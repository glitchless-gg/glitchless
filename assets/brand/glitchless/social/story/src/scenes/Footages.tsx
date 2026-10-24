import React from 'react';
import { AbsoluteFill, Sequence, staticFile } from 'remotion';
import { Audio } from '@remotion/media';
import { Footage, FootageBand, Glitch, Stretch, Voice } from '../components';
import { sceneFrames, wordFrame } from '../voice';

// 0 · The game: Zoomies on our Mac, the buggy build at a smooth 60 through Dog Park. It breaks up into the bug.
export const GAME_FRAMES = sceneFrames('game', 150, 240);
export const GAME_BREAK = GAME_FRAMES - 12;
const GAME: Stretch[] = [{ clip: 'dev', from: 4, frames: GAME_FRAMES }];
export const Game: React.FC = () => (
  <AbsoluteFill>
    <Glitch at={GAME_BREAK}>
      <Footage run={GAME} />
      <FootageBand run={GAME} />
    </Glitch>
    <Sequence from={GAME_BREAK} layout="none">
      <Audio src={staticFile('sfx/glitch.mp3')} volume={0.7} />
    </Sequence>
    <Voice id="game" />
  </AbsoluteFill>
);

// 1 · The bug: the same build on a slower laptop. Every pickup leaves its confetti behind, so Dog Park slides from about
// 40 fps to 21; on "until it's unplayable" it cuts to Rooftops, where it sits at 11.
export const BUG_FRAMES = sceneFrames('bug', 180, 270);
const CUT = wordFrame('bug', 'until');
const BUG: Stretch[] = [
  { clip: 'before', from: 5, frames: CUT },
  { clip: 'before', from: 20.5, frames: BUG_FRAMES - CUT },
];
export const Bug: React.FC = () => (
  <AbsoluteFill>
    <Footage run={BUG} />
    <FootageBand run={BUG} />
    <Voice id="bug" />
  </AbsoluteFill>
);

// 4 · Fast again: the same Rooftops seconds, after the fix.
export const FAST_FRAMES = sceneFrames('fast', 132, 190);
const FAST: Stretch[] = [{ clip: 'after', from: 20.5, frames: FAST_FRAMES }];
export const Fast: React.FC = () => (
  <AbsoluteFill>
    <Footage run={FAST} />
    <FootageBand run={FAST} />
    <Voice id="fast" />
  </AbsoluteFill>
);
