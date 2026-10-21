// Playtest settings: defaults suit Zoomies, and a glitchless.playtest.json in the project root can
// override any of them (scenarios, thresholds, URLs, how to tell a run is finished).

import fs from 'node:fs';
import path from 'node:path';

// Each scenario is one autoplay run. Fixed seeds make the bot play the same way on both builds, so
// the only thing that changes between baseline and candidate is the code.
export const DEFAULT_SCENARIOS = [
  { name: 'expert from level 1', params: { autoplay: 1, seed: 7, skill: 0.95, level: 1 }, max_s: 90 },
  { name: 'average from level 1', params: { autoplay: 1, seed: 21, skill: 0.8, level: 1 }, max_s: 90 },
  { name: 'novice from level 2', params: { autoplay: 1, seed: 42, skill: 0.6, level: 2 }, max_s: 90 },
];

// A change regresses a metric only when it is worse by BOTH the relative and the absolute margin,
// so small numbers (0.3 → 0.4 ms) and noise on fast machines don't fail a build.
//   higher: whether a higher value is worse (true) or better (false)
//   severity: 'fail' blocks the change, 'warn' is reported but passes
// Frame time is judged on the share of slow frames. p95 is only a warning: with vsync, frame times
// cluster at 16.7 and 33.3 ms, so p95 flips between them when about 5% of frames are slow.
export const DEFAULT_THRESHOLDS = {
  pct_frames_over_budget: { label: 'Slow frames (% over budget)', higher: true, pct: 50, abs: 2, severity: 'fail' },
  frame_p95: { label: 'Frame time p95 (ms)', higher: true, pct: 15, abs: 2, severity: 'warn' },
  render_cpu_ms: { label: 'Render CPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  draw_calls: { label: 'Draw calls per frame', higher: true, pct: 25, abs: 50, severity: 'fail' },
  hitches_per_min: { label: 'Hitches per minute', higher: true, pct: 50, abs: 1, severity: 'warn' },
  errors_per_session: { label: 'Errors per run', higher: true, pct: 50, abs: 1, severity: 'warn' },
  deaths_per_session: { label: 'Deaths per run', higher: true, pct: 50, abs: 2, severity: 'warn' },
  level_completion_pct: { label: 'Level completion (%)', higher: false, pct: 0, abs: 25, severity: 'warn' },
  geometries_growth_per_level_load: { label: 'Geometry growth per level load', higher: true, pct: 50, abs: 200, severity: 'warn' },
  // Per-level versions of the renderer metrics catch a regression the whole-run average dilutes.
  'level.pct_frames_over_budget': { label: 'Slow frames (% over budget)', higher: true, pct: 50, abs: 2, severity: 'fail' },
  'level.frame_p95': { label: 'Frame time p95 (ms)', higher: true, pct: 15, abs: 2, severity: 'warn' },
  'level.render_cpu_ms': { label: 'Render CPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  'level.draw_calls': { label: 'Draw calls per frame', higher: true, pct: 25, abs: 50, severity: 'fail' },
  new_errors: { label: 'New error types', severity: 'fail' },
  new_crashes: { label: 'Crashed runs', severity: 'fail' },
};

export const DEFAULTS = {
  game: 'http://localhost:5173/',
  server: process.env.GLITCHLESS_URL || 'http://localhost:7777',
  service: process.env.GLITCHLESS_SERVICE || null,
  api_key: process.env.GLITCHLESS_API_KEY || null,
  channel: 'chrome',
  env: 'playtest',
  // JS expression evaluated in the page; the run ends early once it is truthy.
  done_when: 'window.__GLITCHLESS_PLAYTEST_DONE__ || window.zoomies?.halted || window.zoomies?.won || window.zoomies?.quit',
  viewport: { width: 1280, height: 720 },
  runs_dir: '.glitchless/playtest',
  scenarios: DEFAULT_SCENARIOS,
  thresholds: DEFAULT_THRESHOLDS,
};

export function loadConfig(cwd = process.cwd(), overrides = {}) {
  const file = path.join(cwd, 'glitchless.playtest.json');
  let fromFile = {};
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`glitchless.playtest.json is not valid JSON: ${err.message}`);
    }
  }
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null));
  const cfg = { ...DEFAULTS, ...fromFile, ...clean };
  cfg.thresholds = { ...DEFAULT_THRESHOLDS, ...(fromFile.thresholds || {}) };
  cfg.runs_dir = path.resolve(cwd, cfg.runs_dir);
  return cfg;
}
