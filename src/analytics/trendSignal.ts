/**
 * 트렌드→주제 경로(2026-08-20 조회수 감사) — 주제 두뇌에 닿는 실검색 신호가 0 이던 공백의 봉합.
 * 종전엔 데이터랩·자동완성·SERP 전부 '주제 확정 후' 본문 근거 수집에만 쓰였고, 유일한 실검색 유래
 * 신호(클러스터 백로그)도 트렌드 순위 없이 생성 순서로 소진됐다.
 *
 * 설계: 매일 브랜드 시드 키워드의 네이버 자동완성을 스냅샷으로 저장하고, 직전 스냅샷과의 diff 로
 * '새로 등장한 연관검색어(★)'를 표시해 주제 두뇌에 주입한다. 자동완성은 실사용자 검색 수요의 실시간
 * 반영이라, 새 등장어 = 최근 며칠 수요가 움직인 신호다(공식 급상승어 API 부재의 실용 대체).
 * 전량 fail-open — 수집 실패·스냅샷 없음은 무주입일 뿐 주제 선정을 막지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug, brandFileSuffixFor } from '../content/brand';
import { discoverySeeds, looksLikeGardenQuery } from './discoverySeeds';
import { naverAutocomplete } from '../grounding/naver_autocomplete';
import { fetchTimeout } from '../util/fetch';

export interface TrendSnap {
  date: string;                        // YYYY-MM-DD(수집일)
  entries: Record<string, string[]>;   // 시드 → 네이버 자동완성 상위
  /** 시드 → 유튜브 자동완성 상위(2026-08-25 유튜브 축) — 쇼츠·영상 검색 수요. 구 스냅샷엔 없음. */
  ytEntries?: Record<string, string[]>;
  prevDate?: string;
  prevEntries?: Record<string, string[]>;
  prevYtEntries?: Record<string, string[]>;
}

/** 유튜브 자동완성 응답 파서(순수, 테스트 대상) — client=firefox&ds=yt 는 ["질의",["제안",...]] JSON. */
export function parseYtSuggest(json: unknown): string[] {
  if (!Array.isArray(json) || !Array.isArray(json[1])) return [];
  return (json[1] as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean);
}

/** 유튜브 자동완성 조회 — 키 불필요 공개 엔드포인트(oe=utf8 필수 — 미지정 시 EUC-KR 모지바케 실측). */
async function ytAutocomplete(seed: string, signal?: AbortSignal): Promise<string[]> {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ko&gl=kr&oe=utf8&q=${encodeURIComponent(seed)}`;
  const r = await fetchTimeout(u, {}, signal);
  if (!r.ok) throw new Error(`yt suggest HTTP ${r.status}`);
  return parseYtSuggest(await r.json());
}

const MAX_SEEDS = 8;
const MAX_SUGGESTIONS = 8;
const STALE_DAYS = 7;                  // 이보다 낡은 스냅샷은 '트렌드'가 아니다 — 무주입

const normKw = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase();

function snapPath(slug?: string): string {
  const s = slug ?? activeBrandSlug();
  return path.join(CONFIG.dataDir, 'topics', `trend-snap${brandFileSuffixFor(s || undefined)}.json`);
}

export function readTrendSnap(slug?: string): TrendSnap | null {
  try {
    const raw = JSON.parse(fs.readFileSync(snapPath(slug), 'utf-8')) as TrendSnap;
    return raw && typeof raw.date === 'string' && raw.entries && typeof raw.entries === 'object' ? raw : null;
  } catch { return null; }
}

/**
 * 일일 스냅샷 갱신 — perf-sync 틱에서 fire-and-forget. 같은 날 재호출은 no-op(하루 1회).
 * 날이 바뀔 때만 직전 스냅샷을 prev 로 밀어 diff 기준을 보존한다.
 */
/** 로컬 날짜 문자열(YYYY-MM-DD) — startDaily 의 로컬 날짜 키와 같은 기준. toISOString(UTC)은 KST 에서
 *  자정~09시 발동이 전날로 라벨링되고 따라잡기 발동일 다음 날을 같은 날로 오인해 갱신을 스킵한다(리뷰 지적). */
function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function refreshTrendSnapshot(signal?: AbortSignal): Promise<void> {
  try {
    const slug = activeBrandSlug();
    const seeds = discoverySeeds(MAX_SEEDS);   // 카탈로그 회전(2026-08-27) — 안 다룬 수종부터 자동완성을 긁는다
    if (!seeds.length) return;
    const today = localDateStr();
    const cur = readTrendSnap(slug);
    if (cur?.date === today) return;
    const entries: Record<string, string[]> = {};
    const ytEntries: Record<string, string[]> = {};
    for (const kw of seeds) {
      try {
        const rel = await naverAutocomplete(kw, signal);
        const relOk = rel.filter(looksLikeGardenQuery);   // 노래·상호·의원 류 자동완성 잡음 제거(2026-08-27)
        if (relOk.length) entries[kw] = relOk.slice(0, MAX_SUGGESTIONS);
      } catch { /* 키워드별 fail-open */ }
      try {
        const yt = await ytAutocomplete(kw, signal);
        if (yt.length) ytEntries[kw] = yt.slice(0, MAX_SUGGESTIONS);
      } catch { /* 유튜브 축 fail-open — 네이버 축과 독립 */ }
    }
    if (!Object.keys(entries).length && !Object.keys(ytEntries).length) return; // 전 시드 실패 — 기존 스냅샷 보존
    const next: TrendSnap = {
      date: today, entries, ytEntries,
      ...(cur ? { prevDate: cur.date, prevEntries: cur.entries, ...(cur.ytEntries ? { prevYtEntries: cur.ytEntries } : {}) } : {}),
    };
    const f = snapPath(slug);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 원자적 쓰기(tmp+rename) — 같은 디렉토리 clusterStore 관례. 쓰기 도중 자율 틱의 읽기가 찢어진 JSON 을 만나지 않게.
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(`${f}.tmp`, f);
    console.log(`[trend] 자동완성 스냅샷 갱신 — 시드 ${Object.keys(entries).length}개(${today})`);
  } catch (e) {
    console.log(`[trend] 스냅샷 갱신 실패(무해): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 블록 조립(순수, 테스트 대상) — trendSignalBlock 의 코어. now 주입은 테스트용.
 *  excludeStems: 계열 쿨다운 어간(2026-08-24) — 시드가 그 계열이면 목록에서 제외해, 트렌드 신호가
 *  최근 집중 계열(포도나무 4편/6일 실사고)을 매일 다시 밀지 않게 한다. */
export function buildTrendBlock(snap: TrendSnap | null, now = Date.now(), excludeStems: string[] = []): string {
  if (!snap) return '';
  const age = now - new Date(`${snap.date}T00:00:00`).getTime();
  if (!Number.isFinite(age) || age > STALE_DAYS * 86_400_000) return '';
  const isCooled = (kw: string): boolean => excludeStems.some((s) => kw.replace(/\s+/g, '').includes(s));
  const section = (src: Record<string, string[]> | undefined, prev: Record<string, string[]> | undefined): { lines: string[]; skipped: string[] } => {
    const prevAll = new Set(Object.values(prev ?? {}).flat().map(normKw));
    const entries = Object.entries(src ?? {}).filter(([, sug]) => sug.length);
    return {
      skipped: entries.filter(([kw]) => isCooled(kw)).map(([kw]) => kw),
      lines: entries.filter(([kw]) => !isCooled(kw))
        .map(([kw, sug]) => `- ${kw}: ${sug.map((x) => prevAll.size && !prevAll.has(normKw(x)) ? `★${x}` : x).join(', ')}`),
    };
  };
  const naver = section(snap.entries, snap.prevEntries);
  const yt = section(snap.ytEntries, snap.prevYtEntries);
  if (!naver.lines.length && !yt.lines.length) return '';
  const skipped = [...new Set([...naver.skipped, ...yt.skipped])];
  return `[실검색 연관어 — ${snap.date} 수집${snap.prevDate ? `, ★=직전(${snap.prevDate}) 스냅샷에 없던 새 등장어(최근 검색 수요 변화 신호)` : ''}]\n` +
    (naver.lines.length ? `네이버 자동완성(블로그 검색 수요):\n${naver.lines.join('\n')}\n` : '') +
    // 유튜브 축(2026-08-25) — 쇼츠·영상은 유튜브 검색창 수요가 별도 축이다(네이버와 겹치지 않는 소재가 뜬다).
    (yt.lines.length ? `유튜브 자동완성(쇼츠·영상 검색 수요):\n${yt.lines.join('\n')}\n` : '') +
    (skipped.length ? `(제외: ${skipped.join(', ')} — 최근 집중 다룬 계열이라 이번 목록에서 뺐다)\n` : '') +
    `반영 지침: 실제 사용자들이 지금 치는 검색어다 — 주제·keyword 는 가능하면 이 목록(또는 그 구체 변형)에서 골라라${snap.prevDate ? '. ★ 새 등장어는 시의성 신호로 우선 검토하라' : ''}. 유튜브 목록의 수요는 파생 쇼츠의 소재·훅에도 반영하라.\n\n`;
}

/** 주제 두뇌 주입용 블록 — 스냅샷 없음·낡음은 빈 문자열(무주입). */
export function trendSignalBlock(slug?: string, excludeStems: string[] = []): string {
  try { return buildTrendBlock(readTrendSnap(slug), Date.now(), excludeStems); } catch { return ''; }
}
