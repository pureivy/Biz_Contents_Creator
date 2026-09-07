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

// 실사고(2026-08-31 08:55~10:55): 데스크탑 런처(scripts/launcher/start.sh)로 띄운 서버의 PATH 에
// ~/.local/bin 이 없어 spawn('claude') 이 전부 ENOENT — 오토런 틱이 2시간 동안 "처리할 작업 없음"만
// 남기고 침묵했다(proposeContentIdeas 가 microJSON 실패를 삼키고 무로그 return null). LaunchServices
// 경유 부팅은 PATH 가 /usr/bin:/bin:/usr/sbin:/sbin 로 축소되므로 spawn PATH 를 코드에서 보강한다.
describe('cliSearchPath — spawn PATH 보강(런처 축소 PATH 방어)', () => {
  it('축소된 PATH 에 표준 사용자 bin 을 덧붙인다', async () => {
    const { cliSearchPath } = await import('./claudeCli');
    const out = cliSearchPath('/usr/bin:/bin', '/Users/tester').split(':');
    expect(out).toContain('/Users/tester/.local/bin');
    expect(out).toContain('/opt/homebrew/bin');
    expect(out).toContain('/usr/local/bin');
  });

  it('기존 PATH 항목과 그 순서를 앞쪽에 그대로 보존한다(보강은 뒤에만)', async () => {
    const { cliSearchPath } = await import('./claudeCli');
    const out = cliSearchPath('/first:/second', '/Users/tester').split(':');
    expect(out.slice(0, 2)).toEqual(['/first', '/second']);
  });

  it('이미 있는 디렉토리는 중복 추가하지 않는다', async () => {
    const { cliSearchPath } = await import('./claudeCli');
    const out = cliSearchPath('/Users/tester/.local/bin:/usr/bin', '/Users/tester').split(':');
    expect(out.filter((p) => p === '/Users/tester/.local/bin')).toHaveLength(1);
  });

  it('빈 PATH 여도 보강 목록만으로 유효한 경로를 만든다', async () => {
    const { cliSearchPath } = await import('./claudeCli');
    const out = cliSearchPath('', '/Users/tester').split(':').filter(Boolean);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('/Users/tester/.local/bin');
  });
});

// 무음 실패 방지 — CLI 를 못 찾는 상태로 뜨면 부팅 로그에서 즉시 드러나야 한다(위 실사고의 2차 원인).
describe('claudeCliProblem — 부팅 점검', () => {
  it('PATH 어디에도 없는 실행 파일이면 사유 문자열을 돌려준다', async () => {
    const { claudeCliProblem } = await import('./claudeCli');
    expect(claudeCliProblem('claude-does-not-exist-xyz', '/nonexistent-dir')).toMatch(/PATH/);
  });

  it('존재하는 절대 경로면 null(문제 없음)', async () => {
    const { claudeCliProblem } = await import('./claudeCli');
    expect(claudeCliProblem('/bin/sh', '')).toBeNull();
  });

  it('없는 절대 경로면 사유를 돌려준다', async () => {
    const { claudeCliProblem } = await import('./claudeCli');
    expect(claudeCliProblem('/nonexistent/claude', '')).toBeTruthy();
  });
});
