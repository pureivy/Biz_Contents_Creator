// 활동 피드 — a chronological "누가 무엇을 했나" stream for the 토론 타임라인 창.
// Pure projection: it just renders the merged (s.activity ∪ s.liveActivity) list it's
// given. Real-event rows come from the reducer (replay-safe); ambient office-life
// (잡담/휴식/산책/통화) is pushed live by OfficeView. Rows read like the reference:
//   07:52:48 · ●─ [avatar] 박정민 → 코다리  (위키 작성)  detail…
import { ActivityItem, ActivityKind, AgentNode, Team } from "../events/types";
import { agentColor, agentGlyph, resolveName } from "./agentVisual";
import { toolVisual } from "./toolVisual";
import Avatar from "./Avatar";
import Ico, { type IcoName } from "./Ico";

// 이벤트 종류 → Wanted 아이콘(Ico). 어휘는 다른 크롬과 일치(비평=eye · 검색=search ·
// 산출물=document · 승인=bell · 실패=triangle-exclamation).
export const KIND_ICON: Record<ActivityKind, IcoName> = {
  run: "play", user: "person", spawn: "home", team: "bookmark", delegation: "send", phase: "filter",
  message: "chat", critique: "eye", rebuttal: "bubble", deliverable: "document",
  wiki: "pencil", edge: "share", tool: "setting", skill: "sparkle", query: "search",
  approval: "bell", lesson: "sparkle-line", session: "document", fail: "triangle-exclamation",
  chat: "bubble", rest: "moon", stroll: "location", phone: "phone",
};

// 24h zero-padded HH:MM:SS straight from the Date — locale-independent (matches the
// reference's 07:52:48), and tolerant of a bad/empty ts.
function clock(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function ActivityFeed({
  items,
  agents,
  teams,
  names = {},
}: {
  items: ActivityItem[];
  agents: Record<string, AgentNode>;
  teams: Record<string, Team>;
  names?: Record<string, string>; // roster id→title fallback (pre-run, before agent_spawned)
}) {
  if (items.length === 0) {
    return <p className="activity-empty">아직 활동이 없습니다. 토론이 진행되면 여기에 누가 무엇을 했는지 쌓입니다.</p>;
  }

  // agent_id → display name. live persona (during a run) → roster title (pre-run
  // ambient) → team name → raw id, so every actor reads sensibly in any mode.
  const nameOf = (id?: string | null): string => {
    if (!id) return "시스템";
    if (id === "user") return "나";
    // 실명직책 우선 → 실명 없으면 로스터(names) 실명직책 → 팀명/직무/id (resolveName 공용)
    return resolveName(id, agents[id]?.persona, names) || teams[id]?.name || id;
  };

  // Agents often title their own artifacts with their name ("박정민 과장 — 검증보고…").
  // The row already shows the actor, so strip a leading actor-name prefix from the detail
  // to avoid the redundant "박정민 과장 / 박정민 과장 — …" stutter.
  const cleanDetail = (detail: string, actorName: string): string => {
    const t = detail.trimStart();
    if (actorName && actorName !== "시스템" && actorName !== "나" && t.startsWith(actorName)) {
      const rest = t.slice(actorName.length).replace(/^\s*[—–\-:·|]\s*/, "").trimStart();
      return rest || detail;
    }
    return detail;
  };

  return (
    <div className="activity-feed">
      {items.map((it) => {
        const actor = it.actorId ?? null;
        const isPerson = !!actor && actor !== "user"; // render the portrait for any employee
        const color = isPerson ? agentColor(actor!) : undefined;
        const a = actor ? agents[actor] : undefined;
        // glyph only shows if the avatar image is missing — always the role glyph
        // (KIND_ICON은 이제 IcoName이라 아바타 폴백 문자로 못 쓴다).
        const glyphFallback = agentGlyph(a?.level ?? "member", actor ?? "", a?.persona?.role ?? "");
        return (
          <div key={it.id} className={`act-row kind-${it.kind}${it.tone ? ` tone-${it.tone}` : ""}`}>
            <span className="act-time">{clock(it.ts)}</span>
            <span className="act-rail" aria-hidden />
            <div className="act-main">
              <div className="act-line">
                {isPerson ? (
                  <Avatar id={actor!} glyph={glyphFallback} size={18} head level={a?.level} title={a?.persona?.role ?? ""} />
                ) : (
                  <span className="act-glyph"><Ico name={KIND_ICON[it.kind]} size={13} /></span>
                )}
                <b className="act-actor" style={color ? { color } : undefined}>{nameOf(actor)}</b>
                {it.targetId && (
                  <>
                    <span className="act-arrow">→</span>
                    <b className="act-target">{nameOf(it.targetId)}</b>
                  </>
                )}
                <span className="act-chip">
                  {it.kind === "tool"
                    ? (() => { const tv = toolVisual(it.detail); return <><Ico name={tv.icon} size={10} /> {tv.label}</>; })()
                    : <><Ico name={KIND_ICON[it.kind]} size={10} /> {it.label}</>}
                </span>
              </div>
              {it.detail && it.kind !== "tool" && <div className="act-detail">{cleanDetail(it.detail, nameOf(actor))}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
