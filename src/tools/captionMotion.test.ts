import { describe, it, expect } from 'vitest';
// @ts-ignore — remotion/ 는 root tsc include 밖(런타임 임포트만)
import { CAPTION_MOTIONS, pickCaptionMotion, captionWordStyle } from '../../remotion/captionMotion';

const FPS = 30;

describe('자막 모션 — 편마다 다른 글자 움직임', () => {
  it('여섯 종이 모두 뽑힌다', () => {
    const seen = new Set(Array.from({ length: 300 }, (_, i) => pickCaptionMotion(i / 300)));
    expect(seen.size).toBe(CAPTION_MOTIONS.length);
  });
  it('rand 1.0 경계에서도 목록 밖으로 안 나간다', () => {
    expect(CAPTION_MOTIONS).toContain(pickCaptionMotion(0.999999));
    expect(CAPTION_MOTIONS).toContain(pickCaptionMotion(1));
    expect(CAPTION_MOTIONS).toContain(pickCaptionMotion(0));
  });

  for (const m of CAPTION_MOTIONS) {
    it(`${m} — 등장 전엔 안 보이고, 정착 뒤엔 완전히 보인다`, () => {
      const before = captionWordStyle(m, 0, FPS, 2);       // 단어 2 는 12프레임 뒤에 시작
      expect(Number(before.opacity)).toBe(0);
      const after = captionWordStyle(m, 200, FPS, 2);
      expect(Number(after.opacity)).toBeCloseTo(1, 5);
    });
    it(`${m} — 정착 뒤 변형이 남지 않는다(자막이 비뚤게 멈추면 안 된다)`, () => {
      const s = captionWordStyle(m, 300, FPS, 0);
      const t = String(s.transform ?? '');
      // translate 0px / scale 1 / 변형 없음 중 하나여야 한다
      expect(/translate[XY]\(-?0(\.0+)?px\)|scale\(1(\.0+)?\)|^$/.test(t)).toBe(true);
      expect(String(s.filter ?? '')).toMatch(/blur\(0(\.0+)?px\)|^$/);
    });
    it(`${m} — 레이아웃을 바꾸는 속성은 안 쓴다(줄바꿈이 흔들리면 안 된다)`, () => {
      const s = captionWordStyle(m, 6, FPS, 0) as Record<string, unknown>;
      for (const k of ['width', 'height', 'margin', 'padding', 'fontSize', 'letterSpacing', 'lineHeight']) {
        expect(s[k]).toBeUndefined();
      }
    });
    it(`${m} — opacity 가 0~1 을 벗어나지 않는다`, () => {
      for (let f = -5; f < 60; f++) {
        const o = Number(captionWordStyle(m, f, FPS, 0).opacity);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    });
  }

  it('단어 순번이 뒤일수록 늦게 등장한다', () => {
    for (const m of CAPTION_MOTIONS) {
      const a = Number(captionWordStyle(m, 10, FPS, 0).opacity);
      const b = Number(captionWordStyle(m, 10, FPS, 3).opacity);
      expect(a).toBeGreaterThan(b);
    }
  });
  it('모션마다 실제로 다른 스타일이 나온다', () => {
    const at8 = CAPTION_MOTIONS.map((m) => JSON.stringify(captionWordStyle(m, 8, FPS, 0)));
    expect(new Set(at8).size).toBeGreaterThan(4);
  });
});
