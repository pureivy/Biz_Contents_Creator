/**
 * 유튜브 쇼츠 성과 수집·강화 — 업로드된 쇼츠(youtubeId·youtubeTs)의 조회수·좋아요·댓글을
 * videos.list(YOUTUBE_API_KEY, 50개 배치=1쿼터단위)로 매일 수집해 기존 시계열(appendMetrics)에
 * 쌓고, 측정창(SHORTS_PERF_DAYS) 경과 시 1회 강화(shorts_writer·shorts_director 메모리+위키,
 * perfReflected 멱등). 비공개 영상은 API 가 통계를 안 주므로 자동 스킵 — 공개 전환 후 재개(스펙 §9).
 * 전량 fail-open — 실패는 해당 쇼츠만 스킵, 다음 틱 재시도. reinforceFromPerformance(piece)의 사촌.
 */
import { CONFIG } from '../config';
import { getSecret, getMetaAccount } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { appendMetrics, readMetrics, type MetricSample } from './performance';
import { shortsStore, type Shorts } from '../content/shorts';
import { isSafeBrandSlug, activeBrandSlug, getBrand } from '../content/brand';
import { llmWikiFor } from '../wiki/llmwiki';
import { appendMemory, appendActivity } from '../agents/workspace';
import { pieceStore } from '../content/pieces';
import { GRAPH, FB_GRAPH } from '../tools/metaPublish';
// cardnewsPerf ↔ shortsPerf 순환 — 함수 선언만이라 안전(최상위 상호 호출 없음)
import { cardnewsSignal, parseIgInsights } from './cardnewsPerf';

export interface VideoStats { views: number; likes: number; comments: number }

/** 쇼츠 성과 → 0~1 스칼라(순수) — views 로그 스케일(1만뷰≈1.0) 0.8 + 좋아요율(1%≈만점) 0.2. */
export function shortsSignal(views: number, likes: number): number {
  const viewScore = Math.min(1, Math.log10(Math.max(0, views) + 1) / 4);
  const likeScore = views > 0 ? Math.min(1, likes / views / 0.01) : 0;
  return 0.8 * viewScore + 0.2 * likeScore;
}

/** videos.list 응답 → videoId→통계 Map(순수) — 이형·결측·음수 방어. */
export function parseStatsResponse(json: unknown): Map<string, VideoStats> {
  const out = new Map<string, VideoStats>();
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return out;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  for (const it of items) {
    const o = it as { id?: unknown; statistics?: { viewCount?: unknown; likeCount?: unknown; commentCount?: unknown } };
    const id = typeof o?.id === 'string' ? o.id : '';
    if (!id) continue;
    out.set(id, { views: n(o.statistics?.viewCount), likes: n(o.statistics?.likeCount), comments: n(o.statistics?.commentCount) });
  }
  return out;
}

/** 이번 틱 수집 대상인가(순수) — 창 내 매일, 또는 창 경과 후 미강화(강화 기회 유실 방지). */
export function shortsPerfDue(s: Pick<Shorts, 'youtubeId' | 'youtubeTs' | 'perfReflected'>, now: number, days: number): boolean {
  if (!s.youtubeId || !s.youtubeTs) return false;
  const t = new Date(s.youtubeTs).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age > days * 4 * 86_400_000) return false; // 포기 지평(측정창 4배) — 영구 비공개/삭제 영상 무한 재시도 방지
  return age <= days * 86_400_000 || !s.perfReflected;
}

/**
 * 강화 시 역할 메모리 기록 여부(순수) — 긍정(≥0.6)은 즉시, 부정은 공개 상태 실측 2틱 이상일 때만.
 * 비공개→늦공개 쇼츠가 공개 직후 낮은 조회수로 "저조" 오귀속되는 것을 차단(스펙 §9 상호작용).
 * 위키 적재는 이 게이트와 무관하게 항상 수행(수치 보존).
 */
export function shouldRecordMemory(signal: number, publicSampleCount: number): boolean {
  return signal >= 0.6 || publicSampleCount >= 2;
}

/** 소스별 샘플 수(순수) — 유튜브·메타 샘플이 한 JSONL 에 공존하므로 게이트 카운트는 소스 필터 필수
 *  (무필터 시 메타 샘플 혼입으로 카운트가 부풀어 비공개→늦공개 오귀속 방지 게이트가 무력화됨, 스펙 §4.3). */
export function countSamples(samples: Pick<MetricSample, 'source'>[], source: string): number {
  return samples.filter((s) => s.source === source).length;
}

/**
 * FB 비디오(릴스) 노드 응답 → 지표(순수). 게시물 노드와 형태가 다르다 — views 는 스칼라,
 * likes·comments 는 edge 의 summary.total_count. 이형·결측·음수 방어.
 */
export function parseFbVideoStats(json: unknown): { views: number; likes: number; comments: number } {
  const o = json as {
    views?: unknown;
    likes?: { summary?: { total_count?: unknown } };
    comments?: { summary?: { total_count?: unknown } };
  } | null;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  return { views: n(o?.views), likes: n(o?.likes?.summary?.total_count), comments: n(o?.comments?.summary?.total_count) };
}

/** 이번 틱 메타(릴스) 수집 대상인가(순수) — shortsPerfDue 의 메타 채널 판. 유튜브 창과 독립. */
export function shortsMetaPerfDue(
  s: Pick<Shorts, 'igReelId' | 'fbReelId' | 'metaPublishedTs' | 'metaPerfReflected'>, now: number, days: number,
): boolean {
  // 어느 채널이든 게시됐으면 대상 — 페북 페이지만 연결된 쇼츠가 수집에서 통째 빠지지 않게.
  if ((!s.igReelId && !s.fbReelId) || !s.metaPublishedTs) return false;
  const t = new Date(s.metaPublishedTs).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age > days * 4 * 86_400_000) return false; // 포기 지평(측정창 4배) — 삭제 릴스 무한 재시도 방지
  return age <= days * 86_400_000 || !s.metaPerfReflected;
}

/**
 * 대시보드 '수집 불가'(순수) — 미반영인데 수집 대상도 아님 = 영구 정체(비공개·삭제·id 없음·포기 지평 경과).
 * due 술어를 그대로 뒤집어 쓰므로 수집 게이트가 바뀌면 표시도 저절로 따라온다(로직 이원화 금지).
 * '측정 중'(창 안 정상 대기)과 구분하지 않으면 죽은 행이 대기 중인 척 대시보드에 영원히 남는다.
 */
export function shortsPerfStale(
  s: Pick<Shorts, 'youtubeId' | 'youtubeTs' | 'perfReflected'>, now: number, days: number,
): boolean {
  return !s.perfReflected && !shortsPerfDue(s, now, days);
}

/** 대시보드 '수집 불가' — 메타(릴스) 판. shortsPerfStale 의 메타 채널 미러. */
export function shortsMetaPerfStale(
  s: Pick<Shorts, 'igReelId' | 'fbReelId' | 'metaPublishedTs' | 'metaPerfReflected'>, now: number, days: number,
): boolean {
  return !s.metaPerfReflected && !shortsMetaPerfDue(s, now, days);
}

/** videos.list 50개 배치 — 키 없으면 빈 Map. 배치별 fail-open — 성공한 배치는 보존. */
async function fetchVideoStats(videoIds: string[], signal?: AbortSignal): Promise<Map<string, VideoStats>> {
  const key = getSecret('YOUTUBE_API_KEY');
  const out = new Map<string, VideoStats>();
  if (!key || !videoIds.length) return out;
  for (let i = 0; i < videoIds.length; i += 50) {
    const ids = videoIds.slice(i, i + 50).join(',');
    try {
      const r = await fetchTimeout(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${encodeURIComponent(key)}`, {}, signal);
      if (!r.ok) throw new Error(`videos.list HTTP ${r.status}`);
      for (const [id, st] of parseStatsResponse(await r.json())) out.set(id, st);
    } catch (e) { // 배치별 fail-open — 성공한 배치 결과는 보존, 실패분은 다음 틱 재시도
      console.log('[perf-sync]', `videos.list 배치 실패(해당 ≤50건 이번 틱 스킵): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** 강화 1회 — reinforceFromPerformance(piece) 미러. 역할 부재·위키 실패는 무해. 신호를 반환. */
function reinforceShorts(s: Shorts, m: MetricSample): number {
  const signal = shortsSignal(m.views, m.likes ?? 0);
  const keyword = s.sourcePieceId
    ? (() => { try { return pieceStore().get(s.sourcePieceId!)?.keyword; } catch { return undefined; } })() ?? s.keyword
    : s.keyword;
  const brand = s.brand && isSafeBrandSlug(s.brand) ? s.brand : ''; // 경로 싱크 재검증(관례) — 비정상 슬러그는 범용 강등
  const title = s.title ?? s.topic;
  const verdict = signal >= 0.6 ? '이 주제·구성이 노출로 이어짐 — 유사 각도 유지' : '노출 저조 — 훅·주제 각도 재고';
  if (shouldRecordMemory(signal, countSamples(readMetrics(s.id), 'youtube:api'))) {
    for (const role of ['shorts_writer', 'shorts_director']) {
      try {
        appendMemory(role, `쇼츠 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 조회 ${m.views}·좋아요 ${m.likes ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, brand);
        appendActivity(role, `📈 쇼츠 성과 학습: ${title.slice(0, 40)}`);
      } catch { /* 역할 부재 등 — 무해 */ }
    }
  }
  try {
    const w = llmWikiFor(brand);
    w.upsertPage({
      title: `쇼츠 성과: ${title}`, type: 'performance',
      body:
        `조회 ${m.views}회 · 좋아요 ${m.likes ?? 0} · 댓글 ${m.comments ?? 0} · 성과신호 ${signal.toFixed(2)}\n` +
        `키워드: ${keyword ?? '-'} · 브랜드: ${s.brand ?? '범용'}\n` +
        (s.youtubeUrl ? `\n[근거: ${s.youtubeUrl}]` : '') +
        w.relatedLine([keyword], [`${s.topic} (요약)`]),
      summary: `쇼츠 "${title}" 성과신호 ${signal.toFixed(2)} (조회 ${m.views})`,
      sources: [s.youtubeUrl ? `perf:${s.youtubeUrl}` : 'perf:youtube'],
      aliases: keyword ? [keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }
  return signal;
}

/** 일일 쇼츠 성과 동기화 — perf-sync 틱에서 piece 동기화와 나란히 호출(Task 3). */
export async function syncShortsPerformance(opts: { force?: boolean } = {}): Promise<void> {
  try {
    if (!getSecret('YOUTUBE_API_KEY')) return; // 커넥터 키 없음 — no-op
    const days = CONFIG.shortsPerfDays;
    const now = Date.now();
    // force(대시보드 새로고침) = 측정창·포기 지평 무시하고 업로드된 전부 재수집 — 사용자 제보 2026-07-31
    // "새로고침해도 옛 콘텐츠 숫자가 안 변함"(창 경과+강화 후 동결이 원인). 강화는 기존 게이트 그대로 1회.
    const due = shortsStore().list().filter((s) => opts.force ? (!!s.youtubeId && !!s.youtubeTs) : shortsPerfDue(s, now, days));
    if (!due.length) return;
    const stats = await fetchVideoStats(due.map((s) => s.youtubeId!));
    for (const s of due) {
      try {
        const st = stats.get(s.youtubeId!);
        if (!st) { console.log('[perf-sync]', `쇼츠 ${s.id} 통계 없음(비공개/삭제) — 스킵`); continue; }
        const sample: MetricSample = {
          measuredAt: new Date().toISOString(), views: st.views, likes: st.likes, comments: st.comments,
          searchInflow: [], source: 'youtube:api',
        };
        appendMetrics(s.id, sample);
        const windowOver = now - new Date(s.youtubeTs!).getTime() > days * 86_400_000;
        if (windowOver && !s.perfReflected) {
          const sig = reinforceShorts(s, sample);
          shortsStore().update(s.id, { perfReflected: true });
          console.log('[perf-sync]', `쇼츠 강화 완료: ${(s.title ?? s.topic).slice(0, 30)} (신호 ${sig.toFixed(2)})`);
        }
      } catch (e) { console.log('[perf-sync]', `쇼츠 ${s.id} 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { console.log('[perf-sync]', `쇼츠 동기화 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
}

/** 릴스 강화 1회 — reinforceShorts 의 메타 채널 판. 신호는 도달·저장률·공유율(cardnewsSignal 재사용). */
function reinforceShortsMeta(s: Shorts, m: MetricSample): number {
  const signal = cardnewsSignal(m.reach ?? 0, m.saved ?? 0, m.shares ?? 0);
  const keyword = s.sourcePieceId
    ? (() => { try { return pieceStore().get(s.sourcePieceId!)?.keyword; } catch { return undefined; } })() ?? s.keyword
    : s.keyword;
  const brand = s.brand && isSafeBrandSlug(s.brand) ? s.brand : '';
  const title = s.title ?? s.topic;
  const verdict = signal >= 0.6 ? '이 주제·훅이 릴스에서 저장·공유로 이어짐 — 유사 각도 유지' : '릴스 저장·공유 저조 — 훅·초반 5초 재고';
  if (shouldRecordMemory(signal, countSamples(readMetrics(s.id), 'meta:ig'))) {
    for (const role of ['shorts_writer', 'shorts_director']) {
      try {
        appendMemory(role, `릴스 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0}·공유 ${m.shares ?? 0}·조회 ${m.views}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, brand);
        appendActivity(role, `📈 릴스 성과 학습: ${title.slice(0, 40)}`);
      } catch { /* 역할 부재 등 — 무해 */ }
    }
  }
  try {
    llmWikiFor(brand).upsertPage({
      title: `릴스 성과: ${title}`, type: 'performance',
      body:
        `도달 ${m.reach ?? 0} · 저장 ${m.saved ?? 0} · 공유 ${m.shares ?? 0} · 조회 ${m.views} · 좋아요 ${m.likes ?? 0} · 댓글 ${m.comments ?? 0} · 성과신호 ${signal.toFixed(2)}\n` +
        `키워드: ${keyword ?? '-'} · 브랜드: ${s.brand ?? '범용'}\n` +
        (s.igPermalink ? `\n[근거: ${s.igPermalink}]` : ''),
      summary: `릴스 "${title}" 성과신호 ${signal.toFixed(2)} (도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0})`,
      sources: [s.igPermalink ? `perf:${s.igPermalink}` : 'perf:meta'],
      aliases: keyword ? [keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }
  return signal;
}

/** 일일 릴스 성과 동기화 — perf-sync 틱에서 유튜브·카드뉴스 동기화와 나란히 호출. 전량 fail-open. */
export async function syncShortsMetaPerformance(opts: { force?: boolean } = {}): Promise<void> {
  try {
    const days = CONFIG.shortsPerfDays;
    const now = Date.now();
    // force = 새로고침 전체 재수집(창·지평 무시) — syncShortsPerformance 와 동일 규약.
    const due = shortsStore().list().filter((s) => opts.force
      ? ((!!s.igReelId || !!s.fbReelId) && !!s.metaPublishedTs)
      : shortsMetaPerfDue(s, now, days));
    for (const s of due) {
      try {
        const acct = getMetaAccount(s.brand ?? '');
        if (!acct.pageAccessToken && !acct.pageToken) continue; // 양쪽 다 미연결 — 스킵
        // 채널별 독립 수집 — IG 실패(삭제된 릴스·토큰 만료)가 FB 수집을 함께 죽이지 않게.
        let sample: MetricSample | null = null;
        if (s.igReelId && acct.pageAccessToken) {
          try {
            const r = await fetchTimeout(`${GRAPH}/${s.igReelId}/insights?metric=views,reach,likes,comments,saved,shares&access_token=${encodeURIComponent(acct.pageAccessToken)}`, {});
            if (!r.ok) throw new Error(`IG insights HTTP ${r.status}`);
            const ig = parseIgInsights(await r.json());
            sample = {
              measuredAt: new Date().toISOString(),
              views: ig.views ?? 0, reach: ig.reach ?? 0, saved: ig.saved ?? 0, shares: ig.shares ?? 0,
              likes: ig.likes ?? 0, comments: ig.comments ?? 0, searchInflow: [], source: 'meta:ig',
            };
            appendMetrics(s.id, sample);
          } catch (e) { console.log('[perf-sync]', `릴스 ${s.id} IG 수집 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
        }
        // FB 릴스 반응 — 부가 채널(fail-open). 비디오 노드를 직접 조회한다: post_id 로 게시물 노드를 거치는
        // 2단 경로는 '(#12) singular statuses API is deprecated' 로 실패했다(실측 2026-07-27).
        // 호스트·토큰은 FB 전용(graph.facebook.com + 페이지 토큰). 강화 신호는 IG 표본만 쓴다.
        if (s.fbReelId && acct.pageToken) {
          try {
            const fr = await fetchTimeout(`${FB_GRAPH}/${s.fbReelId}?fields=views,likes.summary(true),comments.summary(true)&access_token=${encodeURIComponent(acct.pageToken)}`, {});
            if (fr.ok) {
              const fb = parseFbVideoStats(await fr.json());
              appendMetrics(s.id, { measuredAt: new Date().toISOString(), views: fb.views, likes: fb.likes, comments: fb.comments, shares: 0, searchInflow: [], source: 'meta:fb' });
            }
          } catch { /* 부가 채널 fail-open */ }
        }
        // 강화 신호는 IG 지표 정의 기반 — IG 표본을 못 얻었으면 다음 틱으로 미룬다(0 으로 잘못 강화 금지).
        const windowOver = now - new Date(s.metaPublishedTs!).getTime() > days * 86_400_000;
        if (windowOver && !s.metaPerfReflected && sample) {
          const sig = reinforceShortsMeta(s, sample);
          shortsStore().update(s.id, { metaPerfReflected: true });
          console.log('[perf-sync]', `릴스 강화 완료: ${(s.title ?? s.topic).slice(0, 30)} (신호 ${sig.toFixed(2)})`);
        }
      } catch (e) { console.log('[perf-sync]', `릴스 ${s.id} 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { console.log('[perf-sync]', `릴스 동기화 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
}

/** 키워드 계열별 실측 요약(순수, 테스트 대상) — shortsTopicSignalBlock 의 집계 코어.
 *  rows: 쇼츠 1편 = 1행(발행 72h+ 경과분의 최신 YT·IG 조회수, 미측정 채널은 음수).
 *  미측정(-1)은 0 이 아니라 '없음'으로 다룬다 — 단일 채널만 발행된 계열이 합산 랭킹에서 '부진'으로
 *  오귀속되던 리뷰 지적 대응. 랭킹 키는 측정된 채널 중앙값의 최대값(채널 커버리지 차이에 강건). */
export function aggregateShortsTopicRows(
  rows: Array<{ label: string; yt: number; ig: number }>,
): Array<{ label: string; n: number; ytMed: number | null; igMed: number | null }> {
  const median = (xs: number[]): number | null => {
    const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2)) : null;
  };
  const byLabel = new Map<string, { yts: number[]; igs: number[] }>();
  for (const r of rows) {
    const g = byLabel.get(r.label) ?? { yts: [], igs: [] };
    g.yts.push(r.yt); g.igs.push(r.ig);
    byLabel.set(r.label, g);
  }
  return [...byLabel.entries()]
    .map(([label, g]) => ({ label, n: g.yts.length, ytMed: median(g.yts), igMed: median(g.igs) }))
    .sort((a, b) => Math.max(b.ytMed ?? 0, b.igMed ?? 0) - Math.max(a.ytMed ?? 0, a.igMed ?? 0));
}

/**
 * 주제 두뇌 주입용 쇼츠 채널 실측 블록 — 조회수 감사(2026-08-20)의 배선 공백 봉합: 쇼츠 YT/IG 성과는
 * 직원 메모리·위키에만 쌓이고 주제 선정(winners=블로그 지표 전용)에는 한 번도 닿지 않았다.
 * 소재를 코드에 박지 않는다(브랜드 오염 금지 원칙) — 실데이터에서 상·하위 계열을 뽑아 보여줄 뿐,
 * 판단은 두뇌(LLM)가 브랜드 컨텍스트 안에서 한다. 발행 72h 미만은 제외(YT 조회수는 72h 내 완결 실측
 * — 신작의 낮은 수치가 '부진'으로 오귀속되는 연령 편향 차단). 표본 부족·실패는 빈 문자열(무주입).
 */
export function shortsTopicSignalBlock(slug?: string): string {
  try {
    const brand = slug ?? activeBrandSlug();
    const now = Date.now();
    const rows: Array<{ label: string; yt: number; ig: number }> = [];
    for (const s of shortsStore().list()) {
      if ((s.brand ?? '') !== (brand || '')) continue;
      const pubTs = s.youtubeTs ?? s.metaPublishedTs;
      if (!pubTs) continue; // 미발행 — 실측 없음
      const age = now - new Date(pubTs).getTime();
      if (!Number.isFinite(age) || age < 3 * 86_400_000) continue;
      const samples = readMetrics(s.id);
      const latest = (source: string): number => {
        for (let i = samples.length - 1; i >= 0; i--) { const x = samples[i]!; if (x.source === source) return x.views; }
        return -1;
      };
      const yt = latest('youtube:api'); const ig = latest('meta:ig');
      if (yt < 0 && ig < 0) continue; // 측정 자체가 없음(비공개 등)
      let keyword = (s.sourcePieceId
        ? (() => { try { return pieceStore().get(s.sourcePieceId!)?.keyword; } catch { return undefined; } })() ?? s.keyword
        : s.keyword)?.trim();
      // 함정어 세탁(리뷰 지적) — 라벨에 avoidJargon 함정어가 그대로 실리면 같은 프롬프트의 어휘 지침
      // ("시비→…로 풀어 써라")과 충돌해 두뇌가 함정어 변형 후보를 내고 하드 게이트에 기각당한다.
      for (const j of getBrand()?.avoidJargon ?? []) {
        if (keyword?.includes(j.term)) keyword = keyword.split(j.term).join(j.use);
      }
      rows.push({ label: keyword || (s.title ?? s.topic).slice(0, 24), yt, ig });
    }
    const agg = aggregateShortsTopicRows(rows);
    if (agg.length < 6) return ''; // 표본 게이트 — 계열이 적으면 무주입(titleTypeGuidance 와 동일 사상)
    const num = (v: number | null): string => v == null ? '측정 없음' : v.toLocaleString();
    const fmt = (r: { label: string; n: number; ytMed: number | null; igMed: number | null }): string =>
      `- ${r.label}${r.n > 1 ? ` ×${r.n}편` : ''} (유튜브 ${num(r.ytMed)} · 인스타 ${num(r.igMed)})`;
    // 하위 슬라이스는 상위(0~4)와 겹치지 않게 — 계열 6~9개 구간에서 같은 계열이 상·하위 동시 등재되던 리뷰 지적.
    const bottom = agg.slice(Math.max(5, agg.length - 5));
    return `[쇼츠 채널 실측 — 이 주제들에서 파생된 숏폼의 조회수(발행 72시간 경과분, 계열 중앙값)]\n` +
      `잘 된 계열(상위):\n${agg.slice(0, 5).map(fmt).join('\n')}\n` +
      `부진 계열(하위):\n${bottom.reverse().map(fmt).join('\n')}\n` +
      `반영 지침: 파생 숏폼까지 잘 되는 글이 좋은 글이다 — 상위 계열의 소재·접근 방식(예: 구별법·원인 진단처럼 결과가 보이는 틀)은 인접 영역으로 확장하고, 하위 계열과 같은 틀의 반복은 줄여라. 소재 범위의 기준은 언제나 [브랜드 컨텍스트]다.\n\n`;
  } catch { return ''; }
}
