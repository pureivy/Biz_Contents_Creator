# 사실 게이트 hold 율 저감 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사실 게이트의 오탐(판단문·유보문·관찰법을 무근거로 판정)을 없애고, 남는 통설 단정은 문장 단위 표적 수정으로 유보어/판단문으로 바꾸며, 작가에게 '사실 카드'를 주입해 처음부터 근거 범위 안에서 쓰게 한다 — 사용자 절대 규칙(근거 없는 사실 금지)은 그대로.

**Architecture:** `src/content/factGate.ts` 에 결정적 선분류(판단문·유보어·사건 표지)와 문장 단위 표적 수정(`repairSentences`+`applySentenceRepairs`)을 추가하고 `runFactGateWithRepair` 가 표적 수정을 먼저 시도한 뒤 실패 시에만 작가 전면 재작성으로 폴백한다. `src/orchestrator/org.ts` 는 브리프에서 사실 카드를 1회 추출해 작가 컨텍스트 첫 블록과 게이트 근거 첫 블록에 넣는다. 1차 판정은 `firstPass` 로 보존한다.

**Tech Stack:** TypeScript(Node 20, tsx), vitest, pnpm. LLM 호출은 `microJSON` 만.

**Spec:** 채팅 설계(2026-08-26, 사용자 승인 "1~6 전부") — 실측 근거: 3런 54주장 중 무근거 22 = 판단문 7 · 통설 단정 10 · 유보어 오판 3 · experience 오분류 3(관찰법).

## Global Constraints

- `pnpm test`·`pnpm typecheck` 통과 후 커밋. `rm` 금지(`trash`), `pnpm dev` 금지, `git add -A` 금지(다른 세션의 `data/` 변경분 존재).
- 서버는 `pnpm dev`(tsx watch) — 자율 사이클은 컨트롤러가 정지시킨 상태. 런을 띄우지 말 것.
- 사용자 확정 원칙 유지: 1인칭 판단·관점은 근거 불필요(08-12) · 유보어 붙은 통설 허용(08-26) · 겪지 않은 사건 서술 금지(08-02) · hold 는 자동 임시저장만 차단.
- 커밋 트레일러 2줄: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01HUSNN1pJkNxMnbvjqRHdmN`.
- 한국어 주석, 기존 factGate.ts 스타일(순수부/LLM부 분리) 유지. 새 LLM 호출은 fail-open 이 아니라 결과 null 을 정직하게 돌려주고 호출부가 폴백한다.

---

### Task 1: 게이트 정확도 — 판단문 제외·유보어 선분류·사건 표지·firstPass

**Files:**
- Modify: `src/content/factGate.ts`, `src/content/factGate.test.ts`

**Interfaces:**
- Produces (export):
  - `JUDGMENT_RE`, `HEDGE_RE`(factGate 전용 — shorts.ts 의 것과 별개), `EVENT_MARKER_RE`
  - `isJudgmentSentence(s: string): boolean` — 판단·관점·권유·채널 자기서술
  - `hasHedge(s: string): boolean`, `hasEventMarkers(s: string): boolean`
  - `classifyClaim(c: { text: string; kind: ClaimKind }): 'judgment' | 'hedged' | 'event' | 'claim'`
  - `FactGateResult.firstPass?: FactGateInfo`, `FactGateResult.filtered?: { judgment: number; hedged: number }`
  - `factGateBlog` 가 (1) judgment 를 판정에서 제외 (2) hedged 는 판정기에 "모순 여부만" 묻고 코드가 `hedged_general` 로 확정(판정이 contradicted 면 유지) (3) experience 는 사건 표지가 있을 때만 강제 unsupported, 없으면 kind 를 `general` 로 바꿔 정상 판정 (4) 추출 프롬프트에 제외 규칙·experience 협의(狹義) 명시.
  - `runFactGateWithRepair` 가 2차 결과에 `firstPass: toFactGateInfo(first)` 를 붙인다.

- [ ] **Step 1: 실패하는 테스트** (`factGate.test.ts` 에 추가; 기존 `mocked`/`beforeEach` 재사용)

```ts
import { isJudgmentSentence, hasHedge, hasEventMarkers, classifyClaim } from './factGate';

describe('선분류(2026-08-26 hold 율 저감) — 3런 실측 문장', () => {
  it('판단·관점·권유·채널 자기서술은 주장이 아니다', () => {
    for (const s of [
      '감나무 가을 거름은 모자란 쪽이 안전하다고 봅니다.',
      '같은 무늬가 열매에도 보이면 거름과는 무관하다고 봅니다.',
      '가지 갈라진 곳에 흰 덩어리가 붙어 있거나 잎이 끈적하다면 벌레 쪽부터 보는 편입니다.',
      '화분에 담긴 흙 부피가 정해져 있으니 마당에 선 나무와 같은 기준으로 넣지 않는 게 안전합니다.',
      '병이나 벌레로 보이는 나무에 거름부터 넣는 건 순서가 틀렸습니다.',
      '병든 잎과 떨어진 열매를 치우는 일이 먼저예요.',
      '자동으로 물이 나오는 장치를 쓰고 있다면 이 시기에 타이머부터 손봐야 합니다',
      '묘목 한 그루가 뿌리내리는 과정을 계절 단위로 이어서 기록하고 있어요',
    ]) expect(isJudgmentSentence(s), s).toBe(true);
    for (const s of ['질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.', '퇴비는 흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.', '겉흙 3cm가 말랐을 때 줍니다.'])
      expect(isJudgmentSentence(s), s).toBe(false);
  });
  it('유보어 — 대부분·흔히·경우가 많 포함', () => {
    expect(hasHedge('심은 지 1~2년 된 어린나무는 뿌리가 아직 넓게 뻗지 못한 경우가 대부분입니다.')).toBe(true);
    expect(hasHedge('잎맥은 초록으로 남고 그 사이만 흐려지는 모습이면 흔히 양분 쪽입니다.')).toBe(true);
    expect(hasHedge('질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.')).toBe(false);
  });
  it('사건 표지 — 연도·기간·우리 밭·문의 실태만', () => {
    expect(hasEventMarkers('지난해 우리 밭 어린 단감나무도 사흘 사이 스무 개 넘게 떨궜습니다')).toBe(true);
    expect(hasEventMarkers('저희 밭에서도 문의가 오면 이렇게 답합니다')).toBe(true);
    expect(hasEventMarkers("화분을 들었을 때 '아직 무겁네' 하는 날이 이어지면 그게 신호예요")).toBe(false);
    expect(hasEventMarkers('우리 나무 잎을 사흘 간격으로 두어 번 만져 보는 편이 정확합니다.')).toBe(false); // 관찰법 권유(사흘 간격 ≠ 사흘 만에)
  });
  it('classifyClaim 우선순위: event > judgment > hedged > claim', () => {
    expect(classifyClaim({ text: '지난해 우리 밭에서는 그렇게 봤습니다.', kind: 'experience' })).toBe('event');
    expect(classifyClaim({ text: '모자란 쪽이 안전하다고 봅니다.', kind: 'general' })).toBe('judgment');
    expect(classifyClaim({ text: '흔히 양분 쪽입니다.', kind: 'pest' })).toBe('hedged');
    expect(classifyClaim({ text: '가을에 양을 줄입니다.', kind: 'treatment' })).toBe('claim');
    expect(classifyClaim({ text: '무거우면 그게 신호예요', kind: 'experience' })).toBe('claim'); // 표지 없는 experience 는 일반 주장
  });
});

describe('factGateBlog — 선분류 반영', () => {
  it('판단문은 판정에 보내지 않고 filtered 에 세며, 유보문은 판정이 unsupported 여도 hedged_general, 표지 없는 experience 는 일반 판정', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [
        { text: '모자란 쪽이 안전하다고 봅니다.', kind: 'general' },
        { text: '흔히 양분 쪽입니다.', kind: 'pest' },
        { text: '무거우면 그게 신호예요', kind: 'experience' },
        { text: '가을에 양을 줄입니다.', kind: 'treatment' },
      ] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'unsupported' }, { index: 2, status: 'supported', evidence: '브리프' }, { index: 3, status: 'unsupported' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e' });
    const judgeUser = String(mocked.mock.calls[1]![2]);
    expect(judgeUser).not.toContain('안전하다고 봅니다');           // 판단문 제외
    expect(judgeUser).toContain('(유보)');                          // 유보문은 모순 여부만
    expect(r.filtered).toEqual({ judgment: 1, hedged: 1 });
    expect(r.claims.find((c) => c.text.includes('흔히'))!.status).toBe('hedged_general');
    expect(r.claims.find((c) => c.text.includes('무거우면'))!.status).toBe('supported');
    expect(r.claims.find((c) => c.text.includes('무거우면'))!.kind).toBe('general');
    expect(r.unsupported).toEqual(['가을에 양을 줄입니다.']);
    expect(r.status).toBe('hold');
  });
  it('유보문이라도 판정이 contradicted 면 유지한다', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [{ text: '대개 9월에 줍니다.', kind: 'time' }] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'contradicted', evidence: '자사 글: 추분 후' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e' });
    expect(r.contradicted).toHaveLength(1);
  });
  it('전부 판단문이면 판정 콜 없이 pass', async () => {
    mocked.mockResolvedValueOnce({ claims: [{ text: '자리부터 정한다고 봅니다.', kind: 'general' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e' });
    expect(r.status).toBe('pass'); expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe('runFactGateWithRepair — firstPass 보존', () => {
  it('2차 결과에 1차 요약이 붙는다', async () => {
    const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], repaired: false, checkedTs: 't' });
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const r = await runFactGateWithRepair({ gate, repair: async () => '## 고침' }, '## 원본');
    expect(r.result.firstPass).toEqual({ status: 'hold', unsupported: ['a'], contradicted: [], checkedTs: 't' });
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm vitest run src/content/factGate.test.ts` → FAIL

- [ ] **Step 3: 구현** (`factGate.ts`)

```ts
/** 판단·관점·권유·채널 자기서술 종결 — 사실 주장이 아니다(사용자 08-12: 1인칭 판단 유지). 3런 실측 7건이 이 꼴로 무근거 판정됐다. */
export const JUDGMENT_RE = /(?:고|다고|라고)\s*(?:봅니다|봐요|보고 있어요|보는 편)|보는 편입니다|편입니다|편이에요|편이 (?:정확|안전|낫)|게 안전(?:합니다|해요)|권(?:합니다|해요|하지 않)|먼저(?:예요|입니다)|그다음(?:입니다|이에요)|순서가 틀렸|낫습니다|나아요|낫다고|봐야 (?:합니다|해요)|손봐야|부터 (?:봅니다|보세요|봐요|확인합니다|확인해요|손봅니다)|기록하고 있어요|이어서 기록/;
/** 유보어 — '대부분' 포함(실측: "경우가 대부분입니다" 가 무근거 판정됨). shorts.ts 의 HEDGE_RE(낭독용)와 별개. */
export const HEDGE_RE = /대개|흔히|보통|대체로|대부분|경우가 많|경우가 대부분|수 있|수도 있|가능성|편이/;
/** 겪은 사건 표지 — NO_FABRICATED_EXPERIENCE 정의(연도·기간·수량·우리 밭 관찰·영업 실태) 그대로. '사흘 간격'(관찰법)은 표지가 아니다. */
export const EVENT_MARKER_RE = /지난해|작년|재작년|올해 초|지난\s*(?:봄|여름|가을|겨울)|(?:\d+|하루|이틀|사흘|나흘|닷새|열흘|보름)\s*(?:만에|사이에?|동안|째)|(?:우리|저희)\s*(?:밭|농장|포장|하우스|묘목장)|문의가 오면|주문이 들어오면|기록에 따르면|기록을 보면/;

export function isJudgmentSentence(s: string): boolean { return JUDGMENT_RE.test(s); }
export function hasHedge(s: string): boolean { return HEDGE_RE.test(s); }
export function hasEventMarkers(s: string): boolean { return EVENT_MARKER_RE.test(s); }

/** 선분류 우선순위: 사건 서술(금지) > 판단문(제외) > 유보문(통과) > 일반 주장(판정). */
export function classifyClaim(c: { text: string; kind: ClaimKind }): 'judgment' | 'hedged' | 'event' | 'claim' {
  if (hasEventMarkers(c.text)) return 'event';
  if (isJudgmentSentence(c.text)) return 'judgment';
  if (hasHedge(c.text)) return 'hedged';
  return 'claim';
}
```
- `FactGateResult` 에 `firstPass?: FactGateInfo; filtered?: { judgment: number; hedged: number };` 추가.
- 추출 프롬프트(`extractFactClaims`): '제외:' 줄을 `'제외: 상식 수준의 뻔한 문장, 1인칭 판단·관점·권유("~라고 봅니다", "~편입니다", "~게 안전합니다", "~부터 보세요"), 독자에게 권하는 행동 자체, 채널 자기서술("기록하고 있어요").'` 로, experience 정의를 `'experience 는 겪은 사건 서술(연도·기간·수량·우리 밭/농장 관찰·문의 실태)에만 쓴다 — 관찰 방법·기준 설명은 experience 가 아니다.'` 로 한 줄 추가.
- `judgeClaims(model, claims, evidence, opts)` 는 `claims` 원소에 선택 필드 `hedged?: boolean` 을 받아 목록에 `(유보)` 표기(`${i+1}. (${c.kind}${c.hedged ? '·유보' : ''}) ${c.text}` 와 별도로 프롬프트 규칙 ⑧ `'(유보) 표시 주장은 hedged_general 이 기본이다 — 근거 자료에 반대 진술이 있을 때만 contradicted 로 판정하라'`; 프롬프트에 문자열 `'(유보)'` 가 포함되게). experience 강제 unsupported 는 `c.kind === 'experience'` 그대로(호출부가 표지 없는 experience 를 general 로 바꿔 넘긴다).
- `factGateBlog`:
```ts
  const extracted = await extractFactClaims(...); if (!extracted) return error…; 
  let judgment = 0, hedged = 0;
  const toJudge: Array<{ text: string; kind: ClaimKind; hedged?: boolean }> = [];
  for (const c of extracted) {
    const cls = classifyClaim(c);
    if (cls === 'judgment') { judgment++; continue; }
    if (cls === 'event') { toJudge.push({ ...c, kind: 'experience' }); continue; }
    if (cls === 'hedged') { hedged++; toJudge.push({ ...c, kind: c.kind === 'experience' ? 'general' : c.kind, hedged: true }); continue; }
    toJudge.push({ ...c, kind: c.kind === 'experience' ? 'general' : c.kind });
  }
  const filtered = { judgment, hedged };
  if (!toJudge.length) return { ...base, status: 'pass', filtered };
  const judged = await judgeClaims(a.model, toJudge, a.evidence, { signal: a.signal });
  if (!judged) return { ...base, status: 'error', error: '주장 판정 실패(LLM 무응답)', claims: toJudge.map(...unsupported), filtered };
  const fixed = judged.map((c, i) => (toJudge[i]!.hedged && c.status !== 'contradicted') ? { ...c, status: 'hedged_general' as const } : c);
  const v = gateVerdict(fixed);
  return { ...base, claims: fixed, ...v, filtered };
```
- `runFactGateWithRepair`: `return { body: repaired, result: { ...second, repaired: true, firstPass: toFactGateInfo(first) } };`

- [ ] **Step 4: 통과 확인** — `pnpm vitest run src/content/factGate.test.ts && pnpm typecheck && pnpm test`
- [ ] **Step 5: 커밋** — `feat(factgate): 판단문 제외·유보어 선분류·사건 표지 협의·firstPass 보존(hold 오탐 3종 제거)`

---

### Task 2: 문장 단위 표적 수정 — 전면 재작성 대신 유보어·판단문 전환

**Files:**
- Modify: `src/content/factGate.ts`, `src/content/factGate.test.ts`, `src/orchestrator/org.ts`

**Interfaces:**
- Produces:
  - `repairSentences(model, body, unsupported: string[], opts?: { signal? }): Promise<Array<{ index: number; action: 'hedge' | 'judgment' | 'delete'; replacement: string }> | null>` — micro 1콜. 규칙: 새 사실·수치 추가 금지, 문장 길이 비슷하게, hedge 는 "대개/흔히/보통"을 자연스럽게, judgment 는 "~라고 봅니다/~부터 봅니다/~게 안전합니다" 꼴, delete 는 그 문장이 빠져도 문단이 성립할 때만; `replacement` 는 완결 문장(마침표 포함), delete 면 빈 문자열.
  - `applySentenceRepairs(body: string, unsupported: string[], repairs: …): { body: string; applied: number; missed: string[] }` (순수) — 각 `unsupported[index-1]` 를 본문에서 찾아 치환. 매칭 순서: ① 정확 일치 ② 공백 정규화 일치 ③ 추출 시 160자 절단을 고려해 앞 40자 이상이 일치하는 문장(`splitBodySentences` 단위)까지 통째 치환. 못 찾으면 `missed` 에 원문. delete 는 문장 제거 후 이중 공백·빈 줄 정리.
  - `runFactGateWithRepair(a: { gate; repair; targeted?: (body: string, unsupported: string[]) => Promise<{ body: string; applied: number; missed: string[] }> }, body)`: 1차 hold 이고 `targeted` 가 있으면 먼저 표적 수정 → `applied > 0` 이면 그 본문으로 2차 판정하고 끝(`repaired: true`, `firstPass`). `applied === 0`(전부 miss 또는 LLM null) 이면 기존 작가 전면 재작성 경로. 총 LLM 콜 상한은 종전과 같은 5.
  - org.ts: `targeted` 배선 — `repairSentences(assign.standard, body, unsupported, { signal })` → `applySentenceRepairs`; 로그 `사실 게이트 — 표적 수정 N문장(누락 M)`.

- [ ] **Step 1: 실패하는 테스트**

```ts
import { applySentenceRepairs, repairSentences } from './factGate';

describe('applySentenceRepairs — 문장 단위 치환(순수)', () => {
  const body = '## 거름\n질소 성분이 앞선 화학비료는 가을에 양을 줄입니다. 퇴비는 흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.\n\n잎에 뿌리는 영양제로 대신할 수 없습니다.';
  it('정확 일치·공백 정규화·앞 40자 접두 일치로 치환하고 delete 는 제거한다', () => {
    const r = applySentenceRepairs(body,
      ['질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.', '퇴비는  흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.', '잎에 뿌리는 영양제로 대신할 수 없습니'],
      [{ index: 1, action: 'hedge', replacement: '질소 성분이 앞선 화학비료는 가을에는 대개 양을 줄입니다.' }, { index: 2, action: 'judgment', replacement: '퇴비는 효과가 더디게 나오는 쪽이라고 봅니다.' }, { index: 3, action: 'delete', replacement: '' }]);
    expect(r.applied).toBe(3); expect(r.missed).toEqual([]);
    expect(r.body).toContain('가을에는 대개 양을 줄입니다.');
    expect(r.body).toContain('더디게 나오는 쪽이라고 봅니다.');
    expect(r.body).not.toContain('영양제로 대신할 수 없습니다');
    expect(r.body).not.toMatch(/\n{3,}/);
  });
  it('못 찾는 문장은 missed 로 남기고 나머지는 적용한다', () => {
    const r = applySentenceRepairs(body, ['없는 문장입니다.', '잎에 뿌리는 영양제로 대신할 수 없습니다.'],
      [{ index: 1, action: 'hedge', replacement: 'x' }, { index: 2, action: 'hedge', replacement: '잎에 뿌리는 영양제로는 대개 대신하기 어렵습니다.' }]);
    expect(r.applied).toBe(1); expect(r.missed).toEqual(['없는 문장입니다.']);
  });
  it('replacement 가 새 수치를 들이면 그 항목은 건너뛴다', () => {
    const r = applySentenceRepairs(body, ['잎에 뿌리는 영양제로 대신할 수 없습니다.'], [{ index: 1, action: 'hedge', replacement: '잎에 뿌리는 영양제는 3회까지는 대개 괜찮습니다.' }]);
    expect(r.applied).toBe(0); expect(r.missed).toEqual(['잎에 뿌리는 영양제로 대신할 수 없습니다.']);
  });
});

describe('repairSentences — 프롬프트·검증', () => {
  it('규칙(새 사실 금지·hedge/judgment/delete)이 프롬프트에 있고 잘못된 index/action 은 버린다', async () => {
    mocked.mockResolvedValueOnce({ repairs: [{ index: 1, action: 'hedge', replacement: 'a.' }, { index: 9, action: 'hedge', replacement: 'b.' }, { index: 2, action: 'rewrite', replacement: 'c.' }] });
    const r = await repairSentences('m', 'body', ['s1', 's2']);
    expect(r).toEqual([{ index: 1, action: 'hedge', replacement: 'a.' }]);
    const user = String(mocked.mock.calls[0]![2]);
    expect(user).toContain('새 사실·수치'); expect(user).toContain('hedge'); expect(user).toContain('judgment'); expect(user).toContain('delete');
  });
});

describe('runFactGateWithRepair — 표적 수정 우선', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], repaired: false, checkedTs: 't' });
  it('표적 수정이 적용되면 작가 재작성 없이 2차 판정', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(); const targeted = vi.fn(async () => ({ body: '## 표적', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).not.toHaveBeenCalled(); expect(r.body).toBe('## 표적'); expect(r.result.repaired).toBe(true);
  });
  it('표적 수정이 하나도 안 붙으면 작가 재작성으로 폴백', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async () => '## 재작성'); const targeted = vi.fn(async () => ({ body: '## 원본', applied: 0, missed: ['a'] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).toHaveBeenCalledTimes(1); expect(r.body).toBe('## 재작성');
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — `repairSentences` 프롬프트: 시스템 `SYS` 재사용; user 에 `[본문](8000자)`, `[고칠 문장](번호)`, 규칙(위 Interfaces 문구 그대로 + "replacement 에 본문에 없던 수치·시기·약제·품종 특성을 넣지 마라"), JSON `{"repairs":[{"index":1,"action":"hedge|judgment|delete","replacement":"..."}]}`; `maxOutputTokens: Math.min(3000, 300 + unsupported.length * 160)`. 검증: index 는 1..n 정수, action ∈ 3종, replacement 문자열(delete 면 '' 허용), 중복 index 는 첫 것만. `applySentenceRepairs` 의 새 수치 가드: `replacement` 에 `UNIT_RE|MONTH_RE|YEAR_RE` 매치가 있는데 원문에는 없으면 건너뛴다(`missed` 에 원문). org.ts 배선은 Interfaces 대로; 표적 수정 로그를 gate 로그 앞에 한 줄.
- [ ] **Step 4: 통과 확인** — `pnpm vitest run src/content/factGate.test.ts && pnpm typecheck && pnpm test`
- [ ] **Step 5: 커밋** — `feat(factgate): 무근거 문장 표적 수정(유보어·판단문·삭제) — 전면 재작성은 폴백으로`

---

### Task 3: 사실 카드 — 브리프의 근거 있는 사실을 작가와 판정기에 선명하게

**Files:**
- Modify: `src/content/factGate.ts`, `src/content/factGate.test.ts`, `src/sessions/digest.ts`, `src/sessions/digest.test.ts`, `src/orchestrator/org.ts`

**Interfaces:**
- Produces:
  - `extractFactCard(model, brief, opts?: { max?: number; signal? }): Promise<string | null>` — micro 1콜. 브리프에서 **근거 표기가 있는 사실 문장만**(`[근거:`, `_(근거:`, URL, 커넥터 라벨 "검색광고 실검색량"·"연관 검색어(자동완성)"·"검색어트렌드(데이터랩)"·"네이버 블로그 SERP"·"유튜브 리서치"·기관명) 최대 `max`(기본 25)개를 `- 사실 (근거: 출처)` 불릿으로. 운영 수치(검색량·문서수·조회수)는 제외. 결과가 비면 null.
  - `FACT_CARD_HEADER = '[사실 카드 — 브리프에서 근거가 확인된 사실. 이 목록 밖의 사실·수치·시기·약제는 쓰지 말고, 꼭 필요하면 유보어("대개/흔히")를 붙인 일반론이나 판단문("~라고 봅니다")으로만 말하라]'`
  - `buildEvidence(parts)` 에 `factCard?: string` 추가 — 있으면 **첫 블록**으로 `[사실 카드(브리프 근거 확정)]`.
  - digest.ts: `writeFactCard(runId, card)`, `readFactCard(runId)`(`fact_card.md`).
  - org.ts `runOrg`: `writeResearchBrief` 직후 `const factCard = await extractFactCard(assign.micro, brief, { signal }).catch(() => null)`; 있으면 `writeFactCard`, 작가 컨텍스트 배열 **첫 원소**로 `${FACT_CARD_HEADER}\n${factCard}`, `writeBlogBody` 에 새 인자 `factCard?: string` 으로 전달(재집필 retry 컨텍스트와 `buildReviseContext` 에도 첫 블록으로). `runOrgRevise`: `readFactCard(revise.baseRunId)` → 없으면 브리프가 있을 때만 재추출. 게이트 `buildEvidence({ factCard, brief, … })`.

- [ ] **Step 1: 실패하는 테스트**

```ts
import { extractFactCard, FACT_CARD_HEADER } from './factGate';
describe('extractFactCard', () => {
  it('근거 표기 문장만 불릿으로, 운영 수치 제외 규칙이 프롬프트에 있고, 비면 null', async () => {
    mocked.mockResolvedValueOnce({ facts: ['감나무 주머니깍지벌레는 4월 하순부터 약충으로 깨어난다 (근거: 농사로 curationNo=1964)', ''] });
    const c = await extractFactCard('m', '브리프', { max: 10 });
    expect(c).toBe('- 감나무 주머니깍지벌레는 4월 하순부터 약충으로 깨어난다 (근거: 농사로 curationNo=1964)');
    const user = String(mocked.mock.calls[0]![2]);
    expect(user).toContain('검색량'); expect(user).toContain('최대 10');
    mocked.mockResolvedValueOnce({ facts: [] });
    expect(await extractFactCard('m', '브리프')).toBeNull();
  });
  it('buildEvidence 는 사실 카드를 첫 블록으로', () => {
    const e = buildEvidence({ factCard: '- a', brief: 'b' });
    expect(e.startsWith('[사실 카드(브리프 근거 확정)]\n- a')).toBe(true);
  });
  it('헤더 문구', () => { expect(FACT_CARD_HEADER).toContain('이 목록 밖의 사실'); });
});
```
(digest.test.ts 에 `writeFactCard/readFactCard` 왕복 테스트 1건 — research_brief 테스트와 같은 꼴.)

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 프롬프트: `'아래 브리프에서 근거 표기가 있는 사실 문장만 뽑아라 — "[근거: …]", "_(근거: …)_", URL, 실측 커넥터 라벨(검색광고 실검색량·연관 검색어(자동완성)·검색어트렌드(데이터랩)·네이버 블로그 SERP·유튜브 리서치)·기관명(농사로·산림청 등)이 붙은 것. 검색량·문서수·조회수 같은 운영 수치는 제외. 각 항목은 "사실 (근거: 출처)" 한 줄, 최대 ${max}개. 근거 없는 문장은 넣지 마라.'` JSON `{"facts":["..."]}`; `maxOutputTokens: Math.min(3000, 400 + max * 90)`. 빈 문자열 항목 제거, 없으면 null. org.ts 배선은 Interfaces 대로(작가 컨텍스트 첫 블록·retry·revise·게이트 근거). 리서치 런(`research`)에서는 생략.
- [ ] **Step 4: 통과 확인** — `pnpm vitest run src/content/factGate.test.ts src/sessions/digest.test.ts && pnpm typecheck && pnpm test`
- [ ] **Step 5: 커밋** — `feat(factgate): 사실 카드 — 브리프의 근거 확정 사실을 작가 첫 블록·판정 근거 첫 블록에 주입`

---

### Task 4: 실런 실측·메모리·푸시 (컨트롤러 수행)
- 자율 사이클 재개 후 다음 자율 런 1편의 `fact_gate.json`(filtered·firstPass·표적 수정 로그) 확인, `fact-gate.md` 메모리 갱신, main 푸시.
