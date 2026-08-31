import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildIgCaption, extractId, parsePermalink, realPermalink, graphError, metaLimitHint, matchRecentPublish, matchRecentFbPost, matchOrphanReels, publishCardNewsToMeta, publishShortsToMeta } from './metaPublish';
import { uploadToFalStorage } from './falStorage';
import { getMetaAccount } from '../secrets/store';
import fs from 'node:fs';

// ESM 모듈 함수는 spyOn 불가 — vi.mock 부분 목킹(파서 등 순수부는 원본 유지).
vi.mock('../secrets/store', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../secrets/store')>();
  return { ...mod, getMetaAccount: vi.fn(() => ({ pageId: '', igUserId: '', pageAccessToken: '' , pageToken: '' })) };
});

// fal 스토리지 업로드는 네트워크·FAL_KEY 의존 → 고정 공개 URL 로 목킹(발행 로직만 검증).
vi.mock('./falStorage', () => ({ uploadToFalStorage: vi.fn(async () => 'https://v3.fal.media/files/test.mp4') }));

afterEach(() => vi.restoreAllMocks());

describe('metaPublish 순수 헬퍼', () => {
  it('buildIgCaption: 캡션+해시태그 결합, 2200자 캡', () => {
    expect(buildIgCaption('본문', ['#a', '#b'])).toBe('본문\n\n#a #b');
    expect(buildIgCaption('', ['#a'])).toBe('#a');
    expect(buildIgCaption('x'.repeat(3000), []).length).toBe(2200);
  });
  it('buildIgCaption: 블로그 링크 줄 — 본문과 태그 사이, 캡 초과 시 본문을 잘라 링크·태그 보존(2026-07-31)', () => {
    const url = 'https://blog.naver.com/biondi_tree/224345904342';
    expect(buildIgCaption('본문', ['#a'], url)).toBe(`본문\n\n📖 전체 가이드(블로그): ${url}\n\n#a`);
    expect(buildIgCaption('본문', [], url)).toBe(`본문\n\n📖 전체 가이드(블로그): ${url}`);
    const long = buildIgCaption('x'.repeat(3000), ['#tag'], url);
    expect(long.length).toBeLessThanOrEqual(2200);
    expect(long).toContain(url);      // 링크는 잘리지 않음
    expect(long.endsWith('#tag')).toBe(true);
    expect(buildIgCaption('본문', ['#a'], undefined)).toBe('본문\n\n#a'); // 미지정 시 종전과 동일
  });
  it('extractId: {id} 추출, 이형은 null', () => {
    expect(extractId({ id: '123' })).toBe('123');
    expect(extractId({})).toBeNull();
    expect(extractId(null)).toBeNull();
    expect(extractId({ id: 42 })).toBeNull();
  });
  it('parsePermalink: {permalink} 추출', () => {
    expect(parsePermalink({ permalink: 'https://www.instagram.com/p/x/' })).toBe('https://www.instagram.com/p/x/');
    expect(parsePermalink({})).toBeNull();
  });
  it('realPermalink: 실제 게시물 링크만 인정, 홈 URL·빈값은 undefined(재시도 보강용)', () => {
    expect(realPermalink('https://www.instagram.com/reel/AbC/')).toBe('https://www.instagram.com/reel/AbC/');
    expect(realPermalink('https://www.instagram.com/p/x/')).toBe('https://www.instagram.com/p/x/');
    expect(realPermalink('https://www.instagram.com/')).toBeUndefined();   // 홈 URL 잔재 → 미보유
    expect(realPermalink('https://instagram.com')).toBeUndefined();
    expect(realPermalink(null)).toBeUndefined();
    expect(realPermalink(undefined)).toBeUndefined();
  });
  it('graphError: 메시지+subcode+사용자제목 추출(토큰 미노출), 없으면 HTTP 코드', () => {
    expect(graphError({ error: { message: 'Invalid parameter', code: 100 } }, 400)).toBe('Invalid parameter(code 100)');
    // 행동차단: subcode·error_user_title 동봉 → 하류(metaLimitHint)가 구분 가능
    expect(graphError({ error: { message: 'Application request limit reached', code: 4, error_subcode: 2207051, error_user_title: '행동이 차단되었습니다' } }, 403))
      .toBe('Application request limit reached(code 4, subcode 2207051) — 행동이 차단되었습니다');
    expect(graphError({}, 500)).toBe('HTTP 500');
  });
  it('metaLimitHint: 행동차단(2207051) vs 앱 레이트리밋(code 4) vs 24h 발행 한도 구분', () => {
    // 행동차단(subcode 2207051) → '행동 차단·반복 금지', 앱 레이트리밋 안내는 안 붙음
    const block = metaLimitHint('IG 발행 실패: Application request limit reached(code 4, subcode 2207051) — 행동이 차단되었습니다');
    expect(block).toContain('행동 차단');
    expect(block).toContain('반복 클릭은 금지');
    expect(block).not.toContain('앱 API 레이트리밋');
    // subcode 없는 순수 code 4 → 앱 레이트리밋
    const rate = metaLimitHint('IG 발행 실패: Application request limit reached(code 4)');
    expect(rate).toContain('앱 API 레이트리밋');
    expect(rate).not.toContain('행동 차단');
    expect(rate).not.toContain('24시간 발행 한도');
    // 그 외 limit → 24h 발행 한도
    const quota = metaLimitHint('IG 발행 실패: The user has reached the limit of posts(code 9)');
    expect(quota).toContain('24시간 발행 한도');
    expect(quota).toContain('/me/content_publishing_limit');
    // limit 무관 → 힌트 없음
    expect(metaLimitHint('IG 컨테이너 응답 이형')).toBe('');
  });
  it('matchRecentPublish: 캡션 프리픽스+타입+3분이내 매칭(행동차단 후 회수)', () => {
    const now = Date.parse('2026-07-24T08:25:00Z');
    const posts = [
      { id: 'reel1', caption: '라임오렌지나무여름관리 어쩌고', timestamp: '2026-07-24T08:24:30Z', media_type: 'VIDEO' },
      { id: 'car1', caption: '방학 시작에 10개였던 열매, 끝날 때 몇 개', timestamp: '2026-07-24T08:24:52Z', media_type: 'CAROUSEL_ALBUM' },
    ];
    // 캡션 프리픽스+타입 일치 + 3분 이내 → 그 id
    expect(matchRecentPublish(posts, '방학 시작에 10개였던 열매, 끝날 때 몇 개 남을까요\n\n#태그', 'CAROUSEL_ALBUM', now)).toBe('car1');
    // 타입 불일치(릴스로 찾으면 캐러셀 제외) → 릴스 캡션과 다르면 null
    expect(matchRecentPublish(posts, '전혀 다른 릴스 캡션입니다 여기', 'VIDEO', now)).toBeNull();
    // 3분 초과 → null
    const later = Date.parse('2026-07-24T08:29:00Z');
    expect(matchRecentPublish(posts, '방학 시작에 10개였던 열매', 'CAROUSEL_ALBUM', later)).toBeNull();
    // 캡션 프리픽스 불일치 → null
    expect(matchRecentPublish(posts, '완전히 다른 카드뉴스 캡션', 'CAROUSEL_ALBUM', now)).toBeNull();
    // 캡션 너무 짧음(<8자) → 오매칭 방지로 null
    expect(matchRecentPublish(posts, '방학', 'CAROUSEL_ALBUM', now)).toBeNull();
  });
});

describe('matchOrphanReels', () => {
  it('제목=캡션 접두 매칭, igReelId 있는 쇼츠 제외·매칭 릴스 없으면 스킵', () => {
    const shorts = [
      { id: 's1', title: '여름꽃 여섯 가지', igReelId: undefined },
      { id: 's2', title: '베란다 채소 다섯 가지', igReelId: 'R99' }, // 이미 추적됨 → 제외
      { id: 's3', title: '없는 제목', igReelId: undefined },        // 매칭 릴스 없음
    ];
    const reels = [
      { id: 'R1', permalink: 'https://www.instagram.com/reel/a/', timestamp: '2026-07-20T07:40:44+0000', caption: '여름꽃 여섯 가지 지금 심어도\n\n본문' },
      { id: 'R2', permalink: 'https://www.instagram.com/reel/b/', timestamp: '2026-07-20T07:40:41+0000', caption: '베란다 채소 다섯 가지 …' },
    ];
    expect(matchOrphanReels(shorts, reels)).toEqual([
      { shortsId: 's1', reelId: 'R1', permalink: 'https://www.instagram.com/reel/a/', timestamp: '2026-07-20T07:40:44+0000' },
    ]);
  });
  it('한 릴스가 여러 쇼츠에 중복 매칭되지 않음(선점)', () => {
    const shorts = [{ id: 's1', title: '같은 제목', igReelId: undefined }, { id: 's2', title: '같은 제목', igReelId: undefined }];
    const reels = [{ id: 'R1', permalink: 'p', timestamp: 't', caption: '같은 제목 뒤' }];
    const m = matchOrphanReels(shorts, reels);
    expect(m.length).toBe(1);
    expect(m[0]!.shortsId).toBe('s1');
  });
  it('빈 제목 쇼츠는 매칭 안 함(무분별 매칭 방지)', () => {
    expect(matchOrphanReels([{ id: 's1', title: '  ', igReelId: undefined }], [{ id: 'R1', permalink: 'p', timestamp: 't', caption: '아무거나' }])).toEqual([]);
  });
});

describe('publishCardNewsToMeta', () => {
  it('브랜드 미연결 → 명확한 에러(네트워크 호출 없음)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: '', pageAccessToken: '' , pageToken: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await publishCardNewsToMeta({ slug: 'x', slidePaths: ['/tmp/none.png'], caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('메타 미연결');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('11장 이상 → 캐러셀 한도 에러', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'p', igUserId: 'ig', pageAccessToken: 't' , pageToken: '' });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: Array.from({ length: 11 }, (_, i) => `/tmp/s${i}.png`), caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('10장');
  });
  it('happy path: 슬라이드 2장 fal 업로드→IG 캐러셀→발행→permalink(IG 전용, FB 없음)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: 'IG', pageAccessToken: 'T' , pageToken: '' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    // fal 은 슬라이드 파일명별 고유 공개 URL 반환 — image_url 로 흘렀는지·순서 보존을 값으로 검증.
    vi.mocked(uploadToFalStorage).mockImplementation(async (p) => `https://v3.fal.media/${p.split('/').pop()}`);
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); const body = String((init as RequestInit | undefined)?.body ?? ''); bodies.push(body);
      const json =
        u.includes('/me/media_publish') ? { id: 'IGMEDIA' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/p/x/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') && body.includes('media_type=CAROUSEL') ? { id: 'CAR1' }
        : u.includes('/me/media') ? { id: `ct${bodies.filter((b) => b.includes('is_carousel_item')).length}` }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png', '/a/slide_02.png'], caption: '본문', hashtags: ['#t'] });
    expect(r).toMatchObject({ ok: true, igMediaId: 'IGMEDIA', igPermalink: 'https://www.instagram.com/p/x/' });
    expect(r.fbPostId).toBeUndefined();                                     // 페이지 미연결 → FB 경로 미실행
    // fal 업로드: 슬라이드 수·순서·contentType 검증(로컬 경로/스킵 회귀를 잡음)
    expect(vi.mocked(uploadToFalStorage).mock.calls.map((c) => [c[0], c[1]])).toEqual([['/a/slide_01.png', 'image/png'], ['/a/slide_02.png', 'image/png']]);
    // fal 공개 URL 이 자식 image_url 로, 슬라이드 순서대로 전달됐는지(로컬 경로 회귀 시 실패)
    const children = bodies.filter((b) => b.includes('is_carousel_item=true'));
    expect(children.length).toBe(2);
    expect(children.every((b) => b.includes('fal.media') && b.includes('image_url'))).toBe(true);
    expect(children[0]).toContain('slide_01.png');
    expect(children[1]).toContain('slide_02.png');
  });
  it('단일 슬라이드 → 캐러셀 아닌 일반 이미지 포스트(fal URL)로 발행', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: 'IG', pageAccessToken: 'T' , pageToken: '' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); const body = String((init as RequestInit | undefined)?.body ?? ''); bodies.push(body);
      const json =
        u.includes('/me/media_publish') ? { id: 'IGONE' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/p/one/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') ? { id: 'IMG1' }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [] });
    expect(r).toMatchObject({ ok: true, igMediaId: 'IGONE' });
    expect(vi.mocked(uploadToFalStorage)).toHaveBeenCalledWith('/a/slide_01.png', 'image/png', expect.anything());
    expect(bodies.some((b) => b.includes('is_carousel_item') || b.includes('media_type=CAROUSEL'))).toBe(false); // 캐러셀 아님
    expect(bodies.some((b) => b.includes('image_url') && b.includes('caption') && b.includes('fal.media'))).toBe(true); // 단일 이미지+캡션+fal URL
  });
  it('단일 이미지 발행 이형(id 없음) → ok:false(fail-closed, 단일 경로도 위장 금지)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: 'IG', pageAccessToken: 'T' , pageToken: '' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      const json =
        u.includes('/me/media_publish') ? {}                       // ← 이형: id 없음
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') ? { id: 'IMG1' }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('이형');
  });
  it('부분 성공 멱등: existing.igMediaId 있으면 IG 스킵·fal 미업로드(재발행·중복 없음)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: 'IG', pageAccessToken: 'T' , pageToken: '' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); });
    const r = await publishCardNewsToMeta({
      slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [],
      existing: { igMediaId: 'MDONE', igPermalink: 'https://www.instagram.com/p/done/' },
    });
    expect(r.ok).toBe(true);
    expect(r.igMediaId).toBe('MDONE');                              // 기존 미디어 id 이월
    expect(vi.mocked(uploadToFalStorage)).not.toHaveBeenCalled();   // 재업로드 없음
    expect(calls.some((c) => c.includes('/me/media'))).toBe(false); // IG 경로 미호출(중복 방지)
  });
  it('media_publish 이형 응답(id 없음) → ok:false(성공 위장 금지)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: 'IG', pageAccessToken: 'T' , pageToken: '' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('/me/media_publish') ? {}                       // ← 이형: id 없음
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') && body.includes('media_type=CAROUSEL') ? { id: 'CAR1' }
        : u.includes('/me/media') ? { id: 'ct1' }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png', '/a/slide_02.png'], caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('이형');
    expect(r.error).toContain('IG 발행');        // IG 발행 단계 가드가 발동했음을 특정
  });
});

// 페이스북 페이지 채널 — 과거 결함(FB 엔드포인트를 graph.instagram.com 호스트 + IG 토큰으로 호출)이
// 되살아나지 않게 호스트·토큰을 값으로 검증한다. 둘 중 하나라도 IG 쪽이면 실사용에서 100% 실패한다.
describe('페이스북 페이지 발행(카드뉴스)', () => {
  const BOTH = { pageId: 'PG', igUserId: 'IG', pageAccessToken: 'IGTOK', pageToken: 'PGTOK' };
  /** IG(성공) + FB 응답을 흉내내는 fetch 목 — 호출 URL·바디를 수집해 반환. */
  function mockFetch(fbFail?: number): { urls: string[]; bodies: string[] } {
    const urls: string[] = []; const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); urls.push(u);
      const raw = (init as RequestInit | undefined)?.body;
      const body = raw instanceof FormData ? [...raw.keys()].join(',') : String(raw ?? '');
      bodies.push(body);
      if (u.startsWith('https://graph.facebook.com/')) {
        if (fbFail && u.includes('/photos')) {
          return new Response(JSON.stringify({ error: { message: 'permissions error', code: 200 } }), { status: fbFail });
        }
        return new Response(JSON.stringify({ id: u.includes('/photos') ? `PH${urls.filter((x) => x.includes('/photos')).length}` : 'PG_POST1' }), { status: 200 });
      }
      const json =
        u.includes('/me/media_publish') ? { id: 'IGMEDIA' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/p/x/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') && body.includes('media_type=CAROUSEL') ? { id: 'CAR1' }
        : u.includes('/me/media') ? { id: 'ct' }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    return { urls, bodies };
  }

  it('IG 캐러셀 발행 후 FB 페이지 다중 사진 게시 — 호스트=graph.facebook.com·토큰=페이지 토큰', async () => {
    vi.mocked(getMetaAccount).mockReturnValue(BOTH);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    const { urls, bodies } = mockFetch();
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png', '/a/slide_02.png'], caption: '본문', hashtags: ['#t'] });
    expect(r).toMatchObject({ ok: true, igMediaId: 'IGMEDIA', fbPostId: 'PG_POST1' });
    expect(r.fbError).toBeUndefined();
    // 슬라이드마다 미공개 사진 업로드 → 한 피드 게시물로 묶기
    expect(urls.filter((u) => u === 'https://graph.facebook.com/v23.0/PG/photos')).toHaveLength(2);
    const feedIdx = urls.findIndex((u) => u.endsWith('/PG/feed'));
    expect(feedIdx).toBeGreaterThan(-1);
    expect(bodies[feedIdx]).toContain('attached_media');
    expect(bodies[feedIdx]).toContain(encodeURIComponent('{"media_fbid":"PH1"}').replace(/%2C/g, '%2C')); // 순서: 1번 슬라이드 먼저
    expect(bodies[feedIdx]).toContain('PH2');
    expect(bodies[feedIdx]).toContain('access_token=PGTOK'); // ← 페이지 토큰(IG 토큰이면 회귀)
    expect(bodies[feedIdx]).not.toContain('IGTOK');
    // FB 엔드포인트가 IG 호스트로 새지 않았는지(과거 결함)
    expect(urls.some((u) => u.startsWith('https://graph.instagram.com/') && /photos|\/feed/.test(u))).toBe(false);
  });

  it('FB 만 실패하면 IG 성공 유지 + fbError 로 사유 보고(성공 위장·실패 위장 둘 다 금지)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue(BOTH);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    mockFetch(403);
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [] });
    expect(r.ok).toBe(true);                       // IG 는 실제로 공개 발행됨 → 취소 불가
    expect(r.igMediaId).toBe('IGMEDIA');
    expect(r.fbPostId).toBeUndefined();
    expect(r.fbError).toContain('pages_manage_posts'); // 권한 누락 → 조치까지 안내
  });

  it('FB 멱등: existing.fbPostId 있으면 FB 재게시 안 함(중복 공개 방지)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue(BOTH);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    const { urls } = mockFetch();
    const r = await publishCardNewsToMeta({
      slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [],
      existing: { igMediaId: 'MDONE', igPermalink: 'https://www.instagram.com/p/done/', fbPostId: 'FBDONE' },
    });
    expect(r).toMatchObject({ ok: true, igMediaId: 'MDONE', fbPostId: 'FBDONE' });
    expect(urls.some((u) => u.startsWith('https://graph.facebook.com/'))).toBe(false);
  });

  it('IG 완료·FB 미게시 상태로 재시도하면 FB 만 올린다(페이지를 나중에 연결한 경우)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue(BOTH);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    const { urls } = mockFetch();
    const r = await publishCardNewsToMeta({
      slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [],
      existing: { igMediaId: 'MDONE', igPermalink: 'https://www.instagram.com/p/done/' },
    });
    expect(r).toMatchObject({ ok: true, igMediaId: 'MDONE', fbPostId: 'PG_POST1' });
    expect(urls.some((u) => u.includes('/me/media'))).toBe(false); // IG 재발행 없음
    expect(vi.mocked(uploadToFalStorage)).not.toHaveBeenCalled();  // fal 재업로드도 없음(FB 는 바이너리 직접 업로드)
  });

  it('FB 페이지만 연결(IG 미연결) → FB 만 발행하고 ok, IG 호출 없음', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: '', pageAccessToken: '', pageToken: 'PGTOK' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    const { urls } = mockFetch();
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [] });
    expect(r).toMatchObject({ ok: true, fbPostId: 'PG_POST1' });
    expect(r.igMediaId).toBeUndefined();
    expect(urls.some((u) => u.startsWith('https://graph.instagram.com/'))).toBe(false);
  });

  it('/feed 실패 후 실제로 게시돼 있으면 id 를 회수한다(중복 공개 게시 방지)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue(BOTH);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const raw = (init as RequestInit | undefined)?.body;
      const isPost = (init as RequestInit | undefined)?.method === 'POST';
      if (u.startsWith('https://graph.facebook.com/')) {
        if (u.includes('/photos')) return new Response(JSON.stringify({ id: 'PH1' }), { status: 200 });
        if (u.includes('/feed') && isPost) return new Response(JSON.stringify({ error: { message: 'timeout', code: 1 } }), { status: 500 });
        if (u.includes('/feed')) { // ← 회수 조회: 방금 올라간 게시물이 실제로 존재
          return new Response(JSON.stringify({ data: [{ id: 'PG_RECOVERED', message: '방학 시작에 10개였던 열매 어쩌고', created_time: new Date().toISOString() }] }), { status: 200 });
        }
      }
      const body = String(raw ?? '');
      const json =
        u.includes('/me/media_publish') ? { id: 'IGMEDIA' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/p/x/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') && body.includes('media_type=CAROUSEL') ? { id: 'CAR1' }
        : u.includes('/me/media') ? { id: 'ct' }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png'], caption: '방학 시작에 10개였던 열매 어쩌고', hashtags: [] });
    expect(r.ok).toBe(true);
    expect(r.fbPostId).toBe('PG_RECOVERED'); // 재시도가 두 번째 게시를 만들지 않게 id 확보
    expect(r.recovered).toBe(true);
    expect(r.fbError).toBeUndefined();       // 결과적으로 게시됐으므로 실패로 보고하지 않음
  });

  it('FB 전용 연결에서 FB 가 실패하면 ok:false(올라간 채널이 없으므로 성공 아님)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: '', pageAccessToken: '', pageToken: 'PGTOK' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('png'));
    mockFetch(403);
    const r = await publishCardNewsToMeta({ slug: '', slidePaths: ['/a/slide_01.png'], caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('permissions error');
  });
});

describe('publishShortsToMeta', () => {
  it('브랜드 미연결 → 명확한 에러(네트워크 호출 없음)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: '', igUserId: '', pageAccessToken: '' , pageToken: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await publishShortsToMeta({ slug: 'x', videoPath: '/tmp/none.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('메타 미연결');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('영상 파일 없음 → 에러', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T', pageToken: 'PGTOK' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('영상 파일');
  });
  it('happy path: IG 컨테이너(fal video_url)→폴링→발행→permalink + FB start→upload→finish', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T', pageToken: 'PGTOK' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    const calls: string[] = []; const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); calls.push(u);
      const body = String((init as RequestInit | undefined)?.body ?? ''); bodies.push(body);
      const json =
        u.includes('rupload.facebook.com') || u.includes('UPLOAD_URL') ? { success: true }
        : u.includes('/media_publish') ? { id: 'REEL1' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/reel/x/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') ? { id: 'CT1' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? { video_id: 'FBV1', upload_url: 'https://rupload.facebook.com/UPLOAD_URL' }
        : u.includes('/PG/video_reels') ? { success: true }   // finish
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: '제목\n\n설명', hashtags: ['#t'] });
    expect(r).toMatchObject({ ok: true, igReelId: 'REEL1', igPermalink: 'https://www.instagram.com/reel/x/', fbReelId: 'FBV1' });
    expect(calls.filter((c) => c.includes('rupload.facebook.com')).length).toBe(1); // FB 바이너리만(IG 는 fal video_url)
    expect(calls.some((c) => c.includes('/me/media') && !c.includes('media_publish'))).toBe(true); // IG 컨테이너는 me/media
    // FB 릴스는 FB 호스트 + 페이지 토큰 — 과거엔 graph.instagram.com + IG 토큰으로 호출해 실사용에서 전건 실패했다.
    expect(calls.filter((c) => c.includes('/PG/video_reels')).every((c) => c.startsWith('https://graph.facebook.com/v23.0/'))).toBe(true);
    const reelBodies = bodies.filter((b) => b.includes('upload_phase'));
    expect(reelBodies.length).toBe(2);                                    // start + finish
    expect(reelBodies.every((b) => b.includes('access_token=PGTOK'))).toBe(true);
    expect(reelBodies.some((b) => b.includes('access_token=T'))).toBe(false); // IG 토큰 유출 없음
  });
  it('IG 발행 이형(id 없음) → ok:false + FB 미진행(변별력: FB 성공 mock 준비)', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T', pageToken: 'PGTOK' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); calls.push(u);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('/me/media_publish') ? {}                            // ← 이형: id 없음 → throw
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') ? { id: 'CT1' }                       // 컨테이너 생성 성공
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? { video_id: 'FBV1', upload_url: 'https://rupload.facebook.com/UPLOAD_URL' }
        : u.includes('/PG/video_reels') ? { success: true }
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('릴스 발행');
    expect(r.fbReelId).toBeUndefined();                                  // IG 실패가 FB 진행을 막음
    expect(calls.some((c) => c.includes('/PG/video_reels'))).toBe(false);
  });
  it('FB start 이형(video_id 없음) → FB best-effort 스킵, IG 릴스 성공은 ok:true 로 유지', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T', pageToken: 'PGTOK' });
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
        : u.includes('/me/media') ? { id: 'CT9' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? {}   // ← 이형: video_id 없음
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(true);            // FB best-effort — 실패해도 IG 성공으로 ok:true
    expect(r.igReelId).toBe('REEL9');   // IG 릴스 성공
    expect(r.fbReelId).toBeUndefined(); // FB 는 스킵됨
  });
  it('FB finish 이형(success 없음) → FB best-effort 스킵, IG 릴스 성공 유지', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T', pageToken: 'PGTOK' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('mp4'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const body = String((init as RequestInit | undefined)?.body ?? '');
      const json =
        u.includes('rupload.facebook.com') || u.includes('UPLOAD_URL') ? { success: true }
        : u.includes('/media_publish') ? { id: 'REEL7' }
        : u.includes('fields=permalink') ? { permalink: 'https://www.instagram.com/reel/z/' }
        : u.includes('fields=status_code') ? { status_code: 'FINISHED' }
        : u.includes('/me/media') ? { id: 'CT7' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=start') ? { video_id: 'FBV7', upload_url: 'https://rupload.facebook.com/UPLOAD_URL' }
        : u.includes('/PG/video_reels') && body.includes('upload_phase=finish') ? {}   // ← 이형
        : {};
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const r = await publishShortsToMeta({ slug: '', videoPath: '/a/final.mp4', caption: 'c', hashtags: [] });
    expect(r.ok).toBe(true);                 // FB best-effort — IG 성공으로 ok:true
    expect(r.igReelId).toBe('REEL7');        // IG 릴스 성공
    expect(r.fbReelId).toBeUndefined();      // FB 는 스킵됨
  });
  it('부분 성공 멱등: existing.igReelId 있으면 IG 경로 무호출·fal 미업로드, FB 만 발행', async () => {
    vi.mocked(getMetaAccount).mockReturnValue({ pageId: 'PG', igUserId: 'IG', pageAccessToken: 'T', pageToken: 'PGTOK' });
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
      existing: { igReelId: 'RDONE', igPermalink: 'https://www.instagram.com/reel/done/', fbReelId: undefined },
    });
    expect(r.ok).toBe(true);
    expect(r.igReelId).toBe('RDONE');                              // 기존 릴스 id 이월
    expect(r.fbReelId).toBe('FBV2');
    expect(vi.mocked(uploadToFalStorage)).not.toHaveBeenCalled();  // 재업로드 없음
    expect(calls.some((c) => c.includes('/me/media'))).toBe(false); // IG 경로 미호출(중복 방지)
  });
});

// /feed 응답 유실 회수의 순수 매처 — 오매칭은 남의 게시물을 우리 것으로 기록하므로 경계를 못박는다.
describe('matchRecentFbPost', () => {
  const now = Date.parse('2026-07-27T08:25:00Z');
  const posts = [
    { id: 'p1', message: '방학 시작에 10개였던 열매, 끝날 때 몇 개 남을까요\n\n#태그', created_time: '2026-07-27T08:24:30Z' },
    { id: 'p2', message: '완전히 다른 페이지 게시물', created_time: '2026-07-27T08:24:50Z' },
  ];
  it('메시지 프리픽스 일치 + 3분 이내 → 그 id', () => {
    expect(matchRecentFbPost(posts, '방학 시작에 10개였던 열매, 끝날 때 몇 개 남을까요\n\n#태그', now)).toBe('p1');
  });
  it('3분 초과·프리픽스 불일치·짧은 메시지·필드 결측 → null', () => {
    expect(matchRecentFbPost(posts, '방학 시작에 10개였던 열매', Date.parse('2026-07-27T08:29:00Z'))).toBeNull();
    expect(matchRecentFbPost(posts, '전혀 다른 카드뉴스 캡션입니다', now)).toBeNull();
    expect(matchRecentFbPost(posts, '방학', now)).toBeNull();                       // <8자 → 오매칭 방지
    expect(matchRecentFbPost([{ id: 'x', created_time: '2026-07-27T08:24:30Z' }], '방학 시작에 10개였던 열매', now)).toBeNull();
  });
});
