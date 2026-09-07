/**
 * 중간 산출물 정리 — 렌더·생성이 끝나면 재생성 가능한 작업물을 지워 디스크를 회수한다.
 *
 * 배경(실측 2026-08-31): 쇼츠 154건이 20G, 카드뉴스 147건이 7.5G 를 쓰고 디스크가 96%(여유 20G)에
 * 닿았다. 최종 산출물(final.mp4 7.2G, slide_*.png 2.3G)보다 **중간물이 더 컸다** —
 *   쇼츠   remotion/bundle 5.3G + remotion/public 2.9G: 렌더마다 webpack 번들을 새로 굽고 그 안에
 *          씬 이미지·나레이션까지 복사한다. 렌더가 끝나면 아무도 안 읽는다.
 *   쇼츠   clips/ 1.2G: 씬별 클립. 조립이 끝나 final.mp4 가 나오면 역할이 끝난다.
 *   카드뉴스 bg-retry·bg-repair 폴더 2.0G: 실패한 재시도 잔해가 영구 보존됐다.
 * 하루 2~6세트가 계속 쌓이므로(월 ~16G) 일회성 청소가 아니라 완료 시점 자동 정리가 필요하다.
 *
 * 설계 원칙 — **정리는 본 작업을 절대 깨지 않는다.** 전 함수 fail-open(예외 삼킴, 0 반환)이고,
 * 존재 검사도 내부에서 한다. 정리 실패의 대가는 '디스크를 못 줄임'이지 '산출물 손실'이 아니어야 한다.
 */
import fs from 'node:fs';
import path from 'node:path';

/** 디렉토리 총 바이트(재귀). 실패는 0 — 회수량 표기는 참고값이지 정확성이 목적이 아니다. */
function dirBytes(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += dirBytes(full);
      else { try { total += fs.statSync(full).size; } catch { /* 무해 */ } }
    }
  } catch { /* 없음/권한 — 0 */ }
  return total;
}

/**
 * 디렉토리를 지운다. keep 정규식(파일명 대상)에 맞는 파일은 남기고, 남은 게 있으면 디렉토리도 유지한다.
 * 반환값은 회수한 바이트(참고용).
 *
 * keep 의 유일한 실사용처: 쇼츠의 remotion/narr_*.mp3 — ffmpeg 폴백 경로가 재사용해 TTS 이중 과금을
 * 막는다(shortsRender.ts). 번들만 지우고 mp3 는 남겨야 한다.
 */
export function pruneDir(dir: string, keep?: RegExp): number {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; } // 없음 · 파일 경로 · 권한 — 조용히 통과
  let freed = 0;
  let kept = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (!e.isDirectory() && keep?.test(e.name)) { kept++; continue; }
    try {
      freed += e.isDirectory() ? dirBytes(full) : fs.statSync(full).size;
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* 개별 실패는 건너뛴다 — 나머지는 계속 지운다 */ }
  }
  // 보존 대상이 없으면 빈 껍데기를 남기지 않는다.
  if (!kept) { try { fs.rmdirSync(dir); } catch { /* 비지 않았거나 없음 */ } }
  return freed;
}

/**
 * 부모 아래에서 접두사로 시작하는 **디렉토리들**을 통째로 지운다(파일은 대상 아님).
 * 카드뉴스의 bg-retry1·bg-retry2·bg-repair 처럼 회차가 붙어 이름이 고정되지 않는 잔해용.
 * 접두사 비교라 'bg' 는 'bg-retry' 에 걸리지 않는다 — 최종 배경(bg/)을 지우면 안 되기 때문이다.
 */
export function pruneByPrefix(parent: string, prefixes: readonly string[]): number {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch { return 0; }
  let freed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!prefixes.some((p) => e.name.startsWith(p))) continue;
    const full = path.join(parent, e.name);
    try { freed += dirBytes(full); fs.rmSync(full, { recursive: true, force: true }); }
    catch { /* 개별 실패는 건너뛴다 */ }
  }
  return freed;
}

/** 로그용 — 바이트를 사람이 읽는 단위로. */
export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}
