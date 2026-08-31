// src/content/factGate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../orchestrator/agent', () => ({ microJSON: vi.fn() }));
import { microJSON } from '../orchestrator/agent';
import {
  splitBodySentences, numericClaimSentences, buildEvidence, gateVerdict, formatGateFeedback, toFactGateInfo,
  extractFactClaims, judgeClaims, factGateBlog, runFactGateWithRepair,
  isJudgmentSentence, hasHedge, hasEventMarkers, classifyClaim,
  isHardClaim, HARD_CLAIM_KINDS,
  applySentenceRepairs, repairSentences,
  extractFactCard, FACT_CARD_HEADER,
} from './factGate';
import type { FactClaim, FactGateResult } from './factGate';

const mocked = microJSON as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => mocked.mockReset());

describe('splitBodySentences — 마크다운 본문을 판정 단위 문장으로', () => {
  it('소제목·표 행·목록을 문장으로 살리고 [IMAGE:]·코드펜스는 버린다', () => {
    const md = [
      '## 물주기 기준', '흙이 마르면 줍니다. 겉흙 3cm가 말랐을 때가 기준이에요.',
      '[IMAGE: 화분 사진]', '```', 'code', '```',
      '| 나이 | 화분 |', '|---|---|', '| 1년생 | 6~8호 |', '- 9월에는 거름을 줄입니다',
    ].join('\n');
    const s = splitBodySentences(md);
    expect(s).toContain('물주기 기준');
    expect(s).toContain('흙이 마르면 줍니다.');
    expect(s).toContain('겉흙 3cm가 말랐을 때가 기준이에요.');
    expect(s).toContain('1년생 · 6~8호');
    expect(s).toContain('9월에는 거름을 줄입니다');
    expect(s.some((x) => x.includes('IMAGE'))).toBe(false);
    expect(s.some((x) => x === 'code')).toBe(false);
    expect(s.some((x) => /^\|?-{3}/.test(x))).toBe(false);
  });
});

describe('numericClaimSentences — 수치·시기 문장 결정적 추출', () => {
  it('단위 수치·월·고유어 월·절기·연도 문장을 뽑는다', () => {
    const md = [
      '겉흙 3cm가 말랐을 때 줍니다.', '9월에는 거름을 줄입니다.', '시월이 지나면 물을 더 줄여요.',
      '처서가 지나면 새순이 멈춥니다.', '2025년 기준입니다.', '잔뿌리를 먼저 봅니다.', '두 해째 나무라면 가지가 열 개 안팎입니다.',
    ].join('\n');
    const s = numericClaimSentences(md);
    expect(s).toContain('겉흙 3cm가 말랐을 때 줍니다.');
    expect(s).toContain('9월에는 거름을 줄입니다.');
    expect(s).toContain('시월이 지나면 물을 더 줄여요.');
    expect(s).toContain('처서가 지나면 새순이 멈춥니다.');
    expect(s).toContain('2025년 기준입니다.');
    expect(s).not.toContain('잔뿌리를 먼저 봅니다.');
  });
  it('상한을 지키고 중복은 없앤다', () => {
    const md = Array.from({ length: 40 }, (_, i) => `${i + 1}cm 간격으로 심습니다.`).join('\n') + '\n3cm 간격으로 심습니다.';
    expect(numericClaimSentences(md, 10)).toHaveLength(10);
    expect(new Set(numericClaimSentences(md)).size).toBe(numericClaimSentences(md).length);
  });
});

describe('buildEvidence — 근거 말뭉치 조립', () => {
  it('블록마다 머리말을 붙이고 빈 블록은 뺀다', () => {
    const e = buildEvidence({ brief: '브리프 내용', critiqueText: '', wikiGrounding: '### 감나무 [런 산출 요약]\n발췌', verified: '- (2026-08-25) 4월 하순 부화 _(근거: 농사로)_' });
    expect(e).toContain('[리서치·SEO 브리프]\n브리프 내용');
    expect(e).toContain('[작가에게 주입된 위키 발췌]');
    expect(e).toContain('[근거 표기된 지식(verified)]');
    expect(e).not.toContain('[검수 의견]');
  });
  it('블록별 상한으로 자른다(브리프 12000자)', () => {
    const e = buildEvidence({ brief: 'x'.repeat(20000) });
    expect(e.length).toBeLessThan(12500);
  });
  it('사실 카드는 첫 블록으로 들어간다', () => {
    const e = buildEvidence({ factCard: '- a', brief: 'b' });
    expect(e.startsWith('[사실 카드(브리프 근거 확정)]\n- a')).toBe(true);
  });
  it('사실 카드는 브리프 예산에서 차감한다 — 총량이 카드만큼 늘지 않는다(Fix round 4, I3)', () => {
    const card = 'c'.repeat(6000);
    const e = buildEvidence({ factCard: card, brief: 'x'.repeat(20000), injected: '주입 지식', verified: '- 근거 표기 지식' });
    const briefBlock = e.split('[리서치·SEO 브리프]\n')[1]!.split('\n\n')[0]!;
    expect(briefBlock.length).toBeLessThanOrEqual(6000);   // 12000 - 6000(카드)
    expect(e).toContain('[주입된 외부 지식(사람이 넣음)]\n주입 지식');   // 뒤쪽 블록이 살아 있다
    expect(e).toContain('[근거 표기된 지식(verified)]\n- 근거 표기 지식');
    // 카드+브리프 본문 총량이 종전 브리프 상한(12000)을 넘지 않는다 — 카드가 근거 말뭉치를 부풀리지 않는다
    const cardBlock = e.split('[사실 카드(브리프 근거 확정)]\n')[1]!.split('\n\n')[0]!;
    expect(cardBlock.length + briefBlock.length).toBeLessThanOrEqual(12000);
  });
  it('카드가 상한을 넘겨도 카드는 6000자로 잘리고 브리프는 남은 예산만 받는다', () => {
    const e = buildEvidence({ factCard: 'c'.repeat(99999), brief: 'x'.repeat(20000) });
    const cardBlock = e.split('[사실 카드(브리프 근거 확정)]\n')[1]!.split('\n\n')[0]!;
    const briefBlock = e.split('[리서치·SEO 브리프]\n')[1]!;
    expect(cardBlock.length).toBe(6000);   // CAP.factCard
    expect(briefBlock.length).toBe(6000);  // CAP.brief(12000) - 6000. 하한 2000 은 현 상한 조합에선 닿지 않는 방어선이다
  });
});

describe('gateVerdict — 판정 집계', () => {
  const c = (text: string, status: FactClaim['status'], kind: FactClaim['kind'] = 'number'): FactClaim => ({ text, kind, status });
  it('supported·hedged_general 만 있으면 pass', () => {
    expect(gateVerdict([c('a', 'supported'), c('b', 'hedged_general', 'general')]).status).toBe('pass');
  });
  it('unsupported 1건이면 hold, 목록에 원문이 들어간다', () => {
    const v = gateVerdict([c('5cm 두께로 덮습니다', 'unsupported')]);
    expect(v.status).toBe('hold');
    expect(v.unsupported).toEqual(['5cm 두께로 덮습니다']);
    expect(v.contradicted).toEqual([]);
  });
  it('contradicted 는 근거 발췌를 붙여 보고한다', () => {
    const v = gateVerdict([{ text: '잎이 진 뒤 거름', kind: 'time', status: 'contradicted', evidence: '자사 글: 추분 후 시비' }]);
    expect(v.status).toBe('hold');
    expect(v.contradicted[0]).toBe('잎이 진 뒤 거름 ← 근거: 자사 글: 추분 후 시비');
  });
});

/**
 * 2026-08-27 사용자 지시 ① — 사실 게이트는 수치·시기·약제·법령·가격·경험 주장(hard)만 보류하고,
 * 일반 상식 문장의 무근거(soft)는 참고(unverified)로 통과시킨다. FACT_GATE_STRICT=1 이면 예전 동작으로 복귀.
 */
describe('isHardClaim / gateVerdict — hard(보류) · soft(참고) 분리', () => {
  it('한글 수사 오인 — 이번·일주일·백도·천도·팔도·사회 는 수치가 아니다(일반 상식 → soft)', () => {
    for (const text of ['이번 가을에는 낙엽을 걷어냅니다.', '일주일 정도 지켜봅니다.', '백도 품종은 늦게 익습니다.', '천도복숭아는 털이 없습니다.', '팔도 어디서나 자랍니다.'])
      expect(isHardClaim({ text, kind: 'general' })).toBe(false);
  });
  it('한글 수사+단위 — 삼일·오회·천원 은 수치 주장(hard)', () => {
    for (const text of ['삼일 만에 마릅니다.', '오회 나눠 줍니다.', '천원 차이입니다.'])
      expect(isHardClaim({ text, kind: 'general' })).toBe(true);
  });
  const u = (text: string, kind: FactClaim['kind']): FactClaim => ({ text, kind, status: 'unsupported' });

  it('hard kind 집합 — 수치·시기·약제·법령·가격·통계·경험(수종·병해충·일반은 soft)', () => {
    expect([...HARD_CLAIM_KINDS].sort()).toEqual(['experience', 'law', 'number', 'price', 'stat', 'time', 'treatment']);
    for (const k of ['species', 'pest', 'general'] as const) expect(HARD_CLAIM_KINDS.has(k)).toBe(false);
  });

  it('(a) kind general + 수치 없음 → 참고(unverified)로 통과', () => {
    const v = gateVerdict([u('낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.', 'general')], false);
    expect(v.status).toBe('pass');
    expect(v.unsupported).toEqual([]);
    expect(v.unverified).toEqual(['낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.']);
  });

  it('(b) kind general 이라도 수치("3배")가 있으면 보류', () => {
    const v = gateVerdict([u('뿌리가 3배 넘게 뻗습니다.', 'general')], false);
    expect(v.status).toBe('hold');
    expect(v.unsupported).toEqual(['뿌리가 3배 넘게 뻗습니다.']);
    expect(v.unverified).toEqual([]);
  });

  it('(b2) 한글 수사 + 단위("십 년")도 hard', () => {
    expect(isHardClaim({ text: '심고 십 년쯤 지나면 열매가 굵어집니다.', kind: 'general' })).toBe(true);
    expect(isHardClaim({ text: '낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.', kind: 'general' })).toBe(false);
  });

  it('(c) kind time 은 수치가 없어도 보류', () => {
    const v = gateVerdict([u('잎이 다 진 뒤에 거름을 줍니다.', 'time')], false);
    expect(v.status).toBe('hold');
    expect(v.unsupported).toEqual(['잎이 다 진 뒤에 거름을 줍니다.']);
    expect(v.unverified).toEqual([]);
  });

  it('(d) kind experience 는 수치가 없어도 보류', () => {
    const v = gateVerdict([u('우리 밭에서도 같은 일이 있었습니다.', 'experience')], false);
    expect(v.status).toBe('hold');
    expect(v.unsupported).toEqual(['우리 밭에서도 같은 일이 있었습니다.']);
  });

  it('soft 만 있으면 pass, hard 가 하나라도 섞이면 hold(soft 는 참고로 남는다)', () => {
    const v = gateVerdict([
      u('낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.', 'general'),
      u('잎이 다 진 뒤에 거름을 줍니다.', 'time'),
    ], false);
    expect(v.status).toBe('hold');
    expect(v.unsupported).toEqual(['잎이 다 진 뒤에 거름을 줍니다.']);
    expect(v.unverified).toEqual(['낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.']);
  });

  it('모순(contradicted)은 soft kind 여도 항상 보류', () => {
    const v = gateVerdict([{ text: '겨울에도 잎이 답니다', kind: 'general', status: 'contradicted', evidence: '브리프: 낙엽수' }], false);
    expect(v.status).toBe('hold');
    expect(v.unverified).toEqual([]);
  });

  it('(e) strict 면 예전 동작 — 무근거는 전부 unsupported, unverified 는 빈 배열', () => {
    const v = gateVerdict([u('낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.', 'general')], true);
    expect(v.status).toBe('hold');
    expect(v.unsupported).toEqual(['낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.']);
    expect(v.unverified).toEqual([]);
  });

  it('toFactGateInfo 가 unverified 를 요약에 싣는다(구 데이터는 [])', () => {
    const r: FactGateResult = {
      status: 'pass', claims: [], unsupported: [], contradicted: [], unverified: ['일반 상식 문장'], repaired: false, checkedTs: 't',
    };
    expect(toFactGateInfo(r).unverified).toEqual(['일반 상식 문장']);
    const legacy = { status: 'hold', claims: [], unsupported: ['a'], contradicted: [], repaired: false, checkedTs: 't' } as unknown as FactGateResult;
    expect(toFactGateInfo(legacy).unverified).toEqual([]);
  });
});

describe('factGateBlog — hard/soft 결과 조립', () => {
  it('무근거 일반 문장은 unverified 로, 수치 문장은 unsupported 로 갈린다', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [
        { text: '낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.', kind: 'general' },
        { text: '뿌리가 3배 넘게 뻗습니다.', kind: 'general' },
      ] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'unsupported' }, { index: 2, status: 'unsupported' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e', strict: false });
    expect(r.status).toBe('hold');
    expect(r.unsupported).toEqual(['뿌리가 3배 넘게 뻗습니다.']);
    expect(r.unverified).toEqual(['낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.']);
  });

  it('무근거가 일반 문장뿐이면 pass — 표적 수정·작가 재작성 라운드가 0 이 된다', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [{ text: '낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.', kind: 'general' }] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'unsupported' }] });
    const gate = vi.fn(async () => factGateBlog({ model: 'm', body: 'x', evidence: 'e', strict: false }));
    const targeted = vi.fn();
    const repair = vi.fn();
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 소제목\n본문');
    expect(r.result.status).toBe('pass');
    expect(r.result.unverified).toEqual(['낙엽이 지고 나면 나무는 쉬는 철로 들어갑니다.']);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(targeted).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });
});

describe('formatGateFeedback / toFactGateInfo', () => {
  const r: FactGateResult = {
    status: 'hold', claims: [], unsupported: ['5cm 두께로 덮습니다'], contradicted: ['잎이 진 뒤 거름 ← 근거: 추분 후'],
    unverified: [], repaired: false, checkedTs: '2026-08-26T00:00:00.000Z',
  };
  it('작가 수정 요청문에 문장 목록과 새 사실 금지 규칙이 들어간다', () => {
    const f = formatGateFeedback(r);
    expect(f).toContain('5cm 두께로 덮습니다');
    expect(f).toContain('잎이 진 뒤 거름');
    expect(f).toContain('새 사실·수치를 추가하지 마라');
  });
  it('info 는 claims 를 뺀 요약만 담는다', () => {
    expect(toFactGateInfo(r)).toEqual({ status: 'hold', unsupported: r.unsupported, contradicted: r.contradicted, unverified: [], checkedTs: r.checkedTs });
  });
});

describe('extractFactClaims — 추출 프롬프트·검증', () => {
  it('mustInclude 문장을 프롬프트에 넣고, 알 수 없는 kind 는 general 로 정규화한다', async () => {
    mocked.mockResolvedValueOnce({ claims: [{ text: '겉흙 3cm', kind: 'number' }, { text: '잎맥 사이 노랑', kind: 'weird' }, { text: '', kind: 'number' }] });
    const r = await extractFactClaims('m', '본문', ['겉흙 3cm'], { max: 5 });
    expect(r).toEqual([{ text: '겉흙 3cm', kind: 'number' }, { text: '잎맥 사이 노랑', kind: 'general' }]);
    const user = String(mocked.mock.calls[0]![2]);
    expect(user).toContain('반드시 포함');
    expect(user).toContain('겉흙 3cm');
    expect(user).toContain('최대 5개');
    // 출력 예산은 요청 주장 수에 비례(2026-08-26 최종 리뷰 F3) — 고정 1800 은 max 20 에서 잘려
    // 뒤쪽 주장이 통째로 유실됐다(잘린 JSON = 추출 실패 = fail-closed error).
    expect((mocked.mock.calls[0]![3] as { maxOutputTokens?: number }).maxOutputTokens).toBe(1500); // 600 + 5*180
  });
  it('LLM 실패(null)면 null', async () => {
    mocked.mockResolvedValueOnce(null);
    expect(await extractFactClaims('m', '본문', [])).toBeNull();
  });
});

describe('judgeClaims — 판정 규칙', () => {
  it('index 로 매핑하고, experience 는 근거와 무관하게 unsupported, 미판정은 unsupported', async () => {
    mocked.mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'supported', evidence: '브리프: 3cm' }, { index: 2, status: 'supported' }] });
    const r = await judgeClaims('m', [
      { text: '겉흙 3cm', kind: 'number' }, { text: '지난해 우리 밭', kind: 'experience' }, { text: '9월 시비', kind: 'time' },
    ], '[리서치·SEO 브리프]\n3cm');
    expect(r).toEqual([
      { text: '겉흙 3cm', kind: 'number', status: 'supported', evidence: '브리프: 3cm' },
      { text: '지난해 우리 밭', kind: 'experience', status: 'unsupported' },
      { text: '9월 시비', kind: 'time', status: 'unsupported' },
    ]);
    const user = String(mocked.mock.calls[0]![2]);
    expect(user).toContain('18~24cm');           // 반올림 오탐 예시
    expect(user).toContain('6호=18cm');           // 호↔cm 환산표
    expect(user).toContain('hedged_general');
    expect(user).toContain('검색량');             // 운영 수치 제외 규칙
    expect((mocked.mock.calls[0]![3] as { maxOutputTokens?: number }).maxOutputTokens).toBe(760); // 400 + 3*120
  });
});

describe('선분류(2026-08-26 hold 율 저감) — 3런 실측 문장', () => {
  it('판단·관점·권유·채널 자기서술은 주장이 아니다', () => {
    for (const s of [
      '감나무 가을 거름은 모자란 쪽이 안전하다고 봅니다.',
      '같은 무늬가 열매에도 보이면 거름과는 무관하다고 봅니다.',
      '가지 갈라진 곳에 흰 덩어리가 붙어 있거나 잎이 끈적하다면 벌레 쪽부터 보는 편입니다.',
      '화분에 담긴 흙 부피가 정해져 있으니 마당에 선 나무와 같은 기준으로 넣지 않는 게 안전합니다.',
      '병이나 벌레로 보이는 나무에 거름부터 넣는 건 순서가 틀렸습니다.',
      '병든 잎과 떨어진 열매를 치우는 일이 먼저예요.',
      '자동으로 물이 나오는 장치를 쓰고 있다면 이 시기에 타이머부터 손봐야 합니다',
      '묘목 한 그루가 뿌리내리는 과정을 계절 단위로 이어서 기록하고 있어요',
    ]) expect(isJudgmentSentence(s), s).toBe(true);
    for (const s of ['질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.', '퇴비는 흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.', '겉흙 3cm가 말랐을 때 줍니다.'])
      expect(isJudgmentSentence(s), s).toBe(false);
  });
  it('fix round 4(C1) — 사실 주장을 삼키던 대안 제거: 낫습니다·권합니다·부터 봅니다·낱개 먼저입니다·나아요는 판단문이 아니다', () => {
    for (const s of [
      '탄저병은 6월에 약제를 뿌리면 낫습니다.',
      '농약안전사용기준은 수확 14일 전까지 살포를 권합니다.',
      '깍지벌레 약충은 4월 하순부터 봅니다.',
      '산수유는 잎보다 꽃이 먼저입니다.',
      '배수가 좋은 흙에서 뿌리가 더 나아요.',
    ]) expect(isJudgmentSentence(s), s).toBe(false);
    // 조언 꼴로 좁힌 먼저/그다음은 여전히 판단문이다.
    expect(isJudgmentSentence('병든 잎과 떨어진 열매를 치우는 일이 먼저예요.')).toBe(true);
    expect(isJudgmentSentence('흙에 무엇을 넣는 건 그다음입니다.')).toBe(true);
    // "낫다고 봅니다" 류는 `다고 봅니다` 로 여전히 잡힌다(제거된 낱개 '낫다고' 의 실효 손실 없음).
    expect(isJudgmentSentence('약을 치는 쪽이 낫다고 봅니다.')).toBe(true);
  });
  it('fix round 4(C2) — 경성 수치(희석배수·횟수·온도·ppm·수확 전 일수·용량)는 유보어가 붙어도 판정 대상', () => {
    for (const s of [
      '이 약제는 1000배로 희석해 쓸 수 있습니다.',
      '살충제는 연 2회까지 쓸 수 있습니다.',
      '감나무는 영하 15도까지 견딜 수 있습니다.',
      '농약안전사용기준은 수확 14일 전까지 살포를 권합니다.',
    ]) expect(classifyClaim({ text: s, kind: 'treatment' }), s).toBe('claim');
    for (const s of [
      '넣지 않고 넘어간 해는 되돌릴 수 있지만 서두를 일은 아닙니다.',
      '심은 지 1~2년 된 어린나무는 뿌리가 아직 넓게 뻗지 못한 경우가 대부분입니다.',
      '흔히 양분 쪽입니다.',
    ]) expect(classifyClaim({ text: s, kind: 'general' }), s).toBe('hedged');
  });
  it('유보어 — 대부분·흔히·경우가 많 포함', () => {
    expect(hasHedge('심은 지 1~2년 된 어린나무는 뿌리가 아직 넓게 뻗지 못한 경우가 대부분입니다.')).toBe(true);
    expect(hasHedge('잎맥은 초록으로 남고 그 사이만 흐려지는 모습이면 흔히 양분 쪽입니다.')).toBe(true);
    expect(hasHedge('질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.')).toBe(false);
  });
  it('fix round 1 — 낱개 "편입니다" 는 판단문이 아니라 유보문(반증 가능한 수종 주장까지 무조건 제외되던 오탐 수선)', () => {
    // 수치 없는 유보 수종 주장은 그대로 유보문(판정기가 모순만 본다).
    expect(classifyClaim({ text: '래빗아이는 더위·건조에 강하고 나무가 크게 자라는 편입니다', kind: 'species' })).toBe('hedged');
    // fix round 4(C2)가 이 기대를 갱신한다 — '영하 10도'는 경성 수치라 유보문 자동 통과가 아니라 판정 대상('claim')이 됐다
    // (round 1 기대값은 'hedged' 였다). round 1 의 본래 취지(낱개 "편입니다" ≠ 판단문)는 아래 isJudgmentSentence 로 계속 지킨다.
    expect(classifyClaim({ text: '단감나무는 영하 10도까지 견디는 편입니다.', kind: 'species' })).toBe('claim');
    expect(isJudgmentSentence('단감나무는 영하 10도까지 견디는 편입니다.')).toBe(false);
    expect(classifyClaim({ text: '벌레 쪽부터 보는 편입니다.', kind: 'general' })).toBe('judgment'); // 권유 고정구는 여전히 판단문
    expect(isJudgmentSentence('그 안이 본편입니다')).toBe(false); // 낱개 "편입니다" 오탐(본편=main episode) 재발 방지
  });
  it('사건 표지 — 연도·기간·우리 밭·문의 실태만', () => {
    expect(hasEventMarkers('지난해 우리 밭 어린 단감나무도 사흘 사이 스무 개 넘게 떨궜습니다')).toBe(true);
    expect(hasEventMarkers('저희 밭에서도 문의가 오면 이렇게 답합니다')).toBe(true);
    expect(hasEventMarkers("화분을 들었을 때 '아직 무겁네' 하는 날이 이어지면 그게 신호예요")).toBe(false);
    expect(hasEventMarkers('우리 나무 잎을 사흘 간격으로 두어 번 만져 보는 편이 정확합니다.')).toBe(false); // 관찰법 권유(사흘 간격 ≠ 사흘 만에)
  });
  it('fix round 1 — 기간 표지는 1인칭 주어와 함께일 때만 사건(동안 제거, 숫자는 일 단위 한정)', () => {
    expect(hasEventMarkers('맨뿌리 묘목은 심기 전 이틀 동안 물에 담가 둡니다.')).toBe(false); // '동안' 은 관찰법에도 흔함
    expect(hasEventMarkers('흙 산도는 pH 5.5~6.5 사이가 알맞습니다.')).toBe(false); // 숫자+'사이'는 일 단위가 아니면 표지 아님
    expect(hasEventMarkers('하루 이틀 만에 물러집니다')).toBe(false); // 기간 표지는 있으나 1인칭 주어가 없다
    expect(hasEventMarkers('우리 밭에서는 사흘 만에 떨어졌습니다')).toBe(true); // 1인칭 + 기간 = 사건
  });
  it('classifyClaim 우선순위: event > judgment > hedged > claim', () => {
    expect(classifyClaim({ text: '지난해 우리 밭에서는 그렇게 봤습니다.', kind: 'experience' })).toBe('event');
    expect(classifyClaim({ text: '모자란 쪽이 안전하다고 봅니다.', kind: 'general' })).toBe('judgment');
    expect(classifyClaim({ text: '흔히 양분 쪽입니다.', kind: 'pest' })).toBe('hedged');
    expect(classifyClaim({ text: '가을에 양을 줄입니다.', kind: 'treatment' })).toBe('claim');
    expect(classifyClaim({ text: '무거우면 그게 신호예요', kind: 'experience' })).toBe('claim'); // 표지 없는 experience 는 일반 주장
  });
});

describe('factGateBlog — 선분류 반영', () => {
  it('판단문은 판정에 보내지 않고 filtered 에 세며, 유보문은 판정이 unsupported 여도 hedged_general, 표지 없는 experience 는 일반 판정', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [
        { text: '모자란 쪽이 안전하다고 봅니다.', kind: 'general' },
        { text: '흔히 양분 쪽입니다.', kind: 'pest' },
        { text: '무거우면 그게 신호예요', kind: 'experience' },
        { text: '가을에 양을 줄입니다.', kind: 'treatment' },
      ] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'unsupported' }, { index: 2, status: 'supported', evidence: '브리프' }, { index: 3, status: 'unsupported' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e' });
    const judgeUser = String(mocked.mock.calls[1]![2]);
    expect(judgeUser).not.toContain('안전하다고 봅니다');           // 판단문 제외
    expect(judgeUser).toContain('(유보)');                          // 유보문은 모순 여부만
    // Fix round 4(C3) — filtered 는 개수가 아니라 걸러낸 문장 텍스트(개수 = 배열 길이)
    expect(r.filtered).toEqual({ judgment: ['모자란 쪽이 안전하다고 봅니다.'], hedged: ['흔히 양분 쪽입니다.'] });
    expect(r.claims.find((c) => c.text.includes('흔히'))!.status).toBe('hedged_general');
    expect(r.claims.find((c) => c.text.includes('무거우면'))!.status).toBe('supported');
    expect(r.claims.find((c) => c.text.includes('무거우면'))!.kind).toBe('general');
    expect(r.unsupported).toEqual(['가을에 양을 줄입니다.']);
    expect(r.status).toBe('hold');
    expect(r.claims.every((c) => !('hedged' in c))).toBe(true); // 내부 플래그가 fact_gate.json 으로 새지 않는다
  });
  it('유보문이라도 판정이 contradicted 면 유지한다', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [{ text: '대개 9월에 줍니다.', kind: 'time' }] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'contradicted', evidence: '자사 글: 추분 후' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e' });
    expect(r.contradicted).toHaveLength(1);
  });
  it('전부 판단문이면 판정 콜 없이 pass', async () => {
    mocked.mockResolvedValueOnce({ claims: [{ text: '자리부터 정한다고 봅니다.', kind: 'general' }] });
    const r = await factGateBlog({ model: 'm', body: 'x', evidence: 'e' });
    expect(r.status).toBe('pass'); expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe('factGateBlog — 종단', () => {
  it('추출→판정→집계, 무근거 있으면 hold', async () => {
    mocked
      .mockResolvedValueOnce({ claims: [{ text: '5cm 두께로 덮습니다', kind: 'number' }] })
      .mockResolvedValueOnce({ verdicts: [{ index: 1, status: 'unsupported' }] });
    const r = await factGateBlog({ model: 'm', body: '짚을 5cm 두께로 덮습니다.', evidence: '브리프' });
    expect(r.status).toBe('hold');
    expect(r.unsupported).toEqual(['5cm 두께로 덮습니다']);
    expect(r.repaired).toBe(false);
    expect(r.checkedTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('주장이 0건이면 pass', async () => {
    mocked.mockResolvedValueOnce({ claims: [] });
    const r = await factGateBlog({ model: 'm', body: '잔뿌리를 봅니다.', evidence: '' });
    expect(r.status).toBe('pass');
    expect(mocked).toHaveBeenCalledTimes(1); // 판정 콜 생략
  });
  it('LLM 실패면 error(자동 경로 fail-closed)', async () => {
    mocked.mockResolvedValueOnce(null);
    const r = await factGateBlog({ model: 'm', body: '3cm', evidence: '' });
    expect(r.status).toBe('error');
    expect(r.error).toContain('추출');
  });
});

describe('runFactGateWithRepair — 1차 판정 → 수정 1회 → 2차 판정', () => {
  const R = (status: 'pass' | 'hold' | 'error', unsupported: string[] = []): FactGateResult =>
    ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('1차 pass 면 수정 없이 끝', async () => {
    const repair = vi.fn();
    const r = await runFactGateWithRepair({ gate: async () => R('pass'), repair }, '본문');
    expect(r.body).toBe('본문'); expect(r.result.status).toBe('pass'); expect(repair).not.toHaveBeenCalled();
  });
  it('1차 hold 면 피드백으로 수정 후 2차 판정, repaired=true', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['5cm'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async (_b: string, f: string) => `## 고침\n${f.includes('5cm') ? 'ok' : 'no'}`);
    const r = await runFactGateWithRepair({ gate, repair }, '## 원본\n5cm');
    expect(r.body).toBe('## 고침\nok'); expect(r.result.status).toBe('pass'); expect(r.result.repaired).toBe(true);
  });
  it('수정본이 비거나 소제목이 없으면 원본 유지 + 1차 결과 유지', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['5cm']));
    const r = await runFactGateWithRepair({ gate, repair: async () => '질문이 있습니다' }, '## 원본');
    expect(r.body).toBe('## 원본'); expect(r.result.status).toBe('hold'); expect(gate).toHaveBeenCalledTimes(1);
  });
  it('1차 error 면 수정하지 않고 error 유지(fail-closed)', async () => {
    const repair = vi.fn();
    const r = await runFactGateWithRepair({ gate: async () => R('error'), repair }, '## 원본');
    expect(r.result.status).toBe('error'); expect(repair).not.toHaveBeenCalled();
  });
});

describe('runFactGateWithRepair — firstPass 보존', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('2차 결과에 1차 요약이 붙는다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const r = await runFactGateWithRepair({ gate, repair: async () => '## 고침' }, '## 원본');
    expect(r.result.firstPass).toEqual({ status: 'hold', unsupported: ['a'], contradicted: [], unverified: [], checkedTs: 't' });
  });
  it('1차의 선분류 텍스트(filtered)도 함께 살아남는다(Fix round 4, C3)', async () => {
    const first: FactGateResult = {
      status: 'hold', claims: [], unsupported: ['a'], contradicted: [], unverified: [], repaired: false, checkedTs: 't',
      filtered: { judgment: ['모자란 쪽이 안전하다고 봅니다.'], hedged: ['흔히 양분 쪽입니다.'] },
    };
    const second: FactGateResult = { status: 'pass', claims: [], unsupported: [], contradicted: [], unverified: [], repaired: false, checkedTs: 't2', filtered: { judgment: [], hedged: [] } };
    const gate = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const r = await runFactGateWithRepair({ gate, repair: async () => '## 고침' }, '## 원본');
    expect(r.result.firstPass?.filtered).toEqual({ judgment: ['모자란 쪽이 안전하다고 봅니다.'], hedged: ['흔히 양분 쪽입니다.'] });
    expect(r.result.filtered).toEqual({ judgment: [], hedged: [] }); // 2차 결과의 filtered 는 수정된 본문 기준
  });
  it('1차에 filtered 가 없으면 firstPass 에도 붙이지 않는다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const r = await runFactGateWithRepair({ gate, repair: async () => '## 고침' }, '## 원본');
    expect(r.result.firstPass && 'filtered' in r.result.firstPass).toBe(false);
  });
});

describe('applySentenceRepairs — 문장 단위 치환(순수)', () => {
  const body = '## 거름\n질소 성분이 앞선 화학비료는 가을에 양을 줄입니다. 퇴비는 흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.\n\n잎에 뿌리는 영양제로 대신할 수 없습니다.';
  it('정확 일치·공백 정규화·앞 40자 접두 일치로 치환하고 delete 는 제거한다', () => {
    const r = applySentenceRepairs(body,
      ['질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.', '퇴비는  흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.', '잎에 뿌리는 영양제로 대신할 수 없습니'],
      [{ index: 1, action: 'hedge', replacement: '질소 성분이 앞선 화학비료는 가을에는 대개 양을 줄입니다.' }, { index: 2, action: 'judgment', replacement: '퇴비는 효과가 더디게 나오는 쪽이라고 봅니다.' }, { index: 3, action: 'delete', replacement: '' }]);
    expect(r.applied).toBe(3); expect(r.missed).toEqual([]);
    expect(r.body).toContain('가을에는 대개 양을 줄입니다.');
    expect(r.body).toContain('더디게 나오는 쪽이라고 봅니다.');
    expect(r.body).not.toContain('영양제로 대신할 수 없습니다');
    expect(r.body).not.toMatch(/\n{3,}/);
  });
  it('못 찾는 문장은 missed 로 남기고 나머지는 적용한다', () => {
    const r = applySentenceRepairs(body, ['없는 문장입니다.', '잎에 뿌리는 영양제로 대신할 수 없습니다.'],
      [{ index: 1, action: 'hedge', replacement: 'x' }, { index: 2, action: 'hedge', replacement: '잎에 뿌리는 영양제로는 대개 대신하기 어렵습니다.' }]);
    expect(r.applied).toBe(1); expect(r.missed).toEqual(['없는 문장입니다.']);
  });
  it('replacement 가 새 수치를 들이면 그 항목은 건너뛴다', () => {
    const r = applySentenceRepairs(body, ['잎에 뿌리는 영양제로 대신할 수 없습니다.'], [{ index: 1, action: 'hedge', replacement: '잎에 뿌리는 영양제는 3회까지는 대개 괜찮습니다.' }]);
    expect(r.applied).toBe(0); expect(r.missed).toEqual(['잎에 뿌리는 영양제로 대신할 수 없습니다.']);
  });
});

describe('repairSentences — 프롬프트·검증', () => {
  it('규칙(새 사실 금지·hedge/judgment/delete)이 프롬프트에 있고 잘못된 index/action 은 버린다', async () => {
    mocked.mockResolvedValueOnce({ repairs: [{ index: 1, action: 'hedge', replacement: 'a.' }, { index: 9, action: 'hedge', replacement: 'b.' }, { index: 2, action: 'rewrite', replacement: 'c.' }] });
    const r = await repairSentences('m', 'body', ['s1', 's2']);
    expect(r).toEqual([{ index: 1, action: 'hedge', replacement: 'a.' }]);
    const user = String(mocked.mock.calls[0]![2]);
    expect(user).toContain('새 사실·수치'); expect(user).toContain('hedge'); expect(user).toContain('judgment'); expect(user).toContain('delete');
  });
});

describe('runFactGateWithRepair — 표적 수정 우선', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('표적 수정이 적용되면 작가 재작성 없이 2차 판정', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(); const targeted = vi.fn(async () => ({ body: '## 표적', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).not.toHaveBeenCalled(); expect(r.body).toBe('## 표적'); expect(r.result.repaired).toBe(true);
  });
  it('표적 수정이 하나도 안 붙으면 작가 재작성으로 폴백', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async () => '## 재작성'); const targeted = vi.fn(async () => ({ body: '## 원본', applied: 0, missed: ['a'] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).toHaveBeenCalledTimes(1); expect(r.body).toBe('## 재작성');
  });
});

// ─────────────────────────── Fix round 1(리뷰어 지적 6건) ───────────────────────────

describe('applySentenceRepairs — 마크다운 마커 보존(Fix round 1)', () => {
  it('H2 제목 문장을 hedge 로 바꿔도 "## " 마커와 H2 개수가 유지된다(실제 발행 draft.json 에서 재현된 사고)', () => {
    const body = '## 9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무\n본문입니다.';
    const r = applySentenceRepairs(body, ['9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무'],
      [{ index: 1, action: 'hedge', replacement: '9월 초 사과나무비료는 대개 미룰 나무와 줘도 되는 나무로 나뉩니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.body).toMatch(/^## /m);
    expect((r.body.match(/^#{2,}\s/gm) ?? []).length).toBe((body.match(/^#{2,}\s/gm) ?? []).length);
  });
  it('목록 항목 문장을 치환해도 "- " 마커가 유지된다', () => {
    const body = '- 심은 지 1~2년 된 어린나무는 뿌리가 얕습니다.\n다음 줄입니다.';
    const r = applySentenceRepairs(body, ['심은 지 1~2년 된 어린나무는 뿌리가 얕습니다.'],
      [{ index: 1, action: 'hedge', replacement: '심은 지 1~2년 된 어린나무는 대개 뿌리가 얕습니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.body).toMatch(/^- /m);
  });
  it('제목 문장 전체를 delete 요청해도 소제목은 지워지지 않고 missed 로 남는다(Fix round 2c — 정책 변경: 소제목은 구조라 삭제 대상이 아니다)', () => {
    const body = '## 9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무\n본문입니다.';
    const r = applySentenceRepairs(body, ['9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무'],
      [{ index: 1, action: 'delete', replacement: '' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무']);
    expect(r.body).toBe(body);
  });
  it('repairs 가 배열이 아니면 아무것도 적용하지 않고 전량 missed 로 돌린다', () => {
    const r = applySentenceRepairs('본문', ['a', 'b'], null as unknown as never);
    expect(r).toEqual({ body: '본문', applied: 0, missed: ['a', 'b'] });
  });
});

describe('applySentenceRepairs — 접두 일치 하한(Fix round 1)', () => {
  it('원문이 지나치게 짧으면(짧은 접두) 우연한 접두 일치를 인정하지 않는다', () => {
    const r = applySentenceRepairs('겉흙 3cm가 마르면 그때 흠뻑 줍니다.', ['겉흙 3cm'],
      [{ index: 1, action: 'hedge', replacement: '겉흙 3cm 안팎이면 대개 줍니다.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['겉흙 3cm']);
  });
  it('브리프의 21자 안팎 절단 접두는 여전히 매치된다(회귀 방지)', () => {
    const body = '## 거름\n잎에 뿌리는 영양제로 대신할 수 없습니다.';
    const r = applySentenceRepairs(body, ['잎에 뿌리는 영양제로 대신할 수 없습니'],
      [{ index: 1, action: 'delete', replacement: '' }]);
    expect(r.applied).toBe(1);
    expect(r.body).not.toContain('영양제로 대신할 수 없습니다');
  });
});

describe('applySentenceRepairs — 새 수치 가드는 값 집합으로 비교한다(Fix round 1)', () => {
  it('같은 종류라도 값이 바뀌면(3cm→5cm) 건너뛴다', () => {
    const r = applySentenceRepairs('겉흙 3cm가 마르면 줍니다.', ['겉흙 3cm가 마르면 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '겉흙 5cm가 마르면 대개 줍니다.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['겉흙 3cm가 마르면 줍니다.']);
  });
  it('원문에 있던 값 그대로면 적용한다', () => {
    const r = applySentenceRepairs('겉흙 3cm가 마르면 줍니다.', ['겉흙 3cm가 마르면 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '겉흙 3cm가 마르면 대개 줍니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
});

describe('runFactGateWithRepair — 구조 가드(Fix round 1)', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('표적 수정 본문의 H2 개수가 줄면 적용됐어도 작가 재작성으로 폴백한다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async () => '## 재작성');
    // 마커가 깨져 H2 가 2 → 0 으로 줄어든 표적 수정 결과를 흉내낸다.
    const targeted = vi.fn(async () => ({ body: '본문만 남음', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본\n## 소제목2');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(r.body).toBe('## 재작성');
  });
});

describe('runFactGateWithRepair — 표적 수정 예외(Fix round 1)', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('targeted 가 예외를 던지면 작가 재작성으로 폴백한다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async () => '## 재작성');
    const targeted = vi.fn(async () => { throw new Error('llm down'); });
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(r.body).toBe('## 재작성');
  });
});

describe('runFactGateWithRepair — 부분 적용(Fix round 1)', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('3건 중 1건만 적용되면(절반 미만) 부분 적용된 본문을 기준으로 작가가 나머지를 마저 고친다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a', 'b', 'c'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async (baseBody: string) => `## 재작성\n${baseBody.includes('부분적용됨') ? 'ok' : 'no'}`);
    const targeted = vi.fn(async () => ({ body: '## 부분적용됨', applied: 1, missed: ['b', 'c'] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0]![0]).toContain('부분적용됨');
    expect(r.body).toBe('## 재작성\nok');
  });
  it('3건 중 2건 적용되면(절반 이상) 작가 재작성 없이 곧장 2차 판정한다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a', 'b', 'c'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn();
    const targeted = vi.fn(async () => ({ body: '## 대부분적용됨', applied: 2, missed: ['c'] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).not.toHaveBeenCalled();
    expect(r.body).toBe('## 대부분적용됨');
  });
});

// ─────────────────────────── Fix round 2(리뷰어 재검토 지적 4건) ───────────────────────────

describe('splitBodySentences — 인용 마커(Fix round 2a)', () => {
  it('인용(>·>>·>>>)·조합 마커(> - )를 벗기고 문장을 살린다', () => {
    const md = ['> 인용 한 줄입니다.', '>> 이중 인용입니다.', '> - 인용 속 목록입니다.'].join('\n');
    const s = splitBodySentences(md);
    expect(s).toContain('인용 한 줄입니다.');
    expect(s).toContain('이중 인용입니다.');
    expect(s).toContain('인용 속 목록입니다.');
  });
});

describe('applySentenceRepairs — 인용 마커 보존(Fix round 2a)', () => {
  it('">> " 인용 마커는 치환 범위에서 제외되어 살아남는다(83건 실측된 인용 수치 문장 사고)', () => {
    const body = '>> 어린 나무는 3년 뒤 골격이 먼저입니다.\n본문입니다.';
    const r = applySentenceRepairs(body, ['어린 나무는 3년 뒤 골격이 먼저입니다.'],
      [{ index: 1, action: 'hedge', replacement: '어린 나무는 대개 3년 뒤 골격이 먼저입니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.body).toMatch(/^>> /m);
  });
  it('"> - " 처럼 겹친 마커도 반복 매칭으로 전부 보존한다', () => {
    const body = '> - 어린 나무는 3년 뒤 골격이 먼저입니다.\n본문입니다.';
    const r = applySentenceRepairs(body, ['어린 나무는 3년 뒤 골격이 먼저입니다.'],
      [{ index: 1, action: 'hedge', replacement: '어린 나무는 대개 3년 뒤 골격이 먼저입니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.body).toMatch(/^> - /m);
  });
});

describe('introducesNewFacts — 수치 토큰 정규화(Fix round 2b)', () => {
  it('MONTH_RE 가 캡처한 앞 글자 차이(" 9월" vs "9월")는 새 사실이 아니다', () => {
    const r = applySentenceRepairs('거름은 9월에 줍니다.', ['거름은 9월에 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '9월에는 대개 거름을 줍니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
  it('공백 유무 차이("3cm" vs "3 cm")는 새 사실이 아니다', () => {
    const r = applySentenceRepairs('겉흙 3cm가 마르면 줍니다.', ['겉흙 3cm가 마르면 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '겉흙 3 cm가 마르면 대개 줍니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
  it('값 자체가 바뀌면(3cm→5cm) 여전히 새 사실로 걸러낸다(회귀 방지)', () => {
    const r = applySentenceRepairs('겉흙 3cm가 마르면 줍니다.', ['겉흙 3cm가 마르면 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '겉흙 5cm가 마르면 대개 줍니다.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['겉흙 3cm가 마르면 줍니다.']);
  });
});

describe('introducesNewFacts — 고유어 월 이름 첫 음절 소실 회귀(Fix round 3)', () => {
  it('고유어 월이 바뀌면(삼월→구월) 새 사실로 걸러낸다(정월~십이월 전부가 "월"로 뭉개지던 회귀)', () => {
    const r = applySentenceRepairs('삼월에 심습니다.', ['삼월에 심습니다.'],
      [{ index: 1, action: 'hedge', replacement: '구월에 대개 심습니다.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['삼월에 심습니다.']);
  });
  it('같은 고유어 월이면(삼월→삼월) 적용한다', () => {
    const r = applySentenceRepairs('삼월에 심습니다.', ['삼월에 심습니다.'],
      [{ index: 1, action: 'hedge', replacement: '삼월에는 대개 심습니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
  it('정월→유월도 새 사실로 걸러낸다', () => {
    const r = applySentenceRepairs('정월에 가지치기합니다.', ['정월에 가지치기합니다.'],
      [{ index: 1, action: 'hedge', replacement: '유월에 대개 가지치기합니다.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['정월에 가지치기합니다.']);
  });
  it('숫자 월(" 9월" vs "9월")은 여전히 새 사실이 아니다(Fix round 2 회귀 방지)', () => {
    const r = applySentenceRepairs('거름은 9월에 줍니다.', ['거름은 9월에 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '9월에는 대개 거름을 줍니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
  it('공백 유무 차이("3cm" vs "3 cm")도 여전히 새 사실이 아니다(Fix round 2 회귀 방지)', () => {
    const r = applySentenceRepairs('겉흙 3cm가 마르면 줍니다.', ['겉흙 3cm가 마르면 줍니다.'],
      [{ index: 1, action: 'hedge', replacement: '겉흙 3 cm가 마르면 대개 줍니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
});

describe('applySentenceRepairs — 소제목 delete 금지(Fix round 2c)', () => {
  it('소제목 delete 는 missed 로 남고, 형제 문장은 정상 적용되며 H2 개수는 그대로다', () => {
    const body = '## 9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무\n질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.';
    const r = applySentenceRepairs(body,
      ['9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무', '질소 성분이 앞선 화학비료는 가을에 양을 줄입니다.'],
      [
        { index: 1, action: 'delete', replacement: '' },
        { index: 2, action: 'hedge', replacement: '질소 성분이 앞선 화학비료는 가을에는 대개 양을 줄입니다.' },
      ]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual(['9월 초 사과나무비료, 미룰 나무와 줘도 되는 나무']);
    expect(r.body).toMatch(/^## /m);
    expect((r.body.match(/^#{2,}\s/gm) ?? []).length).toBe(1);
  });
});

describe('runFactGateWithRepair — targeted 메타 정보(Fix round 2d)', () => {
  const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
  it('전량 적용 — used:true, missed:0', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const targeted = vi.fn(async () => ({ body: '## 표적', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair: vi.fn(), targeted }, '## 원본');
    expect(r.targeted).toEqual({ applied: 1, missed: 0, used: true });
  });
  it('targeted 예외 — used:false, applied:0, missed 는 무근거 문장 전체 개수', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a', 'b'])).mockResolvedValueOnce(R('pass'));
    const targeted = vi.fn(async () => { throw new Error('llm down'); });
    const r = await runFactGateWithRepair({ gate, repair: async () => '## 재작성', targeted }, '## 원본');
    expect(r.targeted).toEqual({ applied: 0, missed: 2, used: false });
  });
  it('구조 손상으로 폐기 — used:false 지만 applied/missed 는 표적 결과 값 그대로 보고한다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async () => '## 재작성');
    const targeted = vi.fn(async () => ({ body: '본문만 남음', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본\n## 소제목2');
    expect(r.targeted).toEqual({ applied: 1, missed: 0, used: false });
  });
  it('부분 적용 후 작가 폴백 — 표적 결과가 출발점으로 쓰였으니 used:true', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a', 'b', 'c'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn(async () => '## 재작성');
    const targeted = vi.fn(async () => ({ body: '## 부분적용됨', applied: 1, missed: ['b', 'c'] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(r.targeted).toEqual({ applied: 1, missed: 2, used: true });
  });
  it('targeted 콜백 자체가 없으면 targeted 필드도 없다', async () => {
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const r = await runFactGateWithRepair({ gate, repair: async () => '## 재작성' }, '## 원본');
    expect(r.targeted).toBeUndefined();
  });
});

// ─────────────────────────── Fix round 4(최종 리뷰 지적) ───────────────────────────

describe('applySentenceRepairs — 치환문 유사도 하한(Fix round 4, I4)', () => {
  const body = '## 거름\n가을에 양을 줄입니다.';
  it('원문을 낮춰 말한 치환은 적용한다(유사도 0.76)', () => {
    const r = applySentenceRepairs(body, ['가을에 양을 줄입니다.'],
      [{ index: 1, action: 'hedge', replacement: '가을에는 대개 양을 줄입니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
    expect(r.body).toContain('가을에는 대개 양을 줄입니다.');
  });
  it('원문과 무관한 문장으로 통째 교체하면(유사도 0) 적용하지 않고 missed 로 돌린다', () => {
    const r = applySentenceRepairs(body, ['가을에 양을 줄입니다.'],
      [{ index: 1, action: 'hedge', replacement: '물은 아침에 주세요.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['가을에 양을 줄입니다.']);
    expect(r.body).toBe(body); // 본문은 손대지 않는다
  });
  it('judgment 액션도 같은 하한을 쓴다', () => {
    const r = applySentenceRepairs(body, ['가을에 양을 줄입니다.'],
      [{ index: 1, action: 'judgment', replacement: '병해충 방제가 먼저라고 봅니다.' }]);
    expect(r.applied).toBe(0);
    expect(r.missed).toEqual(['가을에 양을 줄입니다.']);
  });
  it('delete 는 하한 대상이 아니다(빈 문자열이라 유사도가 늘 0)', () => {
    const r = applySentenceRepairs(body, ['가을에 양을 줄입니다.'], [{ index: 1, action: 'delete', replacement: '' }]);
    expect(r.applied).toBe(1);
    expect(r.body).not.toContain('가을에 양을 줄입니다.');
  });
  it('하한 바로 위 경계(퇴비 문장 0.4444)는 계속 적용된다 — 하한·계산식을 건드리면 여기서 먼저 깨진다', () => {
    // 유사도 지표를 바꾸면(문장부호 제거·패딩·멀티셋 등) 이 쌍이 0.4 아래로 내려가 실제 교정 1건이 조용히 사라진다.
    const b = '## 거름\n퇴비는 흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.';
    const r = applySentenceRepairs(b, ['퇴비는  흙에서 천천히 분해되는 자재라 효과가 더디게 나옵니다.'],
      [{ index: 1, action: 'judgment', replacement: '퇴비는 효과가 더디게 나오는 쪽이라고 봅니다.' }]);
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual([]);
  });
});

describe('runFactGateWithRepair — 모순 hold 는 작가까지 간다(Fix round 4, I1·I2)', () => {
  it('I1 — 모순 1 + 무근거 1 에서 표적이 1건 적용돼도 작가 재작성을 부른다(표적 본문 기준)', async () => {
    const first: FactGateResult = {
      status: 'hold', claims: [], unsupported: ['무근거 문장'], contradicted: ['모순 문장 ← 근거: 자사 글'],
      unverified: [], repaired: false, checkedTs: 't',
    };
    const pass: FactGateResult = { status: 'pass', claims: [], unsupported: [], contradicted: [], unverified: [], repaired: false, checkedTs: 't2' };
    const gate = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(pass);
    const repair = vi.fn(async (_b: string, _f: string) => '## 재작성');
    const targeted = vi.fn(async () => ({ body: '## 표적적용됨', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0]![0]).toBe('## 표적적용됨');           // 표적 결과가 작가의 출발점
    expect(repair.mock.calls[0]![1]).toContain('모순 문장');           // 모순 목록은 피드백에 그대로 남는다
    expect(r.body).toBe('## 재작성');
    expect(r.targeted).toEqual({ applied: 1, missed: 0, used: true });
  });
  it('I2 — 무근거가 0건인 hold(모순만)에서는 표적 수정을 아예 부르지 않는다', async () => {
    const first: FactGateResult = {
      status: 'hold', claims: [], unsupported: [], contradicted: ['모순 문장 ← 근거: 자사 글'],
      unverified: [], repaired: false, checkedTs: 't',
    };
    const pass: FactGateResult = { status: 'pass', claims: [], unsupported: [], contradicted: [], unverified: [], repaired: false, checkedTs: 't2' };
    const gate = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(pass);
    const repair = vi.fn(async () => '## 재작성');
    const targeted = vi.fn(async () => ({ body: '## 표적', applied: 0, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(targeted).not.toHaveBeenCalled();
    expect(r.targeted).toBeUndefined();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(r.body).toBe('## 재작성');
  });
  it('모순이 없으면 지름길(작가 재작성 없이 2차 판정)은 그대로다(회귀 방지)', async () => {
    const R = (status: 'pass' | 'hold', unsupported: string[] = []): FactGateResult => ({ status, claims: [], unsupported, contradicted: [], unverified: [], repaired: false, checkedTs: 't' });
    const gate = vi.fn().mockResolvedValueOnce(R('hold', ['a'])).mockResolvedValueOnce(R('pass'));
    const repair = vi.fn();
    const targeted = vi.fn(async () => ({ body: '## 표적', applied: 1, missed: [] }));
    const r = await runFactGateWithRepair({ gate, repair, targeted }, '## 원본');
    expect(repair).not.toHaveBeenCalled();
    expect(r.body).toBe('## 표적');
  });
});

describe('extractFactCard', () => {
  it('근거 표기 문장만 불릿으로, 운영 수치 제외 규칙이 프롬프트에 있고, 비면 null', async () => {
    mocked.mockResolvedValueOnce({ facts: ['감나무 주머니깍지벌레는 4월 하순부터 약충으로 깨어난다 (근거: 농사로 curationNo=1964)', ''] });
    const c = await extractFactCard('m', '브리프', { max: 10 });
    expect(c).toBe('- 감나무 주머니깍지벌레는 4월 하순부터 약충으로 깨어난다 (근거: 농사로 curationNo=1964)');
    const user = String(mocked.mock.calls[0]![2]);
    expect(user).toContain('검색량'); expect(user).toContain('최대 10');
    mocked.mockResolvedValueOnce({ facts: [] });
    expect(await extractFactCard('m', '브리프')).toBeNull();
  });
  it('이중 불릿 접두(-,•)는 벗기고 "- " 하나로 통일한다(Fix round 1)', async () => {
    mocked.mockResolvedValueOnce({ facts: ['- a (근거: x)', '• b (근거: y)'] });
    expect(await extractFactCard('m', '브리프')).toBe('- a (근거: x)\n- b (근거: y)');
  });
  it('공백 없는 선행 "-"는 음수 부호로 보존한다(Fix round 2 — 불릿 오인 방지)', async () => {
    mocked.mockResolvedValueOnce({ facts: ['-5℃ 이하에서는 동해를 입는다 (근거: 산림청)'] });
    expect(await extractFactCard('m', '브리프')).toBe('- -5℃ 이하에서는 동해를 입는다 (근거: 산림청)');
  });
  it('microJSON 이 null(무응답)이면 null(Fix round 1)', async () => {
    mocked.mockResolvedValueOnce(null);
    expect(await extractFactCard('m', '브리프')).toBeNull();
  });
  it('buildEvidence 는 사실 카드를 첫 블록으로', () => {
    const e = buildEvidence({ factCard: '- a', brief: 'b' });
    expect(e.startsWith('[사실 카드(브리프 근거 확정)]\n- a')).toBe(true);
  });
  it('헤더 문구', () => {
    expect(FACT_CARD_HEADER).toContain('이 목록 밖의 사실');
    expect(FACT_CARD_HEADER).toBe('[사실 카드 — 브리프에서 근거가 확인된 사실. 이 목록 밖의 사실·수치·시기·약제는 쓰지 말고, 꼭 필요하면 유보어("대개/흔히")를 붙인 일반론이나 판단문("~라고 봅니다")으로만 말하라]');
  });
});
