// Packages the test game (unreal/test/GlitchlessTest, which loads the plugin from unreal/Plugins) as a
// Development build, plays it against a fresh local Glitchless server and checks what arrives: what
// the plugin sent (recorded on the way in) and what the server made of it (its raw events and the
// /v1/query API the dashboard and the MCP tools read). ios.mjs does the same on an iPhone.
//
//   node unreal/test/e2e.mjs              build, cook and package, then play
//   node unreal/test/e2e.mjs --no-build   play the last package again
//   node unreal/test/e2e.mjs --offscreen  render with no window (on by itself over SSH on Windows)
//   UE_ROOT=/path/to/UE_5.8 node unreal/test/e2e.mjs
//
//   1. autoplay   the scripted run: events, context, hitches from game code, garbage collection and a
//                 map load, a log error, an ensure, a Blueprint error, a death, a bug report
//   2. crash      the same run ending in a crash: it is written to the outbox, each batch with its batch ID, and
//                 sent on the next launch; then one ending in a UE_LOG Fatal, and one that types into the bug report box
//   2d. leave     a level left twice: the game goes to the background mid-level (failing the level as "left" there),
//                 comes back and quits mid-level, while the first batch's answer is held back, so going to the
//                 background gives that batch up and it is sent again: the server stores it once, by its batch_id
//   2e. genre     properties, groups, a level with attributes, a zone, counts, flags and lists, and a connection
//                 that drops and comes back (the recorder's health answer lists the features a newer server has)
//   3. measure    -glitchless-measure prints frame stats as one line of JSON and quits
// Last, nothing the server stored over all these runs is stored twice.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, SDK, WINDOWS, checkAutoplay, checkDialog, checkGenre, checkMeasureLine, checkSentOnce, checker, events, freePort, packageGame, query, requireEngine, startRecorder, startServer } from './harness.mjs';

const PLATFORM = WINDOWS ? 'Win64' : 'Mac';
// The staged build: on a Mac, -archive copies the .app without its content (UE 5.8), so it is run where it was staged.
const STAGED = path.join(ROOT, 'unreal/test/GlitchlessTest/Saved/StagedBuilds');
const build = !process.argv.includes('--no-build');
// Over SSH a Windows game runs in session 0, which has no desktop to put a window on (D3D12 can't make its
// swapchain there): it renders offscreen instead. --offscreen does the same anywhere.
const offscreen = process.argv.includes('--offscreen') || (WINDOWS && !process.env.SESSIONNAME);
const { check, finish, results } = checker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-'));

requireEngine();

function executable() {
  // On Windows the staged GlitchlessTest.exe at the top only starts this one (and keeps its stdout to itself).
  const candidates = WINDOWS ? [path.join(STAGED, 'Windows/GlitchlessTest/Binaries/Win64/GlitchlessTest.exe'), path.join(STAGED, 'Windows/GlitchlessTest.exe')] : [path.join(STAGED, 'Mac/GlitchlessTest.app/Contents/MacOS/GlitchlessTest')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`no packaged game in ${STAGED}`);
  return found;
}

// FPaths::ProjectSavedDir() of a packaged game. A Windows Development build isn't "installed" (only Shipping is), so
// its Saved folder is beside it. UE 5.8 signs Mac builds with App Sandbox, so theirs is in the app's container
// (named for its bundle ID), and the container's tmp is the one place outside it the game may write -glitchless-out.
function bundleId() {
  const plist = path.join(STAGED, 'Mac/GlitchlessTest.app/Contents/Info.plist');
  const r = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'gg.glitchless.unrealtest';
}
let container = path.join(os.homedir(), 'Library/Containers/gg.glitchless.unrealtest/Data');
let savedDir = WINDOWS ? path.join(STAGED, 'Windows/GlitchlessTest/Saved') : path.join(container, 'Library/Application Support/Epic/GlitchlessTest/Saved');
let outbox = path.join(savedDir, 'Glitchless/outbox.json');
let outDir = WINDOWS ? tmp : path.join(container, 'tmp');

// The game runs while this process keeps serving the recorder, so it is spawned, not spawnSync'd.
function launch(exe, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(exe, ['-windowed', '-ResX=1280', '-ResY=720', ...(offscreen ? ['-RenderOffscreen'] : []), '-unattended', '-nosound', '-nosplash', '-stdout', '-FullStdOutLogOutput', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ stdout: out, status, signal });
    });
  });
}

// A UE 5.8 Mac Development build sometimes dies as it starts, before it logs anything: the game thread empties
// the memory tracker (LLM, when -llm isn't given) while the main thread's first Apple Event pops a tag off it
// (FLLMGlobals::ProcessCommandLineInner, about 1 launch in 12 here). Glitchless isn't loaded yet, so such a
// launch is tried again. A planted crash comes long after the engine's first log line.
async function play(exe, args, label, { expectCrash = false, timeout = 180_000 } = {}) {
  const log = path.join(tmp, `${label}.log`);
  let run;
  for (let attempt = 1; attempt <= 3; attempt++) {
    run = await launch(exe, args, timeout);
    const diedStarting = (run.signal || run.status > 128) && !/LogInit/.test(run.stdout);
    if (!diedStarting) break;
    console.log(`   ${label}: the engine died as it started (${run.signal ?? run.status}), before Glitchless loads; again…`);
  }
  fs.writeFileSync(log, run.stdout);
  if (!expectCrash && run.status !== 0) throw new Error(`${label}: the game exited with ${run.status ?? run.signal} (log: ${log})`);
  if (expectCrash) await new Promise((r) => setTimeout(r, 2000)); // the OS writes its crash report
  return { ...run, log };
}

// Passes each request on (to the recorder, and so to the server, which stores it), but holds the answer to the first
// intake request back for holdMs: what a phone that stalled, or went to the background mid-send, sees.
async function holdingProxy(target, holdMs) {
  let first = true;
  const answers = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let status = 502;
    let text = '';
    try {
      const r = await fetch(`http://127.0.0.1:${target}${req.url}`, { method: req.method, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined, headers: { 'content-type': req.headers['content-type'] || 'text/plain' } });
      status = r.status;
      text = await r.text();
    } catch {}
    if (req.url.startsWith('/v1/intake')) {
      try {
        answers.push(JSON.parse(text));
      } catch {
        answers.push({ status, text });
      }
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, holdMs));
      }
    }
    if (res.writable) res.writeHead(status, { 'content-type': 'application/json' }).end(text);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, answers, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

// Everything the server stored, as its file store wrote it.
function stored(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir).filter((f) => /^events-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(dataDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

const BATCH_ID = /^b_[a-z0-9]{16}$/;
const port = await freePort();
const recorderPort = await freePort();
const batches = [];
let server;
let recorder;
try {
  if (build) packageGame(PLATFORM, path.join(tmp, 'package.log'));
  const exe = executable();
  if (!WINDOWS) {
    container = path.join(os.homedir(), 'Library/Containers', bundleId(), 'Data');
    savedDir = path.join(container, 'Library/Application Support/Epic/GlitchlessTest/Saved');
    outbox = path.join(savedDir, 'Glitchless/outbox.json');
    outDir = path.join(container, 'tmp');
  }
  fs.rmSync(path.join(savedDir, 'Glitchless'), { recursive: true, force: true });
  server = await startServer(port, path.join(tmp, 'data'));
  recorder = await startRecorder(recorderPort, port, batches);
  const intake = `-glitchless-intake=http://127.0.0.1:${recorderPort}`;

  // 1. autoplay
  console.log('1. autoplay…');
  await play(exe, ['-autoplay', intake], 'autoplay');
  checkAutoplay(check, batches, events(batches));
  checkSentOnce(check, batches);
  check('nothing is left in the outbox', () => assert.ok(!fs.existsSync(outbox), 'outbox.json is still there'));

  // 2. crash
  console.log('2. crash, then a launch that sends it…');
  const before = batches.length;
  const crashed = await play(exe, ['-autoplay', '-glitchless-test-crash', intake], 'crash', { expectCrash: true });
  check('the crash run dies', () => assert.ok(crashed.status !== 0, `exited with ${crashed.status}`));
  const saved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  check('the crash is in the outbox, with no ID (anonymous mode)', () => {
    assert.ok(saved.includes('"kind":"crash"'), 'no crash in the outbox');
    assert.ok(saved.includes('"reason":"crash"'), 'no session end');
    assert.ok(!/"(sid|pid|session_id|player_id)"/.test(saved), 'an ID was written to disk');
  });
  const savedIds = saved ? JSON.parse(saved).batches.map((b) => b.bid) : [];
  check('each batch in the outbox keeps its own batch ID, for the server to spot a repeat', () => {
    assert.ok(savedIds.length > 0 && savedIds.every((id) => BATCH_ID.test(id)), JSON.stringify(savedIds));
    assert.equal(new Set(savedIds).size, savedIds.length);
  });
  const beforeAfterCrash = batches.length;
  await play(exe, ['-glitchless-measure=2', intake], 'after-crash');
  check('the next launch sends the crash, with its callstack', () => {
    const crash = events(batches.slice(before)).find((e) => e.type === 'error' && e.kind === 'crash');
    assert.ok(crash, 'no crash arrived');
    assert.match(crash.fn || '', /UGlitchlessTestScript::Step/);
    assert.match(crash.stack, /^crash: /);
  });
  check('the next launch sends the saved batches under the batch IDs they were saved with', () => {
    const sent = new Set(batches.slice(beforeAfterCrash).map((b) => b.json?.batch_id));
    for (const id of savedIds) assert.ok(sent.has(id), `${id} was not sent: ${JSON.stringify([...sent])}`);
  });

  // 2b. a fatal error (UE_LOG Fatal) goes the same way
  console.log('2b. a fatal error, then a launch that sends it…');
  const beforeFatal = batches.length;
  const fatal = await play(exe, ['-autoplay', '-glitchless-test-fatal', intake], 'fatal', { expectCrash: true });
  check('the fatal run dies', () => assert.ok(fatal.status !== 0, `exited with ${fatal.status}`));
  await play(exe, ['-glitchless-measure=2', intake], 'after-fatal');
  check('the next launch sends the fatal error as a crash, with its message', () => {
    const crash = events(batches.slice(beforeFatal)).find((e) => e.type === 'error' && e.kind === 'crash');
    assert.ok(crash, 'no crash arrived');
    assert.match(crash.message, /Planted fatal error/);
  });

  // 2c. the bug report box, typed into and sent with Ctrl+Enter
  console.log('2c. the bug report box…');
  const beforeBox = batches.length;
  await play(exe, ['-autoplay', '-glitchless-test-dialog', intake], 'dialog');
  checkDialog(check, events(batches.slice(beforeBox)));

  // 2d. a level left twice, and a batch sent twice
  console.log('2d. a level left by going to the background and by quitting, and a batch sent again…');
  const beforeLeave = batches.length;
  const proxy = await holdingProxy(recorderPort, 4000);
  try {
    await play(exe, ['-autoplay', '-glitchless-test-leave', `-glitchless-intake=http://127.0.0.1:${proxy.port}`], 'leave');
  } finally {
    await proxy.close();
  }
  const leave = batches.slice(beforeLeave);
  // Each batch as it first arrived: a batch sent again repeats its events, which the server drops.
  const firstTries = leave.filter((b, i) => leave.findIndex((o) => o.json?.batch_id === b.json?.batch_id) === i);
  const leaveSid = leave[0]?.json?.session_id;
  check('leave: going to the background mid-level abandons the level before the end; the game\'s "left" fail after it is dropped; quitting mid-level abandons it again', () => {
    const outcomes = events(firstTries).filter((e) => e.type === 'session_end' || (e.level === 'arena-1' && /^level_/.test(e.type)));
    assert.deepEqual(outcomes.map((e) => [e.type, e.reason ?? e.cause ?? null]), [['level_start', null], ['level_abandon', 'background'], ['session_end', 'background'], ['level_abandon', 'quit'], ['session_end', 'quit']]);
    const [, abandon, end] = outcomes;
    assert.ok(abandon.ts <= end.ts, 'the abandon comes before the end');
    assert.ok(typeof abandon.duration_s === 'number' && abandon.duration_s > 0, `duration_s ${abandon.duration_s}`);
    assert.ok(events(firstTries).some((e) => e.type === 'custom' && e.name === 'app_resume'), 'no app_resume: the session did not go on');
    assert.equal(new Set(leave.map((b) => b.json?.session_id)).size, 1, 'coming back soon keeps the session');
  });
  check('repeats: the batch given up on in the background goes again under its batch_id, and the server answers it as a duplicate', () => {
    for (const b of leave) assert.match(b.json?.batch_id || '', BATCH_ID);
    const twice = leave.filter((b) => leave.filter((o) => o.json.batch_id === b.json.batch_id).length > 1);
    assert.ok(twice.length >= 2, `no batch was sent again: ${JSON.stringify(leave.map((b) => b.json.batch_id))}`);
    assert.deepEqual(twice[1].json.events, twice[0].json.events, 'a batch sent again must be the same batch');
    assert.ok(proxy.answers.some((a) => a.duplicate === true), JSON.stringify(proxy.answers));
  });
  await new Promise((r) => setTimeout(r, 300));
  check('leave: the server stores the session once, the level as abandoned, and no rage quit', () => {
    const mine = stored(path.join(tmp, 'data')).filter((e) => e.session_id === leaveSid);
    assert.ok(mine.length > 0, `nothing stored for ${leaveSid}`);
    assert.equal(mine.filter((e) => e.type === 'session_start').length, 1);
    assert.equal(mine.filter((e) => e.type === 'level_fail').length, 0, 'the "left" fail was stored');
    assert.equal(mine.filter((e) => e.type === 'level_abandon').length, 2);
  });
  const leaveSession = (await query(port, 'sessions')).sessions.find((s) => s.session_id === leaveSid);
  check('leave: the server reads the session as one that left arena-1, not a rage quit', () => {
    assert.ok(leaveSession, `no session ${leaveSid}`);
    assert.deepEqual(leaveSession.abandoned, ['arena-1']);
    assert.equal(leaveSession.rage_quit, false);
  });

  // 2e. the genre additions
  console.log('2e. properties, groups, counts, zones and a dropped connection…');
  const beforeGenre = batches.length;
  const genre = await play(exe, ['-autoplay', '-glitchless-test-genre', intake], 'genre');
  checkGenre(check, events(batches.slice(beforeGenre)), genre.stdout);

  // 3. measure
  console.log('3. measure…');
  fs.mkdirSync(outDir, { recursive: true });
  const measureOut = path.join(outDir, 'glitchless-measure.json');
  fs.rmSync(measureOut, { force: true });
  const m3 = await play(exe, ['-glitchless-off', '-glitchless-warmup=1', '-glitchless-measure=5', `-glitchless-out=${measureOut}`], 'measure');
  const printed = checkMeasureLine(check, m3.stdout);
  check('measure: writes the same JSON to -glitchless-out', () => {
    assert.ok(fs.existsSync(measureOut), `nothing written to ${measureOut}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(measureOut, 'utf8')).glitchless_measure.frames, printed?.frames);
  });

  // What the server made of it.
  await new Promise((r) => setTimeout(r, 300));
  const { sessions } = await query(port, 'sessions');
  check('the server has the sessions, with the Unreal device', () => {
    // An anonymous crash arrives as a short session of its own, with no session_start: nothing on disk may tie it to the one it ended.
    const started = sessions.filter((s) => s.browser);
    assert.ok(started.length >= 4, `${started.length} sessions with a start`);
    for (const s of started) assert.match(s.browser, /^Unreal 5\./);
  });
  const { issues } = await query(port, 'errors');
  check('the server groups the errors', () => {
    for (const kind of ['log_error', 'ensure', 'script', 'crash']) assert.ok(issues.some((i) => i.kind === kind), `no ${kind} issue: ${JSON.stringify(issues.map((i) => i.kind))}`);
    assert.ok(issues.find((i) => i.kind === 'ensure').sessions >= 2, 'the ensure should be one issue across both runs');
  });
  const { reports } = await query(port, 'reports');
  check('the server keeps the bug reports, with their screenshots', () => {
    const planted = reports.filter((r) => /Planted bug report|Door stuck/.test(r.note));
    assert.ok(planted.length >= 2, JSON.stringify(reports.map((r) => r.note)));
    assert.ok(planted.every((r) => r.has_screenshot), 'a report lost its screenshot');
  });
  const one = reports.length ? (await query(port, 'report', { id: reports[0].id })).report : null;
  check('a report reads back with its screenshot, recent events and frames', () => {
    assert.match(one?.screenshot || '', /^data:image\/jpeg;base64,/);
    assert.ok(one.recent.length > 0 && one.frames.length > 0, 'no recent events or frames');
    assert.equal(one.sdk, SDK);
  });
  const perf = await query(port, 'performance');
  check('the server reads the frame times', () => assert.ok(perf.distribution && JSON.stringify(perf).includes('Template_Default'), 'no performance for the level'));
  check('every batch carries a batch_id, and the server stored no event twice over all the runs', () => {
    for (const b of batches) assert.match(b.json?.batch_id || '', BATCH_ID);
    const seen = new Set();
    for (const e of stored(path.join(tmp, 'data'))) {
      const key = JSON.stringify({ ...e, received: 0 });
      assert.ok(!seen.has(key), `stored twice: ${e.type} ${e.ts} in ${e.session_id}`);
      seen.add(key);
    }
    assert.ok(seen.size > 0, 'nothing stored');
  });
} catch (err) {
  results.push(['FAIL', 'run', err.message]);
} finally {
  server?.kill();
  recorder?.close();
  fs.writeFileSync(path.join(tmp, 'batches.json'), JSON.stringify(batches)); // everything the plugin sent, for a look
}

finish(PLATFORM, tmp);
