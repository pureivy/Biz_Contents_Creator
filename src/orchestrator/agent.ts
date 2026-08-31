/**
 * 에이전트 실행 — GEPA의 풀 Claude CLI 에이전틱 루프를 대체하는 **경량 직접 호출** 경로.
 *
 * 핵심: 역할별 최소 시스템 프롬프트만 싣고 ollama.chat 으로 바로 스트리밍. 거대한 Claude Code
 * 시스템 프롬프트/전체 툴 스키마/MCP를 매 턴 프리필하던 비용이 사라진다(로컬 속도의 본질적 개선).
 *
 * - runAgent: 전문가/CEO 한 턴(spawn 이벤트 → 토큰 스트림 → 완성 메시지 → llm_metric).
 * - microCall/microJSON: 분해·배정·수렴판정·분류 같은 구조적 단발 호출(작은 모델, 비스트리밍).
 */
import { CONFIG } from '../config';
import { llm } from '../llm/client';
import type { ChatMessage, ChatResult } from '../llm/types';
import { EventType } from '../events/types';
import type { EventBus } from '../events/bus';
import type { RoleDef } from '../agents/company';
import { kstNowKo } from '../util/time';
import { genId } from '../util/ids';
import { isAbort } from '../util/abort';
import { llmWiki } from '../wiki/llmwiki';
import { webSearch } from '../tools/web_search';
import { personaExtra, effectiveTools, effectiveAutonomy, appendActivity, appendKnowledge } from '../agents/workspace';
import { brandContext } from '../content/brand';
import { connectors } from '../grounding';
import { noteGrounding } from './groundingLedger';
import { approvalStore } from '../approvals/store';
import { parseToolCalls, toolsForAutonomy, toolInstructions, stripToolTags, WRITE_TOOLS, type ToolCall } from './tools';
import { runCommand } from './shell';
import { runImageGenerate, runBlogPublish } from '../tools/blog_skills';

// 검증 지식(Self-RAG) — 사실 주장에 [근거] 태그를 유도. 런 후 reflect 가 태그 붙은 주장만
// verified.md 로 승격해 다음 런에 우선 신뢰 주입(환각 억제·근거 기반 compounding).
const VERIFIED_NOTE =
  '\n\n검증 가능한 핵심 사실 주장에는 문장 끝에 [근거: 출처] 를 붙여라(예: [근거: 2024 경영평가 보고서]). 근거 없는 추측에는 붙이지 마라.';

/** 역할 → 최소 시스템 프롬프트. 길게 쓰지 않는다(프리필 절약이 목적).
 *  opts.brevity=false 면 로컬 간결지침(2000~4000자 상한)을 생략 — 최종 산출물(합성)처럼 충분한 분량이 필요한 단계용. */
export function buildSystemPrompt(role: RoleDef, extra = '', opts: { brevity?: boolean } = {}): string {
  // 로컬 간결지침(localBrevityNote)은 Ollama 백엔드 제거와 함께 삭제 — opts.brevity 는
  // 호출부 호환을 위해 시그니처만 유지한다(Claude 는 분량을 프롬프트 규격으로 통제).
  void opts;
  // 워크스페이스 진화(prompt.md·goal.md·skills) 주입 → 직원 편집이 런에 실제 반영.
  const tail = [extra, personaExtra(role.id)].filter(Boolean).join('\n\n');
  // 현재 시각(KST) 주입 — 에이전트가 '오늘'을 실제 날짜로 인지(학습시점 추측 방지).
  const dateNote = `오늘은 ${kstNowKo()} 입니다.`;
  // 브랜드(고객사) 컨텍스트 — 설정 시 전 직원이 '누구를 위해' 만드는지 인지(미설정=빈 문자열, 기존 동작 불변).
  const brandNote = brandContext();
  if (role.systemPrompt) {
    // company.yaml 의 풍부한 시스템 프롬프트 사용(실명·직책·기관 맥락 보존).
    const head = `당신은 "${role.name}"(${role.title})입니다.`;
    return [head, dateNote, brandNote, role.systemPrompt, tail].filter(Boolean).join('\n\n') + VERIFIED_NOTE;
  }
  const lines = [
    `당신은 "${role.name}" — ${role.title}.`,
    dateNote,
    ...(brandNote ? [brandNote] : []),
    `전문 영역: ${role.specialty}.`,
  ];
  if (role.persona) lines.push(`태도/말투: ${role.persona}`);
  if (role.isCritic) lines.push('역할상 반드시 비판적으로 검토하고 약점·반례를 우선 제시하라.');
  if (tail) lines.push(tail);
  return lines.join('\n') + VERIFIED_NOTE;
}

export interface AgentRunArgs {
  bus: EventBus;
  role: RoleDef;
  model: string;
  /** 이번 턴의 지시/질문. */
  task: string;
  /** 그라운딩 컨텍스트(위키·타 에이전트 산출물 등). */
  context?: string;
  /** 'work' | 'critique' | 'rebuttal' | 'synthesis' | ... — 스트림 종류/지표 태깅. */
  stage: string;
  /** 능동 도구 루프 강제 오버라이드 — 미지정 시 stage==='work' 규칙. 지명(directed) 런은
   *  synthesis 스테이지지만 사용자가 특정 직원에게 조사를 시키는 경로라 true 로 켠다. */
  toolLoop?: boolean;
  /** 빈 출력 시 승급 재시도할 상위 tier 모델(소형 모델 무음 실패 구제). */
  fallbackModel?: string;
  blockId?: string;
  maxOutputTokens?: number;
  /** 추론(extended thinking) 강제 오버라이드 — 미지정 시 UI 토글을 따른다. 단발 JSON 기획 호출은
   *  false 로 못박아라: sonnet-5 가 제약 많은 기획 프롬프트에서 사고를 폭주시켜 출력 상한(예산×3)을
   *  6000→12000까지 전부 소진하며 연쇄 실패한 실측(2026-08-11 카드뉴스 파생 4연속) 대응. */
  think?: boolean;
  /** agent_spawned 이벤트를 emit 할지(첫 등장 시 true). */
  emitSpawn?: boolean;
  subproblemId?: string;
  /** 시스템 프롬프트에 덧붙일 런 스코프 지침(예: 블로그 작가 말투/페르소나). role.systemPrompt 뒤에
   *  붙어 우선 적용된다. 도구 루프 안내와 함께 buildSystemPrompt 의 extra 로 합쳐진다. */
  systemExtra?: string;
  /** 위키 그라운딩 질의 — 역할이 wiki_query 툴을 가지면 작업 전 관련 지식을 조회·주입. */
  groundQuery?: string;
  /** 그라운딩 히트 수(기본 6). 합성 섹션처럼 1차 원문이 집중된 경우 작게(예: 3) 주면 프리필이 줄어 빨라진다. */
  groundLimit?: number;
  /** true 면 웹·외부 커넥터(법령·KOSIS 등) 그라운딩을 건너뛰고 위키만 사용. 합성 단계는 팀이 이미 외부
   *  데이터를 모았으므로 섹션마다 느린 외부 API 를 재호출하지 않게 한다(통합 속도 — 사용자 요청). */
  groundWikiOnly?: boolean;
  /** 집필용 사실 조회 — performance·debate·overview·lesson 제외, LLM 스텁 감가(스펙 §4). */
  groundForFacts?: boolean;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  blockId: string;
  result: ChatResult;
}

/**
 * 실데이터 그라운딩 강제(이슈12) — 위키/커넥터 근거가 주입된 작업·종합 단계에서는 실제 수치·명칭을
 * 인용하게 하고 플레이스홀더·가정값을 금지한다. 자료에 없으면 지어내지 말고 누락을 명시(요청 자료까지).
 *
 * forFacts(=groundForFacts, 블로그 본문 작가) 경로에서는 3)·4) 를 뺀다(2026-08-26 최종 리뷰 F2):
 * 사실 게이트의 extractFactClaims 가 주장 텍스트를 그대로 뜨므로, 본문 문장에 박힌
 * "[근거: 확립된 원예학 지식]" 이 판정기를 어휘적으로 supported 쪽으로 밀어 무근거 주장이 게이트를
 * 통과한다 — 표식으로 표식을 세탁하는 고리가 다시 열린다. 사람이 읽는 리서치 work 산출물은 4규칙 유지.
 */
export function buildGroundDirective(hasGround: boolean, stage: string, forFacts: boolean): string {
  if (!hasGround || (stage !== 'work' && stage !== 'synthesis')) return '';
  const rules = [
    '1) 아래 제공 자료 중 [원문(raw)]·[실측 성과] 라벨이 붙은 위키 발췌와 커넥터 블록의 실제 수치·명칭은 그대로 인용하라. [LLM 생성 스텁]·[원문 발췌 스텁]·[토론·종합(출처 없음)]·[런 산출 요약]·[출처 미상] 라벨 자료는 방향 참고용이다 — 그 수치·주장을 사실로 인용하지 마라.',
    '2) 플레이스홀더·더미값을 절대 쓰지 마라: "[OO]", "202X", "[항목]", "000,000", "00.0%", "00%", "X,XXX" 같은 빈칸·0·임의 숫자로 표나 수치를 채우지 마라.',
  ];
  if (!forFacts) {
    rules.push(
      '3) 제공 자료에 없는 값은 지어내지(0·임의값 포함) 말고 "⚠️ 데이터 없음: <항목> (필요 자료: <무엇>)" 으로 정직하게 명시하라.',
      '4) 인용한 실제 수치에는 [근거: <제공 자료 제목>] 을 붙여라(존재하지 않는 자료를 지어내 인용하지 마라).',
    );
  }
  return `\n\n[작성 규칙 — 반드시 준수]\n${rules.join('\n')}`;
}

/** 한 에이전트의 한 턴을 실행하고 결과 텍스트를 반환. 스트리밍 + 이벤트 emit 포함. */
export async function runAgent(args: AgentRunArgs): Promise<AgentRunResult> {
  const { bus, role, model, stage } = args;
  const blockId = args.blockId ?? genId('blk');
  const deltaType = stage === 'synthesis' ? 'synthesis_chunk' : 'agent_thinking';

  if (args.emitSpawn) {
    bus.emit(
      EventType.agent_spawned,
      {
        agent_id: role.id,
        persona: {
          role: role.title,
          name: role.name, // 실명 → 런 중 아바타·타임라인·활동에 '실명 직책' 표시
          team: role.team, // 팀 id → OfficeView 팀별 좌석·engaged·phase 안무 매칭(없으면 work 시 자기자리 안무 死)
          scope: role.specialty,
          stance: role.stance,
          subproblem_id: args.subproblemId,
          is_critic: role.isCritic,
          // 조직 레벨은 role.level(yaml)을 우선 존중 — 팀원이면서 is_critic 인 역할(예: planning_risk)을
          // level:'critic' 으로 덮으면 OfficeView 팀원 렌더(level==='member')에서 빠져 책상·아바타가 사라진다.
          // 비평 정체성은 is_critic 플래그가 따로 전달하므로, level 은 실제 조직 위계만 담는다.
          level: role.level ?? (role.id === 'ceo' ? 'ceo' : (role.isCritic ? 'critic' : 'member')),
        },
        model,
      },
      { agentId: role.id },
    );
  }

  // --- LLM Wiki 그라운딩(Karpathy: 인덱스 우선 탐색 → 관련 페이지 본문 주입) ---
  const tools = effectiveTools(role); // 워크스페이스 capabilities 오버레이 반영
  // 능동 다단계 도구 루프(옵트인: AGENT_TOOL_LOOP) — 기본 stage='work'(+지명 런 오버라이드) + autonomy>0.
  // 기본(off)에선 effectiveAutonomy 디스크 읽기조차 건너뛰어 기존 단발 경로가 추가 I/O 0 으로 유지된다.
  const loopOn = CONFIG.agentToolLoop && (args.toolLoop ?? stage === 'work');
  const autonomy = loopOn ? effectiveAutonomy(role) : role.autonomy;
  const loopTools = (loopOn && autonomy > 0) ? availableLoopTools(tools, autonomy) : [];
  const loopActive = loopTools.length > 0;
  let grounding = '';
  if (args.groundQuery && tools.includes('wiki_query')) {
    // 데이터 그라운딩 폭 — 결산보고서처럼 여러 자료의 실수치를 종합해야 하므로 6건(이슈12). source 우대+넉넉한 본문은 query() 에서.
    // 임베딩 모델 설치 시 의미검색(retrieve→rerank), 없으면 휴리스틱 query() 로 자동 폴백.
    const { hits, context } = await llmWiki().semanticQuery(args.groundQuery, args.groundLimit ?? 6, args.signal, { forFacts: !!args.groundForFacts });
    if (context) {
      grounding = context;
      bus.emit(
        EventType.wiki_query,
        { q: args.groundQuery, hits: hits.map((p) => ({ page_id: p.slug, score: 1 })) },
        { agentId: role.id },
      );
      try {
        noteGrounding(bus.runId, hits.map((p) => ({ label: p.title, kind: p.sources.some((s) => s.startsWith('raw/')) ? 'wiki-raw' as const : 'wiki-derived' as const })));
      } catch { /* 무해 — 원장 기록 실패가 런을 깨면 안 됨 */ }
    }
  }

  // --- 웹 검색 그라운딩(외부 툴) — 내부 위키가 질의를 커버하면(grounding 존재) 생략한다.
  //     결산·회계·규정·인사 등 업로드된 내부 문서로 답해야 할 과제에 외부 웹검색이 끼어들어 추측·외부수치를
  //     주입하던 문제(이슈2)를 차단. 위키 히트가 전혀 없을 때만(외부 지식이 필요한 주제) 웹을 폴백으로 쓴다. ---
  let webContext = '';
  if (args.groundQuery && !args.groundWikiOnly && !grounding && CONFIG.webSearch && tools.includes('web_search')) {
    const results = await webSearch(args.groundQuery, 5, args.signal);
    if (results.length) {
      webContext = results
        .map((rs, i) => `${i + 1}. ${rs.title}\n   ${rs.snippet}\n   ${rs.url}`)
        .join('\n');
      bus.emit(EventType.tool_used, { agent_id: role.id, tool: 'web_search' }, { agentId: role.id });
      try {
        noteGrounding(bus.runId, results.map((rs) => ({ label: rs.url, kind: 'web' as const })));
      } catch { /* 무해 — 원장 기록 실패가 런을 깨면 안 됨 */ }
    }
  }

  // --- 외부 데이터 소스 커넥터 그라운딩(법령·DART 등) — 등록된 커넥터를 순회하며, 키가 설정되고
  //     scope(전역/역할 도구)가 맞으면 관련 자료를 자동 주입. 새 소스는 커넥터만 추가하면 자동 합류. ---
  const connectorBlocks: string[] = [];
  if (args.groundQuery && !args.groundWikiOnly) {
    for (const conn of connectors()) {
      if (!conn.enabled()) continue;
      if (conn.scope !== 'global' && !conn.scope.some((t) => tools.includes(t))) continue;
      try {
        const ctx = await conn.ground(args.groundQuery, args.signal);
        if (ctx) {
          connectorBlocks.push(`${conn.blockLabel}\n${ctx}`);
          bus.emit(EventType.tool_used, { agent_id: role.id, tool: `${conn.id}_search` }, { agentId: role.id });
          try {
            noteGrounding(bus.runId, [{ label: conn.blockLabel.replace(/^\[|\]$/g, ''), kind: 'connector' }]);
          } catch { /* 무해 — 원장 기록 실패가 런을 깨면 안 됨 */ }
        }
      } catch { /* 커넥터 실패는 무시(런 무중단) */ }
    }
  }

  // 실데이터 그라운딩 강제(이슈12) — 규칙 본문·forFacts 예외는 buildGroundDirective 참고.
  const hasGround = !!(grounding || connectorBlocks.length || webContext);
  const groundDirective = buildGroundDirective(hasGround, stage, !!args.groundForFacts);
  const userContent = [
    args.task + groundDirective,
    grounding ? `[관련 지식(위키)]\n${grounding}` : '',
    webContext ? `[웹 검색 결과]\n${webContext}` : '',
    ...connectorBlocks,
    args.context ? `[참고 자료]\n${args.context}` : '',
  ].filter(Boolean).join('\n\n');

  const messages: ChatMessage[] = [
    // 최종 산출물(synthesis)은 간결지침(2000~4000자 상한)을 끈다 — 10페이지+ 완결 문서가 필요하므로.
    // 루프 활성 시에만 도구 사용 안내를 시스템 프롬프트에 덧붙인다(기본 경로엔 미주입).
    { role: 'system', content: buildSystemPrompt(role, [loopActive ? toolInstructions(loopTools) : '', args.systemExtra].filter(Boolean).join('\n\n'), { brevity: stage !== 'synthesis' }) },
    { role: 'user', content: userContent },
  ];

  const maxOut = args.maxOutputTokens ?? CONFIG.maxOutputTokens;
  const onDelta = (d: string) => bus.emitDelta(deltaType, blockId, d, { agentId: role.id });
  let result = await llm.chat({ model, messages, maxOutputTokens: maxOut, think: args.think, signal: args.signal, onDelta });
  // 빈 출력 방어 — 1회 재시도. fallbackModel(상위 tier)이 있으면 그 모델로 승급(소형 모델
  // 무음 실패를 큰 모델로 구제), 없으면 온도↑로 재시도. 취소 중이면 생략.
  // 재시도는 추론(think) 강제 OFF — 실측(2026-08-10 런 80f1e7ce1180): opus 가 1.6만 토큰을
  // 추론만 하다 본문 없이 턴을 끝내는 플레이크가 있고, 같은 설정 재시도는 같은 모드를 다시 맞아
  // 리드 실패 → 팀 빈 산출물 → 런 전체가 비었다. 추론 없는 재시도는 본문부터 쓴다.
  if (!result.text.trim() && !args.signal?.aborted) {
    const retryModel = args.fallbackModel && args.fallbackModel !== model ? args.fallbackModel : model;
    bus.emit(EventType.log, { message: `빈 출력 — ${role.name} ${retryModel !== model ? `모델 승급 재시도(${model}→${retryModel})` : '추론 끄고 재시도'}` }, { agentId: role.id });
    result = await llm.chat({ model: retryModel, messages, maxOutputTokens: maxOut, temperature: 0.9, think: false, signal: args.signal, onDelta });
  }

  // --- 능동 도구 루프(옵트인) — 모델이 <tool> 태그로 추가 자료를 요청하면 실행해 주입·재호출.
  //     connect-ai 의 액션태그 멀티턴 실행에 대응. 같은 blockId 로 스트림이 이어져 OfficeView 안무 유지.
  //     기본(loopActive=false)에선 진입조차 안 하므로 기본 경로는 영향 0. ---
  if (loopActive && !args.signal?.aborted) {
    let calls = 0;
    // 턴별 본문 누적 — 재호출 프롬프트가 '이어서 작성'(continue)이라 각 턴은 연속 본문이다.
    // 마지막 턴만 남기면 turn0 분석 본문이 유실되므로(스트림 누적·하류 합성과도 어긋남) 합쳐 반환한다.
    const parts: string[] = [];
    let accPrompt = result.promptEvalCount, accEval = result.evalCount, accMs = result.totalDurationMs;
    let turnText = result.text;
    while (calls < CONFIG.agentMaxToolCalls && !args.signal?.aborted) {
      const reqs = parseToolCalls(turnText)
        .filter((rc) => loopTools.includes(rc.name))
        .slice(0, CONFIG.agentMaxToolCalls - calls);
      const prose = stripToolTags(turnText); // 이 턴의 본문(도구 태그 제거)을 보존
      if (prose) parts.push(prose);
      if (reqs.length === 0) break; // 더 호출할 도구 없음 → 종료
      const blocks: string[] = [];
      for (const rc of reqs) {
        calls++;
        const obs = await execLoopTool(rc, role, autonomy, bus, args.signal);
        // 도구 결과는 길이 캡(4000자) — 깊은 루프에서 컨텍스트가 서버 고정 num_ctx 를 넘어 앞단 절단되는 것 방지.
        blocks.push(`<tool_result name="${rc.name}">\n${obs.slice(0, 4000)}\n</tool_result>`);
        bus.emit(EventType.tool_used, { agent_id: role.id, tool: rc.name }, { agentId: role.id });
      }
      // 대화에 직전 답(요청 포함)과 도구 결과를 추가하고 이어서 재호출.
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: blocks.join('\n\n') + '\n\n위 도구 결과를 반영해 이어서 작성하라. 자료가 충분하면 도구 없이 최종 답을 완성하라.' });
      const next = await llm.chat({ model, messages, maxOutputTokens: maxOut, signal: args.signal, onDelta });
      accPrompt += next.promptEvalCount; accEval += next.evalCount; accMs += next.totalDurationMs;
      if (next.text.trim()) { turnText = next.text; result = next; }
      else { turnText = ''; break; }
    }
    // 누적 본문을 최종 산출물로, 메트릭은 루프 전체 합산(마지막 턴만 보고하던 과소집계 보정).
    result = { ...result, text: parts.join('\n\n').trim(), promptEvalCount: accPrompt, evalCount: accEval, totalDurationMs: accMs };
    if (calls > 0) bus.emit(EventType.log, { message: `${role.name} 도구 루프 — ${calls}회 호출` }, { agentId: role.id });
    // 루프 소진 후에도 본문이 비면 — 전 턴을 도구 태그로만 채워 prose 0줄인 모드(실측 2026-08-11
    // ce3d6a725506 리드: 4턴 전부 도구 호출, 종합 없이 종료 → 팀 빈 산출물 → 런 전체 공백. 시작 전
    // 빈 출력 재시도는 루프 '앞'이라 이 모드를 못 잡는다). 도구 금지·추론 OFF 로 최종 종합을 강제한다.
    if (!result.text.trim() && !args.signal?.aborted) {
      bus.emit(EventType.log, { message: `빈 출력(도구 루프 소진) — ${role.name} 최종 종합 강제 1회` }, { agentId: role.id });
      messages.push({ role: 'user', content: '도구 호출 없이, 지금까지 수집한 자료와 분석을 종합해 담당 산출물 본문을 즉시 완성하라. 출력은 본문만.' });
      const fin = await llm.chat({ model, messages, maxOutputTokens: maxOut, think: false, signal: args.signal, onDelta });
      const finText = stripToolTags(fin.text).trim() || fin.text.trim();
      if (finText) result = { ...result, text: finText, evalCount: result.evalCount + fin.evalCount, totalDurationMs: result.totalDurationMs + fin.totalDurationMs };
    }
  }

  bus.flushAll();
  bus.emit(
    EventType.agent_message,
    { block_id: blockId, text: result.text, stage },
    { agentId: role.id },
  );
  if (!result.text.trim()) {
    bus.emit(EventType.agent_failed, { agent_id: role.id, error: '빈 출력', isolated: true }, { agentId: role.id });
  }

  // 로컬 성능 가시화(진단·벤치마크)
  const tokPerS = result.evalCount > 0 && result.totalDurationMs > 0
    ? (result.evalCount / (result.totalDurationMs / 1000))
    : 0;
  bus.emit(
    EventType.llm_metric,
    {
      agent_id: role.id,
      model,
      prompt_tokens: result.promptEvalCount,
      output_tokens: result.evalCount,
      total_ms: Math.round(result.totalDurationMs),
      load_ms: Math.round(result.loadDurationMs),
      tok_per_s: Math.round(tokPerS * 10) / 10,
      truncated: result.truncated,
      stage,
    },
    { agentId: role.id },
  );

  // 최근활동 로깅 — 직원 탭 '📜 최근 활동' 에 런 참여 자취를 남긴다(프로필 편집만이 아니라 실제 작업).
  if (result.text.trim()) {
    const label = stage === 'synthesis' ? '종합' : stage === 'critique' ? '비평' : stage === 'rebuttal' ? '반론' : stage === 'directive' ? '지침' : '작업';
    // 내부 조합 프롬프트("주제: …\n하위 문제: …")가 아닌 첫 줄 주제만 깔끔히 발췌.
    const brief = (args.task.split('\n')[0] ?? '').replace(/^주제:\s*/, '').replace(/\s+/g, ' ').slice(0, 36).trim();
    appendActivity(role.id, `[${label}] ${brief} → ${result.text.length}자`);
  }

  return { text: result.text, blockId, result };
}

/** 구조적 단발 호출 — 분해/배정/수렴판정/분류용. 작은 모델, 비스트리밍, 짧은 출력. */
export async function microCall(
  model: string,
  system: string,
  user: string,
  opts: { maxOutputTokens?: number; temperature?: number; format?: 'json'; signal?: AbortSignal; visionPaths?: readonly string[] } = {},
): Promise<string> {
  const res = await llm.chat({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
    temperature: opts.temperature ?? 0.2,
    format: opts.format,
    signal: opts.signal,
    visionPaths: opts.visionPaths,
  });
  return res.text;
}

/** 텍스트에서 첫 JSON 객체/배열을 관대하게 추출(코드펜스·머리말 제거). */
export function extractFirstJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  // ```json ... ``` 펜스 제거
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 산출물의 플레이스홀더·가짜수치 탐지(이슈12 검증). 실데이터 대신 채워넣은 더미값을 결정적으로 잡는다.
 * 모델이 [OO] 금지를 000,000·00.0% 같은 0/X 템플릿으로 우회하던 문제를 정규식으로 포착. [근거:…] 인용은 정당하므로 제외.
 */
export function findTemplateNumbers(text: string): string[] {
  const pats: RegExp[] = [
    /0{2,}\.0+\s*%/g,                 // 00.0%
    /\b0{2,}\s*%/g,                   // 00%
    /\b0{1,3}(?:,0{3})+/g,            // 000,000 / 0,000,000 (쉼표 묶음 0)
    /\[\s*O{2,}\s*\]/gi,              // [OO]
    /\b20[0-9]?X{1,2}\b/g,            // 202X / 20XX
    /\[\s*(?:항목|숫자|기재|금액|수치)\s*\]/g, // [항목] 류
    /\bX{2,}(?:,X{3})*\s*(?:원|천원|백만원|억원|%)?/g, // XXX / X,XXX(원/%)
  ];
  const hits = new Set<string>();
  for (const re of pats) { const m = text.match(re); if (m) m.forEach((x) => hits.add(x.trim())); }
  return [...hits];
}

/** microCall + JSON 추출. 실패 시 null. */
export async function microJSON<T = unknown>(
  model: string,
  system: string,
  user: string,
  opts: { maxOutputTokens?: number; signal?: AbortSignal; visionPaths?: readonly string[] } = {},
): Promise<T | null> {
  // format:'json' 으로 Ollama 구조화 출력 강제 — 코드펜스·머리말 잡음 제거로 파싱 신뢰도↑.
  const txt = await microCall(model, system, `${user}\n\nJSON만 출력하라.`, {
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
    format: 'json',
    signal: opts.signal,
    visionPaths: opts.visionPaths,
  });
  return extractFirstJson<T>(txt);
}

// ============================================================
// 능동 도구 루프 실행부(옵트인) — 순수 헬퍼는 ./tools, 부작용 실행은 여기(기존 그라운딩 wiring 재사용).
// ============================================================

/** 역할이 루프에서 쓸 수 있는 도구 집합 — effectiveTools + 활성 커넥터 + 쓰기후보 → 자율도 게이트. */
function availableLoopTools(tools: string[], autonomy: number): string[] {
  const base: string[] = [];
  if (tools.includes('wiki_query') || tools.includes('wiki')) base.push('wiki_query');
  if (CONFIG.webSearch && (tools.includes('web_search') || tools.includes('web'))) base.push('web_search');
  for (const conn of connectors()) {
    if (conn.scope === 'global' || conn.scope.some((t: string) => tools.includes(t))) base.push(conn.id);
  }
  base.push('save_note'); // 쓰기 후보 — autonomy<2 면 toolsForAutonomy 가 제거.
  if (CONFIG.agentShell) base.push('run_command'); // 셸 옵트인(AGENT_SHELL) 시에만 노출, 그래도 autonomy≥2 에서만 제시.
  // 블로그 스킬(외부 Python 툴) — role 이 tools 로 grant 받았고 BLOG_PYTHON 이 설정됐을 때만 노출.
  if (CONFIG.blogPython) {
    if (tools.includes('image_generate')) base.push('image_generate');
    if (tools.includes('blog_publish')) base.push('blog_publish');
  }
  return toolsForAutonomy(base, autonomy);
}

/** 루프 도구 1건 실행 → 관찰 문자열. 읽기는 부작용 없음, 쓰기(save_note)는 승인 게이트(gateWrite). */
async function execLoopTool(
  rc: ToolCall, role: RoleDef, autonomy: number, bus: EventBus, signal?: AbortSignal,
): Promise<string> {
  const { name, arg } = rc;
  try {
    if (name === 'wiki_query') {
      return llmWiki().query(arg, 5).context || '(위키에 관련 자료 없음)';
    }
    if (name === 'web_search') {
      if (!CONFIG.webSearch) return '(웹 검색 비활성)';
      const rs = await webSearch(arg, 5, signal);
      return rs.length
        ? rs.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join('\n')
        : '(검색 결과 없음)';
    }
    if (WRITE_TOOLS.has(name)) {
      if (name === 'run_command' && !CONFIG.agentShell) return '(셸 실행 비활성 — AGENT_SHELL=1 필요)';
      const summary = name === 'run_command'
        ? `명령 실행: ${arg.replace(/\s+/g, ' ').slice(0, 500)}` // 전체 명령 노출 — 휴먼 검토자가 위험한 꼬리까지 보게(80자 절단 금지)
        : name === 'image_generate'
          ? `이미지 생성(gpt-image-2): ${arg.replace(/\s+/g, ' ').slice(0, 120)}`
          : name === 'blog_publish'
            ? `네이버 블로그 임시저장(초안 — 발행 아님): ${arg.replace(/\s+/g, ' ').slice(0, 120)}`
            : `노트 저장: ${arg.replace(/\s+/g, ' ').slice(0, 60)}`;
      const ok = await gateWrite(role, autonomy, name, summary, bus, signal);
      // 승인 후라도 그 사이 취소됐으면 실행/쓰기를 하지 않는다(fail-open 타임아웃이 abort 와 경합해 늦게 발화하는 경로 차단).
      if (!ok || signal?.aborted) return '(거부됨 — 승인되지 않음)';
      if (name === 'run_command') {
        const r = await runCommand(role.id, arg, signal);
        return r.output;
      }
      // await 필수 — 미await 시 내부 fs.writeFileSync rejection 이 이 try 의 catch 를 건너뛰어 runAgent 를
      // 통째로 실패시킨다(run_command 처럼 '(도구 실패)' 로 degrade 되게 await 로 catch 안에서 던지게 한다).
      if (name === 'image_generate') return await runImageGenerate(role.id, arg, signal);
      if (name === 'blog_publish') return await runBlogPublish(role.id, arg, signal);
      appendKnowledge(role.id, `- (자율노트) ${arg.replace(/\s+/g, ' ').slice(0, 300)}`);
      return '(노트 저장됨)';
    }
    // 외부 커넥터(law/dart/custom) 재호출 — 모델이 새 질의로 그라운딩.
    const conn = connectors().find((c) => c.id === name);
    if (conn && conn.enabled()) {
      const ctx = await conn.ground(arg, signal);
      return ctx || `(${name}: 관련 자료 없음)`;
    }
    return `(알 수 없거나 비활성 도구: ${name})`;
  } catch (e) {
    if (isAbort(e, signal)) throw e; // 취소는 상위로 전파
    return `(도구 실패: ${name})`;
  }
}

/** 쓰기 행동 자율도 게이트(거버넌스 enforcement): ≥3 자동 · 2 승인대기(블로킹, 타임아웃 fail-open) · ≤1 차단.
 *  취소(signal)를 승인 대기에 배선 — abort 시 즉시 거부로 귀결해 좀비 승인·지연 쓰기를 막는다. */
async function gateWrite(role: RoleDef, autonomy: number, actionType: string, summary: string, bus: EventBus, signal?: AbortSignal): Promise<boolean> {
  // 셸 실행·블로그 발행·이미지 생성(유료 API 과금)은 결제/부작용 확인이 필요해 ENFORCE_AUTONOMY=false 라도
  // 항상 게이트한다(심층방어 + 사용자 선호: 외부 서비스 결제성 행동은 확인).
  const alwaysGate = actionType === 'run_command' || actionType === 'blog_publish' || actionType === 'image_generate';
  if (!alwaysGate && !CONFIG.enforceAutonomy) return true;
  // blog_publish(외부 초안)·image_generate(유료 과금)는 autonomy≥3 에서도 자동승인하지 않고 항상 승인 요청.
  // (run_command 는 기존대로 ≥3 자동승인 유지.)
  if (autonomy >= 3 && actionType !== 'blog_publish' && actionType !== 'image_generate') return true;
  if (autonomy < 2 || signal?.aborted) return false;
  const { approval, decided } = approvalStore().request({ agent_id: role.id, action_type: actionType, summary, autonomy });
  bus.emit(EventType.approval_requested, {
    approval_id: approval.id, agent_id: approval.agent_id,
    action_type: approval.action_type, summary: approval.summary, autonomy: approval.autonomy,
  });
  // 사용자 결정 | 타임아웃(fail-open) | 취소(abort→거부) 중 먼저 오는 것으로 귀결.
  const onAbort = new Promise<{ approved: boolean; by?: string; note?: string }>((resolve) => {
    if (signal) signal.addEventListener('abort', () => resolve({ approved: false, by: 'abort', note: '취소됨' }), { once: true });
  });
  const d = await Promise.race([decided, onAbort]);
  // blog_publish(외부 네이버 초안 생성)는 타임아웃 fail-open(자동승인)을 거부로 뒤집어 fail-closed 로 만든다 —
  // 무인 런에서 사람 확인 없이 외부 초안이 저장되지 않게. (run_command 등 기존 액션의 타임아웃 자동승인은 보존.)
  const approved = actionType === 'blog_publish' && d.by === 'timeout' ? false : d.approved;
  bus.emit(EventType.approval_decided, {
    approval_id: approval.id, approved, decided_by: d.by ?? 'abort', note: d.note ?? '',
  });
  return approved;
}
