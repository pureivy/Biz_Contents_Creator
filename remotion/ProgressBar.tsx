import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

export const ProgressBar: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = durationInFrames > 0 ? Math.min(1, f / durationInFrames) : 0;
  return <div style={{ position: 'absolute', top: 0, left: 0, height: 8, width: `${w * 100}%`, background: '#5598f8' }} />;
};
