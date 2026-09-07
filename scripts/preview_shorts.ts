/**
 * 디자인 미리보기 렌더 — 돈 안 들이고 화면만 확인한다.
 *
 *   pnpm preview                  표본 대본(연출 7종 전부, 에셋 없음)  → out/preview.mp4
 *   pnpm preview --from short_xxx 기존 쇼츠의 실제 에셋으로 재렌더      → out/preview.mp4
 *   pnpm preview --from short_xxx 내경로.mp4
 *
 * --from 이 중요하다. 표본 모드는 이미지·오디오·클립·제목이 전부 없어서(imageSrc:null) 실렌더가
 * 지나는 길의 절반만 밟는다 — staticFile <Img>, <Audio>, OffthreadVideo, 상단 캘리, 그리고
 * 작가가 실제로 쓰는 길이의 자막이 전부 빠진다. --from 은 이미 값을 치른 에셋(씬 이미지·낭독
 * mp3·I2V 클립)을 그대로 재사용하므로, API 호출 0 회로 실경로를 통째로 돌려볼 수 있다.
 *
 * 스테이징·props 조립은 실렌더와 같은 함수(stageAndBuildProps)를 부른다 — 복사본이 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';
import { RENDER_OPTS, stageAndBuildProps } from '../src/tools/shortsRenderRemotion';
import { sceneDurationSec, sceneFrames, probeDuration, varyLayout } from '../src/tools/shortsCommon';
import type { ShortsScene, PreparedScene } from '../src/tools/shortsCommon';
import { CONFIG } from '../src/config';
import { sampleProps } from '../remotion/sampleProps';

/** 기존 쇼츠 폴더에서 실렌더와 동일한 inputProps 를 복원한다(TTS·이미지 생성 없이). */
async function propsFromShort(dir: string, publicDir: string): Promise<Record<string, unknown>> {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf-8')) as { title: string; scenes: ShortsScene[] };
  const images = fs.existsSync(path.join(dir, 'scenes'))
    ? fs.readdirSync(path.join(dir, 'scenes')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    : [];
  const clipDir = path.join(dir, 'clips');

  const prepared: PreparedScene[] = [];
  let startFrame = 0;
  for (let i = 0; i < plan.scenes.length; i++) {
    const nn = String(i + 1).padStart(2, '0');
    const audio = path.join(dir, 'remotion', `narr_${nn}.mp3`);
    const audioPath = fs.existsSync(audio) ? audio : null;
    // 실렌더와 같은 길이 산식 — 낭독 길이가 씬 길이를 지배한다.
    const durationSec = sceneDurationSec(audioPath ? await probeDuration(audioPath) : 0);
    const img = images[i] ? path.join(dir, 'scenes', images[i]!) : null;
    prepared.push({
      index: i, imagePath: img, audioPath, screenText: plan.scenes[i]?.screenText ?? '',
      narration: plan.scenes[i]?.narration ?? '', durationSec, durationInFrames: sceneFrames(durationSec), startFrame,
    });
    startFrame += sceneFrames(durationSec);
  }

  const clips = plan.scenes.map((_, i) => {
    const c = path.join(clipDir, `clip_${String(i + 1).padStart(2, '0')}.mp4`);
    return fs.existsSync(c) ? c : null;
  });
  const titleArt = path.join(dir, 'title-art.png');
  const lay = varyLayout({
    bottomPct: CONFIG.shortsCaptionBottomPct, fontPx: CONFIG.shortsCaptionFontPx, hookFontPx: CONFIG.shortsCaptionHookFontPx,
    titleTopPct: CONFIG.shortsTitleTopPct, titleWidthPct: CONFIG.shortsTitleWidthPct,
  }, path.basename(dir));

  const missing = prepared.filter((p) => !p.audioPath).length;
  console.log(
    `대본 ${plan.scenes.length}씬 · 이미지 ${prepared.filter((p) => p.imagePath).length} · 낭독 ${prepared.length - missing}` +
    ` · 클립 ${clips.filter(Boolean).length} · 캘리 ${fs.existsSync(titleArt) ? 'y' : 'n'}` +
    (missing ? ` — 낭독 없는 씬 ${missing}개는 무음 3.5초로 잡힌다` : ''),
  );

  return stageAndBuildProps(publicDir, prepared, plan.scenes, {
    clips, fxSeedKey: path.basename(dir), // 실렌더와 같은 시드 — 미리보기가 실제와 다른 연출을 보여주면 안 된다
    // 실렌더와 같은 배치 산식 — 미리보기가 실제와 다른 자막 크기를 보여주면 안 된다.
    caption: {
      bottomPct: lay.bottomPct, fontPx: lay.fontPx, hookFontPx: lay.hookFontPx,
      ...(CONFIG.shortsCaptionOutline ? { outline: true } : {}),
    },
    ...(fs.existsSync(titleArt)
      ? { title: { imagePath: titleArt, topPct: lay.titleTopPct, widthPct: lay.titleWidthPct } }
      : {}),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fromIdx = argv.indexOf('--from');
  const from = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
  // fromIdx 가 -1(=--from 없음)일 때 i !== fromIdx+1 이 인덱스 0 을 걸러내던 버그 수선.
  const rest = fromIdx >= 0 ? argv.filter((_, i) => i !== fromIdx && i !== fromIdx + 1) : argv;
  const out = path.resolve(rest[0] ?? 'out/preview.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const work = path.join(path.dirname(out), '.preview');
  fs.rmSync(work, { recursive: true, force: true });
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  let inputProps: Record<string, unknown>;
  if (from) {
    const dir = fs.existsSync(from) ? from : path.join('data/shorts', from);
    if (!fs.existsSync(path.join(dir, 'plan.json'))) throw new Error(`plan.json 없음: ${dir}`);
    console.log(`실에셋 모드 — ${dir}`);
    inputProps = await propsFromShort(dir, publicDir);
  } else {
    console.log('표본 모드 — 연출 7종, 에셋 없음(--from <쇼츠ID> 로 실에셋 렌더)');
    inputProps = sampleProps as unknown as Record<string, unknown>;
  }

  const t0 = Date.now();
  // 실렌더와 같은 호출 형태 — publicDir 을 함께 넘겨야 staticFile 이 스테이징된 파일을 찾는다.
  const serveUrl = await bundle({ entryPoint: path.resolve('remotion/index.ts'), publicDir, outDir: path.join(work, 'bundle') });
  console.log(`번들 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const composition = await selectComposition({ serveUrl, id: 'AutoShorts', inputProps });
  console.log(`컴포지션 ${composition.width}x${composition.height} · ${composition.durationInFrames}프레임 · ${composition.fps}fps`);

  let last = -1;
  const t1 = Date.now();
  await renderMedia({
    serveUrl, composition, codec: 'h264', outputLocation: out, inputProps, ...RENDER_OPTS,
    onProgress: ({ progress }) => {
      const p = Math.floor(progress * 10) * 10;
      if (p > last) { last = p; console.log(`렌더 ${p}%`); }
    },
    // 폰트 로딩 실패 등 브라우저 쪽 경고를 콘솔로 끌어올린다 — 조용히 폴백되는 사고를 막는다.
    onBrowserLog: (log) => { if (log.type === 'warning' || log.type === 'error') console.log(`[브라우저 ${log.type}] ${log.text}`); },
  });
  fs.rmSync(path.join(work, 'bundle'), { recursive: true, force: true });
  console.log(`완료 ${((Date.now() - t1) / 1000).toFixed(1)}s → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)}MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
