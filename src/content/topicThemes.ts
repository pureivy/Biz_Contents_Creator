/**
 * 주제 축 로테이션(순수) — brand.yaml topicThemes(심기·구매·거름·전정·병충해·번식·정원 조성…) 기준으로
 * 최근 30일 블로그가 어느 축에 몰렸는지 세고, 월 상한을 넘은 축은 하드 기각·안 다룬 축은 우선 제안.
 * 2026-08-27 사용자: "수종뿐 아니라 나무 관리·정원 관리·나무 구매·접붙이기 등 다양한 주제를 조사해서 후보군에".
 * 수종 로테이션(speciesRotation)과 직교 — 한 글은 수종 하나 × 축 하나.
 */
export interface TopicTheme { theme: string; seeds: string[]; match: string[] }

// 상한 4 → 5(2026-09-01 사용자 확정, 최소 상향). 산술이 안 맞았다: 축 16 × 4 = 월 수용량 64편인데
// 30일 생산이 68편이라 구조적 초과였고, 어느 축이든 결국 상한에 닿아 16축 중 10축이 막혔다.
// 상한만 올리면 쏠림이 커지므로(실측 '묘목 구매·선택' 11편) 축 확대·하위 축 우선과 함께 간다.
export const THEME_MONTHLY_CAP = 5;
export const THEME_WINDOW_DAYS = 30;

const compact = (s: string): string => (s ?? '').normalize('NFC').replace(/\s+/g, '');

/** 텍스트가 속한 축(첫 매치 토큰이 가장 앞에 나오는 축). */
export function themeInText(text: string, themes: TopicTheme[] | undefined): string | null {
  if (!text || !themes?.length) return null;
  const t = compact(text);
  let best: { theme: string; idx: number; len: number } | null = null;
  for (const th of themes) {
    for (const tok of th.match ?? []) {
      const f = compact(tok);
      if (f.length < 1) continue;
      const idx = t.indexOf(f);
      if (idx < 0) continue;
      if (!best || idx < best.idx || (idx === best.idx && f.length > best.len)) best = { theme: th.theme, idx, len: f.length };
    }
  }
  return best?.theme ?? null;
}

export function themeCoverage(
  items: Array<{ title: string; keyword?: string; ts: string }>, themes: TopicTheme[] | undefined,
  now = new Date(), days = THEME_WINDOW_DAYS,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!themes?.length) return out;
  const since = now.getTime() - days * 86_400_000;
  for (const it of items) {
    const t = new Date(it.ts).getTime();
    if (!Number.isFinite(t) || t < since || t > now.getTime() + 60_000) continue;
    const th = themeInText(`${it.title} ${it.keyword ?? ''}`, themes);
    if (th) out.set(th, (out.get(th) ?? 0) + 1);
  }
  return out;
}

export function overThemeCap(
  text: string, coverage: Map<string, number>, themes: TopicTheme[] | undefined, cap = THEME_MONTHLY_CAP,
): { theme: string; count: number } | null {
  const th = themeInText(text, themes);
  if (!th) return null;
  const n = coverage.get(th) ?? 0;
  return n >= cap ? { theme: th, count: n } : null;
}

/** 프롬프트 블록 — 상한 도달(제안 금지) · 최근 다룸 · 아직 안 다룬 축(우선, 발굴 검색어 예시 동반). */
export function themeRotationBlock(
  themes: TopicTheme[] | undefined,
  coverage: Map<string, number>,
  cap = THEME_MONTHLY_CAP,
  /** 이 라운드가 요구하는 후보 수 — 남은 축이 이보다 적으면 '좁은 장' 경고를 낸다. */
  candidates = 8,
): string {
  if (!themes?.length) return '';
  // 우선 목록의 기준을 'n===0' 에서 **커버리지 하위**로 바꾼다(2026-09-01 사용자 요청: 다양한 주제).
  // 실측: 30일 68편이 나오면 0편인 축이 존재하지 않아 '아직 안 다룬 축' 목록이 늘 비었고, 남는 지시가
  // "가급적 피함"뿐이라 후보가 결국 많이 다룬 축으로 몰렸다. 16축 중 10축 상한 → 깨끗한 후보 0 →
  // 기아 폴백이 유사 주제를 채택(목련 중복). 적게 다룬 축을 이름으로 지목해야 후보가 그쪽으로 간다.
  // 임계는 상한의 절반 — 상한 5면 2편 이하가 '적게 다룬' 축이다(고정 숫자보다 상한을 따라가게).
  const lowMark = Math.max(1, Math.floor(cap / 2));
  const capped: string[] = []; const recent: string[] = [];
  const priority: Array<{ n: number; line: string }> = [];
  for (const th of themes) {
    const n = coverage.get(th.theme) ?? 0;
    const seeds = (th.seeds ?? []).slice(0, 4).join(', ');
    if (n >= cap) capped.push(`${th.theme}(${n}편)`);
    else if (n <= lowMark) priority.push({ n, line: `  · ${th.theme}(${n}편): 예) ${seeds}` });
    else recent.push(`${th.theme}(${n}편)`);
  }
  priority.sort((a, b) => a.n - b.n); // 적은 순 — 0편이 있으면 그게 맨 앞
  const fresh = priority.map((p) => p.line);
  const lines = [`[주제 축 로테이션 — 최근 ${THEME_WINDOW_DAYS}일 블로그 기준, 축당 상한 ${cap}편 · 수종 로테이션과 별개 축]`];
  if (capped.length) lines.push(`- 상한 도달 → 제안 금지(코드가 기각한다): ${capped.join(', ')}`);
  if (recent.length) lines.push(`- 최근 다룸 → 가급적 피함: ${recent.join(', ')}`);
  if (fresh.length) lines.push('- 적게 다룬 축 → **여기서 우선 고른다**(사람들이 실제로 치는 검색어 예시):', ...fresh);
  lines.push('- 후보 8개는 서로 다른 축에서 고르고, 수종 × 축 조합은 기존 글과 겹치지 않게.');
  // 좁은 장에서의 지시 강화(2026-08-30) — 축이 많이 막히면 "가급적 피함"까지 써야 후보가 채워진다.
  // 그 사실을 명시하지 않으면 두뇌가 상한 축에서 8개를 억지로 만들고 전부 코드 기각된다(실측: 16축 중
  // 7축 포화 상태에서 한 라운드 17건 기각, 생산 정지). 남은 자리를 세어 알려 주는 편이 정확하다.
  // 임계는 '축의 절반'이 아니라 **요구 후보 수**로 잡는다 — 위 줄이 "후보 8개를 서로 다른 축에서"라고
  // 요구하므로, 열린 축이 그보다 적거나 겨우 같으면 그 지시가 이미 성립하지 않는다(실측: 16축 중 7축
  // 포화 = 열린 9축이지만 그중 6축은 이미 다룬 것이라 실질 여유가 없었다).
  const open = themes.length - capped.length;
  if (capped.length && open <= candidates + 1) {
    lines.push(
      `- ⚠ 지금 쓸 수 있는 축은 ${open}개뿐이다(${themes.length}축 중 ${capped.length}축 상한 도달).`
      + ` 후보 8개를 채우려면 '아직 안 다룬 축'과 '최근 다룸' 축을 모두 써라 — 상한 축으로 자리를 메우면 그 후보는 버려진다.`
      + (fresh.length ? '' : ' 적게 다룬 축이 없으면 남은 축에서 편수가 적은 것부터 고른다.'),
    );
  }
  return lines.join('\n');
}
