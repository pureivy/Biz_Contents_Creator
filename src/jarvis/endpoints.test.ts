import { describe, it, expect, afterEach, vi } from 'vitest';
import { app } from '../server/main';
import { llm } from '../llm/client';

afterEach(() => vi.restoreAllMocks());

describe('POST /jarvis/chat', () => {
  it('빈 messages → 400(LLM 가용 시)', async () => {
    const res = await app.request('/jarvis/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('정상 → {reply} 반환', async () => {
    vi.spyOn(llm, 'chat').mockResolvedValue({ text: '안녕하세요, 자비스예요.' } as never);
    const res = await app.request('/jarvis/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '자비스' }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { reply: string }).reply).toContain('자비스');
  });
});
