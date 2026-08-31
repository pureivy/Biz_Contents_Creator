import { describe, it, expect, afterEach } from 'vitest';
import { inheritedClaims, formatInherited, salientTokens } from './inheritedClaims';

// 고정 표본 — 실사고(piece_8d9113cdde 블로그 hold ↔ short_b894bf71fb 파생 pass)의 실제 문자열.
// 원문 게이트가 '근거 미확인'으로 분류한 손질 시기가 파생 숏폼 화면 목록에 그대로 떴다.
const CLAIM_회양목 = '회양목 - 겨울 잎 남습니다, 새순이 굳는 초여름에 한 번';
const CLAIM_향나무 = '향나무·측백류 - 겨울 잎 남습니다, 봄에 한 번, 늦여름에 한 번';
const CLAIM_질소 = '늦여름 이후에는 질소 성분이 많은 거름을 줄입니다.';

describe('inheritedClaims — 실사고 고정 표본', () => {
  it('재작성된 파생 문구에서도 같은 주장을 잡는다(복붙이 아니다)', () => {
    // 실측 유사도 38~56% — 문자열 포함 검사로는 절대 안 걸린다.
    const hits = inheritedClaims([CLAIM_회양목, CLAIM_향나무], [
      { field: '씬5 목록', text: '회양목: 초여름 한 번 / 쥐똥나무: 두 번 / 측백류: 봄·늦여름 두 번' },
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.field).toBe('씬5 목록');
    expect(hits[0]!.tokens).toEqual(expect.arrayContaining(['회양목', '초여름']));
  });

  it('원문 문장이 그대로 들어가도 잡는다', () => {
    expect(inheritedClaims([CLAIM_질소], [{ field: '캡션', text: '늦여름 이후에는 질소 거름을 줄이세요' }])).toHaveLength(1);
  });
});

describe('inheritedClaims — 과차단 방지', () => {
  const flagged = [CLAIM_회양목];
  // 토큰 1개만 겹치는 것은 '같은 주장'이 아니다 — 같은 나무의 다른 이야기까지 걸면 가드가 소음이 된다.
  it.each([
    ['같은 수종의 다른 이야기', '회양목은 낮은 경계에 잘 어울려요'],
    ['수종명만 언급', '회양목'],
    ['시기어만 겹침', '초여름에 물을 자주 줍니다'],
    ['완전 무관', '물은 흠뻑 주고 간격을 띄우세요'],
  ])('%s → 걸리지 않는다', (_label, text) => {
    expect(inheritedClaims(flagged, [{ field: 'X', text }])).toEqual([]);
  });

  it('빈 입력은 조용히 통과', () => {
    expect(inheritedClaims([], [{ field: 'X', text: '회양목 초여름 한 번' }])).toEqual([]);
    expect(inheritedClaims(flagged, [])).toEqual([]);
    expect(inheritedClaims(flagged, [{ field: 'X', text: '   ' }])).toEqual([]);
  });

  it('토큰이 빈약한 주장은 아무것과도 엮이지 않는다', () => {
    // "그렇습니다" 류가 남아 있으면 어떤 텍스트와도 우연히 걸린다 — MIN_SHARED 미만이면 건너뛴다.
    expect(inheritedClaims(['그렇습니다.'], [{ field: 'X', text: '회양목 초여름 한 번' }])).toEqual([]);
  });
});

describe('salientTokens', () => {
  it('조사를 떼어 같은 토큰으로 만든다', () => {
    const t = salientTokens('회양목은 초여름에 다듬어요');
    expect(t.has('회양목')).toBe(true);
    expect(t.has('초여름')).toBe(true);
  });

  it('변별력 없는 흔한 말은 토큰에서 뺀다 — 이게 없으면 무관한 주장이 "나무"로 엮인다', () => {
    const t = salientTokens('나무 가지 관리 방법');
    expect([...t]).toEqual([]);
  });
});

describe('상한·킬스위치', () => {
  afterEach(() => { delete process.env.INHERITED_CLAIMS; });

  it('결과 상한을 넘기지 않는다', () => {
    const many = Array.from({ length: 20 }, (_, i) => `회양목 초여름 항목${i}`);
    const fields = many.map((t, i) => ({ field: `씬${i}`, text: t }));
    expect(inheritedClaims([CLAIM_회양목], fields).length).toBeLessThanOrEqual(5);
  });

  it('INHERITED_CLAIMS=off 면 검사 자체가 멈춘다', () => {
    process.env.INHERITED_CLAIMS = 'off';
    expect(inheritedClaims([CLAIM_회양목], [{ field: 'X', text: '회양목: 초여름 한 번' }])).toEqual([]);
  });
});

describe('formatInherited', () => {
  it('필드·주장·근거 토큰을 한 줄로 낸다', () => {
    const [hit] = inheritedClaims([CLAIM_회양목], [{ field: '씬5 목록', text: '회양목: 초여름 한 번' }]);
    const line = formatInherited(hit!);
    expect(line).toContain('씬5 목록');
    expect(line).toContain('근거 미확인');
    expect(line).toContain('회양목');
  });

  it('긴 주장은 잘라 낸다(수정 라운드 입력이 비대해지지 않게)', () => {
    const long = `회양목 초여름 ${'가'.repeat(200)}`;
    const [hit] = inheritedClaims([long], [{ field: 'X', text: '회양목 초여름 한 번' }]);
    expect(formatInherited(hit!)).toContain('…');
  });
});
