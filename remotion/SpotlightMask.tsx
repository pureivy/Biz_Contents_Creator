import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { spotlightRadius } from './anim';

/** 훅 액센트 — 피사체 중심(상단 42%)만 밝게 시작해 원이 열리며 전체 공개(첫 0.8초 시선 고정).
 *  자막·오버레이보다 아래(배경 위)에 배치 — 텍스트는 어두워지지 않는다. */
export const SpotlightMask: React.FC = () => {
  const f = useCurrentFrame();
  const r = spotlightRadius(f);
  if (r >= 149) return null; // 완전 개방 후 노드 제거 — 렌더 비용 0
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 50% 42%, rgba(0,0,0,0) ${r * 0.55}%, rgba(0,0,0,.72) ${r}%)`,
      }}
    />
  );
};
