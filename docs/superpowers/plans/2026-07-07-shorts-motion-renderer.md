# 쇼츠 모션그래픽 렌더러 구현 플랜 (Phase 1 · Remotion)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B의 쇼츠 렌더를 정지 슬라이드쇼에서 Remotion 기반 데이터 주도 모션그래픽으로 업그레이드하되, 실패 시 기존 ffmpeg 슬라이드쇼로 폴백한다.

**Architecture:** gpt-image 배경 위에 데이터 주도 Remotion 컴포지션(`AutoShorts`)이 Ken Burns·키네틱 자막·씬 전환·프로그레스바를 그리고 씬별 `<Audio>`로 TTS를 mux한다. LLM의 `plan.scenes`+`images`를 `inputProps`로 그대로 매핑(스키마 무변경). `renderShortsVideoRemotion`을 기존 `renderShortsVideo`와 동일 시그니처의 드롭인으로 만들고 `runShortsJob`이 Remotion 먼저 → 실패 시 ffmpeg 폴백.

**Tech Stack:** TypeScript(Node), Remotion(`remotion`,`@remotion/bundler`,`@remotion/renderer`,`@remotion/cli`), React 19, zod, ffprobe, 기존 TTS(`src/voice/tts.ts`).

## Global Constraints

- 출력 포맷: 1080×1920, 30fps, H.264 + AAC(기존과 동일).
- 씬 길이 불변식: `dur = max(2.8s, audioDur + 0.6s)`, `frames = round(dur × 30)`. 오디오가 길이를 지배.
- Remotion 라이선스: **무료 플랜(개인·3인 이하 팀 전제)**. 모든 Remotion 패키지는 **동일 버전**으로 설치.
- 무중단: Remotion 렌더가 던지거나 `ok:false`면 항상 기존 `renderShortsVideo`(ffmpeg)로 폴백.
- 렌더러 반환형 불변: `{ ok: boolean; videoPath?: string; srtPath?: string; durationSec?: number; sceneCount?: number; issues: string[] }`.
- 에셋 참조: per-render `public/` 스테이징 + `staticFile()` (임의 `file://` 회피).
- `remotion/` 는 root `tsc --noEmit`(include=`src/**/*.ts`) 대상 밖 → 자체 `remotion/tsconfig.json`으로 타입체크. root tsc 게이트를 깨지 않는다.
- 파일 안전: 삭제 시 `trash`(없으면 중단), `mv -n`.
- 빌드/테스트: `npx tsc --noEmit`(exit 0), `npx vitest run <경로>`.

---

### Task 1: shortsCommon.ts — 공유 헬퍼 + shortsRender 리팩터

**Files:**
- Create: `src/tools/shortsCommon.ts`
- Create: `src/tools/shortsCommon.test.ts`
- Modify: `src/tools/shortsRender.ts`

**Interfaces:**
- Produces:
  - 상수 `FPS=30, W=1080, H=1920, MIN_SCENE_SEC=2.8, TAIL_PAD_SEC=0.6, FRAME_W=1620, FRAME_H=2880`
  - `interface ShortsScene { narration: string; screenText?: string }`
  - `interface ShortsRenderResult { ok: boolean; videoPath?: string; srtPath?: string; durationSec?: number; sceneCount?: number; issues: string[] }`
  - `interface PreparedScene { index: number; imagePath: string|null; audioPath: string|null; screenText: string; narration: string; durationSec: number; durationInFrames: number; startFrame: number }`
  - `sceneDurationSec(audioDurSec: number): number`
  - `sceneFrames(durSec: number): number`
  - `fmtSrtTime(sec: number): string`
  - `buildSrt(scenes: { narration: string; durationSec: number }[]): string`
  - `probeDuration(file: string): Promise<number>`
  - `prepareScenes(workDir: string, scenes: ShortsScene[], images: (string|null)[], opts: { voice?: string; instructions?: string; signal?: AbortSignal }): Promise<{ prepared: PreparedScene[]; issues: string[] }>`

- [ ] **Step 1: Write the failing test**

`src/tools/shortsCommon.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { sceneDurationSec, sceneFrames, fmtSrtTime, buildSrt } from './shortsCommon';

describe('sceneDurationSec — 오디오가 길이 지배 + 하한 클램프', () => {
  it('오디오 + 꼬리여백(0.6), 하한 2.8', () => {
    expect(sceneDurationSec(5)).toBeCloseTo(5.6, 5);
    expect(sceneDurationSec(1)).toBeCloseTo(2.8, 5);
    expect(sceneDurationSec(0)).toBeCloseTo(2.8, 5);
    expect(sceneDurationSec(-1)).toBeCloseTo(2.8, 5);
  });
});
describe('sceneFrames — 30fps 반올림', () => {
  it('초 × 30 반올림', () => {
    expect(sceneFrames(2.8)).toBe(84);
    expect(sceneFrames(5.6)).toBe(168);
    expect(sceneFrames(3.017)).toBe(91);
  });
});
describe('fmtSrtTime — SRT 타임코드', () => {
  it('HH:MM:SS,mmm', () => {
    expect(fmtSrtTime(0)).toBe('00:00:00,000');
    expect(fmtSrtTime(3.5)).toBe('00:00:03,500');
    expect(fmtSrtTime(3661.25)).toBe('01:01:01,250');
  });
});
describe('buildSrt — 누적 타이밍', () => {
  it('씬 순서대로 누적 시작/끝', () => {
    expect(buildSrt([
      { narration: '첫 씬', durationSec: 3 },
      { narration: '둘째 씬', durationSec: 2 },
    ])).toBe('1\n00:00:00,000 --> 00:00:03,000\n첫 씬\n\n2\n00:00:03,000 --> 00:00:05,000\n둘째 씬\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/shortsCommon.test.ts`
Expected: FAIL — "Cannot find module './shortsCommon'".

- [ ] **Step 3: Write minimal implementation**

`src/tools/shortsCommon.ts`:
```ts
/**
 * 쇼츠 렌더러 공유 상수·헬퍼 — ffmpeg 슬라이드쇼(shortsRender)와 Remotion(shortsRenderRemotion)이
 * "오디오가 길이를 지배" 불변식·SRT·길이·씬 전처리를 공유한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { synthesize } from '../voice/tts';

const execFileP = promisify(execFile);

export const FPS = 30;
export const W = 1080;
export const H = 1920;
export const MIN_SCENE_SEC = 2.8;
export const TAIL_PAD_SEC = 0.6;
export const FRAME_W = 1620;
export const FRAME_H = 2880;

export const SHORTS_TTS_TONE =
  '활기차고 대화하듯, 약간 빠른 템포로 친근하게 낭독한다. 첫 훅은 궁금증을 자아내게 힘주어, 핵심 수치와 결론은 또렷하고 자신감 있게. 광고 성우톤이 아니라 아는 사람이 알려주듯.';

export interface ShortsScene { narration: string; screenText?: string }
export interface ShortsRenderResult {
  ok: boolean; videoPath?: string; srtPath?: string;
  durationSec?: number; sceneCount?: number; issues: string[];
}
export interface PreparedScene {
  index: number; imagePath: string | null; audioPath: string | null;
  screenText: string; narration: string;
  durationSec: number; durationInFrames: number; startFrame: number;
}

export function sceneDurationSec(audioDurSec: number): number {
  return Math.max(MIN_SCENE_SEC, (audioDurSec > 0 ? audioDurSec : 0) + TAIL_PAD_SEC);
}
export function sceneFrames(durSec: number): number { return Math.round(durSec * FPS); }

export function fmtSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}
export function buildSrt(scenes: { narration: string; durationSec: number }[]): string {
  const lines: string[] = [];
  let clock = 0;
  scenes.forEach((sc, i) => {
    lines.push(`${i + 1}`, `${fmtSrtTime(clock)} --> ${fmtSrtTime(clock + sc.durationSec)}`, sc.narration, '');
    clock += sc.durationSec;
  });
  return lines.join('\n');
}
export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileP('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { timeout: 15_000 });
  const d = parseFloat(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe 길이 측정 실패: ${file}`);
  return d;
}

/** 씬별 TTS 합성(실패 시 무음)·길이 실측·프레임/오프셋 산출. 두 렌더러 공유. */
export async function prepareScenes(
  workDir: string, scenes: ShortsScene[], images: Array<string | null>,
  opts: { voice?: string; instructions?: string; signal?: AbortSignal },
): Promise<{ prepared: PreparedScene[]; issues: string[] }> {
  fs.mkdirSync(workDir, { recursive: true });
  const issues: string[] = [];
  const prepared: PreparedScene[] = [];
  let startFrame = 0;
  for (let i = 0; i < scenes.length; i++) {
    if (opts.signal?.aborted) throw new Error('취소됨');
    const sc = scenes[i]!;
    const nn = String(i + 1).padStart(2, '0');
    let audioPath: string | null = null, audioDur = 0;
    try {
      const mp3 = await synthesize(sc.narration, { voice: opts.voice, instructions: opts.instructions ?? SHORTS_TTS_TONE, signal: opts.signal });
      audioPath = path.join(workDir, `narr_${nn}.mp3`);
      fs.writeFileSync(audioPath, mp3);
      audioDur = await probeDuration(audioPath);
    } catch (e) { issues.push(`씬${i + 1} TTS 실패(무음): ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    const durationSec = sceneDurationSec(audioDur);
    const durationInFrames = sceneFrames(durationSec);
    const imagePath = images[i] && fs.existsSync(images[i]!) ? images[i]! : null;
    if (!imagePath) issues.push(`씬${i + 1} 배경 폴백(그라데이션)`);
    prepared.push({ index: i, imagePath, audioPath, screenText: sc.screenText ?? '', narration: sc.narration, durationSec, durationInFrames, startFrame });
    startFrame += durationInFrames;
  }
  return { prepared, issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/shortsCommon.test.ts`
Expected: PASS (4 describe).

- [ ] **Step 5: Refactor shortsRender.ts to import shared helpers**

`src/tools/shortsRender.ts`:
- import 추가: `import { FPS, W, H, MIN_SCENE_SEC, TAIL_PAD_SEC, FRAME_W, FRAME_H, ShortsScene, ShortsRenderResult, sceneDurationSec, fmtSrtTime, probeDuration, SHORTS_TTS_TONE } from './shortsCommon';`
- 로컬 중복 삭제: `FPS/W/H/FRAME_W/FRAME_H/MIN_SCENE_SEC/TAIL_PAD_SEC` 상수, `interface ShortsScene`,
  `interface ShortsRenderResult`, `function probeDuration`, `function fmtSrtTime`, `const SHORTS_TTS_TONE`.
- 씬 길이 계산 `const dur = Math.max(MIN_SCENE_SEC, audioDur + TAIL_PAD_SEC);` → `const dur = sceneDurationSec(audioDur);`.
- `renderShortsVideo` 시그니처는 그대로.

- [ ] **Step 6: Verify no regression**

Run: `npx tsc --noEmit; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/tools` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/shortsCommon.ts src/tools/shortsCommon.test.ts src/tools/shortsRender.ts
git commit -m "refactor(shorts): 렌더러 공유 헬퍼(shortsCommon: 상수·SRT·prepareScenes) 추출 + 테스트"
```

---

### Task 2: config — SHORTS_RENDERER 토글

**Files:** Modify: `src/config.ts`

**Interfaces:** Produces `CONFIG.shortsRenderer: 'remotion' | 'ffmpeg'` (ENV `SHORTS_RENDERER`, 기본 `'remotion'`).

- [ ] **Step 1: Add config field**

`src/config.ts`:
- `Config` 인터페이스:
```ts
  /** 쇼츠 렌더 엔진 — 'remotion'(모션그래픽, 기본) | 'ffmpeg'(슬라이드쇼 폴백/강제). */
  readonly shortsRenderer: 'remotion' | 'ffmpeg';
```
- CONFIG 리터럴:
```ts
  shortsRenderer: env('SHORTS_RENDERER', 'remotion') === 'ffmpeg' ? 'ffmpeg' : 'remotion',
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit; echo "tsc: $?"` → `tsc: 0`.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(shorts): SHORTS_RENDERER 토글(remotion|ffmpeg) 추가"
```

---

### Task 3: Remotion 의존성 설치 + 프로젝트 스캐폴드

**Files:**
- Modify: `package.json` (deps)
- Create: `remotion/index.ts`, `remotion/Root.tsx`, `remotion/AutoShorts.tsx`(최소), `remotion/tsconfig.json`
- Create: `remotion/public/.gitkeep`

**Interfaces:** Produces 컴포지션 `id="AutoShorts"`, 1080×1920/30fps. `remotion/index.ts`가 엔트리.

- [ ] **Step 1: Install deps (동일 버전)**

Run:
```bash
pnpm add remotion @remotion/bundler @remotion/renderer react react-dom zod
pnpm add -D @remotion/cli @types/react @types/react-dom
npx remotion versions   # 모든 remotion 패키지 버전 일치 확인
```
Expected: 설치 성공, `remotion versions` 가 불일치 경고 없음.

- [ ] **Step 2: Scaffold composition (최소 렌더 가능 버전)**

`remotion/index.ts`:
```ts
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';
registerRoot(RemotionRoot);
```

`remotion/Root.tsx`:
```tsx
import React from 'react';
import { Composition } from 'remotion';
import { AutoShorts, autoShortsSchema, defaultProps } from './AutoShorts';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="AutoShorts"
    component={AutoShorts}
    schema={autoShortsSchema}
    defaultProps={defaultProps}
    fps={30}
    width={1080}
    height={1920}
    durationInFrames={90}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.totalFrames) })}
  />
);
```

`remotion/AutoShorts.tsx` (Task 4에서 확장 — 지금은 최소):
```tsx
import React from 'react';
import { z } from 'zod';
import { AbsoluteFill } from 'remotion';

export const autoShortsSchema = z.object({
  scenes: z.array(z.object({
    imageSrc: z.string().nullable(),
    audioSrc: z.string().nullable(),
    screenText: z.string(),
    durationInFrames: z.number(),
  })),
  totalFrames: z.number(),
});
export type AutoShortsProps = z.infer<typeof autoShortsSchema>;

export const defaultProps: AutoShortsProps = {
  scenes: [{ imageSrc: null, audioSrc: null, screenText: '샘플 자막', durationInFrames: 90 }],
  totalFrames: 90,
};

export const AutoShorts: React.FC<AutoShortsProps> = ({ scenes }) => (
  <AbsoluteFill style={{ background: '#111', color: '#fff', justifyContent: 'center', alignItems: 'center', fontSize: 64 }}>
    {scenes[0]?.screenText}
  </AbsoluteFill>
);
```

`remotion/tsconfig.json` (root tsc include 밖 — 자체 타입체크):
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "noEmit": true,
    "esModuleInterop": true, "types": ["node"]
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

`remotion/public/.gitkeep`: 빈 파일(스테이징 기준 디렉토리).

- [ ] **Step 3: Verify bundle + still render (스캐폴드 동작 확인)**

Run:
```bash
npx tsc --noEmit; echo "root tsc: $?"                # remotion/ 는 include 밖 → 여전히 0 이어야
npx tsc -p remotion/tsconfig.json; echo "remotion tsc: $?"
npx remotion still remotion/index.ts AutoShorts /tmp/autoshorts_scaffold.png
```
Expected: root tsc 0, remotion tsc 0, `/tmp/autoshorts_scaffold.png`(1080×1920, 어두운 배경에 "샘플 자막"). 눈으로 확인.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml remotion/
git commit -m "feat(shorts): Remotion 의존성 + AutoShorts 컴포지션 스캐폴드"
```

---

### Task 4: AutoShorts 컴포지션 + 애니메이션 (verify-by-render)

**Files:**
- Create: `remotion/anim.ts` (순수 타이밍 함수)
- Create: `src/tools/remotionAnim.test.ts` (anim.ts 단위 테스트)
- Create: `remotion/KenBurnsImage.tsx`, `remotion/KineticCaption.tsx`, `remotion/ProgressBar.tsx`
- Modify: `remotion/AutoShorts.tsx` (Series + Audio + 프리미티브 조립)

**Interfaces:**
- `remotion/anim.ts` exports: `kenBurnsScale(local, total, max?)`, `kenBurnsPan(local, total)`, `captionWordsVisible(local, count, perWord?)`, `sceneFadeOpacity(local, total, fade?)`.

- [ ] **Step 1: Write failing test for anim**

`src/tools/remotionAnim.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
// @ts-expect-error — remotion/anim.ts (root tsc include 밖)
import * as A from '../../remotion/anim';

describe('kenBurnsScale', () => {
  it('시작 1, 끝 증가(≤1.12)', () => {
    expect(A.kenBurnsScale(0, 100)).toBeCloseTo(1, 3);
    expect(A.kenBurnsScale(100, 100)).toBeGreaterThan(1.05);
    expect(A.kenBurnsScale(100, 100)).toBeLessThanOrEqual(1.12);
  });
});
describe('captionWordsVisible', () => {
  it('스태거 증가, 상한 count', () => {
    expect(A.captionWordsVisible(0, 3, 6)).toBe(0);
    expect(A.captionWordsVisible(6, 3, 6)).toBe(1);
    expect(A.captionWordsVisible(600, 3, 6)).toBe(3);
  });
});
describe('sceneFadeOpacity', () => {
  it('중앙 1, 경계 0 근처', () => {
    expect(A.sceneFadeOpacity(0, 90, 6)).toBeCloseTo(0, 1);
    expect(A.sceneFadeOpacity(45, 90, 6)).toBeCloseTo(1, 1);
    expect(A.sceneFadeOpacity(90, 90, 6)).toBeLessThan(0.3);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `npx vitest run src/tools/remotionAnim.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: Implement anim.ts**

`remotion/anim.ts`:
```ts
export function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }
export function kenBurnsScale(local: number, total: number, max = 1.08): number {
  const p = total > 0 ? clamp01(local / total) : 0;
  return 1 + (max - 1) * p;
}
export function kenBurnsPan(local: number, total: number): { x: number; y: number } {
  const p = total > 0 ? clamp01(local / total) : 0;
  return { x: (p - 0.5) * 24, y: (p - 0.5) * -24 };
}
export function captionWordsVisible(local: number, count: number, perWord = 6): number {
  if (count <= 0) return 0;
  return Math.min(count, Math.max(0, Math.floor(local / perWord)));
}
export function sceneFadeOpacity(local: number, total: number, fade = 6): number {
  if (total <= 0) return 1;
  const fin = clamp01(local / fade);
  const fout = clamp01((total - local) / fade);
  return clamp01(Math.min(fin, fout));
}
```

- [ ] **Step 4: Run → pass**

Run: `npx vitest run src/tools/remotionAnim.test.ts`
Expected: PASS (3 describe).

- [ ] **Step 5: Implement primitives**

`remotion/KenBurnsImage.tsx`:
```tsx
import React from 'react';
import { AbsoluteFill, Img, useCurrentFrame } from 'remotion';
import { kenBurnsScale, kenBurnsPan } from './anim';

const GRAD = ['#1f2937', '#3b2f2f', '#22303c', '#2f2a3c', '#243027'];
export const KenBurnsImage: React.FC<{ src: string | null; total: number; index: number }> = ({ src, total, index }) => {
  const f = useCurrentFrame();
  const scale = kenBurnsScale(f, total);
  const pan = kenBurnsPan(f, total);
  const transform = `scale(${scale}) translate(${pan.x}px, ${pan.y}px)`;
  if (!src) return <AbsoluteFill style={{ background: `linear-gradient(160deg, ${GRAD[index % GRAD.length]}, #000)`, transform }} />;
  return <AbsoluteFill style={{ transform }}><Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></AbsoluteFill>;
};
```

`remotion/KineticCaption.tsx`:
```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { captionWordsVisible } from './anim';

export const KineticCaption: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const words = text.split(/\s+/).filter(Boolean);
  const vis = captionWordsVisible(f, words.length);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: '20%' }}>
      <div style={{ background: 'linear-gradient(transparent, rgba(0,0,0,.45))', padding: '32px 64px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' }}>
        {words.map((w, i) => (
          <span key={i} style={{ fontSize: 64, fontWeight: 800, color: '#fff', lineHeight: 1.25, textShadow: '0 3px 18px rgba(0,0,0,.75)', opacity: i < vis ? 1 : 0, transform: i < vis ? 'none' : 'translateY(16px)', transition: 'none' }}>{w}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
```

`remotion/ProgressBar.tsx`:
```tsx
import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

export const ProgressBar: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = durationInFrames > 0 ? Math.min(1, f / durationInFrames) : 0;
  return <div style={{ position: 'absolute', top: 0, left: 0, height: 8, width: `${w * 100}%`, background: '#5598f8' }} />;
};
```

- [ ] **Step 6: Assemble AutoShorts**

`remotion/AutoShorts.tsx` (스캐폴드 교체):
```tsx
import React from 'react';
import { z } from 'zod';
import { AbsoluteFill, Series, Audio, Sequence } from 'remotion';
import { KenBurnsImage } from './KenBurnsImage';
import { KineticCaption } from './KineticCaption';
import { ProgressBar } from './ProgressBar';
import { sceneFadeOpacity } from './anim';

export const autoShortsSchema = z.object({
  scenes: z.array(z.object({
    imageSrc: z.string().nullable(),
    audioSrc: z.string().nullable(),
    screenText: z.string(),
    durationInFrames: z.number(),
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
    <KineticCaption text={s.screenText} />
    {s.audioSrc ? <Audio src={s.audioSrc} /> : null}
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
(참고: 씬 경계 페이드는 v1에서 KenBurnsImage/Caption 개별 opacity로 두지 않고 단순 컷 + Ken Burns 로 시작. `sceneFadeOpacity` 는 Task 4 테스트로 검증만 하고 v1.1에서 Series.Sequence transition으로 확장 가능 — YAGNI.)

- [ ] **Step 7: Verify render (still + short preview)**

Run:
```bash
npx tsc -p remotion/tsconfig.json; echo "remotion tsc: $?"
npx vitest run src/tools/remotionAnim.test.ts
npx remotion still remotion/index.ts AutoShorts /tmp/autoshorts_frame.png --frame=45
```
Expected: remotion tsc 0, 테스트 PASS, `/tmp/autoshorts_frame.png`(그라데이션 배경 + 부분 표시 자막 + 프로그레스바). 눈으로 확인.

- [ ] **Step 8: Commit**

```bash
git add remotion/ src/tools/remotionAnim.test.ts
git commit -m "feat(shorts): AutoShorts 컴포지션(KenBurns·키네틱 자막·프로그레스바) + anim 테스트"
```

---

### Task 5: shortsRenderRemotion.ts — Node 렌더 (verify-by-render)

**Files:** Create: `src/tools/shortsRenderRemotion.ts`

**Interfaces:**
- Consumes: `shortsCommon`(prepareScenes·buildSrt·상수·타입), `@remotion/bundler`, `@remotion/renderer`.
- Produces: `renderShortsVideoRemotion(dir, scenes, images, opts?): Promise<ShortsRenderResult>` (반환형 = 기존과 동일).

- [ ] **Step 1: Implement renderer**

`src/tools/shortsRenderRemotion.ts`:
```ts
/**
 * 쇼츠 Remotion 렌더러 — AutoShorts 컴포지션을 @remotion/renderer 로 mp4 렌더. renderShortsVideo
 * (ffmpeg 슬라이드쇼)와 동일 시그니처의 드롭인. 실패 시 호출부가 폴백한다.
 * 에셋(씬 이미지·TTS mp3)은 per-render public/ 로 스테이징해 staticFile 로 참조한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';
import { prepareScenes, buildSrt } from './shortsCommon';
import type { ShortsScene, ShortsRenderResult } from './shortsCommon';

export async function renderShortsVideoRemotion(
  dir: string, scenes: ShortsScene[], images: Array<string | null>,
  opts: { voice?: string; instructions?: string; signal?: AbortSignal } = {},
): Promise<ShortsRenderResult> {
  const entry = path.resolve('remotion/index.ts');
  if (!fs.existsSync(entry)) return { ok: false, issues: ['remotion 엔트리 부재'] };

  const work = path.join(dir, 'remotion');
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  // 1) TTS·길이
  const { prepared, issues } = await prepareScenes(work, scenes, images, opts);
  if (!prepared.length) return { ok: false, issues: [...issues, '조립할 씬 없음'] };

  // 2) 에셋 스테이징(public/) — staticFile 참조명으로 복사
  const propScenes = prepared.map((p) => {
    const nn = String(p.index + 1).padStart(2, '0');
    let imageSrc: string | null = null, audioSrc: string | null = null;
    if (p.imagePath) { const dst = `scene_${nn}${path.extname(p.imagePath) || '.png'}`; fs.copyFileSync(p.imagePath, path.join(publicDir, dst)); imageSrc = dst; }
    if (p.audioPath) { const dst = `narr_${nn}.mp3`; if (path.resolve(p.audioPath) !== path.join(publicDir, dst)) fs.copyFileSync(p.audioPath, path.join(publicDir, dst)); audioSrc = dst; }
    return { imageSrc, audioSrc, screenText: p.screenText, durationInFrames: p.durationInFrames };
  });
  const totalFrames = prepared.reduce((a, p) => a + p.durationInFrames, 0);
  const inputProps = { scenes: propScenes, totalFrames };

  // 3) 번들 + 렌더
  const videoPath = path.join(dir, 'final.mp4');
  try {
    const serveUrl = await bundle({ entryPoint: entry, publicDir });
    const composition = await selectComposition({ serveUrl, id: 'AutoShorts', inputProps });
    await renderMedia({
      serveUrl, composition, codec: 'h264', outputLocation: videoPath, inputProps,
      // 씬 이미지가 staticFile 로 public/ 에서 로드됨. 취소 신호 연동.
    });
  } catch (e) {
    return { ok: false, issues: [...issues, `Remotion 렌더 실패: ${e instanceof Error ? e.message.slice(0, 160) : e}`] };
  }

  // 4) SRT
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, buildSrt(prepared.map((p) => ({ narration: p.narration, durationSec: p.durationSec }))), 'utf-8');

  const durationSec = Math.round(prepared.reduce((a, p) => a + p.durationSec, 0) * 10) / 10;
  return { ok: true, videoPath, srtPath, durationSec, sceneCount: prepared.length, issues };
}
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit; echo "tsc: $?"`
Expected: `tsc: 0`.
> `@remotion/bundler`·`@remotion/renderer` 타입 미해결이면 Task 3 설치 확인. `W`/`H` 미사용 경고면 렌더 옵션에 사용하거나 import 제거.

- [ ] **Step 3: End-to-end verify (실제 렌더 1회)**

```bash
cat > /tmp/shorts_remotion_smoke.mjs <<'JS'
import { renderShortsVideoRemotion } from './src/tools/shortsRenderRemotion.ts';
import fs from 'node:fs';
const dir = '/tmp/shorts_remotion_smoke'; fs.mkdirSync(dir, { recursive: true });
const scenes = [{ narration: '첫 번째 씬 내레이션입니다.', screenText: '핵심 요약 한 줄' },
                { narration: '두 번째 씬 내레이션입니다.', screenText: '두 번째 포인트' }];
const r = await renderShortsVideoRemotion(dir, scenes, [null, null], {});
console.log(JSON.stringify(r, null, 2));
JS
npx tsx /tmp/shorts_remotion_smoke.mjs
ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 /tmp/shorts_remotion_smoke/final.mp4
```
Expected: 최초 실행 시 Remotion chromium 다운로드(수십 초). `r.ok === true`, `final.mp4` 존재, `width=1080 height=1920`, duration ≈ 씬 길이 합. mp4 재생해 자막 등장·Ken Burns·프로그레스바 확인. (TTS 키 없으면 무음 mp4 + issues 에 TTS 실패 기록.)

- [ ] **Step 4: Commit**

```bash
git add src/tools/shortsRenderRemotion.ts
git commit -m "feat(shorts): Remotion Node 렌더러(에셋 스테이징 + renderMedia) — 드롭인"
```

---

### Task 6: runShortsJob 배선 + 폴백

**Files:** Modify: `src/orchestrator/shorts.ts` (renderShortsVideo 호출부 ~223행)

**Interfaces:** Consumes `renderShortsVideoRemotion`(Task 5), `renderShortsVideo`(기존), `CONFIG.shortsRenderer`(Task 2).

- [ ] **Step 1: Wire renderer selection + fallback**

`src/orchestrator/shorts.ts`:
- import 추가: `import { renderShortsVideoRemotion } from '../tools/shortsRenderRemotion';` (기존 `renderShortsVideo` 유지). `CONFIG` import 확인(없으면 `import { CONFIG } from '../config';`).
- 기존:
```ts
    const r = await renderShortsVideo(dir, plan.scenes, images, { signal: opts.signal });
```
→ 교체:
```ts
    let r = null as Awaited<ReturnType<typeof renderShortsVideo>> | null;
    if (CONFIG.shortsRenderer !== 'ffmpeg') {
      try { r = await renderShortsVideoRemotion(dir, plan.scenes, images, { signal: opts.signal }); }
      catch (e) { say(`모션 렌더 예외 → ffmpeg 폴백: ${e instanceof Error ? e.message.slice(0, 80) : e}`); r = null; }
    }
    if (!r || !r.ok) {
      if (r) say('모션 렌더 실패 → ffmpeg 슬라이드쇼로 폴백');
      r = await renderShortsVideo(dir, plan.scenes, images, { signal: opts.signal });
    }
```
- 이후 `r.sceneCount`·`r.durationSec`·`r.issues` 사용부는 그대로.

- [ ] **Step 2: Verify** — `npx tsc --noEmit; echo "tsc: $?"` → 0. `npx vitest run src/orchestrator src/tools` → PASS.

- [ ] **Step 3: Verify fallback** — `remotion/index.ts` 를 일시적으로 rename(`mv -n`) 해 `renderShortsVideoRemotion` 이 `ok:false`(엔트리 부재) 반환 → 실제 쇼츠 잡이 ffmpeg 폴백으로 `final.mp4` 산출하는지 로그·산출물 확인 후 원복. (또는 `SHORTS_RENDERER=ffmpeg` 로 강제.)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/shorts.ts
git commit -m "feat(shorts): runShortsJob Remotion 기본 + ffmpeg 폴백 배선"
```

---

### Task 7: 실제 앱 검증 (verify 스킬)

- [ ] **Step 1: 실런** — `SHORTS_RENDERER=remotion`(기본)로 실제 주제 1개 쇼츠 생성. `data/shorts/<id>/final.mp4` 가 키네틱 자막·Ken Burns·프로그레스바·오디오와 함께 나오는지 재생 확인. `index.json` stage=ready, durationSec·scenes 기록 확인.
- [ ] **Step 2: 폴백** — `SHORTS_RENDERER=ffmpeg` 로 같은 흐름 → 기존 슬라이드쇼 mp4(무중단) 확인.
- [ ] **Step 3: 최종 게이트** — `npx tsc --noEmit`(0), `npx tsc -p remotion/tsconfig.json`(0), `cd frontend && pnpm build`(성공), `npx vitest run src/tools src/orchestrator`(PASS).

---

## 완료 기준 (스펙 §10 대응)

- [ ] `SHORTS_RENDERER=remotion` 기본에서 Remotion이 1080×1920 mp4(키네틱 자막·Ken Burns·전환·오디오) 산출.
- [ ] Remotion 실패 주입 시 ffmpeg 슬라이드쇼 폴백으로 완성물 산출(무중단).
- [ ] 기존 쇼츠 파이프라인·테스트 회귀 없음. root tsc·remotion tsc·프론트 빌드 통과.
