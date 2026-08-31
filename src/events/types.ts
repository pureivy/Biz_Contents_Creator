/**
 * 이벤트 스키마 — 백엔드와 프론트엔드가 공유하는 단일 진실원.
 *
 * 원본 GEPA models.py 의 와이어 포맷을 그대로 계승한다 → 기존 React 프론트(frontend/)가
 * 수정 없이 이 백엔드의 SSE 스트림을 접을(fold) 수 있다. 규칙:
 *   1) 각 payload 는 자기완결적(델타는 block_id, 엣지는 양끝점, spawn 은 페르소나 전체를 들고 옴).
 *   2) seq 는 이벤트 버스가 런 단위 단조증가로 찍고, SSE event id(Last-Event-ID 재개)로도 쓰인다.
 */

export const SCHEMA_VERSION = 1;

export const EventType = {
  // lifecycle
  run_started: 'run_started',
  topic_decomposed: 'topic_decomposed',
  agent_spawned: 'agent_spawned',
  task_assigned: 'task_assigned',
  run_done: 'run_done',
  // streaming text
  agent_thinking: 'agent_thinking', // coalesced token deltas
  agent_message: 'agent_message',   // 완성된 메시지(전체 텍스트)
  synthesis_chunk: 'synthesis_chunk',
  // debate
  debate_message: 'debate_message',
  critique: 'critique',
  rebuttal: 'rebuttal',
  convergence_state_changed: 'convergence_state_changed',
  // wiki / knowledge graph
  wiki_query: 'wiki_query',
  wiki_page_written: 'wiki_page_written',
  edge_created: 'edge_created',
  merge: 'merge',
  // governance / diagnostics
  budget_update: 'budget_update',
  agent_failed: 'agent_failed',
  rate_limited: 'rate_limited',
  error: 'error',
  log: 'log',
  // org / company hierarchy
  company_started: 'company_started',
  team_spawned: 'team_spawned',
  delegation: 'delegation',
  team_deliverable: 'team_deliverable',
  lesson_learned: 'lesson_learned',
  // employee workspace
  tool_used: 'tool_used',
  skill_loaded: 'skill_loaded',
  approval_requested: 'approval_requested',
  approval_decided: 'approval_decided',
  session_digest_written: 'session_digest_written',
  user_message: 'user_message',
  phase: 'phase',
  // 진단/관측: 로컬 LLM 성능(원본에 없던 추가) — 턴별 토큰/속도 가시화
  llm_metric: 'llm_metric',
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

export interface EventEnvelope<P = Record<string, unknown>> {
  v: number;
  type: EventTypeName;
  run_id: string;
  seq: number;
  ts: string;
  agent_id?: string;
  parent_id?: string;
  payload: P;
}

// --- 대표 payload 타입 (emit 지점 문서화 + 프론트 타입 생성용) ---

export type Stance = 'pro' | 'con' | 'neutral' | 'nuanced' | 'critic';

export interface Persona {
  role: string;
  name?: string; // 담당자 실명(있으면) — 아바타·타임라인에 '실명 직책' 표시
  team?: string | null; // 소속 팀 id — OfficeView 팀별 좌석·engaged·phase 안무 매칭
  scope: string;
  stance: Stance;
  subproblem_id?: string;
  is_critic: boolean;
}

export interface SubProblem {
  id: string;
  text: string;
  deps: string[];
}

export interface RunStartedPayload {
  topic: string;
  config: Record<string, unknown>;
}

export interface TopicDecomposedPayload {
  subproblems: SubProblem[];
  debate_gated: boolean;
}

export interface AgentSpawnedPayload {
  agent_id: string;
  persona: Persona;
  model: string;
}

export interface AgentThinkingPayload {
  block_id: string;
  delta: string;
}

export interface AgentMessagePayload {
  block_id: string;
  text: string;
  round?: number;
}

export interface ConvergenceStatePayload {
  round: number;
  state: 'diverging' | 'converging' | 'converged' | 'irreconcilable';
  stable_rounds: number;
}

export interface RunDonePayload {
  status: 'ok' | 'cancelled' | 'error';
  deliverable_ref?: string;
}

export interface TeamSpawnedPayload {
  team_id: string;
  name: string;
  lead: string;
  members: string[];
}

export interface ApprovalRequestedPayload {
  approval_id: string;
  agent_id?: string;
  action_type: string;
  summary: string;
  autonomy: number;
}

/** 로컬 LLM 관측 — 진단·벤치마크용(원본 대비 추가). */
export interface LlmMetricPayload {
  agent_id: string;
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  total_ms: number;
  load_ms: number;
  tok_per_s: number;
  truncated: boolean;
  stage: string;
}
