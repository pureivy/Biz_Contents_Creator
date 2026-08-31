import { describe, it, expect } from 'vitest';
import { shortsSignal, parseStatsResponse, shortsPerfDue, shouldRecordMemory, countSamples, shortsMetaPerfDue, parseFbVideoStats, aggregateShortsTopicRows } from './shortsPerf';

describe('aggregateShortsTopicRows — 키워드 계열 중앙값 랭킹(순수, 2026-08-20 주제 되먹임)', () => {
  it('같은 계열 여러 편은 중앙값으로 묶고, 합산 중앙값 내림차순 정렬한다', () => {
    const out = aggregateShortsTopicRows([
      { label: '배롱나무', yt: 800, ig: 2500 },
      { label: '배롱나무', yt: 900, ig: 5200 },
      { label: '묘목 고르는 법', yt: 400, ig: 300 },
    ]);
    expect(out[0]).toEqual({ label: '배롱나무', n: 2, ytMed: 850, igMed: 3850 });
    expect(out[1]).toEqual({ label: '묘목 고르는 법', n: 1, ytMed: 400, igMed: 300 });
  });
  it('측정 없음(-1)은 0 이 아니라 null(측정 없음)로 다룬다 — 단일 채널 계열 오귀속 방지', () => {
    expect(aggregateShortsTopicRows([{ label: 'a', yt: -1, ig: 100 }])[0]).toEqual({ label: 'a', n: 1, ytMed: null, igMed: 100 });
  });
  it('랭킹 키는 측정 채널 중앙값의 최대값 — 유튜브 단독 900 계열이 양채널(300·2000) 계열보다 아래', () => {
    const out = aggregateShortsTopicRows([
      { label: 'yt단독', yt: 900, ig: -1 },
      { label: '양채널', yt: 300, ig: 2000 },
    ]);
    expect(out.map((r) => r.label)).toEqual(['양채널', 'yt단독']);
  });
});

describe('shortsSignal — 로그 스케일 + 좋아요율(순수)', () => {
  it('0뷰=0, 1만뷰≈0.8(뷰만), 좋아요율 1% 이상이면 +0.2 만점', () => {
    expect(shortsSignal(0, 0)).toBe(0);
    expect(shortsSignal(10_000, 0)).toBeGreaterThan(0.75);
    expect(shortsSignal(10_000, 0)).toBeLessThanOrEqual(0.8);
    expect(shortsSignal(10_000, 100)).toBeCloseTo(shortsSignal(10_000, 0) + 0.2, 5);
    expect(shortsSignal(100, 0)).toBeLessThan(shortsSignal(1_000, 0)); // 단조 증가
  });
});
describe('parseStatsResponse — 이형·결측 방어(순수)', () => {
  it('정상 항목 매핑, id 없음/비수치/음수 방어', () => {
    const m = parseStatsResponse({ items: [
      { id: 'v1', statistics: { viewCount: '123', likeCount: '4', commentCount: '5' } },
      { statistics: { viewCount: '9' } },
      { id: 'v2', statistics: { viewCount: 'x', likeCount: '-3' } },
    ] });
    expect(m.get('v1')).toEqual({ views: 123, likes: 4, comments: 5 });
    expect(m.has('')).toBe(false);
    expect(m.get('v2')).toEqual({ views: 0, likes: 0, comments: 0 });
    expect(parseStatsResponse(null).size).toBe(0);
    expect(parseStatsResponse({}).size).toBe(0);
  });
});
describe('shortsPerfDue — 창 내 매일·경과 후 미강화 1회(순수)', () => {
  const DAY = 86_400_000;
  const base = { youtubeId: 'v', youtubeTs: new Date(1_000_000_000_000).toISOString() };
  const now = 1_000_000_000_000;
  it('창 내 true(reflected 무관), 경과+미강화 true, 경과+강화 false', () => {
    expect(shortsPerfDue(base, now + 3 * DAY, 7)).toBe(true);
    expect(shortsPerfDue({ ...base, perfReflected: true }, now + 3 * DAY, 7)).toBe(true);
    expect(shortsPerfDue(base, now + 10 * DAY, 7)).toBe(true);
    expect(shortsPerfDue({ ...base, perfReflected: true }, now + 10 * DAY, 7)).toBe(false);
  });
  it('필드 결측·이상 Ts 는 false', () => {
    expect(shortsPerfDue({ youtubeTs: base.youtubeTs }, now, 7)).toBe(false);
    expect(shortsPerfDue({ youtubeId: 'v' }, now, 7)).toBe(false);
    expect(shortsPerfDue({ youtubeId: 'v', youtubeTs: '이상한값' }, now, 7)).toBe(false);
  });
  it('포기 지평(측정창 4배) 경과 시 미강화라도 false — 영구 비공개/삭제 영상 무한 재시도 방지', () => {
    expect(shortsPerfDue(base, now + 27 * DAY, 7)).toBe(true);   // 4배(28일) 이내 — 아직 due
    expect(shortsPerfDue(base, now + 29 * DAY, 7)).toBe(false);  // 4배 초과 — 포기
  });
});
describe('shouldRecordMemory — 긍정 즉시·부정은 실측 2틱 게이트(순수)', () => {
  it('signal≥0.6 이면 샘플 수 무관 true, 미만이면 2틱부터', () => {
    expect(shouldRecordMemory(0.7, 0)).toBe(true);
    expect(shouldRecordMemory(0.6, 1)).toBe(true);
    expect(shouldRecordMemory(0.3, 1)).toBe(false);
    expect(shouldRecordMemory(0.3, 2)).toBe(true);
  });
});
describe('countSamples', () => {
  it('소스 필터 카운트 — 메타 샘플 혼입 시 유튜브 카운트 불변(게이트 회귀)', () => {
    const samples = [
      { source: 'youtube:api' }, { source: 'meta:ig' }, { source: 'meta:fb' },
      { source: 'youtube:api' }, { source: undefined },
    ];
    expect(countSamples(samples, 'youtube:api')).toBe(2);   // 메타 3건 혼입돼도 2
    expect(countSamples(samples, 'meta:ig')).toBe(1);
    expect(countSamples([], 'youtube:api')).toBe(0);
  });
});
describe('shortsMetaPerfDue', () => {
  const day = 86_400_000;
  it('igReelId·metaPublishedTs 없음 → false', () => {
    expect(shortsMetaPerfDue({}, Date.now(), 7)).toBe(false);
    expect(shortsMetaPerfDue({ igReelId: 'r' }, Date.now(), 7)).toBe(false);
  });
  it('창 내 매일 true / 창 경과+미강화 true / 강화 완료 false / 포기 지평(4배) false', () => {
    const now = Date.now();
    const at = (d: number): string => new Date(now - d * day).toISOString();
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(3) }, now, 7)).toBe(true);
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(10) }, now, 7)).toBe(true);
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(10), metaPerfReflected: true }, now, 7)).toBe(false);
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(30) }, now, 7)).toBe(false);
  });
});

// FB 비디오(릴스) 노드 응답 파서 — 게시물 노드와 형태가 달라 그대로 쓰면 전부 0 이 된다.
// 실측(2026-07-27): post_id 로 게시물을 거치는 2단 경로는 '(#12) singular statuses API deprecated' 로 실패하고,
// 비디오 노드 직접 조회(views + likes/comments summary)만 현재 권한으로 통과한다.
describe('parseFbVideoStats', () => {
  it('views 스칼라 + likes/comments summary 추출', () => {
    expect(parseFbVideoStats({
      views: 1,
      likes: { data: [], summary: { total_count: 3 } },
      comments: { data: [], summary: { total_count: 2 } },
    })).toEqual({ views: 1, likes: 3, comments: 2 });
  });
  it('결측·이형·음수는 0(가짜 수치 금지)', () => {
    expect(parseFbVideoStats({})).toEqual({ views: 0, likes: 0, comments: 0 });
    expect(parseFbVideoStats(null)).toEqual({ views: 0, likes: 0, comments: 0 });
    expect(parseFbVideoStats({ views: -5, likes: { summary: { total_count: 'x' } } })).toEqual({ views: 0, likes: 0, comments: 0 });
  });
  it('게시물 노드 형태(reactions)를 줘도 0 — 잘못된 쿼리를 조용히 통과시키지 않는다', () => {
    expect(parseFbVideoStats({ reactions: { summary: { total_count: 9 } } })).toEqual({ views: 0, likes: 0, comments: 0 });
  });
});
