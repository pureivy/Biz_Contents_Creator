# 품질 후속 정리 사이클 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 누적 비차단 후속 10건을 4개 영역(비전 QA 공유화·TTS 이중합성 방지·I2V 하드닝·유튜브/성과 마이너)으로 상환한다 — 신기능 없음, 전부 하드닝·중복 제거.

**Architecture:** 영역별 독립 태스크 4개. A는 `visionCommon.ts` 공유 헬퍼 신설 후 두 QA(쇼츠·카드뉴스)가 위임, B는 ffmpeg 폴백이 Remotion 이 합성한 mp3 재사용, C는 fal cancel/씬 시그널/클립 판정 추출/stat 상한, D는 포트 파생·due 캡·fmtCount·slug 재검증·tmp pid.

**Tech Stack:** TypeScript·vitest·React(기존). 새 의존성 없음.

## Global Constraints

- 전 항목 **기존 실패 시맨틱 불변**(fail-open/try-catch 구조 안의 수정). 신기능·동작 확장 금지.
- `parseBadScenes` 는 export 유지(위임 래퍼) — 기존 테스트·소비 호환.
- cardnews 의 bad 배열은 `parseBadIndices` 로 **정렬 정규화**됨(기존 미정렬) — retryDraft 생성과 교체 루프가 같은 배열을 쓰므로 정합 유지(무해한 순서 정규화).
- 빌드/테스트: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json`(exit 0), `npx vitest run <경로>`, D 태스크는 `cd frontend && npm run build` 포함.
- 커밋 직전 `git status --short`로 내 파일만 스테이징(병렬 세션 data/ 금지). 브랜치 **main** 직접 커밋(사용자 지시).

---

### Task 1 (영역 A): visionCommon 공유화 + cardnews r.ok + 씬undefined 로그 + 리맵 헬퍼

**Files:**
- Create: `src/orchestrator/visionCommon.ts`
- Create: `src/orchestrator/visionCommon.test.ts`
- Modify: `src/orchestrator/shortsSceneQa.ts`
- Modify: `src/orchestrator/shortsSceneQa.test.ts`
- Modify: `src/orchestrator/cardnews.ts`

**Interfaces:**
- Produces:
  - `stdModel(): string`, `visionCapable(): boolean` (visionCommon)
  - `parseBadIndices(issues: unknown, key: string, count: number): number[]` (순수)
  - `mapBadToOrig(bad: number[], checked: Array<{ origIndex: number }>): number[]` (shortsSceneQa, 순수)
  - (호환 유지) `parseBadScenes(issues, count)` — parseBadIndices('scene') 위임.

- [ ] **Step 1: Write the failing tests**

`src/orchestrator/visionCommon.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseBadIndices } from './visionCommon';

describe('parseBadIndices — 키 일반화(scene/slide)·범위·중복·정렬(순수)', () => {
  it('scene/slide 키 모두 지원, 중복·범위밖·비정상값 방어, floor', () => {
    expect(parseBadIndices([{ scene: 2 }, { scene: 2 }, { scene: 1 }], 'scene', 3)).toEqual([1, 2]);
    expect(parseBadIndices([{ slide: 0 }, { slide: 4 }, { slide: 'x' }, { slide: 3 }], 'slide', 3)).toEqual([3]);
    expect(parseBadIndices([{ scene: 2.9 }], 'scene', 3)).toEqual([2]);
    expect(parseBadIndices(null, 'scene', 3)).toEqual([]);
    expect(parseBadIndices([], 'slide', 3)).toEqual([]);
  });
});
```
`src/orchestrator/shortsSceneQa.test.ts` — import 라인에 `mapBadToOrig` 추가(기존 식별자 유지), 파일 끝에 추가:
```ts
describe('mapBadToOrig — checked 순번→원본 인덱스(순수)', () => {
  it('널홀 건너뛴 checked 매핑, 빈/범위밖 방어', () => {
    const checked = [{ origIndex: 0 }, { origIndex: 2 }, { origIndex: 3 }];
    expect(mapBadToOrig([1, 3], checked)).toEqual([0, 3]);
    expect(mapBadToOrig([], checked)).toEqual([]);
    expect(mapBadToOrig([4], checked)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/orchestrator/visionCommon.test.ts src/orchestrator/shortsSceneQa.test.ts`
Expected: FAIL — "Cannot find module './visionCommon'" / `mapBadToOrig` export 없음.

- [ ] **Step 3: visionCommon.ts 작성**

```ts
/**
 * 비전 QA 공유 헬퍼 — 쇼츠 씬 QA(shortsSceneQa)와 카드뉴스 QA(cardnews)가 공유하는
 * 게이트·파싱. 비전은 표준 모델이 claude- 일 때만(로컬 백엔드는 이미지 불가 — 환각 방지).
 */
import { CONFIG } from '../config';

export const stdModel = (): string => CONFIG.cloudTierModels.standard;
export const visionCapable = (): boolean => stdModel().startsWith('claude-');

/** 비전 이슈 배열 → 유효(1..count)·중복 제거·정렬된 1-base 불량 순번(순수). key = 'scene' | 'slide' 등. */
export function parseBadIndices(issues: unknown, key: string, count: number): number[] {
  const arr = Array.isArray(issues) ? issues : [];
  const set = new Set<number>();
  for (const it of arr) {
    const k = Math.floor(Number((it as Record<string, unknown> | null)?.[key]));
    if (Number.isFinite(k) && k >= 1 && k <= count) set.add(k);
  }
  return [...set].sort((a, b) => a - b);
}
```

- [ ] **Step 4: shortsSceneQa.ts 수정**

(a) import — 기존:
```ts
import { CONFIG } from '../config';
import { microJSON } from './agent';
import { generateImagesForDraft } from '../tools/blog_skills';

const stdModel = (): string => CONFIG.cloudTierModels.standard;
const visionCapable = (): boolean => stdModel().startsWith('claude-');
```
을 다음으로 교체(CONFIG 는 더 이상 안 씀):
```ts
import { microJSON } from './agent';
import { generateImagesForDraft } from '../tools/blog_skills';
import { stdModel, visionCapable, parseBadIndices } from './visionCommon';
```
(b) parseBadScenes — 기존 함수 본문을 위임으로 교체:
```ts
/** 비전 이슈 배열 → 불량 씬 순번 — parseBadIndices('scene') 위임(기존 소비 호환 유지). */
export function parseBadScenes(issues: Array<{ scene?: unknown }>, count: number): number[] {
  return parseBadIndices(issues, 'scene', count);
}
```
(c) mapBadToOrig 추가 — `buildRetryPrompt` 함수 뒤에:
```ts
/** 불량 순번(1-base, checked 기준) → 원본 images 인덱스(순수). 범위밖은 제외. */
export function mapBadToOrig(bad: number[], checked: Array<{ origIndex: number }>): number[] {
  return bad.map((k) => checked[k - 1]?.origIndex).filter((v): v is number => v !== undefined);
}
```
(d) issues 조립·리맵 — 기존:
```ts
    out.issues = (qa?.issues ?? []).map((x) => `씬${x?.scene}: ${String(x?.problem ?? '').slice(0, 60)}`);
    const bad = parseBadScenes(qa?.issues ?? [], checked.length);
    if (!bad.length || bad.length >= checked.length) return out; // 없음 or 전량 불량(스킵)
```
을 다음으로 교체(검증된 순번만 로그 — 씬undefined 방지):
```ts
    const rawIssues = qa?.issues ?? [];
    const bad = parseBadScenes(rawIssues, checked.length);
    out.issues = rawIssues
      .filter((x) => bad.includes(Math.floor(Number(x?.scene))))
      .map((x) => `씬${Math.floor(Number(x?.scene))}: ${String(x?.problem ?? '').slice(0, 60)}`);
    if (!bad.length || bad.length >= checked.length) return out; // 없음 or 전량 불량(스킵)
```
(e) retryDraft·교체 루프 — 기존:
```ts
    const retryDraft = {
      imageSlots: bad.map((k) => {
        const orig = checked[k - 1]!.origIndex;
        return { alt: `scene ${orig + 1}`, prompt: buildRetryPrompt(opts.scenePrompts[orig] ?? '') };
      }),
    };
```
을 다음으로 교체:
```ts
    const origIdxs = mapBadToOrig(bad, checked);
    const retryDraft = {
      imageSlots: origIdxs.map((orig) => ({ alt: `scene ${orig + 1}`, prompt: buildRetryPrompt(opts.scenePrompts[orig] ?? '') })),
    };
```
그리고 기존:
```ts
    bad.forEach((k, j) => {
      const orig = checked[k - 1]!.origIndex;
      const im = rm.images?.[j];
      const fp = im?.file_path ? String(im.file_path) : '';
      if (fp && !im?.error && fs.existsSync(fp)) { out.images[orig] = fp; out.regenerated++; }
    });
```
을 다음으로 교체:
```ts
    origIdxs.forEach((orig, j) => {
      const im = rm.images?.[j];
      const fp = im?.file_path ? String(im.file_path) : '';
      if (fp && !im?.error && fs.existsSync(fp)) { out.images[orig] = fp; out.regenerated++; }
    });
```

- [ ] **Step 5: cardnews.ts 수정**

(a) 자체 정의 제거 — 기존:
```ts
const stdModel = (): string => CONFIG.cloudTierModels.standard;
const visionCapable = (): boolean => stdModel().startsWith('claude-');
```
을 삭제하고, 파일 상단 import 블록(다른 상대 import 근처)에 추가(CONFIG import 는 파일 내 다른 사용처가 있으므로 **건드리지 말 것**):
```ts
import { stdModel, visionCapable, parseBadIndices } from './visionCommon';
```
(b) bad 파싱 — 기존:
```ts
        const bad = [...new Set((qa?.issues ?? [])
          .map((x) => Math.floor(Number(x?.slide)))
          .filter((k) => Number.isFinite(k) && k >= 1 && k <= slideMap.length))];
```
을 다음으로 교체:
```ts
        const bad = parseBadIndices(qa?.issues, 'slide', slideMap.length);
```
(c) retry r.ok 가드 — 기존:
```ts
          await generateImagesForDraft(retryDraftPath, path.join(dir, 'bg-retry'), retryManifestPath,
            { imageStyle: design.preset, limit: bad.length, refImages: refs.refPaths, allowText: true, timeoutMs: 150_000 * bad.length }, opts.signal);
          const rem = JSON.parse(fs.readFileSync(retryManifestPath, 'utf-8')) as { images?: Array<{ file_path?: string; error?: string }> };
          let replaced = 0;
          bad.forEach((k, j) => {
            const fp = rem.images?.[j]?.file_path;
            if (fp && !rem.images?.[j]?.error && fs.existsSync(String(fp))) {
              fs.copyFileSync(String(fp), slidePaths[k - 1]!);
              replaced++;
            }
          });
          if (replaced) say(`QA — ${replaced}장 교정 완료`);
```
을 다음으로 교체(스테일 매니페스트 오독 방지 — shortsSceneQa 와 동일 패턴):
```ts
          const rr = await generateImagesForDraft(retryDraftPath, path.join(dir, 'bg-retry'), retryManifestPath,
            { imageStyle: design.preset, limit: bad.length, refImages: refs.refPaths, allowText: true, timeoutMs: 150_000 * bad.length }, opts.signal);
          if (!rr.ok) {
            say('QA — 재생성 스크립트 실패(기존 완성본 유지)');
          } else {
            const rem = JSON.parse(fs.readFileSync(retryManifestPath, 'utf-8')) as { images?: Array<{ file_path?: string; error?: string }> };
            let replaced = 0;
            bad.forEach((k, j) => {
              const fp = rem.images?.[j]?.file_path;
              if (fp && !rem.images?.[j]?.error && fs.existsSync(String(fp))) {
                fs.copyFileSync(String(fp), slidePaths[k - 1]!);
                replaced++;
              }
            });
            if (replaced) say(`QA — ${replaced}장 교정 완료`);
          }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/orchestrator`
Expected: PASS (visionCommon 신규 + shortsSceneQa 기존·신규).

- [ ] **Step 7: Typecheck + 전체 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src` → PASS.

- [ ] **Step 8: Commit**

```bash
git status --short   # 아래 5개 파일만 확인
git add src/orchestrator/visionCommon.ts src/orchestrator/visionCommon.test.ts src/orchestrator/shortsSceneQa.ts src/orchestrator/shortsSceneQa.test.ts src/orchestrator/cardnews.ts
git commit -m "refactor(qa): 비전 QA 공유 헬퍼(visionCommon) + cardnews 재생성 r.ok 가드 + 씬 이슈 로그 검증 후 조립 + 리맵 순수 헬퍼"
```

---

### Task 2 (영역 B): ffmpeg 폴백 TTS 이중합성 방지

**Files:**
- Modify: `src/tools/shortsRender.ts` (씬 루프 TTS 블록, ~60행)

**Interfaces:**
- Consumes: 없음(파일 내부 수정). Remotion 경로의 산출물 규약 `dir/remotion/narr_<NN>.mp3`(shortsCommon.prepareScenes)만 참조.

- [ ] **Step 1: TTS 재사용 삽입**

기존:
```ts
    // 1) 내레이션 TTS → mp3 (실패 시 무음 씬으로 폴백)
    let audioPath: string | null = null;
    let audioDur = 0;
    try {
      const mp3 = await synthesize(scene.narration, { voice: opts.voice, instructions: opts.instructions ?? SHORTS_TTS_TONE, signal: opts.signal });
      audioPath = path.join(segDir, `narr_${nn}.mp3`);
      fs.writeFileSync(audioPath, mp3);
      audioDur = await probeDuration(audioPath);
    } catch (e) {
```
을 다음으로 교체(Remotion 이 먼저 합성해 둔 mp3 재사용 — 폴백 시 TTS 이중 과금 방지. audioPath 를 probe 성공 후에 할당해 깨진 파일이 ffmpeg 입력으로 새는 기존 잠재 nit 도 함께 해소):
```ts
    // 1) 내레이션 TTS → mp3 (실패 시 무음 씬으로 폴백).
    //    Remotion 경로가 먼저 합성해 둔 mp3(dir/remotion/narr_NN.mp3)가 있으면 재사용 — 폴백 시 TTS 이중 과금 방지.
    let audioPath: string | null = null;
    let audioDur = 0;
    try {
      const remotionMp3 = path.join(dir, 'remotion', `narr_${nn}.mp3`);
      const dst = path.join(segDir, `narr_${nn}.mp3`);
      if (fs.existsSync(remotionMp3)) {
        fs.copyFileSync(remotionMp3, dst);
      } else {
        const mp3 = await synthesize(scene.narration, { voice: opts.voice, instructions: opts.instructions ?? SHORTS_TTS_TONE, signal: opts.signal });
        fs.writeFileSync(dst, mp3);
      }
      audioDur = await probeDuration(dst);
      audioPath = dst;
    } catch (e) {
```

- [ ] **Step 2: Verify types + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/tools` → PASS. (이 경로는 순수 부분이 없어 신규 단위테스트 없음 — 스펙 §6, 리뷰로 검증.)

- [ ] **Step 3: Commit**

```bash
git status --short   # src/tools/shortsRender.ts 만
git add src/tools/shortsRender.ts
git commit -m "fix(shorts): ffmpeg 폴백이 Remotion 합성 mp3 재사용 — TTS 이중 과금 방지(+깨진 mp3 유입 nit 해소)"
```

---

### Task 3 (영역 C): I2V 하드닝(cancel_url·씬 시그널) + resolveClipSrc + stat 상한

**Files:**
- Modify: `src/orchestrator/shortsSceneClips.ts` (falQueueRun + 씬 루프)
- Modify: `src/tools/shortsCommon.ts` (resolveClipSrc 추가 + normalizeSceneKind stat 상한)
- Modify: `src/tools/shortsCommon.test.ts` (케이스 추가)
- Modify: `src/tools/shortsRenderRemotion.ts` (propScenes 가 resolveClipSrc 사용)

**Interfaces:**
- Produces: `resolveClipSrc(clip: string | null | undefined, nn: string): string | null` (shortsCommon — fs.existsSync 만 수행).

- [ ] **Step 1: Write the failing tests**

`src/tools/shortsCommon.test.ts` — import 라인에 `resolveClipSrc` 추가, 파일 끝에 추가:
```ts
describe('resolveClipSrc — 클립 존재 판정(픽스처)', () => {
  it('존재 파일 → clip_NN.mp4, 부재/null/undefined → null', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `clip-src-${process.pid}-`));
    const f = path.join(tmp, 'c.mp4');
    fs.writeFileSync(f, 'x');
    expect(resolveClipSrc(f, '01')).toBe('clip_01.mp4');
    expect(resolveClipSrc(path.join(tmp, 'none.mp4'), '02')).toBeNull();
    expect(resolveClipSrc(null, '03')).toBeNull();
    expect(resolveClipSrc(undefined, '04')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
describe('normalizeSceneKind — stat 자릿수 상한', () => {
  it('1e12 이상은 강등(CountUp 패널 넘침 방지)', () => {
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: 1e12 } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: -1e12 } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: 999_999_999_999 } }))
      .toEqual({ kind: 'stat', stat: { value: 999_999_999_999 } });
  });
});
```
(파일 상단에 `fs`/`os`/`path` import 가 없으면 `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';` 추가.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/shortsCommon.test.ts`
Expected: FAIL — `resolveClipSrc` export 없음 / 1e12 케이스가 `{kind:'stat',...}` 를 반환해 toEqual({}) 실패.

- [ ] **Step 3: shortsCommon.ts 구현**

(a) normalizeSceneKind stat 분기 — 기존:
```ts
    if (!Number.isFinite(value)) return {};
```
을 다음으로 교체:
```ts
    if (!Number.isFinite(value) || Math.abs(value) >= 1e12) return {}; // 12자리+ 는 CountUp 패널 넘침 — 강등
```
(b) 파일 끝(prepareScenes 뒤)에 추가:
```ts
/** 클립 스테이징 판정 — 존재하는 클립이면 public 파일명(clip_NN.mp4), 아니면 null. 복사는 호출자. */
export function resolveClipSrc(clip: string | null | undefined, nn: string): string | null {
  return clip && fs.existsSync(clip) ? `clip_${nn}.mp4` : null;
}
```

- [ ] **Step 4: shortsRenderRemotion.ts 가 사용**

import — 기존:
```ts
import { prepareScenes, buildSrt } from './shortsCommon';
```
을 다음으로 교체:
```ts
import { prepareScenes, buildSrt, resolveClipSrc } from './shortsCommon';
```
propScenes — 기존:
```ts
    let videoSrc: string | null = null;
    const clip = opts.clips?.[p.index];
    if (clip && fs.existsSync(clip)) { const dst = `clip_${nn}.mp4`; fs.copyFileSync(clip, path.join(publicDir, dst)); videoSrc = dst; }
```
을 다음으로 교체:
```ts
    const videoSrc = resolveClipSrc(opts.clips?.[p.index], nn);
    if (videoSrc) fs.copyFileSync(opts.clips![p.index]!, path.join(publicDir, videoSrc));
```

- [ ] **Step 5: shortsSceneClips.ts — cancel_url + 씬 결합 시그널**

(a) `falQueueRun` 전체를 다음으로 교체(변경: cancel_url 보관·검증 + 실패 경로에서 fire-and-forget 취소):
```ts
/** fal queue REST 1회 실행 — 제출→폴링(2초)→결과 JSON. 타임아웃·취소·비정상 응답은 throw.
 *  중단 시 서버측 잡도 취소(cancel_url PUT, fire-and-forget) — 과금 즉시 종료. */
async function falQueueRun(model: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  const headers = { Authorization: `Key ${CONFIG.falKey}`, 'Content-Type': 'application/json' };
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!sub.ok) throw new Error(`fal 제출 실패 HTTP ${sub.status}`);
  const q = await sub.json() as { status_url?: string; response_url?: string; cancel_url?: string };
  const falHost = (u: string): boolean => { try { const h = new URL(u).host; return h === 'fal.run' || h.endsWith('.fal.run'); } catch { return false; } };
  if (!q.status_url || !q.response_url || !falHost(q.status_url) || !falHost(q.response_url)) throw new Error('fal 큐 응답 이형');
  const cancel = (): void => {
    if (q.cancel_url && falHost(q.cancel_url)) void fetch(q.cancel_url, { method: 'PUT', headers }).catch(() => { /* 취소 실패 무해 */ });
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('취소됨');
      if (Date.now() > deadline) throw new Error('fal 타임아웃(120s)');
      let sj: { status?: string } = {};
      try {
        const st = await fetch(q.status_url, { headers, signal });
        sj = await st.json() as { status?: string };
      } catch { /* 일시 오류 — 데드라인까지 폴링 지속(제출 재시도 아님, 과금 불변) */ }
      if (sj.status === 'COMPLETED') break;
      if (sj.status === 'FAILED' || sj.status === 'ERROR') throw new Error(`fal 실패: ${sj.status}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) { cancel(); throw e; }
  const res = await fetch(q.response_url, { headers, signal });
  if (!res.ok) throw new Error(`fal 결과 조회 실패 HTTP ${res.status}`);
  return res.json();
}
```
(주의: 현재 파일의 falQueueRun 이 위 "변경 전" 형태(폴링 내성 포함)와 다르면 STOP — NEEDS_CONTEXT. cancel fetch 에는 의도적으로 `signal` 을 넘기지 않는다 — 취소된 시그널이 취소 호출 자체를 죽이면 안 됨.)
(b) `i2vSceneClips` 씬 루프 — 기존:
```ts
      try {
        const b64 = fs.readFileSync(img).toString('base64');
        const json = await falQueueRun(CONFIG.shortsI2vModel,
          buildI2vBody(CONFIG.shortsI2vModel, buildMotionPrompt(opts.scenePrompts[i] ?? ''), `data:image/png;base64,${b64}`),
          opts.signal);
```
을 다음으로 교체(씬 단위 결합 시그널 — 폴링+다운로드 전체 120초 캡):
```ts
      try {
        const sceneSignal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
        const b64 = fs.readFileSync(img).toString('base64');
        const json = await falQueueRun(CONFIG.shortsI2vModel,
          buildI2vBody(CONFIG.shortsI2vModel, buildMotionPrompt(opts.scenePrompts[i] ?? ''), `data:image/png;base64,${b64}`),
          sceneSignal);
```
그리고 다운로드 2줄 — 기존:
```ts
        let dl = await fetch(url, { signal: opts.signal });
        if (!dl.ok) dl = await fetch(url, { signal: opts.signal }); // CDN 일시 오류 1회 재시도(생성 재과금 없음)
```
을 다음으로 교체:
```ts
        let dl = await fetch(url, { signal: sceneSignal });
        if (!dl.ok) dl = await fetch(url, { signal: sceneSignal }); // CDN 일시 오류 1회 재시도(생성 재과금 없음)
```

- [ ] **Step 6: Run tests to verify they pass + 회귀**

Run: `npx vitest run src/tools src/orchestrator` → PASS.
Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.

- [ ] **Step 7: Commit**

```bash
git status --short   # 아래 4개 파일만 확인
git add src/orchestrator/shortsSceneClips.ts src/tools/shortsCommon.ts src/tools/shortsCommon.test.ts src/tools/shortsRenderRemotion.ts
git commit -m "fix(shorts): fal cancel_url 취소 + 씬 결합 시그널(다운로드 포함 120s) + resolveClipSrc 추출·테스트 + stat 1e12 상한"
```

---

### Task 4 (영역 D): 유튜브·성과 마이너 5건

**Files:**
- Modify: `src/server/main.ts` (YT_REDIRECT 1줄)
- Modify: `docs/superpowers/specs/2026-07-08-shorts-youtube-publish-design.md` (§9 노트 1줄)
- Modify: `src/analytics/shortsPerf.ts` (due 캡 + slug 재검증)
- Modify: `src/analytics/shortsPerf.test.ts` (due 캡 케이스)
- Modify: `frontend/src/panels/ShortsView.tsx` (fmtCount)
- Modify: `src/agents/workspace.test.ts` · `src/wiki/llmwiki.test.ts` (tmp pid)

**Interfaces:**
- Consumes: `isSafeBrandSlug`(src/content/brand — 기존 export).

- [ ] **Step 1: YT_REDIRECT 포트 파생**

`src/server/main.ts` — 기존:
```ts
const YT_REDIRECT = 'http://127.0.0.1:8787/youtube/oauth/callback';
```
을 다음으로 교체:
```ts
const YT_REDIRECT = `http://127.0.0.1:${CONFIG.port}/youtube/oauth/callback`; // PORT 변경 시 구글 콘솔 리디렉션 URI 도 함께 갱신
```
그리고 `docs/superpowers/specs/2026-07-08-shorts-youtube-publish-design.md` §9 목록 끝(6번 항목 뒤)에 추가:
```markdown
7. **`PORT` 를 8787 에서 바꾸면** 4번의 리디렉션 URI 도 같은 포트로 구글 콘솔에서 갱신해야 한다
   (앱은 `CONFIG.port` 로 자동 추종).
```

- [ ] **Step 2: due 포기 지평 (실패 테스트 먼저)**

`src/analytics/shortsPerf.test.ts` — `shortsPerfDue` describe 의 마지막 it 뒤에 추가:
```ts
  it('포기 지평(측정창 4배) 경과 시 미강화라도 false — 영구 비공개/삭제 영상 무한 재시도 방지', () => {
    expect(shortsPerfDue(base, now + 27 * DAY, 7)).toBe(true);   // 4배(28일) 이내 — 아직 due
    expect(shortsPerfDue(base, now + 29 * DAY, 7)).toBe(false);  // 4배 초과 — 포기
  });
```
Run: `npx vitest run src/analytics/shortsPerf.test.ts` → 신규 케이스 FAIL(29일에도 true).
`src/analytics/shortsPerf.ts` `shortsPerfDue` — 기존:
```ts
  const t = new Date(s.youtubeTs).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= days * 86_400_000 || !s.perfReflected;
```
을 다음으로 교체:
```ts
  const t = new Date(s.youtubeTs).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age > days * 4 * 86_400_000) return false; // 포기 지평(측정창 4배) — 영구 비공개/삭제 영상 무한 재시도 방지
  return age <= days * 86_400_000 || !s.perfReflected;
```
Run: 다시 → PASS.

- [ ] **Step 3: 강화 slug 재검증**

`src/analytics/shortsPerf.ts` — import 추가(기존 content/shorts import 근처):
```ts
import { isSafeBrandSlug } from '../content/brand';
```
`reinforceShorts` 안 — 기존 `const title = s.title ?? s.topic;` 줄 앞에 추가:
```ts
  const brand = s.brand && isSafeBrandSlug(s.brand) ? s.brand : ''; // 경로 싱크 재검증(관례) — 비정상 슬러그는 범용 강등
```
그리고 기존:
```ts
        appendMemory(role, `쇼츠 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 조회 ${m.views}·좋아요 ${m.likes ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, s.brand ?? '');
```
의 마지막 인자 `s.brand ?? ''` 를 `brand` 로, 기존:
```ts
    llmWikiFor(s.brand).upsertPage({
```
을 `llmWikiFor(brand).upsertPage({` 로 교체(위키 body 의 `브랜드: ${s.brand ?? '범용'}` 표기는 원문 유지 — 표시용).

- [ ] **Step 4: fmtCount 롤오버 + tmp pid**

`frontend/src/panels/ShortsView.tsx` — 기존:
```ts
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만`;
```
을 다음으로 교체:
```ts
  if (n >= 9_950) return `${(n / 10_000).toFixed(1)}만`; // 9950+ 는 반올림상 "10.0천" 대신 "1.0만"
```
`src/agents/workspace.test.ts` — 기존:
```ts
  const tmp = path.join(os.tmpdir(), 'workspace-brand-attr-test');
```
을 `` const tmp = path.join(os.tmpdir(), `workspace-brand-attr-test-${process.pid}`); `` 로.
`src/wiki/llmwiki.test.ts` — 기존:
```ts
  const tmp = path.join(os.tmpdir(), 'llmwiki-brand-attr-test');
```
을 `` const tmp = path.join(os.tmpdir(), `llmwiki-brand-attr-test-${process.pid}`); `` 로.

- [ ] **Step 5: Verify — 전체**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src` → PASS.
Run: `cd frontend && npm run build` → 빌드 성공.

- [ ] **Step 6: Commit**

```bash
git status --short   # 아래 7개 파일만 확인
git add src/server/main.ts docs/superpowers/specs/2026-07-08-shorts-youtube-publish-design.md src/analytics/shortsPerf.ts src/analytics/shortsPerf.test.ts frontend/src/panels/ShortsView.tsx src/agents/workspace.test.ts src/wiki/llmwiki.test.ts
git commit -m "fix(cleanup): YT_REDIRECT 포트 파생·성과 due 포기 지평·fmtCount 롤오버·강화 slug 재검증·테스트 tmp pid"
```

---

## 완료 기준 (스펙 §7)

- [ ] 10건 전부 반영·각 테스트 통과(visionCommon·mapBadToOrig·resolveClipSrc·stat 상한·due 캡 신규 케이스 포함).
- [ ] 전체 스위트·루트+remotion tsc 0·프론트 빌드 성공. 기존 동작 회귀 없음(공유화는 중복 제거 diff 로 확인).
