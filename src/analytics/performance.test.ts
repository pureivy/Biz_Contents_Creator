import { describe, it, expect } from 'vitest';
import { parseManualMetrics, latestSampleBySource, viewsSeriesBySource, naverTrackingDue, topInflow, latestDwell, latestLikes, sameKstDay, latestTouch, type MetricSample } from './performance';
import { performanceSignal } from './reinforce';

// 스파크라인용 시계열(2026-07-20) — 소스 접두로 거른 샘플을 '하루 1점(그날 마지막 값)'으로 압축해
// 조회수 추이를 반환한다. 하루 여러 번 수집돼도 스파크라인이 노이즈로 톱니치지 않게 일 단위로 정규화.
describe('viewsSeriesBySource (채널 조회수 추이)', () => {
  const s = (day: string, hh: string, views: number, source = 'youtube:api'): MetricSample =>
    ({ measuredAt: `2026-07-${day}T${hh}:00:00Z`, views, searchInflow: [], source });
  it('소스 접두 필터 + 하루 1점(그날 마지막) + 조회수 배열', () => {
    const rows = [s('14', '01', 4), s('15', '03', 855), s('15', '22', 900), s('16', '10', 1124), s('16', '02', 999, 'meta:ig')];
    expect(viewsSeriesBySource(rows, 'youtube:')).toEqual([4, 900, 1124]); // 15일은 마지막(900), meta 제외
    expect(viewsSeriesBySource(rows, 'meta:ig')).toEqual([999]);
  });
  it('빈/무일치/레거시(source 없음) → 빈 배열, 최근 maxPoints 개로 제한', () => {
    expect(viewsSeriesBySource([], 'youtube:')).toEqual([]);
    expect(viewsSeriesBySource([s('14', '01', 4)], 'naver:')).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => s(String(10 + i).padStart(2, '0'), '00', i * 10));
    expect(viewsSeriesBySource(many, 'youtube:', 5)).toEqual([150, 160, 170, 180, 190]); // 최근 5일
  });
});

// 한 콘텐츠 id 의 시계열엔 유튜브(youtube:api)·인스타(meta:ig)·페북(meta:fb) 샘플이 섞인다 —
// 채널별 최신치는 소스 접두로 갈라 뒤에서부터(최신) 골라야 한다(latestMetrics 는 소스 무시).
describe('latestSampleBySource (채널별 최신 샘플)', () => {
  const s = (source: string, views: number): MetricSample =>
    ({ measuredAt: `2026-07-${String(10 + views).padStart(2, '0')}T00:00:00Z`, views, searchInflow: [], source });
  const mixed = [s('youtube:api', 1), s('meta:ig', 2), s('youtube:api', 3), s('meta:fb', 4), s('meta:ig', 5)];

  it('접두 일치하는 마지막(최신) 샘플 — 유튜브·IG·FB 각각', () => {
    expect(latestSampleBySource(mixed, 'youtube:')?.views).toBe(3);
    expect(latestSampleBySource(mixed, 'meta:ig')?.views).toBe(5);
    expect(latestSampleBySource(mixed, 'meta:fb')?.views).toBe(4);
  });
  it('일치 없음·빈 시계열·source 없는 레거시 샘플 → null 안전', () => {
    expect(latestSampleBySource(mixed, 'naver:')).toBeNull();
    expect(latestSampleBySource([], 'youtube:')).toBeNull();
    const legacy = [{ measuredAt: '2026-07-10T00:00:00Z', views: 9, searchInflow: [] }] as MetricSample[];
    expect(latestSampleBySource(legacy, 'youtube:')).toBeNull();
  });
});

describe('parseManualMetrics (수동 성과 입력 정규화)', () => {
  it('구조화 JSON 을 안전 파싱(유입 키워드 포함)', () => {
    const m = parseManualMetrics({ views: 1200, dwellSec: 95, searchInflow: [{ keyword: '홈카페 원두', count: 340, rank: 3 }, { keyword: '원두 보관', count: 120 }] });
    expect(m.views).toBe(1200);
    expect(m.dwellSec).toBe(95);
    expect(m.searchInflow).toHaveLength(2);
    expect(m.searchInflow[0]).toEqual({ keyword: '홈카페 원두', count: 340, rank: 3 });
    expect(m.searchInflow[1]).toEqual({ keyword: '원두 보관', count: 120 }); // rank 없으면 생략
    expect(m.source).toBe('manual');
  });

  it('잘못된/누락 필드는 0·빈배열로 방어(빈 keyword 유입은 버림)', () => {
    const m = parseManualMetrics({ views: 'x', searchInflow: [{ keyword: '', count: 5 }, { count: 9 }, 'junk'] });
    expect(m.views).toBe(0);
    expect(m.dwellSec).toBeUndefined();
    expect(m.searchInflow).toEqual([]);
  });

  it('객체가 아니면 전부 기본값', () => {
    const m = parseManualMetrics(null);
    expect(m.views).toBe(0);
    expect(m.searchInflow).toEqual([]);
  });
});

describe('performanceSignal (성과 → 스칼라, 0~1)', () => {
  it('조회수가 많을수록 단조 증가, [0,1] 경계', () => {
    const s0 = performanceSignal({ measuredAt: '', views: 0, searchInflow: [] });
    const s1 = performanceSignal({ measuredAt: '', views: 100, searchInflow: [] });
    const s2 = performanceSignal({ measuredAt: '', views: 5000, searchInflow: [] });
    expect(s0).toBeGreaterThanOrEqual(0);
    expect(s0).toBeLessThan(s1);
    expect(s1).toBeLessThan(s2);
    expect(s2).toBeLessThanOrEqual(1);
  });

  it('유입 키워드 다양성이 신호를 높인다(같은 조회수)', () => {
    const few = performanceSignal({ measuredAt: '', views: 500, searchInflow: [{ keyword: 'a', count: 1 }] });
    const many = performanceSignal({ measuredAt: '', views: 500, searchInflow: Array.from({ length: 10 }, (_, i) => ({ keyword: `k${i}`, count: 1 })) });
    expect(many).toBeGreaterThan(few);
  });
});

describe('naverTrackingDue — 일일 연속 추적 게이트(수집은 매일, 강화는 14일 후)', () => {
  const base = { stage: 'published', publishedUrl: 'https://blog.naver.com/x/1', publishedTs: '2026-07-20T09:00:00+09:00', updatedTs: '2026-07-20T09:00:00+09:00' };
  const now = new Date('2026-07-30T07:30:00+09:00');
  it('발행 직후~측정창 안 + 오늘 미수집이면 true(measured/reflected 포함)', () => {
    expect(naverTrackingDue(base, null, 14, now)).toBe(true);
    expect(naverTrackingDue({ ...base, stage: 'reflected' }, '2026-07-29T07:30:00+09:00', 14, now)).toBe(true);
  });
  it('같은 KST 날짜에 이미 수집했으면 false(멱등 — 새로고침·크론 중복 방지)', () => {
    expect(naverTrackingDue(base, '2026-07-30T01:00:00+09:00', 14, now)).toBe(false);
  });
  it('측정창 경과·발행 URL 없음·미발행 스테이지는 false', () => {
    expect(naverTrackingDue({ ...base, publishedTs: '2026-07-01T09:00:00+09:00' }, null, 14, now)).toBe(false);
    expect(naverTrackingDue({ ...base, publishedUrl: undefined }, null, 14, now)).toBe(false);
    expect(naverTrackingDue({ ...base, stage: 'ready' }, null, 14, now)).toBe(false);
  });
});

describe('sameKstDay · latestTouch — 시도 포함 하루 1회 게이트 헬퍼(순수)', () => {
  const now = new Date('2026-07-30T14:30:00+09:00');
  it('sameKstDay — KST 자정 경계·널·불량 입력', () => {
    expect(sameKstDay('2026-07-30T00:10:00+09:00', now)).toBe(true);
    expect(sameKstDay('2026-07-29T23:50:00+09:00', now)).toBe(false);
    expect(sameKstDay(null, now)).toBe(false);
    expect(sameKstDay('bogus', now)).toBe(false);
  });
  it('latestTouch — 최신 ISO 선택, 널·불량 무시', () => {
    expect(latestTouch(null, undefined)).toBeNull();
    expect(latestTouch('2026-07-30T01:00:00Z', '2026-07-30T02:00:00Z')).toBe('2026-07-30T02:00:00Z');
    expect(latestTouch('bogus', '2026-07-30T02:00:00Z')).toBe('2026-07-30T02:00:00Z');
  });
  it('표본을 못 얻어도(측정 null) 오늘 시도가 있으면 게이트가 닫힌다 — 새로고침마다 headful 크롬 재기동 방지(2026-07-30 실측)', () => {
    const base = { stage: 'published', publishedUrl: 'https://blog.naver.com/x/1', publishedTs: '2026-07-30T13:39:00+09:00', updatedTs: '2026-07-30T13:39:00+09:00' };
    expect(naverTrackingDue(base, latestTouch(null, '2026-07-30T14:12:00+09:00'), 14, now)).toBe(false); // 오늘 시도 → 닫힘
    expect(naverTrackingDue(base, latestTouch(null, '2026-07-29T14:12:00+09:00'), 14, now)).toBe(true);  // 어제 시도 → 오늘 도래
  });
});

describe('topInflow / latestDwell — 최신 빈 표본이 과거 값을 가리지 않게', () => {
  const s = (over: Partial<MetricSample>): MetricSample => ({ measuredAt: '2026-07-30T00:00:00Z', views: 1, searchInflow: [], ...over });
  it('유입: 전 이력에서 키워드별 최대값 병합·상위 정렬(합산 이중계상 방지)', () => {
    const samples = [
      s({ searchInflow: [{ keyword: '습도 낮추는법', count: 1 }] }),
      s({ searchInflow: [] }),                                          // 일일 추적 빈 표본 — 가리면 안 됨
      s({ searchInflow: [{ keyword: '습도 낮추는법', count: 3 }, { keyword: '장마 곰팡이', count: 2 }] }),
    ];
    expect(topInflow(samples)).toEqual([{ keyword: '습도 낮추는법', count: 3 }, { keyword: '장마 곰팡이', count: 2 }]);
  });
  it('체류: 최근 표본부터 첫 유효값(빈 최신 표본 스킵), 전부 없으면 null', () => {
    expect(latestDwell([s({ dwellSec: 45 }), s({})])).toBe(45);
    expect(latestDwell([s({ dwellSec: 45 }), s({ dwellSec: 60 }), s({})])).toBe(60);
    expect(latestDwell([s({}), s({})])).toBeNull();
  });
  it('공감: dwell 과 달리 0 도 실값 — 미기록(undefined)만 스킵, 전부 미기록이면 null', () => {
    expect(latestLikes([s({ likes: 5 }), s({})])).toBe(5);       // 공감 조회 실패 표본이 과거 값 안 가림
    expect(latestLikes([s({ likes: 5 }), s({ likes: 0 })])).toBe(0); // 0 은 유효(공감 없음)
    expect(latestLikes([s({}), s({})])).toBeNull();
  });
});
