import { describe, it, expect } from 'vitest';
import { kstDate, kstNowKo } from './time';

describe('KST 시간 헬퍼 — Asia/Seoul 고정', () => {
  it('kstDate — UTC 인스턴트를 KST 달력날짜로(아침 하루 밀림 회피)', () => {
    expect(kstDate(new Date('2026-06-22T15:30:00Z'))).toBe('2026-06-23'); // KST 00:30 → 다음날
    expect(kstDate(new Date('2026-06-22T14:59:00Z'))).toBe('2026-06-22'); // KST 23:59 → 당일
    expect(kstDate(new Date('2026-06-23T08:30:00Z'))).toBe('2026-06-23'); // KST 17:30
  });

  it('kstDate — YYYY-MM-DD 포맷', () => {
    expect(kstDate(new Date('2026-01-05T03:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('kstNowKo — 한국어 풀 표기(KST)', () => {
    const s = kstNowKo(new Date('2026-06-23T08:30:00Z')); // KST 2026-06-23(화) 17:30
    expect(s).toContain('2026년');
    expect(s).toContain('6월');
    expect(s).toContain('23일');
    expect(s).toContain('화요일');
    expect(s).toContain('17시');
    expect(s).toContain('30분');
    expect(s).toContain('(KST)');
  });

  it('kstNowKo — 자정 직후 UTC 전날이어도 KST 날짜로', () => {
    const s = kstNowKo(new Date('2026-06-22T15:10:00Z')); // KST 2026-06-23 00:10
    expect(s).toContain('23일');
    expect(s).toContain('00시');
  });
});
