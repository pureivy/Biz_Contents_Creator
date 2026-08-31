/**
 * 능동 도구 루프 통합 테스트 — ollama.chat 을 스텁해 LLM 비결정성을 제거하고 루프 분기를 결정적으로 검증.
 * (라이브 모델은 태그 발신을 보장 못 하므로 단위 결정성을 위해 전송계층만 가짜로 둔다.)
 *
 * env 를 먼저 세팅한 뒤 동적 import — config.ts 가 import 시점에 env 를 읽으므로(정적 import 금지).
 * groundQuery 는 주지 않는다(선그라운딩의 위키/커넥터 실호출을 배제해 hermetic). 역할 id 는 워크스페이스가
 * 없는 고유값을 써 capabilities.json 디스크 상태에 흔들리지 않게 한다.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
let runAgent: any;
let createBus: any;
let llm: any;

const fakeResult = (text: string, model = 'fake') => ({
  text, model, promptEvalCount: 1, evalCount: 1, totalDurationMs: 1, loadDurationMs: 0, truncated: false, doneReason: 'stop',
});

const role = (autonomy: number, tools: string[]) => ({
  id: 'looptest_agent', name: '루프테스트', title: 'Researcher', emoji: '🔍',
  tier: 'standard', stance: 'neutral', persona: '', specialty: '리서치',
  tools, autonomy, isCritic: false,
}) as any;

const toolUsedNames = (bus: any): string[] =>
  (bus.replay(0) as any[]).filter((e) => e.type === 'tool_used').map((e) => e.payload?.tool);

beforeAll(async () => {
  process.env.AGENT_TOOL_LOOP = '1';
  process.env.AGENT_MAX_TOOL_CALLS = '3';
  process.env.WEB_SEARCH = 'false';
  ({ llm } = await import('../llm/client'));
  ({ runAgent } = await import('./agent'));
  ({ createBus } = await import('../events/bus'));
});

describe('runAgent 능동 도구 루프(AGENT_TOOL_LOOP)', () => {
  it('모델이 <tool> 태그를 내면 도구를 실행·주입·재호출하고, 최종 답에서 태그를 제거한다', async () => {
    let n = 0;
    const spy = vi.spyOn(llm, 'chat').mockImplementation(async () => {
      n++;
      return fakeResult(n === 1 ? '<tool name="wiki_query">로컬 LLM 속도</tool>' : '최종 답변입니다. 자료를 반영했습니다.');
    });

    const bus = createBus('loop-test-1');
    const out = await runAgent({
      bus, role: role(1, ['wiki_query']), model: 'fake', task: '분석하라', stage: 'work', emitSpawn: true,
    });

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);     // turn0 + 도구 후 재호출
    expect(toolUsedNames(bus)).toContain('wiki_query');          // 도구 실제 실행
    expect(out.text).not.toMatch(/<tool\b/);                     // 최종 답에서 태그 제거
    expect(out.text).toContain('최종 답변');
    spy.mockRestore();
  });

  it('autonomy 1(읽기 전용)에서는 쓰기 도구(save_note)를 실행하지 않는다(거버넌스 게이트)', async () => {
    let n = 0;
    const spy = vi.spyOn(llm, 'chat').mockImplementation(async () => {
      n++;
      return fakeResult(n === 1 ? '<tool name="save_note">중요 사실 저장</tool>' : '최종 답변.');
    });
    const bus = createBus('loop-test-2');
    await runAgent({ bus, role: role(1, ['wiki_query']), model: 'fake', task: 'x', stage: 'work', emitSpawn: true });
    expect(toolUsedNames(bus)).not.toContain('save_note');       // autonomy 1 → 쓰기 차단
    spy.mockRestore();
  });

  it('turn0 본문 + 도구호출이 섞이면 turn0 본문이 최종 산출물에 보존된다(콘텐츠 유실 방지)', async () => {
    let n = 0;
    const spy = vi.spyOn(llm, 'chat').mockImplementation(async () => {
      n++;
      return fakeResult(n === 1 ? '핵심 분석: 로컬이 빠르다. <tool name="wiki_query">근거</tool>' : '추가로, 캐시가 중요하다.');
    });
    const bus = createBus('loop-test-4');
    const out = await runAgent({ bus, role: role(1, ['wiki_query']), model: 'fake', task: 'x', stage: 'work', emitSpawn: true });
    expect(out.text).toContain('핵심 분석');   // turn0 본문 보존(이전엔 마지막 턴만 남아 유실)
    expect(out.text).toContain('추가로');       // turn1 연속 본문도 포함
    expect(out.text).not.toMatch(/<tool\b/);
    spy.mockRestore();
  });

  it('stage=synthesis 는 루프를 돌리지 않는다(단발 유지)', async () => {
    const spy = vi.spyOn(llm, 'chat').mockImplementation(async () =>
      fakeResult('<tool name="wiki_query">x</tool> 종합 결과'),
    );
    const bus = createBus('loop-test-3');
    const out = await runAgent({ bus, role: role(3, ['wiki_query']), model: 'fake', task: 'x', stage: 'synthesis', emitSpawn: true });
    expect(spy.mock.calls.length).toBe(1);                        // 단발(재호출 없음)
    expect(out.text).toContain('종합 결과');                      // synthesis 는 strip 미적용(루프 미진입 증거)
    spy.mockRestore();
  });
});
