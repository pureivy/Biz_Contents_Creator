import { describe, it, expect } from 'vitest';
import { naverBlogRef } from './naverIndexing';

// 네이버 블로그 URL 두 형식에서 blogId·postId 추출(2026-07-23 색인 점검) — 실측: 클린 형식과
// PostView.naver?blogId=&logNo= 편집기 형식이 섞여 있어 둘 다 처리해야 매칭이 된다.
describe('naverBlogRef — URL 형식별 blogId·postId 추출', () => {
  it('클린 형식 /blogId/postId', () => {
    expect(naverBlogRef('https://blog.naver.com/biondi_tree/224345904342')).toEqual({ blogId: 'biondi_tree', postId: '224345904342' });
  });
  it('PostView.naver?blogId=&logNo= 편집기 형식', () => {
    const u = 'https://blog.naver.com/PostView.naver?blogId=biondi_tree&Redirect=View&logNo=224347607380&categoryNo=1';
    expect(naverBlogRef(u)).toEqual({ blogId: 'biondi_tree', postId: '224347607380' });
  });
  it('빈/무관 URL 은 빈 문자열', () => {
    expect(naverBlogRef('')).toEqual({ blogId: '', postId: '' });
    expect(naverBlogRef('https://example.com/foo/123')).toEqual({ blogId: '', postId: '' });
  });
});
