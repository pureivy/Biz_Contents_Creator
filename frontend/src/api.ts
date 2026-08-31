import { ApprovalItem, EventEnvelope } from "./events/types";

export interface RunInfo {
  run_id: string;
  topic: string;
  status: string;
  total_cost: number;
  created_ts: string;
  active: boolean;
  /** 자율(백그라운드) 런 여부 — 기록엔 진행 중 자율런만 표출(완료 자율런 제외). */
  auto?: boolean;
  /** 리비전(개정) 런 — 새 글 생성이 아니라 기존 초안을 다듬은 런(자동 SEO 개정 등). 기록에서 원본과 구분 표시. */
  revise?: boolean;
  /** 수정 런 계보(⑤): 부모 런 id + 버전(v2부터 서버가 채움). */
  parent_run_id?: string | null;
  version?: number;
}

// (반복 업무 템플릿 기능 제거됨 — 백엔드 미구현 스텁이었고, 역할은 자율 사이클·캘린더가 대체)

// --- 브랜드(고객사) 프로필 — 스튜디오가 '누구를 위해' 만드는지. 저장 즉시 다음 런부터 주입 ---
export interface BrandProductInfo { name: string; features?: string; target?: string }
export interface BrandInfo {
  name: string;
  industry?: string;
  description?: string;
  products: BrandProductInfo[];
  audience?: string;
  region?: string;
  tone?: string;
  banned?: string[];
  seedKeywords?: string[];
  channel?: string;
  /** 카드뉴스 기본 이미지 스타일(브랜드 고정 — 자동 파생 포함). 미설정=디자이너 자동. */
  cardStyle?: string;
}
export async function fetchBrand(): Promise<BrandInfo | null> {
  try { const r = await fetch("/brand"); if (!r.ok) return null; return (await r.json()).brand ?? null; }
  catch { return null; }
}
export interface BrandListItem { slug: string; name: string; industry?: string }
export async function fetchBrands(): Promise<{ active: string | null; brands: BrandListItem[] }> {
  try { const r = await fetch("/brands"); if (!r.ok) return { active: null, brands: [] }; return await r.json(); }
  catch { return { active: null, brands: [] }; }
}
export async function activateBrand(slug: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/brands/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
/** 카드뉴스 기본 스타일(브랜드 고정) 저장 — 'auto' = 고정 해제(디자이너 자동). */
export async function saveBrandCardStyle(style: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/brand/cardstyle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style }) });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
export async function deleteBrandProfile(slug: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/brands/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
export async function saveBrandProfile(b: BrandInfo): Promise<{ ok: boolean; brand?: BrandInfo; error?: string }> {
  try {
    const r = await fetch("/brand", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({} as { brand?: BrandInfo; error?: string }));
    return r.ok ? { ok: true, brand: j.brand } : { ok: false, error: j.error };
  } catch { return { ok: false, error: "network" }; }
}

/** 산출물 수정 루프(⑤): 끝난 런에 피드백 → CEO 통합만 재실행하는 v{n} 런 시작. */
export async function reviseRun(runId: string, feedback: string):
  Promise<{ run_id: string; version: number }> {
  const r = await fetch(`/runs/${runId}/revise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feedback }),
  });
  if (!r.ok) {
    const text = await r.text();
    let msg = `수정 런 시작 실패 (${r.status})`;
    try { msg = JSON.parse(text).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}

export async function fetchRuns(): Promise<RunInfo[]> {
  try {
    const r = await fetch("/runs");
    if (!r.ok) return [];
    return (await r.json()).runs ?? [];
  } catch {
    return [];
  }
}

export async function fetchRunLog(runId: string): Promise<EventEnvelope[]> {
  const r = await fetch(`/runs/${runId}/log`);
  if (!r.ok) throw new Error(`failed to load run log: ${r.status}`);
  return (await r.json()).events ?? [];
}

// ── External materials (외부 자료): upload docs into the LLM wiki so agents can use them ──
export interface SourceInfo { id: string; title: string; origin: string; by: string; file: string; }

export async function fetchSources(): Promise<SourceInfo[]> {
  try {
    const r = await fetch("/sources");
    if (!r.ok) return [];
    return (await r.json()).sources ?? [];
  } catch {
    return [];
  }
}

// Total stored wiki page count (+ raw source count) for the dashboard 위키 metric.
export interface AutonomyStatus {
  enabled: boolean; interval_minutes: number; shell: boolean; active: boolean;
  /** 오토런 사용자 토글(칩 클릭) — false 면 주기는 살아있지만 틱이 아무 일도 하지 않는다. */
  run_enabled?: boolean;
  /** 진행 중인 자율런 id(있으면) — 유휴 시 오피스뷰 자동 관전용. */
  auto_run_id?: string | null;
  last_auto_ts: string | null; last_auto_topic: string | null;
}
/** 오토런 온/오프 토글 — enabled 생략 시 서버가 반전. */
export async function toggleAutonomy(): Promise<{ ok: boolean; run_enabled?: boolean }> {
  try {
    const r = await fetch("/autonomy/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return r.ok ? await r.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}
export async function fetchAutonomyStatus(): Promise<AutonomyStatus | null> {
  try {
    const r = await fetch("/autonomy/status");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function fetchWikiStats(): Promise<{ pages: number; sources: number; lessons: number }> {
  try {
    const r = await fetch("/wiki/stats");
    if (!r.ok) return { pages: 0, sources: 0, lessons: 0 };
    const d = await r.json();
    return { pages: d.pages ?? 0, sources: d.sources ?? 0, lessons: d.lessons ?? 0 };
  } catch {
    return { pages: 0, sources: 0, lessons: 0 };
  }
}

// 런타임 품질 설정(토론·추론) — 서버 재시작 없이 토글, 다음 런부터 반영.
export interface RunSettings { orgDebateRounds: number; agentThinking: boolean }
const DEFAULT_RUN_SETTINGS: RunSettings = { orgDebateRounds: 0, agentThinking: false };
export async function fetchRunSettings(): Promise<RunSettings> {
  try {
    const r = await fetch("/runsettings");
    return r.ok ? await r.json() : DEFAULT_RUN_SETTINGS;
  } catch {
    return DEFAULT_RUN_SETTINGS;
  }
}
export async function updateRunSettings(patch: Partial<RunSettings>): Promise<RunSettings> {
  try {
    const r = await fetch("/runsettings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return r.ok ? await r.json() : fetchRunSettings();
  } catch {
    return fetchRunSettings();
  }
}

// ── API 키 통합 관리 (프로젝트 .env 단일 저장) ──
export interface ApiKeyInfo {
  key: string; label: string; icon: string; desc: string;
  placeholder: string; needs_restart: boolean; set: boolean; masked: string; builtin: boolean;
  brand?: string; // 커스텀 키의 소속 브랜드 슬러그('' = 공용). 내장 키는 앱 공용이라 없음.
}
export interface HiddenKeyInfo { key: string; label: string; icon: string }
export interface ApiKeysResp {
  keys: ApiKeyInfo[]; hidden: HiddenKeyInfo[];
  brands: { slug: string; name: string }[];
  activeBrand: string | null; // null = 조회 실패(브랜드 선택 초기화를 미루라는 뜻)
}
export async function fetchApiKeys(): Promise<ApiKeyInfo[]> {
  try {
    const r = await fetch("/api-keys");
    if (!r.ok) return [];
    return (await r.json()).keys ?? [];
  } catch {
    return [];
  }
}
// 보이는 키 + 숨긴 기본 키(복원 UI 용) + 브랜드 목록·활성 브랜드 함께 조회 — ApiKeysView 전용.
export async function fetchApiKeysAll(): Promise<ApiKeysResp> {
  const empty: ApiKeysResp = { keys: [], hidden: [], brands: [{ slug: "", name: "공용 (기본)" }], activeBrand: null };
  try {
    const r = await fetch("/api-keys");
    if (!r.ok) return empty;
    const j = await r.json();
    return {
      keys: j.keys ?? [], hidden: j.hidden ?? [],
      brands: j.brands ?? empty.brands, activeBrand: j.activeBrand ?? "",
    };
  } catch {
    return empty;
  }
}
export async function saveApiKey(
  key: string, value: string,
): Promise<{ ok: boolean; error?: string; needs_restart?: boolean }> {
  try {
    const r = await fetch("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}
export async function addApiKey(
  key: string, label: string, desc: string, value: string, brand = "",
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api-keys/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, label, desc, value, brand }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}
export async function deleteApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api-keys/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}
// 숨긴 기본 키 복원 — 카드가 '미설정' 상태로 다시 나타난다.
export async function restoreApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api-keys/${encodeURIComponent(key)}/restore`, { method: "POST" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}

// ── 네이버 발행 계정(브랜드별) — 전용 섹션에서 브랜드 선택 후 blogId/로그인 편집 ──
export interface NaverAccountView { blogId: string; loginIdSet: boolean; loginIdMasked: string; loginPwSet: boolean }
export interface NaverAccountsResp { brands: { slug: string; name: string }[]; accounts: Record<string, NaverAccountView> }
export async function fetchNaverAccounts(): Promise<NaverAccountsResp> {
  try {
    const r = await fetch("/api-keys/naver");
    if (!r.ok) return { brands: [{ slug: "", name: "범용 (기본)" }], accounts: {} };
    return await r.json();
  } catch {
    return { brands: [{ slug: "", name: "범용 (기본)" }], accounts: {} };
  }
}
export async function saveNaverAccount(
  brand: string, patch: { blogId?: string; loginId?: string; loginPw?: string },
): Promise<{ ok: boolean; error?: string; account?: NaverAccountView }> {
  try {
    const r = await fetch("/api-keys/naver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand, ...patch }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}

// status: ok | duplicate | unsupported | failed | too-large (백엔드) / network | filtered (프론트)
// ref = raw/ 원자료 참조(저장 증거), page_id = wiki/ reference 페이지 id(적재 증거).
export interface UploadFileResult {
  file: string; title?: string; status: string; note?: string;
  assigned?: string[]; ref?: string | null; page_id?: string | null;
}
export interface UploadResult { ok: number; total: number; results: UploadFileResult[]; }

// 분류(직원 귀속)는 업로드 응답 후 백그라운드 진행 — 정산 패널이 ref들로 폴링한다.
// null = 엔드포인트 없음/오류(예: 서버가 구버전·재시작 전) → 패널은 "확인 불가"로 표시.
export interface IngestStatus { state: "pending" | "done" | "failed"; entities: string[]; }
export interface ClassifyStatus { state: "pending" | "done" | "failed" | "unknown"; assigned: string[]; ingest?: IngestStatus; }
export async function fetchClassifyStatus(refs: string[]): Promise<Record<string, ClassifyStatus> | null> {
  try {
    const r = await fetch("/sources/classify_status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refs }),
    });
    if (!r.ok) return null;
    return (await r.json()).statuses ?? null;
  } catch {
    return null;
  }
}

// --- 단계별 ETA(과거 런 중앙값) ------------------------------------------------
export interface EtaStats {
  sample: number;
  stages: Record<string, number>;   // 단계명 → 중앙값(초)
  total_sec: number | null;
  cost_usd: number | null;
}
export async function fetchEta(): Promise<EtaStats | null> {
  try {
    const r = await fetch("/runs/eta");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** 자료 오귀속 교정: ref 를 지정 직원에게 재귀속(기존 귀속 전부 제거). */
export async function reassignSource(ref: string, to: string):
  Promise<{ assigned_label: string } | null> {
  try {
    const r = await fetch("/sources/reassign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, to }),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** 실패한 분류(직원 귀속)의 수동 재시도. 성공 시 재시도에 들어간 건수, 실패 시 null. */
export async function retryClassify(refs: string[]): Promise<number | null> {
  try {
    const r = await fetch("/sources/classify_retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refs }),
    });
    if (!r.ok) return null;
    return (await r.json()).retrying ?? 0;
  } catch {
    return null;
  }
}

// --- 컴포저 첨부(멀티모달: 이미지 + 문서) --------------------------------------
// 파일을 서버에 저장하고 경로를 받는다 — startRun opts.images/docs 로 전달되어
// 런 시작 시 이미지는 비전 분석, 문서는 텍스트 추출 블록으로 주제에 합류한다.
export interface SkippedAttachment { file: string; reason: string }
export async function uploadRunAttachments(
  files: File[],
): Promise<{ ok: boolean; images: string[]; docs: string[]; skipped: SkippedAttachment[]; error?: string }> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  try {
    const r = await fetch("/runs/attachments", { method: "POST", body: fd });
    const j = (await r.json().catch(() => ({}))) as { images?: string[]; docs?: string[]; skipped?: SkippedAttachment[]; error?: string };
    if (!r.ok) return { ok: false, images: [], docs: [], skipped: j.skipped ?? [], error: j.error };
    // skipped: 서버가 용량·형식·개수 상한으로 제외한 파일 — 호출부가 사용자에게 고지하고 계속 여부를 묻는다.
    return { ok: true, images: j.images ?? [], docs: j.docs ?? [], skipped: j.skipped ?? [] };
  } catch {
    return { ok: false, images: [], docs: [], skipped: [], error: "network" };
  }
}

// --- 블로그 작가 말투(페르소나) -------------------------------------------------
export interface PersonaOpt { id: string; label: string; desc: string }
// 서버가 단일 소스 — 목록(id/label/desc)만 받아 드롭다운에 표시(프롬프트 본문은 서버 전용).
export async function fetchPersonas(): Promise<PersonaOpt[]> {
  try {
    const r = await fetch("/personas");
    if (!r.ok) return [];
    const j = (await r.json()) as { personas?: PersonaOpt[] };
    return j.personas ?? [];
  } catch {
    return [];
  }
}

// --- MCP 서버 관리 -----------------------------------------------------------
export interface McpServer {
  id: string; name: string; icon: string; kind: string; desc: string;
  tools: string[]; enabled: boolean; toggleable: boolean; used_by: string[];
  transport?: string; needs_restart?: boolean;
}
export async function fetchMcp(): Promise<McpServer[]> {
  try {
    const r = await fetch("/mcp");
    if (!r.ok) return [];
    return (await r.json()).servers ?? [];
  } catch {
    return [];
  }
}
export async function toggleMcp(
  id: string, enabled: boolean,
): Promise<{ ok: boolean; error?: string; servers?: McpServer[] }> {
  try {
    const r = await fetch(`/mcp/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}

// ── 외부 API 커넥터(선언형/AI 자동설정) ──
export interface ConnectorCfg {
  id: string; keyName: string; label: string; icon: string; desc: string;
  endpoint: string; method?: string; blockLabel: string; scope: string | string[];
  extract: { type: string; itemsPath?: string; fields?: string[]; regex?: string; max?: number; limit?: number };
}
export async function listConnectors(): Promise<ConnectorCfg[]> {
  try { const r = await fetch("/connectors"); return (await r.json()).connectors ?? []; } catch { return []; }
}
export interface DocResult { title: string; url: string; snippet: string }
export async function searchDocs(apiName: string): Promise<{ ok: boolean; results?: DocResult[]; error?: string }> {
  try {
    const r = await fetch("/connectors/searchdocs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiName }) });
    return await r.json();
  } catch { return { ok: false, error: "network" }; }
}
export async function autoconfigConnector(keyName: string, apiName: string, docsUrl: string): Promise<{ ok: boolean; cfg?: ConnectorCfg; error?: string }> {
  try {
    const r = await fetch("/connectors/autoconfig", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyName, apiName, docsUrl }) });
    return await r.json();
  } catch { return { ok: false, error: "network" }; }
}
export async function testConnector(cfg: ConnectorCfg, query: string): Promise<{ ok: boolean; preview?: string; empty?: boolean; note?: string; error?: string }> {
  try {
    const r = await fetch("/connectors/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cfg, query }) });
    return await r.json();
  } catch { return { ok: false, error: "network" }; }
}
export async function saveConnector(cfg: ConnectorCfg): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
    return await r.json();
  } catch { return { ok: false, error: "network" }; }
}
export async function deleteConnector(id: string): Promise<{ ok: boolean }> {
  try { const r = await fetch(`/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }); return await r.json(); } catch { return { ok: false }; }
}

// --- "제2의 두뇌" wiki graph -------------------------------------------------
export type WikiNodeType = "page" | "tag" | "source" | "agent";
export interface WikiGraphNode {
  id: string;
  type: WikiNodeType;
  label: string;
  // page-only
  slug?: string;
  category?: string;
  stance?: string;
  status?: string;
  confidence?: string;
  tags?: string[];
  contributors?: string[];
  source_count?: number;
  degree?: number;
  contested?: boolean;
  stale?: boolean;
  summary?: string;
  updated_ts?: string;
  // tag-only
  count?: number;
  // source-only
  origin?: string;
  by?: string;
}
export type WikiLinkKind =
  | "relates" | "rebuts" | "cites" | "supersedes" | "supports" | "refines"
  | "tag" | "source" | "author";
export interface WikiGraphLink { source: string; target: string; kind: WikiLinkKind; }
export interface WikiGraph {
  nodes: WikiGraphNode[];
  links: WikiGraphLink[];
  stats: { pages: number; tags: number; sources: number; agents: number; links: number };
}
export interface WikiPageDetail {
  id: string; slug: string; title: string; category: string; status: string;
  stance: string; confidence: string; tags: string[]; aliases: string[];
  contributors: string[]; sources: string[]; body: string;
  created_ts: string; updated_ts: string;
  related: { relation: string; direction: "in" | "out"; other_id: string; other_title: string }[];
}

export async function fetchWikiGraph(): Promise<WikiGraph> {
  const r = await fetch("/wiki/graph");
  if (!r.ok) throw new Error(`위키 그래프 로드 실패: ${r.status}`);
  return await r.json();
}

export async function fetchWikiPage(id: string): Promise<WikiPageDetail | null> {
  try {
    const r = await fetch(`/wiki/page/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export interface WikiPageRow {
  id: string; title: string; category: string; status: string; stance: string;
  contributors: string[]; tags: string[]; source_count: number; updated_ts: string; summary: string;
}
export interface WikiPagesResult {
  pages: WikiPageRow[]; counts: Record<string, number>; total_pages: number;
}

export async function fetchWikiPages(category = "", limit = 300): Promise<WikiPagesResult> {
  try {
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    qs.set("limit", String(limit));
    const r = await fetch(`/wiki/pages?${qs.toString()}`);
    if (!r.ok) return { pages: [], counts: {}, total_pages: 0 };
    return await r.json();
  } catch {
    return { pages: [], counts: {}, total_pages: 0 };
  }
}

export async function uploadSources(
  files: FileList | File[],
  timeoutMs = 120_000,
): Promise<UploadResult> {
  const fd = new FormData();
  for (const f of Array.from(files)) fd.append("files", f);
  // A heavy batch can keep the server busy for a while; abort (→ retry by caller) only
  // after a generous timeout so a genuinely stuck request can't hang the whole upload.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("/sources", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(`업로드 실패: ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// send a direct instruction to a running run (the timeline chat)
export async function sendMessage(runId: string, text: string): Promise<boolean> {
  try {
    const r = await fetch(`/runs/${runId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// delete a run from history (cancels it first if still active)
export async function deleteRun(runId: string): Promise<boolean> {
  try {
    const r = await fetch(`/runs/${runId}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// --- employee directory (independent of any run) ---
export interface RoleInfo {
  id: string;
  title: string;       // 직무(안정적 정체성)
  name?: string;       // 현 담당자 실명(교체 가능)
  level: string;
  team: string | null;
  tools: string[];
  skills: string[];
  model: string;
  stance: string;
  is_critic: boolean;
  autonomy: number;
}
export interface CompanyInfo {
  name: string;
  ceo: RoleInfo;
  teams: { id: string; name: string; lead: RoleInfo; members: RoleInfo[] }[];
}
export interface AgentProfile extends RoleInfo {
  system_prompt: string;
  skills_loaded: string[];
  autonomy_effective: number;
  goal: string;
  memory: string;
  verified: string;
  injected: string;
  tools_md: string;
  activity_tail: string[];
  usage_pages: { page_id: string; title: string }[];
}

// --- 직원 편집: 팀/역할 구조 CRUD ---
async function jsonReq(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: any }> {
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, ...data };
  } catch {
    return { ok: false, error: "network" };
  }
}
export const addTeam = (name: string) => jsonReq("/company/teams", "POST", { name });
export const renameTeam = (tid: string, name: string) => jsonReq(`/company/teams/${tid}`, "PATCH", { name });
export const deleteTeam = (tid: string) => jsonReq(`/company/teams/${tid}`, "DELETE");
export const addMember = (tid: string, body: { title: string; system_prompt?: string; model?: string; stance?: string; is_critic?: boolean; tools?: string[] }) =>
  jsonReq(`/company/teams/${tid}/members`, "POST", body);
export const patchRole = (rid: string, body: { title?: string; system_prompt?: string; model?: string; stance?: string; is_critic?: boolean; tools?: string[] }) =>
  jsonReq(`/company/roles/${rid}`, "PATCH", body);
export const deleteRole = (rid: string) => jsonReq(`/company/roles/${rid}`, "DELETE");
export async function fetchCompany(): Promise<CompanyInfo | null> {
  try {
    const r = await fetch("/company");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export async function fetchAgent(id: string): Promise<AgentProfile | null> {
  try {
    const r = await fetch(`/agents/${id}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// edit an employee's goal/tools/autonomy
export async function patchAgent(
  id: string,
  body: { goal?: string; tools?: string[]; autonomy?: number },
): Promise<boolean> {
  try {
    const r = await fetch(`/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}
export async function addSkill(id: string, name: string, content: string): Promise<boolean> {
  try {
    const r = await fetch(`/agents/${id}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
export async function deleteSkill(id: string, skill: string): Promise<boolean> {
  try {
    const r = await fetch(`/agents/${id}/skills/${encodeURIComponent(skill)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// employee workspace graft: globally-pending approvals (incl. run-end tool-grant
// recommendations). Hydrates the banner on mount/refresh — not only from live SSE,
// so a recommendation queued at a past run's end is still actionable later.
// Backend item uses `id`; map it to the frontend `approval_id` shape.
export async function fetchApprovals(): Promise<ApprovalItem[]> {
  try {
    const r = await fetch("/approvals");
    if (!r.ok) return [];
    const data = await r.json();
    const pending = Array.isArray(data?.pending) ? data.pending : [];
    return pending.map(
      (p: Record<string, unknown>): ApprovalItem => ({
        approval_id: String(p.id ?? p.approval_id ?? ""),
        agent_id: (p.agent_id as string | null) ?? null,
        action_type: String(p.action_type ?? "action"),
        summary: String(p.summary ?? ""),
        autonomy: typeof p.autonomy === "number" ? p.autonomy : undefined,
        status: "pending",
      }),
    );
  } catch {
    return [];
  }
}

// employee workspace graft: decide a pending approval (wakes a blocked run)
export async function decideApproval(
  approvalId: string,
  approved: boolean,
  note = "",
): Promise<boolean> {
  try {
    const r = await fetch(`/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved, note }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// --- 음성 입출력 ---
export async function getVoices(): Promise<{ available: boolean; sttAvailable: boolean; ttsAvailable: boolean; voices: string[]; defaultVoice: string; conversational: boolean }> {
  try {
    const r = await fetch("/voice/voices");
    if (!r.ok) return { available: false, sttAvailable: false, ttsAvailable: false, voices: [], defaultVoice: "Yuna", conversational: false };
    return await r.json();
  } catch { return { available: false, sttAvailable: false, ttsAvailable: false, voices: [], defaultVoice: "Yuna", conversational: false }; }
}

// --- 자비스 채팅 ---
export async function postJarvisChat(
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<{ reply: string; delegate?: { task: string; agent?: string } }> {
  const r = await fetch('/jarvis/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `자비스 응답 실패 (${r.status})`);
  return await r.json();
}

export async function setVoiceConversational(on: boolean): Promise<boolean> {
  try {
    const r = await fetch('/voice/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversational: on }),
    });
    return r.ok ? (await r.json()).conversational ?? on : on;
  } catch { return on; }
}

/** 녹음 Blob 업로드 → 전사 텍스트. 실패 시 빈 문자열. */
export async function sttUpload(blob: Blob, timeoutMs = 60_000): Promise<string> {
  const fd = new FormData();
  fd.append("files", blob, "speech.webm");        // 필드명 'files' = 서버 parseBody 기대값
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("/voice/stt", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) return "";
    return ((await r.json()).text ?? "").trim();
  } catch { return ""; }
  finally { clearTimeout(timer); }
}

/** 텍스트 → 오디오 Blob(mp3). 실패 시 null. */
export async function ttsFetch(text: string, voice?: string): Promise<Blob | null> {
  try {
    const r = await fetch("/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!r.ok) return null;
    return await r.blob();
  } catch { return null; }
}

// (HWPX 내보내기 제거 — 콘텐츠 스튜디오는 최종 산출물을 한글 문서로 변환하지 않는다.)


// ============================================================
// 콘텐츠 piece — 완전 자율 캘린더/초안검토(크로스-런, REST 폴링. store/fold 금지 — 스크럽 시 수치 변형 방지).
// ============================================================
export type PieceStage =
  | "idea" | "research" | "draft" | "ready" | "published" | "measured" | "reflected" | "error";
/** 파생 콘텐츠 요약(카드뉴스·숏폼) — 콘텐츠 세트 상태를 캘린더 배지·검토 미리보기·성과 컬럼에 표시. */
export interface DerivedSummary {
  cardnews?: { id: string; stage: string; slides?: number; running: boolean };
  shorts?: { id: string; stage: string; durationSec?: number; running: boolean };
}
export interface PieceInfo {
  id: string;
  runId?: string;
  title: string;
  keyword?: string;
  subNiche?: string;
  stage: PieceStage;
  publishedUrl?: string;
  publishedTs?: string; // 발행 시각 — 검토 탭 발행 이후 그룹의 안정 정렬 축(서버는 늘 내려주고 있었음)
  naverDraftUrl?: string;
  naverDraftTs?: string;
  seoScore?: number;
  errors?: number;
  derived?: DerivedSummary;
  createdTs: string;
  updatedTs: string;
}
export interface SeoCheck { label: string; ok: boolean; note?: string }
export interface BlogDraft {
  topic: string;
  primaryKeyword: string;
  titleCandidates: string[];
  metaDescription: string;
  tags: string[];
  imageSlots: Array<{ alt: string; prompt: string }>;
  internalLinks: string[];
  bodyMarkdown: string;
  seo: { score: number; checklist: SeoCheck[] };
}
export interface PieceDraftResp { piece: PieceInfo; draft: BlogDraft; md: string; html: string }
// 본문(draft.json) 없이 끝난 런(브리프 단계 종료·편집 게이트 반려) — 검토 탭이 보류 사유를 보여주도록 폴백.
export interface PieceBriefResp { piece: PieceInfo; brief: string }
export interface MetricSample {
  measuredAt: string; views: number; dwellSec?: number;
  searchInflow: Array<{ keyword: string; count: number; rank?: number }>; source?: string;
}

export async function fetchPieces(): Promise<PieceInfo[]> {
  try { const r = await fetch("/pieces"); if (!r.ok) return []; return (await r.json()).pieces ?? []; }
  catch { return []; }
}
export async function createPiece(body: { title: string; keyword?: string; subNiche?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await fetch("/pieces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({} as { piece?: { id: string }; error?: string }));
    if (!r.ok) return { ok: false, error: j.error };
    return { ok: true, id: j.piece?.id };
  } catch { return { ok: false, error: "network" }; }
}
export async function fetchPieceDraft(id: string): Promise<PieceDraftResp | PieceBriefResp | null> {
  try { const r = await fetch(`/pieces/${id}/draft`); return r.ok ? await r.json() : null; }
  catch { return null; }
}
// 미리보기 HTML(이미지 data: 인라인) — JSON 반환(직접 내비게이션 시 렌더 안 됨=앱 오리진 XSS 방지). srcDoc(sandbox)에 넣는다.
export async function fetchPiecePreview(id: string): Promise<string> {
  try { const r = await fetch(`/pieces/${id}/preview`); return r.ok ? ((await r.json()).html ?? "") : ""; }
  catch { return ""; }
}
// 수정 요청(검토 탭) — 피드백으로 리비전 런을 띄운다. 완료되면 초안이 갱신(runId 교체)된다.
export async function revisePiece(id: string, feedback: string): Promise<{ ok: boolean; run_id?: string; error?: string }> {
  try {
    const r = await fetch(`/pieces/${id}/revise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }) });
    const j = await r.json().catch(() => ({} as { run_id?: string; error?: string }));
    if (!r.ok) return { ok: false, error: j.error };
    return { ok: true, run_id: j.run_id };
  } catch { return { ok: false, error: "network" }; }
}
export async function publishPiece(id: string, url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/pieces/${id}/published`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
// 카드 삭제(캘린더·검토·성과 탭) — 서버는 실행 중 런/잡이 있으면 409 로 거절한다.
export async function deletePiece(id: string, opts?: { purge?: boolean }): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/pieces/${id}${opts?.purge ? "?purge=1" : ""}`, { method: "DELETE" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
export async function postPieceMetrics(id: string, body: unknown): Promise<{ ok: boolean; reinforced?: boolean }> {
  try {
    const r = await fetch(`/pieces/${id}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return { ok: false };
    const j = await r.json().catch(() => ({}));
    return { ok: true, reinforced: !!j.reinforced };
  } catch { return { ok: false }; }
}
export async function fetchPieceMetrics(id: string): Promise<MetricSample[]> {
  try { const r = await fetch(`/pieces/${id}/metrics`); if (!r.ok) return []; return (await r.json()).metrics ?? []; }
  catch { return []; }
}
// 네이버 임시저장(검토 탭) — 서버가 백그라운드 잡으로 Playwright 임시저장을 수행. 상태는 폴링으로 확인.
export interface NaverDraftStatus {
  status: "idle" | "running" | "saved" | "failed";
  url?: string; admin_url?: string; error?: string; dry_run?: boolean;
  started_ts?: string; ended_ts?: string;
}
export async function startNaverDraft(id: string, dryRun = false): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/pieces/${id}/naver-draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dry_run: dryRun }) });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
export async function fetchNaverDraftStatus(id: string): Promise<NaverDraftStatus | null> {
  try { const r = await fetch(`/pieces/${id}/naver-draft`); return r.ok ? await r.json() : null; }
  catch { return null; }
}
// 성과 자동 수집(검토 탭) — 발행된 글의 조회수·유입 키워드를 네이버에서 수집→강화. 백그라운드 잡 폴링.
export interface CollectStatus {
  status: "idle" | "running" | "done" | "failed";
  views?: number; dwell_sec?: number; inflow_count?: number;
  reinforced?: boolean; note?: string; error?: string; dry_run?: boolean;
}
export async function startCollectMetrics(id: string, dryRun = false): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/pieces/${id}/collect-metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dry_run: dryRun }) });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
export async function fetchCollectStatus(id: string): Promise<CollectStatus | null> {
  try { const r = await fetch(`/pieces/${id}/collect-metrics`); return r.ok ? await r.json() : null; }
  catch { return null; }
}
// 성과 대시보드 — 발행/측정된 piece 성과 + 전략(강화 EWMA) 집계.
export interface PerfRow {
  id: string; title: string; stage: PieceStage; keyword?: string; subNiche?: string;
  publishedUrl?: string; seoScore?: number;
  date: string; // 발행일(없으면 작성일 폴백) — 날짜 정렬·표시용
  views: number | null; dwellSec?: number | null;
  /** 네이버 공감(리액션 총합, 2026-07-31) — 0 도 실값, 미수집이면 null. */
  likes?: number | null;
  inflow: Array<{ keyword: string; count: number; rank?: number }>;
  measuredAt?: string | null; source?: string; samples: number;
  derived?: DerivedSummary;
}
// 채널 성과(쇼츠·카드뉴스) — 채널 미발행이면 null, 발행됐지만 수집 전이면 views null.
// stale = 미반영인데 수집 대상에서도 빠진 상태(비공개·삭제·포기 지평 경과) → '측정 중'이 아니라 '수집 불가'.
export interface ShortsPerfRow {
  id: string; title: string; ts: string;
  youtube: { url: string | null; views: number | null; likes: number | null; reflected: boolean; stale: boolean; series: number[]; ts: string } | null;
  meta: { permalink: string | null; views: number | null; likes: number | null; reflected: boolean; stale: boolean; series: number[]; ts: string } | null;
  // 페북 릴스 — 미게시면 null. coverPending 이면 커버(썸네일) 미적용 상태.
  fb: { url: string; views: number | null; likes: number | null; series: number[]; ts: string | null; coverPending: boolean } | null;
}
export interface CardnewsPerfRow {
  id: string; topic: string; ts: string; reflected: boolean; stale: boolean;
  ig: { permalink: string | null; views: number | null; reach: number | null; likes: number | null; series: number[]; ts: string } | null;
  fb: { url: string; likes: number | null; shares: number | null; series: number[]; ts: string | null } | null; // series = 좋아요 추이(FB 게시물은 조회 미제공)
}
export interface PerfData {
  /** 새로고침 백그라운드 재수집 진행 중 여부 — true 면 프론트가 폴링으로 완료를 기다린다. */
  refreshBusy?: boolean;
  strategy: {
    winners: Array<{ keyword: string; score: number; samples: number }>; subNiches: Record<string, number>; measuredPieces: number;
    /** 채널 학습(쇼츠·릴스·카드뉴스) — 직원 강화가 남긴 교훈 문장(위키 performance 페이지 요약). */
    channelLessons: Array<{ channel: string; summary: string; updated: string }>;
  };
  pieces: PerfRow[];
  summary: { count: number; measured: number; totalViews: number; blogLikes?: number };
  channels?: {
    shorts: ShortsPerfRow[];
    cardnews: CardnewsPerfRow[];
    summary: {
      shortsYtViews: number; reelsViews: number; cardnewsViews: number; fbReelViews: number;
      ytLikes: number; reelsLikes: number; cardnewsLikes: number; fbReelLikes: number; fbPostLikes: number;
    };
  };
}
export async function fetchPerformance(): Promise<PerfData | null> {
  try { const r = await fetch("/performance"); return r.ok ? await r.json() : null; }
  catch { return null; }
}

// 팔로워·이웃 일일 스냅샷(브리핑 수집 공유) — 성과탭 채널 카드 표기+추이 그래프용(2026-07-31).
/** ts = 마지막 수집 시각(ISO) — 하루에 여러 번 갱신되므로 date 만으론 신선도를 알 수 없다(2026-08-02). */
export interface FollowerSnapshot { date: string; ts?: string | null; naver?: number | null; youtube?: number | null; instagram?: number | null; facebook?: number | null }
export interface FollowersData { snapshots: FollowerSnapshot[]; latest: FollowerSnapshot | null; goal: number }
export async function fetchFollowers(): Promise<FollowersData | null> {
  try { const r = await fetch("/api/followers"); return r.ok ? await r.json() : null; }
  catch { return null; }
}

// 제목 유형·발행 시각 A/B 리포트(후속 카드 2026-08-12) — 서버 analytics/titleTiming.ts 의 즉석 집계 미러.
export interface TitleTimingAggRow { key: string; count: number; avgSignal: number; avgViews: number; typeKo?: string }
export interface TitleTimingCrossRow { channel: string; type: string; items: number; totalDelta: number; perItem: number; typeKo: string }
export interface TitleTimingReport {
  brand: string;
  itemsTotal: number;
  itemsScorable: number;
  note: string;
  byType: Array<{ kind: string; kindKo: string; rows: TitleTimingAggRow[] }>;
  bySlot: Array<{ kind: string; kindKo: string; rows: TitleTimingAggRow[] }>;
  followerByChannel: Array<{ channel: string; channelKo: string; rows: TitleTimingCrossRow[] }>;
}
export async function fetchTitleTiming(): Promise<TitleTimingReport | null> {
  try { const r = await fetch("/api/analytics/title-timing"); return r.ok ? await r.json() : null; }
  catch { return null; }
}
/** 채널 성과 즉시 재수집 시작(쇼츠 유튜브·릴스·카드뉴스 API + 네이버 일일 추적) — 서버는 백그라운드로
 *  돌리고 즉시 응답한다(started=시작, busy=이미 진행 중). 완료는 fetchPerformance().refreshBusy 로 폴링. */
export async function refreshPerformance(): Promise<{ ok: boolean; started?: boolean; busy?: boolean; error?: string }> {
  try {
    const r = await fetch("/performance/refresh", { method: "POST" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}

// --- 지식 주입: 파일(들)을 선택한 에이전트(들)에 '우선 신뢰 지식'으로 주입 ---
export interface InjectResult {
  ok: boolean;
  files?: { file: string; status: string; chars?: number; note?: string }[];
  agents?: { agent: string; name: string; totalChars: number; overCap: boolean }[];
  warning?: string | null;
  error?: string;
}
export async function injectKnowledge(agentIds: string[], files: File[] | FileList): Promise<InjectResult> {
  try {
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
    fd.append("agent_ids", agentIds.join(","));
    const r = await fetch("/agents/knowledge", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({} as Record<string, unknown>));
    return r.ok ? { ok: true, ...j } : { ok: false, error: (j as { error?: string }).error || `HTTP ${r.status}`, files: (j as InjectResult).files };
  } catch { return { ok: false, error: "network" }; }
}
export async function clearInjectedKnowledge(id: string): Promise<boolean> {
  try { const r = await fetch(`/agents/${id}/knowledge`, { method: "DELETE" }); return r.ok; }
  catch { return false; }
}

// ── 카드뉴스(카드뉴스팀 전용 파이프라인) — 생성은 POST, 진행은 목록 GET 폴링, 발행은 메타(인스타·페북) 연결 시에만 ──
export type CardNewsStage = "planning" | "designing" | "rendering" | "ready" | "error";
export interface CardNewsInfo {
  id: string;
  topic: string;
  keyword?: string;
  sourcePieceId?: string;
  stage: CardNewsStage;
  slides?: number;
  bgFallbacks?: number;
  caption?: string;
  hashtags?: string[];
  planner?: string;
  designer?: string;
  error?: string;
  running?: boolean;
  createdTs: string;
  updatedTs: string;
  igPermalink?: string;
  fbPostId?: string;
  publishedTs?: string;
}
export async function fetchCardNews(): Promise<CardNewsInfo[]> {
  try { const r = await fetch("/cardnews"); if (!r.ok) return []; return (await r.json()).cards ?? []; }
  catch { return []; }
}
export async function createCardNews(body: { topic: string; keyword?: string; slides?: number; style?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await fetch("/cardnews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({} as { card?: { id: string }; error?: string }));
    return r.ok ? { ok: true, id: j.card?.id } : { ok: false, error: j.error };
  } catch { return { ok: false, error: "network" }; }
}
export async function createCardNewsFromPiece(pieceId: string, slides?: number, style?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await fetch(`/pieces/${pieceId}/cardnews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slides, style }) });
    const j = await r.json().catch(() => ({} as { card?: { id: string }; error?: string }));
    return r.ok ? { ok: true, id: j.card?.id } : { ok: false, error: j.error };
  } catch { return { ok: false, error: "network" }; }
}
export async function deleteCardNews(id: string, opts?: { purge?: boolean }): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/cardnews/${id}${opts?.purge ? "?purge=1" : ""}`, { method: "DELETE" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}

// ── 숏폼(숏폼팀 전용 파이프라인) — 생성은 POST, 진행은 목록 GET 폴링, 발행 없음(다운로드 전용) ──
export type ShortsStage = "planning" | "designing" | "rendering" | "ready" | "error";
export interface ShortsInfo {
  id: string;
  topic: string;
  keyword?: string;
  sourcePieceId?: string;
  stage: ShortsStage;
  title?: string;
  titles?: string[];
  description?: string;
  hashtags?: string[];
  durationSec?: number;
  scenes?: number;
  bgFallbacks?: number;
  writer?: string;
  director?: string;
  error?: string;
  youtubeUrl?: string;
  igPermalink?: string;
  fbReelId?: string;
  fbReelCoverTs?: string;   // 없으면 페북 릴스 커버 미적용 → '페북에도 올리기'가 보강한다
  views?: number;
  likes?: number;
  running?: boolean;
  createdTs: string;
  updatedTs: string;
}
export async function fetchShorts(): Promise<ShortsInfo[]> {
  try { const r = await fetch("/shorts"); if (!r.ok) return []; return (await r.json()).shorts ?? []; }
  catch { return []; }
}
export async function createShorts(body: { topic: string; keyword?: string; scenes?: number }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await fetch("/shorts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({} as { short?: { id: string }; error?: string }));
    return r.ok ? { ok: true, id: j.short?.id } : { ok: false, error: j.error };
  } catch { return { ok: false, error: "network" }; }
}
export async function createShortsFromPiece(pieceId: string, scenes?: number): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await fetch(`/pieces/${pieceId}/shorts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenes }) });
    const j = await r.json().catch(() => ({} as { short?: { id: string }; error?: string }));
    return r.ok ? { ok: true, id: j.short?.id } : { ok: false, error: j.error };
  } catch { return { ok: false, error: "network" }; }
}
export async function deleteShorts(id: string, opts?: { purge?: boolean }): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/shorts/${id}${opts?.purge ? "?purge=1" : ""}`, { method: "DELETE" });
    if (!r.ok) { const e = await r.json().catch(() => ({} as { error?: string })); return { ok: false, error: e.error }; }
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
}
export async function uploadShortsYoutube(id: string): Promise<{ ok: boolean; url?: string; error?: string; thumbnailError?: string }> {
  try {
    const r = await fetch(`/shorts/${id}/youtube`, { method: "POST" });
    const j = await r.json().catch(() => ({} as { url?: string; error?: string }));
    if (!r.ok) return { ok: false, error: (j as { error?: string }).error || `HTTP ${r.status}` };
    return { ok: true, url: (j as { url?: string }).url };
  } catch { return { ok: false, error: "network" }; }
}
export async function publishShortsMeta(id: string): Promise<{ ok?: boolean; igPermalink?: string; fbReelId?: string; error?: string; fbError?: string }> {
  try { const r = await fetch(`/shorts/${id}/meta`, { method: "POST" }); return await r.json(); }
  catch { return { error: "요청 실패" }; }
}
export async function regenerateShortsThumbnail(id: string): Promise<{ ok?: boolean; error?: string }> {
  try { const r = await fetch(`/shorts/${id}/thumbnail/regenerate`, { method: "POST" }); return await r.json(); }
  catch { return { error: "요청 실패" }; }
}
export async function fetchYoutubeStatus(): Promise<{ client: boolean; connected: boolean }> {
  try { const r = await fetch("/youtube/status"); return await r.json() as { client: boolean; connected: boolean }; }
  catch { return { client: false, connected: false }; }
}
/** 파생 수정 요청(검토 탭) — 자유 피드백을 LLM 이 해석해 카드=문구 개정+바뀐 슬라이드만 재생성,
 *  숏폼=대본 개정+필요 씬 재생성+재조립. 발행 전 한정, 수 분 걸리는 동기 호출. */
export async function reviseDerived(kind: "cardnews" | "shorts", id: string, feedback: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(`/${kind}/${id}/revise`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }),
    });
    return await r.json();
  } catch { return { error: "요청 실패" }; }
}
/** force: QA 미해결(qa_unresolved 409) 카드를 사용자가 확인한 뒤 발행 확정할 때만 true. */
export async function publishCardNews(id: string, force = false): Promise<{ ok?: boolean; igPermalink?: string; fbPostId?: string; error?: string; fbError?: string; qa_unresolved?: number[] }> {
  try {
    const r = await fetch(`/cardnews/${id}/publish`, {
      method: "POST",
      ...(force ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) } : {}),
    });
    return await r.json();
  }
  catch { return { error: "요청 실패" }; }
}
export interface MetaStatus {
  client: boolean; connected: boolean;            // 인스타그램 앱 설정 / 인스타 계정 연결
  fbClient?: boolean; fbConnected?: boolean;      // 메타 앱 설정 / 페이스북 페이지 연결(독립 축)
  pageId?: string;
}
export async function fetchMetaStatus(): Promise<MetaStatus> {
  try { const r = await fetch("/meta/status"); return await r.json() as MetaStatus; }
  catch { return { client: false, connected: false }; }
}

// piece 온디맨드 실행 — 자율 케이던스를 안 기다리고 지금 초안 런을 띄운다.
export async function runPiece(id: string): Promise<{ ok: boolean; run_id?: string; error?: string }> {
  try {
    const r = await fetch(`/pieces/${id}/run`, { method: "POST" });
    const j = await r.json().catch(() => ({} as { run_id?: string; error?: string }));
    return r.ok ? { ok: true, run_id: j.run_id } : { ok: false, error: j.error || `HTTP ${r.status}` };
  } catch { return { ok: false, error: "network" }; }
}
