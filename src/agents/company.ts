/**
 * 회사 정의 — CEO + 전문가 페르소나/역할/모델 tier/툴. 데이터 주도(추후 company.yaml 로딩 대체 가능).
 *
 * 모델 tier 매핑이 로컬 속도의 핵심: 마이크로(분해·배정·수렴판정)는 시스템이 micro 모델로,
 * 전문가 본작업은 standard, CEO 통합은 heavy. → llm/models.ts autoAssignModels 와 연결.
 */
import type { RoleTier } from '../llm/models';
import type { Stance } from '../events/types';

export interface RoleDef {
  id: string;
  name: string;
  title: string;
  emoji: string;
  /** 모델 선택 tier. */
  tier: RoleTier;
  stance: Stance;
  /** 말투/성격(시스템 프롬프트에 주입). */
  persona: string;
  /** 전문 영역(한 줄). */
  specialty: string;
  /** 허용 툴 id(추후 tool 게이팅). 비면 채팅 전용. */
  tools: string[];
  autonomy: number; // 0=off,1=read,2=draft(승인),3=auto
  isCritic: boolean;
  /** company.yaml 의 풍부한 시스템 프롬프트(있으면 buildSystemPrompt 가 우선 사용). */
  systemPrompt?: string;
  /** 조직 레벨(ceo|lead|member) — 프론트 표시·연출용. */
  level?: string;
  /** 소속 팀 id — 프론트 표시용. */
  team?: string | null;
}

export interface TeamDef {
  id: string;
  name: string;
  lead: RoleDef;
  members: RoleDef[];
  /** 대기(standby) 팀 — 블로그 초안 org 런에 자동 편성하지 않는다(전용 파이프라인이 직접 호출).
   *  예: 카드뉴스팀. 지명(directed) 런은 rolesById 팀 순회로 여전히 가능. */
  standby?: boolean;
}

export interface CompanyDef {
  name: string;
  mission: string;
  ceo: RoleDef;
  /** 평면 전문가 목록(debate 모드). teams 가 있으면 그 합집합 + 회사급 비평가. */
  specialists: RoleDef[];
  /** 조직 위계(org 모드). 없으면 debate 모드 평면 실행. */
  teams?: TeamDef[];
}

const r = (d: Partial<RoleDef> & Pick<RoleDef, 'id' | 'name' | 'title' | 'specialty'>): RoleDef => ({
  emoji: '🧑‍💼',
  tier: 'standard',
  stance: 'neutral',
  persona: '',
  tools: [],
  autonomy: 2,
  isCritic: false,
  ...d,
});

// --- 역할 정의(명명 상수 — 팀 구성에 참조) ---
// AI 콘텐츠 스튜디오 로스터. 이 코드 폴백은 data/company.yaml 에 ceo 가 없을 때만 쓰인다(정상은 YAML).
const CEO = r({
  id: 'ceo', name: '편집장', title: '편집장', emoji: '🧭',
  tier: 'standard', // 취합·검증 (비용 위해 heavy 대신 standard)
  persona: '결론을 먼저 말하고 근거로 뒷받침. 검색 의도·사실·가독성·건강한 SEO를 기준으로 취합한다.',
  specialty: '콘텐츠 편집 총괄, 주제 선정, 초안 취합·검증, 게시 판단',
  tools: ['wiki_query', 'wiki_ingest'], autonomy: 3,
});
const RESEARCH_LEAD = r({
  id: 'research_lead', name: '리서치·전략 디렉터', title: '리서치·전략 디렉터', emoji: '👔',
  tier: 'standard', stance: 'neutral',
  persona: '트렌드·검색량·경쟁도를 근거로 노출 기회를 판단하고 팀 조사를 브리프로 취합.',
  specialty: '키워드/주제 기회 판단, 콘텐츠 브리프, 리서치 취합',
  tools: ['wiki_query', 'wiki_ingest', 'web_search', 'naver_search', 'naver_searchad', 'naver_datalab', 'naver_autocomplete'],
  autonomy: 3,
});
const TREND_RESEARCHER = r({
  id: 'trend_researcher', name: '트렌드 리서처', title: '트렌드 리서처', emoji: '🔍',
  tier: 'standard', stance: 'neutral',
  persona: '근거 우선. 출처를 명시하고 불확실은 불확실로 표시.',
  specialty: '트렌드·연관 키워드 조사, 경쟁 콘텐츠 빈틈 분석',
  tools: ['wiki_query', 'wiki_ingest', 'web_search', 'naver_search', 'naver_datalab', 'naver_autocomplete'],
  autonomy: 2,
});
const SEO_STRATEGIST = r({
  id: 'seo_strategist', name: 'SEO 키워드 전략가', title: 'SEO 키워드 전략가', emoji: '🔑',
  tier: 'micro', stance: 'nuanced',
  persona: '실검색량·경쟁지수로 타겟 키워드를 정하되 과최적화를 경계.',
  specialty: '키워드 조사·클러스터링·검색의도 분류·태깅',
  tools: ['wiki_query', 'web_search', 'naver_searchad', 'naver_search', 'naver_autocomplete'],
  autonomy: 2,
});
const REVIEWER = r({
  id: 'reviewer', name: '팩트체커·리뷰어', title: '팩트체커·리뷰어', emoji: '⚖️',
  tier: 'standard', stance: 'critic', isCritic: true,
  persona: '초안을 쓰지 않고 사실·출처·SEO 린트를 검증. 근거 없는 동조 금지.',
  specialty: '사실·출처 검증, 네이버 SEO 린트, 과최적화 적출',
  tools: ['wiki_query', 'web_search'], autonomy: 2,
});
const PERF_ANALYST = r({
  id: 'perf_analyst', name: '성과 분석가', title: '성과 분석가', emoji: '📈',
  tier: 'standard', stance: 'nuanced',
  persona: '실제 성과(유입·조회·체류)로 무엇이 통했는지 판단해 다음 기획에 되먹임.',
  specialty: '네이버 유입키워드·조회·체류 분석 → 강화 학습',
  tools: ['wiki_query', 'wiki_ingest', 'naver_analytics'], autonomy: 2,
});
const WRITER = r({
  id: 'content_lead', name: '수석 작가·카피라이터', title: '수석 작가·카피라이터', emoji: '✍️',
  tier: 'standard', stance: 'pro',
  persona: '검색 의도를 충족하는 구조로 독자가 끝까지 읽게. 군더더기 없이 핵심을.',
  specialty: '네이버 블로그 본문 저작, 후크·구조·자연스러운 키워드 배치',
  tools: ['wiki_query'], autonomy: 3,
});

/** 기본 회사 — AI 콘텐츠 스튜디오. 편집장 + 리서치·SEO팀 + 제작팀(단독 작가). */
export const DEFAULT_COMPANY: CompanyDef = {
  name: 'AI 콘텐츠 스튜디오',
  mission: '검색 노출을 목표로 네이버 블로그 콘텐츠를 발굴·조사·작성·검증하고, 실제 성과로 다음 콘텐츠를 강화한다.',
  ceo: CEO,
  specialists: [RESEARCH_LEAD, TREND_RESEARCHER, SEO_STRATEGIST, REVIEWER, PERF_ANALYST, WRITER],
  teams: [
    { id: 'research', name: '리서치·SEO팀', lead: RESEARCH_LEAD, members: [TREND_RESEARCHER, SEO_STRATEGIST, REVIEWER, PERF_ANALYST] },
    { id: 'content', name: '제작팀', lead: WRITER, members: [] },
  ],
};

/** id → 역할(빠른 조회). */
export function rolesById(c: CompanyDef = DEFAULT_COMPANY): Map<string, RoleDef> {
  const m = new Map<string, RoleDef>();
  m.set(c.ceo.id, c.ceo);
  for (const s of c.specialists) m.set(s.id, s);
  // 팀 리드·팀원도 포함 — directed 런이 커스텀 회사의 팀 전용 역할도 지명 가능하게.
  for (const t of c.teams ?? []) {
    m.set(t.lead.id, t.lead);
    for (const mem of t.members) m.set(mem.id, mem);
  }
  return m;
}
