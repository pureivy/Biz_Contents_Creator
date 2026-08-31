import { describe, it, expect } from 'vitest';
import { toVolume, fmtVolume } from './naver_searchad';

// 실사고(2026-07-28): 네이버 키워드도구가 월 10 미만 검색량을 "< 10" 문자열로 주는데, 옛 코드가
// 숫자만 뽑아 10 으로 파싱해 "월 20회(PC10+모바일10)" 같은 가짜 실측값을 만들었다 — SEO 전략가가
// 이 가짜 수치를 근거로 사실상 검색 안 되는 표현을 계속 골랐다. toVolume/fmtVolume 이 그 회귀 방지.
describe('toVolume', () => {
  it('"< 10" 문자열 → 0 + approx(정확값 아님을 보존)', () => {
    expect(toVolume('< 10')).toEqual({ value: 0, approx: true });
    expect(toVolume('<10')).toEqual({ value: 0, approx: true }); // 공백 유무 이형
  });
  it('일반 숫자 문자열 → 그대로 파싱, approx=false', () => {
    expect(toVolume('1,234')).toEqual({ value: 1234, approx: false });
    expect(toVolume('50')).toEqual({ value: 50, approx: false });
  });
  it('숫자 타입 입력 → 그대로, approx=false', () => {
    expect(toVolume(300)).toEqual({ value: 300, approx: false });
  });
  it('결측·이형 → 0, approx=false(파싱 실패와 "10 미만"을 혼동하지 않는다)', () => {
    expect(toVolume(undefined)).toEqual({ value: 0, approx: false });
    expect(toVolume(null)).toEqual({ value: 0, approx: false });
  });
});

describe('fmtVolume', () => {
  it('approx=true → 숫자 대신 "10미만"(가짜 정밀도 금지)', () => {
    expect(fmtVolume(0, true)).toBe('10미만');
  });
  it('approx=false → 천단위 구분 숫자', () => {
    expect(fmtVolume(14240, false)).toBe('14,240');
    expect(fmtVolume(0, false)).toBe('0');
  });
});
