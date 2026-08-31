// src/orchestrator/briefVerdict.ts
/**
 * 브리프 게이트(2026-08-28) — 팩트체커 비평문에서 **판정**을 기계 판독한다.
 *
 * 배경: 종전엔 비평문이 `critiqueText` 문자열로 작가에게 참고 입력으로만 흘러갔고, 판정값으로 읽히는
 * 곳이 한 군데도 없었다. 실측(런 ba522a39fa7d, 2026-08-28): 팩트체커가 "REVISION_NEEDED(43/70) —
 * 무근거 기입 1건 확정으로 자동 반려. **게이트 미해소 상태의 집필 착수는 계속 보류한다**"고 썼는데
 * 62초 뒤 작가가 스폰돼 집필이 그대로 진행됐다. 반려가 아무것도 막지 못한 것이다.
 *
 * ── 왜 단순 문자열 검색이면 안 되는가(실측 함정) ────────────────────────────────
 * 비평문 본문에는 판정 토큰이 '판정이 아닌 용법'으로 흔히 등장한다. 위 런의 실제 두 비평문에서:
 *   R1:79   "…이 항목은 미해소 시 제 검토에서 무근거·리스크 누락으로 REVISION_NEEDED 사유가 됩니다"
 *            → 가정문. 이 라운드의 판정이 아니라 '다음에 이러면 반려하겠다'는 예고.
 *   R2:92   "wiki 기록: `R2/… — REVISION_NEEDED(43/70), 무근거 기입 1건(손질강도)…`"
 *            → 자기 판정의 메아리(기록용 요약). 중복 집계 위험.
 * 게다가 팩트체커의 시스템 프롬프트 자체가 REVISION_NEEDED 를 3회 담고 있어, 비평가가 자기 기준을
 * 인용하는 순간(“무근거면 REVISION_NEEDED”) 또 걸린다. 그래서 `text.includes(...)` 는 금지다.
 *
 * ── 앵커 3층 ────────────────────────────────────────────────────────────────
 *  1) 머리글 `판정:` 줄 — 첫 HEAD_LINES 줄 안. 페르소나가 강제하는 정규 표기.  (실측 R2:3 이 여기)
 *  2) 채점표 합계 행 — `합계`/`총점` + `N/70` + 판정 토큰이 한 줄에 모인 행.  (실측 R1:106 이 여기)
 *  3) 미파싱 — 판정을 못 읽으면 'unparsed'.
 *
 * ── 미파싱은 통과가 아니다 ──────────────────────────────────────────────────
 * 'unparsed' 를 APPROVED 로 흘려보내면, 프롬프트가 조금만 표류해도 지금 막으려는 구멍이 조용히 다시
 * 열린다(그리고 아무도 모른다). 호출부는 `isBlocking()` 으로 판단한다 — 반려와 미파싱을 같이 막는다.
 */

/** 판정 — approved(통과) / revision_needed(반려) / unparsed(판독 실패, 통과로 치지 않는다). */
export type BriefVerdict = 'approved' | 'revision_needed' | 'unparsed';

export interface BriefVerdictParse {
  verdict: BriefVerdict;
  /** 총점(예: 43). 못 읽으면 null. */
  score: number | null;
  /** 만점(예: 70). 못 읽으면 null. */
  maxScore: number | null;
  /** 차단 지적 건수(페르소나 정규 표기 `차단 N건`). 구 런·자유 서술이면 null. */
  blockers: number | null;
  /** 어느 앵커에서 읽었는지 — 로그·기록용(파서 표류를 현장에서 눈치채는 유일한 신호). */
  source: 'head' | 'total-row' | 'none';
}

/** 판정 줄을 찾을 머리글 범위. R2 실측은 3행 — 여유를 둬도 본문 채점표까지는 닿지 않는다. */
const HEAD_LINES = 12;

/** 판정 토큰. REVISION NEEDED / REVISION-NEEDED 변형까지 받는다. */
const VERDICT_RE = /\b(REVISION[_\s-]?NEEDED|APPROVED)\b/i;
/** 머리글 판정 줄 — 마크다운 장식(`**`, `>`, `-`, `#`)을 앞에 달고 오는 경우까지. */
const JUDGE_PREFIX_RE = /^[\s>*_#·+-]*판정\s*[:：]/;
/** 채점표 합계 행 앵커. */
const TOTAL_RE = /(합계|총점)/;
/** 마크다운 표 행 — 채점표 합계는 항상 표 안에 있다. 이 제한이 산문 오탐을 통째로 걷어낸다(아래 주석). */
const TABLE_ROW_RE = /^\s*\|.*\|/;
/** `43/70` 꼴. 숫자와 슬래시 사이에 단위·문자가 끼면 매치하지 않는다(실측 "163,027회 / 91.2%" 배제). */
const SCORE_RE = /(\d{1,3})\s*\/\s*(\d{1,3})(?!\d)/;
/** 페르소나 정규 표기의 차단 건수 — `차단 3건`. */
const BLOCKERS_RE = /차단\s*(\d{1,3})\s*건/;

/** 마크다운 강조 제거 — `**REVISION_NEEDED**` 를 토큰 매치에 방해되지 않게. */
function unstyle(line: string): string {
  return line.replace(/[*_`]/g, ' ');
}

function verdictOf(line: string): BriefVerdict | null {
  const m = VERDICT_RE.exec(unstyle(line));
  if (!m) return null;
  return /APPROVED/i.test(m[1]!) ? 'approved' : 'revision_needed';
}

/** 만점 타당성 — 채점표는 70점 만점이지만 표류를 대비해 범위로만 막는다(0/0·연도·전화번호 배제). */
function plausibleScore(score: number, max: number): boolean {
  return max >= 10 && max <= 200 && score >= 0 && score <= max;
}

function scoreOf(line: string): { score: number | null; maxScore: number | null } {
  const m = SCORE_RE.exec(unstyle(line));
  if (!m) return { score: null, maxScore: null };
  const score = Number(m[1]);
  const maxScore = Number(m[2]);
  return plausibleScore(score, maxScore) ? { score, maxScore } : { score: null, maxScore: null };
}

function blockersOf(line: string): number | null {
  const m = BLOCKERS_RE.exec(unstyle(line));
  return m ? Number(m[1]) : null;
}

/**
 * 비평문에서 판정을 읽는다. 앵커 밖의 판정 토큰(가정문·메아리·기준 인용)은 의도적으로 무시한다.
 * 순수 함수 — 실제 비평문 두 건을 고정 표본으로 테스트한다(briefVerdict.test.ts).
 */
export function parseBriefVerdict(text: string): BriefVerdictParse {
  const none: BriefVerdictParse = { verdict: 'unparsed', score: null, maxScore: null, blockers: null, source: 'none' };
  if (!text || !text.trim()) return none;
  const lines = text.split('\n');

  // ── 1층: 머리글 `판정:` 줄 ───────────────────────────────────────────────
  // 빈 줄·구분선을 세지 않고 '내용 있는 줄' 기준으로 HEAD_LINES 만큼만 본다(제목·전제 고지가 앞을 먹어도
  // 판정 줄에 닿게). 실측 R2 는 내용 3번째 줄에 있다.
  let seen = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (++seen > HEAD_LINES) break;
    if (!JUDGE_PREFIX_RE.test(raw)) continue;
    const verdict = verdictOf(raw);
    if (!verdict) continue; // "판정: 보류" 같은 비정규 표기 — 아래 층에 맡긴다
    return { verdict, ...scoreOf(raw), blockers: blockersOf(raw), source: 'head' };
  }

  // ── 2층: 채점표 합계 행 ─────────────────────────────────────────────────
  // **마크다운 표 행**이면서 `합계`/`총점` + `N/70` + 판정 토큰이 한 줄에 모여야 한다. 넷을 모두
  // 요구해야 실측 오탐이 걸러진다:
  //   R1:30  "§1-2 표 6행 합계는 44,620회입니다"        → 점수·판정 없음
  //   R2:13  "| S-1 | 유튜브 5편 합계 163,027회 / 91.2%" → 판정 없음 + 슬래시 앞이 '회'
  //   R2:92  "wiki 기록: … REVISION_NEEDED(43/70) …"     → 합계/총점 없음, 표 행 아님
  // 표 행 제한이 없으면 페르소나 기준의 **자기 인용**이 걸린다 — 팩트체커 시스템 프롬프트가 담은
  // "총점 49/70 이상이면 APPROVED, 미만이면 REVISION_NEEDED" 를 비평가가 본문에 옮겨 적는 순간
  // 산문 한 줄에 합계·점수·판정이 모두 모여 통과로 오독된다(개발 중 실제로 걸린 오탐).
  // 채점표는 문서 끝에 오므로 마지막 매치를 취한다.
  let found: BriefVerdictParse | null = null;
  for (const raw of lines) {
    if (!TABLE_ROW_RE.test(raw) || !TOTAL_RE.test(raw)) continue;
    const verdict = verdictOf(raw);
    if (!verdict) continue;
    const s = scoreOf(raw);
    if (s.score === null) continue;
    found = { verdict, ...s, blockers: blockersOf(raw), source: 'total-row' };
  }
  return found ?? none;
}

/**
 * 집필을 막아야 하는 판정인가 — 반려와 **미파싱**을 함께 막는다.
 * 미파싱을 통과로 두면 프롬프트 표류가 게이트를 조용히 무력화한다(이 파일이 존재하는 이유 그 자체).
 */
export function isBlocking(p: BriefVerdictParse): boolean {
  return p.verdict !== 'approved';
}

/** 비평문 말미의 `## 미해소` 절 머리글. VERDICT_FORMAT 이 강제하는 표기. */
const UNRESOLVED_HEAD_RE = /^[\s>*_#·+-]*미해소\s*[:：]?\s*$/;
/** 목록 항목 — `- `, `* `, `1. `, `① ` 등. */
const BULLET_RE = /^\s*(?:[-*+·]|\d{1,2}[.)]|[①-⑳])\s+(.+)$/;
/** 다른 절의 시작(마크다운 머리글) — 미해소 절의 끝. */
const HEADING_RE = /^\s*#{1,6}\s/;

/**
 * 비평문 말미 `## 미해소` 절의 항목을 뽑는다 — 재작업 뒤에도 남은 지적. 작가에게 '필수 반영'으로
 * 주입하고, 검토 알림에 건수로 띄운다. 절이 없으면 빈 배열(구 런·자유 서술).
 */
export function parseUnresolved(text: string, limit = 10): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    if (UNRESOLVED_HEAD_RE.test(raw)) { inSection = true; out.length = 0; continue; } // 여러 번 나오면 마지막 절
    if (!inSection) continue;
    if (HEADING_RE.test(raw)) { inSection = false; continue; }
    const m = BULLET_RE.exec(raw);
    if (m) {
      const item = m[1]!.replace(/[*_`]/g, '').trim();
      // '없음'은 항목이 아니라 '비어 있음' 선언이다 — 이걸 1건으로 세면 통과한 런이 미해소 1건으로 보인다.
      if (item && !/^없(음|다)[.。]?$/.test(item)) out.push(item);
    }
  }
  return out.slice(0, limit);
}

/**
 * 비평가에게 요구하는 판정 표기 — 파서의 앵커와 1:1로 맞물린다. 여기를 고치면 briefVerdict 의 앵커도
 * 같이 고쳐야 한다(그래서 프롬프트를 파서 옆에 둔다 — 떨어져 있으면 조용히 어긋난다).
 */
export const VERDICT_FORMAT = [
  '[판정 표기 — 반드시 이 형식으로]',
  '1) 문서 **첫 줄**에 `판정: APPROVED` 또는 `판정: REVISION_NEEDED` 로 시작하고, 뒤에 `· 총점 N/70 · 차단 N건`을 붙여라.',
  '2) 문서 **마지막**에 `## 미해소` 절을 두고, 집필 전에 반드시 해소돼야 할 지적만 한 줄씩 목록으로 적어라(없으면 "- 없음").',
  '   각 줄은 그 자체로 이해되게 써라 — 작가는 이 목록만 보고 고친다("A-3 참조" 같은 상호참조 금지).',
  '3) `차단 N건`의 N 은 `## 미해소` 항목 수와 일치시켜라.',
].join('\n');

/** 로그·기록용 한 줄 — `반려 43/70 · 차단 3건(머리글)`. 사람이 읽는 현장 신호. */
export function describeVerdict(p: BriefVerdictParse): string {
  const label = p.verdict === 'approved' ? '통과' : p.verdict === 'revision_needed' ? '반려' : '판정 미파싱';
  const parts = [label];
  if (p.score !== null && p.maxScore !== null) parts.push(`${p.score}/${p.maxScore}`);
  if (p.blockers !== null) parts.push(`차단 ${p.blockers}건`);
  const src = p.source === 'head' ? '머리글' : p.source === 'total-row' ? '채점표' : '앵커 없음';
  return `${parts.join(' · ')}(${src})`;
}
