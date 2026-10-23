// Game tools for coding agents, exposed over WebMCP by the Glitchless SDK. Handlers never throw.
import { LEVELS } from './levels.js';

const LEVEL_IDS = LEVELS.map((l) => l.id);

const safe = (fn) => async (args = {}) => {
  try {
    return await fn(args || {});
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
};

export function registerAgentTools(glitchless, api) {
  glitchless.registerTool('spark_get_state', 'Spark Run state: level, board position and progress, lives, sparks, score, live spark effects, boost bursts so far, and whether the Collector script is still on.', { type: 'object', properties: {} }, safe(() => api.getState()));
  glitchless.registerTool(
    'spark_load_level',
    'Start a track.',
    { type: 'object', properties: { level: { type: 'string', enum: LEVEL_IDS } }, required: ['level'] },
    safe(({ level }) => api.loadLevel(level)),
  );
  glitchless.registerTool('spark_boost_burst', 'Run the boost pad\'s spark burst in front of the board, to reproduce the stutter on demand.', { type: 'object', properties: {} }, safe(() => api.burst()));
  glitchless.registerTool(
    'spark_teleport',
    'Move the board to x along the current track (0 is the start). The skyway magnet is at x 330.',
    { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    safe(({ x }) => (Number.isFinite(x) ? api.teleport(x) : { ok: false, error: 'x must be a number' })),
  );
  glitchless.registerTool('spark_set_paused', 'Pause or resume the game.', { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] }, safe(({ paused }) => api.setPaused(!!paused)));
}
