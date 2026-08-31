/**
 * 네이버 블로그 포매터 — org 본문을 발행용 초안(제목·메타·태그·이미지 슬롯·SEO 점수)으로 포장.
 * 본문은 생성하지 않는다(작가가 이미 씀). 구조작업(제목/메타/태그/이미지 프롬프트)만 microJSON 1콜.
 */
import { microJSON } from '../orchestrator/agent';
import { firstJson } from '../tools/classify';
import { asString } from '../util/str';
import { seedKeyword } from '../grounding/naver_common';
import { scoreSeo } from './seo';
import { renderMarkdown, renderHtml, stripEmoji } from './render';
import { registerFormatter } from './formatter';
import { brandContext, getBrand, lexiconGuide } from '../content/brand';
import { metaSummaryIssues } from '../content/styleLint';
import { CONFIG } from '../config';
import { seasonalContext } from '../util/solarTerms';
import type { AssetBundle, BlogDraft, FormatterInput } from './formatter';

const PACK_SYSTEM =
  '너는 네이버 블로그 SEO 편집자다. 주어진 블로그 본문을 바탕으로 발행용 메타데이터를 만든다.\n' +
  '- primaryKeyword: 이 글의 핵심 타겟 키워드 1개(검색량 있을 법한 명사구).\n' +
  '- titles: 검색 노출에 유리한 제목 후보 5개. 핵심 키워드를 앞쪽에 자연스럽게, 15~40자, 클릭 유도. 과장·낚시 금지. 사전에 없는 조어를 만들지 마라(실측 유출: "첫 식재자들" — "처음 심는 분들"처럼 일상어로).\n' +
  '  [네이버 상위 노출 제목]이 주어지면 실제 상위 글들의 제목 패턴(구체 수치·대상·상황 명시)을 참고하되 그대로 베끼지 마라.\n' +
  // 절기 병기(2026-08-07 사용자 승인) — 실측상 절기 합성 키워드는 월 10미만이라 SEO 타겟은 불가하지만,
  // 제목 병기는 검색결과에서 "지금 안 하면 늦는다" 시의성 훅(CTR)이 된다. 키워드 대체 금지·선택 적용.
  '  [오늘·절기]가 주어지고 주제가 현재·다가오는 절기와 시기적으로 맞물리면, 제목 후보 1~2개에 절기명을 자연스럽게 병기하라(예: "…, 처서 전에 끝내야 하는 이유"). 핵심 키워드 표기를 절기로 대체하지 말고, 시기가 안 맞으면 넣지 마라.\n' +
  '- meta: 100~200자 요약(검색 스니펫용). 핵심 키워드 포함, 글의 이득을 한 문장으로.\n' +
  '  메타 요약투 금지 — "정리했습니다/담았어요/알아봅니다/알아보세요/살펴봅니다/소개합니다" 로 끝내지 말고 "결론 한 줄 + 조건 한 줄" 꼴로 써라(예: "잎이 상한 나무는 9월에 비료를 줘도 소용없습니다. 갈변이 어디서 시작됐는지부터 보세요.").\n' +
  '- tags: 5~10개(핵심·연관 키워드, # 없이). 띄어쓰기 없이 붙여쓴다("카페창업" O, "카페 창업" X). 본문과 무관한 태그 금지.\n' +
  '- images: 본문 흐름에 맞는 이미지 3개 슬롯. alt(대체텍스트)와 prompt(이미지 생성 프롬프트, 한국어).\n' +
  '이모지·이모티콘·장식 특수문자는 제목·메타·태그 어디에도 쓰지 마라. 본문에 없는 사실을 지어내지 마라.';

/** 작가가 본문 끝에 남기는 태그류 제거(순수) — ① "태그: #…" 줄(종전) ② 맨 키워드 나열
 *  (구두점 없는 4+ 토큰 한 줄, 실측 2026-08-10: "포도나무수확시기 … 비온디트리"가 본문으로 발행됨).
 *  태그는 발행 시 별도 필드로 입력되므로 본문 노출은 순수 중복+키워드 덤프(스팸 신호)다.
 *  정상 마무리 문단은 구두점(마침표·쉼표 등)을 포함하므로 걸리지 않는다. */
export function stripTrailingTagDump(body: string): string {
  return body
    .replace(/\n+\s*(?:\*\*)?태그(?:\*\*)?\s*[:：][^\n]*$/u, '')
    .replace(/\n+\s*(?:[가-힣A-Za-z0-9]{2,20}[ \t]+){3,}[가-힣A-Za-z0-9]{2,20}[ \t]*$/u, '')
    .trimEnd();
}

/** 발행 초안에서 내부 표식 제거(순수, 스펙 §6c) — 감사 실측: "[근거: 확립된 원예학 지식]"·"⚠️ 데이터 없음:" 이 그대로 발행됐다.
 *  인라인 표식은 문장부호(.!?) 또는 괄호에서 소비를 멈춘다 — 안 그러면 뒤따르는 문장까지 삼켜 내용이 유실된다(리뷰 라운드 1). */
export function stripInternalMarkers(md: string): string {
  return md
    // stripEmoji 가 먼저 돌아 ⚠️ 가 이미 지워졌을 수 있다 — 이모지는 통째로 선택(optional group).
    // 공백은 그룹 '안'에 둔다: 종전 `(?:⚠️?)?\s*` 는 앞뒤 \s* 사이에 선택 그룹이 끼어 "긴 공백 +
    // 비매칭"에서 지수 백트래킹을 일으켰다(실측: 공백 3000자 → 6.0초). stripEmoji 가 ⚠ 자체를
    // Extended_Pictographic 로 지우므로 VS16 없는 맨 ⚠ 는 여기 도달하지 않는다(실측 확인).
    .replace(/^[ \t]*(?:[-*]\s*)?(?:⚠️\s*)?데이터 없음\s*[:：][^\n]*\n?/gmu, '')
    .replace(/\s*(?:⚠️\s*)?데이터 없음\s*[:：][^\n().!?]*(?:\([^)]*\))?/gu, '')
    .replace(/\s*\[\s*근거\s*[:：]\s*([^\]]*)\]/gu, (_m, inner: string) => {
      const url = /https?:\/\/[^\s\]]+/.exec(inner)?.[0];
      return url ? ` (출처: ${url})` : '';
    })
    .replace(/[ \t]+([.,!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n');
}

export async function packageNaverBlog(input: FormatterInput): Promise<AssetBundle> {
  const { topic, researchBrief, serpText, model, signal } = input;
  const pinnedKeyword = stripEmoji(asString(input.keyword).trim());
  // 이모지 결정적 제거 — 지침(작가·편집자 프롬프트)이 1차 방어, 여기가 최종 보증(발행 초안엔 이모지 0).
  const body = stripInternalMarkers(stripTrailingTagDump(stripEmoji(input.body)));
  type PackMeta = {
    primaryKeyword?: string; titles?: unknown; meta?: string; tags?: unknown;
    images?: Array<{ alt?: string; prompt?: string }>;
  };
  // 지연 조립 — meta 요약투 재시도(권고 2)는 같은 프롬프트에 피드백만 덧붙여 다시 부른다. 함수로 두는 이유는
  // 조립부(seasonalContext·brandContext·getBrand·lexiconGuide)가 던져도 호출부 try 안에서 터지게 하기 위해서다:
  // 문 수준에서 조립하면 종전에 fail-open(meta=null 폴백)이던 실패가 포장 전체를 죽인다.
  const packUser = () =>
      `[주제] ${topic}\n\n[오늘·절기] ${seasonalContext()}\n\n[본문]\n${body.slice(0, 6000)}\n` +
      // SEO 포장도 microJSON 직행 — 브랜드 설정 시 태그·메타에 브랜드 연관 키워드가 자연스럽게 실리게.
      (brandContext() ? `\n${brandContext()}\n` : '') +
      `\n${lexiconGuide(getBrand()?.avoidJargon, getBrand()?.keepTerms)}\n` + // 어휘 가드(2026-08-08) — 제목·메타·태그의 함정어·조어 방지
      (pinnedKeyword ? `\n[핵심 키워드(고정)] ${pinnedKeyword} — primaryKeyword 는 정확히 이 값으로 쓰고, titles 5개 중 4개 이상과 meta 에 이 표기를 그대로 포함하라.\n` : '') +
      (serpText ? `\n[네이버 상위 노출 제목(실측)]\n${serpText.slice(0, 800)}\n` : '') +
      `${researchBrief ? `\n[리서치·SEO 브리프]\n${researchBrief.slice(0, 1500)}` : ''}\n\n` +
      `형식: {"primaryKeyword":"...","titles":["...","...","...","...","..."],"meta":"...","tags":["...","..."],"images":[{"alt":"...","prompt":"..."}]}`;
  const askPack = (feedback: string) => microJSON<PackMeta>(model, PACK_SYSTEM, packUser() + feedback, { maxOutputTokens: 900, signal });
  let meta: PackMeta | null = null;
  try { meta = await askPack(''); } catch { /* 포장 실패 시 폴백 아래 */ }

  // 요약투 린트 + 같은 콜 1회 재시도(2026-08-27 권고 2). 검사는 '실제로 실릴' 문자열(이모지 제거·200자 절단
  // 뒤)에 건다 — 원본 필드를 보면 린트와 발행물이 갈라지고 잔존 로그가 다른 문장을 인용하게 된다.
  // 재시도가 깨끗할 때 갈아끼우는 것은 meta 뿐이다: 제목 후보·태그는 자기 제약(15~40자·키워드 4/5 포함·
  // 조어 금지)이 따로 있어 meta 표적 재생성이 통째로 덮으면 통제 못 하는 드리프트가 된다.
  // META_SUMMARY_LINT 게이트(Fix wave 2026-08-27 소견 4) — 이 검사가 만드는 2번째 askPack 콜만
  // 되돌릴 레버가 없었다(계획서 Global Constraints: 모든 새 동작에 킬스위치). off 면 검사 자체를 건너뛴다.
  const metaText = (m: PackMeta | null): string => stripEmoji(asString(m?.meta)).trim().slice(0, 200);
  let metaDescription = metaText(meta);
  const metaIssues = CONFIG.metaSummaryLint ? metaSummaryIssues(metaDescription) : [];
  if (metaIssues.length) {
    try {
      const retry = await askPack(
        `\n\n[meta 재작성 — 아래 지적만 고쳐 같은 JSON 스키마로 다시 출력하라(다른 필드는 그대로 둬도 된다)]\n`
        + metaIssues.map((i) => `- ${i}`).join('\n'),
      );
      const fixed = metaText(retry);
      if (fixed && !metaSummaryIssues(fixed).length) metaDescription = fixed;
    } catch { /* 재시도 실패 = 1차 meta 유지(fail-open — 포장은 계속 간다) */ }
    // 잔존은 로그만 — 발행을 막지 않는다(린트 공통 원칙).
    if (metaSummaryIssues(metaDescription).length) console.log(`[메타] 요약투 잔존 — "${metaDescription.slice(0, 60)}"`);
  }

  // 고정 키워드 우선 — LLM 재추출값은 고정이 없을 때만(과녁 고정: 검사기·리비전 피드백·제목이 같은 표기를 본다).
  const primaryKeyword = pinnedKeyword || stripEmoji(asString(meta?.primaryKeyword).trim() || seedKeyword(topic));
  const titles = (Array.isArray(meta?.titles) ? meta!.titles as unknown[] : [])
    .map((t) => stripEmoji(asString(t)).trim()).filter(Boolean).slice(0, 5);
  const titleCandidates = titles.length ? titles : [topic];
  const tags = (Array.isArray(meta?.tags) ? meta!.tags as unknown[] : [])
    .map((t) => stripEmoji(asString(t)).replace(/^#/, '').trim()).filter(Boolean).slice(0, 10);
  const imageSlots = (meta?.images ?? [])
    .map((im) => ({ alt: stripEmoji(asString(im?.alt)).trim(), prompt: asString(im?.prompt).trim() }))
    .filter((im) => im.alt || im.prompt).slice(0, 3); // 이미지 실생성 한도(3장)와 일치 — 미생성 파일 참조 방지
  const internalLinks = input.internalLinks ?? [];

  const seo = scoreSeo({ title: titleCandidates[0] ?? topic, body, primaryKeyword, tags, imageSlots: imageSlots.length });
  const draft: BlogDraft = { topic, primaryKeyword, titleCandidates, metaDescription, tags, imageSlots, internalLinks, bodyMarkdown: body, seo };

  return {
    platform: 'naver_blog',
    files: draftFiles(draft),
    meta: { title: titleCandidates[0], titleCandidates, seoScore: seo.score, tags, primaryKeyword },
    draft,
  };
}

/**
 * 초안 → 세션 파일 목록(draft.json/md/html + image-prompts.md). 슬롯이 갱신되면(디자이너 협의) 재호출해 동기화.
 * imagesReady=true 면 draft.html 이 세션 images/blog-image-0N.png 를 <img> 로 참조(이미지 실생성 런).
 */
export function draftFiles(draft: BlogDraft, imagesReady = false): Array<{ name: string; content: string }> {
  const files = [
    { name: 'draft.json', content: JSON.stringify(draft, null, 2) },
    { name: 'draft.md', content: renderMarkdown(draft) },
    { name: 'draft.html', content: renderHtml(draft, { imagesReady }) },
  ];
  if (draft.imageSlots.length) {
    files.push({ name: 'image-prompts.md', content: draft.imageSlots.map((s, i) => `${i + 1}. **${s.alt}**\n   ${s.prompt}`).join('\n\n') });
  }
  return files;
}

/**
 * 이미지 디자이너의 계획 텍스트 → 이미지 슬롯(alt/prompt). 자유 서술 뒤 JSON 한 줄
 * ({"images":[{"alt","prompt"}]}) 을 firstJson 으로 추출, alt·prompt 둘 다 있는 항목만 최대 max.
 * 실패/빈 계획이면 [] — 호출부가 기존 슬롯을 유지(fail-open). 순수 함수 — 단위 테스트 대상.
 */
export function parseImagePlan(text: string, max = 3): Array<{ alt: string; prompt: string }> {
  const j = firstJson<{ images?: Array<{ alt?: unknown; prompt?: unknown }> }>(text ?? '');
  const arr = Array.isArray(j?.images) ? j!.images : [];
  return arr
    .map((im) => ({ alt: asString(im?.alt).trim(), prompt: asString(im?.prompt).trim() }))
    .filter((im) => im.alt && im.prompt)
    .slice(0, Math.max(1, max));
}

registerFormatter('naver_blog', packageNaverBlog);
