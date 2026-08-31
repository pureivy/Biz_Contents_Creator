import { describe, it, expect, afterEach, vi } from 'vitest';
import { llm } from '../llm/client';
import { getCompany } from '../agents/company-loader';
import { jarvisChat, jarvisSystemPrompt, jarvisPersona } from './chat';

afterEach(() => vi.restoreAllMocks());

describe('jarvisChat', () => {
  it('잡담: 페르소나 system 메시지 + reply 반환(delegate 없음)', async () => {
    const spy = vi.spyOn(llm, 'chat').mockResolvedValue({ text: '안녕하세요, 자비스예요.' } as never);
    const r = await jarvisChat([{ role: 'user', content: '자비스' }]);
    expect(r.reply).toContain('자비스');
    expect(r.delegate).toBeUndefined();
    const sys = (spy.mock.calls[0]![0] as { messages: { role: string; content: string }[] }).messages[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content.length).toBeGreaterThan(10);
  });

  it('업무지시: 끝줄 delegate JSON 을 파싱하고 reply 에서 JSON 제거', async () => {
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: '네, 전달하겠습니다.\n{"delegate":{"task":"예산 회의 자료 준비"}}',
    } as never);
    const r = await jarvisChat([{ role: 'user', content: '예산 회의 자료 준비해줘' }]);
    expect(r.delegate?.task).toContain('예산');
    expect(r.reply).not.toContain('{');
    expect(r.reply).toContain('전달');
  });

  it('위임: 유효 직원 id 는 delegate.agent 로 채택, 무효 id 는 무시', async () => {
    vi.spyOn(llm, 'chat')
      .mockResolvedValueOnce({ text: '네.\n{"delegate":{"task":"예산 정리","agent":"seo_strategist"}}' } as never)
      .mockResolvedValueOnce({ text: '네.\n{"delegate":{"task":"예산 정리","agent":"nobody_xyz"}}' } as never);
    const ok = await jarvisChat([{ role: 'user', content: '예산 정리해줘' }]);
    expect(ok.delegate?.agent).toBe('seo_strategist');
    const bad = await jarvisChat([{ role: 'user', content: '예산 정리해줘' }]);
    expect(bad.delegate?.task).toContain('예산');
    expect(bad.delegate?.agent).toBeUndefined();   // 무효 id → 미채택
  });

  it('jarvisSystemPrompt 는 직원 목록을 포함한다', () => {
    const p = jarvisSystemPrompt();
    expect(p.length).toBeGreaterThan(20);
    expect(p).toContain('직원 목록');
  });

  it('jarvisSystemPrompt 는 현재 KST 시각을 주입한다(날짜 추측 방지)', () => {
    const p = jarvisSystemPrompt();
    expect(p).toContain('현재 시각');
    expect(p).toContain('(KST)');
    expect(p).toMatch(/\d{4}년/); // 연도 포함
  });

  it('jarvisSystemPrompt 로스터는 비서(자비스) 자신을 위임 후보로 넣지 않는다', () => {
    const p = jarvisSystemPrompt();
    expect(p).toContain('seo_strategist');   // 실제 직원은 후보에 있음
    expect(p).not.toContain('secretary |');  // 비서(자비스) 로스터 항목 제외(자기위임 방지)
  });

  it('jarvisSystemPrompt 로스터는 specialty(주요 업무)·담당선택 규칙을 포함한다', () => {
    const p = jarvisSystemPrompt();
    expect(p).toContain('키워드');      // specialty(주요 업무) 노출 — 콘텐츠 역할 변별 단서
    expect(p).toContain('팀장');        // 복합 업무는 팀장 규칙
    expect(p).toContain('비서 본연');   // 비서 본연 업무는 직접 처리(위임 안 함)
  });

  it('jarvisPersona: secretary 역할 system_prompt(직원 탭 편집)가 있으면 그것을 페르소나로 쓴다', () => {
    expect(jarvisPersona({ systemPrompt: '나는 커스텀 비서다.' })).toEqual(['나는 커스텀 비서다.']);
    expect(jarvisPersona({ systemPrompt: '   ' }).join('\n')).toContain('자비스');  // 공백뿐 → 내장 기본
    expect(jarvisPersona(undefined).join('\n')).toContain('주인님');                // 역할 미등록 → 내장 기본
  });

  it('jarvisSystemPrompt 팀장 규칙·로스터는 standby 팀(위임 불가)을 제외한다', () => {
    const p = jarvisSystemPrompt();
    // standby 팀장은 specialists 에 없어 위임 불가 — 규칙에만 있으면 모델이 골라도 강등되므로 아예 비노출.
    // 특정 팀 id 하드코딩 대신 라이브 로스터에서 도출 — 데이터에서 standby 구성이 바뀌어도 위양성 없음.
    const standbyLeads = (getCompany().teams ?? []).filter((t) => t.standby).map((t) => t.lead.id);
    expect(standbyLeads.length).toBeGreaterThan(0);   // 비서실은 ensureSecretariat 로 항상 존재
    for (const id of standbyLeads) expect(p).not.toContain(id);
  });

  it('위임: 비서(자비스) 자신 id 는 위임 대상으로 채택하지 않는다', async () => {
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: '네.\n{"delegate":{"task":"회의 준비","agent":"secretary"}}',
    } as never);
    const r = await jarvisChat([{ role: 'user', content: '회의 준비해줘' }]);
    expect(r.delegate?.task).toContain('회의');
    expect(r.delegate?.agent).toBeUndefined();   // 자기위임 방지
  });
});
