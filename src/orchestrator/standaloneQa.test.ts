import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./agent', () => ({ microJSON: vi.fn() }));
vi.mock('./visionCommon', () => ({ stdModel: vi.fn(() => 'claude-sonnet-5') }));
import { microJSON } from './agent';
import { stdModel } from './visionCommon';
import { parityIssues, parityToInfo } from './standaloneQa';

const m = microJSON as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => m.mockReset());

describe('parityIssues — 파생물 원문 정합(스펙 §2-4)', () => {
  it('원문에 없는 사실·결론 반전을 "항목N:" 꼴로 돌려주고, 프롬프트에 반올림·환산 규칙이 있다', async () => {
    m.mockResolvedValueOnce({ problems: ['항목3: 원문에 없는 수치 "3일"', '항목5: 원문 결론 반전(잎 진 뒤 미루라 → 잎 멀쩡할 때 주라)'] });
    const r = await parityIssues('유튜브 숏폼 대본', ['훅', '전제', '3일이면 됩니다', '…', '잎 멀쩡할 때 주세요'], '## 원문\n잎이 진 뒤로 미루세요.');
    expect(r).toHaveLength(2);
    const user = String(m.mock.calls[0]![2]);
    expect(user).toContain('18~24cm');
    expect(user).toContain('결론 반전');
    expect(user).toContain('## 원문');
  });
  it('claude 계열이 아니면 호출 없이 빈 배열', async () => {
    (stdModel as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('llama3');
    expect(await parityIssues('k', ['a'], 'b')).toEqual([]);
    expect(m).not.toHaveBeenCalled();
  });
  it('실패는 빈 배열(fail-open)', async () => {
    m.mockRejectedValueOnce(new Error('x'));
    expect(await parityIssues('k', ['a'], 'b')).toEqual([]);
  });
  it('parityToInfo', () => {
    expect(parityToInfo([]).status).toBe('pass');
    expect(parityToInfo(['항목1: x'])).toMatchObject({ status: 'hold', unsupported: ['항목1: x'], contradicted: [] });
  });
});
