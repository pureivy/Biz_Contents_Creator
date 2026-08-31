// 🔀 워크플로우 — a live "mission control" board: the macro DISPATCH PROTOCOL phase
// pipeline (위임→작업→토론→보고→통합→완료) + every team member's CURRENT task and the
// time of their last action. Pure projection of the store (phases/agents/activity), so it
// updates live during a run (1s tick for elapsed) and rebuilds correctly on replay/seek.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { AgentNode } from "../events/types";
import { agentColor, agentGlyph, resolveName } from "./agentVisual";
import { isWorkingNow } from "../events/working";
import { TERMINAL, macroStages, soloWorking } from "./workflowStages";
import Avatar from "./Avatar";
import Ico from "./Ico";

const PHASE_LABEL: Record<string, string> = {
  brief: "브리핑", decompose: "업무 분해", assign: "업무 배정", work: "작업 진행",
  debate: "팀 토론", report: "보고", delegate: "위임", review: "검토", integrate: "통합", idle: "대기",
};
function clock(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function ago(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 0) return "방금";
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}분 ${sec % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
// A real run-progress meter for the OFFICE view — a filled, segmented bar across the
// DISPATCH PROTOCOL macro stages (전사: 위임→작업→토론→보고→통합→완료, 솔로: 위임→작업→완료)
// with a %. This is the office's actual 진행률 indicator; it is intentionally distinct from
// the 자료실 책장 (a knowledge shelf, not progress). Hidden when idle (no run yet).
export function OfficeProgressBar() {
  const phases = useStore((st) => st.phases);
  const status = useStore((st) => st.status);
  const soloId = useStore((st) => st.soloAgentId);
  const working = useStore(soloWorking);
  const { stages, cur } = macroStages(phases, status, { id: soloId, working });
  if (cur < 0) return null;
  const pct = Math.round(((cur + 1) / stages.length) * 100); // stages reached / total
  const terminal = TERMINAL.has(status);
  return (
    <div className="office-progress" title="DISPATCH PROTOCOL 진행 단계 (실제 런 진행률)">
      <span className="op-label"><Ico name="chart" size={11} /> 진행률</span>
      <div className="op-track">
        {stages.map((m, i) => {
          const state = terminal ? "done" : i < cur ? "done" : i === cur ? "current" : "pending";
          return (
            <div key={m.key} className={`op-seg ${state}`}>
              <span className="op-seg-label">{m.label}</span>
            </div>
          );
        })}
      </div>
      <span className="op-pct">{pct}%</span>
    </div>
  );
}

// The DISPATCH PROTOCOL stepper — also used compactly at the top of the timeline. 솔로(지명)
// 런은 토론·보고·통합이 없는 축약 파이프라인(위임→작업 진행→완료)으로 표시(macroStages).
export function PhaseStepper({ compact = false }: { compact?: boolean }) {
  const phases = useStore((st) => st.phases);
  const status = useStore((st) => st.status);
  const soloId = useStore((st) => st.soloAgentId);
  const working = useStore(soloWorking);
  const { stages, cur } = macroStages(phases, status, { id: soloId, working });
  if (cur < 0) return null;
  return (
    <div className={`phase-stepper${compact ? " compact" : ""}`}>
      {!compact && <div className="wf-head">DISPATCH PROTOCOL</div>}
      <div className="phase-steps">
        {stages.map((m, i) => {
          const state = i < cur ? "done" : i === cur ? "current" : "pending";
          return (
            <div key={m.key} className={`phase-step ${state}`}>
              <span className="phase-dot">{state === "done" ? "✓" : i + 1}</span>
              <span className="phase-label">{m.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function WorkflowBoard({ names }: { names?: Record<string, string> }) {
  const s = useStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [s.status]);

  // each agent's most-recent activity timestamp = their "last seen working" time.
  const lastTs = useMemo(() => {
    const m: Record<string, string> = {};
    for (const it of s.activity) {
      if (it.actorId && (!m[it.actorId] || it.ts > m[it.actorId])) m[it.actorId] = it.ts;
    }
    return m;
  }, [s.activity]);

  const running = s.status === "running";
  // Uses the shared isWorkingNow rule (events/working.ts) for the working/idle decision
  // so CEO and members don't latch "작업 중" based on raw spawned status. Only the
  // 토론/작업 label distinction (debate phase → 토론 중) is kept locally.
  // Wanted 원칙: 제품 UI 크롬에 이모지 금지 — 상태는 톤 컬러(tone-*) + 라벨로만 전달.
  const statusOf = (a: AgentNode) => {
    if (a.status === "failed") return { label: "오류", cls: "con" };
    if (isWorkingNow(a, s)) {
      const teamPhase = a.team ? s.phases[a.team] : s.phases["_ceo"];
      return teamPhase === "debate"
        ? { label: "토론 중", cls: "info" }
        : { label: "작업 중", cls: "info" };
    }
    if (a.status === "spoke" || a.status === "converged") return { label: "휴식 중", cls: "pro" };
    return { label: "대기", cls: "muted" };
  };

  const Row = (a: AgentNode) => {
    const ms = statusOf(a);
    const ts = lastTs[a.agent_id];
    return (
      <div key={a.agent_id} className="wf-member">
        <Avatar id={a.agent_id} glyph={agentGlyph(a.level, a.agent_id, a.persona?.role ?? "")} size={24} head level={a.level} title={a.persona?.role ?? ""} />
        <div className="wf-member-body">
          <div className="wf-member-top">
            <span className="wf-name" style={{ color: agentColor(a.agent_id) }}>{resolveName(a.agent_id, a.persona, names) || a.persona?.role || a.agent_id}</span>
            <span className={`wf-status tone-${ms.cls}`}>{ms.label}</span>
          </div>
          <div className="wf-time">
            <Ico name="clock" size={10} /> {ts ? clock(ts) : "—"}
            {running && ts && <em className="wf-ago"> · {ago(now - new Date(ts).getTime())} 전</em>}
          </div>
        </div>
      </div>
    );
  };

  const agents = Object.values(s.agents);
  const ceo = agents.find((a) => a.level === "ceo");
  const hasRun = s.teamOrder.length > 0 || agents.length > 0;
  if (!hasRun) {
    return (
      <p className="activity-empty">
        아직 워크플로우가 없습니다. 토론이 시작되면 진행 단계와 팀원별 업무·시간이 여기에 표시됩니다.
      </p>
    );
  }

  return (
    <div className="wf-board">
      <PhaseStepper />
      <div className="wf-section">
        <div className="wf-head">팀원 현황 · 업무 / 시간</div>
        {ceo && (
          <div className="wf-team">
            <div className="wf-team-head">
              <b>CEO · 편집장</b>
              <span className="wf-phase">{PHASE_LABEL[s.phases["_ceo"] ?? "idle"] ?? s.phases["_ceo"] ?? "대기"}</span>
            </div>
            {Row(ceo)}
          </div>
        )}
        {s.teamOrder.map((tid) => {
          const team = s.teams[tid];
          if (!team) return null;
          const lead = agents.find((a) => a.team === tid && a.level === "lead");
          const members = agents.filter((a) => a.team === tid && a.level === "member");
          if (!lead && members.length === 0) return null;
          return (
            <div key={tid} className="wf-team">
              <div className="wf-team-head">
                <b>{team.name}</b>
                <span className="wf-phase">{PHASE_LABEL[s.phases[tid] ?? "idle"] ?? s.phases[tid] ?? "대기"}</span>
              </div>
              {lead && Row(lead)}
              {members.map(Row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
