# 오피스 라이프 공간 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오피스 뷰의 ambient(사회·휴식) 액션을 자연스러운 방(휴게실 소파존/탕비존·회의실 허들·복도·팀존 책장)으로 재배치하고, 신규 액션(업무협의·커피·간식·자료 찾기·화이트보드)을 추가한다.

**Architecture:** ambient는 `OfficeView`의 3초 `tick`이 free 직원을 임의로 골라 자세(`wander` state)를 주는 **순수 프론트 연출**이다. 장소 좌표는 `officeChoreography.ts`의 순수 헬퍼(테스트 가능)로 빼고, `tick`은 그 헬퍼를 써서 액션→장소를 가중 선택한다. 백엔드/이벤트/working·phase/리플레이는 일절 건드리지 않는다.

**Tech Stack:** React + TypeScript, zustand store, framer-motion(아바타 보간), vitest(단위 테스트), `frontend/src/index.css`(오피스 집기 CSS).

## Global Constraints

- 백엔드·이벤트 스트림·`events/working.ts`·phase 규칙 변경 금지(ambient는 순수 프론트 연출).
- 리플레이 동작 변경 금지(ambient는 live-only — `useStore.getState().mode !== "live"` 가드 유지).
- 새 방(별도 탕비실/옥상 등) 신설 금지 — 휴게실 1칸 내부 구획으로 해결.
- 비겹침 불변식: 두 아바타 center가 `Math.abs(dx) < AVATAR_W(≈6.25)` **그리고** `Math.abs(dy) < AVATAR_H(≈10.83)` 이면 겹침 → 동시 점유 가능한 spot은 이 박스 밖이어야 한다.
- 기존 게이트 유지: CEO·비서(secretariat)·활성 작업 팀 직원은 ambient로 떠돌지 않는다(`freeIds`).
- 좌표 단위는 모두 office-% (고정 BASE 캔버스 비율). 집기 JSX는 방 내부 상대 %, ambient spot은 절대 office-%.
- 완료 기준: `pnpm test` 전체 통과 + `cd frontend && pnpm exec tsc --noEmit` 통과.

---

## File Structure

- **`frontend/src/panels/officeChoreography.ts`** (수정) — ambient 장소의 순수 지오메트리 헬퍼 추가(소파존·탕비존·허들 좌석·화이트보드·책장). 순수 함수라 단위 테스트 대상.
- **`frontend/src/panels/officeChoreography.test.ts`** (신규) — 새 spot/좌석의 비겹침·개수 단위 테스트.
- **`frontend/src/panels/OfficeView.tsx`** (수정) — `WSpot.act` 유니온·`AMB` 라벨 확장(Task 2), ambient `tick` 액션 선택 재작성(Task 3), 휴게실/회의실 집기 JSX(Task 4).
- **`frontend/src/index.css`** (수정) — 탕비 카운터·화이트보드 집기 CSS(Task 4).

---

## Task 1: ambient 장소 지오메트리 헬퍼 (officeChoreography.ts) + 단위 테스트

**Files:**
- Modify: `frontend/src/panels/officeChoreography.ts` (export 추가; 기존 export·함수 유지)
- Test: `frontend/src/panels/officeChoreography.test.ts` (신규)

**Interfaces:**
- Consumes: 기존 `Pt`, `AVATAR_W`, `AVATAR_H` (이미 export됨).
- Produces (Task 3가 사용):
  - `LOUNGE_SOFA_SPOTS: Pt[]` — 휴게실 좌측 소파존 휴식 spot
  - `PANTRY_CHAT_PAIR: [Pt, Pt]` — 휴게실 우측 탕비존 잡담 페어
  - `PANTRY_COFFEE_SPOTS: Pt[]` — 탕비존 커피·간식 1인 spot
  - `WHITEBOARD_SPOT: Pt` — 회의실 화이트보드 앞
  - `huddleSeats(n: number): Pt[]` — 회의실 업무협의 좌석 n개(회의 테이블 둘레)
  - `shelfSpot(zone: { x: number; w: number }): Pt` — 팀존 상단 책장 앞 1석

- [ ] **Step 1: 실패하는 테스트 작성** — `frontend/src/panels/officeChoreography.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  LOUNGE_SOFA_SPOTS, PANTRY_CHAT_PAIR, PANTRY_COFFEE_SPOTS,
  WHITEBOARD_SPOT, huddleSeats, shelfSpot, AVATAR_W, AVATAR_H, Pt,
} from "./officeChoreography";

const overlaps = (a: Pt, b: Pt) =>
  Math.abs(a.x - b.x) < AVATAR_W && Math.abs(a.y - b.y) < AVATAR_H;
function assertNoOverlap(pts: Pt[]) {
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      expect(overlaps(pts[i], pts[j])).toBe(false);
}

describe("휴게실 ambient spots — 동시 점유 가능 spot 끼리 비겹침", () => {
  it("소파존(휴식)+탕비존(잡담 페어·커피) 전체 상호 비겹침", () => {
    assertNoOverlap([...LOUNGE_SOFA_SPOTS, ...PANTRY_CHAT_PAIR, ...PANTRY_COFFEE_SPOTS]);
  });
});

describe("회의실 — 업무협의 좌석 + 화이트보드", () => {
  it("huddleSeats(n) 은 n개 좌석", () => {
    expect(huddleSeats(2)).toHaveLength(2);
    expect(huddleSeats(3)).toHaveLength(3);
  });
  it("huddleSeats(2)·(3) 내부 비겹침", () => {
    assertNoOverlap(huddleSeats(2));
    assertNoOverlap(huddleSeats(3));
  });
  it("화이트보드는 허들 좌석과 비겹침", () => {
    assertNoOverlap([WHITEBOARD_SPOT, ...huddleSeats(3)]);
  });
});

describe("자료 찾기 — 팀존 책장 앞", () => {
  it("shelfSpot 은 팀존 중앙·상단(y=35)", () => {
    expect(shelfSpot({ x: 2, w: 48 })).toEqual({ x: 26, y: 35 });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec vitest run frontend/src/panels/officeChoreography.test.ts`
Expected: FAIL — `LOUNGE_SOFA_SPOTS`/`huddleSeats`/`shelfSpot` 등이 export 되지 않아 import 에러.

- [ ] **Step 3: 헬퍼 구현** — `officeChoreography.ts` 끝(기존 `confMeetingSeats` 아래)에 추가

```ts
// 휴게실(x69–98) 좌측 소파존 — 휴식 착석(소파 위). 절대 office-%.
export const LOUNGE_SOFA_SPOTS: Pt[] = [{ x: 73, y: 9 }, { x: 80, y: 9 }];
// 휴게실 우측 탕비존 — 잡담 페어(마주봄) + 커피·간식 1인.
export const PANTRY_CHAT_PAIR: [Pt, Pt] = [{ x: 87, y: 9 }, { x: 94, y: 9 }];
export const PANTRY_COFFEE_SPOTS: Pt[] = [{ x: 87, y: 21 }, { x: 94, y: 21 }];
// 회의실 좌측 벽 화이트보드 앞 — 메모 1인.
export const WHITEBOARD_SPOT: Pt = { x: 6, y: 9 };

// 회의실 업무협의(허들) — 회의 테이블(중심 16.5,16.5) 둘레 n인 좌석. 12시부터 균등.
const HUDDLE = { cx: 16.5, cy: 16.5, rx: 10, ry: 7 };
export function huddleSeats(n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    out.push({ x: HUDDLE.cx + Math.cos(ang) * HUDDLE.rx, y: HUDDLE.cy + Math.sin(ang) * HUDDLE.ry });
  }
  return out;
}

// 자료 찾기 — 팀존(상단 책장 벽) 앞 1석. 팀존 사각형에서 파생(매직넘버 금지).
export function shelfSpot(zone: { x: number; w: number }): Pt {
  return { x: zone.x + zone.w / 2, y: 35 };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec vitest run frontend/src/panels/officeChoreography.test.ts`
Expected: PASS (4 describe / 5 it 모두 통과). 만약 비겹침이 실패하면 해당 spot의 x/y를 7%(가로)·12%(세로) 간격 이상으로 조정 후 재실행.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/panels/officeChoreography.ts frontend/src/panels/officeChoreography.test.ts
git commit -m "feat(office): ambient 장소 지오메트리 헬퍼 추가(소파존·탕비존·허들·책장)"
```

---

## Task 2: WSpot 액션 유니온 + 활동 피드 라벨 확장 (OfficeView.tsx)

**Files:**
- Modify: `frontend/src/panels/OfficeView.tsx` (WSpot 타입 ≈line 622, AMB 맵 ≈line 761)

**Interfaces:**
- Consumes: 없음(타입·맵 확장만).
- Produces (Task 3가 사용): `WSpot.act` 가 `"huddle" | "coffee" | "shelf" | "board"` 를 허용; `AMB` 가 해당 act 라벨 보유.

- [ ] **Step 1: WSpot 유니온 확장** — 기존 줄

```ts
  type WSpot = { x: number; y: number; bubble: string; act?: "chat" | "phone" | "rest" | "stroll"; partner?: string; dir?: 1 | -1 };
```

를 아래로 교체:

```ts
  type WSpot = { x: number; y: number; bubble: string; act?: "chat" | "phone" | "rest" | "stroll" | "huddle" | "coffee" | "shelf" | "board"; partner?: string; dir?: 1 | -1 };
```

- [ ] **Step 2: AMB 라벨 맵 확장** — 기존 블록

```ts
    const AMB: Record<string, { kind: "chat" | "rest" | "stroll" | "phone"; label: string }> = {
      chat: { kind: "chat", label: "잡담" },
      rest: { kind: "rest", label: "휴식" },
      stroll: { kind: "stroll", label: "산책" },
      phone: { kind: "phone", label: "통화" },
    };
```

를 아래로 교체(신규 act는 가장 가까운 ambient ActivityKind에 매핑, 라벨만 구분):

```ts
    const AMB: Record<string, { kind: "chat" | "rest" | "stroll" | "phone"; label: string }> = {
      chat: { kind: "chat", label: "잡담" },
      rest: { kind: "rest", label: "휴식" },
      stroll: { kind: "stroll", label: "산책" },
      phone: { kind: "phone", label: "통화" },
      huddle: { kind: "chat", label: "업무협의" },
      coffee: { kind: "rest", label: "커피·간식" },
      shelf: { kind: "stroll", label: "자료 찾기" },
      board: { kind: "chat", label: "화이트보드" },
    };
```

- [ ] **Step 3: 타입체크**

Run: `cd frontend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0 (신규 act 값은 아직 미사용이지만 유니온·맵이 일관되어 통과).

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/panels/OfficeView.tsx
git commit -m "feat(office): ambient 액션 유니온·활동피드 라벨 확장(업무협의·커피·자료찾기·화이트보드)"
```

---

## Task 3: ambient tick 액션 선택 재작성 (OfficeView.tsx)

핵심 변경: 잡담을 책상·팀경계 → 탕비존으로, 휴식을 소파존으로, 신규 업무협의(회의실 허들)·커피·자료찾기·화이트보드 추가, 통화를 복도로 일원화.

**Files:**
- Modify: `frontend/src/panels/OfficeView.tsx`
  - import (≈line 25), teamZones 구조분해(≈line 640), restSpots 선언(≈line 641), cleanup 루프(≈line 649), 액션 선택 블록(≈line 670–742), end-one(≈line 743–746)

**Interfaces:**
- Consumes: Task 1의 `LOUNGE_SOFA_SPOTS`, `PANTRY_CHAT_PAIR`, `PANTRY_COFFEE_SPOTS`, `WHITEBOARD_SPOT`, `huddleSeats`, `shelfSpot`; Task 2의 확장된 `WSpot.act`. 기존 스코프 변수 `next`, `freeList`, `out`, `target`, `atDesk`, `used`, `occupied`, `key`, `pick`, `active`, `wgeom`, `deskPos`, `corridor`, `STROLL`.
- Produces: 없음(연출 로직).

- [ ] **Step 1: import 갱신** — 기존 줄

```ts
import { clusterBelow, meetingCircle, REST_SPOTS, CORRIDOR_SPOTS, STROLL, AVATAR_W, AVATAR_H, Pt } from "./officeChoreography";
```

를 아래로 교체(REST_SPOTS 제거, 신규 6개 추가):

```ts
import { clusterBelow, meetingCircle, CORRIDOR_SPOTS, STROLL, AVATAR_W, AVATAR_H, Pt,
  LOUNGE_SOFA_SPOTS, PANTRY_CHAT_PAIR, PANTRY_COFFEE_SPOTS, WHITEBOARD_SPOT, huddleSeats, shelfSpot } from "./officeChoreography";
```

- [ ] **Step 2: teamZones 구조분해에서 미사용 floorTeams 제거 + restSpots→sofaSpots** — 기존 두 줄

```ts
        const { ids: floorTeams, geom: wgeom } = teamZones(teamOrder);
        const restSpots: Pt[] = [...REST_SPOTS];     // 휴게실 휴식
```

을 아래로 교체(이후 잡담이 더는 floorTeams 경계 로직을 쓰지 않음):

```ts
        const { geom: wgeom } = teamZones(teamOrder);
        const sofaSpots: Pt[] = [...LOUNGE_SOFA_SPOTS];  // 휴게실 소파존 휴식
```

- [ ] **Step 3: cleanup 루프에 huddle 포함** — 기존 줄

```ts
          if (w.act === "chat" && (!w.partner || !next[w.partner])) delete next[k];
```

을 아래로 교체(허들도 대표 partner가 빠지면 해산):

```ts
          if ((w.act === "chat" || w.act === "huddle") && (!w.partner || !next[w.partner])) delete next[k];
```

- [ ] **Step 4: 액션 선택 블록 전체 교체** — 기존 `if (out.length < target) { ... } else if (out.length && Math.random() < 0.3) { ... }` 블록(잡담 deskside/boundary + 산책/휴식/통화 + end-one)을 아래로 교체

```ts
        if (out.length < target) {                  // start one more activity
          const atDesk = freeList.filter((k) => !next[k]);
          const used = occupied();
          const openSofa = sofaSpots.filter((s) => !used.has(key(s)));
          const openCoffee = [...PANTRY_COFFEE_SPOTS].filter((s) => !used.has(key(s)));
          const openCorridor = corridor.filter((s) => !used.has(key(s)));
          const chatFree = !used.has(key(PANTRY_CHAT_PAIR[0])) && !used.has(key(PANTRY_CHAT_PAIR[1]));
          const r = Math.random();
          if (r < 0.20 && atDesk.length >= 2 && chatFree) {        // 잡담 — 탕비존 페어
            const a = pick(atDesk);
            const b = pick(atDesk.filter((k) => k !== a));
            next[a] = { x: PANTRY_CHAT_PAIR[0].x, y: PANTRY_CHAT_PAIR[0].y, bubble: "💬 잡담", act: "chat", partner: b };
            next[b] = { x: PANTRY_CHAT_PAIR[1].x, y: PANTRY_CHAT_PAIR[1].y, bubble: "💬 잡담", act: "chat", partner: a };
          } else if (r < 0.35 && atDesk.length >= 2) {             // 업무협의 — 회의실 허들 2~3인
            const n = atDesk.length >= 3 && Math.random() < 0.6 ? 3 : 2;
            const seats = huddleSeats(n);
            if (seats.every((s) => !used.has(key(s)))) {
              const pool = [...atDesk];
              const people: string[] = [];
              for (let i = 0; i < n && pool.length; i++) {
                people.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
              }
              people.forEach((p, i) => {
                next[p] = { x: seats[i].x, y: seats[i].y, bubble: "🤝 업무협의", act: "huddle",
                  partner: people.find((q) => q !== p) };
              });
            }
          } else if (r < 0.50 && atDesk.length && openSofa.length) {  // 휴식 — 소파존
            const who = pick(atDesk); const s = pick(openSofa);
            next[who] = { x: s.x, y: s.y, bubble: "☕ 휴식", act: "rest" };
          } else if (r < 0.65 && atDesk.length) {                    // 산책 — 복도 왕복
            const who = pick(atDesk);
            const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
            const lane = STROLL.lanes[
              Object.values(next).filter((w) => w.act === "stroll").length % STROLL.lanes.length];
            next[who] = { x: dir > 0 ? STROLL.xMin : STROLL.xMax, y: STROLL.y + lane,
              bubble: "🚶 산책", act: "stroll", dir };
          } else if (r < 0.75 && atDesk.length && openCorridor.length) { // 통화 — 복도
            const who = pick(atDesk); const s = pick(openCorridor);
            next[who] = { x: s.x, y: s.y, bubble: "📞 통화 중", act: "phone" };
          } else if (r < 0.85 && atDesk.length && openCoffee.length) {   // 커피·간식 — 탕비존
            const who = pick(atDesk); const s = pick(openCoffee);
            next[who] = { x: s.x, y: s.y, bubble: "🍵 커피·간식", act: "coffee" };
          } else if (r < 0.95 && atDesk.length) {                        // 자료 찾기 — 팀존 책장(팀 idle)
            const cand = atDesk.filter((k) => {
              const t = deskPos[k]?.team; return !!t && !active.has(t) && !!wgeom[t];
            });
            if (cand.length) {
              const who = pick(cand);
              const s = shelfSpot(wgeom[deskPos[who]!.team!]);
              if (!used.has(key(s))) next[who] = { x: s.x, y: s.y, bubble: "📚 자료 찾기", act: "shelf" };
            }
          } else if (atDesk.length && !used.has(key(WHITEBOARD_SPOT))) {  // 화이트보드 — 회의실
            const who = pick(atDesk);
            next[who] = { x: WHITEBOARD_SPOT.x, y: WHITEBOARD_SPOT.y, bubble: "✍️ 화이트보드", act: "board" };
          }
        } else if (out.length && Math.random() < 0.3) { // end one (groups leave together)
          const k = pick(out); const w = next[k]; delete next[k];
          if ((w.act === "chat" || w.act === "huddle") && w.partner) delete next[w.partner];
        }
```

- [ ] **Step 5: 타입체크 + 전체 테스트**

Run: `cd frontend && pnpm exec tsc --noEmit -p tsconfig.json` → exit 0
Run: `cd /Users/sangbumnam/AI_Agents_git/gepa-ai-office && pnpm test` → 전체 통과(Task 1 비겹침 테스트 포함)
Expected: 둘 다 통과. `deskPos[k]?.team` 타입이 `string | undefined` 라 `!!t` 가드로 좁혀짐을 확인.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/panels/OfficeView.tsx
git commit -m "feat(office): ambient 액션을 방별로 재배치(잡담→탕비존·휴식→소파존·업무협의→회의실·통화→복도) + 커피·자료찾기·화이트보드 추가"
```

---

## Task 4: 휴게실 구획·회의실 화이트보드 집기 (OfficeView.tsx JSX + index.css)

ambient spot(절대 office-%)이 집기 위에 놓이도록 시각 집기를 맞춘다: 소파는 휴게실 좌측, 탕비 카운터는 우측, 화이트보드는 회의실 좌벽.

**Files:**
- Modify: `frontend/src/panels/OfficeView.tsx` (휴게실 JSX ≈line 826–837, 회의실 JSX ≈line 803–810)
- Modify: `frontend/src/index.css` (집기 클래스 추가)

**Interfaces:**
- Consumes: 없음(시각 집기). Task 3의 ambient spot 좌표와 시각적으로 정합.
- Produces: 없음.

- [ ] **Step 1: 휴게실 집기 좌→소파 / 우→탕비 카운터로 재배치** — 기존 휴게실 블록

```tsx
        {/* 휴게실·탕비실 — top-right. 소파=12시 벽, 책장=3시 벽, 싱크대=9시 벽(아래 floor 배치) */}
        <div className="office-room lounge" style={roomStyle(ROOMS.lounge)}>
          <span className="office-room-label">🛋️ 휴게실 · 탕비실</span>
          {/* 소파 2개 — 12시(상단) 벽에 나란히 */}
          <div className="office-sofa" style={{ left: "33%", top: "27%" }} />
          <div className="office-sofa" style={{ left: "69%", top: "27%" }} />
          {/* 커피 테이블 + 러그(소파 앞 가운데) */}
          <div className="room-rug oval green" style={{ left: "47%", top: "66%", width: "46%", height: "30%" }} />
          <span className="lounge-item" style={{ left: "47%", top: "66%" }}>☕</span>
          {/* 화분(하단 코너) */}
          <div className="office-plant" style={{ left: "16%", top: "88%" }} />
        </div>
```

를 아래로 교체(소파를 좌측으로 모으고, 우측에 탕비 카운터 신설):

```tsx
        {/* 휴게실·탕비실 — top-right. 좌=소파존(휴식), 우=탕비존(커피·간식·잡담) */}
        <div className="office-room lounge" style={roomStyle(ROOMS.lounge)}>
          <span className="office-room-label">🛋️ 휴게실 · 탕비실</span>
          {/* 소파존(좌측 절반) — 소파 2개 + 러그 */}
          <div className="office-sofa" style={{ left: "14%", top: "30%" }} />
          <div className="office-sofa" style={{ left: "38%", top: "30%" }} />
          <div className="room-rug oval green" style={{ left: "26%", top: "70%", width: "42%", height: "26%" }} />
          {/* 탕비존(우측 절반) — 커피·간식 카운터 */}
          <div className="pantry-counter" style={{ left: "74%", top: "20%" }} />
          <span className="lounge-item" style={{ left: "74%", top: "20%" }}>☕</span>
          <span className="lounge-item" style={{ left: "88%", top: "20%" }}>🍪</span>
          {/* 화분(하단 코너) */}
          <div className="office-plant" style={{ left: "16%", top: "90%" }} />
        </div>
```

- [ ] **Step 2: 회의실에 화이트보드 추가** — 기존 회의실 블록

```tsx
        {/* 회의실 (conference room) — top-left */}
        <div className="office-room meeting-room" style={roomStyle(ROOMS.conf)}>
          <span className="office-room-label">🗣️ 회의실</span>
          <div className="room-rug oval blue" style={{ left: "50%", top: "58%", width: "82%", height: "66%" }} />
          <div className="conf-table">
            <span className="conf-chairs" />
          </div>
        </div>
```

를 아래로 교체(좌벽 화이트보드 + 라벨 보강):

```tsx
        {/* 회의실 (conference room) — top-left. 업무협의(허들)·화이트보드 메모 */}
        <div className="office-room meeting-room" style={roomStyle(ROOMS.conf)}>
          <span className="office-room-label">🗣️ 회의실 · 업무협의</span>
          <div className="room-rug oval blue" style={{ left: "50%", top: "58%", width: "82%", height: "66%" }} />
          <div className="whiteboard" style={{ left: "14%", top: "20%" }} />
          <div className="conf-table">
            <span className="conf-chairs" />
          </div>
        </div>
```

- [ ] **Step 3: 집기 CSS 추가** — `frontend/src/index.css` 의 `.office-sofa` 규칙 근처에 추가(기존 패턴 따름; 값은 시각 확인 후 미세조정)

```css
/* 탕비존 카운터 — 휴게실 우측 벽 앞 (싱크/커피머신 느낌) */
.pantry-counter {
  position: absolute;
  width: 22%;
  height: 12%;
  transform: translate(-50%, -50%);
  background: #2b3140;
  border: 1px solid #3a4252;
  border-radius: 4px;
}
/* 회의실 화이트보드 — 좌측 벽 */
.whiteboard {
  position: absolute;
  width: 16%;
  height: 22%;
  transform: translate(-50%, -50%);
  background: #f4f6fb;
  border: 2px solid #cfd6e4;
  border-radius: 3px;
}
```

- [ ] **Step 4: 타입체크 + 시각 확인**

Run: `cd frontend && pnpm exec tsc --noEmit -p tsconfig.json` → exit 0
시각 확인: 앱을 띄워(`pnpm dev` → http://localhost:8787) 런을 한 번 돌리고 유휴 구간에서 관찰 —
  - 휴식 아바타가 **좌측 소파**에, 잡담/커피 아바타가 **우측 탕비 카운터**에 위치
  - 업무협의 아바타가 **회의실 테이블**에 2~3인 모임, 화이트보드 메모는 좌벽
  - 통화·산책은 복도, 자료 찾기는 팀존 상단(책장)
  - 두 아바타가 겹치는 곳이 없음(겹치면 Task 1 spot 좌표 또는 본 집기 left/top을 조정해 정합)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/panels/OfficeView.tsx frontend/src/index.css
git commit -m "feat(office): 휴게실 소파존/탕비존 구획 + 회의실 화이트보드 집기"
```

---

## Self-Review (작성자 점검 결과)

**1. 스펙 커버리지:** §3 방 역할(회의실 허들·휴게실 구획) → Task 4/3. §4 액션 매핑 8종 → Task 3 가중 분기 + Task 1 좌표. §5 지오메트리 → Task 1. §6 tick 로직·가중치·그룹 해산 → Task 3. §7 활동피드 라벨 → Task 2. §8 집기/CSS → Task 4. §10 수용기준 1~5 → Task 3/4 시각 확인 + Task 1 비겹침 테스트, 기준 6 → 각 Task의 tsc/pnpm test. §9 비목표 → Global Constraints. 누락 없음.

**2. 플레이스홀더 스캔:** 모든 코드 스텝에 실제 코드 포함. "값은 시각 확인 후 미세조정"은 좌표 튜닝 안내(플레이스홀더 아님) — 시작값은 모두 구체.

**3. 타입 일관성:** `huddleSeats`/`shelfSpot`/`LOUNGE_SOFA_SPOTS` 등 Task 1 시그니처가 Task 3 사용처와 일치. `WSpot.act` 신규 값(huddle/coffee/shelf/board)이 Task 2 유니온·`AMB` 와 Task 3 사용처에서 동일. `wgeom` 타입 `Record<string,{x,w}>` 이 `shelfSpot` 인자 `{x,w}` 와 일치.

**주의(구현 시):** Task 3·4의 좌표 정합은 자동 테스트로 100% 검증 불가(React 타이머·시각) → Task 1 비겹침 단위 테스트 + Task 4 수동 시각 확인의 2단으로 닫는다. 비겹침 실패 시 spot 좌표를 가로 7%·세로 12% 간격 이상으로 조정.
