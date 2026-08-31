/**
 * 시크릿(API 키) 저장소 — 값은 프로젝트 루트 `.env` 한 곳에만 저장한다(사용자 요청: 저장소 일원화).
 * 부팅 시 process.loadEnvFile() 이 같은 파일을 읽으므로 '.env = 단일 소스'. UI 편집은 파일을
 * 원자적으로 고쳐 쓰고(주석·다른 줄 보존, 0600) process.env 에도 미러링해 재시작 없이 반영한다.
 * data/secrets.json 은 메타데이터(사용자 키 정의 custom·숨긴 기본 키 hidden)만 남고, 과거 값은
 * 최초 접근 시 .env 로 1회 이관된다. 화면엔 항상 마스킹만 노출.
 * builtin 키(Anthropic/OpenAI/커넥터)는 정의가 코드에 있으므로 삭제 시 '숨김'(값 제거+카드 제거,
 * 복원 가능), 사용자 키는 추가·완전 삭제 가능.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { connectorKeyDefs } from '../grounding/registry'; // pure 모듈(순환 없음). 등록은 main 이 grounding 을 import 하며 수행.

const FILE = path.join(CONFIG.dataDir, 'secrets.json');           // 메타데이터(custom·hidden)만
const ENV_FILE = process.env.GEPA_ENV_FILE || path.resolve(process.cwd(), '.env'); // 값 저장소(단일)

export interface ApiKeyInfo {
  key: string; label: string; icon: string; desc: string;
  placeholder: string; needs_restart: boolean; set: boolean; masked: string; builtin: boolean;
  /** 커스텀 키의 소속 브랜드 슬러그('' = 공용). 내장 키는 앱 공용이라 없음. */
  brand?: string;
}
interface CustomDef { key: string; label: string; icon: string; desc: string; brand?: string }
interface Meta { custom: CustomDef[]; hidden: string[] }

interface BuiltinDef { key: string; label: string; icon: string; desc: string; placeholder: string; needs_restart: boolean }
const BUILTIN: BuiltinDef[] = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', icon: '🟣', desc: '미사용 — Claude 는 구독(claude CLI) 인증으로 호출됨', placeholder: 'sk-ant-…', needs_restart: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', icon: '🟢', desc: 'OpenAI 호환 백엔드(선택)', placeholder: 'sk-…', needs_restart: true },
  // 알림 채널(자율 사이클 완료·일일 브리핑) — 설정하면 자동 발송. 미설정이면 알림 no-op.
  { key: 'NOTIFY_WEBHOOK_URL', label: '알림 웹훅', icon: '🔔', desc: '자율 사이클·일일 브리핑을 POST 할 URL(Slack/Discord/커스텀)', placeholder: 'https://hooks.…', needs_restart: false },
  { key: 'TELEGRAM_BOT_TOKEN', label: '텔레그램 봇 토큰', icon: '📨', desc: '텔레그램 알림(봇 토큰 + 챗 ID 둘 다 설정 시 발송)', placeholder: '123456:ABC…', needs_restart: false },
  { key: 'TELEGRAM_CHAT_ID', label: '텔레그램 챗 ID', icon: '💬', desc: '알림을 받을 텔레그램 chat_id', placeholder: '123456789', needs_restart: false },
  // 유튜브 쇼츠 발행 — 공용 OAuth 클라이언트(웹) 1개. 브랜드별 채널 토큰은 YOUTUBE_TOKENS blob(스튜디오 '채널 연결').
  { key: 'YOUTUBE_OAUTH_CLIENT_ID', label: '유튜브 OAuth 클라이언트 ID', icon: '▶️', desc: '쇼츠 업로드용 공용 OAuth 클라이언트(웹) ID — 설정 가이드는 스펙 §9', placeholder: '….apps.googleusercontent.com', needs_restart: false },
  { key: 'YOUTUBE_OAUTH_CLIENT_SECRET', label: '유튜브 OAuth 시크릿', icon: '🔑', desc: '위 클라이언트의 Client Secret', placeholder: 'GOCSPX-…', needs_restart: false },
  // 메타(인스타·페북) 발행 — 공용 개발자 앱 1개. 브랜드별 페이지·IG 토큰은 META_TOKENS blob(스튜디오 '메타 연결').
  // 인스타그램 로그인 방식(2026-07-20 전환) — Instagram 제품의 앱 ID/시크릿(페북 앱과 별개). 이게 발행 연결에 쓰인다.
  { key: 'INSTAGRAM_APP_ID', label: '인스타그램 앱 ID', icon: '📸', desc: '메타 앱 > Instagram 제품 > API 설정(Instagram 로그인)의 앱 ID — 릴스·카드뉴스 인스타 발행 연결용', placeholder: '1234567890', needs_restart: true },
  { key: 'INSTAGRAM_APP_SECRET', label: '인스타그램 앱 시크릿', icon: '🔑', desc: '위 Instagram 앱의 App Secret', placeholder: 'abc123…', needs_restart: true },
  // 페이스북 페이지 발행(선택) — 인스타 앱 ID 와 다른 '메타 앱' 자체의 ID/시크릿(설정 > 기본 설정).
  // 페이스북 로그인으로 페이지 액세스 토큰을 받아 페이지 피드·릴스에 게시한다(인스타 연결과 독립·병행).
  { key: 'META_APP_ID', label: '메타 앱 ID (페북 페이지용)', icon: '📘', desc: '메타 앱 > 설정 > 기본 설정의 앱 ID — 페이스북 페이지 발행 연결용(인스타 앱 ID 와 다름)', placeholder: '1234567890123456', needs_restart: true },
  { key: 'META_APP_SECRET', label: '메타 앱 시크릿 (페북 페이지용)', icon: '🔑', desc: '위 메타 앱의 App Secret', placeholder: 'abc123…', needs_restart: true },
  // 네이버 발행 계정(블로그 ID·로그인)은 브랜드별로 갈리므로 일반 키 그리드가 아니라 전용
  // "네이버 발행 계정" 섹션(브랜드 선택)에서 관리한다 — get/setNaverAccount·naverAccountView.
  // 범용('') 계정은 여전히 평면 키(NAVER_BLOG_ID/NAVER_LOGIN_ID/NAVER_LOGIN_PW)에 저장된다.
  // 법령(LAW)·DART 등 외부 데이터 소스 키는 그라운딩 커넥터(grounding/)가 선언 → connectorKeyDefs 로 합류.
];
// 커넥터가 선언한 키도 '내장 키'처럼 다룬다(값 편집만, 삭제=숨김, 설정 시 자동 연동).
const connDefs = (): BuiltinDef[] =>
  connectorKeyDefs().map((d) => ({ key: d.key, label: d.label, icon: d.icon, desc: d.desc, placeholder: d.placeholder, needs_restart: false }));
const builtinDefs = (): BuiltinDef[] => [...BUILTIN, ...connDefs()];
const isBuiltinKey = (k: string): boolean => builtinDefs().some((b) => b.key === k);

// ── .env 파싱/편집 (순수 텍스트 변환 — 테스트 대상) ─────────────────────────
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** .env 텍스트 → 값 맵. 주석 무시, 따옴표 제거, 같은 키 중복 시 마지막 값. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = ENV_LINE.exec(line);
    const k = m?.[1], raw = m?.[2];
    if (!k || raw === undefined) continue;
    let v = raw.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      // 이중따옴표만 이스케이프 해제(작성 시 quoteEnv 와 대칭)
      if (dq) v = v.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    out[k] = v;
  }
  return out;
}
function quoteEnv(v: string): string {
  return /[\s#'"\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}
/**
 * .env 텍스트에서 key 라인을 교체/삭제/추가한 새 텍스트 반환(순수).
 * 주석·다른 키·빈 줄은 그대로 보존. 같은 키 중복 라인은 하나로 정리.
 * value === undefined → 해당 키 라인 제거.
 */
export function upsertEnvText(text: string, key: string, value: string | undefined): string {
  const lines = text.length ? text.split(/\r?\n/) : [];
  const kept: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (m?.[1] === key && !/^\s*#/.test(line)) {
      if (value !== undefined && !replaced) { kept.push(`${key}=${quoteEnv(value)}`); replaced = true; }
      continue; // 삭제 대상 또는 중복 라인 스킵
    }
    kept.push(line);
  }
  if (value !== undefined && !replaced) {
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    kept.push(`${key}=${quoteEnv(value)}`);
  }
  return kept.join('\n').replace(/\n*$/, '\n');
}

function readEnvValues(): Record<string, string> {
  try { return parseEnvText(fs.readFileSync(ENV_FILE, 'utf-8')); } catch { return {}; }
}
/** .env 원자적 갱신(0600) + process.env 미러링(부팅 loadEnvFile 값이 낡지 않게 즉시 반영). */
function writeEnvValue(key: string, value: string | undefined): void {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf-8'); } catch { /* 새 파일 */ }
  const tmp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(tmp, upsertEnvText(text, key, value), { mode: 0o600 });
  fs.renameSync(tmp, ENV_FILE);
  if (value !== undefined) process.env[key] = value;
  else delete process.env[key];
}

// ── 메타데이터(secrets.json) — 레거시 values 는 최초 접근 시 .env 로 1회 이관 ──
function writeMeta(m: Meta): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(m, null, 2), { mode: 0o600 });
}
function readMeta(): Meta {
  let raw: Partial<Meta> & { values?: Record<string, string> };
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Partial<Meta> & { values?: Record<string, string> }; }
  catch { raw = {}; }
  const meta: Meta = { custom: raw.custom ?? [], hidden: raw.hidden ?? [] };
  if (raw.values) {                                   // 레거시(이전 저장소) — .env 에 없는 값만 이관 후 제거
    const cur = readEnvValues();
    for (const [k, v] of Object.entries(raw.values)) if (v && !(k in cur)) writeEnvValue(k, v);
    writeMeta(meta);
  }
  return meta;
}

/** 항상 마스킹 — 앞 4 + 점 + 뒤 4. 짧으면 전부 가림. */
export function maskSecret(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(Math.max(4, v.length));
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}
/** 사람 비밀번호류 키 — 앞4+뒤4 부분노출(maskSecret)도 과다해 전체 마스킹한다(길이도 숨김). */
const FULL_MASK_KEY = /(_PW|_PASSWORD|PASSWORD)$/;
export function maskFor(key: string, v: string): string {
  if (!v) return '';
  return FULL_MASK_KEY.test(key) ? '••••••••' : maskSecret(v);
}
function validKeyName(k: string): boolean { return /^[A-Z][A-Z0-9_]{1,48}$/.test(k); }

export function listKeys(): ApiKeyInfo[] {
  const meta = readMeta();
  const vals = readEnvValues();
  // 표시값 = 런타임(getSecret)과 동일 우선순위: .env 파일 → 실제 환경변수(셸 export 등)
  const val = (k: string): string => vals[k] ?? process.env[k] ?? '';
  const builtin: ApiKeyInfo[] = builtinDefs()
    .filter((b) => !meta.hidden.includes(b.key))
    .map((b) => ({ ...b, set: !!val(b.key), masked: maskFor(b.key, val(b.key)), builtin: true }));
  const custom: ApiKeyInfo[] = meta.custom.map((c) => ({
    key: c.key, label: c.label || c.key, icon: c.icon || '🔑', desc: c.desc || '사용자 정의 키',
    placeholder: '값 입력…', needs_restart: false, set: !!val(c.key), masked: maskFor(c.key, val(c.key)), builtin: false,
    brand: c.brand ?? '', // 레거시(브랜드 도입 전) 정의는 공용
  }));
  return [...builtin, ...custom];
}
export function setKey(key: string, value: string): { ok: boolean; error?: string } {
  const meta = readMeta();
  if (!isBuiltinKey(key) && !meta.custom.some((c) => c.key === key)) return { ok: false, error: '알 수 없는 키입니다.' };
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: '값이 비었습니다.' };
  // 개행·제어문자 거부 — 값에 '\nOTHER_KEY=evil' 을 넣어 .env 에 임의 env 라인을 주입하는 것 차단(보안점검).
  if (/[\x00-\x1f]/.test(value)) return { ok: false, error: '값에 줄바꿈·제어문자를 넣을 수 없습니다.' };
  writeEnvValue(key, value.trim());
  return { ok: true };
}
export function addCustom(key: string, label: string, icon: string, value: string, brand = ''): { ok: boolean; error?: string } {
  if (!validKeyName(key)) return { ok: false, error: '키 이름은 대문자·숫자·밑줄만 가능합니다(예: MY_API_KEY).' };
  if (isBuiltinKey(key)) return { ok: false, error: '기본 키와 중복됩니다.' };
  const meta = readMeta();
  const existing = meta.custom.find((c) => c.key === key);
  // 값은 .env 평면 키(브랜드 무관 단일 이름)라, 다른 브랜드의 동명 추가를 허용하면 그 브랜드
  // 값을 조용히 덮어쓰게 된다 — 격리 원칙대로 충돌로 거부(같은 브랜드 재추가만 값 갱신).
  if (existing && (existing.brand ?? '') !== brand) {
    return { ok: false, error: `이미 ${existing.brand ? `'${existing.brand}' 브랜드` : '공용'}에 있는 키 이름입니다. 다른 이름을 쓰세요.` };
  }
  if (!existing) meta.custom.push({ key, label: label || key, icon: icon || '🔑', desc: '사용자 정의 키', ...(brand ? { brand } : {}) });
  writeMeta(meta);
  if (value && value.trim()) writeEnvValue(key, value.trim());
  return { ok: true };
}
/** 카드 삭제 — 사용자 키는 완전 제거, 기본 키는 값 제거 + 숨김(restoreKey 로 복원 가능). */
export function deleteKey(key: string): { ok: boolean; error?: string } {
  const meta = readMeta();
  if (isBuiltinKey(key)) {
    if (!meta.hidden.includes(key)) meta.hidden.push(key);
  } else {
    if (!meta.custom.some((c) => c.key === key)) return { ok: false, error: '알 수 없는 키입니다.' };
    meta.custom = meta.custom.filter((c) => c.key !== key);
  }
  writeMeta(meta);
  writeEnvValue(key, undefined);
  return { ok: true };
}
/**
 * 브랜드 삭제 동반 정리 — 그 브랜드의 커스텀 키 정의·.env 값을 함께 제거한다(개수 반환).
 * 남기면 선택자에 없는 브랜드라 카드 도달 불가 + addCustom 동명 가드가 죽은 브랜드를 근거로
 * 영구 거부 + 값이 process.env 로 전역 주입되는 고아가 된다. 빈 슬러그는 no-op(공용 보호).
 */
export function purgeCustomKeysForBrand(slug: string): number {
  if (!slug) return 0;
  const meta = readMeta();
  const doomed = meta.custom.filter((c) => (c.brand ?? '') === slug);
  if (!doomed.length) return 0;
  meta.custom = meta.custom.filter((c) => (c.brand ?? '') !== slug);
  writeMeta(meta);
  for (const c of doomed) writeEnvValue(c.key, undefined);
  return doomed.length;
}
/** 숨긴 기본 키 목록(복원 UI 용) — 커넥터 제거 등으로 정의가 사라진 키는 제외. */
export function hiddenKeys(): { key: string; label: string; icon: string }[] {
  const meta = readMeta();
  return builtinDefs()
    .filter((b) => meta.hidden.includes(b.key))
    .map((b) => ({ key: b.key, label: b.label, icon: b.icon }));
}
/** 숨긴 기본 키 복원 — 카드가 '미설정' 상태로 다시 나타난다(값은 다시 입력). */
export function restoreKey(key: string): { ok: boolean; error?: string } {
  const meta = readMeta();
  if (!meta.hidden.includes(key)) return { ok: false, error: '숨긴 키가 아닙니다.' };
  meta.hidden = meta.hidden.filter((k) => k !== key);
  writeMeta(meta);
  return { ok: true };
}
/** 런타임 시크릿 조회(LLM 클라이언트 등) — .env 파일(단일 저장소) 우선, 실제 환경변수 폴백. */
export function getSecret(key: string): string | undefined {
  return readEnvValues()[key] || process.env[key] || undefined;
}

// ── 브랜드별 네이버 발행 계정 ────────────────────────────────────────────────
// 브랜드마다 다른 네이버 블로그로 임시저장/발행하려면 자격증명이 브랜드별로 갈려야 한다.
// 슬러그가 한글일 수 있어 env 키 이름에 직접 못 박으므로, 브랜드 계정은 NAVER_ACCOUNTS
// 한 키에 JSON({"<slug>":{blogId,loginId,loginPw}})으로 담는다(.env 단일 저장소 유지).
// 범용('')은 기존 평면 키(NAVER_BLOG_ID/…)를 그대로 써 하위호환·기존 동작 불변.
// 브랜드는 폴백하지 않는다 — 미설정 브랜드는 빈 계정(발행 시 명확히 에러) → 계정 섞임 원천 차단.
export interface NaverAccount { blogId: string; loginId: string; loginPw: string }
const ACCOUNTS_KEY = 'NAVER_ACCOUNTS';

function readNaverAccounts(): Record<string, Partial<NaverAccount>> {
  const raw = readEnvValues()[ACCOUNTS_KEY] ?? process.env[ACCOUNTS_KEY] ?? '';
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, Partial<NaverAccount>>) : {};
  } catch { return {}; }
}
function writeNaverAccounts(map: Record<string, Partial<NaverAccount>>): void {
  const clean: Record<string, Partial<NaverAccount>> = {};
  for (const [slug, a] of Object.entries(map)) {
    const e: Partial<NaverAccount> = {};
    if (a.blogId?.trim()) e.blogId = a.blogId.trim();
    if (a.loginId?.trim()) e.loginId = a.loginId.trim();
    if (a.loginPw?.trim()) e.loginPw = a.loginPw.trim();
    if (Object.keys(e).length) clean[slug] = e;
  }
  writeEnvValue(ACCOUNTS_KEY, Object.keys(clean).length ? JSON.stringify(clean) : undefined);
}

/** 발행에 쓸 계정 해석 — 범용('')은 평면 키, 브랜드는 NAVER_ACCOUNTS[slug](폴백 없음). */
export function getNaverAccount(slug: string): NaverAccount {
  if (!slug) {
    const v = readEnvValues();
    const env = (k: string): string => (v[k] ?? process.env[k] ?? '').trim();
    return { blogId: env('NAVER_BLOG_ID'), loginId: env('NAVER_LOGIN_ID'), loginPw: env('NAVER_LOGIN_PW') };
  }
  const a = readNaverAccounts()[slug] ?? {};
  return { blogId: (a.blogId ?? '').trim(), loginId: (a.loginId ?? '').trim(), loginPw: (a.loginPw ?? '').trim() };
}

/** 계정 저장(부분 갱신) — 빈 문자열은 해당 필드 삭제. 범용은 평면 키, 브랜드는 JSON blob. */
export function setNaverAccount(slug: string, patch: Partial<NaverAccount>): void {
  if (!slug) {
    if (patch.blogId !== undefined) writeEnvValue('NAVER_BLOG_ID', patch.blogId.trim() || undefined);
    if (patch.loginId !== undefined) writeEnvValue('NAVER_LOGIN_ID', patch.loginId.trim() || undefined);
    if (patch.loginPw !== undefined) writeEnvValue('NAVER_LOGIN_PW', patch.loginPw.trim() || undefined);
    return;
  }
  const map = readNaverAccounts();
  const cur = { ...(map[slug] ?? {}) };
  for (const [k, val] of Object.entries(patch)) {
    const t = (val ?? '').trim();
    if (t) cur[k as keyof NaverAccount] = t; else delete cur[k as keyof NaverAccount];
  }
  map[slug] = cur;
  writeNaverAccounts(map);
}

// ── 브랜드별 유튜브 채널 토큰 ────────────────────────────────────────────────
// NAVER_ACCOUNTS 와 동일 패턴 — 공용 OAuth 클라이언트 1개 + 브랜드별 refresh token 을
// YOUTUBE_TOKENS 한 키에 JSON({"<slug>":{refreshToken}})으로 저장(.env 단일 저장소).
// 브랜드 폴백 없음 — 미연결 브랜드는 빈 토큰(업로드 시 명확히 에러) → 채널 섞임 원천 차단.
export interface YoutubeAccount { refreshToken: string }
const YT_TOKENS_KEY = 'YOUTUBE_TOKENS';

function readYoutubeTokens(): Record<string, Partial<YoutubeAccount>> {
  const raw = readEnvValues()[YT_TOKENS_KEY] ?? process.env[YT_TOKENS_KEY] ?? '';
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, Partial<YoutubeAccount>>) : {};
  } catch { return {}; }
}

/** 업로드에 쓸 브랜드 채널 토큰 — 범용('')도 blob 의 '' 키(평면 키 없음). 미연결이면 빈 문자열. */
export function getYoutubeAccount(slug: string): YoutubeAccount {
  const a = readYoutubeTokens()[slug] ?? {};
  return { refreshToken: (a.refreshToken ?? '').trim() };
}

/** 브랜드 채널 토큰 저장 — 빈 문자열이면 해당 브랜드 연결 해제. */
export function setYoutubeToken(slug: string, refreshToken: string): void {
  const map = readYoutubeTokens();
  const clean: Record<string, Partial<YoutubeAccount>> = {};
  for (const [s, a] of Object.entries(map)) if (a.refreshToken?.trim()) clean[s] = { refreshToken: a.refreshToken.trim() };
  if (refreshToken.trim()) clean[slug] = { refreshToken: refreshToken.trim() };
  else delete clean[slug];
  writeEnvValue(YT_TOKENS_KEY, Object.keys(clean).length ? JSON.stringify(clean) : undefined);
}

// ── 브랜드별 메타(인스타·페북) 계정 ──────────────────────────────────────────
// YOUTUBE_TOKENS 와 동일 패턴 — 공용 개발자 앱 + 브랜드별 계정을 META_TOKENS 한 키에 JSON 으로 저장.
// 브랜드 폴백 없음 — 미연결은 빈값(발행 시 명확히 에러).
//
// 두 연결이 독립·병행한다(각각 다른 앱·다른 로그인, 한쪽만 연결돼도 그쪽 채널은 발행 가능):
//  · 인스타그램 로그인(INSTAGRAM_APP_ID) → igUserId + pageAccessToken(=IG 장기 토큰, 이름은 역사적 잔재).
//  · 페이스북 로그인(META_APP_ID)        → pageId  + pageToken(=페이지 액세스 토큰, FB 페이지 게시용).
// 토큰 필드를 절대 겹쳐 쓰지 않는다 — 한쪽 재연결이 다른 쪽 자격증명을 조용히 깨뜨리면
// '연결됐는데 발행 실패'를 진단 불가로 만든다(setMetaToken·setMetaPage 가 서로를 보존).
export interface MetaAccount { pageId: string; igUserId: string; pageAccessToken: string; pageToken: string }
const META_TOKENS_KEY = 'META_TOKENS';
/** 보존 요건(순수) — IG 연결(igUserId+토큰) 또는 FB 페이지 연결(pageId+페이지토큰) 중 하나라도 성립하면 유지. */
function hasAnyMetaLink(a: Partial<MetaAccount>): boolean {
  return !!((a.igUserId?.trim() && a.pageAccessToken?.trim()) || (a.pageId?.trim() && a.pageToken?.trim()));
}

/** blob 파싱(순수) — 깨진 JSON·비객체는 빈 맵. */
export function parseMetaTokens(raw: string): Record<string, Partial<MetaAccount>> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, Partial<MetaAccount>>) : {};
  } catch { return {}; }
}
function readMetaTokens(): Record<string, Partial<MetaAccount>> {
  return parseMetaTokens(readEnvValues()[META_TOKENS_KEY] ?? process.env[META_TOKENS_KEY] ?? '');
}
/** 발행에 쓸 브랜드 계정 — 범용('')도 blob 의 '' 키. 미연결이면 빈 문자열들. */
export function getMetaAccount(slug: string): MetaAccount {
  const a = readMetaTokens()[slug] ?? {};
  return {
    pageId: (a.pageId ?? '').trim(), igUserId: (a.igUserId ?? '').trim(),
    pageAccessToken: (a.pageAccessToken ?? '').trim(), pageToken: (a.pageToken ?? '').trim(),
  };
}
/** blob 쓰기 공용 — 유효 연결 없는 항목은 떨어낸다(죽은 자격증명 잔존 방지). */
function writeMetaTokens(clean: Record<string, Partial<MetaAccount>>): void {
  writeEnvValue(META_TOKENS_KEY, Object.keys(clean).length ? JSON.stringify(clean) : undefined);
}
/**
 * 인스타그램 연결 저장 — null 이면 IG 연결만 해제. 같은 브랜드의 FB 페이지 연결(pageId/pageToken)은
 * 그대로 보존한다(인스타 재연결이 페북 발행을 깨뜨리지 않게).
 */
export function setMetaToken(slug: string, acct: { igUserId: string; pageAccessToken: string } | null): void {
  const map = readMetaTokens();
  const clean: Record<string, Partial<MetaAccount>> = {};
  for (const [s, a] of Object.entries(map)) if (hasAnyMetaLink(a)) clean[s] = a;
  const prev = clean[slug] ?? map[slug] ?? {};
  if (acct && acct.igUserId.trim() && acct.pageAccessToken.trim()) {
    clean[slug] = { ...prev, igUserId: acct.igUserId, pageAccessToken: acct.pageAccessToken };
  } else {
    const kept: Partial<MetaAccount> = { pageId: prev.pageId, pageToken: prev.pageToken };
    if (hasAnyMetaLink(kept)) clean[slug] = kept; // FB 페이지 연결만 남기고 IG 자격증명 제거
    else delete clean[slug];
  }
  writeMetaTokens(clean);
}
/** 브랜드의 메타 항목 통째 제거 — IG·FB 양쪽 자격증명 모두. 브랜드 삭제 동반 정리용. */
export function deleteMetaAccount(slug: string): void {
  const map = readMetaTokens();
  const clean: Record<string, Partial<MetaAccount>> = {};
  for (const [s, a] of Object.entries(map)) if (s !== slug && hasAnyMetaLink(a)) clean[s] = a;
  writeMetaTokens(clean);
}
/**
 * 페이스북 페이지 연결 저장 — null 이면 페이지 연결만 해제. 같은 브랜드의 IG 연결은 보존한다.
 * (페이지 토큰은 IG 토큰과 별 필드 — 겹쳐 쓰면 잘 되던 인스타 발행이 조용히 깨진다.)
 */
export function setMetaPage(slug: string, page: { pageId: string; pageToken: string } | null): void {
  const map = readMetaTokens();
  const clean: Record<string, Partial<MetaAccount>> = {};
  for (const [s, a] of Object.entries(map)) if (hasAnyMetaLink(a)) clean[s] = a;
  const prev = clean[slug] ?? map[slug] ?? {};
  if (page && page.pageId.trim() && page.pageToken.trim()) {
    clean[slug] = { ...prev, pageId: page.pageId, pageToken: page.pageToken };
  } else {
    const kept: Partial<MetaAccount> = { igUserId: prev.igUserId, pageAccessToken: prev.pageAccessToken };
    if (hasAnyMetaLink(kept)) clean[slug] = kept; // IG 연결만 남기고 페이지 자격증명 제거
    else delete clean[slug];
  }
  writeMetaTokens(clean);
}

/**
 * 브랜드 삭제 동반 정리 — 채널 계정 blob(NAVER_ACCOUNTS·YOUTUBE_TOKENS·META_TOKENS)에서 해당 슬러그
 * 항목 제거. 잔존 시 죽은 브랜드의 로그인·토큰이 .env 에 남고(기밀 잔존), 동명 재생성 브랜드가 옛 계정을
 * 그대로 승계한다. 범용('')은 브랜드가 아니므로 no-op. 제거된 blob 항목 수 반환.
 */
export function purgeBrandAccounts(slug: string): number {
  if (!slug) return 0;
  let n = 0;
  if (readNaverAccounts()[slug]) { setNaverAccount(slug, { blogId: '', loginId: '', loginPw: '' }); n++; }
  if (readYoutubeTokens()[slug]) { setYoutubeToken(slug, ''); n++; }
  // 메타는 IG·FB 두 연결이 한 항목에 공존 — 부분 해제(setMetaToken/setMetaPage)는 다른 쪽을 보존하므로
  // 브랜드 삭제엔 항목 통째 제거를 쓴다(죽은 브랜드의 페이지 토큰 잔존 방지).
  if (readMetaTokens()[slug]) { deleteMetaAccount(slug); n++; }
  return n;
}

/** UI 표시용 — 계정 각 필드의 설정 여부 + 마스킹(blogId 는 공개값이라 평문, 로그인은 마스킹). */
export function naverAccountView(slug: string): {
  blogId: string; loginIdSet: boolean; loginIdMasked: string; loginPwSet: boolean;
} {
  const a = getNaverAccount(slug);
  return {
    blogId: a.blogId,
    loginIdSet: !!a.loginId, loginIdMasked: a.loginId ? maskSecret(a.loginId) : '',
    loginPwSet: !!a.loginPw,
  };
}
