import { describe, it, expect } from 'vitest';
import { seasonalContext } from './solarTerms';

// 절기 시의성 신호(2026-08-07 사용자 제안) — 두뇌가 날짜를 몰라 '시의성 고려' 지시가 공회전하던
// 공백을 메운다. 고정 날짜 표(±1일 오차 무해) 기반 순수 함수.
describe('seasonalContext — 오늘 날짜의 절기 컨텍스트 한 줄', () => {
  it('절기 당일 — 입추(8/7)면 입추가 현재, 다음은 처서(8/23)', () => {
    const s = seasonalContext(new Date(2026, 7, 7)); // 8월 7일
    expect(s).toContain('8월 7일');
    expect(s).toContain('입추');
    expect(s).toContain('처서');
    expect(s).toContain('8/23');
    expect(s).not.toContain('+'); // 당일은 경과일 표기 없음
  });

  it('절기 전날 — 8/6이면 아직 대서가 현재', () => {
    const s = seasonalContext(new Date(2026, 7, 6));
    expect(s).toContain('대서');
    expect(s).toContain('입추');
  });

  it('경과일 표기 — 8/10이면 입추 +3일', () => {
    const s = seasonalContext(new Date(2026, 7, 10));
    expect(s).toContain('입추');
    expect(s).toContain('+3일');
  });

  it('연초 랩어라운드 — 1/2는 전년 동지가 현재, 다음은 소한(1/5)', () => {
    const s = seasonalContext(new Date(2026, 0, 2));
    expect(s).toContain('동지');
    expect(s).toContain('소한');
    expect(s).toContain('1/5');
  });

  it('연말 랩어라운드 — 12/25는 동지가 현재, 다음은 이듬해 소한(1/5)', () => {
    const s = seasonalContext(new Date(2026, 11, 25));
    expect(s).toContain('동지');
    expect(s).toContain('소한');
    expect(s).toContain('1/5');
  });

  it('의미 문구 동봉 — 입추엔 가을 언급', () => {
    expect(seasonalContext(new Date(2026, 7, 7))).toContain('가을');
  });
});
