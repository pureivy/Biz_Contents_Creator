import { describe, it, expect } from 'vitest';
import { renderHtml, renderMarkdown, stripEmoji } from './render';
import type { BlogDraft } from './formatter';

// 네이버 블로그 렌더 — 이모지 제거·완성 HTML 문서·[IMAGE:] 마커 위치 이미지 삽입이 결정적으로 동작해야 한다.

const base = {
  topic: '장마철 제습', primaryKeyword: '장마철 제습', titleCandidates: ['장마철 제습 방법 5가지'],
  metaDescription: '장마철 집안 습도를 낮추는 실전 방법.', tags: ['장마철', '제습'],
  imageSlots: [] as Array<{ alt: string; prompt: string }>, internalLinks: [],
  bodyMarkdown: '', seo: { score: 80, checklist: [] },
} as unknown as BlogDraft;

describe('stripEmoji — 이모지·장식 픽토그램 제거(한글 보존)', () => {
  it('소제목·본문의 이모지를 걷어내고 공백을 정리한다', () => {
    expect(stripEmoji('## ❄️ 냉동실을 이용한 방법')).toBe('## 냉동실을 이용한 방법');
    expect(stripEmoji('완벽 정리 ✅ 지금 시작 🚀!')).toBe('완벽 정리 지금 시작 !');
  });
  it('결합 이모지(ZWJ)·변형 선택자 잔재까지 제거', () => {
    expect(stripEmoji('가족 👨‍👩‍👧‍👦 나들이')).toBe('가족 나들이');
  });
  it('한글·숫자·문장부호는 보존', () => {
    const s = '1,500~4,000자(정보) — "그대로"?';
    expect(stripEmoji(s)).toBe(s);
  });
});

describe('renderHtml — 완성 문서 + 이미지 삽입', () => {
  it('완성 HTML 문서(스타일 포함)를 만든다 — 제목·리드·소제목·태그 칩', () => {
    const html = renderHtml({ ...base, bodyMarkdown: '도입 문단.\n\n## 첫 소제목\n내용 **강조**.' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<style>');
    expect(html).toContain('<h1>장마철 제습 방법 5가지</h1>');
    expect(html).toContain('<div class="lead">');
    expect(html).toContain('<h2>첫 소제목</h2>');
    expect(html).toContain('<strong>강조</strong>');
    expect(html).toContain('<span>#장마철</span>');
  });
  it('[IMAGE:] 마커 위치에 슬롯 순서대로 <img>(imagesReady) 삽입 + 캡션', () => {
    const d = {
      ...base,
      imageSlots: [{ alt: '창가 제습', prompt: 'p1' }, { alt: '숯 바구니', prompt: 'p2' }],
      bodyMarkdown: '## 하나\n[IMAGE: 창가 사진]\n본문.\n\n## 둘\n[IMAGE: 숯 사진]\n본문2.',
    };
    const html = renderHtml(d, { imagesReady: true });
    expect(html).toContain('src="images/blog-image-01.png"');
    expect(html).toContain('src="images/blog-image-02.png"');
    expect(html).toContain('<figcaption>창가 제습</figcaption>');
    expect(html.indexOf('<h2>하나</h2>')).toBeLessThan(html.indexOf('blog-image-01'));
    expect(html.indexOf('blog-image-01')).toBeLessThan(html.indexOf('<h2>둘</h2>'));
    expect(html).not.toContain('[IMAGE:');
  });
  it('imagesReady=false 면 자리표시 박스(깨진 이미지 없음)', () => {
    const d = { ...base, imageSlots: [{ alt: '창가 제습', prompt: 'p' }], bodyMarkdown: '## 하나\n[IMAGE: 창가]\n본문.' };
    const html = renderHtml(d);
    expect(html).not.toContain('<img');
    expect(html).toContain('이미지 1 — 창가 제습');
  });
  it('마커가 없으면 첫 H2들 아래에 슬롯을 배분한다', () => {
    const d = {
      ...base,
      imageSlots: [{ alt: 'a', prompt: 'p' }, { alt: 'b', prompt: 'p' }],
      bodyMarkdown: '## 하나\n본문.\n\n## 둘\n본문2.\n\n## 셋\n본문3.',
    };
    const html = renderHtml(d, { imagesReady: true });
    const iOne = html.indexOf('<h2>하나</h2>'), iImg1 = html.indexOf('blog-image-01');
    const iTwo = html.indexOf('<h2>둘</h2>'), iImg2 = html.indexOf('blog-image-02');
    const iThree = html.indexOf('<h2>셋</h2>');
    expect(iOne).toBeLessThan(iImg1); expect(iImg1).toBeLessThan(iTwo);
    expect(iTwo).toBeLessThan(iImg2); expect(iImg2).toBeLessThan(iThree);
  });
  it('마커보다 슬롯이 많으면 남는 이미지를 본문 끝에 붙인다', () => {
    const d = {
      ...base,
      imageSlots: [{ alt: 'a', prompt: 'p' }, { alt: 'b', prompt: 'p' }],
      bodyMarkdown: '## 하나\n[IMAGE: 하나]\n본문.',
    };
    const html = renderHtml(d, { imagesReady: true });
    expect(html).toContain('blog-image-01');
    expect(html).toContain('blog-image-02');
  });
  it('인용(>)·구분선(---) 지원', () => {
    const html = renderHtml({ ...base, bodyMarkdown: '> 핵심 요약.\n\n---\n\n## 끝\n마무리.' });
    expect(html).toContain('<blockquote><p>핵심 요약.</p></blockquote>');
    expect(html).toContain('<hr>');
  });
});

describe('renderMarkdown — 발행용 MD', () => {
  it('이미지 슬롯 안내(이모지 없음)와 태그를 포함한다', () => {
    const md = renderMarkdown({ ...base, imageSlots: [{ alt: 'a', prompt: 'p' }], bodyMarkdown: '## 하나\n본문.' });
    expect(md).toContain('이미지 슬롯(발행 시 삽입)');
    expect(md).not.toContain('🖼');
    expect(md).toContain('**태그:** #장마철 #제습');
  });
});

// 실사고(2026-08-31): imagesReady 는 '이미지를 생성할 예정인 런인가'라는 **예측**이라(org.ts, 생성 전에
// 계산) 생성이 실패해도 true 였다. .env 의 BLOG_PYTHON 이 삭제된 경로를 가리켜 openai_image.py 가 아예
// 안 돌았는데 draft.html 은 <img src="images/blog-image-01.png"> 를 그대로 뱉었고, 검토탭 미리보기가
// 깨진 이미지로 떴다(사용자 제보: "블로그 글에 이미지가 깨어져 있어").
// 부분 실패도 같은 문제다 — 3장 중 2장만 나와도 한 장은 깨진다. 그래서 슬롯 단위로 실재를 반영한다.
describe('renderHtml — readySlots(실재 파일 기준 슬롯별 판정)', () => {
  const d = {
    ...base,
    imageSlots: [{ alt: '창가 제습', prompt: 'p1' }, { alt: '숯 바구니', prompt: 'p2' }, { alt: '제습기', prompt: 'p3' }],
    bodyMarkdown: '## 하나\n[IMAGE: a]\n본문.\n\n## 둘\n[IMAGE: b]\n본문2.\n\n## 셋\n[IMAGE: c]\n본문3.',
  };

  it('한 장도 못 만들었으면 <img> 없이 전부 자리표시 박스', () => {
    const html = renderHtml(d, { imagesReady: true, readySlots: new Set<number>() });
    expect(html).not.toContain('<img');
    expect(html).toContain('이미지 1 — 창가 제습');
    expect(html).toContain('이미지 3 — 제습기');
  });

  it('부분 성공(1·3번만 생성)이면 그 둘만 <img>, 2번은 자리표시', () => {
    const html = renderHtml(d, { imagesReady: true, readySlots: new Set([0, 2]) });
    expect(html).toContain('src="images/blog-image-01.png"');
    expect(html).not.toContain('src="images/blog-image-02.png"');
    expect(html).toContain('src="images/blog-image-03.png"');
    expect(html).toContain('이미지 2 — 숯 바구니');
  });

  it('전부 생성됐으면 종전과 같이 3장 모두 <img>', () => {
    const html = renderHtml(d, { imagesReady: true, readySlots: new Set([0, 1, 2]) });
    for (const n of ['01', '02', '03']) expect(html).toContain(`src="images/blog-image-${n}.png"`);
    expect(html).not.toContain('class="ph"');
  });

  it('readySlots 미지정이면 종전 imagesReady 동작 그대로(하위 호환)', () => {
    expect(renderHtml(d, { imagesReady: true })).toContain('src="images/blog-image-02.png"');
    expect(renderHtml(d, { imagesReady: false })).not.toContain('<img');
  });
});
