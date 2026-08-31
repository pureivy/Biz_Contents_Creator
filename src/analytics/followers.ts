/**
 * 팔로워 지표 추적 — 유튜브 구독자·인스타 팔로워·페북 페이지 팔로워를 하루 1회 스냅샷으로 적재
 * (data/followers/<slug>.json)하고, 일일 브리핑이 최신/직전 차이를 읽어 "어제 +N명"으로 보여준다
 * (1,000명 목표 가시화 — 사용자 요청 2026-07-29). 조회수(성과 루프)와 별개 축: 조회수는 콘텐츠
 * 단위, 팔로워는 채널 단위라 "어떤 콘텐츠가 구독을 만들었나"는 이 스냅샷과 발행 이력의 교차로 본다.
 *
 * 채널 미연결·API 실패는 해당 채널만 null(무해). 같은 날 재수집은 그 날 값을 갱신(멱등).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug } from '../content/brand';
import { getMetaAccount, getNaverAccount, getSecret } from '../secrets/store';
import { shortsStore } from '../content/shorts';
import { fetchYoutubeSubscribers } from '../tools/youtubeUpload';
import { GRAPH, FB_GRAPH } from '../tools/metaPublish';

export interface FollowerSnapshot {
  date: string; // KST YYYY-MM-DD
  /** 이 스냅샷을 마지막으로 수집한 시각(ISO) — 하루 안에 여러 번 갱신되므로 날짜만으론 신선도를 알 수 없다.
   *  값이 안 변하면 사용자는 '수집이 안 된 것'과 '수집했는데 실제로 안 변한 것'을 구분할 수 없다(신고 2026-08-02). */
  ts?: string;
  /** 네이버 블로그 이웃 수 — 공개 모바일 API(subscriberCount), 로그인·자동화 불요. */
  naver?: number | null;
  youtube: number | null;
  instagram: number | null;
  facebook: number | null;
}

const kstDate = (): string => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const fileFor = (slug: string): string => path.join(CONFIG.dataDir, 'followers', `${slug || 'default'}.json`);

export function readSnapshots(slug: string): FollowerSnapshot[] {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(slug), 'utf-8')) as FollowerSnapshot[];
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

/** 네이버 블로그 이웃 수 — 공개 모바일 API(비로그인 GET, 실측 2026-07-30: result.subscriberCount). */
async function fetchNaverNeighbors(blogId: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const r = await fetch(`https://m.blog.naver.com/api/blogs/${encodeURIComponent(blogId)}`, {
      headers: { Referer: `https://m.blog.naver.com/${encodeURIComponent(blogId)}` },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const j = await r.json() as { result?: { subscriberCount?: number } };
    const n = j.result?.subscriberCount;
    return typeof n === 'number' ? n : null;
  } catch { return null; }
}

async function fetchIgFollowers(token: string, signal?: AbortSignal): Promise<number | null> {
  try {
    // /me 경로 필수(실측 2026-07-29) — 저장된 igUserId 노드로는 프로필 필드 조회가 400(발행용 id 와 프로필 id 가 다름).
    const r = await fetch(`${GRAPH}/me?fields=followers_count&access_token=${encodeURIComponent(token)}`,
      { signal: signal ?? AbortSignal.timeout(15_000) });
    const j = await r.json() as { followers_count?: number };
    return typeof j.followers_count === 'number' ? j.followers_count : null;
  } catch { return null; }
}

// 유튜브 채널 id 캐시 — API 키 폴백 경로가 매번 videos.list 를 두드리지 않게(채널 id 는 불변).
const ytChannelCacheFile = (slug: string): string => path.join(CONFIG.dataDir, 'followers', `${slug || 'default'}.ytchannel`);

/** OAuth 스코프가 upload 뿐이라 mine=true 가 403 인 경우의 폴백 — 업로드된 영상 id 로 채널을 찾아
 *  공개 통계(API 키)로 구독자 수를 읽는다. 재동의(readonly 스코프) 없이 오늘 동작하는 경로. */
async function fetchYoutubeSubscribersViaApiKey(slug: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const key = (getSecret('YOUTUBE_API_KEY') ?? '').trim();
    if (!key) return null;
    const sg = signal ?? AbortSignal.timeout(15_000);
    let channelId = '';
    try { channelId = fs.readFileSync(ytChannelCacheFile(slug), 'utf-8').trim(); } catch { /* 아래에서 해석 */ }
    if (!channelId) {
      const vid = shortsStore().list().find((s) => (s.brand ?? '') === slug && s.youtubeId)?.youtubeId;
      if (!vid) return null;
      const vr = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(vid)}&key=${encodeURIComponent(key)}`, { signal: sg });
      const vj = await vr.json() as { items?: Array<{ snippet?: { channelId?: string } }> };
      channelId = vj.items?.[0]?.snippet?.channelId ?? '';
      if (!channelId) return null;
      try { fs.mkdirSync(path.dirname(ytChannelCacheFile(slug)), { recursive: true }); fs.writeFileSync(ytChannelCacheFile(slug), channelId, 'utf-8'); } catch { /* 캐시 실패 무해 */ }
    }
    const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(key)}`, { signal: sg });
    const j = await r.json() as { items?: Array<{ statistics?: { subscriberCount?: string } }> };
    const n = Number(j.items?.[0]?.statistics?.subscriberCount);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function fetchFbFollowers(pageId: string, token: string, signal?: AbortSignal): Promise<number | null> {
  try {
    // followers_count 우선, 구 필드 fan_count 폴백 — 페이지 노드 기본 필드라 별도 앱심사 불필요(실패 시 null).
    const r = await fetch(`${FB_GRAPH}/${pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(token)}`,
      { signal: signal ?? AbortSignal.timeout(15_000) });
    const j = await r.json() as { followers_count?: number; fan_count?: number };
    if (typeof j.followers_count === 'number') return j.followers_count;
    return typeof j.fan_count === 'number' ? j.fan_count : null;
  } catch { return null; }
}

/** 오늘 스냅샷 수집·적재 — 활성 브랜드 기준. 채널별 병렬, 실패 채널은 null. 반환=오늘 스냅샷. */
export async function recordFollowersSnapshot(signal?: AbortSignal): Promise<FollowerSnapshot> {
  const slug = activeBrandSlug() || '';
  const meta = getMetaAccount(slug);
  let naverBlogId = '';
  try { naverBlogId = getNaverAccount(slug).blogId; } catch { /* 계정 미설정 — 이웃 수 생략 */ }
  const [naver, youtube, instagram, facebook] = await Promise.all([
    naverBlogId ? fetchNaverNeighbors(naverBlogId, signal) : Promise.resolve(null),
    // OAuth(mine=true) 우선 — 스코프가 upload 뿐이면 403 → API 키 공개 통계 폴백(실측 2026-07-29).
    fetchYoutubeSubscribers(slug, signal).then((n) => n ?? fetchYoutubeSubscribersViaApiKey(slug, signal)),
    meta.pageAccessToken ? fetchIgFollowers(meta.pageAccessToken, signal) : Promise.resolve(null),
    meta.pageId && meta.pageToken ? fetchFbFollowers(meta.pageId, meta.pageToken, signal) : Promise.resolve(null),
  ]);
  const snap: FollowerSnapshot = { date: kstDate(), ts: new Date().toISOString(), naver, youtube, instagram, facebook };
  try {
    const file = fileFor(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rest = readSnapshots(slug).filter((s) => s.date !== snap.date);
    // 전 채널 null(전부 미연결/실패)이고 기존 기록이 있으면 그날 값을 null 로 덮지 않는다(일시 장애로 이력 훼손 방지).
    const todayExisting = readSnapshots(slug).find((s) => s.date === snap.date);
    const merged: FollowerSnapshot = todayExisting
      ? {
          date: snap.date,
          ts: snap.ts, // 병합해도 '방금 수집함'은 사실 — 값이 그대로여도 신선도는 갱신된다
          naver: snap.naver ?? todayExisting.naver ?? null,
          youtube: snap.youtube ?? todayExisting.youtube,
          instagram: snap.instagram ?? todayExisting.instagram,
          facebook: snap.facebook ?? todayExisting.facebook,
        }
      : snap;
    const all = [...rest, merged].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 원자적 교체
    return merged;
  } catch { return snap; } // 영속 실패 무해 — 다음 수집에서 재시도
}

// (후속 카드 넛지 followersFollowupNudge 는 2026-08-12 이행 완료로 제거 — analytics/titleTiming.ts 가 그 자리를 대체.)

/** 브리핑 섹션(동기 — 파일만 읽음) — 최신 스냅샷과 직전 스냅샷의 차이. 기록 없으면 null(섹션 생략). */
export function followersSection(): { heading: string; body: string } | null {
  const snaps = readSnapshots(activeBrandSlug() || '');
  if (!snaps.length) return null;
  const cur = snaps[snaps.length - 1]!;
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : undefined;
  const fmt = (label: string, now: number | null, old: number | null | undefined): string => {
    if (now == null) return `${label} 미연결`;
    const delta = old != null ? now - old : null;
    return `${label} ${now.toLocaleString()}명${delta != null ? ` (${delta >= 0 ? '+' : ''}${delta})` : ''}`;
  };
  return {
    heading: '📈 팔로워 (목표 1,000)',
    body: [
      fmt('네이버 이웃', cur.naver ?? null, prev?.naver),
      fmt('유튜브', cur.youtube, prev?.youtube),
      fmt('인스타', cur.instagram, prev?.instagram),
      fmt('페북', cur.facebook, prev?.facebook),
    ].join(' · '),
  };
}
