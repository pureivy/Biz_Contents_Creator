import { useCallback, useEffect } from "react";
import Ico from "./Ico";
import { canStep, clampIndex, neighborIndexes, slideName, slideUrl, stepIndex } from "./slideNav";

// 카드뉴스 슬라이드 전체화면 뷰어 — 예전엔 새 탭에 PNG 원본을 띄워 넘길 방법이 없었다.
// 오버레이 관례는 .metric-overlay(대시보드 드릴다운)와 동일: fixed inset 0 · 어두운 배경 · ESC 닫기.
export interface SlideTarget {
  cardId: string;
  slides: number;
  index: number;
  title?: string;
  version?: string;
}

export default function SlideLightbox({ target, onIndex, onClose }: {
  target: SlideTarget; onIndex: (i: number) => void; onClose: () => void;
}) {
  const { cardId, slides: n, title, version } = target;
  const i = clampIndex(target.index, n);
  const go = useCallback((dir: 1 | -1) => onIndex(stepIndex(i, n, dir)), [i, n, onIndex]);

  // ←/→ 이동, ESC 닫기 — window 리스너 관례는 WikiGraphView 와 동일.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // 앞뒤 장을 미리 받아둬 넘길 때 흰 화면이 스치지 않게.
  useEffect(() => {
    for (const k of neighborIndexes(i, n)) { const im = new Image(); im.src = slideUrl(cardId, k, version); }
  }, [cardId, i, n, version]);

  if (n <= 0) return null;
  const src = slideUrl(cardId, i, version);
  return (
    <div className="slide-overlay" onClick={onClose} role="dialog" aria-modal="true"
      aria-label={`${title ?? "카드뉴스"} 슬라이드 보기`}>
      {/* 뷰어 안쪽 클릭은 닫지 않는다(넘기는 중 실수로 닫히는 것 방지) */}
      <div className="slide-box" onClick={(e) => e.stopPropagation()}>
        <div className="slide-head">
          {title && <b className="slide-title">{title}</b>}
          <span className="slide-count">{i + 1} / {n}</span>
          <button className="slide-x" onClick={onClose} title="닫기 (ESC)" aria-label="닫기">✕</button>
        </div>
        <div className="slide-stage">
          <button className="slide-arrow" onClick={() => go(-1)} disabled={!canStep(i, n, -1)}
            title="이전 슬라이드 (←)" aria-label="이전 슬라이드">‹</button>
          <img className="slide-img" src={src} alt={`${title ?? "카드뉴스"} ${i + 1}번째 슬라이드`} />
          <button className="slide-arrow" onClick={() => go(1)} disabled={!canStep(i, n, 1)}
            title="다음 슬라이드 (→)" aria-label="다음 슬라이드">›</button>
        </div>
        <div className="slide-foot">
          <div className="slide-dots">
            {Array.from({ length: n }, (_, k) => (
              <button key={k} className={`slide-dot${k === i ? " on" : ""}`} onClick={() => onIndex(k)}
                title={`${k + 1}번째 슬라이드`} aria-label={`${k + 1}번째 슬라이드로 이동`} />
            ))}
          </div>
          {/* 새 탭 열기·저장 — 종전 새 탭 동작으로 하던 일을 잃지 않게 남겨둔다 */}
          <a className="btn ghost" href={src} target="_blank" rel="noreferrer">
            <Ico name="external-link" size={12} /> 원본 열기
          </a>
          <a className="btn ghost" href={src} download={slideName(i)}>이 장 저장</a>
        </div>
      </div>
    </div>
  );
}
