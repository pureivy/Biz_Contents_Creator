/**
 * 웹 검색 인-프로세스 툴 — DuckDuckGo HTML 엔드포인트(키 불필요)를 fetch·파싱.
 * 네이티브 의존성 없음(정규식 파싱). 실패는 무해([], fail-open).
 *
 * 파서(parseDdgHtml)는 네트워크와 분리해 단위 테스트 가능.
 */
import { anySignal } from '../util/abort';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** DDG 리다이렉트 href(//duckduckgo.com/l/?uddg=...)에서 실제 URL 추출. */
function resolveHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]!); } catch { /* fallthrough */ }
  }
  return href.startsWith('//') ? 'https:' + href : href;
}

/** DDG html 결과 페이지를 파싱해 결과 배열로. 네트워크 없이 테스트 가능. */
export function parseDdgHtml(html: string, limit = 5): WebResult[] {
  const out: WebResult[] = [];
  // 결과 링크 + (인접) 스니펫. result__a 가 제목/링크, result__snippet 가 요약.
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html)) !== null) snippets.push(stripTags(sm[1]!));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && out.length < limit) {
    const title = stripTags(lm[2]!);
    if (!title) { i++; continue; }
    out.push({ title, url: resolveHref(lm[1]!), snippet: snippets[i] ?? '' });
    i++;
  }
  return out;
}

export async function webSearch(query: string, limit = 5, signal?: AbortSignal): Promise<WebResult[]> {
  if (!query.trim()) return [];
  try {
    const timeout = AbortSignal.timeout(8000);
    const sig = signal ? anySignal([timeout, signal]) : timeout;
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' },
      signal: sig,
    });
    if (!r.ok) return [];
    return parseDdgHtml(await r.text(), limit);
  } catch {
    return [];
  }
}
