// "지금 누가 일하는 중인가"의 단일 진실원천 — OfficeView(아바타 안무)와
// DashboardBar(WORKING n/total 칩)가 같은 규칙을 쓰도록 추출. 과거에 DashboardBar가
// 자체 근사 규칙(engaged 웨이브·placeholder·running 게이트 누락)을 들고 있어 사무실
// 표시와 카운터가 어긋났다(팀 phase=work면 미선발 팀원까지 전원 working으로 집계).
//
// 규칙(OfficeView 안무와 1:1, 메모리 office-stale-display-at-completion-resume의
// "active는 latch가 아니라 현재 wave·phase·status==='running'으로 게이트" 원칙):
//  - 런이 살아있지 않으면(status!=="running") 아무도 working이 아니다.
//  - 로스터 placeholder(이번 런에 스폰되지 않은 직원)는 절대 working이 아니다.
//  - CEO: 위임(delegate)/검토(review) phase 또는 통합 스트리밍(ceo-synth) 중일 때만.
//  - 팀장: 실제 스트리밍(thinking)이거나, 팀이 활성 phase(LEAD_WORK_PHASES)에 있을 때.
//    (CEO 통합 단계는 CEO 단독 작업 — 팀장은 보고를 마쳐 대기. ceoIntegrating 으로 집계하지 않는다.)
//  - 팀원: 팀의 '현재 위임 웨이브'(engaged)에 선발된 경우에만 — 그리고 팀이
//    팀원-활성 phase(MEMBER_WORK_PHASES)에 있거나 실제 스트리밍 중일 때.
//  - 토론 모드(level 없음): 실제 스트리밍(thinking)일 때만.
import { AgentNode, UIState } from "./types";

// Phases in which a member / a lead is actually "working" (OfficeView의 안무 기준).
// 'work' phase(팀원 작업 구간)에는 팀장이 실제 LLM 호출 없이 자리에서 대기하므로
// LEAD_WORK_PHASES에서 'work'를 뺀다 — 팀원만 working으로 집계/표시되게 한다.
// (brief·report_ceo 는 백엔드가 emit 하지 않는 phase 라 제외 — 통합은 ceoIntegrating 로 따로 게이트.)
export const MEMBER_WORK_PHASES = new Set(["assign", "work", "debate", "report"]);
export const LEAD_WORK_PHASES = new Set([
  "assign", "decompose", "debate", "report",
]);

// spawned→thinking 승격: 런이 살아있고 실제 참여자(placeholder 아님)면 "spawned"를
// 작업 중으로 본다(OfficeView effStatus와 동일 — 세션이 막 붙어 아직 첫 토큰 전).
function effStatus(a: AgentNode, running: boolean): string {
  return running && a.status === "spawned" && !a.placeholder ? "thinking" : a.status;
}

type WorkingSlice = Pick<UIState, "agents" | "phases" | "engaged" | "blocks" | "status" | "soloAgentId">;

export function isWorkingNow(a: AgentNode, s: WorkingSlice): boolean {
  const running = s.status === "running";
  if (!running || a.placeholder) return false;
  // 직원 지명(단독) 런 — 지명된 그 직원만 작업 중. 단독 응답을 ceo-synth 블록으로 흘리므로
  // ceoIntegrating(blocks["ceo-synth"]) 가 켜지지만, 이 분기로 가짜 팀간회의 집계를 차단한다.
  if (s.soloAgentId) return a.agent_id === s.soloAgentId;
  const ph = s.phases;
  const ceoIntegrating = !!s.blocks["ceo-synth"] || s.phases["_ceo"] === "integrate";
  if (a.level === "ceo") {
    return ph["_ceo"] === "delegate" || ph["_ceo"] === "review" || ceoIntegrating;
  }
  const teamPhase = ph[a.team ?? ""] ?? "";
  if (a.level === "lead") {
    // 팀장 분해는 microCall이라 런 내내 status가 'spawned'에 머문다 → effStatus 승격을
    // 쓰면 팀원 'work' 구간에도 팀장이 자동 working이 된다. raw status==='thinking'(실제
    // 스트리밍, 즉 report 종합·report_ceo 등)만 working으로 보고, 단계 기반은
    // LEAD_WORK_PHASES('work' 제외)로 게이트한다.
    // CEO 통합(integrate)은 CEO '단독' 작업 — 팀장은 이미 보고를 마쳐(team phase=idle) 대기다.
    // 그래서 ceoIntegrating 으로 팀장을 working 집계하지 않는다(오피스뷰 '팀간회의' 연출 제거와 1:1).
    return a.status === "thinking" || LEAD_WORK_PHASES.has(teamPhase);
  }
  if (a.level === "member") {
    // standby 콘텐츠 팀(카드뉴스/숏폼)의 렌더링(integrate) 구간 — 코드(이미지·영상 생성)가
    // 일하는 구간이라 engaged 게이트를 우회한다. 팀 스코프 'integrate'는 이 두 잡만 emit 하고
    // (블로그 org 런의 통합은 '_ceo' 키), OfficeView의 '렌더링 중' 버블과 1:1.
    // (디자인 단계의 LLM 스트리밍은 cardnews/shorts 잡이 delegation 을 emit 해 engaged 로 잡힌다
    //  — 2026-08-12 배선 전엔 디자인 내내 칩 0·유휴 표시였다.)
    if (teamPhase === "integrate") return true;
    const engaged = (s.engaged[a.team ?? ""] ?? []).includes(a.agent_id);
    if (!engaged) return false;
    // 직렬(concurrency=1)에서 '지금 실제로 토큰을 내는' 멤버만 작업중 — OfficeView work 분기와 1:1.
    // effStatus 가 non-placeholder spawned 를 thinking 으로 승격(막 스폰돼 첫 토큰 전 포함)하고,
    // 완료(spoke)·직렬대기(placeholder)는 제외 → 오피스 '✍️ 작업 중' 버블 수와 항상 동일.
    return effStatus(a, running) === "thinking";
  }
  // 토론 모드(수평 토론, level 없음): 스트리밍 중일 때만.
  return a.status === "thinking";
}

export function countWorking(s: WorkingSlice): number {
  return Object.values(s.agents).filter((a) => isWorkingNow(a, s)).length;
}
