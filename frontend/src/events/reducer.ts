// The KEYSTONE: the entire UI is a pure projection of the event stream.
//   uiState = events.reduce(fold, initialState())
// This same reducer drives live streaming today and replay/scrubbing later.
// It must be PURE and never depend on wall-clock or external state.
import {
  ActivityItem,
  ActivityKind,
  AgentNode,
  ApprovalItem,
  DebateMsg,
  EventEnvelope,
  UIState,
  WikiEdge,
  WikiPage,
} from "./types";
import { debateSummary, debateTarget } from "./debateSummary";

// org workflow phase → Korean label for the 활동 피드.
const PHASE_KO: Record<string, string> = {
  brief: "브리핑", decompose: "업무 분해", assign: "업무 배정", work: "작업 진행",
  debate: "팀 토론", report: "보고", delegate: "위임", integrate: "통합", idle: "대기",
};

// collapse whitespace + clamp — keeps an activity detail to one scannable line.
const snippet = (t: unknown, n = 80): string =>
  String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function fold(state: UIState, ev: EventEnvelope): UIState {
  const p = ev.payload || {};
  // Always advance lastSeq (used for resume / dedup).
  const next: UIState = { ...state, lastSeq: Math.max(state.lastSeq, ev.seq) };

  // Build the activity list with one new row stamped by this event's identity
  // (ev.seq/ev.ts → pure, replay-safe). Callers spread it into `activity`.
  const act = (
    kind: ActivityKind,
    label: string,
    o: Partial<ActivityItem> = {},
  ): ActivityItem[] => [
    ...state.activity,
    { id: `e${ev.seq}`, seq: ev.seq, ts: ev.ts, kind, label, ...o },
  ];

  switch (ev.type) {
    case "run_started":
      return {
        ...next, topic: p.topic ?? state.topic, status: "running",
        // 직원 지명(단독) 런이면 그 직원 id — 오피스뷰 솔로 안무 게이트(없으면 null = 전사/토론 런).
        soloAgentId: (p.directed_agent_id as string | undefined) ?? null,
        activity: act("run", "토론 시작", { detail: snippet(p.topic ?? state.topic, 100), tone: "info" }),
      };

    case "company_started":
      // org-mode kickoff; payload key is `goal` (run_started already set topic).
      return {
        ...next, topic: p.goal ?? state.topic, status: "running",
        activity: act("run", "전사 가동 시작", { detail: snippet(p.goal ?? state.topic, 100), tone: "info" }),
      };

    case "team_spawned": {
      const tid = p.team_id ?? p.id;
      if (!tid) return next;
      const team = { id: tid, name: p.name ?? tid };
      return {
        ...next,
        teams: { ...state.teams, [tid]: team },
        teamOrder: state.teamOrder.includes(tid)
          ? state.teamOrder
          : [...state.teamOrder, tid],
        activity: act("team", "팀 출범", { detail: team.name }),
      };
    }

    case "delegation": {
      // Structure (CEO->team, lead->member) is derived in AgentGraph from team/level.
      // We ALSO record lead->member delegations as the team's engaged set — the
      // authoritative "who the lead summoned THIS wave" signal (agent_ids), reset on
      // decompose below. The office uses this instead of cumulative agent_spawned, so a
      // resumed run's earlier waves don't keep stale members working.
      const team = p.team_id as string | undefined;
      const to = (p.to ?? ev.agent_id) as string | undefined;
      if (!team || !to) return next;
      // Always build the activity row — CEO→team delegations were previously early-returned
      // before this point so they never appeared in the 활동 feed.
      const teamName = state.teams[to]?.name ?? to;
      const actRow = act("delegation", "업무 위임", {
        // The delegation event is emitted with agent_id = the RECIPIENT (m.agent_id),
        // so the delegator is payload.from (the lead/CEO). Using ev.agent_id as actor made
        // every row read as a self-delegation ("박정민 → 박정민").
        actorId: (p.from as string) ?? ev.agent_id, targetId: to,
        detail: snippet(p.task ?? p.objective ?? p.summary ?? teamName, 90),
      });
      // CEO→team delegation (to === team_id): log to activity but skip engaged-set update.
      if (to === team) {
        return { ...next, activity: actRow };
      }
      // Lead→member delegation: update the engaged set as before.
      const cur = state.engaged[team] ?? [];
      if (cur.includes(to)) return next;
      return {
        ...next, engaged: { ...state.engaged, [team]: [...cur, to] },
        activity: actRow,
      };
    }

    case "phase": {
      // org workflow stage per team (+ "_ceo"); the office choreographs avatar
      // moves from it (brief→CEO실, debate→table, report→supervisor desk, …).
      const tid = p.team_id as string;
      const phase = p.phase as string;
      if (!tid || !phase) return next;
      // A team starting a fresh cycle (brief/decompose) clears its engaged set, so the
      // upcoming delegation wave defines who works — old waves (esp. on a RESUMED run,
      // where the original larger wave is replayed) don't linger as "working".
      const engaged = (phase === "brief" || phase === "decompose")
        ? { ...state.engaged, [tid]: [] }
        : state.engaged;
      // Only log a real transition (the choreographer can re-emit the same phase).
      const teamName = tid === "_ceo" ? "CEO" : state.teams[tid]?.name ?? tid;
      const changed = state.phases[tid] !== phase;
      return {
        ...next, phases: { ...state.phases, [tid]: phase }, engaged,
        activity: changed
          ? act("phase", PHASE_KO[phase] ?? phase, { detail: teamName })
          : state.activity,
      };
    }

    case "team_deliverable": {
      const msg: DebateMsg = {
        seq: ev.seq,
        agent_id: ev.agent_id, // emitted with no agent_id -> null
        round: 100,
        move: "deliverable",
        text: p.text ?? "",
        refs: [],
      };
      return {
        ...next, messages: [...state.messages, msg],
        activity: act("deliverable", "팀 산출물", {
          actorId: ev.agent_id, detail: snippet(p.text), tone: "pro",
        }),
      };
    }

    case "lesson_learned": {
      const title = (p.title ?? "").trim();
      if (!title) return next;
      return {
        ...next, lessons: [...state.lessons, title],
        activity: act("lesson", "교훈 기록", { detail: title }),
      };
    }

    case "topic_decomposed":
      return {
        ...next,
        subproblems: p.subproblems ?? [],
        debateGated: !!p.debate_gated,
        activity: act("phase", "주제 분해", {
          detail: `하위 문제 ${(p.subproblems ?? []).length}개`,
        }),
      };

    case "agent_spawned": {
      const id = p.agent_id ?? ev.agent_id;
      if (!id) return next;
      const node: AgentNode = {
        agent_id: id,
        persona: p.persona,
        model: p.model ?? "",
        subproblem_id: p.persona?.subproblem_id ?? null,
        status: "spawned",
        level: p.persona?.level,
        team: p.persona?.team ?? null,
        // declared capability surface rides the persona (employee graft)
        toolsAllowed: p.persona?.tools_allowed,
        skills: p.persona?.skills,
        autonomy: p.persona?.autonomy,
        toolsUsed: {},
        toolUseCount: 0,
      };
      const known = state.agentOrder.includes(id);
      return {
        ...next,
        agents: { ...state.agents, [id]: node },
        agentOrder: known ? state.agentOrder : [...state.agentOrder, id],
        // Only the FIRST spawn (출근) is an event; re-spawns on resume are silent.
        // No detail — the actor name + "출근" chip already says it (avoids 이름/이름 중복).
        activity: known ? state.activity : act("spawn", "출근", { actorId: id }),
      };
    }

    case "skill_loaded": {
      const id = p.agent_id ?? ev.agent_id;
      const a = id ? state.agents[id] : undefined;
      if (!id || !a) return next;
      return {
        ...next,
        agents: {
          ...state.agents,
          [id]: {
            ...a,
            toolsAllowed: p.tools_allowed ?? a.toolsAllowed,
            skills: p.skills ?? a.skills,
            autonomy: p.autonomy ?? a.autonomy,
          },
        },
      };
    }

    case "tool_used": {
      const id = p.agent_id ?? ev.agent_id;
      const a = id ? state.agents[id] : undefined;
      const tool = (p.tool as string) || "";
      if (!id || !a || !tool) return next;
      const short = tool.includes("__") ? tool.split("__").pop()! : tool;
      const used = { ...(a.toolsUsed ?? {}) };
      used[short] = (used[short] ?? 0) + 1;
      return {
        ...next,
        agents: {
          ...state.agents,
          [id]: { ...a, toolsUsed: used, toolUseCount: (a.toolUseCount ?? 0) + 1 },
        },
        activity: act("tool", "툴 사용", { actorId: id, detail: short }),
      };
    }

    case "approval_requested": {
      const item: ApprovalItem = {
        approval_id: p.approval_id,
        agent_id: ev.agent_id ?? p.agent_id ?? null,
        action_type: p.action_type ?? "action",
        summary: p.summary ?? "",
        autonomy: p.autonomy,
        status: "pending",
      };
      if (!item.approval_id || state.approvals.some((x) => x.approval_id === item.approval_id))
        return next;
      return {
        ...next, approvals: [...state.approvals, item],
        activity: act("approval", "승인 요청", {
          actorId: item.agent_id, detail: snippet(`${item.action_type} — ${item.summary}`, 90), tone: "warn",
        }),
      };
    }

    case "approval_decided": {
      const aid = p.approval_id;
      if (!aid) return next;
      const decided = state.approvals.find((x) => x.approval_id === aid);
      const moved: ApprovalItem | null = decided
        ? { ...decided, status: p.approved ? "approved" : "rejected", decided_by: p.decided_by }
        : null;
      return {
        ...next,
        approvals: state.approvals.filter((x) => x.approval_id !== aid),
        approvalHistory: moved ? [...state.approvalHistory, moved] : state.approvalHistory,
        activity: act("approval", p.approved ? "승인됨" : "거부됨", {
          actorId: moved?.agent_id ?? null,
          detail: p.decided_by ? `결정: ${p.decided_by}` : undefined,
          tone: p.approved ? "pro" : "con",
        }),
      };
    }

    case "session_digest_written":
      return {
        ...next, sessionDigest: { path: p.path ?? "", files: p.files ?? [] },
        activity: act("session", "세션 산출물 저장", { detail: `${(p.files ?? []).length}개 파일` }),
      };

    case "user_message": {
      const msg: DebateMsg = {
        seq: ev.seq,
        agent_id: "user",
        round: 0,
        move: "user",
        text: p.text ?? "",
        refs: [],
      };
      return {
        ...next, messages: [...state.messages, msg],
        activity: act("user", "지시", { actorId: "user", detail: snippet(p.text, 100), tone: "info" }),
      };
    }

    case "task_assigned": {
      const id = p.agent_id ?? ev.agent_id;
      const a = id ? state.agents[id] : undefined;
      if (!a) return next;
      return {
        ...next,
        agents: {
          ...state.agents,
          [id]: { ...a, subproblem_id: p.subproblem_id ?? a.subproblem_id },
        },
      };
    }

    case "agent_thinking": {
      const id = ev.agent_id;
      const block = p.block_id as string;
      if (!block) return next;
      const prevText = state.blocks[block] ?? "";
      const blocks = { ...state.blocks, [block]: prevText + (p.delta ?? "") };
      const agents = { ...state.agents };
      if (id && agents[id]) {
        agents[id] = { ...agents[id], status: "thinking", currentBlock: block };
      }
      return { ...next, blocks, agents };
    }

    case "synthesis_chunk": {
      const block = (p.block_id as string) || "synth";
      const prevText = state.blocks[block] ?? "";
      const blocks = { ...state.blocks, [block]: prevText + (p.delta ?? "") };
      return { ...next, blocks, synthesis: state.synthesis + (p.delta ?? "") };
    }

    case "agent_message":
    case "debate_message":
    case "critique":
    case "rebuttal": {
      const move = p.move ?? (ev.type === "debate_message" ? "position" : ev.type);
      const msg: DebateMsg = {
        seq: ev.seq,
        agent_id: ev.agent_id,
        round: p.round ?? 0,
        move,
        text: p.text ?? "",
        refs: p.refs ?? [],
      };
      const agents = { ...state.agents };
      if (ev.agent_id && agents[ev.agent_id]) {
        agents[ev.agent_id] = { ...agents[ev.agent_id], status: "spoke" };
      }
      const kind: ActivityKind =
        move === "critique" ? "critique" : move === "rebuttal" ? "rebuttal" : "message";
      const moveLabel = move === "critique" ? "검토 의견"
        : move === "rebuttal" ? "반박"
        : move === "position" ? "주장" : "발언";
      // A rebuttal/critique addresses a specific colleague → "발언자 → 대상" arrow; a
      // round-1 주장 is to the whole team, so it has no single target.
      const target = (move === "rebuttal" || move === "critique")
        ? debateTarget(p.text, ev.agent_id ?? "", state.agents)
        : null;
      // 산출물 패널 폴백: 종합(ceo-synth/stage=synthesis) agent_message 가 도착했는데
      // synthesis_chunk 델타가 0이라 s.synthesis 가 비면(비스트리밍/버퍼링 모델) 본문으로 채움.
      const synthesis =
        ev.type === "agent_message" &&
        (p.block_id === "ceo-synth" || p.stage === "synthesis") &&
        !state.synthesis.trim()
          ? (p.text ?? state.synthesis)
          : state.synthesis;
      return {
        ...next, messages: [...state.messages, msg], agents, synthesis,
        // The debate detail is the agent's CONCLUSION/rebuttal (not the "이제 …확인합니다"
        // process-narration opening) — see debateSummary for the extraction heuristic.
        activity: act(kind, moveLabel, { actorId: ev.agent_id, targetId: target, detail: debateSummary(p.text) }),
      };
    }

    case "wiki_page_written": {
      const page: WikiPage = {
        page_id: p.page_id,
        slug: p.slug,
        title: p.title ?? p.slug,
        category: p.category ?? "claim",
        status: p.status ?? "draft",
        stance: p.stance ?? "neutral",
        by: ev.agent_id,
      };
      const exists = !!state.wikiPages[page.page_id];
      return {
        ...next,
        wikiPages: { ...state.wikiPages, [page.page_id]: page },
        wikiOrder: exists ? state.wikiOrder : [...state.wikiOrder, page.page_id],
        activity: act("wiki", exists ? "위키 갱신" : "위키 작성", {
          actorId: ev.agent_id, detail: page.title, tone: "info",
        }),
      };
    }

    case "edge_created": {
      const edge: WikiEdge = {
        src_id: p.src_id,
        dst_id: p.dst_id,
        relation: p.relation,
        by: p.by ?? ev.agent_id,
      };
      return {
        ...next, wikiEdges: [...state.wikiEdges, edge],
        activity: act("edge", "관계 생성", {
          actorId: p.by ?? ev.agent_id,
          detail: snippet(`${state.wikiPages[p.src_id]?.title ?? p.src_id} —${p.relation}→ ${state.wikiPages[p.dst_id]?.title ?? p.dst_id}`, 90),
        }),
      };
    }

    case "convergence_state_changed":
      return {
        ...next,
        convergence: {
          round: p.round ?? 0,
          state: p.state ?? "diverging",
          stable_rounds: p.stable_rounds ?? 0,
        },
      };

    case "budget_update":
      return {
        ...next,
        budget: {
          spent_usd: p.spent_usd ?? 0,
          cap_usd: p.cap_usd ?? 0,
          tokens: p.tokens ?? 0,
        },
      };

    case "agent_failed": {
      const id = p.agent_id ?? ev.agent_id;
      const a = id ? state.agents[id] : undefined;
      const agents = { ...state.agents };
      // An isolated failure is contained by design — the run continues with the
      // survivors, and the agent has usually already delivered earlier work. So it does
      // NOT brand the avatar "⚠ 오류": that would overwrite its last real status (spoke/
      // converged) and nag forever, especially on a replayed/resumed run. Only a
      // non-isolated (fatal) failure marks the node failed. Either way the error is
      // recorded in the activity log; the persistent error banner stays for fatal only.
      if (id && a && !p.isolated) agents[id] = { ...a, status: "failed" };
      const note = `agent ${id} failed: ${p.error ?? "unknown"}`;
      const failAct = act("fail", p.isolated ? "오류(격리됨)" : "오류", {
        actorId: id, detail: snippet(p.error ?? "unknown", 90), tone: "con",
      });
      return p.isolated
        ? { ...next, agents, log: [...state.log, note], activity: failAct }
        : { ...next, agents, errors: [...state.errors, note], activity: failAct };
    }

    case "rate_limited":
      return {
        ...next,
        log: [...state.log, `rate limited, backoff ${p.backoff_s ?? "?"}s`],
      };

    case "run_done": {
      const status = (p.status as UIState["status"]) ?? "ok";
      // A cancelled/isolated-failed stream never gets a closing agent_message
      // (loop.py:243, direct_loop.py:171, session.py:146), so "thinking" would
      // latch forever (live card + ✍️ 작업 중). Park them as spoke at run end.
      let agents = state.agents;
      if (Object.values(state.agents).some((a) => a.status === "thinking")) {
        agents = Object.fromEntries(
          Object.entries(state.agents).map(([id, a]) => [
            id,
            a.status === "thinking"
              ? { ...a, status: "spoke" as const, currentBlock: undefined }
              : a,
          ]),
        );
      }
      const DONE_KO: Record<string, string> = {
        ok: "토론 완료", partial: "부분 완료", cancelled: "취소됨",
        budget_exceeded: "예산 초과", error: "오류 종료",
      };
      return {
        ...next, status, agents, totalCost: p.total_cost_usd ?? state.totalCost,
        activity: act("run", DONE_KO[status] ?? "종료", { tone: status === "ok" ? "pro" : "warn" }),
      };
    }

    case "error":
      return {
        ...next,
        errors: [...state.errors, `${p.scope ?? ""}: ${p.message ?? ""}`],
      };

    case "log":
      return { ...next, log: [...state.log, p.message ?? ""] };

    case "wiki_query": {
      // 위키 그라운딩(임베딩 의미검색 포함) — '무엇으로 그라운딩했나'를 활동피드에 표시.
      const id = p.agent_id ?? ev.agent_id;
      const hits = Array.isArray(p.hits) ? (p.hits as Array<{ page_id?: string }>) : [];
      if (!id || !hits.length) return next;
      const slugs = hits.slice(0, 3).map((h) => h.page_id).filter(Boolean).join(", ");
      return { ...next, activity: act("query", "그라운딩", { actorId: id as string, detail: `${hits.length}개 자료 참조${slugs ? `: ${slugs}` : ""}` }) };
    }

    default:
      return next;
  }
}
