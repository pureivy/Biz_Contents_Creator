import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { inheritShortsAssets, inheritedSceneImages, inheritedClips, writeSceneImageMap, INHERITED_FILES, SCENE_IMAGE_MAP } from './shortsInherit';

const mk = (): { from: string; to: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inherit-'));
  const from = path.join(root, 'primary'); const to = path.join(root, 'sibling');
  fs.mkdirSync(path.join(from, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(from, 'clips'), { recursive: true });
  fs.writeFileSync(path.join(from, 'plan.json'), JSON.stringify({ title: 't', scenes: [{}, {}, {}] }));
  fs.writeFileSync(path.join(from, 'title-art.png'), 'png');
  fs.writeFileSync(path.join(from, 'thumbnail.jpg'), 'jpg');
  for (const n of ['blog-image-01.png', 'blog-image-02.png', 'blog-image-03.png']) fs.writeFileSync(path.join(from, 'scenes', n), 'x');
  fs.writeFileSync(path.join(from, 'clips', 'clip_02.mp4'), 'mp4');
  return { from, to };
};

describe('inheritShortsAssets', () => {
  it('대본·이미지·클립·캘리·썸네일을 복사한다', () => {
    const { from, to } = mk();
    const r = inheritShortsAssets(from, to);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(to, 'plan.json'))).toBe(true);
    expect(fs.existsSync(path.join(to, 'title-art.png'))).toBe(true);
    expect(fs.readdirSync(path.join(to, 'scenes'))).toHaveLength(3);
    expect(fs.existsSync(path.join(to, 'clips', 'clip_02.mp4'))).toBe(true);
  });
  it('낭독은 승계하지 않는다 — 작가마다 목소리가 다르다', () => {
    const { from, to } = mk();
    fs.mkdirSync(path.join(from, 'remotion'), { recursive: true });
    fs.writeFileSync(path.join(from, 'remotion', 'narr_01.mp3'), 'mp3');
    inheritShortsAssets(from, to);
    expect(fs.existsSync(path.join(to, 'remotion'))).toBe(false);
    expect(INHERITED_FILES.some((f) => String(f).includes('narr'))).toBe(false);
  });
  it('썸네일 QA 미해결 표식도 함께 옮긴다 — 게이트를 물려받아야 한다', () => {
    const { from, to } = mk();
    fs.writeFileSync(path.join(from, 'thumb-qa-failed.json'), '{}');
    inheritShortsAssets(from, to);
    expect(fs.existsSync(path.join(to, 'thumb-qa-failed.json'))).toBe(true);
  });
  it('대본이 없으면 승계 실패 — 호출부가 일반 생성으로 돌아가야 한다', () => {
    const { from, to } = mk();
    fs.rmSync(path.join(from, 'plan.json'));
    expect(inheritShortsAssets(from, to).ok).toBe(false);
  });
  it('복사본이라 원편을 지워도 형제편이 산다', () => {
    const { from, to } = mk();
    inheritShortsAssets(from, to);
    fs.rmSync(from, { recursive: true, force: true });
    expect(fs.existsSync(path.join(to, 'plan.json'))).toBe(true);
    expect(fs.readdirSync(path.join(to, 'scenes'))).toHaveLength(3);
  });
});

describe('inheritedSceneImages / inheritedClips', () => {
  it('씬 순서대로 채우고 모자란 자리는 null', () => {
    const { from, to } = mk();
    inheritShortsAssets(from, to);
    const imgs = inheritedSceneImages(to, 5);
    expect(imgs).toHaveLength(5);
    expect(imgs.slice(0, 3).every(Boolean)).toBe(true);
    expect(imgs[3]).toBeNull();
  });
  it('클립은 clip_NN 규약대로 매칭된다', () => {
    const { from, to } = mk();
    inheritShortsAssets(from, to);
    const c = inheritedClips(to, 3);
    expect(c[0]).toBeNull();
    expect(c[1]).toContain('clip_02.mp4');
    expect(c[2]).toBeNull();
  });
  it('scenes 디렉터리가 없어도 안 터진다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
    expect(inheritedSceneImages(root, 3)).toEqual([null, null, null]);
    expect(inheritedClips(root, 2)).toEqual([null, null]);
  });
});

describe('씬→이미지 매핑 — 실촬영 씬이 있으면 이름순 위치로는 밀린다(2026-09-04 실사고)', () => {
  // 실측: 5씬 중 3번이 실촬영이라 생성 이미지가 넷(blog-image-01..04)이었다. 이름순으로 꽂으니
  // 3번 씬이 4번 씬 그림을 받고 마지막 씬은 그라데이션으로 나갔다. 인스타편에서 실제로 발생.
  const mk5 = (): { from: string; to: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-'));
    const from = path.join(root, 'p'); const to = path.join(root, 's');
    fs.mkdirSync(path.join(from, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(from, 'plan.json'), JSON.stringify({ title: 't', scenes: [{}, {}, {}, {}, {}] }));
    for (const n of ['blog-image-01.png', 'blog-image-02.png', 'blog-image-03.png', 'blog-image-04.png']) {
      fs.writeFileSync(path.join(from, 'scenes', n), 'x');
    }
    return { from, to };
  };
  const P = (f: string | null | undefined): string | null => (f ? path.basename(f) : null);

  it('매핑을 남기면 실촬영 씬만 비고 나머지는 제 그림을 받는다', () => {
    const { from, to } = mk5();
    // 씬2(0-base)가 실촬영 — 이미지 없음
    writeSceneImageMap(from, [
      path.join(from, 'scenes', 'blog-image-01.png'),
      path.join(from, 'scenes', 'blog-image-02.png'),
      null,
      path.join(from, 'scenes', 'blog-image-03.png'),
      path.join(from, 'scenes', 'blog-image-04.png'),
    ]);
    inheritShortsAssets(from, to);
    expect(inheritedSceneImages(to, 5).map(P))
      .toEqual(['blog-image-01.png', 'blog-image-02.png', null, 'blog-image-03.png', 'blog-image-04.png']);
  });
  it('매핑이 없으면 종전대로 이름순 위치 — 이전 편의 재조립을 막지 않는다', () => {
    const { from, to } = mk5();
    inheritShortsAssets(from, to);
    expect(inheritedSceneImages(to, 5).map(P))
      .toEqual(['blog-image-01.png', 'blog-image-02.png', 'blog-image-03.png', 'blog-image-04.png', null]);
  });
  it('매핑 파일이 형제편으로 복사된다 — 안 옮기면 형제편이 위치로 떨어진다', () => {
    const { from, to } = mk5();
    writeSceneImageMap(from, [null, null, null, null, null]);
    inheritShortsAssets(from, to);
    expect(fs.existsSync(path.join(to, SCENE_IMAGE_MAP))).toBe(true);
  });
  it('매핑이 가리키는 파일이 없어지면 그 자리는 null', () => {
    const { from, to } = mk5();
    writeSceneImageMap(from, [path.join(from, 'scenes', 'gone.png'), null, null, null, null]);
    inheritShortsAssets(from, to);
    expect(inheritedSceneImages(to, 5)[0]).toBeNull();
  });
  it('깨진 매핑 파일은 위치 폴백으로 떨어진다', () => {
    const { from, to } = mk5();
    inheritShortsAssets(from, to);
    fs.writeFileSync(path.join(to, SCENE_IMAGE_MAP), '{ 망가짐');
    expect(P(inheritedSceneImages(to, 5)[0])).toBe('blog-image-01.png');
  });
});

describe('씬→이미지 매핑 — 디렉터리가 다른 동명 파일(2026-09-04 실사고)', () => {
  // 실측: 씬3 이 QA 로 재생성돼 scenes-retry/blog-image-01.png 를 가리키는데 매핑엔 파일명만
  // 남아, 읽는 쪽이 scenes/blog-image-01.png(=씬1 그림)를 집었다. 두 씬이 같은 그림이 됐다.
  const mk = (): { from: string; to: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-'));
    const from = path.join(root, 'p'); const to = path.join(root, 's');
    fs.mkdirSync(path.join(from, 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(from, 'scenes-retry'), { recursive: true });
    fs.writeFileSync(path.join(from, 'plan.json'), JSON.stringify({ title: 't', scenes: [{}, {}, {}] }));
    fs.writeFileSync(path.join(from, 'scenes', 'blog-image-01.png'), '씬1 그림');
    fs.writeFileSync(path.join(from, 'scenes', 'blog-image-02.png'), '씬2 그림');
    fs.writeFileSync(path.join(from, 'scenes-retry', 'blog-image-01.png'), '씬3 재생성 그림');
    return { from, to };
  };

  it('QA 재생성본을 씬1 그림으로 착각하지 않는다', () => {
    const { from, to } = mk();
    writeSceneImageMap(from, [
      path.join(from, 'scenes', 'blog-image-01.png'),
      path.join(from, 'scenes', 'blog-image-02.png'),
      path.join(from, 'scenes-retry', 'blog-image-01.png'),
    ]);
    inheritShortsAssets(from, to);
    const got = inheritedSceneImages(to, 3);
    expect(fs.readFileSync(got[0]!, 'utf-8')).toBe('씬1 그림');
    expect(fs.readFileSync(got[2]!, 'utf-8')).toBe('씬3 재생성 그림');
  });
  it('재생성 디렉터리도 형제편으로 복사된다 — 안 옮기면 그 씬이 빈다', () => {
    const { from, to } = mk();
    writeSceneImageMap(from, [null, null, path.join(from, 'scenes-retry', 'blog-image-01.png')]);
    inheritShortsAssets(from, to);
    expect(fs.existsSync(path.join(to, 'scenes-retry', 'blog-image-01.png'))).toBe(true);
  });
  it('편 폴더 밖 경로는 매핑에 안 담는다 — 형제편에 그 파일이 없다', () => {
    const { from, to } = mk();
    writeSceneImageMap(from, [path.join(os.tmpdir(), '남의-사진.jpg'), null, null]);
    inheritShortsAssets(from, to);
    expect(inheritedSceneImages(to, 3)[0]).toBeNull();
  });
  it('".." 이 섞인 값은 무시한다', () => {
    const { from, to } = mk();
    inheritShortsAssets(from, to);
    fs.writeFileSync(path.join(to, SCENE_IMAGE_MAP), JSON.stringify(['../../etc/passwd', null, null]));
    expect(inheritedSceneImages(to, 3)[0]).toBeNull();
  });
  it('파일명만 있는 옛 매핑은 종전대로 scenes/ 밑으로 읽는다', () => {
    const { from, to } = mk();
    inheritShortsAssets(from, to);
    fs.writeFileSync(path.join(to, SCENE_IMAGE_MAP), JSON.stringify(['blog-image-01.png', null, null]));
    expect(fs.readFileSync(inheritedSceneImages(to, 3)[0]!, 'utf-8')).toBe('씬1 그림');
  });
});
