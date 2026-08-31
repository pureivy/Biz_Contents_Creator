import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { staggerProgress } from './anim';

/** list 씬 오버레이 — 항목별 스태거 리빌(fade+slide-up), 번호 액센트. */
export const ListReveal: React.FC<{ items: string[]; total: number }> = ({ items, total }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '28%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, width: '78%' }}>
        {items.map((it, i) => {
          const p = staggerProgress(f, total, i, items.length);
          return (
            <div key={i} style={{ background: 'rgba(0,0,0,.45)', borderRadius: 20, padding: '26px 36px', fontSize: 54, fontWeight: 800, color: '#fff', textShadow: '0 3px 16px rgba(0,0,0,.6)', opacity: p, transform: `translateY(${(1 - p) * 24}px)` }}>
              <span style={{ color: '#ffd54a', marginRight: 16 }}>{i + 1}</span>{it}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
