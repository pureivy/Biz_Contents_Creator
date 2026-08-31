// MetricDrawer — 대시보드 지표(누적토론·작업중·산출물·위키·교훈)를 클릭하면 열리는
// 통합 드릴다운 패널. 5개 지표가 모두 같은 오버레이 모양을 쓴다(WikiGraphView의
// brain-overlay 패턴과 동일 룩). 범위는 데이터 의미를 따른다:
//   누적토론·위키·교훈 = 전 기간 누적, 작업중·산출물 = 현재 런.
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { isWorkingNow } from "../events/working";
import { fetchWikiPages, fetchWikiPage, WikiPageRow } from "../api";
import type { RunInfo } from "../api";

export type MetricKind = "runs" | "working" | "output" | "wiki" | "lessons";

const META: Record<MetricKind, { icon: string; title: string; sub: string }> = {
  runs:    { icon: "📅", title: "누적 토론",  sub: "지금까지 실행한 모든 토론 기록 (클릭 → 불러오기)" },
  working: { icon: "👥", title: "작업 중",    sub: "현재 런에서 일하고 있는 직원" },
  output:  { icon: "📄", title: "산출물",     sub: "현재 런의 팀 산출물 · 최종 결과물 (클릭 → 본문)" },
  wiki:    { icon: "📚", title: "위키",       sub: "누적된 지식베이스 페이지 (클릭 → 본문)" },
  lessons: { icon: "🏆", title: "교훈",       sub: "직원이 런을 거치며 축적한 노하우 (클릭 → 본문)" },
};

const STATUS_KO: Record<string, string> = {
  running: "진행 중", ok: "완료", partial: "부분완료", error: "오류",
  cancelled: "중지", budget_exceeded: "예산초과", interrupted: "중단됨",
};
const CAT_KO: Record<string, string> = {
  synthesis: "종합", decision: "결정", evidence: "근거", research: "조사",
  reference: "참고", claim: "주장", "debate-transcript": "토론기록",
  lesson: "교훈", usage_log: "사용기록", refinement: "보완", analysis: "분석",
};
const catKo = (c: string) => CAT_KO[c] ?? c;

interface Props {
  metric: MetricKind;
  runs: RunInfo[];
  names: Record<string, string>;            // id → 직무
  persons?: Record<string, string>;          // id → 현 담당자 실명(보조)
  onOpenRun: (id: string) => void;
  onOpenOutputs: () => void;
  onClose: () => void;
}

export default function MetricDrawer({ metric, runs, names, persons = {}, onOpenRun, onOpenOutputs, onClose }: Props) {
  const s = useStore();
  const meta = META[metric];
  const [rows, setRows] = useState<WikiPageRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [bodies, setBodies] = useState<Record<string, string>>({});
  // 산출물 인라인 펼침 — 전문이 이미 store(synthesis/message)에 있어 fetch 불필요.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  useEffect(() => {
    if (metric === "wiki") {
      setRows(null);
      fetchWikiPages("", 300).then((r) => { setRows(r.pages); setCounts(r.counts); });
    } else if (metric === "lessons") {
      setRows(null);
      fetchWikiPages("lesson", 200).then((r) => setRows(r.pages));
    }
  }, [metric]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const toggleBody = async (id: string) => {
    if (bodies[id] !== undefined) {
      setBodies((b) => { const n = { ...b }; delete n[id]; return n; });
      return;
    }
    const page = await fetchWikiPage(id);
    setBodies((b) => ({ ...b, [id]: (page?.body || "(본문 없음)").slice(0, 4000) }));
  };

  const empty = (msg: string) => <p className="metric-empty">{msg}</p>;

  let content: React.ReactNode = null;

  if (metric === "runs") {
    content = runs.length === 0 ? empty("아직 실행한 토론이 없습니다.") : (
      <ul className="metric-list">
        {runs.map((r) => (
          <li key={r.run_id} className="metric-row click"
              onClick={() => { onOpenRun(r.run_id); onClose(); }}>
            <div className="metric-row-main">
              <span className={`mbadge st-${r.status}`}>{STATUS_KO[r.status] ?? r.status}</span>
              <span className="metric-row-title">{r.topic || "(제목 없음)"}</span>
            </div>
            <div className="metric-row-meta">
              {r.created_ts.slice(0, 10)} · ${r.total_cost.toFixed(2)}{r.active ? " · 라이브" : ""}
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (metric === "working") {
    const working = s.agentOrder.map((id) => s.agents[id]).filter((a) => a && isWorkingNow(a, s));
    content = working.length === 0
      ? empty(s.status === "running" ? "지금 작업 중인 직원이 없습니다." : "진행 중인 런이 없습니다.")
      : (
        <ul className="metric-list">
          {working.map((a) => {
            const act = a.currentBlock ? (s.blocks[a.currentBlock] || "").trim().split("\n").pop() : "";
            const team = a.team ? s.teams[a.team]?.name : "";
            return (
              <li key={a.agent_id} className="metric-row">
                <div className="metric-row-main">
                  <span className="mwork">●</span>
                  <span className="metric-row-title">{names[a.agent_id] ?? a.agent_id}</span>
                  {team && <span className="metric-row-tag">{team}</span>}
                </div>
                {act && <div className="metric-row-meta">{act.slice(0, 140)}</div>}
              </li>
            );
          })}
        </ul>
      );
  } else if (metric === "output") {
    const deliverables = s.messages.filter((m) => m.move === "deliverable" && (m.text || "").trim());
    const hasFinal = s.synthesis.trim();
    content = (deliverables.length === 0 && !hasFinal) ? empty("아직 산출물이 없습니다.") : (
      <>
        <button className="metric-cta" onClick={() => { onOpenOutputs(); onClose(); }}>
          산출물 패널 열기 →
        </button>
        <ul className="metric-list">
          {hasFinal && (
            <li className="metric-row click" onClick={() => toggleExpand("final")}>
              <div className="metric-row-main">
                <span className="mbadge st-ok">최종 결과물</span>
                <span className="metric-row-title">{(s.synthesis.match(/^#+\s*(.+)$/m)?.[1] || s.topic || "최종 결과물").slice(0, 80)}</span>
              </div>
              {expanded["final"]
                ? <pre className="metric-pre">{s.synthesis.slice(0, 12000)}</pre>
                : <div className="metric-row-meta">{s.synthesis.replace(/[#*`]/g, "").trim().slice(0, 160)}…</div>}
            </li>
          )}
          {deliverables.map((m, i) => {
            const key = `deli-${i}`;
            return (
              <li key={key} className="metric-row click" onClick={() => toggleExpand(key)}>
                <div className="metric-row-main">
                  <span className="mbadge">팀 산출물</span>
                  <span className="metric-row-title">{(m.text.match(/^#+\s*(.+)$/m)?.[1] || m.text).slice(0, 80)}</span>
                </div>
                {expanded[key]
                  ? <pre className="metric-pre">{m.text.slice(0, 12000)}</pre>
                  : <div className="metric-row-meta">{m.text.replace(/[#*`]/g, "").trim().slice(0, 160)}…</div>}
              </li>
            );
          })}
        </ul>
      </>
    );
  } else if (metric === "wiki") {
    content = rows === null ? empty("불러오는 중…") : rows.length === 0 ? empty("위키가 비어 있습니다.") : (
      <>
        <div className="metric-cats">
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => (
            <span key={c} className="metric-cat">{catKo(c)} <b>{n}</b></span>
          ))}
        </div>
        <ul className="metric-list">
          {rows.map((p) => (
            <li key={p.id} className="metric-row click" onClick={() => toggleBody(p.id)}>
              <div className="metric-row-main">
                <span className={`mcat c-${p.category}`}>{catKo(p.category)}</span>
                <span className="metric-row-title">{p.title}</span>
                {p.source_count > 0 && <span className="metric-row-tag">출처 {p.source_count}</span>}
              </div>
              {p.summary && <div className="metric-row-meta">{p.summary}</div>}
              {bodies[p.id] !== undefined && <pre className="metric-pre">{bodies[p.id]}</pre>}
            </li>
          ))}
        </ul>
      </>
    );
  } else if (metric === "lessons") {
    if (rows === null) content = empty("불러오는 중…");
    else if (rows.length === 0) content = empty("아직 축적된 교훈이 없습니다.");
    else {
      const byRole: Record<string, WikiPageRow[]> = {};
      for (const p of rows) {
        const tag = (p.tags || []).find((t) => t.startsWith("role:"));
        const rid = tag ? tag.slice(5) : "기타";
        (byRole[rid] ||= []).push(p);
      }
      content = (
        <div className="metric-groups">
          {Object.entries(byRole).map(([rid, ls]) => (
            <div key={rid} className="metric-group">
              <div className="metric-group-h">
                {names[rid] ?? rid}
                {persons[rid] && <span> · {persons[rid]}</span>}
                <span> · {ls.length}</span>
              </div>
              <ul className="metric-list">
                {ls.map((p) => (
                  <li key={p.id} className="metric-row click" onClick={() => toggleBody(p.id)}>
                    <div className="metric-row-main">
                      <span className="metric-row-title">{p.title}</span>
                      {p.source_count > 0 && <span className="metric-row-tag">출처 {p.source_count}</span>}
                    </div>
                    {p.summary && <div className="metric-row-meta">{p.summary}</div>}
                    {bodies[p.id] !== undefined && <pre className="metric-pre">{bodies[p.id]}</pre>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    }
  }

  return (
    <div className="metric-overlay" onClick={onClose}>
      <div className="metric-modal" onClick={(e) => e.stopPropagation()}>
        <div className="metric-head">
          <span className="metric-ic">{meta.icon}</span>
          <div className="metric-titles"><b>{meta.title}</b><span>{meta.sub}</span></div>
          <button className="metric-x" onClick={onClose} title="닫기 (Esc)">✕</button>
        </div>
        <div className="metric-scroll">{content}</div>
      </div>
    </div>
  );
}
