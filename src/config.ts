/**
 * 전역 설정 — 환경변수 기반. LLM 은 Claude Code CLI 단일 백엔드
 * (로컬 Ollama 경로·RAM 예산 자동배정은 2026-07-06 제거 — llm/claudeCli.ts 참조).
 */
import os from 'node:os';
import path from 'node:path';

// .env 로드 — CONFIG·getSecret(process.env 우선)이 값을 읽기 전에 반영. Node 20.12+/22 내장. 파일 없으면 무해.
// GEPA_ENV_FILE 지정 시 그 파일을 로드(기업별 인스턴스 분리 — 같은 소스 트리에서 여러 스튜디오를
// 띄울 때 공유 cwd/.env 대신 인스턴스 전용 env 를 부팅부터 사용; shell env 가 항상 우선).
try { process.loadEnvFile(process.env.GEPA_ENV_FILE || undefined); } catch { /* .env 없음 — 무해 */ }

const env = (k: string, d = ''): string => process.env[k] ?? d;
const envInt = (k: string, d: number): number => {
  const v = parseInt(env(k), 10);
  return Number.isFinite(v) ? v : d;
};
const envFloat = (k: string, d: number): number => {
  const v = parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};
const envBool = (k: string, d: boolean): boolean => {
  const v = env(k).trim().toLowerCase();
  if (!v) return d;
  return !['0', 'false', 'no', 'off'].includes(v);
};

const ROOT = path.resolve(env('GEPA_DATA_DIR', path.join(process.cwd(), 'data')));

export type Termination = 'adaptive' | 'fixed';

export interface Config {
  // --- 서버 ---
  readonly port: number;
  readonly host: string;

  // --- LLM 백엔드(Claude 단일 — Ollama 제거 2026-07-06) ---
  /** 클라우드(claude) tier→모델. micro=고빈도 구조작업(속도), standard=창의 본문, heavy=편집 최종/플래그십. */
  readonly cloudTierModels: { readonly micro: string; readonly standard: string; readonly heavy: string };
  readonly requestTimeoutMs: number;
  /** 외부 그라운딩 커넥터(법령·KOSIS·DART 등) fetch 타임아웃(ms). 무응답 외부 API 무한 대기 방지. */
  readonly groundingTimeoutMs: number;
  /** 일반 호출 출력 상한. 통합 단계만 별도 상향. */
  readonly maxOutputTokens: number;
  readonly integrationMaxOutputTokens: number;

  // --- 거버넌스/동시성 ---
  /** 동시 LLM 세션 수 — 벽시계 1번 노브. */
  readonly concurrency: number;
  readonly teamParallel: number;
  readonly maxTurnsPerAgent: number;
  /** Claude(클라우드) 동시 호출 상한 — CLI spawn 동시 수(구독 rate limit 고려). */
  readonly anthropicConcurrency: number;
  /** Claude Code CLI 실행 파일 경로 — 구독(OAuth) 인증 호출용. */
  readonly claudeCliPath: string;
  /** 월 예산 캡($) — 무감시 자율 폭주 안전장치. 0=캡 없음(정액 기본). 메터드로 쓰면 설정. */
  readonly monthlyBudgetUsd: number;

  // --- 토론/조직 형태 ---
  readonly runMode: 'org' | 'debate';
  readonly minSpecialists: number;
  readonly maxSpecialists: number;
  readonly debateRounds: number;
  readonly debateRoundsCap: number;
  /** org(팀) 모드에서 팀 산출물에 적용할 비평→반박 라운드 수. 0=현행(비평 1회만). 팀 위계를 유지한 채 토론 추가. */
  readonly orgDebateRounds: number;
  readonly termination: Termination;

  // --- 오피스 연출(LLM 비용 0, 벽시계만) ---
  readonly choreoPauseMs: number;

  // --- 스트리밍 ---
  readonly tokenCoalesceMs: number;
  readonly ssePingSeconds: number;

  // --- 저장 경로 ---
  readonly dataDir: string;
  readonly wikiDir: string;
  readonly runsDir: string;
  readonly sessionsDir: string;
  readonly agentsDir: string;
  readonly approvalsDir: string;

  // --- 자율/승인 ---
  readonly defaultAutonomy: number;
  readonly requireApproval: boolean;
  readonly approvalTimeoutS: number;
  readonly writeSessionDigest: boolean;
  readonly evolveEmployees: boolean;

  // --- 외부 툴 ---
  readonly webSearch: boolean;

  // --- 블로그 스킬(외부 Python 툴: image_generate / blog_publish) — 전부 옵트인 ---
  /** 블로그 스킬 스크립트 전용 venv python 절대경로. 비면 블로그 툴이 '비활성' 반환(기본 안전). */
  readonly blogPython: string;
  /** openai_image.py·naver_publish.py 가 있는 디렉토리. */
  readonly blogScriptsDir: string;
  /** gpt-image-2 호출용 OpenAI 키 — 서브프로세스 env 로만 전달(로그·프롬프트에 안 실림). */
  readonly openaiApiKey: string;
  /** 이미지 생성 모델(기본 gpt-image-2). */
  readonly openaiImageModel: string;
  /** 네이버 로그인 세션(Playwright storage_state) 파일 경로 — blog_publish 용. */
  readonly naverSessionFile: string;
  /** finalize 후 완성 초안(draft.json)에 이미지 자동 생성(옵트인, 기본 off — 기본 런 경로 불변). */
  readonly blogAutoImage: boolean;
  /** ready 도달 시 자동 네이버 임시저장 — SEO 점수가 기준(naverDraftSeoMin) 이상일 때만. 발행은 여전히 사람 수동. */
  readonly autoNaverDraft: boolean;
  /** 사실 게이트(2026-08-26, 사용자 절대 규칙) — 본문 주장을 브리프·근거와 대조해 무근거·모순이면 자동 임시저장 보류. */
  readonly factGate: boolean;
  /** 사실 게이트가 판정할 주장 수 상한(5~40 클램프). */
  readonly factGateMaxClaims: number;
  /** 엄격 모드(2026-08-27 복귀 스위치) — on 이면 무근거 주장을 종류와 무관하게 전부 보류(구 동작).
   * 기본 off: 수치·시기·약제·법령·가격·통계·경험 주장만 보류하고, 일반 상식 문장은 참고(unverified)로 통과. */
  readonly factGateStrict: boolean;
  /** 브리프 게이트(2026-08-28) — 팩트체커 판정(REVISION_NEEDED)을 기계 판독해 재작업 1라운드를 돌리고
   * 미해소 지적을 작가에게 '필수 반영'으로 주입한다. off 면 판독·재작업·주입 모두 중단(구 동작). */
  readonly briefGate: boolean;
  /** 브리프 게이트 재작업 라운드 상한(0~3 클램프). 0 이면 판독·표시만 하고 재작업은 돌리지 않는다. */
  readonly briefGateRounds: number;
  /** 파생 콘텐츠 시기·수치 원문 대조(2026-08-27 권고 1) — 결정적 검사. off 면 검출·오버레이 제거 모두 중단. */
  readonly timingParity: boolean;
  /** 블로그 본문 문체 린트(2026-08-27 권고 3) — 결정적 4종 검사 후 작가 수정 1회. off 면 검사·수정 모두 중단. */
  readonly blogStyleLint: boolean;
  /** 요약·설명 메타투 린트(2026-08-27 권고 2) — 블로그 meta 재생성 1회 + 쇼츠 description 수정 라운드 합류.
   *  off 면 검사와 그 재시도가 함께 멈춘다(블로그 포장 LLM 콜이 최대 1회로 돌아간다). */
  readonly metaSummaryLint: boolean;
  /** 마무리·제목 문형 로테이션(2026-08-27 권고 5) — 카드 마무리·블로그 마무리 회피 블록 주입과 쇼츠 제목
   *  유형 풀. off 면 세 주입이 모두 빠지고 쇼츠 제목 후보는 종전 고정 3종(정보형·후킹형·질문형)으로 돌아간다. */
  readonly voiceRotation: boolean;
  /** 런별 구조 시드(2026-08-27 권고 4) — 블로그 골격(도입 유형·중심 명제 인용 자리·표/체크리스트/예고)과
   *  파생물 골격(카드 본문 줄 수·해시태그 수·쇼츠 씬 수)을 런마다 다르게 뽑는다.
   *  off 면 고정 시드(after-hook·표+체크리스트·4줄·12개·5씬)로 종전 동작. */
  readonly structureVariety: boolean;
  /** 자동 임시저장 SEO 최소 점수 — 미달이면 자동 리비전 1회 후 재평가, 그래도 미달이면 수동 검토로 남긴다. */
  readonly naverDraftSeoMin: number;
  /** 네이버 임시저장 성공(본문 확정) 시 카드뉴스 자동 파생 — piece당 1회. 글마다 이미지 5장 내외 생성 비용. */
  readonly autoCardNews: boolean;
  /** 네이버 임시저장 성공 시 숏폼(MP4) 자동 파생 — piece당 1회. 글마다 이미지 ~6장 + TTS·ffmpeg(로컬) 비용. */
  readonly autoShorts: boolean;
  /** 쇼츠 렌더 엔진 — 'remotion'(모션그래픽, 기본) | 'ffmpeg'(슬라이드쇼 폴백/강제). */
  readonly shortsRenderer: 'remotion' | 'ffmpeg';
  /** fal.ai API 키 — 쇼츠 씬 배경 I2V(Phase 3). 비면 I2V 완전 비활성(스틸 폴백). */
  readonly falKey: string;
  /** 쇼츠 I2V 스위치 — 'fal'(기본, 키 있을 때만 동작) | 'off'. */
  readonly shortsI2v: 'fal' | 'off';
  /** fal I2V 모델 ID — env 한 줄로 Wan 등 교체. */
  readonly shortsI2vModel: string;
  /** 런당 I2V 클립 상한 — '정말 움직임이 필요한 핵심 컷'만 클립화(과금 캡). 0=전 씬 스킵, 8=구 동작(씬 캡과 동일). */
  readonly shortsI2vMaxClips: number;
  /** ready 쇼츠 자동 유튜브 비공개 업로드(옵트인). */
  readonly autoYtUpload: boolean;
  /** 쇼츠 성과 측정창(일) — 업로드 후 이 기간 매일 수집, 경과 시 강화 1회. */
  readonly shortsPerfDays: number;
  /** 쇼츠 총 길이 상한(초) — 대본 자수 예산·씬 수를 여기서 역산(사용자 확정 2026-08-14: 60초 이내). */
  readonly shortsMaxDurationSec: number;
  /** 쇼츠 자막 하단 여백(%) — 플랫폼 UI 가림 회피용 위치 조정(5~60 클램프). */
  readonly shortsCaptionBottomPct: number;
  /** 쇼츠 자막 글자 크기(px) — 일반 씬(훅 제외). */
  readonly shortsCaptionFontPx: number;
  /** 쇼츠 자막 글자 크기(px) — 훅(첫) 씬. */
  readonly shortsCaptionHookFontPx: number;
  /** 쇼츠 자막 키워드 강조색 사용 여부. */
  readonly shortsCaptionKeyword: boolean;
  /** 쇼츠 자막 글자 검은 테두리 — 밝은 배경 시인성(E안, 사용자 확정 2026-07-30). */
  readonly shortsCaptionOutline: boolean;
  /** 쇼츠 상단 제목 캘리 오버레이 — 별도 생성 투명 PNG 를 전 씬 고정(사용자 확정 2026-07-30). */
  /** 네이버 통계 수집(naver_stats)을 헤드리스로 — 일일 추적이 조각 수만큼 크롬 창을 띄우는 것 방지. */
  readonly naverStatsHeadless: boolean;
  readonly metaAiLabel: boolean;
  readonly shortsTitleOverlay: boolean;
  /** 쇼츠 상단 제목 오프셋(% of 높이, 0~20 클램프) — 5=플랫폼 상단 UI 회피 절충. */
  readonly shortsTitleTopPct: number;
  /** 쇼츠 상단 제목 폭(% of 화면 폭, 30~100 클램프) — 74=썸네일 제목의 80% 크기 상당. */
  readonly shortsTitleWidthPct: number;

  // --- 음성 입출력 ---
  /** TTS 제공자: 'elevenlabs'(ElevenLabs, 고품질) | 'openai'(gpt-4o-mini-tts) | 'say'(macOS 로컬, 폴백). 기본 elevenlabs. 폴백 체인: elevenlabs→openai→say(키/가용성에 따라 자동). */
  readonly ttsProvider: string;
  /** OpenAI TTS 모델(기본 gpt-4o-mini-tts — instructions 로 톤 지시 가능). 미지원 시 tts-1-hd 로 바꿔 쓰면 된다. */
  readonly openaiTtsModel: string;
  /** OpenAI TTS 음색(alloy·echo·fable·onyx·nova·shimmer 등). 한국어 내레이션은 nova(따뜻·또렷) 기본. */
  readonly openaiTtsVoice: string;
  /** ElevenLabs API 키(env/시크릿 ELEVENLABS_API_KEY). 없으면 openai 로 폴백. */
  readonly elevenLabsApiKey: string;
  /** ElevenLabs 음성 ID(기본 iWLjl1zCuqXRkW6494ve). POST /v1/text-to-speech/{voice_id} 경로에 사용. */
  readonly elevenLabsVoiceId: string;
  /** ElevenLabs 모델(기본 eleven_multilingual_v2 — 한국어 지원). */
  readonly elevenLabsModel: string;
  /** ElevenLabs 낭독 속도(voice_settings.speed) — 1.0 기본(voice_settings 미전송 → 음성 기본값=playground와 동일). >1.0 빠르게, 안전범위 0.7~1.2. ELEVENLABS_SPEED 로 조절. */
  readonly elevenLabsSpeed: number;
  /** 쇼츠 내레이션에 <break time> 태그 주입(ElevenLabs 전용) — 문장부호를 확률적으로 무시하고 몰아 읽는 실측(2026-08-11, 30클립 중 8클립 경계 0ms) 대응. SHORTS_TTS_BREAKS=false 킬스위치. */
  readonly shortsTtsBreaks: boolean;
  /** 쇼츠 씬별 합성에 previous_text/next_text 스티칭(ElevenLabs 전용) — 씬 경계 운율 연속성. SHORTS_TTS_STITCH=false 킬스위치. */
  readonly shortsTtsStitch: boolean;
  /** macOS say 폴백 음색. */
  readonly voiceTtsVoice: string;
  readonly voiceSttModel: string;

  // --- 에이전트 도구 루프 / 자율 사이클 (전부 옵트인 — 기본 off 라 기본 런 경로는 바이트 동일) ---
  /** 능동 다단계 tool-loop. on 이면 stage='work' 에이전트가 <tool> 태그로 추가 자료를 스스로 조회·재호출. */
  readonly agentToolLoop: boolean;
  /** 한 에이전트 턴에서 허용하는 총 도구 호출 수(로컬 속도 백스톱). */
  readonly agentMaxToolCalls: number;
  /** 생성 단계(작업·비평·종합)에서 모델 추론(thinking) 활성. 구조적 JSON 호출은 제외. 기본 off(속도·예산). */
  readonly agentThinking: boolean;
  /** 자율 레벨(0~3) 강제 — 쓰기성 도구를 autonomy 로 게이팅(2=승인, 3=자동, ≤1=차단). */
  readonly enforceAutonomy: boolean;
  /** 유휴 게이트 자율 사이클 주기(분). 기본 30(ON), 0=off. 사용자 런이 없을 때만 진입하고 사용자 런 도착 시 양보. */
  readonly autoCycleMinutes: number;
  /** 지식 리서치 런 주기(시간) — 자율 사이클 틱에서 마지막 리서치 후 이 시간이 지나면 콘텐츠 제작 대신
   *  리서치 런 1건(독자 궁금증·경쟁 콘텐츠 조사→팀 토론→두뇌 적재→직원 학습)을 띄운다. 0=off. */
  readonly researchCycleHours: number;
  /** 자율 파생 케이던스(일일 N편, 0=off) — 쇼츠·카드뉴스를 초안 있는 최신 블로그에서 자동 파생. */
  readonly autoShortsPerDay: number;
  readonly autoCardnewsPerDay: number;
  /** 능동 셸 실행 도구(run_command) — tool-loop 와 별개로 명시 옵트인(기본 false). 위험 표면이라 이중 게이트. */
  readonly agentShell: boolean;
  /** 셸 allowlist — 명령 argv[0]의 basename 이 이 목록에 있을 때만 실행(env AGENT_SHELL_ALLOW, 쉼표구분). */
  readonly agentShellAllow: readonly string[];
  /** 셸 명령 타임아웃(ms) — 초과 시 SIGKILL. */
  readonly agentShellTimeoutMs: number;
  /** 일일 브리핑 시각 "HH:MM"(로컬 시간). 빈 문자열=off. 알림 채널 설정 시 그 시각에 다이제스트 전송. */
  readonly dailyBriefingTime: string;
  readonly autorunTimes: string;
  /** 자율 사이클 런 완료 시 알림 전송(알림 채널 설정돼 있을 때만 실제 발송). */
  readonly notifyAutoCycle: boolean;
  /** 조각별 ready(검토 대기) 알림 — 블로그·카드뉴스·쇼츠가 완성되는 순간 push(텔레그램이면 미리보기 동봉). 킬스위치. */
  readonly notifyContentReady: boolean;
  /** 텔레그램 봇 수신 폴러 — 검토 알림의 발행 버튼·수정요청 답장 처리(자격 설정 시에만 실동작). 킬스위치. */
  readonly telegramBot: boolean;
  /** 알림 속 검토 링크의 베이스 URL — 폰에서 열려면 Tailscale 주소(예: https://mac.tailnet.ts.net). 빈 값=로컬(127.0.0.1:PORT). */
  readonly studioBaseUrl: string;
  /** 콘텐츠 발행 케이던스(주당 신규 편수 목표). 자율 사이클의 신규 아이디어 생성 최소 간격을 이걸로 산정(재개는 무관). 사용자 결정: 주 2~3개. */
  readonly contentCadencePerWeek: number;
  /** 미발행 'ready' 초안 백로그 캡 — 사람이 검토·발행 안 한 초안이 이만큼 쌓이면 신규 생성 중단(홍수 방지). */
  readonly contentReadyCap: number;
  /** 일일 성과 동기화 시각 "HH:MM"(로컬). 빈 문자열=off. 등록된 수집기로 발행 piece 성과를 측정→강화(수집기 미설정 시 no-op). */
  readonly performanceSyncTime: string;
  /** 발행 후 성과 측정까지 대기일 — 네이버 트래픽이 축적될 시간(콜드스타트 지연). 이 창 도달 전 piece 는 측정 안 함. */
  readonly performanceWindowDays: number;
  /** 주입 지식(injected.md) 반영 한도(자 수) — 에이전트 매 런 시스템프롬프트에 들어가는 양. 초과분은 최신 우선(tail)로 잘림. */
  readonly injectedKnowledgeCap: number;
  /** 주제 선정 검색 수요 게이트(2026-08-26) — 후보 keyword 의 절대 검색량·시즌 지수로 기각·후순위. off 면 조회 자체를 생략(비용 0). */
  readonly topicDemandGate: boolean;
  /** 월 검색량 하한 — 후보(또는 계열 최대 연관어)가 이 미만이면 기각. 실측 근거: 우리 롱테일이 0~30/월이었다. */
  readonly topicDemandMinVolume: number;
  /** 시즌 지수(0~1) 하한 — 이 미만이면 비수기로 후순위(기각 아님). 0~1 로 클램프. */
  readonly topicDemandMinSeason: number;
}

export const CONFIG: Config = {
  port: envInt('PORT', 8787),
  host: env('HOST', '127.0.0.1'),

  // 정액 구독이라 모델 선택은 품질 우선(속도 목적의 haiku 만 micro). 개별 override 가능.
  cloudTierModels: {
    micro: env('CLOUD_MICRO_MODEL', 'claude-haiku-4-5'),
    standard: env('CLOUD_STANDARD_MODEL', 'claude-sonnet-5'),
    heavy: env('CLOUD_HEAVY_MODEL', 'claude-opus-5'),
  },
  agentThinking: envBool('AGENT_THINKING', false),
  // 구 env 이름(LOCAL_LLM_*)은 하위 호환 폴백으로 유지.
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', envInt('LOCAL_LLM_TIMEOUT_MS', 600_000)),
  groundingTimeoutMs: Math.min(Math.max(3000, envInt('GROUNDING_TIMEOUT_MS', 15_000)), 120_000),
  // 출력 캡은 [1, 32768] 로 클램프 — env 0/음수가 빈 출력/무한생성을 유발하지 않게.
  maxOutputTokens: Math.min(Math.max(1, envInt('MAX_OUTPUT_TOKENS', envInt('LOCAL_LLM_MAX_OUTPUT_TOKENS', 8192))), 32_768),
  // CEO 종합·검토 출력 캡. 최종 산출물은 10페이지+ 완결 문서가 필요(≈15,000자≈~22k 토큰)하므로 24k 로 둔다.
  integrationMaxOutputTokens: Math.min(Math.max(1, envInt('INTEGRATION_MAX_OUTPUT_TOKENS', envInt('LOCAL_LLM_INTEGRATION_MAX_OUTPUT_TOKENS', 24_000))), 32_768),

  concurrency: envInt('CONCURRENCY', 4),
  teamParallel: envInt('TEAM_PARALLEL', 4),
  maxTurnsPerAgent: envInt('MAX_TURNS_PER_AGENT', 20),
  anthropicConcurrency: Math.max(1, envInt('ANTHROPIC_CONCURRENCY', 6)),
  claudeCliPath: env('CLAUDE_CLI_PATH', 'claude'),
  monthlyBudgetUsd: Math.max(0, Number(env('MONTHLY_BUDGET_USD', '0'))),

  runMode: (env('RUN_MODE', 'org') as 'org' | 'debate'),
  minSpecialists: envInt('MIN_SPECIALISTS', 2),
  // 콘텐츠 v1: 초안당 활성 멤버 2명(트렌드+SEO). 리뷰어=회사 크리틱, 성과분석가=벤치(cap 밖).
  maxSpecialists: envInt('MAX_SPECIALISTS', 2),
  debateRounds: envInt('DEBATE_ROUNDS', 2),
  debateRoundsCap: envInt('DEBATE_ROUNDS_CAP', 3),
  // 기본 1(ON) — 팀토론(비평→반박) 1라운드를 기본 활성. 끄려면 ORG_DEBATE_ROUNDS=0(또는 UI 토글).
  orgDebateRounds: Math.min(Math.max(0, envInt('ORG_DEBATE_ROUNDS', 1)), 3),
  termination: (env('TERMINATION', 'adaptive') as Termination),

  choreoPauseMs: envInt('CHOREO_PAUSE_MS', 300),

  tokenCoalesceMs: envInt('TOKEN_COALESCE_MS', 80),
  ssePingSeconds: envInt('SSE_PING_SECONDS', 15),

  dataDir: ROOT,
  wikiDir: path.join(ROOT, 'wiki'),
  runsDir: path.join(ROOT, 'runs'),
  sessionsDir: path.join(ROOT, 'sessions'),
  agentsDir: path.join(ROOT, 'agents'),
  approvalsDir: path.join(ROOT, 'approvals'),

  defaultAutonomy: envInt('DEFAULT_AUTONOMY', 2),
  requireApproval: envBool('REQUIRE_APPROVAL', false),
  approvalTimeoutS: envInt('APPROVAL_TIMEOUT_S', 600),
  writeSessionDigest: envBool('WRITE_SESSION_DIGEST', true),
  evolveEmployees: envBool('EVOLVE_EMPLOYEES', true), // 자가학습 — 런 종료 후 교훈 누적(백그라운드)

  webSearch: envBool('WEB_SEARCH', true),

  // 블로그 스킬(외부 Python) — 기본 비활성. BLOG_PYTHON 미설정 시 image_generate/blog_publish 가 '비활성' 반환.
  blogPython: env('BLOG_PYTHON', ''),
  blogScriptsDir: env('BLOG_SCRIPTS_DIR', path.join(process.cwd(), 'scripts', 'blog_skills')),
  openaiApiKey: env('OPENAI_API_KEY', ''),
  openaiImageModel: env('OPENAI_IMAGE_MODEL', 'gpt-image-2'),
  naverSessionFile: env('NAVER_SESSION_FILE', path.join(ROOT, '.naver_session.json')),
  blogAutoImage: envBool('BLOG_AUTO_IMAGE', false),
  // 2026-08-27 사용자 확정 — 기본 off. 근거 유무와 무관하게 모든 블로그 글은 수동 검토 후 버튼으로 임시저장한다
  // (SEO 자동 리비전은 그대로 유지 — 꺼지는 건 임시저장 '호출'뿐).
  autoNaverDraft: envBool('AUTO_NAVER_DRAFT', false),
  // 사실 게이트(2026-08-26, 사용자 절대 규칙) — 본문 주장을 브리프·근거와 대조해 무근거·모순이면 자동 임시저장 보류.
  factGate: envBool('FACT_GATE', true),
  factGateMaxClaims: Math.min(Math.max(5, envInt('FACT_GATE_MAX_CLAIMS', 20)), 40),
  factGateStrict: envBool('FACT_GATE_STRICT', false),
  // 브리프 게이트(2026-08-28) — 팩트체커 반려가 아무것도 막지 못하던 실측(런 ba522a39fa7d: REVISION_NEEDED
  // 43/70 판정 62초 뒤 집필 착수) 대응. 판정을 읽어 재작업을 돌리고, 남은 지적은 작가에게 필수 반영으로 넘긴다.
  briefGate: envBool('BRIEF_GATE', true),
  briefGateRounds: Math.min(Math.max(0, envInt('BRIEF_GATE_ROUNDS', 1)), 3),
  // 시기·수치 원문 대조(2026-08-27 권고 1) — 활엽수 실사고: 블로그 "근거 확실치 않다" ↔ 쇼츠 "지금이 적기" + 오버레이 "8월".
  timingParity: envBool('TIMING_PARITY', true),
  blogStyleLint: envBool('BLOG_STYLE_LINT', true),
  // 요약·설명 메타투 린트(2026-08-27 권고 2) — meta·쇼츠 설명이 "…정리했습니다"로 끝나 채널 전체가 한 템플릿으로 읽힌 실측 대응.
  metaSummaryLint: envBool('META_SUMMARY_LINT', true),
  // 마무리·제목 로테이션(2026-08-27 권고 5) — 카드 마무리 장·블로그 마무리 문단·쇼츠 제목 유형이 고정 틀로 수렴한 실측 대응.
  voiceRotation: envBool('VOICE_ROTATION', true),
  // 골격 다양화(2026-08-27 권고 4) — 문구를 다양화해도 뼈대가 매편 같은 자리에 서서 "찍어낸 글" 인상이 남던 실측 대응.
  structureVariety: envBool('STRUCTURE_VARIETY', true),
  naverDraftSeoMin: Math.min(Math.max(0, envInt('NAVER_DRAFT_SEO_MIN', 80)), 100),
  autoCardNews: envBool('AUTO_CARDNEWS', true),
  autoShorts: envBool('AUTO_SHORTS', true),
  shortsRenderer: env('SHORTS_RENDERER', 'remotion') === 'ffmpeg' ? 'ffmpeg' : 'remotion',
  falKey: env('FAL_KEY', ''),
  shortsI2v: env('SHORTS_I2V', 'fal') === 'off' ? 'off' : 'fal',
  shortsI2vModel: env('SHORTS_I2V_MODEL', 'fal-ai/wan/v2.2-5b/image-to-video'), // LTX-2 는 가로 전용(실측) — 세로 쇼츠 기본은 Wan 5B
  // 기본 2 = 훅+본문 1컷(사용자 번복 2026-08-10 저녁: 상한 1 도입 당일 "움직임이 적다" 체감 지적 —
  // 1로 줄인 날 fal 3연속 실패까지 겹쳐 클립 0장 편이 잇따랐다). 나머지 씬은 Remotion 네이티브 모션(fx).
  shortsI2vMaxClips: Math.min(8, Math.max(0, envInt('SHORTS_I2V_MAX_CLIPS', 2))),
  autoYtUpload: envBool('AUTO_YT_UPLOAD', false),
  shortsPerfDays: Math.max(1, envInt('SHORTS_PERF_DAYS', 7)),
  shortsMaxDurationSec: Math.min(180, Math.max(20, envInt('SHORTS_MAX_DURATION_SEC', 60))),
  // 자막 하단 여백(%) — 유튜브 쇼츠·릴스 하단 UI(~25%)에 안 가리는 안전 영역. 기본 32 + 키워드 강조색
  // = 사용자 A/B/C/D 비교 후 C안 확정(2026-07-30). 종전(20·무강조)으로 되돌리려면 env 로 조정.
  shortsCaptionBottomPct: Math.min(60, Math.max(5, envInt('SHORTS_CAPTION_BOTTOM_PCT', 50))),
  shortsCaptionFontPx: Math.min(120, Math.max(32, envInt('SHORTS_CAPTION_FONT_PX', 70))),
  shortsCaptionHookFontPx: Math.min(140, Math.max(32, envInt('SHORTS_CAPTION_HOOK_FONT_PX', 84))),
  shortsCaptionKeyword: envBool('SHORTS_CAPTION_KEYWORD', true),
  shortsCaptionOutline: envBool('SHORTS_CAPTION_OUTLINE', true),
  // 통계 수집은 세션 쿠키 재사용이라 헤드리스 기본(사용자 요청 2026-07-31 — 날짜 전환 후 첫 수집의 크롬 창 연발 제거).
  // 인증 판정은 API 기반이라 헤드리스 안전(구 DOM 오판은 우회됨). 발행·임시저장은 별개(NAVER_PUBLISH_HEADLESS, 헤드풀 기본 유지).
  naverStatsHeadless: envBool('NAVER_STATS_HEADLESS', true),
  // 메타 발행 시 'AI 정보' 자기 공개 라벨 — IG 컨테이너·FB 릴스는 is_ai_generated(공식, 2026-06-22 도입),
  // FB 사진은 provenance_info(효과 실검증 대기). AI 생성 콘텐츠 파이프라인이므로 기본 on.
  metaAiLabel: envBool('META_AI_LABEL', true),
  shortsTitleOverlay: envBool('SHORTS_TITLE_OVERLAY', true),
  shortsTitleTopPct: Math.min(20, Math.max(0, envInt('SHORTS_TITLE_TOP_PCT', 5))),
  shortsTitleWidthPct: Math.min(100, Math.max(30, envInt('SHORTS_TITLE_WIDTH_PCT', 74))), // 74=2줄 위계(키워드 라벨+훅) 기준 재보정(2026-07-31) — 90은 1줄 시절 값

  ttsProvider: env('TTS_PROVIDER', 'elevenlabs'),
  openaiTtsModel: env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
  openaiTtsVoice: env('OPENAI_TTS_VOICE', 'nova'),
  elevenLabsApiKey: env('ELEVENLABS_API_KEY', ''),
  elevenLabsVoiceId: env('ELEVENLABS_VOICE_ID', 'iWLjl1zCuqXRkW6494ve'),
  elevenLabsModel: env('ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
  elevenLabsSpeed: Math.min(1.2, Math.max(0.7, envFloat('ELEVENLABS_SPEED', 1.0))),
  shortsTtsBreaks: envBool('SHORTS_TTS_BREAKS', true),
  shortsTtsStitch: envBool('SHORTS_TTS_STITCH', true),
  voiceTtsVoice: env('VOICE_TTS_VOICE', 'Yuna'),
  voiceSttModel: env('VOICE_STT_MODEL', 'mlx-community/whisper-large-v3-turbo'),

  // 옵트인 기능(기본 off/보수값). connect-ai 패리티(능동 실행·거버넌스 강제·자율 사이클)를 켜는 노브.
  agentToolLoop: envBool('AGENT_TOOL_LOOP', false),
  agentMaxToolCalls: Math.min(Math.max(1, envInt('AGENT_MAX_TOOL_CALLS', 4)), 12),
  enforceAutonomy: envBool('ENFORCE_AUTONOMY', true),
  // 무감시 비용/레이트 보호 기본 0(off) — 켜려면 AUTO_CYCLE_MINUTES=N.
  autoCycleMinutes: Math.max(0, envInt('AUTO_CYCLE_MINUTES', 0)),
  researchCycleHours: Math.max(0, envInt('RESEARCH_CYCLE_HOURS', 24)),
  autoShortsPerDay: Math.max(0, envInt('AUTO_SHORTS_PER_DAY', 0)),
  autoCardnewsPerDay: Math.max(0, envInt('AUTO_CARDNEWS_PER_DAY', 0)),
  agentShell: envBool('AGENT_SHELL', false),
  // 기본 allowlist 는 '읽기 전용 분석 명령'만 — python3/node/awk/sed/find 같은 범용 코드 실행기는 제외(임의
  // 실행기는 메타문자 없이도 RCE 가 되어 allowlist 를 무력화). 스크립트 실행이 필요하면 AGENT_SHELL_ALLOW 로
  // 명시 추가하되 autonomy=2(명령별 승인)와 함께 쓸 것 — 인터프리터 추가는 사실상 임의 실행을 허용함.
  agentShellAllow: env(
    'AGENT_SHELL_ALLOW',
    'ls,cat,grep,rg,wc,head,tail,echo,pwd,sort,uniq,cut,tr,date,which,file,stat,diff,nl,basename,dirname',
  ).split(',').map((s) => s.trim()).filter(Boolean),
  agentShellTimeoutMs: Math.min(Math.max(1000, envInt('AGENT_SHELL_TIMEOUT_MS', 60_000)), 600_000),
  dailyBriefingTime: env('DAILY_BRIEFING_TIME', '').trim(),
  // 정각 오토런(사용자 결정 2026-08-10) — "HH:MM,HH:MM" 목록. 각 시각에 즉시 생산 틱 1회(빈값=off).
  autorunTimes: env('AUTORUN_TIMES', '').trim(),
  notifyAutoCycle: envBool('NOTIFY_AUTO_CYCLE', true),
  notifyContentReady: envBool('NOTIFY_CONTENT_READY', true),
  telegramBot: envBool('TELEGRAM_BOT', true),
  studioBaseUrl: env('STUDIO_BASE_URL', '').trim().replace(/\/+$/, ''),
  contentCadencePerWeek: Math.max(1, envInt('CONTENT_CADENCE_PER_WEEK', 3)),
  contentReadyCap: Math.max(1, envInt('CONTENT_READY_CAP', 5)),
  performanceSyncTime: env('PERFORMANCE_SYNC_TIME', '').trim(),
  performanceWindowDays: Math.max(0, envInt('PERFORMANCE_WINDOW_DAYS', 14)),
  injectedKnowledgeCap: Math.max(500, envInt('INJECTED_KNOWLEDGE_CAP', 10000)),
  topicDemandGate: envBool('TOPIC_DEMAND_GATE', true),
  topicDemandMinVolume: Math.max(0, envInt('TOPIC_DEMAND_MIN_VOLUME', 30)),
  // 1 초과 값은 모든 후보를 비수기로 만든다(0 미만은 게이트 무효) — 오설정이 사이클을 굶기지 않게 클램프.
  topicDemandMinSeason: Math.min(Math.max(0, envFloat('TOPIC_DEMAND_MIN_SEASON', 0.25)), 1),
};

export function systemRamGB(): number {
  return os.totalmem() / 1024 ** 3;
}
