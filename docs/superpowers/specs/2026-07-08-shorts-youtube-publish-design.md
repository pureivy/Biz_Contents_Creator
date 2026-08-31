# 브랜드별 유튜브 숏폼 발행 설계 (Feature C)

- 날짜: 2026-07-08
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 쇼츠 파이프라인 발행 단계

## 1. 목표

완성된 쇼츠(`data/shorts/<id>/final.mp4`)를 **브랜드별 유튜브 채널**에 **비공개(private)로
업로드**한다. 공개 전환은 항상 사람이 유튜브 스튜디오에서 — 네이버 "임시저장, 발행은 사람"
원칙과 동일(오발행 방지). 브랜드 계정 섞임 차단 원칙([[brand-scoped-data-separation]],
네이버 `NAVER_ACCOUNTS` 패턴)을 그대로 따른다.

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| 트리거 | 수동 버튼(기본) + `AUTO_YT_UPLOAD=true` 옵트인 자동 | 네이버 autoNaverDraft 패턴과 동일 구조 |
| 채널 인증 | **서버 통합 OAuth** — UI 버튼 → 구글 동의 → 서버 콜백이 브랜드별 refresh token 저장 | 가장 매끄러운 UX, 서버(8787)가 이미 상주 |
| OAuth 클라이언트 | **앱 공용 1개**(키 탭 입력), 브랜드별 토큰만 분리 | 기존 합의(2026-07-07) |
| 업로드 구현 | **Node 내장 fetch REST 직접**(토큰 갱신 + multipart videos.insert) | 새 의존성 0, fal 모듈과 동일 패턴. 쇼츠 20~30MB는 단발 multipart 로 충분 |
| 공개 수준 | `privacyStatus: 'private'` 고정 | 오발행 방지 — unlisted 도 링크 유출 가능하므로 private |

## 3. 현재 상태 (기준선)

- 쇼츠: `runShortsJob` 이 `data/shorts/<id>/final.mp4` 렌더 후 `store.update(id, { stage:'ready', title, description, hashtags, ... })`. `Shorts` 레코드에 `brand?`(생성 시점 활성 브랜드 슬러그)·`title`·`description`·`hashtags` 보유(`src/content/shorts.ts:14`).
- 시크릿: `src/secrets/store.ts` — 키 탭용 `listKeys/setKey/addCustom/getSecret`, 브랜드별 계정 blob 패턴 `readNaverAccounts()/getNaverAccount(slug)/setNaverAccount(slug, patch)`(231~249행, `NAVER_ACCOUNTS` JSON). 이 패턴을 유튜브로 미러링한다.
- 서버: Hono(`src/server/main.ts`) — `/shorts` REST, `publisherName()`(1207행) 발행담당 액터, 활동 피드 `console.log('[발행담당] ...')` 패턴.
- 프론트: `frontend/src/panels/StudioView.tsx` `ShortsSection`(쇼츠 카드 목록), `ApiKeysView.tsx`(키 탭).
- 유튜브 관련 기존 코드: 조사용 Data API 커넥터(`src/grounding/youtube.ts`, API 키)뿐 — 업로드 전무.

## 4. 설계

### 4.1 시크릿·설정

- 키 탭 공용 키 2개: `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`
  (secrets store 기본 키 목록에 추가 — 네이버 평면 키와 같은 방식).
- 브랜드별 토큰 blob: `YOUTUBE_TOKENS` = `{ [slug]: { refreshToken: string } }`.
  `src/secrets/store.ts` 에 `getYoutubeAccount(slug)` / `setYoutubeToken(slug, refreshToken)`
  추가 — `getNaverAccount` 미러(범용 `''` 슬러그는 blob 의 `''` 키 사용, 평면 키 없음).
- `CONFIG.autoYtUpload` = `envBool('AUTO_YT_UPLOAD', false)`.

### 4.2 새 모듈 `src/tools/youtubeUpload.ts`

```ts
export interface YtUploadResult { ok: boolean; videoId?: string; url?: string; error?: string }
export async function uploadShortsToYoutube(opts: {
  slug: string;                 // 브랜드 슬러그('' = 범용)
  videoPath: string;
  title: string; description: string; hashtags: string[];
  signal?: AbortSignal;
}): Promise<YtUploadResult>;
```

동작:
1. `getYoutubeAccount(opts.slug)` 로 refreshToken, 키 탭에서 클라이언트 ID/Secret 로드 —
   없으면 `{ ok:false, error:'유튜브 채널 미연결' }`(예외 아님).
2. 토큰 갱신: `POST https://oauth2.googleapis.com/token`
   (`grant_type=refresh_token`) → `access_token`. 실패(invalid_grant 등)면 명시 에러 반환.
3. 업로드: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status`
   — `multipart/related` body: ① JSON 메타데이터 ② `video/mp4` 바이트. 응답 `{ id }` →
   `url = https://youtube.com/watch?v=<id>`.
4. 타임아웃 캡 180초, 재시도 없음(쿼터 보호 — videos.insert 는 일일 쿼터 1600단위/건).
5. 순수 헬퍼(테스트 대상):
   - `buildVideoMeta(title, description, hashtags)` — snippet(제목 100자 캡·꺾쇠 `<>` 제거,
     설명 = description + 해시태그 줄, 5000자 캡, tags = 해시태그에서 `#` 제거·30자 캡·최대 15개,
     `categoryId: '22'`) + status(`privacyStatus: 'private'`, `selfDeclaredMadeForKids: false`).
   - `buildMultipartBody(metaJson, videoBuf, boundary)` — multipart/related Buffer 조립.
   - `extractVideoId(json)` — 응답 `{ id }` 안전 추출.

### 4.3 채널 연결(서버 통합 OAuth)

- `GET /youtube/oauth/start?brand=<slug>` → 302 구글 동의 URL:
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=http://127.0.0.1:8787/youtube/oauth/callback&response_type=code&scope=https://www.googleapis.com/auth/youtube.upload&access_type=offline&prompt=consent&state=<slug>`
- `GET /youtube/oauth/callback?code&state` → 코드 교환(`POST oauth2.googleapis.com/token`,
  `grant_type=authorization_code`) → `setYoutubeToken(state, refresh_token)` → 완료 HTML
  ("채널 연결 완료 — 이 창을 닫으세요"). 에러 시 사유 HTML.
- `GET /youtube/status?brand=<slug>` → `{ connected: boolean }` (UI 버튼 분기용).

### 4.4 배선·UI

- `POST /shorts/:id/youtube` — `stage==='ready'` 필수, `final.mp4` 존재 확인 →
  `uploadShortsToYoutube({ slug: short.brand ?? '', ... })` → 성공 시
  `store.update(id, { youtubeId, youtubeUrl })` + `[발행담당] <제목> — 유튜브 비공개 업로드 완료`
  피드 로그. 실패 시 `{ error }` 반환(레코드 불변).
- `Shorts` 타입 확장: `youtubeId?: string; youtubeUrl?: string`.
- StudioView `ShortsSection` 쇼츠 카드(ready): `youtubeUrl` 있으면 링크 배지, 없으면
  "유튜브 업로드" 버튼(→ POST, 결과 반영). 브랜드 미연결(`/youtube/status` false)이면
  "채널 연결" 버튼(→ `/youtube/oauth/start?brand=` 새 창).
- 자동 옵트인: `runShortsJob` 의 ready 직후 — `CONFIG.autoYtUpload && 연결됨` 이면 업로드
  시도, 성공/실패를 `say()` 로 피드에 기록(잡은 이미 완료 상태 — 실패해도 무영향).

## 5. 에러 처리

- 수동 업로드는 **명시 실패 반환**(fail-open 아님): 미연결·토큰 만료(invalid_grant → "채널
  재연결 필요")·쿼터 초과(quotaExceeded)·파일 없음 각각 사람이 읽을 메시지로 UI 표시.
- 자동 업로드 실패는 피드 로그만 — 쇼츠 레코드는 ready 유지, 수동 버튼으로 재시도 가능.
- refresh token·client secret 은 로그·에러 메시지에 싣지 않는다(fal 패턴).

## 6. 테스트

- 단위(vitest): `buildVideoMeta`(캡·해시태그 합성·tags 변환), `buildMultipartBody`(경계·
  바이트 정합), `extractVideoId`(정상/이형).
- **실 업로드는 로컬 자동 테스트 불가**(실 채널·OAuth 필요, 기존 합의) — 구현+가이드 완성
  후 사용자와 함께 1회 검증: 채널 연결 → 업로드 → 유튜브 스튜디오에서 비공개 영상 확인.
- 회귀: 키/토큰 없음 → 버튼이 연결 안내만, 자동 업로드는 기본 off — 기존 파이프라인 무영향.

## 7. 의존성·사용자 선행 작업

- 새 npm/python 의존성 없음(Node 20+ fetch).
- **사용자 1회 설정(가이드를 스펙 부록 §9 로 포함)**: Google Cloud 프로젝트에서
  YouTube Data API v3 활성화 → OAuth 클라이언트(웹 애플리케이션) 생성 →
  리디렉션 URI `http://127.0.0.1:8787/youtube/oauth/callback` 등록 →
  ID/Secret 을 키 탭에 입력 → 브랜드마다 "채널 연결" 1회(해당 채널 구글 계정으로 로그인).
- 쿼터: videos.insert 1건 = 1600단위(일일 기본 10,000) → 하루 ~6건 업로드 상한. 초과 시
  quotaExceeded 에러 표시(비차단).

## 8. 완료 기준

- 키 탭에 클라이언트 입력·브랜드 채널 연결 후, 쇼츠 카드 버튼으로 비공개 업로드 성공
  (`youtubeUrl` 저장·링크 표시) — 사용자 동반 1회 실검증.
- `AUTO_YT_UPLOAD=true` 시 ready 도달 쇼츠가 자동 비공개 업로드(연결된 브랜드만).
- 미연결·키 없음·auto off 경로에서 기존 동작 회귀 없음. 순수 헬퍼 테스트 통과, tsc 0.

## 9. 부록 — Google Cloud 1회 설정 가이드 (사용자용)

1. https://console.cloud.google.com 접속 → 프로젝트 선택(없으면 새로 만들기).
2. "API 및 서비스 → 라이브러리" → **YouTube Data API v3** 검색 → 사용 설정.
3. "API 및 서비스 → OAuth 동의 화면" → 앱 이름 등록(외부, 테스트 모드면 테스트 사용자에
   각 브랜드 채널의 구글 계정 추가).
4. "사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID" → 유형 **웹 애플리케이션**
   → 승인된 리디렉션 URI 에 `http://127.0.0.1:8787/youtube/oauth/callback` 추가.
5. 발급된 **클라이언트 ID/Secret** 을 앱 키 탭(`YOUTUBE_OAUTH_CLIENT_ID`/`YOUTUBE_OAUTH_CLIENT_SECRET`)에 입력.
6. 스튜디오 쇼츠 탭에서 브랜드 전환 후 "채널 연결" → 그 브랜드의 유튜브 채널 구글 계정으로
   로그인·동의 → "연결 완료" 확인. 브랜드마다 반복.
7. **`PORT` 를 8787 에서 바꾸면** 4번의 리디렉션 URI 도 같은 포트로 구글 콘솔에서 갱신해야 한다
   (앱은 `CONFIG.port` 로 자동 추종).
