/**
 * 수종 로테이션(순수) — 브랜드 수종 카탈로그(brand.yaml speciesCatalog) 기준으로 최근 30일 블로그가
 * 어느 수종에 몰렸는지 세고, 월 상한을 넘은 수종은 하드 기각·프롬프트 제안 금지, 안 다룬 수종은 우선 제안.
 * 2026-08-27 사용자: "배롱나무는 너무 많이 다뤘어. 나무 종류가 많을 텐데 왜 이래" — 실측 블로그 91편 중
 * 배롱 8·블루베리 7·포도 5, 씨앗 키워드 21개가 10종 안팎이라 두뇌가 그 안에서만 돌았다.
 */
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

/** 후보가 월 상한을 넘은 수종이면 {name,count}, 아니면 null. */
export function overSpeciesCap(
  text: string, coverage: Map<string, number>, catalog: SpeciesGroup[] | undefined, cap = SPECIES_MONTHLY_CAP,
): { name: string; count: number } | null {
  const sp = speciesInText(text, catalog);
  if (!sp) return null;
  const n = coverage.get(sp) ?? 0;
  return n >= cap ? { name: sp, count: n } : null;
}

/** 프롬프트 블록 — 상한 도달(제안 금지) · 최근 다룸(피함) · 아직 안 다룬 수종(우선, 분류별). */
export function speciesRotationBlock(
  catalog: SpeciesGroup[] | undefined, coverage: Map<string, number>, cap = SPECIES_MONTHLY_CAP, minFresh = 5,
): string {
  if (!catalog?.length) return '';
  const capped: string[] = []; const recent: string[] = []; const freshGroups: string[] = [];
  for (const g of catalog) {
    const fresh: string[] = [];
    for (const sp of g.species ?? []) {
      const n = coverage.get(sp.name) ?? 0;
      if (n >= cap) capped.push(`${sp.name}(${n}편)`);
      else if (n > 0) recent.push(`${sp.name}(${n}편)`);
      else fresh.push(sp.name);
    }
    if (fresh.length) freshGroups.push(`  · ${g.group}: ${fresh.join(', ')}`);
  }
  const lines = [`[수종 로테이션 — 최근 ${SPECIES_WINDOW_DAYS}일 블로그 기준, 수종당 상한 ${cap}편]`];
  if (capped.length) lines.push(`- 상한 도달 → 제안 금지(코드가 기각한다): ${capped.join(', ')}`);
  if (recent.length) lines.push(`- 최근 다룸 → 가급적 피함: ${recent.join(', ')}`);
  if (freshGroups.length) lines.push(`- 아직 안 다룬 수종 → 우선(후보 중 최소 ${minFresh}개는 여기서):`, ...freshGroups);
  lines.push('- 수종은 카탈로그 정식명 그대로 쓰고, 한 후보에 수종 하나만. 총칭(나무·묘목·유실수·조경수)만으로 된 주제는 최대 1개.');
  return lines.join('\n');
}
