/**
 * 성과 강화(reinforceFromPerformance) — reflect.ts(자기 산출물 자평)의 사촌. 입력이 '자기 텍스트'가 아니라
 * '실측 성과'다. 이게 사용자가 원한 "노출 기반 강화"의 잃어버린 절반이다.
 *
 * 귀속: 키워드/포맷 1차(strategy EWMA + 위키 성과 페이지), 에이전트 2차·약(memory). — 네이버 트래픽은 수주
 * 지연·교란이라 에이전트 단위로 과적합하면 안 된다(1차=집합 신호, 2차=강성과일 때만 가벼운 신호).
 *
 * 멱등: piece.stage==='measured' 일 때만 강화하고 끝에 'reflected' 로 전이 → 일일 동기화가 두 번 돌아도 no-op.
 * (측정치 append 는 이력이라 증가해도 되지만, EWMA·memory·위키 병합은 중복되면 신호가 오염된다.)
 */
import { pieceStore } from '../content/pieces';
import { updateStrategy } from './strategy';
import { appendMetrics } from './performance';
import type { MetricSample } from './performance';
import { llmWikiFor } from '../wiki/llmwiki';
import { appendMemory, appendActivity } from '../agents/workspace';
import { getCompany } from '../agents/company-loader';

/** 성과 → 단일 스칼라 신호(0~1 근사). 절대 랭킹이 아니라 상대 비교·EWMA 용. views 로그 스케일 + 유입 다양성. */
export function performanceSignal(m: MetricSample): number {
  const viewScore = Math.min(1, Math.log10(Math.max(0, m.views) + 1) / 3); // 약 1000뷰 → 1.0
  const inflowScore = Math.min(1, (m.searchInflow?.length ?? 0) / 10);
  return 0.7 * viewScore + 0.3 * inflowScore;
}

/** content_lead(작가) 등 실재 역할이면 memory 에 가벼운 성과 신호 누적(2차 귀속, 강성과 한정). */
function reinforceWriter(title: string, keyword: string | undefined, signal: number, brand: string | undefined): void {
  try {
    const c = getCompany();
    const valid = new Set([c.ceo, ...c.specialists].map((r) => r.id));
    const writerId = 'content_lead';
    if (!valid.has(writerId)) return;
    appendMemory(writerId, `성과 좋았던 글: "${title}"${keyword ? ` (타겟 "${keyword}")` : ''} — 이 주제·접근이 노출로 이어짐(성과신호 ${signal.toFixed(2)}). 유사 각도 유지.`, brand ?? '');
    appendActivity(writerId, `📈 성과 학습: ${title.slice(0, 40)}`);
  } catch { /* 무해 */ }
}

/**
 * 실측 성과로 강화(멱등). measured 아니면 skip(이미 reflected 포함). 반환: 실제 강화했는지.
 */
export async function reinforceFromPerformance(pieceId: string, metrics: MetricSample): Promise<boolean> {
  const store = pieceStore();
  const piece = store.get(pieceId);
  if (!piece || piece.stage !== 'measured') return false; // 멱등 게이트

  const signal = performanceSignal(metrics);
  // 1차 — 키워드/서브니치 EWMA(+measuredPieces 정확히 1회 증가: 이 함수는 piece 당 measured→reflected 로 1회만 통과).
  updateStrategy({ keyword: piece.keyword, subNiche: piece.subNiche, signal, incMeasured: true, brand: piece.brand });

  // 위키 'performance' 페이지 — 근거 URL 포함([근거: URL], Self-RAG 승격과 동형). 다음 기획이 참조(query 우대).
  try {
    const topKw = (metrics.searchInflow ?? []).slice(0, 5)
      .map((k) => `- ${k.keyword} (${k.count}${k.rank ? `, ${k.rank}위` : ''})`).join('\n');
    const w = llmWikiFor(piece.brand);
    w.upsertPage({
      title: `성과: ${piece.title}`, type: 'performance',
      body:
        `조회 ${metrics.views}회${metrics.dwellSec ? ` · 체류 ${metrics.dwellSec}s` : ''} · 성과신호 ${signal.toFixed(2)}\n` +
        `타겟 키워드: ${piece.keyword ?? '-'} · 서브니치: ${piece.subNiche ?? '-'}\n` +
        `유입 키워드:\n${topKw || '- (없음)'}\n` +
        (piece.publishedUrl ? `\n[근거: ${piece.publishedUrl}]` : '') +
        w.relatedLine([piece.keyword], [`${piece.title} (요약)`]),
      summary: `${piece.title} 성과신호 ${signal.toFixed(2)} (조회 ${metrics.views})`,
      sources: [piece.publishedUrl ? `perf:${piece.publishedUrl}` : 'perf:manual'],
      aliases: piece.keyword ? [piece.keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }

  // 2차(약) — 강성과일 때만 작가에게 가벼운 신호(에이전트 과적합 회피).
  if (signal >= 0.6) reinforceWriter(piece.title, piece.keyword, signal, piece.brand);

  store.setStage(pieceId, 'reflected'); // 멱등 전이 — 이후 재호출은 measured 아니라 skip.
  return true;
}

/**
 * 성과 측정치 수집의 멱등 진입점 — 수동 엔드포인트·일일 스크레이프가 공유.
 * append(이력) → published 면 measured 전이 → reinforce(measured→reflected). 두 번 불러도 강화는 1회.
 */
export async function ingestMetrics(pieceId: string, sample: MetricSample): Promise<{ recorded: boolean; reinforced: boolean }> {
  const store = pieceStore();
  const piece = store.get(pieceId);
  if (!piece) return { recorded: false, reinforced: false };
  appendMetrics(pieceId, sample);                                  // 항상 이력 기록(append-only)
  if (piece.stage === 'published') store.setStage(pieceId, 'measured'); // 최초 측정만 전이(reflected 면 이력만 쌓음)
  const reinforced = await reinforceFromPerformance(pieceId, sample);
  return { recorded: true, reinforced };
}
