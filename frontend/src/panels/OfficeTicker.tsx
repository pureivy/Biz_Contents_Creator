// OfficeTicker — 2D 사무실 상단 실시간 상태 띠. ActivityFeed 행과 같은 어휘
// (아바타 + 활동 이모지 + 누구→누구 + 색 순환 깜빡 dot)로 "지금 사무실 상황"을
// 한 줄로 보여준다. 두 모드:
//   · item 있음(유휴 ambient): 아바타 + 이름 [→ 상대] + 이모지 label [+ detail]
//   · item 없음(실행 중/리플레이/빈 사무실): dot + text 멘트
import { ActivityItem, AgentNode } from "../events/types";
import { agentColor, agentGlyph, resolveName } from "./agentVisual";
import { KIND_ICON } from "./ActivityFeed";
import Avatar from "./Avatar";
import Ico from "./Ico";

// 받침 유무에 맞춘 한국어 조사 — 서술형 ticker 문장이 어색하지 않게.
const hasBatchim = (w: string): boolean => {
  const c = w.charCodeAt(w.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
};
export const ga = (w: string) => (w ? (hasBatchim(w) ? "이" : "가") : "이(가)");   // 주격
const wa = (w: string) => (w ? (hasBatchim(w) ? "과" : "와") : "와(과)");   // 공동격

// ambient 사무실 생활을 서술형 한 문장으로. actor 이름은 호출측에서 굵게 렌더하고
// 여기서는 "이/가 …하고 있습니다" 꼬리만 반환한다.
function narrateTail(item: ActivityItem, actor: string, target: string): string {
  const g = ga(actor);
  switch (item.kind) {
    case "rest":   return `${g} 잠시 휴식을 취하고 있습니다`;
    case "chat":   return target ? `${g} ${target}${wa(target)} 이야기를 나누고 있습니다`
                                  : `${g} 동료와 담소를 나누고 있습니다`;
    case "stroll": return `${g} 사무실을 거닐고 있습니다`;
    case "phone":  return `${g} 통화를 하고 있습니다`;
    default:       return `${g} ${item.label} 중입니다`;
  }
}

export default function OfficeTicker({
  item, text, agents, names, live,
}: {
  item: ActivityItem | null;          // 최근 ambient 사무실 생활(있으면 풍부하게 렌더)
  text: string;                       // 실행 중/기본 멘트(item 없을 때)
  agents: Record<string, AgentNode>;
  names: Record<string, string>;      // roster id→title 폴백
  live: boolean;                      // running → 펄스 강조
}) {
  const nameOf = (id?: string | null) => {
    if (!id) return "";
    // 실명직책 우선 → 실명 없으면 로스터(names) 실명직책 → 직무/id (resolveName 공용)
    return resolveName(id, agents[id]?.persona, names) || id;
  };

  if (item && item.actorId) {
    const a = agents[item.actorId];
    // KIND_ICON은 이제 IcoName — 아바타 폴백 문자로는 역할 글리프만 쓴다.
    const glyph = agentGlyph(a?.level ?? "member", item.actorId, a?.persona?.role ?? "");
    const color = agentColor(item.actorId);
    const actorName = nameOf(item.actorId);
    const target = item.targetId ? nameOf(item.targetId) : "";
    const tail = narrateTail(item, actorName, target);
    return (
      <div className="office-ticker live" title={`${actorName}${tail}`}>
        <span className="office-ticker-dot" />
        <Avatar id={item.actorId} glyph={glyph} size={17} head level={a?.level} title={a?.persona?.role ?? ""} />
        <span className="office-ticker-text">
          <b className="office-ticker-actor" style={{ color }}>{actorName}</b>{tail} <Ico name={KIND_ICON[item.kind]} size={11} />
        </span>
      </div>
    );
  }

  return (
    <div className={`office-ticker${live ? " live" : ""}`} title={text}>
      <span className="office-ticker-dot" />
      <span className="office-ticker-text">{text}</span>
    </div>
  );
}
