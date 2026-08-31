import { describe, it, expect, afterEach, vi } from 'vitest';
import { app } from '../server/main';
import { audio } from './audio';

afterEach(() => vi.restoreAllMocks());

describe('voice endpoints', () => {
  it('POST /voice/tts — 빈 텍스트는 400(가용할 때)', async () => {
    vi.spyOn(audio, 'which').mockReturnValue(true);   // ttsAvailable() -> true
    const res = await app.request('/voice/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /voice/voices — available/voices/defaultVoice 형태 반환', async () => {
    vi.spyOn(audio, 'which').mockReturnValue(true);
    vi.spyOn(audio, 'run').mockResolvedValue({ stdout: Buffer.from('Yuna  ko_KR  # 안녕'), code: 0 });
    const res = await app.request('/voice/voices');
    const j = await res.json() as { available: boolean; sttAvailable: boolean; ttsAvailable: boolean; voices: string[]; defaultVoice: string; conversational: boolean };
    expect(j.available).toBe(true);
    expect(j.sttAvailable).toBe(true);
    expect(j.ttsAvailable).toBe(true);
    expect(j.voices).toContain('Yuna');
    expect(typeof j.defaultVoice).toBe('string');
    expect(typeof j.conversational).toBe('boolean');
  });
});
