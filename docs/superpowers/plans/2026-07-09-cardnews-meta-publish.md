# 카드뉴스 인스타·페북 발행 + 성과 측정 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `stage:'ready'` 카드뉴스를 버튼 한 번으로 인스타그램 캐러셀+페이스북 페이지 게시물로 발행하고, 인사이트를 매일 수집해 기획자·디자이너에게 되먹임한다.

**Architecture:** 유튜브 Feature C(브랜드별 토큰 blob + OAuth 라우트 + 발행 라우트 409 가드)와 쇼츠 성과 루프(`shortsPerf.ts`)를 그대로 미러링. IG의 공개 이미지 URL 제약은 FB 미공개 사진 CDN URL 재사용으로 해결. 스펙: `docs/superpowers/specs/2026-07-09-cardnews-meta-publish-design.md`.

**Tech Stack:** TypeScript(Node 20 내장 fetch/FormData/Blob — 새 의존성 없음), Hono 라우트, vitest.

## Global Constraints

- Graph API 버전 고정: `const GRAPH = 'https://graph.facebook.com/v23.0'` (metaPublish.ts 한 곳에서만 선언, 다른 파일은 import)
- 새 npm 의존성 금지 — Node 내장 fetch·FormData·Blob만 사용(youtubeUpload.ts 관례)
- 토큰·시크릿을 로그·에러 메시지에 싣지 않는다
- 브랜드 폴백 없음: 미연결 브랜드는 명확한 에러(채널 섞임 차단, `YOUTUBE_TOKENS` 관례)
- 측정은 전량 fail-open(카드별 격리), 발행은 명시적 실패 반환(성공 위장 금지)
- 주석·에러 메시지는 한국어, 각 파일의 기존 스타일(간결한 헤더 주석) 준수
- 각 Task 커밋 전: `npx tsc --noEmit` 종료코드 0 + 해당 vitest 통과
- IG 캐러셀 ≤10장(카드뉴스는 3~8장), 발행 한도 100건/24h, 캡션 2200자 캡

---

### Task 1: 시크릿 스토어 — META_TOKENS 브랜드별 계정

**Files:**
- Modify: `src/secrets/store.ts` (YOUTUBE_TOKENS 블록 바로 아래, ~293행)
- Test: `src/secrets/store.test.ts` (신규)

**Interfaces:**
- Produces: `interface MetaAccount { pageId: string; igUserId: string; pageAccessToken: string }`, `parseMetaTokens(raw: string): Record<string, Partial<MetaAccount>>`, `getMetaAccount(slug: string): MetaAccount`, `setMetaToken(slug: string, acct: MetaAccount | null): void`
- Consumes: 같은 파일의 `readEnvValues()` / `writeEnvValue()` (기존)

- [ ] **Step 1: 실패하는 테스트 작성** — `.env`를 건드리지 않도록 순수 파서만 테스트

```typescript
// src/secrets/store.test.ts
import { describe, it, expect } from 'vitest';
import { parseMetaTokens } from './store';

describe('parseMetaTokens', () => {
  it('정상 blob → 슬러그별 계정', () => {
    const raw = JSON.stringify({ 'brand-a': { pageId: '1', igUserId: '2', pageAccessToken: 't' } });
    expect(parseMetaTokens(raw)['brand-a']).toEqual({ pageId: '1', igUserId: '2', pageAccessToken: 't' });
  });
  it('빈 문자열·깨진 JSON·비객체 → 빈 맵', () => {
    expect(parseMetaTokens('')).toEqual({});
    expect(parseMetaTokens('{broken')).toEqual({});
    expect(parseMetaTokens('"str"')).toEqual({});
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/secrets/store.test.ts` / Expected: FAIL (`parseMetaTokens` export 없음)

- [ ] **Step 3: 구현** — `setYoutubeToken` 정의(약 293행) 바로 아래에 추가:

```typescript
// ── 브랜드별 메타(인스타·페북) 계정 ──────────────────────────────────────────
// YOUTUBE_TOKENS 와 동일 패턴 — 공용 개발자 앱 1개 + 브랜드별 {pageId, igUserId, pageAccessToken}을
// META_TOKENS 한 키에 JSON 으로 저장. 브랜드 폴백 없음 — 미연결은 빈값(발행 시 명확히 에러).
export interface MetaAccount { pageId: string; igUserId: string; pageAccessToken: string }
const META_TOKENS_KEY = 'META_TOKENS';

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
  return { pageId: (a.pageId ?? '').trim(), igUserId: (a.igUserId ?? '').trim(), pageAccessToken: (a.pageAccessToken ?? '').trim() };
}
/** 브랜드 계정 저장 — null 이면 해당 브랜드 연결 해제. */
export function setMetaToken(slug: string, acct: MetaAccount | null): void {
  const map = readMetaTokens();
  const clean: Record<string, Partial<MetaAccount>> = {};
  for (const [s, a] of Object.entries(map)) {
    if (a.pageId?.trim() && a.igUserId?.trim() && a.pageAccessToken?.trim()) clean[s] = a;
  }
  if (acct && acct.pageId.trim() && acct.igUserId.trim() && acct.pageAccessToken.trim()) clean[slug] = acct;
  else delete clean[slug];
  writeEnvValue(META_TOKENS_KEY, Object.keys(clean).length ? JSON.stringify(clean) : undefined);
}
```

같은 파일의 `BUILTIN` 배열(유튜브 OAuth 키 항목 아래, ~35행)에 키 탭 노출용 2건 추가:

```typescript
  // 메타(인스타·페북) 발행 — 공용 개발자 앱 1개. 브랜드별 페이지·IG 토큰은 META_TOKENS blob(스튜디오 '메타 연결').
  { key: 'META_OAUTH_CLIENT_ID', label: '메타 앱 ID', icon: '📸', desc: '카드뉴스 인스타·페북 발행용 Meta 개발자 앱 ID — 설정 가이드는 스펙 §4', placeholder: '1234567890', needs_restart: false },
  { key: 'META_OAUTH_CLIENT_SECRET', label: '메타 앱 시크릿', icon: '🔑', desc: '위 앱의 App Secret', placeholder: 'abc123…', needs_restart: false },
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/secrets/store.test.ts` / Expected: PASS · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/secrets/store.ts src/secrets/store.test.ts
git commit -m "feat(meta): META_TOKENS 브랜드별 메타 계정 저장(유튜브 패턴 미러) + 키 탭 앱 ID/시크릿"
```

---

### Task 2: CardNews 레코드 발행·성과 필드

**Files:**
- Modify: `src/content/cardnews.ts` (CardNews 인터페이스, ~14-37행)

**Interfaces:**
- Produces: `CardNews`에 `igMediaId?: string; igPermalink?: string; fbPostId?: string; publishedTs?: string; perfReflected?: boolean` — Task 5·6·7이 사용

- [ ] **Step 1: 필드 추가** — `error?: string;` 바로 위에 삽입:

```typescript
  /** 메타 발행 결과(인스타 캐러셀 미디어 id·퍼머링크, 페북 게시물 id). 부분 성공 시 채널별 개별 기록. */
  igMediaId?: string;
  igPermalink?: string;
  fbPostId?: string;
  /** 첫 채널 발행 성공 시각 — 성과 측정 창 기준점. */
  publishedTs?: string;
  /** 측정 창 경과 후 강화 1회 완료(멱등 플래그) — shorts.perfReflected 미러. */
  perfReflected?: boolean;
```

- [ ] **Step 2: 검증** — Run: `npx tsc --noEmit` / Expected: 종료코드 0 (타입 전용 변경 — `CardNewsStore.update(id, patch: Partial<CardNews>)`가 기존에 있어 별도 코드 불요. 없다면 이 Task 에서 update 시그니처를 확인하고 실패 보고)

- [ ] **Step 3: Commit**

```bash
git add src/content/cardnews.ts
git commit -m "feat(meta): CardNews 발행·성과 필드(igMediaId·igPermalink·fbPostId·publishedTs·perfReflected)"
```

---

### Task 3: metaPublish 순수 헬퍼 + 테스트

**Files:**
- Create: `src/tools/metaPublish.ts`
- Test: `src/tools/metaPublish.test.ts` (신규)

**Interfaces:**
- Produces: `GRAPH`(상수), `buildIgCaption(caption, hashtags): string`, `extractId(json): string | null`, `pickPhotoUrl(json): string | null`, `parsePermalink(json): string | null`, `graphError(json, status): string`
- Consumes: 없음(순수)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/tools/metaPublish.test.ts
import { describe, it, expect } from 'vitest';
import { buildIgCaption, extractId, pickPhotoUrl, parsePermalink, graphError } from './metaPublish';

describe('metaPublish 순수 헬퍼', () => {
  it('buildIgCaption: 캡션+해시태그 결합, 2200자 캡', () => {
    expect(buildIgCaption('본문', ['#a', '#b'])).toBe('본문\n\n#a #b');
    expect(buildIgCaption('', ['#a'])).toBe('#a');
    expect(buildIgCaption('x'.repeat(3000), []).length).toBe(2200);
  });
  it('extractId: {id} 추출, 이형은 null', () => {
    expect(extractId({ id: '123' })).toBe('123');
    expect(extractId({})).toBeNull();
    expect(extractId(null)).toBeNull();
    expect(extractId({ id: 42 })).toBeNull();
  });
  it('pickPhotoUrl: images[0].source(최대 해상도), 이형은 null', () => {
    expect(pickPhotoUrl({ images: [{ source: 'https://cdn/a.png' }, { source: 'https://cdn/small.png' }] })).toBe('https://cdn/a.png');
    expect(pickPhotoUrl({ images: [] })).toBeNull();
    expect(pickPhotoUrl({})).toBeNull();
  });
  it('parsePermalink: {permalink} 추출', () => {
    expect(parsePermalink({ permalink: 'https://www.instagram.com/p/x/' })).toBe('https://www.instagram.com/p/x/');
    expect(parsePermalink({})).toBeNull();
  });
  it('graphError: 그래프 에러 메시지 추출(토큰 미노출), 없으면 HTTP 코드', () => {
    expect(graphError({ error: { message: 'Invalid parameter', code: 100 } }, 400)).toBe('Invalid parameter(code 100)');
    expect(graphError({}, 500)).toBe('HTTP 500');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/tools/metaPublish.test.ts` / Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/tools/metaPublish.ts` 생성:

```typescript
/**
 * 카드뉴스 메타(인스타·페북) 발행 — 브랜드별 계정(META_TOKENS)으로 ①FB 페이지 미공개 사진
 * 업로드(바이너리) ②그 CDN URL 로 IG 캐러셀 발행 ③같은 사진으로 FB 피드 게시.
 * IG API 는 공개 image_url 만 받으므로 FB CDN 을 재사용(외부 호스팅 무의존, 스펙 §6).
 * Node 내장 fetch/FormData 만 사용. 명시 실패 반환 — 사용자 트리거 액션(fail-open 아님).
 * 부분 성공 멱등: existing 에 있는 채널은 스킵. 토큰은 로그·에러에 싣지 않는다.
 */
import fs from 'node:fs';
import { getMetaAccount } from '../secrets/store';

export const GRAPH = 'https://graph.facebook.com/v23.0';

export interface MetaPublishResult {
  ok: boolean; igMediaId?: string; igPermalink?: string; fbPostId?: string; error?: string;
}

/** IG 캡션(순수) — 본문+해시태그 줄바꿈 결합, IG 한도 2200자 캡. */
export function buildIgCaption(caption: string, hashtags: string[]): string {
  const tagLine = hashtags.filter(Boolean).join(' ');
  return [caption.trim(), tagLine].filter(Boolean).join('\n\n').slice(0, 2200);
}
/** 그래프 응답 {id} 안전 추출(순수). */
export function extractId(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}
/** FB 사진 images 배열에서 최대 해상도 URL(첫 항목 = 최대, 순수). */
export function pickPhotoUrl(json: unknown): string | null {
  const imgs = (json as { images?: Array<{ source?: unknown }> } | null)?.images;
  const src = Array.isArray(imgs) ? imgs[0]?.source : undefined;
  return typeof src === 'string' && src ? src : null;
}
/** IG 미디어 {permalink} 추출(순수). */
export function parsePermalink(json: unknown): string | null {
  const p = (json as { permalink?: unknown } | null)?.permalink;
  return typeof p === 'string' && p ? p : null;
}
/** 그래프 에러 → 사람이 읽을 메시지(순수, 토큰류 미포함). */
export function graphError(json: unknown, status: number): string {
  const e = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  return e && typeof e.message === 'string'
    ? `${e.message}${e.code != null ? `(code ${e.code})` : ''}`.slice(0, 160)
    : `HTTP ${status}`;
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/tools/metaPublish.test.ts` / Expected: 5 PASS · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/tools/metaPublish.ts src/tools/metaPublish.test.ts
git commit -m "feat(meta): metaPublish 순수 헬퍼(캡션 캡·id/URL/permalink 추출·에러 메시지)"
```

---

### Task 4: publishCardNewsToMeta 발행 함수

**Files:**
- Modify: `src/tools/metaPublish.ts` (Task 3 파일에 이어서)
- Test: `src/tools/metaPublish.test.ts` (케이스 추가)

**Interfaces:**
- Produces: `publishCardNewsToMeta(opts: { slug: string; slidePaths: string[]; caption: string; hashtags: string[]; existing?: { igPermalink?: string; fbPostId?: string }; signal?: AbortSignal }): Promise<MetaPublishResult>`
- Consumes: Task 1 `getMetaAccount`, Task 3 헬퍼

- [ ] **Step 1: 실패하는 테스트 작성** — fetch 전체를 stub 해 호출 시퀀스 검증. describe 블록을 파일에 추가:

```typescript
import { vi, afterEach } from 'vitest';
import { publishCardNewsToMeta } from './metaPublish';
import { getMetaAccount } from '../secrets/store';
import fs from 'node:fs';

// ESM 모듈 함수는 spyOn 불가 — vi.mock 부분 목킹(파서 등 순수부는 원본 유지).
vi.mock('../secrets/store', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../secrets/store')>();
  return { ...mod, getMetaAccount: vi.fn(() => ({ pageId: '', igUserId: '', pageAccessToken: '' })) };
});

afterEach(() => vi.restoreAllMocks());

describe('publishCardNewsToMeta', () => {
  it('브랜드 미연결 → 명확한 에러(네트워크 호출 없음)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: '', pageAccessToken: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await publishCardNewsToMeta({ slug: 'x', slidePaths: ['/tmp/none.png'], caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('메타 미연결');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('11장 이상 → 캐러셀 한도 에러', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'p', igUserId: 'ig', pageAccessToken: 't' });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: Array.from({ length: 11 }, (_, i) => `/tmp/s${i}.png`), caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('10장');
  });
  it('happy path: 사진 2장 업로드→IG 캐러셀→FB 피드, 두 채널 id 반환', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url); calls.push(u);
      const json =
        u.includes('/PG/photos') ? { id: `ph${calls.filter((c) => c.includes('/PG/photos')).length}` }
        : u.includes('fields=images') ? { images: [{ source: 'https://cdn/x.png' }] }
        : u.includes('/media_publish') ? { id: 'IGMEDIA' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/p/x/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/IG/media') ? { id: `ct${calls.filter((c) => c.includes('/IG/media')).length}` }
        : u.includes('/PG/feed') ? { id: 'PG_POST1' }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png', '/a/slide_02.png'], caption: '본문', hashtags: ['#t'] });
    expect(r).toMatchObject({ ok: true, igMediaId: 'IGMEDIA', igPermalink: 'https://www.instagram.com/p/x/', fbPostId: 'PG_POST1' });
    expect(calls.filter((c) => c.includes('/PG/photos')).length).toBe(2);
  });
  it('부분 성공 멱등: existing.igPermalink 있으면 IG 스킵하고 FB 만 발행', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url); calls.push(u);
      const json = u.includes('/PG/photos') ? { id: 'ph1' } : u.includes('/PG/feed') ? { id: 'PG_POST2' } : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({
      slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [],
      existing: { igPermalink: 'https://www.instagram.com/p/done/' },
    });
    expect(r.ok).toBe(true);
    expect(r.fbPostId).toBe('PG_POST2');
    expect(calls.some((c) => c.includes('/IG/media'))).toBe(false); // IG 경로 미호출
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/tools/metaPublish.test.ts` / Expected: 신규 4케이스 FAIL

- [ ] **Step 3: 구현** — metaPublish.ts 에 추가:

```typescript
async function graphJson(url: string, init: RequestInit, what: string): Promise<unknown> {
  const r = await fetch(url, init);
  const j: unknown = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${what} 실패: ${graphError(j, r.status)}`);
  return j;
}
const tokenQs = (token: string): string => `access_token=${encodeURIComponent(token)}`;

/** FB 페이지에 미공개 사진 업로드(바이너리) → photoId. */
async function uploadUnpublishedPhoto(pageId: string, token: string, filePath: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('source', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), 'slide.png');
  form.append('published', 'false');
  form.append('access_token', token);
  const j = await graphJson(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: form, signal }, 'FB 사진 업로드');
  const id = extractId(j);
  if (!id) throw new Error('FB 사진 업로드 응답 이형(id 없음)');
  return id;
}
/** 캐러셀 컨테이너 처리 대기 — FINISHED 까지 3초×10회 폴링. */
async function waitContainer(containerId: string, token: string, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const j = await graphJson(`${GRAPH}/${containerId}?fields=status_code&${tokenQs(token)}`, { signal }, '컨테이너 상태');
    const st = (j as { status_code?: string }).status_code;
    if (st === 'FINISHED') return;
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error(`IG 컨테이너 처리 실패(${st})`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('IG 컨테이너 처리 시간 초과 — 잠시 후 재시도하세요');
}

export async function publishCardNewsToMeta(opts: {
  slug: string; slidePaths: string[]; caption: string; hashtags: string[];
  existing?: { igPermalink?: string; fbPostId?: string }; signal?: AbortSignal;
}): Promise<MetaPublishResult> {
  const out: MetaPublishResult = { ok: false };
  try {
    const acct = getMetaAccount(opts.slug);
    if (!acct.pageId || !acct.igUserId || !acct.pageAccessToken) {
      return { ok: false, error: '메타 미연결 — 카드뉴스 탭에서 메타 연결을 먼저 하세요' };
    }
    if (opts.slidePaths.length > 10) return { ok: false, error: `IG 캐러셀은 최대 10장(현재 ${opts.slidePaths.length}장)` };
    if (!opts.slidePaths.length || !opts.slidePaths.every((p) => fs.existsSync(p))) {
      return { ok: false, error: '슬라이드 파일 없음' };
    }
    const timeout = AbortSignal.timeout(300_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const message = buildIgCaption(opts.caption, opts.hashtags);
    const token = acct.pageAccessToken;

    // ① FB 미공개 사진 업로드 — IG(CDN URL)·FB(attached_media) 양쪽의 재료(순서 보존).
    const photoIds: string[] = [];
    for (const p of opts.slidePaths) photoIds.push(await uploadUnpublishedPhoto(acct.pageId, token, p, signal));

    // ② IG 캐러셀 — 기발행(existing.igPermalink)이면 스킵(부분 성공 재시도 멱등).
    if (!opts.existing?.igPermalink) {
      const childIds: string[] = [];
      for (const phId of photoIds) {
        // CDN URL 은 서명 만료가 있어 저장·재사용 금지 — 획득 즉시 컨테이너 생성(스펙 §6).
        const cdn = pickPhotoUrl(await graphJson(`${GRAPH}/${phId}?fields=images&${tokenQs(token)}`, { signal }, 'FB 사진 URL 조회'));
        if (!cdn) throw new Error('FB 사진 CDN URL 없음');
        const child = await graphJson(`${GRAPH}/${acct.igUserId}/media`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ image_url: cdn, is_carousel_item: 'true', access_token: token }),
        }, 'IG 자식 컨테이너');
        const cid = extractId(child);
        if (!cid) throw new Error('IG 자식 컨테이너 응답 이형');
        childIds.push(cid);
      }
      const carousel = await graphJson(`${GRAPH}/${acct.igUserId}/media`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ media_type: 'CAROUSEL', children: childIds.join(','), caption: message, access_token: token }),
      }, 'IG 캐러셀 컨테이너');
      const carId = extractId(carousel);
      if (!carId) throw new Error('IG 캐러셀 컨테이너 응답 이형');
      await waitContainer(carId, token, signal);
      const pub = await graphJson(`${GRAPH}/${acct.igUserId}/media_publish`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: carId, access_token: token }),
      }, 'IG 발행');
      out.igMediaId = extractId(pub) ?? undefined;
      if (out.igMediaId) {
        const perma = await graphJson(`${GRAPH}/${out.igMediaId}?fields=permalink&${tokenQs(token)}`, { signal }, 'IG 퍼머링크').catch(() => null);
        out.igPermalink = (perma && parsePermalink(perma)) ?? `https://www.instagram.com/`;
      }
    }

    // ③ FB 피드 게시 — 기발행(existing.fbPostId)이면 스킵.
    if (!opts.existing?.fbPostId) {
      const feed = await graphJson(`${GRAPH}/${acct.pageId}/feed`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          message,
          attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id }))),
          access_token: token,
        }),
      }, 'FB 피드 게시');
      out.fbPostId = extractId(feed) ?? undefined;
      if (!out.fbPostId) throw new Error('FB 피드 응답 이형(id 없음)');
    }

    out.ok = true;
    return out;
  } catch (e) {
    // 채널별 부분 성공은 out 에 남아 있음 — 라우트가 성공분을 저장하고 실패 원인만 보고(성공 위장 금지).
    out.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    // 발행 한도 도달 힌트(스펙 §6) — 메타 에러 문구에 limit 이 보이면 확인 경로 안내.
    if (/limit/i.test(out.error)) out.error += ' — 24시간 발행 한도(100건) 가능성: GET /{ig-user-id}/content_publishing_limit 로 확인';
    return out;
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/tools/metaPublish.test.ts` / Expected: 전체 PASS(9케이스) · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/tools/metaPublish.ts src/tools/metaPublish.test.ts
git commit -m "feat(meta): publishCardNewsToMeta — FB 미공개 사진→IG 캐러셀→FB 피드, 부분 성공 멱등"
```

---

### Task 5: OAuth 라우트(/meta/oauth/*) + /meta/status

**Files:**
- Modify: `src/server/main.ts` — 유튜브 OAuth 블록(`app.post('/shorts/:id/youtube'` 아래, ~1102행) 다음에 메타 블록 추가. 파일 상단 import 에 `getMetaAccount, setMetaToken` (../secrets/store), `publishCardNewsToMeta, GRAPH` (../tools/metaPublish) 추가
- Test: `src/tools/metaEndpoints.test.ts` (신규)

**Interfaces:**
- Produces: `GET /meta/status` → `{ client: boolean; connected: boolean }` · `GET /meta/oauth/start` · `GET /meta/oauth/callback` · `GET /meta/oauth/pick`
- Consumes: Task 1 `getMetaAccount/setMetaToken`, 기존 `getSecret`·`activeBrandSlug`·`isSafeBrandSlug`·`randomBytes`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/tools/metaEndpoints.test.ts
import { describe, it, expect } from 'vitest';
import { app } from '../server/main';

describe('메타 OAuth·상태 라우트', () => {
  it('GET /meta/status → client/connected 불리언', async () => {
    const res = await app.request('/meta/status');
    expect(res.status).toBe(200);
    const j = await res.json() as { client: boolean; connected: boolean };
    expect(typeof j.client).toBe('boolean');
    expect(typeof j.connected).toBe('boolean');
  });
  it('GET /meta/oauth/start: 클라이언트 미설정이면 400, 비정상 슬러그 400', async () => {
    const bad = await app.request('/meta/oauth/start?brand=../evil');
    expect(bad.status).toBe(400);
  });
  it('GET /meta/oauth/callback: state 없음 → 실패 안내(200 HTML)', async () => {
    const res = await app.request('/meta/oauth/callback');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('연결 실패');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/tools/metaEndpoints.test.ts` / Expected: FAIL (라우트 404)

- [ ] **Step 3: 구현** — 유튜브 발행 블록 아래에 추가(주석·구조는 유튜브 블록 미러):

```typescript
// ── 메타(인스타·페북) 발행 — 공용 개발자 앱 + 브랜드별 페이지·IG 토큰(META_TOKENS).
//    콜백: code→장기 사용자 토큰→/me/accounts. 페이지 1개면 즉시 저장, 여러 개면 pick 화면.
const META_REDIRECT = `http://127.0.0.1:${CONFIG.port}/meta/oauth/callback`; // 앱 설정의 리디렉션 URI 와 일치 필수
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,instagram_manage_insights';
interface MetaPage { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }
const META_OAUTH_PENDING = new Map<string, { brand: string; exp: number; pages?: MetaPage[] }>();
// 그래프 호스트·버전은 metaPublish.GRAPH 단일 선언을 재사용(전역 제약). dialog URL 만 www.facebook.com 호스트.

app.get('/meta/status', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  const client = !!(getSecret('META_OAUTH_CLIENT_ID') && getSecret('META_OAUTH_CLIENT_SECRET'));
  const a = getMetaAccount(brand);
  return c.json({ client, connected: !!(a.pageId && a.igUserId && a.pageAccessToken) });
});
app.get('/meta/oauth/start', (c) => {
  const brand = c.req.query('brand') ?? (activeBrandSlug() || '');
  if (brand && !isSafeBrandSlug(brand)) return c.text('비정상 브랜드 슬러그', 400);
  const id = getSecret('META_OAUTH_CLIENT_ID');
  if (!id) return c.text('메타 앱 미설정 — 키 탭에서 앱 ID/시크릿을 먼저 입력하세요(스펙 §4 가이드)', 400);
  const nonce = randomBytes(16).toString('hex');
  for (const [k, v] of META_OAUTH_PENDING) if (v.exp < Date.now()) META_OAUTH_PENDING.delete(k);
  META_OAUTH_PENDING.set(nonce, { brand, exp: Date.now() + 10 * 60_000 });
  const u = new URL('https://www.facebook.com/v23.0/dialog/oauth');
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', META_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', META_SCOPES);
  u.searchParams.set('state', nonce);
  return c.redirect(u.toString());
});
/** 페이지 1건을 브랜드에 저장(IG 연결 검증 포함) — callback·pick 공용. */
function saveMetaPage(brand: string, page: MetaPage): string | null {
  const ig = page.instagram_business_account?.id ?? '';
  if (!ig) return `페이지 "${page.name}"에 연결된 인스타그램 프로페셔널 계정이 없습니다 — 페이지 설정에서 IG 계정을 먼저 연결하세요`;
  setMetaToken(brand, { pageId: page.id, igUserId: ig, pageAccessToken: page.access_token });
  console.log(`[발행담당] 메타 연결 — 브랜드 '${brand || '범용'}' ← 페이지 "${page.name}"`);
  return null;
}
app.get('/meta/oauth/callback', async (c) => {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const done = (msg: string): Response => c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${esc(msg)} — 이 창을 닫으세요.</body>`);
  const state = c.req.query('state') ?? '';
  const pending = META_OAUTH_PENDING.get(state);
  if (!pending || pending.exp < Date.now()) return done('연결 실패: 유효하지 않거나 만료된 연결 요청 — 메타 연결을 다시 시작하세요');
  META_OAUTH_PENDING.delete(state);
  const code = c.req.query('code') ?? '';
  if (!code) return done(`연결 실패: ${c.req.query('error') ?? '인증 코드 없음'}`);
  try {
    const cid = getSecret('META_OAUTH_CLIENT_ID') ?? '';
    const sec = getSecret('META_OAUTH_CLIENT_SECRET') ?? '';
    const tok = await fetch(`${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(META_REDIRECT)}&client_secret=${encodeURIComponent(sec)}&code=${encodeURIComponent(code)}`);
    const tj = await tok.json() as { access_token?: string };
    if (!tj.access_token) return done('연결 실패: 액세스 토큰 없음');
    const long = await fetch(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(sec)}&fb_exchange_token=${encodeURIComponent(tj.access_token)}`);
    const lj = await long.json() as { access_token?: string };
    const userToken = lj.access_token ?? tj.access_token; // 장기 교환 실패 시 단기로 진행(페이지 토큰은 어차피 페이지별)
    const pr = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(userToken)}`);
    const pj = await pr.json() as { data?: MetaPage[] };
    const pages = (pj.data ?? []).filter((p) => p.id && p.access_token);
    if (!pages.length) return done('연결 실패: 관리 중인 페이스북 페이지가 없습니다 — 페이지를 먼저 만드세요(스펙 §4)');
    if (pages.length === 1) {
      const err = saveMetaPage(pending.brand, pages[0]!);
      return done(err ? `연결 실패: ${err}` : `✅ 메타 연결 완료 (브랜드: ${pending.brand || '범용'} ← ${pages[0]!.name})`);
    }
    const nonce2 = randomBytes(16).toString('hex');
    META_OAUTH_PENDING.set(nonce2, { brand: pending.brand, exp: Date.now() + 10 * 60_000, pages });
    const links = pages.map((p) =>
      `<li><a href="/meta/oauth/pick?state=${nonce2}&page=${esc(p.id)}">${esc(p.name)}</a>${p.instagram_business_account ? '' : ' (IG 미연결)'}</li>`).join('');
    return c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">브랜드 '${esc(pending.brand || '범용')}'에 연결할 페이지를 선택하세요:<ul>${links}</ul></body>`);
  } catch (e) { return done(`연결 실패: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
});
app.get('/meta/oauth/pick', (c) => {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const done = (msg: string): Response => c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${esc(msg)} — 이 창을 닫으세요.</body>`);
  const pending = META_OAUTH_PENDING.get(c.req.query('state') ?? '');
  if (!pending?.pages || pending.exp < Date.now()) return done('선택 실패: 만료된 요청 — 메타 연결을 다시 시작하세요');
  META_OAUTH_PENDING.delete(c.req.query('state') ?? '');
  const page = pending.pages.find((p) => p.id === (c.req.query('page') ?? ''));
  if (!page) return done('선택 실패: 페이지 없음');
  const err = saveMetaPage(pending.brand, page);
  return done(err ? `연결 실패: ${err}` : `✅ 메타 연결 완료 (브랜드: ${pending.brand || '범용'} ← ${page.name})`);
});
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/tools/metaEndpoints.test.ts` / Expected: 3 PASS · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/server/main.ts src/tools/metaEndpoints.test.ts
git commit -m "feat(meta): OAuth 라우트(start/callback/pick, nonce state)+/meta/status — 장기 페이지 토큰 브랜드별 저장"
```

---

### Task 6: 발행 라우트 POST /cardnews/:id/publish

**Files:**
- Modify: `src/server/main.ts` — Task 5 블록 아래
- Test: `src/tools/metaEndpoints.test.ts` (케이스 추가)

**Interfaces:**
- Produces: `POST /cardnews/:id/publish` → 200 `{ ok, igPermalink?, fbPostId? }` / 404 / 409 / 502
- Consumes: Task 4 `publishCardNewsToMeta`, Task 2 CardNews 필드, 기존 `cardNewsStore`

- [ ] **Step 1: 실패하는 테스트 작성** — 네트워크 안 타는 가드만 엔드포인트 테스트(유튜브 라우트 관례):

```typescript
describe('POST /cardnews/:id/publish 가드', () => {
  it('미존재 id → 404', async () => {
    const res = await app.request('/cardnews/nope-xyz/publish', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/tools/metaEndpoints.test.ts` / Expected: 새 케이스 FAIL (라우트 404 원인은 미들웨어 폴백 — 상태코드·본문 확인)

- [ ] **Step 3: 구현**:

```typescript
app.post('/cardnews/:id/publish', async (c) => {
  const id = c.req.param('id') ?? '';
  const card = cardNewsStore().get(id);
  if (!card) return c.json({ error: 'unknown cardnews' }, 404);
  if (card.stage !== 'ready') return c.json({ error: '완성(ready) 상태가 아닙니다' }, 409);
  if (card.igPermalink && card.fbPostId) return c.json({ error: '이미 발행됨', igPermalink: card.igPermalink }, 409);
  const dir = path.join(CONFIG.dataDir, 'cardnews', id);
  const slides = (() => {
    try { return fs.readdirSync(dir).filter((f) => /^slide_\d{2}\.png$/.test(f)).sort().map((f) => path.join(dir, f)); }
    catch { return [] as string[]; }
  })();
  if (!slides.length) return c.json({ error: '슬라이드 파일 없음' }, 409);
  const r = await publishCardNewsToMeta({
    slug: card.brand ?? '', slidePaths: slides,
    caption: card.caption ?? card.topic, hashtags: card.hashtags ?? [],
    existing: { igPermalink: card.igPermalink, fbPostId: card.fbPostId },
  });
  // 부분 성공도 저장 — 재시도 시 성공 채널은 existing 으로 스킵(멱등).
  const patch: Partial<CardNews> = {};
  if (r.igMediaId) { patch.igMediaId = r.igMediaId; patch.igPermalink = r.igPermalink; }
  if (r.fbPostId) patch.fbPostId = r.fbPostId;
  if ((r.igMediaId || r.fbPostId) && !card.publishedTs) patch.publishedTs = new Date().toISOString();
  if (Object.keys(patch).length) cardNewsStore().update(id, patch);
  if (!r.ok) return c.json({ error: r.error, ...patch }, 502);
  console.log(`[발행담당] 카드뉴스 "${card.topic.slice(0, 30)}" — 인스타·페북 발행 완료`);
  return c.json({ ok: true, igPermalink: r.igPermalink ?? card.igPermalink, fbPostId: r.fbPostId ?? card.fbPostId });
});
```

import 확인: `CardNews` 타입을 `../content/cardnews`에서 type import(파일 상단 기존 cardNewsStore import 라인에 추가).

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/tools/metaEndpoints.test.ts` / Expected: 전체 PASS · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/server/main.ts src/tools/metaEndpoints.test.ts
git commit -m "feat(meta): POST /cardnews/:id/publish — 409 가드·부분 성공 저장·멱등 재시도"
```

---

### Task 7: 성과 순수 헬퍼 — MetricSample 확장 + cardnewsPerf

**Files:**
- Modify: `src/analytics/performance.ts` (MetricSample, ~12-21행)
- Create: `src/analytics/cardnewsPerf.ts` (순수 부분)
- Test: `src/analytics/cardnewsPerf.test.ts` (신규)

**Interfaces:**
- Produces: `MetricSample`에 `reach?: number; saved?: number; shares?: number` · `cardnewsSignal(reach, saved, shares): number` · `parseIgInsights(json): Record<string, number>` · `parseFbEngagement(json): { likes: number; comments: number; shares: number }` · `cardnewsPerfDue(c, now, days): boolean`
- Consumes: Task 2 CardNews 필드, 기존 `MetricSample`

- [ ] **Step 1: MetricSample 확장** — `comments?: number;` 아래에 추가:

```typescript
  /** 메타(인스타) 수집(meta:ig) 전용 — 도달·저장·공유(하위호환 optional). */
  reach?: number;
  saved?: number;
  shares?: number;
```

- [ ] **Step 2: 실패하는 테스트 작성**

```typescript
// src/analytics/cardnewsPerf.test.ts
import { describe, it, expect } from 'vitest';
import { cardnewsSignal, parseIgInsights, parseFbEngagement, cardnewsPerfDue } from './cardnewsPerf';

describe('cardnewsSignal', () => {
  it('0 도달 → 0(0나눗셈 안전)', () => expect(cardnewsSignal(0, 0, 0)).toBe(0));
  it('1만 도달·저장률 2%·공유율 1% ≈ 1.0', () => {
    expect(cardnewsSignal(10_000, 200, 100)).toBeGreaterThan(0.95);
  });
  it('저장·공유 없이 도달만 크면 0.4 이하(저장·공유 중심 가중)', () => {
    expect(cardnewsSignal(100_000, 0, 0)).toBeLessThanOrEqual(0.4 + 1e-9);
  });
});
describe('parseIgInsights', () => {
  it('insights 응답 → 지표맵, 이형은 빈 맵', () => {
    const j = { data: [{ name: 'reach', values: [{ value: 42 }] }, { name: 'saved', values: [{ value: 3 }] }] };
    expect(parseIgInsights(j)).toEqual({ reach: 42, saved: 3 });
    expect(parseIgInsights(null)).toEqual({});
    expect(parseIgInsights({ data: [{ name: 'reach', values: [{ value: 'x' }] }] })).toEqual({ reach: 0 });
  });
});
describe('parseFbEngagement', () => {
  it('필드 응답 → 카운트, 결측 0', () => {
    const j = { reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 } };
    expect(parseFbEngagement(j)).toEqual({ likes: 5, comments: 2, shares: 1 });
    expect(parseFbEngagement({})).toEqual({ likes: 0, comments: 0, shares: 0 });
  });
});
describe('cardnewsPerfDue', () => {
  const day = 86_400_000;
  it('미발행·igMediaId 없음 → false', () => {
    expect(cardnewsPerfDue({ }, Date.now(), 7)).toBe(false);
    expect(cardnewsPerfDue({ publishedTs: new Date().toISOString() }, Date.now(), 7)).toBe(false);
  });
  it('창 내 매일 true, 창 경과+미강화 true, 강화 완료 false, 포기 지평(4배) false', () => {
    const now = Date.now();
    const at = (ageDays: number): string => new Date(now - ageDays * day).toISOString();
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(3) }, now, 7)).toBe(true);
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(10) }, now, 7)).toBe(true);
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(10), perfReflected: true }, now, 7)).toBe(false);
    expect(cardnewsPerfDue({ igMediaId: 'm', publishedTs: at(30) }, now, 7)).toBe(false);
  });
});
```

- [ ] **Step 3: 실패 확인** — Run: `npx vitest run src/analytics/cardnewsPerf.test.ts` / Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현** — `src/analytics/cardnewsPerf.ts` 생성(순수 부분):

```typescript
/**
 * 카드뉴스 메타 성과 수집·강화 — 발행된 카드뉴스(igMediaId·publishedTs)의 IG 인사이트
 * (views·reach·saved·shares·likes·comments)와 FB 반응을 매일 수집해 시계열(appendMetrics)에
 * 쌓고, 측정창(shortsPerfDays 재사용) 경과 시 1회 강화(cardnews_planner·designer 메모리+위키,
 * perfReflected 멱등). 전량 fail-open — shortsPerf.ts 의 사촌(스펙 §7).
 */
import { CONFIG } from '../config';
import { fetchTimeout } from '../util/fetch';
import { getMetaAccount } from '../secrets/store';
import { GRAPH } from '../tools/metaPublish';
import { appendMetrics, readMetrics, type MetricSample } from './performance';
import { shouldRecordMemory } from './shortsPerf';
import { cardNewsStore, type CardNews } from '../content/cardnews';
import { isSafeBrandSlug } from '../content/brand';
import { llmWikiFor } from '../wiki/llmwiki';
import { appendMemory, appendActivity } from '../agents/workspace';

/** 카드뉴스 성과 → 0~1 스칼라(순수) — 도달 로그 0.4 + 저장률(2%≈만점) 0.35 + 공유율(1%≈만점) 0.25.
 *  perf_analyst 진단 기준(저장=실용 가치·공유=공감 가치 중심)과 일치, 강화 임계 0.6 규약 공유. */
export function cardnewsSignal(reach: number, saved: number, shares: number): number {
  const reachScore = Math.min(1, Math.log10(Math.max(0, reach) + 1) / 4); // 1만 도달 ≈ 1.0
  const savedRate = reach > 0 ? Math.min(1, saved / reach / 0.02) : 0;
  const shareRate = reach > 0 ? Math.min(1, shares / reach / 0.01) : 0;
  return 0.4 * reachScore + 0.35 * savedRate + 0.25 * shareRate;
}
/** IG insights 응답 → {지표명: 값}(순수) — 이형·결측·음수 방어. */
export function parseIgInsights(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const it of data) {
    const o = it as { name?: unknown; values?: Array<{ value?: unknown }> };
    if (typeof o?.name !== 'string') continue;
    const v = Number(o.values?.[0]?.value);
    out[o.name] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return out;
}
/** FB 게시물 필드 응답 → 반응·댓글·공유 수(순수). */
export function parseFbEngagement(json: unknown): { likes: number; comments: number; shares: number } {
  const o = json as {
    reactions?: { summary?: { total_count?: unknown } };
    comments?: { summary?: { total_count?: unknown } };
    shares?: { count?: unknown };
  } | null;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  return { likes: n(o?.reactions?.summary?.total_count), comments: n(o?.comments?.summary?.total_count), shares: n(o?.shares?.count) };
}
/** 이번 틱 수집 대상인가(순수) — shortsPerfDue 미러(igMediaId·publishedTs 기준, 포기 지평 4배). */
export function cardnewsPerfDue(
  c: Pick<CardNews, 'igMediaId' | 'publishedTs' | 'perfReflected'>, now: number, days: number,
): boolean {
  if (!c.igMediaId || !c.publishedTs) return false;
  const t = new Date(c.publishedTs).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age > days * 4 * 86_400_000) return false;
  return age <= days * 86_400_000 || !c.perfReflected;
}
```

- [ ] **Step 5: 통과 확인** — Run: `npx vitest run src/analytics/cardnewsPerf.test.ts` / Expected: PASS · `npx tsc --noEmit` → 0

- [ ] **Step 6: Commit**

```bash
git add src/analytics/performance.ts src/analytics/cardnewsPerf.ts src/analytics/cardnewsPerf.test.ts
git commit -m "feat(meta): 카드뉴스 성과 순수부 — cardnewsSignal(저장·공유 중심)·인사이트 파서·수집 대상 판정 + MetricSample reach/saved/shares"
```

---

### Task 8: syncCardnewsPerformance + 강화 + 일일 틱 배선

**Files:**
- Modify: `src/analytics/cardnewsPerf.ts` (Task 7 파일에 이어서)
- Modify: `src/server/main.ts` — `startDaily` perf-sync 배선(~2422행) run 콜백에 1줄 추가 + import

**Interfaces:**
- Produces: `syncCardnewsPerformance(): Promise<void>` — main.ts 일일 틱이 호출
- Consumes: Task 7 순수부, Task 1 `getMetaAccount`, 기존 `appendMetrics`·`llmWikiFor`·`appendMemory`·`shouldRecordMemory`·`CONFIG.shortsPerfDays`

- [ ] **Step 1: 구현** — cardnewsPerf.ts 에 추가(shortsPerf `reinforceShorts`/`syncShortsPerformance` 미러):

```typescript
/** 강화 1회 — reinforceShorts 미러. 역할 부재·위키 실패는 무해. 신호를 반환. */
function reinforceCardnews(card: CardNews, m: MetricSample): number {
  const signal = cardnewsSignal(m.reach ?? 0, m.saved ?? 0, m.shares ?? 0);
  const brand = card.brand && isSafeBrandSlug(card.brand) ? card.brand : '';
  const verdict = signal >= 0.6
    ? '이 주제·표지 훅·비주얼이 저장·공유로 이어짐 — 유사 각도 유지'
    : '저장·공유 저조 — 표지 훅과 장당 메시지 밀도 재고';
  const igOnlySamples = readMetrics(card.id).filter((s) => s.source === 'meta:ig').length;
  if (shouldRecordMemory(signal, igOnlySamples)) {
    for (const role of ['cardnews_planner', 'cardnews_designer']) {
      try {
        appendMemory(role, `카드뉴스 성과: "${card.topic}"${card.keyword ? ` (키워드 "${card.keyword}")` : ''} — 도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0}·공유 ${m.shares ?? 0}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, brand);
        appendActivity(role, `📈 카드뉴스 성과 학습: ${card.topic.slice(0, 40)}`);
      } catch { /* 역할 부재 등 — 무해 */ }
    }
  }
  try {
    llmWikiFor(brand).upsertPage({
      title: `카드뉴스 성과: ${card.topic}`, type: 'performance',
      body:
        `도달 ${m.reach ?? 0} · 저장 ${m.saved ?? 0} · 공유 ${m.shares ?? 0} · 조회 ${m.views} · 좋아요 ${m.likes ?? 0} · 댓글 ${m.comments ?? 0} · 성과신호 ${signal.toFixed(2)}\n` +
        `키워드: ${card.keyword ?? '-'} · 브랜드: ${card.brand ?? '범용'}\n` +
        (card.igPermalink ? `\n[근거: ${card.igPermalink}]` : ''),
      summary: `카드뉴스 "${card.topic}" 성과신호 ${signal.toFixed(2)} (도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0})`,
      sources: [card.igPermalink ? `perf:${card.igPermalink}` : 'perf:meta'],
      aliases: card.keyword ? [card.keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }
  return signal;
}

/** 일일 카드뉴스 성과 동기화 — perf-sync 틱에서 piece·쇼츠 동기화와 나란히 호출. */
export async function syncCardnewsPerformance(): Promise<void> {
  try {
    const days = CONFIG.shortsPerfDays; // 측정 창은 쇼츠와 동일 상수 재사용(스펙 §7)
    const now = Date.now();
    const due = cardNewsStore().list().filter((x) => cardnewsPerfDue(x, now, days));
    for (const card of due) {
      try {
        const acct = getMetaAccount(card.brand ?? '');
        if (!acct.pageAccessToken) continue; // 브랜드 미연결(연결 해제됨) — 스킵
        const qs = `access_token=${encodeURIComponent(acct.pageAccessToken)}`;
        const ir = await fetchTimeout(`${GRAPH}/${card.igMediaId}/insights?metric=views,reach,saved,shares,likes,comments&${qs}`, {});
        if (!ir.ok) throw new Error(`IG insights HTTP ${ir.status}`);
        const ig = parseIgInsights(await ir.json());
        const igSample: MetricSample = {
          measuredAt: new Date().toISOString(),
          views: ig.views ?? 0, reach: ig.reach ?? 0, saved: ig.saved ?? 0, shares: ig.shares ?? 0,
          likes: ig.likes ?? 0, comments: ig.comments ?? 0, searchInflow: [], source: 'meta:ig',
        };
        appendMetrics(card.id, igSample);
        if (card.fbPostId) { // FB 는 부가 채널 — 실패해도 IG 수집·강화를 막지 않음
          try {
            const fr = await fetchTimeout(`${GRAPH}/${card.fbPostId}?fields=reactions.summary(true),comments.summary(true),shares&${qs}`, {});
            if (fr.ok) {
              const fb = parseFbEngagement(await fr.json());
              appendMetrics(card.id, { measuredAt: new Date().toISOString(), views: 0, likes: fb.likes, comments: fb.comments, shares: fb.shares, searchInflow: [], source: 'meta:fb' });
            }
          } catch { /* 부가 채널 fail-open */ }
        }
        const windowOver = now - new Date(card.publishedTs!).getTime() > days * 86_400_000;
        if (windowOver && !card.perfReflected) {
          const sig = reinforceCardnews(card, igSample);
          cardNewsStore().update(card.id, { perfReflected: true });
          console.log('[perf-sync]', `카드뉴스 강화 완료: ${card.topic.slice(0, 30)} (신호 ${sig.toFixed(2)})`);
        }
      } catch (e) { console.log('[perf-sync]', `카드뉴스 ${card.id} 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { console.log('[perf-sync]', `카드뉴스 동기화 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
}
```

- [ ] **Step 2: 틱 배선** — main.ts 의 perf-sync `startDaily` run 콜백(약 2422행)을 수정:

```typescript
  run: () => { void syncPerformance(); void syncShortsPerformance(); void syncCardnewsPerformance(); }, // 쇼츠·카드뉴스는 순수 API — 프로필 락 무관
```

import 라인에 `syncCardnewsPerformance` 추가(`../analytics/cardnewsPerf`).

- [ ] **Step 3: 검증** — Run: `npx tsc --noEmit` → 0 · `npx vitest run src/analytics src/tools src/jarvis` / Expected: 전체 PASS

- [ ] **Step 4: Commit**

```bash
git add src/analytics/cardnewsPerf.ts src/server/main.ts
git commit -m "feat(meta): syncCardnewsPerformance — IG 인사이트+FB 반응 일일 수집→저장률·공유율 신호로 기획자·디자이너 강화(멱등)"
```

---

### Task 9: 프론트 — 발행 버튼·링크·메타 연결

**Files:**
- Modify: `frontend/src/api.ts` — CardNews 타입 필드 + `publishCardNews`/`fetchMetaStatus`
- Modify: `frontend/src/panels/CardNewsView.tsx` — ready 카드에 발행 UI

**Interfaces:**
- Consumes: Task 6 `POST /cardnews/:id/publish`, Task 5 `GET /meta/status`
- Produces: 사용자 발행 버튼(연결 안 됐으면 "메타 연결" 링크), 발행 후 IG/FB 링크

- [ ] **Step 1: api.ts** — `CardNewsInfo` 인터페이스(api.ts:945)에 필드 추가:

```typescript
  igPermalink?: string;
  fbPostId?: string;
  publishedTs?: string;
```

함수 2개 추가(기존 shorts 유튜브 함수들 근처):

```typescript
export async function publishCardNews(id: string): Promise<{ ok?: boolean; igPermalink?: string; fbPostId?: string; error?: string }> {
  try { const r = await fetch(`/cardnews/${id}/publish`, { method: "POST" }); return await r.json(); }
  catch { return { error: "요청 실패" }; }
}
export async function fetchMetaStatus(): Promise<{ client: boolean; connected: boolean }> {
  try { const r = await fetch("/meta/status"); return await r.json() as { client: boolean; connected: boolean }; }
  catch { return { client: false, connected: false }; }
}
```

- [ ] **Step 2: CardNewsView.tsx — CardRow 시그니처 확장(51행)**:

```tsx
function CardRow({ card, onDelete, metaReady, onChanged }: {
  card: CardNewsInfo; onDelete: (id: string) => void; metaReady: boolean; onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const doPublish = async () => {
    setPublishing(true);
    const r = await publishCardNews(card.id);
    setPublishing(false);
    if (r.error) alert(`발행 실패: ${r.error}`); // doDelete 의 기존 alert 관례
    onChanged(); // 부분 성공도 링크가 바로 보이게 즉시 재조회(폴링 8초 대기 없이)
  };
```

`card.stage === "ready"` 블록 안(캡션 복사 버튼 옆)에 발행 UI 추가 — ShortsView 유튜브 버튼 블록(101-112행) 미러:

```tsx
{card.igPermalink || card.fbPostId ? (
  <span style={{ display: "inline-flex", gap: 6 }}>
    {card.igPermalink && <a className="btn ghost" href={card.igPermalink} target="_blank" rel="noreferrer">📸 인스타그램</a>}
    {card.fbPostId && <a className="btn ghost" href={`https://www.facebook.com/${card.fbPostId}`} target="_blank" rel="noreferrer">📘 페이스북</a>}
  </span>
) : metaReady ? (
  <button className="btn" disabled={publishing} onClick={doPublish}>
    {publishing ? "발행 중…" : "📤 인스타·페북 발행"}
  </button>
) : (
  <a className="btn ghost" href="/meta/oauth/start" target="_blank" rel="noreferrer" title="이 브랜드의 메타(페이스북) 계정으로 로그인해 1회 연결 — 앱 ID/시크릿은 키 탭에서 먼저 설정">📤 메타 연결</a>
)}
```

`CardNewsSection`(98행)에 상태 1개 추가하고 CardRow 렌더에 prop 전달:

```tsx
const [metaReady, setMetaReady] = useState(false);
// 기존 useEffect(load 폴링) 안 또는 별도 useEffect 로 1회 조회:
useEffect(() => { fetchMetaStatus().then((s) => setMetaReady(s.client && s.connected)); }, []);
// 렌더부의 <CardRow card={...} onDelete={doDelete} /> → 아래로 교체:
// <CardRow card={c} onDelete={doDelete} metaReady={metaReady} onChanged={load} />
```

import 라인에 `publishCardNews, fetchMetaStatus` 추가(../api).

- [ ] **Step 3: 검증** — Run: `cd frontend && npx tsc --noEmit -p tsconfig.json` / Expected: 0. 그리고 `npm run build` (frontend/) — dist 서빙 모드이므로 빌드까지 확인.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.ts frontend/src/panels/CardNewsView.tsx
git commit -m "feat(meta): 카드뉴스 발행 버튼·메타 연결·발행 링크 UI(쇼츠 유튜브 버튼 미러)"
```

---

### Task 10: 최종 검증 + 문서

**Files:**
- Modify: 없음(검증) · 필요 시 위 Task 파일들의 결함 수정

- [ ] **Step 1: 전체 검증**

```bash
npx tsc --noEmit && (cd frontend && npx tsc --noEmit -p tsconfig.json)
npx vitest run
```
Expected: tsc 0 + 전체 테스트 PASS(기존 스위트 회귀 없음).

- [ ] **Step 2: 스펙 대조** — 스펙 §2 성공 기준 1~6을 훑고 각 항목의 구현 위치를 확인(1→Task 6·9, 2→Task 4, 3→Task 8, 4→Task 8, 5→Task 8 fail-open, 6→Task 4·6). 미달 항목이 있으면 해당 Task 로 돌아가 수정.

- [ ] **Step 3: 수동 실검증 안내 출력** — 코드가 아니라 사용자 절차(스펙 §4 체크리스트): 페이지·IG 계정 개설 → 키 탭에 앱 ID/시크릿 → 브랜드 활성화 후 카드뉴스 탭 "메타 연결" → 카드 1건 실발행 → 다음날 `[perf-sync]` 로그와 `data/analytics/metrics/<id>.jsonl` 확인.

- [ ] **Step 4: Commit(잔여 수정이 있었던 경우만)**

```bash
git add -A && git commit -m "chore(meta): 카드뉴스 메타 발행 최종 검증 잔여 수정"
```
