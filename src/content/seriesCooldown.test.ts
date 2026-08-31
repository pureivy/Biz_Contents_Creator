import { describe, it, expect } from 'vitest';
import { seriesStems, fallbackSeriesLabels } from './seriesCooldown';

describe('seriesStems — 수종 어간 추출(순수)', () => {
  it("'XX나무' 어간을 뽑고 공백을 무시한다(포도나무→포도, 블루베리 나무→블루베리)", () => {
    expect(seriesStems('포도나무 가지치기, 제한 가지')).toEqual(['포도']);
    expect(seriesStems('블루베리 나무 키우기 베란다')).toEqual(['블루베리']);
  });
  it('총칭 어간(과실·유실·조경 등)과 단독 나무는 계열이 아니다', () => {
    expect(seriesStems('과실나무 전정, 어린 나무 주지')).toEqual([]);
    expect(seriesStems('나무 물주기')).toEqual([]);
  });
  it("'XX베리' 전체어도 계열이다 — 나무 미표기 관용", () => {
    expect(seriesStems('블루베리 꽃눈 확인법')).toEqual(['블루베리']);
    expect(seriesStems('하스카프베리 재배, 두 품종')).toEqual(['하스카프베리']);
  });
  it('단음절 어간 수종은 전체어를 키로 유지한다(감나무·소나무 — 리뷰 확정 메이저)', () => {
    expect(seriesStems('감나무 묘목 고르기')).toEqual(['감나무']);
    expect(seriesStems('소나무 전정 시기')).toEqual(['소나무']);
  });
});

describe('fallbackSeriesLabels — 결정적 라벨 폴백(LLM 분류 실패 시의 바닥)', () => {
  it('수종·행위를 함께 뽑고, 행위는 동의어 표준형(terms[0])으로 정규화한다', () => {
    expect(fallbackSeriesLabels('포도나무 가지 정리, 9월엔')).toEqual({ species: '포도', activity: '전정' });
    expect(fallbackSeriesLabels('올리브나무 물주기, 과습 주의')).toEqual({ species: '올리브', activity: '물주기' });
  });
  it("행위 없는 제목은 activity null, '세 가지' 일반어는 오탐하지 않는다", () => {
    expect(fallbackSeriesLabels('배롱나무 꽃 안 피는 이유')).toEqual({ species: '배롱', activity: null });
    expect(fallbackSeriesLabels('묘목 고르는 세 가지 기준').activity).not.toBe('전정');
  });
});
