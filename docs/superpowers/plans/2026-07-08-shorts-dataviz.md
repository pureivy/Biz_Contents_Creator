# 쇼츠 데이터 시각화 씬 구현 플랜 (Phase 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 쇼츠 씬에 `kind`(hook/stat/list/quote/cta)를 도입하고 Remotion에 CountUp 수치·리스트 리빌·인용 카드 오버레이를 추가한다.

**Architecture:** shorts_writer 스키마 확장(kind+페이로드) → `normalizeSceneKind` 순수 정규화(불량 강등 fail-open) → 공유 타입 `ShortsScene` 확장 → Remotion `AutoShorts` 씬에 kind별 오버레이 조건부 렌더(기존 KenBurns 배경·KineticCaption 자막·오디오 유지). ffmpeg 폴백은 무변경(kind 무시, 우아한 열화).

**Tech Stack:** TypeScript(Node)·Remotion·zod(기존). 새 의존성 없음.

## Global Constraints

- 씬 `kind` 5종: `hook|stat|list|quote|cta`. `kind` 없는 씬 = 현행 렌더 그대로(하위 호환).
- 페이로드 캡(스펙 §4.1·4.2 그대로): stat `{ value: 유한수(콤마 제거 파싱), unit ≤6자, label ≤15자 }`, list `items 2~4개·각 ≤18자`, quote `{ text ≤40자(필수), source ≤15자 }`. hook/cta 페이로드 없음.
- 정규화 강등(fail-open): 페이로드 검증 실패 시 kind 필드를 **버리고** 기본 씬으로 — 렌더가 절대 깨지지 않는다.
- 수치 규칙(프롬프트): 블로그 파생=원문 수치만, 자유 주제=단계·개수 등 구조적 숫자만, 불확실하면 stat 금지. narration 은 수치 한글 낭독, stat.value 는 아라비아 숫자.
- 오버레이 위치: 화면 세로 중앙대 — 하단 25% 자막 세이프존·상단 프로그레스바 회피. 기존 KineticCaption(하단)은 유지·병행.
- hook/cta 는 KineticCaption `variant` 변형만(레이아웃 신설 없음). screenText 가 비면 현행처럼 무자막 = 변형도 무동작.
- ffmpeg 폴백·씬 QA(Phase 2a)·디자이너·SRT 무변경.
- 빌드/테스트: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json`(둘 다 exit 0), `npx vitest run <경로>`.
- 커밋 직전 `git status --short`로 내 파일만 스테이징 확인 — 병렬 세션의 data/ 파일 add 금지(`git add -A`/`git add .` 금지).

---

### Task 1: anim 순수 헬퍼 — countUpValue·staggerProgress + 테스트

**Files:**
- Modify: `remotion/anim.ts` (파일 끝에 추가)
- Modify: `src/tools/remotionAnim.test.ts` (describe 블록 추가)

**Interfaces:**
- Produces:
  - `countUpValue(local: number, total: number, value: number, settle = 12): number` — ease-out 카운트업. `local ≥ total - settle`이면 value 도달. 정수 value→정수, 소수 value→소수 1자리.
  - `staggerProgress(local: number, total: number, index: number, count: number, enter = 15, windowRatio = 0.6, rise = 12): number` — 항목 index 의 등장 진행도 0..1. enter 프레임부터 씬의 windowRatio 구간 안에 count 개 슬롯 분배, 항목당 rise 프레임에 걸쳐 0→1.

- [ ] **Step 1: Write the failing tests**

`src/tools/remotionAnim.test.ts` 끝에 추가:
```ts
describe('countUpValue — ease-out 카운트업, settle 전 도달', () => {
  it('시작 0, 끝 value, 단조 증가', () => {
    expect(A.countUpValue(0, 90, 42)).toBe(0);
    expect(A.countUpValue(90, 90, 42)).toBe(42);
    expect(A.countUpValue(78, 90, 42)).toBe(42); // total - settle(12) 에서 이미 도달
    const mid1 = A.countUpValue(20, 90, 42), mid2 = A.countUpValue(40, 90, 42);
    expect(mid1).toBeGreaterThanOrEqual(0);
    expect(mid2).toBeGreaterThanOrEqual(mid1);
  });
  it('소수 value 는 소수 1자리 유지', () => {
    expect(A.countUpValue(90, 90, 3.5)).toBeCloseTo(3.5, 5);
    expect(Number.isInteger(A.countUpValue(45, 90, 42))).toBe(true);
  });
});
describe('staggerProgress — 슬롯 분배·순서·경계', () => {
  it('enter 전 0, 충분히 지나면 1, 앞 항목이 먼저', () => {
    expect(A.staggerProgress(0, 90, 0, 3)).toBe(0);
    expect(A.staggerProgress(90, 90, 2, 3)).toBe(1);
    expect(A.staggerProgress(30, 90, 0, 3)).toBeGreaterThanOrEqual(A.staggerProgress(30, 90, 1, 3));
    expect(A.staggerProgress(30, 90, 1, 3)).toBeGreaterThanOrEqual(A.staggerProgress(30, 90, 2, 3));
  });
  it('count 0 은 1(무동작), 진행도는 0..1 클램프', () => {
    expect(A.staggerProgress(50, 90, 0, 0)).toBe(1);
    expect(A.staggerProgress(9999, 90, 0, 3)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/remotionAnim.test.ts`
Expected: FAIL — `countUpValue is not a function` (신규 2개 describe 실패, 기존 3개 통과).

- [ ] **Step 3: Write the implementation**

`remotion/anim.ts` 끝에 추가:
```ts
/** ease-out 카운트업 — total-settle 프레임까지 value 도달, 이후 유지. 정수 value→정수, 소수→1자리. */
export function countUpValue(local: number, total: number, value: number, settle = 12): number {
  const dur = Math.max(1, total - settle);
  const p = clamp01(local / dur);
  const eased = 1 - Math.pow(1 - p, 3);
  const d = Number.isInteger(value) ? 0 : 1;
  return Number((value * eased).toFixed(d));
}
/** 리스트 항목 index 의 등장 진행도(0..1) — enter 프레임부터 씬의 windowRatio 구간에 슬롯 분배. */
export function staggerProgress(local: number, total: number, index: number, count: number, enter = 15, windowRatio = 0.6, rise = 12): number {
  if (count <= 0) return 1;
  const windowEnd = Math.max(enter + 1, total * windowRatio);
  const slot = (windowEnd - enter) / count;
  const start = enter + slot * index;
  return clamp01((local - start) / rise);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/remotionAnim.test.ts`
Expected: PASS (기존 3 + 신규 2 describe).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"`
Expected: `tsc: 0`.

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 2개 파일만 확인
git add remotion/anim.ts src/tools/remotionAnim.test.ts
git commit -m "feat(shorts): anim 카운트업·스태거 순수 헬퍼 + 테스트"
```

---

### Task 2: ShortsScene kind 확장 + normalizeSceneKind + 테스트

**Files:**
- Modify: `src/tools/shortsCommon.ts` (타입 확장 + 함수 추가)
- Modify: `src/tools/shortsCommon.test.ts` (describe 블록 추가)

**Interfaces:**
- Produces:
  - `type SceneKind = 'hook' | 'stat' | 'list' | 'quote' | 'cta'`
  - `interface SceneKindFields { kind?: SceneKind; stat?: { value: number; unit?: string; label?: string }; items?: string[]; quote?: { text: string; source?: string } }`
  - `interface ShortsScene extends SceneKindFields { narration: string; screenText?: string }` (기존 필드 유지 — 하위 호환)
  - `normalizeSceneKind(raw: unknown): SceneKindFields` — LLM 씬 오브젝트에서 kind·페이로드를 검증 추출, 실패 시 `{}`(강등).

- [ ] **Step 1: Write the failing tests**

`src/tools/shortsCommon.test.ts` — import 라인에 `normalizeSceneKind` 추가:
```ts
import { sceneDurationSec, sceneFrames, fmtSrtTime, buildSrt, normalizeSceneKind } from './shortsCommon';
```
파일 끝에 추가:
```ts
describe('normalizeSceneKind — 검증 추출, 실패 시 {} 강등', () => {
  it('hook/cta 는 페이로드 없이 통과, 대소문자·공백 정규화', () => {
    expect(normalizeSceneKind({ kind: 'hook' })).toEqual({ kind: 'hook' });
    expect(normalizeSceneKind({ kind: ' CTA ' })).toEqual({ kind: 'cta' });
  });
  it('미지 kind·kind 없음 은 {}', () => {
    expect(normalizeSceneKind({ kind: 'banner' })).toEqual({});
    expect(normalizeSceneKind({})).toEqual({});
    expect(normalizeSceneKind(null)).toEqual({});
  });
  it('stat — 콤마 문자열 파싱, 비수치 강등, unit 6자·label 15자 캡', () => {
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: '1,200', unit: '%', label: '월 절감액' } }))
      .toEqual({ kind: 'stat', stat: { value: 1200, unit: '%', label: '월 절감액' } });
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: '많이' } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat' })).toEqual({});
    const long = normalizeSceneKind({ kind: 'stat', stat: { value: 3, unit: '1234567890', label: '가나다라마바사아자차카타파하호호' } });
    expect(long).toEqual({ kind: 'stat', stat: { value: 3, unit: '123456', label: '가나다라마바사아자차카타파하호' } });
  });
  it('list — 트림·빈 항목 제거·18자 캡·4개 절삭, 2개 미만 강등', () => {
    expect(normalizeSceneKind({ kind: 'list', items: [' 물주기 ', '', '분갈이', '햇빛', '통풍', '영양제'] }))
      .toEqual({ kind: 'list', items: ['물주기', '분갈이', '햇빛', '통풍'] });
    expect(normalizeSceneKind({ kind: 'list', items: ['하나'] })).toEqual({});
    expect(normalizeSceneKind({ kind: 'list' })).toEqual({});
  });
  it('quote — text 필수(40자 캡), source 15자 캡', () => {
    expect(normalizeSceneKind({ kind: 'quote', quote: { text: ' 시작이 반이다 ', source: '속담' } }))
      .toEqual({ kind: 'quote', quote: { text: '시작이 반이다', source: '속담' } });
    expect(normalizeSceneKind({ kind: 'quote', quote: { text: '  ' } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'quote' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/shortsCommon.test.ts`
Expected: FAIL — `normalizeSceneKind` export 없음 (기존 4개 describe 는 통과).

- [ ] **Step 3: Write the implementation**

`src/tools/shortsCommon.ts` 24행의 기존 한 줄
```ts
export interface ShortsScene { narration: string; screenText?: string }
```
을 다음으로 교체:
```ts
export type SceneKind = 'hook' | 'stat' | 'list' | 'quote' | 'cta';
export interface SceneKindFields {
  kind?: SceneKind;
  stat?: { value: number; unit?: string; label?: string };
  items?: string[];
  quote?: { text: string; source?: string };
}
export interface ShortsScene extends SceneKindFields { narration: string; screenText?: string }

/**
 * LLM 씬 오브젝트에서 kind·페이로드를 검증 추출 — 실패 시 {} 로 강등(fail-open, 렌더 무중단).
 * 캡: stat unit 6자·label 15자, list 2~4개·각 18자, quote text 40자·source 15자.
 */
export function normalizeSceneKind(raw: unknown): SceneKindFields {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = String(r.kind ?? '').trim().toLowerCase();
  if (kind === 'hook' || kind === 'cta') return { kind };
  if (kind === 'stat') {
    const s = (r.stat && typeof r.stat === 'object' ? r.stat : {}) as Record<string, unknown>;
    const rawVal = String(s.value ?? '').replace(/,/g, '').trim();
    const value = rawVal ? Number(rawVal) : NaN; // 빈 값은 Number('')=0 함정 회피 — 명시 거부
    if (!Number.isFinite(value)) return {};
    const unit = String(s.unit ?? '').trim().slice(0, 6);
    const label = String(s.label ?? '').trim().slice(0, 15);
    return { kind: 'stat', stat: { value, ...(unit ? { unit } : {}), ...(label ? { label } : {}) } };
  }
  if (kind === 'list') {
    const items = (Array.isArray(r.items) ? r.items : [])
      .map((x) => String(x ?? '').trim().slice(0, 18)).filter(Boolean).slice(0, 4);
    if (items.length < 2) return {};
    return { kind: 'list', items };
  }
  if (kind === 'quote') {
    const q = (r.quote && typeof r.quote === 'object' ? r.quote : {}) as Record<string, unknown>;
    const text = String(q.text ?? '').trim().slice(0, 40);
    if (!text) return {};
    const source = String(q.source ?? '').trim().slice(0, 15);
    return { kind: 'quote', quote: { text, ...(source ? { source } : {}) } };
  }
  return {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/shortsCommon.test.ts`
Expected: PASS (기존 4 + 신규 1 describe).

- [ ] **Step 5: Typecheck + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"`
Expected: `tsc: 0` (optional 필드라 기존 소비자 무영향).
Run: `npx vitest run src/tools`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 2개 파일만 확인
git add src/tools/shortsCommon.ts src/tools/shortsCommon.test.ts
git commit -m "feat(shorts): 씬 kind 스키마(ShortsScene 확장)·normalizeSceneKind 정규화 + 테스트"
```

---

### Task 3: planShorts — shorts_writer 프롬프트·정규화 배선

**Files:**
- Modify: `src/orchestrator/shorts.ts` (planShorts, 85~104행 부근)

**Interfaces:**
- Consumes: `normalizeSceneKind`(Task 2, `src/tools/shortsCommon.ts`).

- [ ] **Step 1: Add import**

`src/orchestrator/shorts.ts` 상단 import 블록(24행 `import type { ShortsScene } ...` 근처)에 추가:
```ts
import { normalizeSceneKind } from '../tools/shortsCommon';
```

- [ ] **Step 2: Extend the prompt**

`planShorts` 안의 두 줄을 교체한다.

(a) 기존:
```ts
    'screenText 는 씬당 1줄 15자 이내 키워드 요약(비워도 됨).',
```
을 다음 3줄로 교체:
```ts
    'screenText 는 씬당 1줄 15자 이내 키워드 요약(비워도 됨).',
    '씬 kind(선택): 씬1="hook", 마지막 씬="cta". 본문 씬 중 어울리는 곳에만 "stat"(핵심 수치 1개: value 숫자·unit 단위·label 15자)·"list"(items 2~4개, 각 18자)·"quote"(text 40자, source 출처) — 억지 배정 금지, 애매하면 kind 생략.',
    '수치 규칙: stat.value 는 원문(블로그 초안)에 있는 수치 또는 대본 구조상 자명한 숫자(단계 수·항목 수)만. 불확실하면 stat 을 쓰지 마라. narration 은 수치를 한글로 낭독하되 stat.value 는 아라비아 숫자.',
```

(b) 기존:
```ts
    'JSON 형식: {"title":"대표 제목","titles":["정보형","후킹형","질문형"],"scenes":[{"narration":"...","screenText":"..."}],"description":"2~3줄","hashtags":["#니치","#범용","#shorts"]}',
```
을 다음으로 교체:
```ts
    'JSON 형식: {"title":"대표 제목","titles":["정보형","후킹형","질문형"],"scenes":[{"narration":"...","screenText":"...","kind":"hook|stat|list|quote|cta(선택)","stat":{"value":42,"unit":"%","label":"라벨"},"items":["항목"],"quote":{"text":"인용","source":"출처"}}],"description":"2~3줄","hashtags":["#니치","#범용","#shorts"]}',
```

- [ ] **Step 3: Wire normalization**

(a) `callRoleJSON` 제네릭의 scenes 항목 타입 확장 — 기존:
```ts
  const j = await callRoleJSON<{ title?: unknown; titles?: unknown[]; scenes?: Array<{ narration?: unknown; screenText?: unknown }>; description?: unknown; hashtags?: unknown }>(
```
을 다음으로 교체:
```ts
  const j = await callRoleJSON<{ title?: unknown; titles?: unknown[]; scenes?: Array<{ narration?: unknown; screenText?: unknown; kind?: unknown; stat?: unknown; items?: unknown; quote?: unknown }>; description?: unknown; hashtags?: unknown }>(
```

(b) scenes 정규화 — 기존:
```ts
  const scenes = j.scenes.slice(0, 8).map((s) => ({
    narration: cleanNarration(s?.narration),
    screenText: stripEmoji(String(s?.screenText ?? '')).trim().slice(0, 20),
  })).filter((s) => s.narration);
```
을 다음으로 교체:
```ts
  const scenes = j.scenes.slice(0, 8).map((s) => ({
    narration: cleanNarration(s?.narration),
    screenText: stripEmoji(String(s?.screenText ?? '')).trim().slice(0, 20),
    ...normalizeSceneKind(s), // 불량 페이로드는 {} 강등 — 기본 씬으로 렌더
  })).filter((s) => s.narration);
```

- [ ] **Step 4: Verify types + tests**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/orchestrator src/tools` → PASS(회귀 없음).

- [ ] **Step 5: Commit**

```bash
git status --short   # src/orchestrator/shorts.ts 만
git add src/orchestrator/shorts.ts
git commit -m "feat(shorts): shorts_writer 씬 kind 기획 확장(프롬프트·정규화 배선)"
```

---

### Task 4: Remotion 오버레이 3종 + KineticCaption 변형

**Files:**
- Create: `remotion/StatCountUp.tsx`
- Create: `remotion/ListReveal.tsx`
- Create: `remotion/QuoteCard.tsx`
- Modify: `remotion/KineticCaption.tsx`

**Interfaces:**
- Consumes: `countUpValue`·`staggerProgress`·`clamp01`·`sceneFadeOpacity`(Task 1, `remotion/anim.ts`).
- Produces(Task 5 가 사용):
  - `StatCountUp: React.FC<{ stat: { value: number; unit?: string; label?: string }; total: number }>`
  - `ListReveal: React.FC<{ items: string[]; total: number }>`
  - `QuoteCard: React.FC<{ quote: { text: string; source?: string }; total: number }>`
  - `KineticCaption: React.FC<{ text: string; variant?: 'hook' | 'cta' }>` (variant 미지정 = 현행 동일)

- [ ] **Step 1: Create StatCountUp.tsx**

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { countUpValue, sceneFadeOpacity } from './anim';

/** stat 씬 오버레이 — 중앙대(하단 25% 자막 세이프존 회피) 반투명 패널에 CountUp 수치+단위+라벨. */
export const StatCountUp: React.FC<{ stat: { value: number; unit?: string; label?: string }; total: number }> = ({ stat, total }) => {
  const f = useCurrentFrame();
  const v = countUpValue(f, total, stat.value);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '30%' }}>
      <div style={{ background: 'rgba(0,0,0,.45)', borderRadius: 32, padding: '48px 72px', textAlign: 'center', opacity: sceneFadeOpacity(f, total, 8) }}>
        <div style={{ fontSize: 160, fontWeight: 900, color: '#fff', lineHeight: 1, textShadow: '0 4px 24px rgba(0,0,0,.6)' }}>
          {v.toLocaleString('ko-KR')}
          {stat.unit ? <span style={{ fontSize: 72, fontWeight: 800, marginLeft: 8 }}>{stat.unit}</span> : null}
        </div>
        {stat.label ? <div style={{ fontSize: 44, fontWeight: 700, color: 'rgba(255,255,255,.92)', marginTop: 20 }}>{stat.label}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Create ListReveal.tsx**

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { staggerProgress } from './anim';

/** list 씬 오버레이 — 항목별 스태거 리빌(fade+slide-up), 번호 액센트. */
export const ListReveal: React.FC<{ items: string[]; total: number }> = ({ items, total }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '28%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, width: '78%' }}>
        {items.map((it, i) => {
          const p = staggerProgress(f, total, i, items.length);
          return (
            <div key={i} style={{ background: 'rgba(0,0,0,.45)', borderRadius: 20, padding: '26px 36px', fontSize: 54, fontWeight: 800, color: '#fff', textShadow: '0 3px 16px rgba(0,0,0,.6)', opacity: p, transform: `translateY(${(1 - p) * 24}px)` }}>
              <span style={{ color: '#ffd54a', marginRight: 16 }}>{i + 1}</span>{it}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Create QuoteCard.tsx**

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { clamp01, sceneFadeOpacity } from './anim';

/** quote 씬 오버레이 — 따옴표 장식 인용 카드 페이드인(+살짝 스케일), source 는 작은 글씨. */
export const QuoteCard: React.FC<{ quote: { text: string; source?: string }; total: number }> = ({ quote, total }) => {
  const f = useCurrentFrame();
  const p = clamp01(f / 12);
  const op = Math.min(p, sceneFadeOpacity(f, total, 8));
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '28%' }}>
      <div style={{ background: 'rgba(0,0,0,.5)', borderRadius: 28, padding: '56px 64px', width: '80%', textAlign: 'center', opacity: op, transform: `scale(${0.94 + 0.06 * p})` }}>
        <div style={{ fontSize: 100, fontWeight: 900, color: '#ffd54a', lineHeight: 0.6 }}>“</div>
        <div style={{ fontSize: 58, fontWeight: 800, color: '#fff', lineHeight: 1.45, textShadow: '0 3px 16px rgba(0,0,0,.6)' }}>{quote.text}</div>
        {quote.source ? <div style={{ fontSize: 38, fontWeight: 600, color: 'rgba(255,255,255,.8)', marginTop: 24 }}>— {quote.source}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: KineticCaption variant**

`remotion/KineticCaption.tsx` 전체를 다음으로 교체(변경: props 에 `variant` 추가, hook=확대+액센트 컬러, cta=배지 컨테이너. variant 미지정 시 기존과 동일):
```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { captionWordsVisible } from './anim';

export const KineticCaption: React.FC<{ text: string; variant?: 'hook' | 'cta' }> = ({ text, variant }) => {
  const f = useCurrentFrame();
  const words = text.split(/\s+/).filter(Boolean);
  const vis = captionWordsVisible(f, words.length);
  const isHook = variant === 'hook';
  const isCta = variant === 'cta';
  const box: React.CSSProperties = isCta
    ? { background: '#e53935', borderRadius: 999, padding: '24px 56px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' }
    : { background: 'linear-gradient(transparent, rgba(0,0,0,.45))', padding: '32px 64px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' };
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: '20%' }}>
      <div style={box}>
        {words.map((w, i) => (
          <span key={i} style={{ fontSize: isHook ? 78 : 64, fontWeight: 800, color: isHook ? '#ffd54a' : '#fff', lineHeight: 1.25, textShadow: '0 3px 18px rgba(0,0,0,.75)', opacity: i < vis ? 1 : 0, transform: i < vis ? 'none' : 'translateY(16px)' }}>{w}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"`
Expected: `tsc: 0` (신규 컴포넌트는 아직 미사용 — Task 5 에서 배선).

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 4개 파일만 확인
git add remotion/StatCountUp.tsx remotion/ListReveal.tsx remotion/QuoteCard.tsx remotion/KineticCaption.tsx
git commit -m "feat(shorts): Remotion 데이터 시각화 오버레이 3종(CountUp·리스트·인용) + 자막 hook/cta 변형"
```

---

### Task 5: AutoShorts·propScenes kind 배선 + 최종 검증

**Files:**
- Modify: `remotion/AutoShorts.tsx`
- Modify: `src/tools/shortsRenderRemotion.ts` (propScenes, 29~35행)

**Interfaces:**
- Consumes: Task 4 컴포넌트 4종, Task 2 `ShortsScene` 확장 필드.

- [ ] **Step 1: Extend AutoShorts schema + Scene**

`remotion/AutoShorts.tsx` 전체를 다음으로 교체(변경: zod 에 kind·stat·items·quote optional 추가, Scene 에 kind별 오버레이 조건부 렌더 + variant 전달. 기본 렌더 경로는 기존과 동일):
```tsx
import React from 'react';
import { z } from 'zod';
import { AbsoluteFill, Series, Audio, staticFile } from 'remotion';
import { KenBurnsImage } from './KenBurnsImage';
import { KineticCaption } from './KineticCaption';
import { ProgressBar } from './ProgressBar';
import { StatCountUp } from './StatCountUp';
import { ListReveal } from './ListReveal';
import { QuoteCard } from './QuoteCard';

export const autoShortsSchema = z.object({
  scenes: z.array(z.object({
    imageSrc: z.string().nullable(),
    audioSrc: z.string().nullable(),
    screenText: z.string(),
    durationInFrames: z.number(),
    kind: z.enum(['hook', 'stat', 'list', 'quote', 'cta']).optional(),
    stat: z.object({ value: z.number(), unit: z.string().optional(), label: z.string().optional() }).optional(),
    items: z.array(z.string()).optional(),
    quote: z.object({ text: z.string(), source: z.string().optional() }).optional(),
  })),
  totalFrames: z.number(),
});
export type AutoShortsProps = z.infer<typeof autoShortsSchema>;
export const defaultProps: AutoShortsProps = {
  scenes: [{ imageSrc: null, audioSrc: null, screenText: '샘플 자막 한 줄', durationInFrames: 90 }],
  totalFrames: 90,
};

const Scene: React.FC<{ s: AutoShortsProps['scenes'][number]; index: number }> = ({ s, index }) => (
  <AbsoluteFill>
    <KenBurnsImage src={s.imageSrc} total={s.durationInFrames} index={index} />
    {s.kind === 'stat' && s.stat ? <StatCountUp stat={s.stat} total={s.durationInFrames} /> : null}
    {s.kind === 'list' && s.items?.length ? <ListReveal items={s.items} total={s.durationInFrames} /> : null}
    {s.kind === 'quote' && s.quote ? <QuoteCard quote={s.quote} total={s.durationInFrames} /> : null}
    <KineticCaption text={s.screenText} variant={s.kind === 'hook' || s.kind === 'cta' ? s.kind : undefined} />
    {s.audioSrc ? <Audio src={staticFile(s.audioSrc)} /> : null}
  </AbsoluteFill>
);

export const AutoShorts: React.FC<AutoShortsProps> = ({ scenes }) => (
  <AbsoluteFill style={{ background: '#000', fontFamily: '"Noto Sans KR", sans-serif' }}>
    <Series>
      {scenes.map((s, i) => (
        <Series.Sequence key={i} durationInFrames={Math.max(1, s.durationInFrames)}>
          <Scene s={s} index={i} />
        </Series.Sequence>
      ))}
    </Series>
    <ProgressBar />
  </AbsoluteFill>
);
```

- [ ] **Step 2: Thread kind through propScenes**

`src/tools/shortsRenderRemotion.ts` — 기존:
```ts
    return { imageSrc, audioSrc, screenText: p.screenText, durationInFrames: p.durationInFrames };
```
을 다음으로 교체(`prepared` 는 씬을 필터링 없이 순서 보존하므로 `scenes[p.index]` 가 원본 씬):
```ts
    const sc = scenes[p.index];
    return {
      imageSrc, audioSrc, screenText: p.screenText, durationInFrames: p.durationInFrames,
      ...(sc?.kind ? { kind: sc.kind } : {}),
      ...(sc?.stat ? { stat: sc.stat } : {}),
      ...(sc?.items ? { items: sc.items } : {}),
      ...(sc?.quote ? { quote: sc.quote } : {}),
    };
```

- [ ] **Step 3: Verify types + full tests**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/tools src/orchestrator` → PASS(회귀 없음 — kind 없는 씬은 기존 경로 그대로).

- [ ] **Step 4: 실런 검증(선택 — gpt-image·TTS 과금)**

서버 실행 중이면 수치·리스트가 나올 주제로 1건:
```bash
curl -s -X POST http://127.0.0.1:8787/shorts -H 'content-type: application/json' -d '{"topic":"실내 화분 관리 실수 3가지와 물주기 주기","scenes":4}'
```
GET /shorts 폴링으로 ready 후 `data/shorts/<id>/final.mp4` 재생 — stat 씬 CountUp·list 씬 리빌·hook/cta 자막 변형 확인. writer 가 kind 를 생략하면(억지 배정 금지 규칙) 기존 렌더와 동일한 것이 정상.

- [ ] **Step 5: Commit**

```bash
git status --short   # 아래 2개 파일만 확인
git add remotion/AutoShorts.tsx src/tools/shortsRenderRemotion.ts
git commit -m "feat(shorts): AutoShorts 씬 kind 배선(zod·오버레이 조건부 렌더·propScenes)"
```

---

## 완료 기준 (스펙 §8)

- [ ] shorts_writer 가 kind·페이로드를 생성하고 정규화가 불량을 강등한다(`normalizeSceneKind` 단위테스트).
- [ ] Remotion 렌더에서 stat=CountUp, list=스태거 리빌, quote=인용 카드, hook/cta=자막 변형 동작(실런 육안 또는 회귀 무결).
- [ ] kind 없는 씬·ffmpeg 폴백·씬 QA 등 기존 경로 회귀 없음. 루트+remotion tsc 0, 기존+신규 테스트 통과.
