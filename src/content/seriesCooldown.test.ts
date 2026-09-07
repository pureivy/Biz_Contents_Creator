import { describe, it, expect } from 'vitest';
import { seriesStems, fallbackSeriesLabels, stripGenericSuffix } from './seriesCooldown';
import type { NameEntry } from './seriesCooldown';

// 원예 브랜드가 brand.yaml 에 넣을 값을 명시 인자로 준다 — 코드 기본은 업종 중립(빈 표)이라 라벨이 null 이다.
const cat = (pairs: Array<[string, string[]?]>): NameEntry[] => {
  const out: NameEntry[] = [];
  for (const [name, aliases] of pairs) { out.push({ key: name, name }); for (const a of aliases ?? []) out.push({ key: a, name }); }
  return out.sort((a, b) => b.key.length - a.key.length);
};
const NAMES = cat([['포도나무', ['포도']], ['블루베리'], ['하스카프베리'], ['감나무'], ['소나무'], ['올리브나무', ['올리브']], ['배롱나무', ['배롱']]]);
const GENERIC = ['나무', '묘목', '유실수', '조경수', '과실나무'];
const AXES = [
  { terms: ['전정', '가지치기', '가지정리', '도장지', '순정리'] },
  { terms: ['물주기', '급수', '관수'] },
  { terms: ['식재', '심기', '옮겨심기', '이식', '심는', '심을'] },
  { terms: ['고르기', '고르는법', '판별', '선별'] },
];

describe('seriesStems — 소재 어간 추출(순수)', () => {
  it('이름·별칭을 정식명으로 바꾸고 총칭 접미를 뗀다', () => {
    expect(seriesStems('포도나무 가지치기, 제한 가지', NAMES, GENERIC)).toEqual(['포도']);
    expect(seriesStems('블루베리 나무 키우기 베란다', NAMES, GENERIC)).toEqual(['블루베리']);
    expect(seriesStems('올리브 물주기', NAMES, GENERIC)).toEqual(['올리브']);
  });
  it('총칭만 있는 문장은 빈 목록', () => {
    expect(seriesStems('과실나무 전정, 어린 나무 주지', NAMES, GENERIC)).toEqual([]);
    expect(seriesStems('나무 물주기', NAMES, GENERIC)).toEqual([]);
  });
  it('단음절 어간(감나무·소나무)은 전체어를 키로 — seriesLedger.normSpecies 와 같은 키 공간', () => {
    expect(seriesStems('감나무 묘목 고르기', NAMES, GENERIC)).toEqual(['감나무']);
    expect(seriesStems('소나무 전정 시기', NAMES, GENERIC)).toEqual(['소나무']);
    expect(seriesStems('하스카프베리 재배, 두 품종', NAMES, GENERIC)).toEqual(['하스카프베리']);
  });
  it('이름 표가 비면(범용 기본) 앵커 정규식이 있을 때만 잡고, 없으면 빈 목록', () => {
    expect(seriesStems('포도나무 가지치기', [], [], null)).toEqual([]);
    expect(seriesStems('포도나무', [], ['나무'], (t) => /[가-힣]{1,6}나무/.test(t))).toEqual(['포도나무']);
    expect(seriesStems('나무', [], ['나무'], (t) => /나무/.test(t))).toEqual([]);
  });
});

describe('stripGenericSuffix', () => {
  it('가장 긴 총칭 접미를 떼되 어간이 2자 미만이면 그대로', () => {
    expect(stripGenericSuffix('배롱나무', GENERIC)).toBe('배롱');
    expect(stripGenericSuffix('감나무', GENERIC)).toBe('감나무');
    expect(stripGenericSuffix('사과 묘목', GENERIC)).toBe('사과');
    expect(stripGenericSuffix('포도', [])).toBe('포도');
  });
});

describe('fallbackSeriesLabels — 결정적 라벨 폴백(LLM 분류 실패 시의 바닥)', () => {
  it('소재 + 행위 축 표준형', () => {
    expect(fallbackSeriesLabels('포도나무 가지 정리, 9월엔', { names: NAMES, generic: GENERIC, axes: AXES })).toEqual({ species: '포도', activity: '전정' });
    expect(fallbackSeriesLabels('올리브나무 물주기, 과습 주의', { names: NAMES, generic: GENERIC, axes: AXES })).toEqual({ species: '올리브', activity: '물주기' });
  });
  it('행위 축이 없으면 null · 총칭만이면 소재 null', () => {
    expect(fallbackSeriesLabels('배롱나무 꽃 안 피는 이유', { names: NAMES, generic: GENERIC, axes: AXES })).toEqual({ species: '배롱', activity: null });
    expect(fallbackSeriesLabels('묘목 고르는 세 가지 기준', { names: NAMES, generic: GENERIC, axes: AXES }).activity).not.toBe('전정');
  });
  it('브랜드 설정이 전혀 없으면 둘 다 null — 원장 방식은 LLM 라벨로만 돈다', () => {
    expect(fallbackSeriesLabels('포도나무 가지치기', { names: [], generic: [], axes: [] })).toEqual({ species: null, activity: null });
  });
});
