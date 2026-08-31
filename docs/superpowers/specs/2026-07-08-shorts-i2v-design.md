# 쇼츠 씬 배경 I2V 클라우드 통합 설계 (Phase 3)

- 날짜: 2026-07-08
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 쇼츠 파이프라인

## 1. 목표

씬 QA를 통과한 배경 이미지를 클라우드 GPU(fal.ai)의 I2V 모델로 **모션 클립**(mp4)으로 만들어,
Remotion 렌더에서 KenBurns 스틸 대신 실제 영상 배경을 쓴다. 클립이 없거나 실패하면 씬별로
KenBurns 폴백(fail-open) — 쇼츠는 항상 완성된다.

배경: 맥 로컬 PoC(Wan 5B GGUF, [[wan-i2v-mac-poc]])로 품질은 검증됐으나 2초 클립에 20분이
걸려 상시 파이프라인 부적합 → 클라우드 서버리스로 전환(사용자 확정).

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| 제공자 | **fal.ai** 서버리스 | 유휴 비용 0, REST만으로 통합, Wan·LTX 모두 보유 |
| 기본 모델 | **LTX-2 fast I2V** (`fal-ai/ltx-2/image-to-video/fast`) | 속도·비용 균형. 구형 `ltx-video/image-to-video`는 768×512 가로 전용이라 세로 쇼츠 불가 |
| 모델 교체 | env `SHORTS_I2V_MODEL` 한 줄 | Wan·Seedance 등 상위 모델로 즉시 전환 가능 |
| 통합 층 | **오케스트레이터 단계**(씬 QA 직후, 새 모듈) | 씬 QA·카드뉴스와 동일 패턴, 렌더러는 과금·네트워크 무지 |
| 적용 범위 | 전 씬(병렬) | 편당 ~\$1(6초×4씬, \$0.04/초)로 수용 가능, 씬당 1회·재시도 없음 캡 |

## 3. 현재 상태 (기준선)

- `runShortsJob`(`src/orchestrator/shorts.ts`): 기획→디자인→씬 이미지→씬 QA(`qaSceneImages`)→조립.
- Remotion 배선: `renderShortsVideoRemotion(dir, scenes, images, opts)`(`src/tools/shortsRenderRemotion.ts`)
  — `propScenes { imageSrc, audioSrc, screenText, durationInFrames, kind?, ... }` → `AutoShorts`.
- 씬 렌더: `KenBurnsImage`(스틸+줌팬). 씬 길이는 오디오 지배(`sceneDurationSec`), 30fps.
- ffmpeg 폴백(`shortsRender.ts`): Pillow 프레임+zoompan — I2V와 무관하게 유지.
- 설정 패턴: `CONFIG` + `env()`(`src/config.ts`).

## 4. 설계

### 4.1 게이트·설정

- `FAL_KEY` — fal.ai API 키(사용자 발급). 없으면 I2V 전체 no-op.
- `SHORTS_I2V` — `fal`(기본) | `off`. `off`면 키가 있어도 no-op.
- `SHORTS_I2V_MODEL` — 기본 `fal-ai/ltx-2/image-to-video/fast`.
- `CONFIG`에 `falKey`·`shortsI2v`·`shortsI2vModel` 추가.

### 4.2 새 모듈 `src/orchestrator/shortsSceneClips.ts`

```ts
export interface SceneClipsResult { clips: Array<string | null>; issues: string[] }
export async function i2vSceneClips(opts: {
  dir: string; images: Array<string | null>; scenePrompts: string[]; signal?: AbortSignal;
}): Promise<SceneClipsResult>;
```

동작:
1. 게이트(`shortsI2v==='fal' && falKey`) 아니면 `{ clips: images.map(()=>null), issues: [] }` no-op.
2. non-null 씬 이미지 각각을 **병렬**로 fal queue API 호출:
   - `POST https://queue.fal.run/{model}` (헤더 `Authorization: Key ${falKey}`)
   - body: `{ prompt, image_url: dataURI(base64 png), duration: 6, resolution: '1080p', fps: 25, generate_audio: false }`
     (오디오 불필요 — 내레이션·자막은 렌더러가 얹음. duration 최소값 6초.)
   - 응답 `{ request_id, status_url, response_url }` → `status_url` 폴링(2초 간격) →
     COMPLETED 시 `response_url`에서 `{ video: { url } }` → mp4 다운로드 `dir/clips/clip_NN.mp4`.
3. 씬당 타임아웃 캡 120초(폴링 포함), 재시도 없음 — 과금 캡: 편당 최대 8클립.
4. 씬별 try/catch — 실패 씬만 null(그 씬은 KenBurns 폴백). 전체도 try/catch fail-open.
5. `signal` 취소 존중(폴링 루프·다운로드 중단).
6. 순수 헬퍼(테스트 대상): `buildMotionPrompt(scenePrompt)` = 씬 프롬프트 + ' subtle cinematic
   motion, slow camera drift, natural ambient movement, no text, no captions.',
   `extractVideoUrl(json)` = 응답에서 video.url 안전 추출(없으면 null).

### 4.3 배선

- `runShortsJob`: 씬 QA 직후
  `const cv = await i2vSceneClips({ dir, images, scenePrompts: bgDraft.imageSlots.map(s=>s.prompt), signal });`
  → `renderShortsVideoRemotion(dir, plan.scenes, images, { clips: cv.clips, signal })`.
  클립 수를 `say()`로 보고(0이어도 게이트 on이면 이슈 요약).
- `renderShortsVideoRemotion` 시그니처 확장: `opts.clips?: Array<string|null>` —
  propScenes 스테이징 시 클립을 `public/clip_NN.mp4`로 복사, `videoSrc` 필드 추가.
- `AutoShorts.tsx`: zod에 `videoSrc: z.string().nullable().optional()`. Scene 렌더:
  `videoSrc` 있으면 `<Loop durationInFrames={clipFrames}><OffthreadVideo src={staticFile(videoSrc)} muted /></Loop>`
  (클립 6초×30fps 기준 180프레임 루프 — 씬이 더 길면 반복), 없으면 기존 `KenBurnsImage`.
  클립 fps(25)와 컴포지션 fps(30) 차이는 Remotion이 프레임 보간 없이 재생 — 실런에서 확인.
- ffmpeg 폴백: 무변경(클립 무시).

### 4.4 출력 비율 (실런 검증 항목)

fal I2V는 관례상 입력 이미지 비율을 추종한다(문서에 세로 명시는 없음). 입력 1024×1536(2:3)
→ 세로 클립 기대. **실런에서 첫 클립의 실제 해상도·비율을 확인**하고, 가로로 나오면 모델을
`fal-ai/wan/v2.2-5b/image-to-video` 계열로 교체(env)한다 — 모듈 코드는 모델 불문 동일.

## 5. 에러 처리

- 키 없음/`off` → no-op(기존 파이프라인과 동일 경로).
- 개별 씬 실패(타임아웃·API 오류·다운로드 실패) → 그 씬만 스틸 폴백, issues에 한 줄.
- 전체 예외 → 전 씬 스틸(fail-open), 잡 무중단.
- Remotion 렌더 실패 → 기존 ffmpeg 폴백 그대로.

## 6. 테스트

- 단위(vitest): `buildMotionPrompt`(접미 포함·원본 보존), `extractVideoUrl`(정상/결측/이형 응답).
- API 실호출·클립 재생은 실런 검증(FAL_KEY 준비 후): 세로 비율 확인(§4.4), Remotion 루프 재생,
  실패 씬 스틸 폴백.
- 회귀: 키 없음 경로에서 기존 렌더와 동일(clips 전부 null).

## 7. 의존성

- 새 npm 의존성 없음(Node 20+ 내장 fetch).
- **사용자 선행 작업: fal.ai 계정 생성 → API 키 발급 → `.env`에 `FAL_KEY=` 추가.**
- 비용: LTX-2 fast 기준 \$0.04/초 → 6초 클립 ~\$0.24, 4씬 편당 ~\$1. 모델 교체 시 변동.

## 8. 완료 기준

- FAL_KEY 있는 환경에서 실런 시 씬 배경이 모션 클립으로 재생(세로 비율 확인 포함).
- 키 없음·`SHORTS_I2V=off`·클립 실패 씬에서 기존 KenBurns 렌더 그대로(회귀 없음).
- 순수 헬퍼 단위테스트 통과, 루트+remotion tsc 0.

## 9. 실런 확인 결과 (2026-07-08 추가)

§4.4 검증 실행: LTX-2 는 fast/일반 모두 aspect 파라미터가 없어 **가로(1920×1080) 전용**으로
확인(세로 입력을 중앙 크롭 재구도) → 기본 모델을 `fal-ai/wan/v2.2-5b/image-to-video` 로
변경(704×1280 세로 확인, 6.04초·24fps·클립당 ~66초 생성). LTX 계열과 Wan 계열의 요청
스키마가 달라 `buildI2vBody(model, ...)` 순수 함수로 모델별 body 를 분기(단위테스트 포함).
