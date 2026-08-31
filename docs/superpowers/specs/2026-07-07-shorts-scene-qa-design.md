# 쇼츠 렌더 전 씬 배경 비전 QA 설계 (Phase 2a)

- 날짜: 2026-07-07
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 쇼츠 파이프라인

## 1. 목표

쇼츠 씬 배경(gpt-image)을 **렌더 전에 Claude 비전으로 검수**해 불량 씬 이미지만 1회 재생성한다.
잡글자·나쁜 구도·왜곡을 사전 차단해 출력 품질을 높인다. 자막은 렌더러가 얹으므로 배경 이미지
자체를 검수한다 — 따라서 **엔진 독립**(Remotion·ffmpeg 양쪽 출력이 같이 좋아짐). 카드뉴스의
비전 QA 패턴(검수→불량만 재생성)을 미러링한다.

Phase 2의 두 하위기능 중 첫째. 데이터 시각화(씬 kind 확장 + CountUp/리스트/인용)는 별도 사이클.

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| QA 대상 | **원본 배경 이미지**(합성 스틸 아님) | renderStill 불필요, 카드뉴스 QA+gpt-image 재생성 재사용, 엔진 독립 |
| 검수 항목 | 잡글자·구도·왜곡 (하단 25% 세이프존 검사 **제외**) | 자막 뒤 반투명 박스가 가독성 보장 → 하단 피사체 무해 |
| 재생성 | 불량 씬만 씬당 1회 | 과금 캡, 카드뉴스와 동일 |
| 게이트 | `visionCapable()`(claude- 모델) | 카드뉴스와 동일; 비-Claude면 no-op |

## 3. 현재 상태 (기준선)

- `runShortsJob`(`src/orchestrator/shorts.ts`): 기획→디자인→씬 이미지 생성→조립.
- 씬 이미지: `generateImagesForDraft(bgDraftPath, dir/scenes, bgManifestPath, {size:'1024x1536',...})`
  (205행)로 gpt-image 세로 무텍스트 배경 생성. `buildSceneImagePrompt`가 씬별 프롬프트 조립(199행).
- 정리: `images: (string|null)[]`(209-219행) — 실패 씬 null(렌더러 그라데이션 폴백).
- **QA 삽입 지점**: 219행(images 정리) 직후 · 222행(조립) 직전.
- 참고 패턴: `src/orchestrator/cardnews.ts`의 QA 루프 — microJSON 비전(visionPaths)으로 슬라이드
  검수 → 불량 슬롯만 retry 드래프트로 `generateImagesForDraft` 재생성 → 파일 교체 → try/catch fail-open.
- `visionCapable()`(cardnews.ts): 표준 모델이 `claude-`로 시작할 때만 true.

## 4. 설계

### 4.1 배치

새 모듈 `src/content/shortsSceneQa.ts`에 QA 로직을 담고, `runShortsJob`은 219행 직후 한 줄로 호출:

```ts
// 3-b) 씬 배경 비전 QA — 잡글자·구도·왜곡 불량만 재생성(claude 비전, fail-open).
const qa = await qaSceneImages({
  dir, images, scenePrompts: bgDraft.imageSlots.map((s) => s.prompt),
  preset: design.preset, refImages: [], signal: opts.signal,
});
images = qa.images;
if (qa.regenerated) say(`씬 QA — ${qa.regenerated}장 재생성`);
```

### 4.2 `qaSceneImages` — 인터페이스

```ts
export interface SceneQaResult { images: Array<string | null>; regenerated: number; issues: string[] }
export async function qaSceneImages(opts: {
  dir: string;
  images: Array<string | null>;
  scenePrompts: string[];      // 씬별 원본 프롬프트(재생성용)
  preset: string;              // imageStyle
  refImages?: string[];
  signal?: AbortSignal;
}): Promise<SceneQaResult>;
```

동작:
1. `visionCapable()` 아니거나 non-null 이미지가 없으면 즉시 `{ images, regenerated:0, issues:[] }`(no-op).
2. **검수 대상 목록 구성**: `checked = images` 중 non-null 만 `{ origIndex, path }`로 모아 순서 유지
   (예: images=[a,null,b] → checked=[{0,a},{1,b}]). 비전에 넘기는 이미지 순번(1..checked.length)이
   곧 `checked` 위치이고, 이를 통해 원본 `images[]` 인덱스로 되매핑한다.
3. **비전 검수**: `checked`의 path 들을 `microJSON`(vision, `visionPaths`)에 순서대로 넘겨 각 씬에서
   ① 이미지 내 잡글자·워터마크·글자, ② 나쁜 구도(주 피사체 잘림/어색/빈 화면), ③ 심한 왜곡·저품질
   을 판정 → `{ issues: [{ scene: 순번(1부터, checked 위치), problem: string }] }`.
   (하단 세이프존 검사는 하지 않는다.)
4. **불량 목록 정규화**: `parseBadScenes(issues, checked.length)` → 유효(1..checked.length)·중복 제거·
   정렬된 checked-위치(1-base) 배열. 상한: `bad.length >= checked.length`(전량 불량)면 스킵
   (시스템적 문제, 재생성해도 동일 확률 — 과금 폭주 방지).
5. **재생성**: 각 불량 checked 위치 `k`(1-base) → `orig = checked[k-1].origIndex`. retry 드래프트를
   그 origIndex들의 프롬프트로 구성 — `buildRetryPrompt(scenePrompts[orig])` = 원본 + " 이미지 안에
   어떤 글자·문자·숫자·워터마크도 넣지 말 것. 주 피사체를 화면 안에 온전히, 안정적 구도로." →
   `generateImagesForDraft(retryDraft, dir/scenes-retry, retryManifest, { imageStyle: preset,
   limit: bad.length, refImages, size:'1024x1536', timeoutMs:150_000*bad.length }, signal)`.
6. **교체**: retry 매니페스트에서 성공한 씬만 원본 `images[orig]`를 새 파일 경로로 교체(실패 씬은 원본
   유지). `regenerated` = 교체 성공 수.
7. 반환 `{ images, regenerated, issues }`.

전체를 try/catch로 감싸 **fail-open** — QA/재생성 실패 시 원본 `images` 그대로 반환(잡 무중단).
`signal.aborted`면 즉시 throw('취소됨') 또는 no-op 반환(호출부 checkAbort와 정합).

### 4.3 순수 헬퍼(테스트 대상)

- `parseBadScenes(issues: Array<{scene?: unknown}>, count: number): number[]` — 유효(1..count)·중복
  제거·정렬된 불량 인덱스. `Math.floor(Number(scene))` 방어.
- `buildRetryPrompt(base: string): string` — 원본 프롬프트 + 강화 접미(순수 문자열).

## 5. 에러 처리

- QA 전체 try/catch → 실패 시 원본 이미지 유지(fail-open), 잡 계속.
- 개별 retry 씬 실패 → 그 씬만 원본 유지.
- `visionCapable()` false → no-op(비-Claude 백엔드 안전).
- `signal` 취소 → 즉시 중단.

## 6. 테스트

- 단위(vitest): `parseBadScenes`(범위/중복/비정상값 방어), `buildRetryPrompt`(접미 포함).
- 비전 호출·gpt-image 재생성은 부작용이라 실 쇼츠 런으로 검증(불량 이미지가 개선되는지 눈 확인).
- 회귀: QA를 타지 않는 경로(visionCapable false, 이미지 전무)에서 기존 동작 불변.

## 7. 의존성

- 재사용: `generateImagesForDraft`(`src/tools/blog_skills.ts`), `microJSON`(vision), `visionCapable()`
  패턴(cardnews.ts). 새 npm 의존성 없음.
- gpt-image 재생성은 유료(OpenAI) — 불량 씬만·씬당 1회로 캡.

## 8. 완료 기준

- 불량 씬 배경(잡글자/나쁜 구도/왜곡)이 렌더 전에 재생성돼 교체됨(실 런에서 관측).
- `visionCapable()` false·이미지 전무 시 no-op, 기존 파이프라인 회귀 없음.
- 순수 헬퍼 단위테스트 통과. tsc 0.
