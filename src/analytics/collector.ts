/**
 * 성과 수집기 인터페이스 — 스왑 가능·fail-open. v1 주 경로는 **수동 입력**(POST /pieces/:id/metrics)이라
 * 기본 수집기는 no-op stub(항상 null)이다. 실제 네이버 브라우저 스크레이퍼(로그인/2FA/봇탐지)는 별도
 * 마일스톤에서 이 인터페이스를 구현해 setCollector 로 등록한다 — 수집 실패는 로그+수동 폴백, 절대 루프를
 * 깨거나 piece 를 stranded 시키지 않는다.
 */
import type { Piece } from '../content/pieces';
import type { MetricSample } from './performance';

export interface PerformanceCollector {
  name: string;
  /** piece 성과 측정치를 반환. 미설정·실패면 null(fail-open — 호출자는 수동 입력을 기다린다). */
  measure(piece: Piece): Promise<MetricSample | null>;
}

/** v1 기본 — 자동 수집 없음. 사람이 네이버 통계에서 붙여넣기(수동). */
export const manualCollector: PerformanceCollector = {
  name: 'manual',
  async measure() { return null; },
};

let _collector: PerformanceCollector = manualCollector;
/** 실제 스크레이퍼 등록(스크레이퍼 마일스톤에서). */
export function setCollector(c: PerformanceCollector): void { _collector = c; }
export function getCollector(): PerformanceCollector { return _collector; }
