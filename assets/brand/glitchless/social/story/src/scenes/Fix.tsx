import React from 'react';
import { Easing, Sequence, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import { Audio } from '@remotion/media';
import { Background, Voice, fadeIn } from '../components';
import { C, FPS, display } from '../theme';
import { sceneFrames, wordFrame } from '../voice';

// 3 · The fix, in one number: the agent's own re-measure of the same reproduction (docs/demo/confetti-fix.patch made
// the confetti one InstancedMesh with reused slots). render_cpu_ms p50 went 8.85 → 1.10, eight times faster.
export const FIX_FRAMES = sceneFrames('fix', 150);
const DROP = wordFrame('fix', 'now');
const EIGHT = wordFrame('fix', 'eight');

export const Fix: React.FC = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [DROP, DROP + 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const ms = 8.85 + (1.1 - 8.85) * p;
  const pop = spring({ frame: frame - EIGHT, fps: FPS, config: { damping: 12, stiffness: 180 } });
  return (
    <Background>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 120, opacity: fadeIn(frame, 0) }}>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 60, color: C.soft }}>Time to draw each frame</div>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 260, lineHeight: 1.05, letterSpacing: -4, color: p >= 1 ? C.mint : C.coral }}>
          {ms.toFixed(2)}
          <span style={{ fontSize: 120, marginLeft: 20 }}>ms</span>
        </div>
        <div style={{ marginTop: 10, transform: `scale(${pop})`, opacity: frame >= EIGHT ? 1 : 0, fontFamily: display, fontWeight: 800, fontSize: 72, color: C.deep, background: C.mint, borderRadius: 999, padding: '10px 44px' }}>8× faster</div>
      </div>
      <Sequence from={EIGHT} layout="none">
        <Audio src={staticFile('sfx/ding.mp3')} volume={0.55} />
      </Sequence>
      <Voice id="fix" />
    </Background>
  );
};
