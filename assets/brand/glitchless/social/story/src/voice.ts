// The voiceover (scripts/voiceover.mjs): each scene's line, its words' times, and how long the scene runs for it.
import durations from '../public/voiceover/durations.json';
import hook from '../public/voiceover/hook.json';
import game from '../public/voiceover/game.json';
import bug from '../public/voiceover/bug.json';
import agent from '../public/voiceover/agent.json';
import fix from '../public/voiceover/fix.json';
import fast from '../public/voiceover/fast.json';
import dash from '../public/voiceover/dash.json';
import end from '../public/voiceover/end.json';
import { FPS } from './theme';

export type Word = { text: string; startMs: number; endMs: number; phrase: number };
export type LineId = keyof typeof durations;
export const WORDS: Record<LineId, Word[]> = { hook, game, bug, agent, fix, fast, dash, end };

// A line starts this many frames into its scene, once the fade from the last one is done.
export const VO_DELAY = 8;

// A scene's length: its line plus a breath, at least `min` frames and at most `max` (the footage runs out).
export const sceneFrames = (id: LineId, min: number, max = Infinity, pad = 0.45) => Math.min(max, Math.max(min, Math.ceil((durations[id] + pad) * FPS) + VO_DELAY));

// The frame (scene-relative) a word of a line is spoken at.
export const wordFrame = (id: LineId, word: string) => {
  const w = WORDS[id].find((x) => x.text.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(word.toLowerCase()));
  return VO_DELAY + Math.round(((w?.startMs ?? 0) / 1000) * FPS);
};
