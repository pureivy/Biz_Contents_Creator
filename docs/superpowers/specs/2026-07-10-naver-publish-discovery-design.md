# 네이버 발행 자동 감지 + 성과 수집 실검증 설계

- 날짜: 2026-07-10
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 블로그 성과 루프의 마지막 수동 고리 제거

## 1. 목표

네이버 성과 수집기는 이미 끝까지 배선돼 있다(`naver_stats.py` → `collectNaverMetrics` →
`setCollector('naver_advisor')` → 일일 perf-sync 틱). 그러나 발행이 "임시저장 → 사람이 발행"
원칙이라 **최종 발행 URL(`publishedUrl`) 포착이 수동**(사람이 붙여넣기 →
`POST /pieces/:id/published`)이고, 이게 없으면 수집기는 영원히 기동하지 않는다.

이 사이클은 ① 블로그 공개 RSS 로 발행을 자동 감지해 `publishedUrl` 을 자동 설정하고
② 기존 수집 경로(naver_stats → ingestMetrics)를 실제 발행글로 1회 실검증한다.
이로써 블로그도 쇼츠·카드뉴스와 같은 무인 측정→반영 루프가 된다
([[knowledge-compounding-loop]]의 블로그 절반 완성).

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| 감지 방식 | **공개 RSS** `https://rss.blog.naver.com/<blogId>.xml` — Node fetch 단독 | 로그인·브라우저·파이썬·신규 의존성 0. 발행=공개가 기본 워크플로 |
| 매칭 규칙 | **보수적 exact 만** — 정규화 후 제목 완전일치 + 시각 조건 + 양방향 유일 | 오매칭 = 강화 루프 오염(잘못된 키워드·스타일에 보상). 커버리지보다 무결성 |
| 주기 | 일일 perf-sync 틱 편승(`syncPerformance` 직전) | 측정창 7일이라 ≤1일 감지 지연 무해. 새 스케줄러 불필요 |
| 실검증 | 실제 글 1건 사용자 동반: 발행 → 감지 → naver_stats 실런 → ingestMetrics | 수집 추출은 휴리스틱 — 실증 없이는 완성 선언 불가. 발견 결함은 사이클 내 수정 |

**제외(근거 기록):** 비공개글 감지(실브라우저 postlist — 프로필 락 경합·봇탐지 리스크,
발행=공개 워크플로에 불필요), 퍼지 매칭(오매칭 리스크가 편익 초과), 반자동 확정 UI(수동
붙여넣기 폴백이 이미 그 역할), 발행 직후 고빈도 폴링(측정창 대비 무의미).

## 3. 현재 상태 (기준선)

- Piece(`src/content/pieces.ts:14`): stage `'idea'|'research'|'draft'|'ready'|'published'|'measured'|'reflected'|'error'`.
  임시저장 성공 시 `naverDraftUrl`/`naverDraftTs` 기록(`src/server/main.ts:1330`) — 최종 URL 아님.
  `setPublished(id, url)`(`pieces.ts:93`) = `{ stage:'published', publishedUrl:url }` — 수동 라우트
  `POST /pieces/:id/published`(main.ts:651~657)가 유일한 호출자.
- 일일 틱(main.ts:2532~): `startDaily({ time: CONFIG.performanceSyncTime, run: () => { void syncPerformance(); void syncShortsPerformance(); void syncCardnewsPerformance(); } })`.
  `syncPerformance` 는 `stage==='published'` && `updatedTs`(≈발행 시각) 기준 측정창
  (`performanceWindowDays`, 기본 7일) 경과분을 `getCollector().measure()` → `ingestMetrics`.
- 계정: `NAVER_ACCOUNTS` blob `{ [slug]: { blogId, loginId, loginPw } }`
  (`src/secrets/store.ts:214~235`), 범용 `''` 은 평면 키 `NAVER_BLOG_ID` 등(store.ts:239~242).
- 수동 성과 입력·자동 수집 라우트(`POST /pieces/:id/metrics`, `/pieces/:id/collect-metrics`)는
  기존 그대로 — 이 설계는 그 앞단(URL 포착)만 자동화한다.

## 4. 설계

### 4.1 신규 모듈 `src/analytics/naverDiscovery.ts`

순수 헬퍼(전부 export·단위테스트 대상):

```ts
export interface RssItem { title: string; link: string; pubDate: string /* ISO */ }
/** RSS 2.0 XML → 아이템 배열. CDATA·HTML 엔티티·이형 XML 방어 — 이형이면 빈 배열(throw 금지). */
export function parseRssItems(xml: string): RssItem[];
/** NFC 정규화 + HTML 엔티티 디코드(named 5종+숫자) + 공백 축약 + 트림. */
export function normalizeTitle(s: string): string;
/** 감지 대상 선별(순수): naverDraftTs 있고 publishedUrl 없고 stage!=='error',
 *  임시저장 후 30일 이내(포기 지평 — 초과분은 giveUp 목록으로 반환). */
export function selectDiscoveryTargets(pieces: Piece[], now: number): { targets: Piece[]; gaveUp: Piece[] };
/** 보수적 매칭(순수): 정규화 제목 완전일치 && pubDate ≥ naverDraftTs − 1h(시계 여유)
 *  && 양방향 유일(그 piece 의 후보 아이템이 1개 && 그 아이템의 후보 piece 가 1개).
 *  유일성 실패는 ambiguous 로 분류(자동 설정 금지). */
export function matchPublished(
  pending: Array<{ id: string; title: string; draftTs: string }>,
  items: RssItem[],
): { matched: Array<{ pieceId: string; url: string }>; ambiguous: string[] };
```

오케스트레이션(단일 진입점):

```ts
/** 브랜드별 RSS 조회 → 매칭 → setPublished + 피드 로그. 전량 fail-open(성과 틱을 절대 깨지 않음). */
export async function discoverPublishedNaver(): Promise<void>;
```

동작:
1. `selectDiscoveryTargets(pieceStore().list(), Date.now())` — 대상 없으면 즉시 반환(RSS 조회 0회).
2. 대상을 `p.brand ?? ''` 로 그룹핑 → 브랜드마다 `getNaverAccount(slug)` 의 `blogId` 로
   RSS 1회 fetch(`AbortSignal.timeout(10_000)`). blogId 없는 브랜드는 건너뜀(로그 1줄).
3. `matchPublished` 결과의 `matched` 각각: `pieceStore().setPublished(id, url)` + 활동 피드
   `console.log('[성과분석] <제목 30자> — 네이버 발행 감지, 성과 추적 시작')`
   (기존 `[발행담당]` 컨벤션 미러 — 액터명 접미는 붙이지 않음, YAGNI).
4. `ambiguous` 와 `gaveUp` 은 piece 당 **1회만** 피드 안내(프로세스 생애 `Set<pieceId>` 중복 억제):
   - ambiguous: `동명 후보 복수 — 자동 연결 보류, 발행 URL 을 수동 등록해 주세요`
   - gaveUp: `임시저장 30일 경과 — 자동 감지 포기, 발행했다면 URL 을 수동 등록해 주세요`
5. 매칭 실패(후보 0)는 침묵 — 아직 미발행이거나 제목이 수정된 경우로 구분 불가, 다음 틱 재시도.

### 4.2 매칭 규칙 상세

- 정규화: `String.prototype.normalize('NFC')` → 엔티티 디코드(`&amp; &lt; &gt; &quot; &#39;` +
  `&#NNN;`/`&#xHH;`) → 연속 공백(개행 포함) 1칸 축약 → 트림.
- 시각 조건: RSS `pubDate`(RFC-822) 파싱 실패 아이템은 후보 제외.
  `pubDate ≥ naverDraftTs − 1h` — 임시저장 직후 바로 발행하는 케이스의 시계 오차 흡수.
- 링크 검증: `link` 가 `blog.naver.com` 호스트(`m.blog` 포함)가 아니면 후보 제외
  (naver_stats 의 `parse_blog_url` 이 소화 가능한 형태만 저장).
- 양방향 유일: 같은 제목의 RSS 아이템 2개 또는 같은 제목의 대기 piece 2개 → 전부 ambiguous.

### 4.3 배선

`src/server/main.ts` 일일 틱의 `run` 을 `discoverPublishedNaver()` → `syncPerformance()` 순차로
변경(쇼츠·카드뉴스 sync 는 기존대로 병행). RSS 는 공개 엔드포인트라 `naverProfileBusy` 락과
무관 — 락 검사 없이 실행. 감지 시각이 `updatedTs` 가 되므로 측정창 기점이 실제 발행보다
최대 ~1일 늦어질 수 있음 — 측정창 7일 대비 수용(스펙 결정).

### 4.4 수동 경로 유지

`POST /pieces/:id/published` 는 그대로 — 자동 감지가 놓친 경우(제목 수정·비공개 발행·30일
경과)의 폴백. 이미 `publishedUrl` 이 있는 piece 는 감지 대상에서 제외되므로 충돌 없음.

## 5. 에러 처리

- 브랜드 RSS fetch 실패(타임아웃·HTTP 오류) → 그 브랜드만 건너뜀, `[publish-discover]` 로그 1줄.
- `parseRssItems` 는 어떤 입력에도 throw 하지 않음(이형 → 빈 배열).
- `discoverPublishedNaver` 전체 try/catch — 실패해도 이어지는 `syncPerformance` 는 반드시 실행.
- `setPublished` 실패(piece 삭제 경합)는 무해 — 다음 틱 재평가.

## 6. 테스트

- 단위(vitest): `parseRssItems`(실 네이버 RSS 픽스처·CDATA·엔티티·이형 XML·빈 문자열),
  `normalizeTitle`(NFC·엔티티·공백), `selectDiscoveryTargets`(경계 29/31일·stage 필터·
  publishedUrl 보유 제외), `matchPublished`(정상 1:1·시각 조건 경계·동명 아이템/piece 모호·
  링크 호스트 필터).
- `discoverPublishedNaver` 는 순수부가 전부라 얇은 조립 — 코드 리뷰로 검증(fetch mock 통합
  테스트는 편익 대비 하네스 비용 과다, 기존 sync 계열과 동일 기준).
- 회귀: 기존 전체 스위트. 수동 발행 라우트·기존 수집 경로 무변경.

## 7. 의존성·사용자 선행 작업

- 새 의존성 없음(Node fetch + 정규식 파싱).
- `PERFORMANCE_SYNC_TIME` 미설정이면 틱 자체가 꺼져 있음(기존 옵트인) — 실검증 시 설정 확인.
- 실검증에 실제 네이버 발행 1회(사람) 필요 — §8 절차.

## 8. 완료 기준

1. 단위테스트 전부 통과, 루트 tsc 0, 전체 스위트 회귀 없음.
2. **실검증(사용자 동반)**: 실제 piece 임시저장 → 사람이 네이버에서 발행 → 감지 실행(틱 수동
   트리거 또는 dev 호출) → `publishedUrl` 자동 설정·피드 로그 확인 → `naver_stats.py` 실런
   1회(`POST /pieces/:id/collect-metrics`)로 `views/searchInflow` 가 `ingestMetrics` 까지 도달.
   여기서 발견되는 수집 추출 결함은 이 사이클 안에서 수정.
3. 매칭 불가 케이스(동명 2건)가 ambiguous 로 보류되고 수동 등록 안내가 피드에 1회만 출력.

## 9. 부록 — 감지 흐름 요약

```
임시저장(naverDraftTs) ─사람 발행→ 네이버 공개 RSS
        │                              │
        └── 일일 틱: selectDiscoveryTargets ──→ 브랜드별 RSS fetch
                                               │
                        matchPublished(보수적 exact·양방향 유일)
                        │ matched                │ ambiguous/gaveUp
                        ▼                        ▼
              setPublished(stage:'published')   피드 안내 1회(수동 폴백)
                        │
              (기존) syncPerformance → naver_stats.py → ingestMetrics → 강화
```
