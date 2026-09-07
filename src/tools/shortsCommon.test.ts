import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { sceneDurationSec, sceneFrames, fmtSrtTime, buildSrt, normalizeSceneKind, resolveClipSrc, cutAtWordBoundary, emptyKindScenes, dropEmptyKinds, bodyKindCoverage, defaultSceneFx, fxSeed, varyLayout } from './shortsCommon';

describe('sceneDurationSec — 오디오가 길이 지배 + 하한 클램프', () => {
  it('오디오 + 꼬리여백(0.6), 하한 2.8', () => {
    expect(sceneDurationSec(5)).toBeCloseTo(5.6, 5);
    expect(sceneDurationSec(1)).toBeCloseTo(2.8, 5);
    expect(sceneDurationSec(0)).toBeCloseTo(2.8, 5);
    expect(sceneDurationSec(-1)).toBeCloseTo(2.8, 5);
  });
});
describe('sceneFrames — 30fps 반올림', () => {
  it('초 × 30 반올림', () => {
    expect(sceneFrames(2.8)).toBe(84);
    expect(sceneFrames(5.6)).toBe(168);
    expect(sceneFrames(3.017)).toBe(91);
  });
});
describe('fmtSrtTime — SRT 타임코드', () => {
  it('HH:MM:SS,mmm', () => {
    expect(fmtSrtTime(0)).toBe('00:00:00,000');
    expect(fmtSrtTime(3.5)).toBe('00:00:03,500');
    expect(fmtSrtTime(3661.25)).toBe('01:01:01,250');
  });
});
describe('buildSrt — 누적 타이밍', () => {
  it('씬 순서대로 누적 시작/끝', () => {
    expect(buildSrt([
      { narration: '첫 씬', durationSec: 3 },
      { narration: '둘째 씬', durationSec: 2 },
    ])).toBe('1\n00:00:00,000 --> 00:00:03,000\n첫 씬\n\n2\n00:00:03,000 --> 00:00:05,000\n둘째 씬\n');
  });
});
describe('normalizeSceneKind — 검증 추출, 실패 시 {} 강등', () => {
  it('hook/cta 는 페이로드 없이 통과, 대소문자·공백 정규화', () => {
    expect(normalizeSceneKind({ kind: 'hook' })).toEqual({ kind: 'hook' });
    expect(normalizeSceneKind({ kind: ' CTA ' })).toEqual({ kind: 'cta' });
  });
  it('미지 kind·kind 없음 은 {}', () => {
    expect(normalizeSceneKind({ kind: 'banner' })).toEqual({});
    expect(normalizeSceneKind({})).toEqual({});
    expect(normalizeSceneKind(null)).toEqual({});
  });
  it('stat — 콤마 문자열 파싱, 비수치 강등, unit 6자·label 15자 캡', () => {
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: '1,200', unit: '%', label: '월 절감액' } }))
      .toEqual({ kind: 'stat', stat: { value: 1200, unit: '%', label: '월 절감액' } });
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: '많이' } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat' })).toEqual({});
    const long = normalizeSceneKind({ kind: 'stat', stat: { value: 3, unit: '1234567890', label: '가나다라마바사아자차카타파하호호' } });
    expect(long).toEqual({ kind: 'stat', stat: { value: 3, unit: '123456', label: '가나다라마바사아자차카타파하호' } });
  });
  it('list — 트림·빈 항목 제거·18자 캡·4개 절삭, 2개 미만 강등', () => {
    expect(normalizeSceneKind({ kind: 'list', items: [' 물주기 ', '', '분갈이', '햇빛', '통풍', '영양제'] }))
      .toEqual({ kind: 'list', items: ['물주기', '분갈이', '햇빛', '통풍'] });
    expect(normalizeSceneKind({ kind: 'list', items: ['하나'] })).toEqual({});
    expect(normalizeSceneKind({ kind: 'list' })).toEqual({});
  });
  it('quote — text 필수(40자 캡), source 15자 캡', () => {
    expect(normalizeSceneKind({ kind: 'quote', quote: { text: ' 시작이 반이다 ', source: '속담' } }))
      .toEqual({ kind: 'quote', quote: { text: '시작이 반이다', source: '속담' } });
    expect(normalizeSceneKind({ kind: 'quote', quote: { text: '  ' } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'quote' })).toEqual({});
  });
  it('list 항목 18자 캡, 경계(2개) 통과', () => {
    expect(normalizeSceneKind({ kind: 'list', items: ['다'.repeat(20), '물주기'] }))
      .toEqual({ kind: 'list', items: ['다'.repeat(18), '물주기'] });
    expect(normalizeSceneKind({ kind: 'list', items: ['하나', '둘'] })).toEqual({ kind: 'list', items: ['하나', '둘'] });
  });
  it('quote text 40자·source 15자 캡', () => {
    expect(normalizeSceneKind({ kind: 'quote', quote: { text: '가'.repeat(45), source: '나'.repeat(20) } }))
      .toEqual({ kind: 'quote', quote: { text: '가'.repeat(40), source: '나'.repeat(15) } });
  });
  it('비문자열 페이로드 방어 — 오브젝트는 강등, 숫자는 문자열화 허용', () => {
    expect(normalizeSceneKind({ kind: 'list', items: [{ a: 1 }, { b: 2 }, '물주기'] })).toEqual({});
    expect(normalizeSceneKind({ kind: 'quote', quote: { text: { nested: true } } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: 42, unit: 7, label: 3 } }))
      .toEqual({ kind: 'stat', stat: { value: 42, unit: '7', label: '3' } });
  });
});
describe('resolveClipSrc — 클립 존재 판정(픽스처)', () => {
  it('존재 파일 → clip_NN.mp4, 부재/null/undefined → null', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `clip-src-${process.pid}-`));
    const f = path.join(tmp, 'c.mp4');
    fs.writeFileSync(f, 'x');
    expect(resolveClipSrc(f, '01')).toBe('clip_01.mp4');
    expect(resolveClipSrc(path.join(tmp, 'none.mp4'), '02')).toBeNull();
    expect(resolveClipSrc(null, '03')).toBeNull();
    expect(resolveClipSrc(undefined, '04')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
describe('normalizeSceneKind — stat 자릿수 상한', () => {
  it('1e12 이상은 강등(CountUp 패널 넘침 방지)', () => {
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: 1e12 } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: -1e12 } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'stat', stat: { value: 999_999_999_999 } }))
      .toEqual({ kind: 'stat', stat: { value: 999_999_999_999 } });
  });
});

// TTS 숫자 한글화 지시("숫자는 한글로")가 '10월'을 '십월'로 만들던 실측(2026-08-08 어휘 감사, 쇼츠 낭독 유출).
// 월 이름은 고유어 불규칙(시월·유월)이라 결정적으로 교정한다 — 낭독·자막 공용.
describe('fixMonthNames — 월 이름 고유어 교정', () => {
  it('십월→시월, 육월→유월', async () => {
    const { fixMonthNames } = await import('./shortsCommon');
    expect(fixMonthNames('십월에 심고 육월에 확인합니다')).toBe('시월에 심고 유월에 확인합니다');
  });
  it('그 외 월 이름·본문은 불변', async () => {
    const { fixMonthNames } = await import('./shortsCommon');
    expect(fixMonthNames('칠월과 팔월, 구월까지')).toBe('칠월과 팔월, 구월까지');
  });
});

describe('defaultSceneFx — 결정적 kind 연출(순수)', () => {
  it('클립 씬은 undefined(클립이 곧 모션 — 종전 동작 유지)', async () => {
    const { defaultSceneFx } = await import('./shortsCommon');
    expect(defaultSceneFx('hook', 0, true)).toBeUndefined();
    expect(defaultSceneFx(undefined, 2, true)).toBeUndefined();
  });
  it('훅(kind 또는 첫 씬)=push 강줌·스포트라이트·엔터 없음, cta=줌아웃', async () => {
    const { defaultSceneFx } = await import('./shortsCommon');
    expect(defaultSceneFx('hook', 3, false)).toEqual({ enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' });
    expect(defaultSceneFx(undefined, 0, false)).toEqual({ enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' });
    expect(defaultSceneFx('cta', 5, false)).toEqual({ enter: 'fade', move: 'zoom-out', intensity: 'normal' });
  });
  it('계절 파티클 — 봄 꽃잎/가을 낙엽/겨울 눈, 여름 없음; 본문 index1+cta 만(캡 2)', async () => {
    const { defaultSceneFx, seasonalParticles } = await import('./shortsCommon');
    expect(seasonalParticles(4)).toBe('particles-petals');
    expect(seasonalParticles(10)).toBe('particles-leaves');
    expect(seasonalParticles(1)).toBe('particles-snow');
    expect(seasonalParticles(7)).toBeUndefined();
    expect(defaultSceneFx(undefined, 1, false, 10)?.accent).toBe('particles-leaves'); // 본문 index 1
    expect(defaultSceneFx(undefined, 2, false, 10)?.accent).toBeUndefined();          // 다른 본문은 제외
    expect(defaultSceneFx('cta', 5, false, 10)?.accent).toBe('particles-leaves');
    expect(defaultSceneFx('stat', 2, false, 10)?.accent).toBeUndefined();             // 오버레이 씬 제외
    expect(defaultSceneFx(undefined, 1, false, 7)?.accent).toBeUndefined();           // 여름
  });
  it('오버레이 씬(stat/list/quote)=배경 subtle 캡 + kind별 엔터', async () => {
    const { defaultSceneFx } = await import('./shortsCommon');
    expect(defaultSceneFx('stat', 2, false)).toEqual({ enter: 'fade', intensity: 'subtle' });
    expect(defaultSceneFx('list', 2, false)).toEqual({ enter: 'wipe', intensity: 'subtle' });
    expect(defaultSceneFx('quote', 2, false)).toEqual({ enter: 'scale', intensity: 'subtle' });
  });
  it('본문 씬=strong 줌 + 엔터 변주(짝수 slide-up/홀수 fade)', async () => {
    const { defaultSceneFx } = await import('./shortsCommon');
    expect(defaultSceneFx(undefined, 2, false)).toEqual({ enter: 'slide-up', intensity: 'strong' });
    expect(defaultSceneFx(undefined, 3, false)).toEqual({ enter: 'fade', intensity: 'strong' });
  });
});

describe('normalizeSceneKind — chart 검증', () => {
  it('정상 chart: series 2~5·label 8자 캡·highlight 범위 검증', () => {
    const r = normalizeSceneKind({ kind: 'chart', chart: { series: [{ label: '봄철심기12345', value: 90 }, { label: '가을', value: '70' }], unit: '%', highlight: 0 } });
    expect(r.kind).toBe('chart');
    expect(r.chart?.series).toEqual([{ label: '봄철심기1234', value: 90 }, { label: '가을', value: 70 }]);
    expect(r.chart?.unit).toBe('%');
    expect(r.chart?.highlight).toBe(0);
  });
  it('불량 강등: series 1개·음수·전부 0·highlight 범위 밖', () => {
    expect(normalizeSceneKind({ kind: 'chart', chart: { series: [{ label: '봄', value: 90 }] } })).toEqual({});
    expect(normalizeSceneKind({ kind: 'chart', chart: { series: [{ label: '봄', value: -1 }, { label: '가을', value: 70 }] } }).chart?.series).toEqual([{ label: '가을', value: 70 }].length === 1 ? undefined : []);
    expect(normalizeSceneKind({ kind: 'chart', chart: { series: [{ label: '봄', value: 0 }, { label: '가을', value: 0 }] } })).toEqual({});
    const hi = normalizeSceneKind({ kind: 'chart', chart: { series: [{ label: '봄', value: 9 }, { label: '가을', value: 7 }], highlight: 9 } });
    expect(hi.chart?.highlight).toBeUndefined();
  });
  it('라벨 없는 항목 제외, 6개 이상은 5개 캡', () => {
    const r = normalizeSceneKind({ kind: 'chart', chart: { series: [1, 2, 3, 4, 5, 6].map((v) => ({ label: `항목${v}`, value: v })) } });
    expect(r.chart?.series.length).toBe(5);
    const r2 = normalizeSceneKind({ kind: 'chart', chart: { series: [{ label: '', value: 1 }, { label: 'ㄱ', value: 2 }, { label: 'ㄴ', value: 3 }] } });
    expect(r2.chart?.series.length).toBe(2);
  });
  it('defaultSceneFx chart = slide-up + subtle', async () => {
    const { defaultSceneFx } = await import('./shortsCommon');
    expect(defaultSceneFx('chart', 2, false)).toEqual({ enter: 'slide-up', intensity: 'subtle' });
  });
});

describe('quote.source 절단 — 단어 경계(스펙 §6a, 실측 "biondi tree 재배노")', () => {
  it('상한 안의 마지막 공백에서 자르고, 공백이 없으면 그대로 자른다', () => {
    expect(cutAtWordBoundary('biondi tree 재배노트 2026', 15)).toBe('biondi tree');
    expect(cutAtWordBoundary('재배기록', 15)).toBe('재배기록');
    expect(cutAtWordBoundary('가나다라마바사아자차카타파하거너더', 15)).toBe('가나다라마바사아자차카타파하거');
  });
  it('normalizeSceneKind 가 quote.source 에 적용한다', () => {
    const k = normalizeSceneKind({ kind: 'quote', quote: { text: 't', source: 'biondi tree 재배노트 2026' } });
    expect(k.quote?.source).toBe('biondi tree');
  });
});

// CTA 결론 카드(2026-08-28) — 결론이 소리로만 지나가면 무음 시청자에게 아무것도 안 남는다.
// 실측(short_6c8936f791): 내레이션 "허리 높이면 회양목…" ↔ 화면 "자리별 나무 정하기".
describe('normalizeSceneKind — cta takeaways', () => {
  it('조건·답 쌍을 싣는다', () => {
    expect(normalizeSceneKind({
      kind: 'cta',
      takeaways: [{ when: '허리 높이', then: '회양목' }, { when: '어깨 높이 상록', then: '사철나무' }],
    })).toEqual({
      kind: 'cta',
      takeaways: [{ when: '허리 높이', then: '회양목' }, { when: '어깨 높이 상록', then: '사철나무' }],
    });
  });

  it('한쪽만 있는 쌍은 버린다 — 화살표 표기가 성립하지 않는다', () => {
    const r = normalizeSceneKind({ kind: 'cta', takeaways: [{ when: '허리 높이' }, { then: '회양목' }, { when: '어깨', then: '사철나무' }] });
    expect(r.takeaways).toEqual([{ when: '어깨', then: '사철나무' }]);
  });

  it('takeaways 가 없거나 전부 불량이면 kind 만 남는다(종전 동작 — CTA 씬은 유지)', () => {
    expect(normalizeSceneKind({ kind: 'cta' })).toEqual({ kind: 'cta' });
    expect(normalizeSceneKind({ kind: 'cta', takeaways: [] })).toEqual({ kind: 'cta' });
    expect(normalizeSceneKind({ kind: 'cta', takeaways: 'nope' })).toEqual({ kind: 'cta' });
    expect(normalizeSceneKind({ kind: 'cta', takeaways: [{ when: {}, then: [] }] })).toEqual({ kind: 'cta' });
  });

  it('최대 3쌍 — 그 이상은 한 화면에 안 들어온다', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ when: `조건${i}`, then: `답${i}` }));
    expect(normalizeSceneKind({ kind: 'cta', takeaways: many }).takeaways).toHaveLength(3);
  });

  it('12자 초과는 단어 경계에서 자른다', () => {
    const r = normalizeSceneKind({ kind: 'cta', takeaways: [{ when: '아주 긴 조건 문장이 여기 들어간다', then: '회양목' }] });
    expect(r.takeaways![0]!.when.length).toBeLessThanOrEqual(12);
    expect(r.takeaways![0]!.then).toBe('회양목');
  });

  it('hook 은 종전대로 kind 만 — takeaways 를 보내도 무시한다', () => {
    expect(normalizeSceneKind({ kind: 'hook', takeaways: [{ when: 'a', then: 'b' }] })).toEqual({ kind: 'hook' });
  });
});

describe('normalizeSceneKind — compare(대비 씬, 2026-09-03)', () => {
  it('양쪽이 다 있으면 그대로 싣는다', () => {
    const r = normalizeSceneKind({
      kind: 'compare',
      bad: { label: '웃자란 가지', note: '꽃눈이 안 앉아요' },
      good: { label: '짧은 곁가지', note: '여기 열매가 달려요' },
    });
    expect(r.kind).toBe('compare');
    expect(r.compare?.bad.label).toBe('웃자란 가지');
    expect(r.compare?.good.note).toBe('여기 열매가 달려요');
  });
  it('한쪽만 있으면 kind 만 남긴다 — 대비가 성립하지 않는다', () => {
    expect(normalizeSceneKind({ kind: 'compare', bad: { label: '웃자란 가지' } }))
      .toEqual({ kind: 'compare' });
    expect(normalizeSceneKind({ kind: 'compare' })).toEqual({ kind: 'compare' });
  });
  it('note 는 선택 — 없으면 필드를 넣지 않는다', () => {
    const r = normalizeSceneKind({ kind: 'compare', bad: { label: 'A' }, good: { label: 'B' } });
    expect(r.compare).toEqual({ bad: { label: 'A' }, good: { label: 'B' } });
  });
  it('label 14자·note 18자 캡(단어 경계)', () => {
    const r = normalizeSceneKind({
      kind: 'compare',
      bad: { label: '아주 길게 늘어진 웃자란 가지 여러 개', note: '이렇게 되면 꽃눈이 전혀 앉지 않아서 열매가 안 달립니다' },
      good: { label: 'B' },
    });
    expect((r.compare!.bad.label).length).toBeLessThanOrEqual(14);
    expect((r.compare!.bad.note ?? '').length).toBeLessThanOrEqual(18);
  });
  it('이형 페이로드는 kind 만 — 렌더 무중단(fail-open)', () => {
    expect(normalizeSceneKind({ kind: 'compare', bad: 'x', good: 3 })).toEqual({ kind: 'compare' });
  });
});

describe('emptyKindScenes — 선언만 하고 비어 있는 연출 탐지(순수, 2026-09-03)', () => {
  it('페이로드가 없는 kind 를 집어낸다', () => {
    expect(emptyKindScenes([
      { kind: 'hook' },
      { kind: 'compare' },
      { kind: 'stat' },
    ])).toEqual([{ index: 2, kind: 'compare' }, { index: 3, kind: 'stat' }]);
  });
  it('채워진 kind 는 잡지 않는다', () => {
    expect(emptyKindScenes([
      { kind: 'compare', compare: { bad: { label: 'a' }, good: { label: 'b' } } },
      { kind: 'stat', stat: { value: 3 } },
      { kind: 'list', items: ['a', 'b'] },
      { kind: 'quote', quote: { text: 'x' } },
      { kind: 'chart', chart: { series: [{ label: 'a', value: 1 }] } },
    ])).toEqual([]);
  });
  it('cta 는 제외 — takeaways 생략이 설계상 허용된다', () => {
    expect(emptyKindScenes([{ kind: 'cta' }])).toEqual([]);
  });
  it('kind 없는 씬은 대상이 아니다', () => {
    expect(emptyKindScenes([{}, { kind: undefined }])).toEqual([]);
  });
  it('빈 items 는 누락으로 본다 — 배열만 있고 항목이 없으면 화면에 안 나온다', () => {
    expect(emptyKindScenes([{ kind: 'list', items: [] }])).toEqual([{ index: 1, kind: 'list' }]);
  });
});

describe('bodyKindCoverage', () => {
  it('훅·CTA 는 본문에서 뺀다 — 그 둘은 프롬프트가 항상 붙이라 한 자리다', () => {
    const cov = bodyKindCoverage([{ kind: 'hook' }, {}, { kind: 'stat' }, {}, { kind: 'cta' }]);
    expect(cov.body).toBe(3);
    expect(cov.withKind).toBe(1);
    expect(cov.kinds).toEqual(['stat']);
  });
  it('본문이 전부 비면 withKind 0 — 종전 로그가 절대 못 잡던 상태', () => {
    const cov = bodyKindCoverage([{ kind: 'hook' }, {}, {}, { kind: 'cta' }]);
    expect(cov.withKind).toBe(0);
    expect(cov.body).toBe(2);
  });
  it('위치로도 가장자리를 뺀다 — 작가가 hook/cta 를 안 붙인 경우', () => {
    const cov = bodyKindCoverage([{}, { kind: 'list' }, {}]);
    expect(cov.body).toBe(1);
    expect(cov.withKind).toBe(1);
  });
  it('씬 2개 이하면 본문이 없다', () => {
    expect(bodyKindCoverage([{ kind: 'hook' }, { kind: 'cta' }]).body).toBe(0);
    expect(bodyKindCoverage([]).body).toBe(0);
  });
});

describe('defaultSceneFx — 편 간 변주', () => {
  const seedA = fxSeed('short_aaaaaaaaaa');
  const seedB = fxSeed('short_bbbbbbbbbb');

  it('시드가 없으면 종전 고정 연출 그대로', () => {
    expect(defaultSceneFx('hook', 0, false)).toEqual({ enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' });
    expect(defaultSceneFx('stat', 2, false)).toEqual({ enter: 'fade', intensity: 'subtle' });
  });
  it('같은 시드는 같은 연출 — 재조립해도 화면이 안 바뀐다', () => {
    for (const i of [0, 1, 2, 3, 4]) {
      expect(defaultSceneFx('stat', i, false, 9, seedA)).toEqual(defaultSceneFx('stat', i, false, 9, seedA));
    }
  });
  it('편이 다르면 연출 묶음이 갈린다 — 여러 편에 걸쳐 같은 조합만 나오지 않는다', () => {
    const a = [0, 1, 2, 3, 4, 5].map((i) => JSON.stringify(defaultSceneFx(undefined, i, false, 9, seedA)));
    const b = [0, 1, 2, 3, 4, 5].map((i) => JSON.stringify(defaultSceneFx(undefined, i, false, 9, seedB)));
    expect(a).not.toEqual(b);
  });
  it('한 편 안에서도 씬끼리 조합이 반복되지 않는다', () => {
    const seen = [1, 2, 3, 4].map((i) => JSON.stringify(defaultSceneFx(undefined, i, false, undefined, seedA)));
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
  it('카드 씬 배경은 절대 strong 이 아니다 — 패널이 주인공이라 시선을 뺏으면 안 된다', () => {
    for (const seed of [seedA, seedB, fxSeed('x'), fxSeed('y'), fxSeed('z')]) {
      for (const k of ['stat', 'list', 'quote', 'chart', 'compare'] as const) {
        for (const i of [1, 2, 3, 4]) {
          expect(defaultSceneFx(k, i, false, 9, seed)?.intensity).not.toBe('strong');
        }
      }
    }
  });
  it('클립 씬은 시드가 있어도 undefined — 클립이 곧 모션', () => {
    expect(defaultSceneFx('stat', 1, true, 9, seedA)).toBeUndefined();
  });
  it('파티클은 한 편에 본문 1곳 + cta 로 제한된다', () => {
    for (const seed of [seedA, seedB, fxSeed('q')]) {
      const body = [1, 2, 3, 4, 5].filter((i) => defaultSceneFx(undefined, i, false, 9, seed)?.accent?.startsWith('particles-'));
      expect(body.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('fxSeed — 하위 비트 함정 회귀', () => {
  it('접미사가 같은 키들이 서로 다른 하위 비트를 받는다', () => {
    // FNV-1a 만 쓰던 시절, "…:0" 처럼 끝이 같은 키는 하위 비트가 같아져 서로 다른 두 편이
    // 5개 씬 연출을 통째로 똑같이 받았다(실측: short_f7da9c2057 vs short_fab8242762).
    const lows = ['3612565752:0', '3454849696:0', '111:0', '222:0', '333:0'].map((k) => fxSeed(k) % 4);
    expect(new Set(lows).size).toBeGreaterThan(1);
  });
  it('가까운 문자열이 서로 다른 조합으로 갈린다', () => {
    const keys = Array.from({ length: 200 }, (_, i) => `short_${i.toString(16).padStart(10, '0')}`);
    const combos = new Set(keys.map((k) => {
      const s = fxSeed(k);
      return [0, 1, 2, 3, 4].map((i) => JSON.stringify(defaultSceneFx(i === 0 ? 'hook' : undefined, i, false, 9, s))).join('|');
    }));
    // 완벽한 200/200 을 요구하면 취약한 테스트가 된다 — 판박이가 아니라는 것만 못박는다.
    expect(combos.size).toBeGreaterThan(150);
  });
});

describe("defaultSceneFx — 'wipe' 자동 선택 금지", () => {
  it('어떤 시드·씬에서도 wipe 를 고르지 않는다', () => {
    // Series 는 씬을 겹치지 않아 와이프의 미개방 영역이 루트 배경(검정)으로 드러난다.
    // 실측(short_0b062a8f6a): 전환 0.2초간 화면 오른쪽이 순검정이었다.
    for (let n = 0; n < 60; n++) {
      const s = fxSeed(`short_${n}`);
      for (const k of [undefined, 'stat', 'list', 'quote', 'chart', 'compare', 'hook', 'cta'] as const) {
        for (const i of [0, 1, 2, 3, 4, 5]) {
          expect(defaultSceneFx(k, i, false, 9, s)?.enter).not.toBe('wipe');
        }
      }
    }
  });
});

describe('varyLayout — 자막·제목 배치 미세 변주', () => {
  const base = { bottomPct: 50, fontPx: 70, hookFontPx: 84, titleTopPct: 5, titleWidthPct: 74 };

  it('시드가 없으면 보정값 그대로', () => {
    expect(varyLayout(base)).toEqual(base);
  });
  it('같은 편은 같은 배치 — 재조립해도 자막이 안 움직인다', () => {
    expect(varyLayout(base, 'short_a')).toEqual(varyLayout(base, 'short_a'));
  });
  it('편이 다르면 배치가 갈린다', () => {
    const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(varyLayout(base, `short_${i}`))));
    expect(seen.size).toBeGreaterThan(20);
  });
  it('안전 하한을 절대 안 넘는다 — 자막이 플랫폼 UI 에 먹히면 변주 이득보다 손해가 크다', () => {
    for (let i = 0; i < 300; i++) {
      const v = varyLayout(base, `short_${i}`);
      expect(v.bottomPct).toBeGreaterThanOrEqual(30);
      expect(v.fontPx).toBeGreaterThanOrEqual(56);
      expect(v.hookFontPx).toBeGreaterThanOrEqual(70);
      expect(v.titleTopPct).toBeGreaterThanOrEqual(3);
      expect(v.titleWidthPct).toBeGreaterThanOrEqual(64);
      expect(v.titleWidthPct).toBeLessThanOrEqual(88);
    }
  });
  it('흔들림 폭이 좁다 — 줄바꿈이 바뀔 만큼 크면 안 된다', () => {
    for (let i = 0; i < 300; i++) {
      const v = varyLayout(base, `short_${i}`);
      expect(Math.abs(v.bottomPct - base.bottomPct)).toBeLessThanOrEqual(3);
      expect(Math.abs(v.fontPx - base.fontPx)).toBeLessThanOrEqual(3);
      expect(Math.abs(v.hookFontPx - base.hookFontPx)).toBeLessThanOrEqual(4);
    }
  });
  it('보정값이 이미 하한 근처여도 하한 아래로 안 내려간다', () => {
    const low = { bottomPct: 31, fontPx: 57, hookFontPx: 71, titleTopPct: 3, titleWidthPct: 65 };
    for (let i = 0; i < 200; i++) {
      const v = varyLayout(low, `s${i}`);
      expect(v.bottomPct).toBeGreaterThanOrEqual(30);
      expect(v.titleTopPct).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('훅 첫 프레임 — 커버가 검게 나오면 안 된다', () => {
  it('어떤 시드에서도 훅 enter 는 none — 프레임 0 이 커버로 쓰인다', () => {
    // 실사고(2026-09-03, short_1a95e1e542): 훅이 enter:'fade' 로 뽑혀 프레임 0 이 opacity 0 →
    // 평균 밝기 8/255. 상단 캘리는 씬 밖 오버레이라 그대로 보여 "검은 배경에 제목만" 이 됐다.
    // 유튜브 커버(extractFirstFrame)와 릴스 커버가 그 프레임을 쓴다.
    for (let n = 0; n < 120; n++) {
      const fx = defaultSceneFx('hook', 0, false, 9, fxSeed(`short_${n}`));
      expect(fx?.enter).toBe('none');
    }
  });
  it('첫 씬이 kind 없이 와도 마찬가지다', () => {
    for (let n = 0; n < 60; n++) {
      expect(defaultSceneFx(undefined, 0, false, 9, fxSeed(`s${n}`))?.enter).toBe('none');
    }
  });
  it('훅 변주는 move·intensity·accent 로만 준다 — 실제로 갈리는지', () => {
    const seen = new Set(Array.from({ length: 40 }, (_, n) => {
      const fx = defaultSceneFx('hook', 0, false, 9, fxSeed(`short_${n}`));
      return `${fx?.move}/${fx?.accent ?? '-'}`;
    }));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('dropEmptyKinds — 못 채운 연출은 떼어 낸다(순수, 2026-09-04)', () => {
  it('빈 compare 는 kind 가 사라진다 — 남겨 두면 연출·I2V 가 거짓 전제로 돈다', () => {
    const r = dropEmptyKinds([{ kind: 'hook' }, { kind: 'compare' }, { kind: 'cta' }]);
    expect(r.dropped).toEqual([2]);
    expect(r.scenes[1]!.kind).toBeUndefined();
  });
  it('채워진 연출은 그대로 둔다', () => {
    const full = { kind: 'compare' as const, compare: { bad: { label: '가' }, good: { label: '나' } } };
    const r = dropEmptyKinds([{ kind: 'hook' as const }, full]);
    expect(r.dropped).toEqual([]);
    expect(r.scenes[1]!.kind).toBe('compare');
  });
  it('cta 는 takeaways 가 없어도 안 뗀다 — 설계상 허용된 생략이다', () => {
    expect(dropEmptyKinds([{ kind: 'hook' }, { kind: 'list', items: ['가'] }, { kind: 'cta' }]).dropped).toEqual([]);
  });
  it('kind 말고는 아무것도 안 건드린다', () => {
    const r = dropEmptyKinds([{ kind: 'stat', narration: '가', screenText: '나' } as never]);
    expect(r.scenes[0]).toEqual({ narration: '가', screenText: '나' });
  });
  it('원본을 바꾸지 않는다', () => {
    const src = [{ kind: 'compare' as const }];
    dropEmptyKinds(src);
    expect(src[0]!.kind).toBe('compare');
  });
  it('여러 개면 모두 뗀다', () => {
    expect(dropEmptyKinds([{ kind: 'hook' }, { kind: 'stat' }, { kind: 'chart' }, { kind: 'cta' }]).dropped).toEqual([2, 3]);
  });
});
