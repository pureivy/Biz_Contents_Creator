/**
 * 벤치마크 하네스 — 헤드리스로 한 런을 돌려 로컬 LLM 속도를 측정.
 *   측정: 단계별 프롬프트/출력 토큰, tok/s, 호출 시간, 총 벽시계, 절단 여부.
 *   목적: "프롬프트가 작다(프리필 적다)"는 본 구현의 속도 우위를 수치로 증명.
 *
 * 실행:  pnpm exec tsx src/bench/bench.ts "벤치마크할 주제"
 */
import { performance } from 'node:perf_hooks';
import { createBus, disposeBus } from '../events/bus';
import { EventType } from '../events/types';
import type { LlmMetricPayload } from '../events/types';
import { runId } from '../util/ids';
import { startRun } from '../orchestrator/index';

async function main(): Promise<void> {
  const topic = process.argv[2] ?? '로컬 LLM 멀티에이전트 오케스트레이션을 빠르게 만드는 핵심 전략';
  const id = runId();
  const bus = createBus(id);
  const metrics: LlmMetricPayload[] = [];

  bus.subscribe((ev) => {
    if (ev.type === EventType.llm_metric) metrics.push(ev.payload as unknown as LlmMetricPayload);
    if (ev.type === EventType.log) process.stdout.write(`· ${(ev.payload as { message?: string }).message ?? ''}\n`);
    if (ev.type === EventType.team_spawned) {
      const p = ev.payload as { name?: string; lead?: string; members?: string[] };
      process.stdout.write(`▸ 팀 가동: ${p.name} (리드 ${p.lead}, 팀원 ${(p.members ?? []).join(',') || '없음'})\n`);
    }
    if (ev.type === EventType.team_deliverable) process.stdout.write(`◂ 팀 산출물 완료: ${(ev.payload as { team_id?: string }).team_id}\n`);
  });

  console.log(`\n=== 벤치마크 시작 ===\n주제: ${topic}\n`);
  const t0 = performance.now();
  let status = 'ok';
  try {
    await startRun(bus, { topic });
  } catch (e) {
    status = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  const wallMs = performance.now() - t0;
  disposeBus(id);

  // 표 출력
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log('\n=== 단계별 LLM 메트릭 ===');
  console.log(pad('stage', 12), pad('agent', 11), pad('model', 22), pad('in', 6), pad('out', 7), pad('tok/s', 7), 'ms');
  let totInTok = 0, totOutTok = 0, totLlmMs = 0;
  for (const m of metrics) {
    console.log(
      pad(m.stage, 12), pad(m.agent_id, 11), pad(m.model, 22),
      pad(String(m.prompt_tokens), 6), pad(String(m.output_tokens), 7),
      pad(String(m.tok_per_s), 7), Math.round(m.total_ms) + (m.truncated ? ' (truncated!)' : ''),
    );
    totInTok += m.prompt_tokens; totOutTok += m.output_tokens; totLlmMs += m.total_ms;
  }
  const avgTokS = totLlmMs > 0 ? (totOutTok / (totLlmMs / 1000)) : 0;
  console.log('\n=== 요약 ===');
  console.log(`상태:           ${status}`);
  console.log(`LLM 호출 수:    ${metrics.length}`);
  console.log(`총 입력 토큰:   ${totInTok}  (호출당 평균 ${metrics.length ? Math.round(totInTok / metrics.length) : 0} — 작을수록 프리필 적음)`);
  console.log(`총 출력 토큰:   ${totOutTok}`);
  console.log(`평균 생성속도:  ${avgTokS.toFixed(1)} tok/s`);
  console.log(`총 벽시계:      ${(wallMs / 1000).toFixed(1)}s  (LLM 합 ${(totLlmMs / 1000).toFixed(1)}s + 오버헤드)`);
  console.log('');
}

void main();
