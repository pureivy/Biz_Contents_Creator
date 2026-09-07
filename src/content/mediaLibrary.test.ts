import { describe, it, expect } from 'vitest';
import { matchMedia, type MediaItem } from './mediaLibrary';

const mk = (o: Partial<MediaItem>): MediaItem => ({
  id: o.id ?? 'm', file: '/f.jpg', kind: o.kind ?? 'image', name: 'f.jpg', bytes: 1,
  createdTs: o.createdTs ?? '2026-09-01T00:00:00Z', ...o,
} as MediaItem);

describe('matchMedia — 주제에 맞는 소재 고르기', () => {
  it('수종이 맞는 소재가 최우선', () => {
    const items = [mk({ id: 'a' }), mk({ id: 'b', species: '수국' })];
    expect(matchMedia(items, { species: '수국' })[0]!.id).toBe('b');
  });
  it('다른 수종은 아예 안 쓴다 — 수국 편에 회양목 사진은 없느니만 못하다', () => {
    const items = [mk({ id: 'x', species: '회양목' })];
    expect(matchMedia(items, { species: '수국' })).toHaveLength(0);
  });
  it('수종 없는 범용 소재는 쓴다', () => {
    const items = [mk({ id: 'g' })];
    expect(matchMedia(items, { species: '수국' })).toHaveLength(1);
  });
  it('태그가 주제에 걸리면 점수가 오른다', () => {
    const items = [mk({ id: 'p' }), mk({ id: 'q', tags: ['전정'] })];
    expect(matchMedia(items, { text: '가을 전정 방법' })[0]!.id).toBe('q');
  });
  it('종류로 거른다', () => {
    const items = [mk({ id: 'i', kind: 'image' }), mk({ id: 'v', kind: 'video' })];
    expect(matchMedia(items, { kind: 'video' }).map((m) => m.id)).toEqual(['v']);
  });
  it('상한을 지킨다', () => {
    const items = Array.from({ length: 20 }, (_, i) => mk({ id: `m${i}` }));
    expect(matchMedia(items, { limit: 3 })).toHaveLength(3);
  });
  it('같은 점수면 최신 우선', () => {
    const items = [
      mk({ id: 'old', species: '수국', createdTs: '2026-01-01T00:00:00Z' }),
      mk({ id: 'new', species: '수국', createdTs: '2026-09-01T00:00:00Z' }),
    ];
    expect(matchMedia(items, { species: '수국' })[0]!.id).toBe('new');
  });
  // 2026-09-04 실측 사고 — 사장님이 '사계장미' 딱지를 붙여 올린 영상이 사계장미 편에서 배제됐다.
  // 그 시점 수종 사전에 사계장미가 없어 opts.species 가 비었고, 딱지가 붙은 소재는 점수가 0이었다.
  it('사전이 그 수종을 몰라도 주제 문장에 이름이 있으면 쓴다', () => {
    const items = [mk({ id: 'r', species: '사계장미', kind: 'video' })];
    const got = matchMedia(items, { text: '사계장미 전정, 꽃 진 자리 어디를 자르나요', kind: 'video' });
    expect(got.map((m) => m.id)).toEqual(['r']);
  });
  it('사전도 모르고 주제에도 이름이 없으면 안 쓴다', () => {
    const items = [mk({ id: 'r', species: '사계장미' })];
    expect(matchMedia(items, { text: '수국 9월 관리' })).toHaveLength(0);
  });
  it('수종 딱지 소재는 사전 판정이 있을 때 그 판정을 따른다 — 주제 문장보다 우선', () => {
    const items = [mk({ id: 'r', species: '사계장미' })];
    // 주제에 '사계장미'가 있어도 사전이 회양목으로 판정했다면 안 쓴다.
    expect(matchMedia(items, { species: '회양목', text: '사계장미 전정' })).toHaveLength(0);
  });
  it('빈 목록은 빈 결과', () => {
    expect(matchMedia([], { species: '수국' })).toEqual([]);
  });
});

describe('matchMedia — 별칭이 달라도 같은 나무면 쓴다(2026-09-04 실사고)', () => {
  // 사장님이 '음나무'로 딱지를 붙여 올린 영상이 '엄나무 묘목' 편에서 배제됐다.
  // 같은 나무(Kalopanax septemlobus)인데 부르는 이름이 둘이고 코드는 글자만 비교했다.
  const canon = (n: string): string => (['엄나무', '음나무', '개두릅나무'].includes(n) ? '음나무' : n);

  it('사전이 아는 별칭은 표준명으로 맞춘다', () => {
    const items = [mk({ id: 'v', species: '음나무', kind: 'video' })];
    expect(matchMedia(items, { species: '엄나무', kind: 'video', canon }).map((m) => m.id)).toEqual(['v']);
  });
  it('반대 방향도 같다 — 소재에 별칭, 주제에 표준명', () => {
    const items = [mk({ id: 'v', species: '엄나무' })];
    expect(matchMedia(items, { species: '음나무', canon })).toHaveLength(1);
  });
  it('사전 판정이 없어도 주제 문장에 사용자가 적은 표기가 있으면 쓴다', () => {
    const items = [mk({ id: 'v', species: '음나무' })];
    expect(matchMedia(items, { text: '음나무 묘목 고르기', canon })).toHaveLength(1);
  });
  it('다른 나무는 여전히 배제한다 — 별칭 처리가 문을 열어서는 안 된다', () => {
    const items = [mk({ id: 'v', species: '두릅나무' })];
    expect(matchMedia(items, { species: '엄나무', canon })).toHaveLength(0);
  });
  it('canon 이 없으면 종전대로 글자 비교', () => {
    const items = [mk({ id: 'v', species: '음나무' })];
    expect(matchMedia(items, { species: '엄나무' })).toHaveLength(0);
  });
  it('canon 이 던져도 안 터진다 — 사전 실패로 소재를 잃지 않는다', () => {
    const items = [mk({ id: 'v', species: '음나무' })];
    const boom = (): string => { throw new Error('사전 고장'); };
    expect(matchMedia(items, { species: '음나무', canon: boom })).toHaveLength(1);
  });
});
