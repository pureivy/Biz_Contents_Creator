/**
 * 수종 로테이션(순수) — 브랜드 수종 카탈로그(brand.yaml speciesCatalog) 기준으로 최근 30일 블로그가
 * 어느 수종에 몰렸는지 세고, 월 상한을 넘은 수종은 하드 기각·프롬프트 제안 금지, 안 다룬 수종은 우선 제안.
 * 2026-08-27 사용자: "배롱나무는 너무 많이 다뤘어. 나무 종류가 많을 텐데 왜 이래" — 실측 블로그 91편 중
 * 배롱 8·블루베리 7·포도 5, 씨앗 키워드 21개가 10종 안팎이라 두뇌가 그 안에서만 돌았다.
 */
import { subjectGenericTerms } from './brand';

export interface SpeciesEntry { name: string; aliases?: string[] }
export interface SpeciesGroup { group: string; species: SpeciesEntry[] }

/** 30일 내 같은 수종 블로그 상한(초과분부터 하드 기각). 하루 2편·수종 60여 종이면 수종당 2편/월이 자연 배분. */
export const SPECIES_MONTHLY_CAP = 2;
export const SPECIES_WINDOW_DAYS = 30;

const compact = (s: string): string => (s ?? '').normalize('NFC').replace(/\s+/g, '');

/** 텍스트에 든 카탈로그 수종(정식명). 여러 개면 가장 긴 표기가 맞은 것 — '배롱나무'가 '배'보다 우선. */
export function speciesInText(text: string, catalog: SpeciesGroup[] | undefined): string | null {
  if (!text || !catalog?.length) return null;
  const t = compact(text);
  let best: { name: string; len: number; idx: number } | null = null;
  for (const g of catalog) {
    for (const sp of g.species ?? []) {
      for (const form of [sp.name, ...(sp.aliases ?? [])]) {
        const f = compact(form);
        if (f.length < 2) continue;
        const idx = t.indexOf(f);
        if (idx < 0) continue;
        if (!best || f.length > best.len || (f.length === best.len && idx < best.idx)) best = { name: sp.name, len: f.length, idx };
      }
    }
  }
  return best?.name ?? null;
}

/** 최근 days 일 블로그(제목+키워드)에서 수종별 편수. */
export function speciesCoverage(
  items: Array<{ title: string; keyword?: string; ts: string }>,
  catalog: SpeciesGroup[] | undefined,
  now = new Date(), days = SPECIES_WINDOW_DAYS,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!catalog?.length) return out;
  const since = now.getTime() - days * 86_400_000;
  for (const it of items) {
    const t = new Date(it.ts).getTime();
    if (!Number.isFinite(t) || t < since || t > now.getTime() + 60_000) continue;
    const sp = speciesInText(`${it.title} ${it.keyword ?? ''}`, catalog);
    if (sp) out.set(sp, (out.get(sp) ?? 0) + 1);
  }
  return out;
}

/**
 * 수종별 월 상한 — 수요가 큰 수종은 몇 편 더 허용한다(순수, 2026-09-04 사용자 확정).
 *
 * 종전엔 수요와 무관하게 전 수종 2편이었다. 실측 배분이 그래서 어긋났다:
 *   6편  배롱나무      수요 22/월      검색 유입 27회
 *   4편  포도나무      수요 230/월     검색 유입 461회
 *   3편  하스카프베리  수요 목록 밖    검색 유입 1,085회
 * 수종 수를 넓게 가는 건 유지한다(109편에 104소재 — 이미 최대치다). 편수 배분만 수요에 비례시킨다.
 *
 * **느슨하게만 만든다. 절대 조이지 않는다.** 이 채널 최고 성적(하스카프베리 검색 1,085회)은
 * 네이버 수요 목록에 아예 없는 수종에서 나왔다. 수요가 낮다고 상한을 낮췄다면 그 수종을 처음부터
 * 막았을 것이다 — 수요 데이터가 모르는 틈새가 실제로 가장 크게 먹혔다.
 */
export function speciesCapFor(volume: number | undefined, base = SPECIES_MONTHLY_CAP): number {
  const v = Number(volume);
  if (!Number.isFinite(v) || v <= 0) return base;   // 미상·0 은 종전 그대로 — 틈새를 막지 않는다
  if (v >= 5000) return base + 2;
  if (v >= 1000) return base + 1;
  return base;
}

/** cap 인자 정규화(순수) — 숫자면 그대로, 함수면 수종별 상한. 종전 호출부는 그대로 동작한다. */
function capOf(cap: number | ((name: string) => number), name: string): number {
  if (typeof cap !== 'function') return cap;
  try { const n = cap(name); return Number.isFinite(n) && n >= 1 ? n : SPECIES_MONTHLY_CAP; }
  catch { return SPECIES_MONTHLY_CAP; }
}

/** 후보가 월 상한을 넘은 수종이면 {name,count}, 아니면 null. cap 은 숫자 또는 수종별 함수. */
export function overSpeciesCap(
  text: string, coverage: Map<string, number>, catalog: SpeciesGroup[] | undefined,
  cap: number | ((name: string) => number) = SPECIES_MONTHLY_CAP,
): { name: string; count: number } | null {
  const sp = speciesInText(text, catalog);
  if (!sp) return null;
  const n = coverage.get(sp) ?? 0;
  return n >= capOf(cap, sp) ? { name: sp, count: n } : null;
}

/**
 * 프롬프트 블록 — 상한 도달(제안 금지) · 최근 다룸(피함) · 아직 안 다룬 소재(우선, 분류별).
 * genericTerms 미지정이면 브랜드 총칭어(subjectGenericTerms) — 비면 총칭 제한 문장을 생략한다.
 */
export function speciesRotationBlock(
  catalog: SpeciesGroup[] | undefined, coverage: Map<string, number>,
  cap: number | ((name: string) => number) = SPECIES_MONTHLY_CAP, minFresh = 5,
  genericTerms: readonly string[] = subjectGenericTerms(),
): string {
  if (!catalog?.length) return '';
  const capped: string[] = []; const recent: string[] = []; const freshGroups: string[] = [];
  for (const g of catalog) {
    const fresh: string[] = [];
    for (const sp of g.species ?? []) {
      const n = coverage.get(sp.name) ?? 0;
      if (n >= capOf(cap, sp.name)) capped.push(`${sp.name}(${n}편)`);
      else if (n > 0) recent.push(`${sp.name}(${n}편)`);
      else fresh.push(sp.name);
    }
    if (fresh.length) freshGroups.push(`  · ${g.group}: ${fresh.join(', ')}`);
  }
  const lines = [`[소재 로테이션 — 최근 ${SPECIES_WINDOW_DAYS}일 블로그 기준, 소재당 상한 ${cap}편]`];
  if (capped.length) lines.push(`- 상한 도달 → 제안 금지(코드가 기각한다): ${capped.join(', ')}`);
  if (recent.length) lines.push(`- 최근 다룸 → 가급적 피함: ${recent.join(', ')}`);
  if (freshGroups.length) lines.push(`- 아직 안 다룬 소재 → 우선(후보 중 최소 ${minFresh}개는 여기서):`, ...freshGroups);
  lines.push('- 소재는 카탈로그 정식명 그대로 쓰고, 한 후보에 소재 하나만.'
    + (genericTerms.length ? ` 총칭(${genericTerms.join('·')})만으로 된 주제는 최대 1개.` : ''));
  return lines.join('\n');
}
