import { useState } from "react";
import SlideLightbox from "./SlideLightbox";
import { slideUrl } from "./slideNav";

// 카드뉴스 슬라이드 썸네일 그리드 — 제작실(CardNewsView)·검토대기(DraftReview) 공용.
// 클릭하면 새 탭이 아니라 전체화면 뷰어가 열려 ←/→ 로 넘겨본다. 클릭 배선이 여기 한 곳뿐이라
// 두 탭이 저절로 같은 동작을 갖는다. compact 는 검토탭의 작은 썸네일 크기.
export default function SlideStrip({ cardId, slides: n, title, version, compact = false }: {
  cardId: string; slides: number; title?: string; version?: string; compact?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!n) return null;
  const min = compact ? 84 : 120, gap = compact ? 6 : 8, radius = compact ? 6 : 8;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap, marginTop: compact ? 0 : 8 }}>
        {Array.from({ length: n }, (_, k) => (
          <button key={k} className="slide-thumb" onClick={() => setOpen(k)} title={`${k + 1}번째 슬라이드 크게 보기`}>
            <img src={slideUrl(cardId, k, version)} alt={`${title ?? "카드뉴스"} ${k + 1}번째 슬라이드`}
              loading="lazy" style={{ borderRadius: radius }} />
          </button>
        ))}
      </div>
      {open !== null && (
        <SlideLightbox target={{ cardId, slides: n, index: open, title, version }}
          onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
