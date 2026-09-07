/**
 * 계열 결정적 폴백 매처(2026-08-25 v2 개편) — 쿨다운의 본체는 seriesLedger(LLM 분류 원장+감쇠 점수)로
 * 이관됐고, 이 모듈은 LLM 분류가 없거나 실패했을 때의 결정적 라벨 추출만 남는다(fail-open 의 바닥).
 * 연혁: v1(2026-08-24)은 정규식·사전 집계로 직접 게이트했다 — 포도 4편/6일 → 블루베리(베리 접미) →
 * 전정(행위 축) 순서로 사각을 한 땀씩 메우다, "새 편중마다 코드 수정" 구조 자체를 원장 방식으로 교체.
 *
 * 2026-09-07 범용화: 'XX나무'·'XX베리' 정규식과 원예 행위 축이 코드에 박혀 있었다. 이제 소재 이름은
 * 브랜드 소재 카탈로그(speciesCatalog)와 소재 사전에서, 행위 축은 brand.activityAxes 에서 온다.
 * 둘 다 없으면 라벨은 null — 폴백이 없을 뿐 원장 방식은 그대로 돈다.
 */
import { activityAxes as brandActivityAxes, subjectAnchorTest, subjectGenericTerms, subjectNameTable, getBrand } from './brand';
import { loadSpecies } from './species';

export interface NameEntry { key: string; name: string }

/** 소재 이름 표 = 카탈로그(브랜드 설정) + 소재 사전(data/species-<slug>.yaml) — 긴 키가 먼저. */
export function subjectNames(): NameEntry[] {
  const out = subjectNameTable(getBrand());
  for (const sp of loadSpecies()) {
    out.push({ key: sp.name, name: sp.name });
    for (const a of sp.aliases ?? []) out.push({ key: a, name: sp.name });
  }
  return out.filter((x) => x.key).sort((a, c) => c.key.length - a.key.length);
}

/** 총칭 접미 제거 — seriesLedger.normSpecies 와 같은 규칙(어간이 2자 이상 남을 때만). '감나무'는 그대로. */
export function stripGenericSuffix(name: string, generic: readonly string[]): string {
  const raw = (name || '').normalize('NFC').replace(/\s+/g, '');
  for (const g of [...generic].sort((a, b) => b.length - a.length)) {
    if (g && raw.endsWith(g) && raw.length - g.length >= 2) return raw.slice(0, raw.length - g.length);
  }
  return raw;
}

/**
 * 소재 어간 추출(순수, 테스트 대상) — 공백 무시 텍스트에서 소재 이름·별칭을 찾아 정식명으로 바꾸고 총칭 접미를 뗀다.
 * 이름 표가 비어 있으면 브랜드 앵커 정규식(있으면)으로 잡되, 총칭어 자체는 버린다.
 */
export function seriesStems(
  text: string,
  names: readonly NameEntry[] = subjectNames(),
  generic: readonly string[] = subjectGenericTerms(),
  anchored: ((t: string) => boolean) | null = subjectAnchorTest(),
): string[] {
  const t = (text || '').normalize('NFC').replace(/\s+/g, '');
  if (!t) return [];
  const out = new Set<string>();
  if (names.length) {
    let rest = t;
    for (const { key, name } of names) {
      if (!key || !rest.includes(key)) continue;
      out.add(stripGenericSuffix(name, generic));
      rest = rest.split(key).join(' '); // 긴 키가 먼저 잡혔으니 짧은 키가 그 안에서 다시 걸리지 않게
    }
    return [...out];
  }
  // 이름 표가 없을 때의 바닥 — 앵커 정규식이 있으면 그 판정만 쓴다(어간은 못 뽑는다 → 텍스트 자체를 키로).
  if (anchored && anchored(t) && !generic.includes(t)) out.add(t);
  return [...out];
}

/** 행위 축(브랜드 설정) — terms[0] 이 표준형(LLM 분류 라벨과 통일). */
export function activityAxes(): Array<{ terms: string[] }> { return brandActivityAxes(); }

/** 결정적 라벨 폴백(순수, 테스트 대상) — LLM 분류 부재 시 원장 점수 계산이 이걸로 라벨을 만든다.
 *  activity 는 동의어 묶음의 표준형(terms[0])으로 정규화해 LLM 라벨과 같은 키 공간을 쓴다. */
export function fallbackSeriesLabels(
  text: string,
  opts: { names?: readonly NameEntry[]; generic?: readonly string[]; axes?: ReadonlyArray<{ terms: string[] }> } = {},
): { species: string | null; activity: string | null } {
  const stripped = (text || '').normalize('NFC').replace(/\s+/g, '');
  const axes = opts.axes ?? activityAxes();
  const axis = axes.find((a) => a.terms.some((term) => stripped.includes(term.replace(/\s+/g, ''))));
  const stems = seriesStems(text, opts.names ?? subjectNames(), opts.generic ?? subjectGenericTerms());
  return { species: stems[0] ?? null, activity: axis?.terms[0] ?? null };
}
