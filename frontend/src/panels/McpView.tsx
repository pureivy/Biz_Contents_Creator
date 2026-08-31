// McpView — 외부 데이터 소스(MCP/커넥터) 관리 + AI로 외부 API 연동 추가.
// 위키·웹검색(in-process)은 항상 활성, 법령·DART·커스텀 커넥터(external)는 API키 설정 시 활성.
// 'AI 자동설정': API 이름(+문서 URL)으로 Claude 가 선언형 설정을 제안 → 테스트 미리보기 → 저장.
import { useEffect, useState } from "react";
import Ico from "./Ico";
import {
  fetchMcp, toggleMcp, McpServer,
  listConnectors, autoconfigConnector, testConnector, saveConnector, deleteConnector, ConnectorCfg,
  fetchApiKeys, ApiKeyInfo, searchDocs, DocResult,
} from "../api";

export default function McpView() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [customIds, setCustomIds] = useState<Set<string>>(new Set());
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [connKeyNames, setConnKeyNames] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // 연동 추가 폼
  const [keyName, setKeyName] = useState("");
  const [apiName, setApiName] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [cfgJson, setCfgJson] = useState("");
  const [testQ, setTestQ] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [docs, setDocs] = useState<DocResult[]>([]);

  const load = () => {
    fetchMcp().then(setServers);
    listConnectors().then((cs) => {
      setCustomIds(new Set(cs.map((c) => c.id)));
      setConnKeyNames(new Set(cs.map((c) => c.keyName)));
    });
    fetchApiKeys().then(setKeys);
  };
  useEffect(() => { load(); }, []);

  // API키 화면에 등록됐지만 아직 연동 커넥터가 없는 '미연동' 커스텀 키 — 클릭하면 그 키로 AI 설정 시작.
  const unconnected = keys.filter((k) => !k.builtin && k.set && !connKeyNames.has(k.key));

  const onToggle = async (s: McpServer) => {
    if (!s.toggleable) return;
    setBusy(s.id);
    const res = await toggleMcp(s.id, !s.enabled);
    setBusy(null);
    if (res.ok && res.servers) setServers(res.servers);
    else if (!res.ok) alert(`변경 실패: ${res.error || ""}`);
  };

  const onAuto = async () => {
    if (!keyName.trim() || !apiName.trim()) { setMsg("⚠ 시크릿 키 이름과 API 이름을 입력하세요."); return; }
    setBusy("auto"); setMsg("AI가 설정 생성 중… (최대 1분)"); setPreview(null);
    const r = await autoconfigConnector(keyName.trim(), apiName.trim(), docsUrl.trim());
    setBusy(null);
    if (r.ok && r.cfg) { setCfgJson(JSON.stringify(r.cfg, null, 2)); setMsg("✓ 설정 생성됨 — 검토·수정 후 반드시 테스트하세요(AI 추정이라 틀릴 수 있음)."); }
    else setMsg(`생성 실패: ${r.error || ""}`);
  };
  const onSearchDocs = async () => {
    if (!apiName.trim()) { setMsg("⚠ 먼저 API 이름을 입력하세요."); return; }
    setBusy("docs"); setDocs([]); setMsg("문서 URL 검색 중…");
    const r = await searchDocs(apiName.trim());
    setBusy(null);
    if (r.ok && r.results?.length) { setDocs(r.results.slice(0, 6)); setMsg(`문서 후보 ${r.results.length}건 — 클릭하면 URL이 입력됩니다.`); }
    else setMsg("검색 결과 없음 — 직접 입력하거나 API 이름만으로 자동설정하세요.");
  };
  const parseCfg = (): ConnectorCfg | null => {
    try { return JSON.parse(cfgJson) as ConnectorCfg; } catch { setMsg("⚠ 설정 JSON 형식 오류 — 중괄호·쉼표를 확인하세요."); return null; }
  };
  const onTest = async () => {
    const cfg = parseCfg(); if (!cfg) return;
    setBusy("test"); setPreview(null);
    const r = await testConnector(cfg, testQ.trim());
    setBusy(null);
    if (!r.ok) { setMsg(`테스트 실패: ${r.error || ""}`); return; }
    setPreview(r.preview || "");
    setMsg(r.empty ? `⚠ ${r.note || "빈 응답"} (엔드포인트/파라미터/추출규칙 수정 필요)` : "✓ 응답을 받았습니다 — 저장하면 자동 연동됩니다.");
  };
  const onSave = async () => {
    const cfg = parseCfg(); if (!cfg) return;
    setBusy("save");
    const r = await saveConnector(cfg);
    setBusy(null);
    if (r.ok) { setMsg("✓ 저장됨 — 키가 설정돼 있으면 다음 런부터 직원들이 자동 사용합니다."); setCfgJson(""); setApiName(""); setDocsUrl(""); setPreview(null); load(); }
    else setMsg(`저장 실패: ${r.error || ""}`);
  };
  const onDelete = async (id: string) => {
    if (!window.confirm(`커넥터 '${id}' 를 삭제할까요?`)) return;
    await deleteConnector(id); load();
  };

  return (
    <div className="apikeys">
      <div className="apikeys-head">
        <h1><Ico name="globe" size={17} /> MCP · 외부 데이터 연동</h1>
        <p className="apikeys-sub">
          직원들이 작업에 활용하는 외부 데이터 소스 목록입니다. <b>API 키는 'API 키' 화면에서 먼저 입력</b>하고,
          여기서 새 API 를 <b>AI 자동설정</b>으로 연결하세요. 연결되면 관련 주제 작업에 자동 주입됩니다.
        </p>
      </div>

      {/* AI 외부 API 연동 추가 */}
      <div className="apikeys-grid">
        <div className="apikey-card">
          <div className="apikey-card-head">
            <span className="apikey-icon"><Ico name="sparkle" size={18} /></span>
            <div className="apikey-titles">
              <b>AI로 외부 API 연동 추가</b>
              <div className="apikey-desc">API 이름(+문서 URL)을 넣고 AI 자동설정 → 테스트 → 저장. 키만으로는 안 되고, 한 번 설정을 만들면 그 다음부터 키로 켜고 끕니다.</div>
            </div>
          </div>
          {unconnected.length > 0 && (
            <div className="apikey-field">
              <label>등록된 미연동 키 ({unconnected.length}) — 클릭하면 자동 입력</label>
              <div className="mcp-tools">
                {unconnected.map((k) => (
                  <button key={k.key} type="button"
                    className={`mcp-tool${keyName === k.key ? " sel" : ""}`}
                    style={{ cursor: "pointer", border: keyName === k.key ? "1px solid var(--fg-success)" : undefined }}
                    onClick={() => { setKeyName(k.key); if (!apiName) setApiName(k.label && k.label !== k.key ? k.label : ""); setMsg(`'${k.key}' 선택됨 — API 이름·문서 URL을 넣고 자동설정하세요.`); }}>
                    {k.icon} {k.key}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="apikey-field"><label>시크릿 키 이름</label>
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="예: KOSIS_API (API 키 화면에 등록한 이름)" /></div>
          <div className="apikey-field"><label>API 이름</label>
            <input value={apiName} onChange={(e) => setApiName(e.target.value)} placeholder="예: KOSIS 국가통계포털 OpenAPI" /></div>
          <div className="apikey-field">
            <label>API 문서 URL (선택 · 정확도↑)</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} placeholder="https://… 또는 우측 '문서 검색'으로 찾기" style={{ flex: 1 }} />
              <button className="btn" type="button" disabled={busy !== null || !apiName.trim()} onClick={onSearchDocs}>{busy === "docs" ? "검색 중…" : "문서 검색"}</button>
            </div>
            {docs.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {docs.map((d) => (
                  <button key={d.url} type="button"
                    onClick={() => { setDocsUrl(d.url); setMsg(`문서 URL 선택됨 — 이제 AI 자동설정을 누르세요.`); }}
                    style={{ textAlign: "left", padding: "5px 9px", borderRadius: 5, cursor: "pointer",
                      border: docsUrl === d.url ? "1px solid var(--fg-success)" : "1px solid var(--line-neutral)", background: "transparent", color: "inherit" }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{d.title || d.url}</div>
                    <div style={{ fontSize: 11, opacity: 0.65, wordBreak: "break-all" }}>{d.url}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="apikey-foot">
            <button className="btn start" disabled={busy !== null} onClick={onAuto}>{busy === "auto" ? "생성 중…" : "AI 자동설정"}</button>
          </div>

          {cfgJson && (
            <>
              <div className="apikey-field"><label>연동 설정 (JSON · 직접 수정 가능)</label>
                <textarea value={cfgJson} onChange={(e) => setCfgJson(e.target.value)} rows={10} style={{ fontFamily: "monospace", fontSize: 12, width: "100%" }} /></div>
              <div className="apikey-field"><label>테스트 검색어</label>
                <input value={testQ} onChange={(e) => setTestQ(e.target.value)} placeholder="예: 경상북도 일자리 지원" /></div>
              <div className="apikey-foot">
                <button className="btn" disabled={busy !== null} onClick={onTest}>{busy === "test" ? "테스트 중…" : "테스트(미리보기)"}</button>
                <button className="btn start" disabled={busy !== null} onClick={onSave}>{busy === "save" ? "저장 중…" : "저장"}</button>
              </div>
              {preview !== null && (
                <div className="apikey-field"><label>미리보기 결과</label>
                  <pre className="emp-dir-file">{preview.trim() || "(빈 응답)"}</pre></div>
              )}
            </>
          )}
          {msg && <div className="apikey-note" style={{ marginTop: 6 }}>{msg}</div>}
        </div>
      </div>

      {/* 외부 데이터 소스 목록 */}
      <div className="apikeys-grid">
        {servers.length === 0 && (
          <div className="apikey-card"><div className="apikey-desc">등록된 데이터 소스가 없습니다.</div></div>
        )}
        {servers.map((s) => (
          <div key={s.id} className="apikey-card">
            <div className="apikey-card-head">
              <span className="apikey-icon">{s.icon}</span>
              <div className="apikey-titles">
                <b>{s.name} <span className="mcp-kind">{s.kind}</span></b>
                <div className="apikey-desc">{s.desc}</div>
              </div>
              <span className={`apikey-state${s.enabled ? " on" : ""}`}>{s.enabled ? "활성" : "꺼짐"}</span>
            </div>
            {s.tools.length > 0 && (
              <div className="apikey-field"><label>제공 툴</label>
                <div className="mcp-tools">{s.tools.map((t) => <span key={t} className="mcp-tool">{t}</span>)}</div></div>
            )}
            <div className="apikey-field"><label>사용 직원 ({s.used_by.length})</label>
              <div className="apikey-desc">{s.used_by.join(", ") || "—"}</div></div>
            <div className="apikey-foot">
              <span className="apikey-note">
                {customIds.has(s.id) ? "AI/사용자 커넥터" : (s.kind === "in-process" ? "in-process · 항상 활성" : "키 설정 시 자동 활성")}
              </span>
              {s.toggleable && (
                <button className={`btn ${s.enabled ? "reject" : "start"}`} disabled={busy === s.id} onClick={() => onToggle(s)}>
                  {busy === s.id ? "변경 중…" : s.enabled ? "끄기" : "켜기"}
                </button>
              )}
              {customIds.has(s.id) && (
                <button className="btn reject" onClick={() => onDelete(s.id)}><Ico name="trash" size={12} /> 삭제</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
