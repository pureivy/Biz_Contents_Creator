import { describe, it, expect } from 'vitest';
// @ts-ignore — remotion/anim.ts (root tsc include 밖, JS 런타임 임포트만)
import * as A from '../../remotion/anim';

describe('kenBurnsScale', () => {
  it('시작 1, 끝 증가(≤1.12)', () => {
    expect(A.kenBurnsScale(0, 100)).toBeCloseTo(1, 3);
    expect(A.kenBurnsScale(100, 100)).toBeGreaterThan(1.05);
    expect(A.kenBurnsScale(100, 100)).toBeLessThanOrEqual(1.12);
  });
  it('씬별 변주 — 홀수 index 는 줌아웃(max→1)', () => {
    expect(A.kenBurnsScale(0, 100, 1.08, 1)).toBeCloseTo(1.08, 3);
    expect(A.kenBurnsScale(100, 100, 1.08, 1)).toBeCloseTo(1, 3);
  });
});
describe('smoothstep — 이징 곡선', () => {
  it('경계 0/1, 중앙 0.5, 선형보다 완만한 시작', () => {
    expect(A.smoothstep(0)).toBe(0);
    expect(A.smoothstep(1)).toBe(1);
    expect(A.smoothstep(0.5)).toBeCloseTo(0.5, 5);
    expect(A.smoothstep(0.1)).toBeLessThan(0.1); // ease-in 구간
  });
});
describe('kenBurnsPan — 방향 4종 순환', () => {
  it('index 별 방향이 다르고, 시작·끝 대칭(±12px)', () => {
    const p0 = A.kenBurnsPan(100, 100, 0), p1 = A.kenBurnsPan(100, 100, 1);
    expect(p0.x).toBeCloseTo(12, 3); expect(p0.y).toBeCloseTo(-12, 3);
    expect(p1.x).toBeCloseTo(-12, 3); expect(p1.y).toBeCloseTo(12, 3);
    expect(A.kenBurnsPan(0, 100, 0).x).toBeCloseTo(-12, 3);
  });
});
describe('sceneEnterFade — 씬 시작 페이드인', () => {
  it('0에서 0, fade 프레임에 1, 이후 유지', () => {
    expect(A.sceneEnterFade(0, 6)).toBe(0);
    expect(A.sceneEnterFade(6, 6)).toBe(1);
    expect(A.sceneEnterFade(999, 6)).toBe(1);
  });
});
describe('captionWordProgress — 단어별 부드러운 등장', () => {
  it('앞 단어가 먼저 완료, rise 동안 0..1 단조 증가', () => {
    expect(A.captionWordProgress(0, 0)).toBe(0);
    expect(A.captionWordProgress(5, 0)).toBe(1);   // rise=5 완료
    expect(A.captionWordProgress(5, 1)).toBeLessThan(1); // 둘째 단어는 아직
    const a = A.captionWordProgress(2, 0), b = A.captionWordProgress(3, 0);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
describe('sceneFadeOpacity', () => {
  it('중앙 1, 경계 0 근처', () => {
    expect(A.sceneFadeOpacity(0, 90, 6)).toBeCloseTo(0, 1);
    expect(A.sceneFadeOpacity(45, 90, 6)).toBeCloseTo(1, 1);
    expect(A.sceneFadeOpacity(90, 90, 6)).toBeLessThan(0.3);
  });
});
describe('countUpValue — ease-out 카운트업, settle 전 도달', () => {
  it('시작 0, 끝 value, 단조 증가', () => {
    expect(A.countUpValue(0, 90, 42)).toBe(0);
    expect(A.countUpValue(90, 90, 42)).toBe(42);
    expect(A.countUpValue(78, 90, 42)).toBe(42); // total - settle(12) 에서 이미 도달
    const mid1 = A.countUpValue(20, 90, 42), mid2 = A.countUpValue(40, 90, 42);
    expect(mid1).toBeGreaterThanOrEqual(0);
    expect(mid2).toBeGreaterThanOrEqual(mid1);
  });
  it('소수 value 는 소수 1자리 유지', () => {
    expect(A.countUpValue(90, 90, 3.5)).toBeCloseTo(3.5, 5);
    expect(Number.isInteger(A.countUpValue(45, 90, 42))).toBe(true);
  });
});
describe('staggerProgress — 슬롯 분배·순서·경계', () => {
  it('enter 전 0, 충분히 지나면 1, 앞 항목이 먼저', () => {
    expect(A.staggerProgress(0, 90, 0, 3)).toBe(0);
    expect(A.staggerProgress(90, 90, 2, 3)).toBe(1);
    expect(A.staggerProgress(30, 90, 0, 3)).toBeGreaterThanOrEqual(A.staggerProgress(30, 90, 1, 3));
    expect(A.staggerProgress(30, 90, 1, 3)).toBeGreaterThanOrEqual(A.staggerProgress(30, 90, 2, 3));
  });
  it('count 0 은 1(무동작), 진행도는 0..1 클램프', () => {
    expect(A.staggerProgress(50, 90, 0, 0)).toBe(1);
    expect(A.staggerProgress(9999, 90, 0, 3)).toBe(1);
  });
});

describe('kenBurnsMove — 확장 무브(폴백=현행 index parity)', () => {
  it('move 미지정 = 종전 kenBurnsScale/Pan 과 동일(폴백 불변)', () => {
    const m0 = A.kenBurnsMove(50, 100, 0), m1 = A.kenBurnsMove(50, 100, 1);
    expect(m0.scale).toBeCloseTo(A.kenBurnsScale(50, 100, 1.08, 0), 6);
    expect(m1.scale).toBeCloseTo(A.kenBurnsScale(50, 100, 1.08, 1), 6);
    expect(m0.x).toBeCloseTo(A.kenBurnsPan(50, 100, 0).x, 6);
    expect(m0.rotate).toBe(0);
  });
  it('push = 오버스캔 1.08 시작 → 강줌 1.458(1.08×1.35), 70% 지점 조기 완료 + 회전 1.5° + 팬 40%', () => {
    expect(A.kenBurnsMove(0, 100, 0, 'push').scale).toBeCloseTo(1.08, 3);
    expect(A.kenBurnsMove(70, 100, 0, 'push').scale).toBeCloseTo(1.08 * 1.35, 3); // window 0.7 완료
    expect(A.kenBurnsMove(100, 100, 0, 'push').rotate).toBeCloseTo(1.5, 3);
    expect(Math.abs(A.kenBurnsMove(100, 100, 0, 'push').x)).toBeCloseTo(28, 3); // 70×0.4
  });
  it('intensity 진폭 — subtle 1.134 / strong 1.382(×1.08 오버스캔), 85% 조기 완료, zoom-out 역방향', () => {
    expect(A.kenBurnsMove(100, 100, 0, 'zoom-in', 'subtle').scale).toBeCloseTo(1.08 * 1.05, 3);
    expect(A.kenBurnsMove(85, 100, 0, 'zoom-in', 'strong').scale).toBeCloseTo(1.08 * 1.28, 3); // window 0.85 완료
    expect(A.kenBurnsMove(0, 100, 0, 'zoom-out', 'strong').scale).toBeCloseTo(1.08 * 1.28, 3);
    expect(A.kenBurnsMove(100, 100, 0, 'zoom-out', 'strong').scale).toBeCloseTo(1.08, 3);
  });
  it('팬 축별 캡 — 저스케일 구간은 클램프(±37.6), 고스케일 구간은 원진폭(±70)', () => {
    // s=1.08 에서 가로 캡 = (0.08×540/1.08)×0.94 = 37.6 — 우측 검은 띠 실측(2026-08-10)의 수선
    expect(A.kenBurnsMove(0, 100, 0, 'zoom-in', 'strong').x).toBeCloseTo(-37.6, 1);
    expect(A.kenBurnsMove(100, 100, 0, 'zoom-in', 'strong').x).toBeCloseTo(70, 3); // s=1.38 — 여유 충분
  });
  it('가장자리 노출 불가능(속성) — 전 조합에서 scale·|팬| ≤ (scale-1)·half', () => {
    for (const move of ['zoom-in', 'zoom-out', 'push', undefined] as const)
      for (const intensity of ['subtle', 'normal', 'strong'] as const)
        for (let index = 0; index < 4; index++)
          for (let f = 0; f <= 100; f += 10) {
            const m = A.kenBurnsMove(f, 100, index, move, intensity);
            expect(m.scale * Math.abs(m.x)).toBeLessThanOrEqual((m.scale - 1) * 540 + 1e-6);
            expect(m.scale * Math.abs(m.y)).toBeLessThanOrEqual((m.scale - 1) * 960 + 1e-6);
          }
  });
  it('none = 완전 정지(스케일 1·팬 0·회전 0)', () => {
    expect(A.kenBurnsMove(70, 100, 3, 'none')).toEqual({ scale: 1, x: 0, y: 0, rotate: 0 });
  });
});

describe('spotlightRadius·particleState — 액센트 수학(순수·결정적)', () => {
  it('스포트라이트 — 0에서 30%, open(24) 이후 150% 완전 개방', () => {
    expect(A.spotlightRadius(0)).toBeCloseTo(30, 3);
    expect(A.spotlightRadius(24)).toBeCloseTo(150, 3);
    expect(A.spotlightRadius(999)).toBeCloseTo(150, 3);
  });
  it('hash01 — 결정적(같은 seed 같은 값), 0..1 범위', () => {
    expect(A.hash01(42)).toBe(A.hash01(42));
    expect(A.hash01(42)).not.toBe(A.hash01(43));
    for (const s of [0, 1, 7, 999]) { const v = A.hash01(s); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
  it('particleState — 같은 (seed,frame) 동일 상태(프레임 간 결정성), y 순환 낙하', () => {
    expect(A.particleState(5, 30)).toEqual(A.particleState(5, 30));
    const a = A.particleState(5, 0).y01, b = A.particleState(5, 50).y01;
    expect(a).not.toBeCloseTo(b, 5); // 낙하 진행
    expect(A.particleState(5, 9999).y01).toBeLessThan(1.15); // 순환 유지
  });
});
