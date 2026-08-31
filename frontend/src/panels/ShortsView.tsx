import { useEffect, useMemo, useState } from "react";
import {
  fetchShorts, createShorts, createShortsFromPiece, deleteShorts,
  fetchPieces, ShortsInfo, PieceInfo, uploadShortsYoutube, fetchYoutubeStatus,
  publishShortsMeta, fetchMetaStatus, regenerateShortsThumbnail,
} from "../api";
import Avatar from "./Avatar";
import Ico, { type IcoName } from "./Ico";

// 숏폼 탭 — 숏폼팀(작가 → 디렉터 → 씬 이미지 → TTS+ffmpeg 조립)이 만드는 세로 MP4.
// 발행 없음(다운로드 전용): 인라인 재생 + mp4/zip 다운로드. 진행은 8초 폴링(캘린더와 동일 케이던스).
// 스테이지 아이콘 어휘는 카드뉴스와 통일(대본=pencil · 연출=sparkle · 조립=setting · 완성=circle-check).
const STAGE_LABEL: Record<string, { icon: IcoName; label: string }> = {
  planning: { icon: "pencil", label: "대본 중" }, designing: { icon: "sparkle", label: "연출 중" },
  rendering: { icon: "setting", label: "조립 중" }, ready: { icon: "circle-check", label: "완성" },
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

// 성과 수 축약 — 1234→"1.2천", 12345→"1.2만"(뱃지 폭 절약).
function fmtCount(n: number): string {
  if (n >= 9_950) return `${(n / 10_000).toFixed(1)}만`; // 9950+ 는 반올림상 "10.0천" 대신 "1.0만"
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}천`;
  return String(n);
}

function ShortRow({ s, onDelete, yt, metaReady, fbReady, onChanged }: {
  s: ShortsInfo; onDelete: (id: string) => void;
  yt: { client: boolean; connected: boolean }; metaReady: boolean; fbReady: boolean; onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytErr, setYtErr] = useState("");
  const doYoutube = async () => {
    setYtBusy(true); setYtErr("");
    const r = await uploadShortsYoutube(s.id);
    setYtBusy(false);
    // 쇼츠 커버는 API 로 지정 불가(thumbnailError 는 정상 — 유튜브 한계) → 오해 메시지 대신 스튜디오 안내를 지속 표시.
    if (r.ok) { onChanged(); setYtErr(""); }
    else setYtErr(r.error || "업로드 실패");
  };
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaErr, setMetaErr] = useState("");
  const doMeta = async () => {
    setMetaBusy(true); setMetaErr("");
    const r = await publishShortsMeta(s.id);
    setMetaBusy(false);
    if (r.error) setMetaErr(r.error);
    else setMetaErr(r.fbError ? `인스타 릴스는 발행됨 / 페북 릴스 실패: ${r.fbError}` : "");
    onChanged(); // 부분 성공 링크도 즉시 반영
  };
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbErr, setThumbErr] = useState("");
  const doThumbnail = async () => {
    setThumbBusy(true); setThumbErr("");
    const r = await regenerateShortsThumbnail(s.id);
    setThumbBusy(false);
    if (r.error) setThumbErr(r.error); else onChanged(); // updatedTs 갱신 → 포스터 새로고침
  };
  const running = RUNNING_STAGES.has(s.stage);
  const captionFull = [s.title, s.description, (s.hashtags ?? []).join(" ")].filter(Boolean).join("\n\n");
  const copyCaption = async () => {
    try { await navigator.clipboard.writeText(captionFull); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { alert("복사 실패 — 텍스트를 직접 선택해 복사하세요"); }
  };
  return (
    <div className="review-section">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="badge">{STAGE_LABEL[s.stage] ? <><Ico name={STAGE_LABEL[s.stage].icon} size={10} /> {STAGE_LABEL[s.stage].label}</> : s.stage}</span>
        <strong>{s.title ?? s.topic}</strong>
        {s.keyword && <span className="chip"><Ico name="location" size={11} /> {s.keyword}</span>}
        {s.sourcePieceId && <span className="chip" title="블로그 초안에서 파생"><Ico name="document" size={11} /> 블로그 파생</span>}
        {typeof s.durationSec === "number" && <span className="chip">⏱ {s.durationSec}초</span>}
        <span className="muted" style={{ marginLeft: "auto" }}>{fmtWhen(s.updatedTs)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }} className="muted">
        {s.writer && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Avatar id="shorts_writer" glyph="✍️" size={18} head /> 대본 {s.writer}</span>}
        {s.director && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Avatar id="shorts_director" glyph="🎬" size={18} head /> 연출 {s.director}</span>}
        {running && <span>… 작업 중(자동 갱신)</span>}
        {s.stage === "ready" && typeof s.bgFallbacks === "number" && s.bgFallbacks > 0 && (
          <span title="이미지 생성 실패 씬은 그라데이션 배경으로 대체됨">배경 폴백 {s.bgFallbacks}씬</span>
        )}
      </div>
      {s.stage === "error" && <p className="muted" style={{ color: "var(--con)", marginTop: 6 }}>{s.error || "알 수 없는 실패"}</p>}
      {s.stage === "ready" && (
        <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* 세로 영상 미리보기 — 훅 프레임 포스터(가벼운 이미지)를 먼저 띄우고, 재생 시에만 영상 로드(preload=none).
              poster 는 updatedTs 로 캐시버스트(재렌더 시 새 프레임). key 로 갱신 시 리로드 */}
          <video
            key={s.updatedTs} controls preload="none"
            poster={`/shorts/${s.id}/thumbnail?v=${encodeURIComponent(s.updatedTs)}`}
            src={`/shorts/${s.id}/video`}
            // contain: 2:3 썸네일을 9:16 칸에 잘림 없이 전체 표시(좌우 텍스트 안 잘림). 9:16 영상은 그대로 꽉 참.
            style={{ width: 220, aspectRatio: "9/16", borderRadius: 10, background: "#000", objectFit: "contain" }}
          />
          <div style={{ flex: "1 1 260px", minWidth: 220 }}>
            {s.titles && s.titles.length > 1 && (
              <div style={{ marginBottom: 8 }}>
                <div className="muted" style={{ marginBottom: 4 }}>제목 후보</div>
                {s.titles.map((t, i) => <div key={i}>{i === 0 ? "" : "· "}{t}</div>)}
              </div>
            )}
            {captionFull && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{captionFull}</div>}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {s.stage === "ready" && (
          <>
            <a className="btn start" href={`/shorts/${s.id}/download`} download={`shorts-${s.id}.mp4`}
              title="썸네일을 앞 1.6초 인트로로 붙인 MP4 (첫 다운로드는 인코딩으로 잠시 걸릴 수 있음)">MP4</a>
            <a className="btn ghost" href={`/shorts/${s.id}/zip`} download>zip (mp4+자막+캡션)</a>
            {captionFull && <button className="btn ghost" onClick={copyCaption}>{copied ? "복사됨!" : "캡션 복사"}</button>}
            <button className="btn ghost" disabled={thumbBusy} onClick={doThumbnail} title="훅 장면 배경에 제목·핵심을 얹은 디자인 썸네일을 새로 만듭니다(약 1분, 이미지 생성 과금)">
              {thumbBusy ? "썸네일 생성 중…" : "🖼 썸네일 생성"}
            </button>
            {s.youtubeUrl ? (
              <>
                <a className="btn ghost" href={s.youtubeUrl} target="_blank" rel="noreferrer" title="비공개 업로드됨 — 공개 전환은 유튜브 스튜디오에서. 그때 커버를 '동영상 프레임' 맨 앞(0초=디자인 썸네일)으로 지정하세요">▶ 유튜브(비공개)</a>
                {typeof s.views === "number" && (
                  <span className="chip" title="유튜브 성과(최신 수집 — 매일 갱신)">👁 {fmtCount(s.views)}{typeof s.likes === "number" ? ` · 👍 ${fmtCount(s.likes)}` : ""}</span>
                )}
              </>
            ) : yt.connected ? (
              <button className="btn ghost" disabled={ytBusy} onClick={doYoutube}>{ytBusy ? "업로드 중…" : "▶ 유튜브 업로드"}</button>
            ) : yt.client ? (
              <a className="btn ghost" href="/youtube/oauth/start" target="_blank" rel="noreferrer" title="이 브랜드의 유튜브 채널 구글 계정으로 로그인해 1회 연결">▶ 채널 연결</a>
            ) : null}
            {(s.igPermalink || s.fbReelId) && (
              <span style={{ display: "inline-flex", gap: 6 }}>
                {s.igPermalink && <a className="btn ghost" href={s.igPermalink} target="_blank" rel="noreferrer">📸 릴스</a>}
                {s.fbReelId && <a className="btn ghost" href={`https://www.facebook.com/reel/${s.fbReelId}`} target="_blank" rel="noreferrer">📘 FB 릴스</a>}
              </span>
            )}
            {!s.igPermalink && !s.fbReelId ? (
              metaReady || fbReady ? (
                <button className="btn ghost" disabled={metaBusy} onClick={doMeta} title="릴스로 발행 — 릴스는 즉시 공개됩니다(연결된 채널 모두)">
                  {metaBusy ? "릴스 발행 중…" : "📤 릴스 발행(즉시 공개)"}
                </button>
              ) : (
                <a className="btn ghost" href="/meta/oauth/start" target="_blank" rel="noreferrer" title="이 브랜드의 인스타 계정으로 1회 연결(카드뉴스와 공용)">📤 메타 연결</a>
              )
            ) : fbReady && !s.fbReelId ? (
              // 인스타엔 올라간 릴스를 페이스북 페이지에도(IG 재발행 없음 — 같은 final.mp4 업로드)
              <button className="btn ghost" disabled={metaBusy} onClick={doMeta}
                title="이미 인스타에 올라간 이 릴스를 페이스북 페이지에도 게시합니다(인스타 재발행 없음)">
                {metaBusy ? "페북 게시 중…" : "📘 페북에도 올리기"}
              </button>
            ) : fbReady && s.fbReelId && !s.fbReelCoverTs ? (
              // 페북 릴스는 올라갔지만 커버가 없다 — 릴스 발행 API 에 커버 파라미터가 없어 별 호출로 붙인다
              <button className="btn ghost" disabled={metaBusy} onClick={doMeta}
                title="페이스북 릴스에 디자인 썸네일을 커버로 지정합니다(재발행 없음)">
                {metaBusy ? "커버 적용 중…" : "🖼 페북 커버 적용"}
              </button>
            ) : null}
            {metaErr && <span className="muted" style={{ color: "var(--con)" }}>{metaErr}</span>}
            {ytErr && <span className="muted" style={{ color: "var(--con)" }}>{ytErr}</span>}
            {s.youtubeUrl && (
              <span className="muted" style={{ fontSize: 11, flexBasis: "100%" }} title="유튜브 쇼츠는 커버를 API 로 못 바꿉니다 — 스튜디오/앱의 프레임 선택으로만 지정됩니다. 인트로 덕분에 맨 앞 프레임이 곧 디자인 썸네일입니다.">
                🎬 공개 전환 시 <b>커버를 '동영상 프레임' 맨 앞(0초)</b>으로 지정하세요 — 그게 디자인 썸네일입니다.
              </span>
            )}
            {thumbErr && <span className="muted" style={{ color: "var(--con)" }}>{thumbErr}</span>}
          </>
        )}
        <button className="btn ghost" title="목록에서 삭제(산출물 파일은 남음)" disabled={running} onClick={() => onDelete(s.id)}><Ico name="trash" size={12} /> 삭제</button>
      </div>
    </div>
  );
}

// 제작실(StudioView) 탭의 숏폼 섹션 — 페이지 프레임·헤더는 StudioView 가 제공.
export default function ShortsSection() {
  const [items, setItems] = useState<ShortsInfo[]>([]);
  const [pieces, setPieces] = useState<PieceInfo[]>([]);
  const [topic, setTopic] = useState("");
  const [keyword, setKeyword] = useState("");
  const [scenes, setScenes] = useState(6);
  const [srcPiece, setSrcPiece] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [yt, setYt] = useState<{ client: boolean; connected: boolean }>({ client: false, connected: false });
  const [metaReady, setMetaReady] = useState(false);
  // 페이스북 페이지는 인스타와 독립 연결(앱·토큰이 다름) — 별 상태.
  const [fbReady, setFbReady] = useState(false);

  const load = () => {
    fetchShorts().then(setItems); fetchPieces().then(setPieces); fetchYoutubeStatus().then(setYt);
    fetchMetaStatus().then((m) => { setMetaReady(m.client && m.connected); setFbReady(!!m.fbClient && !!m.fbConnected); });
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 8000); // 진행 중 상태 폴링(캘린더와 동일 케이던스)
    return () => clearInterval(t);
  }, []);

  const derivable = useMemo(
    () => pieces.filter((p) => DERIVABLE.has(p.stage) && p.runId).sort((a, b) => b.updatedTs.localeCompare(a.updatedTs)),
    [pieces],
  );

  const doCreate = async () => {
    const t = topic.trim();
    if (!t) return;
    setBusy(true); setErr("");
    const r = await createShorts({ topic: t, keyword: keyword.trim() || undefined, scenes });
    setBusy(false);
    if (r.ok) { setTopic(""); setKeyword(""); load(); } else setErr(r.error || "생성 실패");
  };
  const doDerive = async () => {
    if (!srcPiece) return;
    setBusy(true); setErr("");
    const r = await createShortsFromPiece(srcPiece, scenes);
    setBusy(false);
    if (r.ok) { setSrcPiece(""); load(); } else setErr(r.error || "생성 실패");
  };
  const doDelete = async (id: string) => {
    const s = items.find((x) => x.id === id);
    if (!confirm(`"${s?.title ?? s?.topic ?? id}" 숏폼을 삭제할까요?\n(영상 파일은 남고 목록에서만 제거됩니다)`)) return;
    const r = await deleteShorts(id);
    if (r.ok) load(); else alert(r.error || "삭제 실패");
  };

  return (
    <>
      {/* 새 숏폼 — 독립 주제 */}
      <div className="review-section">
        <h3>새 숏폼</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" value={topic} placeholder="주제 (예: 장마철 제습 꿀팁)" style={{ flex: "1 1 260px" }}
            onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doCreate(); }} />
          <input type="text" value={keyword} placeholder="핵심 키워드(선택)" style={{ flex: "0 1 180px" }}
            onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doCreate(); }} />
          <label className="muted">씬&nbsp;
            <select value={scenes} onChange={(e) => setScenes(Number(e.target.value))}>
              {[4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
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
          <button className="btn ghost" disabled={busy || !srcPiece} onClick={doDerive}><Ico name="document" size={12} /> 초안 → 숏폼</button>
          {err && <span className="muted" style={{ color: "var(--con)" }}>{err}</span>}
        </div>
      </div>

      {items.length === 0 && <p className="muted">아직 숏폼이 없습니다 — 위에서 주제를 입력해 첫 영상을 만들어 보세요.</p>}
      {items.map((s) => <ShortRow key={s.id} s={s} onDelete={doDelete} yt={yt} metaReady={metaReady} fbReady={fbReady} onChanged={load} />)}
    </>
  );
}
