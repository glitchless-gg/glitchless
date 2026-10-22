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
  glitchless.registerTool('fetch_get_state', 'Fetch! game state: level, dog position, grounded, lives, bones, zoomies, how many confetti images exist and how many update listeners the level scene has.', { type: 'object', properties: {} }, safe(() => api.getState()));
  glitchless.registerTool(
    'fetch_load_level',
    'Start a level (a normal level start, which also adds a listener copy: see the listener leak).',
    { type: 'object', properties: { level: { type: 'string', enum: LEVEL_IDS } }, required: ['level'] },
    safe(({ level }) => (LEVEL_IDS.includes(level) ? api.loadLevel(level) : { ok: false, error: `level must be one of ${LEVEL_IDS.join(', ')}` })),
  );
  glitchless.registerTool('fetch_throw_ball', 'Run the tennis-ball pickup at the dog: zoomies plus the confetti burst, to reproduce the stutter on demand.', { type: 'object', properties: {} }, safe(() => api.throwBall()));
  glitchless.registerTool(
    'fetch_teleport',
    'Move the dog to x on the current level. Level 2\'s Long Jump pit spans x 3300-3490; the level 3 frisbee is at x 1570.',
    { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    safe(({ x }) => (Number.isFinite(x) ? api.teleport(x) : { ok: false, error: 'x must be a number' })),
  );
  glitchless.registerTool('fetch_set_paused', 'Pause or resume the game.', { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] }, safe(({ paused }) => api.setPaused(!!paused)));
}
