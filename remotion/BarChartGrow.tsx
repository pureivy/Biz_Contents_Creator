import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { staggerProgress, sceneFadeOpacity } from './anim';

const ACCENT = '#ffd54a'; // 키워드 강조색과 동일(시각 일관성)
const BAR_MAX_H = 380;

/** chart 씬 오버레이 — 막대가 자라나는 비교 수치 패널(StatCountUp 스타일 미러).
 *  막대별 스태거 성장 + 값 라벨 카운트업, highlight 막대만 액센트색. */
export const BarChartGrow: React.FC<{ chart: { series: Array<{ label: string; value: number }>; unit?: string; highlight?: number }; total: number }> = ({ chart, total }) => {
  const f = useCurrentFrame();
  const max = Math.max(...chart.series.map((s) => s.value), 1e-9);
  const fmt = (v: number, int: boolean): string => Number(v.toFixed(int ? 0 : 1)).toLocaleString('ko-KR');
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '28%' }}>
      <div style={{ background: 'rgba(0,0,0,.45)', borderRadius: 32, padding: '44px 52px 36px', opacity: sceneFadeOpacity(f, total, 8) }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 36 }}>
          {chart.series.map((s, i) => {
            const p = staggerProgress(f, total, i, chart.series.length, 15, 0.55, 14);
            const hi = chart.highlight === i;
            const int = Number.isInteger(s.value);
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 150 }}>
                <div style={{ fontSize: 46, fontWeight: 900, color: hi ? ACCENT : '#fff', marginBottom: 12, opacity: p, textShadow: '0 3px 16px rgba(0,0,0,.6)' }}>
                  {fmt(s.value * p, int)}{chart.unit ?? ''}
                </div>
                <div style={{ width: 92, height: Math.max(6, (s.value / max) * BAR_MAX_H * p), borderRadius: 14, background: hi ? ACCENT : 'rgba(255,255,255,.85)', boxShadow: '0 4px 18px rgba(0,0,0,.35)' }} />
                <div style={{ fontSize: 38, fontWeight: 700, color: 'rgba(255,255,255,.92)', marginTop: 16, textShadow: '0 2px 12px rgba(0,0,0,.6)' }}>{s.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
