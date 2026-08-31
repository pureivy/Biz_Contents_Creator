// Mirror of backend models.py. (scripts/gen_ts_types.py can regenerate this.)
// The wire format every event arrives in:
export interface EventEnvelope {
  v: number;
  type: string;
  run_id: string;
  seq: number;
  ts: string;
  agent_id: string | null;
  parent_id: string | null;
  payload: Record<string, any>;
}

export type EventType =
  | "run_started"
  | "topic_decomposed"
  | "agent_spawned"
  | "task_assigned"
  | "run_done"
  | "agent_thinking"
  | "agent_message"
  | "synthesis_chunk"
  | "debate_message"
  | "critique"
  | "rebuttal"
  | "convergence_state_changed"
  | "wiki_query"
  | "wiki_page_written"
  | "edge_created"
  | "merge"
  | "budget_update"
  | "agent_failed"
  | "rate_limited"
  | "error"
  | "log"
  // org / company hierarchy
  | "company_started"
  | "team_spawned"
  | "delegation"
  | "team_deliverable"
  | "lesson_learned"
  // employee workspace: skill/tool usage, approvals, session digests
  | "tool_used"
  | "skill_loaded"
  | "approval_requested"
  | "approval_decided"
  | "session_digest_written"
  | "user_message";

export interface Persona {
  role: string;        // 직무(안정적 정체성, 예: '전략기획팀장')
  name?: string;       // 현 담당자 실명(인사이동 시 교체) — 직무 우선 표시의 보조
  scope: string;
  stance: string;
  subproblem_id?: string | null;
  is_critic?: boolean;
}

export interface SubProblem {
  id: string;
  text: string;
  deps: string[];
}

// --- folded UI state ---
export type RunStatus =
  | "idle"
  | "running"
  | "ok"
  | "partial"
  | "cancelled"
  | "budget_exceeded"
  | "error"
  | "interrupted";

export interface AgentNode {
  agent_id: string;
  persona: Persona;
  model: string;
  subproblem_id?: string | null;
  status: "spawned" | "thinking" | "spoke" | "failed" | "converged";
  currentBlock?: string; // block_id currently streaming
  // True only for roster-seeded placeholders (an employee shown at their desk who
  // has NOT been spawned in the current run). A real agent_spawned event replaces
  // the placeholder with a live node (placeholder undefined), so the office can tell
  // "engaged now" from "just furniture" — the two otherwise share status:"spawned".
  placeholder?: boolean;
  // org-mode hierarchy (absent in debate mode)
  level?: "ceo" | "lead" | "member";
  team?: string | null;
  // employee workspace graft: declared capability (static) + actual usage (dynamic)
  toolsAllowed?: string[];
  skills?: string[];
  autonomy?: number;
  toolsUsed?: Record<string, number>; // tool name -> invocation count this run
  toolUseCount?: number;              // total invocations (sum of counts)
}

// employee workspace graft: one approval request (pending or decided)
export interface ApprovalItem {
  approval_id: string;
  agent_id?: string | null;
  action_type: string;
  summary: string;
  autonomy?: number;
  status: "pending" | "approved" | "rejected";
  decided_by?: string;
}

// org-mode team registered via team_spawned
export interface Team {
  id: string;
  name: string;
}

export interface DebateMsg {
  seq: number;
  agent_id: string | null;
  round: number;
  move: string; // position | critique | rebuttal
  text: string;
  refs: string[];
}

export interface WikiPage {
  page_id: string;
  slug: string;
  title: string;
  category: string;
  status: string; // draft | contested | converged | superseded
  stance: string;
  by?: string | null;
}

export interface WikiEdge {
  src_id: string;
  dst_id: string;
  relation: string;
  by?: string | null;
}

// One row in the 활동(Activity) feed — a chronological "누가 무엇을 했나" projection.
// Real events are folded into UIState.activity (timestamped by ev.ts → pure & replay-
// safe). Ephemeral office-life (잡담/휴식/산책/통화) is pushed LIVE-ONLY via the store
// (store.liveActivity), since random ambient animation can't be replayed. The feed
// renders s.activity ∪ s.liveActivity, sorted ascending by ts.
export type ActivityKind =
  | "run" | "user" | "spawn" | "team" | "delegation" | "phase"
  | "message" | "critique" | "rebuttal" | "deliverable"
  | "wiki" | "edge" | "tool" | "skill" | "query"
  | "approval" | "lesson" | "session" | "fail"
  | "chat" | "rest" | "stroll" | "phone";

export interface ActivityItem {
  id: string;            // stable React key (`${seq}` for events, `amb-…` for ambient)
  seq?: number;          // event seq — real events only (absent for ambient)
  ts: string;            // ISO timestamp: ev.ts (real) or wall-clock (ambient)
  kind: ActivityKind;
  actorId?: string | null;   // who acted (agent_id, "user", or null for system)
  targetId?: string | null;  // recipient, if any ("A → B")
  label: string;             // action label, e.g. "위키 작성", "잡담"
  detail?: string;           // optional one-line detail (clamped at render)
  tone?: "pro" | "con" | "warn" | "info"; // accent hint for the rail node
}

export interface UIState {
  runId: string | null;
  topic: string;
  status: RunStatus;
  subproblems: SubProblem[];
  debateGated: boolean;
  agents: Record<string, AgentNode>;
  agentOrder: string[];
  messages: DebateMsg[];
  blocks: Record<string, string>; // block_id -> accumulated streaming text
  wikiPages: Record<string, WikiPage>;
  wikiOrder: string[];
  wikiEdges: WikiEdge[];
  synthesis: string;
  convergence: { round: number; state: string; stable_rounds: number } | null;
  budget: { spent_usd: number; cap_usd: number; tokens: number } | null;
  totalCost: number;
  lastSeq: number;
  errors: string[];
  log: string[];
  // org-mode hierarchy state
  teams: Record<string, Team>;
  teamOrder: string[];
  lessons: string[];
  // workflow stage per team (+ "_ceo") for office choreography: brief | decompose |
  // work | debate | report | delegate | idle
  phases: Record<string, string>;
  // currently-engaged member agent_ids per team — the LATEST decompose→delegation wave.
  // Reset when a team re-decomposes, so a RESUMED run's earlier (larger) waves don't keep
  // stale members "working" in the office. engaged ≠ "ever spawned in this run".
  engaged: Record<string, string[]>;
  // 직원 지명(단독) 런의 그 직원 agent_id — 오피스뷰가 가짜 팀간회의 대신 이 직원만 자기 자리에서
  // 작업하게 한다(없으면 전사/토론 런). run_started 에서 세팅, 다음 런 reset 에서 자동 해제.
  soloAgentId: string | null;
  // employee workspace graft
  approvals: ApprovalItem[];          // pending requests awaiting a decision
  approvalHistory: ApprovalItem[];    // decided requests (newest last)
  sessionDigest: { path: string; files: string[] } | null;
  // 활동 피드: real-event projection (folded here so replay/seek rebuilds it too).
  activity: ActivityItem[];
}

export function initialState(): UIState {
  return {
    runId: null,
    topic: "",
    status: "idle",
    subproblems: [],
    debateGated: false,
    agents: {},
    agentOrder: [],
    messages: [],
    blocks: {},
    wikiPages: {},
    wikiOrder: [],
    wikiEdges: [],
    synthesis: "",
    convergence: null,
    budget: null,
    totalCost: 0,
    lastSeq: 0,
    errors: [],
    log: [],
    teams: {},
    teamOrder: [],
    lessons: [],
    phases: {},
    engaged: {},
    soloAgentId: null,
    approvals: [],
    approvalHistory: [],
    sessionDigest: null,
    activity: [],
  };
}
