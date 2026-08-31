// Stable per-agent color + glyph so each name is visually distinct across the
// timeline, the 활동 피드, and the office. Shared (was inline in App.tsx) so every
// renderer maps the same agent_id → the same color/glyph.

export const AGENT_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#ff7b72", "#bc8cff", "#39c5cf", "#f0883e", "#e3b341",
];

export function agentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

// 사무실 아바타·티커 표시명 — '실명 직책'(예: 장은영 팀장, 박용식 과장). 직책은
// 직무(persona.role, 예 '전략기획팀 전략설계 과장')의 말미 직급어에서 추출. 담당자
// 실명이 없으면(공석) 직무로 폴백. CEO는 'CEO'로 표시.
export function personLabel(name?: string, role?: string): string {
  // CEO는 아바타에 'CEO'로 표시(과거 '경영기획실장' 직책의 리플레이 런도 포함해 호환).
  if (role === "CEO" || role === "ceo" || role === "경영기획실장" || name === "경영기획실장") {
    return "CEO";
  }
  if (name) {
    // 직급어는 직무 말미. 뒤에 괄호 보충(예 '…지출 과장(강소기업지원실·지역산업단)')이 와도
    // 직급을 잡도록 임의 괄호 접미를 허용 — 숫자만 허용하던 (\(\d+\)) 로는 누락됐음.
    const m = (role || "").match(/(팀장|과장|차장|대리|주임|실장)(?:\s*\([^)]*\))?$/);
    return m ? `${name} ${m[1]}` : name;
  }
  return role || "";
}

// 표시명 해석 — 실명직책(장은영 팀장) 우선. persona.name 이 비어 있어도(name 미주입 런·
// 과거 런 리플레이) 로스터 맵(names: id→실명직책)으로 폴백하고, 그것도 없을 때만 직무로.
// 핵심: personLabel(name,role)은 name 이 없으면 role(직무)을 truthy로 반환하므로, name 부재
// 시 직무가 곧장 떠 로스터 폴백을 가려버리던 버그를 막는다(활동·티커·워크플로우 공용).
export function resolveName(
  id: string | null | undefined,
  persona: { name?: string; role?: string } | undefined,
  names?: Record<string, string>,
): string {
  if (persona?.name) return personLabel(persona.name, persona.role);
  if (id && names && names[id]) return names[id];
  return personLabel(persona?.name, persona?.role); // 실명 없음 → 직무/실장/""
}

// 콘텐츠 로스터 글리프 — OfficeView.glyphFor·EmployeesView.glyph 와 **동일 매핑**으로 유지해야
// 티커·활동피드·워크플로보드·오피스에서 같은 에이전트가 같은 이모지로 보인다(글리프 일관성).
// 순서 주의: trend_researcher(id에 'research' 포함)가 research_lead 규칙에 가로채이지 않도록,
// research_lead 는 'research_lead|디렉터|리서치'로, trend 는 '트렌드|trend|리서처'로 상호배타 키잉.
export function agentGlyph(level: string | undefined, id: string, title: string): string {
  if (level === "ceo") return "🧑‍💼";               // 편집장
  const k = (id + " " + title).toLowerCase();
  if (/(reviewer|팩트|리뷰|검증|비평)/.test(k)) return "🔎"; // 팩트체커·리뷰어
  if (/(디렉터|리서치|research_lead)/.test(k)) return "🧭";  // 리서치·전략 디렉터
  if (/(seo|키워드|strategist)/.test(k)) return "🔑";        // SEO 키워드 전략가
  if (/(트렌드|trend|리서처)/.test(k)) return "📈";          // 트렌드 리서처
  if (/(성과|분석|analyst|perf)/.test(k)) return "📊";       // 성과 분석가
  if (/(작가|카피|content_lead|copywriter)/.test(k)) return "✍️"; // 수석 작가·카피라이터(lead 보다 먼저)
  if (level === "lead") return "🧑‍💼";
  return "🧑‍💻";
}
