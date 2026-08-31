/**
 * 텔레그램 봇 수신 폴러 — 검토 대기 알림의 발행 버튼(callback_query)과 수정요청 답장을 처리한다.
 * 서버에 공개 주소가 없으므로 웹훅 대신 getUpdates 롱폴링(50s). 액션은 자기 자신(127.0.0.1)의
 * HTTP 엔드포인트로 위임 — 라우트의 stage 가드·멱등(409)·in-flight 락을 그대로 재사용한다.
 *
 * 보안: TELEGRAM_CHAT_ID 와 일치하는 채팅의 업데이트만 처리(그 외 무시+오프셋 확인).
 * 부팅 이전 메시지는 조용히 드레인(오래된 '안녕' 류에 응답하지 않음). 실패는 전부 무해(다음 폴로 복구).
 * 주의: 폴러 가동 중 같은 토큰으로 수동 getUpdates 를 호출하면 409 충돌이 난다(진단 시 폴러 먼저 내릴 것).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { getSecret } from '../secrets/store';
import { telegramCreds, tgApiUrl, sendTelegramHtml, sendTelegramPhotos } from './notify';
import { studioBase, escapeHtml } from './contentNotify';

export type BotAction =
  | { kind: 'naver_draft'; id: string }
  | { kind: 'revise'; id: string }
  | { kind: 'cardnews_publish'; id: string }
  | { kind: 'cardnews_force'; id: string }
  | { kind: 'shorts_youtube'; id: string }
  | { kind: 'shorts_meta'; id: string };

/** 콜백 데이터 파싱(≤64바이트 규격: "<op>:<id>"). 불명이면 null. 순수 — 테스트 대상. */
export function parseCallback(data: string): BotAction | null {
  const m = /^(bp|rv|cp|cf|sy|sm):([A-Za-z0-9_]{1,48})$/.exec(data);
  if (!m) return null;
  const id = m[2]!;
  switch (m[1]) {
    case 'bp': return { kind: 'naver_draft', id };
    case 'rv': return { kind: 'revise', id };
    case 'cp': return { kind: 'cardnews_publish', id };
    case 'cf': return { kind: 'cardnews_force', id };
    case 'sy': return { kind: 'shorts_youtube', id };
    case 'sm': return { kind: 'shorts_meta', id };
    default: return null;
  }
}

/** 수정요청 답장의 대상 라우트(순수, 테스트 대상) — 파생(card_/short_)은 자기 revise 라우트(수 분 동기),
 *  그 외는 블로그 piece revise(리비전 런 발사). rv 버튼이 세 종류 알림에 다 달리면서 필요해졌다. */
export function reviseEndpointFor(id: string): { path: string; label: string; derived: boolean } {
  if (id.startsWith('card_')) return { path: `/cardnews/${id}/revise`, label: '카드뉴스', derived: true };
  if (id.startsWith('short_')) return { path: `/shorts/${id}/revise`, label: '숏폼', derived: true };
  return { path: `/pieces/${id}/revise`, label: '블로그', derived: false };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 자기 서버 호출 — 라우트 가드·멱등을 재사용. AUTH_TOKEN 설정 시 Bearer 동봉. */
async function api(pathname: string, body?: unknown, timeoutMs = 600_000): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tok = (getSecret('AUTH_TOKEN') || '').trim();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch(`http://127.0.0.1:${CONFIG.port}${pathname}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
  });
  let json: Record<string, unknown> | null = null;
  try { json = await r.json() as Record<string, unknown>; } catch { /* 비 JSON 응답 — 상태코드로만 판정 */ }
  return { ok: r.ok, status: r.status, json };
}

// 오류 본문은 업스트림(구글·그래프 API) 문자열이 섞일 수 있어 이스케이프 필수 — 안 하면 parse_mode HTML 이
// 거부해 실패 메시지조차 사용자에게 못 간다(이중 침묵).
const errText = (label: string, r: { status: number; json: Record<string, unknown> | null }): string =>
  `⚠️ ${label} — ${escapeHtml(typeof r.json?.error === 'string' ? r.json.error : `HTTP ${r.status}`)}`;

/** 버튼 액션 실행 → 사용자에게 보낼 결과 문구. revise 는 답장 유도라 여기 없음. */
async function runAction(a: Exclude<BotAction, { kind: 'revise' }>): Promise<string> {
  switch (a.kind) {
    case 'naver_draft': {
      const r = await api(`/pieces/${a.id}/naver-draft`, { actor: '텔레그램' }, 30_000);
      return r.ok ? '📗 네이버 임시저장 시작 — 완료되면 알림이 옵니다.' : errText('임시저장 시작 실패', r);
    }
    case 'cardnews_publish': {
      const r = await api(`/cardnews/${a.id}/publish`);
      if (!r.ok) {
        // 오타 QA 미해결 게이트(409) — 실패로 끝내지 않고 '확인 후 강행' 2단계로 잇는다:
        // 의심 슬라이드 이미지를 보내 사용자가 텔레그램에서 바로 검수하고, 이상 없으면 강행(cf) 버튼.
        const qa = Array.isArray(r.json?.qa_unresolved) ? (r.json!.qa_unresolved as unknown[]).filter((n): n is number => typeof n === 'number') : [];
        if (r.status === 409 && qa.length) {
          const dir = path.join(CONFIG.dataDir, 'cardnews', a.id);
          const flagged = qa.map((n) => path.join(dir, `slide_${String(n).padStart(2, '0')}.png`)).filter((p) => fs.existsSync(p));
          if (flagged.length) await sendTelegramPhotos(flagged, `⚠️ 오타 의심 슬라이드 ${qa.join(', ')}`);
          await sendTelegramHtml(
            `⚠️ 오타 QA 미해결 — 슬라이드 ${qa.join(', ')} 확인 필요\n위 이미지 문구가 정상이면 아래 버튼으로 발행을 강행하세요. 오타가 보이면 스튜디오에서 수정 후 발행하세요.\n${studioBase()}/`,
            [[{ text: `✅ 확인했어요 — 강행 발행`, callback_data: `cf:${a.id}` }]],
          );
          return ''; // 안내는 위에서 이미 전송 — 호출부가 빈 문자열은 재전송하지 않는다.
        }
        return errText('카드뉴스 발행 실패', r);
      }
      const link = typeof r.json?.igPermalink === 'string' ? `\n${r.json.igPermalink}` : '';
      const fbErr = typeof r.json?.fbError === 'string' && r.json.fbError ? `\n(페북: ${r.json.fbError})` : '';
      return `📸 인스타 캐러셀 발행 완료${link}${fbErr}`;
    }
    case 'cardnews_force': {
      // 사용자가 의심 슬라이드를 확인한 뒤의 강행 발행 — 라우트의 force 게이트(qaPublishBlockReason)를 통과.
      const r = await api(`/cardnews/${a.id}/publish`, { force: true });
      if (!r.ok) return errText('카드뉴스 강행 발행 실패', r);
      const link = typeof r.json?.igPermalink === 'string' ? `\n${r.json.igPermalink}` : '';
      const fbErr = typeof r.json?.fbError === 'string' && r.json.fbError ? `\n(페북: ${r.json.fbError})` : '';
      return `📸 인스타 캐러셀 발행 완료(QA 확인 강행)${link}${fbErr}`;
    }
    case 'shorts_youtube': {
      const r = await api(`/shorts/${a.id}/youtube`);
      if (!r.ok) return errText('유튜브 업로드 실패', r);
      const url = typeof r.json?.url === 'string' ? r.json.url : typeof r.json?.youtubeUrl === 'string' ? r.json.youtubeUrl : '';
      return `▶️ 유튜브 비공개 업로드 완료${url ? `\n${url}` : ''}\n공개 전환은 유튜브 스튜디오에서.`;
    }
    case 'shorts_meta': {
      const r = await api(`/shorts/${a.id}/meta`);
      if (!r.ok) return errText('릴스 발행 실패', r);
      const link = typeof r.json?.igPermalink === 'string' ? `\n${r.json.igPermalink}` : '';
      return `🎬 인스타 릴스 발행 완료${link}`;
    }
  }
}

/** 텔레그램 저수준 호출(응답 JSON 반환) — force_reply 의 message_id 회수 등에 사용. */
async function tgCall(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const url = tgApiUrl(method);
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

// 수정요청 대기 — force_reply 로 보낸 안내 message_id → 대상(블로그 piece·카드뉴스·숏폼 id).
// 재시작하면 소실(버튼 다시 누르면 됨).
const pendingRevise = new Map<number, { targetId: string; ts: number }>();
function prunePendingRevise(): void {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1시간 경과 폐기
  for (const [k, v] of pendingRevise) if (v.ts < cutoff) pendingRevise.delete(k);
  while (pendingRevise.size > 50) { const k = pendingRevise.keys().next().value; if (k === undefined) break; pendingRevise.delete(k); }
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; date?: number; text?: string; chat?: { id?: number }; reply_to_message?: { message_id?: number } };
  callback_query?: { id: string; data?: string; from?: { id?: number }; message?: { chat?: { id?: number } } };
}

// 오프셋 영속 — 메모리에만 두면 재시작 시 0 부터라 텔레그램이 미확인 업데이트(최대 24h)를 전부 재전달하고,
// 다운타임 중 눌린 버튼들이 부팅 순간 일제히 재실행된다. 배치마다 저장(원자적 교체, 실패 무해).
const OFFSET_FILE = path.join(CONFIG.dataDir, 'telegram-bot.json');
function loadOffset(): number {
  try {
    const d = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf-8')) as { offset?: number };
    return typeof d.offset === 'number' && d.offset > 0 ? d.offset : 0;
  } catch { return 0; }
}
function saveOffset(offset: number): void {
  try {
    const tmp = `${OFFSET_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ offset }), 'utf-8');
    fs.renameSync(tmp, OFFSET_FILE);
  } catch { /* 영속 실패 무해 — 다음 배치에서 재시도 */ }
}

async function handleUpdate(u: TgUpdate, chatId: string, bootTs: number): Promise<void> {
  // ── 버튼(callback_query) ──
  const cq = u.callback_query;
  if (cq) {
    // 채팅과 '누른 사람' 둘 다 검사 — 개인 채팅에선 동일하지만, CHAT_ID 를 그룹으로 잘못 설정해도
    // 그룹 구성원이 발행을 트리거하지 못하게 막는 이중 가드.
    if (String(cq.message?.chat?.id ?? '') !== chatId || String(cq.from?.id ?? '') !== chatId) return;
    const action = cq.data ? parseCallback(cq.data) : null;
    void tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: action ? '접수 — 처리 중…' : '알 수 없는 버튼' });
    if (!action) return;
    if (action.kind === 'revise') {
      // 답장 유도 — 답장 텍스트가 도착하면 아래 message 분기가 /revise 로 잇는다.
      const res = await tgCall('sendMessage', {
        chat_id: chatId, text: '✍ 수정 지시를 이 메시지에 답장(Reply)으로 보내주세요.',
        reply_markup: { force_reply: true },
      });
      const mid = (res?.result as { message_id?: number } | undefined)?.message_id;
      if (typeof mid === 'number') { pendingRevise.set(mid, { targetId: action.id, ts: Date.now() }); prunePendingRevise(); }
      return;
    }
    // 발행류는 수 초~수 분 — 폴 루프를 막지 않게 비동기로 돌리고 끝나면 결과를 새 메시지로 push.
    // 실패(타임아웃·재시작 중 ECONNREFUSED 등)도 반드시 사용자에게 알린다 — '접수'만 보고 무소식이면 안 됨.
    void runAction(action)
      .then((msg) => { if (msg) void sendTelegramHtml(msg); }) // ''=QA 안내처럼 액션이 직접 전송한 경우
      .catch((e: unknown) => sendTelegramHtml(`⚠️ 처리 실패 — ${escapeHtml(e instanceof Error ? e.message : String(e))}`));
    return;
  }
  // ── 텍스트 메시지 ──
  const m = u.message;
  if (!m || String(m.chat?.id ?? '') !== chatId) return;
  if ((m.date ?? 0) < bootTs) return; // 부팅 이전 잔여 메시지 — 조용히 드레인
  const text = (m.text ?? '').trim();
  if (!text) return;
  const replyTo = m.reply_to_message?.message_id;
  if (typeof replyTo === 'number') {
    const pending = pendingRevise.get(replyTo);
    if (pending) {
      pendingRevise.delete(replyTo);
      const ep = reviseEndpointFor(pending.targetId);
      if (ep.derived) {
        // 카드뉴스·숏폼 revise 는 수 분짜리 동기 라우트 — 폴 루프를 막지 않게 비동기 실행 후 결과 push.
        void sendTelegramHtml(`✍ ${ep.label} 수정 반영 중… (부분 재생성 — 수 분 소요)`);
        void api(ep.path, { feedback: text })
          .then((r) => sendTelegramHtml(r.ok ? `✍ ${ep.label} 수정 반영 완료 — 갱신본 알림을 확인하세요.` : errText(`${ep.label} 수정 요청 실패`, r)))
          .catch((e: unknown) => sendTelegramHtml(`⚠️ ${ep.label} 수정 요청 실패 — ${escapeHtml(e instanceof Error ? e.message : String(e))}`));
      } else {
        const r = await api(ep.path, { feedback: text }, 30_000);
        void sendTelegramHtml(r.ok ? '✍ 수정 런 시작 — 완료되면 ↻ 개정본 알림이 옵니다.' : errText('수정 요청 실패', r));
      }
    } else {
      // 재시작으로 대기 맵이 소실된 답장 — 지시 텍스트가 버려졌음을 명확히 알린다(조용한 폐기 금지).
      void sendTelegramHtml('⏳ 수정 요청 세션이 만료됐습니다 — 알림 메시지의 ✍ 수정요청 버튼을 다시 눌러주세요.');
    }
    return;
  }
  // 명령이 아닌 일반 텍스트 — 짧은 안내(발행은 알림 메시지의 버튼으로).
  void sendTelegramHtml(`📌 발행·수정은 검토 대기 알림 메시지의 버튼으로 할 수 있습니다.\n스튜디오: ${studioBase()}/`);
}

let started = false;

/** 폴러 기동(1회) — 자격 미설정이면 유휴 대기(설정 즉시 자동 재개, .env 매 폴 재읽기). */
export function startTelegramBot(): void {
  if (started) return;
  started = true;
  const bootTs = Math.floor(Date.now() / 1000);
  let offset = loadOffset();
  let announced = false;
  let failStreak = 0;      // 연속 실패 횟수 — 백오프 5s→최대 60s 에스컬레이션(죽은 토큰으로 API 두들기지 않기)
  let lastFailLogTs = 0;   // 실패 로그 스로틀(60s) — 지속 실패를 '진단 가능하되 로그 홍수 없이' 남긴다
  const logFail = (why: string): void => {
    failStreak++;
    if (Date.now() - lastFailLogTs > 60_000) { lastFailLogTs = Date.now(); console.log(`[텔레그램] getUpdates 실패(연속 ${failStreak}) — ${why.slice(0, 200)}`); }
  };
  void (async () => {
    for (;;) {
      const tg = telegramCreds();
      if (!tg) { announced = false; await sleep(60_000); continue; }
      if (!announced) { announced = true; console.log('[텔레그램] 봇 수신 폴러 시작 — 검토 알림 발행 버튼 활성'); }
      const base = tgApiUrl('getUpdates');
      if (!base) { await sleep(5_000); continue; } // 자격이 방금 지워진 레이스 — 다음 루프의 creds 체크로 수렴
      try {
        const url = `${base}?timeout=50${offset ? `&offset=${offset}` : ''}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        const d = await r.json() as { ok?: boolean; description?: string; result?: TgUpdate[] };
        if (!d.ok) { logFail(d.description ?? `HTTP ${r.status}`); await sleep(Math.min(60_000, 5_000 * failStreak)); continue; }
        if (failStreak) { console.log(`[텔레그램] getUpdates 복구(연속 실패 ${failStreak}회 후)`); failStreak = 0; }
        for (const u of d.result ?? []) {
          offset = Math.max(offset, u.update_id + 1);
          try { await handleUpdate(u, tg.chatId, bootTs); } catch { /* 무해 — 다음 업데이트 계속 */ }
        }
        if (d.result?.length) saveOffset(offset);
      } catch (e) {
        logFail(e instanceof Error ? e.message : String(e));
        await sleep(Math.min(60_000, 5_000 * failStreak));
      }
    }
  })();
}
