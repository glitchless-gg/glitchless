// Engine builds: the measure lines Unity, Godot, Unreal and GameMaker print, the summary made from them, and
// whole playtests against a stand-in build (fixtures/fake-build.mjs). The fixtures are real output: a headless
// run of godot/demo, the Unity SDK's Fetch! sample player (--glitchless-out), the Unreal plugin's core under
// unreal/test/core's harness, and GameMaker's GML under gamemaker/test/runtime.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeasure, measureSummary, scenarioArgs, detectEngine, splitCommand, resolveCommand, paramFlags, errorType } from '../src/engine.js';
import { compareRuns } from '../src/compare.js';
import { comparisonReport } from '../src/report.js';
import { playtest } from '../src/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const measured = (name) => parseMeasure(fixture(name));
const one = (m, scenario = 'run') => ({ scenario, measure: m });

test('the measure line is found in each engine\'s output', () => {
  const godot = measured('godot.txt'); // among Godot's own log lines and errors
  assert.equal(godot.sdk, 'glitchless-godot/0.6.4');
  const unity = measured('unity.json'); // the --glitchless-out file: a Unity player on macOS prints nothing to stdout
  assert.equal(unity.sdk, 'glitchless-unity/0.6.4');
  const unreal = measured('unreal.txt'); // after Unreal's log category
  assert.match(fixture('unreal.txt'), /^LogGlitchless: Display: \{"glitchless_measure"/);
  assert.equal(unreal.sdk, 'glitchless-unreal/0.5.3');
  const gamemaker = measured('gamemaker.txt'); // json_stringify writes / as \/
  assert.equal(gamemaker.sdk, 'glitchless-gamemaker/0.4.2');
  assert.equal(parseMeasure('no line here\n{"other": 1}'), null);
  assert.equal(parseMeasure('{"glitchless_measure": {"seconds": 2'), null);
});

test('each engine\'s numbers land in the summary compareRuns reads', () => {
  const godot = measureSummary([one(measured('godot.txt'))]);
  assert.equal(godot.frame_p95, 19.69);
  assert.equal(godot.frame_p99, 20.5);
  assert.equal(godot.update_cpu_ms, 0.21); // Godot's _process time is process_ms
  assert.equal(godot.gpu_ms, null); // Metal doesn't report it
  assert.equal(godot.errors_per_session, 1);
  assert.equal(godot.errors[0].fingerprint, 'push_error|bonus table missing row # in user://bonus.cfg|_play_event (demo.gd)');
  assert.equal(godot.by_scenario.run.level_end, 'level_3');
  assert.equal(godot.headless, true);

  const unity = measureSummary([one(measured('unity.json'))]);
  assert.equal(unity.update_cpu_ms, 0.03);
  assert.equal(unity.physics_ms, 0.11);
  assert.equal(unity.gpu_ms, 0.2);
  assert.equal(unity.draw_calls, 105);
  assert.equal(unity.memory_growth.materials, 500); // the Fetch! sample's planted confetti leak
  assert.equal(unity.gc_collections, 5);

  const unreal = measureSummary([one(measured('unreal.txt'))]);
  assert.equal(unreal.update_cpu_ms, 5.26); // the game thread
  assert.equal(unreal.rhi_cpu_ms, 2.1);
  assert.equal(unreal.draw_calls, 1451);
  assert.equal(unreal.hitches_per_min, 15);
  assert.deepEqual(unreal.errors.map((e) => e.message), ['Accessed None trying to read property Target']);
  assert.deepEqual([unreal.by_scenario.run.level_start, unreal.by_scenario.run.level_end], ['Arena', 'Arena_2']);

  const gamemaker = measureSummary([one(measured('gamemaker.txt'))]);
  assert.equal(gamemaker.draw_calls, null); // GameMaker doesn't count them
  assert.equal(gamemaker.update_cpu_ms, 4);
  assert.equal(gamemaker.render_cpu_ms, 3);
  assert.equal(gamemaker.gc_ms, 0);
  assert.equal(gamemaker.memory_growth.instances, 140);
});

test('several runs are weighted by frames, and a crashed run counts as a crash', () => {
  const a = measured('godot.txt');
  const b = { ...a, frames: a.frames * 3, pct_frames_over_budget: 2.9, frame_ms: { ...a.frame_ms, p95: 17 } };
  const s = measureSummary([one(a, 'seed 7'), one(b, 'seed 21'), { scenario: 'seed 42', crashed: true, reason: 'exit code 139' }]);
  assert.equal(s.sessions, 3);
  assert.equal(s.crashes, 1);
  assert.equal(s.pct_frames_over_budget, 3.9); // (6.9 + 3 × 2.9) / 4
  assert.equal(s.frame_p95, 17.67);
  assert.deepEqual(Object.keys(s.by_scenario), ['seed 7', 'seed 21', 'seed 42']);
  assert.equal(s.by_scenario['seed 42'].crashed, true);
});

test('a scenario becomes the game\'s own flags plus the measure flags, in each engine\'s style', () => {
  const sc = { params: { autoplay: true, seed: 7, skip: false, level: null }, args: ['--difficulty=hard'], seconds: 10, warmup: 0 };
  assert.deepEqual(paramFlags(sc.params), ['--autoplay', '--seed=7']);
  // Godot hands a game only what comes after "--".
  assert.deepEqual(scenarioArgs('godot', ['godot', '--path', '.'], sc, { out: '/tmp/m.json' }), ['--', '--autoplay', '--seed=7', '--difficulty=hard', '--glitchless-measure=10', '--glitchless-warmup=0', '--glitchless-out=/tmp/m.json']);
  assert.equal(scenarioArgs('godot', ['godot', '--path', '.', '--'], sc)[0], '--autoplay');
  assert.deepEqual(scenarioArgs('unreal', ['Game'], { params: { autoplay: true, seed: 7 }, seconds: 5, warmup: 2 }), ['-autoplay', '-seed=7', '-glitchless-measure=5', '-glitchless-warmup=2']);
  assert.deepEqual(scenarioArgs('unity', ['Game'], { params: { autoplay: true }, seconds: 5, warmup: 1 }), ['--autoplay', '--glitchless-measure=5', '--glitchless-warmup=1']);
});

test('the engine is told from the command, or from what an export leaves beside its executable', () => {
  assert.equal(detectEngine(['/opt/homebrew/bin/godot', '--path', '.']), 'godot');
  assert.equal(detectEngine(['/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor', '/work/Starseam/Starseam.uproject', '-game']), 'unreal');
  assert.equal(detectEngine(['open', '-n', '-W', '-a', '/rt/mac/YoYo Runner.app', '--args', '-game', '/work/build/game.ios']), 'gamemaker');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-detect-'));
  const app = path.join(dir, 'Lucky Twice.app/Contents');
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Frameworks'));
  fs.writeFileSync(path.join(app, 'MacOS/Lucky Twice'), '');
  fs.writeFileSync(path.join(app, 'Frameworks/UnityPlayer.dylib'), '');
  const argv = resolveCommand('"Lucky Twice.app" --windowed', dir); // a macOS .app runs its own executable
  assert.deepEqual(argv, [path.join(app, 'MacOS/Lucky Twice'), '--windowed']);
  assert.equal(detectEngine(argv), 'unity');
  fs.mkdirSync(path.join(dir, 'linux'));
  fs.writeFileSync(path.join(dir, 'linux/Starlift.x86_64'), '');
  fs.writeFileSync(path.join(dir, 'linux/Starlift.pck'), '');
  assert.equal(detectEngine([path.join(dir, 'linux/Starlift.x86_64')]), 'godot');
  assert.equal(detectEngine([path.join(dir, 'nothing-here')]), null);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(splitCommand(`"/Applications/My Game.app" --path '.' -x`), ['/Applications/My Game.app', '--path', '.', '-x']);
});

test('errors match across builds though their numbers and line numbers move', () => {
  const e = { kind: 'push_error', message: 'bonus table missing row 4580', location: '_play_event (demo.gd:175)' };
  assert.equal(errorType(e), errorType({ ...e, message: 'bonus table missing row 6265', location: '_play_event (demo.gd:181)' }));
  assert.notEqual(errorType(e), errorType({ ...e, location: '_spawn (demo.gd:175)' }));
});

// ───────────────────────────── whole playtests, against the stand-in build ─────────────────────────────

function project(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-engine-playtest-'));
  fs.writeFileSync(path.join(dir, 'glitchless.playtest.json'), JSON.stringify({ command: [process.execPath, path.join(FIXTURES, 'fake-build.mjs')], engine: 'godot', ...config }));
  return dir;
}
const scenarios = (mode, extra = {}) => [
  { name: 'seed 7', params: { autoplay: true, seed: 7, mode }, seconds: 3, ...extra },
  { name: 'seed 21', params: { autoplay: true, seed: 21, mode: 'ok' }, seconds: 3 },
];
const run = (cwd, o = {}) => playtest({ cwd, ...o });

test('an engine build: save a baseline, then a slower build fails, run by run', async () => {
  const cwd = project({ scenarios: scenarios('ok') });
  const saved = await run(cwd, { saveAs: 'baseline' });
  assert.equal(saved.verdict, 'none');
  assert.equal(saved.candidate.kind, 'engine');
  assert.equal(saved.candidate.engine, 'godot');
  // The build was started with "--", the game's flags and the measure flags.
  assert.deepEqual(saved.candidate.scenarios[0].measure.args.slice(0, 5), ['--', '--autoplay', '--seed=7', '--mode=ok', '--glitchless-measure=3']);
  assert.ok(saved.candidate.scenarios[0].measure.args.some((a) => a.startsWith('--glitchless-out=')));
  assert.ok(!saved.candidate.scenarios[0].command.some((a) => a.includes('glitchless-out')), 'the temporary file is left out of the saved run');
  assert.match(saved.report, /\| seed 7 \| 275 \| 6\.9 \| 19\.69 \| 20\.5 \| 2 \| 1 \| level_1 → level_3 \|/);
  assert.ok(fs.existsSync(path.join(cwd, '.glitchless/playtest/baseline.json')));

  fs.writeFileSync(path.join(cwd, 'glitchless.playtest.json'), JSON.stringify({ command: [process.execPath, path.join(FIXTURES, 'fake-build.mjs')], engine: 'godot', scenarios: scenarios('slow') }));
  const r = await run(cwd);
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.comparison.regressions.map((c) => c.id).sort(), ['run.update_cpu_ms.seed 7', 'update_cpu_ms']);
  assert.match(r.report, /Update CPU per frame \(ms\), run "seed 7" \| 0\.21 \| 6\.21/);
  // The scenarios changed (mode), which the report says.
  assert.match(r.report, /different scenarios/);
});

test('a new error, a crash and a leak in an engine build', async () => {
  const cwd = project({ scenarios: scenarios('ok') });
  await run(cwd, { saveAs: 'baseline' });
  const again = (mode) => {
    fs.writeFileSync(path.join(cwd, 'glitchless.playtest.json'), JSON.stringify({ command: [process.execPath, path.join(FIXTURES, 'fake-build.mjs')], engine: 'godot', scenarios: scenarios(mode) }));
    return run(cwd);
  };
  const error = await again('error');
  assert.equal(error.verdict, 'fail');
  assert.deepEqual(error.comparison.new_errors.map((e) => e.location), ['_on_enemy_hit (enemy.gd:42)']);

  const crash = await again('crash');
  assert.equal(crash.verdict, 'fail');
  assert.ok(crash.comparison.regressions.some((c) => c.id === 'crashes' && c.after === 1));
  assert.match(crash.report, /### Crashed runs[\s\S]*exit code 139[\s\S]*waves\.gd:88/);

  const leak = await again('leak');
  assert.equal(leak.verdict, 'pass'); // growth warns
  assert.ok(leak.comparison.warnings.some((c) => c.id === 'memory_growth.orphan_nodes' && c.after - c.before === 20_000), JSON.stringify(leak.comparison.checks.filter((c) => c.id.startsWith('memory'))));

  const same = await again('ok');
  assert.equal(same.verdict, 'pass');
  assert.equal(same.comparison.regressions.length + same.comparison.warnings.length, 0);
});

test('a quick engine run is compared with the same run of the baseline only', async () => {
  const cwd = project({ scenarios: scenarios('ok') });
  await run(cwd, { saveAs: 'baseline' });
  const r = await run(cwd, { quick: true });
  assert.equal(r.candidate.scenarios.length, 1);
  assert.equal(r.baseline.scenarios.length, 1);
  assert.match(r.baseline.name, /matching runs/);
  assert.ok(!r.comparison.notes.some((n) => /different scenarios/.test(n)));
});

test('a build that only writes its measurement to a file (a Unity player on macOS) still works', async () => {
  const cwd = project({ scenarios: [{ name: 'silent', params: { autoplay: true, mode: 'silent' }, seconds: 2 }] });
  const r = await run(cwd);
  assert.equal(r.candidate.summary.frame_p95, 19.69);
});

test('engine errors say what to do', async () => {
  const fails = async (config, pattern, o = {}) => assert.rejects(run(project(config), o), pattern);
  // The bot quit before the measure ended.
  await fails({ scenarios: [{ name: 'short', params: { autoplay: true, mode: 'quit' }, seconds: 30 }] }, /quit after \d+ s without printing its measurement[\s\S]*lower "seconds"/);
  // The player switched Glitchless off on this device.
  await fails({ scenarios: [{ params: { autoplay: true, mode: 'off' }, seconds: 2 }] }, /measured nothing: Glitchless is off[\s\S]*turn the in-game "share data" setting back on/);
  // Every run crashed: the build's own last lines are the answer.
  await fails({ scenarios: [{ params: { autoplay: true, mode: 'crash' }, seconds: 2 }] }, /crashed in every run[\s\S]*signal 11/);
  // Nothing in the scenario starts the bot.
  await fails({ scenarios: [{ name: 'idle', seconds: 2 }] }, /passes nothing to the game[\s\S]*OS\.get_cmdline_user_args/);
  // With the default scenarios, a game that never starts a level has no autoplay mode.
  await fails({ command: [process.execPath, path.join(FIXTURES, 'fake-build.mjs'), '--mode=menu'] }, /no run started a level, so it probably has no autoplay mode[\s\S]*godot\/demo\/demo\.gd/, { config: { seconds: 2 } });
  await assert.rejects(playtest({ cwd: project({}), config: { command: 'no-such-game-build --path .' } }), /Could not start no-such-game-build: no such program/);
  // A frozen build is killed at the cap and counted as a crash.
  const frozen = await run(project({ scenarios: [{ name: 'frozen', params: { autoplay: true, mode: 'hang' }, seconds: 2, max_s: 2 }, { name: 'fine', params: { autoplay: true }, seconds: 2 }] }));
  assert.equal(frozen.candidate.summary.crashes, 1);
  assert.match(frozen.report, /froze or never quit within 2 s/);
});

test('explicit scenarios on a game that starts no level get a note, not an error', async () => {
  const r = await run(project({ scenarios: [{ params: { autoplay: true, mode: 'menu' }, seconds: 2 }] }));
  assert.match(r.report, /No run started a level[\s\S]*OS\.get_cmdline_user_args/);
});

test('frame times warn instead of failing when the runs measured differently', () => {
  const m = measured('godot.txt');
  const record = (x, extra = {}) => ({ kind: 'engine', scenarios: [{ scenario: 'a', measure: x }, { scenario: 'b', measure: x }], summary: measureSummary([one(x, 'a'), one(x, 'b')]), ...extra });
  const windowed = { ...m, headless: false };
  // The SDK read a 75 Hz screen in one run: slow frames are counted against another line.
  const misread = { ...windowed, frame_budget_ms: 13.33, pct_frames_over_budget: 70.4 };
  const cmp = compareRuns(record(windowed), { ...record(windowed), scenarios: [{ scenario: 'a', measure: misread }, { scenario: 'b', measure: windowed }], summary: measureSummary([one(misread, 'a'), one(windowed, 'b')]) });
  assert.equal(cmp.verdict, 'pass');
  assert.ok(cmp.warnings.some((c) => c.id === 'pct_frames_over_budget'));
  assert.ok(cmp.notes.some((n) => /different frame budgets/.test(n)));
  // The same jump on the same budget fails.
  const slow = { ...windowed, pct_frames_over_budget: 40 };
  assert.equal(compareRuns(record(windowed), record(slow)).verdict, 'fail');
  // Headless, it only warns.
  assert.equal(compareRuns(record(m), record({ ...slow, headless: true })).verdict, 'pass');
  assert.match(comparisonReport({ ...record(m), name: 'baseline' }, { ...record({ ...slow, headless: true }), name: 'latest' }, compareRuns(record(m), record({ ...slow, headless: true }))), /PASS/);
});
