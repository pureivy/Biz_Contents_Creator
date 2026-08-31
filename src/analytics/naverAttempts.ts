/**
 * 네이버 수집 '시도' 기록 — 표본을 못 얻은 시도(발행 초기 집계 지연 등)도 하루 1회 게이트에 포함시키기
 * 위한 별도 저장(data/analytics/naver-attempts.json). 메트릭 jsonl 에 0 표본을 섞으면 학습·표시가
 * 오염되므로 파일을 분리한다. 전량 fail-open — 파일 문제로 수집 루프를 깨지 않는다(게이트만 느슨해짐).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

const file = (): string => path.join(CONFIG.dataDir, 'analytics', 'naver-attempts.json');
const KEEP_MS = 30 * 24 * 3600 * 1000; // 측정창(14일)보다 넉넉히 — 무한 성장 방지

function load(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(file(), 'utf-8')) as Record<string, string>; } catch { return {}; }
}

export function naverAttemptAt(pieceId: string): string | null {
  const v = load()[pieceId];
  return typeof v === 'string' ? v : null;
}

export function markNaverAttempt(pieceId: string, ts: string = new Date().toISOString()): void {
  try {
    const m = load();
    m[pieceId] = ts;
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, v] of Object.entries(m)) { if (!(new Date(v).getTime() >= cutoff)) delete m[k]; }
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(m, null, 2), 'utf-8');
  } catch { /* fail-open — 기록 실패 시 다음 시도가 한 번 더 일어날 뿐 */ }
}
