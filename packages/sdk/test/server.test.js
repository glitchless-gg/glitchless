// The Node server SDK (glitchless/server; SPEC §1, §2 server_window; design A9): what a game server sends, the
// /v1/health check that keeps it off servers that would file it among players, sessions cut per match and every
// 6 hours, matches hosted side by side, crashes sent as the process dies, and the Socket.IO and Colyseus helpers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeIntake, settle } from './fake-intake.js';

const { GlitchlessServer, instrumentSocketIO, glitchlessRoom } = await import('../src/server.js');
const { hashGroupId } = await import('../src/groups.js');
const { SDK_VERSION } = await import('../src/core.js');

const SERVER_JS = fileURLToPath(new URL('../src/server.js', import.meta.url));
const intakes = [];
after(() => Promise.all(intakes.map((i) => i.close())));
async function intake(opts) {
  const i = await fakeIntake(opts);
  intakes.push(i);
  return i;
}
function server(opts = {}) {
  return new GlitchlessServer({ service: 'zoomies', version: '2.1.0', tickHz: 30, timers: false, crashes: false, crashDir: null, ...opts });
}
const of = (list, type) => list.filter((e) => e.type === type);

test('the session starts with the server: tick rate, players, build, region and the host in plain numbers, never its address', () => {
  const s = server({ maxPlayers: 100, region: 'eu-west', sessionType: 'synthetic' });
  const [start] = s.queue;
  assert.equal(start.type, 'session_start');
  assert.deepEqual([start.session_type, start.privacy, start.engine.name], ['synthetic', 'anonymous', 'node']);
  assert.deepEqual(Object.keys(start.server).sort(), ['build', 'host', 'max_players', 'region', 'tick_hz']);
  assert.deepEqual([start.server.tick_hz, start.server.max_players, start.server.build, start.server.region], [30, 100, 'dedicated', 'eu-west']);
  assert.deepEqual(Object.keys(start.server.host).sort(), ['cores', 'memory_gb', 'os']);
  assert.ok(!JSON.stringify(start).includes(os.hostname()), 'no host name');
});

test('a server_window says how its ticks went against the target rate, with players, pings, CPU, memory and gauges', () => {
  const s = server();
  for (let i = 0; i < 140; i++) s.tick(10 + (i % 10));
  s.tick(52); // over the 33.3 ms budget of 30 Hz
  s.tick(40);
  s.setPlayers(64);
  s.setPlayers(58);
  for (const ms of [30, 40, 50, 60, 200]) s.playerPing(ms);
  s.setContext({ net_objects: 1200, in_kbps: 800, out_kbps: 2400, rooms: 3 });
  s.win.startedAt -= 5000;
  s.closeWindow();
  const w = of(s.queue, 'server_window')[0];
  assert.deepEqual(Object.keys(w).sort(), ['cpu_pct', 'ctx', 'duration_s', 'in_kbps', 'late', 'level', 'mem_mb', 'net_objects', 'out_kbps', 'players', 'players_max', 'rtt_p95', 'tick', 'tick_hz', 'tick_max', 'tick_p50', 'tick_p95', 'ticks', 'ts', 'type']);
  assert.equal(w.ticks, 142);
  assert.ok(Math.abs(w.tick_hz - 28.4) < 0.5, `tick_hz ${w.tick_hz}`);
  assert.equal(w.late, 2);
  assert.equal(w.tick.a, 0.02);
  assert.equal(w.tick.n, 142);
  assert.ok(w.tick_p50 >= 13 && w.tick_p50 <= 16, `p50 ${w.tick_p50}`);
  assert.equal(w.tick_max, 52);
  assert.deepEqual([w.players, w.players_max], [58, 64]);
  assert.ok(Math.abs(w.rtt_p95 - 60) <= 3, `rtt_p95 ${w.rtt_p95}: the 4th of 5 pings, within the sketch's 5%`);
  assert.deepEqual([w.net_objects, w.in_kbps, w.out_kbps, w.ctx], [1200, 800, 2400, { rooms: 3 }]);
  assert.ok(w.mem_mb > 0 && w.cpu_pct >= 0);
  s.closeWindow();
  const idle = of(s.queue, 'server_window')[1];
  assert.deepEqual([idle.ticks, idle.tick_p95, idle.players, idle.players_max], [0, null, 58, 58], 'a window without ticks still goes');
});

test('measureTick times a tick, an async tick until it settles, and a tick that throws', async () => {
  const s = server({ tickHz: null });
  const sync = s.measureTick((x) => x * 2);
  assert.equal(sync(21), 42);
  const slow = s.measureTick(() => new Promise((r) => setTimeout(r, 30)));
  await slow();
  const bad = s.measureTick(() => {
    throw new Error('boom');
  });
  assert.throws(() => bad(), /boom/);
  assert.equal(s.win.ticks, 3);
  assert.ok(s.win.max >= 25, 'the async tick counted its wait');
  s.closeWindow();
  assert.equal(of(s.queue, 'server_window')[0].late, null, 'no target rate, no late ticks');
});

test('batches go as role "server" under the game\'s own service, with no player ID, gzipped as text/plain', async () => {
  const fake = await intake();
  const s = server({ intake: fake.url, clientToken: 'gl_pub_zoomies' });
  s.track('match_ready', { mode: 'squads' });
  s.closeWindow();
  await s.flush();
  assert.equal(fake.batches.length, 1);
  const { body, token, contentType } = fake.batches[0];
  assert.deepEqual(Object.keys(body).sort(), ['batch_id', 'env', 'events', 'player_id', 'role', 'sdk', 'service', 'session_id', 'version']);
  assert.deepEqual([body.role, body.player_id, body.service, body.sdk, token, contentType], ['server', null, 'zoomies', `glitchless-node/${SDK_VERSION}`, 'gl_pub_zoomies', 'text/plain']);
  assert.match(body.batch_id, /^b_[a-z0-9]{16}$/);
  assert.match(body.session_id, /^s_[a-z0-9]{16}$/);
  assert.deepEqual(body.events.map((e) => e.type), ['session_start', 'custom', 'server_window']);
});

test('nothing goes to a server whose /v1/health has no server_mode, and it says so once', async () => {
  const fake = await intake({ features: ['counts'] });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const s = server({ intake: fake.url });
    s.track('x');
    await s.flush();
    s.track('y');
    s.closeWindow();
    await s.flush();
    assert.equal(fake.batches.length, 0);
    assert.equal(s.disabled, true);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /doesn't read server sessions/);
});

test("until /v1/health answers everything waits; then it goes, counters only when the server reads them", async () => {
  const fake = await intake({ features: ['server_mode'], health: false });
  const s = server({ intake: fake.url });
  s.count('tick_spent', { phase: 'physics' }, 3);
  s.closeWindow();
  await s.flush();
  assert.equal(fake.batches.length, 0, 'held');
  fake.health = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await s.flush();
  } finally {
    console.warn = warn;
  }
  const types = fake.events().map((e) => e.type);
  assert.deepEqual(types, ['session_start', 'server_window'], 'counts left out: this server has no "counts"');
});

test('sessionPerMatch makes each match a session of its own; batches keep each session apart', async () => {
  const fake = await intake();
  const s = server({ intake: fake.url, sessionPerMatch: true });
  const first = s.sessionId;
  const id = s.setGroup('match', 'match-0001', { mode: 'squads' });
  assert.equal(id, hashGroupId('zoomies', 'match-0001'));
  s.levelStart('island', { mode: 'squads' });
  s.tick(12);
  s.setGroup('match', null);
  const second = s.sessionId;
  assert.notEqual(second, first);
  s.setGroup('match', 'match-0002');
  await s.flush();
  const bySession = {};
  for (const e of fake.events()) (bySession[e._batch.session_id] ??= []).push(e.type);
  assert.deepEqual(bySession[first], ['session_start', 'group', 'level_start', 'server_window', 'group', 'session_end']);
  assert.deepEqual(bySession[second], ['session_start', 'group']);
  const end = fake.events().find((e) => e.type === 'session_end');
  assert.equal(end.reason, 'match_end');
  const levelStart = fake.events().find((e) => e.type === 'level_start');
  assert.deepEqual([levelStart.level, levelStart.match, levelStart.attrs], ['island', id, { mode: 'squads' }]);
});

test('a server session is cut every 6 hours, and its groups carry over', () => {
  const s = server();
  s.setGroup('party', 'party-0001');
  const first = s.sessionId;
  s.startedAt -= 6 * 3600_000;
  s.lastFlushAt = Date.now(); // no send in this window: the sessions stay in the queue to look at
  s.onWindow();
  assert.notEqual(s.sessionId, first);
  assert.equal(s.sealed[0].events.at(-1).reason, 'max_duration');
  assert.deepEqual(s.queue.map((e) => [e.type, e.kind ?? null, e.id ?? null]), [['session_start', null, null], ['group', 'party', hashGroupId('zoomies', 'party-0001')]]);
});

test('matches hosted side by side each stamp their own events and counters, and end by name', () => {
  const s = server();
  const a = s.match('room-aaaa1111', { room: 'battle' });
  const b = s.match('room-bbbb2222');
  a.levelStart('arena');
  a.track('kill', { weapon: 'bow' });
  b.track('kill', { weapon: 'axe' });
  a.count('hit', {}, 3);
  b.count('hit', {}, 5);
  a.error(new Error('desync at tick 4411'));
  a.end();
  a.track('after_end');
  s.closeWindow();
  const idA = hashGroupId('zoomies', 'room-aaaa1111');
  const idB = hashGroupId('zoomies', 'room-bbbb2222');
  const kills = of(s.queue, 'custom');
  assert.deepEqual(kills.map((e) => [e.match, e.attrs.weapon, e.level]), [[idA, 'bow', 'arena'], [idB, 'axe', null]]);
  const groups = of(s.queue, 'group');
  assert.deepEqual(groups.map((g) => [g.id, g.ended ?? null, g.attrs ?? null]), [[idA, null, { room: 'battle' }], [idB, null, null], [null, idA, null]]);
  assert.deepEqual(of(s.queue, 'counts').map((c) => [c.match, c.counts[0].n]), [[idA, 3], [idB, 5]]);
  assert.deepEqual([of(s.queue, 'error')[0].match, of(s.queue, 'error')[0].level], [idA, 'arena']);
  assert.equal(s.counters.has(idA), false, 'an ended match lets its counter go');
  assert.equal(s.match('bad id!').id, null, 'a bad ID gives a handle that sends nothing');
});

test('error text loses query strings and the password in a connection string', () => {
  const s = server();
  s.error(new Error('connect ECONNREFUSED postgres://game:hunter2@db.internal:5432/zoomies?sslmode=require'));
  const e = of(s.queue, 'error')[0];
  assert.equal(e.message, 'Error: connect ECONNREFUSED postgres://db.internal:5432/zoomies');
  assert.equal(e.kind, 'manual');
  assert.match(e.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(!e.stack.includes('hunter2'));
});

// Runs a small game server in a child process, against the fake intake.
function runChild(code, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('an uncaught error still ends the process, and the crash, the session end and what was queued reach the intake', async () => {
  const fake = await intake();
  const { code, stderr } = await runChild(`
    import { GlitchlessServer } from ${JSON.stringify(SERVER_JS)};
    const s = new GlitchlessServer({ service: 'zoomies', intake: process.env.INTAKE, crashDir: null });
    await s.checkFeatures();
    s.track('match_ready');
    setTimeout(function explode() { null.players.length; }, 10);
  `, { INTAKE: fake.url });
  assert.equal(code, 1, 'it dies as it would without Glitchless');
  assert.match(stderr, /TypeError/);
  const events = fake.events();
  assert.deepEqual(events.map((e) => e.type), ['session_start', 'custom', 'error', 'server_window', 'session_end']);
  const crash = events.find((e) => e.type === 'error');
  assert.deepEqual([crash.kind, crash.fn, crash.attrs], ['crash', 'Timeout.explode [as _onTimeout]', { origin: 'uncaughtException' }]);
  assert.equal(events.at(-1).reason, 'crash');
});

test('a game that handles uncaughtException keeps going, and the error is an exception, not a crash', async () => {
  const fake = await intake();
  const { code } = await runChild(`
    import { GlitchlessServer } from ${JSON.stringify(SERVER_JS)};
    const s = new GlitchlessServer({ service: 'zoomies', intake: process.env.INTAKE, crashDir: null });
    process.on('uncaughtException', () => {});
    setTimeout(() => { throw new Error('room 7 lost its state'); }, 5);
    setTimeout(async () => { await s.close(); process.exit(0); }, 50);
  `, { INTAKE: fake.url });
  assert.equal(code, 0);
  const events = fake.events();
  assert.equal(events.find((e) => e.type === 'error').kind, 'exception');
  assert.equal(events.at(-1).reason, 'shutdown');
});

test('a crash before /v1/health answered waits in crashDir, and the next start sends it', async () => {
  const fake = await intake();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-test-'));
  const { code } = await runChild(`
    import { GlitchlessServer } from ${JSON.stringify(SERVER_JS)};
    new GlitchlessServer({ service: 'zoomies', intake: 'http://127.0.0.1:9', crashDir: process.env.DIR });
    throw new Error('died at boot');
  `, { DIR: dir });
  assert.equal(code, 1);
  assert.equal(fs.readdirSync(dir).length, 1);
  const s = server({ intake: fake.url, crashDir: dir });
  await s.checkFeatures();
  await s.sendPending();
  assert.deepEqual(fake.events().map((e) => [e.type, e.kind ?? e.reason ?? null]), [['session_start', null], ['error', 'crash'], ['server_window', null], ['session_end', 'crash']]);
  assert.equal(fs.readdirSync(dir).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('instrumentSocketIO: players, how they leave, and round trips from Engine.IO\'s heartbeat', async () => {
  const s = server();
  const io = new EventEmitter();
  io.engine = { clientsCount: 0 };
  instrumentSocketIO(s, io);
  const socket = () => Object.assign(new EventEmitter(), { conn: new EventEmitter() });
  const a = socket();
  const b = socket();
  io.engine.clientsCount = 1;
  io.emit('connection', a);
  io.engine.clientsCount = 2;
  io.emit('connection', b);
  a.conn.emit('packetCreate', { type: 'ping' });
  await settle(20);
  a.conn.emit('packet', { type: 'pong' });
  b.conn.emit('packet', { type: 'pong' }); // no ping of ours before it: not a round trip
  io.engine.clientsCount = 1;
  a.emit('disconnect', 'ping timeout');
  b.emit('disconnect', 'client namespace disconnect');
  await settle(5);
  assert.equal(s.win.rtt.n, 1);
  assert.ok(s.win.rtt.max >= 15);
  assert.equal(s.win.playersMax, 2);
  s.closeWindow();
  const left = of(s.queue, 'counts')[0].counts;
  assert.deepEqual(left.map((c) => [c.name, c.attrs.reason, c.n]), [['player_left', 'timeout', 1], ['player_left', 'left', 1]]);
});

test('glitchlessRoom: each Colyseus room is a match, its simulation interval the tick, its clients the players', async () => {
  const s = server();
  class Room {
    constructor(id) {
      this.roomId = id;
      this.roomName = 'battle';
      this.clients = [];
    }
    setSimulationInterval(cb) {
      this.sim = cb;
    }
  }
  class Battle extends Room {
    onCreate() {
      this.setSimulationInterval(() => (this.steps = (this.steps ?? 0) + 1));
    }
    onJoin(client) {
      if (client === 'banned') throw new Error('not allowed');
    }
  }
  const Measured = glitchlessRoom(s, Battle);
  assert.equal(Measured.prototype.onUncaughtException, undefined, 'not added where the room has none');
  const r1 = new Measured('aaaa1111');
  const r2 = new Measured('bbbb2222');
  r1.onCreate();
  r2.onCreate();
  r1.sim();
  r1.sim();
  assert.equal(r1.steps, 2);
  await r1.onJoin('p1');
  await r1.onJoin('p2');
  await r2.onJoin('p3');
  await assert.rejects(r2.onJoin('banned'));
  assert.equal(s.players, 3, 'a refused join is not a player');
  r1.onLeave('p1');
  r2.onDispose();
  assert.equal(s.players, 1);
  s.closeWindow();
  assert.equal(of(s.queue, 'server_window')[0].ticks, 2);
  const groups = of(s.queue, 'group');
  assert.deepEqual(groups.map((g) => [g.id, g.ended ?? null, g.attrs?.room ?? null]), [
    [hashGroupId('zoomies', 'aaaa1111'), null, 'battle'],
    [hashGroupId('zoomies', 'bbbb2222'), null, 'battle'],
    [null, hashGroupId('zoomies', 'bbbb2222'), null],
  ]);

  const seen = [];
  class Careful extends Room {
    onUncaughtException(error, method) {
      seen.push([error.message, method]);
    }
  }
  const room = new (glitchlessRoom(s, Careful))('cccc3333');
  room.onCreate();
  room.onUncaughtException(new Error('bad message'), 'onMessage');
  assert.deepEqual(seen, [['bad message', 'onMessage']], "the room's own handler still runs");
  const err = of(s.queue, 'error').at(-1);
  assert.deepEqual([err.match, err.attrs], [hashGroupId('zoomies', 'cccc3333'), { method: 'onMessage' }]);
});
