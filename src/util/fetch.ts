/**
 * 외부 fetch + 타임아웃 — run signal(취소)과 타임아웃 signal 을 결합해, 외부 그라운딩 API 가 응답하지
 * 않아도 무한 대기하지 않게 한다(리뷰 발견: 커넥터 fetch 가 signal 만 받고 타임아웃이 없어 work 단계가
 * 외부 API 무응답 시 멈췄다). 타임아웃/취소 시 fetch 가 AbortError 를 던지므로, 호출부 try/catch 가
 * 빈 결과로 처리해 런은 중단 없이 진행된다.
 */
import { CONFIG } from '../config';
import { anySignal } from './abort';

export function fetchTimeout(
  url: string,
  opts: RequestInit = {},
  signal?: AbortSignal,
  ms: number = CONFIG.groundingTimeoutMs,
): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  return fetch(url, { ...opts, signal: signal ? anySignal([signal, timeout]) : timeout });
}
