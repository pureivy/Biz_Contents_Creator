/**
 * 신뢰할 수 없는 값(특히 LLM JSON 출력)을 문자열로 안전 변환 — 문자열이 아니면 ''(빈 문자열).
 * LLM 이 {task, team, member, insight, goal} 등을 숫자·객체·배열로 반환해도 .trim()/.slice() 가
 * 크래시하지 않게 한다(리뷰 발견: `(a?.team ?? '').trim()` 이 a.team 이 비문자열이면 ?? 가 안 먹어 throw).
 */
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
