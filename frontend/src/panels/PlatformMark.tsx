// 플랫폼 마크 — 성과·발행 화면의 채널 링크 배지에 쓰는 인라인 SVG.
// 이모지(📸📘▶)는 OS·브라우저마다 모양과 폭이 달라 표에서 열이 흔들리고 채널 식별도 약했다.
// 외부 요청 없이(오프라인·CSP 안전) 각 브랜드의 식별 요소(형태 + 브랜드 색)를 직접 그린다.
// 크기는 배지(25×22px) 안에서 도형이 같은 시각 무게를 갖도록 통일.

export type Platform = "naver" | "youtube" | "instagram" | "facebook";

const LABEL: Record<Platform, string> = {
  naver: "네이버 블로그",
  youtube: "유튜브",
  instagram: "인스타그램",
  facebook: "페이스북",
};

/**
 * 채널 마크. mono=true 면 브랜드 색을 버리고 currentColor 로 그린다(미게시 배지처럼 흐리게 쓸 때 —
 * 브랜드 색을 흐리게 하면 '색이 바랜 로고'로 보여 오히려 지저분하다).
 */
export default function PlatformMark({ name, size = 14, mono = false }: { name: Platform; size?: number; mono?: boolean }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", role: "img" as const, "aria-label": LABEL[name] };
  const fg = mono ? "currentColor" : undefined;

  if (name === "naver") {
    // 네이버 — 초록 사각형 + 흰 N(왼쪽 세로·대각·오른쪽 세로).
    return (
      <svg {...common}>
        <rect x="2" y="2" width="20" height="20" rx="4" fill={fg ?? "#03C75A"} />
        <path d="M8 7.5v9h2.6v-4.4l2.8 4.4H16v-9h-2.6v4.4L10.6 7.5H8z" fill={mono ? "var(--panel)" : "#fff"} />
      </svg>
    );
  }
  if (name === "youtube") {
    // 유튜브 — 가로로 긴 빨강 라운드 사각형 + 흰 재생 삼각형.
    return (
      <svg {...common}>
        <rect x="1.5" y="5" width="21" height="14" rx="4" fill={fg ?? "#FF0000"} />
        <path d="M10 9.2l5.4 2.8L10 14.8V9.2z" fill={mono ? "var(--panel)" : "#fff"} />
      </svg>
    );
  }
  if (name === "instagram") {
    // 인스타그램 — 라운드 사각형 외곽선 + 렌즈 원 + 우상단 점. 공식 마크는 그라디언트라 그대로 재현.
    const stroke = fg ?? "url(#igGrad)";
    return (
      <svg {...common}>
        {!mono && (
          <defs>
            <linearGradient id="igGrad" x1="0" y1="24" x2="24" y2="0">
              <stop offset="0%" stopColor="#FFD521" />
              <stop offset="35%" stopColor="#F50000" />
              <stop offset="70%" stopColor="#B900B4" />
              <stop offset="100%" stopColor="#4C68D7" />
            </linearGradient>
          </defs>
        )}
        <rect x="3" y="3" width="18" height="18" rx="5.4" fill="none" stroke={stroke} strokeWidth="2.1" />
        <circle cx="12" cy="12" r="4.1" fill="none" stroke={stroke} strokeWidth="2.1" />
        <circle cx="17.2" cy="6.9" r="1.25" fill={stroke} />
      </svg>
    );
  }
  // 페이스북 — 파란 원 + 흰 f.
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="10" fill={fg ?? "#1877F2"} />
      <path d="M14.6 12.3h-1.9V19h-2.6v-6.7H8.6v-2.2h1.5V8.8c0-1.7 1-2.8 2.9-2.8h1.7v2.2h-1.1c-.6 0-.9.3-.9.9v1h2.1l-.2 2.2z"
        fill={mono ? "var(--panel)" : "#fff"} />
    </svg>
  );
}
