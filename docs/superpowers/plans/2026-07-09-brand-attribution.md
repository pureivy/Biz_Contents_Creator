# 성과 강화 산출물 브랜드 귀속 수정 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 성과 강화의 역할 메모리·위키 기록이 "활성 브랜드"가 아니라 "콘텐츠의 브랜드"에 귀속되게 한다(piece·쇼츠 공통, 브랜드 격리 원칙 복구).

**Architecture:** `brandFileSuffixFor(slug)` 순수 함수 추출 → `appendMemory(id, insight, brand?)` 옵션 인자 + `llmWikiFor(brand)` 전용 접근자(기존 `llmWiki()`·`brandFileSuffix()`는 위임으로 동작 불변) → 강화 경로 2곳(`reinforceFromPerformance`·`reinforceShorts`)만 콘텐츠 레코드의 brand 를 명시 전달. 기존 호출자(llmWiki 25곳·reflect.ts appendMemory) 무변경.

**Tech Stack:** TypeScript·vitest(기존). 새 의존성 없음.

## Global Constraints

- **기존 호출자 동작 바이트 동일**: `brandFileSuffix()`·`llmWiki()`·2-인자 `appendMemory` 는 위임/기본값 경로로 현행과 동일해야 한다.
- brand 의미: `undefined` = 활성 브랜드(현행), `''` = 범용 명시, `'슬러그'` = 그 브랜드 명시.
- `appendActivity`·`reflect.ts` 는 무변경(스펙 §2 — 브랜드 무관 파일 / 런 맥락이 곧 콘텐츠 브랜드).
- 강화 경로: piece 는 `piece.brand`, 쇼츠는 `s.brand` 를 전달. `appendMemory` 에는 `?? ''`(범용 명시), `llmWikiFor` 에는 그대로(`undefined` = 범용 디렉터리 — `brandFileSuffixFor(undefined)===''` 이라 동등).
- 빌드/테스트: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json`(exit 0), `npx vitest run <경로>`.
- 커밋 직전 `git status --short`로 내 파일만 스테이징(병렬 세션 data/ 금지). 브랜치 **main** 직접 커밋(사용자 지시).

---

### Task 1: 기반 — brandFileSuffixFor + appendMemory(brand?) + llmWikiFor + 테스트

**Files:**
- Modify: `src/content/brand.ts` (72~75행)
- Modify: `src/content/brand.test.ts` (describe 추가)
- Modify: `src/agents/workspace.ts` (13행 import, memoryFile·appendMemory ~91행)
- Modify: `src/agents/workspace.test.ts` (describe 추가)
- Modify: `src/wiki/llmwiki.ts` (17행 import, llmWiki ~1010행)

**Interfaces:**
- Produces:
  - `brandFileSuffixFor(slug: string | undefined): string` (순수)
  - `appendMemory(id: string, insight: string, brand?: string): void`
  - `llmWikiFor(brand: string | undefined): LlmWiki`
  - (불변) `brandFileSuffix(): string`, `llmWiki(): LlmWiki` — 위임으로 동작 동일.

- [ ] **Step 1: Write the failing tests**

`src/content/brand.test.ts` — 기존 import 라인에 `brandFileSuffixFor` 를 추가하고(기존 식별자 유지), 파일 끝에 추가:
```ts
describe('brandFileSuffixFor — 명시 슬러그 접미(순수)', () => {
  it("undefined·''(범용) → '', 슬러그 → '-슬러그'", () => {
    expect(brandFileSuffixFor(undefined)).toBe('');
    expect(brandFileSuffixFor('')).toBe('');
    expect(brandFileSuffixFor('브랜드a')).toBe('-브랜드a');
  });
});
```
`src/agents/workspace.test.ts` — import 블록을 다음으로 교체:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractVerifiedClaims } from './workspace';
```
파일 끝에 추가(임시 데이터 디렉터리 하네스 — secrets store 테스트와 동일 원리):
```ts
describe('appendMemory — 명시 brand 귀속(오귀속 회귀)', () => {
  const tmp = path.join(os.tmpdir(), 'workspace-brand-attr-test');
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무해 */ }
    delete process.env.GEPA_DATA_DIR;
    vi.resetModules();
  });
  it('활성 브랜드(범용)와 무관하게 명시 브랜드 파일에 기록되고, 활성 파일로 새지 않는다', async () => {
    fs.mkdirSync(tmp, { recursive: true });
    process.env.GEPA_DATA_DIR = tmp;
    vi.resetModules();
    const ws = await import('./workspace');
    ws.appendMemory('tester', '명시 귀속 교훈', '브랜드a');
    const brandFile = path.join(tmp, 'agents', 'tester', 'memory-브랜드a.md');
    expect(fs.existsSync(brandFile)).toBe(true);
    expect(fs.readFileSync(brandFile, 'utf-8')).toContain('명시 귀속 교훈');
    // 활성 브랜드(신선한 tmp = 범용)의 memory.md 로 새지 않음 — 오귀속 회귀 가드
    expect(fs.existsSync(path.join(tmp, 'agents', 'tester', 'memory.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/content/brand.test.ts src/agents/workspace.test.ts`
Expected: FAIL — `brandFileSuffixFor` export 없음 / appendMemory 3번째 인자 무시로 `memory.md` 에 기록되어 마지막 expect 실패. (기존 describe 들은 통과.)

- [ ] **Step 3: brand.ts 구현**

기존:
```ts
export function brandFileSuffix(): string {
  const s = activeBrandSlug();
  return s ? `-${s}` : '';
}
```
을 다음으로 교체:
```ts
/** 슬러그 → 브랜드 파일 접미(순수). undefined/''(범용) → ''. */
export function brandFileSuffixFor(slug: string | undefined): string {
  return slug ? `-${slug}` : '';
}
export function brandFileSuffix(): string { return brandFileSuffixFor(activeBrandSlug()); }
```

- [ ] **Step 4: workspace.ts 구현**

13행 — 기존:
```ts
import { brandFileSuffix } from '../content/brand';
```
을 다음으로 교체:
```ts
import { brandFileSuffix, brandFileSuffixFor } from '../content/brand';
```
memoryFile — 기존:
```ts
const memoryFile = (id: string): string => path.join(dir(id), `memory${brandFileSuffix()}.md`);
```
을 다음으로 교체:
```ts
const memoryFile = (id: string, brand?: string): string =>
  path.join(dir(id), `memory${brand !== undefined ? brandFileSuffixFor(brand) : brandFileSuffix()}.md`);
```
appendMemory — 기존:
```ts
export function appendMemory(id: string, insight: string): void {
  if (!safeId(id) || !insight.trim()) return;
  fs.mkdirSync(dir(id), { recursive: true });
  const date = kstDate();
  const p = memoryFile(id);
```
을 다음으로 교체(주석+시그니처+memoryFile 인자 — 함수 나머지는 그대로):
```ts
/** brand 명시 시 그 브랜드의 memory 파일에 귀속(성과 강화 등 활성≠콘텐츠 브랜드 경로용). 미지정=활성 브랜드(현행). */
export function appendMemory(id: string, insight: string, brand?: string): void {
  if (!safeId(id) || !insight.trim()) return;
  fs.mkdirSync(dir(id), { recursive: true });
  const date = kstDate();
  const p = memoryFile(id, brand);
```

- [ ] **Step 5: llmwiki.ts 구현**

17행 — 기존:
```ts
import { brandFileSuffix } from '../content/brand';
```
을 다음으로 교체(먼저 `grep -n "brandFileSuffix" src/wiki/llmwiki.ts` 로 1011행 외 사용처가 없음을 확인 — 있으면 brandFileSuffix 를 import 에 유지):
```ts
import { brandFileSuffixFor, activeBrandSlug } from '../content/brand';
```
llmWiki — 기존:
```ts
export function llmWiki(): LlmWiki {
  const suffix = brandFileSuffix();
  const dir = suffix ? path.join(path.dirname(CONFIG.wikiDir), `${path.basename(CONFIG.wikiDir)}${suffix}`) : CONFIG.wikiDir;
  if (!_wiki || _wikiDir !== dir) { _wiki = new LlmWiki(dir); _wikiDir = dir; }
  return _wiki;
}
```
을 다음으로 교체:
```ts
/** 명시 브랜드의 위키 인스턴스 — 강화 등 "콘텐츠 브랜드 ≠ 활성 브랜드" 일 수 있는 경로용. */
export function llmWikiFor(brand: string | undefined): LlmWiki {
  const suffix = brandFileSuffixFor(brand);
  const dir = suffix ? path.join(path.dirname(CONFIG.wikiDir), `${path.basename(CONFIG.wikiDir)}${suffix}`) : CONFIG.wikiDir;
  if (!_wiki || _wikiDir !== dir) { _wiki = new LlmWiki(dir); _wikiDir = dir; }
  return _wiki;
}
export function llmWiki(): LlmWiki { return llmWikiFor(activeBrandSlug() || undefined); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/content/brand.test.ts src/agents/workspace.test.ts`
Expected: PASS (기존 + 신규 describe).

- [ ] **Step 7: Typecheck + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src` → PASS(전체 — llmWiki 위임 회귀 확인).

- [ ] **Step 8: Commit**

```bash
git status --short   # 아래 5개 파일만 확인
git add src/content/brand.ts src/content/brand.test.ts src/agents/workspace.ts src/agents/workspace.test.ts src/wiki/llmwiki.ts
git commit -m "feat(brand): 명시 브랜드 귀속 기반 — brandFileSuffixFor·appendMemory(brand?)·llmWikiFor (기존 호출자 동작 불변)"
```

---

### Task 2: 강화 경로 2곳 — 콘텐츠 브랜드 전달 + 최종 검증

**Files:**
- Modify: `src/analytics/reinforce.ts` (import·reinforceWriter·호출부·위키)
- Modify: `src/analytics/shortsPerf.ts` (import·appendMemory·위키)

**Interfaces:**
- Consumes: Task 1 의 `appendMemory(id, insight, brand?)`·`llmWikiFor(brand)`.

- [ ] **Step 1: reinforce.ts 전달**

(a) import — 기존:
```ts
import { llmWiki } from '../wiki/llmwiki';
```
을 다음으로 교체(먼저 `grep -n "llmWiki" src/analytics/reinforce.ts` 로 upsertPage 1곳 외 사용처 없음 확인):
```ts
import { llmWikiFor } from '../wiki/llmwiki';
```
(b) reinforceWriter — 기존:
```ts
function reinforceWriter(title: string, keyword: string | undefined, signal: number): void {
```
을 다음으로 교체:
```ts
function reinforceWriter(title: string, keyword: string | undefined, signal: number, brand: string | undefined): void {
```
그 함수 안 — 기존:
```ts
    appendMemory(writerId, `성과 좋았던 글: "${title}"${keyword ? ` (타겟 "${keyword}")` : ''} — 이 주제·접근이 노출로 이어짐(성과신호 ${signal.toFixed(2)}). 유사 각도 유지.`);
```
을 다음으로 교체(콘텐츠 브랜드 명시 — 범용은 ''):
```ts
    appendMemory(writerId, `성과 좋았던 글: "${title}"${keyword ? ` (타겟 "${keyword}")` : ''} — 이 주제·접근이 노출로 이어짐(성과신호 ${signal.toFixed(2)}). 유사 각도 유지.`, brand ?? '');
```
(c) 위키 — 기존:
```ts
    llmWiki().upsertPage({
```
을 다음으로 교체:
```ts
    llmWikiFor(piece.brand).upsertPage({
```
(d) 호출부 — 기존:
```ts
  if (signal >= 0.6) reinforceWriter(piece.title, piece.keyword, signal);
```
을 다음으로 교체:
```ts
  if (signal >= 0.6) reinforceWriter(piece.title, piece.keyword, signal, piece.brand);
```

- [ ] **Step 2: shortsPerf.ts 전달**

(a) import — 기존:
```ts
import { llmWiki } from '../wiki/llmwiki';
```
을 다음으로 교체:
```ts
import { llmWikiFor } from '../wiki/llmwiki';
```
(b) 메모리 — 기존:
```ts
        appendMemory(role, `쇼츠 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 조회 ${m.views}·좋아요 ${m.likes ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`);
```
을 다음으로 교체:
```ts
        appendMemory(role, `쇼츠 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 조회 ${m.views}·좋아요 ${m.likes ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, s.brand ?? '');
```
(c) 위키 — 기존:
```ts
    llmWiki().upsertPage({
```
을 다음으로 교체:
```ts
    llmWikiFor(s.brand).upsertPage({
```

- [ ] **Step 3: Verify types + 전체 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src` → PASS.

- [ ] **Step 4: Commit**

```bash
git status --short   # 아래 2개 파일만 확인
git add src/analytics/reinforce.ts src/analytics/shortsPerf.ts
git commit -m "fix(brand): 성과 강화 산출물을 콘텐츠 브랜드에 명시 귀속(piece·쇼츠) — 활성 브랜드 오귀속 차단"
```

---

## 완료 기준 (스펙 §8)

- [ ] 강화 산출물(역할 memory·위키 performance 페이지)이 활성 브랜드와 무관하게 콘텐츠 브랜드에 기록(오귀속 회귀 테스트 포함).
- [ ] 기존 호출자(llmWiki 25곳·reflect.ts) 무변경·동작 불변 — 전체 스위트·tsc 0.
