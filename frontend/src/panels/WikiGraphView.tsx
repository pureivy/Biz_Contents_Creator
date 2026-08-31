// WikiGraphView — "제2의 두뇌": an Obsidian-style force-directed graph of the whole
// persistent LLM wiki. Opens as a full-screen modal from the 산출물 panel. Nodes are
// wiki pages (colored by category, sized by link-degree, red ring = contested), with
// optional tag/source/agent layers (toolbar toggles, off by default). Hover dims all
// but the node + neighbors; click opens a side drawer with the page's body + meta.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import {
  fetchWikiGraph, fetchWikiPage,
  WikiGraph, WikiGraphNode, WikiNodeType, WikiPageDetail,
} from "../api";

// 색별 glow 스프라이트 캐시. 매 프레임 shadowBlur/createRadialGradient 없이
// drawImage(cached bitmap)으로 싸게 뉴런 발광 효과.
// 키: 노드 fill 색 문자열, 값: 128×128 offscreen canvas
const glowSpriteCache = new Map<string, HTMLCanvasElement>();

function getGlowSprite(color: string): HTMLCanvasElement {
  const cached = glowSpriteCache.get(color);
  if (cached) return cached;

  const size = 128;
  const oc = document.createElement("canvas");
  oc.width = oc.height = size;
  const oc2d = oc.getContext("2d")!;
  const cx = size / 2;

  // 카테고리 색으로 발광 그라디언트 — 중심 alpha 0.75, 가장자리 0
  const grad = oc2d.createRadialGradient(cx, cx, 0, cx, cx, cx);
  grad.addColorStop(0,    color + "bf"); // alpha ≈ 0.75, 뉴런 핵 발광
  grad.addColorStop(0.35, color + "80"); // alpha ≈ 0.50
  grad.addColorStop(0.65, color + "33"); // alpha ≈ 0.20, halo 외곽
  grad.addColorStop(1,    color + "00"); // fade out

  oc2d.fillStyle = grad;
  oc2d.fillRect(0, 0, size, size);

  glowSpriteCache.set(color, oc);
  return oc;
}

// category → fill color (page nodes); matches the app's dark GitHub-ish palette.
// 실제 데이터 카테고리(concept/entity/source/stub)와 LLM-wiki 원래 스키마 모두 커버.
const CAT_COLOR: Record<string, string> = {
  // 실제 데이터 카테고리 (PageType: entity·concept·source·overview·answer·lesson·debate·performance + dangling=stub)
  concept: "#58a6ff", entity: "#3fb950", source: "#e3b341", stub: "#8b949e", debate: "#f778ba",
  overview: "#d2a8ff", answer: "#79c0ff", performance: "#f0883e",
  // LLM wiki 원래 스키마 카테고리 (데이터 확장 시 대비)
  claim: "#58a6ff", evidence: "#3fb950", research: "#56d4dd", decision: "#bc8cff",
  synthesis: "#d29922", reference: "#6b7a99", "debate-transcript": "#f778ba", lesson: "#db6d28",
  usage_log: "#6e7681", refinement: "#39c5cf", analysis: "#a371f7",
};
const TYPE_COLOR: Record<string, string> = { tag: "#9d7cd8", source: "#e3b341", agent: "#f0883e" };
// stance → border ring color (page nodes)
const STANCE_RING: Record<string, string> = {
  pro: "#3fb950", con: "#f85149", critic: "#f85149", neutral: "#30363d", nuanced: "#d29922",
};
const LINK_COLOR: Record<string, string> = {
  relates: "#3b4252", rebuts: "#f85149", cites: "#388bfd", supersedes: "#8957e5",
  supports: "#2ea043", refines: "#56d4dd",
  tag: "#473a5c", source: "#4d4222", author: "#2f3a4a",
};
// 시냅스(강조 링크)용 발광 톤 — 신경 신호 입자 색. 기존 의미(rebuts 빨강 등)는 유지하되 한 단계 밝게.
const SYNAPSE_GLOW: Record<string, string> = {
  relates: "#6b7a99", rebuts: "#ff7b72", cites: "#79c0ff", supersedes: "#bc8cff",
  supports: "#56d364", refines: "#7ee7ef",
  tag: "#9d7cd8", source: "#e3b341", author: "#79a8e0",
};
const CAT_LABEL: Record<string, string> = {
  // 실제 데이터 카테고리
  concept: "개념", entity: "개체", source: "출처", stub: "미완성", debate: "토론",
  overview: "종합", answer: "답변", performance: "성과",
  // LLM wiki 원래 스키마
  claim: "주장", evidence: "근거", research: "리서치", decision: "결정",
  synthesis: "종합", reference: "참고자료", "debate-transcript": "토론기록", lesson: "교훈",
  usage_log: "사용기록", refinement: "보완", analysis: "분석",
};

function nodeColor(n: WikiGraphNode): string {
  return n.type === "page" ? (CAT_COLOR[n.category || ""] || "#8b949e") : (TYPE_COLOR[n.type] || "#8b949e");
}
function nodeRadius(n: WikiGraphNode): number {
  if (n.type === "page") return 3 + Math.min(n.degree || 0, 14) * 0.85;
  if (n.type === "tag") return 2.5 + Math.min(n.count || 1, 8) * 0.45;
  return 3; // source / agent
}
function linkEndId(v: unknown): string {
  return typeof v === "object" && v !== null ? (v as { id: string }).id : (v as string);
}

interface Props { onClose: () => void; }

export default function WikiGraphView({ onClose }: Props) {
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const hoverNodeRef = useRef<string | null>(null);  // node under the cursor (set by onNodeHover)

  const [raw, setRaw] = useState<WikiGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<Exclude<WikiNodeType, "page">, boolean>>({
    tag: false, source: false, agent: false,
  });
  // 출처(원문) 페이지 노드 — category:'source' 인 변환 원문 md 페이지. 지식 그래프를 가리지 않게 기본 숨김.
  const [showSourcePages, setShowSourcePages] = useState(false);
  const [q, setQ] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ nodes: Set<string>; links: Set<unknown> }>({
    nodes: new Set(), links: new Set(),
  });
  const [detail, setDetail] = useState<WikiPageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dims, setDims] = useState({ w: 900, h: 640 });

  // load the whole wiki graph once
  useEffect(() => {
    fetchWikiGraph().then(setRaw).catch((e) => setErr(String(e)));
  }, []);

  // Spread the layout: with hundreds of nodes the default forces collapse into a
  // tight hairball. Stronger charge repulsion + longer links give Obsidian-like air.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !raw) return;
    fg.d3Force("charge")?.strength(-120);
    fg.d3Force("link")?.distance(38);
    fg.d3ReheatSimulation?.();
  }, [raw]);

  // size the canvas to its container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ESC: close drawer first, then the modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (detail) setDetail(null); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, onClose]);

  // visible subgraph (pages always; tag/source/agent by toggle). Keeps original node
  // object refs so force-graph preserves positions across toggles.
  const data = useMemo(() => {
    if (!raw) return { nodes: [] as WikiGraphNode[], links: [] as any[] };
    const visible = (t: WikiNodeType) => t === "page" || layers[t as Exclude<WikiNodeType, "page">];
    // 출처(원문) 페이지(category:'source')는 showSourcePages 가 켜졌을 때만 노출 — 기본 숨김.
    const nodes = raw.nodes.filter((n) =>
      visible(n.type) && !(n.type === "page" && n.category === "source" && !showSourcePages));
    const ids = new Set(nodes.map((n) => n.id));
    const links = raw.links.filter((l) => ids.has(linkEndId(l.source)) && ids.has(linkEndId(l.target)));
    return { nodes, links };
  }, [raw, layers, showSourcePages]);

  const searching = q.trim().length > 0;
  const matchSet = useMemo(() => {
    if (!searching) return null;
    const needle = q.trim().toLowerCase();
    return new Set(data.nodes.filter((n) => n.label.toLowerCase().includes(needle)).map((n) => n.id));
  }, [q, searching, data]);

  const onNodeHover = useCallback((node: any) => {
    hoverNodeRef.current = node ? node.id : null;
    if (!node) { setHoverId(null); setHighlight({ nodes: new Set(), links: new Set() }); return; }
    const nodes = new Set<string>([node.id]);
    const links = new Set<unknown>();
    for (const l of data.links) {
      const s = linkEndId(l.source), t = linkEndId(l.target);
      if (s === node.id || t === node.id) { links.add(l); nodes.add(s); nodes.add(t); }
    }
    setHoverId(node.id);
    setHighlight({ nodes, links });
  }, [data.links]);

  const openPage = useCallback((id: string) => {
    setDetailLoading(true);
    fetchWikiPage(id).then((d) => { setDetail(d); setDetailLoading(false); });
    const n = data.nodes.find((x) => x.id === id) as any;
    if (n && fgRef.current && n.x != null) fgRef.current.centerAt(n.x, n.y, 600);
  }, [data.nodes]);

  // Open the page on click. EMPIRICALLY, force-graph's own onNodeClick does NOT fire in
  // this setup (verified: a confirmed-hover + click never triggered it), while onNodeHover
  // fires reliably and keeps hoverNodeRef current. So we open from a plain DOM click on the
  // canvas container, using the hovered node. A real user moves onto the node (hover sets
  // the ref) before clicking, so the ref is current at click time. Empty-space click (ref
  // cleared by onNodeHover(null)) closes the drawer. We also keep onBackgroundClick UNSET:
  // enabling it turns on force-graph's pan-drag detection that swallows mouse clicks.
  const handleCanvasClick = useCallback(() => {
    const id = hoverNodeRef.current;
    if (!id) { setDetail(null); return; }
    const n = raw?.nodes.find((x) => x.id === id);
    if (n?.type === "page") openPage(id);
  }, [raw, openPage]);

  const alphaFor = (id: string): number => {
    if (searching) return matchSet!.has(id) ? 1 : 0.08;
    if (hoverId) return highlight.nodes.has(id) ? 1 : 0.12;
    return 1;
  };

  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, scale: number) => {
    const n = node as WikiGraphNode & { x: number; y: number };
    const r = nodeRadius(n);
    const a = alphaFor(n.id);
    const color = nodeColor(n);
    // 이 노드가 "발화(firing)" 대상인가 — hover 이웃 / 검색 히트 / hover 본인.
    // 무거운 효과(radial gradient + shadowBlur + 펄스)는 이 노드들에만 건다.
    const isEmphasized =
      (hoverId != null && highlight.nodes.has(n.id)) ||
      (searching && matchSet!.has(n.id));
    // 줌아웃(scale 작음)에서는 평상시 glow 생략 — dot 만 렌더해 비용 절약.
    // 줌인(scale > 0.6)에서는 스프라이트 drawImage로 카테고리 색 tint 발광.
    // 스프라이트는 색별 1회 생성 후 Map 캐시 — 매 프레임 blur/gradient 없음.
    const showAmbientGlow = !hoverId && !searching && scale > 0.6;
    ctx.save();
    ctx.globalAlpha = a;
    if (isEmphasized) {
      // 신경 발화 펄스: performance.now() 기반 0.5+0.5*sin → halo 반경/투명도 진동.
      // autoPauseRedraw=false라 매 프레임 갱신되어 살아 움직인다.
      const t = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 4 + (n.x + n.y) * 0.05);
      const haloR = r + 4 + pulse * (r * 0.9 + 3);
      const grad = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, haloR);
      grad.addColorStop(0, color + "cc");
      grad.addColorStop(0.45, color + "55");
      grad.addColorStop(1, color + "00");
      ctx.globalAlpha = a * (0.55 + pulse * 0.45);
      ctx.beginPath();
      ctx.arc(n.x, n.y, haloR, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = a;
      // soma 자체도 발광
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 + pulse * 6;
    } else if (showAmbientGlow) {
      // 평상시 뉴런 glow: 캐시된 스프라이트를 drawImage로 찍어
      // per-frame shadowBlur/createRadialGradient 비용 없이 카테고리 색 발광.
      // gr = glow 반경(그래프 단위). ctx가 이미 zoom transform 공간이라 scale 곱셈 불필요.
      const gr = r * 2.8;
      const sprite = getGlowSprite(color);
      ctx.drawImage(sprite, n.x - gr, n.y - gr, gr * 2, gr * 2);
    }
    // fill — soma는 카테고리 원본 색 유지(범례와 일치)
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    // glow가 stance border/contested 점선/라벨로 번지지 않도록 즉시 리셋
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    // stance border (page)
    if (n.type === "page") {
      ctx.lineWidth = 1.4 / scale;
      ctx.strokeStyle = STANCE_RING[n.stance || "neutral"] || "#30363d";
      ctx.stroke();
      // contested → outer dashed red ring (open contradiction)
      if (n.contested) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 2.2, 0, 2 * Math.PI);
        ctx.lineWidth = 1.2 / scale;
        ctx.setLineDash([3 / scale, 2 / scale]);
        ctx.strokeStyle = "#f85149";
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // search hit → bright halo
    if (searching && matchSet!.has(n.id)) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3, 0, 2 * Math.PI);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = "#f2cc60";
      ctx.stroke();
    }
    // label — only when zoomed in (or hovered/searched). Zoomed out it's just
    // colored dots (Obsidian-style), so a large graph stays readable.
    const strong = (hoverId != null || searching) && a === 1;
    const showLabel = n.type === "page" ? (scale > 1.4 || strong) : (scale > 2.4 || strong);
    if (showLabel) {
      const fs = Math.max(11 / scale, 1.5);
      ctx.font = `${fs}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = strong ? "#e6edf3" : "#7d8590";
      const label = n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label;
      ctx.fillText(label, n.x, n.y + r + 1.5 / scale);
    }
    ctx.restore();
  }, [searching, matchSet, hoverId, highlight]);

  const paintPointerArea = useCallback((node: any, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeRadius(node) + 2, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const linkColor = useCallback((l: any): string => {
    // 시냅스: 강조 링크는 발광 톤(SYNAPSE_GLOW), 비강조/평상시 dim 동작은 보존.
    if (hoverId) return highlight.links.has(l) ? (SYNAPSE_GLOW[l.kind] || "#6b7a99") : "rgba(70,80,100,0.05)";
    if (searching) return "rgba(70,80,100,0.18)";
    return SYNAPSE_GLOW[l.kind] || LINK_COLOR[l.kind] || "#3b4252";
  }, [hoverId, highlight, searching]);

  // 신경 신호 입자(시냅스) — 평상시는 0(대량 링크 성능 보호), hover 시 강조 링크만 발화.
  const linkParticles = useCallback((l: any): number => {
    if (!hoverId) return 0;            // 평상시: 입자 없음 → 970노드+다수 링크에서 프레임 안전
    return highlight.links.has(l) ? 4 : 0;  // 강조 시냅스만 신호 흐름
  }, [hoverId, highlight]);
  const linkParticleSpeed = useCallback((l: any): number => {
    // rebuts(반박)은 더 빠르게 — 격렬한 신호처럼.
    return l.kind === "rebuts" ? 0.018 : 0.012;
  }, []);
  const linkParticleColor = useCallback((l: any): string => {
    return SYNAPSE_GLOW[l.kind] || "#79c0ff";
  }, []);

  const toggle = (t: Exclude<WikiNodeType, "page">) =>
    setLayers((s) => ({ ...s, [t]: !s[t] }));

  const usedCats = useMemo(() => {
    const set = new Set<string>();
    // 숨긴 출처(원문) 페이지는 범례에서도 제외 — 노드가 없는데 색칩만 뜨지 않게.
    raw?.nodes.forEach((n) => {
      if (n.type === "page" && n.category && !(n.category === "source" && !showSourcePages)) set.add(n.category);
    });
    return [...set];
  }, [raw, showSourcePages]);

  return (
    <div className="brain-overlay" onClick={onClose}>
      <div className="brain-modal" onClick={(e) => e.stopPropagation()}>
        <div className="brain-toolbar">
          <div className="brain-title">🧠 제2의 두뇌 <span className="brain-sub">지식 그래프</span></div>
          <input
            className="brain-search"
            placeholder="🔍 노드 검색 (제목)…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="brain-layers">
            <button className={`brain-chip page`} disabled title="페이지는 항상 표시">● 페이지</button>
            <button className={`brain-chip${showSourcePages ? " on" : ""}`} onClick={() => setShowSourcePages((v) => !v)} title="출처(원문) 페이지 표시 — 기본 숨김">📄 출처</button>
            <button className={`brain-chip${layers.tag ? " on" : ""}`} onClick={() => toggle("tag")}># 태그</button>
            <button className={`brain-chip${layers.source ? " on" : ""}`} onClick={() => toggle("source")}>📎 자료</button>
            <button className={`brain-chip${layers.agent ? " on" : ""}`} onClick={() => toggle("agent")}>👤 직원</button>
          </div>
          <div className="brain-spacer" />
          {raw && (
            <span className="brain-stats">
              페이지 {data.nodes.filter((n) => n.type === "page").length} · 링크 {data.links.length} · 노드 {data.nodes.length}
            </span>
          )}
          <button className="brain-btn" onClick={() => fgRef.current?.zoomToFit(400, 40)} title="전체 보기">⤢ 맞춤</button>
          <button className="brain-close" onClick={onClose} title="닫기 (Esc)">✕</button>
        </div>

        <div className="brain-body">
          <div className="brain-canvas" ref={wrapRef} onClick={handleCanvasClick}>
            {err && <div className="brain-empty">⚠ {err}</div>}
            {!err && raw && data.nodes.length === 0 && (
              <div className="brain-empty">아직 위키 페이지가 없습니다. 토론이 진행되면 지식이 쌓입니다.</div>
            )}
            {!err && raw && data.nodes.length > 0 && (
              <ForceGraph2D
                ref={fgRef}
                width={dims.w}
                height={dims.h}
                graphData={data}
                backgroundColor="#0d1117"
                nodeRelSize={1}
                nodeCanvasObject={drawNode}
                nodePointerAreaPaint={paintPointerArea}
                linkColor={linkColor}
                linkWidth={(l: any) => (l.kind === "rebuts" ? 1.6 : 0.7)}
                linkCurvature={0.16}
                linkDirectionalArrowLength={(l: any) => (l.kind === "relates" || l.kind === "tag" ? 0 : 2.2)}
                linkDirectionalArrowRelPos={1}
                linkDirectionalParticles={linkParticles}
                linkDirectionalParticleWidth={1.8}
                linkDirectionalParticleSpeed={linkParticleSpeed}
                linkDirectionalParticleColor={linkParticleColor}
                onNodeHover={onNodeHover}
                cooldownTicks={120}
                d3VelocityDecay={0.3}
                autoPauseRedraw={false}
                onEngineStop={() => {
                  if (!fitted.current) { fgRef.current?.zoomToFit(400, 40); fitted.current = true; }
                }}
              />
            )}
            {/* category legend */}
            {raw && data.nodes.length > 0 && (
              <div className="brain-legend">
                {usedCats.map((c) => (
                  <span key={c} className="legend-item">
                    <i style={{ background: CAT_COLOR[c] || "#8b949e" }} />{CAT_LABEL[c] || c}
                  </span>
                ))}
                <span className="legend-item"><i className="ring-rebut" />반박</span>
              </div>
            )}
          </div>

          {/* click-to-open page detail drawer */}
          {(detail || detailLoading) && (
            <div className="brain-drawer">
              <button className="brain-close drawer-x" onClick={() => setDetail(null)}>✕</button>
              {detailLoading && <div className="muted">불러오는 중…</div>}
              {detail && (
                <>
                  <h3>{detail.title}</h3>
                  <div className="drawer-meta">
                    <span className="meta-chip" style={{ borderColor: CAT_COLOR[detail.category] }}>
                      {CAT_LABEL[detail.category] || detail.category}
                    </span>
                    <span className="meta-chip">입장: {detail.stance}</span>
                    <span className="meta-chip">상태: {detail.status}</span>
                    <span className="meta-chip">신뢰도: {detail.confidence}</span>
                  </div>
                  {detail.tags.length > 0 && (
                    <div className="drawer-tags">{detail.tags.map((t) => <span key={t}>#{t}</span>)}</div>
                  )}
                  {detail.contributors.length > 0 && (
                    <div className="drawer-line">👤 기여: {detail.contributors.join(", ")}</div>
                  )}
                  {detail.sources.length > 0 && (
                    <div className="drawer-line">📎 출처: {detail.sources.length}건</div>
                  )}
                  {detail.related.length > 0 && (
                    <div className="drawer-related">
                      <b>연결</b>
                      {detail.related.map((r, i) => (
                        <button key={i} className="related-link" onClick={() => openPage(r.other_id)}>
                          {r.direction === "out" ? "→" : "←"} <em>{r.relation}</em> {r.other_title}
                        </button>
                      ))}
                    </div>
                  )}
                  <pre className="drawer-body">{detail.body}</pre>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
