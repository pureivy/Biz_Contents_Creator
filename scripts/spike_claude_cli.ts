/**
 * Claude Code CLI 클라이언트 스파이크 — llm/claudeCli.ts 가 ChatParams→ChatResult 계약을
 * 구독 인증으로 이행하는지 실호출 검증(스트리밍·JSON·멀티턴).
 * 실행: pnpm exec tsx scripts/spike_claude_cli.ts
 */
import { llm } from '../src/llm/client';

async function main() {
  // 1) 스트리밍 — onDelta 로 토큰이 흘러오는지
  let deltas = 0;
  const r1 = await llm.chat({
    model: 'claude-haiku-4-5',
    messages: [
      { role: 'system', content: '간결히 답하라.' },
      { role: 'user', content: '한국의 수도는? 한 단어로.' },
    ],
    maxOutputTokens: 100,
    onDelta: () => { deltas++; },
  });
  console.log('[1 스트리밍]', JSON.stringify({ text: r1.text, deltas, inTok: r1.promptEvalCount, outTok: r1.evalCount, ms: r1.totalDurationMs, done: r1.doneReason }));
  if (!r1.text.includes('서울') || deltas < 1) throw new Error('스트리밍 케이스 실패');

  // 2) JSON — format:'json'(effort low 경로) + 파싱 가능 여부
  const r2 = await llm.chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '{"a":1,"b":2} 의 a+b 를 {"sum": <값>} JSON 으로만 답해.' }],
    maxOutputTokens: 200,
    format: 'json',
  });
  const m = r2.text.match(/\{[\s\S]*\}/);
  const parsed = m ? (JSON.parse(m[0]) as { sum?: number }) : null;
  console.log('[2 JSON]', JSON.stringify({ text: r2.text.slice(0, 80), sum: parsed?.sum, ms: r2.totalDurationMs }));
  if (parsed?.sum !== 3) throw new Error('JSON 케이스 실패');

  // 3) 멀티턴 — assistant 이력 포함 직렬화가 맥락을 보존하는지
  const r3 = await llm.chat({
    model: 'claude-haiku-4-5',
    messages: [
      { role: 'user', content: '내 이름은 남상범이야.' },
      { role: 'assistant', content: '반갑습니다, 남상범 님.' },
      { role: 'user', content: '내 이름이 뭐라고 했지? 이름만 답해.' },
    ],
    maxOutputTokens: 100,
  });
  console.log('[3 멀티턴]', JSON.stringify({ text: r3.text, ms: r3.totalDurationMs }));
  if (!r3.text.includes('남상범')) throw new Error('멀티턴 케이스 실패');

  console.log('✅ 3/3 통과');
}

main().catch((e) => { console.error('❌', (e as Error).message); process.exit(1); });
