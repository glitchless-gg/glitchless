import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { Background, Mark, Voice, fadeIn } from '../components';
import { sceneFrames } from '../voice';
import { C, display, inter } from '../theme';

// 5 · The dashboard: Glitchless's Overview (the site's capture, sample data), drifting toward its findings. No words on it
// but the captions: the dashboard is the picture.
export const DASH_FRAMES = sceneFrames('dash', 105);
export const Dashboard: React.FC = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, DASH_FRAMES], [0, 1], { easing: Easing.inOut(Easing.cubic) });
  const scale = 0.86 + p * 0.22;
  const x = -40 - p * 380;
  const y = 70 - p * 150;
  return (
    <Background>
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <Img
          src={staticFile('brand/dash-overview.webp')}
          style={{ position: 'absolute', left: 0, top: 0, width: 2000, height: 1250, transformOrigin: '0 0', transform: `translate(${x + 100}px, ${y}px) scale(${scale})`, borderRadius: 18, boxShadow: '0 40px 120px rgba(0,0,0,0.5)' }}
        />
      </AbsoluteFill>
      <Voice id="dash" />
    </Background>
  );
};

// The end: what it is, where it is, and Glitchy.
export const END_FRAMES = sceneFrames('end', 110, Infinity, 0.9);
export const End: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Background>
      <div style={{ position: 'absolute', left: 120, top: 250, opacity: fadeIn(frame, 2) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <Mark size={120} />
          <span style={{ fontFamily: display, fontWeight: 800, fontSize: 104 }}>Glitchless</span>
        </div>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 56, marginTop: 36, color: C.text }}>Vibe debugging and analytics for games</div>
        <div style={{ fontFamily: inter, fontSize: 30, marginTop: 20, color: C.soft, opacity: fadeIn(frame, 12) }}>Three.js · Phaser · Godot · Unity · Unreal · GameMaker</div>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 64, marginTop: 56, color: C.mint, opacity: fadeIn(frame, 20) }}>glitchless.gg</div>
      </div>
      <Voice id="end" captions={false} />
      <Img src={staticFile('brand/glitchy-search.png')} style={{ position: 'absolute', right: 110, bottom: 120, width: 460, height: 460, opacity: fadeIn(frame, 8), transform: `translateY(${(1 - fadeIn(frame, 8, 18)) * 40}px)` }} />
    </Background>
  );
};
