import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneDir, pruneByPrefix } from './prune';

// 저장공간 회수(2026-08-31 사용자 확정) — 실측: 쇼츠 154건에 20G, 카드뉴스 147건에 7.5G 를 쓰고
// 디스크가 96%(여유 20G)까지 찼다. 지배 요인은 최종 산출물이 아니라 **재생성 가능한 중간물**이었다:
//   쇼츠   remotion/bundle 5.3G + remotion/public 2.9G (렌더마다 webpack 번들을 새로 구움) + clips 1.2G
//   카드뉴스 bg-retry*/bg-repair* 2.0G (실패한 재시도 잔해가 영구 보존)
// 일회성 정리로 13G 를 회수했지만, 하루 2~6세트가 계속 쌓이므로 완료 시점에 자동으로 지워야 한다.
// narr_*.mp3 는 예외 — ffmpeg 폴백이 재사용해 TTS 이중 과금을 막는다(shortsRender.ts).

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무해 */ } });

const write = (rel: string, size: number): string => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
  return p;
};

describe('pruneDir — 디렉토리 정리(보존 패턴 예외)', () => {
  it('디렉토리를 통째로 지우고 회수 바이트를 돌려준다', () => {
    write('bundle/a.js', 1000);
    write('bundle/sub/b.js', 500);
    const freed = pruneDir(path.join(tmp, 'bundle'));
    expect(freed).toBe(1500);
    expect(fs.existsSync(path.join(tmp, 'bundle'))).toBe(false);
  });

  it('keep 에 맞는 파일은 남기고 디렉토리도 유지한다', () => {
    write('remotion/bundle.js', 1000);
    write('remotion/narr_01.mp3', 300);
    write('remotion/narr_02.mp3', 200);
    const freed = pruneDir(path.join(tmp, 'remotion'), /\.mp3$/i);
    expect(freed).toBe(1000);
    expect(fs.existsSync(path.join(tmp, 'remotion', 'narr_01.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'remotion', 'narr_02.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'remotion', 'bundle.js'))).toBe(false);
  });

  it('keep 이 하나도 안 맞으면 디렉토리까지 지운다(빈 껍데기 방지)', () => {
    write('x/a.js', 100);
    pruneDir(path.join(tmp, 'x'), /\.mp3$/i);
    expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
  });

  it('없는 디렉토리는 0 — 호출부가 존재 검사를 안 해도 안전하다', () => {
    expect(pruneDir(path.join(tmp, '없음'))).toBe(0);
  });

  it('파일 경로를 줘도 터지지 않는다(fail-open — 정리는 본 작업을 깨면 안 된다)', () => {
    const f = write('a.txt', 10);
    expect(() => pruneDir(f)).not.toThrow();
  });
});

describe('pruneByPrefix — 접두사로 시작하는 형제 디렉토리 일괄 정리', () => {
  it('접두사에 맞는 디렉토리만 지운다', () => {
    write('bg/1.png', 100);
    write('bg-retry1/1.png', 200);
    write('bg-retry2/1.png', 300);
    write('bg-repair/1.png', 400);
    write('refs/1.png', 500);
    const freed = pruneByPrefix(tmp, ['bg-retry', 'bg-repair']);
    expect(freed).toBe(900);
    expect(fs.existsSync(path.join(tmp, 'bg'))).toBe(true);      // 최종 배경은 보존
    expect(fs.existsSync(path.join(tmp, 'refs'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'bg-retry1'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'bg-repair'))).toBe(false);
  });

  it('bg 는 bg-retry 접두사에 걸리지 않는다(부분 일치 오삭제 방지)', () => {
    write('bg/keep.png', 100);
    expect(pruneByPrefix(tmp, ['bg-retry'])).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'bg'))).toBe(true);
  });

  it('없는 부모 디렉토리는 0', () => {
    expect(pruneByPrefix(path.join(tmp, '없음'), ['bg-retry'])).toBe(0);
  });
});
