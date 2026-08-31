# 주제 선정 검색 수요 게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자율 사이클의 주제 선정이 절대 검색량(네이버 검색광고)과 데이터랩 추이(시즌 지수)를 보고 후보를 기각·후순위화하고, 두뇌 프롬프트에 시드 키워드의 수요 표를 주입해 처음부터 수요 있는 방향으로 제안하게 한다.

**Architecture:** 새 모듈 `src/analytics/topicDemand.ts` 가 (a) 후보 키워드 묶음의 수요 평가(검색광고 1~2콜 + 데이터랩 1콜, fail-open) (b) 일일 수요 스냅샷(`data/analytics/demand-<brand>.json`)과 프롬프트 블록을 제공한다. `src/autonomy/scheduler.ts` 의 후보 루프가 리서치 폐기 게이트 다음에 수요 판정을 넣어 `reject`(하한 미달)·`demote`(비수기)·`pass` 를 적용하고 로그를 남긴다. 일일 스냅샷은 기존 perf-sync 틱(main.ts)에 합류한다. 킬스위치 `TOPIC_DEMAND_GATE=off`.

**Tech Stack:** TypeScript(Node 20, tsx), vitest, pnpm. 커넥터 `searchAdVolumes`(src/grounding/naver_searchad.ts, 힌트 ≤5/콜, 연관어 포함 반환, "10 미만"=0·approx), `datalabTrend(keywords, months)`(src/grounding/naver_datalab.ts, ≤5/콜, 월별 ratio·direction).

**Spec:** 채팅 설계(2026-08-26, 사용자 승인 "1~4 전부"). 실측 근거(08-26): 우리 문구 검색량 0~30/월(가을 거름 0·유실수 가을 시비 0·사과나무 비료 30), 비료 데이터랩 3월 100→8월 13(비수기), 블로그 거름 중앙값 2회.

## Global Constraints

- `pnpm test`·`pnpm typecheck` 통과 후 커밋. `rm` 금지(`trash`), `pnpm dev` 금지, `git add -A` 금지.
- **서버는 tsx watch** — `src/` 저장·테스트 전 반드시 `curl -s http://127.0.0.1:8787/runs | grep -c '"status":"running"'` 가 0 이고 `pgrep -f naver_publish.py` 가 비어 있는지 확인, 아니면 대기. 자율 사이클은 컨트롤러가 정지시킨다. 런을 띄우지 말 것.
- fail-open: 커넥터 실패·키 없음이면 게이트 생략(로그 `수요 조회 실패 — 게이트 생략`)·프롬프트 블록 빈 문자열. 게이트는 하드 기각 1종(하한 미달)만, 비수기는 후순위(demote)일 뿐 기각 아님(기아 방지).
- 기본값: `TOPIC_DEMAND_MIN_VOLUME=30`, `TOPIC_DEMAND_MIN_SEASON=0.25`, `TOPIC_DEMAND_GATE=on`. `.env.example` 문서화.
- 커밋 트레일러: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01HUSNN1pJkNxMnbvjqRHdmN`. 한국어 주석.

---

### Task 1: 수요 평가 모듈 — 순수 함수 + 커넥터 묶음 호출 + 일일 스냅샷

**Files:**
- Create: `src/analytics/topicDemand.ts`, `src/analytics/topicDemand.test.ts`
- Modify: `src/config.ts`(3 키), `.env.example`

**Interfaces (export):**
```ts
export interface DemandRow {
  keyword: string;            // 후보 keyword 원문
  volume: number;             // 정확 일치(공백 제거) 행의 월 검색량(pc+mobile), 없으면 0
  approx: boolean;            // "10 미만" 표기였나
  familyMax: number;          // 후보의 내용 토큰을 전부 포함하는 연관어 중 최대 검색량
  familyTop?: string;         // 그 연관어
  seasonIdx?: number;         // 13개월 데이터랩: max(현재 월, 작년 다음달)/정점 (0~1), 데이터 없으면 undefined
  direction?: '상승' | '하락' | '보합';
}
export type DemandVerdict = 'pass' | 'demote' | 'reject' | 'unknown';
export const DEMAND_STOPWORDS: ReadonlySet<string>; // 시기·방법·법·주는·하는·전·후·언제·어떻게·하기·되는·좋은·나무(단독)…
export function contentTokens(keyword: string): string[];           // 공백 분리 → 2자 이상 → 불용어 제거 → '~나무' 는 유지
export function familyVolume(rows: Array<{ keyword: string; total: number }>, keyword: string): { max: number; top?: string };
export function seasonIndex(points: Array<{ period: string; ratio: number }>, now?: Date): number | undefined;
export function demandScore(row: DemandRow): number;               // log10(max(volume,familyMax)+1) × (0.5 + 0.5×(seasonIdx ?? 1))
export function demandVerdict(row: DemandRow | undefined, cfg: { minVolume: number; minSeason: number }): DemandVerdict;
export function formatDemandLine(row: DemandRow): string;           // `"사과나무 비료" 30/월(계열 최대 30) · 시즌 0.13↓`
export async function assessCandidatesDemand(keywords: string[], signal?: AbortSignal): Promise<Map<string, DemandRow>>; // 검색광고 ≤2콜 + 데이터랩 1콜, 실패 시 빈 Map
export interface DemandSnap { date: string; rows: DemandRow[] }
export async function refreshDemandSnapshot(signal?: AbortSignal): Promise<void>; // 하루 1회, 시드(brandSeedKeywords + winners 키워드) ≤15 → data/analytics/demand-<brand>.json (tmp+rename)
export function demandSignalBlock(slug?: string): string;          // `[검색 수요 실측 — YYYY-MM-DD]` + 점수순 상위 12줄 + 지시 1줄, 스냅샷 없거나 3일 초과면 ''
```
- `contentTokens('가을 거름 주는 시기')` → `['가을','거름']`; `contentTokens('사과나무 비료')` → `['사과나무','비료']`; `contentTokens('나무 거름 주는 시기')` → `['거름']`(단독 '나무' 불용어).
- `familyVolume`: 공백 제거 비교 — 행 키워드에 모든 내용 토큰이 포함될 때만 후보. `['가을','거름']` 에 '밑거름'(1220)은 불포함(가을 없음) → max 0.
- `seasonIndex`: points 는 오래된→최신. 정점 = max ratio; 현재 = 마지막 점; 다음달 = 13개 이상이면 `points[len-12]`(작년 같은 달 = 다음달 근사). 정점 0 이면 undefined.
- `demandVerdict`: row 없음 → 'unknown'(통과). `max(volume, familyMax) < minVolume` → 'reject'. `seasonIdx !== undefined && seasonIdx < minSeason` → 'demote'. 아니면 'pass'.
- `assessCandidatesDemand`: 키워드 중복 제거 → 5개씩 `searchAdVolumes` (≤2콜) → 각 후보에 exact(공백 제거 일치) 행과 family 계산 → `datalabTrend(keywords.slice(0,5), 13)` 1콜로 seasonIdx/direction. 연결자 비활성이면 빈 Map. 예외는 삼키고 빈 Map + `console.log('[demand] 조회 실패 — …')`.
- 스냅샷/블록: `refreshDemandSnapshot` 은 trendSignal.ts 의 `refreshTrendSnapshot` 과 같은 꼴(로컬 날짜, 같은 날 no-op, tmp+rename, 로그 `[demand] 수요 스냅샷 갱신 — N 키워드`). `demandSignalBlock` 지시문: `'검색량 10 미만·시즌 지수 0.25 미만 키워드로 주제를 세우지 마라. 수요가 있는 키워드는 그대로 keyword 로 쓰고, 계열 최대 연관어가 더 크면 그 표기를 우선하라.'`
- config: `topicDemandGate: envBool('TOPIC_DEMAND_GATE', true)`, `topicDemandMinVolume: envInt('TOPIC_DEMAND_MIN_VOLUME', 30)`, `topicDemandMinSeason: envFloat('TOPIC_DEMAND_MIN_SEASON', 0.25)` (+ `Config` 인터페이스). `.env.example` 에 3줄(한국어 주석).

- [ ] **Step 1: 실패하는 테스트** — `topicDemand.test.ts`: `contentTokens` 3케이스, `familyVolume`(가을·거름 vs 밑거름 불포함 / 블루베리·비료 vs 블루베리전용비료 포함 360), `seasonIndex`(13점: 3월 100·8월 13.3·작년 9월 20 → max(13.3,20)/100=0.2; 6점만 있으면 현재/정점), `demandScore`(단조 증가), `demandVerdict`(reject/demote/pass/unknown 각 1), `formatDemandLine`, `demandSignalBlock`(임시 디렉토리 스냅샷 파일로 — `vi.doMock('../config')` 로 `analyticsDir`/`dataDir` 경로 지정, 3일 초과면 ''), `assessCandidatesDemand`(`vi.mock('../grounding/naver_searchad')`·`naver_datalab` 로 고정 응답 → Map 내용; 커넥터 예외 → 빈 Map).
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 위 인터페이스 대로. 스냅샷 경로는 `path.join(CONFIG.dataDir, 'analytics', \`demand-${slug}.json\`)`(brand 없으면 `demand.json`).
- [ ] **Step 4: 통과 확인** — `pnpm vitest run src/analytics/topicDemand.test.ts && pnpm typecheck && pnpm test`
- [ ] **Step 5: 커밋** — `feat(topic): 검색 수요 평가 모듈 — 검색광고·데이터랩 묶음 조회·시즌 지수·판정·일일 스냅샷`

---

### Task 2: 스케줄러 배선 — 후보 수요 게이트·프롬프트 블록·일일 스냅샷 합류

**Files:**
- Modify: `src/autonomy/scheduler.ts`(후보 루프 ~439-520, 프롬프트 ~407), `src/server/main.ts:3742`(perf-sync 틱), `src/autonomy/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 전부, `CONFIG.topicDemand*`.
- Produces: `export function demandGateDecision(rows: Map<string, DemandRow>, keyword: string | undefined, cfg): { verdict: DemandVerdict; line: string }`(scheduler.ts, 순수 — 로그 문구 생성 포함) ; 프롬프트에 `demandSignalBlock()` 삽입(`trendSignalBlock` 다음) ; 후보 루프: 라운드당 `assessCandidatesDemand(cands.map(c=>c.keyword).filter(Boolean))` 1회(게이트 on 일 때만) → 각 후보에서 리서치 폐기 게이트 **다음**에 판정: `reject` → `console.log('[auto-cycle] 아이디어 기각(검색 수요 미달) — "title" (line)')` + `rejects.push(...)` + continue ; `demote` → `demoted` 배열에 보관하고 continue(similarFallback 과 같은 자격 규칙: 계열 게이트 none 만) ; `pass|unknown` → 기존 흐름. 라운드 끝에 새 소재 후보가 없으면 `demoted[0]` 채택(로그 `수요 비수기 후보 채택(대안 없음)`), 그다음 similarFallback. 채택 시 로그 `[auto-cycle] 수요 게이트 — "title" line 채택`.
- 일일: main.ts 3742 의 perf-sync run() 에 `void refreshDemandSnapshot().catch(() => {});` 추가.

- [ ] **Step 1: 실패하는 테스트** — `scheduler.test.ts`: `demandGateDecision`(reject 문구에 `N/월`·계열 최대 포함 / demote / pass / rows 에 없으면 unknown+빈 line). 기존 테스트 유지.
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 위 배선. `demoted` 처리 순서: 새 소재 pass 후보 → demoted → similarFallback. 게이트 off 면 `assessCandidatesDemand` 호출 자체를 생략(비용 0).
- [ ] **Step 4: 통과 확인** — `pnpm vitest run src/autonomy/scheduler.test.ts && pnpm typecheck && pnpm test`
- [ ] **Step 5: 커밋** — `feat(topic): 주제 선정 수요 게이트 — 검색량 하한 기각·비수기 후순위·수요 표 프롬프트 주입·일일 스냅샷`

---

### Task 3: 실측·메모리 (컨트롤러)
- 사이클 재개 후 다음 자율 틱 로그에서 `수요 게이트` 라인·기각/채택 확인, 스냅샷 파일 생성 확인, 메모리 갱신, 푸시.
