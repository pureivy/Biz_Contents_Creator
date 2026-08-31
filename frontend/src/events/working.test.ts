import { describe, it, expect } from "vitest";
import { isWorkingNow, countWorking } from "./working";
import { AgentNode, UIState } from "./types";

// 버그: 전진영 차장을 직접 호출(directed run)하면 응답이 ceo-synth 블록으로 흘러
// ceoIntegrating(blocks["ceo-synth"])가 켜지고, 오피스뷰가 CEO+팀장 전원을 '팀간 회의'로
// 모으는데 정작 지명된 직원은 idle 로 남았다(타임라인 "지시 수행 중"과 불일치).
// 수정: run_started 의 directed_agent_id → soloAgentId. 솔로면 그 직원만 working,
// 가짜 팀간회의(다른 팀장·CEO working)는 차단. 비솔로(전사 통합)는 회귀 없이 유지.

function mk(agent_id: string, level: AgentNode["level"], opts: Partial<AgentNode> = {}): AgentNode {
  return {
    agent_id, model: "m", status: "spawned", level,
    persona: { role: agent_id, name: agent_id } as AgentNode["persona"],
    ...opts,
  };
}
type Slice = Pick<UIState, "agents" | "phases" | "engaged" | "blocks" | "status" | "soloAgentId">;
function slice(agents: AgentNode[], over: Partial<Slice> = {}): Slice {
  return {
    agents: Object.fromEntries(agents.map((a) => [a.agent_id, a])),
    phases: {}, engaged: {}, blocks: {}, status: "running", soloAgentId: null, ...over,
  };
}

const ceo = mk("ceo", "ceo");
const leadA = mk("leadA", "lead", { team: "planning" });
const leadB = mk("leadB", "lead", { team: "support" });
const jeon = mk("jeon", "member", { team: "planning" }); // 전진영(팀원)

describe("directed(단독) 런 — 솔로 직원만 working, 가짜 팀간회의 차단", () => {
  it("팀원 단독 호출: 그 팀원만 working, CEO·다른 팀장은 idle(블록 ceo-synth 켜져도)", () => {
    const s = slice([ceo, leadA, leadB, jeon], { soloAgentId: "jeon", blocks: { "ceo-synth": "응답…" } });
    expect(isWorkingNow(jeon, s)).toBe(true);   // 지명 직원 = 작업 중
    expect(isWorkingNow(ceo, s)).toBe(false);   // CEO 팀간회의 아님
    expect(isWorkingNow(leadA, s)).toBe(false); // 팀장도 회의 소집 안 됨
    expect(isWorkingNow(leadB, s)).toBe(false);
    expect(countWorking(s)).toBe(1);            // 사무실에 단 한 명만 작업
  });

  it("CEO 단독(단축경로): CEO만 working, 팀장은 idle", () => {
    const s = slice([ceo, leadA, leadB], { soloAgentId: "ceo", blocks: { "ceo-synth": "즉답…" } });
    expect(isWorkingNow(ceo, s)).toBe(true);
    expect(isWorkingNow(leadA, s)).toBe(false);
    expect(countWorking(s)).toBe(1);
  });

  it("솔로 직원이 placeholder/완료여도 런 종료 전엔 working(런 종료 시 status!=running 으로 자동 해제)", () => {
    const done = slice([ceo, jeon], { soloAgentId: "jeon", blocks: { "ceo-synth": "x" }, status: "ok" });
    expect(isWorkingNow(jeon, done)).toBe(false); // 종료된 런 = 아무도 working 아님
  });
});

// 사용자 피드백: 통합(integrate) 중 오피스뷰가 CEO+팀장을 '팀간 회의'로 모으는데, 타임라인은
// 팀장을 '대기'로 보여 어긋났다. 통합은 CEO 단독 작업(팀장은 보고를 마쳐 대기)으로 통일 →
// isWorkingNow 에서 ceoIntegrating 으로 팀장을 working 집계하지 않는다(CEO만 working).
describe("비솔로(전사 통합) — CEO 단독 통합, 팀장은 보고 끝나 대기", () => {
  it("ceo-synth 스트리밍: CEO만 working, 팀장은 idle(가짜 팀간회의 차단)", () => {
    const s = slice([ceo, leadA, leadB, jeon], { soloAgentId: null, blocks: { "ceo-synth": "통합…" } });
    expect(isWorkingNow(ceo, s)).toBe(true);
    expect(isWorkingNow(leadA, s)).toBe(false);
    expect(isWorkingNow(leadB, s)).toBe(false);
    expect(countWorking(s)).toBe(1);
  });
  it("_ceo phase=integrate + 팀 idle: CEO만 working, 팀장은 idle", () => {
    const s = slice([ceo, leadA, leadB], {
      soloAgentId: null, phases: { _ceo: "integrate", planning: "idle", support: "idle" },
    });
    expect(isWorkingNow(ceo, s)).toBe(true);
    expect(isWorkingNow(leadA, s)).toBe(false);
    expect(isWorkingNow(leadB, s)).toBe(false);
  });
  it("회귀 가드 — 팀장은 report phase 엔 여전히 working", () => {
    const s = slice([ceo, leadA, leadB], { soloAgentId: null, phases: { planning: "report" } });
    expect(isWorkingNow(leadA, s)).toBe(true);   // 보고 종합 중
    expect(isWorkingNow(leadB, s)).toBe(false);  // support 팀은 단계 없음 → 대기
  });
});

// 카드뉴스/숏폼 잡의 렌더링 구간(팀 phase=integrate)은 코드가 이미지·영상을 생성하는
// 단계 — 위임(engaged) 웨이브가 없어 기존 규칙으론 아무도 working이 아니었다(오피스 전체가
// '휴식'으로 보여 검토탭 '생성 중…'과 어긋남). 스폰된 팀원은 engaged 없이 working으로 집계해
// OfficeView '렌더링 중' 버블과 1:1을 유지한다. 팀 스코프 'integrate'는 이 두 잡만 emit.
describe("standby 팀 렌더링(integrate) — engaged 없이 팀원 working", () => {
  const designer = mk("designer", "member", { team: "cardnews" });
  it("팀 phase=integrate: 스폰된 팀원은 위임 웨이브 없이도 working", () => {
    const s = slice([designer], { phases: { cardnews: "integrate" } });
    expect(isWorkingNow(designer, s)).toBe(true);
    expect(countWorking(s)).toBe(1);
  });
  it("placeholder 팀원은 integrate 여도 working 아님", () => {
    const ghost = mk("ghost", "member", { team: "cardnews", placeholder: true });
    const s = slice([designer, ghost], { phases: { cardnews: "integrate" } });
    expect(isWorkingNow(ghost, s)).toBe(false);
    expect(countWorking(s)).toBe(1);
  });
  it("런 종료(status!=running) 시 자동 해제", () => {
    const s = slice([designer], { phases: { cardnews: "integrate" }, status: "ok" });
    expect(isWorkingNow(designer, s)).toBe(false);
  });
  it("회귀 가드 — 다른 팀 팀원은 남의 integrate 에 영향받지 않음", () => {
    const s = slice([designer, jeon], { phases: { cardnews: "integrate" } });
    expect(isWorkingNow(jeon, s)).toBe(false); // planning 팀은 단계 없음 → 대기
  });
});
