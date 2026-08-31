# 숏폼 메타 발행(IG 릴스·FB 릴스) + 성과 측정 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `stage:'ready'` 쇼츠를 버튼 한 번으로 인스타 릴스+페북 릴스에 발행(즉시 공개)하고, IG 인사이트를 기존 쇼츠 측정 루프에 채널 독립으로 통합한다.

**Architecture:** 카드뉴스 메타 사이클의 인프라(META_TOKENS·OAuth·GRAPH·graphJson·buildIgCaption·parseIgInsights·cardnewsSignal·shouldRecordMemory)를 전부 재사용. 영상은 공개 URL 불필요 — IG resumable(rupload 바이너리)·FB video_reels 3단계. 스펙: `docs/superpowers/specs/2026-07-10-shorts-meta-reels-design.md`.

**Tech Stack:** TypeScript(Node 20 내장 fetch — 새 의존성 없음), Hono, vitest.

## Global Constraints

- Graph 호스트·버전은 `metaPublish.ts`의 `GRAPH`(v23.0) 단일 상수. rupload 호스트도 metaPublish.ts 한 곳에만: `const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload/v23.0'`
- 새 npm 의존성 금지
- 토큰을 로그·에러 메시지에 싣지 않는다(rupload `Authorization: OAuth <token>` 헤더는 API 필수라 허용)
- 브랜드 폴백 없음(미연결 명확 에러), 발행은 명시 실패 반환(이형 응답 전부 throw — 성공 위장 금지), 부분 성공 멱등(existing 채널 스킵)
- 측정은 전량 fail-open(쇼츠별 격리), 기존 유튜브 루프(`shortsPerfDue`·`reinforceShorts`·`syncShortsPerformance`) 무접촉 — 예외는 스펙 §4.3의 게이트 소스 필터 1줄 보정뿐
- 테스트는 변별력 규약: 가드/분기를 제거하면 실제로 깨지는 mock 구성(카드뉴스 사이클 교훈)
- 주석·메시지 한국어(404 식별 문자열 'unknown shorts'류 영문 관용구는 기존 유지), 각 파일 기존 스타일 준수
- 각 Task 커밋 전: `npx tsc --noEmit` 0 + 해당 vitest 통과. `git add`는 명시 경로만(병렬 세션 주의)

---

### Task 1: Shorts 레코드 메타 발행·성과 필드

**Files:**
- Modify: `src/content/shorts.ts` (Shorts 인터페이스, `perfReflected?: boolean;` 아래·`createdTs` 위)

**Interfaces:**
- Produces: `Shorts`에 `igReelId?: string; igPermalink?: string; fbReelId?: string; metaPublishedTs?: string; metaPerfReflected?: boolean` — Task 2·3·4·5가 사용

- [ ] **Step 1: 필드 추가** — `perfReflected?: boolean;` 바로 아래 삽입:

```typescript
  /** 메타 발행 결과(인스타 릴스 미디어 id·퍼머링크, 페북 릴스 video id) — 유튜브 발행과 독립. */
  igReelId?: string;
  igPermalink?: string;
  fbReelId?: string;
  /** 메타 첫 채널 발행 성공 시각 — 메타 성과 측정 창 기준점(youtubeTs 와 독립). */
  metaPublishedTs?: string;
  /** 메타 측정 창 경과 후 강화 1회 완료(멱등) — perfReflected(유튜브)와 독립. */
  metaPerfReflected?: boolean;
```

- [ ] **Step 2: 검증** — Run: `npx tsc --noEmit` / Expected: 0

- [ ] **Step 3: Commit**

```bash
git add src/content/shorts.ts
git commit -m "feat(reels): Shorts 메타 발행·성과 필드(igReelId·igPermalink·fbReelId·metaPublishedTs·metaPerfReflected)"
```

---

### Task 2: publishShortsToMeta — IG 릴스 resumable + FB 릴스 3단계

**Files:**
- Modify: `src/tools/metaPublish.ts` (waitContainer 파라미터화 + 파일 끝에 릴스 블록 추가)
- Test: `src/tools/metaPublish.test.ts` (describe 추가 — 기존 테스트 유지)

**Interfaces:**
- Consumes: 기존 `GRAPH`·`graphJson`·`tokenQs`·`buildIgCaption`·`extractId`·`parsePermalink`·`graphError`·`getMetaAccount`·`waitContainer`
- Produces: `RUPLOAD`(상수), `interface MetaReelsResult { ok: boolean; igReelId?: string; igPermalink?: string; fbReelId?: string; error?: string }`, `publishShortsToMeta(opts: { slug: string; videoPath: string; caption: string; hashtags: string[]; existing?: { igPermalink?: string; fbReelId?: string }; signal?: AbortSignal }): Promise<MetaReelsResult>` · `waitContainer` 시그니처가 `(containerId, token, signal?, maxTries = 10)` 로 확장(기존 호출 무변경)

- [ ] **Step 1: 실패하는 테스트 작성** — metaPublish.test.ts 에 describe 추가(기존 vi.mock 재사용):

```typescript
import { publishShortsToMeta } from './metaPublish';

describe('publishShortsToMeta', () => {
  it('브랜드 미연결 → 명확한 에러(네트워크 호출 없음)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: '', pageAccessToken: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await publishShortsToMeta({ slug: 'x', videoPath: '/tmp/none.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('메타 미연결');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('영상 파일 없음 → 에러', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('영상 파일');
  });
  it('happy path: IG 컨테이너→rupload→폴링→발행→permalink + FB start→upload→finish', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); calls.push(u);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('rupload.facebook.com') || u.includes('UPLOAD_URL') ? { success: true }
        : u.includes('/media_publish') ? { id: 'REEL1' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/reel/x/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/IG/media') ? { id: 'CT1' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? { video_id: 'FBV1', upload_url: 'https://rupload.facebook.com/UPLOAD_URL' }
        : u.includes('/PG/video_reels') ? { success: true }   // finish
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: '제목\n\n설명', hashtags: ['#t'] });
    expect(r).toMatchObject({ ok: true, igReelId: 'REEL1', igPermalink: 'https://www.instagram.com/reel/x/', fbReelId: 'FBV1' });
    expect(calls.filter((c) => c.includes('rupload.facebook.com')).length).toBe(2); // IG 바이너리 + FB 바이너리
  });
  it('rupload 이형(success 없음) → ok:false + FB 미진행(변별력: FB 성공 mock 준비)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); calls.push(u);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('rupload.facebook.com') ? {}                         // ← 이형: success 없음
        : u.includes('/IG/media') ? { id: 'CT1' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? { video_id: 'FBV1', upload_url: 'https://rupload.facebook.com/UPLOAD_URL' }
        : u.includes('/PG/video_reels') ? { success: true }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('릴스 업로드');
    expect(r.fbReelId).toBeUndefined();                                  // IG 실패가 FB 진행을 막음
    expect(calls.some((c) => c.includes('/PG/video_reels'))).toBe(false);
  });
  it('FB start 이형(video_id 없음) → ok:false, 단 IG 부분 성공은 결과에 보존', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('rupload.facebook.com') ? { success: true }
        : u.includes('/media_publish') ? { id: 'REEL9' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/reel/y/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/IG/media') ? { id: 'CT9' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? {}   // ← 이형: video_id 없음
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('FB 릴스 시작');
    expect(r.igReelId).toBe('REEL9');   // 부분 성공 보존 — 라우트가 저장·재시도 시 IG 스킵
  });
  it('부분 성공 멱등: existing.igPermalink 있으면 IG 경로 무호출, FB 만 발행', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); calls.push(u);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? { video_id: 'FBV2', upload_url: 'https://rupload.facebook.com/UPLOAD_URL' }
        : u.includes('UPLOAD_URL') ? { success: true }
        : u.includes('/PG/video_reels') ? { success: true }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({
      slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [],
      existing: { igPermalink: 'https://www.instagram.com/reel/done/' },
    });
    expect(r.ok).toBe(true);
    expect(r.fbReelId).toBe('FBV2');
    expect(calls.some((c) => c.includes('/IG/media'))).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/tools/metaPublish.test.ts` / Expected: 신규 6케이스 FAIL(`publishShortsToMeta` 미정의)

- [ ] **Step 3: 구현** — ① `waitContainer` 시그니처를 `(containerId: string, token: string, signal?: AbortSignal, maxTries = 10)` 로 바꾸고 루프를 `for (let i = 0; i < maxTries; i++)` 로 수정(기존 호출부 무변경, 주석의 "3초×10회"를 "3초×maxTries회"로). ② 파일 끝에 추가:

```typescript
// ── 쇼츠 릴스 발행 ───────────────────────────────────────────────────────────
// 영상은 공개 URL 불필요 — IG 는 resumable(rupload 바이너리), FB 는 video_reels 3단계(start→binary→finish).
// 릴스는 발행 즉시 공개(비공개·초안 없음, 스펙 §3) — 버튼 클릭=공개 발행 정책.
const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload/v23.0'; // 버전은 GRAPH 와 동일 유지

export interface MetaReelsResult {
  ok: boolean; igReelId?: string; igPermalink?: string; fbReelId?: string; error?: string;
}

/** 업로드 URI 에 영상 바이너리 POST(IG rupload·FB upload_url 공통 규약) — {success:true} 아니면 throw. */
async function uploadVideoBinary(uploadUrl: string, token: string, videoPath: string, what: string, signal?: AbortSignal): Promise<void> {
  const buf = fs.readFileSync(videoPath);
  const r = await fetch(uploadUrl, {
    method: 'POST', signal,
    headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(buf.byteLength), 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const j: unknown = await r.json().catch(() => ({}));
  if (!r.ok || !(j as { success?: boolean }).success) throw new Error(`${what} 실패: ${graphError(j, r.status)}`);
}

/** FB 릴스 3단계 — start(video_id·upload_url) → 바이너리 → finish(PUBLISHED). video_id 반환. */
async function publishFbReel(pageId: string, token: string, videoPath: string, description: string, signal?: AbortSignal): Promise<string> {
  const start = await graphJson(`${GRAPH}/${pageId}/video_reels`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ upload_phase: 'start', access_token: token }),
  }, 'FB 릴스 시작') as { video_id?: string; upload_url?: string };
  if (!start.video_id || !start.upload_url) throw new Error('FB 릴스 시작 응답 이형');
  await uploadVideoBinary(start.upload_url, token, videoPath, 'FB 릴스 업로드', signal);
  await graphJson(`${GRAPH}/${pageId}/video_reels`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description, access_token: token }),
  }, 'FB 릴스 발행');
  return start.video_id;
}

export async function publishShortsToMeta(opts: {
  slug: string; videoPath: string; caption: string; hashtags: string[];
  existing?: { igPermalink?: string; fbReelId?: string }; signal?: AbortSignal;
}): Promise<MetaReelsResult> {
  const out: MetaReelsResult = { ok: false };
  try {
    const acct = getMetaAccount(opts.slug);
    if (!acct.pageId || !acct.igUserId || !acct.pageAccessToken) {
      return { ok: false, error: '메타 미연결 — 카드뉴스/숏폼 탭에서 메타 연결을 먼저 하세요' };
    }
    if (!fs.existsSync(opts.videoPath)) return { ok: false, error: '영상 파일 없음' };
    const timeout = AbortSignal.timeout(600_000); // 영상 업로드+인코딩 — 카드뉴스(5분)의 2배 여유
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const message = buildIgCaption(opts.caption, opts.hashtags);
    const token = acct.pageAccessToken;

    // ① IG 릴스 — 기발행(existing.igPermalink)이면 스킵(부분 성공 재시도 멱등).
    if (!opts.existing?.igPermalink) {
      const container = await graphJson(`${GRAPH}/${acct.igUserId}/media`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable', caption: message, share_to_feed: 'true', access_token: token }),
      }, 'IG 릴스 컨테이너');
      const cid = extractId(container);
      if (!cid) throw new Error('IG 릴스 컨테이너 응답 이형');
      await uploadVideoBinary(`${RUPLOAD}/${cid}`, token, opts.videoPath, 'IG 릴스 업로드', signal);
      await waitContainer(cid, token, signal, 60); // 영상 인코딩 — 3초×60회(이미지 캐러셀 10회보다 여유)
      const pub = await graphJson(`${GRAPH}/${acct.igUserId}/media_publish`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: cid, access_token: token }),
      }, 'IG 릴스 발행');
      out.igReelId = extractId(pub) ?? undefined;
      if (!out.igReelId) throw new Error('IG 릴스 발행 응답 이형(id 없음)');
      const perma = await graphJson(`${GRAPH}/${out.igReelId}?fields=permalink&${tokenQs(token)}`, { signal }, 'IG 퍼머링크').catch(() => null);
      out.igPermalink = (perma === null ? null : parsePermalink(perma)) ?? 'https://www.instagram.com/';
    }

    // ② FB 릴스 — 기발행(existing.fbReelId)이면 스킵.
    if (!opts.existing?.fbReelId) {
      out.fbReelId = await publishFbReel(acct.pageId, token, opts.videoPath, message, signal);
    }

    out.ok = true;
    return out;
  } catch (e) {
    // 채널별 부분 성공은 out 에 남아 있음 — 라우트가 성공분을 저장하고 실패 원인만 보고(성공 위장 금지).
    out.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    if (/limit/i.test(out.error)) out.error += ' — 24시간 발행 한도 가능성: content_publishing_limit 확인';
    return out;
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/tools/metaPublish.test.ts` / Expected: 전체 PASS(기존 10 + 신규 6) · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/tools/metaPublish.ts src/tools/metaPublish.test.ts
git commit -m "feat(reels): publishShortsToMeta — IG resumable+FB video_reels 3단계, 부분 성공 멱등·이형 가드"
```

---

### Task 3: POST /shorts/:id/meta 라우트 + publish_video scope

**Files:**
- Modify: `src/server/main.ts` — ①`META_SCOPES`에 `publish_video` 추가 ②`app.post('/cardnews/:id/publish', ...)` 블록 바로 아래에 라우트 추가 ③`../content/shorts` import 라인에 `type Shorts` 추가, `../tools/metaPublish` import 라인에 `publishShortsToMeta` 추가
- Test: `src/tools/metaEndpoints.test.ts` (케이스 추가)

**Interfaces:**
- Consumes: Task 1 필드, Task 2 `publishShortsToMeta`, 기존 `shortsStore`(`dirFor(id)` 존재 — `/shorts/:id/youtube` 라우트가 사용 중)
- Produces: `POST /shorts/:id/meta` → 200 `{ ok, igPermalink?, fbReelId? }` / 404 / 409 / 502

- [ ] **Step 1: 실패하는 테스트 작성** — metaEndpoints.test.ts 에 추가:

```typescript
describe('POST /shorts/:id/meta 가드', () => {
  it('미존재 id → 404(JSON 본문 단언 — Hono 폴백과 변별)', async () => {
    const res = await app.request('/shorts/nope-xyz/meta', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown shorts' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/tools/metaEndpoints.test.ts` / Expected: 신규 케이스 FAIL(`res.json()` 파싱 실패 — Hono 기본 404는 text)

- [ ] **Step 3: 구현** — ① `META_SCOPES` 문자열 끝에 `,publish_video` 추가(FB 릴스 발행 권한 — 스펙 §5). ② 라우트:

```typescript
app.post('/shorts/:id/meta', async (c) => {
  const id = c.req.param('id') ?? '';
  const s = shortsStore().get(id);
  if (!s) return c.json({ error: 'unknown shorts' }, 404);
  if (s.stage !== 'ready') return c.json({ error: '완성(ready) 상태가 아닙니다' }, 409);
  if (s.igPermalink && s.fbReelId) return c.json({ error: '이미 발행됨', igPermalink: s.igPermalink }, 409);
  const videoPath = path.join(shortsStore().dirFor(id), 'final.mp4');
  if (!fs.existsSync(videoPath)) return c.json({ error: '영상 파일 없음' }, 409);
  const r = await publishShortsToMeta({
    slug: s.brand ?? '', videoPath,
    caption: [s.title ?? s.topic, s.description ?? ''].filter(Boolean).join('\n\n'),
    hashtags: s.hashtags ?? [],
    existing: { igPermalink: s.igPermalink, fbReelId: s.fbReelId },
  });
  // 부분 성공도 저장 — 재시도 시 성공 채널은 existing 으로 스킵(멱등). 릴스는 즉시 공개(스펙 §3).
  const patch: Partial<Shorts> = {};
  if (r.igReelId) { patch.igReelId = r.igReelId; patch.igPermalink = r.igPermalink; }
  if (r.fbReelId) patch.fbReelId = r.fbReelId;
  if ((r.igReelId || r.fbReelId) && !s.metaPublishedTs) patch.metaPublishedTs = new Date().toISOString();
  if (Object.keys(patch).length) shortsStore().update(id, patch);
  if (!r.ok) return c.json({ error: r.error, ...patch }, 502);
  console.log(`[발행담당] ${(s.title ?? s.topic).slice(0, 30)} — 릴스 발행 완료(IG·FB, 즉시 공개)`);
  return c.json({ ok: true, igPermalink: r.igPermalink ?? s.igPermalink, fbReelId: r.fbReelId ?? s.fbReelId });
});
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/tools/metaEndpoints.test.ts` / Expected: 전체 PASS · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/server/main.ts src/tools/metaEndpoints.test.ts
git commit -m "feat(reels): POST /shorts/:id/meta — 409 가드·부분 성공 저장·멱등 + OAuth scope publish_video"
```

---

### Task 4: 성과 순수부 — shortsMetaPerfDue·countSamples + 유튜브 게이트 소스 필터 보정

**Files:**
- Modify: `src/analytics/shortsPerf.ts` (순수 함수 2개 추가 + `reinforceShorts` 게이트 1줄 보정)
- Test: `src/analytics/shortsPerf.test.ts` (기존 파일 — describe 2개 추가, 기존 테스트 유지. import 라인에 `countSamples, shortsMetaPerfDue` 추가)

**Interfaces:**
- Consumes: Task 1 `Shorts` 메타 필드, 기존 `MetricSample`
- Produces: `countSamples(samples: Pick<MetricSample, 'source'>[], source: string): number` · `shortsMetaPerfDue(s: Pick<Shorts, 'igReelId' | 'metaPublishedTs' | 'metaPerfReflected'>, now: number, days: number): boolean` — Task 5가 사용

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { countSamples, shortsMetaPerfDue } from './shortsPerf';

describe('countSamples', () => {
  it('소스 필터 카운트 — 메타 샘플 혼입 시 유튜브 카운트 불변(게이트 회귀)', () => {
    const samples = [
      { source: 'youtube:api' }, { source: 'meta:ig' }, { source: 'meta:fb' },
      { source: 'youtube:api' }, { source: undefined },
    ];
    expect(countSamples(samples, 'youtube:api')).toBe(2);   // 메타 3건 혼입돼도 2
    expect(countSamples(samples, 'meta:ig')).toBe(1);
    expect(countSamples([], 'youtube:api')).toBe(0);
  });
});
describe('shortsMetaPerfDue', () => {
  const day = 86_400_000;
  it('igReelId·metaPublishedTs 없음 → false', () => {
    expect(shortsMetaPerfDue({}, Date.now(), 7)).toBe(false);
    expect(shortsMetaPerfDue({ igReelId: 'r' }, Date.now(), 7)).toBe(false);
  });
  it('창 내 매일 true / 창 경과+미강화 true / 강화 완료 false / 포기 지평(4배) false', () => {
    const now = Date.now();
    const at = (d: number): string => new Date(now - d * day).toISOString();
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(3) }, now, 7)).toBe(true);
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(10) }, now, 7)).toBe(true);
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(10), metaPerfReflected: true }, now, 7)).toBe(false);
    expect(shortsMetaPerfDue({ igReelId: 'r', metaPublishedTs: at(30) }, now, 7)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/analytics/shortsPerf.test.ts` / Expected: FAIL(미정의)

- [ ] **Step 3: 구현** — shortsPerf.ts 의 `shouldRecordMemory` 아래에 추가:

```typescript
/** 소스별 샘플 수(순수) — 유튜브·메타 샘플이 한 JSONL 에 공존하므로 게이트 카운트는 소스 필터 필수
 *  (무필터 시 메타 샘플 혼입으로 카운트가 부풀어 비공개→늦공개 오귀속 방지 게이트가 무력화됨, 스펙 §4.3). */
export function countSamples(samples: Pick<MetricSample, 'source'>[], source: string): number {
  return samples.filter((s) => s.source === source).length;
}
/** 이번 틱 메타(릴스) 수집 대상인가(순수) — shortsPerfDue 의 메타 채널 판. 유튜브 창과 독립. */
export function shortsMetaPerfDue(
  s: Pick<Shorts, 'igReelId' | 'metaPublishedTs' | 'metaPerfReflected'>, now: number, days: number,
): boolean {
  if (!s.igReelId || !s.metaPublishedTs) return false;
  const t = new Date(s.metaPublishedTs).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age > days * 4 * 86_400_000) return false; // 포기 지평(측정창 4배) — 삭제 릴스 무한 재시도 방지
  return age <= days * 86_400_000 || !s.metaPerfReflected;
}
```

그리고 `reinforceShorts` 의 게이트 라인(기존 `if (shouldRecordMemory(signal, readMetrics(s.id).length)) {`)을 다음으로 교체:

```typescript
  if (shouldRecordMemory(signal, countSamples(readMetrics(s.id), 'youtube:api'))) {
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/analytics` / Expected: 전체 PASS(기존 cardnewsPerf 포함) · `npx tsc --noEmit` → 0

- [ ] **Step 5: Commit**

```bash
git add src/analytics/shortsPerf.ts src/analytics/shortsPerf.test.ts
git commit -m "feat(reels): 메타 측정 순수부(shortsMetaPerfDue·countSamples) + 유튜브 게이트 소스 필터 보정(혼입 회귀 방지)"
```

---

### Task 5: syncShortsMetaPerformance + 강화 + 틱 배선

**Files:**
- Modify: `src/analytics/shortsPerf.ts` (파일 끝에 함수 2개 + import 추가)
- Modify: `src/server/main.ts` — perf-sync `startDaily` run 콜백에 1줄 + import

**Interfaces:**
- Consumes: Task 4 `shortsMetaPerfDue`·`countSamples`, 기존 `cardnewsSignal`·`parseIgInsights`(../analytics/cardnewsPerf), `getMetaAccount`(../secrets/store), `GRAPH`(../tools/metaPublish)
- Produces: `syncShortsMetaPerformance(): Promise<void>` — main.ts 틱이 호출

- [ ] **Step 1: 구현** — shortsPerf.ts import 에 추가: `import { getMetaAccount } from '../secrets/store';` · `import { GRAPH } from '../tools/metaPublish';` · `import { cardnewsSignal, parseIgInsights } from './cardnewsPerf';`

주의: cardnewsPerf.ts 가 이미 `shouldRecordMemory` 를 shortsPerf 에서 import 하므로 **순환 import**가 생긴다 — 두 모듈 모두 함수 선언만 있고 최상위에서 상대 export 를 호출하지 않으므로 ESM 에서 안전(호출은 전부 런타임). import 라인 옆에 한 줄 주석으로 남겨라: `// cardnewsPerf ↔ shortsPerf 순환 — 함수 선언만이라 안전(최상위 상호 호출 없음)`. 파일 끝에:

```typescript
/** 릴스 강화 1회 — reinforceShorts 의 메타 채널 판. 신호는 도달·저장률·공유율(cardnewsSignal 재사용). */
function reinforceShortsMeta(s: Shorts, m: MetricSample): number {
  const signal = cardnewsSignal(m.reach ?? 0, m.saved ?? 0, m.shares ?? 0);
  const keyword = s.sourcePieceId
    ? (() => { try { return pieceStore().get(s.sourcePieceId!)?.keyword; } catch { return undefined; } })() ?? s.keyword
    : s.keyword;
  const brand = s.brand && isSafeBrandSlug(s.brand) ? s.brand : '';
  const title = s.title ?? s.topic;
  const verdict = signal >= 0.6 ? '이 주제·훅이 릴스에서 저장·공유로 이어짐 — 유사 각도 유지' : '릴스 저장·공유 저조 — 훅·초반 5초 재고';
  if (shouldRecordMemory(signal, countSamples(readMetrics(s.id), 'meta:ig'))) {
    for (const role of ['shorts_writer', 'shorts_director']) {
      try {
        appendMemory(role, `릴스 성과: "${title}"${keyword ? ` (키워드 "${keyword}")` : ''} — 도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0}·공유 ${m.shares ?? 0}·조회 ${m.views}, 성과신호 ${signal.toFixed(2)}. ${verdict}.`, brand);
        appendActivity(role, `📈 릴스 성과 학습: ${title.slice(0, 40)}`);
      } catch { /* 역할 부재 등 — 무해 */ }
    }
  }
  try {
    llmWikiFor(brand).upsertPage({
      title: `릴스 성과: ${title}`, type: 'performance',
      body:
        `도달 ${m.reach ?? 0} · 저장 ${m.saved ?? 0} · 공유 ${m.shares ?? 0} · 조회 ${m.views} · 좋아요 ${m.likes ?? 0} · 댓글 ${m.comments ?? 0} · 성과신호 ${signal.toFixed(2)}\n` +
        `키워드: ${keyword ?? '-'} · 브랜드: ${s.brand ?? '범용'}\n` +
        (s.igPermalink ? `\n[근거: ${s.igPermalink}]` : ''),
      summary: `릴스 "${title}" 성과신호 ${signal.toFixed(2)} (도달 ${m.reach ?? 0}·저장 ${m.saved ?? 0})`,
      sources: [s.igPermalink ? `perf:${s.igPermalink}` : 'perf:meta'],
      aliases: keyword ? [keyword] : [],
    });
  } catch { /* 위키 실패는 강화를 막지 않음 */ }
  return signal;
}

/** 일일 릴스 성과 동기화 — perf-sync 틱에서 유튜브·카드뉴스 동기화와 나란히 호출. 전량 fail-open. */
export async function syncShortsMetaPerformance(): Promise<void> {
  try {
    const days = CONFIG.shortsPerfDays;
    const now = Date.now();
    const due = shortsStore().list().filter((s) => shortsMetaPerfDue(s, now, days));
    for (const s of due) {
      try {
        const acct = getMetaAccount(s.brand ?? '');
        if (!acct.pageAccessToken) continue; // 브랜드 미연결(연결 해제됨) — 스킵
        const r = await fetchTimeout(`${GRAPH}/${s.igReelId}/insights?metric=views,reach,likes,comments,saved,shares&access_token=${encodeURIComponent(acct.pageAccessToken)}`, {});
        if (!r.ok) throw new Error(`IG insights HTTP ${r.status}`);
        const ig = parseIgInsights(await r.json());
        const sample: MetricSample = {
          measuredAt: new Date().toISOString(),
          views: ig.views ?? 0, reach: ig.reach ?? 0, saved: ig.saved ?? 0, shares: ig.shares ?? 0,
          likes: ig.likes ?? 0, comments: ig.comments ?? 0, searchInflow: [], source: 'meta:ig',
        };
        appendMetrics(s.id, sample);
        const windowOver = now - new Date(s.metaPublishedTs!).getTime() > days * 86_400_000;
        if (windowOver && !s.metaPerfReflected) {
          const sig = reinforceShortsMeta(s, sample);
          shortsStore().update(s.id, { metaPerfReflected: true });
          console.log('[perf-sync]', `릴스 강화 완료: ${(s.title ?? s.topic).slice(0, 30)} (신호 ${sig.toFixed(2)})`);
        }
      } catch (e) { console.log('[perf-sync]', `릴스 ${s.id} 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { console.log('[perf-sync]', `릴스 동기화 실패(무해): ${e instanceof Error ? e.message : String(e)}`); }
}
```

- [ ] **Step 2: 틱 배선** — main.ts perf-sync `startDaily` run 콜백을 다음으로(카드뉴스 배선 라인과 같은 줄):

```typescript
  run: () => { void syncPerformance(); void syncShortsPerformance(); void syncCardnewsPerformance(); void syncShortsMetaPerformance(); }, // 쇼츠·카드뉴스·릴스는 순수 API — 프로필 락 무관
```

import 라인(`../analytics/shortsPerf`)에 `syncShortsMetaPerformance` 추가.

- [ ] **Step 3: 검증** — Run: `npx tsc --noEmit` → 0 · `npx vitest run src/analytics src/tools src/jarvis` / Expected: 전체 PASS

- [ ] **Step 4: Commit**

```bash
git add src/analytics/shortsPerf.ts src/server/main.ts
git commit -m "feat(reels): syncShortsMetaPerformance — IG 릴스 인사이트 일일 수집→채널 독립 강화(metaPerfReflected 멱등)"
```

---

### Task 6: 프론트 — 릴스 발행 버튼·링크·메타 연결

**Files:**
- Modify: `frontend/src/api.ts` — `ShortsInfo`(993행 부근)에 `igPermalink?: string; fbReelId?: string;` 추가 + `uploadShortsYoutube` 아래에 함수 추가
- Modify: `frontend/src/panels/ShortsView.tsx` — `ShortRow` props·상태·UI + `ShortsSection` 상태

**Interfaces:**
- Consumes: Task 3 `POST /shorts/:id/meta`, 기존 `fetchMetaStatus`(카드뉴스 사이클이 추가)
- Produces: 릴스 발행 버튼(3분기)·발행 후 IG/FB 링크

- [ ] **Step 1: api.ts** — `ShortsInfo`에 `igPermalink?: string; fbReelId?: string;` (youtubeUrl 아래). `uploadShortsYoutube` 아래에:

```typescript
export async function publishShortsMeta(id: string): Promise<{ ok?: boolean; igPermalink?: string; fbReelId?: string; error?: string }> {
  try { const r = await fetch(`/shorts/${id}/meta`, { method: "POST" }); return await r.json(); }
  catch { return { error: "요청 실패" }; }
}
```

- [ ] **Step 2: ShortsView.tsx** — ① import 에 `publishShortsMeta`와 `fetchMetaStatus` 추가(../api). ② `ShortRow` 시그니처(38행)에 `metaReady: boolean` 추가:

```tsx
function ShortRow({ s, onDelete, yt, metaReady, onChanged }: {
  s: ShortsInfo; onDelete: (id: string) => void;
  yt: { client: boolean; connected: boolean }; metaReady: boolean; onChanged: () => void;
}) {
```

③ `doYoutube` 아래에 상태·핸들러:

```tsx
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaErr, setMetaErr] = useState("");
  const doMeta = async () => {
    setMetaBusy(true); setMetaErr("");
    const r = await publishShortsMeta(s.id);
    setMetaBusy(false);
    if (r.error) setMetaErr(r.error);
    onChanged(); // 부분 성공 링크도 즉시 반영
  };
```

④ 유튜브 3분기 블록(`{ytErr && ...}` 라인) 바로 앞에 릴스 3분기 추가:

```tsx
            {s.igPermalink || s.fbReelId ? (
              <span style={{ display: "inline-flex", gap: 6 }}>
                {s.igPermalink && <a className="btn ghost" href={s.igPermalink} target="_blank" rel="noreferrer">📸 릴스</a>}
                {s.fbReelId && <a className="btn ghost" href={`https://www.facebook.com/reel/${s.fbReelId}`} target="_blank" rel="noreferrer">📘 FB 릴스</a>}
              </span>
            ) : metaReady ? (
              <button className="btn ghost" disabled={metaBusy} onClick={doMeta} title="인스타 릴스+페북 릴스로 발행 — 릴스는 즉시 공개됩니다">
                {metaBusy ? "릴스 발행 중…" : "📤 릴스 발행(즉시 공개)"}
              </button>
            ) : (
              <a className="btn ghost" href="/meta/oauth/start" target="_blank" rel="noreferrer" title="이 브랜드의 메타 계정으로 1회 연결(카드뉴스와 공용)">📤 메타 연결</a>
            )}
            {metaErr && <span className="muted" style={{ color: "var(--con)" }}>{metaErr}</span>}
```

⑤ `ShortsSection`: `const [yt, setYt] = ...`(132행) 아래에 `const [metaReady, setMetaReady] = useState(false);` — `load()`(134행)에 `fetchMetaStatus().then((m) => setMetaReady(m.client && m.connected));` 추가. ⑥ `<ShortRow ...>` 렌더 호출부에 `metaReady={metaReady}` prop 추가.

- [ ] **Step 3: 검증** — Run: `cd frontend && npx tsc --noEmit -p tsconfig.json` → 0 · `npm run build` 성공(dist 서빙 모드) · 루트에서 `npx vitest run frontend/src` PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.ts frontend/src/panels/ShortsView.tsx
git commit -m "feat(reels): 쇼츠 릴스 발행 버튼·링크·메타 연결 UI(즉시 공개 명시)"
```

---

### Task 7: 최종 검증

**Files:** 없음(검증) · 필요 시 위 Task 파일들의 결함 수정

- [ ] **Step 1: 전체 검증**

```bash
npx tsc --noEmit && (cd frontend && npx tsc --noEmit -p tsconfig.json)
npx vitest run
```
Expected: tsc 0 + 전체 PASS(기존 스위트 회귀 없음).

- [ ] **Step 2: 스펙 대조** — §2 성공 기준 1~6 구현 위치 확인(1→T2·3·6, 2→T4 보정 1줄 외 기존 무접촉 diff 확인, 3→T5, 4→T5, 5→T2·3, 6→T5 fail-open). 미달 시 해당 Task 로 복귀.

- [ ] **Step 3: 수동 실검증 안내 출력** — 메타 연결(카드뉴스와 공용 — 단, scope 에 publish_video 가 추가됐으므로 **기연결 브랜드는 재연결 1회 필요**) → 쇼츠 1건 릴스 발행 → IG/FB 링크·릴스 탭 노출 확인 → 익일 `[perf-sync]` 로그·JSONL(`source:'meta:ig'`) 확인.

- [ ] **Step 4: Commit(잔여 수정이 있었던 경우만)**

```bash
git add -A && git commit -m "chore(reels): 숏폼 메타 발행 최종 검증 잔여 수정"
```
