// 카드뉴스 생성 시 고를 수 있는 이미지 스타일 — 제작실(CardNewsView)·검토탭(DraftReview) 공용.
// value 는 백엔드 PRESETS 키와 정확히 일치해야 함(자동=디자이너가 주제 보고 선택).
export const CARD_STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "자동 (주제에 맞게)" },
  { value: "handwritten_poster", label: "손글씨 포스터 (인사·캠페인·감성)" },
  { value: "photorealistic", label: "사진풍 (정보·실용)" },
  { value: "flat_design", label: "플랫 일러스트 (가이드·수치)" },
  { value: "watercolor", label: "수채화풍 (감성·계절)" },
  { value: "manhwa", label: "만화풍 (향수·음식)" },
  { value: "ink_wash", label: "수묵화풍 (전통·사색)" },
  { value: "retro_poster", label: "레트로 포스터 (이벤트·복고)" },
];

// 선택한 스타일은 localStorage 에 기억 — 탭 이동·새로고침에도 풀리지 않고 계속 그 스타일로 생성
// (사용자 요청 2026-07-22). 제작실·검토탭이 같은 키를 공유해 한 번 고르면 양쪽 모두 유지된다.
const STYLE_KEY = "gepa.cardStyle";

/** 저장된 스타일 → 없거나 무효(프리셋 개편 등)면 'auto'. localStorage 접근 불가(사생활 모드)도 안전. */
export function loadCardStyle(): string {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return v && CARD_STYLE_OPTIONS.some((o) => o.value === v) ? v : "auto";
  } catch { return "auto"; }
}

export function saveCardStyle(v: string): void {
  try { localStorage.setItem(STYLE_KEY, v); } catch { /* 저장 실패 무해 */ }
}
