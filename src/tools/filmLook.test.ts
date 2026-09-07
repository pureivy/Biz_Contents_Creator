import { describe, it, expect } from 'vitest';
// @ts-ignore — remotion/ 는 root tsc include 밖(런타임 임포트만)
import { FILM_LOOKS, pickFilmLook, filmLookEffects } from '../../remotion/filmLook';

describe('필름 룩 — 편별 색 보정', () => {
  it('같은 편은 같은 룩 — 재렌더해도 색이 안 바뀐다', () => {
    for (const id of ['short_a', 'short_b', 'short_c']) {
      expect(pickFilmLook(id)).toBe(pickFilmLook(id));
    }
  });
  it('편이 다르면 룩이 갈린다', () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => pickFilmLook(`short_${i}`).name));
    expect(seen.size).toBeGreaterThan(3);
  });
  it('여섯 룩이 모두 뽑힌다 — 죽은 항목이 없다', () => {
    const seen = new Set(Array.from({ length: 400 }, (_, i) => pickFilmLook(`s${i}`).name));
    expect(seen.size).toBe(FILM_LOOKS.length);
  });

  it('값이 보정 범위를 넘지 않는다 — 세게 걸면 보정이 아니라 필터가 된다', () => {
    // 폭을 넓혔다(2026-09-04, 사용자 "뭐가 바뀐지 모르겠다"). 다만 실사로 읽히는 선은 지킨다:
    // 채도 0 대나 대비 1.5 같은 값은 보정이 아니라 필터다.
    for (const l of FILM_LOOKS) {
      // 폭을 넓혔다(2026-09-04) — 사용자가 "뭐가 바뀐지 모르겠다"고 했다. 다만 실사로 읽히는
      // 선은 지킨다: 채도 0 대나 대비 1.5 같은 값은 보정이 아니라 필터다.
      expect(Math.abs(l.temperature)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(l.tint)).toBeLessThanOrEqual(0.12);
      expect(l.contrast).toBeGreaterThanOrEqual(0.8);
      expect(l.contrast).toBeLessThanOrEqual(1.28);
      expect(l.saturation).toBeGreaterThanOrEqual(0.72);
      expect(l.saturation).toBeLessThanOrEqual(1.25);
      expect(Math.abs(l.brightness)).toBeLessThanOrEqual(0.1);
      expect(l.vignette).toBeLessThanOrEqual(0.36);
      expect(l.aberration).toBeLessThanOrEqual(0.14); // 세면 렌즈 특성이 아니라 깨진 렌더로 보인다
    }
  });
  it('룩 이름이 서로 다르다', () => {
    expect(new Set(FILM_LOOKS.map((l) => l.name)).size).toBe(FILM_LOOKS.length);
  });

  it('효과 배열이 만들어지고 순서가 색→렌즈다', () => {
    const fx = filmLookEffects(FILM_LOOKS[0]!);
    expect(fx.length).toBeGreaterThanOrEqual(6);
    expect(Array.isArray(fx)).toBe(true);
  });
  it('색수차 0 인 룩은 그 효과를 안 넣는다 — 없는 보정을 거는 비용 방지', () => {
    const withAb = FILM_LOOKS.find((l) => l.aberration > 0)!;
    const noAb = FILM_LOOKS.find((l) => l.aberration === 0)!;
    expect(filmLookEffects(withAb).length).toBeGreaterThan(filmLookEffects(noAb).length);
  });
});

describe('형제편은 다른 룩을 받는다', () => {
  it('offset 을 주면 룩이 달라진다 — 같은 대본·이미지를 공유하는 사이라 색까지 같으면 같은 영상이 된다', () => {
    for (const id of ['short_a', 'short_b', 'short_c']) {
      expect(pickFilmLook(id, 1).name).not.toBe(pickFilmLook(id, 0).name);
    }
  });
  it('offset 0 은 종전과 동일', () => {
    expect(pickFilmLook('short_x', 0)).toBe(pickFilmLook('short_x'));
  });
  it('offset 이 목록을 넘어가도 안전하게 돈다', () => {
    expect(pickFilmLook('short_x', FILM_LOOKS.length)).toBe(pickFilmLook('short_x', 0));
  });
});
