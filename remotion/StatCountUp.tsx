import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { countUpValue, sceneFadeOpacity } from './anim';

/** stat 씬 오버레이 — 중앙대(하단 25% 자막 세이프존 회피) 반투명 패널에 CountUp 수치+단위+라벨. */
export const StatCountUp: React.FC<{ stat: { value: number; unit?: string; label?: string }; total: number }> = ({ stat, total }) => {
  const f = useCurrentFrame();
  const v = countUpValue(f, total, stat.value);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '30%' }}>
      <div style={{ background: 'rgba(0,0,0,.45)', borderRadius: 32, padding: '48px 72px', textAlign: 'center', opacity: sceneFadeOpacity(f, total, 8) }}>
        <div style={{ fontSize: 160, fontWeight: 900, color: '#fff', lineHeight: 1, textShadow: '0 4px 24px rgba(0,0,0,.6)' }}>
          {v.toLocaleString('ko-KR')}
          {stat.unit ? <span style={{ fontSize: 72, fontWeight: 800, marginLeft: 8 }}>{stat.unit}</span> : null}
        </div>
        {stat.label ? <div style={{ fontSize: 44, fontWeight: 700, color: 'rgba(255,255,255,.92)', marginTop: 20 }}>{stat.label}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
