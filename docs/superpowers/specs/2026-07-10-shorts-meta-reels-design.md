# 숏폼 메타 발행(IG 릴스·FB 릴스) + 성과 측정 — 설계 스펙

- 작성일: 2026-07-10
- 브랜치: main
- 선행: 카드뉴스 메타 발행(`docs/superpowers/specs/2026-07-09-cardnews-meta-publish-design.md` — META_TOKENS·OAuth·GRAPH·인사이트 파서·강화 게이트 전부 재사용) · 유튜브 쇼츠 발행/측정(Feature C·shortsPerf)
- 상태: 설계 승인됨 → 구현 계획 대기

## 1. 목적 / 배경

쇼츠(`data/shorts/<id>/final.mp4`, 9:16 세로 30~55초)는 현재 유튜브에만 발행된다. 이 기능은 같은 쇼츠를 **인스타그램 릴스 + 페이스북 릴스**로도 발행하고 IG 인사이트를 기존 쇼츠 측정 루프에 통합한다. 쇼츠 규격은 릴스 노출 조건(IG 5~90초·FB 3~60초, 9:16, 1080p)에 정확히 부합한다. 카드뉴스 사이클이 구축한 메타 인프라(브랜드별 `META_TOKENS`·OAuth 연결·`GRAPH` v23.0)를 그대로 쓰므로 **추가 계정 설정이 없다**.

## 2. 성공 기준

1. 쇼츠 UI에서 "릴스 발행" 클릭 → 활성 브랜드의 IG 릴스 + FB 릴스가 올라가고 두 링크가 카드에 표시된다.
2. 유튜브 발행과 완전 독립 — 유튜브 업로드 여부와 무관하게 메타 발행 가능, 기존 유튜브 루프(업로드·측정·강화) 무회귀.
3. 발행 다음날부터 일일 perf-sync 가 IG 릴스 인사이트(`views·reach·likes·comments·saved·shares`)를 쇼츠 metrics JSONL 에 `source:'meta:ig'`로 적재한다(유튜브 샘플과 공존).
4. 측정 창 경과 후 1회, 저장률·공유율 중심 신호가 `shorts_writer`·`shorts_director` 메모리(채널 명시 "릴스 성과")와 브랜드 위키에 반영된다(`metaPerfReflected` 멱등 — 유튜브 `perfReflected`와 독립).
5. 재발행 409 + 부분 성공(한 채널만) 재시도 시 성공 채널 스킵(멱등). 브랜드 미연결은 명확한 에러.
6. 측정 실패는 전량 fail-open(쇼츠별 격리).

## 3. 결정 사항 (브레인스토밍 합의)

| 항목 | 결정 |
|---|---|
| 채널 | IG 릴스 + FB 릴스(A안). FB 페이지 일반 영상 아님 — 형식 정합 |
| 업로드 방식 | 공개 URL 불필요 — IG: **resumable 업로드**(컨테이너 생성 후 `rupload.facebook.com/ig-api-upload/<version>/<container-id>` 바이너리 POST) / FB: `/{page-id}/video_reels` **start→binary→finish** 3단계 |
| 공개 정책 | 릴스는 API 발행 즉시 공개(비공개·초안 없음) — 카드뉴스와 동일한 "버튼 클릭=공개 발행"(사용자 합의) |
| 측정 | IG 릴스 인사이트만 이번 범위. FB 릴스 인사이트는 후속(복잡도 대비 가치 낮음 — 카드뉴스도 FB는 보조) |
| 강화 | **채널별 독립** — 유튜브 `perfReflected` 무접촉, 메타는 `metaPerfReflected` 별도 플래그·별도 1회 강화(perf_analyst 철학: 채널 네이티브 지표로 진단). 신호는 `cardnewsSignal` 재사용(도달·저장률·공유율 — 릴스도 저장·공유가 핵심) |
| 계정·토큰 | 카드뉴스와 공용(`getMetaAccount(slug)` — pageId·igUserId·pageAccessToken). 신규 설정 0 |
| 캡션 | `buildIgCaption(제목+설명, hashtags)` 재사용(2200자 캡). FB finish 의 description 도 동일 문자열 |

## 4. 아키텍처

```
[ShortsView 릴스 버튼] → POST /shorts/:id/meta (409 가드)
   → metaPublish.publishShortsToMeta({slug, videoPath, caption, hashtags, existing})
       ① IG: 컨테이너(media_type=REELS, upload_type=resumable, caption, share_to_feed)
            → rupload 바이너리 POST(offset:0·file_size 헤더, Authorization: OAuth <token>)
            → 상태 폴링(waitContainer, 영상용 상한 60회×3s) → media_publish → permalink
       ② FB: /{pageId}/video_reels start → 업로드 URI 바이너리 POST → finish(video_state=PUBLISHED, description)
   → shortsStore.update({igReelId, igPermalink, fbReelId, metaPublishedTs})

[일일 perf-sync 틱] → syncShortsMetaPerformance()   (shortsPerf.ts 에 추가, cardnewsPerf 미러)
   → 대상: igReelId && metaPublishedTs, shortsMetaPerfDue(창 내 매일 / 창 경과 후 미강화, 포기 지평 4배)
   → IG /{igReelId}/insights (parseIgInsights 재사용) → appendMetrics(shorts.id, {source:'meta:ig'})
   → 창 경과 시 1회: cardnewsSignal → shorts_writer·shorts_director 메모리("릴스 성과") + 위키
   → metaPerfReflected:true
```

### 4.1 신규·수정 파일

| 파일 | 작업 | 미러 원본 |
|---|---|---|
| `src/tools/metaPublish.ts` | `publishShortsToMeta` + rupload/FB reels 헬퍼 추가 | 같은 파일 `publishCardNewsToMeta` |
| `src/content/shorts.ts` | `Shorts`에 `igReelId? igPermalink? fbReelId? metaPublishedTs? metaPerfReflected?` | 유튜브 발행 필드 |
| `src/server/main.ts` | `POST /shorts/:id/meta`(메타 블록에 추가) + perf-sync 틱 1줄 | `/cardnews/:id/publish` |
| `src/analytics/shortsPerf.ts` | `shortsMetaPerfDue` + `reinforceShortsMeta` + `syncShortsMetaPerformance` | `cardnewsPerf.ts` |
| `frontend/src/api.ts` | ShortsInfo 필드 3개 + `publishShortsMeta(id)` | `publishCardNews` |
| `frontend/src/panels/ShortsView.tsx` | 릴스 발행 버튼·링크 3분기(metaReady prop) | CardNewsView 발행 UI |

### 4.2 발행 상세

- 입력: `data/shorts/<id>/final.mp4`(존재 확인), 캡션 = `buildIgCaption([s.title ?? s.topic, s.description ?? ''].filter(Boolean).join('\n\n'), s.hashtags ?? [])` — 제목이 릴스 캡션 첫 줄, 2200자 캡은 buildIgCaption 이 보장.
- IG 컨테이너 상태 폴링: 영상 인코딩이 이미지보다 오래 걸림 — `waitContainer` 재사용하되 폴링 횟수 파라미터화(기본 10, 릴스 60). `ERROR`/`EXPIRED` 명시 throw.
- rupload 요청: `Content-Type: application/octet-stream`, 헤더 `Authorization: OAuth <pageAccessToken>`, `offset: 0`, `file_size: <bytes>`. 응답 `{success:true}` 아니면 throw.
- FB start 응답 `{video_id, upload_url}` — upload_url 에 바이너리 POST(동일 헤더 규약), finish 는 `/{pageId}/video_reels?upload_phase=finish&video_id=…&video_state=PUBLISHED&description=…`. finish 성공 후 릴 URL 은 `https://www.facebook.com/reel/{video_id}`.
- 부분 성공 멱등: `existing.igPermalink` → IG 스킵, `existing.fbReelId` → FB 스킵. 이형 응답(id/success 누락)은 전부 명시 throw(성공 위장 금지 — 카드뉴스 교훈).
- 409 가드: `stage!=='ready'` / `igPermalink && fbReelId`. 슬라이드 대신 `final.mp4` 부재 시 409.
- 동시발행 락: 카드뉴스와 동일하게 서버측 락 없음(알려진 수용 한계, 후속 공통 도입 후보 — 카드뉴스 원장 M1).

### 4.3 측정·강화 상세

- `shortsMetaPerfDue(s, now, days)`: `igReelId && metaPublishedTs` 전제, 창 내 매일 / 창 경과 후 `!metaPerfReflected`, 포기 지평 `days*4`. 측정 창 상수 `CONFIG.shortsPerfDays` 재사용.
- 수집: `GET /{igReelId}/insights?metric=views,reach,likes,comments,saved,shares` — `parseIgInsights` 재사용. 실패는 쇼츠별 fail-open.
- 적재: `appendMetrics(s.id, {…, source:'meta:ig'})` — 같은 JSONL 에 유튜브(`youtube:api`)·메타 샘플 공존. 기존 유튜브 강화의 `shouldRecordMemory(signal, readMetrics(s.id).length)` 는 전체 샘플을 세지만, 메타 샘플 혼입으로 카운트가 부풀 수 있음 → **기존 유튜브 게이트도 `source==='youtube:api'` 필터로 보정**(이번 범위에 포함 — 무보정 시 비공개→늦공개 오귀속 방지 게이트가 무력화되는 실회귀).
- 강화: `reinforceShortsMeta` — `cardnewsSignal(reach, saved, shares)` 신호, 메모리 문구 "릴스 성과: …"(채널 명시), 위키 제목 "릴스 성과: <제목>". 게이트는 `shouldRecordMemory(signal, meta:ig 샘플 수)`. 완료 시 `metaPerfReflected:true`.
- 기존 `shortsPerfDue`·`reinforceShorts`·`syncShortsPerformance` 로직 무접촉(위 게이트 필터 1줄 제외).

## 5. 에러 처리·보안

- 발행: 명시 실패 반환 + 부분 성공 채널별 저장(502 시에도 patch). 토큰은 로그·에러 미노출(rupload Authorization 헤더만).
- 측정: 전량 fail-open, 쇼츠별 격리.
- 권한: 기존 OAuth scope 로 충분한지 실검증에서 확인 — 부족 시(`publish_video` 필요 가능성) `/meta/oauth/start` scope 에 추가하고 재연결 1회 안내(스펙 확정 사항: scope 문자열에 `publish_video` 선제 포함).

## 6. 테스트

- 단위(전부 API mock, 변별력 규약 — 가드 제거 시 실제로 깨지는 mock 구성): IG 릴스 시퀀스(컨테이너→rupload→폴링→발행→permalink), rupload 이형(`success:false`) throw, FB start→upload→finish 시퀀스·이형 가드, 부분 성공 멱등(IG 기발행 스킵 시 IG 경로 무호출), `shortsMetaPerfDue` 창 경계, 유튜브 게이트 소스 필터 보정 회귀(메타 샘플 혼입 시 카운트 불변), 라우트 404(JSON 본문 단언).
- 실검증: 메타 연결(카드뉴스와 공용) 후 실발행 1회 → 릴스 탭 노출·링크 확인 → 익일 perf-sync 로그·JSONL 확인.

## 7. 후속 (이번 범위 아님)

- FB 릴스 인사이트 수집.
- 발행 동시성 락(카드뉴스·유튜브 공통).
- 자동발행 옵트인(`AUTO_META_PUBLISH` — 카드뉴스와 공통).
