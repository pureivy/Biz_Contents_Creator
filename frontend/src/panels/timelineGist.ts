// 토론 발언 본문 → 한 줄 요지. 첫 heading(#…) 또는 첫 의미있는 줄을 마크다운 기호를
// 떼고 max자로 자른다. 순수 텍스트(LLM·비용 없음). 빈 본문 → "".
export function oneLineGist(text: string, max = 40): string {
  const t = (text || "").trim();
  if (!t) return "";
  for (const raw of t.split("\n")) {
    const trimmed = raw.trim();
    // 빈 줄·수평선(---, ***, ___, ===)은 건너뜀. 불릿 제거보다 먼저 검사해야
    // '---'가 불릿 1개 제거로 '--'(<3자)가 돼 수평선 가드를 빠져나가지 않는다.
    if (!trimmed || /^[-=_*]{3,}$/.test(trimmed)) continue;
    const line = trimmed.replace(/^#+\s*/, "").replace(/^[-*>•]\s*/, "").trim();
    const clean = line.replace(/[*`#>]/g, "").trim();
    if (!clean) continue;
    return clean.length > max ? clean.slice(0, max) + "…" : clean;
  }
  return "";
}

// 스트리밍 텍스트에서 의미있는 줄을 최대 n개 뽑는다(프리앰블·마크다운/수평선 잡음 정리,
// 각 max자 truncate). LiveNowStrip '지금 작업 중' 2줄 현황에서 detail이 빈 스트림의
// 2번째 줄을 채우는 데 사용 — 항상 '무슨 일을 하는지' 2줄을 substantive하게 보장.
export function gistLines(text: string, n = 2, max = 60): string[] {
  const out: string[] = [];
  for (const raw of (text || "").split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || /^[-=_*]{3,}$/.test(trimmed)) continue;
    const line = trimmed.replace(/^#+\s*/, "").replace(/^[-*>•]\s*/, "").trim();
    const clean = line.replace(/[*`#>]/g, "").trim();
    if (!clean || clean.replace(/[^가-힣A-Za-z0-9]/g, "").length < 3) continue;
    out.push(clean.length > max ? clean.slice(0, max) + "…" : clean);
    if (out.length >= n) break;
  }
  return out;
}
