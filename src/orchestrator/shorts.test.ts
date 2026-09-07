import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyShortsRevision, trimPlanToBudget, pruneQuoteSources, restoreLostHedges, HEDGE_RE, timingFields, pickTitleTypes, TITLE_TYPE_POOL, shortsTitleTypeGuide, descriptionLintIssues, buildSceneImagePrompt, diversifyTitle, titleShape, normalizeLatinName } from './shorts';
import { ShortsStore } from '../content/shorts';
import { subjectTraits } from '../content/brand';

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

describe('buildSceneImagePrompt — 촬영 지시 변주', () => {
  const base = { style: '가을빛 수채화', scene: '수국 앞에서 가위를 든 손', total: 4 };

  it('시드가 없으면 종전 문구 그대로', () => {
    const t = buildSceneImagePrompt({ ...base, index: 1 });
    expect(t).toContain('얕은 심도와 부드러운 조명');
    expect(t).toContain('구도: 세로 9:16 프레임을 피사체로 자연스럽게 채운다.');
  });
  it('시드를 주면 조명·심도·앵글·생활감 지시가 붙는다', () => {
    const t = buildSceneImagePrompt({ ...base, index: 1, seed: 'short_a' });
    expect(t).toContain('빛과 심도(전 씬 동일)');
    expect(t).toContain('생활감:');
    expect(t).toMatch(/구도: 세로 9:16\. .+ 담는다\./);
  });
  it('빛·심도는 한 편 안에서 모든 씬이 같다 — 시리즈 일관성 유지', () => {
    const light = (i: number) => buildSceneImagePrompt({ ...base, index: i, seed: 'short_a' })
      .split('\n').find((l) => l.startsWith('빛과 심도'));
    expect(new Set([0, 1, 2, 3].map(light)).size).toBe(1);
  });
  it('앵글·생활감은 씬마다 갈린다 — 한 편 안에서도 화면이 바뀐다', () => {
    const frame = (i: number) => buildSceneImagePrompt({ ...base, index: i, seed: 'short_a' })
      .split('\n').filter((l) => l.startsWith('구도') || l.startsWith('생활감')).join();
    expect(new Set([0, 1, 2, 3].map(frame)).size).toBeGreaterThan(1);
  });
  it('편이 다르면 빛·심도가 갈린다 — 176편이 같은 조명을 받던 문제', () => {
    const light = (id: string) => buildSceneImagePrompt({ ...base, index: 1, seed: id })
      .split('\n').find((l) => l.startsWith('빛과 심도'));
    const seen = new Set(Array.from({ length: 30 }, (_, i) => light(`short_${i}`)));
    expect(seen.size).toBeGreaterThan(3);
  });
  it('글자 금지·손 왜곡 방어는 시드와 무관하게 항상 붙는다', () => {
    for (const seed of [undefined, 'short_a', 'short_b']) {
      const t = buildSceneImagePrompt({ ...base, index: 0, seed });
      expect(t).toContain('글자·자막·숫자·로고·워터마크');
      expect(t).toContain('손·손가락 왜곡');
      expect(t).toContain('[전 씬 공통 스타일] 가을빛 수채화');
    }
  });
});

describe('diversifyTitle — 대표 제목 구조 수렴 차단', () => {
  const recent = [
    '상토 배양토 차이 몰라도, 포대 수는 이렇게 계산해요',
    '수국 9월 관리, 이번 달엔 이것만 정해요',
    '산수유 열매 적을 때, 지금 확인할 순서',
  ];

  it('실사고 재현 — 후보가 전부 무쉼표인데 대표만 쉼표였던 short_5b5f7f4231', () => {
    const title = '측백나무 생울타리, 몇 그루인지 줄자로 끝냅니다';
    const cands = [
      '측백나무 생울타리 그루 수 계산법',
      '측백나무 그루 수는 폭과 길이로 나옵니다',
      '측백나무 심는데 왜 그루 수부터 세야 할까요',
    ];
    const out = diversifyTitle(title, cands, recent, '측백나무');
    expect(out).not.toBe(title);
    expect(out).not.toContain(',');
    expect(out).toContain('측백나무'); // 키워드 규칙은 지킨다
  });
  it('키워드 없는 후보는 안 고른다 — 검색 노출 자산이 우선', () => {
    const title = '수국 9월 관리, 이것만 정해요';
    const cands = ['가지를 자를지 둘지 먼저 정합니다']; // 키워드 없음
    expect(diversifyTitle(title, cands, recent, '수국')).toBe(title);
  });
  it('최근 것들과 꼴이 다르면 그대로 둔다', () => {
    const title = '측백나무 그루 수는 폭으로 정해집니다'; // plain
    expect(diversifyTitle(title, ['측백나무 계산법, 이렇게'], recent, '측백나무')).toBe(title);
  });
  it('바꿀 후보가 없으면 원본 유지(fail-open)', () => {
    const title = '수국 9월 관리, 이것만 정해요';
    expect(diversifyTitle(title, ['수국 관리, 다른 쉼표 제목'], recent, '수국')).toBe(title);
    expect(diversifyTitle(title, [], recent, '수국')).toBe(title);
  });
  it('최근 표본이 3편 미만이면 개입하지 않는다', () => {
    const title = '수국 9월 관리, 이것만 정해요';
    expect(diversifyTitle(title, ['수국 관리는 이렇게 합니다'], recent.slice(0, 2), '수국')).toBe(title);
  });
  it('최근 과반이 같은 꼴일 때만 개입한다', () => {
    const mixed = ['수국 관리는 이렇습니다', '산수유 열매가 적은 이유', '상토 차이, 뒷면을 보세요'];
    const title = '측백나무 생울타리, 줄자로 끝냅니다'; // comma — mixed 중 1/3 만 comma
    expect(diversifyTitle(title, ['측백나무 그루 수 계산법'], mixed, '측백나무')).toBe(title);
  });
  it('titleShape — 물음표·쉼표·평서를 가른다', () => {
    expect(titleShape('수국 언제 자를까요?')).toBe('question');
    expect(titleShape('수국 9월 관리, 이것만')).toBe('comma');
    expect(titleShape('수국은 9월에 결정됩니다')).toBe('plain');
  });
});

describe('buildSceneImagePrompt — 소재 앵커', () => {
  const base = { style: '플랫 디자인', scene: '담장 위 작은 나무들', index: 2, total: 4 };
  const SUBJ = '측백나무 — 비늘 모양 잎의 침엽수, 원뿔형 수형';

  it('subject 를 주면 씬 묘사보다 먼저 종을 못박는다', () => {
    const t = buildSceneImagePrompt({ ...base, subject: SUBJ });
    expect(t).toContain('[대상 소재');
    expect(t).toContain('측백나무');
    expect(t.indexOf('[대상 소재')).toBeLessThan(t.indexOf('장면(씬'));
  });
  it('시드 유무와 무관하게 항상 걸린다 — 수종 정확성은 연출 변주와 별개다', () => {
    for (const seed of [undefined, 'short_a']) {
      expect(buildSceneImagePrompt({ ...base, seed, subject: SUBJ })).toContain('[대상 소재');
    }
  });
  it('subject 가 없으면 앵커 줄이 안 붙는다(종전 동작)', () => {
    expect(buildSceneImagePrompt(base)).not.toContain('[대상 소재');
  });
  it('실사고 재현 — 씬 묘사가 "작은 나무들"뿐이어도 종이 프롬프트에 남는다', () => {
    // short_5b5f7f4231: 4씬 중 1씬만 수종명을 적었고 나머지는 "생울타리"·"작은 나무 아이콘들"
    // 이라 활엽수가 나왔다(측백나무는 침엽수).
    const t = buildSceneImagePrompt({ style: '플랫', scene: '담장 위에 일정 간격으로 배치된 작은 나무 아이콘들', index: 2, total: 4, subject: SUBJ });
    expect(t).toContain('침엽수');
  });
});

describe('normalizeLatinName — 학명만 통과시킨다', () => {
  it('정상 학명', () => {
    expect(normalizeLatinName('Nandina domestica')).toBe('Nandina domestica');
    expect(normalizeLatinName('Platycladus orientalis')).toBe('Platycladus orientalis');
  });
  it('군더더기를 떼어낸다', () => {
    expect(normalizeLatinName('Nandina domestica (남천)')).toBe('Nandina domestica');
    expect(normalizeLatinName('  Cornus officinalis  ')).toBe('Cornus officinalis');
    expect(normalizeLatinName('Hydrangea macrophylla var. serrata')).toBe('Hydrangea macrophylla');
  });
  it('학명이 아니면 버린다 — 틀린 학명은 없느니만 못하다', () => {
    for (const bad of ['남천', '나무', '', 'nandina domestica', 'Nandina', 'N. domestica', '123 456']) {
      expect(normalizeLatinName(bad)).toBe('');
    }
  });
});

describe('buildSceneImagePrompt — 학명 앵커', () => {
  const base = { style: '수채화', scene: '마당의 나무', index: 2, total: 4 };
  it('학명이 있으면 앞에 세운다', () => {
    const t = buildSceneImagePrompt({ ...base, subjectLatin: 'Nandina domestica', subject: '남천 — 깃꼴겹잎' });
    expect(t).toContain('Nandina domestica');
    expect(t).toContain('남천');
    expect(t.indexOf('Nandina')).toBeLessThan(t.indexOf('장면(씬'));
  });
  it('학명만 있어도 앵커가 붙는다', () => {
    expect(buildSceneImagePrompt({ ...base, subjectLatin: 'Nandina domestica' })).toContain('[대상 소재');
  });
  it('둘 다 없으면 앵커 줄이 없다', () => {
    expect(buildSceneImagePrompt(base)).not.toContain('[대상 소재');
  });
  // 특징 축은 브랜드가 준다(2026-09-07 범용화) — 원예 브랜드면 '잎 모양·잎차례·수형·계절 색',
  // 미설정이면 업종 중립 기본. 앵커 줄이 그 축을 그대로 지시하는지만 본다.
  it('특징 축까지 지시한다 — 남천을 손바닥잎으로 그린 실사고 대응', () => {
    expect(buildSceneImagePrompt({ ...base, subjectLatin: 'Nandina domestica' })).toContain(subjectTraits());
  });
});

describe('buildSceneImagePrompt — 종 레퍼런스·도구 금지(2026-09-06)', () => {
  const base = { style: '자연광', scene: '줄기 구조', index: 1, total: 4, seed: 's1' };
  it('레퍼런스가 붙으면 팔레트가 아니라 실물이라고 못박는다', () => {
    // 실측: 앵커에 "잎맥 세 개"·"지그재그 수형"을 다 적어도 종이 틀렸다. 실물 프레임 한 장이
    // 붙자 맞았다. 참조를 스타일로만 읽히면 그 효과가 사라진다.
    const p = buildSceneImagePrompt({ ...base, subjectLatin: 'Ziziphus jujuba', speciesRef: true });
    expect(p).toContain('이 종의 실물');
    expect(p).toContain('잎맥이 뻗는 방향');
    expect(p).toContain('구도·배치·피사체는 복제하지 말고'); // 전 씬이 같은 그림이 되면 안 된다
  });
  it('레퍼런스가 없으면 그 줄은 안 나온다', () => {
    expect(buildSceneImagePrompt({ ...base, subjectLatin: 'Ziziphus jujuba' })).not.toContain('이 종의 실물');
  });
  it('도구는 언제나 금지 — 가위 날·축이 물리적으로 불가능하게 그려졌다', () => {
    const p = buildSceneImagePrompt(base);
    expect(p).toContain('[도구]');
    expect(p).toContain('가위·톱·삽');
  });
  it('생활감이 도구를 부르지 않는다 — 도구 금지와 모순되면 안 된다', () => {
    for (let i = 0; i < 12; i++) {
      const p = buildSceneImagePrompt({ ...base, index: i, total: 12, seed: `seed${i}` });
      const line = p.split('\n').find((l) => l.startsWith('생활감:')) ?? '';
      expect(line, line).not.toContain('도구');
    }
  });
  it('화분 소품은 화분 주제에서만 — 노지 편에 나오면 종이 틀어진다', () => {
    for (let i = 0; i < 12; i++) {
      const line = buildSceneImagePrompt({ ...base, index: i, total: 12, seed: `s${i}` })
        .split('\n').find((l) => l.startsWith('생활감:')) ?? '';
      expect(line, line).not.toContain('화분');
    }
    const potted = Array.from({ length: 12 }, (_, i) =>
      buildSceneImagePrompt({ ...base, index: i, total: 12, seed: `s${i}`, potted: true })
        .split('\n').find((l) => l.startsWith('생활감:')) ?? '');
    expect(potted.some((l) => l.includes('화분'))).toBe(true);
  });
});
