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
  glitchless.registerTool('comet_get_state', 'Comet Garden state: level, marble position, crystals collected, lives, score, active power-up, live shards and prism bursts so far.', { type: 'object', properties: {} }, safe(() => api.getState()));
  glitchless.registerTool(
    'comet_load_level',
    'Start a level (a new Babylon.js scene).',
    { type: 'object', properties: { level: { type: 'string', enum: LEVEL_IDS } }, required: ['level'] },
    safe(({ level }) => api.loadLevel(level)),
  );
  glitchless.registerTool('comet_prism_burst', 'Run the prism pickup\'s shard burst at the marble, to reproduce the stutter on demand.', { type: 'object', properties: {} }, safe(() => api.burst()));
  glitchless.registerTool(
    'comet_teleport',
    'Move the marble to (x, z) on the current level; the garden spans -18..18 on both. The nebula comet is at (-6, 13).',
    { type: 'object', properties: { x: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'] },
    safe(({ x, z }) => (Number.isFinite(x) && Number.isFinite(z) ? api.teleport(x, z) : { ok: false, error: 'x and z must be numbers' })),
  );
  glitchless.registerTool('comet_set_paused', 'Pause or resume the game.', { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] }, safe(({ paused }) => api.setPaused(!!paused)));
}
