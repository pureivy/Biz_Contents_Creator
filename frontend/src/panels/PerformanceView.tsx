import { useEffect, useState } from "react";
import { fetchPerformance, fetchFollowers, refreshPerformance, deletePiece, deleteShorts, deleteCardNews, PerfData, FollowersData } from "../api";
import Ico, { type IcoName } from "./Ico";
import PlatformMark, { type Platform } from "./PlatformMark";
import FollowerTrendModal, { type FollowerField, latestFollower, followerDelta } from "./FollowerTrend";
import TitleTimingSection from "./TitleTiming";

// 성과 대시보드 — 채널 통합 요약(블로그·쇼츠·카드뉴스) → 블로그 글별 → 쇼츠·카드뉴스 → 강화 학습 순.
// 스테이지 어휘는 캘린더·검토 탭과 동일(Ico).

/** 측정 시각 표기 — 오늘이면 시:분만, 이전이면 월-일 시:분. 값 없으면 "기록 없음". */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "기록 없음";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "기록 없음";
  const hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

// 조회수 추이 스파크라인 — 인라인 SVG(의존성·외부요청 없음). 하루 1점 시계열(뒤가 최신).
// 데이터 2점 미만이면 미표시(추세 없음), 마지막 점은 강조 dot. 값 범위 flat 이면 중앙선.
function Sparkline({ data, title }: { data: number[]; title?: string }) {
  if (!data || data.length < 2) return <span className="spark-empty" title="추이 데이터 부족">–</span>;
  const w = 64, h = 18, pad = 2;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = data[data.length - 1]! >= data[0]!; // 상승/하강 색
  const stroke = up ? "var(--spark-up, #3fb950)" : "var(--spark-down, #f85149)";
  const lx = x(data.length - 1), ly = y(data[data.length - 1]!);
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img"
      aria-label={title || "조회수 추이"} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2" fill={stroke} />
    </svg>
  );
}
const STAGE_LABEL: Record<string, { icon: IcoName; label: string }> = {
  published: { icon: "megaphone", label: "발행됨" }, measured: { icon: "chart", label: "측정됨" },
  reflected: { icon: "arrow-up-right", label: "강화 반영" }, ready: { icon: "eye", label: "검토 대기" },
  idea: { icon: "sparkle", label: "아이디어" }, research: { icon: "search", label: "리서치" },
  draft: { icon: "pencil", label: "초안" }, error: { icon: "triangle-exclamation", label: "실패" },
};

export default function PerformanceView() {
  const [data, setData] = useState<PerfData | null>(null);
  const [loading, setLoading] = useState(true);
  // 표별 '더 보기' 펼침 상태 — 기본은 최근 5개만, 펼치면 전체(각 표는 이미 최신순 정렬).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 팔로워·이웃 스냅샷(일일 브리핑 수집 공유) + 추이 모달로 연 채널(2026-07-31 사용자 확정).
  const [followers, setFollowers] = useState<FollowersData | null>(null);
  const [trend, setTrend] = useState<FollowerField | null>(null);

  const load = () => { setLoading(true); return fetchPerformance().then((d) => { setData(d); setLoading(false); }); };
  useEffect(() => { void load(); void fetchFollowers().then(setFollowers); }, []);

  // 새로고침 = 채널 성과 즉시 재수집(쇼츠 유튜브·릴스·카드뉴스 API + 네이버 블로그 Playwright) 후 재조회 —
  // 종전엔 저장값 재조회뿐이라 숫자가 안 변해 '죽은 버튼'으로 보였다(2026-07-20 사용자 보고).
  // 블로그는 발행 감지 후 측정창 지난 미측정 글만 수집(브라우저 열릴 수 있음·로그인 세션 필요·프로필 사용 중이면 건너뜀).
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg("⏳ 재수집 중… (네이버 일일 수집이 있으면 브라우저 창이 여러 번 열렸다 닫힐 수 있어요)");
    const r = await refreshPerformance(); // 서버는 즉시 응답(백그라운드 수집) — 진행 중이었으면 그 수집에 합류
    if (!r.ok) {
      await load(); // 시작 실패해도 표시는 최신 저장값으로 갱신
      void fetchFollowers().then(setFollowers);
      setRefreshing(false);
      setRefreshMsg(`⚠ ${r.error || "재수집 실패"} — 표시만 갱신됨`);
      return;
    }
    // 완료까지 폴링(최대 8분 — 네이버 순차 브라우저 런은 조각 수에 비례) — 도중에도 표를 계속 갱신.
    const deadline = Date.now() + 8 * 60_000;
    // 팔로워는 순수 API 라 서버에서 1~2초면 끝난다(실측 2026-08-02). 반면 네이버 조각 수집은 수 분 걸리고
    // refreshBusy 는 그때까지 참이다. 폴링이 끝난 뒤에야 팔로워를 읽으면 이미 갱신된 값이 몇 분간 화면에
    // 안 뜬다 — 사용자에겐 "새로고침해도 숫자가 그대로"로 보인다(신고 2026-08-02). 폴링 안에서 같이 읽는다.
    void fetchFollowers().then(setFollowers);
    let d = await fetchPerformance();
    while (d?.refreshBusy && Date.now() < deadline) {
      setData(d);
      await new Promise((res) => setTimeout(res, 5000));
      d = await fetchPerformance();
      void fetchFollowers().then(setFollowers);
    }
    if (d) setData(d);
    await fetchFollowers().then(setFollowers);
    setRefreshing(false);
    const t = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    setRefreshMsg(d?.refreshBusy ? "⏳ 수집이 아직 진행 중 — 잠시 후 새로고침으로 확인하세요" : `✓ ${t} 재수집됨`);
  };

  // 행 삭제(완전 삭제) — 대시보드 카드 + 연결 파일(산출물·초안 세션·성과 기록)을 휴지통(data/.trash)으로
  // 이동(사용자 요청 2026-07-22). 네이버·유튜브·인스타에 이미 게시된 원격 게시물은 남는다.
  const doDelete = async (id: string, title: string) => {
    if (!confirm(`"${title}" 글을 삭제할까요?\n카드와 초안·성과 기록이 함께 삭제(휴지통 이동)됩니다.\n네이버에 발행된 글은 남습니다.`)) return;
    const r = await deletePiece(id, { purge: true });
    if (r.ok) load(); else alert(r.error || "삭제 실패");
  };
  // 숏폼 한 레코드가 유튜브·릴스 양쪽 행으로 나타남 — 삭제 시 두 표 모두에서 사라진다(명시 안내).
  const doDeleteShorts = async (id: string, title: string) => {
    if (!confirm(`"${title}" 숏폼을 삭제할까요?\n제작실 카드·영상 산출물·성과 기록이 함께 삭제(휴지통 이동)되고, 유튜브·릴스 성과 행이 모두 사라집니다.\n유튜브·인스타에 게시된 영상은 남습니다.`)) return;
    const r = await deleteShorts(id, { purge: true });
    if (r.ok) load(); else alert(r.error || "삭제 실패");
  };
  const doDeleteCardnews = async (id: string, topic: string) => {
    if (!confirm(`"${topic}" 카드뉴스를 삭제할까요?\n제작실 카드·슬라이드 산출물·성과 기록이 함께 삭제(휴지통 이동)됩니다.\n인스타에 게시된 게시물은 남습니다.`)) return;
    const r = await deleteCardNews(id, { purge: true });
    if (r.ok) load(); else alert(r.error || "삭제 실패");
  };

  const s = data?.summary;
  const winners = data?.strategy.winners ?? [];
  const subNiches = Object.entries(data?.strategy.subNiches ?? {}).sort((a, b) => b[1] - a[1]);
  const channelLessons = data?.strategy.channelLessons ?? [];
  const ch = data?.channels;
  // null = 아직 수집 전(발행 후 첫 일일 틱 대기) — 0 과 구분해 "—" 로 표시.
  const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
  // 발행·업로드 날짜 표기 — YYYY.MM.DD(로컬). 없으면 "—".
  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—"
      : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  };
  // 측정창 종료 후 학습 강화 반영 여부 칩 — 3상태. '측정 중'(창 안, 정상 대기)과 '수집 불가'(비공개·삭제·
  // 포기 지평 경과로 영구 정체)를 구분해야 죽은 행이 대기 중인 척 남지 않는다.
  // 채널(쇼츠·릴스·카드뉴스) 강화는 담당 직원 메모리 + 위키를 갱신한다. 키워드·서브니치 EWMA 전략은
  // 블로그 경로 전용(reinforce.ts 의 updateStrategy)이라 여기 문구에 섞으면 안 된다.
  // 채널 링크 배지 — 게시됐으면 브랜드 마크 링크, 미게시면 같은 폭의 흐린 단색 마크(행마다 열이 흔들리지 않게).
  const linkBadge = (name: Platform, url: string | null | undefined, onTitle: string, offTitle: string) =>
    url
      ? <a className="perf-link-badge" href={url} target="_blank" rel="noreferrer" title={onTitle}><PlatformMark name={name} size={14} /></a>
      : <span className="perf-link-badge off" title={offTitle}><PlatformMark name={name} size={14} mono /></span>;
  const reflBadge = (reflected: boolean, stale?: boolean) => {
    if (reflected) return <span className="chip" title="측정창이 끝나 성과가 담당 직원 메모리·위키에 학습 반영됐습니다.">✓ 반영</span>;
    if (stale) return <span className="chip stale" title="수집 대상에서 빠졌습니다 — 영상·게시물이 비공개·삭제됐거나 측정 기한이 지나 성과를 더는 가져올 수 없습니다. 학습에 반영되지 않습니다.">수집 불가</span>;
    return <span className="chip muted" title="측정창이 아직 진행 중입니다 — 창이 끝나면 성과가 담당 직원 메모리·위키에 1회 학습 반영됩니다.">측정 중</span>;
  };
  // 채널별 분리 — 한 숏폼이 유튜브·인스타 양쪽에 발행됐으면 각 섹션에 각각 나타난다(채널별 성과 독립).
  // 정렬·업로드일도 채널별 타임스탬프 사용(youtube.ts / meta.ts) — 상단 r.ts(최신값)와 달라 섹션별로 정확.
  const ytShorts = (ch?.shorts.filter((r) => r.youtube) ?? [])
    .sort((a, b) => (b.youtube!.ts).localeCompare(a.youtube!.ts));
  const reels = (ch?.shorts.filter((r) => r.meta) ?? [])
    .sort((a, b) => (b.meta!.ts).localeCompare(a.meta!.ts));
  const cardnews = ch?.cardnews ?? [];
  // 전체 조회 합계 — 위 조회 카드 5종의 합. 좋아요(단위 다름)는 제외한다.
  const totalViews = (s?.totalViews ?? 0) + (ch?.summary.shortsYtViews ?? 0) + (ch?.summary.reelsViews ?? 0)
    + (ch?.summary.cardnewsViews ?? 0) + (ch?.summary.fbReelViews ?? 0);

  // 최근 5개만 기본 표시, 나머지는 '더 보기'로 펼침(표별 독립 상태). 배열은 이미 최신순.
  const LIMIT = 5;
  const take = <T,>(key: string, rows: T[]) => (expanded[key] ? rows : rows.slice(0, LIMIT));
  const moreBtn = (key: string, total: number) =>
    total > LIMIT ? (
      <div className="perf-more-row">
        <button className="btn ghost" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}>
          {expanded[key] ? "접기" : `더 보기 (+${total - LIMIT})`}
        </button>
      </div>
    ) : null;

  // 측정 신선도 — 블로그 조각들의 measuredAt 중 최신. 하나도 측정 안 됐으면 null.
  const lastMeasuredAt = (data?.pieces ?? [])
    .map((p) => p.measuredAt)
    .filter((t): t is string => typeof t === "string" && !!t)
    .sort()
    .pop() ?? null;

  // 카드 보조 지표(좋아요·안내 문구) — 조회수와 시각적 위계 분리(작고 옅게). 다크/라이트 모두 opacity 로 무난.
  const subStyle = { fontSize: 11, opacity: 0.65, marginTop: 3 } as const;
  // 채널 카드의 팔로워 표기 — 좋아요 '옆'에 인라인(구분점 포함, 사용자 확정 2026-07-31). 현재값+전일 증감,
  // 클릭 시 일자별 추이 모달. 스냅샷 없으면 표기 생략(빈 0 오해 방지).
  const folStat = (field: FollowerField, label: string) => {
    const cur = latestFollower(followers, field);
    if (cur == null) return null;
    // 전일 대비 증감(사용자 확정 2026-08-02) — 전일 스냅샷이 없으면 null 이라 증감을 생략한다.
    const d = followerDelta(followers, field);
    const deltaTxt = d != null && d !== 0 ? ` (${d > 0 ? "+" : ""}${d.toLocaleString()})` : "";
    return (
      <>
        {" · "}
        <button className="fol-link" onClick={() => setTrend(field)}
          title={`${label} — 전일 대비 증감${d == null ? "(전일 기록이 없어 생략)" : ""}. 클릭하면 일자별 추이 그래프`}>
          👥 {label} {cur.toLocaleString()}{deltaTxt} ▸
        </button>
      </>
    );
  };

  return (
    <div className="apikeys perf-view">
      <div className="apikeys-head">
        <h1><Ico name="chart" size={17} /> 성과 대시보드</h1>
        <p className="apikeys-sub">
          블로그·쇼츠·카드뉴스 채널별 성과와, 성과로 학습된 전략(키워드·서브니치 EWMA)을 모아 봅니다.
          <button className="btn ghost" style={{ marginLeft: 10 }} onClick={() => { void doRefresh(); }} disabled={refreshing}
            title="블로그·쇼츠 유튜브·릴스·카드뉴스 성과를 즉시 재수집합니다 (블로그는 발행 14일 안 글의 오늘분 일일 추적 + 측정창 지난 미측정 글 강화 — 하루 1회 멱등, 브라우저가 열릴 수 있고 네이버 로그인 세션이 필요)">
            {refreshing ? "재수집 중…" : "새로고침"}
          </button>
          {refreshMsg && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{refreshMsg}</span>}
          {/* 신선도 표기 — 숫자가 그대로일 때 '수집이 안 됐다'와 '수집했는데 실제로 안 변했다'를 구분할
              수단이 없었다(사용자 신고 2026-08-02). 블로그 조회는 네이버 하루 1회 게이트라 같은 날
              새로고침해도 시각이 안 바뀌는 게 정상 — 그 사실이 화면에 보여야 한다. */}
          <span className="muted" style={{ display: "block", marginTop: 6, fontSize: 11.5 }}>
            블로그 조회 마지막 측정 {fmtWhen(lastMeasuredAt)}<span style={{ opacity: 0.7 }}> (네이버는 하루 1회 — 같은 날 새로고침해도 조회수는 안 바뀝니다)</span>
            {" · "}팔로워 기준 {fmtWhen(followers?.latest?.ts ?? null)}
          </span>
        </p>
      </div>

      {loading && <div className="muted" style={{ padding: 24 }}>불러오는 중…</div>}

      {data && (
        <>
          {/* 요약 카드 — 채널당 1장: 조회(크게)+좋아요(작게, 해당 표의 👍 열 합과 일치). 사용자 제안 2026-07-30. */}
          <div className="perf-summary">
            <div className="perf-card">
              <div className="perf-num">{(s?.totalViews ?? 0).toLocaleString()}</div>
              <div className="perf-lbl">블로그 조회</div>
              <div style={subStyle} title="네이버 공감(리액션 총합) 합계 — 블로그 표의 공감 열 합과 일치">💚 공감 {(s?.blogLikes ?? 0).toLocaleString()}{folStat("naver", "이웃")}</div>
            </div>
            <div className="perf-card">
              <div className="perf-num">{(ch?.summary.shortsYtViews ?? 0).toLocaleString()}</div>
              <div className="perf-lbl">쇼츠 유튜브 조회</div>
              <div style={subStyle} title="유튜브 좋아요 합계 — 쇼츠 표의 유튜브 👍 열 합과 일치">👍 {(ch?.summary.ytLikes ?? 0).toLocaleString()}{folStat("youtube", "구독")}</div>
            </div>
            <div className="perf-card">
              <div className="perf-num">{(ch?.summary.reelsViews ?? 0).toLocaleString()}</div>
              <div className="perf-lbl" title="인스타그램 릴스만의 조회 합계 — 페이스북은 합산하지 않고 릴스 표의 페이스북 그룹에서 따로 봅니다">인스타 릴스 조회</div>
              <div style={subStyle} title="인스타 릴스 좋아요 합계 — 쇼츠 표의 인스타 👍 열 합과 일치">👍 {(ch?.summary.reelsLikes ?? 0).toLocaleString()}{folStat("instagram", "팔로워")}</div>
            </div>
            <div className="perf-card">
              <div className="perf-num">{(ch?.summary.cardnewsViews ?? 0).toLocaleString()}</div>
              <div className="perf-lbl" title="인스타그램 카드뉴스만의 조회 합계">인스타 카드뉴스 조회</div>
              <div style={subStyle} title="인스타 카드뉴스 좋아요 합계 — 카드뉴스 표의 인스타 좋아요 열 합과 일치">👍 {(ch?.summary.cardnewsLikes ?? 0).toLocaleString()}</div>
            </div>
            <div className="perf-card">
              <div className="perf-num">{(ch?.summary.fbReelViews ?? 0).toLocaleString()}</div>
              <div className="perf-lbl" title="페이스북 페이지 릴스 조회 합계. 페이스북은 영상만 조회 지표가 있습니다">페이스북 릴스 조회</div>
              <div style={subStyle} title="페이스북 릴스 좋아요 합계 — 쇼츠 표의 페이스북 👍 열 합과 일치">👍 {(ch?.summary.fbReelLikes ?? 0).toLocaleString()}{folStat("facebook", "팔로워")}</div>
            </div>
            <div className="perf-card">
              <div className="perf-num">{(ch?.summary.fbPostLikes ?? 0).toLocaleString()}</div>
              <div className="perf-lbl" title="페이스북 카드뉴스 게시물 좋아요 합계 — 카드뉴스 표의 페이스북 좋아요 열 합과 일치합니다">페북 카드뉴스 좋아요</div>
              {/* 사진 게시물은 조회·노출 지표 미제공(실측: post_impressions 계열 무효, read_insights 앱심사 필요) — 오해 방지 안내. */}
              <div style={subStyle}>조회수 미제공 (메타 API 제한)</div>
            </div>
            {/* 전체 합계 = 화면에 있는 조회 카드 5개의 합(사용자가 눈으로 검산할 수 있게 같은 값에서 계산). */}
            <div className="perf-card total">
              <div className="perf-num">{totalViews.toLocaleString()}</div>
              <div className="perf-lbl" title="블로그 + 쇼츠 유튜브 + 인스타 릴스 + 인스타 카드뉴스 + 페이스북 릴스 조회의 합계. 좋아요는 단위가 달라 제외됩니다">전체 조회 합계</div>
            </div>
          </div>

          {/* 팔로워 추이 모달 — 채널 카드의 👥 클릭으로 열림(고정 오버레이라 DOM 위치 무관). */}
          {trend && followers && <FollowerTrendModal data={followers} field={trend} onClose={() => setTrend(null)} />}

          {/* 블로그 성과 — 글별 표. 발행/측정/반영 카운트는 제목 옆(요약 카드는 채널 통합으로 승격). */}
          <div className="review-section">
            <h3>블로그 성과 <span className="muted">발행 {s?.count ?? 0} · 측정 {s?.measured ?? 0} · 강화 반영 {data.strategy.measuredPieces}</span></h3>
            {data.pieces.length === 0 ? (
              <p className="muted">발행된 글이 아직 없습니다. 검토 탭에서 발행 후 성과를 수집하세요.</p>
            ) : (
              <div className="perf-table-wrap">
                <table className="perf-table">
                  <colgroup>
                    <col className="perf-col-title" /><col className="perf-col-link" />
                    <col className="perf-col-date perf-grp-start" /><col className="perf-col-state" />
                    <col className="perf-col-num" /><col className="perf-col-num" /><col className="perf-col-num" /><col className="perf-col-inflow" /><col className="perf-col-num" />
                    <col className="perf-col-num perf-grp-start" /><col className="perf-col-num" />
                    <col className="perf-col-refl perf-grp-start" /><col className="perf-col-act" />
                  </colgroup>
                  <thead>
                    <tr className="perf-grouprow">
                      <th className="perf-grp-soft" colSpan={2}>콘텐츠</th>
                      <th colSpan={7}><span className="perf-grp-in"><PlatformMark name="naver" size={13} /> 네이버 블로그</span></th>
                      <th className="perf-grp-soft perf-grp-edge" colSpan={2}>파생</th>
                      <th className="perf-grp-soft perf-grp-edge" colSpan={2}>학습</th>
                    </tr>
                    <tr>
                      <th>제목</th>
                      <th className="perf-c">링크</th>
                      <th className="perf-c perf-grp-edge">발행일</th>
                      <th className="perf-c">상태</th>
                      <th className="perf-r">조회수</th>
                      <th className="perf-r">체류</th>
                      <th className="perf-r" title="네이버 공감(리액션 총합) — 매일 성과 수집 때 함께 갱신">공감</th>
                      <th className="perf-c">유입 키워드(상위)</th>
                      <th className="perf-r">SEO</th>
                      <th className="perf-c perf-grp-edge" title="파생 카드뉴스 완성 여부"><Ico name="cards" size={13} /></th>
                      <th className="perf-c" title="파생 숏폼 완성 여부"><Ico name="play" size={13} /></th>
                      <th className="perf-r perf-grp-edge" title="성과 측정 표본 수">측정</th>
                      <th className="perf-c"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {take("blog", data.pieces).map((p) => (
                      <tr key={p.id}>
                        <td className="perf-title">
                          <div className="perf-title-row">
                            <span className="perf-title-txt" title={p.title}>{p.title}</span>
                            {p.keyword && <span className="chip"><Ico name="location" size={11} /> {p.keyword}</span>}
                          </div>
                        </td>
                        <td className="perf-c">
                          <span className="perf-links">
                            {linkBadge("naver", p.publishedUrl, "네이버 블로그에서 열기", "네이버 미발행")}
                          </span>
                        </td>
                        <td className="perf-date perf-c perf-grp-edge">{fmtDate(p.date)}</td>
                        <td className="perf-c"><span className="badge">{STAGE_LABEL[p.stage] ? <><Ico name={STAGE_LABEL[p.stage].icon} size={10} /> {STAGE_LABEL[p.stage].label}</> : p.stage}</span></td>
                        <td className="perf-r">{p.views != null ? p.views.toLocaleString() : "—"}</td>
                        <td className="perf-r">{p.dwellSec != null ? `${p.dwellSec}s` : "—"}</td>
                        <td className="perf-r">{p.likes != null ? p.likes.toLocaleString() : "—"}</td>
                        <td className="perf-inflow perf-c">
                          {p.inflow.length === 0 ? <span className="muted">—</span>
                            : p.inflow.slice(0, 4).map((k) => (
                              <span key={k.keyword} className="chip">{k.keyword} {k.count}</span>
                            ))}
                        </td>
                        <td className="perf-r">{typeof p.seoScore === "number" ? p.seoScore : "—"}</td>
                        {/* 파생 콘텐츠 세트 완성 여부 — ✓ 완성 / … 생성 중 / — 없음 */}
                        <td className="perf-c perf-grp-edge" title={p.derived?.cardnews ? `카드뉴스 ${p.derived.cardnews.stage}` : "카드뉴스 없음"}>
                          {p.derived?.cardnews ? (p.derived.cardnews.stage === "ready" ? "✓" : p.derived.cardnews.stage === "error" ? <Ico name="triangle-exclamation" size={11} /> : "…") : "—"}
                        </td>
                        <td className="perf-c" title={p.derived?.shorts ? `숏폼 ${p.derived.shorts.stage}` : "숏폼 없음"}>
                          {p.derived?.shorts ? (p.derived.shorts.stage === "ready" ? "✓" : p.derived.shorts.stage === "error" ? <Ico name="triangle-exclamation" size={11} /> : "…") : "—"}
                        </td>
                        <td className="perf-r muted perf-grp-edge">{p.samples || "—"}</td>
                        <td className="perf-c"><button className="btn ghost" title="카드 삭제" onClick={() => doDelete(p.id, p.title)}><Ico name="trash" size={12} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {moreBtn("blog", data.pieces.length)}
              </div>
            )}
          </div>

          {/* 채널별 성과 — 유튜브 쇼츠 / 인스타 릴스 / 카드뉴스 각각 구분(매일 자동 수집). 한 숏폼이 양쪽 발행이면 각 표에 각각. */}
          <div className="review-section">
            <h3>유튜브 쇼츠 성과 <span className="muted">(매일 자동 수집)</span></h3>
            {ytShorts.length > 0 ? (
              <div className="perf-table-wrap">
                <table className="perf-table">
                  <colgroup>
                    <col className="perf-col-title" /><col className="perf-col-link" />
                    <col className="perf-col-date perf-grp-start" /><col className="perf-col-spark" /><col className="perf-col-num" /><col className="perf-col-num" />
                    <col className="perf-col-refl perf-grp-start" /><col className="perf-col-act" />
                  </colgroup>
                  <thead>
                    {/* 릴스·카드뉴스와 같은 2단 구조 — 네 표의 헤더 리듬을 맞춘다(단일 채널이라 그룹은 하나). */}
                    <tr className="perf-grouprow">
                      <th className="perf-grp-soft" colSpan={2}>콘텐츠</th>
                      <th colSpan={4}><span className="perf-grp-in"><PlatformMark name="youtube" size={13} /> 유튜브</span></th>
                      <th className="perf-grp-soft perf-grp-edge" colSpan={2}>학습</th>
                    </tr>
                    <tr>
                      <th>숏폼</th>
                      <th className="perf-c">링크</th>
                      <th className="perf-c perf-grp-edge">업로드일</th>
                      <th className="perf-c" title="유튜브 조회수 일별 추이">추이</th>
                      <th className="perf-r">조회</th>
                      <th className="perf-r">👍</th>
                      <th className="perf-c perf-grp-edge" title="직원 메모리·위키에 학습 반영(✓ 반영) / 측정창 진행 중(측정 중) / 비공개·삭제·기한 경과로 영구 정체(수집 불가)">반영</th>
                      <th className="perf-c"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {take("yt", ytShorts).map((r) => (
                      <tr key={r.id}>
                        <td className="perf-title">
                          <div className="perf-title-row">
                            <span className="perf-title-txt" title={r.title}>{r.title}</span>
                          </div>
                        </td>
                        <td className="perf-c">
                          <span className="perf-links">{linkBadge("youtube", r.youtube?.url, "유튜브에서 열기", "유튜브 미업로드")}</span>
                        </td>
                        <td className="perf-date perf-c perf-grp-edge">{fmtDate(r.youtube?.ts ?? r.ts)}</td>
                        <td className="perf-spark perf-c"><Sparkline data={r.youtube?.series ?? []} title={`${r.title} 유튜브 조회 추이`} /></td>
                        <td className="perf-r">{r.youtube ? fmt(r.youtube.views) : "—"}</td>
                        <td className="perf-r">{r.youtube ? fmt(r.youtube.likes) : "—"}</td>
                        <td className="perf-c perf-grp-edge">{r.youtube ? reflBadge(r.youtube.reflected, r.youtube.stale) : "—"}</td>
                        <td className="perf-c"><button className="btn ghost" title="숏폼 삭제 — 산출물·성과 포함(유튜브·릴스 행 모두 사라짐)" onClick={() => doDeleteShorts(r.id, r.title)}><Ico name="trash" size={12} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {moreBtn("yt", ytShorts.length)}
              </div>
            ) : (
              <p className="muted">유튜브에 발행된 쇼츠가 아직 없습니다.</p>
            )}
          </div>

          <div className="review-section">
            <h3>릴스 성과 <span className="muted">(인스타·페이스북 · 매일 자동 수집)</span></h3>
            {reels.length > 0 ? (
              <div className="perf-table-wrap">
                <table className="perf-table">
                  <colgroup>
                    <col className="perf-col-title" /><col className="perf-col-link" />
                    <col className="perf-col-date perf-grp-start" /><col className="perf-col-spark" /><col className="perf-col-num" /><col className="perf-col-num" />
                    <col className="perf-col-date perf-grp-start" /><col className="perf-col-spark" /><col className="perf-col-num" /><col className="perf-col-num" />
                    <col className="perf-col-refl perf-grp-start" /><col className="perf-col-act" />
                  </colgroup>
                  <thead>
                    {/* 2단 헤더 — 같은 릴스가 두 플랫폼에 올라가므로 지표 열을 채널로 묶는다.
                        모든 열을 그룹이 덮는다(앞뒤 빈 칸이 남으면 미완성처럼 보임). */}
                    <tr className="perf-grouprow">
                      <th className="perf-grp-soft" colSpan={2}>콘텐츠</th>
                      <th colSpan={4}><span className="perf-grp-in"><PlatformMark name="instagram" size={13} /> 인스타그램</span></th>
                      <th className="perf-grp-edge" colSpan={4}><span className="perf-grp-in"><PlatformMark name="facebook" size={13} /> 페이스북</span></th>
                      <th className="perf-grp-soft perf-grp-edge" colSpan={2}>학습</th>
                    </tr>
                    <tr>
                      <th>릴스</th>
                      <th className="perf-c">링크</th>
                      {/* 게시일은 채널 소속 — 같은 릴스를 인스타·페북에 다른 날 올릴 수 있어 한 열로는 한쪽이 거짓이 된다. */}
                      <th className="perf-c perf-grp-edge">게시일</th>
                      <th className="perf-c" title="인스타 릴스 조회수 일별 추이">추이</th>
                      <th className="perf-r">조회</th>
                      <th className="perf-r">👍</th>
                      <th className="perf-c perf-grp-edge" title="페이스북 릴스 게시일 — 인스타와 다른 날일 수 있습니다">게시일</th>
                      <th className="perf-c" title="페이스북 릴스 조회수 일별 추이(같은 날 여러 번 수집해도 하루 1점)">추이</th>
                      <th className="perf-r" title="페이스북 페이지 릴스 조회 — 미게시면 '—'">조회</th>
                      <th className="perf-r" title="페이스북 릴스 좋아요. 🖼 는 커버(썸네일) 미적용 — 쇼츠 탭에서 '페북 커버 적용'">👍</th>
                      <th className="perf-c perf-grp-edge" title="직원 메모리·위키에 학습 반영(✓ 반영) / 측정창 진행 중(측정 중) / 비공개·삭제·기한 경과로 영구 정체(수집 불가)">반영</th>
                      <th className="perf-c"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {take("reels", reels).map((r) => (
                      <tr key={r.id}>
                        <td className="perf-title">
                          <div className="perf-title-row">
                            <span className="perf-title-txt" title={r.title}>{r.title}</span>
                          </div>
                        </td>
                        {/* 링크는 전용 열의 배지로 — 제목·숫자에 링크를 섞지 않는다(어느 채널로 가는지 모호했다). */}
                        <td className="perf-c">
                          <span className="perf-links">
                            {linkBadge("instagram", r.meta?.permalink, "인스타그램 릴스 열기", "인스타그램 미게시")}
                            {linkBadge("facebook", r.fb?.url, "페이스북 릴스 열기", "페이스북 페이지 미게시")}
                          </span>
                        </td>
                        <td className="perf-date perf-c perf-grp-edge">{fmtDate(r.meta?.ts)}</td>
                        <td className="perf-spark perf-c"><Sparkline data={r.meta?.series ?? []} title={`${r.title} 인스타 릴스 조회 추이`} /></td>
                        <td className="perf-r">{r.meta ? fmt(r.meta.views) : "—"}</td>
                        <td className="perf-r">{r.meta ? fmt(r.meta.likes) : "—"}</td>
                        <td className="perf-date perf-c perf-grp-edge">{fmtDate(r.fb?.ts)}</td>
                        <td className="perf-spark perf-c"><Sparkline data={r.fb?.series ?? []} title={`${r.title} 페이스북 릴스 조회 추이`} /></td>
                        <td className="perf-r">{r.fb ? fmt(r.fb.views) : "—"}</td>
                        <td className="perf-r">
                          {r.fb
                            ? <>{fmt(r.fb.likes)}{r.fb.coverPending && <span title="커버(썸네일) 미적용 — 쇼츠 탭의 '🖼 페북 커버 적용'으로 보강" style={{ marginLeft: 3 }}>🖼</span>}</>
                            : "—"}
                        </td>
                        <td className="perf-c perf-grp-edge">{r.meta ? reflBadge(r.meta.reflected, r.meta.stale) : "—"}</td>
                        <td className="perf-c"><button className="btn ghost" title="숏폼 삭제 — 산출물·성과 포함(유튜브·릴스 행 모두 사라짐)" onClick={() => doDeleteShorts(r.id, r.title)}><Ico name="trash" size={12} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {moreBtn("reels", reels.length)}
              </div>
            ) : (
              <p className="muted">인스타그램에 발행된 릴스가 아직 없습니다.</p>
            )}
          </div>

          <div className="review-section">
            <h3>카드뉴스 성과 <span className="muted">(매일 자동 수집)</span></h3>
            {cardnews.length > 0 ? (
              <div className="perf-table-wrap">
                <table className="perf-table">
                  <colgroup>
                    <col className="perf-col-title" /><col className="perf-col-link" />
                    <col className="perf-col-date perf-grp-start" /><col className="perf-col-spark" /><col className="perf-col-num" /><col className="perf-col-num" /><col className="perf-col-num" />
                    <col className="perf-col-date perf-grp-start" /><col className="perf-col-spark-w" /><col className="perf-col-num" /><col className="perf-col-num" />
                    <col className="perf-col-refl perf-grp-start" /><col className="perf-col-act" />
                  </colgroup>
                  <thead>
                    {/* 릴스 표와 동일 구조 — 두 표를 나란히 볼 때 열 의미가 흔들리지 않게 통일. */}
                    <tr className="perf-grouprow">
                      <th className="perf-grp-soft" colSpan={2}>콘텐츠</th>
                      <th colSpan={5}><span className="perf-grp-in"><PlatformMark name="instagram" size={13} /> 인스타그램</span></th>
                      <th className="perf-grp-edge" colSpan={4}><span className="perf-grp-in"><PlatformMark name="facebook" size={13} /> 페이스북</span></th>
                      <th className="perf-grp-soft perf-grp-edge" colSpan={2}>학습</th>
                    </tr>
                    <tr>
                      <th>카드뉴스</th>
                      <th className="perf-c">링크</th>
                      <th className="perf-c perf-grp-edge">게시일</th>
                      <th className="perf-c" title="인스타 조회수 일별 추이">추이</th>
                      <th className="perf-r">조회</th>
                      <th className="perf-r">도달</th>
                      <th className="perf-r">👍</th>
                      {/* 페이스북 사진 게시물은 조회·노출 지표를 주지 않는다(실측: post_impressions 계열 전부 무효) →
                          이 그룹의 추이는 좋아요 기준. 헤더에 '👍 추이'로 명시해 조회 추이로 오해되지 않게. */}
                      <th className="perf-c perf-grp-edge" title="페이스북 페이지 게시일 — 인스타와 다른 날일 수 있습니다">게시일</th>
                      <th className="perf-c" title="좋아요 일별 추이 — 페이스북 사진 게시물은 조회·노출 지표를 제공하지 않아(실측: post_impressions 계열 전부 무효) 좋아요를 추이로 씁니다">추이</th>
                      <th className="perf-r">👍</th>
                      <th className="perf-r">공유</th>
                      <th className="perf-c perf-grp-edge" title="직원 메모리·위키에 학습 반영(✓ 반영) / 측정창 진행 중(측정 중) / 비공개·삭제·기한 경과로 영구 정체(수집 불가)">반영</th>
                      <th className="perf-c"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {take("cardnews", cardnews).map((r) => (
                      <tr key={r.id}>
                        <td className="perf-title">
                          <div className="perf-title-row">
                            <span className="perf-title-txt" title={r.topic}>{r.topic}</span>
                          </div>
                        </td>
                        <td className="perf-c">
                          <span className="perf-links">
                            {linkBadge("instagram", r.ig?.permalink, "인스타그램 게시물 열기", "인스타그램 미게시")}
                            {linkBadge("facebook", r.fb?.url, "페이스북 페이지 게시물 열기", "페이스북 페이지 미게시")}
                          </span>
                        </td>
                        <td className="perf-date perf-c perf-grp-edge">{fmtDate(r.ig?.ts ?? r.ts)}</td>
                        <td className="perf-spark perf-c"><Sparkline data={r.ig?.series ?? []} title={`${r.topic} 인스타 조회 추이`} /></td>
                        <td className="perf-r">{r.ig ? fmt(r.ig.views) : "—"}</td>
                        <td className="perf-r">{r.ig ? fmt(r.ig.reach) : "—"}</td>
                        <td className="perf-r">{r.ig ? fmt(r.ig.likes) : "—"}</td>
                        <td className="perf-date perf-c perf-grp-edge">{fmtDate(r.fb?.ts)}</td>
                        <td className="perf-spark perf-c"><Sparkline data={r.fb?.series ?? []} title={`${r.topic} 페이스북 좋아요 추이`} /></td>
                        <td className="perf-r">{r.fb ? fmt(r.fb.likes) : "—"}</td>
                        <td className="perf-r">{r.fb ? fmt(r.fb.shares) : "—"}</td>
                        <td className="perf-c perf-grp-edge">{reflBadge(r.reflected, r.stale)}</td>
                        <td className="perf-c"><button className="btn ghost" title="카드뉴스 삭제 — 산출물·성과 포함" onClick={() => doDeleteCardnews(r.id, r.topic)}><Ico name="trash" size={12} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {moreBtn("cardnews", cardnews.length)}
              </div>
            ) : (
              <p className="muted">발행된 카드뉴스가 아직 없습니다.</p>
            )}
          </div>

          {/* 강화 학습 전략 */}
          <div className="review-section">
            <h3>강화 학습된 키워드 <span className="muted">(성과 신호 EWMA — 다음 기획이 우대)</span></h3>
            {winners.length === 0 ? (
              <p className="muted">아직 학습된 키워드가 없습니다. 발행 글의 성과가 쌓이면 여기에 나타납니다.</p>
            ) : (
              /* 자료가 늘어도 페이지가 무한히 길어지지 않게 높이 상한+내부 스크롤(사용자 요청 2026-07-30). */
              <div style={{ maxHeight: 150, overflowY: "auto" }}>
                <div className="piece-card-meta">
                  {winners.map((w) => (
                    <span key={w.keyword} className="chip" title={`샘플 ${w.samples}건`}>
                      {w.keyword} · {(w.score * 100).toFixed(0)}
                    </span>
                  ))}
                </div>
                {subNiches.length > 0 && (
                  <div className="piece-card-meta" style={{ marginTop: 8 }}>
                    {subNiches.map(([k, v]) => (
                      <span key={k} className="chip muted">{k} · {(v * 100).toFixed(0)}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 채널 학습 — 쇼츠·릴스·카드는 키워드 점수표가 아니라 직원 강화 '교훈 문장'으로 학습된다(위키 performance).
              블로그 EWMA 표와 나란히 노출해 "채널 학습이 안 보인다"는 오해를 없앤다(사용자 요청 2026-07-30). */}
          <div className="review-section">
            <h3>채널 학습 <span className="muted">(쇼츠·릴스·카드뉴스 — 담당 직원이 배운 것, 다음 기획 프롬프트에 주입)</span></h3>
            {channelLessons.length === 0 ? (
              <p className="muted">아직 채널 강화 교훈이 없습니다 — 발행 후 측정창(7일)이 지나면 쌓입니다.</p>
            ) : (
              /* 최신 30건까지 — 높이 상한+내부 스크롤로 페이지 길이 고정(사용자 요청 2026-07-30). */
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {channelLessons.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", fontSize: 13 }}>
                    <span className="chip" style={{ flexShrink: 0 }}>{l.channel}</span>
                    <span>{l.summary}</span>
                    <span className="muted" style={{ flexShrink: 0, fontSize: 11 }}>{(l.updated || "").slice(5, 10)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 제목·발행시각 A/B(후속 카드 2026-08-12) — 강화 학습 블록과 같은 '전략 인사이트' 묶음의 마지막. */}
          <TitleTimingSection />

        </>
      )}
    </div>
  );
}
