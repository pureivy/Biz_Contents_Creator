import { describe, it, expect } from 'vitest';
import { parseBlogIdLogNo, sumReactions } from './naverSympathy';

describe('parseBlogIdLogNo — 발행 URL 형태별(순수)', () => {
  it('표준·모바일·PostView 쿼리 형태 지원', () => {
    expect(parseBlogIdLogNo('https://blog.naver.com/biondi_tree/224345904342')).toEqual({ blogId: 'biondi_tree', logNo: '224345904342' });
    expect(parseBlogIdLogNo('https://m.blog.naver.com/biondi_tree/224345904342')).toEqual({ blogId: 'biondi_tree', logNo: '224345904342' });
    expect(parseBlogIdLogNo('https://blog.naver.com/PostView.naver?blogId=biondi_tree&logNo=224345904342')).toEqual({ blogId: 'biondi_tree', logNo: '224345904342' });
  });
  it('이형은 null', () => {
    expect(parseBlogIdLogNo('https://example.com/x')).toBeNull();
    expect(parseBlogIdLogNo('')).toBeNull();
  });
});

describe('sumReactions — like API 응답 → 공감 총합(순수)', () => {
  it('전 리액션 count 합(공감·감사·웃김 등)', () => {
    expect(sumReactions({ contents: [{ reactions: [{ reactionType: 'like', count: 3 }, { reactionType: 'thanks', count: 2 }] }] })).toBe(5);
  });
  it('빈 reactions 는 실값 0(공감 없음 — 실측 2026-07-31 응답 형태)', () => {
    expect(sumReactions({ contents: [{ reactions: [], reactionMap: {} }] })).toBe(0);
  });
  it('이형·빈 응답은 null(미기록 — 과거 값 유지)', () => {
    expect(sumReactions(null)).toBeNull();
    expect(sumReactions({})).toBeNull();
    expect(sumReactions({ contents: [] })).toBeNull();
  });
  it('불량 count 는 0 취급(합 오염 방지)', () => {
    expect(sumReactions({ contents: [{ reactions: [{ count: 'x' }, { count: 4 }] }] })).toBe(4);
  });
});
