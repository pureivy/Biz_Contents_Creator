import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import { startRun, resumeRun, watchRun, RunHandle } from "./transport/sse";
import { fetchRuns, fetchRunLog, decideApproval, deleteRun, sendMessage, fetchApprovals, fetchCompany, uploadSources, uploadRunAttachments, fetchPersonas, PersonaOpt, fetchEta, reviseRun, fetchRunSettings, updateRunSettings, fetchAutonomyStatus, sttUpload, getVoices, setVoiceConversational, RunInfo, UploadFileResult, EtaStats, RunSettings } from "./api";
import { ActivityItem, ApprovalItem, DebateMsg, UIState } from "./events/types";
import AgentGraph from "./panels/AgentGraph";
import OfficeView from "./panels/OfficeView";
import EmployeesView from "./panels/EmployeesView";
import ApiKeysView from "./panels/ApiKeysView";
import LlmSettingsView from "./panels/LlmSettingsView";
import McpView from "./panels/McpView";
import BrandView from "./panels/BrandView";
import ContentCalendar from "./panels/ContentCalendar";
import DraftReview from "./panels/DraftReview";
import PerformanceView from "./panels/PerformanceView";
import StudioView from "./panels/StudioView";
import Ico from "./panels/Ico";
import { Theme, initialTheme, applyTheme } from "./theme";
import { useStageWidths } from "./panels/useStageWidths";
import { countWorking } from "./events/working";
import OfficeTicker, { ga } from "./panels/OfficeTicker";
import Avatar from "./panels/Avatar";
import ActivityFeed from "./panels/ActivityFeed";
import WorkflowBoard, { PhaseStepper, OfficeProgressBar } from "./panels/WorkflowBoard";
import { TERMINAL } from "./panels/workflowStages";
import ReplayBar from "./panels/ReplayBar";
import DashboardBar from "./panels/DashboardBar";
import MetricDrawer, { MetricKind } from "./panels/MetricDrawer";
import UploadSummary from "./panels/UploadSummary";
import LiveNowStrip from "./panels/LiveNowStrip";
import { debateGist } from "./events/debateSummary";
import { agentColor, agentGlyph, personLabel } from "./panels/agentVisual";
import { useRecorder } from "./voice/useRecorder";
import { useTts } from "./voice/useTts";
import { Waveform } from "./voice/Waveform";
import { mergeTranscript } from "./voice/transcript";
import { useJarvis } from "./jarvis/useJarvis";
import { useJarvisVoice } from "./voice/useJarvisVoice";
import { JarvisAvatar } from "./jarvis/JarvisAvatar";
// 무거운 그래프 라이브러리(react-force-graph)는 모달을 열 때만 로드(초기 번들에서 분리).
const WikiGraphView = lazy(() => import("./panels/WikiGraphView"));

const AUTONOMY_LABEL = ["Off", "읽기전용", "초안(승인)", "자동"];

// Timeline move → colored mission-control tag (label + css class), like the reference's
// protocol chips. Unknown moves fall back to a neutral "보고/report" tag.
const MOVE_TAG: Record<string, { label: string; cls: string }> = {
  position: { label: "입장", cls: "position" },
  critique: { label: "비평", cls: "critique" },
  rebuttal: { label: "반박", cls: "rebuttal" },
  agent_message: { label: "보고", cls: "report" },
  deliverable: { label: "산출물", cls: "deliverable" },
  user: { label: "지시", cls: "user" },
  synthesis: { label: "종합", cls: "synth" },
};
// Run state → uppercase protocol label for the timeline status banner
// (RUN · ACTIVE / SESSION · COMPLETE), matching the reference's mission-control header.
function protocolLabel(status: string): string {
  switch (status) {
    case "running": return "RUN · ACTIVE";
    case "ok": return "SESSION · COMPLETE";
    case "partial": return "SESSION · PARTIAL";
    case "cancelled": return "SESSION · CANCELLED";
    case "interrupted": return "SESSION · INTERRUPTED";
    case "error": case "budget_exceeded": return "SESSION · ERROR";
    default: return status.toUpperCase();
  }
}

// A live "현재 진행" line for the timeline, derived from team/_ceo phases — so the
// decompose/assign stages (run by forced-tool queries that DON'T stream into the
// timeline) still show what's happening instead of a bare "RUN · ACTIVE". Teams run
// sequentially, so at most one team phase is non-idle at a time.
// (백엔드가 emit 하는 phase 와 1:1 — brief·report_ceo 는 발행되지 않으므로 멘트도 두지 않는다.)
const PHASE_NOTE: Record<string, (team: string) => string> = {
  decompose: (n) => `🧩 ${n} 팀장이 팀원 과제를 분해·배정하는 중…`,
  assign: (n) => `📌 ${n} 팀장이 팀원에게 과제를 지시하는 중…`,
  work: (n) => `✍️ ${n} 팀원들이 작업하는 중…`,
  debate: (n) => `💬 ${n} 팀원들이 상호검증 토론 중…`,
  report: (n) => `🔍 ${n} 팀장이 팀원 보고를 검토·취합하는 중…`,
};
function progressNote(
  phases: Record<string, string>,
  teams: Record<string, { name: string }>,
  status: string,
  soloNote?: (tid: string, ph: string) => string | null,  // 팀원 없는 솔로 팀(비서실) 전용 멘트
): string {
  if (status !== "running") return "";
  const ceo = phases["_ceo"];
  if (ceo === "delegate") return "🧩 편집장이 목표를 팀별 과제로 분해하는 중…";
  if (ceo === "review") return "🔎 편집장이 팀 산출물을 검토하는 중…";
  if (ceo === "integrate") return "🧩 편집장이 팀 산출물을 통합하는 중…";
  for (const tid in phases) {
    if (tid === "_ceo") continue;
    const ph = phases[tid];
    if (ph && ph !== "idle" && PHASE_NOTE[ph])
      return soloNote?.(tid, ph) ?? PHASE_NOTE[ph](teams[tid]?.name ?? tid);
  }
  return "⏳ 편집장이 목표를 분석하는 중…";
}

type View = "office" | "graph" | "detail" | "employees" | "apikeys" | "llm" | "mcp" | "calendar" | "review" | "perf" | "studio" | "brand";
type TLTab = "timeline" | "activity" | "workflow";

const STATUS_LABEL: Record<string, string> = {
  idle: "대기",
  running: "진행 중",
  ok: "완료",
  done: "완료",
  partial: "부분 완료",
  cancelled: "취소됨",
  budget_exceeded: "예산 초과",
  error: "오류",
  interrupted: "중단됨",
};
// TERMINAL 은 workflowStages 의 단일 정의를 공유 — 사본이 'done'(잡 런 종료 status) 누락으로 갈라졌던 실사고(2026-07-22).
// 외부 자료로 받을 확장자. 폴더 업로드 시 하위 파일을 이 목록으로 거른다(이미지·기타 제외).
// 백엔드(kordoc·내장 파서·OCR)가 추출 가능한 + 시도해볼 만한 공문서 포맷.
// kordoc: hwp/hwpx/hwpml/pdf/xls/xlsx/docx · 내장: txt/md/csv/rtf · OCR: 이미지.
// ppt/pptx/doc(구포맷)는 현재 미지원이지만 프론트에서 막지 않고 올려 '미지원'으로
// 정산에 보고한다(조용한 누락 제거 — 사용자 지시).
const ALLOWED_EXT = [".pdf", ".docx", ".doc", ".xlsx", ".xlsm", ".xls", ".pptx", ".ppt",
  ".hwp", ".hwpx", ".hwpml", ".txt", ".md", ".markdown", ".rtf", ".csv", ".log",
  ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"];

type Employee = { id: string; title: string; name?: string; level?: string };

// Detect a leading "직원명" in the timeline-chat text → route to a single-employee
// directed run. "권이담 4천만원 용역?" → {id, rest:"4천만원 용역?"}. Consumes an
// optional title token ("권이담 과장 …") and trailing particles ("권이담에게").
// Requires a remaining question, so a bare name never routes. null = none named.
const _TITLE_TOKEN = /^(팀장|차장|과장|대리|주임|사원|부장|이사|사장|대표)$/;
function matchEmployee(text: string, roster: Employee[]): { id: string; rest: string } | null {
  if (!roster.length) return null;
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const take = parts.length >= 2 && _TITLE_TOKEN.test(parts[1].replace(/[,.:]/g, "")) ? 2 : 1;
  const cand = parts.slice(0, take).join("").replace(/[\s,.:/·]+$/, "").replace(/(에게|한테|께|님|씨|분)+$/, "");
  const norm = cand.replace(/\s+/g, "");
  if (!norm) return null;
  const rest = parts.slice(take).join(" ").trim();
  if (!rest) return null;
  const hit = roster.find((r) => {
    const rt = r.title.replace(/\s+/g, "");          // 직무(예: 전략기획팀장)
    const person = (r.name || "").replace(/\s+/g, ""); // 실명(예: 장은영)
    if (rt === norm || person === norm) return true;   // 직무·실명 둘 다로 지명 가능
    if (person && norm.length >= 2 && (person.startsWith(norm) || norm.startsWith(person))) return true;
    return norm.length >= 2 && rt.startsWith(norm);
  });
  return hit ? { id: hit.id, rest } : null;
}

// 입력이 '직원명 [직책]' 만으로 완성됐는지(질문 없이) 판정 — 대상 칩 토큰화용.
// 이름 파싱은 matchEmployee 를 재사용(더미 질문 'q' 부착)하고, 질문이 이미 있으면 null.
function matchEmployeeName(
  text: string, roster: Employee[],
): { id: string; label: string; lead: boolean } | null {
  const m = matchEmployee(text.trim() + " q", roster);
  if (!m || m.rest !== "q") return null;
  const r = roster.find((x) => x.id === m.id);
  if (!r) return null;
  return { id: m.id, label: personLabel(r.name, r.title) || r.title, lead: r.level === "lead" };
}

// One timeline message: text is clamped to a few lines and expands on demand,
// so the column stays scannable. "더보기" only appears when the text actually
// overflows the clamp (measured after render while clamped).
function TimelineMessage({
  m,
  roleLabel,
  avatarId,
  glyph,
  wikiPages,
  selfName,
  rosterNames,
  tts,
  ttsAvail,
}: {
  m: DebateMsg;
  roleLabel: string;
  avatarId?: string | null;
  glyph?: string;
  wikiPages: UIState["wikiPages"];
  selfName?: string;
  rosterNames?: string[];
  tts: ReturnType<typeof useTts>;
  ttsAvail?: boolean;
}) {
  // 카드 파형 표시 게이트 — store.speakingSeq 가 이 카드의 seq 와 같을 때만(useTts 가 갱신).
  const speakingSeq = useStore((st) => st.speakingSeq);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = textRef.current;
    if (el && !expanded) setOverflows(el.scrollHeight - el.clientHeight > 4);
  }, [m.text, expanded]);
  // user(사용자 지시)·deliverable(팀 산출물)·synthesis(최종 종합)는 완결·중요 메시지라
  // 전문 유지. 그 외 토론 발언은 2줄 요지(누구/무엇 + 어떻게/왜) + 대상 동료(→)로 압축,
  // 클릭 시 전문 펼침. gist는 순수 텍스트 파생(LLM 없음).
  const full = m.move === "user" || m.move === "deliverable" || m.move === "synthesis";
  const gist = useMemo(
    () => (full ? null : debateGist(m.text, selfName, rosterNames)),
    [full, m.text, selfName, rosterNames],
  );
  const targets = gist?.targets ?? [];
  return (
    <div className={`msg move-${m.move}`}>
      <div className="msg-head">
        <span className="msg-who">
          {avatarId && <Avatar id={avatarId} glyph={glyph ?? "🧑‍💻"} size={22} head />}
          <b>{roleLabel}</b>
          {targets.length > 0 && (
            <span className="msg-target" title={`대상: ${targets.join(", ")}`}>
              <span className="msg-target-arrow">→</span>
              {targets.slice(0, 2).join("·")}{targets.length > 2 ? ` 외${targets.length - 2}` : ""}
            </span>
          )}
        </span>
        <span className={`msg-tag tag-${(MOVE_TAG[m.move] ?? { cls: "report" }).cls}`}>
          {m.move === "user" || m.move === "deliverable" || m.move === "synthesis"
            ? MOVE_TAG[m.move]?.label ?? m.move
            : `R${m.round} · ${MOVE_TAG[m.move]?.label ?? m.move}`}
        </span>
        <button
          type="button"
          className="voice-speak"
          title={ttsAvail ? "이 메시지 음성으로 듣기" : "음성 출력 미설치(say·ffmpeg 필요)"}
          disabled={!ttsAvail}
          onClick={() => tts.speak(m.text, m.seq)}
        >🔊</button>
        {speakingSeq === m.seq && tts.analyser && (
          <Waveform analyser={tts.analyser} variant="card" active />
        )}
      </div>
      {full ? (
        <>
          <div ref={textRef} className={`msg-text${expanded ? "" : " clamped"}`}>{m.text}</div>
          {(overflows || expanded) && (
            <button className="msg-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "접기" : "더보기"}
            </button>
          )}
        </>
      ) : expanded ? (
        <>
          <div className="msg-text">{m.text}</div>
          <button className="msg-more" onClick={() => setExpanded(false)}>접기</button>
        </>
      ) : (
        <button className="msg-gist" onClick={() => setExpanded(true)} title="클릭하면 전문 보기">
          <span className="msg-gist-body">
            <span className="msg-gist-headline">{gist?.headline || "(내용 보기)"}</span>
            {gist?.detail && <span className="msg-gist-detail">{gist.detail}</span>}
          </span>
          <span className="msg-gist-caret">▸</span>
        </button>
      )}
      {m.refs.length > 0 && (
        <div className="refs">
          {m.refs.map((r) => (
            <span key={r} className="ref-chip">[[{wikiPages[r]?.title ?? r}]]</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const s = useStore();
  const apply = useStore((st) => st.applyEvent);
  const reset = useStore((st) => st.reset);
  const clearToIdle = useStore((st) => st.clearToIdle);
  const setRunId = useStore((st) => st.setRunId);
  const loadReplay = useStore((st) => st.loadReplay);
  const snapshotLive = useStore((st) => st.snapshotLive);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  // 딥링크 ?piece=<id> — 텔레그램 검토 알림 링크가 검토 탭의 해당 초안을 바로 연다(1회성, 마운트 시 확정).
  const [deepLinkPiece] = useState<string | null>(() => new URLSearchParams(window.location.search).get("piece"));
  const [view, setView] = useState<View>(() => (deepLinkPiece ? "review" : "office"));
  // 파라미터는 캡처 즉시 URL 에서 제거 — 남겨두면 새로고침마다 검토 탭으로 끌려간다(?run= 정리와 동일한 위생).
  useEffect(() => {
    if (!deepLinkPiece) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("piece");
    window.history.replaceState(null, "", url);
  }, [deepLinkPiece]);
  const [tlTab, setTlTab] = useState<TLTab>("timeline");  // 토론 타임라인 창: 타임라인 | 활동
  const [showHist, setShowHist] = useState(false);
  const histWrapRef = useRef<HTMLDivElement>(null);  // '📑 기록' 풀다운 바깥클릭 닫기용
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [chat, setChat] = useState("");
  const recorder = useRecorder();  // 홀드 녹음(push-to-talk) → STT
  const tts = useTts();            // 메시지/최종결과 낭독(단일 인스턴스 = AudioContext 1개 공유)
  const [voiceAvail, setVoiceAvail] = useState({ stt: false, tts: false });
  const [convo, setConvo] = useState(false);                 // 자비스 대화형
  useEffect(() => { getVoices().then((v) => setConvo(!!(v as { conversational?: boolean }).conversational)); }, []);
  // 자비스가 주도해 시작한 런 id 집합 — 자동낭독 skip 가드와 보고 턴 트리거에 사용.
  const jarvisRunIds = useRef<Set<string>>(new Set());
  // 자비스 대화 스레드 — 새 턴/생각중 표시 시 항상 최신(맨 아래)으로 스크롤.
  const jarvisThreadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = jarvisThreadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.jarvisTurns.length, s.jarvisBusy]);
  const jarvis = useJarvis(tts, async (task, agent) => {
    handleRef.current?.cancel();                              // 진행 중 런 취소(기존 directed 분기와 동일)
    reset(task);
    try {
      // 자비스가 고른 직원이 있으면 그 직원 단독 런(directed) — 없으면 사장(전사) 런으로 위임.
      handleRef.current = await startRun(
        task, (ev) => apply(ev), (rid) => { jarvisRunIds.current.add(String(rid)); setRunId(rid); },
        () => useStore.getState().lastSeq, { agent },
      );
    } catch (e) { useStore.getState().pushJarvisTurn({ role: "jarvis", text: `(위임 실패) ${(e as Error).message}` }); }
  });
  // 핸즈프리 자비스 — JARVIS 모드(convo) 동안 상시 청취 + 웨이크워드("자비스") 또는 버튼 탭 활성화 + VAD.
  const jv = useJarvisVoice({
    enabled: convo && voiceAvail.stt,
    speaking: tts.speakingSeq !== null,
    sttUpload,
    send: jarvis.send,
  });
  const toggleConvo = () => { const next = !convo; if (next) tts.prime(); setConvo(next); setVoiceConversational(next); };

  // 마운트 시 1회 — 음성 도구 가용성 체크(mlx_whisper/say/ffmpeg 설치 여부)
  useEffect(() => {
    getVoices().then(v => setVoiceAvail({ stt: v.sttAvailable, tts: v.ttsAvailable }));
  }, []);

  // 홀드 녹음 종료 → STT → (대화형이면)자비스 자동 전송 / 아니면 입력창 합성.
  const handleMicUp = async () => {
    if (!voiceAvail.stt) return;
    const blob = await recorder.stop();
    if (!blob) return;
    const text = await sttUpload(blob);
    if (!text) return;
    if (convo) await jarvis.send(text);                      // 대화형: 자비스에게 자동 전송
    else setChat((prev) => mergeTranscript(prev, text));     // 기존: 입력창 채움
  };
  // 좌하단 입력 대상 칩 — 직원명을 토큰화해 입력창엔 질문만 남긴다. null=전사 토론/지시.
  const [directedTarget, setDirectedTarget] = useState<{ id: string; label: string; lead: boolean } | null>(null);
  const [roster, setRoster] = useState<Employee[]>([]);
  const [ceoName, setCeoName] = useState("");  // 이름 표시용(roster엔 제외 — 지명 라우팅 대상 아님)
  const [companyMeta, setCompanyMeta] = useState({ name: "", total: 0 });
  const [uploadProg, setUploadProg] = useState<{ done: number; total: number } | null>(null);
  // 업로드 정산 — 끝나면 저장/중복/미지원/실패/필터제외 집계를 패널로 표시.
  const [uploadDone, setUploadDone] = useState<{ results: UploadFileResult[] } | null>(null);
  // 파일·폴더 통합 업로드 풀다운(상단바 '📎 자료 ▾')
  const [uploadMenu, setUploadMenu] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const [showBrain, setShowBrain] = useState(false);  // "제2의 두뇌" 위키 그래프 모달
  const [metric, setMetric] = useState<MetricKind | null>(null);  // 대시보드 지표 드릴다운
  // 3패널(타임라인|사무실|산출물) 가로 폭 — 핸들 드래그로 조절, localStorage 영속.
  const { widths, startDrag, reset: resetWidth, outputsOpen, setOutputsOpen } = useStageWidths();
  // 3단 런 경로(①). "" = 자동 추천 / "team"(경량) / "full"(전사).
  const [runPath, setRunPath] = useState("");
  // 런별 예산 캡(USD). "" = 전역 기본 / "0" = 무제한 명시 / 그 외 = 캡.
  const [runBudget, setRunBudget] = useState("");
  // 컴포저 첨부(멀티모달: 이미지 + 문서) — 시작 시 /runs/attachments 로 업로드해 경로를 런에 전달.
  // objectURL 은 첨부 시 1회 생성·제거 시 revoke(렌더마다 생성하면 타이핑 중 누수).
  const [topicImages, setTopicImages] = useState<Array<{ file: File; url: string }>>([]);
  // 문서 첨부(PDF·HWP/HWPX·DOCX·PPTX·XLSX·텍스트) — 서버가 텍스트 추출해 주제에 병합(이 런 전용, 자료실 미적재).
  const [topicDocs, setTopicDocs] = useState<File[]>([]);
  // 지식 리서치 런 토글 — 켜고 시작하면 조사→토론→두뇌 적재 런(발행 초안 없음, 캘린더 비오염). 시작 후 자동 해제.
  const [researchMode, setResearchMode] = useState(false);
  // 테마(다크 기본 / 라이트 옵트인) — 초기값은 main.tsx 가 이미 <html>에 심었고, 여기선 상태만 동기.
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggleTheme = () => setTheme((t) => { const next: Theme = t === "dark" ? "light" : "dark"; applyTheme(next); return next; });
  // 블로그 작가 말투(페르소나) — 서버 목록에서 선택. custom 이면 personaText 입력창 노출. 시작 후에도 유지(다음 글도 같은 말투).
  const [personas, setPersonas] = useState<PersonaOpt[]>([]);
  const [persona, setPersona] = useState("");
  const [personaText, setPersonaText] = useState("");
  const topicImgInputRef = useRef<HTMLInputElement>(null);
  // 서버 extract.ts 지원 확장자와 동기(isSupportedExt).
  const DOC_EXTS = new Set(["pdf", "docx", "pptx", "hwpx", "hwp", "hwp3", "hwpml", "xlsx", "xls", "txt", "md", "markdown", "csv", "json", "text", "log"]);
  const addTopicFiles = (files: FileList | File[]) => {
    const all = Array.from(files);
    const imgs = all.filter((f) => f.type.startsWith("image/"));
    const docs = all.filter((f) => !f.type.startsWith("image/") && DOC_EXTS.has((f.name.split(".").pop() || "").toLowerCase()));
    // objectURL 은 캡(각 8개)을 밖에서 적용한 뒤 이벤트 핸들러에서 1회 생성 — 상태 업데이터 안에서 만들면
    // StrictMode 이중 호출·slice 탈락분이 revoke 없이 새어 나가고, 탈락 자체도 무통보였다.
    const takeImgs = imgs.slice(0, Math.max(0, 8 - topicImages.length)); // Claude 비전 캡 8장
    const takeDocs = docs.slice(0, Math.max(0, 8 - topicDocs.length));
    if (takeImgs.length) {
      const entries = takeImgs.map((f) => ({ file: f, url: URL.createObjectURL(f) }));
      setTopicImages((prev) => [...prev, ...entries]);
    }
    if (takeDocs.length) setTopicDocs((prev) => [...prev, ...takeDocs]);
    const unsupported = all.length - imgs.length - docs.length;
    const overCap = (imgs.length - takeImgs.length) + (docs.length - takeDocs.length);
    const msgs: string[] = [];
    if (unsupported > 0) msgs.push(`미지원 형식 ${unsupported}개`);
    if (overCap > 0) msgs.push(`개수 상한(각 8개) 초과 ${overCap}개`);
    if (msgs.length) window.alert(`${msgs.join(", ")} 제외 — 이미지·PDF·HWP/HWPX·DOCX·PPTX·XLSX·텍스트, 각 최대 8개만 첨부됩니다`);
  };
  const removeTopicImage = (i: number) => {
    setTopicImages((prev) => { const t = prev[i]; if (t) URL.revokeObjectURL(t.url); return prev.filter((_, j) => j !== i); });
  };
  const removeTopicDoc = (i: number) => setTopicDocs((prev) => prev.filter((_, j) => j !== i));
  const clearTopicAttachments = () => {
    setTopicImages((prev) => { prev.forEach((t) => URL.revokeObjectURL(t.url)); return []; });
    setTopicDocs([]);
  };
  const handleRef = useRef<RunHandle | null>(null);
  const submittingRef = useRef(false); // double-submit guard
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const refreshRuns = () => fetchRuns().then(setRuns);
  useEffect(() => { refreshRuns(); }, []);
  useEffect(() => { fetchPersonas().then(setPersonas); }, []);
  // ⑧ 최소 인증 부트스트랩 — 서버에 AUTH_TOKEN 이 설정돼 있으면(401) 토큰을 물어
  // 쿠키(studio_token)로 저장 후 재로드. fetch/SSE 모두 same-origin 쿠키로 통과.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/runs");
        if (r.status === 401) {
          const tok = window.prompt("🔒 이 서버는 접근 토큰이 필요합니다 (서버 AUTH_TOKEN 값):");
          if (tok && tok.trim()) {
            document.cookie = `studio_token=${encodeURIComponent(tok.trim())}; path=/; max-age=2592000; samesite=lax`;
            location.reload();
          }
        }
      } catch { /* 서버 다운 등 — 기존 흐름이 처리 */ }
    })();
  }, []);
  // Globally-pending approvals (incl. run-end tool-grant recommendations), hydrated
  // from GET /approvals so they survive reload / show across runs — not only while
  // watching the run that emitted them live.
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalItem[]>([]);
  const refreshApprovals = () => fetchApprovals().then(setPendingApprovals);
  useEffect(() => { refreshApprovals(); }, []);
  // Roster for the timeline-chat "직원 지명" routing (CEO + every team member).
  useEffect(() => {
    fetchCompany().then((c) => {
      if (!c) return;
      // CEO는 directed 라우팅에서 제외(= 명명 시 전사 런과 동일). 팀장/팀원만 지명 대상.
      // 비서(secretary·자비스)도 제외 — 자비스 대화는 자비스 패널 전담이라, '자비스/비서…' 접두 문장이
      // 지명 매칭돼 라이브 런을 취소하고 응대용 페르소나 솔로 런을 시작하는 오라우팅을 막는다.
      setRoster(
        c.teams.flatMap((t) => [t.lead, ...t.members]).filter((r) => r.id !== "secretary").map((r) => ({
          id: r.id, title: r.title, name: r.name, level: r.level,
        })),
      );
      setCeoName(c.ceo?.title ?? "");
      const total = 1 + c.teams.reduce((n, t) => n + 1 + t.members.length, 0); // CEO + 팀장/팀원
      setCompanyMeta({ name: c.name, total });
    });
  }, []);
  // when a live run finishes, add it to the history list + pull any approvals it
  // queued at the end (e.g. tool-grant recommendations).
  useEffect(() => {
    // 라이브 런의 상태가 바뀔 때마다(시작=running 포함) 기록 목록 갱신 — 종전엔 완료(TERMINAL) 시에만 갱신해
    // '진행 중' 런이 기록에 안 떴다(사용자 보고: 완료된 것만 나옴). approvals 는 종료 시에만 필요.
    if (s.mode === "live" && s.runId) { refreshRuns(); if (TERMINAL.has(s.status)) refreshApprovals(); }
  }, [s.status, s.runId, s.mode]);

  // 최종 결과(synthesis) 자동 낭독 — running→TERMINAL 전이 시 1회(라이브 한정). 합성은
  // DebateMsg 카드가 아니라 s.synthesis 문자열이므로 seq=-1(가상 식별자)로 읽는다.
  const autoReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (s.mode !== "live") return;                 // 리플레이 제외
    if (!convo) return;                             // 자비스(음성) OFF 면 자동 낭독 안 함 — 자율 런 산출물이 저절로 읽히던 문제.
    if (!TERMINAL.has(s.status)) return;            // 런 종료 시점만
    const key = `${s.runId}`;
    if (autoReadRef.current === key) return;        // 런당 1회
    if (jarvisRunIds.current.has(key)) { autoReadRef.current = key; return; } // 자비스 런은 자비스가 낭독 전담
    const text = (s.synthesis ?? "").trim();
    if (!text) return;
    autoReadRef.current = key;
    tts.speak(text, -1);                            // seq=-1: 최종 종합(카드 아님)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status, s.runId, s.mode, s.synthesis, convo]);

  // 자비스가 위임한 런 종료 시 — 합성 결과를 자비스 보고 턴으로 추가하고 낭독(1회).
  // 위 자동낭독은 jarvisRunIds skip 가드로 건너뛰므로 이중낭독되지 않는다.
  const jarvisReportRef = useRef<string | null>(null);
  useEffect(() => {
    if (s.mode !== "live" || !TERMINAL.has(s.status)) return;
    const key = String(s.runId);
    if (!jarvisRunIds.current.has(key)) return;               // 자비스 런만
    if (jarvisReportRef.current === key) return;              // 1회
    const text = (s.synthesis ?? "").trim();
    if (!text) return;
    jarvisReportRef.current = key;
    useStore.getState().pushJarvisTurn({ role: "jarvis", text });
    tts.speak(text, useStore.getState().jarvisTurns.length);  // 보고 낭독(기존 자동낭독은 skip됨)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status, s.runId, s.mode, s.synthesis]);

  // LLM 백엔드 상태(런 셀렉터 옵션 + 현재 effective 배지). 마운트 + 사무실 복귀 시 로드
  // 런타임 품질 설정(토론·추론) — 헤더 토글. 마운트 시 로드, 토글 시 POST 후 즉시 반영(다음 런부터 적용).
  const [runSettings, setRunSettingsState] = useState<RunSettings>({ orgDebateRounds: 0, agentThinking: false });
  useEffect(() => { fetchRunSettings().then(setRunSettingsState); }, []);
  const toggleDebate = () => updateRunSettings({ orgDebateRounds: runSettings.orgDebateRounds > 0 ? 0 : 1 }).then(setRunSettingsState);
  const toggleThinking = () => updateRunSettings({ agentThinking: !runSettings.agentThinking }).then(setRunSettingsState);

  // 업로드 풀다운 바깥 클릭 시 닫기
  useEffect(() => {
    if (!uploadMenu) return;
    const h = (e: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target as Node)) setUploadMenu(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [uploadMenu]);
  // '📑 기록' 풀다운 바깥 클릭 시 닫기(자료와 동일 동작)
  useEffect(() => {
    if (!showHist) return;
    const h = (e: MouseEvent) => {
      if (histWrapRef.current && !histWrapRef.current.contains(e.target as Node)) setShowHist(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showHist]);

  const cancel = () => handleRef.current?.cancel();

  // Upload external materials. A folder pick (webkitdirectory) yields every file under
  // it (recursively); we keep only supported extensions, then send them to /sources in
  // small batches so a progress bar can advance as each batch is ingested.
  const doUpload = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return;
    const picked = Array.from(fileList);
    const files = picked.filter((f) => ALLOWED_EXT.some((ext) => f.name.toLowerCase().endsWith(ext)));
    // 확장자 필터로 빠진 파일도 정산에 기록(조용한 누락 제거).
    const filtered: UploadFileResult[] = picked
      .filter((f) => !files.includes(f))
      .map((f) => ({ file: f.name, status: "filtered", note: "지원 확장자 아님" }));
    if (!files.length) {
      setUploadDone({ results: filtered });
      return;
    }
    const BATCH = 4;
    const results: UploadFileResult[] = [];
    setUploadProg({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        const slice = files.slice(i, i + BATCH);
        // Per-batch resilience: a single slow/dropped batch must NOT abort the whole
        // folder upload (the old behavior — one 'Failed to fetch' nuked everything).
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          try {
            const res = await uploadSources(slice);
            results.push(...res.results);
            done = true;
          } catch {
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            } else {
              results.push(...slice.map((f) => ({ file: f.name, status: "network", note: "네트워크 오류" })));
            }
          }
        }
        setUploadProg({ done: Math.min(i + BATCH, files.length), total: files.length });
      }
      setUploadDone({ results: [...results, ...filtered] });  // 정산 패널 표시
    } catch (err) {
      setUploadDone({ results: [{ file: "업로드", status: "failed", note: String(err) }, ...filtered] });
    } finally {
      setUploadProg(null);
    }
  };

  const loadPast = async (runId: string) => {
    if (!runId) return;
    handleRef.current?.detach();
    handleRef.current = null;
    const info = runs.find((r) => r.run_id === runId);
    const events = await fetchRunLog(runId);
    if (!events.length) {  // 삭제됐거나 없는 런 — URL 파라미터 정리하고 종료(빈 리플레이 방지)
      const url = new URL(window.location.href);
      url.searchParams.delete("run"); url.searchParams.delete("mode");
      window.history.replaceState(null, "", url);
      return;
    }
    loadReplay(runId, info?.topic ?? runId, events);
  };

  // Resume an interrupted run (server-restart recovery): re-drive it from the last
  // completed boundary and watch live. The SSE backlog rebuilds prior progress first.
  // 단, 서버는 아직 재구동을 지원하지 않고 501 을 돌려준다(오케스트레이터에 체크포인트
  // 인프라 부재 — server/main.ts 참고). 실패 시 idle 로 떨어뜨리지 말고 '기록 다시 보기'
  // (loadPast)로 우회해, 사용자가 빈 화면 대신 진행 과정·산출물을 보게 한다.
  const resume = async (runId: string) => {
    if (!runId || s.status === "running") return;
    handleRef.current?.detach();
    const info = runs.find((r) => r.run_id === runId);
    reset(info?.topic ?? runId);
    setRunId(runId);
    setShowHist(false);
    try {
      handleRef.current = await resumeRun(
        runId,
        (ev) => apply(ev),
        () => useStore.getState().lastSeq,
      );
    } catch (e) {
      window.alert(`재개 불가: ${(e as Error).message}\n기록(다시 보기)으로 엽니다.`);
      handleRef.current = null;
      await loadPast(runId);   // 빈 화면 대신 과거 진행을 재생
      refreshRuns();
    }
  };

  // Re-attach to an ALREADY-running run's live stream WITHOUT re-driving it. resume()
  // re-enters run_company (only valid for an interrupted run); after a page reload a
  // still-"running" run has no resume button, so this is the way back to watching it live.
  //
  // 과거 안무를 처음부터 재생하지 않도록: 먼저 백로그(/runs/:id/log)를 받아 snapshotLive
  // 로 '한 번에' 최종 상태로 fold(애니메이션 없이 현재 진행 상태로 즉시 스냅)한 뒤,
  // 마지막 seq 부터 watchRun 으로 라이브 tail 한다. getLastSeq()=lastSeq 이므로 SSE 재연결이
  // Last-Event-ID=lastSeq 를 보내 서버는 그 이후 이벤트만 보낸다(백로그 재전송·재애니메이션 없음).
  // 백로그 fetch 실패 시엔 종전대로 seq 0 부터 watchRun(안전 폴백).
  const watchLive = async (runId: string) => {
    if (!runId) return;
    handleRef.current?.detach();
    const info = runs.find((r) => r.run_id === runId);
    reset(info?.topic ?? runId);
    setRunId(runId);
    setShowHist(false);
    try {
      const backlog = await fetchRunLog(runId);
      // reset/setRunId 직후 동일 런을 보는 중일 때만 스냅(사용자가 그새 다른 화면으로
      // 이동했으면 존중 — 늦게 도착한 백로그가 새 화면을 덮어쓰지 않게).
      if (useStore.getState().runId === runId) {
        snapshotLive(runId, info?.topic ?? runId, backlog);
      }
    } catch {
      // 백로그 로드 실패 — watchRun 이 seq 0 부터 다시 채운다(기존 동작).
    }
    if (useStore.getState().runId !== runId) return; // 그새 떠났으면 스트림 안 붙임
    handleRef.current = watchRun(
      runId,
      (ev) => apply(ev),
      () => useStore.getState().lastSeq,
    );
  };

  // 좌상단 로고 클릭 → 초기화면. 실행 중인 런은 취소가 아니라 라이브 스트림만
  // 떼고(detach) 빈 홈으로 — 런은 서버에서 계속되고 기록에서 다시 열 수 있다.
  const goHome = () => {
    handleRef.current?.detach();
    handleRef.current = null;
    clearToIdle();          // 런 상태를 초기(빈)값으로
    setView("office");      // 기본 뷰(사무실)
    setShowHist(false);
    setShowBrain(false);
    setMetric(null);
    setUploadDone(null);
    setDirectedTarget(null);
  };

  // ⑦ URL 상태 복구 — 보고 있는 런을 ?run=<id>&mode=live|replay 로 주소창에 반영
  // (replaceState라 히스토리 오염 없음). 새로고침해도 idle로 떨어지지 않고, 링크를
  // 복사하면 같은 런 화면이 공유된다.
  const urlRestoredRef = useRef(false);   // 최초 복구 시도 완료 전엔 초기 ""가 파라미터를 못 지우게
  const hadRunRef = useRef(false);
  useEffect(() => {
    if (!urlRestoredRef.current && !s.runId) return;
    const url = new URL(window.location.href);
    if (s.runId) {
      url.searchParams.set("run", s.runId);
      url.searchParams.set("mode", s.mode);
      hadRunRef.current = true;
    } else if (hadRunRef.current) {
      url.searchParams.delete("run");
      url.searchParams.delete("mode");
    }
    window.history.replaceState(null, "", url);
  }, [s.runId, s.mode]);
  // 첫 런 목록이 도착하면 1회 복구: running 런은 라이브 재접속(watchLive — 재구동
  // 아님), 끝난 런(또는 이미 끝났는데 mode=live로 남은 경우)은 리플레이로 연다.
  useEffect(() => {
    if (urlRestoredRef.current || runs.length === 0) return;
    urlRestoredRef.current = true;
    const p = new URLSearchParams(window.location.search);
    const rid = p.get("run");
    if (!rid || useStore.getState().runId) return;  // 이미 다른 런을 보는 중이면 존중
    const info = runs.find((r) => r.run_id === rid);
    // info 가 없어도(자율런은 /runs 목록에서 제외됨) loadPast 가 직접 fetch 해 리플레이한다.
    // 정말 없는 런이면 loadPast 가 빈 이벤트를 보고 URL 을 정리한다.
    if (p.get("mode") === "live" && info?.status === "running") watchLive(rid);
    else loadPast(rid);
  }, [runs]);

  // 활성 런 자동 관전 — 사용자가 라이브 런을 보고 있지 않고(=running 아님) 과거 런 리플레이도 아닐 때,
  // 진행 중인 '최신 활성 런'에 자동 연결해 오피스뷰가 살아 움직이게 한다(능동실행 오토플레이 취지).
  // 카드뉴스·숏폼 파생은 블로그 런 완료 뒤 서버가 별도 런으로 띄우므로(launchCardNewsRun/launchShortsRun,
  // 독립 run_id·버스로 phase·작업 스트림 방출), 프론트가 최신 활성 런에 붙기만 하면 송하영·민준호·서준영이
  // 실제로 일하는 모습이 오피스뷰에 그대로 이어진다. 자율 사이클 런도 동일하게 잡힌다(활성 런이라서).
  // watchLive 가 붙으면 status=running 이 되어 폴링이 멈추고, 그 런이 끝나면 status 가 종료로 바뀌어 다시
  // 폴링 → 다음 활성 런(카드뉴스→숏폼→자율런)으로 이어진다. 사용자가 자기 런을 시작하면 그게 우선한다.
  useEffect(() => {
    if (s.status === "running" || s.mode === "replay") return;
    let stopped = false;
    const tick = async () => {
      if (stopped || !urlRestoredRef.current) return; // URL 복구(특정 런 보기)가 끝나기 전엔 자동관전 보류 — 리플레이 하이재킹 방지
      if (useStore.getState().status === "running") return;
      // 최신 생성된 활성 런을 따라간다(파생·자율 모두 포함). created_ts 는 ISO 라 문자열 내림차순=최신 우선.
      const rs = await fetchRuns();
      const active = rs.filter((r) => r.active).sort((a, b) => (a.created_ts < b.created_ts ? 1 : -1));
      let id: string | null = active[0]?.run_id ?? null;
      if (!id) { const st = await fetchAutonomyStatus(); id = st?.auto_run_id ?? null; } // 폴백(활성 런 목록이 빌 때)
      if (id && id !== useStore.getState().runId && useStore.getState().status !== "running") {
        watchLive(id); // 백로그+라이브 구독 → 아바타 안무 시작
      }
    };
    tick();
    const t = setInterval(tick, 6000);
    return () => { stopped = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status, s.mode]);

  const toggleCheck = (id: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const deleteChecked = async () => {
    const ids = [...checked];
    if (ids.length === 0) return;
    if (!window.confirm(`${ids.length}개 기록을 삭제할까요? (되돌릴 수 없습니다)`)) return;
    await Promise.all(ids.map((id) => deleteRun(id)));
    if (s.runId && checked.has(s.runId)) clearToIdle();
    setChecked(new Set());
    refreshRuns();
  };

  const isReplay = s.mode === "replay";
  // ⑧ 예산 경고 — cap 대비 사용률(무제한이면 0). 80% 경고 / 95% 위험.
  const budgetRatio = s.budget && s.budget.cap_usd > 0 ? s.budget.spent_usd / s.budget.cap_usd : 0;
  // ④ ETA — 과거 런 중앙값. 런 시작 시 1회 갱신, 현재 단계는 스토어에서 도출.
  const [eta, setEta] = useState<EtaStats | null>(null);
  useEffect(() => {
    if (s.status === "running" || eta === null) fetchEta().then(setEta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status]);
  // 직원 지명(단독) 런은 phase 이벤트가 없어 "팀 작업·토론" 분기에 못 들어가 위임에 갇힌다 →
  // 지명 직원이 산출물을 내기 시작하면(ceo-synth 스트리밍) '작업 진행'으로 전진.
  const etaStage = s.soloAgentId
    ? (s.blocks["ceo-synth"] ? "작업 진행" : "위임")
    : s.synthesis ? "통합·마무리"
      : Object.keys(s.phases).length ? "팀 작업·토론" : "위임";
  const fmtDur = (sec: number) => sec >= 90 ? `${Math.round(sec / 60)}분` : `${Math.round(sec)}초`;

  const sendChat = async () => {
    const t = chat.trim();
    if (!t || isReplay) return;
    // Read the latest status from the store directly (not from the render-time closure)
    // so two quick Enter presses both see the updated status after the first submit.
    const currentStatus = useStore.getState().status;
    if (submittingRef.current) return; // in-flight guard
    // 대상 칩이 있으면 그 직원에게, 없으면 입력 텍스트에서 직원명 추정(미토큰화 폴백).
    const directed = directedTarget ? { id: directedTarget.id, rest: t } : matchEmployee(t, roster);
    const prevTarget = directedTarget; // 실패 시 지명 칩 복원용 — 칩 토큰화로 입력 텍스트에서 이름이 이미 지워져 있다
    setChat("");
    setDirectedTarget(null);
    submittingRef.current = true;
    try {
      // 첨부(이미지+문서) 업로드 — 새 런을 시작하는 제출(지명은 진행 중에도 새 런)에만.
      // 실패·부분 제외 거부 시 시작을 중단하고 입력·칩·첨부를 보존한다.
      let images: string[] | undefined;
      let docs: string[] | undefined;
      const startsNewRun = !!directed || currentStatus !== "running";
      if ((topicImages.length || topicDocs.length) && startsNewRun) {
        const up = await uploadRunAttachments([...topicImages.map((x) => x.file), ...topicDocs]);
        if (!up.ok) { window.alert(`첨부 업로드 실패: ${up.error || "알 수 없는 오류"}`); setChat(t); setDirectedTarget(prevTarget); return; }
        if (up.skipped.length) {
          // 서버가 제외한 파일(용량·형식·개수 상한)을 무통보로 흘리지 않는다 — 사용자가 계속 여부를 결정.
          const list = up.skipped.slice(0, 5).map((s) => `· ${s.file} — ${s.reason}`).join("\n");
          const more = up.skipped.length > 5 ? `\n… 외 ${up.skipped.length - 5}개` : "";
          if (!window.confirm(`일부 첨부가 제외됩니다:\n${list}${more}\n\n제외한 채 시작할까요?`)) {
            setChat(t); setDirectedTarget(prevTarget); return;
          }
        }
        images = up.images.length ? up.images : undefined;
        docs = up.docs.length ? up.docs : undefined;
      } else if (topicImages.length || topicDocs.length) {
        // 진행 중 런에 지시 주입 — 첨부는 전달되지 않고 남는다(다음 새 런에 함께). 무단 소실·무단 이월 방지 고지.
        window.alert("첨부 파일은 진행 중 런에는 전달되지 않습니다 — 새 런을 시작할 때 함께 전달됩니다.");
      }
      if (directed) {
        // 직원 지명 → 그 직원 단독(필요 시 ask_colleague 협업) 런 시작.
        // 진행 중 런이 있으면 먼저 취소(고아 런·예산 누수·이벤트/seq 오염 방지).
        handleRef.current?.cancel();
        reset(directed.rest);
        try {
          handleRef.current = await startRun(
            directed.rest,
            (ev) => apply(ev),
            (rid) => setRunId(rid),
            () => useStore.getState().lastSeq,
            { agent: directed.id, images, docs },
          );
          clearTopicAttachments();
          setResearchMode(false); // 토글은 제출 1회성 — 지명 런으로 소진돼도 다음 일반 주제가 몰래 리서치가 되지 않게
        } catch (e) {
          window.alert((e as Error & { routed?: boolean }).routed ? (e as Error).message : `런 시작 실패: ${(e as Error).message}`);
          clearToIdle();
        }
      } else if (currentStatus === "running" && useStore.getState().runId) {
        await sendMessage(useStore.getState().runId!, t); // inject a direct instruction into the running run
      } else {
        handleRef.current?.detach();
        reset(t); // idle → start a new run with this instruction
        try {
          handleRef.current = await startRun(
            t,
            (ev) => apply(ev),
            (rid) => setRunId(rid),
            () => useStore.getState().lastSeq,
            { path: runPath || undefined,
              budget: runBudget === "" ? undefined : Number(runBudget), images, docs,
              mission: researchMode ? "research" : undefined,
              persona: persona || undefined,
              personaText: persona === "custom" ? personaText : undefined },
          );
          clearTopicAttachments();
          setResearchMode(false);
        } catch (e) {
          window.alert((e as Error & { routed?: boolean }).routed ? (e as Error).message : `런 시작 실패: ${(e as Error).message}`);
          clearToIdle();
        }
      }
    } finally {
      submittingRef.current = false;
    }
  };

  // 칩·플레이스홀더·버튼은 토큰화된 대상(directedTarget)으로 — 실명직책 표시. 직원명은
  // 입력 후 스페이스를 누르면 칩으로 토큰화되고 입력창엔 질문만 남는다(어색한 중복 제거).
  const directedTitle = directedTarget?.label ?? "";
  const directedLead = directedTarget?.lead ?? false;
  // 통합 커맨드 바 — 상단 주제 입력창을 흡수한 단일 입력. 유휴=전사 토론 시작 ·
  // 직원명+질문=지명 질의 · 실행 중=지시 주입. LLM 런 셀렉터와 중지 버튼도 여기.
  const chatBar = !isReplay ? (
    <>
      {/* 녹음 중 음파 스트립 — 컴포저 위(스크롤 컨테이너 밖, 고정)에 두어 '듣는 중'이 항상 보이게.
          단, 자비스 오버레이(convo) 중에는 오버레이 자체 마이크 버튼이 '듣는 중'을 표시하므로
          중복·중첩 방지로 이 전역 스트립은 숨긴다. */}
      {recorder.recording && !convo && (
        <div className="waveform-strip-wrap">
          <Waveform analyser={recorder.analyser} variant="strip" active={recorder.recording} />
          <span className="muted">🎙 듣는 중…</span>
        </div>
      )}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          sendChat();
        }}
      >
      {directedTarget && (
        <span className="directed-chip">
          <Ico name="person" size={12} />{directedLead ? ` ${directedTitle} · 팀 가동` : ` ${directedTitle}`}
          <button type="button" className="directed-chip-x" title="대상 해제"
            onClick={() => setDirectedTarget(null)}>×</button>
        </span>
      )}
      {(topicImages.length > 0 || topicDocs.length > 0) && (
        <div className="chat-attach-row">
          {topicImages.map((t, i) => (
            <span key={t.url} className="chat-attach-thumb" title={t.file.name}>
              <img src={t.url} alt={t.file.name} />
              <button type="button" title="제거" onClick={() => removeTopicImage(i)}>×</button>
            </span>
          ))}
          {topicDocs.map((f, i) => (
            <span key={`${f.name}-${i}`} className="chat-attach-doc" title={f.name}>
              <Ico name="document" size={11} />
              <span className="chat-attach-doc-name">{f.name}</span>
              <button type="button" title="제거" onClick={() => removeTopicDoc(i)}>×</button>
            </span>
          ))}
        </div>
      )}
      <textarea
        rows={1}
        value={chat}
        title="Enter = 보내기 · Shift+Enter = 줄바꿈"
        onChange={(e) => {
          const v = e.target.value;
          // 대상 없을 때 '직원명 + 스페이스' → 칩으로 토큰화하고 입력창엔 질문만 남긴다(IME 안전).
          if (!directedTarget && /\s$/.test(v)) {
            const m = matchEmployeeName(v, roster);
            if (m) { setDirectedTarget(m); setChat(""); e.target.value = ""; e.target.style.height = "auto"; return; }
          }
          setChat(v);
          e.target.style.height = "auto";                       // 줄 수에 맞춰 자동 높이(상한 132px)
          e.target.style.height = Math.min(e.target.scrollHeight, 132) + "px";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
          else if (e.key === "Backspace" && chat === "" && directedTarget) setDirectedTarget(null);
          // Shift+Enter → 기본 동작(줄바꿈)
        }}
        onPaste={(e) => {
          // 클립보드 이미지 붙여넣기 → 첨부(스크린샷 워크플로). 파일이 있을 때만 기본 붙여넣기 취소.
          if (e.clipboardData?.files?.length) { addTopicFiles(e.clipboardData.files); e.preventDefault(); }
        }}
        placeholder={
          directedTarget
            ? directedLead
              ? `${directedTitle} 팀에 맡길 질문…`
              : `${directedTitle}에게 맡길 질문…`
            : s.status === "running"
              ? "진행 중인 토론에 지시 추가…"
              : "주제 입력(전사 토론) 또는 직원명+질문…"
        }
      />
      <button
        type="button"
        className={`voice-mic ${recorder.recording ? "rec" : ""}`}
        title={voiceAvail.stt ? "누르고 말하기(떼면 입력창에 채움)" : "음성 입력 미설치(mlx-whisper 필요)"}
        disabled={!voiceAvail.stt}
        onPointerDown={(e) => { e.preventDefault(); tts.stop(); tts.prime(); recorder.start(); }}
        onPointerUp={(e) => { e.preventDefault(); handleMicUp(); }}
        onPointerLeave={() => { if (recorder.recording) handleMicUp(); }}
      >🎙️</button>
      <button type="button"
        className={`run-opt-toggle ${convo ? "active" : ""}`}
        title="자비스 대화형 — 켜면 음성이 자비스에게 바로 전달되고 음성으로 답합니다"
        onClick={toggleConvo}>🗣️ 자비스 {convo ? "ON" : "OFF"}</button>
      {/* 첨부(멀티모달: 이미지+문서) — 새 런에만. 붙여넣기(Cmd+V)로도 첨부된다. */}
      {s.status !== "running" && (
        <button type="button" className={`run-opt-toggle ${topicImages.length + topicDocs.length ? "active" : ""}`}
          title="파일 첨부 — 이미지는 비전 분석, 문서(PDF·HWP/HWPX·DOCX·PPTX·XLSX·텍스트)는 내용 추출되어 직원들에게 전달됩니다(각 최대 8개)"
          onClick={() => topicImgInputRef.current?.click()}>
          <Ico name="cards" size={11} /> 첨부{topicImages.length + topicDocs.length ? ` ${topicImages.length + topicDocs.length}` : ""}
        </button>
      )}
      <input ref={topicImgInputRef} type="file" multiple style={{ display: "none" }}
        accept="image/*,.pdf,.docx,.pptx,.hwpx,.hwp,.xlsx,.xls,.txt,.md,.csv,.json"
        onChange={(e) => { if (e.target.files) addTopicFiles(e.target.files); e.target.value = ""; }} />
      {/* 지식 리서치 런 — 조사→토론→두뇌 적재. 발행 초안을 만들지 않아 캘린더에 쌓이지 않는다. */}
      {s.status !== "running" && !directedTarget && (
        <button type="button" className={`run-opt-toggle ${researchMode ? "active" : ""}`}
          title="지식 리서치 런 — 독자 궁금증·경쟁 콘텐츠(네이버·유튜브)를 리서치 팀이 조사·토론해 두뇌(위키)에 적재합니다. 발행 초안은 만들지 않습니다"
          onClick={() => setResearchMode((v) => !v)}>
          <Ico name="search" size={11} /> 리서치 {researchMode ? "ON" : "OFF"}
        </button>
      )}
      {/* 품질 토글(토론·추론) — per-run 옵션이라 컴포저에 배치. type="button" 필수(form submit 방지). */}
      {s.status !== "running" && (
        <button type="button"
          className={`run-opt-toggle ${runSettings.orgDebateRounds > 0 ? "active" : ""}`}
          onClick={toggleDebate}
          title="팀 토론(비평→반박): 켜면 팀들이 서로의 산출물을 비판·정련. 품질↑ 속도↓">
          토론 {runSettings.orgDebateRounds > 0 ? "ON" : "OFF"}
        </button>
      )}
      {s.status !== "running" && (
        <button type="button"
          className={`run-opt-toggle ${runSettings.agentThinking ? "active" : ""}`}
          onClick={toggleThinking}
          title="추론(thinking): 켜면 답 전에 단계적으로 사고. 품질↑ 속도↓">
          추론 {runSettings.agentThinking ? "ON" : "OFF"}
        </button>
      )}
      {/* 블로그 작가 말투(페르소나) — 본문 집필 작가의 목소리 선택(전사 블로그 런에만 의미). custom 시 직접 입력. */}
      {!directedTarget && s.status !== "running" && personas.length > 0 && (
        <select
          className="llm-run-select run-opt"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          title="블로그 작가 말투 — 본문을 쓰는 작가의 목소리를 고릅니다(기본: 지정 안 함)"
        >
          <option value="">말투 기본</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id} title={p.desc}>{p.label}</option>
          ))}
        </select>
      )}
      {!directedTarget && s.status !== "running" && persona === "custom" && (
        <input
          className="persona-custom"
          value={personaText}
          onChange={(e) => setPersonaText(e.target.value)}
          placeholder="원하는 말투 (예: 담백한 정보체)"
          title="직접 입력한 말투가 작가에게 최우선으로 적용됩니다"
        />
      )}
      {!directedTarget && s.status !== "running" && (
        <select
          className="llm-run-select run-opt"
          value={runPath}
          onChange={(e) => setRunPath(e.target.value)}
          title="실행 경로(검토 ①) — 자동: 주제로 추천(타임라인에 사유 표시) · 팀: 가장 적합한 한 팀 경량 1라운드(빠름·저비용) · 전사: 풀 토론(전략·계획 등 산출물 과제)"
        >
          <option value="">경로 자동</option>
          <option value="team">팀(경량)</option>
          <option value="full">전사(풀)</option>
        </select>
      )}
      <button className="btn start" type="submit">
        {directedTarget ? "전달" : s.status === "running" ? "지시" : "시작"}
      </button>
      {s.status === "running" && (
        <button className="btn cancel" type="button" onClick={cancel}>중지</button>
      )}
      </form>
    </>
  ) : null;

  // 라이브 스트리밍 표시는 LiveNowStrip(타임라인 상단 '지금 작업 중' 띠)이 담당 —
  // 현재 작업자만 실명직책 + 한 줄 현황으로 압축(과거의 700자 스트리밍 덤프 제거).

  // 표시명 헬퍼 — '실명 직책'(장은영 팀장). progress·티커·renderTimeline 이 empLabel 을
  // 쓰므로 **그것들보다 먼저** 선언해야 한다(TDZ 방지). 단독 지명 런은 CEO/팀 phase 가
  // 없어 progress 가 empLabel 분기까지 내려가는데, 아래에 선언돼 있으면 'Cannot access
  // before initialization' 으로 전 화면이 죽었다(2026-06-12 수정).
  const personNames = useMemo(() => {
    const m = Object.fromEntries(roster.map((r) => [r.id, personLabel(r.name, r.title)]));
    m["ceo"] = "CEO";
    return m;
  }, [roster]);
  const empLabel = (id?: string | null, persona?: { name?: string; role?: string }): string => {
    if (persona?.name) return personLabel(persona.name, persona.role);
    if (id && personNames[id]) return personNames[id];
    return persona?.role || id || "";
  };

  // One-line "what's happening now" for the timeline (covers the forced-tool decompose
  // stages that don't stream). "" when not running. 직원 지명(단독) 런은 CEO/팀 phase 가
  // 없으므로 progressNote 의 "사장이…" fallback 대신 실제 일하는 그 직원을 보여준다.
  const progress = useMemo((): string => {
    if (s.status !== "running") return "";
    const ceoPhase = s.phases["_ceo"];
    const hasTeamPhase = Object.keys(s.phases)
      .some((k) => k !== "_ceo" && s.phases[k] && s.phases[k] !== "idle");
    // 팀원 없는 솔로 팀(예: 비서실)은 '팀원들이 각자'가 아니라 팀장(비서)이 직접 작업 → 그에 맞는 멘트.
    const soloNote = (tid: string, ph: string): string | null => {
      if (ph !== "work") return null;
      const hasMembers = s.agentOrder.some((id) => {
        const a = s.agents[id]; return !!a && a.team === tid && a.level === "member";
      });
      if (hasMembers) return null;  // 팀원 있는 일반 팀 → 기본 멘트
      const lead = s.agentOrder.map((id) => s.agents[id]).find((a) => a && a.team === tid && a.level === "lead");
      const r = lead ? (empLabel(lead.agent_id, lead.persona) || "담당") : (s.teams[tid]?.name ?? tid);
      return `✍️ ${r}${ga(r)} 작업하는 중…`;
    };
    if (ceoPhase || hasTeamPhase) return progressNote(s.phases, s.teams, s.status, soloNote);
    const w = s.agentOrder.map((id) => s.agents[id])
      .find((a) => a && a.level !== "ceo" && !a.placeholder
        && (a.status === "thinking" || a.status === "spawned"));
    if (w) {
      const r = empLabel(w.agent_id, w.persona) || "직원";
      return `✍️ ${r}${ga(r)} 지시를 수행하고 있습니다`;
    }
    return "⏳ 작업을 준비하는 중…";
  }, [s.status, s.phases, s.teams, s.agents, s.agentOrder]);

  // 활동 피드: folded real-event activity ∪ live-only ambient office-life, sorted
  // ascending by ts (oldest → newest, like the message log). Tie-break by seq so
  // same-timestamp events keep their emit order.
  const mergedActivity = useMemo(() => {
    return [...s.activity, ...s.liveActivity].sort((a, b) =>
      a.ts === b.ts ? (a.seq ?? 0) - (b.seq ?? 0) : a.ts < b.ts ? -1 : 1,
    );
  }, [s.activity, s.liveActivity]);

  // 2D 사무실 상단 실시간 상태 띠 — "지금 사무실에서 무슨 일이 일어나는지" 한 줄.
  // 실행 중에는 한 phase가 수 분 지속돼 멘트가 고정되므로, phase 멘트(닻)와 최근
  // 활동(실제 이벤트 ∪ ambient 사무실 생활)을 4초 간격으로 순환시킨다. 유휴+ambient면
  // 최신 사무실 생활 1건, 리플레이/빈 사무실은 텍스트 멘트.
  const [tickerIdx, setTickerIdx] = useState(0);
  useEffect(() => {
    if (isReplay || s.status !== "running") return;
    const t = setInterval(() => setTickerIdx((v) => v + 1), 4000);
    return () => clearInterval(t);
  }, [isReplay, s.status]);
  // 회전 후보: "{직원}이 {label} 중입니다"로 읽어도 자연스러운 종류만(allowlist),
  // 최근 2분 내, 같은 직원·같은 종류는 최신 1건으로 묶어 최대 5건.
  const tickerPool = useMemo((): ActivityItem[] => {
    if (isReplay || s.status !== "running") return [];
    // 티커는 "지금 사무실 상황"을 보여준다 — 내부 동작(tool=그라운딩 커넥터 호출, skill)은 phase 와 무관하게
    // "사장이 툴 사용 중" 처럼 오해를 주므로 제외. 의미있는 활동(위임·발언·비평·산출물·교훈·위키)과 ambient 만.
    const ok = new Set(["wiki", "delegation", "message", "critique", "rebuttal",
      "deliverable", "lesson", "chat", "rest", "stroll", "phone"]);
    const now = Date.now();
    const seen = new Set<string>();
    const picked: ActivityItem[] = [];
    for (let i = mergedActivity.length - 1; i >= 0 && picked.length < 5; i--) {
      const a = mergedActivity[i];
      const t = new Date(a.ts).getTime();
      if (isNaN(t) || now - t > 120_000) break;  // ts 오름차순이라 더 과거는 전부 stale
      if (!a.actorId || !ok.has(a.kind)) continue;
      const key = `${a.actorId}|${a.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(a);
    }
    return picked.reverse();
    // tickerIdx 의존: 신선도(2분) 창을 회전 주기마다 재평가해 stale 활동을 흘려보냄
  }, [isReplay, s.status, mergedActivity, tickerIdx]);
  // slot 0 = phase 멘트(닻) → 활동 1..N → 다시 닻 — 닻이 주기적으로 돌아온다.
  const tickerSlot = !isReplay && s.status === "running" ? tickerIdx % (1 + tickerPool.length) : 0;
  const tickerItem = useMemo((): ActivityItem | null => {
    if (!isReplay && s.status === "running")
      return tickerSlot > 0 ? tickerPool[tickerSlot - 1] ?? null : null;
    if (!isReplay && !progress)
      return s.liveActivity[s.liveActivity.length - 1] ?? null;  // 유휴: 최신 ambient
    return null;
  }, [isReplay, s.status, progress, tickerSlot, tickerPool, s.liveActivity]);
  const tickerText = useMemo(() => {
    if (isReplay) return "📼 지난 토론을 리플레이하는 중입니다";
    if (tickerItem) return "";  // OfficeTicker 가 item 으로 렌더
    // progress 가 이미 directed-aware(풀 org=phase 멘트 / 단독=그 직원). 풀 org 런만
    // 참여 인원을 덧붙인다(단독 런은 1명이라 불필요).
    if (progress) {
      const hasTeam = !!s.phases["_ceo"] || Object.keys(s.phases)
        .some((k) => k !== "_ceo" && s.phases[k] && s.phases[k] !== "idle");
      const n = hasTeam ? countWorking(s) : 0;
      return n > 0 ? `${progress} · 👥 ${n}명 참여 중` : progress;
    }
    return "🏢 직원들이 각자 자리에서 업무를 보는 중 — 아래에 주제를 입력해 토론을 시작하세요";
  }, [isReplay, progress, s.status, s.phases, tickerItem]);
  // roster id→이름 — pre-run ambient actors (no agent_spawned yet) still get a Korean name.
  // 직무(안정) 표시명 — 라벨 전반에 쓰여 '직무 우선'을 전역 달성. id→직무.
  const rosterNames = useMemo(
    () => {
      const m = Object.fromEntries(roster.map((r) => [r.id, r.title]));
      if (ceoName) m["ceo"] = ceoName;  // 교훈 패널 등 이름 표시용(라우팅 roster와 무관)
      return m;
    },
    [roster, ceoName],
  );
  // 현 담당자 실명 — 상세 화면에서 직무 뒤에 보조로 병기. id→실명(없으면 생략).
  const rosterPersons = useMemo(
    () => Object.fromEntries(roster.filter((r) => r.name).map((r) => [r.id, r.name as string])),
    [roster],
  );
  // 토론 발언 대상 추출 시 오탐 차단용 동료 실명 목록(현 로스터 기준 — 과거 런도 안전).
  const rosterNameList = useMemo(() => Object.values(rosterPersons), [rosterPersons]);
  // personNames·empLabel 은 위(progress 앞)로 이동했다 — TDZ 방지.

  const renderTimeline = (showSynthesis: boolean, heading = true) => (
    <>
      {heading && <h2>토론 타임라인</h2>}
      {(s.status !== "idle" || s.messages.length > 0) && (
        <div className={`tl-protocol status-${s.status}`}>
          <span className="tl-protocol-dot" />
          <b>{protocolLabel(s.status)}</b>
          {s.convergence && (
            <span className="tl-protocol-meta">R{s.convergence.round} · {s.convergence.state}</span>
          )}
        </div>
      )}
      <PhaseStepper compact />
      {progress && <div className="tl-progress"><span className="tl-progress-dot" />{progress}</div>}
      <LiveNowStrip names={personNames} />
      {s.messages.length === 0 && s.status !== "running" && !progress && <p className="muted">토론 메시지 없음.</p>}
      {(() => {
        // Group debate messages by round with a divider so round 1 reads as PARALLEL
        // positions (팀원 동시 작성), not a sequence — the members run concurrently and
        // only appear in finish-time order, which can look like a wrong ordering.
        const rows: JSX.Element[] = [];
        let lastRound = -1;
        for (const m of s.messages) {
          const isDebate = m.move === "position" || m.move === "critique" || m.move === "rebuttal";
          if (isDebate && m.round !== lastRound) {
            lastRound = m.round;
            rows.push(
              <div key={`div-r${m.round}`} className="tl-round-div">
                {m.round === 1 ? "라운드 1 · 동시 입장 (팀원 병렬 작성)" : `라운드 ${m.round} · 상호검증 토론`}
              </div>,
            );
          }
          const a = m.agent_id ? s.agents[m.agent_id] : undefined;
          const isEmp = !!m.agent_id && m.move !== "user";
          rows.push(
            <TimelineMessage
              key={m.seq}
              m={m}
              roleLabel={m.move === "user" ? "👤 나" : empLabel(m.agent_id, a?.persona) || "팀 산출물"}
              avatarId={isEmp ? m.agent_id : null}
              glyph={isEmp ? agentGlyph(a?.level, m.agent_id!, a?.persona?.role ?? "") : undefined}
              wikiPages={s.wikiPages}
              selfName={a?.persona?.name || rosterPersons[m.agent_id ?? ""]}
              rosterNames={rosterNameList}
              tts={tts}
              ttsAvail={voiceAvail.tts}
            />,
          );
        }
        return rows;
      })()}
      {showSynthesis && s.synthesis && (
        <div className="synthesis">
          <h3>종합 결과</h3>
          <pre>{s.synthesis}</pre>
        </div>
      )}
    </>
  );

  const wikiPanel = (
    <>
      <h2>LLM 위키 ({s.wikiOrder.length})</h2>
      {s.wikiOrder.length === 0 && <p className="muted">아직 페이지 없음.</p>}
      {s.wikiOrder.map((pid) => {
        const w = s.wikiPages[pid];
        return (
          <div key={pid} className={`wiki-card status-${w.status} stance-${w.stance}`}>
            <div className="wiki-title">{w.title}</div>
            <div className="wiki-meta">
              <span className="tag">{w.category}</span>
              <span className="tag">{w.status}</span>
              <span className="tag">{w.stance}</span>
            </div>
          </div>
        );
      })}
      {s.wikiEdges.length > 0 && (
        <div className="edges">
          <h3>관계</h3>
          {s.wikiEdges.map((e, i) => (
            <div key={i} className={`edge rel-${e.relation}`}>
              {s.wikiPages[e.src_id]?.title ?? e.src_id}
              <b> —{e.relation}→ </b>
              {s.wikiPages[e.dst_id]?.title ?? e.dst_id}
            </div>
          ))}
        </div>
      )}
    </>
  );

  // 산출물 패널 (오른쪽): 최종 결과물 + 팀 산출물 + 에이전트별 최신 산출.
  const latestByAgent: Record<string, (typeof s.messages)[number]> = {};
  for (const m of s.messages) if (m.agent_id && (m.text || "").trim()) latestByAgent[m.agent_id] = m;
  const teamDeliverables = s.messages.filter((m) => m.move === "deliverable" && (m.text || "").trim());
  const hasOutputs = !!s.synthesis.trim() || teamDeliverables.length > 0 || Object.keys(latestByAgent).length > 0;

  const outputsPanel = (
    <>
      <div className="panel-head">
        <h2><Ico name="document" size={12} /> 산출물</h2>
        <button className="outputs-close" onClick={() => setOutputsOpen(false)}
          title="산출물 창 닫기">✕</button>
      </div>
      {!hasOutputs && <p className="muted">아직 산출물이 없습니다. 토론이 진행되면 여기에 쌓입니다.</p>}

      {s.synthesis.trim() && (
        <div className="output-card final">
          <div className="output-head">
            <span className="output-glyph"><Ico name="sparkle" size={15} /></span>
            <b>최종 결과물</b>
            {s.status === "running" && <span className="output-live">작성 중…</span>}
            {s.runId && s.status !== "running" && (
              <button
                className="output-hwpx"
                title="피드백을 반영한 개정판(v+1) — 팀 작업 재실행 없이 CEO 통합만 다시 수행(빠르고 저렴). 리플레이로 연 과거 런에서도 가능"
                onClick={async () => {
                  if (!s.runId) return;
                  const fb = window.prompt(
                    "수정 지시(피드백)를 입력하세요.\n예: 예산 표를 사업별로 나누고, 3장 결론을 더 단정적으로.");
                  if (!fb || !fb.trim()) return;
                  try {
                    const { run_id } = await reviseRun(s.runId, fb.trim());
                    refreshRuns();
                    watchLive(run_id);
                  } catch (e) {
                    alert(e instanceof Error ? e.message : String(e));
                  }
                }}
              ><Ico name="pencil" size={11} /> 수정 요청</button>
            )}
          </div>
          <div className="output-body">{s.synthesis}</div>
        </div>
      )}

      {teamDeliverables.map((m) => (
        <div key={m.seq} className="output-card deliverable">
          <div className="output-head">
            <span className="output-glyph"><Ico name="document" size={14} /></span>
            <b>팀 산출물</b>
          </div>
          <div className="output-body">{m.text}</div>
        </div>
      ))}

      {s.agentOrder.map((id) => {
        const m = latestByAgent[id];
        if (!m) return null;
        const a = s.agents[id];
        const color = agentColor(id);
        return (
          <div key={id} className="output-card" style={{ borderLeftColor: color }}>
            <div className="output-head">
              <Avatar id={id} glyph={agentGlyph(a?.level, id, a?.persona?.role ?? "")} size={22} head level={a?.level} title={a?.persona?.role ?? ""} />
              <b style={{ color }}>{empLabel(id, a?.persona)}</b>
              <span className="output-meta">R{m.round} · {m.move}</span>
            </div>
            <div className="output-body">{m.text}</div>
          </div>
        );
      })}
    </>
  );

  const employeePanel = (
    <>
      <h2><Ico name="person" size={12} /> 직원 활동 ({s.agentOrder.length})</h2>
      {s.agentOrder.length === 0 && <p className="muted">아직 출근 전.</p>}
      {s.agentOrder.map((id) => {
        const a = s.agents[id];
        if (!a) return null;
        const used = Object.entries(a.toolsUsed ?? {});
        return (
          <div key={id} className="emp-card">
            <div className="emp-head">
              <span className="msg-who">
                <Avatar id={id} glyph={agentGlyph(a.level, id, a.persona?.role ?? "")} size={20} head level={a.level} title={a.persona?.role ?? ""} />
                <b>{empLabel(id, a.persona)}</b>
              </span>
              <span className="emp-meta">
                {a.team ? `${a.team} · ` : ""}{a.level ?? ""}
                {typeof a.autonomy === "number" && (
                  <span className="emp-autonomy" title="AUTONOMY_LEVEL">
                    {" · "}자율 {a.autonomy}({AUTONOMY_LABEL[a.autonomy] ?? "?"})
                  </span>
                )}
              </span>
            </div>
            {(a.skills?.length ?? 0) > 0 && (
              <div className="emp-row">
                스킬: {a.skills!.map((sk) => (
                  <span key={sk} className="chip skill-chip">🧩 {sk}</span>
                ))}
              </div>
            )}
            <div className="emp-row">
              사용 툴 ({a.toolUseCount ?? 0}):{" "}
              {used.length === 0 ? (
                <span className="muted">없음</span>
              ) : (
                used.map(([t, n]) => (
                  <span key={t} className="chip tool-chip">🔧 {t}×{n}</span>
                ))
              )}
            </div>
          </div>
        );
      })}
      {s.sessionDigest && (
        <div className="digest-note">📁 세션 산출물 {s.sessionDigest.files.length}개 파일 저장됨</div>
      )}
    </>
  );

  const decide = async (id: string, approved: boolean) => {
    // The reducer folds the approval_decided SSE event (live path); re-fetch covers
    // hydrated recommendations from past runs (no live event for those).
    await decideApproval(id, approved);
    refreshApprovals();
  };

  // Banner = live (this run's SSE) ∪ hydrated globally-pending, deduped, minus any
  // already decided live this session.
  const liveIds = new Set(s.approvals.map((a) => a.approval_id));
  const decidedIds = new Set(s.approvalHistory.map((a) => a.approval_id));
  const mergedApprovals: ApprovalItem[] = [
    ...s.approvals,
    ...pendingApprovals.filter((p) => !liveIds.has(p.approval_id) && !decidedIds.has(p.approval_id)),
  ];

  // 승인 행동 라벨 — run_command(셸)는 위험이라 danger 시각화 + 명령 전문을 코드블록으로 노출.
  const ACTION_LABEL: Record<string, { label: string; danger?: boolean }> = {
    run_command: { label: "⌨️ 셸 명령 실행", danger: true },
    save_note: { label: "노트 저장" },
    publish: { label: "산출물 발행" },
    write: { label: "쓰기" },
  };
  const approvalsBanner = mergedApprovals.length > 0 && (
    <div className="approvals-banner">
      {mergedApprovals.map((ap) => {
        const aa = ap.agent_id ? s.agents[ap.agent_id] : undefined;
        const meta = ACTION_LABEL[ap.action_type] ?? { label: ap.action_type };
        const isShell = ap.action_type === "run_command";
        return (
        <div key={ap.approval_id} className={`approval-item${meta.danger ? " danger" : ""}`}>
          <span className="approval-text">
            <Ico name="bell" size={14} />{" "}
            {ap.agent_id && (
              <Avatar id={ap.agent_id} glyph={agentGlyph(aa?.level, ap.agent_id, aa?.persona?.role ?? "")} size={20} head level={aa?.level} title={aa?.persona?.role ?? ""} />
            )}{" "}
            <b>{empLabel(ap.agent_id, aa?.persona) || "시스템"}</b>
            {" "}승인 요청 · <span className="approval-act">{meta.label}</span>
            {isShell
              ? <pre className="approval-cmd"><code>{ap.summary.replace(/^명령 실행:\s*/, "")}</code></pre>
              : <> — {ap.summary}</>}
          </span>
          <span className="approval-actions">
            <button className="btn approve" onClick={() => decide(ap.approval_id, true)}>승인</button>
            <button className="btn reject" onClick={() => decide(ap.approval_id, false)}>거부</button>
          </span>
        </div>
        );
      })}
    </div>
  );

  const emptyStage = (
    <div className="graph-empty">
      <p className="muted">주제를 입력하고 시작하면<br />에이전트들이 사무실에 출근합니다.</p>
    </div>
  );

  return (
    <div className="app">
      {convo && (
        <div className="jarvis-overlay">
          <button type="button" className="jarvis-close" onClick={toggleConvo} title="닫기">×</button>
          <JarvisAvatar analyser={tts.analyser} speaking={tts.speakingSeq !== null} />
          <div className="jarvis-thread" ref={jarvisThreadRef}>
            {s.jarvisTurns.length === 0 && <p className="muted">🎙 아래 버튼을 탭하거나 “자비스”라고 부르면 대화가 시작됩니다</p>}
            {s.jarvisTurns.map((t, i) => (
              <div key={i} className={`jarvis-turn ${t.role}`}>
                <b>{t.role === "jarvis" ? "자비스" : "나"}</b> {t.text}
                {t.role === "jarvis" && <button className="voice-speak" onClick={() => tts.speak(t.text, i)}>🔊</button>}
              </div>
            ))}
            {s.jarvisBusy && <p className="muted">자비스가 생각 중…</p>}
          </div>
          {jv.lastHeard && <p className="jarvis-heard">🗨 들린 말: “{jv.lastHeard}”</p>}
          <button
            type="button"
            className={`jarvis-mic jv-${jv.status}`}
            disabled={!voiceAvail.stt}
            title={voiceAvail.stt ? '탭하면 바로 대화 시작 (또는 "자비스"라고 부르세요)' : "음성 입력 미설치(mlx-whisper 필요)"}
            onClick={() => { tts.prime(); jv.activate(); }}
          >{!voiceAvail.stt ? "🎙️ 음성 미설치"
            : jv.status === "speaking" ? "🗣️ 자비스가 말하는 중…"
            : jv.status === "thinking" ? "💭 생각 중…"
            : jv.status === "listening" ? "👂 듣는 중…"
            : jv.active ? "🟢 대화 중 · 편히 말씀하세요"
            : "🎙️ 탭하고 말하기 (또는 “자비스”)"}</button>
        </div>
      )}
      <header className="topbar">
        <button className="brand" type="button" onClick={goHome} title="초기화면으로"><Ico name="company" size={15} /> <span className="brand-txt">AI 콘텐츠 스튜디오</span></button>
        {/* LLM 배지 — Claude 단일 백엔드(Ollama 제거). 클릭 시 LLM 정보 뷰로. */}
        <button className="llm-badge claude" onClick={() => setView("llm")}
          title="LLM 백엔드: Claude 클라우드 (편집장·심층=opus · 표준=sonnet · 빠름=haiku)">
          <span className="llm-badge-dot" />
          <span className="llm-badge-txt">Claude 클라우드</span>
        </button>
        {/* 주제 입력·토론 시작·LLM 셀렉터는 좌하단 통합 커맨드 바로 이동 — 상단은
            업로드/기록/뷰 전환/상태만 남겨 깔끔하게. */}
        <div className="topbar-actions">
        <button className="btn theme-toggle" type="button" onClick={toggleTheme}
          title={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
          aria-label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}>
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <div className="upload-wrap" ref={uploadMenuRef}>
          <button className="btn" onClick={() => setUploadMenu((v) => !v)}
            title="외부 자료 업로드(PDF/Word/Excel/PPT/HWPX/txt 등) → 위키 적재"><Ico name="document" size={12} /> 자료 ▾</button>
          {uploadMenu && (
            <div className="upload-menu">
              <button onClick={() => { setUploadMenu(false); fileInputRef.current?.click(); }}>파일 선택</button>
              <button onClick={() => { setUploadMenu(false); folderInputRef.current?.click(); }}>폴더 선택</button>
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
          accept={ALLOWED_EXT.join(",")}
          onChange={async (e) => { await doUpload(e.target.files); e.target.value = ""; }} />
        <input ref={folderInputRef} type="file" multiple style={{ display: "none" }}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={async (e) => { await doUpload(e.target.files); e.target.value = ""; }} />
        <div className="hist-wrap" ref={histWrapRef}>
          <button className="btn hist-toggle" onClick={() => { if (!showHist) void refreshRuns(); setShowHist((v) => !v); }} title="토론 기록">
            <Ico name="bubble" size={12} /> 기록{runs.length > 0 ? ` (${runs.length})` : ""}
          </button>
          {showHist && (
            <div className="hist-panel">
              <div className="hist-head">
                <b>토론 기록 ({runs.length})</b>
                <button className="hist-close" onClick={() => setShowHist(false)}>✕</button>
              </div>
              <div className="hist-list">
                {runs.length === 0 && <p className="muted hist-empty">기록 없음</p>}
                {runs.map((r) => (
                  <div key={r.run_id} className={`hist-row${checked.has(r.run_id) ? " checked" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked.has(r.run_id)}
                      onChange={() => toggleCheck(r.run_id)}
                    />
                    <button
                      className="hist-load"
                      onClick={() => {
                        loadPast(r.run_id);
                        setShowHist(false);
                      }}
                    >
                      <span className={`hist-badge status-${r.status}`}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                      {r.auto && <span className="hist-badge" title="자율(백그라운드) 런 — 진행 중">🤖 자율</span>}
                      {(r.revise || (r.version ?? 0) > 1) && (
                        <span className="hist-badge" title="개정판 — 새로 생성한 글이 아니라 기존 초안을 다듬은 런입니다(자동 SEO 개정 등). 본문이 원본과 비슷한 게 정상입니다.">
                          ↻ 개정{(r.version ?? 0) > 1 ? ` v${r.version}` : ""}
                        </span>
                      )}
                      <span className="hist-topic">{r.topic.slice(0, 40) || "(제목 없음)"}</span>
                    </button>
                    {r.status === "interrupted" && (
                      <button
                        className="hist-resume"
                        title="중단된 지점부터 이어가기"
                        onClick={() => resume(r.run_id)}
                      >
                        ▶ 이어가기
                      </button>
                    )}
                    {r.status === "running" && (
                      <button
                        className="hist-resume"
                        title="실행 중인 런에 라이브로 다시 연결 (재실행이 아니라 화면만 따라붙음)"
                        onClick={() => watchLive(r.run_id)}
                      >
                        ▶ 라이브로 보기
                      </button>
                    )}
                    {r.status !== "running" && r.status !== "interrupted" && (
                      <button
                        className="hist-resume"
                        title="완료된 기록을 다시 열어 진행 과정·산출물을 재생"
                        onClick={() => {
                          loadPast(r.run_id);
                          setShowHist(false);
                        }}
                      >
                        다시 보기
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {checked.size > 0 && (
                <div className="hist-foot">
                  <button className="btn" onClick={() => setChecked(new Set())}>선택 해제</button>
                  <button className="btn reject" onClick={deleteChecked}><Ico name="trash" size={12} /> 선택 {checked.size}개 삭제</button>
                </div>
              )}
            </div>
          )}
        </div>
        <button className="btn" onClick={() => setShowBrain(true)}
          title="제2의 두뇌 — 위키 지식 그래프(옵시디언 뷰)"><Ico name="sparkle-line" size={12} /> 두뇌</button>
        </div>
        {/* viewtabs: 데스크톱은 display:contents 라 두 그룹이 그대로 topbar 직속(무변경).
            폰(≤640)에선 한 줄 가로스크롤 탭바로 묶여 세로 예산을 절약한다. */}
        <div className="viewtabs">
        <div className="viewtoggle">
          <button className={view === "office" ? "active" : ""} onClick={() => setView("office")}><Ico name="home" size={12} /> 사무실</button>
          <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}><Ico name="share" size={12} /> 그래프</button>
          <button className={view === "employees" ? "active" : ""} onClick={() => setView("employees")}><Ico name="person" size={12} /> 직원</button>
          <button className={view === "detail" ? "active" : ""} onClick={() => setView("detail")}><Ico name="menu" size={12} /> 상세</button>
        </div>
        <div className="viewtoggle">
          <button className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}><Ico name="calendar" size={12} /> 캘린더</button>
          <button className={view === "review" ? "active" : ""} onClick={() => setView("review")}><Ico name="eye" size={12} /> 검토</button>
          <button className={view === "perf" ? "active" : ""} onClick={() => setView("perf")}><Ico name="chart" size={12} /> 성과</button>
          <button className={view === "studio" ? "active" : ""} onClick={() => setView("studio")}><Ico name="pencil" size={12} /> 제작실</button>
        </div>
        <div className="viewtoggle">
          <button className={view === "apikeys" ? "active" : ""} onClick={() => setView("apikeys")}><Ico name="key" size={12} /> API 키</button>
          <button className={view === "llm" ? "active" : ""}
            onClick={() => setView("llm")}><Ico name="sparkle" size={12} /> LLM</button>
          <button className={view === "mcp" ? "active" : ""} onClick={() => setView("mcp")}><Ico name="globe" size={12} /> MCP</button>
          <button className={view === "brand" ? "active" : ""} onClick={() => setView("brand")}><Ico name="company" size={12} /> 브랜드</button>
        </div>
        </div>
        <div className={`status status-${s.status}`}>
          {isReplay ? "리플레이" : STATUS_LABEL[s.status] ?? s.status}
        </div>
        {s.status === "running" && !isReplay && eta && eta.sample > 0 && (
          <div className="hud" title={
            `최근 ${eta.sample}개 런 중앙값 — ` +
            Object.entries(eta.stages).map(([k, v]) => `${k} ${fmtDur(v)}`).join(" · ") +
            (eta.total_sec ? ` · 전체 ${fmtDur(eta.total_sec)}` : "") +
            (eta.cost_usd ? ` · 비용 ~$${eta.cost_usd}` : "")
          }>
            <Ico name="clock" size={11} /> {etaStage}{eta.stages[etaStage] ? ` · 보통 ~${fmtDur(eta.stages[etaStage])}` : ""}
          </div>
        )}
        {s.budget && (
          <div
            className={`hud${budgetRatio >= 0.95 ? " budget-crit" : budgetRatio >= 0.8 ? " budget-warn" : ""}`}
            title={s.budget.cap_usd > 0 ? `예산 ${Math.round(budgetRatio * 100)}% 사용` : "예산 무제한"}
          >
            ${s.budget.spent_usd.toFixed(3)} / {s.budget.cap_usd > 0 ? `$${s.budget.cap_usd.toFixed(2)}` : "∞"}
          </div>
        )}
        {s.convergence && (
          <div className="hud conv" title="라운드 기반 상태 (적응형 수렴 감지는 phase 2)">
            라운드 {s.convergence.round} · {s.convergence.state}
          </div>
        )}
      </header>

      {budgetRatio >= 0.8 && s.status === "running" && s.budget && (
        <div className={`budget-banner${budgetRatio >= 0.95 ? " crit" : ""}`}>
          ⚠️ 예산 {Math.round(budgetRatio * 100)}% 사용 — 남은 한도 $
          {Math.max(0, s.budget.cap_usd - s.budget.spent_usd).toFixed(2)}
          {budgetRatio >= 0.95 && " · 한도 도달 시 런이 자동 중단됩니다"}
        </div>
      )}

      {uploadProg && (
        <div className="upload-toast">
          <div className="upload-toast-label">
            📁 자료 적재 중… {uploadProg.done}/{uploadProg.total}
            <span className="upload-pct"> ({Math.round((uploadProg.done / uploadProg.total) * 100)}%)</span>
          </div>
          <div className="upload-bar">
            <div className="upload-bar-fill"
              style={{ width: `${Math.round((uploadProg.done / Math.max(uploadProg.total, 1)) * 100)}%` }} />
          </div>
        </div>
      )}

      {uploadDone && <UploadSummary results={uploadDone.results} roster={roster} onClose={() => setUploadDone(null)} />}

      {showBrain && (
        <Suspense fallback={null}><WikiGraphView onClose={() => setShowBrain(false)} /></Suspense>
      )}

      {metric && (
        <MetricDrawer metric={metric} runs={runs} names={rosterNames} persons={rosterPersons}
          onOpenRun={loadPast} onOpenOutputs={() => setOutputsOpen(true)}
          onClose={() => setMetric(null)} />
      )}

      {approvalsBanner}

      {s.subproblems.length > 0 && (
        <div className="subproblem-strip">
          <span className="strip-label">{s.debateGated ? "단일 관점" : "하위 문제"}:</span>
          {s.subproblems.map((sp) => (
            <span key={sp.id} className="chip">{sp.id} · {sp.text}</span>
          ))}
        </div>
      )}

      {view === "apikeys" ? (
        <main className="employees-stage">
          <ApiKeysView />
        </main>
      ) : view === "llm" ? (
        <main className="employees-stage">
          <LlmSettingsView />
        </main>
      ) : view === "mcp" ? (
        <main className="employees-stage">
          <McpView />
        </main>
      ) : view === "calendar" ? (
        <main className="employees-stage">
          <ContentCalendar />
        </main>
      ) : view === "review" ? (
        <main className="employees-stage">
          <DraftReview initialPieceId={deepLinkPiece ?? undefined} />
        </main>
      ) : view === "perf" ? (
        <main className="employees-stage">
          <PerformanceView />
        </main>
      ) : view === "studio" ? (
        <main className="employees-stage">
          <StudioView />
        </main>
      ) : view === "brand" ? (
        <main className="employees-stage">
          <BrandView />
        </main>
      ) : view === "employees" ? (
        <main className="employees-stage">
          <EmployeesView />
        </main>
      ) : view === "detail" ? (
        <main className="panels">
          <section className="panel graph-panel">
            {s.agentOrder.length === 0 ? emptyStage : <AgentGraph />}
          </section>
          <section className="panel timeline-detail">
            <div className="td-scroll">{renderTimeline(true)}</div>
            {chatBar}
          </section>
          <section className="panel employees">{employeePanel}</section>
          <section className="panel wiki">{wikiPanel}</section>
        </main>
      ) : (
        <main
          className="stage"
          // 5컬럼: 좌패널 | 핸들 | 중앙(1fr) | 핸들 | 우패널 — 핸들 드래그로 좌/우 폭 조절.
          // 산출물 창을 닫으면 우측 핸들+패널 2컬럼을 제거해 중앙이 그만큼 넓어진다.
          style={{ gridTemplateColumns: outputsOpen
            ? `${widths.left}px 5px 1fr 5px ${widths.right}px`
            : `${widths.left}px 5px 1fr` }}
        >
          <aside className="sidechat">
            <div className="tl-tabs" role="tablist">
              <button
                className={`tl-tab${tlTab === "timeline" ? " active" : ""}`}
                role="tab" aria-selected={tlTab === "timeline"}
                onClick={() => setTlTab("timeline")}
              >
                <Ico name="chat" size={13} /> 타임라인
              </button>
              <button
                className={`tl-tab${tlTab === "activity" ? " active" : ""}`}
                role="tab" aria-selected={tlTab === "activity"}
                onClick={() => setTlTab("activity")}
              >
                <Ico name="sparkle" size={13} /> 활동{mergedActivity.length ? ` ${mergedActivity.length}` : ""}
              </button>
              <button
                className={`tl-tab${tlTab === "workflow" ? " active" : ""}`}
                role="tab" aria-selected={tlTab === "workflow"}
                onClick={() => setTlTab("workflow")}
              >
                <Ico name="filter" size={13} /> 워크플로우
              </button>
            </div>
            <div className="sidechat-scroll">
              {tlTab === "timeline"
                ? renderTimeline(false, false)
                : tlTab === "workflow"
                ? <WorkflowBoard names={personNames} />
                : <ActivityFeed items={mergedActivity} agents={s.agents} teams={s.teams} names={personNames} />}
            </div>
            {chatBar}
          </aside>
          <div className="stage-split" onMouseDown={startDrag("left")}
            onDoubleClick={() => resetWidth("left")}
            title="드래그 = 타임라인 폭 조절 · 더블클릭 = 기본 폭" />
          <section className="stage-main">
            {view === "office" ? (
              <div className="office-stage">
                <DashboardBar companyName={companyMeta.name} total={companyMeta.total}
                  runsCount={runs.length} onMetric={setMetric} onOpenBrand={() => setView("brand")} />
                <OfficeTicker item={tickerItem} text={tickerText}
                  agents={s.agents} names={personNames} live={s.status === "running"} />
                <OfficeView />
                <OfficeProgressBar />
              </div>
            ) : s.agentOrder.length === 0 ? (
              emptyStage
            ) : (
              <AgentGraph />
            )}
          </section>
          {outputsOpen ? (
            <>
              <div className="stage-split" onMouseDown={startDrag("right")}
                onDoubleClick={() => resetWidth("right")}
                title="드래그 = 산출물 폭 조절 · 더블클릭 = 기본 폭" />
              <aside className="outputs">{outputsPanel}</aside>
            </>
          ) : (
            // 닫힌 상태: 중앙 우측 가장자리에 얇은 "산출물 열기" 탭.
            <button className="outputs-reopen" onClick={() => setOutputsOpen(true)}
              title="산출물 창 열기"><Ico name="document" size={12} /> 산출물 ◀</button>
          )}
        </main>
      )}

      {isReplay && <ReplayBar />}

      {s.errors.length > 0 && (
        <footer className="errors">
          {s.errors.map((e, i) => (<div key={i}>⚠ {e}</div>))}
        </footer>
      )}
    </div>
  );
}
