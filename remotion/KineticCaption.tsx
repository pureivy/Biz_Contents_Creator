import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { captionWordProgress } from './anim';

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
}> = ({ text, variant, bottomPct = 20, keyword, outline, fontPx = 70, hookFontPx = 84 }) => {
  const f = useCurrentFrame();
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null; // 빈 자막 — 배경 박스(특히 cta 배지)도 그리지 않음
  const isHook = variant === 'hook';
  const isCta = variant === 'cta';
  const isKw = kwMatcher(isHook ? undefined : keyword); // 훅은 전체 노란색 — 키워드 강조 중복 방지
  const box: React.CSSProperties = isCta
    ? { background: '#e53935', borderRadius: 999, padding: '24px 56px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' }
    : { padding: '32px 64px', display: 'flex', flexWrap: 'wrap', gap: '0 14px', justifyContent: 'center' }; // 자막 배경 없음(사용자 지정) — 가독성은 textShadow 담당
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: `${bottomPct}%` }}>
      <div style={box}>
        {words.map((w, i) => {
          // 단어별 부드러운 등장(ease-out rise) — 이산 점프 대신 5프레임 fade+slide-up.
          const p = captionWordProgress(f, i);
          return (
            <span key={i} style={{
              fontSize: isHook ? hookFontPx : fontPx, fontWeight: 800,
              color: isHook || isKw(w) ? '#ffd54a' : '#fff',
              lineHeight: 1.25, textShadow: '0 3px 18px rgba(0,0,0,.75)',
              ...(outline ? { WebkitTextStroke: '8px rgba(0,0,0,0.9)', paintOrder: 'stroke fill' } : {}),
              opacity: p, transform: `translateY(${(1 - p) * 16}px)`,
            }}>{w}</span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
