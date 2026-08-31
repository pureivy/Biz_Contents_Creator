import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { clamp01, sceneFadeOpacity } from './anim';

/** quote 씬 오버레이 — 따옴표 장식 인용 카드 페이드인(+살짝 스케일), source 는 작은 글씨. */
export const QuoteCard: React.FC<{ quote: { text: string; source?: string }; total: number }> = ({ quote, total }) => {
  const f = useCurrentFrame();
  const p = clamp01(f / 12);
  const op = Math.min(p, sceneFadeOpacity(f, total, 8));
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '28%' }}>
      <div style={{ background: 'rgba(0,0,0,.5)', borderRadius: 28, padding: '56px 64px', width: '80%', textAlign: 'center', opacity: op, transform: `scale(${0.94 + 0.06 * p})` }}>
        <div style={{ fontSize: 100, fontWeight: 900, color: '#ffd54a', lineHeight: 0.6 }}>“</div>
        <div style={{ fontSize: 58, fontWeight: 800, color: '#fff', lineHeight: 1.45, textShadow: '0 3px 16px rgba(0,0,0,.6)' }}>{quote.text}</div>
        {quote.source ? <div style={{ fontSize: 38, fontWeight: 600, color: 'rgba(255,255,255,.8)', marginTop: 24 }}>— {quote.source}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
