import { describe, it, expect } from 'vitest';
import { speciesInText, speciesCoverage, overSpeciesCap, speciesRotationBlock, SPECIES_MONTHLY_CAP } from './speciesRotation';

const CAT = [
  { group: '유실수', species: [{ name: '사과나무', aliases: ['사과'] }, { name: '배나무' }, { name: '블루베리', aliases: ['블루베리나무'] }, { name: '매실나무', aliases: ['매실'] }] },
  { group: '조경수', species: [{ name: '배롱나무', aliases: ['배롱', '백일홍나무'] }, { name: '느티나무', aliases: ['느티'] }] },
];
const NOW = new Date('2026-08-27T18:00:00+09:00');
const d = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('speciesInText — 카탈로그 수종 탐지(가장 긴 표기 우선)', () => {
  it('별칭·정식명 모두 잡고 정식명으로 돌려준다', () => {
    expect(speciesInText('배롱 8월 말 꽃이 안 필 때', CAT)).toBe('배롱나무');
    expect(speciesInText('사과 나무 묘목 고르기', CAT)).toBe('사과나무');
    expect(speciesInText('블루베리 물주기', CAT)).toBe('블루베리');
  });
  it("'배'는 별칭이 아니라 배롱·배수에 오탐 없음, 배나무는 잡힘", () => {
    expect(speciesInText('배수 문제와 배롱나무', CAT)).toBe('배롱나무');
    expect(speciesInText('배나무 가을 거름', CAT)).toBe('배나무');
  });
  it('카탈로그 없음·수종 없음이면 null', () => {
    expect(speciesInText('묘목 심기 전 흙 상태', CAT)).toBeNull();
    expect(speciesInText('배롱나무', undefined)).toBeNull();
  });
});

describe('speciesCoverage / overSpeciesCap — 30일 창 편수와 월 상한', () => {
  const items = [
    { title: '배롱나무 관리', ts: d(5) }, { title: '배롱나무선택', keyword: '배롱나무선택', ts: d(9) }, { title: '배롱 개화시기', ts: d(21) },
    { title: '블루베리 물주기', ts: d(3) },
    { title: '매실나무 전정', ts: d(40) },  // 창 밖
  ];
  it('30일 안 편수만 센다', () => {
    const cov = speciesCoverage(items, CAT, NOW);
    expect(cov.get('배롱나무')).toBe(3);
    expect(cov.get('블루베리')).toBe(1);
    expect(cov.has('매실나무')).toBe(false);
  });
  it(`상한(${SPECIES_MONTHLY_CAP}) 도달 수종은 기각, 미달·미다룸은 통과`, () => {
    const cov = speciesCoverage(items, CAT, NOW);
    expect(overSpeciesCap('배롱나무 꽃 안 피는 이유', cov, CAT)).toEqual({ name: '배롱나무', count: 3 });
    expect(overSpeciesCap('블루베리 가을 거름', cov, CAT)).toBeNull();
    expect(overSpeciesCap('느티나무 심는 간격', cov, CAT)).toBeNull();
  });
});

describe('speciesRotationBlock — 제안 금지·피함·우선 목록', () => {
  it('세 묶음을 분류별로 나열한다', () => {
    const cov = new Map([['배롱나무', 3], ['블루베리', 1]]);
    const b = speciesRotationBlock(CAT, cov);
    expect(b).toContain('제안 금지');
    expect(b).toContain('배롱나무(3편)');
    expect(b).toContain('피함: 블루베리(1편)');
    expect(b).toContain('· 유실수: 사과나무, 배나무, 매실나무');
    expect(b).toContain('· 조경수: 느티나무');
    expect(b).toContain('최소 5개');
  });
  it('카탈로그 없으면 빈 문자열', () => { expect(speciesRotationBlock(undefined, new Map())).toBe(''); });
});
