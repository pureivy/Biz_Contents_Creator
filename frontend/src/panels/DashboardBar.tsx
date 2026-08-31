// DashboardBar — a metrics strip under the top bar (회사 · 누적토론 · TIME · WORKING ·
// OUTPUT · 위키 · 교훈 · 가동상태), styled like the reference office-sim toolbar. All
// values are live from the same folded uiState the office renders.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { fetchWikiStats, fetchAutonomyStatus, fetchBrands, activateBrand, toggleAutonomy, type AutonomyStatus, type BrandListItem } from "../api";
import { countWorking } from "../events/working";
import type { MetricKind } from "./MetricDrawer";
import Ico from "./Ico";

interface Props {
  companyName: string;
  total: number;      // 전체 직원 수 (CEO + 팀장/팀원)
  runsCount: number;  // 누적 토론(기록) 수
  onMetric?: (m: MetricKind) => void;  // 지표 클릭 → 드릴다운 패널 열기
  onOpenBrand?: () => void;            // '브랜드 관리' → 브랜드 탭 이동
}

function Chip({ icon, label, value, accent, mono, onClick }: {
  icon: ReactNode; label: string; value: string | number;
  accent?: boolean; mono?: boolean; onClick?: () => void;
}) {
  const cls = `dash-chip${accent ? " accent" : ""}${onClick ? " clickable" : ""}`;
  const inner = (
    <>
      <span className="dash-icon">{icon}</span>
      <div className="dash-meta">
        <span className="dash-label">{label}</span>
        <span className={`dash-value${mono ? " mono" : ""}`}>{value}</span>
      </div>
    </>
  );
  return onClick
    ? <button type="button" className={cls} onClick={onClick}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

export default function DashboardBar({ companyName, total, runsCount, onMetric, onOpenBrand }: Props) {
  const s = useStore();
  const [now, setNow] = useState(() => new Date());
  // 브랜드(고객사) 전환 — 회사 칩이 활성 브랜드명을 보여주고, 클릭 시 저장된 브랜드 중 선택.
  const [brands, setBrands] = useState<BrandListItem[]>([]);
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [brandMenu, setBrandMenu] = useState(false);
  const [switching, setSwitching] = useState(false);
  const brandRef = useRef<HTMLDivElement>(null);
  // 대시보드 바가 overflow-x:auto 라 absolute 메뉴가 잘린다 — 버튼 위치 기준 fixed 로 띄운다.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const toggleBrandMenu = () => {
    const r = brandRef.current?.getBoundingClientRect();
    setMenuPos(r ? { top: r.bottom + 6, left: r.left } : null);
    setBrandMenu((v) => !v);
  };
  useEffect(() => {
    const load = () => fetchBrands().then((r) => { setBrands(r.brands); setActiveBrand(r.active); }).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!brandMenu) return;
    const h = (e: MouseEvent) => { if (brandRef.current && !brandRef.current.contains(e.target as Node)) setBrandMenu(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [brandMenu]);
  const doSwitch = async (slug: string | null) => {
    if (switching || slug === activeBrand) { setBrandMenu(false); return; }
    setSwitching(true);
    const r = await activateBrand(slug);
    setSwitching(false); setBrandMenu(false);
    if (r.ok) { const b = await fetchBrands(); setBrands(b.brands); setActiveBrand(b.active); }
    else alert(r.error || "브랜드 전환 실패");
  };
  const activeName = brands.find((b) => b.slug === activeBrand)?.name;
  const [wikiTotal, setWikiTotal] = useState(0);
  const [lessonsTotal, setLessonsTotal] = useState(0);
  const [auto, setAuto] = useState<AutonomyStatus | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  // 자율 사이클 상태 — 8초 폴링(활성/대기). AUTO_CYCLE_MINUTES=0 이면 enabled=false → 칩 숨김.
  useEffect(() => {
    const load = () => fetchAutonomyStatus().then(setAuto).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  // 위키 = 저장소 지식 페이지 수(원문 source 제외; 현재 런 한정 아님). 교훈도 같은 호출로 영속 총계를
  // 받는다 — 라이브 스토어(s.lessons)는 이번 런 델타만 담아 평소 0 으로 보이던 문제(위키 칩과 동일 패턴) 보강.
  useEffect(() => {
    const load = () => fetchWikiStats().then((w) => { setWikiTotal(w.pages - w.sources); setLessonsTotal(w.lessons); }).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  // 현재 런이 위키 페이지를 추가하면 즉시 총계도 다시 가져온다.
  useEffect(() => { fetchWikiStats().then((w) => { setWikiTotal(w.pages - w.sources); setLessonsTotal(w.lessons); }).catch(() => {}); }, [s.wikiOrder.length]);

  const hhmm = now.toTimeString().slice(0, 5);
  // "WORKING" = 사무실 안무가 작업 중으로 보여주는 아바타 수 — events/working.ts 의
  // 공유 규칙(engaged 웨이브 + placeholder 제외 + running 게이트)을 그대로 사용해
  // OfficeView 와 절대 어긋나지 않는다.
  const working = countWorking(s);
  const output =
    s.messages.filter((m) => m.move === "deliverable" && (m.text || "").trim()).length +
    (s.synthesis.trim() ? 1 : 0);
  const live = s.status === "running";

  return (
    <div className="dashboard-bar">
      <div className="dash-company-wrap" ref={brandRef}>
        <button type="button" className="dash-company clickable" title="브랜드(고객사) 선택"
          onClick={toggleBrandMenu}>
          <span className="dash-logo"><Ico name="company" size={15} /></span>
          <div className="dash-company-txt">
            <b>{activeName || companyName || "AI 콘텐츠 스튜디오"}</b>
            <span>{activeName ? `${companyName || "AI 콘텐츠 스튜디오"} · 브랜드` : "AI 에이전트 조직"} ▾</span>
          </div>
        </button>
        {brandMenu && (
          <div className="upload-menu brand-menu"
            style={menuPos ? { position: "fixed", top: menuPos.top, left: menuPos.left } : undefined}>
            <button className="llm-menu-item" disabled={switching} onClick={() => doSwitch(null)}>
              {activeBrand == null ? "✓ " : ""}범용 모드 <span className="muted">(브랜드 없음)</span>
            </button>
            {brands.map((b) => (
              <button key={b.slug} className="llm-menu-item" disabled={switching} onClick={() => doSwitch(b.slug)} title={b.industry || undefined}>
                {b.slug === activeBrand ? "✓ " : ""}{b.name}
              </button>
            ))}
            {onOpenBrand && (
              <button className="llm-menu-item" onClick={() => { setBrandMenu(false); onOpenBrand(); }}>
                ＋ 브랜드 관리…
              </button>
            )}
          </div>
        )}
      </div>
      <Chip icon={<Ico name="bubble" size={14} />} label="누적 토론" value={runsCount}
        onClick={onMetric && (() => onMetric("runs"))} />
      <Chip icon={<Ico name="clock" size={14} />} label="TIME" value={hhmm} mono />
      <Chip icon={<Ico name="person" size={14} />} label="WORKING" value={`${working}/${total}`} accent={working > 0}
        onClick={onMetric && (() => onMetric("working"))} />
      <Chip icon={<Ico name="megaphone" size={14} />} label="발행" value={output} accent={output > 0}
        onClick={onMetric && (() => onMetric("output"))} />
      <Chip icon={<Ico name="document" size={14} />} label="위키" value={wikiTotal}
        onClick={onMetric && (() => onMetric("wiki"))} />
      <Chip icon={<Ico name="sparkle" size={14} />} label="인사이트" value={Math.max(lessonsTotal, s.lessons.length)}
        onClick={onMetric && (() => onMetric("lessons"))} />
      {s.approvals.length > 0 && (
        <Chip icon={<Ico name="bell" size={14} />} label="검토 대기" value={s.approvals.length} accent />
      )}
      {auto?.enabled && (
        /* 클릭 = 오토런 온/오프 토글(영속) — 꺼짐이면 30분 틱이 조용히 통과한다. */
        <Chip icon={<Ico name="setting" size={14} />} label="자율"
          value={auto.run_enabled === false ? "꺼짐" : auto.active ? "동작 중" : "대기"}
          accent={auto.active && auto.run_enabled !== false}
          onClick={() => { void toggleAutonomy().then(() => fetchAutonomyStatus().then(setAuto).catch(() => {})); }} />
      )}
      <div className={`dash-live${live ? " on" : ""}`}>
        <span className="dash-dot" />
        {live ? "가동 중" : "대기"}
      </div>
    </div>
  );
}
