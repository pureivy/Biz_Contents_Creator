import { describe, it, expect } from 'vitest';
import { unusedStock, stockBlock, usedSpecies, MIN_USABLE_SEC, STOCK_NAMES_IN_PROMPT } from './mediaStock';
import type { StockItem } from './mediaStock';

const vid = (species: string, seconds: number): StockItem => ({ species, seconds, kind: 'video' });

describe('unusedStock — 안 쓴 소재 묶기(순수)', () => {
  it('쓴 소재는 빼고 안 쓴 것만 준다', () => {
    const rows = unusedStock([vid('감나무', 30), vid('사과나무', 25)], new Set(['사과나무']));
    expect(rows.map((r) => r.species)).toEqual(['감나무']);
  });

  it('같은 소재 여러 건은 하나로 묶고 건수를 센다', () => {
    const rows = unusedStock([vid('대추나무', 30), vid('대추나무', 23)], new Set());
    expect(rows).toEqual([{ species: '대추나무', count: 2, seconds: 30 }]);
  });

  it('건수 많은 순 — 재고가 두꺼운 쪽을 먼저 소진한다', () => {
    const rows = unusedStock([vid('감나무', 40), vid('대추나무', 10), vid('대추나무', 12)], new Set());
    expect(rows.map((r) => r.species)).toEqual(['대추나무', '감나무']);
  });

  it('너무 짧은 영상은 재고가 아니다 — 주제만 끌고 화면엔 안 들어간다', () => {
    expect(unusedStock([vid('감나무', MIN_USABLE_SEC - 0.1)], new Set())).toEqual([]);
    expect(unusedStock([vid('감나무', MIN_USABLE_SEC)], new Set())).toHaveLength(1);
  });

  it('사진은 안 센다 — 사용자가 말한 것은 영상 자료다', () => {
    expect(unusedStock([{ species: '감나무', seconds: 30, kind: 'image' }], new Set())).toEqual([]);
  });

  it('무표기 소재는 안 센다 — 어느 주제로도 안 이어진다', () => {
    expect(unusedStock([{ seconds: 30, kind: 'video' }], new Set())).toEqual([]);
    expect(unusedStock([{ species: '  ', seconds: 30, kind: 'video' }], new Set())).toEqual([]);
  });

  it('길이가 없거나 이상하면 안 센다', () => {
    expect(unusedStock([{ species: '감나무', kind: 'video' }], new Set())).toEqual([]);
    expect(unusedStock([{ species: '감나무', seconds: NaN, kind: 'video' }], new Set())).toEqual([]);
  });

  it('별칭으로 붙인 딱지도 소진 판정된다 — 표준명으로 대조한다', () => {
    // '백일홍' 딱지를 쓴 배롱나무 편이 이미 나갔으면, 그 소재는 재고가 아니다
    const canon = (n: string): string => (n === '백일홍' ? '배롱나무' : n);
    const rows = unusedStock([vid('백일홍', 24)], new Set(['배롱나무']), canon);
    expect(rows).toEqual([]);
  });

  it('사전이 모르는 딱지는 재고로 남긴다 — 모른다고 버리면 영원히 안 쓰인다', () => {
    const canon = (n: string): string => n; // 사전이 모름 → 그대로
    const rows = unusedStock([vid('홍가시나무', 16)], new Set(['감나무']), canon);
    expect(rows.map((r) => r.species)).toEqual(['홍가시나무']);
  });

  it('딱지 원문을 그대로 내놓는다 — 운영자가 적은 이름으로 프롬프트에 나가야 한다', () => {
    const canon = (n: string): string => (n === '백일홍' ? '배롱나무' : n);
    expect(unusedStock([vid('백일홍', 24)], new Set(), canon)[0]!.species).toBe('백일홍');
  });

  it('canon 이 터져도 소재를 잃지 않는다', () => {
    const boom = (): string => { throw new Error('x'); };
    expect(unusedStock([vid('감나무', 30)], new Set(), boom)).toHaveLength(1);
  });

  it('빈 입력은 빈 결과', () => {
    expect(unusedStock([], new Set())).toEqual([]);
  });
});

describe('stockBlock — 프롬프트 블록(순수)', () => {
  const rows = [
    { species: '대추나무', count: 2, seconds: 30 },
    { species: '감나무', count: 1, seconds: 38.7 },
  ];

  it('재고가 없으면 빈 문자열 — 무주입', () => {
    expect(stockBlock([])).toBe('');
  });

  it('소재 이름을 대고, 여러 건이면 건수를 붙인다', () => {
    const b = stockBlock(rows);
    expect(b).toContain('대추나무(2건)');
    expect(b).toContain('감나무');
    expect(b).not.toContain('감나무(1건)');
  });

  it('게이트가 아니라 동점 처리라고 못박는다 — 이게 이 블록의 전부다', () => {
    const b = stockBlock(rows);
    expect(b).toContain('동점');
    expect(b).toContain('계절');
    expect(b).toContain('검색 수요가 먼저');
  });

  it('마땅한 게 없으면 무시하라고 열어 둔다 — 재고가 주제를 끌고 가면 안 된다', () => {
    expect(stockBlock(rows)).toContain('무시하고');
  });

  it('이름은 상한까지만 대고 나머지는 개수로 — 다른 신호를 덮으면 안 된다', () => {
    const many = Array.from({ length: STOCK_NAMES_IN_PROMPT + 5 }, (_, i) =>
      ({ species: `수종${i}`, count: 1, seconds: 10 }));
    const b = stockBlock(many);
    expect(b).toContain('외 5건');
    expect(b).not.toContain(`수종${STOCK_NAMES_IN_PROMPT}`);
  });
});

describe('usedSpecies — 실촬영이 나간 소재 읽기(주입 의존)', () => {
  const shorts = [
    { id: 'a', keyword: '감나무 묘목', title: '감나무 심는 시기' },
    { id: 'b', keyword: '사과나무', title: '사과나무 열매' },
    { id: 'c', keyword: '멀칭', title: '나무 멀칭하는 법' },
  ];
  const speciesOf = (t: string): string | undefined =>
    ['감나무', '사과나무'].find((s) => t.includes(s));

  it('user 클립이 구워진 편의 소재만 센다', () => {
    const got = usedSpecies(shorts, { hasUserClip: (id) => id === 'a', speciesOf });
    expect([...got]).toEqual(['감나무']);
  });

  it('클립이 없으면 안 센다 — 배정 시도가 아니라 구워진 것이 근거다', () => {
    expect([...usedSpecies(shorts, { hasUserClip: () => false, speciesOf })]).toEqual([]);
  });

  it('소재가 안 잡히는 편은 건너뛴다', () => {
    const got = usedSpecies(shorts, { hasUserClip: (id) => id === 'c', speciesOf });
    expect([...got]).toEqual([]);
  });

  it('같은 소재 두 채널은 한 번만 — 승계로 둘 다 클립을 갖는다', () => {
    const pair = [{ id: 'y', title: '감나무 심기' }, { id: 'i', title: '감나무 심기' }];
    expect(usedSpecies(pair, { hasUserClip: () => true, speciesOf }).size).toBe(1);
  });

  it('한 편을 못 읽어도 나머지는 센다', () => {
    const got = usedSpecies(shorts, {
      hasUserClip: (id) => { if (id === 'a') throw new Error('권한'); return true; },
      speciesOf,
    });
    expect([...got]).toEqual(['사과나무']);
  });
});
