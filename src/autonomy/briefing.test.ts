import { describe, it, expect } from 'vitest';
import { composeBriefing } from './briefing';

describe('composeBriefing', () => {
  it('섹션을 제목 + 본문으로 조립한다', () => {
    const m = composeBriefing('2026-06-19', [
      { heading: '📚 지식', body: '100페이지' },
      { heading: '⚖️ 결정', body: 'A안을 채택' },
    ]);
    expect(m.title).toContain('2026-06-19');
    expect(m.body).toContain('📚 지식');
    expect(m.body).toContain('A안을 채택');
  });

  it('빈 섹션은 제외한다', () => {
    const m = composeBriefing('2026-06-19', [
      { heading: '빈섹션', body: '   ' },
      { heading: '있음', body: '실제 내용' },
    ]);
    expect(m.body).not.toContain('빈섹션');
    expect(m.body).toContain('실제 내용');
  });

  it('전부 비면 기본 문구', () => {
    expect(composeBriefing('2026-06-19', []).body).toContain('특별한 활동이 없습니다');
  });
});
