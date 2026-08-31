# 자비스 음성 비서 (Jarvis voice assistant) — 설계 스펙

- 작성일: 2026-06-23
- 브랜치: feat/voice-io (음성 입출력 기능 위에 얹는 연속 작업)
- 선행: `docs/superpowers/specs/2026-06-23-voice-io-design.md` (STT/TTS/음파 — 구현 완료)
- 상태: 설계 승인됨 → 구현 계획 대기

## 1. 목적 / 배경

음성 입출력(STT/TTS)은 구현됐다. 그 위에, 사용자가 **자비스(비서 = secretary)와 자연스럽게 대화**하는 음성 비서를 만든다. 자비스는:

- **잡담·인사·간단 질의**에 즉시 대화로 응답한다 (예: "자비스" → "안녕하세요, 자비스예요. 무엇을 도와드릴까요?").
- **업무 지시**를 받으면 office(다른 직원/팀)에 위임하고, 결과를 취합해 보고한다 (chief-of-staff).

핵심 통찰: 잡담에까지 무거운 오케스트레이션 런(synthesis까지)을 돌리면 느리고 어색하다. 그래서 **가벼운 대화 턴**이 코어이고, **업무 지시일 때만** 기존 런 시스템에 위임한다.

## 2. 성공 기준

1. 대화형 토글 ON에서 "자비스"라고 말하면, 자비스가 음성으로 인사/응대한다 (풀 런 없이 빠르게).
2. 멀티턴 — 자비스가 직전 대화 맥락을 기억하고 이어간다.
3. 업무 지시("다음주 예산회의 자료 준비해줘")를 하면, 자비스가 짧게 확인 응답 후 office에 위임하고, 완료 시 결과를 음성으로 보고한다.
4. 입력은 음성(STT) + 출력은 음성(TTS), 자동재생이 브라우저 정책에 막히지 않는다.
5. 음성 도구·LLM 미가용 시 앱은 깨지지 않는다(토스트/비활성).
6. 대화 시작 시 화면 중앙에 **자비스 JARVIS 오브 아바타**가 팝업으로 뜨고, 자비스가 말하는 동안 음성 진폭에 맞춰 맥동·발광·회전한다(유휴 시 잔잔한 애니메이션). 닫거나 대화형 OFF 시 사라진다.

## 3. 결정 사항 (브레인스토밍 합의)

| 항목 | 결정 |
|---|---|
| 대화 상대 | 항상 **자비스(secretary)** 고정 — 사용자가 직원 이름을 부를 필요 없음 |
| 모드 | 컴포저 **"자비스 대화형" 토글**(voice.json `conversational`, 기본 OFF). ON: 음성→자비스 자동전송 |
| 대화 코어 | 신규 경량 엔드포인트 `POST /jarvis/chat`(자비스 페르소나 + 히스토리, ollama 단일 호출) |
| 업무 위임 | 자비스가 업무로 판단 시 구조화 `delegate` 신호 → 기존 `startRun(task)` 트리거 → synthesis 보고 |
| 자비스 동작 | chief-of-staff: 적합 직원/팀에 위임(org 자동 라우팅) → 취합 → 보고 |
| 답변 음성 | 자비스 턴/보고를 TTS 낭독 + 마이크 제스처에서 `prime()`로 autoplay 언락 |
| UI | **중앙 오버레이 팝업** — 자비스 JARVIS 오브 아바타(화면 중앙) + 대화 스레드. 위임 런은 기존 타임라인에 표시 |
| 아바타 | `자비스.webp`(512² JARVIS HUD 오브) 중앙 표시. 말할 때 `tts.analyser`(AnalyserNode)로 **맥동·발광·회전** 반응, 유휴 시 잔잔한 회전·펄스 |
| STT 이름 바이어스 | 불필요(이름 안 부름) — 구현 안 함 |

## 4. 아키텍처

```
음성 → STT(/voice/stt) → jarvis.send(text)
   → POST /jarvis/chat { messages: 최근 N턴 + 새 user }
        자비스 시스템프롬프트(비서 페르소나) + 히스토리 → ollama.chat → 모델 출력
        → 파싱: { reply, delegate?: { task } }
   ├─ delegate 없음(잡담/간단) → reply 표시 + 음성
   └─ delegate 있음(업무)      → reply(ack) 표시 + 음성
                                → startRun(task)  [기존 오케스트레이션: org 자동 라우팅]
                                → 런 종료(s.synthesis) → 자비스 보고 턴 표시 + 음성
```

- 대화 코어와 위임은 분리된 관심사: `/jarvis/chat`은 빠른 단일 LLM 턴, 위임은 기존 런 시스템.
- 멀티턴 히스토리는 프런트가 보관하고 매 호출에 최근 N턴(예: 12)을 보낸다.

## 5. Phase 1 — 대화 코어

### 5.1 백엔드 `src/jarvis/chat.ts`
- `export interface JarvisTurn { role: 'user' | 'assistant'; content: string }`
- `export interface JarvisReply { reply: string; delegate?: { task: string } }`
- `export async function jarvisChat(messages: JarvisTurn[], opts?: { model?: string; signal?: AbortSignal }): Promise<JarvisReply>`
  - 시스템프롬프트: company.yaml 의 secretary 페르소나 기반 + 대화 지침(친근·간결 한국어, 1~3문장). Phase 1 에서는 delegate 미사용(항상 잡담 응답).
  - `ollama.chat({ model, messages: [system, ...최근N], maxOutputTokens: 300, temperature: 0.4, signal })` → `{ reply: res.text.trim() }`.
  - 모델: 미지정 시 설정된 로컬 모델(`data/llm.json` localModel, 기존 헬퍼 재사용).
- `export function jarvisSystemPrompt(): string` — secretary 역할/페르소나에서 구성(getCompany 의 secretary lead 정보 활용). 분리 export 로 단위테스트 가능.

### 5.2 엔드포인트 (`src/server/main.ts`)
- `POST /jarvis/chat` 및 `/api/jarvis/chat` — body `{ messages: JarvisTurn[] }` → `jarvisChat` → `c.json(reply)`. ollama 미가용 시 503. 빈 messages 400. 에러 500.

### 5.3 프런트 `frontend/src/jarvis/useJarvis.ts`
- store 슬라이스: `jarvisTurns: { role: 'user' | 'jarvis'; text: string }[]`, `jarvisBusy: boolean`, 액션 `pushJarvisTurn`, `setJarvisBusy`, `clearJarvis`.
- `useJarvis()`: `{ send(text: string): Promise<void>; turns; busy }`.
  - `send`: user 턴 push → `postJarvisChat(historyMessages)` → jarvis 턴 push → `tts.speak(reply, <turn-seq>)`.
  - 히스토리: 최근 12턴을 백엔드 형식으로 매핑해 전송 — 프런트 턴 `{role:'jarvis'|'user', text}` → API `{role:'assistant'|'user', content}` (jarvis→assistant). 보고 턴(위임 결과)도 `assistant` 로 보낸다.
- `frontend/src/api.ts`: `postJarvisChat(messages): Promise<{reply:string; delegate?:{task:string}}>` (실패 시 throw/안전 처리).

### 5.4 App 연결 (Phase 1)
- 컴포저에 **"자비스 대화형" 토글**(voice.json `conversational`). ON 이면:
  - `handleMicUp`: STT → 전사 비어있지 않으면 `jarvis.send(전사)` (입력창 채움 대신). OFF 면 기존 채움+검토.
  - 마이크 `onPointerDown`: `tts.prime()` (autoplay 언락).
- 자비스 대화는 **중앙 오버레이 팝업**(§5.6)에 렌더 — 오브 아바타 + 대화 스레드(user/jarvis 턴, 턴별 🔊 + 자동 음성).

### 5.6 자비스 아바타 오버레이 `frontend/src/jarvis/JarvisAvatar.tsx`
- 에셋: `자비스.webp` 를 `frontend/src/assets/jarvis.webp` 로 복사(Vite 번들). 컴포넌트가 import.
- `<JarvisAvatar analyser={tts.analyser} speaking={tts.speakingSeq !== null} />`:
  - 중앙 큰 오브(이미지). `requestAnimationFrame` 으로 `analyser.getByteTimeDomainData` 의 RMS 진폭을 읽어 CSS 변수로 **scale·glow(drop-shadow)·ring 회전속도**를 진폭에 비례 적용(Waveform 패턴 재사용). `speaking=false`면 유휴 애니메이션(느린 회전 + 약한 펄스)으로 폴백, rAF 정리.
- **오버레이 컨테이너**: 대화형 ON & 대화 세션 활성일 때 화면 중앙에 팝업(반투명 backdrop, 닫기 X). 닫거나 대화형 OFF 시 사라짐. 아바타 아래/옆에 대화 스레드. 위임이 일어나면 그 런은 뒤의 기존 타임라인에서 진행(오버레이는 자비스 보고를 받아 턴으로 표시·낭독).

### 5.5 데이터 (`data/company.yaml`)
- secretary(자비스) 페르소나에 대화 지침 보강: "사용자와 친근하고 간결하게 대화한다. 인사·잡담·간단한 질의에는 1~3문장으로 바로 답한다."

## 6. Phase 2 — 업무 위임

### 6.1 자비스의 분류 + delegate 신호
- `jarvisSystemPrompt`에 위임 지침 추가: "사용자 발화가 **실행 가능한 업무 지시**이면, 짧은 확인 응답과 함께 JSON 으로 `{\"reply\":\"...\", \"delegate\":{\"task\":\"<직원들이 수행할 과제 한 문장>\"}}` 형식으로 출력한다. 잡담/간단 질의이면 `delegate` 없이 `{\"reply\":\"...\"}` 만."
- `jarvisChat`: 모델 출력에서 기존 `firstJson` 패턴(classify.ts 참고)으로 `{reply, delegate}` 추출. JSON 실패 시 전체를 `reply` 로 폴백(잡담 취급).

### 6.2 위임 실행 (프런트)
- `useJarvis.send`가 `delegate` 수신 시:
  1. jarvis ack 턴 push + 음성("네, ○○에 전달하겠습니다").
  2. 기존 `startRun(delegate.task, ...)` 로 런 시작(org 자동 라우팅 — 적합 팀/직원).
  3. 런이 `TERMINAL` 도달 + `s.synthesis` 채워지면, **자비스 보고 턴** push("정리된 결과입니다: " + 요약) + 음성 낭독.
- **이중 낭독 방지(명시):** voice-io 의 기존 자동낭독은 `running→TERMINAL` 에서 `s.synthesis` 를 1회 읽는다. 자비스 위임 보고도 같은 synthesis 를 읽으므로 충돌한다. 해결 — **위임이 자비스에서 시작됐고 대화형 ON 이면, voice-io 자동낭독을 건너뛰고(예: 자비스-주도 런 id 를 기록해 자동낭독 effect 가 skip) 자비스 보고 턴이 낭독을 전담**한다. 자비스 발(發)이 아닌 일반 런/타이핑 런에는 기존 자동낭독이 그대로 동작.

### 6.3 엣지
- 위임 런 실패/빈 synthesis → 자비스가 "완료하지 못했어요, 다시 말씀해 주세요" 보고.
- 위임 중 사용자가 또 말하면: 진행 중 런에 지시 주입(기존 sendMessage) 또는 큐잉 — 본 스펙은 **새 발화는 진행 런 종료 후 처리**(단순). 진행 중 표시.

## 7. 데이터 플로우 요약

- 잡담: 음성→STT→/jarvis/chat→{reply}→턴 표시+음성.
- 업무: 음성→STT→/jarvis/chat→{reply,delegate}→ack 턴+음성→startRun(task)→synthesis→보고 턴+음성.

## 8. 에러 처리 / 엣지

- STT 빈 결과 → 무시. `/jarvis/chat` 실패(503/500) → 토스트, 턴 미추가.
- TTS autoplay → 마이크 제스처 `prime()`. 재생 중 새 발화 → 이전 재생 중지(기존 useTts).
- LLM 미가용 → 대화형 토글 비활성 + 안내.
- 멀티턴 히스토리 상한(최근 12턴) — 컨텍스트·비용 보호.

## 9. 테스트

- 백엔드(vitest, node): `jarvisChat` — `vi.spyOn(ollama,'chat')` 로 (a)페르소나 system 메시지 적용, (b)Phase2 delegate JSON 파싱(정상/JSON아님 폴백) 검증. `jarvisSystemPrompt` 순수 구성 테스트.
- 프런트(vitest, node): 순수 분리분 — 히스토리 매핑(최근 N턴), delegate 분기 판정 헬퍼. (`useJarvis`/TTS/토글 배선은 브라우저 의존 → 수동.)
- 수동: 토글 ON → 중앙 오버레이에 오브 아바타 팝업 → "자비스" 인사 응답(음성) + 말하는 동안 오브 반응 애니메이션 · 멀티턴 · "○○ 준비해줘" → ack→위임→보고(음성) · 닫기/토글 OFF 시 오버레이 사라짐. (아바타/오버레이/애니메이션은 브라우저 의존 → 수동 검증)

## 10. 범위 밖 (YAGNI)

- 웨이크워드 상시청취, 음성 인터럽트(말 중간 끊기), 위임 큐/동시 다발 런, 대화 영속(서버 저장), 다국어, 립싱크(입모양) 정밀 동기화. 이번 범위 아님.
- (중앙 오버레이 팝업 + 오브 음성반응 애니메이션은 **범위 안** — §5.6. 단 정밀 립싱크가 아니라 진폭 기반 맥동·발광·회전.)

## 11. 신규/변경 파일

- 신규(백): `src/jarvis/chat.ts`(+테스트), `src/server/main.ts` 에 `/jarvis/chat`·`/api/jarvis/chat`.
- 신규(프런트): `frontend/src/jarvis/useJarvis.ts`(+순수헬퍼 테스트), `frontend/src/jarvis/JarvisAvatar.tsx`(오브 아바타 + 음성반응 애니메이션), 에셋 `frontend/src/assets/jarvis.webp`(`자비스.webp` 복사).
- 변경(프런트): `frontend/src/store.ts`(jarvisTurns 슬라이스), `frontend/src/api.ts`(postJarvisChat), `frontend/src/App.tsx`(대화형 토글·음성→자비스·**중앙 오버레이 팝업** 렌더·위임 핸들·prime), `frontend/src/voice/useTts.ts`(prime), `frontend/src/index.css`(오버레이·아바타 스타일).
- 변경(데이터): `data/company.yaml`(자비스 페르소나: 대화+위임 지침).
