import { describe, it, expect } from 'vitest';
import { parseYtSearch, buildYtNicheBlock, type YtNicheSnap } from './ytNiche';

const NOW = new Date('2026-08-25T12:00:00').getTime();

describe('parseYtSearch — search.list 응답 파서(순수)', () => {
  it('videoId·title 을 뽑고 이형·결측을 거른다', () => {
    const j = { items: [
      { id: { videoId: 'a1' }, snippet: { title: ' 조경수 실제 거래가 ' } },
      { id: {}, snippet: { title: '무시' } },
      { id: { videoId: 'b2' }, snippet: {} },
    ] };
    expect(parseYtSearch(j)).toEqual([{ videoId: 'a1', title: '조경수 실제 거래가' }]);
    expect(parseYtSearch(null)).toEqual([]);
  });
});

describe('buildYtNicheBlock — 니치 동향 블록(순수)', () => {
  const snap: YtNicheSnap = {
    date: '2026-08-25',
    entries: [
      { seed: '조경수 추천', videos: [{ title: '조경수 실제 거래가 공개', views: 52300 }, { title: '정원수 고르기', views: 900 }] },
      { seed: '포도나무 재배', videos: [{ title: '포도 순치기', views: 12000 }] },
    ],
  };
  it('조회수 만 단위 표기로 시드별 상위 영상을 나열한다', () => {
    const b = buildYtNicheBlock(snap, NOW);
    expect(b).toContain('유튜브 니치 동향');
    expect(b).toContain('"조경수 실제 거래가 공개"(5.2만회)');
    expect(b).toContain('"정원수 고르기"(900회)');
  });
  it('쿨다운 계열 시드는 제외하고, 전부 제외되면 무주입', () => {
    const b = buildYtNicheBlock(snap, NOW, ['포도']);
    expect(b).not.toContain('포도 순치기');
    expect(b).toContain('조경수 실제 거래가');
    expect(buildYtNicheBlock(snap, NOW, ['포도', '조경수'])).toBe('');
  });
  it('낡은 스냅샷(7일 초과)·null 은 무주입', () => {
    expect(buildYtNicheBlock({ ...snap, date: '2026-08-10' }, NOW)).toBe('');
    expect(buildYtNicheBlock(null, NOW)).toBe('');
  });
});
