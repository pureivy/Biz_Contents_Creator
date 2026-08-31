import { describe, it, expect } from 'vitest';
import { seasonalHint } from './naver_datalab';
import type { TrendPoint } from './naver_datalab';

const pt = (period: string, ratio: number): TrendPoint => ({ period: `${period}-01`, ratio });

// 실측 표본 — 계수나무 꽃(2026-08-28 데이터랩 14점). 6개월 창(26-02~08)만 보면 4월 정점 뒤 저점이라
// 리서치팀이 "지금은 비수기, 봄을 노리는 자산형"으로 브리프를 썼다. 실제로는 작년 8월 28 → 9월 48 로
// 가을에 2차 정점이 있고, 수요 게이트(13개월)는 그걸 반영해 채택했다. 둘이 다른 데이터를 본 게 원인.
const 계수나무꽃: TrendPoint[] = [
  pt('2025-07', 36), pt('2025-08', 28), pt('2025-09', 48), pt('2025-10', 55),
  pt('2025-11', 40), pt('2025-12', 16), pt('2026-01', 19), pt('2026-02', 14),
  pt('2026-03', 44), pt('2026-04', 100), pt('2026-05', 78), pt('2026-06', 41),
  pt('2026-07', 36), pt('2026-08', 41),
];

describe('seasonalHint — 작년 같은 달 비교', () => {
  it('작년 이맘때·작년 다음 달·지금을 짚어 준다', () => {
    const h = seasonalHint(계수나무꽃);
    expect(h).toContain('작년 이맘때 28');       // 25-08
    expect(h).toContain('작년 다음 달 48');      // 25-09 — 가을 상승 신호
    expect(h).toContain('지금 41');              // 26-08
  });

  it('수요 게이트(seasonIdx)와 같은 두 점을 가리킨다 — 브리프와 게이트가 같은 근거를 보게', () => {
    // seasonIdx = max(현재, 작년 다음 달) / 정점 = max(41, 48) / 100 = 0.48
    const cur = 계수나무꽃[계수나무꽃.length - 1]!.ratio;
    const lastYearNext = 계수나무꽃[계수나무꽃.length - 12]!.ratio;
    expect(Math.max(cur, lastYearNext) / 100).toBeCloseTo(0.48, 2);
    expect(seasonalHint(계수나무꽃)).toContain(String(Math.round(lastYearNext)));
  });

  it('13점 미만이면 빈 문자열 — 없는 비교를 지어내지 않는다', () => {
    expect(seasonalHint(계수나무꽃.slice(-6))).toBe('');   // 6개월(구 동작)
    expect(seasonalHint(계수나무꽃.slice(-12))).toBe('');  // 12점도 작년 같은 달이 없다
    expect(seasonalHint([])).toBe('');
  });

  it('정확히 13점이면 동작한다(경계)', () => {
    const h = seasonalHint(계수나무꽃.slice(-13));
    expect(h).toContain('작년 이맘때');
    expect(h).not.toBe('');
  });

  it('소수 비율은 반올림해 읽기 쉽게 낸다', () => {
    const pts = Array.from({ length: 13 }, (_, i) => pt(`2025-${String(i + 1).padStart(2, '0')}`, 12.6));
    expect(seasonalHint(pts)).toContain('13');
  });
});
