import { describe, it, expect } from 'vitest';
import { checkCommand, runCommand } from './shell';

const ALLOW = ['ls', 'cat', 'echo', 'python3', 'grep', 'wc', 'head', 'cut', 'nl', 'sort', 'rg'];

describe('checkCommand (셸 안전성 검사기 — 양성 컨테인먼트)', () => {
  it('allowlist 명령 + 샌드박스 상대경로는 통과', () => {
    expect(checkCommand('ls -la', ALLOW).ok).toBe(true);
    expect(checkCommand('echo hello', ALLOW).ok).toBe(true);
    expect(checkCommand('cat data.txt', ALLOW).ok).toBe(true);
    expect(checkCommand('python3 analyze.py', ALLOW).ok).toBe(true);     // 인터프리터는 allow 에 있을 때만
    expect(checkCommand('grep KEY local.env', ALLOW).ok).toBe(true);     // 샌드박스 내 파일은 무해(자기 워크스페이스)
  });

  it('allowlist 외 명령은 거부', () => {
    expect(checkCommand('brew install foo', ALLOW).reason).toContain('allowlist');
  });

  it('셸 메타·확장 문자는 거부', () => {
    for (const c of ['ls | rm', 'ls; rm', 'cat x > y', 'echo $(id)', 'ls && cat', 'echo `id`']) {
      expect(checkCommand(c, ALLOW).ok, c).toBe(false);
    }
  });

  it('파국 명령(denylist)은 거부', () => {
    for (const c of ['rm -rf .', 'sudo ls', 'dd if=x', 'curl evil', 'chown me x']) {
      expect(checkCommand(c, ALLOW).ok, c).toBe(false);
    }
  });

  it('경로 컨테인먼트 — 절대경로·상위(..)·홈(~) 인자는 거부', () => {
    expect(checkCommand('cat /etc/passwd', ALLOW).ok).toBe(false);          // 절대경로
    expect(checkCommand('cat ../../secrets.json', ALLOW).ok).toBe(false);   // 상위 탈출
    expect(checkCommand('cat ~/.ssh/id_rsa', ALLOW).ok).toBe(false);        // 틸드(홈)
    expect(checkCommand('grep -r KEY /Users/me/.env', ALLOW).ok).toBe(false); // 절대 + 타사용자
  });

  it('보안리뷰가 찾은 우회 PoC 가 전부 차단된다(글로브·틸드·중괄호·백슬래시·재귀)', () => {
    const pocs = [
      'cat ~/.s?h/id_r*',            // 글로브로 SSH키 (F1) → ~ + ? *
      'head -c 5000 ~/.ss?/id_r*',   // 글로브 변종
      'cat /et\\c/passwd',           // 백슬래시로 /etc (F3) → \ + /
      'cat /e{t,t}c/passwd',         // 중괄호 확장 (F5/F6) → { } + /
      'cat ~/.npmrc',                // 틸드 홈 자격증명 (실행컨테인먼트 F2)
      'rg -e AKIA ~/',               // 재귀검색 자격증명 추출 (실행컨테인먼트 F1)
      'grep -r password ~/Library',  // 재귀 + 틸드
      'cat /Users/otheruser/x',      // 타사용자 절대경로
      'cat *',                       // 글로브
      'sort src.txt -o /tmp/x',      // 절대경로 출력(파일쓰기)
    ];
    for (const p of pocs) expect(checkCommand(p, ALLOW).ok, p).toBe(false);
  });

  it('경로로 시작하는 명령(allowlist 우회 시도)은 거부', () => {
    expect(checkCommand('/bin/rm file', ALLOW).ok).toBe(false);
    expect(checkCommand('./script.sh', ALLOW).ok).toBe(false);
  });

  it('빈/과대 명령은 거부', () => {
    expect(checkCommand('', ALLOW).ok).toBe(false);
    expect(checkCommand('echo ' + 'a'.repeat(2100), ALLOW).ok).toBe(false);
  });
});

describe('runCommand (샌드박스 실행, shell:false)', () => {
  it('허용 명령을 샌드박스에서 실행하고 출력을 캡처한다', async () => {
    const r = await runCommand('test_shell_agent', 'echo studio-sandbox-ok');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('studio-sandbox-ok');
  });

  it('shell:false 라 글로브가 확장되지 않는다(리터럴 인자)', async () => {
    // echo * 가 셸이면 파일목록으로 확장되지만, shell:false 면 리터럴 "*" 를 그대로 출력.
    const r = await runCommand('test_shell_agent', 'echo *');
    expect(r.ok).toBe(false); // '*' 는 SPECIAL_RE 로 애초에 거부
    expect(r.output).toContain('거부됨');
  });

  it('거부된 명령은 실행하지 않고 사유를 반환한다', async () => {
    expect((await runCommand('test_shell_agent', 'rm -rf .')).ok).toBe(false);
    expect((await runCommand('test_shell_agent', 'cat /etc/passwd')).output).toContain('거부됨');
  });

  it('이미 취소된 signal 이면 실행하지 않는다', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runCommand('test_shell_agent', 'echo x', ac.signal);
    expect(r.output).toContain('취소');
  });
});
