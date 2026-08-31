import { describe, it, expect } from 'vitest';
import { mergeVerdicts, buildVerdictBlock, type TopicVerdict } from './topicVerdicts';

const v = (keyword: string, verdict: TopicVerdict['verdict'], reason = '월 20회 무볼륨', ts = '2026-08-20T00:00:00.000Z'): TopicVerdict =>
  ({ keyword, verdict, reason, ts });

describe('mergeVerdicts — 키워드 정규화 동치는 새 판정이 이긴다', () => {
  it('같은 키워드(공백·대소문자 무시)는 next 가 prev 를 대체한다', () => {
    const out = mergeVerdicts([v('가을 나무 심기', 'opportunity', '옛 판정')], [v('가을나무심기', 'avoid', '월 20회 무볼륨')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.verdict).toBe('avoid');
  });
  it('next 내부 중복은 첫 항목만 남고, prev 의 다른 키워드는 보존된다', () => {
    const out = mergeVerdicts([v('조경수', 'opportunity')], [v('처서', 'avoid', '1차'), v('처서', 'avoid', '2차')]);
    expect(out.map((x) => x.keyword)).toEqual(['처서', '조경수']);
    expect(out[0]!.reason).toBe('1차');
  });
  it('판정·근거가 동일한 재추출은 기존 ts 를 보존한다 — TTL 이 매일 리셋되지 않게(리뷰 지적)', () => {
    const old = v('조경수', 'opportunity', '월 8,630회', '2026-07-10T00:00:00.000Z');
    const re = v('조경수', 'opportunity', '월 8,630회', '2026-08-20T00:00:00.000Z');
    expect(mergeVerdicts([old], [re])[0]!.ts).toBe('2026-07-10T00:00:00.000Z');
    const changed = v('조경수', 'avoid', '경쟁 급증', '2026-08-20T00:00:00.000Z');
    expect(mergeVerdicts([old], [changed])[0]!.ts).toBe('2026-08-20T00:00:00.000Z');
  });
});

describe('buildVerdictBlock — 주제 두뇌 주입 블록(순수)', () => {
  it('avoid·opportunity 를 나눠 담고 근거·날짜를 포함한다', () => {
    const block = buildVerdictBlock([v('처서', 'avoid', '자동완성 직결률 0%'), v('조경수', 'opportunity', '월 8,630회·경쟁 약함')]);
    expect(block).toContain('검증된 기회');
    expect(block).toContain('조경수 — 월 8,630회·경쟁 약함 (2026-08-20)');
    expect(block).toContain('실측 폐기');
    expect(block).toContain('처서 — 자동완성 직결률 0%');
  });
  it('판정이 없으면 빈 문자열(무주입)', () => {
    expect(buildVerdictBlock([])).toBe('');
  });
  it('소진된 기회(consumedTs)는 블록에서 빠진다 — 채택 다음 날 반복 주입 방지(2026-08-24 포도 실사고)', () => {
    const consumed = { ...v('포도나무 가지치기', 'opportunity', '월 210회'), consumedTs: '2026-08-24T00:00:00.000Z' };
    expect(buildVerdictBlock([consumed])).toBe('');
    expect(buildVerdictBlock([consumed, v('조경수', 'opportunity', '월 8,630회')])).not.toContain('포도나무 가지치기');
  });
  it('동일 판정·근거 재추출 병합은 소진 상태도 보존한다', () => {
    const consumed = { ...v('포도나무 가지치기', 'opportunity', '월 210회', '2026-08-23T00:00:00.000Z'), consumedTs: '2026-08-24T00:00:00.000Z' };
    const re = v('포도나무 가지치기', 'opportunity', '월 210회', '2026-08-25T00:00:00.000Z');
    expect(mergeVerdicts([consumed], [re])[0]!.consumedTs).toBe('2026-08-24T00:00:00.000Z');
  });
});
