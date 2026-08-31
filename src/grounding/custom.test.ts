import { describe, it, expect } from 'vitest';
import { isSafeRegexSource } from './custom';

describe('isSafeRegexSource — ReDoS 위험 정규식 거부', () => {
  it('중첩 수량자(치명적 백트래킹) 거부', () => {
    expect(isSafeRegexSource('(a+)+')).toBe(false);
    expect(isSafeRegexSource('(a*)*')).toBe(false);
    expect(isSafeRegexSource('(.+)+$')).toBe(false);
  });
  it('200자 초과·비문자열 거부', () => {
    expect(isSafeRegexSource('a'.repeat(201))).toBe(false);
    expect(isSafeRegexSource(undefined as unknown as string)).toBe(false);
  });
  it('정상 패턴 허용', () => {
    expect(isSafeRegexSource('<title>([^<]+)</title>')).toBe(true);
    expect(isSafeRegexSource('\\d{1,3}')).toBe(true);
  });
});
