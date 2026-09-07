/**
 * 쇼츠 Remotion 렌더러 — AutoShorts 컴포지션을 @remotion/renderer 로 mp4 렌더. renderShortsVideo
 * (ffmpeg 슬라이드쇼)와 동일 시그니처의 드롭인. 실패 시 호출부가 폴백한다.
 * 에셋(씬 이미지·TTS mp3)은 per-render public/ 로 스테이징해 staticFile(bare 파일명)로 참조한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { pruneDir, humanBytes } from '../util/prune';
import { selectComposition, renderMedia, makeCancelSignal } from '@remotion/renderer';
import { prepareScenes, buildSrt, resolveClipSrc, defaultSceneFx, fxSeed, FPS, probeDuration } from './shortsCommon';
import type { ShortsScene, ShortsRenderResult, PreparedScene } from './shortsCommon';

/**
 * 렌더 품질·환경 옵션 — 종전엔 codec 만 넘기고 나머지를 전부 Remotion 기본값에 맡겼다.
 * 기본값이 나쁘진 않지만, 유튜브·인스타가 한 번 더 재인코딩하는 경로라 원본 쪽에서 잃은 화질은
 * 되돌릴 수 없다. 값을 못박아 Remotion 판올림에 기본값이 바뀌어도 결과가 흔들리지 않게 한다.
 */
export const RENDER_OPTS = {
  crf: 18,                      // h264 기본값과 동일 — 명시해 고정(판올림 방어)
  // Remotion 기본값과 동일 — 명시해 고정. 'slow' 도 재 보았지만 실에셋 기준 렌더 29s→35s(+21%)에
  // 파일은 35MB→34MB(-3%)라 남는 장사가 아니었다. 유튜브·인스타가 어차피 재인코딩하므로 원본
  // 파일 크기는 업로드 대역폭 말고는 의미가 없다.
  x264Preset: 'medium' as const,
  // 색공간 태깅 — 미지정(default)은 태그를 안 붙여 플레이어가 bt601 로 넘겨짚고, 그 결과 색이
  // 옅게 보인다("업로드하니 색이 죽었다"의 흔한 원인). bt709 로 명시.
  colorSpace: 'bt709' as const,
  // WebGL2 백엔드 — @remotion/effects 의 셰이더 효과에 필수다. 없으면 렌더가 첫 프레임에서
  // "Failed to acquire WebGL2 context for canvas effect" 로 죽는다(실측 2026-09-04).
  //
  // 이 줄은 한 번 뺐다가 되돌린 것이다. 2026-09-03 에 '속도가 빨라지나' 보려고 4회 측정했고
  // angle 30s / 기본 30s 로 차이가 없어 뺐다 — 그 측정 자체는 맞았다. 다만 속도만 봤을 뿐,
  // 이 설정의 진짜 용도가 '셰이더를 돌릴 수 있게 하는 것'이라는 걸 그때는 몰랐다.
  chromiumOptions: { gl: 'angle' as const },
  // delayRender 대기 상한 — 기본 30초. 씬 이미지 로딩(<Img>)에 폰트 로딩(loadFonts.ts)이 더해져
  // 여유를 둔다. 넘치면 폰트가 아니라 렌더 전체가 죽으므로 넉넉한 편이 안전하다.
  timeoutInMilliseconds: 90_000,
};


/**
 * 에셋 스테이징(public/) + AutoShorts inputProps 조립.
 *
 * staticFile 은 bare 파일명을 publicDir 기준으로 찾으므로, 씬 이미지·낭독 mp3·I2V 클립·제목
 * 캘리를 전부 그 디렉터리로 복사한 뒤 파일명만 props 에 싣는다.
 *
 * renderShortsVideoRemotion 에서 떼어낸 이유는 미리보기(scripts/preview_shorts.ts)와 공유하기
 * 위해서다. 미리보기가 이 함수를 그대로 쓰면, 거기서 잘 나온 화면은 실렌더에서도 잘 나온다.
 */
export async function stageAndBuildProps(
  publicDir: string,
  prepared: PreparedScene[],
  scenes: ShortsScene[],
  opts: {
    clips?: Array<string | null>;
    caption?: { bottomPct?: number; keyword?: string; outline?: boolean; fontPx?: number; hookFontPx?: number };
    title?: { imagePath: string; topPct?: number; widthPct?: number };
    /** 연출 변주 시드 — 보통 쇼츠 id. 편마다 다른 조합을 뽑되 재렌더에는 같은 값이 나온다. */
    fxSeedKey?: string;
    /** 룩 자리 이동 — 형제편(원편 자산 승계)에 1 을 주면 원편과 다른 색을 받는다.
     *  대본·이미지를 공유하는 사이라 색까지 같으면 두 편이 사실상 같은 영상이 된다. */
    lookOffset?: number;
  } = {},
): Promise<Record<string, unknown>> {
  fs.mkdirSync(publicDir, { recursive: true });
  // staticFile 참조용 bare 파일명으로 복사
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
    // 시드는 쇼츠 id — 편마다 연출 조합이 갈리고, 같은 편을 재조립하면 같은 화면이 나온다.
    const fx = defaultSceneFx(sc?.kind, p.index, !!videoSrc, new Date().getMonth() + 1, opts.fxSeedKey ? fxSeed(opts.fxSeedKey) : undefined);
    // 실촬영 표시 — 사용자가 올린 화면은 clips/user_NN.mp4 로 굽는다(orchestrator overlayUserVideos).
    // 이 표시를 보고 렌더러가 흑백·정지 같은 파괴적 기법을 그 씬에서 피한다.
    const realFootage = !!videoSrc && path.basename(opts.clips![p.index]!).startsWith('user_');
    return {
      imageSrc, audioSrc, videoSrc, screenText: p.screenText, durationInFrames: p.durationInFrames,
      ...(clipFrames ? { clipFrames } : {}),
      ...(realFootage ? { realFootage } : {}),
      ...(sc?.kind ? { kind: sc.kind } : {}),
      ...(sc?.stat ? { stat: sc.stat } : {}),
      ...(sc?.items ? { items: sc.items } : {}),
      ...(sc?.quote ? { quote: sc.quote } : {}),
      ...(sc?.chart ? { chart: sc.chart } : {}),
      ...(sc?.takeaways ? { takeaways: sc.takeaways } : {}),
      ...(sc?.compare ? { compare: sc.compare } : {}),
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
  const inputProps = { scenes: propScenes, totalFrames, ...(opts.fxSeedKey ? { driftSeed: opts.fxSeedKey } : {}), ...(opts.lookOffset ? { lookOffset: opts.lookOffset } : {}), ...(opts.caption ? { caption: opts.caption } : {}), ...(titleProp ? { title: titleProp } : {}) };
  return inputProps;
}

export async function renderShortsVideoRemotion(
  dir: string, scenes: ShortsScene[], images: Array<string | null>,
  opts: {
    voice?: string; instructions?: string; signal?: AbortSignal; clips?: Array<string | null>;
    elevenVoiceId?: string; elevenVoiceSettings?: Record<string, number>;
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
  // opts 에 clips 가 이미 들어 있다 — prepareScenes 가 배경 폴백 판정에 쓴다(클립이 있으면 폴백이 아니다).
  const { prepared, issues } = await prepareScenes(work, scenes, images, opts);
  if (!prepared.length) return { ok: false, issues: [...issues, '조립할 씬 없음'] };

  // 2) 에셋 스테이징 + inputProps 조립 — 미리보기 스크립트(scripts/preview_shorts.ts)와 공유한다.
  //    복사본이 아니라 같은 함수라야, 미리보기가 실렌더와 다른 길을 타는 사고가 안 난다.
  const inputProps = await stageAndBuildProps(publicDir, prepared, scenes, { ...opts, fxSeedKey: path.basename(dir) });

  // 3) 번들 + 렌더
  const videoPath = path.join(dir, 'final.mp4');
  try {
    const serveUrl = await bundle({ entryPoint: entry, publicDir, outDir: path.join(work, 'bundle') });
    const composition = await selectComposition({ serveUrl, id: 'AutoShorts', inputProps });
    const { cancelSignal, cancel } = makeCancelSignal();
    if (opts.signal?.aborted) cancel();
    opts.signal?.addEventListener('abort', () => cancel());
    let lastPct = -1;
    await renderMedia({
      serveUrl, composition, codec: 'h264', outputLocation: videoPath, inputProps, cancelSignal,
      ...RENDER_OPTS,
      // 진행 로그 — 종전엔 렌더 몇 분 동안 아무것도 안 찍혀 멈춘 건지 도는 건지 알 수 없었다. 10% 단위.
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 10) * 10;
        if (pct > lastPct) { lastPct = pct; console.log('[쇼츠]', `렌더 ${pct}%`); }
      },
    });
  } catch (e) {
    return { ok: false, issues: [...issues, `Remotion 렌더 실패: ${e instanceof Error ? e.message.slice(0, 160) : e}`] };
  }
  // 취소 레이스 가드 — renderMedia 가 취소 직전 프레임까지 쓰고 완주해버린 경우 대비.
  if (opts.signal?.aborted) return { ok: false, issues: [...issues, '취소됨'] };

  // 4) SRT
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, buildSrt(prepared.map((p) => ({ narration: p.narration, durationSec: p.durationSec }))), 'utf-8');

  const durationSec = Math.round(prepared.reduce((a, p) => a + p.durationSec, 0) * 10) / 10;
  // 번들 정리(2026-08-31) — bundle/public 은 이 렌더에서만 쓰는 webpack 산출물이라 final.mp4 가 나온
  // 뒤엔 아무도 안 읽는다. 실측: 쇼츠당 평균 65MB × 131건 = 8.2G 가 그냥 쌓여 있었다.
  // narr_*.mp3 는 남긴다 — ffmpeg 폴백이 재사용해 TTS 이중 과금을 막는다(shortsRender.ts:169).
  // clips/ 는 대상이 아니다: 재작성 경로가 씬별 클립을 재사용한다(shorts.ts:255).
  const freed = pruneDir(work, /\.mp3$/i);
  if (freed) console.log('[쇼츠]', `렌더 작업물 정리 — ${humanBytes(freed)} 회수`);
  return { ok: true, videoPath, srtPath, durationSec, sceneCount: prepared.length, issues };
}
