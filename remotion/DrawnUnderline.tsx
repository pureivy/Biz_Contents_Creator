import React from 'react';
import { random, useCurrentFrame, useVideoConfig } from 'remotion';
import { evolvePath } from '@remotion/paths';
import { popIn } from './anim';

/**
 * 손으로 그은 밑줄(2026-09-04) — 왼쪽에서 오른쪽으로 그어진다.
 *
 * "AI가 찍어낸 화면"을 깨는 방법 중 하나는 사람이 손을 댄 흔적을 남기는 것이다. 자를 대고 그은
 * 직선은 그 반대라, 일부러 흔들리는 곡선을 쓴다 — 시드로 흔들림을 만들어 편마다 획이 다르다.
 *
 * @remotion/paths 의 evolvePath 로 '그려지는' 연출을 낸다. strokeDasharray·strokeDashoffset 을
 * 진행도에 맞춰 돌려주므로, 선을 실제로 긋는 것처럼 보인다.
 */
export const DrawnUnderline: React.FC<{
  /** 획 시드 — 편·자리마다 다른 흔들림. */
  readonly seed: string;
  /** 그리기 시작 프레임(씬 로컬). */
  readonly delay?: number;
  readonly width?: number;
  readonly color?: string;
  readonly thickness?: number;
}> = ({ seed, delay = 8, width = 320, color = '#ffd54a', thickness = 7 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // 그려지는 속도 — 스프링을 그대로 쓰면 오버슛이 1 을 넘어 dashoffset 이 음수가 된다. 잘라 쓴다.
  const p = Math.min(1, popIn(frame, fps, delay));

  const h = thickness * 3.2;
  // 손으로 그은 획 — 시작·끝을 살짝 올리고 가운데를 눌러 자연스럽게 휘게 한다. 흔들림은 시드로.
  const j = (k: string, amp: number): number => (random(`${seed}:${k}`) - 0.5) * amp;
  const y0 = h * 0.62 + j('a', h * 0.3);
  const y1 = h * 0.42 + j('b', h * 0.35);
  const y2 = h * 0.70 + j('c', h * 0.3);
  const d = `M ${thickness * 0.6} ${y0} Q ${width * 0.35} ${y1} ${width * 0.62} ${y0 * 0.96} T ${width - thickness * 0.6} ${y2}`;
  const evolved = evolvePath(p, d);

  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <path
        d={d}
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={evolved.strokeDasharray}
        strokeDashoffset={evolved.strokeDashoffset}
        opacity={0.92}
      />
    </svg>
  );
};
