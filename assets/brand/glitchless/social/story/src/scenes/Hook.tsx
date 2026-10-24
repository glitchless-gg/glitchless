import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Background, Voice } from '../components';
import { C, display } from '../theme';
import { sceneFrames } from '../voice';

// The hook: "It runs great on your machine." Then the game, running great on ours.
export const HOOK_FRAMES = sceneFrames('hook', 60, Infinity, 0.35);

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const intro = interpolate(frame, [0, 8], [0.94, 1], { extrapolateRight: 'clamp' });
  return (
    <Background>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${intro})` }}>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 112, letterSpacing: -1, color: C.text, textAlign: 'center', lineHeight: 1.05 }}>
          It runs great
          <br />
          on your machine.
        </div>
      </AbsoluteFill>
      <Voice id="hook" captions={false} />
    </Background>
  );
};
