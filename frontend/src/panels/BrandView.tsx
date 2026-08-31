import { useEffect, useState } from "react";
import { fetchBrand, saveBrandProfile, fetchBrands, activateBrand, deleteBrandProfile, BrandInfo, BrandProductInfo, BrandListItem } from "../api";
import Ico from "./Ico";

// 브랜드(고객사) 프로필 — 이 스튜디오가 '누구를 위해' 콘텐츠를 만드는지 정의.
// 저장 즉시 다음 런부터 전 파이프라인(주제 제안·리서치·본문·SEO·카드뉴스·숏폼)에 주입된다.
// 미설정이면 범용 모드(기존 동작) — 배지로 현재 상태를 명확히 보여준다.
const EMPTY: BrandInfo = { name: "", products: [] };

export default function BrandView() {
  const [b, setB] = useState<BrandInfo>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  // 저장된 브랜드 레지스트리 — 여기서 전환하면 폼·헤더·전체 탭이 그 브랜드로 바뀐다.
  const [registry, setRegistry] = useState<BrandListItem[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const loadAll = () => {
    fetchBrand().then((brand) => {
      if (brand) { setB({ ...EMPTY, ...brand }); setConfigured(true); }
      else { setB(EMPTY); setConfigured(false); }
      setLoaded(true);
    });
    fetchBrands().then((r) => { setRegistry(r.brands); setActiveSlug(r.active); });
  };
  useEffect(loadAll, []);

  const doActivate = async (slug: string | null) => {
    const r = await activateBrand(slug);
    if (r.ok) { setMsg(slug ? "✓ 브랜드 전환됨" : "✓ 범용 모드로 전환됨"); loadAll(); }
    else setMsg(r.error || "전환 실패");
  };

  const doDelete = async (slug: string, name: string) => {
    if (!confirm(`"${name}" 브랜드를 삭제할까요?\n\n· 이 브랜드의 글·카드뉴스·숏폼·지식·성과가 모두 data/.trash 로 이동됩니다(복구 가능)\n· 실행 중인 작업이 있으면 삭제가 거절됩니다\n· 활성 브랜드였다면 범용 모드로 전환됩니다`)) return;
    const r = await deleteBrandProfile(slug);
    if (r.ok) { setMsg(`✓ "${name}" 삭제됨`); loadAll(); }
    else setMsg(r.error || "삭제 실패");
  };

  const set = <K extends keyof BrandInfo>(k: K, v: BrandInfo[K]) => setB((p) => ({ ...p, [k]: v }));
  const setProduct = (i: number, patch: Partial<BrandProductInfo>) =>
    setB((p) => ({ ...p, products: p.products.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const addProduct = () => setB((p) => ({ ...p, products: [...p.products, { name: "" }] }));
  const rmProduct = (i: number) => setB((p) => ({ ...p, products: p.products.filter((_, j) => j !== i) }));

  const doSave = async () => {
    if (!b.name.trim()) { setMsg("업체명은 필수입니다"); return; }
    setSaving(true); setMsg("");
    const r = await saveBrandProfile({
      ...b,
      products: b.products.filter((p) => p.name.trim()),
    });
    setSaving(false);
    if (r.ok && r.brand) { setMsg("✓ 저장됨 — 다음 런부터 전 파이프라인에 반영됩니다"); loadAll(); }
    else setMsg(r.error || "저장 실패");
  };

  if (!loaded) return <div className="apikeys"><p className="muted" style={{ padding: 24 }}>불러오는 중…</p></div>;

  return (
    <div className="apikeys brand-view">
      <div className="apikeys-head">
        <h1><Ico name="company" size={17} /> 브랜드 <span className="badge">{configured ? `${b.name} 전용` : "미설정 — 범용 모드"}</span></h1>
        <p className="apikeys-sub">
          이 스튜디오가 <b>누구를 위해</b> 콘텐츠를 만드는지 정의합니다. 저장하면 주제 제안·리서치·본문·SEO·
          카드뉴스·숏폼 전 과정에 브랜드 컨텍스트가 주입되고, 성과 학습은 제품 라인별로 집계됩니다.
          비워 두면 지금처럼 범용 콘텐츠를 만듭니다.
        </p>
      </div>

      {(registry.length > 0 || configured) && (
        <div className="review-section">
          <h3>저장된 브랜드 <span className="muted">— 선택하면 모든 탭이 그 브랜드의 자료·전략으로 전환됩니다</span></h3>
          <div className="piece-card-meta">
            <button className={`btn ghost${activeSlug == null ? " start" : ""}`} onClick={() => doActivate(null)}>
              {activeSlug == null ? "✓ " : ""}범용 모드
            </button>
            {registry.map((r) => (
              <span key={r.slug} style={{ display: "inline-flex", gap: 2 }}>
                {/* 이름만 표시(업종은 툴팁) — 업종이 길면 버튼이 과대해짐(사용자 지적 2026-07-22). */}
                <button className={`btn ghost${r.slug === activeSlug ? " start" : ""}`} onClick={() => doActivate(r.slug)} title={r.industry || undefined}>
                  {r.slug === activeSlug ? "✓ " : ""}{r.name}
                </button>
                <button className="btn ghost" title={`"${r.name}" 브랜드 삭제`} onClick={() => doDelete(r.slug, r.name)}>
                  <Ico name="trash" size={11} />
                </button>
              </span>
            ))}
            <button className="btn ghost" title="아래 폼을 비우고 새 브랜드 입력"
              onClick={() => { setB(EMPTY); setMsg("새 브랜드 정보를 입력하고 저장하세요 — 저장 시 목록에 추가되고 활성화됩니다"); }}>
              ＋ 새 브랜드
            </button>
          </div>
        </div>
      )}

      <div className="review-section">
        <h3>기본 정보</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
          <input type="text" value={b.name} placeholder="업체명 (필수)" onChange={(e) => set("name", e.target.value)} />
          <input type="text" value={b.industry ?? ""} placeholder="업종 (예: 식품, 인테리어)" onChange={(e) => set("industry", e.target.value)} />
          <input type="text" value={b.region ?? ""} placeholder="지역 (로컬 비즈니스면)" onChange={(e) => set("region", e.target.value)} />
        </div>
        <textarea rows={2} value={b.description ?? ""} placeholder="한 줄 소개 — 무엇을 하는 회사인가"
          style={{ marginTop: 8, width: "100%" }} onChange={(e) => set("description", e.target.value)} />
      </div>

      <div className="review-section">
        <h3>주요 제품/서비스 <span className="muted">— 성과 학습이 이 라인별로 집계됩니다</span></h3>
        {b.products.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <input type="text" value={p.name} placeholder="제품/서비스명" style={{ flex: "0 1 180px" }}
              onChange={(e) => setProduct(i, { name: e.target.value })} />
            <input type="text" value={p.features ?? ""} placeholder="특징·강점 한 줄" style={{ flex: "1 1 240px" }}
              onChange={(e) => setProduct(i, { features: e.target.value })} />
            <input type="text" value={p.target ?? ""} placeholder="타겟(선택)" style={{ flex: "0 1 160px" }}
              onChange={(e) => setProduct(i, { target: e.target.value })} />
            <button className="btn ghost" onClick={() => rmProduct(i)}><Ico name="trash" size={12} /></button>
          </div>
        ))}
        <button className="btn ghost" onClick={addProduct}>+ 제품 추가</button>
      </div>

      <div className="review-section">
        <h3>독자·톤</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input type="text" value={b.audience ?? ""} placeholder="타겟 고객 (예: 3040 건강 관심 주부)" onChange={(e) => set("audience", e.target.value)} />
          <input type="text" value={b.tone ?? ""} placeholder="톤앤매너 (예: 친근한 존댓말, 전문적)" onChange={(e) => set("tone", e.target.value)} />
          <input type="text" value={b.channel ?? ""} placeholder="채널 설명 (예: 네이버 블로그 — 제품 활용 하우투·후기 중심)" onChange={(e) => set("channel", e.target.value)} />
          <input type="text" value={(b.banned ?? []).join(", ")} placeholder="금지 표현·주제 (쉼표 구분)"
            onChange={(e) => set("banned", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
          <input type="text" value={(b.seedKeywords ?? []).join(", ")} placeholder="시드 키워드 (쉼표 구분) — 성과 데이터가 없을 때 주제 탐색 출발점"
            onChange={(e) => set("seedKeywords", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn start" disabled={saving || !b.name.trim()} onClick={doSave}>{saving ? "저장 중…" : "저장"}</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        💡 다른 기업의 스튜디오가 더 필요하면 <code>node scripts/new_studio.mjs --name "업체명"</code> 으로
        독립 인스턴스(별도 데이터·네이버 계정·포트)를 만들 수 있습니다.
      </p>
    </div>
  );
}
