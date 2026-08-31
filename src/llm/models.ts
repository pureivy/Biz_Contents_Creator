/**
 * 역할 tier → 모델 배정 타입 + 조회 헬퍼.
 *
 * RAM 예산 기반 로컬(Ollama) 자동배정(getSystemSpecs/autoAssignModels/estimateModelMemoryGB)은
 * Ollama 백엔드 제거(2026-07-06 2단계)와 함께 삭제 — 배정은 setting.ts resolveAssignment 가
 * CONFIG.cloudTierModels(haiku/sonnet/opus)로 고정 반환한다.
 */

export type RoleTier = 'micro' | 'standard' | 'heavy';

export interface ModelAssignment {
  micro: string;    // 분해·배정·수렴판정·분류·리플렉트 등 구조적 단발 호출
  standard: string; // 전문가/팀원 본작업
  heavy: string;    // CEO 통합·종합(긴 산출물)
  reason: string;
}

/** 역할 tier → 배정된 모델 ID. */
export function modelForTier(assign: ModelAssignment, tier: RoleTier): string {
  return tier === 'micro' ? assign.micro : tier === 'heavy' ? assign.heavy : assign.standard;
}
