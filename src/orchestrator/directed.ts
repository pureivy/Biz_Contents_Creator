/**
 * Directed 런 — 지명한 직원(역할) 1명이 단독으로 주제에 응답. 전사 토론/조직 오버헤드 없이 가장 빠름.
 * (프론트의 "직원명+질문" 지명 런 계약)
 */
import { CONFIG } from '../config';
import { modelForTier } from '../llm/models';
import type { EventBus } from '../events/bus';
import { DEFAULT_COMPANY, rolesById } from '../agents/company';
import { runAgent } from './agent';
import { prepareRun } from './prepare';
import { finalizeRun } from './finalize';
import type { RunOptions, RunOutcome } from './run';

export async function runDirected(bus: EventBus, opts: RunOptions): Promise<RunOutcome> {
  const company = opts.company ?? DEFAULT_COMPANY;
  const { topic, signal } = opts;

  // 지명된 직원(역할)을 prepareRun 전에 확정 — run_started 에 solo 직원 id 를 실어 보내,
  // 프론트 오피스뷰가 '단독 런'으로 인지하고 가짜 팀간회의 대신 그 직원만 자기 자리에서 작업하게 한다.
  const role = rolesById(company).get(opts.agentId ?? '') ?? company.ceo;
  const prep = await prepareRun(bus, topic, company, signal, role.id);
  if (!prep) throw new Error('no local models');
  const { assign, subproblems } = prep;

  const subContext = subproblems.map((s) => `- (${s.id}) ${s.text}`).join('\n');

  // 단독 응답을 종합 스테이지로 흘려 산출물 패널에 바로 표시(ceo-synth 블록 계약 재사용).
  const out = await runAgent({
    bus, role, model: modelForTier(assign, role.tier),
    task: subContext ? `${topic}\n\n관련 하위 문제:\n${subContext}` : topic,
    stage: 'synthesis', toolLoop: true, emitSpawn: true, blockId: 'ceo-synth', groundQuery: topic,
    maxOutputTokens: CONFIG.integrationMaxOutputTokens, signal,
  });

  await finalizeRun({
    bus, topic, ceoId: role.id, ceoName: role.name,
    assignReason: assign.reason, subproblems,
    positions: [{ id: role.id, name: role.name, stance: role.stance, text: out.text }],
    deliverable: out.text, converged: true, ingestModel: assign.micro, signal,
  });

  return {
    deliverable: out.text, modelAssignment: assign,
    positions: [{ id: role.id, name: role.name, stance: role.stance, text: out.text }],
    subproblems,
  };
}
