/**
 * 직원 워크스페이스 — `data/agents/<id>/` 의 진화 파일(원본 GEPA org/workspace.py 포팅).
 *  - goal.md     : 개인 목표(자가학습이 비면 자동 생성, 사람 편집 우선). 직무 정체성은 company.yaml 의 system_prompt 가 담당.
 *  - skills/*.md : 검증된 재사용 패턴(주입)
 *  - capabilities.json : { tools, autonomy } — company.yaml 위 오버레이
 *  - knowledge.md : 귀속된 자료(자동분류용)
 *  - activity.log : append 활동 로그
 * persona_extra(=goal+skills+memory)와 effective tools/autonomy 를 오케스트레이터가 주입한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { brandFileSuffix, brandFileSuffixFor } from '../content/brand';
import { llm } from '../llm/client';
import type { RoleDef } from './company';
import { kstDate } from '../util/time';
import type { GroundingEntry } from '../orchestrator/groundingLedger';

const ALLOWED_TOOLS = new Set(['wiki_query', 'wiki_ingest', 'web_search']);

function dir(id: string): string {
  const d = path.join(CONFIG.agentsDir, id);
  return d;
}
function safeId(id: string): boolean {
  return !!id && !/[/\\]|\.\./.test(id);
}
function read(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}
function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf-8');
}
function skillSlug(name: string): string {
  return (name || 'skill').trim().toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}
/** append 누적 파일의 무한 성장 방지 — 줄 수가 max 를 넘으면 마지막 keep 줄만 남긴다(디스크 누수·조회 지연 차단). */
function tailTrim(p: string, max: number, keep: number): void {
  try {
    const lines = read(p).split('\n');
    if (lines.length > max) write(p, lines.slice(-keep).join('\n'));
  } catch { /* 무해 */ }
}

// 브랜드 스코프 경로 — 범용은 기본 파일, 브랜드 활성 시 -<slug> 접미(사용자 확정 2026-07-06).
// 직원 워크스페이스의 지식·설정 전부가 브랜드별이다: goal(목표)·verified(검증 지식)·skills(패턴)·
// memory(교훈)·injected(사람 주입 지식)·capabilities(툴·자율도 오버레이) — 브랜드 간 교차 주입 차단.
const goalFile = (id: string): string => path.join(dir(id), `goal${brandFileSuffix()}.md`);
const verifiedFile = (id: string): string => path.join(dir(id), `verified${brandFileSuffix()}.md`);
const skillsDirOf = (id: string): string => path.join(dir(id), `skills${brandFileSuffix()}`);
const injectedFile = (id: string): string => path.join(dir(id), `injected${brandFileSuffix()}.md`);
const capabilitiesFile = (id: string): string => path.join(dir(id), `capabilities${brandFileSuffix()}.json`);

export function ensureScaffold(id: string): void {
  if (!safeId(id)) return;
  fs.mkdirSync(skillsDirOf(id), { recursive: true });
}

export function writeGoal(id: string, text: string): void {
  if (safeId(id)) write(goalFile(id), text);
}
export function readGoal(id: string): string { return safeId(id) ? read(goalFile(id)) : ''; }
export function readKnowledge(id: string): string { return safeId(id) ? read(path.join(dir(id), 'knowledge.md')) : ''; }

export function appendKnowledge(id: string, line: string): void {
  if (!safeId(id)) return;
  const p = path.join(dir(id), 'knowledge.md');
  fs.mkdirSync(dir(id), { recursive: true });
  fs.appendFileSync(p, line.trim() + '\n', 'utf-8');
}
export function removeKnowledge(id: string, marker: string): void {
  if (!safeId(id)) return;
  const p = path.join(dir(id), 'knowledge.md');
  const cur = read(p);
  if (!cur) return;
  write(p, cur.split('\n').filter((l) => !l.includes(marker)).join('\n'));
}
export function appendActivity(id: string, line: string): void {
  if (!safeId(id)) return;
  fs.mkdirSync(dir(id), { recursive: true });
  const p = path.join(dir(id), 'activity.log');
  fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`, 'utf-8');
  tailTrim(p, 200, 100); // 무한 성장 방지(최근 100줄 유지)
}

// --- 자가학습(self-learning): memory 누적 + 다음 런 주입 ---
// 교훈은 브랜드(고객사)별로 분리 — 범용은 memory.md, 브랜드 활성 시 memory-<slug>.md.
// (브랜드 A 런에서 배운 채널·독자 교훈이 다른 브랜드 런의 프롬프트에 주입되지 않게 — 사용자 확정 2026-07-06.
//  위키 lesson 페이지는 llmWiki() 가 이미 브랜드별 디렉토리로 분리하므로 여기(주입용 memory)만 맞추면 된다.)
const memoryFile = (id: string, brand?: string): string =>
  path.join(dir(id), `memory${brand !== undefined ? brandFileSuffixFor(brand) : brandFileSuffix()}.md`);
const memoryArchiveFile = (id: string): string => path.join(dir(id), `memory_archive${brandFileSuffix()}.md`);
/** brand 명시 시 그 브랜드의 memory 파일에 귀속(성과 강화 등 활성≠콘텐츠 브랜드 경로용). 미지정=활성 브랜드(현행). */
export function appendMemory(id: string, insight: string, brand?: string): void {
  if (!safeId(id) || !insight.trim()) return;
  fs.mkdirSync(dir(id), { recursive: true });
  const date = kstDate();
  const p = memoryFile(id, brand);
  fs.appendFileSync(p, `- (${date}) ${insight.trim().replace(/\s+/g, ' ')}\n`, 'utf-8');
  tailTrim(p, 400, 200); // 자가학습 누적 상한(최근 200줄) — 파일·주입 비용 통제
}
export function readMemory(id: string, maxChars = 1500): string {
  if (!safeId(id)) return '';
  const m = read(memoryFile(id)).trim();
  return m.length > maxChars ? '...\n' + m.slice(-maxChars) : m; // 최근 학습 우선
}
// 오래된 학습 압축·아카이브 — memory.md 가 임계(줄)를 넘으면 오래된 부분을 micro 로 요약해
// '이전 학습 요약'으로 갈음하고 원본은 memory_archive.md 에 보존. 단순 폐기(tailTrim) 대신
// 지식을 잃지 않고 주입 컨텍스트 비용만 줄인다(Connect AI recency 개념 차용, 1000+ 런 오염 방지).
const MEMORY_ARCHIVE_LINES = 60;
export async function archiveMemory(id: string, microModel: string, signal?: AbortSignal): Promise<boolean> {
  if (!safeId(id)) return false;
  const p = memoryFile(id);
  const cur = read(p).trim();
  if (!cur) return false;
  const lines = cur.split('\n').filter((l) => l.trim());
  if (lines.length <= MEMORY_ARCHIVE_LINES) return false;
  const keep = Math.floor(MEMORY_ARCHIVE_LINES / 2);
  const old = lines.slice(0, lines.length - keep);
  const recent = lines.slice(lines.length - keep);
  try { fs.appendFileSync(memoryArchiveFile(id), old.join('\n') + '\n', 'utf-8'); } catch { /* 보존 실패 무해 */ }
  let summary = '';
  try {
    const res = await llm.chat({
      model: microModel,
      messages: [
        { role: 'system', content: '너는 학습 정리자다. 아래 누적 교훈을 중복 제거하고 핵심만 5~8개 불릿으로 압축하라. 한국어, 구체적으로.' },
        { role: 'user', content: old.join('\n') },
      ],
      maxOutputTokens: 500, temperature: 0.2, signal,
    });
    summary = res.text.trim();
  } catch { /* 요약 실패해도 원본은 archive 에 보존됨 */ }
  const head = summary ? `## 이전 학습 요약 (${kstDate()})\n${summary}\n` : '';
  write(p, [head, recent.join('\n')].filter(Boolean).join('\n') + '\n');
  return true;
}
// --- 검증 지식(Self-RAG, Connect AI verified.md 벤치마킹) ---
// 에이전트 출력에서 [근거: 출처] 태그가 붙은 주장만 '검증 지식'으로 승격해 verified.md 에 누적.
// 다음 런 시스템프롬프트에 memory 보다 우선 주입 → 근거 있는 사실 위에 compounding(환각 억제).

/** 텍스트에서 [근거: 출처] 태그가 붙은 주장 추출 — 태그 직전 문장(클레임) + 출처. */
export function extractVerifiedClaims(text: string): Array<{ claim: string; source: string }> {
  const out: Array<{ claim: string; source: string }> = [];
  if (!text) return out;
  const re = /([^.\n!?•]{8,}?)\s*\[\s*근거\s*[:：]\s*([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const claim = (m[1] ?? '').replace(/^[-*\s>]+/, '').trim();
    const source = (m[2] ?? '').trim();
    if (claim.length >= 8 && source) out.push({ claim, source });
    if (out.length >= 20) break; // 폭주 방지
  }
  return out;
}

const VERIFIED_REJECT_SOURCE = /동일|종합|비평|성과|검증된 지식|표기된 지식|사내|확립된|일반|상식|추정|추론/;
// '가정' 은 가정(假定)의미만(가정용·가정정원 등 생활어 오탈락 방지), '미확인' 은 보류 표시 문맥만(김도현 미확인 항목 같은 역참조 오탈락 방지) — 표 조각 「| 미확인 |」은 아래 표 규칙이 별도로 잡는다.
const VERIFIED_REJECT_CLAIM = /⚠|미실측|미확인 상태|미확인\s*[—–-]|데이터 없음|가정한다|가정하면|가정할 때|가정치|가정 하에|\(가정\)|가정:/;
const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** verified 승격 거절 사유(순수) — 근거가 근거가 아닌 것(자기 인용·토론·성과·보류 표시·표 조각). null 이면 통과. */
export function rejectVerifiedLine(claim: string, source: string): string | null {
  const c = claim.trim();
  if (VERIFIED_REJECT_CLAIM.test(c)) return '보류·미실측 표시';
  if (c.startsWith('|') || (c.match(/\|/g)?.length ?? 0) >= 2) return '표 조각';
  if (VERIFIED_REJECT_SOURCE.test(source)) return '근거가 자기 인용·토론·성과';
  return null;
}
/** 승격 수락(순수) — 거절 규칙 통과 + 근거 문자열이 이 런의 실제 조회(커넥터·웹 URL·raw 위키)와 일치할 때만. */
export function acceptVerifiedSource(claim: string, source: string, entries: GroundingEntry[]): boolean {
  if (rejectVerifiedLine(claim, source)) return false;
  const ns = norm(source);
  return entries.some((e) =>
    (e.kind === 'web' && source.includes(e.label)) ||
    (e.kind === 'connector' && ns.includes(norm(e.label))) ||
    (e.kind === 'wiki-raw' && ns.includes(norm(e.label))));
}

/** 검증 주장 1건을 직원 verified.md 에 누적(중복은 스킵). 승격되면 true. */
export function appendVerified(id: string, claim: string, source: string): boolean {
  if (!safeId(id)) return false;
  const c = (claim || '').replace(/\s+/g, ' ').trim();
  const src = (source || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (c.length < 8 || !src) return false;
  const p = verifiedFile(id);
  const cur = read(p);
  if (cur.includes(c.slice(0, 40))) return false; // 동일 주장 중복 방지
  fs.mkdirSync(dir(id), { recursive: true });
  fs.appendFileSync(p, `- (${kstDate()}) ${c} _(근거: ${src})_\n`, 'utf-8');
  tailTrim(p, 200, 120); // 상한
  return true;
}
export function readVerified(id: string, maxChars = 1000): string {
  if (!safeId(id)) return '';
  const v = read(verifiedFile(id)).trim();
  return v.length > maxChars ? '...\n' + v.slice(-maxChars) : v;
}

// --- 주입 지식(injected.md) — 사람이 UI로 특정 에이전트에 넣는 외부 지식. '우선 신뢰'로 시스템프롬프트에 주입.
// 자가학습(memory)·근거추출(verified)과 달리 사람이 명시적으로 넣은 것이라 최우선 배치하되, '관련될 때
// 우선 활용'으로 프레이밍(무관 출력에 억지로 끼워넣지 않게). 주입 한도(자 수) 초과분은 최신 우선(tail)로 잘린다. ---
export const INJECTED_CAP = CONFIG.injectedKnowledgeCap; // 기본 10,000자 · env INJECTED_KNOWLEDGE_CAP 로 조절
export function appendInjected(id: string, text: string, source = '외부 자료'): boolean {
  if (!safeId(id)) return false;
  const t = (text || '').trim();
  if (!t) return false;
  fs.mkdirSync(dir(id), { recursive: true });
  const src = source.replace(/\s+/g, ' ').trim().slice(0, 80) || '외부 자료';
  fs.appendFileSync(injectedFile(id), `\n## ${src} (${kstDate()})\n${t}\n`, 'utf-8');
  return true;
}
export function readInjected(id: string, maxChars = INJECTED_CAP): string {
  if (!safeId(id)) return '';
  const v = read(injectedFile(id)).trim();
  return v.length > maxChars ? '...(이전 주입 일부 생략)\n' + v.slice(-maxChars) : v;
}
/** injected.md 전체 길이 — 엔드포인트의 한도초과 경고용(주입은 tail 로 잘리므로 총량>CAP 이면 일부 미반영). */
export function injectedLength(id: string): number {
  if (!safeId(id)) return 0;
  return read(injectedFile(id)).trim().length;
}
export function clearInjected(id: string): void {
  if (!safeId(id)) return;
  try { fs.rmSync(injectedFile(id)); } catch { /* 없으면 무해 */ }
}

/** CEO 의사결정 로그(공유). */
export function appendDecision(topic: string, summary: string): void {
  try {
    const d = path.join(CONFIG.dataDir, '_shared');
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, `decisions${brandFileSuffix()}.md`), `## [${kstDate()}] ${topic}\n${summary.trim()}\n\n`, 'utf-8');
  } catch { /* */ }
}

// --- capabilities 오버레이 ---
export interface Capabilities { tools?: string[]; autonomy?: number; }
export function readCapabilities(id: string): Capabilities {
  if (!safeId(id)) return {};
  try { return JSON.parse(read(capabilitiesFile(id))) as Capabilities; } catch { return {}; }
}
export function writeCapabilities(id: string, cap: Capabilities): void {
  if (!safeId(id)) return;
  const cur = readCapabilities(id);
  const next: Capabilities = { ...cur };
  if (cap.tools) next.tools = cap.tools.filter((t) => ALLOWED_TOOLS.has(t));
  if (typeof cap.autonomy === 'number') next.autonomy = Math.max(0, Math.min(3, Math.floor(cap.autonomy)));
  write(capabilitiesFile(id), JSON.stringify(next, null, 2));
}

// --- skills ---
export function skillNames(id: string): string[] {
  if (!safeId(id)) return [];
  try {
    return fs.readdirSync(skillsDirOf(id))
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}
export function addSkill(id: string, name: string, content: string): boolean {
  if (!safeId(id)) return false;
  const slug = skillSlug(name);
  if (slug === 'readme') return false;
  write(path.join(skillsDirOf(id), `${slug}.md`), content || `# ${name}\n`);
  return true;
}
export function deleteSkill(id: string, slug: string): boolean {
  if (!safeId(id) || /[/\\]|\.\./.test(slug)) return false;
  try { fs.rmSync(path.join(skillsDirOf(id), `${skillSlug(slug)}.md`), { force: true }); return true; } catch { return false; }
}
// 스킬 플레이북 주입 — 로컬 프리필 비용 통제를 위해 스킬당 600자·총 1500자로 캡(긴 절차서는
// 앞부분만 주입, 전문은 스킬 파일·직원 탭에서 참조). 격상된 system_prompt 가 주 식별자.
function readSkills(id: string, maxTotal = 1500): string {
  const parts: string[] = [];
  let used = 0;
  for (const s of skillNames(id)) {
    if (used >= maxTotal) break;
    const body = read(path.join(skillsDirOf(id), `${s}.md`)).trim();
    if (!body) continue;
    const slice = body.length > 600 ? body.slice(0, 600).trimEnd() + ' …(상세는 스킬 파일)' : body;
    parts.push(slice);
    used += slice.length;
  }
  return parts.join('\n\n');
}

// --- 오케스트레이터 주입: persona_extra + effective tools/autonomy ---
export function personaExtra(id: string): string {
  if (!safeId(id)) return '';
  const parts: string[] = [];
  const goal = readGoal(id).trim();
  const skills = readSkills(id);
  const injected = readInjected(id).trim();
  const verified = readVerified(id, 1000);
  const memory = readMemory(id, 1000);
  if (goal) parts.push(`[개인 목표]\n${goal}`);
  // 사람이 주입한 외부 지식 — 최우선 신뢰. 단 '관련될 때 우선 활용'으로, 무관한 출력에 억지로 끼워넣지 않게.
  if (injected) parts.push(`[주입된 외부 지식(우선 신뢰 — 관련될 때 우선 활용, 무관하면 무시)]\n${injected}`);
  // 검증 지식(근거 확인됨)을 교훈보다 먼저·우선 신뢰하도록 배치.
  if (verified) parts.push(`[근거 표기된 지식(출처 표기됨 — 실측·원문 출처만 사실로 인용, 나머지는 방향 참고)]\n${verified}`);
  if (skills) parts.push(`[검증된 작업 패턴(스킬)]\n${skills}`);
  if (memory) parts.push(`[과거 학습·교훈(자가학습)]\n${memory}`);
  return parts.join('\n\n');
}
export function effectiveTools(role: RoleDef): string[] {
  const cap = readCapabilities(role.id);
  return cap.tools ?? role.tools;
}
export function effectiveAutonomy(role: RoleDef): number {
  const cap = readCapabilities(role.id);
  const a = typeof cap.autonomy === 'number' ? cap.autonomy : role.autonomy;
  // 게이트(toolsForAutonomy·gateWrite)가 항상 정수 0~3 만 보도록 정규화 — 디스크 직접편집 등으로 들어온
  // 범위 밖·소수 값이 자동승인(≥3)이나 경계 불일치로 새지 않게(신뢰경계 방어).
  return Math.max(0, Math.min(3, Math.floor(a)));
}

/** GET /agents/:id 의 AgentProfile 페이로드(프론트 EmployeesView). */
export function agentDetail(role: RoleDef): Record<string, unknown> {
  const id = role.id;
  return {
    id, title: role.title, name: role.name,
    level: role.level ?? 'member', team: role.team ?? null,
    tools: effectiveTools(role), skills: skillNames(id), model: role.tier,
    stance: role.stance, is_critic: role.isCritic, autonomy: effectiveAutonomy(role),
    // AgentProfile 확장 필드
    system_prompt: role.systemPrompt ?? '',
    skills_loaded: skillNames(id),
    autonomy_effective: effectiveAutonomy(role),
    goal: readGoal(id),
    // 직원 탭 표시도 브랜드 스코프와 일치 — 직접 경로가 아니라 스코프 헬퍼 경유.
    memory: read(memoryFile(id)),
    verified: read(verifiedFile(id)),
    injected: read(injectedFile(id)),
    tools_md: JSON.stringify(readCapabilities(id)),
    activity_tail: read(path.join(dir(id), 'activity.log')).split('\n').filter(Boolean).slice(-20),
    usage_pages: [] as Array<{ page_id: string; title: string }>,
  };
}
