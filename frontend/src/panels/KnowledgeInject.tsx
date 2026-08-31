import { useState } from "react";
import { CompanyInfo, injectKnowledge, InjectResult } from "../api";

// 지식 주입 모달 — 파일(들)을 여러 에이전트에 '우선 신뢰 지식'으로 주입. 다음 런부터 시스템프롬프트에 반영.
export default function KnowledgeInject({ company, onClose, onDone }: {
  company: CompanyInfo; onClose: () => void; onDone: () => void;
}) {
  const roster = [
    { id: company.ceo.id, title: company.ceo.title, name: company.ceo.name, team: "편집장" },
    ...company.teams.flatMap((t) => [t.lead, ...t.members].map((r) => ({ id: r.id, title: r.title, name: r.name, team: t.name }))),
  ];
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InjectResult | null>(null);

  const toggle = (id: string) => setChecked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = checked.size === roster.length;

  const submit = async () => {
    if (!files.length || !checked.size) return;
    setBusy(true); setResult(null);
    const r = await injectKnowledge([...checked], files);
    setBusy(false); setResult(r);
    if (r.ok) onDone();
  };

  return (
    <div className="ki-overlay" onClick={onClose}>
      <div className="ki-card" onClick={(e) => e.stopPropagation()}>
        <div className="ki-head">
          <h3>📥 지식 주입</h3>
          <button className="ki-x" onClick={onClose} title="닫기">✕</button>
        </div>
        <p className="muted ki-desc">
          파일을 선택한 에이전트(들)의 <b>우선 신뢰 지식</b>으로 주입합니다. 다음 런부터 그 에이전트의
          시스템프롬프트에 반영됩니다(관련될 때 우선 활용). 규칙·정책·핵심 사실에 적합하며, 대용량 자료는
          자료실(위키 업로드)을 쓰세요.
        </p>

        <label className="ki-file">
          <span>📄 파일 선택 <span className="muted">(PDF·DOCX·HWPX·XLSX·PPTX·텍스트, 여러 개 가능)</span></span>
          <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
        {files.length > 0 && <div className="muted ki-filelist">{files.map((f) => f.name).join(" · ")}</div>}

        <div className="ki-agents">
          <div className="ki-agents-head">
            <span>대상 에이전트</span>
            <button className="btn ghost ki-all" onClick={() => setChecked(allOn ? new Set() : new Set(roster.map((r) => r.id)))}>
              {allOn ? "전체 해제" : "전체 선택"}
            </button>
          </div>
          <div className="ki-agent-grid">
            {roster.map((r) => (
              <label key={r.id} className={`ki-agent ${checked.has(r.id) ? "on" : ""}`}>
                <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="ki-agent-name">{r.title}{r.name ? ` · ${r.name}` : ""}</span>
                <span className="muted ki-team">{r.team}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="ki-foot">
          <span className="muted">{checked.size}명 선택 · 파일 {files.length}개</span>
          <button className="btn start" disabled={busy || !files.length || !checked.size} onClick={submit}>
            {busy ? "주입 중…" : "주입"}
          </button>
        </div>

        {result && (
          <div className="ki-result">
            {result.error ? (
              <p style={{ color: "var(--con)" }}>실패: {result.error}</p>
            ) : (
              <>
                <p>✅ 주입 완료 — {result.agents?.length ?? 0}명</p>
                {result.warning && <p style={{ color: "var(--critic)" }}>⚠️ {result.warning}</p>}
                <ul className="ki-result-files">
                  {result.files?.map((f, i) => (
                    <li key={i} className="muted">{f.file}: {f.status}{f.chars ? ` (${f.chars}자)` : ""}{f.note ? ` — ${f.note}` : ""}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
