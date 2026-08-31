// 카드뉴스 슬라이드 뷰어의 순수 로직 — 파일명·URL·인덱스 이동.
// UI(SlideStrip·SlideLightbox)는 얇게 두고 경계 동작(양끝에서 멈춤)은 여기서 단위 테스트한다
// — officeNav·workflowStages 와 같은 관례(프론트 테스트는 .ts 순수 모듈만 돈다).

/** 0-based 인덱스 → 서버 슬라이드 파일명(0 → slide_01.png). */
export function slideName(i: number): string {
  return `slide_${String(i + 1).padStart(2, "0")}.png`;
}

/** 슬라이드 이미지 URL. version 을 주면 캐시 무효화 쿼리를 붙인다(재렌더 후 옛 이미지 방지). */
export function slideUrl(cardId: string, i: number, version?: string): string {
  return `/cardnews/${cardId}/slides/${slideName(i)}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/** [0, n-1] 로 자른 인덱스. 장수가 없거나 값이 이상하면 0. */
export function clampIndex(i: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const t = Number.isFinite(i) ? Math.trunc(i) : 0;
  return Math.min(Math.max(t, 0), Math.trunc(n) - 1);
}

/** 한 장 이동 — 양끝에서 멈춘다(순환 없음: "7 / 7"에서 →가 1로 튀면 카운터와 어긋난다). */
export function stepIndex(i: number, n: number, dir: 1 | -1): number {
  return clampIndex(clampIndex(i, n) + dir, n);
}

/** 그 방향으로 더 갈 수 있는가 — 화살표 버튼 비활성 판정. */
export function canStep(i: number, n: number, dir: 1 | -1): boolean {
  return n > 0 && stepIndex(i, n, dir) !== clampIndex(i, n);
}

/** 미리 받아둘 이웃 인덱스(앞뒤 1장, 존재하는 것만) — 넘길 때 깜빡임 제거용. */
export function neighborIndexes(i: number, n: number): number[] {
  const c = clampIndex(i, n);
  return [c - 1, c + 1].filter((x) => x >= 0 && x < n);
}
