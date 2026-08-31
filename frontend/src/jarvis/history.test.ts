import { describe, it, expect } from 'vitest';
import { toApiMessages } from './history';

describe('toApiMessages', () => {
  it('jarvis→assistant 매핑 + text→content', () => {
    const out = toApiMessages([{ role: 'user', text: '안녕' }, { role: 'jarvis', text: '안녕하세요' }]);
    expect(out).toEqual([{ role: 'user', content: '안녕' }, { role: 'assistant', content: '안녕하세요' }]);
  });
  it('최근 limit 턴만', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: String(i) }));
    expect(toApiMessages(turns, 12)).toHaveLength(12);
    expect(toApiMessages(turns, 12)[0]!.content).toBe('8');
  });
});
