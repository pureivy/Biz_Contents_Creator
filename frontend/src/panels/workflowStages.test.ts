import { describe, it, expect } from "vitest";
import { currentMacro, soloWorking, macroStages, MACRO, SOLO_MACRO } from "./workflowStages";
import { AgentNode } from "../events/types";

// 버그: 직원 지명(단독) 런은 org phase 이벤트를 내지 않아 phase 기반 진행이 0(위임)에 갇히고,
// 작업이 끝나야 완료로 점프했다("타임라인/워크플로우가 위임에 머물면서 작업은 진행됨").
// 수정: soloAgentId 가 있으면 축약 파이프라인(위임→작업 진행→완료)을 쓰고, 지명 직원이 실제
// 작업을 시작하면(ceo-synth 스트리밍/상태 졸업) '작업 진행'으로 전진한다.

const mk = (id: string, status: AgentNode["status"]): AgentNode => ({
  agent_id: id, model: "m", status, level: "member",
  persona: { role: id, name: id } as AgentNode["persona"],
});

describe("currentMacro — 전사/토론 런(회귀 가드)", () => {
  it("phase 비어있고 running → 0(위임)", () => {
    expect(currentMacro({}, "running")).toBe(0);
  });
  it("어느 팀이 work → 1(작업 진행)", () => {
    expect(currentMacro({ planning: "work" }, "running")).toBe(1);
  });
  it("debate → 2(팀 토론)", () => {
    expect(currentMacro({ planning: "debate" }, "running")).toBe(2);
  });
  it("종료(ok) → 마지막(완료)", () => {
    expect(currentMacro({ planning: "work" }, "ok")).toBe(MACRO.length - 1);
  });
  it("잡 런 종료(done) → 마지막(완료) — integrate 에 갇히지 않음(2026-07-22 실사고 회귀 가드)", () => {
    // 카드뉴스·숏폼 잡 런은 phase work→integrate 를 흘리고 status 'done' 으로 끝난다.
    // 'done' 이 TERMINAL 에 없으면 완료 점프가 안 돼 타임라인이 '통합'에 고정됐다.
    expect(currentMacro({ cardnews: "integrate" }, "done")).toBe(MACRO.length - 1);
  });
});

describe("soloWorking — 지명 직원 작업 시작 신호", () => {
  it("soloAgentId 없으면 false", () => {
    expect(soloWorking({ soloAgentId: null, blocks: {}, agents: {} })).toBe(false);
  });
  it("ceo-synth 블록이 차면 true(스트리밍 중)", () => {
    expect(soloWorking({ soloAgentId: "jeon", blocks: { "ceo-synth": "응답…" }, agents: {} })).toBe(true);
  });
  it("직원 status 가 spawned 졸업(thinking/spoke)하면 true", () => {
    expect(soloWorking({ soloAgentId: "jeon", blocks: {}, agents: { jeon: mk("jeon", "thinking") } })).toBe(true);
    expect(soloWorking({ soloAgentId: "jeon", blocks: {}, agents: { jeon: mk("jeon", "spoke") } })).toBe(true);
  });
  it("막 스폰돼 아직 산출물 전(spawned)이면 false → 위임 단계 유지", () => {
    expect(soloWorking({ soloAgentId: "jeon", blocks: {}, agents: { jeon: mk("jeon", "spawned") } })).toBe(false);
  });
});

describe("macroStages — 솔로 런은 축약 파이프라인, 위임에 갇히지 않음", () => {
  it("솔로 + 작업 시작 → 작업 진행(1), 단계는 3개(위임·작업 진행·완료)", () => {
    const { stages, cur } = macroStages({}, "running", { id: "jeon", working: true });
    expect(stages).toBe(SOLO_MACRO);
    expect(stages.map((s) => s.label)).toEqual(["위임", "작업 진행", "완료"]);
    expect(cur).toBe(1);
  });
  it("솔로 + 작업 전 → 위임(0)", () => {
    expect(macroStages({}, "running", { id: "jeon", working: false }).cur).toBe(0);
  });
  it("솔로 + 종료 → 완료(마지막)", () => {
    expect(macroStages({}, "ok", { id: "jeon", working: true }).cur).toBe(SOLO_MACRO.length - 1);
  });
  it("비솔로(전사/토론) → 6단계 DISPATCH PROTOCOL 유지", () => {
    const { stages, cur } = macroStages({ planning: "work" }, "running", { id: null, working: false });
    expect(stages).toBe(MACRO);
    expect(cur).toBe(1);
  });
});
