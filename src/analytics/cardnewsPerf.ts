/**
 * 카드뉴스 메타 성과 수집·강화 — 발행된 카드뉴스(igMediaId·publishedTs)의 IG 인사이트
 * (views·reach·saved·shares·likes·comments)와 FB 반응을 매일 수집해 시계열(appendMetrics)에
 * 쌓고, 측정창(shortsPerfDays 재사용) 경과 시 1회 강화(cardnews_planner·designer 메모리+위키,
 * perfReflected 멱등). 전량 fail-open — shortsPerf.ts 의 사촌(스펙 §7).
 */
import { CONFIG } from '../config';
import { fetchTimeout } from '../util/fetch';
import { getMetaAccount } from '../secrets/store';
import { GRAPH, FB_GRAPH } from '../tools/metaPublish';
import { appendMetrics, readMetrics, type MetricSample } from './performance';
import { shouldRecordMemory } from './shortsPerf';
import { cardNewsStore, type CardNews } from '../content/cardnews';
import { isSafeBrandSlug } from '../content/brand';
import { llmWikiFor } from '../wiki/llmwiki';
import { appendMemory, appendActivity } from '../agents/workspace';

/** 카드뉴스 성과 → 0~1 스칼라(순수) — 도달 로그 0.4 + 저장률(2%≈만점) 0.35 + 공유율(1%≈만점) 0.25.
 *  perf_analyst 진단 기준(저장=실용 가치·공유=공감 가치 중심)과 일치, 강화 임계 0.6 규약 공유. */
export function cardnewsSignal(reach: number, saved: number, shares: number): number {
  const reachScore = Math.min(1, Math.log10(Math.max(0, reach) + 1) / 4); // 1만 도달 ≈ 1.0
  const savedRate = reach > 0 ? Math.min(1, saved / reach / 0.02) : 0;
  const shareRate = reach > 0 ? Math.min(1, shares / reach / 0.01) : 0;
  return 0.4 * reachScore + 0.35 * savedRate + 0.25 * shareRate;
}
/** IG insights 응답 → {지표명: 값}(순수) — 이형·결측·음수 방어. */
export function parseIgInsights(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const it of data) {
    const o = it as { name?: unknown; values?: Array<{ value?: unknown }> };
    if (typeof o?.name !== 'string') continue;
    const v = Number(o.values?.[0]?.value);
    out[o.name] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return out;
}
/** FB 게시물 필드 응답 → 반응·댓글·공유 수(순수). */
export function parseFbEngagement(json: unknown): { likes: number; comments: number; shares: number } {
  const o = json as {
    reactions?: { summary?: { total_count?: unknown } };
    comments?: { summary?: { total_count?: unknown } };
    shares?: { count?: unknown };
  } | null;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  return { likes: n(o?.reactions?.summary?.total_count), comments: n(o?.comments?.summary?.total_count), shares: n(o?.shares?.count) };
}
/**
 * FB 게시물 인사이트 응답 → 조회수(순수).
 *
 * 사진 게시물(카드뉴스)의 '조회수'는 릴스와 달리 노드 필드가 아니다 — `?fields=views` 는
 * "nonexisting field (views)" 로 거부되고, 인사이트 지표로만 온다(실측 2026-07-27).
 * 지표명은 post_media_view — post_impressions 계열은 2025-11-15 자로 폐기돼 이제
 * "must be a valid insights metric" 오류가 난다. 응답 형태는 IG 인사이트와 같다.
 */
export function parseFbPostViews(json: unknown): number {
  return parseIgInsights(json).post_media_view ?? 0;
}
/** 이번 틱 수집 대상인가(순수) — shortsPerfDue 미러(igMediaId·publishedTs 기준, 포기 지평 4배). */
export function cardnewsPerfDue(
  c: Pick<CardNews, 'igMediaId' | 'fbPostId' | 'publishedTs' | 'perfReflected'>, now: number, days: number,
): boolean {
  // 어느 채널이든 게시됐으면 대상 — 페북 페이지만 연결된 카드가 수집에서 통째 빠지지 않게.
  if ((!c.igMediaId && !c.fbPostId) || !c.publishedTs) return false;
  const t = new Date(c.publishedTs).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age > days * 4 * 86_400_000) return false;
  return age <= days * 86_400_000 || !c.perfReflected;
}

/** 대시보드 '수집 불가'(순수) — shortsPerfStale 의 카드뉴스 판(미반영 + 수집 대상 아님 = 영구 정체). */
export function cardnewsPerfStale(
  c: Pick<CardNews, 'igMediaId' | 'publishedTs' | 'perfReflected'>, now: number, days: number,
): boolean {
  return !c.perfReflected && !cardnewsPerfDue(c, now, days);
}

/** 강화 1회 — reinforceShorts 미러. 역할 부재·위키 실패는 무해. 신호를 반환. */
function reinforceCardnews(card: CardNews, m: MetricSample): number {
  const signal = cardnewsSignal(m.reach ?? 0, m.saved ?? 0, m.shares ?? 0);
  const brand = card.brand && isSafeBrandSlug(card.brand) ? card.brand : '';
  const verdict = signal >= 0.6
    ? '이 주제·표지 훅·비주얼이 저장·공유로 이어짐 — 유사 각도 유지'
    : '저장·공유 저조 — 표지 훅과 장당 메시지 밀도 재고';
  const igOnlySamples = readMetrics(card.id).filter((s) => s.source === 'meta:ig').length;
  if (shouldRecordMemory(signal, igOnlySamples)) {
    for (const role of ['cardnews_planner', 'cardnews_designer']) {
      try {
        appendMemory(role, `카드뉴스 성과: "${card.topic}"${card.keyword ? ` (키워드 "${card.keyword}")` : ''} — 도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0}·공유 ${m.shares ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, brand);
        appendActivity(role, `📈 카드뉴스 성과 학습: ${card.topic.slice(0, 40)}`);
      } catch { /* 역할 부재 등 — 무해 */ }
    }
  }
  try {
    const w = llmWikiFor(brand);
    w.upsertPage({
      title: `카드뉴스 성과: ${card.topic}`, type: 'performance',
      body:
        `도달 ${m.reach ?? 0} · 저장 ${m.saved ?? 0} · 공유 ${m.shares ?? 0} · 조회 ${m.views} · 좋아요 ${m.likes ?? 0} · 댓글 ${m.comments ?? 0} · 성과신호 ${signal.toFixed(2)}\n` +
        `키워드: ${card.keyword ?? '-'} · 브랜드: ${card.brand ?? '범용'}\n` +
        (card.igPermalink ? `\n[근거: ${card.igPermalink}]` : '') +
        w.relatedLine([card.keyword], [`${card.topic} (요약)`]),
      summary: `카드뉴스 "${card.topic}" 성과신호 ${signal.toFixed(2)} (도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0})`,
      sources: [card.igPermalink ? `perf:${card.igPermalink}` : 'perf:meta'],
      aliases: card.keyword ? [card.keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }
  return signal;
}

/** 일일 카드뉴스 성과 동기화 — perf-sync 틱에서 piece·쇼츠 동기화와 나란히 호출. */
export async function syncCardnewsPerformance(opts: { force?: boolean } = {}): Promise<void> {
  try {
    const days = CONFIG.shortsPerfDays; // 측정 창은 쇼츠와 동일 상수 재사용(스펙 §7)
    const now = Date.now();
    // force = 새로고침 전체 재수집(창·지평 무시) — syncShortsPerformance 와 동일 규약.
    const due = cardNewsStore().list().filter((x) => opts.force
      ? ((!!x.igMediaId || !!x.fbPostId) && !!x.publishedTs)
      : cardnewsPerfDue(x, now, days));
    for (const card of due) {
      try {
        const acct = getMetaAccount(card.brand ?? '');
        if (!acct.pageAccessToken && !acct.pageToken) continue; // 양쪽 다 미연결 — 스킵
        // 채널별로 독립 수집한다. IG 실패(삭제된 게시물·토큰 만료)가 FB 수집을 함께 죽이던 구조를 피한다.
        let igSample: MetricSample | null = null;
        if (card.igMediaId && acct.pageAccessToken) {
          try {
            const qs = `access_token=${encodeURIComponent(acct.pageAccessToken)}`;
            const ir = await fetchTimeout(`${GRAPH}/${card.igMediaId}/insights?metric=views,reach,saved,shares,likes,comments&${qs}`, {});
            if (!ir.ok) throw new Error(`IG insights HTTP ${ir.status}`);
            const ig = parseIgInsights(await ir.json());
            igSample = {
              measuredAt: new Date().toISOString(),
              views: ig.views ?? 0, reach: ig.reach ?? 0, saved: ig.saved ?? 0, shares: ig.shares ?? 0,
              likes: ig.likes ?? 0, comments: ig.comments ?? 0, searchInflow: [], source: 'meta:ig',
            };
            appendMetrics(card.id, igSample);
          } catch (e) { console.log('[perf-sync]', `카드뉴스 ${card.id} IG 수집 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
        }
        // FB 는 부가 채널 — 호스트·토큰이 IG 와 완전히 다르다(graph.facebook.com + 페이지 액세스 토큰).
        if (card.fbPostId && acct.pageToken) {
          try {
            const fbQs = `access_token=${encodeURIComponent(acct.pageToken)}`;
            const fr = await fetchTimeout(`${FB_GRAPH}/${card.fbPostId}?fields=reactions.summary(true),comments.summary(true),shares&${fbQs}`, {});
            if (fr.ok) {
              const fb = parseFbEngagement(await fr.json());
              // 조회수는 별도 인사이트 호출 — 사진 게시물엔 views 필드가 없다(릴스와 다른 점).
              // 실패·무권한이어도 반응·댓글·공유는 그대로 남긴다(조회수만 0).
              let views = 0;
              try {
                const vr = await fetchTimeout(`${FB_GRAPH}/${card.fbPostId}/insights?metric=post_media_view&${fbQs}`, {});
                if (vr.ok) views = parseFbPostViews(await vr.json());
              } catch { /* 조회수만 실패 — 나머지 지표는 살린다 */ }
              appendMetrics(card.id, { measuredAt: new Date().toISOString(), views, likes: fb.likes, comments: fb.comments, shares: fb.shares, searchInflow: [], source: 'meta:fb' });
            }
          } catch { /* 부가 채널 fail-open */ }
        }
        // 강화 신호는 IG 지표 정의 기반 — IG 표본을 못 얻었으면 다음 틱으로 미룬다(0 으로 잘못 강화 금지).
        const windowOver = now - new Date(card.publishedTs!).getTime() > days * 86_400_000;
        if (windowOver && !card.perfReflected && igSample) {
          const sig = reinforceCardnews(card, igSample);
          cardNewsStore().update(card.id, { perfReflected: true });
          console.log('[perf-sync]', `카드뉴스 강화 완료: ${card.topic.slice(0, 30)} (신호 ${sig.toFixed(2)})`);
        }
      } catch (e) { console.log('[perf-sync]', `카드뉴스 ${card.id} 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { console.log('[perf-sync]', `카드뉴스 동기화 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
}
