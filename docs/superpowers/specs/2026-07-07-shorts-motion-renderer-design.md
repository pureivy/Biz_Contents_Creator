# 쇼츠 모션그래픽 렌더러 설계 — 정지 슬라이드쇼 → 데이터 주도 모션 (Remotion)

- 날짜: 2026-07-07
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상 코드베이스: AI_ContentsCreator (B)

## 1. 목표

B의 쇼츠 렌더러를 현재의 **정지 이미지 + Ken Burns 줌 + Pillow 구운 자막 슬라이드쇼**에서
**Remotion 기반 데이터 주도 모션그래픽**으로 업그레이드한다. gpt-image 씬 배경은 그대로 유지하고,
그 위에 실제 프레임 단위 모션(키네틱 자막·Ken Burns·씬 전환·프로그레스바, 이후 CountUp/데이터
시각화)을 얹어 역동성을 크게 높인다.

렌더 엔진은 **Remotion(무료 플랜)**을 쓴다. 원본 도구(GEPA_Workspace-main/03-shorts-generator)의
Remotion·SVG 테마를 그대로 이식하지 않는다 — 원본은 영상마다 사람이 `ShortsVideo.tsx`를 손편집하는
수동 도구, 테마는 기관 공고 전용. B는 자율·범용 주제이므로 **데이터 주도(파라미터화) 컴포지션**
하나를 만들어 LLM의 씬 JSON을 `inputProps`로 받아 렌더한다.

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| 시각 콘텐츠 모델 | gpt-image 배경 + 그 위 모션 | 범용 주제에 강함, 현재 자산 재사용, 빠른 도입 |
| 렌더러 구조 | 모션 렌더러 기본 + ffmpeg 폴백 | B의 무중단 철학, 업그레이드하되 안전망 유지 |
| 렌더 엔진 | **Remotion (무료 플랜 — 개인·3인 이하 팀 전제)** | 성숙·커스텀 코드 최소, 오디오 mux 내장. §8 라이선스 참조 |
| 진행 | Phase 1(스키마 무변경 드롭인)부터 | YAGNI, 기존 파이프라인에 즉시 얹힘 |

## 3. 현재 상태 (기준선)

- 진입점: `renderShortsVideo(dir, scenes, images, opts)` — `src/tools/shortsRender.ts`.
  - `scenes: ShortsScene[]`, `ShortsScene = { narration: string; screenText?: string }`.
  - `images: Array<string | null>` — 씬 배경(gpt-image, 없으면 null → 그라데이션 폴백).
  - 반환: `{ ok, videoPath, srtPath, durationSec, sceneCount, issues }`.
- 잡: `runShortsJob` (`src/orchestrator/shorts.ts`) — `planShorts`(shorts_writer LLM) →
  `designScenes`(shorts_director LLM) → gpt-image 생성 → `renderShortsVideo` 호출(223행 부근).
- Plan 데이터: `{ title, titles[3], scenes[{narration, screenText≤20자}], description, hashtags }`.
- 처리: 씬별 TTS(`synthesize`, OpenAI gpt-4o-mini-tts + macOS say 폴백) → ffprobe 길이 실측 →
  Pillow 프레임(`shorts_frame.py`) → ffmpeg zoompan 세그먼트 → concat. 자막은 프레임에 구움.
- 출력: 1080×1920 / 30fps / H.264+AAC.
- 프론트엔드는 이미 React 사용(`frontend/`) — Remotion(React) 도입에 언어/생태계 장벽 없음.

## 4. 설계

### 4.1 드롭인 렌더러 + 폴백

새 함수 `renderShortsVideoRemotion(dir, scenes, images, opts)`를 **`renderShortsVideo`와 동일
시그니처·반환형**으로 신설(`src/tools/shortsRenderRemotion.ts`).

`runShortsJob`의 렌더 호출을 다음으로 교체:

```
let r = null;
if (CONFIG.shortsRenderer !== 'ffmpeg') {
  try { r = await renderShortsVideoRemotion(dir, plan.scenes, images, opts); } catch { r = null; }
}
if (!r || !r.ok) {
  if (r) say('모션 렌더 실패 → ffmpeg 슬라이드쇼로 폴백');
  r = await renderShortsVideo(dir, plan.scenes, images, opts);  // 기존 경로 유지(무변경)
}
```

- `CONFIG.shortsRenderer`(ENV `SHORTS_RENDERER`, 기본 `remotion`, 값 `remotion|ffmpeg`)로 강제 선택.
- Remotion 렌더가 던지거나 `ok:false`면 조용히 ffmpeg로 폴백 — 사용자에겐 무중단.

### 4.2 공통 전처리 추출

두 렌더러가 공유하는 순수/준순수 로직을 `src/tools/shortsCommon.ts`로 추출(테스트 대상):

- 상수: `FPS=30, W=1080, H=1920, MIN_SCENE_SEC=2.8, TAIL_PAD_SEC=0.6`, `ShortsScene` 타입,
  `ShortsRenderResult` 타입(shortsRender에서 이동), `probeDuration`.
- `sceneDurationSec(audioDur)` = `max(2.8, audioDur+0.6)`, `sceneFrames(dur)` = `round(dur×30)`,
  `fmtSrtTime`, `buildSrt(scenes)`. **"오디오가 길이를 지배" 불변식**(원본 이식) — 두 렌더러 동일.
- `prepareScenes(workDir, scenes, images, opts) → PreparedScene[]`: 씬별 TTS 합성(실패 시 무음)·
  ffprobe 길이·`durationInFrames`·`startFrame` 산출. 두 렌더러 공유.

기존 `renderShortsVideo`도 이 공통 함수를 쓰도록 리팩터(동작 불변, 중복 제거).

### 4.3 Remotion 컴포지션 (데이터 주도, 1종)

- 위치: `remotion/`(레포 루트) — `index.ts`(`registerRoot`), `Root.tsx`(단일
  `<Composition id="AutoShorts" .../>`, 1080×1920/30fps), `AutoShorts.tsx`, 프리미티브 컴포넌트들.
- `inputProps` 스키마(Phase 1, zod로 검증):
  ```ts
  { scenes: { imageSrc: string|null; audioSrc: string|null; screenText: string;
              durationInFrames: number }[]; totalFrames: number }
  ```
  - LLM 스키마 **무변경** — 현재 `plan.scenes` + `images`에서 그대로 매핑.
- `AutoShorts`는 `<Series>`로 씬별 `<Series.Sequence durationInFrames={scene.durationInFrames}>`를
  배치, 각 시퀀스에 `<Audio src={scene.audioSrc}/>`(있을 때) — **오디오 mux를 Remotion이 처리**
  (별도 ffmpeg 오디오 트랙 조립 불필요).
- Composition 총길이 = `totalFrames`(`calculateMetadata`로 inputProps에서 동적 설정).
- 재사용 프리미티브(작은 파일, 각 단일 책임): `KenBurnsImage`(배경 줌·팬, null이면 씬 색 순환
  그라데이션), `KineticCaption`(screenText 단어별 스태거, 하단 25% 세이프존), `SceneFade`(시퀀스
  경계 페이드), `ProgressBar`(상단 전체 진행). 애니메이션은 Remotion `interpolate`/`spring`으로.
- 텍스트는 React가 문자열로 렌더 → 오타·자소 깨짐 원천 불가(원본 A/02 장점 계승). 로컬 Noto Sans KR
  `staticFile` 폰트 임베드.

### 4.4 Node 측 Remotion 렌더

`renderShortsVideoRemotion` 내부:
1. `prepareScenes(...)`로 씬 전처리(TTS·길이).
2. **에셋 스테이징**: 씬 이미지·TTS mp3를 per-render 임시 `public/` 디렉토리(`dir/remotion-public/`)로
   복사(예: `scene_01.jpg`, `narr_01.mp3`) → `inputProps.scenes[].imageSrc/audioSrc`는
   `staticFile('scene_01.jpg')`로 참조. (임의 절대경로 `file://` 대신 문서화된 publicDir 패턴 사용 —
   렌더러 에셋 로딩 안정성.)
3. `@remotion/bundler`의 `bundle({ entryPoint: 'remotion/index.ts', publicDir })`로 번들(최초 1회
   캐시 가능) → `@remotion/renderer`의 `selectComposition({ id:'AutoShorts', inputProps })` +
   `renderMedia({ codec:'h264', outputLocation: dir/final.mp4, inputProps, ... })`. Remotion이 자체
   headless chromium(최초 렌더 시 다운로드)으로 프레임·오디오 합성.
4. `buildSrt`로 `subtitles.srt` 기록.
5. 반환형 `{ ok, videoPath, srtPath, durationSec, sceneCount, issues }`.
- 취소: `opts.signal`로 렌더 중단(가능하면) + 잡 레벨 abort로 프로세스 정리.

## 5. Phase 2 (후속, 이 스펙 범위 밖 — 방향만 기록)

- **데이터 시각화**: `shorts_writer` 스키마 확장 — 씬 `kind`(hook/stat/list/quote/cta) +
  stat 숫자·단위, list 항목. Remotion에 타입별 레이아웃(CountUp 수치, 리스트 리빌, 인용 카드) 추가.
- **렌더 전 비전 QA**: Remotion `renderStill()`로 씬 스틸 1장 → Claude 비전이 자막 세이프존 침범·
  구도·가독성 점검 → 불량 **씬 이미지만** 1회 재생성(카드뉴스 QA 기계 재사용, `visionCapable()` 게이트).
- Phase 2는 별도 스펙·플랜으로 진행.

## 6. 에러 처리

- Remotion 번들/렌더 실패(모듈 부재, chromium 부재, 타임아웃, 예외) → `ok:false`/throw →
  §4.1 폴백으로 ffmpeg 슬라이드쇼가 항상 완성.
- 개별 씬 TTS 실패 → 무음 씬 진행(현행 유지). 이미지 null → 그라데이션 폴백(현행 유지).
- 취소(signal) → 두 경로 모두 즉시 중단.

## 7. 테스트

- 단위(vitest): `shortsCommon`의 `sceneDurationSec`(클램프)·`sceneFrames`·`fmtSrtTime`·`buildSrt`
  순수 함수. `prepareScenes`는 TTS/ffprobe 주입/모킹 또는 스모크로 커버.
- 컴포지션 순수부: 애니메이션 타이밍을 순수 함수로 분리(`remotion/anim.ts`: easeOut·kenBurns 값·
  captionWordsVisible 등)해 노드 단위 테스트. React 렌더 자체는 verify-by-render.
- 스모크: 소수 씬 고정 inputProps로 `renderMedia` 1회(로컬, opt-in) — mp4 산출·길이·해상도 검증.
- 폴백: `SHORTS_RENDERER=ffmpeg` 및 Remotion 강제 실패 주입으로 폴백 경로가 완성물을 내는지.
- 기존 쇼츠 테스트 회귀 없음(공통 추출 후 `renderShortsVideo` 동작 불변).

## 8. 의존성 · 리스크

- **Remotion 라이선스(핵심)**: MIT 아님. 개인·3인 이하 팀 무료(사용자 선택: 무료 플랜 — 이 조건에
  해당한다는 전제로 진행). 4인 이상 영리 기업은 유료 Company License. 조건 변동 시 §9 대안으로 엔진 교체.
- npm 의존성 추가: `remotion`, `@remotion/bundler`, `@remotion/renderer`, `react`, `react-dom`
  (+ `@remotion/cli` dev, `zod`). 서버(Node)에 React 도입. `@remotion/renderer`가 자체 headless
  chromium(~150MB)을 최초 렌더 시 다운로드.
- 렌더가 ffmpeg 슬라이드쇼보다 느리고 무거움 → 폴백이 그래서 필수. 잡 타임아웃 재검토.
- 에셋 로딩: per-render publicDir 스테이징(§4.4-2)로 `staticFile` 안정 참조(임의 file:// 회피).

## 9. 대안 (라이선스/성능 조건 변동 시)

동일 아키텍처(데이터 주도 컴포지션 + 드롭인 + 폴백) 유지, 렌더 엔진만 교체:
- 헤드리스 브라우저 프레임 캡처(기존 Python Playwright + ffmpeg) — 라이선스-프리, 커스텀 코드 많음.
- Pillow 프레임(기존 스택) — 최경량, 표현력 낮음.

## 10. 완료 기준 (Phase 1)

- `SHORTS_RENDERER=remotion`(기본)에서 주제 1개로 쇼츠 생성 시 Remotion이 1080×1920 mp4를
  키네틱 자막·Ken Burns·전환·오디오와 함께 산출.
- Remotion 실패를 주입하면 ffmpeg 슬라이드쇼로 폴백해 완성물 산출(무중단).
- 기존 쇼츠 파이프라인·테스트 회귀 없음. tsc·빌드 통과.
