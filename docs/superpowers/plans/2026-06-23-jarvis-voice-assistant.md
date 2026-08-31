# 자비스 음성 비서 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자비스(secretary)와 멀티턴 음성 대화 — 잡담은 경량 `/jarvis/chat` 즉답, 업무 지시는 기존 런에 위임 후 음성 보고하며, 화면 중앙에 음성반응 JARVIS 오브 아바타를 띄운다.

**Architecture:** 신규 경량 백엔드 `src/jarvis/chat.ts`(자비스 페르소나로 ollama 단일 chat, 업무면 `delegate` JSON 방출)와 `/jarvis/chat` 엔드포인트가 코어. 프런트는 음성→STT→`/jarvis/chat`→중앙 오버레이(오브 아바타 + 대화 스레드), 위임이면 기존 `startRun` 트리거 후 synthesis 를 자비스 보고로 낭독. 음성/AnalyserNode/TTS 는 기존 voice 기능 재사용.

**Tech Stack:** TypeScript, Hono, ollama(로컬 gemma), React 18 + zustand, Web Audio AnalyserNode + canvas/CSS, vitest(node 환경).

## Global Constraints

- 대화 상대는 항상 **자비스(secretary, role id `secretary`)** 고정. 사용자가 직원 이름을 부르지 않는다.
- 대화 코어 = 신규 `POST /jarvis/chat`(+`/api/jarvis/chat`), ollama **단일 chat** 호출. 모델 = `getLlmSetting().localModel`(standard 티어). **`.micro` 사용 금지**, **`format:'json'` 설정 금지**(자유응답 깨짐) — 자유 텍스트로 응답받고 `firstJson`으로 delegate 추출.
- `firstJson`은 `src/tools/classify.ts:52`에 있으나 export 안 됨 → **classify.ts에서 `export function firstJson` 으로 노출**하고 `src/jarvis/chat.ts`가 import(복사 금지·DRY).
- 자비스 페르소나 = `getCompany()`의 secretary lead `.systemPrompt`(camelCase) + 이름 `.name`(people.yaml에서 '자비스'). 팀 id는 `secretariat`이나 lead role id는 `secretary` — lead.id로 매칭.
- 업무 위임은 기존 `startRun(task, onEvent, onRunId, getLastSeq, opts?)` 재사용(org 자동 라우팅). opts.budget→body `budget_usd`는 startRun 내부 처리.
- **이중 낭독 방지**: 기존 자동낭독 useEffect(App.tsx)는 모든 live 런의 TERMINAL에서 synthesis를 1회 읽는다. **자비스-주도 런 id는 Set에 기록해 그 effect가 skip**, 자비스 보고 턴이 낭독 전담.
- 대화형 토글 ON 시: mic 떼면 STT→`jarvis.send`(입력창 채움 대신). mic `onPointerDown`에서 `tts.prime()`로 AudioContext 언락(자동 낭독 autoplay 방지).
- 아바타: `자비스.webp`(512² JARVIS 오브)를 `frontend/src/assets/jarvis.webp`로 복사·번들. 말할 때 `tts.analyser` 진폭으로 scale·glow·회전(정밀 립싱크 아님).
- 테스트: 단일 루트 vitest, **node 환경(jsdom 없음)**. 브라우저 API(AudioContext/canvas/오버레이)는 **수동 검증**, 순수 로직만 TDD. 모킹은 `vi.spyOn(인스턴스,'메서드')`, `afterEach(() => vi.restoreAllMocks())`.
- 라우트는 `/jarvis/*`와 `/api/jarvis/*` 양쪽 등록. vite 프록시 배열에 `/jarvis` 추가.
- 미가용(LLM/음성) 시 앱은 깨지지 않는다(토스트/비활성).

---

### Task 1: 자비스 대화 코어 (`src/jarvis/chat.ts`)

**Files:**
- Create: `src/jarvis/chat.ts`, `src/jarvis/chat.test.ts`
- Modify: `src/tools/classify.ts` (`function firstJson` → `export function firstJson`)

**Interfaces:**
- Consumes: `ollama`(`../llm/ollama`), `getLlmSetting`(`../llm/setting`), `getCompany`(`../agents/company-loader`), `firstJson`(`../tools/classify`)
- Produces:
  - `interface JarvisTurn { role: 'user' | 'assistant'; content: string }`
  - `interface JarvisReply { reply: string; delegate?: { task: string } }`
  - `jarvisSystemPrompt(): string`
  - `jarvisChat(messages: JarvisTurn[], opts?: { model?: string; signal?: AbortSignal }): Promise<JarvisReply>`

- [ ] **Step 1: 실패 테스트 작성**

`src/jarvis/chat.test.ts`:
```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ollama } from '../llm/ollama';
import { jarvisChat, jarvisSystemPrompt } from './chat';

afterEach(() => vi.restoreAllMocks());

describe('jarvisChat', () => {
  it('잡담: 페르소나 system 메시지 + reply 반환(delegate 없음)', async () => {
    const spy = vi.spyOn(ollama, 'chat').mockResolvedValue({ text: '안녕하세요, 자비스예요.' } as never);
    const r = await jarvisChat([{ role: 'user', content: '자비스' }]);
    expect(r.reply).toContain('자비스');
    expect(r.delegate).toBeUndefined();
    const sys = (spy.mock.calls[0]![0] as { messages: { role: string; content: string }[] }).messages[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content.length).toBeGreaterThan(10);
  });

  it('업무지시: 끝줄 delegate JSON 을 파싱하고 reply 에서 JSON 제거', async () => {
    vi.spyOn(ollama, 'chat').mockResolvedValue({
      text: '네, 전달하겠습니다.\n{"delegate":{"task":"예산 회의 자료 준비"}}',
    } as never);
    const r = await jarvisChat([{ role: 'user', content: '예산 회의 자료 준비해줘' }]);
    expect(r.delegate?.task).toContain('예산');
    expect(r.reply).not.toContain('{');
    expect(r.reply).toContain('전달');
  });

  it('jarvisSystemPrompt 는 비어있지 않다', () => {
    expect(jarvisSystemPrompt().length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/jarvis/chat.test.ts`
Expected: FAIL — `Cannot find module './chat'`

- [ ] **Step 3a: classify.ts에서 firstJson export 노출**

`src/tools/classify.ts:52` 의 `function firstJson<T>(raw: string): T | null {` 를 `export function firstJson<T>(raw: string): T | null {` 로 변경(시그니처·본문 동일, export 만 추가). 다른 호출부 영향 없음(같은 모듈 내 호출 그대로 동작).

- [ ] **Step 3: 구현**

`src/jarvis/chat.ts`:
```typescript
/** 자비스(비서) 대화 코어 — 페르소나로 ollama 단일 chat, 업무지시면 delegate JSON 방출.
 *  format:'json' 미사용(자유응답 보존) → 자유 텍스트 후 firstJson 으로 delegate 추출. */
import { ollama } from '../llm/ollama';
import { getLlmSetting } from '../llm/setting';
import { getCompany } from '../agents/company-loader';
import { firstJson } from '../tools/classify';   // Step 3a 에서 classify.ts 가 export 노출

export interface JarvisTurn { role: 'user' | 'assistant'; content: string }
export interface JarvisReply { reply: string; delegate?: { task: string } }

export function jarvisSystemPrompt(): string {
  const co = getCompany();
  const sec = co.specialists.find((r) => r.id === 'secretary')
    ?? co.teams.find((t) => t.lead?.id === 'secretary')?.lead;
  const persona = sec?.systemPrompt ?? '당신은 (재)경상북도경제진흥원 CEO를 보좌하는 비서입니다.';
  const name = sec?.name ?? '자비스';
  return [
    persona,
    `당신의 이름은 ${name} 입니다. 사용자와 친근하고 간결하게(1~3문장) 한국어로 대화합니다.`,
    '인사·잡담·간단한 질의에는 JSON 없이 바로 답합니다.',
    '사용자 발화가 실행 가능한 업무 지시이면, 짧은 확인 응답을 한 뒤 마지막 줄에 JSON 한 줄로',
    '{"delegate":{"task":"<담당 직원들이 수행할 과제 한 문장>"}} 를 출력합니다.',
  ].join('\n');
}

function resolveModel(): string {
  // server/main.ts 의 standard 해석과 동일 취지: 설정된 로컬 모델 우선.
  const m = getLlmSetting().localModel;
  return m && m.trim() ? m : 'gemma4:12b';
}

export async function jarvisChat(
  messages: JarvisTurn[],
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<JarvisReply> {
  const model = opts.model ?? resolveModel();
  const res = await ollama.chat({
    model,
    messages: [{ role: 'system', content: jarvisSystemPrompt() }, ...messages.slice(-12)],
    maxOutputTokens: 400, temperature: 0.4, signal: opts.signal,
  });
  const raw = (res.text ?? '').trim();
  const j = firstJson<{ delegate?: { task?: string } }>(raw);
  const task = j?.delegate?.task;
  if (task && String(task).trim()) {
    const reply = raw.replace(/\{[\s\S]*\}\s*$/, '').trim() || '네, 처리하겠습니다.';
    return { reply, delegate: { task: String(task).trim() } };
  }
  return { reply: raw };
}
```

> 주의: `getLlmSetting`이 `src/llm/setting.ts`에서 export 되는지 확인(없으면 `src/server/main.ts:367-375`의 standard 모델 해석을 복제). `res.text`는 이미 trim 됨. `ollama.chat`은 전역 세마포어로 직렬화됨(정상).

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/jarvis/chat.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/jarvis/chat.ts src/jarvis/chat.test.ts src/tools/classify.ts
git commit -m "feat(jarvis): 자비스 대화 코어(페르소나 chat + delegate 파싱)"
```

---

### Task 2: `/jarvis/chat` 엔드포인트

**Files:**
- Modify: `src/server/main.ts`
- Create: `src/jarvis/endpoints.test.ts`

**Interfaces:**
- Consumes: `jarvisChat`(`../jarvis/chat`), `ollama`(가용성), `app`(Hono)
- Produces: `POST /jarvis/chat` `{messages}` → `{reply, delegate?}`

- [ ] **Step 1: main.ts import + 핸들러 + 라우트**

`src/server/main.ts` import 헤더:
```typescript
import { jarvisChat } from '../jarvis/chat';
```
라우트 등록부(다른 라우트 근처, `if (!process.env.VITEST) serve(...)` 이전):
```typescript
// --- 자비스 대화 ---
const jarvisHandler = async (c: Context): Promise<Response> => {
  const models = await ollama.listModels().catch(() => []);
  if (!models.length) return c.json({ error: 'LLM 미가용(로컬 모델 없음)' }, 503);
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>().catch(() => ({} as { messages?: { role: string; content: string }[] }));
  const messages = (body.messages ?? []).filter((m) => m && typeof m.content === 'string');
  if (!messages.length) return c.json({ error: '메시지 없음' }, 400);
  try {
    const out = await jarvisChat(messages as { role: 'user' | 'assistant'; content: string }[], { signal: c.req.raw.signal });
    return c.json(out);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};
app.post('/jarvis/chat', jarvisHandler);
app.post('/api/jarvis/chat', jarvisHandler);
```
> `ollama`는 main.ts 에 이미 import 되어 있음(없으면 `import { ollama } from '../llm/ollama'` 추가). `Context` 타입도 이미 import 됨.

- [ ] **Step 2: 실패 통합 테스트 작성 (스폰 없음 — jarvisChat 의 ollama.chat 스파이)**

`src/jarvis/endpoints.test.ts`:
```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { app } from '../server/main';
import { ollama } from '../llm/ollama';

afterEach(() => vi.restoreAllMocks());

describe('POST /jarvis/chat', () => {
  it('빈 messages → 400(LLM 가용 시)', async () => {
    vi.spyOn(ollama, 'listModels').mockResolvedValue([{ name: 'gemma4:12b', sizeGB: 8 }] as never);
    const res = await app.request('/jarvis/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('정상 → {reply} 반환', async () => {
    vi.spyOn(ollama, 'listModels').mockResolvedValue([{ name: 'gemma4:12b', sizeGB: 8 }] as never);
    vi.spyOn(ollama, 'chat').mockResolvedValue({ text: '안녕하세요, 자비스예요.' } as never);
    const res = await app.request('/jarvis/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '자비스' }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toContain('자비스');
  });
});
```
> `app` import 시 서버가 안 뜨도록 voice 기능에서 넣은 `if (!process.env.VITEST) serve(...)` 가드가 그대로 적용됨(확인).

- [ ] **Step 3~4: 실패 → 통과**

Run: `npx vitest run src/jarvis/endpoints.test.ts`
Expected: 처음 FAIL(모듈/라우트 전) → 구현 후 PASS (2 tests). `npx tsc --noEmit 2>&1 | grep -iE "main.ts|jarvis" | head` 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/server/main.ts src/jarvis/endpoints.test.ts
git commit -m "feat(jarvis): /jarvis/chat 엔드포인트"
```

---

### Task 3: voice.json `conversational` 설정 + 노출

**Files:**
- Modify: `src/voice/setting.ts` (VoiceSettings에 `conversational`)
- Modify: `src/server/main.ts` (voices 응답에 conversational + `POST /voice/settings`)
- Modify: `src/voice/endpoints.test.ts` (assertion 추가)

**Interfaces:**
- Produces: `VoiceSettings.conversational: boolean`(기본 false); `GET /voice/voices` 응답에 `conversational`; `POST /voice/settings {conversational}` → 저장.

- [ ] **Step 1: setting.ts 확장**

`src/voice/setting.ts`의 `VoiceSettings` 인터페이스에 추가:
```typescript
  conversational: boolean;
```
`defaults()` 반환 객체에 추가: `conversational: false,`
`getVoiceSettings()`의 per-field 폴백 블록에 추가:
```typescript
      conversational: typeof raw.conversational === 'boolean' ? raw.conversational : d.conversational,
```

- [ ] **Step 2: main.ts — voices 응답 확장 + settings POST**

`voicesHandler`의 `return c.json({...})`에 `conversational: getVoiceSettings().conversational,` 추가. 그리고 핸들러 추가:
```typescript
const voiceSettingsHandler = async (c: Context): Promise<Response> => {
  const body = await c.req.json<{ conversational?: boolean }>().catch(() => ({} as { conversational?: boolean }));
  const patch: Partial<{ conversational: boolean }> = {};
  if (typeof body.conversational === 'boolean') patch.conversational = body.conversational;
  const next = setVoiceSettings(patch);
  return c.json({ conversational: next.conversational });
};
app.post('/voice/settings', voiceSettingsHandler);
app.post('/api/voice/settings', voiceSettingsHandler);
```
> import 에 `setVoiceSettings` 추가(`import { getVoiceSettings, setVoiceSettings } from '../voice/setting'`).

- [ ] **Step 3: 테스트 — endpoints.test.ts 에 assertion 추가**

`src/voice/endpoints.test.ts`의 `/voice/voices` 테스트에 추가:
```typescript
    expect(typeof j.conversational).toBe('boolean');
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/voice/setting.test.ts src/voice/endpoints.test.ts`
Expected: PASS (setting 2 + endpoints 2). `tsc` 음성 관련 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/voice/setting.ts src/server/main.ts src/voice/endpoints.test.ts
git commit -m "feat(jarvis): voice.json conversational 설정 + /voice/settings"
```

---

### Task 4: 프런트 API + store + useJarvis + 순수 헬퍼

**Files:**
- Modify: `frontend/vite.config.ts` (프록시 `/jarvis`)
- Modify: `frontend/src/api.ts` (postJarvisChat, setVoiceConversational, getVoices 타입 확장)
- Modify: `frontend/src/store.ts` (jarvisTurns 슬라이스)
- Create: `frontend/src/jarvis/useJarvis.ts`, `frontend/src/jarvis/history.ts`, `frontend/src/jarvis/history.test.ts`

**Interfaces:**
- Produces:
  - `postJarvisChat(messages: {role:'user'|'assistant';content:string}[]): Promise<{reply:string; delegate?:{task:string}}>`
  - `setVoiceConversational(on: boolean): Promise<boolean>`
  - store: `jarvisTurns: {role:'user'|'jarvis'; text:string}[]`, `jarvisBusy: boolean`, `pushJarvisTurn`, `setJarvisBusy`, `clearJarvis`
  - `toApiMessages(turns: {role:'user'|'jarvis'; text:string}[], limit?: number): {role:'user'|'assistant';content:string}[]`
  - `useJarvis(tts): { send(text:string): Promise<void> }`

- [ ] **Step 1: vite 프록시에 `/jarvis` 추가**

`frontend/vite.config.ts` 경로 배열에 `"/jarvis"` 추가(기존 `"/voice"` 옆).

- [ ] **Step 2: 순수 헬퍼 실패 테스트**

`frontend/src/jarvis/history.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { toApiMessages } from './history';

describe('toApiMessages', () => {
  it('jarvis→assistant 매핑 + text→content', () => {
    const out = toApiMessages([{ role: 'user', text: '안녕' }, { role: 'jarvis', text: '안녕하세요' }]);
    expect(out).toEqual([{ role: 'user', content: '안녕' }, { role: 'assistant', content: '안녕하세요' }]);
  });
  it('최근 limit 턴만', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: String(i) }));
    expect(toApiMessages(turns, 12)).toHaveLength(12);
    expect(toApiMessages(turns, 12)[0]!.content).toBe('8');
  });
});
```

- [ ] **Step 3: 실패 확인 → history.ts 구현 → 통과**

Run: `npx vitest run frontend/src/jarvis/history.test.ts` (먼저 FAIL)
`frontend/src/jarvis/history.ts`:
```typescript
export type JarvisUiTurn = { role: 'user' | 'jarvis'; text: string };
export type ApiMessage = { role: 'user' | 'assistant'; content: string };

/** UI 턴(jarvis)을 API 형식(assistant)으로 매핑 + 최근 limit 턴만. */
export function toApiMessages(turns: JarvisUiTurn[], limit = 12): ApiMessage[] {
  return turns.slice(-limit).map((t) => ({
    role: t.role === 'jarvis' ? 'assistant' : 'user',
    content: t.text,
  }));
}
```
Run 재실행 → PASS (2 tests).

- [ ] **Step 4: api.ts 헬퍼**

`frontend/src/api.ts`에 추가(기존 voice 헬퍼 근처). `getVoices` 반환 타입에 `conversational: boolean` 추가:
```typescript
export async function postJarvisChat(
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<{ reply: string; delegate?: { task: string } }> {
  const r = await fetch('/jarvis/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `자비스 응답 실패 (${r.status})`);
  return await r.json();
}

export async function setVoiceConversational(on: boolean): Promise<boolean> {
  try {
    const r = await fetch('/voice/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversational: on }),
    });
    return r.ok ? (await r.json()).conversational ?? on : on;
  } catch { return on; }
}
```
`getVoices()` 반환 객체/타입에 `conversational` 포함(서버가 이제 반환). 기본값 객체에 `conversational: false` 추가.

- [ ] **Step 5: store 슬라이스**

`frontend/src/store.ts` — (a) `Store` 인터페이스에:
```typescript
  jarvisTurns: { role: 'user' | 'jarvis'; text: string }[];
  jarvisBusy: boolean;
  pushJarvisTurn: (t: { role: 'user' | 'jarvis'; text: string }) => void;
  setJarvisBusy: (b: boolean) => void;
  clearJarvis: () => void;
```
(b) `create<Store>` 초기값:
```typescript
  jarvisTurns: [],
  jarvisBusy: false,
```
(c) 액션(`setSpeaking` 근처):
```typescript
  pushJarvisTurn: (t) => set((s) => ({ jarvisTurns: [...s.jarvisTurns, t] })),
  setJarvisBusy: (jarvisBusy) => set(() => ({ jarvisBusy })),
  clearJarvis: () => set(() => ({ jarvisTurns: [] })),
```

- [ ] **Step 6: useJarvis 훅 (Phase 1: 잡담만 — delegate 는 Task 7에서 처리)**

`frontend/src/jarvis/useJarvis.ts`:
```typescript
import { useStore } from '../store';
import { postJarvisChat } from '../api';
import { toApiMessages } from './history';
import type { useTts } from '../voice/useTts';

/** 자비스 대화 전송. Phase 1 은 잡담 응답만 표시·낭독. (delegate 처리는 App 측 Phase 2에서 주입) */
export function useJarvis(tts: ReturnType<typeof useTts>, onDelegate?: (task: string, reply: string) => void) {
  const pushJarvisTurn = useStore((s) => s.pushJarvisTurn);
  const setJarvisBusy = useStore((s) => s.setJarvisBusy);

  async function send(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    pushJarvisTurn({ role: 'user', text: t });
    setJarvisBusy(true);
    try {
      const history = toApiMessages(useStore.getState().jarvisTurns);
      const out = await postJarvisChat(history);
      pushJarvisTurn({ role: 'jarvis', text: out.reply });
      tts.speak(out.reply, useStore.getState().jarvisTurns.length); // 보고 턴 낭독
      if (out.delegate?.task && onDelegate) onDelegate(out.delegate.task, out.reply);
    } catch (e) {
      pushJarvisTurn({ role: 'jarvis', text: `(오류) ${(e as Error).message}` });
    } finally {
      setJarvisBusy(false);
    }
  }
  return { send };
}
```
> 히스토리는 `useStore.getState().jarvisTurns`로 직전 push 반영분까지 읽어 전송(렌더 클로저 회피).

- [ ] **Step 7: 타입체크 + 커밋**

Run: `npx tsc --noEmit 2>&1 | grep -iE "jarvis|store.ts|api.ts|vite.config" | head` (에러 없음)
```bash
git add frontend/vite.config.ts frontend/src/api.ts frontend/src/store.ts frontend/src/jarvis/
git commit -m "feat(jarvis): 프런트 api/store/useJarvis + 히스토리 매핑 + vite 프록시"
```

---

### Task 5: useTts.prime() + JarvisAvatar + 에셋

**Files:**
- Modify: `frontend/src/voice/useTts.ts` (prime)
- Create: `frontend/src/assets/jarvis.webp` (`/Users/sangbumnam/Downloads/자비스.webp` 복사)
- Create: `frontend/src/jarvis/JarvisAvatar.tsx`

> 브라우저 의존 → 단위테스트 없음(수동 검증). tsc + vite build 로 확인.

- [ ] **Step 1: 에셋 복사**

```bash
cp "/Users/sangbumnam/Downloads/자비스.webp" "/Users/sangbumnam/AI_Agents_git/gepa-ai-office/frontend/src/assets/jarvis.webp"
```

- [ ] **Step 2: useTts.prime() 추가**

`frontend/src/voice/useTts.ts` — `speak` 함수 근처에 추가하고 반환 객체에 포함:
```typescript
  /** 사용자 제스처(마이크 누름) 때 AudioContext 를 생성·resume 해 이후 자동재생을 언락. */
  async function prime(): Promise<void> {
    const ctx = acRef.current ?? new AudioContext();
    acRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
  }
```
반환문을 `return { speak, stop, prime, speakingSeq, analyser };` 로 수정.

- [ ] **Step 3: JarvisAvatar 컴포넌트**

`frontend/src/jarvis/JarvisAvatar.tsx`:
```tsx
import { useEffect, useRef } from "react";
import jarvisOrb from "../assets/jarvis.webp";

/** 중앙 자비스 오브. speaking 중에는 tts.analyser 진폭으로 scale·glow·회전 가속, 유휴 시 잔잔. */
export function JarvisAvatar({ analyser, speaking }: { analyser: AnalyserNode | null; speaking: boolean }) {
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const buf = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let spin = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      let amp = 0;
      if (speaking && analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i]! - 128) / 128; sum += v * v; }
        amp = Math.sqrt(sum / buf.length); // 0~1 RMS
      }
      spin += 0.2 + amp * 2.5;                       // 회전: 유휴 느림, 말할 때 가속
      const scale = 1 + amp * 0.18;                  // 맥동
      const glow = 8 + amp * 40;                     // 발광
      el.style.transform = `rotate(${spin}deg) scale(${scale})`;
      el.style.filter = `drop-shadow(0 0 ${glow}px rgba(90,170,255,${0.5 + amp * 0.5}))`;
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, speaking]);

  return <img ref={ref} src={jarvisOrb} className="jarvis-orb" alt="자비스" />;
}
```

- [ ] **Step 4: 타입체크 + 빌드 + 커밋**

Run: `npx tsc --noEmit 2>&1 | grep -iE "useTts|JarvisAvatar|jarvis" | head` (에러 없음)
Run: `cd frontend && npx vite build 2>&1 | tail -3` (성공 — webp 에셋 번들 포함)
```bash
git add frontend/src/voice/useTts.ts frontend/src/assets/jarvis.webp frontend/src/jarvis/JarvisAvatar.tsx
git commit -m "feat(jarvis): useTts.prime + JarvisAvatar 오브(음성반응) + 에셋"
```

---

### Task 6: App 통합 Phase 1 — 토글·음성→자비스·중앙 오버레이

**Files:**
- Modify: `frontend/src/App.tsx`, `frontend/src/index.css`

> 브라우저 통합 → 수동 검증. tsc + vite build 로 확인.

- [ ] **Step 1: import + 훅 + 대화형 상태**

App.tsx 상단 import: `import { useJarvis } from "./jarvis/useJarvis";`, `import { JarvisAvatar } from "./jarvis/JarvisAvatar";`, `import { setVoiceConversational } from "./api";`(기존 api import에 합쳐도 됨).
메인 컴포넌트 본문(기존 `tts`/`recorder` 정의 근처):
```typescript
  const [convo, setConvo] = useState(false);                 // 자비스 대화형
  useEffect(() => { getVoices().then((v) => setConvo(!!(v as { conversational?: boolean }).conversational)); }, []);
  const jarvis = useJarvis(tts);                             // Phase 2 에서 onDelegate 주입
  const toggleConvo = () => { const next = !convo; setConvo(next); setVoiceConversational(next); };
```

- [ ] **Step 2: handleMicUp 대화형 분기**

기존 `handleMicUp` 을 수정:
```typescript
  const handleMicUp = async () => {
    if (!voiceAvail.stt) return;
    const blob = await recorder.stop();
    if (!blob) return;
    const text = await sttUpload(blob);
    if (!text) return;
    if (convo) await jarvis.send(text);                      // 대화형: 자비스에게 자동 전송
    else setChat((prev) => mergeTranscript(prev, text));     // 기존: 입력창 채움
  };
```

- [ ] **Step 3: 대화형 토글 버튼 (컴포저, run-opt 패턴)**

기존 토글 버튼들 옆에:
```tsx
        <button type="button"
          className={`run-opt-toggle ${convo ? "active" : ""}`}
          title="자비스 대화형 — 켜면 음성이 자비스에게 바로 전달되고 음성으로 답합니다"
          onClick={toggleConvo}>🗣️ 자비스 {convo ? "ON" : "OFF"}</button>
```

- [ ] **Step 4: 중앙 오버레이 팝업 (오브 + 대화 스레드)**

컴포넌트 return JSX 최상단(루트 컨테이너 내부)에 추가:
```tsx
      {convo && (
        <div className="jarvis-overlay">
          <button type="button" className="jarvis-close" onClick={toggleConvo} title="닫기">×</button>
          <JarvisAvatar analyser={tts.analyser} speaking={tts.speakingSeq !== null} />
          <div className="jarvis-thread">
            {s.jarvisTurns.length === 0 && <p className="muted">🎙 마이크를 누르고 자비스에게 말하세요</p>}
            {s.jarvisTurns.map((t, i) => (
              <div key={i} className={`jarvis-turn ${t.role}`}>
                <b>{t.role === "jarvis" ? "자비스" : "나"}</b> {t.text}
                {t.role === "jarvis" && <button className="voice-speak" onClick={() => tts.speak(t.text, i)}>🔊</button>}
              </div>
            ))}
            {s.jarvisBusy && <p className="muted">자비스가 생각 중…</p>}
          </div>
        </div>
      )}
```
> `s` 는 기존 `const s = useStore()`. `jarvisTurns`/`jarvisBusy` 는 store 구독이라 새 턴이 push 되면 자동 리렌더된다.

- [ ] **Step 5: 마이크 pointerDown 에서 prime**

기존 마이크 버튼 `onPointerDown` 에 `tts.prime()` 추가:
```tsx
        onPointerDown={(e) => { e.preventDefault(); tts.stop(); tts.prime(); recorder.start(); }}
```

- [ ] **Step 6: index.css — 오버레이/오브/턴 스타일**

`frontend/src/index.css` 끝에:
```css
/* 자비스 대화 오버레이 */
.jarvis-overlay { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 16px; background: rgba(4, 10, 22, 0.72); backdrop-filter: blur(4px); }
.jarvis-orb { width: min(42vmin, 360px); height: auto; will-change: transform, filter; }
.jarvis-close { position: absolute; top: 18px; right: 22px; font-size: 28px; background: none; border: none; color: #cfe3ff; cursor: pointer; }
.jarvis-thread { width: min(92vw, 560px); max-height: 32vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.jarvis-turn { padding: 6px 10px; border-radius: 10px; background: rgba(255,255,255,0.06); color: #e8f1ff; }
.jarvis-turn.user { align-self: flex-end; background: rgba(90,140,255,0.18); }
```

- [ ] **Step 7: 타입체크 + 빌드 + 커밋**

Run: `npx tsc --noEmit 2>&1 | grep -iE "App.tsx|jarvis" | head` (에러 없음)
Run: `cd frontend && npx vite build 2>&1 | tail -3` (성공)
```bash
git add frontend/src/App.tsx frontend/src/index.css
git commit -m "feat(jarvis): App 통합 Phase1 — 대화형 토글·음성→자비스·중앙 오버레이"
```

---

### Task 7: App 통합 Phase 2 — 업무 위임 + 이중낭독 방지

**Files:**
- Modify: `frontend/src/App.tsx`

> 브라우저 통합 + 런 연동 → 수동 검증. tsc + build 로 확인.

- [ ] **Step 1: 자비스-주도 런 id 추적 + 자동낭독 skip 가드**

App.tsx 에 ref 추가(메인 컴포넌트 본문):
```typescript
  const jarvisRunIds = useRef<Set<string>>(new Set());
```
기존 자동낭독 useEffect(현재 `tts.speak(text, -1)` 직전)에 skip 가드 추가:
```typescript
    if (autoReadRef.current === key) return;
    if (jarvisRunIds.current.has(key)) { autoReadRef.current = key; return; } // 자비스 런은 자비스가 낭독 전담
    const text = (s.synthesis ?? '').trim();
```

- [ ] **Step 2: jarvis.send 에 위임 핸들러 주입**

Task 6 의 `const jarvis = useJarvis(tts);` 를 onDelegate 주입형으로 교체:
```typescript
  const jarvis = useJarvis(tts, async (task /*, reply */) => {
    handleRef.current?.cancel();                              // 진행 중 런 취소(기존 directed 분기와 동일)
    reset(task);
    try {
      handleRef.current = await startRun(
        task, (ev) => apply(ev), (rid) => { jarvisRunIds.current.add(String(rid)); setRunId(rid); },
        () => useStore.getState().lastSeq, { llm: runLlmOpt() },
      );
    } catch (e) { useStore.getState().pushJarvisTurn({ role: 'jarvis', text: `(위임 실패) ${(e as Error).message}` }); }
  });
```
> `handleRef`/`reset`/`apply`/`setRunId`/`runLlmOpt` 는 기존 sendChat 에서 쓰는 것과 동일(같은 스코프). `startRun` import 확인.

- [ ] **Step 3: 위임 런 종료 시 자비스 보고 턴 + 낭독**

자동낭독 useEffect 와 별도로, 자비스 런 종료를 감지해 보고하는 useEffect 추가:
```typescript
  const jarvisReportRef = useRef<string | null>(null);
  useEffect(() => {
    if (s.mode !== 'live' || !TERMINAL.has(s.status)) return;
    const key = String(s.runId);
    if (!jarvisRunIds.current.has(key)) return;               // 자비스 런만
    if (jarvisReportRef.current === key) return;              // 1회
    const text = (s.synthesis ?? '').trim();
    if (!text) return;
    jarvisReportRef.current = key;
    useStore.getState().pushJarvisTurn({ role: 'jarvis', text });
    tts.speak(text, useStore.getState().jarvisTurns.length);  // 보고 낭독(기존 자동낭독은 skip됨)
  }, [s.status, s.runId, s.mode, s.synthesis]);
```

- [ ] **Step 4: 타입체크 + 빌드 + 커밋**

Run: `npx tsc --noEmit 2>&1 | grep -iE "App.tsx|jarvis" | head` (에러 없음)
Run: `cd frontend && npx vite build 2>&1 | tail -3` (성공)
```bash
git add frontend/src/App.tsx
git commit -m "feat(jarvis): App 통합 Phase2 — 업무 위임·보고 + 이중낭독 방지"
```

---

### Task 8: 자비스 페르소나 + 셋업/검증

**Files:**
- Modify: `data/company.yaml` (secretary system_prompt 보강)
- Modify: `README.md`

- [ ] **Step 1: company.yaml 자비스 페르소나 보강**

`data/company.yaml`의 secretariat lead(`id: secretary`) `system_prompt` 끝에 추가(기존 내용 유지):
```
사용자와 친근하고 간결하게 대화하며, 인사·잡담·간단한 질의에는 바로 답한다. 실행 가능한 업무 지시를 받으면 적합한 직원에게 위임하고 결과를 취합해 보고한다.
```
> reload: 서버가 캐시하므로 변경 후 서버 재시작 또는 `PATCH /company/roles/secretary` 로 무해 갱신 시 반영(설명만, 강제 아님).

- [ ] **Step 2: README 셋업 노트**

`README.md`의 음성 섹션에 추가:
```markdown
### 자비스 대화형
좌하단 "🗣️ 자비스" 토글을 켜면 마이크로 자비스(비서)와 대화한다. 인사·간단 질의는 즉답하고,
업무 지시는 office에 위임해 결과를 음성으로 보고한다. 화면 중앙에 음성반응 오브가 뜬다.
```

- [ ] **Step 3: 전체 검증**

Run: `npx vitest run src/jarvis src/voice frontend/src/jarvis 2>&1 | tail -8` (전부 PASS)
Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests " | tail -3` (전체 그린; 비음성 기존 실패 있으면 분리 보고)
Run: `npx tsc --noEmit 2>&1 | tail -5` (에러 없음)
Run: `cd frontend && npx vite build 2>&1 | tail -3` (성공)

- [ ] **Step 4: 수동 검증 체크리스트 (서버 재시작 + 브라우저)**

전제: mlx-whisper 설치됨, ollama 가동. 서버 재시작(voice/jarvis 코드 반영) + dist 재빌드.
- [ ] "🗣️ 자비스" 토글 ON → 화면 중앙에 오브 팝업.
- [ ] 마이크 누르고 "자비스" → "안녕하세요, 자비스예요…" 음성 응답 + 말하는 동안 오브 맥동·발광·회전.
- [ ] 멀티턴 — 직전 맥락 이어 대화.
- [ ] "다음주 예산회의 자료 준비해줘" → 자비스 확인 응답 → 위임 런(타임라인 진행) → 완료 시 자비스 보고 1회 낭독(이중낭독 없음).
- [ ] 토글 OFF/× → 오버레이 사라짐, 음성은 기존 입력창 채움 모드로.

- [ ] **Step 5: 커밋**

```bash
git add data/company.yaml README.md
git commit -m "feat(jarvis): 자비스 페르소나 보강 + 셋업 가이드"
```

---

## 구현 후 — 검증 게이트
- `npx vitest run` 전체 그린, `npx tsc --noEmit` 에러 없음, `vite build` 성공.
- 수동 체크리스트(Task 8 Step 4) 통과.
- LLM/음성 미가용 환경에서도 앱이 깨지지 않음(토글 비활성/토스트) 확인.
