/**
 * run_command 통합 — AGENT_SHELL 옵트인 + 자율도 게이트가 execLoopTool→gateWrite→runCommand 경로로
 * 올바르게 작동하는지 결정적 검증(전송계층 stub). echo 만 실행해 부작용을 최소화.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
let runAgent: any;
let createBus: any;
let llm: any;

const fakeResult = (text: string) => ({
  text, model: 'fake', promptEvalCount: 1, evalCount: 1, totalDurationMs: 1, loadDurationMs: 0, truncated: false, doneReason: 'stop',
});
const role = (autonomy: number) => ({
  id: 'shelltest_agent', name: '셸테스트', title: 'Researcher', emoji: '🔍',
  tier: 'standard', stance: 'neutral', persona: '', specialty: '리서치',
  tools: ['wiki_query'], autonomy, isCritic: false,
}) as any;
const toolUsedNames = (bus: any): string[] =>
  (bus.replay(0) as any[]).filter((e) => e.type === 'tool_used').map((e) => e.payload?.tool);

beforeAll(async () => {
  process.env.AGENT_TOOL_LOOP = '1';
  process.env.AGENT_SHELL = '1';
  process.env.ENFORCE_AUTONOMY = '1';
  process.env.WEB_SEARCH = 'false';
  ({ llm } = await import('../llm/client'));
  ({ runAgent } = await import('./agent'));
  ({ createBus } = await import('../events/bus'));
});

describe('run_command 통합(AGENT_SHELL)', () => {
  it('autonomy 3(자동)에서 allowlist 안전 명령을 실행하고 결과를 주입한다', async () => {
    let n = 0;
    const spy = vi.spyOn(llm, 'chat').mockImplementation(async () => {
      n++;
      return fakeResult(n === 1 ? '<tool name="run_command">echo studio-shell-itest</tool>' : '명령 결과를 반영했습니다.');
    });
    const bus = createBus('shell-itest-1');
    const out = await runAgent({ bus, role: role(3), model: 'fake', task: 'x', stage: 'work', emitSpawn: true });
    expect(toolUsedNames(bus)).toContain('run_command'); // 실제 실행됨
    expect(out.text).toContain('명령 결과');
    spy.mockRestore();
  });

  it('autonomy 1(읽기 전용)에서는 run_command 가 제시·실행되지 않는다', async () => {
    let n = 0;
    const spy = vi.spyOn(llm, 'chat').mockImplementation(async () => {
      n++;
      return fakeResult(n === 1 ? '<tool name="run_command">echo x</tool>' : '답변.');
    });
    const bus = createBus('shell-itest-2');
    await runAgent({ bus, role: role(1), model: 'fake', task: 'x', stage: 'work', emitSpawn: true });
    expect(toolUsedNames(bus)).not.toContain('run_command'); // 자율도 게이트로 차단
    spy.mockRestore();
  });
});
