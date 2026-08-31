// UploadSummary — 자료 업로드 후 결과 정산 패널. 저장/중복/미지원/실패/필터제외를
// 집계해 보여주고, 손봐야 할 항목(미지원·실패·네트워크·필터제외)은 파일 목록까지
// 펼쳐 보여준다(조용한 누락 제거 — 1000개 올렸는데 428개만 남는 미스터리 해소).
// 저장된 파일은 행별로 "원문(raw) · 위키 페이지 · 직원 귀속" 증거 배지를 보여주고,
// 귀속은 백그라운드 분류가 끝날 때까지 4초 간격 폴링으로 갱신한다(사용자 요청:
// 대량 업로드 후 제대로 저장·분류됐는지 웹 UI에서 확인 가능해야 함).
import { useEffect, useState } from "react";
import { ClassifyStatus, UploadFileResult, fetchClassifyStatus, reassignSource, retryClassify } from "../api";

/** 교정 드롭다운용 최소 직원 정보(App 의 roster 와 동일 형태). */
export interface RosterEntry { id: string; title: string; name?: string; level?: string }

// status → {라벨, 아이콘, 문제여부}. 백엔드 ok/duplicate/unsupported/failed/too-large
// + 프론트 network/filtered.
const CATS: { key: string; icon: string; label: string; problem: boolean; hint?: string }[] = [
  { key: "ok", icon: "✅", label: "저장됨", problem: false },
  { key: "duplicate", icon: "♻️", label: "중복(이미 위키에 있음)", problem: false,
    hint: "같은 내용이라 다시 저장하지 않음 — 손실 아님" },
  { key: "unsupported", icon: "🚫", label: "미지원 포맷", problem: true,
    hint: "현재 추출기가 못 읽는 형식(.ppt/.doc 구버전 등)" },
  { key: "failed", icon: "⚠️", label: "추출 실패", problem: true,
    hint: "손상·암호화·폰트 깨짐 등 — 다른 형식으로 저장 후 재업로드" },
  { key: "network", icon: "📡", label: "네트워크 오류", problem: true,
    hint: "전송 실패 — 잠시 후 다시 업로드하면 됨" },
  { key: "too-large", icon: "📦", label: "용량 초과(25MB)", problem: true },
  { key: "filtered", icon: "⊘", label: "필터 제외(확장자)", problem: true,
    hint: "지원 확장자가 아니라 업로드되지 않음" },
];

// 한 파일의 분류(귀속) 상태 → 사람이 읽는 문구. cls 미도착(폴링 전)은 '분류 중'으로 취급.
function classifyLabel(st: ClassifyStatus | undefined, unavailable: boolean): string {
  if (unavailable) return "귀속 확인 불가";
  switch (st?.state) {
    case "done":
      return st.assigned.length ? `귀속: ${st.assigned.join(", ")}` : "공용 위키(특정 직원 귀속 없음)";
    case "failed": return "분류 실패 — 공용 위키로 유지";
    case "unknown": return "상태 유실(서버 재시작) — 자료는 저장됨";
    default: return "⏳ 분류 중…";
  }
}
// ingest(엔티티/개념 추출 + [[링크]]) 상태 → 사람이 읽는 문구. ingest 미시작이면 빈 문자열.
function ingestLabel(st: ClassifyStatus | undefined): string {
  switch (st?.ingest?.state) {
    case "done": {
      const e = st.ingest.entities;
      return e.length ? `🔗 엔티티 ${e.length}개(${e.slice(0, 3).join(", ")}${e.length > 3 ? " 외" : ""})` : "엔티티 없음";
    }
    case "failed": return "엔티티 추출 실패";
    case "pending": return "⏳ 엔티티 추출 중…";
    default: return "";
  }
}

export default function UploadSummary({ results, onClose, roster = [] }: {
  results: UploadFileResult[]; onClose: () => void; roster?: RosterEntry[];
}) {
  const by: Record<string, UploadFileResult[]> = {};
  for (const r of results) (by[r.status] ||= []).push(r);
  const total = results.length;
  const savedRows = by["ok"] || [];
  const saved = savedRows.length;

  // 분류 상태 폴링 — 저장된(ok) 파일의 ref들로, pending이 남아 있는 동안만 4초 간격.
  // 엔드포인트가 없거나(구버전 서버) 오류면 1회 만에 '확인 불가'로 멈춘다(fail-open).
  const [cls, setCls] = useState<Record<string, ClassifyStatus>>({});
  const [clsUnavailable, setClsUnavailable] = useState(false);
  const [pollKey, setPollKey] = useState(0);  // 재시도 후 폴링 재가동 트리거
  const [fixRef, setFixRef] = useState<string | null>(null);  // 교정 드롭다운이 열린 행
  useEffect(() => {
    const refs = (by["ok"] || []).map((r) => r.ref).filter((x): x is string => !!x);
    if (!refs.length) return;
    let stop = false;
    let timer = 0;
    const tick = async () => {
      const m = await fetchClassifyStatus(refs);
      if (stop) return;
      if (!m) { setClsUnavailable(true); return; }
      setCls(m);
      if (Object.values(m).some((v) => v.state === "pending" || v.ingest?.state === "pending")) timer = window.setTimeout(tick, 4000);
    };
    timer = window.setTimeout(tick, 600);
    return () => { stop = true; window.clearTimeout(timer); };
    // results 가 바뀌면(배치 추가 합산) refs 재계산; pollKey 는 재시도 재가동
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, pollKey]);

  // 실패 건 수동 재시도 — 서버 큐의 attempts 를 리셋하고 분류를 다시 건다(③ 재시도 경로).
  const failedRefs = (by["ok"] || [])
    .filter((r) => r.ref && cls[r.ref]?.state === "failed")
    .map((r) => r.ref as string);
  const doRetry = async () => {
    const n = await retryClassify(failedRefs);
    if (n === null) { window.alert("재시도 요청 실패 — 서버 연결을 확인하세요"); return; }
    setCls((prev) => {
      const next = { ...prev };
      for (const ref of failedRefs) next[ref] = { state: "pending", assigned: [] };
      return next;
    });
    setPollKey((k) => k + 1);
  };

  const stOf = (r: UploadFileResult) => (r.ref ? cls[r.ref] : undefined);
  const pageN = savedRows.filter((r) => r.page_id).length;
  const doneRows = savedRows.filter((r) => stOf(r)?.state === "done");
  const assignedN = doneRows.filter((r) => (stOf(r)?.assigned.length ?? 0) > 0).length;
  const pendingN = clsUnavailable ? 0
    : savedRows.filter((r) => r.ref && (stOf(r)?.state ?? "pending") === "pending").length;

  return (
    <div className="metric-overlay" onClick={onClose}>
      <div className="metric-modal" onClick={(e) => e.stopPropagation()} style={{ width: 620, height: "auto", maxHeight: "82vh" }}>
        <div className="metric-head">
          <span className="metric-ic">📁</span>
          <div className="metric-titles">
            <b>자료 업로드 정산</b>
            <span>총 {total}건 중 {saved}건 저장 · 나머지 사유별 분류</span>
          </div>
          <button className="metric-x" onClick={onClose} title="닫기 (Esc)">✕</button>
        </div>
        <div className="metric-scroll">
          {/* 집계 칩 줄 — 저장 단계별 증거(원문/위키 페이지/귀속) 포함 */}
          <div className="metric-cats">
            {CATS.filter((c) => (by[c.key] || []).length).map((c) => (
              <span key={c.key} className="metric-cat">{c.icon} {c.label} <b>{by[c.key].length}</b></span>
            ))}
            {saved > 0 && <span className="metric-cat">📄 위키 페이지 <b>{pageN}</b></span>}
            {saved > 0 && !clsUnavailable && (
              <span className="metric-cat">
                🏷️ 직원 귀속 <b>{assignedN}</b>{pendingN > 0 ? <> · ⏳ 분류 중 <b>{pendingN}</b></> : null}
              </span>
            )}
            {failedRefs.length > 0 && (
              <button className="metric-cat upload-retry" onClick={doRetry}
                title="실패한 분류를 다시 시도합니다(자료 저장과는 무관)">
                🔁 분류 재시도 <b>{failedRefs.length}</b>
              </button>
            )}
          </div>
          {clsUnavailable && saved > 0 && (
            <p className="metric-row-meta" style={{ padding: "2px 2px 6px" }}>
              ⓘ 직원 귀속 상태를 조회할 수 없습니다(서버 재시작 후 업로드부터 표시됩니다). 자료 저장 자체는 위 집계대로 완료.
            </p>
          )}
          {/* 문제 카테고리는 파일 목록까지 — 무엇을 손봐야 하는지 보이게 */}
          {CATS.filter((c) => c.problem && (by[c.key] || []).length).map((c) => (
            <div key={c.key} className="metric-group">
              <div className="metric-group-h">
                {c.icon} {c.label} <span>· {by[c.key].length}</span>
                {c.hint && <span className="upload-cat-hint"> — {c.hint}</span>}
              </div>
              <ul className="metric-list">
                {by[c.key].slice(0, 50).map((r, i) => (
                  <li key={i} className="metric-row">
                    <div className="metric-row-main">
                      <span className="metric-row-title">{r.title || r.file}</span>
                    </div>
                    {r.note && <div className="metric-row-meta">{r.note}</div>}
                  </li>
                ))}
                {by[c.key].length > 50 && <li className="metric-row-meta" style={{ padding: "4px 2px" }}>… 외 {by[c.key].length - 50}건</li>}
              </ul>
            </div>
          ))}
          {/* 저장된 파일 — 행별 저장 증거(원문 raw · 위키 페이지 · 직원 귀속) */}
          {saved > 0 && (
            <div className="metric-group">
              <div className="metric-group-h">✅ 저장됨 <span>· {saved}</span>
                <span className="upload-cat-hint"> — 원문(raw)·위키 페이지·직원 귀속 단계별 확인</span>
              </div>
              <ul className="metric-list">
                {savedRows.slice(0, 50).map((r, i) => (
                  <li key={i} className="metric-row">
                    <div className="metric-row-main">
                      <span className="metric-row-title">{r.title || r.file}</span>
                    </div>
                    <div className="metric-row-meta">
                      원문 {r.ref ? "✓" : "—"} · 위키 페이지 {r.page_id ? "✓" : "—"} · {classifyLabel(stOf(r), clsUnavailable)}{stOf(r)?.ingest ? ` · ${ingestLabel(stOf(r))}` : ""}
                      {/* 오귀속 교정(분기+): 분류 완료/실패 건은 직원 선택으로 재귀속 */}
                      {r.ref && roster.length > 0 && ["done", "failed"].includes(stOf(r)?.state ?? "") && (
                        fixRef === r.ref ? (
                          <select
                            className="reassign-select" autoFocus defaultValue=""
                            onBlur={() => setFixRef(null)}
                            onChange={async (e) => {
                              const to = e.target.value;
                              setFixRef(null);
                              if (!to || !r.ref) return;
                              const res = await reassignSource(r.ref, to);
                              if (!res) { window.alert("재귀속 실패 — 서버 연결을 확인하세요"); return; }
                              setCls((prev) => ({ ...prev, [r.ref as string]: { state: "done", assigned: [res.assigned_label] } }));
                            }}>
                            <option value="" disabled>올바른 담당 직원…</option>
                            {roster.filter((e) => e.level !== "ceo").map((e) => (
                              <option key={e.id} value={e.id}>{e.name ? `${e.name} ` : ""}{e.title}</option>
                            ))}
                          </select>
                        ) : (
                          <button className="reassign-btn" title="이 자료의 직원 귀속을 교정합니다"
                            onClick={() => setFixRef(r.ref ?? null)}>✎ 교정</button>
                        )
                      )}
                    </div>
                  </li>
                ))}
                {saved > 50 && <li className="metric-row-meta" style={{ padding: "4px 2px" }}>… 외 {saved - 50}건</li>}
              </ul>
            </div>
          )}
          {saved > 0 && !CATS.some((c) => c.problem && (by[c.key] || []).length) && pendingN === 0 && !clsUnavailable && (
            <p className="metric-empty">모든 자료가 정상 저장되었습니다 🎉</p>
          )}
        </div>
      </div>
    </div>
  );
}
