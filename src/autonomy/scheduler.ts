/**
 * 유휴 게이트 자율 사이클(옵트인: AUTO_CYCLE_MINUTES>0) — Connect AI 15분 오토사이클의 로컬·속도우선 변형.
 *
 * 핵심 긴장: 이 앱의 모든 속도 설계가 '단일 KV 슬롯(concurrency=1)'에 수렴하는데, 상시 백그라운드 LLM
 * 루프는 그 슬롯을 점유해 사용자 런을 지연시킨다. 그래서 이 스케줄러는 세 가지로 충돌을 회피한다.
 *   (1) 사용자 런이 하나라도 진행 중이면 진입조차 안 함(유휴 게이트).
 *   (2) 자율 런도 사용자 런과 같은 LLM_SLOT 으로 큐잉 → 단일 KV 슬롯 불변식 자동 보존.
 *   (3) 사용자 런 도착 시 양보(진행 중 자율 런 abort) — main.ts 의 launchRun 이 처리.
 * 기본 ON(config autoCycleMinutes=30). 켜져도 '가장 가치있는 단일 작업'을 micro 로 1건 제안해 저비용 런 1개만 띄운다(끄려면 AUTO_CYCLE_MINUTES=0).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { resolveAssignment } from '../llm/setting';
import { getCompany } from '../agents/company-loader';
import { microJSON } from '../orchestrator/agent';
import { asString } from '../util/str';
import { brandContext, brandProductLines, brandSeedKeywords, activeBrandSlug, brandFileSuffix, offBrandTerm, getBrand, lintLexicon } from '../content/brand';
import { titleTypeGuidanceBlock } from '../analytics/titleTiming';
import { shortsTopicSignalBlock } from '../analytics/shortsPerf';
import { topicVerdictBlock, avoidVerdictFor, consumeOpportunityVerdict } from '../analytics/topicVerdicts';
import { trendSignalBlock } from '../analytics/trendSignal';
import { assessCandidatesDemand, demandSignalBlock, demandRejectBlock, demandRejectFor, rememberDemandReject, demandVerdict, formatDemandLine, normKw, type DemandRow, type DemandVerdict } from '../analytics/topicDemand';
import { searchAdEnabled } from '../grounding/naver_searchad';
import { ytNicheBlock } from '../analytics/ytNiche';
import { ensureSeriesLabels, classifyCandidates, seriesScoresFor, gateForLabels, fillLabelsFromKnown, cooldownSummary } from '../analytics/seriesLedger';
import { fallbackSeriesLabels } from '../content/seriesCooldown';
import { seasonalContext } from '../util/solarTerms';
import { offSeasonSubject, seasonalSubjectBlock, formatMonths } from '../content/seasonalSubjects';
import { speciesCoverage, overSpeciesCap, speciesRotationBlock, speciesInText, SPECIES_MONTHLY_CAP } from '../content/speciesRotation';
import { pieceStore } from '../content/pieces';
import { overThemeCap, themeRotationBlock, THEME_MONTHLY_CAP } from '../content/topicThemes';
import { brandThemeCoverage } from '../analytics/discoverySeeds';
import { collectExistingContent, findSimilarContent, saturatedThemes, saturatedThemeMatches } from '../content/novelty';

export interface AutoCycleDeps<T = string> {
  /** 사이클 주기(ms). ≤0 이면 스케줄러는 no-op. */
  intervalMs: number;
  /** 사용자/기존 런이 진행 중인가(유휴 게이트). true 면 이번 틱을 건너뛴다. */
  isBusy: () => boolean;
  /** 오토런 스위치(사용자 토글) — false 면 틱이 조용히 아무 일도 하지 않는다(타이머는 유지). 미지정 = 항상 온. */
  isEnabled?: () => boolean;
  /** 이번 틱에 처리할 작업(재개 대상 piece 또는 새 아이디어). null 이면 띄우지 않음.
   *  force=true 는 사용자가 직접 실행한 틱(runNow) — 케이던스 간격을 기다리지 않고 즉시 생산한다
   *  (사용자 결정 2026-08-09). 타이머 자동 틱은 force 없음(무인 도배 방지 유지). */
  pickWork: (signal?: AbortSignal, force?: boolean, userTriggered?: boolean) => Promise<T | null>;
  /** 선택된 작업으로 자율 런을 띄운다(main.ts 의 launchRun 으로 위임). */
  launch: (work: T) => void;
  /** 로그 표기용 — 작업을 한 줄로 요약. */
  describe?: (work: T) => string;
  log?: (msg: string) => void;
}

/** 자율 사이클 시작. 반환값은 정지 함수. intervalMs≤0 이면 아무것도 하지 않는다. */
/** 1틱 결과 — busy(런 충돌)만 재시도할 가치가 있는 상태다(idle=할 일 없음, launched=성공). */
export type AutoTickOutcome = 'launched' | 'idle' | 'busy' | 'overlap' | 'error';
/** 정지 함수 + runNow(수동 즉시 1틱) + runNowPersistent(busy 시 재시도 — 슬롯·지시 침묵 소멸 방지). */
export type AutoCycleControl = (() => void) & {
  runNow: () => Promise<AutoTickOutcome>;
  runNowPersistent: (opts?: { label?: string; retryMs?: number; maxAttempts?: number; respectToggle?: boolean; userTriggered?: boolean }) => Promise<AutoTickOutcome>;
};

export function startAutoCycle<T = string>(deps: AutoCycleDeps<T>): AutoCycleControl {
  let ticking = false; // 재진입 가드 — pickWork(LLM)이 주기보다 길어도 틱이 겹쳐 다중 자율런이 뜨지 않게.
  // 핵심 1틱 — isEnabled 게이트 제외(타이머 틱과 수동 실행이 공유). isBusy·재진입은 항상 적용.
  // userTriggered — 사용자가 "자율런" 지시문·수동 틱 버튼으로 직접 촉발한 틱인가(2026-08-29 사용자 확정).
  // force 로는 구분할 수 없다: 정각 슬롯도 force 로 돈다(간격 우회가 목적이라 같다). 그래서 별도 신호로 흘린다.
  const core = async (force = false, userTriggered = false): Promise<AutoTickOutcome> => {
    if (ticking) return 'overlap';
    ticking = true;
    try {
      // 블로커는 사용자 런일 수도, 다른 자율 런(리서치 등)일 수도 있다 — '사용자 런'으로 단정하던
      // 종전 문구는 실사고(2026-08-18: 리서치 런에 밀린 18:00 슬롯) 원인 추적을 헷갈리게 했다.
      if (deps.isBusy()) { deps.log?.('진행 중 런 있음 — 자율 사이클 건너뜀'); return 'busy'; }
      const work = await deps.pickWork(undefined, force, userTriggered);
      // 제안 도중 다른 런이 도착했을 수 있으니 launch 직전 재확인(유휴 게이트 비원자성 완화).
      if (deps.isBusy()) { deps.log?.('제안 도중 다른 런 도착 — 자율 사이클 보류'); return 'busy'; }
      if (work != null) { deps.log?.(`자율 사이클 — "${deps.describe?.(work) ?? String(work)}"`); deps.launch(work); return 'launched'; }
      deps.log?.('자율 사이클 — 처리할 작업 없음(재개 대상·신규 아이디어 모두 없음)');
      return 'idle';
    } catch (e) {
      deps.log?.(`자율 사이클 오류: ${e instanceof Error ? e.message : String(e)}`);
      return 'error';
    } finally {
      ticking = false;
    }
  };
  const timer = (deps.intervalMs > 0)
    ? setInterval(() => {
        if (deps.isEnabled && !deps.isEnabled()) return; // 오토런 오프 — 타이머 틱만 조용히 통과(수동 runNow 는 무관)
        void core();
      }, deps.intervalMs)
    : null;
  if (timer && typeof timer.unref === 'function') timer.unref(); // 프로세스 종료를 막지 않게
  const stop = (() => { if (timer) clearInterval(timer); }) as AutoCycleControl;
  // 수동 즉시 실행(사용자 '자율런 돌려줘') — 토글 무시, isBusy·재진입 가드 유지.
  // force=true: 사용자 지시는 케이던스를 기다리지 않고 즉시 생산(사용자 결정 2026-08-09).
  stop.runNow = () => core(true, true); // 수동 즉시 실행 = 사용자 촉발
  // busy(런 충돌) 시 포기하지 않는 실행 — 정각 슬롯·사용자 오토런 지시가 진행 중 런에 밀려 조용히
  // 소멸하던 실사고(2026-08-18: 30분 유휴 틱의 리서치 런이 18:00 슬롯을 삼킴) 봉합. 동시 대기는 1건만.
  let persistentWaiting = false;
  stop.runNowPersistent = async (opts = {}) => {
    const { label = '자율 틱', retryMs = 180_000, maxAttempts = 10, respectToggle = false, userTriggered = false } = opts;
    if (persistentWaiting) { deps.log?.(`${label} — 이미 재시도 대기 중(중복 요청 무시)`); return 'busy'; }
    persistentWaiting = true;
    try {
      for (let i = 1; ; i++) {
        if (respectToggle && deps.isEnabled && !deps.isEnabled()) return 'idle'; // 대기 중 토글 오프 존중
        const r = await core(true, userTriggered);
        if (r !== 'busy' && r !== 'overlap') return r;
        if (i >= maxAttempts) { deps.log?.(`${label} — 재시도 ${maxAttempts}회 소진(런 장기 점유), 이번 슬롯 포기`); return 'busy'; }
        deps.log?.(`${label} — 진행 중 런 종료 대기, ${Math.max(1, Math.round(retryMs / 60_000))}분 후 재시도(${i}/${maxAttempts})`);
        await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
      }
    } finally {
      persistentWaiting = false;
    }
  };
  return stop;
}

/** 파생 콘텐츠 일일 케이던스 게이트(순수) — lastCreatedTs 에서 24h/N 경과 여부. 호출부가 '자율 생산분의
 *  마지막 생성 ts'만 넘겨(수동 제외) 오토런은 사용자와 무관하게 자기 몫을 채운다. perDay<=0 = off.
 *  손상 ts 는 게이트가 영구히 잠기지 않게 즉시 due. */
export function derivedContentDue(perDay: number, lastCreatedTs: string | undefined, now = Date.now()): boolean {
  if (!(perDay > 0)) return false;
  if (!lastCreatedTs) return true;
  const t = new Date(lastCreatedTs).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= 86_400_000 / perDay;
}

// ── 오토런 온/오프 토글(사용자 요청 2026-07-16) — 앱 전역 스위치(브랜드 무관), 재시작에도 유지 ──
// AUTO_CYCLE_MINUTES(주기 설정)와 별개다: 주기는 기능의 존재, 토글은 사용자의 일시 정지 스위치.
const autorunFile = (): string => path.join(CONFIG.dataDir, '_shared', 'autorun.json');
let _autorunCache: boolean | undefined;
/** 오토런 켜짐 여부 — 파일 없음/깨짐은 온(기존 동작 불변). 1회 읽고 캐시(틱마다 디스크 안 침). */
export function autoRunEnabled(): boolean {
  if (_autorunCache === undefined) {
    try { _autorunCache = (JSON.parse(fs.readFileSync(autorunFile(), 'utf-8')) as { enabled?: unknown }).enabled !== false; }
    catch { _autorunCache = true; }
  }
  return _autorunCache;
}
export function setAutoRunEnabled(v: boolean): void {
  _autorunCache = v;
  try {
    fs.mkdirSync(path.dirname(autorunFile()), { recursive: true });
    fs.writeFileSync(autorunFile(), JSON.stringify({ enabled: v }));
  } catch { /* 영속 실패해도 런타임 토글은 유효(다음 재시작에 기본 온) */ }
}

/**
 * 오토런 지시문 판별(순수) — 주제창에 "오토런 실행해줘" 같은 지시를 치면 콘텐츠 런이 돌아 지시문
 * 제목의 글이 검토함에 쌓였다(실측 3회: "자율런 실행", "오토런 실행해줘"×2 — 2026-08-05·08-08).
 * 짧고(≤15자) 오토런 지칭+실행 동사로만 이루어진 입력만 지시로 본다 — "오토런 기능을 소개하는 글"
 * 같은 정상 주제는 길이·구성에서 걸리지 않는다. 호출부(startHandler)가 런 대신 자율 틱으로 라우팅.
 * 명사부에 콘텐츠런 계열 추가(실측 5번째 변형 2026-08-09: "콘텐츠 란 실행"이 새어 들어가 두뇌 그라운딩
 * 주제 선정 → 참나무 자기 강화 런이 됐다). 단독 "콘텐츠"는 명사부가 아니다(런/란 접미 필수).
 * 확장(2026-08-14): 목적어 조사(을/를) 선택 허용 + 부사 슬롯(좀·한번·지금·다시·바로) + 사동형
 * (실행시켜/실행시키)·돌리 변형 포괄 — "자율런을 실행해줘"·"자율런 좀 돌려줘"·"실행시켜줘"가 새던 구멍.
 * 지시명사 앵커(오토런/자율런 등)+길이 캡은 유지해 정상 주제 오탐을 막는다.
 */
export function isAutorunDirective(topic: string): boolean {
  const t = (topic || '').trim();
  if (!t || t.length > 15) return false;
  return /^(오토런|자율런|자율\s*사이클|콘텐츠\s*[런란])[을를]?(\s*(좀|한번|지금|다시|바로))*(\s*(실행|시작|가동|틱|돌려|돌리)(\s*(시켜|시키|해))?\s*(줘|주세요|라|자)?)?\s*$/.test(t);
}

export interface DailyDeps {
  /** "HH:MM" 로컬 시각. 형식 불일치면 no-op. */
  time: string;
  run: () => void;
  log?: (msg: string) => void;
  /** 발동 이력 영속 키(파일명). 주면 프로세스 재기동에도 '오늘 이미 돌았음'이 유지되고,
   *  예정 시각을 지나 부팅해도 그날 몫을 따라잡는다. 미지정이면 종전(메모리 전용) 동작. */
  key?: string;
}

/**
 * 오늘 실행 도래 판정(순수) — 예정 시각 **이후 아무 때나** 참(따라잡기).
 *
 * 종전 조건은 `now.getHours() === hh && now.getMinutes() >= mm` 이라 예정 시각이 든 **그 한 시간 안에**
 * 프로세스가 살아 있어야만 발동했다(07:30 이면 07:30~07:59 창). tsx watch 는 TS 를 고칠 때마다 자식을
 * 재기동하므로 그 창을 놓치면 그날 팔로워 스냅샷·성과 동기화가 통째로 사라진다 — 실측 2026-08-02:
 * followers 스냅샷이 07-31 에서 멈춰 08-01 하루가 비었다.
 */
export function dailyDue(now: Date, hh: number, mm: number, today: string, lastFired: string): boolean {
  if (today === lastFired) return false; // 당일 1회만
  return now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
}

const dailyStateFile = (key: string): string => path.join(CONFIG.dataDir, '_shared', `daily-${key}.json`);
function readLastFired(key: string): string {
  try { return String((JSON.parse(fs.readFileSync(dailyStateFile(key), 'utf-8')) as { lastFired?: unknown }).lastFired ?? ''); }
  catch { return ''; }
}
function writeLastFired(key: string, day: string): void {
  try {
    const f = dailyStateFile(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ lastFired: day }), 'utf-8');
  } catch { /* 영속 실패 무해 — 최악의 경우 재기동 시 한 번 더 돈다 */ }
}

/** 매일 지정 시각(로컬)에 1회 run() 호출 — 1분 간격 체크 + 당일 1회 가드. 정지 함수 반환. */
export function startDaily(deps: DailyDeps): () => void {
  const m = /^(\d{1,2}):(\d{2})$/.exec((deps.time || '').trim());
  if (!m) return () => {};
  const hh = Number(m[1]); const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return () => {};
  let lastFired = deps.key ? readLastFired(deps.key) : '';
  const tick = (): void => {
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (!dailyDue(now, hh, mm, today, lastFired)) return;
    lastFired = today;
    if (deps.key) writeLastFired(deps.key, today); // 재기동해도 같은 날 다시 안 돌게
    try { deps.log?.(`일일 브리핑 발송(${deps.time})`); deps.run(); }
    catch (e) { deps.log?.(`일일 브리핑 오류: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const timer = setInterval(tick, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function readSafe(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

// 최근 자율 주제(중복 회피) — Connect AI 의 '24h 내 반복 금지'에 대응하는 경량 메모리.
const recentAuto: string[] = [];

/** 다음에 제작할 콘텐츠 아이디어(구조화). */
export interface ContentIdea { title: string; keyword?: string; subNiche?: string; }

/**
 * 주제 조향에 쓸 성과 키워드 선별(순수) — 두 겹.
 *
 * 1. **소재 게이트**: banned 에 걸리는 키워드 제외(채소·다육 등).
 * 2. **시대 컷오프**: 브랜드 정체성 재정립 이전에 **처음 측정된** 키워드 제외.
 *    게이트만으로는 부족하다는 게 실측으로 드러났다(2026-08-01: bionditree 상위 8개 중 5개가
 *    여름꽃종류·7월에 심는 꽃·화분곰팡이·여름화분물주기·반려동물 안전한 식물). 이들은 나무 브랜드의
 *    소재가 아니지만 banned 토큰에 안 걸린다 — '꽃'은 꽃나무(배롱나무·벚나무)를 살려야 해서
 *    스톱워드이기 때문이다. 즉 게이트를 조이면 정상 주제가 죽고, 안 조이면 옛 정체성이 살아남는다.
 *    해법은 소재 판정이 아니라 시대 판정이다.
 *
 * 기준 시각은 firstSeenAt(불변) — updatedAt 은 측정창 안에서 매일 갱신돼 컷오프를 무너뜨린다.
 * 구파일 호환: firstSeenAt 이 없으면 updatedAt 으로 대체(readStrategy 가 백필하지만 직접 파싱 경로도 있다).
 * since 미설정이면 시대 필터 없음 — 정체성을 바꾼 적 없는 브랜드는 종전 동작 그대로.
 */
export function eligibleWinners<T extends { keyword?: string; firstSeenAt?: string; updatedAt?: string }>(
  winners: T[], since?: string,
): T[] {
  return winners.filter((w) => {
    if (!w || !w.keyword || offBrandTerm(w.keyword)) return false;
    if (!since) return true;
    const born = (w.firstSeenAt || w.updatedAt || '').slice(0, 10);
    return born ? born >= since : false; // 시각을 모르면 옛 것으로 본다(보수적)
  });
}

// 성과 전략(analytics/strategy.json, 6d 연동) 있으면 승자 키워드를 아이디어 재료로 — 없으면 콜드스타트(무시).
/** 최근 30일 블로그의 수종별 편수(브랜드 카탈로그 기준) — 후보 루프·예고·클러스터 게이트가 공유. */
export function speciesCoverageFor(slug: string | undefined, now = new Date()): Map<string, number> {
  try {
    const items = pieceStore().list()
      .filter((p) => (p.brand ?? '') === (slug ?? '') && p.stage !== 'idea' && p.stage !== 'error')
      .map((p) => ({ title: p.title, keyword: p.keyword, ts: p.createdTs }));
    return speciesCoverage(items, getBrand()?.speciesCatalog, now);
  } catch { return new Map(); }
}

function readStrategyWinners(): string {
  try {
    const slug = activeBrandSlug();
    const raw = JSON.parse(readSafe(path.join(CONFIG.dataDir, 'analytics', slug ? `strategy-${slug}.json` : 'strategy.json'))) as {
      winners?: Array<{ keyword?: string; score?: number }>;
    };
    const cov = speciesCoverageFor(slug || undefined);
    const themeCovW = brandThemeCoverage(new Date(), slug || '');
    return eligibleWinners(raw.winners ?? [], getBrand()?.perfEraSince)
      // 월 상한에 닿은 수종의 성과 키워드는 빼서 '통했던 배롱'이 매 틱 되주입되는 고리를 끊는다(2026-08-27).
      .filter((w) => !overSpeciesCap(w.keyword ?? '', cov, getBrand()?.speciesCatalog))
      .filter((w) => !overThemeCap(w.keyword ?? '', themeCovW, getBrand()?.topicThemes))   // 축 상한도 같은 이유(수렴 고리 차단)
      .slice(0, 8)
      .map((w) => `- ${w.keyword}${typeof w.score === 'number' ? ` (점수 ${w.score.toFixed(2)})` : ''}`)
      .join('\n');
  } catch { return ''; }
}

/**
 * 시드 키워드 블록(순수) — 성과 winners 와 **나란히** 주기 위한 것.
 *
 * 종전 프롬프트는 `winners || coldstart` 하나뿐이라, winners 가 한 줄이라도 있으면 시드가 통째로
 * 사라졌다. 그래서 브랜드 yaml 의 seedKeywords 에 새 축을 넣어도 주제 선정에 아무 영향이 없었다
 * (실측 2026-08-01: bionditree winners 19개 중 게이트 통과 8개 → 시드 16개 전부 미주입).
 * 게다가 살아남은 winners 는 정체성 재정립(07-31) 전에 쌓인 것이라 '여름꽃종류'·'7월에 심는 꽃'처럼
 * 지금 축과 무관한 소재가 섞여 있다 — '꽃'은 신규성 스톱워드라 소재 게이트가 걸러내지 못한다.
 *
 * winners 가 비었을 땐 coldstart 가 이미 같은 시드를 담으므로 빈 문자열(중복 주입 방지).
 */
export function seedKeywordBlock(winners: string, seeds: string[]): string {
  if (!winners || !seeds.length) return '';
  return `[브랜드 시드 키워드(성과가 아직 없는 축 — 위 성과 키워드 대신 여기서 골라도 된다)]\n${seeds.map((k) => `- ${k}`).join('\n')}\n\n`;
}

const IDEA_SYSTEM =
  '너는 1인 AI 콘텐츠 회사의 자율 편집 기획자다. 소재 범위의 기준은 [브랜드 컨텍스트]다 — 소개가 말하는 영역 안에서만, ' +
  '금지 목록의 소재는 절대 제안하지 마라. [팀·업무 범위]는 제작 공정 설명일 뿐 소재 범위가 아니다. ' +
  '다음에 제작하면 검색 노출·유입에 가치있는 네이버 블로그(정보/하우투·리뷰) 콘텐츠 아이디어를 서로 소재가 다른 8개, 가장 자신 있는 것부터 순서대로 제안하라(2026-08-27 사용자 확정 8개 — 검색량·시기·수종 게이트가 겹쳐 후보가 전멸하지 않게 폭을 넓힌다).\n' +
  '- 검색 의도가 뚜렷하고 실용적인 주제(하우투/비교/리뷰/체크리스트 등). 시의성·계절성도 고려한다.\n' +
  '- [브랜드 컨텍스트]가 있으면 그 기업의 제품·타겟 고객의 관심사와 자연스럽게 연결되는 주제를 우선하라(노골적 광고성 주제 금지 — 독자에게 유용한 정보가 우선).\n' +
  '- [성과 상위 키워드]는 어떤 분야가 통했는지의 참고다 — 그 분야의 인접·연관 영역에서 새로운 키워드를 발굴하라(성과 키워드 자체나 그 변형의 재사용은 금지). 없으면(콜드스타트) 영역 안에서 다양하게 탐색한다.\n' +
  '- 단, 성과 기록에는 브랜드 범위가 지금과 달랐던 시절의 주제가 남아 있을 수 있다. 그런 키워드는 "무엇이 통했나"의 신호(예: 계절 타이밍·비교·증상 진단 같은 접근 방식)로만 읽고, 그 소재 자체나 인접 소재로 확장하지 마라 — 소재 범위의 기준은 언제나 [브랜드 컨텍스트]다.\n' +
  '- [최근 제작]·[최근 자율주제]와 중복되지 않게 하라.\n' +
  '- [기존 콘텐츠]와 겹치지 않는 새 소재를 우선하라. 좋은 주제가 기존과 겹치면 버리지 말고, 기존 글과 뚜렷이 다른 시각(대상·상황·계절·관점)을 잡아 제안하라(사용자 원칙 2026-08-14 — 종전 "완전히 새로운 각도만"에서 개정).\n' +
  '- title 은 클릭·검색에 유리한 한국어 제목, keyword 는 검색량 있을 법한 핵심 타겟 키워드 1개, subNiche 는 세부 분야다.\n' +
  '- keyword 는 사람이 실제로 검색창에 치는 2~3어절(수종명+행위·대상: "매실나무 가지치기", "사과나무 묘목", "느티나무 심는 시기")로 써라. 설명형 구절("묘목 식재 흙 준비", "정원 과실나무 크기" 식)은 검색량이 0이라 코드가 기각한다 — [검색 수요 실측] 표에 있는 표기를 우선 재사용하라.';

/**
 * 다음에 제작할 콘텐츠 아이디어 1건 제안 — 조직 헌장(팀·업무 범위) + 성과 전략(strategy.json)에 그라운딩.
 * 위키 인덱스는 주제 생성에서 제외(anti-drift): 과거 적재 자료로 편향되는 피드백 루프를 끊는다(구 gov 버전의 근본 교훈 유지).
 * 모델 — 클라우드 micro(haiku). (Ollama 로컬 분기는 백엔드 제거와 함께 삭제 — 2026-07-06)
 */
// 콘텐츠 각도 메뉴(브랜드 무관) — 아이디어가 매번 '계절 케어 하우투'로 수렴하지 않게 각도를 로테이션한다.
// '다음 시즌·시기 대비' 축은 제거(2026-08-27 사용자 확정 "지금~다음 달만" — 8월 말 단풍 실사고). 시의성은
// seasonalContext(절기)와 [시기 밖 소재] 블록이 담당한다.
const IDEA_ANGLES = [
  '하우투(단계별 실행 절차)', '구매·선택 가이드(옵션 비교·고르는 기준)', '흔한 실패·오해 바로잡기',
  '초보 입문(처음 시작하는 사람 기준)', '증상·상황별 진단',
  '실제 사례·후기 관점', '한 가지 쟁점 깊이 파기',
];
/** 후보 파서(순수, 테스트 대상) — {ideas:[...]} 8후보 응답을 방어적으로 정규화. 구형 단일 오브젝트
 *  응답({title,...})도 1건 목록으로 수용(하위호환). 제목 정리·중복 제거·상한. */
export const IDEA_CANDIDATES = 8; // 2026-08-27 사용자 확정(5→8)
export function normalizeIdeaCandidates(raw: unknown, max = IDEA_CANDIDATES): Array<{ title: string; keyword?: string; subNiche?: string }> {
  const src = (raw as { ideas?: unknown } | null)?.ideas;
  const list = Array.isArray(src) ? src : [raw];
  const out: Array<{ title: string; keyword?: string; subNiche?: string }> = [];
  const seen = new Set<string>();
  for (const o of list) {
    const title = asString((o as { title?: unknown } | null)?.title).trim().replace(/^["'\-•\s]+/, '').slice(0, 120);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const keyword = asString((o as { keyword?: unknown } | null)?.keyword).trim();
    const subNiche = asString((o as { subNiche?: unknown } | null)?.subNiche).trim();
    out.push({ title, ...(keyword ? { keyword } : {}), ...(subNiche ? { subNiche } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/** 이름·꽃말·상징 유래 주제의 수종 앵커 부재 판정(순수, 테스트 대상) — '회화나무 꽃말'은 통과,
 *  '튤립 꽃말'·'나무 이름 유래'(총칭)는 기각. '~나무' 표기가 한국어 수종명 대부분을 커버한다. */
export function lacksSpeciesAnchor(text: string): boolean {
  const t = (text || '').normalize('NFC');
  // '상징'은 수사적 사용("가을의 상징")이 흔해 트리거에서 제외 — 축의 핵심 표지인 꽃말·유래만 본다.
  if (!/꽃말|유래/.test(t)) return false;
  return !/[가-힣]{1,6}나무/.test(t);                        // 수종 앵커(○○나무) 존재 여부
}

/**
 * 후보 1건의 검색 수요 판정 + 로그·기각사유 문구(순수, 테스트 대상).
 *
 * 종전 주제 선정은 절대 검색량을 한 번도 보지 않았다 — 실측(2026-08-26)으로 우리가 쓰던 롱테일이
 * 0~30/월이었고('가을 거름' 0·'유실수 가을 시비' 0·'사과나무 비료' 30), '비료' 계열은 데이터랩
 * 8월 지수가 3월의 13% 였다. 소재가 아니라 **표기와 시기**가 문제였다는 뜻이라, 후보 단계에서
 * 이 둘을 갈라 본다: 검색량 하한 미달만 하드 기각, 비수기는 후순위(demote)다.
 *
 * rows 에 없는 키워드(미조회·조회 실패·keyword 없음)는 unknown — 게이트를 통째로 생략한다(fail-open).
 * '수요가 없다'는 단정은 실제 응답을 받았을 때만 한다.
 *
 * opts.relax: 마지막 라운드의 기아 방지 밸브 — 하한 미달을 기각 대신 후순위로 낮춘다(`relaxed: true`).
 * 통과·비수기 판정은 건드리지 않는다(밸브가 만든 후순위인지 원래 비수기인지 채택 로그가 갈려야 하므로).
 *
 * opts.remembered: 지난 틱에 실측으로 하한 미달을 받아 기억된 키워드(2026-08-27) — rows 를 아예 보지 않고
 * 그때의 실측 줄로 판정한다(그래서 호출부는 이 후보를 API 조회 대상에서도 뺀다 — 조회 비용 0).
 */
export function demandGateDecision(
  rows: Map<string, DemandRow>,
  keyword: string | undefined,
  cfg: { minVolume: number; minSeason: number },
  opts: { relax?: boolean; remembered?: { line: string } } = {},
): { verdict: DemandVerdict; line: string; relaxed?: boolean } {
  // 기억된 기각은 rows 보다 먼저 본다 — 이 후보는 조회하지 않았으니 rows 에 없고(unknown = fail-open),
  // 순서를 뒤집으면 기억이 통째로 무력화된다. 기아 방지 밸브는 기억에도 똑같이 적용한다: 규칙을 갈라 두면
  // '기억됐다는 이유로' 마지막 라운드 밸브가 안 먹혀 후보 전멸 시 슬롯이 선다.
  if (opts.remembered) {
    return opts.relax
      ? { verdict: 'demote', line: opts.remembered.line, relaxed: true }
      : { verdict: 'reject', line: opts.remembered.line };
  }
  // 정확 일치 우선, 실패하면 정규화 대조 — assessCandidatesDemand 가 정규화 키로 중복을 걸러 담기 때문에
  // '가을 거름'과 '가을거름'이 한 라운드에 같이 오면 뒤엣것이 미조회로 빠져 게이트를 그냥 통과했다.
  const row = keyword
    ? rows.get(keyword) ?? [...rows.values()].find((r) => normKw(r.keyword) === normKw(keyword))
    : undefined;
  const line = row ? formatDemandLine(row) : '';
  const verdict = demandVerdict(row, cfg);
  if (opts.relax && verdict === 'reject') return { verdict: 'demote', line, relaxed: true };
  return { verdict, line };
}

/**
 * 이번 판정을 기각 기억(원장)에 남길 것인가(순수, 테스트 대상).
 *
 * `remembered` 가 있으면 항상 false — 이 가드가 이 함수의 존재 이유다. 지워지면 후보 루프가 기억을 읽을
 * 때마다 다시 써서 `ts` 가 매 틱 갱신되고, TTL 30일이 영영 만료되지 않는 '조용한 영구 금지'가 된다.
 * `relaxed: true` 는 'API 원 판정이 reject 였는데 마지막 라운드 밸브가 후순위로 낮췄다'는 뜻이라 기억
 * 대상이고, 순수 비수기 demote 는 아니다(수요는 있고 지금이 아닐 뿐 — 다음 시즌에 다시 제안돼야 한다).
 * `unknown` 도 아니다(미조회·조회 실패 = '측정 안 함'이라, 기억하면 미측정이 30일 금지로 굳는다 — fail-open).
 *
 * 반환 타입이 술어(`keyword is string`)인 것은 호출부에서 `keyword` 를 좁혀 중복 `&& keyword` 를 없애기 위함.
 */
export function shouldRememberDemandReject(
  demand: { verdict: DemandVerdict; relaxed?: boolean },
  remembered: unknown,
  keyword: string | undefined,
): keyword is string {
  if (remembered || !keyword) return false;
  return demand.verdict === 'reject' || demand.relaxed === true;
}

/**
 * 후순위 보관함에서 채택할 후보 하나(순수) — rank 오름차순, 같은 rank 는 먼저 담긴 순서를 유지한다
 * (rank 0=비수기, 1=기아 방지 밸브. '지금 덜 찾는 소재'가 '아예 검색량이 없는 소재'보다 항상 낫다).
 * 엄격 부등호 비교라서 안정성이 구현에 박혀 있다 — sort 로 바꾸면 동률 순서 보장을 잃는다.
 */
export function pickDemoted<T extends { rank: number }>(list: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const cur of list) if (best === undefined || cur.rank < best.rank) best = cur;
  return best;
}

/**
 * 라운드 끝 채택 경합(순수) — 후순위 보관함 vs 유사 폴백. 어느 쪽이 이기는지만 돌려주고 로그·조립은
 * 호출부가 한다(경로별 로그 문구를 그대로 유지하기 위해).
 *
 * rank 0(비수기)은 폴백을 이긴다 — 아직 안 다룬 새 소재이고 소재 자체엔 수요가 있다(지금 덜 찾을 뿐).
 * rank 1(기아 방지 밸브 = 검색량 하한 미달)은 폴백에 진다(2026-08-26 최종 리뷰 I3) — '이 표기로는
 * 아무도 안 찾는다'가 실측된 후보라, 이미 다룬 소재라도 검색량이 확인된 유사 폴백이 낫다. 폴백이
 * 없으면 rank 1 도 채택한다(좌초보다는 생산).
 */
export function pickRoundAdoption<T extends { rank: number }>(
  demoted: readonly T[],
  hasFallback: boolean,
): { source: 'demoted'; pick: T } | { source: 'fallback' } | undefined {
  const best = pickDemoted(demoted);
  if (best && (best.rank !== 1 || !hasFallback)) return { source: 'demoted', pick: best };
  if (hasFallback) return { source: 'fallback' };
  return undefined;
}

export async function proposeContentIdeas(signal?: AbortSignal): Promise<ContentIdea | null> {
  const c = getCompany();
  // 팀·업무 범위(헌장) — 아이디어 생성의 재료(회사 정체성·콘텐츠 영역이 specialty 에 담겨 있음).
  // 비서실(자비스)은 응대·라우팅 헌장이라 콘텐츠 영역이 아님 — 주제 그라운딩 오염 방지 위해 제외.
  const teamLines = (c.teams ?? [])
    .filter((t) => t.id !== 'secretariat')
    .map((t) => `- ${t.name}: ${(t.lead?.specialty || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter((l) => l.length > 6)
    .join('\n');
  if (!teamLines.trim()) return null; // 조직 구성이 없으면 제안 불가

  const done = readSafe(path.join(CONFIG.dataDir, '_shared', `decisions${brandFileSuffix()}.md`)).slice(-500);
  const winners = readStrategyWinners();

  const micro = resolveAssignment().micro;
  // 브랜드 슬러그는 여기서 한 번 고정한다 — 프롬프트 조립과 후보 루프가 LLM 왕복(수 초)을 여러 번 건너므로
  // 그 사이 브랜드가 전환되면 기각 기억을 A 로 읽고 B 에 쓰게 된다(아래 ResearchState 의 slug 고정과 같은 버그).
  const slug = activeBrandSlug() || '';
  const speciesCov = speciesCoverageFor(slug);   // 수종 로테이션(2026-08-27) — 프롬프트 블록·후보 게이트·winners 필터 공용
  const themeCov = brandThemeCoverage(new Date(), slug);   // 주제 축 로테이션(2026-08-27) — 수종과 직교

  // 브랜드 설정 시: 주제를 브랜드 제품·타겟에 조향 + 콜드스타트는 시드 키워드에서 출발 +
  // subNiche 를 제품 라인으로 제약(기존 서브니치 EWMA 가 그대로 '제품 라인별 성과 학습'이 된다).
  const brand = brandContext();
  const seeds = brandSeedKeywords();
  const productLines = brandProductLines();
  // "없음"이 아니라 "쓸 수 있는 게 없음" — 시대 컷오프(perfEraSince)로 옛 정체성 성과를 일부러 뺀
  // 경우가 있어서, 데이터가 아예 없다고 말하면 두뇌가 '신생 브랜드'로 오해한다.
  const coldstart = seeds.length
    ? `(지금 정체성에 쓸 성과 키워드 없음 — 아래 브랜드 시드 키워드에서 출발해 탐색)\n${seeds.map((k) => `- ${k}`).join('\n')}`
    : '(없음 — 콜드스타트)';
  const seedBlock = seedKeywordBlock(winners, seeds);
  // 신규성 가드(사용자 원칙 2026-07-15) — 브랜드의 기존 글·쇼츠·카드뉴스 제목+키워드와 유사 금지.
  // 프롬프트 주입(사전)과 findSimilarContent 사후 검사 이중 방어 — 유사하면 기각 사유를 담아 1회 재시도.
  const existing = collectExistingContent(activeBrandSlug() || undefined);
  const existingLines = existing.slice(0, 30)
    .map((e) => `- (${e.kind}) ${e.title}${e.keyword ? ` [키워드: ${e.keyword}]` : ''}`).join('\n');
  // 다양성 강제(2026-07-23 감사) — 킬스위치 CONTENT_DIVERSITY=off 로 끔. 표면 novelty 가 못 잡는 '소재 쏠림'을
  // 포화 소재어 회피 + 각도 로테이션으로 완화(탐색 예산). 실효는 향후 몇 편의 실제 산출로만 판단 가능.
  const diversityOn = process.env.CONTENT_DIVERSITY !== 'off';
  // 합성어 어간은 브랜드 설정에서(업종어) — 미설정 브랜드는 확장 없이 종전 동작.
  const satTokens = diversityOn ? saturatedThemes(existing, 3, getBrand()?.compoundStems ?? []).slice(0, 15).map((t) => t.token) : []; // 상위 15개(빈도순)만 — 과도한 회피목록 방지
  const diversityBlock = diversityOn
    ? `[이미 포화된 소재 — 이번엔 이 소재어들을 피하라]\n${satTokens.length ? satTokens.join(', ') : '(아직 포화 없음 — 자유롭게)'}\n\n`
      + `[이번 글의 각도 — 아래 중 최근 자율주제와 다른 각도 하나를 골라 그 각도로 잡아라]\n${IDEA_ANGLES.join(' | ')}\n\n`
    : '';
  // 어휘 함정어를 소스에서 차단(실측 2026-08-10: 아이디어가 keyword 를 "유실수 가을 시비"로 뽑자
  // 하류의 키워드 정확 표기 강제가 어휘 가드를 이겨 제목·본문에 함정어가 살아남았다 — SEO 리비전조차
  // 키워드 고정 때문에 못 뺀다. keyword 가 태어나는 여기가 유일하게 싼 차단 지점).
  const jargonList = getBrand()?.avoidJargon ?? [];
  // 계열 원장 v2(2026-08-25) — 미분류 편 배치 분류(대개 no-op) 후 감쇠 점수 요약.
  // hard=기각 대상, soft=회피 권고+신호(트렌드·기회) 제외만. 실패는 전부 fail-open(빈 요약).
  await ensureSeriesLabels(activeBrandSlug() || undefined, signal).catch(() => {});
  const cdown = cooldownSummary(activeBrandSlug() || undefined);
  const seriesScores = seriesScoresFor(activeBrandSlug() || undefined);
  // 여유 시드는 라벨 게이트로 판정(리뷰 지적: 부분문자열 대조는 '심는'≠'심기' 활용형을 놓쳐
  // 쿨다운 계열 시드를 '여유 있는 방향'으로 추천하는 자기모순을 만들었다).
  const freeSeeds = seeds.filter((k) => gateForLabels(fillLabelsFromKnown(k, fallbackSeriesLabels(k), seriesScores), seriesScores).level === 'none');
  const jargonLine = jargonList.length
    ? `[제목·키워드 어휘] 다음 말은 일반 독자가 다른 뜻으로 읽거나 모른다 — title·keyword 에 쓰지 말고 화살표처럼 풀어 써라: ${jargonList.map((j) => `${j.term}→${j.use}`).join(', ')}\n\n`
    : '';
  const baseUser =
    // 절기 시의성 신호(2026-08-07 사용자 제안) — 종전엔 "시의성·계절성 고려" 지시만 있고 오늘 날짜가
    // 없어 공회전했다. 날짜+절기 한 줄이면 두뇌가 "처서 지나면 가을 식재 준비" 같은 타이밍을 스스로 잡는다.
    `${seasonalContext()}\n\n` +
    (() => { const b = seasonalSubjectBlock(getBrand()?.seasonalSubjects); return b ? `${b}\n\n` : ''; })() +
    (() => { const b = speciesRotationBlock(getBrand()?.speciesCatalog, speciesCov); return b ? `${b}\n\n` : ''; })() +
    (() => { const b = themeRotationBlock(getBrand()?.topicThemes, themeCov); return b ? `${b}\n\n` : ''; })() +
    jargonLine +
    (brand ? `${brand}\n\n` : '') +
    `[팀·업무 범위]\n${teamLines}\n\n` +
    `[성과 상위 키워드(참고용 씨앗 — 이 테마만 반복하지 말 것)]\n${winners || coldstart}\n\n` +
    seedBlock +
    // 후속 카드(2026-08-12) — 제목 유형 A/B 실측을 기획에 연결. 표본 게이트 미달이면 빈 문자열(무주입).
    titleTypeGuidanceBlock(activeBrandSlug() || '') +
    // 조회수 감사(2026-08-20) 3종 배선 — 전부 데이터 부족·실패 시 빈 문자열(무주입, fail-open).
    // ① 쇼츠 채널 실측: 파생 숏폼 YT/IG 조회수가 주제 선정에 처음으로 되먹임된다(종전 winners=블로그 전용).
    shortsTopicSignalBlock(activeBrandSlug() || '') +
    // ② 리서치 실측 판정 역류: 폐기(avoid)·기회(opportunity) 키워드 — 하드 계열의 기회만 주입 제외
    //    (소프트 계열의 검증된 기회는 살린다 — 리뷰 지적: 소프트 제외+정렬 중첩이 준하드로 작동하던 문제).
    topicVerdictBlock(undefined, cdown.excludeTokensHard) +
    // ③ 실검색 연관어(네이버+유튜브 자동완성 일일 스냅샷 diff): 쿨다운 계열 시드는 목록에서 제외.
    trendSignalBlock(undefined, cdown.excludeTokens) +
    // ③-a 검색 수요 실측(2026-08-26): 시드 키워드의 절대 검색량·시즌 지수 표. 연관어(무엇을 검색하나)
    //     옆에 붙여야 두뇌가 '이 표기로 몇 명이 찾는가'까지 함께 본다. 스냅샷 없음·킬스위치 off 면 빈 문자열.
    //     쿨다운 계열 행은 뺀다 — 금지된 계열이 '수요 있는 소재'로 표에 남으면 지시끼리 충돌한다.
    demandSignalBlock(activeBrandSlug() || '', cdown.excludeTokens) +
    // ③-a' 수요 미달로 이미 기각된 키워드(2026-08-27): 재제안 금지 목록. 수요 표 바로 뒤에 붙여야
    //      '수요가 있는 것'과 '이미 없다고 실측된 것'을 두뇌가 한 자리에서 본다. 항목 없으면 빈 문자열.
    //      아래 [신호 우선순위]의 "금지가 항상 이긴다"가 이 블록에도 그대로 적용된다(줄 변경 불필요).
    demandRejectBlock(slug) +
    // ③-b 유튜브 니치 동향(2026-08-25): 최근 7일 조회 상위 영상 — 소재·프레이밍의 실반응 신호.
    ytNicheBlock(undefined, cdown.excludeTokens) +
    // ④ 계열 쿨다운 v2(감쇠 점수): 하드=금지(아래 후보 게이트가 코드로도 기각), 소프트=회피 권고 + 빈 방향 유도.
    ((cdown.hard.length || cdown.soft.length)
      ? `[계열 쿨다운 — 최근 집중해서 다룬 계열(괄호는 감쇠 점수)]\n`
        + (cdown.hard.length ? `금지: ${cdown.hard.join(', ')} — 이 계열·조합은 제안 불가.\n` : '')
        + (cdown.soft.length ? `가급적 회피: ${cdown.soft.join(', ')} — 꼭 쓰려면 안 다룬 새 조합(다른 행위·상황)으로만.\n` : '')
        + (freeSeeds.length ? `여유 있는 방향(쿨다운 아닌 시드 예): ${freeSeeds.slice(0, 6).join(', ')}\n` : '')
        + '\n'
      : '') +
    // 신호 서열 선언(리뷰 지적) — 명령형 블록 6종이 서열 없이 나열되면 micro 가 어느 지시에 최적화할지 비결정적.
    // 로테이션을 서열 1군에 명시(2026-08-30) — 종전 서열은 쿨다운·폐기·유사만 '금지'로 세우고 축·수종
    // 상한을 빼놨다. 그러면 아래 시드·수요 표·연관어가 막힌 축 키워드를 내밀 때 두뇌가 그쪽을 따르고,
    // 후보 8개가 전부 코드 기각으로 날아간다(실측 2026-08-30: 한 라운드 기각 17건 중 대부분이 축 상한,
    // 16축 중 7축 포화 상태에서 생산이 멈춤). 로테이션 블록은 이미 '제안 금지'라 적고 있었지만 서열
    // 선언이 그것을 1군으로 인정하지 않아 지시끼리 사실상 동급이었다.
    `[신호 우선순위 — 위 신호들이 충돌할 때] 1) **주제 축·수종 상한 도달(제안 금지)** · 계열 쿨다운 금지·실측 폐기·기존 콘텐츠 유사 회피(금지) > 2) 리서치 기회·실검색 연관어·검색 수요 실측(우선 검토) > 3) 성과 계열 확장(참고). 금지가 항상 이긴다.\n`
      + `상한 도달 축·수종은 아래 어떤 신호(시드·수요 표·연관어·성과 키워드)에 등장하더라도 후보로 내지 마라 — 코드가 기각해 그 자리가 통째로 버려진다. '아직 안 다룬 축'이 있으면 그 축에서 먼저 채워라.\n\n` +
    `[기존 콘텐츠 — 주제·키워드 유사 금지]\n${existingLines || '(없음)'}\n\n` +
    `[최근 제작 — 중복 회피]\n${done || '(없음)'}\n\n` +
    `[최근 자율주제 — 중복 회피]\n${recentAuto.slice(-5).join('\n') || '(없음)'}\n\n` +
    diversityBlock +
    (productLines.length ? `subNiche 는 반드시 다음 제품 라인 중 가장 관련 있는 하나로: ${productLines.join(' | ')}\n\n` : '') +
    `형식: {"ideas":[{"title":"...","keyword":"...","subNiche":"..."} — 서로 소재가 다른 8개]}`;

  // 후보 수 확장(2026-08-14, 사용자 승인) — 사이클당 1건×2시도는 포화 시즌에 슬롯 좌초를 만들었다
  // (08-12~14 3슬롯 연속: 틱당 보류 2+기각 2~4, 지연 38분+). 한 호출로 5후보를 받아 게이트를 통과하는
  // 첫 후보를 채택 — 개당 통과율 p 일 때 시도당 통과율이 1-(1-p)^5 로 뛴다. 비용은 haiku 소형 호출 1회분.
  let rejectNote = '';
  const IDEA_ROUNDS = 2;   // 마지막 라운드 판정(기아 방지 밸브)이 이 숫자에 매달려 있어 상수로 묶는다
  for (let attempt = 0; attempt < IDEA_ROUNDS; attempt++) {
    const o = await microJSON<{ ideas?: unknown }>(
      micro, IDEA_SYSTEM, rejectNote ? `${baseUser}\n\n${rejectNote}` : baseUser, { maxOutputTokens: 900, signal },
    ).catch(() => null);
    const cands = normalizeIdeaCandidates(o);
    if (!cands.length) return null; // 응답 자체가 무효 — 이번 주기 스킵
    // 검색 수요 묶음 조회(2026-08-26) — 라운드당 딱 1회(검색광고 ≤2콜 + 데이터랩 1콜). 후보당 개별
    // 조회는 라운드당 수십 콜이 된다. 킬스위치 off 면 호출 자체를 생략해 비용이 0이다.
    // 검색광고 자격이 없으면(키 미설정) 조회도 로그도 하지 않는다 — '조회 실패'가 아니라 '측정 안 함'이고,
    // 그 상태에서 "조회 없음 채택" 같은 줄을 남기면 하지도 않은 측정을 했다고 로그가 주장하게 된다.
    const demandOn = CONFIG.topicDemandGate && searchAdEnabled();
    const demandCfg = { minVolume: CONFIG.topicDemandMinVolume, minSeason: CONFIG.topicDemandMinSeason };
    // 기억된 기각 키워드는 조회 대상에서 뺀다(2026-08-27) — 판정은 기억으로 이미 나 있으므로 조회 비용 0.
    const demandTargets = demandOn
      ? cands.map((c) => c.keyword).filter((k): k is string => !!k && !demandRejectFor(slug, k))
      : [];
    // 후보 계열 분류(라운드당 micro 1콜, 실패 시 결정적 폴백 + 원장 키 포함 대조 보강) + 게이트 선계산.
    // 소프트 후보는 뒤로 미룬다(안정 정렬) — none 후보가 있으면 그쪽을 먼저 채택.
    // 계열 분류와 수요 조회는 서로 무관한 외부 왕복이라 같이 기다린다(틱 지연을 직렬로 늘리지 않게).
    const [candLabels, demandRows] = await Promise.all([
      classifyCandidates(cands, signal),
      // 조회 예외가 Promise.all 을 거부시키면 계열 분류까지 잃고 틱 전체가 날아간다 — 레그 단위로 삼킨다.
      demandTargets.length
        ? assessCandidatesDemand(demandTargets, signal).catch(() => new Map<string, DemandRow>())
        : Promise.resolve(new Map<string, DemandRow>()),
    ]);
    // fail-open — 요청은 했는데 응답이 통째로 비면 '검색량 0'이 아니라 '모름'이다(키 없음·HTTP 오류 포함).
    if (demandTargets.length && !demandRows.size) console.log('[auto-cycle] 수요 조회 실패 — 게이트 생략');
    // 채택 시 수요 실측을 한 줄 남긴다(세 채택 경로 공용) — 나중에 '왜 이 주제였나'를 로그만으로 재구성하려면
    // 기각뿐 아니라 통과한 후보의 숫자도 있어야 한다. 게이트 off 면 아무 말도 하지 않는다(무주입 원칙).
    // 판정 line 을 아는 호출부는 그대로 넘긴다 — 기억으로 기각됐다가 밸브·폴백으로 되살아난 후보는
    // 애초에 조회 대상에서 빠져(demandTargets) demandRows 에 없으므로, 여기서 다시 계산하면 실측이
    // 엄연히 있는데도 '조회 없음 채택'이라고 로그가 주장하게 된다(위 무주입 원칙의 대칭 사고).
    const logDemandAdopt = (title: string, keyword?: string, known?: string): void => {
      if (!demandOn) return;
      const line = known || demandGateDecision(demandRows, keyword, demandCfg).line;
      console.log(`[auto-cycle] 수요 게이트 — "${title}" ${line || '조회 없음'} 채택`);
    };
    const gated = cands.map((cand, i) => ({
      cand,
      gate: gateForLabels(fillLabelsFromKnown(`${cand.title} ${cand.keyword ?? ''}`, candLabels[i]!, seriesScores), seriesScores),
    })).sort((a, b) => (a.gate.level === 'soft' ? 1 : 0) - (b.gate.level === 'soft' ? 1 : 0));
    const rejects: string[] = [];
    // 유사 폴백(사용자 원칙 개정 2026-08-14) — 기존과 유사한 후보는 기각이 아니라 '다른 시각 생성'
    // 대상. 새 소재 후보를 우선하되, 이번 라운드에 새 소재가 없으면 유사 후보를 채택한다 — 집필 시점에
    // priorCoverageBrief 가 이전 글 앵글을 주입해 프레이밍을 바꾼다(same-topic different content 배선).
    let similarFallback: ContentIdea | null = null;
    let similarFallbackLine = '';   // 그 후보의 수요 판정 문구(기억 경로는 demandRows 에 없다 — 채택 로그용)
    // 후순위 보관함 — 라운드 안에서만 산다(라운드 밖에 두면 1라운드 기각 사유를 되먹인 뒤에도
    // 그 라운드의 후보가 2라운드 끝에 되살아난다). rank 0=비수기, 1=기아 방지 밸브(아래).
    // line 은 그 후보의 판정 문구 — 채택 로그가 '조회 없음'으로 새지 않게 함께 들고 간다(기억 경로는
    // 조회 대상에서 빠져 demandRows 에 없다).
    const demoted: Array<{ idea: ContentIdea; rank: 0 | 1; line: string }> = [];
    for (const { cand, gate } of gated) {
      const { title, keyword } = cand;
      if (recentAuto.includes(title)) {
        // 종전엔 여기서 로그 없이 전체 return null — 재탕 제목 하나가 슬롯을 '침묵 좌초'시켰다(08-14 관측).
        console.log(`[auto-cycle] 아이디어 스킵(최근 제안 재탕) — "${title}"`);
        rejects.push(`"${title}"=최근 제안 재탕`);
        continue;
      }
      // 브랜드 소재 게이트(하드) — 프롬프트 유도가 실패해도 금지 소재는 코드가 막는다(2026-07-31 정체성 각인).
      const off = offBrandTerm(`${title} ${keyword ?? ''}`);
      if (off) {
        console.log(`[auto-cycle] 아이디어 기각(브랜드 범위 밖) — "${title}" (소재 "${off}")`);
        rejects.push(`"${title}"=브랜드가 안 다루는 소재(${off})`);
        continue;
      }
      // 시기 소재 게이트(하드, 비용 0) — 검색량 게이트는 keyword 만 재므로 제목의 달력 소재를 따로 본다
      // (2026-08-27: "활엽수" 키워드(시즌 0.81)에 단풍 글이 묻어 나감). 이번 달·다음 달 밖이면 기각.
      const offSeason = offSeasonSubject(`${title} ${keyword ?? ''}`, getBrand()?.seasonalSubjects);
      if (offSeason) {
        console.log(`[auto-cycle] 아이디어 기각(시기 밖 소재) — "${title}" (${offSeason.term}: ${formatMonths(offSeason.months)}, 지금 ${new Date().getMonth() + 1}월)`);
        rejects.push(`"${title}"=시기 밖 소재(${offSeason.term}은 ${formatMonths(offSeason.months)} — 지금~다음 달 검색 소재만)`);
        continue;
      }
      // 수종 월 상한 게이트(하드, 비용 0, 2026-08-27) — 최근 30일 같은 수종 블로그가 상한이면 어떤 각도든 기각.
      // 유사 폴백보다 앞이라 '다른 시각' 우회도 막힌다(배롱 8편/월 실사고).
      const capped = overSpeciesCap(`${title} ${keyword ?? ''}`, speciesCov, getBrand()?.speciesCatalog);
      if (capped) {
        console.log(`[auto-cycle] 아이디어 기각(수종 월 상한) — "${title}" (${capped.name}: 30일 ${capped.count}편 ≥ ${SPECIES_MONTHLY_CAP})`);
        rejects.push(`"${title}"=수종 월 상한(${capped.name} 최근 30일 ${capped.count}편 — 아직 안 다룬 수종으로)`);
        continue;
      }
      // 주제 축 월 상한 게이트(하드, 비용 0, 2026-08-27) — 같은 축(심기·구매·거름·전정…)이 30일 상한이면 기각.
      const cappedTheme = overThemeCap(`${title} ${keyword ?? ''}`, themeCov, getBrand()?.topicThemes);
      if (cappedTheme) {
        console.log(`[auto-cycle] 아이디어 기각(주제 축 월 상한) — "${title}" (${cappedTheme.theme}: 30일 ${cappedTheme.count}편 ≥ ${THEME_MONTHLY_CAP})`);
        rejects.push(`"${title}"=주제 축 월 상한(${cappedTheme.theme} 최근 30일 ${cappedTheme.count}편 — 아직 안 다룬 축으로)`);
        continue;
      }
      // 어휘 함정어 게이트(하드) — keyword 로 태어난 함정어는 하류 어디서도 못 뺀다(키워드 고정 강제가
      // 어휘 가드·린트·리비전을 전부 이김, 실측 2026-08-10 "유실수 가을 시비"). 프롬프트 유도 실패 대비 코드 차단.
      const jarg = lintLexicon(`${title} ${keyword ?? ''}`, jargonList);
      if (jarg.length) {
        console.log(`[auto-cycle] 아이디어 기각(어휘 함정어) — "${title}" ("${jarg[0]!.term}")`);
        rejects.push(`"${title}"=함정어(${jarg[0]!.term} — ${jarg[0]!.use}로)`);
        continue;
      }
      // 리서치 폐기 판정 게이트(하드, 2026-08-20) — 실측으로 폐기된 키워드가 프롬프트 지시를 뚫고
      // 재제안되던 실사고(처서: 08-16 폐기 판정 후 08-18~20 3건 재배정) 봉합. 정규화 완전 일치만
      // 기각해 과차단을 막는다(파생 주제 판단은 프롬프트의 topicVerdictBlock 이 담당).
      const avoided = keyword ? avoidVerdictFor(keyword) : null;
      if (avoided) {
        console.log(`[auto-cycle] 아이디어 기각(리서치 폐기 판정) — "${title}" (키워드 "${keyword}": ${avoided.reason.slice(0, 50)})`);
        rejects.push(`"${title}"=리서치 실측 폐기 키워드(${keyword} — ${avoided.reason.slice(0, 40)})`);
        continue;
      }
      // 검색 수요 게이트(하드 기각 1종, 2026-08-26) — 절대 검색량(검색광고)이 하한 미달이면 기각한다.
      // 계열 최대(표기만 다른 연관어)까지 봐도 미달일 때만이라, '표기가 나쁜 좋은 소재'는 살아남는다.
      // 비수기(시즌 지수 미달)는 여기서 판정만 하고 기각하지 않는다 — 처리는 아래 채택 직전(후순위).
      //
      // 기아 방지 밸브(마지막 라운드) — 우리 롱테일은 실측 0~30/월이라 5후보가 통째로 하한에 걸릴 수 있고,
      // 2라운드까지 전멸하면 null 을 반환해 슬롯이 선다. 그래서 마지막 라운드에서는 하한 미달을 기각이
      // 아니라 후순위로 낮춘다(아래 소재 포화 게이트의 'attempt 0 에서만 … 기아 방지' 선례와 같은 형태).
      // 첫 라운드는 종전대로 하드 기각이라 사유가 rejectNote 로 두뇌에 전달돼 2라운드 제안이 실제로 바뀐다.
      //
      // 기각 기억(2026-08-27) — 지난 틱에 실측으로 하한 미달을 받은 키워드는 조회 없이 그때의 줄로 기각하고,
      // 이번 틱에 새로 난 API 기각은 기억에 남긴다. 이미 기억된 건은 다시 쓰지 않는다(쓰면 읽을 때마다
      // ts 가 갱신돼 TTL 30일이 영영 끝나지 않는다).
      // 기억 조회에는 `demandOn`(검색광고 키 여부)을 걸지 않는다 — 기억은 이미 받아 둔 실측이라 키가
      // 필요 없고(그게 '재조회 0'의 요점), 프롬프트의 금지 블록은 CONFIG.topicDemandGate 만 보므로
      // 여기에 키 조건을 더하면 "제안 금지"라고 시켜 놓고 게이트는 통과시키는 지시 충돌이 난다.
      const remembered = demandRejectFor(slug, keyword);
      const demand = demandGateDecision(demandRows, keyword, demandCfg, {
        relax: attempt === IDEA_ROUNDS - 1,
        ...(remembered ? { remembered: { line: remembered.line } } : {}),
      });
      // 기억은 '실측 결과'이지 '채택 자격'이 아니다 — 판정이 난 자리에서 바로 기록한다. 아래 게이트
      // (계열 하드·수종 앵커·유사·소재 포화)에 먼저 걸려 continue 되는 후보도 실측은 이미 받았으므로,
      // 여기서 기록하지 않으면 다음 틱에 같은 키워드가 또 검색광고 조회를 태운다(이 태스크가 없애려던
      // 재조회 낭비가 마지막 라운드 경로에만 남던 비대칭). 실패는 함수 안에서 삼켜지는 fire-and-forget.
      if (shouldRememberDemandReject(demand, remembered, keyword)) rememberDemandReject(slug, keyword, demand.line);
      if (demand.verdict === 'reject') {
        console.log(remembered
          ? `[auto-cycle] 아이디어 기각(검색 수요 미달·기억) — "${title}" (${demand.line})`
          : `[auto-cycle] 아이디어 기각(검색 수요 미달) — "${title}" (${demand.line})`);
        rejects.push(`"${title}"=검색 수요 미달(${demand.line})`);
        continue;
      }
      // 계열 쿨다운 v2 게이트(하드만 기각, 2026-08-25) — 감쇠 점수 기반. 조합(수종×행위)은 엄격,
      // 단독은 느슨, 소프트는 기각 없이 순서만 뒤로(위 정렬) — 포도 4편/6일·전정 6편/7일 실사고 계보.
      if (gate.level === 'hard') {
        console.log(`[auto-cycle] 아이디어 기각(계열 쿨다운 하드) — "${title}" (${gate.key}: ${gate.why})`);
        rejects.push(`"${title}"=계열 쿨다운(${gate.key} — 최근 집중, 다른 계열·조합으로)`);
        continue;
      }
      // 수종 앵커 게이트(하드) — 이름·상징 유래 축(4순위, 2026-08-13 투입) 전용 함정 차단. 실측(08-01):
      // '나무 이름 유래' 총칭은 검색 0이고, 앵커 없는 꽃말·유래 주제는 화초 꽃말로 미끄러지는데 브랜드
      // 소재 게이트가 못 막는다(장미·국화류는 금지 목록에 없음). '~나무' 수종 앵커를 코드로 강제한다.
      if (lacksSpeciesAnchor(`${title} ${keyword ?? ''}`)) {
        console.log(`[auto-cycle] 아이디어 기각(수종 앵커 없음) — "${title}"`);
        rejects.push(`"${title}"=꽃말·유래 주제인데 수종명(○○나무) 앵커 없음`);
        continue;
      }
      const sim = findSimilarContent({ title, ...(keyword ? { keyword } : {}) }, existing);
      if (sim.length) {
        const top = sim[0]!;
        console.log(`[auto-cycle] 아이디어 유사 감지 — "${title}" ≈ (${top.kind}) "${top.title}" → 새 소재 우선, 없으면 다른 시각으로 채택`);
        // 폴백 자격은 계열 게이트 none 후보만(리뷰 확정: 소프트 후보가 폴백으로 채택되면 창설 사고
        // 경로 — 포도 4편째 유사 폴백 채택 — 가 감쇠 완화 뒤로 다시 열린다).
        // 검색량 하한 미달(마지막 라운드 완화로 demote 된 것 포함)은 폴백 자격도 없다 — 2026-08-27 실사고:
        // "올리브나무 화분 재배" 10미만/월이 유사 폴백으로 채택돼 게이트가 무력화됐다.
        if (!similarFallback && gate.level === 'none' && !demand.relaxed) {
          similarFallback = { title, ...(keyword ? { keyword } : {}), ...(cand.subNiche ? { subNiche: cand.subNiche } : {}) };
          similarFallbackLine = demand.line;   // 마지막 라운드에 기억으로 후순위가 된 후보가 여기로 온다(로그가 '조회 없음'으로 새지 않게)
        }
        continue; // 이번 라운드의 새 소재 후보를 먼저 소진한다
      }
      // 개념 포화 기각 — 표면 유사(findSimilarContent)는 통과했지만 핵심 소재가 여러 편과 겹치면 1회만 다른 축 유도.
      // attempt 0 에서만(2번째 시도는 통과시켜 기아 방지 — 다양성은 강제하되 생산은 막지 않는다).
      if (diversityOn && attempt === 0) {
        const sat = saturatedThemeMatches({ title, ...(keyword ? { keyword } : {}) }, existing, 3, getBrand()?.compoundStems ?? []);
        if (sat.length) {
          console.log(`[auto-cycle] 아이디어 기각(소재 포화) — "${title}" ≈ "${sat[0]!.title}"`);
          rejects.push(`"${title}"=포화 소재(기존 "${sat[0]!.title}"와 겹침)`);
          continue;
        }
      }
      // 비수기 후순위 — 판정은 위(리서치 폐기 다음)에서 났지만 **보관은 여기서** 한다. 위에서 바로
      // 보관하면 수종 앵커·유사·소재 포화 게이트를 건너뛴 후보가 라운드 끝에 채택돼, 유사 폴백 자격을
      // 계열 게이트 none 으로 좁혀 막았던 구멍이 두 번째 폴백 경로로 다시 열린다(위 유사 폴백 자격
      // 주석의 포도 4편 사고 계보). 로그는 항상, 보관은 자격(계열 none)일 때만 — 유사 폴백과 같은 규칙.
      if (demand.verdict === 'demote') {
        console.log(demand.relaxed
          ? `[auto-cycle] 아이디어 후순위(검색 수요 미달·기아 방지) — "${title}" (${demand.line})`
          : `[auto-cycle] 아이디어 후순위(검색 비수기) — "${title}" (${demand.line})`);
        // (기억 기록은 위 판정 지점에서 이미 끝났다 — 이 블록보다 위의 게이트에 걸려 여기 못 오는
        //  후보도 실측은 받았으므로, 기록을 채택 자격 판단 뒤로 미루면 그 후보만 매 틱 재조회된다.)
        // 후순위 사유도 노트에 남긴다(2026-08-26 최종 리뷰 M3) — 종전엔 rejects 가 비어 2라운드 노트가
        // "전부 무효"로 나가, 두뇌는 뭐가 문제였는지(비수기냐 수요 미달이냐) 모른 채 다시 제안했다.
        // 보관 자격(계열 none)과 무관하게 기록한다 — 노트는 두뇌에게 주는 정보고, 보관은 별개 판단이다.
        rejects.push(`"${title}"=후순위(${demand.relaxed ? '검색 수요 미달' : '검색 비수기'}${demand.line ? ` — ${demand.line}` : ''})`);
        if (gate.level === 'none') {
          demoted.push({
            idea: { title, ...(keyword ? { keyword } : {}), ...(cand.subNiche ? { subNiche: cand.subNiche } : {}) },
            rank: demand.relaxed ? 1 : 0,   // 비수기(0)가 하한 미달(1)보다 항상 낫다 — 소재 자체엔 수요가 있다
            line: demand.line,              // 채택되면 이 실측 줄이 로그에 그대로 간다(기억 경로는 demandRows 에 없다)
          });
        }
        continue;
      }
      logDemandAdopt(title, keyword);
      recentAuto.push(title);
      if (recentAuto.length > 20) recentAuto.shift();
      if (keyword) consumeOpportunityVerdict(keyword); // 채택된 리서치 기회는 소진 — 다음 기획에 반복 주입 방지(2026-08-24)
      return { title, ...(keyword ? { keyword } : {}), ...(cand.subNiche ? { subNiche: cand.subNiche } : {}) };
    }
    // 제철 후보가 전멸했으면 후순위 보관함과 유사 폴백 중에서 고른다(pickRoundAdoption). 비수기(rank 0)는
    // '지금 덜 찾는다'일 뿐 수요가 없는 게 아니고 아직 안 다룬 새 소재라 폴백을 이긴다. 반대로 하한 미달
    // (rank 1)은 검색량이 실측으로 0 에 가까운 후보라, 검색량이 있을 수 있는 유사 폴백에 진다(리뷰 I3).
    const adoption = pickRoundAdoption(demoted, !!similarFallback);
    if (adoption?.source === 'demoted') {
      const { idea, rank, line } = adoption.pick;
      console.log(rank === 1
        ? `[auto-cycle] 수요 미달 후보 채택(기아 방지) — "${idea.title}"`
        : `[auto-cycle] 수요 비수기 후보 채택(대안 없음) — "${idea.title}"`);
      logDemandAdopt(idea.title, idea.keyword, line);
      recentAuto.push(idea.title);
      if (recentAuto.length > 20) recentAuto.shift();
      if (idea.keyword) consumeOpportunityVerdict(idea.keyword);
      return idea;
    }
    // 새 소재 후보가 전멸했지만 유사 후보가 있으면 채택 — 좌초 대신 '같은 소재, 다른 시각' 글로 간다.
    // 폴백은 계열 게이트 none 후보만 대입되므로(위 자격 조건) 재검사 불필요 — v1의 폴백 뚫림
    // 실사고(포도 4편째)는 자격+N7 바닥선 이중으로 봉쇄돼 있다.
    if (similarFallback) {
      console.log(`[auto-cycle] 유사 주제 채택(다른 시각 생성) — "${similarFallback.title}"`);
      logDemandAdopt(similarFallback.title, similarFallback.keyword, similarFallbackLine);
      recentAuto.push(similarFallback.title);
      if (recentAuto.length > 20) recentAuto.shift();
      if (similarFallback.keyword) consumeOpportunityVerdict(similarFallback.keyword);
      return similarFallback;
    }
    // 문구가 '전부 기각'이면 후순위 항목이 섞였을 때 노트가 사실과 어긋난다(후순위는 기각이 아니다).
    rejectNote = `[직전 제안 ${cands.length}건 전부 채택 불가(기각 또는 후순위) — 사유: ${rejects.slice(0, 4).join(' · ') || '전부 무효'}] 이 사유들과 소재를 전부 피해, 완전히 다른 소재·키워드로 5건을 다시 제안하라.`;
  }
  return null; // 두 라운드(최대 10후보) 전부 기각 — 이번 주기 스킵(다음 주기에 새 각도로 재시도)
}

// ============================================================
// 지식 리서치 미션(자율) — 콘텐츠 제작과 별개로, 주기적으로 브랜드 영역의 독자 궁금증·경쟁 콘텐츠
// (네이버 블로그·유튜브)를 조사하는 런을 제안한다. 조사→팀 토론→두뇌(위키) 적재→직원 학습(reflect)의
// 지식 컴파운딩 루프 입구 — 시간이 갈수록 지식은 촘촘해지고 직원은 똑똑해진다(사용자 확정 2026-07-06).
// ============================================================
interface ResearchState { lastTs?: string; prevTs?: string; recent?: string[] }
// slug 인자: 호출 시점의 활성 브랜드가 아니라 '틱 시작 시점에 고정한 브랜드'로 상태를 읽고 쓰기 위한 명시 전달.
// (제안 LLM 대기 수 초 사이 브랜드가 전환되면 기록이 엉뚱한 브랜드 파일로 가던 버그의 봉합점.)
function researchStatePath(slug?: string): string {
  const suffix = slug === undefined ? brandFileSuffix() : (slug ? `-${slug}` : '');
  return path.join(CONFIG.dataDir, '_shared', `research-state${suffix}.json`); // 브랜드별 주기·이력 분리
}
function readResearchState(slug?: string): ResearchState {
  try { return JSON.parse(readSafe(researchStatePath(slug))) as ResearchState; } catch { return {}; }
}
function writeResearchState(st: ResearchState, slug?: string): void {
  try {
    fs.mkdirSync(path.dirname(researchStatePath(slug)), { recursive: true });
    fs.writeFileSync(researchStatePath(slug), JSON.stringify(st, null, 2), 'utf-8');
  } catch { /* 무해 — 기록 실패 시 다음 틱에 리서치가 한 번 더 뜰 뿐 */ }
}

/** 마지막 리서치 런 이후 주기(시간)가 지났는가 — 자율 사이클의 리서치/콘텐츠 분기 게이트. 0=off. */
export function researchDue(hours: number, slug?: string): boolean {
  if (!(hours > 0)) return false;
  const st = readResearchState(slug);
  if (!st.lastTs) return true;
  const t = new Date(st.lastTs).getTime();
  if (!Number.isFinite(t)) return true; // 손상된 lastTs(NaN) — 게이트가 영구히 잠기지 않게 즉시 due 처리
  return Date.now() - t >= hours * 3600_000;
}

/** 리서치 런 시작 기록 — 주기 게이트 갱신 + 최근 미션(중복 회피) 누적. 시작 시점 기록이라 실패해도 폭주하지
 *  않고, 취소(양보) 시엔 rollbackResearchLaunch 가 직전 상태(prevTs)로 되돌려 창이 소각되지 않는다. */
export function recordResearchLaunch(title: string, slug?: string): void {
  const st = readResearchState(slug);
  const recent = [...(st.recent ?? []), title].slice(-10);
  writeResearchState({ lastTs: new Date().toISOString(), prevTs: st.lastTs, recent }, slug);
}

/** 리서치 런 취소(사용자 양보) 롤백 — lastTs 를 직전 값으로 복원하고 미션을 recent 에서 제거해,
 *  조사가 실제로 이뤄지지 않은 영역이 24h 창 소각·중복회피 블랙리스트에 걸리지 않게 한다.
 *  오류 종료는 롤백하지 않는다(계속 실패하는 미션의 틱마다 재시도 폭주 방지 — 기록 시점 트레이드오프 유지). */
export function rollbackResearchLaunch(title: string, slug?: string): void {
  const st = readResearchState(slug);
  writeResearchState({
    ...(st.prevTs ? { lastTs: st.prevTs } : {}),
    recent: (st.recent ?? []).filter((t) => t !== title),
  }, slug);
}

const RESEARCH_SYSTEM =
  '너는 1인 AI 콘텐츠 회사의 리서치 디렉터다. 아래 [팀·업무 범위]가 이 회사의 콘텐츠 영역이다. ' +
  '지금 조사하면 향후 콘텐츠 기획에 가장 가치있는 지식 리서치 미션 한 개를 제안하라.\n' +
  '- 미션은 "독자들이 실제로 궁금해하는 것(질문·고민)"과 "경쟁 콘텐츠(네이버 블로그·유튜브 상위)의 강점·빈틈"을 파악하는 조사다 — 글 제작이 아니다.\n' +
  '- [브랜드 컨텍스트]가 있으면 그 기업의 제품·타겟 고객 관심 영역을 우선하라. 시의성·계절성을 고려한다.\n' +
  '- [최근 리서치]와 중복되지 않게 하라 — 아직 조사되지 않은 영역을 고른다.\n' +
  '- title 은 조사 대상을 담은 한국어 한 줄(예: "7월 장마철 텃밭 관리 — 독자 질문·경쟁 콘텐츠 분석").';

/** 지식 리서치 미션 1건 제안 — 브랜드 컨텍스트·시드 키워드에 그라운딩, 최근 리서치와 중복 회피.
 *  slug: 틱 시작 시점에 고정한 브랜드(researchDue/recordResearchLaunch 와 동일 상태 파일을 보게). */
export async function proposeResearchMission(signal?: AbortSignal, slug?: string): Promise<string | null> {
  const c = getCompany();
  const teamLines = (c.teams ?? [])
    .filter((t) => t.id !== 'secretariat')   // 비서실(자비스) 헌장은 콘텐츠 영역 아님 — 리서치 그라운딩 제외
    .map((t) => `- ${t.name}: ${(t.lead?.specialty || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter((l) => l.length > 6)
    .join('\n');
  if (!teamLines.trim()) return null;
  const brand = brandContext();
  const seeds = brandSeedKeywords();
  const st = readResearchState(slug);
  const user =
    `${seasonalContext()}\n\n` + // 절기 시의성 신호 — 리서치 미션도 계절 타이밍에 맞게(아이디어 경로와 동일)
    (brand ? `${brand}\n\n` : '') +
    `[팀·업무 범위]\n${teamLines}\n\n` +
    (seeds.length ? `[브랜드 시드 키워드]\n${seeds.map((k) => `- ${k}`).join('\n')}\n\n` : '') +
    `[최근 리서치 — 중복 회피]\n${(st.recent ?? []).slice(-5).join('\n') || '(없음)'}\n\n` +
    `형식: {"title":"..."}`;
  const o = await microJSON<{ title?: unknown }>(
    resolveAssignment().micro, RESEARCH_SYSTEM, user, { maxOutputTokens: 120, signal },
  ).catch(() => null);
  const title = asString(o?.title).trim().replace(/^["'\-•\s]+/, '').slice(0, 120);
  if (!title || (st.recent ?? []).includes(title)) return null;
  // 브랜드 소재 게이트(하드) — 리서치 미션도 금지 소재면 스킵(다음 주기 재시도, 2026-07-31 정체성 각인).
  const off = offBrandTerm(title);
  if (off) { console.log(`[auto-cycle] 리서치 미션 기각(브랜드 범위 밖) — "${title}" (소재 "${off}")`); return null; }
  return title;
}
