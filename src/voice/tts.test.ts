import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { audio } from './audio';
import { CONFIG } from '../config';
import { synthesize, listKoreanVoices, injectPauseBreaks } from './tts';

// CONFIG 는 런타임 가변 객체(readonly 는 타입 힌트일 뿐) — 테스트에서 제공자/키를 강제하고 복원한다.
const cfg = CONFIG as unknown as { ttsProvider: string; openaiApiKey: string; elevenLabsApiKey: string };
let origProvider: string;
let origKey: string;
let origElevenKey: string;
beforeEach(() => { origProvider = cfg.ttsProvider; origKey = cfg.openaiApiKey; origElevenKey = cfg.elevenLabsApiKey; });
afterEach(() => {
  cfg.ttsProvider = origProvider; cfg.openaiApiKey = origKey; cfg.elevenLabsApiKey = origElevenKey;
  vi.restoreAllMocks();
});

describe('synthesize', () => {
  it('OpenAI 경로: /v1/audio/speech 를 호출하고 mp3 버퍼를 반환한다(텍스트 정제·instructions 전달)', async () => {
    cfg.ttsProvider = 'openai';
    cfg.openaiApiKey = 'sk-test'; // getSecret 이 비어도 CONFIG 폴백으로 키 존재
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([0xFF, 0xF3, 0x00]), { status: 200 }) as unknown as Response,
    );
    const sayRun = vi.spyOn(audio, 'run');
    const buf = await synthesize('**안녕** 하세요', { instructions: '활기차게 낭독' });
    expect([...buf.subarray(0, 2)]).toEqual([0xFF, 0xF3]); // mp3 프레임 헤더
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/audio/speech');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe(CONFIG.openaiTtsModel);
    expect(body.input).not.toContain('**'); // sanitizeForTts 로 마크다운 제거
    expect(body.instructions).toBe('활기차게 낭독');
    expect(sayRun).not.toHaveBeenCalled(); // OpenAI 성공 시 say 폴백 안 함
  });

  it('ElevenLabs 경로: pauseBreaks 로 break 태그 주입, previous/next_text 는 정제해 전달한다', async () => {
    cfg.ttsProvider = 'elevenlabs';
    cfg.elevenLabsApiKey = 'el-test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([0xFF, 0xF3, 0x00]), { status: 200 }) as unknown as Response,
    );
    await synthesize('첫 문장입니다. 둘째, 문장입니다.', {
      pauseBreaks: true, previousText: '**이전** 씬', nextText: '다음 씬',
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/text-to-speech/');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.text).toContain('<break time="0.3s" />');
    expect(body.previous_text).toBe('이전 씬'); // sanitizeForTts 로 마크다운 제거
    expect(body.next_text).toBe('다음 씬');
  });

  it('ElevenLabs 경로: pauseBreaks 미지정이면 break 태그를 넣지 않는다(자비스 등 기존 호출 무영향)', async () => {
    cfg.ttsProvider = 'elevenlabs';
    cfg.elevenLabsApiKey = 'el-test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([0xFF, 0xF3, 0x00]), { status: 200 }) as unknown as Response,
    );
    await synthesize('첫 문장입니다. 둘째 문장입니다.');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.text).not.toContain('<break');
    expect(body.previous_text).toBeUndefined();
  });

  it('say 폴백: provider=say 면 say(-v voice -o aiff text)→ffmpeg(mp3) 순서로 호출한다', async () => {
    cfg.ttsProvider = 'say';
    const spy = vi.spyOn(audio, 'run').mockImplementation(async (bin, args) => {
      if (bin === 'ffmpeg') {
        const out = args[args.length - 1]!;                    // 마지막 인자 = mp3 출력경로
        fs.writeFileSync(out, Buffer.from([0x49, 0x44, 0x33])); // 'ID3'
      }
      return { stdout: Buffer.from(''), code: 0 };
    });
    const buf = await synthesize('**안녕** 하세요', { voice: 'Yuna' });
    expect(buf.subarray(0, 3).toString()).toBe('ID3');
    expect(spy.mock.calls[0]![0]).toBe('say');
    const sayArgs = spy.mock.calls[0]![1];
    expect(sayArgs).toContain('-v');
    expect(sayArgs).toContain('Yuna');
    expect(sayArgs[sayArgs.length - 1]).not.toContain('**'); // 정제됨
  });
});

describe('injectPauseBreaks', () => {
  it('문장 경계에 0.3s, 쉼표에 0.2s break 를 넣는다(끝문장 뒤는 제외)', () => {
    const t = injectPauseBreaks('묘목 고르는 눈, 계속 알려드립니다. 다음엔 순치기입니다.');
    expect(t).toContain(', <break time="0.2s" /> 계속');
    expect(t).toContain('알려드립니다. <break time="0.3s" /> 다음엔');
    expect(t.endsWith('순치기입니다.')).toBe(true); // 마지막 문장부호 뒤엔 주입 없음
  });

  it('호출당 3개 캡 — 문장 경계를 쉼표보다 먼저 배정한다(남발 시 불안정 실측 경고)', () => {
    const t = injectPauseBreaks('하나, 둘입니다. 셋, 넷입니다. 다섯, 여섯입니다. 끝, 입니다.');
    expect((t.match(/<break /g) ?? []).length).toBe(3);
    expect((t.match(/0\.3s/g) ?? []).length).toBe(3); // 문장 경계 3개가 예산 소진 → 쉼표 0개
  });

  it('이미 break 태그가 있으면 이중 주입하지 않는다', () => {
    const src = '앞 문장. <break time="1s" /> 뒤 문장.';
    expect(injectPauseBreaks(src)).toBe(src);
  });
});

describe('listKoreanVoices', () => {
  it('say -v ? 를 호출해 ko_KR 음성만 반환한다', async () => {
    vi.spyOn(audio, 'run').mockResolvedValue({
      stdout: Buffer.from('Alex  en_US  # hi\nYuna  ko_KR  # 안녕'), code: 0,
    });
    expect(await listKoreanVoices()).toContain('Yuna');
  });
});
