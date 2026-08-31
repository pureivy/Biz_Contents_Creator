/** 음성 입출력 설정 — data/voice.json 영속. runsettings.ts 패턴 복제. */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

export interface VoiceSettings {
  enabled: boolean;
  ttsVoice: string;
  sttModel: string;
  autoReadFinal: boolean;
  conversational: boolean;
}

const file = (): string => path.join(CONFIG.dataDir, 'voice.json');
let _cached: VoiceSettings | null = null;

function defaults(): VoiceSettings {
  return { enabled: true, ttsVoice: CONFIG.voiceTtsVoice, sttModel: CONFIG.voiceSttModel, autoReadFinal: true, conversational: false };
}

export function getVoiceSettings(): VoiceSettings {
  if (_cached) return _cached;
  const d = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Partial<VoiceSettings>;
    _cached = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
      ttsVoice: typeof raw.ttsVoice === 'string' && raw.ttsVoice ? raw.ttsVoice : d.ttsVoice,
      sttModel: typeof raw.sttModel === 'string' && raw.sttModel ? raw.sttModel : d.sttModel,
      autoReadFinal: typeof raw.autoReadFinal === 'boolean' ? raw.autoReadFinal : d.autoReadFinal,
      conversational: typeof raw.conversational === 'boolean' ? raw.conversational : d.conversational,
    };
  } catch {
    _cached = d;
  }
  return _cached;
}

export function setVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next: VoiceSettings = { ...getVoiceSettings(), ...patch };
  _cached = next;
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf-8');
  } catch { /* 디스크 실패해도 메모리 캐시는 유지 */ }
  return next;
}
