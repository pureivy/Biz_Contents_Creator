/**
 * 능동 셸 실행(run_command) — connect-ai 의 <run_command> 패리티이되 **근본적으로 방어적**으로.
 *
 * connect-ai 는 시스템 디렉터리만 차단하는 관대한 모델이라 분석보고서가 ACE 리스크로 지적했다. 초기 구현은
 * '경로 블랙리스트(민감경로 정규식)'를 썼으나 적대적 보안리뷰(wf, 3 에이전트)가 글로브(`cat ~/.s?h/id_r*`)·
 * 틸드(`cat ~/.npmrc`)·백슬래시(`/et\c/passwd`)·중괄호(`/e{t,t}c`)·절대경로(`/Users/x/.pgpass`)·재귀검색
 * (`grep -r password ~`)로 전부 우회됨을 입증했다. 블랙리스트는 두더지잡기라 근본책이 아니다.
 *
 * 그래서 **양성 컨테인먼트(positive containment)** 로 전환한다:
 *   ① 이중 옵트인  : AGENT_SHELL=1(기본 off) — tool-loop 가 켜져도 셸은 별도 활성 필요.
 *   ② 자율도 게이트: WRITE_TOOL → autonomy≥2 + 명령별 승인(2=휴먼, 3=자동). → agent.ts gateWrite.
 *   ③ **shell:false**: spawn 에 셸을 안 끼워 글로브·틸드·중괄호·치환·리다이렉트·체이닝 확장이 *원천 차단*된다
 *      (인자는 전부 리터럴 argv 로 전달). 특수문자는 추가로 거부해 명령을 단순·예측가능하게 유지.
 *   ④ allowlist   : argv[0] basename 이 CONFIG.agentShellAllow 에 있을 때만(기본 읽기전용, 인터프리터 제외).
 *   ⑤ denylist    : 파국 명령(rm/dd/mkfs/sudo 등) — 운영자가 allowlist 를 넓혀도 막는 심층방어.
 *   ⑥ **경로 컨테인먼트**: 모든 인자가 절대경로(/)·홈(~)·상위(..)를 못 쓴다 → 상대경로는 샌드박스 cwd 하위로만
 *      해석되어 워크스페이스 밖 파일을 읽거나 쓸 수 없다(시스템·홈·타사용자·시크릿 전부 도달 불가).
 *   ⑦ 샌드박스 cwd: data/agents/<id>/workspace + 타임아웃 SIGKILL + 출력 30KB 하드캡(초과 시 kill) + abort 전파.
 * (잔존: 운영자가 샌드박스에 외부로의 심볼릭링크를 심으면 그 너머를 읽을 수 있음 — LLM 위협모델 밖, 운영자 책임.)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

// 셸 확장·치환·인용·체이닝 문자 — shell:false 라 대부분 무력화되지만, 명령을 단순 argv 로 유지하고
// 예측가능성·심층방어를 위해 거부한다(글로브 * ? [ ], 중괄호 { }, 틸드 ~, 치환 $ ` (), 리다이렉트 > <,
// 체이닝 ; | &, 인용 ' ", 이스케이프 \, 개행).
const SPECIAL_RE = /[;|&`$><(){}*?[\]~!#\\'"\n\r]/;
// 파국 명령(이름 기준, 대소문자 무시) — allowlist 를 운영자가 넓혀도 막는 심층방어.
const DENY_RE: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b.*\bif=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\b/i,
  /\bkillall\b/i,
  /\bcrontab\b/i,
  /\b(curl|wget)\b/i,
];

export interface CmdCheck { ok: boolean; reason?: string; bin?: string; argv?: string[]; }

/** 순수 안전성 검사 — 실행 없이 허용/거부 판정(결정적 테스트 가능). 통과 시 argv(공백분할)를 함께 반환. */
export function checkCommand(raw: string, allow: readonly string[] = CONFIG.agentShellAllow): CmdCheck {
  const cmd = (raw || '').trim();
  if (!cmd) return { ok: false, reason: '빈 명령' };
  if (cmd.length > 2000) return { ok: false, reason: '명령이 너무 깁니다(2000자 초과)' };
  if (SPECIAL_RE.test(cmd)) return { ok: false, reason: '셸 특수문자(확장·치환·인용·리다이렉트·체이닝) 비허용' };
  for (const re of DENY_RE) if (re.test(cmd)) return { ok: false, reason: `금지 명령 패턴(${re.source})` };
  const argv = cmd.split(/\s+/);
  const first = argv[0] ?? '';
  if (!first || first.includes('/')) return { ok: false, reason: '명령은 경로가 아닌 allowlist 이름으로 시작해야 함' };
  const bin = path.basename(first);
  if (!allow.includes(bin)) return { ok: false, reason: `allowlist 외 명령: ${bin}` };
  // 경로 컨테인먼트 — 절대(/)·상위(..) 인자 거부(틸드 ~ 는 SPECIAL_RE 가 이미 차단). 모든 경로가 샌드박스 하위로만.
  for (const tok of argv.slice(1)) {
    if (tok.startsWith('/')) return { ok: false, reason: `절대경로 인자 비허용(샌드박스 상대경로만): ${tok}` };
    if (tok.split('/').includes('..')) return { ok: false, reason: `상위 디렉토리(..) 인자 비허용: ${tok}` };
  }
  return { ok: true, bin, argv };
}

/** 에이전트 전용 샌드박스 작업 디렉토리(data/agents/<id>/workspace). */
export function sandboxDir(agentId: string): string {
  const safe = (agentId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const d = path.join(CONFIG.agentsDir, safe || 'unknown', 'workspace');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export interface CmdResult { ok: boolean; output: string; }

/** 검사 통과 명령을 샌드박스 cwd 에서 비동기 실행(shell:false, 비블로킹). 타임아웃 SIGKILL·출력 30KB 하드캡·abort 전파. */
export async function runCommand(agentId: string, raw: string, signal?: AbortSignal): Promise<CmdResult> {
  const chk = checkCommand(raw);
  if (!chk.ok || !chk.argv) return { ok: false, output: `(거부됨: ${chk.reason})` };
  if (signal?.aborted) return { ok: false, output: '(취소됨)' };
  const cwd = sandboxDir(agentId);
  const CAP = 30 * 1024;
  const [bin, ...args] = chk.argv;
  return new Promise<CmdResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // shell:false — 셸 미경유라 글로브·틸드·치환·체이닝이 일어나지 않는다(인자는 전부 리터럴).
      child = spawn(bin!, args, { shell: false, cwd, signal });
    } catch (e) {
      resolve({ ok: false, output: `(실행 실패: ${e instanceof Error ? e.message : String(e)})` });
      return;
    }
    let out = '';
    let done = false;
    const finish = (r: CmdResult): void => { if (!done) { done = true; resolve(r); } };
    const onData = (d: Buffer): void => {
      if (out.length >= CAP) return;
      out += d.toString('utf-8');
      if (out.length >= CAP) { out = out.slice(0, CAP); try { child.kill('SIGKILL'); } catch { /* 종료됨 */ } }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } }, CONFIG.agentShellTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      finish({ ok: false, output: e.name === 'AbortError' ? '(취소됨)' : `(실행 실패: ${e.message})` });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const body = out.slice(0, CAP).trim();
      finish({ ok: true, output: (body || '(출력 없음)') + (code ? `\n(exit ${code})` : '') });
    });
  });
}
