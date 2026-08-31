import { describe, it, expect } from 'vitest';
import { buildTrendBlock, parseYtSuggest, type TrendSnap } from './trendSignal';

describe('parseYtSuggest — 유튜브 자동완성 파서(순수)', () => {
  it('["질의",["제안",...]] 꼴에서 제안 목록을 뽑는다', () => {
    expect(parseYtSuggest(['배롱나무', ['배롱나무 가지치기', '배롱나무 병충해']])).toEqual(['배롱나무 가지치기', '배롱나무 병충해']);
    expect(parseYtSuggest(['q', []])).toEqual([]);
    expect(parseYtSuggest({})).toEqual([]);
  });
});

describe('buildTrendBlock — 유튜브 축(2026-08-25)', () => {
  it('네이버·유튜브 섹션을 나눠 담고 유튜브 diff 도 ★를 붙인다', () => {
    const snap: TrendSnap = {
      date: '2026-08-25',
      entries: { 조경수: ['조경수 추천'] },
      ytEntries: { 조경수: ['조경수 가격', '조경수 심기'] },
      prevDate: '2026-08-24',
      prevEntries: { 조경수: ['조경수 추천'] },
      prevYtEntries: { 조경수: ['조경수 가격'] },
    };
    const b = buildTrendBlock(snap, new Date('2026-08-25T12:00:00').getTime());
    expect(b).toContain('네이버 자동완성');
    expect(b).toContain('유튜브 자동완성');
    expect(b).toContain('★조경수 심기');
    expect(b).not.toContain('★조경수 가격');
  });
  it('유튜브 축만 있어도(네이버 전 시드 실패) 블록이 나온다', () => {
    const b = buildTrendBlock({ date: '2026-08-25', entries: {}, ytEntries: { 단풍나무: ['단풍나무 분갈이'] } }, new Date('2026-08-25T12:00:00').getTime());
    expect(b).toContain('단풍나무 분갈이');
  });
});

const NOW = new Date('2026-08-20T12:00:00').getTime();

describe('buildTrendBlock — 자동완성 스냅샷 diff 블록(순수)', () => {
  it('직전 스냅샷에 없던 연관어에 ★를 붙인다', () => {
    const snap: TrendSnap = {
      date: '2026-08-20',
      entries: { 배롱나무: ['배롱나무 가지치기', '배롱나무 단풍'] },
      prevDate: '2026-08-19',
      prevEntries: { 배롱나무: ['배롱나무 가지치기'] },
    };
    const block = buildTrendBlock(snap, NOW);
    expect(block).toContain('배롱나무 가지치기');
    expect(block).not.toContain('★배롱나무 가지치기');
    expect(block).toContain('★배롱나무 단풍');
    expect(block).toContain('2026-08-19');
  });
  it('직전 스냅샷이 없으면 ★ 없이 목록만 준다(첫 수집일)', () => {
    const block = buildTrendBlock({ date: '2026-08-20', entries: { 조경수: ['조경수 추천'] } }, NOW);
    expect(block).toContain('조경수 추천');
    expect(block).not.toContain('★');
  });
  it('낡은 스냅샷(7일 초과)·null 은 빈 문자열(무주입)', () => {
    expect(buildTrendBlock({ date: '2026-08-01', entries: { a: ['b'] } }, NOW)).toBe('');
    expect(buildTrendBlock(null, NOW)).toBe('');
  });
  it('계열 쿨다운 어간의 시드는 목록에서 제외하고 제외 사실을 명시한다(2026-08-24 포도 편중)', () => {
    const snap = { date: '2026-08-20', entries: { '포도나무 재배': ['포도나무 재배법'], 조경수: ['조경수 추천'] } };
    const block = buildTrendBlock(snap, NOW, ['포도']);
    expect(block).not.toContain('포도나무 재배법');
    expect(block).toContain('제외: 포도나무 재배');
    expect(block).toContain('조경수 추천');
    expect(buildTrendBlock({ date: '2026-08-20', entries: { '포도나무 재배': ['포도나무 재배법'] } }, NOW, ['포도'])).toBe(''); // 전 시드 제외 시 무주입
  });
});
