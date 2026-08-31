/**
 * Debate 모드 런 엔진 — 분해 → 전문가 작업 → 다라운드 토론 → CEO 종합.
 *
 * 로컬 속도 설계: 분해/수렴판정은 micro 단발 호출, 전문가 작업은 standard(세마포어 직렬),
 * 종합만 heavy + 큰 출력 캡. 모델은 RAM 예산 자동 배정(prepare.ts).
 */
import { CONFIG } from '../config';
import { modelForTier } from '../llm/models';
import type { ModelAssignment } from '../llm/models';
import type { EventBus } from '../events/bus';
import { DEFAULT_COMPANY } from '../agents/company';
import type { CompanyDef, RoleDef } from '../agents/company';
import { mapLimit } from '../util/semaphore';
import { isAbort } from '../util/abort';
import { runAgent } from './agent';
import { runDebate } from './debate';
import type { Position } from './debate';
import { prepareRun } from './prepare';
import { finalizeRun } from './finalize';
import type { FinalPosition } from './finalize';

export interface RunOptions {
  topic: string;
  company?: CompanyDef;
  signal?: AbortSignal;
  /** 직원 지명 런 — 이 역할 1명이 단독 응답. */
  agentId?: string;
  /** 실행 경로: 'auto' | 'team'(1팀 경량) | 'full'(전사). */
  path?: string;
  /** 런 예산 캡(USD). 로컬은 무료라 정보용. */
  budgetUsd?: number;
  /** 리비전 런(검토 탭 '수정 요청') — 기존 초안을 사용자 피드백에 따라 개정. 리서치·검수 생략 fast-path. */
  revise?: { baseBody: string; feedback: string; /** 개정 대상 초안을 만든 런 — research_brief.md 재주입용(스펙 §3). */ baseRunId?: string };
  /** 핵심 타겟 키워드(piece.keyword) — 포장 단계 primaryKeyword 고정(SEO 게이트·리비전 과녁 고정). */
  keyword?: string;
  /** 연결된 piece id — 있으면 콘텐츠 '제작' 런이라는 표식. 단축경로(즉답) 분류를 우회한다(실측 2026-08-07:
   *  클러스터 가제 "…언제 꽃이 피고 언제 관리할까"가 '언제'에 걸려 즉답으로 빠짐 → draft 없는 ready 좌초). */
  pieceId?: string;
  /** 지식 리서치 런 — 블로그 집필·포장(draft.json) 생략. 산출물은 리서치 보고서로 두뇌(위키) 적재·
   *  직원 학습(reflect)에만 쓰인다. draft.json 이 없어 piece 승격·캘린더 오염이 자연 차단된다. */
  mission?: 'research';
  /** 블로그 작가 말투(페르소나) id — 컴포저에서 고른 목소리를 본문 집필 작가에 주입(personas.ts). */
  persona?: string;
  /** persona='custom' 일 때 사용자가 직접 입력한 말투 텍스트. */
  personaText?: string;
}

export interface RunOutcome {
  deliverable: string;
  modelAssignment: ModelAssignment;
  /** 전문가/팀 산출물 — revise(재종합)에서 재사용. */
  positions?: FinalPosition[];
  subproblems?: Array<{ id: string; text: string }>;
}

/** Debate 모드 런. 이벤트는 bus 로 스트리밍, 최종 산출물 반환. */
export async function runOffice(bus: EventBus, opts: RunOptions): Promise<RunOutcome> {
  const company = opts.company ?? DEFAULT_COMPANY;
  const { topic, signal } = opts;

  const prep = await prepareRun(bus, topic, company, signal);
  if (!prep) throw new Error('no local models');
  const { assign, subproblems } = prep;

  // --- 전문가 작업(비평가 제외, 로컬 속도 위해 MAX_SPECIALISTS 로 캡) ---
  const workers = company.specialists.filter((s) => !s.isCritic).slice(0, CONFIG.maxSpecialists);
  const critic = company.specialists.find((s) => s.isCritic);

  const subContext = subproblems.map((s) => `- (${s.id}) ${s.text}`).join('\n');
  const workTask = `주제: ${topic}\n\n다룰 하위 문제:\n${subContext}\n\n당신의 전문 관점에서 분석과 제안을 작성하세요.`;

  const workOutputs = await mapLimit(
    CONFIG.concurrency,
    workers.map((role: RoleDef) => async () => {
      try {
        const out = await runAgent({
          bus, role, model: modelForTier(assign, role.tier),
          task: workTask, stage: 'work', emitSpawn: true, groundQuery: topic, signal,
        });
        return { role, text: out.text };
      } catch (e) {
        if (isAbort(e, signal)) throw e; // 취소는 상위로 전파
        // 단일 전문가 실패는 격리 — 빈 입장으로 배치를 깨지 않음.
        bus.emit('agent_failed', { agent_id: role.id, error: e instanceof Error ? e.message : String(e), isolated: true }, { agentId: role.id });
        return { role, text: '' };
      }
    }),
  );

  // --- 다라운드 토론 + 수렴 판정 (DEBATE_ROUNDS=0 이면 생략) ---
  const initialPositions: Position[] = workOutputs.map((o) => ({ role: o.role, text: o.text }));
  const debate = await runDebate(bus, company, assign, workers, initialPositions, signal);
  // 빈 입장(격리 실패 등) 제외 — 종합·다이제스트 오염 방지.
  const usable = debate.positions.filter((p) => p.text.trim());
  const critiqueText = debate.critique;
  if (debate.roundsRun > 0) {
    bus.emit('log', {
      message: `토론 ${debate.roundsRun}라운드 — ${debate.converged ? '수렴' : '라운드 소진'}`,
    });
  }
  if (usable.length === 0) {
    bus.emit('error', { message: '모든 전문가가 빈 출력 — 종합할 내용이 없습니다.' });
    bus.emit('run_done', { status: 'error' });
    return { deliverable: '', modelAssignment: assign };
  }

  // --- CEO 종합 ---
  const synthContext = [
    ...usable.map((o) => `## ${o.role.name}\n${o.text}`),
    critiqueText ? `## 비평(${critic?.name})\n${critiqueText}` : '',
  ].filter(Boolean).join('\n\n');

  const synth = await runAgent({
    bus, role: company.ceo, model: modelForTier(assign, company.ceo.tier),
    task: `주제 "${topic}" 에 대한 전문가 분석과 비평을 종합해, 모순을 정리하고 실행 가능한 최종 결론을 작성하라.`,
    context: synthContext, stage: 'synthesis', emitSpawn: true, blockId: 'ceo-synth',
    maxOutputTokens: CONFIG.integrationMaxOutputTokens, signal,
  });

  await finalizeRun({
    bus, topic, ceoId: company.ceo.id, ceoName: company.ceo.name,
    assignReason: assign.reason, subproblems,
    positions: usable.map((p) => ({ id: p.role.id, name: p.role.name, stance: p.role.stance, text: p.text })),
    critique: critic && critiqueText ? { id: critic.id, name: critic.name, text: critiqueText } : undefined,
    deliverable: synth.text, converged: debate.converged, ingestModel: assign.micro, reflectModel: assign.standard, signal,
  });

  return {
    deliverable: synth.text, modelAssignment: assign,
    positions: usable.map((p) => ({ id: p.role.id, name: p.role.name, stance: p.role.stance, text: p.text })),
    subproblems,
  };
}
