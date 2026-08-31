import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyShortsRevision, trimPlanToBudget, pruneQuoteSources, restoreLostHedges, HEDGE_RE, timingFields, pickTitleTypes, TITLE_TYPE_POOL, shortsTitleTypeGuide, descriptionLintIssues } from './shorts';
import { ShortsStore } from '../content/shorts';

type ShortsPlan = Parameters<typeof applyShortsRevision>[0];

describe('trimPlanToBudget — 결정적 트리밍(생성 실패 금지의 예산 보장, 2026-08-20)', () => {
  const mk = (narrs: string[]): ShortsPlan => ({
    title: '제목', titles: ['제목'], description: '설명', hashtags: ['#a'],
    scenes: narrs.map((n, i) => ({ narration: n, screenText: `t${i}` })),
  });
  it('예산 이내면 무변화(trimmed=false, 전 씬 유지)', () => {
    const p = mk(['훅.', '전제.', '본문.', '마무리.']);
    const r = trimPlanToBudget(p, 999);
    expect(r.trimmed).toBe(false);
    expect(r.keptScenes).toEqual([0, 1, 2, 3]);
  });
  it('1단계: 본문 씬의 마지막 문장부터 깎아 예산을 맞춘다(훅·CTA 문장 보존)', () => {
    const p = mk(['훅 문장입니다.', '전제 문장입니다.', '방법 문장입니다. 이유 문장입니다.', 'CTA 문장입니다.']);
    const before = p.scenes.reduce((s, x) => s + x.narration.length, 0);
    const r = trimPlanToBudget(p, before - 5);
    expect(r.trimmed).toBe(true);
    expect(r.plan.scenes[2]!.narration).toBe('방법 문장입니다.'); // 뒤 문장 제거
    expect(r.plan.scenes[0]!.narration).toBe('훅 문장입니다.');
    expect(r.keptScenes).toEqual([0, 1, 2, 3]); // 씬 수 유지
  });
  it('2단계: 문장으로 모자라면 뒤쪽 본문 씬을 통째 제거 — keptScenes 가 원본 인덱스를 준다', () => {
    const p = mk(['훅번째문장입니다.', '전제번째문장입니다.', '본문하나입니다.', '본문둘입니다.', '본문셋입니다.', 'CTA입니다.']);
    const r = trimPlanToBudget(p, 45); // 전체 ~50자 → 씬 제거 필요
    expect(r.trimmed).toBe(true);
    expect(r.plan.scenes.length).toBeLessThan(6);
    expect(r.keptScenes[0]).toBe(0); // 훅 보존
    expect(r.keptScenes[r.keptScenes.length - 1]).toBe(5); // CTA 보존
    expect(r.plan.scenes.length).toBeGreaterThanOrEqual(4); // 최소 4씬
  });
  it('최소 구성(4씬·전 씬 1문장)에서는 더 깎지 않고 멈춘다(생성 우선 — 무한루프 없음)', () => {
    const p = mk(['훅.', '전제.', '본문.', 'CTA.']);
    const r = trimPlanToBudget(p, 3);
    expect(r.plan.scenes.length).toBe(4);
  });
});

describe('applyShortsRevision — 수정 요청 개정안 적용(순수)', () => {
  const base: ShortsPlan = {
    title: '원제목', titles: ['원제목', '후보2'], description: '설명', hashtags: ['#a'],
    scenes: [
      { narration: 'n1', screenText: 't1' },
      { narration: 'n2', screenText: 't2' },
    ],
  };
  it('내레이션 교체 → changedScenes, 배경 재생성 아님', () => {
    const r = applyShortsRevision(base, { scenes: [{ index: 1, narration: '새 내레이션' }] });
    expect(r).not.toBeNull();
    expect(r!.changedScenes).toEqual([1]);
    expect(r!.regenScenes).toEqual([]);
    expect(r!.plan.scenes[0]!.narration).toBe('새 내레이션');
    expect(r!.plan.scenes[0]!.screenText).toBe('t1'); // 미지정 보존
  });
  it('regen_image 씬은 regenScenes + image_note 보관', () => {
    const r = applyShortsRevision(base, { scenes: [{ index: 2, regen_image: true, image_note: '화분을 테라코타로' }] });
    expect(r!.regenScenes).toEqual([2]);
    expect(r!.changedScenes).toEqual([2]);
    expect(r!.imageNotes.get(2)).toBe('화분을 테라코타로');
  });
  it('제목 변경은 titleChanged, 유효 변경 없으면 null', () => {
    expect(applyShortsRevision(base, { title: '새 제목' })!.titleChanged).toBe(true);
    expect(applyShortsRevision(base, { title: '원제목' })).toBeNull();
    expect(applyShortsRevision(base, { scenes: [{ index: 5, narration: 'x' }] })).toBeNull();
    expect(applyShortsRevision(base, null)).toBeNull();
  });
  it('titleArt 캘리 문구 변경 — 실변경만 인정, 미지정 필드는 현행 유지', () => {
    const cur = { line1: '묘목 식재 준비', line2: '손끝으로 답 찾기', points: ['활착 가르는 손끝 감각'] };
    const r = applyShortsRevision(base, { titleArt: { line2: '흙덩이가 알려주는 답' } }, cur);
    expect(r!.titleArtCopy).toEqual({ line1: '묘목 식재 준비', line2: '흙덩이가 알려주는 답', points: ['활착 가르는 손끝 감각'] });
    expect(r!.titleChanged).toBe(false); // plan.title 은 무변경
  });
  it('titleArt — 동일 문구·현 카피 부재는 무변경(null)', () => {
    const cur = { line1: '묘목 식재 준비', line2: '손끝으로 답 찾기', points: ['p'] };
    expect(applyShortsRevision(base, { titleArt: { line2: '손끝으로 답 찾기' } }, cur)).toBeNull();
    expect(applyShortsRevision(base, { titleArt: { line2: '새 훅' } })).toBeNull(); // 현 카피 없음 → 무시
    expect(applyShortsRevision(base, { titleArt: { line2: '새 훅' } }, null)).toBeNull();
  });
});

const P = (scenes: Array<Record<string, unknown>>) => ({ title: 't', titles: ['t'], scenes, description: '', hashtags: [] }) as never;
describe('pruneQuoteSources — 원문에 없는 출처 라벨 제거(스펙 §6a)', () => {
  it('원문에 문자열이 있으면 유지, 없으면 source 만 삭제, 원문 없으면 전부 삭제', () => {
    const plan = P([
      { narration: 'a', kind: 'quote', quote: { text: 'q1', source: '농사로' } },
      { narration: 'b', kind: 'quote', quote: { text: 'q2', source: '재배 기록' } },
      { narration: 'c' },
    ]);
    const r = pruneQuoteSources(plan, '농사로 자료에 따르면 …');
    expect(r.pruned).toBe(1);
    expect(r.plan.scenes[0]!.quote).toEqual({ text: 'q1', source: '농사로' });
    expect(r.plan.scenes[1]!.quote).toEqual({ text: 'q2' });
    expect(pruneQuoteSources(plan, undefined).pruned).toBe(2);
  });
});
describe('timingFields — 시기·수치 대조 입력(권고 1)', () => {
  it('내레이션·자막·dataviz 오버레이 값·설명을 전부 필드로 낸다', () => {
    const plan = {
      title: 'T', titles: ['T'], description: '9월 기준 설명', hashtags: ['#a'],
      scenes: [
        { narration: '훅입니다', screenText: '훅' },
        { narration: '수치 씬', kind: 'stat' as const, stat: { value: 8, unit: '월', label: '식재 시작' } },
        { narration: '차트 씬', kind: 'chart' as const, chart: { series: [{ label: '봄', value: 90 }, { label: '가을', value: 70 }], unit: '%' } },
      ],
    } as unknown as ShortsPlan;
    expect(timingFields(plan)).toEqual([
      { field: '씬1 내레이션', text: '훅입니다' },
      { field: '씬1 자막', text: '훅' },
      { field: '씬2 내레이션', text: '수치 씬' },
      { field: '씬2 오버레이', text: '8월 식재 시작' },
      { field: '씬3 내레이션', text: '차트 씬' },
      { field: '씬3 차트', text: '봄 90%, 가을 70%' },
      { field: '설명', text: '9월 기준 설명' },
    ]);
  });

  // 결론 카드(2026-08-28) — 사용자 확정 분업에서 답은 화면에만 있다. 대조에서 빠지면 검증 안 받은
  // 답이 화면으로 나간다(다른 오버레이는 전부 실리는데 이것만 빠져 있었다).
  it('CTA 결론 카드도 대조 대상에 싣는다 — 화면이 답을 단독으로 지기 때문', () => {
    const plan = {
      title: 'T', titles: ['T'], description: '', hashtags: [],
      scenes: [
        { narration: '기준만 말합니다', screenText: '두 기준', kind: 'cta' as const,
          takeaways: [{ when: '무릎~허리', then: '회양목' }, { when: '어깨 상록', then: '사철나무' }] },
      ],
    } as unknown as ShortsPlan;
    expect(timingFields(plan)).toEqual([
      { field: '씬1 내레이션', text: '기준만 말합니다' },
      { field: '씬1 자막', text: '두 기준' },
      { field: '씬1 결론', text: '무릎~허리 → 회양목, 어깨 상록 → 사철나무' },
    ]);
  });

  it('takeaways 가 없는 CTA 는 결론 필드를 만들지 않는다(회귀 0)', () => {
    const plan = {
      title: 'T', titles: ['T'], description: '', hashtags: [],
      scenes: [{ narration: '마무리', kind: 'cta' as const }],
    } as unknown as ShortsPlan;
    expect(timingFields(plan)).toEqual([{ field: '씬1 내레이션', text: '마무리' }]);
  });
});
describe('applyShortsRevision — quote 편집', () => {
  it('kind=quote 씬만 text·source 를 바꾼다', () => {
    const plan = P([{ narration: 'a', kind: 'quote', quote: { text: 'old', source: 's' } }, { narration: 'b' }]);
    const r = applyShortsRevision(plan, { scenes: [{ index: 1, quote: { text: 'new', source: '농사로' } }, { index: 2, quote: { text: 'x' } }] });
    expect(r?.plan.scenes[0]!.quote).toEqual({ text: 'new', source: '농사로' });
    expect(r?.plan.scenes[1]!.quote).toBeUndefined();
    expect(r?.changedScenes).toEqual([1]);
  });
});
describe('restoreLostHedges — 압축이 유보어를 지우면 원문장 유지(스펙 §6b, 결론 반전 실측 2건)', () => {
  it('유보 토큰이 있던 씬이 압축본에서 사라지면 원 내레이션으로 되돌린다', () => {
    const before = P([{ narration: '잎이 대체로 멀쩡하면 거름은 잎이 진 뒤로 미루고 봐요.' }, { narration: '물은 아침에 주세요.' }]);
    const after = P([{ narration: '잎이 멀쩡할 때만 거름을 주세요.' }, { narration: '물은 아침에.' }]);
    const r = restoreLostHedges(before, after);
    expect(r.restored).toEqual([1]);
    expect(r.plan.scenes[0]!.narration).toBe('잎이 대체로 멀쩡하면 거름은 잎이 진 뒤로 미루고 봐요.');
    expect(r.plan.scenes[1]!.narration).toBe('물은 아침에.');
  });
  it('압축본이 유보어를 지켰거나 원문에 유보어가 없으면 그대로', () => {
    const before = P([{ narration: '대개 물 쪽 문제예요.' }]);
    const after = P([{ narration: '대개 물 문제예요.' }]);
    expect(restoreLostHedges(before, after).restored).toEqual([]);
  });
  // 수종명 오탐(2026-08-26 최종 리뷰 F5d) — '미루나무'는 유보어가 아니다. 오탐이면 압축된 씬이
  // 통째로 원문장으로 되돌아가 길이 예산(40초)을 깨뜨린다.
  it("'미루나무'만 든 내레이션은 유보 문장으로 보지 않는다", () => {
    expect(HEDGE_RE.test('미루나무는 물가에서 빨리 자랍니다.')).toBe(false);
    expect(HEDGE_RE.test('전정은 잎이 진 뒤로 미루고 봅니다.')).toBe(true); // 진짜 유보는 유지
    const before = P([{ narration: '미루나무는 물가에서 빨리 자랍니다.' }]);
    const after = P([{ narration: '미루나무는 빨리 자랍니다.' }]);
    expect(restoreLostHedges(before, after).restored).toEqual([]);
  });
});

// ── 2026-08-27 말투 감사 권고 5 — 제목 후보 유형 로테이션(고정 3종 → 5종 풀, 질문형 상한) ────
describe('pickTitleTypes — 런별 제목 유형 선택·질문형 상한', () => {
  /** 결정적 난수 — 같은 값을 되풀이해 선택 경로를 고정한다. */
  const fixed = (v: number) => () => v;

  it('항상 3개를 중복 없이 유형 풀에서 고른다', () => {
    const t = pickTitleTypes([], { rand: fixed(0) });
    expect(t).toHaveLength(3);
    expect(new Set(t).size).toBe(3);
    t.forEach((x) => expect(TITLE_TYPE_POOL as readonly string[]).toContain(x));
  });

  it('최근 3편 중 1편이라도 질문형을 썼으면 이번 런에서 질문형을 뺀다', () => {
    const recent = [['가을에 묘목 심어도 될까요?'], ['묘목 고르는 법'], ['겨울 전정 순서']];
    for (let i = 0; i < 50; i++) expect(pickTitleTypes(recent)).not.toContain('질문형');
  });

  it('최근 3편에 질문형이 없으면 질문형도 후보로 남는다', () => {
    const recent = [['묘목 고르는 법'], ['겨울 전정 순서']];
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) pickTitleTypes(recent).forEach((x) => seen.add(x));
    expect(seen.has('질문형')).toBe(true);
  });

  it('상한 판정 창은 최근 3편까지 — 4편째의 질문형은 세지 않는다', () => {
    const recent = [['묘목 고르는 법'], ['겨울 전정 순서'], ['잎이 노랗게 변한 이유'], ['지금 심어도 될까요?']];
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) pickTitleTypes(recent).forEach((x) => seen.add(x));
    expect(seen.has('질문형')).toBe(true);
  });

  it('키워드가 있는 런은 정보형을 반드시 포함한다(키워드 정확 표기 규칙 유지)', () => {
    for (let i = 0; i < 100; i++) expect(pickTitleTypes([], { keywordFirst: true })).toContain('정보형');
  });
});

// Fix wave(2026-08-27, 소견 3) — 5종 유형 정의 줄은 base(194bed6d) 프롬프트에 없던 줄이다(약 150자).
// VOICE_ROTATION=off 면 제목 유형은 종전 고정 3종으로 돌아가는데 정의 줄만 남아 base 와 달랐다.
describe('shortsTitleTypeGuide — 제목 유형 정의 줄(VOICE_ROTATION)', () => {
  it('off 면 줄 자체가 빠진다(base 프롬프트엔 없던 줄)', () => {
    expect(shortsTitleTypeGuide(['정보형', '후킹형', '질문형'], false)).toBe('');
  });
  it('on 이면 이번 런이 고른 3유형 순서와 5종 정의가 실린다', () => {
    const s = shortsTitleTypeGuide(['정보형', '결론형', '장면형'], true);
    expect(s).toContain('정보형 / 결론형 / 장면형');
    expect(s).toContain('장면형=');
    expect(s).toContain('결론형=');
  });
});

// Fix wave(2026-08-27, 소견 4) — 권고 2 가 새로 만든 검사에 되돌릴 레버가 없었다(다른 넷은 전부 게이트를 가진다).
describe('descriptionLintIssues — 설명 요약투 검사(META_SUMMARY_LINT)', () => {
  const bad = '가을 묘목 심는 법을 정리했습니다.';
  it('on 이면 요약투를 잡아 수정 라운드로 넘긴다(최대 1건)', () => {
    expect(descriptionLintIssues(bad, true)).toHaveLength(1);
  });
  it('off 면 빈 배열 — 검사와 재생성 합류가 함께 멈춘다', () => {
    expect(descriptionLintIssues(bad, false)).toEqual([]);
  });
  it('깨끗한 설명은 어느 쪽이든 통과', () => {
    const ok = '잎이 상한 나무는 9월에 비료를 줘도 소용없습니다. 갈변이 어디서 시작됐는지부터 보세요.';
    expect(descriptionLintIssues(ok, true)).toEqual([]);
  });
});

// 이 파일의 리더들(recentHooksToAvoid·recentShortsTitles)이 기대는 스토어 계약 — 방향이 뒤집히면
// '최근 5편' 주입이 조용히 '가장 오래된 5편'이 된다(2026-08-27 실측 결함, 회귀 방지).
describe('ShortsStore.list() — createdTs 내림차순(최신순) 고정', () => {
  it('최신 항목을 먼저 돌려준다 — 리더는 .reverse() 하면 안 된다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-store-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([
        { id: 'old', topic: '옛 편', stage: 'ready', createdTs: '2026-07-13T00:00:00.000Z', updatedTs: '2026-07-13T00:00:00.000Z' },
        { id: 'mid', topic: '중간 편', stage: 'ready', createdTs: '2026-08-01T00:00:00.000Z', updatedTs: '2026-08-01T00:00:00.000Z' },
        { id: 'new', topic: '최신 편', stage: 'ready', createdTs: '2026-08-26T00:00:00.000Z', updatedTs: '2026-08-26T00:00:00.000Z' },
      ]), 'utf-8');
      expect(new ShortsStore(dir).list().map((e) => e.id)).toEqual(['new', 'mid', 'old']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
