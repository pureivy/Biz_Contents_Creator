// 도구 id → 아이콘+한국어 라벨. tool_used 표시·LiveNow·승인에서 공용.
// 백엔드 emit: wiki_query/web_search/save_note/run_command + 커넥터 law_search/dart_search/custom_search.
// Wanted 원칙(제품 UI 크롬 이모지 금지)에 따라 아이콘은 Ico(IcoName)로 분리한다.
import type { IcoName } from "./Ico";

const TOOL_VISUALS: Record<string, { icon: IcoName; label: string }> = {
  wiki_query: { icon: "search", label: "위키 검색" },
  wiki_ingest: { icon: "pencil", label: "위키 기록" },
  web_search: { icon: "globe", label: "웹 검색" },
  dart: { icon: "chart", label: "DART 공시" },
  law: { icon: "document", label: "법령 검색" },
  custom: { icon: "external-link", label: "외부 데이터" },
  save_note: { icon: "document", label: "노트 저장" },
  run_command: { icon: "setting", label: "셸 실행" },
};

/** 도구명 정규화 — 커넥터 접미사(_search)·네임스페이스(__) 제거. */
function normalize(tool?: string | null): string | null {
  if (!tool) return null;
  const t = tool.includes("__") ? tool.split("__").pop()! : tool;
  return t;
}

/** 도구의 아이콘+라벨. 미지 도구는 setting 아이콘 + raw 이름 폴백. */
export function toolVisual(tool?: string | null): { icon: IcoName; label: string } {
  const t = normalize(tool);
  if (!t) return { icon: "setting", label: "툴 사용" };
  const base = t.replace(/_search$/, ""); // law_search→law, dart_search→dart
  return TOOL_VISUALS[t] || TOOL_VISUALS[base] || { icon: "setting", label: t };
}

/** 텍스트 전용 컨텍스트(title 속성 등)용 라벨. */
export function toolLabel(tool?: string | null): string {
  return toolVisual(tool).label;
}
