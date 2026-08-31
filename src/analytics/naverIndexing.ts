/**
 * 네이버 블로그 색인 자동 점검(사용자 요청 2026-07-23) — 발행 글이 네이버 블로그 검색(Open API)에서
 * 자기 postId 로 뜨는지 확인한다. NAVER_CLIENT_ID/SECRET(검색·데이터랩 공용) 설정 시 활성.
 *
 * 해석 주의(중요):
 * - **없음 = 강한 음성 신호**(발행 후 충분히 지난 글이 자기 정확검색에도 안 뜨면 저품질 의심).
 * - **있음 = 약한 양성**일 뿐 "정상"이 아니다. openapi.naver 블로그 검색은 사용자 통합검색 색인보다
 *   관대해서, 저품질 글도 여기엔 뜰 수 있다. 그래서 문구는 "블로그 검색결과에 있음/없음"으로만.
 * - 발행 직후 글은 색인 전이라 '없음'을 저품질로 보면 안 된다 → GRACE_DAYS 이후에만 음성 판정.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { pieceStore } from '../content/pieces';
import { activeBrandSlug } from '../content/brand';

const CID = 'NAVER_CLIENT_ID';
const CSEC = 'NAVER_CLIENT_SECRET';
export const GRACE_DAYS = 7; // 발행 후 이만큼 지나야 '없음'을 저품질 신호로 본다(그 전엔 색인 대기).
export function naverIndexingEnabled(): boolean { return !!getSecret(CID) && !!getSecret(CSEC); }

/** 네이버 블로그 글 URL → { blogId, postId }. 두 형식 지원: /blogId/postId, PostView.naver?blogId=&logNo=. 순수. */
export function naverBlogRef(url: string): { blogId: string; postId: string } {
  const clean = /blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)/.exec(url || '');
  if (clean) return { blogId: clean[1]!, postId: clean[2]! };
  return {
    blogId: /[?&]blogId=([^&]+)/.exec(url || '')?.[1] ?? '',
    postId: /[?&]logNo=(\d+)/.exec(url || '')?.[1] ?? '',
  };
}

/** 블로그 검색에 이 postId 가 있는지(있음=true). API 실패는 throw(호출부가 '점검불가'로 구분). */
async function searchHasPost(title: string, postId: string, signal?: AbortSignal): Promise<boolean> {
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(title)}&display=30&sort=sim`;
  const r = await fetchTimeout(url, {
    headers: { 'X-Naver-Client-Id': getSecret(CID)!, 'X-Naver-Client-Secret': getSecret(CSEC)! },
  }, signal);
  if (!r.ok) throw new Error(`naver search ${r.status}`);
  const j = await r.json() as { items?: Array<{ link?: string }> };
  return (j.items ?? []).some((it) => !!postId && (it.link || '').includes(postId));
}

export interface IndexStatus { title: string; ageDays: number; found: boolean; checkable: boolean }
export interface IndexReport { ts: string; brand: string; results: IndexStatus[] }

/** 활성 브랜드 발행 블로그 글의 색인 상태(라이브 API). 자격증명 없으면 빈 배열. */
export async function checkNaverIndexing(now = Date.now(), signal?: AbortSignal): Promise<IndexStatus[]> {
  if (!naverIndexingEnabled()) return [];
  const brand = activeBrandSlug() || '';
  const out: IndexStatus[] = [];
  for (const p of pieceStore().list()) {
    if ((p.brand ?? '') !== brand || !p.publishedUrl) continue;
    const { postId } = naverBlogRef(p.publishedUrl);
    if (!postId) continue;
    const ageDays = Math.floor((now - new Date(p.updatedTs).getTime()) / 86_400_000);
    let found = false, checkable = true;
    try { found = await searchHasPost(p.title, postId, signal); } catch { checkable = false; }
    out.push({ title: p.title, ageDays: Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0, found, checkable });
  }
  return out;
}

const cacheFile = (): string => path.join(CONFIG.dataDir, '_shared', 'naver-indexing.json');
/** 점검 후 결과를 캐시 파일에 기록(브리핑이 동기로 읽는다). API 부하 낮음(글 수만큼 검색 1회). */
export async function refreshNaverIndexingCache(now = Date.now(), signal?: AbortSignal): Promise<IndexReport | null> {
  if (!naverIndexingEnabled()) return null;
  const results = await checkNaverIndexing(now, signal);
  const report: IndexReport = { ts: new Date(now).toISOString(), brand: activeBrandSlug() || '', results };
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(report)); } catch { /* 영속 실패 무해 */ }
  return report;
}
/** 캐시된 색인 리포트(동기) — 브리핑용. 없으면 null. */
export function readNaverIndexingReport(): IndexReport | null {
  try { const r = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8')) as IndexReport; return Array.isArray(r.results) ? r : null; } catch { return null; }
}
