import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { ensureShortsThumbnail } from './shortsRender';

afterEach(() => vi.restoreAllMocks());

// ffmpeg 실행 분기는 통합(실영상)으로 검증 — 여기선 파일 존재·신선도 판정(순수 fs 로직)만.
describe('ensureShortsThumbnail', () => {
  it('영상 없고 썸네일도 없으면 null', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(await ensureShortsThumbnail('/d')).toBeNull();
  });
  it('영상 없어도 기존 썸네일 있으면 그 경로 반환(재추출 안 함)', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('thumbnail.jpg'));
    expect(await ensureShortsThumbnail('/d')).toBe('/d/thumbnail.jpg');
  });
  it('썸네일이 이미 있으면 그대로 재사용(디자인 썸네일 보존 — 프레임 재추출 안 함)', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true); // 썸네일·영상 모두 존재
    expect(await ensureShortsThumbnail('/d')).toBe('/d/thumbnail.jpg');
  });
});

// 폴백 렌더러 제목 합성(2026-08-08) — Remotion 실패 시 상단 제목이 통째로 사라지던 실측(참나무 쇼츠)
// 대응. Remotion TitleOverlay 와 동일 기하(폭 %·높이 상한 26%·상단 %·상단 정렬)를 ffmpeg 필터로.
describe('titleOverlayFilter — 폴백 제목 오버레이 필터(순수)', () => {
  it('기본 기하(폭 74%·상단 5%)를 담은 filter_complex 문자열', async () => {
    const { titleOverlayFilter } = await import('./shortsRender');
    const f = titleOverlayFilter(74, 5);
    expect(f).toContain('force_original_aspect_ratio=decrease'); // contain
    expect(f).toContain('scale=w=799');   // 1080*0.74 내림
    expect(f).toContain('h=499');         // 1920*0.26 내림
    expect(f).toContain('overlay=x=(W-w)/2:y=96'); // 1920*0.05
  });
});
