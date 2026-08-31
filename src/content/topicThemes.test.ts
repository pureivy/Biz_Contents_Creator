import { describe, it, expect } from 'vitest';
import { themeInText, themeCoverage, overThemeCap, themeRotationBlock, THEME_MONTHLY_CAP } from './topicThemes';

const TH = [
  { theme: '심기·이식', seeds: ['나무 심기 좋은 시기', '나무 옮겨심기'], match: ['심기', '심는', '이식', '간격'] },
  { theme: '번식·접목·삽목', seeds: ['나무 접붙이기', '눈접 붙이는 방법'], match: ['접목', '접붙이', '삽목', '휘묻이'] },
  { theme: '병충해·문제 진단', seeds: ['나무 벌레 약'], match: ['병충해', '벌레', '깍지벌레', '안 열리'] },
];
const NOW = new Date('2026-08-27T18:00:00+09:00');
const d = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('themeInText', () => {
  it('제목의 토큰으로 축을 잡는다(가장 앞 토큰 우선)', () => {
    expect(themeInText('감나무 접붙이기, 봄에 하는 이유', TH)).toBe('번식·접목·삽목');
    expect(themeInText('사과나무 심는 간격과 깍지벌레', TH)).toBe('심기·이식');
    expect(themeInText('블루베리 물주기', TH)).toBeNull();
  });
});

describe('themeCoverage / overThemeCap / block', () => {
  const items = [
    { title: '감나무 심는 시기', ts: d(2) }, { title: '매실 묘목 심기', ts: d(6) }, { title: '나무 이식 후 물', ts: d(12) }, { title: '포도 심는 간격', ts: d(20) },
    { title: '깍지벌레 약', ts: d(4) }, { title: '옛날 접목 글', ts: d(45) },
  ];
  it('30일 창 편수', () => {
    const cov = themeCoverage(items, TH, NOW);
    expect(cov.get('심기·이식')).toBe(4);
    expect(cov.get('병충해·문제 진단')).toBe(1);
    expect(cov.has('번식·접목·삽목')).toBe(false);
  });
  it(`상한(${THEME_MONTHLY_CAP}) 도달 축은 기각`, () => {
    const cov = themeCoverage(items, TH, NOW);
    expect(overThemeCap('대추나무 심는 시기', cov, TH)).toEqual({ theme: '심기·이식', count: 4 });
    expect(overThemeCap('대추나무 접붙이기', cov, TH)).toBeNull();
  });
  it('블록은 금지·피함·우선(검색어 예시)을 나열', () => {
    const b = themeRotationBlock(TH, themeCoverage(items, TH, NOW));
    expect(b).toContain('제안 금지(코드가 기각한다): 심기·이식(4편)');
    expect(b).toContain('피함: 병충해·문제 진단(1편)');
    expect(b).toContain('· 번식·접목·삽목: 예) 나무 접붙이기, 눈접 붙이는 방법');
    expect(themeRotationBlock(undefined, new Map())).toBe('');
  });
});

// 좁은 장 경고(2026-08-30) — 실사고: 16축 중 7축이 상한에 닿은 상태에서 두뇌가 상한 축으로 후보를
// 채워 한 라운드 17건이 코드 기각됐고 생산이 멈췄다. 남은 자리를 세어 알려 주면 그 자리를 피한다.
describe('themeRotationBlock — 좁은 장 경고', () => {
  const cov = (m: Record<string, number>): Map<string, number> => new Map(Object.entries(m));

  it('남은 축이 요구 후보 수 이하면 경고를 낸다', () => {
    // 3축 중 2축 상한 → 열린 축 1개, 후보 2개 요구
    const b = themeRotationBlock(TH, cov({ '심기·이식': 9, '병충해·문제 진단': 5 }), THEME_MONTHLY_CAP, 2);
    expect(b).toContain('⚠ 지금 쓸 수 있는 축은 1개뿐이다(3축 중 2축 상한 도달)');
    expect(b).toContain('상한 축으로 자리를 메우면 그 후보는 버려진다');
  });

  it('여유가 있으면 경고를 내지 않는다 — 정상 상태의 소음 방지', () => {
    // 축을 넉넉히 둔 장: 10축 중 1축만 상한 → 열린 축 9개로 후보 3개 요구를 여유 있게 채운다.
    const many = Array.from({ length: 10 }, (_, i) => ({ theme: `축${i}`, seeds: [`시드${i}`], match: [`토큰${i}`] }));
    const b = themeRotationBlock(many, cov({ '축0': 9 }), THEME_MONTHLY_CAP, 3);
    expect(b).toContain('상한 도달 → 제안 금지');            // 상한 안내는 그대로 나온다
    expect(b).not.toContain('⚠ 지금 쓸 수 있는 축은');       // 좁은 장 경고만 없다
  });

  it('상한 축이 없으면 경고 자체가 없다', () => {
    expect(themeRotationBlock(TH, cov({}), THEME_MONTHLY_CAP, 8)).not.toContain('⚠');
  });

  it('안 다룬 축이 하나도 없으면 대안을 덧붙인다', () => {
    // 3축 전부 다뤘고 2축이 상한 → fresh 없음
    const b = themeRotationBlock(TH, cov({ '심기·이식': 9, '병충해·문제 진단': 5, '번식·접목·삽목': 1 }), THEME_MONTHLY_CAP, 2);
    expect(b).toContain('안 다룬 축이 없으면 최근 다룸 축에서 편수가 적은 것부터 고른다');
  });

  it('축 정의가 없으면 종전대로 빈 문자열', () => {
    expect(themeRotationBlock(undefined, cov({}))).toBe('');
    expect(themeRotationBlock([], cov({}))).toBe('');
  });
});
