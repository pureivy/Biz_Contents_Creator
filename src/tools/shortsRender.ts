/**
 * 숏폼 렌더러 — 씬 이미지 + TTS 내레이션 + 자막을 ffmpeg 로 세로(1080×1920) MP4 로 조립.
 *
 * 설계(참고 자산 이식 근거):
 *  - 내레이션은 TTS(voice/tts synthesize — OpenAI gpt-4o-mini-tts 기본, 실패 시 macOS say 폴백) →
 *    씬 길이는 오디오 실측(ffprobe). 숏폼 톤(활기·빠른 템포)은 instructions 로 전달
 *  - 화면 텍스트는 Pillow(shorts_frame.py)로 프레임에 미리 굽는다 — 홈브류 ffmpeg 가 drawtext
 *    (freetype) 없이 빌드돼 있어(실측 'No such filter') 자막 필터를 쓸 수 없고, AI 이미지에
 *    글자를 맡기지도 않는다(오타 원천 차단)
 *  - 출력은 H.264 + AAC(참고 프로젝트 사운드 감독 규칙), 씬별 세그먼트 → concat demuxer(-c copy)
 *  - 씬 이미지에 느린 줌(zoompan ~1.10)으로 정지화면 지루함 완화 — 프레임을 1.5배(1620×2880)로
 *    렌더해 줌 다운스케일 후에도 텍스트가 선명
 *  - 씬 이미지 누락 시 그라데이션 폴백(내러티브 순서 보존 — 장 스킵 대신 배경만 대체)
 *  - BGM 은 로컬 음악 생성 모델이 없어 미탑재. 추후 추가 시 내레이션 100%·BGM 30% 볼륨 규칙 적용.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from '../config';
import { synthesize } from '../voice/tts';
import {
  FPS, W, H, FRAME_W, FRAME_H,
  type ShortsScene, type ShortsRenderResult, sceneDurationSec, sceneFrames, fmtSrtTime, probeDuration, SHORTS_TTS_TONE,
} from './shortsCommon';

export type { ShortsScene, ShortsRenderResult } from './shortsCommon';

const execFileP = promisify(execFile);

async function ff(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await execFileP('ffmpeg', ['-nostdin', '-y', ...args], { timeout: timeoutMs, signal, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * 숏폼 썸네일 — final.mp4 의 훅 프레임(≈1s, 페이드인 이후·제목이 이미 구워진 첫 장면)을 dir/thumbnail.jpg 로 1장 추출.
 * 이미 있으면 그대로 반환. 영상 없으면 null. 스튜디오 카드 포스터·다운로드용(발행엔 미사용). best-effort — 실패는 null.
 */
export async function ensureShortsThumbnail(dir: string, signal?: AbortSignal): Promise<string | null> {
  const thumb = path.join(dir, 'thumbnail.jpg');
  // 이미 있으면 그대로 사용 — 디자인 썸네일(완성부 gpt-image)을 프레임으로 덮어쓰지 않는다.
  // 재렌더 시엔 완성부가 디자인 썸네일을 새로 덮어쓴다(이 함수는 폴백 전용).
  if (fs.existsSync(thumb)) return thumb;
  const video = path.join(dir, 'final.mp4');
  if (!fs.existsSync(video)) return null;
  try {
    await ff(['-ss', '1', '-i', video, '-frames:v', '1', '-vf', 'scale=-2:720', '-q:v', '4', thumb], 20_000, signal);
    return fs.existsSync(thumb) ? thumb : null;
  } catch { return fs.existsSync(thumb) ? thumb : null; } // 렌더 폴백처럼 무해 — 없으면 포스터 없이 진행
}

/**
 * 업로드용 커버 — 업로드할 영상의 첫 프레임(인트로가 있으면 그게 곧 디자인 썸네일)을 jpg 로 추출.
 * 유튜브는 썸네일 미지정 시 중간 프레임을 자동 선택하므로(실측 2026-07-22), '영상 맨 처음이 보이게'
 * 첫 프레임을 thumbnails.set 에 쓴다. 임시파일+rename(원자적). 실패 시 null(썸네일 미지정 폴백).
 */
export async function extractFirstFrame(videoPath: string, outPath: string, signal?: AbortSignal): Promise<string | null> {
  if (!fs.existsSync(videoPath)) return null;
  const tmp = `${outPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  try {
    await ff(['-i', videoPath, '-frames:v', '1', '-q:v', '3', tmp], 20_000, signal);
    fs.renameSync(tmp, outPath);
    return outPath;
  } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* 무해 */ } return null; }
}

/**
 * 다운로드용 — 디자인 썸네일을 영상 앞 1.6초 인트로로 붙인 dir/download.mp4(캐시). 썸네일 없으면 원본 그대로.
 * 썸네일(2:3)은 9:16 프레임에 레터박스(검정 여백)로 넣고 인트로 구간은 무음. 원본·썸네일 갱신 시 재생성.
 * 실패하면 원본 final.mp4 경로 반환(인트로 없이 폴백). 오디오는 44100·스테레오·fltp 로 정규화해 concat 안정화.
 */
export async function ensureShortsDownload(dir: string, signal?: AbortSignal): Promise<string | null> {
  const video = path.join(dir, 'final.mp4');
  if (!fs.existsSync(video)) return null;
  const thumb = path.join(dir, 'thumbnail.jpg');
  if (!fs.existsSync(thumb)) return video; // 썸네일 없으면 인트로 불가 → 원본
  const out = path.join(dir, 'download.mp4');
  if (fs.existsSync(out)) { // 캐시 신선도 — 원본·썸네일보다 최신이면 재사용
    try {
      const ot = fs.statSync(out).mtimeMs;
      if (ot >= fs.statSync(video).mtimeMs && ot >= fs.statSync(thumb).mtimeMs) return out;
    } catch { /* 재생성 */ }
  }
  const tmp = path.join(dir, `.download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  const fc =
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p[intro];` +
    `[1:v]scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[main];` +
    `[intro][main]concat=n=2:v=1:a=0[v];` +
    `anullsrc=channel_layout=stereo:sample_rate=44100:d=1.6,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100[sil];` +
    `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100[maina];` +
    `[sil][maina]concat=n=2:v=0:a=1[a]`;
  try {
    await ff(['-loop', '1', '-t', '1.6', '-i', thumb, '-i', video, '-filter_complex', fc,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', tmp],
      300_000, signal);
    fs.renameSync(tmp, out);
    return out;
  } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* 무해 */ } return video; } // 실패 시 원본(인트로 없이)
}

/** 릴스(메타) 업로드용 영상 — fal 스토리지 단건 한도 초과 시(실측 2026-08-13: 93초 I2V 다수 편성
 *  final.mp4 102MB → HTTP 413) CRF 재인코딩 사본(meta.mp4)을 만들어 돌려준다. 인트로는 붙이지
 *  않는다(인트로는 유튜브 커버용 — 릴스는 원본 그대로). 캐시 신선도는 원본 mtime 기준. */
export const META_UPLOAD_LIMIT_BYTES = 95 * 1024 * 1024; // fal 한도(~100MB 추정) 아래 여유
export async function ensureMetaVideo(dir: string, signal?: AbortSignal): Promise<string | null> {
  const video = path.join(dir, 'final.mp4');
  if (!fs.existsSync(video)) return null;
  if (fs.statSync(video).size <= META_UPLOAD_LIMIT_BYTES) return video;
  const out = path.join(dir, 'meta.mp4');
  if (fs.existsSync(out)) {
    try { if (fs.statSync(out).mtimeMs >= fs.statSync(video).mtimeMs) return out; } catch { /* 재생성 */ }
  }
  const tmp = path.join(dir, `.meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  try {
    await ff(['-i', video, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], 600_000, signal);
    fs.renameSync(tmp, out);
    return out;
  } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* 무해 */ } return video; } // 재인코딩 실패 시 원본으로 시도
}

/**
 * 씬 배열 → dir/final.mp4 + subtitles.srt. images[i] 는 씬 i 의 배경(없으면 null → 단색 폴백).
 * 개별 씬 실패는 이슈로 기록하고 해당 씬을 단색 배경·무음으로라도 완성(전체 실패 방지).
 */

/**
 * 폴백 제목 오버레이 필터(순수) — Remotion 실패 시 상단 제목이 통째로 사라지던 실측(2026-08-08 참나무
 * 쇼츠) 대응. Remotion TitleOverlay 와 동일 기하: 폭 widthPct%·높이 상한 26%(contain)·상단 topPct%·
 * 상단 중앙 정렬. drop-shadow 는 폴백에선 생략(비상 경로 절충 — 캘리 자체 윤곽으로 시인).
 */
export function titleOverlayFilter(widthPct: number, topPct: number): string {
  const w = Math.floor(W * (widthPct / 100));
  const h = Math.floor(H * 0.26);
  const y = Math.floor(H * (topPct / 100));
  return `[1:v]scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease[t];[0:v][t]overlay=x=(W-w)/2:y=${y}`;
}

export async function renderShortsVideo(
  dir: string, scenes: ShortsScene[], images: Array<string | null>,
  opts: {
    voice?: string; instructions?: string; signal?: AbortSignal;
    /** 상단 제목 캘리(투명 PNG) — Remotion 경로와 동일 형태. 폴백에서도 제목이 사라지지 않게(2026-08-08). */
    title?: { imagePath: string; topPct?: number; widthPct?: number };
  } = {},
): Promise<ShortsRenderResult> {
  const issues: string[] = [];
  if (!CONFIG.blogPython || !fs.existsSync(CONFIG.blogPython)) {
    return { ok: false, issues: ['BLOG_PYTHON 미설정 — 씬 프레임(Pillow) 합성 불가'] };
  }
  const frameScript = path.join(CONFIG.blogScriptsDir, 'shorts_frame.py');
  const segDir = path.join(dir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });

  const segFiles: string[] = [];
  const srtLines: string[] = [];
  let clock = 0;

  for (let i = 0; i < scenes.length; i++) {
    if (opts.signal?.aborted) throw new Error('취소됨');
    const scene = scenes[i]!;
    const nn = String(i + 1).padStart(2, '0');

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
      issues.push(`씬${i + 1} TTS 실패(무음 진행): ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
    const dur = sceneDurationSec(audioDur);
    const frames = sceneFrames(dur);

    // 2) 씬 프레임 합성(Pillow) — 배경 커버핏 + 화면 텍스트 굽기(이미지 누락 시 그라데이션 폴백)
    const img = images[i] && fs.existsSync(images[i]!) ? images[i]! : '';
    if (!img) issues.push(`씬${i + 1} 배경 폴백(그라데이션)`);
    const framePath = path.join(segDir, `frame_${nn}.png`);
    await execFileP(CONFIG.blogPython, [frameScript,
      '--image', img, '--text', (scene.screenText ?? '').trim(), '--index', String(i),
      '--output', framePath, '--width', String(FRAME_W), '--height', String(FRAME_H)],
      { timeout: 60_000, signal: opts.signal });

    // 3) 세그먼트 — 느린 줌(zoompan) + 내레이션. 프레임이 이미 목표 비율이라 스케일 불필요.
    const seg = path.join(segDir, `seg_${nn}.mp4`);
    const audioArgs = audioPath
      ? ['-i', audioPath]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
    await ff([
      '-i', framePath, ...audioArgs,
      '-filter_complex',
      `[0:v]zoompan=z='min(zoom+0.0006,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}[v];[1:a]apad[a]`,
      '-map', '[v]', '-map', '[a]',
      '-t', dur.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      seg,
    ], 120_000, opts.signal);
    segFiles.push(seg);

    srtLines.push(`${i + 1}`, `${fmtSrtTime(clock)} --> ${fmtSrtTime(clock + dur)}`, scene.narration, '');
    clock += dur;
  }

  if (!segFiles.length) return { ok: false, issues: [...issues, '조립할 씬 없음'] };

  // 3) concat(-c copy — 전 세그먼트 동일 파라미터) + srt
  const listPath = path.join(segDir, 'concat.txt');
  fs.writeFileSync(listPath, segFiles.map((f) => `file '${f}'`).join('\n'), 'utf-8');
  const videoPath = path.join(dir, 'final.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', videoPath], 60_000, opts.signal);

  // 상단 제목 오버레이(1패스 재인코딩) — Remotion 실패 폴백에서도 제목이 사라지지 않게(실측 2026-08-08).
  // 실패는 무해(이슈 기록 후 무제목 영상 유지 — 종전 동작).
  if (opts.title?.imagePath && fs.existsSync(opts.title.imagePath)) {
    try {
      const titled = path.join(segDir, 'final-titled.mp4');
      await ff([
        '-i', videoPath, '-i', opts.title.imagePath,
        '-filter_complex', titleOverlayFilter(opts.title.widthPct ?? 74, opts.title.topPct ?? 5),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        titled,
      ], 180_000, opts.signal);
      fs.renameSync(titled, videoPath);
    } catch (e) {
      issues.push(`제목 오버레이 실패(무제목 유지): ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, srtLines.join('\n'), 'utf-8');

  return { ok: true, videoPath, srtPath, durationSec: Math.round(clock * 10) / 10, sceneCount: scenes.length, issues };
}
