/**
 * 안 쓴 실촬영 소재(2026-09-06 사용자 요청: "보관소에 새로운 영상 자료가 있으면 그걸 먼저
 * 활용해서 자율런을 돌려줘") — 주제를 고를 때 '어느 소재를 먼저 볼지'의 근거.
 *
 * 왜 이 신호가 값진가. 이 채널의 09-02 조회 급감 진단은 "쇼츠 피드가 초기 배분을 거뒀다"
 * 였고, 109편이 이어가지 못한 공통점은 생성 이미지로만 만든 편들이라는 것이다. 운영자가
 * 직접 찍은 현장 영상은 이 채널이 가진 유일한 차별 자산이다. 창고에 쌓아 두면 값이 0이다.
 *
 * ⚠ 이건 게이트가 아니라 동점 처리다.
 *   미사용 소재가 15건이면 하루 한 편 기준으로 보름치다. 이걸 강제 조건으로 걸면 9월
 *   식재 성수기 내내 주제가 재고에 끌려다니고, 진단이 지목한 유일한 살아 있는 축(검색어
 *   매칭)을 밀어낸다. 그래서 "계절·검색 수요가 먼저고, 그게 비슷할 때 이쪽을 골라라"로
 *   주입한다 — igAxis 가 "계절과 싸우지 마라"라고 적은 것과 같은 등급의 신호다.
 *
 * 소진 판정의 한계를 적어 둔다(실측 기반이 아니라 흔적 기반이다):
 *   - 발행 전에 지운 편(purge)은 폴더가 사라져서, 그 편만 쓴 소재는 '미사용'으로 되돌아온다.
 *     되돌아온 소재를 한 번 더 다루는 것은 무해해서 그대로 둔다.
 *   - 유튜브·인스타 두 편이 같은 클립을 물려받으므로 '몇 번 썼나'는 세지 않는다. 썼나/안 썼나만 본다.
 *   - 사전이 모르는 딱지는 '미사용'으로 친다. 운영자가 직접 적은 이름이 유일한 근거이고,
 *     모른다는 이유로 재고에서 빼면 그 소재는 영원히 안 쓰인다.
 */

/** 소진 판정에 필요한 최소 정보 — 보관소 항목에서 이만큼만 본다. */
export interface StockItem {
  readonly species?: string;
  readonly kind?: string;
  readonly seconds?: number;
}

export interface StockRow {
  /** 운영자가 적은 딱지 그대로 — 프롬프트에 이 이름으로 나간다. */
  readonly species: string;
  readonly count: number;
  /** 가장 긴 영상 길이(초). 짧은 소재만 있으면 한 씬도 못 채운다. */
  readonly seconds: number;
}

/**
 * 한 씬을 채우려면 이만큼은 있어야 한다(초).
 *
 * userAssets.planVideoSegments 가 MIN_CLIP_COVERAGE=0.5 로 '씬 길이의 절반은 덮어야
 * 배정한다'고 본다. 씬 하나가 대략 6~8초이므로 3초면 그 문턱을 넘는다. 이보다 짧은 소재를
 * 재고라고 내밀면 주제를 그쪽으로 몰아 놓고 정작 화면에는 안 들어간다.
 */
export const MIN_USABLE_SEC = 3;

/**
 * 아직 안 쓴 촬영본을 소재별로 묶는다(순수).
 *
 * @param items 보관소 목록
 * @param used  이미 실촬영이 들어간 소재의 표준명 집합
 * @param canon 딱지 → 표준명. 사전이 모르는 이름은 그대로 돌려준다(fail-open).
 */
export function unusedStock(
  items: readonly StockItem[],
  used: ReadonlySet<string>,
  canon: (name: string) => string = (n) => n,
): StockRow[] {
  const by = new Map<string, { count: number; seconds: number }>();
  for (const m of items) {
    if (m.kind !== 'video') continue; // 사용자가 말한 것은 '영상 자료'다
    const label = String(m.species ?? '').trim();
    if (!label) continue; // 무표기 범용 소재는 어느 주제로도 안 이어진다
    const sec = Number(m.seconds);
    if (!Number.isFinite(sec) || sec < MIN_USABLE_SEC) continue;
    let key = label;
    try { key = String(canon(label) ?? label).trim() || label; } catch { key = label; }
    if (used.has(key)) continue;
    const cur = by.get(label) ?? { count: 0, seconds: 0 };
    by.set(label, { count: cur.count + 1, seconds: Math.max(cur.seconds, sec) });
  }
  return [...by.entries()]
    .map(([species, v]) => ({ species, count: v.count, seconds: Math.round(v.seconds * 10) / 10 }))
    .sort((a, b) => b.count - a.count || b.seconds - a.seconds || a.species.localeCompare(b.species));
}

/** 프롬프트에 몇 개까지 이름을 댈지 — 너무 길면 다른 신호를 덮는다. */
export const STOCK_NAMES_IN_PROMPT = 10;

/**
 * 주제 제안 프롬프트에 넣을 블록(순수). 재고가 없으면 빈 문자열(무주입).
 *
 * 문구가 이 함수의 전부다. "이 소재를 다뤄라"가 아니라 "다른 조건이 비슷하면 이쪽을
 * 먼저 골라라"로 적는다 — 계절과 검색 수요를 이기면 안 된다.
 */
export function stockBlock(rows: readonly StockRow[]): string {
  if (!rows.length) return '';
  const names = rows.slice(0, STOCK_NAMES_IN_PROMPT)
    .map((r) => (r.count > 1 ? `${r.species}(${r.count}건)` : r.species));
  const rest = rows.length - names.length;
  return [
    '[실촬영 재고 — 아직 화면에 안 나간 운영자 촬영본이 있는 소재]',
    names.join(', ') + (rest > 0 ? ` 외 ${rest}건` : ''),
    '',
    '이 소재로 주제를 잡으면 생성 이미지 대신 실제 촬영 영상이 화면에 들어간다.',
    '이 채널이 가진 유일한 차별 자산이고, 창고에 두면 값이 0이다.',
    '',
    '⚠ 다만 이건 동점 처리다. 계절 시의성과 검색 수요가 먼저다 — 지금 시기에 맞지 않는',
    '소재를 재고가 있다는 이유로 고르지 마라. 앞의 조건들이 비슷할 때 이 목록에 있는',
    '소재를 먼저 골라라. 목록에 마땅한 것이 없으면 무시하고 평소대로 골라라.',
  ].join('\n');
}

/**
 * 이미 실촬영이 들어간 소재를 읽는다(부수효과 — 숏폼 폴더를 훑는다).
 *
 * 근거는 `clips/user_*.mp4` 의 존재다. applyUserSegments 가 운영자 영상을 이 이름으로
 * 구워 넣기 때문에, 이 파일이 있으면 그 편에 실촬영이 실제로 나갔다는 뜻이다.
 * (편 기록의 '보관소 영상 N개 사용' 로그는 배정 시도일 뿐 화면에 나갔다는 보장이 아니다 —
 *  길이 미달로 배정이 취소될 수 있다. 구워진 파일이 더 강한 근거다.)
 *
 * 실패는 삼킨다 — 재고 신호를 못 읽었다고 주제 제안이 멈추면 안 된다.
 */
export function usedSpecies(
  shorts: ReadonlyArray<{ id: string; keyword?: string; topic?: string; title?: string }>,
  deps: { hasUserClip: (id: string) => boolean; speciesOf: (text: string) => string | undefined },
): Set<string> {
  const out = new Set<string>();
  for (const s of shorts) {
    try {
      if (!deps.hasUserClip(s.id)) continue;
      const sp = deps.speciesOf(`${s.keyword ?? ''} ${s.topic ?? s.title ?? ''}`);
      if (sp) out.add(sp);
    } catch { /* 한 편을 못 읽어도 나머지는 센다 */ }
  }
  return out;
}
