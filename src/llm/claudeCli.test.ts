import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { ensureNeutralCwd } from './claudeCli';

// 실사고(2026-08-10 13:21): 상주 서버 가동 중 macOS 임시폴더 청소가 중립 cwd 를 지워 이후 모든
// claude spawn 이 ENOENT 로 죽었다 — Node 는 cwd 부재도 실행 파일 부재와 같은 "spawn claude ENOENT"
// 로 보고해 "CLI 설치/PATH 확인"으로 오독된다. 부팅 1회 mkdir 로는 부족하고 spawn 직전 보장이 필요.
describe('ensureNeutralCwd — 중립 cwd 자가 치유', () => {
  it('삭제된 디렉토리를 다음 호출에서 다시 만든다', () => {
    const dir = ensureNeutralCwd();
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(ensureNeutralCwd()).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
