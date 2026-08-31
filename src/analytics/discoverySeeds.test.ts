import { describe, it, expect } from 'vitest';
import { pickDiscoverySeeds, pickThemeSeeds, looksLikeGardenQuery } from './discoverySeeds';

const CAT = [
  { group: '유실수', species: [{ name: '사과나무' }, { name: '배나무' }, { name: '매실나무' }, { name: '대추나무' }] },
  { group: '조경수', species: [{ name: '배롱나무' }, { name: '느티나무' }, { name: '이팝나무' }] },
];
const BRAND = ['묘목 식재', '나무 물주기', '배롱나무 관리'];

describe('pickDiscoverySeeds — 안 다룬 수종 회전 + 브랜드 시드 소량', () => {
  it('상한 수종은 빠지고, 안 다룬 수종이 먼저, 브랜드 시드 2개를 덧붙인다', () => {
    const cov = new Map([['배롱나무', 3], ['사과나무', 1]]);
    const out = pickDiscoverySeeds({ catalog: CAT, coverage: cov, brandSeeds: BRAND, max: 6, now: new Date('2026-08-27T12:00:00') });
    expect(out).toHaveLength(6);
    expect(out).not.toContain('배롱나무');
    const species = out.filter((s) => CAT.some((g) => g.species.some((x) => x.name === s)));
    expect(species).toHaveLength(4);
    expect(out.filter((s) => BRAND.includes(s))).toHaveLength(2);
    // 안 다룬 5종(배·매실·대추·느티·이팝) 중 4개가 먼저, 최근 다룸(사과 1편)은 그 뒤 순번
    const fresh = ['배나무', '매실나무', '대추나무', '느티나무', '이팝나무'];
    expect(species.filter((s) => fresh.includes(s)).length).toBeGreaterThanOrEqual(3);
  });
  it('날짜가 바뀌면 시드가 회전한다', () => {
    const a = pickDiscoverySeeds({ catalog: CAT, coverage: new Map(), brandSeeds: [], max: 3, now: new Date('2026-08-27T12:00:00') });
    const b = pickDiscoverySeeds({ catalog: CAT, coverage: new Map(), brandSeeds: [], max: 3, now: new Date('2026-08-28T12:00:00') });
    expect(a).not.toEqual(b);
    expect(new Set([...a, ...b]).size).toBeGreaterThan(3);
  });
  it('카탈로그 없으면 브랜드 시드 그대로(종전 동작)', () => {
    expect(pickDiscoverySeeds({ catalog: undefined, coverage: new Map(), brandSeeds: BRAND, max: 8 })).toEqual(BRAND);
  });
});

describe('looksLikeGardenQuery — 자동완성 잡음 제거', () => {
  it('원예 의도어가 있으면 통과, 노래·상호·의원은 제외', () => {
    for (const q of ['매실나무 묘목', '체리나무키우기', '대추나무 가지치기 시기', '호두나무 심는 간격']) expect(looksLikeGardenQuery(q)).toBe(true);
    for (const q of ['대추나무 사랑걸렸네', '대추나무집', '대추나무한의원', '체리나무 원목']) expect(looksLikeGardenQuery(q)).toBe(false);
  });
});

describe('pickThemeSeeds — 안 다룬 축부터, 상한 축 제외, 날짜 회전', () => {
  const TH = [
    { theme: 'A', seeds: ['a1', 'a2'], match: [] }, { theme: 'B', seeds: ['b1'], match: [] }, { theme: 'C', seeds: ['c1', 'c2', 'c3'], match: [] }, { theme: 'D', seeds: ['d1'], match: [] },
  ];
  it('상한 도달 축(4편)은 빠지고 편수 적은 축이 먼저', () => {
    const cov = new Map([['A', 4], ['B', 1]]);
    const out = pickThemeSeeds({ themes: TH, coverage: cov, max: 2, now: new Date('2026-08-27T12:00:00') });
    expect(out).toHaveLength(2);
    expect(out.some((s) => s.startsWith('a'))).toBe(false);
    expect(out.some((s) => s.startsWith('c') || s.startsWith('d'))).toBe(true);
  });
  it('날짜가 바뀌면 구절이 회전한다', () => {
    const a = pickThemeSeeds({ themes: TH, coverage: new Map(), max: 3, now: new Date('2026-08-27T12:00:00') });
    const b = pickThemeSeeds({ themes: TH, coverage: new Map(), max: 3, now: new Date('2026-08-28T12:00:00') });
    expect(a).not.toEqual(b);
  });
  it('축 없음·max 0 이면 빈 배열', () => {
    expect(pickThemeSeeds({ themes: undefined, coverage: new Map(), max: 3 })).toEqual([]);
    expect(pickThemeSeeds({ themes: TH, coverage: new Map(), max: 0 })).toEqual([]);
  });
});
