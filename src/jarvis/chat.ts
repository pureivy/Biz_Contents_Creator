/** 자비스(비서) 대화 코어 — 페르소나로 llm.chat 단일 호출, 업무지시면 delegate JSON 방출.
 *  format:'json' 미사용(자유응답 보존) → 자유 텍스트 후 firstJson 으로 delegate 추출. */
import { llm } from '../llm/client';
import { resolveAssignment } from '../llm/setting';
import { getCompany } from '../agents/company-loader';
import { rolesById } from '../agents/company';
import { firstJson } from '../tools/classify';   // Step 3a 에서 classify.ts 가 export 노출
import { kstNowKo } from '../util/time';
import { pieceStore, type Piece, type PieceStage } from '../content/pieces';

export interface JarvisTurn { role: 'user' | 'assistant'; content: string }
export interface JarvisReply { reply: string; delegate?: { task: string; agent?: string } }

const SECRETARY_ID = 'secretary';   // 자비스 본인(비서실 lead) — 위임 대상에서 제외(자기위임 방지)

/** 로스터의 비서(자비스) 역할 — 직원 탭에서 편집한 페르소나·처리 등급이 자비스에 실반영되는 연결점. */
function secretaryRole() {
  return rolesById(getCompany()).get(SECRETARY_ID);
}
/** 페르소나 머리말 — secretary 역할 system_prompt(직원 탭에서 편집 가능)가 있으면 그것을, 없으면 내장 기본. */
export function jarvisPersona(role?: { systemPrompt?: string }): string[] {
  const p = role?.systemPrompt?.trim();
  if (p) return [p];
  return [
    "당신은 '자비스'(JARVIS), 주인님을 보좌하는 인공지능 비서입니다.",
    '사용자를 항상 "주인님"이라고 부르며, 친근하고 간결하게(1~2문장) 한국어로 대화합니다.',
  ];
}

/** 위임 대상 후보 — 비-CEO 직원에서 비서(자비스) 자신을 뺀 목록. 자비스가 이 중 1명을 고른다.
 *  (specialists 자체는 office 뷰·org 모드가 쓰므로 건드리지 않고, 여기서만 필터.) */
function delegatableSpecialists() {
  return getCompany().specialists.filter((r) => r.id !== SECRETARY_ID);
}
function roster(): string {
  // id | 실명 | 직함 | 주요 업무(specialty). specialty 는 재원(일반회계 vs 수탁회계)·겸장 사업·
  // 계약/감사/IT 등 변별 단서를 담아 정확한 라우팅에 결정적 — title 만으론 인접 직무가 안 갈림.
  return delegatableSpecialists()
    .map((r) => {
      const spec = (r.specialty ?? '').replace(/\s*\(※[^)]*\)\s*/g, ' ').trim(); // 토론 전용 비평가 주석 제거
      const s = spec.length > 150 ? spec.slice(0, 150) + '…' : spec;
      return `${r.id} | ${r.name ?? ''} | ${r.title}${s ? ' | ' + s : ''}`;
    })
    .join('\n');
}
function validAgentIds(): Set<string> {
  return new Set(delegatableSpecialists().map((r) => r.id));
}

const STAGE_KO: Record<PieceStage, string> = {
  idea: '아이디어', research: '리서치 중', draft: '초안 작성 중', ready: '검토 대기(발행 준비 완료)',
  published: '발행됨', measured: '성과 측정됨', reflected: '회고 완료', error: '오류로 멈춤',
};
/** 콘텐츠 캘린더 브리핑 — '일정 정리/브리핑/다음 할 일' 질문에 자비스가 실제 데이터로 답하게 주입.
 *  비서 본연의 일정 관리(사용자 요청): 추측 대신 piece 스토어(자율 캘린더의 단일 진실)를 근거로. */
export function calendarBrief(): string {
  try {
    const all = pieceStore().list();
    if (!all.length) return '등록된 콘텐츠가 아직 없습니다(자율 사이클이 아이디어를 만들면 채워집니다).';
    const by = (s: PieceStage) => all.filter((p) => p.stage === s);
    const fmt = (p: Piece) => `「${p.title}」${p.keyword ? `(${p.keyword})` : ''}`;
    const stages: PieceStage[] = ['idea', 'research', 'draft', 'ready', 'published', 'measured', 'reflected', 'error'];
    const counts = stages.map((s) => [s, by(s).length] as const).filter(([, n]) => n > 0)
      .map(([s, n]) => `${STAGE_KO[s]} ${n}건`).join(', ');
    const lines = [`전체 ${all.length}건 — ${counts}`];
    const ready = by('ready').slice(-5);
    if (ready.length) lines.push(`발행 대기(주인님 검토 필요): ${ready.map(fmt).join(' / ')}`);
    const wip = all.filter((p) => ['idea', 'research', 'draft'].includes(p.stage)).slice(-5);
    if (wip.length) lines.push(`진행 중: ${wip.map((p) => `${fmt(p)}[${STAGE_KO[p.stage]}]`).join(' / ')}`);
    const pub = by('published').slice(-3);
    if (pub.length) lines.push(`최근 발행: ${pub.map(fmt).join(' / ')}`);
    const err = by('error');
    if (err.length) lines.push(`주의 — 오류로 멈춘 콘텐츠 ${err.length}건: ${err.slice(-3).map(fmt).join(' / ')}`);
    return lines.join('\n');
  } catch { return ''; }
}

export function jarvisSystemPrompt(): string {
  // 짧은 페르소나 + 직원 명단(위임 대상 선택용). 잡담 저지연 위해 장문 회사 페르소나는 안 씀.
  // 팀장 id 는 실제 회사 로스터에서 동적으로 — 하드코딩(구 정부 팀 id) 제거.
  // standby 팀장(카드뉴스·숏폼·비서실)은 specialists 에 없어 위임이 불가하므로 팀장 규칙에서도 제외
  // — 규칙에만 있고 로스터에 없는 id 를 모델이 고르면 validAgentIds 에서 버려져 전사 런으로 강등되던 불일치 해소.
  const leads = (getCompany().teams ?? [])
    .filter((t) => !t.standby)
    .map((t) => t.lead.id)
    .filter((id) => id !== SECRETARY_ID);
  const leadRule = leads.length
    ? `담당 선택: 특정 분야의 구체적 실무는 그 분야 담당자에게, 여러 분야가 걸친 복합 업무나 팀 전체 총괄·방향 설정은 팀장(${leads.join('·')})에게 맡깁니다.`
    : '담당 선택: 각 업무를 가장 적합한 담당자에게 맡깁니다.';
  return [
    ...jarvisPersona(secretaryRole()),
    `현재 시각은 ${kstNowKo()} 입니다. 오늘 날짜·요일·시간을 묻는 질문에는 반드시 이 값(대한민국 표준시)을 기준으로 답하고, 학습 시점의 날짜를 추측하지 마세요.`,
    '인사·잡담·간단한 질의, 그리고 일정 관리·미팅 예약·메모·받아쓰기 등 비서 본연의 일은 JSON 없이 직접 답하고 위임하지 않습니다.',
    '일정 정리·브리핑·다음 할 일·발행 대기 확인 등 콘텐츠 일정 질문에는 아래 [콘텐츠 캘린더 현황]을 근거로 직접 요약해 답합니다(추측·위임 금지). 발행 대기 건이 있으면 검토를 정중히 권합니다.',
    '[콘텐츠 캘린더 현황]',
    calendarBrief(),
    '그 밖의 실행 가능한 업무 지시이면, 짧은 확인 응답 후 마지막 줄에 JSON 한 줄로',
    '{"delegate":{"task":"<과제 한 문장>","agent":"<아래 직원 목록 id 중 그 일에 가장 적합한 1명>"}} 를 출력합니다.',
    leadRule,
    '직원 목록(id | 실명 | 직함 | 주요 업무):',
    roster(),
  ].join('\n');
}

function resolveModel(): string {
  // 비서 역할(secretary)의 처리 등급을 따른다(직원 탭 편집 반영). 역할 미등록 시 저지연 micro 폴백.
  // 주의: YAML 손편집으로 secretary.model 을 지우거나 비표준 값으로 두면 tierFor 의 lead 기본(heavy)이
  // 적용돼 잡담이 조용히 승격된다 — UI 편집(normalizeModel 검증)에서는 발생하지 않는 손편집 한정 엣지.
  const tier = secretaryRole()?.tier ?? 'micro';
  return resolveAssignment()[tier];
}

export async function jarvisChat(
  messages: JarvisTurn[],
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<JarvisReply> {
  const model = opts.model ?? resolveModel();
  const res = await llm.chat({
    model,
    messages: [{ role: 'system', content: jarvisSystemPrompt() }, ...messages.slice(-8)],
    maxOutputTokens: 200, temperature: 0.4, think: false, signal: opts.signal, // think:false → 잡담 저지연(추론 토글 무관)
  });
  const raw = (res.text ?? '').trim();
  const j = firstJson<{ delegate?: { task?: string; agent?: string } }>(raw);
  const task = j?.delegate?.task;
  if (task && String(task).trim()) {
    const reply = raw.replace(/\{[\s\S]*\}\s*$/, '').trim() || '네, 처리하겠습니다.';
    const a = j?.delegate?.agent ? String(j.delegate.agent).trim() : '';
    const agent = a && validAgentIds().has(a) ? a : undefined;   // 유효 직원 id 만 채택
    return { reply, delegate: agent ? { task: String(task).trim(), agent } : { task: String(task).trim() } };
  }
  return { reply: raw };
}
