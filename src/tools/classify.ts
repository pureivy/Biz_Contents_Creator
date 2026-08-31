/**
 * 자료 자동 직원귀속 분류 — LLM '사서'가 업무분장(역할 주력업무)을 대조해 1~3명에게 귀속.
 * 귀속된 자료는 각 직원 workspace 의 knowledge.md 에 기록(다음 런 그라운딩 소스).
 * 상태(pending/done/failed)는 data/classify_status.json 에 영속 — 프론트 정산 패널이 폴링.
 * (원본 GEPA orchestrator/classify_material.py 포팅)
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { llm } from '../llm/client';
import { getCompany } from '../agents/company-loader';
import { appendKnowledge, removeKnowledge } from '../agents/workspace';

export interface IngestStatus { state: 'pending' | 'done' | 'failed'; entities: string[]; }
export interface ClassifyStatus {
  state: 'pending' | 'done' | 'failed' | 'unknown';
  assigned: string[];
  title?: string;
  ingest?: IngestStatus; // 자료 ingest(엔티티/개념 추출) 결과 — 같은 ref 에 병합
}

const statusPath = (): string => path.join(CONFIG.dataDir, 'classify_status.json');
function loadStatus(): Record<string, ClassifyStatus> {
  try { return JSON.parse(fs.readFileSync(statusPath(), 'utf-8')) as Record<string, ClassifyStatus>; } catch { return {}; }
}
function saveStatus(s: Record<string, ClassifyStatus>): void {
  try { fs.mkdirSync(CONFIG.dataDir, { recursive: true }); fs.writeFileSync(statusPath(), JSON.stringify(s, null, 2), 'utf-8'); } catch { /* */ }
}
function setStatus(ref: string, st: Partial<ClassifyStatus>): void {
  const all = loadStatus();
  all[ref] = { state: 'pending', assigned: [], ...all[ref], ...st } as ClassifyStatus; // 병합 — classify/ingest 독립 갱신
  saveStatus(all);
}
/** 자료 ingest 결과를 같은 ref 에 병합 기록(정산 패널 폴링용). */
export function setIngestStatus(ref: string, ingest: IngestStatus): void {
  setStatus(ref, { ingest });
}
export function getStatuses(refs: string[]): Record<string, ClassifyStatus> {
  const all = loadStatus();
  const out: Record<string, ClassifyStatus> = {};
  for (const r of refs) out[r] = all[r] ?? { state: 'unknown', assigned: [] };
  return out;
}

function roster(): string {
  return getCompany().specialists.map((r) => `${r.id} | ${r.title} | ${r.specialty}`).join('\n');
}
function validIds(): Set<string> {
  return new Set(getCompany().specialists.map((r) => r.id)); // CEO 제외(specialists 는 비-CEO)
}

export function firstJson<T>(raw: string): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const s = body.search(/[[{]/);
  if (s < 0) return null;
  const open = body[s]!; const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(body.slice(s, i + 1)) as T; } catch { return null; } } }
  }
  return null;
}

async function classifyLLM(model: string, title: string, text: string, signal?: AbortSignal): Promise<string[]> {
  const sys =
    '당신은 사내 문서를 분석해 어느 직원의 업무 지식으로 가장 적합한지 분류하는 사서입니다.\n' +
    `직원 목록(id | 직책 | 주력업무):\n${roster()}\n\n` +
    '자료 내용을 보고 직접 관련된 직원 1~3명의 id 를 고르세요. 직책명 통념이 아니라 주력업무(업무분장)로 대조해 판단하고, 무리하게 여러 명에게 주지 마세요.';
  const user = `자료 제목: ${title}\n\n발췌:\n${(text || '').slice(0, 3000)}\n\nJSON만 출력: {"assignments":["employee_id", ...]}`;
  const res = await llm.chat({
    model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    maxOutputTokens: 200, temperature: 0.2, think: false, signal, // 분류는 단순 라우팅 — 추론 끔(저지연; 자비스와 동일)
  });
  const j = firstJson<{ assignments?: string[] }>(res.text);
  const valid = validIds();
  const out: string[] = [];
  for (const id of j?.assignments ?? []) if (valid.has(id) && !out.includes(id)) out.push(id);
  return out.slice(0, 3);
}

/** 백그라운드 분류 + 귀속. 실패해도 업로드를 깨지 않음. */
export async function classifyAndAssign(ref: string, title: string, text: string, model: string, signal?: AbortSignal): Promise<string[]> {
  setStatus(ref, { state: 'pending', assigned: [], title });
  try {
    const assigned = await classifyLLM(model, title, text, signal);
    for (const id of assigned) appendKnowledge(id, `- [${title}] 귀속자료 (ref:${ref})`);
    setStatus(ref, { state: 'done', assigned, title });
    return assigned;
  } catch {
    setStatus(ref, { state: 'failed', assigned: [], title });
    return [];
  }
}

/** 오귀속 수동 교정 — 기존 귀속 전부 제거 후 지정 직원 1명에게 재귀속. */
export function reassign(ref: string, toId: string): { ok: boolean; assigned_label?: string; error?: string } {
  if (!validIds().has(toId)) return { ok: false, error: '대상 직원 없음' };
  const all = loadStatus();
  const cur = all[ref];
  for (const id of cur?.assigned ?? []) removeKnowledge(id, `ref:${ref}`);
  const title = cur?.title ?? ref;
  appendKnowledge(toId, `- [${title}] 귀속자료 (ref:${ref})`);
  all[ref] = { state: 'done', assigned: [toId], title };
  saveStatus(all);
  const role = getCompany().specialists.find((r) => r.id === toId);
  return { ok: true, assigned_label: role ? `${role.name}(${role.title})` : toId };
}
