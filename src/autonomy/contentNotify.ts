/**
 * 조각별 ready(검토 대기) 알림 — 블로그·카드뉴스·쇼츠가 검토 가능해지는 순간 push.
 * 텔레그램이면 미리보기 동봉(블로그=본문 발췌, 카드뉴스=슬라이드 앨범, 쇼츠=완성 영상),
 * 웹훅(Slack/Discord)은 텍스트. 킬스위치 NOTIFY_CONTENT_READY=0, 채널 미설정 시 no-op.
 * 실패는 무해 — 알림이 라이프사이클(ready 승격·발행)을 절대 막지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { CONFIG } from '../config';
import {
  notifyConfigured, notifyWebhookOnly, telegramCreds,
  sendTelegramHtml, sendTelegramPhotos, sendTelegramVideo,
} from './notify';
import type { TgButton } from './notify';
import type { FactGateInfo } from '../content/factGate';
import { readStyleLint, readBriefGate } from '../sessions/digest';
import type { BriefGateRecord } from '../sessions/digest';

export interface BlogReadyInfo {
  id: string; title?: string; keyword?: string; seoScore?: number; brand?: string;
  /** 개정 런(자동 SEO 리비전·수동 수정요청) 산출물 — '↻ 개정본' 라벨로 원본 알림과 구분(중복 오해 방지). */
  revised?: boolean;
  /** 사실 게이트 판정 요약(스펙 §2-3) — hold·error 면 검토 알림에 보류 사유를 동봉. */
  factGate?: FactGateInfo;
}
export interface CardReadyInfo {
  id: string; topic: string; brand?: string; slides?: number; sourcePieceId?: string;
  planner?: string; designer?: string;
  factGate?: FactGateInfo;
}
export interface ShortsReadyInfo {
  id: string; topic: string; brand?: string; durationSec?: number; scenes?: number;
  sourcePieceId?: string; writer?: string; director?: string;
  factGate?: FactGateInfo;
}

/** 알림 발송 조건(킬스위치 + 채널 설정) — advancePieceReady 가 사이클 완료 알림 중복 억제 판정에도 쓴다. */
export function contentReadyNotifyEnabled(): boolean {
  return CONFIG.notifyContentReady && notifyConfigured();
}

/** 검토 링크 베이스 — STUDIO_BASE_URL(태일넷 등) 우선, 미설정·스킴 없음(링크화 불가)이면 로컬. */
export function studioBase(): string {
  return /^https?:\/\//i.test(CONFIG.studioBaseUrl) ? CONFIG.studioBaseUrl : `http://127.0.0.1:${CONFIG.port}`;
}

/** 검토 딥링크 — ?piece= 는 검토 탭 자동 선택용(프론트 2단계에서 해석, 그 전엔 스튜디오 홈으로 열림). */
export function reviewLink(pieceId?: string): string {
  return pieceId ? `${studioBase()}/?piece=${encodeURIComponent(pieceId)}` : `${studioBase()}/`;
}

/** 텔레그램 HTML 이스케이프(&·<·> — 우리가 넣는 <b> 태그 외 원문은 전부 평문). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 마크다운 → 발췌용 평문(이미지·링크·헤더·강조·코드펜스 제거, 공백 정리). 순수. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 세션 초안(draft.md 우선, 없으면 draft.json bodyMarkdown)에서 발췌를 뽑는다. 실패 시 빈 문자열. */
function readDraftExcerpt(runId: string, cap = 350): string {
  try {
    const dir = path.join(CONFIG.sessionsDir, runId);
    let md = '';
    try { md = fs.readFileSync(path.join(dir, 'draft.md'), 'utf-8'); } catch { /* 아래 폴백 */ }
    if (!md) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
      md = d.bodyMarkdown ?? '';
    }
    const text = stripMarkdown(md);
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
  } catch {
    return '';
  }
}

// 웹훅 제목용은 평문 그대로, 텔레그램 HTML 에 넣을 땐 호출측이 escapeHtml 로 감싼다(브랜드 슬러그는 자유 문자열).
const brandTag = (brand?: string): string => (brand ? ` · ${brand}` : '');
// 잘라내기는 이스케이프 전에 — HTML 을 자르면 태그·엔티티가 중간에서 끊겨 텔레그램 400 이 난다.
const clip = (s: string, cap: number): string => (s.length > cap ? `${s.slice(0, cap)}…` : s);

const blogReadyLabel = (revised?: boolean): string => (revised ? '↻ 블로그 개정본 검토 대기' : '📝 블로그 초안 검토 대기');

/**
 * 보류 표시 줄(평문, 순수) — 호출측이 escapeHtml 로 감싼다. 파생은 라벨만 '원문 정합'.
 *
 * breakdown=false 면 '근거 없음 U · 모순 C' 내역을 뺀 건수만 낸다(2026-08-26 최종 리뷰 F5b) —
 * 카드·쇼츠의 보류는 parityIssues(원문 정합) 지적을 unsupported 칸에 담아 나른 것이라 '근거 없음'이
 * 아니고 contradicted 는 구조상 항상 0 이다. 블로그(사실 게이트)만 실제 판정이라 내역을 유지한다.
 */
export function factGateLines(info: FactGateInfo | undefined, maxItems: number, label = '사실 게이트', breakdown = true): string {
  if (!info) return '';
  const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  // 시기·수치 잔존(2026-08-27 권고 1) — 결정적 검사라 LLM 정합이 pass 여도 남을 수 있다. 어느 상태에서든 붙인다.
  const timing = info.timing ?? [];
  const timingBlock = timing.length
    ? [`⚠ 원문과 다른 시기·수치 ${timing.length}건`, ...timing.slice(0, 2).map((s) => `• ${clip(s)}`)].join('\n')
    : '';
  const withTiming = (s: string): string => [s, timingBlock].filter(Boolean).join('\n');
  if (info.status === 'error') return withTiming(`⚠ ${label} 판정 실패 — 수동 검토 필요`);
  // 참고(unverified) — 근거는 없지만 보류시키지 않은 일반 상식 문장(2026-08-27 지시 ①). 구 데이터는 필드가 없다.
  const soft = info.unverified ?? [];
  if (info.status !== 'hold') {
    if (!soft.length) return timingBlock;
    return withTiming([`✅ ${label} 통과 · 근거 미확인(참고) ${soft.length}건`, ...soft.slice(0, maxItems).map((s) => `• 참고: ${clip(s)}`)].join('\n'));
  }
  const items = [...info.unsupported, ...info.contradicted].slice(0, maxItems).map((s) => `• ${clip(s)}`);
  const total = info.unsupported.length + info.contradicted.length;
  const softTail = soft.length ? ` (참고 ${soft.length}건)` : '';
  const head = breakdown
    ? `⚠ ${label} 보류 ${total}건 — 근거 없음 ${info.unsupported.length} · 모순 ${info.contradicted.length}${softTail}`
    : `⚠ ${label} 보류 ${total}건${softTail}`;
  return withTiming([head, ...items].join('\n'));
}

/** 자동 임시저장이 꺼진 동안의 안내 1줄(2026-08-27 사용자 확정) — 사람이 버튼을 눌러야 저장된다는 사실을 못 박는다. */
const MANUAL_REVIEW_LINE = '✋ 수동 검토 대기 — 아래 "네이버 임시저장" 버튼으로 저장';

/** 브리프 게이트 줄(2026-08-28) — `⚖ 브리프 반려 43/70 · 미해소 3건` + 지적 최대 2건. 순수 — 테스트 대상.
 * 통과(approved)면 빈 문자열: 정상은 알리지 않는다(줄이 늘면 반려 줄이 묻힌다).
 * 미파싱(unparsed)도 알린다 — 판정을 못 읽었다는 건 게이트가 이번 런에 작동하지 않았다는 뜻이라, 조용히
 * 넘기면 사람이 '검증됐다'고 오해한다. */
export function briefGateLines(g: BriefGateRecord | null | undefined, maxItems = 2): string {
  if (!g || g.verdict === 'approved') return '';
  const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  const score = g.score !== null && g.maxScore !== null ? ` ${g.score}/${g.maxScore}` : '';
  const head = g.verdict === 'unparsed'
    ? '⚖ 브리프 판정 미파싱 — 검증 미작동, 수동 검토 필요'
    : `⚖ 브리프 반려${score} · 미해소 ${g.unresolved.length}건`;
  return [head, ...g.unresolved.slice(0, maxItems).map((s) => `• ${clip(s)}`)].join('\n');
}

/**
 * 블로그 ready 텔레그램 메시지(HTML). 순수 — 테스트 대상(autoDraft 는 기본값만 CONFIG 에서 읽는다).
 * styleResidual = 문체 린트 수정 1회 뒤에도 남은 지적 수(2026-08-27 권고 3) — 0 이면 줄 자체가 없다.
 * briefGate = 브리프 게이트 기록(2026-08-28) — 통과·미기록이면 줄 자체가 없다.
 */
export function blogReadyHtml(p: BlogReadyInfo, excerpt: string, autoDraft = CONFIG.autoNaverDraft, styleResidual = 0, briefGate: BriefGateRecord | null = null): string {
  const meta = [p.keyword, typeof p.seoScore === 'number' ? `SEO ${p.seoScore}점` : '']
    .filter(Boolean).join(' · ');
  return [
    escapeHtml(`${blogReadyLabel(p.revised)}${brandTag(p.brand)}`),
    `<b>${escapeHtml(clip(p.title ?? '(제목 미정)', 200))}</b>`,
    meta ? escapeHtml(meta) : '',
    factGateLines(p.factGate, 3) ? escapeHtml(factGateLines(p.factGate, 3)) : '',
    // 브리프 게이트(2026-08-28) — 사실 게이트 '아래', 문체 '위'. 심각도 순서다: 본문 근거(사실) → 집필 재료의
    // 근거(브리프) → 말투(문체). 셋 다 발행을 막지 않는 표시 전용이고, 판단은 사람이 한다.
    briefGateLines(briefGate) ? escapeHtml(briefGateLines(briefGate)) : '',
    // 문체 린트 잔존(2026-08-27 권고 3) — 사실 게이트 줄 옆. 발행을 막지 않는 표시 전용이라 건수만 낸다.
    styleResidual > 0 ? escapeHtml(`✍ 문체 ${styleResidual}건 잔존`) : '',
    // 사실 게이트 줄 '아래' — 보류 사유를 먼저 읽고 버튼을 누르는 순서.
    autoDraft ? '' : escapeHtml(MANUAL_REVIEW_LINE),
    excerpt ? `\n${escapeHtml(excerpt)}` : '',
    `\n검토: ${reviewLink(p.id)}`,
  ].filter(Boolean).join('\n');
}

/** 카드뉴스 ready 캡션(HTML, 앨범 첫 장에 부착). 순수 — 테스트 대상. */
export function cardnewsCaptionHtml(c: CardReadyInfo): string {
  const staff = [c.planner, c.designer].filter(Boolean).join('·');
  return [
    escapeHtml(`🖼 카드뉴스 검토 대기${brandTag(c.brand)}`),
    `<b>${escapeHtml(clip(c.topic, 200))}</b>`,
    escapeHtml([typeof c.slides === 'number' ? `${c.slides}장` : '', staff].filter(Boolean).join(' · ')),
    factGateLines(c.factGate, 2, '원문 정합', false) ? escapeHtml(factGateLines(c.factGate, 2, '원문 정합', false)) : '',
    `검토: ${reviewLink(c.sourcePieceId)}`,
  ].filter(Boolean).join('\n');
}

/** 쇼츠 ready 캡션(HTML, 영상에 부착). 순수 — 테스트 대상. */
export function shortsCaptionHtml(s: ShortsReadyInfo): string {
  const staff = [s.writer, s.director].filter(Boolean).join('·');
  const specs = [
    typeof s.durationSec === 'number' ? `${s.durationSec}초` : '',
    typeof s.scenes === 'number' ? `씬 ${s.scenes}개` : '',
    staff,
  ].filter(Boolean).join(' · ');
  return [
    escapeHtml(`🎬 쇼츠 검토 대기${brandTag(s.brand)}`),
    `<b>${escapeHtml(clip(s.topic, 200))}</b>`,
    specs ? escapeHtml(specs) : '',
    factGateLines(s.factGate, 2, '원문 정합', false) ? escapeHtml(factGateLines(s.factGate, 2, '원문 정합', false)) : '',
    `검토: ${reviewLink(s.sourcePieceId)}`,
  ].filter(Boolean).join('\n');
}

// 발행 버튼(인라인 키보드) — callback_data 규격은 telegramBot.parseCallback 과 한 쌍("<op>:<id>", ≤64바이트).
const blogButtons = (id: string): TgButton[][] => [[
  { text: '📗 네이버 임시저장', callback_data: `bp:${id}` },
  { text: '✍ 수정요청', callback_data: `rv:${id}` },
]];
const cardnewsButtons = (id: string): TgButton[][] => [[
  { text: '📸 인스타 발행', callback_data: `cp:${id}` },
  { text: '✍ 수정요청', callback_data: `rv:${id}` },
]];
const shortsButtons = (id: string): TgButton[][] => [[
  { text: '▶️ 유튜브 업로드', callback_data: `sy:${id}` },
  { text: '🎬 릴스 발행', callback_data: `sm:${id}` },
  { text: '✍ 수정요청', callback_data: `rv:${id}` },
]];

/** 블로그 초안 ready → 발췌 미리보기 알림. fire-and-forget(void 호출) 전제, 절대 throw 하지 않는다. */
export async function notifyBlogReady(p: BlogReadyInfo, runId: string): Promise<void> {
  try {
    if (!contentReadyNotifyEnabled()) return;
    const excerpt = readDraftExcerpt(runId);
    // 문체 린트 잔존 건수 — 세션 기록(style_lint.json)에서 읽는다. 없으면 0(구 런·린트 off·기록 실패).
    // Fix round 1 — `?.issues?.length` 로 한 단계 더 방어한다(readStyleLint 의 Array 검증과 이중). 여기서 던지면
    // 바깥 try 가 삼켜 텔레그램은 물론 notifyWebhookOnly 알림까지 함께 유실된다.
    const styleResidual = (runId ? readStyleLint(runId)?.issues?.length : 0) ?? 0;
    // 브리프 게이트 기록(2026-08-28) — style_lint 와 같은 경로. readBriefGate 가 손상 기록을 null 로
    // 떨어뜨리므로 여기서 던지지 않는다(던지면 바깥 try 가 삼켜 알림이 통째로 사라진다).
    const briefGate = runId ? readBriefGate(runId) : null;
    if (telegramCreds()) await sendTelegramHtml(blogReadyHtml(p, excerpt, undefined, styleResidual, briefGate), blogButtons(p.id));
    await notifyWebhookOnly({
      title: `${blogReadyLabel(p.revised)}${brandTag(p.brand)} · ${p.title ?? '(제목 미정)'}`,
      // 웹훅에도 반려를 싣는다 — 텔레그램만 보는 게 아니다(둘 중 하나만 보는 사람이 게이트를 못 보면 안 된다).
      body: [briefGateLines(briefGate), excerpt, `검토: ${reviewLink(p.id)}`].filter(Boolean).join('\n'),
    });
  } catch { /* 무해 */ }
}

/** 카드뉴스 ready → 슬라이드 앨범 알림(슬라이드 없거나 전송 실패 시 텍스트 폴백). */
export async function notifyCardnewsReady(c: CardReadyInfo, dir: string): Promise<void> {
  try {
    if (!contentReadyNotifyEnabled()) return;
    const caption = cardnewsCaptionHtml(c);
    if (telegramCreds()) {
      let slides: string[] = [];
      try {
        slides = fs.readdirSync(dir)
          .filter((f) => /^slide_\d+\.png$/.test(f)).sort()
          .map((f) => path.join(dir, f));
      } catch { /* 디렉토리 없음 — 텍스트 폴백 */ }
      const sent = await sendTelegramPhotos(slides, caption);
      // 앨범(sendMediaGroup)은 인라인 키보드를 지원하지 않아 버튼은 후속 메시지로 붙인다.
      if (sent) await sendTelegramHtml(`🖼 ${escapeHtml(clip(c.topic, 40))} — 발행:`, cardnewsButtons(c.id));
      else await sendTelegramHtml(caption, cardnewsButtons(c.id));
    }
    await notifyWebhookOnly({
      title: `🖼 카드뉴스 검토 대기${brandTag(c.brand)} · ${c.topic}`,
      body: `검토: ${reviewLink(c.sourcePieceId)}`,
    });
  } catch { /* 무해 */ }
}

const execFileP = promisify(execFile);

/** 텔레그램용 소형 커버(최장변 320px JPEG) — 디자인 썸네일 축소, 없으면 영상 첫 프레임. 실패 시 null(커버 없이 전송). */
async function tgVideoThumb(videoPath: string): Promise<string | null> {
  try {
    const dir = path.dirname(videoPath);
    const out = path.join(dir, 'tg-thumb.jpg');
    if (fs.existsSync(out)) return out;
    const design = path.join(dir, 'thumbnail.jpg');
    const src = fs.existsSync(design) ? design : videoPath;
    await execFileP('ffmpeg', ['-nostdin', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=-2:320', '-q:v', '5', out],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    return fs.existsSync(out) ? out : null;
  } catch { return null; }
}

/** 쇼츠 ready → 완성 영상 알림(50MB 초과·전송 실패 시 텍스트 폴백). */
export async function notifyShortsReady(s: ShortsReadyInfo, videoPath: string): Promise<void> {
  try {
    if (!contentReadyNotifyEnabled()) return;
    const caption = shortsCaptionHtml(s);
    if (telegramCreds()) {
      // 1080×1920 고정 — Remotion 컴포지션·ffmpeg 폴백 모두 이 규격으로 렌더(shortsRender). 커버는 320px 축소본.
      const thumb = await tgVideoThumb(videoPath);
      const sent = await sendTelegramVideo(videoPath, caption, shortsButtons(s.id),
        { width: 1080, height: 1920, thumbnailPath: thumb ?? undefined });
      if (!sent) await sendTelegramHtml(`${caption}\n(영상은 스튜디오에서 확인 — 전송 한도 초과/실패)`, shortsButtons(s.id));
    }
    await notifyWebhookOnly({
      title: `🎬 쇼츠 검토 대기${brandTag(s.brand)} · ${s.topic}`,
      body: `검토: ${reviewLink(s.sourcePieceId)}`,
    });
  } catch { /* 무해 */ }
}
