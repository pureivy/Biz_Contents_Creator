/**
 * 계열 결정적 폴백 매처(2026-08-25 v2 개편) — 쿨다운의 본체는 seriesLedger(LLM 분류 원장+감쇠 점수)로
 * 이관됐고, 이 모듈은 LLM 분류가 없거나 실패했을 때의 결정적 라벨 추출만 남는다(fail-open 의 바닥).
 * 연혁: v1(2026-08-24)은 정규식·사전 집계로 직접 게이트했다 — 포도 4편/6일 → 블루베리(베리 접미) →
 * 전정(행위 축) 순서로 사각을 한 땀씩 메우다, "새 편중마다 코드 수정" 구조 자체를 원장 방식으로 교체.
 */

/** 계열이 아닌 총칭·범주 어간 — 'XX나무' 꼴이지만 특정 수종을 지칭하지 않는 한국어 일반 어휘. */
const GENERIC_STEMS = new Set(['과실', '유실', '조경', '정원', '낙엽', '상록', '침엽', '활엽', '어린', '가로수']);

/** 행위 축 동의어(폴백·매칭 토큰 전개용) — terms[0] 이 표준형(LLM 분류 라벨과 통일). */
export const ACTIVITY_AXES: Array<{ terms: string[] }> = [
  { terms: ['전정', '가지치기', '가지정리', '도장지', '순정리'] }, // '가지' 단독은 "세 가지" 오탐이라 금지
  { terms: ['물주기', '급수', '관수'] },
  { terms: ['월동', '겨울나기', '방한'] },
  { terms: ['식재', '심기', '옮겨심기', '이식', '심는', '심을'] }, // 활용형(리뷰 지적: '심는 시기'가 새어 freeSeeds 로 추천되던 모순)
  { terms: ['병충해', '해충', '방제'] },
  { terms: ['시비', '거름', '밑거름', '웃거름'] },
  { terms: ['고르기', '고르는법', '판별', '선별'] },
  { terms: ['구별', '구분'] },
];

/** 수종 어간 추출(순수, 테스트 대상) — 공백 무시 'XX나무' 어간(총칭 제외) + 'XX베리' 전체어.
 *  단음절 어간(감나무·배나무 등)은 어간 소멸을 막기 위해 전체어를 키로 쓴다(리뷰 확정 메이저) —
 *  seriesLedger.normSpecies 와 같은 키 공간('감나무'). */
export function seriesStems(text: string): string[] {
  const t = (text || '').normalize('NFC').replace(/\s+/g, '');
  const out = new Set<string>();
  for (const m of t.matchAll(/([가-힣]{1,8})나무/g)) {
    const stem = m[1]!;
    if (GENERIC_STEMS.has(stem)) continue;
    out.add(stem.length >= 2 ? stem : m[0]!);
  }
  for (const m of t.matchAll(/[가-힣]{2,6}베리/g)) out.add(m[0]!);
  return [...out];
}

/** 결정적 라벨 폴백(순수, 테스트 대상) — LLM 분류 부재 시 원장 점수 계산이 이걸로 라벨을 만든다.
 *  activity 는 동의어 묶음의 표준형(terms[0])으로 정규화해 LLM 라벨과 같은 키 공간을 쓴다. */
export function fallbackSeriesLabels(text: string): { species: string | null; activity: string | null } {
  const stripped = (text || '').normalize('NFC').replace(/\s+/g, '');
  const axis = ACTIVITY_AXES.find((a) => a.terms.some((term) => stripped.includes(term)));
  return { species: seriesStems(text)[0] ?? null, activity: axis?.terms[0] ?? null };
}
