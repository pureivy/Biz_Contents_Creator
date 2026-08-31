/**
 * 쇼츠 렌더러 공유 상수·헬퍼 — ffmpeg 슬라이드쇼(shortsRender)와 Remotion(shortsRenderRemotion)이
 * "오디오가 길이를 지배" 불변식·SRT·길이·씬 전처리를 공유한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { synthesize } from '../voice/tts';
import { CONFIG } from '../config';

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

export type SceneKind = 'hook' | 'stat' | 'list' | 'quote' | 'chart' | 'cta';
export interface SceneKindFields {
  kind?: SceneKind;
  stat?: { value: number; unit?: string; label?: string };
  items?: string[];
  quote?: { text: string; source?: string };
  chart?: { series: Array<{ label: string; value: number }>; unit?: string; highlight?: number };
  /** CTA 결론(2026-08-28) — "조건 → 답" 쌍. 무음 시청·되감기 없는 매체라 결론은 화면에도 남겨야 한다. */
  takeaways?: Array<{ when: string; then: string }>;
}
export interface ShortsScene extends SceneKindFields { narration: string; screenText?: string }

/**
 * LLM 씬 오브젝트에서 kind·페이로드를 검증 추출 — 실패 시 {} 로 강등(fail-open, 렌더 무중단).
 * 캡: stat unit 6자·label 15자, list 2~4개·각 18자, quote text 40자·source 15자.
 */
const asText = (v: unknown): string => (typeof v === 'string' || typeof v === 'number') ? String(v).trim() : ''; // 오브젝트 등은 '' — '[object Object]' 렌더 유출 방지

/** 상한 안 마지막 공백에서 자른다(단어 경계) — 15자 하드 절단이 "재배노트"를 "재배노"로 깨던 실측 대응. */
export function cutAtWordBoundary(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sp = head.lastIndexOf(' ');
  return (sp > 0 ? head.slice(0, sp) : head).trim();
}

export function normalizeSceneKind(raw: unknown): SceneKindFields {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = String(r.kind ?? '').trim().toLowerCase();
  if (kind === 'hook') return { kind };
  // CTA 결론 카드(2026-08-28 사용자 요청) — 실측(short_6c8936f791): 내레이션은 "허리 높이면 회양목,
  // 어깨 높이 상록이면 사철나무"라고 답을 주는데 화면엔 "자리별 나무 정하기" 라벨만 떴다. 조건·답이
  // 모두 있는 쌍만 싣고, 없거나 불량이면 kind 만 남긴다(종전 동작 — CTA 씬 자체는 유지).
  if (kind === 'cta') {
    const takeaways = (Array.isArray(r.takeaways) ? r.takeaways : [])
      .map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        // when 은 시청자가 자기 상황을 찾는 조건, then 은 답 — 둘 다 있어야 화살표 표기가 성립한다.
        const when = cutAtWordBoundary(asText(o.when), 12);
        const then = cutAtWordBoundary(asText(o.then), 12);
        return when && then ? { when, then } : null;
      })
      .filter((x): x is { when: string; then: string } => !!x)
      .slice(0, 3);
    return takeaways.length ? { kind, takeaways } : { kind };
  }
  if (kind === 'stat') {
    const s = (r.stat && typeof r.stat === 'object' ? r.stat : {}) as Record<string, unknown>;
    const rawVal = asText(s.value).replace(/,/g, '').trim();
    const value = rawVal ? Number(rawVal) : NaN; // 빈 값은 Number('')=0 함정 회피 — 명시 거부
    if (!Number.isFinite(value) || Math.abs(value) >= 1e12) return {}; // 12자리+ 는 CountUp 패널 넘침 — 강등
    const unit = asText(s.unit).slice(0, 6);
    const label = asText(s.label).slice(0, 15);
    return { kind: 'stat', stat: { value, ...(unit ? { unit } : {}), ...(label ? { label } : {}) } };
  }
  if (kind === 'list') {
    const items = (Array.isArray(r.items) ? r.items : [])
      .map((x) => asText(x).slice(0, 18)).filter(Boolean).slice(0, 4);
    if (items.length < 2) return {};
    return { kind: 'list', items };
  }
  if (kind === 'quote') {
    const q = (r.quote && typeof r.quote === 'object' ? r.quote : {}) as Record<string, unknown>;
    const text = asText(q.text).slice(0, 40);
    if (!text) return {};
    const source = cutAtWordBoundary(asText(q.source), 15);
    return { kind: 'quote', quote: { text, ...(source ? { source } : {}) } };
  }
  if (kind === 'chart') {
    const c = (r.chart && typeof r.chart === 'object' ? r.chart : {}) as Record<string, unknown>;
    const series = (Array.isArray(c.series) ? c.series : [])
      .map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const rawVal = asText(o.value).replace(/,/g, '').trim();
        const value = rawVal ? Number(rawVal) : NaN;
        const label = asText(o.label).slice(0, 8);
        // 음수·비유한·12자리+ 거부(막대 좌표계·패널 넘침), 라벨 필수(축 없는 막대 무의미)
        return Number.isFinite(value) && value >= 0 && value < 1e12 && label ? { label, value } : null;
      })
      .filter((x): x is { label: string; value: number } => !!x)
      .slice(0, 5);
    if (series.length < 2 || series.every((s) => s.value === 0)) return {}; // 비교가 성립해야 차트
    const unit = asText(c.unit).slice(0, 6);
    const hi = Math.floor(Number(asText(c.highlight)));
    return {
      kind: 'chart',
      chart: { series, ...(unit ? { unit } : {}), ...(Number.isFinite(hi) && hi >= 0 && hi < series.length ? { highlight: hi } : {}) },
    };
  }
  return {};
}
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

/** 월 이름 고유어 교정(순수) — TTS 숫자 한글화 지시가 '10월'을 '십월'로 만들던 실측(2026-08-08 어휘 감사)
 *  대응. 시월·유월은 불규칙이라 프롬프트에 안 맡기고 결정적으로 치환한다. 낭독·자막 공용. */
export function fixMonthNames(s: string): string {
  return (s ?? '').replace(/십월/g, '시월').replace(/육월/g, '유월');
}

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
      // 몰아 읽기 대응(실측 2026-08-11, 30클립 중 8클립 경계 0ms): 문장·쉼표 경계 break 태그 +
      // 이웃 씬 스티칭(경계 운율 연속). 둘 다 ElevenLabs 경로 전용이라 폴백(openai/say)엔 무영향.
      const mp3 = await synthesize(sc.narration, {
        voice: opts.voice, instructions: opts.instructions ?? SHORTS_TTS_TONE,
        pauseBreaks: CONFIG.shortsTtsBreaks,
        previousText: CONFIG.shortsTtsStitch ? scenes[i - 1]?.narration : undefined,
        nextText: CONFIG.shortsTtsStitch ? scenes[i + 1]?.narration : undefined,
        signal: opts.signal,
      });
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

/** 클립 스테이징 판정 — 존재하는 클립이면 public 파일명(clip_NN.mp4), 아니면 null. 복사는 호출자. */
export function resolveClipSrc(clip: string | null | undefined, nn: string): string | null {
  return clip && fs.existsSync(clip) ? `clip_${nn}.mp4` : null;
}

// 씬 연출(fx) — AutoShorts zod 스키마와 동일 어휘. 결정적 kind 기본값(LLM 무관, 순수)이라 재현 가능.
export type SceneAccent = 'spotlight' | 'particles-leaves' | 'particles-petals' | 'particles-snow';
export interface SceneFx {
  enter?: 'none' | 'fade' | 'slide-up' | 'wipe' | 'scale';
  move?: 'zoom-in' | 'zoom-out' | 'push' | 'none';
  intensity?: 'subtle' | 'normal' | 'strong';
  accent?: SceneAccent;
}
/** 계절 파티클(순수) — 봄(3~5) 꽃잎, 가을(9~11) 낙엽, 겨울(12~2) 눈. 여름은 낙하 파티클이 부자연이라 없음. */
export function seasonalParticles(month?: number): SceneAccent | undefined {
  if (!month || month < 1 || month > 12) return undefined;
  if (month >= 3 && month <= 5) return 'particles-petals';
  if (month >= 9 && month <= 11) return 'particles-leaves';
  if (month === 12 || month <= 2) return 'particles-snow';
  return undefined;
}
/**
 * kind 기반 결정적 씬 연출(순수) — I2V 상한제로 스틸이 된 씬의 움직임 공백을 Remotion 네이티브로 메운다.
 * 클립 씬은 undefined(클립이 곧 모션 — 종전 fade 엔터 유지). 오버레이 씬(stat/list/quote)은 배경 subtle 캡
 * (패널 모션이 주인공 — 배경이 시선을 뺏지 않게), 훅은 push 강줌+스포트라이트, 본문은 strong 줌 + 엔터 변주.
 * 파티클은 런당 최대 2씬(본문 index 1 + cta) — 과장 방지 캡을 코드로 강제.
 */
export function defaultSceneFx(kind: SceneKind | undefined, index: number, hasClip: boolean, month?: number): SceneFx | undefined {
  if (hasClip) return undefined;
  if (kind === 'hook' || (index === 0 && !kind)) return { enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' };
  const seasonal = seasonalParticles(month);
  if (kind === 'stat') return { enter: 'fade', intensity: 'subtle' };
  if (kind === 'list') return { enter: 'wipe', intensity: 'subtle' };
  if (kind === 'quote') return { enter: 'scale', intensity: 'subtle' };
  if (kind === 'chart') return { enter: 'slide-up', intensity: 'subtle' };
  if (kind === 'cta') return { enter: 'fade', move: 'zoom-out', intensity: 'normal', ...(seasonal ? { accent: seasonal } : {}) };
  return { enter: index % 2 === 0 ? 'slide-up' : 'fade', intensity: 'strong', ...(seasonal && index === 1 ? { accent: seasonal } : {}) };
}
