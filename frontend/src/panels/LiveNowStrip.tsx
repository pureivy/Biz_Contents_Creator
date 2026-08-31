// 타임라인 상단 '지금 작업 중' 띠 — **팀별로 묶어서** 보여준다. 각 팀 섹션은 팀명 +
// 현재 단계 배지(보고·취합 중 / 상호검증 토론 중 …)를 헤더로 갖고, 그 밑에 그 팀의 작업
// 중인 팀원(팀장 먼저)을 **2줄 현황**(무엇을/어떻게)으로 나열한다. CEO는 별도 섹션.
// store 파생(리플레이 안전), 런이 살아있을 때만(status==="running") 노출.
import { useStore } from "../store";
import { isWorkingNow } from "../events/working";
import { agentColor, agentGlyph, resolveName } from "./agentVisual";
import { debateGist } from "../events/debateSummary";
import { gistLines } from "./timelineGist";
import { ActivityItem, AgentNode } from "../events/types";
import Avatar from "./Avatar";

const PHASE_DOING: Record<string, string> = {
  brief: "브리핑 받는 중", decompose: "과제 분해 중", assign: "과제 배정 중",
  work: "작업 중", debate: "상호검증 토론 중", report: "팀원 보고 검토·취합 중",
  report_ceo: "편집장께 보고 중", delegate: "지침 수립 중", review: "검토·확정 중",
  integrate: "산출물 통합 중", idle: "대기",
};

// 팀장/CEO 전용 phase 라벨 — 오피스뷰의 팀장 말풍선(분해/배정/검토)과 의미를 일치시켜
// 두 뷰가 같은 단계를 같은 말로 보이게 한다(팀장은 '작업'이 아니라 분해·배정·취합을 한다).
// 'work' 구간엔 팀장이 일하지 않아(isWorkingNow에서 제외) 이 띠에 아예 안 뜨므로 '대기'로 둔다.
const LEAD_PHASE_DOING: Record<string, string> = {
  brief: "지시 받는 중", decompose: "과제 분해 중", assign: "과제 배정 중",
  work: "대기", debate: "회의 주재 중", report: "팀원 보고 검토·취합 중",
  report_ceo: "편집장께 보고 중", delegate: "지침 수립 중", review: "검토·확정 중",
  integrate: "산출물 통합 중", idle: "대기",
};

// 작업자의 '현재 행동' — 가장 최근 활동(툴/위키/스킬/발언)을 '…중' 라벨로 매핑. line2가
// substantive하지 않을 때(아직 첫 줄만 산출) "작업 중" 대신 무엇을 하는지 구체화한다.
const TOOL_ACTION: Array<[RegExp, string]> = [
  [/wiki_(query|list|read|search)/i, "위키 검색 중"],
  [/wiki_(save|add|ingest|write|page)/i, "위키 기록 중"],
  // 신규 백엔드 도구 — 일반 search/web 패턴보다 먼저 둬야 law_search/dart_search 가 '웹 조사'로 오분류되지 않는다.
  [/^law/i, "법령 조회 중"],
  [/^dart/i, "공시 조회 중"],
  [/save_note/i, "노트 기록 중"],
  [/run_command|shell/i, "셸 실행 중"],
  [/(^read$|read_source)/i, "원자료 읽는 중"],
  [/^(write|edit|notebookedit)$/i, "문서 작성 중"],
  [/(bash|python|repl|run_code)/i, "데이터 분석 중"],
  [/(web|fetch|search)/i, "웹 조사 중"],
  [/(docx|xlsx|hwpx?|pdf|pptx)/i, "문서 작성 중"],
  [/(kosis|public_data|bizinfo|stat)/i, "통계 조회 중"],
  [/(grep|glob|find)/i, "자료 탐색 중"],
  [/ask_colleague/i, "동료에게 문의 중"],
];
function actionLabel(it: ActivityItem): string {
  switch (it.kind) {
    case "tool": {
      const d = it.detail ?? "";
      for (const [re, label] of TOOL_ACTION) if (re.test(d)) return label;
      return d ? `${d} 사용 중` : "도구 사용 중";
    }
    case "wiki": return "위키 기록 중";
    case "query": return "자료 검색 중";
    case "skill": return it.detail ? `${it.detail} 사용 중` : "스킬 사용 중";
    case "message": case "rebuttal": return "보고 작성 중";
    case "critique": return "교차검증 중";
    case "delegation": return "과제 받는 중";
    default: return "";
  }
}

interface Group { key: string; title: string; phase?: string; members: AgentNode[]; }

export default function LiveNowStrip({ names }: { names: Record<string, string> }) {
  const s = useStore();
  if (s.status !== "running") return null;
  const working = s.agentOrder.map((id) => s.agents[id]).filter((a): a is AgentNode => !!a && isWorkingNow(a, s));
  if (!working.length) return null;

  // 작업자별 '현재 행동'(가장 최근 활동) — activity를 한 번만 역순 스캔해 첫(=최신) 매핑.
  const lastAction: Record<string, string> = {};
  for (let i = s.activity.length - 1; i >= 0; i--) {
    const it = s.activity[i];
    // 위임은 '받는' 행위 → 수신자(targetId=팀원)에게 붙인다. actorId(=위임 준 팀장)에 붙이면
    // 팀장이 '과제 받는 중'으로 잘못 표시된다(팀장은 주는 쪽).
    if (it.kind === "delegation") {
      if (it.targetId && !lastAction[it.targetId]) lastAction[it.targetId] = "과제 받는 중";
      continue;
    }
    if (!it.actorId || lastAction[it.actorId]) continue;
    const lbl = actionLabel(it);
    if (lbl) lastAction[it.actorId] = lbl;
  }

  // 팀별 그룹핑(CEO 별도). 순서: CEO → s.teamOrder. 각 팀 내 팀장 먼저.
  const groups: Group[] = [];
  const ceo = working.filter((a) => a.level === "ceo");
  if (ceo.length) groups.push({ key: "_ceo", title: "CEO", phase: s.phases["_ceo"], members: ceo });
  for (const tid of s.teamOrder) {
    const ms = working.filter((a) => a.team === tid && a.level !== "ceo");
    if (!ms.length) continue;
    ms.sort((a, b) => (b.level === "lead" ? 1 : 0) - (a.level === "lead" ? 1 : 0));
    groups.push({ key: tid, title: s.teams[tid]?.name ?? tid, phase: s.phases[tid], members: ms });
  }
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.agent_id)));
  const orphans = working.filter((a) => !grouped.has(a.agent_id));
  if (orphans.length) groups.push({ key: "_other", title: "기타", members: orphans });

  return (
    <div className="livenow">
      <div className="livenow-head"><span className="livenow-dot" /> 지금 작업 중 · {working.length}</div>
      {groups.map((g) => (
        <div key={g.key} className="livenow-group">
          <div className="livenow-group-head">
            <b className="livenow-team">{g.title}</b>
            {/* 팀 스코프 integrate = standby 팀(카드뉴스/숏폼) 렌더링 — CEO 통합 문구와 구분. */}
            <span className="livenow-badge">{(g.key !== "_ceo" && g.phase === "integrate" ? "렌더링 중" : PHASE_DOING[g.phase ?? ""]) || "작업 중"}</span>
            <span className="livenow-count">{g.members.length}명</span>
          </div>
          <div className="livenow-cards">
            {g.members.map((a) => {
              const label = resolveName(a.agent_id, a.persona, names) || a.agent_id;
              const stream = a.currentBlock ? (s.blocks[a.currentBlock] ?? "") : "";
              const task = (a.subproblem_id ?? "").trim();
              // 팀장/CEO 는 phase 전용 라벨(분해·배정·진행 점검·검토) — 오피스뷰와 의미 일치.
              const isLead = a.level === "lead" || a.level === "ceo";
              const rendering = g.key !== "_ceo" && g.phase === "integrate"; // standby 팀 렌더링
              const phaseDoing = rendering ? "렌더링 중"
                : (isLead ? LEAD_PHASE_DOING[g.phase ?? ""] : PHASE_DOING[g.phase ?? ""]) || "작업 중";
              // 2줄 현황(직원명 제외, '무슨 일을 하는지'). 스트리밍이면 debateGist(무엇=headline
              // / 어떻게·왜=detail). detail이 비는 스트림(단독 지명·짧은 산출)에선 2번째 줄을
              // 배정 과제 → 단계 행동으로 폴백해 **항상 2줄**을 보장(1줄 회귀 방지).
              let l1 = "", l2 = "";
              if (isLead) {
                // 팀장/CEO는 오케스트레이터 — report 종합 등에서 스트리밍을 하더라도 1번째 줄은
                // 항상 단계 라벨(검토·취합 중 등)로 고정해 gist headline의 모호한 "작업중" 폴백이
                // l1을 덮지 않게 한다(사용자가 본 "작업중" 폴백 차단). 스트림 gist는 2번째 줄로.
                l1 = phaseDoing;
                if (stream.trim()) {
                  const gi = debateGist(stream);
                  l2 = gi.headline && gi.headline !== l1 ? gi.headline : gi.detail;
                }
              } else if (rendering) {
                // 렌더링 구간 팀원 — 지금 스트리밍 중이 아니라 직전 디자인 턴의 JSON 응답이
                // 블록에 latch돼 있다(reducer는 run_done에서만 정리) → gist가 JSON 조각을
                // 1줄 현황으로 뽑는다. 스트림·최근활동 대신 단계 라벨로 고정(오피스뷰
                // '🎨/🎬 렌더링 중' 버블과 일치).
                l1 = phaseDoing;
                l2 = g.key === "shorts" ? "영상 합성 중" : "카드 이미지 생성 중";
              } else {
                if (stream.trim()) {
                  const gi = debateGist(stream);
                  l1 = gi.headline; l2 = gi.detail;
                  if (!l2) {                       // detail 없으면 스트림의 2번째 의미있는 줄로
                    const lines = gistLines(stream, 2);
                    if (lines[1] && lines[1] !== l1) l2 = lines[1];
                  }
                }
                if (!l1) l1 = task || phaseDoing;
                // 2번째 줄이 비거나 1줄과 같으면 현재 행동 → 배정 과제 → 단계 순으로 폴백.
                if (!l2 || l2 === l1) {
                  l2 = lastAction[a.agent_id] || (task && task !== l1 ? task : "") || phaseDoing;
                }
              }
              return (
                <div key={a.agent_id} className="livenow-card" style={{ borderLeftColor: agentColor(a.agent_id) }}>
                  <Avatar id={a.agent_id} glyph={agentGlyph(a.level, a.agent_id, a.persona?.role ?? "")} size={18} head level={a.level} title={a.persona?.role ?? ""} />
                  <div className="livenow-meta">
                    <b className="livenow-name">{label}</b>
                    <span className="livenow-doing">{l1}</span>
                    {l2 && <span className="livenow-doing2">{l2}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
