import { FollowersData } from "../api";

// 팔로워·이웃 일자별 추이 모달 — 채널 카드의 👥 클릭 시(2026-07-31 사용자 확정).
// 단일 시리즈 라인(범례 불필요 — 제목이 시리즈명), 2px 선·8px+ 히트 타겟·은은한 그리드,
// 텍스트는 잉크 토큰(시리즈 색 금지) — dataviz 규칙. 외부 의존성 없음(인라인 SVG, Sparkline 관례).

export type FollowerField = "naver" | "youtube" | "instagram" | "facebook";
export const FOLLOWER_LABEL: Record<FollowerField, string> = {
  naver: "네이버 이웃", youtube: "유튜브 구독자", instagram: "인스타 팔로워", facebook: "페이스북 팔로워",
};

/** 스냅샷 배열에서 해당 채널의 (date, value) 시계열 — 수치 없는 날은 제외(수집 실패 날 0 오염 방지). */
function seriesOf(data: FollowersData, field: FollowerField): Array<{ date: string; v: number }> {
  return data.snapshots
    .map((s) => ({ date: s.date, v: s[field] }))
    .filter((p): p is { date: string; v: number } => typeof p.v === "number");
}

/** 마지막 유효값(카드 표기용) — 없으면 null. export: PerformanceView 카드가 공유. */
export function latestFollower(data: FollowersData | null, field: FollowerField): number | null {
  if (!data) return null;
  const s = seriesOf(data, field);
  return s.length ? s[s.length - 1]!.v : null;
}
/**
 * **전일 대비** 증감(사용자 확정 2026-08-02) — 최신 기록의 '하루 전 날짜' 스냅샷과 비교한다.
 *
 * 직전 기록과 비교하면 스냅샷이 빠진 날이 섞였을 때 이틀·사흘치가 하루치로 읽힌다(실측 2026-08-02:
 * 08-01 결측이라 08-02 증감이 이틀치였다). 그래서 '바로 앞 표본'이 아니라 **날짜로** 전일을 찾고,
 * 전일 기록이 없으면 전일 대비를 계산할 수 없으므로 null(화면에 증감 미표기)을 준다 —
 * 없는 날을 있는 척 메우지 않는다.
 */
export function followerDelta(data: FollowersData | null, field: FollowerField): number | null {
  if (!data) return null;
  const s = seriesOf(data, field);
  if (s.length < 2) return null;
  const cur = s[s.length - 1]!;
  const t = Date.parse(cur.date);
  if (!Number.isFinite(t)) return null;
  // 날짜 문자열(KST YYYY-MM-DD)을 UTC 자정으로 파싱해 순수 날짜 산술 — 시간대 이동 없음.
  const prevDate = new Date(t - 86_400_000).toISOString().slice(0, 10);
  const prev = s.find((p) => p.date === prevDate);
  return prev ? cur.v - prev.v : null;
}

/**
 * Y축 눈금(순수) — 팔로워 수는 음수가 없는 정수 카운트다.
 * 종전 [y1,(y0+y1)/2,y0] 를 그대로 반올림해 라벨을 만들면 두 가지가 깨졌다(실측 2026-08-02):
 *  - 전부 0인 시리즈(페북) → y0 를 -1 로 내려 **"-1" 음수 라벨**이 떴다.
 *  - [0,0,1] 시리즈(네이버 이웃) → 중간값 0.5 가 1 로 반올림돼 **"1"이 두 번** 찍혔다.
 * 하한은 0 미만으로 내리지 않고, 눈금은 정수로 만든 뒤 중복을 제거한다.
 */
export function axisTicks(vs: number[]): { y0: number; y1: number; ticks: number[] } {
  const lo = Math.max(0, Math.min(...vs));
  let y0 = lo, y1 = Math.max(...vs);
  if (y0 === y1) { y0 = Math.max(0, y0 - 1); y1 = y0 + (y1 === 0 ? 1 : 2); } // flat 시계열에 폭 부여(0 아래로 안 감)
  const ticks = [...new Set([y1, Math.round((y0 + y1) / 2), y0])].sort((a, b) => b - a);
  return { y0, y1, ticks };
}

function TrendChart({ points }: { points: Array<{ date: string; v: number }> }) {
  const W = 560, H = 230, L = 48, R = 20, T = 18, B = 30;
  if (!points.length) return <p className="muted" style={{ padding: 20 }}>아직 스냅샷이 없습니다 — 일일 브리핑이 매일 아침 기록합니다.</p>;
  const xs = points.map((p) => Date.parse(p.date));
  const vs = points.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const { y0, y1, ticks } = axisTicks(vs);
  const x = (t: number) => (x1 === x0 ? (L + (W - R)) / 2 : L + ((t - x0) / (x1 - x0)) * (W - L - R));
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(Date.parse(p.date)).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const fmtD = (d: string) => d.slice(5).replace("-", "/"); // MM/DD
  const last = points[points.length - 1]!;
  const gridV = ticks;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="일자별 추이" style={{ display: "block" }}>
      {/* 은은한 그리드 3선 + 좌측 값 라벨(잉크 토큰·저대비) */}
      {gridV.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" opacity="0.12" />
          <text x={L - 7} y={y(v) + 3.5} textAnchor="end" fontSize="10.5" fill="currentColor" opacity="0.55">{Math.round(v).toLocaleString()}</text>
        </g>
      ))}
      {/* X 축 날짜 — 처음·끝만(점 수가 적어 과밀 방지) */}
      <text x={L} y={H - 9} fontSize="10.5" fill="currentColor" opacity="0.55">{fmtD(points[0]!.date)}</text>
      {points.length > 1 && <text x={W - R} y={H - 9} textAnchor="end" fontSize="10.5" fill="currentColor" opacity="0.55">{fmtD(last.date)}</text>}
      {points.length > 1 && <path d={path} fill="none" stroke="var(--accent, #5598f8)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {/* 포인트 + 네이티브 툴팁(투명 확장 히트 타겟 r=10 ≥ 8px 규칙) */}
      {points.map((p) => (
        <g key={p.date}>
          <circle cx={x(Date.parse(p.date))} cy={y(p.v)} r="3" fill="var(--accent, #5598f8)" />
          <circle cx={x(Date.parse(p.date))} cy={y(p.v)} r="10" fill="transparent">
            <title>{`${p.date} — ${p.v.toLocaleString()}`}</title>
          </circle>
        </g>
      ))}
      {/* 마지막 값 직접 라벨 — 잉크 토큰(시리즈 색 금지) */}
      <text x={Math.min(x(Date.parse(last.date)) + 8, W - R)} y={y(last.v) - 8} fontSize="12" fontWeight="700" fill="currentColor"
        textAnchor={x(Date.parse(last.date)) > W - 70 ? "end" : "start"}>{last.v.toLocaleString()}</text>
    </svg>
  );
}

export default function FollowerTrendModal({ data, field, onClose }: { data: FollowersData; field: FollowerField; onClose: () => void }) {
  const points = seriesOf(data, field);
  // 목표는 4채널 합계 기준(1,000명) — 채널 라인에 목표선을 긋지 않고 합계 문구로 안내.
  const latest = data.latest;
  const total = latest ? (["naver", "youtube", "instagram", "facebook"] as const).reduce((n, f) => n + (typeof latest[f] === "number" ? (latest[f] as number) : 0), 0) : 0;
  return (
    <div className="metric-overlay" onClick={onClose}>
      <div className="fol-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fol-modal-head">
          <h3 style={{ margin: 0, fontSize: 15 }}>{FOLLOWER_LABEL[field]} 추이</h3>
          <button className="btn ghost" onClick={onClose}>닫기</button>
        </div>
        <TrendChart points={points} />
        <div className="muted" style={{ fontSize: 12, padding: "2px 6px 4px" }}>
          4채널 합계 {total.toLocaleString()}명 · 목표 {data.goal.toLocaleString()}명 ({(total / data.goal * 100).toFixed(1)}%)
          {points.length < 5 && " · 스냅샷이 매일 쌓이며 그래프가 길어집니다"}
        </div>
      </div>
    </div>
  );
}
