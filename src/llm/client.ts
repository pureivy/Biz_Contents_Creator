/**
 * LLM 프로바이더 파사드 — Claude Code CLI 단일 백엔드(구독 인증 — llm/claudeCli.ts).
 * Ollama 백엔드는 제거됨(2026-07-06 2단계). 호출부는 `llm.chat` 만 사용한다.
 * (테스트가 llm.chat 을 spy 하므로 객체 파사드 형태를 유지한다.)
 */
import type { ChatParams, ChatResult } from './types';
import { claudeCli } from './claudeCli';

export const llm = {
  chat(params: ChatParams): Promise<ChatResult> {
    return claudeCli.chat(params);
  },
};
