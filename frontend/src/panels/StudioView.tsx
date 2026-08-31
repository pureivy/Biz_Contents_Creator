import { useState } from "react";
import CardNewsSection from "./CardNewsView";
import ShortsSection from "./ShortsView";
import Ico from "./Ico";

// 제작실 — 카드뉴스·숏폼 탭 통합(사용자 확정: 탭 과밀 해소). 독립 주제 생성 입구 + 전체 보관함.
// 블로그 파생물의 세트 검토는 검토 탭이 담당하고, 여기는 블로그와 무관한 독립 제작·이력 관리용.
const KINDS = [
  { key: "cardnews", icon: "cards", label: "카드뉴스", desc: "인스타그램용 정사각 슬라이드 — gpt-image-2가 텍스트까지 그리고, 비전 QA가 한글 오타를 검수합니다." },
  { key: "shorts", icon: "play", label: "숏폼", desc: "유튜브 숏폼(세로 MP4) — 대본·씬 이미지는 AI, 내레이션은 TTS, 자막·조립은 코드가 담당합니다." },
] as const;
type Kind = (typeof KINDS)[number]["key"];

export default function StudioView() {
  const [kind, setKind] = useState<Kind>("cardnews");
  const cur = KINDS.find((k) => k.key === kind)!;
  return (
    <div className="apikeys studio-view">
      <div className="apikeys-head">
        <h1>
          <Ico name="pencil" size={17} /> 제작실{" "}
          {KINDS.map((k) => (
            <button key={k.key} className={`btn ghost review-viewtab${kind === k.key ? " on" : ""}`}
              onClick={() => setKind(k.key)}><Ico name={k.icon} size={12} /> {k.label}</button>
          ))}
        </h1>
        <p className="apikeys-sub">
          블로그와 별개의 독립 주제로 만들거나, 전체 산출물을 보관·다운로드합니다
          (블로그 파생물은 검토 탭에서 초안과 세트로도 확인됩니다). {cur.desc} 발행은 없고 다운로드까지만.
        </p>
      </div>
      {/* key 로 섹션 전환 시 상태(폼 입력·폴링) 초기화 — 두 섹션이 같은 폼 구조라 잔상 방지 */}
      {kind === "cardnews" ? <CardNewsSection key="cardnews" /> : <ShortsSection key="shorts" />}
    </div>
  );
}
