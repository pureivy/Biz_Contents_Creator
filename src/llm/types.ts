/**
 * LLM 채팅 계약 타입 — Claude CLI 클라이언트(claudeCli.ts)가 구현한다.
 * (원래 ollama.ts 에 살던 타입 — Ollama 백엔드 제거(2026-07-06 2단계)로 여기로 이전.)
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  keepAlive?: string;
  signal?: AbortSignal;
  /** 구조화 출력 힌트 — 'json' 이면 추론을 끄고 프롬프트 지시+관대 파싱(extractFirstJson)으로 처리. */
  format?: 'json';
  /** 추론(thinking) per-call 오버라이드. 미지정이면 runSettings.agentThinking(UI '추론' 토글)을 따른다.
   *  false 로 주면 전역 추론 토글과 무관하게 이 호출은 추론을 끈다(잡담 등 저지연 응답용). */
  think?: boolean;
  /** 비전 입력(로컬 이미지 절대경로) — Read 도구로 열어 봄. */
  visionPaths?: readonly string[];
  /** 토큰 델타 콜백(스트리밍 UI용). */
  onDelta?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  model: string;
  promptEvalCount: number;
  evalCount: number;
  totalDurationMs: number;
  loadDurationMs: number;
  /** 출력 상한 절단 여부. */
  truncated: boolean;
  doneReason: string;
}
