import { describe, it, expect } from 'vitest';
import { mediaPlanGuide, type MediaBrief } from './shortsMediaBrief';

const b = (o: Partial<MediaBrief>): MediaBrief => ({
  file: '/x.mp4', kind: 'video', what: '무언가', ...o,
});

describe('mediaPlanGuide — 작가에게 주는 실촬영 안내(순수)', () => {
  it('소재가 없으면 빈 문자열 — 프롬프트에 빈 블록이 끼지 않는다', () => {
    expect(mediaPlanGuide([])).toBe('');
  });
  it('무엇이 찍혔는지를 그대로 적는다 — "영상이 있다"만으로는 대본이 화면을 안 본다', () => {
    const g = mediaPlanGuide([b({ what: '비닐하우스 안 사계장미 밭, 붉은 꽃 만개' })]);
    expect(g).toContain('비닐하우스 안 사계장미 밭, 붉은 꽃 만개');
    expect(g).toContain('영상');
  });
  it('사진과 영상을 구분해 적는다', () => {
    const g = mediaPlanGuide([b({ kind: 'image', what: '전정가위를 든 손' })]);
    expect(g).toContain('사진 — 전정가위를 든 손');
  });
  it('쓰임 힌트가 있으면 함께 적는다', () => {
    const g = mediaPlanGuide([b({ what: '장미 밭', use: '도입부 배경' })]);
    expect(g).toContain('(쓰임: 도입부 배경)');
  });
  it('없는 장면을 지어내지 말라고 못박는다 — 안내를 주면 작가가 상상하기 시작한다', () => {
    const g = mediaPlanGuide([b({})]);
    expect(g).toContain('목록에 없는 장면을 있는 것처럼 쓰지 마라');
  });
  it('설명을 못 얻은 소재는 목록에서 빠진다', () => {
    expect(mediaPlanGuide([b({ what: '' })])).toBe('');
  });
  it('여러 건이면 번호를 매긴다 — 배정 단계가 같은 번호를 쓴다', () => {
    const g = mediaPlanGuide([b({ what: '가' }), b({ what: '나' })]);
    expect(g).toContain('1) ');
    expect(g).toContain('2) ');
  });
});
