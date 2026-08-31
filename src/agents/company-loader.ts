/**
 * 회사 정의 로더 + 편집 — data/company.yaml(조직) + data/people.yaml(역할→실명) ↔ CompanyDef.
 * 없으면 assets/company 시드 복사. 역할·팀 편집은 raw YAML 문서를 수정·저장(실명은 people.yaml 분리).
 * (원본 GEPA org/company_store.py 포팅)
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CONFIG } from '../config';
import { DEFAULT_COMPANY } from './company';
import type { CompanyDef, RoleDef, TeamDef } from './company';
import type { RoleTier } from '../llm/models';
import type { Stance } from '../events/types';
import { ensureScaffold } from './workspace';

const SEED_DIR = path.resolve(process.cwd(), 'assets/company');
const MODELS = new Set(['opus', 'sonnet', 'haiku']);
// 로컬 우선 제품: UI 가 '모델' 대신 '처리 등급(tier)' 을 보낼 수 있다(micro|standard|heavy).
// YAML 일관성을 위해 등급은 대표 클라우드 모델로 저장 → 로드 시 tierFor 가 다시 tier 로 복원(round-trip).
const TIERS = new Set(['micro', 'standard', 'heavy']);
export function tierToModel(tier: string): string {
  return tier === 'heavy' ? 'opus' : tier === 'micro' ? 'haiku' : 'sonnet';
}
/** 모델명(opus|sonnet|haiku) 또는 등급(micro|standard|heavy)을 YAML 저장용 모델명으로 정규화. 유효치 않으면 null. */
export function normalizeModel(m: string | undefined): string | null {
  const v = (m || '').toLowerCase();
  if (MODELS.has(v)) return v;
  if (TIERS.has(v)) return tierToModel(v);
  return null;
}
const STANCES = new Set(['neutral', 'pro', 'con', 'critic', 'nuanced']);
// wiki/web 은 mapTools 가 확장(wiki→wiki_query+wiki_ingest, web→web_search); 나머지는 그대로 통과.
// naver_*·youtube 는 UI editRole 재저장 시 필터로 스트립되지 않게 여기 포함(로드 시엔 mapTools 통과라 무관).
// ⚠ 새 그라운딩 커넥터의 도구명을 여기 빠뜨리면 역할 편집 한 번에 도구가 영구 소실된다(유튜브에서 실제 발생).
const YAML_TOOLS = new Set([
  'wiki', 'web',
  'naver_search', 'naver_searchad', 'naver_datalab', 'naver_autocomplete', 'naver_analytics',
  'youtube',
  'image_generate', 'blog_publish',
]);

interface YRole {
  id?: string; title?: string; level?: string; team?: string;
  focus?: string; system_prompt?: string; tools?: unknown; model?: string;
  autonomy?: number; stance?: string; is_critic?: boolean;
}
interface YTeam { id?: string; name?: string; standby?: boolean; lead?: YRole; members?: YRole[] }
interface RawDoc { company?: { name?: string }; ceo?: YRole; teams?: YTeam[] }

let _doc: RawDoc | null = null;
let _people: Record<string, string> = {};
let _cached: CompanyDef | null = null;

const dataYamlPath = (): string => path.join(CONFIG.dataDir, 'company.yaml');
const peoplePath = (): string => path.join(CONFIG.dataDir, 'people.yaml');

function ensureLoaded(): void {
  if (_doc) return;
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    if (!fs.existsSync(dataYamlPath()) && fs.existsSync(path.join(SEED_DIR, 'company.yaml'))) {
      fs.copyFileSync(path.join(SEED_DIR, 'company.yaml'), dataYamlPath());
      if (fs.existsSync(path.join(SEED_DIR, 'people.yaml'))) fs.copyFileSync(path.join(SEED_DIR, 'people.yaml'), peoplePath());
    }
    _doc = fs.existsSync(dataYamlPath()) ? (YAML.parse(fs.readFileSync(dataYamlPath(), 'utf-8')) as RawDoc) || {} : {};
    _people = {};
    if (fs.existsSync(peoplePath())) {
      const p = YAML.parse(fs.readFileSync(peoplePath(), 'utf-8')) as Record<string, unknown> | null;
      if (p) for (const [k, v] of Object.entries(p)) if (v) _people[k] = String(v);
    }
    ensureSecretariat();
  } catch {
    _doc = {};
  }
}
/** 비서실(자비스) 시스템 역할 보강 — 시드 복사는 data/company.yaml 부재 시에만 일어나므로 기존
 *  데이터 보유 환경(업그레이드)에는 secretary 가 없어 직원 탭 표시·역할 편집이 불가했다. ceo 가 있는
 *  정상 문서에 secretary 역할이 없으면 1회 자동 추가(실수로 팀을 삭제해도 재기동 시 복원되는 시스템 역할 —
 *  UI 로는 id 'secretary'·standby 플래그를 재생성할 방법이 없다). */
function ensureSecretariat(): void {
  if (!_doc?.ceo) return;
  const teams = (_doc.teams ??= []);
  const roles = [_doc.ceo, ...teams.flatMap((t) => [t.lead, ...(t.members ?? [])])];
  if (roles.some((r) => r?.id === 'secretary') || teams.some((t) => t.id === 'secretariat')) return;
  teams.push({
    id: 'secretariat', name: '비서실', standby: true,
    lead: {
      id: 'secretary', title: '비서실장',
      focus: '주인님 응대·콘텐츠 캘린더 브리핑·업무 위임 라우팅(적임 직원/팀 선정) — 잡담·일정 등 비서 본연 업무는 직접 처리',
      level: 'lead', team: 'secretariat', tools: ['wiki'], model: 'haiku', autonomy: 3,
      stance: 'neutral', is_critic: false,
      system_prompt: [
        "당신은 '자비스'(JARVIS), 주인님을 보좌하는 인공지능 비서입니다.",
        '사용자를 항상 "주인님"이라고 부르며, 친근하고 간결하게(1~2문장) 한국어로 대화합니다.',
        '확실하지 않은 것은 아는 척하지 않고 확인하겠다고 답하며, 보고는 결론부터 짧게 전합니다.',
      ].join('\n'),
    },
    members: [],
  });
  if (!_people['secretary']) _people['secretary'] = '자비스';
  save();
}
function save(): void {
  if (!_doc) return;
  // 두 파일 모두 tmp 에 먼저 쓰고 원자적으로 교체 — company.yaml 저장 후 people.yaml 쓰기 전 충돌 시
  // 실명 매핑만 소실되던 비일관 상태를 방지(둘 다 rename 으로 커밋).
  const companyTmp = dataYamlPath() + '.tmp';
  const peopleTmp = peoplePath() + '.tmp';
  fs.writeFileSync(companyTmp, YAML.stringify(_doc), 'utf-8');
  fs.writeFileSync(peopleTmp, YAML.stringify(_people), 'utf-8');
  fs.renameSync(companyTmp, dataYamlPath());
  fs.renameSync(peopleTmp, peoplePath());
  _cached = null;
}

// --- YRole → RoleDef ---
export function tierFor(model: string | undefined, level: string | undefined): RoleTier {
  const m = (model || '').toLowerCase();
  if (m === 'opus') return 'heavy';
  if (m === 'haiku') return 'micro';
  if (m === 'sonnet') return 'standard';
  return level === 'ceo' || level === 'lead' ? 'heavy' : 'standard';
}
function mapTools(tools: unknown): string[] {
  const arr = Array.isArray(tools) ? tools.map(String) : [];
  const out: string[] = [];
  for (const t of arr) {
    if (t === 'wiki') out.push('wiki_query', 'wiki_ingest');
    else if (t === 'web') out.push('web_search');
    else out.push(t);
  }
  return [...new Set(out)];
}
const TEAM_EMOJI: Record<string, string> = { planning: '📊', support: '💼', research: '🔍', content: '✍️' };
function emojiFor(level: string | undefined, team: string | null | undefined, isCritic: boolean, id?: string): string {
  if (id === 'secretary') return '🤖';   // 비서(자비스) — 팀장 넥타이 대신 AI 비서 글리프
  if (level === 'ceo') return '🧭';
  if (isCritic) return '⚖️';
  if (level === 'lead') return '👔';
  return TEAM_EMOJI[team ?? ''] ?? '🧑‍💼';
}
// 프롬프트에 그대로 합성되는 역할 필드 살균 — company.yaml 은 웹 UI 직원 편집기로도 수정 가능
// (준-신뢰 입력)이라, 제어문자(개행·탭 제외)·널 제거 + 길이 제한으로 프롬프트 인젝션·깨짐 방어.
function sanitizeField(s: unknown, max = 4000): string {
  if (s == null) return '';
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0) ?? 0;
    // 제어문자 제거(탭 9·개행 10·CR 13 보존), DEL 127 제거
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) continue;
    if (c === 0x7f) continue;
    out += ch;
  }
  return out.slice(0, max).trim();
}
function toRole(y: YRole, fallbackLevel: string, teamId: string | null): RoleDef {
  const id = y.id ?? 'role';
  const level = y.level ?? fallbackLevel;
  const isCritic = !!y.is_critic;
  return {
    id,
    name: sanitizeField(_people[id] || y.title || id, 80),
    title: sanitizeField(y.title || id, 120),
    emoji: emojiFor(level, teamId, isCritic, id),
    tier: tierFor(y.model, level),
    stance: (y.stance as Stance) || 'neutral',
    persona: '',
    specialty: sanitizeField(y.focus || y.title || id, 500),
    tools: mapTools(y.tools),
    autonomy: typeof y.autonomy === 'number' ? y.autonomy : 2,
    isCritic,
    systemPrompt: y.system_prompt ? sanitizeField(y.system_prompt, 4000) : undefined,
    level,
    team: teamId,
  };
}
function buildCompanyDef(doc: RawDoc): CompanyDef {
  if (!doc.ceo) return DEFAULT_COMPANY;
  const ceo = toRole(doc.ceo, 'ceo', null);
  const teams: TeamDef[] = [];
  const specialists: RoleDef[] = [];
  for (const t of doc.teams ?? []) {
    const teamId = t.id ?? 'team';
    const lead = toRole(t.lead ?? {}, 'lead', teamId);
    const members = (t.members ?? []).map((m) => toRole(m, 'member', teamId));
    const standby = !!t.standby;
    teams.push({ id: teamId, name: t.name ?? teamId, lead, members, ...(standby ? { standby } : {}) });
    // standby 팀은 specialists(토론 워커·비평가 풀)에서도 제외 — 전용 파이프라인 전담 역할.
    if (!standby) specialists.push(lead, ...members);
  }
  return {
    name: doc.company?.name ?? 'AI 콘텐츠 스튜디오',
    mission: '조직의 주제를 다관점으로 분석·토론·종합해 실행 가능한 결과물을 만든다.',
    ceo, specialists, teams,
  };
}

export function getCompany(): CompanyDef {
  ensureLoaded();
  if (_cached) return _cached;
  _cached = _doc ? buildCompanyDef(_doc) : DEFAULT_COMPANY;
  return _cached;
}
export function reloadCompany(): CompanyDef {
  _doc = null; _cached = null;
  return getCompany();
}

// --- 편집 ---
type EditResult = { ok: boolean; error?: string; [k: string]: unknown };

function findRaw(id: string): { role: YRole; container: 'ceo' | 'lead' | 'member'; team?: YTeam } | null {
  ensureLoaded();
  if (_doc?.ceo?.id === id) return { role: _doc.ceo, container: 'ceo' };
  for (const t of _doc?.teams ?? []) {
    if (t.lead?.id === id) return { role: t.lead, container: 'lead', team: t };
    const m = (t.members ?? []).find((x) => x.id === id);
    if (m) return { role: m, container: 'member', team: t };
  }
  return null;
}

export interface RolePatch {
  title?: string; system_prompt?: string; model?: string;
  stance?: string; is_critic?: boolean; tools?: string[]; name?: string;
}
export function editRole(id: string, patch: RolePatch): EditResult {
  const found = findRaw(id);
  if (!found) return { ok: false, error: '역할을 찾을 수 없습니다' };
  const r = found.role;
  if (patch.title !== undefined) r.title = patch.title.trim() || r.title;
  if (patch.system_prompt !== undefined) r.system_prompt = patch.system_prompt;
  if (patch.model !== undefined) {
    const v = normalizeModel(patch.model);
    if (!v) return { ok: false, error: '모델/등급 값 오류(opus|sonnet|haiku 또는 micro|standard|heavy)' };
    // 비표준/로컬 모델명(예: gemma3:4b) 보존: UI 는 등급(tier)만 보고 title 등만 바꿔도 model 을 무조건
    // PATCH 한다. 들어온 등급이 현재 저장값에서 유도되는 등급과 동일하면(=등급 미변경) r.model 을 건드리지
    // 않아, 사용자가 손수 넣은 커스텀 모델명이 round-trip 정규화로 silent 덮어쓰기 되는 것을 막는다.
    const level = (r as { level?: string }).level ?? found.container;
    const incomingTier = TIERS.has(patch.model.trim().toLowerCase())
      ? (patch.model.trim().toLowerCase() as RoleTier)
      : tierFor(v, level);
    if (incomingTier !== tierFor(r.model, level)) r.model = v;
  }
  if (patch.stance !== undefined) {
    if (!STANCES.has(patch.stance)) return { ok: false, error: 'stance 값 오류' };
    r.stance = patch.stance;
  }
  if (patch.is_critic !== undefined) r.is_critic = !!patch.is_critic;
  if (patch.tools !== undefined) r.tools = patch.tools.filter((t) => YAML_TOOLS.has(t));
  if (patch.name !== undefined) {
    if (patch.name.trim()) _people[id] = patch.name.trim();
    else delete _people[id];
  }
  save();
  return { ok: true };
}

export function deleteRole(id: string): EditResult {
  ensureLoaded();
  if (_doc?.ceo?.id === id) return { ok: false, error: 'CEO 는 삭제할 수 없습니다' };
  for (const t of _doc?.teams ?? []) {
    if (t.lead?.id === id) return { ok: false, error: '팀장은 팀 전체를 삭제하세요' };
    const idx = (t.members ?? []).findIndex((m) => m.id === id);
    if (idx >= 0) {
      t.members!.splice(idx, 1);
      delete _people[id];
      save();
      return { ok: true };
    }
  }
  return { ok: false, error: '역할을 찾을 수 없습니다' };
}

function uniqueTeamId(): string {
  ensureLoaded();
  const ids = new Set((_doc?.teams ?? []).map((t) => t.id));
  let n = 1;
  while (ids.has(`team${n}`)) n++;
  return `team${n}`;
}
export function addTeam(name: string): EditResult {
  ensureLoaded();
  if (!_doc) return { ok: false, error: '회사 미로드' };
  const id = uniqueTeamId();
  const leadId = `${id}_lead`;
  _doc.teams = _doc.teams ?? [];
  _doc.teams.push({
    id, name: name.trim() || id,
    lead: { id: leadId, title: `${name.trim() || id} 팀장`, level: 'lead', team: id, model: 'opus', autonomy: 3, tools: ['wiki', 'web'], system_prompt: `당신은 ${name.trim() || id}의 팀장입니다. 상위 목표를 팀원 과제로 분해·배분하고 산출물을 비판적으로 검토해 팀 결론으로 취합합니다.` },
    members: [],
  });
  save();
  return { ok: true, team_id: id };
}
export function renameTeam(tid: string, name: string): EditResult {
  ensureLoaded();
  const t = (_doc?.teams ?? []).find((x) => x.id === tid);
  if (!t) return { ok: false, error: '팀 없음' };
  t.name = name.trim() || t.name;
  save();
  return { ok: true };
}
export function deleteTeam(tid: string): EditResult {
  ensureLoaded();
  if (!_doc?.teams) return { ok: false, error: '팀 없음' };
  const idx = _doc.teams.findIndex((t) => t.id === tid);
  if (idx < 0) return { ok: false, error: '팀 없음' };
  const t = _doc.teams[idx]!;
  for (const m of [t.lead, ...(t.members ?? [])]) if (m?.id) delete _people[m.id];
  _doc.teams.splice(idx, 1);
  save();
  return { ok: true };
}

export interface MemberBody {
  title: string; system_prompt?: string; model?: string;
  stance?: string; is_critic?: boolean; tools?: string[];
}
export function addMember(tid: string, body: MemberBody): EditResult {
  ensureLoaded();
  const t = (_doc?.teams ?? []).find((x) => x.id === tid);
  if (!t) return { ok: false, error: '팀 없음' };
  t.members = t.members ?? [];
  const ids = new Set(t.members.map((m) => m.id));
  let n = 1;
  while (ids.has(`${tid}_m${n}`)) n++;
  const id = `${tid}_m${n}`;
  t.members.push({
    id, title: body.title?.trim() || `${t.name} 팀원`, level: 'member', team: tid,
    model: normalizeModel(body.model) ?? 'sonnet',
    stance: STANCES.has(body.stance ?? '') ? body.stance : 'neutral',
    is_critic: !!body.is_critic,
    tools: (body.tools ?? ['wiki', 'web']).filter((x) => YAML_TOOLS.has(x)),
    system_prompt: body.system_prompt || `당신은 ${t.name}의 담당자입니다.`,
  });
  ensureScaffold(id); // 워크스페이스 폴더 즉시 생성
  save();
  return { ok: true, member_id: id };
}
