import { describe, it, expect } from 'vitest';
import { parseDdgHtml } from './web_search';

const SAMPLE = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Follama.com%2Fdocs&rut=abc">Ollama <b>문서</b></a>
  <a class="result__snippet" href="x">로컬에서 LLM을 돌리는 도구. <b>gemma</b> 등 지원.</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://direct.example.com/page">Direct Link Title</a>
  <a class="result__snippet" href="x">두 번째 결과 스니펫 &amp; 인용.</a>
</div>
`;

describe('parseDdgHtml', () => {
  it('제목·URL·스니펫을 추출한다', () => {
    const r = parseDdgHtml(SAMPLE);
    expect(r).toHaveLength(2);
    expect(r[0]!.title).toBe('Ollama 문서');           // 태그 제거
    expect(r[0]!.url).toBe('https://ollama.com/docs');  // uddg 디코딩
    expect(r[0]!.snippet).toContain('로컬에서 LLM');
  });
  it('직접 href·HTML 엔티티 처리', () => {
    const r = parseDdgHtml(SAMPLE);
    expect(r[1]!.url).toBe('https://direct.example.com/page');
    expect(r[1]!.snippet).toContain('&');               // &amp; → &
  });
  it('limit 적용', () => {
    expect(parseDdgHtml(SAMPLE, 1)).toHaveLength(1);
  });
  it('빈/무관 HTML → []', () => {
    expect(parseDdgHtml('<html>nothing</html>')).toEqual([]);
  });
});
