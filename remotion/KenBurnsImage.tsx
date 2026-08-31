import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { kenBurnsMove } from './anim';
import type { KenMove, KenIntensity } from './anim';

const GRAD = ['#1f2937', '#3b2f2f', '#22303c', '#2f2a3c', '#243027'];
export const KenBurnsImage: React.FC<{ src: string | null; total: number; index: number; move?: KenMove; intensity?: KenIntensity }> = ({ src, total, index, move, intensity }) => {
  const f = useCurrentFrame();
  // 씬별 변주 — move 미지정이면 종전 그대로(짝수 줌인/홀수 줌아웃, 팬 4종 순환), 지정 시 push(훅 강줌+미세 회전) 등 확장 무브.
  const m = kenBurnsMove(f, total, index, move, intensity);
  const transform = `scale(${m.scale}) translate(${m.x}px, ${m.y}px)${m.rotate ? ` rotate(${m.rotate}deg)` : ''}`;
  if (!src) return <AbsoluteFill style={{ background: `linear-gradient(160deg, ${GRAD[index % GRAD.length]}, #000)`, transform }} />;
  return <AbsoluteFill style={{ transform }}><Img src={staticFile(src)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></AbsoluteFill>;
};
