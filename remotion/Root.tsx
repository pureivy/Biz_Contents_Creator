import React from 'react';
import { Composition } from 'remotion';
import { AutoShorts, autoShortsSchema } from './AutoShorts';
import { sampleProps } from './sampleProps';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="AutoShorts"
    component={AutoShorts}
    schema={autoShortsSchema}
    // Studio 기본값 = 연출 전종이 담긴 표본(sampleProps). 실렌더는 inputProps 로 덮어써 영향 없다.
    defaultProps={sampleProps}
    fps={30}
    width={1080}
    height={1920}
    durationInFrames={sampleProps.totalFrames}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.totalFrames) })}
  />
);
