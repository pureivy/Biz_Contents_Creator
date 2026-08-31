import { describe, it, expect } from 'vitest';
import { isTransientFailure, transientReason } from './transientError';

// 고정 표본 — 실사고(2026-08-28 자율 틱)에서 events.jsonl 에 실제로 기록된 문자열.
// CLI 가 한도를 is_error:true + subtype:'success' 로 돌려줘 "success — …"라는 모순된 꼴이 된다.
const REAL = "Claude CLI claude-haiku-4-5: success — You've hit your session limit · resets 1:40pm (Asia/Seoul)";

describe('isTransientFailure — 시간이 풀어 주는 실패', () => {
  it('실사고 문자열을 일시적 실패로 본다', () => {
    expect(isTransientFailure(new Error(REAL))).toBe(true);
    expect(isTransientFailure(REAL)).toBe(true);
  });

  it.each([
    ['사용량 한도', 'usage limit reached · resets 3pm'],
    ['429', 'HTTP 429 Too Many Requests'],
    ['혼잡', 'Error: overloaded_error'],
    ['rate limit', 'rate_limit_error'],
    ['네트워크', 'connect ECONNRESET 127.0.0.1:443'],
    ['DNS', 'getaddrinfo EAI_AGAIN api.anthropic.com'],
  ])('%s → 일시적', (_l, msg) => {
    expect(isTransientFailure(new Error(msg))).toBe(true);
  });

  it.each([
    ['기획 실패', '기획 실패 — 작가 JSON 응답을 해석할 수 없습니다'],
    ['빈 산출물', '모든 팀이 빈 산출물 — 통합할 내용이 없습니다.'],
    ['길이 상한', '길이 상한 초과 — 60.7초 > 60초(재감량 후에도 초과)'],
    ['타임아웃', 'Claude CLI: 타임아웃(600000ms)'],
    ['빈 메시지', ''],
  ])('%s → 일시적 아님(카운트해야 사람 눈에 띈다)', (_l, msg) => {
    expect(isTransientFailure(new Error(msg))).toBe(false);
  });

  it('타임아웃을 일부러 제외한다 — 매번 걸리는 구조적 실패일 수 있다', () => {
    expect(isTransientFailure(new Error('타임아웃(600000ms)'))).toBe(false);
  });

  it('null·undefined 도 안전하게 false', () => {
    expect(isTransientFailure(null)).toBe(false);
    expect(isTransientFailure(undefined)).toBe(false);
  });
});

describe('transientReason — 사람이 읽는 사유', () => {
  it('한도면 해제 시각을 실어 준다(언제 다시 돌릴지 판단할 단서)', () => {
    expect(transientReason(new Error(REAL))).toBe('LLM 사용 한도 — 해제 1:40pm (Asia/Seoul)');
  });

  it('해제 시각이 없으면 사유만', () => {
    expect(transientReason(new Error("You've hit your session limit"))).toBe('LLM 사용 한도');
  });

  it('혼잡·네트워크를 구분한다', () => {
    expect(transientReason(new Error('overloaded_error'))).toBe('LLM 혼잡(재시도로 해소)');
    expect(transientReason(new Error('ECONNRESET'))).toBe('일시적 네트워크 실패');
  });
});
