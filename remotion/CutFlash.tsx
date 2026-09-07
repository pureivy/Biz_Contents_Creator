import React from 'react';
import { AbsoluteFill, Solid, useCurrentFrame, useVideoConfig, random } from 'remotion';
import { lightLeak } from '@remotion/effects/light-leak';

/**
 * 컷 위 빛샘(2026-09-04) — 씬이 바뀌는 지점에 필름 라이트리크를 한 번 스치게 한다.
 *
 * 이걸 넣을 수 있게 된 경위가 중요하다. 종전 주석은 "TransitionSeries 는 씬을 겹쳐 전체 길이를
 * 줄이므로 '오디오가 길이를 지배한다'는 불변식과 충돌한다"며 전환을 통째로 닫아 뒀다. 그 판단은
 * Transition 에 대해선 지금도 맞다. 그런데 조사에서 TransitionSeries.Overlay 를 찾았다 —
 * 컷 위에 얹히기만 하고 앞뒤 씬 길이를 건드리지 않는다. 길이 반론이 적용되지 않는 물건이다.
 *
 * lightLeak 은 progress 0→1 동안 열렸다 닫힌다. 오버레이 구간 전체에 그 한 번을 매핑한다.
 * seed 를 컷마다 바꿔 같은 무늬가 반복되지 않게 하고, hueShift 로 편의 룩과 색을 맞춘다.
 */
export const CutFlash: React.FC<{
  /** 컷 번호 — 무늬·색을 컷마다 다르게 하는 시드. */
  readonly cutIndex: number;
  /** 편 시드 — 편이 다르면 빛샘도 다르게. */
  readonly seed: string;
  /** 색상 회전(0~360). 편의 룩이 따뜻하면 낮게, 차가우면 높게. */
  readonly hueShift: number;
  /** 최대 불투명도(0~1) — 편마다 갈린다. 같은 장치라도 세기가 다르면 반복으로 안 읽힌다. */
  readonly strength?: number;
}> = ({ cutIndex, seed, hueShift, strength = 0.22 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  // 오버레이 구간을 progress 0→1 로. 구간이 1프레임이어도 0 나눗셈이 안 나게 막는다.
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames - 1)));
  // 세기 조절(2026-09-04 실측) — 날것의 lightLeak 은 화면을 통째로 덮고 자막까지 지운다.
  // 두 가지로 눌렀다.
  //   · mixBlendMode 'screen' — 덮어쓰는 대신 빛을 더한다(어두운 곳만 밝아지고 밝은 곳은 유지)
  //   · opacity 0.22 — 구간 중앙에서 최대. 스치듯 지나가야 '필름 느낌'이지 가리면 방해물이다
  // 종모양으로 여닫아 컷 직전·직후에는 0 이 되게 한다(경계에서 툭 끊기면 결함으로 보인다).
  const bell = Math.sin(progress * Math.PI);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity: strength * bell, mixBlendMode: 'screen' }}>
      <Solid
        width={width}
        height={height}
        color="transparent"
        effects={[lightLeak({ progress, hueShift, seed: Math.floor(random(`${seed}:leak:${cutIndex}`) * 1000) })]}
      />
    </AbsoluteFill>
  );
};
