/**
 * 같은 주제 재작성 시 '관점 다양성' 주입(사용자 원칙 2026-07-21) — 기존 novelty 가드는 유사 주제를
 * "차단"하지만, 사용자가 같은 주제로 또 만들 때(force) 내용이 앵글까지 똑같아지는 문제가 있었다
 * (실측: 하스카프베리 글 2편 — 문자열 12% 겹침이나 소제목·구성·비교가 동일).
 *
 * 이 모듈은 같은 kind(블로그↔블로그 등)의 유사 주제 기존 콘텐츠가 '이미 다룬 구성'을 뽑아, 생성기
 * (작가·기획자) 프롬프트에 "핵심 사실은 담되 진입점·강조·구성은 완전히 다르게" 지시로 주입한다.
 * 사실을 피하라는 게 아니라 프레이밍을 다르게 — 정의적 사실을 빼면 글이 틀려지므로.
 *
 * 전량 fail-open: 스토어·파일·파싱 어디가 실패해도 빈 문자열을 반환해 파이프라인은 기존대로 진행한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { keywordSimilar, titleSimilar, STOP_TOKENS } from './novelty';
import { pieceStore } from './pieces';
import { cardNewsStore } from './cardnews';
import { shortsStore } from './shorts';

export type ContentKind = '블로그' | '카드뉴스' | '숏폼';

interface PriorOutline { title: string; outline: string }

/** 후보(새 콘텐츠 주제/키워드)와 기존 항목이 '같은 주제'인가 — 키워드 포함/유사 + 제목 유사(관대). */
function sameTopic(candTitle: string, candKey: string, e: { title: string; keyword?: string }): boolean {
  if (candKey && e.keyword && keywordSimilar(candKey, e.keyword)) return true; // '하스카프베리 재배' ↔ '하스카프베리'
  if (candKey && e.title && keywordSimilar(candKey, e.title)) return true;     // 키워드 ⊂ 제목
  if (titleSimilar(candTitle, e.title)) return true;
  return false;
}

/** 마크다운 본문에서 소제목(##/###) 추출 — 해시태그 줄(# 2개 이상)은 제외. */
export function markdownHeadings(body: string, cap = 6): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^#{1,3}\s*(.+)$/gm)) {
    const h = (m[1] || '').trim();
    if (!h || (h.match(/#/g) || []).length >= 2) continue; // 태그 나열 줄 배제
    out.push(h.slice(0, 50));
    if (out.length >= cap) break;
  }
  return out;
}

/** 본문 마크다운의 '스타일 지문'(순수) — 도입 첫 문장·마무리 소제목·소제목 골격. 교차-글 다양성 지시의 원자료. */
export function styleSignatureOf(body: string): { opening: string; closing: string; headings: string } {
  const hs = markdownHeadings(body);
  const plain = (body || '')
    .replace(/^#{1,6}.*$/gm, ' ')          // 소제목 줄 제거
    .replace(/\[IMAGE:[^\]]*\]/g, ' ')     // 이미지 마커 제거
    .replace(/[#*>`|_~-]/g, ' ')           // 서식 문자 제거
    .replace(/\s+/g, ' ').trim();
  const opening = (plain.split(/(?<=[.!?。])\s/)[0] ?? plain).slice(0, 60);
  return { opening, closing: hs[hs.length - 1] ?? '', headings: hs.join(' · ') };
}
/** 블로그 초안 스타일 지문 — piece.runId → draft.json 의 bodyMarkdown(디스크). 실패 시 null. */
function blogStyleSig(runId: string | undefined): { opening: string; closing: string; headings: string } | null {
  if (!runId) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    const body = d.bodyMarkdown ?? '';
    if (!body.trim()) return null;
    const s = styleSignatureOf(body);
    return (s.opening || s.headings) ? s : null;
  } catch { return null; }
}
/** 블로그 초안 본문 원문 — piece.runId → data/sessions/<runId>/draft.json 의 bodyMarkdown(없으면 ''). */
function blogBodyOf(runId: string | undefined): string {
  if (!runId) return '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    return d.bodyMarkdown ?? '';
  } catch { return ''; }
}

/** 블로그 초안 소제목 — piece.runId → data/sessions/<runId>/draft.json 의 bodyMarkdown. */
function blogOutline(runId: string | undefined): string {
  if (!runId) return '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    return markdownHeadings(d.bodyMarkdown ?? '').join(' · ');
  } catch { return ''; }
}

/** 카드뉴스/숏폼 plan.json 에서 구성 요약 — 슬라이드 헤드라인 / 씬 화면텍스트. */
function planOutline(dir: string, kind: 'card' | 'short'): string {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf-8')) as {
      slides?: Array<{ headline?: string }>; scenes?: Array<{ screenText?: string; narration?: string }>;
    };
    if (kind === 'card') {
      return (p.slides ?? []).map((s) => (s.headline || '').trim()).filter(Boolean).slice(0, 6).join(' · ');
    }
    return (p.scenes ?? []).map((s) => (s.screenText || s.narration || '').trim().slice(0, 24)).filter(Boolean).slice(0, 6).join(' · ');
  } catch { return ''; }
}

/** 같은 kind·같은 브랜드·유사 주제의 기존 콘텐츠 구성(최신순, 파생·자기 자신 제외). */
function collectPriorOutlines(
  kind: ContentKind, topic: string, keyword: string | undefined,
  opts: { excludeId?: string; excludeSourcePieceId?: string; brandSlug?: string },
): PriorOutline[] {
  const candKey = (keyword || topic || '').trim();
  const candTitle = (topic || '').trim();
  const brand = opts.brandSlug;
  // 브랜드 격리(사용자 원칙) — brandSlug 지정 시 같은 브랜드만 대조. undefined 는 필터 안 함.
  const brandOk = (b?: string): boolean => brand === undefined || (b ?? undefined) === brand;
  const out: PriorOutline[] = [];
  if (kind === '블로그') {
    // 최신부터 — 최근 것이 가장 관련 높음. 블로그 piece 는 원본(파생 아님).
    for (const e of [...pieceStore().list()].reverse()) {
      if (e.id === opts.excludeId || !brandOk(e.brand)) continue;
      if (!sameTopic(candTitle, candKey, e)) continue;
      out.push({ title: e.title, outline: blogOutline(e.runId) });
      if (out.length >= 2) break;
    }
  } else if (kind === '카드뉴스') {
    for (const e of cardNewsStore().list()) { // 이미 최신순
      if (e.id === opts.excludeId || !brandOk(e.brand)) continue;
      if (opts.excludeSourcePieceId && e.sourcePieceId === opts.excludeSourcePieceId) continue; // 같은 글 파생 형제 제외
      if (!sameTopic(candTitle, candKey, { title: e.topic, keyword: e.keyword })) continue;
      out.push({ title: e.topic, outline: planOutline(cardNewsStore().dirFor(e.id), 'card') });
      if (out.length >= 2) break;
    }
  } else {
    for (const e of shortsStore().list()) {
      if (e.id === opts.excludeId || !brandOk(e.brand)) continue;
      if (opts.excludeSourcePieceId && e.sourcePieceId === opts.excludeSourcePieceId) continue;
      if (!sameTopic(candTitle, candKey, { title: e.topic, keyword: e.keyword })) continue;
      out.push({ title: e.topic, outline: planOutline(shortsStore().dirFor(e.id), 'short') });
      if (out.length >= 2) break;
    }
  }
  return out;
}

/**
 * 생성기 프롬프트에 붙일 '관점 다양성' 지시 블록 — 유사 주제 기존 콘텐츠가 없으면 빈 문자열(무주입).
 * 사실은 담되 프레이밍(진입점·독자 상황·강조·예시·구성·순서·깊이)을 완전히 다르게 하라는 지시.
 */
export function priorCoverageBrief(
  kind: ContentKind, topic: string, keyword: string | undefined,
  opts: { excludeId?: string; excludeSourcePieceId?: string; brandSlug?: string } = {},
): string {
  try {
    const priors = collectPriorOutlines(kind, topic, keyword, opts);
    if (!priors.length) return '';
    const lines = priors.map((o, i) => `${i + 1}. "${o.title}"${o.outline ? ` (다룬 것: ${o.outline})` : ''}`);
    return [
      `[이미 만든 유사 주제 ${kind} — 반드시 다른 각도로 써라]`,
      '이 주제로 이미 아래를 만들었다:',
      ...lines,
      // 앵커링 방지 — 위 구성을 "피할 목록"으로 보여주되, 흉내 금지를 강하게 못박고 divergence '방향'을 처방한다.
      '경고: 위 구성은 참고가 아니라 "이미 써먹어서 반복하면 안 되는 것"이다. 위의 소제목·전개 순서·도입·비교 대상을 그대로 따라가면 실패다.',
      // 회피 범위 정밀화(2026-08-24 실사고) — "블루베리나무화분 라벨" 편이 목록에 있다는 이유로 작가가
      // 원문의 핵심 축 '화분 크기'까지 통째로 회피해, 파생 쇼츠가 블로그 핵심과 어긋났다. 금지는
      // '실제로 다룬 것'에만 걸린다는 것을 명시해 소재 단어 겹침만으로 새 축을 버리지 않게 한다.
      '단, 회피 대상은 위 "다룬 것" 목록의 내용 그 자체뿐이다 — 목록에 없는 소재·각도는 비슷한 단어가 들어가도 회피 대상이 아니다. 이번 원문에만 있는 새 소재는 자유롭게 중심으로 삼아라.',
      '대신 진입 프레임 자체를 바꿔라 — 아래 중 위 글과 겹치지 않는 하나를 골라 그 각도로 처음부터 새로 구성하라:',
      '· 다른 독자 상황(예: 이미 심었는데 열매가 안 달리는 사람 / 공간·화분 제약 / 특정 계절·시기)',
      '· 다른 글 유형(통념 반박 / 실패·시행착오 복기 / 단계별 체크리스트 / 자주 묻는 질문 / 한 가지 쟁점 심화)',
      '주제의 정의적 핵심 사실은 한두 줄로만 짚고, 나머지 분량은 위 글이 다루지 않은 새 정보·상황·예시로 채워라.',
    ].join('\n');
  } catch { return ''; }
}

/**
 * 최근 발행한 같은 유형(블로그) 글의 '스타일 지문'(도입 첫 문장·마무리 소제목·소제목 골격)을 모아,
 * 작가에게 "이 도입·마무리·구성을 반복하지 말고 다르게 쓰라"는 교차-글 다양성 지시 블록으로 만든다.
 * novelty(주제 중복)·priorCoverage(같은 주제 각도)를 넘어, **다른 주제인데도 매번 같은 틀로 수렴**하는 것을
 * 막는다(2026-07-23 감사: 도입 공식·"N단계 체크"·"오늘 바로 할 일" 마무리·"A가 아니라 B" 훅 과반복). 전량 fail-open.
 */
export function recentStyleToAvoid(
  brandSlug: string | undefined, opts: { excludeRunId?: string; limit?: number } = {},
): string {
  try {
    const brandOk = (b?: string): boolean => brandSlug === undefined || (b ?? undefined) === brandSlug;
    const sigs: Array<{ opening: string; closing: string; headings: string }> = [];
    for (const e of [...pieceStore().list()].reverse()) {   // 최신부터
      if (e.runId === opts.excludeRunId || !brandOk(e.brand)) continue;
      const s = blogStyleSig(e.runId);
      if (s) sigs.push(s);
      if (sigs.length >= (opts.limit ?? 4)) break;
    }
    if (!sigs.length) return '';
    const lines = sigs.map((s, i) => `${i + 1}. 도입: "${s.opening}…" / 마무리 소제목: "${s.closing}" / 구성: ${s.headings}`);
    return [
      '[최근 발행한 같은 유형 글의 도입·마무리·구성 — 아래와 겹치지 말 것]',
      ...lines,
      '위 글들과 다른 진입 방식·다른 마무리·다른 소제목 구성으로 써라. 특히 아래 과반복 틀을 이번 글에서 반복하지 마라: '
        + '①도입 공식(계절/날씨 장면→독자의 흔한 실수→"결론부터/그런데" 반전) ②"N단계 체크법" 소제목 ③"오늘 바로 할 일/정리/요약" 식 마무리 '
        + '④"A가 아니라 B"·"X보다 Y가 먼저" 대비 훅. 같은 소재라도 진입 프레임·구성·마무리 방식을 반드시 바꿔라.',
    ].join('\n');
  } catch { return ''; }
}

/**
 * 코퍼스 반복 상투구 채굴(순수, 2026-08-06) — 서로 다른 문서 minDocs편 이상에 등장하는 n그램(기본 2~3그램).
 *
 * 배경: phraseAvoid 는 하드코딩 예시('물주기 리듬' 등)뿐이라 새로 생기는 상투구를 못 막았다
 * (실측: 소제목 "…갈리는 지점" 3편, 카드뉴스 헤드라인 "사진 …" 3건). 문서빈도(df)로 직접 잡는다.
 *
 * 오차단 방지 3중: ①같은 문서 내 반복은 1회(주제 내 정상 반복을 상투구로 오인 금지)
 * ②exclude 어간(compoundStems 등 소재어)이 든 n그램 제외 — '묘목 고르기'는 도메인 용어지 상투구가 아니다
 * ③전 토큰이 STOP_TOKENS(관리·방법…)뿐인 n그램 제외. 문장부호 경계 너머로는 잇지 않는다.
 * includeUnigrams 는 헤드라인처럼 짧은 문서용(블로그 전문에 켜면 모든 빈출 명사가 잡힌다 — 켜지 말 것).
 */
// 단일어 채굴 전용 기능어 — 헤드라인류에 흔하지만 상투구 신호가 아닌 부사·지시어(실코퍼스 스모크에서
// '다른'·'전에'·'계속'이 잡히던 오탐 대응). STOP_TOKENS(novelty)와 달리 유사도 판정에는 안 쓰는 로컬 목록.
const UNIGRAM_FUNC = new Set(['다른', '전에', '계속', '오늘', '지금', '먼저', '바로', '함께', '이번', '아직']);

export function recurringPhrases(
  docs: string[],
  opts: { minDocs?: number; cap?: number; includeUnigrams?: boolean; exclude?: string[] } = {},
): string[] {
  const minDocs = opts.minDocs ?? 3;
  const cap = opts.cap ?? 8;
  const exclude = (opts.exclude ?? []).filter(Boolean);
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    // 문장부호로 세그먼트를 끊고, 세그먼트 안에서만 인접 n그램 생성.
    for (const seg of (doc || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}\s]+/u)) {
      const toks = seg.split(/\s+/).filter((t) => t.length >= 2);
      for (let n = opts.includeUnigrams ? 1 : 2; n <= 3; n++) {
        for (let i = 0; i + n <= toks.length; i++) {
          const gram = toks.slice(i, i + n);
          if (gram.every((t) => STOP_TOKENS.has(t))) continue;             // 범용 꼬리말뿐
          if (n === 1 && UNIGRAM_FUNC.has(gram[0]!)) continue;             // 단일어 기능어 오탐
          // 소재어 보호 — 양방향 포함: 어간 '가지치기'가 토큰 '가지'도 보호해야 나무 브랜드에서
          // '가지(枝)'를 상투구로 금지하는 사고가 없다(실코퍼스 스모크 실측).
          if (exclude.some((s) => gram.some((t) => t.includes(s) || s.includes(t)))) continue;
          seen.add(gram.join(' '));
        }
      }
    }
    for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1);
  }
  const kept: string[] = [];
  // df 내림차순 → 긴 것 우선. 이미 채택한 구에 포함되는 부분구는 중복이라 건너뛴다.
  for (const [g] of [...df.entries()].filter(([, c]) => c >= minDocs)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)) {
    if (kept.some((k) => k.includes(g) || g.includes(k))) continue;
    kept.push(g);
    if (kept.length >= cap) break;
  }
  return kept;
}

/** 과사용 어휘 회피 시드(2026-08-13 15편 감사 확정) — 블로그 작가는 org.ts 의 상세판을 쓰고, 파생
 *  기획(카드뉴스·숏폼)은 이 압축판을 쓴다. 실측: 가드가 블로그에만 있던 탓에 쇼츠 '제목'으로 같은
 *  지문('갈려요')이 샜다 — 파생 기획도 제목·헤드라인·내레이션을 새로 쓰므로 같은 지문이 재발한다. */
export const OVERUSED_LEXEME_GUIDE =
  "[과사용 어휘 회피] 최근 콘텐츠에 반복돼 문체 지문이 된 어휘다 — 활용형·변형까지 전부 포함해 제목·헤드라인·내레이션·캡션에서 피하고 같은 뜻의 일상어로 써라: "
  + "'갈린다·갈립니다·갈래·갈려요' 등 갈리- 계열 전부(→달라진다·차이가 난다·나뉜다·~에 달렸다 — 실측: '갈려요'·'갈립니다'로 제목에 두 번 우회 유출), "
  + "'대개'(→보통·흔히), '판단·판정' 명사 남용(→기준·보는 법), "
  + "'~쪽입니다'(→직접 서술), '걷어내다'(→잘라내다·솎다·치우다), '~하는 셈', 추상 '지점'(→대목·부분). 일상 대화에서 안 쓰는 어휘로 멋 내지 말 것.";

/** 블로그 초안 전문 본문 — piece.runId → data/sessions/<runId>/draft.json 의 bodyMarkdown. */
function blogBody(runId: string | undefined): string {
  if (!runId) return '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    return d.bodyMarkdown ?? '';
  } catch { return ''; }
}

/** 자모 접두(NFD) — 활용형(갈린다/갈리는/갈립니다)을 같은 어간 그룹으로 접는 값싼 트릭.
 *  NFD 는 초·중·종성을 별개 코드포인트로 풀어 접두 5자모 ≈ 어간 2.5음절(형태소 분석기 없이 충분). */
export function jamoPrefix(w: string, n = 5): string {
  return [...w.normalize('NFD')].slice(0, n).join('');
}

// 과사용 어간 채굴 제외 상용 기능형(어절 접두 매치) — 이걸 금지하면 문장 자체가 안 써진다.
// 85% 상한(거의 전 편 등장=언어)이 1차 방어고 이 목록은 중간 빈도로 걸리는 것들의 2차 안전핀.
const LEXEME_STOP_PREFIXES = [
  '합니다', '입니다', '됩니다', '있습', '없습', '했습', '봅니다', '줍니다', '옵니다', '갑니다',
  '있는', '없는', '있어', '없어', '있으', '없으', '하는', '되는', '하면', '되면', '해서', '해도', '해요', '했다', '한다',
  '그리고', '그래서', '하지만', '그런데', '그러면', '그렇', '이렇', '저렇', '이런', '그런', '저런',
  '때문', '경우', '정도', '가장', '조금', '지금', '이제', '다시', '바로', '함께', '모두', '먼저', '같은', '같이', '다른', '많이',
  '여기', '거기', '저기', '우리', '제가', '저는', '보면', '보고', '보이', '싶은', '싶다', '주세', '보세', '드세', '말고', '아니',
];

/**
 * 최근 블로그 '본문 전체'에서 글마다 반복되는 어간(활용형 무관) 채굴 — 작가 어휘 지문 완화 재료.
 * recentPhrasesToAvoid(표면 n그램·소제목/도입 한정)가 못 잡던 두 구멍을 메운다(2026-08-13 사용자 지적,
 * 15편 감사 실측: '갈리-/갈래' 47회 등 지문 12종이 전부 본문 중간 + 활용형 분산이라 미검출):
 *  ① 본문 중간의 반복 ② 갈린다/갈리는/갈립니다 활용형 분산(자모 접두 5로 그룹).
 * 안전핀: 소재어(stems)·제목 토큰 보호, 기능형 STOP, 85%+ 편재는 언어 자체라 제외, cap 6, 전량 fail-open.
 */
export function recentLexemesToAvoid(
  brandSlug: string | undefined,
  opts: { stems?: string[]; limit?: number; minDocs?: number; docs?: string[]; titles?: string[] } = {},
): string[] {
  try {
    let docs = opts.docs;
    let titles = opts.titles ?? [];
    if (!docs) {
      docs = [];
      titles = [];
      const limit = opts.limit ?? 15;
      const brandOk = (b?: string): boolean => brandSlug === undefined || (b ?? undefined) === brandSlug;
      for (const e of [...pieceStore().list()].reverse()) {
        if (!brandOk(e.brand)) continue;
        const body = blogBody(e.runId);
        if (body) { docs.push(body); titles.push(e.title); }
        if (docs.length >= limit) break;
      }
    }
    const minDocs = opts.minDocs ?? 5;
    if (docs.length < Math.max(minDocs, 8)) return []; // 코퍼스 작으면 판단 보류(초기 브랜드 무해)
    const ceiling = Math.ceil(docs.length * 0.85);
    const titleTokens = new Set(titles.flatMap((t) =>
      (t || '').normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 2)));
    // 소재 동사 보호(실코퍼스 스모크 2026-08-13): 제목에 '떨어지는'이 있으면 본문의 떨어짐·떨어진 등
    // 활용형 전체를 보호해야 한다 — 정확 일치만으론 '잎이 떨어지는 이유' 글 무리에서 '떨어지-'를
    // 문체 지문으로 오인했다. 제목 토큰의 자모 접두 3(≈1.5음절)까지 보호(과보호가 과차단보다 낫다).
    const titleJamo = new Set([...titleTokens].map((t) => jamoPrefix(t, 3)));
    const stems = (opts.stems ?? []).filter(Boolean);
    const df = new Map<string, number>();                       // 자모접두 → 문서빈도
    const surf = new Map<string, Map<string, number>>();        // 자모접두 → 표면형 빈도(대표형 선정)
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const raw of (doc || '').normalize('NFC').split(/[^가-힣]+/u)) {
        if (raw.length < 2 || raw.length > 6) continue;
        if (titleTokens.has(raw) || titleJamo.has(jamoPrefix(raw, 3))) continue;
        if (stems.some((s) => raw.includes(s) || s.includes(raw))) continue;
        if (LEXEME_STOP_PREFIXES.some((p) => raw.startsWith(p) || p.startsWith(raw))) continue;
        const key = jamoPrefix(raw, 5);
        if ([...key].length < 5) continue;                      // 짧은 어절(1음절대)은 잡음
        seen.add(key);
        const m = surf.get(key) ?? new Map<string, number>();
        m.set(raw, (m.get(raw) ?? 0) + 1);
        surf.set(key, m);
      }
      for (const k of seen) df.set(k, (df.get(k) ?? 0) + 1);
    }
    const out: string[] = [];
    for (const [k, c] of [...df.entries()].sort((a, b) => b[1] - a[1])) {
      if (c < minDocs || c > ceiling) continue;
      const forms = [...(surf.get(k) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
      if (!forms.length) continue;
      // 대표형 + 다른 활용형 힌트(작가가 '활용형 포함'임을 알게)
      const rep = forms[0]![0];
      const alt = forms.slice(1, 3).map(([w]) => w).filter((w) => w !== rep);
      out.push(alt.length ? `${rep}(${alt.join('·')} 등 활용형 포함)` : rep);
      if (out.length >= 6) break;
    }
    return out;
  } catch { return []; }
}

/**
 * 최근 콘텐츠의 반복 상투구 목록 — 생성기 프롬프트 '반복 표현 금지'에 주입할 재료. 전량 fail-open.
 * 채굴 원천은 kind별 '스타일이 드러나는 표면'만: 블로그=소제목+도입 첫 문장(전문을 넣으면 정상 소재어까지
 * 잡힌다), 카드뉴스=슬라이드 헤드라인, 숏폼=씬 화면텍스트. 헤드라인류는 짧아 unigram 도 포함.
 */
export function recentPhrasesToAvoid(
  kind: ContentKind, brandSlug: string | undefined,
  opts: { stems?: string[]; limit?: number; minDocs?: number } = {},
): string[] {
  try {
    // 블로그는 창을 넓게(20) — 상투구는 오래돼도 상투구고, 좁은 창(12)에선 '갈리는 지점' 3편이 흩어져
    // 문서빈도 미달로 놓쳤다(실코퍼스 스모크 실측). 파생은 총량이 적어 12로 충분.
    const limit = opts.limit ?? (kind === '블로그' ? 20 : 12);
    const brandOk = (b?: string): boolean => brandSlug === undefined || (b ?? undefined) === brandSlug;
    const docs: string[] = [];
    const titles: string[] = []; // 채굴 문서들의 제목·주제 — 주제어는 상투구가 아니다(아래 exclude 로 보호)
    if (kind === '블로그') {
      for (const e of [...pieceStore().list()].reverse()) {
        if (!brandOk(e.brand)) continue;
        const s = blogStyleSig(e.runId);
        if (s) { docs.push(`${s.headings}. ${s.opening}`); titles.push(e.title); }
        if (docs.length >= limit) break;
      }
    } else if (kind === '카드뉴스') {
      for (const e of cardNewsStore().list()) {
        if (!brandOk(e.brand)) continue;
        const o = planOutline(cardNewsStore().dirFor(e.id), 'card');
        // 마지막 장(마무리·CTA)은 제외 — 설계상 반복되는 행동유도('예고' 등)를 상투구로 오인 방지.
        if (o) { docs.push(o.split(' · ').slice(0, -1).join(' · ')); titles.push(e.topic); }
        if (docs.length >= limit) break;
      }
    } else {
      for (const e of shortsStore().list()) {
        if (!brandOk(e.brand)) continue;
        const o = planOutline(shortsStore().dirFor(e.id), 'short');
        if (o) { docs.push(o.split(' · ').slice(0, -1).join(' · ')); titles.push(e.topic) ; }
        if (docs.length >= limit) break;
      }
    }
    if (docs.length < (opts.minDocs ?? 3)) return []; // 코퍼스가 작으면 판단 보류(초기 브랜드 무해)
    // 주제어 보호 — 채굴 문서들의 제목 토큰('배롱나무'·'심기'·'확인'…)이 든 n그램은 소재 반복이지
    // 문체 상투구가 아니다. 이걸 금지하면 키워드 표기 강제(SEO)와 정면 충돌한다.
    const titleTokens = [...new Set(titles.flatMap((t) =>
      (t || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 2)))];
    return recurringPhrases(docs, {
      minDocs: opts.minDocs ?? 3,
      includeUnigrams: kind !== '블로그', // 헤드라인·화면텍스트는 짧아 단일어 반복('사진')도 상투구
      exclude: [...(opts.stems ?? []), ...titleTokens],
      cap: 6,
    });
  } catch { return []; }
}

/**
 * 마무리 문단 첫 문장 추출(순수, 2026-08-27 말투 감사 권고 5) — 최근 글의 '닫는 문형'을 작가에게 보여 주는
 * 로테이션 지시의 원자료. 마크다운 껍데기(소제목·표·코드·인용/목록 마커·구분선·이미지 마커)를 벗기고
 * 남은 **마지막 문단**의 첫 문장을 뽑는다(꼬리가 해시태그·키워드 나열 줄이면 건너뛴다 — 2026-08-27 리뷰
 * 실측: bodyMarkdown 자체가 태그 줄로 끝나는 초안이 90건 중 2건). styleSignatureOf 의 closing 은 '마무리 소제목'이라 다른 축이다
 * (소제목만 바꾸고 같은 문형으로 닫는 글을 못 잡았다 — 그래서 문장 층위를 따로 본다).
 */
export function endingSentenceOf(body: string): string {
  const cleaned = String(body ?? '')
    .replace(/```[\s\S]*?```/g, '\n\n')      // 코드블록
    .replace(/^#{1,6}\s.*$/gm, '\n')         // 소제목
    .replace(/\[IMAGE:[^\]]*\]/g, ' ')       // 이미지 마커
    .replace(/^\s*\|.*$/gm, '\n')            // 표
    .replace(/^\s*-{3,}\s*$/gm, '\n')        // 구분선
    .replace(/^\s*>+\s*/gm, '')              // 인용 마커
    .replace(/^\s*(?:[-*]\s+|\d+\.\s+)/gm, '') // 목록 마커
    .replace(/^\s*(?:#\S+\s*)+$/gm, '\n')      // 해시태그 전용 줄 — '#' 뒤 공백이 없어 소제목 스트립에 안 걸린다(실측)
    .replace(/[*_`]/g, '');
  const paras = cleaned.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // 꼬리 키워드 나열 방어(실측 2/90건) — 마지막 '문단'이 문장 종결부호도 한글 종결어미도 없이 끝나면
  // 그것은 문장이 아니라 태그·키워드 줄이다("포도나무수확시기 포도수확시기 …"). 한 칸 앞 문단을 쓴다.
  const endsAsSentence = (p: string): boolean => /[.!?…]$/.test(p) || /(?:다|요|죠|까|세요|니다)$/.test(p);
  let i = paras.length - 1;
  if (i > 0 && !endsAsSentence(paras[i] ?? '')) i -= 1;
  const last = paras[i] ?? '';
  return (last.split(/(?<=[.!?…])\s/)[0] ?? last).slice(0, 60);
}

/**
 * 최근 블로그 마무리 문형 회피 블록(2026-08-27 권고 5) — 카드·쇼츠의 마무리 로테이션과 같은 원리로,
 * 최근 limit 편의 마무리 문단 첫 문장을 원문 그대로 보여 주고 "같은 문형으로 닫지 마라"고 못박는다.
 * 지시문만으로는 '오늘 바로 할 일' 계열 클로징이 계속 새는 것이 실측됐다(recentStyleToAvoid 는 소제목 층위).
 * 원문은 draft.json 의 bodyMarkdown 을 쓴다 — 같은 런의 draft.md 는 꼬리에 해시태그·제목 후보 주석이
 * 붙어 있어 '마지막 문단'이 태그 줄이 된다(실측). 전량 fail-open: 실패하면 빈 문자열(무주입).
 */
export function recentBlogEndings(brandSlug: string | undefined, limit = 5): string {
  try {
    const brandOk = (b?: string): boolean => brandSlug === undefined || (b ?? undefined) === brandSlug;
    const endings: string[] = [];
    for (const e of [...pieceStore().list()].reverse()) {   // pieceStore.list() 는 오래된 순 — 뒤집어 최신부터
      if (!brandOk(e.brand)) continue;
      const body = blogBodyOf(e.runId);
      const s = body ? endingSentenceOf(body) : '';
      if (s) endings.push(s);
      if (endings.length >= limit) break;
    }
    if (!endings.length) return '';
    return [
      '[최근 마무리 문단 첫 문장 — 같은 문형 금지]',
      ...endings.map((s, i) => `${i + 1}. "${s}"`),
      '위 문장들과 같은 문형·같은 첫 어절로 글을 닫지 마라 — 이번 글은 다른 방식으로 맺어라(장면으로 끝내기 / 조건문 / 판단 단정 / 독자가 오늘 볼 것 한 가지 중 위와 겹치지 않는 것).',
    ].join('\n');
  } catch { return ''; }
}
