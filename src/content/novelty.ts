/**
 * 콘텐츠 신규성 가드(사용자 원칙 2026-07-15) — 신규 블로그·쇼츠·카드뉴스 기획은 기존 콘텐츠와
 * 주제(제목)·키워드가 유사하면 지양한다. 판정은 한글 복합어에 강한 '문자 바이그램 자카드'(공백·
 * 표기 변형에 관대) — 임베딩 없이 결정적·즉시 계산. 파생 생성(글→쇼츠·카드뉴스, sourcePieceId)은
 * 같은 주제의 채널 전개가 설계 의도라 가드 대상이 아니다.
 */
import { pieceStore } from './pieces';
import { shortsStore } from './shorts';
import { cardNewsStore } from './cardnews';

export interface ExistingContent { title: string; keyword?: string; kind: '블로그' | '쇼츠' | '카드뉴스' }
export interface SimilarMatch { title: string; kind: string; score: number; via: 'keyword' | 'title' }

/** NFC·소문자·문자/숫자 외 제거(공백 포함) — 표기 변형을 흡수한 압축 문자열. */
function compact(s: string): string {
  return (s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length <= 1) { if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
export function bigramJaccard(a: string, b: string): number {
  const A = bigrams(compact(a)), B = bigrams(compact(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// 임계값 — 실데이터로 보정: '7월에 심는 꽃 5가지…' vs '칠월에…' ≈ 0.55(유사), 무관 주제 < 0.2.
// 키워드는 짧아 포함·동치가 흔한 재탕 패턴('장마철 제습' ⊂ '장마철 제습기')이라 별도 규칙.
const KW_JACCARD = 0.6;
const TITLE_JACCARD = 0.45;
const KW_CONTAIN_MIN = 4; // 4자 미만 포함('꽃' ⊂ '꽃나무')은 우연 — 무시

export function keywordSimilar(a: string, b: string): boolean {
  const na = compact(a), nb = compact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= KW_CONTAIN_MIN && longer.includes(shorter)) return true;
  return bigramJaccard(a, b) >= KW_JACCARD;
}
/** 콘텐츠 제목의 범용 꼬리 토큰 — 하우투·리스트형 제목 어디에나 붙어 변별력이 없다.
 *  이걸 세면 '여름 장미 관리 방법 총정리' vs '겨울 동백 관리 방법 총정리'처럼 무관 주제가
 *  '관리·방법·총정리' 3겹침으로 오탐된다(2026-07-15 리뷰 실재현) — 핵심 토큰 산정에서 제외. */
export const STOP_TOKENS = new Set([
  '방법', '총정리', '정리', '요령', '추천', '방지', '시기', '준비물', '꿀팁', '가이드',
  '체크리스트', '비교', '후기', '리뷰', '관리', '노하우', '하는법', '초보자', '완벽', '실전',
  // 순수 filler(테마 아님) — 제목에 흔하나 변별력 없어 유사·포화 신호를 오염(2026-07-23 감사).
  '지금', '이유', '완전', '이것',
]);
/** 2자 이상·비범용 토큰 집합 — 공백·구두점 분리, NFC·소문자. */
function tokens(s: string): string[] {
  return (s || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
}
/** 두 제목의 핵심 토큰 겹침 수 — 동치 또는 포함('제습' ⊂ '제습기')을 1로 센다(후보 토큰당 최대 1).
 *  stems 를 주면 합성어 어간까지 비교에 넣는다 — '감나무묘목'과 '신비복숭아묘목'은 서로를 포함하지 않아
 *  종전엔 남남이었고, 그래서 예고 포화 게이트가 같은 축을 통과시켰다(실측 2026-08-01). */
function sharedTokenCount(a: string, b: string, stems: string[] = []): number {
  const bt = [...expandTokens(b, stems)];
  let n = 0;
  for (const t of expandTokens(a, stems)) {
    if (bt.some((u) => t === u || t.includes(u) || u.includes(t))) n++;
  }
  return n;
}
const TITLE_SHARED_TOKENS = 3; // '장마철·실내·제습' 처럼 핵심어 3개 겹치면 문구가 달라도 같은 주제
export function titleSimilar(a: string, b: string): boolean {
  return bigramJaccard(a, b) >= TITLE_JACCARD || sharedTokenCount(a, b) >= TITLE_SHARED_TOKENS;
}

/** 후보(제목·키워드)를 기존 콘텐츠와 대조 — 유사 근거를 점수 내림차순으로 반환(빈 배열 = 신규). */
export function findSimilarContent(
  cand: { title: string; keyword?: string },
  existing: ExistingContent[],
): SimilarMatch[] {
  const out: SimilarMatch[] = [];
  for (const e of existing) {
    if (cand.keyword && e.keyword && keywordSimilar(cand.keyword, e.keyword)) {
      out.push({ title: e.title, kind: e.kind, score: bigramJaccard(cand.keyword, e.keyword), via: 'keyword' });
      continue;
    }
    if (titleSimilar(cand.title, e.title)) {
      out.push({ title: e.title, kind: e.kind, score: bigramJaccard(cand.title, e.title), via: 'title' });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * 개념 포화(테마 쏠림) 감지 — 표면 문자열(bigram)론 안 겹쳐도 '핵심 내용어'가 겹치면 같은 소재로 본다.
 * '폭염 나무 물주기' ↔ '여름화분물주기' ↔ '장마철 물빼기'처럼 글자는 달라도 소재가 쏠린 경우를 잡는다
 * (bigramJaccard 는 이들을 0.35 미만으로 흘려보낸다 — 실측). tokens() 는 범용 꼬리말(방법·가이드·관리…)을
 * STOP_TOKENS 로 제외하므로 남는 건 변별력 있는 내용어(물주기·여름·품종·과습…)다.
 */
/** 후보가 기존 콘텐츠와 핵심 내용어를 minShared개 이상 공유하는 것들(공유 수 내림차순). 빈 배열 = 소재 신선. */
export function saturatedThemeMatches(
  cand: { title: string; keyword?: string },
  existing: ExistingContent[],
  minShared = 2,
  stems: string[] = [],
): SimilarMatch[] {
  const a = `${cand.title} ${cand.keyword ?? ''}`;
  return existing
    .map((e) => ({ e, shared: sharedTokenCount(a, `${e.title} ${e.keyword ?? ''}`, stems) }))
    .filter((x) => x.shared >= minShared)
    .sort((x, y) => y.shared - x.shared)
    .map((x) => ({ title: x.e.title, kind: x.e.kind, score: x.shared, via: 'title' as const }));
}
/** 토큰 + 그 안에 든 도메인 어간(순수). stems=['묘목','나무'] 이면 '감나무묘목' → {감나무묘목, 묘목, 나무}.
 *  tokens() 는 공백으로만 자르므로 '감나무묘목'·'신비복숭아묘목'·'정원수묘목' 이 각각 1회로 흩어져
 *  정작 수렴한 축('묘목')이 포화 탐지에 안 보였다(실측 2026-08-01). 형태소 분석기 없이 보완하는 최소 장치.
 *  **어간 목록은 업종어라 브랜드 설정(brand.compoundStems)에서 온다** — 미설정 브랜드는 확장 없음(종전 동작). */
export function expandTokens(s: string, stems: string[] = []): Set<string> {
  const out = new Set(tokens(s));
  if (!stems.length) return out;
  for (const t of [...out]) {
    for (const stem of stems) if (stem && t.length > stem.length && t.includes(stem)) out.add(stem);
  }
  return out;
}

/** 코퍼스에서 minPieces편 이상에 등장하는 핵심 내용어 = '이미 포화된 소재'. 아이디어 생성이 피하도록 프롬프트에 주입. */
export function saturatedThemes(existing: ExistingContent[], minPieces = 3, stems: string[] = []): Array<{ token: string; count: number }> {
  const freq = new Map<string, number>();
  for (const e of existing) {
    for (const t of expandTokens(`${e.title} ${e.keyword ?? ''}`, stems)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()].filter(([, c]) => c >= minPieces).sort((x, y) => y[1] - x[1]).map(([token, count]) => ({ token, count }));
}

/**
 * 브랜드의 기존 콘텐츠 수집(제목+키워드) — 글·쇼츠·카드뉴스 최신순 limit 건.
 * 브랜드 격리: (brand ?? '') 정확 일치만(폴백 없음 — 타 브랜드 콘텐츠는 비교 대상 아님).
 */
export function collectExistingContent(brand: string | undefined, limit = 60): ExistingContent[] {
  const slug = brand ?? '';
  const match = (b: string | undefined): boolean => (b ?? '') === slug;
  // 파생물은 원본과 한 덩어리로 센다 — 블로그 1편이 쇼츠·카드뉴스로 파생되면 같은 주제가 3표가 되어
  // 자기 혼자 '포화'(minPieces=3)를 만들고, 회피 목록이 1회성 주제어로 채워져 진짜 반복 축을 밀어냈다
  // (실측 2026-08-01: 60건 중 18개 키워드가 3채널 중복). 그룹 대표는 최신 1건.
  const rows: Array<ExistingContent & { ts: string; group: string }> = [];
  for (const p of pieceStore().list()) {
    if (match(p.brand)) rows.push({ title: p.title, keyword: p.keyword, kind: '블로그', ts: p.updatedTs, group: p.id });
  }
  for (const s of shortsStore().list()) {
    if (match(s.brand)) rows.push({ title: s.title || s.topic, keyword: s.keyword, kind: '쇼츠', ts: s.updatedTs, group: s.sourcePieceId ?? s.id });
  }
  for (const x of cardNewsStore().list()) {
    if (match(x.brand)) rows.push({ title: x.topic, keyword: x.keyword, kind: '카드뉴스', ts: x.updatedTs, group: x.sourcePieceId ?? x.id });
  }
  const seen = new Set<string>();
  return rows.sort((a, b) => b.ts.localeCompare(a.ts))
    .filter((r) => !seen.has(r.group) && (seen.add(r.group), true))
    .slice(0, limit)
    .map(({ ts: _ts, group: _g, ...e }) => e);
}
