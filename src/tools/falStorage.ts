/**
 * fal.ai 스토리지 업로드 — 로컬 파일을 fal CDN(공개 URL)에 올려 반환.
 * 인스타그램 로그인 방식(graph.instagram.com)은 공개 video_url/image_url 만 받고
 * 로컬·resumable 업로드를 지원하지 않으므로(Meta 문서), 발행 직전 임시 호스팅에 사용.
 * FAL_KEY 필요(쇼츠 I2V 와 동일 키). 실패는 명시 throw — 발행은 fail-open 아님.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

const FAL_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn';

/** fal.media 호스트만 허용(응답 이형·SSRF 방지). */
function isFalMedia(u: string): boolean {
  try { return new URL(u).host.endsWith('.fal.media'); } catch { return false; }
}

/** 파일을 fal 스토리지에 올리고 공개 URL(https://*.fal.media/...) 반환. 실패 시 throw. */
export async function uploadToFalStorage(filePath: string, contentType: string, signal?: AbortSignal): Promise<string> {
  if (!CONFIG.falKey) throw new Error('FAL_KEY 미설정 — 인스타 발행은 공개 URL 호스팅(fal 스토리지)이 필요합니다');
  if (!fs.existsSync(filePath)) throw new Error('업로드 대상 파일 없음');
  const init = await fetch(FAL_INITIATE, {
    method: 'POST', signal,
    headers: { Authorization: `Key ${CONFIG.falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: path.basename(filePath) }),
  });
  if (!init.ok) throw new Error(`fal 스토리지 initiate 실패 HTTP ${init.status}`);
  const j = await init.json() as { file_url?: string; upload_url?: string };
  if (!j.file_url || !j.upload_url || !isFalMedia(j.file_url) || !isFalMedia(j.upload_url)) {
    throw new Error('fal 스토리지 응답 이형');
  }
  const put = await fetch(j.upload_url, {
    method: 'PUT', signal,
    headers: { 'Content-Type': contentType },
    body: fs.readFileSync(filePath),
  });
  if (!put.ok) throw new Error(`fal 스토리지 업로드 실패 HTTP ${put.status}`);
  return j.file_url;
}
