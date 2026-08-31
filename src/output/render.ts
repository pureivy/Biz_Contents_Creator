/**
 * BlogDraft → 네이버 붙여넣기용 마크다운 / 미리보기·발행 참고용 HTML 문서.
 * 외부 의존 없이 최소 마크다운 서브셋만 변환(h2/h3·p·ul/ol·strong·blockquote·hr).
 * HTML 은 네이버 블로그 톤의 완성 문서(타이포·리드 박스·형광펜 강조·이미지 figure)로 렌더한다.
 */
import type { BlogDraft } from './formatter';

/**
 * 이모지·장식 픽토그램 제거 — 네이버 블로그 작성 지침(이모지 미사용). 한글·문장부호·숫자는 보존.
 * 변형 선택자(FE0E/FE0F)·ZWJ(200D)·키캡(20E3)·태그 문자까지 걷어 결합 이모지 잔재를 남기지 않는다.
 */
const EMOJI_RE = /[\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]|\p{Extended_Pictographic}/gu;
export function stripEmoji(s: string): string {
  return s
    .replace(EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')          // 이모지 자리 이중 공백 정리
    .replace(/(^#{1,6})\s+/gm, '$1 ');   // 소제목 마커 뒤 공백 1개로 정규화
}

/** 마크다운 — 제목 + 메타 + 본문 + 태그(+ 제목 후보 주석). [IMAGE:] 마커는 발행 시 삽입 위치 안내로 남긴다. */
export function renderMarkdown(d: BlogDraft): string {
  const parts = [
    `# ${d.titleCandidates[0] ?? d.topic}`,
    d.metaDescription ? `> ${d.metaDescription}` : '',
    d.bodyMarkdown.trim(),
    d.imageSlots.length ? `\n---\n**이미지 슬롯(발행 시 삽입):**\n${d.imageSlots.map((s, i) => `${i + 1}. ${s.alt} — _${s.prompt}_`).join('\n')}` : '',
    d.tags.length ? `**태그:** ${d.tags.map((t) => `#${t}`).join(' ')}` : '',
    d.titleCandidates.length > 1 ? `<!-- 제목 후보: ${d.titleCandidates.join(' / ')} -->` : '',
    `<!-- SEO 점수: ${d.seo.score}/100 · 핵심키워드: ${d.primaryKeyword} -->`,
  ].filter(Boolean);
  return parts.join('\n\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** 인라인 **강조** → <strong>. */
function inline(s: string): string {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 생성 이미지 figure — imagesReady 면 세션 images/blog-image-0N.png, 아니면 자리표시 박스. */
function figureHtml(idx: number, alt: string, imagesReady: boolean): string {
  if (imagesReady) {
    const n = String(idx + 1).padStart(2, '0');
    return `<figure class="img"><img src="images/blog-image-${n}.png" alt="${esc(alt)}"><figcaption>${esc(alt)}</figcaption></figure>`;
  }
  return `<figure class="img"><div class="ph">이미지 ${idx + 1} — ${esc(alt)}</div></figure>`;
}

// 네이버 블로그 톤 미리보기 스타일 — 본문 붙여넣기(MD)와 별개로, 검토자가 발행 모습을 가늠하는 용도.
// 과한 장식 없이: 리드 박스, 소제목 밑줄, 형광펜 강조(네이버 그린), 이미지 라운드, 태그 칩.
const PREVIEW_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 20px 72px; background: #fff; color: #222;
    font-family: Pretendard, "Pretendard Variable", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
    font-size: 16px; line-height: 1.9; word-break: keep-all; overflow-wrap: break-word; }
  article { max-width: 660px; margin: 0 auto; }
  h1 { font-size: 27px; line-height: 1.45; margin: 0 0 12px; letter-spacing: -0.5px; }
  .lead { margin: 22px 0 40px; padding: 18px 20px; background: #f7f8f9; border-radius: 10px;
    color: #555; font-size: 15px; line-height: 1.8; }
  h2 { font-size: 21px; line-height: 1.5; margin: 52px 0 18px; padding-bottom: 10px;
    border-bottom: 2px solid #222; letter-spacing: -0.4px; }
  h3 { font-size: 17.5px; margin: 34px 0 12px; }
  p { margin: 0 0 16px; }
  ul, ol { margin: 0 0 18px; padding-left: 24px; }
  li { margin: 6px 0; }
  strong { font-weight: 700; box-shadow: inset 0 -10px 0 rgba(3, 199, 90, 0.15); }
  blockquote { margin: 24px 0; padding: 14px 18px; border-left: 3px solid #03c75a;
    background: #f6faf7; color: #444; border-radius: 0 8px 8px 0; }
  blockquote p { margin: 0; }
  hr { border: 0; height: 1px; background: #e8e8e8; margin: 44px auto; width: 60%; }
  figure.img { margin: 30px 0; }
  figure.img img { display: block; width: 100%; border-radius: 10px; }
  figure.img figcaption { margin-top: 8px; text-align: center; font-size: 13px; color: #999; }
  figure.img .ph { padding: 46px 16px; text-align: center; background: #f4f5f6;
    border: 1px dashed #ccc; border-radius: 10px; color: #888; font-size: 14px; }
  .tags { margin-top: 48px; padding-top: 20px; border-top: 1px solid #eee;
    display: flex; flex-wrap: wrap; gap: 8px; }
  .tags span { padding: 5px 12px; background: #f2f3f5; border-radius: 999px; font-size: 13px; color: #555; }
`;

/**
 * 최소 마크다운 → 완성 HTML 문서. 지원: ## h2, ### h3, - / 1. 리스트, > 인용, ---, 문단, **강조**.
 * 이미지: 본문 [IMAGE: 설명] 마커 위치에 슬롯 순서대로 figure 삽입(마커가 없으면 소제목(H2) 아래에 배분).
 * 남는 슬롯은 본문 끝에 이어붙인다. imagesReady=true 면 세션 상대경로 <img>(images/blog-image-0N.png),
 * 아니면 자리표시 박스 — 미리보기는 서버가 <base href="/pieces/:id/"> 를 주입해 이미지를 서빙한다.
 */
export function renderHtml(d: BlogDraft, opts?: { imagesReady?: boolean }): string {
  const imagesReady = opts?.imagesReady ?? false;
  const slots = d.imageSlots;
  const body = d.bodyMarkdown;
  const hasMarkers = /^\s*\[IMAGE:[^\]]*\]\s*$/m.test(body);
  let slotIdx = 0;
  let h2Count = 0;

  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushAll(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*\[IMAGE:([^\]]*)\]\s*$/))) {
      flushAll();
      const desc = (m[1] ?? '').trim();
      const slot = slots[slotIdx];
      out.push(figureHtml(slotIdx, slot?.alt || desc || '삽입 이미지', imagesReady && !!slot));
      slotIdx++;
    } else if ((m = line.match(/^###\s+(.*)$/))) { flushAll(); out.push(`<h3>${inline(m[1]!)}</h3>`); }
    else if ((m = line.match(/^##\s+(.*)$/)) || (m = line.match(/^#\s+(.*)$/))) {
      flushAll(); h2Count++;
      out.push(`<h2>${inline(m[1]!)}</h2>`);
      // 마커 없는 본문 — 첫 H2들 바로 아래에 슬롯 배분(네이버 관행: 소제목 밑 사진).
      if (!hasMarkers && slotIdx < slots.length && h2Count <= slots.length) {
        out.push(figureHtml(slotIdx, slots[slotIdx]!.alt, imagesReady));
        slotIdx++;
      }
    } else if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); }
    else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]!); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); flushQuote(); if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${inline(m[1]!)}</li>`); }
    else if ((m = line.match(/^\s*[-*·]\s+(.*)$/))) { flushPara(); flushQuote(); if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${inline(m[1]!)}</li>`); }
    else { flushList(); flushQuote(); para.push(line.trim().replace(/\[IMAGE:[^\]]*\]/g, '').trim()); }
  }
  flushAll();
  // 마커보다 슬롯이 많으면(디자이너가 3장 확정, 마커 2개 등) 남은 이미지를 본문 끝에.
  while (slotIdx < slots.length) { out.push(figureHtml(slotIdx, slots[slotIdx]!.alt, imagesReady)); slotIdx++; }

  const title = d.titleCandidates[0] ?? d.topic;
  const article = [
    `<h1>${inline(title)}</h1>`,
    d.metaDescription ? `<div class="lead">${inline(d.metaDescription)}</div>` : '',
    ...out,
    d.tags.length ? `<div class="tags">${d.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : '',
  ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PREVIEW_CSS}</style>
</head>
<body>
<article>
${article}
</article>
</body>
</html>`;
}
