// EmployeesView — directory + EDITOR for the company.
// Structure (teams / members: title·role·model·stance·critic) is edited here and
// written to org/company.yaml via /company/* . Each employee's workspace
// (persona·goal·skills·tools·autonomy) is edited too (org/agents/<id>/).
import { useEffect, useState } from "react";
import {
  fetchCompany, fetchAgent, patchAgent, addSkill, deleteSkill,
  addTeam, renameTeam, deleteTeam, addMember, patchRole, deleteRole,
  CompanyInfo, RoleInfo, AgentProfile, clearInjectedKnowledge,
} from "../api";
import Avatar from "./Avatar";
import KnowledgeInject from "./KnowledgeInject";
import Ico from "./Ico";

const AUTONOMY_LABEL = ["Off", "읽기전용", "초안(승인)", "자동"];
// 직원별 '모델'은 '처리 등급(tier)' 으로 일원화. 백엔드 agentDetail 이
// role.tier(micro|standard|heavy) 를 내려주므로 등급으로 표시·저장한다(빠름=haiku·표준=sonnet·심층=opus).
const TIER_OPTS = [
  { v: "micro", label: "⚡ 빠름 (경량)" },
  { v: "standard", label: "⚖️ 표준" },
  { v: "heavy", label: "🧠 심층 (고품질)" },
];
const STANCES = ["neutral", "pro", "con", "nuanced", "critic"];
function tierLabel(tier: string): string {
  return tier === "micro" ? "빠름" : tier === "heavy" ? "심층" : tier === "standard" ? "표준" : tier;
}

function glyph(level: string, id: string, title: string): string {
  if (level === "ceo") return "🧑‍💼";
  const k = (id + " " + title).toLowerCase();
  if (/(secretary|비서|자비스)/.test(k)) return "🤖";
  if (/(reviewer|팩트|리뷰|검증|비평)/.test(k)) return "🔎";
  if (/(디렉터|리서치|research_lead)/.test(k)) return "🧭";
  if (/(seo|키워드|strategist)/.test(k)) return "🔑";
  if (/(트렌드|trend|리서처)/.test(k)) return "📈";
  if (/(성과|분석|analyst|perf)/.test(k)) return "📊";
  if (/(발행|publish)/.test(k)) return "📮"; // content 규칙보다 먼저(content_mN id 가로채임 방지)
  if (/(작가|카피|content_lead|copywriter)/.test(k)) return "✍️";
  if (level === "lead") return "🧑‍💼";
  return "🧑‍💻";
}

export default function EmployeesView() {
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  // 전역 LLM 설정 — 로컬 모드면 직원별 모델(opus/sonnet/haiku)이 전부 로컬 모델로
  // 덮인다는 사실을 디렉터리에 표시(설정 자체는 🧩 LLM 패널에서).
  const [sel, setSel] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [flashMsg, setFlashMsg] = useState("");
  const [injectOpen, setInjectOpen] = useState(false);  // 지식 주입 모달

  // workspace edit state
  const [goal, setGoal] = useState("");
  const [web, setWeb] = useState(false);
  const [autonomy, setAutonomy] = useState(2);
  const [saving, setSaving] = useState(false);
  const [skName, setSkName] = useState("");
  const [skBody, setSkBody] = useState("");

  // structure (company.yaml) edit state
  const [title, setTitle] = useState("");
  const [sysPrompt, setSysPrompt] = useState("");
  const [model, setModel] = useState("standard");
  const [stance, setStance] = useState("neutral");
  const [critic, setCritic] = useState(false);

  // team/member add controls
  const [newTeam, setNewTeam] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newMember, setNewMember] = useState("");

  const reloadCompany = () => fetchCompany().then(setCompany);
  useEffect(() => {
    reloadCompany();
  }, []);

  const flash = (m: string) => {
    setFlashMsg(m);
    setTimeout(() => setFlashMsg(""), 2200);
  };

  const load = (id: string) => {
    setLoading(true);
    fetchAgent(id).then((p) => {
      setProfile(p);
      if (p) {
        setGoal(p.goal?.replace(/^#.*\n+/, "").trim() ?? "");
        setWeb(p.tools.includes("web") || p.tools.includes("web_search"));
        setAutonomy(p.autonomy_effective);
        setTitle(p.title ?? "");
        setSysPrompt(p.system_prompt ?? "");
        setModel(p.model ?? "standard");
        setStance(p.stance ?? "neutral");
        setCritic(!!p.is_critic);
      }
      setLoading(false);
    });
  };
  useEffect(() => {
    if (sel) load(sel);
    else setProfile(null);
  }, [sel]);

  if (!company) return <div className="emp-dir-loading">직원 정보를 불러오는 중…</div>;

  // --- workspace save ---
  const saveWorkspace = async () => {
    if (!sel) return;
    setSaving(true);
    // 백엔드 ALLOWED_TOOLS·선그라운딩(agent.ts)이 인식하는 정식(long) 툴명으로 저장 — 'wiki'/'web' 단축형은
    // 필터링돼 저장이 비워지던 버그 수정. 쓰기 도구(save_note)·셸(run_command)은 역할 툴이 아니라 자율도+AGENT_SHELL 로 게이팅.
    const ok = await patchAgent(sel, { goal, tools: web ? ["wiki_query", "wiki_ingest", "web_search"] : ["wiki_query", "wiki_ingest"], autonomy });
    setSaving(false);
    // reloadCompany — 자율도·툴 변경이 리스트 카드(실효 자율도)에 즉시 반영되게 /company 재요청.
    if (ok) { flash("워크스페이스 저장됨 ✓"); await reloadCompany(); load(sel); } else flash("저장 실패");
  };
  // --- structure save ---
  const saveStruct = async () => {
    if (!sel) return;
    setSaving(true);
    const r = await patchRole(sel, { title, system_prompt: sysPrompt, model, stance, is_critic: critic });
    setSaving(false);
    if (r.ok) { flash("구조 저장됨 ✓ (다음 run 적용)"); await reloadCompany(); load(sel); }
    else flash(r.error || "저장 실패");
  };

  const onAddSkill = async () => {
    if (!sel || !skName.trim()) return;
    if (await addSkill(sel, skName.trim(), skBody.trim())) { setSkName(""); setSkBody(""); flash("스킬 추가됨 ✓"); load(sel); }
  };
  const onDelSkill = async (s: string) => { if (sel) { await deleteSkill(sel, s); load(sel); } };

  // --- team/member CRUD ---
  const doAddTeam = async () => {
    if (!newTeam.trim()) return;
    const r = await addTeam(newTeam.trim());
    if (r.ok) { setNewTeam(""); flash("팀 추가됨 ✓"); reloadCompany(); } else flash(r.error || "실패");
  };
  const doRenameTeam = async (tid: string, cur: string) => {
    const n = window.prompt("팀 이름", cur);
    if (n && n.trim() && n !== cur) { const r = await renameTeam(tid, n.trim()); if (r.ok) reloadCompany(); else flash(r.error || "실패"); }
  };
  const doDeleteTeam = async (tid: string, name: string) => {
    if (!window.confirm(`'${name}' 팀과 소속 직원을 모두 삭제할까요?`)) return;
    const r = await deleteTeam(tid);
    if (r.ok) { flash("팀 삭제됨"); if (profile?.team === tid) setSel(null); reloadCompany(); } else flash(r.error || "실패");
  };
  const doAddMember = async (tid: string) => {
    if (!newMember.trim()) return;
    const r = await addMember(tid, { title: newMember.trim() });
    if (r.ok) { setNewMember(""); setAddingTo(null); flash("팀원 추가됨 ✓"); reloadCompany(); setSel(r.member?.id ?? null); }
    else flash(r.error || "실패");
  };
  const doDeleteMember = async (rid: string, name: string) => {
    if (!window.confirm(`'${name}' 직원을 삭제할까요?`)) return;
    const r = await deleteRole(rid);
    if (r.ok) { flash("직원 삭제됨"); if (sel === rid) setSel(null); reloadCompany(); } else flash(r.error || "실패");
  };

  const card = (r: RoleInfo, deletable: boolean) => (
    <div key={r.id} className={`emp-dir-card${sel === r.id ? " sel" : ""}${r.is_critic ? " critic" : ""}`}>
      <button className="emp-dir-cardbtn" onClick={() => setSel(r.id)}>
        <span className="emp-dir-glyph">
          <Avatar id={r.id} glyph={glyph(r.level, r.id, r.title)} size={18} level={r.level} title={r.title} />
        </span>
        <span className="emp-dir-info">
          <span className="emp-dir-name">{r.title}{r.name ? <span className="emp-person"> · {r.name}</span> : null}</span>
          <span className="emp-dir-sub">
            {typeof r.autonomy === "number" && (
              <span className={`emp-auto a${r.autonomy}`} title={`자율도 ${r.autonomy}`}>{AUTONOMY_LABEL[r.autonomy] ?? r.autonomy}</span>
            )}
            {tierLabel(r.model)} · {r.tools.join("/") || "툴 없음"}{r.is_critic ? " · 비평가" : ""}
          </span>
        </span>
      </button>
      {deletable && (
        <button className="emp-del" title="직원 삭제" onClick={() => doDeleteMember(r.id, r.title)}>✕</button>
      )}
    </div>
  );

  return (
    <div className="emp-dir">
      <div className="emp-dir-roster">
        <div className="emp-roster-head">
          <span><Ico name="person" size={12} /> 직원 편집</span>
          <button className="btn ghost emp-inject-btn" onClick={() => setInjectOpen(true)} title="파일로 외부 지식을 특정 에이전트(들)에 주입">지식 주입</button>
          <span className="emp-saved">{flashMsg}</span>
        </div>

        <div className="emp-dir-section">
          <div className="emp-dir-team"><Ico name="company" size={11} /> {company.name}</div>
          {card(company.ceo, false)}
        </div>

        {company.teams.map((t) => (
          <div key={t.id} className="emp-dir-section">
            <div className="emp-team-head">
              <span className="emp-dir-team"><Ico name="person" size={11} /> {t.name}</span>
              <span className="emp-team-actions">
                <button title="팀 이름 변경" onClick={() => doRenameTeam(t.id, t.name)}><Ico name="pencil" size={12} /></button>
                <button title="팀 삭제" onClick={() => doDeleteTeam(t.id, t.name)}><Ico name="trash" size={12} /></button>
              </span>
            </div>
            {card(t.lead, false)}
            {t.members.map((m) => card(m, true))}
            {addingTo === t.id ? (
              <div className="emp-addmember">
                <input autoFocus placeholder="새 팀원 이름 (예: 홍길동 사원)" value={newMember}
                  onChange={(e) => setNewMember(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doAddMember(t.id)} />
                <button className="btn" onClick={() => doAddMember(t.id)}>추가</button>
                <button className="btn ghost" onClick={() => { setAddingTo(null); setNewMember(""); }}>취소</button>
              </div>
            ) : (
              <button className="emp-add-btn" onClick={() => { setAddingTo(t.id); setNewMember(""); }}>+ 팀원 추가</button>
            )}
          </div>
        ))}

        <div className="emp-addteam">
          <input placeholder="새 팀 이름" value={newTeam} onChange={(e) => setNewTeam(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doAddTeam()} />
          <button className="btn start" onClick={doAddTeam}>+ 팀 추가</button>
        </div>
      </div>

      <div className="emp-dir-detail">
        {!profile && !loading && <p className="muted">직원을 선택하면 구조·워크스페이스를 편집할 수 있습니다.</p>}
        {loading && <p className="muted">불러오는 중…</p>}
        {profile && (
          <>
            <h2 className="emp-detail-title">
              <span className="emp-detail-ava">
                <Avatar id={profile.id} glyph={glyph(profile.level, profile.id, profile.title)} size={24} level={profile.level} title={profile.title} />
              </span>
              {profile.title}
              {profile.name && <span className="emp-person"> · {profile.name}</span>}
              <span className="muted"> ({profile.id})</span>
            </h2>
            <div className="emp-dir-badges">
              <span className="chip">레벨 {profile.level}</span>
              {profile.team && <span className="chip">{profile.team}</span>}
            </div>

            {/* --- 구조 (company.yaml) --- */}
            <div className="emp-edit-box">
              <h4>구조 (역할 정의)</h4>
              <label className="emp-field"><span>이름/직책</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label className="emp-field col"><span>역할 설명 (system prompt)</span>
                <textarea rows={3} value={sysPrompt} onChange={(e) => setSysPrompt(e.target.value)} /></label>
              <div className="emp-edit-row">
                <label className="emp-field"><span>처리 등급</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {TIER_OPTS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                  </select></label>
                {profile.level === "member" && (
                  <>
                    <label className="emp-field"><span>입장</span>
                      <select value={stance} onChange={(e) => setStance(e.target.value)}>
                        {STANCES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select></label>
                    <label className="emp-field checkbox"><input type="checkbox" checked={critic}
                      onChange={(e) => setCritic(e.target.checked)} /><span>비평가</span></label>
                  </>
                )}
                <button className="btn start emp-save" disabled={saving} onClick={saveStruct}>구조 저장</button>
              </div>
            </div>

            {/* --- 워크스페이스 (org/agents/<id>) --- */}
            <div className="emp-edit-box">
              <h4>워크스페이스 (목표·툴·스킬)</h4>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
                직무 정체성·성격은 위 <b>역할 설명(system prompt)</b>이 담당합니다. 여기선 개인 목표·툴·스킬만 조정하세요.
              </p>
              <label className="emp-field col"><span>개인 목표 (goal.md)</span>
                <textarea rows={2} value={goal} placeholder="비우면 자가학습이 업무·학습을 반영해 자동 생성합니다"
                  onChange={(e) => setGoal(e.target.value)} /></label>
              <div className="emp-edit-row">
                <label className="emp-field"><span>자율도</span>
                  <select value={autonomy} onChange={(e) => setAutonomy(Number(e.target.value))}>
                    {AUTONOMY_LABEL.map((l, i) => <option key={i} value={i}>{i} · {l}</option>)}
                  </select></label>
                <label className="emp-field checkbox"><input type="checkbox" checked={web}
                  onChange={(e) => setWeb(e.target.checked)} /><span><Ico name="globe" size={12} /> 웹 검색 툴</span></label>
                <button className="btn start emp-save" disabled={saving} onClick={saveWorkspace}>워크스페이스 저장</button>
              </div>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 11 }}>
                자율도 2↑면 쓰기 도구(노트 저장)·셸(서버 <code>AGENT_SHELL=1</code>)을 <b>승인 후</b> 사용합니다. 0=도구 없음 · 1=읽기만.
              </p>
              <h4>스킬</h4>
              <div className="emp-skill-list">
                {profile.skills_loaded.length ? profile.skills_loaded.map((s) => (
                  <span key={s} className="chip skill-chip emp-skill">{s}
                    <button className="emp-skill-del" onClick={() => onDelSkill(s)}>✕</button></span>
                )) : <span className="muted">아직 없음 (연구 과정에서 자동 학습)</span>}
              </div>
              <div className="emp-skill-add">
                <input placeholder="스킬 제목" value={skName} onChange={(e) => setSkName(e.target.value)} />
                <input placeholder="내용" value={skBody} onChange={(e) => setSkBody(e.target.value)} />
                <button className="btn" onClick={onAddSkill} disabled={!skName.trim()}>+ 스킬</button>
              </div>
            </div>

            <div className="emp-injected-head">
              <h4>주입된 외부 지식 (사람이 넣음 · 최우선 신뢰)</h4>
              {profile.injected?.trim() && (
                <button className="btn ghost emp-inject-clear" onClick={async () => {
                  if (!window.confirm("이 에이전트의 주입 지식을 모두 비울까요?")) return;
                  if (await clearInjectedKnowledge(profile.id)) { flash("주입 지식 비움"); load(profile.id); }
                }}>🧹 비우기</button>
              )}
            </div>
            <pre className="emp-dir-file">{profile.injected?.trim() ? profile.injected.trim() : "(없음 — 상단 📥 지식 주입 으로 파일을 이 에이전트에 넣으면 다음 런부터 우선 반영됩니다)"}</pre>

            <h4>✅ 검증 지식 (근거 확인됨 · 우선 신뢰)</h4>
            <pre className="emp-dir-file">{profile.verified?.trim() ? profile.verified.trim() : "(아직 없음 — 산출물에 [근거: 출처] 태그가 붙은 주장이 검증 지식으로 자동 승격되어 다음 런에 우선 주입됩니다)"}</pre>

            <h4>🎓 학습한 교훈 (자가학습)</h4>
            <pre className="emp-dir-file">{profile.memory?.trim() ? profile.memory.trim() : "(아직 학습 없음 — 런을 마칠 때마다 이 직원의 기여에서 교훈이 자동 누적되고, 다음 런 프롬프트에 주입됩니다)"}</pre>

            <h4>📜 최근 활동</h4>
            <pre className="emp-dir-file">{profile.activity_tail.length ? profile.activity_tail.join("\n") : "(아직 활동 없음)"}</pre>
          </>
        )}
      </div>
      {injectOpen && company && (
        <KnowledgeInject company={company} onClose={() => setInjectOpen(false)} onDone={() => { if (sel) load(sel); }} />
      )}
    </div>
  );
}
