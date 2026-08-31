// 테마(다크/라이트) — 다크가 기본, 라이트는 옵트인. 선택은 localStorage 에 기억한다.
// 실제 색은 styles/tokens.css 의 :root(다크)와 :root[data-theme="light"] 오버라이드가 담당하고,
// 여기서는 <html data-theme> 속성만 토글한다(index.css 의 var() 301곳이 자동 승계).
export type Theme = "dark" | "light";

const KEY = "studio-theme";

/** 저장된 선택 → 없으면 다크(기본). localStorage 접근 불가(사생활 모드 등)도 안전. */
export function initialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") return t;
  } catch { /* 접근 불가 — 기본값 */ }
  return "dark";
}

/** <html data-theme> 설정 + 선택 저장. 마운트 전(main.tsx)·토글(App) 공용. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* 저장 실패 무해 */ }
}
