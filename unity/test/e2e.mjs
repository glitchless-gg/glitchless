// Builds the Fetch! sample (the package's Samples~/Fetch) as a macOS player, plays it against a fresh
// local Glitchless server and checks what arrives, through the /v1/query API the dashboard and the MCP
// tools read.
//
//   node unity/test/e2e.mjs                 (npm run test:unity)
//   UNITY=/path/to/Unity node unity/test/e2e.mjs
//
// Uses the Editor version in unity/ProjectSettings/ProjectVersion.txt (or, when it isn't installed, the newest
// one that is) unless UNITY is set; another version runs on a copy of the project, so the committed one isn't
// upgraded. The player runs in batch mode, so it works on a machine without a screen.
//   1. offline   the server is down: batches are saved in the player's persistent data folder,
//                in anonymous mode without any ID
//   2. online    the saved batches go out under a new random ID, then this run's session
//   3. full      full mode: a saved player ID and the device model
//   4. measure   --glitchless-measure writes frame stats as JSON and quits
//   5. install   install mode: the saved player ID sent as player_id (full mode's, kept), the device as anonymous
//                mode sends it
//   6. repeats   the server stores the first batch but its answer is late, and the game quits mid-level meanwhile:
//                quitting sends the batch again, and its batch_id lets the server store it once. The quit sends
//                level_abandon before session_end, and the "left" fail the game sends as it tears the level down
//                (--fail-on-quit) is dropped
// The offline and online runs each send a bug report from code (--bug-report-at): the offline one waits in the
// outbox and goes on the next launch.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVICE = 'fetch-unity';
const PROJECT_VERSION = fs.readFileSync(path.join(ROOT, 'unity/ProjectSettings/ProjectVersion.txt'), 'utf8').match(/m_EditorVersion: (\S+)/)[1];
// The project's version, else the newest Editor the Hub has installed (on a copy of the project, below).
const HUB = '/Applications/Unity/Hub/Editor';
const editorAt = (v) => `${HUB}/${v}/Unity.app/Contents/MacOS/Unity`;
const installed = fs.existsSync(HUB) ? fs.readdirSync(HUB).filter((v) => fs.existsSync(editorAt(v))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
const unity = process.env.UNITY || (installed.includes(PROJECT_VERSION) || !installed.length ? editorAt(PROJECT_VERSION) : editorAt(installed.at(-1)));
if (process.platform !== 'darwin') {
  console.error('This test builds a macOS player. On another OS, build the sample with SampleBuilder yourself.');
  process.exit(2);
}
if (!fs.existsSync(unity)) {
  console.error(`Unity ${PROJECT_VERSION} not found at ${unity}. Install it (unity install ${PROJECT_VERSION}) or set UNITY=/path/to/Unity.`);
  process.exit(2);
}
const editorVersion = unity.match(/Editor\/([^/]+)\//)?.[1] ?? 'custom';
const results = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unity-'));

// A different Editor version would upgrade the project in place: give it a copy.
let project = path.join(ROOT, 'unity');
if (editorVersion !== PROJECT_VERSION) {
  project = path.join(tmp, 'project');
  fs.cpSync(path.join(ROOT, 'unity'), project, { recursive: true, filter: (p) => !/[/\\](Library|Temp|Logs|Builds|UserSettings)$/.test(p) });
}

function editor(method, label, env = {}) {
  const log = path.join(tmp, `${label}.log`);
  const r = spawnSync(unity, ['-batchmode', '-nographics', '-quit', '-projectPath', project, '-executeMethod', method, '-logFile', log], { env: { ...process.env, ...env }, timeout: 900_000 });
  if (r.status !== 0) {
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    console.error(text.split('\n').filter((l) => /error|exception/i.test(l)).slice(0, 30).join('\n'));
    throw new Error(`${label}: Unity exited with ${r.status} (log: ${log})`);
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

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_OTLP: 'off', GLITCHLESS_API_KEY: '' },
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

const app = path.join(project, 'Builds/e2e/Fetch.app');
const player = path.join(app, 'Contents/MacOS/Fetch');
// Application.persistentDataPath for company "Glitchless", product "Fetch" on macOS.
const dataDir = path.join(os.homedir(), 'Library/Application Support/Glitchless/Fetch/glitchless');
const outbox = path.join(dataDir, 'outbox.json');
const playerFile = path.join(dataDir, 'player_id');

function play(args, label) {
  const log = path.join(tmp, `${label}.player.log`);
  const r = spawnSync(player, ['-batchmode', '-nographics', '-logFile', log, '--autoplay', ...args], { timeout: 180_000 });
  if (r.status !== 0) throw new Error(`${label}: the player exited with ${r.status} (log: ${log})`);
  return fs.readFileSync(log, 'utf8');
}

// Like play, without blocking this process, so a server in it (the proxy in step 6) can answer.
function playAsync(args, label) {
  const log = path.join(tmp, `${label}.player.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(player, ['-batchmode', '-nographics', '-logFile', log, '--autoplay', ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(fs.readFileSync(log, 'utf8'));
      else reject(new Error(`${label}: the player exited with ${code} (log: ${log})`));
    });
  });
}

// Passes each request on to the server, so every batch is stored, but holds the answer to the first intake request
// back for holdMs: what a phone that stalled, or a game that quit mid-send, sees.
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

const readRaw = () => fs.readdirSync(path.join(tmp, 'data')).filter((f) => f.startsWith('events-')).flatMap((f) => fs.readFileSync(path.join(tmp, 'data', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));

// A package installed from git is read-only, and Unity ignores any file in it without a .meta.
const PACKAGE = path.join(ROOT, 'unity/Packages/gg.glitchless.sdk');
check('every file in the package has its .meta (Samples~ is copied as it is)', () => {
  const missing = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.endsWith('.meta') || e.name.startsWith('.') || e.name.endsWith('~')) continue;
      const p = path.join(dir, e.name);
      if (!fs.existsSync(`${p}.meta`)) missing.push(path.relative(PACKAGE, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(PACKAGE);
  assert.deepEqual(missing, []);
});

const port = await freePort();
const deadPort = await freePort();
let server;
try {
  console.log(`Unity ${editorVersion}: importing the sample and building the player…`);
  editor('SampleBuilder.Import', 'import');
  editor('SampleBuilder.BuildPlayer', 'build', { GLITCHLESS_BUILD_OUT: 'Builds/e2e/Fetch.app' });
  fs.rmSync(dataDir, { recursive: true, force: true });

  // 1. offline
  const offlineLog = play(['--level=3', '--skill=0.95', '--seed=1', '--bug-report-at=3', `--glitchless-intake=http://127.0.0.1:${deadPort}`], 'offline');
  const saved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  check('offline: unsent batches are saved in the persistent data folder', () => assert.ok(saved.includes('"session_start"') && saved.includes('"session_end"') && saved.includes('KeyNotFoundException'), 'the session is not in the outbox'));
  check('offline: a bug report that could not go is kept in the outbox', () => {
    assert.match(offlineLog, /bug report from code: sent=False reason=error/);
    assert.ok(saved.includes('"bug_report"') && saved.includes('the pup ran into something invisible'), 'no report in the outbox');
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
  const onlineLog = play(['--level=2', '--skill=0.7', '--seed=2', '--quit-after=40', '--bug-report-at=3', `--glitchless-intake=http://127.0.0.1:${port}`], 'online');
  check('online: the outbox is empty once everything is sent', () => assert.ok(!fs.existsSync(outbox), 'outbox.json still there'));

  // 3. full mode
  play(['--level=3', '--skill=0.95', '--seed=3', '--privacy=full', `--glitchless-intake=http://127.0.0.1:${port}`], 'full');
  check('full: a random player ID is saved', () => assert.match(fs.readFileSync(playerFile, 'utf8'), /^p_[a-z0-9]{12}$/));

  // 4. measure (--glitchless-off: this run sends nothing, so it adds no session)
  const measureOut = path.join(tmp, 'measure.json');
  play(['--level=1', '--skill=1', '--seed=4', '--glitchless-off', '--glitchless-warmup=1', '--glitchless-measure=2', `--glitchless-out=${measureOut}`], 'measure');
  check('measure: writes one line of JSON with frame stats', () => {
    const m = JSON.parse(fs.readFileSync(measureOut, 'utf8')).glitchless_measure;
    assert.ok(m.frames > 30, `frames ${m.frames}`);
    for (const k of ['p50', 'p95', 'p99', 'worst']) assert.equal(typeof m.frame_ms[k], 'number', `frame_ms.${k}`);
    for (const k of ['fps', 'frame_budget_ms', 'pct_frames_over_budget', 'hitch_count', 'update_cpu_ms', 'physics_ms', 'memory_delta', 'new_errors']) assert.ok(k in m, k);
    assert.equal(m.sdk, 'glitchless-unity/0.3.0');
  });

  await new Promise((r) => setTimeout(r, 300));
  const { sessions } = await query(port, 'sessions');
  const full = sessions.find((s) => s.player_id.startsWith('p_'));
  const anon = sessions.filter((s) => s !== full);
  check('three sessions arrive: the replayed offline one, the online one and the full-mode one', () => assert.equal(sessions.length, 3, JSON.stringify(sessions.map((s) => s.session_id))));
  check('every session has its start, its levels and its end', () => {
    for (const s of sessions) {
      assert.equal(s.ended, true, `${s.session_id} not ended`);
      assert.ok(s.levels.length > 0 && s.levels.every((l) => /^level-[123]$/.test(l)), `levels ${s.levels}`);
      assert.match(s.browser, /^Unity \d{4}\.\d+/);
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
    for (const k of ['os', 'device_tier', 'gpu_tier', 'renderer', 'driver', 'screen', 'refresh_hz']) assert.ok(k in anonDevice, `anonymous lacks ${k}`);
    for (const k of ['model', 'gpu', 'os_version', 'cores']) assert.ok(k in fullDevice, `full lacks ${k}`);
  });

  const raw = readRaw();
  check('load: stamped at the first frame, not when the first batch went', () => {
    for (const s of sessions) {
      const start = raw.find((e) => e.session_id === s.session_id && e.type === 'session_start');
      const load = raw.find((e) => e.session_id === s.session_id && e.type === 'load' && 'ttff_ms' in e);
      assert.ok(load, `${s.session_id}: no load`);
      // The session starts before the first scene loads, after the engine has started: the first frame comes
      // at most ttff_ms after it. The first batch goes 2 s after Init.
      assert.ok(load.ts >= start.ts && load.ts - start.ts <= load.ttff_ms + 100, `load ${load.ts - start.ts} ms after the start, ttff_ms ${load.ttff_ms}`);
    }
  });
  check("load: first_launch only on this build's first launch here (the offline run)", () => {
    const loads = sessions.map((s) => raw.find((e) => e.session_id === s.session_id && e.type === 'load' && 'ttff_ms' in e));
    assert.deepEqual(loads.map((l) => l?.first_launch).sort(), [false, false, true]);
    assert.equal(fs.readFileSync(path.join(dataDir, 'launched'), 'utf8'), '1.0.0');
  });
  check('frame windows: the server reads the C# sketch back, with the frame split and the mesh count', () => {
    const windows = raw.filter((e) => e.type === 'frame_window');
    assert.ok(windows.length >= 6, `${windows.length} windows`);
    for (const w of windows) {
      const s = Sketch.from(w.ft);
      assert.equal(s.n, w.frames);
      assert.equal(Math.round(s.quantile(0.5) * 100) / 100, w.ft_p50);
      for (const k of ['process_ms', 'physics_ms', 'render_ms']) assert.equal(typeof w[k], 'number', k);
    }
    assert.ok(windows.every((w) => w.sdk === 'glitchless-unity/0.3.0'));
    assert.ok(windows.some((w) => typeof w.geometries === 'number'), 'no mesh count (a development build has it)');
  });
  check('the confetti bodies show up in the physics time', () => {
    const peak = Math.max(...raw.filter((e) => e.type === 'frame_window').map((w) => w.physics_ms));
    assert.ok(peak > 0.3, `physics_ms peaks at ${peak}`);
  });
  check('deaths carry places (the sample turns positions on)', () => {
    const deaths = raw.filter((e) => e.type === 'death');
    assert.ok(deaths.length > 0, 'no deaths');
    for (const d of deaths) assert.equal(typeof d.x, 'number');
  });

  const { issues } = await query(port, 'errors');
  check('the frisbee exception is one issue, at FetchGame.CatchToy', () => {
    const issue = issues.find((i) => i.kind === 'exception');
    assert.ok(issue, JSON.stringify(issues.map((i) => i.message)));
    assert.match(issue.message, /^KeyNotFoundException/);
    assert.match(issue.location, /FetchGame\.CatchToy \(FetchGame\.cs:\d+\)/);
    assert.ok(issue.sessions >= 2, `${issue.sessions} sessions`);
  });
  const { reports } = await query(port, 'reports');
  check('bug reports: sent from code straight away, and the offline one on the next launch', () => {
    assert.match(onlineLog, /bug report from code: sent=True reason=none/);
    assert.equal(reports.length, 2, JSON.stringify(reports.map((r) => r.note)));
    for (const r of reports) {
      assert.match(r.note, /^the pup ran into something invisible on level-[123]$/);
      assert.ok(anon.some((s) => s.session_id === r.session_id), 'in its anonymous session');
      assert.match(r.device, /^Unity \d{4}\.\d+/);
      assert.equal(typeof r.position?.x, 'number', 'the sample turns positions on');
    }
  });
  const opened = reports[0] && (await query(port, 'report', { id: reports[0].id })).report;
  check('bug reports: recent events and frame windows arrive (no screenshot in -nographics)', () => {
    assert.ok(opened, 'no report');
    assert.equal(opened.sdk, 'glitchless-unity/0.3.0');
    assert.ok(opened.recent.some((e) => e.type === 'level_start'), JSON.stringify(opened.recent));
    assert.ok(opened.frames.length > 0 && opened.frames.every((f) => typeof f.fps === 'number'), JSON.stringify(opened.frames));
    assert.equal(opened.screenshot, null);
  });
  const { findings } = await query(port, 'findings');
  check('findings speak Unity', () => {
    const f = findings.find((x) => x.evidence?.kind === 'exception');
    assert.ok(f, 'no finding for the exception');
    assert.match(f.summary, /Unity skipped the rest of that callback/);
    assert.match(f.suggestion, /GetComponent|Destroy/);
  });

  // 5. install mode
  const beforeInstall = new Set(sessions.map((s) => s.session_id));
  const fullId = fs.readFileSync(playerFile, 'utf8');
  play(['--level=1', '--skill=1', '--seed=5', '--privacy=install', '--quit-after=20', `--glitchless-intake=http://127.0.0.1:${port}`], 'install');
  const installId = fs.existsSync(playerFile) ? fs.readFileSync(playerFile, 'utf8') : '';
  check("install: the player ID full mode saved is kept and sent", () => assert.equal(installId, fullId));
  await new Promise((r) => setTimeout(r, 300));
  const installRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeInstall.has(s.session_id));
  const installDevice = installRun[0] && (await detail(installRun[0].session_id)).device;
  check('install: the session sends the saved ID, with the device as anonymous mode sends it', () => {
    assert.deepEqual(installRun.map((s) => s.player_id), [installId]);
    assert.deepEqual(Object.keys(installDevice).sort(), Object.keys(anonDevice).sort());
    const raw5 = readRaw();
    assert.equal(raw5.find((e) => e.type === 'session_start' && e.session_id === installRun[0].session_id).privacy, 'install');
  });

  // 6. repeats: the first batch is stored, but its answer comes 5 s late. The game quits about 4.5 s in, mid-level,
  // and sends what is waiting then, the first batch included.
  const beforeRepeats = new Set((await query(port, 'sessions')).sessions.map((s) => s.session_id));
  const proxy = await holdingProxy(port, 5000);
  try {
    await playAsync(['--level=1', '--skill=1', '--seed=6', '--quit-after=3', '--fail-on-quit', `--glitchless-intake=http://127.0.0.1:${proxy.port}`], 'repeats');
  } finally {
    await proxy.close();
  }
  await new Promise((r) => setTimeout(r, 300));
  const repeatRun = (await query(port, 'sessions')).sessions.filter((s) => !beforeRepeats.has(s.session_id));
  const raw6 = readRaw();
  const mine = repeatRun[0] ? raw6.filter((e) => e.session_id === repeatRun[0].session_id) : [];
  check('repeats: a batch sent again is answered as a duplicate, and stored once', () => {
    assert.equal(repeatRun.length, 1, `${repeatRun.length} sessions`);
    assert.ok(proxy.answers.some((a) => a.duplicate === true), JSON.stringify(proxy.answers));
    assert.equal(mine.filter((e) => e.type === 'session_start').length, 1);
  });
  check('quit mid-level: an abandon before the end, and the "left" fail after it is dropped', () => {
    const ends = mine.filter((e) => ['level_abandon', 'level_fail', 'session_end'].includes(e.type)).map((e) => [e.type, e.reason ?? e.cause, e.level]);
    assert.deepEqual(ends, [['level_abandon', 'quit', 'level-1'], ['session_end', 'quit', 'level-1']]);
    assert.deepEqual(repeatRun[0].abandoned, ['level-1']);
    assert.equal(repeatRun[0].rage_quit, false);
  });
  check('no event is stored twice', () => {
    const seen = new Set();
    for (const e of raw6) {
      const key = JSON.stringify({ ...e, received: 0 });
      assert.ok(!seen.has(key), `stored twice: ${e.type} in ${e.session_id}`);
      seen.add(key);
    }
  });
} catch (err) {
  results.push(['FAIL', 'run', err.message]);
} finally {
  server?.kill();
}

let failed = 0;
for (const [status, name, why] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${why ? `\n    ${why}` : ''}`);
  if (status !== 'ok') failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed (Unity ${editorVersion}; logs in ${tmp})`);
process.exit(failed ? 1 : 0);
