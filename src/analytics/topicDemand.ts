/**
 * 주제 선정 검색 수요 게이트(2026-08-26) — 주제 두뇌가 '검색되지 않는 문구'로 편을 세우던 공백의 봉합.
 *
 * 실측 근거(2026-08-26): 우리가 실제로 쓰던 롱테일의 월 검색량이 0~30 이었다(가을 거름 0·유실수 가을
 * 시비 0·사과나무 비료 30). 게다가 '비료' 계열은 데이터랩 3월 100 → 8월 13 으로 지금이 연중 최저다.
 * 즉 소재가 나쁜 게 아니라 **지금·이 표기**로는 검색 수요가 없었다 — 종전 주제 선정은 절대 검색량을
 * 한 번도 보지 않았기 때문에 이걸 알 방법이 없었다.
 *
 * 설계: (a) 후보 키워드 묶음의 수요를 검색광고(절대량·연관어) ≤2콜 + 데이터랩(13개월 추이) 1콜로 한 번에
 * 재고, (b) 매일 시드 키워드의 수요 스냅샷을 떠 두뇌 프롬프트에 표로 주입한다. 판정은 하드 기각 1종
 * (하한 미달)뿐이고 비수기는 후순위(demote)일 뿐이다 — 비수기 기각까지 하면 후보 기아가 난다.
 *
 * 전량 fail-open — 키 없음·조회 실패·빈 응답은 '수요 미상'이라 게이트를 통째로 생략한다(빈 Map·빈 블록).
 * 수요가 없다고 단정해 기각하는 경로는 **실제 응답을 받았을 때만** 열린다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug, brandSeedKeywords, getBrand, offBrandTerm } from '../content/brand';
import { discoverySeeds, looksLikeGardenQuery, brandSpeciesCoverage, brandThemeCoverage } from './discoverySeeds';
import { overThemeCap } from '../content/topicThemes';
import { overSpeciesCap } from '../content/speciesRotation';
import { readTrendSnap } from './trendSignal';
import { datalabEnabled, datalabTrend } from '../grounding/naver_datalab';
import { searchAdEnabled, searchAdVolumes } from '../grounding/naver_searchad';

export interface DemandRow {
  /** 후보 keyword 원문(공백 포함 표기 그대로 — 로그·프롬프트에 그대로 쓴다). */
  keyword: string;
  /** 정확 일치(공백 제거) 행의 월 검색량(pc+mobile). 해당 행이 없으면 0. */
  volume: number;
  /** pc·모바일 중 하나라도 "10 미만" 표기였나 — 총량이 정확값이 아니라는 뜻. */
  approx: boolean;
  /** 후보의 내용 토큰을 전부 포함하는 연관어 중 최대 검색량(후보 자신도 포함). */
  familyMax: number;
  /** 그 최대치를 만든 연관어(표기 교체 후보). */
  familyTop?: string;
  /** 시즌 지수(0~1) — max(현재 월, 작년 다음달)/정점. 데이터 없으면 undefined(판정 생략). */
  seasonIdx?: number;
  direction?: '상승' | '하락' | '보합';
}

export type DemandVerdict = 'pass' | 'demote' | 'reject' | 'unknown';

export interface DemandSnap { date: string; rows: DemandRow[] }

/**
 * 계열 대조에서 빼는 어미·수식어. 이걸 남기면 '가을 거름 주는 시기'의 연관어가 사실상 하나도 안 걸려
 * 계열 최대가 0 이 되고, 반대로 '나무'까지 내용어로 치면 계열이 업종 전체로 넓어져 아무거나 통과한다
 * (그래서 단독 '나무'만 불용어 — '사과나무'·'배롱나무' 같은 복합어는 그대로 내용어다).
 */
export const DEMAND_STOPWORDS: ReadonlySet<string> = new Set([
  '시기', '시기별', '방법', '법', '주는', '하는', '전', '후', '언제', '어떻게',
  '하기', '되는', '좋은', '나무', '정리', '총정리',
]);

const MAX_ASSESS = 10;    // 검색광고 힌트 5개/콜 × 2콜 — 한 라운드 후보 수 상한
const MAX_TREND = 5;      // 데이터랩 1콜 상한(그리고 스냅샷 묶음 크기)
const SNAP_MAX_SEEDS = 15;
const MAX_WINNER_SEEDS = 5;   // 스냅샷 15칸 중 winners 몫(나머지는 브랜드 시드 회전 창)
const STALE_DAYS = 3;     // 수요는 주 단위로 움직인다 — 이보다 낡은 스냅샷은 '실측'이라 부르지 않는다
const BLOCK_ROWS = 12;

/** 표기 정규화(공백 제거·소문자) — 스케줄러의 행 조회 폴백도 같은 규칙을 써야 '가을 거름'과 '가을거름'이
 *  서로 다른 키워드로 갈리지 않는다(그래서 모듈 밖으로 연다). */
export const normKw = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase();
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 연중 일수(1~366) — 시드 회전 창의 기준. Date.UTC 로 계산해 서머타임에 하루가 밀리지 않게 한다. */
function dayOfYear(d: Date): number {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86_400_000);
}

/** 후보 키워드 → 계열 대조용 내용 토큰(순수). 2자 미만·불용어 제거. */
export function contentTokens(keyword: string): string[] {
  return (keyword || '').split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !DEMAND_STOPWORDS.has(t));
}

/**
 * 계열 최대 검색량(순수) — 후보의 내용 토큰을 **전부** 포함하는 연관어 중 최대치.
 * 정확 일치가 0 이어도 계열이 크면 '소재는 살아 있고 표기만 틀린' 경우라 기각하지 않기 위한 축이다.
 */
export function familyVolume(
  rows: Array<{ keyword: string; total: number }>,
  keyword: string,
): { max: number; top?: string } {
  const tokens = contentTokens(keyword).map(normKw).filter(Boolean);
  // 토큰이 하나도 없으면 every() 가 공허참이 되어 전역 최대(무관한 연관어)가 새어든다 — 0 으로 못 박는다.
  if (!tokens.length) return { max: 0 };
  let best: { keyword: string; total: number } | undefined;
  for (const r of rows ?? []) {
    const k = normKw(r?.keyword ?? '');
    if (!k || !tokens.every((t) => k.includes(t))) continue;
    if (!best || r.total > best.total) best = r;
  }
  return best ? { max: best.total, top: best.keyword } : { max: 0 };
}

/**
 * 시즌 지수(순수) — 정점 대비 '지금 그리고 곧'의 수요. points 는 오래된→최신.
 * 현재 월만 보면 발행 시점(며칠 뒤)의 수요를 놓치므로 작년 같은 달들로 전방 창을 근사해 최대치를 쓴다.
 *
 * 전방 창 = 작년 +1개월 한 칸(사용자 확정 2026-08-27 "지금~다음 달만"). 08-26 저녁에 '다음 시즌 대비'
 * 장르 축과 맞추려 창을 +2개월까지 넓혔다가, 다음 날 8월 말에 단풍(10~11월 피크) 글이 통과돼 사용자가
 * 되돌렸다 — 사람들이 지금 또는 4주 안에 검색할 소재만 쓴다. 장르 축 쪽도 같이 제거(scheduler IDEA_ANGLES).
 * 현재 월(cur)은 그대로 최대치 후보로 남긴다(올해 갑자기 뜬 키워드는 작년 어느 달로도 설명되지 않는다).
 */
export function seasonIndex(points: Array<{ period: string; ratio: number }>, now = new Date()): number | undefined {
  const pts = (points ?? []).filter((p) => p && Number.isFinite(p.ratio));
  if (!pts.length) return undefined;
  const peak = Math.max(...pts.map((p) => p.ratio));
  if (!(peak > 0)) return undefined;                      // 전 구간 0 = 데이터랩에 사실상 없는 키워드
  const cur = pts[pts.length - 1]!.ratio;
  let fwd = 0;
  if (pts.length >= 13) {
    let base = pts.length - 12;                           // 13점 이상이면 '한 해 전 다음 달'이 창의 기준점
    const ym = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // 데이터랩이 당월을 아직 안 내주면 창 전체가 한 칸 밀려 인덱스가 '작년 이번 달'을 가리킨다 —
    // 마지막 점이 이번 달이 아닐 때만 period 로 직접 찾는다(찾으면 그 값, 없으면 인덱스 그대로).
    // Date 생성자가 month=12 를 이듬해 1월로 굴려 주므로 12월 롤오버도 이 한 줄이 처리한다.
    if (pts[pts.length - 1]!.period.slice(0, 7) !== ym(now)) {
      const want = ym(new Date(now.getFullYear() - 1, now.getMonth() + 1, 1));
      const found = pts.findIndex((p) => (p.period || '').slice(0, 7) === want);
      if (found >= 0) base = found;
    }
    // 창 = 작년 +1개월 한 칸(사용자 확정 2026-08-27 "지금~다음 달만" — 2개월 창은 8월 말에 단풍을
    // 통과시켰다). 구간을 벗어난 인덱스는 무시.
    const r = pts[base]?.ratio;
    if (typeof r === 'number' && r > fwd) fwd = r;
  }
  return Math.min(1, Math.max(cur, fwd) / peak);
}

/** 정렬용 점수(순수) — 검색량은 로그(자릿수 차이만 보고), 비수기는 최대 절반까지 깎는다. */
export function demandScore(row: DemandRow): number {
  const v = Math.max(row?.volume ?? 0, row?.familyMax ?? 0);
  return Math.log10(Math.max(0, v) + 1) * (0.5 + 0.5 * (row?.seasonIdx ?? 1));
}

/** 판정(순수) — 하드 기각은 '하한 미달' 1종뿐. 비수기는 후순위(demote)이지 기각이 아니다. */
export function demandVerdict(row: DemandRow | undefined, cfg: { minVolume: number; minSeason: number }): DemandVerdict {
  if (!row) return 'unknown';                                                   // 미조회·조회 실패 → 게이트 생략
  if (Math.max(row.volume, row.familyMax) < cfg.minVolume) return 'reject';
  if (row.seasonIdx !== undefined && row.seasonIdx < cfg.minSeason) return 'demote';
  return 'pass';
}

/** 로그·프롬프트 공용 한 줄(순수). 예: `"사과나무 비료" 30/월(계열 최대 30) · 시즌 0.13↓` */
export function formatDemandLine(row: DemandRow): string {
  // "10 미만"은 0~9 중 어디인지 모른다 — 가짜 정밀도("0회") 대신 그 사실을 그대로 남긴다(searchad 관례).
  const vol = row.approx && row.volume === 0 ? '10미만' : row.volume.toLocaleString();
  const other = row.familyTop && normKw(row.familyTop) !== normKw(row.keyword) ? ` "${row.familyTop}"` : '';
  const arrow = row.direction === '상승' ? '↑' : row.direction === '하락' ? '↓' : row.direction === '보합' ? '→' : '';
  const season = row.seasonIdx === undefined ? '' : ` · 시즌 ${row.seasonIdx.toFixed(2)}${arrow}`;
  return `"${row.keyword}" ${vol}/월(계열 최대 ${row.familyMax.toLocaleString()}${other})${season}`;
}

/**
 * 후보 묶음 수요 평가 — 검색광고 ≤2콜 + 데이터랩 1콜. 후보당 개별 조회는 라운드당 수십 콜이 되므로
 * 반드시 묶어서 부른다. 11번째부터는 조회하지 않는다(미조회 = Map 에 없음 = unknown = 통과) —
 * '순번이 밀렸다'는 이유로 기각되는 후보가 생기면 그건 수요 게이트가 아니다.
 */
export async function assessCandidatesDemand(keywords: string[], signal?: AbortSignal): Promise<Map<string, DemandRow>> {
  const out = new Map<string, DemandRow>();
  const seen = new Set<string>();
  // raw=후보 원문(Map 키·표기), hint=커넥터에 보낼 정제본. 둘을 갈라 두는 이유: LLM 이 keyword 에
  // 쉼표·개행을 섞어 오면 hintKeywords 가 join(',') 이라 후보 1개가 힌트 여러 개로 불어나 5개 상한을
  // 넘겨 400 이 나고, 그 라운드 게이트가 통째로 무력화됐다(2026-08-26 최종 리뷰 I5).
  const targets: Array<{ raw: string; hint: string }> = [];
  for (const k of keywords ?? []) {
    const raw = (k || '').trim();
    const hint = raw.replace(/[,\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!raw || !hint || seen.has(normKw(hint))) continue;   // 정제 후 같아지는 후보는 한 번만 조회
    seen.add(normKw(hint));
    targets.push({ raw, hint });
    if (targets.length >= MAX_ASSESS) break;
  }
  if (!targets.length || !searchAdEnabled()) return out;
  type Row = { keyword: string; total: number; pcApprox: boolean; mobileApprox: boolean };
  const chunks: Array<{ targets: Array<{ raw: string; hint: string }>; rows: Row[] }> = [];
  try {
    for (let i = 0; i < targets.length; i += 5) {
      const slice = targets.slice(i, i + 5);
      chunks.push({ targets: slice, rows: await searchAdVolumes(slice.map((t) => t.hint), signal) });
    }
  } catch (e) {
    console.log(`[demand] 조회 실패 — 수요 게이트 생략(${errMsg(e)})`);
    return new Map();
  }
  const pooled = chunks.flatMap((c) => c.rows);
  // 빈 응답(HTTP 오류를 커넥터가 [] 로 삼킨 경우 포함)은 '검색량 0'이 아니라 '모름'이다.
  if (!pooled.length) return out;
  for (const c of chunks) {
    // 청크 단위로 본다 — 1번 묶음만 응답하고 2번이 실패하면, 2번 후보들은 '검색량 0'이 아니라 미조회다
    // (전체 합계만 보면 살아남은 묶음 덕에 가드를 통과해 나머지가 통째로 기각된다).
    if (!c.rows.length) continue;
    for (const { raw, hint } of c.targets) {
      const exact = pooled.find((r) => normKw(r.keyword) === normKw(hint));
      const fam = familyVolume(pooled, hint);   // 계열 대조는 살아있는 응답 전체를 쓴다
      // 청크 응답은 왔지만 이 키워드 행이 없으면 '검색량 0'이 아니라 **미측정**이다 — 담지 않는다
      // (2026-08-26 최종 리뷰 C2). 종전엔 0/월·계열 0 으로 담겨 하드 기각을 부르고 프롬프트에도
      // "0/월"이 사실처럼 실렸다. 모듈 헤더 불변식: 기각은 실제 응답을 받았을 때만.
      if (!exact && !fam.max) continue;
      out.set(raw, {
        keyword: raw,
        volume: exact?.total ?? 0,
        approx: !!exact && (exact.pcApprox || exact.mobileApprox),
        familyMax: fam.max,
        ...(fam.top ? { familyTop: fam.top } : {}),
      });
    }
  }
  // 데이터랩 실패는 따로 삼킨다 — 시즌만 잃고 검색량 판정은 살린다(시즌 미상이면 demote 자체가 불가).
  if (datalabEnabled()) {
    try {
      // 데이터랩에도 정제본을 보낸다(같은 이유) — 응답 키워드는 힌트 표기라 원문 행으로 되짚어 붙인다.
      const byHint = new Map(targets.map((t) => [normKw(t.hint), t.raw]));
      // 후보가 8개(2026-08-27)라 5개 상한으로 잘라 보내면 뒤 3개는 시즌 미상 → 비수기 판정 불가. MAX_TREND 씩 나눠 전부 조회.
      const trendRows: Awaited<ReturnType<typeof datalabTrend>> = [];
      for (let i = 0; i < targets.length; i += MAX_TREND) {
        trendRows.push(...await datalabTrend(targets.slice(i, i + MAX_TREND).map((x) => x.hint), 13, signal));
      }
      for (const t of trendRows) {
        const raw = byHint.get(normKw(t.keyword));
        const row = (raw !== undefined ? out.get(raw) : undefined)
          ?? out.get(t.keyword)
          ?? [...out.values()].find((r) => normKw(r.keyword) === normKw(t.keyword));
        if (!row) continue;
        const s = seasonIndex(t.points);
        if (s !== undefined) row.seasonIdx = s;
        row.direction = t.direction;
      }
    } catch (e) {
      console.log(`[demand] 시즌 조회 실패(검색량은 유지) — ${errMsg(e)}`);
    }
  }
  return out;
}

function snapPath(slug?: string): string {
  const s = slug ?? activeBrandSlug();
  return path.join(CONFIG.dataDir, 'analytics', s ? `demand-${s}.json` : 'demand.json');
}

export function readDemandSnap(slug?: string): DemandSnap | null {
  try {
    const raw = JSON.parse(fs.readFileSync(snapPath(slug), 'utf-8')) as DemandSnap;
    return raw && typeof raw.date === 'string' && Array.isArray(raw.rows) ? raw : null;
  } catch { return null; }
}

/**
 * 스냅샷 시드 — 브랜드 시드 키워드 + 성과 winners 키워드(≤15).
 * winners 를 날것으로 읽지 않는다: 정체성 재정립(perfEraSince) 이전에 쌓인 옛 소재가 섞여 있어서
 * (scheduler.ts 의 eligibleWinners 와 같은 이유) 조회 콜을 거기에 태우면 프롬프트 표까지 오염된다.
 * (analytics → autonomy 순환 import 를 피하려 전략 파일을 여기서 직접 읽는다 — 경로 규칙 동일.)
 */
export function demandSeeds(slug?: string, now = new Date()): string[] {
  const s = slug ?? activeBrandSlug();
  const era = getBrand()?.perfEraSince;
  const winners: Array<{ kw: string; score: number }> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CONFIG.dataDir, 'analytics', s ? `strategy-${s}.json` : 'strategy.json'), 'utf-8')) as {
      winners?: Array<{ keyword?: string; score?: number; firstSeenAt?: string; updatedAt?: string }>;
    };
    for (const w of raw.winners ?? []) {
      const kw = (w?.keyword || '').trim();
      if (!kw) continue;
      if (era) {
        const born = (w.firstSeenAt || w.updatedAt || '').slice(0, 10);
        if (!born || born < era) continue;   // 시각을 모르면 옛 것으로 본다(보수적 — scheduler 와 동일)
      }
      // 소재 범위 게이트는 winners(자동 축적물)에만 건다 — 브랜드 시드는 사용자가 직접 적은 설정이라
      // 자기 banned 프로즈에서 샌 토큰으로 조용히 지워지면 안 된다(모종 오탐 전례, brand.ts 참조).
      if (offBrandTerm(kw)) continue;
      winners.push({ kw, score: typeof w.score === 'number' ? w.score : 0 });
    }
  } catch { /* 전략 파일 없음(콜드스타트) — 브랜드 시드만 */ }
  // 월 상한에 닿은 수종의 winners 는 측정에서도 뺀다(2026-08-27) — 표에 '배롱나무 …' 행이 남으면 두뇌가 또 그쪽으로 끌린다.
  const capCov = getBrand()?.speciesCatalog?.length ? brandSpeciesCoverage(now, s || undefined) : new Map<string, number>();
  const themeCapCov = getBrand()?.topicThemes?.length ? brandThemeCoverage(now, s || undefined) : new Map<string, number>();
  const winTop = winners.sort((a, b) => b.score - a.score)
    .filter((w) => !overSpeciesCap(w.kw, capCov, getBrand()?.speciesCatalog))
    .filter((w) => !overThemeCap(w.kw, themeCapCov, getBrand()?.topicThemes))
    .slice(0, MAX_WINNER_SEEDS).map((w) => w.kw);

  // 슬롯 예약 — 브랜드 시드가 상한을 통째로 먹으면 winners 축이 영영 측정되지 않는다
  // (실측 2026-08-26: data/brand.yaml 시드 21개 > 상한 15 → winners 0개 도달).
  const brand = brandSeedKeywords().map((k) => (k || '').trim()).filter(Boolean);
  const take = Math.min(brand.length ? Math.max(brand.length, SNAP_MAX_SEEDS) : SNAP_MAX_SEEDS, SNAP_MAX_SEEDS - winTop.length);
  const window: string[] = [];
  if (getBrand()?.speciesCatalog?.length) {
    // 발굴 시드 회전(2026-08-27) — 브랜드 시드 21개 고정 창 대신 카탈로그의 '안 다룬 수종'을 날짜로 돌리고,
    // 오늘 자동완성 스냅샷에 그 수종의 연관 검색어가 있으면 그 표기(사람이 실제로 치는 구절)를 수요 표에 싣는다.
    const disc = discoverySeeds(Math.max(1, Math.ceil(take / 2)), now, s || undefined);
    const trend = (() => { try { return readTrendSnap(s || undefined); } catch { return null; } })();
    for (const seed of disc) {
      const rel = (trend?.entries?.[seed] ?? []).filter(looksLikeGardenQuery).slice(0, 2);
      for (const k of (rel.length ? [seed, ...rel] : [seed])) if (window.length < take) window.push(k);
    }
  } else {
    // 카탈로그 없는 브랜드 — 종전 동작: 전부 못 담을 때만 날짜로 창을 돌린다(21개 시드가 ~3일이면 한 바퀴).
    const t = Math.min(brand.length, take);
    const offset = brand.length > t ? dayOfYear(now) % brand.length : 0;
    for (let i = 0; i < t; i++) window.push(brand[(offset + i) % brand.length]!);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...window, ...winTop]) {
    if (!t || seen.has(normKw(t))) continue;
    seen.add(normKw(t));
    out.push(t);
    if (out.length >= SNAP_MAX_SEEDS) break;
  }
  return out;
}

/**
 * 일일 수요 스냅샷 — perf-sync 틱에서 fire-and-forget. 같은 날 재호출은 no-op.
 * 5개씩 끊어 부르는 이유: 한 묶음이 검색광고 1콜 + 데이터랩 1콜이라 이 크기여야 **전 시드가** 시즌
 * 지수까지 받는다(10개씩이면 뒤 5개는 시즌 미상). 15 시드 = 하루 6콜.
 */
export async function refreshDemandSnapshot(signal?: AbortSignal): Promise<void> {
  try {
    // 킬스위치는 조회 전에 본다 — off 면 외부 API 콜도 파일 쓰기도 0(비용 0으로 완전히 잠든다).
    if (!CONFIG.topicDemandGate || !searchAdEnabled()) return;
    const slug = activeBrandSlug();
    const seeds = demandSeeds(slug);
    if (!seeds.length) return;
    const today = localDateStr();
    if (readDemandSnap(slug)?.date === today) return;
    const rows: DemandRow[] = [];
    for (let i = 0; i < seeds.length; i += MAX_TREND) {
      const m = await assessCandidatesDemand(seeds.slice(i, i + MAX_TREND), signal);
      rows.push(...m.values());
    }
    if (!rows.length) return;   // 전 묶음 실패 — 어제 스냅샷을 빈 표로 덮지 않는다
    const f = snapPath(slug);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 원자적 쓰기(tmp+rename) — 자율 틱의 읽기가 찢어진 JSON 을 만나지 않게. tmp 이름에 pid 를 넣는 이유:
    // 부팅 예열(+20s)과 perf-sync 틱이 겹쳐 두 쓰기가 같은 tmp 를 잡으면 서로의 파일을 rename 해 간다
    // (2026-08-26 최종 리뷰 M1). 같은 프로세스 안 동시 실행은 하루 1회 가드가 이미 막는다.
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ date: today, rows } satisfies DemandSnap, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
    console.log(`[demand] 수요 스냅샷 갱신 — ${rows.length} 키워드(${today})`);
  } catch (e) {
    console.log(`[demand] 스냅샷 갱신 실패(무해): ${errMsg(e)}`);
  }
}

/** 블록 조립(순수, 테스트 대상) — demandSignalBlock 의 코어.
 *  excludeTokens: 계열 쿨다운 토큰. 쿨다운으로 '제안 불가'인 계열이 수요 표에 남으면 두뇌 눈에는
 *  "수요 있는 소재"로 보여 금지 지시와 정면 충돌한다(트렌드 블록이 같은 이유로 같은 필터를 쓴다). */
export function buildDemandBlock(snap: DemandSnap | null, now = Date.now(), excludeTokens: string[] = []): string {
  if (!snap || !Array.isArray(snap.rows) || !snap.rows.length) return '';
  const age = now - new Date(`${snap.date}T00:00:00`).getTime();
  if (!Number.isFinite(age) || age > STALE_DAYS * 86_400_000) return '';
  // 빈 토큰은 버린다 — normKw('') 은 ''이고 includes('') 는 항상 참이라 표가 통째로 비는 함정.
  const cooled = excludeTokens.map(normKw).filter(Boolean);
  const lines = [...snap.rows]
    .filter((r) => !cooled.some((t) => normKw(r.keyword).includes(t)))
    .sort((a, b) => demandScore(b) - demandScore(a))
    .slice(0, BLOCK_ROWS)
    .map((r) => `- ${formatDemandLine(r)}`);
  if (!lines.length) return '';
  // 하한은 설정값을 그대로 읽어 넣는다 — 프롬프트의 숫자와 실제 게이트가 어긋나면 두뇌가 통과할 리 없는
  // 키워드를 계속 제안하거나(하한 상향 시) 멀쩡한 후보를 스스로 버린다(하향 시).
  // 연관어 표기는 관측으로만 전한다(2026-08-26 최종 리뷰 M4) — 검색광고 연관어는 띄어쓰기가 없는
  // 형태('블루베리전용비료')라 "그 표기를 우선하라"고 시키면 그대로 제목·태그에 붙는다. 겨냥할 것은
  // 그 표기가 아니라 그 표기가 대변하는 수요다.
  return `[검색 수요 실측 — ${snap.date}]\n${lines.join('\n')}\n` +
    `반영 지침: 검색량 ${CONFIG.topicDemandMinVolume}/월 미만·시즌 지수 ${CONFIG.topicDemandMinSeason} 미만 키워드로 주제를 세우지 마라. ` +
    '수요가 있는 키워드는 그대로 keyword 로 쓰고, 계열 최대 연관어의 검색량이 더 크면 주제는 그 수요를 겨냥하되 표기는 자연스러운 띄어쓰기로 써라.\n\n';
}

/** 주제 두뇌 주입용 블록 — 킬스위치 off·스냅샷 없음·낡음은 빈 문자열(무주입).
 *  excludeTokens 는 계열 쿨다운 토큰(호출부가 cooldownSummary 에서 넘긴다). */
export function demandSignalBlock(slug?: string, excludeTokens: string[] = []): string {
  if (!CONFIG.topicDemandGate) return '';
  try { return buildDemandBlock(readDemandSnap(slug), Date.now(), excludeTokens); } catch { return ''; }
}

// ============================================================
// 수요 미달 기각 기억(2026-08-27, 사용자 지시) — 틱 간에 남는 '이미 실측으로 떨어진 키워드' 원장.
//
// 종전 게이트는 틱 안에서만 기억했다. 그래서 두뇌가 같은 롱테일("가을 거름")을 다음 틱에 또 제안하면
// 검색광고를 또 부르고 또 기각했다 — 조회 비용은 매번 새로 들고, 두뇌는 자기가 이미 기각당한 표기를
// 모르니 같은 자리를 계속 맴돌았다. 기각을 30일 기억해 (a) 조회 자체를 건너뛰고 (b) 프롬프트에
// '제안 금지' 블록으로 되먹여 두뇌가 상위 카테고리어로 올라가게 만든다.
//
// TTL 이 있는 이유: 수요는 계절을 탄다. 8월에 0/월이던 표기가 11월엔 살아날 수 있으므로 영구 금지는
// 과차단이다. 만료 판정은 읽기·블록 양쪽에서 함께 본다 — 블록만 낡은 항목을 실으면 "제안 금지"라고
// 시켜 놓고 게이트는 통과시키는 지시 충돌이 난다(buildDemandBlock 의 쿨다운 필터와 같은 이유).
// 킬스위치(topicDemandGate) off 면 읽기·쓰기·블록 전부 0 — 파일조차 만들지 않는다.
// ============================================================

export const DEMAND_REJECT_TTL_DAYS = 30;

export interface DemandRejectEntry { keyword: string; line: string; ts: string }
type DemandRejectMap = Record<string, DemandRejectEntry>;

const REJECT_BLOCK_ROWS = 15;

function rejectPath(slug: string): string {
  return path.join(CONFIG.dataDir, 'analytics', slug ? `demand-rejects-${slug}.json` : 'demand-rejects.json');
}

function readRejects(slug: string): DemandRejectMap {
  try {
    const raw = JSON.parse(fs.readFileSync(rejectPath(slug), 'utf-8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as DemandRejectMap : {};
  } catch { return {}; }
}

/** 만료 전인가(순수) — ts 가 없거나 파싱 불가면 '못 믿는 항목'이라 만료로 본다(보수적). */
function rejectFresh(e: DemandRejectEntry | undefined, now: Date): boolean {
  const t = e && typeof e.ts === 'string' ? new Date(e.ts).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < DEMAND_REJECT_TTL_DAYS * 86_400_000;
}

/**
 * 기각 기록(upsert) — 쓰기 때마다 만료 항목을 함께 걷어낸다(원장이 무한히 자라지 않게).
 * 실패는 전부 삼킨다: 후보 루프 한가운데서 호출되므로 여기서 throw 하면 틱 전체가 날아간다.
 */
export function rememberDemandReject(slug: string, keyword: string, line: string, now = new Date()): void {
  if (!CONFIG.topicDemandGate) return;
  const k = normKw(keyword);
  if (!k) return;
  try {
    const next: DemandRejectMap = {};
    for (const [key, e] of Object.entries(readRejects(slug))) if (rejectFresh(e, now)) next[key] = e;
    next[k] = { keyword: (keyword || '').trim(), line, ts: now.toISOString() };
    const f = rejectPath(slug);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 스냅샷과 같은 원자적 쓰기 규약(tmp+rename, tmp 이름에 pid) — 자율 틱의 읽기가 찢어진 JSON 을 안 만나게.
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
  } catch (e) {
    console.log(`[demand] 기각 기억 실패(무해): ${errMsg(e)}`);
  }
}

/** 기억 조회 — 정규화 대조라 '가을거름'과 '가을 거름'이 갈리지 않는다. 만료·킬스위치 off 는 null.
 *  읽기 경로는 절대 쓰지 않는다(후보마다 호출된다 — 여기서 정리·저장하면 TTL 이 읽을 때마다 갱신된다). */
export function demandRejectFor(slug: string, keyword: string | undefined, now = new Date()): DemandRejectEntry | null {
  if (!CONFIG.topicDemandGate || !keyword) return null;
  const k = normKw(keyword);
  if (!k) return null;
  const e = readRejects(slug)[k];
  return rejectFresh(e, now) ? e! : null;
}

/** 주제 두뇌 주입용 '제안 금지' 블록 — 항목 없음·전부 만료·킬스위치 off 면 빈 문자열(무주입). */
export function demandRejectBlock(slug: string, now = new Date()): string {
  if (!CONFIG.topicDemandGate) return '';
  const items = Object.values(readRejects(slug))
    .filter((e) => rejectFresh(e, now))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))   // 최근순 — 오래된 것부터 목록에서 밀린다
    .slice(0, REJECT_BLOCK_ROWS);
  if (!items.length) return '';
  return `[검색 수요 미달로 기각된 키워드 — ${DEMAND_REJECT_TTL_DAYS}일간 제안 금지]\n`
    + items.map((e) => `- "${e.keyword}" (${e.line})`).join('\n') + '\n'
    + '이 키워드와 띄어쓰기만 다른 변형도 같은 키워드다. 대신 검색량이 있는 상위 카테고리어로 주제를 세워라.\n\n';
}
