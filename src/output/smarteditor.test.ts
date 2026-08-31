import { describe, it, expect } from 'vitest';
import { draftToFinalContent, coerceBlogDraft } from './smarteditor';
import type { BlogDraft } from './formatter';

function mkDraft(over: Partial<BlogDraft> = {}): BlogDraft {
  return {
    topic: '주제',
    primaryKeyword: '키워드',
    titleCandidates: ['제목 A', '제목 B'],
    metaDescription: '메타',
    tags: ['태그1', '태그2'],
    imageSlots: [],
    internalLinks: [],
    bodyMarkdown: '',
    seo: { score: 0, checklist: [] },
    ...over,
  };
}

describe('draftToFinalContent — 기본 구조', () => {
  it('제목은 titleCandidates[0], 없으면 topic', () => {
    const r = draftToFinalContent(mkDraft({ bodyMarkdown: '본문' }));
    expect(r.final_title).toBe('제목 A');
    expect(r.smarteditor_text.title).toBe('제목 A');
    expect(draftToFinalContent(mkDraft({ titleCandidates: [], bodyMarkdown: '본문' })).final_title).toBe('주제');
  });

  it('리드 문단 → 무제목 섹션, H2 → 제목 섹션(HEADING1 기본=레벨 필드 생략)', () => {
    const r = draftToFinalContent(mkDraft({
      bodyMarkdown: '리드 문단입니다.\n\n## 첫 소제목\n\n본문 한 줄.\n본문 두 줄.',
    }));
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '', body: '리드 문단입니다.' },
      { heading: '첫 소제목', body: '본문 한 줄.\n본문 두 줄.' },
    ]);
    expect(r.smarteditor_text.image_positions).toEqual([]);
    expect(r.tags).toEqual(['태그1', '태그2']);
  });

  it('### 은 heading_level=HEADING2 로 구분', () => {
    const r = draftToFinalContent(mkDraft({ bodyMarkdown: '## 큰 제목\n내용\n### 작은 제목\n디테일' }));
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '큰 제목', body: '내용' },
      { heading: '작은 제목', heading_level: 'HEADING2', body: '디테일' },
    ]);
  });

  it('본문은 굵게(**)·인용(>)·구분선(---) 등 리치 마크다운을 원문 그대로 보존', () => {
    const r = draftToFinalContent(mkDraft({
      bodyMarkdown: '이건 **아주** 중요.\n- 항목 하나\n1. 순서 항목\n---\n> 인용문입니다.',
    }));
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '', body: '이건 **아주** 중요.\n- 항목 하나\n1. 순서 항목\n---\n> 인용문입니다.' },
    ]);
  });

  it('제목의 굵게 마커는 제거(제목은 이미 굵은 큰 글씨)', () => {
    const r = draftToFinalContent(mkDraft({ bodyMarkdown: '## **핵심** 정리\n본문 **강조** 줄' }));
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '핵심 정리', body: '본문 **강조** 줄' },
    ]);
  });
});

describe('draftToFinalContent — 이미지 배치(렌더러 미러)', () => {
  const slots = [
    { alt: '이미지1', prompt: 'p1' },
    { alt: '이미지2', prompt: 'p2' },
    { alt: '이미지3', prompt: 'p3' },
  ];

  it('[IMAGE:] 마커 위치에서 섹션을 쪼개고 그 뒤에 삽입', () => {
    const r = draftToFinalContent(mkDraft({
      imageSlots: slots.slice(0, 2),
      bodyMarkdown: '리드.\n\n## 소제목\n앞 문단.\n[IMAGE: 장면 하나]\n뒷 문단.\n[IMAGE: 장면 둘]',
    }));
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '', body: '리드.' },
      { heading: '소제목', body: '앞 문단.' },
      { heading: '', body: '뒷 문단.' },
    ]);
    // 이미지1 은 '앞 문단' 섹션(인덱스1) 뒤, 이미지2 는 '뒷 문단' 섹션(인덱스2) 뒤.
    expect(r.smarteditor_text.image_positions).toEqual([
      { after_section: 1, image_index: 0 },
      { after_section: 2, image_index: 1 },
    ]);
  });

  it('마커 없으면 첫 H2들 바로 아래 배분 — 제목만 있는 섹션 뒤에 이미지', () => {
    const r = draftToFinalContent(mkDraft({
      imageSlots: slots.slice(0, 2),
      bodyMarkdown: '리드.\n## 하나\n내용1\n## 둘\n내용2\n## 셋\n내용3',
    }));
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '', body: '리드.' },
      { heading: '하나', body: '' },   // 제목만 확정 → 이미지가 소제목 바로 아래
      { heading: '', body: '내용1' },
      { heading: '둘', body: '' },
      { heading: '', body: '내용2' },
      { heading: '셋', body: '내용3' }, // 슬롯 소진 — 통짜 섹션
    ]);
    expect(r.smarteditor_text.image_positions).toEqual([
      { after_section: 1, image_index: 0 },
      { after_section: 3, image_index: 1 },
    ]);
  });

  it('마커보다 슬롯이 많으면 남는 이미지는 본문 끝에', () => {
    const r = draftToFinalContent(mkDraft({
      imageSlots: slots,
      bodyMarkdown: '## 하나\n내용\n[IMAGE: 한 장]',
    }));
    expect(r.smarteditor_text.sections).toEqual([{ heading: '하나', body: '내용' }]);
    expect(r.smarteditor_text.image_positions).toEqual([
      { after_section: 0, image_index: 0 },
      { after_section: 0, image_index: 1 }, // 같은 섹션 뒤 복수 — python 다중맵 지원
      { after_section: 0, image_index: 2 },
    ]);
  });

  it('슬롯보다 마커가 많으면 초과 마커는 드롭(자리표시 SE 요소 없음)', () => {
    const r = draftToFinalContent(mkDraft({
      imageSlots: slots.slice(0, 1),
      bodyMarkdown: '문단.\n[IMAGE: a]\n[IMAGE: b]\n끝 문단.',
    }));
    expect(r.smarteditor_text.image_positions).toEqual([{ after_section: 0, image_index: 0 }]);
    expect(r.smarteditor_text.sections).toEqual([
      { heading: '', body: '문단.' },
      { heading: '', body: '끝 문단.' },
    ]);
  });

  it('본문 시작 전 마커 → after_section -1(맨 앞 삽입)', () => {
    const r = draftToFinalContent(mkDraft({
      imageSlots: slots.slice(0, 1),
      bodyMarkdown: '[IMAGE: 커버]\n리드 문단.',
    }));
    expect(r.smarteditor_text.image_positions).toEqual([{ after_section: -1, image_index: 0 }]);
    expect(r.smarteditor_text.sections).toEqual([{ heading: '', body: '리드 문단.' }]);
  });

  it('본문이 사실상 비어도 안전(섹션 0, 남는 슬롯은 -1)', () => {
    const r = draftToFinalContent(mkDraft({ imageSlots: slots.slice(0, 1), bodyMarkdown: '\n\n' }));
    expect(r.smarteditor_text.sections).toEqual([]);
    expect(r.smarteditor_text.image_positions).toEqual([{ after_section: -1, image_index: 0 }]);
  });

  it('빈 섹션은 배출하지 않아 인덱스가 어긋나지 않는다(연속 마커)', () => {
    const r = draftToFinalContent(mkDraft({
      imageSlots: slots.slice(0, 2),
      bodyMarkdown: '문단.\n[IMAGE: a]\n[IMAGE: b]',
    }));
    expect(r.smarteditor_text.sections).toEqual([{ heading: '', body: '문단.' }]);
    expect(r.smarteditor_text.image_positions).toEqual([
      { after_section: 0, image_index: 0 },
      { after_section: 0, image_index: 1 },
    ]);
  });
});

describe('coerceBlogDraft', () => {
  it('bodyMarkdown 없으면 null', () => {
    expect(coerceBlogDraft(null)).toBeNull();
    expect(coerceBlogDraft('문자열')).toBeNull();
    expect(coerceBlogDraft({ title: 'x' })).toBeNull();
    expect(coerceBlogDraft({ bodyMarkdown: '   ' })).toBeNull();
  });

  it('최소 입력을 안전 기본값으로 보정', () => {
    const d = coerceBlogDraft({ bodyMarkdown: '본문' });
    expect(d).not.toBeNull();
    expect(d!.titleCandidates).toEqual([]);
    expect(d!.tags).toEqual([]);
    expect(d!.imageSlots).toEqual([]);
    expect(d!.seo).toEqual({ score: 0, checklist: [] });
  });

  it('필드 타입을 보정(비문자 태그 드롭, 슬롯 객체만 수용)', () => {
    const d = coerceBlogDraft({
      bodyMarkdown: '본문',
      topic: '주제',
      titleCandidates: ['제목', 3, ''],
      tags: ['ok', null],
      imageSlots: [{ alt: 'a', prompt: 'p' }, 'junk', null],
    });
    expect(d!.topic).toBe('주제');
    expect(d!.titleCandidates).toEqual(['제목']);
    expect(d!.tags).toEqual(['ok']);
    expect(d!.imageSlots).toEqual([{ alt: 'a', prompt: 'p' }]);
  });
});
