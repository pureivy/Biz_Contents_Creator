# 브랜드별 유튜브 숏폼 발행 구현 플랜 (Feature C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 완성 쇼츠(final.mp4)를 브랜드별 유튜브 채널에 비공개(private) 업로드한다 — 수동 버튼 + `AUTO_YT_UPLOAD` 옵트인 자동.

**Architecture:** 공용 OAuth 클라이언트(키 탭 2키) + 브랜드별 refresh token(`YOUTUBE_TOKENS` blob, 네이버 `NAVER_ACCOUNTS` 미러) → 서버 통합 OAuth(동의→콜백 저장) → `src/tools/youtubeUpload.ts`가 Node fetch로 토큰 갱신+multipart videos.insert → 서버 라우트/쇼츠 카드 버튼/ready 자동 옵트인 배선.

**Tech Stack:** TypeScript(Node 20+ 내장 fetch)·Hono(기존)·React(기존). 새 의존성 없음.

## Global Constraints

- 공개 수준 `privacyStatus: 'private'` **고정** — 공개 전환은 항상 사람이 유튜브 스튜디오에서.
- 브랜드 폴백 없음 — 미연결 브랜드는 명시 에러(계정 섞임 원천 차단, 스펙 §1).
- 업로드는 **명시 실패 반환**(fail-open 아님): 미설정/미연결/invalid_grant("채널 재연결 필요")/quotaExceeded("일일 쿼터 초과")를 사람이 읽을 메시지로. refresh token·client secret 은 로그·에러에 싣지 않는다.
- 타임아웃 캡 180초, 재시도 없음(videos.insert = 1600 쿼터단위/건, 일일 기본 10,000 → ~6건).
- 메타데이터 캡(스펙 §4.2): 제목 100자·꺾쇠 `<>` 제거, 설명 5000자(= description + 해시태그 줄), tags = `#` 제거·30자 캡·최대 15개, `categoryId: '22'`, `selfDeclaredMadeForKids: false`.
- OAuth: scope `https://www.googleapis.com/auth/youtube.upload`, redirect `http://127.0.0.1:8787/youtube/oauth/callback`, `access_type=offline&prompt=consent`, `state=<브랜드 슬러그>`.
- 자동 업로드는 `AUTO_YT_UPLOAD`(기본 **false**) 옵트인 — 실패해도 잡 무영향(피드 로그만).
- **실 업로드는 로컬 자동 테스트 불가** — 순수 헬퍼만 vitest, 실검증은 사용자 동반 1회(플랜 밖).
- 빌드/테스트: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json`(exit 0), `npx vitest run <경로>`, 프론트는 `cd frontend && npm run build`.
- 커밋 직전 `git status --short`로 내 파일만 스테이징(병렬 세션 data/ 금지). 브랜치 **main** 직접 커밋(사용자 지시).

---

### Task 1: secrets store — 공용 키 2개 + 브랜드 토큰 blob

**Files:**
- Modify: `src/secrets/store.ts` (BUILTIN 배열 ~31행, 네이버 계정 섹션 뒤 ~250행)

**Interfaces:**
- Produces:
  - 키 탭 내장 키 `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`
  - `interface YoutubeAccount { refreshToken: string }`
  - `getYoutubeAccount(slug: string): YoutubeAccount` (미연결이면 `{ refreshToken: '' }`)
  - `setYoutubeToken(slug: string, refreshToken: string): void` (빈 문자열 = 연결 해제)

- [ ] **Step 1: Add builtin keys**

`src/secrets/store.ts` BUILTIN 배열 — 기존:
```ts
  { key: 'TELEGRAM_CHAT_ID', label: '텔레그램 챗 ID', icon: '💬', desc: '알림을 받을 텔레그램 chat_id', placeholder: '123456789', needs_restart: false },
```
을 다음으로 교체(2키 추가):
```ts
  { key: 'TELEGRAM_CHAT_ID', label: '텔레그램 챗 ID', icon: '💬', desc: '알림을 받을 텔레그램 chat_id', placeholder: '123456789', needs_restart: false },
  // 유튜브 쇼츠 발행 — 공용 OAuth 클라이언트(웹) 1개. 브랜드별 채널 토큰은 YOUTUBE_TOKENS blob(스튜디오 '채널 연결').
  { key: 'YOUTUBE_OAUTH_CLIENT_ID', label: '유튜브 OAuth 클라이언트 ID', icon: '▶️', desc: '쇼츠 업로드용 공용 OAuth 클라이언트(웹) ID — 설정 가이드는 스펙 §9', placeholder: '….apps.googleusercontent.com', needs_restart: false },
  { key: 'YOUTUBE_OAUTH_CLIENT_SECRET', label: '유튜브 OAuth 시크릿', icon: '🔑', desc: '위 클라이언트의 Client Secret', placeholder: 'GOCSPX-…', needs_restart: false },
```

- [ ] **Step 2: Add brand token blob helpers**

`src/secrets/store.ts` — `getNaverAccount`/`setNaverAccount` 섹션이 끝나는 지점 뒤에 추가:
```ts
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
```

- [ ] **Step 3: Verify types + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/secrets src/tools src/orchestrator` → PASS.

- [ ] **Step 4: Commit**

```bash
git status --short   # src/secrets/store.ts 만
git add src/secrets/store.ts
git commit -m "feat(youtube): 공용 OAuth 클라이언트 키 2종 + 브랜드별 채널 토큰 blob(YOUTUBE_TOKENS)"
```

---

### Task 2: youtubeUpload 모듈 + CONFIG.autoYtUpload + 테스트

**Files:**
- Modify: `src/config.ts` (인터페이스 ~120행, 객체 ~237행)
- Create: `src/tools/youtubeUpload.ts`
- Create: `src/tools/youtubeUpload.test.ts`

**Interfaces:**
- Consumes: `getSecret`·`getYoutubeAccount`(Task 1, `src/secrets/store.ts`).
- Produces:
  - `CONFIG.autoYtUpload: boolean`
  - `interface YtUploadResult { ok: boolean; videoId?: string; url?: string; error?: string }`
  - `buildVideoMeta(title: string, description: string, hashtags: string[]): Record<string, unknown>`
  - `buildMultipartBody(meta: Record<string, unknown>, video: Buffer, boundary: string): Buffer`
  - `extractVideoId(json: unknown): string | null`
  - `uploadShortsToYoutube(opts: { slug: string; videoPath: string; title: string; description: string; hashtags: string[]; signal?: AbortSignal }): Promise<YtUploadResult>`

- [ ] **Step 1: Write the failing tests**

`src/tools/youtubeUpload.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildVideoMeta, buildMultipartBody, extractVideoId } from './youtubeUpload';

describe('buildVideoMeta — 캡·해시태그 합성·private 고정(순수)', () => {
  it('꺾쇠 제거·설명에 해시태그 줄·tags 변환(# 제거·빈 항목 제외)', () => {
    const m = buildVideoMeta('제목 <b>테스트</b>', '설명', ['#shorts', '#화분', '']) as {
      snippet: { title: string; description: string; tags: string[]; categoryId: string };
      status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
    };
    expect(m.snippet.title).toBe('제목 b테스트/b');
    expect(m.snippet.description).toBe('설명\n\n#shorts #화분');
    expect(m.snippet.tags).toEqual(['shorts', '화분']);
    expect(m.snippet.categoryId).toBe('22');
    expect(m.status.privacyStatus).toBe('private');
    expect(m.status.selfDeclaredMadeForKids).toBe(false);
  });
  it('제목 100자 캡·빈 제목 폴백, 설명 5000자 캡', () => {
    const m = buildVideoMeta('x'.repeat(120), 'y'.repeat(6000), []) as { snippet: { title: string; description: string } };
    expect(m.snippet.title.length).toBe(100);
    expect(m.snippet.description.length).toBe(5000);
    const empty = buildVideoMeta('  ', '', []) as { snippet: { title: string } };
    expect(empty.snippet.title).toBe('쇼츠');
  });
});
describe('buildMultipartBody — multipart/related 조립(순수)', () => {
  it('메타 JSON + 비디오 바이트 + 종료 경계', () => {
    const buf = buildMultipartBody({ a: 1 }, Buffer.from('VIDEO'), 'BB');
    const s = buf.toString('utf-8');
    expect(s.startsWith('--BB\r\n')).toBe(true);
    expect(s).toContain('{"a":1}');
    expect(s).toContain('Content-Type: video/mp4');
    expect(s).toContain('VIDEO');
    expect(s.endsWith('\r\n--BB--\r\n')).toBe(true);
  });
});
describe('extractVideoId — 정상/이형(순수)', () => {
  it('비어있지 않은 문자열 id 만 통과', () => {
    expect(extractVideoId({ id: 'abc123' })).toBe('abc123');
    expect(extractVideoId({})).toBeNull();
    expect(extractVideoId(null)).toBeNull();
    expect(extractVideoId({ id: 5 })).toBeNull();
    expect(extractVideoId({ id: '' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/youtubeUpload.test.ts`
Expected: FAIL — "Cannot find module './youtubeUpload'".

- [ ] **Step 3: Extend CONFIG**

`src/config.ts` 인터페이스 — 기존:
```ts
  /** fal I2V 모델 ID — env 한 줄로 Wan 등 교체. */
  readonly shortsI2vModel: string;
```
을 다음으로 교체:
```ts
  /** fal I2V 모델 ID — env 한 줄로 Wan 등 교체. */
  readonly shortsI2vModel: string;
  /** ready 쇼츠 자동 유튜브 비공개 업로드(옵트인). */
  readonly autoYtUpload: boolean;
```
객체 — 기존:
```ts
  shortsI2vModel: env('SHORTS_I2V_MODEL', 'fal-ai/wan/v2.2-5b/image-to-video'), // LTX-2 는 가로 전용(실측) — 세로 쇼츠 기본은 Wan 5B
```
을 다음으로 교체:
```ts
  shortsI2vModel: env('SHORTS_I2V_MODEL', 'fal-ai/wan/v2.2-5b/image-to-video'), // LTX-2 는 가로 전용(실측) — 세로 쇼츠 기본은 Wan 5B
  autoYtUpload: envBool('AUTO_YT_UPLOAD', false),
```

- [ ] **Step 4: Write the module**

`src/tools/youtubeUpload.ts`:
```ts
/**
 * 유튜브 숏폼 업로드 — 브랜드별 refresh token(YOUTUBE_TOKENS)으로 access token 을 갱신해
 * videos.insert(multipart)로 비공개(private) 업로드. 공개 전환은 항상 사람이 유튜브 스튜디오에서.
 * Node 내장 fetch 만 사용(새 의존성 없음). 명시 실패 반환 — 사용자 트리거 액션(fail-open 아님).
 * 재시도 없음(videos.insert = 1600 쿼터단위/건). 토큰·시크릿은 로그·에러에 싣지 않는다.
 */
import fs from 'node:fs';
import { getSecret, getYoutubeAccount } from '../secrets/store';

export interface YtUploadResult { ok: boolean; videoId?: string; url?: string; error?: string }

/** snippet/status 메타데이터(순수) — 제목 100자·꺾쇠 제거, 설명 5000자, tags ≤15개·30자, private 고정. */
export function buildVideoMeta(title: string, description: string, hashtags: string[]): Record<string, unknown> {
  const t = title.replace(/[<>]/g, '').trim().slice(0, 100) || '쇼츠';
  const tagLine = hashtags.filter(Boolean).join(' ');
  const desc = [description.trim(), tagLine].filter(Boolean).join('\n\n').slice(0, 5000);
  const tags = hashtags.map((h) => h.replace(/^#/, '').trim().slice(0, 30)).filter(Boolean).slice(0, 15);
  return {
    snippet: { title: t, description: desc, tags, categoryId: '22' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  };
}

/** multipart/related 바디 조립(순수 Buffer) — ① JSON 메타 ② video/mp4 바이트. */
export function buildMultipartBody(meta: Record<string, unknown>, video: Buffer, boundary: string): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`, 'utf-8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  return Buffer.concat([head, video, tail]);
}

/** videos.insert 응답에서 id 안전 추출(순수). */
export function extractVideoId(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** refresh token → access token. 실패 사유는 사람이 읽을 메시지로(토큰 값 미노출). */
async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const j = await r.json() as { access_token?: string; error?: string };
  if (!r.ok || !j.access_token) {
    throw new Error(j.error === 'invalid_grant' ? '토큰 만료 — 채널 재연결 필요' : `토큰 갱신 실패(${j.error ?? r.status})`);
  }
  return j.access_token;
}

export async function uploadShortsToYoutube(opts: {
  slug: string; videoPath: string;
  title: string; description: string; hashtags: string[];
  signal?: AbortSignal;
}): Promise<YtUploadResult> {
  try {
    const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID') ?? '';
    const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET') ?? '';
    if (!clientId || !clientSecret) return { ok: false, error: '유튜브 OAuth 클라이언트 미설정 — 키 탭에서 입력하세요' };
    const { refreshToken } = getYoutubeAccount(opts.slug);
    if (!refreshToken) return { ok: false, error: '유튜브 채널 미연결 — 채널 연결을 먼저 하세요' };
    if (!fs.existsSync(opts.videoPath)) return { ok: false, error: '영상 파일 없음' };

    const timeout = AbortSignal.timeout(180_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const access = await refreshAccessToken(clientId, clientSecret, refreshToken, signal);

    const boundary = `yt-${Date.now().toString(36)}-gepa`;
    const body = buildMultipartBody(
      buildVideoMeta(opts.title, opts.description, opts.hashtags),
      fs.readFileSync(opts.videoPath), boundary);
    const r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const j: unknown = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = (j as { error?: { errors?: Array<{ reason?: string }> } })?.error?.errors?.[0]?.reason ?? String(r.status);
      return { ok: false, error: reason === 'quotaExceeded' ? '유튜브 일일 쿼터 초과 — 내일 재시도' : `업로드 실패(${reason})` };
    }
    const id = extractVideoId(j);
    if (!id) return { ok: false, error: '업로드 응답 이형(id 없음)' };
    return { ok: true, videoId: id, url: `https://youtube.com/watch?v=${id}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tools/youtubeUpload.test.ts`
Expected: PASS (3 describe).

- [ ] **Step 6: Typecheck + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/tools src/orchestrator` → PASS.

- [ ] **Step 7: Commit**

```bash
git status --short   # 아래 3개 파일만 확인
git add src/config.ts src/tools/youtubeUpload.ts src/tools/youtubeUpload.test.ts
git commit -m "feat(youtube): 업로드 모듈(토큰 갱신+multipart videos.insert, private 고정) + AUTO_YT_UPLOAD 게이트 + 순수 헬퍼 테스트"
```

---

### Task 3: 서버 라우트(OAuth 연결 3종 + 업로드) + Shorts 타입 확장

**Files:**
- Modify: `src/content/shorts.ts` (Shorts 인터페이스 ~38행)
- Modify: `src/server/main.ts` (import 30행, 쇼츠 라우트 블록 ~1021행 뒤)

**Interfaces:**
- Consumes: `uploadShortsToYoutube`(Task 2), `getYoutubeAccount`·`setYoutubeToken`(Task 1), 기존 `shortsStore().dirFor(id)`·`publisherName()`·`activeBrandSlug()`.
- Produces: `GET /youtube/status`(`{ client, connected }`), `GET /youtube/oauth/start`, `GET /youtube/oauth/callback`, `POST /shorts/:id/youtube`(`{ ok, url }` | `{ error }`), `Shorts.youtubeId?/youtubeUrl?`.

- [ ] **Step 1: Extend Shorts type**

`src/content/shorts.ts` — 기존:
```ts
  error?: string;
```
을 다음으로 교체:
```ts
  error?: string;
  /** 유튜브 비공개 업로드 결과(발행은 사람이 유튜브 스튜디오에서 공개 전환). */
  youtubeId?: string;
  youtubeUrl?: string;
```

- [ ] **Step 2: Extend server imports**

`src/server/main.ts` 30행 — 기존:
```ts
import { listKeys, setKey, addCustom, deleteKey, hiddenKeys, restoreKey, getSecret, setNaverAccount, naverAccountView } from '../secrets/store';
```
을 다음으로 교체:
```ts
import { listKeys, setKey, addCustom, deleteKey, hiddenKeys, restoreKey, getSecret, setNaverAccount, naverAccountView, getYoutubeAccount, setYoutubeToken } from '../secrets/store';
```
그리고 렌더러 import 근처(파일 상단 import 블록)에 추가:
```ts
import { uploadShortsToYoutube } from '../tools/youtubeUpload';
```

- [ ] **Step 3: Add routes**

`src/server/main.ts` — 기존:
```ts
app.get('/shorts/:id/video', shortsVideoHandler); // :id 보다 먼저(구체 경로 우선)
```
바로 **앞**에 추가:
```ts
// ── 유튜브 발행(브랜드별 채널) — 공용 OAuth 클라이언트 + 브랜드 refresh token(YOUTUBE_TOKENS).
//    비공개 업로드 고정 — 공개 전환은 사람이 유튜브 스튜디오에서(네이버 '임시저장' 원칙).
const YT_REDIRECT = 'http://127.0.0.1:8787/youtube/oauth/callback';
app.get('/youtube/status', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  const client = !!(getSecret('YOUTUBE_OAUTH_CLIENT_ID') && getSecret('YOUTUBE_OAUTH_CLIENT_SECRET'));
  return c.json({ client, connected: !!getYoutubeAccount(brand).refreshToken });
});
app.get('/youtube/oauth/start', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  const id = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  if (!id) return c.text('유튜브 OAuth 클라이언트 미설정 — 키 탭에서 먼저 입력하세요', 400);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', YT_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.upload');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', brand);
  return c.redirect(u.toString());
});
app.get('/youtube/oauth/callback', async (c) => {
  const code = c.req.query('code') ?? '';
  const brand = c.req.query('state') ?? '';
  const done = (msg: string): Response => c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${msg} — 이 창을 닫으세요.</body>`);
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
app.post('/shorts/:id/youtube', async (c) => {
  const id = c.req.param('id');
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown shorts' }, 404);
  if (s.stage !== 'ready') return c.json({ error: '완성(ready) 상태가 아닙니다' }, 409);
  const r = await uploadShortsToYoutube({
    slug: s.brand ?? '', videoPath: path.join(shortsStore().dirFor(id), 'final.mp4'),
    title: s.title ?? s.topic, description: s.description ?? '', hashtags: s.hashtags ?? [],
  });
  if (!r.ok) return c.json({ error: r.error }, 502);
  shortsStore().update(id, { youtubeId: r.videoId, youtubeUrl: r.url });
  console.log(`[발행담당] ${(s.title ?? s.topic).slice(0, 30)} — 유튜브 비공개 업로드 완료 (${publisherName()})`);
  return c.json({ ok: true, url: r.url });
});
```

- [ ] **Step 4: Verify types + 회귀**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/tools src/orchestrator src/secrets` → PASS.

- [ ] **Step 5: Commit**

```bash
git status --short   # 아래 2개 파일만 확인
git add src/content/shorts.ts src/server/main.ts
git commit -m "feat(youtube): 서버 통합 OAuth 연결(start/callback/status) + POST /shorts/:id/youtube 업로드 라우트"
```

---

### Task 4: 자동 업로드 배선 + 쇼츠 카드 UI + 최종 검증

**Files:**
- Modify: `src/orchestrator/shorts.ts` (ready 업데이트 직후)
- Modify: `frontend/src/api.ts` (ShortsInfo + 헬퍼 2개)
- Modify: `frontend/src/panels/ShortsView.tsx` (ShortRow 버튼 + 섹션 상태)

**Interfaces:**
- Consumes: `uploadShortsToYoutube`(Task 2), `CONFIG.autoYtUpload`(Task 2), `POST /shorts/:id/youtube`·`GET /youtube/status`·`/youtube/oauth/start`(Task 3).

- [ ] **Step 1: Auto upload after ready**

`src/orchestrator/shorts.ts` — import 블록의 `import { renderShortsVideoRemotion } ...` 아래에 추가:
```ts
import { uploadShortsToYoutube } from '../tools/youtubeUpload';
```
기존(ready 완료부):
```ts
    say(`${plan.title.slice(0, 30)} — ${r.durationSec}초 · 씬 ${r.sceneCount}개 완성${fallbacks ? ` (배경 폴백 ${fallbacks}씬)` : ''}`);
```
을 다음으로 교체:
```ts
    say(`${plan.title.slice(0, 30)} — ${r.durationSec}초 · 씬 ${r.sceneCount}개 완성${fallbacks ? ` (배경 폴백 ${fallbacks}씬)` : ''}`);

    // ready 이후 자동 유튜브 업로드(옵트인) — 비공개 고정. 실패해도 잡은 이미 완성(수동 재시도 가능).
    if (CONFIG.autoYtUpload) {
      const up = await uploadShortsToYoutube({
        slug: short.brand ?? '', videoPath: r.videoPath,
        title: plan.title, description: plan.description, hashtags: plan.hashtags,
        signal: opts.signal,
      });
      if (up.ok) { store.update(id, { youtubeId: up.videoId, youtubeUrl: up.url }); say(`유튜브 비공개 업로드 완료 — ${up.url}`); }
      else say(`유튜브 자동 업로드 실패(수동 재시도 가능) — ${up.error}`);
    }
```

- [ ] **Step 2: Frontend API helpers**

`frontend/src/api.ts` — `ShortsInfo` 인터페이스의 `error?: string;` 을 다음으로 교체:
```ts
  error?: string;
  youtubeUrl?: string;
```
그리고 `deleteShorts` 함수 뒤에 추가:
```ts
export async function uploadShortsYoutube(id: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const r = await fetch(`/shorts/${id}/youtube`, { method: "POST" });
    const j = await r.json().catch(() => ({} as { url?: string; error?: string }));
    if (!r.ok) return { ok: false, error: (j as { error?: string }).error || `HTTP ${r.status}` };
    return { ok: true, url: (j as { url?: string }).url };
  } catch { return { ok: false, error: "network" }; }
}
export async function fetchYoutubeStatus(): Promise<{ client: boolean; connected: boolean }> {
  try { const r = await fetch("/youtube/status"); return await r.json() as { client: boolean; connected: boolean }; }
  catch { return { client: false, connected: false }; }
}
```

- [ ] **Step 3: ShortRow 버튼 + 섹션 상태**

`frontend/src/panels/ShortsView.tsx`:
(a) import — 기존:
```ts
import {
  fetchShorts, createShorts, createShortsFromPiece, deleteShorts,
  fetchPieces, ShortsInfo, PieceInfo,
} from "../api";
```
을 다음으로 교체:
```ts
import {
  fetchShorts, createShorts, createShortsFromPiece, deleteShorts,
  fetchPieces, ShortsInfo, PieceInfo, uploadShortsYoutube, fetchYoutubeStatus,
} from "../api";
```
(b) `ShortRow` 시그니처 — 기존:
```tsx
function ShortRow({ s, onDelete }: { s: ShortsInfo; onDelete: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
```
을 다음으로 교체:
```tsx
function ShortRow({ s, onDelete, yt, onChanged }: {
  s: ShortsInfo; onDelete: (id: string) => void;
  yt: { client: boolean; connected: boolean }; onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytErr, setYtErr] = useState("");
  const doYoutube = async () => {
    setYtBusy(true); setYtErr("");
    const r = await uploadShortsYoutube(s.id);
    setYtBusy(false);
    if (r.ok) onChanged(); else setYtErr(r.error || "업로드 실패");
  };
```
(c) 버튼 블록 — 기존:
```tsx
            {captionFull && <button className="btn ghost" onClick={copyCaption}>{copied ? "복사됨!" : "캡션 복사"}</button>}
          </>
        )}
```
을 다음으로 교체(유튜브 버튼/링크/연결 + 에러 표시):
```tsx
            {captionFull && <button className="btn ghost" onClick={copyCaption}>{copied ? "복사됨!" : "캡션 복사"}</button>}
            {s.youtubeUrl ? (
              <a className="btn ghost" href={s.youtubeUrl} target="_blank" rel="noreferrer" title="비공개 업로드됨 — 공개 전환은 유튜브 스튜디오에서">▶ 유튜브(비공개)</a>
            ) : yt.connected ? (
              <button className="btn ghost" disabled={ytBusy} onClick={doYoutube}>{ytBusy ? "업로드 중…" : "▶ 유튜브 업로드"}</button>
            ) : yt.client ? (
              <a className="btn ghost" href="/youtube/oauth/start" target="_blank" rel="noreferrer" title="이 브랜드의 유튜브 채널 구글 계정으로 로그인해 1회 연결">▶ 채널 연결</a>
            ) : null}
            {ytErr && <span className="muted" style={{ color: "var(--con)" }}>{ytErr}</span>}
          </>
        )}
```
(d) `ShortsSection` — 기존:
```tsx
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => { fetchShorts().then(setItems); fetchPieces().then(setPieces); };
```
을 다음으로 교체:
```tsx
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [yt, setYt] = useState<{ client: boolean; connected: boolean }>({ client: false, connected: false });

  const load = () => { fetchShorts().then(setItems); fetchPieces().then(setPieces); fetchYoutubeStatus().then(setYt); };
```
(e) 목록 렌더 — 기존:
```tsx
      {items.map((s) => <ShortRow key={s.id} s={s} onDelete={doDelete} />)}
```
을 다음으로 교체:
```tsx
      {items.map((s) => <ShortRow key={s.id} s={s} onDelete={doDelete} yt={yt} onChanged={load} />)}
```

- [ ] **Step 4: Verify — 백엔드 + 프론트 빌드**

Run: `npx tsc --noEmit && npx tsc -p remotion/tsconfig.json; echo "tsc: $?"` → `tsc: 0`.
Run: `npx vitest run src/tools src/orchestrator` → PASS.
Run: `cd frontend && npm run build` → 빌드 성공(에러 0).

- [ ] **Step 5: Commit**

```bash
git status --short   # 아래 3개 파일만 확인
git add src/orchestrator/shorts.ts frontend/src/api.ts frontend/src/panels/ShortsView.tsx
git commit -m "feat(youtube): ready 자동 업로드(옵트인) + 쇼츠 카드 유튜브 업로드/채널 연결 UI"
```

---

## 완료 기준 (스펙 §8)

- [ ] 순수 헬퍼(buildVideoMeta·buildMultipartBody·extractVideoId) 테스트 통과, 루트+remotion tsc 0, 프론트 빌드 성공.
- [ ] 키/토큰 없음·`AUTO_YT_UPLOAD` off 경로에서 기존 동작 회귀 없음(버튼은 연결 안내만).
- [ ] **사용자 동반 실검증(플랜 밖, 구현 완료 후)**: 키 탭 입력 → 채널 연결 → 쇼츠 카드 버튼 업로드 → 유튜브 스튜디오에서 비공개 영상 확인.
