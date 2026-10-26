// Plays small multiplayer matches on Unreal's own replication, with the plugin on every side, against a fresh local
// Glitchless server behind the recorder (whose health answer lists the features a newer server has), and checks what
// each side sent (docs/design/genre-coverage.md A7 to A9):
//
//   1. dedicated  a dedicated server and a client that joins it. The server quits first, so the client's connection
//                 goes: ping and loss on the client's frame windows, a disconnect, and the server's own session
//                 (role "server", server windows with its ticks, players and their pings), one hashed match on both
//   2. listen     a listen server (a map opened with ?listen) and a client: the host's player session with net.host,
//                 and its own server session (build "listen") with both players
//   3. crash      a dedicated server that crashes: the crash waits in its own outbox, and its next start sends it
//
// The editor binary runs every side (-server for the dedicated server, -game for the rest): a launcher install of
// Unreal can't build a Server target, and the game's code is the same. Win64 and Linux servers are checked elsewhere.
//
//   node unreal/test/mp.mjs               build the editor target, then play
//   node unreal/test/mp.mjs --no-build    play with the last build
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PROJECT, ROOT, SDK, SERVICE, UE_ROOT, WINDOWS, checker, events, freePort, hashed, requireEngine, startRecorder, startServer } from './harness.mjs';

const EDITOR = path.join(UE_ROOT, WINDOWS ? 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe' : 'Engine/Binaries/Mac/UnrealEditor-Cmd');
const SAVED = path.join(ROOT, 'unreal/test/GlitchlessTest/Saved/Glitchless');
const MAP = '/Engine/Maps/Templates/Template_Default';
const MATCH = hashed('mp-match-0001');
const build = !process.argv.includes('--no-build');
const { check, finish, results } = checker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-mp-'));

requireEngine();

function buildEditor() {
  const script = path.join(UE_ROOT, 'Engine/Build/BatchFiles', WINDOWS ? 'Build.bat' : 'Mac/Build.sh');
  const log = path.join(tmp, 'build.log');
  console.log(`building the editor target (log: ${log})…`);
  const args = ['GlitchlessTestEditor', WINDOWS ? 'Win64' : 'Mac', 'Development', `-Project=${PROJECT}`, '-WaitMutex'];
  // Windows runs a .bat only through cmd, as one command line with its paths quoted (C:\Program Files\…).
  const opts = { encoding: 'utf8', maxBuffer: 1 << 28 };
  const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
  const r = WINDOWS ? spawnSync([script, ...args].map(q).join(' '), { ...opts, shell: true }) : spawnSync(script, args, opts);
  fs.writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) throw new Error(`the editor target didn't build (log: ${log})`);
}

// One side of a match. Crash reports stay on this machine: a dedicated server is unattended, and Unreal sends an
// unattended crash to Epic unless told not to.
// A game with no renderer runs as fast as it can, so the players are held to 60 frames a second; a dedicated server
// keeps its own cap (NetServerMaxTickRate, 30).
function launch(label, args, timeout = 240_000) {
  const all = [PROJECT, ...args, '-nullrhi', '-unattended', '-nosplash', '-nosound', '-stdout', '-FullStdOutLogOutput', '-ini:EditorSettings:[/Script/UnrealEd.CrashReportsPrivacySettings]:bSendUnattendedBugReports=False'];
  if (!args.includes('-server')) all.push('-ExecCmds=t.MaxFPS 60');
  const child = spawn(EDITOR, all, { stdio: ['ignore', 'pipe', 'pipe'] });
  const side = { label, out: '', child, exited: null };
  child.stdout.on('data', (d) => (side.out += d));
  child.stderr.on('data', (d) => (side.out += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  side.done = new Promise((resolve) => {
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      side.exited = { status, signal };
      fs.writeFileSync(path.join(tmp, `${label}.log`), side.out);
      resolve(side.exited);
    });
  });
  return side;
}

async function until(side, pattern, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pattern.test(side.out)) return;
    if (side.exited) throw new Error(`${side.label} exited (${JSON.stringify(side.exited)}) before ${pattern} (log: ${path.join(tmp, `${side.label}.log`)})`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${side.label}: no ${pattern} within ${ms / 1000} s`);
}

// The batches one run sent, split by role: a server's carry role "server".
function split(batches) {
  const server = batches.filter((b) => b.json?.role === 'server');
  const player = batches.filter((b) => b.json && b.json.role !== 'server');
  return { server, player, serverEvents: events(server), playerEvents: events(player) };
}

const port = await freePort();
const recorderPort = await freePort();
const batches = [];
let server;
let recorder;
try {
  if (build) buildEditor();
  fs.rmSync(SAVED, { recursive: true, force: true });
  server = await startServer(port, path.join(tmp, 'data'));
  recorder = await startRecorder(recorderPort, port, batches);
  const intake = `-glitchless-intake=http://127.0.0.1:${recorderPort}`;

  // 1. a dedicated server and a client
  console.log('1. a dedicated server and a client…');
  const gamePort = await freePort();
  const dedicated = launch('dedicated', [MAP, '-server', `-port=${gamePort}`, '-glitchless-test-mp', '-glitchless-test-quit=12', '-glitchless-region=local-test', intake]);
  await until(dedicated, /IpNetDriver listening on port/);
  const client = launch('client', [`127.0.0.1:${gamePort}`, '-game', '-glitchless-test-mp', '-glitchless-test-quit=12', intake]);
  await Promise.all([dedicated.done, client.done]);
  await new Promise((r) => setTimeout(r, 500));
  const one = split(batches);
  check('dedicated: the server sends its own session, with no player, as the game\'s server', () => {
    assert.ok(one.server.length > 0, `no server batches (log: ${tmp}/dedicated.log)`);
    for (const b of one.server) {
      assert.equal(b.json.service, SERVICE, 'the game\'s own service: intake files it under <service>.server');
      assert.equal(b.json.player_id, null);
      assert.equal(b.json.sdk, SDK);
    }
    const start = one.serverEvents.find((e) => e.type === 'session_start');
    assert.equal(start?.session_type, 'user');
    assert.equal(start.server.build, 'dedicated');
    assert.equal(start.server.tick_hz, 30);
    assert.equal(start.server.region, 'local-test');
    assert.ok(start.server.host.cores > 0 && start.server.host.memory_gb > 0 && typeof start.server.host.os === 'string', JSON.stringify(start.server));
    assert.deepEqual(Object.keys(start.device).sort(), ['browser', 'browser_version', 'os']);
    for (const t of ['frame_window', 'hitch', 'load']) assert.ok(!one.serverEvents.some((e) => e.type === t), `a server sent ${t}`);
    assert.equal(one.serverEvents.find((e) => e.type === 'session_end')?.reason, 'quit');
  });
  check('dedicated: server windows carry its ticks against 30 Hz, its players, their pings, CPU and memory', () => {
    const windows = one.serverEvents.filter((e) => e.type === 'server_window');
    assert.ok(windows.length >= 2, `${windows.length} server windows`);
    for (const w of windows) {
      assert.ok(w.ticks > 0 && w.tick.n === w.ticks, `ticks ${w.ticks}`);
      assert.ok(w.tick_hz > 20 && w.tick_hz < 35, `tick_hz ${w.tick_hz}`);
      for (const k of ['tick_p50', 'tick_p95', 'tick_max', 'late', 'cpu_pct', 'mem_mb']) assert.equal(typeof w[k], 'number', k);
      assert.ok(w.tick_p50 < 8, `tick_p50 ${w.tick_p50}: the sleep that holds the server to 30 Hz counted as work`);
      assert.equal(w.level, 'Template_Default');
    }
    const busy = windows.find((w) => w.players >= 1);
    assert.ok(busy, `no window with a player: ${JSON.stringify(windows.map((w) => w.players))}`);
    assert.equal(typeof busy.rtt_p95, 'number');
    assert.ok(busy.in_kbps > 0 && busy.out_kbps > 0, `traffic ${busy.in_kbps} in, ${busy.out_kbps} out`);
    assert.equal(busy.match, MATCH);
    assert.ok(windows.some((w) => typeof w.net_objects === 'number' && w.net_objects > 0), 'no replicated objects counted');
  });
  check('dedicated: the server\'s match, counts and events are its own', () => {
    assert.equal(one.serverEvents.find((e) => e.type === 'group' && e.kind === 'match')?.id, MATCH);
    assert.ok(one.serverEvents.some((e) => e.type === 'custom' && e.name === 'match_hosted' && e.match === MATCH));
    const hits = one.serverEvents.filter((e) => e.type === 'counts').flatMap((e) => e.counts).filter((c) => c.name === 'replicated_hit');
    // 4 a call, with 23 damage a call: sums add each call's numbers as given.
    assert.ok(hits.length > 0 && hits.every((c) => c.n % 4 === 0 && c.sums?.damage === (c.n / 4) * 23), JSON.stringify(hits));
  });
  check('dedicated: the client\'s windows carry its connection, and its match is the server\'s', () => {
    const windows = one.playerEvents.filter((e) => e.type === 'frame_window');
    const connected = windows.filter((w) => w.net?.samples > 0);
    assert.ok(connected.length > 0, `no window with net (log: ${tmp}/client.log)`);
    for (const w of connected) {
      assert.equal(w.net.transport, 'unreal');
      assert.equal(w.net.host, false);
      assert.equal(w.net.rtt.a, 0.05);
      for (const k of ['rtt_p50', 'rtt_p95', 'loss_pct', 'jitter_ms', 'in_kbps', 'out_kbps']) assert.equal(typeof w.net[k], 'number', `${k}: ${JSON.stringify(w.net)}`);
    }
    assert.equal(one.playerEvents.find((e) => e.type === 'group' && e.kind === 'match')?.id, MATCH, 'one match, hashed alike on both sides');
    assert.ok(connected.some((w) => w.match === MATCH));
    assert.ok(!one.player.some((b) => b.json.role), 'a player batch with a role');
  });
  check('dedicated: the client sees the server go: a disconnect, and no net once it is gone', () => {
    const lost = one.playerEvents.filter((e) => e.type === 'disconnect');
    assert.equal(lost.length, 1, JSON.stringify(lost));
    assert.equal(lost[0].reason, 'server_closed', 'the server shut down: it closed the connection');
    assert.ok(lost[0].connected_s > 0);
    const after = one.playerEvents.filter((e) => e.type === 'frame_window' && e.ts > lost[0].ts + 2000);
    assert.ok(after.length > 0 && after.every((w) => !w.net), 'net after the connection went');
  });

  // 2. a listen server and a client
  console.log('2. a listen server and a client…');
  const beforeListen = batches.length;
  const listenPort = await freePort();
  const host = launch('listen', [`${MAP}?listen`, '-game', `-port=${listenPort}`, '-glitchless-test-mp', '-glitchless-test-quit=12', intake]);
  await until(host, /IpNetDriver listening on port/);
  const guest = launch('guest', [`127.0.0.1:${listenPort}`, '-game', '-glitchless-test-mp', '-glitchless-test-quit=12', intake]);
  await Promise.all([host.done, guest.done]);
  await new Promise((r) => setTimeout(r, 500));
  const two = split(batches.slice(beforeListen));
  const hostSid = two.playerEvents.find((e) => e.type === 'frame_window' && e.net?.host)?._sid;
  check('listen: the host is a player, with net.host and no round trip of its own', () => {
    assert.ok(hostSid, `no host window (log: ${tmp}/listen.log)`);
    const hosted = two.playerEvents.filter((e) => e._sid === hostSid && e.type === 'frame_window' && e.net);
    assert.ok(hosted.every((w) => w.net.host && (w.net.rtt_p95 === null || w.net.rtt_p95 === 0)), JSON.stringify(hosted.map((w) => w.net)));
  });
  check('listen: and the host has a server session of its own, with both players', () => {
    const start = two.serverEvents.find((e) => e.type === 'session_start');
    assert.equal(start?.server?.build, 'listen');
    assert.equal(start.server.tick_hz, 60, 'a listen server ticks with its host\'s frames, here held to 60');
    const windows = two.serverEvents.filter((e) => e.type === 'server_window');
    assert.ok(windows.some((w) => w.players >= 2), JSON.stringify(windows.map((w) => w.players)));
    assert.ok(windows.every((w) => w.ticks > 0));
    // An empty map's tick is quick: the wait for the frame cap is not work. The first window holds the host loading
    // the map (on a cold Windows box, shader compiles too), so only the windows after it are held to that.
    assert.ok(windows.slice(1).every((w) => w.tick_p50 < 8), JSON.stringify(windows.map((w) => [w.tick_p50, w.late])));
    assert.equal(two.serverEvents.find((e) => e.type === 'group' && e.kind === 'match')?.id, MATCH);
    assert.ok(!two.serverEvents.some((e) => e.type === 'custom'), 'the host\'s own events went to the server session too');
  });
  check('listen: the guest\'s match is the host\'s, and it sees the host go', () => {
    const guestEvents = two.playerEvents.filter((e) => e._sid !== hostSid);
    assert.equal(guestEvents.find((e) => e.type === 'group' && e.kind === 'match')?.id, MATCH);
    assert.ok(guestEvents.some((e) => e.type === 'frame_window' && e.net?.samples > 0 && !e.net.host), 'no guest window with net');
    assert.equal(guestEvents.filter((e) => e.type === 'disconnect').length, 1);
  });

  // 3. a dedicated server that crashes, and its next start
  console.log('3. a server crash, then the start that sends it…');
  const crashPort = await freePort();
  const crashed = launch('server-crash', [MAP, '-server', `-port=${crashPort}`, '-glitchless-test-mp', '-glitchless-test-crash', intake]);
  await crashed.done;
  const outbox = path.join(SAVED, 'Server/outbox.json');
  const saved = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
  check('crash: the server\'s crash waits in its own outbox, apart from a player\'s', () => {
    assert.ok(crashed.exited.status !== 0 || crashed.exited.signal, `exited with ${JSON.stringify(crashed.exited)}`);
    assert.ok(saved.includes('"kind":"crash"'), `no crash in ${outbox}`);
    assert.ok(saved.includes('"reason":"crash"'), 'no session end');
  });
  const beforeNext = batches.length;
  const next = launch('server-next', [MAP, '-server', `-port=${await freePort()}`, '-glitchless-test-mp', '-glitchless-test-solo', '-glitchless-test-quit=4', intake]);
  await next.done;
  check('crash: the next start sends it as a server\'s crash', () => {
    const sent = batches.slice(beforeNext).filter((b) => b.json?.role === 'server');
    const crash = events(sent).find((e) => e.type === 'error' && e.kind === 'crash');
    assert.ok(crash, 'no crash arrived');
    assert.match(crash.fn || crash.stack || '', /StepMultiplayer|GlitchlessTestScript/);
  });
} catch (err) {
  results.push(['FAIL', 'run', err.message]);
} finally {
  server?.kill();
  recorder?.close();
  fs.writeFileSync(path.join(tmp, 'batches.json'), JSON.stringify(batches));
}

finish(WINDOWS ? 'Win64' : 'Mac', tmp);
