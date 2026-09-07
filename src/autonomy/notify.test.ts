import { describe, it, expect } from 'vitest';
import { shouldRetryTelegram } from './notify';

// 실사고 2건이 이 판정을 만들었다 — 방향이 정반대라 함께 적는다.
//
// ① 2026-08-31 오전: 알림이 "fetch failed" 한 번에 **영구 소실**됐다(재시도 없음). → 재시도 도입.
// ② 2026-08-31 밤: 그 재시도가 **중복 2통**을 만들었다. 로그는
//      [알림] 텔레그램 sendMessage 예외 — fetch failed
//      [알림] 텔레그램 sendMessage 복구(재시도 1회 후)
//    인데 사용자에겐 2통이 도착했다. 즉 첫 전송은 **텔레그램에 이미 닿았고** 응답만 못 받은 것이다.
//
// sendMessage 는 멱등 키가 없어 '보냈는지 모르는' 실패를 재시도하면 반드시 중복이 난다.
// 그래서 판정 기준을 '실패했나'가 아니라 **'전송되지 않았음이 확실한가'** 로 바꾼다:
//   확실히 미전송 — DNS 실패·연결 거부(요청이 서버에 닿지도 않음), 429·5xx(서버가 명시적으로 거절)
//   불확실       — 타임아웃·연결 리셋·소켓 종료(요청은 갔을 수 있고 응답만 유실)
// 불확실은 재시도하지 않는다. 사용자가 원한 건 1통이고, 중복은 소음이지만 확실한 손해다.
describe('shouldRetryTelegram — 전송 재시도 판정(전송되지 않았음이 확실할 때만)', () => {
  const err = (msg: string, code?: string): Error => {
    const e = new TypeError(msg) as Error & { cause?: unknown };
    if (code) e.cause = { code };
    return e;
  };

  it('DNS 실패는 재시도한다 — 요청이 텔레그램에 닿지 않았다', () => {
    expect(shouldRetryTelegram({ error: err('fetch failed', 'ENOTFOUND') })).toBe(true);
    expect(shouldRetryTelegram({ error: err('fetch failed', 'EAI_AGAIN') })).toBe(true);
  });

  it('연결 거부도 재시도한다 — 마찬가지로 미전송이 확실하다', () => {
    expect(shouldRetryTelegram({ error: err('fetch failed', 'ECONNREFUSED') })).toBe(true);
  });

  it('연결 리셋은 재시도하지 않는다 — 요청이 갔을 수 있어 중복 위험', () => {
    expect(shouldRetryTelegram({ error: err('fetch failed', 'ECONNRESET') })).toBe(false);
    expect(shouldRetryTelegram({ error: err('fetch failed', 'UND_ERR_SOCKET') })).toBe(false);
  });

  it('타임아웃은 재시도하지 않는다 — 실사고 ②의 중복 원인', () => {
    const t = new Error('The operation was aborted due to timeout'); t.name = 'TimeoutError';
    expect(shouldRetryTelegram({ error: t })).toBe(false);
    const a = new Error('This operation was aborted'); a.name = 'AbortError';
    expect(shouldRetryTelegram({ error: a })).toBe(false);
  });

  it('사유를 알 수 없는 네트워크 예외는 재시도하지 않는다(보수적 기본값)', () => {
    expect(shouldRetryTelegram({ error: err('fetch failed') })).toBe(false);
  });

  it('429·5xx 는 재시도한다 — 서버가 명시적으로 거절해 처리되지 않았다', () => {
    expect(shouldRetryTelegram({ status: 429 })).toBe(true);
    expect(shouldRetryTelegram({ status: 500 })).toBe(true);
    expect(shouldRetryTelegram({ status: 502 })).toBe(true);
  });

  it('4xx(토큰·chat not found·파싱 오류)는 재시도하지 않는다 — 몇 번 보내도 같다', () => {
    expect(shouldRetryTelegram({ status: 400 })).toBe(false);
    expect(shouldRetryTelegram({ status: 401 })).toBe(false);
    expect(shouldRetryTelegram({ status: 403 })).toBe(false);
  });

  it('성공·정보 없음은 재시도 대상이 아니다', () => {
    expect(shouldRetryTelegram({ status: 200 })).toBe(false);
    expect(shouldRetryTelegram({})).toBe(false);
  });
});
