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
//   7. focus     losing focus without going to the background (Control Center, a call)
//                and drawing nothing meanwhile is not a frozen frame
//   8. bug report  one from code (Glitchless.report_bug), one through the F8 form, and the offline
//                run's, saved in the outbox and sent on the next launch
//   9. install   install mode: the random player ID kept in user://, sent as player_id, with the device and
//                positions as anonymous mode sends them; reset_install_id() and anonymous mode remove it
//  10. repeats   the server stores the first batch but its answer is late: going to the background sends the
//                batch again, and a send that times out is tried again. Each batch carries its batch_id, so
//                the server stores it once (Starlift's first batches arrived up to 8 times without one)
//  11. close     the window closes mid-level: Glitchless records the abandon before the session's end, and drops
//                the "left" fail the game sends as it tears the level down
// It first runs test/bug_report_test.gd (screenshot fitting, slimmed events, hotkeys), test/device_test.gd
// (Steam Deck detection from a Deck's, a desktop's and a Deck-like PC's files; Firebase Test Lab's setting),
// test/frames_test.gd (the refresh rate read off the fast frames; hitch causes) and test/steam_test.gd (Steam facts
// from a fake GodotSteam).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

// Like runGodot, without blocking this process, so a server in it (the proxy in step 10) can answer.
function runGodotAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(godot, ['--headless', '--max-fps', '60', '--path', PROJECT, ...args]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('exit', (code) => (clearTimeout(timer), code === 0 ? resolve(out) : reject(new Error(`Godot exited with ${code}\n${out}`))));
  });
}

// Passes each request on to the server, so every batch is stored, but holds the answer to the first intake request
// back for holdMs: what a phone that stalled, or went to the background mid-send, sees.
async function holdingProxy(target, holdMs) {
  let first = true;
  const answers = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(`http://127.0.0.1:${target}${req.url}`, { method: req.method, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const text = await r.text();
    if (req.url.startsWith('/v1/intake')) {
      answers.push(JSON.parse(text));
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      }
    }
    if (res.writable) res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(text);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, answers, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
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
  const unit = spawnSync(godot, ['--headless', '--path', PROJECT, '--script', 'res://test/bug_report_test.gd'], { encoding: 'utf8', timeout: 120_000 });
  for (const m of unit.stdout.matchAll(/^(ok|FAIL) (.+)$/gm)) results.push(m[1] === 'ok' ? ['ok', `bug report unit: ${m[2]}`] : ['FAIL', `bug report unit: ${m[2]}`]);
  check('bug report unit tests ran', () => assert.match(unit.stdout, /bug report tests: 0 failed/, unit.stdout + unit.stderr));
  const deviceUnit = spawnSync(godot, ['--headless', '--path', PROJECT, '--script', 'res://test/device_test.gd'], { encoding: 'utf8', timeout: 120_000 });
  for (const m of deviceUnit.stdout.matchAll(/^(ok|FAIL) (.+)$/gm)) results.push(m[1] === 'ok' ? ['ok', `device unit: ${m[2]}`] : ['FAIL', `device unit: ${m[2]}`]);
  check('device unit tests ran', () => assert.match(deviceUnit.stdout, /device tests: 0 failed/, deviceUnit.stdout + deviceUnit.stderr));
  const steamUnit = spawnSync(godot, ['--headless', '--path', PROJECT, '--script', 'res://test/steam_test.gd'], { encoding: 'utf8', timeout: 120_000 });
  for (const m of steamUnit.stdout.matchAll(/^(ok|FAIL) (.+)$/gm)) results.push(m[1] === 'ok' ? ['ok', `steam unit: ${m[2]}`] : ['FAIL', `steam unit: ${m[2]}`]);
  check('steam unit tests ran', () => assert.match(steamUnit.stdout, /steam tests: 0 failed/, steamUnit.stdout + steamUnit.stderr));
  const framesUnit = spawnSync(godot, ['--headless', '--path', PROJECT, '--script', 'res://test/frames_test.gd'], { encoding: 'utf8', timeout: 120_000 });
  for (const m of framesUnit.stdout.matchAll(/^(ok|FAIL) (.+)$/gm)) results.push(m[1] === 'ok' ? ['ok', `frames unit: ${m[2]}`] : ['FAIL', `frames unit: ${m[2]}`]);
  check('frames unit tests ran', () => assert.match(framesUnit.stdout, /frames tests: 0 failed/, framesUnit.stdout + framesUnit.stderr));
  const outbox = path.join(userDir, 'glitchless/outbox.json');
  const playerFile = path.join(userDir, 'glitchless/player_id');
  fs.rmSync(path.join(userDir, 'glitchless'), { recursive: true, force: true });
  const demo = (extra) => ['--', '--autoplay', '--level-seconds=1.5', '--glitchless', ...extra];

  // 1. offline
  const offlineOut = runGodot(demo(['--seed=1', '--bug-report-at=1', `--intake=http://127.0.0.1:${deadPort}`]), 'offline run');
  const saved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  check('offline: unsent batches are saved in user://glitchless/outbox.json', () => assert.ok(saved.includes('"session_start"') && saved.includes('"session_end"'), 'no session in the outbox'));
  check('offline: a bug report that could not go is kept in the outbox', () => {
    assert.match(offlineOut, /bug report from code: \{ "sent": false, "reason": "error" \}/);
    assert.ok(saved.includes('"bug_report"') && saved.includes('data:image/jpeg;base64,'), 'no report in the outbox');
  });
  check('offline: anonymous mode saves no session or player ID', () => {
    assert.ok(!/"(sid|pid|session_id|player_id)"/.test(saved), 'an ID was written to disk');
    assert.ok(!fs.existsSync(playerFile), 'player_id file exists');
  });
  check('offline: each saved batch keeps its own batch ID, for the server to spot a repeat', () => {
    const batches = JSON.parse(saved).batches;
    assert.ok(batches.length > 0 && batches.every((b) => /^b_[a-z0-9]{16}$/.test(b.bid)), JSON.stringify(batches.map((b) => b.bid)));
    assert.equal(new Set(batches.map((b) => b.bid)).size, batches.length);
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
    assert.ok(windows.every((w) => w.sdk === 'glitchless-godot/0.4.0'));
  });
  check('load: stamped when the first frame was drawn, not when the first batch went', () => {
    for (const s of sessions) {
      const start = raw.find((e) => e.session_id === s.session_id && e.type === 'session_start');
      const load = raw.find((e) => e.session_id === s.session_id && e.type === 'load' && e.ttff_ms != null);
      const firstWindow = raw.filter((e) => e.session_id === s.session_id && e.type === 'frame_window').sort((a, b) => a.ts - b.ts)[0];
      assert.ok(load && start && firstWindow, s.session_id);
      assert.ok(load.ts - start.ts < 1000, `load ${load.ts - start.ts} ms after the start`);
      assert.ok(load.ts < firstWindow.ts + firstWindow.duration_s * 1000, 'before the first window closed');
    }
  });
  check('load: first_launch is true for the first launch of a version on this device only', () => {
    const loads = raw.filter((e) => e.type === 'load' && e.ttff_ms != null);
    assert.deepEqual(loads.map((e) => e.first_launch).sort(), [false, false, true], JSON.stringify(loads.map((e) => [e.session_id, e.first_launch])));
    assert.equal(fs.readFileSync(path.join(userDir, 'glitchless/launched'), 'utf8'), '0.1.0');
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
  check('away: going to the background mid-level sends an abandon before the end; playing on takes it back', () => {
    const mine = raw2().filter((e) => e.session_id === shortAway[0].session_id);
    const abandon = mine.find((e) => e.type === 'level_abandon');
    assert.ok(abandon && abandon.reason === 'background' && abandon.level === 'level_2', JSON.stringify(abandon));
    const end = mine.find((e) => e.type === 'session_end' && e.reason === 'background');
    assert.ok(abandon.ts <= end.ts && mine.indexOf(abandon) < mine.indexOf(end), 'the abandon comes before the end');
    assert.deepEqual(shortAway[0].abandoned, [], 'level_2 was completed after coming back');
    assert.deepEqual(shortAway[0].completed, ['level_1', 'level_2', 'level_3']);
  });
  check('long away: past session_timeout, coming back starts a new session with a new ID', () => {
    assert.equal(longAway.length, 2, `${longAway.length} sessions`);
    const [first, second] = longAway.sort((a, b) => a.start - b.start);
    assert.deepEqual(typesOf(first.session_id), ['session_start', 'background']);
    assert.deepEqual(typesOf(second.session_id), ['session_start', 'quit']);
  });

  // 7. Control Center on iOS, the notification shade on Android: focus goes, nothing is drawn for 1.5 s,
  // focus comes back. The game never stuttered, so nothing near 1.5 s may be reported.
  const beforeFocus = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  runGodot(demo(['--seed=7', '--focus-away-at=2', '--focus-away-for=1.5', `--intake=http://127.0.0.1:${port}`]), 'focus away run');
  await new Promise((r) => setTimeout(r, 300));
  const focusRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeFocus.has(s.session_id));
  check('focus: time out of focus (Control Center, a call) is not a frame, so no false freeze', () => {
    assert.equal(focusRun.length, 1, `${focusRun.length} sessions`);
    const id = focusRun[0].session_id;
    assert.deepEqual(typesOf(id), ['session_start', 'quit'], 'losing focus is not going to the background');
    const long = raw2().filter((e) => e.session_id === id && e.type === 'hitch' && e.duration_ms >= 1300);
    assert.deepEqual(long.map((e) => e.duration_ms), [], 'a hitch as long as the time out of focus');
    const windows = raw2().filter((e) => e.session_id === id && e.type === 'frame_window');
    assert.ok(windows.length && windows.every((w) => !(w.ft_max >= 1300)), `worst frame ${Math.max(...windows.map((w) => w.ft_max))} ms`);
  });

  // 8. bug reports
  const beforeReports = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  const bugOut = runGodot(demo(['--seed=8', '--bug-report-at=1', '--bug-form-at=2.5', `--intake=http://127.0.0.1:${port}`]), 'bug report run');
  await new Promise((r) => setTimeout(r, 300));
  const bugRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeReports.has(s.session_id));
  const { reports } = await query(port, 'reports');
  check('bug report: sent from code straight away, and through the form', () => {
    assert.match(bugOut, /bug report from code: \{ "sent": true \}/);
    assert.equal(bugRun.length, 1, `${bugRun.length} sessions`);
    const mine = reports.filter((r) => r.session_id === bugRun[0].session_id);
    assert.deepEqual(mine.map((r) => r.note).sort(), ['sparks froze the screen', 'the bonus on level_1 never paid out'], 'Esc cancelled the first form, so it sent nothing');
    for (const r of mine) {
      assert.match(r.device, /^Godot 4\.\d+/);
      assert.equal(r.version, '0.1.0');
    }
  });
  check('bug report: the form pauses the game while it is open, and F8 and Esc open and close it', () => {
    assert.deepEqual(bugOut.match(/bug report form (opened|closed), paused: \w+/g), [
      'bug report form opened, paused: true',
      'bug report form closed, paused: false',
      'bug report form opened, paused: true',
      'bug report form closed, paused: false',
    ]);
  });
  check('bug report: the offline run\'s report arrived with its session on the next launch', () => {
    assert.ok(reports.some((r) => r.note === 'the bonus on level_1 never paid out' && anon.some((s) => s.session_id === r.session_id)), JSON.stringify(reports.map((r) => r.session_id)));
  });
  const fromCode = reports.find((r) => r.session_id === bugRun[0]?.session_id && r.note.startsWith('the bonus'));
  const opened = fromCode && (await query(port, 'report', { id: fromCode.id })).report;
  check('bug report: the screenshot, recent events and frame windows arrive', () => {
    assert.ok(opened, 'no report from code');
    assert.match(opened.screenshot, /^data:image\/jpeg;base64,/);
    assert.ok(opened.screenshot.length <= 200_000);
    assert.equal(opened.sdk, 'glitchless-godot/0.4.0');
    assert.equal(opened.level, 'level_1');
    assert.ok(opened.recent.some((e) => e.type === 'level_start' && e.level === 'level_1'), JSON.stringify(opened.recent));
    assert.ok(opened.recent.every((e) => typeof e.ts === 'number' && e.type), 'recent events need ts and type');
    assert.ok(opened.frames.length > 0 && opened.frames.every((f) => typeof f.fps === 'number' && typeof f.p95 === 'number'), JSON.stringify(opened.frames));
  });
  const timeline = bugRun[0] ? (await query(port, 'session', { id: bugRun[0].session_id })).timeline : [];
  check('bug report: the session timeline lists both reports', () => assert.equal(timeline.filter((e) => e.type === 'bug_report').length, 2));

  const all = (await query(port, 'sessions')).sessions;
  check('a script error is a crash only when nothing in the game happens after it', () => {
    // SPEC §4: a session crashed when the run broke at the end, not when the player played on. Runs quit
    // soon after level_3's script error; whether level_3 still completes in between decides which it is.
    const events = raw2();
    const sdkOwn = new Set(['rage_input', 'screen_change', 'app_resume', 'webgl_context_restored', 'annotation', 'assets_loaded']);
    const play = (e) => ['level_start', 'level_complete', 'level_fail', 'death'].includes(e.type) || (e.type === 'custom' && !sdkOwn.has(e.name));
    const broke = new Set();
    for (const err of events.filter((e) => e.type === 'error' && e.kind === 'script')) {
      if (!events.some((e) => e.session_id === err.session_id && e.ts > err.ts && play(e))) broke.add(err.session_id);
    }
    for (const s of all) assert.equal(s.crashed, broke.has(s.session_id), s.session_id);
    assert.ok(all.some((s) => !s.crashed));
  });

  // 9. install mode
  const beforeInstall = new Set(all.map((s) => s.session_id));
  const intake = `--intake=http://127.0.0.1:${port}`;
  runGodot(demo(['--seed=9', '--privacy=install', intake]), 'install run');
  const firstId = fs.existsSync(playerFile) ? fs.readFileSync(playerFile, 'utf8') : '';
  check('install: a random player ID is saved in user://glitchless/player_id, as in full mode', () => assert.match(firstId, /^p_[a-z0-9]{12}$/));
  runGodot(demo(['--seed=10', '--privacy=install', '--reset-install-id', intake]), 'install reset run');
  check('install: reset_install_id() deletes the saved ID', () => assert.ok(!fs.existsSync(playerFile), 'player_id still there'));
  runGodot(demo(['--seed=11', '--privacy=install', intake]), 'install run after the reset');
  const secondId = fs.existsSync(playerFile) ? fs.readFileSync(playerFile, 'utf8') : '';
  await new Promise((r) => setTimeout(r, 300));
  const installRuns = (await query(port, 'sessions')).sessions.filter((s) => !beforeInstall.has(s.session_id)).sort((a, b) => a.start - b.start);
  check('install: each session sends the saved ID; the one that reset it keeps its own, the next launch has a new one', () => {
    assert.deepEqual(installRuns.map((s) => s.player_id), [firstId, firstId, secondId]);
    assert.match(secondId, /^p_[a-z0-9]{12}$/);
    assert.notEqual(secondId, firstId);
  });
  const installDevice = installRuns[0] && (await detail(installRuns[0].session_id)).device;
  check('install: the device as anonymous mode sends it, and deaths without a place', () => {
    for (const k of ['model', 'gpu', 'os_version', 'cores', 'memory_gb']) assert.ok(!(k in installDevice), `install sent ${k}`);
    assert.deepEqual(Object.keys(installDevice).sort(), Object.keys(anonDevice).sort());
    const mine = new Set(installRuns.map((s) => s.session_id));
    const deaths = raw2().filter((e) => e.type === 'death' && mine.has(e.session_id));
    assert.ok(deaths.length > 0 && deaths.every((d) => !('x' in d)), `${deaths.length} deaths`);
    const start = raw2().find((e) => e.type === 'session_start' && e.session_id === installRuns[0].session_id);
    assert.equal(start.privacy, 'install');
  });
  const { retention } = await query(port, 'players');
  check('install: the players query counts retention over the sessions with an ID', () => {
    assert.equal(retention.status, 'ok');
    assert.ok(retention.id_sessions_pct > 0 && retention.id_sessions_pct < 100, `${retention.id_sessions_pct}%`);
  });
  runGodot(demo(['--seed=12', intake]), 'anonymous run after install');
  check('install: anonymous mode deletes the ID an install-mode build left', () => assert.ok(!fs.existsSync(playerFile), 'player_id still there'));

  // 10. repeats: the first batch is stored, but its answer comes 3 s late. At 2.5 s the game goes to the background,
  // which sends what is waiting there and then, the first batch included.
  const beforeRepeats = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  const proxy = await holdingProxy(port, 3000);
  try {
    await runGodotAsync(demo(['--seed=13', '--background-at=2.5', '--background-for=0.5', `--intake=http://127.0.0.1:${proxy.port}`]));
    await new Promise((r) => setTimeout(r, 3300));
  } finally {
    await proxy.close();
  }
  const repeatRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeRepeats.has(s.session_id));
  check('repeats: a batch sent again is answered as a duplicate, and nothing is stored twice', () => {
    assert.equal(repeatRun.length, 1, `${repeatRun.length} sessions`);
    assert.ok(proxy.answers.some((a) => a.duplicate === true), JSON.stringify(proxy.answers));
    const mine = raw2().filter((e) => e.session_id === repeatRun[0].session_id);
    const seen = new Set();
    for (const e of mine) {
      const key = JSON.stringify({ ...e, received: 0 });
      assert.ok(!seen.has(key), `stored twice: ${e.type}`);
      seen.add(key);
    }
    assert.equal(mine.filter((e) => e.type === 'session_start').length, 1);
  });

  // 11. close mid-level
  const beforeClose = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  runGodot(demo(['--seed=14', '--close-at=2.2', intake]), 'close mid-level run');
  await new Promise((r) => setTimeout(r, 300));
  const closeRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeClose.has(s.session_id));
  check('close: leaving mid-level is an abandon, not a fail, and no rage quit', () => {
    assert.equal(closeRun.length, 1, `${closeRun.length} sessions`);
    const s = closeRun[0];
    const mine = raw2().filter((e) => e.session_id === s.session_id);
    assert.deepEqual(mine.filter((e) => ['level_abandon', 'level_fail', 'session_end'].includes(e.type)).map((e) => [e.type, e.reason ?? e.cause]), [['level_abandon', 'close'], ['session_end', 'close']], 'the game\'s "left" fail after the end is dropped');
    assert.deepEqual(s.abandoned, ['level_2']);
    assert.equal(s.rage_quit, false);
  });
} finally {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const [status, name, why] of results) console.log(`${status === 'ok' ? '✔' : '✖'} ${name}${why ? `\n    ${why}` : ''}`);
const failed = results.filter((r) => r[0] !== 'ok').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (Godot: ${godot})`);
process.exit(failed ? 1 : 0);
