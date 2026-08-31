import { create } from "zustand";
import { fold } from "./events/reducer";
import { ActivityItem, EventEnvelope, UIState, initialState } from "./events/types";

type Mode = "live" | "replay";

interface Store extends UIState {
  mode: Mode;
  replayBuffer: EventEnvelope[];
  replayPos: number; // number of events applied (0..buffer.length)
  // Ephemeral office-life (잡담/휴식/산책/통화) for the 활동 피드. Lives OUTSIDE the
  // folded UIState because it's random/wall-clock animation — not replayable. Merged
  // with s.activity at render; cleared whenever the run/identity changes.
  liveActivity: ActivityItem[];
  applyEvent: (ev: EventEnvelope) => void; // live path
  pushActivity: (item: ActivityItem) => void; // ambient → liveActivity (capped)
  reset: (topic: string) => void;
  clearToIdle: () => void; // back to the idle/empty state (e.g. after deleting a run)
  setRunId: (runId: string) => void;
  loadReplay: (runId: string, topic: string, events: EventEnvelope[]) => void;
  // 라이브 재접속용 — 기존 백로그를 애니메이션 없이 '한 번에' 최종 상태로 fold 하고
  // mode='live'·lastSeq=마지막 seq 로 맞춘다. 이후 watchRun 이 마지막 seq+1 부터만
  // tail 하므로(Last-Event-ID=lastSeq) 백로그 안무를 처음부터 재생하지 않는다.
  snapshotLive: (runId: string, topic: string, events: EventEnvelope[]) => void;
  seek: (pos: number) => void; // re-fold to position (supports scrubbing both ways)
  speakingSeq: number | null;
  recording: boolean;
  setSpeaking: (seq: number | null) => void;
  setRecording: (b: boolean) => void;
  jarvisTurns: { role: 'user' | 'jarvis'; text: string }[];
  jarvisBusy: boolean;
  pushJarvisTurn: (t: { role: 'user' | 'jarvis'; text: string }) => void;
  setJarvisBusy: (b: boolean) => void;
  clearJarvis: () => void;
}

// 후진 스크럽 시 매번 0부터 재fold 하던 O(n) 비용을 줄이는 체크포인트 캐시. fold 가 순수 함수이므로
// CKPT 개마다 스냅샷을 저장하고 가장 가까운 체크포인트부터 fold 한다(결과는 0부터 fold 한 것과 동일).
// replayBuffer 배열이 바뀌면(새 런 로드) identity 비교로 캐시를 버린다.
const CKPT = 200;
let _ckptBuf: EventEnvelope[] | null = null;
const _ckpts = new Map<number, UIState>(); // key = CKPT 배수, value = 그 지점까지 fold 한 상태
function foldUpTo(events: EventEnvelope[], pos: number): UIState {
  if (events !== _ckptBuf) { _ckptBuf = events; _ckpts.clear(); }
  const base = Math.floor(pos / CKPT) * CKPT;
  let st = _ckpts.get(base) ?? initialState();
  const start = _ckpts.has(base) ? base : 0;
  for (let i = start; i < pos && i < events.length; i++) {
    st = fold(st, events[i]);
    const next = i + 1;
    if (next % CKPT === 0 && !_ckpts.has(next)) _ckpts.set(next, st); // 경계마다 스냅샷 적립
  }
  return st;
}

export const useStore = create<Store>((set, get) => ({
  ...initialState(),
  mode: "live",
  replayBuffer: [],
  replayPos: 0,
  liveActivity: [],
  speakingSeq: null,
  recording: false,
  jarvisTurns: [],
  jarvisBusy: false,

  applyEvent: (ev) => set((s) => {
    if (s.mode === "replay") return s;                      // live events never touch replay state
    if (s.runId && ev.run_id !== s.runId) return s;         // drop strays from a stale stream
    return fold(s as UIState, ev) as Partial<Store>;
  }),

  // Cap the ring so a long idle run can't grow the ambient feed unbounded.
  pushActivity: (item) =>
    set((s) => ({ liveActivity: [...s.liveActivity, item].slice(-150) })),

  reset: (topic) =>
    set(() => ({ ...initialState(), topic, status: "running", mode: "live", replayBuffer: [], replayPos: 0, liveActivity: [] })),

  clearToIdle: () =>
    set(() => ({ ...initialState(), mode: "live", replayBuffer: [], replayPos: 0, liveActivity: [] })),

  setRunId: (runId) => set(() => ({ runId })),
  setSpeaking: (speakingSeq) => set(() => ({ speakingSeq })),
  setRecording: (recording) => set(() => ({ recording })),
  pushJarvisTurn: (t) => set((s) => ({ jarvisTurns: [...s.jarvisTurns, t] })),
  setJarvisBusy: (jarvisBusy) => set(() => ({ jarvisBusy })),
  clearJarvis: () => set(() => ({ jarvisTurns: [], jarvisBusy: false })),

  loadReplay: (runId, topic, events) =>
    set(() => ({
      ...foldUpTo(events, events.length), // final state first...
      runId,                              // ...then preserve identity + replay fields
      topic,
      mode: "replay",
      replayBuffer: events,
      replayPos: events.length,
      liveActivity: [],                   // ambient is live-only — never in replay
    })),

  // 실행 중인 런에 라이브로 다시 붙을 때: 백로그를 loadReplay 처럼 '한 번에' 최종
  // 상태로 fold(애니메이션 없음) 하되 mode='live' 로 두어 이후 live 이벤트가 적용되게
  // 한다. replayBuffer 는 비워(스크럽 불가 — 이건 리플레이가 아니라 라이브 꼬리잡기).
  // folded.lastSeq(reducer 가 매 이벤트마다 갱신)가 곧 watchRun 의 재개 지점이 된다.
  snapshotLive: (runId, topic, events) =>
    set(() => {
      const folded = foldUpTo(events, events.length);
      return {
        ...folded,
        runId,
        topic: folded.topic || topic,
        // 백로그에 run_done 이 있었으면 그 상태(종료) 유지, 아니면 진행 중.
        status: folded.status === "idle" ? "running" : folded.status,
        mode: "live",
        replayBuffer: [],
        replayPos: 0,
        liveActivity: [],
      };
    }),

  seek: (pos) => {
    const { replayBuffer, replayPos, runId, topic } = get();
    const clamped = Math.max(0, Math.min(pos, replayBuffer.length));
    if (clamped === replayPos) return; // no-op
    if (clamped > replayPos) {
      // Forward step: fold incrementally from the current position — O(delta) not O(n).
      set((s) => {
        let st = s as UIState;
        for (let i = replayPos; i < clamped; i++) st = fold(st, replayBuffer[i]);
        return { ...st, runId, topic: st.topic || topic, mode: "replay", replayBuffer, replayPos: clamped, liveActivity: [] };
      });
    } else {
      // Backward scrub: must refold from scratch.
      const folded = foldUpTo(replayBuffer, clamped);
      set(() => ({ ...folded, runId, topic: folded.topic || topic, mode: "replay", replayBuffer, replayPos: clamped, liveActivity: [] }));
    }
  },
}));
