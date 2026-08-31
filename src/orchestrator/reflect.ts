/**
 * 자가학습(self-learning) 리플렉터 — 런 종료 후 각 참여 직원의 기여에서 한 줄 교훈을 뽑아
 * 그 직원 memory.md 에 누적한다(다음 런 시스템프롬프트에 자동 주입 → compounding).
 * (Connect AI 의 memory.md/decisions.md 자가학습 + P-Reinforce 대응)
 */
import { EventType } from '../events/types';
import type { EventBus } from '../events/bus';
import { microJSON } from './agent';
import { asString } from '../util/str';
import { appendMemory, appendDecision, appendActivity, readGoal, writeGoal, archiveMemory, extractVerifiedClaims, appendVerified, acceptVerifiedSource } from '../agents/workspace';
import { getCompany } from '../agents/company-loader';
import { llmWiki } from '../wiki/llmwiki';
import { groundingEntries } from './groundingLedger';

export interface Participant { id: string; name: string; text: string }

export async function reflectAndLearn(
  bus: EventBus, model: string, topic: string, participants: Participant[], deliverable: string, signal?: AbortSignal,
  verifiedInputs?: Array<{ id: string; text: string }>,
): Promise<number> {
  const c = getCompany();
  const roleById = new Map([c.ceo, ...c.specialists].map((r) => [r.id, r] as const));
  const valid = new Set(roleById.keys());
  const roster = participants.filter((p) => p.text.trim() && valid.has(p.id));
  if (!roster.length) {
    appendDecision(topic, deliverable.slice(0, 300));
    return 0;
  }
  const sys =
    '너는 회고 코치다. 각 직원의 이번 기여에서 (1) 다음 비슷한 작업에 재사용할 구체적 한 줄 교훈, ' +
    '(2) 담당업무와 이번 학습을 반영한 그 직원의 개인 목표 1~2문장을 한국어로 뽑는다. 일반론·칭찬 말고 구체적으로.';
  const user =
    `주제: ${topic}\n\n` +
    roster.map((p) => {
      const role = roleById.get(p.id);
      return `## ${p.name} (id: ${p.id})\n[담당업무] ${role?.specialty ?? ''}\n[이번 기여]\n${p.text.slice(0, 600)}`;
    }).join('\n\n') +
    `\n\nJSON만: {"lessons":[{"id":"직원id","insight":"한 줄 교훈"}],"goals":[{"id":"직원id","goal":"개인 목표 1~2문장"}]}`;
  const j = await microJSON<{
    lessons?: Array<{ id?: string; insight?: string }>;
    goals?: Array<{ id?: string; goal?: string }>;
    // 참여자 수에 비례해 출력 토큰 확대 — 고정 800 은 다팀(8명) JSON(교훈+목표 각 8개)을 잘라 파싱 실패(교훈 0)시켰다.
  }>(model, sys, user, { maxOutputTokens: Math.min(2400, 500 + roster.length * 220), signal });
  let n = 0;
  const learned = new Set<string>();
  const lessonsByAgent = new Map<string, string[]>();
  for (const l of j?.lessons ?? []) {
    const id = asString(l.id).trim();
    const insight = asString(l.insight).trim(); // LLM 이 insight 를 비문자열로 반환해도 안전(빈 문자열→스킵)
    if (id && insight && valid.has(id)) {
      appendMemory(id, insight); // 역량 강화: memory.md 누적 → 다음 런 시스템프롬프트 주입(compounding)
      appendActivity(id, `🎓 학습: ${insight.slice(0, 50).replace(/\s+/g, ' ')}${insight.length > 50 ? '…' : ''}`);
      bus.emit(EventType.lesson_learned, { title: insight, agent_id: id }, { agentId: id });
      learned.add(id);
      const arr = lessonsByAgent.get(id) ?? []; arr.push(insight); lessonsByAgent.set(id, arr);
      n++;
    }
  }
  // 가시화·축적: 교훈을 위키 'lesson' 페이지(직원당 1개, role:<id> 태그)로 누적 → UI 교훈 탭(/wiki/pages?category=lesson)
  // 과 두뇌 그래프에 표출. (memory.md 는 위에서 — 역량 강화용 프롬프트 주입. 위키는 전 기간 가시 축적용.)
  for (const [id, insights] of lessonsByAgent) {
    try {
      const nm = roleById.get(id)?.name ?? id;
      const w = llmWiki();
      w.upsertPage({
        title: `${nm} 교훈`, type: 'lesson',
        // 발원 런의 주제 요약 페이지와 [[링크]](실재 시) — 교훈 노드가 그래프에서 지식 본체와
        // 분리된 위성 섬이 되던 문제(2026-07-16 그래프 검토) 해소. ingest 가 reflect 보다 먼저라 대개 실재.
        body: insights.map((s) => `- ${s}`).join('\n') + w.relatedLine([], [`${topic} (요약)`]),
        aliases: [`role:${id}`], contributors: [nm], summary: insights[0]!.slice(0, 100),
      });
    } catch { /* 위키 적재 실패는 학습을 막지 않음 */ }
  }
  // 검증 지식 승격(Self-RAG, 스펙 §5) — [근거: 출처] 태그만으로는 부족하다(자기 인용·토론·성과 페이지·
  // 미실측 표시까지 통과했던 감사 실측). 거절 규칙 통과 + 이 런의 실제 조회 원장(groundingLedger)과
  // 근거 문자열이 일치할 때만 승격. 입력도 토론 전 R0(participants) 대신 **토론 후** 팀 산출물(verifiedInputs).
  let promoted = 0; let rejected = 0;
  const entries = groundingEntries(bus.runId);
  for (const p of (verifiedInputs ?? roster)) {
    if (!valid.has(p.id)) continue;
    for (const v of extractVerifiedClaims(p.text)) {
      if (!acceptVerifiedSource(v.claim, v.source, entries)) { rejected++; continue; }
      if (appendVerified(p.id, v.claim, v.source)) promoted++;
    }
  }
  if (promoted || rejected) {
    // 프로세스 로그에도 미러 — 원장 승격은 다음 런의 근거 자료를 바꾸므로 사후 추적이 필요하다.
    const m = `검증 지식 — 승격 ${promoted}건 · 거절 ${rejected}건(자기 인용·보류 표시·원장 불일치)`;
    console.log(`[검증지식] ${m}`);
    bus.emit(EventType.log, { message: m });
  }

  // 학습 누적분이 임계를 넘으면 오래된 교훈을 micro 로 요약·아카이브(폐기 대신 압축 — compounding 보존).
  for (const id of learned) {
    try { await archiveMemory(id, model, signal); } catch { /* 무해 */ }
  }
  // 개인목표 자동 채움(자가학습) — goal.md 가 비어있는 직원만. 사람이 직접 적은 목표는 보호.
  for (const g of j?.goals ?? []) {
    const id = asString(g.id).trim();
    const goal = asString(g.goal).trim(); // LLM 이 goal 을 비문자열로 반환해도 안전
    if (id && goal && valid.has(id) && !readGoal(id).trim()) {
      writeGoal(id, `# 개인 목표\n${goal}`);
      appendActivity(id, '🎯 개인목표 자동 설정(자가학습)');
    }
  }
  appendDecision(topic, deliverable.slice(0, 300));
  return n;
}
