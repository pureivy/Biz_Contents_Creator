/**
 * 대비 카드(2026-09-03) — "이것 말고 이것"을 화면에서 나란히 보여준다.
 *
 * 가리키기 도해(화살표)를 걷어낸 자리를 메운다. 그쪽이 실패한 이유는 모양이 아니라 구조였다:
 * 작가는 대본을 쓸 때 배경 이미지를 본 적이 없어 '이미지의 어디'를 지정할 수 없다(실측 2026-09-03,
 * 화살표가 가지 사이 빈 공간을 가리켰다). 반면 '무엇 대신 무엇'은 원문만으로 정확히 쓸 수 있다 —
 * 위치 추측이 필요 없는 연출이라 틀릴 여지가 없다.
 *
 * 세로 9:16 에서는 좌우 분할이 글자를 너무 좁게 만들어 위아래로 쌓는다. 위=틀림(붉은), 아래=맞음(초록).
 * 두 패널이 0.4초 간격으로 들어와 시선이 위→아래로 흐른다.
 */
import React from 'react';
import { useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion';
import { popIn } from './anim';

const BAD = '#FF6B5E';
const GOOD = '#4ADE80';

const Panel: React.FC<{
  side: { label: string; note?: string }; tone: string; mark: string; delay: number;
}> = ({ side, tone, mark, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = popIn(f, fps, delay); // 오버슛이 있어 두 패널이 차례로 '툭' 얹힌다
  const o = Math.min(1, p);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 28, padding: '34px 44px',
      background: 'rgba(0,0,0,0.66)', borderRadius: 26, border: `4px solid ${tone}`,
      opacity: o, transform: `translateY(${(1 - p) * 26}px)`,
    }}>
      <div style={{
        flex: 'none', width: 92, height: 92, borderRadius: '50%', background: tone,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 58, fontWeight: 900, color: '#141414', lineHeight: 1,
      }}>{mark}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 60, fontWeight: 800, color: '#fff', lineHeight: 1.15 }}>{side.label}</div>
        {side.note ? (
          <div style={{ fontSize: 38, fontWeight: 600, color: 'rgba(255,255,255,0.82)', marginTop: 10 }}>{side.note}</div>
        ) : null}
      </div>
    </div>
  );
};

export const CompareCard: React.FC<{
  compare: { bad: { label: string; note?: string }; good: { label: string; note?: string } };
}> = ({ compare }) => (
  <AbsoluteFill style={{
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 40,
    padding: '0 70px', paddingBottom: 380, // 자막 영역(하단)을 비운다
  }}>
    <Panel side={compare.bad} tone={BAD} mark="✕" delay={4} />
    <Panel side={compare.good} tone={GOOD} mark="✓" delay={16} />
  </AbsoluteFill>
);
