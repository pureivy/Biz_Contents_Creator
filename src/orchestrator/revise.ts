/**
 * Revise 런 — 끝난 런의 전문가 입장 + 이전 산출물 + 사용자 피드백으로 CEO 종합만 재실행(v+1).
 * 팀 작업을 다시 돌리지 않아 빠르고 저렴(프론트 '수정 요청' 계약).
 */
import { CONFIG } from '../config';
import { modelForTier } from '../llm/models';
import type { EventBus } from '../events/bus';
import { getCompany } from '../agents/company-loader';
import type { CompanyDef } from '../agents/company';
import { runAgent } from './agent';
import { prepareRun } from './prepare';
import { finalizeRun } from './finalize';
import type { FinalPosition } from './finalize';
import type { RunOutcome } from './run';

export interface ReviseInput {
  topic: string;
  positions: FinalPosition[];
  priorDeliverable: string;
  feedback: string;
  company?: CompanyDef;
  signal?: AbortSignal;
}

export async function runRevise(bus: EventBus, input: ReviseInput): Promise<RunOutcome> {
  const company = input.company ?? getCompany();
  const { topic, signal } = input;

  const prep = await prepareRun(bus, topic, company, signal);
  if (!prep) throw new Error('no local models');
  const { assign, subproblems } = prep;

  const ctx = [
    '[이전 전문가 분석]',
    ...input.positions.map((p) => `## ${p.name}\n${p.text}`),
    '\n[이전 최종 산출물]',
    input.priorDeliverable,
    '\n[사용자 피드백 — 반드시 반영해 개선하라]',
    input.feedback,
  ].join('\n\n');

  const out = await runAgent({
    bus, role: company.ceo, model: modelForTier(assign, company.ceo.tier),
    task: `주제 "${topic}"의 이전 산출물을 사용자 피드백에 따라 개선해 최종본을 다시 작성하라. 피드백이 지적한 점을 명시적으로 반영할 것.`,
    context: ctx, stage: 'synthesis', emitSpawn: true, blockId: 'ceo-synth',
    maxOutputTokens: CONFIG.integrationMaxOutputTokens, signal,
  });

  await finalizeRun({
    bus, topic, ceoId: company.ceo.id, ceoName: company.ceo.name,
    assignReason: assign.reason, subproblems,
    positions: input.positions, deliverable: out.text, converged: true, ingestModel: assign.micro, signal,
  });

  return { deliverable: out.text, modelAssignment: assign, positions: input.positions, subproblems };
}
