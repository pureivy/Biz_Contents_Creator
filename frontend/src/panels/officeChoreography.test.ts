import { describe, it, expect } from "vitest";
import {
  LOUNGE_SOFA_ZONE, PANTRY_ZONE, CONF_ZONE, READING_ZONE, BEANBAG_ZONE, WHITEBOARD_SPOT,
  pointInZone, overlapFrac, placeInZone, MAX_OVERLAP, clusterBelow, meetingCircle,
  AVATAR_W, AVATAR_H, VGAP, Pt, Zone,
} from "./officeChoreography";

// 결정적 난수(LCG) — placeInZone 의 산포가 재현 가능하도록.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const inZone = (p: Pt, z: Zone) => p.x >= z.xMin && p.x <= z.xMax && p.y >= z.yMin && p.y <= z.yMax;

// office_map.png 의 8개 방 좌표(OfficeView ROOMS 와 동일) — ambient 존이 각자 '제 방' 안에 드는지 검증.
// 가구·동선은 그림이 그리므로, 코드 존은 그 방 사각형 안에 있기만 하면 된다(겹침 허용이라 비겹침 검증 X).
type Rect = { xMin: number; xMax: number; yMin: number; yMax: number };
const inside = (p: Pt, r: Rect) => p.x >= r.xMin && p.x <= r.xMax && p.y >= r.yMin && p.y <= r.yMax;
const within = (z: Zone, r: Rect) =>
  inside({ x: z.xMin, y: z.yMin }, r) && inside({ x: z.xMax, y: z.yMax }, r);
const CONF: Rect    = { xMin: 31,   xMax: 60,   yMin: 3,  yMax: 33 }; // 회의실(상중)
const LOUNGE: Rect  = { xMin: 11,   xMax: 42,   yMin: 60, yMax: 98 }; // 휴게실(좌하)
const PANTRY: Rect  = { xMin: 62.5, xMax: 98.5, yMin: 32, yMax: 58 }; // 탕비실(우중)
const READING: Rect = { xMin: 61.5, xMax: 98,   yMin: 60, yMax: 98 }; // 휴식공간(우하)
const BEANBAG: Rect = { xMin: 42,   xMax: 62,   yMin: 60, yMax: 98 }; // 하단 중앙 빈백 라운지

describe("방 안 ambient 배치 영역 — office_map.png 의 제 방 안에 든다", () => {
  it("업무협의·화이트보드는 회의실(상중) 안", () => {
    expect(within(CONF_ZONE, CONF)).toBe(true);
    expect(inside(WHITEBOARD_SPOT, CONF)).toBe(true);
  });
  it("잡담·커피 존은 탕비실(우중) 안", () => {
    expect(within(PANTRY_ZONE, PANTRY)).toBe(true);
  });
  it("휴식 존들은 각자 휴게실/휴식공간/빈백 안", () => {
    expect(within(LOUNGE_SOFA_ZONE, LOUNGE)).toBe(true);
    expect(within(READING_ZONE, READING)).toBe(true);
    expect(within(BEANBAG_ZONE, BEANBAG)).toBe(true);
  });
  it("y·x 밴드가 1점이 아니라 폭을 가져 일직선 방지(2D 산포)", () => {
    for (const z of [LOUNGE_SOFA_ZONE, PANTRY_ZONE, CONF_ZONE, READING_ZONE, BEANBAG_ZONE]) {
      expect(z.yMax).toBeGreaterThan(z.yMin);
      expect(z.xMax).toBeGreaterThan(z.xMin);
    }
  });
});

describe("pointInZone — [0,1] 난수를 영역 안 좌표로", () => {
  it("모서리·중앙 매핑", () => {
    expect(pointInZone(CONF_ZONE, 0, 0)).toEqual({ x: CONF_ZONE.xMin, y: CONF_ZONE.yMin });
    expect(pointInZone(CONF_ZONE, 1, 1)).toEqual({ x: CONF_ZONE.xMax, y: CONF_ZONE.yMax });
  });
  it("어떤 난수든 결과는 영역 안", () => {
    for (const [rx, ry] of [[0, 0], [0.3, 0.7], [1, 1], [0.99, 0.01]] as const) {
      expect(inZone(pointInZone(PANTRY_ZONE, rx, ry), PANTRY_ZONE)).toBe(true);
      expect(inZone(pointInZone(CONF_ZONE, rx, ry), CONF_ZONE)).toBe(true);
    }
  });
});

describe("overlapFrac — 아바타 박스 면적 겹침 비율(한쪽 박스 대비)", () => {
  it("같은 점=완전 겹침(1), 한 칸 이상 떨어지면 0", () => {
    expect(overlapFrac({ x: 50, y: 50 }, { x: 50, y: 50 })).toBeCloseTo(1, 5);
    expect(overlapFrac({ x: 50, y: 50 }, { x: 50 + AVATAR_W, y: 50 })).toBeCloseTo(0, 5);
    expect(overlapFrac({ x: 50, y: 50 }, { x: 50, y: 50 + AVATAR_H })).toBeCloseTo(0, 5);
  });
  it("같은 y, dx=AVATAR_W/2 → 면적 1/2 (세로 완전 겹침 × 가로 1/2)", () => {
    expect(overlapFrac({ x: 50, y: 50 }, { x: 50 + AVATAR_W / 2, y: 50 })).toBeCloseTo(0.5, 5);
  });
  it("1/3 경계: dx=AVATAR_W*2/3, dy=0 → 정확히 1/3", () => {
    expect(overlapFrac({ x: 50, y: 50 }, { x: 50 + (AVATAR_W * 2) / 3, y: 50 })).toBeCloseTo(1 / 3, 5);
  });
});

describe("placeInZone — 영역 안 산포, 쌍별 겹침 < 1/3", () => {
  it("배치된 점은 항상 영역 안(실제 존)", () => {
    const rng = lcg(7);
    const placed: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const p = placeInZone(PANTRY_ZONE, placed, rng);
      expect(inZone(p, PANTRY_ZONE)).toBe(true);
      placed.push(p);
    }
  });
  it("충분히 넓은 영역에선 4명 쌍별 겹침이 모두 1/3 미만", () => {
    const WIDE: Zone = { xMin: 10, xMax: 40, yMin: 10, yMax: 30 };
    const rng = lcg(42);
    const placed: Pt[] = [];
    for (let i = 0; i < 4; i++) placed.push(placeInZone(WIDE, placed, rng));
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(overlapFrac(placed[i], placed[j])).toBeLessThan(MAX_OVERLAP);
  });
  it("MAX_OVERLAP 은 1/3", () => {
    expect(MAX_OVERLAP).toBeCloseTo(1 / 3, 10);
  });
});

// ── 안무 기하(집합·토론 상석) — OfficeView 실좌표로 '방 밖 이탈'을 검증한다 ─────────
// 기획팀(planning) 방: y13~30(h17) — 팀장(fy0.62) 아래 +11 은 방 밖(탕비실)이라 클램프 필수.
// 경영관리팀(support) 방: y33.5~58.5(h25) — 깊어서 기존 '팀장 아래 집합'이 그대로 유효.
const PLANNING = { left: 61.5, right: 98.5, top: 13, bottom: 30 };
const SUPPORT = { left: 26, right: 61.5, top: 33.5, bottom: 58.5 };

describe("clusterBelow — 집합 대열이 방 사각형을 벗어나지 않는다", () => {
  it("깊은 방(경영관리팀): 기존 '팀장 아래 중앙 정렬' 유지", () => {
    const anchor = { x: 43.75, y: 38 };
    const pts = clusterBelow(4, anchor.x, anchor.y, SUPPORT.left, SUPPORT.right, SUPPORT.bottom);
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(anchor.y + AVATAR_H); // 팀장 아래(세로 비겹침)
      expect(p.y).toBeLessThanOrEqual(SUPPORT.bottom - AVATAR_H / 2); // 방 하단 안
      expect(p.x).toBeGreaterThanOrEqual(SUPPORT.left);
      expect(p.x).toBeLessThanOrEqual(SUPPORT.right);
    }
  });
  it("얕은 방(기획팀 콘텐츠): 아래로 못 내려가면 팀장 '옆' 한 줄 — 방 안 + 팀장 비겹침", () => {
    const anchor = { x: 71.86, y: 23.54 }; // content 팀장(fx0.28, fy0.62)
    const pts = clusterBelow(2, anchor.x, anchor.y, PLANNING.left, PLANNING.right, PLANNING.bottom);
    expect(pts).toHaveLength(2);
    for (const p of pts) {
      expect(p.y).toBeLessThanOrEqual(PLANNING.bottom - AVATAR_H / 2); // 방 하단 안(탕비실 이탈 금지)
      expect(p.y).toBeGreaterThanOrEqual(PLANNING.top);
      expect(p.x).toBeGreaterThanOrEqual(PLANNING.left);
      expect(p.x).toBeLessThanOrEqual(PLANNING.right);
      expect(Math.abs(p.x - anchor.x)).toBeGreaterThanOrEqual(AVATAR_W); // 팀장 위에 안 올라섬(몸폭 이상)
    }
    // 대열끼리도 서로 안 겹친다(몸폭 이상 간격)
    expect(Math.abs(pts[0].x - pts[1].x)).toBeGreaterThanOrEqual(AVATAR_W);
  });
  it("얕은 방 옆줄이 같은 방 타 팀 상주 좌석(avoid)을 1/3 이상 덮지 않는다", () => {
    const anchor = { x: 71.86, y: 23.54 };
    // 카드뉴스 팀장(90.36,23.54)·디자이너 좌석(94.8,24.56) — 실제 planning 방 공유 좌석.
    const avoid: Pt[] = [{ x: 90.36, y: 23.54 }, { x: 94.8, y: 24.56 }];
    const pts = clusterBelow(2, anchor.x, anchor.y, PLANNING.left, PLANNING.right, PLANNING.bottom, avoid);
    for (const p of pts) for (const q of avoid)
      expect(overlapFrac(p, q)).toBeLessThan(MAX_OVERLAP);
  });
  it("얕은 방(기획팀 카드뉴스, 우측 팀장): 1명이 방 안 왼쪽 옆자리로", () => {
    const anchor = { x: 90.36, y: 23.54 }; // cardnews 팀장(fx0.78, fy0.62)
    const pts = clusterBelow(1, anchor.x, anchor.y, PLANNING.left, PLANNING.right, PLANNING.bottom);
    expect(pts).toHaveLength(1);
    expect(pts[0].y).toBeLessThanOrEqual(PLANNING.bottom - AVATAR_H / 2);
    expect(pts[0].x).toBeGreaterThanOrEqual(PLANNING.left);
    expect(pts[0].x).toBeLessThanOrEqual(PLANNING.right);
    expect(Math.abs(pts[0].x - anchor.x)).toBeGreaterThanOrEqual(AVATAR_W);
  });
  it("깊은 방 다열(8명): 옆줄로 오분류하지 않고 행만 하단 클램프 — 전원 방 안", () => {
    const anchor = { x: 43.75, y: 38 };
    const pts = clusterBelow(8, anchor.x, anchor.y, SUPPORT.left, SUPPORT.right, SUPPORT.bottom);
    expect(pts).toHaveLength(8);
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(anchor.y + AVATAR_H);          // 여전히 '팀장 아래'
      expect(p.y).toBeLessThanOrEqual(SUPPORT.bottom - AVATAR_H / 2);   // 2행도 방 하단 안
      expect(p.x).toBeGreaterThanOrEqual(SUPPORT.left);
      expect(p.x).toBeLessThanOrEqual(SUPPORT.right);                   // 캔버스 밖(x>100) 이탈 금지
    }
  });
  it("zoneBottom 미지정 시 기존 동작(하위호환)", () => {
    const pts = clusterBelow(2, 43.75, 38, SUPPORT.left, SUPPORT.right);
    for (const p of pts) expect(p.y).toBeCloseTo(38 + 11, 5);
  });
});

describe("meetingCircle — 토론 상석이 방 상단(스카이라인·옆방)으로 나가지 않는다", () => {
  it("얕은 방(기획팀 콘텐츠, n=2): 상석이 방 안으로 클램프", () => {
    const cy = PLANNING.top + 17 * 0.55; // 22.35
    const { head, members } = meetingCircle(2, 80.25, cy, 37, 17, PLANNING.top);
    expect(head.y).toBeGreaterThanOrEqual(PLANNING.top + AVATAR_H / 2); // 방 상단 안
    expect(head.y).toBeLessThan(cy); // 여전히 '상석'(테이블 위쪽)
    // 클램프로 상석이 12시 갭 안까지 내려와도 갭 가장자리(±60°) 팀원과 몸폭 이상 벌어진다
    for (const m of members) expect(Math.abs(m.x - head.x)).toBeGreaterThanOrEqual(AVATAR_W);
  });
  it("경영관리팀(n=4): 상석이 자기 방 안(위층 회의실 침범 금지)", () => {
    const cy = SUPPORT.top + 25 * 0.55; // 47.25
    const { head } = meetingCircle(4, 43.75, cy, 35.5, 25, SUPPORT.top);
    expect(head.y).toBeGreaterThanOrEqual(SUPPORT.top + AVATAR_H / 2);
    expect(head.y).toBeLessThan(cy);
  });
  it("zoneTop 미지정 시 기존 동작(하위호환)", () => {
    const { head } = meetingCircle(3, 50, 50);
    expect(head.y).toBeCloseTo(50 - (6.5 + 3 * 0.5) - 10, 5);
  });
  it("VGAP 는 아바타 높이보다 크다(행간 비겹침 전제)", () => {
    expect(VGAP).toBeGreaterThan(AVATAR_H);
  });
});

// (구) corridorPath(4-lane 사다리) 테스트는 참고 엔진 이식(officeNav.ts)으로 대체 —
// '가구 위를 지나가지 않는 이동' 보장은 officeNav.test.ts(보행 격자 기반)가 검증한다.
