/**
 * 쇼츠 Remotion 렌더러 — AutoShorts 컴포지션을 @remotion/renderer 로 mp4 렌더. renderShortsVideo
 * (ffmpeg 슬라이드쇼)와 동일 시그니처의 드롭인. 실패 시 호출부가 폴백한다.
 * 에셋(씬 이미지·TTS mp3)은 per-render public/ 로 스테이징해 staticFile(bare 파일명)로 참조한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, makeCancelSignal } from '@remotion/renderer';
import { prepareScenes, buildSrt, resolveClipSrc, defaultSceneFx, FPS, probeDuration } from './shortsCommon';
import type { ShortsScene, ShortsRenderResult } from './shortsCommon';

export async function renderShortsVideoRemotion(
  dir: string, scenes: ShortsScene[], images: Array<string | null>,
  opts: {
    voice?: string; instructions?: string; signal?: AbortSignal; clips?: Array<string | null>;
    /** 자막 옵션 — 위치(하단 여백 %)·키워드 강조색·검은 테두리·글자 크기(AutoShorts caption prop 으로 전달). */
    caption?: { bottomPct?: number; keyword?: string; outline?: boolean; fontPx?: number; hookFontPx?: number };
    /** 상단 제목 캘리(투명 PNG 절대경로) — public/ 로 스테이징해 전 씬 고정 오버레이. */
    title?: { imagePath: string; topPct?: number; widthPct?: number };
  } = {},
): Promise<ShortsRenderResult> {
  const entry = path.resolve('remotion/index.ts');
  if (!fs.existsSync(entry)) return { ok: false, issues: ['remotion 엔트리 부재'] };

  const work = path.join(dir, 'remotion');
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  // 1) TTS·길이
  const { prepared, issues } = await prepareScenes(work, scenes, images, opts);
  if (!prepared.length) return { ok: false, issues: [...issues, '조립할 씬 없음'] };

  // 2) 에셋 스테이징(public/) — staticFile 참조용 bare 파일명으로 복사
  const propScenes = await Promise.all(prepared.map(async (p) => {
    const nn = String(p.index + 1).padStart(2, '0');
    let imageSrc: string | null = null, audioSrc: string | null = null;
    if (p.imagePath) { const dst = `scene_${nn}${path.extname(p.imagePath) || '.png'}`; fs.copyFileSync(p.imagePath, path.join(publicDir, dst)); imageSrc = dst; }
    if (p.audioPath) { const dst = `narr_${nn}.mp3`; fs.copyFileSync(p.audioPath, path.join(publicDir, dst)); audioSrc = dst; }
    const videoSrc = resolveClipSrc(opts.clips?.[p.index], nn);
    let clipFrames: number | undefined;
    if (videoSrc) {
      const clipPath = opts.clips![p.index]!;
      fs.copyFileSync(clipPath, path.join(publicDir, videoSrc));
      // 실제 클립 길이(ffprobe)로 Loop 프레임 산정 — '모든 클립 6초' 하드코딩 가정 제거(길이 가변 시 루프 경계 프리즈/점프 방지).
      try { const d = await probeDuration(clipPath); if (d > 0) clipFrames = Math.max(1, Math.round(d * FPS)); } catch { /* 산정 실패 시 AutoShorts CLIP_FRAMES 상수 폴백 */ }
    }
    const sc = scenes[p.index];
    // 씬 연출 — 결정적 kind 기본값(스틸 씬만). 클립 씬은 undefined(클립이 곧 모션, 종전 동작).
    // month 는 렌더 시점 — 계절 파티클(봄 꽃잎/가을 낙엽/겨울 눈) 배정용.
    const fx = defaultSceneFx(sc?.kind, p.index, !!videoSrc, new Date().getMonth() + 1);
    return {
      imageSrc, audioSrc, videoSrc, screenText: p.screenText, durationInFrames: p.durationInFrames,
      ...(clipFrames ? { clipFrames } : {}),
      ...(sc?.kind ? { kind: sc.kind } : {}),
      ...(sc?.stat ? { stat: sc.stat } : {}),
      ...(sc?.items ? { items: sc.items } : {}),
      ...(sc?.quote ? { quote: sc.quote } : {}),
      ...(sc?.chart ? { chart: sc.chart } : {}),
      ...(sc?.takeaways ? { takeaways: sc.takeaways } : {}),
      ...(fx ? { fx } : {}),
    };
  }));
  const totalFrames = prepared.reduce((a, p) => a + p.durationInFrames, 0);
  // 상단 제목 캘리 스테이징 — 없거나 실패해도 렌더는 계속(오버레이만 생략)
  let titleProp: { imageSrc: string; topPct?: number; widthPct?: number } | undefined;
  if (opts.title?.imagePath && fs.existsSync(opts.title.imagePath)) {
    try {
      const dst = 'title.png';
      fs.copyFileSync(opts.title.imagePath, path.join(publicDir, dst));
      titleProp = {
        imageSrc: dst,
        ...(opts.title.topPct != null ? { topPct: opts.title.topPct } : {}),
        ...(opts.title.widthPct != null ? { widthPct: opts.title.widthPct } : {}),
      };
    } catch { /* 스테이징 실패 — 오버레이 생략 */ }
  }
  const inputProps = { scenes: propScenes, totalFrames, ...(opts.caption ? { caption: opts.caption } : {}), ...(titleProp ? { title: titleProp } : {}) };

  // 3) 번들 + 렌더
  const videoPath = path.join(dir, 'final.mp4');
  try {
    const serveUrl = await bundle({ entryPoint: entry, publicDir, outDir: path.join(work, 'bundle') });
    const composition = await selectComposition({ serveUrl, id: 'AutoShorts', inputProps });
    const { cancelSignal, cancel } = makeCancelSignal();
    if (opts.signal?.aborted) cancel();
    opts.signal?.addEventListener('abort', () => cancel());
    await renderMedia({ serveUrl, composition, codec: 'h264', outputLocation: videoPath, inputProps, cancelSignal });
  } catch (e) {
    return { ok: false, issues: [...issues, `Remotion 렌더 실패: ${e instanceof Error ? e.message.slice(0, 160) : e}`] };
  }
  // 취소 레이스 가드 — renderMedia 가 취소 직전 프레임까지 쓰고 완주해버린 경우 대비.
  if (opts.signal?.aborted) return { ok: false, issues: [...issues, '취소됨'] };

  // 4) SRT
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, buildSrt(prepared.map((p) => ({ narration: p.narration, durationSec: p.durationSec }))), 'utf-8');

  const durationSec = Math.round(prepared.reduce((a, p) => a + p.durationSec, 0) * 10) / 10;
  return { ok: true, videoPath, srtPath, durationSec, sceneCount: prepared.length, issues };
}
