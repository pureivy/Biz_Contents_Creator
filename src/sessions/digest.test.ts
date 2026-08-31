import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')); vi.doMock('../config', () => ({ CONFIG: { sessionsDir: tmp } })); });
afterEach(() => { vi.doUnmock('../config'); vi.resetModules(); });

describe('세션 파일 IO — research_brief.md / fact_gate.json', () => {
  it('브리프를 쓰고 읽는다(없으면 빈 문자열)', async () => {
    const { writeResearchBrief, readResearchBrief } = await import('./digest');
    expect(readResearchBrief('r1')).toBe('');
    writeResearchBrief('r1', '## 리서치팀\n브리프');
    expect(readResearchBrief('r1')).toBe('## 리서치팀\n브리프');
    expect(fs.existsSync(path.join(tmp, 'r1', 'research_brief.md'))).toBe(true);
  });
  it('게이트 결과를 JSON 으로 쓰고 읽는다(없으면 null)', async () => {
    const { writeFactGate, readFactGate } = await import('./digest');
    expect(readFactGate('r2')).toBeNull();
    const r = { status: 'hold' as const, claims: [], unsupported: ['5cm'], contradicted: [], unverified: [], repaired: false, checkedTs: 't' };
    writeFactGate('r2', r);
    expect(readFactGate('r2')).toEqual(r);
  });
  it('사실 카드를 쓰고 읽는다(없으면 빈 문자열)', async () => {
    const { writeFactCard, readFactCard } = await import('./digest');
    expect(readFactCard('r6')).toBe('');
    writeFactCard('r6', '- 감나무 주머니깍지벌레는 4월 하순부터 약충으로 깨어난다 (근거: 농사로)');
    expect(readFactCard('r6')).toBe('- 감나무 주머니깍지벌레는 4월 하순부터 약충으로 깨어난다 (근거: 농사로)');
    expect(fs.existsSync(path.join(tmp, 'r6', 'fact_card.md'))).toBe(true);
  });
});

describe('readStyleLint — 손상·구 기록 방어(Fix round 1)', () => {
  it('문체 린트 결과를 쓰고 읽는다(없으면 null)', async () => {
    const { writeStyleLint, readStyleLint } = await import('./digest');
    expect(readStyleLint('s1')).toBeNull();
    const r = { issues: ['유보 중첩 — "대개 …경우가 많습니다"'], before: 3, checkedTs: 't' };
    writeStyleLint('s1', r);
    expect(readStyleLint('s1')).toEqual(r);
  });
  it('issues 필드가 없거나 배열이 아니면 null 을 준다(검토 알림이 통째로 유실되던 TypeError 봉합)', async () => {
    const { readStyleLint } = await import('./digest');
    fs.mkdirSync(path.join(tmp, 's2'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 's2', 'style_lint.json'), JSON.stringify({ before: 2, checkedTs: 't' }), 'utf-8');
    expect(readStyleLint('s2')).toBeNull();
    fs.mkdirSync(path.join(tmp, 's3'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 's3', 'style_lint.json'), JSON.stringify({ issues: 3, before: 2, checkedTs: 't' }), 'utf-8');
    expect(readStyleLint('s3')).toBeNull();
  });
});

describe('readResearchBriefWithFallback — research_brief.md 없을 때 work 산출물로 대체', () => {
  it('research_brief.md 가 있으면 그것을 그대로 쓴다(폴백 무시)', async () => {
    const { writeResearchBrief, readResearchBriefWithFallback } = await import('./digest');
    writeResearchBrief('r3', '## 리서치팀\n브리프 본문');
    fs.mkdirSync(path.join(tmp, 'r3'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'r3', 'research.md'), '# 리서치팀 (work)\n\n무시돼야 할 산출물', 'utf-8');
    expect(readResearchBriefWithFallback('r3')).toBe('## 리서치팀\n브리프 본문');
  });
  it('research_brief.md 가 없으면 work 단계 산출물만 이어붙이고, work 아닌 파일·_ 접두·draft 는 뺀다', async () => {
    const dir = path.join(tmp, 'r4');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'research.md'), '# 리서치팀 (work)\n\n연구 산출물 본문', 'utf-8');
    fs.writeFileSync(path.join(dir, 'reviewer.md'), '# 검수 (critique)\n\n검수 의견', 'utf-8');
    fs.writeFileSync(path.join(dir, 'ceo.md'), '# CEO (synthesis)\n\n종합 산출물', 'utf-8');
    fs.writeFileSync(path.join(dir, '_report.md'), '# 최종 종합\n\n보고서', 'utf-8');
    fs.writeFileSync(path.join(dir, 'draft.md'), '# 초안\n\n초안 내용', 'utf-8');
    const { readResearchBriefWithFallback } = await import('./digest');
    expect(readResearchBriefWithFallback('r4')).toBe('## 리서치팀 (work)\n\n연구 산출물 본문');
  });
  it('아무 것도 없으면 빈 문자열', async () => {
    const { readResearchBriefWithFallback } = await import('./digest');
    expect(readResearchBriefWithFallback('r5-없음')).toBe('');
  });
});
