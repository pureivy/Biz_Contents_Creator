/**
 * 다라운드 토론 + 수렴 판정 (GEPA debate 모드 패리티).
 *
 * 라운드마다: 비평가가 현재 입장들을 비판 → 각 전문가가 비평·동료 입장을 반영해 재반박(입장 갱신)
 * → micro 모델 판정기가 수렴 여부 판단(adaptive 종료). 로컬 속도를 위해 판정은 micro 단발 호출.
 *
 * 호출 비용(로컬 직렬): 라운드당 critic(1) + workers(n) + 수렴판정(1). DEBATE_ROUNDS=0 이면 토론 생략.
 */
import { CONFIG } from '../config';
import { EventType } from '../events/types';
import type { EventBus } from '../events/bus';
import type { CompanyDef, RoleDef } from '../agents/company';
import { modelForTier } from '../llm/models';
import type { ModelAssignment } from '../llm/models';
import { mapLimit } from '../util/semaphore';
import { runAgent, microJSON } from './agent';

export interface Position {
  role: RoleDef;
  text: string;
}

export interface DebateResult {
  positions: Position[];
  critique: string;
  roundsRun: number;
  converged: boolean;
}

const combine = (ps: Position[]): string => ps.map((p) => `## ${p.role.name}\n${p.text}`).join('\n\n');

/** micro 판정기로 직전 라운드 대비 수렴 여부를 평가. 실패 시 보수적으로 미수렴. */
async function assessConvergence(
  microModel: string,
  prevText: string,
  curText: string,
  signal?: AbortSignal,
): Promise<{ state: 'converging' | 'converged' | 'diverging'; confidence: number }> {
  const j = await microJSON<{ state?: string; confidence?: number }>(
    microModel,
    '너는 토론 수렴 판정기다. 두 라운드의 입장이 실질적으로 같은 결론에 도달했으면 converged. confidence 는 판정 확신도(0~1).',
    `직전 라운드와 현재 라운드 입장이 실질적으로 수렴했는가?\n\n[직전]\n${prevText.slice(0, 4000)}\n\n[현재]\n${curText.slice(0, 4000)}\n\n형식: {"state":"converging|converged|diverging","confidence":0.0~1.0}`,
    { signal, maxOutputTokens: 120 },
  );
  const s = (j?.state ?? '').toLowerCase();
  const state = s === 'converged' ? 'converged' : s === 'diverging' ? 'diverging' : 'converging';
  const c = typeof j?.confidence === 'number' ? j.confidence : 0.5;
  return { state, confidence: Math.max(0, Math.min(1, c)) };
}

/**
 * 초기 입장(round 0)을 받아 토론 라운드를 돌리고 최종 입장 + 마지막 비평을 반환.
 */
export async function runDebate(
  bus: EventBus,
  company: CompanyDef,
  assign: ModelAssignment,
  workers: RoleDef[],
  initial: Position[],
  signal?: AbortSignal,
): Promise<DebateResult> {
  let positions = initial;
  let critique = '';
  let converged = false;
  let roundsRun = 0;

  const critic = company.specialists.find((s) => s.isCritic);

  for (let round = 1; round <= CONFIG.debateRounds && !converged; round++) {
    roundsRun = round;
    const prevCombined = combine(positions);

    // 1) 비평
    if (critic) {
      const c = await runAgent({
        bus, role: critic, model: modelForTier(assign, critic.tier),
        task: `라운드 ${round}: 아래 입장들을 비판적으로 검토하라. 약점·가정·반례·미해결 쟁점을 구체적으로 지적하라.`,
        context: prevCombined, stage: 'critique', emitSpawn: round === 1, signal,
      });
      critique = c.text;
      bus.emit(EventType.critique, { round, text: critique }, { agentId: critic.id });
    }

    // 2) 재반박(입장 갱신)
    const revised = await mapLimit(
      CONFIG.concurrency,
      workers.map((role) => async (): Promise<Position> => {
        const mine = positions.find((p) => p.role.id === role.id)?.text ?? '';
        const out = await runAgent({
          bus, role, model: modelForTier(assign, role.tier),
          task: `라운드 ${round}: 비평과 동료 입장을 반영해 당신의 입장을 갱신하라. 바뀐 점은 명시하고, 동의/이견을 분명히 하라.`,
          context: `[당신의 이전 입장]\n${mine}\n\n[비평]\n${critique}\n\n[동료 입장]\n${prevCombined}`,
          stage: 'rebuttal', signal,
        });
        bus.emit(EventType.debate_message, { round, move: 'rebuttal', text: out.text }, { agentId: role.id });
        return { role, text: out.text };
      }),
    );

    // 3) 수렴 판정(adaptive)
    const prevText = positions.map((p) => p.text).join('\n');
    const curText = revised.map((p) => p.text).join('\n');
    positions = revised;

    if (CONFIG.termination === 'adaptive') {
      const { state, confidence } = await assessConvergence(assign.micro, prevText, curText, signal);
      converged = state === 'converged';
      bus.emit(EventType.convergence_state_changed, { round, state, confidence, stable_rounds: converged ? 1 : 0 });
      // 낮은 신뢰도(<0.6)로 수렴 → CEO/UI 가 '불안정 수렴'을 인지하도록 경고(조기 종료 오판 방지).
      if (converged && confidence < 0.6) {
        bus.emit(EventType.log, { message: `⚠ 라운드 ${round} 수렴 판정 신뢰도 낮음(${confidence.toFixed(2)}) — 결론 안정성 주의` });
      }
    }
  }

  return { positions, critique, roundsRun, converged };
}
