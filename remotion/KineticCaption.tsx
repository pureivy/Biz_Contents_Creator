import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { fitTextOnNLines } from '@remotion/layout-utils';
import { captionWordStyle, type CaptionMotionName } from './captionMotion';
import { FONT_NAME } from './loadFonts';

/** 자막 좌우 여백(box padding 64 × 2) + 단어 사이 gap 여유. 측정 폭을 이만큼 좁게 잡는다. */
const CAPTION_SIDE_PAD = 160;
/** 자막은 두 줄까지 — 세 줄이 되면 카드 영역까지 올라와 화면이 막힌다. */
const CAPTION_MAX_LINES = 2;

/**
 * 넘치면 줄이고, 넘치지 않으면 보정값 그대로(순수하지 않음 — 브라우저 측정을 쓴다).
 *
 * 자막 크기를 편마다 ±3px 흔들면서(varyLayout) 두 줄이 세 줄로 넘어갈 위험이 생겼다.
 * fitTextOnNLines 가 maxFontSize 를 상한으로 받으므로 '키우지는 않고 넘칠 때만 줄이는' 방향만 쓴다 —
 * 사용자가 손보정한 크기를 측정값이 덮어쓰지 않게.
 *
 * 측정은 폰트가 로딩된 뒤라야 맞다(loadFonts 의 delayRender 가 그것을 보장한다). 그래도 어떤
 * 이유로든 실패하면 보정값을 그대로 쓴다 — 자막 크기 하나 때문에 영상 생성이 죽는 쪽이 더 나쁘다.
 */
const fitCaption = (text: string, maxFontSize: number, boxWidth: number): number => {
  try {
    const { fontSize } = fitTextOnNLines({
      text, maxLines: CAPTION_MAX_LINES, maxBoxWidth: boxWidth,
      fontFamily: FONT_NAME, fontWeight: 800, maxFontSize, validateFontIsLoaded: false,
    });
    return Math.min(maxFontSize, Math.max(1, fontSize));
  } catch {
    return maxFontSize;
  }
};

/** 키워드 토큰 매칭(2자 이상) — 자막 단어에 키워드 토큰이 포함되면 강조색. 조사 오탐 방지로 1자는 제외. */
const kwMatcher = (keyword?: string): ((w: string) => boolean) => {
  const tokens = (keyword ?? '').split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return () => false;
  return (w) => tokens.some((t) => w.includes(t) || (w.length >= 2 && t.includes(w)));
};

export const KineticCaption: React.FC<{
  text: string;
  variant?: 'hook' | 'cta';
  /** 하단 여백(%) — 기본 20(종전). 유튜브 쇼츠·릴스는 하단 ~25% 를 플랫폼 UI 가 덮어 시인성이
   *  떨어진다(사용자 보고 2026-07-30) — 30±면 안전 영역(화면 65~70% 지점)에 얹힌다. */
  bottomPct?: number;
  /** 핵심 키워드 — 자막 속 해당 단어를 강조색으로(훅 씬은 전체가 이미 강조색이라 미적용). */
  keyword?: string;
  /** 글자 검은 테두리 — 밝은 배경에서도 자막이 뜨게(paint-order 로 획이 글자 뒤에 깔림). */
  outline?: boolean;
  /** 글자 크기(px) — 일반 씬. 기본 70(사용자 확정 2026-07-30, 종전 64). */
  fontPx?: number;
  /** 글자 크기(px) — 훅 씬. 기본 84(종전 78). */
  hookFontPx?: number;
  /** 등장 모션 — 편마다 다르다. 미지정=종전 동작('튀어오름'). */
  motion?: CaptionMotionName;
}> = ({ text, variant, bottomPct = 20, keyword, outline, fontPx = 70, hookFontPx = 84, motion = '튀어오름' }) => {
  const f = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null; // 빈 자막 — 배경 박스(특히 cta 배지)도 그리지 않음
  const isHook = variant === 'hook';
  const wanted = variant === 'hook' ? hookFontPx : fontPx;
  const size = fitCaption(text, wanted, Math.max(200, width - CAPTION_SIDE_PAD));
  const isCta = variant === 'cta';
  const isKw = kwMatcher(isHook ? undefined : keyword); // 훅은 전체 노란색 — 키워드 강조 중복 방지
  const box: React.CSSProperties = isCta
    ? { background: '#e53935', borderRadius: 999, padding: '24px 56px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' }
    : { padding: '32px 64px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' }; // 자막 배경 없음(사용자 지정) — 가독성은 textShadow 담당
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: `${bottomPct}%` }}>
      <div style={box}>
        {words.map((w, i) => {
          // 단어별 등장 — 모션 종류는 편마다 갈린다(captionMotion). 자막은 영상 시간의 100% 를
          // 차지하므로, 여기가 늘 같으면 앞에서 색·카메라를 갈라 놔도 지문이 남는다.
          const wordStyle = captionWordStyle(motion, f, fps, i);
          return (
            <span key={i} style={{
              fontSize: size, fontWeight: 800,
              color: isHook || isKw(w) ? '#ffd54a' : '#fff',
              lineHeight: 1.25, textShadow: '0 3px 18px rgba(0,0,0,.75)',
              ...(outline ? { WebkitTextStroke: '8px rgba(0,0,0,0.9)', paintOrder: 'stroke fill' } : {}),
              ...wordStyle,
            }}>{w}</span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
