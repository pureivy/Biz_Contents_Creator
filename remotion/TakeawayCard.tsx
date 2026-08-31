import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

/**
 * CTA 씬 결론 오버레이(2026-08-28 사용자 요청) — "무얼 심어라"를 화면에 띄운다.
 *
 * 배경(실측 short_6c8936f791): 내레이션은 "허리 높이면 회양목, 어깨 높이 상록이면 사철나무"라고
 * 답을 주는데, 화면에는 screenText "자리별 나무 정하기"라는 라벨만 떴다. 숏폼은 무음 시청이 흔하고
 * 되감기가 없다 — 소리로만 지나간 결론은 남지 않는다. list 씬엔 ListReveal 오버레이가 있는데
 * CTA 씬엔 아무것도 없어, 정작 가장 남아야 할 한 줄이 화면에서 빠져 있었다.
 *
 * 표기: 조건과 답을 화살표로 가른다("허리 높이 → 회양목"). 조건은 흐리게·답은 강조 — 시청자가
 * 자기 상황(조건)을 먼저 찾고 답으로 눈을 옮기는 순서다. 항목이 없으면 한 줄 결론으로 렌더한다.
 */
export const TakeawayCard: React.FC<{
  /** 결론 항목 — "조건 → 답" 쌍. 최대 3개(그 이상은 한 화면에 안 들어온다). */
  takeaways: Array<{ when: string; then: string }>;
  total: number;
}> = ({ takeaways, total }) => {
  const f = useCurrentFrame();
  // 카드 자체는 씬 시작 직후 뜨고, 항목은 차례로 얹힌다 — 내레이션이 항목을 하나씩 말하는 속도에 맞춘다.
  const inP = interpolate(f, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rows = takeaways.slice(0, 3);
  // 마지막 항목이 화면에 다 뜬 뒤에도 읽을 시간이 남도록 전체의 55% 안에서 스태거를 끝낸다.
  const stagger = Math.max(1, Math.floor((total * 0.55) / Math.max(1, rows.length)));

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: '26%' }}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', gap: 20, width: '82%',
          opacity: inP, transform: `translateY(${(1 - inP) * 18}px)`,
        }}
      >
        {rows.map((t, i) => {
          const p = interpolate(f, [12 + i * stagger, 12 + i * stagger + 10], [0, 1], {
            extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          });
          return (
            <div
              key={i}
              style={{
                background: 'rgba(0,0,0,.52)', borderRadius: 22, padding: '24px 34px',
                display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
                opacity: p, transform: `translateY(${(1 - p) * 20}px)`,
                textShadow: '0 3px 16px rgba(0,0,0,.65)',
              }}
            >
              <span style={{ fontSize: 46, fontWeight: 600, color: 'rgba(255,255,255,.82)' }}>{t.when}</span>
              <span style={{ fontSize: 42, color: '#ffd54a', fontWeight: 800 }}>→</span>
              <span style={{ fontSize: 56, fontWeight: 800, color: '#fff' }}>{t.then}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
