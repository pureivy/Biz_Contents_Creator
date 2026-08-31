# 유튜브 쇼츠 성과 수집·강화 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 업로드된 쇼츠의 조회수·좋아요·댓글을 매일 수집(videos.list 배치)하고 측정창 경과 시 1회 강화해 측정→반영 루프를 완성한다.

**Architecture:** 새 모듈 `src/analytics/shortsPerf.ts`의 `syncShortsPerformance()`가 기존 일일 성과 동기화 틱에 편승 — `youtubeId+youtubeTs` 보유 쇼츠를 50개 배치로 `videos.list` 조회 → 기존 `appendMetrics` 시계열 재사용 → 창 경과 시 `reinforceShorts`(shorts_writer·shorts_director 메모리+위키, `perfReflected` 멱등). UI는 쇼츠 카드 뱃지.

**Tech Stack:** TypeScript(기존 fetchTimeout)·vitest·React(기존). 새 의존성 없음.

## Global Constraints

- 수집원: `videos.list?part=statistics`(기존 `YOUTUBE_API_KEY`) — 50개 배치 = 1쿼터단위/호출(업로드 쿼터와 독립). 게이트는 `getSecret('YOUTUBE_API_KEY')` 직접 확인 — 스펙의 `youtubeEnabled()`와 동치이며, grounding 모듈의 커넥터 등록 부수효과 import 를 피하기 위한 의도적 선택.
- **비공개 영상은 API 키로 통계 반환 안 됨**(items 누락, 스펙 §9) — "통계 없음 — 스킵" 로그 후 통과, `perfReflected` 미마킹이라 공개 전환 후 자동 재개. 의도된 동작.
- 케이던스: 업로드(`youtubeTs`) 후 `SHORTS_PERF_DAYS`(기본 **7**, env) 동안 매일 append, 창 경과 && `!perfReflected` 면 마지막 수집+강화 1회 후 `perfReflected: true`(멱등).
- 시계열: 기존 `appendMetrics(short.id, sample)` 재사용, `source: 'youtube:api'`, `searchInflow: []`.
- 전량 fail-open: 쇼츠별 try/catch + 전체 try/catch — 한 쇼츠 실패가 나머지·piece 동기화를 막지 않는다. 로그 프리픽스 `[perf-sync]`.
- 배선: 기존 `startDaily` perf-sync `run`에 편승(같은 `PERFORMANCE_SYNC_TIME` 스위치), `naverProfileBusy` 락 **밖**.
- 빌드/테스트: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json`(exit 0), `npx vitest run <경로>`, 프론트 `cd frontend && npm run build`.
- 커밋 직전 `git status --short`로 내 파일만 스테이징(병렬 세션 data/ 금지). 브랜치 **main** 직접 커밋(사용자 지시).

---

### Task 1: 타입·설정 확장 + youtubeTs 저장

**Files:**
- Modify: `src/analytics/performance.ts` (MetricSample, ~11행)
- Modify: `src/content/shorts.ts` (Shorts 인터페이스, ~40행)
- Modify: `src/config.ts` (인터페이스 ~120행, 객체 ~238행)
- Modify: `src/server/main.ts` (~1093행 업로드 성공 저장)
- Modify: `src/orchestrator/shorts.ts` (~279행 자동 업로드 성공 저장)

**Interfaces:**
- Produces: `MetricSample.likes?/comments?`, `Shorts.youtubeTs?/perfReflected?`, `CONFIG.shortsPerfDays: number`, 업로드 성공 시 `youtubeTs` 저장(측정창 기준점 — Task 2 의 `shortsPerfDue` 가 소비).

- [ ] **Step 1: MetricSample 확장**

`src/analytics/performance.ts` — 기존:
```ts
export interface MetricSample {
  measuredAt: string;
  views: number;
  dwellSec?: number;
  searchInflow: SearchInflow[];
```
을 다음으로 교체:
```ts
export interface MetricSample {
  measuredAt: string;
  views: number;
  dwellSec?: number;
  /** 유튜브 쇼츠 수집(youtube:api) 전용 — 네이버 piece 샘플엔 없음(하위호환 optional). */
  likes?: number;
  comments?: number;
  searchInflow: SearchInflow[];
```

- [ ] **Step 2: Shorts 확장**

`src/content/shorts.ts` — 기존:
```ts
  /** 유튜브 비공개 업로드 결과(발행은 사람이 유튜브 스튜디오에서 공개 전환). */
  youtubeId?: string;
  youtubeUrl?: string;
```
을 다음으로 교체:
```ts
  /** 유튜브 비공개 업로드 결과(발행은 사람이 유튜브 스튜디오에서 공개 전환). */
  youtubeId?: string;
  youtubeUrl?: string;
  /** 업로드 성공 시각 — 성과 측정창(SHORTS_PERF_DAYS) 기준점. */
  youtubeTs?: string;
  /** 성과 강화(1회) 완료 마킹 — 멱등 게이트. */
  perfReflected?: boolean;
```

- [ ] **Step 3: CONFIG 확장**

`src/config.ts` 인터페이스 — 기존:
```ts
  /** ready 쇼츠 자동 유튜브 비공개 업로드(옵트인). */
  readonly autoYtUpload: boolean;
```
을 다음으로 교체:
```ts
  /** ready 쇼츠 자동 유튜브 비공개 업로드(옵트인). */
  readonly autoYtUpload: boolean;
  /** 쇼츠 성과 측정창(일) — 업로드 후 이 기간 매일 수집, 경과 시 강화 1회. */
  readonly shortsPerfDays: number;
```
객체 — 기존:
```ts
  autoYtUpload: envBool('AUTO_YT_UPLOAD', false),
```
을 다음으로 교체:
```ts
  autoYtUpload: envBool('AUTO_YT_UPLOAD', false),
  shortsPerfDays: Math.max(1, envInt('SHORTS_PERF_DAYS', 7)),
```

- [ ] **Step 4: 업로드 성공 시 youtubeTs 저장 (2곳)**

`src/server/main.ts` — 기존:
```ts
  shortsStore().update(id, { youtubeId: r.videoId, youtubeUrl: r.url });
```
을 다음으로 교체:
```ts
  shortsStore().update(id, { youtubeId: r.videoId, youtubeUrl: r.url, youtubeTs: new Date().toISOString() });
```
`src/orchestrator/shorts.ts` — 기존:
```ts
      if (up.ok) { store.update(id, { youtubeId: up.videoId, youtubeUrl: up.url }); say(`유튜브 비공개 업로드 완료 — ${up.url}`); }
```
을 다음으로 교체:
```ts
      if (up.ok) { store.update(id, { youtubeId: up.videoId, youtubeUrl: up.url, youtubeTs: new Date().toISOString() }); say(`유튜브 비공개 업로드 완료 — ${up.url}`); }
```

- [ ] **Step 5: Verify types + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/analytics src/tools src/orchestrator` → PASS.

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 5개 파일만 확인
git add src/analytics/performance.ts src/content/shorts.ts src/config.ts src/server/main.ts src/orchestrator/shorts.ts
git commit -m "feat(perf): 쇼츠 성과 기반 필드(youtubeTs·perfReflected·likes/comments) + SHORTS_PERF_DAYS"
```

---

### Task 2: shortsPerf 모듈 + 순수 헬퍼 테스트

**Files:**
- Create: `src/analytics/shortsPerf.ts`
- Create: `src/analytics/shortsPerf.test.ts`

**Interfaces:**
- Consumes: Task 1 필드들, `appendMetrics`·`MetricSample`(analytics/performance), `shortsStore`·`Shorts`(content/shorts), `getSecret`(secrets/store), `fetchTimeout`(util/fetch), `llmWiki`(wiki/llmwiki), `appendMemory`·`appendActivity`(agents/workspace), `pieceStore`(content/pieces).
- Produces:
  - `interface VideoStats { views: number; likes: number; comments: number }`
  - `shortsSignal(views: number, likes: number): number` (순수)
  - `parseStatsResponse(json: unknown): Map<string, VideoStats>` (순수)
  - `shortsPerfDue(s: Pick<Shorts, 'youtubeId' | 'youtubeTs' | 'perfReflected'>, now: number, days: number): boolean` (순수)
  - `syncShortsPerformance(): Promise<void>` (Task 3 이 배선)

- [ ] **Step 1: Write the failing tests**

`src/analytics/shortsPerf.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { shortsSignal, parseStatsResponse, shortsPerfDue } from './shortsPerf';

describe('shortsSignal — 로그 스케일 + 좋아요율(순수)', () => {
  it('0뷰=0, 1만뷰≈0.8(뷰만), 좋아요율 1% 이상이면 +0.2 만점', () => {
    expect(shortsSignal(0, 0)).toBe(0);
    expect(shortsSignal(10_000, 0)).toBeGreaterThan(0.75);
    expect(shortsSignal(10_000, 0)).toBeLessThanOrEqual(0.8);
    expect(shortsSignal(10_000, 100)).toBeCloseTo(shortsSignal(10_000, 0) + 0.2, 5);
    expect(shortsSignal(100, 0)).toBeLessThan(shortsSignal(1_000, 0)); // 단조 증가
  });
});
describe('parseStatsResponse — 이형·결측 방어(순수)', () => {
  it('정상 항목 매핑, id 없음/비수치/음수 방어', () => {
    const m = parseStatsResponse({ items: [
      { id: 'v1', statistics: { viewCount: '123', likeCount: '4', commentCount: '5' } },
      { statistics: { viewCount: '9' } },
      { id: 'v2', statistics: { viewCount: 'x', likeCount: '-3' } },
    ] });
    expect(m.get('v1')).toEqual({ views: 123, likes: 4, comments: 5 });
    expect(m.has('')).toBe(false);
    expect(m.get('v2')).toEqual({ views: 0, likes: 0, comments: 0 });
    expect(parseStatsResponse(null).size).toBe(0);
    expect(parseStatsResponse({}).size).toBe(0);
  });
});
describe('shortsPerfDue — 창 내 매일·경과 후 미강화 1회(순수)', () => {
  const DAY = 86_400_000;
  const base = { youtubeId: 'v', youtubeTs: new Date(1_000_000_000_000).toISOString() };
  const now = 1_000_000_000_000;
  it('창 내 true(reflected 무관), 경과+미강화 true, 경과+강화 false', () => {
    expect(shortsPerfDue(base, now + 3 * DAY, 7)).toBe(true);
    expect(shortsPerfDue({ ...base, perfReflected: true }, now + 3 * DAY, 7)).toBe(true);
    expect(shortsPerfDue(base, now + 10 * DAY, 7)).toBe(true);
    expect(shortsPerfDue({ ...base, perfReflected: true }, now + 10 * DAY, 7)).toBe(false);
  });
  it('필드 결측·이상 Ts 는 false', () => {
    expect(shortsPerfDue({ youtubeTs: base.youtubeTs }, now, 7)).toBe(false);
    expect(shortsPerfDue({ youtubeId: 'v' }, now, 7)).toBe(false);
    expect(shortsPerfDue({ youtubeId: 'v', youtubeTs: '이상한값' }, now, 7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/analytics/shortsPerf.test.ts`
Expected: FAIL — "Cannot find module './shortsPerf'".

- [ ] **Step 3: Write the module**

`src/analytics/shortsPerf.ts`:
```ts
/**
 * 유튜브 쇼츠 성과 수집·강화 — 업로드된 쇼츠(youtubeId·youtubeTs)의 조회수·좋아요·댓글을
 * videos.list(YOUTUBE_API_KEY, 50개 배치=1쿼터단위)로 매일 수집해 기존 시계열(appendMetrics)에
 * 쌓고, 측정창(SHORTS_PERF_DAYS) 경과 시 1회 강화(shorts_writer·shorts_director 메모리+위키,
 * perfReflected 멱등). 비공개 영상은 API 가 통계를 안 주므로 자동 스킵 — 공개 전환 후 재개(스펙 §9).
 * 전량 fail-open — 실패는 해당 쇼츠만 스킵, 다음 틱 재시도. reinforceFromPerformance(piece)의 사촌.
 */
import { CONFIG } from '../config';
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { appendMetrics, type MetricSample } from './performance';
import { shortsStore, type Shorts } from '../content/shorts';
import { llmWiki } from '../wiki/llmwiki';
import { appendMemory, appendActivity } from '../agents/workspace';
import { pieceStore } from '../content/pieces';

export interface VideoStats { views: number; likes: number; comments: number }

/** 쇼츠 성과 → 0~1 스칼라(순수) — views 로그 스케일(1만뷰≈1.0) 0.8 + 좋아요율(1%≈만점) 0.2. */
export function shortsSignal(views: number, likes: number): number {
  const viewScore = Math.min(1, Math.log10(Math.max(0, views) + 1) / 4);
  const likeScore = views > 0 ? Math.min(1, likes / views / 0.01) : 0;
  return 0.8 * viewScore + 0.2 * likeScore;
}

/** videos.list 응답 → videoId→통계 Map(순수) — 이형·결측·음수 방어. */
export function parseStatsResponse(json: unknown): Map<string, VideoStats> {
  const out = new Map<string, VideoStats>();
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return out;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  for (const it of items) {
    const o = it as { id?: unknown; statistics?: { viewCount?: unknown; likeCount?: unknown; commentCount?: unknown } };
    const id = typeof o?.id === 'string' ? o.id : '';
    if (!id) continue;
    out.set(id, { views: n(o.statistics?.viewCount), likes: n(o.statistics?.likeCount), comments: n(o.statistics?.commentCount) });
  }
  return out;
}

/** 이번 틱 수집 대상인가(순수) — 창 내 매일, 또는 창 경과 후 미강화(강화 기회 유실 방지). */
export function shortsPerfDue(s: Pick<Shorts, 'youtubeId' | 'youtubeTs' | 'perfReflected'>, now: number, days: number): boolean {
  if (!s.youtubeId || !s.youtubeTs) return false;
  const t = new Date(s.youtubeTs).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= days * 86_400_000 || !s.perfReflected;
}

/** videos.list 50개 배치 — 키 없으면 빈 Map. HTTP 오류는 throw(호출자 fail-open). */
async function fetchVideoStats(videoIds: string[], signal?: AbortSignal): Promise<Map<string, VideoStats>> {
  const key = getSecret('YOUTUBE_API_KEY');
  const out = new Map<string, VideoStats>();
  if (!key || !videoIds.length) return out;
  for (let i = 0; i < videoIds.length; i += 50) {
    const ids = videoIds.slice(i, i + 50).join(',');
    const r = await fetchTimeout(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${encodeURIComponent(key)}`, {}, signal);
    if (!r.ok) throw new Error(`videos.list HTTP ${r.status}`);
    for (const [id, st] of parseStatsResponse(await r.json())) out.set(id, st);
  }
  return out;
}

/** 강화 1회 — reinforceFromPerformance(piece) 미러. 역할 부재·위키 실패는 무해. */
function reinforceShorts(s: Shorts, m: MetricSample): void {
  const signal = shortsSignal(m.views, m.likes ?? 0);
  const keyword = s.sourcePieceId
    ? (() => { try { return pieceStore().get(s.sourcePieceId!)?.keyword; } catch { return undefined; } })() ?? s.keyword
    : s.keyword;
  const title = s.title ?? s.topic;
  const verdict = signal >= 0.6 ? '이 주제·구성이 노출로 이어짐 — 유사 각도 유지' : '노출 저조 — 훅·주제 각도 재고';
  for (const role of ['shorts_writer', 'shorts_director']) {
    try {
      appendMemory(role, `쇼츠 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 조회 ${m.views}·좋아요 ${m.likes ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`);
      appendActivity(role, `📈 쇼츠 성과 학습: ${title.slice(0, 40)}`);
    } catch { /* 역할 부재 등 — 무해 */ }
  }
  try {
    llmWiki().upsertPage({
      title: `쇼츠 성과: ${title}`, type: 'performance',
      body:
        `조회 ${m.views}회 · 좋아요 ${m.likes ?? 0} · 댓글 ${m.comments ?? 0} · 성과신호 ${signal.toFixed(2)}\n` +
        `키워드: ${keyword ?? '-'} · 브랜드: ${s.brand ?? '범용'}\n` +
        (s.youtubeUrl ? `\n[근거: ${s.youtubeUrl}]` : ''),
      summary: `쇼츠 "${title}" 성과신호 ${signal.toFixed(2)} (조회 ${m.views})`,
      sources: [s.youtubeUrl ? `perf:${s.youtubeUrl}` : 'perf:youtube'],
      aliases: keyword ? [keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }
}

/** 일일 쇼츠 성과 동기화 — perf-sync 틱에서 piece 동기화와 나란히 호출(Task 3). */
export async function syncShortsPerformance(): Promise<void> {
  try {
    if (!getSecret('YOUTUBE_API_KEY')) return; // 커넥터 키 없음 — no-op
    const days = CONFIG.shortsPerfDays;
    const now = Date.now();
    const due = shortsStore().list().filter((s) => shortsPerfDue(s, now, days));
    if (!due.length) return;
    const stats = await fetchVideoStats(due.map((s) => s.youtubeId!));
    for (const s of due) {
      try {
        const st = stats.get(s.youtubeId!);
        if (!st) { console.log('[perf-sync]', `쇼츠 ${s.id} 통계 없음(비공개/삭제) — 스킵`); continue; }
        const sample: MetricSample = {
          measuredAt: new Date().toISOString(), views: st.views, likes: st.likes, comments: st.comments,
          searchInflow: [], source: 'youtube:api',
        };
        appendMetrics(s.id, sample);
        const windowOver = now - new Date(s.youtubeTs!).getTime() > days * 86_400_000;
        if (windowOver && !s.perfReflected) {
          reinforceShorts(s, sample);
          shortsStore().update(s.id, { perfReflected: true });
          console.log('[perf-sync]', `쇼츠 강화 완료: ${(s.title ?? s.topic).slice(0, 30)} (신호 ${shortsSignal(st.views, st.likes).toFixed(2)})`);
        }
      } catch (e) { console.log('[perf-sync]', `쇼츠 ${s.id} 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { console.log('[perf-sync]', `쇼츠 동기화 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/analytics/shortsPerf.test.ts`
Expected: PASS (3 describe).

- [ ] **Step 5: Typecheck + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/analytics src/tools src/orchestrator` → PASS.

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 2개 파일만 확인
git add src/analytics/shortsPerf.ts src/analytics/shortsPerf.test.ts
git commit -m "feat(perf): 쇼츠 성과 수집·강화 모듈(videos.list 배치·시계열·멱등 강화) + 순수 헬퍼 테스트"
```

---

### Task 3: 배선(일일 틱·목록 성과 첨부) + 카드 뱃지 + 최종 검증

**Files:**
- Modify: `src/server/main.ts` (perf-sync run + shortsListHandler + import)
- Modify: `frontend/src/api.ts` (ShortsInfo)
- Modify: `frontend/src/panels/ShortsView.tsx` (뱃지 + 포맷 헬퍼)

**Interfaces:**
- Consumes: `syncShortsPerformance`(Task 2), `latestMetrics`(analytics/performance — 기존).

- [ ] **Step 1: 일일 틱 편승**

`src/server/main.ts` — import 블록의 `import { ingestMetrics } from '../analytics/reinforce';` 아래에 추가:
```ts
import { syncShortsPerformance } from '../analytics/shortsPerf';
import { latestMetrics } from '../analytics/performance';
```
(참고: `latestMetrics` 가 이미 import 돼 있으면 그 줄은 생략.)
기존:
```ts
const stopPerfSync = startDaily({
  time: CONFIG.performanceSyncTime,
  run: () => { void syncPerformance(); },
```
을 다음으로 교체:
```ts
const stopPerfSync = startDaily({
  time: CONFIG.performanceSyncTime,
  run: () => { void syncPerformance(); void syncShortsPerformance(); }, // 쇼츠는 순수 API — 프로필 락 무관
```

- [ ] **Step 2: 목록에 최신 성과 첨부**

`src/server/main.ts` — 기존:
```ts
function shortsListHandler(c: Context): Response {
  return c.json({ shorts: shortsStore().list().filter(brandMatch).map((x) => ({ ...x, running: isShortsRunning(x.id) })) });
}
```
을 다음으로 교체:
```ts
function shortsListHandler(c: Context): Response {
  return c.json({
    shorts: shortsStore().list().filter(brandMatch).map((x) => {
      const m = x.youtubeUrl ? latestMetrics(x.id) : null; // 업로드된 쇼츠만 — 최신 수집값 뱃지용
      return { ...x, running: isShortsRunning(x.id), ...(m ? { views: m.views, likes: m.likes ?? 0 } : {}) };
    }),
  });
}
```

- [ ] **Step 3: 프론트 타입 + 뱃지**

`frontend/src/api.ts` — `ShortsInfo` 의 기존:
```ts
  youtubeUrl?: string;
```
을 다음으로 교체:
```ts
  youtubeUrl?: string;
  views?: number;
  likes?: number;
```
`frontend/src/panels/ShortsView.tsx` — `fmtWhen` 함수 아래에 추가:
```ts
// 성과 수 축약 — 1234→"1.2천", 12345→"1.2만"(뱃지 폭 절약).
function fmtCount(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}천`;
  return String(n);
}
```
버튼 블록의 기존:
```tsx
            {s.youtubeUrl ? (
              <a className="btn ghost" href={s.youtubeUrl} target="_blank" rel="noreferrer" title="비공개 업로드됨 — 공개 전환은 유튜브 스튜디오에서">▶ 유튜브(비공개)</a>
            ) : yt.connected ? (
```
을 다음으로 교체(뱃지 추가):
```tsx
            {s.youtubeUrl ? (
              <>
                <a className="btn ghost" href={s.youtubeUrl} target="_blank" rel="noreferrer" title="비공개 업로드됨 — 공개 전환은 유튜브 스튜디오에서">▶ 유튜브(비공개)</a>
                {typeof s.views === "number" && (
                  <span className="chip" title="유튜브 성과(최신 수집 — 매일 갱신)">👁 {fmtCount(s.views)}{typeof s.likes === "number" ? ` · 👍 ${fmtCount(s.likes)}` : ""}</span>
                )}
              </>
            ) : yt.connected ? (
```

- [ ] **Step 4: Verify — 백엔드 + 프론트 빌드**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/analytics src/tools src/orchestrator` → PASS.
Run: `cd frontend && npm run build` → 빌드 성공.

- [ ] **Step 5: 실검증(선택 — 과금 없음, 컨트롤러 수행)**

기존 업로드 영상(`short_d2f77f5e55`)은 `youtubeTs` 없는 레코드라 1회 백필 후 수동 실행:
① 백필: 쇼츠 스토어 JSON 에 `youtubeTs`(업로드일) 추가 ② `npx tsx` 하네스로 `syncShortsPerformance()` 1회 →
현재 **비공개 상태라 "통계 없음(비공개/삭제) — 스킵" 로그가 정상**(스펙 §9). 공개 전환된 영상이 있으면
`data/analytics/metrics/short_*.jsonl` 생성 + 카드 뱃지 표시 확인.

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 3개 파일만 확인
git add src/server/main.ts frontend/src/api.ts frontend/src/panels/ShortsView.tsx
git commit -m "feat(perf): 쇼츠 성과 일일 동기화 배선 + 목록 최신 성과 첨부 + 카드 뱃지"
```

---

## 완료 기준 (스펙 §8)

- [ ] 업로드된 쇼츠가 매일 시계열 수집(JSONL)되고 측정창 경과 시 1회 강화(멱등) — 비공개 스킵 동작 포함(§9).
- [ ] 키 없음·`PERFORMANCE_SYNC_TIME` off 경로 회귀 없음(기존 piece 동기화 불변).
- [ ] 순수 헬퍼(shortsSignal·parseStatsResponse·shortsPerfDue) 테스트 통과, 루트+remotion tsc 0, 프론트 빌드 성공.
