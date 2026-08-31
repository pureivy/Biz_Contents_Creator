/**
 * 런별 그라운딩 원장(메모리) — runAgent 가 실제로 주입한 위키 히트·커넥터·웹 URL 을 기록한다.
 * verified 승격(reflect)이 "근거 문자열이 이 런에서 실제 조회된 것인가"를 대조하는 데 쓴다(스펙 §5).
 * 감사 실측: [근거:] 태그만 있으면 '동일'·위키 (종합)·성과 페이지·미실측 표시까지 verified 로 승격됐다.
 */
export type GroundingKind = 'connector' | 'web' | 'wiki-raw' | 'wiki-derived';
export interface GroundingEntry { label: string; kind: GroundingKind }

const MAX_RUNS = 100;
const ledger = new Map<string, GroundingEntry[]>();

export function noteGrounding(runId: string, entries: GroundingEntry[]): void {
  if (!runId) return;
  const cur = ledger.get(runId) ?? [];
  ledger.delete(runId); // 재삽입으로 최신 순서 유지(Map 삽입 순서 = LRU 근사)
  for (const e of entries) {
    const label = e.label.trim();
    if (!label || cur.some((x) => x.label === label && x.kind === e.kind)) continue;
    cur.push({ label, kind: e.kind });
  }
  ledger.set(runId, cur);
  while (ledger.size > MAX_RUNS) { const oldest = ledger.keys().next().value; if (oldest === undefined) break; ledger.delete(oldest); }
}
export function groundingEntries(runId: string): GroundingEntry[] { return [...(ledger.get(runId) ?? [])]; }
export function clearGrounding(runId: string): void { ledger.delete(runId); }
