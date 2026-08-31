/**
 * 오케스트레이터 디스패처 — RUN_MODE 에 따라 org(위계) 또는 debate(평면) 모드 선택.
 */
import { CONFIG } from '../config';
import { getCompany } from '../agents/company-loader';
import type { EventBus } from '../events/bus';
import { runOffice } from './run';
import type { RunOptions, RunOutcome } from './run';
import { runOrg } from './org';
import { runDirected } from './directed';

// 단축경로(Connect AI 벤치마킹) — '조회·확인·현황'류 단순 질의는 분해·토론 없이 CEO 단독 즉답으로
// 오버헤드를 줄인다. '분석·전략·계획·수립'류 동사가 있거나 긴 질의는 풀 분해로 보낸다.
const LOOKUP_RE = /(조회|확인|검색|현황|알려줘|보여줘|언제|어디|얼마|몇\s|뭐(야|니|예요)|찾아)/;
const ANALYSIS_RE = /(분석|전략|계획|방안|설계|수립|평가|검토|비교|보고서|로드맵|개선|종합|토론|발굴)/;
function isLookup(topic: string): boolean {
  const t = (topic || '').trim();
  return t.length > 0 && t.length <= 40 && LOOKUP_RE.test(t) && !ANALYSIS_RE.test(t);
}

export function startRun(bus: EventBus, opts: RunOptions): Promise<RunOutcome> {
  // 로드된 회사(data/company.yaml, 없으면 시드)를 주입 — 모든 런 엔진이 동일 로스터 사용.
  const company = opts.company ?? getCompany();
  const o: RunOptions = { ...opts, company };
  // 리비전 런(검토 탭 '수정 요청') — 항상 org 엔진의 fast-path 로(단축경로·토론 모드 우회).
  if (o.revise) return runOrg(bus, o);
  // 직원 지명 런 → 단독 응답(가장 빠름).
  if (o.agentId) return runDirected(bus, o);
  // 단축경로 — auto 모드(명시 path 없음)에서 단순 조회성 질의는 CEO 단독 즉답으로 빠르게.
  // piece 연결 런(콘텐츠 제작)은 제외 — 질문형 제목("…언제 관리할까")이 '언제'에 걸려 즉답으로 빠지면
  // draft.json 없는 ready 조각이 좌초한다(실측 2026-08-07: 첫 클러스터 형제 소진에서 발생).
  if (!o.path && !o.pieceId && isLookup(o.topic)) {
    bus.emit('log', { message: '단축경로 — 단순 조회로 판단해 분해 없이 단독 즉답' });
    return runDirected(bus, { ...o, agentId: company.ceo.id });
  }
  const hasTeams = (company.teams?.length ?? 0) > 0;
  // path 'team'/'full' 또는 RUN_MODE=org → 조직 모드(팀 있을 때). 그 외 평면 토론.
  const wantOrg = o.path === 'team' || o.path === 'full' || CONFIG.runMode === 'org';
  return wantOrg && hasTeams ? runOrg(bus, o) : runOffice(bus, o);
}

export type { RunOptions, RunOutcome } from './run';
