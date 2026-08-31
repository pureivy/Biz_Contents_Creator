# 유튜브 쇼츠 성과 수집·강화 설계

- 날짜: 2026-07-09
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 성과 루프(제작→발행→**측정→반영**)

## 1. 목표

유튜브에 발행된 쇼츠(`youtubeId` 보유)의 조회수·좋아요·댓글을 **YouTube Data API
(`videos.list`, 기존 조사용 `YOUTUBE_API_KEY`)**로 매일 수집해 시계열로 쌓고, 측정창이
끝나면 **1회 강화**(shorts_writer·shorts_director 학습 + 위키 적재)한다. 블로그 piece 의
측정→강화 루프([[knowledge-compounding-loop]])를 쇼츠로 확장 — 지식 복리 루프의 마지막 조각.

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| v1 범위 | **수집 + 강화까지** | 측정→반영 루프 완성(사용자 확정) |
| UI | **쇼츠 카드 뱃지**(👁 조회 · 👍 좋아요 최신값) | 구현 가벼움, 제작 맥락에서 바로 보임 |
| 통합 층 | 기존 일일 성과 동기화 틱에 **쇼츠 전용 함수 편승** | `PerformanceCollector` 는 piece 시그니처라 부적합. 같은 on/off 스위치(`PERFORMANCE_SYNC_TIME`) |
| 케이던스 | 업로드 후 `SHORTS_PERF_DAYS`(기본 7, env) 동안 매일 append → 창 경과 시 강화 1회 | 쇼츠는 노출이 즉발성 — piece 의 "창 도달 후 1회 측정"과 달리 추적형 |

## 3. 현재 상태 (기준선)

- 성과 체계(piece 중심): `syncPerformance()`(server/main.ts ~2399) — `performanceSyncTime`
  일일 틱, published piece 가 측정창(`performanceWindowDays`) 도달 시 `collector.measure`
  → `ingestMetrics` → `reinforceFromPerformance`(measured→reflected 멱등, 작가 메모리+위키).
- 저장: `appendMetrics(pieceId, sample)` — `data/analytics/metrics/<id>.jsonl` append-only
  (`src/analytics/performance.ts`). `MetricSample { measuredAt, views, dwellSec?, searchInflow[], source? }`.
- 신호: `performanceSignal(m)` — views 로그 + 유입 다양성(`src/analytics/reinforce.ts:20`).
- 강화 패턴: `reinforceWriter` — `appendMemory(roleId, ...)` + `appendActivity` + `llmWiki` 적재.
- 유튜브 API: `src/grounding/youtube.ts` — `youtubeEnabled()`(YOUTUBE_API_KEY), `videos?part=statistics`
  호출 패턴 기존재. `videos.list` = 1쿼터단위/호출(50 id 배치) — 업로드 쿼터(1600/건)와 독립.
- 쇼츠: `youtubeId/youtubeUrl` 저장됨(Feature C). **업로드 시각 필드는 없음** — 이번에 추가.

## 4. 설계

### 4.1 레코드·타입 확장

- `Shorts`(src/content/shorts.ts): `youtubeTs?: string`(업로드 성공 시각 — 측정창 기준점),
  `perfReflected?: boolean`(강화 멱등 게이트). 업로드 성공 지점 2곳(서버 라우트·자동 업로드)에서
  `youtubeTs: new Date().toISOString()` 를 youtubeId 와 함께 저장.
- `MetricSample`(src/analytics/performance.ts): `likes?: number; comments?: number;` optional
  추가 — 기존 JSONL·소비자 하위호환(필드 없으면 undefined).

### 4.2 새 모듈 `src/analytics/shortsPerf.ts`

```ts
/** videos.list?part=statistics 50개 배치 — youtubeEnabled() 아니면 빈 Map. */
export async function fetchVideoStats(videoIds: string[], signal?: AbortSignal):
  Promise<Map<string, { views: number; likes: number; comments: number }>>;

/** 쇼츠 성과 → 0~1 스칼라(순수) — views 로그 스케일(1만뷰≈1.0) 0.8 + 좋아요율 0.2. */
export function shortsSignal(views: number, likes: number): number;

/** 일일 쇼츠 성과 동기화 — 수집(창 내 매일) + 창 경과 시 강화 1회. 전량 fail-open. */
export async function syncShortsPerformance(): Promise<void>;
```

`syncShortsPerformance()` 동작:
1. `youtubeEnabled()` 아니면 no-op.
2. 대상: `shortsStore().list()` 중 `youtubeId && youtubeTs` 보유.
3. 창 내(`now - youtubeTs ≤ SHORTS_PERF_DAYS`) 또는 (창 경과 && `!perfReflected`) 인
   쇼츠들의 videoId 를 모아 `fetchVideoStats` 배치 조회.
4. 각 쇼츠: `appendMetrics(short.id, { measuredAt, views, likes, comments, searchInflow: [], source: 'youtube:api' })`
   — 기존 piece 저장소 재사용(id 네임스페이스 `short_` 로 충돌 없음).
5. 창 경과 && `!perfReflected` 쇼츠는 `reinforceShorts(short, sample)` 후
   `shortsStore().update(id, { perfReflected: true })` — 멱등(다음 틱부터 대상 제외).
6. 쇼츠별 try/catch — 한 쇼츠 실패가 나머지를 막지 않는다. API 오류·삭제된 영상(응답 누락)은
   그 쇼츠만 스킵(로그 한 줄).

`reinforceShorts(short, sample)` — 기존 `reinforceFromPerformance` 미러:
- `signal = shortsSignal(views, likes)`.
- `appendMemory('shorts_writer', ...)` + `appendMemory('shorts_director', ...)`:
  제목·주제·성과 신호 + "이 주제·구성이 노출로 이어짐 / 저조" 요지(신호 상하위 문구 분기).
- `llmWiki` 적재(주제·조회수·신호 — 브랜드 컨텍스트 포함).
- 파생 쇼츠(`sourcePieceId`)면 원본 piece 의 keyword 를 문구에 포함(키워드 신호 합류).
- 역할 id 부재·위키 실패는 강화를 막지 않는다(기존 패턴).

### 4.3 배선

- `server/main.ts` 의 일일 동기화 `run`:
  `run: () => { void syncPerformance(); void syncShortsPerformance(); }` —
  `naverProfileBusy` 락 **밖**(쇼츠는 순수 API — 브라우저 프로필 무관).
- `CONFIG.shortsPerfDays` = `envInt('SHORTS_PERF_DAYS', 7)`.

### 4.4 UI (쇼츠 카드 뱃지)

- `shortsListHandler`: 각 쇼츠에 `latestMetrics(x.id)` 최신값을 `views/likes` 로 첨부
  (youtubeUrl 있는 쇼츠만 조회 — 파일 1회 읽기, 목록 규모상 무해).
- `ShortsInfo`(frontend/src/api.ts): `views?: number; likes?: number;`.
- `ShortsView` 카드: `youtubeUrl` 뱃지 옆에 `views` 존재 시 `👁 {포맷} · 👍 {포맷}` 표시
  (1200→"1.2천" 축약 포맷 순수 헬퍼).

## 5. 에러 처리

- API 키 없음·`PERFORMANCE_SYNC_TIME` off·유튜브 쇼츠 없음 → 완전 no-op(기존 경로 불변).
- API 오류·쿼터 초과·삭제된 영상 → 해당 쇼츠만 스킵 + `[perf-sync]` 로그 한 줄, 다음 틱 재시도
  (창 내면 자동 재시도, 창 경과 강화 대상이면 `perfReflected` 미마킹이라 다음 틱 재시도).
- 강화 실패(메모리/위키) → 기존 패턴대로 무해 처리.

## 6. 테스트

- 단위(vitest): `shortsSignal`(로그 스케일 경계·0뷰·좋아요율), `fetchVideoStats` 응답 파싱
  (정상/누락 id/이형 — fetch 는 주입 불가하므로 파싱 부분을 순수 함수 `parseStatsResponse(json)`
  로 분리해 테스트), 대상 선별 술어 `shortsPerfDue(short, now, days)` 순수화 + 테스트
  (창 내/경과/reflected/필드 결측).
- 실검증: 오늘 업로드된 `short_d2f77f5e55`(youtubeId 보유)로 `syncShortsPerformance()` 1회
  실행 → metrics JSONL 생성·카드 뱃지 표시 확인. 단, `youtubeTs` 가 없는 **기존 레코드**라
  백필 필요 — 실검증 절차에 1회 백필(youtubeTs=업로드일) 포함.
- 회귀: 키 없음 경로 no-op, 기존 piece 동기화 불변.

## 7. 의존성

- 새 의존성 없음. `YOUTUBE_API_KEY` 는 이미 설정돼 있음(조사용 커넥터 공유).
- 쿼터: videos.list 1단위/50개 — 일 1~2단위(무시 가능 수준).

## 8. 완료 기준

- 업로드된 쇼츠가 매일 시계열 수집되고(JSONL), 측정창 경과 시 1회 강화(멱등)된다 —
  실검증: 실제 영상 1건으로 수집·뱃지 확인(강화는 신호 로그로 확인).
- 키 없음·off 경로 회귀 없음. 순수 헬퍼 테스트 통과, 루트+remotion tsc 0, 프론트 빌드 성공.

## 9. 보강 (플랜 작성 중 발견)

**비공개 영상 제약**: `videos.list`(API 키)는 **비공개(private) 영상 통계를 반환하지 않는다**
(응답 items 에서 누락). 따라서 사람이 공개 전환하기 전까지는 "통계 없음 — 스킵"으로 자동
통과하고(무해 로그), 공개 후 첫 성공 수집부터 시계열이 쌓인다. 측정창(youtubeTs 기준)이
이미 경과한 뒤 공개됐다면 첫 성공 수집 시점에 즉시 강화 1회. 이는 의도된 동작 — 비공개
기간의 성과는 무의미하며, `perfReflected` 미마킹이라 강화 기회가 유실되지 않는다.
