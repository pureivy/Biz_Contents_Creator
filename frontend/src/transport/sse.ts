import {
  EventSourceMessage,
  fetchEventSource,
} from "@microsoft/fetch-event-source";
import { EventEnvelope } from "../events/types";

export interface RunHandle {
  cancel: () => void;
  detach: () => void;
}

// Connect to an existing run's SSE stream and fold its events. The server replays the
// backlog from Last-Event-ID first, then tails live — so a fresh OR resumed/late viewer
// reconstructs full history, then follows along. Uses fetch-event-source (not native
// EventSource) for header control + Last-Event-ID resume.
//
// Exported so the UI can re-attach to an ALREADY-running run after a page reload
// (status stays "running", so resume() — which re-drives — is the wrong tool). This
// only tails the stream; it never re-enters run_company, so there is no double-run risk.
export function watchRun(
  run_id: string,
  onEvent: (ev: EventEnvelope) => void,
  getLastSeq: () => number,
): RunHandle {
  const ctrl = new AbortController();

  fetchEventSource(`/runs/${run_id}/events`, {
    signal: ctrl.signal,
    openWhenHidden: true,
    headers: {},
    onmessage(msg: EventSourceMessage) {
      if (!msg.data) return;
      try {
        onEvent(JSON.parse(msg.data) as EventEnvelope);
      } catch {
        /* ignore malformed frames */
      }
    },
    // On reconnect, resume from the last seq we folded.
    fetch: (input, init) => {
      const last = getLastSeq();
      const headers = new Headers(init?.headers);
      if (last > 0) headers.set("Last-Event-ID", String(last));
      return fetch(input, { ...init, headers });
    },
    onerror(err) {
      // returning lets the lib retry with backoff; throw to stop.
      console.warn("SSE error, will retry:", err);
    },
  }).catch((e) => console.warn("SSE closed:", e));

  return {
    cancel: () => {
      ctrl.abort();
      fetch(`/runs/${run_id}/cancel`, { method: "POST" }).catch(() => {});
    },
    detach: () => ctrl.abort(),
  };
}

// Create a run and stream its events into `onEvent`.
export async function startRun(
  topic: string,
  onEvent: (ev: EventEnvelope) => void,
  onRunId: (runId: string) => void,
  getLastSeq: () => number,
  opts?: { agent?: string; path?: string;
           budget?: number; images?: string[]; docs?: string[]; mission?: string;
           persona?: string; personaText?: string },
): Promise<RunHandle> {
  const res = await fetch("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `agent` (a role id) routes to a single-employee directed run; omitted = full run.
    // `path` picks the 3-tier run path ("team"|"full"); omitted = server auto-recommend.
    // `budget` caps THIS run's spend in USD (0 = explicit unlimited); omitted = global default.
    // `images` — /runs/attachments 로 업로드된 첨부 이미지 경로(멀티모달 주제 입력).
    // `mission` — 'research' = 지식 리서치 런(조사→토론→두뇌 적재, 발행 초안 없음).
    body: JSON.stringify({
      topic,
      ...(opts?.agent ? { agent: opts.agent } : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
      ...(opts?.docs?.length ? { docs: opts.docs } : {}),
      ...(opts?.mission ? { mission: opts.mission } : {}),
      ...(opts?.persona ? { persona: opts.persona } : {}),
      ...(opts?.personaText ? { personaText: opts.personaText } : {}),
      ...(opts?.path ? { path: opts.path } : {}),
      ...(opts?.budget !== undefined ? { budget_usd: opts.budget } : {}),
    }),
  });
  if (!res.ok) throw new Error(`failed to create run: ${res.status}`);
  const j = await res.json();
  // 서버가 런 대신 다른 동작으로 라우팅한 응답(예: "오토런 실행해줘" → 자율 틱, autorun_tick) —
  // run_id 없이 watchRun 으로 들어가면 이벤트가 영영 오지 않아 "작업 준비중"에 갇힌다(실측 2026-08-09).
  // note 를 담아 던지면 호출부의 기존 catch 가 안내를 띄우고 대기 상태를 풀어준다.
  // routed 표식: 실패가 아닌 의도된 라우팅 — 호출부가 "런 시작 실패:" 접두어를 붙이지 않게(실측:
  // "실패했다면서 실행했다"는 모순 문구가 사용자 혼란을 불렀다).
  if (!j.run_id) {
    const err = new Error(j.note || j.error || "런이 시작되지 않았습니다") as Error & { routed?: boolean };
    if (j.autorun_tick) err.routed = true;
    throw err;
  }
  const { run_id } = j;
  onRunId(run_id);
  return watchRun(run_id, onEvent, getLastSeq);
}

// Resume an interrupted run server-side (continues from its last completed boundary),
// then watch it live. Throws with the server's message on failure (e.g. already running
// / already finished).
export async function resumeRun(
  run_id: string,
  onEvent: (ev: EventEnvelope) => void,
  getLastSeq: () => number,
): Promise<RunHandle> {
  const res = await fetch(`/runs/${run_id}/resume`, { method: "POST" });
  if (!res.ok) {
    const e = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(e.error || `failed to resume: ${res.status}`);
  }
  return watchRun(run_id, onEvent, getLastSeq);
}
