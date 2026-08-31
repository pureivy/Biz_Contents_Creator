/**
 * 시기 소재 게이트(순수) — 제목에 든 달력 소재(단풍·월동·새순…)가 "이번 달 또는 다음 달" 밖이면 기각.
 * 2026-08-27 실사고: 검색량 게이트는 keyword("활엽수", 시즌 0.81)만 재서 8월 말에 단풍 글이 통과됐다.
 * 사용자 확정 "지금~다음 달만 — 사람들이 지금 검색하거나 4주 안에 검색할 소재만". 달력은 brand.yaml
 * seasonalSubjects(업종어라 브랜드별). 어두 규칙 없이 부분 일치(단풍나무·단풍철 모두 단풍 소재).
 */
export interface SeasonalSubject { term: string; months: number[] }

/** 이번 달·다음 달(1~12, 12→1 롤오버). */
export function seasonWindow(now = new Date()): [number, number] {
  const m = now.getMonth() + 1;
  return [m, (m % 12) + 1];
}

/** 제목이 시기 밖 소재를 담고 있으면 그 항목, 아니면 null. 여러 개면 제목에서 먼저 나오는 것. */
export function offSeasonSubject(title: string, lexicon: SeasonalSubject[] | undefined, now = new Date()): SeasonalSubject | null {
  if (!title || !lexicon?.length) return null;
  const [cur, next] = seasonWindow(now);
  let best: { idx: number; item: SeasonalSubject } | null = null;
  for (const item of lexicon) {
    if (!item?.term || !item.months?.length) continue;
    const idx = title.indexOf(item.term);
    if (idx < 0) continue;
    if (item.months.includes(cur) || item.months.includes(next)) continue;   // 제철 또는 다음 달 제철 → 통과
    if (!best || idx < best.idx) best = { idx, item };
  }
  return best?.item ?? null;
}

export function formatMonths(months: number[]): string {
  const ms = [...new Set(months)].sort((a, b) => a - b);
  if (!ms.length) return '';
  // 연속 구간은 "10~11월", 나머지는 "3·4월" 꼴 — 11,12,1,2 처럼 해를 넘는 구간은 단순 나열로 둔다.
  const ranges: string[] = [];
  let start = ms[0]!, prev = ms[0]!;
  for (const m of ms.slice(1)) {
    if (m === prev + 1) { prev = m; continue; }
    ranges.push(start === prev ? `${start}` : `${start}~${prev}`); start = m; prev = m;
  }
  ranges.push(start === prev ? `${start}` : `${start}~${prev}`);
  return `${ranges.join('·')}월`;
}

/** 프롬프트 블록 — 지금 창 밖인 소재만 나열(창 안이면 빈 문자열). */
export function seasonalSubjectBlock(lexicon: SeasonalSubject[] | undefined, now = new Date()): string {
  if (!lexicon?.length) return '';
  const [cur, next] = seasonWindow(now);
  const off = lexicon.filter((x) => x.term && x.months?.length && !x.months.includes(cur) && !x.months.includes(next));
  if (!off.length) return '';
  return `[시기 밖 소재 — 제안 금지(지금 ${cur}월, 독자가 지금~다음 달 검색하는 것만 쓴다)]\n`
    + off.map((x) => `- ${x.term}(${formatMonths(x.months)})`).join('\n')
    + '\n이 말이 제목·키워드에 들어간 주제는 코드가 기각한다. "미리 준비" "지금 알아두면" 식으로도 우회하지 마라.';
}
