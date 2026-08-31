import { describe, it, expect } from 'vitest';
import { noteGrounding, groundingEntries, clearGrounding } from './groundingLedger';

describe('groundingLedger — 런별 조회 원장', () => {
  it('기록·중복 제거·조회·삭제', () => {
    noteGrounding('r1', [{ label: '검색광고 실검색량', kind: 'connector' }, { label: '검색광고 실검색량', kind: 'connector' }]);
    noteGrounding('r1', [{ label: 'https://a.example/x', kind: 'web' }]);
    expect(groundingEntries('r1')).toEqual([{ label: '검색광고 실검색량', kind: 'connector' }, { label: 'https://a.example/x', kind: 'web' }]);
    expect(groundingEntries('없음')).toEqual([]);
    clearGrounding('r1');
    expect(groundingEntries('r1')).toEqual([]);
  });
  it('런 100개 상한 — 오래된 런부터 밀려난다', () => {
    for (let i = 0; i < 105; i++) noteGrounding(`run-${i}`, [{ label: 'x', kind: 'connector' }]);
    expect(groundingEntries('run-0')).toEqual([]);
    expect(groundingEntries('run-104')).toHaveLength(1);
  });
});
