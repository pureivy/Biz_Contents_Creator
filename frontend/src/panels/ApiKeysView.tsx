// ApiKeysView — "API 키 한 곳에서 관리": a card per credential. Built-in keys
// (Anthropic / OpenAI / 법제처) are editable but protected; you can ADD custom keys
// and DELETE them. Values live in the project's .env (the single store) and are shown masked.
import { useEffect, useState } from "react";
import { fetchApiKeysAll, saveApiKey, addApiKey, deleteApiKey, restoreApiKey, ApiKeyInfo, HiddenKeyInfo,
  fetchNaverAccounts, saveNaverAccount, NaverAccountsResp } from "../api";
import Ico from "./Ico";

export default function ApiKeysView() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [hidden, setHidden] = useState<HiddenKeyInfo[]>([]);
  // 커스텀 키의 브랜드 스코프 — 탭을 열면 활성 브랜드가 기본 선택돼 그 브랜드 카드가 보인다.
  // null = 아직 미초기화(첫 응답의 activeBrand 로 1회 설정, 이후 재조회에도 선택 유지).
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([{ slug: "", name: "공용 (기본)" }]);
  const [kbrand, setKbrand] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [nk, setNk] = useState({ key: "", label: "", value: "" });
  const [addBusy, setAddBusy] = useState(false);
  // 네이버 발행 계정(브랜드별) — 전용 섹션. 프로필·세션은 발행 시 브랜드 슬러그로 자동 분리.
  const [naver, setNaver] = useState<NaverAccountsResp>({ brands: [{ slug: "", name: "범용 (기본)" }], accounts: {} });
  const [naverSel, setNaverSel] = useState("");
  const [naverDraft, setNaverDraft] = useState({ blogId: "", loginId: "", loginPw: "" });
  const [naverBusy, setNaverBusy] = useState(false);
  const [naverSaved, setNaverSaved] = useState(false);

  const load = () => fetchApiKeysAll().then(({ keys, hidden, brands, activeBrand }) => {
    setKeys(keys); setHidden(hidden); setBrands(brands);
    // 첫 성공 응답에서만 활성 브랜드로 초기화 — 실패(null)면 미루고, 사용자의 선택은 재조회에도 유지.
    if (activeBrand !== null) setKbrand((prev) => prev ?? activeBrand);
  });
  const loadNaver = () => fetchNaverAccounts().then(setNaver);
  useEffect(() => { load(); loadNaver(); }, []);

  const naverAcct = naver.accounts[naverSel];
  const saveNaver = async () => {
    const patch: { blogId?: string; loginId?: string; loginPw?: string } = {};
    if (naverDraft.blogId.trim()) patch.blogId = naverDraft.blogId.trim();
    if (naverDraft.loginId.trim()) patch.loginId = naverDraft.loginId.trim();
    if (naverDraft.loginPw.trim()) patch.loginPw = naverDraft.loginPw.trim();
    if (!Object.keys(patch).length) return;
    setNaverBusy(true);
    const res = await saveNaverAccount(naverSel, patch);
    setNaverBusy(false);
    if (res.ok) {
      setNaverDraft({ blogId: "", loginId: "", loginPw: "" });
      setNaverSaved(true);
      loadNaver();
      window.setTimeout(() => setNaverSaved(false), 2500);
    } else {
      alert(`저장 실패: ${res.error || ""}`);
    }
  };

  const save = async (key: string) => {
    const v = (drafts[key] ?? "").trim();
    if (!v) return;
    setBusy(key);
    const res = await saveApiKey(key, v);
    setBusy(null);
    if (res.ok) {
      setDrafts((d) => ({ ...d, [key]: "" }));
      setSaved(key);
      load();
      window.setTimeout(() => setSaved((s) => (s === key ? null : s)), 2500);
    } else {
      alert(`저장 실패: ${res.error || ""}`);
    }
  };

  const addKey = async () => {
    if (!nk.key.trim()) return;
    setAddBusy(true);
    const res = await addApiKey(nk.key.trim(), nk.label.trim(), "", nk.value.trim(), kbrand ?? "");
    setAddBusy(false);
    if (res.ok) { setNk({ key: "", label: "", value: "" }); load(); }
    else alert(`추가 실패: ${res.error || ""}`);
  };

  // 카드 삭제 — 사용자 키는 완전 제거, 기본 키는 값 제거+숨김(아래 '숨긴 기본 키'에서 복원).
  const del = async (k: ApiKeyInfo) => {
    const msg = k.builtin
      ? `'${k.label}' 카드를 삭제할까요? 저장된 값도 제거됩니다. (하단 '숨긴 기본 키'에서 복원 가능)`
      : `'${k.key}' 키를 삭제할까요? (항목·저장된 값 모두 제거)`;
    if (!window.confirm(msg)) return;
    const res = await deleteApiKey(k.key);
    if (res.ok) load();
    else alert(`삭제 실패: ${res.error || ""}`);
  };

  const restore = async (key: string) => {
    const res = await restoreApiKey(key);
    if (res.ok) load();
    else alert(`복원 실패: ${res.error || ""}`);
  };

  return (
    <div className="apikeys">
      <div className="apikeys-head">
        <h1><Ico name="key" size={17} /> API 키 한 곳에서 관리</h1>
        <p className="apikeys-sub">
          모든 자격증명을 한 곳에서 입력·저장합니다. 키는 프로젝트의 <code>.env</code>(git 제외) <b>한 곳에만</b> 저장되며,
          화면에는 항상 <b>마스킹</b>되어 표시됩니다. 휴지통 버튼은 카드를 삭제합니다 — 사용자 키는 완전 제거,
          <b>기본 키는 값 제거 후 숨김</b>(하단에서 복원 가능). <b>사용자 키는 브랜드별</b>로 관리됩니다 —
          탭을 열면 활성 브랜드의 카드가 보이고, 아래 선택자로 다른 브랜드·공용 키를 볼 수 있습니다(기본 키는 앱 공용).
        </p>
      </div>
      {/* 네이버 발행 계정 — 브랜드별. blogId 는 공개값(평문), 로그인은 마스킹. 프로필·세션 자동 분리. */}
      <div className="apikey-card" style={{ marginBottom: 18 }}>
        <div className="apikey-card-head">
          <span className="apikey-icon">📗</span>
          <div className="apikey-titles">
            <b>네이버 발행 계정 (브랜드별)</b>
            <div className="apikey-desc">
              브랜드마다 다른 네이버 블로그로 임시저장·발행합니다. 로그인 프로필·세션은 발행 시 브랜드별로 자동
              분리돼 계정이 섞이지 않습니다. 비밀번호는 선택 — 최초 발행 때 열린 브라우저에서 직접 로그인하면 그
              브랜드 프로필에 유지됩니다.
            </div>
          </div>
          <select
            value={naverSel}
            onChange={(e) => { setNaverSel(e.target.value); setNaverDraft({ blogId: "", loginId: "", loginPw: "" }); }}
            style={{ marginLeft: "auto", background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", fontSize: 13 }}
            title="발행 계정을 설정할 브랜드"
          >
            {naver.brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
          </select>
        </div>
        <div className="apikey-field">
          <label>블로그 ID{naverAcct?.blogId && <span className="apikey-cur"> · 현재 {naverAcct.blogId}</span>}</label>
          <input
            type="text" autoComplete="off"
            placeholder={naverAcct?.blogId ? "변경하려면 새 값 입력…" : "예: myblog (blog.naver.com/<이 값>)"}
            value={naverDraft.blogId}
            onChange={(e) => setNaverDraft((d) => ({ ...d, blogId: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && saveNaver()}
          />
        </div>
        <div className="apikey-field">
          <label>로그인 아이디 (선택){naverAcct?.loginIdSet && <span className="apikey-cur"> · 현재 {naverAcct.loginIdMasked}</span>}</label>
          <input
            type="text" autoComplete="off"
            placeholder={naverAcct?.loginIdSet ? "변경하려면 새 값…" : "네이버 아이디 (자동 로그인 보조)"}
            value={naverDraft.loginId}
            onChange={(e) => setNaverDraft((d) => ({ ...d, loginId: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && saveNaver()}
          />
        </div>
        <div className="apikey-field">
          <label>로그인 비밀번호 (선택){naverAcct?.loginPwSet && <span className="apikey-cur"> · 설정됨</span>}</label>
          <input
            type="password" autoComplete="off"
            placeholder={naverAcct?.loginPwSet ? "변경하려면 새 값…" : "비밀번호 (.env 에만 저장·마스킹)"}
            value={naverDraft.loginPw}
            onChange={(e) => setNaverDraft((d) => ({ ...d, loginPw: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && saveNaver()}
          />
        </div>
        <div className="apikey-foot">
          {naverSaved && <span className="apikey-ok">✓ 저장됨</span>}
          <button
            className="btn start"
            disabled={naverBusy || !(naverDraft.blogId.trim() || naverDraft.loginId.trim() || naverDraft.loginPw.trim())}
            onClick={saveNaver}
          >
            {naverBusy ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>

      {/* 사용자 키 브랜드 선택 — 카드·추가 폼이 이 브랜드로 스코프된다(내장 키는 항상 표시). */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px" }}>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>사용자 키 브랜드</span>
        <select
          value={kbrand ?? ""}
          onChange={(e) => setKbrand(e.target.value)}
          style={{ background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", fontSize: 13 }}
          title="이 브랜드에서 설정한 사용자 키 카드를 표시·추가"
        >
          {brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
        </select>
      </div>

      <div className="apikeys-grid">
        {keys.filter((k) => k.builtin || (k.brand ?? "") === (kbrand ?? "")).map((k) => {
          const draft = drafts[k.key] ?? "";
          return (
            <div key={k.key} className="apikey-card">
              <div className="apikey-card-head">
                <span className="apikey-icon">{k.icon}</span>
                <div className="apikey-titles">
                  <b>{k.label}</b>
                  <div className="apikey-desc">{k.desc}</div>
                </div>
                <span className={`apikey-state${k.set ? " on" : ""}`}>{k.set ? "설정됨" : "미설정"}</span>
                <button
                  className="apikey-del"
                  title={k.builtin ? "카드 삭제(값 제거+숨김 · 복원 가능)" : "이 키 삭제(항목·값 제거)"}
                  onClick={() => del(k)}
                ><Ico name="trash" size={13} /></button>
              </div>
              <div className="apikey-field">
                <label>
                  {k.key}
                  {k.set && <span className="apikey-cur"> · 현재 {k.masked}</span>}
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={k.set ? "변경하려면 새 값 입력…" : k.placeholder}
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [k.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && save(k.key)}
                />
              </div>
              <div className="apikey-foot">
                {k.needs_restart && <span className="apikey-note">※ 적용에 서버 재시작 필요</span>}
                {saved === k.key && <span className="apikey-ok">✓ 저장됨</span>}
                <button
                  className="btn start"
                  disabled={busy === k.key || !draft.trim()}
                  onClick={() => save(k.key)}
                >
                  {busy === k.key ? "저장 중…" : "저장"}
                </button>
              </div>
            </div>
          );
        })}

        {/* 사용자 키 추가 */}
        <div className="apikey-card apikey-add">
          <div className="apikey-card-head">
            <span className="apikey-icon"><Ico name="plus" size={18} /></span>
            <div className="apikey-titles">
              <b>API 키 추가</b>
              <div className="apikey-desc">
                사용자 정의 키 등록 — <b>{brands.find((b) => b.slug === (kbrand ?? ""))?.name ?? "공용 (기본)"}</b>에 저장됩니다.
                이름은 대문자로 시작, 대문자/숫자/밑줄만 (예: MY_API_KEY).
              </div>
            </div>
          </div>
          <div className="apikey-field">
            <label>키 이름</label>
            <input value={nk.key} placeholder="MY_API_KEY" autoComplete="off"
              onChange={(e) => setNk((s) => ({ ...s, key: e.target.value }))} />
          </div>
          <div className="apikey-field">
            <label>표시 이름 (선택)</label>
            <input value={nk.label} placeholder="예: 내 서비스"
              onChange={(e) => setNk((s) => ({ ...s, label: e.target.value }))} />
          </div>
          <div className="apikey-field">
            <label>값 (선택)</label>
            <input type="password" value={nk.value} placeholder="키 값…" autoComplete="off"
              onChange={(e) => setNk((s) => ({ ...s, value: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && addKey()} />
          </div>
          <div className="apikey-foot">
            <button className="btn start" disabled={addBusy || !nk.key.trim()} onClick={addKey}>
              {addBusy ? "추가 중…" : "추가"}
            </button>
          </div>
        </div>
      </div>

      {/* 삭제(숨김)한 기본 키 복원 — 정의는 코드에 있으므로 언제든 되살릴 수 있다 */}
      {hidden.length > 0 && (
        <div className="apikey-hidden">
          <span className="apikey-hidden-label">숨긴 기본 키:</span>
          {hidden.map((h) => (
            <button key={h.key} className="apikey-restore" title={`${h.key} 카드 복원`} onClick={() => restore(h.key)}>
              {h.icon} {h.label} ↩︎
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
