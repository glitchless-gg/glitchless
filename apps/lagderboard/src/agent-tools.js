// Game tools for coding agents over WebMCP (gd.registerTool), next to Glitchless's own glitchless_measure and
// glitchless_live_performance. The same handlers are on window.lagderboard.
export function registerAgentTools(gd, api) {
  const none = { type: 'object', properties: {} };
  gd.registerTool(
    'lagderboard_get_state',
    "Lagderboard's state: phase (title, run, end), cubes on screen, the load the run is heading for, lights, explosions, the MORE tier, run time, the judge's latest 1 s frame-time verdict (p95, fps, over the 30 fps line or not), how long the meltdown streak has lasted, the device and the last result.",
    none,
    () => api.state(),
  );
  gd.registerTool('lagderboard_start_run', 'Start a run from the title or end screen.', none, () => api.start());
  gd.registerTool(
    'lagderboard_more',
    'Press MORE: one tier up (the load grows faster), 30% more cubes at once and three explosions.',
    { type: 'object', properties: { times: { type: 'number', description: 'How many presses (1-10, default 1)' } } },
    ({ times = 1 } = {}) => api.more(Number(times) || 1),
  );
  gd.registerTool(
    'lagderboard_set_load',
    'Set the cube count and hold it (starts a run if needed). While held the load stops growing and the run cannot end, so glitchless_measure can measure this device at a fixed number of cubes. hold: false lets the run grow and end again.',
    { type: 'object', properties: { cubes: { type: 'number', description: 'Cubes on screen, up to 2,000,000' }, hold: { type: 'boolean', description: 'Hold the load there (default true)' } }, required: ['cubes'] },
    ({ cubes, hold = true }) => api.setLoad(Number(cubes) || 0, hold !== false),
  );
}
