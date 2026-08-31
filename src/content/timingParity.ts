/**
 * 파생 콘텐츠 시기·수치 원문 대조(2026-08-27 말투 감사 권고 1) — 결정적(LLM 없음).
 *
 * 실사고(활엽수 편): 블로그는 "적기는 보통 봄… 가을이 낫다고 말할 근거는 확실치 않습니다"인데,
 * 같은 소재 쇼츠가 내레이션("지금이 심기 좋은 때")·자막("낙엽나무는 지금 적기")·화면 수치
 * 오버레이("8월 · 낙엽수 식재 시작") 세 군데에서 8월을 적기로 단정했다. 세 채널을 다 보는 단골에게
 * 가장 먼저 들키는 어긋남이고, 사실 기반 원칙(2026-08-26 사용자 확정)에 직결된다.
 *
 * **다만 이 모듈은 바로 그 사고를 못 잡는다**(Fix round 1, 실데이터 대조로 확인). 원문 본문에도 "8월 말에
 * 할 일은…"이 있어 값은 같고 주장만 뒤집혔기 때문이다(data/sessions/370d4a20682a ↔ data/shorts/short_4c0b420c51).
 * 여기는 "원문에 없는 값"만 본다 — 주장 뒤집힘 절반은 구조적으로 LLM 정합 축(parityIssues)의 몫이고,
 * 그 조각에서는 그쪽도 침묵했다(레코드 factGate: null). 권고 1 은 아직 열려 있다(task-1-report.md 의 Fix round).
 * 이 축이 실측으로 실제 잡은 것: 원문에 없는 오버레이 수치(3일·3번·10일)와 카드 본문의 2년 — 180쌍 중 4건.
 *
 * 성격: LLM 정합 검사(standaloneQa.parityIssues)와 **별개 축**이다. LLM 쪽은 프롬프트에서 반올림·
 * 범위 의역을 명시적으로 인정하지만, 여기는 "원문에 없는 시기·수치는 파생물에 새로 못 만든다"만 본다.
 * 그래서 이쪽이 더 엄격하고, 그만큼 fail-open·비차단(발행을 막지 않는다)으로만 쓴다 —
 * 검출은 기존 정합 수정 라운드에 문자열로 합류하고, 잔존은 텔레그램 표시로 끝난다.
 * 예외적으로 쇼츠 stat 오버레이만 결정적으로 제거한다(화면에 큼직하게 박히는 숫자라 수정 라운드를 못 믿는다).
 *
 * 킬스위치: TIMING_PARITY=off — 검출과 오버레이 제거를 함께 끈다.
 */
import { CONFIG } from '../config';
import type { SceneKindFields } from '../tools/shortsCommon';

export interface TimingIssue { field: string; token: string; text: string }

/** 고유어 월 → 숫자월. 긴 것부터 대조해야 '십이월'이 '이월'로 잘리지 않는다. */
const NATIVE_MONTHS: ReadonlyArray<readonly [string, number]> = [
  ['십이월', 12], ['십일월', 11], ['시월', 10], ['십월', 10], ['정월', 1], ['일월', 1],
  ['이월', 2], ['삼월', 3], ['사월', 4], ['오월', 5], ['유월', 6], ['육월', 6],
  ['칠월', 7], ['팔월', 8], ['구월', 9],
];
/**
 * 낱말 경계(Fix round 1, 2026-08-27) — 앞이 한글이 아니고, 뒤가 조사·시간명사이거나 비한글이거나 문자열 끝일
 * 때만 월 이름으로 본다. 경계가 없어 "이월된 묘목"이 "2월된 묘목"으로 바뀌던 결함(계획서 Task 4 가 같은
 * 사고를 명시적으로 막는 규칙과 같은 형태: 뒤가 `에|부터|까지|중|말|초|은|는|이|의|,|\s|$`).
 * 조사 목록은 계획서 예시가 아니라 **실코퍼스 실측**으로 정했다(원문 209편 + 파생 252편에서 고유어 월 뒤에
 * 실제로 붙는 한글: 에·엔·은·이·의·과·부터·까지·입니다·인데·중·말·초). '엔'을 빼면 "팔월엔"이 통째로
 * 안 잡혀 파생 쪽 8월이 사라진다 — 실측으로 확인한 회귀라 목록에 넣었다.
 * 앞 경계(앞이 한글이면 제외)의 대가: "팔구월엔"처럼 붙여 쓴 겹월은 이제 하나도 안 잡힌다. 종전에는 뒤의
 * '구월'만 잡혀(→9월) 원문 "팔구월" ↔ 파생 "8월"이 가짜 불일치가 됐으니, 양쪽 다 안 잡는 지금이 더 대칭이다.
 * 뒤 조건에 비한글([^가-힣])을 남긴 것은 의도다 — 추출은 원문·파생 **양쪽**에 같은 함수를 먹이므로 원문 쪽
 * 인식을 좁히면 없던 불일치를 만든다(원문 "시월." 미인식 + 파생 "시월에" 인식 = 가짜 지적).
 */
const NATIVE_MONTH_RE = new RegExp(
  `(?<![가-힣])(?:${NATIVE_MONTHS.map(([w]) => w).join('|')})(?=[은는이의에엔과와도만중말초인입부까]|[^가-힣]|$)`, 'g',
);

/** 24절기 — 계절+시점("늦가을")은 너무 일반이라 제외하고, 이름이 특정된 절기만 본다. */
const SOLAR_TERMS = [
  '입춘', '우수', '경칩', '춘분', '청명', '곡우', '입하', '소만', '망종', '하지', '소서', '대서',
  '입추', '처서', '백로', '추분', '한로', '상강', '입동', '소설', '대설', '동지', '소한', '대한',
] as const;
/**
 * 앞이 한글이면 낱말 조각(필요"하지" 않다)이라 제외한다. 뒤는 ⓐ 붙어 오는 조사 ⓑ 공백을 사이에 둘 수 있는
 * 시간 문맥어 ⓒ 비한글·비공백(문장부호·숫자 = 구절 끝) ⓓ 문자열 끝만 인정한다.
 *
 * Fix round 1(2026-08-27): 종전 조건은 "뒤가 아무 비한글"이라 **맨 공백**만으로도 절기가 됐다
 * ("묘목 입하 소식"→입하, "우수 개체를 고르세요"→우수). 공백 뒤에는 시간 문맥어를 요구해 그 겹을 닫았다.
 * 문장부호까지 함께 막지 않은 것은 의도다 — 추출은 원문·파생 양쪽에 같은 함수를 먹이므로, 원문 쪽 인식만
 * 좁히면(원문 "절기상 처서." 미인식 + 파생 "처서 무렵" 인식) 없던 불일치를 새로 만들어 낸다.
 * 남는 겹: "소설을 읽듯"처럼 조사 '을/를'이 붙은 동음 명사는 여전히 절기로 읽힌다 — 조사를 빼면
 * "동지를 지나면"·"입추를 앞두고" 같은 진짜 용례가 죽어서, 가름하려면 뒤 서술어까지 봐야 한다(요구 범위 밖).
 */
const PARTICLE_TAIL = '가이은는을를에의도와과로으랑';
/**
 * 공백을 사이에 둬도 절기로 인정하는 시간 문맥어(처서 무렵·즈음·께·쯤·경 …). 붙여 쓴 "처서부터"도 같은 가지다.
 * 목록은 실코퍼스 실측(원문 209편 + 파생 252편)에서 절기 뒤에 실제로 온 말로 채웠다 — '뒤'(추분 뒤·처서 뒤)와
 * '직후'(입추 직후), '지났'(입추 지났다)이 빠지면 실제 파생물의 절기가 사라져 원문 대조가 비대칭이 된다.
 */
const TIME_TAIL = [
  '무렵', '즈음', '께', '쯤', '경', '전후', '직전', '직후', '이전', '이후', '전', '후', '뒤', '앞',
  '부터', '까지', '때', '다음', '지나', '지난', '지날', '지남', '지났', '넘어', '넘으', '들어',
].join('|');
const SOLAR_RE = new RegExp(
  `(?<![가-힣])(${SOLAR_TERMS.join('|')})(?=[${PARTICLE_TAIL}]|\\s*(?:${TIME_TAIL})|[^가-힣\\s]|$)`, 'g',
);
/**
 * 절기 형태와 겹치는 상용구 — 정규식 경계만으로 못 막는 두 건(실제 원예 문장에서 흔하다).
 * Fix round 1 이후 '하지' 가지는 겹겹 방어다(좁힌 lookahead 가 "하지 마세요"를 먼저 막는다). '대한' 가지는
 * 여전히 산다 — "묘목에 대한 이후 관리"처럼 뒤에 시간 문맥어가 오면 lookahead 를 통과해 여기로 온다.
 */
function solarTermIsFalsePositive(term: string, before: string, after: string): boolean {
  if (term === '하지' && /^\s*(?:마|말|않|못|맙)/.test(after)) return true; // "하지 마세요"·"하지 않습니다"
  if (term === '대한' && /에\s*$/.test(before)) return true;               // "묘목에 대한"
  return false;
}

/** 숫자+단위 — 긴 단위를 먼저 둬야 '2주일'이 '2주'로, '50ml'이 '50m'로 잘리지 않는다. */
const UNITS = ['주일', '개월', '리터', 'cm', 'kg', 'ml', 'm', 'g', '일', '주', '년', '회', '번', '배', '도', '℃', '원', '%'] as const;
const UNIT_ALT = UNITS.join('|');
const NUM = String.raw`\d+(?:[.,]\d+)?`;
/**
 * 토큰 안의 공백 — 줄바꿈은 넘지 않는다(Fix round 1). `\s*` 면 줄 끝 숫자와 다음 줄 첫 글자가 한 토큰이 된다:
 * 실측 FP(data/cardnews/card_8cf712884c) "적정 pH는 4.5~5.5\n일반 흙은 …" → "5.5일".
 */
const SP = String.raw`[^\S\r\n]*`;
const UNIT_RE = new RegExp(`(${NUM})${SP}(${UNIT_ALT})`, 'g');
/** 범위 표기("20~30cm") — 원문에만 적용해 그 사이 값을 통과시킨다. */
const RANGE_RE = new RegExp(`(${NUM})${SP}[~\\-–—−]${SP}(${NUM})${SP}(${UNIT_ALT})`, 'g');
const MONTH_RE = new RegExp(`(\\d{1,2})${SP}월`, 'g');
const MONTH_RANGE_RE = new RegExp(`(\\d{1,2})${SP}[~\\-–—−]${SP}(\\d{1,2})${SP}월`, 'g');
/** 시각 — '3시간'은 기간이지 시각이 아니라서 뺀다. */
const CLOCK_RE = new RegExp(`(\\d{1,2})${SP}시(?![간])`, 'g');

const num = (s: string): number => Number(s.replace(/,/g, ''));
/** 표시용 숫자 정규화 — 남은 쉼표를 흡수한다(천 단위는 normalizeForMatch 가 매치 전에 이미 지웠다). */
const normNum = (s: string): string => s.replace(/,/g, '');
const normUnit = (u: string): string => (u === '℃' ? '도' : u);

/**
 * 천 단위 구분 쉼표 — 매치 **전에** 지운다(Fix round 1). 캡처 안에서만 지우면 `\d+(?:[.,]\d+)?` 가
 * "1,200,000원"의 앞 자리를 못 삼켜 "200000원"으로 잘린다(뒤에서부터 맞는 조각만 남는다).
 */
const THOUSANDS_RE = /(\d),(?=\d{3}(?:\D|$))/g;
/**
 * 원문·파생에 **같은** 정규화를 먹인다 — 한쪽만 바꾸면 없던 불일치가 생긴다.
 * 천 단위 쉼표 제거 + 고유어 월 → 숫자월(그러면 아래 월 정규식 하나로 둘 다 잡힌다).
 */
function normalizeForMatch(s: string): string {
  return s.replace(THOUSANDS_RE, '$1')
    .replace(NATIVE_MONTH_RE, (w) => `${NATIVE_MONTHS.find(([k]) => k === w)![1]}월`);
}

/**
 * 시기·수치 토큰 결정적 추출(순수). 정규화: 공백 제거, ℃→도, 고유어 월→숫자월, 천 단위 쉼표 제거.
 * 중복은 접어 첫 등장 순서로 돌려준다.
 */
export function extractTimingNumbers(text: string): string[] {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const t = normalizeForMatch(s);
  const out: string[] = [];
  const push = (tok: string): void => { if (tok && !out.includes(tok)) out.push(tok); };

  for (const m of t.matchAll(MONTH_RE)) push(`${num(m[1]!)}월`);
  for (const m of t.matchAll(CLOCK_RE)) push(`${num(m[1]!)}시`);
  for (const m of t.matchAll(UNIT_RE)) push(`${normNum(m[1]!)}${normUnit(m[2]!)}`);
  for (const m of t.matchAll(SOLAR_RE)) {
    const term = m[1]!;
    const at = m.index ?? 0;
    if (solarTermIsFalsePositive(term, t.slice(0, at), t.slice(at + term.length))) continue;
    push(term);
  }
  return out;
}

interface SourceIndex {
  tokens: Set<string>;
  months: Set<number>;
  /** 단위별 범위 — 원문 "20~30cm" 안의 값은 통과시킨다(반올림은 통과시키지 않는다). */
  ranges: Array<{ unit: string; lo: number; hi: number }>;
}

function indexSource(sourceBody: string): SourceIndex {
  const s = String(sourceBody ?? '');
  const tokens = new Set(extractTimingNumbers(s));
  const months = new Set<number>();
  for (const tok of tokens) { const m = /^(\d+)월$/.exec(tok); if (m) months.add(Number(m[1])); }
  const t = normalizeForMatch(s);
  for (const m of t.matchAll(MONTH_RANGE_RE)) {
    const lo = num(m[1]!); const hi = num(m[2]!);
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) months.add(i);
  }
  const ranges: SourceIndex['ranges'] = [];
  for (const m of t.matchAll(RANGE_RE)) {
    const lo = num(m[1]!); const hi = num(m[2]!);
    ranges.push({ unit: normUnit(m[3]!), lo: Math.min(lo, hi), hi: Math.max(lo, hi) });
  }
  return { tokens, months, ranges };
}

const UNIT_TOKEN_RE = new RegExp(`^(${NUM})(${UNIT_ALT})$`);

function tokenInSource(token: string, idx: SourceIndex): boolean {
  if (idx.tokens.has(token)) return true;
  const mo = /^(\d+)월$/.exec(token);
  if (mo) return idx.months.has(Number(mo[1])); // 9월 ↔ "9월 중순" — 같은 월이면 통과
  const un = UNIT_TOKEN_RE.exec(token);
  if (un) {
    const v = num(un[1]!); const u = un[2]!;
    return idx.ranges.some((r) => r.unit === u && v >= r.lo && v <= r.hi);
  }
  return false;
}

/**
 * 파생 텍스트에만 있는 시기·수치를 보고한다(순수, 원문이 비면 검사 안 함 — 파생물이 아니라는 뜻).
 * 같은 field 안의 같은 토큰은 한 번만 보고한다.
 */
export function timingParityIssues(
  sourceBody: string, derived: Array<{ field: string; text: string }>,
): TimingIssue[] {
  if (!CONFIG.timingParity) return [];
  const src = String(sourceBody ?? '');
  if (!src.trim() || !derived?.length) return [];
  // 원문에 시기·수치가 하나도 없어도 검사한다 — 그때야말로 파생물이 없는 시기를 새로 만든 사고다(활엽수 편).
  const idx = indexSource(src);
  const out: TimingIssue[] = [];
  const seen = new Set<string>();
  for (const d of derived) {
    const text = String(d?.text ?? '');
    if (!text.trim()) continue;
    for (const token of extractTimingNumbers(text)) {
      if (tokenInSource(token, idx)) continue;
      const key = `${d.field}||${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ field: d.field, token, text });
    }
  }
  return out;
}

/** 수정 라운드 입력 한 줄(기존 정합 지적과 같은 자리에 섞인다). 텍스트는 60자에서 자른다(프롬프트 비대 방지). */
export function formatTimingIssue(i: TimingIssue): string {
  const t = i.text.length > 60 ? `${i.text.slice(0, 60)}…` : i.text;
  return `시기·수치 원문 불일치 — ${i.field}: "${t}" (원문에 없는 ${i.token})`;
}

/**
 * 쇼츠 stat 오버레이 결정적 제거 — 값이 원문에 없으면 오버레이 자체를 뗀다(kind·stat 삭제 = normalizeSceneKind
 * 의 `{}` 강등과 같은 표현). 화면에 큼직하게 박히는 숫자라 수정 라운드(LLM)에 맡기지 않는다.
 * 단위 없는 값(단계 수·항목 수처럼 대본 구조상 자명한 숫자)은 대조할 수 없으므로 건드리지 않는다.
 * 반드시 수정 라운드 **뒤**에 부를 것 — 앞에서 떼면 작가가 같은 값을 다시 실어 보낼 수 있다.
 */
export function stripUnsourcedStatOverlays<T extends SceneKindFields>(
  scenes: T[], sourceBody: string,
): { scenes: T[]; removed: string[] } {
  const list = scenes ?? [];
  if (!CONFIG.timingParity || !String(sourceBody ?? '').trim()) return { scenes: list, removed: [] };
  const idx = indexSource(sourceBody);
  const removed: string[] = [];
  const next = list.map((sc) => {
    if (sc?.kind !== 'stat' || !sc.stat) return sc;
    const composed = `${sc.stat.value}${sc.stat.unit ?? ''}`;
    const tokens = extractTimingNumbers(composed);
    if (!tokens.length) return sc;                       // 단위 없는 자명한 숫자 — 대조 불가
    if (tokens.every((t) => tokenInSource(t, idx))) return sc;
    removed.push(tokens.find((t) => !tokenInSource(t, idx))!);
    const { kind: _kind, stat: _stat, ...rest } = sc;
    return rest as unknown as T;
  });
  return { scenes: next, removed };
}
