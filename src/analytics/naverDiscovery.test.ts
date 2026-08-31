import { describe, it, expect } from 'vitest';
import { parseRssItems, normalizeTitle, selectDiscoveryTargets, matchPublished, type RssItem } from './naverDiscovery';
import type { Piece } from '../content/pieces';

// 실 네이버 RSS 2.0 형태 축약 픽스처 — 평문 제목·CDATA 제목·엔티티·이형 아이템 혼재.
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>테스트 블로그</title>
<link>https://blog.naver.com/testblog</link>
<item>
<title>경북 소상공인 지원금 총정리</title>
<link>https://blog.naver.com/testblog/223900000001</link>
<description>본문 요약</description>
<pubDate>Thu, 09 Jul 2026 10:30:00 +0900</pubDate>
</item>
<item>
<title><![CDATA[카드뉴스 &amp; 숏폼 활용법]]></title>
<link>https://blog.naver.com/testblog/223900000002</link>
<pubDate>Thu, 09 Jul 2026 11:00:00 +0900</pubDate>
</item>
<item>
<title>pubDate 이상 아이템</title>
<link>https://blog.naver.com/testblog/223900000003</link>
<pubDate>날짜아님</pubDate>
</item>
<item>
<title>링크 없는 아이템</title>
<pubDate>Thu, 09 Jul 2026 12:00:00 +0900</pubDate>
</item>
</channel>
</rss>`;

describe('parseRssItems — RSS 2.0 파싱(순수·이형 방어)', () => {
  it('정상 아이템만 추출, pubDate 는 ISO 로 정규화', () => {
    const items = parseRssItems(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: '경북 소상공인 지원금 총정리',
      link: 'https://blog.naver.com/testblog/223900000001',
      pubDate: new Date('2026-07-09T10:30:00+09:00').toISOString(),
    });
    expect(items[1]!.title).toBe('카드뉴스 &amp; 숏폼 활용법'); // CDATA 원문 보존(디코드는 normalizeTitle 몫)
  });
  it('이형 입력은 빈 배열 — throw 금지', () => {
    expect(parseRssItems('')).toEqual([]);
    expect(parseRssItems('완전 엉뚱한 문자열')).toEqual([]);
    expect(parseRssItems('<rss><channel><item><title>닫히지 않은')).toEqual([]);
  });
});

describe('normalizeTitle — NFC·엔티티·공백(순수)', () => {
  it('HTML 엔티티 디코드(named+숫자) 후 공백 축약·트림', () => {
    expect(normalizeTitle('카드뉴스 &amp; 숏폼 활용법')).toBe('카드뉴스 & 숏폼 활용법');
    expect(normalizeTitle('&quot;따옴표&quot; &#39;홑&#39; &#x27;헥스&#x27;')).toBe(`"따옴표" '홑' '헥스'`);
    expect(normalizeTitle('  앞뒤\n개행\t탭  ')).toBe('앞뒤 개행 탭');
  });
  it('NFC 정규화 — NFD 한글과 NFC 한글이 같은 표준형', () => {
    expect(normalizeTitle('가나다'.normalize('NFD'))).toBe('가나다');
  });
  it('&amp;lt; 는 이중 디코드하지 않는다(&amp; 를 마지막에 처리)', () => {
    expect(normalizeTitle('a &amp;lt; b')).toBe('a &lt; b');
  });
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-07-10T09:00:00+09:00');
const iso = (t: number): string => new Date(t).toISOString();
const piece = (over: Partial<Piece>): Piece => ({
  id: over.id ?? 'p1', title: over.title ?? '제목', stage: over.stage ?? 'ready',
  createdTs: iso(NOW - 10 * DAY), updatedTs: iso(NOW - DAY), ...over,
});

describe('selectDiscoveryTargets — 감지 대상 선별(순수)', () => {
  it('임시저장+URL없음만 대상, 30일 경계에서 gaveUp 분리', () => {
    const ps = [
      piece({ id: 'a', naverDraftTs: iso(NOW - 29 * DAY) }),                                  // 대상
      piece({ id: 'b', naverDraftTs: iso(NOW - 31 * DAY) }),                                  // 포기
      piece({ id: 'c' }),                                                                     // draftTs 없음 — 제외
      piece({ id: 'd', naverDraftTs: iso(NOW - DAY), publishedUrl: 'https://blog.naver.com/x/1' }), // 이미 발행 — 제외
      piece({ id: 'e', naverDraftTs: iso(NOW - DAY), stage: 'error' }),                       // error — 제외
      piece({ id: 'f', naverDraftTs: '이상한값' }),                                            // 이상 Ts — 제외
    ];
    const r = selectDiscoveryTargets(ps, NOW);
    expect(r.targets.map((p) => p.id)).toEqual(['a']);
    expect(r.gaveUp.map((p) => p.id)).toEqual(['b']);
  });
});

describe('matchPublished — 보수적 exact + 양방향 유일(순수)', () => {
  const item = (over: Partial<RssItem>): RssItem => ({
    title: over.title ?? '제목', link: over.link ?? 'https://blog.naver.com/tb/223900000001',
    pubDate: over.pubDate ?? iso(NOW - HOUR),
  });
  const pend = (id: string, title: string, draftTs = iso(NOW - 2 * DAY)) => ({ id, title, draftTs });

  it('정규화 exact 1:1 이면 매칭 — 엔티티·공백 차이 흡수', () => {
    const r = matchPublished([pend('p1', '카드뉴스 & 숏폼  활용법')],
      [item({ title: '카드뉴스 &amp; 숏폼 활용법' })]);
    expect(r.matched).toEqual([{ pieceId: 'p1', url: 'https://blog.naver.com/tb/223900000001', pubDate: iso(NOW - HOUR) }]);
    expect(r.ambiguous).toEqual([]);
  });
  it('시각 조건 — 임시저장 1시간 전 경계는 포함, 그 이전은 제외', () => {
    const draft = iso(NOW);
    expect(matchPublished([pend('p1', 'T', draft)], [item({ title: 'T', pubDate: iso(NOW - HOUR) })]).matched).toHaveLength(1);
    expect(matchPublished([pend('p1', 'T', draft)], [item({ title: 'T', pubDate: iso(NOW - HOUR - 1) })]).matched).toHaveLength(0);
  });
  it('동명 RSS 아이템 2개 → ambiguous', () => {
    const r = matchPublished([pend('p1', 'T')],
      [item({ title: 'T' }), item({ title: 'T', link: 'https://blog.naver.com/tb/223900000002' })]);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous).toEqual(['p1']);
  });
  it('동명 대기 piece 2개 → 둘 다 ambiguous', () => {
    const r = matchPublished([pend('p1', 'T'), pend('p2', 'T')], [item({ title: 'T' })]);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous.sort()).toEqual(['p1', 'p2']);
  });
  it('블로그 링크 아닌 아이템·제목 불일치는 후보 제외(모호 아님 — 침묵)', () => {
    const r = matchPublished([pend('p1', 'T')],
      [item({ title: 'T', link: 'https://evil.example.com/x' }), item({ title: '다른 제목' })]);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });
  it('m.blog.naver.com 링크는 허용', () => {
    const r = matchPublished([pend('p1', 'T')], [item({ title: 'T', link: 'https://m.blog.naver.com/tb/223900000009' })]);
    expect(r.matched).toHaveLength(1);
  });
});
