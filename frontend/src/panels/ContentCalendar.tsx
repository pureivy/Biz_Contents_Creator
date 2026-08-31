import { useEffect, useMemo, useState } from "react";
import { fetchPieces, createPiece, runPiece, deletePiece, PieceInfo, PieceStage } from "../api";
import Ico, { type IcoName } from "./Ico";

// 지금 실행 가능한(초안이 아직 없는) 스테이지 — idea·research·draft·error.
const RUNNABLE = new Set<PieceStage>(["idea", "research", "draft", "error"]);

// 크로스-런 캘린더 — REST 폴링만(store/fold 금지: 스크럽 시 성과 수치 변형 방지). 라이프사이클 칸반.
// 스테이지 아이콘은 뷰 탭과 같은 어휘를 재사용(검토 대기=eye, 발행=megaphone, 측정=chart).
const STAGES: { key: PieceStage; label: string; icon: IcoName }[] = [
  { key: "idea", label: "아이디어", icon: "sparkle" },
  { key: "research", label: "리서치", icon: "search" },
  { key: "draft", label: "초안 작성", icon: "pencil" },
  { key: "ready", label: "검토 대기", icon: "eye" },
  { key: "published", label: "발행됨", icon: "megaphone" },
  { key: "measured", label: "측정됨", icon: "chart" },
  { key: "reflected", label: "강화 반영", icon: "arrow-up-right" },
];

function fmtWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

// 파생 콘텐츠(카드뉴스·숏폼) 상태 배지 — 주제 하나의 '콘텐츠 세트' 진행을 캘린더에서 한눈에.
function DerivedBadge({ icon, name, d }: { icon: IcoName; name: string; d?: { stage: string; running: boolean } }) {
  if (!d) return null;
  const working = d.running || ["planning", "designing", "rendering"].includes(d.stage);
  const mark = working ? "생성 중…" : d.stage === "ready" ? "완성" : "실패";
  return (
    <span className="chip" title={`${name} ${mark}`}>
      <Ico name={icon} size={11} />{" "}
      {working ? "…" : d.stage === "ready" ? "✓" : <Ico name="triangle-exclamation" size={10} />}
    </span>
  );
}

function PieceCard({ p, onRun, onDelete, running }: { p: PieceInfo; onRun: (id: string) => void; onDelete: (id: string) => void; running: boolean }) {
  return (
    <div className="piece-card">
      <div className="piece-card-title">{p.title}</div>
      <div className="piece-card-meta">
        {p.keyword && <span className="chip"><Ico name="location" size={11} /> {p.keyword}</span>}
        {p.subNiche && <span className="chip">{p.subNiche}</span>}
        {typeof p.seoScore === "number" && <span className="badge">SEO {p.seoScore}</span>}
        <DerivedBadge icon="cards" name="카드뉴스" d={p.derived?.cardnews} />
        <DerivedBadge icon="play" name="숏폼" d={p.derived?.shorts} />
      </div>
      {p.publishedUrl && (
        <a className="piece-card-link" href={p.publishedUrl} target="_blank" rel="noreferrer"><Ico name="external-link" size={11} /> 발행 글 보기</a>
      )}
      <div className="piece-card-foot">
        <span className="muted">{fmtWhen(p.updatedTs)}{p.errors ? ` · 실패 ${p.errors}` : ""}</span>
        <span>
          {RUNNABLE.has(p.stage) && (
            <button className="btn ghost piece-run-btn" disabled={running} onClick={() => onRun(p.id)}>
              {running ? "실행 중…" : "▶ 실행"}
            </button>
          )}
          <button className="btn ghost piece-run-btn" title="카드 삭제" disabled={running} onClick={() => onDelete(p.id)}><Ico name="trash" size={11} /></button>
        </span>
      </div>
    </div>
  );
}

export default function ContentCalendar() {
  const [pieces, setPieces] = useState<PieceInfo[]>([]);
  const [title, setTitle] = useState("");
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = () => fetchPieces().then(setPieces);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000); // 8초 폴링(DashboardBar 와 동일 케이던스)
    return () => clearInterval(t);
  }, []);

  const byStage = useMemo(() => {
    const m: Record<string, PieceInfo[]> = {};
    for (const p of pieces) (m[p.stage] ??= []).push(p);
    return m;
  }, [pieces]);
  const errors = byStage["error"] ?? [];

  // 보기 모드(칸반↔목록) — localStorage 영속. 자료가 많으면 목록(표)이 관리 쉬움(사용자 요청 2026-07-22).
  const [view, setViewRaw] = useState<"board" | "list">(() => {
    try { return localStorage.getItem("gepa.calendarView") === "list" ? "list" : "board"; } catch { return "board"; }
  });
  const setView = (v: "board" | "list"): void => { setViewRaw(v); try { localStorage.setItem("gepa.calendarView", v); } catch { /* 무해 */ } };
  // 완료 칸(발행됨·측정됨·강화 반영)은 무한 누적 — 기본 최근 5개만, 칸별 '더 보기'(성과 대시보드 패턴).
  const TERMINAL = useMemo(() => new Set<string>(["published", "measured", "reflected"]), []);
  const [colExpanded, setColExpanded] = useState<Record<string, boolean>>({});
  // 목록 보기 행 — 최신 갱신순(모든 단계 포함, 실패도 한 표에서 관리).
  const listRows = useMemo(() => [...pieces].sort((a, b) => b.updatedTs.localeCompare(a.updatedTs)), [pieces]);
  const stageOf = (key: string): { label: string; icon: IcoName } =>
    STAGES.find((s) => s.key === key) ?? { label: "실패", icon: "triangle-exclamation" };

  const doRun = async (id: string) => {
    setRunningId(id);
    const r = await runPiece(id);
    setRunningId(null);
    if (r.ok) load(); else alert(r.error || "실행 실패");
  };

  const doDelete = async (id: string) => {
    const p = pieces.find((x) => x.id === id);
    if (!confirm(`"${p?.title ?? id}" 카드를 삭제할까요?\n(산출물 파일은 남고 카드만 제거됩니다)`)) return;
    const r = await deletePiece(id);
    if (r.ok) load(); else alert(r.error || "삭제 실패");
  };

  // 주제 추가 = 아이디어 생성 + 즉시 블로그 런 시작(사용자 의도: 주제 입력 → 바로 생성).
  // 런까지 못 띄워도(동시 실행 상한 등) 아이디어 카드는 남아 자율 사이클/수동 실행으로 이어진다.
  const addIdea = async () => {
    const t = title.trim();
    if (!t) return;
    setBusy(true); setErr("");
    const r = await createPiece({ title: t, keyword: keyword.trim() || undefined });
    if (r.ok && r.id) { await runPiece(r.id); }
    setBusy(false);
    if (r.ok) { setTitle(""); setKeyword(""); load(); }
    else setErr(r.error || "생성 실패");
  };

  return (
    <div className="apikeys calendar-view">
      <div className="apikeys-head">
        <h1><Ico name="calendar" size={17} /> 콘텐츠 캘린더</h1>
        <p className="apikeys-sub">
          주제를 넣으면 바로 블로그 생성이 시작돼 초안→검토대기까지 이어지고, 발행·성과는 사람이 관리합니다.
          여기 카드는 크로스-런 실데이터를 8초마다 폴링합니다(총 {pieces.length}건).
        </p>
      </div>

      {/* 수동 아이디어 투입 — 자율 사이클이 다음 틱에 집어 초안까지 만든다. */}
      <div className="calendar-newidea">
        <input
          type="text" value={title} placeholder="새 콘텐츠 아이디어 제목…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addIdea(); }}
        />
        <input
          type="text" value={keyword} placeholder="핵심 키워드(선택)"
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addIdea(); }}
        />
        <button className="btn start" disabled={busy || !title.trim()} onClick={addIdea}>{busy ? "생성 시작 중…" : "+ 주제 추가 · 생성 시작"}</button>
        {err && <span className="muted" style={{ color: "var(--con)" }}>{err}</span>}
      </div>

      {/* 보기 전환 — 칸반(진행 흐름) ↔ 목록(대량 관리). 선택은 localStorage 로 유지. */}
      <div style={{ display: "flex", gap: 6, margin: "2px 0 10px" }}>
        <button className={view === "board" ? "btn start" : "btn ghost"} onClick={() => setView("board")}><Ico name="cards" size={12} /> 칸반</button>
        <button className={view === "list" ? "btn start" : "btn ghost"} onClick={() => setView("list")}><Ico name="document" size={12} /> 목록</button>
      </div>

      {view === "list" ? (
        // 목록(표) 보기 — 전 단계 한 표(최신 갱신순), 자료가 많을 때 관리용.
        <div className="perf-table-wrap">
          <table className="perf-table">
            <thead>
              <tr><th>제목</th><th>단계</th><th>키워드</th><th title="파생 콘텐츠(카드뉴스·숏폼)">파생</th><th>SEO</th><th>갱신</th><th></th></tr>
            </thead>
            <tbody>
              {listRows.length === 0 && <tr><td colSpan={7} className="muted">아직 콘텐츠가 없습니다.</td></tr>}
              {listRows.map((p) => {
                const st = stageOf(p.stage);
                return (
                  <tr key={p.id}>
                    <td className="perf-title">
                      <div className="perf-title-row">
                        {p.publishedUrl
                          ? <a href={p.publishedUrl} target="_blank" rel="noreferrer" title={p.title}>{p.title}</a>
                          : <span className="perf-title-txt" title={p.title}>{p.title}</span>}
                      </div>
                    </td>
                    <td><span className="badge"><Ico name={st.icon} size={10} /> {st.label}</span></td>
                    <td>{p.keyword ? <span className="chip"><Ico name="location" size={10} /> {p.keyword}</span> : <span className="muted">—</span>}</td>
                    <td>
                      <DerivedBadge icon="cards" name="카드뉴스" d={p.derived?.cardnews} />
                      <DerivedBadge icon="play" name="숏폼" d={p.derived?.shorts} />
                    </td>
                    <td className="perf-r">{typeof p.seoScore === "number" ? p.seoScore : "—"}</td>
                    <td className="perf-date">{fmtWhen(p.updatedTs)}{p.errors ? ` · 실패 ${p.errors}` : ""}</td>
                    <td className="perf-r">
                      {RUNNABLE.has(p.stage) && (
                        <button className="btn ghost piece-run-btn" disabled={runningId === p.id} onClick={() => doRun(p.id)}>
                          {runningId === p.id ? "실행 중…" : "▶"}
                        </button>
                      )}
                      <button className="btn ghost piece-run-btn" title="카드 삭제" disabled={runningId === p.id} onClick={() => doDelete(p.id)}><Ico name="trash" size={11} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="calendar-board">
            {STAGES.map((st) => {
              const items = byStage[st.key] ?? [];
              // 완료 칸은 최신순 정렬 후 기본 5개만(더 보기 토글) — 진행 칸은 전량 표시(작업 대상 누락 방지).
              const sorted = TERMINAL.has(st.key) ? [...items].sort((a, b) => b.updatedTs.localeCompare(a.updatedTs)) : items;
              const shown = TERMINAL.has(st.key) && !colExpanded[st.key] ? sorted.slice(0, 5) : sorted;
              return (
                <div key={st.key} className="calendar-col">
                  <div className="calendar-col-head">
                    <span><Ico name={st.icon} size={12} /> {st.label}</span>
                    <span className="badge">{items.length}</span>
                  </div>
                  <div className="calendar-col-body">
                    {items.length === 0 && <div className="muted calendar-empty">—</div>}
                    {shown.map((p) => <PieceCard key={p.id} p={p} onRun={doRun} onDelete={doDelete} running={runningId === p.id} />)}
                    {TERMINAL.has(st.key) && items.length > 5 && (
                      <button className="btn ghost" style={{ width: "100%", fontSize: 12 }}
                        onClick={() => setColExpanded((e) => ({ ...e, [st.key]: !e[st.key] }))}>
                        {colExpanded[st.key] ? "접기" : `더 보기 (+${items.length - 5})`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {errors.length > 0 && (
            <div className="calendar-errors">
              <h3><Ico name="triangle-exclamation" size={13} /> 실패({errors.length}) — 자율 재시도 한도 초과</h3>
              <div className="calendar-col-body">{errors.map((p) => <PieceCard key={p.id} p={p} onRun={doRun} onDelete={doDelete} running={runningId === p.id} />)}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
