/**
 * 네이버 블로그 공감 수 — 공감 위젯이 쓰는 공개 like API(비로그인 GET, 실측 2026-07-31).
 * 브라우저·로그인 불필요(성과 수집의 조회수 경로와 독립) — 일일 추적 measurePiece 가 표본에 likes 로 동봉.
 * 전량 fail-open(null) — 공감 조회 실패가 조회수 수집을 막지 않는다.
 */

/** 발행 URL → { blogId, logNo }. blog.naver.com/<id>/<logNo> 및 PostView·m.blog 형태 지원(순수). */
export function parseBlogIdLogNo(url: string): { blogId: string; logNo: string } | null {
  const q = /[?&]blogId=([^&]+)[^#]*[?&]logNo=(\d+)/.exec(url);
  if (q?.[1] && q[2]) return { blogId: q[1], logNo: q[2] };
  const p = /blog\.naver\.com\/([^/?#]+)\/(\d+)/.exec(url);
  if (p?.[1] && p[2]) return { blogId: p[1], logNo: p[2] };
  return null;
}

/** like API 응답 → 공감 총합(순수) — reactions[].count 합(감사·웃김·공감·슬픔·칭찬·놀람 전 리액션).
 *  블로그 UI 의 공감 수 = 리액션 총합. 응답이 오면 빈 reactions 는 실값 0, 이형은 null. */
export function sumReactions(json: unknown): number | null {
  const c = (json as { contents?: Array<{ reactions?: Array<{ count?: unknown }> }> } | null)?.contents?.[0];
  if (!c) return null;
  const list = Array.isArray(c.reactions) ? c.reactions : [];
  return list.reduce((n, r) => n + (typeof r?.count === 'number' && Number.isFinite(r.count) ? r.count : 0), 0);
}

/** 발행 글의 공감 수 조회 — 실패·이형은 null(fail-open). */
export async function fetchBlogSympathy(publishedUrl: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const ids = parseBlogIdLogNo(publishedUrl);
    if (!ids) return null;
    const q = encodeURIComponent(`BLOG[${ids.blogId}_${ids.logNo}]`);
    const r = await fetch(`https://common.like.naver.com/v1/search/contents?suppressResponseCodes=true&q=${q}`, {
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    return sumReactions(await r.json());
  } catch { return null; }
}
