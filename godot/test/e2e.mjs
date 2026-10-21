// Plays the demo game (godot/demo) against a fresh local Glitchless server and checks what arrives,
// through the same /v1/query API the dashboard and the MCP tools read.
//
//   node godot/test/e2e.mjs          (npm run test:godot)
//   GODOT=/path/to/Godot node godot/test/e2e.mjs
//
// Needs Godot 4.5 or later. Runs headless, so it works on a machine without a screen.
//   1. offline   the server is down: batches are saved to user://glitchless/outbox.json,
//                in anonymous mode without the session ID
//   2. online    the saved batches go out under a new random ID, then this run's session
//   3. full      full mode: a saved player ID, the device model, death positions
//   4. measure   --glitchless-measure prints frame stats as JSON and quits
//   5. away      a short trip to the background ends the session and resumes it
//   6. long away a trip longer than session_timeout starts a new session
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint } from '../../packages/sdk/src/fingerprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = path.join(ROOT, 'godot');
const SERVICE = 'glitchless-godot-demo';
const godot = findGodot();
const results = [];

function findGodot() {
  const candidates = [
    process.env.GODOT,
    'godot',
    path.join(os.homedir(), 'Applications/Godot.app/Contents/MacOS/Godot'),
    '/Applications/Godot.app/Contents/MacOS/Godot',
    ...listGodotApps(path.join(os.homedir(), 'Applications')),
    ...listGodotApps('/Applications'),
  ].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    const m = r.stdout?.match(/^(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 4 || (Number(m[1]) === 4 && Number(m[2]) >= 5))) return bin;
  }
  console.error('Godot 4.5 or later not found. Set GODOT=/path/to/Godot.');
  process.exit(2);
}

function listGodotApps(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^Godot.*\.app$/.test(f)).sort().reverse().map((f) => path.join(dir, f, 'Contents/MacOS/Godot'));
  } catch {
    return [];
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function runGodot(args, label) {
  const r = spawnSync(godot, ['--headless', '--max-fps', '60', '--path', PROJECT, ...args], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${label}: Godot exited with ${r.status}`);
  }
  return r.stdout + r.stderr;
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
  const qs = new URLSearchParams({ service: SERVICE, from: '0', ...params });
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-godot-'));
const port = await freePort();
const deadPort = await freePort();
let server;
try {
  if (!fs.existsSync(path.join(PROJECT, '.godot'))) spawnSync(godot, ['--headless', '--path', PROJECT, '--import'], { stdio: 'ignore' });
  const userDir = runGodot(['--script', 'res://test/user_dir.gd'], 'user dir').match(/^user dir: (.+)$/m)[1].trim();
  const outbox = path.join(userDir, 'glitchless/outbox.json');
  const playerFile = path.join(userDir, 'glitchless/player_id');
  fs.rmSync(path.join(userDir, 'glitchless'), { recursive: true, force: true });
  const demo = (extra) => ['--', '--autoplay', '--level-seconds=1.5', '--glitchless', ...extra];

  // 1. offline
  runGodot(demo(['--seed=1', `--intake=http://127.0.0.1:${deadPort}`]), 'offline run');
  const saved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  check('offline: unsent batches are saved in user://glitchless/outbox.json', () => assert.ok(saved.includes('"session_start"') && saved.includes('"session_end"'), 'no session in the outbox'));
  check('offline: anonymous mode saves no session or player ID', () => {
    assert.ok(!/"(sid|pid|session_id|player_id)"/.test(saved), 'an ID was written to disk');
    assert.ok(!fs.existsSync(playerFile), 'player_id file exists');
  });

  // 2. online
  server = await startServer(port, path.join(tmp, 'data'));
  runGodot(demo(['--seed=2', `--intake=http://127.0.0.1:${port}`]), 'online run');
  check('online: the outbox is empty once everything is sent', () => assert.ok(!fs.existsSync(outbox), 'outbox.json still there'));

  // 3. full mode
  runGodot(demo(['--seed=3', '--privacy=full', `--intake=http://127.0.0.1:${port}`]), 'full-mode run');
  check('full: a random player ID is saved', () => assert.match(fs.readFileSync(playerFile, 'utf8'), /^p_[a-z0-9]{12}$/));

  // 4. measure (a debug build without --glitchless sends nothing, so this adds no session)
  const out = runGodot(['--', '--autoplay', '--seed=4', '--level-seconds=1', '--glitchless-measure=2'], 'measure run');
  const line = out.split('\n').find((l) => l.startsWith('{"glitchless_measure"'));
  check('measure: prints one line of JSON with frame stats', () => {
    assert.ok(line, 'no {"glitchless_measure": ...} line');
    const m = JSON.parse(line).glitchless_measure;
    assert.ok(m.frames > 30, `frames ${m.frames}`);
    for (const k of ['p50', 'p95', 'p99', 'worst']) assert.equal(typeof m.frame_ms[k], 'number', `frame_ms.${k}`);
    for (const k of ['fps', 'frame_budget_ms', 'pct_frames_over_budget', 'hitch_count', 'draw_calls', 'memory_delta', 'new_errors', 'process_ms']) assert.ok(k in m, k);
    assert.equal(m.headless, true);
  });

  await new Promise((r) => setTimeout(r, 300));
  const { sessions } = await query(port, 'sessions');
  const full = sessions.find((s) => s.player_id.startsWith('p_'));
  const anon = sessions.filter((s) => s !== full);
  check('three sessions arrive: the replayed offline one, the online one and the full-mode one', () => assert.equal(sessions.length, 3, JSON.stringify(sessions.map((s) => s.session_id))));
  check('every session has its start, all three levels and its end', () => {
    for (const s of sessions) {
      assert.equal(s.ended, true, `${s.session_id} not ended`);
      assert.deepEqual(s.levels, ['level_1', 'level_2', 'level_3']);
      assert.match(s.browser, /^Godot 4\.\d+/);
      assert.equal(s.session_type, 'synthetic');
    }
  });
  check('anonymous sessions carry no player ID', () => {
    for (const s of anon) assert.equal(s.player_id, s.session_id);
  });

  const detail = async (id) => (await query(port, 'session', { id })).session;
  const anonDevice = (await detail(anon[0].session_id)).device;
  const fullDevice = (await detail(full.session_id)).device;
  check('anonymous device info is coarse; full adds the model and GPU', () => {
    for (const k of ['model', 'gpu', 'os_version', 'cores', 'memory_gb']) assert.ok(!(k in anonDevice), `anonymous sent ${k}`);
    for (const k of ['os', 'device_tier', 'gpu_tier', 'renderer', 'screen', 'refresh_hz']) assert.ok(k in anonDevice, `anonymous lacks ${k}`);
    for (const k of ['model', 'gpu', 'os_version']) assert.ok(k in fullDevice, `full lacks ${k}`);
  });

  const raw = fs.readdirSync(path.join(tmp, 'data')).filter((f) => f.startsWith('events-')).flatMap((f) => fs.readFileSync(path.join(tmp, 'data', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  check('deaths carry positions in full mode only', () => {
    const deaths = raw.filter((e) => e.type === 'death');
    assert.ok(deaths.length > 0, 'no deaths');
    for (const d of deaths) assert.equal('x' in d, d.player_id.startsWith('p_'), `death in ${d.session_id}`);
  });
  check('frame windows: the server reads the GDScript sketch back', () => {
    const windows = raw.filter((e) => e.type === 'frame_window');
    assert.ok(windows.length >= 6, `${windows.length} windows`);
    for (const w of windows) {
      const s = Sketch.from(w.ft);
      assert.equal(s.n, w.frames);
      assert.equal(Math.round(s.quantile(0.5) * 100) / 100, w.ft_p50);
    }
    assert.ok(windows.every((w) => w.sdk === 'glitchless-godot/0.1.0'));
  });
  check('engine gauges ride in ctx: level_3 carries the orphan nodes level_2 leaked', () => {
    const peak = (level) => Math.max(...raw.filter((e) => e.type === 'frame_window' && e.level === level).map((w) => w.ctx?.orphan_nodes ?? 0));
    assert.ok(peak('level_3') >= 2500, `level_3 orphan_nodes ${peak('level_3')}`);
    assert.ok(peak('level_1') < 10, `level_1 orphan_nodes ${peak('level_1')}`);
  });

  const perf = await query(port, 'performance');
  check('performance: global percentiles and every level', () => {
    assert.equal(typeof perf.kpis.frame_p95, 'number');
    assert.deepEqual(perf.by_level.map((l) => l.key), ['level_1', 'level_2', 'level_3']);
    assert.equal(perf.by_browser[0].key, 'Godot');
  });

  const { issues } = await query(port, 'errors');
  const script = issues.find((i) => i.kind === 'script');
  const pushed = issues.find((i) => i.kind === 'push_error');
  check('errors: the GDScript runtime error, with its script backtrace and breadcrumbs', () => {
    assert.ok(script, `kinds: ${issues.map((i) => i.kind)}`);
    assert.equal(script.message, "Invalid call. Nonexistent function 'queue_free' in base 'Nil'.");
    assert.equal(script.fn, '_play_event');
    assert.equal(script.source, 'demo.gd');
    assert.equal(script.fatal, true);
    assert.match(script.stack, /at _play_event \(res:\/\/demo\/demo\.gd:\d+\)\n {4}at _process \(res:\/\/demo\/demo\.gd:\d+\)/);
    assert.equal(script.sessions, 3);
    assert.equal(script.breadcrumbs.at(-1).name, 'bonus');
  });
  check('errors: push_error groups by the browser SDK fingerprint, long numbers blanked', () => {
    assert.ok(pushed, 'no push_error issue');
    assert.equal(pushed.fingerprint, fingerprint('push_error', pushed.message, '_play_event'));
    assert.ok(pushed.count >= 3, `count ${pushed.count}`);
  });
  check('errors: paths on the device are cut down to user:// before anything is sent', () => {
    assert.match(pushed.message, /^bonus table missing row \d+ in user:\/\/bonus\.cfg$/);
    const userName = os.userInfo().username;
    for (const e of raw.filter((x) => x.type === 'error')) assert.ok(!JSON.stringify(e).includes(userName), `user name in: ${e.message}`);
  });
  check('errors: each error event lists the game events before it', () => {
    const e = raw.find((x) => x.type === 'error' && x.kind === 'script');
    assert.ok(Array.isArray(e.recent) && e.recent.includes('bonus'), JSON.stringify(e.recent));
  });

  // 5 and 6: the phone lifecycle, pretended with the notifications iOS and Android send.
  const before = new Set(sessions.map((s) => s.session_id));
  runGodot(demo(['--seed=5', '--background-at=2', '--background-for=0.5', `--intake=http://127.0.0.1:${port}`]), 'short background run');
  await new Promise((r) => setTimeout(r, 300));
  const shortAway = (await query(port, 'sessions')).sessions.filter((s) => !before.has(s.session_id));
  shortAway.forEach((s) => before.add(s.session_id));
  runGodot(demo(['--seed=6', '--background-at=2', '--background-for=1.5', '--session-timeout=1', `--intake=http://127.0.0.1:${port}`]), 'long background run');
  await new Promise((r) => setTimeout(r, 300));
  const longAway = (await query(port, 'sessions')).sessions.filter((s) => !before.has(s.session_id));
  const typesOf = (id) => raw2().filter((e) => e.session_id === id && ['session_start', 'session_end', 'custom'].includes(e.type) && e.name !== 'pickup' && e.name !== 'powerup' && e.name !== 'bonus').map((e) => e.reason || e.name || e.type);
  const raw2 = () => fs.readdirSync(path.join(tmp, 'data')).filter((f) => f.startsWith('events-')).flatMap((f) => fs.readFileSync(path.join(tmp, 'data', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  check('away: a short trip to the background ends the session, and coming back carries on in it', () => {
    assert.equal(shortAway.length, 1, `${shortAway.length} sessions`);
    assert.deepEqual(typesOf(shortAway[0].session_id), ['session_start', 'background', 'app_resume', 'quit']);
  });
  check('long away: past session_timeout, coming back starts a new session with a new ID', () => {
    assert.equal(longAway.length, 2, `${longAway.length} sessions`);
    const [first, second] = longAway.sort((a, b) => a.start - b.start);
    assert.deepEqual(typesOf(first.session_id), ['session_start', 'background']);
    assert.deepEqual(typesOf(second.session_id), ['session_start', 'quit']);
  });

  const all = (await query(port, 'sessions')).sessions;
  check('a script error just before the session ends makes it a crash', () => {
    // Every run quits about half a second after level_3's script error; a session that
    // went to the background before level_3 never saw it.
    const scriptError = new Set(raw2().filter((e) => e.type === 'error' && e.kind === 'script').map((e) => e.session_id));
    for (const s of all) assert.equal(s.crashed, scriptError.has(s.session_id), s.session_id);
    assert.ok(all.some((s) => !s.crashed));
  });
} finally {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const [status, name, why] of results) console.log(`${status === 'ok' ? '✔' : '✖'} ${name}${why ? `\n    ${why}` : ''}`);
const failed = results.filter((r) => r[0] !== 'ok').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (Godot: ${godot})`);
process.exit(failed ? 1 : 0);
