// Game-specific tools for coding agents (exposed by the Glitchless SDK over WebMCP).
// Handlers never throw — they return { ok: false, error } instead.

const LEVEL_IDS = ['level-1', 'level-2', 'level-3'];

function safe(fn) {
  return async (args = {}) => {
    try {
      return await fn(args || {});
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  };
}

/**
 * api = { getState(), loadLevel(id), triggerZoomies(), teleport(x), setPaused(bool) }
 */
export function registerAgentTools(gd, api) {
  gd.registerTool(
    'zoomies_get_state',
    'Zoomies! game state: level, player position/velocity, grounded, lives/deaths, bones/score, zoomies, live confetti mesh count, enemy count and UI state (title/playing/paused/complete/win).',
    { type: 'object', properties: {} },
    safe(() => api.getState()),
  );
  gd.registerTool(
    'zoomies_load_level',
    'Jump straight to a level (counts as a normal level start).',
    { type: 'object', properties: { level: { type: 'string', enum: LEVEL_IDS } }, required: ['level'] },
    safe(({ level }) => {
      if (!LEVEL_IDS.includes(level)) return { ok: false, error: `level must be one of ${LEVEL_IDS.join(', ')}` };
      return api.loadLevel(level);
    }),
  );
  gd.registerTool(
    'zoomies_trigger_zoomies',
    "Simulate picking up a tennis ball at the player's position — same code path as a real pickup (speed boost + confetti burst), to reproduce the perf issue on demand.",
    { type: 'object', properties: {} },
    safe(() => api.triggerZoomies()),
  );
  gd.registerTool(
    'zoomies_teleport',
    'Move the player onto the ground at (or nearest to) the given x on the current level. Level 3 "The Leap of Faith" gap spans x 42→48.',
    { type: 'object', properties: { x: { type: 'number', description: 'world x position' } }, required: ['x'] },
    safe(({ x }) => {
      if (typeof x !== 'number' || !Number.isFinite(x)) return { ok: false, error: 'x must be a finite number' };
      return api.teleport(x);
    }),
  );
  gd.registerTool(
    'zoomies_set_paused',
    'Pause or resume the game.',
    { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] },
    safe(({ paused }) => api.setPaused(!!paused)),
  );
}
