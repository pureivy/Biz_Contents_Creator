import { describe, it, expect } from 'vitest';
import { splitTwoLines, derivePoints, ensureKeywordInCopy, buildThumbnailPrompt } from './shortsThumbnail';

describe('splitTwoLines', () => {
  it('단어(공백) 경계에서만 분할 — 어떤 단어도 중간에서 쪼개지 않음', () => {
    for (const t of ['하스카프베리 재배 두 품종', '물 더 주면 나무 죽어요', '폭염 나무 물주기 급수법']) {
      const r = splitTwoLines(t);
      // 두 줄을 다시 합치면 원본 단어 배열과 정확히 일치(= 어떤 단어도 두 줄에 걸쳐 쪼개지지 않음)
      expect([r.line1, r.line2].filter(Boolean).join(' ').split(/\s+/)).toEqual(t.split(/\s+/));
    }
  });
  it('첫 단어가 길어도 통째로 유지(하스카프베리 → 하스카/프베리 금지)', () => {
    const r = splitTwoLines('하스카프베리 재배 두 품종이 필수');
    expect(r.line1.split(/\s+/)[0]).toBe('하스카프베리');
  });
  it('단어 하나면 쪼개지 않고 한 줄(line2 빈값)', () => {
    expect(splitTwoLines('하스카프베리')).toEqual({ line1: '하스카프베리', line2: '' });
  });
});

describe('ensureKeywordInCopy', () => {
  it('키워드가 어느 줄에도 없으면 line1 을 키워드로 강제, 기존 훅은 line2 승계', () => {
    // 실측 재현(2026-07-31): short_69d9fe4166 — "블루베리나무화분" 탈락 케이스
    expect(ensureKeywordInCopy({ line1: '묘목 라벨', line2: '세 가지 확인', points: [] }, '블루베리나무화분'))
      .toEqual({ line1: '블루베리나무화분', line2: '세 가지 확인', points: [] });
  });
  it('이미 포함(어느 줄이든)이면 무변경', () => {
    const c1 = { line1: '블루베리나무화분', line2: '라벨 확인', points: ['a'] };
    expect(ensureKeywordInCopy(c1, '블루베리나무화분')).toBe(c1);
    const c2 = { line1: '라벨 확인', line2: '블루베리나무화분', points: [] };
    expect(ensureKeywordInCopy(c2, '블루베리나무화분')).toBe(c2);
  });
  it('키워드 미지정이면 무변경, line2 빈 카피는 line1 을 훅으로 승계', () => {
    const c = { line1: '묘목 라벨', line2: '', points: [] };
    expect(ensureKeywordInCopy(c, undefined)).toBe(c);
    expect(ensureKeywordInCopy(c, '배롱나무')).toEqual({ line1: '배롱나무', line2: '묘목 라벨', points: [] });
  });
  it('긴 키워드(16자 초과)도 자르지 않음 — 잘린 키워드가 그려지면 정확 표기 불변식 위반(실측 최장 14자, 상한 24)', () => {
    const kw = '경상북도경제진흥원 지원사업 총정리'; // 18자
    expect(ensureKeywordInCopy({ line1: '지원 안내', line2: '신청 방법', points: [] }, kw).line1).toBe(kw);
  });
});

describe('buildThumbnailPrompt — 밑줄 위계', () => {
  it('2줄 — 밑줄은 2줄(노랑) 아래에만, 1줄 라벨 줄에는 긋지 않음', () => {
    const p = buildThumbnailPrompt({ line1: '블루베리나무화분', line2: '라벨 확인', points: ['계열 확인'] });
    expect(p).toContain('2줄(노랑) 아래에만');
    expect(p).toContain('1줄(크림 화이트 라벨 줄) 아래에는 긋지 않는다');
    expect(p).toContain("'블루베리나무화분'");
  });
});

describe('derivePoints', () => {
  it('설명을 짧은 구 2~3개로 — 좌하단 포인트 폴백', () => {
    const p = derivePoints('장마철엔 물빼기가 먼저. 뿌리 상하는 진짜 이유. 침수목 살리는 순서.');
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p.every((x) => x.length >= 4 && x.length <= 22)).toBe(true);
  });
  it('빈 설명·초장문은 제외 → 빈 배열 가능', () => {
    expect(derivePoints('')).toEqual([]);
    expect(derivePoints('가나')).toEqual([]); // 4자 미만 제외
  });
});
