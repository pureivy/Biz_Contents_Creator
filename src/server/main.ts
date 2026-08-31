/**
 * HTTP + SSE 서버 (Hono) — 단일 런타임. React 프론트(무접두 계약) + 자체 경량 UI(/lite).
 *
 * 런/이벤트/취소는 무접두(/runs…)와 /api/* 둘 다 등록(프론트는 무접두, 자체 UI는 /api).
 * 프론트 계약: /runs, /runs/:id/{events,log,cancel}, /llm, /company, /wiki/*, /approvals, 스텁들.
 */
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { createServer as createHttpsServer } from 'node:https';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { secureHeaders } from 'hono/secure-headers';
import net from 'node:net';
import { CONFIG } from '../config';
import { getLlmSetting, setLlmSetting, resolveAssignment } from '../llm/setting';
import { getRunSettings, setRunSettings } from '../runsettings';
import { EventType } from '../events/types';
import { createBus, getBus, disposeBus } from '../events/bus';
import type { EventBus } from '../events/bus';
import { runId } from '../util/ids';
import { startRun } from '../orchestrator/index';
import { microCall } from '../orchestrator/agent';
import { getCompany, reloadCompany, editRole, deleteRole, addTeam, renameTeam, deleteTeam, addMember } from '../agents/company-loader';
import { rolesById } from '../agents/company';
import type { RoleDef } from '../agents/company';
import type { RolePatch, MemberBody } from '../agents/company-loader';
import { agentDetail, writeGoal, writeCapabilities, addSkill, deleteSkill, appendActivity, ensureScaffold, effectiveAutonomy, appendInjected, injectedLength, clearInjected, INJECTED_CAP } from '../agents/workspace';
import { listKeys, setKey, addCustom, deleteKey, hiddenKeys, restoreKey, getSecret, setNaverAccount, naverAccountView, getYoutubeAccount, setYoutubeToken, getMetaAccount, setMetaToken, setMetaPage, purgeCustomKeysForBrand, purgeBrandAccounts } from '../secrets/store';
import { collectExistingContent, findSimilarContent, saturatedThemeMatches, type SimilarMatch } from '../content/novelty';
import { clusterStore, pickNextSibling } from '../content/topicCluster';
import { mineClusterForPiece, filterCandidates } from '../orchestrator/clusterMine';
import { connectors } from '../grounding'; // 그라운딩 커넥터 등록(law·dart·custom) + mcpServers 노출
import { listCustomConfigs, saveCustomConfig, deleteCustomConfig, runCustomConnector, autoConfigConnector, type CustomConnectorCfg } from '../grounding/custom';
import { webSearch } from '../tools/web_search';
import { uploadShortsToYoutube } from '../tools/youtubeUpload';
import { publishCardNewsToMeta, publishShortsToMeta, realPermalink, listIgMedia, matchOrphanReels, GRAPH } from '../tools/metaPublish';
import { llmWiki, slugify } from '../wiki/llmwiki';
import { approvalStore } from '../approvals/store';
import { isAbort } from '../util/abort';
import { runRevise } from '../orchestrator/revise';
import type { FinalPosition } from '../orchestrator/finalize';
import { startAutoCycle, proposeContentIdeas, startDaily, researchDue, recordResearchLaunch, rollbackResearchLaunch, proposeResearchMission, autoRunEnabled, setAutoRunEnabled, derivedContentDue, isAutorunDirective, demandGateDecision, speciesCoverageFor } from '../autonomy/scheduler';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cardNewsStore, qaPublishBlockReason } from '../content/cardnews';
import type { CardNews } from '../content/cardnews';
import { runCardNewsJob, isCardNewsRunning, resolveForcedPreset, repairCardNewsSlides, reviseCardNews } from '../orchestrator/cardnews';
import { shortsStore } from '../content/shorts';
import type { Shorts } from '../content/shorts';
import { runShortsJob, isShortsRunning, reviseShorts } from '../orchestrator/shorts';
import { ensureShortsThumbnail, ensureShortsDownload, ensureMetaVideo, extractFirstFrame } from '../tools/shortsRender';
import { generateDesignedThumbnail } from '../orchestrator/shortsThumbnail';
import { pieceStore, selectResumablePiece, blogUrlForPiece, planAutoNaverDraft, shouldAutoDeriveOnDecision, cadenceBaselineTs } from '../content/pieces';
import { isTransientFailure, transientReason } from '../llm/transientError';
import { toFactGateInfo } from '../content/factGate';
import { readFactGate } from '../sessions/digest';
import { listPersonas } from '../content/personas';
import { getBrand, saveBrand, normalizeBrand, listBrands, activateBrand, activeBrandSlug, deleteBrand, isSafeBrandSlug, offBrandTerm, lintLexicon } from '../content/brand';
import type { BrandProfile } from '../content/brand';
import { offSeasonSubject, formatMonths } from '../content/seasonalSubjects';
import { overSpeciesCap, SPECIES_MONTHLY_CAP } from '../content/speciesRotation';
import { overThemeCap, THEME_MONTHLY_CAP } from '../content/topicThemes';
import { brandThemeCoverage } from '../analytics/discoverySeeds';
import type { Piece } from '../content/pieces';
import { ingestMetrics } from '../analytics/reinforce';
import { syncShortsPerformance, syncShortsMetaPerformance, shortsPerfStale, shortsMetaPerfStale } from '../analytics/shortsPerf';
import { harvestTopicVerdicts, avoidVerdictFor, consumeOpportunityVerdict } from '../analytics/topicVerdicts';
import { seriesGateForText, ensureSeriesLabels } from '../analytics/seriesLedger';
import { refreshTrendSnapshot } from '../analytics/trendSignal';
import { refreshDemandSnapshot, assessCandidatesDemand, demandRejectFor, rememberDemandReject, type DemandRow, type DemandVerdict } from '../analytics/topicDemand';
import { searchAdEnabled } from '../grounding/naver_searchad';
import { refreshYtNicheSnapshot } from '../analytics/ytNiche';
import { syncCardnewsPerformance, cardnewsPerfStale } from '../analytics/cardnewsPerf';
import { discoverPublishedNaver } from '../analytics/naverDiscovery';
import { recordFollowersSnapshot, readSnapshots } from '../analytics/followers';
import { buildTitleTimingReport } from '../analytics/titleTiming';
import { promiseStore } from '../content/promises';
import { refreshNaverIndexingCache } from '../analytics/naverIndexing';
import { parseManualMetrics, readMetrics, latestMetrics, latestMetricsBySource, viewsSeriesFor, metricSeriesFor, appendMetrics, naverTrackingDue, topInflow, latestDwell, latestLikes, latestTouch, sameKstDay } from '../analytics/performance';
import { fetchBlogSympathy } from '../analytics/naverSympathy';
import { naverAttemptAt, markNaverAttempt } from '../analytics/naverAttempts';
import { readStrategy } from '../analytics/strategy';
import { getCollector, setCollector } from '../analytics/collector';
import { notify, notifyConfigured } from '../autonomy/notify';
import { notifyBlogReady, notifyShortsReady, notifyCardnewsReady, contentReadyNotifyEnabled, studioBase } from '../autonomy/contentNotify';
import { startTelegramBot } from '../autonomy/telegramBot';
import { buildBriefing } from '../autonomy/briefing';
import { extractText, isSupportedExt } from '../tools/extract';
import { publishDraftToNaver, naverPublishCreds, collectNaverMetrics } from '../tools/blog_skills';
import { coerceBlogDraft } from '../output/smarteditor';
import type { MetricSample } from '../analytics/performance';
import { classifyAndAssign, getStatuses, reassign, setIngestStatus } from '../tools/classify';
import { transcribe, sttAvailable } from '../voice/stt';
import { synthesize, listKoreanVoices, ttsAvailable } from '../voice/tts';
import { getVoiceSettings, setVoiceSettings } from '../voice/setting';
import { jarvisChat } from '../jarvis/chat';

// 시간 기준 = 대한민국 표준시(KST). 스크립트(package.json)가 TZ 를 주지만, 직접 실행 대비 방어적으로
// 고정한다(이미 설정돼 있으면 존중). 로컬시간 기반 코드(nowDate·스케줄러)가 호스트 OS 와 무관하게 KST.
process.env.TZ ??= 'Asia/Seoul';

// 듀얼스택(IPv4+IPv6) API 의 아웃바운드 안정화 — IPv6 광고는 되는데 라우팅이 죽은 망(실측: api.telegram.org,
// 2026-07-29)에서 Node Happy Eyeballs 기본 폴백 대기(250ms)로는 fetch 가 ETIMEDOUT 으로 굳는다.
// 재실측(2026-08-15): api.telegram.org 는 v4 RTT 자체가 평균 324ms(282~353)라 시도 대기가 RTT 보다 짧으면
// v4 '연결 자체'도 중도 포기된다(국내 엣지 있는 구글·그래프는 멀쩡 — 텔레그램만 간헐 단절·발행 실패로 보인 이유).
// 1500ms + IPv4 우선 조회(v6 는 EHOSTUNREACH, 'ipv4first' 는 v6 폴백을 막지 않음)로 여유를 확보한다.
net.setDefaultAutoSelectFamilyAttemptTimeout(1500);
dns.setDefaultResultOrder('ipv4first');

interface RunHandle {
  status: 'running' | 'done' | 'error' | 'cancelled';
  abort: AbortController;
  topic: string;
  created_ts: string;
  deliverable?: string;
  positions?: FinalPosition[];
  subproblems?: Array<{ id: string; text: string }>;
  version?: number;
  /** 리비전(개정) 런 — 기존 초안 개정 fast-path(자동 SEO 개정 등). 기록에서 원본 생성과 구분 표시용. */
  revise?: boolean;
  /** 자율 사이클이 띄운 런 — 사용자 런 도착 시 양보(abort) 대상. */
  auto?: boolean;
  /** 이 런이 만든/개정한 블로그 조각 — 완료된 자율런 중 '본편 생산 런'을 기록 목록에 남기는 식별자
   *  (사용자 결정 2026-08-14: 개정런만 남고 원런이 숨는 비대칭 해소 — 리서치 등 나머지 자율런은 계속 숨김). */
  pieceId?: string;
  /** 시작 시점의 활성 브랜드 슬러그 — 기록·누적 토론의 브랜드 필터 기준(범용은 undefined). */
  brand?: string;
}

const RUNS = new Map<string, RunHandle>();
const RUNS_CAP = 200;
// 마지막 자율 사이클 런(있으면) — /autonomy/status 표출용.
let lastAutoRun: { ts: string; topic: string } | null = null;
/** RUNS 무한 누적 방지 — 캡 초과 시 오래된 '종료' 런부터 제거(running 보존, 이벤트는 events.jsonl 영속). */
function evictRuns(): void {
  if (RUNS.size <= RUNS_CAP) return;
  const finished = [...RUNS.entries()]
    .filter(([, h]) => h.status !== 'running')
    .sort((a, b) => a[1].created_ts.localeCompare(b[1].created_ts));
  for (const [id] of finished) {
    if (RUNS.size <= RUNS_CAP) break;
    RUNS.delete(id);
  }
}
const app = new Hono();

// ── 보안 미들웨어(2026-07-22 보안점검) — 서버는 무인증 로컬 도구(127.0.0.1)라 원격 직격은 없지만,
//   브라우저는 localhost 를 특별취급하지 않아 (a) 악성 페이지 방문 시 cross-origin 요청으로 상태변경
//   (CSRF), (b) DNS 리바인딩(공개 이름이 127.0.0.1 로 해석)으로 바인딩 우회가 성립한다. 두 벡터를 차단.
// 허용 호스트 = 루프백 + 바인딩 주소 + Tailscale(사설 메시 VPN: MagicDNS .ts.net·CGNAT 100.64/10·ULA fd7a:115c:a1e0)
//  + ALLOWED_HOSTS env(쉼표구분 추가 호스트). Tailscale 은 tailnet 내부에서만 도달 가능한 사설 경로라 허용해도
//  외부 DNS 리바인딩 표면이 넓어지지 않는다(공격자가 그 호스트에 도달하려면 사용자의 tailnet 소속이어야 함).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', CONFIG.host.toLowerCase()]);
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
);
/** Host/Origin 헤더에서 순수 호스트명 추출(포트·IPv6 대괄호·끝점 제거, 순수). */
function bareHost(raw: string): string {
  let h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i > 0 ? h.slice(1, i) : h.slice(1); } // [ipv6]:port
  const c = h.indexOf(':');
  return c >= 0 ? h.slice(0, c) : h; // host:port (이름/ipv4)
}
/** 이 호스트로의 접속을 허용하나 — 리바인딩 차단은 유지하되 Tailscale·env 지정 호스트는 통과. */
function isAllowedHost(raw: string): boolean {
  const h = bareHost(raw);
  if (!h) return true; // Host 헤더 없음(비브라우저) — 통과
  if (LOOPBACK_HOSTS.has(h) || ALLOWED_HOSTS.has(h)) return true;
  if (h.endsWith('.ts.net')) return true;                    // Tailscale MagicDNS
  if (net.isIP(h) === 4) { const p = h.split('.').map(Number); if (p[0] === 100 && (p[1] ?? -1) >= 64 && (p[1] ?? -1) <= 127) return true; } // Tailscale CGNAT 100.64/10
  if (net.isIP(h) === 6 && h.startsWith('fd7a:115c:a1e0')) return true; // Tailscale IPv6 ULA
  return false;
}

// 보안 헤더(#14) — 클릭재킹(frame-ancestors)·MIME 스니핑·리퍼러 유출 차단. CSP 는 SPA 실제 사용에 맞춤:
// 스크립트는 self(외부 모듈만, 인라인 없음), 스타일은 인라인(React style prop) 허용, 이미지·미디어는 self+data:+blob:.
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    // 스타일·폰트는 self+인라인 + 웹폰트 CDN(jsdelivr — Pretendard/wanted-sans, index.html 이 로드).
    styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
    imgSrc: ["'self'", 'data:', 'blob:'],
    mediaSrc: ["'self'", 'data:', 'blob:'],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
  },
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: false, // 로컬 http — HSTS 부적합
}));

// 선택적 접근 토큰(#12) — AUTH_TOKEN 시크릿이 설정된 경우에만 활성(기본은 게이트 없음, 기존 동작 유지).
// 프론트의 401→토큰입력→studio_token 쿠키 부트스트랩과 정합. OAuth 콜백(외부 리디렉션)·정적 에셋은 면제.
app.use('*', async (c, next) => {
  const expected = getSecret('AUTH_TOKEN') || process.env.AUTH_TOKEN || '';
  if (!expected) return next(); // 미설정 = 게이트 off
  const p = c.req.path;
  if (p.startsWith('/youtube/oauth/callback') || p.startsWith('/meta/oauth/callback') || p.startsWith('/assets/')) return next();
  const cookie = /(?:^|;\s*)studio_token=([^;]+)/.exec(c.req.header('cookie') ?? '')?.[1];
  const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const tok = decodeURIComponent(cookie ?? '') || bearer;
  if (!safeEqual(tok, expected)) return c.json({ error: '인증 필요 — AUTH_TOKEN' }, 401);
  return next();
});

app.use('*', async (c, next) => {
  const hostHeader = c.req.header('host') ?? '';
  // (1) Host 허용목록 — DNS 리바인딩 차단(공격자 이름 Host 는 미허용). Tailscale·env 지정 호스트는 통과.
  if (!isAllowedHost(hostHeader)) return c.json({ error: 'forbidden host' }, 403);
  // (2) 상태변경 요청의 cross-origin 차단(CSRF) — Sec-Fetch-Site/Origin 검사. Origin 은 요청 Host 와
  //     같은 호스트(same-origin)이거나 허용 호스트여야 통과 → 우리 UI(로컬·Tailscale)·스크립트(헤더없음)는
  //     통과, 타 사이트 브라우저 요청만 거부.
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const sfs = c.req.header('sec-fetch-site');
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') return c.json({ error: 'cross-origin blocked' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        const oh = new URL(origin).hostname.toLowerCase();
        if (oh !== bareHost(hostHeader) && !isAllowedHost(oh)) return c.json({ error: 'cross-origin blocked' }, 403);
      } catch { return c.json({ error: 'bad origin' }, 403); }
    }
  }
  await next();
});

// 런 종료 시 이벤트 스트림을 디스크로 영속화 — 버스 폐기(30s)·재시작 후에도 replay 가능.
function persistEvents(id: string, busRef?: EventBus): void {
  // 클로저로 받은 버스 참조 우선 — eventsHandler 가 SSE 끊김 30초 뒤 disposeBus 로 맵에서
  // 제거해도(런 완료가 그 뒤면 getBus 가 null), 살아있는 객체로 항상 영속한다.
  const bus = busRef ?? getBus(id);
  if (!bus) return;
  try {
    const dir = path.join(CONFIG.sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const lines = bus.replay(0).map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), lines, 'utf-8');
  } catch { /* 영속 실패 무해 */ }
}
function loadPersistedEvents(id: string): unknown[] {
  try {
    const text = fs.readFileSync(path.join(CONFIG.sessionsDir, id, 'events.jsonl'), 'utf-8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// 런 메타 사이드카(run.json) — 목록·재열기·HWPX 가 재시작/메모리 evict 후에도 디스크에서
// 완전 복원되도록 topic·status·deliverable 까지 영속. events.jsonl(이벤트 replay)과 별개.
interface PersistedMeta { run_id: string; topic: string; status: string; created_ts: string; deliverable: string; auto?: boolean; brand?: string; revise?: boolean; pieceId?: string; }
function persistRunMeta(id: string, h: RunHandle): void {
  try {
    const dir = path.join(CONFIG.sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta: PersistedMeta = { run_id: id, topic: h.topic, status: h.status, created_ts: h.created_ts, deliverable: h.deliverable ?? '', auto: !!h.auto, brand: h.brand, revise: !!h.revise, ...(h.pieceId ? { pieceId: h.pieceId } : {}) };
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(meta), 'utf-8');
  } catch { /* 영속 실패 무해 */ }
}
function loadRunMeta(id: string): PersistedMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, id, 'run.json'), 'utf-8')) as Partial<PersistedMeta>;
    if (!m || typeof m.topic !== 'string') return null;
    return { run_id: id, topic: m.topic, status: m.status ?? 'done', created_ts: m.created_ts ?? '', deliverable: m.deliverable ?? '', auto: !!m.auto, brand: typeof m.brand === 'string' ? m.brand : undefined, revise: !!m.revise, ...(typeof m.pieceId === 'string' && m.pieceId ? { pieceId: m.pieceId } : {}) };
  } catch { return null; }
}
// 레거시 세션(run.json·events.jsonl 부재, _report.md 만 존재) — 과거 런을 잃지 않게 산출물 파일로 복원.
function legacyMetaFromFiles(id: string): PersistedMeta | null {
  try {
    const dir = path.join(CONFIG.sessionsDir, id);
    const reportPath = path.join(dir, '_report.md');
    if (!fs.existsSync(reportPath)) return null;
    const report = fs.readFileSync(reportPath, 'utf-8');
    // _report.md 형식: "# 최종 종합 — {topic}\n\n{deliverable}\n"
    const nl = report.indexOf('\n');
    const head = (nl >= 0 ? report.slice(0, nl) : report).trim();
    const topic = head.replace(/^#\s*최종\s*종합\s*[—\-]\s*/, '').trim() || id;
    const deliverable = nl >= 0 ? report.slice(nl + 1).replace(/^\s+/, '') : '';
    let created = '';
    try { created = fs.statSync(dir).mtime.toISOString(); } catch { /* */ }
    return { run_id: id, topic, status: 'done', created_ts: created, deliverable };
  } catch { return null; }
}

// ============================================================
// 런 라이프사이클 (무접두 + /api 양쪽 등록)
// ============================================================
interface LaunchOpts {
  agent?: string; path?: string; budgetUsd?: number; auto?: boolean; pieceId?: string;
  /** 리비전 런(검토 탭 '수정 요청') — 기존 초안+피드백으로 개정. 실패해도 ready 초안은 보존(에러 카운트 X). */
  revise?: { baseBody: string; feedback: string; /** 개정 대상 초안을 만든 런 — research_brief.md 재주입용(스펙 §3). */ baseRunId?: string };
  /** 핵심 타겟 키워드(piece.keyword) — 포장 primaryKeyword 고정(SEO 게이트·리비전 과녁 고정). */
  keyword?: string;
  /** 첨부 이미지 경로(/runs/attachments 저장분) — 런 시작 전 vision 분석 결과를 주제에 병합. */
  images?: string[];
  /** 첨부 문서 경로(/runs/attachments 저장분) — 런 시작 전 텍스트 추출(길면 micro 요약)해 주제에 병합. */
  docs?: string[];
  /** 지식 리서치 런 — 집필·포장 생략(draft.json 없음 → piece 승격·캘린더 오염 자연 차단). 두뇌 적재·직원 학습 전용. */
  mission?: 'research';
  /** 블로그 작가 말투(페르소나) id + custom 자유 텍스트 — 본문 집필 작가에 주입(personas.ts). */
  persona?: string;
  personaText?: string;
}

// draft.json(6c)에서 piece 표시 메타 재로드 — 초안 asset 은 finalize 가 이미 디스크에 씀(메모리 의존 없음).
function readDraftMeta(runId: string): { title?: string; seoScore?: number; keyword?: string } | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as {
      titleCandidates?: string[]; primaryKeyword?: string; seo?: { score?: number };
    };
    return { title: d.titleCandidates?.[0], keyword: d.primaryKeyword, seoScore: d.seo?.score };
  } catch { return null; }
}

/** 리비전 런이 완주 못 하면(실패·취소) 유예했던 원본 초안의 검토 대기 알림을 복원한다(멱등 — notifiedTs 가드). */
function restoreDeferredReadyNotify(pieceId: string): void {
  try {
    const p = pieceStore().get(pieceId);
    if (!p || p.stage !== 'ready' || p.notifiedTs || !contentReadyNotifyEnabled()) return;
    console.log(`[발행담당] 리비전 미완주 — 원본 초안 검토 대기 알림 복원(${p.id})`);
    void notifyBlogReady({ id: p.id, title: p.title, keyword: p.keyword, seoScore: p.seoScore, brand: p.brand, factGate: p.factGate }, p.runId ?? '')
      .finally(() => { try { pieceStore().update(p.id, { notifiedTs: new Date().toISOString() }); } catch { /* 무해 */ } });
  } catch { /* 무해 — 부팅 복구 스윕이 최후 방어선 */ }
}

// 런 완료 → piece 를 'ready'(검토 대기)로 승격. draft.json 우선, 없으면(포장 실패) 본문(deliverable)으로 폴백.
// 초안·본문 모두 비면 산출 실패로 간주해 에러 카운트(다음 틱 재개 대상). '완전 자율'의 라이프사이클 전진 지점.
// 반환: 조각별 알림 채널이 이 piece 의 메시징을 소유하는지(리비전 유예 포함) — 자율 사이클이 산출물 덤프 알림을 억제하는 데 쓴다.
function advancePieceReady(pieceId: string, runId: string, deliverable: string, revised = false): boolean {
  const draft = readDraftMeta(runId);
  if (!draft && !deliverable.trim()) { pieceStore().recordError(pieceId); return false; }
  const gate = readFactGate(runId);
  pieceStore().update(pieceId, {
    runId, stage: 'ready',
    ...(draft?.title ? { title: draft.title } : {}),
    ...(typeof draft?.seoScore === 'number' ? { seoScore: draft.seoScore } : {}),
    ...(draft?.keyword ? { keyword: draft.keyword } : {}),
    // 게이트 결과 없음(FACT_GATE=off·리서치 런·기록 실패)이면 명시적으로 지운다 — 조건부 스프레드로
    // 키를 빼면 직전 런의 hold 가 그대로 남아 자동 임시저장이 계속 막힌다(2026-08-26 최종 리뷰 F1).
    // update 는 { ...p, ...patch } 라 undefined 도 키로 실려 실제로 덮어쓰고, 영속 시 JSON 이 떨군다.
    factGate: gate ? toFactGateInfo(gate) : undefined,
  });
  // ready 도달 → 자동 네이버 임시저장 게이트(SEO 기준 통과 시 발행 담당이 저장, 미달 시 자동 리비전 1회).
  // 알림보다 먼저 실행 — 리비전이 뜨면 이 초안은 곧 대체되므로 낡은 '검토 대기' 푸시를 만들지 않는다(리비전 완료가 다시 여기로 와 알림).
  let revisionLaunched = false;
  try { revisionLaunched = maybeAutoNaverDraft(pieceId); } catch { /* 무해 — 수동(검토 탭 버튼) 경로는 그대로 살아있다 */ }
  // 검토 대기 알림(조각별) — 텔레그램이면 본문 발췌 동봉. 전송 실패 무해(fire-and-forget).
  // 발송이 '정착'한 뒤 notifiedTs 기록 — 프로세스가 전송 도중 죽으면 미기록으로 남아 부팅 복구 스윕이
  // 재발송한다(실측 2026-07-31: ready 승격 6초 뒤 tsx 재시작 → 알림·리비전 동반 유실).
  const owned = contentReadyNotifyEnabled();
  if (owned && !revisionLaunched) {
    const p = pieceStore().get(pieceId);
    if (p) {
      void notifyBlogReady({ id: p.id, title: p.title, keyword: p.keyword, seoScore: p.seoScore, brand: p.brand, revised, factGate: p.factGate }, runId)
        .finally(() => { try { pieceStore().update(pieceId, { notifiedTs: new Date().toISOString() }); } catch { /* 무해 */ } });
    }
  }
  // 클러스터 채굴(스펙 2026-08-06) — 대표 편 초안 확정 시 연관 검색어 형제를 백로그로. 수동·자율 런이
  // 여기서 합류하므로 단일 훅으로 두 경로를 다 덮는다. 리비전은 같은 글 재확정이라 제외. fire-and-forget.
  if (!revised && process.env.TOPIC_CLUSTER !== 'off') {
    void mineClusterForPiece(pieceId).catch(() => { /* 무해 — mineClusterForPiece 내부도 fail-open */ });
  }
  return owned;
}

// 컴포저(타임라인) 런 조건부 승격 — 산출물이 블로그 초안 형태(finalize 가 draft.json 을 남김)면
// piece 로 등록해 캘린더→검토→발행→성과 파이프라인에 합류시킨다. 질문·지시·지명 런처럼 초안
// 포장이 없는 런은 draft.json 이 없어 자연히 제외된다(캘린더 오염 방지). 브랜드는 런 시작 시점 기준.
function promoteRunToPiece(runId: string, topic: string, deliverable: string, brand?: string): { piece: PieceInfoLike | null; notified: boolean } {
  if (!readDraftMeta(runId)) return { piece: null, notified: false };       // 초안 형태 아님 — 승격 안 함
  const dup = pieceStore().list().find((p) => p.runId === runId);
  if (dup) return { piece: dup, notified: false };                          // 이미 등록(자동/수동 이중 승격 방지)
  const piece = pieceStore().create({ title: topic.slice(0, 120), brand });
  const notified = advancePieceReady(piece.id, runId, deliverable);         // draft 메타로 title/keyword/seo 갱신 + ready
  return { piece: pieceStore().get(piece.id) ?? piece, notified };
}
type PieceInfoLike = ReturnType<ReturnType<typeof pieceStore>['create']>;

/** 진행 중 자율(auto) 런을 모두 양보(abort) — 사용자 런(일반/revise) 도착 시 호출. */
function yieldRunningAutos(): void {
  for (const [, h] of RUNS) {
    if (h.auto && h.status === 'running') h.abort.abort();
  }
}

/** 런 1건을 띄우고 run_id 반환. startHandler(사용자)와 자율 사이클이 공유. */
function launchRun(topic: string, opts: LaunchOpts = {}): string {
  // 유휴 게이트 원자성 — 자율런은 진행 중 사용자 런이 하나라도 있으면 아예 띄우지 않는다(JS 단일스레드라
  // 스케줄러의 proposeTask await 동안 들어온 사용자 런이 이 동기 체크에 보여 레이스가 닫힌다).
  if (opts.auto) {
    if ([...RUNS.values()].some((h) => !h.auto && h.status === 'running')) return '';
  } else {
    yieldRunningAutos(); // 사용자 런 도착 → 진행 중 자율런 양보(단일 KV 슬롯·체감속도 우선)
  }
  const id = runId();
  const bus = createBus(id);
  const abort = new AbortController();
  const handle: RunHandle = { status: 'running', abort, topic, created_ts: new Date().toISOString(), auto: !!opts.auto };
  handle.brand = activeBrandSlug() || undefined;
  if (opts.revise) handle.revise = true; // 개정 런 표식 — 기록에서 원본 생성과 구분(중복 오해 방지)
  if (opts.pieceId) handle.pieceId = opts.pieceId; // 본편 생산 런 표식 — 완료 자율런의 기록 표시 기준
  RUNS.set(id, handle);
  if (opts.auto) lastAutoRun = { ts: handle.created_ts, topic };
  evictRuns();

  // 첨부(멀티모달 주제) — 본 런 시작 전 문서는 텍스트 추출, 이미지는 vision 분석으로 텍스트 컨텍스트를
  // 만들어 주제에 병합. 텍스트 전용인 하위 전 단계(리서치·초안·검수)가 공유한다. 실패는 무해 — 원 주제로 진행.
  const prepared: Promise<string> = (opts.images?.length || opts.docs?.length)
    ? (async () => {
        let t = topic;
        if (opts.docs?.length) {
          const block = await digestAttachedDocs(topic, opts.docs, bus, abort.signal).catch(() => '');
          if (block) t += `\n\n[첨부 자료]\n${block}`;
        }
        if (opts.images?.length) {
          const desc = await describeAttachedImages(topic, opts.images, bus, abort.signal).catch(() => '');
          if (desc) t += `\n\n[첨부 이미지 분석]\n${desc}`;
        }
        return t;
      })()
    : Promise.resolve(topic);

  prepared
    .then((fullTopic) => {
      // 첨부 분석(수 초~수십 초) 중 취소되면 여기서 끊는다 — 취소된 런이 run_started 를 방출하며
      // 되살아나 LLM 호출까지 이어지던 구멍(분석 헬퍼의 내부 catch 가 중단을 삼켜 prepared 는 resolve 됨).
      if (abort.signal.aborted) throw new Error('중단됨(abort)');
      return startRun(bus, {
        topic: fullTopic, signal: abort.signal,
        agentId: opts.agent, path: opts.path, budgetUsd: opts.budgetUsd, revise: opts.revise, keyword: opts.keyword,
        pieceId: opts.pieceId, // 제작 런 표식 — 단축경로(즉답) 분류 우회(질문형 가제 좌초 방지)
        mission: opts.mission, persona: opts.persona, personaText: opts.personaText,
      });
    })
    .then((outcome) => {
      handle.status = 'done';
      handle.deliverable = outcome.deliverable;
      handle.positions = outcome.positions;
      handle.subproblems = outcome.subproblems;
      // piece 라이프사이클 전진 — 초안 완성 → 'ready'(검토 대기, 지속형 레코드). 발행은 사람이 수동(POST /pieces/:id/published).
      let readyNotified = false;
      if (opts.pieceId) { try { readyNotified = advancePieceReady(opts.pieceId, id, outcome.deliverable ?? '', !!opts.revise); } catch { /* 무해 — piece 는 draft 로 남아 재개 */ } }
      // pieceId 없는 런(컴포저 주제 등)도 초안을 만들었으면 파이프라인에 합류(조건부 승격 — 사용자 확정 2026-07-06).
      else if (!opts.revise) {
        try { readyNotified = promoteRunToPiece(id, topic, outcome.deliverable ?? '', handle.brand).notified; } catch { /* 무해 */ }
      }
      // 자율 사이클 런 완료 → 알림(채널 설정 시에만 실제 발송). 조각별 검토 대기 알림이 메시징을 소유하는 런은 생략(이중 핑 방지).
      // 요약형(2026-07-29 사용자 확정) — 원문 덤프는 텔레그램에서 마크다운 표가 깨지고 1200자 캡에 중간 잘림.
      // 상세는 런 리플레이 딥링크로 위임(자율런은 /runs 목록에 없어도 loadPast 가 직접 fetch 해 리플레이됨).
      if (opts.auto && CONFIG.notifyAutoCycle && notifyConfigured() && !readyNotified) {
        const recordLink = `전체 기록: ${studioBase()}/?run=${id}&mode=replay`;
        if (opts.mission === 'research') {
          void notify({ title: `🧠 리서치 완료 · ${topic}`, body: `두뇌 적재·직원 학습 반영 완료\n${recordLink}` });
        } else {
          const head = (outcome.deliverable || '(산출물 없음)').replace(/\s+/g, ' ').trim();
          const excerpt = head.length > 200 ? `${head.slice(0, 200)}…` : head;
          void notify({ title: `🤖 자율 사이클 완료 · ${topic}`, body: `${excerpt}\n${recordLink}` });
        }
      }
    })
    .catch((e: unknown) => {
      if (abort.signal.aborted || isAbort(e)) {
        // 사용자 취소(양보)를 '오류'로 오인하지 않게. piece 는 비종료 스테이지로 남아 다음 틱에 재개(에러 카운트 안 함).
        handle.status = 'cancelled';
        // 리서치 런이 양보·취소로 죽으면 주기 게이트 롤백 — 조사 없이 24h 창이 소각되고 미션이
        // 중복회피 목록에 박제되지 않게(다음 유휴 틱에 재제안). 오류 종료는 롤백 안 함(재시도 폭주 방지).
        if (opts.mission === 'research') { try { rollbackResearchLaunch(topic, handle.brand ?? ''); } catch { /* 무해 */ } }
        bus.emit(EventType.run_done, { status: 'cancelled' });
      } else {
        handle.status = 'error';
        // 실런 실패 → piece 에러 카운트(캡 초과 시 종료, 그 전엔 재개 대상). 취소와 구분해 폭주 방지.
        // 리비전 런 실패는 예외 — ready 초안이 멀쩡히 남아 있으므로 강등/카운트하지 않는다.
        // 일시적 실패(LLM 한도·혼잡·네트워크)도 예외(2026-08-28) — 시간이 풀어 주는 실패라 재시도
        // 예산을 쓸 이유가 없다. 실사고: 세션 한도로 2초 만에 죽은 런이 errors 를 3으로 채워 조각이
        // stage='error' 가 됐고, RESUMABLE_STAGES 에서 빠져 자율 틱이 영영 다시 집지 않았다.
        const transient = isTransientFailure(e);
        if (opts.pieceId && !opts.revise && !transient) { try { pieceStore().recordError(opts.pieceId); } catch { /* 무해 */ } }
        if (opts.pieceId && transient) {
          // 카운트는 안 하되 조각을 재개 가능한 자리로 되돌린다 — draft 로 승격된 채 런만 죽으면
          // runId 가 빈 런을 가리킨 상태로 남아, 다음 틱이 그 잔해를 물고 재개한다.
          try { pieceStore().update(opts.pieceId, { stage: 'idea', runId: undefined }); } catch { /* 무해 */ }
          const reason = transientReason(e);
          console.log(`[런] ${topic.slice(0, 30)} — ${reason} → 재시도 예산 보존, 다음 틱에 재개`);
          // 조용히 재개하면 사람은 "왜 안 도나" 상태가 된다(실측 2026-08-28: 한도로 죽은 걸 로그를 파서야
          // 알았다). 자동 복구된다는 사실과 사유·해제 시각을 알린다. 실패는 무해 — 알림이 복구를 막지 않는다.
          void notify({
            title: `⏸ 생산 일시 중단 — ${reason}`,
            body: `"${topic.slice(0, 40)}" 은(는) 재시도 예산을 쓰지 않고 다음 자율 틱에서 자동 재개됩니다.`,
          }).catch(() => { /* 무해 */ });
        }
        bus.emit(EventType.error, { message: e instanceof Error ? e.message : String(e) });
        bus.emit(EventType.run_done, { status: 'error' });
      }
      // 리비전 미완주(실패·취소) → 유예했던 원본 초안의 검토 대기 알림 복원 — advancePieceReady 가
      // 리비전 발사 시 알림을 미루는데, 리비전이 죽으면 아무도 안 보내 조각이 침묵 속에 ready 로 남았다
      // (실사고 2026-08-18: SEO 미달 자동 리비전이 CLI 세션 한도로 실패 → "텔레그램 왜 안 와" 신고).
      if (opts.pieceId && opts.revise) restoreDeferredReadyNotify(opts.pieceId);
    })
    .finally(() => { persistEvents(id, bus); persistRunMeta(id, handle); });

  return id;
}

// ── 컴포저 멀티모달(이미지 첨부) ──
// 업로드(POST /runs/attachments)가 저장 경로를 돌려주고, 클라이언트가 POST /runs 의 images 로 회신한다.
const ATTACH_DIR = path.join(CONFIG.dataDir, 'attachments');

async function attachmentsHandler(c: Context): Promise<Response> {
  const body = await c.req.parseBody({ all: true });
  const raw = body['files'] ?? body['images']; // 구 클라이언트(images 필드) 호환
  const files = (Array.isArray(raw) ? raw : [raw]).filter((x): x is File => x instanceof File);
  if (!files.length) return c.json({ error: '첨부 파일이 필요합니다' }, 400);
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const images: string[] = [];
  const docs: string[] = [];
  // 무통보 탈락 금지 — 저장 못 한 파일은 사유와 함께 회신, 클라이언트가 사용자에게 고지·확인한다.
  const skipped: Array<{ file: string; reason: string }> = [];
  for (const f of files) {
    const isImg = f.type.startsWith('image/');
    if (isImg && images.length >= 8) { skipped.push({ file: f.name, reason: '이미지 개수 상한(8장) 초과' }); continue; } // claude CLI vision 상한과 일치
    if (!isImg && docs.length >= 8) { skipped.push({ file: f.name, reason: '문서 개수 상한(8건) 초과' }); continue; }
    if (!isImg && !isSupportedExt(f.name || '')) { skipped.push({ file: f.name, reason: '미지원 형식' }); continue; } // 문서는 자료실 추출기 지원 형식만
    if (f.size > (isImg ? 10_000_000 : 25_000_000)) { skipped.push({ file: f.name, reason: `용량 초과(${isImg ? '10MB' : '25MB'})` }); continue; } // 문서 25MB — /sources 와 동일
    const ext = (path.extname(f.name || '').toLowerCase() || (isImg ? '.png' : '')).slice(0, 12);
    // 원 파일명 stem 보존 — 문서 추출기의 확장자 판별·주제 병합 블록의 표시명에 쓰인다.
    const stem = path.basename(f.name || 'file', path.extname(f.name || ''))
      .replace(/[^\w가-힣.\-]+/g, '_').slice(0, 40) || 'file';
    const name = `${Date.now()}-${createHash('sha1').update(`${f.name}:${f.size}:${images.length + docs.length}`).digest('hex').slice(0, 8)}-${stem}${ext}`;
    await fs.promises.writeFile(path.join(ATTACH_DIR, name), Buffer.from(await f.arrayBuffer())); // 비동기 — 25MB 동기 쓰기의 이벤트 루프 정지 방지
    (isImg ? images : docs).push(path.join(ATTACH_DIR, name));
  }
  if (!images.length && !docs.length) {
    return c.json({ error: '저장 가능한 파일이 없습니다 — 이미지(10MB)·문서 PDF/HWP/HWPX/DOCX/PPTX/XLSX/텍스트(25MB)만 지원', skipped }, 400);
  }
  return c.json({ ok: true, paths: [...images, ...docs], images, docs, skipped });
}

// 첨부 문서 → 텍스트 추출(자료실 /sources 와 동일 추출기) 후 주제에 병합. 짧으면 원문 그대로,
// 길면 micro 발췌 요약 — 근거 수치·항목 보존이 목적이라 재서술이 아닌 발췌를 지시한다.
async function digestAttachedDocs(topic: string, docs: string[], bus: EventBus, signal: AbortSignal): Promise<string> {
  const micro = resolveAssignment().micro;
  const parts: string[] = [];
  for (const p of docs.slice(0, 8)) {
    const display = path.basename(p).replace(/^\d+-[0-9a-f]{8}-/, ''); // 저장 접두사 제거 → 원 파일명
    let text = '';
    try { text = (await extractText(path.basename(p), await fs.promises.readFile(p))).trim(); } // 비동기 — 25MB 동기 읽기의 이벤트 루프 정지 방지
    catch { /* 추출 실패 — 아래에서 표기 */ }
    if (!text) { parts.push(`## ${display}\n(텍스트 추출 실패 — 내용 미반영)`); continue; }
    if (text.length <= 2500) { parts.push(`## ${display}\n${text}`); continue; }
    const sum = micro
      ? await microCall(
          micro,
          '너는 자료 요약가다. 문서에서 주제와 관련된 핵심 사실·수치·항목을 재서술 없이 발췌 요약한다. 이모지 금지.',
          `주제: ${topic}\n\n[문서: ${display}]\n${text.slice(0, 24_000)}\n\n1500자 이내로 발췌 요약하라.`,
          { maxOutputTokens: 900, signal },
        ).catch(() => '')
      : '';
    parts.push(`## ${display}\n${(sum || text.slice(0, 2500)).trim()}`);
  }
  const block = parts.join('\n\n').slice(0, 12_000);
  if (block) bus.emit(EventType.log, { message: `첨부 자료 ${docs.length}건 추출 — 주제에 병합` });
  return block;
}

// 런 시작 전 vision 사전 분석 — standard 모델이 Read 도구로 이미지를 직접 보고 관찰 사실을 서술.
async function describeAttachedImages(topic: string, images: string[], bus: EventBus, signal: AbortSignal): Promise<string> {
  const model = resolveAssignment().standard || resolveAssignment().micro;
  if (!model) return '';
  bus.emit(EventType.log, { message: `첨부 이미지 ${images.length}장 분석 중…` });
  const out = await microCall(
    model,
    '너는 시각 자료 분석가다. 첨부 이미지에서 관찰되는 사실만 서술한다. 불확실한 내용은 "추정"으로 표시한다. 이모지 금지.',
    `주제: ${topic}\n\n첨부 이미지 ${images.length}장을 각각 분석하라. 이미지마다 "- 이미지N:" 으로 시작해 (1) 무엇이 보이는지 (2) 식별 가능한 텍스트·수치 (3) 주제와의 연관성을 2~3문장으로 서술하라.`,
    { maxOutputTokens: 900, signal, visionPaths: images },
  );
  bus.emit(EventType.log, { message: '첨부 이미지 분석 완료 — 주제에 병합' });
  return out.trim();
}

async function startHandler(c: Context): Promise<Response> {
  type StartBody = { topic?: string; agent?: string; path?: string; budget_usd?: number; images?: string[]; docs?: string[]; mission?: string; persona?: string; personaText?: string };
  const body = await c.req.json<StartBody>().catch(() => ({}) as StartBody);
  const topic = (body.topic ?? '').trim();
  if (!topic) return c.json({ error: 'topic 이 필요합니다' }, 400);

  // 오토런 지시문 라우팅(실측 3회: "자율런 실행"·"오토런 실행해줘"×2) — 지시문이 콘텐츠 런이 되어
  // 지시문 제목의 글이 검토함에 쌓이던 함정. 런 대신 자율 틱을 즉시 실행하고 안내를 반환한다(지명 런 제외).
  if (!body.agent && isAutorunDirective(topic)) {
    // busy 시 조용히 소멸하던 함정(실사고 2026-08-18) — 지속 실행으로 런 종료를 기다렸다 시작하고,
    // 응답 문구도 현재 상태에 맞게(막연한 '곧 시작' 약속이 무산되면 "작동 안함"으로 체감된다).
    const busyNow = [...RUNS.values()].some((h) => h.status === 'running');
    void stopAutoCycle.runNowPersistent({ label: '오토런 지시', userTriggered: true });
    return c.json({ ok: true, autorun_tick: true, note: busyNow
      ? '오토런 지시로 인식 — 지금은 다른 런이 진행 중이라, 종료되는 대로 콘텐츠 1건을 자율 선정해 시작합니다(자동 재시도, 사무실 탭에서 관전).'
      : '오토런 지시로 인식 — 지금 만들 콘텐츠 1건을 자율 선정해 곧 시작합니다(사무실 탭에서 관전. 검토 대기가 가득이면 보류). 특정 주제로 쓰려던 것이면 그 주제를 입력해 주세요.' });
  }

  // 첨부(이미지·문서) — /runs/attachments 가 저장한 경로만 신뢰(디렉토리 밖 경로 거부: 경로 주입 방지).
  const safeAttachPaths = (v: unknown): string[] => (Array.isArray(v) ? v : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => path.resolve(p))
    .filter((p) => p.startsWith(ATTACH_DIR + path.sep) && fs.existsSync(p))
    .slice(0, 8);
  const images = safeAttachPaths(body.images);
  const docs = safeAttachPaths(body.docs);

  // 리서치 런은 org 팀 경로에서만 의미가 있다(집필·포장 생략을 runOrg 만 해석) — 지명 런이나 팀 없는
  // 회사에서는 일반 런으로 다루고 주기 게이트도 소모하지 않는다(조사 없이 24h 창이 잠기던 구멍 봉합).
  const research = body.mission === 'research' && !body.agent && (getCompany().teams?.length ?? 0) > 0;
  // 수동 리서치 런도 주기 게이트에 반영 — 방금 조사한 영역을 자율 사이클이 중복 조사하지 않게.
  if (research) recordResearchLaunch(topic.replace(/^리서치:\s*/, ''));

  const id = launchRun(topic, {
    agent: body.agent, path: body.path, budgetUsd: body.budget_usd,
    ...(images.length ? { images } : {}),
    ...(docs.length ? { docs } : {}),
    // 블로그 작가 말투 — 지명·리서치가 아닌 본문 집필 런에서만 의미(runOrg writeBlogBody 가 소비). 그 외엔 무시됨.
    ...(typeof body.persona === 'string' && body.persona ? { persona: body.persona } : {}),
    ...(typeof body.personaText === 'string' ? { personaText: body.personaText } : {}),
    // 리서치 런 기본 경로 = 'team'(리서치 팀 경량) — 명시 path 가 있으면 존중.
    ...(research ? { mission: 'research' as const, path: body.path || 'team' } : {}),
  });
  return c.json({ run_id: id });
}

function cancelHandler(c: Context): Response {
  const h = RUNS.get(c.req.param('id') ?? '');
  if (!h) return c.json({ error: 'unknown run' }, 404);
  h.abort.abort();
  h.status = 'cancelled';
  return c.json({ ok: true });
}

// 런 id 경로 조작 가드 — 슬래시·상위경로 포함 id 는 data/sessions 밖 파일을 읽게 하므로 즉시 거부(순수).
function isSafeRunId(id: string): boolean { return !!id && !/[/\\]|\.\./.test(id); }

function runGetHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!isSafeRunId(id)) return c.json({ error: 'unknown run' }, 404);
  const h = RUNS.get(id);
  if (h) return c.json({ run_id: id, status: h.status, topic: h.topic, deliverable: h.deliverable ?? null, created_ts: h.created_ts });
  // 메모리에 없으면(재시작/evict 후) 디스크에서 복원 — 기록 런 재열기 시 산출물까지 표출.
  const meta = loadRunMeta(id) ?? legacyMetaFromFiles(id);
  if (meta) return c.json({ run_id: id, status: meta.status, topic: meta.topic, deliverable: meta.deliverable || null, created_ts: meta.created_ts });
  return c.json({ error: 'unknown run' }, 404);
}

// SSE 끊김 후 bus 정리 타이머(런별). 재연결 시 취소하고, 실행 중이면 정리하지 않는다(아래 eventsHandler).
const _busDisposeTimers = new Map<string, NodeJS.Timeout>();

function eventsHandler(c: Context): Response | Promise<Response> {
  const id = c.req.param('id') ?? '';
  const bus = getBus(id);
  if (!bus) return c.text('unknown run', 404);
  // 재연결 — 직전 끊김으로 예약된 bus 정리 타이머를 취소(라이브 재개가 'unknown run' 으로 끊기지 않게).
  const pendingDispose = _busDisposeTimers.get(id);
  if (pendingDispose) { clearTimeout(pendingDispose); _busDisposeTimers.delete(id); }
  const lastId = Number(c.req.header('Last-Event-ID') ?? '0') || 0;

  return streamSSE(c, async (stream) => {
    const queue = bus.replay(lastId);
    let wake: (() => void) | null = null;
    let closed = false;
    const unsub = bus.subscribe((ev) => { queue.push(ev); wake?.(); });
    stream.onAbort(() => { closed = true; unsub(); wake?.(); });
    try {
      while (!closed) {
        while (queue.length) {
          const ev = queue.shift()!;
          await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev) });
          if (ev.type === EventType.run_done) { closed = true; break; }
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          const t = setTimeout(resolve, CONFIG.ssePingSeconds * 1000);
          if (typeof t.unref === 'function') t.unref();
        });
        wake = null;
        if (!queue.length && !closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
    } finally {
      unsub();
      // bus 정리는 (a) 실행이 끝났고 (b) 30초간 재연결이 없을 때만. 실행 중이면 보존하고 재예약 →
      // 끊김 후 재연결 시 라이브 재개 가능(이전엔 30초 뒤 무조건 dispose → 실행 중에도 'unknown run').
      // 런 종료 후엔 마지막 시청자 이탈 30초 뒤 정리(미정리 누수 방지). 재연결 시 위에서 타이머 취소.
      const scheduleDispose = () => {
        const t = setTimeout(() => {
          _busDisposeTimers.delete(id);
          if (RUNS.get(id)?.status === 'running') { scheduleDispose(); return; } // 아직 실행 중 → 보존, 다시 미룸
          disposeBus(id);
        }, 30_000);
        if (typeof t.unref === 'function') t.unref();
        _busDisposeTimers.set(id, t);
      };
      scheduleDispose();
    }
  });
}

// 영속 세션(data/sessions/*)에서 런 메타 복원 — 서버 재시작/메모리 evict 후에도 기록 보존.
// 우선순위: run.json(완전 메타) → events.jsonl(이벤트 파싱) → 레거시 _report.md(과거 런).
function listPersistedRuns(): PersistedMeta[] {
  const dir = CONFIG.sessionsDir;
  if (!fs.existsSync(dir)) return [];
  const out: PersistedMeta[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue; // data/sessions 에 끼어든 파일 무시(읽기 에러 silent swallow 방지)
    const id = ent.name;
    const meta = loadRunMeta(id);
    if (meta) { out.push(meta); continue; }
    const evs = loadPersistedEvents(id) as Array<{ type?: string; ts?: string; payload?: Record<string, unknown> }>;
    if (evs.length) {
      let topic = '', status = 'done', created = '';
      for (const e of evs) {
        if (e.type === 'run_started' && typeof e.payload?.topic === 'string') topic = e.payload.topic;
        if (e.type === 'run_done' && typeof e.payload?.status === 'string') status = e.payload.status;
        if (!created && e.ts) created = e.ts;
      }
      // topic 누락 시에도 드롭하지 않고 폴백 — run_started 가 바뀌어도 런이 조용히 사라지지 않게.
      const legacy = topic ? null : legacyMetaFromFiles(id);
      out.push({ run_id: id, topic: topic || legacy?.topic || '(제목 없음)', status, created_ts: created || legacy?.created_ts || '', deliverable: legacy?.deliverable ?? '' });
      continue;
    }
    const legacy = legacyMetaFromFiles(id);
    if (legacy) out.push(legacy);
  }
  return out;
}
function listRunsHandler(c: Context): Response {
  // 사용자 런은 전부, 자율(auto) 런은 '진행 중'이거나 '본편 생산 런(pieceId 보유)'만 기록에 포함 —
  // 완료된 자율런 수십 건(리서치 등)의 오염은 계속 방지(사용자 결정 2026-07-23)하되, 본편 원런이 숨어
  // 자동 SEO 개정런과 비대칭("개정은 있는데 원런이 없다")이던 것을 해소(사용자 결정 2026-08-14).
  const pieceRunIds = new Set(pieceStore().list().map((p) => p.runId).filter(Boolean)); // 과거 런 소급 표시용
  const mem = [...RUNS.entries()]
    .filter(([id, h]) => (!h.auto || h.status === 'running' || !!h.pieceId || pieceRunIds.has(id)) && (h.brand ?? '') === activeBrandSlug())
    .map(([id, h]) => ({ run_id: id, topic: h.topic, status: h.status, total_cost: 0, created_ts: h.created_ts, active: h.status === 'running', auto: !!h.auto, revise: !!h.revise, version: h.version }));
  const memIds = new Set(RUNS.keys());
  // 영속 세션 — 메모리에 없는 과거 런만 합쳐 재시작 후에도 기록 탭에 표출. pieceId 미영속 시절의 과거
  // 본편 런은 pieceStore 의 runId 연결로 소급 표시(개정으로 교체된 원런은 연결이 끊겨 소급 불가 — 신규부터 pieceId 영속).
  const persisted = listPersistedRuns()
    .filter((r) => !memIds.has(r.run_id) && (!r.auto || !!r.pieceId || pieceRunIds.has(r.run_id)) && (r.brand ?? '') === activeBrandSlug())
    .map((r) => ({ run_id: r.run_id, topic: r.topic, status: r.status, total_cost: 0, created_ts: r.created_ts, active: false, auto: !!r.auto, revise: !!r.revise }));
  const runs = [...mem, ...persisted].sort((a, b) => (b.created_ts || '').localeCompare(a.created_ts || ''));
  return c.json({ runs });
}

// 레거시 런(events.jsonl 부재) — 산출물 메타로 최소 이벤트를 합성해 replay 가 리포트를 표출하게.
// reducer 가 agent_message(block_id 'ceo-synth')의 text 로 synthesis 패널을 채운다(reducer.ts:349).
function synthEventsFromMeta(m: PersistedMeta): unknown[] {
  const ts = m.created_ts || new Date().toISOString();
  return [
    { v: 1, type: 'run_started', run_id: m.run_id, seq: 1, ts, payload: { topic: m.topic } },
    { v: 1, type: 'agent_message', run_id: m.run_id, seq: 2, ts, agent_id: 'ceo', payload: { block_id: 'ceo-synth', stage: 'synthesis', text: m.deliverable } },
    { v: 1, type: 'run_done', run_id: m.run_id, seq: 3, ts, payload: { status: m.status } },
  ];
}
function runLogHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!isSafeRunId(id)) return c.json({ error: 'unknown run' }, 404);
  const bus = getBus(id);
  if (bus) return c.json({ events: bus.replay(0) }); // 버스 생존 시 메모리 버퍼
  const evs = loadPersistedEvents(id);
  if (evs.length) return c.json({ events: evs }); // 영속 이벤트 replay
  // events.jsonl 부재(레거시/메타만) → 산출물로 최소 이벤트 합성(빈 화면 대신 리포트 표출).
  const meta = loadRunMeta(id) ?? legacyMetaFromFiles(id);
  return c.json({ events: meta && meta.deliverable.trim() ? synthEventsFromMeta(meta) : [] });
}

app.post('/runs', startHandler);
app.post('/api/runs', startHandler);
app.post('/runs/attachments', attachmentsHandler);
app.post('/api/runs/attachments', attachmentsHandler);
app.get('/runs', listRunsHandler);
app.get('/runs/eta', (c) => c.json({ sample: 0, stages: {}, total_sec: null, cost_usd: null })); // /runs/:id 보다 먼저
app.get('/runs/:id/events', eventsHandler);
app.get('/api/runs/:id/events', eventsHandler);
app.get('/runs/:id/log', runLogHandler);
app.post('/runs/:id/cancel', cancelHandler);
app.post('/api/runs/:id/cancel', cancelHandler);
// 완료된 런을 piece 로 수동 승격(소급) — 자동 승격 도입 전의 런이나, 필요 시 상세 탭에서 회수용.
const promoteHandler = (c: Context): Response => {
  const id = c.req.param('id') ?? '';
  if (!isSafeRunId(id)) return c.json({ error: 'unknown run' }, 404);
  const h = RUNS.get(id);
  const meta = readDraftMeta(id);
  if (!meta) return c.json({ error: '초안(draft.json)이 없는 런 — 블로그 초안 형태가 아니라 승격할 수 없습니다' }, 400);
  const piece = promoteRunToPiece(id, h?.topic || meta.title || id, h?.deliverable ?? '', h?.brand ?? (activeBrandSlug() || undefined)).piece;
  if (!piece) return c.json({ error: '승격 실패' }, 500);
  return c.json({ ok: true, piece });
};
app.post('/runs/:id/promote', promoteHandler);
app.post('/api/runs/:id/promote', promoteHandler);
app.get('/runs/:id', runGetHandler);
app.get('/api/runs/:id', runGetHandler);
// 미구현 런 동작(프론트가 실패를 우아하게 처리) — 명시적 스텁
app.delete('/runs/:id', (c) => {
  const id = c.req.param('id') ?? '';
  // 이 런의 세션(draft.json)을 참조하는 초안 카드가 있으면 거절 — 런 삭제가 검토 대기 초안을
  // 소리 없이 증발시키는 사고 방지(실사고: 검토 탭 '초안 없음' 미스터리의 원인). 카드 먼저 삭제.
  const ref = pieceStore().list().find((p) => p.runId === id);
  if (ref) return c.json({ error: `초안 "${ref.title.slice(0, 30)}" 카드가 이 런을 참조합니다 — 캘린더/검토 탭에서 카드를 먼저 삭제하세요.` }, 409);
  RUNS.get(id)?.abort.abort();
  RUNS.delete(id);
  // 영속 세션(data/sessions/{id})도 삭제 — 안 지우면 /runs 가 영속에서 다시 복원해 '삭제 안 됨'으로 보인다.
  if (id && !/[/\\]|\.\./.test(id)) { try { fs.rmSync(path.join(CONFIG.sessionsDir, id), { recursive: true, force: true }); } catch { /* 무해 */ } }
  return c.json({ ok: true });
});
app.post('/runs/:id/message', (c) => c.json({ ok: true }));

// ============================================================
// 콘텐츠 piece — 완전 자율 캘린더 저장소(크로스-런). 프론트는 REST 폴링으로 읽는다(UIState/fold 금지 — 스크럽 시 수치 변형 방지).
// ============================================================
/** 활성 브랜드의 자료만 통과 — 범용 모드(활성 없음)면 브랜드 태그 없는 자료만. 탭 전환의 핵심. */
function brandMatch(x: { brand?: string }): boolean { return (x.brand ?? '') === activeBrandSlug(); }

/** 파생 콘텐츠 요약(카드뉴스·숏폼) — 캘린더 배지·검토 미리보기·성과 컬럼용. 최신 1건씩. */
interface DerivedSummary {
  cardnews?: { id: string; stage: string; slides?: number; running: boolean };
  shorts?: { id: string; stage: string; durationSec?: number; running: boolean };
}
function derivedSummary(pieceId: string): DerivedSummary {
  const out: DerivedSummary = {};
  const cn = cardNewsStore().list().find((x) => x.sourcePieceId === pieceId); // list() 최신순 → 첫 매치 = 최신
  if (cn) out.cardnews = { id: cn.id, stage: cn.stage, slides: cn.slides, running: isCardNewsRunning(cn.id) };
  const sh = shortsStore().list().find((x) => x.sourcePieceId === pieceId);
  if (sh) out.shorts = { id: sh.id, stage: sh.stage, durationSec: sh.durationSec, running: isShortsRunning(sh.id) };
  return out;
}

function piecesListHandler(c: Context): Response {
  return c.json({ pieces: pieceStore().list().filter(brandMatch).map((p) => ({ ...p, derived: derivedSummary(p.id) })) });
}
/**
 * 신규 기획 신규성 가드(사용자 원칙 2026-07-15) — 활성 브랜드의 기존 글·쇼츠·카드뉴스와 주제·키워드가
 * 유사하면 유사 근거를 반환(호출부가 409 응답). force=true 로 의도적 우회 가능. 파생 생성(글→쇼츠·
 * 카드뉴스)은 같은 주제 채널 전개가 의도라 이 가드를 타지 않는다.
 */
function noveltyViolation(title: string, keyword: string | undefined, force: boolean | undefined): SimilarMatch[] | null {
  if (force) return null;
  const sim = findSimilarContent({ title, ...(keyword ? { keyword } : {}) }, collectExistingContent(activeBrandSlug() || undefined));
  return sim.length ? sim.slice(0, 3) : null;
}
const noveltyError = (sim: SimilarMatch[]): { error: string; similar: SimilarMatch[] } => ({
  error: `기존 ${sim[0]!.kind} "${sim[0]!.title}"와(과) ${sim[0]!.via === 'keyword' ? '키워드' : '주제'}가 유사합니다 — 다른 주제·키워드로 바꿔 주세요. (의도한 재도전이면 force 로 강행)`,
  similar: sim,
});

async function pieceCreateHandler(c: Context): Promise<Response> {
  const body = await c.req.json<{ title?: string; keyword?: string; subNiche?: string; force?: boolean }>().catch(() => ({}) as { title?: string; keyword?: string; subNiche?: string; force?: boolean });
  const title = (body.title ?? '').trim();
  if (!title) return c.json({ error: 'title 이 필요합니다' }, 400);
  const sim = noveltyViolation(title, body.keyword, body.force);
  if (sim) return c.json(noveltyError(sim), 409);
  return c.json({ piece: pieceStore().create({ title, keyword: body.keyword, subNiche: body.subNiche, brand: activeBrandSlug() || undefined }) });
}
function pieceGetHandler(c: Context): Response {
  const p = pieceStore().get(c.req.param('id') ?? '');
  return p ? c.json({ piece: p }) : c.json({ error: 'unknown piece' }, 404);
}
// piece 삭제(캘린더·검토·성과 탭 카드 제거) — 실행 중 런/네이버 잡/성과 수집이 있으면 거절.
// 산출물 파일(data/sessions, 성과 샘플)은 지우지 않는다 — 카드(인덱스)만 제거하는 비파괴 삭제.
/**
 * 완전 삭제(purge) 동반 정리 — 카드 제거에 더해 연결 파일(산출물 디렉토리·성과 시계열·블로그는 런 세션)을
 * data/.trash 로 이동한다(rm 아님 — 브랜드 삭제와 동일한 복구 가능 원칙). 유튜브·인스타·네이버에 이미
 * 게시된 원격 게시물은 건드리지 않는다(로컬 파일만). 이동 실패는 무해(잔여는 수동 정리).
 */
function trashContentFiles(kind: 'pieces' | 'shorts' | 'cardnews', id: string, runId?: string): void {
  const trash = path.join(CONFIG.dataDir, '.trash', `${kind}-${id}-${Date.now()}`);
  const move = (src: string, sub: string): void => {
    try {
      if (!fs.existsSync(src)) return;
      const dst = path.join(trash, sub);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } catch { /* 이동 실패 무해 */ }
  };
  if (kind === 'shorts') move(path.join(CONFIG.dataDir, 'shorts', id), id);
  if (kind === 'cardnews') move(path.join(CONFIG.dataDir, 'cardnews', id), id);
  if (kind === 'pieces' && runId) move(path.join(CONFIG.sessionsDir, runId), path.join('sessions', runId));
  move(path.join(CONFIG.dataDir, 'analytics', 'metrics', `${id}.jsonl`), `${id}.jsonl`);
}

function pieceDeleteHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  const piece = pieceStore().get(id);
  if (!piece) return c.json({ error: 'unknown piece' }, 404);
  if ([...RUNS.values()].some((h) => h.status === 'running' && h.topic === piece.title)) {
    return c.json({ error: '이 카드의 런이 실행 중입니다 — 취소 후 삭제하세요.' }, 409);
  }
  if (NAVER_DRAFT_JOBS.get(id)?.status === 'running') {
    return c.json({ error: '네이버 임시저장이 진행 중입니다 — 완료 후 삭제하세요.' }, 409);
  }
  if (COLLECT_JOBS.get(id)?.status === 'running') {
    return c.json({ error: '성과 수집이 진행 중입니다 — 완료 후 삭제하세요.' }, 409);
  }
  NAVER_DRAFT_JOBS.delete(id); // 지난 잡 기록 정리(메모리)
  COLLECT_JOBS.delete(id);
  pieceStore().remove(id);
  // purge=1(성과 대시보드 완전 삭제) — 초안 런 세션·성과 시계열도 휴지통 이동. 기본(무파라미터)은 종전 비파괴 유지.
  if (c.req.query('purge') === '1') {
    if (piece.runId && RUNS.get(piece.runId)?.status !== 'running') RUNS.delete(piece.runId);
    trashContentFiles('pieces', id, piece.runId);
  }
  return c.json({ ok: true });
}
// 발행(수동) — 사람이 네이버에 게시 후 URL 등록 → 'published'. 성과 측정(6d)의 앵커.
async function piecePublishedHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
  const url = (body.url ?? '').trim();
  if (!url) return c.json({ error: 'url 이 필요합니다' }, 400);
  return c.json({ piece: pieceStore().setPublished(id, url) });
}
// 성과 측정치 수집(v1 주 경로 = 수동 입력) — 사람이 네이버 통계에서 붙여넣기 → 강화 루프 트리거(멱등).
async function pieceMetricsPostHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  const body = await c.req.json<unknown>().catch(() => ({}));
  const sample = parseManualMetrics(body);
  const r = await ingestMetrics(id, sample);
  return c.json({ ok: r.recorded, reinforced: r.reinforced, sample, piece: pieceStore().get(id) });
}
function pieceMetricsGetHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  return c.json({ metrics: readMetrics(id) });
}
// 초안 재로드 — DraftReview 가 본문/렌더/메타를 디스크(data/sessions/<runId>/)에서 읽는다(메모리 의존 없음).
function pieceDraftHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  const p = pieceStore().get(id);
  if (!p) return c.json({ error: 'unknown piece' }, 404);
  if (!p.runId) return c.json({ error: 'no draft yet' }, 404);
  const dir = path.join(CONFIG.sessionsDir, p.runId);
  const read = (n: string): string => { try { return fs.readFileSync(path.join(dir, n), 'utf-8'); } catch { return ''; } };
  try {
    const draft = JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf-8')) as unknown;
    // 미리보기 iframe(srcDoc)에서 draft.html 의 상대 이미지(images/blog-image-0N.png)가 로드되게 <base> 주입.
    let html = read('draft.html');
    if (html) {
      const base = `<base href="/pieces/${id}/">`;
      html = html.includes('<head>') ? html.replace('<head>', `<head>\n${base}`) : `${base}\n${html}`;
    }
    return c.json({ piece: p, draft, md: read('draft.md'), html });
  } catch {
    // draft.json 없음 — 리서치·브리프 단계에서 끝났거나 편집 게이트가 반려한 런. run.json deliverable / _brief.md 로
    // 폴백해 검토 탭이 '본문 없음' 대신 보류 사유·브리프를 보여준다(발행용 초안 아니므로 brief 로 구분, 200).
    let deliverable = '';
    try { deliverable = (JSON.parse(read('run.json')) as { deliverable?: string }).deliverable ?? ''; } catch { /* run.json 없음/파손 */ }
    const brief = deliverable.trim() || read('_brief.md').trim();
    if (!brief) return c.json({ error: 'draft not found' }, 404);
    return c.json({ piece: p, brief });
  }
}
// 미리보기 HTML — draft.html 의 이미지를 data: URI 로 인라인해 **JSON({html})** 로 반환한다. text/html 로
// 앱 오리진에 서빙하면 직접 내비게이션 시 LLM 생성 HTML 의 스크립트가 앱 오리진에서 실행돼(iframe sandbox 우회)
// 쿠키(AUTH_TOKEN) 탈취 등 XSS 가 된다 → JSON 이라 브라우저가 렌더하지 않음. 프론트가 이 html 을 sandbox
// srcDoc(allow-scripts 없음)에 넣어 렌더 — 스크립트 차단 + data: 이미지 렌더(오리진·캐시 무관). draft.html
// 원본(pieceDraftHandler)은 외부참조 그대로(복사용·경량). 지연 로드(HTML 미리보기 탭 열 때만 fetch).
function piecePreviewHandler(c: Context): Response {
  const p = pieceStore().get(c.req.param('id') ?? '');
  if (!p?.runId) return c.json({ html: '' });
  let html = '';
  try { html = fs.readFileSync(path.join(CONFIG.sessionsDir, p.runId, 'draft.html'), 'utf-8'); } catch { return c.json({ html: '' }); }
  html = html.replace(/(<img\b[^>]*\bsrc=["'])(?:\.\/)?images\/(blog-image-\d{2}\.(?:png|jpe?g|webp))(["'])/gi, (m, pre: string, name: string, post: string) => {
    try {
      const buf = fs.readFileSync(path.join(CONFIG.sessionsDir, p.runId!, 'images', name));
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return `${pre}data:${mime};base64,${buf.toString('base64')}${post}`;
    } catch { return m; } // 이미지 누락 시 원본 참조 유지(폴백)
  });
  return c.json({ html });
}
// 세션 생성 이미지 서빙 — draft.html 의 상대경로가 위 <base> 로 이 라우트에 해석된다. 이름 화이트리스트(경로 이탈 차단).
function pieceImageHandler(c: Context): Response {
  const p = pieceStore().get(c.req.param('id') ?? '');
  const name = c.req.param('name') ?? '';
  if (!p?.runId) return c.json({ error: 'unknown piece' }, 404);
  if (!/^blog-image-\d{2}\.(?:png|jpg|jpeg|webp)$/.test(name)) return c.json({ error: 'bad name' }, 400);
  try {
    const buf = fs.readFileSync(path.join(CONFIG.sessionsDir, p.runId, 'images', name));
    const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return c.body(new Uint8Array(buf), 200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  } catch { return c.json({ error: 'image not found' }, 404); }
}
app.get('/pieces', piecesListHandler);
app.get('/api/pieces', piecesListHandler);
app.get('/calendar', piecesListHandler); // 캘린더 데이터 = piece 목록(별칭)
app.get('/api/calendar', piecesListHandler);
app.post('/pieces', pieceCreateHandler);
app.post('/api/pieces', pieceCreateHandler);
app.get('/pieces/:id/draft', pieceDraftHandler); // :id 보다 먼저(구체 경로 우선)
app.get('/pieces/:id/preview', piecePreviewHandler); // 미리보기 HTML(이미지 data: 인라인) — iframe src 대상
app.get('/api/pieces/:id/draft', pieceDraftHandler);
app.get('/pieces/:id/images/:name', pieceImageHandler); // 미리보기 <base href="/pieces/:id/"> 상대경로 대상
app.get('/api/pieces/:id/images/:name', pieceImageHandler);
app.get('/pieces/:id', pieceGetHandler);
app.get('/api/pieces/:id', pieceGetHandler);
app.delete('/pieces/:id', pieceDeleteHandler);
app.delete('/api/pieces/:id', pieceDeleteHandler);

// ============================================================
// 카드뉴스 — 카드뉴스팀(standby) 전용 파이프라인. 블로그 org 런과 무관, 발행 없음(다운로드 전용).
// 잡은 백그라운드로 돌고 프론트는 목록/상세 GET 폴링(네이버 임시저장 잡과 동일 패턴).
// ============================================================
const execFileP = promisify(execFile);

/** 담당자 실명(기획·디자인) — 로스터에서 해석해 카드 레코드에 표기(UI용). */
function cardActorNames(): { planner?: string; designer?: string } {
  try {
    const roles = rolesById(getCompany());
    return { planner: roles.get('cardnews_planner')?.name, designer: roles.get('cardnews_designer')?.name };
  } catch { return {}; }
}

// 카드뉴스 잡을 '런'으로 등록 — 오피스 뷰·활동 피드·타임라인이 런 이벤트로 구동되므로, 버스를
// 흘리면 송하영·민준호가 실제로 일하는 모습(스폰·작업 애니메이션·스트림·지표)이 그대로 보인다.
// 런 취소 버튼 → abort 로 잡 중단까지 연결. 완료 시 이벤트 영속(리플레이 가능).
function launchCardNewsRun(cardId: string, topic: string, opts: { sourceBody?: string; slideCount?: number; stylePreset?: string; sourceFlagged?: string[] } = {}): string {
  const id = runId();
  const bus = createBus(id);
  const abort = new AbortController();
  const handle: RunHandle = {
    status: 'running', abort, topic: `카드뉴스: ${topic}`.slice(0, 80), created_ts: new Date().toISOString(), auto: false,
  };
  handle.brand = activeBrandSlug() || undefined;
  RUNS.set(id, handle);
  evictRuns();
  bus.emit(EventType.run_started, { topic: handle.topic });
  // 스타일 해석: 명시 선택 > 브랜드 기본(cardStyle, 자동 파생 포함 전 경로) > 디자이너 자동.
  const stylePreset = opts.stylePreset ?? getBrand()?.cardStyle;
  runCardNewsJob(cardId, { ...opts, stylePreset, bus, signal: abort.signal })
    .then(() => {
      const card = cardNewsStore().get(cardId);
      if (abort.signal.aborted) { handle.status = 'cancelled'; bus.emit(EventType.run_done, { status: 'cancelled' }); return; }
      if (card?.stage === 'ready') {
        handle.status = 'done';
        handle.deliverable = [`카드뉴스 ${card.slides ?? 0}장 완성 — ${card.topic}`, card.caption ?? ''].filter(Boolean).join('\n\n');
        bus.emit(EventType.run_done, { status: 'done' });
      } else {
        handle.status = 'error';
        bus.emit(EventType.error, { message: card?.error ?? '카드뉴스 생성 실패' });
        bus.emit(EventType.run_done, { status: 'error' });
      }
    })
    .catch((e: unknown) => {
      handle.status = abort.signal.aborted ? 'cancelled' : 'error';
      if (!abort.signal.aborted) bus.emit(EventType.error, { message: e instanceof Error ? e.message : String(e) });
      bus.emit(EventType.run_done, { status: handle.status });
    })
    .finally(() => { persistEvents(id, bus); persistRunMeta(id, handle); });
  return id;
}

async function cardNewsCreateHandler(c: Context): Promise<Response> {
  const b = await c.req.json<{ topic?: string; keyword?: string; slides?: number; style?: string; force?: boolean }>()
    .catch(() => ({}) as { topic?: string; keyword?: string; slides?: number; style?: string; force?: boolean });
  const topic = (b.topic ?? '').trim();
  if (!topic) return c.json({ error: 'topic 이 필요합니다' }, 400);
  const sim = noveltyViolation(topic, b.keyword, b.force);
  if (sim) return c.json(noveltyError(sim), 409);
  const card = cardNewsStore().create({ topic, keyword: b.keyword, ...cardActorNames() });
  const run = launchCardNewsRun(card.id, topic, { slideCount: b.slides, stylePreset: b.style });
  return c.json({ card, run_id: run });
}

// 블로그 초안 → 카드뉴스 파생(공용) — 초안 본문을 기획자에게 넘겨 슬라이드로 재구성(복붙 아님).
// 검토 탭 수동 버튼과 '네이버 임시저장 성공' 자동 훅이 공유한다.
function deriveCardNewsFromPiece(pieceId: string, slides?: number, style?: string, auto = false): { card: CardNews } | { error: string } {
  const piece = pieceStore().get(pieceId);
  if (!piece) return { error: 'unknown piece' };
  if (!piece.runId) return { error: '초안이 아직 없습니다.' };
  let body = '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, piece.runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    body = (d.bodyMarkdown ?? '').trim();
  } catch { /* 아래에서 거절 */ }
  if (!body) return { error: '초안 본문(draft.json)을 읽을 수 없습니다.' };
  const card = cardNewsStore().create({
    topic: piece.title, keyword: piece.keyword, sourcePieceId: piece.id, auto, ...cardActorNames(),
  });
  launchCardNewsRun(card.id, piece.title, { sourceBody: body, slideCount: slides, stylePreset: style, sourceFlagged: sourceFlaggedClaims(piece.runId) });
  return { card };
}
async function cardNewsFromPieceHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  const b = await c.req.json<{ slides?: number; style?: string }>().catch(() => ({}) as { slides?: number; style?: string });
  const r = deriveCardNewsFromPiece(id, b.slides, b.style);
  if ('error' in r) return c.json({ error: r.error }, r.error === 'unknown piece' ? 404 : 409);
  return c.json({ card: r.card });
}

function cardNewsListHandler(c: Context): Response {
  return c.json({ cards: cardNewsStore().list().filter(brandMatch).map((x) => ({ ...x, running: isCardNewsRunning(x.id) })) });
}
function cardNewsGetHandler(c: Context): Response {
  const x = cardNewsStore().get(c.req.param('id') ?? '');
  return x ? c.json({ card: { ...x, running: isCardNewsRunning(x.id) } }) : c.json({ error: 'unknown card' }, 404);
}
// 슬라이드 PNG 서빙 — 이름 화이트리스트(경로 이탈 차단).
function cardNewsSlideHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  const name = c.req.param('name') ?? '';
  if (!cardNewsStore().get(id)) return c.json({ error: 'unknown card' }, 404);
  if (!/^slide_\d{2}\.png$/.test(name)) return c.json({ error: 'bad name' }, 400);
  try {
    const buf = fs.readFileSync(path.join(cardNewsStore().dirFor(id), name));
    return c.body(new Uint8Array(buf), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  } catch { return c.json({ error: 'slide not found' }, 404); }
}
// 전체 zip 다운로드 — 슬라이드 PNG + 캡션. 시스템 zip(-j 평탄화) 사용, 매 요청 재생성(간단·항상 최신).
async function cardNewsZipHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const card = cardNewsStore().get(id);
  if (!card) return c.json({ error: 'unknown card' }, 404);
  if (card.stage !== 'ready') return c.json({ error: '아직 완성되지 않았습니다.' }, 409);
  const dir = cardNewsStore().dirFor(id);
  const files = fs.readdirSync(dir).filter((f) => /^slide_\d{2}\.png$/.test(f) || f === 'caption.txt').sort();
  if (!files.length) return c.json({ error: '산출물이 없습니다.' }, 404);
  const zipPath = path.join(dir, 'cardnews.zip');
  try { fs.rmSync(zipPath, { force: true }); } catch { /* 무해 */ }
  try {
    await execFileP('/usr/bin/zip', ['-j', '-q', zipPath, ...files.map((f) => path.join(dir, f))]);
    const buf = fs.readFileSync(zipPath);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="cardnews-${id}.zip"`,
    });
  } catch (e) {
    return c.json({ error: `zip 생성 실패: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}
function cardNewsDeleteHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!cardNewsStore().get(id)) return c.json({ error: 'unknown card' }, 404);
  if (isCardNewsRunning(id)) return c.json({ error: '생성이 진행 중입니다 — 완료 후 삭제하세요.' }, 409);
  cardNewsStore().remove(id); // 기본은 산출물 파일 남김(비파괴 — pieces 삭제와 동일 원칙)
  try { promiseStore().dropBySource(id); } catch { /* 무해 — 예고 정리 실패가 삭제를 막지 않음 */ }
  if (c.req.query('purge') === '1') trashContentFiles('cardnews', id); // 완전 삭제 — 산출물·성과도 휴지통 이동
  return c.json({ ok: true });
}

app.post('/cardnews', cardNewsCreateHandler);
app.post('/api/cardnews', cardNewsCreateHandler);
app.post('/pieces/:id/cardnews', cardNewsFromPieceHandler);
app.post('/api/pieces/:id/cardnews', cardNewsFromPieceHandler);
app.get('/cardnews', cardNewsListHandler);
app.get('/api/cardnews', cardNewsListHandler);
app.get('/cardnews/:id/slides/:name', cardNewsSlideHandler); // :id 보다 먼저(구체 경로 우선)
app.get('/api/cardnews/:id/slides/:name', cardNewsSlideHandler);
app.get('/cardnews/:id/zip', cardNewsZipHandler);
app.get('/api/cardnews/:id/zip', cardNewsZipHandler);
app.get('/cardnews/:id', cardNewsGetHandler);
app.get('/api/cardnews/:id', cardNewsGetHandler);
app.delete('/cardnews/:id', cardNewsDeleteHandler);
app.delete('/api/cardnews/:id', cardNewsDeleteHandler);

// ============================================================
// 숏폼 — 숏폼팀(standby) 전용 파이프라인. 카드뉴스와 동일 구조(런 등록 = 오피스 뷰 연동,
// GET 폴링, 발행 없음 — 다운로드 전용). 산출물: 세로 MP4 + srt + 캡션.
// ============================================================

/** 담당자 실명(작가·디렉터) — 로스터에서 해석해 레코드에 표기(UI용). */
function shortsActorNames(): { writer?: string; director?: string } {
  try {
    const roles = rolesById(getCompany());
    return { writer: roles.get('shorts_writer')?.name, director: roles.get('shorts_director')?.name };
  } catch { return {}; }
}

// 숏폼 잡을 '런'으로 등록 — 유하린·서준영의 스폰·작업·지표가 오피스 뷰에 흐르고,
// 런 취소 → abort 로 잡 중단, 완료 시 이벤트 영속(리플레이). launchCardNewsRun 과 동일 패턴.
function launchShortsRun(shortsId: string, topic: string, opts: { sourceBody?: string; sceneCount?: number; sourceFlagged?: string[] } = {}): string {
  const id = runId();
  const bus = createBus(id);
  const abort = new AbortController();
  const handle: RunHandle = {
    status: 'running', abort, topic: `숏폼: ${topic}`.slice(0, 80), created_ts: new Date().toISOString(), auto: false,
  };
  handle.brand = activeBrandSlug() || undefined;
  RUNS.set(id, handle);
  evictRuns();
  bus.emit(EventType.run_started, { topic: handle.topic });
  runShortsJob(shortsId, { ...opts, bus, signal: abort.signal })
    .then(() => {
      const s = shortsStore().get(shortsId);
      if (abort.signal.aborted) { handle.status = 'cancelled'; bus.emit(EventType.run_done, { status: 'cancelled' }); return; }
      if (s?.stage === 'ready') {
        handle.status = 'done';
        handle.deliverable = [
          `숏폼 ${s.durationSec ?? 0}초 · 씬 ${s.scenes ?? 0}개 완성 — ${s.title ?? s.topic}`,
          s.description ?? '', (s.hashtags ?? []).join(' '),
        ].filter(Boolean).join('\n\n');
        bus.emit(EventType.run_done, { status: 'done' });
      } else {
        handle.status = 'error';
        bus.emit(EventType.error, { message: s?.error ?? '숏폼 생성 실패' });
        bus.emit(EventType.run_done, { status: 'error' });
      }
    })
    .catch((e: unknown) => {
      handle.status = abort.signal.aborted ? 'cancelled' : 'error';
      if (!abort.signal.aborted) bus.emit(EventType.error, { message: e instanceof Error ? e.message : String(e) });
      bus.emit(EventType.run_done, { status: handle.status });
    })
    .finally(() => { persistEvents(id, bus); persistRunMeta(id, handle); });
  return id;
}

async function shortsCreateHandler(c: Context): Promise<Response> {
  const b = await c.req.json<{ topic?: string; keyword?: string; scenes?: number; force?: boolean }>()
    .catch(() => ({}) as { topic?: string; keyword?: string; scenes?: number; force?: boolean });
  const topic = (b.topic ?? '').trim();
  if (!topic) return c.json({ error: 'topic 이 필요합니다' }, 400);
  const sim = noveltyViolation(topic, b.keyword, b.force);
  if (sim) return c.json(noveltyError(sim), 409);
  const short = shortsStore().create({ topic, keyword: b.keyword, ...shortsActorNames() });
  const run = launchShortsRun(short.id, topic, { sceneCount: b.scenes });
  return c.json({ short, run_id: run });
}

// 블로그 초안 → 숏폼 파생(공용) — 검토 탭 버튼·네이버 저장 성공 자동 훅이 공유.
/**
 * 원문(블로그) 사실 게이트가 건 주장 — unsupported + unverified(2026-08-28 처방 C).
 * 파생물이 이 문장들을 다시 실으면 승계로 표시한다. 실사고: 블로그 hold ↔ 파생 pass 인데
 * '근거 미확인'으로 분류된 손질 시기가 그대로 숏폼 화면 목록에 떴다.
 * 읽기 실패는 빈 배열(fail-open) — 승계 검사가 파생 생성을 막지 않는다.
 */
function sourceFlaggedClaims(runId: string | undefined): string[] {
  if (!runId) return [];
  try {
    const g = readFactGate(runId);
    // unverified 는 '보류시키진 않았지만 근거가 확인되지 않은' 문장이다 — 원문에선 참고로 통과시켜도
    // 파생물이 단정문·화면 목록으로 바꿔 실으면 성격이 달라진다. 그래서 unsupported 와 함께 본다.
    return g ? [...(g.unsupported ?? []), ...(g.unverified ?? [])].filter(Boolean) : [];
  } catch { return []; }
}

function deriveShortsFromPiece(pieceId: string, scenes?: number, auto = false): { short: Shorts } | { error: string } {
  const piece = pieceStore().get(pieceId);
  if (!piece) return { error: 'unknown piece' };
  if (!piece.runId) return { error: '초안이 아직 없습니다.' };
  let body = '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, piece.runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    body = (d.bodyMarkdown ?? '').trim();
  } catch { /* 아래에서 거절 */ }
  if (!body) return { error: '초안 본문(draft.json)을 읽을 수 없습니다.' };
  const short = shortsStore().create({
    topic: piece.title, keyword: piece.keyword, sourcePieceId: piece.id, auto, ...shortsActorNames(),
  });
  launchShortsRun(short.id, piece.title, { sourceBody: body, sceneCount: scenes, sourceFlagged: sourceFlaggedClaims(piece.runId) });
  return { short };
}
async function shortsFromPieceHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  const b = await c.req.json<{ scenes?: number }>().catch(() => ({}) as { scenes?: number });
  const r = deriveShortsFromPiece(id, b.scenes);
  if ('error' in r) return c.json({ error: r.error }, r.error === 'unknown piece' ? 404 : 409);
  return c.json({ short: r.short });
}

function shortsListHandler(c: Context): Response {
  return c.json({
    shorts: shortsStore().list().filter(brandMatch).map((x) => {
      const m = x.youtubeUrl ? latestMetrics(x.id) : null; // 업로드된 쇼츠만 — 최신 수집값 뱃지용
      return { ...x, running: isShortsRunning(x.id), ...(m ? { views: m.views, likes: m.likes ?? 0 } : {}) };
    }),
  });
}
function shortsGetHandler(c: Context): Response {
  const x = shortsStore().get(c.req.param('id') ?? '');
  return x ? c.json({ short: { ...x, running: isShortsRunning(x.id) } }) : c.json({ error: 'unknown short' }, 404);
}
// MP4 서빙 — Range 지원(Safari 는 Range 없이는 <video> 재생 거부, Chrome 도 시킹에 필요).
function shortsVideoHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!shortsStore().get(id)) return c.json({ error: 'unknown short' }, 404);
  const fp = path.join(shortsStore().dirFor(id), 'final.mp4');
  let size = 0;
  try { size = fs.statSync(fp).size; } catch { return c.json({ error: 'video not found' }, 404); }
  const range = c.req.header('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2]!, 10));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (!Number.isFinite(start) || start >= size || start > end) {
      return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    }
    const fd = fs.openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      return c.body(new Uint8Array(buf), 206, {
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(buf.length),
      });
    } finally { fs.closeSync(fd); }
  }
  const buf = fs.readFileSync(fp);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(size),
  });
}
// 썸네일 서빙 — final.mp4 훅 프레임 1장(lazy 생성·캐시). 카드 <video poster> 용. 동시 요청은 한 번의 생성을 공유.
const thumbJobs = new Map<string, Promise<string | null>>();
async function shortsThumbnailHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!shortsStore().get(id)) return c.json({ error: 'unknown short' }, 404);
  const thumb = path.join(shortsStore().dirFor(id), 'thumbnail.jpg');
  let job = thumbJobs.get(id);
  if (!job) { job = ensureShortsThumbnail(shortsStore().dirFor(id)).finally(() => thumbJobs.delete(id)); thumbJobs.set(id, job); }
  await job;
  let buf: Buffer;
  try { buf = fs.readFileSync(thumb); } catch { return c.json({ error: 'thumbnail not found' }, 404); }
  return c.body(new Uint8Array(buf), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
}
// 전체 zip — MP4 + 자막(srt) + 캡션. 매 요청 재생성(항상 최신).
async function shortsZipHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown short' }, 404);
  if (s.stage !== 'ready') return c.json({ error: '아직 완성되지 않았습니다.' }, 409);
  const dir = shortsStore().dirFor(id);
  const files = ['final.mp4', 'subtitles.srt', 'caption.txt'].filter((f) => fs.existsSync(path.join(dir, f)));
  if (!files.length) return c.json({ error: '산출물이 없습니다.' }, 404);
  const zipPath = path.join(dir, 'shorts.zip');
  try { fs.rmSync(zipPath, { force: true }); } catch { /* 무해 */ }
  try {
    await execFileP('/usr/bin/zip', ['-j', '-q', zipPath, ...files.map((f) => path.join(dir, f))]);
    const buf = fs.readFileSync(zipPath);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="shorts-${id}.zip"`,
    });
  } catch (e) {
    return c.json({ error: `zip 생성 실패: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}
function shortsDeleteHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!shortsStore().get(id)) return c.json({ error: 'unknown short' }, 404);
  if (isShortsRunning(id)) return c.json({ error: '생성이 진행 중입니다 — 완료 후 삭제하세요.' }, 409);
  shortsStore().remove(id); // 기본은 산출물 파일 남김(비파괴)
  try { promiseStore().dropBySource(id); } catch { /* 무해 — 예고 정리 실패가 삭제를 막지 않음 */ }
  if (c.req.query('purge') === '1') trashContentFiles('shorts', id); // 완전 삭제 — 산출물·성과도 휴지통 이동
  return c.json({ ok: true });
}

app.post('/shorts', shortsCreateHandler);
app.post('/api/shorts', shortsCreateHandler);
app.post('/pieces/:id/shorts', shortsFromPieceHandler);
app.post('/api/pieces/:id/shorts', shortsFromPieceHandler);
app.get('/shorts', shortsListHandler);
app.get('/api/shorts', shortsListHandler);
// ── 유튜브 발행(브랜드별 채널) — 공용 OAuth 클라이언트 + 브랜드 refresh token(YOUTUBE_TOKENS).
//    비공개 업로드 고정 — 공개 전환은 사람이 유튜브 스튜디오에서(네이버 '임시저장' 원칙).
const YT_REDIRECT = `http://127.0.0.1:${CONFIG.port}/youtube/oauth/callback`; // PORT 변경 시 구글 콘솔 리디렉션 URI 도 함께 갱신
// OAuth state = 1회용 난수 논스(브랜드는 서버 메모리에서 복원, 10분 TTL) — 위조 콜백으로 임의
// 브랜드에 공격자 토큰을 심는 CSRF 차단 + 비정상 슬러그가 토큰 blob 에 저장되는 것 차단.
const YT_OAUTH_PENDING = new Map<string, { brand: string; exp: number }>();
app.get('/youtube/status', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  const client = !!(getSecret('YOUTUBE_OAUTH_CLIENT_ID') && getSecret('YOUTUBE_OAUTH_CLIENT_SECRET'));
  return c.json({ client, connected: !!getYoutubeAccount(brand).refreshToken });
});
app.get('/youtube/oauth/start', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  if (brand && !isSafeBrandSlug(brand)) return c.text('비정상 브랜드 슬러그', 400);
  const id = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  if (!id) return c.text('유튜브 OAuth 클라이언트 미설정 — 키 탭에서 먼저 입력하세요', 400);
  const nonce = randomBytes(16).toString('hex');
  for (const [k, v] of YT_OAUTH_PENDING) if (v.exp < Date.now()) YT_OAUTH_PENDING.delete(k); // 만료 청소
  YT_OAUTH_PENDING.set(nonce, { brand, exp: Date.now() + 10 * 60_000 });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', YT_REDIRECT);
  u.searchParams.set('response_type', 'code');
  // readonly 추가(2026-07-29) — 구독자 수 조회(channels.list mine=true)용. 기존 연결 토큰은 upload 뿐이라
  // 재연결 전까지는 팔로워 추적이 API 키 공개 통계 폴백으로 동작한다(analytics/followers).
  u.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', nonce);
  return c.redirect(u.toString());
});
app.get('/youtube/oauth/callback', async (c) => {
  const code = c.req.query('code') ?? '';
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const done = (msg: string): Response => c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${esc(msg)} — 이 창을 닫으세요.</body>`);
  const state = c.req.query('state') ?? '';
  const pending = YT_OAUTH_PENDING.get(state);
  if (!pending || pending.exp < Date.now()) return done('연결 실패: 유효하지 않거나 만료된 연결 요청 — 채널 연결을 다시 시작하세요');
  YT_OAUTH_PENDING.delete(state); // 1회용
  const brand = pending.brand;
  if (!code) return done(`연결 실패: ${c.req.query('error') ?? '인증 코드 없음'}`);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: getSecret('YOUTUBE_OAUTH_CLIENT_ID') ?? '', client_secret: getSecret('YOUTUBE_OAUTH_CLIENT_SECRET') ?? '',
        redirect_uri: YT_REDIRECT, grant_type: 'authorization_code',
      }),
    });
    const j = await r.json() as { refresh_token?: string; error?: string };
    if (!j.refresh_token) return done(`연결 실패: refresh token 없음(${j.error ?? r.status}) — 구글 계정 보안 설정에서 이 앱 액세스를 제거한 뒤 다시 연결하세요`);
    setYoutubeToken(brand, j.refresh_token);
    console.log(`[발행담당] 유튜브 채널 연결 — 브랜드 '${brand || '범용'}'`);
    return done(`✅ 채널 연결 완료 (브랜드: ${brand || '범용'})`);
  } catch (e) { return done(`연결 실패: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
});
// 유튜브 업로드 in-flight 락 — youtubeUrl 은 업로드 '완료 후'에야 기록되므로 그 가드만으로는
// 동시/이중 제출(특히 텔레그램 버튼 이중 탭)이 같은 영상을 두 번 올린다(중복 영상+쿼터 낭비).
const ytPublishInFlight = new Set<string>();
/** 숏폼 수정 요청(검토 탭) — 자유 피드백 → 대본·제목·설명 개정 → 필요 씬만 배경 재생성 → 재조립.
 *  발행(유튜브·릴스) 후엔 파일 교체 불가라 거절. 재조립 포함 수 분 동기 호출. */
async function shortsReviseHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const b = await c.req.json<{ feedback?: string }>().catch(() => ({} as { feedback?: string }));
  const feedback = (b.feedback ?? '').trim();
  if (!feedback) return c.json({ error: '수정 요청 내용이 비었습니다.' }, 400);
  console.log(`[발행담당] 숏폼 수정 요청 접수 — ${id}: ${feedback.slice(0, 80)}`); // 유실 추적용(카드와 동일)
  const r = await reviseShorts(id, feedback);
  if (!r.ok) { console.log(`[발행담당] 숏폼 수정 요청 기각 — ${id}: ${r.error ?? ''}`); return c.json({ error: r.error, ...r }, 409); }
  console.log(`[발행담당] 숏폼 수정 요청 반영 — ${id} 씬 ${r.changedScenes.join(',') || '문구없음'}${r.regenScenes.length ? ` · 배경 ${r.regenScenes.join(',')}` : ''}${r.titleChanged ? ' · 제목' : ''}${r.titleArtChanged ? ' · 캘리' : ''}`);
  return c.json(r);
}
app.post('/shorts/:id/revise', shortsReviseHandler);
app.post('/api/shorts/:id/revise', shortsReviseHandler);

/** 쇼츠 제목 교체(업로드 전 한정) — 제목 후보(plan.titles) 선택 또는 직접 지정. 영상 캘리 오버레이는
 *  제목 원문이 아니라 키워드+카피(title-copy.json)를 굽으므로 재렌더 없이 안전. 업로드 후엔 스튜디오에서. */
async function shortsTitleHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown shorts' }, 404);
  if (s.youtubeUrl) return c.json({ error: '이미 업로드됨 — 제목은 유튜브 스튜디오에서 수정하세요' }, 409);
  const b = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }));
  const title = (b.title ?? '').trim();
  if (!title || title.length > 100) return c.json({ error: '제목이 비었거나 100자 초과입니다' }, 400);
  shortsStore().update(id, { title });
  console.log(`[발행담당] 쇼츠 제목 교체 — ${(s.title ?? '').slice(0, 24)} → ${title.slice(0, 40)}`);
  return c.json({ ok: true, title });
}
app.post('/shorts/:id/title', shortsTitleHandler);
app.post('/api/shorts/:id/title', shortsTitleHandler);
app.post('/shorts/:id/youtube', async (c) => {
  const id = c.req.param('id');
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown shorts' }, 404);
  if (s.stage !== 'ready') return c.json({ error: '완성(ready) 상태가 아닙니다' }, 409);
  // 길이 상한 발행 게이트(2026-08-20 하드 캡) — 어떤 경로(수정요청 재조립·구버전 잔존분)로 ready 가 됐든 초과본 발행 차단.
  if ((s.durationSec ?? 0) > CONFIG.shortsMaxDurationSec) return c.json({ error: `길이 상한 초과(${s.durationSec}초 > ${CONFIG.shortsMaxDurationSec}초) — ✍수정요청으로 대본을 줄인 뒤 발행하세요` }, 409);
  if (s.youtubeUrl) return c.json({ error: '이미 업로드됨', url: s.youtubeUrl }, 409); // 중복 영상·쿼터 낭비 방지
  if (ytPublishInFlight.has(id)) return c.json({ error: '이미 업로드 처리 중입니다' }, 409);
  ytPublishInFlight.add(id);
  try {
    const ytDir = shortsStore().dirFor(id);
    // 인트로(1.6초=디자인 썸네일) 붙은 영상을 업로드하고, 썸네일은 그 '영상 첫 프레임'으로 지정 —
    // 미지정 시 유튜브가 중간 프레임을 자동 선택해 커버가 엉뚱해짐(실측 2026-07-22, 사용자 방침: 맨 처음이 보이게).
    const ytVideo = (await ensureShortsDownload(ytDir)) ?? path.join(ytDir, 'final.mp4');
    const ytCover = await extractFirstFrame(ytVideo, path.join(ytDir, 'yt-cover.jpg'));
    const r = await uploadShortsToYoutube({
      slug: s.brand ?? '', videoPath: ytVideo,
      title: s.title ?? s.topic, description: s.description ?? '', hashtags: s.hashtags ?? [],
      blogUrl: blogUrlForPiece(s.sourcePieceId), // 원본 블로그 링크 — 발행 시점 조회(사용자 확정 2026-07-31)
      thumbnailPath: ytCover ?? undefined,
    });
    if (!r.ok) return c.json({ error: r.error }, 502);
    shortsStore().update(id, { youtubeId: r.videoId, youtubeUrl: r.url, youtubeTs: new Date().toISOString() });
    if (r.thumbnailError) console.log(`[발행담당] ${(s.title ?? s.topic).slice(0, 24)} — 썸네일 미적용: ${r.thumbnailError}`);
    console.log(`[발행담당] ${(s.title ?? s.topic).slice(0, 30)} — 유튜브 비공개 업로드 완료 (${publisherName()})`);
    return c.json({ ok: true, url: r.url, thumbnailError: r.thumbnailError });
  } finally {
    ytPublishInFlight.delete(id);
  }
});
// ── 메타(인스타·페북) 발행 — 공용 개발자 앱 + 브랜드별 페이지·IG 토큰(META_TOKENS).
//    콜백: code→장기 사용자 토큰→/me/accounts. 페이지 1개면 즉시 저장, 여러 개면 pick 화면.
// 메타는 OAuth 리디렉션 HTTPS 강제 → 콜백 전용 HTTPS 포트(기본 port+1). 페이스북 앱의 리디렉션 URI 와 일치 필수.
const META_HTTPS_PORT = Number(process.env.META_HTTPS_PORT) || (CONFIG.port + 1);
const META_REDIRECT = `https://localhost:${META_HTTPS_PORT}/meta/oauth/callback`;
// 인스타그램 로그인 방식(2026-07-20 전환) — instagram.com/oauth 는 instagram_business_* 만 받는다
// (pages_* 는 페북 로그인 전용이라 넣으면 Invalid Scopes). 인스타 앱 ID/시크릿(페북 앱과 별개)을 쓴다.
const META_SCOPES = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights';
interface MetaPage { id: string; name: string; access_token: string; tasks?: string[]; instagram_business_account?: { id: string } }
const META_OAUTH_PENDING = new Map<string, { brand: string; exp: number; pages?: MetaPage[] }>();
// 그래프 호스트·버전은 metaPublish.GRAPH 단일 선언을 재사용(전역 제약). dialog URL 만 www.facebook.com 호스트.
// 인스타그램 로그인 방식(2026-07-20) — 인스타 앱 ID/시크릿(INSTAGRAM_APP_ID/SECRET, 페북 앱과 별개).
// instagram.com/oauth → code → api.instagram.com(단기) → graph.instagram.com(장기 60일). 페이지 없음.
const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH = 'https://graph.instagram.com';
// 페이스북 페이지 발행(선택·독립 연결) — 페북 로그인은 '메타 앱' 자체의 ID/시크릿(META_APP_ID)을 쓴다.
// 인스타 연결과 앱·토큰·호스트가 모두 달라 한쪽만 연결돼도 그쪽 채널은 발행된다.
// 스코프는 페이지 목록·게시·인사이트 + 영상(릴스). 앱에서 일부 권한이 요청 불가면 META_FB_SCOPES 로 조정.
const FB_AUTHORIZE = 'https://www.facebook.com/v23.0/dialog/oauth';
const FB_GRAPH_HOST = 'https://graph.facebook.com/v23.0';
const FB_REDIRECT = `https://localhost:${META_HTTPS_PORT}/meta/fb/oauth/callback`;
// 스코프 오버라이드는 요청 시점에 읽는다(.env 즉시 반영) — 'Invalid Scopes' 진단 중 서버 재시작 없이
// 권한을 하나씩 빼며 어느 것이 앱에 없는지 좁힐 수 있어야 한다.
// business_management 포함 이유(실측 2026-07-27): 페이지 권한이 전부 허용됐는데도 /me/accounts 가 비고
// /me/businesses 가 '(#100) Missing Permission' 이었다 — 비즈니스 포트폴리오 소유 페이지를 찾으려면 필요하다.
// 이 권한은 '페이지의 모든 부분 관리' 이용 사례의 필수 권한이라 앱에 이미 붙어 있다.
// pages_read_user_content·pages_manage_engagement 포함 이유(실측 2026-07-27): 게시물 반응 조회
// (reactions/comments/shares)와 릴스 커버 지정(/{video-id}/thumbnails)이 이 둘을 요구한다 — 없으면 (#10).
// read_insights 는 여기 넣지 않는다(실측 2026-07-27). 사진 게시물(카드뉴스) 조회수는 이 권한이
// 있어야 인사이트로 읽히지만(없으면 빈 data → 조회수가 조용히 0), 앱 대시보드의 이용 사례에
// 이 권한이 추가돼 있지 않으면 메타가 로그인 창 자체를 "Invalid Scopes: read_insights" 로 거부한다.
// 즉 앱에 없는 권한 하나가 재연결 전체를 막는다 — 기본값에 넣으면 연결이 통째로 죽는다.
// 활성화 순서: ① 앱 대시보드 이용 사례에 read_insights 추가 → ② .env 의 META_FB_SCOPES 에
// 이 목록 + ,read_insights 를 넣어 검증 → ③ 통과하면 그때 이 기본값에 편입.
const FB_SCOPES_DEFAULT = 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_manage_engagement,publish_video,business_management';
const fbScopes = (): string => getSecret('META_FB_SCOPES') || FB_SCOPES_DEFAULT;
// 비즈니스용 Facebook 로그인(FBLB)의 '구성' 방식 — 구성 ID 를 주면 권한·자산 선택이 구성에서 온다.
// scope 방식으로는 자산(페이지) 선택 화면이 아예 안 나올 수 있어(권한만 승인되고 페이지 0개) 그때의 정공법이다.
// 대시보드: 비즈니스용 Facebook 로그인 → 구성 에서 만들고 그 ID 를 .env 의 META_FB_CONFIG_ID 에 넣는다.
const fbConfigId = (): string => getSecret('META_FB_CONFIG_ID') || '';
app.get('/meta/status', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  const client = !!(getSecret('INSTAGRAM_APP_ID') && getSecret('INSTAGRAM_APP_SECRET'));
  const fbClient = !!(getSecret('META_APP_ID') && getSecret('META_APP_SECRET'));
  const a = getMetaAccount(brand);
  // pageId 는 공개 식별자(토큰류 절대 미포함) — UI 가 페이지 링크·연결 상태 표시에 쓴다.
  return c.json({
    client, connected: !!(a.igUserId && a.pageAccessToken),
    fbClient, fbConnected: !!(a.pageId && a.pageToken), pageId: a.pageId || undefined,
  });
});
app.get('/meta/oauth/start', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  if (brand && !isSafeBrandSlug(brand)) return c.text('비정상 브랜드 슬러그', 400);
  const id = getSecret('INSTAGRAM_APP_ID');
  if (!id) return c.text('인스타그램 앱 미설정 — .env 의 INSTAGRAM_APP_ID/SECRET 에 Instagram 제품의 앱 ID/시크릿을 입력하세요(페북 앱과 별개)', 400);
  const nonce = randomBytes(16).toString('hex');
  for (const [k, v] of META_OAUTH_PENDING) if (v.exp < Date.now()) META_OAUTH_PENDING.delete(k);
  META_OAUTH_PENDING.set(nonce, { brand, exp: Date.now() + 10 * 60_000 });
  const u = new URL(IG_AUTHORIZE);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', META_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', META_SCOPES);
  u.searchParams.set('state', nonce);
  return c.redirect(u.toString());
});
app.get('/meta/oauth/callback', async (c) => {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const done = (msg: string): Response => c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${esc(msg)} — 이 창을 닫으세요.</body>`);
  const state = c.req.query('state') ?? '';
  const pending = META_OAUTH_PENDING.get(state);
  if (!pending || pending.exp < Date.now()) return done('연결 실패: 유효하지 않거나 만료된 연결 요청 — 메타 연결을 다시 시작하세요');
  META_OAUTH_PENDING.delete(state);
  const code = c.req.query('code') ?? '';
  if (!code) return done(`연결 실패: ${c.req.query('error_description') ?? c.req.query('error') ?? '인증 코드 없음'}`);
  try {
    const cid = getSecret('INSTAGRAM_APP_ID') ?? '';
    const sec = getSecret('INSTAGRAM_APP_SECRET') ?? '';
    // ① 단기 토큰 + user_id — api.instagram.com(form-urlencoded POST). Instagram Login 네이티브.
    const tok = await fetch(IG_TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, client_secret: sec, grant_type: 'authorization_code', redirect_uri: META_REDIRECT, code }),
    });
    const tj = await tok.json() as { access_token?: string; user_id?: number | string; error_message?: string };
    if (!tj.access_token || !tj.user_id) return done(`연결 실패: ${tj.error_message ?? '토큰/사용자 ID 없음'}`);
    // ② 장기 토큰(60일) — graph.instagram.com/access_token?grant_type=ig_exchange_token.
    const long = await fetch(`${IG_GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(sec)}&access_token=${encodeURIComponent(tj.access_token)}`);
    const lj = await long.json() as { access_token?: string };
    const igToken = lj.access_token ?? tj.access_token; // 장기 교환 실패 시 단기로 진행(1h) — 다음 연결에 갱신
    // user_id 는 토큰 응답에서 JSON 숫자(>2^53)로 와 JSON.parse 가 마지막 자리를 반올림(정밀도 손실).
    // /me?fields=user_id 로 문자열 id 를 다시 받아 저장(발행 URL 은 me 별칭이라 무의존이지만 상태·게이트 정확값용).
    let igUserId = String(tj.user_id);
    try {
      const me = await fetch(`${IG_GRAPH}/me?fields=user_id&access_token=${encodeURIComponent(igToken)}`);
      const mj = await me.json() as { user_id?: string };
      if (mj.user_id) igUserId = String(mj.user_id);
    } catch { /* /me 실패 시 토큰 user_id 유지(정밀도 주의) — me 별칭 발행이라 발행엔 무영향 */ }
    setMetaToken(pending.brand, { igUserId, pageAccessToken: igToken }); // FB 페이지 연결은 보존(setMetaToken 계약)
    console.log(`[발행담당] 인스타그램 연결 — 브랜드 '${pending.brand || '범용'}' (IG user ${igUserId})`);
    return done(`✅ 인스타그램 연결 완료 (브랜드: ${pending.brand || '범용'})`);
  } catch (e) { return done(`연결 실패: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
});
// ── 페이스북 페이지 연결(페북 로그인) ────────────────────────────────────────
// code → 단기 사용자 토큰 → 장기 사용자 토큰(fb_exchange_token) → /me/accounts 의 페이지 액세스 토큰.
// 장기 사용자 토큰에서 받은 페이지 토큰은 사실상 만료가 없다(비밀번호 변경·권한 회수 시 무효).
app.get('/meta/fb/oauth/start', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  if (brand && !isSafeBrandSlug(brand)) return c.text('비정상 브랜드 슬러그', 400);
  const id = getSecret('META_APP_ID');
  if (!id) return c.text('메타 앱 미설정 — 키 탭의 META_APP_ID/META_APP_SECRET 에 메타 앱(설정>기본 설정)의 앱 ID/시크릿을 입력하세요(인스타 앱 ID 와 다름)', 400);
  const nonce = randomBytes(16).toString('hex');
  for (const [k, v] of META_OAUTH_PENDING) if (v.exp < Date.now()) META_OAUTH_PENDING.delete(k);
  META_OAUTH_PENDING.set(nonce, { brand, exp: Date.now() + 10 * 60_000 });
  const u = new URL(FB_AUTHORIZE);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', FB_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', nonce);
  const cfg = fbConfigId();
  if (cfg) {
    // 구성 방식 — 권한·자산 목록은 구성이 정하므로 scope 를 함께 보내지 않는다(충돌 방지).
    // override_default_response_type: 구성 기본 응답형이 토큰이어도 code 를 받게 강제(서버 교환 유지).
    u.searchParams.set('config_id', cfg);
    u.searchParams.set('override_default_response_type', 'true');
  } else {
    u.searchParams.set('scope', fbScopes());
  }
  return c.redirect(u.toString());
});
app.get('/meta/fb/oauth/callback', async (c) => {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const done = (msg: string): Response => c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${esc(msg)} — 이 창을 닫으세요.</body>`);
  const state = c.req.query('state') ?? '';
  const pending = META_OAUTH_PENDING.get(state);
  if (!pending || pending.exp < Date.now()) return done('연결 실패: 유효하지 않거나 만료된 연결 요청 — 페이스북 연결을 다시 시작하세요');
  META_OAUTH_PENDING.delete(state);
  const code = c.req.query('code') ?? '';
  if (!code) return done(`연결 실패: ${c.req.query('error_description') ?? c.req.query('error') ?? '인증 코드 없음'}`);
  try {
    const cid = getSecret('META_APP_ID') ?? '';
    const sec = getSecret('META_APP_SECRET') ?? '';
    // ① code → 단기 사용자 토큰.
    const t1 = await fetch(`${FB_GRAPH_HOST}/oauth/access_token?client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(sec)}&redirect_uri=${encodeURIComponent(FB_REDIRECT)}&code=${encodeURIComponent(code)}`);
    const j1 = await t1.json() as { access_token?: string; error?: { message?: string } };
    if (!j1.access_token) return done(`연결 실패: ${j1.error?.message ?? '사용자 토큰 없음'}`);
    // ② 장기 사용자 토큰(60일) — 이걸로 받은 페이지 토큰이 장수(단기로 받으면 1시간 뒤 발행 실패).
    const t2 = await fetch(`${FB_GRAPH_HOST}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(sec)}&fb_exchange_token=${encodeURIComponent(j1.access_token)}`);
    const j2 = await t2.json() as { access_token?: string };
    const userToken = j2.access_token ?? j1.access_token;
    // ③ 연결할 페이지 수집(비즈니스 포트폴리오 경유 포함) + 실패 시 원인 진단.
    const { pages, diag } = await collectFbPages(userToken);
    if (!pages.length) {
      return done(`연결 실패: 연결할 페이스북 페이지를 찾지 못했습니다 — ${diag.join(' / ') || '원인 미상'} · 권한 화면에서 페이지를 체크했는지, 그 계정이 해당 페이지의 관리자인지 확인하세요`);
    }
    if (pages.length === 1) return done(saveFbPage(pending.brand, pages[0]!));
    // 여러 페이지 → 선택 화면(새 nonce 에 페이지 목록 보관, 토큰은 서버에만 둔다).
    const pick = randomBytes(16).toString('hex');
    META_OAUTH_PENDING.set(pick, { brand: pending.brand, exp: Date.now() + 10 * 60_000, pages });
    const rows = pages.map((p) => `<li><a href="/meta/fb/pick?state=${pick}&page=${encodeURIComponent(p.id)}">${esc(p.name || p.id)}</a></li>`).join('');
    return c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><p>발행할 페이지를 고르세요 (브랜드: ${esc(pending.brand || '범용')})</p><ul>${rows}</ul></body>`);
  } catch (e) { return done(`연결 실패: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
});
/**
 * 게시 가능 페이지 우선 선별(순수) — CREATE_CONTENT 작업을 가진 페이지가 있으면 그것만, 없으면 전체.
 * tasks 필드가 응답에 없을 수도 있어(필드 미제공) 그때 전체를 후보로 둔다 — 빈 목록으로 오안내하는 것보다 낫다.
 */
export function pickPublishablePages(all: MetaPage[]): MetaPage[] {
  const ok = all.filter((p) => p.id && p.access_token);
  const creatable = ok.filter((p) => p.tasks?.includes('CREATE_CONTENT'));
  return creatable.length ? creatable : ok;
}

/**
 * 연결 가능한 페이지 수집 — /me/accounts 가 1순위. 비즈니스 포트폴리오가 소유한 페이지는 개인 역할이 아니라
 * 비즈니스 경유로 접근돼 /me/accounts 가 빌 수 있으므로 /me/businesses → owned_pages·client_pages 까지 훑고
 * 페이지 토큰은 페이지 노드에서 개별 조회한다.
 * 빈 결과일 때 원인을 구분할 수 있도록 진단 문구(diag)를 함께 돌려준다 — '페이지 없음' 한 줄로는
 * (승인 계정 착오 / 권한 미허용 / 페이지 미선택 / 비즈니스 소유) 네 경우가 구분되지 않는다. 토큰류는 담지 않는다.
 */
async function collectFbPages(userToken: string): Promise<{ pages: MetaPage[]; diag: string[] }> {
  const tk = encodeURIComponent(userToken);
  const diag: string[] = [];
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const r = await fetch(`${FB_GRAPH_HOST}/${path}${path.includes('?') ? '&' : '?'}access_token=${tk}`);
    const j: unknown = await r.json().catch(() => ({}));
    return (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  };
  const rows = (j: Record<string, unknown>): Array<Record<string, unknown>> =>
    Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : [];
  const errOf = (j: Record<string, unknown>): string | undefined =>
    (j.error as { message?: string } | undefined)?.message;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const acc = await get('me/accounts?fields=id,name,access_token,tasks');
  const direct = pickPublishablePages(rows(acc).map((p) => ({
    id: str(p.id), name: str(p.name), access_token: str(p.access_token),
    tasks: Array.isArray(p.tasks) ? (p.tasks as string[]) : undefined,
  })));
  if (direct.length) return { pages: direct, diag };
  if (errOf(acc)) diag.push(`페이지 목록 오류: ${errOf(acc)}`);

  // 누가 승인했고 어떤 권한이 실제로 허용됐는가 — 여기서 대부분의 오인이 드러난다.
  const me = await get('me?fields=id,name').catch(() => ({} as Record<string, unknown>));
  if (str(me.name)) diag.push(`승인 계정: ${str(me.name)}`);
  const perm = await get('me/permissions').catch(() => ({} as Record<string, unknown>));
  const granted = rows(perm).filter((p) => str(p.status) === 'granted').map((p) => str(p.permission)).filter(Boolean);
  const denied = rows(perm).filter((p) => str(p.status) !== 'granted').map((p) => str(p.permission)).filter(Boolean);
  if (granted.length || denied.length) {
    diag.push(`허용 권한: ${granted.join(' ') || '없음'}`);
    if (denied.length) diag.push(`미허용: ${denied.join(' ')}`);
  }

  // 비즈니스 포트폴리오 경유 — 소유/고객 페이지를 훑어 페이지 토큰을 개별 확보.
  try {
    const bz = await get('me/businesses?fields=id,name');
    if (errOf(bz)) diag.push(`비즈니스 조회 오류: ${errOf(bz)}`);
    const bs = rows(bz);
    diag.push(`비즈니스: ${bs.map((b) => str(b.name) || str(b.id)).filter(Boolean).join(', ') || '없음'}`);
    const found: MetaPage[] = [];
    for (const b of bs.slice(0, 5)) {
      const bid = str(b.id);
      if (!bid) continue;
      for (const edge of ['owned_pages', 'client_pages']) {
        const pr = await get(`${bid}/${edge}?fields=id,name`);
        for (const p of rows(pr).slice(0, 20)) {
          const pid = str(p.id);
          if (!pid || found.some((f) => f.id === pid)) continue;
          const tj = await get(`${pid}?fields=access_token,name`); // 페이지 토큰은 페이지 노드에서만 나온다
          const tok = str(tj.access_token);
          if (tok) found.push({ id: pid, name: str(tj.name) || str(p.name) || pid, access_token: tok });
        }
      }
    }
    if (found.length) {
      diag.push(`비즈니스 소유 페이지에서 ${found.length}개 확보`);
      return { pages: found, diag };
    }
  } catch { diag.push('비즈니스 경유 조회 실패'); }
  return { pages: [], diag };
}

/** 페이지 저장 공용 — 결과 메시지 반환(토큰 미포함). */
function saveFbPage(brand: string, page: MetaPage): string {
  setMetaPage(brand, { pageId: page.id, pageToken: page.access_token });
  console.log(`[발행담당] 페이스북 페이지 연결 — 브랜드 '${brand || '범용'}' (page ${page.id})`);
  return `✅ 페이스북 페이지 연결 완료: ${page.name || page.id} (브랜드: ${brand || '범용'})`;
}
app.get('/meta/fb/pick', (c) => {
  const esc = (x: string): string => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const state = c.req.query('state') ?? '';
  const pending = META_OAUTH_PENDING.get(state);
  if (!pending || pending.exp < Date.now() || !pending.pages) return c.text('만료된 선택 요청 — 페이스북 연결을 다시 시작하세요', 400);
  const page = pending.pages.find((p) => p.id === (c.req.query('page') ?? ''));
  if (!page) return c.text('알 수 없는 페이지', 400);
  META_OAUTH_PENDING.delete(state);
  return c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${esc(saveFbPage(pending.brand, page))} — 이 창을 닫으세요.</body>`);
});
/** 페이스북 페이지 연결 해제 — IG 연결은 보존(브랜드별). */
app.post('/meta/fb/disconnect', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  if (brand && !isSafeBrandSlug(brand)) return c.json({ error: '비정상 브랜드 슬러그' }, 400);
  setMetaPage(brand, null);
  console.log(`[발행담당] 페이스북 페이지 연결 해제 — 브랜드 '${brand || '범용'}'`);
  return c.json({ ok: true });
});
// 메타(인스타) 발행 in-flight 락 — 카드뉴스·릴스 공용. 동시/이중 제출로 같은 공개 게시물이 두 번 올라가는 것 차단(되돌리기 어려움).
const metaPublishInFlight = new Set<string>();
app.post('/cardnews/:id/publish', async (c) => {
  const id = c.req.param('id') ?? '';
  const card = cardNewsStore().get(id);
  if (!card) return c.json({ error: 'unknown cardnews' }, 404);
  if (card.stage !== 'ready') return c.json({ error: '완성(ready) 상태가 아닙니다' }, 409);
  // QA 미해결 게이트(실사고 2026-08-10: 오타 슬라이드가 그대로 인스타 발행) — 사용자 확인(force) 없인 보류.
  // 모든 발행 경로(UI 버튼·텔레그램 버튼)가 이 라우트를 지나므로 여기 한 곳이 관문이다.
  const force = !!(await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }))).force;
  const qaBlock = qaPublishBlockReason(card, force);
  if (qaBlock) return c.json({ error: qaBlock, qa_unresolved: card.qaUnresolved }, 409);
  // 완료 판정 = 인스타(미디어 id + 실제 퍼머링크) + 페이스북 페이지 연결 시 FB 게시물 id.
  // 홈 URL 잔재만 있으면 완료 아님 → 재시도가 링크를 보강하게 통과시킨다.
  // FB 페이지를 나중에 연결한 경우 IG 완료만으로 막으면 페북에 영구히 못 올라간다 → FB 미게시면 통과.
  const cardAcct = getMetaAccount(card.brand ?? '');
  const cardFbPending = !!(cardAcct.pageId && cardAcct.pageToken) && !card.fbPostId; // 발행기와 동일 판정(토큰까지)
  if (card.igMediaId && realPermalink(card.igPermalink) && !cardFbPending) {
    return c.json({ error: '이미 발행됨', igPermalink: card.igPermalink }, 409);
  }
  if (metaPublishInFlight.has(id)) return c.json({ error: '이미 발행 처리 중입니다' }, 409); // 동시/이중 제출 → 중복 공개 발행 차단
  const dir = path.join(CONFIG.dataDir, 'cardnews', id);
  const slides = (() => {
    try { return fs.readdirSync(dir).filter((f) => /^slide_\d{2}\.png$/.test(f)).sort().map((f) => path.join(dir, f)); }
    catch { return [] as string[]; }
  })();
  if (!slides.length) return c.json({ error: '슬라이드 파일 없음' }, 409);
  const wasPublished = !!card.igMediaId;
  metaPublishInFlight.add(id);
  try {
    const r = await publishCardNewsToMeta({
      slug: card.brand ?? '', slidePaths: slides,
      caption: card.caption ?? card.topic, hashtags: card.hashtags ?? [],
      blogUrl: blogUrlForPiece(card.sourcePieceId), // 원본 블로그 링크 — 발행 시점 조회(사용자 확정 2026-07-31)
      existing: { igMediaId: card.igMediaId, igPermalink: card.igPermalink, fbPostId: card.fbPostId },
    });
    // 부분 성공도 저장 — 재시도 시 성공 채널은 existing 으로 스킵(멱등). 퍼머링크는 실제 링크 있을 때만 갱신(홈 URL 덮어쓰기 방지).
    const patch: Partial<CardNews> = {};
    if (r.igMediaId) { patch.igMediaId = r.igMediaId; if (r.igPermalink) patch.igPermalink = r.igPermalink; }
    if (r.fbPostId) { patch.fbPostId = r.fbPostId; if (!card.fbPostTs) patch.fbPostTs = new Date().toISOString(); }
    if ((r.igMediaId || r.fbPostId) && !card.publishedTs) patch.publishedTs = new Date().toISOString();
    if (Object.keys(patch).length) cardNewsStore().update(id, patch);
    if (!r.ok) return c.json({ error: r.error, ...patch }, 502);
    const fbNote = r.fbError ? ' / 페북 실패' : r.fbPostId ? ' + 페북 페이지' : '';
    console.log(`[발행담당] 카드뉴스 "${card.topic.slice(0, 30)}" — 인스타 ${wasPublished ? '퍼머링크 보강' : '발행 완료'}${fbNote}`);
    if (r.fbError) console.log(`[발행담당] 페북 게시 실패 사유: ${r.fbError}`);
    // fbError 는 200 과 함께 올려보낸다 — IG 는 실제로 성공했으므로 502 로 뒤집으면 '실패 위장'이 된다.
    return c.json({ ok: true, igPermalink: r.igPermalink ?? card.igPermalink, fbPostId: r.fbPostId ?? card.fbPostId, fbError: r.fbError });
  } finally {
    metaPublishInFlight.delete(id);
  }
});
/** 카드뉴스 수정 요청(검토 탭) — 블로그 revise 동형: 자유 피드백 → 카피 개정 → 바뀐 슬라이드만
 *  표적 재생성+블라인드 QA 재검수. 발행(인스타) 후엔 이미지 교체 불가라 거절. 수 분 동기 호출. */
async function cardnewsReviseHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const b = await c.req.json<{ feedback?: string }>().catch(() => ({} as { feedback?: string }));
  const feedback = (b.feedback ?? '').trim();
  if (!feedback) return c.json({ error: '수정 요청 내용이 비었습니다.' }, 400);
  // 접수 즉시 로그 — 수 분짜리 동기 처리라 서버 재시작에 요청이 통째로 죽으면 흔적이 없었다
  // (실사고 2026-08-14: 배포 재시작에 사용자 수정 요청 유실, 피드백 내용도 복구 불가).
  console.log(`[발행담당] 카드뉴스 수정 요청 접수 — ${id}: ${feedback.slice(0, 80)}`);
  const r = await reviseCardNews(id, feedback);
  // 기각도 접수처럼 로그 — 조용한 409 는 사용자에겐 '반영 안 됨'으로만 보이고 서버엔 흔적이 없었다
  // (실사고 2026-08-18: 같은 카드 수정 요청 4회 연속 침묵 기각, 원인 추적에 로그 부재).
  if (!r.ok) { console.log(`[발행담당] 카드뉴스 수정 요청 기각 — ${id}: ${r.error ?? ''}`); return c.json({ error: r.error, ...r }, 409); }
  console.log(`[발행담당] 카드뉴스 수정 요청 반영 — ${id} 슬라이드 ${r.changedSlides.join(',') || '문구없음'}${r.stillBad.length ? ` · 미해결 ${r.stillBad.join(',')}` : ''}`);
  return c.json(r);
}
app.post('/cardnews/:id/revise', cardnewsReviseHandler);
app.post('/api/cardnews/:id/revise', cardnewsReviseHandler);

/** 완성 카드의 특정 슬라이드만 표적 재생성(오타 수선) — body.slides 미지정이면 qaUnresolved 대상.
 *  수 분 걸리는 동기 호출(gpt-image 재생성+QA 재검수). 성공 시 qaUnresolved 갱신 → 발행 게이트 해제. */
app.post('/cardnews/:id/repair', async (c) => {
  const id = c.req.param('id') ?? '';
  const body = await c.req.json<{ slides?: number[] }>().catch(() => ({} as { slides?: number[] }));
  const r = await repairCardNewsSlides(id, Array.isArray(body.slides) ? body.slides : undefined);
  if (!r.ok) return c.json({ error: r.error, fixed: r.fixed, stillBad: r.stillBad }, 409);
  return c.json(r);
});
app.post('/api/cardnews/:id/repair', async (c) => {
  const id = c.req.param('id') ?? '';
  const body = await c.req.json<{ slides?: number[] }>().catch(() => ({} as { slides?: number[] }));
  const r = await repairCardNewsSlides(id, Array.isArray(body.slides) ? body.slides : undefined);
  if (!r.ok) return c.json({ error: r.error, fixed: r.fixed, stillBad: r.stillBad }, 409);
  return c.json(r);
});
app.post('/shorts/:id/meta', async (c) => {
  const id = c.req.param('id') ?? '';
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown shorts' }, 404);
  if (s.stage !== 'ready') return c.json({ error: '완성(ready) 상태가 아닙니다' }, 409);
  // 길이 상한 발행 게이트(2026-08-20 하드 캡) — 유튜브 핸들러와 동일. 초과본은 어떤 경로로도 발행 불가.
  if ((s.durationSec ?? 0) > CONFIG.shortsMaxDurationSec) return c.json({ error: `길이 상한 초과(${s.durationSec}초 > ${CONFIG.shortsMaxDurationSec}초) — ✍수정요청으로 대본을 줄인 뒤 발행하세요` }, 409);
  // 완료 판정 = 릴스 id + 실제 퍼머링크 + (페이지 연결 시) FB 릴스 id. 홈 URL 잔재만 있으면 재시도가 링크를 보강하게 통과.
  // FB 페이지를 나중에 연결한 경우 IG 완료만으로 막으면 페북 릴스는 영구히 못 올라간다 → FB 미게시면 통과.
  const shortsAcct = getMetaAccount(s.brand ?? '');
  const fbLinked = !!(shortsAcct.pageId && shortsAcct.pageToken); // 발행기와 동일 판정(토큰까지)
  const metaDir = shortsStore().dirFor(id);
  const metaThumb = path.join(metaDir, 'thumbnail.jpg');
  // 커버 보강 대기 — 릴스는 올라갔는데 커버가 아직 없고 디자인 썸네일 파일이 있는 경우. 썸네일이 없으면
  // 보강할 게 없으므로 대기로 보지 않는다(그래야 '이미 발행됨' 게이트가 계속 살아 있다).
  const coverPending = fbLinked && !!s.fbReelId && !s.fbReelCoverTs && fs.existsSync(metaThumb);
  const shortsFbPending = fbLinked && (!s.fbReelId || coverPending);
  if (s.igReelId && realPermalink(s.igPermalink) && !shortsFbPending) {
    return c.json({ error: '이미 발행됨', igPermalink: s.igPermalink }, 409);
  }
  if (metaPublishInFlight.has(id)) return c.json({ error: '이미 발행 처리 중입니다' }, 409); // 동시/이중 제출 → 중복 공개 발행 차단
  // fal 스토리지 단건 한도 초과분(실측 2026-08-13: 93초 I2V 편성 102MB → HTTP 413)은
  // CRF 재인코딩 사본으로 업로드 — 인트로 없는 릴스 원본 유지, 한도 이하면 원본 그대로.
  const videoPath = await ensureMetaVideo(metaDir);
  if (!videoPath) return c.json({ error: '영상 파일 없음' }, 409);
  const wasPublished = !!s.igReelId;
  metaPublishInFlight.add(id);
  try {
    const r = await publishShortsToMeta({
      slug: s.brand ?? '', videoPath,
      caption: [s.title ?? s.topic, s.description ?? ''].filter(Boolean).join('\n\n'),
      hashtags: s.hashtags ?? [],
      blogUrl: blogUrlForPiece(s.sourcePieceId), // 원본 블로그 링크 — 발행 시점 조회(사용자 확정 2026-07-31)
      thumbnailPath: fs.existsSync(metaThumb) ? metaThumb : undefined,
      existing: { igReelId: s.igReelId, igPermalink: s.igPermalink, fbReelId: s.fbReelId, fbCoverTs: s.fbReelCoverTs },
    });
    // 부분 성공도 저장 — 재시도 시 성공 채널은 existing 으로 스킵(멱등). 릴스는 즉시 공개(스펙 §3). 퍼머링크는 실제 링크 있을 때만 갱신.
    const patch: Partial<Shorts> = {};
    if (r.igReelId) { patch.igReelId = r.igReelId; if (r.igPermalink) patch.igPermalink = r.igPermalink; }
    if (r.fbReelId) { patch.fbReelId = r.fbReelId; if (!s.fbReelTs) patch.fbReelTs = new Date().toISOString(); }
    if (r.fbCoverSet) patch.fbReelCoverTs = new Date().toISOString(); // 재시도마다 커버 재업로드 방지
    if ((r.igReelId || r.fbReelId) && !s.metaPublishedTs) patch.metaPublishedTs = new Date().toISOString();
    if (Object.keys(patch).length) shortsStore().update(id, patch);
    if (!r.ok) return c.json({ error: r.error, ...patch }, 502);
    const fbNote = r.fbError ? ' / 페북 실패' : r.fbCoverSet ? ' + 페북 커버 적용' : r.fbReelId ? ' + 페북 릴스' : '';
    console.log(`[발행담당] ${(s.title ?? s.topic).slice(0, 30)} — 릴스 ${wasPublished ? '퍼머링크 보강' : '발행 완료(즉시 공개)'}${fbNote}`);
    if (r.fbError) console.log(`[발행담당] 페북 릴스 실패 사유: ${r.fbError}`);
    // fbError 는 200 과 함께(IG 릴스는 실제 공개됨 — 502 로 뒤집으면 실패 위장).
    if (r.fbCoverError) console.log(`[발행담당] 페북 릴스 커버 미적용: ${r.fbCoverError}`);
    return c.json({ ok: true, igPermalink: r.igPermalink ?? s.igPermalink, fbReelId: r.fbReelId ?? s.fbReelId, fbError: r.fbError ?? r.fbCoverError });
  } finally {
    metaPublishInFlight.delete(id);
  }
});
// 릴스 재조정 — 라이브 IG 릴스인데 로컬 영속이 유실된 쇼츠(발행 중 재시작 등)를 캡션=제목 매칭으로 백필.
// 안전: igReelId 없는 쇼츠만 채우고 재발행하지 않음(중복 공개 방지). 성과 대시보드 누락 복구용.
app.post('/shorts/meta-reconcile', async (c) => {
  const brand = c.req.query('brand') ?? '';
  let media;
  try { media = await listIgMedia(brand); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 502); }
  const reels = media.filter((m) => m.type === 'REELS' || m.type === 'VIDEO');
  const targets = shortsStore().list()
    .filter((s) => (s.brand ?? '') === brand)
    .map((s) => ({ id: s.id, title: s.title ?? s.topic ?? '', igReelId: s.igReelId }));
  const matches = matchOrphanReels(targets, reels);
  for (const m of matches) shortsStore().update(m.shortsId, { igReelId: m.reelId, igPermalink: m.permalink, metaPublishedTs: m.timestamp });
  if (matches.length) console.log(`[발행담당] 릴스 재조정 — 브랜드 '${brand || '범용'}': ${matches.length}건 백필(라이브 릴스 ${reels.length}개)`);
  return c.json({ ok: true, reconciled: matches.length, reelsOnIg: reels.length, items: matches.map((m) => ({ shortsId: m.shortsId, permalink: m.permalink })) });
});
app.get('/shorts/:id/video', shortsVideoHandler); // :id 보다 먼저(구체 경로 우선)
app.get('/api/shorts/:id/video', shortsVideoHandler);
app.get('/shorts/:id/thumbnail', shortsThumbnailHandler);
app.get('/api/shorts/:id/thumbnail', shortsThumbnailHandler);
// 다운로드 — 썸네일 인트로(1.6초) 붙인 mp4(lazy 빌드·캐시, 동시 요청 1회 빌드 공유). 없으면 원본. 첫 다운로드는 인코딩으로 수 초~십수 초.
const dlJobs = new Map<string, Promise<string | null>>();
async function shortsDownloadHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!shortsStore().get(id)) return c.json({ error: 'unknown short' }, 404);
  const dir = shortsStore().dirFor(id);
  let job = dlJobs.get(id);
  if (!job) { job = ensureShortsDownload(dir).finally(() => dlJobs.delete(id)); dlJobs.set(id, job); }
  const file = (await job) ?? path.join(dir, 'final.mp4');
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return c.json({ error: 'video not found' }, 404); }
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `attachment; filename="shorts-${id}.mp4"`,
    'Content-Length': String(buf.length),
  });
}
app.get('/shorts/:id/download', shortsDownloadHandler);
app.get('/api/shorts/:id/download', shortsDownloadHandler);
// 디자인 썸네일 재생성(온디맨드) — 훅 씬 배경 위에 손글씨 제목/핵심(gpt-image). 기존 쇼츠 업그레이드·재시도용.
const thumbGenInFlight = new Set<string>();
async function shortsThumbnailRegenHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown short' }, 404);
  if (!CONFIG.openaiApiKey) return c.json({ error: 'OPENAI_API_KEY 미설정 — 디자인 썸네일은 이미지 생성 키가 필요합니다' }, 400);
  // 완성 잡이 아직 실행 중이면 그 잡의 자동 썸네일 생성과 겹쳐 이중 과금·작업물 충돌 → 완료 후 재시도 안내(락 공유 효과).
  if (isShortsRunning(id)) return c.json({ error: '생성이 진행 중입니다 — 완료 후 다시 시도하세요' }, 409);
  if (thumbGenInFlight.has(id)) return c.json({ error: '이미 썸네일 생성 중입니다' }, 409);
  const dir = shortsStore().dirFor(id);
  const hook = (() => {
    try {
      const f = fs.readdirSync(path.join(dir, 'scenes')).filter((x) => /\.(png|jpe?g)$/i.test(x)).sort()[0];
      return f ? path.join(dir, 'scenes', f) : null;
    } catch { return null; }
  })();
  if (!hook) return c.json({ error: '훅 씬 이미지가 없어 디자인 썸네일을 만들 수 없습니다(영상 프레임만 가능)' }, 409);
  thumbGenInFlight.add(id);
  try {
    // 클라이언트 이탈해도 작업·락이 무한 점유되지 않게 상한(4분) — generateDesignedThumbnail 은 예외를 던지지 않음.
    // 영상 상단 캘리와 같은 카피 재사용(title-copy.json) — 재생성 썸네일이 영상 속 제목과 문구가 어긋나지 않게.
    const savedCopy = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'title-copy.json'), 'utf-8')) as { line1: string; line2: string; points: string[] }; } catch { return undefined; }
    })();
    const ok = await generateDesignedThumbnail({ dir, title: s.title ?? s.topic, description: s.description ?? '', titles: s.titles, keyword: s.keyword, hookImage: hook, signal: AbortSignal.timeout(240_000), ...(savedCopy?.line1 ? { copy: savedCopy } : {}) });
    if (!ok) return c.json({ error: '썸네일 생성 실패(무해 — 기존 유지)' }, 502);
    shortsStore().update(id, {}); // updatedTs 갱신 → 포스터 캐시버스트
    return c.json({ ok: true });
  } finally { thumbGenInFlight.delete(id); }
}
app.post('/shorts/:id/thumbnail/regenerate', shortsThumbnailRegenHandler);
app.post('/api/shorts/:id/thumbnail/regenerate', shortsThumbnailRegenHandler);
app.get('/shorts/:id/zip', shortsZipHandler);
app.get('/api/shorts/:id/zip', shortsZipHandler);
app.get('/shorts/:id', shortsGetHandler);
app.get('/api/shorts/:id', shortsGetHandler);
app.delete('/shorts/:id', shortsDeleteHandler);
app.delete('/api/shorts/:id', shortsDeleteHandler);
app.post('/pieces/:id/published', piecePublishedHandler);
app.post('/api/pieces/:id/published', piecePublishedHandler);
app.post('/pieces/:id/metrics', pieceMetricsPostHandler);
app.post('/api/pieces/:id/metrics', pieceMetricsPostHandler);
app.get('/pieces/:id/metrics', pieceMetricsGetHandler);
app.get('/api/pieces/:id/metrics', pieceMetricsGetHandler);
// piece 온디맨드 실행 — 자율 케이던스를 기다리지 않고 지금 초안 런을 띄운다(사용자 트리거 = user run).
// 완료 시 pieceId 로 advancePieceReady 가 'ready' 로 전진(자율 launch 와 동일 경로). 이미 초안이 있거나 실행 중이면 거절.
function pieceRunHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  const piece = pieceStore().get(id);
  if (!piece) return c.json({ error: 'unknown piece' }, 404);
  if (piece.runId && RUNS.get(piece.runId)?.status === 'running') return c.json({ error: '이미 실행 중입니다', run_id: piece.runId }, 409);
  if (['published', 'measured', 'reflected'].includes(piece.stage)) return c.json({ error: '이미 발행·측정 단계입니다' }, 409);
  if (piece.stage === 'ready') {
    // ready 지만 실제 본문(draft.json)이 없는 고아 조각(리서치·브리프 단계에서 끝난 런)은 본문 생성 재실행 허용.
    // 진짜 초안을 가진 ready 는 재실행 대신 검토·수정(revise) 경로를 쓰도록 거절.
    const hasDraft = !!piece.runId && fs.existsSync(path.join(CONFIG.sessionsDir, piece.runId, 'draft.json'));
    if (hasDraft) return c.json({ error: '이미 초안이 있습니다(검토·발행 단계)' }, 409);
  }
  const runId = launchRun(piece.title, { pieceId: piece.id, keyword: piece.keyword }); // user run(양보 대상 아님)
  if (!runId) return c.json({ error: '실행 시작 실패' }, 500);
  pieceStore().update(id, { runId, stage: 'draft' });
  return c.json({ ok: true, run_id: runId });
}
app.post('/pieces/:id/run', pieceRunHandler);
app.post('/api/pieces/:id/run', pieceRunHandler);
// 수정 요청(검토 탭) — ready 초안에 사용자 피드백을 걸어 리비전 런(기존 초안 개정)을 띄운다.
// stage 는 'ready' 유지(수정 실패 시 기존 초안 보존) — 완료되면 advancePieceReady 가 runId 를 새 런으로 교체.
async function pieceReviseHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const piece = pieceStore().get(id);
  if (!piece) return c.json({ error: 'unknown piece' }, 404);
  const b = await c.req.json<{ feedback?: string }>().catch(() => ({} as { feedback?: string }));
  const feedback = (b.feedback ?? '').trim();
  if (!feedback) return c.json({ error: '수정 요청 내용이 비었습니다.' }, 400);
  // published 허용(2026-08-12): 발행 후 소급 수정 경로 — 지침 개정(결론 의무 등)을 기발행분에 적용할 때 쓴다.
  // 리비전 완료 후 네이버 재발행은 자동이 아니라 수동 트리거(중복 초안 방지 가드가 그대로 살아 있음),
  // 기존 네이버 글 삭제는 사람이 판단한다.
  if (piece.stage !== 'ready' && piece.stage !== 'published') {
    return c.json({ error: '검토 대기(ready) 또는 발행됨(published) 초안만 수정 요청할 수 있습니다.' }, 409);
  }
  if ([...RUNS.values()].some((h) => h.status === 'running' && h.topic === piece.title)) {
    return c.json({ error: '이 초안의 런이 이미 실행 중입니다.' }, 409);
  }
  // 네이버 임시저장이 도는 중이면 개정 금지 — 저장 결과가 옛 내용과 뒤엉키는 것 방지(상호 가드).
  if (NAVER_DRAFT_JOBS.get(id)?.status === 'running') {
    return c.json({ error: '네이버 임시저장이 진행 중입니다 — 완료 후 수정 요청하세요.' }, 409);
  }
  let baseBody = '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, piece.runId ?? '', 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    baseBody = (d.bodyMarkdown ?? '').trim();
  } catch { /* 아래에서 거절 */ }
  if (!baseBody) return c.json({ error: '기존 초안 본문을 찾을 수 없습니다.' }, 404);
  const runId = launchRun(piece.title, { pieceId: piece.id, keyword: piece.keyword, revise: { baseBody, feedback: feedback.slice(0, 4000), baseRunId: piece.runId } });
  if (!runId) return c.json({ error: '실행 시작 실패' }, 500);
  return c.json({ ok: true, run_id: runId });
}
app.post('/pieces/:id/revise', pieceReviseHandler);
app.post('/api/pieces/:id/revise', pieceReviseHandler);

// 네이버 임시저장(검토 탭) — 완성 초안을 실제 네이버 SmartEditor 에 임시저장한다(발행 아님).
// Playwright 브라우저(기본 headful — 최초 로그인/캡차를 사람이 처리)가 최대 15분 걸릴 수 있어
// 백그라운드 잡으로 돌리고, 프론트는 GET 으로 폴링한다. 사용자 클릭이 곧 승인(신뢰 경로).
interface NaverDraftJob {
  status: 'running' | 'saved' | 'failed';
  startedTs: string; endedTs?: string;
  url?: string; adminUrl?: string; error?: string; dryRun: boolean;
  /** 자동 게이트가 기동한 잡의 담당자 표기(발행 담당) — 수동(검토 탭 버튼) 잡은 비움. */
  actor?: string;
}
const NAVER_DRAFT_JOBS = new Map<string, NaverDraftJob>();

// 네이버 Chrome 영속 프로필(~/.naver-blog-profiles/cli)은 1개뿐 — 동시에 두 브라우저(임시저장·성과수집·
// 일일동기화)를 열면 두 번째 launch_persistent_context 가 프로필 락으로 실패한다. 셋을 단일 뮤텍스로
// 직렬화한다. dry-run 은 브라우저를 열지 않으므로 점유 대상이 아니다.
let naverProfileBusy: string | null = null;

// 임시저장 잡 기동(공용) — 검토 탭 버튼(pieceNaverDraftHandler)과 자동 게이트(maybeAutoNaverDraft)가
// 같은 가드·프로필 뮤텍스를 공유한다. 잡 등록(set)까지 동기 — await 금지(TOCTOU 차단: 이중 기동 방지).
type NaverDraftStart = { ok: true } | { error: string; status: 400 | 404 | 409 };
/** 블로그 본문 확정 → 카드뉴스·숏폼 자동 파생(piece당 각 1회, AUTO_CARDNEWS / AUTO_SHORTS 로 켜고 끔).
 *  호출 지점: 네이버 임시저장 성공 훅 + 자동 임시저장 off 시 ready 확정(maybeAutoNaverDraft). 가드가 멱등을 보장. */
function autoDeriveSet(id: string, title: string): void {
  if (CONFIG.autoCardNews && !cardNewsStore().list().some((x) => x.sourcePieceId === id)) {
    const dc = deriveCardNewsFromPiece(id);
    console.log('error' in dc
      ? `[카드뉴스] 자동 파생 실패 — ${title.slice(0, 25)}: ${dc.error}`
      : `[카드뉴스] 자동 파생 시작 — ${title.slice(0, 30)} (${dc.card.id})`);
  }
  // error 레코드는 점유로 안 본다(2026-08-20 하드 캡 리뷰) — 길이 상한 등으로 실패한 파생이 그 글의
  // 쇼츠를 영구 결손시키지 않게. 단 같은 글 실패 2회부터는 재파생 중단(계속 실패하는 소재 폭주 방지).
  if (CONFIG.autoShorts && (() => {
    const mine = shortsStore().list().filter((x) => x.sourcePieceId === id);
    return !mine.some((x) => x.stage !== 'error') && mine.filter((x) => x.stage === 'error').length < 2;
  })()) {
    const ds = deriveShortsFromPiece(id);
    console.log('error' in ds
      ? `[숏폼] 자동 파생 실패 — ${title.slice(0, 25)}: ${ds.error}`
      : `[숏폼] 자동 파생 시작 — ${title.slice(0, 30)} (${ds.short.id})`);
  }
}

function startNaverDraftJob(id: string, opts: { dryRun?: boolean; actor?: string } = {}): NaverDraftStart {
  const dryRun = opts.dryRun === true;
  const piece = pieceStore().get(id);
  if (!piece) return { error: 'unknown piece', status: 404 };
  if (!piece.runId) return { error: '초안이 아직 없습니다.', status: 409 };
  if (NAVER_DRAFT_JOBS.get(id)?.status === 'running') return { error: '이미 네이버 임시저장이 진행 중입니다.', status: 409 };
  // 실런은 브라우저를 여니 프로필 뮤텍스 필요 — 수집·타 임시저장·일일동기화와 상호 배제.
  if (!dryRun && naverProfileBusy) {
    return { error: `네이버 브라우저 작업이 진행 중입니다(${naverProfileBusy}) — 완료 후 다시 시도하세요.`, status: 409 };
  }
  // 이 초안의 런(수정 요청 리비전 포함)이 실행 중이면 내용이 바뀌는 중 — 저장하지 않는다.
  if ([...RUNS.values()].some((h) => h.status === 'running' && h.topic === piece.title)) {
    return { error: '이 초안의 런이 실행 중입니다 — 완료 후 저장하세요.', status: 409 };
  }
  // 브랜드 없는(범용) piece 는 반드시 범용('') 계정으로 — piece.brand=undefined 를 그대로 넘기면
  // blog_skills 의 `?? activeBrandSlug()` 가 활성 브랜드로 해석해 범용 글을 활성 브랜드 블로그로
  // 오발행한다(격리 위반). undefined→'' 로 못박는다.
  const pubBrand = piece.brand ?? '';
  if (!dryRun && !naverPublishCreds(pubBrand).blogId) {
    const where = piece.brand ? `브랜드 '${piece.brand}' 의 ` : '';
    return { error: `${where}네이버 블로그 ID 미설정 — API 키 탭 "네이버 발행 계정"에서 ${piece.brand ? '이 브랜드의' : '범용'} 블로그 ID를 설정하세요.`, status: 400 };
  }
  const runIdAtStart = piece.runId;
  const sessionDir = path.join(CONFIG.sessionsDir, runIdAtStart);
  let draft: ReturnType<typeof coerceBlogDraft> = null;
  try { draft = coerceBlogDraft(JSON.parse(fs.readFileSync(path.join(sessionDir, 'draft.json'), 'utf-8'))); } catch { /* 아래에서 거절 */ }
  if (!draft) return { error: '초안(draft.json)을 읽을 수 없습니다.', status: 404 };

  const job: NaverDraftJob = { status: 'running', startedTs: new Date().toISOString(), dryRun, actor: opts.actor };
  NAVER_DRAFT_JOBS.set(id, job);
  if (!dryRun) naverProfileBusy = `임시저장:${piece.title.slice(0, 20)}`; // ── 동기 구간 끝(뮤텍스 획득)
  void publishDraftToNaver(sessionDir, draft, { dryRun, brand: pubBrand }).then((r) => {
    job.endedTs = new Date().toISOString();
    if (r.ok) {
      job.status = 'saved'; job.url = r.draftUrl; job.adminUrl = r.adminUrl;
      if (r.issues.length) job.error = r.issues.join(' · '); // PARTIAL — 저장은 됐지만 일부 문제(이미지 누락 등)
      // 잡 도는 사이 리비전으로 runId 가 바뀌었다면 이 결과는 옛 내용 — 현재 초안의 기록으로 남기지 않는다.
      if (!dryRun && pieceStore().get(id)?.runId === runIdAtStart) {
        // 비공개 발행(2026-08-28 수선) — 파이썬 기본 모드는 임시저장이 아니라 '비공개 발행'이라 진짜 글
        // 주소(logNo=…)가 나온다. 종전엔 publish_mode 를 안 읽어 그 URL 이 naverDraftUrl 로만 들어갔고,
        // publishedUrl 이 비어 파생물 캡션의 원본 블로그 링크가 끝내 안 붙었다(사용자 제보).
        // 임시저장 폴백일 때는 URL 이 postwrite 라 절대 publishedUrl 로 쓰지 않는다.
        const privateNow = r.privatePublished && r.draftUrl && /logNo=|\/\d{6,}/.test(r.draftUrl)
          ? r.draftUrl : undefined;
        pieceStore().update(id, {
          naverDraftUrl: r.draftUrl ?? r.adminUrl, naverDraftTs: job.endedTs,
          // privateUrl 로 넣는다(2026-08-29 수선) — publishedUrl 에 넣었더니 RSS 발행 감지가 이 조각을
          // '이미 처리됨'으로 보고 건너뛰어, 사람이 전체공개로 바꿔도 발행이 잡히지 않았다(실측 5건).
          // 공개 판정은 publishedUrl 한 곳만 한다.
          ...(privateNow ? { privateUrl: privateNow } : {}),
        });
        if (privateNow) console.log(`[네이버] 비공개 발행 — ${privateNow.slice(0, 80)}`);
        // 저장 성공 = 본문 확정 + 블로그 주소 확보 → 카드뉴스·숏폼 자동 파생(주제 하나 → 세트).
        // 2026-08-28 사용자 확정으로 이 훅이 파생의 **단일 경로**가 됐다 — 사람이 검토 탭·텔레그램
        // 버튼으로 저장한 글도 같은 훅을 타므로 전량 수동 검토 운영에서도 세트는 정상 생성된다.
        // autoDeriveSet 내부 가드가 중복 파생을 막는다(같은 piece 로 두 번 저장해도 no-op).
        autoDeriveSet(id, piece.title);
      }
    } else {
      job.status = 'failed';
      job.error = [...r.issues, r.output.slice(-400)].filter(Boolean).join(' · ') || '알 수 없는 실패';
    }
  }).catch((e: unknown) => {
    job.status = 'failed'; job.endedTs = new Date().toISOString();
    job.error = e instanceof Error ? e.message : String(e);
  }).finally(() => {
    if (!dryRun) naverProfileBusy = null; // 뮤텍스 해제
    // 자동(발행 담당) 잡 종료 알림 — 채널 설정 시에만. 수동 잡은 사용자가 화면에서 폴링하므로 제외.
    if (opts.actor && !dryRun && notifyConfigured()) {
      void notify({
        title: `📗 ${opts.actor} — 네이버 임시저장 ${job.status === 'saved' ? '완료' : '실패'} · ${piece.title.slice(0, 40)}`,
        body: job.url ?? job.adminUrl ?? job.error ?? '',
      });
    }
  });
  return { ok: true };
}

async function pieceNaverDraftHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  const b = await c.req.json<{ dry_run?: boolean; actor?: string }>().catch(() => ({} as { dry_run?: boolean; actor?: string }));
  const dryRun = b.dry_run === true;
  // actor 지정(텔레그램 봇 등 비-UI 트리거) — 설정 시 잡 완료 알림이 발송된다(자동 게이트와 동일 경로).
  const actor = typeof b.actor === 'string' && b.actor.trim() ? b.actor.trim().slice(0, 20) : undefined;
  const r = startNaverDraftJob(id, { dryRun, actor }); // 가드~잡 등록은 내부에서 동기 처리
  if ('error' in r) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, started: true, dry_run: dryRun });
}
function pieceNaverDraftStatusHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  const piece = pieceStore().get(id);
  if (!piece) return c.json({ error: 'unknown piece' }, 404);
  const job = NAVER_DRAFT_JOBS.get(id);
  // 잡 없음 = 진행 중 아님 — 'idle'. 과거 저장 이력(url)은 참고용으로만 싣는다(재시작으로 잡이
  // 유실된 폴링이 옛 'saved' 를 '방금 완료'로 오인하지 않도록 status 는 idle 고정).
  if (!job) return c.json({ status: 'idle', url: piece.naverDraftUrl, saved_ts: piece.naverDraftTs });
  return c.json({
    status: job.status, url: job.url ?? piece.naverDraftUrl, admin_url: job.adminUrl,
    error: job.error, dry_run: job.dryRun, started_ts: job.startedTs, ended_ts: job.endedTs,
    actor: job.actor,
  });
}

// ── ready 이후 자동 네이버 임시저장 게이트 — SEO 기준 통과 시 발행 담당 명의로 저장, 미달이면
//    자동 리비전 1회 후 재평가(리비전 완료 → advancePieceReady → 여기 재진입). 그래도 미달이거나
//    점수 미측정이면 수동 검토로 남긴다. 실제 '발행'은 여전히 사람 수동(설계 유지).
function publisherName(): string {
  // 발행 담당 실명 — 회사 로스터에서 직함 '발행'으로 해석(별도 people.yaml 키 불필요 — 중복 방지).
  // 로스터 name 은 실명(people.yaml)→직함 순 폴백이라 실명 미지정이어도 자연스러운 라벨이 나온다.
  try {
    const c = getCompany();
    const r = [c.ceo, ...(c.teams ?? []).flatMap((t) => [t.lead, ...t.members])].find((x) => /발행|publish/i.test(x.title));
    if (r?.name?.trim()) return r.name.trim();
  } catch { /* 기본값 */ }
  return '발행 담당';
}

/** draft.json 의 SEO 체크리스트 미달 항목 → 리비전 피드백 문자열(없으면 null). */
function seoReviseFeedback(runId: string, keyword?: string): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as {
      seo?: { checklist?: Array<{ label: string; ok: boolean; note?: string }> };
      bodyMarkdown?: string; titleCandidates?: string[];
    };
    // 키워드 밀도 항목 제외(Fix wave 2026-08-27 소견 6) — 권고 7 로 본문·리비전이 '정확 표기 최대 2회'로
    // 통일된 뒤로 이 항목은 리비전이 고칠 수 없는 산술이 됐다(kw 6자·본문 3,000자면 하한 0.5% 에 3회가
    // 필요). 고칠 수 없는 항목을 피드백에 실으면 리비전이 키워드를 다시 심어 정확 표기 규칙(사용자 확정
    // 자산)과 싸운다. 점수·체크리스트 자체(seo.ts)는 건드리지 않는다 — 화면 표시와 점수는 그대로다.
    const DENSITY_LABEL = '키워드 밀도 0.5~2.5%(과최적화 경계)';
    const fails = (d.seo?.checklist ?? []).filter((c) => !c.ok && c.label !== DENSITY_LABEL);
    // 어휘 린트(2026-08-08, 2차 방어) — 프롬프트 예방이 뚫린 함정어를 리비전에 동봉해 함께 교정.
    // 새 리비전 트리거는 만들지 않는다(비용 불변): SEO 미달로 리비전이 돌 때만 얹고, 아니면 로그만.
    const jargon = lintLexicon(`${d.bodyMarkdown ?? ''}\n${(d.titleCandidates ?? []).join('\n')}`, getBrand()?.avoidJargon);
    if (!fails.length) {
      if (jargon.length) console.log(`[어휘 린트] 함정어 잔존(리비전 미발동 — SEO 통과): ${jargon.map((j) => j.term).join(', ')} — ${runId}`);
      return null;
    }
    return [
      // 자연스러움 감사(2026-08-11): 리비전이 키워드를 재삽입하며 문장을 굳히는 부작용 차단 —
      // 미달 항목 교정 외의 키워드 밀도 보강·어미 획일화를 금지한다.
      'SEO 점검에서 아래 항목이 미달했다. 본문의 구조·어조·분량은 유지하면서 미달 항목만 보완하라. '
      + '키워드를 아래 요구 횟수 이상으로 재삽입하거나 밀도를 추가 보강하지 말고, 본문의 어미·문장 리듬 다양성(해요체 혼합·명사 종결)은 그대로 유지하라.',
      ...fails.map((c) => `- ${c.label}${c.note ? ` (현재: ${c.note})` : ''}`),
      // 검색어 규칙 통일(2026-08-27 권고 7) — 종전 "본문 전체에 2~4회"는 작가 지침(org.ts:123 키워드 계층
      // 분리: 첫 문단 1회·소제목 1곳)과 정면으로 어긋나, 리비전이 돌 때마다 본문에 정확 표기를 다시 심었다.
      ...(keyword ? [`핵심 키워드 "${keyword}" 를 첫 문단에 1회, 소제목 1곳까지만 정확히 이 표기로 — 그 밖에는 조사·어순을 바꾼 변형으로(네이버는 형태소 분석이라 손실 없음) 자연스럽게 포함하라.`] : []),
      ...(jargon.length ? [`아울러 다음 말은 일반 독자가 다른 뜻으로 읽거나 모르는 표현이니 풀어 써라: ${jargon.map((j) => `${j.term}→${j.use}`).join(', ')}`] : []),
    ].join('\n');
  } catch { return null; }
}

// 자동 임시저장 꺼짐 안내를 조각당 1회로 접는다 — maybeAutoNaverDraft 는 ready 전이·재개 스윕마다 불려서
// 그냥 두면 같은 조각의 같은 문장이 로그를 채운다(재시작하면 초기화 = 다시 1회, 무해).
const AUTO_DRAFT_OFF_LOGGED = new Set<string>();

// 반환: 자동 리비전 런을 띄웠는지 — 호출측(advancePieceReady)이 곧 대체될 초안의 '검토 대기' 알림을 유예하는 데 쓴다.
function maybeAutoNaverDraft(pieceId: string): boolean {
  const piece = pieceStore().get(pieceId);
  if (!piece) return false;
  const seo = piece.seoScore;
  // 결정은 순수 함수(planAutoNaverDraft)에만 — 여기는 효과만. 자동 임시저장이 꺼져 있어도
  // SEO 판단·자동 리비전은 예전 그대로 돌고, 임시저장 '호출'만 막힌다(2026-08-27 사용자 확정).
  const decision = planAutoNaverDraft(piece, { autoNaverDraft: CONFIG.autoNaverDraft, seoMin: CONFIG.naverDraftSeoMin });
  if (decision === 'skip') return false;
  if (decision === 'draft-off') {
    if (!AUTO_DRAFT_OFF_LOGGED.has(pieceId)) {
      AUTO_DRAFT_OFF_LOGGED.add(pieceId);
      console.log(`[발행담당] ${piece.title.slice(0, 30)} — 자동 임시저장 꺼짐 → 수동 검토 대기(텔레그램·검토 탭 버튼) · 카드뉴스·숏폼은 저장 뒤 파생`);
    }
    // 파생은 네이버 비공개 저장 뒤에만(2026-08-28 사용자 확정) — 저장 시점에 진짜 글 주소가 나와야
    // 파생물 캡션에 원본 링크가 붙는다. 여기서는 킬스위치 DERIVE_ON_READY=1 일 때만 발동한다.
    // (문구도 함께 고친다 — 옛 문구가 "지금 파생"이라 로그만 보면 새 동작과 정반대로 읽혔다.)
    if (shouldAutoDeriveOnDecision(decision, CONFIG.autoNaverDraft)) autoDeriveSet(pieceId, piece.title);
    return false;
  }
  if (decision === 'fact-hold') {
    const n = (piece.factGate?.unsupported.length ?? 0) + (piece.factGate?.contradicted.length ?? 0);
    console.log(`[발행담당] ${piece.title.slice(0, 30)} — 사실 게이트 ${piece.factGate?.status === 'error' ? '판정 실패' : `보류 ${n}건`} → 자동 임시저장 건너뜀(수동 검토)`);
    return false;
  }
  if (decision === 'draft') {
    const r = startNaverDraftJob(pieceId, { actor: publisherName() });
    console.log('error' in r
      ? `[발행담당] ${piece.title.slice(0, 30)} — 임시저장 기동 실패: ${r.error}`
      : `[발행담당] ${piece.title.slice(0, 30)} — SEO ${seo}점(기준 ${CONFIG.naverDraftSeoMin}) 통과 → 네이버 임시저장 시작`);
    return false;
  }
  if (decision === 'revise-exhausted') {
    console.log(`[발행담당] ${piece.title.slice(0, 30)} — SEO ${seo ?? '미측정'}점 < ${CONFIG.naverDraftSeoMin} · 자동 리비전 소진 → 수동 검토 대기`);
    // 파생은 기본적으로 네이버 비공개 저장 뒤에만(2026-08-28) — 저장 시점에 진짜 글 주소가 나와야
    // 파생물 캡션에 원본 링크가 붙는다. 여기서는 킬스위치 DERIVE_ON_READY=1 일 때만 발동한다.
    if (shouldAutoDeriveOnDecision(decision, CONFIG.autoNaverDraft)) autoDeriveSet(pieceId, piece.title);
    return false;
  }
  // decision === 'revise' — 여기부터는 효과 있는 게이트(진행 중 런·잡, 본문·체크리스트 유무)만 남는다.
  const runId = piece.runId;
  if (!runId) return false; // planAutoNaverDraft 가 보장하지만(runId 없으면 skip) 타입 좁히기용
  // 다른 런/잡이 도는 중이면 이번 틱은 건너뛴다(다음 ready 전이 때 재평가).
  if ([...RUNS.values()].some((h) => h.status === 'running' && h.topic === piece.title)) return false;
  if (NAVER_DRAFT_JOBS.get(pieceId)?.status === 'running') return false;
  let baseBody = '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
    baseBody = (d.bodyMarkdown ?? '').trim();
  } catch { /* 아래에서 중단 */ }
  const feedback = seoReviseFeedback(runId, piece.keyword);
  if (!baseBody || !feedback) return false; // 본문·체크리스트 없이는 리비전 품질을 보장할 수 없다 — 수동으로
  pieceStore().update(pieceId, { autoRevisions: (piece.autoRevisions ?? 0) + 1 });
  const rid = launchRun(piece.title, { pieceId, keyword: piece.keyword, revise: { baseBody, feedback: feedback.slice(0, 4000), baseRunId: runId } });
  console.log(rid
    ? `[발행담당] ${piece.title.slice(0, 30)} — SEO ${seo}점 미달 → 자동 리비전 런 ${rid}`
    : `[발행담당] ${piece.title.slice(0, 30)} — 리비전 런 기동 실패(다른 런 진행 중일 수 있음)`);
  return !!rid;
}
app.post('/pieces/:id/naver-draft', pieceNaverDraftHandler);
app.post('/api/pieces/:id/naver-draft', pieceNaverDraftHandler);
app.get('/pieces/:id/naver-draft', pieceNaverDraftStatusHandler);
app.get('/api/pieces/:id/naver-draft', pieceNaverDraftStatusHandler);

// 성과 자동 수집(검토 탭) — 발행된 글 URL 의 조회수·검색 유입 키워드를 네이버에서 수집→강화(멱등).
// 스크레이프가 수십 초~분 걸릴 수 있어 백그라운드 잡+폴링. 수집 실패는 fail-open(수동 입력으로 대체).
interface CollectJob {
  status: 'running' | 'done' | 'failed';
  startedTs: string; endedTs?: string;
  views?: number; dwellSec?: number; inflowCount?: number;
  reinforced?: boolean; note?: string; error?: string; dryRun: boolean;
}
const COLLECT_JOBS = new Map<string, CollectJob>();

/** piece → 성과 수집치(MetricSample) 또는 null(수집 실패·데이터 없음 = fail-open). */
async function measurePiece(piece: Piece, dryRun: boolean, signal?: AbortSignal): Promise<{ sample: MetricSample | null; note?: string }> {
  if (!piece.publishedUrl) return { sample: null, note: '발행 URL 없음' };
  const runDir = path.join(CONFIG.sessionsDir, piece.runId ?? piece.id, 'metrics');
  // 범용 piece(brand=undefined)는 범용('') 계정/프로필로 수집 — activeBrandSlug 폴백 방지(격리).
  const m = await collectNaverMetrics(piece.publishedUrl, runDir, { dryRun, brand: piece.brand ?? '' }, signal);
  if (!m) return { sample: null, note: '수집 결과 파싱 실패' };
  if (!m.views && m.searchInflow.length === 0) return { sample: null, note: m.note };
  // 공감 — 공개 like API(브라우저·로그인 무관, 1콜) 동봉. 실패는 무해(likes 미기록 — latestLikes 가 과거 값 유지).
  const likes = await fetchBlogSympathy(piece.publishedUrl, signal);
  const sample: MetricSample = {
    measuredAt: new Date().toISOString(),
    views: m.views,
    ...(m.dwellSec ? { dwellSec: m.dwellSec } : {}),
    ...(typeof likes === 'number' ? { likes } : {}),
    searchInflow: m.searchInflow,
    source: m.source,
  };
  return { sample, note: m.note };
}

async function pieceCollectHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const body = await c.req.json<{ dry_run?: boolean }>().catch(() => ({} as { dry_run?: boolean }));
  const dryRun = body.dry_run === true;
  // ── 여기부터 잡 등록까지 동기 — await 금지(동시 수집 이중 기동 방지, naver-draft 와 동일 방어).
  const piece = pieceStore().get(id);
  if (!piece) return c.json({ error: 'unknown piece' }, 404);
  if (!piece.publishedUrl) return c.json({ error: '발행 URL 이 없습니다 — 네이버에 발행 후 글 URL을 먼저 등록하세요.' }, 409);
  if (COLLECT_JOBS.get(id)?.status === 'running') return c.json({ error: '이미 성과 수집이 진행 중입니다.' }, 409);
  // 수집도 브라우저를 여니 프로필 뮤텍스 필요(dry-run 제외 — 브라우저 안 엶).
  if (!dryRun && naverProfileBusy) {
    return c.json({ error: `네이버 브라우저 작업이 진행 중입니다(${naverProfileBusy}) — 완료 후 다시 시도하세요.` }, 409);
  }
  const job: CollectJob = { status: 'running', startedTs: new Date().toISOString(), dryRun };
  COLLECT_JOBS.set(id, job);
  if (!dryRun) naverProfileBusy = `성과수집:${piece.title.slice(0, 20)}`; // ── 동기 구간 끝(뮤텍스 획득)
  void measurePiece(piece, dryRun).then(async ({ sample, note }) => {
    job.endedTs = new Date().toISOString();
    job.note = note;
    if (!sample) {
      job.status = 'failed';
      job.error = note || '자동 추출된 성과가 없습니다 — 수동 입력으로 대체하세요.';
      return;
    }
    // dry-run 은 실제 상태를 변이하지 않는다 — 샘플만 노출(강화·이력·전이 없음, naver-draft 와 동일 관례).
    if (dryRun) {
      job.status = 'done'; job.reinforced = false;
      job.views = sample.views; job.dwellSec = sample.dwellSec; job.inflowCount = sample.searchInflow.length;
      return;
    }
    const r = await ingestMetrics(id, sample);
    job.status = 'done';
    job.views = sample.views; job.dwellSec = sample.dwellSec;
    job.inflowCount = sample.searchInflow.length; job.reinforced = r.reinforced;
  }).catch((e: unknown) => {
    job.status = 'failed'; job.endedTs = new Date().toISOString();
    job.error = e instanceof Error ? e.message : String(e);
  }).finally(() => { if (!dryRun) naverProfileBusy = null; }); // 뮤텍스 해제
  return c.json({ ok: true, started: true, dry_run: dryRun });
}
function pieceCollectStatusHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!pieceStore().get(id)) return c.json({ error: 'unknown piece' }, 404);
  const job = COLLECT_JOBS.get(id);
  if (!job) return c.json({ status: 'idle' });
  return c.json({
    status: job.status, views: job.views, dwell_sec: job.dwellSec, inflow_count: job.inflowCount,
    reinforced: job.reinforced, note: job.note, error: job.error, dry_run: job.dryRun,
    started_ts: job.startedTs, ended_ts: job.endedTs,
  });
}
app.post('/pieces/:id/collect-metrics', pieceCollectHandler);
app.post('/api/pieces/:id/collect-metrics', pieceCollectHandler);
app.get('/pieces/:id/collect-metrics', pieceCollectStatusHandler);
app.get('/api/pieces/:id/collect-metrics', pieceCollectStatusHandler);

// 성과 집계 — 발행/측정된 piece 들의 최신 성과치 + 전략(강화 EWMA) 요약을 한 번에 반환(성과 대시보드용).
function performanceHandler(c: Context): Response {
  const rows = pieceStore().list()
    .filter(brandMatch)
    .filter((p) => !!p.publishedUrl || ['published', 'measured', 'reflected'].includes(p.stage))
    .map((p) => {
      // 최신 표본만 읽으면 유입·체류가 빈 새 표본(일일 추적)이 과거 값을 '—' 로 가린다(실측 2026-07-30)
      // — 유입은 전 이력 상위 집계, 체류는 최근 유효값, 조회는 누적치라 최신값 그대로.
      const all = readMetrics(p.id);
      const m = all.length ? all[all.length - 1]! : null;
      return {
        id: p.id, title: p.title, stage: p.stage, keyword: p.keyword, subNiche: p.subNiche,
        publishedUrl: p.publishedUrl, seoScore: p.seoScore,
        date: p.publishedTs ?? p.createdTs, // 발행일(없으면 작성일 폴백 — 레거시 piece)
        views: m ? m.views : null, dwellSec: latestDwell(all),
        likes: latestLikes(all), // 네이버 공감(2026-07-31) — 0 도 실값, 미기록만 null
        inflow: topInflow(all), measuredAt: m?.measuredAt ?? null,
        source: m?.source, samples: all.length,
        derived: derivedSummary(p.id), // 콘텐츠 세트 완성 여부(카드뉴스·숏폼)
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date)); // 발행일 내림차순(최신 먼저)
  const s = readStrategy(activeBrandSlug()); // 활성 브랜드의 강화 학습만 표시
  const measured = rows.filter((r) => r.views != null);
  // 채널 성과(쇼츠·카드뉴스) — 발행된 것만, 채널별 최신 샘플(한 시계열에 유튜브·메타가 섞여 소스로 분리).
  // stale = 미반영인데 수집 대상도 아님(비공개·삭제·포기 지평 경과) → 영구 정체라 '측정 중'과 구분해 표시.
  // 판정은 수집 틱과 같은 due 술어를 그대로 재사용 — 게이트가 바뀌어도 대시보드가 따라오도록(로직 이원화 금지).
  const perfNow = Date.now();
  const perfDays = CONFIG.shortsPerfDays;
  const shortsRows = shortsStore().list().filter(brandMatch)
    .filter((x) => !!x.youtubeTs || !!x.metaPublishedTs)
    .map((x) => {
      const yt = x.youtubeTs ? latestMetricsBySource(x.id, 'youtube:') : null;
      const ig = x.metaPublishedTs ? latestMetricsBySource(x.id, 'meta:ig') : null;
      const fbv = x.fbReelId ? latestMetricsBySource(x.id, 'meta:fb') : null;
      return {
        id: x.id, title: x.title || x.topic,
        // 업로드일은 채널별로 분리 — 유튜브 섹션은 youtubeTs, 릴스 섹션은 metaPublishedTs(양쪽 발행 시 상단 ts 는 최신값으로 정렬용).
        youtube: x.youtubeTs ? { url: x.youtubeUrl ?? null, views: yt?.views ?? null, likes: yt?.likes ?? null, reflected: !!x.perfReflected, stale: shortsPerfStale(x, perfNow, perfDays), series: viewsSeriesFor(x.id, 'youtube:'), ts: x.youtubeTs } : null,
        meta: x.metaPublishedTs ? { permalink: x.igPermalink ?? null, views: ig?.views ?? null, likes: ig?.likes ?? null, reflected: !!x.metaPerfReflected, stale: shortsMetaPerfStale(x, perfNow, perfDays), series: viewsSeriesFor(x.id, 'meta:ig'), ts: x.metaPublishedTs } : null,
        // 페북 릴스 — 게시된 조각만(fbReelId). 지표는 비디오 노드에서 수집한 meta:fb 표본.
        // 커버 미적용 여부(coverPending)도 함께 보내 성과 탭에서 바로 보이게 한다(발행 탭까지 가지 않아도 알게).
        fb: x.fbReelId ? {
          url: `https://www.facebook.com/reel/${x.fbReelId}`,
          views: fbv?.views ?? null, likes: fbv?.likes ?? null,
          series: metricSeriesFor(x.id, 'meta:fb', 'views'),
          ts: x.fbReelTs ?? null, // 페북 게시일(인스타와 다를 수 있음). 구 데이터는 null → '—'
          coverPending: !x.fbReelCoverTs,
        } : null,
        ts: [x.youtubeTs, x.metaPublishedTs].filter(Boolean).sort().pop()!,
      };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
  const cardRows = cardNewsStore().list().filter(brandMatch)
    .filter((x) => !!x.publishedTs)
    .map((x) => {
      const ig = latestMetricsBySource(x.id, 'meta:ig');
      const fb = latestMetricsBySource(x.id, 'meta:fb');
      return {
        id: x.id, topic: x.topic, ts: x.publishedTs!, reflected: !!x.perfReflected,
        stale: cardnewsPerfStale(x, perfNow, perfDays),
        ig: x.igMediaId ? { permalink: x.igPermalink ?? null, views: ig?.views ?? null, reach: ig?.reach ?? null, likes: ig?.likes ?? null, series: viewsSeriesFor(x.id, 'meta:ig'), ts: x.publishedTs! } : null,
        fb: x.fbPostId ? {
          url: `https://www.facebook.com/${x.fbPostId}`,
          likes: fb?.likes ?? null, shares: fb?.shares ?? null,
          series: metricSeriesFor(x.id, 'meta:fb', 'likes'), // FB 게시물은 조회 지표 미제공 → 좋아요 추이
          ts: x.fbPostTs ?? null,
        } : null,
      };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
  return c.json({
    refreshBusy: perfRefreshBusy, // 새로고침 백그라운드 수집 진행 여부 — 프론트 폴링 종료 판정
    strategy: {
      winners: s.winners.slice(0, 20), subNiches: s.subNiches, measuredPieces: s.measuredPieces,
      // 채널 학습(쇼츠·릴스·카드뉴스) — 키워드 점수표가 아니라 직원 강화가 남긴 교훈 문장(위키 performance
      // 페이지). 블로그 EWMA 와 나란히 보이게 노출(사용자 요청 2026-07-30).
      channelLessons: llmWiki().list('performance').slice(0, 30).map((p) => ({
        channel: p.title.startsWith('쇼츠') ? '유튜브 쇼츠' : p.title.startsWith('릴스') ? '인스타 릴스' : p.title.startsWith('카드뉴스') ? '카드뉴스' : '채널',
        summary: p.summary || p.title,
        updated: p.updated,
      })),
    },
    pieces: rows,
    summary: {
      count: rows.length,
      measured: measured.length,
      totalViews: measured.reduce((sum, r) => sum + (r.views ?? 0), 0),
      blogLikes: rows.reduce((sum, r) => sum + (r.likes ?? 0), 0), // 공감 합계 — 요약 카드용(2026-07-31)
    },
    channels: {
      shorts: shortsRows,
      cardnews: cardRows,
      summary: {
        shortsYtViews: shortsRows.reduce((n, r) => n + (r.youtube?.views ?? 0), 0),
        reelsViews: shortsRows.reduce((n, r) => n + (r.meta?.views ?? 0), 0),
        cardnewsViews: cardRows.reduce((n, r) => n + (r.ig?.views ?? 0), 0),
        // 채널별 좋아요 — 요약 카드가 조회(크게)+좋아요(작게)를 함께 보여준다(사용자 제안 2026-07-30).
        // 각 값은 해당 표의 좋아요 열 합과 1:1 로 일치.
        ytLikes: shortsRows.reduce((n, r) => n + (r.youtube?.likes ?? 0), 0),
        reelsLikes: shortsRows.reduce((n, r) => n + (r.meta?.likes ?? 0), 0),
        cardnewsLikes: cardRows.reduce((n, r) => n + (r.ig?.likes ?? 0), 0),
        // 페이스북 — 릴스만 조회 지표가 있다(사진 게시물은 조회·노출 미제공, 실측 확인).
        // 그래서 페북은 '조회'와 '좋아요'를 따로 보낸다: 좋아요를 조회 합계에 섞으면 단위가 다른 수를 더하게 된다.
        fbReelViews: shortsRows.reduce((n, r) => n + (r.fb?.views ?? 0), 0),
        // 좋아요는 표 그룹과 1:1 로 분리(쇼츠 릴스 / 카드뉴스 게시물) — 합쳐 놓으면 어느 표와도
        // 안 맞아 보인다(사용자 보고 2026-07-30: 카드 35 vs 카드뉴스 표 16).
        fbReelLikes: shortsRows.reduce((n, r) => n + (r.fb?.likes ?? 0), 0),
        fbPostLikes: cardRows.reduce((n, r) => n + (r.fb?.likes ?? 0), 0),
        // @deprecated 합산 별칭 — 구 프론트 번들(브라우저 캐시)이 0 을 표시하지 않게 유지. 새 UI 는 위 두 필드 사용.
        fbLikes: shortsRows.reduce((n, r) => n + (r.fb?.likes ?? 0), 0) + cardRows.reduce((n, r) => n + (r.fb?.likes ?? 0), 0),
      },
    },
  });
}
app.get('/performance', performanceHandler);
app.get('/api/performance', performanceHandler);
// 성과 즉시 재수집(대시보드 새로고침 버튼) — 쇼츠 유튜브·릴스·카드뉴스 메타는 순수 API. 네이버 블로그도
// 포함하되(RSS 발행 감지 → syncPerformance) headful 크롬을 쓰므로, syncPerformance 의 하루 1회 게이트
// (측정뿐 아니라 '시도'도 포함 — naverAttempts)·프로필 락이 같은 날 재기동을 막는다.
// 동시 트리거는 중복 샘플 append 를 만들므로 in-flight 가드.
let perfRefreshBusy = false;
/** 재수집 본체(백그라운드) — 네이버 일일 추적은 조각 수만큼 순차 브라우저 런이라 수 분 걸릴 수 있다.
 *  실측 2026-07-31: KST 날짜 전환 직후 새로고침 → 19조각 × ~14초 = 약 4분. 동기 응답이던 시절엔
 *  브라우저 fetch 가 타임아웃해 수집은 성공했는데 UI 는 에러로 보였다 → 즉시 응답+폴링으로 전환. */
async function runPerfRefresh(): Promise<void> {
  try {
    // 네이버 블로그: 발행 감지(공개 RSS — 프로필 락 무관) 후 성과 수집. syncPerformance 가 프로필 락·측정창·
    // 하루 1회(시도 포함) 게이트를 스스로 처리하므로, 수집 대상이 없거나 프로필 사용 중이면 조용히 건너뛴다
    // (일일 동기화와 동일 동작·안전). 쇼츠·릴스·카드뉴스는 순수 API 라 병행. allSettled — 한 채널 실패가 다른 채널을 막지 않음.
    // 전 채널 force — 새로고침은 측정창 지나 동결된 옛 콘텐츠 숫자도 갱신한다(네이버 편입 사용자 확정
    // 2026-07-31 — 헤드리스 전환으로 크롬 비용 해소). 네이버는 시도 게이트(하루 1회)가 그대로 상한.
    await Promise.allSettled([
      discoverPublishedNaver().then(() => syncPerformance({ force: true })),
      syncShortsPerformance({ force: true }),
      syncShortsMetaPerformance({ force: true }),
      syncCardnewsPerformance({ force: true }),
      // 이웃·구독자·팔로워 — 종전엔 07:30 일일 브리핑에서만 갱신돼, 새로고침을 눌러도 카드 숫자가
      // 그대로였다(실측 2026-08-02: 스냅샷이 07-31 에 멈춰 있었다). 순수 API 4콜·약 1초,
      // 브라우저도 게이트도 없으므로 일일 경로에만 둘 이유가 없다.
      recordFollowersSnapshot(),
    ]);
  } finally { perfRefreshBusy = false; }
}
function perfRefreshHandler(c: Context): Response {
  // 이미 진행 중이면 에러가 아니라 '진행 중' — 프론트는 같은 폴링 경로로 합류한다(종전 409 는 UI 에 에러로 떴음).
  if (perfRefreshBusy) return c.json({ ok: true, started: false, busy: true });
  perfRefreshBusy = true;
  void runPerfRefresh();
  return c.json({ ok: true, started: true });
}
app.post('/performance/refresh', perfRefreshHandler);
app.post('/api/performance/refresh', perfRefreshHandler);

// 실제 네이버 수집기 등록 — 일일 성과 동기화(syncPerformance)가 publishedUrl 있는 piece 를 자동 수집.
// measure 는 fail-open(미로그인·데이터 없음 → null) — 루프를 깨지 않는다. 수동 POST /metrics 는 계속 유효.
setCollector({
  name: 'naver_advisor',
  async measure(p) { return (await measurePiece(p, false)).sample; },
});

// ============================================================
// LLM 상태 — 프론트 계약(/llm) + 자체 UI(/api/llm)
// ============================================================
async function llmStatusPayload(): Promise<Record<string, unknown>> {
  // Claude 단일 백엔드(Ollama 제거 — 2026-07-06). 프론트 계약 키는 유지하되 로컬 필드는 빈 값.
  const assignment = resolveAssignment();
  return {
    setting: { backend: 'claude', local_model: '' },
    backends: [{ id: 'claude', label: 'Claude 클라우드', available: true }],
    cloud_tiers: { micro: assignment.micro, standard: assignment.standard, heavy: assignment.heavy },
    local_models: [],
    local_loaded: [],
  };
}
app.get('/llm', async (c) => c.json(await llmStatusPayload()));
// 설정 저장 — data/llm.json 에 영속하고, 이후 모든 런의 모델 배정(prepareRun→tierOverrides)에 반영.
app.post('/llm', async (c) => {
  const body = await c.req.json<{ backend?: string; local_model?: string }>().catch(() => ({}) as { backend?: string; local_model?: string });
  setLlmSetting({ backend: body.backend, localModel: body.local_model });
  return c.json(await llmStatusPayload());
});
app.get('/api/llm', async (c) => {
  return c.json({ backend: 'claude', version: 'claude', available: true, specs: 'Claude 클라우드', models: [], loaded: [], assignment: resolveAssignment() });
});
// 런타임 품질 설정(토론·추론) — UI 토글로 바꾸면 다음 런부터 즉시 반영(서버 재시작 불필요).
app.get('/runsettings', (c) => c.json(getRunSettings()));
app.post('/runsettings', async (c) => {
  const body = await c.req.json<{ orgDebateRounds?: number; agentThinking?: boolean }>().catch(() => ({}) as { orgDebateRounds?: number; agentThinking?: boolean });
  return c.json(setRunSettings({ orgDebateRounds: body.orgDebateRounds, agentThinking: body.agentThinking }));
});
app.get('/api/runsettings', (c) => c.json(getRunSettings()));
app.post('/api/runsettings', async (c) => {
  const body = await c.req.json<{ orgDebateRounds?: number; agentThinking?: boolean }>().catch(() => ({}) as { orgDebateRounds?: number; agentThinking?: boolean });
  return c.json(setRunSettings({ orgDebateRounds: body.orgDebateRounds, agentThinking: body.agentThinking }));
});

app.get('/api/health', (c) => c.json({ ok: true, backend: 'claude' }));
app.get('/healthz', (c) => c.json({ ok: true }));

// 오토런 온/오프(사용자 토글 — 대시보드 '자율' 칩 클릭). body.enabled 생략 시 반전. 재시작에도 유지.
app.post('/autonomy/toggle', async (c) => {
  const b = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));
  const next = typeof b.enabled === 'boolean' ? b.enabled : !autoRunEnabled();
  setAutoRunEnabled(next);
  console.log(`[auto-cycle] 오토런 ${next ? '켜짐' : '꺼짐'} (사용자 토글)`);
  return c.json({ ok: true, run_enabled: next });
});

// 자율 사이클 상태 — 프론트 대시보드의 '🤖 자율' 칩용. enabled 면 주기, active 면 자율 런 진행 중.
app.get('/autonomy/status', (c) => {
  // 진행 중인 자율런 — 프론트가 유휴 시 자동 관전(watchLive)할 수 있게 run_id 를 노출한다.
  const activeAuto = [...RUNS.entries()].find(([, h]) => h.auto && h.status === 'running');
  return c.json({
    enabled: CONFIG.autoCycleMinutes > 0,
    run_enabled: autoRunEnabled(), // 사용자 토글(칩 클릭) — enabled(주기 설정 존재)와 별개
    interval_minutes: CONFIG.autoCycleMinutes,
    shell: CONFIG.agentShell,
    active: !!activeAuto,
    auto_run_id: activeAuto ? activeAuto[0] : null,
    last_auto_ts: lastAutoRun?.ts ?? null,
    last_auto_topic: lastAutoRun?.topic ?? null,
  });
});

// 일일 브리핑 — 미리보기(GET) + 수동 발송(POST). 설정 시각엔 자동 발송(startDaily).
app.get('/briefing', (c) => c.json({ ...buildBriefing(), configured: notifyConfigured(), time: CONFIG.dailyBriefingTime }));
// 네이버 색인 점검(온디맨드) — 라이브 검색 후 캐시 갱신. 없음(발행 오래된 글)=저품질 강한 음성, 있음=약한 양성.
app.get('/naver/indexing', async (c) => {
  const report = await refreshNaverIndexingCache().catch(() => null);
  if (!report) return c.json({ enabled: false, note: 'NAVER_CLIENT_ID/SECRET 미설정 — 검색 API 자격증명 필요' });
  return c.json({ enabled: true, ...report, graceDays: 7 });
});
app.post('/briefing/send', async (c) => {
  await recordFollowersSnapshot().catch(() => { /* 무해 — 섹션 생략/이전 값 */ });
  const sent = await notify(buildBriefing());
  return c.json({ sent, configured: notifyConfigured() });
});
// 팔로워 현황 — 스냅샷 이력 조회(+?refresh=1 이면 즉시 재수집). 채널 미연결은 null.
const followersHandler = async (c: Context): Promise<Response> => {
  if (c.req.query('refresh') === '1') await recordFollowersSnapshot().catch(() => { /* 무해 */ });
  const snapshots = readSnapshots(activeBrandSlug() || '');
  return c.json({ snapshots, latest: snapshots[snapshots.length - 1] ?? null, goal: 1000 });
};
app.get('/followers', followersHandler);
app.get('/api/followers', followersHandler);
// 제목 유형·발행 시각 A/B 리포트(후속 카드 2026-08-12) — 읽기 전용 집계, 브리핑 섹션의 풀버전.
const titleTimingHandler = (c: Context): Response => c.json(buildTitleTimingReport(activeBrandSlug() || ''));
app.get('/analytics/title-timing', titleTimingHandler);
app.get('/api/analytics/title-timing', titleTimingHandler);
// 예고 대장 — 콘텐츠가 한 "다음 편" 약속 조회·수동 등록·폐기. 자율 틱이 시기 도래분을 신규 아이디어보다 먼저 이행.
const promisesListHandler = (c: Context): Response => {
  const brand = activeBrandSlug() || '';
  const all = promiseStore().list().filter((p) => (p.brand ?? '') === brand);
  return c.json({
    pending: promiseStore().pending(brand),
    fulfilled: all.filter((p) => p.status === 'fulfilled'),
    droppedCount: all.filter((p) => p.status === 'dropped').length,
  });
};
app.get('/promises', promisesListHandler);
app.get('/api/promises', promisesListHandler);
const promiseCreateHandler = async (c: Context): Promise<Response> => {
  const b = await c.req.json<{ topic?: string; window?: string; sourceTopic?: string }>().catch(() => ({} as { topic?: string; window?: string; sourceTopic?: string }));
  const topic = (b.topic ?? '').trim();
  if (!topic) return c.json({ error: '주제(topic)가 비었습니다.' }, 400);
  const p = promiseStore().create({ topic, window: b.window, sourceKind: 'manual', sourceTopic: b.sourceTopic });
  if (!p) return c.json({ error: '등록 불가 — 미이행 약속 백로그가 가득이거나 주제가 비었습니다.' }, 409);
  // 시기 해석 실패는 명시적으로 알린다 — dueMonth null 은 자동 이행 대상이 아니라 브리핑 노출·수동 처리 전용.
  return c.json({ promise: p, note: p.dueMonth === null ? '시기(window)를 해석하지 못했습니다 — "N월" 형식이 아니면 자동 이행되지 않습니다(수동 처리 전용).' : undefined });
};
app.post('/promises', promiseCreateHandler);
app.post('/api/promises', promiseCreateHandler);
const promiseDropHandler = (c: Context): Response => {
  const id = c.req.param('id') ?? '';
  const cur = promiseStore().get(id);
  // 브랜드 스코프 — 목록과 동일 기준(활성 브랜드의 약속만 폐기 가능).
  if (!cur || (cur.brand ?? '') !== (activeBrandSlug() || '')) return c.json({ error: 'unknown promise' }, 404);
  return c.json({ promise: promiseStore().update(id, { status: 'dropped' }) });
};
app.post('/promises/:id/drop', promiseDropHandler);
app.post('/api/promises/:id/drop', promiseDropHandler);

// ============================================================
// 회사 — 프론트 계약(/company, teams 구조) + 자체 UI(/api/company)
// ============================================================
function roleInfo(r: RoleDef, level: string, team: string | null) {
  return {
    id: r.id, title: r.title, name: r.name,
    level: r.level ?? level, team: r.team ?? team,
    tools: r.tools, skills: [], model: r.tier, stance: r.stance,
    // 직원 탭 리스트 카드의 자율도 — 상세 패널(agentDetail)과 동일하게 '실효 자율도'를 쓴다.
    // (자율도 편집은 PATCH /agents/:id → writeCapabilities 로 워크스페이스 캡에 저장되므로,
    //  raw company.yaml 값을 보여주면 편집이 카드에 반영되지 않는다 — 비서 '자동' 설정이
    //  '초안(승인)'으로 보이던 버그.)
    is_critic: r.isCritic, autonomy: effectiveAutonomy(r),
  };
}
// 브랜드(고객사) 프로필 — 이 스튜디오가 '누구를 위해' 만드는지. 저장 즉시 다음 런부터 전 파이프라인 주입.
app.get('/brands', (c) => c.json({ active: activeBrandSlug() || null, brands: listBrands() }));
app.post('/brands/activate', async (c) => {
  const body = await c.req.json().catch(() => ({} as { slug?: string | null }));
  try {
    const b = activateBrand(body.slug ?? null);
    console.log(`[브랜드] 전환 — ${b ? b.name : '범용 모드'}`);
    return c.json({ active: activeBrandSlug() || null, brand: b });
  } catch { return c.json({ error: '해당 브랜드를 찾을 수 없습니다' }, 404); }
});
/**
 * 브랜드 자료 일괄 정리 — 영구 삭제가 아니라 data/.trash/brand-<slug>-<ts>/ 로 이동(복구 가능).
 * 대상: 글(piece)+런 세션+성과 측정 이력, 카드뉴스·숏폼 산출물, 브랜드 태그 런, 위키·전략·제작 이력.
 */
function purgeBrandData(slug: string): { pieces: number; cards: number; shorts: number; runs: number; keys: number; accounts: number; agents: number } {
  const trash = path.join(CONFIG.dataDir, '.trash', `brand-${slug}-${Date.now()}`);
  const move = (src: string, sub: string): void => {
    try {
      if (!fs.existsSync(src)) return;
      const dst = path.join(trash, sub);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } catch { /* 이동 실패 무해 — 잔여 파일은 수동 정리 */ }
  };
  const pieces = pieceStore().list().filter((x) => (x.brand ?? '') === slug);
  for (const x of pieces) {
    if (x.runId) move(path.join(CONFIG.sessionsDir, x.runId), path.join('sessions', x.runId));
    // id 가 이미 'piece_' 접두를 포함(genId) — 종전 `piece_${x.id}` 는 이중 접두라 이동이 항상 no-op 이던 버그.
    move(path.join(CONFIG.dataDir, 'analytics', 'metrics', `${x.id}.jsonl`), path.join('metrics', `${x.id}.jsonl`));
    pieceStore().remove(x.id);
  }
  const cards = cardNewsStore().list().filter((x) => (x.brand ?? '') === slug);
  for (const x of cards) {
    move(path.join(CONFIG.dataDir, 'cardnews', x.id), path.join('cardnews', x.id));
    move(path.join(CONFIG.dataDir, 'analytics', 'metrics', `${x.id}.jsonl`), path.join('metrics', `${x.id}.jsonl`)); // 성과 시계열 동반
    cardNewsStore().remove(x.id);
  }
  const sh = shortsStore().list().filter((x) => (x.brand ?? '') === slug);
  for (const x of sh) {
    move(path.join(CONFIG.dataDir, 'shorts', x.id), path.join('shorts', x.id));
    move(path.join(CONFIG.dataDir, 'analytics', 'metrics', `${x.id}.jsonl`), path.join('metrics', `${x.id}.jsonl`)); // 성과 시계열 동반
    shortsStore().remove(x.id);
  }
  const runs = listPersistedRuns().filter((r) => (r.brand ?? '') === slug);
  for (const r of runs) { move(path.join(CONFIG.sessionsDir, r.run_id), path.join('sessions', r.run_id)); RUNS.delete(r.run_id); }
  for (const [rid, h] of [...RUNS]) if ((h.brand ?? '') === slug && h.status !== 'running') RUNS.delete(rid);
  move(path.join(path.dirname(CONFIG.wikiDir), `${path.basename(CONFIG.wikiDir)}-${slug}`), 'wiki');
  // 브랜드 스코프 신설 저장소도 동반 정리 — raw 원문(고객사 업로드 원본: 잔존 시 기밀 유출·slug 재사용 승계)
  // 과 리서치 주기 상태(잔존 시 새 브랜드가 죽은 브랜드의 게이트·중복회피 이력을 승계).
  move(path.join(path.dirname(CONFIG.wikiDir), `raw-${slug}`), 'raw');
  move(path.join(CONFIG.dataDir, '_shared', `research-state-${slug}.json`), `research-state-${slug}.json`);
  move(path.join(CONFIG.dataDir, 'analytics', `strategy-${slug}.json`), `strategy-${slug}.json`);
  // 수요 기각 원장(2026-08-27 신설)도 동반 정리 — 후보를 실제로 '기각'까지 시키는 브랜드 스코프 게이트라
  // 잔존 시 죽은 브랜드의 실측 기각이 동명 재생성 브랜드의 하드 게이트로 30일 작동하고, 제안 금지 블록으로
  // 두뇌 프롬프트에도 주입된다. 옆의 수요 스냅샷(demand-)은 정보 표일 뿐이지만 같은 브랜드 자료라 함께 옮긴다.
  move(path.join(CONFIG.dataDir, 'analytics', `demand-rejects-${slug}.json`), `demand-rejects-${slug}.json`);
  move(path.join(CONFIG.dataDir, 'analytics', `demand-${slug}.json`), `demand-${slug}.json`);
  move(path.join(CONFIG.dataDir, '_shared', `decisions-${slug}.md`), `decisions-${slug}.md`);
  // 리서치 판정·트렌드 스냅샷(2026-08-20 신설)도 동반 정리 — 잔존 시 새 브랜드가 죽은 브랜드의 폐기 게이트·연관어를 승계.
  move(path.join(CONFIG.dataDir, 'topics', `verdicts-${slug}.json`), `verdicts-${slug}.json`);
  move(path.join(CONFIG.dataDir, 'topics', `trend-snap-${slug}.json`), `trend-snap-${slug}.json`);
  // 브랜드 스코프 커스텀 API 키도 동반 제거 — 잔존 시 카드 도달 불가·동명 재추가 영구 거부·값 전역 주입.
  const keys = purgeCustomKeysForBrand(slug);
  // 채널 계정 blob(네이버 로그인·유튜브 토큰·메타 토큰)도 동반 제거 — 잔존 시 기밀 잔존+동명 재생성 브랜드가 옛 계정 승계.
  const accounts = purgeBrandAccounts(slug);
  // 직원 워크스페이스의 브랜드 스코프 파일도 동반 정리 — data/agents/*/ 의 `-<slug>.md`(goal·verified·
  // memory·injected 등)와 skills-<slug>/ 디렉토리. 잔존 시 동명 재생성 브랜드가 옛 직원 지식·패턴을 승계.
  let agents = 0;
  try {
    for (const e of fs.readdirSync(CONFIG.agentsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const adir = path.join(CONFIG.agentsDir, e.name);
      for (const f of fs.readdirSync(adir)) {
        if (!f.endsWith(`-${slug}.md`) && f !== `skills-${slug}`) continue;
        move(path.join(adir, f), path.join('agents', e.name, f));
        agents++;
      }
    }
  } catch { /* agents 디렉토리 없음 무해 */ }
  return { pieces: pieces.length, cards: cards.length, shorts: sh.length, runs: runs.length, keys, accounts, agents };
}

app.delete('/brands/:slug', (c) => {
  const slug = c.req.param('slug') ?? '';
  if (!isSafeBrandSlug(slug)) return c.json({ error: '무효한 슬러그' }, 400);
  // 실행 중인 런·잡이 있는 브랜드는 삭제 거절 — 진행 중 산출물 디렉토리 이동으로 인한 잡 파손 방지.
  const busy = [...RUNS.values()].some((h) => h.status === 'running' && (h.brand ?? '') === slug)
    || cardNewsStore().list().some((x) => (x.brand ?? '') === slug && isCardNewsRunning(x.id))
    || shortsStore().list().some((x) => (x.brand ?? '') === slug && isShortsRunning(x.id));
  if (busy) return c.json({ error: '이 브랜드의 작업이 실행 중입니다 — 완료/취소 후 삭제하세요' }, 409);
  try {
    if (!deleteBrand(slug)) return c.json({ error: '해당 브랜드가 없습니다' }, 404);
    const purged = purgeBrandData(slug);
    console.log(`[브랜드] 삭제 — ${slug}: 글 ${purged.pieces}·카드뉴스 ${purged.cards}·숏폼 ${purged.shorts}·런 ${purged.runs}·키 ${purged.keys}·계정 ${purged.accounts}·직원파일 ${purged.agents} → data/.trash 이동 (활성: ${activeBrandSlug() || '범용 모드'})`);
    return c.json({ ok: true, active: activeBrandSlug() || null, purged });
  } catch { return c.json({ error: '무효한 슬러그' }, 400); }
});
app.get('/brand', (c) => c.json({ brand: getBrand() }));
app.put('/brand', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<BrandProfile> | null;
  // cardStyle 은 프로필 편집 폼 밖(검토탭·제작실)에서 관리 — body 에 없으면 기존값 보존(소실 방지).
  if (body && body.cardStyle === undefined) {
    const cur = getBrand();
    if (cur?.cardStyle) body.cardStyle = cur.cardStyle;
  }
  const b = normalizeBrand(body);
  if (!b) return c.json({ error: '업체명(name)은 필수입니다' }, 400);
  saveBrand(b);
  console.log(`[브랜드] 프로필 저장 — ${b.name} (제품 ${b.products.length}종)`);
  return c.json({ brand: getBrand() });
});
// 카드뉴스 기본 스타일(브랜드 고정) — 검토탭·제작실 드롭다운이 저장. 'auto'/'' = 고정 해제(디자이너 자동).
app.post('/brand/cardstyle', async (c) => {
  const b = await c.req.json().catch(() => ({}) as { style?: string }) as { style?: string };
  const cur = getBrand();
  if (!cur) return c.json({ error: '브랜드 프로필이 없습니다 — 브랜드 탭에서 먼저 설정하세요' }, 409);
  const raw = String(b.style ?? '').trim();
  const resolved = resolveForcedPreset(raw); // 유효 프리셋 키/별칭 → 키, auto·불명 → undefined(해제)
  if (raw && raw !== 'auto' && !resolved) return c.json({ error: `알 수 없는 스타일: ${raw.slice(0, 30)}` }, 400);
  saveBrand({ ...cur, cardStyle: resolved });
  console.log(`[브랜드] 카드뉴스 기본 스타일 — ${cur.name}: ${resolved ?? '자동(해제)'}`);
  return c.json({ ok: true, cardStyle: resolved ?? null });
});

// 블로그 작가 말투(페르소나) 목록 — 컴포저 드롭다운용(id/label/desc). 프롬프트 본문은 서버 전용(SSOT).
const personasHandler = (c: Context): Response => c.json({ personas: listPersonas() });
app.get('/personas', personasHandler);
app.get('/api/personas', personasHandler);

app.get('/company', (c) => {
  const co = getCompany();
  return c.json({
    name: co.name,
    ceo: roleInfo(co.ceo, 'exec', null),
    teams: (co.teams ?? []).map((t) => ({
      id: t.id, name: t.name,
      lead: roleInfo(t.lead, 'lead', t.id),
      members: t.members.map((m) => roleInfo(m, 'member', t.id)),
    })),
  });
});
app.get('/api/company', (c) => c.json(getCompany()));

// --- 직원 워크스페이스 + 회사 편집 (EmployeesView) ---
app.get('/agents/:id', (c) => {
  const role = rolesById(getCompany()).get(c.req.param('id') ?? '');
  if (!role) return c.json({ error: 'unknown agent' }, 404);
  return c.json(agentDetail(role));
});
app.patch('/agents/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!rolesById(getCompany()).has(id)) return c.json({ error: 'unknown agent' }, 404);
  const b = await c.req.json<{ goal?: string; tools?: string[]; autonomy?: number }>().catch(() => ({}) as { goal?: string; tools?: string[]; autonomy?: number });
  if (b.goal !== undefined) writeGoal(id, b.goal);
  if (b.tools !== undefined || b.autonomy !== undefined) writeCapabilities(id, { tools: b.tools, autonomy: b.autonomy });
  appendActivity(id, '프로필 편집(목표/툴/자율도)');
  return c.json({ ok: true });
});
app.post('/agents/:id/skills', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!rolesById(getCompany()).has(id)) return c.json({ error: 'unknown agent' }, 404);
  const b = await c.req.json<{ name?: string; content?: string }>().catch(() => ({}) as { name?: string; content?: string });
  return addSkill(id, b.name ?? '', b.content ?? '') ? c.json({ ok: true }) : c.json({ error: 'skill 추가 실패' }, 400);
});
app.delete('/agents/:id/skills/:skill', (c) =>
  deleteSkill(c.req.param('id') ?? '', c.req.param('skill') ?? '') ? c.json({ ok: true }) : c.json({ error: 'skill 삭제 실패' }, 400));

// 지식 주입 — 업로드 파일(들)을 추출해 선택한 에이전트(들)의 injected.md 에 '우선 신뢰 지식'으로 누적.
// (/sources 와 동일한 추출·가드 재사용. agent_ids 는 반복 필드 또는 콤마 문자열 모두 허용, roster+safeId 검증.)
async function injectKnowledgeHandler(c: Context): Promise<Response> {
  const body = await c.req.parseBody({ all: true });
  const rawFiles = body['files'];
  const files = (Array.isArray(rawFiles) ? rawFiles : [rawFiles]).filter((x): x is File => x instanceof File);
  const rawIds = body['agent_ids'];
  const idParts = (Array.isArray(rawIds) ? rawIds : [rawIds])
    .flatMap((v) => String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  const roster = rolesById(getCompany());
  const agentIds = [...new Set(idParts)].filter((id) => roster.has(id)); // 실재 멤버만(경로 traversal·유령 id 차단)
  if (!agentIds.length) return c.json({ error: '대상 에이전트를 하나 이상 선택하세요' }, 400);
  if (!files.length) return c.json({ error: '파일이 필요합니다' }, 400);

  const docs: Array<{ name: string; text: string }> = [];
  const fileResults: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const name = f.name || 'upload';
    if (!isSupportedExt(name)) { fileResults.push({ file: name, status: 'unsupported', note: 'PDF/DOCX/HWPX/XLSX/PPTX/텍스트만 지원' }); continue; }
    if (f.size > 25_000_000) { fileResults.push({ file: name, status: 'too-large' }); continue; }
    try {
      const text = (await extractText(name, Buffer.from(await f.arrayBuffer()))).trim();
      if (!text) { fileResults.push({ file: name, status: 'failed', note: '추출된 텍스트 없음' }); continue; }
      docs.push({ name, text });
      fileResults.push({ file: name, status: 'ok', chars: text.length });
    } catch (e) { fileResults.push({ file: name, status: 'error', note: e instanceof Error ? e.message : String(e) }); }
  }
  if (!docs.length) return c.json({ error: '주입할 텍스트를 추출하지 못했습니다', files: fileResults }, 400);

  const agents: Array<Record<string, unknown>> = [];
  for (const id of agentIds) {
    ensureScaffold(id);
    for (const d of docs) appendInjected(id, d.text, d.name);
    const total = injectedLength(id);
    appendActivity(id, `📥 지식 주입: ${docs.map((d) => d.name).join(', ')}`);
    agents.push({ agent: id, name: roster.get(id)?.name ?? id, totalChars: total, overCap: total > INJECTED_CAP });
  }
  const over = agents.some((a) => a.overCap);
  return c.json({
    ok: true, files: fileResults, agents,
    warning: over ? `일부 에이전트의 주입 총량이 반영 한도(${INJECTED_CAP}자)를 넘어, 최신 주입 우선으로 잘려 일부는 프롬프트에 안 들어갑니다. '비우기'로 정리하거나 대용량은 자료실(위키 업로드)을 쓰세요.` : null,
  });
}
app.post('/agents/knowledge', injectKnowledgeHandler);
app.post('/api/agents/knowledge', injectKnowledgeHandler);
function clearKnowledgeHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  if (!rolesById(getCompany()).has(id)) return c.json({ error: 'unknown agent' }, 404);
  clearInjected(id);
  appendActivity(id, '🧹 주입 지식 비움');
  return c.json({ ok: true });
}
app.delete('/agents/:id/knowledge', clearKnowledgeHandler);
app.delete('/api/agents/:id/knowledge', clearKnowledgeHandler);

// 회사(역할/팀) 편집 — 성공 시 reloadCompany 로 /company 즉시 반영.
function companyEdit(c: Context, r: { ok: boolean; error?: string; [k: string]: unknown }): Response {
  if (r.ok) reloadCompany();
  return c.json(r, r.ok ? 200 : 400);
}
app.patch('/company/roles/:id', async (c) => {
  const b = await c.req.json<RolePatch>().catch(() => ({}) as RolePatch);
  return companyEdit(c, editRole(c.req.param('id') ?? '', b));
});
app.delete('/company/roles/:id', (c) => companyEdit(c, deleteRole(c.req.param('id') ?? '')));
app.post('/company/teams', async (c) => {
  const b = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  return companyEdit(c, addTeam(b.name ?? '새 팀'));
});
app.patch('/company/teams/:id', async (c) => {
  const b = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  return companyEdit(c, renameTeam(c.req.param('id') ?? '', b.name ?? ''));
});
app.delete('/company/teams/:id', (c) => companyEdit(c, deleteTeam(c.req.param('id') ?? '')));
app.post('/company/teams/:id/members', async (c) => {
  const b = await c.req.json<MemberBody>().catch(() => ({ title: '' }) as MemberBody);
  return companyEdit(c, addMember(c.req.param('id') ?? '', b));
});

// ============================================================
// 위키 지식그래프 (프론트 계약)
// ============================================================
app.get('/wiki/graph', (c) => c.json(llmWiki().graph()));
app.get('/wiki/stats', (c) => { const s = llmWiki().stats(); return c.json({ pages: s.pages, sources: s.sources, lessons: s.lessons }); });
// 외부 지식 주입(Connect AI /api/brain-inject 벤치마킹) — {title, markdown} 를 위키 source 로 저장+ingest.
/** 상수시간 토큰 비교 — 타이밍 공격 방지. 길이 불일치도 안전 처리(timingSafeEqual 은 동일 길이만 허용). */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// 인증 필수: 시크릿 INJECT_TOKEN(또는 env)과 **Bearer 헤더만** 일치해야 함(Connect 의 무인증 취약점 보완).
// 쿼리 토큰(?token=)은 URL·로그·referrer 로 유출되므로 폐기. 비교는 상수시간(safeEqual).
app.post('/wiki/inject', async (c) => {
  const expected = getSecret('INJECT_TOKEN') || process.env.INJECT_TOKEN || '';
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!expected || !safeEqual(token, expected)) return c.json({ error: '인증 실패 — 시크릿 INJECT_TOKEN 을 설정하고 Bearer 토큰을 일치시키세요' }, 401);
  const body = await c.req.json<{ title?: string; markdown?: string; content?: string }>().catch(() => ({}) as { title?: string; markdown?: string; content?: string });
  const title = (body.title ?? '').trim();
  const content = (body.markdown ?? body.content ?? '').trim();
  if (!title || !content) return c.json({ error: 'title 과 markdown(또는 content) 이 필요합니다' }, 400);
  const w = llmWiki();
  const rawRef = w.saveRaw(title, content);
  const page = w.upsertPage({ title, type: 'source', body: content, sources: [rawRef] });
  w.appendLog('inject', title);
  const imodel = await ingestModel();
  setIngestStatus(page.slug, { state: 'pending', entities: [] });
  void w.ingest({ title, content, model: imodel, sources: [rawRef], skipSummary: true })
    .then((r) => setIngestStatus(page.slug, { state: 'done', entities: r.pages }))
    .catch(() => setIngestStatus(page.slug, { state: 'failed', entities: [] }));
  return c.json({ ok: true, slug: page.slug });
});
// Karpathy lint 워크플로우 — 고아·끊긴링크(지식 갭) 점검
app.get('/wiki/lint', (c) => c.json(llmWiki().lint()));
// 자가수선 — lint 가 찾은 지식 갭을 LLM 으로 보충(?n=개수, 기본 6)
// 정수 쿼리 파싱 — 0/음수/비숫자를 일관 처리(`|| 6` falsy 버그 회피).
function parseN(c: Context, def = 6): number {
  const raw = Number(c.req.query('n'));
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : def;
}
app.post('/wiki/maintain', async (c) => {
  const micro = resolveAssignment().micro;
  const r = await llmWiki().maintain(micro, { maxFill: parseN(c), signal: c.req.raw.signal });
  return c.json(r);
});
// 모순 감사 — 토픽 겹치는 페이지 쌍을 LLM 비교(?n=쌍수, ?resolve=1 이면 해소 노트 기록)
app.post('/wiki/audit', async (c) => {
  const micro = resolveAssignment().micro;
  const r = await llmWiki().findContradictions(micro, { maxChecks: parseN(c), resolve: c.req.query('resolve') === '1', signal: c.req.raw.signal });
  return c.json(r);
});
// 기존 자료(source 페이지) 일괄 ingest — 엔티티·[[링크]] 추출로 두뇌 그래프 연결 보강(백그라운드 + 진행률).
const reingestState = { total: 0, done: 0, running: false, model: '' };
const reingestDoneFile = (): string => path.join(CONFIG.dataDir, 'reingest_done.json');
function loadReingestDone(): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(reingestDoneFile(), 'utf-8')) as string[]); } catch { return new Set(); }
}
app.post('/wiki/reingest', async (c) => {
  if (reingestState.running) return c.json({ ok: false, error: '이미 진행 중', total: reingestState.total, done: reingestState.done });
  // ?model= 으로 ingest 모델 지정. 미지정이면 micro(소형) 자동.
  const reqModel = (c.req.query('model') ?? '').trim();
  const model = reqModel || resolveAssignment().micro;
  const w = llmWiki();
  // 진행 영속 — 재기동 후엔 남은 것만(reset=1 이면 처음부터). 매 페이지 완료 시 done 기록.
  const done = c.req.query('reset') === '1' ? new Set<string>() : loadReingestDone();
  const remaining = w.list('source').filter((p) => !done.has(p.slug));
  reingestState.total = done.size + remaining.length; reingestState.done = done.size; reingestState.running = true; reingestState.model = model;
  void (async () => {
    for (const p of remaining) {
      try { await w.ingest({ title: p.title, content: p.body, model, skipSummary: true }); done.add(p.slug); } catch { /* 무해 */ }
      reingestState.done++;
      try { fs.writeFileSync(reingestDoneFile(), JSON.stringify([...done])); } catch { /* */ }
    }
    reingestState.running = false;
  })();
  return c.json({ ok: true, total: reingestState.total, remaining: remaining.length, model });
});
app.get('/wiki/reingest_status', (c) => c.json(reingestState));
// 멈춘 자동 직원귀속(classify) 일괄 재분류 — source 페이지 body 로 다시 돌린다(reingest 패턴 복제).
// 업로드 중 중단(서버 재시작 등)으로 pending 에 정체된 자료를 위키 원문으로 재귀속한다.
const reclassifyState = { total: 0, done: 0, running: false, model: '' };
app.post('/sources/reclassify', async (c) => {
  if (reclassifyState.running) return c.json({ ok: false, error: '이미 진행 중', total: reclassifyState.total, done: reclassifyState.done });
  // ?model= 으로 분류 모델 지정. 미지정이면 standard(분류는 standard 슬롯 — /sources 와 일관).
  const reqModel = (c.req.query('model') ?? '').trim();
  const model = reqModel || resolveAssignment().standard;
  const w = llmWiki();
  // 대상: source 페이지 중 아직 귀속 안 된 것(classify_status 가 done+assigned 아님). reset=1 이면 전부 재분류.
  const reset = c.req.query('reset') === '1';
  const sources = w.list('source');
  const statuses = getStatuses(sources.map((p) => p.slug));
  const targets = reset ? sources : sources.filter((p) => {
    const st = statuses[p.slug];
    return !st || st.state !== 'done' || (st.assigned?.length ?? 0) === 0;
  });
  reclassifyState.total = sources.length;
  reclassifyState.done = sources.length - targets.length;
  reclassifyState.running = true;
  reclassifyState.model = model;
  // 백그라운드 순회 — classifyAndAssign 이 자체적으로 status(pending→done) 갱신·실패안전 처리.
  void (async () => {
    for (const p of targets) {
      try { await classifyAndAssign(p.slug, p.title, p.body, model); } catch { /* 무해 — 한 건 실패가 전체를 막지 않음 */ }
      reclassifyState.done++;
    }
    reclassifyState.running = false;
  })();
  return c.json({ ok: true, total: reclassifyState.total, remaining: targets.length, model });
});
app.get('/sources/reclassify_status', (c) => c.json(reclassifyState));

// 업로드 원문(data/raw, 이미 추출된 UTF-8 텍스트)을 직접 재처리한다.
// 위키 재구축으로 source 페이지가 소실되고 classify_status 키가 어긋난 상황에서,
// 검증된 원문을 단일 진실원본으로 삼아 ①source 페이지 복원 ②직원귀속 ③두뇌 ingest 를 재수행.
// 2패스: Pass1(귀속·빠름) → Pass2(ingest·느림). 내용해시로 _2 재업로드 중복 제거. done 은 skip → 재개 안전.
const reprocessState = {
  phase: 'idle' as 'idle' | 'scan' | 'classify' | 'ingest' | 'done',
  total: 0, classified: 0, ingested: 0, skippedDup: 0, errors: 0,
  running: false, model: '', imodel: '', doIngest: true,
};
app.post('/sources/reprocess_raw', async (c) => {
  if (reprocessState.running) return c.json({ ok: false, error: '이미 진행 중', ...reprocessState });
  const reqModel = (c.req.query('model') ?? '').trim();
  const model = reqModel || resolveAssignment().standard;
  const imodel = resolveAssignment().micro || model;
  const reset = c.req.query('reset') === '1';
  const doIngest = c.req.query('ingest') !== '0';
  const limit = Math.max(0, Number(c.req.query('limit') ?? '0') | 0);
  const w = llmWiki();

  // 1) data/raw 전 파일 수집 + 내용해시 중복 제거(_2 재업로드 등). 텍스트는 처리 시 재독(메모리 절약).
  reprocessState.phase = 'scan';
  const seen = new Set<string>();
  const docs: Array<{ abs: string; title: string; slug: string; ref: string }> = [];
  let days: string[] = [];
  try { days = fs.readdirSync(w.rawDir).filter((d) => { try { return fs.statSync(path.join(w.rawDir, d)).isDirectory(); } catch { return false; } }).sort(); } catch { days = []; }
  let dupCount = 0;
  for (const day of days) {
    const dir = path.join(w.rawDir, day);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const file of files) {
      const abs = path.join(dir, file);
      let text = '';
      try { if (!fs.statSync(abs).isFile()) continue; text = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
      if (!text.trim()) continue;
      const h = createHash('sha1').update(text).digest('hex');
      if (seen.has(h)) { dupCount++; continue; }
      seen.add(h);
      // 표시·slug 용 제목 정돈: 확장자 제거 + 언더스코어→공백 + 양끝 따옴표 제거.
      const title = file.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^['"]+|['"]+$/g, '').trim() || file;
      docs.push({ abs, title, slug: slugify(title), ref: `raw/${day}/${file}` });
    }
  }
  const work = limit > 0 ? docs.slice(0, limit) : docs;
  reprocessState.total = work.length;
  reprocessState.classified = 0; reprocessState.ingested = 0; reprocessState.skippedDup = dupCount; reprocessState.errors = 0;
  reprocessState.running = true; reprocessState.model = model; reprocessState.imodel = imodel; reprocessState.doIngest = doIngest;

  void (async () => {
    const existing = new Set(w.list('source').map((p) => p.slug)); // 기존 source 페이지 — body 재append(비대화) 방지
    // ── Pass 1: source 페이지 복원 + 직원귀속(빠름) ──
    reprocessState.phase = 'classify';
    for (const d of work) {
      try {
        let text = ''; try { text = fs.readFileSync(d.abs, 'utf-8'); } catch { /* */ }
        if (text.trim()) {
          if (!existing.has(d.slug)) { w.upsertPage({ title: d.title, type: 'source', body: text, sources: [d.ref] }); existing.add(d.slug); }
          const st = getStatuses([d.slug])[d.slug];
          if (reset || !st || st.state !== 'done' || (st.assigned?.length ?? 0) === 0) {
            await classifyAndAssign(d.slug, d.title, text, model);
          }
        }
      } catch { reprocessState.errors++; }
      reprocessState.classified++;
    }
    // ── Pass 2: 두뇌 ingest(엔티티/개념 추출 — 느림, 직렬) ──
    if (doIngest) {
      reprocessState.phase = 'ingest';
      for (const d of work) {
        try {
          let text = ''; try { text = fs.readFileSync(d.abs, 'utf-8'); } catch { /* */ }
          if (text.trim()) {
            const st = getStatuses([d.slug])[d.slug];
            if (reset || st?.ingest?.state !== 'done') {
              setIngestStatus(d.slug, { state: 'pending', entities: [] });
              try {
                const r = await w.ingest({ title: d.title, content: text, model: imodel, sources: [d.ref], skipSummary: true });
                setIngestStatus(d.slug, { state: 'done', entities: r.pages });
              } catch { setIngestStatus(d.slug, { state: 'failed', entities: [] }); reprocessState.errors++; }
            }
          }
        } catch { reprocessState.errors++; }
        reprocessState.ingested++;
      }
    }
    w.rebuildIndex();
    reprocessState.phase = 'done';
    reprocessState.running = false;
  })();

  return c.json({ ok: true, total: work.length, uniqueDocs: docs.length, skippedDup: dupCount, doIngest, model, imodel });
});
app.get('/sources/reprocess_status', (c) => c.json(reprocessState));
app.get('/wiki/pages', (c) => {
  const cat = c.req.query('category') ?? '';
  const w = llmWiki();
  const all = w.list();
  const pages = (cat ? all.filter((p) => p.type === cat) : all).map((p) => ({
    id: p.slug, title: p.title, category: p.type, status: 'active', stance: 'neutral',
    contributors: p.contributors, tags: p.aliases, source_count: p.sources.length,
    updated_ts: p.updated, summary: p.summary,
  }));
  const counts: Record<string, number> = {};
  for (const p of all) counts[p.type] = (counts[p.type] ?? 0) + 1;
  return c.json({ pages, counts, total_pages: all.length });
});
app.get('/wiki/page/:id', (c) => {
  const w = llmWiki();
  const p = w.getPage(c.req.param('id') ?? '');
  if (!p) return c.json({ error: 'not found' }, 404);
  const related = p.links.map((slug) => ({ relation: 'relates', direction: 'out' as const, other_id: slug, other_title: w.getPage(slug)?.title ?? slug }));
  return c.json({
    id: p.slug, slug: p.slug, title: p.title, category: p.type, status: 'active',
    stance: 'neutral', confidence: 'medium', tags: p.aliases, aliases: p.aliases,
    contributors: p.contributors, sources: p.sources, body: p.body,
    created_ts: p.updated, updated_ts: p.updated, related,
  });
});

// ============================================================
// 승인 (프론트 계약)
// ============================================================
app.get('/approvals', (c) => c.json({ pending: approvalStore().list() }));
app.post('/approvals/:id/decide', async (c) => {
  const body = await c.req.json<{ approved?: boolean; note?: string }>().catch(() => ({}) as { approved?: boolean; note?: string });
  const ok = approvalStore().decide(c.req.param('id'), !!body.approved, body.note ?? '');
  return ok ? c.json({ ok: true }) : c.json({ error: 'unknown approval' }, 404);
});

// ============================================================
// MCP 서버 목록 — 현재 in-process 도구(위키·웹검색)를 MCP 서버 형태로 표면화. used_by 는 해당
// 툴을 보유한 직원(실명/직책)을 company 로스터에서 스캔. 외부(법제처 등) 서버는 미구현이라 표시 안 함.
async function mcpServers() {
  const co = getCompany();
  const roles = [co.ceo, ...co.specialists];
  const usersOf = (tools: string[]) =>
    [...new Set(roles.filter((r) => r.tools.some((t) => tools.includes(t))).map((r) => r.name || r.title))];
  const servers: Array<Record<string, unknown>> = [
    { id: 'wiki', name: '위키 (LLM Wiki)', icon: '📚', kind: 'in-process', desc: 'Karpathy 식 엔티티/개념 페이지 적재·조회', tools: ['wiki_query', 'wiki_ingest'], enabled: true, toggleable: false, used_by: usersOf(['wiki_query', 'wiki_ingest']) },
    { id: 'web', name: '웹 검색', icon: '🌐', kind: 'in-process', desc: '외부 웹 검색 그라운딩(DuckDuckGo)', tools: ['web_search'], enabled: CONFIG.webSearch, toggleable: false, used_by: usersOf(['web_search']) },
  ];
  // 외부 데이터 소스 커넥터(법령·DART 등) — 등록된 커넥터를 순회. 키 설정 시 enabled, scope 에 따라
  //  used_by(전 직원 또는 해당 도구 보유 역할). 새 소스는 커넥터만 추가하면 여기 자동 표시.
  for (const conn of connectors()) {
    const enabled = conn.enabled();
    const used = conn.scope === 'global' ? roles.map((r) => r.name || r.title) : usersOf(conn.scope);
    let tools: string[] = [];
    try { tools = enabled && conn.tools ? await conn.tools() : []; } catch { /* */ }
    servers.push({
      id: conn.id, name: conn.keyDef.label, icon: conn.keyDef.icon, kind: 'external',
      desc: `${conn.keyDef.desc}${enabled ? '' : ' — (키 미설정: API키 화면에서 ' + conn.keyDef.key + ' 입력 시 활성)'}`,
      tools, enabled, toggleable: false, used_by: used, needs_restart: false,
    });
  }
  return servers;
}
app.get('/mcp', async (c) => c.json({ servers: await mcpServers() }));

// ---- 외부 API 커넥터(선언형/AI 자동설정) ----
app.get('/connectors', (c) => c.json({ connectors: listCustomConfigs() }));
app.post('/connectors', async (c) => {
  const cfg = await c.req.json<CustomConnectorCfg>().catch(() => null);
  if (!cfg) return c.json({ ok: false, error: '잘못된 설정' }, 400);
  return c.json(saveCustomConfig(cfg));
});
app.delete('/connectors/:id', (c) => c.json(deleteCustomConfig(c.req.param('id') ?? '')));
// 테스트 — 설정 + 검색어로 실제 호출해 추출 결과 미리보기(저장 전 검증). 키는 시크릿에서 읽음.
app.post('/connectors/test', async (c) => {
  const b = await c.req.json<{ cfg?: CustomConnectorCfg; query?: string }>().catch(() => ({}) as { cfg?: CustomConnectorCfg; query?: string });
  if (!b.cfg) return c.json({ ok: false, error: 'cfg 필요' }, 400);
  const keySet = !!getSecret(b.cfg.keyName);
  if (!keySet) return c.json({ ok: false, error: `${b.cfg.keyName} 키가 설정되지 않았습니다(API키 화면에서 입력).` });
  const preview = await runCustomConnector(b.cfg, b.query?.trim() || '테스트', c.req.raw.signal);
  return c.json({ ok: true, preview, empty: !preview.trim(), note: preview.trim() ? '' : '응답이 비었습니다 — 엔드포인트/파라미터/추출규칙을 점검하세요.' });
});
// 문서 URL 검색 — API 이름으로 웹검색해 개발가이드 후보 URL 목록 반환(공식 도메인 우선 정렬).
app.post('/connectors/searchdocs', async (c) => {
  const b = await c.req.json<{ apiName?: string }>().catch(() => ({}) as { apiName?: string });
  const name = (b.apiName ?? '').trim();
  if (!name) return c.json({ ok: false, error: 'apiName 필요' }, 400);
  const results = await webSearch(`${name} OpenAPI 개발가이드 요청 파라미터 명세`, 8, c.req.raw.signal);
  // 공식·문서성 도메인 가산점(정확한 명세일 확률↑).
  const OFFICIAL = /(data\.go\.kr|kosis\.kr|opendart\.fss\.or\.kr|bizinfo\.go\.kr|go\.kr|or\.kr)/i;
  const DOCY = /(guide|api|openapi|dev|doc|명세|가이드|spec)/i;
  const scored = results.map((r) => ({
    title: r.title, url: r.url, snippet: r.snippet,
    score: (OFFICIAL.test(r.url) ? 2 : 0) + (DOCY.test(r.url + r.title) ? 1 : 0),
  })).sort((a, b) => b.score - a.score);
  return c.json({ ok: true, results: scored });
});
// AI 자동설정 — API 이름(+문서 URL)으로 로컬 LLM 이 선언형 설정 제안(저장 안 함, 미리보기용).
app.post('/connectors/autoconfig', async (c) => {
  const b = await c.req.json<{ keyName?: string; apiName?: string; docsUrl?: string }>().catch(() => ({}) as { keyName?: string; apiName?: string; docsUrl?: string });
  if (!b.keyName || !b.apiName) return c.json({ ok: false, error: 'keyName·apiName 필요' }, 400);
  const cfg = await autoConfigConnector({ keyName: b.keyName, apiName: b.apiName, docsUrl: b.docsUrl, signal: c.req.raw.signal });
  if (!cfg) return c.json({ ok: false, error: 'AI 설정 생성 실패 — API 문서 URL을 넣거나 수동 설정을 시도하세요.' });
  return c.json({ ok: true, cfg });
});
// 토글 — 위키·웹검색은 항상 활성, 법제처는 API 키 패널의 LAW_API_KEY 로 켜고 끔(명시 반환, 404 방지).
app.post('/mcp/:id', async (c) => c.json({ ok: false, error: '위키·웹검색은 항상 활성입니다. 법제처는 API 키 패널에서 LAW_API_KEY(법제처 OC)로 켜고 끕니다.', servers: await mcpServers() }));

// --- 외부 자료 업로드 → 멀티포맷 추출 → 위키 적재 + LLM 자동 직원귀속 분류 ---
async function classifyModel(): Promise<string> {
  return resolveAssignment().standard;
}
// ingest(엔티티 추출)는 micro 모델 — classify(standard)보다 빠르게 처리(finalize 와 일관).
async function ingestModel(): Promise<string> {
  return resolveAssignment().micro;
}
app.post('/sources', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const raw = body['files'];
  const files = (Array.isArray(raw) ? raw : [raw]).filter((x): x is File => x instanceof File);
  const w = llmWiki();
  const model = await classifyModel();
  const imodel = await ingestModel();
  const results: Array<Record<string, unknown>> = [];
  let ok = 0;
  let dup = 0;
  // 내용해시 중복제거: 동일 텍스트(예: macOS 사본 'foo 2.pdf' 와 'foo.pdf' 동시 업로드, 혹은 재업로드)는
  // 위키·raw 에 두 번 들어가지 않는다. 비교 기준은 살아있는 source 가 참조하는 '원문(raw)' 해시 —
  // 페이지 본문이 갱신 누적·청크 분할로 변형돼도 원문 기준이라 재업로드를 놓치지 않는다(삭제된 자료의
  // 고아 raw 는 제외 → 삭제 후 재업로드 가능). 이번 요청 내 해시는 아래 루프에서 함께 추적.
  const seen = w.referencedRawHashes();
  for (const f of files) {
    const name = f.name || 'upload';
    if (!isSupportedExt(name)) { results.push({ file: name, status: 'unsupported', note: 'PDF/DOCX/HWPX/XLSX/PPTX/텍스트만 지원' }); continue; }
    if (f.size > 25_000_000) { results.push({ file: name, status: 'too-large' }); continue; }
    try {
      const buf = Buffer.from(await f.arrayBuffer());
      // 원본 바이너리 보존(프로비넌스) — 추출이 부실해도 나중에 더 나은 추출기로 재처리 가능하게.
      // (이전엔 추출 텍스트만 저장 → 원본 소실로 재추출 불가. 추출 전에 먼저 보존.)
      w.saveOriginal(name, buf);
      const text = await extractText(name, buf);
      if (!text.trim()) { results.push({ file: name, status: 'failed', note: '추출된 텍스트 없음' }); continue; }
      const h = createHash('sha1').update(text.trim()).digest('hex');
      if (seen.has(h)) { dup++; results.push({ file: name, status: 'duplicate', note: '동일 내용 자료가 이미 있어 건너뜀' }); continue; }
      seen.add(h);
      const rawRef = w.saveRaw(name, text);
      // 검색 친화 제목 — 폴더 경로(예: '2026년도/회계파트/...')를 제목으로 쓰면 slug 가 붙어 검색 토큰에 안 걸렸다.
      // basename 만 제목으로 쓰고(확장자 제거·언더스코어→공백·선행기호 제거), 폴더·괄호(작성자)는 검색 별칭으로 둔다.
      const pathParts = name.replace(/\\/g, '/').split('/').filter(Boolean);
      const baseName = (pathParts[pathParts.length - 1] ?? name).replace(/\.[^.]+$/, '');
      const title = baseName.replace(/_/g, ' ').replace(/^[\s★·*]+/, '').replace(/\s+/g, ' ').trim() || baseName;
      const titleAliases = [...new Set([
        ...pathParts.slice(0, -1),
        ...((baseName.match(/\(([^)]+)\)/g) || []).map((s) => s.replace(/[()]/g, '').trim())),
      ].filter(Boolean))];
      const page = w.addSourceDoc({ title, body: text, sources: [rawRef], aliases: titleAliases });
      w.appendLog('source', name);
      // 자동 직원귀속 분류는 백그라운드(업로드 응답 즉시) — 정산 패널이 ref 로 폴링.
      if (model) {
        void classifyAndAssign(page.slug, page.title, text, model);
        // 자료에서 엔티티/개념 추출 + [[링크]] 생성(두뇌 그래프 연결) — 백그라운드. 정산 패널에 결과 표출.
        setIngestStatus(page.slug, { state: 'pending', entities: [] });
        void w.ingest({ title, content: text, model: imodel || model, sources: [rawRef], skipSummary: true })
          .then((r) => setIngestStatus(page.slug, { state: 'done', entities: r.pages }))
          .catch(() => setIngestStatus(page.slug, { state: 'failed', entities: [] }));
      }
      results.push({ file: name, title: page.title, status: 'ok', ref: page.slug, page_id: page.slug, assigned: [] });
      ok++;
    } catch (e) {
      results.push({ file: name, status: 'failed', note: e instanceof Error ? e.message : String(e) });
    }
  }
  if (ok > 0) w.rebuildIndex();
  return c.json({ ok, skipped: dup, total: files.length, results });
});
app.get('/sources', (c) => {
  const sources = llmWiki().list('source').map((p) => ({
    id: p.slug, title: p.title, origin: 'upload', by: (p.contributors[0] ?? ''), file: (p.sources[0] ?? p.title),
  }));
  return c.json({ sources });
});
app.post('/sources/classify_status', async (c) => {
  const body = await c.req.json<{ refs?: string[] }>().catch(() => ({}) as { refs?: string[] });
  return c.json({ statuses: getStatuses(body.refs ?? []) });
});
app.post('/sources/reassign', async (c) => {
  const body = await c.req.json<{ ref?: string; to?: string }>().catch(() => ({}) as { ref?: string; to?: string });
  const r = reassign(body.ref ?? '', body.to ?? '');
  return r.ok ? c.json({ assigned_label: r.assigned_label }) : c.json({ error: r.error }, 400);
});
app.post('/sources/classify_retry', async (c) => {
  const body = await c.req.json<{ refs?: string[] }>().catch(() => ({}) as { refs?: string[] });
  const model = await classifyModel();
  let retrying = 0;
  if (model) for (const ref of body.refs ?? []) {
    const page = llmWiki().getPage(ref);
    if (page) { void classifyAndAssign(ref, page.title, page.body, model); retrying++; }
  }
  return c.json({ retrying });
});
// 키 목록 — 카드마다 brand('' = 공용)가 실려 있어 UI가 브랜드별로 필터한다(내장 키는 앱 공용).
// brands·activeBrand 는 키 탭의 브랜드 선택자 초기화용(탭을 열면 활성 브랜드 카드가 보이도록).
app.get('/api-keys', (c) => c.json({
  keys: listKeys(), hidden: hiddenKeys(), activeBrand: activeBrandSlug(),
  brands: [{ slug: '', name: '공용 (기본)' }, ...listBrands().map((b) => ({ slug: b.slug, name: b.name }))],
}));
app.post('/api-keys', async (c) => {
  const b = await c.req.json<{ key?: string; value?: string }>().catch(() => ({} as { key?: string; value?: string }));
  return c.json(setKey(b.key ?? '', b.value ?? ''));
});
app.post('/api-keys/add', async (c) => {
  const b = await c.req.json<{ key?: string; label?: string; icon?: string; value?: string; brand?: string }>()
    .catch(() => ({} as { key?: string; label?: string; icon?: string; value?: string; brand?: string }));
  const brand = (b.brand ?? '').trim();
  if (brand && !isSafeBrandSlug(brand)) return c.json({ ok: false, error: '무효한 브랜드 슬러그입니다.' }, 400);
  // 존재하는 브랜드만 허용 — 오탈자 슬러그로 태생부터 도달 불가한 고아 정의가 생기는 것 차단.
  if (brand && !listBrands().some((x) => x.slug === brand)) return c.json({ ok: false, error: '존재하지 않는 브랜드입니다.' }, 400);
  return c.json(addCustom(b.key ?? '', b.label ?? '', b.icon ?? '', b.value ?? '', brand));
});
// 네이버 발행 계정 — 브랜드별 분리(범용 '' 포함). blogId 는 공개값(평문), 로그인 아이디·비번은 마스킹.
// 프로필·세션 파일은 발행 시 활성/piece 브랜드 슬러그로 자동 분리된다(blog_skills). 계정 섞임 차단.
app.get('/api-keys/naver', (c) => {
  const brands = [{ slug: '', name: '범용 (기본)' }, ...listBrands().map((b) => ({ slug: b.slug, name: b.name }))];
  const accounts: Record<string, ReturnType<typeof naverAccountView>> = {};
  for (const b of brands) accounts[b.slug] = naverAccountView(b.slug);
  return c.json({ brands, accounts });
});
app.post('/api-keys/naver', async (c) => {
  const b = await c.req.json<{ brand?: string; blogId?: string; loginId?: string; loginPw?: string }>()
    .catch(() => ({} as { brand?: string; blogId?: string; loginId?: string; loginPw?: string }));
  const slug = (b.brand ?? '').trim();
  if (slug && !isSafeBrandSlug(slug)) return c.json({ ok: false, error: '무효한 브랜드 슬러그입니다.' }, 400);
  // 빈 값은 '유지'(기존 키 탭 UX와 동일) — 비운 채 저장해도 지우지 않는다. 값이 온 필드만 갱신.
  const patch: { blogId?: string; loginId?: string; loginPw?: string } = {};
  if (typeof b.blogId === 'string' && b.blogId.trim()) patch.blogId = b.blogId;
  if (typeof b.loginId === 'string' && b.loginId.trim()) patch.loginId = b.loginId;
  if (typeof b.loginPw === 'string' && b.loginPw.trim()) patch.loginPw = b.loginPw;
  if (!Object.keys(patch).length) return c.json({ ok: false, error: '변경할 값이 없습니다.' }, 400);
  setNaverAccount(slug, patch);
  return c.json({ ok: true, account: naverAccountView(slug) });
});
// 카드 삭제 — 사용자 키는 완전 제거, 기본 키는 값 제거+숨김(restore 로 복원).
app.delete('/api-keys/:key', (c) => c.json(deleteKey(c.req.param('key') ?? '')));
app.post('/api-keys/:key/restore', (c) => c.json(restoreKey(c.req.param('key') ?? '')));
app.get('/favicon.ico', (c) => c.body(null, 204));
// 수정 요청(v+1) — 부모 런의 전문가 입장 + 피드백으로 CEO 재종합.
async function reviseHandler(c: Context): Promise<Response> {
  const parentId = c.req.param('id') ?? '';
  const parent = RUNS.get(parentId);
  if (!parent) {
    // 메모리에 없으면(재시작/evict) 디스크에 런이 실재하는지 구분 — positions 는 메모리에만 있어 복원 불가하므로,
    // '모르는 런'(404)과 '재시작으로 입장 데이터 소실'(409)을 구분해 안내한다(이전엔 둘 다 혼란스런 404였다).
    const meta = loadRunMeta(parentId) ?? legacyMetaFromFiles(parentId);
    return meta
      ? c.json({ error: '서버 재시작으로 입장 데이터가 소실되었습니다. 원본 런을 다시 실행한 뒤 수정해 주세요.' }, 409)
      : c.json({ error: 'unknown run' }, 404);
  }
  if (!parent.positions?.length) return c.json({ error: '원본 입장 데이터가 없습니다(런 완료 후 다시 시도).' }, 409);
  const body = await c.req.json<{ feedback?: string }>().catch(() => ({}) as { feedback?: string });
  const feedback = (body.feedback ?? '').trim();
  if (!feedback) return c.json({ error: 'feedback 이 필요합니다' }, 400);

  yieldRunningAutos(); // revise 도 사용자 개시 런 — 진행 중 자율런을 양보시켜 launchRun 과 동일 정책 유지.
  const id = runId();
  const version = (parent.version ?? 1) + 1;
  const bus = createBus(id);
  const abort = new AbortController();
  const handle: RunHandle = { status: 'running', abort, topic: parent.topic, created_ts: new Date().toISOString(), version };
  handle.brand = activeBrandSlug() || undefined;
  RUNS.set(id, handle);
  evictRuns();

  runRevise(bus, { topic: parent.topic, positions: parent.positions, priorDeliverable: parent.deliverable ?? '', feedback, signal: abort.signal })
    .then((o) => { handle.status = 'done'; handle.deliverable = o.deliverable; handle.positions = o.positions; handle.subproblems = o.subproblems; })
    .catch((e: unknown) => {
      if (abort.signal.aborted || isAbort(e)) { handle.status = 'cancelled'; bus.emit(EventType.run_done, { status: 'cancelled' }); }
      else { handle.status = 'error'; bus.emit(EventType.error, { message: e instanceof Error ? e.message : String(e) }); bus.emit(EventType.run_done, { status: 'error' }); }
    })
    .finally(() => { persistEvents(id, bus); persistRunMeta(id, handle); });

  return c.json({ run_id: id, version });
}

app.post('/runs/:id/revise', reviseHandler);
// (HWPX 내보내기 제거 — 콘텐츠 스튜디오는 최종 산출물을 한글 문서로 변환하지 않는다.)
// 중단 런 재구동(resume) — 오케스트레이터에 체크포인트/경계-재시작 인프라가 없어(RunOptions
// 에 resumeFrom 없음; runOffice/runOrg 는 항상 처음부터) 안전한 재구동이 불가하다. 무계획 재실행은
// LLM 을 처음부터 다시 돌려 이벤트 seq 가 충돌하므로 막는다. 프론트는 이 501 을 받아 친절히 안내하고
// '기록 다시 보기'(loadPast)로 우회한다. (참고: 서버는 'interrupted' 상태를 만들지 않으므로 — running|
// done|error|cancelled — '이어가기' 버튼은 실제로 거의 렌더되지 않는다.)
app.post('/runs/:id/resume', (c) =>
  c.json({ error: '중단된 런의 자동 재구동은 아직 지원되지 않습니다. "다시 보기"로 기록을 열어 진행 과정·산출물을 확인하세요.' }, 501));

// --- 음성 입출력 (Voice I/O) ---
const sttHandler = async (c: Context): Promise<Response> => {
  if (!sttAvailable()) return c.json({ error: 'STT 미설치(mlx_whisper/ffmpeg 필요)' }, 503);
  const body = await c.req.parseBody({ all: true });
  const files = ([] as unknown[]).concat(body['files'] ?? []).filter((f): f is File => f instanceof File);
  const f = files[0];
  if (!f) return c.json({ error: '오디오 파일 없음' }, 400);
  if (f.size > 25_000_000) return c.json({ error: '오디오가 너무 큼(25MB 초과)' }, 400);
  try {
    const text = await transcribe(Buffer.from(await f.arrayBuffer()), { signal: c.req.raw.signal });
    return c.json({ text });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};

const ttsHandler = async (c: Context): Promise<Response> => {
  if (!ttsAvailable()) return c.json({ error: 'TTS 미설치(say/ffmpeg 필요)' }, 503);
  const body = await c.req.json<{ text?: string; voice?: string }>().catch(() => ({} as { text?: string; voice?: string }));
  const text = (body.text ?? '').trim();
  if (!text) return c.json({ error: '텍스트 없음' }, 400);
  try {
    const mp3 = await synthesize(text, { voice: body.voice, signal: c.req.raw.signal });
    return new Response(new Uint8Array(mp3), {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};

const voicesHandler = async (c: Context): Promise<Response> => {
  const available = ttsAvailable();
  const voices = available ? await listKoreanVoices() : [];
  return c.json({ available: ttsAvailable(), ttsAvailable: ttsAvailable(), sttAvailable: sttAvailable(), voices, defaultVoice: getVoiceSettings().ttsVoice, conversational: getVoiceSettings().conversational });
};

const voiceSettingsHandler = async (c: Context): Promise<Response> => {
  const body = await c.req.json<{ conversational?: boolean }>().catch(() => ({} as { conversational?: boolean }));
  const patch: Partial<{ conversational: boolean }> = {};
  if (typeof body.conversational === 'boolean') patch.conversational = body.conversational;
  const next = setVoiceSettings(patch);
  return c.json({ conversational: next.conversational });
};

app.post('/voice/stt', sttHandler);
app.post('/api/voice/stt', sttHandler);
app.post('/voice/tts', ttsHandler);
app.post('/api/voice/tts', ttsHandler);
app.get('/voice/voices', voicesHandler);
app.get('/api/voice/voices', voicesHandler);
app.post('/voice/settings', voiceSettingsHandler);
app.post('/api/voice/settings', voiceSettingsHandler);

// --- 자비스 대화 ---
const jarvisHandler = async (c: Context): Promise<Response> => {
  // 가용성 — Claude 백엔드는 항상 가용(호출 시 인증 오류는 그때 표면화).
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>().catch(() => ({} as { messages?: { role: string; content: string }[] }));
  const messages = (body.messages ?? []).filter((m) => m && typeof m.content === 'string');
  if (!messages.length) return c.json({ error: '메시지 없음' }, 400);
  try {
    const out = await jarvisChat(messages as { role: 'user' | 'assistant'; content: string }[], { signal: c.req.raw.signal });
    return c.json(out);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};
app.post('/jarvis/chat', jarvisHandler);
app.post('/api/jarvis/chat', jarvisHandler);

// ============================================================
// 정적 — React 프론트(/) + 경량 자체 UI(/lite)
// ============================================================
const DIST = path.resolve(process.cwd(), 'frontend/dist');
const PUBLIC = path.resolve(process.cwd(), 'public');

async function serveDistIndex(c: Context): Promise<Response> {
  try {
    return c.html(await readFile(path.join(DIST, 'index.html'), 'utf-8'));
  } catch {
    return c.html('<h1>React 프론트 미빌드</h1><p><code>cd frontend && pnpm install && pnpm build</code> 후 새로고침. 경량 UI: <a href="/lite">/lite</a></p>');
  }
}
app.get('/lite', async (c) => {
  try { return c.html(await readFile(path.join(PUBLIC, 'index.html'), 'utf-8')); }
  catch { return c.text('lite UI 없음', 500); }
});
app.use('/assets/*', serveStatic({ root: 'frontend/dist' }));
app.get('/', serveDistIndex);
app.use('/*', serveStatic({ root: 'frontend/dist' })); // favicon 등 기타 정적, 없으면 next→notFound
// 매칭 실패는 텍스트 대신 JSON 404(프론트 fetch 의 JSON 파싱 우아 처리).
app.notFound((c) => c.json({ error: 'not found' }, 404));

// 직원 워크스페이스 스캐폴드 — 14명 전원 data/agents/<id>/ 폴더를 보장(아직 미참여 직원도 포함).
for (const id of rolesById(getCompany()).keys()) ensureScaffold(id);

// 유휴 게이트 자율 사이클(옵트인: AUTO_CYCLE_MINUTES>0). 사용자 런이 없을 때만 콘텐츠 piece 1건을 전진시키고,
// 사용자 런 도착 시 양보(launchRun 이 abort). 기본 off 라 기본 동작엔 영향 없음.
const isRunLive = (runId?: string): boolean => !!runId && RUNS.get(runId)?.status === 'running';

// 이번 틱에 처리할 작업 — **재개 우선**: 사용자 양보·재시작으로 런이 죽어 stranded 된 비종료 piece 를 먼저
// 회수하고(신규 생성보다 우선), 없을 때만 새 아이디어를 제안·생성한다. 이게 '완전 자율'의 내구성 핵심 —
// 없으면 사용자가 앱을 쓸 때마다(유휴 게이트가 상시 양보) piece 가 idea 에서 고아가 되고 매 틱 새 piece 만 쌓인다.
// 신규 아이디어 생성 케이던스/백로그 게이트(재개는 무관) — 사용자 결정(주 2~3개) 준수 + ready 홍수 방지.
// 없으면 autoCycleMinutes 를 낮게 잡을 때 하루 수십 편이 생성돼 미발행 초안이 범람한다.
function canGenerateNew(pieces: Piece[], force = false): boolean {
  // 카덴스 쿼터는 자율 생산분만 계산 — 사용자 수동 생성은 오토런 쿼터에서 제외(사용자 지시).
  // 사용자가 직접 촉발한 틱의 산출물은 케이던스 기준에서 뺀다(2026-08-29 사용자 확정) — "지금 하나 더"가
  // 다음 정각 슬롯을 밀어내면 안 된다. 실측: 07:28 생성분이 기준점이 되어 17:00 슬롯이 12시간 간격에 막혔다.
  // 미발행 초안 캡에는 그대로 포함한다(아래) — 그건 검토 홍수를 막는 별개 축이다.
  if (pieces.filter((p) => p.auto && p.stage === 'ready').length >= CONFIG.contentReadyCap) return false; // 미발행 자율 초안 캡(사용자 촉발분 포함)
  // force(사용자 직접 실행 틱) — 간격을 기다리지 않고 즉시 생산(사용자 결정 2026-08-09). 캡은 유지(검토 홍수 방지).
  if (force) return true;
  const minIntervalMs = (7 * 24 * 60 * 60 * 1000) / CONFIG.contentCadencePerWeek;                    // 주 N편 → 최소 간격
  const lastCreated = cadenceBaselineTs(pieces);
  return !lastCreated || (Date.now() - new Date(lastCreated).getTime()) >= minIntervalMs;
}

/**
 * 채택 직전 단일 키워드 수요 판정(2026-08-26 최종 리뷰 C1) — 예고·클러스터 형제 경로용.
 *
 * 수요 게이트는 proposeContentIdeas(세 번째 공급 경로) 안에만 있었다. 그 앞에서 return 하는 두 경로
 * (예고 이행·클러스터 형제 소진)는 게이트를 통째로 우회해, LLM 이 쓴 "다음 편" 문구나 자동완성 형제가
 * 검색량 검증 없이 그대로 발주됐다(리서치 폐기 게이트를 두 경로에 소급했던 처서 실사고와 같은 형태).
 *
 * 호출은 그 경로가 실제로 후보를 낸 틱에서만 — 조용한 틱의 비용은 0이다. 게이트 off 는 아무것도 하지 않고,
 * 검색광고 키가 없으면 API 조회도 로그도 하지 않는다('측정 안 함'을 측정한 것처럼 로그가 주장하면 안 된다).
 * 단 기억 조회는 키와 무관하게 한다 — 기억은 이미 받아 둔 실측이라 키가 필요 없고(그게 '재조회 0'의 요점),
 * 키 유무로 갈리면 같은 키워드가 아이디어 경로에서는 기각·예고 경로에서는 통과하는 비대칭이 생긴다.
 * 예외·빈 Map 은 fail-open(unknown) — 판정은 실제 응답을 받았을 때만 한다.
 */
async function demandCheckFor(
  keyword: string,
  where: '예고' | '클러스터',
  signal?: AbortSignal,
  slug: string = activeBrandSlug() || '',
): Promise<{ verdict: DemandVerdict; line: string }> {
  if (!CONFIG.topicDemandGate) return { verdict: 'unknown', line: '' };
  // 시기 소재 게이트(2026-08-27) — 예고·클러스터 주제도 이번 달·다음 달 밖 달력 소재(단풍·월동…)면 기각.
  // 검색광고 키·기억 원장과 무관하게 먼저 본다(비용 0, 스케줄러 후보 루프와 같은 규칙).
  const offSeason = offSeasonSubject(keyword, getBrand()?.seasonalSubjects);
  if (offSeason) return { verdict: 'reject', line: `시기 밖 소재(${offSeason.term}: ${formatMonths(offSeason.months)}, 지금 ${new Date().getMonth() + 1}월)` };
  // 수종 월 상한(2026-08-27) — 예고·클러스터 주제도 최근 30일 같은 수종 블로그가 상한이면 기각.
  const capped = overSpeciesCap(keyword, speciesCoverageFor(slug), getBrand()?.speciesCatalog);
  if (capped) return { verdict: 'reject', line: `수종 월 상한(${capped.name}: 30일 ${capped.count}편 ≥ ${SPECIES_MONTHLY_CAP})` };
  const cappedTheme = overThemeCap(keyword, brandThemeCoverage(new Date(), slug), getBrand()?.topicThemes);
  if (cappedTheme) return { verdict: 'reject', line: `주제 축 월 상한(${cappedTheme.theme}: 30일 ${cappedTheme.count}편 ≥ ${THEME_MONTHLY_CAP})` };
  const cfg = { minVolume: CONFIG.topicDemandMinVolume, minSeason: CONFIG.topicDemandMinSeason };
  // 기각 기억(2026-08-27) — 지난 틱에 실측으로 하한 미달이 확정된 키워드는 API 를 부르지 않는다(조회 비용 0).
  // 세 경로(후보 루프·예고·클러스터)가 같은 원장을 공유해야, 어느 경로에서 떨어진 키워드든 다른 경로로
  // 되돌아오지 않는다. 여기엔 기아 방지 밸브가 없다(단건 판정이라 '후보 전멸' 개념 자체가 없음).
  const remembered = demandRejectFor(slug, keyword);
  if (remembered) return demandGateDecision(new Map(), keyword, cfg, { remembered: { line: remembered.line } });
  // 검색광고 키는 여기서부터(API 경로)만 요구한다 — 위 기억 조회보다 앞에 두면 키 없는 설정에서 이 두 경로만
  // 원장을 못 보게 되고, 스케줄러(키와 무관하게 기억을 본다)와 갈려 '세 경로가 같은 원장을 공유'가 깨진다.
  if (!searchAdEnabled()) return { verdict: 'unknown', line: '' };
  // 레그 단위로 삼킨다 — 커넥터 예외가 틱 전체(예고 이행·형제 소진)를 날리면 안 된다(scheduler 와 동일 규약).
  const rows = await assessCandidatesDemand([keyword], signal).catch(() => new Map<string, DemandRow>());
  const d = demandGateDecision(rows, keyword, cfg);
  // 기각은 각 경로가 자기 문구로 남긴다(폐기·제외 처리와 한 줄로 붙어야 읽힌다). 나머지는 여기서 1줄.
  if (d.verdict !== 'reject') console.log(`[auto-cycle] 수요 게이트(${where}) — "${keyword.slice(0, 40)}" ${d.line || '조회 없음'}`);
  else rememberDemandReject(slug, keyword, d.line);
  return { verdict: d.verdict, line: d.line };
}

// 자율 틱 작업 유형 — 콘텐츠 piece(재개/신규) 또는 지식 리서치 미션(조사→토론→두뇌 적재→학습).
type AutoWork = { kind: 'piece'; piece: Piece; promiseId?: string; clusterTopicId?: string } | { kind: 'research'; title: string; brand: string }
  | { kind: 'shorts'; pieceId: string; title: string } | { kind: 'cardnews'; pieceId: string; title: string };

async function pickAutoWork(signal?: AbortSignal, force = false, userTriggered = false): Promise<AutoWork | null> {
  const pieces = pieceStore().list();
  const resume = selectResumablePiece(pieces, isRunLive);
  if (resume) return { kind: 'piece', piece: resume }; // 재개는 케이던스와 무관 — 죽은 piece 회수 우선.
  // 지식 리서치 게이트 — 주기 도래 시 신규 콘텐츠보다 먼저 1건. 조사 결과(두뇌·교훈)가 이후 콘텐츠 품질을
  // 끌어올리는 컴파운딩 순서(지식 먼저, 제작 나중). 제안 실패 시 콘텐츠 흐름으로 자연 폴백.
  // 브랜드는 틱 시작 시점에 고정 — 제안 LLM 대기(수 초) 중 브랜드가 전환돼도 상태·기록이 갈리지 않게.
  // force(사용자 직접 실행) 땐 리서치 분기 생략 — 사용자가 원한 건 '지금 콘텐츠 생산'(사용자 결정 2026-08-09).
  const tickBrand = activeBrandSlug() || '';
  if (!force && researchDue(CONFIG.researchCycleHours, tickBrand)) {
    const title = await proposeResearchMission(signal, tickBrand);
    if (title) return { kind: 'research', title, brand: tickBrand };
  }
  if (canGenerateNew(pieces, force)) {  // 케이던스/백로그 초과면 신규 블로그 보류 → 아래 파생 케이던스로 폴백.
    // 예고 이행 우선 — 콘텐츠가 시청자에게 한 "다음 편" 약속은 신규 아이디어보다 먼저 갚는다
    // (사용자 지적 2026-07-30: 예고만 하고 안 지키면 신뢰 역효과). 시기 명시+시즌 창 안의 약속만
    // 자동 대상(무기한 선점 방지 — 리뷰 반영). 이행 piece 가 ready 되면 기존 자동 파생이
    // 카드뉴스·쇼츠까지 이어주고, priorCoverage 가 앞선 편의 앵글을 주입한다.
    try {
      // 정합 복원 — 이행 piece 가 삭제·종료실패(stage:'error')면 약속을 pending 으로 되살린다
      // ("갚은 척 기록만 남는" 신뢰 역전 방지). 저비용이라 매 틱 수행.
      const reverted = promiseStore().reconcile(tickBrand, (pid) => {
        const p = pieceStore().get(pid);
        return !p ? 'missing' : p.stage === 'error' ? 'error' : 'ok';
      });
      if (reverted) console.log(`[auto-cycle] 예고 정합 복원 — ${reverted}건 pending 복귀(이행 piece 유실/실패)`);
      // 만료 청소(2026-08-28) — 시즌 창을 놓친 지 오래된 약속을 비워 백로그가 스스로 숨 쉬게 한다.
      // 실측: 7/29~8/1 12건 적재 후 27일간 캡 만석 → 그 사이 모든 신규 예고가 조용히 거절됐다.
      // nextDue 앞에 둔다 — 만료분이 후보에서 먼저 빠져야 이번 틱이 살아 있는 약속을 본다.
      const expired = promiseStore().expire(tickBrand);
      for (const e of expired) console.log(`[auto-cycle] 예고 만료 폐기 — "${e.topic.slice(0, 40)}" (${e.window ?? '시기 미상'} 창 경과) → dropped`);
      const due = promiseStore().nextDue(tickBrand);
      if (due) {
        // 브랜드 소재 게이트 — 예고 경로는 신규성·범위 검사를 다 우회하므로 여기서 막는다. 게이트 신설(2026-07-31)
        // 이전에 등록된 오프브랜드 약속의 이행 방지. 걸리면 dropped 처리 후 신규 아이디어로 폴백.
        const off = offBrandTerm(due.topic);
        // 소재 포화 게이트 — 예고 이행은 신규성·포화 검사를 우회해 같은 축을 자기복제한다(실측 2026-08-01:
        // 감나무묘목 글이 예고한 "상자 받으면 뿌리·접목부 확인"이 그대로 다음 글로 발주). 이행 시점에
        // 코퍼스가 이미 그 소재로 포화면 미룬다 — dropped 가 아니라 pending 유지(시즌·맥락이 바뀌면 살아난다).
        const satur = off ? [] : saturatedThemeMatches({ title: due.topic }, collectExistingContent(tickBrand || undefined), 3, getBrand()?.compoundStems ?? []);
        if (off) {
          promiseStore().update(due.id, { status: 'dropped' });
          console.log(`[auto-cycle] 예고 기각(브랜드 범위 밖) — "${due.topic.slice(0, 40)}" (소재 "${off}") → dropped`);
        } else if (satur.length) {
          console.log(`[auto-cycle] 예고 보류(소재 포화) — "${due.topic.slice(0, 40)}" ≈ "${satur[0]!.title.slice(0, 30)}" → 신규 아이디어로 폴백`);
        } else {
          // 검색 수요 게이트(2026-08-26 리뷰 C1) — 기존 검사(범위·포화) 뒤, 채택 직전.
          // 미달은 pending 유지가 아니라 dropped 다: 월 검색량은 기다린다고 바뀌지 않아(포화처럼 시간이
          // 풀어 주는 조건이 아니다) pending 으로 두면 틱마다 재조회하며 영원히 미이행으로 남는다.
          const dem = await demandCheckFor(due.topic, '예고', signal, tickBrand);
          if (dem.verdict === 'reject') {
            promiseStore().update(due.id, { status: 'dropped' });
            console.log(`[auto-cycle] 예고 폐기(검색 수요 미달) — "${due.topic.slice(0, 40)}" (${dem.line})`);
          } else {
            const piece = pieceStore().create({ title: due.topic, brand: tickBrand || undefined, auto: true, userTriggered });
            // fulfilled 마킹은 여기서 하지 않는다 — launch 가 런을 실제로 시작한 뒤에만(아래 launch 참조).
            console.log(`[auto-cycle] 예고 이행 착수 — "${due.topic.slice(0, 40)}" (출처: ${due.sourceKind}${due.window ? ` · ${due.window}` : ''})`);
            return { kind: 'piece', piece, promiseId: due.id };
          }
        }
      }
    } catch { /* 예고 대장 실패 무해 — 신규 아이디어로 폴백 */ }
    // 클러스터 형제 소진(스펙 2026-08-06) — 예고(약속)보다 뒤, 신규 아이디어보다 앞(검색 수요가 자동완성으로
    // 이미 검증된 주제). 케이던스(canGenerateNew) 안이므로 생산량은 불변, 다양성만 늘린다.
    if (process.env.TOPIC_CLUSTER !== 'off') {
      try {
        const all = clusterStore().list().filter((t) => (t.brand ?? '') === tickBrand);
        // 쿨다운 입력 — 최근 자율 blog piece 의 clusterSeedId(최신순).
        const recentSeeds = pieces.filter((p) => p.auto && (p.brand ?? '') === tickBrand)
          .sort((a, b) => b.createdTs.localeCompare(a.createdTs))
          .map((p) => p.clusterSeedId);
        const cand = pickNextSibling(all.filter((t) => t.status === 'pending'), all, recentSeeds);
        if (cand) {
          // 소진 시점 재검증 — 채굴과 소진 사이 코퍼스가 변했을 수 있다(스펙 ③). 게이트는 채굴과 동일한
          // filterCandidates 재사용 — 시드 가족(파생·동일 키워드)은 차별화 부분으로만 대조(전 후보 오기각 방지).
          const seedTitle = (cand.seedPieceId ? pieceStore().get(cand.seedPieceId)?.title : undefined) ?? '';
          const off = offBrandTerm(`${cand.title} ${cand.keyword}`);
          // 리서치 폐기 판정 게이트(2026-08-20 리뷰) — proposeContentIdeas 만 막으면 클러스터 소진 경로로
          // 폐기 키워드가 그대로 재배정된다(처서 실사고의 두 번째 공급로). 정규화 완전 일치만 기각.
          const avoided = off ? null : avoidVerdictFor(cand.keyword, tickBrand || undefined);
          const existingNow = collectExistingContent(tickBrand || undefined);
          const gate = (off || avoided) ? null : filterCandidates([cand.keyword], cand.seedKeyword, seedTitle, existingNow);
          const dupWhy = gate && !gate.pass.length ? (gate.rejected[0]?.why ?? '게이트 기각') : '';
          const sat = (off || avoided || dupWhy) ? [] : saturatedThemeMatches({ title: cand.title, keyword: cand.keyword }, existingNow, 3, getBrand()?.compoundStems ?? []);
          // 계열 쿨다운 v2(2026-08-25) — 백로그의 같은 계열 형제도 하드 구간엔 소진하지 않는다(폴백 라벨 경로).
          // dropped 가 아니라 보류(pending 유지) — 점수가 식으면 자연 해제되고, 소진 시점 재검증이 중복은 따로 거른다.
          const clGate = (off || avoided || dupWhy || sat.length) ? null : seriesGateForText(`${cand.title} ${cand.keyword}`, tickBrand || undefined);
          const cooledCl = clGate && clGate.level === 'hard' ? clGate.key ?? '계열' : null;
          if (off || avoided || dupWhy) {
            clusterStore().update(cand.id, { status: 'dropped' });
            console.log(`[auto-cycle] 클러스터 기각 — "${cand.keyword}" (${off ? `소재 "${off}"` : avoided ? `리서치 폐기 판정(${avoided.reason.slice(0, 40)})` : dupWhy}) → dropped`);
          } else if (sat.length) {
            console.log(`[auto-cycle] 클러스터 보류(소재 포화) — "${cand.keyword}" ≈ "${sat[0]!.title.slice(0, 24)}" → 신규 아이디어로 폴백`);
          } else if (cooledCl) {
            console.log(`[auto-cycle] 클러스터 보류(계열 쿨다운 "${cooledCl}") — "${cand.keyword}" → 신규 아이디어로 폴백`);
          } else {
            // 검색 수요 게이트(2026-08-26 리뷰 C1) — 형제는 자동완성 유래라 약한 자연 방어가 있지만
            // 검색량 자체는 검증된 적이 없다. 미달이면 리서치 폐기 소급과 같은 메커니즘(dropped)으로
            // 백로그에서 빼고(사유는 로그) 다음 경로(신규 아이디어)로 진행한다.
            const dem = await demandCheckFor(cand.keyword, '클러스터', signal, tickBrand);
            if (dem.verdict === 'reject') {
              clusterStore().update(cand.id, { status: 'dropped' });
              console.log(`[auto-cycle] 클러스터 기각(검색 수요 미달) — "${cand.keyword}" (${dem.line}) → dropped`);
            } else {
              const piece = pieceStore().create({ title: cand.title, keyword: cand.keyword, brand: tickBrand || undefined, auto: true, userTriggered, clusterSeedId: cand.id });
              console.log(`[auto-cycle] 클러스터 형제 착수 — "${cand.keyword}" (시드 "${cand.seedKeyword}")`);
              consumeOpportunityVerdict(cand.keyword, tickBrand || undefined); // 채택된 기회 소진(2026-08-24)
              return { kind: 'piece', piece, clusterTopicId: cand.id };
            }
          }
        }
      } catch { /* 클러스터 실패 무해 — 신규 아이디어로 폴백 */ }
    }
    const idea = await proposeContentIdeas(signal);
    // 브랜드 고정 — 제안 LLM 대기(수 초) 중 브랜드가 전환되면 A 컨텍스트로 만든 아이디어가 B 에 귀속될 수
    // 있어 버린다(리서치 경로 main.ts 위 tickBrand 고정과 동일 원칙 — 종전엔 콘텐츠 경로만 빠져 있었음).
    if ((activeBrandSlug() || '') !== tickBrand) return null;
    if (idea) return { kind: 'piece', piece: pieceStore().create({ title: idea.title, keyword: idea.keyword, subNiche: idea.subNiche, brand: tickBrand || undefined, auto: true, userTriggered }) };
  }
  // 파생 콘텐츠 일일 케이던스(사용자 지시 2026-07-16: 쇼츠·카드뉴스 매일 1편) — 초안 있는 최신 블로그
  // 에서 파생(리서치된 내용 재사용 = 같은 주제 채널 전개라 신규성 가드 비대상). 케이던스는 자율 생산분만
  // 계산해(수동 제외) 사용자가 직접 만들어도 오토런은 자기 몫을 채운다. 파생 소스는 아직 그 채널로 전개 안 된 최신 초안.
  const derivable = pieces
    .filter((p) => (p.brand ?? '') === tickBrand && p.runId && ['ready', 'published', 'measured', 'reflected'].includes(p.stage))
    .sort((a, b) => b.updatedTs.localeCompare(a.updatedTs));
  if (CONFIG.autoShortsPerDay > 0) {
    const all = shortsStore().list().filter((s) => (s.brand ?? '') === tickBrand);
    // error 제외(2026-08-20 하드 캡 리뷰) — 실패 건이 케이던스 슬롯을 소진하거나 소스 글을 영구 점유하지 않게.
    // 같은 글 실패 2회부터는 재파생 중단(폭주 방지) — 네이버 저장 훅의 파생 게이트와 동일 규약.
    const last = all.filter((s) => s.auto && s.stage !== 'error').reduce((mx, s) => (s.createdTs > mx ? s.createdTs : mx), ''); // 자율 생산분만(수동 제외)
    if (derivedContentDue(CONFIG.autoShortsPerDay, last || undefined) && !all.some((s) => isShortsRunning(s.id))) {
      const src = derivable.find((p) => {
        const mine = all.filter((s) => s.sourcePieceId === p.id);
        return !mine.some((s) => s.stage !== 'error') && mine.filter((s) => s.stage === 'error').length < 2;
      });
      if (src) return { kind: 'shorts', pieceId: src.id, title: src.title };
    }
  }
  if (CONFIG.autoCardnewsPerDay > 0) {
    const all = cardNewsStore().list().filter((x) => (x.brand ?? '') === tickBrand);
    const last = all.filter((x) => x.auto).reduce((mx, x) => (x.createdTs > mx ? x.createdTs : mx), ''); // 자율 생산분만(수동 제외)
    if (derivedContentDue(CONFIG.autoCardnewsPerDay, last || undefined) && !all.some((x) => isCardNewsRunning(x.id))) {
      const src = derivable.find((p) => !all.some((x) => x.sourcePieceId === p.id));
      if (src) return { kind: 'cardnews', pieceId: src.id, title: src.title };
    }
  }
  return null;
}

const stopAutoCycle = startAutoCycle<AutoWork>({
  intervalMs: CONFIG.autoCycleMinutes * 60_000,
  isEnabled: autoRunEnabled, // 사용자 토글(대시보드 '자율' 칩 클릭) — 꺼짐이면 틱이 조용히 통과
  isBusy: () => [...RUNS.values()].some((h) => h.status === 'running'), // 자율런 포함 — 동시 1런만(단일 KV 슬롯 불변식).
  pickWork: (signal, force, userTriggered) => pickAutoWork(signal, force, userTriggered),
  launch: (w) => {
    if (w.kind === 'research') {
      // 제안 도중 브랜드가 전환됐으면 이번 틱은 건너뜀 — A 컨텍스트 조사가 B 두뇌·게이트에 섞이지 않게.
      if ((activeBrandSlug() || '') !== w.brand) return;
      // 리서치 팀 1팀 경량 경로(path:'team') — 협업·토론 후 보고서를 두뇌에 적재. piece 미생성(캘린더 비오염).
      // 주제에 '리서치:' 접두사를 붙이지 않는다 — seedKeyword 가 콜론에서 절단해 전 그라운딩 커넥터가
      // 문자 그대로 '리서치'를 검색하던 버그(2b2d901 과 동일 부류). mission 필드가 이미 1급 신호다.
      recordResearchLaunch(w.title, w.brand);
      launchRun(w.title, { auto: true, mission: 'research', path: 'team' });
      return;
    }
    if (w.kind === 'shorts' || w.kind === 'cardnews') {
      // 파생은 자체 잡 시스템(런 슬롯 비점유) — derive 가 생성+런 기동까지 처리, 실패는 무해 로그.
      const r = w.kind === 'shorts' ? deriveShortsFromPiece(w.pieceId, undefined, true) : deriveCardNewsFromPiece(w.pieceId, undefined, undefined, true);
      if ('error' in r) console.log(`[auto-cycle] ${w.kind === 'shorts' ? '쇼츠' : '카드뉴스'} 파생 실패(무해): ${r.error}`);
      return;
    }
    const id = launchRun(w.piece.title, { auto: true, pieceId: w.piece.id, keyword: w.piece.keyword });
    if (id) pieceStore().update(w.piece.id, { runId: id, stage: 'draft' }); // 시작 성공 → draft(진행중). ''(억제)면 유지, 다음 틱 재개.
    // 예고 이행 마킹 — 런이 실제로 시작됐을 때만(억제('')면 piece 가 idea 로 남아 다음 틱 재개, 약속도 pending 유지).
    // 이후 piece 가 종료 실패하면 위 reconcile 이 pending 으로 복원한다.
    if (id && w.promiseId) { try { promiseStore().update(w.promiseId, { status: 'fulfilled', fulfilledPieceId: w.piece.id }); } catch { /* 무해 */ } }
    // 클러스터 소진 마킹 — 예고와 동일 원칙: 런이 실제 시작됐을 때만(억제('')면 pending 유지, 다음 틱 재시도).
    if (id && w.clusterTopicId) { try { clusterStore().update(w.clusterTopicId, { status: 'consumed', consumedPieceId: w.piece.id }); } catch { /* 무해 */ } }
  },
  describe: (w) => (w.kind === 'research' ? `리서치: ${w.title}`
    : w.kind === 'shorts' ? `쇼츠 파생: ${w.title}`
    : w.kind === 'cardnews' ? `카드뉴스 파생: ${w.title}` : w.piece.title),
  log: (m) => console.log('[auto-cycle]', m),
});
if (CONFIG.autoCycleMinutes > 0) {
  // eslint-disable-next-line no-console
  console.log(`[biz-contents-creator] 자율 사이클 활성 — ${CONFIG.autoCycleMinutes}분 주기(유휴 게이트) · 리서치 ${CONFIG.researchCycleHours}h/건 · 블로그 주 ${CONFIG.contentCadencePerWeek}편${CONFIG.autoShortsPerDay ? ` · 쇼츠 일 ${CONFIG.autoShortsPerDay}편` : ''}${CONFIG.autoCardnewsPerDay ? ` · 카드뉴스 일 ${CONFIG.autoCardnewsPerDay}편` : ''}`);
}
void stopAutoCycle; // 프로세스 생존 동안 유지(unref 타이머라 종료는 막지 않음)
// 수동 즉시 실행 — 30분 타이머를 기다리지 않고 지금 한 틱(pickAutoWork→launch). 토글 무시, isBusy·재진입 가드는 유지.
app.post('/autonomy/tick', async (c) => {
  // 진행 중 런이 있어도 409 로 끝내지 않는다 — 지속 실행이 종료를 기다렸다 시작(오토런 지시 게이트와 동일 UX).
  const busyNow = [...RUNS.values()].some((h) => h.status === 'running');
  // 수동 틱도 사용자 촉발 — 웹 UI 버튼이든 "자율런" 지시문이든 사람이 시킨 것은 쿼터에서 뺀다(2026-08-29).
  void stopAutoCycle.runNowPersistent({ label: '수동 틱', userTriggered: true }); // 비동기 기동 — 즉시 응답, 진행은 사무실/기록 탭에서.
  return c.json({ ok: true, note: busyNow
    ? '자율 사이클 예약 — 진행 중 런이 끝나는 대로 콘텐츠 1건을 자율 선정해 시작합니다(자동 재시도).'
    : '자율 사이클 1틱 실행 — 지금 만들 콘텐츠 1건을 자율 선정해 곧 시작합니다(사무실 탭에서 관전).' });
});
app.post('/api/autonomy/tick', (c) => c.redirect('/autonomy/tick', 307));

// 정각 오토런(사용자 결정 2026-08-10: 매일 06:00·18:00 각 1편) — AUTORUN_TIMES="HH:MM,HH:MM".
// startDaily 가 재기동 내구·당일 따라잡기를 보장하고, runNow(force)가 케이던스 간격을 우회해 그 자리에서
// 1편을 선정·시작한다(사용자 오토런 토글은 존중 — off 면 그 슬롯 건너뜀). 빈값=off(종전 동작).
// 30분 타이머 틱(24h 간격 케이던스)은 슬롯 유실 시(런 충돌 등) 따라잡기 폴백으로 남는다.
for (const t of CONFIG.autorunTimes.split(',').map((s) => s.trim()).filter(Boolean)) {
  startDaily({
    time: t, key: `autorun-${t.replace(':', '')}`,
    // 지속 실행 — 슬롯 발화 순간 다른 런(유휴 틱 리서치 등)이 돌고 있으면 종료를 기다렸다 생산
    // (실사고 2026-08-18: 18:00 슬롯이 리서치 런에 밀려 소멸, 30분 폴백 틱은 케이던스 게이트에 막힘).
    run: () => { if (autoRunEnabled()) void stopAutoCycle.runNowPersistent({ label: `정각 슬롯(${t})`, respectToggle: true }); },
    log: (m) => console.log('[정각 오토런]', m),
  });
}
if (CONFIG.autorunTimes) {
  // eslint-disable-next-line no-console
  console.log(`[biz-contents-creator] 정각 오토런 — 매일 ${CONFIG.autorunTimes} 즉시 생산 1편씩`);
}

// 일일 브리핑(옵트인: DAILY_BRIEFING_TIME="HH:MM"). 지정 시각에 다이제스트를 알림 채널로 발송. 빈값=off.
const stopDaily = startDaily({
  time: CONFIG.dailyBriefingTime,
  key: 'briefing', // 재기동에도 하루 1회 유지 + 예정 시각 지나 부팅해도 그날 몫 따라잡기

  // 팔로워 스냅샷 → 색인 캐시 갱신 → 브리핑(두 섹션 모두 최신값으로). 수집 실패는 무해(섹션 생략/이전 값).
  run: () => { void recordFollowersSnapshot().catch(() => {}).finally(() => { void refreshNaverIndexingCache().catch(() => {}).finally(() => { void notify(buildBriefing()); }); }); },
  log: (m) => console.log('[briefing]', m),
});
if (CONFIG.dailyBriefingTime) {
  // eslint-disable-next-line no-console
  console.log(`[biz-contents-creator] 일일 브리핑 활성 — ${CONFIG.dailyBriefingTime}${notifyConfigured() ? '' : ' (알림 채널 미설정 — /api-keys 에서 웹훅/텔레그램 설정 필요)'}`);
}
void stopDaily;

// 일일 성과 동기화(옵트인: PERFORMANCE_SYNC_TIME="HH:MM"). 발행 후 측정창 도달한 piece 를 등록 수집기로
// 측정→강화(멱등). 기본 수집기(manual)는 measure 가 null 이라 no-op — 사람이 POST /pieces/:id/metrics 로
// 수동 입력한다. 실제 브라우저 스크레이퍼를 setCollector 로 등록하면 자동화(스크레이퍼 마일스톤, 사용자 로그인 필요).
async function syncPerformance(opts?: { force?: boolean }): Promise<void> {
  // 사용자 트리거 브라우저 작업(임시저장·수집)이 프로필을 쓰는 중이면 이번 주기는 건너뛴다(프로필 락 충돌 방지).
  if (naverProfileBusy) { console.log('[perf-sync]', `프로필 사용 중(${naverProfileBusy}) — 이번 주기 건너뜀`); return; }
  naverProfileBusy = '일일동기화';
  try {
  const collector = getCollector();
  const windowMs = CONFIG.performanceWindowDays * 24 * 60 * 60 * 1000;
  for (const p of pieceStore().list()) {
    // ① 일일 연속 추적 — 발행 직후~측정창(14일) 안의 글은 매일 1회 조회·체류·유입을 '기록만'
    //    (appendMetrics — 강화 없음). 사용자 요청 2026-07-30: 수집은 매일, 강화는 14일 후 그대로.
    //    KST 하루 1회 멱등이라 새로고침 버튼·크론이 겹쳐도 재스크레이프하지 않는다.
    // 게이트 기준은 '접촉'(측정 성공 또는 시도) — 표본을 못 얻은 시도(D+0 집계 지연)도 하루 1회로 캡.
    // 실측 2026-07-30: 발행 33분 글은 표본이 없어 measuredAt 이 null 로 남고, 새로고침마다 headful 크롬이 재기동됐다.
    // 단 새로고침(force)은 활성 브랜드 글에 한해 '측정 성공'만 접촉으로 본다(빈손 시도는 재시도) — 이른 아침
    // 데일리 런이 집계 지연으로 빈손이면 하루 종일 어제 값에 멈춰 보이던 문제(사용자 확정 2026-07-31, 조회 1↔4).
    // 타 브랜드 글은 시도 게이트 유지 — 활성 프로필로는 항상 실패라 클릭마다 재스크레이프하는 낭비 방지.
    const touch = (opts?.force && brandMatch(p))
      ? (latestMetrics(p.id)?.measuredAt ?? null)
      : latestTouch(latestMetrics(p.id)?.measuredAt, naverAttemptAt(p.id));
    if (naverTrackingDue(p, touch, CONFIG.performanceWindowDays)) {
      try {
        const sample = await collector.measure(p);
        if (sample) {
          appendMetrics(p.id, sample);
          const age = Date.now() - new Date(p.publishedTs ?? p.updatedTs).getTime();
          console.log('[perf-sync]', `${p.title.slice(0, 24)} — 일일 추적 D+${Math.floor(age / 86_400_000)} 기록(조회 ${sample.views})`);
        } else {
          console.log('[perf-sync]', `${p.title.slice(0, 24)} — 일일 추적: 표본 없음(발행 초기 집계 지연 가능) — 오늘은 재시도 안 함`);
        }
      } catch (e) { console.log('[perf-sync]', `${p.id} 일일 추적 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
      finally { markNaverAttempt(p.id); }
      continue; // 창 안은 추적만 — 강화는 창 경과 후 아래 ②에서
    }
    // ①b 새로고침(force) 동결 해제 — 측정창 경과+강화 완료(reflected/measured)로 ①·② 어디에도 안 걸려
    //    동결되던 글을 재수집해 '기록만'(강화 재실행 없음). 사용자 확정 2026-07-31: 성과탭 새로고침이
    //    옛 글 조회수도 갱신(실측: 페이지 67 vs 성과탭 53 동결) — 유튜브·IG·FB force 와 동작 통일.
    //    헤드리스 전환(45c69eb)으로 크롬 창 남발이 해소돼 편입하되, 시도 게이트(하루 1회)는 그대로 캡.
    if (opts?.force && p.publishedUrl && p.stage !== 'published'
      && Date.now() - new Date(p.publishedTs ?? p.updatedTs).getTime() >= windowMs
      // 활성 브랜드는 '측정 성공'만 스킵 사유(빈손 재시도 허용, ① 과 동일 원칙) — 타 브랜드는 시도 게이트.
      && !sameKstDay(brandMatch(p) ? (latestMetrics(p.id)?.measuredAt ?? null) : naverAttemptAt(p.id))) {
      try {
        const sample = await collector.measure(p);
        if (sample) {
          appendMetrics(p.id, sample);
          console.log('[perf-sync]', `${p.title.slice(0, 24)} — 새로고침 갱신(창 경과, 조회 ${sample.views})`);
        }
      } catch (e) { console.log('[perf-sync]', `${p.id} 새로고침 갱신 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
      finally { markNaverAttempt(p.id); }
      continue;
    }
    // ② 강화(기존) — 측정창 경과 + 미측정(published) 글 1회 측정→강화(measured→reflected).
    if (p.stage !== 'published') continue;
    if (Date.now() - new Date(p.publishedTs ?? p.updatedTs).getTime() < windowMs) continue; // 창 미도달 — 대기
    if (sameKstDay(naverAttemptAt(p.id))) continue; // 창 경과 글도 시도는 하루 1회 — 데이터 없는 글의 새로고침 반복 스크레이프 방지
    try {
      const sample = await collector.measure(p);
      if (sample) await ingestMetrics(p.id, sample);                        // 측정치 있으면 강화(measured→reflected)
    } catch (e) { console.log('[perf-sync]', `${p.id} 측정 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    finally { markNaverAttempt(p.id); }
  }
  } finally { naverProfileBusy = null; }
}
const stopPerfSync = startDaily({
  time: CONFIG.performanceSyncTime,
  key: 'perf-sync',

  // 네이버 발행 감지(공개 RSS — 프로필 락 무관)가 publishedUrl 을 채운 뒤 piece 동기화. 쇼츠·카드뉴스는 순수 API 라 병행.
  // 팔로워 스냅샷을 여기에도 건다 — 종전엔 일일 브리핑 잡에만 달려 있었는데, DAILY_BRIEFING_TIME 이
  // 비어 있으면 startDaily 가 no-op 이라 스냅샷이 **한 번도 정기 수집되지 않았다**(실측 2026-08-02:
  // 설정 비어 있음 + 스냅샷 07-31 에서 정지). 브리핑 설정 여부와 팔로워 추적은 서로 묶일 이유가 없다.
  // 조회수 감사(2026-08-20) 일일 배선 — 리서치 판정 수확 + 자동완성 트렌드 스냅샷(둘 다 fail-open, 주제 두뇌가 소비).
  // 검색 수요 스냅샷(2026-08-26)도 여기 합류 — 시드 키워드의 절대 검색량·시즌 지수(하루 ~6콜, 킬스위치 off 면 0콜).
  run: () => { void discoverPublishedNaver().then(() => syncPerformance()); void syncShortsPerformance(); void syncCardnewsPerformance(); void syncShortsMetaPerformance(); void recordFollowersSnapshot().catch(() => {}); void harvestTopicVerdicts().catch(() => {}); void refreshTrendSnapshot().catch(() => {}); void refreshDemandSnapshot().catch(() => {}); void refreshYtNicheSnapshot().catch(() => {}); void ensureSeriesLabels(activeBrandSlug() || undefined).catch(() => {}); }, // 쇼츠·카드뉴스·릴스는 순수 API — 프로필 락 무관
  log: (m) => console.log('[perf-sync]', m),
});
if (CONFIG.performanceSyncTime) {
  // eslint-disable-next-line no-console
  console.log(`[biz-contents-creator] 성과 동기화 활성 — ${CONFIG.performanceSyncTime} · 수집기 "${getCollector().name}"(측정창 ${CONFIG.performanceWindowDays}일)`);
}
// 수요 게이트 상태 1줄(2026-08-26 리뷰 M2) — 켜져 있어도 검색광고 키가 없으면 전량 fail-open 이라
// 아무 판정도 일어나지 않는다. 그 '조용한 무동작'이 부팅 로그에서 바로 보이게 한다.
// eslint-disable-next-line no-console
console.log(`[biz-contents-creator] 수요 게이트 ${CONFIG.topicDemandGate ? 'on' : 'off'} (검색광고 키 ${searchAdEnabled() ? '있음' : '없음'}, 하한 ${CONFIG.topicDemandMinVolume}/월·시즌 ${CONFIG.topicDemandMinSeason})`);
void stopPerfSync;

// 텔레그램 봇 수신 폴러 — 검토 대기 알림의 발행 버튼(callback)·수정요청 답장 처리.
// 자격(TELEGRAM_BOT_TOKEN/CHAT_ID) 미설정이면 내부에서 유휴 대기(설정 즉시 자동 재개).
if (CONFIG.telegramBot && !process.env.VITEST) startTelegramBot();

// 부팅 복구 스윕 — 카드뉴스/숏폼 잡의 '진행 중'은 in-memory RUNNING 에만 있고 디스크에는
// stage(planning/designing/rendering)만 남는다. 렌더링 도중 서버가 재시작되면(tsx watch 의
// TS 편집 포함) 잡은 사라지는데 stage 는 그대로라 검토탭이 영구 "생성 중…"이 된다.
// 새 프로세스엔 살아있는 잡이 없으므로 비종료 stage 는 전부 고아 — error 로 마감한다.
if (!process.env.VITEST) {
  const orphanErr = '서버 재시작으로 생성이 중단되었습니다 — 삭제 후 다시 만들어 주세요';
  const orphanCards = cardNewsStore().list().filter((x) => x.stage !== 'ready' && x.stage !== 'error');
  for (const x of orphanCards) cardNewsStore().update(x.id, { stage: 'error', error: orphanErr });
  // 숏폼은 실패 처리 대신 자동 재개(2026-08-20 사용자 확정: "쇼츠는 반드시 생성되어야 함") — 실사고:
  // tsx 지연 중복 재시작(23:23, mtime 변화 없이 발화)이 렌더 중 잡을 죽여 error 로 좌초. 재개 캡 2회
  // (크래시 루프 방지), 15초 정착 지연(tsx 는 1변경에 수 초 간격 연쇄 재시작하는 습성이 실측됨 — 즉시
  // 재개하면 그 버스트에 복구 횟수가 다 탄다. 지연 중 또 재시작하면 카운터 소모 없이 다음 부팅이 이어받는다).
  const orphanShorts = shortsStore().list().filter((x) => x.stage !== 'ready' && x.stage !== 'error');
  const recoverIds = orphanShorts.filter((x) => (x.recoveries ?? 0) < 2).map((x) => x.id);
  for (const x of orphanShorts) {
    if (!recoverIds.includes(x.id)) shortsStore().update(x.id, { stage: 'error', error: `${orphanErr} (자동 재개 2회 소진)` });
  }
  if (recoverIds.length) {
    const timer = setTimeout(() => {
      for (const sid of recoverIds) {
        try {
          const s = shortsStore().get(sid);
          if (!s || s.stage === 'ready' || s.stage === 'error' || isShortsRunning(sid)) continue; // 그 사이 종결·재개됨
          // 파생 쇼츠는 원본 초안 본문을 다시 읽어 동일 조건으로 재실행(deriveShortsFromPiece 와 같은 소스).
          let sourceBody: string | undefined;
          if (s.sourcePieceId) {
            try {
              const piece = pieceStore().get(s.sourcePieceId);
              if (piece?.runId) {
                const d = JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, piece.runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string };
                sourceBody = (d.bodyMarkdown ?? '').trim() || undefined;
              }
            } catch { /* 본문 없이도 재개 — planShorts 는 sourceBody 없이 동작 */ }
          }
          shortsStore().update(sid, { recoveries: (s.recoveries ?? 0) + 1 });
          launchShortsRun(sid, s.topic, sourceBody
            ? { sourceBody, sourceFlagged: sourceFlaggedClaims(pieceStore().get(s.sourcePieceId ?? '')?.runId) }
            : {});
          // eslint-disable-next-line no-console
          console.log(`[부팅 복구] 중단된 숏폼 자동 재개 — ${s.topic.slice(0, 30)} (${(s.recoveries ?? 0) + 1}/2회차)`);
        } catch (e) { console.log(`[부팅 복구] 숏폼 ${sid} 재개 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
      }
    }, 15_000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  if (orphanCards.length || orphanShorts.length) {
    // eslint-disable-next-line no-console
    console.log(`[부팅 복구] 중단된 생성 잡 — 카드뉴스 ${orphanCards.length}건 실패 처리 · 숏폼 ${recoverIds.length}건 15초 후 자동 재개${orphanShorts.length - recoverIds.length ? ` · ${orphanShorts.length - recoverIds.length}건 재개 소진→실패` : ''}`);
  }
  // 검토 알림 유실 복구 — ready 승격·리비전 대기 중 재시작하면 fire-and-forget 알림이 프로세스와 함께
  // 죽는다(실측 2026-07-31: ready 6초 뒤 tsx 재시작 → 알림·리비전 동반 유실, "사과나무" 건). 최근 24h 내
  // 미발송(notifiedTs 없음)분만 재발송 — 옛 글 스팸 방지. 발송 '전에' 스탬프: 편집 세션의 연속 재시작에도
  // 1회만 나간다(여기서 또 죽으면 그 1건은 유실이지만, 부팅 연발이 훨씬 흔한 시나리오라 선기록이 낫다).
  // 리비전 유예로 알림을 생략한 글도 리비전이 재시작에 죽으면 여기서 원본 초안 알림이 나간다(리비전은 프로세스 생존 불가).
  if (contentReadyNotifyEnabled()) {
    for (const p of pieceStore().list()) {
      if (p.stage !== 'ready' || p.notifiedTs || !p.runId) continue;
      if (Date.now() - new Date(p.updatedTs).getTime() > 24 * 3600 * 1000) continue;
      pieceStore().update(p.id, { notifiedTs: new Date().toISOString() });
      // eslint-disable-next-line no-console
      console.log(`[부팅 복구] 유실된 검토 알림 재발송 — ${p.title.slice(0, 30)}`);
      void notifyBlogReady({ id: p.id, title: p.title, keyword: p.keyword, seoScore: p.seoScore, brand: p.brand, factGate: p.factGate }, p.runId);
    }
    // 쇼츠·카드뉴스도 동일 복구 — 단 이들은 발행 후에도 stage 가 'ready' 로 남으므로(발행은 별도 액션)
    // 아직 어느 채널에도 발행 안 된 것(진짜 검토 대기)만 대상. 산출물 파일이 없으면(삭제 등) 건너뜀.
    for (const s of shortsStore().list()) {
      if (s.stage !== 'ready' || s.notifiedTs || s.youtubeId || s.igReelId || s.fbReelId) continue;
      if (Date.now() - new Date(s.updatedTs).getTime() > 24 * 3600 * 1000) continue;
      const vp = path.join(shortsStore().dirFor(s.id), 'final.mp4');
      if (!fs.existsSync(vp)) continue;
      shortsStore().update(s.id, { notifiedTs: new Date().toISOString() });
      // eslint-disable-next-line no-console
      console.log(`[부팅 복구] 유실된 쇼츠 검토 알림 재발송 — ${s.topic.slice(0, 30)}`);
      void notifyShortsReady({
        id: s.id, topic: s.topic, brand: s.brand, durationSec: s.durationSec, scenes: s.scenes,
        sourcePieceId: s.sourcePieceId, writer: s.writer, director: s.director, factGate: s.factGate,
      }, vp);
    }
    for (const cn of cardNewsStore().list()) {
      if (cn.stage !== 'ready' || cn.notifiedTs || cn.igMediaId || cn.fbPostId) continue;
      if (Date.now() - new Date(cn.updatedTs).getTime() > 24 * 3600 * 1000) continue;
      const dir = cardNewsStore().dirFor(cn.id);
      if (!fs.existsSync(dir)) continue;
      cardNewsStore().update(cn.id, { notifiedTs: new Date().toISOString() });
      // eslint-disable-next-line no-console
      console.log(`[부팅 복구] 유실된 카드뉴스 검토 알림 재발송 — ${cn.topic.slice(0, 30)}`);
      void notifyCardnewsReady({
        id: cn.id, topic: cn.topic, brand: cn.brand, slides: cn.slides,
        sourcePieceId: cn.sourcePieceId, planner: cn.planner, designer: cn.designer, factGate: cn.factGate,
      }, dir);
    }
  }
}

// 수요 스냅샷 부팅 예열 — 하드 기각(검색량 하한)은 배포 즉시 켜지는데 두뇌에 넣는 수요 표는
// demand-<brand>.json 이 생겨야(일일 perf-sync 틱) 나온다. 그 사이엔 '기각은 하는데 왜 기각인지는
// 안 알려주는' 상태라 첫 틱부터 표를 채워 둔다. 같은 날 재호출은 함수 내부에서 no-op, 게이트 off 면 0콜.
// 20초 지연+unref: tsx watch 는 1회 편집에 수 초 간격으로 연쇄 재시작하는 습성이 실측돼 있어(위 숏폼
// 복구의 15초 정착 지연과 같은 이유), 즉시 호출하면 편집 버스트마다 조회가 새로 나간다. 재시작이
// 창 안에 들어오면 타이머가 프로세스와 함께 사라져 버스트가 1회로 접힌다.
if (!process.env.VITEST) {
  const warm = setTimeout(() => { void refreshDemandSnapshot().catch(() => {}); }, 20_000);
  if (typeof warm.unref === 'function') warm.unref();
}

const port = CONFIG.port;
if (!process.env.VITEST) serve({ fetch: app.fetch, hostname: CONFIG.host, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[biz-contents-creator] http://${CONFIG.host}:${info.port}  (backend=claude)  · React=/ · lite=/lite`);
});

// 메타(페이스북) OAuth 콜백 전용 HTTPS 리스너 — 페이스북은 OAuth 리디렉션에 HTTPS 를 강제한다
// (구글은 로컬 http 허용, 페이스북은 불가). data/certs/localhost.{key,crt}(자체 서명) 있으면 콜백 포트에
// 같은 app 을 HTTPS 로도 서빙 → META_REDIRECT 가 https://localhost:<port>/meta/oauth/callback 로 성립.
if (!process.env.VITEST) {
  try {
    const key = fs.readFileSync(path.join(CONFIG.dataDir, 'certs', 'localhost.key'));
    const cert = fs.readFileSync(path.join(CONFIG.dataDir, 'certs', 'localhost.crt'));
    serve({ fetch: app.fetch, hostname: CONFIG.host, port: META_HTTPS_PORT, createServer: createHttpsServer, serverOptions: { key, cert } }, () => {
      // eslint-disable-next-line no-console
      console.log(`[biz-contents-creator] https://localhost:${META_HTTPS_PORT}  (메타 OAuth 콜백 전용)`);
    });
  } catch {
    // eslint-disable-next-line no-console
    console.log('[biz-contents-creator] 메타 HTTPS 콜백 미기동 — data/certs/localhost.{key,crt} 없음(메타 연결 시 필요)');
  }
}

export { app };
