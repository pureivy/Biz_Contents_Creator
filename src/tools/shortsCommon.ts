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

export type SceneKind = 'hook' | 'stat' | 'list' | 'quote' | 'chart' | 'cta' | 'compare';
export interface SceneKindFields {
  kind?: SceneKind;
  stat?: { value: number; unit?: string; label?: string };
  items?: string[];
  quote?: { text: string; source?: string };
  chart?: { series: Array<{ label: string; value: number }>; unit?: string; highlight?: number };
  /** CTA 결론(2026-08-28) — "조건 → 답" 쌍. 무음 시청·되감기 없는 매체라 결론은 화면에도 남겨야 한다. */
  takeaways?: Array<{ when: string; then: string }>;
  /**
   * 대비 씬(2026-09-03) — 틀린 것과 맞는 것을 화면에서 나란히 보여준다.
   * 가리키기 도해(화살표)를 뺀 자리를 메운다: 작가는 이미지를 못 보므로 '이미지의 어디'는 못 짚지만,
   * '무엇 대신 무엇'은 원문만으로 정확히 쓸 수 있다. 위치 추측이 필요 없는 연출이다.
   */
  compare?: { bad: { label: string; note?: string }; good: { label: string; note?: string } };
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

/**
 * kind 는 선언됐는데 그 페이로드가 비어 렌더가 아무것도 못 그리는 씬(순수, 2026-09-03).
 *
 * normalizeSceneKind 는 불량 페이로드를 조용히 {kind} 로 강등한다(fail-open — 렌더 무중단이 우선).
 * 그 침묵이 실측에서 문제가 됐다: compare 도입 첫 런에서 두 작가 모두 kind 만 보내고 bad·good 을
 * 비웠는데 로그에 아무 흔적이 없어, 영상을 열어 보고서야 알았다. 지시문이 안 먹은 것을 다음 런
 * 전에 알아채려면 세어서 말해 줘야 한다.
 *
 * cta 는 제외한다 — takeaways 생략이 설계상 허용된다(조건 없는 단일 행동 결론).
 */
export function emptyKindScenes(scenes: ReadonlyArray<SceneKindFields>): Array<{ index: number; kind: SceneKind }> {
  const out: Array<{ index: number; kind: SceneKind }> = [];
  scenes.forEach((s, i) => {
    const k = s.kind;
    if (!k) return;
    const missing =
      (k === 'stat' && !s.stat) ||
      (k === 'list' && !s.items?.length) ||
      (k === 'quote' && !s.quote) ||
      (k === 'chart' && !s.chart) ||
      (k === 'compare' && !s.compare);
    if (missing) out.push({ index: i + 1, kind: k });
  });
  return out;
}

/**
 * 페이로드가 빈 kind 를 떼어 낸다(순수, 2026-09-04).
 *
 * 빈 kind 는 화면만 비는 게 아니라 그 씬을 세 군데서 잘못 대접한다.
 *  · defaultSceneFx — 카드가 있는 씬으로 보고 얌전한 움직임(CARD_*)을 준다. 카드가 없는데.
 *  · defaultSceneFx — 계절 파티클 배정에서도 빠진다(카드 씬은 액센트를 안 받는다).
 *  · selectI2vScenes — kind 있는 씬은 점수 5, 없는 씬은 60. '화면에 이미 뭔가 있으니 모션은
 *    다른 데 주자'고 판단한다. 실제로는 배경과 자막뿐인 씬이 가장 심심한 씬이 된다.
 * 그래서 못 채운 kind 는 남겨 두지 않는다 — 셋 다 거짓 전제 위에서 돌게 된다.
 *
 * hook·cta 는 대상이 아니다(emptyKindScenes 가 이미 제외한다) — 페이로드 없이도 성립하는 자리다.
 */
export function dropEmptyKinds<T extends SceneKindFields>(scenes: readonly T[]): { scenes: T[]; dropped: number[] } {
  const out = scenes.map((s) => ({ ...s }));
  const dropped: number[] = [];
  for (const e of emptyKindScenes(out)) {
    const { kind: _drop, ...rest } = out[e.index - 1]!;
    out[e.index - 1] = rest as T;
    dropped.push(e.index);
  }
  return { scenes: out, dropped };
}

/**
 * 본문 씬의 연출 적용률(순수) — 훅·CTA 를 뺀 가운데 씬 중 몇 개가 kind 를 가졌나.
 *
 * 종전 로그는 `scenes.map(s => s.kind).filter(Boolean)` 으로 전 씬을 셌는데, 훅과 CTA 는 프롬프트가
 * 항상 붙이라고 못박은 자리라 이 값은 사실상 절대 0 이 되지 않는다 — 그래서 "본문 씬 최소 1개"
 * 규칙이 지켜지는지 한 번도 확인된 적이 없었다(실측 2026-09-03: 40편 193씬 중 본문 113개가
 * kind 없이 나갔는데 로그는 매번 "연출 hook·cta" 라고만 찍혔다).
 *
 * 가장자리 판정은 위치와 kind 둘 다 본다 — 프롬프트는 씬1=hook·마지막=cta 를 요구하지만
 * 작가가 어기는 경우가 있어, 어느 쪽으로든 훅/CTA 로 보이면 본문에서 뺀다.
 */
export function bodyKindCoverage(scenes: ReadonlyArray<SceneKindFields>): { body: number; withKind: number; kinds: SceneKind[] } {
  const kinds: SceneKind[] = [];
  let body = 0;
  scenes.forEach((s, i) => {
    if (i === 0 || i === scenes.length - 1 || s.kind === 'hook' || s.kind === 'cta') return;
    body++;
    if (s.kind) kinds.push(s.kind);
  });
  return { body, withKind: kinds.length, kinds };
}

export function normalizeSceneKind(raw: unknown): SceneKindFields {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = String(r.kind ?? '').trim().toLowerCase();
  if (kind === 'hook') return { kind };
  // CTA 결론 카드(2026-08-28 사용자 요청) — 실측(short_6c8936f791): 내레이션은 "허리 높이면 회양목,
  // 어깨 높이 상록이면 사철나무"라고 답을 주는데 화면엔 "자리별 나무 정하기" 라벨만 떴다. 조건·답이
  // 모두 있는 쌍만 싣고, 없거나 불량이면 kind 만 남긴다(종전 동작 — CTA 씬 자체는 유지).
  // 대비 씬 — 양쪽이 다 있어야 성립한다(한쪽만 있으면 대비가 아니다). 불량이면 kind 만 남긴다.
  if (kind === 'compare') {
    const side = (v: unknown): { label: string; note?: string } | null => {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      const label = cutAtWordBoundary(asText(o.label), 14);
      if (!label) return null;
      const note = cutAtWordBoundary(asText(o.note), 18);
      return note ? { label, note } : { label };
    };
    const bad = side(r.bad), good = side(r.good);
    return bad && good ? { kind, compare: { bad, good } } : { kind };
  }
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
  opts: {
    voice?: string; instructions?: string; signal?: AbortSignal;
    /** 작가별 목소리(2026-09-03) — 미지정이면 전역 기본 보이스. */
    elevenVoiceId?: string; elevenVoiceSettings?: Record<string, number>;
    /** 씬별 클립(2026-09-04) — 배경 폴백 판정에만 쓴다. 클립이 있으면 이미지가 없어도 화면은 찬다. */
    clips?: Array<string | null>;
  },
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
        elevenVoiceId: opts.elevenVoiceId, elevenVoiceSettings: opts.elevenVoiceSettings,
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
    // 클립이 있으면 이미지가 없어도 화면은 영상으로 찬다 — 폴백이 아니다(2026-09-04).
    // 실촬영 씬은 이미지를 아예 안 만들므로, 이 구분이 없으면 정상 런마다 "배경 폴백"이 찍혀
    // 정작 이미지 생성이 실패했을 때 그 경보를 못 알아본다.
    const hasClip = !!opts.clips?.[i] && (() => { try { return fs.existsSync(opts.clips![i]!); } catch { return false; } })();
    if (!imagePath && !hasClip) issues.push(`씬${i + 1} 배경 폴백(그라데이션)`);
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
 * 문자열 → 안정적 정수 시드(순수). 같은 쇼츠는 언제 다시 렌더해도 같은 연출을 받는다.
 *
 * FNV-1a 뒤에 murmur3 의 마무리 혼합(fmix32)을 붙인다. FNV 만 쓰면 하위 비트가 문자열 끝쪽
 * 글자에만 좌우돼서, `"…:0"` `"…:1"` 처럼 접미사가 같은 키들이 같은 하위 비트를 받는다.
 * 실제로 그 함정에 빠졌다 — 서로 다른 쇼츠 두 편이 5개 씬 연출을 통째로 똑같이 받았다.
 */
export function fxSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
/**
 * 축별로 후보 하나를 고른다(순수). 시프트로 비트를 나눠 쓰지 않고 축마다 다시 해싱한다 —
 * 나눠 쓰면 축 하나당 2~3비트뿐이라 편이 달라도 같은 조합이 나오기 쉽다.
 */
function pick<T>(list: readonly T[], seed: number, axis: number): T {
  return list[fxSeed(`${seed}#${axis}`) % list.length]!;
}

// ── 자막·제목 배치 미세 변주(2026-09-03) ─────────────────────────────────────
// 자막 크기·위치와 상단 제목 배치가 176편 전부 같은 픽셀에 있었다. 사용자가 손보정한 값이라
// 갈아엎지 않는다 — 보정값을 중심으로 좁은 폭만 흔든다. 편끼리 프레임이 겹치지 않게 하는 게
// 목적이고, 읽기 편함은 보정값이 이미 잡아 놨다.
//
// 폭이 좁은 데는 이유가 있다. bottomPct 를 크게 흔들면 플랫폼 UI(하단 ~25%)에 자막이 먹히고,
// fontPx 를 크게 흔들면 줄바꿈이 달라져 두 줄이 세 줄이 된다.
const JITTER = { bottomPct: 3, fontPx: 3, hookFontPx: 4, titleTopPct: 2, titleWidthPct: 4 } as const;

/** 시드 기준 −n..+n 의 정수 흔들림(순수). */
function jitter(seed: number, axis: number, n: number): number {
  return (fxSeed(`${seed}~${axis}`) % (2 * n + 1)) - n;
}

/**
 * 편별 자막·제목 배치(순수). seed 가 없으면 보정값 그대로다(구 호출부·테스트 불변).
 * 하한을 두는 값들은 그 하한을 절대 안 넘는다 — 자막이 플랫폼 UI 에 먹히거나 제목이 잘리면
 * 변주의 이득보다 손해가 크다.
 */
export function varyLayout(
  base: { bottomPct: number; fontPx: number; hookFontPx: number; titleTopPct: number; titleWidthPct: number },
  seed?: string,
): { bottomPct: number; fontPx: number; hookFontPx: number; titleTopPct: number; titleWidthPct: number } {
  if (!seed) return base;
  const n = fxSeed(seed);
  return {
    bottomPct: Math.max(30, base.bottomPct + jitter(n, 0, JITTER.bottomPct)),      // 30 미만은 하단 UI 위험
    fontPx: Math.max(56, base.fontPx + jitter(n, 1, JITTER.fontPx)),
    hookFontPx: Math.max(70, base.hookFontPx + jitter(n, 2, JITTER.hookFontPx)),
    titleTopPct: Math.max(3, base.titleTopPct + jitter(n, 3, JITTER.titleTopPct)), // 3 미만은 상단 UI 에 물림
    titleWidthPct: Math.min(88, Math.max(64, base.titleWidthPct + jitter(n, 4, JITTER.titleWidthPct))),
  };
}

// ── 연출 변주표(2026-09-03) ─────────────────────────────────────────────────
// 종전엔 kind 하나에 연출 하나가 고정이었다 — 훅은 언제나 push+스포트라이트, stat 은 언제나
// fade+subtle. 편마다 같은 자리에서 같은 움직임이 나오니 여러 편을 이어 보면 한 틀에서 찍어낸
// 티가 난다. 유튜브 노출이 끊긴 뒤 '틀에서 찍어낸 티'를 줄이는 게 과제가 됐으므로, kind 별로
// '허용되는 연출 묶음'을 두고 쇼츠 id 시드로 고른다.
//
// 무작위가 아니라 시드다 — 같은 쇼츠를 재조립해도 같은 화면이 나와야 재작성 경로가 성립한다.
// 묶음 안의 후보는 전부 그 kind 에 안전한 것만 담는다(카드 씬 배경이 strong 으로 튀지 않는 등).
// 훅은 enter 를 절대 바꾸지 않는다 — 'none' 고정(2026-09-03 실사고).
// 첫 프레임이 곧 커버다: 유튜브 업로드는 extractFirstFrame 으로 프레임 0 을 커버로 지정하고
// 릴스 커버도 같은 자리를 쓴다. 그런데 'none' 을 뺀 엔터는 전부 opacity 0 에서 시작하므로
// 프레임 0 이 새까맣게 나온다. 상단 캘리는 씬 밖 오버레이라 그대로 보여서, 결과가 '검은 배경에
// 제목만' 이 된다(실측: short_1a95e1e542, 프레임 0 평균 밝기 8/255).
// 변주는 move·intensity·accent 로만 준다 — 이 셋은 프레임 0 불투명도에 영향이 없다.
const HOOK_FX: readonly SceneFx[] = [
  { enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' },
  { enter: 'none', move: 'zoom-in', intensity: 'strong', accent: 'spotlight' },
  { enter: 'none', move: 'push', intensity: 'strong' },
  { enter: 'none', move: 'zoom-out', intensity: 'strong', accent: 'spotlight' },
];
// 'wipe' 는 변주 묶음에서 뺀다(2026-09-03 실측). Series 는 씬을 겹치지 않으므로 와이프가 아직
// 안 열린 쪽에는 아무것도 없고, 루트 배경인 검정이 그대로 드러난다 — 실측에서 씬 전환 0.2초 동안
// 화면 오른쪽 절반이 순검정이었다(t=10s 우측 테두리 밝기 0.0). 전환이 아니라 결함으로 보인다.
// 스키마에는 남겨 둔다(옛 props 호환) — 자동 선택만 안 한다.
// 카드 씬 — 패널이 주인공이라 배경은 subtle~normal 로 묶는다(strong 은 시선을 뺏는다).
const CARD_ENTER: readonly NonNullable<SceneFx['enter']>[] = ['fade', 'scale', 'slide-up', 'fade'];
const CARD_MOVE: readonly NonNullable<SceneFx['move']>[] = ['zoom-in', 'zoom-out', 'none'];
const CARD_INTENSITY: readonly NonNullable<SceneFx['intensity']>[] = ['subtle', 'subtle', 'normal'];
// 본문(카드 없는) 씬 — 배경뿐이라 크게 움직여도 된다.
const BODY_ENTER: readonly NonNullable<SceneFx['enter']>[] = ['slide-up', 'fade', 'scale', 'slide-up'];
const BODY_MOVE: readonly NonNullable<SceneFx['move']>[] = ['zoom-in', 'zoom-out', 'push'];
const CTA_ENTER: readonly NonNullable<SceneFx['enter']>[] = ['fade', 'scale', 'slide-up'];

/**
 * kind 기반 씬 연출(순수) — I2V 상한제로 스틸이 된 씬의 움직임 공백을 Remotion 네이티브로 메운다.
 * 클립 씬은 undefined(클립이 곧 모션 — 종전 fade 엔터 유지).
 *
 * seed 를 주면 kind 별 허용 묶음에서 편마다 다른 조합을 고른다(편 간 판박이 제거). seed 를 안 주면
 * 종전 고정 연출 그대로다 — 구 호출부·테스트 불변.
 *
 * 파티클은 런당 최대 2씬(본문 한 곳 + cta) — 과장 방지 캡을 코드로 강제한다.
 */
export function defaultSceneFx(kind: SceneKind | undefined, index: number, hasClip: boolean, month?: number, seed?: number): SceneFx | undefined {
  if (hasClip) return undefined;
  const seasonal = seasonalParticles(month);
  if (seed === undefined) { // 종전 동작 보존
    if (kind === 'hook' || (index === 0 && !kind)) return { enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' };
    if (kind === 'stat') return { enter: 'fade', intensity: 'subtle' };
    if (kind === 'list') return { enter: 'wipe', intensity: 'subtle' };
    if (kind === 'quote') return { enter: 'scale', intensity: 'subtle' };
    if (kind === 'chart') return { enter: 'slide-up', intensity: 'subtle' };
    if (kind === 'cta') return { enter: 'fade', move: 'zoom-out', intensity: 'normal', ...(seasonal ? { accent: seasonal } : {}) };
    return { enter: index % 2 === 0 ? 'slide-up' : 'fade', intensity: 'strong', ...(seasonal && index === 1 ? { accent: seasonal } : {}) };
  }
  // 씬마다 다른 축을 쓰도록 시드에 index 를 섞는다 — 한 편 안에서도 씬끼리 같은 조합이 반복되지 않게.
  const sc = fxSeed(`${seed}:${index}`);
  if (kind === 'hook' || (index === 0 && !kind)) return pick(HOOK_FX, sc, 0);
  if (kind === 'cta') {
    return { enter: pick(CTA_ENTER, sc, 0), move: pick(['zoom-out', 'zoom-in'] as const, sc, 2), intensity: 'normal', ...(seasonal ? { accent: seasonal } : {}) };
  }
  if (kind === 'stat' || kind === 'list' || kind === 'quote' || kind === 'chart' || kind === 'compare') {
    return { enter: pick(CARD_ENTER, sc, 0), move: pick(CARD_MOVE, sc, 2), intensity: pick(CARD_INTENSITY, sc, 4) };
  }
  // 파티클은 본문 한 곳에만 — 어느 본문 씬이 걸릴지는 편마다 달라진다(종전엔 항상 index 1).
  // 반드시 편 단위 seed 로 뽑는다. 씬 단위 sc 로 뽑으면 씬마다 제각기 '내가 그 자리'라고 판단해
  // 캡이 무너진다(테스트가 실제로 2곳을 잡아냈다).
  const particleAt = 1 + (seed % 2);
  return {
    enter: pick(BODY_ENTER, sc, 0), move: pick(BODY_MOVE, sc, 2), intensity: 'strong',
    ...(seasonal && index === particleAt ? { accent: seasonal } : {}),
  };
}
