import { describe, it, expect } from 'vitest';
import { extractFirstJson, buildGroundDirective } from './agent';

describe('extractFirstJson', () => {
  it('순수 JSON 객체를 파싱한다', () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('코드펜스를 벗긴다', () => {
    expect(extractFirstJson('```json\n{"x":[1,2]}\n```')).toEqual({ x: [1, 2] });
  });
  it('머리말이 있어도 첫 객체를 뽑는다', () => {
    const raw = '네, 분해 결과입니다:\n{"subproblems":[{"id":"sp1","text":"a"}]}\n끝.';
    expect(extractFirstJson<{ subproblems: unknown[] }>(raw)?.subproblems).toHaveLength(1);
  });
  it('문자열 안의 중괄호에 속지 않는다', () => {
    expect(extractFirstJson('{"t":"a {nested} b"}')).toEqual({ t: 'a {nested} b' });
  });
  it('JSON 이 없으면 null', () => {
    expect(extractFirstJson('그냥 텍스트')).toBeNull();
  });
});

// 사실 게이트 세탁 고리 차단(2026-08-26 최종 리뷰 F2) — groundForFacts 경로(블로그 본문 작가)에서는
// 게이트에 보이는 표식(⚠️ 데이터 없음 / [근거: …])을 쓰라고 지시하면 안 된다. extractFactClaims 가
// 주장 텍스트를 그대로 뜨므로 문장 안의 "[근거: 확립된 원예학 지식]" 이 판정기를 supported 로 밀어
// 게이트를 통과시킨다. 리서치 work 단계는 사람이 읽는 산출물이라 4규칙 전부 유지.
describe('buildGroundDirective — 그라운딩 작성 규칙(순수)', () => {
  it('사실 게이트 대상(forFacts)에서는 표식 규칙 3)·4) 를 빼고 1)·2) 만 남긴다', () => {
    const d = buildGroundDirective(true, 'synthesis', true);
    expect(d).toContain('1)');
    expect(d).toContain('2)');
    expect(d).toContain('플레이스홀더');
    expect(d).not.toContain('데이터 없음');
    expect(d).not.toContain('[근거:');
    expect(d).not.toContain('3)');
    expect(d).not.toContain('4)');
  });
  it('리서치 work 단계(forFacts 아님)는 4규칙 전부 유지', () => {
    const d = buildGroundDirective(true, 'work', false);
    expect(d).toContain('데이터 없음');
    expect(d).toContain('[근거:');
  });
  it('근거가 없거나 work·synthesis 가 아니면 빈 문자열', () => {
    expect(buildGroundDirective(false, 'synthesis', false)).toBe('');
    expect(buildGroundDirective(true, 'critique', false)).toBe('');
  });
});
