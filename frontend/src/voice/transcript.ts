/** STT 전사를 컴포저 기존 텍스트에 합성(자동 전송 아님 — 검토용). */
export function mergeTranscript(prev: string, transcript: string): string {
  const t = (transcript ?? '').trim();
  if (!t) return prev;
  if (!prev) return t;
  return /\s$/.test(prev) ? prev + t : prev + ' ' + t;
}
