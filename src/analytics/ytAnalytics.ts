/**
 * 유튜브 애널리틱스 수집 — 시청 지속률(평균 시청 비율·시간)과 유입 경로(Shorts 피드/검색/구독 등).
 *
 * 왜 필요한가: Data API 의 statistics.viewCount 만으로는 "노출이 끊긴 것"과 "노출은 됐는데 초반에
 * 이탈한 것"을 구분할 수 없다(2026-09-02 신작 조회 붕괴 진단에서 드러난 계측 공백 — 4편 연속 0~5회인데
 * 원인을 데이터로 못 갈랐다). insightTrafficSourceType 별 조회수를 같이 쌓으면 다음부터는 한 번에 갈린다.
 *
 * 인증: 채널 OAuth 토큰(yt-analytics.readonly, 2026-09-03 스코프 추가). 재연결 전 토큰에는 이 스코프가
 * 없어 403 이 나므로 전량 fail-open — 실패는 해당 영상만 스킵하고 조회수 수집(youtube:api)은 그대로 간다.
 *
 * 처리 지연: 애널리틱스는 당일·전일 데이터가 아직 없다(실측 2026-09-03 기준 08-31 까지만 조회됨).
 * 따라서 이 수집은 "지금 값"이 아니라 "지금까지 확정된 값"이며, 신작은 며칠 뒤에야 채워진다.
 */
import { fetchTimeout } from '../util/fetch';
import { youtubeAccessToken } from '../tools/youtubeUpload';

const REPORTS = 'https://youtubeanalytics.googleapis.com/v2/reports';

/** 애널리틱스 처리 지연(일) — 실측 2026-09-03 조회 시 08-31 까지만 채워져 있었다(2일). */
export const ANALYTICS_LAG_DAYS = 2;

export interface YtRetention {
  views: number;
  /** 총 시청 시간(분). */
  watchMinutes: number;
  /** 평균 시청 시간(초). */
  avgViewSec: number;
  /** 평균 시청 비율(%) — 반복 재생이 있으면 100 을 넘는다(실측 08-30 185.8%). */
  avgViewPct: number;
}
/** 유입 경로별 조회수 — 키는 insightTrafficSourceType(SHORTS·YT_SEARCH·SUBSCRIBER…). */
export type YtTraffic = Record<string, number>;

/** columnHeaders 로 열 이름→인덱스(순수) — 응답 열 순서를 가정하지 않는다. */
export function columnIndex(json: unknown): Record<string, number> {
  const cols = (json as { columnHeaders?: unknown[] } | null)?.columnHeaders;
  const out: Record<string, number> = {};
  if (!Array.isArray(cols)) return out;
  cols.forEach((c, i) => {
    const name = (c as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name) out[name] = i;
  });
  return out;
}

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** reports 응답(차원 없음) → 지표 1행(순수). 행이 없으면 null(= 아직 처리 전이거나 조회 0). */
export function parseRetentionReport(json: unknown): YtRetention | null {
  const rows = (json as { rows?: unknown[] } | null)?.rows;
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) return null;
  const idx = columnIndex(json);
  const r = rows[0] as unknown[];
  const at = (k: string): number => (idx[k] === undefined ? 0 : num(r[idx[k]]));
  return {
    views: at('views'),
    watchMinutes: at('estimatedMinutesWatched'),
    avgViewSec: at('averageViewDuration'),
    avgViewPct: at('averageViewPercentage'),
  };
}

/** reports 응답(insightTrafficSourceType 차원) → 경로별 조회수(순수). 같은 키 중복은 합산. */
export function parseTrafficReport(json: unknown): YtTraffic {
  const rows = (json as { rows?: unknown[] } | null)?.rows;
  const out: YtTraffic = {};
  if (!Array.isArray(rows)) return out;
  const idx = columnIndex(json);
  const srcAt = idx['insightTrafficSourceType'] ?? 0;
  const viewAt = idx['views'] ?? 1;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const src = row[srcAt];
    if (typeof src !== 'string' || !src) continue;
    out[src] = (out[src] ?? 0) + num(row[viewAt]);
  }
  return out;
}

/** 유입 경로 합계 중 Shorts 피드 비중(0~1, 순수). 합이 0이면 null(판단 불가 — 0% 와 구분). */
export function shortsFeedShare(traffic: YtTraffic): number | null {
  const total = Object.values(traffic).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return (traffic['SHORTS'] ?? 0) / total;
}

/**
 * 기록할 가치가 있는 측정인가(순수) — 조회 0 + 유입 경로 0건은 '처리 전'과 구별되지 않는다.
 * 업로드 당일이 처리 경계에 걸리면 0 행이 돌아오는데(실측 측백나무 09-02), 그걸 그대로 쌓으면
 * 시청비율 0% 가 시계열에 남아 평균을 끌어내린다. 조회수 자체는 youtube:api 줄이 이미 담고 있다.
 */
export function hasMeasurement(retention: YtRetention | null, traffic: YtTraffic): boolean {
  if (!retention) return false;
  return retention.views > 0 || Object.keys(traffic).length > 0;
}

/** YYYY-MM-DD(UTC) — 애널리틱스 startDate/endDate 형식(순수). */
export function ymd(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

/**
 * 인증 문제인가(순수) — 401·403 은 토큰·스코프 문제라 다음 영상도 똑같이 실패한다(수집 조기 종료 대상).
 * 그 외(5xx·쿼터·일시 오류)는 해당 영상만 건너뛰고 계속한다. 실측 2026-09-03: 같은 질의가 500 을 냈다가
 * 재시도에서 바로 200 을 준 사례가 있어, 5xx 로 전체 수집을 접으면 그날 데이터를 통째로 잃는다.
 */
export function isAuthError(message: string): boolean {
  return /^(401|403)\b/.test(message.trim());
}

async function query(token: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const u = new URL(REPORTS);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let last = '';
  for (let attempt = 0; attempt < 2; attempt += 1) { // 5xx 는 1회 재시도(구글측 일시 오류 실측)
    const r = await fetchTimeout(u.toString(), { headers: { Authorization: `Bearer ${token}` } }, signal);
    const j = await r.json() as { error?: { code?: number; message?: string } };
    if (r.ok && !j.error) return j;
    const code = j.error?.code ?? r.status;
    last = `${code}: ${(j.error?.message ?? `HTTP ${r.status}`).slice(0, 160)}`;
    if (code < 500 || attempt === 1) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(last);
}

/**
 * reports 응답(insightTrafficSourceDetail 차원) → 검색어별 조회수(순수).
 *
 * 이 채널에서 검색은 유일하게 죽지 않은 유입이다(2026-09-04 분석). 피드가 끊긴 뒤에도 하루
 * 200~340회로 유지됐고, 7월 30회에서 두 달 만에 그만큼 자랐다. 그런데 '무엇으로 들어왔는지'를
 * 한 번도 안 쌓아 왔다 — searchInflow 필드는 네이버 블로그만 채우고 유튜브는 빈 배열이었다.
 * 그래서 "하스카프베리묘목 551회" 같은 값을 임시 스크립트로만 볼 수 있었다.
 */
export function parseSearchTerms(json: unknown): Array<{ keyword: string; count: number }> {
  const j = json as { rows?: unknown[][] } | null;
  const out: Array<{ keyword: string; count: number }> = [];
  for (const row of j?.rows ?? []) {
    const keyword = String(row?.[0] ?? '').trim();
    const count = Number(row?.[1]);
    if (!keyword || !Number.isFinite(count) || count <= 0) continue;
    out.push({ keyword, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** 영상 1편의 시청 지속률 + 유입 경로 + 검색어. 토큰·스코프 없으면 throw(호출측 fail-open). */
export async function fetchVideoAnalytics(
  slug: string, videoId: string, startDate: string, endDate: string, signal?: AbortSignal,
): Promise<{ retention: YtRetention | null; traffic: YtTraffic; searchTerms: Array<{ keyword: string; count: number }> }> {
  const token = await youtubeAccessToken(slug, signal);
  const base = { ids: 'channel==MINE', startDate, endDate, filters: `video==${videoId}` };
  const rj = await query(token, { ...base, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage' }, signal);
  const tj = await query(token, { ...base, metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views' }, signal);
  // 검색어는 실패해도 나머지를 버리지 않는다 — 지원 안 되는 조합·일시 오류로 지속률까지 잃으면 손해다.
  let searchTerms: Array<{ keyword: string; count: number }> = [];
  try {
    const sj = await query(token, {
      ...base, filters: `video==${videoId};insightTrafficSourceType==YT_SEARCH`,
      metrics: 'views', dimensions: 'insightTrafficSourceDetail', sort: '-views', maxResults: '10',
    }, signal);
    searchTerms = parseSearchTerms(sj);
  } catch { /* 무해 — 검색어 없이 진행 */ }
  return { retention: parseRetentionReport(rj), traffic: parseTrafficReport(tj), searchTerms };
}
