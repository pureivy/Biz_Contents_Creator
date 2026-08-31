/**
 * 세션 다이제스트 — 런 산출물을 사람이 읽는 마크다운으로 영속화(원본 GEPA sessions/<run_id>/ 패리티).
 *   _brief.md   : 주제 + 하위문제 + 모델 배정
 *   _report.md  : 최종 종합 산출물
 *   <agent>.md  : 에이전트별 산출물
 */
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import type { FactGateResult } from '../content/factGate';
import type { StructureSeed } from '../content/structureSeed';

export interface AgentOutput {
  id: string;
  name: string;
  stage: string;
  text: string;
}

export interface DigestInput {
  runId: string;
  topic: string;
  subproblems: Array<{ id: string; text: string }>;
  modelAssignmentReason: string;
  agentOutputs: AgentOutput[];
  deliverable: string;
}

export async function writeDigest(d: DigestInput): Promise<string> {
  const dir = path.join(CONFIG.sessionsDir, d.runId);
  await mkdir(dir, { recursive: true });

  const brief =
    `# 브리프 — ${d.topic}\n\n` +
    `- run: \`${d.runId}\`\n- 모델 배정: ${d.modelAssignmentReason}\n\n` +
    `## 하위 문제\n${d.subproblems.map((s) => `- (${s.id}) ${s.text}`).join('\n')}\n`;
  await writeFile(path.join(dir, '_brief.md'), brief, 'utf-8');

  await writeFile(
    path.join(dir, '_report.md'),
    `# 최종 종합 — ${d.topic}\n\n${d.deliverable}\n`,
    'utf-8',
  );

  await Promise.all(
    d.agentOutputs.map((a) =>
      writeFile(
        path.join(dir, `${a.id}.md`),
        `# ${a.name} (${a.stage})\n\n${a.text}\n`,
        'utf-8',
      ),
    ),
  );

  return dir;
}

const sessionFile = (runId: string, name: string): string => path.join(CONFIG.sessionsDir, runId, name);
function writeSessionFile(runId: string, name: string, content: string): void {
  fs.mkdirSync(path.join(CONFIG.sessionsDir, runId), { recursive: true });
  fs.writeFileSync(sessionFile(runId, name), content, 'utf-8');
}
/** 리서치 브리프(팀 산출물 종합) — 리비전 런이 같은 근거로 개정하게 영속화(스펙 §3). */
export function writeResearchBrief(runId: string, brief: string): void { writeSessionFile(runId, 'research_brief.md', brief); }
export function readResearchBrief(runId: string): string {
  try { return fs.readFileSync(sessionFile(runId, 'research_brief.md'), 'utf-8'); } catch { return ''; }
}
/** 리비전용 브리프 — research_brief.md 가 없으면(이 기능 이전 런) 같은 세션의 work 단계 에이전트 산출물(<id>.md, 첫 줄 "# 이름 (work)")을 이어 붙여 브리프로 쓴다. */
export function readResearchBriefWithFallback(runId: string): string {
  const direct = readResearchBrief(runId);
  if (direct.trim()) return direct;
  try {
    const dir = path.join(CONFIG.sessionsDir, runId);
    const parts: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('_') || f.startsWith('draft')) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf-8');
      const first = text.split('\n')[0] ?? '';
      if (!/\(work\)\s*$/.test(first)) continue;
      parts.push(text.replace(/^# /, '## '));
    }
    return parts.join('\n\n');
  } catch { return ''; }
}
/** 사실 카드(2026-08-26) — 브리프에서 근거 확인된 사실만 압축한 카드. 리비전 런이 같은 카드를 재사용하게 영속화. */
export function writeFactCard(runId: string, card: string): void { writeSessionFile(runId, 'fact_card.md', card); }
export function readFactCard(runId: string): string {
  try { return fs.readFileSync(sessionFile(runId, 'fact_card.md'), 'utf-8'); } catch { return ''; }
}
/** 블로그 문체 린트 결과(2026-08-27 권고 3) — 수정 1회 뒤 '잔존' 지적. 검토 알림(contentNotify)이 건수만 읽어
 * '✍ 문체 N건 잔존' 한 줄로 보여 준다. 사실 게이트와 별개 파일이라 FACT_GATE=off 여도 표시가 살아 있다. */
export interface StyleLintRecord { issues: string[]; before: number; checkedTs: string }
export function writeStyleLint(runId: string, r: StyleLintRecord): void { writeSessionFile(runId, 'style_lint.json', JSON.stringify(r, null, 2)); }
export function readStyleLint(runId: string): StyleLintRecord | null {
  // Fix round 1 — issues 배열까지 확인한다. 파싱은 되는데 필드가 없는 구·손상 기록을 그대로 돌려주면 호출부의
  // `.issues.length` 가 TypeError 를 내고, 그 예외를 notifyBlogReady 의 바깥 try 가 삼켜 텔레그램뿐 아니라
  // 웹훅 알림까지 통째로 사라진다(검토 대기 자체를 모르게 된다).
  try {
    const r = JSON.parse(fs.readFileSync(sessionFile(runId, 'style_lint.json'), 'utf-8')) as StyleLintRecord;
    return r && Array.isArray(r.issues) ? r : null;
  } catch { return null; }
}
/** 브리프 게이트 기록(2026-08-28) — 팩트체커 판정과 재작업 결과. 검토 알림(contentNotify)이 읽어
 * '⚖ 브리프 반려 43/70 · 미해소 3건' 한 줄로 보여 준다. 사실 게이트·문체 린트와 별개 파일이라
 * FACT_GATE=off 여도 표시가 살아 있다(같은 이유로 style_lint.json 도 분리돼 있다). */
export interface BriefGateRecord {
  /** 최종 라운드 판정 — 'approved' | 'revision_needed' | 'unparsed'. */
  verdict: string;
  score: number | null;
  maxScore: number | null;
  /** 실제로 돈 재작업 라운드 수(0 = 첫 판정에 통과했거나 라운드 상한이 0). */
  rounds: number;
  /** 미해소 지적 요약 — 작가에게 '필수 반영'으로 주입한 것과 같은 목록. */
  unresolved: string[];
  checkedTs: string;
}
export function writeBriefGate(runId: string, r: BriefGateRecord): void { writeSessionFile(runId, 'brief_gate.json', JSON.stringify(r, null, 2)); }
export function readBriefGate(runId: string): BriefGateRecord | null {
  // style_lint 와 같은 방어 — 파싱은 되는데 필드가 빠진 구·손상 기록을 그대로 돌려주면 호출부의
  // `.unresolved.length` 가 TypeError 를 내고, notifyBlogReady 의 바깥 try 가 그 예외를 삼켜
  // 텔레그램·웹훅 알림이 통째로 사라진다(검토 대기 자체를 모르게 된다).
  try {
    const r = JSON.parse(fs.readFileSync(sessionFile(runId, 'brief_gate.json'), 'utf-8')) as BriefGateRecord;
    return r && typeof r.verdict === 'string' && Array.isArray(r.unresolved) ? r : null;
  } catch { return null; }
}
/** 런별 구조 시드(2026-08-27 권고 4) — 리비전 런이 baseRunId 로 같은 골격을 승계하게 영속화.
 * 파싱은 되는데 필드가 빠진 구·손상 기록은 null 로 떨어뜨린다(호출부가 유지 블록으로 가게 — style_lint 와 같은 방어). */
export function writeStructureSeed(runId: string, seed: StructureSeed): void { writeSessionFile(runId, 'structure.json', JSON.stringify(seed, null, 2)); }
export function readStructureSeed(runId: string): StructureSeed | null {
  try {
    const r = JSON.parse(fs.readFileSync(sessionFile(runId, 'structure.json'), 'utf-8')) as StructureSeed;
    return r && typeof r.thesisQuote === 'string' && typeof r.openers === 'string'
      && typeof r.cardLines === 'number' && typeof r.hashtags === 'number' && typeof r.shortsScenes === 'number'
      && typeof r.table === 'boolean' && typeof r.checklist === 'boolean' && typeof r.teaser === 'boolean'
      ? r : null;
  } catch { return null; }
}
/** 사실 게이트 결과(스펙 §2-2) — advancePieceReady 가 piece 로 옮긴다. */
export function writeFactGate(runId: string, r: FactGateResult): void { writeSessionFile(runId, 'fact_gate.json', JSON.stringify(r, null, 2)); }
export function readFactGate(runId: string): FactGateResult | null {
  try { return JSON.parse(fs.readFileSync(sessionFile(runId, 'fact_gate.json'), 'utf-8')) as FactGateResult; } catch { return null; }
}
