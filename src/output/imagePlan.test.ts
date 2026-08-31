import { describe, it, expect } from 'vitest';
import { parseImagePlan, draftFiles } from './naverBlog';
import type { BlogDraft } from './formatter';

// 이미지 디자이너 협의 스테이지 — 자유 코멘트 뒤 JSON 한 줄에서 슬롯을 추출한다.
// 실패는 [](fail-open — 편집자 초안 슬롯 유지)여야 런이 절대 안 죽는다.

describe('parseImagePlan — 디자이너 계획 → 이미지 슬롯', () => {
  it('협의 코멘트 + JSON 한 줄 → alt/prompt 슬롯', () => {
    const text = '작가님 카피 톤이 밝아서 사진풍으로 가겠습니다.\n' +
      '{"images":[{"alt":"장마철 창가 제습 모습","prompt":"밝은 아침 거실 창가, 제습제 근접, 자연광, 사진풍"},' +
      '{"alt":"숯 제습제","prompt":"대나무 숯 바구니, 옷장 안, 부드러운 조명"}]}';
    const slots = parseImagePlan(text);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.alt).toContain('장마철');
    expect(slots[1]!.prompt).toContain('숯');
  });
  it('alt 또는 prompt 가 빠진 항목은 제외', () => {
    const slots = parseImagePlan('{"images":[{"alt":"만","prompt":""},{"alt":"","prompt":"만"},{"alt":"a","prompt":"b"}]}');
    expect(slots).toEqual([{ alt: 'a', prompt: 'b' }]);
  });
  it('최대 max(기본 3)장으로 클램프', () => {
    const many = { images: Array.from({ length: 6 }, (_, i) => ({ alt: `a${i}`, prompt: `p${i}` })) };
    expect(parseImagePlan(JSON.stringify(many))).toHaveLength(3);
    expect(parseImagePlan(JSON.stringify(many), 2)).toHaveLength(2);
  });
  it('JSON 없음/형식 불일치 → [] (fail-open)', () => {
    expect(parseImagePlan('죄송하지만 계획을 세울 수 없습니다.')).toEqual([]);
    expect(parseImagePlan('{"plan":"no images key"}')).toEqual([]);
    expect(parseImagePlan('')).toEqual([]);
  });
});

describe('draftFiles — 슬롯 갱신 후 파일 재동기화', () => {
  const draft = {
    topic: 't', primaryKeyword: 'k', titleCandidates: ['제목'], metaDescription: 'm',
    tags: ['태그'], imageSlots: [{ alt: 'a', prompt: 'p' }], internalLinks: [],
    bodyMarkdown: '## 소제목\n본문', seo: { score: 80, checks: [] },
  } as unknown as BlogDraft;
  it('draft.json 에 갱신된 슬롯이 실리고 image-prompts.md 가 생성된다', () => {
    const files = draftFiles(draft);
    const names = files.map((f) => f.name);
    expect(names).toEqual(['draft.json', 'draft.md', 'draft.html', 'image-prompts.md']);
    const json = JSON.parse(files[0]!.content) as BlogDraft;
    expect(json.imageSlots).toEqual([{ alt: 'a', prompt: 'p' }]);
    expect(files[3]!.content).toContain('**a**');
  });
  it('슬롯이 없으면 image-prompts.md 는 생략', () => {
    const noSlots = { ...draft, imageSlots: [] } as unknown as BlogDraft;
    expect(draftFiles(noSlots).map((f) => f.name)).toEqual(['draft.json', 'draft.md', 'draft.html']);
  });
});
