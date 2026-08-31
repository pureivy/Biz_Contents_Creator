/**
 * 네이버 SEO 커넥터 공용 유틸 — 시드 키워드 추출·숫자 파싱·태그 제거.
 * 각 커넥터(naver_search/searchad/datalab/autocomplete)와 discover 파이프라인이 공유.
 */

/**
 * 블로그 글감/지시문(문장)에서 검색 API 용 핵심 키워드 근사 추출.
 * 실사고: 지명 런 topic("여름 제습기 추천 키워드의 검색량과 트렌드를 조사하라")이 통째로
 * 시드가 되어 검색광고는 무의미 데이터(월 20회), 데이터랩은 0포인트 — "커넥터가 안 되는
 * 것처럼" 보였다. 절 경계 컷 → 지시어미·조사 꼬리 제거 → 앞 3어절 캡으로 교정.
 */
export function seedKeyword(query: string): string {
  const first = (query.split('\n')[0] ?? query).trim();
  // ① 절 경계 컷 — 콤마·대시·콜론·괄호·물음표 뒤는 부연/지시부일 확률이 높다
  //    ("장마철 실내 제습, 제습기 없이 습도 낮추는 5가지" → 앞절만).
  const head = (first.split(/[,:：—(（?!]|\s-\s/)[0] ?? first).trim();
  // ② 꼬리 정리 — 명령/서술 어미 토큰("…조사하라")과 조사로 끝나는 연결 토큰("키워드의"·"트렌드를")을
  //    뒤에서부터 제거해 핵심 명사구만 남긴다. 과도 절단 방지: 어미는 1토큰까지, 조사는 2토큰까지 유지.
  const verbal = /(하라|해라|하세요|해\s?줘|한다|합니다|하기|해보기|해보자|할까|일까)[.?!]?$/;
  const josa = /(을|를|이|가|은|는|의|에|로|와|과|도|만)$/;
  const tokens = head.split(/\s+/).filter(Boolean);
  let end = tokens.length;
  while (end > 1 && (verbal.test(tokens[end - 1]!) || (end > 2 && tokens[end - 1]!.length > 1 && josa.test(tokens[end - 1]!)))) end--;
  // ③ 검색 키워드는 통상 1~3어절 — 앞 3어절 캡 후 하우투/트렌드 접미 제거.
  const core = tokens.slice(0, Math.min(end, 3)).join(' ');
  const stripped = core
    .replace(/\s*(하는\s*법|하는법|방법|팁|정리|총정리|추천|비교|후기|가격|순위|리뷰)\s*$/g, '')
    .trim();
  return (stripped || core || first).slice(0, 30).trim();
}

/** "1,234" · "< 10" · number → 정수(비숫자 제거). SearchAd 저조검색 "< 10" 은 ~10 으로 근사. */
export function toInt(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').replace(/[^\d]/g, '');
  return s ? parseInt(s, 10) : 0;
}

/** HTML 태그·엔티티 제거(네이버 검색 결과 title 은 <b> 강조 포함). */
export function stripTags(s: string): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 커넥터 ground() 주입 텍스트 상한(프리필 비용 억제). config 노브가 없으면 800. */
export const GROUND_CAP = 800;
