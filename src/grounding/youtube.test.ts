import { describe, it, expect } from 'vitest';
import { parseIsoDurationMin, formatYtBlock, type YtVideo } from './youtube';

describe('parseIsoDurationMin', () => {
  it('시·분·초 조합을 분으로 반올림한다', () => {
    expect(parseIsoDurationMin('PT8M13S')).toBe(8);
    expect(parseIsoDurationMin('PT8M45S')).toBe(9);
    expect(parseIsoDurationMin('PT1H2M')).toBe(62);
    expect(parseIsoDurationMin('PT2H')).toBe(120);
  });
  it('1분 미만은 1로 올린다(0 표기 방지)', () => {
    expect(parseIsoDurationMin('PT45S')).toBe(1);
  });
  it('빈값·비정형은 0(표기 생략)', () => {
    expect(parseIsoDurationMin('')).toBe(0);
    expect(parseIsoDurationMin('P1D')).toBe(0);
    expect(parseIsoDurationMin('garbage')).toBe(0);
  });
});

describe('formatYtBlock', () => {
  const vid = (over: Partial<YtVideo> = {}): YtVideo => ({
    title: '7월 묘목 관리법', channel: '원예TV', publishedAt: '2026-06-01',
    views: 12345, durationMin: 8, ...over,
  });

  it('제목·채널·조회수·길이·날짜를 한 줄로 조립한다', () => {
    const b = formatYtBlock('묘목 관리', [vid()]);
    expect(b).toContain('검색어 "묘목 관리"');
    expect(b).toContain('· 7월 묘목 관리법 | 원예TV | 조회 12,345 | 8분 | 2026-06-01');
  });
  it('통계 실패(0)면 해당 필드를 생략한다(fail-open 표기)', () => {
    const b = formatYtBlock('묘목', [vid({ views: 0, durationMin: 0, publishedAt: '' })]);
    const item = b.split('\n').find((l) => l.startsWith('· '));
    expect(item).toBe('· 7월 묘목 관리법 | 원예TV');
  });
  it('결과 없으면 빈 문자열(주입 생략)', () => {
    expect(formatYtBlock('묘목', [])).toBe('');
  });
  it('상한(GROUND_CAP=800자)을 넘지 않는다', () => {
    const many = Array.from({ length: 6 }, (_, i) => vid({ title: `아주 긴 제목 ${'가'.repeat(200)} ${i}` }));
    expect(formatYtBlock('묘목', many).length).toBeLessThanOrEqual(800);
  });
});
