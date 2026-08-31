/**
 * 네이버 검색 API(블로그) 커넥터 — NAVER_CLIENT_ID + NAVER_CLIENT_SECRET 설정 시 활성.
 * 용도: 타겟 키워드의 블로그 SERP — 총 문서수(경쟁 지표) + 상위 노출 제목(차별화 각도).
 * 발급: https://developers.naver.com (검색 API).  헤더: X-Naver-Client-Id/Secret.
 */
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { CONFIG } from '../config';
import { registerConnector } from './registry';
import { seedKeyword, stripTags, GROUND_CAP } from './naver_common';

const CID = 'NAVER_CLIENT_ID';
const CSEC = 'NAVER_CLIENT_SECRET';
export function naverSearchEnabled(): boolean { return !!getSecret(CID) && !!getSecret(CSEC); }

export interface SerpResult {
  total: number;                 // 블로그 문서수(경쟁 지표)
  top: Array<{ title: string; blogger: string; postdate: string }>;
}

/** 블로그 SERP 조회 — discover 파이프라인·ground() 공용. 실패 시 total 0. */
export async function naverSerp(keyword: string, signal?: AbortSignal): Promise<SerpResult> {
  const kw = keyword.trim();
  if (!kw || !naverSearchEnabled()) return { total: 0, top: [] };
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(kw)}&display=10&sort=sim`;
  const r = await fetchTimeout(url, {
    headers: { 'X-Naver-Client-Id': getSecret(CID)!, 'X-Naver-Client-Secret': getSecret(CSEC)! },
  }, signal);
  if (!r.ok) return { total: 0, top: [] };
  const j = await r.json() as { total?: number; items?: Array<{ title?: string; bloggername?: string; postdate?: string }> };
  return {
    total: typeof j.total === 'number' ? j.total : 0,
    top: (j.items ?? []).map((it) => ({ title: stripTags(it.title ?? ''), blogger: it.bloggername ?? '', postdate: it.postdate ?? '' })),
  };
}

async function ground(query: string, signal?: AbortSignal): Promise<string> {
  if (!naverSearchEnabled()) return '';
  const kw = seedKeyword(query);
  try {
    const { total, top } = await naverSerp(kw, signal);
    if (!total && !top.length) return '';
    const titles = top.slice(0, 5).map((t) => `· ${t.title}${t.postdate ? ` (${t.postdate})` : ''}`).join('\n');
    return `검색어 "${kw}" — 블로그 문서수 약 ${total.toLocaleString()}건(경쟁 지표)\n상위 노출 제목:\n${titles}`.slice(0, GROUND_CAP);
  } catch { return ''; }
}

registerConnector({
  id: 'naver_search',
  keyDef: {
    key: CID,
    label: '네이버 API — Client ID',
    icon: '🟩',
    desc: '네이버 개발자센터 애플리케이션 ID — 검색(SERP)·데이터랩 공용. Client Secret 과 함께 설정',
    placeholder: '네이버 개발자 Client ID',
  },
  // 검색 API 는 ID+Secret 한 쌍 — 둘 다 카드로 노출(Secret 카드가 빠져 있던 갭 보완).
  keyDefs: [
    {
      key: CID,
      label: '네이버 API — Client ID',
      icon: '🟩',
      desc: '네이버 개발자센터 애플리케이션 ID — 검색(SERP)·데이터랩 공용. Client Secret 과 함께 설정',
      placeholder: '네이버 개발자 Client ID',
    },
    {
      key: CSEC,
      label: '네이버 API — Client Secret',
      icon: '🟩',
      desc: '네이버 개발자센터 애플리케이션 Secret — 검색(SERP)·데이터랩 공용',
      placeholder: '네이버 개발자 Client Secret',
    },
  ],
  blockLabel: '[네이버 블로그 SERP]',
  scope: ['naver_search'], // SEO/트렌드 역할(naver_search 툴 보유)에만 주입
  enabled: naverSearchEnabled,
  ground,
});
