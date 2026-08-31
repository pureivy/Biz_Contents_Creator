# 키워드 클러스터 백로그 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대표 편 초안 확정 시 연관 검색어(자동완성) 형제들을 백로그로 채굴하고, 자율 틱이 간격을 두고 서로 다른 이야기로 소진한다.

**Architecture:** 새 스토어(`data/topics/backlog-<brand>.json`, promises 패턴 복사) + 채굴 모듈(자동완성 배열→코드 게이트→micro 판정) + `advancePieceReady` 훅 1개 + `pickAutoWork` 우선순위 1칸. 스펙: `docs/superpowers/specs/2026-08-06-keyword-cluster-backlog-design.md`.

**Tech Stack:** TypeScript(Node 20), vitest, 기존 microJSON/naverAutocomplete/novelty 재사용. 외부 의존성 추가 없음.

## Global Constraints

- 킬스위치: `process.env.TOPIC_CLUSTER !== 'off'` 를 채굴·소진 양쪽 호출부에서 검사(CONTENT_DIVERSITY 패턴 — config.ts 수정 없음).
- 브랜드 격리: 스토어 파일명·조회 전부 brand 슬러그 정확 일치. `(brand ?? '') === (target ?? '')` 비교(폴백 금지).
- 전량 fail-open: 채굴·소진의 어떤 실패도 런/승격을 막지 않는다(try-catch + 빈 반환).
- 캡(스펙 확정값): 시드당 형제 저장 6건 · 브랜드 pending 24건 · 클러스터당 소진 4편 · 같은 시드 쿨다운 = 최근 자율 blog 3편.
- 케이던스 불변: 클러스터 소진은 기존 `canGenerateNew` 게이트 **안**에서만(생산량 증가 금지).
- 주석은 한국어, 기존 파일의 주석 밀도·서술 톤(왜+실측 근거)을 따른다.
- 파일 삭제는 trash 사용(이 계획엔 삭제 없음). 커밋 트레일러: 기존 세션 규칙 그대로.

---

### Task 1: ClusterStore + 순수 선별 로직 (`src/content/topicCluster.ts`)

**Files:**
- Create: `src/content/topicCluster.ts`
- Test: `src/content/topicCluster.test.ts`

**Interfaces:**
- Consumes: `CONFIG.dataDir`(src/config), `genId`(src/util/ids), `offBrandTerm`·`activeBrandSlug`(src/content/brand)
- Produces(후속 태스크가 의존하는 정확한 형태):
  ```ts
  export interface ClusterTopic {
    id: string; brand?: string;
    seedKeyword: string; seedPieceId?: string;
    keyword: string; title: string; angle?: string;
    status: 'pending' | 'consumed' | 'dropped';
    consumedPieceId?: string;
    createdTs: string; updatedTs: string;
  }
  export const SIBLINGS_PER_SEED = 6;
  export const PENDING_CAP = 24;
  export const CONSUME_CAP_PER_SEED = 4;   // 소진 상한(시드 제외 형제 4편)
  export const SEED_COOLDOWN_PIECES = 3;   // 같은 시드 쿨다운(최근 자율 blog N편)
  export class ClusterStore {
    list(): ClusterTopic[];
    get(id: string): ClusterTopic | undefined;
    createMany(input: { brand?: string | null; seedKeyword: string; seedPieceId?: string;
      siblings: Array<{ keyword: string; title: string; angle?: string }> }): ClusterTopic[];
    update(id: string, patch: Partial<Omit<ClusterTopic, 'id' | 'createdTs'>>): ClusterTopic | undefined;
    pending(brand: string): ClusterTopic[];  // 등록순
  }
  export function clusterStore(): ClusterStore;
  /** 순수 — 소진 후보 1건 선택(쿨다운·클러스터 소진 상한 적용). recentAutoBlogSeeds = 최신순 clusterSeedId 목록. */
  export function pickNextSibling(
    pending: ClusterTopic[],
    all: ClusterTopic[],                       // consumed 카운트 계산용(같은 브랜드 전체)
    recentAutoBlogSeeds: Array<string | undefined>, // 최근 자율 blog piece 들의 clusterSeedId(최신순)
  ): ClusterTopic | null;
  ```
- 스토어 파일: `path.join(CONFIG.dataDir, 'topics', `backlog${brand ? `-${brand}` : ''}.json`)` — **주의**: promises 와 달리 브랜드별 파일 분리가 아니라 promises 처럼 단일 파일+brand 필드로 간다(`data/topics/backlog.json`, promises/index.json 과 동일 방식 — 스펙의 파일명 표기는 브랜드 "격리"의 뜻이고 구현은 필드 격리로 충분, 기존 promises 선례 따름).

**구현 규칙(createMany):**
- `sanitize`: title/keyword trim·80자 캡, 빈 keyword 제외.
- 입구 게이트: `offBrandTerm(`${title} ${keyword}`)` 걸리면 그 형제만 제외(로그), 전체는 계속.
- 중복: 같은 brand 에 같은 keyword(공백 제거·소문자 동치)의 pending/consumed 가 있으면 제외.
- 캡: 시드당 `SIBLINGS_PER_SEED` 건까지만, 브랜드 pending 이 `PENDING_CAP` 이상이면 초과분 버림(로그는 호출부).
- persist: promises 와 동일한 원자적 tmp+rename.

**pickNextSibling 규칙:**
- `recentAutoBlogSeeds.slice(0, SEED_COOLDOWN_PIECES)` 안에 같은 `seedKeyword` 의 형제가 만든 piece 시드가 있으면 그 시드 전체 건너뜀.
- 같은 seedKeyword 의 consumed 수 ≥ `CONSUME_CAP_PER_SEED` 면 그 시드 건너뜀.
- 통과한 것 중 등록 오래된 순 1건. 없으면 null.
- (쿨다운 비교 키는 seedKeyword 가 아니라 **시드 그룹 식별**이 필요 — recentAutoBlogSeeds 는 piece.clusterSeedId(= ClusterTopic.id)라서, 같은 시드 그룹 판정은 `all` 에서 id→seedKeyword 를 역참조해 비교한다.)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/content/topicCluster.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClusterStore, pickNextSibling, SIBLINGS_PER_SEED, PENDING_CAP, CONSUME_CAP_PER_SEED } from './topicCluster';
import type { ClusterTopic } from './topicCluster';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-'));

const sib = (n: number): { keyword: string; title: string } =>
  ({ keyword: `추희자두 형제${n}`, title: `추희자두 형제${n} 이야기` });

describe('ClusterStore — 등록·중복·캡·브랜드 격리', () => {
  let store: ClusterStore;
  beforeEach(() => { store = new ClusterStore(tmp()); });

  it('형제 N건 등록 + 같은 keyword 재등록은 중복 제외', () => {
    const a = store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(1), sib(2)] });
    expect(a).toHaveLength(2);
    const b = store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(2), sib(3)] });
    expect(b.map((x) => x.keyword)).toEqual(['추희자두 형제3']); // 형제2는 중복
  });

  it('시드당 상한 — SIBLINGS_PER_SEED 초과분은 버린다', () => {
    const many = Array.from({ length: 10 }, (_, i) => sib(i));
    expect(store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: many })).toHaveLength(SIBLINGS_PER_SEED);
  });

  it('브랜드 pending 캡 — PENDING_CAP 도달 시 추가 등록 안 됨', () => {
    for (let s = 0; s < 5; s++) {
      store.createMany({ brand: 'b1', seedKeyword: `시드${s}`,
        siblings: Array.from({ length: 6 }, (_, i) => ({ keyword: `시드${s} 갈래${i}`, title: `시드${s} 갈래${i} 글` })) });
    }
    expect(store.pending('b1').length).toBeLessThanOrEqual(PENDING_CAP);
  });

  it('브랜드 격리 — 다른 브랜드 pending 은 안 보인다', () => {
    store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(1)] });
    expect(store.pending('b2')).toHaveLength(0);
  });

  it('재로드 영속 — 새 인스턴스로 읽어도 남아 있다', () => {
    const dir = tmp();
    const s1 = new ClusterStore(dir);
    s1.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(1)] });
    expect(new ClusterStore(dir).pending('b1')).toHaveLength(1);
  });
});

describe('pickNextSibling — 쿨다운·소진 상한(순수)', () => {
  const mk = (id: string, seed: string, status: ClusterTopic['status'], ts: string): ClusterTopic => ({
    id, seedKeyword: seed, keyword: `${seed} ${id}`, title: `${seed} ${id} 글`,
    status, createdTs: ts, updatedTs: ts, brand: 'b1',
  });

  it('쿨다운 — 최근 자율 3편 안에 같은 시드 형제가 있으면 그 시드는 건너뛰고 다른 시드 선택', () => {
    const all = [mk('a1', '추희자두', 'pending', '1'), mk('b1x', '배롱나무', 'pending', '2')];
    // 최근 자율 blog: 가장 최근 것이 추희자두 형제(a0)였다 → 추희자두 시드 쿨다운
    const picked = pickNextSibling(all, [...all, mk('a0', '추희자두', 'consumed', '0')],
      ['a0', undefined, undefined]);
    expect(picked?.seedKeyword).toBe('배롱나무');
  });

  it('소진 상한 — consumed 4편인 시드는 제외', () => {
    const consumed = Array.from({ length: CONSUME_CAP_PER_SEED }, (_, i) => mk(`c${i}`, '추희자두', 'consumed', '0'));
    const all = [...consumed, mk('a9', '추희자두', 'pending', '5'), mk('b1x', '배롱나무', 'pending', '6')];
    expect(pickNextSibling(all.filter((t) => t.status === 'pending'), all, [])?.seedKeyword).toBe('배롱나무');
  });

  it('후보 없으면 null', () => {
    expect(pickNextSibling([], [], [])).toBeNull();
  });

  it('등록 오래된 순 — 같은 조건이면 createdTs 이른 것', () => {
    const all = [mk('n2', '감나무', 'pending', '2'), mk('n1', '배롱나무', 'pending', '1')];
    expect(pickNextSibling(all, all, [])?.id).toBe('n1');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/content/topicCluster.test.ts` → 모듈 없음 실패 예상
- [ ] **Step 3: 최소 구현** — `src/content/topicCluster.ts` 작성. promises.ts 의 load/persist(원자적 tmp+rename)·create 가드 패턴을 복사하되 위 Interfaces 형태 그대로. 파일 헤더 주석에 "예고 대장과 왜 별도인가"(스펙 ② 근거 요약) 포함. `ClusterStore` 생성자는 `constructor(dir: string = path.join(CONFIG.dataDir, 'topics'))`, 파일은 `backlog.json`.
- [ ] **Step 4: 통과 확인** — `npx vitest run src/content/topicCluster.test.ts` → 전건 PASS
- [ ] **Step 5: 커밋** — `git add src/content/topicCluster.ts src/content/topicCluster.test.ts && git commit -m "feat(content): 키워드 클러스터 백로그 스토어 + 소진 선별(쿨다운·상한) — 1/4"`

---

### Task 2: 채굴 파이프라인 (`src/orchestrator/clusterMine.ts`)

**Files:**
- Create: `src/orchestrator/clusterMine.ts`
- Test: `src/orchestrator/clusterMine.test.ts`

**Interfaces:**
- Consumes: `naverAutocomplete`(src/grounding/naver_autocomplete), `microJSON`(./agent), `resolveAssignment`(src/llm/setting), `findSimilarContent`·`collectExistingContent`·`keywordSimilar`(src/content/novelty), `offBrandTerm`(src/content/brand), `clusterStore`(src/content/topicCluster, Task 1), `pieceStore`(src/content/pieces)
- Produces:
  ```ts
  /** 순수 코드 게이트 — LLM 이전에 확실히 걸러지는 것들. exported for test. */
  export function filterCandidates(
    candidates: string[], seedKeyword: string, seedTitle: string,
    existing: Array<{ title: string; keyword?: string; kind: '블로그' | '쇼츠' | '카드뉴스' }>,
  ): { pass: string[]; rejected: Array<{ kw: string; why: string }> };
  /** 대표 편 ready 승격 훅에서 호출 — 채굴 전체(fire-and-forget 대상). 실패 무해. */
  export async function mineClusterForPiece(pieceId: string): Promise<number>; // 반환 = 등록 건수(로그용)
  ```

**filterCandidates 규칙(순수, LLM 무관):**
1. `offBrandTerm(kw)` → reject('브랜드 밖').
2. 시드와 동의어: `kw` 공백 제거·소문자가 시드와 동치 → reject('시드 동치'). (각도 판정은 LLM 몫 — 코드는 표기 동치만.)
3. 기존 콘텐츠 충돌: **시드 편 제외**(`e.title === seedTitle` 인 항목 제거) 후 `findSimilarContent({ title: kw, keyword: kw }, filtered)` 비면 pass, 있으면 reject('기존과 중복: <상대 제목>'). — 실측 근거: "추희자두 묘목"은 시드가 아닌 기발행 글과 충돌해야 걸린다.

**mineClusterForPiece 흐름:**
```ts
export async function mineClusterForPiece(pieceId: string): Promise<number> {
  try {
    const piece = pieceStore().get(pieceId);
    if (!piece || piece.clusterSeedId) return 0;          // 형제 글 자신은 재채굴 금지(클러스터의 클러스터 방지)
    const seed = (piece.keyword || seedKeyword(piece.title)).trim();
    if (!seed) return 0;
    const related = await naverAutocomplete(seed);
    if (!related.length) return 0;
    const existing = collectExistingContent(piece.brand || undefined);
    const { pass, rejected } = filterCandidates(related, seed, piece.title, existing);
    for (const r of rejected) console.log(`[cluster] 형제 기각 — "${r.kw}" (${r.why})`);
    if (!pass.length) return 0;
    // micro 판정 1회 — 검색 의도(angle)와 가제(title). 브랜드 컨텍스트로 소재 적합성 재확인.
    const judged = await microJSON<{ siblings?: Array<{ keyword?: string; title?: string; angle?: string; ok?: boolean }> }>(
      resolveAssignment().micro,
      '너는 콘텐츠 기획자다. 시드 주제로 이미 글 1편을 썼다. 아래 연관 검색어 각각에 대해, 시드 편과 "다른 이야기"가 되는 독립 글감인지 판정하라. ' +
      '다른 이야기가 되면 ok:true 와 함께 검색 의도(angle) 한 줄·클릭에 유리한 가제(title)를 제안하고, 시드 편과 같은 이야기의 표기 변형이면 ok:false.',
      `${brandContext() ? `${brandContext()}\n\n` : ''}[시드 편] ${piece.title} (키워드: ${seed})\n\n[연관 검색어]\n${pass.map((k) => `- ${k}`).join('\n')}\n\n형식: {"siblings":[{"keyword":"...","ok":true,"title":"...","angle":"..."}]}`,
      { maxOutputTokens: 700 },
    ).catch(() => null);
    const siblings = (judged?.siblings ?? [])
      .filter((s) => s?.ok !== false)
      .map((s) => ({ keyword: asString(s?.keyword).trim(), title: asString(s?.title).trim() || `${asString(s?.keyword).trim()} 이야기`, angle: asString(s?.angle).trim() || undefined }))
      .filter((s) => s.keyword && pass.some((k) => k.replace(/\s+/g, '') === s.keyword.replace(/\s+/g, ''))); // LLM 이 목록 밖 키워드를 지어내면 버린다
    if (!siblings.length) return 0;
    const created = clusterStore().createMany({ brand: piece.brand ?? null, seedKeyword: seed, seedPieceId: piece.id, siblings });
    if (created.length) console.log(`[cluster] 채굴 — 시드 "${seed}" 형제 ${created.length}건 백로그 등록`);
    return created.length;
  } catch (e) { console.log(`[cluster] 채굴 실패(무해): ${e instanceof Error ? e.message : String(e)}`); return 0; }
}
```
(import 는 실제 작성 시 정리: `seedKeyword` 는 src/grounding/naver_common, `brandContext`·`offBrandTerm` 은 src/content/brand, `asString` 은 src/util/str.)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/orchestrator/clusterMine.test.ts` (filterCandidates 순수부만 — LLM·IO 는 유닛 밖)

```ts
import { describe, it, expect } from 'vitest';
import { filterCandidates } from './clusterMine';

const existing = [
  { title: '추희자두 특징과 키우는 법', keyword: '추희자두', kind: '블로그' as const },      // 시드 편
  { title: '추희자두 묘목, 늦게 익는 나무를 심는다는 것', keyword: '추희자두 묘목', kind: '블로그' as const }, // 기발행
];

describe('filterCandidates — 채굴 코드 게이트', () => {
  it('시드 편 자신과의 유사는 무시하고, 다른 기발행 글과의 충돌은 기각한다(실측 시나리오)', () => {
    const { pass, rejected } = filterCandidates(
      ['추희자두 수확시기', '추희자두 묘목', '추희자두 후숙'],
      '추희자두', '추희자두 특징과 키우는 법', existing,
    );
    expect(pass).toContain('추희자두 수확시기');   // 시드와만 유사 — 계획된 갈래
    expect(pass).toContain('추희자두 후숙');
    expect(pass).not.toContain('추희자두 묘목');   // 기발행 글과 충돌 — 진짜 중복
    expect(rejected.find((r) => r.kw === '추희자두 묘목')?.why).toContain('중복');
  });

  it('시드 표기 동치(공백 차이)는 기각', () => {
    const { pass } = filterCandidates(['추희 자두'], '추희자두', '추희자두 특징과 키우는 법', existing);
    expect(pass).toHaveLength(0);
  });

  it('브랜드 밖 소재는 기각(offBrandTerm 게이트 — 활성 브랜드 없으면 통과)', () => {
    // offBrandTerm 은 활성 브랜드 프로필 기준 — 테스트 환경(브랜드 미설정)에선 null 반환이 정상.
    const { pass } = filterCandidates(['추희자두 병충해'], '추희자두', '추희자두 특징과 키우는 법', []);
    expect(pass).toContain('추희자두 병충해');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/orchestrator/clusterMine.test.ts` → 모듈 없음
- [ ] **Step 3: 구현** — 위 Produces/흐름 코드 그대로 작성(주석: 왜 시드 편을 제외하고 대조하는가 — 08-03 실측 한 줄).
- [ ] **Step 4: 통과 확인** — `npx vitest run src/orchestrator/clusterMine.test.ts` + `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `git add src/orchestrator/clusterMine.ts src/orchestrator/clusterMine.test.ts && git commit -m "feat(content): 클러스터 채굴 — 자동완성 배열→코드 게이트→micro 판정 — 2/4"`

---

### Task 3: `Piece.clusterSeedId` (`src/content/pieces.ts`)

**Files:**
- Modify: `src/content/pieces.ts` (Piece 인터페이스 ~L20-48, CreatePieceInput L50)
- Test: `src/content/pieces.test.ts` (기존 파일에 케이스 추가)

**Interfaces:**
- Produces: `Piece.clusterSeedId?: string`(ClusterTopic.id — 형제 소진으로 태어난 piece 의 출처), `CreatePieceInput.clusterSeedId?: string`.

- [ ] **Step 1: 실패하는 테스트 추가** — pieces.test.ts 의 기존 describe 에:

```ts
it('clusterSeedId — 생성 시 기록되고 재로드에도 유지된다', () => {
  const p = store.create({ title: '추희자두 후숙, 며칠이면 될까', keyword: '추희자두 후숙', clusterSeedId: 'cluster_abc' });
  expect(store.get(p.id)?.clusterSeedId).toBe('cluster_abc');
});
```
(기존 테스트 파일의 스토어 생성 픽스처 변수명을 따른다 — 파일 열어 동일 패턴 사용.)

- [ ] **Step 2: 실패 확인** — `npx vitest run src/content/pieces.test.ts`
- [ ] **Step 3: 구현** — Piece 에 `/** 클러스터 형제 소진으로 생성된 piece 의 출처(ClusterTopic.id) — 쿨다운 판정·성과 귀속용. */ clusterSeedId?: string;` 추가, CreatePieceInput 에 `clusterSeedId?: string` 추가, `create()` 에서 passthrough(기존 keyword 와 같은 방식).
- [ ] **Step 4: 통과 확인** — `npx vitest run src/content/pieces.test.ts`
- [ ] **Step 5: 커밋** — `git add src/content/pieces.ts src/content/pieces.test.ts && git commit -m "feat(content): Piece.clusterSeedId — 형제 piece 의 시드 출처 — 3/4"`

---

### Task 4: 서버 배선 — 채굴 훅 + 소진 칸 (`src/server/main.ts`)

**Files:**
- Modify: `src/server/main.ts` — ① `advancePieceReady`(L304 부근) ② `pickAutoWork`(L3271 부근) ③ `AutoWork` 타입(L3268) ④ launch 콜백(L3371 부근)
- Test: 유닛 없음(배선) — 검증은 Task 5 스모크 + `pnpm test` 전체 회귀.

**Interfaces:**
- Consumes: `mineClusterForPiece`(Task 2), `clusterStore`·`pickNextSibling`(Task 1), `Piece.clusterSeedId`(Task 3), 기존 `saturatedThemeMatches`·`collectExistingContent`·`offBrandTerm`·`getBrand`.

- [ ] **Step 1: import 추가**

```ts
import { clusterStore, pickNextSibling } from '../content/topicCluster';
import { mineClusterForPiece } from '../orchestrator/clusterMine';
```

- [ ] **Step 2: 채굴 훅 — `advancePieceReady` 끝부분(return owned; 직전)에**

```ts
  // 클러스터 채굴(스펙 2026-08-06) — 대표 편 초안 확정 시 연관 검색어 형제를 백로그로. 수동·자율 런이
  // 여기서 합류하므로 단일 훅으로 두 경로를 다 덮는다. 리비전은 같은 글 재확정이라 제외. fire-and-forget.
  if (!revised && process.env.TOPIC_CLUSTER !== 'off') {
    void mineClusterForPiece(pieceId).catch(() => { /* 무해 — mineClusterForPiece 내부도 fail-open */ });
  }
```

- [ ] **Step 3: `AutoWork` 타입에 클러스터 표식 추가** — piece 변형에 `clusterTopicId?: string`:

```ts
type AutoWork = { kind: 'piece'; piece: Piece; promiseId?: string; clusterTopicId?: string } | { kind: 'research'; title: string; brand: string }
  | { kind: 'shorts'; pieceId: string; title: string } | { kind: 'cardnews'; pieceId: string; title: string };
```

- [ ] **Step 4: `pickAutoWork` — 예고 이행 블록(try{...}catch 끝, L3317) 직후·`proposeContentIdeas` 호출 직전에 클러스터 칸**

```ts
    // 클러스터 형제 소진(스펙 2026-08-06) — 예고(약속)보다 뒤, 신규 아이디어보다 앞(검색 수요가 자동완성으로
    // 이미 검증된 주제). 케이던스(canGenerateNew) 안이므로 생산량은 불변, 다양성만 늘린다.
    if (process.env.TOPIC_CLUSTER !== 'off') {
      try {
        const all = clusterStore().list().filter((t) => (t.brand ?? '') === tickBrand);
        // 쿨다운 입력 — 최근 자율 blog piece 의 clusterSeedId(최신순).
        const recentSeeds = pieces.filter((p) => p.auto && (p.brand ?? '') === tickBrand)
          .sort((a, b) => b.createdTs.localeCompare(a.createdTs))
          .map((p) => p.clusterSeedId);
        const cand = pickNextSibling(all.filter((t) => t.status === 'pending'), all, recentSeeds);
        if (cand) {
          // 소진 시점 재검증 — 채굴과 소진 사이 코퍼스가 변했을 수 있다(스펙 ③).
          const off = offBrandTerm(`${cand.title} ${cand.keyword}`);
          const existingNow = collectExistingContent(tickBrand || undefined)
            .filter((e) => e.title !== (cand.seedPieceId ? pieceStore().get(cand.seedPieceId)?.title : undefined)); // 시드 편 제외
          const dup = off ? [] : findSimilarContent({ title: cand.title, keyword: cand.keyword }, existingNow);
          const sat = (off || dup.length) ? [] : saturatedThemeMatches({ title: cand.title, keyword: cand.keyword }, existingNow, 3, getBrand()?.compoundStems ?? []);
          if (off || dup.length) {
            clusterStore().update(cand.id, { status: 'dropped' });
            console.log(`[auto-cycle] 클러스터 기각 — "${cand.keyword}" (${off ? `소재 "${off}"` : `기존과 중복 "${dup[0]!.title.slice(0, 24)}"`}) → dropped`);
          } else if (sat.length) {
            console.log(`[auto-cycle] 클러스터 보류(소재 포화) — "${cand.keyword}" ≈ "${sat[0]!.title.slice(0, 24)}" → 신규 아이디어로 폴백`);
          } else {
            const piece = pieceStore().create({ title: cand.title, keyword: cand.keyword, brand: tickBrand || undefined, auto: true, clusterSeedId: cand.id });
            console.log(`[auto-cycle] 클러스터 형제 착수 — "${cand.keyword}" (시드 "${cand.seedKeyword}")`);
            return { kind: 'piece', piece, clusterTopicId: cand.id };
          }
        }
      } catch { /* 클러스터 실패 무해 — 신규 아이디어로 폴백 */ }
    }
```
(`findSimilarContent` 가 main.ts 에 이미 import 되어 있는지 확인 — 없으면 novelty import 줄에 추가.)

- [ ] **Step 5: launch 콜백 — 예고 fulfilled 마킹 줄(L3376) 옆에 consumed 마킹**

```ts
    if (id && w.clusterTopicId) { try { clusterStore().update(w.clusterTopicId, { status: 'consumed', consumedPieceId: w.piece.id }); } catch { /* 무해 */ } }
```
(예고와 동일 원칙: 런이 실제 시작됐을 때만 마킹 — 억제('')면 pending 유지, 다음 틱 재시도.)

- [ ] **Step 6: 전체 회귀** — `pnpm test` 전건 PASS + `npx tsc --noEmit`
- [ ] **Step 7: 커밋** — `git add src/server/main.ts && git commit -m "feat(content): 클러스터 배선 — ready 훅 채굴 + 자율 틱 소진 칸(예고 뒤·신규 앞) — 4/4"`

---

### Task 5: 실코퍼스 스모크 + 마무리

**Files:**
- 스크래치패드 일회용 스크립트(저장소 밖) — 커밋 없음.

- [ ] **Step 1: 채굴 스모크(실 LLM 1회)** — 발행된 배롱나무 piece 1건으로 `mineClusterForPiece` 직접 실행:

```bash
npx tsx -e "
import { mineClusterForPiece } from '<repo>/src/orchestrator/clusterMine';
import { clusterStore } from '<repo>/src/content/topicCluster';
mineClusterForPiece('piece_1b74b2ab84').then((n) => {
  console.log('등록', n, '건');
  console.log(clusterStore().list().map((t) => \`\${t.status} \${t.keyword} ← \${t.seedKeyword}\`).join('\n'));
});
"
```
기대: '배롱나무' 연관 검색어 중 기존 4편과 겹치지 않는 형제만 pending 등록(예: '배롱나무 가지치기' 등). 기존 글과 겹치는 후보('배롱나무 꽃 안 피는 이유' 등)는 기각 로그.

- [ ] **Step 2: 소진 선별 스모크(LLM 무관)** — `pickNextSibling` 을 실스토어로 실행해 1건이 나오는지, 쿨다운 입력을 채우면 건너뛰는지 확인.
- [ ] **Step 3: 스모크로 생긴 테스트 데이터 정리 판단** — Step 1 이 실제 백로그를 남긴다. **배롱나무 형제는 실제로 유효한 백로그이므로 남긴다**(이것이 곧 실런 검증의 입력이 된다). 단 명백히 이상한 항목이 있으면 `clusterStore().update(id, { status: 'dropped' })` 로 정리.
- [ ] **Step 4: main 푸시** — `git push origin main`
- [ ] **Step 5: 메모리 갱신** — 자동 메모리에 클러스터 기능 완료+실검증 대기 항목 기록(구현 세션이 아니라 본 세션 오케스트레이터가 수행).

---

## Self-Review 결과

- 스펙 커버리지: ①채굴=Task 2+4(훅) ②저장=Task 1 ③소진=Task 4 ④도배 방지=Task 1(pickNextSibling)+4(쿨다운 입력) ⑤키워드 전달=Task 4(create 에 keyword, launchRun 은 기존 `keyword: w.piece.keyword` 줄이 자동 처리 — 예고 경로의 누락 실수는 이 경로엔 없음) / 킬스위치=Global+Task 4 / 검증=각 태스크 TDD+Task 5. 범위 밖(UI·리서치 채굴·검색광고 우선순위)은 태스크 없음 — 의도적.
- 신규성 게이트 예외(스펙 ⑤): 클러스터 소진 경로는 `proposeContentIdeas` 를 거치지 않으므로 기존 게이트 수정이 불필요 — 자체 재검증(시드 제외 novelty)이 그 역할. 스펙의 "완화" 요구는 이 구조로 충족(기존 코드 무변경).
- 타입 일관성: `ClusterTopic`·`pickNextSibling`·`clusterSeedId`·`clusterTopicId` 명칭이 태스크 간 동일함을 확인.
