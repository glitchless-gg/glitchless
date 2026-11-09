// Engine builds: Unity, Godot, Unreal and GameMaker. A scenario starts the build from the command line with the
// game's own autoplay arguments plus --glitchless-measure=SECONDS. The Glitchless SDK in the build times every frame
// for that long, prints one line of JSON ({"glitchless_measure": {...}}) and quits. This turns those lines into the
// summary compareRuns reads, so engine runs need no browser and no Glitchless server.
// Builds run one at a time, as browser bots do: two games at once fight over the GPU.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gitInfo } from './run.js';

// How each engine takes flags, how long to wait before measuring, and how to give a game an autoplay mode.
// Unreal and GameMaker games read single-dash flags; the Glitchless SDKs in them take either.
// Unity's memory counters read nothing on the first frames, so it measures after a second; the others from the start,
// so errors and stutter while the game loads count too.
export const ENGINES = {
  godot: {
    label: 'Godot',
    dash: '--',
    warmup: 0,
    autoplay:
      'In Godot, read the flags from OS.get_cmdline_user_args() in the main scene\'s _ready(): with "--autoplay", let a bot play (pick inputs from a RandomNumberGenerator seeded with the --seed=N value, so the same seed plays the same way on both builds), call Glitchless.level_start() as it goes, and keep playing for as long as the scenario measures. The demo in the Glitchless repo, godot/demo/demo.gd, does this.',
  },
  unity: {
    label: 'Unity',
    dash: '--',
    warmup: 1,
    autoplay:
      'In Unity, read the flags from System.Environment.GetCommandLineArgs() in a startup script: with "--autoplay", let a bot play (a System.Random seeded with the --seed=N value, so the same seed plays the same way on both builds), call Glitchless.LevelStart() as it goes, and keep playing for as long as the scenario measures. The SDK\'s Fetch! sample (Package Manager → Glitchless → Samples) has such a bot.',
  },
  unreal: {
    label: 'Unreal',
    dash: '-',
    warmup: 0,
    autoplay:
      'In Unreal, check FParse::Param(FCommandLine::Get(), TEXT("autoplay")) in the game mode\'s BeginPlay: with -autoplay, let a bot drive the pawn (an FRandomStream seeded from -seed=N, read with FParse::Value, so the same seed plays the same way on both builds), call Level Start as it goes, and keep playing for as long as the scenario measures.',
  },
  gamemaker: {
    label: 'GameMaker',
    dash: '-',
    warmup: 0,
    autoplay:
      'In GameMaker, check glitchless_has_flag("autoplay") in the first room: with -autoplay, let a bot play (random_set_seed(real(glitchless_flag_value("seed", "1"))), so the same seed plays the same way on both builds), call glitchless_level_start() as it goes, and keep playing for as long as the scenario measures.',
  },
};

const GENERIC_AUTOPLAY =
  'Give the game an autoplay mode: a flag such as --autoplay that lets a bot play by itself, with --seed=N so the same seed plays the same way on both builds. Have it start levels as it goes (Glitchless level_start) and keep playing for as long as the scenario measures.';

// Unity, Godot, Unreal and GameMaker builds print this line when started with the measure flag.
const MEASURE_LINE = /\{\s*"glitchless_measure"\s*:/;

/** Finds the SDK's measure line in a build's output (Unreal prefixes it with its log category). */
export function parseMeasure(text) {
  const lines = String(text || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const at = line.search(MEASURE_LINE);
    if (at < 0) continue;
    try {
      const m = JSON.parse(line.slice(at).trim()).glitchless_measure;
      if (m && typeof m === 'object') return m;
    } catch {}
  }
  return null;
}

/** Splits a command line written as one string ("godot --path ." or with quotes) into its arguments. */
export function splitCommand(command) {
  if (Array.isArray(command)) return command.map(String);
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of String(command || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else {
      cur += ch;
    }
  }
  if (cur || any) out.push(cur);
  return out;
}

const home = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

// A path in the command is relative to the project, and a macOS .app runs its own executable.
export function resolveCommand(command, cwd) {
  const argv = splitCommand(command);
  if (!argv.length) throw new Error('"command" in glitchless.playtest.json is empty. Set it to the exported build, or the engine\'s command line with the project path (for Godot: ["godot", "--path", "."]).');
  let bin = home(argv[0]);
  // A path, or a build sitting in the project folder ("Game.app", "Game.x86_64"), is relative to the project;
  // a bare name ("godot") is looked up on the PATH, even beside a folder of that name.
  const local = path.resolve(cwd, bin);
  if (bin.includes('/') || bin.includes('\\') || /\.app\/?$/.test(bin) || (fs.existsSync(local) && fs.statSync(local).isFile())) bin = local;
  if (/\.app\/?$/.test(bin) && fs.existsSync(path.join(bin, 'Contents/MacOS'))) {
    const name = path.basename(bin).replace(/\.app\/?$/, '');
    const inside = fs.readdirSync(path.join(bin, 'Contents/MacOS'));
    bin = path.join(bin, 'Contents/MacOS', inside.includes(name) ? name : inside[0]);
  }
  return [bin, ...argv.slice(1)];
}

/** Which engine a command starts: from its name, then from the files an export leaves beside its executable. */
export function detectEngine(argv) {
  const [bin, ...rest] = argv;
  const name = path.basename(bin || '');
  const all = argv.join(' ');
  if (/godot/i.test(name) || rest.some((a) => /\.pck$/.test(a) || a === '--main-pack')) return 'godot';
  if (/UnrealEditor|UE4Editor/i.test(name) || rest.some((a) => /\.uproject$/i.test(a))) return 'unreal';
  if (/YoYo Runner|Runner\.exe$/i.test(all) || rest.some((a) => /(^|[/\\])(game\.ios|data\.win|game\.unx)$/.test(a))) return 'gamemaker';
  if (/^Unity(\.exe)?$/i.test(name)) return 'unity';
  const dir = path.dirname(bin || '');
  const near = [dir, path.join(dir, '../Resources'), path.join(dir, '../Frameworks'), path.join(dir, '../UE')];
  const has = (test) => near.some((d) => {
    try {
      return fs.readdirSync(d).some(test);
    } catch {
      return false;
    }
  });
  if (has((f) => /^UnityPlayer\.(dylib|dll|so)$/.test(f) || /_Data$/.test(f))) return 'unity';
  if (has((f) => /\.pck$/.test(f))) return 'godot';
  if (has((f) => /^(game\.ios|data\.win|game\.unx)$/.test(f))) return 'gamemaker';
  if (has((f) => f === 'Engine' || /\.uproject$/.test(f))) return 'unreal';
  return null;
}

// A scenario's params become the game's own flags: { autoplay: true, seed: 7 } → --autoplay --seed=7 (-autoplay in
// Unreal and GameMaker). true is a bare flag; false and null leave it out.
export function paramFlags(params = {}, dash = '--') {
  const out = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === false) continue;
    out.push(v === true ? `${dash}${k}` : `${dash}${k}=${v}`);
  }
  return out;
}

/** The arguments one scenario adds to the command: the game's own flags, then the measure flags. */
export function scenarioArgs(engine, base, sc, { out } = {}) {
  const dash = ENGINES[engine]?.dash || '--';
  const game = [...paramFlags(sc.params, dash), ...(sc.args || []).map(String)];
  const measure = [`${dash}glitchless-measure=${sc.seconds}`, `${dash}glitchless-warmup=${sc.warmup}`, ...(out ? [`${dash}glitchless-out=${out}`] : [])];
  // Godot hands a game only the arguments after "--" (OS.get_cmdline_user_args).
  const separate = engine === 'godot' && ![...base, ...game].some((a) => a === '--' || a === '++');
  return [...(separate ? ['--'] : []), ...game, ...measure];
}

// The scenario's measure settings with the engine's defaults filled in.
export function engineScenario(sc, engine, cfg) {
  const warmup = sc.warmup ?? cfg.warmup ?? ENGINES[engine]?.warmup ?? 1;
  const seconds = sc.seconds ?? cfg.seconds ?? 10;
  return { ...sc, seconds, warmup, max_s: sc.max_s ?? warmup + seconds + 120 };
}

const label = (sc) => sc.name || [...paramFlags(sc.params), ...(sc.args || [])].join(' ') || 'run';
const tail = (text, n = 15) => String(text || '').trimEnd().split(/\r?\n/).slice(-n).join('\n');

// Runs one build to the end, or kills it at the time cap.
function runBuild(argv, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let output = '';
    let timedOut = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d) => {
      output += d;
      if (output.length > 4_000_000) output = output.slice(-2_000_000); // the measure line comes last
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`Could not start ${argv[0]}: no such program. Set "command" in glitchless.playtest.json to the exported build, or to the engine's command line with the project path (for Godot: ["godot", "--path", "."]).`) : err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut, seconds: Math.round((Date.now() - t0) / 1000) });
    });
  });
}

function readIfNew(file, since) {
  try {
    if (fs.statSync(file).mtimeMs < since - 1000) return null;
    return parseMeasure(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Plays every scenario with the build, one at a time. */
export async function runEngineScenarios(cfg, { command = cfg.command, scenarios = cfg.scenarios, log = () => {} } = {}) {
  const root = cfg.root || process.cwd();
  const base = resolveCommand(command, root);
  const engine = cfg.engine || detectEngine(base);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-playtest-'));
  for (const sc of scenarios) {
    if (!paramFlags(sc.params).length && !(sc.args || []).length) throw new Error(`Scenario "${label(sc)}" passes nothing to the game, so nothing starts its autoplay bot. Give it "params" (such as { "autoplay": true, "seed": 7 }) or "args". ${ENGINES[engine]?.autoplay || GENERIC_AUTOPLAY}`);
  }
  const results = [];
  try {
    for (const [i, raw] of scenarios.entries()) {
      const sc = engineScenario(raw, engine, cfg);
      const out = path.join(tmp, `run-${i + 1}.json`);
      const argv = [...base, ...scenarioArgs(engine, base, sc, { out })];
      log(`run ${i + 1}/${scenarios.length}: ${label(sc)} …`);
      const t0 = Date.now();
      const r = await runBuild(argv, { cwd: root, timeoutMs: sc.max_s * 1000 });
      const measure = parseMeasure(r.output) || readIfNew(out, t0) || (cfg.measure_file ? readIfNew(path.resolve(root, home(cfg.measure_file)), t0) : null);
      const shown = argv.filter((a) => !a.includes('glitchless-out='));
      const result = { scenario: sc.name || null, params: sc.params, args: sc.args, seconds: sc.seconds, warmup: sc.warmup, command: shown, session_id: measure?.session_id || null, elapsed_s: r.seconds, finished: !!measure && !measure.error, crashed: false, exit_code: r.code, measure: measure && !measure.error ? measure : null };
      if (measure?.error) throw new Error(`${label(sc)}: the build measured nothing: ${measure.error}${/off/i.test(measure.error) ? ' A playtest needs it on: leave out --glitchless-off, and turn the in-game "share data" setting back on for this device.' : ` The game has to keep drawing frames for warmup + seconds (${sc.warmup} + ${sc.seconds} s): if its autoplay run is shorter, lower "seconds" or let the bot keep playing.`}`);
      if (!measure) {
        if (r.timedOut) {
          Object.assign(result, { crashed: true, reason: `froze or never quit within ${sc.max_s} s`, output_tail: tail(r.output) });
        } else if (r.code === 0 && !r.signal) {
          throw new Error(
            `${label(sc)}: the build quit after ${r.seconds} s without printing its measurement ({"glitchless_measure": …}). Either it quit before the measure ended, because its autoplay run is shorter than warmup + seconds (${sc.warmup} + ${sc.seconds} s): lower "seconds" or let the bot keep playing; or the build doesn't have the Glitchless SDK (Unity, Godot, Unreal and GameMaker builds with it print that line when started with --glitchless-measure=SECONDS)${engine === 'unity' || engine === 'gamemaker' ? '; or the game\'s file sandbox kept it from writing the measurement where this run could read it: set "measure_file" in glitchless.playtest.json to where it writes glitchless/measure.json' : ''}.\nLast lines it printed:\n${tail(r.output)}`,
          );
        } else {
          Object.assign(result, { crashed: true, reason: r.signal ? `killed by ${r.signal}` : `exit code ${r.code}`, output_tail: tail(r.output) });
        }
      }
      results.push(result);
      const m = result.measure;
      log(m ? `  → ${m.frames} frames · p95 ${m.frame_ms?.p95} ms · ${m.hitch_count} hitch(es)${m.new_errors ? ` · ${m.new_errors} error(s)` : ''} · ${r.seconds}s` : `  → crashed (${result.reason}) after ${r.seconds}s`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!results.some((r) => r.measure)) {
    const first = results[0];
    throw new Error(`The build crashed in every run before it finished measuring (${first.reason}). Last lines it printed:\n${first.output_tail}`);
  }
  return { engine, command: base, results };
}

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const p50 = (x) => (x && typeof x === 'object' ? (x.p50 ?? null) : (x ?? null));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function mostFrames(pairs) {
  const by = new Map();
  for (const [v, n] of pairs) if (v != null) by.set(v, (by.get(v) || 0) + n);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// The same error in two builds: messages carry numbers that change every run (an ID, a row), and an edit above the
// line that raised it moves its line number. glitchless-deck matches errors the same way.
export const errorType = (e) => `${e.kind || ''}|${String(e.message || '').replace(/\d+/g, '#')}|${String(e.location || '').replace(/:\d+/g, '')}`;

// One run's numbers, from its measure JSON. Engines differ: update time is update_cpu_ms in Unity and Unreal and
// process_ms in Godot and GameMaker; GameMaker has no draw calls; only Unreal has an RHI thread.
function runMetrics(m) {
  return {
    frames: m.frames ?? null,
    seconds: m.seconds ?? null,
    frame_budget_ms: m.frame_budget_ms ?? null,
    pct_frames_over_budget: m.pct_frames_over_budget ?? null,
    frame_p50: m.frame_ms?.p50 ?? null,
    frame_p95: m.frame_ms?.p95 ?? null,
    frame_p99: m.frame_ms?.p99 ?? null,
    frame_worst: m.frame_ms?.worst ?? null,
    render_cpu_ms: p50(m.render_cpu_ms),
    update_cpu_ms: p50(m.update_cpu_ms ?? m.process_ms),
    gpu_ms: p50(m.gpu_ms),
    rhi_cpu_ms: p50(m.rhi_cpu_ms),
    physics_ms: p50(m.physics_ms),
    draw_calls: m.draw_calls && typeof m.draw_calls === 'object' ? (m.draw_calls.avg ?? null) : (m.draw_calls ?? null),
    hitches: m.hitch_count ?? null,
    hitches_per_min: m.seconds ? round((m.hitch_count || 0) / (m.seconds / 60)) : null,
    errors: m.new_errors ?? null,
    gc_ms: m.gc_ms ?? null,
    gc_collections: m.gc_collections ?? null,
    level_start: m.level_start ?? null,
    level_end: m.level_end ?? null,
  };
}

/**
 * The summary compareRuns reads, from the runs of one playtest. Across runs, per-frame numbers are averaged weighted
 * by frames (exact for slow frames and draw calls, close for percentiles), hitches are counted per minute measured,
 * and each run is kept in by_scenario for a run-by-run comparison.
 */
export function measureSummary(results) {
  const measured = results.filter((r) => r.measure);
  const runs = measured.map((r) => ({ r, x: runMetrics(r.measure) }));
  const weighted = (key, d = 2) => {
    let total = 0;
    let weight = 0;
    for (const { x } of runs) {
      if (x[key] == null) continue;
      const w = x.frames || x.seconds || 1;
      total += x[key] * w;
      weight += w;
    }
    return weight ? round(total / weight, d) : null;
  };
  const measuredSeconds = sum(runs.map(({ x }) => x.seconds || 0));
  const errors = new Map();
  for (const { r } of runs) {
    for (const e of r.measure.errors || []) {
      const fp = errorType(e);
      const have = errors.get(fp) || { fingerprint: fp, kind: e.kind, message: e.message, location: e.location, count: 0, sessions: 0 };
      have.count += e.count || 1;
      have.sessions += 1;
      errors.set(fp, have);
    }
  }
  // What grew over a run (objects, nodes, instances, MB): a leak shows as growth that a fixed-seed run repeats.
  const growth = {};
  const growthRuns = {};
  for (const { r } of runs) {
    for (const [k, v] of Object.entries(r.measure.memory_delta || {})) {
      if (typeof v !== 'number') continue;
      growth[k] = (growth[k] || 0) + v;
      growthRuns[k] = (growthRuns[k] || 0) + 1;
    }
  }
  const byScenario = {};
  for (const [i, r] of results.entries()) {
    const key = r.scenario || `run ${i + 1}`;
    byScenario[key] = r.measure ? runMetrics(r.measure) : { crashed: true, reason: r.reason };
  }
  const gc = runs.filter(({ x }) => x.gc_ms != null);
  const gcCount = runs.filter(({ x }) => x.gc_collections != null);
  return {
    sessions: results.length,
    frames: sum(runs.map(({ x }) => x.frames || 0)),
    seconds_measured: measuredSeconds,
    // The budget most frames ran against; a run that detected another one shows it in by_scenario.
    frame_budget_ms: mostFrames(runs.map(({ x }) => [x.frame_budget_ms, x.frames || 1])),
    pct_frames_over_budget: weighted('pct_frames_over_budget', 1),
    frame_p50: weighted('frame_p50'),
    frame_p95: weighted('frame_p95'),
    frame_p99: weighted('frame_p99'),
    frame_worst: runs.length ? Math.max(...runs.map(({ x }) => x.frame_worst ?? 0)) : null,
    render_cpu_ms: weighted('render_cpu_ms'),
    update_cpu_ms: weighted('update_cpu_ms'),
    gpu_ms: weighted('gpu_ms'),
    rhi_cpu_ms: weighted('rhi_cpu_ms'),
    physics_ms: weighted('physics_ms'),
    draw_calls: weighted('draw_calls', 0),
    hitch_count: sum(runs.map(({ x }) => x.hitches || 0)),
    hitches_per_min: measuredSeconds ? round(sum(runs.map(({ x }) => x.hitches || 0)) / (measuredSeconds / 60)) : null,
    errors_per_session: runs.length ? round(sum(runs.map(({ x }) => x.errors || 0)) / runs.length) : null,
    gc_ms: gc.length ? round(sum(gc.map(({ x }) => x.gc_ms)) / gc.length, 1) : null,
    gc_collections: gcCount.length ? round(sum(gcCount.map(({ x }) => x.gc_collections)) / gcCount.length, 1) : null,
    memory_growth: Object.fromEntries(Object.entries(growth).map(([k, v]) => [k, round(v / growthRuns[k], 1)])),
    crashes: results.filter((r) => r.crashed).length,
    errors: [...errors.values()],
    levels: {},
    by_scenario: byScenario,
    headless: runs.some(({ r }) => r.measure.headless === true),
  };
}

/** Plays every scenario with the build and returns a run record ready to save or compare. */
export async function engineRun(cfg, { command = cfg.command, scenarios = cfg.scenarios, log = () => {} } = {}) {
  const { engine, command: argv, results } = await runEngineScenarios(cfg, { command, scenarios, log });
  const summary = measureSummary(results);
  const measured = results.filter((r) => r.measure);
  const noLevel = measured.every((r) => r.measure.level_start == null && r.measure.level_end == null);
  const howTo = ENGINES[engine]?.autoplay || GENERIC_AUTOPLAY;
  // With the default scenarios, a game that never starts a level most likely ignored --autoplay and sat on its menu.
  if (noLevel && cfg.default_scenarios) {
    throw new Error(`The build ran with the default scenarios (${paramFlags(scenarios[0].params, ENGINES[engine]?.dash).join(' ')}) but no run started a level, so it probably has no autoplay mode and measured its menu. ${howTo} Then list the runs in glitchless.playtest.json under "scenarios" (each with the "params" or "args" that start the bot).`);
  }
  const notes = [];
  if (noLevel) notes.push(`No run started a level (Glitchless level_start), so the bot may not have played. If the game has no autoplay mode yet: ${howTo}`);
  if (summary.headless) notes.push('The build ran headless: nothing was drawn and frames ran uncapped, so frame times mean little and only warn in a comparison. Run it with a window to gate a change on them.');
  const sdk = measured[0]?.measure.sdk || null;
  return {
    created: new Date().toISOString(),
    kind: 'engine',
    engine,
    command: argv,
    service: cfg.service || path.basename(cfg.root || process.cwd()),
    git: gitInfo(cfg.root),
    machine: { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model || null, gpu: null, browser: [ENGINES[engine]?.label, sdk].filter(Boolean).join(' · ') || 'engine build' },
    scenarios: results,
    summary,
    notes,
  };
}

// A quick run plays fewer scenarios than a full baseline: compare it with the same runs of the baseline only.
export function matchingEngineRuns(baseline, candidate) {
  if (baseline.kind !== 'engine') return baseline;
  const key = (s) => JSON.stringify([s.scenario, s.params, s.args]);
  const wanted = new Set((candidate.scenarios || []).map(key));
  const have = baseline.scenarios || [];
  const subset = have.filter((s) => wanted.has(key(s)));
  if (subset.length === have.length || subset.length !== wanted.size) return baseline;
  return { ...baseline, scenarios: subset, summary: measureSummary(subset), name: `${baseline.name} (matching runs)` };
}
