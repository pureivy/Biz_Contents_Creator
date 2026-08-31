export type JarvisUiTurn = { role: 'user' | 'jarvis'; text: string };
export type ApiMessage = { role: 'user' | 'assistant'; content: string };

/** UI 턴(jarvis)을 API 형식(assistant)으로 매핑 + 최근 limit 턴만. */
export function toApiMessages(turns: JarvisUiTurn[], limit = 12): ApiMessage[] {
  return turns.slice(-limit).map((t) => ({
    role: t.role === 'jarvis' ? 'assistant' : 'user',
    content: t.text,
  }));
}
