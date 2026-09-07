import { describe, it, expect } from 'vitest';
import { columnIndex, parseRetentionReport, parseTrafficReport, shortsFeedShare, ymd, isAuthError, hasMeasurement, ANALYTICS_LAG_DAYS, parseSearchTerms } from './ytAnalytics';

const retentionJson = {
  columnHeaders: [
    { name: 'views' }, { name: 'estimatedMinutesWatched' },
    { name: 'averageViewDuration' }, { name: 'averageViewPercentage' },
  ],
  rows: [[1138, 640, 34, 88.02]],
};

describe('parseRetentionReport — 열 이름 기준 해석(순수)', () => {
  it('columnHeaders 순서를 따라 값을 매핑한다', () => {
    expect(parseRetentionReport(retentionJson)).toEqual({
      views: 1138, watchMinutes: 640, avgViewSec: 34, avgViewPct: 88.02,
    });
  });
  it('열 순서가 바뀌어도 이름으로 찾는다 — 위치 가정 금지', () => {
    const swapped = {
      columnHeaders: [{ name: 'averageViewPercentage' }, { name: 'views' },
        { name: 'averageViewDuration' }, { name: 'estimatedMinutesWatched' }],
      rows: [[75.1, 900, 28, 420]],
    };
    expect(parseRetentionReport(swapped)).toEqual({ views: 900, watchMinutes: 420, avgViewSec: 28, avgViewPct: 75.1 });
  });
  it('행이 없으면 null — 처리 전(지연)과 조회 0 을 0 으로 뭉개지 않는다', () => {
    expect(parseRetentionReport({ columnHeaders: retentionJson.columnHeaders, rows: [] })).toBeNull();
    expect(parseRetentionReport({})).toBeNull();
    expect(parseRetentionReport(null)).toBeNull();
  });
  it('결측·이형 값은 0 으로 방어한다', () => {
    const broken = { columnHeaders: retentionJson.columnHeaders, rows: [[null, 'x', undefined, 50]] };
    expect(parseRetentionReport(broken)).toEqual({ views: 0, watchMinutes: 0, avgViewSec: 0, avgViewPct: 50 });
  });
  it('반복 재생으로 100%를 넘는 값도 그대로 보존한다(실측 185.8%)', () => {
    const loop = { columnHeaders: retentionJson.columnHeaders, rows: [[1122, 1270, 68, 185.8]] };
    expect(parseRetentionReport(loop)?.avgViewPct).toBe(185.8);
  });
});

describe('parseTrafficReport — 유입 경로별 조회수(순수)', () => {
  const json = {
    columnHeaders: [{ name: 'insightTrafficSourceType' }, { name: 'views' }],
    rows: [['SHORTS', 2201], ['YT_SEARCH', 230], ['SUBSCRIBER', 66]],
  };
  it('경로→조회수 맵으로 만든다', () => {
    expect(parseTrafficReport(json)).toEqual({ SHORTS: 2201, YT_SEARCH: 230, SUBSCRIBER: 66 });
  });
  it('같은 경로가 여러 행이면 합산한다', () => {
    const dup = { columnHeaders: json.columnHeaders, rows: [['SHORTS', 100], ['SHORTS', 50]] };
    expect(parseTrafficReport(dup)).toEqual({ SHORTS: 150 });
  });
  it('행 없음·이형은 빈 맵', () => {
    expect(parseTrafficReport({ rows: [] })).toEqual({});
    expect(parseTrafficReport({ rows: [[123, 'x']] })).toEqual({});
    expect(parseTrafficReport(undefined)).toEqual({});
  });
});

describe('shortsFeedShare — 피드 비중(순수)', () => {
  it('Shorts 피드 비중을 0~1 로 준다', () => {
    expect(shortsFeedShare({ SHORTS: 2201, YT_SEARCH: 230, SUBSCRIBER: 66 })).toBeCloseTo(0.8817, 3);
  });
  it('피드 유입 0 은 0 — 노출이 끊긴 상태를 숫자로 표현할 수 있어야 한다', () => {
    expect(shortsFeedShare({ YT_SEARCH: 12, SUBSCRIBER: 3 })).toBe(0);
  });
  it('합이 0이면 null — 판단 불가와 0% 를 구분한다', () => {
    expect(shortsFeedShare({})).toBeNull();
    expect(shortsFeedShare({ SHORTS: 0 })).toBeNull();
  });
});

describe('columnIndex·ymd', () => {
  it('열 이름→인덱스', () => {
    expect(columnIndex(retentionJson)).toEqual({
      views: 0, estimatedMinutesWatched: 1, averageViewDuration: 2, averageViewPercentage: 3,
    });
    expect(columnIndex({})).toEqual({});
  });
  it('UTC 날짜 문자열', () => {
    expect(ymd(Date.UTC(2026, 8, 3, 15, 30))).toBe('2026-09-03');
  });
});

describe('isAuthError — 조기 종료 대상 판별(순수)', () => {
  it('401·403 만 전체 중단(토큰·스코프 문제는 다음 영상도 동일)', () => {
    expect(isAuthError('403: Insufficient permission')).toBe(true);
    expect(isAuthError('401: Invalid Credentials')).toBe(true);
  });
  it('5xx·429 는 이 영상만 스킵 — 일시 오류로 그날 수집을 통째로 잃지 않는다(2026-09-03 실측 500→재시도 200)', () => {
    expect(isAuthError('500: Internal error encountered.')).toBe(false);
    expect(isAuthError('503: Service unavailable')).toBe(false);
    expect(isAuthError('429: Quota exceeded')).toBe(false);
    expect(isAuthError('400: Invalid query')).toBe(false);
  });
  it('코드가 문자열 안쪽에 있는 경우는 인증오류로 보지 않는다(오분류 방지)', () => {
    expect(isAuthError('500: request id 403 failed')).toBe(false);
  });
});

describe('ANALYTICS_LAG_DAYS — 처리 지연 경계', () => {
  it('2일 — 실측(09-03 조회 시 08-31까지)', () => { expect(ANALYTICS_LAG_DAYS).toBe(2); });
});

describe('hasMeasurement — 빈 측정 기록 방지(순수)', () => {
  const r = (views: number) => ({ views, watchMinutes: 0, avgViewSec: 0, avgViewPct: 0 });
  it('조회가 있으면 기록', () => { expect(hasMeasurement(r(1049), { SHORTS: 1027 })).toBe(true); });
  it('조회 0이어도 유입 경로가 잡히면 기록', () => { expect(hasMeasurement(r(0), { YT_SEARCH: 3 })).toBe(true); });
  it('조회 0 + 경로 0건은 기록하지 않는다 — 처리 전과 구분 불가', () => {
    expect(hasMeasurement(r(0), {})).toBe(false);
  });
  it('retention 자체가 없으면 기록하지 않는다', () => { expect(hasMeasurement(null, {})).toBe(false); });
});

describe('parseSearchTerms — 유튜브 검색어 파싱(순수, 2026-09-04)', () => {
  it('조회수 많은 순으로 정렬한다', () => {
    expect(parseSearchTerms({ rows: [['포도수확시기', 173], ['하스카프베리묘목', 551]] }))
      .toEqual([{ keyword: '하스카프베리묘목', count: 551 }, { keyword: '포도수확시기', count: 173 }]);
  });
  it('빈 응답·행 없음은 빈 배열', () => {
    expect(parseSearchTerms(null)).toEqual([]);
    expect(parseSearchTerms({})).toEqual([]);
    expect(parseSearchTerms({ rows: [] })).toEqual([]);
  });
  it('키워드 없는 행·0 이하·숫자 아닌 값은 버린다', () => {
    expect(parseSearchTerms({ rows: [['', 10], ['정상', 0], ['이상', 'x'], ['좋음', 3]] }))
      .toEqual([{ keyword: '좋음', count: 3 }]);
  });
  it('앞뒤 공백을 다듬는다', () => {
    expect(parseSearchTerms({ rows: [['  포도  ', 5]] })).toEqual([{ keyword: '포도', count: 5 }]);
  });
});
