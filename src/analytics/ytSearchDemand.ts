/**
 * 우리 채널의 유튜브 검색 전환 성적(2026-09-04) — 주제를 고르는 데이터가 아니라 채점표다.
 *
 * 왜 모으는가. 09-02 이후 쇼츠 피드 노출이 끊겼는데 검색 유입만 살아남았다(7월 하루 30회 →
 * 8월 말 340회로 오히려 자랐다). 그리고 평탄선 1,050 을 넘긴 두 편은 둘 다 검색으로 넘겼다:
 *   1,865 회 = 피드 686 + 검색 1,085   "하스카프베리 묘목, 지금 심으면 늦는 이유"
 *   2,051 회 = 피드 1,038 + 검색 461   "포도나무 수확 시기, 색보다 아래쪽 알로 가늠하세요"
 *
 * 이 값이 무엇인지 정확히 해 둔다(사용자 지적 2026-09-04). "하스카프베리묘목 551회"는
 * **그 말을 검색한 사람 중 우리 영상을 클릭한 조회수**다. 유튜브 전체에서 그 말이 몇 번
 * 검색됐는지가 아니다. 그러니 이건 수요가 아니라 전환이고, 우리가 만든 편에만 생긴다.
 *
 * 따라서 주제 선정에 쓰면 앞뒤가 바뀐다 — 안 만든 주제는 수요가 아무리 커도 여기서 0 이라,
 * 이걸로 주제를 고르면 이미 만든 것 주변만 맴돌게 된다. 주제는 외부 수요(네이버 검색광고)로
 * 고른다. 이 축이 하는 일은 그 선택을 채점하는 것이다:
 *   ① 회양목 7,110/월  ← 세상이 이만큼 찾는다(외부 수요)
 *   ③ 회양목 유입 0회   ← 편을 만들었는데 한 명도 안 들어왔다(이 파일)
 * ①만으로는 "우리 각도가 안 먹혔다"를 절대 알 수 없다. 그걸 아는 것이 이 축의 값어치다.
 */
import type { SearchInflow } from './performance';

/** 주제 제안에 넘길 검색어 한 줄. */
export interface SearchDemandRow {
  readonly keyword: string;
  /** 이 검색어로 들어온 조회수(편별 최대값의 합). */
  readonly count: number;
  /** 이 말을 정면으로 다룬 편이 이미 있는가(표시용). 주제 선정 기준으로 쓰지 않는다 — 위 헤더 참조. */
  readonly covered: boolean;
}

/**
 * 잡음 하한(2026-09-04 실측). 수집된 검색어에는 우리와 무관한 트렌드어가 1~3회씩 섞인다
 * ("감스트 리중딱", "박위 학폭", "네팔홍수장면"). 이걸 주제 제안에 넣으면 두뇌가 엉뚱한
 * 소재를 만들어 낸다. 조회 3회 미만은 버린다 — 진짜 수요라면 그보다는 붙는다.
 */
export const MIN_SEARCH_COUNT = 3;

/** 검색어 정규화 — 띄어쓰기·대소문자만 무시한다("고무나무 삽목" 과 "고무나무삽목" 은 같은 말이다). */
export function normalizeTerm(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 편별 검색어를 모아 순위를 매긴다(순수).
 *
 * 같은 말이 여러 편에 붙으면 합산한다 — 한 검색어의 총수요를 보려는 것이지 편별 성적이 아니다.
 * 띄어쓰기만 다른 표기는 하나로 합치고, 표기는 조회가 가장 많았던 쪽을 대표로 남긴다.
 *
 * isRelevant 는 호출부가 준다(수종 사전·브랜드 업종어). 도메인 지식을 이 순수 함수에 넣지 않는
 * 이유는, 그 판정이 브랜드마다 다르고 데이터에서 오기 때문이다.
 */
export function rankSearchDemand(
  perVideo: ReadonlyArray<{ terms: readonly SearchInflow[] }>,
  opts: {
    /** 이 말을 정면으로 다룬 편이 이미 있는가. */
    isCovered: (keyword: string) => boolean;
    /** 우리 분야의 말인가 — 무관한 트렌드어를 거른다. */
    isRelevant: (keyword: string) => boolean;
    minCount?: number;
    limit?: number;
  },
): SearchDemandRow[] {
  const min = opts.minCount ?? MIN_SEARCH_COUNT;
  const agg = new Map<string, { label: string; best: number; total: number }>();
  for (const v of perVideo) {
    for (const t of v.terms ?? []) {
      const label = String(t?.keyword ?? '').trim();
      const count = Number(t?.count);
      if (!label || !Number.isFinite(count) || count <= 0) continue;
      const key = normalizeTerm(label);
      if (!key) continue;
      const cur = agg.get(key) ?? { label, best: 0, total: 0 };
      cur.total += count;
      if (count > cur.best) { cur.best = count; cur.label = label; } // 대표 표기 = 가장 많이 걸린 표기
      agg.set(key, cur);
    }
  }
  return [...agg.values()]
    .filter((r) => r.total >= min)
    .filter((r) => { try { return opts.isRelevant(r.label); } catch { return false; } })
    .map((r) => ({
      keyword: r.label,
      count: r.total,
      covered: (() => { try { return opts.isCovered(r.label); } catch { return true; } })(), // 판정 실패는 '있음'으로 — 중복 제안보다 낫다
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, opts.limit ?? 20);
}

/**
 * 검색 전환이 0 이었던 소재(순수) — 편은 만들었는데 검색으로 한 명도 안 들어온 자리.
 *
 * 이게 ③(우리 검색어)이 ①(외부 수요)에게 해 줄 수 있는 유일한 말이다. ①은 "회양목 7,110/월"
 * 이라고만 말하고, 우리가 그 수요를 먹었는지는 모른다. 여기서 0 으로 잡히면 "수요는 있는데
 * 우리 각도가 안 먹혔다"는 뜻이고, 같은 각도로 또 만들면 또 0 이다.
 */
export function unconvertedSubjects(
  covered: ReadonlyArray<{ subject: string; searchViews: number }>, max = 8,
): string[] {
  return covered
    .filter((c) => c.subject && (Number(c.searchViews) || 0) <= 0)
    .map((c) => c.subject.trim())
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .slice(0, max);
}

/**
 * 주제 제안 프롬프트에 넣을 블록(순수).
 *
 * **이건 주제 목록이 아니라 성적표다**(2026-09-04 사용자 지적으로 방향 수정).
 * 처음엔 "편이 없는 검색어를 우선 고려하라"고 썼는데 앞뒤가 바뀐 것이었다 — 이 목록은 이미
 * 만든 편에만 생기므로, 이걸로 주제를 고르면 만든 것 주변만 맴돈다. 안 만든 주제는 수요가
 * 아무리 커도 여기서 0 으로 보인다.
 *
 * 주제는 외부 수요(네이버 검색광고)로 고른다. 이 블록이 하는 일은 둘뿐이다.
 *  · 먹힌 표기를 알려 준다 — 같은 소재를 또 다룰 때 제목을 어느 말에 붙일지.
 *  · 못 먹은 소재를 알려 준다 — 수요가 큰데 0 이면 각도를 바꾸라는 신호다.
 */
export function searchDemandBlock(
  rows: readonly SearchDemandRow[], opts: { missed?: readonly string[] } = {},
): string {
  const missed = opts.missed ?? [];
  if (!rows.length && !missed.length) return '';
  const out: string[] = ['[우리 유튜브 검색 전환 성적 — 주제 목록이 아니라 지난 편들의 채점표다]'];
  if (rows.length) {
    out.push('실제로 검색에서 우리를 클릭한 말(이 표기가 먹혔다):');
    out.push(...rows.map((r) => `- ${r.keyword} (${r.count}회)`));
  }
  if (missed.length) {
    out.push('', '편은 있는데 검색 유입이 0 인 소재(수요가 없는 게 아니라 우리 각도가 안 먹혔다):');
    out.push(`- ${missed.join(', ')}`);
  }
  out.push(
    '',
    '· 주제는 검색 수요 데이터에서 고르되, 위 성적을 참고해 읽어라.',
    '· 위 소재를 다시 다룬다면 각도를 바꿔라 — 같은 각도로 또 만들면 또 0 이다.',
    '· 먹힌 표기가 있는 소재를 다시 다룰 때는 keyword 를 그 표기에 가깝게 잡아라. 사람들이 그렇게 친다.',
  );
  return out.join('\n');
}
