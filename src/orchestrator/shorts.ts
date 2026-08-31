/**
 * 숏폼 파이프라인 — 숏폼팀(standby)이 전담하는 전용 경로. 블로그 org 런과 무관.
 *
 * 기획(shorts_writer LLM: 훅·씬·내레이션·화면텍스트·제목3·해시태그) → 디자인(shorts_director
 * LLM: 씬별 세로 비주얼 프롬프트) → 씬 이미지(gpt-image-2, 1024×1536 세로·무텍스트) →
 * 조립(shortsRender: Pillow 자막 프레임 + TTS 내레이션 + ffmpeg 1080×1920 MP4).
 *
 * 실행 모델: 카드뉴스와 동일 — 서버가 launch 래퍼로 런 등록(오피스 뷰 연동), 프론트는 GET 폴링.
 * 직원 프롬프트는 회사 로스터(company.yaml)의 system_prompt 를 그대로 사용.
 */
import fs from 'node:fs';
import { SELLER_INQUIRY_BAN, NO_FABRICATED_EXPERIENCE } from './org';
import { lexiconGuide } from '../content/brand';
import path from 'node:path';
import { CONFIG } from '../config';
import { microJSON, runAgent, extractFirstJson } from './agent';
import { getCompany } from '../agents/company-loader';
import { rolesById } from '../agents/company';
import { stripEmoji } from '../output/render';
import { shortsStore } from '../content/shorts';
import { notifyShortsReady } from '../autonomy/contentNotify';
import { generateImagesForDraft } from '../tools/blog_skills';
import { qaSceneImages } from './shortsSceneQa';
import { qaSceneClips } from './shortsClipQa';
import { standaloneIssues, parityIssues, parityToInfo } from './standaloneQa';
import { timingParityIssues, formatTimingIssue, stripUnsourcedStatOverlays } from '../content/timingParity';
import type { FactGateInfo } from '../content/factGate';
import { narrationStyleIssues, hookKeywordLeadIssues, metaSummaryIssues, screenTextLabelIssues, monthWordOutsideNarration } from '../content/styleLint';
import { promiseStore } from '../content/promises';
import { currentStructureSeed } from '../content/structureSeed';
import { i2vSceneClips, i2vGate } from './shortsSceneClips';
import { directSceneMotion, detectSubjectScenes, selectI2vScenes } from './shortsMotionDirector';
import { renderShortsVideo, ensureShortsDownload, extractFirstFrame } from '../tools/shortsRender';
import { renderShortsVideoRemotion } from '../tools/shortsRenderRemotion';
import { generateDesignedThumbnail, type ThumbCopy } from './shortsThumbnail';
import { generateTitleArt } from './shortsTitleArt';
import { uploadShortsToYoutube } from '../tools/youtubeUpload';
import { blogUrlForPiece } from '../content/pieces';
import { brandContext, getBrand } from '../content/brand';
import { priorCoverageBrief, recentPhrasesToAvoid, OVERUSED_LEXEME_GUIDE } from '../content/priorCoverage';
import type { ShortsScene } from '../tools/shortsRender';
import { normalizeSceneKind, fixMonthNames, cutAtWordBoundary } from '../tools/shortsCommon';
import { inheritedClaims, formatInherited } from '../content/inheritedClaims';
import { classifyTitleType } from '../analytics/titleTiming';
import type { EventBus } from '../events/bus';

const RUNNING = new Set<string>();
export function isShortsRunning(id: string): boolean { return RUNNING.has(id); }

const PRESETS = new Set(['photorealistic', 'manhwa', 'watercolor', 'ink_wash', 'flat_design', 'retro_poster']);
const PRESET_ALIAS: Record<string, string> = {
  '사진풍': 'photorealistic', '수채화풍': 'watercolor', '플랫 일러스트': 'flat_design', '만화풍': 'manhwa',
};

const stdModel = (): string => CONFIG.cloudTierModels.standard;

interface Plan {
  title: string;
  titles: string[];
  scenes: ShortsScene[];
  description: string;
  hashtags: string[];
  /** 다음 편 예고 — CTA 에 예고를 넣었을 때만 작가가 선언(예고 대장 등록 → 자율 틱이 시기 도래 시 이행). */
  next?: { topic: string; window?: string };
  /** 원문 정합 잔존(스펙 §2-4) — 정합 문제로 수정 라운드를 돌았을 때만 재판정해 채운다. 표시 전용. */
  factGate?: FactGateInfo;
}

interface JobIO { bus?: EventBus; signal?: AbortSignal }

/** 수정 요청(자유 피드백) 개정안 — LLM 이 '바뀐 것만' 돌려준다. 적용은 applyShortsRevision(순수)이 검증. */
export interface ShortsRevision {
  title?: unknown; description?: unknown; hashtags?: unknown;
  scenes?: Array<{ index?: unknown; narration?: unknown; screenText?: unknown; regen_image?: unknown; image_note?: unknown; quote?: { text?: unknown; source?: unknown } | null } | null>;
  /** 상단 캘리 문구(영상 오버레이·썸네일 공용 카피, title-copy.json) — 바뀔 때만. */
  titleArt?: { line1?: unknown; line2?: unknown; points?: unknown } | null;
}

/** 개정안 적용(순수, 테스트 대상) — 번호 범위·빈 문자열·길이 상한 검증, 유효 변경 없으면 null.
 *  regen_image 로 표시된 씬만 배경 이미지를 다시 그린다(내레이션·자막만 바뀌면 재조립만으로 충분).
 *  titleCopy(현 캘리 카피)가 주어지면 titleArt 문구 변경도 검증한다 — 없으면 titleArt 는 무시. */
export function applyShortsRevision(
  plan: Plan, cand: ShortsRevision | null,
  titleCopy?: { line1: string; line2: string; points?: string[] } | null,
): { plan: Plan; changedScenes: number[]; regenScenes: number[]; imageNotes: Map<number, string>; titleChanged: boolean; metaChanged: boolean; titleArtCopy: { line1: string; line2: string; points: string[] } | null } | null {
  if (!cand) return null;
  const out: Plan = { ...plan, scenes: plan.scenes.map((s) => ({ ...s })) };
  const changed: number[] = []; const regen: number[] = [];
  const imageNotes = new Map<number, string>();
  let titleChanged = false; let metaChanged = false;
  const str = (v: unknown, max: number): string => {
    const s = typeof v === 'string' ? stripEmoji(v).trim() : '';
    return s && s.length <= max ? s : '';
  };
  for (const s of cand.scenes ?? []) {
    const idx = typeof s?.index === 'number' && Number.isInteger(s.index) ? s.index : 0; // 1-base
    if (idx < 1 || idx > plan.scenes.length) continue;
    const narration = str(s?.narration, 240);
    const screenText = str(s?.screenText, 60);
    const wantRegen = s?.regen_image === true;
    // quote 편집은 kind='quote' 씬에만 허용 — 다른 씬에 quote 를 보내도 무시(§6a).
    const q = s?.quote && typeof s.quote === 'object' ? s.quote as { text?: unknown; source?: unknown } : null;
    const curScene = out.scenes[idx - 1]!;
    const quoteText = curScene.kind === 'quote' && q ? str(q.text, 40) : '';
    const quoteSource = curScene.kind === 'quote' && q ? cutAtWordBoundary(str(q.source, 60), 15) : '';
    if (!narration && !screenText && !wantRegen && !quoteText && !quoteSource) continue;
    const cur = curScene;
    const next = {
      ...cur,
      ...(narration ? { narration } : {}),
      ...(screenText ? { screenText } : {}),
      ...(quoteText || quoteSource
        ? { quote: { text: quoteText || cur.quote?.text || '', ...(quoteSource ? { source: quoteSource } : (cur.quote?.source ? { source: cur.quote.source } : {})) } }
        : {}),
    };
    const textChanged = next.narration !== cur.narration || next.screenText !== cur.screenText || JSON.stringify(next.quote) !== JSON.stringify(cur.quote);
    if (textChanged) { out.scenes[idx - 1] = next; changed.push(idx); }
    if (wantRegen) {
      regen.push(idx);
      if (!textChanged) changed.push(idx);
      const note = str(s?.image_note, 200);
      if (note) imageNotes.set(idx, note);
    }
  }
  const title = str(cand.title, 60);
  if (title && title !== plan.title) { out.title = title; titleChanged = true; }
  const description = str(cand.description, 600);
  if (description && description !== plan.description) { out.description = description; metaChanged = true; }
  if (Array.isArray(cand.hashtags)) {
    const tags = cand.hashtags.filter((t): t is string => typeof t === 'string' && !!t.trim())
      .map((t) => (t.trim().startsWith('#') ? t.trim() : `#${t.trim()}`)).slice(0, 15);
    if (tags.length && JSON.stringify(tags) !== JSON.stringify(plan.hashtags ?? [])) { out.hashtags = tags; metaChanged = true; }
  }
  // 상단 캘리 문구 — 현 카피 대비 실변경만 인정(1줄=키워드 라벨 위계 유지, 미지정 필드는 현행 유지).
  let titleArtCopy: { line1: string; line2: string; points: string[] } | null = null;
  if (cand.titleArt && titleCopy) {
    const line1 = str(cand.titleArt.line1, 30) || titleCopy.line1;
    const line2 = str(cand.titleArt.line2, 30) || titleCopy.line2;
    const reqPoints = Array.isArray(cand.titleArt.points)
      ? cand.titleArt.points.map((p) => str(p, 40)).filter(Boolean).slice(0, 5) : [];
    const points = reqPoints.length ? reqPoints : (titleCopy.points ?? []);
    if (line1 !== titleCopy.line1 || line2 !== titleCopy.line2 || JSON.stringify(points) !== JSON.stringify(titleCopy.points ?? [])) {
      titleArtCopy = { line1, line2, points };
    }
  }
  if (!changed.length && !regen.length && !titleChanged && !metaChanged && !titleArtCopy) return null;
  return {
    plan: out, changedScenes: [...new Set(changed)].sort((a, b) => a - b),
    regenScenes: [...new Set(regen)].sort((a, b) => a - b), imageNotes, titleChanged, metaChanged, titleArtCopy,
  };
}

/**
 * 숏폼 수정 요청(검토 탭) — 피드백을 LLM 이 해석해 대본(내레이션·화면텍스트)·제목·설명·상단 캘리 문구를
 * 개정하고, 이미지 재생성이 필요한 씬만 다시 그린 뒤 재조립한다. 재사용: 무변경 씬 배경·I2V 클립·제목 캘리
 * (제목·캘리 문구가 안 바뀐 경우). 내레이션 TTS 는 조립 과정에서 전 씬 재합성된다(오독 교정 사전 적용).
 * 발행(유튜브 업로드·릴스) 이후엔 파일 교체가 불가하므로 거절한다.
 */
export async function reviseShorts(
  id: string, feedback: string,
  opts: { bus?: EventBus; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; error?: string; changedScenes: number[]; regenScenes: number[]; titleChanged: boolean; titleArtChanged: boolean }> {
  const store = shortsStore();
  const short = store.get(id);
  const fail = (error: string) => ({ ok: false as const, error, changedScenes: [], regenScenes: [], titleChanged: false, titleArtChanged: false });
  if (!short) return fail('unknown shorts');
  if (short.stage !== 'ready') return fail('완성(ready) 상태가 아닙니다');
  if (short.youtubeUrl || short.igReelId) return fail('이미 업로드/발행됨 — 발행물 영상은 교체할 수 없습니다(새 파생 생성 필요)');
  if (RUNNING.has(id)) return fail('생성/수정 작업이 이미 진행 중입니다');
  RUNNING.add(id);
  const say = (m: string): void => { console.log(`[숏폼] ${m}`); opts.bus?.emit('log', { message: m }); };
  try {
    const dir = store.dirFor(id);
    let plan: Plan;
    try { plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf-8')) as Plan; }
    catch { return fail('plan.json 없음 — 수정 불가'); }
    const cur = plan.scenes.map((s, i) => `${i + 1}. [내레이션] ${s.narration}${s.screenText ? ` [화면텍스트] ${s.screenText}` : ''}`).join('\n');
    // 상단 캘리 카피 — 수정 LLM 입력에 포함해야 '캘리 문구만 있는 단어'(예: 훅 줄의 표현)를 겨냥한
    // 요청이 좌초하지 않는다(대본에 없는 단어라 씬 매칭 0 → 무변경 재조립 '수정 완료' 오보고 사고).
    let artCopy: ThumbCopy | null = null;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, 'title-copy.json'), 'utf-8')) as Partial<ThumbCopy>;
      if (typeof c?.line1 === 'string' && c.line1.trim()) {
        artCopy = {
          line1: c.line1, line2: typeof c.line2 === 'string' ? c.line2 : '',
          points: Array.isArray(c.points) ? c.points.filter((p): p is string => typeof p === 'string') : [],
        };
      }
    } catch { /* 캘리 카피 없음 — titleArt 경로 비활성 */ }
    const j = await microJSON<ShortsRevision>(
      stdModel(),
      '당신은 숏폼 대본 에디터입니다. 요청된 JSON 스키마만 출력합니다.',
      [
        '아래 숏폼에 대한 검토자의 수정 요청을 반영해, "바뀌는 항목만" 돌려줘라. 요청과 무관한 씬·필드는 출력하지 마라.',
        `[제목] ${plan.title}`,
        `[씬]\n${cur}`,
        `[설명] ${plan.description}`,
        ...(artCopy ? [`[상단 캘리 문구(영상 오버레이·썸네일 공용)] 1줄(키워드 라벨): ${artCopy.line1}${artCopy.line2 ? ` / 2줄(훅): ${artCopy.line2}` : ''}${artCopy.points.length ? ` / 포인트: ${artCopy.points.join(' · ')}` : ''}`] : []),
        `[수정 요청] ${feedback}`,
        '규칙: 의미·톤 유지 범위에서 요청을 빠짐없이 반영, 내레이션 길이는 원문과 비슷하게(재생 시간 유지), 이모지 금지.',
        '배경 그림 자체를 바꿔야 하는 요청(장면·소품·구도)이면 그 씬에 "regen_image":true 와 "image_note":"무엇을 어떻게"를 넣어라. 문구만 바뀌면 넣지 마라(배경은 무텍스트).',
        ...(artCopy ? ['상단 캘리 문구를 바꿔야 하는 요청이면 "titleArt" 에 바뀐 필드만 넣어라 — 1줄은 핵심 키워드 라벨(정확 표기 유지), 2줄은 짧은 훅. 캘리 문구와 무관한 요청이면 titleArt 를 넣지 마라.'] : []),
        '인용구(quote) 씬의 문구·출처를 바꾸는 요청이면 해당 씬에 "quote":{"text":"...","source":"..."}(바뀐 필드만)를 넣어라 — quote 씬이 아니면 넣지 마라. source 는 실제 원문에 있는 출처만 적어라(지어내지 마라).',
        `JSON 형식: {"scenes":[{"index":씬번호,"narration":"...","screenText":"...","regen_image":false,"image_note":"...","quote":{"text":"...","source":"..."}}],"title":"...","description":"...","hashtags":["#..."]${artCopy ? ',"titleArt":{"line1":"...","line2":"...","points":["..."]}' : ''}} — 바뀌는 필드만 포함.`,
      ].join('\n'),
      { maxOutputTokens: 1600, signal: opts.signal },
    ).catch(() => null);
    const applied = applyShortsRevision(plan, j, artCopy);
    if (!applied) return fail('수정 요청에서 반영할 변경을 찾지 못했습니다 — 요청을 더 구체적으로 써 주세요');
    plan = applied.plan;
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
    store.update(id, { title: plan.title, topic: plan.title, description: plan.description, hashtags: plan.hashtags });
    say(`수정 요청 반영 — 씬 ${applied.changedScenes.join(',') || '없음'}${applied.regenScenes.length ? ` · 배경 재생성 ${applied.regenScenes.join(',')}` : ''}${applied.titleChanged ? ' · 제목' : ''}${applied.titleArtCopy ? ' · 캘리 문구' : ''}`);

    // 씬 배경 재구성 — 기존 매니페스트 슬롯 정렬 + regen 씬만 새로 그림(bg-draft 프롬프트 재사용).
    let images: Array<string | null> = plan.scenes.map(() => null);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'bg-manifest.json'), 'utf-8')) as { images?: Array<{ file_path?: string; error?: string } | null> };
      images = plan.scenes.map((_, i) => {
        const im = m.images?.[i];
        const fp = im?.file_path ? String(im.file_path) : '';
        return fp && !im?.error && fs.existsSync(fp) ? fp : null;
      });
    } catch { /* 전 씬 폴백 */ }
    if (applied.regenScenes.length) {
      let slots: Array<{ prompt?: string }> = [];
      try { slots = (JSON.parse(fs.readFileSync(path.join(dir, 'bg-draft.json'), 'utf-8')) as { imageSlots?: Array<{ prompt?: string }> }).imageSlots ?? []; } catch { /* 프롬프트 없음 */ }
      const rd = {
        imageSlots: applied.regenScenes.map((k) => ({
          alt: plan.scenes[k - 1]!.screenText || plan.scenes[k - 1]!.narration.slice(0, 30),
          prompt: (slots[k - 1]?.prompt ?? '') + (applied.imageNotes.get(k) ? `\n[장면 수정 — 최우선] ${applied.imageNotes.get(k)}` : ''),
        })),
      };
      if (rd.imageSlots.every((s) => s.prompt.trim())) {
        const rdPath = path.join(dir, 'revise-draft.json');
        const rmPath = path.join(dir, 'revise-manifest.json');
        fs.writeFileSync(rdPath, JSON.stringify(rd, null, 2), 'utf-8');
        say(`씬 배경 재생성 — ${applied.regenScenes.join(',')}`);
        const rr = await generateImagesForDraft(rdPath, path.join(dir, 'revise-imgs'), rmPath,
          { limit: rd.imageSlots.length, size: '1024x1536', timeoutMs: 150_000 * rd.imageSlots.length }, opts.signal);
        if (rr.ok) {
          try {
            const rm = JSON.parse(fs.readFileSync(rmPath, 'utf-8')) as { images?: Array<{ file_path?: string; error?: string } | null> };
            applied.regenScenes.forEach((k, i) => {
              const fp = rm.images?.[i]?.file_path ? String(rm.images[i]!.file_path) : '';
              if (fp && !rm.images?.[i]?.error && fs.existsSync(fp)) images[k - 1] = fp;
            });
          } catch { /* 기존 배경 유지 */ }
        } else say('씬 배경 재생성 실패 — 기존 배경 유지');
      } else say('씬 프롬프트 원본 없음(bg-draft) — 배경 재생성 생략');
    }
    // I2V 클립 재사용 — 배경이 바뀐 씬은 클립 폐기(스틸+fx 폴백), 나머지는 기존 클립 유지.
    const clips: Array<string | null> = plan.scenes.map((_, i) => {
      if (applied.regenScenes.includes(i + 1)) return null;
      const p = path.join(dir, 'clips', `clip_${String(i + 1).padStart(2, '0')}.mp4`);
      return fs.existsSync(p) ? p : null;
    });
    // 제목 캘리 — 제목/캘리 문구가 바뀌면 재생성, 아니면 기존 에셋 재사용(카피는 title-copy.json).
    let titleArt: { imagePath: string; copy: ThumbCopy } | null = null;
    if (CONFIG.shortsTitleOverlay) {
      const artPath = path.join(dir, 'title-art.png');
      if (applied.titleArtCopy || applied.titleChanged || !fs.existsSync(artPath)) {
        titleArt = await generateTitleArt({
          dir, title: plan.title, description: plan.description, titles: plan.titles, keyword: short.keyword, signal: opts.signal,
          ...(applied.titleArtCopy ? { copy: applied.titleArtCopy } : {}),
        });
        // 캘리 문구 교체가 핵심 요청인데 재생성이 실패하면 구 문구 그대로 '수정 완료'가 나간다 — 정직하게 실패.
        if (!titleArt && applied.titleArtCopy) return fail('상단 캘리 재생성 실패(생성/QA) — 잠시 후 다시 시도해 주세요');
        say(titleArt ? `상단 제목 캘리 재생성${applied.titleArtCopy ? ' — 문구 교체' : ''}` : '상단 제목 캘리 스킵');
      } else {
        try { titleArt = { imagePath: artPath, copy: JSON.parse(fs.readFileSync(path.join(dir, 'title-copy.json'), 'utf-8')) as ThumbCopy }; } catch { titleArt = null; }
      }
    }
    // 재조립 — 잡과 동일한 폴백 체인(Remotion → ffmpeg). 내레이션 TTS 는 전 씬 재합성(교정 사전 적용).
    say(CONFIG.shortsRenderer === 'ffmpeg' ? '재조립 시작 — ffmpeg 슬라이드쇼' : '재조립 시작 — Remotion 모션그래픽');
    const reassemble = async (p: Plan, imgs: Array<string | null>, clps: typeof clips): Promise<Awaited<ReturnType<typeof renderShortsVideo>>> => {
      let rr = null as Awaited<ReturnType<typeof renderShortsVideo>> | null;
      if (CONFIG.shortsRenderer !== 'ffmpeg') {
        try {
          rr = await renderShortsVideoRemotion(dir, p.scenes, imgs, {
            clips: clps, signal: opts.signal,
            caption: {
              bottomPct: CONFIG.shortsCaptionBottomPct, fontPx: CONFIG.shortsCaptionFontPx, hookFontPx: CONFIG.shortsCaptionHookFontPx,
              ...(CONFIG.shortsCaptionKeyword && short.keyword ? { keyword: short.keyword } : {}),
              ...(CONFIG.shortsCaptionOutline ? { outline: true } : {}),
            },
            ...(titleArt ? { title: { imagePath: titleArt.imagePath, topPct: CONFIG.shortsTitleTopPct, widthPct: CONFIG.shortsTitleWidthPct } } : {}),
          });
        } catch (e) { say(`모션 렌더 예외 → ffmpeg 폴백: ${e instanceof Error ? e.message.slice(0, 80) : e}`); rr = null; }
      }
      if (!rr || !rr.ok) {
        if (rr) say(`모션 렌더 실패 → ffmpeg 폴백${rr.issues.length ? ` (${rr.issues.join(' · ').slice(0, 120)})` : ''}`);
        rr = await renderShortsVideo(dir, p.scenes, imgs, {
          signal: opts.signal,
          ...(titleArt ? { title: { imagePath: titleArt.imagePath, topPct: CONFIG.shortsTitleTopPct, widthPct: CONFIG.shortsTitleWidthPct } } : {}),
        });
      }
      return rr;
    };
    let r = await reassemble(plan, images, clips);
    if (!r.ok || !r.videoPath) return fail(`재조립 실패 — ${r.issues.join(' · ').slice(0, 200)}`);
    // 길이 상한 집행(2026-08-20) — 잡 경로와 패리티. 수정요청이 내레이션을 늘려 상한을 넘기면 실측 속도
    // 재감량(LLM+결정적 트리밍)→재조립. 잔여 초과여도 수정 자체는 완료로 낸다(생성·완료 우선) —
    // 초과본 발행은 발행 핸들러 409 게이트가 막고, 아래 store 갱신이 실측 durationSec 을 기록해 게이트가 진실을 본다.
    let liveIdx = plan.scenes.map((_, i) => i);
    for (let round = 1; (r.durationSec ?? 0) > CONFIG.shortsMaxDurationSec && round <= 2; round++) {
      const io2: JobIO = { signal: opts.signal };
      const chars = shortsNarrationChars(plan);
      const cps = chars / Math.max(1, (r.durationSec ?? 1) - 2);
      const fit2 = await fitShortsPlanToDuration(io2, plan, Math.floor((CONFIG.shortsMaxDurationSec - 5) * cps));
      if (!fit2.compressed) { say(`길이 상한 재감량 무변화(${round}/2) — 이미 최소 구성`); break; }
      liveIdx = fit2.keptScenes.map((k) => liveIdx[k]!);
      plan = fit2.plan;
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
      try {
        const rdir = path.join(dir, 'remotion');
        for (const f of fs.readdirSync(rdir)) if (/^narr_\d+\.mp3$/.test(f)) fs.unlinkSync(path.join(rdir, f)); // 구 대본 TTS 소거
      } catch { /* 무해 */ }
      say(`길이 상한 초과 ${r.durationSec}초 — 재감량 ${fit2.beforeChars}→${fit2.afterChars}자${liveIdx.length < images.length ? ` · 씬 ${liveIdx.length}개로 축소` : ''}, 재조립(${round}/2)`);
      const r2 = await reassemble(plan, liveIdx.map((i) => images[i] ?? null), liveIdx.map((i) => clips[i] ?? null));
      if (!r2.ok || !r2.videoPath) break;
      r = r2;
    }
    if ((r.durationSec ?? 0) > CONFIG.shortsMaxDurationSec) {
      say(`⚠ 길이 상한 잔여 초과 — ${r.durationSec}초 > ${CONFIG.shortsMaxDurationSec}초. 수정은 완료로 처리 — 발행 게이트가 초과본을 막으니 대본 감량 수정을 한 번 더 요청해 주세요`);
    }
    const revisedVideoPath = r.videoPath; // 루프 재대입으로 풀린 내로잉 재확립
    if (!revisedVideoPath) return fail('재조립 실패 — 결과 영상 경로 없음');
    const caption = [plan.title, '', plan.description, '', plan.hashtags.join(' ')].filter((x, i) => x || i === 1 || i === 3).join('\n');
    fs.writeFileSync(path.join(dir, 'caption.txt'), caption, 'utf-8');
    store.update(id, { stage: 'ready', scenes: r.sceneCount, durationSec: r.durationSec, topic: plan.title });
    say(`수정 완료 — ${plan.title.slice(0, 30)} · ${r.durationSec}초`);
    // 썸네일 — 제목/캘리 문구/배경이 바뀐 경우만 재생성(문구 일치 유지). 실패 무해.
    if (applied.titleChanged || applied.titleArtCopy || applied.regenScenes.length) {
      try {
        const hook = images.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
        const ok = await generateDesignedThumbnail({
          dir, title: plan.title, description: plan.description, titles: plan.titles, keyword: short.keyword, hookImage: hook, signal: opts.signal,
          ...(titleArt ? { copy: titleArt.copy } : {}),
        });
        say(ok ? '썸네일 재생성 완료' : '썸네일 재생성 스킵');
      } catch { /* 무해 */ }
    }
    // 갱신 알림(완성 영상 재발송) — 사용자가 수정 결과를 바로 검수. 실패 무해.
    const done = store.get(id);
    if (done) {
      void notifyShortsReady({ id, topic: done.topic, brand: done.brand, durationSec: r.durationSec, scenes: r.sceneCount, sourcePieceId: done.sourcePieceId, writer: done.writer, director: done.director, factGate: done.factGate }, revisedVideoPath).catch(() => { /* 무해 */ });
    }
    return { ok: true, changedScenes: applied.changedScenes, regenScenes: applied.regenScenes, titleChanged: applied.titleChanged, titleArtChanged: !!applied.titleArtCopy };
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 200) : String(e));
  } finally {
    RUNNING.delete(id);
  }
}

/** 역할 LLM 호출(JSON) — 버스가 있으면 runAgent(오피스 뷰 스폰·스트림·지표), 없으면 무음 microJSON. */
async function callRoleJSON<T>(
  io: JobIO, roleId: string, fallbackSystem: string, task: string,
  maxOutputTokens: number, emitSpawn: boolean,
): Promise<T | null> {
  const role = (() => { try { return rolesById(getCompany()).get(roleId); } catch { return undefined; } })();
  if (io.bus && role) {
    const out = await runAgent({
      bus: io.bus, role, model: stdModel(),
      task: `${task}\n\n${NO_FABRICATED_EXPERIENCE}\n\n${SELLER_INQUIRY_BAN}\n\n${lexiconGuide(getBrand()?.avoidJargon, getBrand()?.keepTerms)}\n\n다른 텍스트 없이 JSON만 출력하라.`,
      // 단발 JSON 기획은 추론 강제 OFF(→ sonnet --effort low) — 카드뉴스와 동일한 사고 폭주 상한
      // 초과 계열(2026-08-11 실측) 예방.
      stage: 'work', emitSpawn, maxOutputTokens, think: false, signal: io.signal,
    });
    return extractFirstJson<T>(out.text);
  }
  // microJSON 폴백은 buildSystemPrompt 를 안 지나므로 브랜드 컨텍스트를 system 에 직접 합성.
  const sys = [role?.systemPrompt || fallbackSystem, brandContext(), NO_FABRICATED_EXPERIENCE, SELLER_INQUIRY_BAN, lexiconGuide(getBrand()?.avoidJargon, getBrand()?.keepTerms)].filter(Boolean).join('\n\n');
  return microJSON<T>(stdModel(), sys, task, { maxOutputTokens, signal: io.signal });
}

/** 내레이션 위생 — 이모지·괄호 지문 제거(TTS 가 읽어버림), 월 이름 고유어 교정(십월→시월), 길이 캡. */
function cleanNarration(s: unknown, cap = 120): string {
  return fixMonthNames(stripEmoji(String(s ?? ''))
    .replace(/[()（）[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, cap);
}

function normalizeHashtags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const tags = arr
    .map((t) => String(t ?? '').trim().replace(/\s+/g, ''))
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));
  if (!tags.some((t) => t.toLowerCase() === '#shorts')) tags.push('#shorts'); // 참고 자산 규약: #shorts 필수
  return [...new Set(tags)].slice(0, 8);
}

/**
 * 최근 숏폼 훅·CTA 원문 수집(같은 브랜드, 전량 fail-open) — 문형 로테이션 지시의 실물 근거.
 * 배경(자연스러움 감사 2026-08-11): 훅 "질문+반전" 공식 7/15편, CTA "계속 기록/정리" 7/15편으로
 * 채널 단위 지문화. recentStyleToAvoid(블로그)와 같은 원리 — 겹치면 안 되는 원문을 직접 보여준다.
 */
function recentHooksToAvoid(brand: string | undefined, excludeId: string, limit = 5): string {
  try {
    const store = shortsStore();
    const rows: string[] = [];
    for (const e of store.list()) {   // 최신부터 — shortsStore.list() 가 이미 createdTs 내림차순이다(뒤집지 않는다)
      if (e.id === excludeId || (e.brand ?? undefined) !== (brand ?? undefined)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(store.dirFor(e.id), 'plan.json'), 'utf-8')) as
          { scenes?: Array<{ narration?: string }> };
        const hook = (p.scenes?.[0]?.narration ?? '').trim();
        const cta = (p.scenes?.[p.scenes.length - 1]?.narration ?? '').trim();
        if (hook || cta) rows.push(`- 훅: "${hook}" / CTA: "${cta}"`);
      } catch { /* plan.json 없는 항목(구버전·실패 런) 무시 */ }
      if (rows.length >= limit) break;
    }
    if (!rows.length) return '';
    return [
      '[최근 숏폼의 훅·CTA 원문 — 아래와 문형·첫 문장 구조가 겹치면 다시 써라]',
      ...rows,
    ].join('\n');
  } catch { return ''; }
}

/** TTS 실측 속도(자/초) — 2026-08-14 실측: 대본 460자 → 낭독 77.3초(포즈 포함) ≈ 5.9자/초.
 *  종전 프롬프트 가정(7자/초, "30~70자=5~10초")이 이걸 몰라서 55초 지시가 77초 영상이 됐다. */
const SHORTS_TTS_CPS = 5.9;

function shortsNarrationChars(p: Plan): number { return p.scenes.reduce((s, x) => s + x.narration.length, 0); }

/** 문장 분리(트리밍용) — styleLint 와 같은 대략 규칙(종결부호 기준). */
const splitNarrSentences = (t: string): string[] => t.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);

/**
 * 결정적 트리밍(순수, 테스트 대상) — LLM 감량이 예산에 못 미쳐도(실측 2026-08-20: 목표 341자에 364자
 * 응답, 3라운드 전부 미달 → 60.7초 실패) 코드가 예산을 보장한다. 생성 실패 금지(사용자 확정 2026-08-20:
 * "쇼츠는 반드시 생성되어야 함")의 핵심 장치.
 * 1단계 — 문장 단위: 본문 씬(훅·CTA 제외, 씬2 전제는 후순위)에서 긴 씬부터 마지막 문장을 제거(전 씬
 * 최소 1문장 유지). 2단계 — 씬 단위: 뒤쪽 본문 씬을 통째로 제거(훅·씬2·CTA 보존, 최소 4씬).
 * keptScenes 는 원본 씬 인덱스 — 렌더 시 씬별 이미지·클립 배열을 함께 줄이는 매핑에 쓴다.
 */
export function trimPlanToBudget(plan: Plan, budgetChars: number): { plan: Plan; keptScenes: number[]; trimmed: boolean } {
  const total = (scs: Array<{ narration: string }>): number => scs.reduce((s, x) => s + x.narration.length, 0);
  const scenes = plan.scenes.map((s) => ({ ...s }));
  const kept = scenes.map((_, i) => i);
  let changed = false;
  let guard = 40; // 폭주 방지 — 씬×문장 수보다 넉넉한 상한
  while (total(scenes) > budgetChars && guard-- > 0) {
    const order = [...scenes.keys()]
      .filter((i) => i > 0 && i < scenes.length - 1) // 훅·CTA 는 문장 트리밍 제외(각 1~2문장 핵심)
      .sort((a, b) => (a === 1 ? 1 : 0) - (b === 1 ? 1 : 0) || scenes[b]!.narration.length - scenes[a]!.narration.length);
    const cand = order.find((i) => splitNarrSentences(scenes[i]!.narration).length >= 2);
    if (cand === undefined) break; // 더 뺄 문장 없음 — 씬 단위로
    scenes[cand]!.narration = splitNarrSentences(scenes[cand]!.narration).slice(0, -1).join(' ').trim();
    changed = true;
  }
  while (total(scenes) > budgetChars && scenes.length > 4) {
    const drop = scenes.length - 2; // CTA 앞 본문 씬부터 뒤에서 제거
    scenes.splice(drop, 1);
    kept.splice(drop, 1);
    changed = true;
  }
  return { plan: { ...plan, scenes }, keptScenes: kept, trimmed: changed };
}

/** 제목 후보 유형 풀(2026-08-27 말투 감사 권고 5) — 종전 고정 3종(정보형·후킹형·질문형)이 채널 지문이 됐다. */
export const TITLE_TYPE_POOL = ['정보형', '후킹형', '질문형', '결론형', '장면형'] as const;

/**
 * 런별 제목 후보 유형 3종 선택(순수·주입 난수) — 유형 풀에서 매 런 다르게 고른다.
 *  · 질문형 상한: 최근 3편 중 1편이라도 질문형 후보를 냈으면 이번 런 풀에서 뺀다. 이렇게 하면 연속한
 *    어느 3편 창에서도 질문형이 1편을 넘지 않는다(편1이 썼으면 편2·3·4가 막히고 편5에서 다시 열린다).
 *    판정은 classifyTitleType(analytics/titleTiming) — 제목 유형 A/B 집계와 같은 분류기를 쓴다.
 *  · keywordFirst: 핵심 키워드가 있는 런은 '정보형'을 반드시 포함한다. 프롬프트의 "대표 제목과 정보형
 *    후보에는 키워드를 정확히 이 표기 그대로"(사용자 확정 자산)가 후보에서 통째로 사라지면 안 되기 때문.
 * recentTitles 는 최근 편들의 plan.json titles(최신 순).
 */
/**
 * 제목 유형 정의 줄(순수, Fix wave 2026-08-27 소견 3) — base(194bed6d) 프롬프트에는 이 줄이 아예 없었고
 * titles 는 JSON 형식 줄의 ["정보형","후킹형","질문형"] 로만 지시됐다. VOICE_ROTATION=off 면 제목 유형은
 * 종전 고정 3종으로 돌아가는데 5종 정의 줄만 남으면 base 와 달라진다(킬스위치 동일성 계약) — off 면 뺀다.
 */
export function shortsTitleTypeGuide(titleTypes: string[], rotation: boolean): string {
  if (!rotation) return '';
  return `제목 후보(titles) 3개는 서로 다른 유형으로 쓴다 — 순서대로 [${titleTypes.join(' / ')}]. 유형 정의: 정보형=무엇을 다루는 영상인지 그대로 알린다 / 후킹형=손해·실수·반전으로 클릭을 부른다 / 질문형=독자의 질문을 그대로 던진다 / 결론형="~은 ~입니다" 꼴로 답을 먼저 준다 / 장면형=손에 잡히는 한 장면을 그린다.`;
}

/**
 * 설명(description) 요약투 검사(순수, Fix wave 2026-08-27 소견 4) — 권고 2 가 새로 만든 이 검사만
 * 킬스위치가 없었다(timingParity·blogStyleLint·voiceRotation·structureVariety 는 전부 게이트를 가진다).
 * META_SUMMARY_LINT=off 면 블로그 meta 재시도(naverBlog)와 이 합류가 함께 멈춘다.
 */
export function descriptionLintIssues(description: string, on: boolean = CONFIG.metaSummaryLint): string[] {
  return on ? metaSummaryIssues(description).slice(0, 1) : [];
}

export function pickTitleTypes(
  recentTitles: string[][], opts: { keywordFirst?: boolean; rand?: () => number } = {},
): string[] {
  const rand = opts.rand ?? Math.random;
  const questionEpisodes = recentTitles.slice(0, 3)
    .filter((ts) => ts.some((t) => classifyTitleType(String(t ?? '')) === 'question')).length;
  const rest: string[] = TITLE_TYPE_POOL.filter((t) => t !== '질문형' || questionEpisodes < 1);
  const picked: string[] = [];
  if (opts.keywordFirst) picked.push(...rest.splice(rest.indexOf('정보형'), 1));
  while (picked.length < 3 && rest.length) {
    const i = Math.min(rest.length - 1, Math.floor(rand() * rest.length));
    picked.push(...rest.splice(i, 1));
  }
  return picked;
}

/**
 * 최근 숏폼의 제목 후보 원문(같은 브랜드, 최신 순, 전량 fail-open) — 질문형 상한 판정 입력.
 * shortsStore.list() 는 createdTs 내림차순(최신 순)이라 뒤집지 않는다.
 */
function recentShortsTitles(brand: string | undefined, excludeId: string, limit = 3): string[][] {
  try {
    const store = shortsStore();
    const rows: string[][] = [];
    for (const e of store.list()) {
      if (e.id === excludeId || (e.brand ?? undefined) !== (brand ?? undefined)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(store.dirFor(e.id), 'plan.json'), 'utf-8')) as { titles?: unknown };
        const ts = (Array.isArray(p.titles) ? p.titles : []).map((t) => String(t ?? '').trim()).filter(Boolean);
        if (ts.length) rows.push(ts);
      } catch { /* plan.json 없는 항목(구버전·실패 런) 무시 */ }
      if (rows.length >= limit) break;
    }
    return rows;
  } catch { return []; }
}

/** 유보 표현 — 압축 LLM 이 "군더더기"로 지워 단정문(결론 반전)을 만든 실측 대응.
 *  '미루'는 "미루고/미룹니다"(유보)만 노린다 — 미루나무는 수종명이라 제외(2026-08-26 최종 리뷰 F5d). */
export const HEDGE_RE = /대개|흔히|보통|대체로|경우가 많|수 있|봐요|가능성|편이에요|편입니다|미루(?!나무)/;
/** 원문에 유보 토큰이 있던 씬이 압축본에서 사라지면 원 내레이션으로 되돌린다(스펙 §6b) — 순수 함수, 입력 불변. */
export function restoreLostHedges(before: Plan, after: Plan): { plan: Plan; restored: number[] } {
  const restored: number[] = [];
  const scenes = after.scenes.map((s, i) => {
    const orig = before.scenes[i];
    if (!orig || !HEDGE_RE.test(orig.narration) || HEDGE_RE.test(s.narration)) return s;
    restored.push(i + 1);
    return { ...s, narration: orig.narration };
  });
  return { plan: { ...after, scenes }, restored };
}

/** 길이 상한 초과 대본 압축 — LLM 감량(품질 우선) 후 예산 미달분은 결정적 트리밍이 마감(예산 보장).
 *  budgetCharsOverride: 렌더 후 실측 낭독 속도로 역산한 예산(재감량 경로) — 미지정 시 정적 예산.
 *  keptScenes: 살아남은 씬의 '입력 plan 기준' 인덱스(씬 제거 시 이미지·클립 매핑용). */
async function fitShortsPlanToDuration(io: JobIO, plan: Plan, budgetCharsOverride?: number): Promise<{ plan: Plan; compressed: boolean; beforeChars: number; afterChars: number; keptScenes: number[] }> {
  const cap = CONFIG.shortsMaxDurationSec;
  const budget = budgetCharsOverride ?? Math.floor((cap - 5) * SHORTS_TTS_CPS); // 5초 여유 — TTS 속도 편차·업로드 인트로(1.6초)
  const before = shortsNarrationChars(plan);
  const allIdx = plan.scenes.map((_, i) => i);
  const keep = { plan, compressed: false, beforeChars: before, afterChars: before, keptScenes: allIdx };
  // 트리거: 정적 경로는 상한 예산(cap×CPS) 초과 시, 실측 예산 경로는 그 예산 초과 시.
  if (before <= (budgetCharsOverride ?? Math.floor(cap * SHORTS_TTS_CPS))) return keep;
  const cur = plan.scenes.map((s, i) => `${i + 1}. ${s.narration}`).join('\n');
  const j = await microJSON<{ scenes?: Array<{ index?: unknown; narration?: unknown } | null> }>(
    stdModel(),
    '당신은 숏폼 대본 에디터입니다. 요청된 JSON 스키마만 출력합니다.',
    [
      `아래 숏폼 내레이션 합계가 ${before}자로 낭독 상한(${cap}초 ≈ ${budget}자)을 넘는다. 씬 구성은 유지하고 내레이션만 감량해 합계 ${budget}자 이내로 만들어라.`,
      cur,
      `합계 ${budget}자 이내는 반드시 지켜라 — 표현 다듬기로 모자라면 덜 중요한 문장을 통째로 빼라. 찔끔 깎은 초과 응답은 무효다(실측: 목표 341자에 364자 응답이 반복돼 코드가 강제 트리밍하게 된다 — 그러면 네가 고른 문장이 아니라 뒤 문장이 잘린다).`,
      '규칙: 사실·수치·결론과 씬별 "무엇을+왜"는 유지하고 군더더기·중복 표현만 깎아라. 조사·주어를 떨어낸 초압축은 감량이 아니라 훼손이다("이 시기 질소 거름 주면" 금지 → "이 시기엔 질소 거름을 주면"). 구어체 존댓말·숫자 한글 낭독 등 원문 문체 유지, 이모지 금지. 유보어("대개/흔히/보통/~일 수 있다/~봐요/가능성")는 군더더기가 아니다 — 남겨라. 원문 결론의 방향("미루라/하지 마라")을 뒤집지 마라.',
      'JSON 형식: {"scenes":[{"index":씬번호,"narration":"..."}]} — 전 씬 포함.',
    ].join('\n'),
    { maxOutputTokens: 1200, signal: io.signal },
  ).catch(() => null);
  let out: Plan = { ...plan, scenes: plan.scenes.map((s) => ({ ...s })) };
  if (j?.scenes) {
    for (const s of j.scenes) {
      const idx = typeof s?.index === 'number' && Number.isInteger(s.index) ? s.index : 0; // 1-base
      if (idx < 1 || idx > out.scenes.length) continue;
      const narration = cleanNarration(s?.narration);
      if (narration && narration.length < out.scenes[idx - 1]!.narration.length) out.scenes[idx - 1]!.narration = narration;
    }
  }
  // 압축이 유보어를 지워 결론을 반전시킨 실측 대응 — 결정적 트리밍(예산 보장) 전에 원문장으로 복원.
  try {
    const hedged = restoreLostHedges(plan, out);
    if (hedged.restored.length) { out = hedged.plan; io.bus?.emit('log', { message: `압축 — 유보어 소실 씬 ${hedged.restored.join(',')} 원문장 복원` }); }
  } catch { /* fail-open — 복원 실패로 압축 자체를 막지 않는다 */ }
  // 결정적 마감 — LLM 무응답·부분 이행 모두 여기서 예산을 보장한다(생성 실패 금지의 전제).
  let keptScenes = allIdx;
  if (shortsNarrationChars(out) > budget) {
    const t = trimPlanToBudget(out, budget);
    out = t.plan;
    keptScenes = t.keptScenes;
  }
  const after = shortsNarrationChars(out);
  return after < before
    ? { plan: out, compressed: true, beforeChars: before, afterChars: after, keptScenes }
    : keep;
}

/**
 * 시기·수치 대조 입력(순수) — 시청자가 실제로 보고 듣는 파생 텍스트 전부: 내레이션·자막 + dataviz 오버레이
 * 값(stat·chart·list·quote) + 설명(유튜브 설명 = 인스타 캡션에 복제된다).
 */
export function timingFields(plan: Plan): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  plan.scenes.forEach((s, i) => {
    const n = i + 1;
    if (s.narration) out.push({ field: `씬${n} 내레이션`, text: s.narration });
    if (s.screenText) out.push({ field: `씬${n} 자막`, text: s.screenText });
    if (s.kind === 'stat' && s.stat) out.push({ field: `씬${n} 오버레이`, text: `${s.stat.value}${s.stat.unit ?? ''} ${s.stat.label ?? ''}`.trim() });
    if (s.kind === 'chart' && s.chart) out.push({ field: `씬${n} 차트`, text: s.chart.series.map((x) => `${x.label} ${x.value}${s.chart?.unit ?? ''}`).join(', ') });
    if (s.kind === 'list' && s.items?.length) out.push({ field: `씬${n} 목록`, text: s.items.join(' / ') });
    if (s.kind === 'quote' && s.quote?.text) out.push({ field: `씬${n} 인용`, text: s.quote.text });
    // 결론 카드(2026-08-28) — 사용자 확정으로 화면이 답을 '단독으로' 진다(내레이션은 기준만 말한다).
    // 그래서 이 텍스트가 대조에서 빠지면 검증받지 않은 답이 화면에만 떠서 나간다 — 다른 오버레이와 동렬로 싣는다.
    if (s.kind === 'cta' && s.takeaways?.length) out.push({ field: `씬${n} 결론`, text: s.takeaways.map((t) => `${t.when} → ${t.then}`).join(', ') });
  });
  if (plan.description) out.push({ field: '설명', text: plan.description });
  return out;
}

/** quote 출처 라벨은 원문(블로그 본문)에 그 문자열이 있을 때만 유지 — 패러프레이즈에 가짜 출처("— 재배 기록")가 붙어 발행된 실측 6건 대응(스펙 §6a). */
export function pruneQuoteSources(plan: Plan, sourceBody: string | undefined): { plan: Plan; pruned: number } {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const body = sourceBody ? norm(sourceBody) : '';
  let pruned = 0;
  const scenes = plan.scenes.map((s) => {
    if (s.kind !== 'quote' || !s.quote?.source) return s;
    if (body && body.includes(norm(s.quote.source))) return s;
    pruned++;
    const { source: _drop, ...rest } = s.quote;
    return { ...s, quote: rest };
  });
  return { plan: { ...plan, scenes }, pruned };
}

async function planShorts(io: JobIO, topic: string, keyword: string | undefined, sourceBody: string | undefined, n: number, priorCoverage = '', titleTypes: string[] = ['정보형', '후킹형', '질문형'], sourceFlagged: string[] = []): Promise<Plan | null> {
  const capSec = CONFIG.shortsMaxDurationSec;
  // 제목 후보 유형(권고 5) — 스키마 예시와 유형 설명이 같은 목록을 가리켜야 작가가 순서대로 채운다.
  const titlesJson = titleTypes.map((t) => `"${t}"`).join(',');
  const budgetChars = Math.floor((capSec - 5) * SHORTS_TTS_CPS);
  const maxScenes = Math.min(8, Math.max(3, Math.floor(capSec / 8)));
  const user = [
    `[주제] ${topic}`,
    keyword ? `[핵심 키워드] ${keyword}` : '',
    priorCoverage,
    sourceBody ? `[블로그 초안 본문 — 핵심 1~2개와 그것이 성립하는 이유(전제 인과 한 줄)를 함께 추려 재구성하라(문장 복붙 금지, 사실·수치는 원문에 있는 것만)]\n${sourceBody.slice(0, 4000)}` : '',
    // 원문 핵심 앵커(2026-08-24 실사고) — 블로그는 '화분 크기'가 핵심 축인데 유사주제 가드에 밀린 작가가
    // 그 축을 통째로 빼고 곁가지(겨울 자리)로만 대본을 만들어 세트의 메시지가 어긋났다. 소재 선택은
    // 원문이 이기고, 프레이밍(각도)은 중복 회피가 이긴다는 서열을 명시한다.
    sourceBody ? '원문 핵심 앵커: 원문 제목·소제목이 힘준 핵심 축 중 최소 1개를 대본의 중심 소재로 삼아라 — 원문이 강조하지 않은 곁가지만으로 대본을 채우면 실패다. 그 핵심 축이 [이미 만든 유사 주제] 목록에서 이미 다뤄진 경우에만 다음 축으로 넘어가고, 전부 다뤄졌다면 소재는 유지하되 다른 독자 상황·글 유형으로 재구성하라(소재 선택은 원문이, 프레이밍은 중복 회피가 이긴다).' : '',
    // 매체 전환 선언(2026-08-28 사용자 지적) — 종전 지시는 "문장 복붙 금지"까지였다. 실측(short_b894bf71fb)
    // 유사도는 38~56%라 복붙은 안 했는데도, 씬 순서가 원문 소제목 순서를 그대로 따라가 '요약본'이 됐다:
    // 문제제기→방법→방법→다른주제→목록. 블로그는 훑어 읽으며 필요한 대목만 골라 가는 매체라 병렬 나열이
    // 통하지만, 숏폼은 되감기가 없어 한 줄기로 끝까지 끌고 가야 한다. 복붙 금지는 '문장'의 문제였고,
    // 이 지시는 '구성'의 문제다 — 원문에서 가져올 것은 사실이지 순서가 아니다.
    // 원문 미검증 주장 예방(2026-08-28 처방 C) — 사후 검출(inheritedClaims)의 짝. 작가가 애초에 안 쓰는 게
    // 가장 싸다. 원문에 '있으니까 안전하다'는 판단을 여기서 무너뜨린다 — 원문에 있어도 근거는 없는 문장들이다.
    sourceFlagged.length ? `[원문에서 근거가 확인되지 않은 주장 — 원문 본문에 적혀 있어도 대본·자막·화면 어디에도 쓰지 마라. 사실 게이트가 근거를 못 찾은 문장들이다]\n${sourceFlagged.slice(0, 8).map((c, i) => `${i + 1}. ${c}`).join('\n')}\n이 주장들을 바꿔 말하거나 요약해서 싣는 것도 금지다(수치·시기만 떼어 목록에 넣는 것 포함). 이 소재를 꼭 다뤄야 하면 단정 대신 조건·한계를 밝혀 쓰고 숫자는 적지 마라.` : '',
    sourceBody ? '[매체 전환 — 요약본이 아니라 새 대본] 원문에서 가져오는 것은 **사실과 근거**이지 구성이 아니다. 원문의 소제목 순서를 그대로 따라가지 마라 — 블로그는 필요한 대목만 골라 읽는 매체라 여러 갈래를 나란히 둬도 되지만, 숏폼은 되감기가 없어 한 줄기로만 끝까지 간다. 원문의 여러 축 중 **하나만 골라** 그 축으로 끝까지 밀고, 나머지는 통째로 버려라(다 담으면 아무것도 안 남는다). 고른 축은 훅에서 던진 문제와 마지막 씬의 답이 같은 줄기로 이어져야 한다.' : '',
    '',
    `씬 ${n}개의 유튜브 숏폼 대본을 기획하라. 씬1=훅(3패턴 중 택1), 씬2=전제(이 영상이 무엇에 대한 이야기이고 왜 문제/중요한지를 못박는다 — 원문의 핵심 인과 한 줄), 마지막 씬=CTA.`,
    // 씬2 인과 연결(2026-08-28) — 실측: 훅이 "옆집 창이 마당을 본다"로 사생활 긴장을 세웠는데 씬2가 그걸
    // 받지 않고 곧바로 "두 가지를 적어요"로 넘어가, 시청자에게 화제 전환으로 읽혔다. 원문에는 그 고리가
    // 있었다("그럼 나무를 몇 미터짜리로 심어야 할까요") — 대본이 떨어뜨린 것이다.
    '씬2는 훅이 세운 긴장을 **받아서** 이어라 — 훅의 문제가 왜 이 영상의 주제로 이어지는지 한 마디로 잇고 나서 전제를 말한다. 훅과 무관한 기준·항목을 씬2에서 새로 꺼내면 시청자에겐 화제 전환으로 들린다. 훅에서 세우지 않은 두 번째 축을 씬2에 끼워 넣지 마라.',
    '시청자는 원문 블로그를 본 적이 없다 — 영상 단독으로 완결되게 써라: 핵심 주제어(식물명·행위명 등)를 훅 또는 씬2에서 반드시 명시하고, 지시어·축약어("짝"·"그 방법"·"두 그루" 류)는 앞 씬에서 뜻을 세운 뒤에만 사용하라. 단, 명시는 검색 표기 그대로일 필요 없다 — 키워드 명사구를 통째로 주어 자리에 세우지 말고("가을 묘목 심는 법은 ~로 정해집니다" 식 금지, 검색용 문장 티가 난다) 조사·어순을 바꿔 말이 되는 꼴로 녹여라("가을에 묘목을 심을 땐 날짜보다 뿌리부터 봐요"). 검색 표기 그대로의 노출은 title·titles·description·해시태그·screenText 가 담당한다. 단 씬2(전제)의 정의 한 문장은 예외 — 뒤 씬에서 쓸 기준·개념(예: "두 선")은 씬2에서 이름 붙여 뜻을 세워라. 어순·조사는 바꿔도 되지만 정의 자체를 얼버무리지 마라. 훅에서 감춘 대상도 씬2에서 반드시 밝힌다.',
    '훅 금지 문형: "~보셨나요?/~라고요? + 정작/사실은/그럼 이미 ~" 질문-반전 공식(최근 편들이 과다 사용). 단정 선언("까맣게 익어도 아직 이릅니다"), 구체 장면, 숫자 제시, 청자 상황 지목, 짧은 제동("잠깐,") 등에서 앞 편들과 다른 유형을 골라라.',
    // 첫 2초 훅 분리(2026-08-20 조회수 감사) — 최근 47편 중 17편이 첫 2초를 키워드·상품명 낭독에 써서
    // 추천 피드 이탈 요인이 됐다. 검색 표기는 제목·캘리·화면텍스트가 담당(사용자 확정 원칙 유지).
    '훅 첫 문장을 키워드·수종명·상품명 낭독으로 열지 마라 — 첫 2초(약 12자)가 스와이프 이탈을 결정한다. 긴장·장면·숫자·상황 지목으로 열고, 키워드 명시는 훅의 뒷문장 또는 씬2에서 하라.',
    keyword ? `대표 제목(title)과 정보형 제목 후보에는 핵심 키워드 '${keyword}' 를 정확히 이 표기 그대로, 가급적 앞쪽에 포함하라(검색 노출용 — 제한된 글자수를 이유로 키워드를 빼지 마라). 키워드는 명사구 그대로 자연스럽게 결합하고 어미를 붙여 동사화하지 마라.` : '',
    'CTA 씬은 팔로우할 이유를 담아라 — 이 채널이 계속 주는 가치 한 구절(브랜드 맥락에 맞게) 또는 다음 편 예고 중 하나. "구독과 좋아요 부탁드려요" 같은 기계적 문구 금지. "계속 기록/정리해 드립니다" 계열 문구 재사용 금지 — 기록하는 채널 컨셉은 유지하되 표현은 매편 새로 지어라.',
    '다음 편 예고를 CTA 에 넣었으면 JSON 의 next 필드에 그 주제와 적절한 시기("N월")를 선언하라 — 예고는 시스템이 약속으로 기록해 그 시기에 실제로 제작한다. 지킬 수 있는 예고만 하고, 예고를 안 했으면 next 를 생략하라.',
    '내레이션은 TTS 낭독용: 구어체 존댓말, 숫자는 한글로("30%"→"삼십 퍼센트") — 단 월 이름은 고유어로("10월"→"시월", "6월"→"유월") — 고유어 월은 내레이션에만 쓰고 title·titles·description·screenText·hashtags 에는 숫자 월("9월")을 쓴다. 이모지·괄호 지문 금지. 발음이 헷갈려 뜻이 뒤집히는 표현은 풀어 써라 — "새 가지"는 숫자 "세 가지"로 들리니 "새로 난 가지"처럼, 희귀 활용형("아뭅니다" 류)은 평이한 꼴("잘 아물어요")로.',
    // 이해도 감사(2026-08-11 블라인드 실측) 교훈: 문체 지침이 정의·이유 문장을 밀어내면 파생물이 원문 없이
    // 이해 불가가 된다 — 아래 우선순위 선언이 문체 블록 전체를 지배한다.
    '[우선순위] 아래 문체 지침은 표현 방식 지침이다 — 원문에서 추린 방법·이유·위험 근거 문장을 삭제하는 방식으로 이행하지 마라. 문체와 정보가 충돌하면 정보를 남기고 문체를 양보하라.',
    // 결론 의무+낭독 명료성(사용자 확정 2026-08-12): "잎 색 변화" 편 실측 — 보는 법 3갈래를 나열하고
    // 각각이 뭘 뜻하는지 한 번도 안 말해 "무얼 주장하는지 모르겠는" 영상이 됐다.
    '결론 의무: 구별·진단 소재면 각 갈래에 그것이 대개 무엇을 뜻하는지 한 마디를 붙여라("이건 대개 물 쪽 문제예요" — 통설 수준은 "대개/흔히"를 붙여 단정 가능, 사건 날조와 다르다). 영상 전체에 명시적 판정 또는 행동 결론을 최소 1개 남기고, 결론을 다음 편 예고로 대체하지 마라.',
    '낭독 명료성: 소리로만 듣고 되돌릴 수 없는 매체다 — 동음이의 전문어는 풀어 말하고("수분 나무"→"꽃가루받이 나무", "눈"→"꽃이 될 눈", "뿌리분"→"뿌리와 흙이 뭉친 덩어리"), 주어·비교 대상을 떨어낸 조각문 금지("밀리미터보다 옆 가지와 비교해요" 식 초압축 — 실측). 내레이션에서 언급하는 개수("다섯 곳")는 실제로 그 수만큼 세어 줘야 한다.',
    '문장 종결을 섞어라: 한 씬의 두 문장을 같은 어미로 끝내지 마라("~ㅂ니다"+"~ㅂ니다" 금지). 대본 전체에서 "-ㅂ니다" 종결은 절반 이하로 하고 "~요/~죠/~거든요/~는데요/~하세요"를 섞어라. 습관적 설명 현재형("치웁니다", "심지 않습니다")은 청자에게 말 거는 꼴("치우세요", "지금은 심지 마세요")로. 아나운서 원고가 아니라 옆에서 알려주는 말로 들려야 한다.',
    '대본 전체 1~2곳에 사람 말의 결을 넣어라 — 짧은 제동("잠깐,"), 정정·양보("아, 포트묘는 예외예요"), 판단의 표명("색보다 끝알부터 봐요" — "나는/저는" 같은 1인칭 주어는 쓰지 마라, 주어 없이도 시점이 전달된다. 사용자 확정 2026-08-12). 겪지 않은 사건·일화를 지어내는 것은 금지(판단·관점만). 정보 밀도를 깎는 잡담도 금지. 판단 문장은 근거·이유 문장을 밀어내고 그 자리를 차지하게 하지 마라 — 근거에 덧붙이는 한 줄이다. "X가 아니라 Y" 재정의 문형은 대본 전체 1회 이하 — 앞 편들이 이미 상투로 만든 틀이다.',
    `본문 씬 내레이션은 1~3문장(합쳐서 30~70자, 낭독 5~12초) — "방법 한 문장+이유 한 문장"이 기본형이다. 리듬만 변주하라: 이유를 먼저 두는 씬, 질문으로 끝나는 씬을 최소 1개 섞되(단, 씬당 "무엇을+왜"는 유지 — 리듬을 바꾸라는 것이지 정보를 빼라는 것이 아니다), 질문으로 끝냈으면 그 답을 반드시 바로 다음 씬 첫 문장에서 준다. "~기 때문입니다"는 대본 전체 1회 이하. 씬2(전제)는 45~70자까지 허용. 훅·CTA 씬은 1~2문장(20~40자). 총 낭독 시간 ${Math.max(20, capSec - 25)}~${capSec - 10}초, 대본 전체(모든 씬 내레이션 합) ${budgetChars}자 이내를 반드시 맞춘다 — TTS 실측 속도는 초당 약 6자다. 이 총량이 씬 수보다 우선한다(넘칠 것 같으면 씬 수를 줄여서라도 지켜라).`,
    `압축 안전선: ${capSec}초에 맞추더라도 조사·주어는 남겨라("이 시기 질소 거름 주면" 금지 → "이 시기엔 질소 거름을 주면"). 앞 문장의 주어가 바뀌면 새 주어를 밝혀라. screenText 에 "정의·구분법·요약·정리" 같은 대본용 딱지를 쓰지 마라 — 화면에는 독자에게 하는 말만.`,
    'screenText 는 씬당 1줄 15자 이내 키워드 요약(비워도 됨).',
    // CTA 결론 카드(2026-08-28 사용자 요청) — 결론이 소리로만 지나가면 무음 시청자에게 아무것도 안 남는다.
    // 실측(short_6c8936f791): 내레이션은 "허리 높이면 회양목, 어깨 높이 상록이면 사철나무"인데 화면엔 "자리별 나무 정하기".
    'CTA 씬에는 takeaways 를 채워라 — 이 영상의 결론("무얼 하라/무얼 골라라")을 "조건 → 답" 쌍 1~3개로 화면에 띄운다(when=시청자가 자기 상황을 알아보는 조건, then=그때의 답, 각 12자 이내). 예: {"when":"허리 높이","then":"회양목"}. 답은 화면이 지고 내레이션은 기준·이유를 말한다(사용자 확정 2026-08-28) — 그러니 내레이션이 수종명·품목명을 일일이 읊지 않아도 되고, takeaways 가 내레이션을 그대로 복창할 필요도 없다. 다만 **답의 근거는 반드시 원문(블로그 초안)에 있어야 한다** — 원문에 없는 답을 화면에 지어 넣지 마라. 화면에만 나가는 만큼 이 항목은 내레이션보다 더 엄격히 원문에 붙어라. 조건별로 답이 갈리는 소재가 아니면 when 에 핵심 상황, then 에 할 일을 넣어라(예: {"when":"심기 전","then":"뿌리부터 확인"}). 결론이 조건과 무관한 단일 행동뿐이면 takeaways 를 생략해도 된다 — 억지로 쪼개지 마라.',
    '씬 kind(선택): 씬1="hook", 마지막 씬="cta". 본문 씬 중 어울리는 곳에만 "stat"(핵심 수치 1개: value 숫자·unit 단위·label 15자)·"list"(items 2~4개, 각 18자)·"quote"(text 40자, source 출처)·"chart"(비교 수치 2~5개가 막대그래프로 자라나는 연출: series 각 {label 8자, value 숫자≥0}, unit 단위, highlight 강조할 막대 인덱스) — 억지 배정 금지, 애매하면 kind 생략. chart 는 내레이션이 수치 비교를 말할 때만.',
    '수치 규칙: stat.value 와 chart.series 의 value 는 원문(블로그 초안)에 있는 수치 또는 대본 구조상 자명한 숫자(단계 수·항목 수)만. 불확실하면 그 kind 를 쓰지 마라. narration 은 수치를 한글로 낭독하되 JSON 값은 아라비아 숫자. chart 씬의 screenText 에는 핵심 수치 비교를 요약하라(렌더 실패 대비).',
    'description(유튜브 설명 — 인스타 캡션에도 그대로 복제된다)은 요약투로 끝내지 마라 — "정리했습니다/담았어요/알아봅니다/알아보세요/살펴봅니다/소개합니다" 금지. "결론 한 줄 + 조건 한 줄" 꼴로 써라(예: "잎이 상한 나무는 9월에 비료를 줘도 소용없습니다. 갈변이 어디서 시작됐는지부터 보세요.").',
    shortsTitleTypeGuide(titleTypes, CONFIG.voiceRotation),
    `JSON 형식: {"title":"대표 제목","titles":[${titlesJson}],"scenes":[{"narration":"...","screenText":"...","kind":"hook|stat|list|quote|chart|cta(선택)","stat":{"value":42,"unit":"%","label":"라벨"},"items":["항목"],"quote":{"text":"인용","source":"출처"},"chart":{"series":[{"label":"봄","value":90},{"label":"가을","value":70}],"unit":"%","highlight":0},"takeaways":[{"when":"허리 높이","then":"회양목"}]}],"description":"2~3줄","hashtags":["#니치","#범용","#shorts"],"next":{"topic":"다음 편 주제(예고했을 때만)","window":"9월"}}`,
  ].filter(Boolean).join('\n');
  type PlanRaw = { title?: unknown; titles?: unknown[]; scenes?: Array<{ narration?: unknown; screenText?: unknown; kind?: unknown; stat?: unknown; items?: unknown; quote?: unknown; takeaways?: unknown }>; description?: unknown; hashtags?: unknown; next?: { topic?: unknown; window?: unknown } };
  const sys = '당신은 유튜브 숏폼 작가입니다. 요청된 JSON 스키마만 출력합니다.';
  // 고유어 월은 내레이션(TTS) 전용 — 화면·검색 필드는 숫자 월로 되돌린다(권고 5, 결정적).
  // 단 키워드 정확 표기가 깨지는 경우는 원문을 유지한다: 키워드 규칙(사용자 확정 자산)이 우선이다.
  const numMonth = (t: string): string => {
    if (!CONFIG.voiceRotation) return t; // 이 태스크(권고 5)의 되돌림 레버 하나로 묶는다 — .env.example 참조
    const out = monthWordOutsideNarration(t);
    return keyword && t.includes(keyword) && !out.includes(keyword) ? t : out;
  };
  const parsePlan = (j: PlanRaw | null): Plan | null => {
    if (!j || !Array.isArray(j.scenes) || !j.scenes.length) return null;
    const scenes = j.scenes.slice(0, maxScenes).map((s) => ({
      narration: cleanNarration(s?.narration),
      screenText: numMonth(stripEmoji(String(s?.screenText ?? '')).trim()).slice(0, 20),
      ...normalizeSceneKind(s), // 불량 페이로드는 {} 강등 — 기본 씬으로 렌더
    })).filter((s) => s.narration);
    if (scenes.length < 3) return null;
    const titles = (Array.isArray(j.titles) ? j.titles : []).map((t) => numMonth(stripEmoji(String(t ?? '')).trim())).filter(Boolean).slice(0, 3);
    const next = j.next && typeof j.next.topic === 'string' && j.next.topic.trim()
      ? { topic: j.next.topic.trim().slice(0, 120), window: typeof j.next.window === 'string' && j.next.window.trim() ? j.next.window.trim() : undefined }
      : undefined;
    // 대표 제목 키워드 보정(결정적) — 종전엔 topic(블로그 SEO 제목, 키워드 강제 산물)을 작가가 채택할 때만
    // 우연히 포함됐다. 키워드 없는 창의 제목이 뽑히면 후보·topic 중 키워드 포함본으로 교체(없으면 원본 유지).
    // includes 검사는 60자 슬라이스 '결과'에 — 자르기 전 검사는 키워드가 경계 밖이면 도로 잘린다(리뷰 지적).
    let title = numMonth(stripEmoji(String(j.title ?? '')).trim()).slice(0, 60) || titles[0] || topic;
    if (keyword && !title.includes(keyword)) {
      const alt = [...titles, topic].map((t) => t.slice(0, 60)).find((t) => t.includes(keyword));
      if (alt) title = alt;
    }
    return {
      title,
      titles: titles.length ? titles : [topic],
      scenes,
      description: numMonth(String(j.description ?? '').trim()).slice(0, 500),
      hashtags: normalizeHashtags((Array.isArray(j.hashtags) ? j.hashtags : []).map((t) => numMonth(String(t ?? '')))),
      ...(next ? { next } : {}),
    };
  };
  // 예산 3000(CLI 상한 ×3=9000) — 문체 제약 투입(2026-08-11) 후 사고량 증가로 종전 2200(6600)이
  // 즉시 초과됐다(실측: 테스트 런 2건 연속 "exceeded 6600 output token maximum").
  let plan = parsePlan(await callRoleJSON<PlanRaw>(io, 'shorts_writer', sys, user, 3000, true));
  if (!plan) {
    // 파싱 불가·미완결 JSON 1회 재시도(카드뉴스와 동일 패턴) — 실측 2026-08-11 "보리수나무묘목" 런이
    // 단발 실패로 통째 죽었다. 재시도는 완결 JSON 강조 + 토큰 여유 상향.
    plan = parsePlan(await callRoleJSON<PlanRaw>(io, 'shorts_writer', sys,
      `${user}\n\n반드시 완결된 JSON 하나만 출력하라(설명·마크다운 코드펜스 금지).`, 3400, false));
  }
  if (!plan) return null;
  // 단독 이해 검산 — 원문을 안 본 시청자 관점 텍스트 검사 후 1회 수정 라운드(fail-open, 실측 2026-07-29 결함 대응).
  try {
    // 원문 핵심 축 요약(제목+소제목) — 검산의 '원문 정합' 항목 입력. 파생이 아니면 undefined(검사 생략).
    const sourceCore = sourceBody
      ? [topic, ...sourceBody.split('\n').filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim())]
          .filter(Boolean).slice(0, 8).join(' · ')
      : undefined;
    // 원문 정합(스펙 §2-4) — 파생물이 원문에 없는 사실을 새로 지어내거나 원문 결론을 뒤집는지 대조(fail-open).
    // 결론 카드를 함께 싣는다(2026-08-28) — 사용자 확정 분업에서 답은 화면에만 있다. 내레이션만 보여 주면
    // 정합 판정이 '답이 없는 대본'을 보게 되고, 화면의 답은 아무 검사도 받지 않는다.
    const sceneTexts = (p: Plan): string[] => p.scenes.map((s) => `${s.narration}${s.screenText ? ` (자막: ${s.screenText})` : ''}`
      + (s.takeaways?.length ? ` (결론: ${s.takeaways.map((t) => `${t.when} → ${t.then}`).join(', ')})` : ''));
    // FACT_GATE=off 면 LLM 정합 1차·잔존 판정을 통째로 건너뛴다(킬스위치가 실제로 꺼져야 한다 — 2026-08-26 최종 리뷰 F1):
    // parity 가 빈 배열이면 정합 지적이 수정 라운드 입력에서도 빠지고, 아래 소스별 캡의 'parity ≤2' 몫이
    // 비어 상한이 13 이 된다(다른 소스는 그대로).
    // 단 2026-08-27(권고 1) 이후로 plan.factGate 자체는 FACT_GATE=off 여도 붙을 수 있다 — 아래 잔존 블록이
    // (parity.length || timingResidual.length) 라, **자기 킬스위치(TIMING_PARITY)** 로 사는 시기·수치만
    // 잔존해도 열린다. 그때 status 는 parityToInfo([]) 의 'pass' 라 보류(hold)가 생기지 않는다(표시 전용).
    // 둘 다 끄려면 FACT_GATE=off + TIMING_PARITY=off.
    const parity = CONFIG.factGate && sourceBody ? await parityIssues('유튜브 숏폼 대본(씬 내레이션)', sceneTexts(plan), sourceBody, io.signal) : [];
    // 단독 이해 검산(LLM, 최대 5건) — 소스별 예약 캡의 몫 계산을 위해 먼저 변수로 받는다.
    // 결론 카드를 함께 넘긴다(2026-08-28) — 이 검사의 항목 4가 '결론 부재'다. 사용자 확정 분업에서
    // 답은 화면에만 있으므로, 내레이션만 보여 주면 잘 만든 CTA 가 매번 '결론 없음'으로 걸린다(과차단).
    // 판정자가 화면에 뜬 답까지 보고 나서 결론 유무를 판단하게 한다.
    const standalone = await standaloneIssues('유튜브 숏폼 대본(씬 내레이션)',
      plan.scenes.map((s) => `${s.narration}${s.takeaways?.length ? ` [화면 결론: ${s.takeaways.map((t) => `${t.when} → ${t.then}`).join(', ')}]` : ''}`),
      topic, keyword, io.signal, sourceCore);
    // 문체 결정적 린트(2026-08-11) — 프롬프트 지시만으로는 샌다는 실측("새 가지" 위반) 대응, 같은 수정 라운드에 얹는다.
    // 소스별 예약(2026-08-26 리뷰 수선) — 결정적 린트(문체·훅)를 앞에 둬 프롬프트-only 실측 누출 방지를
    // 우선 보장하고, LLM 판정(단독 이해·정합)은 각 소스당 상한을 둬 한쪽이 다른 쪽을 밀어내지 못하게 한다.
    // 시기·수치 원문 대조(2026-08-27 권고 1, 결정적) — 활엽수 실사고: 블로그가 "근거 확실치 않다"고 한 시기를
    // 파생 쇼츠가 내레이션·자막·오버레이 세 군데에서 단정했다. TIMING_PARITY=off 면 함수가 빈 배열을 낸다.
    const timing = sourceBody ? timingParityIssues(sourceBody, timingFields(plan)).map(formatTimingIssue) : [];
    // 원문 미검증 주장 승계(2026-08-28 처방 C, 결정적) — 실사고: 블로그 게이트가 hold 인데 파생 숏폼은 pass 였고,
    // 원문에서 '근거 미확인'으로 분류된 손질 시기가 그대로 화면 목록에 떴다. 기존 두 축(정합·시기수치)은
    // "원문에 충실한가"만 봐서 통과시킨다 — 이 축이 "원문이 애초에 믿을 만한가"를 본다.
    const inherited = (sourceFlagged.length ? inheritedClaims(sourceFlagged, timingFields(plan)) : []).map(formatInherited);
    // 소스별 캡 합 최대 20(narrationStyleIssues ≤5 + hookKeywordLeadIssues ≤1 + standalone ≤4 + parity ≤2 + 시기·수치 ≤3 + 승계 ≤2 + 설명 요약투 ≤1 + 자막 딱지 ≤2) —
    // 이미 소스별로 상한을 뒀으므로 최종 캡을 또 씌우면 뒤 소스(정합)만 밀려나는 desync 가 재발한다. 최종 캡 없음.
    const probs = [
      ...narrationStyleIssues(plan.scenes.map((s) => s.narration)),
      // 훅 키워드 낭독 결정적 린트(2026-08-20) — 프롬프트 지시 단독은 샌다는 실측 전례(문체 린트와 동일 사상).
      ...hookKeywordLeadIssues(plan.scenes.map((s) => s.narration), keyword),
      ...standalone.slice(0, 4),
      ...parity.slice(0, 2),
      ...timing.slice(0, 3),
      // 승계 지적(처방 C) — 소스별 예약 캡 원칙 그대로 몫을 준다(≤2). 위 캡 합 주석의 총계에 포함.
      ...inherited.slice(0, 2),
      // 설명 요약투(2026-08-27 권고 2, 결정적) — description 은 유튜브 설명이자 인스타 캡션이다.
      // 새 콜을 만들지 않고 기존 수정 라운드에 얹는다(= 플랜이 말하는 "1회 재생성").
      // META_SUMMARY_LINT 게이트(Fix wave 소견 4) — 블로그 meta 재시도와 같은 레버로 함께 꺼진다.
      ...descriptionLintIssues(plan.description),
      // 자막 대본 딱지(2026-08-27 권고 5, 결정적) — screenText 가 "정의/구분법/요약" 같은 목차 라벨로 끝나면
      // 화면이 강의 슬라이드처럼 읽힌다. 프롬프트 지시(압축 안전선)의 2차 방어, 비차단.
      // VOICE_ROTATION 게이트 — 이 태스크가 넣은 동작은 스위치 하나로 전부 되돌아간다.
      ...(CONFIG.voiceRotation ? screenTextLabelIssues(plan.scenes.map((s) => s.screenText ?? '')).slice(0, 2) : []),
    ];
    let planChanged = false;
    if (probs.length) {
      const m = `단독 이해·문체 검산 — ${probs.length}건 → 수정 라운드 (${probs[0]?.slice(0, 50)})`;
      console.log(`[숏폼] ${m}`); io.bus?.emit('log', { message: m });
      const fixed = parsePlan(await callRoleJSON<PlanRaw>(io, 'shorts_writer', sys,
        `${user}\n\n[단독 이해·문체 검산 실패 — 아래 문제를 고쳐 같은 JSON 스키마로 완결 출력하라(설명 금지)]\n${probs.map((p) => `- ${p}`).join('\n')}`, 3400, false));
      // 수정본 파싱 실패 시 원본 유지. 수정 라운드가 대본만 고치고 메타(제목 후보·설명·해시태그)를
      // 빠뜨려도 원본 것을 승계(무손실 병합 — parsePlan 의 [topic] 폴백 제목이 원본을 덮지 않게).
      if (fixed) {
        plan = {
          ...fixed,
          titles: fixed.titles.length > 1 ? fixed.titles : plan.titles,
          description: fixed.description || plan.description,
          hashtags: fixed.hashtags.length ? fixed.hashtags : plan.hashtags,
        };
        planChanged = true;
      }
    }
    // dataviz 오버레이 결정적 제거(권고 1) — 반드시 수정 라운드 '뒤'에: 앞에서 떼면 작가가 같은 값을
    // 그대로 다시 실어 보내고(수정본은 parsePlan→normalizeSceneKind 를 새로 통과한다) 제거가 무효가 된다.
    if (sourceBody) {
      const st = stripUnsourcedStatOverlays(plan.scenes, sourceBody);
      if (st.removed.length) {
        plan = { ...plan, scenes: st.scenes };
        for (const v of st.removed) {
          const m3 = `오버레이 수치 원문 부재 → 제거 — "${v}"`;
          console.log(`[숏폼] ${m3}`); io.bus?.emit('log', { message: m3 });
        }
      }
    }
    // 시기·수치 잔존(권고 1) — 오버레이 제거까지 끝난 최종 대본 기준. LLM 재호출 없음(결정적).
    const timingResidual = sourceBody ? timingParityIssues(sourceBody, timingFields(plan)).map(formatTimingIssue) : [];
    // 승계 잔존(처방 C) — 수정 라운드 뒤 재계산. 원문 게이트가 hold 로 사람을 세운 사안을 파생물에서도
    // 보이게 하는 것이 이 축의 목적이라, 잔존이 있으면 검토 알림까지 반드시 나가야 한다.
    const inheritedResidual = (sourceFlagged.length ? inheritedClaims(sourceFlagged, timingFields(plan)) : []).map(formatInherited);
    // 설명 요약투 잔존(권고 2) — 수정 라운드 뒤 최종 description 기준. 로그만(발행 차단 없음).
    if (metaSummaryIssues(plan.description).length) console.log(`[메타] 요약투 잔존 — "${plan.description.slice(0, 60)}"`);
    // 원문 정합 잔존(스펙 §2-4) — 정합 문제로 수정 라운드가 돌았을 때만 1회 재판정(비용). 표시 전용.
    // 수정본 파싱 실패(planChanged=false) 는 대본이 1차 판정 때와 바이트 동일 — LLM 재호출 없이 1차 parity 를 그대로 잔존으로 재사용한다.
    // 시기·수치만 잔존해도 factGate 를 붙인다(그래야 텔레그램 줄이 나간다) — 단 status 는 정합 판정이 정한다:
    // 결정적 비차단 린트가 보류(hold)를 만들어 자동 임시저장까지 막아서는 안 된다.
    if ((parity.length || timingResidual.length || inheritedResidual.length) && sourceBody) {
      const base = parity.length
        ? (planChanged
          ? parityToInfo(await parityIssues('유튜브 숏폼 대본(씬 내레이션)', sceneTexts(plan), sourceBody, io.signal))
          : parityToInfo(parity))
        : parityToInfo([]);
      // timing 은 자르지 않고 통째로 싣는다 — 텔레그램 머리줄 N 은 잔존 '건수'라, 여기서 5건으로 자르면
      // 8건이 "5건"으로 나간다(Fix round 1). 예시 줄 캡(2줄)은 factGateLines 가 표시 시점에 씌운다.
      // 승계 잔존을 timing 칸에 합류시킨다 — FactGateInfo 스키마를 늘리지 않고 기존 표시 경로(factGateLines)를
      // 그대로 탄다. 두 축 다 '결정적·비차단·표시 전용'이라 성격이 같다(status 는 정합 판정이 정한다).
      const displayResidual = [...timingResidual, ...inheritedResidual];
      const factGate = displayResidual.length ? { ...base, timing: displayResidual } : base;
      plan = { ...plan, factGate };
      if (factGate.status === 'hold') { const m2 = `원문 정합 잔존 ${factGate.unsupported.length}건 — 검토 메시지에 표시`; console.log(`[숏폼] ${m2}`); io.bus?.emit('log', { message: m2 }); }
      if (timingResidual.length) { const m4 = `시기·수치 원문 불일치 잔존 ${timingResidual.length}건 — 검토 메시지에 표시`; console.log(`[숏폼] ${m4}`); io.bus?.emit('log', { message: m4 }); }
      if (inheritedResidual.length) { const m5 = `원문 미검증 주장 승계 잔존 ${inheritedResidual.length}건 — 검토 메시지에 표시`; console.log(`[숏폼] ${m5}`); io.bus?.emit('log', { message: m5 }); }
    }
  } catch { /* 무해 */ }
  // quote 출처 가드 — factGate 등 위에서 채운 필드는 pruneQuoteSources 가 그대로 스프레드 보존한다(fail-open).
  try {
    const pq = pruneQuoteSources(plan, sourceBody);
    if (pq.pruned) {
      const m = `quote 출처 ${pq.pruned}건 제거 — 원문에 없는 출처 라벨`;
      console.log(`[숏폼] ${m}`); io.bus?.emit('log', { message: m });
    }
    return pq.plan;
  } catch { return plan; }
}

async function designScenes(io: JobIO, topic: string, plan: Plan): Promise<{ preset: string; style: string; prompts: string[] }> {
  const user = [
    `[주제] ${topic}`,
    '[씬 — 내레이션 요지]',
    ...plan.scenes.map((s, i) => `${i + 1}. ${s.narration.slice(0, 60)}${s.screenText ? ` (자막: ${s.screenText})` : ''}`),
    '',
    `각 씬의 세로(9:16) 배경 이미지 프롬프트를 설계하라. scenes 는 정확히 ${plan.scenes.length}개.`,
    '이미지 안 글자 금지.',
    'style_preset 은 주제·내용·톤에 어울리게 선택하라 — photorealistic 을 기본값처럼 고르지 말 것. photorealistic=실물 시연·하우투·생활, manhwa=스토리·유머·과장, watercolor=감성·계절·에세이, ink_wash=차분한 전통·사색적 주제, flat_design=정보·정책·경제·비교·수치, retro_poster=이벤트·프로모션·복고.',
    'JSON 형식: {"style_preset":"photorealistic|manhwa|watercolor|ink_wash|flat_design|retro_poster","style":"모든 씬 공통 스타일 문구(팔레트·질감·조명)","scenes":[{"prompt":"장면 묘사(한국어 150자 이내)"}]}',
  ].join('\n');
  const j = await callRoleJSON<{ style_preset?: unknown; style?: unknown; scenes?: Array<{ prompt?: unknown }> }>(
    io, 'shorts_director', '당신은 숏폼 영상 디렉터입니다. 요청된 JSON 스키마만 출력합니다.', user, 1800, true,
  );
  const rawPreset = String(j?.style_preset ?? '').trim();
  const preset = PRESETS.has(rawPreset) ? rawPreset : (PRESET_ALIAS[rawPreset] ?? 'photorealistic');
  const style = String(j?.style ?? '').trim().slice(0, 200) || '밝고 깔끔한 한국 생활 사진풍, 부드러운 자연광';
  const prompts = plan.scenes.map((s, i) => {
    const p = String(j?.scenes?.[i]?.prompt ?? '').trim().slice(0, 200);
    return p || `${topic} 를 상징하는 한국 생활 장면, ${s.narration.slice(0, 30)} 분위기`;
  });
  return { preset, style, prompts };
}

/**
 * 숏폼 씬 이미지(gpt-image-2, 세로 9:16) 프롬프트 조립 — shorts-gen 의 스타일 일관성(전 씬 공통 앵커
 * 반복) + 시네마토그래피(구도·조명·씬 변주). 자막·내레이션은 렌더러가 얹으므로
 * 이미지엔 글자를 넣지 않는다(오타 원천 차단). 순수 함수(생성 없이 프롬프트 검증 가능).
 */
export function buildSceneImagePrompt(a: {
  style: string; scene: string; index: number; total: number;
}): string {
  const { style, index: i, total } = a;
  const scene = a.scene.trim() || '주제를 상징하는 한국 생활 장면';
  const isHook = i === 0;
  const p: string[] = [];
  p.push(`[전 씬 공통 스타일] ${style}`);
  p.push(`장면(씬 ${i + 1}/${total}${isHook ? ', 훅' : ''}): ${scene}.${isHook ? ' 첫 3초에 스크롤을 멈출, 가장 시선을 끄는 강렬한 장면으로 연출한다.' : ''}`);
  p.push('구도: 세로 9:16 프레임을 피사체로 자연스럽게 채운다.');
  p.push('시네마토그래피: 얕은 심도와 부드러운 조명으로 피사체를 또렷하게. 이전 씬과 구분되는 앵글·피사체·범위로 변주하되, 전 씬 공통 팔레트·질감·조명을 동일하게 유지해 시리즈 일관성을 낸다.');
  p.push('금지: 이미지 안에 글자·자막·숫자·로고·워터마크·간판 텍스트를 넣지 않는다(자막은 렌더러가 따로 얹는다). 손·손가락 왜곡과 어색한 합성을 피한다.');
  return p.join('\n');
}

/** 숏폼 생성 잡 — launch 래퍼가 버스·시그널을 주입(오피스 뷰 연동). 프론트는 GET 폴링. */
export async function runShortsJob(
  id: string,
  opts: {
    sourceBody?: string; sceneCount?: number; bus?: EventBus; signal?: AbortSignal;
    /** 원문(블로그) 사실 게이트가 건 주장 — unsupported + unverified. 파생물에 재등장하면 승계 표시(처방 C). */
    sourceFlagged?: string[];
  } = {},
): Promise<void> {
  const store = shortsStore();
  const short = store.get(id);
  if (!short || RUNNING.has(id)) return;
  RUNNING.add(id);
  const dir = store.dirFor(id);
  const io: JobIO = { bus: opts.bus, signal: opts.signal };
  const say = (m: string): void => { console.log(`[숏폼] ${m}`); opts.bus?.emit('log', { message: m }); };
  const checkAbort = (): void => { if (opts.signal?.aborted) throw new Error('취소됨'); };
  try {
    fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true });
    // 씬 수 — 명시 요청(opts.sceneCount)이 없으면 런별 구조 시드가 정한다(4~6, 2026-08-27 권고 4).
    // 상한 역산(씬당 최소 ~8초 = 낭독+연출)은 그대로 씌운다: 40초 상한에서는 실질 4~5씬이고 6씬은
    // 상한 48초부터 열린다. 시드 off 는 종전 기본값 5씬(= min(6, 8, floor(40/8)))과 같은 값이다.
    const seed = currentStructureSeed();
    const n = Math.min(Math.max(4, opts.sceneCount ?? seed.shortsScenes), 8, Math.max(4, Math.floor(CONFIG.shortsMaxDurationSec / 8)));

    // 1) 기획 — 대본(훅·씬·내레이션·자막)·제목 3후보·설명·해시태그
    store.update(id, { stage: 'planning' });
    opts.bus?.emit('phase', { team_id: 'shorts', phase: 'work' });
    // 같은 주제 기존 숏폼이 있으면 '관점 다르게' 주입(자기 자신·같은 글 파생 형제 제외).
    const priorCoverage = priorCoverageBrief('숏폼', short.topic, short.keyword, { excludeId: short.id, excludeSourcePieceId: short.sourcePieceId, brandSlug: short.brand });
    // 반복 상투구 회피(2026-08-06) — 화면텍스트·훅 층위 반복은 주제 대조로 안 잡힌다. 최근 숏폼
    // 화면텍스트 코퍼스에서 문서빈도로 채굴해 금지 목록으로 주입(소재어는 stems 보호).
    const ticPhrases = recentPhrasesToAvoid('숏폼', short.brand, { stems: getBrand()?.compoundStems ?? [] });
    const phraseBlock = ticPhrases.length
      ? `[반복 표현 금지] 최근 숏폼들에서 이미 여러 번 쓴 표현이다 — 내레이션·화면텍스트에 쓰지 말고 다른 어휘·접근으로 풀어라: ${ticPhrases.map((p) => `'${p}'`).join(', ')}`
      : '';
    // 훅·CTA 문형 로테이션(2026-08-11) — 훅 질문-반전 공식 7/15편·CTA "계속 기록" 7/15편 실측.
    // 지시문 단독은 새므로 최근 편의 원문을 직접 보여주고 "겹치면 다시 써라"로 못박는다.
    const hooksBlock = recentHooksToAvoid(short.brand, short.id);
    // 제목 유형 로테이션(2026-08-27 권고 5) — 고정 3종(정보형·후킹형·질문형)이 채널 지문이 됐다.
    // 유형 풀 5종에서 런마다 3개, 질문형은 최근 3편 중 1편 이하. off 면 종전 고정 3종.
    const titleTypes = CONFIG.voiceRotation
      ? pickTitleTypes(recentShortsTitles(short.brand, short.id), { keywordFirst: !!short.keyword })
      : ['정보형', '후킹형', '질문형'];
    say(`기획 가드 — 유사주제 ${priorCoverage ? '주입' : '해당없음'} · 반복표현 ${ticPhrases.length}건 · 훅/CTA 로테이션 ${hooksBlock ? '주입' : '해당없음'} · 제목 유형 ${titleTypes.join('·')}`);
    const planned = await planShorts(io, short.topic, short.keyword, opts.sourceBody, n, [priorCoverage, phraseBlock, hooksBlock, OVERUSED_LEXEME_GUIDE].filter(Boolean).join('\n\n'), titleTypes, opts.sourceFlagged ?? []);
    if (!planned) throw new Error('기획 실패 — 작가 JSON 응답을 해석할 수 없습니다');
    // Plan 타입 재선언 — 길이 상한 루프의 재대입이 클로저(씬 map 등) 내로잉을 풀지 않게 non-null 로 고정.
    let plan: Plan = planned;
    // 길이 상한 집행(사용자 확정 2026-08-14: 총 60초 이내) — 예산 초과 대본은 1회 압축.
    const fit = await fitShortsPlanToDuration(io, plan);
    if (fit.compressed) say(`대본 감량 — ${fit.beforeChars}→${fit.afterChars}자(길이 상한 ${CONFIG.shortsMaxDurationSec}초 예산)`);
    plan = fit.plan;
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
    say(`대본 완성 — ${plan.title.slice(0, 30)} · 씬 ${plan.scenes.length}개 · 낭독 ~${Math.round(shortsNarrationChars(plan) / SHORTS_TTS_CPS)}초 추정`);
    checkAbort();

    // 2) 디자인 — 씬별 세로 비주얼 프롬프트(전 씬 일관 스타일 + 장면 변주)
    store.update(id, {
      stage: 'designing', title: plan.title, titles: plan.titles,
      description: plan.description, hashtags: plan.hashtags,
      ...(plan.factGate ? { factGate: plan.factGate } : {}),
    });
    // 디렉터를 engaged 웨이브에 배선 — standby 팀은 org 와 달리 delegation 이벤트가 없어,
    // 디자인 단계 내내 오피스가 디렉터를 유휴·배회로 그리고 WORKING 칩도 0 이었다(수선 2026-08-12).
    opts.bus?.emit('delegation', { team_id: 'shorts', from: 'shorts_writer', to: 'shorts_director', summary: '씬 비주얼 연출' });
    const design = await designScenes(io, short.topic, plan);
    say(`디자인 확정 — ${design.preset} · ${design.style.slice(0, 40)}`);
    checkAbort();

    // 3) 씬 이미지 — 세로 1024×1536, 무텍스트(자막·내레이션은 렌더러가 얹음)
    store.update(id, { stage: 'rendering' });
    opts.bus?.emit('phase', { team_id: 'shorts', phase: 'integrate' });
    say(`씬 이미지 생성 시작 — gpt-image-2 세로 ${plan.scenes.length}장`);
    const bgDraft = {
      imageSlots: plan.scenes.map((s, i) => ({
        alt: s.screenText || s.narration.slice(0, 30),
        prompt: buildSceneImagePrompt({ style: design.style, scene: design.prompts[i] ?? '', index: i, total: plan.scenes.length }),
      })),
    };
    const bgDraftPath = path.join(dir, 'bg-draft.json');
    const bgManifestPath = path.join(dir, 'bg-manifest.json');
    fs.writeFileSync(bgDraftPath, JSON.stringify(bgDraft, null, 2), 'utf-8');
    await generateImagesForDraft(bgDraftPath, path.join(dir, 'scenes'), bgManifestPath,
      { imageStyle: design.preset, limit: plan.scenes.length, size: '1024x1536', timeoutMs: 150_000 * plan.scenes.length },
      opts.signal);
    // 슬롯 정렬 이미지 목록 — 실패 씬은 null(렌더러가 그라데이션 폴백, 순서 보존)
    let images: Array<string | null> = plan.scenes.map(() => null);
    try {
      const m = JSON.parse(fs.readFileSync(bgManifestPath, 'utf-8')) as { images?: Array<{ file_path?: string; error?: string } | null>; dry_run?: boolean };
      if (!m.dry_run) {
        images = plan.scenes.map((_, i) => {
          const im = m.images?.[i];
          const fp = im?.file_path ? String(im.file_path) : '';
          return fp && !im?.error && fs.existsSync(fp) ? fp : null;
        });
      }
    } catch { /* 전 씬 폴백 */ }

    // 3-b) 씬 배경 비전 QA — 잡글자·구도·왜곡 불량만 재생성(claude 비전, fail-open, 엔진 독립).
    const qa = await qaSceneImages({
      dir, images, scenePrompts: bgDraft.imageSlots.map((s) => s.prompt),
      preset: design.preset, signal: opts.signal,
    });
    images = qa.images;
    if (qa.regenerated) say(`씬 QA — ${qa.regenerated}장 재생성 (${qa.issues.slice(0, 3).join(' · ')})`);
    else if (qa.issues.length) say(`씬 QA — 이슈 ${qa.issues.length}건, 재생성 없음 (${qa.issues.slice(0, 3).join(' · ')})`);
    checkAbort();

    // 3-c-i) 모션 디렉터 — 비전이 QA 통과 이미지를 '직접 보고' 씬 의도(내레이션·kind)에 맞는
    //        씬별 I2V 모션 프롬프트 설계. I2V 게이트가 닫혀 있으면 비전 호출도 생략(낭비 방지).
    const motionPrompts = i2vGate()
      ? await directSceneMotion({
          images,
          scenes: plan.scenes.map((s) => ({ narration: s.narration, screenText: s.screenText, kind: s.kind })),
          styleHint: design.style, signal: opts.signal,
        })
      : images.map(() => null);
    const directed = motionPrompts.filter(Boolean).length;
    if (directed) say(`모션 디렉팅 — ${directed}/${plan.scenes.length}씬 맞춤 연출(나머지 정적 폴백)`);
    // 사람·손·도구 씬 판별(비전이 이미지를 직접 봄) — 그 씬은 I2V 를 건너뛰고 스틸로 남긴다.
    // 프롬프트로 '정지'를 요청하는 방식은 5B 모델이 무시해 실패했다(사용자 보고 2026-08-01).
    const subjectScenes = i2vGate() ? await detectSubjectScenes(images, opts.signal) : new Set<number>();
    if (subjectScenes.size) say(`사람·손·도구 씬 ${subjectScenes.size}개 — 모션 없이 스틸 유지(형태 왜곡 방지)`);

    // I2V 컷 선정 — '정말 움직임이 필요한 핵심 컷'만 클립화(기본 1 = 훅, env SHORTS_I2V_MAX_CLIPS).
    // 탈락 씬은 Remotion 네이티브 연출(fx: push·엔터 이펙트·강도 변주)이 움직임 공백을 채운다.
    const scenePrompts = plan.scenes.map((_, i) => design.prompts[i] ?? '');
    const i2vPlan = selectI2vScenes({
      kinds: plan.scenes.map((s) => s.kind), motionPrompts, subjectScenes, scenePrompts, images,
      max: CONFIG.shortsI2vMaxClips,
    });
    if (i2vGate()) say(`I2V 컷 선정 — ${i2vPlan.allowed.size}/${plan.scenes.length}씬 (상한 ${CONFIG.shortsI2vMaxClips}${i2vPlan.reasons.length ? ` · ${i2vPlan.reasons.join(' ')}` : ''})`);

    // 3-c) 씬 배경 I2V — fal 클립화(키 없으면 no-op, 실패 씬은 스틸 폴백, fail-open).
    const cv = await i2vSceneClips({
      // 원시 장면 묘사를 넘긴다(빌드된 이미지 프롬프트 X) — 후자에는 '손·손가락 왜곡을 피한다' 는
      // 금지 문구가 항상 붙어 있어 손 판별(hasSubjectRisk)이 전 씬에 오탐했다(실측 2026-08-01).
      dir, images, scenePrompts, motionPrompts, subjectScenes, allowedScenes: i2vPlan.allowed, signal: opts.signal,
    });
    const clipCount = cv.clips.filter(Boolean).length;
    if (clipCount) say(`씬 I2V — ${clipCount}/${plan.scenes.length}장 클립화${cv.issues.length ? ` (${cv.issues[0]})` : ''}`);
    else if (cv.issues.length) say(`씬 I2V — 클립 0장 (${cv.issues.slice(0, 2).join(' · ')})`);
    checkAbort();

    // 3-c-ii) 클립 비전 QA — 중간 프레임 검수(형태 붕괴·물체 출현·유령 글자·내레이션 모순),
    //         불량 클립만 QA 통과 스틸(켄번즈)로 강등. 재생성 없음 — 추가 과금 0, fail-open.
    if (clipCount) {
      const cq = await qaSceneClips({ dir, clips: cv.clips, narrations: plan.scenes.map((s) => s.narration), signal: opts.signal });
      cv.clips = cq.clips;
      if (cq.dropped) say(`클립 QA — ${cq.dropped}개 불량 → 스틸 폴백 (${cq.issues.slice(0, 2).join(' · ')})`);
      checkAbort();
    }

    // 4) 조립 — 기본 Remotion 모션그래픽, 실패 시 ffmpeg 슬라이드쇼로 폴백(무중단).
    say(CONFIG.shortsRenderer === 'ffmpeg' ? '영상 조립 시작 — ffmpeg 슬라이드쇼' : '영상 조립 시작 — Remotion 모션그래픽');
    let titleArt: Awaited<ReturnType<typeof generateTitleArt>> = null;
    if (CONFIG.shortsRenderer !== 'ffmpeg' && CONFIG.shortsTitleOverlay) {
      // 상단 제목 캘리(썸네일과 같은 카피, 투명 PNG) — 렌더 전에 생성해야 오버레이 가능. 실패해도 무해(오버레이 생략).
      titleArt = await generateTitleArt({ dir, title: plan.title, description: plan.description, titles: plan.titles, keyword: short.keyword, signal: opts.signal });
      checkAbort(); // 취소가 '스킵' 메시지로 위장되지 않게 — abort 는 null 로 삼켜져 나온다
      say(titleArt ? '상단 제목 캘리 생성 완료' : '상단 제목 캘리 스킵(오버레이 없이 진행)');
    }
    // 조립 1회(Remotion → ffmpeg 폴백 체인) — 길이 상한 재조립(아래 하드 캡)이 재사용하므로 클로저로 묶는다.
    // imgs·clps 를 인자로 받는 이유: 결정적 트리밍이 씬을 제거하면 씬별 이미지·클립 배열도 같이 줄어야 한다.
    const assemble = async (p: Plan, imgs: Array<string | null>, clps: typeof cv.clips): Promise<Awaited<ReturnType<typeof renderShortsVideo>>> => {
      let rr = null as Awaited<ReturnType<typeof renderShortsVideo>> | null;
      if (CONFIG.shortsRenderer !== 'ffmpeg') {
        try {
          rr = await renderShortsVideoRemotion(dir, p.scenes, imgs, {
            clips: clps, signal: opts.signal,
            // 자막 옵션 — 위치(플랫폼 UI 가림 회피)·키워드 강조색(설정 기반, A/B 선택 후 기본값 확정).
            caption: {
              bottomPct: CONFIG.shortsCaptionBottomPct,
              fontPx: CONFIG.shortsCaptionFontPx,
              hookFontPx: CONFIG.shortsCaptionHookFontPx,
              ...(CONFIG.shortsCaptionKeyword && short.keyword ? { keyword: short.keyword } : {}),
              ...(CONFIG.shortsCaptionOutline ? { outline: true } : {}),
            },
            ...(titleArt ? { title: { imagePath: titleArt.imagePath, topPct: CONFIG.shortsTitleTopPct, widthPct: CONFIG.shortsTitleWidthPct } } : {}),
          });
        }
        catch (e) { say(`모션 렌더 예외 → ffmpeg 폴백: ${e instanceof Error ? e.message.slice(0, 80) : e}`); rr = null; }
      }
      if (!rr || !rr.ok) {
        // 실패 사유 동봉(2026-08-08) — 종전엔 r.issues 를 버려 "왜 폴백했나"를 사후 추적할 수 없었다(관측 공백).
        if (rr) say(`모션 렌더 실패 → ffmpeg 슬라이드쇼로 폴백${rr.issues.length ? ` (${rr.issues.join(' · ').slice(0, 140)})` : ''}`);
        // 폴백에도 상단 제목 전달 — Remotion 실패 시 제목이 통째로 사라지던 실측(참나무 쇼츠) 봉합.
        rr = await renderShortsVideo(dir, p.scenes, imgs, {
          signal: opts.signal,
          ...(titleArt ? { title: { imagePath: titleArt.imagePath, topPct: CONFIG.shortsTitleTopPct, widthPct: CONFIG.shortsTitleWidthPct } } : {}),
        });
      }
      return rr;
    };
    let r = await assemble(plan, images, cv.clips);
    if (!r.ok || !r.videoPath) throw new Error(`조립 실패 — ${r.issues.join(' · ').slice(0, 250)}`);
    // 길이 상한 집행(2026-08-20) — 소프트 경고(08-14)로는 61~77초 발행이 계속됐고, 08-11 길이 폭증이
    // 유튜브 하락 변곡점과 겹치는 최대 요인으로 실측됐다. 초과 시 '실측 낭독 속도'로 예산을 역산해
    // 재감량(LLM+결정적 트리밍 마감)→재조립(최대 2회). 그래도 초과면 error 가 아니라 ⚠ ready —
    // 생성이 항상 이긴다(사용자 확정 2026-08-20: "쇼츠는 반드시 생성되어야 함", 첫 하드 캡이 60.7초
    // 를 error 로 죽인 실사고 직후 지시). 초과본 발행은 발행 핸들러 409 게이트가 따로 막는다.
    let liveIdx = plan.scenes.map((_, i) => i); // 원본 씬 인덱스 추적 — 트리밍이 씬을 제거하면 이미지·클립 매핑에 사용
    for (let round = 1; (r.durationSec ?? 0) > CONFIG.shortsMaxDurationSec && round <= 2; round++) {
      checkAbort();
      const chars = shortsNarrationChars(plan);
      const cps = chars / Math.max(1, (r.durationSec ?? 1) - 2); // 인트로(1.6초)·여백 보정한 실측 자/초
      const fit2 = await fitShortsPlanToDuration(io, plan, Math.floor((CONFIG.shortsMaxDurationSec - 5) * cps));
      if (!fit2.compressed) { say(`길이 상한 재감량 무변화(${round}/2) — 이미 최소 구성`); break; }
      liveIdx = fit2.keptScenes.map((k) => liveIdx[k]!);
      plan = fit2.plan;
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8'); // 수정요청 재조립이 같은 대본을 보게
      // 구 대본 TTS 잔존 소거 — 재조립 라운드에서 씬 TTS 가 실패하면 ffmpeg 폴백이 감량 전 mp3 를
      // 재사용해 자막(신 대본)·오디오(구 대본) 불일치 영상이 될 수 있다(리뷰 지적). 대본이 바뀌었으니 캐시 무효.
      try {
        const rdir = path.join(dir, 'remotion');
        for (const f of fs.readdirSync(rdir)) if (/^narr_\d+\.mp3$/.test(f)) fs.unlinkSync(path.join(rdir, f));
      } catch { /* 디렉토리 없음 등 — 무해 */ }
      say(`길이 상한 초과 ${r.durationSec}초 — 실측 ${cps.toFixed(1)}자/초 기준 재감량 ${fit2.beforeChars}→${fit2.afterChars}자${liveIdx.length < images.length ? ` · 씬 ${liveIdx.length}개로 축소` : ''}, 재조립(${round}/2)`);
      const r2 = await assemble(plan, liveIdx.map((i) => images[i] ?? null), liveIdx.map((i) => cv.clips[i] ?? null));
      if (!r2.ok || !r2.videoPath) break; // 재조립 실패 — 직전 완성본 유지(생성 우선)
      r = r2;
    }
    if ((r.durationSec ?? 0) > CONFIG.shortsMaxDurationSec) {
      say(`⚠ 길이 상한 잔여 초과 — ${r.durationSec}초 > ${CONFIG.shortsMaxDurationSec}초. 생성은 완료(생성 우선 원칙) — 발행 게이트가 초과본을 막으니 ✍수정요청으로 감량 후 발행`);
    }
    const finalVideoPath = r.videoPath; // 루프 재대입으로 풀린 내로잉 재확립(r2 는 ok+videoPath 확인분만 채택됨)
    if (!finalVideoPath) throw new Error('조립 실패 — 결과 영상 경로 없음');
    const fallbacks = r.issues.filter((x) => x.includes('배경 폴백')).length;

    // 캡션 파일(업로드 편의) — 제목·설명·해시태그.
    const caption = [plan.title, '', plan.description, '', plan.hashtags.join(' ')].filter((x, i) => x || i === 1 || i === 3).join('\n');
    fs.writeFileSync(path.join(dir, 'caption.txt'), caption, 'utf-8');

    store.update(id, {
      stage: 'ready', scenes: r.sceneCount, durationSec: r.durationSec, bgFallbacks: fallbacks,
      topic: plan.title || short.topic,
    });
    say(`${plan.title.slice(0, 30)} — ${r.durationSec}초 · 씬 ${r.sceneCount}개 완성${fallbacks ? ` (배경 폴백 ${fallbacks}씬)` : ''}`);
    // 검토 대기 알림(완성 영상 동봉, 50MB 초과 시 텍스트 폴백) — fire-and-forget, 실패 무해.
    {
      const done = store.get(id);
      if (done) {
        // 발송 정착 후 notifiedTs 기록 — 도중에 프로세스가 죽으면 미기록으로 남아 부팅 복구 스윕이 재발송.
        void notifyShortsReady({
          id, topic: done.topic, brand: done.brand, durationSec: r.durationSec, scenes: r.sceneCount,
          sourcePieceId: done.sourcePieceId, writer: done.writer, director: done.director, factGate: done.factGate,
        }, finalVideoPath).finally(() => { try { store.update(id, { notifiedTs: new Date().toISOString() }); } catch { /* 무해 */ } });
      }
      // 예고 대장 등록 — CTA 에 다음 편 예고를 선언했으면 약속으로 기록(자율 틱이 시기 도래 시 이행). 실패 무해.
      // brand 는 잡의 것을 명시(null=범용) — 라이브 activeBrand 로의 오귀속 방지.
      if (plan.next?.topic) {
        try {
          const pr = promiseStore().create({
            topic: plan.next.topic, window: plan.next.window,
            sourceKind: 'shorts', sourceId: id, sourceTopic: plan.title, brand: done?.brand ?? null,
          });
          if (pr) say(`예고 등록 — "${pr.topic.slice(0, 30)}"${pr.window ? ` (${pr.window})` : ''}`);
          else say('예고 등록 보류 — 미이행 약속이 가득(백로그 캡)');
        } catch { /* 무해 */ }
      }
    }

    // 디자인 썸네일 — 훅 씬 배경 위에 손글씨 제목/핵심(gpt-image). best-effort: 실패해도 완성 유지(엔드포인트가 영상 프레임 폴백).
    try {
      const hook = images.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
      const ok = await generateDesignedThumbnail({
        dir, title: plan.title, description: plan.description, titles: plan.titles, keyword: short.keyword, hookImage: hook, signal: opts.signal,
        ...(titleArt ? { copy: titleArt.copy } : {}), // 상단 제목 캘리와 같은 카피 재사용 — 영상·썸네일 문구 일치
      });
      if (ok) store.update(id, {}); // updatedTs 갱신 → 포스터 URL(?v=updatedTs) 캐시버스트, 프레임 폴백본 대신 디자인 썸네일 표시
      say(ok ? '썸네일 생성 완료' : '썸네일 생성 스킵(프레임 폴백)');
    } catch (e) { say(`썸네일 생성 건너뜀(무해): ${e instanceof Error ? e.message.slice(0, 60) : e}`); }

    // ready 이후 자동 유튜브 업로드(옵트인) — 비공개 고정. 실패해도 잡은 이미 완성(수동 재시도 가능).
    if (CONFIG.autoYtUpload) {
      // 인트로(1.6초=디자인 썸네일) 붙은 영상 업로드 + 썸네일=그 영상 첫 프레임 — 미지정 시 유튜브가
      // 중간 프레임을 자동 선택해 커버가 엉뚱해짐(실측 2026-07-22, 사용자 방침: 맨 처음이 보이게).
      const ytVideo = (await ensureShortsDownload(dir).catch(() => null)) ?? finalVideoPath;
      const ytCover = await extractFirstFrame(ytVideo, path.join(dir, 'yt-cover.jpg'), opts.signal).catch(() => null);
      const up = await uploadShortsToYoutube({
        slug: short.brand ?? '', videoPath: ytVideo,
        title: plan.title, description: plan.description, hashtags: plan.hashtags,
        blogUrl: blogUrlForPiece(short.sourcePieceId), // 원본 블로그 링크 — 자동 업로드 시점 조회(대개 발행 전이라 생략됨)
        thumbnailPath: ytCover ?? undefined,
        signal: opts.signal,
      });
      if (up.ok) { store.update(id, { youtubeId: up.videoId, youtubeUrl: up.url, youtubeTs: new Date().toISOString() }); say(`유튜브 비공개 업로드 완료 — ${up.url}`); }
      else say(`유튜브 자동 업로드 실패(수동 재시도 가능) — ${up.error}`);
    }
  } catch (e) {
    const msg = opts.signal?.aborted ? '취소됨' : e instanceof Error ? e.message.slice(0, 300) : String(e);
    store.update(id, { stage: 'error', error: msg });
    say(`${short.topic.slice(0, 30)} — 실패: ${msg}`);
  } finally {
    RUNNING.delete(id);
  }
}
