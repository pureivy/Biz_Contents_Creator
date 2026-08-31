/**
 * 에이전트 능동 도구 루프 — 순수 헬퍼(파서 · 자율도 게이트 · 시스템프롬프트 스니펫 · 태그 정리).
 *
 * 부작용(LLM/위키/웹/커넥터/승인 호출)은 agent.ts 가 기존 wiring 으로 수행한다 — 여기는 순수 함수만 모아
 * 단위 테스트가 쉽게(connect-ai 의 XML 액션태그 파싱 계층에 대응).
 *
 * 설계: 로컬 소형 모델은 JSON 함수호출보다 XML 태그를 더 안정적으로 따른다(보고서 Part1 §4 교훈).
 *   형식: <tool name="wiki_query">검색어</tool>  — 모델이 한 턴에 1~N개 발신 → 실행 → 결과 주입 → 재호출.
 */

export interface ToolCall {
  name: string;
  arg: string;
}

/** <tool name="x">arg</tool> — 따옴표(", ', 없음) 관용 허용. 전역 + lastIndex 리셋. */
const TOOL_RE = /<tool\s+name\s*=\s*["']?([a-z_]+)["']?\s*>([\s\S]*?)<\/tool>/gi;
const TOOL_RESULT_RE = /<tool_result[\s\S]*?<\/tool_result>/gi;

/** 모델 출력에서 도구 호출을 추출. arg 가 빈 호출·8개 초과는 버린다(폭주 방지). */
export function parseToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  if (!text) return out;
  TOOL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_RE.exec(text)) !== null) {
    const name = (m[1] ?? '').trim().toLowerCase();
    const arg = (m[2] ?? '').trim();
    if (name && arg) out.push({ name, arg });
    if (out.length >= 8) break;
  }
  return out;
}

/** 읽기 도구(그라운딩) — 부작용 없음, autonomy≥1 에서 허용. */
export const READ_TOOLS = new Set([
  'wiki_query', 'web_search', 'law', 'dart', 'custom',
  'naver_search', 'naver_searchad', 'naver_datalab', 'naver_autocomplete',
]);
/** 쓰기 도구(부작용) — autonomy≥2 + 호출 시점 승인 게이트 필요. */
export const WRITE_TOOLS = new Set(['save_note', 'run_command', 'image_generate', 'blog_publish']);

/**
 * 자율 레벨로 '제시 가능' 도구 집합을 게이팅(거버넌스 enforcement 의 핵심).
 *  0 = off(도구 없음) · 1 = 읽기만 · 2~3 = 읽기 + 쓰기.
 * (쓰기는 실제 호출 시점에 다시 승인 게이트를 거친다 — 2=승인, 3=자동.)
 */
export function toolsForAutonomy(allowed: string[], autonomy: number): string[] {
  if (autonomy <= 0) return [];
  const uniq = [...new Set(allowed)];
  const reads = uniq.filter((t) => READ_TOOLS.has(t));
  if (autonomy < 2) return reads; // 1 → 읽기만. gateWrite 의 쓰기 차단 경계(<2)와 일치시켜 '제시-후-거부' 잡음 제거.
  return uniq.filter((t) => READ_TOOLS.has(t) || WRITE_TOOLS.has(t));
}

const TOOL_DESC: Record<string, string> = {
  wiki_query: '내부 지식(위키)에서 관련 자료 조회',
  web_search: '외부 웹 검색(DuckDuckGo)',
  law: '법제처 법령 검색',
  dart: 'DART 기업공시 조회',
  custom: '등록된 외부 데이터 조회',
  naver_search: '네이버 블로그 SERP(경쟁도·상위 제목)',
  naver_searchad: '네이버 검색광고 실검색량·경쟁지수',
  naver_datalab: '네이버 데이터랩 검색어트렌드 방향',
  naver_autocomplete: '네이버 자동완성 연관 검색어',
  save_note: '확인한 핵심 사실을 본인 지식노트에 저장(부작용 — 승인 필요할 수 있음)',
  run_command: '샌드박스에서 셸 명령 1개 실행(allowlist 제한·승인 필요·파이프/리다이렉트 불가)',
  image_generate: '초안 본문/슬롯을 gpt-image-2 로 이미지 생성(부작용·과금 — 승인 필요). arg 예: {"content":"본문 또는 [IMAGE:] 마커","image_style":"photorealistic","topic":"가게명"}',
  blog_publish: '네이버 블로그 SmartEditor 임시저장(초안만 — 발행 안 함). 외부 부작용이라 항상 승인 게이트. arg: {"final_content":{...},"image_manifest":{...}}',
};

/** 루프 활성 시 시스템 프롬프트에 덧붙일 도구 사용 안내. 도구가 없으면 빈 문자열(=주입 안 함). */
export function toolInstructions(tools: string[]): string {
  if (!tools.length) return '';
  const list = tools.map((t) => `- ${t}: ${TOOL_DESC[t] ?? t}`).join('\n');
  return (
    '\n\n[도구 사용 — 선택] 자료가 더 필요하면 답을 멈추고 아래 형식으로 도구를 호출하라(한 번에 1~2개). ' +
    '결과를 받은 뒤 이어서 작성한다. 자료가 충분하면 도구 없이 바로 최종 답을 작성하라.\n' +
    '형식: <tool name="도구이름">질의/내용</tool>\n사용 가능한 도구:\n' +
    list
  );
}

/** 최종 답에서 잔여 <tool>·<tool_result> 태그 제거(사용자 노출 방지). */
export function stripToolTags(text: string): string {
  if (!text) return '';
  return text.replace(TOOL_RE, '').replace(TOOL_RESULT_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}
