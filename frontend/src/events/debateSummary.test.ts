import { describe, it, expect } from "vitest";
import { debateGist, debateSummary } from "./debateSummary";

// org 모드 작업 산출물(토론 아님)은 "라벨: 짧은 판정값" 줄이 많은 구조화 보고서다.
// debateGist 가 "판단:보완"/"구분: …"/"리더십·전략: 충족" 같은 라벨 조각을 카드
// headline/결론으로 오인하지 않아야 한다(버그: "권하경 과장은 판단:보완"으로 표시됨).
// 동시에 기존 토론 요약 우선순위(verdict blockquote, [갱신된 결론] 마커, ## 섹션 헤더,
// "반론: 예상매출 242억 왜곡"처럼 콜론 뒤 내용이 충분한 경우)는 회귀 없이 유효해야 한다.

// 라벨 조각인지 — "판단:보완"/"보완"/"충족"/"구분" 등 한두 어절 판정 라벨만 남은 경우.
function isLabelFragment(s: string): boolean {
  const t = s.replace(/\s+/g, "").replace(/[：:]/g, ":");
  // 정확히 판정어 한 단어이거나 "라벨:판정어"(콜론 뒤 1어절) 꼴.
  if (/^(?:보완|충족|미충족|미흡|적정|부적정|유보|판단|판정|구분)$/.test(t)) return true;
  if (/^[가-힣A-Za-z·/]{1,8}:(?:보완|충족|미충족|미흡|적정|부적정|유보)$/.test(t)) return true;
  return false;
}

describe("debateSummary — org 산출물의 라벨 조각을 결론으로 오인하지 않음", () => {
  it("'라벨: 짧은 판정값'만 있는 보고서(헤더 없음) → headline 이 '판단:보완' 류 라벨 조각이 아님", () => {
    const report = [
      "구분: 전략/용역계약 검토",
      "결과: 계약 조건 적정성 검토 완료, 일부 보완 필요",
      "",
      "[경영평가 연계 판정]",
      "- 경영성과: 보완",
      "- 리더십·전략: 충족",
      "- 재정건전성: 충족",
      "",
      "판단: 보완",
    ].join("\n");

    const gist = debateGist(report, "권하경 과장");
    expect(isLabelFragment(gist.headline)).toBe(false);
    // 구체적으로 보고된 깨진 출력("판단: 보완")이 그대로 나오지 않아야 한다.
    expect(gist.headline.replace(/\s+/g, "")).not.toBe("판단:보완");
    expect(gist.headline.replace(/\s+/g, "")).not.toBe("보완");
  });

  it("'## 구분: …' 라벨 헤더 → headline 이 라벨 조각/판정값이 아님", () => {
    const report = [
      "## 구분: 전략/용역계약 검토",
      "",
      "[경영평가 연계 판정]",
      "- 경영성과: 보완",
      "- 리더십·전략: 충족",
    ].join("\n");

    const gist = debateGist(report);
    expect(isLabelFragment(gist.headline)).toBe(false);
    expect(gist.detail.replace(/\s+/g, "")).not.toBe("리더십·전략:충족");
    expect(isLabelFragment(gist.detail)).toBe(false);
  });

  it("'[경영평가 연계 판정]' + 라벨 불릿만 → headline 이 '보완'/'충족' 라벨 조각이 아님", () => {
    const input = [
      "[경영평가 연계 판정]",
      "- 경영성과: 보완",
      "- 리더십: 충족",
    ].join("\n");

    const gist = debateGist(input);
    expect(isLabelFragment(gist.headline)).toBe(false);
  });
});

describe("debateSummary — 토론 결론 회귀 가드", () => {
  it("verdict blockquote(> **조건부 가능** — …) 결론이 그대로 추출됨", () => {
    const text = "이제 검토를 진행합니다.\n\n> **조건부 가능** — 예산 범위 내에서 추진 가능";
    expect(debateSummary(text)).toBe("조건부 가능 — 예산 범위 내에서 추진 가능");
  });

  it("라벨형 verdict blockquote(> **판정**: **조건부 가능** — …) 도 유효", () => {
    const text = "> **판정**: **조건부 가능** — 예산 범위 내";
    expect(debateSummary(text)).toBe("조건부 가능 — 예산 범위 내");
  });

  it("'반론: 예상매출 242억 왜곡'처럼 콜론 뒤 내용이 충분하면 그대로 유효(라벨 오인 X)", () => {
    const text = "## 박정민 과장에게 — 반론\n반론: 예상매출 242억 왜곡, 근거 자료 부재";
    expect(debateSummary(text)).toContain("예상매출 242억 왜곡");
    expect(debateGist(text).headline).toContain("예상매출 242억 왜곡");
  });

  it("## 섹션 헤더(핵심 입장) 다음의 결론 prose 가 추출됨", () => {
    const text = "## 핵심 입장\n예산 242억은 과대 추정이며 보수적으로 재산정해야 합니다.";
    expect(debateSummary(text)).toBe("예산 242억은 과대 추정이며 보수적으로 재산정해야 합니다.");
  });

  it("[갱신된 결론] 마커 다음의 결론이 추출됨", () => {
    const text = "[갱신된 결론]\n채택 권고 — 리스크는 분할 발주로 흡수 가능합니다.";
    expect(debateSummary(text)).toBe("채택 권고 — 리스크는 분할 발주로 흡수 가능합니다.");
  });

  it("구조 라벨 키라도 값이 짧은 실질 내용이면('전략: 시장 선점') 드롭하지 않고 보존", () => {
    // 길이 기반 과매칭(LABEL_KEY + 짧은 값을 무조건 라벨로 드롭) 제거 회귀 가드 —
    // 판정어(보완/충족…)가 아닌 짧은 punchline 은 실질 결론이므로 살아남아야 한다.
    expect(debateSummary("전략: 시장 선점")).toContain("시장 선점");
    expect(debateSummary("인사: 팀 개편")).toContain("팀 개편");
    expect(debateSummary("재무: 적자")).toContain("적자");
  });

  it("'## 전략: 시장 선점' 라벨 키 헤더라도 값이 실질이면 headline 으로 보존", () => {
    const gist = debateGist("## 전략: 시장 선점\n시장 선점을 위한 선제 투자가 필요합니다.");
    expect(gist.headline).toContain("시장 선점");
  });
});
