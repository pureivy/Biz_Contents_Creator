import React from 'react';
import { Composition } from 'remotion';
import { AutoShorts, autoShortsSchema, defaultProps } from './AutoShorts';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="AutoShorts"
    component={AutoShorts}
    schema={autoShortsSchema}
    defaultProps={defaultProps}
    fps={30}
    width={1080}
    height={1920}
    durationInFrames={90}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.totalFrames) })}
  />
);
