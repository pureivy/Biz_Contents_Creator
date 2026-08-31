/** 로컬 STT — ffmpeg(16k mono wav) → mlx_whisper(--language ko). audio.run 캡슐화 사용. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audio } from './audio';
import { getVoiceSettings } from './setting';

export function sttAvailable(): boolean {
  return audio.which('ffmpeg') && audio.which('mlx_whisper');
}

export async function transcribe(
  input: Buffer,
  opts: { model?: string; lang?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const model = opts.model ?? getVoiceSettings().sttModel;
  const lang = opts.lang ?? 'ko';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  const inPath = path.join(dir, 'in.webm');
  const wavPath = path.join(dir, 'in.wav');
  const txtPath = path.join(dir, 'in.txt');
  try {
    fs.writeFileSync(inPath, input);
    await audio.run('ffmpeg', ['-nostdin', '-y', '-i', inPath, '-ar', '16000', '-ac', '1', wavPath],
      { signal: opts.signal, timeoutMs: 60_000 });
    await audio.run('mlx_whisper',
      [wavPath, '--language', lang, '--model', model, '--output-dir', dir, '--output-format', 'txt'],
      { signal: opts.signal, timeoutMs: 120_000 });
    return fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf-8').trim() : '';
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}
