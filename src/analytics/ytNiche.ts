/**
 * 유튜브 니치 동향 축(2026-08-25 사용자 지시 "유튜브/인스타 트렌드 수집 축 추가") — 시드 키워드별
 * '최근 7일 조회 상위' 영상을 매일 수집해 주제 두뇌에 주입한다. 자동완성이 '검색 수요'라면 이 축은
 * '지금 실제로 반응이 터지는 소재·프레이밍'이다(추천 피드 쪽 신호의 실용 대체).
 * 인스타 축은 불가 실측(2026-08-25: 인스타그램 로그인 API 는 ig_hashtag_search 미지원) — 릴스는
 * 자체 성과 되먹임(shortsTopicSignalBlock)으로 갈음한다.
 *
 * 쿼터: search.list 100단위 × 시드 ≤6 + videos.list 1 ≈ 하루 ~601/10,000 — 성과 수집과 병행해도 여유.
 * 전량 fail-open — 키 없음·쿼터 초과·실패는 무주입일 뿐이다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug, brandFileSuffixFor } from '../content/brand';
import { discoverySeeds } from './discoverySeeds';
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';

export interface YtNicheVideo { title: string; views: number }
export interface YtNicheSnap { date: string; entries: Array<{ seed: string; videos: YtNicheVideo[] }> }

const MAX_SEEDS = 6;
const MAX_VIDEOS = 4;
const STALE_DAYS = 7;

function snapPath(slug?: string): string {
  const s = slug ?? activeBrandSlug();
  return path.join(CONFIG.dataDir, 'topics', `yt-niche${brandFileSuffixFor(s || undefined)}.json`);
}

export function readYtNicheSnap(slug?: string): YtNicheSnap | null {
  try {
    const raw = JSON.parse(fs.readFileSync(snapPath(slug), 'utf-8')) as YtNicheSnap;
    return raw && typeof raw.date === 'string' && Array.isArray(raw.entries) ? raw : null;
  } catch { return null; }
}

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** search.list 응답 → {videoId, title} 목록(순수, 테스트 대상). */
export function parseYtSearch(json: unknown): Array<{ videoId: string; title: string }> {
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const o = it as { id?: { videoId?: unknown }; snippet?: { title?: unknown } };
    return { videoId: String(o?.id?.videoId ?? ''), title: String(o?.snippet?.title ?? '').trim() };
  }).filter((v) => v.videoId && v.title);
}

/** 일일 수집 — perf-sync 틱에서 fire-and-forget. 같은 날 재호출 no-op. */
export async function refreshYtNicheSnapshot(signal?: AbortSignal): Promise<void> {
  try {
    const key = getSecret('YOUTUBE_API_KEY');
    if (!key) return;
    const slug = activeBrandSlug();
    const seeds = discoverySeeds(MAX_SEEDS);   // 카탈로그 회전(2026-08-27) — 안 다룬 수종의 유튜브 동향
    if (!seeds.length) return;
    const today = localDateStr();
    if (readYtNicheSnap(slug)?.date === today) return;
    const after = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const entries: Array<{ seed: string; videos: YtNicheVideo[] }> = [];
    const idTitle = new Map<string, { seed: string; title: string }>();
    for (const seed of seeds) {
      try {
        const u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount' +
          `&publishedAfter=${encodeURIComponent(after)}&regionCode=KR&relevanceLanguage=ko&maxResults=${MAX_VIDEOS}` +
          `&q=${encodeURIComponent(seed)}&key=${encodeURIComponent(key)}`;
        const r = await fetchTimeout(u, {}, signal);
        if (!r.ok) throw new Error(`search.list HTTP ${r.status}`);
        for (const v of parseYtSearch(await r.json())) if (!idTitle.has(v.videoId)) idTitle.set(v.videoId, { seed, title: v.title });
      } catch { /* 시드별 fail-open — 쿼터 초과 등 */ }
    }
    if (!idTitle.size) return;
    // 조회수는 videos.list 일괄 1콜(1단위) — search 스니펫엔 통계가 없다.
    const stats = new Map<string, number>();
    try {
      const ids = [...idTitle.keys()].join(',');
      const r = await fetchTimeout(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${encodeURIComponent(key)}`, {}, signal);
      if (r.ok) {
        const j = await r.json() as { items?: Array<{ id?: unknown; statistics?: { viewCount?: unknown } }> };
        for (const it of j.items ?? []) {
          const n = Number(it?.statistics?.viewCount);
          if (typeof it?.id === 'string' && Number.isFinite(n)) stats.set(it.id, n);
        }
      }
    } catch { /* 통계 없이도 제목만으로 유효 */ }
    for (const seed of seeds) {
      const vids = [...idTitle.entries()]
        .filter(([, v]) => v.seed === seed)
        .map(([id, v]) => ({ title: v.title.slice(0, 60), views: stats.get(id) ?? 0 }))
        .sort((a, b) => b.views - a.views);
      if (vids.length) entries.push({ seed, videos: vids });
    }
    if (!entries.length) return;
    const f = snapPath(slug);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ date: today, entries } satisfies YtNicheSnap, null, 2), 'utf-8');
    fs.renameSync(`${f}.tmp`, f);
    console.log(`[trend] 유튜브 니치 동향 갱신 — 시드 ${entries.length}개·영상 ${idTitle.size}편(${today})`);
  } catch (e) {
    console.log(`[trend] 유튜브 니치 갱신 실패(무해): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 블록 조립(순수, 테스트 대상). excludeStems: 계열 쿨다운 — 그 계열 시드는 목록에서 뺀다. */
export function buildYtNicheBlock(snap: YtNicheSnap | null, now = Date.now(), excludeStems: string[] = []): string {
  if (!snap) return '';
  const age = now - new Date(`${snap.date}T00:00:00`).getTime();
  if (!Number.isFinite(age) || age > STALE_DAYS * 86_400_000) return '';
  const isCooled = (kw: string): boolean => excludeStems.some((s) => kw.replace(/\s+/g, '').includes(s));
  const fmtViews = (n: number): string => n >= 10_000 ? `${(n / 10_000).toFixed(1)}만` : String(n);
  const lines = snap.entries
    .filter((e) => e.videos.length && !isCooled(e.seed))
    .map((e) => `- ${e.seed}: ${e.videos.slice(0, 3).map((v) => `"${v.title}"(${fmtViews(v.views)}회)`).join(' · ')}`);
  if (!lines.length) return '';
  return `[유튜브 니치 동향 — 최근 7일 조회 상위 영상(${snap.date} 수집)]\n` +
    `${lines.join('\n')}\n` +
    '반영 지침: 유튜브에서 지금 반응이 터지는 소재·프레이밍의 실측이다 — 어떤 각도(가격 공개·현장·비교 등)가 통하는지 참고해 주제·파생 쇼츠 훅에 반영하라. 제목을 그대로 베끼지는 마라.\n\n';
}

/** 주제 두뇌 주입용 블록 — 스냅샷 없음·낡음은 빈 문자열(무주입). */
export function ytNicheBlock(slug?: string, excludeStems: string[] = []): string {
  try { return buildYtNicheBlock(readYtNicheSnap(slug), Date.now(), excludeStems); } catch { return ''; }
}
