// Builds the demo (gamemaker/Glitchless.yyp) with GameMaker's Igor, plays it against a fresh local Glitchless server,
// and checks what arrives through the same /v1/query API the dashboard and the MCP tools read.
//
//   node gamemaker/test/e2e.mjs          (npm run test:gamemaker)
//
// Needs GameMaker installed and its licence in place, set up once by a person (that accepts GameMaker's terms): the
// GameMaker IDE signed in once, or YoYo Games' gm-cli run once (see "Testing" in gamemaker/README.md). This script
// never signs in or fetches a licence: it uses the runtime and licence.plist it finds, or GM_RUNTIME (a runtime folder)
// and GM_LICENCE (a licence.plist), and stops if there are none.
//
// It compiles a VM build for the mac target once, into gamemaker/.build, then starts the runtime's YoYo Runner on it
// for each run, with the run's flags on the command line and the game's output in a -debugoutput file. (Igor's Run
// passes no command line on, and the runner can't load a game from a temporary folder.) The runner opens the game's
// window, so this needs a logged-in macOS desktop.
//
//   0. selftest  this runner computes the sketch, fingerprints, gzip and JSON numbers of test/fixtures/js-fixture.json
//                as the JavaScript SDK does (glitchless/selftest.json in the save area)
//   1. offline   the server is down: batches, and a bug report, are saved to glitchless/outbox.json without any ID
//   2. online    the saved batches go out under a new random ID, then this run's session
//   3. full      full mode: a saved player ID, the GPU, death positions
//   4. measure   -glitchless-measure prints frame stats as JSON, writes them to the save area and quits
//   5. crash     level 3's planted crash stops the game; the next launch sends it, and the session counts as crashed
//   6. install   install mode: a stored player ID, the anonymous device, no positions; anonymous mode deletes the ID
//   7. bug report  one from code and one through the F8 form (cancelled once, then sent)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint } from '../../packages/sdk/src/fingerprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = path.join(ROOT, 'gamemaker/Glitchless.yyp');
const BUILD = path.join(ROOT, 'gamemaker/.build');
const SERVICE = 'glitchless-gamemaker-demo';
const SDK = 'glitchless-gamemaker/0.1.0';
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemaker/test/fixtures/js-fixture.json'), 'utf8'));
const results = [];

if (process.platform !== 'darwin') {
  console.error('The GameMaker e2e runs on macOS (a VM build for the mac target).');
  process.exit(2);
}

// The newest runtime with an Igor and a Mac runner, from GM_RUNTIME, the IDE's shared cache or a gm-cli cache.
function findRuntime() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ok = (rt) => fs.existsSync(path.join(rt, 'bin/igor/osx', arch, 'Igor')) && fs.existsSync(path.join(rt, 'mac/YoYo Runner.app'));
  if (process.env.GM_RUNTIME) return ok(process.env.GM_RUNTIME) ? process.env.GM_RUNTIME : null;
  const roots = [
    ...['GameMakerStudio2-LTS2026', 'GameMakerStudio2'].map((d) => `/Users/Shared/${d}/Cache/runtimes`),
    path.join(process.env.GAMEMAKER_CLI_CACHE_DIR || path.join(os.homedir(), 'Library/Caches/GameMakerCLI-glitchless'), 'runtimes-gms2'),
  ];
  const all = roots.flatMap((r) => (fs.existsSync(r) ? fs.readdirSync(r).filter((d) => d.startsWith('runtime-')).map((d) => path.join(r, d)) : [])).filter(ok);
  return all.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }))[0] ?? null;
}

// The licence: GM_LICENCE, a signed-in IDE user folder (passed whole with -uf), or a gm-cli cache's licence.plist.
function findLicence() {
  if (process.env.GM_LICENCE) return fs.existsSync(process.env.GM_LICENCE) ? ['-lf', process.env.GM_LICENCE] : null;
  for (const base of ['GameMakerStudio2-LTS2026', 'GameMakerStudio2'].map((d) => path.join(os.homedir(), 'Library/Application Support', d))) {
    if (!fs.existsSync(base)) continue;
    const user = fs.readdirSync(base).find((d) => !d.startsWith('unknownUser') && fs.existsSync(path.join(base, d, 'licence.plist')));
    if (user) return ['-uf', path.join(base, user)];
  }
  const cli = path.join(process.env.GAMEMAKER_CLI_CACHE_DIR || path.join(os.homedir(), 'Library/Caches/GameMakerCLI-glitchless'), 'license/licence.plist');
  return fs.existsSync(cli) ? ['-lf', cli] : null;
}

const RUNTIME = findRuntime();
const LICENCE = findLicence();
if (!RUNTIME || !LICENCE) {
  console.error(`${RUNTIME ? 'No GameMaker licence found' : 'No GameMaker runtime found'}. A person sets GameMaker up once (it accepts GameMaker's terms): see "Testing" in gamemaker/README.md.`);
  process.exit(2);
}
const IGOR = path.join(RUNTIME, 'bin/igor/osx', process.arch === 'arm64' ? 'arm64' : 'x64', 'Igor');
const RUNNER = path.join(RUNTIME, 'mac/YoYo Runner.app');
const OUT = path.join(BUILD, 'out');
const GAME = path.join(OUT, 'game.ios');

// A VM build for the mac target, compiled once.
function build() {
  for (const d of ['out', 'cache', 'temp']) fs.rmSync(path.join(BUILD, d), { recursive: true, force: true });
  const prefabs = path.join(path.dirname(path.dirname(path.dirname(RUNTIME))), 'Prefabs');
  const args = ['-rp', RUNTIME, ...LICENCE, '-project', PROJECT, '-runtime', 'VM', '-cache', path.join(BUILD, 'cache'), '-temp', path.join(BUILD, 'temp'), '-of', path.join(OUT, 'Glitchless'), ...(fs.existsSync(prefabs) ? ['-prefabs', prefabs] : []), '-jsonErrors', '--', 'Mac', 'Compile'];
  const r = spawnSync(IGOR, args, { encoding: 'utf8', timeout: 600_000, env: { ...process.env, COMPlus_ZapDisable: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const log = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0 || !fs.existsSync(path.join(OUT, 'assets/game.ios'))) throw new Error(`Igor could not build the demo (exit ${r.status})\n${log.slice(-6000)}`);
  fs.copyFileSync(path.join(OUT, 'assets/game.ios'), GAME); // beside options.ini and the included files, where the runner looks
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let saveDir = null; // the runner's save area, known once the first run prints it
let runs = 0;

// One run of the demo with these flags, until it quits. Returns what the game logged.
function runGame(flags, label, { timeoutMs = 120_000 } = {}) {
  const log = path.join(BUILD, `run-${++runs}.log`);
  fs.rmSync(log, { force: true });
  const r = spawnSync('open', ['-n', '-W', '-a', RUNNER, '--args', '-game', GAME, '-debugoutput', log, ...flags], { encoding: 'utf8', timeout: timeoutMs });
  if (r.error?.code === 'ETIMEDOUT') {
    // Ours is the only runner on this game file: stop it by its PID.
    const pids = spawnSync('pgrep', ['-f', GAME], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    for (const pid of pids) process.kill(Number(pid));
    throw new Error(`${label}: the game did not quit within ${timeoutMs / 1000} s`);
  }
  const out = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const dir = /glitchless demo save dir: (.+?)\s*$/m.exec(out)?.[1];
  if (dir && !saveDir) saveDir = dir.replace(/\/$/, '');
  if (!dir) throw new Error(`${label}: the demo never started\n${out.slice(-4000)}`);
  return out;
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Glitchless server did not start');
}

async function query(port, name, params = {}) {
  const qs = new URLSearchParams({ service: SERVICE, from: '0', to: String(Date.now() + 60_000), ...params });
  const res = await fetch(`http://127.0.0.1:${port}/v1/query/${name}?${qs}`);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
  return res.json();
}

function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-gamemaker-'));
const port = await freePort();
const deadPort = await freePort();
const dataDir = path.join(tmp, 'data');
const live = `-glitchless-intake=http://127.0.0.1:${port}`;
const dead = `-glitchless-intake=http://127.0.0.1:${deadPort}`;
const demo = (...extra) => ['-autoplay', '-level-seconds=1.5', '-glitchless', ...extra];
const raw = () =>
  fs.existsSync(dataDir)
    ? fs
        .readdirSync(dataDir)
        .filter((f) => f.startsWith('events-'))
        .flatMap((f) => fs.readFileSync(path.join(dataDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    : [];
const inSave = (rel) => path.join(saveDir, rel);
let server;
try {
  build();
  // The runner's save area (every GameMaker game run from the IDE shares it): only Glitchless's own files go.
  const runnerSave = path.join(os.homedir(), 'Library/Application Support/com.yoyogames.macyoyorunner/glitchless');
  for (const f of ['selftest.json', 'measure.json', 'outbox.json', 'outbox.json.tmp', 'player_id', 'args.txt']) fs.rmSync(path.join(runnerSave, f), { force: true });
  // 0. selftest
  runGame(['-glitchless-selftest'], 'selftest');
  const self = JSON.parse(fs.readFileSync(inSave('glitchless/selftest.json'), 'utf8'));
  for (const d of [path.join(saveDir, 'glitchless/outbox.json'), path.join(saveDir, 'glitchless/player_id')]) fs.rmSync(d, { force: true });
  check(`selftest: the runner (${self.runtime}) buckets every frame time like the JavaScript sketch`, () => {
    assert.deepEqual(self.sketch.b, fixture.sketch.b);
    for (const k of ['n', 'z', 'mn', 'mx']) assert.equal(self.sketch[k], fixture.sketch[k], k);
    assert.deepEqual(self.indexes, fixture.indexes.map(([, i]) => i));
    for (const [q, v] of Object.entries(fixture.quantiles)) assert.equal(self.quantiles[q], v, `q${q}`);
    assert.equal(self.fraction_above_19_17, fixture.fraction_above_19_17);
  });
  check('selftest: fingerprints and normalized messages match the browser SDK, emoji and all', () => {
    fixture.fingerprints.forEach((e, i) => {
      assert.equal(self.fingerprints[i].fingerprint, e.fingerprint, e.message);
      assert.equal(self.fingerprints[i].normalized.slice(0, 200), e.normalized.slice(0, 200), e.message);
    });
  });
  check(`selftest: gzip from buffer_compress unpacks${self.crc_inverted ? ' (this runner\'s buffer_crc32 inverts)' : ''}`, () => {
    assert.equal(self.gzip_works, true);
    assert.equal(zlib.gunzipSync(Buffer.from(self.gzip, 'base64')).toString('utf8'), 'glitchless gzip check: émoji 🐶');
  });
  check('selftest: json_stringify writes timestamps and decimals exactly, and the clock is UTC', () => {
    assert.deepEqual(JSON.parse(self.json_numbers), { ts: 1792766421123, ms: 16.67, tiny: 0.02, big: 123456789012 });
    assert.ok(Math.abs(self.unix_ms - Date.now()) < 120_000, `unix_ms ${self.unix_ms}`);
    assert.match(self.id, /^s_[a-z0-9]{16}$/);
    assert.ok(self.heap_mb > 0, `heap_mb ${self.heap_mb}`);
  });
  const outbox = inSave('glitchless/outbox.json');
  const playerFile = inSave('glitchless/player_id');

  // 1. offline
  const offlineOut = runGame(demo('-seed=1', '-no-crash', '-bug-report-at=1', dead), 'offline run');
  const saved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  // GameMaker's json_stringify writes / as \/: read the outbox as JSON, not as text.
  const savedEvents = (text) => (text ? JSON.parse(text).batches.flatMap((b) => b.events) : []);
  check('offline: unsent batches are saved in glitchless/outbox.json', () => assert.ok(saved.includes('"session_start"') && saved.includes('"session_end"'), 'no session in the outbox'));
  check('offline: a bug report that could not go is kept in the outbox', () => {
    assert.match(offlineOut, /bug report from code: \{ ?"reason": ?"error", ?"sent": ?false ?\}|bug report from code: \{ ?"sent": ?false, ?"reason": ?"error" ?\}/);
    const report = savedEvents(saved).find((e) => e.type === 'bug_report');
    assert.ok(report, 'no report in the outbox');
    assert.match(report.screenshot, /^data:image\/png;base64,/);
  });
  check('offline: anonymous mode saves no session or player ID', () => {
    assert.ok(!/"(sid|pid|session_id|player_id)"/.test(saved), 'an ID was written to disk');
    assert.ok(!fs.existsSync(playerFile), 'player_id file exists');
  });

  // 2. online
  server = await startServer(port, dataDir);
  runGame(demo('-seed=2', '-no-crash', live), 'online run');
  check('online: the outbox is empty once everything is sent', () => assert.ok(!fs.existsSync(outbox), 'outbox.json still there'));

  // 3. full mode
  runGame(demo('-seed=3', '-no-crash', '-glitchless-privacy=full', live), 'full-mode run');
  check('full: a random player ID is saved', () => assert.match(fs.readFileSync(playerFile, 'utf8'), /^p_[a-z0-9]{12}$/));

  // 4. measure (a build run from Igor without -glitchless sends nothing, so this adds no session)
  const measureOut = runGame(['-autoplay', '-seed=4', '-level-seconds=1', '-no-crash', '-glitchless-measure=2'], 'measure run');
  check('measure: prints one line of JSON with frame stats, and writes it to the save area', () => {
    assert.ok(measureOut.includes('{"glitchless_measure"'), 'no {"glitchless_measure": ...} line');
    const m = JSON.parse(fs.readFileSync(inSave('glitchless/measure.json'), 'utf8')).glitchless_measure;
    assert.ok(m.frames > 30, `frames ${m.frames}`);
    for (const k of ['p50', 'p95', 'p99', 'worst']) assert.equal(typeof m.frame_ms[k], 'number', `frame_ms.${k}`);
    for (const k of ['fps', 'frame_budget_ms', 'pct_frames_over_budget', 'hitch_count', 'memory_delta', 'new_errors', 'process_ms', 'render_cpu_ms', 'session_id']) assert.ok(k in m, k);
    assert.equal(m.sdk, SDK);
    assert.equal(m.renderer, 'vm');
  });

  await new Promise((r) => setTimeout(r, 300));
  const { sessions } = await query(port, 'sessions');
  const full = sessions.find((s) => s.player_id.startsWith('p_'));
  const anon = sessions.filter((s) => s !== full);
  check('three sessions arrive: the replayed offline one, the online one and the full-mode one', () => assert.equal(sessions.length, 3, JSON.stringify(sessions.map((s) => s.session_id))));
  check('every session has its start, all three levels (the rooms) and its end', () => {
    for (const s of sessions) {
      assert.equal(s.ended, true, `${s.session_id} not ended`);
      assert.deepEqual(s.levels, ['rm_level_1', 'rm_level_2', 'rm_level_3']);
      assert.match(s.browser, /^GameMaker 20\d\d\./);
      assert.equal(s.session_type, 'synthetic');
    }
  });
  check('anonymous sessions carry no player ID', () => {
    for (const s of anon) assert.equal(s.player_id, s.session_id);
  });
  const detail = async (id) => (await query(port, 'session', { id })).session;
  const anonDevice = (await detail(anon[0].session_id)).device;
  const fullDevice = (await detail(full.session_id)).device;
  check('anonymous device info is coarse; full adds the OS version', () => {
    for (const k of ['gpu', 'os_version', 'gpu_vendor']) assert.ok(!(k in anonDevice), `anonymous sent ${k}`);
    for (const k of ['os', 'device_tier', 'gpu_tier', 'renderer', 'screen', 'refresh_hz']) assert.ok(k in anonDevice, `anonymous lacks ${k}`);
    assert.equal(anonDevice.os, 'macOS');
    assert.equal(anonDevice.steam_deck, false);
    assert.match(fullDevice.os_version, /^\d+\.\d+\.\d+$/);
  });
  check('deaths carry positions in full mode only', () => {
    const deaths = raw().filter((e) => e.type === 'death');
    assert.ok(deaths.length > 0, 'no deaths');
    for (const d of deaths) assert.equal('x' in d, d.player_id.startsWith('p_'), `death in ${d.session_id}`);
  });
  check('frame windows: the server reads the GML sketch back', () => {
    const windows = raw().filter((e) => e.type === 'frame_window');
    assert.ok(windows.length >= 6, `${windows.length} windows`);
    for (const w of windows) {
      const s = Sketch.from(w.ft);
      assert.equal(s.n, w.frames);
      assert.equal(Math.round(s.quantile(0.5) * 100) / 100, w.ft_p50);
      assert.ok(w.heap_mb > 0, `heap_mb ${w.heap_mb}`);
      // Step and draw times need the frame before (the first frame after glitchless_init has none)
      if (w.frames >= 10) assert.ok(typeof w.process_ms === 'number' && typeof w.render_ms === 'number', JSON.stringify([w.level, w.frames, w.process_ms, w.render_ms]));
    }
    assert.ok(windows.every((w) => w.sdk === SDK));
  });
  check('engine gauges ride in ctx: rm_level_3 carries the instances and surfaces rm_level_2 leaked', () => {
    const peak = (level, key) => Math.max(...raw().filter((e) => e.type === 'frame_window' && e.level === level).map((w) => w.ctx?.[key] ?? 0));
    assert.ok(peak('rm_level_3', 'instances') >= 2500, `rm_level_3 instances ${peak('rm_level_3', 'instances')}`);
    assert.ok(peak('rm_level_1', 'instances') < 100, `rm_level_1 instances ${peak('rm_level_1', 'instances')}`);
    assert.ok(peak('rm_level_3', 'surfaces') > peak('rm_level_1', 'surfaces'), 'no surfaces leaked');
  });
  check('hitches: rm_level_2\'s power-up is an instance burst in step code', () => {
    const burst = raw().filter((e) => e.type === 'hitch' && e.level === 'rm_level_2' && e.instances_added >= 2500);
    assert.ok(burst.length >= 3, JSON.stringify(raw().filter((e) => e.type === 'hitch').map((h) => [h.level, h.duration_ms, h.causes])));
    for (const h of burst) {
      assert.ok(h.causes.includes('object_spawn'), JSON.stringify(h.causes));
      assert.ok(h.recent.includes('powerup'), JSON.stringify(h.recent));
    }
  });

  const perf = await query(port, 'performance');
  check('performance: global percentiles and every level', () => {
    assert.equal(typeof perf.kpis.frame_p95, 'number');
    assert.deepEqual(perf.by_level.map((l) => l.key).filter((k) => k !== '(menu)'), ['rm_level_1', 'rm_level_2', 'rm_level_3']);
    assert.equal(perf.by_browser[0].key, 'GameMaker');
  });

  const { issues } = await query(port, 'errors');
  const caught = issues.find((i) => i.kind === 'manual');
  check('errors: the game\'s caught error groups by the browser SDK fingerprint, its save folder cut down', () => {
    assert.ok(caught, `kinds: ${issues.map((i) => i.kind)}`);
    assert.match(caught.message, /^bonus table missing row \d+ in save:\/bonus\.cfg$/);
    assert.equal(caught.fn, 'demo_play_event');
    assert.equal(caught.fingerprint, fingerprint('manual', caught.message, 'demo_play_event'));
    assert.equal(caught.sessions, 3);
    const userName = os.userInfo().username;
    for (const e of raw().filter((x) => x.type === 'error')) assert.ok(!JSON.stringify(e).includes(`/Users/${userName}`), `user name in: ${e.message}`);
  });

  const { findings } = await query(port, 'findings');
  check('findings: the instances rm_level_2 leaked get GameMaker advice', () => {
    // Three 1.5 s runs give a level too few frames (under 300) for a frame-time finding; the leak shows anyway.
    const f = findings.find((x) => x.id === 'leak-gauge-instances');
    assert.ok(f, findings.map((x) => x.id).join(', '));
    assert.match(f.suggestion, /instance_destroy\(\).*persistent/);
  });

  // 5. crash: the planted crash on rm_level_3, then a launch that sends it
  const before = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  const crashOut = runGame(demo('-seed=5', live), 'crash run');
  const crashSaved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  const crashEvents = savedEvents(crashSaved);
  const crashed = crashEvents.find((e) => e.type === 'error' && e.kind === 'crash');
  check(`crash: the unhandled exception is written to the outbox as the game stops (${crashed?.message})`, () => {
    assert.ok(crashed, 'no crash in the outbox');
    assert.match(crashed.message, /obj_bonus_target|payout|instance|not set/i);
    assert.ok(crashEvents.some((e) => e.type === 'session_end' && e.reason === 'crash'), 'no session_end with reason crash');
    assert.ok(!/ERROR in action/.test(crashOut), 'GameMaker showed its own error: the handler did not run');
  });
  runGame(demo('-seed=6', '-no-crash', live), 'next launch');
  await new Promise((r) => setTimeout(r, 300));
  const after = (await query(port, 'sessions')).sessions.filter((s) => !before.has(s.session_id));
  const crashIssue = (await query(port, 'errors')).issues.find((i) => i.kind === 'crash');
  check('crash: the next launch sends it, the crash is fatal and its session crashed', () => {
    assert.ok(!fs.existsSync(outbox), 'outbox.json still there');
    assert.ok(crashIssue, 'no crash issue');
    assert.equal(crashIssue.fatal, true);
    assert.equal(crashIssue.fn, 'demo_play_event');
    assert.match(crashIssue.stack, /^crash: .+\n {4}at demo_play_event \(gml_Script_demo_play_event:\d+\)/);
    assert.ok(after.some((s) => s.crashed), JSON.stringify(after.map((s) => [s.session_id, s.crashed])));
    assert.ok(after.some((s) => !s.crashed), 'the next launch\'s own session did not crash');
  });

  // install mode: a stored player ID, the anonymous device, no positions
  const beforeInstall = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  fs.rmSync(playerFile, { force: true });
  runGame(demo('-seed=8', '-no-crash', '-glitchless-privacy=install', live), 'install-mode run');
  await new Promise((r) => setTimeout(r, 300));
  const installRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeInstall.has(s.session_id));
  check('install: a random player ID is saved and sent, with the anonymous device and no positions', () => {
    const pid = fs.readFileSync(playerFile, 'utf8');
    assert.match(pid, /^p_[a-z0-9]{12}$/);
    assert.equal(installRun.length, 1, `${installRun.length} sessions`);
    assert.equal(installRun[0].player_id, pid);
    const start = raw().find((e) => e.type === 'session_start' && e.session_id === installRun[0].session_id);
    assert.equal(start.privacy, 'install');
    assert.ok(!('os_version' in start.device) && !('gpu' in start.device), 'install mode sent full device details');
    assert.ok(raw().filter((e) => e.type === 'death' && e.session_id === installRun[0].session_id).every((d) => !('x' in d)), 'install mode sent positions');
  });
  runGame(demo('-seed=9', '-no-crash', live), 'anonymous run after install');
  check('anonymous mode deletes the player ID an install-mode build left', () => assert.ok(!fs.existsSync(playerFile)));

  // 6. bug reports
  const beforeReports = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  const bugOut = runGame(demo('-seed=7', '-no-crash', '-bug-report-at=1', '-bug-form-at=2.5', live), 'bug report run');
  await new Promise((r) => setTimeout(r, 300));
  const bugRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeReports.has(s.session_id));
  const { reports } = await query(port, 'reports');
  check('bug report: sent from code straight away, and through the form', () => {
    assert.match(bugOut, /bug report from code: \{ ?"sent": ?true ?\}/);
    assert.equal(bugRun.length, 1, `${bugRun.length} sessions`);
    const mine = reports.filter((r) => r.session_id === bugRun[0].session_id);
    assert.deepEqual(mine.map((r) => r.note).sort(), ['sparks froze the screen', 'the bonus on rm_level_1 never paid out'], 'the cancelled form sent nothing');
    for (const r of mine) assert.match(r.device, /^GameMaker 20\d\d\./);
  });
  check('bug report: the form pauses the game while it is open', () => {
    assert.deepEqual(bugOut.match(/bug report form (opened|closed), paused: \w+/g), [
      'bug report form opened, paused: true',
      'bug report form closed, paused: false',
      'bug report form opened, paused: true',
      'bug report form closed, paused: false',
    ]);
  });
  check('bug report: the offline run\'s report arrived with its session on the next launch', () => {
    assert.ok(reports.some((r) => r.note === 'the bonus on rm_level_1 never paid out' && anon.some((s) => s.session_id === r.session_id)), JSON.stringify(reports.map((r) => r.session_id)));
  });
  const fromForm = reports.find((r) => r.session_id === bugRun[0]?.session_id && r.note.startsWith('sparks'));
  const opened = fromForm && (await query(port, 'report', { id: fromForm.id })).report;
  // The screenshot, to look at: gamemaker/.build/bug-report.png.
  if (opened?.screenshot) fs.writeFileSync(path.join(BUILD, 'bug-report.png'), Buffer.from(opened.screenshot.split(',')[1], 'base64'));
  check('bug report: the PNG screenshot, recent events and frame windows arrive', () => {
    assert.ok(opened, 'no report from the form');
    assert.match(opened.screenshot, /^data:image\/png;base64,/);
    assert.ok(opened.screenshot.length <= 200_000);
    assert.equal(opened.sdk, SDK);
    assert.ok(opened.recent.every((e) => typeof e.ts === 'number' && e.type), 'recent events need ts and type');
    assert.ok(opened.frames.length > 0 && opened.frames.every((f) => typeof f.fps === 'number' && typeof f.p95 === 'number'), JSON.stringify(opened.frames));
  });
} finally {
  server?.kill(); // this script's own server, by its handle
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const [status, name, why] of results) console.log(`${status === 'ok' ? '✔' : '✖'} ${name}${why ? `\n    ${why}` : ''}`);
const failed = results.filter((r) => r[0] !== 'ok').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (${path.basename(RUNTIME)}, save area ${saveDir})`);
process.exit(failed ? 1 : 0);
