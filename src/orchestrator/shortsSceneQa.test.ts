import { describe, it, expect } from 'vitest';
import { parseBadScenes, buildRetryPrompt, mapBadToOrig, reasonFor } from './shortsSceneQa';

describe('parseBadScenes — 유효(1..count)·중복제거·정렬', () => {
  it('중복·범위밖·비정상값 방어, floor', () => {
    expect(parseBadScenes([{ scene: 2 }, { scene: 2 }, { scene: 1 }], 3)).toEqual([1, 2]);
    expect(parseBadScenes([{ scene: 0 }, { scene: 4 }, { scene: 'x' }, { scene: 3 }], 3)).toEqual([3]);
    expect(parseBadScenes([{ scene: 2.9 }], 3)).toEqual([2]);
    expect(parseBadScenes([], 3)).toEqual([]);
  });
});
describe('buildRetryPrompt — 원본 + 강화 접미(순수)', () => {
  it('원본 포함 + 글자·워터마크 금지 문구', () => {
    const p = buildRetryPrompt('a wilting plant by a window');
    expect(p).toContain('a wilting plant by a window');
    expect(p).toContain('글자');
    expect(p).toContain('워터마크');
  });
});
describe('mapBadToOrig — checked 순번→원본 인덱스(순수)', () => {
  it('널홀 건너뛴 checked 매핑, 빈/범위밖 방어', () => {
    const checked = [{ origIndex: 0 }, { origIndex: 2 }, { origIndex: 3 }];
    expect(mapBadToOrig([1, 3], checked)).toEqual([0, 3]);
    expect(mapBadToOrig([], checked)).toEqual([]);
    expect(mapBadToOrig([4], checked)).toEqual([]);
  });
});

describe('buildRetryPrompt — QA 사유 되먹임', () => {
  it('사유가 있으면 최우선으로 붙인다 — 무엇이 틀렸는지 모르면 같은 그림이 다시 나온다', () => {
    // 실사고(2026-09-06): QA 가 "지그재그 가지 형태와 다름"을 정확히 짚었는데
    // 재생성은 원본 프롬프트만 물려받아 같은 실패를 반복했다.
    const out = buildRetryPrompt('원본 프롬프트', '씬2: 직선 줄기가 대추나무 지그재그와 다름');
    expect(out).toContain('원본 프롬프트');
    expect(out).toContain('[직전 시도의 문제 — 최우선으로 고칠 것]');
    expect(out).toContain('지그재그');
  });
  it('사유가 없으면 종전과 같다', () => {
    expect(buildRetryPrompt('원본')).not.toContain('직전 시도의 문제');
    expect(buildRetryPrompt('원본', '   ')).not.toContain('직전 시도의 문제');
  });
  it('사유가 길어도 잘라 붙인다', () => {
    expect(buildRetryPrompt('원본', 'ㄱ'.repeat(500)).length).toBeLessThan(500);
  });
});

describe('reasonFor — 씬별 사유 꺼내기(순수)', () => {
  const issues = [{ scene: 2, problem: '수형이 다름' }, { scene: 4, problem: '글자 있음' }];
  it('그 씬의 사유를 준다', () => {
    expect(reasonFor(issues, 2)).toBe('수형이 다름');
    expect(reasonFor(issues, 4)).toBe('글자 있음');
  });
  it('없는 씬·잘못된 입력은 undefined', () => {
    expect(reasonFor(issues, 3)).toBeUndefined();
    expect(reasonFor(issues, undefined)).toBeUndefined();
    expect(reasonFor([], 2)).toBeUndefined();
    expect(reasonFor([null, undefined], 2)).toBeUndefined();
  });
  it('빈 사유는 undefined — 빈 줄을 프롬프트에 붙이지 않는다', () => {
    expect(reasonFor([{ scene: 2, problem: '  ' }], 2)).toBeUndefined();
  });
});
