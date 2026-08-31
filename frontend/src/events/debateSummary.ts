import type { AgentNode } from "./types";

// 직급어 — 대상 지칭("X 과장에게")·실명직책 추출에 공용.
const TITLE = "(?:과장|팀장|차장|대리|주임|실장|연구원|위원|사장|원장)";
// 알려진 동료 실명(이 조직 로스터) — 대상 추출 시 오탐('핵심인데 과장'·'경영평가 위원')
// 차단용 화이트리스트. 신규 직원은 caller가 extraNames로 보강.
const KNOWN_NAMES = /박용식|박정민|권하경|이주리|권이담|장은영|전진영|박영희|김현창|박재희|하예림|이윤아|이다정|김영희/;

// 구조화 보고서의 "라벨: 짧은 판정값" 한 줄("판단: 보완", "판정: 충족", "구분: 전략/용역계약
// 검토", "경영성과: 보완", "리더십·전략: 충족") 식별. org 모드 작업 산출물은 토론 발언이 아니라
// '라벨: 값' 줄이 많은데, 이 조각이 카드 headline/결론으로 오인되는 것을 막는다. 콜론 뒤 실질
// 내용이 짧을 때만(어절 수·숫자·서술종결 없음) 약하게 판정 — "반론: 예상매출 242억 왜곡"처럼
// 콜론 뒤 내용이 충분한 토론 결론은 그대로 유효(false).
const VERDICT_WORD = /^(?:보완|충족|미충족|미흡|적정|부적정|적합|부적합|유보|충분|불충분|양호|불량|우수|보통|미달|해당없음)$/;
function isLabelVerdictLine(line: string): boolean {
  // 선행 불릿/마크다운/전각콜론 정규화 후 "key: value" 한 줄만 평가.
  const t = (line || "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/^[>\s#✅✓🔴⚠️▶•\-–—]+/, "")
    .replace(/[：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(/^([^:]{1,12}):\s*(.*)$/);
  if (!m) return false;
  const val = (m[2] ?? "").trim();
  if (!val) return false;
  // 값에 숫자·서술종결("…했음.")이 있으면 실질 내용 → 라벨 아님.
  if (/\d/.test(val)) return false;
  if (/[다요함음임됨까]\.?$/.test(val)) return false;
  // 값 자체가 판정어(보완/충족/미흡…)일 때만 라벨줄로 본다("판단: 보완", "경영성과: 충족").
  // 키가 구조 라벨이어도 값이 실질 내용이면("전략: 시장 선점", "재무: 적자") 결론으로 살린다 —
  // 길이만으로 드롭하던 과매칭(전략/인사/재무/조직 + 짧은 실질 punchline 누락)을 제거한다.
  return VERDICT_WORD.test(val.replace(/\s+/g, ""));
}

// The primary colleague a debate rebuttal addresses — for the "발언자 → 대상" feed arrow.
// Round-1 positions address the whole team (no single target, handled by the caller).
// A rebuttal leads with "[X에게 …]" or names the colleague it refutes; we surface that
// primary addressee (the summary still names any others). Returns the colleague's
// agent_id, or null when there's no clear single peer (never the speaker themselves).
export function debateTarget(
  text: string,
  speakerId: string,
  agents: Record<string, AgentNode>,
): string | null {
  if (!text) return null;
  const nameToId = (name: string): string | null => {
    for (const id in agents) {
      if (id === speakerId) continue;
      if ((agents[id]?.persona?.role ?? "").includes(name)) return id;
    }
    return null;
  };
  // 1) explicit "[X에게 …]" addressee
  const bracket = text.match(/\[\s*([가-힣]{2,4})에게/);
  if (bracket) { const id = nameToId(bracket[1]); if (id) return id; }
  // 2) else the first colleague (by persona surname) named in the text
  let bestIdx = Infinity, bestId: string | null = null;
  for (const id in agents) {
    if (id === speakerId) continue;
    const surname = (agents[id]?.persona?.role ?? "").split(/\s+/)[0];
    if (!surname) continue;
    const idx = text.indexOf(surname);
    if (idx >= 0 && idx < bestIdx) { bestIdx = idx; bestId = id; }
  }
  return bestId;
}

// Extract a one-line CONCLUSION/REBUTTAL summary from a messy LLM debate message for
// the 활동 피드 detail — the raw text is the agent's whole streamed turn (process
// narration "이제 …확인합니다" + tool noise + the actual position at the end), so a naive
// head snippet shows narration, not the debate point.
//
// Heuristic (priority order, designed + adversarially judged against all 19 real
// debate_messages of run 0e0476c0 via a workflow): verdict blockquote → inline
// conclusion marker ([갱신된 결론]) → section header (## … 입장/결론) → last "---" with
// prose walk-back → truncated/narration fallback (last substantive, colleague/number/
// status-bearing clause). Returns <=120 chars, markdown/ULID/tool-noise stripped.
export function debateSummary(text: string): string {
  if (!text || typeof text !== "string") return "";
  const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
  const NAMES = KNOWN_NAMES;
  const contentLen = (s: string) => s.replace(/[^가-힣A-Za-z]/g, "").length;

  function clean(s: string): string {
    return s
      .replace(/`[^`]*`/g, " ")
      .replace(/\(\s*ID\s*:[^)]*\)/gi, " ")
      .replace(/\(\s*page(?:_id)?\s*:[^)]*\)/gi, " ")
      .replace(/\[\s*[0-9A-HJKMNP-TV-Z]{26}\s*\]/g, " ")
      .replace(/\(\s*raw:\s*[0-9A-HJKMNP-TV-Z]{26}[^)]*\)/gi, " ")
      .replace(/\braw:\s*[0-9A-HJKMNP-TV-Z]{26}/gi, " ")
      .replace(ULID, " ")
      .replace(/\*\*([^*]*)\*\*/g, "$1")
      .replace(/\*([^*]*)\*/g, "$1")
      .replace(/^[>\s#✅✓🔴⚠️▶•\-–—]+/, "")
      .replace(/[`*]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function isProse(line: string): boolean {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith("|")) return false;
    if (/^#{1,6}\s/.test(t)) return false;
    if (/^[-=]{3,}\s*$/.test(t)) return false;
    if (/^\*?작성\s*[:：]/.test(t)) return false;
    if (/^\*.*근거\s*wiki/i.test(t)) return false;
    // org 작업 산출물의 "라벨: 짧은 판정값"("판단: 보완", "구분: …", "리더십·전략: 충족") 줄은
    // 결론 prose 가 아니라 구조화 출력 조각 — firstProse·fallback 이 건너뛰게 한다.
    if (isLabelVerdictLine(t)) return false;
    const ct = clean(t);
    // 툴 진행/로깅 메타라인은 결론이 아니라 "지금 기록/생성 중" 잡음 — prose에서 제외해
    // firstProse·fallback이 이를 건너뛰고 실제 결론을 고르게 한다("wiki 기록 완료: v5.0",
    // "…wiki에 기록합니다. 두 산출물 미생성… xlsx 완료" 류 누수 차단).
    if (/wiki에?\s*기록(?:합니다|하겠|했|함)|(?:기록|저장|확보|생성)\s*완료|미생성\s*상태|즉시\s*생성|(?:xlsx|docx|pptx|hwpx?)\s*(?:완료|생성)|순서로\s*(?:즉시\s*)?생성/.test(ct)) return false;
    // "출처: … wiki: …" 류 인용 골격(서술어 없는 라벨 나열)
    if (/^출처\s*[:：]/.test(ct) && /wiki\s*[:：]/.test(ct)) return false;
    // 프롬프트 템플릿 스캐폴드("핵심 입장 요약 (3~6문장)" 류) — 분량 지시는 내용이 아님.
    if (/\(\s*\d+\s*[~∼-]?\s*\d*\s*문장\s*\)/.test(ct)) return false;
    return contentLen(ct) >= 4;
  }
  function firstProse(block: string): string {
    const lines = block.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!isProse(lines[i])) continue;
      let out = clean(lines[i]);
      let j = i + 1;
      while (out.length < 55 && j < lines.length) {
        if (lines[j].trim() === "") { j++; continue; }
        if (isProse(lines[j])) { out = (out + " " + clean(lines[j])).trim(); j++; }
        else break;
      }
      return out;
    }
    return "";
  }
  // Deliverable-title fallback: a bold/header one-liner naming a report/summary/verdict.
  function titleFallback(t: string): string {
    const lines = t.split(/\n/);
    for (const line of lines) {
      const l = line.trim();
      let cand: string | null = null;
      const bm = l.match(/^\*\*\s*([^*]+?)\s*\*\*\s*$/);     // **산출물 완료 보고 — 장은영 팀장**
      if (bm) cand = bm[1];
      const hm = l.match(/^#{1,4}\s*(.+?)\s*$/);             // ## 경영지원 검토서 — 팀장 종합 판정
      if (!cand && hm) cand = hm[1];
      if (!cand) continue;
      cand = clean(cand);
      if (!cand) continue;
      if (/(보고|요약|판정|검토서|결과|입장|결론|취합)/.test(cand) &&
          !/(완료 항목|남은|통합본 7장|다음 행동|행동 항목|구조 요약|현황)/.test(cand) &&
          contentLen(cand) >= 4) {
        return cand;
      }
    }
    return "";
  }
  // Salvage best table cell (last resort for table-only sections).
  function bestCell(t: string): string {
    const lines = t.split(/\n/).filter((l) => l.trim().startsWith("|"));
    const headerCell = /^(항목|장|기한|담당|과제|순위|구분|코드|조항|갑|내용|상태|Y 항목|부|귀속|쟁점|현황|위험|조치|자료|핵심 사실)$/;
    let best = "", bestScore = -1;
    for (const line of lines) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.every((c) => /^[-:\s]+$/.test(c))) continue;
      if (headerCell.test(cells[0])) continue;
      const joined = cells.join(" — ").replace(/\*\*/g, "").replace(/[`*✅✓]/g, "").replace(/\s+/g, " ").trim();
      if (joined.replace(/[^가-힣A-Za-z]/g, "").length < 6) continue;
      let score = joined.length > 18 ? 2 : 0;
      if (NAMES.test(joined)) score += 3;
      if (/\d/.test(joined)) score += 2;
      if (/보고|총괄|핵심|결론|확정|완료|발송|판정|유보/.test(joined)) score += 1;
      if (score > bestScore) { bestScore = score; best = joined; }
    }
    return best;
  }
  function cap(s: string): string {
    s = (s || "").replace(/\s+/g, " ").trim()
      .replace(/[—–-]\s*(에서|에는|에|로|으로|의)\s+/g, " ")
      .replace(/\(\s*[·,\s]*\)/g, "").replace(/\(\s*\)/g, "")
      .replace(/\s*[—–-]\s*[—–-]\s*/g, " — ")
      .replace(/\s+([,.])/g, "$1").replace(/\s+/g, " ").trim()
      .replace(/^["“”']+/, "").replace(/\s*["“”]\s*$/, "").trim();
    if (s.length <= 120) return s;
    let cut = s.slice(0, 119);
    const lp = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다 "), cut.lastIndexOf(", "), cut.lastIndexOf(" — "));
    if (lp > 70) cut = cut.slice(0, lp + 1);
    return cut.trim() + "…";
  }

  // ---- 1. VERDICT BLOCKQUOTE (highest priority): "> **<verdict>** — <rest>"
  {
    const vbRe = /^\s*>\s*\*\*\s*([^*]+?)\s*\*\*\s*(?:[—–-]\s*([^\n]*))?$/gm;
    let m: RegExpExecArray | null, picked: string | null = null;
    while ((m = vbRe.exec(text)) !== null) {
      const head = m[1].trim();
      // 판정어 검출. '가능/불가/추진'은 '입점가능'·'불가피' 같은 복합어 오탐을 막기 위해
      // 앞에 비한글 경계(문두/공백/기호)를 요구한다 — 명확한 판정어는 그대로 매칭.
      if (/(?:결론|조건부|권고|반려|채택|보류|확정|승인|판정)|(?:^|[^가-힣])(?:가능|불가|추진)/.test(head)) {
        const rest = (m[2] || "").trim();
        picked = rest ? head + " — " + rest : head;
      }
    }
    if (picked) {
      const out = clean(picked);
      if (out) return cap(out);
    }
  }
  // ---- 1b. LABELED verdict blockquote: "> **판정/결론**: **조건부 가능** — …"
  {
    const lvRe = /^\s*>\s*\*\*\s*(판정|결론|종합\s*판정|최종\s*판정|최종\s*입장)\s*\*\*\s*[:：]\s*([^\n]+)$/gm;
    let m: RegExpExecArray | null, picked: string | null = null;
    while ((m = lvRe.exec(text)) !== null) {
      const rest = m[2].trim();
      if (/(조건부|가능|불가|추진|권고|반려|채택|보류|확정|승인)/.test(rest)) picked = rest;
    }
    if (picked) { const out = clean(picked); if (out) return cap(out); }
  }

  // ---- 2. inline conclusion-marker punchlines
  const inlineMarkers = [
    /\[\s*갱신된\s*핵심\s*결론\s*\]/g,
    /\[\s*갱신된\s*결론\s*\]/g,
    /\[\s*갱신된\s*핵심\s*입장[^\]]*\]/g,
    />\s*\*\*\s*결론\s*[:：]/g,
  ];
  for (const mk of inlineMarkers) {
    let m: RegExpExecArray | null, last = -1;
    while ((m = mk.exec(text)) !== null) last = m.index + m[0].length;
    if (last >= 0) { const o = firstProse(text.slice(last)); if (o) return cap(o); }
  }

  // ---- 3. section headers (## 핵심 입장 / 갱신된 입장 / 최종 입장 / 결론)
  const headerRe = /^#{1,6}[^\n]*?(갱신된\s*핵심\s*입장|갱신된\s*입장|핵심\s*입장(?:\s*요약)?|최종\s*입장|갱신된\s*결론|결론)[^\n]*$/gm;
  let hm: RegExpExecArray | null, hLast = -1;
  while ((hm = headerRe.exec(text)) !== null) hLast = hm.index + hm[0].length;
  if (hLast >= 0) { const o = firstProse(text.slice(hLast)); if (o) return cap(o); }

  // ---- 4. last '---', walk back until a segment yields prose; else title; else best cell
  const parts = text.split(/^\s*---\s*$/m);
  if (parts.length > 1) {
    for (let k = parts.length - 1; k >= 1; k--) { const o = firstProse(parts[k]); if (o) return cap(o); }
    const t = titleFallback(text); if (t) return cap(t);
    const c = bestCell(text); if (c) return cap(c);
  }

  // ---- 5. truncated / pure-narration fallback
  let body = text.replace(/API\s*Error:[\s\S]*?fetch\(\)/gi, " ").replace(/API\s*Error:[\s\S]*$/i, " ");
  body = body.replace(ULID, " ")
    .replace(/([다요함음임됨까])\.(?=\S)/g, "$1.\n")
    .replace(/(완료|확보|저장|작성|수정|반영|발송)\.(?=\S)/g, "$1.\n")
    .replace(/([.!])(?=[가-힣])/g, "$1\n");
  const sentences = body.split(/\n+/).map(clean).filter((s) => contentLen(s) >= 4);
  const procTail = /^(?:이제|먼저|곧)?\s*(?:반론을?\s*구성|wiki에?\s*기록|위키에?\s*기록|기록합니다|저장합니다|진행합니다|확인합니다|조회합니다|검색|착수합니다|넘어갑니다|보완합니다|업데이트합니다|해결합니다|advisor|블로커)/;
  const procFull = /(병렬|advisor|wiki[_\s]*ingest|기록\s*완료|저장\s*완료|확보\s*완료|로드|재시도|재검색|넘어갑니다|착수합니다|블로커)/;
  const keepSig = () => /[★△☆]|수용|반론|결론|권고|유보|불가|미확인|평가표|결과보고|보고서|난이도/;
  if (sentences.length) {
    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i];
      if (procTail.test(s)) continue;
      // org 산출물의 "라벨: 짧은 판정값"(판단:보완·구분:…) 조각은 결론이 아니므로 건너뛴다.
      if (isLabelVerdictLine(s)) continue;
      if ((NAMES.test(s) || /\d/.test(s) || keepSig().test(s)) && !procFull.test(s)) return cap(s);
    }
    // 최후 폴백: 라벨줄·프로세스 잡음을 제외하고 남은 마지막 실질 문장. 전부 라벨줄이면 "".
    const pool = sentences.slice();
    while (pool.length > 1 && procTail.test(pool[pool.length - 1])) pool.pop();
    while (pool.length > 0 && isLabelVerdictLine(pool[pool.length - 1] as string)) pool.pop();
    if (pool.length) return cap(pool[pool.length - 1] as string);
    return "";
  }
  return cap(clean(body));
}

// 헤더/대상 텍스트의 마크다운·이모지·번호·ULID·wiki 참조 잡음 제거(표시용 한 줄).
function cleanHeadline(s: string): string {
  return (s || "")
    .replace(/`[^`]*`/g, " ")
    .replace(/\(\s*wiki[^)]*\)/gi, " ")
    .replace(/\(\s*(?:page_?id|ID|raw)\s*:[^)]*\)/gi, " ")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, " ")
    .replace(/\*\*([^*]*)\*\*/g, "$1").replace(/\*([^*]*)\*/g, "$1")
    .replace(/[#*`>~[\]]/g, " ")
    .replace(/[🔴🟡🟢🔵⚪⚫✅✓☑️⚠️❗❌⛔️⚔️🛡️📌▌▶►•◦‣·–—|]/gu, " ")
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩➀-➉]/g, " ")
    .replace(/^\s*[Ⅰ-ⅿ]+\s*[.)]?\s*/, " ")   // 로마숫자 머리(Ⅰ. Ⅱ Ⅲ) 제거 — 섹션 번호
    .replace(/^\s*\d+\s*[.)]\s*/, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 쟁점 헤더로 쓰기엔 알맹이 없는 섹션 마커/카운트/제네릭. 라벨(수용/반론…)·괄호·카운트를
// 떼어낸 잔여(core)에 실질 내용이 없으면 약한 헤더로 본다("수용 (이번 라운드)", "반론 2건",
// "(이번 라운드)", "개요" 등). 반대로 "반론 : 예상매출 242억 왜곡"은 core가 충분 → 유효.
function isWeakHeadline(s: string): boolean {
  const t = s.trim();
  if (t.replace(/[^가-힣A-Za-z0-9]/g, "").length < 3) return true;
  // org 작업 산출물의 "라벨: 짧은 판정값"(구분: …, 판정: 충족, 경영성과: 보완) 헤더 조각은
  // 쟁점 헤더가 아니므로 약한 헤더로 본다. "반론: 예상매출 242억 왜곡"처럼 콜론 뒤 내용이
  // 충분하면 isLabelVerdictLine 이 false → 유효 헤더로 통과.
  if (isLabelVerdictLine(t)) return true;
  // 접속/병렬 조사로 시작 = 대상 접두 과다 제거의 흔적인 깨진 조각("및 검증 질문") → 약한 헤더.
  if (/^(?:및|그리고|또는|혹은|와|과|이나|거나)\s/.test(t)) return true;
  if (/^(?:개요|보고서\s*개요|목차|서론|배경|개관|소결|총평)$/.test(t)) return true;
  // 도입부 섹션 라벨("검토 배경 및 자료 근거", "분석 개요 및 대상") — 특정 쟁점 없는 구조
  // 머리말이라 약한 헤더. 전체가 도입 구조어로만 구성될 때만 매칭(쟁점 단어가 섞이면 통과).
  if (/^(?:보고서\s*)?(?:검토|분석|추진|사업|조사)?\s*(?:개요|배경)(?:\s*(?:및|과|와|,)\s*(?:자료\s*근거|근거|대상|목적|범위|방법|개요|배경|현황|자료|목차))*\s*$/.test(t)) return true;
  const core = t
    .replace(/\([^)]*\)/g, " ")
    .replace(/^(?:수용|반론|재반론|비평|검증|교차검증|지적|반영|수정|갱신)\s*[:：]?\s*/, " ")
    .replace(/\d+\s*건/g, " ")
    .replace(/[+＋]/g, " ")
    .trim();
  return core.replace(/[^가-힣A-Za-z0-9]/g, "").length < 3;
}

// 토론 발언이 "말 거는" 대상 동료들 — 표시용 실명직책 문자열(예: ["이주리 과장",
// "박용식 과장"]). 본문 헤더·브래킷의 "X 과장에게 / X 과장에 대한 (재)반론 / [X에게]"를
// 스캔(헤더·앵커 라인 우선, 복수 대상 지원). 백엔드/agent_id 매핑 불필요 → 과거 런 안전.
// 추출 이름의 실명부는 KNOWN_NAMES(+extraNames 로스터)로 검증해 오탐 차단. selfName 제외.
export function debateTargetNames(text: string, selfName?: string, extraNames?: string[]): string[] {
  if (!text) return [];
  const extra = (extraNames ?? []).filter(Boolean);
  const isKnown = (namePart: string) =>
    KNOWN_NAMES.test(namePart) || extra.some((n) => n && namePart.includes(n));
  const found: string[] = [];
  const push = (raw: string) => {
    const name = cleanHeadline(raw).replace(/\s*에게.*$/, "").replace(/\s*에\s*대한.*$/, "").trim();
    if (!name) return;
    const namePart = name.replace(new RegExp(`\\s*${TITLE}$`), "").trim();
    if (namePart.replace(/[^가-힣]/g, "").length < 2 || !isKnown(namePart)) return;
    if (selfName && (namePart.includes(selfName) || selfName.includes(namePart))) return;
    if (!found.includes(name)) found.push(name);
  };
  const reAddr = new RegExp(`([가-힣]{2,4}\\s*${TITLE})\\s*에게`, "g");
  const reAbout = new RegExp(`([가-힣]{2,4}\\s*${TITLE})\\s*에\\s*대한\\s*(?:재)?반론`, "g");
  // "권하경·박용식 과장" / "권하경, 박용식 과장" — 직급어를 공유하는 복수 이름.
  const reShared = new RegExp(`([가-힣]{2,4})\\s*[·,]\\s*([가-힣]{2,4})\\s*(${TITLE})`, "g");
  for (const raw of text.split("\n")) {
    const orig = raw.trim();
    const anchor = /^#{1,6}\s/.test(orig) || /^\[/.test(orig) || /^>?\s*\*\*/.test(orig)
      || orig.includes("에게") || orig.includes("에 대한 반론") || orig.includes("에 대한 재반론");
    if (!anchor) continue;
    const t = orig.replace(/[[\]]/g, " ");   // "[X 과장]에게" → "X 과장 에게"
    let m: RegExpExecArray | null;
    while ((m = reAddr.exec(t)) !== null) push(m[1]);
    while ((m = reAbout.exec(t)) !== null) push(m[1]);
    while ((m = reShared.exec(t)) !== null) { push(`${m[1]} ${m[3]}`); push(`${m[2]} ${m[3]}`); }
  }
  return found;
}

// 발언 본문의 첫 "쟁점 헤더"(누구/무엇) — 프리앰블(첫 헤더 이전 잡음) 스킵 후 첫 의미있는
// ## / ### 헤더를 정제. 대상 지칭("X에게 —")은 앞에 별도 표시되므로 헤더에서 떼어내 쟁점만
// 남긴다. 섹션 마커/카운트(isWeakHeadline)는 건너뛰고 다음 실쟁점 헤더로. 대상 명시 헤더를
// 우선, 없으면 첫 substantive 헤더. 헤더 없으면 "".
function debateHeadline(text: string): string {
  if (!text) return "";
  // 대상 접두("X 과장에게 — " / "X 과장에 대한 (재)반론 — ")를 떼어 쟁점만 남긴다. 단,
  // "…에 대한 반론"의 '반론'은 뒤에 접속사(및/와/과/그리고/또는)가 오면 소비하지 않는다.
  // "권하경 과장에 대한 반론 및 검증 질문"의 '반론'은 제목 명사(반론 및 …)라 베면 "및 검증
  // 질문" 같은 접속사 시작 조각이 남기 때문. 그 경우 "X 과장에 대한 "까지만 제거해 "반론 및
  // 검증 질문"을 보존한다(분리자 —/: 는 cleanHeadline에서 공백으로 바뀌므로 분리자에 의존 못함).
  const stripAddr = new RegExp(
    `^(?:[가-힣]{2,4}\\s*${TITLE}(?:\\s*[·,]\\s*[가-힣]{2,4}\\s*${TITLE})?\\s*에게\\s*[—–:-]?\\s*`
    + `|[가-힣]{2,4}\\s*${TITLE}\\s*에\\s*대한\\s*(?=(?:재)?반론)`
    + `(?:(?:재)?반론(?!\\s*(?:및|와|과|그리고|또는|혹은))\\s*[—–:-]?\\s*)?)`, "");
  let firstTarget = "", firstAny = "";
  for (const raw of text.split("\n")) {
    const hm = raw.trim().match(/^#{2,6}\s+(.+?)\s*$/);
    if (!hm) continue;
    const inner = cleanHeadline(hm[1]);
    if (!inner || inner.replace(/[^가-힣A-Za-z]/g, "").length < 3) continue;
    const hasTarget = /에게|에\s*대한\s*(?:재)?반론/.test(inner);
    const cand = inner.replace(stripAddr, "")
      .replace(/^(?:반론|재반론|비평|지적)\s*[:：]\s*/, "")   // 잉여 "반론 :" 접두 제거
      .trim();
    if (isWeakHeadline(cand)) continue;   // "2건"·"반론" 등 섹션 마커는 다음 헤더로
    if (!firstAny) firstAny = cand;
    if (hasTarget && !firstTarget) firstTarget = cand;
  }
  return firstTarget || firstAny;
}

// 타임라인 토론 발언 2줄 요지 + 대상. headline(누구/무엇=쟁점 헤더) + detail(어떻게/왜=
// debateSummary 결론). 헤더 없으면 detail을 headline으로 승격. headline⊇detail 중복이면
// detail 생략. 순수 텍스트(LLM 없음). targets는 표시용 실명직책 배열(caller가 cap).
export function debateGist(text: string, selfName?: string, extraNames?: string[]): {
  targets: string[]; headline: string; detail: string;
} {
  const targets = debateTargetNames(text, selfName, extraNames);
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trim() + "…" : s);
  let headline = debateHeadline(text);
  let detail = debateSummary(text);
  if (!headline) { headline = detail; detail = ""; }
  const norm = (s: string) => s.replace(/[^가-힣A-Za-z0-9]/g, "");
  if (headline && detail) {
    const a = norm(headline), b = norm(detail);
    if (a && b && (a.includes(b) || b.includes(a))) detail = "";
  }
  return { targets, headline: trunc(headline, 64), detail: trunc(detail, 90) };
}
