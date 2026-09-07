import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { countUpValue, sceneFadeOpacity } from './anim';
import { DrawnUnderline } from './DrawnUnderline';

/** stat 씬 오버레이 — 중앙대(하단 25% 자막 세이프존 회피) 반투명 패널에 CountUp 수치+단위+라벨. */
export const StatCountUp: React.FC<{ stat: { value: number; unit?: string; label?: string }; total: number; seed?: string }> = ({ stat, total, seed }) => {
  const f = useCurrentFrame();
  const v = countUpValue(f, total, stat.value);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '30%' }}>
      <div style={{ background: 'rgba(0,0,0,.45)', borderRadius: 32, padding: '48px 72px', textAlign: 'center', opacity: sceneFadeOpacity(f, total, 8) }}>
        <div style={{ fontSize: 160, fontWeight: 900, color: '#fff', lineHeight: 1, textShadow: '0 4px 24px rgba(0,0,0,.6)' }}>
          {v.toLocaleString('ko-KR')}
          {stat.unit ? <span style={{ fontSize: 72, fontWeight: 800, marginLeft: 8 }}>{stat.unit}</span> : null}
        </div>
        {/* 수치 아래 손그림 밑줄 — 카운트업이 멈출 즈음 그어져 '여기가 핵심'을 짚는다. */}
        {seed ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
            <DrawnUnderline seed={`${seed}:stat`} delay={Math.max(8, Math.round(total * 0.35))} width={300} />
          </div>
        ) : null}
        {stat.label ? <div style={{ fontSize: 44, fontWeight: 700, color: 'rgba(255,255,255,.92)', marginTop: 20 }}>{stat.label}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
