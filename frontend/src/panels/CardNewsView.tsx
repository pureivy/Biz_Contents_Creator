import { useEffect, useMemo, useState } from "react";
import {
  fetchCardNews, createCardNews, createCardNewsFromPiece, deleteCardNews,
  fetchPieces, CardNewsInfo, PieceInfo, publishCardNews, fetchMetaStatus,
  fetchBrand, saveBrandCardStyle,
} from "../api";
import Avatar from "./Avatar";
import Ico, { type IcoName } from "./Ico";
import SlideStrip from "./SlideStrip";
import { CARD_STYLE_OPTIONS, loadCardStyle, saveCardStyle } from "../cardStyles";

// 카드뉴스 탭 — 카드뉴스팀(기획 → 디자인 → 배경 생성 → 렌더)이 만드는 인스타그램용 슬라이드.
// 발행: 메타(인스타·페북) 연결 시 발행 버튼, 미연결 시 연결 링크 — 그 외엔 미리보기 + 개별/zip 다운로드. 진행은 8초 폴링(캘린더와 동일 케이던스).
// 스테이지 아이콘 어휘는 숏폼과 통일(기획=pencil · 디자인=sparkle · 렌더=setting · 완성=circle-check).
const STAGE_LABEL: Record<string, { icon: IcoName; label: string }> = {
  planning: { icon: "pencil", label: "기획 중" }, designing: { icon: "sparkle", label: "디자인 중" },
  rendering: { icon: "setting", label: "렌더 중" }, ready: { icon: "circle-check", label: "완성" },
  error: { icon: "triangle-exclamation", label: "실패" },
};
const RUNNING_STAGES = new Set(["planning", "designing", "rendering"]);
// 파생 소스로 쓸 수 있는 블로그 초안 단계(초안 본문이 존재).
const DERIVABLE = new Set(["ready", "published", "measured", "reflected"]);

function fmtWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

function CardRow({ card, onDelete, metaReady, fbReady, onChanged }: {
  card: CardNewsInfo; onDelete: (id: string) => void; metaReady: boolean; fbReady: boolean; onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const doPublish = async () => {
    setPublishing(true);
    let r = await publishCardNews(card.id);
    // QA 미해결 게이트(409) — 사용자가 슬라이드를 확인했다고 답할 때만 force 재요청(오타 유출 실사고 방어).
    if (r.error && r.qa_unresolved?.length) {
      const go = confirm(`${r.error}\n\n해당 슬라이드를 확인했고 이대로 발행할까요?`);
      if (go) r = await publishCardNews(card.id, true);
      else { setPublishing(false); onChanged(); return; }
    }
    setPublishing(false);
    if (r.error) alert(`발행 실패: ${r.error}`); // doDelete 의 기존 alert 관례
    else if (r.fbError) alert(`인스타는 발행됐지만 페이스북 페이지 게시는 실패했습니다:\n${r.fbError}`);
    onChanged(); // 부분 성공도 링크가 바로 보이게 즉시 재조회(폴링 8초 대기 없이)
  };
  const running = RUNNING_STAGES.has(card.stage);
  const captionFull = [card.caption, (card.hashtags ?? []).join(" ")].filter(Boolean).join("\n\n");
  const copyCaption = async () => {
    try { await navigator.clipboard.writeText(captionFull); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { alert("복사 실패 — 캡션을 직접 선택해 복사하세요"); }
  };
  return (
    <div className="review-section">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="badge">{STAGE_LABEL[card.stage] ? <><Ico name={STAGE_LABEL[card.stage].icon} size={10} /> {STAGE_LABEL[card.stage].label}</> : card.stage}</span>
        <strong>{card.topic}</strong>
        {card.keyword && <span className="chip"><Ico name="location" size={11} /> {card.keyword}</span>}
        {card.sourcePieceId && <span className="chip" title="블로그 초안에서 파생"><Ico name="document" size={11} /> 블로그 파생</span>}
        <span className="muted" style={{ marginLeft: "auto" }}>{fmtWhen(card.updatedTs)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }} className="muted">
        {card.planner && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Avatar id="cardnews_planner" glyph="🗂" size={18} head /> 기획 {card.planner}</span>}
        {card.designer && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Avatar id="cardnews_designer" glyph="🎨" size={18} head /> 디자인 {card.designer}</span>}
        {running && <span>… 작업 중(자동 갱신)</span>}
      </div>
      {card.stage === "error" && <p className="muted" style={{ color: "var(--con)", marginTop: 6 }}>{card.error || "알 수 없는 실패"}</p>}
      {card.stage === "ready" && (
        <>
          <SlideStrip cardId={card.id} slides={card.slides ?? 0} title={card.topic} version={card.updatedTs} />
          {captionFull && (
            <div style={{ marginTop: 8 }}>
              <div style={{ whiteSpace: "pre-wrap" }} className="muted">{captionFull}</div>
            </div>
          )}
        </>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {card.stage === "ready" && (
          <>
            <a className="btn start" href={`/cardnews/${card.id}/zip`} download>전체 zip</a>
            {captionFull && <button className="btn ghost" onClick={copyCaption}>{copied ? "복사됨!" : "캡션 복사"}</button>}
            {(card.igPermalink || card.fbPostId) && (
              <span style={{ display: "inline-flex", gap: 6 }}>
                {card.igPermalink && <a className="btn ghost" href={card.igPermalink} target="_blank" rel="noreferrer">📸 인스타그램</a>}
                {card.fbPostId && <a className="btn ghost" href={`https://www.facebook.com/${card.fbPostId}`} target="_blank" rel="noreferrer">📘 페이스북</a>}
              </span>
            )}
            {!card.igPermalink && !card.fbPostId ? (
              metaReady || fbReady ? (
                <button className="btn" disabled={publishing} onClick={doPublish}>
                  {publishing ? "발행 중…" : fbReady && metaReady ? "📤 인스타·페북 발행" : fbReady ? "📘 페북 발행" : "📸 인스타 발행"}
                </button>
              ) : (
                <a className="btn ghost" href="/meta/oauth/start" target="_blank" rel="noreferrer" title="이 브랜드의 인스타그램 계정으로 로그인해 1회 연결 — 앱 ID/시크릿은 키 탭에서 먼저 설정">📤 메타 연결</a>
              )
            ) : fbReady && !card.fbPostId ? (
              // 인스타엔 올라갔지만 페이스북 페이지엔 아직 — 같은 슬라이드로 페북만 게시(인스타 재발행 없음)
              <button className="btn ghost" disabled={publishing} onClick={doPublish}
                title="이미 인스타에 올라간 이 카드뉴스를 페이스북 페이지에도 게시합니다(인스타 재발행 없음)">
                {publishing ? "게시 중…" : "📘 페북에도 올리기"}
              </button>
            ) : null}
          </>
        )}
        <button className="btn ghost" title="카드 삭제(산출물 파일은 남음)" disabled={running} onClick={() => onDelete(card.id)}><Ico name="trash" size={12} /> 삭제</button>
      </div>
    </div>
  );
}

// 제작실(StudioView) 탭의 카드뉴스 섹션 — 페이지 프레임·헤더는 StudioView 가 제공.
export default function CardNewsSection() {
  const [cards, setCards] = useState<CardNewsInfo[]>([]);
  const [pieces, setPieces] = useState<PieceInfo[]>([]);
  const [topic, setTopic] = useState("");
  const [keyword, setKeyword] = useState("");
  const [slides, setSlides] = useState(0); // 0 = 자동(기획자가 스토리라인에 맞게 3~8장)
  // 이미지 스타일 — 브랜드 고정(서버 cardStyle)이 소스, localStorage 는 fetch 전 초기 캐시.
  // 변경 즉시 서버 저장 → 검토탭·자동 파생까지 같은 스타일로 고정(2026-07-22).
  const [style, setStyleRaw] = useState(loadCardStyle);
  useEffect(() => { fetchBrand().then((b) => { if (b) setStyleRaw(b.cardStyle || "auto"); }); }, []);
  const setStyle = (v: string): void => {
    setStyleRaw(v); saveCardStyle(v);
    void saveBrandCardStyle(v).then((r) => { if (!r.ok && r.error) alert(`스타일 고정 저장 실패: ${r.error}`); });
  };
  const [srcPiece, setSrcPiece] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [metaReady, setMetaReady] = useState(false);
  // 페이스북 페이지는 인스타와 독립 연결(앱·토큰이 다름) — 별 상태로 들고 있어야 어느 쪽이 빠졌는지 UI 가 말할 수 있다.
  const [fbReady, setFbReady] = useState(false);
  const [fbClient, setFbClient] = useState(false);

  const load = () => { fetchCardNews().then(setCards); fetchPieces().then(setPieces); };
  useEffect(() => {
    load();
    const t = setInterval(load, 8000); // 진행 중 카드 상태 폴링(캘린더와 동일 케이던스)
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    fetchMetaStatus().then((s) => {
      setMetaReady(s.client && s.connected);
      setFbReady(!!s.fbClient && !!s.fbConnected);
      setFbClient(!!s.fbClient);
    });
  }, []);

  const derivable = useMemo(
    () => pieces.filter((p) => DERIVABLE.has(p.stage) && p.runId).sort((a, b) => b.updatedTs.localeCompare(a.updatedTs)),
    [pieces],
  );

  const doCreate = async () => {
    const t = topic.trim();
    if (!t) return;
    setBusy(true); setErr("");
    const r = await createCardNews({ topic: t, keyword: keyword.trim() || undefined, slides, style: style === "auto" ? undefined : style });
    setBusy(false);
    if (r.ok) { setTopic(""); setKeyword(""); load(); } else setErr(r.error || "생성 실패");
  };
  const doDerive = async () => {
    if (!srcPiece) return;
    setBusy(true); setErr("");
    const r = await createCardNewsFromPiece(srcPiece, slides, style === "auto" ? undefined : style);
    setBusy(false);
    if (r.ok) { setSrcPiece(""); load(); } else setErr(r.error || "생성 실패");
  };
  const doDelete = async (id: string) => {
    const card = cards.find((x) => x.id === id);
    if (!confirm(`"${card?.topic ?? id}" 카드뉴스를 삭제할까요?\n(슬라이드 파일은 남고 목록에서만 제거됩니다)`)) return;
    const r = await deleteCardNews(id);
    if (r.ok) load(); else alert(r.error || "삭제 실패");
  };

  return (
    <>
      {/* 새 카드뉴스 — 독립 주제 */}
      <div className="review-section">
        <h3>새 카드뉴스</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" value={topic} placeholder="주제 (예: 장마철 실내 제습 꿀팁)" style={{ flex: "1 1 260px" }}
            onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doCreate(); }} />
          <input type="text" value={keyword} placeholder="핵심 키워드(선택)" style={{ flex: "0 1 180px" }}
            onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doCreate(); }} />
          <label className="muted">장수&nbsp;
            <select value={slides} onChange={(e) => setSlides(Number(e.target.value))} title="자동은 기획자가 스토리라인의 핵심 개수에 맞게 3~8장 정함">
              <option value={0}>자동 (내용에 맞게)</option>
              {[3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}장</option>)}
            </select>
          </label>
          <label className="muted">스타일&nbsp;
            <select value={style} onChange={(e) => setStyle(e.target.value)} title="이미지 스타일 — 자동은 주제에 맞게 디자이너가 선택. 아래 초안 파생에도 적용됩니다.">
              {CARD_STYLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <button className="btn start" disabled={busy || !topic.trim()} onClick={doCreate}>+ 생성</button>
        </div>
        {/* 블로그 초안에서 파생 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
          <select value={srcPiece} onChange={(e) => setSrcPiece(e.target.value)} style={{ flex: "1 1 260px" }}>
            <option value="">블로그 초안에서 만들기 — 초안 선택…</option>
            {derivable.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <button className="btn ghost" disabled={busy || !srcPiece} onClick={doDerive}><Ico name="document" size={12} /> 초안 → 카드뉴스</button>
          {err && <span className="muted" style={{ color: "var(--con)" }}>{err}</span>}
        </div>
      </div>

      {/* 페이스북 페이지 연결 — 키가 설정됐는데 미연결일 때만 안내(연결되면 사라짐) */}
      {fbClient && !fbReady && (
        <p className="muted" style={{ marginTop: 8 }}>
          📘 페이스북 페이지가 연결되지 않아 인스타에만 올라갑니다 —{" "}
          <a href="/meta/fb/oauth/start" target="_blank" rel="noreferrer">페이스북 페이지 연결</a>
          {" "}(페이지 관리자 계정으로 1회 로그인)
        </p>
      )}
      {cards.length === 0 && <p className="muted">아직 카드뉴스가 없습니다 — 위에서 주제를 입력해 첫 카드를 만들어 보세요.</p>}
      {cards.map((card) => <CardRow key={card.id} card={card} onDelete={doDelete} metaReady={metaReady} fbReady={fbReady} onChanged={load} />)}
    </>
  );
}
