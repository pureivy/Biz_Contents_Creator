/**
 * 클러스터 채굴 — 대표 편 초안 확정(advancePieceReady) 시 연관 검색어(자동완성) 형제들을 판정해
 * 백로그(topicCluster)에 적재한다. 흐름: 자동완성 배열 → 코드 게이트(filterCandidates) → micro 판정
 * (각도·가제) → clusterStore.createMany. 전량 fail-open — 채굴 실패가 ready 승격을 막지 않는다.
 *
 * 코드 게이트가 '시드 편을 제외하고' 기존 콘텐츠와 대조하는 이유(실측 2026-08-03, 41건):
 * 형제 후보는 정의상 시드 키워드를 포함해 시드 편과는 전부 유사 판정이 난다 — 시드를 빼고도 걸리면
 * 진짜 중복("추희자두 묘목"은 기발행 글이 있었다), 안 걸리면 계획된 갈래다.
 */
import { naverAutocomplete } from '../grounding/naver_autocomplete';
import { seedKeyword } from '../grounding/naver_common';
import { microJSON } from './agent';
import { resolveAssignment } from '../llm/setting';
import { findSimilarContent, collectExistingContent } from '../content/novelty';
import type { ExistingContent } from '../content/novelty';
import { offBrandTerm, brandContext } from '../content/brand';
import { clusterStore } from '../content/topicCluster';
import { pieceStore } from '../content/pieces';
import { asString } from '../util/str';

const normKw = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase();

/**
 * 순수 코드 게이트 — LLM 이전에 확실히 걸러지는 것들: 브랜드 밖 / 시드 표기 동치 / 기존 글과 중복.
 *
 * 대조 이원화(실측 2026-08-06 배롱나무 스모크): 시드 키워드를 keyword 로 쓰는 콘텐츠 가족(시드 편·파생
 * 카드뉴스·동일 키워드 글)과는 단순 포함 규칙이 항상 참(배롱나무 ⊂ 배롱나무꽃)이라 전 후보가 기각됐다.
 * 가족과는 후보의 '차별화 부분'(시드를 뺀 나머지, 2자 이상)이 제목에 들어 있을 때만 중복으로 보고,
 * 가족 밖 콘텐츠와는 종전 findSimilarContent 전체 규칙으로 대조한다.
 */
export function filterCandidates(
  candidates: string[], seedKw: string, seedTitle: string,
  existing: ExistingContent[],
): { pass: string[]; rejected: Array<{ kw: string; why: string }> } {
  const pass: string[] = [];
  const rejected: Array<{ kw: string; why: string }> = [];
  const seedNorm = normKw(seedKw);
  const family = existing.filter((e) => e.title === seedTitle || normKw(e.keyword ?? '') === seedNorm);
  const others = existing.filter((e) => !family.includes(e));
  for (const kw of candidates) {
    const off = offBrandTerm(kw);
    if (off) { rejected.push({ kw, why: `브랜드 밖 소재 "${off}"` }); continue; }
    if (normKw(kw) === normKw(seedNorm)) { rejected.push({ kw, why: '시드 표기 동치' }); continue; }
    // 가족 대조 — 차별화 부분("배롱나무 심기"→"심기")이 가족 글 제목에 이미 있으면 그 각도는 이미 다뤘다.
    const diff = normKw(kw).replace(seedNorm, '');
    const famHit = diff.length >= 2 ? family.find((e) => normKw(e.title).includes(diff)) : undefined;
    if (famHit) { rejected.push({ kw, why: `기존과 중복: "${famHit.title.slice(0, 30)}"` }); continue; }
    const sim = findSimilarContent({ title: kw, keyword: kw }, others);
    if (sim.length) { rejected.push({ kw, why: `기존과 중복: "${sim[0]!.title.slice(0, 30)}"` }); continue; }
    pass.push(kw);
  }
  return { pass, rejected };
}

/**
 * 대표 편 ready 승격 훅에서 호출(fire-and-forget) — 채굴 전체. 반환 = 등록 건수(로그용).
 * 형제 소진으로 태어난 piece(clusterSeedId 보유)는 재채굴하지 않는다 — 클러스터의 클러스터 방지.
 */
export async function mineClusterForPiece(pieceId: string): Promise<number> {
  try {
    const piece = pieceStore().get(pieceId);
    if (!piece || piece.clusterSeedId) return 0;
    const seed = (piece.keyword || seedKeyword(piece.title)).trim();
    if (!seed) return 0;
    const related = await naverAutocomplete(seed);
    if (!related.length) return 0;
    const existing = collectExistingContent(piece.brand || undefined);
    const { pass, rejected } = filterCandidates(related, seed, piece.title, existing);
    for (const r of rejected) console.log(`[cluster] 형제 기각 — "${r.kw}" (${r.why})`);
    if (!pass.length) return 0;
    // micro 판정 1회 — 검색 의도(angle)와 가제(title). 브랜드 컨텍스트로 소재 적합성 재확인.
    const judged = await microJSON<{ siblings?: Array<{ keyword?: unknown; title?: unknown; angle?: unknown; ok?: unknown }> }>(
      resolveAssignment().micro,
      '너는 콘텐츠 기획자다. 시드 주제로 이미 글 1편을 썼다. 아래 연관 검색어 각각에 대해, 시드 편과 "다른 이야기"가 되는 독립 글감인지 판정하라. ' +
      '다른 이야기가 되면 ok:true 와 함께 검색 의도(angle) 한 줄·클릭에 유리한 가제(title)를 제안하고, 시드 편과 같은 이야기의 표기 변형이면 ok:false.',
      `${brandContext() ? `${brandContext()}\n\n` : ''}[시드 편] ${piece.title} (키워드: ${seed})\n\n[연관 검색어]\n${pass.map((k) => `- ${k}`).join('\n')}\n\n형식: {"siblings":[{"keyword":"...","ok":true,"title":"...","angle":"..."}]}`,
      { maxOutputTokens: 700 },
    ).catch(() => null);
    const siblings = (judged?.siblings ?? [])
      .filter((s) => s?.ok !== false)
      .map((s) => ({
        keyword: asString(s?.keyword).trim(),
        title: asString(s?.title).trim() || `${asString(s?.keyword).trim()} 이야기`,
        angle: asString(s?.angle).trim() || undefined,
      }))
      // LLM 이 목록 밖 키워드를 지어내면 버린다 — 게이트를 통과한 실제 자동완성 검색어만 백로그에.
      .filter((s) => s.keyword && pass.some((k) => normKw(k) === normKw(s.keyword)));
    if (!siblings.length) return 0;
    const created = clusterStore().createMany({ brand: piece.brand ?? null, seedKeyword: seed, seedPieceId: piece.id, siblings });
    if (created.length) console.log(`[cluster] 채굴 — 시드 "${seed}" 형제 ${created.length}건 백로그 등록`);
    return created.length;
  } catch (e) {
    console.log(`[cluster] 채굴 실패(무해): ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}
