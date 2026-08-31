# 음성 입출력 + 음파 비주얼 — 설계 스펙

- 작성일: 2026-06-23
- 대상: GEPA AI Office (서버 `src/`, 프런트 `frontend/`)
- 상태: 설계 승인됨 → 구현 계획 대기

## 1. 목적 / 배경

좌하단 통합 커맨드 바(`frontend/src/App.tsx`의 `<form className="chat-input">`)에 **음성 입력(STT)** 과 **음성 출력(TTS)** 을 추가한다. 입출력 중에는 오디오에 실시간 반응하는 **음파(waveform) 비주얼**을 타임라인에 표시한다.

이 앱은 로컬 우선(Ollama 로컬 모델, 공공기관 데이터)이므로 음성 처리도 **전부 로컬**로 수행한다. 외부 클라우드 전송 없음.

## 2. 성공 기준

1. 커맨드 바의 🎤 버튼을 **누르고 있는 동안** 한국어 발화가 녹음되고, 떼면 STT 결과가 **입력창(textarea)에 채워진다**(자동 전송 아님 — 검토 후 Enter).
2. 런 종료 시 **최종 결과(종합/산출물)가 자동 낭독**된다. 또한 각 메시지 카드의 **🔊 버튼**으로 임의 메시지를 온디맨드 낭독할 수 있다.
3. 녹음 중에는 **타임라인 하단 라이브 스트립** 음파가 마이크 입력에 반응한다. 낭독 중에는 **읽고 있는 메시지 카드**에 음파가 떠 "지금 이 메시지를 읽는 중"을 표시한다.
4. 음성 도구(mlx-whisper/say)가 없거나 실패해도 **앱 기능은 깨지지 않는다**(버튼 비활성/토스트만).

## 3. 결정 사항 (브레인스토밍 합의)

| 항목 | 결정 |
|---|---|
| STT 엔진 | **mlx-whisper** (`mlx-community/whisper-large-v3-turbo`), 한국어 `--language ko`. 로컬. |
| TTS 엔진 | **macOS `say -v Yuna`**(한국어, 기본값). 로컬. |
| 오디오 변환 | **ffmpeg**(이미 설치됨) — 녹음본→16kHz mono wav, say aiff→mp3 |
| 입력 UX | **홀드 녹음(push-to-talk)** → STT → 입력창 채움(검토 후 Enter) |
| 출력 범위 | **최종 결과 자동 낭독 + 메시지별 🔊 버튼**(온디맨드) |
| 음파 배치 | **입력 = 타임라인 하단 라이브 스트립 · 출력 = 읽는 메시지 카드 파형** |
| TTS 재생 위치 | **브라우저에서 재생**(서버 스피커 아님) — 출력 음파가 브라우저 Web Audio로 반응하려면 필수 |

## 4. 아키텍처

```
[브라우저]
  마이크 getUserMedia ──┬─ MediaRecorder → webm/opus Blob ── POST /voice/stt
                        └─ AudioContext.AnalyserNode → 하단 음파 스트립(rAF)
                                                       ▲ STT 결과 setChat()
[서버 (Hono/tsx)]
  POST /voice/stt : 임시저장 → ffmpeg(16k mono wav) → mlx_whisper --language ko → { text }
  POST /voice/tts : say -v <voice> -o aiff → ffmpeg(mp3) → audio bytes
  GET  /voice/voices : 설치된 ko_KR say 음성 목록 + 가용성 플래그

[브라우저 출력]
  🔊/자동 → POST /voice/tts {text} → Blob → <audio> 재생
                                     └─ MediaElementSource → AnalyserNode → 카드 음파(rAF)
```

핵심: STT는 **녹음→업로드→서버 전사**(2~5초 비동기), TTS는 **서버 합성→브라우저 재생**. 음파는 두 경우 모두 **브라우저 Web Audio `AnalyserNode`** 가 구동하므로 엔진과 독립적인 프런트 관심사다.

## 5. 백엔드 설계 (신규 `src/voice/`)

### 5.1 `src/voice/stt.ts`
- `export async function transcribe(inputPath: string, opts?: { model?: string; lang?: string }): Promise<string>`
- 파이프라인:
  1. `ffmpeg -i <input> -ar 16000 -ac 1 -f wav <tmp.wav>` (자식프로세스)
  2. `mlx_whisper <tmp.wav> --language ko --model <model> --output-format txt --output-dir <tmpdir>` → 산출 txt 읽기
  3. 텍스트 trim 반환. 임시파일 정리.
- 에러: ffmpeg/mlx 미설치·비정상 종료 시 throw(상위에서 503/400 매핑). 모델 미다운로드 시 첫 호출이 느릴 수 있음(로그로 안내).
- 가용성 검사 `export async function sttAvailable(): Promise<boolean>` — `mlx_whisper --help`/`python -c "import mlx_whisper"` 존재 확인(결과 캐시).

### 5.2 `src/voice/tts.ts`
- `export async function synthesize(text: string, opts?: { voice?: string }): Promise<Buffer>`
- 파이프라인: `say -v <voice|Yuna> -o <tmp.aiff> <text>` → `ffmpeg -i <tmp.aiff> -f mp3 <tmp.mp3>` → Buffer 반환. 임시파일 정리.
- 입력 텍스트 정제: 과도한 마크다운/링크/이모지 제거, 길이 상한(예 4000자) — 낭독 품질·시간 보호.
- `export async function listKoreanVoices(): Promise<string[]>` — `say -v '?'` 파싱 후 `ko_KR` 필터.
- 가용성 `export async function ttsAvailable(): Promise<boolean>` — `which say` + ffmpeg.

### 5.3 엔드포인트 (`src/server/main.ts`)
- `POST /voice/stt` — body: 오디오 바이트(Content-Type: audio/webm 등). 임시저장 → `transcribe` → `{ text }`. 미가용 503.
- `POST /voice/tts` — body JSON `{ text: string; voice?: string }` → `synthesize` → `audio/mpeg` 바이트. 미가용 503.
- `GET /voice/voices` — `{ available: boolean; voices: string[]; defaultVoice: string }`.
- 모두 실패안전: try/catch → JSON 에러 + 적절한 상태코드. 업로드 크기 상한(예 25MB).

### 5.4 설정 (`data/voice.json`, `src/config.ts`)
- 스키마: `{ enabled: boolean; ttsVoice: string; sttModel: string; autoReadFinal: boolean }`
- 기본값: `{ enabled: true, ttsVoice: "Yuna", sttModel: "mlx-community/whisper-large-v3-turbo", autoReadFinal: true }`
- 없으면 기본값으로 동작(파일 강제 아님). `CONFIG`에 로더 추가(기존 `data/llm.json` 패턴 복제).

## 6. 프런트엔드 설계 (신규 `frontend/src/voice/`)

### 6.1 `useRecorder.ts` (훅)
- 반환: `{ recording: boolean; start(): Promise<void>; stop(): Promise<Blob|null>; analyser: AnalyserNode|null; error: string|null }`
- `start`: `getUserMedia({audio:true})` → `MediaRecorder`(webm/opus) 시작 + `AudioContext`/`AnalyserNode`(스트립 구동용) 연결.
- `stop`: 녹음 종료 → Blob 반환, 스트림/컨텍스트 정리.
- 권한 거부·미지원 시 `error` 설정.

### 6.2 `useTts.ts` (훅, 전역 1개)
- 반환: `{ speak(text, msgId?): Promise<void>; stop(): void; speakingId: string|null; analyser: AnalyserNode|null }`
- `speak`: `POST /voice/tts` → Blob → `Audio` 엘리먼트 재생 + `MediaElementSource`→`AnalyserNode`. 재생 시작 시 `speakingId=msgId`, 종료/에러 시 `null`.
- 동시 1개만 재생(새 speak 호출 시 이전 중지). `store.ts`의 `speakingMsgId`와 동기화.

### 6.3 `Waveform.tsx` (컴포넌트)
- props: `{ analyser: AnalyserNode | null; variant: "strip" | "card"; active: boolean }`
- `<canvas>` + `requestAnimationFrame` 루프에서 `analyser.getByteTimeDomainData()` → 파형 라인/바 렌더. `active=false`면 정지·클리어.
- `variant`로 크기/스타일 분기(strip=가로 얇은 바, card=인라인 미니). 앱 테마색(`index.css` 변수) 사용.

### 6.4 `App.tsx` 연결 지점
- **컴포저(🎤)**: chat-input 바에 마이크 버튼. `onPointerDown`=`recorder.start()`, `onPointerUp`/`onPointerLeave`=`recorder.stop()` → Blob을 `sttUpload()` → 결과를 `setChat(prev => (prev+transcript))`(검토 후 사용자가 Enter). 녹음 중 표시.
- **하단 스트립**: 녹음 중 타임라인 맨 아래에 `<Waveform variant="strip" analyser={recorder.analyser} active={recorder.recording}/>` 렌더(트랜션트).
- **메시지 카드 🔊 + 카드 파형**: 메시지 렌더(약 `App.tsx:177` 영역)에 🔊 버튼 → `tts.speak(text, msg.id)`. `speakingMsgId===msg.id`면 카드 내 `<Waveform variant="card" analyser={tts.analyser} active/>`.
- **자동 낭독**: **최종 종합(`synthesis`) 타입 메시지**(없으면 마지막 `deliverable`)가 도착하면, `voice.autoReadFinal`이 켜져 있고 **그 메시지를 아직 낭독하지 않았을 때만**(중복 방지: `autoReadDoneId`로 1회 보장) `tts.speak(finalText, finalMsgId)`. 리플레이 모드에서는 자동 낭독하지 않는다.

### 6.5 상태/헬퍼
- `store.ts`: `speakingMsgId: string|null`, `recording: boolean` 슬라이스(읽는 카드/스트립 표시용).
- `api.ts`: `sttUpload(blob): Promise<string>`, `ttsFetch(text, voice?): Promise<Blob>`, `getVoices()`.
- `index.css`: `.voice-mic`, `.waveform-strip`, `.waveform-card`, 녹음/재생 상태 스타일.

## 7. 데이터 플로우 요약

- 입력: PointerDown→getUserMedia→(MediaRecorder + Analyser→스트립)→PointerUp→Blob→POST /voice/stt→{text}→setChat.
- 출력: speak(text,msgId)→POST /voice/tts→Blob→Audio재생(+Analyser→카드 파형)→ended→speakingId=null.

## 8. 에러 처리 / 엣지

- 마이크 권한 거부 → 토스트 안내, 🎤 비활성.
- STT/TTS 미설치(503) → 음성 UI 비활성 + "음성 도구 미설치" 안내. 앱 기능 정상.
- 빈 녹음/무음 → STT 빈 문자열이면 무시.
- 긴 텍스트 낭독 → 길이 상한·정제. 재생 중 새 speak/녹음 시작 시 이전 중지.
- 동시 녹음·재생 충돌 방지(녹음 시작 시 재생 중지).
- Safari/비-Chromium: `MediaRecorder` mime 폴백, AudioContext resume(사용자 제스처) 처리.

## 9. 테스트

- 백엔드(vitest): `stt.ts`/`tts.ts` 래퍼 — child_process 모킹으로 ffmpeg/mlx/say **인자·에러처리·텍스트 정제** 검증. `listKoreanVoices` 파싱 테스트.
- 프런트(vitest): `useRecorder`/`useTts` 상태전이(MediaRecorder/fetch/Audio 모킹). `Waveform` 마운트/언마운트 시 rAF 정리.
- 수동 검증: 홀드→한국어 발화→입력창 채움 · 최종결과 자동낭독+카드 파형 · 🔊 온디맨드 · 권한 거부/미설치 폴백.

## 10. 설치 / 셋업 (1회)

- `pip install mlx-whisper` (모델 `large-v3-turbo`는 첫 사용 시 ~1.5GB 자동 다운로드).
- `ffmpeg`, `say`는 이미 존재(검증됨).
- README에 "음성 기능 셋업" 섹션 추가.

## 11. 범위 밖 (YAGNI)

- 웨이크워드/상시 청취, 클라우드 STT/TTS, 화자분리, 다국어 자동감지, 음성 명령(인텐트) 파싱, 실시간 스트리밍 전사. 이번 범위 아님.

## 12. 신규/변경 파일

- 신규(서버): `src/voice/stt.ts`, `src/voice/tts.ts`
- 신규(프런트): `frontend/src/voice/useRecorder.ts`, `frontend/src/voice/useTts.ts`, `frontend/src/voice/Waveform.tsx`
- 변경: `src/server/main.ts`(엔드포인트 3), `src/config.ts`(voice 설정), `frontend/src/App.tsx`(🎤·스트립·🔊·자동낭독), `frontend/src/store.ts`(speaking/recording), `frontend/src/api.ts`(헬퍼), `frontend/src/index.css`(스타일), `README.md`(셋업)
