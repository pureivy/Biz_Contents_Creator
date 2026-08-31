/**
 * 유튜브 Data API v3 커넥터 — YOUTUBE_API_KEY 설정 시 활성.
 * 용도: 주제의 유튜브 SERP — 상위 영상 제목·채널·조회수·길이(경쟁 강도·차별화 각도·트렌드 신호).
 * 발급: Google Cloud Console → YouTube Data API v3 활성화 → API 키.
 * 쿼터: 무료 일 10,000유닛(search.list 100유닛 + videos.list 1유닛/회 — 리서치 용도로 충분).
 */
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { registerConnector } from './registry';
import { seedKeyword, stripTags, GROUND_CAP } from './naver_common';

const KEY = 'YOUTUBE_API_KEY';
export function youtubeEnabled(): boolean { return !!getSecret(KEY); }

export interface YtVideo {
  title: string;
  channel: string;
  publishedAt: string;   // YYYY-MM-DD
  views: number;
  durationMin: number;   // 분(반올림, 1분 미만은 1)
}

/** ISO8601 duration(PT1H2M3S) → 분. 파싱 실패·빈값은 0(표기 생략용). */
export function parseIsoDurationMin(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return sec ? Math.max(1, Math.round(sec / 60)) : 0;
}

/** 상위 영상 조회 — search.list(관련도순, 한국) + videos.list(조회수·길이) 2단 호출. 실패 시 []. */
export async function youtubeTop(keyword: string, signal?: AbortSignal): Promise<YtVideo[]> {
  const kw = keyword.trim();
  const key = getSecret(KEY);
  if (!kw || !key) return [];
  const sUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8'
    + `&regionCode=KR&relevanceLanguage=ko&q=${encodeURIComponent(kw)}&key=${encodeURIComponent(key)}`;
  const sr = await fetchTimeout(sUrl, {}, signal);
  if (!sr.ok) return [];
  const sj = await sr.json() as {
    items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string } }>;
  };
  const items = (sj.items ?? []).filter((it) => it.id?.videoId);
  if (!items.length) return [];

  // 통계·길이는 보조 신호 — videos.list 실패해도 제목·채널만으로 주입한다(fail-open).
  const stats = new Map<string, { views: number; durationMin: number }>();
  try {
    const ids = items.map((it) => it.id!.videoId!).join(',');
    const vr = await fetchTimeout(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids}&key=${encodeURIComponent(key)}`, {}, signal);
    if (vr.ok) {
      const vj = await vr.json() as {
        items?: Array<{ id?: string; statistics?: { viewCount?: string }; contentDetails?: { duration?: string } }>;
      };
      for (const v of vj.items ?? []) {
        if (!v.id) continue;
        stats.set(v.id, {
          views: Number(v.statistics?.viewCount ?? 0) || 0,
          durationMin: parseIsoDurationMin(v.contentDetails?.duration ?? ''),
        });
      }
    }
  } catch { /* 통계 없이 진행 */ }

  return items.map((it) => {
    const s = stats.get(it.id!.videoId!) ?? { views: 0, durationMin: 0 };
    return {
      title: stripTags(it.snippet?.title ?? ''),
      channel: it.snippet?.channelTitle ?? '',
      publishedAt: (it.snippet?.publishedAt ?? '').slice(0, 10),
      views: s.views,
      durationMin: s.durationMin,
    };
  });
}

/** 조회 결과 → 주입 블록 텍스트(네트워크와 분리해 단위 테스트 가능). 결과 없으면 ''. */
export function formatYtBlock(kw: string, vids: YtVideo[]): string {
  if (!vids.length) return '';
  const lines = vids.slice(0, 6).map((v) =>
    `· ${v.title} | ${v.channel}${v.views ? ` | 조회 ${v.views.toLocaleString('ko-KR')}` : ''}`
    + `${v.durationMin ? ` | ${v.durationMin}분` : ''}${v.publishedAt ? ` | ${v.publishedAt}` : ''}`);
  return `검색어 "${kw}" — 유튜브 상위 영상(관련도순, 제목·조회수는 경쟁 강도·차별화 각도 신호):\n${lines.join('\n')}`.slice(0, GROUND_CAP);
}

async function ground(query: string, signal?: AbortSignal): Promise<string> {
  if (!youtubeEnabled()) return '';
  const kw = seedKeyword(query);
  try {
    return formatYtBlock(kw, await youtubeTop(kw, signal));
  } catch { return ''; }
}

registerConnector({
  id: 'youtube',
  keyDef: {
    key: KEY,
    label: '유튜브 Data API v3',
    icon: '▶️',
    desc: 'Google Cloud Console 발급 API 키 — 주제 상위 영상·조회수 리서치(무료 쿼터 일 1만 유닛)',
    placeholder: 'AIza…',
  },
  blockLabel: '[유튜브 리서치]',
  scope: ['youtube'], // 리서치 팀(트렌드·SEO — youtube 툴 보유)에만 주입
  enabled: youtubeEnabled,
  ground,
});
