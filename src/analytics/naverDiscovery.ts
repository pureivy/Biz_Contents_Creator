/**
 * 네이버 발행 자동 감지 — 임시저장된 piece 가 사람 손으로 발행되면 블로그 공개 RSS 에서
 * 제목 매칭으로 최종 URL 을 찾아 publishedUrl 을 자동 설정한다(성과 수집기의 기동 조건).
 * 보수적 매칭(정규화 exact + 시각 조건 + 양방향 유일)만 자동 — 모호하면 피드 안내 후 수동 폴백.
 * 전량 fail-open: 어떤 실패도 이어지는 성과 동기화를 깨지 않는다.
 * 스펙: docs/superpowers/specs/2026-07-10-naver-publish-discovery-design.md
 */

import { pieceStore } from '../content/pieces';
import type { Piece } from '../content/pieces';
import { getNaverAccount } from '../secrets/store';

export interface RssItem { title: string; link: string; pubDate: string /* ISO */ }

/** HTML 엔티티 디코드 — 숫자(10/16진) → named 4종 → &amp; 마지막(이중 디코드 방지). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d: string) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    // 숫자형 앰퍼샌드(&#38;lt; 등)는 이중 디코드됨 — 알려진 비대칭. 최악이 매칭 실패(침묵→수동 폴백)라 수용.
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
): { matched: Array<{ pieceId: string; url: string; pubDate: string }>; ambiguous: string[] } {
  const matched: Array<{ pieceId: string; url: string; pubDate: string }> = [];
  const ambiguous: string[] = [];
  const candidates = new Map<string, RssItem[]>();          // pieceId → 후보 아이템
  // 정규화 제목 → 후보 보유 piece 수. "후보 없는 동명 piece" 는 세지 않아도 유일성 판정이 성립하는데,
  // 이는 piece 의존 필터가 단방향 시각 조건(≥ draftTs−1h)뿐이라 동명 piece 들의 후보 집합이 전순서로
  // 중첩되기 때문 — 양방향 시각 창 등으로 바꾸면 이 등가성이 깨진다(주의).
  const titleOwners = new Map<string, number>();
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
      matched.push({ pieceId: p.id, url: cs[0]!.link, pubDate: cs[0]!.pubDate }); // pubDate = 실제 발행시각(발행일 앵커)
    } else {
      ambiguous.push(p.id);
    }
  }
  return { matched, ambiguous };
}

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
          const p = pieceStore().setPublished(m.pieceId, m.url, m.pubDate); // pubDate = 실제 발행시각 → publishedTs (삭제 경합이면 undefined — 무해)
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
