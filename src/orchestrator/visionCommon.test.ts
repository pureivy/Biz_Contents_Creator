import { describe, it, expect } from 'vitest';
import { parseBadIndices } from './visionCommon';

describe('parseBadIndices — 키 일반화(scene/slide)·범위·중복·정렬(순수)', () => {
  it('scene/slide 키 모두 지원, 중복·범위밖·비정상값 방어, floor', () => {
    expect(parseBadIndices([{ scene: 2 }, { scene: 2 }, { scene: 1 }], 'scene', 3)).toEqual([1, 2]);
    expect(parseBadIndices([{ slide: 0 }, { slide: 4 }, { slide: 'x' }, { slide: 3 }], 'slide', 3)).toEqual([3]);
    expect(parseBadIndices([{ scene: 2.9 }], 'scene', 3)).toEqual([2]);
    expect(parseBadIndices(null, 'scene', 3)).toEqual([]);
    expect(parseBadIndices([], 'slide', 3)).toEqual([]);
  });
});
