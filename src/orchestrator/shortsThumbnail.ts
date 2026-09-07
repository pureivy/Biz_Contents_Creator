/**
 * 숏폼 디자인 썸네일 — 훅 씬(첫 장면)을 배경으로 그 위에 손글씨 제목+핵심을 gpt-image(edit)로 그려 넣은
 * '시선 끌기' 커버. 카드뉴스 handwritten_poster 와 동일 엔진(openai_image --allow-text, images.edit) 재사용.
 * best-effort — 키 없거나 실패하면 false 를 반환(호출부·엔드포인트가 영상 첫 프레임으로 폴백).
 * AI 가 한글을 그리므로 오타 위험 → 비전 QA 로 검수하고 1회 재생성으로 커버(카드뉴스와 동일 원리).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from '../config';
import { microJSON } from './agent';
import { stdModel, visionCapable } from './visionCommon';
import { generateImagesForDraft } from '../tools/blog_skills';

const execFileP = promisify(execFile);

export interface ThumbCopy { line1: string; line2: string; points: string[] }

/** 제목을 두 줄로 — 단어(공백) 경계에서만 분할(단어를 중간에서 쪼개지 않음). 단어 하나면 한 줄. 순수. */
export function splitTwoLines(t: string): { line1: string; line2: string } {
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { line1: t, line2: '' };
  const half = t.length / 2;
  let best = 1, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - half);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return { line1: words.slice(0, best).join(' '), line2: words.slice(best).join(' ') };
}
/** 설명에서 핵심 포인트 파생(순수) — 문장/구를 짧게 잘라 2~3개. LLM 이 points 를 비우거나 실패했을 때 폴백. */
export function derivePoints(desc: string): string[] {
  return (desc || '').split(/[.。!?\n·]/).map((s) => s.trim()).filter((s) => s.length >= 4 && s.length <= 22).slice(0, 3);
}

/** 카피에 핵심 키워드 보장(순수) — line1/line2 어디에도 정확 표기가 없으면 line1 을 키워드로 교체하고
 *  기존 문구는 훅(line2)으로 승계. LLM 재작성까지 실패했을 때의 결정적 마지노선(사용자 확정 2026-07-31). */
export function ensureKeywordInCopy(copy: ThumbCopy, keyword?: string): ThumbCopy {
  const kw = (keyword || '').trim();
  if (!kw || copy.line1.includes(kw) || copy.line2.includes(kw)) return copy;
  // 키워드는 자르지 않는 게 원칙(잘린 키워드가 그려지면 정확 표기 불변식이 조용히 깨짐) — 24자는 안전판.
  return { ...copy, line1: kw.slice(0, 24), line2: (copy.line2 || copy.line1).slice(0, 16) };
}

/** 썸네일 카피 — 키워드 라벨(line1)+훅(line2)의 2줄 위계 + 핵심 2~3줄. LLM 실패·누락 시 제목·설명에서 폴백.
 *  상단 제목 캘리(shortsTitleArt)와 공유 — 같은 카피를 먼저 만들어 양쪽에 넘기면 문구가 일치한다.
 *  keyword 는 정확 표기 필수: 프롬프트 요구 → 미포함 시 1회 재작성 → ensureKeywordInCopy 강제.
 *  배경(2026-07-31 실측): "각 줄 8자 이내" 제한이 8자 키워드("블루베리나무화분")와 충돌해 LLM 이 키워드를 버렸다. */
export async function planThumbnailCopy(input: { title: string; description: string; titles?: string[]; keyword?: string }, signal?: AbortSignal): Promise<ThumbCopy> {
  const kw = (input.keyword || '').trim();
  const fallback = (): ThumbCopy => {
    const t = (input.title || '').replace(/[,·].*$/, '').trim() || '숏폼';
    return ensureKeywordInCopy({ ...splitTwoLines(t), points: derivePoints(input.description) }, kw);
  };
  // line1 캡은 키워드 인지형(종전 12) — "정확 표기 그대로" 요구와 고정 캡이 자기모순이 되지 않게. 상한 24 안전판.
  const line1Cap = Math.min(24, Math.max(16, kw.length));
  try {
    let last: ThumbCopy | null = null;
    for (let attempt = 0; attempt < (kw ? 2 : 1); attempt++) {
      let j: { line1?: unknown; line2?: unknown; points?: unknown } | null = null;
      try {
        j = await microJSON<{ line1?: unknown; line2?: unknown; points?: unknown }>(
          stdModel(),
          '당신은 유튜브 숏폼 썸네일 카피라이터입니다. 요청 JSON 스키마만 출력합니다.',
          [
            `[제목] ${input.title}`,
            input.description ? `[설명] ${input.description}` : '',
            (input.titles && input.titles.length) ? `[제목 후보] ${input.titles.join(' / ')}` : '',
            '',
            '위 숏폼의 썸네일 문구를 만들어라.',
            kw
              ? `제목: 2줄 위계 구성. line1 = 핵심 키워드 '${kw}' 를 정확히 이 표기 그대로 담은 라벨 줄(가급적 키워드만 — 키워드가 길어도 자르거나 바꾸지 말 것). line2 = 시선을 확 끄는 훅 줄(8자 이내, 키워드 반복 금지). 절대 한 단어를 두 줄에 쪼개지 마라(단어는 통째로 한 줄).`
              : '제목: 시선을 확 끄는 2줄. 각 줄은 짧게(공백 포함 8자 이내), 두 줄 합쳐 핵심 메시지. 절대 한 단어를 두 줄에 쪼개지 마라(단어는 통째로 한 줄, 줄바꿈은 단어·어절 경계에서만).',
            '핵심 포인트: 반드시 2~3개. 각 14자 이내, 궁금증·이득 자극. 과장·낚시성 금지, 내용에 근거.',
            attempt ? `[재작성] 직전 출력에 핵심 키워드 '${kw}' 가 정확히 이 표기로 없었다 — line1 에 그대로 담아 다시 출력하라.` : '',
            'JSON: {"line1":"첫 줄","line2":"둘째 줄","points":["포인트1","포인트2","포인트3"]}',
          ].filter(Boolean).join('\n'),
          { maxOutputTokens: 400, signal },
        );
      } catch { continue; } // 시도별 격리(리뷰 지적) — 재작성 호출 실패가 직전 유효 카피(last)를 버리지 않게
      const line1 = String(j?.line1 ?? '').trim().slice(0, line1Cap);
      const line2 = String(j?.line2 ?? '').trim().slice(0, 16);
      if (!line1) continue;
      let points = (Array.isArray(j?.points) ? j.points : []).map((p) => String(p ?? '').trim().slice(0, 20)).filter(Boolean).slice(0, 3);
      if (!points.length) points = derivePoints(input.description); // LLM 이 포인트 누락 → 설명에서 보강(좌하단 빔 방지)
      last = { line1, line2, points };
      if (!kw || line1.includes(kw) || line2.includes(kw)) return last;
    }
    return last ? ensureKeywordInCopy(last, kw) : fallback();
  } catch { return fallback(); }
}

/** 카피 → gpt-image 프롬프트(실측 검증본). 지정 한국어만, 오타 없이. 순수 — export 는 테스트·샘플 렌더용. */
export function buildThumbnailPrompt(copy: ThumbCopy): string {
  const pts = copy.points.length ? copy.points.map((p) => `'${p}'`).join(', ') : '';
  // 서체 고정(사용자 확정 2026-07-30): 붓펜 캘리 — 획 끝·흘림이 살아있는 붓글씨. 크레용·색연필체로 흘러가는 것 방지.
  const titleLine = copy.line2
    ? `그 위에 굵은 한국어 붓펜 캘리그래피 제목을 정확히 2줄로 크게 배치한다: 1줄 '${copy.line1}' 는 크림 화이트, 2줄 '${copy.line2}' 는 선명한 노랑. 진짜 붓으로 쓴 붓글씨(획 끝이 갈라지고 흘림·삐침이 살아있는 획) — 크레용체·색연필체·둥근 마커체 금지. 밑줄 획 강조는 2줄(노랑) 아래에만 긋고 1줄(크림 화이트 라벨 줄) 아래에는 긋지 않는다. 각 줄은 지정한 그대로 한 줄에 넣고, 한 단어를 글자 중간에서 쪼개 다음 줄로 넘기지 않는다.`
    : `그 위에 굵은 한국어 붓펜 캘리그래피 제목 '${copy.line1}' 를 한 줄로 크게 배치한다(크림 화이트 바탕에 노랑 포인트, 진짜 붓으로 쓴 붓글씨 획에 밑줄 강조 — 크레용체·색연필체·둥근 마커체 금지). 단어를 글자 중간에서 쪼개지 않는다.`;
  return [
    '세로 유튜브/인스타 썸네일. 참조로 준 사진을 배경으로 그대로 사용하고, 상단 45%를 부드러운 검정 그라데이션으로 살짝 덮어 글자 가독성을 확보한다.',
    titleLine,
    pts ? `왼쪽 하단에는 작은 손글씨로 핵심 ${copy.points.length}줄: ${pts}. 밑줄과 동그라미로 포인트.` : '',
    '작은 손그림 낙서를 여백에만 소량(총 3~4개 이내) 추가한다: 기본 별·구름에 더해, 내용에 어울리는 소재 낙서(소재의 상징·물방울·햇살·하트)와 주목 낙서(화살표·반짝임·체크·느낌표) 중에서 2~3종을 골라 섞되, 각 낙서는 작게 그리고 글자를 가리거나 여백 밖으로 넘지 않게 한다. 밝고 생기있는 무드.',
    '레이아웃 여백(반드시 엄수): 화면 가장자리에서 좌우 각 13%, 상단 10%, 하단 16%를 완전히 비운 안전 영역 안에만 모든 글자를 넣는다. 제목의 첫 글자와 마지막 글자를 포함해 어떤 글자도 이 바깥 여백 띠에 닿거나 들어가면 안 된다. 특히 제목 둘째 줄이 길면 우측 여백을 침범하기 쉬우니, 그럴 땐 글자 크기를 확실히 줄여서라도 반드시 좌우 13% 안쪽에 맞춘다(여백이 글자 크기보다 절대 우선). 제목은 상단 안전 영역 안 가운데에, 핵심 문구는 좌측 하단 안전 영역 안에 배치하되, 맨 아래 문구와 그 밑줄·동그라미·별 장식까지 포함한 가장 낮은 지점 아래로 화면 높이의 16% 이상을 반드시 비운다(하단은 특히 덜 비워지기 쉬우니 글자·장식을 위로 확실히 끌어올려서라도 이 하단 16%를 최우선으로 지킨다). 별·구름 등 낙서·장식도 이 여백 띠를 넘지 않는다. 어떤 글자도 프레임 가장자리에 닿거나 잘리지 않게 한다.',
    '한글 맞춤법을 정확히 지키고 글자가 깨지거나 오타가 없게 한다. 지정한 한국어 텍스트만 사용하고 영어나 의미 없는 글자는 넣지 않는다.',
  ].filter(Boolean).join(' ');
}

/** 비전 QA 결과 — 통과 여부와, 깨진 것으로 보이는 '기대 문구 쪽 낱말'. */
export interface ThumbQaResult { ok: boolean; wrong: string[] }

/**
 * 비전 QA — 이미지의 한글이 기대 문구대로 정확한지. 비전 불가/판정 실패면 통과(파이프라인 차단 방지).
 *
 * 어느 낱말이 깨졌는지도 받는다(2026-09-06). 종전엔 불리언만 받아서, 같은 글자가 계속 깨져도
 * 같은 문구로 다시 뽑을 수밖에 없었다 — 실측으로 '짙은'이 네 번 연속 '질은'으로 나왔고
 * 재생성 3회가 전부 같은 자리에서 실패했다. 무엇이 깨졌는지 알아야 낱말을 바꿔 볼 수 있다.
 */
export async function qaKoreanText(imagePath: string, expected: string, signal?: AbortSignal): Promise<ThumbQaResult> {
  if (!visionCapable()) return { ok: true, wrong: [] };
  const j = await microJSON<{ ok?: boolean; wrong?: unknown }>(
    stdModel(),
    '당신은 한국어 텍스트 검수자입니다. JSON 만 출력합니다.',
    `이 썸네일 이미지에 그려진 한국어 글자에 오타·깨진 자소·이상한 글자가 있는지 판정하라. 기대 문구(순서 무관): ${expected}. 모두 정확하면 ok=true, 하나라도 깨졌으면 ok=false.`
    + ' ok=false 면 wrong 에 "기대 문구 쪽 낱말"을 그대로 적어라 — 이미지에 잘못 그려진 글자가 아니라, 원래 이렇게 나왔어야 하는 낱말이다.'
    + ' 예: 기대가 "짙은"인데 이미지에 "질은"이 그려졌으면 wrong=["짙은"].'
    + ' JSON: {"ok":false,"wrong":["짙은"]}',
    { maxOutputTokens: 200, signal, visionPaths: [imagePath] },
  ).catch(() => null);
  const ok = j?.ok !== false;
  const wrong = Array.isArray(j?.wrong)
    ? j.wrong.map((w) => String(w ?? '').trim()).filter((w) => w && w.length <= 20).slice(0, 5)
    : [];
  return { ok, wrong };
}

/**
 * 깨진 낱말을 뜻이 같은 다른 말로 바꾼다(순수 적용 — 무엇으로 바꿀지는 부르는 쪽이 정한다).
 *
 * 왜 낱말을 바꾸는가. 이미지 모델이 특정 글자를 못 그리는 것은 재시도로 안 풀린다. 같은 뜻을
 * 다른 글자로 적으면 한 번에 풀린다 — '짙은'을 '진한'으로 바꾸자 바로 통과했다(2026-09-06).
 *
 * points 만 바꾼다. line1 은 키워드 정확 표기가 걸려 있고(ensureKeywordInCopy), line2 는
 * 영상 상단 캘리와 같은 문구라 여기서 바꾸면 썸네일과 영상이 어긋난다.
 */
export function applyCopySwap(copy: ThumbCopy, swaps: ReadonlyMap<string, string>): ThumbCopy {
  if (!swaps.size) return copy;
  const fix = (t: string): string => {
    let out = String(t ?? '');
    for (const [from, to] of swaps) {
      const f = String(from ?? '').trim(); const v = String(to ?? '').trim();
      if (!f || !v || f === v) continue;
      out = out.split(f).join(v);
    }
    return out;
  };
  return { ...copy, points: copy.points.map(fix) };
}

/** 두 번 이상 깨진 낱말 — 한 번은 우연일 수 있지만 두 번은 그 글자를 못 그리는 것이다(순수). */
export function repeatedlyWrong(rounds: ReadonlyArray<readonly string[]>, min = 2): string[] {
  const n = new Map<string, number>();
  for (const r of rounds) for (const w of new Set(r)) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n.entries()].filter(([, c]) => c >= min).map(([w]) => w);
}

/**
 * 깨진 낱말의 동의어를 받는다(부수효과 — LLM). 실패하면 빈 표(종전 동작 유지).
 *
 * 바꿀 낱말만 준다 — 문장 전체를 다시 쓰게 하면 뜻이 흘러간다. 실측 사례에서 필요한 것은
 * '짙은 → 진한' 한 쌍뿐이었다.
 */
export async function planCopySwap(wrong: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = wrong.map((w) => String(w ?? '').trim()).filter(Boolean).slice(0, 5);
  if (!list.length) return out;
  const j = await microJSON<{ swaps?: Array<{ from?: unknown; to?: unknown }> }>(
    stdModel(),
    '당신은 한국어 카피라이터입니다. JSON 만 출력합니다.',
    [
      '이미지 생성 모델이 아래 낱말의 글자를 자꾸 깨뜨려 그린다. 뜻이 같으면서 글자가 다른 말로 바꿔라.',
      `낱말: ${list.join(', ')}`,
      '규칙: 뜻이 바뀌면 안 된다. 원래 낱말에 있던 글자를 다시 쓰지 마라. 더 흔하고 쉬운 말을 골라라.',
      '바꿀 만한 말이 없으면 그 낱말은 목록에서 빼라(억지로 바꾸지 마라).',
      '예: {"swaps":[{"from":"짙은","to":"진한"}]}',
      'JSON: {"swaps":[{"from":"원래말","to":"바꿀말"}]}',
    ].join('\n'),
    { maxOutputTokens: 300, signal },
  ).catch(() => null);
  for (const sw of j?.swaps ?? []) {
    const from = String(sw?.from ?? '').trim();
    const to = String(sw?.to ?? '').trim();
    if (!from || !to || from === to || to.length > 20) continue;
    if (!list.includes(from)) continue; // 묻지 않은 낱말은 안 바꾼다
    out.set(from, to);
  }
  return out;
}

/** png → dir/thumbnail.jpg 변환(ffmpeg) — 임시파일에 쓰고 원자적 rename(찢긴 JPEG·부분 기록 방지). */
async function toThumbnailJpg(pngPath: string, dir: string, signal?: AbortSignal): Promise<void> {
  const tmp = path.join(dir, `.thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  await execFileP('ffmpeg', ['-nostdin', '-y', '-i', pngPath, '-q:v', '3', tmp], { timeout: 20_000, signal });
  fs.renameSync(tmp, path.join(dir, 'thumbnail.jpg')); // 같은 파일시스템 → 원자적 교체
}

/** 매니페스트 첫 이미지 — 슬롯 error(생성 실패)면 남아있는 stale 파일이라도 무시(형제 shorts.ts 가드와 동일).
 *  shortsTitleArt 와 공유. */
export function manifestFirstImage(manifestPath: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { images?: Array<{ file_path?: string; error?: unknown }> };
    const im = m.images?.[0];
    if (!im || im.error) return null;
    return im.file_path && fs.existsSync(im.file_path) ? im.file_path : null;
  } catch { return null; }
}

/**
 * 훅 씬 배경 위에 디자인 썸네일 생성 → dir/thumbnail.jpg. 성공 true / 폴백해야 하면 false.
 * hookImage 없거나 키 없으면 false(영상 프레임 폴백). QA 2회 실패 시 마지막 생성본 사용(디자인 우선 방침).
 * 작업물은 실행별 고유 디렉터리(.thumb/<run>)에 격리하고 종료 시 정리 — 동시 실행·stale 재사용 방지. 어떤 예외도 밖으로 던지지 않음(폴백 유도).
 */
/** 썸네일 한글 QA 미해결 표식 파일명 — 발행 게이트가 소비한다(아티팩트와 함께 남아 재시작에도 살아남음). */
export const THUMB_QA_MARKER = 'thumb-qa-failed.json';
/** 이 쇼츠의 썸네일이 한글 QA 를 못 넘긴 채 발행 대기 중인가(순수 판독). */
export function thumbTextQaFailed(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, THUMB_QA_MARKER)); } catch { return false; }
}
/** 표식 제거 — 재생성이 QA 를 통과했을 때. 없으면 무해. */
function clearThumbQaMarker(dir: string): void {
  try { fs.rmSync(path.join(dir, THUMB_QA_MARKER), { force: true }); } catch { /* 무해 */ }
}

export async function generateDesignedThumbnail(input: {
  dir: string; title: string; description: string; titles?: string[]; hookImage: string | null; signal?: AbortSignal;
  /** 핵심 키워드(정확 표기) — copy 미제공 시 planThumbnailCopy 가 line1 라벨로 강제한다. */
  keyword?: string;
  /** 미리 만든 카피(상단 제목 캘리와 공유) — 주면 LLM 호출 생략, 영상 제목과 문구 일치 보장. */
  copy?: ThumbCopy;
}): Promise<boolean> {
  if (!CONFIG.openaiApiKey) return false;
  if (!input.hookImage || !fs.existsSync(input.hookImage)) return false;
  const work = path.join(input.dir, '.thumb', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.mkdirSync(work, { recursive: true });
    let copy = input.copy ?? await planThumbnailCopy(input, input.signal);
    const draftPath = path.join(work, 'draft.json');
    // 회차마다 다시 쓴다 — 낱말을 바꾸면 프롬프트도 기대 문구도 같이 바뀌어야 한다.
    let expected = '';
    const writeDraft = (): void => {
      expected = [copy.line1, copy.line2, ...copy.points].filter(Boolean).join(' / ');
      fs.writeFileSync(draftPath, JSON.stringify({ topic: copy.line1, imageSlots: [{ alt: '썸네일', prompt: buildThumbnailPrompt(copy) }] }), 'utf-8');
    };
    writeDraft();

    let lastPng: string | null = null;
    const wrongRounds: string[][] = []; // 회차별로 어느 낱말이 깨졌나 — 반복되면 그 글자를 못 그리는 것이다
    let swapped = false;                // 낱말 교체는 한 번만 — 계속 바꾸면 문구가 흘러간다
    // 3회로 늘림(2026-09-03) — 한글 자소 깨짐은 흔한 실패라 한 번 더 뽑는 값이 오타 발행보다 싸다.
    // 실측(short_5b5f7f4231): 썸네일이 "줄자로"를 "좔자로"로 냈고 2회 모두 QA 를 못 넘겼다.
    for (let attempt = 0; attempt < 3; attempt++) {
      const outDir = path.join(work, `out${attempt}`);
      const manifest = path.join(work, `m${attempt}.json`);
      try {
        await generateImagesForDraft(draftPath, outDir, manifest,
          { imageStyle: 'photorealistic', allowText: true, size: '1024x1536', limit: 1, refImages: [input.hookImage], topic: copy.line1, timeoutMs: 150_000 },
          input.signal);
      } catch { continue; } // 이 시도 실패 → 다음 시도(또는 폴백)
      const png = manifestFirstImage(manifest); // 실패 슬롯이면 null → 이 시도 이미지 안 씀
      if (!png) continue;
      lastPng = png;
      const qa = await qaKoreanText(png, expected, input.signal);
      if (qa.ok) {
        await toThumbnailJpg(png, input.dir, input.signal);
        clearThumbQaMarker(input.dir); // 재생성이 통과했으면 발행 게이트를 연다
        return true;
      }
      wrongRounds.push([...qa.wrong]);
      console.log('[숏폼]', `썸네일 한글 QA 불합격 — ${attempt + 1}/3회차 재생성${qa.wrong.length ? ` (${qa.wrong.join('·')})` : ''}`);
      // 같은 낱말이 두 번 깨졌으면 재시도로는 안 풀린다 — 뜻이 같은 다른 말로 바꾼다(2026-09-06).
      // 실측: '짙은'이 네 번 연속 '질은'으로 나왔고, '진한'으로 바꾸자 한 번에 통과했다.
      if (!swapped) {
        const stuck = repeatedlyWrong(wrongRounds);
        if (stuck.length) {
          const swaps = await planCopySwap(stuck, input.signal);
          const next = applyCopySwap(copy, swaps);
          if (JSON.stringify(next.points) !== JSON.stringify(copy.points)) {
            copy = next;
            swapped = true;
            writeDraft();
            console.log('[숏폼]', `썸네일 문구 교체 — ${[...swaps].map(([f, t]) => `${f}→${t}`).join(', ')} (모델이 못 그리는 글자)`);
          }
        }
      }
    }
    if (lastPng) {
      // QA 를 못 넘겨도 디자인본을 쓴다(영상 프레임 폴백보다 낫다는 방침). 다만 조용히 나가면 안 된다 —
      // 종전엔 로그가 한 줄도 없어서, 오타가 박힌 썸네일이 발행될 때까지 아무도 몰랐다(실측 2026-09-03).
      console.log('[숏폼]', `⚠ 썸네일 한글 QA 3회 실패 — 오타 가능성 있는 이미지로 발행됩니다. 발행 전 눈으로 확인하세요: ${path.join(input.dir, 'thumbnail.jpg')}`);
      await toThumbnailJpg(lastPng, input.dir, input.signal);
      try { fs.writeFileSync(path.join(input.dir, THUMB_QA_MARKER), JSON.stringify({ expected, at: new Date().toISOString() }, null, 2), 'utf-8'); } catch { /* 표식 실패는 무해 */ }
      return true;
    }
    return false;
  } catch { return false; } // 어떤 실패도 밖으로 던지지 않음 — 호출부(완성부·엔드포인트)는 프레임 폴백
  finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 정리 실패 무해 */ } }
}
