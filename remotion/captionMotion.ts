/**
 * 자막 등장 모션(2026-09-04) — 편마다 다른 글자 움직임.
 *
 * 자막은 전 씬에 상시 떠 있어 영상 시간의 100% 를 차지한다. 그런데 지금까지 모든 편이 똑같이
 * 움직였다(단어별 스프링 팝). 배경 색과 카메라를 편마다 갈라 놨어도, 화면에서 가장 오래 보이는
 * 요소가 늘 같은 리듬으로 튀면 그게 채널의 지문이 된다.
 *
 * 여섯 가지를 두고 편 시드로 고른다. 공통 계약:
 *  · 단어가 순서대로 등장하고 제자리에 정착한다(읽는 순서를 만든다)
 *  · transform·opacity·filter 만 쓴다 — 레이아웃을 바꾸는 속성은 안 쓴다(줄바꿈이 흔들리면 안 된다)
 *  · 씬 길이에 영향이 없다(낭독이 길이를 지배한다는 불변식)
 */
import { Easing, interpolate, spring } from 'remotion';
import type React from 'react';

export type CaptionMotionName = '튀어오름' | '밀어올림' | '옆에서' | '커지며' | '흐림에서' | '또렷하게';
export const CAPTION_MOTIONS: readonly CaptionMotionName[] = [
  '튀어오름', '밀어올림', '옆에서', '커지며', '흐림에서', '또렷하게',
];

/** 시드 → 모션 이름(순수). random 은 코어 API 라 브라우저 번들에서 안전하다. */
export function pickCaptionMotion(rand: number): CaptionMotionName {
  return CAPTION_MOTIONS[Math.floor(rand * CAPTION_MOTIONS.length) % CAPTION_MOTIONS.length]!;
}

/**
 * 단어 하나의 스타일(순수) — local 은 씬 로컬 프레임, index 는 단어 순번.
 * perWord 는 단어 간 간격(프레임). 반환값은 그대로 span 에 얹는다.
 */
export function captionWordStyle(
  motion: CaptionMotionName, local: number, fps: number, index: number, perWord = 6,
): React.CSSProperties {
  const delay = index * perWord;
  const f = local - delay;

  // 스프링 계열 — 살짝 넘겼다 정착. opacity 는 1 로 잘라 쓴다(오버슛이 1 을 넘는다).
  const sp = spring({ frame: f, fps, config: { damping: 13, stiffness: 160, mass: 0.6 }, durationInFrames: 22 });
  // 이징 계열 — 넘치지 않고 스르륵 정착. 12프레임 안에 끝난다.
  const ez = interpolate(f, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });

  switch (motion) {
    case '튀어오름': // 종전 기본값 — 아래에서 튀어 올라 살짝 넘겼다 정착
      return { opacity: Math.min(1, sp), transform: `translateY(${(1 - sp) * 16}px)` };
    case '밀어올림': // 더 크게 아래에서 올라오되 오버슛 없음
      return { opacity: ez, transform: `translateY(${(1 - ez) * 34}px)` };
    case '옆에서': // 왼쪽에서 밀려들어옴 — 읽는 방향과 같아 시선이 앞으로 끌린다
      return { opacity: ez, transform: `translateX(${(1 - ez) * -28}px)` };
    case '커지며': // 작게 시작해 제자리 크기로. 스프링이라 끝에서 살짝 넘긴다
      return { opacity: Math.min(1, sp), transform: `scale(${0.72 + 0.28 * sp})` };
    case '흐림에서': // 초점이 맞는 느낌 — 렌즈가 잡히듯
      return { opacity: ez, filter: `blur(${(1 - ez) * 9}px)` };
    case '또렷하게': // 움직임 없이 나타나기만. 배경이 요란한 편에 어울린다
    default:
      return { opacity: ez };
  }
}
