/**
 * 취소(AbortSignal) 유틸 — 취소를 '오류'와 구분하고, AbortSignal.any 폴리필 제공.
 * (리뷰 발견: 취소가 run_done{error}로 오인 / AbortSignal.any 는 Node 20.3+ 필요)
 */
export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return e instanceof Error && (e.name === 'AbortError' || /abort(ed)?/i.test(e.message));
}

/** AbortSignal.any 폴리필(Node 20.0~20.2 / 미지원 런타임 안전). */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const real = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof real === 'function') return real(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
