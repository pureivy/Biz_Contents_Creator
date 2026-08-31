/**
 * 성과 측정치 저장소 — piece 별 시계열(data/analytics/metrics/<pieceId>.jsonl, append-only).
 * 네이버는 게시물별 공개 API 가 없어, v1 주 경로는 **수동 입력**(사람이 네이버 통계에서 붙여넣기 → POST
 * /pieces/:id/metrics)이고, 브라우저 자동 수집은 스왑 가능한 수집기 뒤에 격리(별도 마일스톤).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

export interface SearchInflow { keyword: string; count: number; rank?: number; }
export interface MetricSample {
  measuredAt: string;
  views: number;
  dwellSec?: number;
  /** 좋아요·공감 — 유튜브 쇼츠(youtube:api)·메타 + 네이버 공감(2026-07-31, like API 동봉). 하위호환 optional. */
  likes?: number;
  comments?: number;
  /** 메타(인스타) 수집(meta:ig) 전용 — 도달·저장·공유(하위호환 optional). */
  reach?: number;
  saved?: number;
  shares?: number;
  searchInflow: SearchInflow[];
  /** 'manual' | 'scrape:<collector>' — 수집 출처(신뢰도 구분). */
  source?: string;
}

function metricsDir(): string { return path.join(CONFIG.dataDir, 'analytics', 'metrics'); }
function metricsFile(pieceId: string): string { return path.join(metricsDir(), `${pieceId}.jsonl`); }

/** 측정치 1건 append(append-only 시계열 — 증가는 의도된 것, 재강화는 stage 게이트로 별도 제어). */
export function appendMetrics(pieceId: string, sample: MetricSample): void {
  try {
    fs.mkdirSync(metricsDir(), { recursive: true });
    fs.appendFileSync(metricsFile(pieceId), JSON.stringify(sample) + '\n', 'utf-8');
  } catch { /* 영속 실패 무해 */ }
}
export function readMetrics(pieceId: string): MetricSample[] {
  try {
    return fs.readFileSync(metricsFile(pieceId), 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as MetricSample);
  } catch { return []; }
}
export function latestMetrics(pieceId: string): MetricSample | null {
  const all = readMetrics(pieceId);
  return all.length ? all[all.length - 1]! : null;
}
/** 채널별 최신 샘플(순수) — 한 시계열에 youtube:api·meta:ig·meta:fb 가 섞이므로 소스 접두로 갈라 고른다. */
export function latestSampleBySource(samples: MetricSample[], prefix: string): MetricSample | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    if ((samples[i]!.source ?? '').startsWith(prefix)) return samples[i]!;
  }
  return null;
}
export function latestMetricsBySource(pieceId: string, prefix: string): MetricSample | null {
  return latestSampleBySource(readMetrics(pieceId), prefix);
}
/**
 * 채널 조회수 추이(순수, 스파크라인용) — 소스 접두로 거른 샘플을 '하루 1점(그날 마지막 값)'으로 압축.
 * 하루 여러 번 수집돼도 스파크라인이 톱니치지 않게 일 단위 정규화, 최근 maxPoints 일만 반환.
 */
/**
 * 지표별 일별 시계열(순수) — views 외 지표도 추이로 그릴 수 있게 필드를 인자로 받는다.
 * 페이스북 게시물(카드뉴스)은 조회 지표를 주지 않아(반응만) views 추이가 항상 0이 된다 →
 * 그 경우 좋아요 추이를 쓴다. 같은 날 여러 표본은 마지막(최신) 값이 덮어쓴다.
 */
export function metricSeriesBySource(
  samples: MetricSample[], prefix: string, field: 'views' | 'likes' | 'comments' | 'shares', maxPoints = 14,
): number[] {
  const byDay = new Map<string, number>();
  for (const m of [...samples].filter((x) => (x.source ?? '').startsWith(prefix))
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt))) {
    byDay.set(m.measuredAt.slice(0, 10), num(m[field]));
  }
  const series = [...byDay.values()];
  return series.length > maxPoints ? series.slice(-maxPoints) : series;
}
/** 지표 시계열 — piece id 로 읽어서. viewsSeriesFor 의 일반화판. */
export function metricSeriesFor(
  pieceId: string, prefix: string, field: 'views' | 'likes' | 'comments' | 'shares', maxPoints = 14,
): number[] {
  return metricSeriesBySource(readMetrics(pieceId), prefix, field, maxPoints);
}

export function viewsSeriesBySource(samples: MetricSample[], prefix: string, maxPoints = 14): number[] {
  const byDay = new Map<string, number>();
  for (const m of [...samples].filter((x) => (x.source ?? '').startsWith(prefix))
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt))) {
    byDay.set(m.measuredAt.slice(0, 10), num(m.views)); // 같은 날은 마지막(최신) 값이 덮어씀
  }
  const series = [...byDay.values()];
  return series.length > maxPoints ? series.slice(-maxPoints) : series;
}
export function viewsSeriesFor(pieceId: string, prefix: string, maxPoints = 14): number[] {
  return viewsSeriesBySource(readMetrics(pieceId), prefix, maxPoints);
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normInflow(v: unknown): SearchInflow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const keyword = String(o.keyword ?? '').trim();
  if (!keyword) return null;
  const rank = o.rank != null ? num(o.rank) : undefined;
  return { keyword, count: num(o.count), ...(rank ? { rank } : {}) };
}

/**
 * 수동 입력 정규화(v1 주 경로) — {views, dwellSec?, searchInflow:[{keyword,count,rank?}]} JSON 을 안전 파싱.
 * 프론트(6f)는 네이버 통계 붙여넣기(CSV 등)를 이 형태로 변환해 전송한다.
 */
export function parseManualMetrics(input: unknown): MetricSample {
  const o = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {};
  const inflow = Array.isArray(o.searchInflow)
    ? (o.searchInflow as unknown[]).map(normInflow).filter((x): x is SearchInflow => x !== null)
    : [];
  return {
    measuredAt: new Date().toISOString(),
    views: num(o.views),
    ...(o.dwellSec != null ? { dwellSec: num(o.dwellSec) } : {}),
    searchInflow: inflow,
    source: 'manual',
  };
}

/**
 * 일일 연속 추적 도래 판정(순수) — 발행 직후부터 측정창(windowDays) 안의 글을 하루 1회 수집한다
 * (사용자 요청 2026-07-30: 수집은 매일, 강화는 14일 후 그대로). KST 날짜 기준 멱등 —
 * 같은 날 재호출(새로고침 버튼·크론 중복)은 false. 발행 URL 없는 글·창 경과 글은 false.
 */
export function naverTrackingDue(p: {
  stage: string; publishedUrl?: string; publishedTs?: string; updatedTs: string;
}, lastMeasuredAt: string | null, windowDays: number, now: Date = new Date()): boolean {
  if (!p.publishedUrl) return false;
  if (!['published', 'measured', 'reflected'].includes(p.stage)) return false;
  const published = new Date(p.publishedTs ?? p.updatedTs).getTime();
  if (!Number.isFinite(published)) return false;
  const age = now.getTime() - published;
  if (age < 0 || age >= windowDays * 24 * 3600 * 1000) return false;
  if (!lastMeasuredAt) return true;
  const kstDay = (d: Date): string => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return kstDay(new Date(lastMeasuredAt)) !== kstDay(now);
}

/** KST 같은 날 판정(순수) — 측정·시도의 '하루 1회' 게이트 공용. null·파싱 불가는 false. */
export function sameKstDay(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const kstDay = (x: Date): string => x.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return kstDay(d) === kstDay(now);
}

/** 마지막 '접촉'(측정 또는 시도) 시각(순수) — ISO 들 중 최신. 표본을 못 얻은 시도도 하루 1회 게이트에
 *  포함시키기 위한 조합 헬퍼(2026-07-30 실측: D+0 집계 지연으로 표본이 없으면 measuredAt 이 계속 null
 *  → 대시보드 새로고침마다 headful 크롬 재기동). null·파싱 불가 입력은 무시. */
export function latestTouch(...isos: Array<string | null | undefined>): string | null {
  const xs = isos.filter((s): s is string => !!s && !Number.isNaN(new Date(s).getTime()));
  if (!xs.length) return null;
  return xs.sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).pop()!;
}

/**
 * 표본 전체의 유입 키워드 상위 집계(순수) — 최신 표본만 읽으면 유입이 빈 새 표본이 과거 유입을
 * 가린다(실측 2026-07-30: 일일 추적 표본이 "습도 낮추는법" 유입을 '—' 로 덮음). 어드바이저 유입
 * 수치는 누적일 수 있어 합산 대신 키워드별 최대값으로 병합(일일 표본 합산은 이중 계상 위험).
 */
export function topInflow(samples: MetricSample[], limit = 5): SearchInflow[] {
  const best = new Map<string, number>();
  for (const s of samples) {
    for (const k of s.searchInflow ?? []) {
      const key = (k.keyword ?? '').trim();
      if (!key) continue;
      const c = Number(k.count) || 0;
      if (c >= (best.get(key) ?? -1)) best.set(key, c);
    }
  }
  return [...best.entries()].map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count).slice(0, limit);
}

/** 최근 표본부터 첫 유효 체류값(순수) — 최신 표본에 체류가 없어도 직전 측정값을 가리지 않게. */
export function latestDwell(samples: MetricSample[]): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const d = samples[i]?.dwellSec;
    if (typeof d === 'number' && d > 0) return d;
  }
  return null;
}

/** 최근 유효 공감·좋아요 — dwell 과 달리 0 도 실값(공감 없음), 미기록(undefined)만 건너뛴다.
 *  공감 조회가 일시 실패한 새 표본이 과거 값을 가리지 않게 역방향 탐색(2026-07-31). */
export function latestLikes(samples: MetricSample[]): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const d = samples[i]?.likes;
    if (typeof d === 'number') return d;
  }
  return null;
}
