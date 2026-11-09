// Playtest settings: defaults suit Zoomies, and a glitchless.playtest.json in the project root can
// override any of them (scenarios, thresholds, URLs, how to tell a run is finished). With "command" set,
// scenarios run an engine build (Unity, Godot, Unreal, GameMaker) instead of a web game: see engine.js. With
// "engine": "roblox", they are play tests in the open Roblox Studio: see roblox.js.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROBLOX_SCENARIOS, ROBLOX_DONE_WHEN } from './roblox.js';

// Each scenario is one autoplay run. Fixed seeds make the bot play the same way on both builds, so
// the only thing that changes between baseline and candidate is the code.
export const DEFAULT_SCENARIOS = [
  { name: 'expert from level 1', params: { autoplay: 1, seed: 7, skill: 0.95, level: 1 }, max_s: 90 },
  { name: 'average from level 1', params: { autoplay: 1, seed: 21, skill: 0.8, level: 1 }, max_s: 90 },
  { name: 'novice from level 2', params: { autoplay: 1, seed: 42, skill: 0.6, level: 2 }, max_s: 90 },
];

// An engine build's runs: params become the game's own flags (--autoplay --seed=7), and each run measures for
// `seconds` after `warmup` (default 0, Unity 1) with the SDK's --glitchless-measure, then the build quits.
export const DEFAULT_ENGINE_SCENARIOS = [
  { name: 'autoplay, seed 7', params: { autoplay: true, seed: 7 }, seconds: 10 },
  { name: 'autoplay, seed 21', params: { autoplay: true, seed: 21 }, seconds: 10 },
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
  frame_p99: { label: 'Frame time p99 (ms)', higher: true, pct: 20, abs: 4, severity: 'warn' },
  render_cpu_ms: { label: 'Render CPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  // The game's update code (scripts and physics), where the SDK can time it: Phaser, Babylon.js, PlayCanvas, Godot and Unity.
  update_cpu_ms: { label: 'Update CPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  draw_calls: { label: 'Draw calls per frame', higher: true, pct: 25, abs: 50, severity: 'fail' },
  // What engine builds measure beyond that, where the engine reports it: the GPU's time (Unity, Unreal; Godot
  // off Metal), Unreal's RHI thread, Unity's physics, garbage collection, and growth over a run (a leak).
  gpu_ms: { label: 'GPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  rhi_cpu_ms: { label: 'RHI thread per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  physics_ms: { label: 'Physics per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  gc_ms: { label: 'Garbage collection per run (ms)', higher: true, pct: 50, abs: 20, severity: 'warn' },
  gc_collections: { label: 'Garbage collections per run', higher: true, pct: 50, abs: 3, severity: 'warn' },
  // Counts (objects, nodes, instances) by abs; sizes in MB by abs_mb.
  memory_growth: { label: 'Growth over a run', higher: true, pct: 50, abs: 100, abs_mb: 16, severity: 'warn' },
  hitches_per_min: { label: 'Hitches per minute', higher: true, pct: 50, abs: 1, severity: 'warn' },
  errors_per_session: { label: 'Errors per run', higher: true, pct: 50, abs: 1, severity: 'warn' },
  deaths_per_session: { label: 'Deaths per run', higher: true, pct: 50, abs: 2, severity: 'warn' },
  level_completion_pct: { label: 'Level completion (%)', higher: false, pct: 0, abs: 25, severity: 'warn' },
  geometries_growth_per_level_load: { label: 'Geometry growth per level load', higher: true, pct: 50, abs: 200, severity: 'warn' },
  // Per-level versions of the renderer metrics catch a regression the whole-run average dilutes. An engine build's
  // runs are compared one by one with the same margins.
  'level.pct_frames_over_budget': { label: 'Slow frames (% over budget)', higher: true, pct: 50, abs: 2, severity: 'fail' },
  'level.frame_p95': { label: 'Frame time p95 (ms)', higher: true, pct: 15, abs: 2, severity: 'warn' },
  'level.frame_p99': { label: 'Frame time p99 (ms)', higher: true, pct: 20, abs: 4, severity: 'warn' },
  'level.render_cpu_ms': { label: 'Render CPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  'level.update_cpu_ms': { label: 'Update CPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
  'level.draw_calls': { label: 'Draw calls per frame', higher: true, pct: 25, abs: 50, severity: 'fail' },
  'level.gpu_ms': { label: 'GPU per frame (ms)', higher: true, pct: 30, abs: 1, severity: 'fail' },
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
  // Engine builds: the command that starts one ("godot --path ." or an exported build; a path is relative to the
  // project), which engine it is when its name doesn't say, how long each run measures and waits first, and where
  // the build writes its measurement when it prints nothing (GameMaker's save area, say).
  command: null,
  engine: null,
  seconds: null,
  warmup: null,
  measure_file: null,
  // Roblox: which open Studio to play in (part of its place's name; needed when several are open), Luau to run in
  // Edit before each play test, and StudioMCP's command when Studio isn't where it installs by default.
  studio: null,
  luau: null,
  studio_mcp: null,
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
  cfg.root = cwd;
  if (cfg.engine) cfg.engine = String(cfg.engine).toLowerCase().replace(/\s+/g, '');
  const roblox = cfg.engine === 'roblox';
  if (!fromFile.scenarios && !clean.scenarios) {
    cfg.scenarios = roblox ? DEFAULT_ROBLOX_SCENARIOS : cfg.command ? DEFAULT_ENGINE_SCENARIOS : DEFAULT_SCENARIOS;
    cfg.default_scenarios = true;
  }
  // done_when is JavaScript in a browser and Luau on a Roblox server.
  if (roblox && !fromFile.done_when && !clean.done_when) cfg.done_when = ROBLOX_DONE_WHEN;
  return cfg;
}
