import { describe, it, expect } from 'vitest';
import { cardnewsSignal, parseIgInsights, parseFbEngagement, parseFbPostViews, cardnewsPerfDue } from './cardnewsPerf';

describe('cardnewsSignal', () => {
  it('0 도달 → 0(0나눗셈 안전)', () => expect(cardnewsSignal(0, 0, 0)).toBe(0));
  it('1만 도달·저장률 2%·공유율 1% ≈ 1.0', () => {
    expect(cardnewsSignal(10_000, 200, 100)).toBeGreaterThan(0.95);
  });
  it('저장·공유 없이 도달만 크면 0.4 이하(저장·공유 중심 가중)', () => {
    expect(cardnewsSignal(100_000, 0, 0)).toBeLessThanOrEqual(0.4 + 1e-9);
  });
});
describe('parseIgInsights', () => {
  it('insights 응답 → 지표맵, 이형은 빈 맵', () => {
    const j = { data: [{ name: 'reach', values: [{ value: 42 }] }, { name: 'saved', values: [{ value: 3 }] }] };
    expect(parseIgInsights(j)).toEqual({ reach: 42, saved: 3 });
    expect(parseIgInsights(null)).toEqual({});
    expect(parseIgInsights({ data: [{ name: 'reach', values: [{ value: 'x' }] }] })).toEqual({ reach: 0 });
  });
});
describe('parseFbEngagement', () => {
  it('필드 응답 → 카운트, 결측 0', () => {
    const j = { reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 } };
    expect(parseFbEngagement(j)).toEqual({ likes: 5, comments: 2, shares: 1 });
    expect(parseFbEngagement({})).toEqual({ likes: 0, comments: 0, shares: 0 });
  });
});
describe('parseFbPostViews', () => {
  it('post_media_view 를 조회수로 읽는다', () => {
    expect(parseFbPostViews({ data: [{ name: 'post_media_view', values: [{ value: 137 }] }] })).toBe(137);
  });
  it('read_insights 권한 없을 때의 빈 응답 → 0(반응 수집은 별개로 살아야 한다)', () => {
    expect(parseFbPostViews({ data: [] })).toBe(0);
    expect(parseFbPostViews(null)).toBe(0);
  });
  it('폐기된 post_impressions 만 오면 0 — 지표명이 바뀌었음을 조용히 넘기지 않게', () => {
    expect(parseFbPostViews({ data: [{ name: 'post_impressions', values: [{ value: 999 }] }] })).toBe(0);
  });
});
describe('cardnewsPerfDue', () => {
  const day = 86_400_000;
  it('미발행·igMediaId 없음 → false', () => {
    expect(cardnewsPerfDue({ }, Date.now(), 7)).toBe(false);
    expect(cardnewsPerfDue({ publishedTs: new Date().toISOString() }, Date.now(), 7)).toBe(false);
  });
  it('창 내 매일 true, 창 경과+미강화 true, 강화 완료 false, 포기 지평(4배) false', () => {
    const now = Date.now();
    const at = (ageDays: number): string => new Date(now - ageDays * day).toISOString();
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(3) }, now, 7)).toBe(true);
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(10) }, now, 7)).toBe(true);
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(10), perfReflected: true }, now, 7)).toBe(false);
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(30) }, now, 7)).toBe(false);
  });
});
