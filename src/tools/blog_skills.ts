/**
 * 블로그 스킬 브릿지 — image_generate / blog_publish 를 스튜디오 툴로 연결.
 *
 * 원본 naver-blog-agent-web 의 Python 스킬(gpt-image-2 이미지 생성 · Playwright 네이버 임시저장)을
 * 재사용한다. run_command 의 allowlist/경로 제약(임의 실행 방지)을 **우회하지 않고**, 여기서
 * **고정 인터프리터(CONFIG.blogPython) · 고정 스크립트 경로 · 리터럴 argv** 만 spawn 한다
 * — 모델은 자유 명령 문자열을 만들 수 없고, 구조화된 인자(주제·스타일·본문)만 제공한다.
 *
 * blog_publish 는 외부(네이버)에 초안을 남기는 부작용이라 agent.ts gateWrite 가 항상 승인 게이트한다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config';
import { sandboxDir } from '../orchestrator/shell';
import { activeBrandSlug, isSafeBrandSlug } from '../content/brand';
import { getNaverAccount } from '../secrets/store';
import { coerceBlogDraft, draftToFinalContent } from '../output/smarteditor';
import type { BlogDraft } from '../output/formatter';

export interface BlogSkillResult { ok: boolean; output: string }

const OUTPUT_CAP = 12 * 1024;
// 이미지 생성·Playwright 임시저장은 셸 분석 명령보다 오래 걸릴 수 있어 별도 타임아웃(3분).
const BLOG_TIMEOUT_MS = Math.max(CONFIG.agentShellTimeoutMs, 180_000);
// 검토 탭 트리거의 실제 네이버 임시저장 — 최초 로그인(수동·최대 10분 대기) + 글쓰기까지 여유.
// 30분: 15분은 사람처럼 타이핑(자당 0.02~0.06초 + 문장 중간 멈춤)에 표·코드 스플라이스가 겹치면
// 부족했다(실측 2026-08-01: 본문 3,668자·표코드 5개 글이 두 번 연속 정확히 15:00 에 절단, 결과 파일
// 미생성 → '발행 결과 파일 없음'). 상한이라 짧은 글의 소요 시간에는 영향 없음. env 로 조정 가능.
const NAVER_PUBLISH_TIMEOUT_MS = Math.max(60_000,
  Number.parseInt(process.env.NAVER_PUBLISH_TIMEOUT_MS ?? '', 10) || 30 * 60_000);
// 성과 수집(어드바이저 캡처) — 로그인된 세션 전제, 네비게이션·캡처까지 여유(5분).
const NAVER_STATS_TIMEOUT_MS = 5 * 60_000;

/**
 * 고정 스크립트 실행 — shell:false(글로브·치환·체이닝 원천 차단), 인자는 전부 리터럴 argv,
 * 타임아웃 SIGKILL, abort 전파, 출력 하드캡. OPENAI_API_KEY 는 env 로만 주입(로그 비노출).
 */
function runScript(
  script: string, args: string[], cwd: string, signal?: AbortSignal,
  opts?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<BlogSkillResult> {
  return new Promise((resolve) => {
    if (!CONFIG.blogPython) {
      resolve({ ok: false, output: '(블로그 스킬 비활성 — BLOG_PYTHON 미설정)' }); return;
    }
    const scriptPath = path.join(CONFIG.blogScriptsDir, script);
    if (!fs.existsSync(CONFIG.blogPython) || !fs.existsSync(scriptPath)) {
      resolve({ ok: false, output: `(스크립트/인터프리터 없음: ${CONFIG.blogPython} · ${scriptPath})` }); return;
    }
    if (signal?.aborted) { resolve({ ok: false, output: '(취소됨)' }); return; }
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(opts?.env ?? {}) };
    if (CONFIG.openaiApiKey) childEnv.OPENAI_API_KEY = CONFIG.openaiApiKey;
    childEnv.OPENAI_IMAGE_MODEL = CONFIG.openaiImageModel;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CONFIG.blogPython, [scriptPath, ...args], { shell: false, cwd, signal, env: childEnv });
    } catch (e) {
      resolve({ ok: false, output: `(실행 실패: ${e instanceof Error ? e.message : String(e)})` }); return;
    }
    let out = '';
    let done = false;
    const finish = (r: BlogSkillResult): void => { if (!done) { done = true; resolve(r); } };
    const onData = (d: Buffer): void => { if (out.length < OUTPUT_CAP) out += d.toString('utf-8'); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 종료됨 */ } }, opts?.timeoutMs ?? BLOG_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      finish({ ok: false, output: e.name === 'AbortError' ? '(취소됨)' : `(실행 실패: ${e.message})` });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const body = out.slice(0, OUTPUT_CAP).trim();
      finish({ ok: code === 0, output: (body || '(출력 없음)') + (code ? `\n(exit ${code})` : '') });
    });
  });
}

// ============================== image_generate ==============================

export interface ImagePayload {
  /** 통째 draft JSON(BlogDraft, imageSlots 포함) — 있으면 --draft 로 전달. */
  draftJson?: string;
  /** 마크다운 본문/주제([IMAGE:] 마커 파싱) — --content 로 전달. */
  content?: string;
  businessType?: string;
  imageStyle: string;
  topic?: string;
  limit: number;
}

/** 툴 arg(JSON 또는 평문) → 구조화 페이로드. 순수 함수(부작용 없음) — 단위 테스트 대상. */
export function parseImagePayload(arg: string): ImagePayload {
  let o: Record<string, unknown> = {};
  const t = (arg || '').trim();
  if (t.startsWith('{')) {
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { o = { content: t }; }
  } else {
    o = { content: t };
  }
  const n = Number(o.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 8) : 4; // 무효·음수·0 → 기본 4, 상한 8
  const p: ImagePayload = {
    businessType: o.business_type ? String(o.business_type) : undefined,
    imageStyle: String(o.image_style ?? 'photorealistic'),
    topic: o.topic ? String(o.topic) : undefined,
    limit,
  };
  if (Array.isArray(o.imageSlots)) p.draftJson = t;             // 통째 BlogDraft
  else p.content = String(o.content ?? o.body ?? o.draft ?? t);
  return p;
}

/** 페이로드를 샌드박스 파일로 기록하고 openai_image.py argv 를 만든다(경로 인자는 전부 샌드박스 고정). */
function buildImageArgs(p: ImagePayload, cwd: string): string[] {
  const args = ['--output-dir', path.join(cwd, 'images'), '--manifest', path.join(cwd, 'image_manifest.json')];
  if (p.draftJson) {
    const df = path.join(cwd, 'draft.json');
    fs.writeFileSync(df, p.draftJson, 'utf-8');
    args.push('--draft', df);
  } else if (p.content) {
    const cf = path.join(cwd, 'draft_for_images.txt');
    fs.writeFileSync(cf, p.content, 'utf-8');
    args.push('--content', cf);
  }
  if (p.businessType) args.push('--business-type', p.businessType);
  args.push('--image-style', p.imageStyle);
  if (p.topic) args.push('--topic', p.topic);
  args.push('--limit', String(p.limit));
  if (!CONFIG.openaiApiKey) args.push('--dry-run'); // 키 없으면 계획만(파이프라인 차단 방지)
  return args;
}

/** image_generate 툴 실행 — 모델 arg 로 이미지 생성. 샌드박스(data/agents/<id>/workspace)에 산출. */
export async function runImageGenerate(roleId: string, arg: string, signal?: AbortSignal): Promise<string> {
  const cwd = sandboxDir(roleId);
  const args = buildImageArgs(parseImagePayload(arg), cwd);
  const r = await runScript('openai_image.py', args, cwd, signal);
  return r.output;
}

/**
 * finalize 훅용 — 완성 초안(draft.json)에서 직접 이미지 생성(모델 툴콜 경유 X, 신뢰 경로).
 * outDir 에 이미지, manifestPath 에 매니페스트를 쓴다.
 */
export async function generateImagesForDraft(
  draftJsonPath: string, outDir: string, manifestPath: string,
  opts: { businessType?: string; imageStyle?: string; topic?: string; limit?: number; timeoutMs?: number; refImages?: readonly string[]; allowText?: boolean; size?: string } = {},
  signal?: AbortSignal,
): Promise<BlogSkillResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 4), 8);
  const args = ['--draft', draftJsonPath, '--output-dir', outDir, '--manifest', manifestPath,
    '--image-style', opts.imageStyle ?? 'photorealistic',
    '--limit', String(limit)];
  if (opts.allowText) args.push('--allow-text'); // 카드뉴스 완성 카드 — 명시 문구 렌더링 허용
  if (opts.size) args.push('--size', opts.size); // 숏폼 세로형(1024x1536) 등 — 미지정 시 스크립트 기본 1024x1024
  if (opts.businessType) args.push('--business-type', opts.businessType);
  if (opts.topic) args.push('--topic', opts.topic);
  // 레퍼런스 참조 생성(images.edit) — 존재 파일만 전달(캡 4장은 스크립트가 재검증). 스타일 트렌드 반영용.
  const refs = (opts.refImages ?? []).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (refs.length) args.push('--ref-images', ...refs);
  if (!CONFIG.openaiApiKey) args.push('--dry-run');
  // finalize 는 세션 dir 를 cwd 로(샌드박스 무관 — 경로는 인자로 절대지정).
  // 타임아웃은 장수 비례 — 고품질 1장에 ~1분이라 기본 3분은 5장에서 SIGKILL 됐다(카드뉴스 E2E 실측).
  const timeoutMs = opts.timeoutMs ?? Math.max(BLOG_TIMEOUT_MS, 90_000 * limit);
  return runScript('openai_image.py', args, path.dirname(manifestPath), signal, { timeoutMs });
}

/**
 * 카드뉴스 레퍼런스 검색 — cardnews_search.py(DuckDuckGo 이미지 검색·다운로드·Pillow 검증).
 * 검색 실패·0장은 무해(빈 매니페스트, exit 0) — 호출부는 레퍼런스 없이 기존 경로로 진행(fail-open).
 */
export async function searchCardRefs(
  query: string, outDir: string, manifestPath: string, num = 5, signal?: AbortSignal,
): Promise<BlogSkillResult> {
  return runScript('cardnews_search.py',
    ['--query', query, '--num', String(Math.min(Math.max(1, num), 8)), '--output-dir', outDir, '--manifest', manifestPath],
    path.dirname(manifestPath), signal, { timeoutMs: 90_000 });
}

/**
 * 카드뉴스 텍스트 렌더 — cardnews_render.py(배경 PNG 위 Pillow 한글 오버레이).
 * 배경 매니페스트가 비어도 스크립트가 그라데이션 폴백으로 전 장을 렌더한다(fail-open).
 */
export async function renderCardSlides(
  planPath: string, backgroundsPath: string, outDir: string, manifestPath: string,
  signal?: AbortSignal,
): Promise<BlogSkillResult> {
  return runScript('cardnews_render.py',
    ['--plan', planPath, '--backgrounds', backgroundsPath, '--output-dir', outDir, '--manifest', manifestPath],
    path.dirname(manifestPath), signal, { timeoutMs: 120_000 });
}

// ============================== blog_publish ==============================

export interface PublishPayload {
  /** 05_final_content.json 인라인 객체(smarteditor_text.sections/image_positions·tags) 또는 JSON 문자열. */
  finalContent?: unknown;
  /** BlogDraft(bodyMarkdown 등) — final_content 가 없으면 어댑터(draftToFinalContent)로 변환한다. */
  draft?: unknown;
  /** 06_image_manifest.json 인라인 객체({images:[{file_path}]}). */
  imageManifest?: unknown;
  dryRun: boolean;
}

/** 툴 arg → 발행 페이로드. 순수 함수 — 단위 테스트 대상. */
export function parsePublishPayload(arg: string): PublishPayload {
  let o: Record<string, unknown> = {};
  const t = (arg || '').trim();
  if (t.startsWith('{')) { try { o = JSON.parse(t) as Record<string, unknown>; } catch { o = {}; } }
  return {
    finalContent: o.final_content ?? o.finalContent,
    // draft 필드 또는 통째 BlogDraft(bodyMarkdown 최상위) 둘 다 수용.
    draft: o.draft ?? (typeof o.bodyMarkdown === 'string' ? o : undefined),
    imageManifest: o.image_manifest ?? o.imageManifest,
    dryRun: o.dry_run === true || o.dryRun === true,
  };
}

/**
 * 모델 제공 매니페스트의 이미지 file_path 를 샌드박스 하위로만 제한한다(보안 — 임의 로컬 파일이 네이버 초안으로
 * 업로드·유출되는 것 차단). run_command 의 경로 컨테인먼트(절대/상위 경로 거부)와 image_generate 의 샌드박스-전용
 * 출력과 동일한 방어. 샌드박스 밖·비문자열 file_path 는 드롭한다. 순수 함수 — 단위 테스트 대상.
 */
export function containImageManifest(
  manifest: unknown, sandbox: string,
): { manifest: Record<string, unknown>; dropped: number } {
  const src = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>) : {};
  const imgs = Array.isArray(src.images) ? src.images : [];
  const root = path.resolve(sandbox) + path.sep;
  let dropped = 0;
  const images = imgs.filter((it) => {
    const fp = it && typeof it === 'object' ? (it as Record<string, unknown>).file_path : undefined;
    if (typeof fp !== 'string' || !fp) { dropped++; return false; }
    const resolved = path.resolve(fp);
    const inside = resolved === path.resolve(sandbox) || (resolved + path.sep).startsWith(root);
    if (!inside) dropped++;
    return inside;
  });
  return { manifest: { ...src, images }, dropped };
}

/**
 * blog_publish 툴 실행 — 네이버 SmartEditor 임시저장(draft). **발행 버튼은 누르지 않는다.**
 * final_content(smarteditor_text 스키마)를 직접 받거나, BlogDraft(bodyMarkdown)를 받으면
 * 어댑터(draftToFinalContent)로 변환한다. 업로드 이미지는 샌드박스 하위 경로만 허용(containImageManifest).
 */
export async function runBlogPublish(roleId: string, arg: string, signal?: AbortSignal): Promise<string> {
  const p = parsePublishPayload(arg);
  if (!p.finalContent) {
    const d = coerceBlogDraft(p.draft);
    if (d) p.finalContent = draftToFinalContent(d);
  }
  if (!p.finalContent) {
    return '(blog_publish: final_content 또는 draft(BlogDraft, bodyMarkdown 포함) 필요 — '
      + '{"final_content":{smarteditor_text:{title,sections,image_positions},tags}} 또는 '
      + '{"draft":{...BlogDraft}, "image_manifest":{images:[{file_path}]}} 형태로 전달하세요.)';
  }
  const cwd = sandboxDir(roleId);
  const finalPath = path.join(cwd, '05_final_content.json');
  const manifestPath = path.join(cwd, '06_image_manifest.json');
  // 업로드 이미지는 샌드박스 하위 경로만 허용 — 모델이 임의 파일경로를 넣어도 유출 불가.
  const { manifest: safeManifest, dropped } = containImageManifest(p.imageManifest ?? { images: [] }, cwd);
  fs.writeFileSync(finalPath, JSON.stringify(p.finalContent, null, 2), 'utf-8');
  fs.writeFileSync(manifestPath, JSON.stringify(safeManifest, null, 2), 'utf-8');
  const hasSession = !!CONFIG.naverSessionFile && fs.existsSync(CONFIG.naverSessionFile);
  const args = ['--final-content', finalPath, '--image-manifest', manifestPath, '--run-dir', cwd];
  if (CONFIG.naverSessionFile) args.push('--session-file', CONFIG.naverSessionFile);
  args.push('--headless');
  if (p.dryRun || !hasSession) args.push('--dry-run'); // 세션 없으면 실제 접속 안 함
  const r = await runScript('naver_publish.py', args, cwd, signal);
  const note = dropped ? `\n(주의: 샌드박스 밖 이미지 ${dropped}건 제외 — 업로드 이미지는 샌드박스 하위만 허용)` : '';
  return r.output + note;
}

// ====================== 검토 탭 네이버 임시저장(신뢰 경로) ======================

export interface NaverDraftResult {
  ok: boolean;
  /** DRAFT_SAVED | PARTIAL | FAILED | (실행 실패 시) ERROR */
  status: string;
  draftUrl?: string;
  adminUrl?: string;
  /**
   * 비공개 발행 성공 여부(2026-08-28) — 파이썬 기본 모드는 'private_publish'(NAVER_PUBLISH_MODE)로,
   * 발행 레이어에서 태그를 넣고 **비공개로 실제 발행**한다. 그러면 postwrite 가 아니라 진짜 글 주소
   * (logNo=…)가 나온다. 종전엔 이 필드를 파싱하지 않아 그 URL 이 naverDraftUrl 로만 들어갔고,
   * publishedUrl 은 계속 비어 파생물 캡션의 원본 블로그 링크가 붙지 않았다(사용자 제보).
   * 임시저장 폴백(비공개 확인 실패·예외)이면 false — 그때 URL 은 postwrite 라 링크로 쓰면 안 된다.
   */
  privatePublished: boolean;
  issues: string[];
  /** 스크립트 stdout/stderr(캡) — 실패 원인 표시용. */
  output: string;
}

/**
 * 발행 자격증명 — 활성 브랜드 기준으로 계정을 해석한다(브랜드별 네이버 계정 분리).
 * 범용(브랜드 미설정)은 기존 평면 키(NAVER_BLOG_ID/…), 브랜드는 NAVER_ACCOUNTS[slug].
 * .env 편집(API 키 탭) 후 재시작 없이 반영되도록 store 가 .env 를 라이브로 읽는다.
 */
export function naverPublishCreds(slug: string = activeBrandSlug()): { blogId: string; loginId: string; loginPw: string; headless: boolean } {
  const acct = getNaverAccount(slug);
  return {
    blogId: acct.blogId,
    loginId: acct.loginId,
    loginPw: acct.loginPw,
    headless: (process.env.NAVER_PUBLISH_HEADLESS ?? '').trim() === 'true',
  };
}

/**
 * 활성 브랜드 기준 네이버 Chrome 프로필 dir(로그인 쿠키가 사는 곳) — 브랜드마다 자기 채널로
 * 로그인 상태를 격리한다. 범용('')은 '' 를 반환해 python 기본(~/.naver-blog-profiles/cli)을 유지.
 */
function naverProfileDir(slug: string): string {
  assertSafeSlug(slug);
  return slug ? path.join(os.homedir(), '.naver-blog-profiles', slug) : '';
}

/** 네이버 런 뒤 브라우저 캐시만 정리 — 로그인 세션(쿠키·로컬스토리지·Preferences)은 절대 건드리지 않는다.
 *  배경(실측 2026-08-01): 조회수 수집이 매번 크롬을 띄우는데 프로필 캐시가 하루 ~87MB 씩 쌓여
 *  bionditree 프로필이 927MB(99%가 캐시)까지 커졌고, 디스크 포화 사고의 한 축이었다.
 *  프로세스 종료 뒤에 지우므로 파일 잠금·손상 위험이 없다. 캐시는 다음 실행 때 크롬이 재생성한다. */
function pruneNaverProfileCache(profileDir: string): void {
  if (!profileDir) profileDir = path.join(os.homedir(), '.naver-blog-profiles', 'cli'); // 범용 기본 프로필
  const rm = (p: string): void => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 무해 */ } };
  const D = path.join(profileDir, 'Default');
  for (const rel of ['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache',
    'ShaderCache', 'GrShaderCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache']) rm(path.join(D, rel));
  for (const rel of ['GraphiteDawnCache', 'ShaderCache', 'GrShaderCache', 'BrowserMetrics',
    'component_crx_cache', 'BrowserMetrics-spare.pma']) rm(path.join(profileDir, rel));
}
/** 활성 브랜드 기준 세션 파일 — 범용은 기존 CONFIG.naverSessionFile, 브랜드는 형제 경로에 -<slug>. */
function naverSessionFileFor(slug: string): string {
  assertSafeSlug(slug);
  const base = CONFIG.naverSessionFile;
  if (!slug || !base) return base;
  return path.join(path.dirname(base), `.naver_session-${slug}.json`);
}
/**
 * FS 경계 자체 방어(defense-in-depth) — 슬러그를 프로필 dir·세션 파일명에 그대로 끼워 넣기 전에
 * isSafeBrandSlug([\p{L}\p{N}-], 구분자·점 없음)로 재검증한다. 현재 호출부(activeBrandSlug/piece.brand,
 * 저장 엔드포인트)는 항상 검증된 슬러그만 넘기므로 이 경로는 정상 동작에서 도달하지 않지만, 미래에
 * 미검증 슬러그를 넘기는 코드가 생겨도 경로 탈출(path traversal)이 불가능하도록 여기서 막는다.
 */
function assertSafeSlug(slug: string): void {
  if (slug && !isSafeBrandSlug(slug)) throw new Error(`무효한 브랜드 슬러그(파일경로 차단): ${slug}`);
}

/**
 * 완성 초안(세션 dir 의 BlogDraft)을 네이버 블로그에 **임시저장**한다 — 검토 탭 버튼의 신뢰 경로
 * (사용자 클릭 = 승인이므로 모델 툴 게이트와 별개). 발행 버튼은 누르지 않는다(발행은 사람이 네이버에서).
 *
 * - 이미지: 세션 image_manifest.json 을 세션 dir 하위·실존 파일로 제한해 업로드(없으면 텍스트만).
 * - 브라우저: 기본 headful(최초 로그인·캡차를 사람이 처리) — NAVER_PUBLISH_HEADLESS=true 로 무헤드 옵트인.
 * - 로그인: 영속 프로필(~/.naver-blog-profiles/cli) 재사용, 자격증명(NAVER_LOGIN_ID/PW)은 자동입력 보조일 뿐
 *   없어도 열린 브라우저에서 직접 로그인하면 된다(최대 10분 대기, 전체 타임아웃 15분).
 */
export async function publishDraftToNaver(
  sessionDir: string, draft: BlogDraft, opts: { dryRun?: boolean; brand?: string } = {}, signal?: AbortSignal,
): Promise<NaverDraftResult> {
  // 발행 대상 브랜드 = piece 의 브랜드(호출부가 명시). 미지정이면 활성 브랜드(대화형 검토 탭 경로).
  const slug = opts.brand ?? activeBrandSlug();
  if (slug && !isSafeBrandSlug(slug)) {
    return { ok: false, status: 'ERROR', privatePublished: false, issues: [`무효한 브랜드 슬러그: ${slug}`], output: '' };
  }
  const creds = naverPublishCreds(slug);
  const dryRun = opts.dryRun === true;
  if (!dryRun && !creds.blogId) {
    const where = slug ? `브랜드 '${slug}' 의 ` : '';
    return { ok: false, status: 'ERROR', privatePublished: false, issues: [`${where}네이버 블로그 ID 미설정 — API 키 탭에서 이 브랜드의 발행 계정을 설정하세요.`], output: '' };
  }
  const finalContent = draftToFinalContent(draft);

  // 세션 이미지 매니페스트 — 세션 dir 하위 + 실존 파일만(finalize 산출 외 임의 경로 차단).
  // file_path 는 생성 시점 절대경로라 데이터 dir 이동 시 깨진다 — 세션 내 images/<filename> 사본을 우선.
  let manifest: Record<string, unknown> = { images: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'image_manifest.json'), 'utf-8')) as unknown;
    const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const norm = (Array.isArray(src.images) ? src.images : []).map((it) => {
      if (!it || typeof it !== 'object') return it;
      const o = { ...(it as Record<string, unknown>) };
      const local = typeof o.filename === 'string' && o.filename
        ? path.join(sessionDir, 'images', path.basename(o.filename)) : '';
      if (local && fs.existsSync(local)) o.file_path = local;
      return o;
    });
    manifest = containImageManifest({ ...src, images: norm }, sessionDir).manifest;
    manifest.images = (manifest.images as Array<Record<string, unknown>>).filter(
      (im) => typeof im.file_path === 'string' && fs.existsSync(im.file_path),
    );
  } catch { /* 이미지 없는 초안 — 텍스트만 저장 */ }

  const finalPath = path.join(sessionDir, '05_final_content.json');
  const manifestPath = path.join(sessionDir, '06_image_manifest.json');
  try {
    fs.writeFileSync(finalPath, JSON.stringify(finalContent, null, 2), 'utf-8');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (e) {
    return { ok: false, status: 'ERROR', privatePublished: false, issues: [`발행 페이로드 기록 실패: ${e instanceof Error ? e.message : String(e)}`], output: '' };
  }

  // 이전 런의 결과 파일이 남아 있으면 이번 런 실패 시 낡은 성공으로 오판 — 실행 전 제거.
  const resultPath = path.join(sessionDir, '07_publish_result.json');
  try { fs.rmSync(resultPath, { force: true }); } catch { /* 없음 */ }

  // 브랜드별 세션·프로필 격리 — 브랜드마다 자기 네이버 계정/쿠키로 발행(계정 섞임 차단). slug 는 위에서 해석.
  const sessionFile = naverSessionFileFor(slug);
  const profileDir = naverProfileDir(slug);
  const args = ['--final-content', finalPath, '--image-manifest', manifestPath, '--run-dir', sessionDir];
  if (sessionFile) args.push('--session-file', sessionFile);
  if (creds.headless) args.push('--headless');
  if (dryRun) args.push('--dry-run');

  const env: Record<string, string> = {};
  if (creds.blogId) env.NAVER_BLOG_ID = creds.blogId;
  if (creds.loginId) env.NAVER_ID = creds.loginId;   // naver_publish.py 가 읽는 이름으로 매핑
  if (creds.loginPw) env.NAVER_PW = creds.loginPw;
  if (profileDir) env.NAVER_PROFILE_DIR = profileDir; // 미설정(범용)이면 python 기본 프로필(cli) 유지

  const r = await runScript('naver_publish.py', args, sessionDir, signal, { timeoutMs: NAVER_PUBLISH_TIMEOUT_MS, env });
  pruneNaverProfileCache(profileDir); // 캐시만 정리(세션 보존) — 프로필 무한 증식 차단

  // 스크립트가 남긴 구조화 결과(07_publish_result.json)가 stdout 보다 신뢰도 높다.
  try {
    const res = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
    const status = String(res.status ?? 'FAILED');
    return {
      ok: status === 'DRAFT_SAVED' || status === 'PARTIAL',
      status,
      draftUrl: typeof res.draft_url === 'string' && res.draft_url ? res.draft_url : undefined,
      adminUrl: typeof res.admin_url === 'string' && res.admin_url ? res.admin_url : undefined,
      privatePublished: res.publish_mode === 'private_published',
      issues: Array.isArray(res.issues) ? res.issues.map(String) : [],
      output: r.output,
    };
  } catch {
    return { ok: false, status: 'ERROR', privatePublished: false, issues: ['발행 결과 파일 없음 — 스크립트 출력 참조'], output: r.output };
  }
}

// ====================== 성과 자동 수집(네이버 통계 스크레이프) ======================

export interface CollectedMetrics {
  ok: boolean;
  views: number;
  dwellSec?: number;
  searchInflow: Array<{ keyword: string; count: number; rank?: number }>;
  source: string;
  /** 수집기가 남긴 안내(로그인 필요·자동추출 실패 등) — UI 표시용. */
  note?: string;
  captured?: number;
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; }

/** naver_stats.py 의 `RESULT_JSON: {...}` 줄을 파싱해 수집 결과로 정규화. 순수 함수 — 단위 테스트 대상. */
export function parseStatsOutput(output: string): CollectedMetrics | null {
  const line = output.split('\n').reverse().find((l) => l.trim().startsWith('RESULT_JSON:'));
  if (!line) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>; } catch { return null; }
  const inflow = Array.isArray(o.searchInflow)
    ? (o.searchInflow as unknown[]).flatMap((it) => {
        if (!it || typeof it !== 'object') return [];
        const r = it as Record<string, unknown>;
        const keyword = String(r.keyword ?? '').trim();
        if (!keyword) return [];
        const rank = r.rank != null ? num(r.rank) : undefined;
        return [{ keyword, count: num(r.count), ...(rank ? { rank } : {}) }];
      })
    : [];
  const dwell = o.dwellSec != null ? num(o.dwellSec) : undefined;
  return {
    ok: true,
    views: num(o.views),
    ...(dwell ? { dwellSec: dwell } : {}),
    searchInflow: inflow,
    source: String(o.source ?? 'scrape:naver_advisor'),
    note: o.note ? String(o.note) : undefined,
    captured: o.captured != null ? num(o.captured) : undefined,
  };
}

/**
 * 발행된 글 URL 의 성과(조회수·검색 유입 키워드)를 네이버에서 수집한다.
 * 영속 프로필(발행 때 만든 로그인 세션) 재사용 — 미로그인이면 note 로 안내하고 빈 결과(fail-open).
 * runDir 에 캡처 원본(naver_stats_capture.json)을 남겨 추출기 정밀화에 쓴다.
 */
export async function collectNaverMetrics(
  publishedUrl: string, runDir: string, opts: { dryRun?: boolean; brand?: string } = {}, signal?: AbortSignal,
): Promise<CollectedMetrics | null> {
  try { fs.mkdirSync(runDir, { recursive: true }); } catch { /* 무해 */ }
  // 이 글의 브랜드 계정/프로필로 통계 조회 — 미지정이면 활성 브랜드. 브랜드마다 로그인 세션이 다르다.
  const slug = opts.brand ?? activeBrandSlug();
  if (slug && !isSafeBrandSlug(slug)) return null; // 무효 슬러그 = 수집 생략(fail-open)
  const args = ['--url', publishedUrl, '--run-dir', runDir];
  const creds = naverPublishCreds(slug);
  // 통계 수집은 헤드리스 기본(CONFIG.naverStatsHeadless) — 발행용 플래그(creds.headless)와 독립.
  if (CONFIG.naverStatsHeadless || creds.headless) args.push('--headless');
  if (opts.dryRun) args.push('--dry-run');
  // naver_stats.py 는 --session-file 을 받지 않는다(로그인 상태는 프로필로만) → NAVER_PROFILE_DIR 로 브랜드 분리.
  const profileDir = naverProfileDir(slug);
  const env: Record<string, string> = {};
  if (creds.loginId) env.NAVER_ID = creds.loginId;
  if (creds.loginPw) env.NAVER_PW = creds.loginPw;
  if (profileDir) env.NAVER_PROFILE_DIR = profileDir;
  const r = await runScript('naver_stats.py', args, runDir, signal, { timeoutMs: NAVER_STATS_TIMEOUT_MS, env });
  pruneNaverProfileCache(profileDir); // 캐시만 정리(세션 보존) — 일일 수집이 프로필을 키우던 주범
  return parseStatsOutput(r.output);
}
