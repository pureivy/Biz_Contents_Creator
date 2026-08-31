import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
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

// 한자어 치환(2026-08-27 말투 감사 권고 8) — 데이터 픽스처 대조.
// 활성(data/brand.yaml)과 레지스트리(data/brands/bionditree.yaml) 양쪽에 같은 목록이 있어야 한다
// (08-14 어휘 가드 전례: 한쪽만 고치면 무반영 — 주입은 활성만 읽고, 브랜드 재전환은 레지스트리로 덮어쓴다).
describe('avoidJargon 데이터 — 톤에서 튀는 한자어 치환(활성+레지스트리)', () => {
  const readAvoid = (rel: string): Array<{ term: string; use: string }> => {
    const raw = YAML.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')) as
      { avoidJargon?: Array<{ term: string; use: string }> } | null;
    return raw?.avoidJargon ?? [];
  };
  const ACTIVE = '../../data/brand.yaml';
  const REGISTRY = '../../data/brands/bionditree.yaml';
  // 2026-08-27 권고 8이 지정한 정확한 10쌍.
  const ADDED: Array<{ term: string; use: string }> = [
    { term: '흡즙', use: '즙을 빨아' },
    { term: '고착', use: '한자리에 붙어' },
    { term: '회차', use: '이번 차례' },
    { term: '미착근', use: '뿌리를 아직 못 내림' },
    { term: '부적합', use: '쓰기 어렵다' },
    { term: '완만히', use: '느슨하게 옆으로' },
    { term: '급수', use: '물 주기' },
    { term: '증발량', use: '마르는 양' },
    { term: '정지기', use: '쉬는 철' },
    { term: '확연히', use: '눈에 띄게' },
  ];

  it('활성 brand.yaml — 10쌍이 정확한 표기로 들어 있다', () => {
    const avoid = readAvoid(ACTIVE);
    for (const pair of ADDED) expect(avoid).toContainEqual(pair);
  });

  it('레지스트리 bionditree.yaml — 10쌍이 정확한 표기로 들어 있다', () => {
    const avoid = readAvoid(REGISTRY);
    for (const pair of ADDED) expect(avoid).toContainEqual(pair);
  });

  it('활성과 레지스트리의 avoidJargon 이 동일(한쪽만 수정 방지)', () => {
    expect(readAvoid(ACTIVE)).toEqual(readAvoid(REGISTRY));
  });

  it('normalizeBrand 캡(30) 안에 들어 정규화에서 잘리지 않는다', () => {
    const avoid = readAvoid(ACTIVE);
    expect(avoid.length).toBeLessThanOrEqual(30);
    expect(normalizeBrand({ name: '비온디트리', avoidJargon: avoid } as never)!.avoidJargon)
      .toEqual(avoid);
  });
});

// 상용어 허용 목록(2026-08-28) — 금지만 있고 허용이 없던 구조가 원예 상용어를 밀어낸 실측 대응.
// 발단: "전정"은 avoidJargon 에 없는데도 최근 글에서 0회가 되고 "1년에 가위를 몇 번 들 수 있는가"로 우회됐다.
describe('keepTerms — 상용어 허용 목록', () => {
  const readKeep = (rel: string): string[] => {
    const raw = YAML.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')) as
      { keepTerms?: string[] } | null;
    return raw?.keepTerms ?? [];
  };
  const ACTIVE = '../../data/brand.yaml';
  const REGISTRY = '../../data/brands/bionditree.yaml';
  // 사용자가 이름을 짚어 확정한 말 — 이게 빠지면 이 태스크가 무의미해진다.
  const MUST = ['전정', '가지치기', '시비', '접붙이기', '삽목', '활착'];

  it('활성 brand.yaml 과 레지스트리 양쪽에 있고 서로 같다', () => {
    // 활성만 고치고 레지스트리를 빠뜨리면 브랜드 전환 시 조용히 되돌아간다(기록된 전례).
    const a = readKeep(ACTIVE);
    const r = readKeep(REGISTRY);
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a)).toEqual(new Set(r));
    for (const t of MUST) expect(a).toContain(t);
  });

  it('금지 목록과 겹치지 않는다 — 같은 말이 "쓰지 마라"+"써라"로 동시에 나가면 가드가 무작위가 된다', () => {
    const raw = YAML.parse(fs.readFileSync(fileURLToPath(new URL(ACTIVE, import.meta.url)), 'utf-8')) as
      { keepTerms?: string[]; avoidJargon?: Array<{ term: string }> };
    const banned = new Set((raw.avoidJargon ?? []).map((a) => a.term));
    expect((raw.keepTerms ?? []).filter((t) => banned.has(t))).toEqual([]);
  });

  it('충돌하면 avoidJargon 이 이긴다 — 명시적 금지가 기본 허용보다 강하다', () => {
    const b = normalizeBrand({
      name: 'T', avoidJargon: [{ term: '전정', use: '가지치기' }], keepTerms: ['전정', '시비'],
    } as never);
    expect(b?.keepTerms).toEqual(["시비"]);
  });

  it('lexiconGuide 가 ⑧ 허용 블록을 내고, 우선순위를 못박는다', () => {
    const g = lexiconGuide([{ term: '동해', use: '겨울 추위 피해' }], ['전정', '시비']);
    expect(g).toContain('⑧');
    expect(g).toContain('전정, 시비');
    expect(g).toContain('①⑦·과사용 어휘 지침보다 이 항목이 우선한다');
    expect(g).toContain('동해→겨울 추위 피해'); // 금지 블록은 그대로 살아 있다
  });

  it('허용 목록이 없으면 ⑧ 블록 자체가 없다(회귀 0)', () => {
    const g = lexiconGuide([{ term: '동해', use: '겨울 추위 피해' }]);
    expect(g).not.toContain('⑧');
    expect(g).toContain('동해→겨울 추위 피해');
  });
});
