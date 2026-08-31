import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { particleState } from './anim';

/** 계절 파티클 종류별 형태 — CSS 도형(이미지·이모지 없이 결정적 렌더). */
const STYLE: Record<'leaves' | 'petals' | 'snow', { colors: string[]; w: number; h: number; radius: string }> = {
  leaves: { colors: ['#b5651d', '#c98a3d', '#8f5b2a'], w: 20, h: 11, radius: '50% 4px 50% 4px' },
  petals: { colors: ['#f6c8d8', '#f2a7c3', '#fbdce8'], w: 13, h: 13, radius: '50% 2px 50% 50%' },
  snow: { colors: ['#ffffff', '#eef4ff'], w: 10, h: 10, radius: '50%' },
};
const COUNT = 16; // 캡 고정 — DOM 노드 수·렌더 시간 상한

/** 계절 액센트 오버레이 — 잎·꽃잎·눈 낙하+스웨이. seed=sceneIndex 파생(순수·결정적, Math.random 금지). */
export const ParticleDrift: React.FC<{ kind: 'leaves' | 'petals' | 'snow'; sceneIndex: number }> = ({ kind, sceneIndex }) => {
  const f = useCurrentFrame();
  const st = STYLE[kind];
  return (
    <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: COUNT }, (_, i) => {
        const p = particleState(sceneIndex * 97 + i * 17, f);
        const size = 0.7 + p.size01 * 0.7;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${((p.x01 + p.sway) * 100 + 100) % 100}%`,
              top: `${p.y01 * 115 - 10}%`,
              width: st.w * size, height: st.h * size,
              background: st.colors[i % st.colors.length],
              borderRadius: st.radius,
              opacity: 0.75,
              transform: kind === 'snow' ? undefined : `rotate(${p.rot}deg)`,
              boxShadow: '0 1px 4px rgba(0,0,0,.25)',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
