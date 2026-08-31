import { describe, it, expect } from 'vitest';
import { REVISE_NO_NEW_FACTS, buildReviseContext, BLOG_BODY_GUIDE, blogBodyGuide, buildGenreGuide } from './org';
import { FACT_CARD_HEADER } from '../content/factGate';

describe('리비전 컨텍스트(스펙 §3) — 브리프·목소리 지침이 개정에도 들어간다', () => {
  it('브리프·voiceGuide·기존 초안·수정 요청 순으로 조립한다', () => {
    const ctx = buildReviseContext({ brief: '브리프B', voiceGuide: '[근거와 목소리] V', baseBody: '## 초안', feedback: '고쳐라' });
    expect(ctx.indexOf('[근거와 목소리] V')).toBeGreaterThanOrEqual(0);
    expect(ctx.indexOf('[리서치·SEO 브리프]\n브리프B')).toBeLessThan(ctx.indexOf('[기존 초안]\n## 초안'));
    expect(ctx).toContain('[검토자 수정 요청 — 반드시 반영]\n고쳐라');
  });
  it('브리프가 없으면 그 블록만 빠진다', () => {
    const ctx = buildReviseContext({ brief: '', voiceGuide: 'V', baseBody: 'B', feedback: 'F' });
    expect(ctx).not.toContain('[리서치·SEO 브리프]');
  });
  it('새 사실 금지 문구 상수', () => {
    expect(REVISE_NO_NEW_FACTS).toContain('새 사실·수치·시기를 추가하지 마라');
  });
  it('사실 카드(2026-08-26)가 있으면 맨 앞 블록으로 들어간다', () => {
    const ctx = buildReviseContext({ factCard: '- 사실', brief: '브리프B', voiceGuide: 'V', baseBody: '## 초안', feedback: '고쳐라' });
    expect(ctx.startsWith(`${FACT_CARD_HEADER}\n- 사실`)).toBe(true);
  });
  it('사실 카드가 없으면 그 블록만 빠진다(기존 순서 불변)', () => {
    const ctx = buildReviseContext({ brief: '브리프B', voiceGuide: 'V', baseBody: 'B', feedback: 'F' });
    expect(ctx).not.toContain('[사실 카드');
  });
});

it('BLOG_BODY_GUIDE — 사실 범위 한정·[근거:] 표기 금지 문구', () => {
  expect(BLOG_BODY_GUIDE).toContain('브리프·제공 자료에 있는 것만 쓴다');
  expect(BLOG_BODY_GUIDE).toContain('[근거: …] 표기는 남기지 않는다');
  expect(BLOG_BODY_GUIDE).not.toContain('사실·수치는 근거로 뒷받침([근거: 출처])');
});

// 골격 다양화(2026-08-27 권고 4) — 자리 고정 문구가 매 글 같은 배치를 만들던 것을 시드에 위임한다.
it('BLOG_BODY_GUIDE — 인용구·프레임·표의 자리 고정 문구가 [이번 글 구조] 위임으로 바뀌었다', () => {
  expect(BLOG_BODY_GUIDE).toContain('글당 0~1곳 — 아래 [이번 글 구조] 지시를 따른다');
  expect(BLOG_BODY_GUIDE).not.toContain('글의 중심 명제 한 문장(글당 1곳, 도입 훅 직후가 최적)');
  expect(BLOG_BODY_GUIDE).toContain('아래 [이번 글 구조] 에서 켜졌을 때만');
  expect(BLOG_BODY_GUIDE).toContain('이번 글에 넣을지는 아래 [이번 글 구조] 를 따른다');
});

// Fix wave(2026-08-27, 소견 2) — 킬스위치 동일성 계약: STRUCTURE_VARIETY=off 는 '시드만 고정'이 아니라
// **프롬프트 문구까지 base 로** 돌아가야 한다. off 인데 위임 문구가 남으면 작가는 존재하지 않는
// [이번 글 구조] 블록을 참조하라는 지시를 받는다(소견 3 과 같은 성격의 매달린 참조).
describe('blogBodyGuide — STRUCTURE_VARIETY 킬스위치가 프롬프트 문구까지 되돌린다', () => {
  it('on 이면 종전 상수와 동일하다(위임 문구 유지)', () => {
    expect(blogBodyGuide(true)).toBe(BLOG_BODY_GUIDE);
  });
  it('off 면 [이번 글 구조] 참조가 하나도 남지 않는다', () => {
    expect(blogBodyGuide(false)).not.toContain('[이번 글 구조]');
  });
  it('off 면 base(194bed6d) 문구로 정확히 되돌아간다 — 도입·인용구·프레임·표', () => {
    const off = blogBodyGuide(false);
    expect(off).toContain('독자의 상황·질문으로 바로 시작한다');
    expect(off).toContain('글의 중심 명제 한 문장(글당 1곳, 도입 훅 직후가 최적)');
    expect(off).toContain('마무리 요약·행동 체크리스트 박스(글당 1곳, 연속 줄로 작성·최대 8줄');
    expect(off).toContain('마크다운 표(| 헤더 | ... |)로 제시하면 가독성이 높다(하우투·리뷰의 비교표에 특히 유용).');
  });
  it('off 여도 보호 자산(사실 범위 한정·프레임 20자 규칙·AI 티 금지)은 그대로다', () => {
    const off = blogBodyGuide(false);
    expect(off).toContain('브리프·제공 자료에 있는 것만 쓴다');
    expect(off).toContain('각 줄은 공백 포함 20자 이내로 짧게');
    expect(off).toContain('①인사·예고형 도입');
  });
});

it('리비전 컨텍스트에 [이번 글 구조] 블록이 들어간다(같은 시드 승계)', () => {
  const ctx = buildReviseContext({ brief: 'B', voiceGuide: 'V', baseBody: '초안', feedback: 'F', structure: '[이번 글 구조] 골격' });
  expect(ctx).toContain('[이번 글 구조] 골격');
  expect(ctx.indexOf('[이번 글 구조] 골격')).toBeLessThan(ctx.indexOf('[기존 초안]'));
});

// Fix round(finding 3) — 도입 자리 고정 문구('독자의 상황·질문으로 바로 시작한다')는 시드 openers 4값 중
// 3값(주장·대비·장면)과 경쟁하는 상시 처방이었다. 인사·예고형 도입 금지 자체는 남기고 꼬리만 위임한다.
it('BLOG_BODY_GUIDE — 도입 유형도 [이번 글 구조] 에 위임한다', () => {
  expect(BLOG_BODY_GUIDE).toContain('도입 유형은 아래 [이번 글 구조] 를 따른다');
  expect(BLOG_BODY_GUIDE).not.toContain('독자의 상황·질문으로 바로 시작한다');
  expect(BLOG_BODY_GUIDE).toContain('①인사·예고형 도입');
});

// Fix round(finding 1) — 시드의 예고가 켜지면(뽑기의 2/3) genreGuide 의 '예고로 닫지 마라'와
// structureBlock 의 '맨 끝에 다음 편 한 줄'이 같은 프롬프트 안에서 정면 충돌한다. 켜진 런에서만 뺀다.
describe('buildGenreGuide — 장르 축 지침 × 구조 시드 예고', () => {
  const axes = ['고르기·구매', '심은 뒤 첫 계절 관리'];
  it('예고가 꺼진 런(기본)에는 "예고로 닫지 마라"가 붙는다', () => {
    expect(buildGenreGuide(axes)).toContain('예고로 닫지 마라');
    expect(buildGenreGuide(axes, false)).toContain('예고로 닫지 마라');
  });
  it('예고가 켜진 런에서는 그 문장만 빠지고 나머지 축 지침은 그대로다', () => {
    const g = buildGenreGuide(axes, true);
    expect(g).not.toContain('예고로 닫지 마라');
    expect(g).toContain('[글의 성격]');
    expect(g).toContain('1) 고르기·구매');
    expect(g).toContain('행동을 최소 하나 제시하라');
  });
  it('genreAxes 미설정 브랜드는 예고 여부와 무관하게 빈 문자열', () => {
    expect(buildGenreGuide([], true)).toBe('');
    expect(buildGenreGuide([], false)).toBe('');
  });
});
