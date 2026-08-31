export function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }
/** smoothstep 이징(0..1) — 선형 대비 시작·끝이 부드러워 Ken Burns 류 저속 모션에 적합. */
export function smoothstep(p: number): number {
  const t = clamp01(p);
  return t * t * (3 - 2 * t);
}
/** Ken Burns 스케일 — smoothstep 이징 + 씬별 변주: 짝수 씬 줌인(1→max), 홀수 씬 줌아웃(max→1). */
export function kenBurnsScale(local: number, total: number, max = 1.08, index = 0): number {
  const p = smoothstep(total > 0 ? local / total : 0);
  const zoomOut = index % 2 === 1;
  return zoomOut ? max - (max - 1) * p : 1 + (max - 1) * p;
}
// 팬 방향 4종 순환 — 전 씬 동일 대각선(↗ 고정)이던 단조로움 제거. 단위 벡터(±1).
const PAN_DIRS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 }, { x: -1, y: -1 },
];
export function kenBurnsPan(local: number, total: number, index = 0): { x: number; y: number } {
  const p = smoothstep(total > 0 ? local / total : 0);
  const d = PAN_DIRS[index % PAN_DIRS.length]!;
  return { x: (p - 0.5) * 24 * d.x, y: (p - 0.5) * 24 * d.y };
}
/** 씬 시작 페이드인만(0→1, ease) — 씬 전환 하드컷 완화. 오디오 싱크(씬 길이) 불변. */
export function sceneEnterFade(local: number, fade = 6): number {
  return smoothstep(fade > 0 ? local / fade : 1);
}
// 배경 모션 어휘 — I2V 상한제(핵심 컷만 클립화)에서 스틸 씬의 '움직임 공백'을 메우는 결정적 연출.
export type KenMove = 'zoom-in' | 'zoom-out' | 'push' | 'none';
export type KenIntensity = 'subtle' | 'normal' | 'strong';
// 진폭 재보정(2026-08-10 실런 체감 부족 실측): 종전 줌 8%/팬 ±12px(화면 1%)는 6~7초 씬에서 정지로
// 보였다. zoom=최대 배율, pan=최대 오프셋(px, ±), push=훅 강줌 배율.
const INTENSITY: Record<KenIntensity, { zoom: number; pan: number; push: number }> = {
  subtle: { zoom: 1.05, pan: 14, push: 1.15 },
  normal: { zoom: 1.12, pan: 30, push: 1.22 },
  strong: { zoom: 1.28, pan: 70, push: 1.35 }, // 2차 상향(2026-08-10 사용자 재보정 요청)
};
// 상시 오버스캔 + 축별 팬 캡 — objectFit:cover 는 이미지를 요소 상자 '안에서' 크롭하므로
// 커버 오버플로는 여유가 아니다(우측 검은 띠 실측 2026-08-10: 줌아웃 끝 s=1.08 에서 가로 여유
// (s-1)*540=43px < 시프트 70*1.08=75.6px → 32px 노출). 여유는 스케일 몫뿐이라 팬 오프셋을
// 축별 허용치(|t| ≤ (s-1)*half/s, 안전율 0.94)로 클램프한다 — 어떤 조합에도 노출 불가.
const OVERSCAN = 1.08;
const HALF_W = 540, HALF_H = 960; // 1080x1920 절반 — 축별 여유 산정 기준
const axisCap = (scale: number, half: number): number => Math.max(0, ((scale - 1) * half) / scale) * 0.94;
const clampAbs = (v: number, cap: number): number => Math.max(-cap, Math.min(cap, v));
/**
 * Ken Burns 확장 무브(순수) — move·intensity 둘 다 미지정이면 종전 index parity(줌 1.08·팬 ±12,
 * 오버스캔 없음) 그대로라 구 props 폴백 불변. intensity 지정 시 신 진폭 + 앞쪽 몰림 타이밍:
 * 줌·팬은 씬의 85%, push 는 70% 지점에 완료돼 초반 체감 속도를 높인다(이후 정지=settle).
 * 'push'는 훅용 강줌+미세 회전(1.5° 캡)+팬 40%, 'none'은 완전 정지.
 */
export function kenBurnsMove(local: number, total: number, index = 0, move?: KenMove, intensity?: KenIntensity): { scale: number; x: number; y: number; rotate: number } {
  if (move === 'none') return { scale: 1, x: 0, y: 0, rotate: 0 };
  if (!move && !intensity) { // 구 동작 보존 — fx 없는 씬(옛 props·명시 폴백)
    const pan = kenBurnsPan(local, total, index);
    return { scale: kenBurnsScale(local, total, 1.08, index), x: pan.x, y: pan.y, rotate: 0 };
  }
  const cfg = INTENSITY[intensity ?? (move === 'push' ? 'strong' : 'normal')]; // push 는 강줌이 본질
  const window = move === 'push' ? 0.7 : 0.85;
  const p = smoothstep(total > 0 ? Math.min(1, local / (total * window)) : 0);
  const d = PAN_DIRS[index % PAN_DIRS.length]!;
  if (move === 'push') {
    const scale = OVERSCAN * (1 + (cfg.push - 1) * p);
    return {
      scale,
      x: clampAbs((p - 0.5) * 2 * cfg.pan * 0.4 * d.x, axisCap(scale, HALF_W)),
      y: clampAbs((p - 0.5) * 2 * cfg.pan * 0.4 * d.y, axisCap(scale, HALF_H)),
      rotate: 1.5 * p,
    };
  }
  const zoomOut = move === 'zoom-out' || (move === undefined && index % 2 === 1);
  const scale = OVERSCAN * (zoomOut ? cfg.zoom - (cfg.zoom - 1) * p : 1 + (cfg.zoom - 1) * p);
  return {
    scale,
    x: clampAbs((p - 0.5) * 2 * cfg.pan * d.x, axisCap(scale, HALF_W)),
    y: clampAbs((p - 0.5) * 2 * cfg.pan * d.y, axisCap(scale, HALF_H)),
    rotate: 0,
  };
}
/** 자막 단어 i 의 등장 진행도(0..1, ease-out) — 이산 점프 대신 rise 프레임 동안 부드럽게. */
export function captionWordProgress(local: number, index: number, perWord = 6, rise = 5): number {
  const start = index * perWord;
  const p = clamp01((local - start) / Math.max(1, rise));
  return 1 - Math.pow(1 - p, 3);
}
/** 스포트라이트 개방 반경(%) — open 프레임 동안 30%→150%(전체 공개). 훅 첫 순간 시선 고정용. */
export function spotlightRadius(local: number, open = 24): number {
  return 30 + 120 * smoothstep(open > 0 ? Math.min(1, local / open) : 1);
}
/** 결정적 의사난수 0..1 (mulberry32 계열, 순수) — 파티클에 Math.random 금지(프레임 간 불일치로 렌더 깨짐). */
export function hash01(seed: number): number {
  let t = (Math.floor(seed) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** 파티클 상태(순수·결정적) — seed 고정 궤적: 순환 낙하(y01 0..1.15), 사인 스웨이, 회전, 크기 변주. */
export function particleState(seed: number, local: number): { x01: number; y01: number; sway: number; rot: number; size01: number } {
  const r1 = hash01(seed), r2 = hash01(seed * 7 + 1), r3 = hash01(seed * 13 + 2), r4 = hash01(seed * 31 + 3);
  const speed = 0.004 + r2 * 0.004; // 프레임당 낙하(화면비) ≈ 4~8초에 화면 한 바퀴
  return {
    x01: r1,
    y01: (r3 * 1.15 + local * speed) % 1.15, // 위 여유 포함 순환 — 씬 내내 끊김 없이
    sway: Math.sin(local * (0.03 + r4 * 0.03) + r1 * 6.28) * (0.02 + r2 * 0.02),
    rot: (local * (1 + r4 * 2) + r1 * 360) % 360,
    size01: r3,
  };
}
export function sceneFadeOpacity(local: number, total: number, fade = 6): number {
  if (total <= 0) return 1;
  const fin = clamp01(local / fade);
  const fout = clamp01((total - local) / fade);
  return clamp01(Math.min(fin, fout));
}
/** ease-out 카운트업 — total-settle 프레임까지 value 도달, 이후 유지. 정수 value→정수, 소수→1자리. */
export function countUpValue(local: number, total: number, value: number, settle = 12): number {
  const dur = Math.max(1, total - settle);
  const p = clamp01(local / dur);
  const eased = 1 - Math.pow(1 - p, 3);
  const d = Number.isInteger(value) ? 0 : 1;
  return Number((value * eased).toFixed(d));
}
/** 리스트 항목 index 의 등장 진행도(0..1) — enter 프레임부터 씬의 windowRatio 구간에 슬롯 분배. */
export function staggerProgress(local: number, total: number, index: number, count: number, enter = 15, windowRatio = 0.6, rise = 12): number {
  if (count <= 0) return 1;
  const windowEnd = Math.max(enter + 1, total * windowRatio);
  const slot = (windowEnd - enter) / count;
  const start = enter + slot * index;
  return clamp01((local - start) / rise);
}
