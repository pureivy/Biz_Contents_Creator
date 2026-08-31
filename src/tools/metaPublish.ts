/**
 * 카드뉴스·쇼츠 메타(인스타그램·페이스북 페이지) 발행 — 브랜드별 계정(META_TOKENS)으로 발행.
 * 인스타 로그인 방식(graph.instagram.com)은 공개 URL 만 받고 로컬·resumable 업로드 미지원(Meta 문서) →
 * 슬라이드 이미지·릴스 영상을 fal 스토리지 공개 URL 로 올려 image_url/video_url 로 전달([[falStorage]]).
 * 카드뉴스는 1장=단일 이미지·2~10장=캐러셀. 페이스북은 호스트·토큰이 완전히 다르다(FB_GRAPH + pageToken):
 * 카드뉴스=미공개 /photos → /feed attached_media(FB 엔 캐러셀 객체가 없음), 쇼츠=/video_reels 3단계.
 * Node 내장 fetch 만 사용. 명시 실패 반환 — 사용자 트리거 액션(fail-open 아님). 토큰은 로그·에러에 싣지 않는다.
 * 멱등: 발행된 미디어 id(existing.igMediaId/igReelId/fbPostId/fbReelId)로 채널별 스킵 — 중복 공개 발행 방지.
 * 채널 독립: FB 실패가 IG 성공을 취소하지 않는다(부분 성공 + fbError 로 사유 보고, 성공 위장 금지).
 */
import fs from 'node:fs';
import { CONFIG } from '../config';
import { getMetaAccount } from '../secrets/store';
import { uploadToFalStorage } from './falStorage';

// 'AI 정보' 라벨 자기 공개(META_AI_LABEL, 기본 on) — IG 는 컨테이너 생성 파라미터 is_ai_generated(2026-06-22
// 공식 도입, 캐러셀은 부모에만 — 자식에 넣으면 에러), FB 릴스는 video_reels 레퍼런스의 동명 파라미터.
// FB 사진(/photos)에는 공식 플래그가 없어 provenance_info(is_gen_ai) 자기 공시로 대신한다 — 라벨 노출 실검증 대기.
const aiLabelParam = (): Record<string, string> => (CONFIG.metaAiLabel ? { is_ai_generated: 'true' } : {});

// 인스타그램 로그인 방식(2026-07-20) — 콘텐츠 발행은 graph.instagram.com. 페이지 없음.
export const GRAPH = 'https://graph.instagram.com/v23.0';
// 페이스북 페이지 발행 — 페이지 노드(photos·feed·video_reels)는 graph.facebook.com 이고 인증도
// 페이지 액세스 토큰이다. IG 호스트·IG 토큰으로는 절대 호출되지 않는다(둘을 섞으면 100% 실패).
export const FB_GRAPH = 'https://graph.facebook.com/v23.0';

export interface MetaPublishResult {
  ok: boolean; igMediaId?: string; igPermalink?: string; fbPostId?: string; error?: string;
  /** FB 페이지 발행만 실패한 사유(IG 는 성공) — 라우트가 사용자에게 표시. */
  fbError?: string;
  /** 행동차단(2207051) 후 최근 미디어에서 회수해 기록한 발행(발행은 됐으나 응답에 id 없던 케이스). */
  recovered?: boolean;
}

/** IG 캡션(순수) — 본문+블로그 링크+해시태그 줄바꿈 결합, IG 한도 2200자 캡.
 *  blogUrl(파생물의 원본 네이버 글, 2026-07-31)은 본문과 태그 사이 한 줄 — 캡 초과 시 본문을 잘라
 *  링크·태그를 보존한다(IG 는 캡션 링크가 평문이지만 복사 유입·유튜브/FB 는 클릭 가능). */
export function buildIgCaption(caption: string, hashtags: string[], blogUrl?: string): string {
  const tagLine = hashtags.filter(Boolean).join(' ');
  const tail = [blogUrl ? `📖 전체 가이드(블로그): ${blogUrl}` : '', tagLine].filter(Boolean).join('\n\n');
  const budget = 2200 - (tail ? tail.length + 2 : 0);
  return [caption.trim().slice(0, Math.max(0, budget)), tail].filter(Boolean).join('\n\n');
}

/** 그래프 응답 {id} 안전 추출(순수). */
export function extractId(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** IG 미디어 {permalink} 추출(순수). */
export function parsePermalink(json: unknown): string | null {
  const p = (json as { permalink?: unknown } | null)?.permalink;
  return typeof p === 'string' && p ? p : null;
}

/**
 * 실제 게시물 퍼머링크만 인정(순수) — 일반 홈 URL(과거 폴백 잔재)은 '미보유'로 취급해
 * 재시도가 진짜 링크로 보강하게 한다. 발행 성공 후 퍼머링크 GET 이 일시 실패해도 홈 URL 을 저장하지 않는다.
 */
export function realPermalink(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  return /^https?:\/\/(www\.)?instagram\.com\/?$/i.test(p) ? undefined : p;
}

/** 그래프 에러 → 사람이 읽을 메시지(순수, 토큰류 미포함). subcode·사용자대면 제목 동봉 — 'Application
 *  request limit reached'(code 4)만으론 앱 레이트리밋과 행동차단(subcode 2207051)을 구분 못 하므로. */
export function graphError(json: unknown, status: number): string {
  const e = (json as { error?: { message?: unknown; code?: unknown; error_subcode?: unknown; error_user_title?: unknown } } | null)?.error;
  if (!e || typeof e.message !== 'string') return `HTTP ${status}`;
  const sub = e.error_subcode != null ? `, subcode ${e.error_subcode}` : '';
  const title = typeof e.error_user_title === 'string' && e.error_user_title ? ` — ${e.error_user_title}` : '';
  return `${e.message}${e.code != null ? `(code ${e.code}${sub})` : ''}${title}`.slice(0, 200);
}

/**
 * 발행 실패 힌트(순수) — 두 가지 다른 한도를 구분해 오안내 방지.
 * - code 4 'Application request limit reached' = 앱 API 레이트리밋(호출량 초과) → 일시적, 잠시 후 재시도. 발행 수 한도 아님.
 * - 그 외 'limit'(발행 quota 초과 등) = 24시간 발행 한도(quota_total, 실측 100건).
 * (graph.instagram.com 은 /me 노드 — content_publishing_limit 도 /me 경로.)
 */
export function metaLimitHint(error: string): string {
  // ① 인스타 행동 차단(게시 빈도/스팸 보호) — subcode 2207051. code 4·'request limit'로 오지만 앱 레이트리밋과
  //    다르다(is_transient=false, 게시 행동 자체 차단). 실측: 짧은 시간 다건 발행/재시도 시 발생. 회복은 수 시간~하루.
  if (/2207051|행동이 차단|action.?block/i.test(error)) {
    return ' — 인스타그램 행동 차단(게시 빈도 제한): 짧은 시간에 너무 많이 올려 일시 차단됐습니다. 수 시간~하루 후 재시도하고, 지금 반복 클릭은 금지(차단이 더 심해짐). 이미 인스타에 올라갔을 수 있으니 확인 후 재시도하세요.';
  }
  // ② 앱 API 레이트리밋 — 호출량(x-app-usage) 초과. 행동차단이 아닌 순수 code 4.
  if (/\(code 4\b|request limit reached/i.test(error)) {
    return ' — 앱 API 레이트리밋(호출량 초과, 일시적): 잠시(수십 분) 후 재시도. 발행 수 한도가 아닙니다.';
  }
  // ③ 24시간 발행 수 한도(quota_total).
  if (/limit/i.test(error)) {
    return ' — 24시간 발행 한도 가능성: 발행 quota 확인(GET /me/content_publishing_limit).';
  }
  return '';
}

async function graphJson(url: string, init: RequestInit, what: string): Promise<unknown> {
  const r = await fetch(url, init);
  const j: unknown = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${what} 실패: ${graphError(j, r.status)}`);
  return j;
}
const tokenQs = (token: string): string => `access_token=${encodeURIComponent(token)}`;
/** 캐러셀 컨테이너 처리 대기 — FINISHED 까지 3초×maxTries회 폴링. */
async function waitContainer(containerId: string, token: string, signal?: AbortSignal, maxTries = 10): Promise<void> {
  for (let i = 0; i < maxTries; i++) {
    const j = await graphJson(`${GRAPH}/${containerId}?fields=status_code&${tokenQs(token)}`, { signal }, '컨테이너 상태');
    const st = (j as { status_code?: string }).status_code;
    if (st === 'FINISHED') return;
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error(`IG 컨테이너 처리 실패(${st})`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('IG 컨테이너 처리 시간 초과 — 잠시 후 재시도하세요');
}

/** 최근 미디어 목록에서 방금 올린 것 매칭(순수) — 캡션 프리픽스(24자)+미디어 타입 일치+nowMs 기준 3분 이내. */
export function matchRecentPublish(
  posts: Array<{ id?: string; caption?: string; timestamp?: string; media_type?: string }>,
  caption: string, mediaType: string, nowMs: number,
): string | null {
  const head = caption.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (head.length < 8) return null; // 프리픽스 너무 짧으면 오매칭 위험 → 포기
  for (const p of posts) {
    if (!p.id || !p.caption || !p.timestamp || p.media_type !== mediaType) continue;
    if (nowMs - new Date(p.timestamp).getTime() > 3 * 60_000) continue; // 3분 이내만
    if (p.caption.replace(/\s+/g, ' ').trim().startsWith(head)) return p.id;
  }
  return null;
}

/**
 * 행동차단(subcode 2207051)은 발행을 처리하고도 403(응답에 id 없음)을 반환할 수 있다(실측 2026-07-24: 카드/릴스당
 * 정확히 1건만 게시 — 중복 아님). 그 경우 최근 내 미디어에서 방금 올린 것을 회수해 id 를 돌려준다 — '발행됐는데 미기록'
 * 으로 버튼이 안 바뀌고 재시도 중복을 유발하던 것을 막는다. 실패 시 null(원래 에러 유지).
 */
async function recoverPublishedId(token: string, caption: string, mediaType: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const j = await graphJson(`${GRAPH}/me/media?fields=id,caption,timestamp,media_type&limit=5&${tokenQs(token)}`, { signal }, '최근 미디어');
    const posts = (j as { data?: Array<{ id?: string; caption?: string; timestamp?: string; media_type?: string }> }).data ?? [];
    return matchRecentPublish(posts, caption, mediaType, Date.now());
  } catch { return null; }
}

// ── 페이스북 페이지 발행(카드뉴스) ───────────────────────────────────────────
// FB 엔 IG 같은 '캐러셀 객체'가 없다 → 미공개(published=false) 사진을 순서대로 올려 photoId 를 모으고,
// 그 id 들을 한 피드 게시물의 attached_media 로 묶는다(사용자 눈엔 다중 사진 게시물 1개).
// 미공개 사진은 피드에 단독 노출되지 않으므로 중간 실패 시에도 '반쪽 게시물'이 공개되지 않는다.

/** FB 페이지에 미공개 사진 업로드(멀티파트 바이너리) → photoId. */
async function uploadUnpublishedPhoto(pageId: string, token: string, filePath: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('source', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), 'slide.png');
  form.append('published', 'false');
  // FB 사진 AI 자기 공시: provenance_info 는 실측 (#100) Missing Permission(2026-07-31, 첫 실발행에서 즉시)
  // — 서드파티 앱 사용 불가 판정, 제거. /photos 엔 is_ai_generated 도 없어 공식 자기 공개 수단 부재 확정.
  // 남는 신호는 이미지에 임베드된 OpenAI C2PA(멀티파트 원본 바이트 업로드라 보존됨 — 메타 자동 감지 여지).
  form.append('access_token', token);
  const j = await graphJson(`${FB_GRAPH}/${pageId}/photos`, { method: 'POST', body: form, signal }, 'FB 사진 업로드');
  const id = extractId(j);
  if (!id) throw new Error('FB 사진 업로드 응답 이형(id 없음)');
  return id;
}

/** FB 페이지 다중 사진 게시 → 게시물 id. 슬라이드 순서 보존. */
export async function publishFbCardNews(
  pageId: string, token: string, slidePaths: string[], message: string, signal?: AbortSignal,
): Promise<string> {
  const photoIds: string[] = [];
  for (const p of slidePaths) photoIds.push(await uploadUnpublishedPhoto(pageId, token, p, signal));
  const feed = await graphJson(`${FB_GRAPH}/${pageId}/feed`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      message,
      attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id }))),
      access_token: token,
    }),
  }, 'FB 피드 게시');
  const id = extractId(feed);
  if (!id) throw new Error('FB 피드 응답 이형(id 없음)');
  return id;
}

/**
 * 최근 페이지 게시물에서 방금 올린 것 매칭(순수) — 메시지 프리픽스(24자) + nowMs 기준 3분 이내.
 * matchRecentPublish(IG)의 페이스북 판. /feed POST 응답만 유실된 경우(게시는 성공) 재시도가 같은
 * 카드뉴스를 두 번 공개 게시하는 것을 막는다 — 되돌리기 어려운 실수라 id 회수가 재시도보다 낫다.
 */
export function matchRecentFbPost(
  posts: Array<{ id?: string; message?: string; created_time?: string }>,
  message: string, nowMs: number,
): string | null {
  const head = message.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (head.length < 8) return null; // 프리픽스 너무 짧으면 오매칭 위험 → 포기
  for (const p of posts) {
    if (!p.id || !p.message || !p.created_time) continue;
    if (nowMs - new Date(p.created_time).getTime() > 3 * 60_000) continue;
    if (p.message.replace(/\s+/g, ' ').trim().startsWith(head)) return p.id;
  }
  return null;
}

/** /feed 실패 후 실제로 게시됐는지 확인해 id 회수(실패 시 null — 원래 에러 유지). */
async function recoverFbPostId(pageId: string, token: string, message: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const j = await graphJson(`${FB_GRAPH}/${pageId}/feed?fields=id,message,created_time&limit=5&${tokenQs(token)}`, { signal }, '최근 페이지 게시물');
    const posts = (j as { data?: Array<{ id?: string; message?: string; created_time?: string }> }).data ?? [];
    return matchRecentFbPost(posts, message, Date.now());
  } catch { return null; }
}

/** FB 채널 실패 메시지(순수) — IG 성공을 취소하지 않되 사유는 감추지 않는다. 권한 누락은 조치까지 안내. */
export function fbFailHint(msg: string): string {
  if (/\(#?200\)|permission|pages_manage_posts|OAuthException.*200/i.test(msg)) {
    return `${msg} — 페이지 게시 권한(pages_manage_posts) 누락: 페이스북 연결을 다시 하며 권한을 허용하세요`;
  }
  if (/\(#?190\)|expired|Session has been invalidated|access token/i.test(msg)) {
    return `${msg} — 페이지 토큰 만료·무효: 페이스북 페이지를 다시 연결하세요`;
  }
  return msg;
}

export async function publishCardNewsToMeta(opts: {
  slug: string; slidePaths: string[]; caption: string; hashtags: string[];
  /** 원본 네이버 블로그 URL(파생 카드일 때) — 캡션에 '전체 가이드' 링크 줄로 삽입. */
  blogUrl?: string;
  existing?: { igMediaId?: string; igPermalink?: string; fbPostId?: string }; signal?: AbortSignal;
}): Promise<MetaPublishResult> {
  const out: MetaPublishResult = { ok: false };
  try {
    const acct = getMetaAccount(opts.slug);
    const igLinked = !!(acct.igUserId && acct.pageAccessToken);
    const fbLinked = !!(acct.pageId && acct.pageToken);
    if (!igLinked && !fbLinked) {
      return { ok: false, error: '메타 미연결 — 카드뉴스 탭에서 인스타그램(또는 페이스북) 연결을 먼저 하세요' };
    }
    if (opts.slidePaths.length > 10) return { ok: false, error: `IG 캐러셀은 최대 10장(현재 ${opts.slidePaths.length}장)` };
    if (!opts.slidePaths.length || !opts.slidePaths.every((p) => fs.existsSync(p))) {
      return { ok: false, error: '슬라이드 파일 없음' };
    }
    const timeout = AbortSignal.timeout(300_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const message = buildIgCaption(opts.caption, opts.hashtags, opts.blogUrl);
    const token = acct.pageAccessToken;

    // IG 발행 — 이미 발행된 미디어 id(existing.igMediaId) 있으면 스킵(중복 공개 발행 방지, 라우트가 영속).
    out.igMediaId = opts.existing?.igMediaId;
    out.igPermalink = realPermalink(opts.existing?.igPermalink);
    if (igLinked && !out.igMediaId) {
      // ① 슬라이드를 fal 스토리지 공개 URL 로 올림 — 인스타 로그인은 공개 image_url 필수(로컬 업로드 미지원, Meta 문서).
      //    PNG 그대로 허용 실측. 순서 보존(슬라이드 정렬 순).
      const imageUrls: string[] = [];
      for (const p of opts.slidePaths) imageUrls.push(await uploadToFalStorage(p, 'image/png', signal));

      // ② 컨테이너 — 1장은 단일 이미지 포스트(캐러셀은 2~10장), 2장 이상은 캐러셀.
      let carId: string;
      if (imageUrls.length === 1) {
        const single = await graphJson(`${GRAPH}/me/media`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ image_url: imageUrls[0]!, caption: message, ...aiLabelParam(), access_token: token }),
        }, 'IG 이미지 컨테이너');
        const sid = extractId(single);
        if (!sid) throw new Error('IG 이미지 컨테이너 응답 이형');
        carId = sid;
      } else {
        const childIds: string[] = [];
        for (const url of imageUrls) {
          const child = await graphJson(`${GRAPH}/me/media`, {
            method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ image_url: url, is_carousel_item: 'true', access_token: token }),
          }, 'IG 자식 컨테이너');
          const cid = extractId(child);
          if (!cid) throw new Error('IG 자식 컨테이너 응답 이형');
          childIds.push(cid);
        }
        const carousel = await graphJson(`${GRAPH}/me/media`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          // is_ai_generated 는 부모 컨테이너에만 — 자식 아이템(:256)에 지정하면 에러(Meta 콘텐츠 발행 가이드).
          body: new URLSearchParams({ media_type: 'CAROUSEL', children: childIds.join(','), caption: message, ...aiLabelParam(), access_token: token }),
        }, 'IG 캐러셀 컨테이너');
        const cid = extractId(carousel);
        if (!cid) throw new Error('IG 캐러셀 컨테이너 응답 이형');
        carId = cid;
      }

      // ③ 처리 완료 대기 후 발행.
      await waitContainer(carId, token, signal);
      try {
        const pub = await graphJson(`${GRAPH}/me/media_publish`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ creation_id: carId, access_token: token }),
        }, 'IG 발행');
        out.igMediaId = extractId(pub) ?? undefined;
      } catch (e) {
        // 행동차단(2207051)은 발행을 처리하고도 403(id 없음)을 반환할 수 있다 — 방금 올린 게시물을 회수해 기록.
        if (/2207051|행동이 차단/i.test(e instanceof Error ? e.message : String(e))) {
          const rec = await recoverPublishedId(token, message, imageUrls.length === 1 ? 'IMAGE' : 'CAROUSEL_ALBUM', signal);
          if (rec) { out.igMediaId = rec; out.recovered = true; }
        }
        if (!out.igMediaId) throw e; // 회복 못 하면 원래 에러(메시지 힌트 유지)
      }
      if (!out.igMediaId) throw new Error('IG 발행 응답 이형(id 없음)');
    }
    // 퍼머링크 보강 — 발행됐고(미디어 id) 아직 실제 링크 없으면 조회. 일시 실패 시 undefined(홈 URL 폴백 없음) → 다음 재시도가 채움.
    if (igLinked && out.igMediaId && !out.igPermalink) {
      const perma = await graphJson(`${GRAPH}/${out.igMediaId}?fields=permalink&${tokenQs(token)}`, { signal }, 'IG 퍼머링크').catch(() => null);
      out.igPermalink = realPermalink(perma ? parsePermalink(perma) : null);
    }

    // FB 페이지 다중 사진 게시 — 페이지 연결(pageId+페이지토큰) 있을 때만. 기발행이면 스킵(멱등).
    // 실패해도 throw 하지 않는다: IG 는 이미 공개 발행됐으므로 취소 불가 — 사유만 fbError 로 올려보낸다.
    out.fbPostId = opts.existing?.fbPostId;
    if (fbLinked && !out.fbPostId) {
      try {
        out.fbPostId = await publishFbCardNews(acct.pageId, acct.pageToken, opts.slidePaths, message, signal);
      } catch (fe) {
        // 게시는 됐는데 응답만 유실된 경우가 있다(IG 의 2207051 사례와 같은 부류) → 최근 게시물에서 회수.
        // 회수 못 하면 사유 보고. 회수 성공은 recovered 로 표시(재시도가 두 번째 공개 게시를 만들지 않게).
        const rec = await recoverFbPostId(acct.pageId, acct.pageToken, message, signal);
        if (rec) { out.fbPostId = rec; out.recovered = true; }
        else {
          out.fbError = fbFailHint(fe instanceof Error ? fe.message.slice(0, 200) : String(fe));
          console.log('[meta] FB 페이지 게시 실패(IG 성공 유지) — ' + out.fbError.slice(0, 160));
        }
      }
    }

    // 한 채널도 못 올렸으면 성공이 아니다(성공 위장 금지) — FB 전용 연결에서 FB 가 실패한 경우.
    if (!out.igMediaId && !out.fbPostId) {
      out.error = out.fbError ?? '발행된 채널 없음';
      return out;
    }
    out.ok = true;
    return out;
  } catch (e) {
    // 채널별 부분 성공은 out 에 남아 있음 — 라우트가 성공분을 저장하고 실패 원인만 보고(성공 위장 금지).
    out.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    // 한도 힌트(스펙 §6) — 앱 레이트리밋(code 4)과 24h 발행 한도를 구분해 오안내 방지.
    out.error += metaLimitHint(out.error);
    return out;
  }
}

// ── 쇼츠 릴스 발행 ───────────────────────────────────────────────────────────
// IG(인스타 로그인)는 공개 video_url 필요 → fal 스토리지 경유. FB 는 video_reels 3단계(start→binary→finish, pageId 있을 때만).
// 릴스는 발행 즉시 공개(비공개·초안 없음, 스펙 §3) — 버튼 클릭=공개 발행 정책.

export interface MetaReelsResult {
  ok: boolean; igReelId?: string; igPermalink?: string; fbReelId?: string; error?: string;
  /** FB 릴스만 실패한 사유(IG 는 성공) — 라우트가 사용자에게 표시. */
  fbError?: string;
  /** FB 릴스 커버(썸네일)를 이번에 지정했는가 — 라우트가 재시도 스킵용 타임스탬프를 남긴다. */
  fbCoverSet?: boolean;
  /** 커버 지정만 실패한 사유(릴스 자체는 살아 있음). */
  fbCoverError?: string;
  /** 행동차단(2207051) 후 최근 미디어에서 회수해 기록한 발행. */
  recovered?: boolean;
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

/**
 * FB 릴스 3단계 — start(video_id·upload_url) → 바이너리 → finish(PUBLISHED). video_id 반환.
 * 호스트는 FB_GRAPH, 토큰은 페이지 액세스 토큰(pageToken) — IG 호스트·IG 토큰으로는 동작하지 않는다.
 */
export async function publishFbReel(pageId: string, token: string, videoPath: string, description: string, signal?: AbortSignal): Promise<string> {
  const start = await graphJson(`${FB_GRAPH}/${pageId}/video_reels`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ upload_phase: 'start', access_token: token }),
  }, 'FB 릴스 시작') as { video_id?: string; upload_url?: string };
  if (!start.video_id || !start.upload_url) throw new Error('FB 릴스 시작 응답 이형');
  await uploadVideoBinary(start.upload_url, token, videoPath, 'FB 릴스 업로드', signal);
  const fin = await graphJson(`${FB_GRAPH}/${pageId}/video_reels`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description, ...aiLabelParam(), access_token: token }),
  }, 'FB 릴스 발행') as { success?: boolean };
  if (!fin.success) throw new Error('FB 릴스 발행 응답 이형(success 없음)');
  return start.video_id;
}

/**
 * FB 릴스 커버(썸네일) 지정 — 릴스 발행 API(video_reels)에는 커버 파라미터가 없어서(Meta 문서) 발행 후
 * /{video-id}/thumbnails 에 이미지를 멀티파트로 올리고 is_preferred 로 대표 지정한다. 이미 공개된 릴스에도
 * 적용되므로 커버 없이 올라간 과거 릴스를 보강할 수 있다.
 * 필요 권한: pages_read_user_content · pages_manage_engagement · pages_show_list — 하나라도 없으면 (#10)/(#200).
 */
export async function setFbReelCover(videoId: string, token: string, imagePath: string, signal?: AbortSignal): Promise<void> {
  const form = new FormData();
  form.append('source', new Blob([fs.readFileSync(imagePath)], { type: 'image/jpeg' }), 'cover.jpg');
  form.append('is_preferred', 'true');
  form.append('access_token', token);
  const j = await graphJson(`${FB_GRAPH}/${videoId}/thumbnails`, { method: 'POST', body: form, signal }, 'FB 릴스 커버');
  if (!(j as { success?: boolean }).success) throw new Error('FB 릴스 커버 응답 이형(success 없음)');
}

export async function publishShortsToMeta(opts: {
  slug: string; videoPath: string; caption: string; hashtags: string[]; thumbnailPath?: string;
  /** 원본 네이버 블로그 URL(파생 쇼츠일 때) — 캡션에 '전체 가이드' 링크 줄로 삽입. */
  blogUrl?: string;
  existing?: { igReelId?: string; igPermalink?: string; fbReelId?: string; fbCoverTs?: string }; signal?: AbortSignal;
}): Promise<MetaReelsResult> {
  const out: MetaReelsResult = { ok: false };
  try {
    const acct = getMetaAccount(opts.slug);
    const igLinked = !!(acct.igUserId && acct.pageAccessToken);
    const fbLinked = !!(acct.pageId && acct.pageToken);
    if (!igLinked && !fbLinked) {
      return { ok: false, error: '메타 미연결 — 카드뉴스/숏폼 탭에서 인스타그램(또는 페이스북) 연결을 먼저 하세요' };
    }
    if (!fs.existsSync(opts.videoPath)) return { ok: false, error: '영상 파일 없음' };
    const timeout = AbortSignal.timeout(600_000); // 영상 업로드+인코딩 — 카드뉴스(5분)의 2배 여유
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const message = buildIgCaption(opts.caption, opts.hashtags, opts.blogUrl);
    const token = acct.pageAccessToken;

    // ① IG 릴스 — 이미 발행된 릴스 id(existing.igReelId) 있으면 스킵(중복 공개 발행 방지, 라우트가 영속).
    // 인스타 로그인 방식은 로컬·resumable 업로드 미지원(Meta 문서) → 영상을 fal 스토리지 공개 URL 로 올려 video_url 로 전달.
    out.igReelId = opts.existing?.igReelId;
    out.igPermalink = realPermalink(opts.existing?.igPermalink);
    if (igLinked && !out.igReelId) {
      const videoUrl = await uploadToFalStorage(opts.videoPath, 'video/mp4', signal);
      // 디자인 썸네일이 있으면 릴스 커버로 지정(cover_url = fal 공개 이미지 URL). 없거나 실패하면 IG 가 영상 프레임으로 자동.
      let coverUrl: string | null = null;
      if (opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
        try { coverUrl = await uploadToFalStorage(opts.thumbnailPath, 'image/jpeg', signal); }
        catch { coverUrl = null; }
      }
      const body = new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption: message, share_to_feed: 'true', ...aiLabelParam(), access_token: token });
      if (coverUrl) body.set('cover_url', coverUrl);
      const container = await graphJson(`${GRAPH}/me/media`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 'IG 릴스 컨테이너');
      const cid = extractId(container);
      if (!cid) throw new Error('IG 릴스 컨테이너 응답 이형');
      await waitContainer(cid, token, signal, 90); // 영상 다운로드+인코딩 — 3초×90회(호스티드 다운로드 여유)
      try {
        const pub = await graphJson(`${GRAPH}/me/media_publish`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ creation_id: cid, access_token: token }),
        }, 'IG 릴스 발행');
        out.igReelId = extractId(pub) ?? undefined;
      } catch (e) {
        // 행동차단(2207051)은 릴스도 발행하고 403(id 없음)을 반환할 수 있다 — 방금 올린 영상을 회수해 기록.
        if (/2207051|행동이 차단/i.test(e instanceof Error ? e.message : String(e))) {
          const rec = await recoverPublishedId(token, message, 'VIDEO', signal);
          if (rec) { out.igReelId = rec; out.recovered = true; }
        }
        if (!out.igReelId) throw e;
      }
      if (!out.igReelId) throw new Error('IG 릴스 발행 응답 이형(id 없음)');
    }
    // 퍼머링크 보강 — 발행됐고(릴스 id) 아직 실제 링크 없으면 조회. 일시 실패 시 undefined(홈 URL 폴백 없음) → 다음 재시도가 채움.
    if (igLinked && out.igReelId && !out.igPermalink) {
      const perma = await graphJson(`${GRAPH}/${out.igReelId}?fields=permalink&${tokenQs(token)}`, { signal }, 'IG 퍼머링크').catch(() => null);
      out.igPermalink = realPermalink(perma ? parsePermalink(perma) : null);
    }

    // ② FB 릴스 — 페이지 연결(pageId+페이지토큰) 있을 때만. 기발행이면 스킵(멱등).
    // 실패해도 throw 하지 않는다: IG 릴스는 이미 공개됐으므로 취소 불가 — 사유만 fbError 로 보고.
    // 알려진 한계: finish 응답만 유실된 경우의 id 회수는 카드뉴스(/feed)에만 있다. 릴스는 재시도가
    // start 부터 새 video_id 를 만들어 중복 공개가 될 수 있다 — 실패 후 재시도 전 페이지를 눈으로 확인할 것.
    out.fbReelId = opts.existing?.fbReelId;
    if (fbLinked && !out.fbReelId) {
      try {
        out.fbReelId = await publishFbReel(acct.pageId, acct.pageToken, opts.videoPath, message, signal);
      } catch (fe) {
        out.fbError = fbFailHint(fe instanceof Error ? fe.message.slice(0, 200) : String(fe));
        console.log('[meta] FB 릴스 실패(IG 성공 유지) — ' + out.fbError.slice(0, 160));
      }
    }

    // ③ FB 릴스 커버 — 발행 직후든 과거 릴스든, 아직 지정 안 됐고 디자인 썸네일이 있으면 지정한다.
    // 커버 실패는 릴스 자체를 되돌리지 않는다(이미 공개됨) — 사유만 올려보낸다.
    if (fbLinked && out.fbReelId && !opts.existing?.fbCoverTs && opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
      try {
        await setFbReelCover(out.fbReelId, acct.pageToken, opts.thumbnailPath, signal);
        out.fbCoverSet = true;
      } catch (ce) {
        out.fbCoverError = fbFailHint(ce instanceof Error ? ce.message.slice(0, 200) : String(ce));
        console.log('[meta] FB 릴스 커버 미적용 — ' + out.fbCoverError.slice(0, 160));
      }
    }

    // 한 채널도 못 올렸으면 성공이 아니다(성공 위장 금지) — FB 전용 연결에서 FB 가 실패한 경우.
    if (!out.igReelId && !out.fbReelId) {
      out.error = out.fbError ?? '발행된 채널 없음';
      return out;
    }
    out.ok = true;
    return out;
  } catch (e) {
    // 채널별 부분 성공은 out 에 남아 있음 — 라우트가 성공분을 저장하고 실패 원인만 보고(성공 위장 금지).
    out.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    out.error += metaLimitHint(out.error);
    return out;
  }
}

export interface IgMediaItem { id: string; permalink: string; timestamp: string; caption: string; type: string; }

/**
 * 계정의 IG 미디어 목록(페이지네이션) — 재조정(reconcile)용. 발행 중 서버 재시작 등으로 로컬 영속이 유실돼도
 * 라이브 릴스를 다시 찾아 백필하기 위해 사용. 미연결이면 throw, 페이징 next 는 graph.instagram.com 호스트만 따른다.
 */
export async function listIgMedia(slug: string): Promise<IgMediaItem[]> {
  const acct = getMetaAccount(slug);
  if (!acct.igUserId || !acct.pageAccessToken) throw new Error('메타 미연결');
  const token = acct.pageAccessToken;
  const out: IgMediaItem[] = [];
  let url: string | null = `${GRAPH}/me/media?fields=id,media_type,media_product_type,permalink,timestamp,caption&limit=50&${tokenQs(token)}`;
  for (let guard = 0; url && guard < 20; guard++) {
    const j = await graphJson(url, {}, 'IG 미디어 목록') as { data?: Array<Record<string, string>>; paging?: { next?: string } };
    for (const m of j.data ?? []) {
      out.push({ id: m.id ?? '', permalink: m.permalink ?? '', timestamp: m.timestamp ?? '', caption: m.caption ?? '', type: m.media_product_type ?? m.media_type ?? '' });
    }
    const next = j.paging?.next;
    url = next && /^https:\/\/graph\.instagram\.com\//.test(next) ? next : null;
  }
  return out;
}

/**
 * 라이브 IG 릴스를 미추적 쇼츠에 매칭(순수) — 캡션이 쇼츠 제목으로 시작하면 동일 콘텐츠로 본다.
 * igReelId 이미 있는 쇼츠는 건너뛰고, 한 릴스 id 는 한 쇼츠에만 선점(중복 매칭 방지). 재조정 백필용.
 */
export function matchOrphanReels(
  shorts: Array<{ id: string; title: string; igReelId?: string }>,
  reels: Array<{ id: string; permalink: string; timestamp: string; caption: string }>,
): Array<{ shortsId: string; reelId: string; permalink: string; timestamp: string }> {
  const claimed = new Set(shorts.map((s) => s.igReelId).filter((x): x is string => !!x));
  const matches: Array<{ shortsId: string; reelId: string; permalink: string; timestamp: string }> = [];
  for (const s of shorts) {
    if (s.igReelId) continue;
    const title = s.title.trim();
    if (!title) continue;
    const m = reels.find((r) => !claimed.has(r.id) && r.caption.trim().startsWith(title));
    if (!m) continue;
    claimed.add(m.id);
    matches.push({ shortsId: s.id, reelId: m.id, permalink: m.permalink, timestamp: m.timestamp });
  }
  return matches;
}
