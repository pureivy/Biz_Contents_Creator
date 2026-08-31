import { describe, it, expect } from 'vitest';
import { axisTicks, followerDelta } from './FollowerTrend';
import type { FollowersData } from '../api';

// 추이 그래프 축·증감 검토(2026-08-02) — 실데이터에서 두 결함이 재현됐다.
describe('axisTicks — 팔로워 수는 음수 없는 정수 카운트', () => {
  it('전부 0인 시리즈에 음수 라벨을 만들지 않는다 — 페북 [0,0,0,0] 이 "-1" 을 찍었다', () => {
    const { y0, ticks } = axisTicks([0, 0, 0, 0]);
    expect(y0).toBe(0);
    expect(ticks.every((t) => t >= 0)).toBe(true);
  });
  it('[0,0,1] 에 같은 라벨이 두 번 찍히지 않는다 — 중간값 0.5 가 1 로 반올림돼 "1,1,0" 이었다', () => {
    const { ticks } = axisTicks([0, 0, 1]);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
  });
  it('눈금은 내림차순 정수이고 데이터 범위를 담는다', () => {
    const { y0, y1, ticks } = axisTicks([36, 38, 44, 48]);
    expect(y0).toBeLessThanOrEqual(36);
    expect(y1).toBeGreaterThanOrEqual(48);
    expect(ticks).toEqual([...ticks].sort((a, b) => b - a));
  });
  it('flat 비영 시리즈도 폭을 갖는다(선이 축에 붙지 않게)', () => {
    const { y0, y1 } = axisTicks([5, 5, 5]);
    expect(y1).toBeGreaterThan(y0);
    expect(y0).toBeGreaterThanOrEqual(0);
  });
});

describe('followerDelta — 전일 대비(사용자 확정 2026-08-02)', () => {
  const mk = (snaps: Array<{ date: string; youtube: number }>): FollowersData =>
    ({ snapshots: snaps, latest: snaps[snaps.length - 1] ?? null, goal: 1000 } as unknown as FollowersData);
  it('전일 스냅샷이 있으면 그것과 비교', () => {
    expect(followerDelta(mk([{ date: '2026-07-30', youtube: 38 }, { date: '2026-07-31', youtube: 44 }]), 'youtube')).toBe(6);
  });
  it('전일이 결측이면 null — 이틀치를 하루치로 보여주지 않는다(08-01 결측 실사례)', () => {
    expect(followerDelta(mk([{ date: '2026-07-31', youtube: 44 }, { date: '2026-08-02', youtube: 48 }]), 'youtube')).toBeNull();
  });
  it('앞선 기록이 여럿이어도 날짜로 전일을 찾는다(직전 표본이 아님)', () => {
    const d = mk([
      { date: '2026-07-30', youtube: 38 },
      { date: '2026-07-31', youtube: 44 },
      { date: '2026-08-01', youtube: 46 },
      { date: '2026-08-02', youtube: 48 },
    ]);
    expect(followerDelta(d, 'youtube')).toBe(2); // 08-02(48) - 08-01(46)
  });
  it('월 경계를 넘어도 전일을 찾는다', () => {
    expect(followerDelta(mk([{ date: '2026-07-31', youtube: 44 }, { date: '2026-08-01', youtube: 46 }]), 'youtube')).toBe(2);
  });
  it('표본 1개면 null', () => {
    expect(followerDelta(mk([{ date: '2026-08-02', youtube: 48 }]), 'youtube')).toBeNull();
  });
});
