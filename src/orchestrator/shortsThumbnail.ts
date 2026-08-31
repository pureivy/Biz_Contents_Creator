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
    '작은 손그림 낙서를 여백에만 소량(총 3~4개 이내) 추가한다: 기본 별·구름에 더해, 내용에 어울리는 원예 낙서(잎·새싹·물방울·햇살·작은 꽃·하트)와 주목 낙서(화살표·반짝임·체크·느낌표) 중에서 2~3종을 골라 섞되, 각 낙서는 작게 그리고 글자를 가리거나 여백 밖으로 넘지 않게 한다. 밝고 생기있는 무드.',
    '레이아웃 여백(반드시 엄수): 화면 가장자리에서 좌우 각 13%, 상단 10%, 하단 16%를 완전히 비운 안전 영역 안에만 모든 글자를 넣는다. 제목의 첫 글자와 마지막 글자를 포함해 어떤 글자도 이 바깥 여백 띠에 닿거나 들어가면 안 된다. 특히 제목 둘째 줄이 길면 우측 여백을 침범하기 쉬우니, 그럴 땐 글자 크기를 확실히 줄여서라도 반드시 좌우 13% 안쪽에 맞춘다(여백이 글자 크기보다 절대 우선). 제목은 상단 안전 영역 안 가운데에, 핵심 문구는 좌측 하단 안전 영역 안에 배치하되, 맨 아래 문구와 그 밑줄·동그라미·별 장식까지 포함한 가장 낮은 지점 아래로 화면 높이의 16% 이상을 반드시 비운다(하단은 특히 덜 비워지기 쉬우니 글자·장식을 위로 확실히 끌어올려서라도 이 하단 16%를 최우선으로 지킨다). 별·구름 등 낙서·장식도 이 여백 띠를 넘지 않는다. 어떤 글자도 프레임 가장자리에 닿거나 잘리지 않게 한다.',
    '한글 맞춤법을 정확히 지키고 글자가 깨지거나 오타가 없게 한다. 지정한 한국어 텍스트만 사용하고 영어나 의미 없는 글자는 넣지 않는다.',
  ].filter(Boolean).join(' ');
}

/** 비전 QA — 이미지의 한글이 기대 문구대로 정확한지. 비전 불가/판정 실패면 통과(파이프라인 차단 방지). */
export async function qaKoreanText(imagePath: string, expected: string, signal?: AbortSignal): Promise<boolean> {
  if (!visionCapable()) return true;
  const j = await microJSON<{ ok?: boolean }>(
    stdModel(),
    '당신은 한국어 텍스트 검수자입니다. JSON 만 출력합니다.',
    `이 썸네일 이미지에 그려진 한국어 글자에 오타·깨진 자소·이상한 글자가 있는지 판정하라. 기대 문구(순서 무관): ${expected}. 모두 정확하면 ok=true, 하나라도 깨졌으면 ok=false. JSON: {"ok":true}`,
    { maxOutputTokens: 150, signal, visionPaths: [imagePath] },
  ).catch(() => null);
  return j?.ok !== false;
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
    const copy = input.copy ?? await planThumbnailCopy(input, input.signal);
    const prompt = buildThumbnailPrompt(copy);
    const expected = [copy.line1, copy.line2, ...copy.points].filter(Boolean).join(' / ');
    const draftPath = path.join(work, 'draft.json');
    fs.writeFileSync(draftPath, JSON.stringify({ topic: copy.line1, imageSlots: [{ alt: '썸네일', prompt }] }), 'utf-8');

    let lastPng: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
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
      if (await qaKoreanText(png, expected, input.signal)) { await toThumbnailJpg(png, input.dir, input.signal); return true; }
    }
    if (lastPng) { await toThumbnailJpg(lastPng, input.dir, input.signal); return true; } // QA 못 넘겨도 디자인본 우선
    return false;
  } catch { return false; } // 어떤 실패도 밖으로 던지지 않음 — 호출부(완성부·엔드포인트)는 프레임 폴백
  finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 정리 실패 무해 */ } }
}
