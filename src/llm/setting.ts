/**
 * 런타임 LLM 설정 — Claude 단일 백엔드로 고정.
 *
 * 과거에는 웹 UI 에서 로컬(Ollama)·Claude 를 오가는 토글을 data/llm.json 에 영속했지만,
 * 스튜디오가 Claude CLI 단독 운용으로 확정되며 Ollama 경로를 제거했다(2026-07-06, 1단계).
 * 기존 호출부(서버 라우트·prepare·UI)와의 호환을 위해 export 시그니처는 유지하고,
 * 값만 'claude' 로 고정한다 — data/llm.json 의 잔존 local 설정은 무시된다.
 */
import { CONFIG } from '../config';
import type { ModelAssignment } from './models';

export interface LlmSetting {
  /** 항상 'claude' — Ollama 백엔드 제거됨. */
  backend: string;
  /** 항상 '' — 로컬 모델 선택 제거됨(하위 호환용 필드). */
  localModel: string;
}

const FIXED: LlmSetting = { backend: 'claude', localModel: '' };

export function getLlmSetting(): LlmSetting {
  return FIXED;
}

/** 하위 호환 no-op — 어떤 입력이 와도 Claude 고정 설정을 돌려준다(디스크 기록 없음). */
export function setLlmSetting(_s: { backend?: string; localModel?: string }): LlmSetting {
  return FIXED;
}

/** 현재 백엔드가 Claude(클라우드)인가 — 항상 true(Ollama 제거). */
export function isClaudeBackend(): boolean {
  return true;
}

/** 모델 배정 — Claude 고정 클라우드 티어맵(haiku/sonnet/opus). */
export function resolveAssignment(): ModelAssignment {
  const c = CONFIG.cloudTierModels;
  return { micro: c.micro, standard: c.standard, heavy: c.heavy, reason: `Claude 클라우드 티어 — micro=${c.micro} standard=${c.standard} heavy=${c.heavy}` };
}
