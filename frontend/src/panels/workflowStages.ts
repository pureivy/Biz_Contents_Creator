// 워크플로우/타임라인 진행 단계의 순수 로직 — PhaseStepper·OfficeProgressBar(워크플로우 보드,
// 타임라인 헤더, 오피스 진행률 바)가 공유한다. React 비의존(순수 함수)이라 단위 테스트 가능.
//
// 두 종류의 런:
//  - 전사/토론 런: org.ts 가 team/_ceo phase 이벤트를 흘려 6단계 DISPATCH PROTOCOL 로 진행.
//  - 직원 지명(단독) 런: directed.ts 는 phase 이벤트를 내지 않는다(오피스뷰 가짜 팀간회의 억제용).
//    그래서 phase 기반 진행이 0(위임)에 갇혀 작업이 끝나야 완료로 점프했다 — "위임에 머물면서
//    작업은 진행됨"의 원인. 솔로 런은 soloAgentId 로 식별해 토론·보고·통합이 없는 축약
//    파이프라인(위임→작업 진행→완료)을 쓰고, 지명 직원이 실제 작업을 시작하면 '작업 진행'으로 전진한다.
import { UIState } from "../events/types";

export const TERMINAL = new Set([
  // 'done' = 잡 런(카드뉴스·숏폼) 종료 status — 누락 시 완료 점프가 안 돼 타임라인이 마지막
  // phase(integrate=통합)에 갇힌다(사용자 보고 2026-07-22: 기록엔 완료인데 타임라인은 통합).
  "ok", "done", "partial", "cancelled", "budget_exceeded", "error", "interrupted",
]);

export interface Stage { key: string; label: string; }

// 전사/토론 런: CEO DISPATCH PROTOCOL 6단계(team/_ceo phase 가 이 매크로 단계로 매핑).
export const MACRO: Stage[] = [
  { key: "delegate", label: "위임" },
  { key: "work", label: "작업 진행" },
  { key: "debate", label: "팀 토론" },
  { key: "report", label: "보고" },
  { key: "integrate", label: "통합" },
  { key: "done", label: "완료" },
];

// 직원 지명(단독) 런: 토론·보고·통합이 없는 축약 파이프라인. 6단계를 쓰면 작업 진행 뒤
// 죽은 단계(토론·보고·통합)가 '대기'로 남아 다시 '한 단계에 갇힌' 인상을 준다 → 정직한 3단계.
export const SOLO_MACRO: Stage[] = [
  { key: "delegate", label: "위임" },
  { key: "work", label: "작업 진행" },
  { key: "done", label: "완료" },
];

// team/_ceo phase → 매크로 단계 인덱스(전사/토론 런).
export function phaseMacro(phase?: string): number {
  switch (phase) {
    case "delegate": return 0;
    case "brief": case "decompose": case "assign": case "work": return 1;
    case "debate": return 2;
    case "report": return 3;
    case "review": case "integrate": return 4;
    default: return -1;
  }
}

// 전사/토론 런의 현재 매크로 단계(팀+CEO phase 중 최고 도달 단계; 종료면 완료).
export function currentMacro(phases: Record<string, string>, status: string): number {
  if (TERMINAL.has(status)) return MACRO.length - 1;
  let max = -1;
  for (const ph of Object.values(phases)) max = Math.max(max, phaseMacro(ph));
  if (max < 0 && (status === "running" || Object.keys(phases).length > 0)) max = 0;
  return max;
}

// 솔로(지명) 런에서 지명 직원이 '작업을 시작했는가' — phase 이벤트가 없으므로 산출물
// 스트리밍(ceo-synth 블록)이나 직원 상태(spawned 졸업: thinking/spoke/…)로 판정한다.
// runAgent(synthesis)는 synthesis_chunk 로 ceo-synth 블록을 채우므로 스트리밍 중에도 잡힌다.
export function soloWorking(s: Pick<UIState, "soloAgentId" | "blocks" | "agents">): boolean {
  const id = s.soloAgentId;
  if (!id) return false;
  if (s.blocks["ceo-synth"]) return true;
  const a = s.agents[id];
  return !!a && a.status !== "spawned";
}

// 표시할 단계 집합 + 현재 인덱스. 솔로 런은 축약 파이프라인, 그 외 6단계 DISPATCH PROTOCOL.
export function macroStages(
  phases: Record<string, string>,
  status: string,
  solo: { id: string | null; working: boolean },
): { stages: Stage[]; cur: number } {
  if (solo.id) {
    const cur = TERMINAL.has(status)
      ? SOLO_MACRO.length - 1   // 완료
      : solo.working ? 1 : 0;   // 작업 진행 / 위임
    return { stages: SOLO_MACRO, cur };
  }
  return { stages: MACRO, cur: currentMacro(phases, status) };
}
