import { describe, it, expect } from 'vitest';
import { computeSeriesScores, gateForLabels, fillLabelsFromKnown, SERIES_SOFT, SERIES_HARD_COMBO, SERIES_HARD_SINGLE } from './seriesLedger';

const NOW = new Date('2026-08-25T00:00:00Z').getTime();
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

describe('computeSeriesScores — 지수 감쇠 점수(반감기 3.5일, 순수)', () => {
  it('오늘 1.0, 3.5일 전 ≈0.5로 감쇠하고 수종·행위·조합을 각각 집계한다', () => {
    const s = computeSeriesScores([
      { species: '포도', activity: '전정', ts: daysAgo(0) },
      { species: '포도', activity: '월동', ts: daysAgo(3.5) },
    ], NOW);
    expect(s.species.get('포도')!).toBeCloseTo(1.5, 1);
    expect(s.activity.get('전정')!).toBeCloseTo(1.0, 5);
    expect(s.combo.get('포도×전정')!).toBeCloseTo(1.0, 5);
    expect(s.combo.get('포도×월동')!).toBeCloseTo(0.5, 1);
  });
  it('21일 지평 밖은 무시한다(절벽이 아니라 감쇠 후 컷)', () => {
    const s = computeSeriesScores([{ species: '포도', activity: null, ts: daysAgo(30) }], NOW);
    expect(s.species.size).toBe(0);
  });
});

describe('gateForLabels — 조합 엄격·단독 느슨·소프트 2단계(순수)', () => {
  it('포도 4편/6일 실사고 재현: 수종 단독 하드', () => {
    const s = computeSeriesScores([0, 1, 3, 5].map((d) => ({ species: '포도', activity: null, ts: daysAgo(d) })), NOW);
    expect(s.species.get('포도')!).toBeGreaterThanOrEqual(SERIES_HARD_SINGLE);
    expect(gateForLabels({ species: '포도', activity: '수확' }, s).level).toBe('hard');
  });
  it('조합은 이틀 2편이면 하드, 같은 수종의 새 조합은 소프트로만 걸린다', () => {
    const s = computeSeriesScores([
      { species: '포도', activity: '전정', ts: daysAgo(0.5) },
      { species: '포도', activity: '전정', ts: daysAgo(1.5) },
    ], NOW);
    const combo = gateForLabels({ species: '포도', activity: '전정' }, s);
    expect(combo.level).toBe('hard');
    expect(combo.key).toBe('포도×전정');
    // 같은 수종의 새 조합: 감쇠 점수 ~1.5 < 2.4(단독 하드)라 종전엔 소프트였지만, 3일 바닥선(2026-08-27
    // 사용자: 며칠 만의 같은 수종 재등장 금지)이 먼저 걸려 하드. 3일이 지나면 종전대로 소프트.
    const newCombo = gateForLabels({ species: '포도', activity: '월동' }, s);
    expect(newCombo).toMatchObject({ level: 'hard', key: '포도', why: '수종 3일 2편' });
    const s4 = computeSeriesScores([
      { species: '포도', activity: '전정', ts: daysAgo(3.5) },
      { species: '포도', activity: '전정', ts: daysAgo(4.5) },
    ], NOW);
    expect(gateForLabels({ species: '포도', activity: '월동' }, s4).level).not.toBe('hard'); // 바닥선 해제 — 감쇠 점수(~0.9)만 남는다
  });
  it('계절적으로 정당한 주 2편(0·4일 전)은 소프트에 그친다 — 이분법 완화', () => {
    const s = computeSeriesScores([
      { species: null, activity: '전정', ts: daysAgo(0) },
      { species: null, activity: '전정', ts: daysAgo(4) },
    ], NOW);
    const g = gateForLabels({ species: '사과', activity: '전정' }, s);
    expect(g.level).toBe('soft');
    expect(s.activity.get('전정')!).toBeLessThan(SERIES_HARD_SINGLE);
    expect(s.activity.get('전정')!).toBeGreaterThanOrEqual(SERIES_SOFT);
  });
  it('점수 미달·무라벨은 none — 게이트 통과', () => {
    const s = computeSeriesScores([{ species: '포도', activity: null, ts: daysAgo(0) }], NOW);
    expect(gateForLabels({ species: '단풍', activity: '식재' }, s).level).toBe('none');
    expect(gateForLabels({ species: null, activity: null }, s).level).toBe('none');
  });
  it('조합 하드 임계는 상수와 정합(회귀 가드)', () => {
    expect(SERIES_HARD_COMBO).toBeLessThan(SERIES_HARD_SINGLE);
    expect(SERIES_SOFT).toBeLessThan(SERIES_HARD_COMBO);
  });
  it('N7 바닥선 — 격일 간격은 감쇠 합이 하드에 영원히 못 미치지만(리뷰 실측 점근합 2.06) 7일 3편이면 하드', () => {
    const s = computeSeriesScores([2, 4, 6].map((d) => ({ species: '포도', activity: null, ts: daysAgo(d) })), NOW);
    expect(s.species.get('포도')!).toBeLessThan(SERIES_HARD_SINGLE); // 감쇠만으로는 미달
    expect(gateForLabels({ species: '포도', activity: null }, s).level).toBe('hard'); // 바닥선이 차단
    expect(gateForLabels({ species: '포도', activity: null }, s).why).toContain('7일 3편');
  });
  it('N3 수종 바닥선 — 같은 수종이 3일 안에 1편이라도 있으면 하드(2026-08-27 올리브 3일 만 재등장)', () => {
    const now = new Date('2026-08-27T18:00:00+09:00').getTime();
    const sc = computeSeriesScores([{ species: '올리브나무', activity: '물주기', ts: '2026-08-24T21:01:00+09:00' }], now);
    expect(gateForLabels({ species: '올리브나무', activity: '화분' }, sc)).toMatchObject({ level: 'hard', key: '올리브나무', why: '수종 3일 1편' });
    // 4일이 지나면 3일 바닥선은 풀리고 감쇠 점수(1편 = 약 0.3)만 남아 none.
    const later = new Date('2026-08-29T06:00:00+09:00').getTime();
    expect(gateForLabels({ species: '올리브나무', activity: '화분' }, computeSeriesScores([{ species: '올리브나무', activity: '물주기', ts: '2026-08-24T21:01:00+09:00' }], later)).level).toBe('none');
  });
  it('N7 조합 바닥선 — 같은 조합 7일 2편이면 간격과 무관하게 하드', () => {
    const s = computeSeriesScores([
      { species: '포도', activity: '전정', ts: daysAgo(2) },
      { species: '포도', activity: '전정', ts: daysAgo(6) },
    ], NOW);
    expect(s.combo.get('포도×전정')!).toBeLessThan(SERIES_HARD_COMBO);
    expect(gateForLabels({ species: '포도', activity: '전정' }, s).level).toBe('hard');
  });
});

describe('fillLabelsFromKnown — 원장 키 포함 대조 복원(v1 상호 대조의 v2 판)', () => {
  const s = computeSeriesScores([
    { species: '포도', activity: '수확', ts: daysAgo(1) },
    { species: '블루베리', activity: null, ts: daysAgo(2) },
  ], NOW);
  it("라벨이 빈 후보라도 원장에 있는 계열이 텍스트에 포함되면 채운다('포도 수확 후 저장법'→포도·수확)", () => {
    expect(fillLabelsFromKnown('포도 수확 후 저장법', { species: null, activity: null }, s)).toEqual({ species: '포도', activity: '수확' });
  });
  it('이미 있는 라벨은 덮지 않고, 무관 텍스트는 null 유지', () => {
    expect(fillLabelsFromKnown('포도밭 이야기', { species: '머루', activity: null }, s).species).toBe('머루');
    expect(fillLabelsFromKnown('은행나무 단풍', { species: null, activity: null }, s)).toEqual({ species: null, activity: null });
  });
});
