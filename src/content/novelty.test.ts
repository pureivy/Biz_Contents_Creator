import { describe, it, expect } from 'vitest';
import { bigramJaccard, keywordSimilar, titleSimilar, findSimilarContent, saturatedThemeMatches, saturatedThemes, expandTokens, type ExistingContent } from './novelty';

// 콘텐츠 신규성 가드(2026-07-15 사용자 원칙) — 신규 블로그·쇼츠·카드뉴스는 기존 콘텐츠와
// 주제·키워드가 유사하면 안 된다. 한글 복합어에 강하도록 문자 바이그램 자카드로 판정한다.

describe('bigramJaccard — 정규화(NFC·소문자·특수문자/공백 제거) 후 문자 2그램 자카드', () => {
  it('동일 문자열 = 1, 무관 문자열 ≈ 0', () => {
    expect(bigramJaccard('장마철 제습', '장마철 제습')).toBe(1);
    expect(bigramJaccard('장마철 제습', '가을 등산 준비물')).toBeLessThan(0.1);
  });
  it('표기 변형(숫자↔한글·공백)에 관대 — 같은 주제는 높은 점수', () => {
    expect(bigramJaccard('7월에 심는 꽃 5가지, 한여름 파종 성공법', '칠월에 심는 꽃 다섯 가지 한여름 파종 성공법')).toBeGreaterThan(0.5);
  });
});

describe('keywordSimilar — 동치·포함·고유사 키워드 차단', () => {
  it('정규화 동치·포함관계는 유사', () => {
    expect(keywordSimilar('장마철 제습', '장마철제습')).toBe(true);
    expect(keywordSimilar('장마철 제습', '장마철 제습기')).toBe(true); // 포함
  });
  it('짧은 우연 포함은 비유사(4자 미만 포함 무시), 다른 주제는 비유사', () => {
    expect(keywordSimilar('꽃', '꽃나무 관리')).toBe(false);
    expect(keywordSimilar('장마철 제습', '베란다 텃밭')).toBe(false);
  });
});

describe('titleSimilar — 주제 재탕 차단', () => {
  it('같은 주제의 문구 변형은 유사', () => {
    expect(titleSimilar('7월에 심는 꽃 5가지, 한여름 파종 성공법', '칠월에 심는 꽃 다섯 가지, 한여름 파종 성공법')).toBe(true);
    expect(titleSimilar('장마철 실내 제습 꿀팁, 곰팡이 없는 여름나기', '장마철 실내 습도 낮추는 법 — 제습기 없이도')).toBe(true);
  });
  it('다른 주제는 통과', () => {
    expect(titleSimilar('7월에 심는 꽃 5가지', '가을 텃밭 김장 배추 파종 시기')).toBe(false);
  });
});

describe('findSimilarContent — 후보 vs 기존 콘텐츠(제목·키워드) 대조', () => {
  const existing: ExistingContent[] = [
    { title: '7월에 심는 꽃 5가지, 한여름 파종 성공법', keyword: '7월에 심는 꽃', kind: '블로그' },
    { title: '장마철 베란다 텃밭 배수 관리', keyword: '베란다 텃밭 배수', kind: '쇼츠' },
  ];
  it('유사 제목·키워드를 근거와 함께 반환(점수 내림차순)', () => {
    const m = findSimilarContent({ title: '칠월에 심는 꽃 다섯 가지 총정리', keyword: '7월에 심는 꽃 추천' }, existing);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0]!.kind).toBe('블로그');
    expect(['keyword', 'title']).toContain(m[0]!.via);
  });
  it('신규 주제는 빈 배열', () => {
    expect(findSimilarContent({ title: '8월 화분 물주기 자동화 도구 3종', keyword: '자동 급수기' }, existing)).toEqual([]);
  });
  it('키워드 없는 후보는 제목만으로 판정', () => {
    expect(findSimilarContent({ title: '장마철 베란다 텃밭 배수 관리법' }, existing).length).toBeGreaterThan(0);
  });
});

// 리뷰 실재현 오탐(2026-07-15) — 범용 꼬리토큰('관리·방법·총정리')만 겹치는 무관 주제가 차단되면 안 된다.
describe('titleSimilar — 범용 토큰 오탐 방지(스톱토큰)', () => {
  it('범용 꼬리만 겹치는 무관 주제는 통과', () => {
    expect(titleSimilar('여름 장미 관리 방법 총정리', '겨울 동백 관리 방법 총정리')).toBe(false);
    expect(titleSimilar('실내 다육이 물주기 방법 총정리', '베란다 허브 물주기 방법 총정리')).toBe(false);
  });
  it('핵심 토큰 3개 겹침은 여전히 유사(스톱토큰 제외 후)', () => {
    expect(titleSimilar('장마철 실내 제습 꿀팁, 곰팡이 없는 여름나기', '장마철 실내 습도 낮추는 법 — 제습기 없이도')).toBe(true);
  });
});

// 개념 포화(2026-07-23 감사) — bigramJaccard 표면 유사론 0쌍이나 실제론 '여름·물주기' 소재로 쏠린 코퍼스를 잡는다.
describe('saturatedThemeMatches — 표면 문자열론 안 겹쳐도 소재 쏠림(개념 포화) 감지', () => {
  const existing: ExistingContent[] = [
    { title: '여름화분물주기 속흙 3단계 체크법으로 과습 방지하기', keyword: '여름화분물주기', kind: '블로그' },
    { title: '폭염 나무 물주기, 이른 아침 깊이 급수 완벽 가이드', keyword: '폭염 나무 물주기', kind: '블로그' },
    { title: '장마철나무관리 물을 빼야 나무가 산다', keyword: '장마철나무관리', kind: '블로그' },
    { title: '반려동물 안전한 식물 5가지', keyword: '반려동물 안전한 식물', kind: '블로그' },
  ];
  it('같은 소재(물주기·여름·과습)로 쏠린 후보는 매치', () => {
    const m = saturatedThemeMatches({ title: '식물 고사 막는 법, 과습 vs 건조 진단부터 물주기 여름', keyword: '물주기' }, existing);
    expect(m.length).toBeGreaterThan(0);
  });
  it('완전히 다른 소재는 빈 배열(소재 신선)', () => {
    expect(saturatedThemeMatches({ title: '겨울 김장 배추 절이기 소금 비율', keyword: '김장 배추' }, existing)).toEqual([]);
  });
});

describe('saturatedThemes — 여러 편에 겹치는 포화 소재어(빈도순)', () => {
  it('minPieces 이상 편에 등장하는 내용어만 반환', () => {
    const existing: ExistingContent[] = [
      { title: '여름 물주기 화분 과습', kind: '블로그' },
      { title: '여름 물주기 나무 급수', kind: '블로그' },
      { title: '여름 채소 베란다 수확', kind: '블로그' },
    ];
    const toks = saturatedThemes(existing, 2).map((s) => s.token);
    expect(toks).toContain('여름');    // 3편
    expect(toks).toContain('물주기');  // 2편
    expect(toks).not.toContain('과습'); // 1편만 → 미포화
  });
});

describe('expandTokens / saturatedThemes — 한국어 합성어 축 탐지(2026-08-01)', () => {
  const STEMS = ['묘목', '나무'];
  it('합성어 안의 도메인 어간을 추가 크레딧 — 감나무묘목 → 묘목·나무', () => {
    const t = expandTokens('감나무묘목 고르기', STEMS);
    expect(t.has('감나무묘목')).toBe(true);
    expect(t.has('묘목')).toBe(true);
    expect(t.has('나무')).toBe(true);
  });
  it('서로 다른 합성어들이 공통 축으로 포화 탐지된다 — 종전엔 각각 1회로 흩어져 안 보였다', () => {
    const ex = [
      { title: '감나무묘목 고르기', kind: '블로그' as const },
      { title: '신비복숭아묘목 접목부 확인', kind: '블로그' as const },
      { title: '정원수묘목 고르는 법', kind: '블로그' as const },
    ];
    expect(saturatedThemes(ex, 3, STEMS).some((s) => s.token === '묘목' && s.count === 3)).toBe(true);
  });
  it('어간 미설정 브랜드는 확장 없음(종전 동작 보존) — 업종어를 전 브랜드에 강요하지 않는다', () => {
    expect([...expandTokens('감나무묘목 고르기')]).toEqual(['감나무묘목', '고르기']);
    const ex = [
      { title: '감나무묘목 고르기', kind: '블로그' as const },
      { title: '신비복숭아묘목 접목부 확인', kind: '블로그' as const },
      { title: '정원수묘목 고르는 법', kind: '블로그' as const },
    ];
    expect(saturatedThemes(ex, 3).some((s) => s.token === '묘목')).toBe(false);
  });
  it('어간보다 짧거나 같은 토큰은 자기 자신만 — 과잉 확장 없음', () => {
    expect([...expandTokens('묘목', STEMS)]).toEqual(['묘목']);
  });
});

describe('saturatedThemeMatches — 합성어 어간이 기각 검사에도 적용(2026-08-01 회귀)', () => {
  const STEMS = ['묘목', '나무'];
  const ex = [{ title: '신비복숭아묘목 접목부와 뿌리로 고르는 법', kind: '블로그' as const }];
  it('어간 없이는 통과 — 감나무묘목/신비복숭아묘목이 서로 남남이라 예고가 같은 축을 복제했다', () => {
    expect(saturatedThemeMatches({ title: '감나무묘목 상자 받으면 뿌리·접목부 확인법' }, ex, 3)).toHaveLength(0);
  });
  it('어간 적용 시 차단 — 공통 축(묘목)+접목부+뿌리로 3 이상', () => {
    const m = saturatedThemeMatches({ title: '감나무묘목 상자 받으면 뿌리·접목부 확인법' }, ex, 3, STEMS);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0]!.score).toBeGreaterThanOrEqual(3);
  });
  it('다른 축 주제는 어간을 써도 통과 — 과잉 차단 없음', () => {
    expect(saturatedThemeMatches({ title: '배롱나무 가을 식재법' }, ex, 3, STEMS)).toHaveLength(0);
  });
});
