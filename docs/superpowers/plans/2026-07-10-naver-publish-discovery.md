# 네이버 발행 자동 감지(RSS) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 임시저장된 piece 가 사람 손으로 네이버에서 발행되면 블로그 공개 RSS 에서 제목 매칭으로 최종 URL 을 찾아 `publishedUrl` 을 자동 설정 — 기존 성과 수집기의 마지막 수동 고리 제거.

**Architecture:** 신규 모듈 `src/analytics/naverDiscovery.ts` 하나에 순수 헬퍼 4종(파싱·정규화·대상 선별·매칭)과 오케스트레이션 `discoverPublishedNaver()`. 일일 perf-sync 틱에서 `syncPerformance()` 직전 실행. 매칭은 보수적 exact(양방향 유일)만 — 모호·포기는 피드 안내 1회 + 기존 수동 붙여넣기 폴백 유지.

**Tech Stack:** TypeScript/Node 20+ (내장 fetch, `AbortSignal.timeout`), 정규식 XML 파싱(의존성 0), vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-naver-publish-discovery-design.md`

## Global Constraints

- 새 npm 의존성 금지 — Node 내장 fetch + 정규식 파싱만.
- 매칭은 **보수적 exact 만**: 정규화 제목 완전일치 && `pubDate ≥ naverDraftTs − 1h` && 양방향 유일. 그 외 자동 설정 금지(ambiguous).
- `discoverPublishedNaver` 는 어떤 입력·네트워크 상태에서도 **throw 금지**(전량 fail-open) — 이어지는 `syncPerformance` 실행이 반드시 보장돼야 한다.
- 기존 수동 라우트(`POST /pieces/:id/published`)·기존 수집 경로(naver_stats → ingestMetrics)는 무변경.
- 포기 지평 30일(`30 * 24 * 3_600_000` ms), 시각 여유 1시간, RSS 타임아웃 `AbortSignal.timeout(10_000)`.
- RSS URL 정확히: `https://rss.blog.naver.com/<blogId>.xml`.
- 피드 문구 정확히(스펙 §4.1): 감지 `[성과분석] <제목 30자> — 네이버 발행 감지, 성과 추적 시작` / 모호 `[성과분석] <제목 30자> — 동명 후보 복수, 자동 연결 보류. 발행 URL 을 수동 등록해 주세요` / 포기 `[성과분석] <제목 30자> — 임시저장 30일 경과, 자동 감지 포기. 발행했다면 URL 을 수동 등록해 주세요`. 모호·포기 안내는 piece 당 1회(프로세스 생애 `Set`).
- 병렬 세션이 같은 작업 트리에 커밋한다 — **자기 파일만 스테이징**(`git add -A`/`git add .` 절대 금지).
- 커밋 전 `npx tsc --noEmit` 0 + 해당 테스트 통과.

---

### Task 1: 순수 헬퍼 — parseRssItems + normalizeTitle

**Files:**
- Create: `src/analytics/naverDiscovery.ts`
- Test: `src/analytics/naverDiscovery.test.ts`

**Interfaces:**
- Consumes: 없음(순수).
- Produces: `interface RssItem { title: string; link: string; pubDate: string /* ISO */ }`, `parseRssItems(xml: string): RssItem[]`, `normalizeTitle(s: string): string` — Task 2 의 `matchPublished` 가 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/analytics/naverDiscovery.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest';
import { parseRssItems, normalizeTitle } from './naverDiscovery';

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
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/analytics/naverDiscovery.test.ts`
Expected: FAIL — `Cannot find module './naverDiscovery'` 류.

- [ ] **Step 3: 최소 구현**

`src/analytics/naverDiscovery.ts` 신규:

```ts
/**
 * 네이버 발행 자동 감지 — 임시저장된 piece 가 사람 손으로 발행되면 블로그 공개 RSS 에서
 * 제목 매칭으로 최종 URL 을 찾아 publishedUrl 을 자동 설정한다(성과 수집기의 기동 조건).
 * 보수적 매칭(정규화 exact + 시각 조건 + 양방향 유일)만 자동 — 모호하면 피드 안내 후 수동 폴백.
 * 전량 fail-open: 어떤 실패도 이어지는 성과 동기화를 깨지 않는다.
 * 스펙: docs/superpowers/specs/2026-07-10-naver-publish-discovery-design.md
 */

export interface RssItem { title: string; link: string; pubDate: string /* ISO */ }

/** HTML 엔티티 디코드 — 숫자(10/16진) → named 4종 → &amp; 마지막(이중 디코드 방지). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d: string) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** NFC 정규화 + 엔티티 디코드 + 공백(개행 포함) 1칸 축약 + 트림 — 매칭 전 제목 표준형(순수). */
export function normalizeTitle(s: string): string {
  return decodeEntities(String(s)).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** RSS 2.0 XML → 아이템 배열(정규식 파싱 — 의존성 0, 순수). CDATA·이형 방어, 이형이면 빈 배열(throw 금지).
 *  title 은 원문 보존(엔티티 디코드는 매칭 시 normalizeTitle 이 양쪽에 적용). pubDate 는 ISO 로 정규화. */
export function parseRssItems(xml: string): RssItem[] {
  const out: RssItem[] = [];
  if (typeof xml !== 'string' || !xml.includes('<item')) return out;
  for (const it of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
    const field = (tag: string): string => {
      const m = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return '';
      const raw = m[1] ?? '';
      const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      return (cdata ? cdata[1] ?? '' : raw).trim();
    };
    const title = field('title');
    const link = field('link');
    const t = Date.parse(field('pubDate'));
    if (!title || !link || !Number.isFinite(t)) continue;
    out.push({ title, link, pubDate: new Date(t).toISOString() });
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/analytics/naverDiscovery.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/analytics/naverDiscovery.ts src/analytics/naverDiscovery.test.ts
git commit -m "feat(perf): 네이버 발행 감지 순수부 1 — RSS 파싱·제목 정규화"
```

---

### Task 2: 순수 헬퍼 — selectDiscoveryTargets + matchPublished

**Files:**
- Modify: `src/analytics/naverDiscovery.ts` (Task 1 산출물에 추가)
- Test: `src/analytics/naverDiscovery.test.ts` (describe 블록 추가)

**Interfaces:**
- Consumes: Task 1 의 `RssItem`, `normalizeTitle`. `Piece` 타입(`src/content/pieces.ts:20` — `id/title/stage/brand?/publishedUrl?/naverDraftTs?` 사용).
- Produces: `selectDiscoveryTargets(pieces: Piece[], now: number): { targets: Piece[]; gaveUp: Piece[] }`, `matchPublished(pending: Array<{ id: string; title: string; draftTs: string }>, items: RssItem[]): { matched: Array<{ pieceId: string; url: string }>; ambiguous: string[] }` — Task 3 의 `discoverPublishedNaver` 가 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/analytics/naverDiscovery.test.ts` 에 추가:

```ts
import { selectDiscoveryTargets, matchPublished, type RssItem } from './naverDiscovery';
import type { Piece } from '../content/pieces';

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
    expect(r.matched).toEqual([{ pieceId: 'p1', url: 'https://blog.naver.com/tb/223900000001' }]);
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
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/analytics/naverDiscovery.test.ts`
Expected: FAIL — `selectDiscoveryTargets is not a function` 류(Task 1 테스트는 계속 PASS).

- [ ] **Step 3: 최소 구현**

`src/analytics/naverDiscovery.ts` 에 추가(파일 상단 import 도 추가):

```ts
import type { Piece } from '../content/pieces';

const HOUR = 3_600_000;
const GIVE_UP_MS = 30 * 24 * HOUR; // 포기 지평 30일 — 이후는 수동 등록 안내만(스펙 §4.1)

/** 감지 대상 선별(순수) — 임시저장됐고 아직 publishedUrl 없는 piece. 지평 초과분은 gaveUp. */
export function selectDiscoveryTargets(pieces: Piece[], now: number): { targets: Piece[]; gaveUp: Piece[] } {
  const targets: Piece[] = [];
  const gaveUp: Piece[] = [];
  for (const p of pieces) {
    if (!p.naverDraftTs || p.publishedUrl || p.stage === 'error') continue;
    const t = Date.parse(p.naverDraftTs);
    if (!Number.isFinite(t)) continue;
    (now - t > GIVE_UP_MS ? gaveUp : targets).push(p);
  }
  return { targets, gaveUp };
}

/** 네이버 블로그 글 링크인지(m.blog 포함) — naver_stats 의 parse_blog_url 이 소화 가능한 형태만. */
function isBlogLink(link: string): boolean {
  try { const h = new URL(link).host; return h === 'blog.naver.com' || h === 'm.blog.naver.com'; } catch { return false; }
}

/** 보수적 매칭(순수) — 정규화 제목 완전일치 && pubDate ≥ draftTs−1h && 양방향 유일.
 *  유일성 실패(동명 아이템 복수 또는 동명 대기 piece 복수)는 ambiguous — 자동 설정 금지. */
export function matchPublished(
  pending: Array<{ id: string; title: string; draftTs: string }>,
  items: RssItem[],
): { matched: Array<{ pieceId: string; url: string }>; ambiguous: string[] } {
  const matched: Array<{ pieceId: string; url: string }> = [];
  const ambiguous: string[] = [];
  const candidates = new Map<string, RssItem[]>();          // pieceId → 후보 아이템
  const titleOwners = new Map<string, number>();            // 정규화 제목 → 후보 보유 piece 수
  for (const p of pending) {
    const key = normalizeTitle(p.title);
    const draft = Date.parse(p.draftTs);
    if (!key || !Number.isFinite(draft)) continue;
    const cs = items.filter((it) =>
      normalizeTitle(it.title) === key && Date.parse(it.pubDate) >= draft - HOUR && isBlogLink(it.link));
    if (!cs.length) continue;                                // 후보 0 = 아직 미발행/제목 수정 — 침묵(다음 틱 재시도)
    candidates.set(p.id, cs);
    titleOwners.set(key, (titleOwners.get(key) ?? 0) + 1);
  }
  for (const p of pending) {
    const cs = candidates.get(p.id);
    if (!cs) continue;
    if (cs.length === 1 && titleOwners.get(normalizeTitle(p.title)) === 1) {
      matched.push({ pieceId: p.id, url: cs[0]!.link });
    } else {
      ambiguous.push(p.id);
    }
  }
  return { matched, ambiguous };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/analytics/naverDiscovery.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/analytics/naverDiscovery.ts src/analytics/naverDiscovery.test.ts
git commit -m "feat(perf): 네이버 발행 감지 순수부 2 — 대상 선별·보수적 매칭(양방향 유일)"
```

---

### Task 3: discoverPublishedNaver 오케스트레이션 + 일일 틱 배선

**Files:**
- Modify: `src/analytics/naverDiscovery.ts` (오케스트레이션 추가)
- Modify: `src/server/main.ts` (import 1줄 + 틱 run 1줄)

**Interfaces:**
- Consumes: Task 1·2 의 순수 헬퍼 전부. `pieceStore()`(`src/content/pieces.ts:122`, `list(): Piece[]`(:83)·`setPublished(id, url)`(:93)), `getNaverAccount(slug: string): { blogId: string; ... }`(`src/secrets/store.ts` — 범용 `''` 은 평면 키, 폴백 없음).
- Produces: `discoverPublishedNaver(): Promise<void>` — main.ts 틱이 소비. **절대 reject 하지 않는다**(전량 내부 catch).

- [ ] **Step 1: 오케스트레이션 구현** (얇은 조립 — 스펙 §6 에 따라 단위테스트 없음, 코드 리뷰로 검증)

`src/analytics/naverDiscovery.ts` 에 추가(상단 import 에 `pieceStore` 추가):

```ts
import { pieceStore } from '../content/pieces';
import { getNaverAccount } from '../secrets/store';
```

(기존 `import type { Piece }` 는 값 import 와 병합: `import { pieceStore, type Piece } from '../content/pieces';`)

```ts
const noticed = new Set<string>(); // 모호/포기 안내는 piece 당 1회(프로세스 생애)

/** 브랜드별 RSS 조회 → 보수적 매칭 → publishedUrl 자동 설정 + 피드 로그.
 *  전량 fail-open — 어떤 실패도 throw 로 새지 않는다(이어지는 syncPerformance 보장). */
export async function discoverPublishedNaver(): Promise<void> {
  try {
    const { targets, gaveUp } = selectDiscoveryTargets(pieceStore().list(), Date.now());
    for (const p of gaveUp) {
      if (noticed.has(p.id)) continue;
      noticed.add(p.id);
      console.log(`[성과분석] ${p.title.slice(0, 30)} — 임시저장 30일 경과, 자동 감지 포기. 발행했다면 URL 을 수동 등록해 주세요`);
    }
    if (!targets.length) return; // 대상 없으면 RSS 조회 0회
    const byBrand = new Map<string, Piece[]>();
    for (const p of targets) {
      const slug = p.brand ?? '';
      byBrand.set(slug, [...(byBrand.get(slug) ?? []), p]);
    }
    for (const [slug, pieces] of byBrand) {
      try {
        const blogId = getNaverAccount(slug).blogId;
        if (!blogId) { console.log(`[publish-discover] 브랜드 "${slug || '범용'}" blogId 미설정 — 건너뜀`); continue; }
        const res = await fetch(`https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`,
          { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) { console.log(`[publish-discover] RSS HTTP ${res.status} ("${slug || '범용'}") — 건너뜀`); continue; }
        const items = parseRssItems(await res.text());
        const { matched, ambiguous } = matchPublished(
          pieces.map((p) => ({ id: p.id, title: p.title, draftTs: p.naverDraftTs! })), items);
        for (const m of matched) {
          const p = pieceStore().setPublished(m.pieceId, m.url); // 삭제 경합이면 undefined — 무해
          if (p) console.log(`[성과분석] ${p.title.slice(0, 30)} — 네이버 발행 감지, 성과 추적 시작`);
        }
        for (const id of ambiguous) {
          if (noticed.has(id)) continue;
          noticed.add(id);
          const p = pieces.find((x) => x.id === id);
          console.log(`[성과분석] ${(p?.title ?? id).slice(0, 30)} — 동명 후보 복수, 자동 연결 보류. 발행 URL 을 수동 등록해 주세요`);
        }
      } catch (e) {
        console.log(`[publish-discover] "${slug || '범용'}" 감지 실패(무해): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    console.log(`[publish-discover] 감지 실패(무해): ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 2: 틱 배선**

`src/server/main.ts` — import 블록(57행 부근, `../analytics/cardnewsPerf` 다음)에 추가:

```ts
import { discoverPublishedNaver } from '../analytics/naverDiscovery';
```

틱(2532행 부근) — 기존:

```ts
const stopPerfSync = startDaily({
  time: CONFIG.performanceSyncTime,
  run: () => { void syncPerformance(); void syncShortsPerformance(); void syncCardnewsPerformance(); }, // 쇼츠·카드뉴스는 순수 API — 프로필 락 무관
  log: (m) => console.log('[perf-sync]', m),
});
```

를 다음으로 교체(발행 감지 → piece 동기화 순차, 나머지 병행):

```ts
const stopPerfSync = startDaily({
  time: CONFIG.performanceSyncTime,
  // 네이버 발행 감지(공개 RSS — 프로필 락 무관)가 publishedUrl 을 채운 뒤 piece 동기화. 쇼츠·카드뉴스는 순수 API 라 병행.
  run: () => { void discoverPublishedNaver().then(() => syncPerformance()); void syncShortsPerformance(); void syncCardnewsPerformance(); },
  log: (m) => console.log('[perf-sync]', m),
});
```

(`discoverPublishedNaver` 는 reject 하지 않으므로 `.then` 체인에 catch 불필요 — Task 브리프의 fail-open 계약.)

- [ ] **Step 3: 전체 검증**

```bash
npx tsc --noEmit          # 0 에러
npx vitest run src        # 전체 스위트 PASS(기존 355 + 신규 13)
```

Expected: 둘 다 그린. main.ts 배선은 컴파일+리뷰로 검증(스펙 §6 — sync 계열과 동일 기준).

- [ ] **Step 4: 커밋**

```bash
git add src/analytics/naverDiscovery.ts src/server/main.ts
git commit -m "feat(perf): 네이버 발행 자동 감지 — RSS 매칭으로 publishedUrl 자동 설정+일일 틱 배선"
```

---

## 실검증 (사용자 동반 — 서브에이전트 태스크 아님)

구현 3태스크 완료 후 컨트롤러가 사용자와 함께 수행(스펙 §8 완료 기준 2):

1. `PERFORMANCE_SYNC_TIME` 설정 확인(.env — 값은 출력 금지).
2. 실제 piece 1건 임시저장 → 사용자가 네이버에서 발행(제목 무수정).
3. 감지 1회 실행 — 서버 재시작 없이: `npx tsx -e "import('./src/analytics/naverDiscovery.js').then(m => m.discoverPublishedNaver())"`
   (서버 구동 중이면 pieces/index.json 동시 쓰기를 피하기 위해 서버를 잠시 멈추거나 틱 시각을 근접 설정해 틱으로 확인).
4. `publishedUrl` 자동 설정 + `[성과분석] … 발행 감지` 로그 확인.
5. `POST /pieces/:id/collect-metrics` 로 naver_stats 실런 1회 — `views/searchInflow` 가 `ingestMetrics` 까지 도달하는지 확인. 발견되는 수집 추출 결함은 이 사이클 안에서 수정.

## Self-Review 결과

- 스펙 커버리지: §4.1 순수 헬퍼 4종+진입점(Task 1·2·3), §4.2 매칭 규칙(Task 2 테스트가 경계 포함 고정), §4.3 배선(Task 3), §4.4 수동 경로 무변경(어느 태스크도 라우트 미접촉), §5 에러 처리(Task 3 fail-open 구조), §6 테스트(순수부 단위·조립은 리뷰), §8 실검증(별도 섹션) — 누락 없음.
- 플레이스홀더: 없음(전 스텝 실코드).
- 타입 일관성: `RssItem`/`matchPublished` 시그니처가 Task 1→2→3 에서 동일. `pend()` 헬퍼의 `draftTs` 기본값(2일 전)은 시각 조건 통과. Task 2 테스트의 `import type { Piece }` 는 Task 3 에서 값 import 와 병합돼도 테스트 파일 쪽은 무관.
