import { useMemo } from "react";
import {
  Background,
  Edge,
  Handle,
  MarkerType,
  Node,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { motion } from "framer-motion";
import { useStore } from "../store";
import { AgentNode, Team } from "../events/types";

const STATUS_RING: Record<string, string> = {
  spawned: "#2d3748",
  thinking: "#58a6ff",
  spoke: "#3fb950",
  converged: "#3fb950",
  failed: "#f85149",
  // 지식 노드(공유지식·역할팀 학습) 전용 — 작업 중 '생성 중'(앰버) → finalize 적재 후 '적재완료'(그린).
  "생성 중": "#d29922",
  "적재완료": "#3fb950",
  "대기": "#6b7a99",
};

function NodeCard({ data }: { data: any }) {
  const ring = STATUS_RING[data.status] ?? "#2d3748";
  const pulsing = data.status === "thinking";
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{
        opacity: 1,
        scale: 1,
        boxShadow: pulsing
          ? ["0 0 0 0 rgba(88,166,255,0.0)", "0 0 0 8px rgba(88,166,255,0.18)", "0 0 0 0 rgba(88,166,255,0.0)"]
          : "0 0 0 0 rgba(0,0,0,0)",
      }}
      transition={pulsing ? { boxShadow: { repeat: Infinity, duration: 1.4 } } : { duration: 0.4 }}
      style={{
        background: data.kind === "hub" ? "#1f2a44" : data.kind === "wiki" ? "#1d2b22" : "#161b22",
        border: `2px solid ${data.isCritic ? "#d29922" : ring}`,
        borderRadius: 12,
        padding: "10px 12px",
        width: data.kind === "wiki" ? 150 : 180,
        color: "#e6edf3",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{ fontSize: 11, color: "#8b949e", display: "flex", justifyContent: "space-between" }}>
        <span>{data.kindLabel}</span>
        <span style={{ color: ring }}>{data.status}</span>
      </div>
      <div style={{ fontWeight: 700, fontSize: 13, marginTop: 2 }}>{data.role}</div>
      {data.stance && data.kind === "agent" && (
        <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>입장: {data.stance}</div>
      )}
      {data.streaming && (
        <div style={{ fontSize: 11, marginTop: 6, maxHeight: 54, overflow: "hidden",
          background: "#0d1117", padding: 6, borderRadius: 6, color: "#c9d1d9" }}>
          {data.streaming.slice(-120)}
        </div>
      )}
      {data.kind === "wiki" && (
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: ring }}>{data.count}</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </motion.div>
  );
}

const nodeTypes = { card: NodeCard };

// --- org mode layout: CEO row -> 팀장 row (grouped by team) -> 팀원 row ---
// Reuses NodeCard/status-rings/framer-motion. Returns React Flow nodes + edges.
function orgGraph(
  agents: Record<string, AgentNode>,
  agentOrder: string[],
  blocks: Record<string, string>,
  teamOrder: string[],
  teams: Record<string, Team>,
  lessonCount: number,
  wikiCount: number,
  running: boolean,
  wikiStatus: string,
  lessonStatus: string,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const live = agentOrder
    .map((id) => agents[id])
    .filter((a): a is AgentNode => !!a);
  const ceo = live.find((a) => a.level === "ceo");
  const leads = live.filter((a) => a.level === "lead");
  const members = live.filter((a) => a.level === "member");

  const X0 = 40;
  const MEMBER_W = 200; // horizontal stride between members in a team
  const TEAM_GAP = 80; // empty space between adjacent team columns

  // Lay teams out CUMULATIVELY: each team's column is wide enough for its own
  // members (>=1 slot), so a 3-member team never overlaps the next team. The
  // lead sits at the left edge of its team's slot; members fan out rightward.
  const memberCount: Record<string, number> = {};
  for (const m of members) {
    const tid = m.team ?? "";
    memberCount[tid] = (memberCount[tid] ?? 0) + 1;
  }
  const teamX: Record<string, number> = {};
  let cursor = X0;
  let lastRight = X0;
  teamOrder.forEach((tid) => {
    teamX[tid] = cursor;
    const slots = Math.max(memberCount[tid] ?? 0, 1);
    lastRight = cursor + (slots - 1) * MEMBER_W;
    cursor = lastRight + MEMBER_W + TEAM_GAP;
  });
  const centerX = teamOrder.length > 0 ? (X0 + lastRight) / 2 : X0;

  // CEO (top row)
  if (ceo) {
    const block = ceo.currentBlock ? blocks[ceo.currentBlock] : blocks["ceo-synth"];
    nodes.push({
      id: ceo.agent_id,
      type: "card",
      position: { x: centerX, y: 0 },
      draggable: true,
      data: {
        kind: "agent",
        kindLabel: "CEO",
        role: ceo.persona?.role ?? ceo.agent_id,
        stance: ceo.persona?.stance,
        status: running && ceo.status === "spawned" ? "thinking" : ceo.status,
        isCritic: ceo.persona?.is_critic,
        streaming: block,
      },
    });
  }

  // wiki node (right) + lessons node (right, below wiki) — past the last column
  const rightX = lastRight + MEMBER_W + TEAM_GAP;
  nodes.push({
    id: "wiki",
    type: "card",
    position: { x: rightX, y: 160 },
    draggable: true,
    data: { kind: "wiki", kindLabel: "LLM 위키", role: "공유 지식", status: wikiStatus, count: wikiCount },
  });
  nodes.push({
    id: "lessons",
    type: "card",
    position: { x: rightX, y: 360 },
    draggable: true,
    data: { kind: "wiki", kindLabel: "교훈 메모리", role: "역할·팀 학습", status: lessonStatus, count: lessonCount },
  });
  // 두 지식 노드(공유지식·팀학습)를 오케스트레이터(CEO)에서 항상 연결 — 이전엔 lessons 노드가 어떤 엣지도
  // 없어 고아였고, wiki 도 팀원에서만 연결돼(팀원 없으면 끊김) spoke 가 안 보였다.
  if (ceo) {
    edges.push({ id: "ceo-wiki", source: ceo.agent_id, target: "wiki", animated: running, style: { stroke: "#2f4030", strokeDasharray: "4 4" } });
    edges.push({ id: "ceo-lessons", source: ceo.agent_id, target: "lessons", animated: running, style: { stroke: "#3a3320", strokeDasharray: "4 4" } });
  }

  // 팀장 row (grouped by team x-offset)
  for (const lead of leads) {
    const tid = lead.team ?? "";
    const x = teamX[tid] ?? X0;
    const block = lead.currentBlock ? blocks[lead.currentBlock] : "";
    nodes.push({
      id: lead.agent_id,
      type: "card",
      position: { x, y: 160 },
      draggable: true,
      data: {
        kind: "agent",
        kindLabel: `팀장 · ${teams[tid]?.name ?? tid}`,
        role: lead.persona?.role ?? lead.agent_id,
        stance: lead.persona?.stance,
        status: lead.status,
        isCritic: lead.persona?.is_critic,
        streaming: block,
      },
    });
    if (ceo) {
      edges.push({
        id: `${ceo.agent_id}-${lead.agent_id}`,
        source: ceo.agent_id,
        target: lead.agent_id,
        animated: lead.status === "thinking",
        style: { stroke: "#3b4252" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#3b4252" },
      });
    }
  }

  // 팀원 row (under each team's lead, stacked horizontally within the team slot)
  const byTeam: Record<string, AgentNode[]> = {};
  for (const m of members) {
    const tid = m.team ?? "";
    (byTeam[tid] ??= []).push(m);
  }
  for (const tid of Object.keys(byTeam)) {
    const list = byTeam[tid];
    const lead = leads.find((l) => (l.team ?? "") === tid);
    const baseX = teamX[tid] ?? X0;
    list.forEach((m, i) => {
      const x = baseX + i * MEMBER_W;
      const block = m.currentBlock ? blocks[m.currentBlock] : "";
      nodes.push({
        id: m.agent_id,
        type: "card",
        position: { x, y: 340 },
        draggable: true,
        data: {
          kind: "agent",
          kindLabel: m.persona?.is_critic ? "비평가" : "팀원",
          role: m.persona?.role ?? m.agent_id,
          stance: m.persona?.stance,
          status: m.status,
          isCritic: m.persona?.is_critic,
          streaming: block,
        },
      });
      if (lead) {
        edges.push({
          id: `${lead.agent_id}-${m.agent_id}`,
          source: lead.agent_id,
          target: m.agent_id,
          animated: m.status === "thinking",
          style: { stroke: "#3b4252" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#3b4252" },
        });
      }
      // member contributes to the wiki + 역할·팀 학습(교훈 메모리)
      edges.push({
        id: `${m.agent_id}-w`,
        source: m.agent_id,
        target: "wiki",
        animated: m.status === "thinking",
        style: { stroke: "#2f4030", strokeDasharray: "4 4" },
      });
      edges.push({
        id: `${m.agent_id}-l`,
        source: m.agent_id,
        target: "lessons",
        animated: m.status === "thinking",
        style: { stroke: "#3a3320", strokeDasharray: "4 4" },
      });
    });
  }

  return { nodes, edges };
}

export default function AgentGraph() {
  const agents = useStore((s) => s.agents);
  const agentOrder = useStore((s) => s.agentOrder);
  const blocks = useStore((s) => s.blocks);
  const wikiCount = useStore((s) => s.wikiOrder.length);
  const status = useStore((s) => s.status);
  const teams = useStore((s) => s.teams);
  const teamOrder = useStore((s) => s.teamOrder);
  const lessons = useStore((s) => s.lessons);
  const messages = useStore((s) => s.messages); // 작업 중 '생성 중' 예고 카운트 산출용(팀 산출물·멤버 발언)

  const { nodes, edges } = useMemo(() => {
    const running = status === "running";
    // 노드 카운트 = **이번 세션이 생성한 양**(영속 누적 총량 아님). 공유지식/교훈은 finalize(런 끝)에만 실제
    // 적재되므로(wiki_page_written·lesson_learned) 작업 중엔 0 이다. 두뇌 적재는 그대로 두고(오염 0) UI 만 개선:
    // 작업 중엔 직원 산출물(messages)로 '생성 중' 예고 카운트를 보여주고, finalize 적재 후 실제 수로 확정한다.
    // 직원 산출물만 — 비평(critic 검토)과 사용자 본인 입력(user)은 제외.
    const isWork = (mv: string): boolean => mv !== "critique" && mv !== "user";
    const workOutputs = messages.filter((m) => isWork(m.move)).length; // 팀산출물·멤버발언·반박
    const contributors = new Set(
      messages.filter((m) => m.agent_id && m.agent_id !== "user" && isWork(m.move)).map((m) => m.agent_id),
    ).size;
    const wikiIngested = wikiCount > 0;
    const lessonsIngested = lessons.length > 0;
    const effWiki = wikiIngested ? wikiCount : running ? workOutputs : 0;
    const effLessons = lessonsIngested ? lessons.length : running ? contributors : 0;
    const wikiStatus = wikiIngested ? "적재완료" : running ? "생성 중" : "대기";
    const lessonStatus = lessonsIngested ? "적재완료" : running ? "생성 중" : "대기";

    // ---- org mode: nested CEO -> 팀장 -> 팀원 organization chart ----
    // teamOrder populates on team_spawned (before any member spawns), so it is a
    // reliable early signal that this run is an org run. The debate path below is
    // left untouched for RUN_MODE=debate.
    if (teamOrder.length > 0) {
      return orgGraph(agents, agentOrder, blocks, teamOrder, teams, effLessons, effWiki, running, wikiStatus, lessonStatus);
    }

    const specialists = agentOrder.filter((id) => id.startsWith("agent"));
    const hasAnalyst = agentOrder.includes("analyst");
    const hasSynth = agentOrder.includes("synth");

    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // orchestrator hub
    nodes.push({
      id: "orchestrator", type: "card", position: { x: 360, y: 0 }, draggable: true,
      data: { kind: "hub", kindLabel: "오케스트레이터", role: "주제 분해 · 배분", status: running ? "thinking" : "spoke" },
    });

    // wiki node (right)
    nodes.push({
      id: "wiki", type: "card", position: { x: 760, y: 200 }, draggable: true,
      data: { kind: "wiki", kindLabel: "LLM 위키", role: "공유 지식", status: wikiStatus, count: effWiki },
    });

    const lane = hasAnalyst ? ["analyst"] : specialists;
    const spread = Math.max(lane.length, 1);
    lane.forEach((id, i) => {
      const a: AgentNode | undefined = agents[id];
      if (!a) return;
      const block = a.currentBlock ? blocks[a.currentBlock] : "";
      nodes.push({
        id, type: "card", position: { x: i * 220, y: 200 }, draggable: true,
        data: {
          kind: "agent", kindLabel: a.persona?.is_critic ? "비평가" : "전문가",
          role: a.persona?.role ?? id, stance: a.persona?.stance,
          status: a.status, isCritic: a.persona?.is_critic, streaming: block,
        },
      });
      edges.push({
        id: `o-${id}`, source: "orchestrator", target: id,
        animated: a.status === "thinking",
        style: { stroke: "#3b4252" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#3b4252" },
      });
      // agent contributes to wiki
      edges.push({
        id: `${id}-w`, source: id, target: "wiki",
        animated: a.status === "thinking",
        style: { stroke: "#2f4030", strokeDasharray: "4 4" },
      });
    });

    if (hasSynth) {
      const sy = agents["synth"];
      nodes.push({
        id: "synth", type: "card", position: { x: 360, y: 420 }, draggable: true,
        data: { kind: "agent", kindLabel: "종합자", role: sy?.persona?.role ?? "종합자",
                status: sy?.status ?? "spawned", streaming: blocks["synth"] },
      });
      lane.forEach((id) =>
        edges.push({
          id: `${id}-s`, source: id, target: "synth",
          animated: sy?.status === "thinking",
          style: { stroke: "#3b4252" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#3b4252" },
        }),
      );
    }

    return { nodes, edges };
  }, [agents, agentOrder, blocks, wikiCount, status, teams, teamOrder, lessons, messages]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background color="#1c2430" gap={20} />
      </ReactFlow>
    </div>
  );
}
