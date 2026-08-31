/**
 * Claude Code CLI 클라이언트 — 구독(OAuth) 인증으로 Claude 호출. 기존 ChatParams→ChatResult 계약 구현.
 *
 * 왜 CLI 경유인가: Anthropic SDK 직접 호출(구 llm/anthropic.ts)은 ant OAuth 프로필/API 키 경유로
 * 조직의 API 크레딧에 과금된다(크레딧 소진 시 400). `claude -p` 는 Claude Code 구독 로그인으로
 * 과금(정액) — 이 스튜디오의 전제와 일치. 대신 호출당 CLI 부팅 오버헤드(~1.5s)와 구독 rate limit
 * (5시간 윈도, Claude Code 대화 세션과 쿼터 공유)을 감수한다.
 *
 * 격리 플래그(실측: 하니스 컨텍스트 31K→175 토큰, 레이턴시 11.6s→2.6s):
 *  --tools ""            도구 전면 비활성(순수 텍스트 생성 — 에이전틱 루프 차단)
 *  --setting-sources ""  사용자/프로젝트 설정·훅 미로딩
 *  --strict-mcp-config   MCP 서버 미로딩(스키마 주입 방지)
 *  --no-session-persistence · --max-turns 1 · 중립 cwd(프로젝트 CLAUDE.md 미주입)
 *
 * 파라미터 매핑(계약 대비 근사치):
 *  - maxOutputTokens → CLAUDE_CODE_MAX_OUTPUT_TOKENS env
 *  - think → ollama 경로와 동일하게 미지정 시 runSettings.agentThinking(UI '추론' 토글)을 따른다.
 *    think off 시 sonnet 만 --effort low 근사(haiku 는 effort 미지원 → 생략). opus 는 편집장·리드의
 *    판단 단계(통합·브리프·지명 런) 전용이므로 토글이 꺼져 있어도 low 로 강등하지 않는다(CLI 기본 effort).
 *  - temperature → CLI 미노출 → 무시(기존에도 haiku 전용 옵션이었음)
 *  - format:'json' → 기존 SDK 경로와 동일하게 프롬프트 지시에 위임(호출부 microJSON 이 처리)
 *  - onDelta → stream-json 의 content_block_delta/text_delta
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config';
import { getRunSettings } from '../runsettings';
import { Semaphore } from '../util/semaphore';
import { recordUsage } from './cost';
import type { ChatParams, ChatResult, ChatMessage } from './types';

// 클라우드는 KV 슬롯 경합이 없어 단일 슬롯 불필요 — 동시 spawn 상한만 둔다.
const SLOT = new Semaphore(CONFIG.anthropicConcurrency);

// 중립 작업 디렉토리 — 스튜디오 프로젝트의 CLAUDE.md/설정이 생성 프롬프트에 새어들지 않게.
const NEUTRAL_CWD = path.join(os.tmpdir(), 'ai-contents-claude-cli');
/** spawn 직전 매번 보장 — 부팅 1회 mkdir 는 상주 서버에서 부족하다(실사고 2026-08-10 13:21: macOS
 *  임시폴더 청소가 이 디렉토리를 지워 이후 모든 호출이 "spawn claude ENOENT" — cwd 부재도 실행 파일
 *  부재와 같은 코드로 보고돼 CLI 문제로 오독). mkdir 1회 비용은 CLI 부팅(~1.5s) 대비 무시 가능. */
export function ensureNeutralCwd(): string {
  fs.mkdirSync(NEUTRAL_CWD, { recursive: true });
  return NEUTRAL_CWD;
}

/** ChatMessage[] → {system, prompt}. 멀티턴 이력은 단일 프롬프트로 직렬화(-p 는 1턴 입력). */
function toPrompt(msgs: ChatMessage[]): { system?: string; prompt: string } {
  const systemParts: string[] = [];
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of msgs) {
    const content = (m.content ?? '').trim();
    if (m.role === 'system') { if (content) systemParts.push(content); continue; }
    if (!content) continue; // 빈 턴 제거(기존 SDK 경로와 동일)
    turns.push({ role: m.role, content });
  }
  const system = systemParts.join('\n\n') || undefined;
  if (!turns.length) return { system, prompt: '(빈 입력)' };
  if (turns.length === 1 && turns[0]!.role === 'user') return { system, prompt: turns[0]!.content };
  const lines = turns.map((t) => `[${t.role === 'user' ? '사용자' : '어시스턴트'}]\n${t.content}`);
  return { system, prompt: `${lines.join('\n\n')}\n\n위 대화에 이어 어시스턴트로서 답하라. 답변 본문만 출력한다.` };
}

/** stream-json result 이벤트에서 쓰는 필드만. */
interface CliResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export class ClaudeCliClient {
  async chat(params: ChatParams): Promise<ChatResult> {
    return SLOT.run(() => this._chat(params));
  }

  private _chat(params: ChatParams): Promise<ChatResult> {
    const model = params.model;
    const isHaiku = /haiku/i.test(model);
    const maxTokens = Math.min(Math.max(1, params.maxOutputTokens ?? CONFIG.maxOutputTokens), 64_000);
    // UI '추론' 토글(runSettings.agentThinking) 폴백 — 미지정 호출도 토글을 따른다.
    const wantThink = (params.think ?? getRunSettings().agentThinking) && params.format !== 'json';
    let { system, prompt } = toPrompt(params.messages);

    // 비전 입력 — 이미지가 있으면 Read 도구만 허용해 CLI 가 파일을 직접 보게 한다(다른 도구는 여전히 차단).
    // 캡 8장: 컨텍스트·턴 폭주 방지. --add-dir 로 이미지 디렉토리를 읽기 허용(중립 cwd 밖 접근).
    const vision = (params.visionPaths ?? []).filter((p) => { try { return fs.existsSync(p); } catch { return false; } }).slice(0, 8);
    if (vision.length) {
      prompt += `\n\n[이미지 ${vision.length}장 — 반드시 각 파일을 Read 도구로 열어 직접 본 뒤 답하라]\n`
        + vision.map((p, i) => `${i + 1}. ${p}`).join('\n');
    }

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose', // print 모드의 stream-json 요구사항
      '--model', model,
      '--tools', vision.length ? 'Read' : '',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      // 비전은 Read 호출 턴이 필요 — 장수 비례 여유(그 외엔 기존 1턴 유지).
      '--max-turns', vision.length ? String(2 + vision.length * 2) : '1',
    ];
    for (const dir of [...new Set(vision.map((p) => path.dirname(p)))]) args.push('--add-dir', dir);
    if (system) args.push('--system-prompt', system);
    // opus 는 편집장·리드 판단 단계 전용 — 추론 토글이 꺼져 있어도 low 강등 없이 CLI 기본 effort 로 돈다.
    // sonnet(대량 work 단계)만 비용을 위해 low 근사 유지.
    const isOpus = /opus/i.test(model);
    if (!isHaiku && !isOpus && !wantThink) args.push('--effort', 'low');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 상한은 요청값의 3배 여유(최소 4천) — CLI 는 상한 초과를 '절단'이 아니라 오류로 반환하므로
      // (실사고: microJSON 700 캡에서 런 전체 실패), 빠듯한 캡은 하드 에러를 유발한다. 초과분
      // 회수는 아래 close 핸들러의 부분 텍스트 절단 경로가 담당.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(Math.max(maxTokens * 3, 4_000), 64_000)),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    // 구독 로그인 강제 — API 키/프로필이 있으면 그쪽으로 새서 크레딧 과금(400)으로 회귀한다.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_PROFILE;

    const t0 = Date.now();
    return new Promise<ChatResult>((resolve, reject) => {
      const child = spawn(CONFIG.claudeCliPath, args, { cwd: ensureNeutralCwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });

      let deltaText = '';
      let result: CliResult | undefined;
      let stderrTail = '';
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return; settled = true;
        try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ }
        reject(new Error(`Claude CLI ${model}: ${msg}`));
      };

      const timer = setTimeout(() => fail(`타임아웃(${CONFIG.requestTimeoutMs}ms)`), CONFIG.requestTimeoutMs);
      const onAbort = () => fail('중단됨(abort)');
      if (params.signal) {
        if (params.signal.aborted) { clearTimeout(timer); return fail('중단됨(abort)'); }
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (e) => { cleanup(); fail(`실행 실패(${e.message}) — claude CLI 설치/PATH 확인`); });
      child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; } // 비JSON 잡음 무시
        if (ev.type === 'stream_event') {
          const inner = (ev as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
            deltaText += inner.delta.text;
            params.onDelta?.(inner.delta.text);
          }
        } else if (ev.type === 'result') {
          result = ev as CliResult;
        }
      });

      child.on('close', (code) => {
        cleanup();
        if (settled) return;
        if (!result) return fail(`결과 없음(exit=${code}) ${stderrTail.trim()}`.trim());
        if (result.is_error || result.subtype !== 'success') {
          // 출력 상한 초과 — CLI 는 오류로 반환하지만 스트리밍된 부분 텍스트가 있으면 SDK 절단
          // 계약(text + truncated)으로 회수한다(마이크로 콜 하나 때문에 런 전체가 죽지 않게).
          const emsg = String(result.result ?? '');
          if (/exceeded the \d+ output token maximum/i.test(emsg) && deltaText.trim()) {
            settled = true;
            const inTok = result.usage?.input_tokens ?? 0;
            const outTok = result.usage?.output_tokens ?? 0;
            recordUsage(model, inTok, outTok, result.usage?.cache_read_input_tokens ?? 0);
            return resolve({
              text: deltaText.trim(), model,
              promptEvalCount: inTok, evalCount: outTok,
              totalDurationMs: Date.now() - t0, loadDurationMs: 0,
              truncated: true, doneReason: 'max_tokens',
            });
          }
          return fail(`${result.subtype ?? 'error'} — ${(result.result ?? stderrTail).slice(0, 500)}`.trim());
        }
        settled = true;
        const inTok = result.usage?.input_tokens ?? 0;
        const outTok = result.usage?.output_tokens ?? 0;
        const cacheRead = result.usage?.cache_read_input_tokens ?? 0;
        recordUsage(model, inTok, outTok, cacheRead);
        const stopReason = result.stop_reason ?? '';
        resolve({
          text: (result.result ?? deltaText).trim(),
          model,
          promptEvalCount: inTok,
          evalCount: outTok,
          totalDurationMs: Date.now() - t0,
          loadDurationMs: 0,
          truncated: stopReason === 'max_tokens',
          doneReason: stopReason || (result.subtype ?? ''),
        });
      });

      // 런 취소(abort→SIGKILL) 직후 stdin 에 쓰면 EPIPE 가 'error' 이벤트로 올라오는데, 핸들러가 없으면
      // 프로세스 전체가 죽는다(2026-08-27 실사고 — 취소 한 번에 서버 다운). 삼키고 fail 로만 정리한다.
      child.stdin.on('error', (e: NodeJS.ErrnoException) => { if (e?.code !== 'EPIPE') fail(`stdin ${e?.code ?? e?.message ?? 'error'}`); });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

export const claudeCli = new ClaudeCliClient();
