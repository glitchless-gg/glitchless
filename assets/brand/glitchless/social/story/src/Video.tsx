import { AbsoluteFill, Sequence, interpolate, staticFile } from 'remotion';
import { Audio } from '@remotion/media';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { FPS } from './theme';
import { Hook, HOOK_FRAMES } from './scenes/Hook';
import { Game, GAME_BREAK, GAME_FRAMES, Bug, BUG_FRAMES, Fast, FAST_FRAMES } from './scenes/Footages';
import { Agent, AGENT_FRAMES } from './scenes/Agent';
import { Fix, FIX_FRAMES } from './scenes/Fix';
import { Dashboard, DASH_FRAMES, End, END_FRAMES } from './scenes/Dashboard';

// The vibe debugging story: the hook, the game running great on our Mac, the bug on a slower laptop, the agent finds
// it over MCP, the fix, fast again, the dashboard. Each scene runs as long as its line. The game breaks up and cuts
// hard into the bug; the rest fade.
const FADE = 10;
const SCENES = [
  { C: Hook, d: HOOK_FRAMES },
  { C: Game, d: GAME_FRAMES, cut: true },
  { C: Bug, d: BUG_FRAMES },
  { C: Agent, d: AGENT_FRAMES },
  { C: Fix, d: FIX_FRAMES },
  { C: Fast, d: FAST_FRAMES },
  { C: Dashboard, d: DASH_FRAMES },
  { C: End, d: END_FRAMES },
];

const START = SCENES.map((_, i) => SCENES.slice(0, i).reduce((n, s) => n + s.d - (s.cut ? 0 : FADE), 0));
export const TOTAL_FRAMES = START[SCENES.length - 1] + SCENES[SCENES.length - 1].d;

// The music (music/bed.mp3, 48 s) plays under the game and stops dead when it breaks. The bug plays without it; it
// comes back with the agent, from far enough into the bed that its own last chord lands on the end card.
const BED = Math.floor(48 * FPS);
const GAME_START = START[1];
const MUSIC_1 = GAME_BREAK;
const AGENT_START = START[3];
const MUSIC_2 = TOTAL_FRAMES - AGENT_START;
const ramp = (len: number, inn: number, out: number) => (f: number) =>
  interpolate(f, [0, inn, len - out, len], [0, 0.13, 0.13, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

export const Story = () => (
  <AbsoluteFill>
    <TransitionSeries>
      {SCENES.flatMap(({ C, d }, i) => [
        ...(i && !SCENES[i - 1].cut ? [<TransitionSeries.Transition key={`t${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />] : []),
        <TransitionSeries.Sequence key={`s${i}`} durationInFrames={d}>
          <C />
        </TransitionSeries.Sequence>,
      ])}
    </TransitionSeries>
    <Sequence from={GAME_START} durationInFrames={MUSIC_1} layout="none">
      <Audio src={staticFile('music/bed.mp3')} volume={ramp(MUSIC_1, 10, 1)} />
    </Sequence>
    <Sequence from={AGENT_START} durationInFrames={MUSIC_2} layout="none">
      <Audio src={staticFile('music/bed.mp3')} trimBefore={Math.max(MUSIC_1, BED - MUSIC_2)} volume={ramp(MUSIC_2, 24, 20)} />
    </Sequence>
  </AbsoluteFill>
);
