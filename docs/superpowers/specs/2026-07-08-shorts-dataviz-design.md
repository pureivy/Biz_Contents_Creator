# 쇼츠 데이터 시각화 씬 설계 (Phase 2b)

- 날짜: 2026-07-08
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 쇼츠 파이프라인

## 1. 목표

쇼츠 씬에 `kind`(hook/stat/list/quote/cta)를 도입하고, Remotion에 타입별 모션 오버레이
3종(CountUp 수치·리스트 리빌·인용 카드)을 추가해 정보 전달력을 높인다. 모션 렌더러
스펙(2026-07-07 §5)의 Phase 2 방향을 구현한다. Phase 2의 둘째 하위기능(첫째 = 씬 배경
비전 QA, 완료).

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| 범위 | kind 5종 + 오버레이 3종(stat/list/quote), hook·cta는 기존 자막 강조 변형만 | 스펙 §5 방향 그대로 한 사이클 완결 |
| 수치 신뢰성 | 프롬프트 규칙 + 정규화 강등 | 블로그 파생=원문 수치만, 자유 주제=단계·개수 등 구조적 숫자만, 불확실하면 stat 금지. 검증 시스템(근거 필드)은 YAGNI |
| 아키텍처 | 오버레이 방식 — 기존 Scene(KenBurns+자막+오디오) 유지, kind별 오버레이만 조건부 추가 | 최소 침습, 기존 파이프라인(이미지 생성·씬 QA)과 완전 호환 |
| 하위 호환 | `kind` 없는 씬 = 현행 렌더 그대로 | 구 draft·강등 씬 안전 |

## 3. 현재 상태 (기준선)

- 씬 타입: `ShortsScene { narration: string; screenText?: string }`
  (`src/tools/shortsCommon.ts:24`) — 오케스트레이터·양 렌더러 공유.
- 기획: `planShorts`(`src/orchestrator/shorts.ts:84-113`) — shorts_writer LLM이
  `{"scenes":[{"narration","screenText"}]}` 생성(94행 스키마), 정규화(100-104행: 8씬 캡,
  narration 위생 120자, screenText 20자).
- Remotion 배선: `renderShortsVideoRemotion`(`src/tools/shortsRenderRemotion.ts`) —
  `propScenes = { imageSrc, audioSrc, screenText, durationInFrames }`(34행) →
  `inputProps`(37행) → `AutoShorts` 컴포지션.
- 컴포지션: `remotion/AutoShorts.tsx` — zod 스키마(8-16행), 씬 = KenBurnsImage +
  KineticCaption + Audio(23-29행), 전역 ProgressBar. 애니메이션 순수 헬퍼는
  `remotion/anim.ts`(kenBurnsScale·captionWordsVisible 등, vitest 테스트 있음).
- ffmpeg 폴백: `shortsRender.ts` — screenText 만 drawtext(80행). kind 개념 없음.
- 씬 QA(Phase 2a): 배경 이미지만 검수 — 씬 kind 와 무관.

## 4. 설계

### 4.1 스키마 확장 — shorts_writer

`planShorts`의 JSON 스키마·프롬프트를 확장한다:

```
scenes: [{
  narration, screenText,
  kind?: "hook"|"stat"|"list"|"quote"|"cta",
  stat?:  { value: 숫자, unit?: "%"·"만원" 등, label?: 15자 },
  items?: string[]   // list 전용, 2~4개, 각 18자
  quote?: { text: 40자, source?: 15자 }
}]
```

프롬프트 규칙:
- 씬1=hook, 마지막 씬=cta (kind 명시). 본문 씬 중 **어울리는 곳에만** stat/list/quote 배정
  — 억지 배정 금지, 없으면 kind 생략(기본 렌더).
- **수치 규칙**: 블로그 초안 파생이면 원문에 있는 수치만 stat 허용. 자유 주제면 단계 수·
  개수 등 대본 구조에서 자명한 숫자만 허용. 불확실하면 stat 을 쓰지 않는다.
- stat 씬의 narration 은 수치를 한글로 낭독(기존 규칙 유지) — 화면 숫자는 stat.value 로
  아라비아 숫자 표기.

### 4.2 정규화·강등 (fail-open)

`planShorts` 정규화에 순수 함수 `normalizeSceneKind(raw)` 추가 — 검증 실패 시 **kind 를
버리고 기본 씬으로 강등**(잡 무중단):

- `stat`: `Number(String(value).replace(/,/g,''))` 파싱 — 유한수 아니면 강등.
  unit 6자·label 15자 캡.
- `list`: items 문자열 배열 정리(트림·빈 항목 제거·각 18자 캡) — 2개 미만이면 강등,
  4개 초과는 절삭.
- `quote`: text 트림·40자 캡 — 비면 강등. source 15자 캡.
- `hook`/`cta`: 페이로드 없음 — 그대로 통과.
- 그 외 kind 값: 강등(무시).

`ShortsScene`(shortsCommon.ts)에 동일 optional 필드 추가 — 양 렌더러 공유 타입 하나만
확장, ffmpeg 렌더러는 새 필드를 읽지 않으므로 무변경.

### 4.3 Remotion 오버레이 3종 + 자막 변형

`AutoShorts.tsx` zod 스키마에 kind·페이로드 optional 통과, `Scene`에 조건부 오버레이:

- `StatCountUp.tsx`: spring 카운트업(0→value)으로 큰 수치+단위, 아래 label. 화면 세로
  중앙대(약 30~55%) 반투명 라운드 패널 — 하단 25% 자막 세이프존·상단 프로그레스바 회피.
- `ListReveal.tsx`: 항목별 스태거 리빌(fade+slide-up). 타이밍은 씬 길이에 비례 분배
  (진입 후 15프레임부터 씬의 60% 구간 안에 모든 항목 등장).
- `QuoteCard.tsx`: 큰 따옴표 장식 + 본문 페이드인 카드, source 는 아래 작은 글씨.
- `KineticCaption`에 `variant?: 'hook'|'cta'` — hook: 자막 확대·액센트 컬러, cta: 구독
  유도 배지 스타일. 레이아웃 신설 없음. screenText 가 비면 현행처럼 자막 자체가 없으므로
  변형도 미적용(무동작).
- 카운트업 값·스태거 타이밍 계산은 `anim.ts`에 순수 함수로 추가
  (`countUpValue(local, total, value)`, `listItemOpacity(local, total, index, count)` 등)
  — 기존 anim 테스트 패턴으로 vitest.

### 4.4 배선·폴백

- `shortsRenderRemotion.ts` propScenes 에 kind·stat·items·quote 통과(34행 확장).
- ffmpeg 폴백: 무변경 — kind 무시, 현행 자막만(우아한 열화). 내레이션이 내용을 낭독하므로
  정보 손실 없음.
- 구 draft(kind 없음)·강등 씬: 기존 렌더와 동일. 디자이너·씬 QA·SRT 무영향.

## 5. 에러 처리

- 정규화 강등이 1차 방어 — 렌더 단계에 불량 페이로드가 도달하지 않는다.
- zod 스키마는 optional 필드라 구 호출부와 호환. 만일 스키마 불일치로 Remotion 렌더가
  실패하면 기존 ffmpeg 폴백이 동작(§4.4, 현행 유지).

## 6. 테스트

- 단위(vitest): `normalizeSceneKind`(파싱·캡·강등 전 케이스), anim 신규 순수 함수
  (카운트업 경계·스태거 단조성).
- 렌더 육안 확인: 실런 1건(선택 — gpt-image·TTS 과금)에서 stat/list/quote 씬 모션 확인.
- 회귀: kind 없는 기존 draft 렌더 불변(스키마 optional), ffmpeg 폴백 불변.

## 7. 의존성

- 새 npm 의존성 없음(remotion·zod 기존 사용).
- shorts_writer 프롬프트 확장은 기존 microJSON 경로 그대로.

## 8. 완료 기준

- shorts_writer 가 kind·페이로드를 생성하고, 정규화가 불량을 강등한다(단위테스트).
- Remotion 렌더에서 stat=CountUp, list=스태거 리빌, quote=인용 카드, hook/cta=자막 변형이
  동작한다(실런 육안 또는 스틸 확인).
- kind 없는 씬·ffmpeg 폴백·씬 QA 등 기존 경로 회귀 없음. tsc 0, 기존+신규 테스트 통과.
