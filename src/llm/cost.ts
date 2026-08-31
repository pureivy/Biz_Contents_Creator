/**
 * Claude 사용량 원장 + 비용 추정 — data/llm_usage.json(월별).
 *
 * 사용자 확인상 Claude 구독은 정액이지만(모델 무관), 리뷰어 권고대로 원장·안전캡은 무비용 보험으로 상시 유지한다.
 * 정액이면 이 수치는 참고용, 혹시 메터드로 밝혀지면 이미 추적·게이팅 준비가 돼 있다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

interface Price { input: number; output: number } // USD / 1M tokens (2026-06 기준)
const PRICES: Array<{ re: RegExp; price: Price }> = [
  { re: /opus/i, price: { input: 5, output: 25 } },
  { re: /sonnet/i, price: { input: 3, output: 15 } },
  { re: /haiku/i, price: { input: 1, output: 5 } },
  { re: /fable|mythos/i, price: { input: 10, output: 50 } },
];
function priceFor(model: string): Price {
  for (const p of PRICES) if (p.re.test(model)) return p.price;
  return { input: 3, output: 15 };
}

/** 캐시 읽기는 입력가의 ~0.1×. cacheRead 는 inTok 에 포함된 값(중복 차감). */
export function estCostUsd(model: string, inTok: number, outTok: number, cacheReadTok = 0): number {
  const p = priceFor(model);
  const freshIn = Math.max(0, inTok - cacheReadTok);
  return (freshIn * p.input + cacheReadTok * p.input * 0.1 + outTok * p.output) / 1_000_000;
}

interface MonthLedger { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }
type Ledger = Record<string, MonthLedger>; // key: 'YYYY-MM'

const ledgerFile = (): string => path.join(CONFIG.dataDir, 'llm_usage.json');
let _ledger: Ledger | null = null;

function load(): Ledger {
  if (_ledger) return _ledger;
  try { _ledger = JSON.parse(fs.readFileSync(ledgerFile(), 'utf-8')) as Ledger; }
  catch { _ledger = {}; }
  return _ledger!;
}
function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 호출 usage 를 월별 원장에 누적하고 이번 호출의 추정 비용($)을 반환. */
export function recordUsage(model: string, inTok: number, outTok: number, cacheReadTok = 0): number {
  const cost = estCostUsd(model, inTok, outTok, cacheReadTok);
  const led = load();
  const k = monthKey();
  const m = led[k] ?? (led[k] = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 });
  m.calls++; m.inputTokens += inTok; m.outputTokens += outTok; m.cacheReadTokens += cacheReadTok; m.costUsd += cost;
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(ledgerFile(), JSON.stringify(led, null, 2), 'utf-8');
  } catch { /* 원장 영속 실패는 무해 */ }
  return cost;
}

export function monthSpendUsd(d = new Date()): number { return load()[monthKey(d)]?.costUsd ?? 0; }
export function monthUsage(d = new Date()): MonthLedger {
  return load()[monthKey(d)] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

/** 무감시 자율 폭주 안전장치 — 월 예산 캡 초과 여부(0 이면 캡 없음). */
export function overBudget(): boolean {
  const cap = CONFIG.monthlyBudgetUsd;
  return cap > 0 && monthSpendUsd() >= cap;
}
