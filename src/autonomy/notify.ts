/**
 * 알림 전송 — 자율 사이클 완료·일일 브리핑을 사용자에게 push(Connect AI 텔레그램 비서·브리핑 대응).
 * 채널: 웹훅(Slack/Discord/커스텀) + 텔레그램. 자격은 시크릿(getSecret) 또는 env. 미설정이면 no-op(회귀 0).
 * 실패는 무해(전송 실패가 런/브리핑을 막지 않음). 웹훅 URL 은 운영자 본인 설정이라 SSRF 표면 아님(http(s)만 허용).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSecret } from '../secrets/store';

export interface NotifyMessage { title: string; body: string; }

/** 시크릿 우선, 없으면 env. */
function cred(key: string): string {
  return (getSecret(key) || process.env[key] || '').trim();
}

/** 설정된 모든 채널로 전송. 반환: 성공 전송 채널 수(0=미설정 또는 전부 실패). */
export async function notify(msg: NotifyMessage): Promise<number> {
  const tasks: Array<Promise<boolean>> = [];
  const webhook = cred('NOTIFY_WEBHOOK_URL');
  if (webhook) tasks.push(sendWebhook(webhook, msg));
  const tgToken = cred('TELEGRAM_BOT_TOKEN');
  const tgChat = cred('TELEGRAM_CHAT_ID');
  if (tgToken && tgChat) tasks.push(sendTelegram(tgToken, tgChat, msg));
  if (!tasks.length) return 0;
  const results = await Promise.all(tasks);
  return results.filter(Boolean).length;
}

/** 알림 채널이 하나라도 설정돼 있는지(전송 시도 전 가드용). */
export function notifyConfigured(): boolean {
  return !!cred('NOTIFY_WEBHOOK_URL') || !!(cred('TELEGRAM_BOT_TOKEN') && cred('TELEGRAM_CHAT_ID'));
}

/** 텔레그램 자격(토큰+챗ID) — 미설정이면 null. */
export function telegramCreds(): { token: string; chatId: string } | null {
  const token = cred('TELEGRAM_BOT_TOKEN');
  const chatId = cred('TELEGRAM_CHAT_ID');
  return token && chatId ? { token, chatId } : null;
}

/** 웹훅 채널만 전송(텔레그램 제외) — 텔레그램으로 리치 알림(앨범·영상)이 따로 나갈 때 중복 방지용. */
export async function notifyWebhookOnly(msg: NotifyMessage): Promise<boolean> {
  const webhook = cred('NOTIFY_WEBHOOK_URL');
  return webhook ? sendWebhook(webhook, msg) : false;
}

const TG_API = 'https://api.telegram.org/bot';

/** 텔레그램 인라인 키보드 버튼(콜백 데이터 ≤64바이트 — 호출측이 준수). */
export interface TgButton { text: string; callback_data: string }

/** 메서드 호출 URL(토큰 포함) — 봇 폴러 등 저수준 호출용. 자격 미설정이면 null. */
export function tgApiUrl(method: string): string | null {
  const tg = telegramCreds();
  return tg ? `${TG_API}${encodeURIComponent(tg.token)}/${method}` : null;
}

// 전송 실패는 무해하지만 무성(無聲)이면 안 된다 — 토큰 폐기·HTML 파싱 오류 같은 지속 실패를 진단할 유일한 흔적.
// 응답 본문에 실제 사유(chat not found, can't parse entities 등)가 실려 온다. 토큰은 절대 로그에 남기지 않는다.
async function logTgFailure(method: string, r: Response): Promise<void> {
  try { console.log(`[알림] 텔레그램 ${method} 실패 — HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); } catch { /* 무해 */ }
}
const logTgError = (method: string, e: unknown): void => {
  // 원인 코드(cause.code)·이름을 함께 남긴다 — "fetch failed" 만으로는 미전송인지 응답 유실인지 못 가른다.
  // 실사고 ②(중복 2통)의 분류를 이 정보 없이 추론해야 했다.
  const x = e as { name?: string; cause?: { code?: unknown } };
  const detail = [x?.name, typeof x?.cause?.code === 'string' ? x.cause.code : ''].filter(Boolean).join('/');
  console.log(`[알림] 텔레그램 ${method} 예외 — ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}${detail ? ` (${detail})` : ''}`);
};

/**
 * 이 전송을 재시도해도 되는가(순수) — **전송되지 않았음이 확실할 때만** true.
 *
 * 실사고 2건이 이 판정을 만들었다(둘 다 2026-08-31, 방향이 정반대다):
 *  ① 오전: 알림이 "fetch failed" 한 번에 영구 소실됐다(재시도 없음) → 재시도를 넣었다.
 *  ② 밤: 그 재시도가 중복 2통을 만들었다. 로그는 "예외 — fetch failed" → "복구(재시도 1회 후)" 인데
 *     사용자에겐 2통이 도착했다. 첫 전송은 텔레그램에 **이미 닿았고** 응답만 유실된 것이다.
 *
 * sendMessage 에는 멱등 키가 없다. 따라서 '보냈는지 모르는' 실패를 재시도하면 반드시 중복이 난다.
 * 판정 기준을 '실패했나'에서 '미전송이 확실한가'로 바꾼다 —
 *   확실히 미전송: DNS 실패·연결 거부(요청이 서버에 닿지도 못함), 429·5xx(서버가 명시적으로 거절)
 *   불확실:       타임아웃·연결 리셋·소켓 종료 — 요청은 갔을 수 있고 응답만 유실됐을 수 있다
 * 불확실은 보내지 않는다. 손실과 중복 중 하나를 골라야 한다면 사용자가 원한 건 1통이다(사용자 확정).
 */
const RETRIABLE_CAUSE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
export function shouldRetryTelegram(x: { status?: number; error?: unknown }): boolean {
  if (x.error !== undefined) {
    const e = x.error as { name?: string; cause?: { code?: unknown } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return false; // 응답만 못 받았을 수 있다
    const code = typeof e?.cause?.code === 'string' ? e.cause.code : '';
    return RETRIABLE_CAUSE.has(code); // 사유 불명은 보수적으로 false
  }
  if (x.status === undefined) return false;
  return x.status === 429 || x.status >= 500;
}

/** 텔레그램 HTML 메시지(링크 미리보기 off — 로컬/태일넷 링크는 미리보기 불가). buttons=인라인 키보드(선택). */
export async function sendTelegramHtml(html: string, buttons?: TgButton[][]): Promise<boolean> {
  const tg = telegramCreds();
  if (!tg) return false;
  const body = JSON.stringify({
    chat_id: tg.chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  // 일시 실패 재시도(2026-08-31) — 1.5s·4s 백오프로 3회. 알림은 '놓치면 사람이 모르는' 정보라
  // 한 번의 blip 으로 버리면 안 된다. 지속 실패(4xx)는 첫 시도에서 바로 포기한다.
  const DELAYS = [1_500, 4_000];
  for (let attempt = 0; ; attempt++) {
    let status: number | undefined;
    let error: unknown;
    try {
      const r = await fetch(`${TG_API}${encodeURIComponent(tg.token)}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        if (attempt) console.log('[알림]', `텔레그램 sendMessage 복구(재시도 ${attempt}회 후)`);
        return true;
      }
      status = r.status;
      await logTgFailure('sendMessage', r);
    } catch (e) {
      error = e;
      logTgError('sendMessage', e);
    }
    if (!shouldRetryTelegram({ status, error })) {
      // 중복 방지로 포기했다는 사실을 남긴다 — 알림이 안 왔을 때 '왜 재시도조차 안 했나'의 답이 된다.
      if (error !== undefined) console.log('[알림]', '텔레그램 전송 여부 불확실 — 중복 방지를 위해 재시도 안 함');
      return false;
    }
    if (attempt >= DELAYS.length) return false;
    await new Promise<void>((res) => setTimeout(res, DELAYS[attempt]!));
  }
}

/** 로컬 파일 → multipart 필드(공개 URL 불필요 — 봇 API 직접 업로드). 비동기 — 대용량 동기 읽기로 서버 이벤트루프를 막지 않는다. */
async function fileBlob(p: string, mime: string): Promise<Blob> {
  return new Blob([await fs.promises.readFile(p)], { type: mime });
}

/** 텔레그램 사진 앨범(1장이면 sendPhoto, 2장~는 sendMediaGroup 최대 10장) + 첫 장 캡션(HTML, 1024자 캡). */
export async function sendTelegramPhotos(files: string[], captionHtml: string): Promise<boolean> {
  const tg = telegramCreds();
  const list = files.filter((f) => { try { return fs.existsSync(f); } catch { return false; } }).slice(0, 10);
  if (!tg || !list.length) return false;
  const caption = captionHtml.slice(0, 1000);
  try {
    const fd = new FormData();
    fd.append('chat_id', tg.chatId);
    if (list.length === 1) {
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
      fd.append('photo', await fileBlob(list[0]!, 'image/png'), path.basename(list[0]!));
      const r = await fetch(`${TG_API}${encodeURIComponent(tg.token)}/sendPhoto`, {
        method: 'POST', body: fd, signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) await logTgFailure('sendPhoto', r);
      return r.ok;
    }
    const media = list.map((f, i) => ({
      type: 'photo', media: `attach://f${i}`,
      ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
    }));
    fd.append('media', JSON.stringify(media));
    for (const [i, f] of list.entries()) fd.append(`f${i}`, await fileBlob(f, 'image/png'), path.basename(f));
    const r = await fetch(`${TG_API}${encodeURIComponent(tg.token)}/sendMediaGroup`, {
      method: 'POST', body: fd, signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) await logTgFailure('sendMediaGroup', r);
    return r.ok;
  } catch (e) {
    logTgError('sendPhoto/MediaGroup', e);
    return false;
  }
}

/** 텔레그램 봇 업로드 한도(50MB) — 초과 영상은 호출측이 텍스트로 폴백. */
export const TELEGRAM_VIDEO_MAX_BYTES = 49 * 1024 * 1024;

/** 텔레그램 영상 + 캡션(HTML). 한도 초과·파일 없음이면 false(호출측 폴백 — 예상 경로라 로그 없음). buttons=인라인 키보드(선택).
 *  opts.width/height: 미전달 시 텔레그램이 비율을 잘못 추정해 세로 영상이 짜부러져 보인다(실측 2026-07-29).
 *  opts.thumbnailPath: 커버(JPEG, 최장변 ≤320px·200KB 미만 — 규격 밖이면 텔레그램이 무시). */
export async function sendTelegramVideo(
  file: string, captionHtml: string, buttons?: TgButton[][],
  opts?: { width?: number; height?: number; thumbnailPath?: string },
): Promise<boolean> {
  const tg = telegramCreds();
  if (!tg) return false;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > TELEGRAM_VIDEO_MAX_BYTES) return false;
    const fd = new FormData();
    fd.append('chat_id', tg.chatId);
    fd.append('caption', captionHtml.slice(0, 1000));
    fd.append('parse_mode', 'HTML');
    fd.append('supports_streaming', 'true');
    if (opts?.width) fd.append('width', String(opts.width));
    if (opts?.height) fd.append('height', String(opts.height));
    if (opts?.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
      fd.append('thumbnail', await fileBlob(opts.thumbnailPath, 'image/jpeg'), 'thumb.jpg');
    }
    if (buttons?.length) fd.append('reply_markup', JSON.stringify({ inline_keyboard: buttons }));
    fd.append('video', await fileBlob(file, 'video/mp4'), path.basename(file));
    const r = await fetch(`${TG_API}${encodeURIComponent(tg.token)}/sendVideo`, {
      method: 'POST', body: fd, signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) await logTgFailure('sendVideo', r);
    return r.ok;
  } catch (e) {
    logTgError('sendVideo', e);
    return false;
  }
}

async function sendWebhook(url: string, msg: NotifyMessage): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false; // http(s) 만
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Slack/Discord 호환(text) + 구조화 필드 동봉.
      body: JSON.stringify({ text: `*${msg.title}*\n${msg.body}`, title: msg.title, body: msg.body }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function sendTelegram(token: string, chatId: string, msg: NotifyMessage): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `${msg.title}\n${msg.body}`.slice(0, 4000) }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
