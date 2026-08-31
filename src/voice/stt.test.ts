import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { audio } from './audio';
import { transcribe } from './stt';

afterEach(() => vi.restoreAllMocks());

describe('transcribe', () => {
  it('ffmpeg→mlx_whisper 순서로 호출하고 출력 txt 를 읽어 반환한다', async () => {
    const spy = vi.spyOn(audio, 'run').mockImplementation(async (bin, args) => {
      if (bin === 'mlx_whisper') {
        // --output-dir <dir> 다음 인자가 출력 폴더, 입력 wav 의 base.txt 를 모사 생성
        const dir = args[args.indexOf('--output-dir') + 1]!;
        const wav = args[0]!;
        const base = path.basename(wav).replace(/\.[^.]+$/, '');
        fs.writeFileSync(path.join(dir, `${base}.txt`), '안녕하세요 테스트 전사입니다');
      }
      return { stdout: Buffer.from(''), code: 0 };
    });
    const text = await transcribe(Buffer.from('fake-webm'), { model: 'm', lang: 'ko' });
    expect(text).toBe('안녕하세요 테스트 전사입니다');
    const bins = spy.mock.calls.map((c) => c[0]);
    expect(bins).toEqual(['ffmpeg', 'mlx_whisper']);
    const mlxArgs = spy.mock.calls[1]![1];
    expect(mlxArgs).toContain('--language');
    expect(mlxArgs).toContain('ko');
  });

  it('빈 전사 결과는 빈 문자열로 반환한다', async () => {
    vi.spyOn(audio, 'run').mockImplementation(async (bin, args) => {
      if (bin === 'mlx_whisper') {
        const dir = args[args.indexOf('--output-dir') + 1]!;
        const base = path.basename(args[0]!).replace(/\.[^.]+$/, '');
        fs.writeFileSync(path.join(dir, `${base}.txt`), '   \n');
      }
      return { stdout: Buffer.from(''), code: 0 };
    });
    expect(await transcribe(Buffer.from('x'))).toBe('');
  });
});
