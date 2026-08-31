import { describe, it, expect } from 'vitest';
import { reconstructImageManifest } from './finalize';

describe('reconstructImageManifest — 부분 이미지 매니페스트 복원(순수)', () => {
  it('완성 3장 → 슬롯 3개 순서대로', () => {
    const out = reconstructImageManifest(['blog-image-01.png', 'blog-image-02.png', 'blog-image-03.png'], '/s/images');
    expect(out).toEqual([
      { file_path: '/s/images/blog-image-01.png' },
      { file_path: '/s/images/blog-image-02.png' },
      { file_path: '/s/images/blog-image-03.png' },
    ]);
  });
  it('부분 실패(2/3, 마지막 실패) → 있는 2장만(뒤 슬롯 없음)', () => {
    // 화분곰팡이 실측 케이스: 3번째 실패로 01·02 만 존재
    const out = reconstructImageManifest(['blog-image-01.png', 'blog-image-02.png'], '/s/images');
    expect(out).toEqual([
      { file_path: '/s/images/blog-image-01.png' },
      { file_path: '/s/images/blog-image-02.png' },
    ]);
  });
  it('중간 슬롯 실패 → 번호 압축 없이 null 유지(뒤 이미지가 당겨지지 않음)', () => {
    const out = reconstructImageManifest(['blog-image-01.png', 'blog-image-03.png'], '/s/images');
    expect(out).toEqual([
      { file_path: '/s/images/blog-image-01.png' },
      null,
      { file_path: '/s/images/blog-image-03.png' },
    ]);
  });
  it('빈 목록·비매칭 파일명 → 빈 배열/무시', () => {
    expect(reconstructImageManifest([], '/s/images')).toEqual([]);
    expect(reconstructImageManifest(['thumbnail.jpg', 'image_manifest.json', 'blog-image-1.png'], '/s/images')).toEqual([]);
  });
});
