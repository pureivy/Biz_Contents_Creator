/**
 * TTS — 기본은 OpenAI(gpt-4o-mini-tts, 자연스러운 신경망 음성), 폴백은 macOS say(로컬).
 * OpenAI 경로는 mp3 를 바로 반환(ffmpeg 불필요). 키가 없거나 호출 실패 시 say 로 우아하게 폴백해
 * 자비스 음성 응답·숏폼 내레이션이 끊기지 않는다. gpt-4o-mini-tts 는 instructions 로 낭독 톤을 지시할 수 있어
 * 숏폼은 활기찬 톤을, 자비스는 차분한 톤을 넘긴다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config';
import { getSecret } from '../secrets/store';
import { audio, sanitizeForTts, parseSayVoices } from './audio';
import { getVoiceSettings } from './setting';

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

/** 라이브 OpenAI 키(시크릿 스토어 우선, 시작 시 env 폴백). */
function openaiKey(): string {
  return getSecret('OPENAI_API_KEY') || CONFIG.openaiApiKey || '';
}

/** 라이브 ElevenLabs 키(시크릿 스토어 우선, 시작 시 env 폴백). */
function elevenLabsKey(): string {
  return getSecret('ELEVENLABS_API_KEY') || CONFIG.elevenLabsApiKey || '';
}

function sayAvailable(): boolean {
  return audio.which('say') && audio.which('ffmpeg');
}

/** TTS 가용 여부 — ElevenLabs·OpenAI 키가 있거나(say 불필요) macOS say+ffmpeg 가 있으면 true. */
export function ttsAvailable(): boolean {
  return !!elevenLabsKey() || !!openaiKey() || sayAvailable();
}

export async function listKoreanVoices(): Promise<string[]> {
  try {
    const r = await audio.run('say', ['-v', '?'], { timeoutMs: 10_000 });
    return parseSayVoices(r.stdout.toString('utf-8'));
  } catch { return []; }
}

/** OpenAI TTS(/v1/audio/speech) → mp3 Buffer. instructions 로 낭독 톤 지시(gpt-4o-mini-tts). */
async function synthesizeOpenAI(
  text: string, opts: { voice?: string; instructions?: string; signal?: AbortSignal },
): Promise<Buffer> {
  const key = openaiKey();
  if (!key) throw new Error('OPENAI_API_KEY 없음');
  const body: Record<string, unknown> = {
    model: CONFIG.openaiTtsModel,
    voice: opts.voice || CONFIG.openaiTtsVoice, // OpenAI 음색(nova 등) — macOS 음색명(Yuna)은 무시
    input: text,
    response_format: 'mp3',
  };
  if (opts.instructions) body.instructions = opts.instructions; // 톤·속도·감정 지시(모델이 무시해도 무해)
  const r = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * 문장·쉼표 경계에 ElevenLabs <break time> 태그 주입(순수) — multilingual v2 가 문장부호 쉼을
 * 확률적으로 무시하고 몰아 읽는 실측(2026-08-11, 최근 5편 30클립 중 8클립에서 쉼표·마침표 경계 간격
 * 0ms, 최대 17어절 8.4초 통독) 대응. 시간값은 정상 낭독 실측 중앙값(마침표 359ms·쉼표 159ms)에 맞춤.
 * 공식 문서가 한 생성에 break 남발 시 가속·노이즈 불안정을 경고하므로 호출당 maxBreaks(기본 3)로 캡
 * — 문장 경계를 쉼표보다 먼저 배정한다(통독 붕괴가 더 큰 쪽). ElevenLabs 전용 마크업이라
 * openai/say 폴백 경로에는 절대 넣지 않는다(태그가 그대로 낭독됨).
 */
export function injectPauseBreaks(text: string, maxBreaks = 3): string {
  if (!text || text.includes('<break')) return text;
  let n = 0;
  let t = text.replace(/([.!?…]+)\s+(?=\S)/g, (m, p: string) =>
    n < maxBreaks ? (n++, `${p} <break time="0.3s" /> `) : m);
  t = t.replace(/,\s+(?=\S)/g, (m) =>
    n < maxBreaks ? (n++, ', <break time="0.2s" /> ') : m);
  return t;
}

/**
 * ElevenLabs TTS(/v1/text-to-speech/{voice_id}) → mp3 Buffer. 음성은 voice_id 로 지정(음색 자체가 캐릭터).
 * output_format=mp3_44100_128, model 은 CONFIG.elevenLabsModel(기본 eleven_multilingual_v2, 한국어 지원).
 * OpenAI 의 instructions 같은 자유 톤 지시는 없음 — 선택한 voice_id 가 낭독 캐릭터를 담는다.
 * previous/next_text 는 세그먼트(씬) 분할 합성의 경계 운율 연속용 — 오독 교정용으로는 실측 무효였으나
 * (audio.ts 잎 보정 주석) 운율 스티칭은 별개 용도로 공식 문서가 권장한다.
 */
async function synthesizeElevenLabs(
  text: string,
  opts: { voiceId?: string; pauseBreaks?: boolean; previousText?: string; nextText?: string; signal?: AbortSignal },
): Promise<Buffer> {
  const key = elevenLabsKey();
  if (!key) throw new Error('ELEVENLABS_API_KEY 없음');
  const voiceId = opts.voiceId || CONFIG.elevenLabsVoiceId;
  const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  // 낭독 속도 — voice_settings.speed(1.0 기본, >1.0 빠르게). 1.0 이면 생략(음성 기본 설정 유지).
  const body: Record<string, unknown> = {
    text: opts.pauseBreaks ? injectPauseBreaks(text) : text,
    model_id: CONFIG.elevenLabsModel,
  };
  if (opts.previousText) body.previous_text = opts.previousText;
  if (opts.nextText) body.next_text = opts.nextText;
  if (CONFIG.elevenLabsSpeed !== 1.0) body.voice_settings = { speed: CONFIG.elevenLabsSpeed };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(`ElevenLabs TTS ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** macOS say(-v <voice> -o aiff) → ffmpeg(mp3). OpenAI 미가용 시 폴백. */
async function synthesizeSay(text: string, voice: string, signal?: AbortSignal): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const aiff = path.join(dir, 'out.aiff');
  const mp3 = path.join(dir, 'out.mp3');
  try {
    // '--' 로 옵션 종료 — text 가 '-' 로 시작해도 say 플래그(임의 파일 읽기·쓰기)로 해석되지 않게(보안점검).
    await audio.run('say', ['-v', voice, '-o', aiff, '--', text], { signal, timeoutMs: 60_000 });
    await audio.run('ffmpeg', ['-nostdin', '-y', '-i', aiff, '-f', 'mp3', mp3], { signal, timeoutMs: 60_000 });
    return fs.readFileSync(mp3);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

/**
 * 텍스트 → mp3. 기본 OpenAI(자연스러운 음성), 실패·키없음 시 macOS say 폴백.
 * @param opts.openaiVoice OpenAI 음색 오버라이드(미지정 시 CONFIG.openaiTtsVoice)
 * @param opts.instructions gpt-4o-mini-tts 낭독 톤 지시(예: 숏폼 활기찬 톤)
 * @param opts.voice macOS say 폴백 음색(미지정 시 설정값)
 */
export async function synthesize(
  text: string,
  opts: {
    voice?: string; openaiVoice?: string; elevenVoiceId?: string; instructions?: string;
    /** ElevenLabs 전용 — 문장·쉼표 경계 break 태그 주입(몰아 읽기 대응). 폴백 경로엔 미적용. */
    pauseBreaks?: boolean;
    /** ElevenLabs 전용 — 이웃 세그먼트 텍스트 스티칭(경계 운율 연속). 낭독되지 않는다. */
    previousText?: string; nextText?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  const clean = sanitizeForTts(text);
  if (!clean) throw new Error('낭독할 텍스트가 비어 있음');

  // 폴백 체인: elevenlabs → openai → say. 각 단계는 키/가용성이 없거나 실패하면 다음으로 넘어간다
  // (취소는 폴백하지 않음). 숏폼 내레이션·자비스 음성이 한 제공자 장애로 끊기지 않게 한다.
  const wantEleven = CONFIG.ttsProvider === 'elevenlabs' && !!elevenLabsKey();
  if (wantEleven) {
    try {
      return await synthesizeElevenLabs(clean, {
        voiceId: opts.elevenVoiceId,
        pauseBreaks: opts.pauseBreaks,
        previousText: opts.previousText ? sanitizeForTts(opts.previousText) : undefined,
        nextText: opts.nextText ? sanitizeForTts(opts.nextText) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (!openaiKey() && !sayAvailable()) throw e;   // 폴백 불가면 원 오류 노출
      // ElevenLabs 실패(키·레이트·네트워크) → openai/say 로 폴백
    }
  }

  const wantOpenAI = CONFIG.ttsProvider !== 'say' && !!openaiKey();
  if (wantOpenAI) {
    try {
      return await synthesizeOpenAI(clean, { voice: opts.openaiVoice, instructions: opts.instructions, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) throw e;           // 취소는 폴백하지 않음
      if (!sayAvailable()) throw e;                // 폴백 불가면 원 오류 노출
      // OpenAI 실패(레이트·네트워크 등) → say 로 폴백(자비스·숏폼 무중단)
    }
  }
  return synthesizeSay(clean, opts.voice ?? getVoiceSettings().ttsVoice, opts.signal);
}
