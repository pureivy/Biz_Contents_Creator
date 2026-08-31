// useStageWidths — 사무실 3패널 레이아웃(타임라인 | 사무실 | 산출물)의 좌/우 패널
// 폭을 드래그로 조절하는 훅. 폭은 localStorage에 영속(새로고침 후 유지), 핸들
// 더블클릭 = 기본 폭 복원. 중앙(stage-main)은 1fr 로 남은 폭을 차지한다.
import { useEffect, useRef, useState } from "react";

export const STAGE_DEFAULTS = { left: 300, right: 360 };
// 패널이 못 쓰게 좁아지거나 중앙을 짓누르지 않게 클램프.
const MIN = { left: 200, right: 240 };
const MAX = { left: 560, right: 680 };
const LS_KEY = "studio-stage-widths";
const LS_OUT = "studio-outputs-open";

type Side = "left" | "right";
type Widths = { left: number; right: number };

function load(): Widths {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
    return {
      left: clamp("left", Number(saved.left) || STAGE_DEFAULTS.left),
      right: clamp("right", Number(saved.right) || STAGE_DEFAULTS.right),
    };
  } catch {
    return { ...STAGE_DEFAULTS };
  }
}

function clamp(side: Side, v: number): number {
  return Math.round(Math.min(MAX[side], Math.max(MIN[side], v)));
}

export function useStageWidths() {
  const [w, setW] = useState<Widths>(load);
  const wRef = useRef(w);
  useEffect(() => { wRef.current = w; }, [w]);

  const persist = () => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(wRef.current)); } catch { /* 영속 실패는 무해 */ }
  };

  // 핸들 mousedown → window 단위 mousemove/mouseup 으로 드래그 추적(핸들 밖으로
  // 빠르게 끌어도 안 끊김). 드래그 중 텍스트 선택/커서 깜빡임 방지.
  const startDrag = (side: Side) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wRef.current[side];
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const v = clamp(side, side === "left" ? startW + dx : startW - dx);
      setW((p) => (p[side] === v ? p : { ...p, [side]: v }));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      persist();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const reset = (side: Side) => {
    setW((p) => ({ ...p, [side]: STAGE_DEFAULTS[side] }));
    // setState 직후 ref 가 아직 옛값일 수 있어 다음 틱에 저장.
    window.setTimeout(persist, 0);
  };

  // 산출물 창 보임/숨김 — 별도 localStorage 키로 영속(닫아둔 상태가 새로고침 후에도 유지).
  const [outputsOpen, setOutputsOpenRaw] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_OUT) !== "0"; } catch { return true; }
  });
  const setOutputsOpen = (v: boolean) => {
    setOutputsOpenRaw(v);
    try { localStorage.setItem(LS_OUT, v ? "1" : "0"); } catch { /* 무해 */ }
  };

  return { widths: w, startDrag, reset, outputsOpen, setOutputsOpen };
}
