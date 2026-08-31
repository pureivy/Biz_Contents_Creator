/**
 * 네이버 데이터랩(검색어트렌드) 커넥터 — NAVER_CLIENT_ID + NAVER_CLIENT_SECRET(검색 API 와 동일 키).
 * 용도: 키워드의 상대적 검색 트렌드(0~100 비율, 시간축) — 절대량이 아닌 '방향(상승/하락)'.
 * (절대 검색량은 naver_searchad 로. 데이터랩은 트렌드 방향 보조.)  POST /v1/datalab/search.
 */
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { registerConnector } from './registry';
import { seedKeyword, GROUND_CAP } from './naver_common';

const CID = 'NAVER_CLIENT_ID';
const CSEC = 'NAVER_CLIENT_SECRET';
export function datalabEnabled(): boolean { return !!getSecret(CID) && !!getSecret(CSEC); }

export interface TrendPoint { period: string; ratio: number }
export interface KeywordTrend { keyword: string; points: TrendPoint[]; direction: '상승' | '하락' | '보합' }

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

/** 최근 N개월 월간 검색어트렌드(상대 0~100). discover·ground() 공용. 실패 시 []. */
export async function datalabTrend(keywords: string[], months = 6, signal?: AbortSignal): Promise<KeywordTrend[]> {
  if (!datalabEnabled()) return [];
  const kws = keywords.map((k) => k.trim()).filter(Boolean).slice(0, 5);
  if (!kws.length) return [];
  const end = new Date();
  const start = new Date(); start.setMonth(start.getMonth() - months);
  const body = {
    startDate: ymd(start), endDate: ymd(end), timeUnit: 'month',
    keywordGroups: kws.map((k) => ({ groupName: k, keywords: [k] })),
  };
  const r = await fetchTimeout('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST',
    headers: { 'X-Naver-Client-Id': getSecret(CID)!, 'X-Naver-Client-Secret': getSecret(CSEC)!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, signal);
  if (!r.ok) return [];
  const j = await r.json() as { results?: Array<{ title?: string; data?: Array<{ period?: string; ratio?: number }> }> };
  return (j.results ?? []).map((res) => {
    const points = (res.data ?? []).map((d) => ({ period: d.period ?? '', ratio: typeof d.ratio === 'number' ? d.ratio : 0 }));
    const first = points[0]?.ratio ?? 0;
    const last = points[points.length - 1]?.ratio ?? 0;
    const direction: KeywordTrend['direction'] = last > first * 1.1 ? '상승' : last < first * 0.9 ? '하락' : '보합';
    return { keyword: (res.title ?? '').trim(), points, direction };
  });
}

/**
 * 트렌드 조회 창(2026-08-28) — 13개월 이상이어야 '작년 같은 달'이 창 안에 들어온다.
 *
 * 종전 6개월은 계절 소재에서 잘못된 결론을 만들었다(실사고, 계수나무): 26-02~08 만 보면 4월 정점
 * 뒤 8월은 저점이라 리서치팀이 "지금은 비수기, 봄을 노리는 자산형"으로 브리프를 썼다. 실제 14개월을
 * 보면 작년 8월 61 → 9월 76 → 10월 94 로 **가을에 2차 정점**이 있고, 수요 게이트는 13개월을 조회해
 * 이미 그걸 반영(seasonIdx 0.76)해 채택한 것이었다. 게이트와 브리프가 서로 다른 데이터를 보고
 * 정반대 결론을 낸 셈이다 — 창을 게이트(topicDemand 의 13)와 맞춘다.
 */
const TREND_MONTHS = 13;

/**
 * 작년 같은 달 비교 한 줄(순수 — 테스트 대상). 스파크라인만 주면 LLM 이 맨 뒤 몇 점만 읽고
 * "지금은 저점"이라 결론짓는다(실사고: 계수나무 브리프). 계절 소재에서 정작 필요한 비교는
 * '작년 이맘때 대비 지금'과 '작년 다음 달'이다 — 수요 게이트의 seasonIdx 가 쓰는 것과 같은 두 점이라,
 * 이 줄이 있어야 브리프와 게이트가 같은 근거 위에서 판단한다.
 * 13점 미만(창을 다 못 받은 신생 키워드)이면 빈 문자열 — 없는 비교를 지어내지 않는다.
 */
export function seasonalHint(points: ReadonlyArray<TrendPoint>): string {
  if (points.length < 13) return '';
  const cur = points[points.length - 1]!.ratio;
  const lastYear = points[points.length - 13]!.ratio;       // 작년 같은 달
  const lastYearNext = points[points.length - 12]!.ratio;   // 작년 그 다음 달
  return `\n작년 이맘때 ${Math.round(lastYear)} → 작년 다음 달 ${Math.round(lastYearNext)}`
    + ` (지금 ${Math.round(cur)}) — 다음 달 방향은 이 두 값으로 판단하라.`;
}

async function ground(query: string, signal?: AbortSignal): Promise<string> {
  if (!datalabEnabled()) return '';
  const kw = seedKeyword(query);
  try {
    // 니치 복합 키워드는 데이터랩에 데이터가 없어 0포인트가 흔하다("장마철 제습" 등) —
    // 점진 축약(전체→2어절→1어절) 재시도로 트렌드 방향이라도 확보한다.
    const words = kw.split(/\s+/).filter(Boolean);
    const candidates = [...new Set([kw, words.slice(0, 2).join(' '), words[0] ?? ''])].filter(Boolean);
    let trends: KeywordTrend[] = [];
    for (const cand of candidates) {
      trends = await datalabTrend([cand], TREND_MONTHS, signal);
      if (trends.length && trends[0]!.points.length) break;
    }
    if (!trends.length || !trends[0]!.points.length) return '';
    const t = trends[0]!;
    const spark = t.points.map((p) => `${p.period.slice(2, 7)}:${Math.round(p.ratio)}`).join(' ');
    return `검색어트렌드 "${t.keyword}" — 최근 ${TREND_MONTHS}개월 방향: ${t.direction} (상대지수 0~100)\n${spark}${seasonalHint(t.points)}`.slice(0, GROUND_CAP);
  } catch { return ''; }
}

registerConnector({
  id: 'naver_datalab',
  // 데이터랩은 검색 API 와 같은 키 쌍(Client ID/Secret)을 쓴다 — 카드는 naver_search 가 두 장을
  // 선언하고, 여기 keyDef 는 동일 키라 connectorKeyDefs 의 중복 제거(첫 선언 우선)로 하나로 합쳐진다.
  keyDef: {
    key: CSEC,
    label: '네이버 API — Client Secret',
    icon: '🟩',
    desc: '네이버 개발자센터 애플리케이션 Secret — 검색(SERP)·데이터랩 공용',
    placeholder: '네이버 개발자 Client Secret',
  },
  blockLabel: '[검색어트렌드(데이터랩)]',
  scope: ['naver_datalab'], // 트렌드 리서처 역할에만 주입
  enabled: datalabEnabled,
  ground,
});
