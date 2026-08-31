import { describe, it, expect } from 'vitest';
import {
  escapeHtml, stripMarkdown, reviewLink, studioBase,
  blogReadyHtml, cardnewsCaptionHtml, shortsCaptionHtml, factGateLines, briefGateLines,
} from './contentNotify';

describe('escapeHtml', () => {
  it('&·<·> 를 이스케이프한다(텔레그램 HTML parse_mode 안전)', () => {
    expect(escapeHtml('<b>A&B</b>')).toBe('&lt;b&gt;A&amp;B&lt;/b&gt;');
  });
});

describe('stripMarkdown', () => {
  it('이미지·링크·헤더·강조·코드펜스를 제거하고 평문만 남긴다', () => {
    const md = '# 제목\n\n![alt](http://x/img.png)\n**굵게** 그리고 [링크](http://y)\n\n```js\ncode();\n```\n본문.';
    const out = stripMarkdown(md);
    expect(out).not.toContain('#');
    expect(out).not.toContain('![');
    expect(out).not.toContain('http://y');
    expect(out).not.toContain('code()');
    expect(out).toContain('제목');
    expect(out).toContain('굵게 그리고 링크');
    expect(out).toContain('본문.');
  });
});

describe('reviewLink', () => {
  it('piece id 가 있으면 ?piece= 딥링크, 없으면 스튜디오 홈', () => {
    expect(reviewLink('piece_ab12')).toBe(`${studioBase()}/?piece=piece_ab12`);
    expect(reviewLink(undefined)).toBe(`${studioBase()}/`);
  });
});

describe('blogReadyHtml', () => {
  it('제목·키워드·SEO·발췌·검토 링크를 담는다', () => {
    const html = blogReadyHtml(
      { id: 'piece_x', title: '블루베리 & 관리', keyword: '블루베리키우기', seoScore: 87, brand: 'bionditree' },
      '본문 발췌입니다',
    );
    expect(html).toContain('블로그 초안 검토 대기 · bionditree');
    expect(html).toContain('<b>블루베리 &amp; 관리</b>'); // 제목의 & 이스케이프
    expect(html).toContain('블루베리키우기 · SEO 87점');
    expect(html).toContain('본문 발췌입니다');
    expect(html).toContain('?piece=piece_x');
  });

  it('메타·발췌가 비면 해당 줄을 생략하고, 제목 없으면 미정 표기', () => {
    const html = blogReadyHtml({ id: 'p1' }, '');
    expect(html).toContain('(제목 미정)');
    expect(html).not.toContain('SEO');
    expect(html).toContain(`${studioBase()}/?piece=p1`);
  });

  it('개정 런이면 ↻ 개정본 라벨 — 원본 알림과 구분(중복 오해 방지)', () => {
    expect(blogReadyHtml({ id: 'p1', revised: true }, '')).toContain('↻ 블로그 개정본 검토 대기');
    expect(blogReadyHtml({ id: 'p1' }, '')).toContain('📝 블로그 초안 검토 대기');
  });

  it('브랜드 슬러그도 이스케이프한다(자유 문자열 — & 포함 가능)', () => {
    expect(blogReadyHtml({ id: 'p1', brand: 'a&b' }, '')).toContain('검토 대기 · a&amp;b');
  });
});

describe('cardnewsCaptionHtml', () => {
  it('주제·장수·담당·원본 piece 딥링크를 담는다', () => {
    const cap = cardnewsCaptionHtml({
      id: 'card_1', topic: '하스카프베리 <두 품종>', brand: 'bionditree', slides: 7,
      sourcePieceId: 'piece_src', planner: '김도현', designer: '오세라',
    });
    expect(cap).toContain('카드뉴스 검토 대기 · bionditree');
    expect(cap).toContain('&lt;두 품종&gt;'); // 주제 이스케이프
    expect(cap).toContain('7장 · 김도현·오세라');
    expect(cap).toContain('?piece=piece_src');
  });

  it('독립 생성(원본 piece 없음)이면 스튜디오 홈 링크', () => {
    expect(cardnewsCaptionHtml({ id: 'c', topic: 'T' })).toContain(`${studioBase()}/`);
  });
});

describe('shortsCaptionHtml', () => {
  it('주제·길이·씬 수·담당·딥링크를 담는다', () => {
    const cap = shortsCaptionHtml({
      id: 'short_1', topic: '라벨 확인법', brand: 'bionditree', durationSec: 42, scenes: 6,
      sourcePieceId: 'piece_src', writer: '서다인',
    });
    expect(cap).toContain('쇼츠 검토 대기 · bionditree');
    expect(cap).toContain('42초 · 씬 6개 · 서다인');
    expect(cap).toContain('?piece=piece_src');
  });
});

describe('factGateLines — 텔레그램 보류 표시(스펙 §2-3)', () => {
  it('hold 면 건수와 문장(80자 절단)을 최대 N개', () => {
    const s = factGateLines({ status: 'hold', unsupported: ['a'.repeat(100), 'b'], contradicted: ['c ← 근거: d'], checkedTs: 't' }, 2);
    expect(s.split('\n')[0]).toBe('⚠ 사실 게이트 보류 3건 — 근거 없음 2 · 모순 1');
    expect(s).toContain('• ' + 'a'.repeat(80) + '…');
    expect(s).toContain('• b');
    expect(s).not.toContain('• c ←'); // maxItems 2 — 세 번째 항목은 잘린다
  });
  it('error 는 판정 실패로, pass·미실행은 빈 문자열', () => {
    expect(factGateLines({ status: 'error', unsupported: [], contradicted: [], checkedTs: 't' }, 3)).toBe('⚠ 사실 게이트 판정 실패 — 수동 검토 필요');
    expect(factGateLines({ status: 'pass', unsupported: [], contradicted: [], checkedTs: 't' }, 3)).toBe('');
    expect(factGateLines(undefined, 3)).toBe('');
  });
  // 2026-08-27 지시 ① — 일반 상식 무근거는 보류가 아니라 참고(unverified)로 통과시킨다.
  it('pass 여도 unverified 가 있으면 참고 줄을 낸다(최대 maxItems · 80자 절단)', () => {
    const s = factGateLines({ status: 'pass', unsupported: [], contradicted: [], unverified: ['a'.repeat(100), 'b', 'c'], checkedTs: 't' }, 2);
    expect(s.split('\n')[0]).toBe('✅ 사실 게이트 통과 · 근거 미확인(참고) 3건');
    expect(s).toContain('• 참고: ' + 'a'.repeat(80) + '…');
    expect(s).toContain('• 참고: b');
    expect(s).not.toContain('• 참고: c'); // maxItems 2
  });
  it('hold 는 기존 형식 유지 + 끝에 (참고 M건) — M>0 일 때만', () => {
    const withSoft = factGateLines({ status: 'hold', unsupported: ['x'], contradicted: [], unverified: ['s1', 's2'], checkedTs: 't' }, 2);
    expect(withSoft.split('\n')[0]).toBe('⚠ 사실 게이트 보류 1건 — 근거 없음 1 · 모순 0 (참고 2건)');
    const noSoft = factGateLines({ status: 'hold', unsupported: ['x'], contradicted: [], unverified: [], checkedTs: 't' }, 2);
    expect(noSoft.split('\n')[0]).toBe('⚠ 사실 게이트 보류 1건 — 근거 없음 1 · 모순 0');
  });
  // 파생물(카드·쇼츠)의 보류는 '원문 정합' 지적이지 근거 없음/모순이 아니다(2026-08-26 최종 리뷰 F5b).
  it('breakdown=false 면 내역(근거 없음·모순)을 빼고 건수만', () => {
    const info = { status: 'hold' as const, unsupported: ['원문에 없는 수치'], contradicted: [], checkedTs: 't' };
    expect(factGateLines(info, 2, '원문 정합', false).split('\n')[0]).toBe('⚠ 원문 정합 보류 1건');
    expect(factGateLines(info, 2, '원문 정합', false)).not.toContain('근거 없음');
  });
  // 시기·수치 원문 대조(2026-08-27 권고 1) — 결정적 검사라 LLM 정합 판정이 pass 여도 잔존할 수 있다.
  it('timing 잔존은 pass·hold·error 어디서든 별도 줄로 나온다(최대 2줄 예시)', () => {
    const pass = factGateLines({ status: 'pass', unsupported: [], contradicted: [], timing: ['t1', 't2', 't3'], checkedTs: 't' }, 2, '원문 정합', false);
    expect(pass.split('\n')[0]).toBe('⚠ 원문과 다른 시기·수치 3건');
    expect(pass).toContain('• t1');
    expect(pass).toContain('• t2');
    expect(pass).not.toContain('• t3'); // 예시는 최대 2줄
    const hold = factGateLines({ status: 'hold', unsupported: ['x'], contradicted: [], timing: ['a'.repeat(100)], checkedTs: 't' }, 2, '원문 정합', false);
    expect(hold.split('\n')[0]).toBe('⚠ 원문 정합 보류 1건');
    expect(hold).toContain('⚠ 원문과 다른 시기·수치 1건');
    expect(hold).toContain('• ' + 'a'.repeat(80) + '…');
    const err = factGateLines({ status: 'error', unsupported: [], contradicted: [], timing: ['t1'], checkedTs: 't' }, 2, '원문 정합', false);
    expect(err).toContain('⚠ 원문과 다른 시기·수치 1건');
    // timing 이 없으면 기존 동작 그대로(빈 문자열).
    expect(factGateLines({ status: 'pass', unsupported: [], contradicted: [], timing: [], checkedTs: 't' }, 2)).toBe('');
    // N 은 잔존 '건수'다(예시 캡이 아니다) — 오케스트레이터가 timing 을 5건으로 잘라 8건이 "5건"으로 나가던
    // 결함의 계약면(Fix round 1). 자르기는 표시 시점에만 일어난다.
    const many = factGateLines({ status: 'pass', unsupported: [], contradicted: [], timing: Array.from({ length: 8 }, (_, i) => `t${i}`), checkedTs: 't' }, 2, '원문 정합', false);
    expect(many.split('\n')[0]).toBe('⚠ 원문과 다른 시기·수치 8건');
    expect(many.split('\n')).toHaveLength(3); // 머리줄 + 예시 2줄
  });
  it('쇼츠 캡션에 시기·수치 줄이 실린다', () => {
    const s = shortsCaptionHtml({ id: 's1', topic: 'T', factGate: { status: 'pass', unsupported: [], contradicted: [], timing: ['씬2: "8월"'], checkedTs: 't' } });
    expect(s).toContain('⚠ 원문과 다른 시기·수치 1건');
  });
  it('블로그 메시지·카드 캡션에 들어간다(HTML 이스케이프)', () => {
    const fg = { status: 'hold' as const, unsupported: ['5cm <두께>'], contradicted: [], checkedTs: 't' };
    expect(blogReadyHtml({ id: 'p1', title: 'T', factGate: fg }, '')).toContain('5cm &lt;두께&gt;');
    // 블로그는 내역 유지 — 사실 게이트가 실제로 근거 없음/모순을 판정한 결과라서.
    expect(blogReadyHtml({ id: 'p1', title: 'T', factGate: fg }, '')).toContain('근거 없음 1 · 모순 0');
    // 카드·쇼츠는 건수만(내역 없음) — 정합 지적을 '근거 없음'으로 잘못 읽히지 않게.
    const card = cardnewsCaptionHtml({ id: 'c1', topic: 'T', factGate: fg });
    expect(card).toContain('⚠ 원문 정합 보류 1건');
    expect(card).not.toContain('근거 없음');
    const short = shortsCaptionHtml({ id: 's1', topic: 'T', factGate: fg });
    expect(short).toContain('⚠ 원문 정합 보류 1건');
    expect(short).not.toContain('근거 없음');
  });
});

// 2026-08-27 사용자 확정 — 자동 임시저장이 꺼진 동안엔 알림이 "버튼을 눌러야 저장된다"를 말해야 한다.
// 안 그러면 사람은 예전처럼 '알아서 임시저장됐겠지'로 읽고 글이 영원히 대기만 한다.
describe('blogReadyHtml — 자동 임시저장 off 안내(전면 수동 검토)', () => {
  const MANUAL = '✋ 수동 검토 대기 — 아래 "네이버 임시저장" 버튼으로 저장';

  it('off 면 수동 검토 줄을 넣고, on 이면 기존 문구 그대로', () => {
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', false)).toContain(MANUAL);
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', true)).not.toContain('✋');
  });

  it('사실 게이트 줄 아래·발췌 위에 온다(보류 사유를 먼저 읽고 버튼을 누르게)', () => {
    const fg = { status: 'hold' as const, unsupported: ['근거 없는 문장'], contradicted: [], checkedTs: 't' };
    const html = blogReadyHtml({ id: 'p1', title: 'T', factGate: fg }, '본문 발췌', false);
    expect(html.indexOf(MANUAL)).toBeGreaterThan(html.indexOf('사실 게이트'));
    expect(html.indexOf(MANUAL)).toBeLessThan(html.indexOf('본문 발췌'));
  });

  it('사실 게이트 줄이 없어도(통과·미실행) 제목 아래·발췌 위에 놓인다', () => {
    const html = blogReadyHtml({ id: 'p1', title: 'T' }, '본문 발췌', false);
    expect(html).not.toContain('사실 게이트');
    expect(html.indexOf(MANUAL)).toBeGreaterThan(html.indexOf('<b>T</b>'));
    expect(html.indexOf(MANUAL)).toBeLessThan(html.indexOf('본문 발췌'));
  });
});

// 문체 린트 잔존(2026-08-27 권고 3) — 수정 1회 뒤에도 남은 지적 건수를 검토 메시지에 1줄로 알린다.
// 발행을 막지 않는 표시 전용이라 사실 게이트 줄 옆에 붙고, 0건이면 줄 자체가 없다.
describe('blogReadyHtml — 문체 린트 잔존 줄(2026-08-27 권고 3)', () => {
  it('잔존 건수가 있으면 ✍ 문체 N건 잔존 줄이 붙는다', () => {
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', false, 2)).toContain('✍ 문체 2건 잔존');
  });
  it('0건이면 줄이 없다(기존 메시지 그대로)', () => {
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', false, 0)).not.toContain('문체');
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', false)).not.toContain('문체');
  });
  it('사실 게이트 줄 옆(아래)·수동 검토 안내 위에 온다', () => {
    const fg = { status: 'hold' as const, unsupported: ['근거 없는 문장'], contradicted: [], checkedTs: 't' };
    const html = blogReadyHtml({ id: 'p1', title: 'T', factGate: fg }, '본문 발췌', false, 1);
    expect(html.indexOf('✍ 문체 1건 잔존')).toBeGreaterThan(html.indexOf('사실 게이트'));
    expect(html.indexOf('✍ 문체 1건 잔존')).toBeLessThan(html.indexOf('✋'));
  });
});

describe('briefGateLines — 브리프 게이트 표시(2026-08-28)', () => {
  const rec = (over = {}) => ({
    verdict: 'revision_needed', score: 43, maxScore: 70, rounds: 1,
    unresolved: ['"손질강도" 수치는 브리프 어디에도 근거가 없다', '향나무 중간기주 관계를 공식 자료로 확인'],
    checkedTs: 't', ...over,
  });

  it('반려면 점수·미해소 건수를 낸다', () => {
    const s = briefGateLines(rec());
    expect(s).toContain('⚖ 브리프 반려 43/70 · 미해소 2건');
    expect(s).toContain('• "손질강도" 수치는 브리프 어디에도 근거가 없다');
  });

  it('통과·미기록이면 줄이 없다 — 정상은 알리지 않는다', () => {
    expect(briefGateLines(rec({ verdict: 'approved', unresolved: [] }))).toBe('');
    expect(briefGateLines(null)).toBe('');
    expect(briefGateLines(undefined)).toBe('');
  });

  it('미파싱은 "검증 미작동"으로 알린다 — 조용히 넘기면 검증됐다고 오해한다', () => {
    expect(briefGateLines(rec({ verdict: 'unparsed', score: null, maxScore: null, unresolved: [] })))
      .toContain('⚖ 브리프 판정 미파싱 — 검증 미작동');
  });

  it('점수를 못 읽었으면 점수 없이 낸다', () => {
    expect(briefGateLines(rec({ score: null, maxScore: null }))).toContain('⚖ 브리프 반려 · 미해소 2건');
  });

  it('지적은 최대 2건까지·80자에서 자른다', () => {
    const many = briefGateLines(rec({ unresolved: ['a', 'b', 'c', 'd'] }));
    expect(many.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(2);
    expect(briefGateLines(rec({ unresolved: ['가'.repeat(200)] }))).toContain('…');
  });
});

describe('blogReadyHtml — 브리프 게이트 줄 배치(2026-08-28)', () => {
  const gate = {
    verdict: 'revision_needed', score: 43, maxScore: 70, rounds: 1,
    unresolved: ['무근거 수치'], checkedTs: 't',
  };

  it('사실 게이트 아래·문체 위에 온다(심각도 순)', () => {
    const fg = { status: 'hold' as const, unsupported: ['근거 없는 문장'], contradicted: [], checkedTs: 't' };
    const html = blogReadyHtml({ id: 'p1', title: 'T', factGate: fg }, '발췌', false, 2, gate);
    expect(html.indexOf('브리프 반려')).toBeGreaterThan(html.indexOf('사실 게이트'));
    expect(html.indexOf('브리프 반려')).toBeLessThan(html.indexOf('✍ 문체'));
    expect(html.indexOf('브리프 반려')).toBeLessThan(html.indexOf('✋'));
  });

  it('기록이 없으면 기존 메시지 그대로다(회귀 0)', () => {
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', false, 0)).not.toContain('브리프');
    expect(blogReadyHtml({ id: 'p1', title: 'T' }, '', false, 0, null)).not.toContain('브리프');
  });
});
