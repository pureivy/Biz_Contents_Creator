import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CONFIG.dataDir 는 import 시점 env(GEPA_DATA_DIR)로 고정되므로 동적 import.
let tmp: string;
let mod: typeof import('./setting');

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  process.env.GEPA_DATA_DIR = tmp;
  // config 와 setting 을 env 반영 후 새로 로드(모듈 캐시 우회)
  vi.resetModules();
  mod = await import('./setting');
});

describe('voice setting', () => {
  it('파일 없으면 기본값(enabled,Yuna,autoReadFinal) 반환', () => {
    const s = mod.getVoiceSettings();
    expect(s.enabled).toBe(true);
    expect(s.ttsVoice).toBe('Yuna');
    expect(s.autoReadFinal).toBe(true);
    expect(s.sttModel).toContain('whisper');
  });

  it('setVoiceSettings 후 디스크에서 재로드해도 보존된다', () => {
    mod.setVoiceSettings({ ttsVoice: 'Sandy', autoReadFinal: false });
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'voice.json'), 'utf-8'));
    expect(onDisk.ttsVoice).toBe('Sandy');
    expect(onDisk.autoReadFinal).toBe(false);
    expect(mod.getVoiceSettings().ttsVoice).toBe('Sandy');
  });
});
