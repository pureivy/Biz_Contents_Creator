import { describe, it, expect } from 'vitest';
import { parseToolCalls, toolsForAutonomy, toolInstructions, stripToolTags, READ_TOOLS, WRITE_TOOLS } from './tools';

describe('parseToolCalls (XML 액션태그)', () => {
  it('단일 호출을 추출한다', () => {
    expect(parseToolCalls('분석 중… <tool name="wiki_query">경북 수출</tool> 더 보겠습니다.'))
      .toEqual([{ name: 'wiki_query', arg: '경북 수출' }]);
  });
  it('여러 호출을 순서대로 추출한다', () => {
    const r = parseToolCalls('<tool name="wiki_query">A</tool>\n<tool name="web_search">B</tool>');
    expect(r.map((c) => c.name)).toEqual(['wiki_query', 'web_search']);
    expect(r.map((c) => c.arg)).toEqual(['A', 'B']);
  });
  it('따옴표 변형(작은따옴표·없음)을 허용한다', () => {
    expect(parseToolCalls("<tool name='dart'>삼성전자</tool>")).toEqual([{ name: 'dart', arg: '삼성전자' }]);
    expect(parseToolCalls('<tool name=law>도로교통법</tool>')).toEqual([{ name: 'law', arg: '도로교통법' }]);
  });
  it('태그 이름은 소문자로 정규화한다', () => {
    expect(parseToolCalls('<tool name="Wiki_Query">x</tool>')[0]!.name).toBe('wiki_query');
  });
  it('빈 인자 호출과 태그 없는 텍스트는 버린다', () => {
    expect(parseToolCalls('<tool name="wiki_query"></tool>')).toEqual([]);
    expect(parseToolCalls('그냥 일반 답변입니다.')).toEqual([]);
  });
  it('빈 입력은 빈 배열', () => {
    expect(parseToolCalls('')).toEqual([]);
  });
});

describe('toolsForAutonomy (거버넌스 게이트)', () => {
  const allowed = ['wiki_query', 'web_search', 'dart', 'save_note'];
  it('autonomy 0 = 도구 없음(off)', () => {
    expect(toolsForAutonomy(allowed, 0)).toEqual([]);
  });
  it('autonomy 1 = 읽기 도구만(쓰기 제외)', () => {
    const r = toolsForAutonomy(allowed, 1);
    expect(r).toContain('wiki_query');
    expect(r).toContain('dart');
    expect(r).not.toContain('save_note');
  });
  it('autonomy 2~3 = 읽기 + 쓰기', () => {
    expect(toolsForAutonomy(allowed, 2)).toContain('save_note');
    expect(toolsForAutonomy(allowed, 3)).toContain('save_note');
  });
  it('중복 제거 + 미지 도구 배제', () => {
    expect(toolsForAutonomy(['wiki_query', 'wiki_query', 'unknown_tool'], 3)).toEqual(['wiki_query']);
  });
  it('READ/WRITE 집합이 분리돼 있다', () => {
    expect(READ_TOOLS.has('wiki_query')).toBe(true);
    expect(WRITE_TOOLS.has('save_note')).toBe(true);
    expect(READ_TOOLS.has('save_note')).toBe(false);
  });
});

describe('toolInstructions', () => {
  it('도구가 없으면 빈 문자열(주입 안 함)', () => {
    expect(toolInstructions([])).toBe('');
  });
  it('도구 이름과 형식 안내를 포함한다', () => {
    const s = toolInstructions(['wiki_query', 'save_note']);
    expect(s).toContain('wiki_query');
    expect(s).toContain('save_note');
    expect(s).toContain('<tool name=');
  });
});

describe('stripToolTags', () => {
  it('잔여 tool/tool_result 태그를 제거한다', () => {
    const t = '결론입니다. <tool name="wiki_query">x</tool>\n<tool_result name="wiki_query">자료</tool_result>\n끝.';
    const r = stripToolTags(t);
    expect(r).not.toContain('<tool');
    expect(r).toContain('결론입니다.');
    expect(r).toContain('끝.');
  });
  it('빈 입력은 빈 문자열', () => {
    expect(stripToolTags('')).toBe('');
  });
});
