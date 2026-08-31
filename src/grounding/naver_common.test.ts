import { describe, it, expect } from 'vitest';
import { seedKeyword } from './naver_common';

// 시드 키워드 추출 — 지시문/긴 제목이 통째로 검색 API 시드가 되던 실사고 회귀 방지.
describe('seedKeyword', () => {
  it('지시문에서 핵심 명사구만 남긴다(어미·조사 꼬리 제거)', () => {
    expect(seedKeyword('여름 제습기 추천 키워드의 검색량과 트렌드를 조사하라')).toBe('여름 제습기');
  });
  it('콤마 뒤 부연은 버리고 앞절만 쓴다', () => {
    expect(seedKeyword('장마철 실내 제습, 제습기 없이 습도 낮추는 5가지')).toBe('장마철 실내 제습');
  });
  it('짧은 키워드는 그대로 보존한다', () => {
    expect(seedKeyword('에어컨 전기요금')).toBe('에어컨 전기요금');
    expect(seedKeyword('제습기')).toBe('제습기');
  });
  it('하우투 접미(방법·추천 등)를 제거한다', () => {
    expect(seedKeyword('제습기 청소 방법')).toBe('제습기 청소');
  });
  it('긴 제목은 앞 3어절로 캡한다', () => {
    expect(seedKeyword('여름 전기요금 아끼는 에어컨 사용법')).toBe('여름 전기요금 아끼는');
  });
  it('전부 잘려도 빈 문자열은 반환하지 않는다', () => {
    expect(seedKeyword('조사하라')).toBe('조사하라');
  });
});
