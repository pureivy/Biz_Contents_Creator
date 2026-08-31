import { describe, it, expect } from "vitest";
import {
  NAV_NODES, NAV_EDGES, walkableAt, lineWalkable, bfsPath, smoothPath, routePath, randomNavPoint,
} from "./officeNav";
import { CORRIDOR_SPOTS, Pt } from "./officeChoreography";

// 참고 엔진(AI_Contents_Office) 이식 검증 — 사용자 요청 "이동은 절대 가구 위를 지나가지 말 것"을
// 보행 격자(WG)로 보장한다: 경로의 중간 경유점·중간 구간은 전부 '열린 바닥' 위여야 한다.
// from/to(책상·소파 등 가구 위 도착지)는 예외 — 첫/마지막 hop 만 가구에 닿는다.

// 결정적 난수(LCG)
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

describe("복도 노드 그래프 — 데이터 무결성", () => {
  it("모든 노드는 보행 가능한 바닥 위", () => {
    for (const n of NAV_NODES) expect(walkableAt(n)).toBe(true);
  });
  it("그래프는 연결(BFS 로 0번에서 전 노드 도달)", () => {
    for (let i = 1; i < NAV_NODES.length; i++) {
      const p = bfsPath(0, i);
      expect(p[0]).toBe(0);
      expect(p[p.length - 1]).toBe(i);
      expect(p.length).toBeGreaterThan(1);
    }
  });
});

describe("routePath — 이동은 열린 바닥으로만(가구 통과 금지)", () => {
  // (from=책상/존, to=책상/존) — 도착지는 가구 위일 수 있으나 '사이 이동'은 바닥 위여야 함.
  const cases: Array<[string, Pt, Pt]> = [
    ["경영지원 포드→휴게실 소파", { x: 44, y: 45 }, { x: 26, y: 78 }],
    ["기획팀 데스크→탕비실",      { x: 80, y: 18 }, { x: 78, y: 42 }],
    ["경영지원 포드→회의실",      { x: 44, y: 45 }, { x: 45, y: 20 }],
    ["휴게실→탕비실(오피스 횡단)", { x: 26, y: 78 }, { x: 78, y: 42 }],
    ["기획팀→휴식공간 서재",      { x: 85, y: 16 }, { x: 80, y: 72 }],
    ["CEO앞 리셉션→회의실",       { x: 12, y: 40 }, { x: 45, y: 20 }],
  ];
  for (const [name, from, to] of cases) {
    it(`${name}: 끝점 보존 + 중간 경유점·구간 전부 바닥 위`, () => {
      const path = routePath(from, to);
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0]).toEqual(from);
      expect(path[path.length - 1]).toEqual(to);
      for (let i = 1; i < path.length - 1; i++) expect(walkableAt(path[i])).toBe(true);
      // 중간 구간(양끝이 모두 경유점)은 (a) string-pull 이 검증한 직선(전부 바닥) 또는
      // (b) 그래프 인접 엣지(바닥 마스크에서 생성된 신뢰 연결 — disc 0.6 침식 격자의 모서리는
      //     스칠 수 있으나 참고 엔진과 동일하게 아바타 반경 여유분 안이다) 둘 중 하나여야 한다.
      const nodeIdx = (q: Pt): number => NAV_NODES.findIndex((n) => n.x === q.x && n.y === q.y);
      for (let i = 1; i < path.length - 2; i++) {
        const a = nodeIdx(path[i]), b = nodeIdx(path[i + 1]);
        const adjacent = a >= 0 && b >= 0 && (NAV_EDGES[a] ?? []).includes(b);
        expect(adjacent || lineWalkable(path[i], path[i + 1])).toBe(true);
      }
    });
  }
  it("근거리(정규화 0.06 미만)는 직행", () => {
    expect(routePath({ x: 50, y: 50 }, { x: 52, y: 51 })).toEqual([{ x: 50, y: 50 }, { x: 52, y: 51 }]);
  });
});

describe("smoothPath — LOS string-pull", () => {
  it("끝점 보존 + 시야가 트인 waypoint 는 건너뛰어 직선화", () => {
    // 하단 가로 복도의 세 노드(서로 LOS) → 가운데가 생략된다
    const a = NAV_NODES[38], b = NAV_NODES[39], c = NAV_NODES[40]; // y=60% 라인 인접 노드들
    const out = smoothPath([a, b, c]);
    expect(out[0]).toEqual(a);
    expect(out[out.length - 1]).toEqual(c);
    if (lineWalkable(a, c)) expect(out).toEqual([a, c]);
  });
});

describe("산책·통화 목적지 — 전부 바닥 위", () => {
  it("randomNavPoint 는 항상 보행 가능 + 중앙 데스크 군집(x30–66·y<52) 밖", () => {
    const rng = lcg(11);
    for (let i = 0; i < 50; i++) {
      const p = randomNavPoint(rng);
      expect(walkableAt(p)).toBe(true);
      expect(p.x >= 30 && p.x <= 66 && p.y < 52).toBe(false);
    }
  });
  it("CORRIDOR_SPOTS(통화 지점)는 보행 격자 위", () => {
    for (const s of CORRIDOR_SPOTS) expect(walkableAt(s)).toBe(true);
  });
});
