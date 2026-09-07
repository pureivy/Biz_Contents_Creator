import { describe, it, expect } from 'vitest';
import { repeatedlyWrong, applyCopySwap, splitTwoLines, derivePoints, ensureKeywordInCopy, buildThumbnailPrompt } from './shortsThumbnail';

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

describe('repeatedlyWrong — 반복해서 깨진 낱말(순수)', () => {
  it('두 번 이상 나온 낱말만 — 한 번은 우연일 수 있다', () => {
    expect(repeatedlyWrong([['짙은'], ['짙은']])).toEqual(['짙은']);
    expect(repeatedlyWrong([['짙은'], ['옆가지']])).toEqual([]);
  });
  it('한 회차에 같은 낱말이 여러 번 나와도 한 번으로 센다', () => {
    expect(repeatedlyWrong([['짙은', '짙은'], ['다른말']])).toEqual([]);
  });
  it('세 낱말 중 반복된 것만 고른다', () => {
    expect(repeatedlyWrong([['짙은', '떼면'], ['짙은', '자랍니다']])).toEqual(['짙은']);
  });
  it('빈 입력은 빈 결과', () => {
    expect(repeatedlyWrong([])).toEqual([]);
    expect(repeatedlyWrong([[], []])).toEqual([]);
  });
});

describe('applyCopySwap — 낱말 교체(순수)', () => {
  const copy = { line1: '황금사철나무 초록가지', line2: '자르는 위치는?', points: ['짙은 초록가지가 옆가지 눌러요', '잎만 떼면 다시 자랍니다'] };

  it('points 안의 낱말을 바꾼다 — 실측 사례 그대로', () => {
    const out = applyCopySwap(copy, new Map([['짙은', '진한']]));
    expect(out.points[0]).toBe('진한 초록가지가 옆가지 눌러요');
    expect(out.points[1]).toBe('잎만 떼면 다시 자랍니다');
  });

  it('line1·line2 는 안 바꾼다 — 키워드 정확 표기와 영상 캘리가 걸려 있다', () => {
    const out = applyCopySwap({ ...copy, line2: '짙은 곳을 자른다' }, new Map([['짙은', '진한']]));
    expect(out.line1).toBe(copy.line1);
    expect(out.line2).toBe('짙은 곳을 자른다'); // 영상 상단 캘리와 어긋나면 안 된다
  });

  it('빈 표면 원본 그대로', () => {
    expect(applyCopySwap(copy, new Map())).toBe(copy);
  });

  it('같은 말로 바꾸라거나 빈 값이면 무시', () => {
    const out = applyCopySwap(copy, new Map([['짙은', '짙은'], ['옆가지', '  ']]));
    expect(out.points[0]).toBe('짙은 초록가지가 옆가지 눌러요');
  });

  it('한 낱말이 여러 번 나오면 전부 바꾼다', () => {
    const c = { ...copy, points: ['짙은 가지와 짙은 잎'] };
    expect(applyCopySwap(c, new Map([['짙은', '진한']])).points[0]).toBe('진한 가지와 진한 잎');
  });
});
