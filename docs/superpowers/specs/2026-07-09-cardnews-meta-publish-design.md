# 카드뉴스 인스타그램·페이스북 발행 + 성과 측정 — 설계 스펙

- 작성일: 2026-07-09
- 브랜치: main
- 선행: 유튜브 브랜드별 발행(Feature C, `src/tools/youtubeUpload.ts`) · 쇼츠 측정→반영 루프(`src/analytics/shortsPerf.ts`) — 두 패턴을 그대로 미러링
- 상태: 설계 승인됨 → 구현 계획 대기

## 1. 목적 / 배경

카드뉴스 파이프라인은 `stage:'ready'`(1080×1080 슬라이드 3~8장 + `caption.txt`)에서 끝난다 — 발행·성과 필드가 없다. 이 기능은 완성된 카드뉴스를 **인스타그램(캐러셀)·페이스북(페이지 게시물)에 발행**하고, **인사이트를 매일 수집해 기획자·디자이너에게 되먹임**하는 루프를 완성한다. 블로그(네이버)·쇼츠(유튜브)에 이은 세 번째 채널로, 콘텐츠 세트(블로그→카드뉴스→쇼츠)의 측정→반영 루프가 전 채널에서 닫힌다.

## 2. 성공 기준

1. 카드뉴스 UI에서 발행 버튼 클릭 → 활성 브랜드의 IG 캐러셀 + FB 페이지 게시물이 올라가고 두 링크가 카드에 표시된다.
2. 브랜드 미연결 시 발행이 명확한 에러로 차단된다(채널 섞임 0건 — 유튜브와 동일 원칙).
3. 발행 다음날부터 일일 성과 동기화가 IG `views·reach·saved·shares·likes·comments`, FB `reactions·comments·shares`를 `data/analytics/metrics/<id>.jsonl`에 적재한다.
4. 측정 창 경과 후 1회, 저장률·공유율 중심 신호가 `cardnews_planner`·`cardnews_designer` 메모리와 브랜드 위키에 반영된다(`perfReflected` 멱등).
5. 측정 실패는 fail-open — 다른 파이프라인·자율 사이클을 깨뜨리지 않는다.
6. 재발행 시도는 409로 거절되고, 부분 성공(한 채널만) 후 재시도는 성공한 채널을 건너뛴다.

## 3. 결정 사항 (브레인스토밍 합의)

| 항목 | 결정 |
|---|---|
| 발행 방식 | **공식 Meta Graph API** (브라우저 자동화 배제 — 인사이트 측정은 API만 신뢰 가능) |
| 계정 구조 | 브랜드별 FB 페이지 + IG 프로페셔널 계정(페이지 연결). 개인 FB 계정 보유 확인, 페이지·IG 계정은 신규 개설(체크리스트 안내) |
| 개발자 앱 | 사용자 본인 앱 1개(공용), **개발 모드 유지 — 본인 소유 페이지·계정만 쓰므로 앱 검수 불필요** |
| 토큰 저장 | `.env` 단일 키 JSON blob `META_TOKENS`={"슬러그":{pageId, igUserId, pageAccessToken}} — `YOUTUBE_TOKENS` 패턴, 브랜드별·폴백 없음 |
| IG 공개 URL 제약 | FB 페이지에 **미공개(published=false) 사진 바이너리 업로드 → CDN URL을 IG 캐러셀에 재사용** — 외부 호스팅 의존 없음 |
| 승인 | 사용자 버튼 클릭=승인(유튜브 패턴). 자동발행은 후속(env 옵트인) |
| 측정 지표 | IG insights: `views·reach·saved·shares·likes·comments`(2025-04 개편 반영, impressions 계열 폐기됨) / FB: insights 대신 **필드 조회**(`reactions·comments·shares`) |
| 강화 신호 | 도달 대비 **저장률(실용 가치)·공유율(공감 가치)** 중심 — perf_analyst 프롬프트의 기존 진단 기준과 일치 |
| API 한도 | IG 발행 100건/24h(캐러셀=1건), 캐러셀 최대 10장 — 카드뉴스 3~8장이라 여유. 에러 시 원인 노출 |

## 4. 사전 준비 (사람이 할 일, 브랜드당 1회)

시스템이 대신할 수 없는 절차 — UI `/meta/status` 화면과 문서로 안내:

1. 개인 FB 계정으로 브랜드별 **페이스북 페이지** 개설.
2. 브랜드별 **인스타그램 계정** 생성 → 설정에서 **프로페셔널(비즈니스) 전환** → 1의 페이지와 연결.
3. **Meta 개발자 앱** 생성(1회, 공용): developers.facebook.com → 앱 생성(비즈니스 유형) → Facebook 로그인 제품 추가 → 리다이렉트 URI `http://127.0.0.1:8787/meta/oauth/callback` 등록. 요청 권한: `pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, instagram_manage_insights`.
4. 앱 ID/Secret을 `.env`의 `META_OAUTH_CLIENT_ID` / `META_OAUTH_CLIENT_SECRET`에 저장.
5. 이후 브랜드 연결: 앱 UI에서 브랜드 활성화 → "메타 연결" 클릭 → OAuth 동의(연결할 페이지 선택) 1회.

## 5. 아키텍처

전 컴포넌트가 기존 패턴의 미러 — 새 개념 없음.

```
[UI 발행 버튼] → POST /cardnews/:id/publish (409 가드)
   → metaPublish.publishCardNewsToMeta({slug, slides[], caption, hashtags})
       ① FB 미공개 사진 업로드(바이너리) → photoId[] + CDN URL[]
       ② IG: 자식 컨테이너(is_carousel_item, image_url=CDN) ×N
            → CAROUSEL 컨테이너(children, caption) → media_publish → permalink
       ③ FB: attached_media=photoId[] 피드 게시(캡션 동일)
   → cardNewsStore.update({igMediaId, igPermalink, fbPostId, publishedTs})

[startDaily 기존 틱] → syncCardnewsPerformance()   (shortsPerf 미러)
   → 대상: publishedTs 있고 측정 창 내(매일) 또는 창 경과 후 미강화
   → IG /{igMediaId}/insights + FB /{fbPostId}?fields=... → appendMetrics(id, {source:'meta:api'})
   → 창 경과 시 1회: cardnewsSignal → planner/designer 메모리 + 위키 → perfReflected:true
```

### 5.1 신규·수정 파일

| 파일 | 작업 | 미러 원본 |
|---|---|---|
| `src/secrets/store.ts` | `META_TOKENS` blob + `getMetaAccount(slug)` / `setMetaToken(slug, acct)` 추가 | `YOUTUBE_TOKENS`(263-293행) |
| `src/tools/metaPublish.ts` | 신규 — 순수 헬퍼(캡션 합성·해시태그 캡·페이로드 빌드·permalink 추출) + `publishCardNewsToMeta` | `youtubeUpload.ts` |
| `src/server/main.ts` | `/meta/oauth/start·callback`(nonce state, 10분 TTL) · `/meta/status` · `POST /cardnews/:id/publish` | 유튜브 OAuth·업로드 라우트(1034-1102행) |
| `src/content/cardnews.ts` | `CardNews`에 `igMediaId? igPermalink? fbPostId? publishedTs? perfReflected?` | `Shorts` 발행 필드 |
| `src/analytics/performance.ts` | `MetricSample`에 `reach? saved? shares?` 추가(하위호환 — 옵셔널) | — |
| `src/analytics/cardnewsPerf.ts` | 신규 — `syncCardnewsPerformance` · `cardnewsSignal` · `cardnewsPerfDue` · 파서 | `shortsPerf.ts` |
| `src/server/main.ts`(틱) | `startDaily` run 콜백에 `syncCardnewsPerformance` 추가 | 2402-2425행 |
| `frontend`(카드뉴스 패널) | 발행 버튼(브랜드 연결 상태 게이트) + IG/FB 링크 표시 | 쇼츠 유튜브 버튼 |

### 5.2 OAuth 흐름 (브랜드당 1회)

`GET /meta/oauth/start` → FB 로그인 동의(위 권한) → callback 에서 ①code→단기 사용자 토큰 ②장기 사용자 토큰 교환(60일) ③`/me/accounts`로 페이지 목록·**페이지 토큰**(장기 사용자 토큰 유래라 무기한) ④페이지의 `instagram_business_account`로 igUserId 획득 → `setMetaToken(activeBrandSlug(), {pageId, igUserId, pageAccessToken})`. 페이지가 여러 개면 선택 UI(콜백 후 상태 화면에서 선택). `/meta/status`: 브랜드별 연결 여부 + 토큰 유효성 검사(간단 `/me` 핑) + 미연결 시 사전 준비 체크리스트 표시.

## 6. 발행 상세

- **입력**: `data/cardnews/<id>/slide_NN.png`(정렬 순서 유지 — IG 캐러셀은 첫 장 비율로 전체 크롭, 전 장 1:1이라 무영향) + `caption.txt`(캡션+해시태그, 이미 인스타 규격으로 생성됨).
- **409 가드**: `stage!=='ready'` → 409 · `igPermalink && fbPostId` → 409("이미 발행됨").
- **부분 성공·멱등**: 채널별 결과를 개별 기록. 재시도 시 `igPermalink` 있으면 IG 스킵, `fbPostId` 있으면 FB 스킵. 실패 원인은 그대로 반환(성공 위장 금지).
- **레이트리밋**: 에러 응답에 `content_publishing_limit` 잔량 안내 포함(도달 시). 발행 볼륨상 실질 위험 없음.
- **CDN URL 만료**: FB 사진 CDN URL은 서명 만료가 있으므로 업로드 직후 즉시 IG 컨테이너 생성(단일 요청 흐름 내 처리, 저장·재사용 금지).

## 7. 측정·강화 상세

- **대상 선정** `cardnewsPerfDue`: `publishedTs` 존재 && (측정 창 내 → 매일 수집) || (창 경과 && `!perfReflected` → 마지막 수집+강화). 측정 창은 쇼츠와 동일 상수 재사용.
- **수집**: IG `GET /{igMediaId}/insights?metric=views,reach,saved,shares,likes,comments` + FB `GET /{fbPostId}?fields=reactions.summary(true),comments.summary(true),shares`. 실패는 카드별 fail-open(한 카드 실패가 나머지를 안 막음).
- **적재**: `appendMetrics(card.id, {measuredAt, views, likes, comments, reach, saved, shares, searchInflow:[], source:'meta:api'})` — 기존 JSONL store 재사용.
- **신호** `cardnewsSignal(reach, saved, shares, likes)`: 저장률(saved/reach)·공유율(shares/reach) 중심 가중 + 도달 로그 보정. 구체 가중치는 구현 플랜에서 쇼츠 `shortsSignal` 스케일과 정합하게 확정(0~1 범위, 강화 임계 동일 규약).
- **되먹임**: `appendMemory('cardnews_planner'|'cardnews_designer', 교훈, brand)` + `llmWikiFor(brand).upsertPage({type:'performance'})`. 부정 신호 기록은 쇼츠와 동일한 `shouldRecordMemory` 게이트 재사용. 완료 시 `perfReflected:true`.

## 8. 에러 처리·보안

- 토큰 부재/만료: 발행 시 명확한 에러("브랜드 미연결 — /meta/status 에서 연결"), `/meta/status`에서 재연결 유도.
- `META_TOKENS`는 `.env` 전용(레포 비추적) — `NAVER_ACCOUNTS`와 동일 취급. 로그에 토큰 원문 금지.
- 측정 루프는 전량 fail-open + 카드별 격리. 발행은 명시적 실패 반환.
- slug 검증은 기존 `isSafeBrandSlug` 재사용.

## 9. 테스트

- 단위(모두 API mock, 네트워크 없음): 캡션 합성·해시태그 캡, 캐러셀 페이로드 빌드(≤10 검증), CDN URL 추출, 409 가드(ready 아님·기발행·부분 성공 재시도), 인사이트 파서, `cardnewsSignal` 경계(reach 0 나눗셈), `cardnewsPerfDue` 창 경계, `META_TOKENS` 접근자 round-trip.
- 실검증: 브랜드 1개 계정 연결 후 실발행 1회 + 다음날 동기화 확인(쇼츠 Feature C와 동일 절차).

## 10. 후속 (이번 범위 아님)

- 자동발행 옵트인(`AUTO_META_PUBLISH`, 쇼츠 `AUTO_YT_UPLOAD` 미러).
- perf_analyst 종합 분석에 카드뉴스 채널 데이터 태우기(현재도 프롬프트는 준비됨 — 데이터가 연동되는 순간 자동 활용).
- 스토리/릴스 등 다른 포맷 발행.
