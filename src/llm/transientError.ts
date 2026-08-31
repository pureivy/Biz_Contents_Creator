/**
 * 일시적 실패 판정(2026-08-28) — 코드·데이터 결함이 아니라 **시간이 풀어 주는** 실패를 가려낸다.
 *
 * 실사고: 자율 틱이 시작 2초 만에 죽었다.
 *   `Claude CLI claude-haiku-4-5: success — You've hit your session limit · resets 1:40pm (Asia/Seoul)`
 * piece 는 recordError 로 errors=3(MAX_ERRORS)에 도달해 stage='error' 가 됐고, RESUMABLE_STAGES
 * (idea·research·draft)에서 빠져 **자율 틱이 영영 다시 집지 않는** 상태가 됐다. 한도는 몇 시간 뒤
 * 저절로 풀리는데, 그 사이 재시도 예산 3회가 통째로 소모되고 조각이 죽은 것이다.
 * (같은 한도가 2026-08-18 에도 리비전 런을 죽였다 — 그때는 알림 복원만 고쳤고 카운트는 그대로 뒀다.)
 *
 * 왜 문자열 판정인가 — CLI 는 한도를 `is_error: true` + `subtype: 'success'` 로 돌려준다(그래서 위
 * 메시지가 "success — …"라는 모순된 꼴이 된다). 구조화된 코드가 없으므로 본문으로 가릴 수밖에 없다.
 * 대신 판정은 보수적으로: 확실한 문구만 잡고 애매하면 false(= 종전대로 카운트)로 둔다. 과잉 분류는
 * 진짜 결함을 "일시적"으로 덮어 무한 재시도를 만든다 — 그게 카운트가 존재하는 이유다.
 */

/**
 * 시간이 풀어 주는 실패의 표지.
 * - 세션·사용량 한도(구독 플랜 소진) — 실측 문구 그대로.
 * - 429/overloaded — 서버 혼잡. 재시도로 풀린다.
 * - 네트워크 단절 — 소켓·DNS 계열.
 * 타임아웃은 **넣지 않는다**: 프롬프트가 너무 커서 매번 걸리는 구조적 실패일 수 있어, 그건 카운트가
 * 쌓여 사람 눈에 띄는 편이 맞다.
 */
const TRANSIENT_RE = [
  /hit your (?:session|usage) limit/i,
  /session limit .*reset/i,
  /rate[_\s-]?limit/i,
  /\b429\b/,
  /overloaded/i,
  /usage limit reached/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENOTFOUND/,
] as const;

/** 이 실패가 시간이 풀어 주는 종류인가. 순수 — 메시지만 본다. */
export function isTransientFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!msg) return false;
  return TRANSIENT_RE.some((re) => re.test(msg));
}

/** 로그·알림용 짧은 사유. 한도면 해제 시각까지 실어 준다(사람이 언제 다시 돌릴지 판단할 유일한 단서). */
export function transientReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const reset = /resets?\s+([^·\n]+)/i.exec(msg);
  if (/hit your (?:session|usage) limit|usage limit reached/i.test(msg)) {
    return `LLM 사용 한도${reset ? ` — 해제 ${reset[1]!.trim()}` : ''}`;
  }
  if (/rate[_\s-]?limit|\b429\b|overloaded/i.test(msg)) return 'LLM 혼잡(재시도로 해소)';
  return '일시적 네트워크 실패';
}
