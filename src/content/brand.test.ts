import { describe, it, expect } from 'vitest';
import { normalizeBrand, brandContext, brandProductLines, brandSeedKeywords, brandSlug, isSafeBrandSlug, brandFileSuffixFor, bannedTopicTerms, offBrandTerm, lexiconGuide } from './brand';

// 브랜드 프로필 — 정규화·주입 블록(순수 함수) 회귀 방지.
describe('normalizeBrand', () => {
  it('name 이 없으면 null(미설정)', () => {
    expect(normalizeBrand(null)).toBeNull();
    expect(normalizeBrand({})).toBeNull();
    expect(normalizeBrand({ name: '  ' })).toBeNull();
  });
  it('제품은 name 필수·트림·캡', () => {
    const b = normalizeBrand({
      name: ' 한빛수제청 ',
      products: [{ name: ' 유자청 ', features: ' 국산 유자 100% ' }, { name: '' }, { name: '자몽청' }],
    })!;
    expect(b.name).toBe('한빛수제청');
    expect(b.products.map((p) => p.name)).toEqual(['유자청', '자몽청']);
    expect(b.products[0]!.features).toBe('국산 유자 100%');
  });
  it('배열 필드는 빈 항목 제거', () => {
    const b = normalizeBrand({ name: 'X', products: [], seedKeywords: ['수제청', '', ' 선물세트 '], banned: [' 과장 광고 '] })!;
    expect(b.seedKeywords).toEqual(['수제청', '선물세트']);
    expect(b.banned).toEqual(['과장 광고']);
  });
});

describe('brandContext', () => {
  it('미설정이면 빈 문자열(기존 동작 불변 보장)', () => {
    expect(brandContext(null)).toBe('');
  });
  it('설정 시 업체·제품·타겟·금지를 포함한 블록', () => {
    const b = normalizeBrand({
      name: '한빛수제청', industry: '식품', products: [{ name: '유자청', features: '국산 유자 100%' }],
      audience: '3040 주부', tone: '친근한 존댓말', banned: ['최고'], seedKeywords: ['수제청'],
    })!;
    const ctx = brandContext(b);
    expect(ctx).toContain('[브랜드 컨텍스트');
    expect(ctx).toContain('한빛수제청');
    expect(ctx).toContain('유자청 — 국산 유자 100%');
    expect(ctx).toContain('3040 주부');
    expect(ctx).toContain('금지: 최고');
    expect(ctx).toContain('노골적 광고 금지');
  });
});

describe('isSafeBrandSlug — 경로 탈출 차단', () => {
  it('정상 슬러그(한글 포함) 허용', () => {
    expect(isSafeBrandSlug('국민원예종묘')).toBe(true);
    expect(isSafeBrandSlug('hanbit-청')).toBe(true);
  });
  it('경로 문자·빈 값·과길이 거부', () => {
    for (const bad of ['../secrets', '..', 'a/b', 'a\\b', 'a.yaml', '', 'x'.repeat(65)]) {
      expect(isSafeBrandSlug(bad)).toBe(false);
    }
  });
  it('brandSlug 산출물은 항상 안전', () => {
    for (const name of ['한빛 수제청!', '../../etc', 'A.B/C\\D', '  ']) {
      expect(isSafeBrandSlug(brandSlug(name))).toBe(true);
    }
  });
});

describe('보조 헬퍼', () => {
  const b = normalizeBrand({ name: 'X', products: [{ name: 'A' }, { name: 'B' }], seedKeywords: ['k1'] })!;
  it('제품 라인 목록', () => expect(brandProductLines(b)).toEqual(['A', 'B']));
  it('시드 키워드', () => expect(brandSeedKeywords(b)).toEqual(['k1']));
  it('null 안전', () => {
    expect(brandProductLines(null)).toEqual([]);
    expect(brandSeedKeywords(null)).toEqual([]);
  });
});

describe('brandFileSuffixFor — 명시 슬러그 접미(순수)', () => {
  it("undefined·''(범용) → '', 슬러그 → '-슬러그'", () => {
    expect(brandFileSuffixFor(undefined)).toBe('');
    expect(brandFileSuffixFor('')).toBe('');
    expect(brandFileSuffixFor('브랜드a')).toBe('-브랜드a');
  });
});

describe('brandSlug — NFC 정규화(macOS/iCloud NFD 파일명 대비)', () => {
  it('NFD 입력도 NFC 슬러그로 수렴 — 이름 유래·파일명 유래 슬러그 동치', () => {
    const nfc = '국민원예종묘';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc); // 전제: 두 표현이 실제로 다른 바이트
    expect(brandSlug(nfd)).toBe(brandSlug(nfc));
    expect(brandSlug(nfd)).toBe(nfc.toLowerCase());
  });
});

describe('브랜드 소재 범위 게이트(2026-07-31 정체성 각인) — banned 프로즈 → 토큰 → 하드 대조', () => {
  const b = normalizeBrand({
    name: 'bionditree',
    banned: [
      '채소·텃밭 작물 주제(배추·상추·토마토·가을채소·베란다 채소 등) — 나무·묘목 브랜드와 무관',
      '화초·구근·꽃 모종 주제(튤립·수선화·페튜니아·제라늄 등)',
      '다육·선인장·실내 관엽 등 나무가 아닌 화분 식물 주제',
    ],
  })!;

  it('토큰 도출 — 금지 소재어는 뽑고, 브랜드 정상 소재어(나무·묘목·식물·화분·꽃)는 스톱워드로 제외', () => {
    const terms = bannedTopicTerms(b);
    for (const t of ['배추', '상추', '토마토', '튤립', '다육', '구근', '텃밭', '채소']) expect(terms).toContain(t);
    for (const t of ['나무', '묘목', '식물', '화분', '꽃', '주제', '브랜드']) expect(terms).not.toContain(t);
  });

  it('오프브랜드 제목·키워드는 걸리고(공백 무시), 나무·묘목 주제는 통과', () => {
    expect(offBrandTerm('가을 배추 모종 고르는 법', b)).toBe('배추');
    expect(offBrandTerm('튤립 · 수선화 구근 심기', b)).toBeTruthy();
    expect(offBrandTerm('다육이 여름 물주기', b)).toBe('다육');
    expect(offBrandTerm('배롱나무 꽃, 백일의 비밀', b)).toBeNull();
    expect(offBrandTerm('블루베리나무 묘목 고르는 법', b)).toBeNull();
    expect(offBrandTerm('베란다 화분에서 단풍나무 키우기', b)).toBeNull();
    expect(offBrandTerm('', b)).toBeNull();
  });

  it('banned 비면 게이트 무동작(범용 브랜드 안전)', () => {
    const nb = normalizeBrand({ name: 'x' })!;
    expect(bannedTopicTerms(nb)).toEqual([]);
    expect(offBrandTerm('배추 이야기', nb)).toBeNull();
  });
});

// 어휘 가드(2026-08-08 어휘 감사) — avoidJargon 파싱 + 린트(2차 방어).
describe('avoidJargon 파싱 + lintLexicon', () => {
  it('avoidJargon — {term,use} 배열 파싱, 불완전 항목 제외', async () => {
    const { normalizeBrand } = await import('./brand');
    const nb = normalizeBrand({ name: 'x', avoidJargon: [
      { term: '방조', use: '새 그물 씌우기' },
      { term: '', use: '무효' },
      { term: '무효만' },
    ] } as never)!;
    expect(nb.avoidJargon).toEqual([{ term: '방조', use: '새 그물 씌우기' }]);
  });

  it('lintLexicon — 본문에 든 함정어를 찾는다(복합어 후행 결합 포함)', async () => {
    const { lintLexicon } = await import('./brand');
    const avoid = [{ term: '방조', use: '새 그물 씌우기' }, { term: '해토', use: '땅이 풀린 뒤' }];
    const hits = lintLexicon('지지와 방조망이 필수입니다. 봄은 해토 직후가 좋습니다.', avoid);
    expect(hits.map((h) => h.term)).toEqual(['방조', '해토']);
  });

  it('lintLexicon — 한글이 앞에 붙은 다른 단어는 오탐하지 않는다(감동해→동해 X)', async () => {
    const { lintLexicon } = await import('./brand');
    const avoid = [{ term: '동해', use: '겨울 추위 피해' }];
    expect(lintLexicon('그 장면에 감동해서 오래 봤습니다', avoid)).toEqual([]);
    expect(lintLexicon('겨울 동해 피해가 큽니다', avoid).map((h) => h.term)).toEqual(['동해']);
  });

  it('lintLexicon — 목록 없으면 빈 배열', async () => {
    const { lintLexicon } = await import('./brand');
    expect(lintLexicon('아무 본문', undefined)).toEqual([]);
  });
});
