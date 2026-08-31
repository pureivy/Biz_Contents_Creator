/**
 * 비전 QA 공유 헬퍼 — 쇼츠 씬 QA(shortsSceneQa)와 카드뉴스 QA(cardnews)가 공유하는
 * 게이트·파싱. 비전은 표준 모델이 claude- 일 때만(로컬 백엔드는 이미지 불가 — 환각 방지).
 */
import { CONFIG } from '../config';

export const stdModel = (): string => CONFIG.cloudTierModels.standard;
export const visionCapable = (): boolean => stdModel().startsWith('claude-');

/** 비전 이슈 배열 → 유효(1..count)·중복 제거·정렬된 1-base 불량 순번(순수). key = 'scene' | 'slide' 등. */
export function parseBadIndices(issues: unknown, key: string, count: number): number[] {
  const arr = Array.isArray(issues) ? issues : [];
  const set = new Set<number>();
  for (const it of arr) {
    const k = Math.floor(Number((it as Record<string, unknown> | null)?.[key]));
    if (Number.isFinite(k) && k >= 1 && k <= count) set.add(k);
  }
  return [...set].sort((a, b) => a - b);
}
