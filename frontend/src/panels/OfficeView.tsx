// OfficeView — a top-down 2D virtual office that renders the SAME event-folded
// uiState as AgentGraph, just as a stylized office instead of a node graph.
// No backend/reducer change: it's another renderer over `fold(events)`.
//
// Mapping (see docs/design-refs/office-view.md):
//   role(CEO/lead/member) -> a character at a desk in the CEO room / team zone
//   agent_spawned   -> character pops in
//   agent_thinking  -> 💭 + pulse ring, live streamed text in the speech bubble
//   debate_message  -> speech bubble with the latest line
//   debate round    -> a team's members gather at their meeting spot, then return
//   CEO integrating -> team leads walk up toward the CEO room
//   wiki_page_written -> book spines fill the 자료실 shelf
//   lesson_learned  -> trophies on the 교훈 shelf
//   status          -> avatar ring color (thinking/spoke/failed)
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store";
import { AgentNode } from "../events/types";
// Phases in which a member / a lead is actually "working" — SHARED with DashboardBar's
// WORKING counter (events/working.ts) so choreography and counter can't diverge.
import { LEAD_WORK_PHASES, MEMBER_WORK_PHASES } from "../events/working";
import { fetchCompany, CompanyInfo, RoleInfo } from "../api";
import { spriteFor, poseFor, TWO_POSE_CHARS } from "./officeSprites";
import { personLabel } from "./agentVisual";
import { clusterBelow, meetingCircle, CORRIDOR_SPOTS, Pt, AVATAR_W, HGAP,
  LOUNGE_SOFA_ZONE, PANTRY_ZONE, CONF_ZONE, READING_ZONE, WHITEBOARD_SPOT, placeInZone } from "./officeChoreography";
// 참고 엔진(AI_Contents_Office) 이식 — 복도 노드 그래프 + 바닥 보행 격자 + LOS string-pull.
import { routePath, randomNavPoint, WALK_SPEED_PX } from "./officeNav";

// Fixed 4:3 design canvas. Everything inside is laid out against this constant
// size (positions in %, furniture in px), then the whole floor is uniformly
// scaled with transform:scale() to fit the panel — so resizing the window
// shrinks/grows every element together and the office always stays 4:3.
const BASE_W = 1664; // .office-floor 폭(office_map.png 16:9 배경을 100%×100% 로 채움 → 화면 % == 이미지 %)
const BASE_H = 960;  // .office-floor 높이

// 오클루더 화분 — 참고 프로젝트 occluders.json(맵 동일). 아바타 발(baseY)보다 아래에 밑동이 있는 화분은
// 그 아바타 앞에 그려져 깊이감을 준다(painter's — z-index 를 baseY 로). 좌표는 맵 이미지 분수(=floor %).
const OCCLUDERS: { name: string; x: number; y: number; w: number; baseY: number }[] = [
  { name: "plant_0", x: 0.27, y: 0.398, w: 0.02, baseY: 0.434 },
  { name: "plant_2", x: 0.36, y: 0.566, w: 0.02, baseY: 0.593 },
  { name: "plant_3", x: 0.405, y: 0.566, w: 0.03, baseY: 0.593 },
  { name: "plant_4", x: 0.515, y: 0.566, w: 0.05, baseY: 0.593 },
  { name: "plant_5", x: 0.59, y: 0.566, w: 0.065, baseY: 0.593 },
  { name: "plant_6", x: 0.94, y: 0.575, w: 0.06, baseY: 0.646 },
  { name: "plant_10", x: 0.0, y: 0.903, w: 0.015, baseY: 1.0 },
];
const SECRETARIAT = "secretariat";

// office_map.png 의 8개 공간을 화면 %(=이미지 %, 배경이 floor 를 100%×100% 로 채우므로 1:1)로 고정.
// 좌표는 grid_overlay(5% 격자) 분석값 → 스크린샷 루프에서 그림과 대조해 미세 보정한다.
type Region = { x: number; y: number; w: number; h: number };
const ROOMS = {
  ceo:         { x: 1.5,  y: 2,    w: 18.5, h: 27 },   // 좌상: CEO실(개인 집무실 — 책상·책장·시티뷰)
  conf:        { x: 31,   y: 3,    w: 29,   h: 30 },   // 상중: 회의실(원형 회의 테이블 + 벽걸이 스크린)
  planning:    { x: 61.5, y: 13,   w: 37,   h: 17 },   // 우상: 기획팀 — 창측 데스크 '바닥 띠'(상단 창/스카이라인 제외 → 팀장이 허공에 안 뜸)
  secretariat: { x: 2,    y: 29,   w: 21,   h: 30 },   // 비서실 — CEO실 '앞' 리셉션 공간. 하단을 리셉션 데스크(SECRETARY_DESK y53)까지 — 활성 강조가 자비스를 담게(h15는 빈 상단만 비췄다)
  support:     { x: 26,   y: 33.5, w: 35.5, h: 25 },   // 정중앙: 경영관리팀(오픈플랜 데스크 포드)
  pantry:      { x: 62.5, y: 32,   w: 36,   h: 26 },   // 우중: 탕비실(커피 바 + 카페 테이블)
  lounge:      { x: 11,   y: 60,   w: 31,   h: 38 },   // 좌하: 휴게실(소파 라운지)
  reading:     { x: 61.5, y: 60,   w: 36.5, h: 38 },   // 우하: 휴식공간(서재 책장 + 안락의자)
} as const satisfies Record<string, Region>;

// 명단의 팀 id → 고정 방. planning→기획팀(우상), support→경영관리팀(정중앙), secretariat→비서실(좌중).
const TEAM_REGION: Record<string, Region> = {
  content: ROOMS.planning,
  research: ROOMS.support,
  secretariat: ROOMS.secretariat,
  cardnews: ROOMS.planning, // 카드뉴스팀 — 우측 상단 사무실(사용자 지정). 콘텐츠팀과 같은 방, 우측 구역 좌석.
  shorts: ROOMS.pantry,     // 숏폼팀 — 우중(탕비실 옆 카페 테이블 구역). 빈 방 중 우측 라인 유지.
};
const regionCx = (r: Region): number => r.x + r.w / 2;
// 팀장 자리 오버라이드(방 모양 보정) — 기획팀(planning)은 책상이 창측 '상단 띠'라 범용 앵커(상단 18%)가
// 책상 위에 올라선 것처럼 보인다(사용자 피드백). 책상 '앞' 바닥 좌측에 세운다.
const TEAM_LEAD_SPOT: Record<string, { fx: number; fy: number }> = {
  content: { fx: 0.28, fy: 0.62 },
  cardnews: { fx: 0.78, fy: 0.62 }, // 같은 방 우측 구역 — 콘텐츠팀(좌측 0.28/0.62)과 겹침 방지
  shorts: { fx: 0.32, fy: 0.60 },   // 탕비실 좌측 바닥(카페 바 앞)
};
// 팀별 멤버 좌석 오버라이드 — 기획팀 멤버(이미지 디자이너)는 팀장 우측 바닥(창측 데스크 앞).
const TEAM_MEMBER_SEATS: Record<string, Seat[]> = {
  content: [{ fx: 0.5, fy: 0.68, face: "down" }, { fx: 0.62, fy: 0.68, face: "down" }],
  cardnews: [{ fx: 0.9, fy: 0.68, face: "down" }],
  shorts: [{ fx: 0.58, fy: 0.66, face: "down" }], // 카페 테이블 쪽
};
const roomStyle = (r: Region) =>
  ({ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });
// 비서 — CEO실 앞 리셉션(소파+콘솔) 공간. 콘솔(소형 모니터) 앞 바닥에 발이 닿도록(시각상 발≈앵커+3.6).
const SECRETARY_DESK = { x: 17, y: 53 }; // 리셉션 데스크 의자 자리(스프라이트 착석 실측 보정)

// Desk seats within a team zone (fx: 0..1 across, fy: 0..1 down), chosen by team size
// so the big avatars never overlap each other and never cross the zone walls.
//  ≤3명: 하단 일렬.  4~7명: 9시(왼쪽)·3시(오른쪽) 기둥 + 하단(6시) 2.  8명(경영지원팀): 6시 3·9시 2·3시 3.
// 3시(오른쪽) 기둥을 최대 3자리까지 우선 확보(사용자 요청 "3시에 책상 3개"), 채움 순서는
// 하단 → 9시 → 3시 라서 6번째(index 5) 멤버가 3시 맨 위에 앉는다.
// face = 책상이 등지는 벽 방향(아바타는 그 반대편에 앉아 벽을 바라봄).
type Face = "up" | "down" | "left" | "right";
type Seat = { fx: number; fy: number; face: Face };
function seatsFor(n: number): Seat[] {
  // 사이드 좌석: 아바타는 벽쪽, 책상은 안쪽(센터)으로 — 책상을 180° 돌려 의자가 아바타를 향하게 한다.
  //  R = 오른쪽 벽 좌석 → 아바타 오른쪽, 책상 왼쪽(face "left" = rotate-90).
  //  L = 왼쪽 벽 좌석   → 아바타 왼쪽,   책상 오른쪽(face "right" = rotate+90).
  const R = (fy: number): Seat => ({ fx: 0.84, fy, face: "left" });   // 오른쪽 열(방 안쪽 — 데스크 위)
  // 왼쪽 열 — 예전엔 framer 가 translate 를 덮어써 ~31px 우측으로 밀리던 걸 fx 0.008 로 보정했으나,
  // Character 의 x/y(-50%) 합성 수정으로 그 밀림이 사라져 이제 정상값(0.16)을 쓴다(방 안쪽 열).
  const L = (fy: number): Seat => ({ fx: 0.16, fy, face: "right" }); // 왼쪽 열(방 안쪽)
  const B = (fx: number): Seat => ({ fx, fy: 0.74, face: "down" });  // 하단(앞) 행
  switch (n) {
    case 0: return [];
    case 1: return [{ fx: 0.50, fy: 0.75, face: "down" }];
    case 2: return [{ fx: 0.34, fy: 0.75, face: "down" }, { fx: 0.66, fy: 0.75, face: "down" }];
    case 3: return [{ fx: 0.26, fy: 0.75, face: "down" }, { fx: 0.50, fy: 0.75, face: "down" }, { fx: 0.74, fy: 0.75, face: "down" }];
    case 4: return [B(0.34), B(0.66), R(0.30), R(0.66)];
    case 5: return [B(0.34), B(0.66), L(0.46), R(0.30), R(0.66)];
    case 6: return [B(0.36), B(0.64), L(0.30), L(0.70), R(0.30), R(0.70)];
    case 7: return [B(0.40), B(0.60), L(0.24), L(0.50), L(0.76), R(0.30), R(0.70)];
    // 경영지원팀(멤버 8명): 6시 4 · 9시 2 · 3시 2 (사용자 요청).
    //  · 멤버 index 순: budget·ops·legal·m(전진영)·m2(하예림)·m5(김홍수)·m3(이윤아)·m4(권이담=7).
    //  · 마지막 좌석을 B(0.80)로 둬 권이담(index 7)이 6시 4번째 자리로 간다(3시→2).
    //  · 3시(R)는 9시(L)와 동일 fy(0.20·0.50)로 좌우 대칭. 3시 아래(fy0.50)와 6시 끝(B0.80)은
    //    세로 13%(≈125px) 떨어져 큰 아바타(104px)도 안 겹친다.
    case 8: return [B(0.20), B(0.40), B(0.60), L(0.20), L(0.50), R(0.20), R(0.50), B(0.80)];
    default: return [B(0.40), B(0.60), L(0.20), L(0.45), L(0.70), R(0.20), R(0.45), R(0.70)];
  }
}

// book-spine colors for the wall bookshelves
const SHELF = ["#e06c75", "#e5c07b", "#98c379", "#61afef", "#c678dd", "#56b6c2", "#d19a66"];

// CEO 집무 책상 — office_map.png 좌상 개인 집무실. 책상 앞 러그(바닥)에 서서 발이 바닥에 닿게(뒤 책장 벽 X).
const CEO_DESK = { x: regionCx(ROOMS.ceo), y: ROOMS.ceo.y + 18 };

const RING: Record<string, string> = {
  spawned: "#3a4252",
  thinking: "#58a6ff",
  spoke: "#3fb950",
  converged: "#3fb950",
  failed: "#f85149",
};


// Pick a character glyph from the role id / title keywords.
function glyphFor(level?: string, id = "", title = ""): string {
  if (level === "ceo") return "🧑‍💼";
  const k = (id + " " + title).toLowerCase();
  if (/(research_lead|디렉터)/.test(k)) return "🧭";
  if (/(trend|트렌드)/.test(k)) return "📈";
  if (/(seo|키워드)/.test(k)) return "🔑";
  if (/(reviewer|팩트|리뷰)/.test(k)) return "🔎";
  if (/(perf|성과|분석)/.test(k)) return "📊";
  if (/(발행|publish)/.test(k)) return "📮"; // content 규칙보다 먼저(content_mN id 가로채임 방지)
  if (/(content|작가|카피)/.test(k)) return "✍️";
  if (level === "lead") return "🧑‍💼";
  return "🧑‍💻";
}

// A short, readable status the office shows over each character (instead of long
// streamed text — the full content lives in the left "진행 중" timeline).
function statusText(a: AgentNode, running: boolean,
                    opts: { meeting?: boolean; integrating?: boolean } = {}): string {
  if (a.status === "failed") return "⚠ 오류";
  // Promote spawned→thinking only for REAL participants. A roster placeholder (an
  // employee not engaged in this run) must stay 대기 중 — otherwise idle members of
  // a not-yet-started / never-delegated team falsely show "💬 토론 중".
  const st = running && a.status === "spawned" && !a.placeholder ? "thinking" : a.status;
  if (st === "thinking") {
    if (opts.integrating) return "🧩 통합 중";
    if (opts.meeting) return "💬 토론 중";
    return "✍️ 작업 중";
  }
  if (st === "spoke" || st === "converged") return "☕ 휴식 중";
  return ""; // 대기 중 → no status bubble (keeps the idle office uncluttered)
}

interface Placed {
  agent: AgentNode;
  glyph: string;
  char: string | null; // 스프라이트 캐릭터(참고 아바타 세트). null=이모지 폴백.
  ring: string;
  deskX: number;   // % in container
  deskY: number;
  x: number;       // current target (desk or meeting)
  y: number;
  bubble: string;  // text to show in the speech bubble ("" = none)
  thinking: boolean;
  isCritic: boolean;
  badge: string;   // e.g. 📄 when a deliverable/synthesis is ready
  roomLabel: string;
  face: Face;      // which wall the desk backs onto (desk rotation)
  act?: string;    // ambient 활동(rest/chat/coffee/phone/stroll/huddle/shelf/board/return) — 활동별 제자리 모션용
}

// Layout the whole company into container-% coordinates.
function layout(
  agents: Record<string, AgentNode>,
  agentOrder: string[],
  teamOrder: string[],
  anyDeliverable: boolean,
  ceoIntegrating: boolean,
  synthesisReady: boolean,
  running: boolean,
  phases: Record<string, string>,
  engagedByTeam: Record<string, string[]>,
  soloAgentId: string | null,
): Placed[] {
  const live = agentOrder.map((id) => agents[id]).filter((a): a is AgentNode => !!a);
  // 직원 지명(단독) 런 — 이 직원만 자기 자리에서 작업 중(레벨 무관). phase/engaged 이벤트가 없으므로
  // 각 레벨 분기에서 명시적으로 '작업 중' 자세를 준다(synthesis_chunk 는 status 를 spawned 로 두지만
  // effStatus 가 running+non-placeholder 를 thinking 으로 승급하므로 raw status 게이트는 피한다).
  const isSolo = (a: AgentNode): boolean => running && !!soloAgentId && a.agent_id === soloAgentId;
  const ceo = live.find((a) => a.level === "ceo");
  const leads = live.filter((a) => a.level === "lead");
  const members = live.filter((a) => a.level === "member");
  const placed: Placed[] = [];

  // A member is "engaged" only if in their team's CURRENT delegation wave (reset on each
  // decompose) — NOT merely "ever spawned this run". On a resumed run the latter re-engages
  // every member from earlier (larger) waves and makes the whole office look busy.
  const isEngaged = (m: AgentNode) =>
    (engagedByTeam[m.team ?? ""] ?? []).includes(m.agent_id);

  const effStatus = (a: AgentNode) =>
    running && a.status === "spawned" && !a.placeholder ? "thinking" : a.status;

  // CEO integration is a CEO-SOLO beat: the CEO synthesizes the teams' already-submitted
  // deliverables alone. The leads have finished reporting (team phase → idle) and are NOT
  // gathered into a meeting — they read 휴식/대기 at their desks, matching the timeline.
  // (사용자 피드백: 통합 중 '팀간 회의' 연출이 타임라인(팀장 대기)과 어긋나 가짜로 보였다 → 제거.)

  // CEO stays at its OWN desk; leads come TO the CEO (briefing / reporting). The CEO
  // only "works" while actually delegating (분해 중) or integrating (통합 중) — the rest
  // of the run it WAITS for the teams, so it must read 대기 중 (no bubble), NOT 작업 중.
  // (The CEO's real status stays "spawned" the whole run since _delegate/_ceo_integrate
  //  don't emit agent_thinking, so we drive its state from the phase + integrate flag,
  //  deliberately ignoring the spawned→thinking promotion that effStatus applies.)
  if (ceo) {
    const ceoPhase = running ? phases["_ceo"] : undefined;
    const ceoSolo = isSolo(ceo);                  // 단축경로(CEO 단독 즉답) — 자리에서 작업, 회의 아님
    const ceoWorking = ceoSolo || ceoPhase === "delegate" || ceoPhase === "review" || ceoIntegrating;
    const bubble = ceoSolo ? "✍️ 작업 중"
      : ceoPhase === "delegate" ? "🧩 지침 수립 중"
      : ceoIntegrating ? "🧩 통합 중"            // 자기 자리에서 단독으로 팀 산출물 통합(팀장은 보고 끝나 대기)
      : ceoPhase === "review" ? "🔎 검토·확정 중"  // 자리에서 부서 산출물 검토·최종 확정
      : "";  // 그 외 = 대기 중 → 말풍선 없음
    placed.push({
      agent: ceo, glyph: glyphFor("ceo", ceo.agent_id, ceo.persona?.role), char: spriteFor(ceo.agent_id, "ceo", ceo.persona?.role),
      ring: ceoWorking ? RING.thinking : RING.spawned,
      deskX: CEO_DESK.x, deskY: CEO_DESK.y,
      x: CEO_DESK.x,   // 통합도 자기 자리에서 단독 수행 — 회의 테이블로 이동하지 않는다
      y: CEO_DESK.y,
      bubble,
      thinking: ceoWorking,
      isCritic: false, badge: synthesisReady ? "📄" : "", roomLabel: "", face: "up",
    });
  }

  // 각 팀은 office_map.png 의 고정 방(TEAM_REGION)에 배치된다 — 균등분할이 아니라 그림 속 실제
  // 방 사각형(x,y,w,h)을 그대로 zone 으로 쓴다. 팀장/팀원/회의 자리는 모두 그 방에서 파생.

  // Leads: at their team-zone desk by default. Choreography by phase:
  //  decompose → own desk (분해) · assign → own desk (배정) · debate → team table head
  //  (회의 주재) · report → own desk (검토) · integrate(ceoIntegrating) → 자기 자리 대기(CEO 단독 통합).
  leads.forEach((lead, j) => {
    const tid = lead.team ?? "";
    // 비서: 하단 팀존이 아니라 상단 비서실에 고정 — CEO 처럼 자리를 지킨다. 팀원이 없어 비서(팀장)가
    // 직접 작업하므로, 비서실 phase 가 'work' 인 동안(스트리밍 전 그라운딩 포함) 줄곧 '작업 중'으로 애니메이션.
    if (tid === SECRETARIAT) {
      const secPh = running ? phases[SECRETARIAT] : undefined;
      const atWork = isSolo(lead) || lead.status === "thinking" || secPh === "work";
      const done = lead.status === "spoke" && secPh !== "work";
      placed.push({
        agent: lead, glyph: glyphFor("lead", lead.agent_id, lead.persona?.role), char: spriteFor(lead.agent_id, "lead", lead.persona?.role),
        ring: atWork ? RING.thinking : (RING[lead.status] ?? RING.spawned),
        deskX: SECRETARY_DESK.x, deskY: SECRETARY_DESK.y,
        x: SECRETARY_DESK.x, y: SECRETARY_DESK.y,
        bubble: atWork ? "✍️ 작업 중" : done ? "☕ 작업 완료" : "",
        thinking: atWork,  // 작업 phase 동안 잔걸음 애니메이션(스트리밍 전 그라운딩 포함)
        isCritic: false, badge: anyDeliverable ? "📄" : "", roomLabel: "", face: "up",
      });
      return;
    }
    const reg = TEAM_REGION[tid] ?? ROOMS.support;
    const zx = reg.x, zw = reg.w, zoneTop = reg.y, zoneH = reg.h;
    const spot = TEAM_LEAD_SPOT[tid];              // 방 모양 보정(기획팀: 책상 '앞' 바닥 — 책상 위 X)
    const deskX = zx + zw * (spot?.fx ?? 0.5);
    const deskY = zoneTop + zoneH * (spot?.fy ?? 0.18); // 기본: 방 상단(데스크 열 머리쪽)
    const cx = zx + zw / 2;
    const cy = zoneTop + zoneH * 0.55;
    const ph = running ? phases[tid] : undefined;
    const teamN = members.filter((m) => (m.team ?? "") === tid).length;
    // 토론 원은 '이번 웨이브에 선발된' 팀원 수로 그린다(멤버 배치와 동일 n) — 상석 반경이
    // 로스터 전원(teamN) 기준이면 팀원 원과 다른 크기로 계산돼 간격이 어긋난다.
    const engagedN = (engagedByTeam[tid] ?? []).length;
    let seat: { x: number; y: number };
    let bubble: string;
    let act: string | undefined;
    if (ph === "assign") {
      seat = { x: deskX, y: deskY };               // 자기 자리에서 팀원에게 과제 배정
      bubble = "📌 과제 배정 중";
    } else if (ph === "work") {
      seat = { x: deskX, y: deskY };
      // 팀원 작업 구간의 팀장은 대개 대기(말풍선 없음)지만, 팀장이 직접 스트리밍하는 경로
      // (standby 기획: cardnews_planner·shorts_writer, 팀원 0명 팀)에선 '작업 중'을 표시한다
      // — 링·💭 만 켜지고 텍스트가 없던 반쪽 연출 보완(칩 집계 working.ts:lead 와 일치).
      bubble = lead.status === "thinking" ? "✍️ 작업 중" : "";
    } else if (ph === "debate") {
      // 상석은 방 상단 클램프(zoneTop) — 얕은 기획팀 방에서 스카이라인 허공(y≈4.9)에 뜨던 것 교정.
      seat = meetingCircle(engagedN > 0 ? engagedN : teamN, cx, cy, zw, zoneH, zoneTop).head;
      bubble = "💬 회의 주재";
      act = "huddle";                              // 주재는 '서서'(착석 폴백 방지 — poseFor: chat→stand)
    } else if (ph === "decompose") {
      seat = { x: deskX, y: deskY };
      bubble = "🧩 분해 중";
    } else if (ph === "report") {
      seat = { x: deskX, y: deskY };               // 팀원 보고를 받으며 검토·취합
      bubble = "🔍 검토 중";
    } else {
      seat = { x: deskX, y: deskY };
      bubble = statusText(lead, running);
    }
    // 단독 런의 지명 팀장 — 자기 자리에서 '작업 중'(phase/스트리밍 신호 없이도).
    if (isSolo(lead)) { seat = { x: deskX, y: deskY }; bubble = "✍️ 작업 중"; }
    // working(링 색·펄스) 게이트는 events/working.ts isWorkingNow의 팀장 분기와 1:1.
    // 팀장 분해는 microCall이라 status가 'spawned'에 머무니 effStatus 승격이 아니라
    // raw lead.status==='thinking'(실제 스트리밍, 즉 report 종합 등)만 working으로 본다.
    // → 팀원 'work' 구간(LEAD_WORK_PHASES에서 'work' 제외)에는 팀장이 idle 링으로 대기.
    const working = isSolo(lead) || lead.status === "thinking" || LEAD_WORK_PHASES.has(ph ?? "");
    // 대기 링 색은 effStatus 승격값이 아니라 raw lead.status로 — micro로 spawned에
    // 머문 팀장이 work 구간에 파란(thinking) 링으로 잘못 빛나지 않고 idle 색으로 앉아있게.
    const restRing = RING[lead.status] ?? RING.spawned;
    placed.push({
      agent: lead, glyph: glyphFor("lead", lead.agent_id, lead.persona?.role), char: spriteFor(lead.agent_id, "lead", lead.persona?.role),
      ring: working ? RING.thinking : restRing,
      deskX, deskY,
      x: seat.x,
      y: seat.y,
      bubble,
      thinking: working,
      isCritic: !!lead.persona?.is_critic,
      badge: anyDeliverable ? "📄" : "", roomLabel: "", face: "up", act,
    });
  });

  // Members: a row near the bottom of their team zone; gather at a meeting circle
  // (zone center) ONLY when 2+ members are working at the same time (a real
  // discussion). A lone worker stays at their own desk and reads "✍️ 작업 중" —
  // otherwise a single working member always tripped "💬 토론 중" (the meeting flag
  // counted the member itself, so the 작업 중 branch was unreachable).
  const byTeam: Record<string, AgentNode[]> = {};
  for (const m of members) (byTeam[m.team ?? ""] ??= []).push(m);

  for (const tid of Object.keys(byTeam)) {
    if (tid === SECRETARIAT) continue; // 비서실은 하단 팀존 없음(상단 배치)
    const list = byTeam[tid];
    const reg = TEAM_REGION[tid] ?? ROOMS.support;
    const zx = reg.x, zw = reg.w, zoneTop = reg.y, zoneH = reg.h;
    const cx = zx + zw / 2;
    const cy = zoneTop + zoneH * 0.55;
    const ph = running ? phases[tid] : undefined;
    const lspot = TEAM_LEAD_SPOT[tid];
    const leadDeskX = zx + zw * (lspot?.fx ?? 0.5), leadDeskY = zoneTop + zoneH * (lspot?.fy ?? 0.18);
    const n = list.length;
    const seats = TEAM_MEMBER_SEATS[tid] ?? seatsFor(n);
    // Only SPAWNED members (the ones the lead summoned this run) gather/debate; size
    // the cluster/ring to that count so the few who were called are spaced right.
    // Non-selected (placeholder) members stay idle → office life (handled by freeIds).
    const engagedCount = list.filter((m) => isEngaged(m)).length;
    const circle = meetingCircle(engagedCount, cx, cy, zw, zoneH);
    // 같은 방을 공유하는 타 팀(콘텐츠↔카드뉴스)의 상주 좌석 — 옆줄 집합이 그 위로 확장하지 않게.
    const avoidPts: Pt[] = [];
    for (const otherTid of Object.keys(TEAM_REGION)) {
      if (otherTid === tid || TEAM_REGION[otherTid] !== reg) continue;
      const os = TEAM_LEAD_SPOT[otherTid];
      avoidPts.push({ x: zx + zw * (os?.fx ?? 0.5), y: zoneTop + zoneH * (os?.fy ?? 0.18) });
      for (const s of TEAM_MEMBER_SEATS[otherTid] ?? []) avoidPts.push({ x: zx + zw * s.fx, y: zoneTop + zoneH * s.fy });
    }
    // 집합(지시/보고)은 방 하단(zoneBottom)까지 클램프 — 얕은 기획팀 방에서 '팀장 아래 +11'이
    // 방 밖(탕비실)으로 새던 것을 팀장 '옆' 한 줄로 교정한다(officeChoreography.clusterBelow).
    const gather = clusterBelow(engagedCount, leadDeskX, leadDeskY, zx, zx + zw, zoneTop + zoneH, avoidPts);
    const fallbackMeeting = list.filter((m) => effStatus(m) === "thinking").length >= 2;
    let ei = 0;  // stable index among engaged members → circle/gather slot
    list.forEach((m, i) => {
      // 인원수에 맞춘 좌석(하단 일렬 / 9시·3시 기둥 + 하단 중앙). 좌석표를 넘친 멤버(UI '팀원
      // 추가' 등)는 한 점(0.5,0.78) 적층 대신 방 하단에 HGAP 간격으로 왼쪽부터 줄세운다.
      const over = i - seats.length;
      const seat = seats[i] ?? {
        fx: Math.min(0.94, (AVATAR_W / 2 + 1 + over * HGAP) / zw), fy: 0.86, face: "down" as Face,
      };
      const deskX = zx + zw * seat.fx;
      const deskY = zoneTop + zoneH * seat.fy;
      const engaged = isEngaged(m);          // in this team's CURRENT delegation wave
      // A non-engaged member (idle, or STALE from a resumed run's earlier wave that died
      // mid-"thinking") reads as a plain idle avatar — never a leftover thinking ring/bubble.
      // 단독 런의 지명 팀원은 engaged 이벤트가 없어도 작업 중 — effStatus 승급으로 thinking 링.
      // standby 팀(카드뉴스/숏폼)의 렌더링(팀 phase=integrate) — 코드가 이미지·영상을 생성하는
      // 구간이라 스폰된 팀원을 작업 중으로 표시(working.ts와 1:1). 디자인 단계(LLM 스트리밍)는
      // 잡이 delegation 을 emit 해(cardnews/shorts, 2026-08-12) engaged+work 경로로 잡힌다.
      // solo 게이트: 단독 런은 isWorkingNow가 지명 직원 외 전원을 false로 보므로(조기 반환)
      // 여기도 억제해야 1:1이 유지된다(현재 emit 조합상 도달 불가 — 방어).
      const rendering = ph === "integrate" && !m.placeholder && !soloAgentId;
      // rendering 을 engaged 보다 먼저 — delegation 배선 후 렌더링(integrate) 구간의 디자이너는
      // engaged+spoke 라서 링이 완료색(초록)으로 떨어졌다. 💭·'렌더링 중'·WORKING 칩과 일치하게
      // 렌더링 중엔 thinking(파랑 펄스) 링을 유지한다.
      const st = rendering ? "thinking" : (isSolo(m) || engaged) ? effStatus(m) : "spawned";
      const slot = engaged ? ei++ : -1;
      const desk = { x: deskX, y: deskY };

      let pos: { x: number; y: number };
      let bubble: string;
      let thinking: boolean;
      let face: Face = seat.face;
      let act: string | undefined;
      // 집합(지시/보고)·토론의 thinking 은 하드코드 true 가 아니라 실제 상태(effStatus)로 —
      // report 구간 멤버는 이미 spoke(팀장이 종합 스트리밍 중)라, 하드코드하면 사무실엔 💭 N명
      // 인데 WORKING 칩은 팀장 1명뿐인 불일치가 매 런 보였다(working.ts 멤버 분기와 1:1 복원).
      // 말풍선(지시 받는 중/보고 중/토론 중)은 위치 설명이므로 유지한다.
      if (engaged && ph === "assign") {              // 팀장에게 와서 과제 지시 받음
        pos = gather[slot] ?? desk; bubble = "📋 지시 받는 중"; thinking = st === "thinking";
        act = "huddle";                              // 맨바닥 대열 — 서서 듣는다(착석 폴백 방지)
      } else if (engaged && ph === "report") {       // 팀장에게 와서 보고
        pos = gather[slot] ?? desk; bubble = "📋 보고 중"; thinking = st === "thinking";
        act = "huddle";
      } else if (engaged && ph === "debate") {       // 회의 테이블 둘레
        pos = circle.members[slot] ?? desk; bubble = "💬 토론 중"; thinking = st === "thinking";
        act = "work"; face = "down";                 // 테이블에 정면 착석(책상 좌석의 측면 face 상속 방지)
      } else if (engaged && ph === "work") {         // 자기 자리에서 작업 — isWorkingNow와 동일 기준(직렬 1명만 작업중)
        pos = desk;
        if (st === "spoke" || st === "converged") { bubble = "☕ 작업 완료"; thinking = false; }
        else if (st === "thinking") { bubble = "✍️ 작업 중"; thinking = true; }   // 실제 스트리밍 중
        else { bubble = "⏳ 대기"; thinking = false; }                            // 아직 차례 안 옴(직렬 대기/placeholder)
      } else if (engaged && ph === "decompose") {  // 팀장 분해 중 → 자기 자리에서 대기
        pos = desk; bubble = ""; thinking = false;
      } else if (rendering) {                        // 카드뉴스 🎨 / 숏폼 🎬 — 산출물 렌더링 중
        pos = desk; bubble = tid === "shorts" ? "🎬 렌더링 중" : "🎨 렌더링 중"; thinking = true;
      } else if (engaged && ph) {                    // idle 등 → 자기 자리
        pos = desk; bubble = statusText(m, running); thinking = st === "thinking";
      } else if (!engaged) {                         // 미선발(placeholder) → 자기 자리(free면 ambient가 덮음)
        pos = desk; bubble = ""; thinking = false;
      } else {                                       // 토론모드 / 런 전 fallback
        pos = fallbackMeeting ? (circle.members[slot] ?? desk) : desk;
        bubble = statusText(m, running, { meeting: fallbackMeeting });
        thinking = st === "thinking";
      }
      // 단독 런의 지명 팀원 — 위 분기(engaged/phase 기반)에 안 걸리므로 자기 자리 '작업 중'으로 덮는다.
      if (isSolo(m)) { pos = desk; bubble = "✍️ 작업 중"; thinking = true; }
      placed.push({
        agent: m, glyph: glyphFor("member", m.agent_id, m.persona?.role), char: spriteFor(m.agent_id, "member", m.persona?.role),
        ring: RING[st] ?? RING.spawned,
        deskX, deskY,
        x: pos.x, y: pos.y,
        bubble, thinking,
        isCritic: !!m.persona?.is_critic, badge: "", roomLabel: "", face, act,
      });
    });
  }

  return placed;
}

// 스프라이트 아바타 높이(floor 좌표 px) — 참고 SPRITE_H(맵높이의 0.13) 대응. 스프라이트 없으면 이모지 폴백.
const SPRITE_PX = 138;
function Sprite({ char, pose, flip, glyph, working }: {
  char: string | null; pose: string; flip: boolean; glyph: string; working: boolean;
}) {
  const [err, setErr] = useState(false);
  if (err || !char) {
    return <div className="office-portrait office-glyph" style={{ fontSize: 32, lineHeight: 1 }}>{glyph}</div>;
  }
  if (TWO_POSE_CHARS.has(char)) return <TwoPoseFigure char={char} pose={pose} working={working} />;
  return (
    <img
      className={`office-sprite${working ? " working" : ""}`}
      src={`/sprites/${char}_${pose}.png`}
      alt="" draggable={false}
      onError={() => setErr(true)}
      style={{ height: SPRITE_PX, width: "auto", transform: flip ? "scaleX(-1)" : undefined }}
    />
  );
}

// 2포즈 피규어(자비스·카드뉴스팀) — 9포즈 풀세트 없이 stand/sit_front 2장으로 모든 포즈를 접는다.
// 우선순위: ① 생성 스프라이트(/sprites/<char>_{stand,sit_front}.png — scripts/gen_*_sprite*.mjs,
// OPENAI_API_KEY 필요) ② 둘 다 없으면 '얼굴 + (자비스 한정) SVG 정장 몸통' 폴백.
function TwoPoseFigure({ char, pose, working }: { char: string; pose: string; working: boolean }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const want = pose === "sit_front" || pose === "sit_right" || pose === "lounge" ? "sit_front" : "stand";
  const cand = !failed[want] ? want : want !== "stand" && !failed.stand ? "stand" : null;
  if (cand) {
    return (
      <img
        className={`office-sprite${working ? " working" : ""}`}
        src={`/sprites/${char}_${cand}.png`}
        alt="" draggable={false}
        onError={() => setFailed((f) => ({ ...f, [cand]: true }))}
        style={{ height: SPRITE_PX, width: "auto" }}
      />
    );
  }
  // 신규 캐릭터 폴백: face 헤드샷 원형(정장 SVG 는 자비스 전용 복장이라 재사용하지 않음).
  if (char !== "jarvis") {
    return (
      <div className={`office-sprite${working ? " working" : ""}`} style={{ display: "flex", justifyContent: "center" }}>
        <img
          src={`/sprites/${char}_face.png`} alt="" draggable={false}
          style={{ height: 56, width: 56, borderRadius: "50%", objectFit: "cover",
                   border: "2px solid rgba(255,255,255,.7)", boxShadow: "0 2px 8px rgba(0,0,0,.25)" }}
        />
      </div>
    );
  }
  return (
      <div className={`office-sprite${working ? " working" : ""}`}
           style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <img
          src="/avatars/jarvis_face.png" alt="" draggable={false}
          style={{ height: 56, width: 56, borderRadius: "50%", objectFit: "cover", zIndex: 1,
                   border: "2px solid rgba(140,220,255,.85)", boxShadow: "0 0 10px rgba(80,180,255,.45)" }}
        />
        <svg width="76" height="94" viewBox="0 0 76 94" style={{ marginTop: -10 }} aria-hidden>
          {/* 팔(재킷 소매) — 몸통 옆으로 자연스럽게 내림 */}
          <path d="M16 18 L7 46 Q6 50 10 51 L16 52 Z" fill="#1d2432" stroke="#3f5170" strokeWidth="1.2" />
          <path d="M60 18 L69 46 Q70 50 66 51 L60 52 Z" fill="#1d2432" stroke="#3f5170" strokeWidth="1.2" />
          {/* 정장 상체(어깨→허리) */}
          <path d="M38 2 C48 4 56 9 61 17 L64 46 Q64 50 59 50 L17 50 Q12 50 12 46 L15 17 C20 9 28 4 38 2 Z"
                fill="#232b3a" stroke="#3f5170" strokeWidth="1.5" />
          {/* 셔츠 V + 코어 라이트 */}
          <path d="M38 4 L30 15 L38 28 L46 15 Z" fill="#0f1622" />
          <circle cx="38" cy="21" r="2.4" fill="#57c7ff" />
          {/* 바지(두 다리) */}
          <path d="M18 50 L21 85 Q21 88 24 88 L32 88 Q35 88 35 85 L36 54 L40 54 L41 85 Q41 88 44 88 L52 88 Q55 88 55 85 L58 50 Z"
                fill="#1a2130" stroke="#33415a" strokeWidth="1.2" />
          {/* 구두 */}
          <path d="M21 88 L21 90 Q21 93 25 93 L34 93 Q36 93 35 90 L35 88 Z" fill="#0c111b" />
          <path d="M41 88 L41 90 Q41 93 45 93 L54 93 Q56 93 55 90 L55 88 Z" fill="#0c111b" />
        </svg>
      </div>
  );
}

// ── rAF 보행 워커(참고 엔진 이식) — 모든 이동(연출·ambient)이 복도 경로(routePath)를 등속으로 걷는다.
// 위치는 리액트 상태가 아니라 워커(ref)+DOM style 로 매 프레임 갱신(60fps 리렌더 방지)하고,
// 포즈에 영향 주는 상태(walking/방향)가 바뀔 때만 Character 를 bump 해 리렌더한다.
export interface Walker {
  el: HTMLDivElement | null;
  x: number; y: number;          // 현재 위치(floor %)
  tx: number; ty: number;        // 목표(floor %)
  path: Pt[];                    // 남은 waypoint(마지막=목표)
  routeKey: string;              // 목표 변경 감지(참고 엔진 routeKey)
  walking: boolean; movingDown: boolean; faceLeft: boolean;
  settled: boolean;              // 도착 후 정지 — 산책 멈춤(2.5~6s)·복귀 해제 판단
  bump: () => void;
}
type Walkers = Map<string, Walker>;
const walkerKey = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;

function Character({ p, walkers }: { p: Placed; walkers: Walkers }) {
  const id = p.agent.agent_id;
  const [, bumpRender] = useReducer((n: number) => n + 1, 0);
  let w = walkers.get(id);
  if (!w) {                      // 최초 스폰: 자기 자리에서 시작(참고 엔진과 동일 — 걸어들어오지 않음)
    w = { el: null, x: p.x, y: p.y, tx: p.x, ty: p.y, path: [], routeKey: walkerKey(p.x, p.y),
          walking: false, movingDown: false, faceLeft: false, settled: true, bump: () => {} };
    walkers.set(id, w);
  }
  w.bump = bumpRender as unknown as () => void;
  w.tx = p.x; w.ty = p.y;        // 렌더마다 목표 갱신 — 엔진이 다음 프레임에 현재 위치에서 경로 재계산
  useEffect(() => () => { walkers.delete(id); }, [walkers, id]);
  const walking = w.walking;
  const [frame, setFrame] = useState<0 | 1>(0);
  useEffect(() => {                // 걷기 프레임 190ms 토글(참고 WALKMS) — walkR1↔R2 / walkF1↔F2
    if (!walking) return;
    const t = setInterval(() => setFrame((f) => (f ? 0 : 1)), 190);
    return () => clearInterval(t);
  }, [walking]);
  // 활동별 '제자리 움직임' — CSS 키프레임(.gait-*, index.css)이라 리렌더에도 연속 재생(리셋 튐 없음).
  // 유휴도 느린 호흡으로 살아있게(사용자 요청), 발 고정·상체만·작은 진폭. 이동 중엔 걸음 바운스.
  const actKind = walking ? "walk"
    : p.act === "rest" ? "rest"
    : p.act === "chat" || p.act === "huddle" ? "chat"
    : p.act === "coffee" ? "coffee"
    : p.act === "phone" ? "phone"
    // 자료 찾기(shelf)·화이트보드(board)는 '서서' 하는 활동 — work 로 접으면 poseFor 가
    // 착석(sit_front)을 반환해 보드 앞/책장 앞에 앉는 그림이 됐다(실측). chat(stand+상체 미동)로.
    : p.act === "shelf" || p.act === "board" ? "chat"
    : p.act === "work" ? "work"
    : p.thinking ? "work"
    : "idle";
  // 아바타별 위상 오프셋(음수 delay) — 전원이 같은 박자로 흔들리지 않게(참고 엔진 _ph 대응).
  let ph = 0;
  for (const c of id) ph = (ph * 31 + c.charCodeAt(0)) % 4096;
  // 상태·이동 → 스프라이트 포즈(sit/stand/walk) + 좌우반전(참고 엔진 이식). 방향은 워커(경로 구간)가 판정.
  const { pose, flip } = poseFor(actKind, walking, w.movingDown, frame, w.faceLeft, p.face);
  return (
    <motion.div
      ref={(el: HTMLDivElement | null) => { walkers.get(id)!.el = el; }}
      initial={{ opacity: 0, scale: 0.4, x: "-50%", y: "-50%" }}
      animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
      transition={{ opacity: { duration: 0.4 }, scale: { duration: 0.4 } }}
      // x/y(-50%) 를 framer transform 으로 줘 scale 과 합성 → (left,top)이 스택의 '정중앙'에 앵커된다.
      // left/top 은 rAF 보행 엔진이 매 프레임 직접 쓴다(framer 는 transform 만 관리 → 충돌 없음).
      style={{ position: "absolute", left: `${w.x}%`, top: `${w.y}%`,
               display: "flex", flexDirection: "column", alignItems: "center",
               zIndex: 10 + Math.round(w.y) }} // 깊이순 z(발 y%) — 오클루더 화분과 painter's 교차
    >
      <AnimatePresence>
        {/* 걷는 동안엔 '도착지 활동' 말풍선(📞 통화 중·🍵 커피 등)을 숨긴다 — 복도를 걸으며
            현재진행형 라벨이 뜨던 어긋남 교정. 산책(stroll)은 걷기 자체가 활동이라 유지. */}
        {p.bubble && (!walking || p.act === "stroll") && (
          <motion.div
            key="bubble"
            initial={{ opacity: 0, y: 6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className={`office-bubble status-chip${p.thinking ? " active" : " resting"}`}
          >
            {p.bubble}
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`office-gait gait-${actKind}`}
        style={{ position: "relative", animationDelay: `-${ph % 1700}ms` }}
      >
        <div className={`office-avatar${p.thinking ? " working" : ""}${walking ? " walking" : ""}`}>
          <Sprite char={p.char} pose={pose} flip={flip} glyph={p.glyph} working={p.thinking} />
          {p.thinking && <span className="office-think">💭</span>}
          {p.badge && <span className="office-badge">{p.badge}</span>}
        </div>
      </div>

      <div className="office-name">
        {/* 아바타는 '사람' → '실명 직책'(장은영 팀장). CEO는 'CEO'로 표시 */}
        {personLabel(p.agent.persona?.name, p.agent.persona?.role) || p.agent.agent_id}
      </div>
    </motion.div>
  );
}

export default function OfficeView() {
  const storeAgents = useStore((s) => s.agents);
  const storeOrder = useStore((s) => s.agentOrder);
  const storeTeamOrder = useStore((s) => s.teamOrder);
  const storeTeams = useStore((s) => s.teams);
  const blocks = useStore((s) => s.blocks);
  const messages = useStore((s) => s.messages);
  const wikiOrder = useStore((s) => s.wikiOrder);
  const wikiPages = useStore((s) => s.wikiPages);
  const lessons = useStore((s) => s.lessons);
  const status = useStore((s) => s.status);
  const synthesis = useStore((s) => s.synthesis);
  const phases = useStore((s) => s.phases);
  const engaged = useStore((s) => s.engaged);
  const soloAgentId = useStore((s) => s.soloAgentId);
  const pushActivity = useStore((s) => s.pushActivity);

  // The office is furnished AND staffed by DEFAULT from the company roster
  // (/company); live run events then overlay status onto the same employees. So
  // every employee + both team zones are present before any run (idle = 대기 중).
  const [roster, setRoster] = useState<CompanyInfo | null>(null);
  useEffect(() => {
    fetchCompany().then(setRoster);
  }, []);

  // ── rAF 보행 엔진(참고 엔진 frame 루프 이식) — 워커별로 목표 변경을 감지해 복도 경로를
  // 재계산하고, 등속(WALK_SPEED_PX)으로 waypoint 를 소비하며 DOM(left/top/z)을 직접 쓴다.
  // 리액트 리렌더는 포즈 상태(walking/방향) 변화 때만(bump) — 60fps 위치 갱신은 스타일만.
  const walkersRef = useRef<Walkers>(new Map());
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.1, (now - last) / 1000); // 탭 복귀 등 큰 공백은 클램프(순간이동 방지)
      last = now;
      if (document.hidden) return;                   // 숨김 중 연산 스킵(루프는 유지)
      for (const w of walkersRef.current.values()) {
        if (!w.el) continue;
        const key = walkerKey(w.tx, w.ty);
        if (w.routeKey !== key) {                    // 목표 변경 → 현재 위치에서 복도 경로 재계산
          w.routeKey = key;
          w.path = routePath({ x: w.x, y: w.y }, { x: w.tx, y: w.ty }).slice(1);
          w.settled = false;
        }
        let budget = WALK_SPEED_PX * dt;             // 등속 보행(px) — 가감속 없는 균일 걸음(참고 SPD)
        let dirX = 0, dirY = 0;                      // 마지막 진행 방향(px) — 포즈 판정
        while (budget > 0 && w.path.length) {
          const wp = w.path[0];
          const dx = ((wp.x - w.x) / 100) * BASE_W, dy = ((wp.y - w.y) / 100) * BASE_H;
          const d = Math.hypot(dx, dy);
          if (d <= budget) { w.x = wp.x; w.y = wp.y; w.path.shift(); budget -= d; }
          else { w.x += (dx / d) * budget * (100 / BASE_W); w.y += (dy / d) * budget * (100 / BASE_H); budget = 0; }
          if (d > 0.5) { dirX = dx; dirY = dy; }
        }
        const walking = w.path.length > 0;
        let movingDown = w.movingDown, faceLeft = w.faceLeft;
        if (dirX !== 0 || dirY !== 0) {
          movingDown = Math.abs(dirY) > Math.abs(dirX) && dirY > 0;  // 정면: '아래로(다가옴)'만
          if (!movingDown && Math.abs(dirX) > 1) faceLeft = dirX < 0; // 측면: 좌향은 반전(멈춰도 유지)
        }
        if (!walking) w.settled = true;              // 도착 — 산책 멈춤/복귀 해제는 ambient 틱이 판단
        w.el.style.left = `${w.x}%`;
        w.el.style.top = `${w.y}%`;
        w.el.style.zIndex = String(10 + Math.round(w.y));
        if (walking !== w.walking || movingDown !== w.movingDown || faceLeft !== w.faceLeft) {
          w.walking = walking; w.movingDown = movingDown; w.faceLeft = faceLeft;
          w.bump();                                  // 포즈 관련 상태 변화 → Character 리렌더
        }
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Scale the fixed 16:9 canvas to fit the panel — uniform shrink/grow of EVERY
  // element (rooms, desks, avatars, fonts) so the layout never distorts on resize.
  const rootRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // 모바일/태블릿(≤900px)에선 .office-root padding 이 8px(모바일 CSS)이라 pad 가 작다.
    const MOBILE_MQ = "(max-width: 900px)";
    const LEGIBLE = 0.42; // 폭맞춤 scale 이 이보다 작으면(아바타 < ~44px) 글자가 안 읽힌다.
    const compute = () => {
      const mobile = window.matchMedia(MOBILE_MQ).matches;
      const pad = mobile ? 16 : 36; // .office-root padding ×2 (모바일 8px·2, 데스크톱 18px·2)
      const availW = el.clientWidth - pad;
      const availH = el.clientHeight - pad;
      const fitW = availW / BASE_W, fitH = availH / BASE_H;
      // 모바일에서 폭맞춤이 너무 작아 글자가 안 읽히면(폰: fitW≈0.22) '높이맞춤'으로 키워 가독 확보 →
      // 가로가 뷰포트보다 넓어지면 좌우 패닝(.office-root overflow-x:auto + 음수마진 footprint 보정).
      // 폭맞춤이 충분하면(태블릿: fitW≈0.46) 그대로 전체 오피스 표시(패닝 불필요). 데스크톱은 기존 min().
      const s = mobile && fitW < LEGIBLE && fitH > fitW ? fitH : Math.min(fitW, fitH);
      setScale(s > 0 && Number.isFinite(s) ? s : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    // 회전·뷰포트 경계 변화 시 ResizeObserver 가 안정적으로 재발화하지 않을 수 있어 matchMedia 로 보강.
    const mq = window.matchMedia(MOBILE_MQ);
    mq.addEventListener("change", compute);
    return () => { ro.disconnect(); mq.removeEventListener("change", compute); };
  }, []);

  const { agents, agentOrder, teamOrder, teams } = useMemo(() => {
    const ag: Record<string, AgentNode> = {};
    const order: string[] = [];
    const tOrder: string[] = [];
    const tmap: Record<string, { id: string; name: string }> = {};
    const add = (r: RoleInfo) => {
      order.push(r.id);
      ag[r.id] = storeAgents[r.id] ?? {
        agent_id: r.id,
        persona: { role: r.title, name: r.name, scope: r.title, stance: r.stance, is_critic: r.is_critic },
        model: r.model, status: "spawned", placeholder: true,
        level: r.level as AgentNode["level"], team: r.team,
      };
    };
    if (roster) {
      add(roster.ceo);
      for (const t of roster.teams) {
        tOrder.push(t.id);
        tmap[t.id] = { id: t.id, name: t.name };
        add(t.lead);
        for (const m of t.members) add(m);
      }
    } else {
      for (const id of storeOrder) if (storeAgents[id]) { ag[id] = storeAgents[id]; order.push(id); }
      for (const id of storeTeamOrder) { tOrder.push(id); tmap[id] = storeTeams[id] ?? { id, name: id }; }
    }
    for (const id of storeOrder) if (!ag[id] && storeAgents[id]) { ag[id] = storeAgents[id]; order.push(id); }
    // 비서(자비스) — 로스터에 비서실(secretariat) 직원이 있으면 그 실제 노드를 쓰고, 없는(구 데이터)
    // 경우에만 합성 아바타를 추가한다 — 둘 다 리셉션 데스크에 배치돼 자비스가 2명 겹치던 중복 방지.
    const hasSecretary = Object.values(ag).some((a) => a?.team === SECRETARIAT);
    if (!hasSecretary && !ag["jarvis"]) {
      order.push("jarvis");
      ag["jarvis"] = {
        agent_id: "jarvis",
        persona: { role: "비서", name: "자비스", scope: "비서·어시스턴트", stance: "", is_critic: false },
        model: "", status: "spawned", placeholder: true,
        level: "lead", team: SECRETARIAT,
      };
    }
    return { agents: ag, agentOrder: order, teamOrder: tOrder, teams: tmap };
  }, [roster, storeAgents, storeOrder, storeTeamOrder, storeTeams]);

  // CEO is "integrating" once it streams the synthesis (block_id "ceo-synth") — drives the
  // CEO's own "🧩 통합 중" pose (layout) and the freeIds guard below, so it lives in its own
  // memo rather than inside placed(). (통합은 CEO 단독 작업 — 팀장은 모이지 않는다.)
  const ceoIntegrating = useMemo(() => {
    // Integration is an ACTIVE-run state. blocks["ceo-synth"] latches (the synthesis text
    // never clears once written), so without this running guard the CEO would stay frozen
    // in the "🧩 통합 중" pose forever AFTER the run finishes. A done run is idle.
    if (status !== "running") return false;
    // 직원 지명(단독) 런은 응답을 ceo-synth 블록으로 흘리지만 통합이 아니다 — 솔로면 팀간회의 억제.
    if (soloAgentId) return false;
    const ceo = agentOrder.map((id) => agents[id]).find((a) => a?.level === "ceo");
    // 'integrate' phase 도 통합으로 인정 — 합성 시작 직후 목차 microJSON 구간(ceo-synth 블록 생성 전)에
    // 타임라인은 '통합 중'인데 CEO 말풍선이 비어 보이는 '깜빡임'을 막는다(팀장은 더 이상 모으지 않음).
    return !!ceo && (ceo.status === "thinking" || !!blocks["ceo-synth"] || phases["_ceo"] === "integrate");
  }, [agents, agentOrder, blocks, status, phases, soloAgentId]);

  const placed = useMemo(() => {
    const running = status === "running";
    // team_deliverable folds to a move:"deliverable" message with no agent_id.
    const anyDeliverable = messages.some((m) => m.move === "deliverable");
    const synthesisReady = !!synthesis.trim();
    return layout(agents, agentOrder, teamOrder, anyDeliverable,
                  ceoIntegrating, synthesisReady, running, phases, engaged, soloAgentId);
  }, [agents, agentOrder, teamOrder, blocks, messages, status, synthesis, phases, engaged, ceoIntegrating, soloAgentId]);

  // Who is NOT engaged in the live choreography right now → free to live their office
  // life (휴식·잡담·다른 부서 방문). The CEO never wanders (it waits at its desk).
  // Engaged = the active team(s)' lead + members; AND during CEO integration the leads
  // stay put at their desks (보고 직후 대기), so they must not wander off either. Teams
  // run sequentially, so every other employee is free to socialize while one works.
  const freeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of agentOrder) {
      const a = agents[id];
      if (!a || a.level === "ceo") continue;              // CEO stays at its desk
      if (soloAgentId && a.agent_id === soloAgentId) continue; // 단독 런의 지명 직원은 자기 자리에서 작업(산책 X)
      if (a.team === SECRETARIAT) continue;               // 비서는 비서실 자리를 지킴(산책/잡담 X)
      if (ceoIntegrating && a.level === "lead") continue;  // 통합 중 팀장은 자기 자리에서 대기(산책 X)
      const p = a.team && status === "running" ? phases[a.team] : undefined;  // 이 팀의 현재 단계
      if (p && p !== "idle") {
        // 팀이 활성(phase 존재 && idle 아님)인 동안 그 팀의 팀장은 항상 자기 자리 유지 —
        // LEAD_WORK_PHASES에서 'work'를 뺐으므로(팀원 작업 구간엔 팀장이 working이 아님)
        // 여기서 명시적으로 free에서 제외해야 work 구간 팀장이 ambient(산책/잡담)로 안 떠돈다.
        // (working이 아니어도 '대기' 자세로 자리를 지킨다 — 말풍선·펄스는 layout이 끈다.)
        if (a.level === "lead" && !a.placeholder) continue;
        const memberEngaged = a.team ? (engaged[a.team] ?? []).includes(a.agent_id) : false;
        if (a.level === "member" && memberEngaged && MEMBER_WORK_PHASES.has(p)) continue;
        // standby 팀(카드뉴스/숏폼) 렌더링(integrate) — 위임 웨이브 없이 스폰된 팀원이 렌더링 중
        // (layout '렌더링 중' 버블과 1:1) → ambient 산책으로 떠돌지 않게 자리를 지킨다.
        if (a.level === "member" && p === "integrate" && !a.placeholder && !soloAgentId) continue;
      }
      ids.add(id);
    }
    return ids;
    // status 도 deps 에 — 위에서 status==='running' 을 읽으므로, 스트리밍 틈(직렬 대기·렌더링
    // 대기)에 취소돼 agents/phases 가 그대로면 재계산이 안 돼 활성 팀이 책상에 얼어붙었다.
  }, [agents, agentOrder, teamOrder, phases, engaged, ceoIntegrating, soloAgentId, status]);

  // Each avatar's home-desk position (+team) — lets ambient "deskside chat" send a
  // visitor to a colleague's actual seat. Recomputed from the same placed layout.
  const deskPos = useMemo(() => {
    const m: Record<string, { x: number; y: number; team: string | null }> = {};
    for (const p of placed) m[p.agent.agent_id] = { x: p.deskX, y: p.deskY, team: p.agent.team ?? null };
    return m;
  }, [placed]);

  // Ambient office life: employees NOT engaged in the live run drift off to a
  // believable office life — chat in the 회의실, rest in the 휴게실, or visit another
  // (idle) team's zone. Engaged employees (the active team) and the CEO never wander.
  // Gentle: ~one avatar moves per tick; spots are mutually non-overlapping so no two
  // socializing avatars ever collide. Runs livelier (idle depts mingle) than pre-run.
  // (x,y)=목적지 — 실제 위치·경로·보행은 rAF 워커 엔진이 맡는다(routePath 등속 보행).
  type WSpot = { x: number; y: number; bubble: string; act?: "chat" | "phone" | "rest" | "stroll" | "huddle" | "coffee" | "shelf" | "board" | "return"; partner?: string; pauseUntil?: number };
  const [wander, setWander] = useState<Record<string, WSpot>>({});
  // 비서(자비스)는 비서실 자리를 지켜 wander 풀에서 빠진다(산책·잡담 X). 대신 자기 자리에서 '데스크
  // 라이프'(메모·통화·문서·휴식)를 ~5초마다 바꿔 살아있게 한다 — 유휴일 때만 적용(작업 중엔 layout 의
  // '✍️ 작업 중'이 우선). 위치는 SECRETARY_DESK 고정, 동작·말풍선만 바뀐다.
  const [secLife, setSecLife] = useState<{ bubble: string; act: string }>({ bubble: "✍️ 메모 정리", act: "work" });
  useEffect(() => {
    const SEC_LIFE = [
      { bubble: "✍️ 메모 정리", act: "work" },
      { bubble: "🗓️ 일정 확인", act: "work" },
      { bubble: "📞 통화 중", act: "phone" },
      { bubble: "⌨️ 문서 작성", act: "work" },
      { bubble: "☕ 잠깐 한숨", act: "rest" },
    ];
    const tick = setInterval(() => {
      const pick = SEC_LIFE[Math.floor(Math.random() * SEC_LIFE.length)];
      if (pick) setSecLife(pick);
    }, 5000);
    return () => clearInterval(tick);
  }, []);
  // Latest values for the ambient interval — read via a ref so the interval is created
  // ONCE (deps []) and never torn down by frequent phase/agent updates (which would
  // reset the 3s timer and, at CHOREO_PAUSE_S=0, starve it entirely).
  const liveRef = useRef({ freeIds, phases, teamOrder, status, deskPos });
  liveRef.current = { freeIds, phases, teamOrder, status, deskPos };
  useEffect(() => {
    const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const tick = setInterval(() => {
      const { freeIds, phases, teamOrder, status, deskPos } = liveRef.current;
      const running = status === "running";
      setWander((prev) => {
        // 유휴 직원의 ambient 동선 — 모든 이동은 office_map.png 의 '빈 복도'(corridorPath)만 따라간다.
        // 가구(책상·소파·테이블·화분) 위로 대각선 횡단 금지. 도착지(가구 위)는 경로의 마지막 점.
        const next: Record<string, WSpot> = {};
        for (const k of Object.keys(prev)) if (freeIds.has(k)) next[k] = prev[k];
        // 짝(잡담/업무협의) 한쪽이 사라지면 남은 쪽도 해제(혼자 잡담 X)
        for (const k of Object.keys(next)) {
          const w = next[k];
          if ((w.act === "chat" || w.act === "huddle") && (!w.partner || !next[w.partner])) delete next[k];
        }

        // ── 도착 후 상태 전이(위치·보행은 rAF 엔진 소관) — 참고 엔진의 '도착 → 2.5~6초 멈춤 →
        //    다음 목적지' 산책 리듬 이식. 복귀(return)는 자리에 닿으면 wander 해제(자리 안착).
        for (const k of Object.keys(next)) {
          const w = next[k];
          const wk = walkersRef.current.get(k);
          if (!wk || !wk.settled) continue;                                // 아직 걷는 중
          if (w.act === "return") { delete next[k]; continue; }            // 복귀 완료 → 안착
          if (w.act === "stroll") {                                        // 산책: 잠시 서서 구경 후 다음 지점
            if (!w.pauseUntil) next[k] = { ...w, pauseUntil: Date.now() + 2500 + Math.random() * 3500 };
            else if (Date.now() > w.pauseUntil) {
              const np = randomNavPoint(Math.random);
              next[k] = { ...w, x: np.x, y: np.y, pauseUntil: undefined };
            }
          }
        }

        // 활동 시작/종료 — (x,y)는 목적지만. 출발 위치·복도 경로는 엔진이 현재 위치에서 계산한다.
        const startMove = (id: string, dest: Pt, bubble: string, act: WSpot["act"], partner?: string) => {
          next[id] = { x: dest.x, y: dest.y, bubble, act, partner };
        };
        const endMove = (id: string) => {
          const w = next[id]; if (!w || w.act === "return") return;
          const desk = deskPos[id] ?? { x: w.x, y: w.y };
          next[id] = { x: desk.x, y: desk.y, bubble: "", act: "return" };
        };

        const freeList = [...freeIds];
        const active = Object.keys(next);
        const target = Math.min(12, Math.max(running ? 3 : 1, Math.round(freeList.length * (running ? 0.55 : 0.35))));
        const rnd = () => Math.random();
        // 산포는 '도착지'끼리 1/3 미만 겹침 — WSpot 의 (x,y)가 곧 목적지. 상주 좌석(책상)도
        // 회피 목록에 — 탕비실 존 하한(y46)이 숏폼팀 좌석(y≈48)과 붙어 있어, 잡담·커피 목적지가
        // 착석 중인 숏폼팀 위(최대 ~85% 겹침)로 떨어지던 것을 막는다.
        const destOf = (w: WSpot): Pt => ({ x: w.x, y: w.y });
        const deskPts: Pt[] = Object.values(deskPos).map((d) => ({ x: d.x, y: d.y }));
        const exDest = (): Pt[] => [...Object.values(next).map(destOf), ...deskPts];
        const usedDest = (): Set<string> => new Set(Object.values(next).map((w) => key(destOf(w))));

        if (active.length < target) {                    // 활동 하나 더 시작(자기 자리 직원이 출발)
          const atDesk = freeList.filter((k) => !next[k]);
          const r = Math.random();
          if (r < 0.20 && atDesk.length >= 2) {                       // 잡담 — 탕비실
            const a = pick(atDesk), b = pick(atDesk.filter((k) => k !== a));
            const ex = exDest();
            const pa = placeInZone(PANTRY_ZONE, ex, rnd), pb = placeInZone(PANTRY_ZONE, [...ex, pa], rnd);
            startMove(a, pa, "💬 잡담", "chat", b); startMove(b, pb, "💬 잡담", "chat", a);
          } else if (r < 0.35 && atDesk.length >= 2) {                // 업무협의 — 회의실
            const n = Math.min(atDesk.length, 2 + Math.floor(Math.random() * 3));
            const pool = [...atDesk], people: string[] = [];
            for (let i = 0; i < n && pool.length; i++) people.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
            const ex = exDest();
            people.forEach((p) => { const s = placeInZone(CONF_ZONE, ex, rnd); ex.push(s);
              startMove(p, s, "🤝 업무협의", "huddle", people.find((q) => q !== p)); });
          } else if (r < 0.50 && atDesk.length) {                     // 휴식 — 휴게실 소파
            startMove(pick(atDesk), placeInZone(LOUNGE_SOFA_ZONE, exDest(), rnd), "☕ 휴식", "rest");
          } else if (r < 0.65 && atDesk.length) {                     // 산책 — 개방 복도 노드 배회
            startMove(pick(atDesk), randomNavPoint(rnd), "🚶 산책", "stroll");
          } else if (r < 0.75 && atDesk.length) {                     // 통화 — 빈 복도 점
            const open = CORRIDOR_SPOTS.filter((s) => !usedDest().has(key(s)));
            if (open.length) startMove(pick(atDesk), pick(open), "📞 통화 중", "phone");
          } else if (r < 0.85 && atDesk.length) {                     // 커피·간식 — 탕비실
            startMove(pick(atDesk), placeInZone(PANTRY_ZONE, exDest(), rnd), "🍵 커피·간식", "coffee");
          } else if (r < 0.95 && atDesk.length) {                     // 자료 찾기 — 휴식공간 서재
            startMove(pick(atDesk), placeInZone(READING_ZONE, exDest(), rnd), "📚 자료 찾기", "shelf");
          } else if (atDesk.length) {                                  // 화이트보드 — 회의실 보드
            startMove(pick(atDesk), WHITEBOARD_SPOT, "✍️ 화이트보드", "board");
          }
        } else if (active.length && Math.random() < 0.3) {            // 활동 종료 → 복도로 책상 복귀
          const endable = active.filter((k) => next[k].act !== "return");
          if (endable.length) {
            const k = pick(endable), w = next[k];
            endMove(k);
            if ((w.act === "chat" || w.act === "huddle") && w.partner) endMove(w.partner);
          }
        }
        return next;
      });
    }, 3000);
    return () => clearInterval(tick);
  }, []);

  // Narrate ambient office-life into the 활동 피드 — but ONLY on the idle→activity
  // transition (the interval re-randomizes every 3s; logging each tick would flood the
  // feed with hundreds of 잡담 rows). We diff the new `wander` against the previous via
  // a ref. Live-only: ambient is random wall-clock animation, never replayed, so we
  // push to store.liveActivity and skip it entirely in replay mode.
  const prevWanderRef = useRef<Record<string, WSpot>>({});
  useEffect(() => {
    if (useStore.getState().mode !== "live") { prevWanderRef.current = wander; return; }
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
    const prev = prevWanderRef.current;
    for (const k of Object.keys(wander)) {
      const w = wander[k];
      if (!w.act) continue;
      // "Started" = a new activity OR (for 잡담) a re-pair to a different partner in the
      // same tick — without the partner check, a canonical-id chatter that swaps partners
      // mid-tick stays act:"chat" so neither side logs (drop-both). Cosmetic but cheap.
      const started =
        !prev[k] || prev[k].act !== w.act ||
        (w.act === "chat" && prev[k].partner !== w.partner);
      if (!started) continue;
      // A 잡담 adds both partners in the same tick — log it once (canonical = smaller id).
      if (w.act === "chat" && w.partner && k > w.partner) continue;
      const meta = AMB[w.act];
      if (!meta) continue;
      const ts = new Date().toISOString();
      pushActivity({
        id: `amb-${ts}-${k}`,
        ts,
        kind: meta.kind,
        label: meta.label,
        actorId: k,
        targetId: w.act === "chat" ? w.partner : undefined,
      });
    }
    prevWanderRef.current = wander;
  }, [wander, pushActivity]);

  // 방 영역 — 이름표(라벨)는 제거(사용자 요청). team 이 지정된 방은 그 팀이 작업 중(phase≠idle)일 때만
  // 은은히 강조해 '지금 어디가 바쁜지'만 보여준다(텍스트 없음).
  const ZONES: { key: keyof typeof ROOMS; team?: string }[] = [
    { key: "ceo" }, { key: "conf" }, { key: "planning", team: "content" },
    { key: "secretariat", team: "secretariat" }, { key: "support", team: "research" },
    { key: "pantry" }, { key: "lounge" }, { key: "reading" },
  ];

  return (
    <div className="office-root" ref={rootRef}>
      {/* --office-scale: 모바일 @media 가 말풍선·이름표를 역보정(scale 의 역수)해 ≥10px 가독 확보.
          데스크톱은 이 변수를 읽는 규칙이 없어 inert(>900px 무변경). */}
      <div className="office-floor"
        style={{ transform: `scale(${scale})`, ["--office-scale" as string]: scale }}>
        {/* 방 영역(투명 핫스팟) — 벽·가구는 office_map.png 가 그린다. 이름표 없이 '활성 강조'만 오버레이. */}
        {ZONES.map(({ key, team }) => {
          const active = !!team && status === "running" && !!phases[team] && phases[team] !== "idle";
          return (
            <div key={key} className={`office-zone${active ? " active" : ""}`} style={roomStyle(ROOMS[key])} />
          );
        })}

        {/* characters (resting ones wander to 회의실/휴게실/복도) */}
        {placed.map((p) => {
          // honor a wander spot only if the avatar is STILL free this render — re-engaged
          // ones (team handoff / CEO integration) snap to their choreography seat at once.
          const w = freeIds.has(p.agent.agent_id) ? wander[p.agent.agent_id] : undefined;
          // 비서가 유휴(작업 중 아님)면 데스크 라이프 적용 — 자리는 유지, 동작·말풍선만 살아있게.
          const sec = !w && p.agent.team === SECRETARIAT && !p.thinking ? secLife : undefined;
          return <Character key={p.agent.agent_id} walkers={walkersRef.current}
            p={w ? { ...p, x: w.x, y: w.y, bubble: w.bubble, thinking: false, act: w.act }
                 : sec ? { ...p, bubble: sec.bubble, act: sec.act } : p} />;
        })}
        {placed.length === 0 && (
          <div className="office-hint">주제를 입력하면 직원들이 사무실로 출근합니다 🏢</div>
        )}

        {/* 오클루더 화분 — 밑동(baseY)보다 발이 위인 아바타 앞에 그려져 깊이감(z=baseY%). 참고 프로젝트 assets. */}
        {OCCLUDERS.map((o) => (
          <img key={o.name} src={`/occluders/${o.name}.png`} alt="" draggable={false}
            className="office-occluder"
            style={{ position: "absolute", left: `${o.x * 100}%`, top: `${o.y * 100}%`,
                     width: `${o.w * 100}%`, zIndex: 10 + Math.round(o.baseY * 100), pointerEvents: "none" }} />
        ))}

        {/* 자료실 (wiki) shelf + 교훈 trophies */}
        <div className="office-archive">
          <div className="archive-head">
            <span>📚 자료실 · LLM 위키 ({wikiOrder.length})</span>
            <span className="archive-trophies">
              🏆 교훈 {lessons.length}
              {lessons.length > 0 && (
                <span className="trophy-row">{lessons.slice(-6).map((_, i) => <span key={i}>🏆</span>)}</span>
              )}
            </span>
          </div>
          {/* 색 범례 — 책등 막대는 '진행률'이 아니라 지식 1건(상태=색)임을 분명히 한다. */}
          <div className="archive-legend" title="막대 하나가 위키 지식 페이지 1건입니다 (색 = 상태)">
            <span><i className="lg-dot" style={{ background: "#58a6ff" }} />주장</span>
            <span><i className="lg-dot" style={{ background: "#3fb950" }} />합의</span>
            <span><i className="lg-dot" style={{ background: "#f85149" }} />대립</span>
            <span><i className="lg-dot" style={{ background: "#6e7681" }} />대체</span>
            <span><i className="lg-dot" style={{ background: "#d29922" }} />교훈</span>
            <span className="lg-note">· 막대 1개 = 지식 1건</span>
          </div>
          <div className="archive-shelf">
            <AnimatePresence>
              {wikiOrder.slice(-40).map((pid) => {
                const w = wikiPages[pid];
                if (!w) return null;
                const color =
                  w.status === "contested" ? "#f85149" :
                  w.status === "converged" ? "#3fb950" :
                  w.status === "superseded" ? "#6e7681" :
                  w.category === "lesson" ? "#d29922" : "#58a6ff";
                return (
                  <motion.div
                    key={pid}
                    initial={{ opacity: 0, scaleY: 0.2 }}
                    animate={{ opacity: 1, scaleY: 1 }}
                    className="book-spine"
                    style={{ background: color }}
                    title={`${w.title} · ${w.category}/${w.status}`}
                  />
                );
              })}
              {wikiOrder.length === 0 && <span className="muted" style={{ fontSize: 12 }}>아직 자료 없음</span>}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
