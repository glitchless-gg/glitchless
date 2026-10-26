// A small multiplayer game end to end: a Node `ws` game server with glitchless/server, and two headless players on
// the browser SDK, connected over real WebSockets, sending to a stand-in intake. Every payload is checked against the
// wire format of the genre additions (docs/design/genre-coverage.md A5-A9; SPEC §2): counters, properties, groups,
// level attributes, zones, network windows, a disconnect, and the server's own windows. Then every batch goes through
// today's intake (server/src/ingest.js) to check an older server keeps what it reads and the new fields in it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { fakeIntake, settle } from './fake-intake.js';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5185', pathname: '/' };

const { Glitchless } = await import('../src/core.js');
const { GlitchlessServer, instrumentWs } = await import('../src/server.js');
const { hashGroupId, GROUP_KINDS } = await import('../src/groups.js');
const { DISCONNECT_REASONS } = await import('../src/net.js');
const { parsePayload, normalize } = await import('../../../server/src/ingest.js');
const { createApp } = await import('../../../server/src/app.js');
const { FileStore } = await import('../../../server/src/stores/file.js');

const SERVICE = 'arena-duel';
// A real Glitchless server behind the stand-in, which passes every batch on to it: the match must show on its match page.
// GLITCHLESS_FORWARD=<url> sends them to a server of your own instead (a dashboard to look at the match in).
const real = process.env.GLITCHLESS_FORWARD ? null : await realServer();
const forward = process.env.GLITCHLESS_FORWARD || real.url;
const intake = await fakeIntake({ forward });
after(async () => {
  await intake.close();
  await real?.close();
});

async function realServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mp-'));
  const server = http.createServer(createApp({ store: new FileStore(dir), logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r), fs.rmSync(dir, { recursive: true, force: true }))),
  };
}

// ───────────────────────────── the game ─────────────────────────────

// The game server: pairs the first two players into a match it names, ticks at 20 Hz, echoes pings, and kicks the
// second player partway through.
function gameServer() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const server = new GlitchlessServer({ service: SERVICE, version: '1.4.0', intake: intake.url, tickHz: 20, maxPlayers: 2, region: 'eu-west', timers: false, crashes: false, crashDir: null });
  instrumentWs(server, wss, { pingMs: 40 });
  const players = [];
  const matchId = 'match-' + Math.random().toString(36).slice(2, 10);
  let state = { tick: 0 };
  const update = () => {
    state = { tick: state.tick + 1, positions: players.map((_, i) => [i, Math.sin(state.tick + i)]) };
    for (const ws of players) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', tick: state.tick }));
  };
  const loop = setInterval(server.measureTick(update), 50);
  wss.on('connection', (ws) => {
    players.push(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    });
    if (players.length === 2) {
      server.setGroup('match', matchId, { mode: 'duel', players: 2 });
      server.levelStart('arena_7', { mode: 'duel' });
      for (const p of players) p.send(JSON.stringify({ type: 'start', match: matchId, map: 'arena_7' }));
    }
  });
  return {
    server,
    wss,
    matchId,
    url: () => `ws://127.0.0.1:${wss.address().port}`,
    kick: (i) => players[i].close(1008, 'kicked'),
    endMatch() {
      server.setGroup('match', null);
    },
    async close() {
      clearInterval(loop);
      await new Promise((r) => wss.close(r));
    },
  };
}

// A headless player: the browser SDK, driven by the test (no window, so no frame loop of its own), on Node's WebSocket.
function player(name, url) {
  const gd = new Glitchless({ service: SERVICE, version: '1.4.0', intake: intake.url, properties: { mode: 'duel', region: 'eu-west', input: 'keyboard' } });
  gd.startedAt -= 5000;
  gd.checkFeatures();
  const ws = new WebSocket(url);
  let clock = 1000;
  const p = { name, gd, ws, started: null, closed: null };
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'start') {
      gd.setGroup('match', msg.match, { mode: 'duel' });
      gd.levelStart(msg.map, { mode: 'duel', hero: name === 'p1' ? 'ember' : 'frost', loadout: ['bow', 'dash', 'shield'] });
      gd.setZone('north_bridge');
      p.started = msg;
    } else if (msg.type === 'pong') {
      gd.netSample({ rtt_ms: performance.now() - msg.t, loss_pct: 0, jitter_ms: 2, transport: 'ws' });
    } else if (msg.type === 'state') {
      for (let i = 0; i < 3; i++) gd.tick((clock += 16.7)); // frames drawn between server states
      gd.count('shot', { weapon: 'bow' });
      if (msg.tick % 3 === 0) gd.count('hit', { weapon: 'bow', damage: 12 });
    }
  });
  ws.addEventListener('close', (ev) => {
    p.closed = ev.code;
    if (!p.leaving) gd.disconnect({ reason: ev.code === 1008 ? 'kicked' : 'connection_lost' });
  });
  const pinger = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t: performance.now() })), 100);
  p.stop = () => clearInterval(pinger);
  return p;
}

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await settle(20);
  }
};

// ───────────────────────────── the wire format ─────────────────────────────

const ID = /^(h_[0-9a-f]{24}|r_[a-z0-9]{12})$/;
const STAMPS = ['zone', ...GROUP_KINDS];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => v === null || isNum(v);
const keys = (o) => Object.keys(o).sort();
const sketch = (s, a) => s && s.a === a && typeof s.b === 'object' && isNum(s.n) && isNum(s.z);

// The fields each new event has beyond type, ts, level and the stamps; frame_window.net and server_window are exact.
function checkEvent(e, role) {
  const where = `${role} ${e.type}`;
  assert.equal(typeof e.type, 'string', where);
  assert.ok(isNum(e.ts), `${where}: ts`);
  assert.ok(e.level === null || typeof e.level === 'string', `${where}: level`);
  if ('zone' in e) assert.equal(typeof e.zone, 'string', `${where}: zone`);
  for (const kind of GROUP_KINDS) if (kind in e) assert.match(e[kind], ID, `${where}: ${kind} is hashed or made by the SDK`);
  const own = keys(e).filter((k) => !['type', 'ts', 'level', ...STAMPS].includes(k));
  switch (e.type) {
    case 'session_start':
      if (role === 'player') assert.deepEqual(e.props, { mode: 'duel', region: 'eu-west', input: 'keyboard' });
      else assert.deepEqual(keys(e.server), ['build', 'host', 'max_players', 'region', 'tick_hz']);
      break;
    case 'props':
      assert.deepEqual(own, ['props']);
      break;
    case 'group':
      assert.ok(GROUP_KINDS.includes(e.kind), where);
      assert.ok(e.id === null || ID.test(e.id), `${where}: id`);
      for (const k of own) assert.ok(['kind', 'id', 'attrs', 'resumed', 'ended'].includes(k), `${where}: ${k}`);
      break;
    case 'level_start':
      for (const k of own) assert.ok(k === 'attrs', `${where}: ${k}`);
      break;
    case 'counts':
      assert.deepEqual(own, ['counts', 'dropped', 'duration_s']);
      assert.ok(isNum(e.dropped) && isNum(e.duration_s));
      for (const c of e.counts) {
        for (const k of keys(c)) assert.ok(['name', 'attrs', 'n', 'sums', 'first_ts'].includes(k), `${where}: ${k}`);
        assert.ok(typeof c.name === 'string' && c.n >= 1 && isNum(c.first_ts) && typeof c.attrs === 'object');
        for (const v of Object.values(c.attrs)) assert.ok(typeof v === 'string' || typeof v === 'boolean');
        for (const v of Object.values(c.sums ?? {})) assert.ok(isNum(v));
      }
      break;
    case 'frame_window':
      if (e.net) {
        assert.deepEqual(keys(e.net), ['host', 'in_kbps', 'jitter_ms', 'link', 'loss_pct', 'out_kbps', 'rtt', 'rtt_max', 'rtt_p50', 'rtt_p95', 'samples', 'transport']);
        if (e.net.samples) assert.ok(sketch(e.net.rtt, 0.05), `${where}: rtt sketch`);
        for (const k of ['rtt_p50', 'rtt_p95', 'rtt_max', 'jitter_ms', 'loss_pct', 'in_kbps', 'out_kbps']) assert.ok(numOrNull(e.net[k]), `${where}: ${k}`);
        assert.ok([null, 'wifi', 'cellular', 'wired'].includes(e.net.link));
      }
      break;
    case 'disconnect':
      assert.deepEqual(own, ['connected_s', 'loss_pct', 'reason', 'rtt_p95']);
      assert.ok(DISCONNECT_REASONS.has(e.reason), `${where}: ${e.reason}`);
      break;
    case 'reconnect':
      assert.deepEqual(own, ['after_s']);
      break;
    case 'server_window':
      assert.deepEqual(own, ['cpu_pct', 'ctx', 'duration_s', 'in_kbps', 'late', 'mem_mb', 'net_objects', 'out_kbps', 'players', 'players_max', 'rtt_p95', 'tick', 'tick_hz', 'tick_max', 'tick_p50', 'tick_p95', 'ticks']);
      assert.ok(sketch(e.tick, 0.02), `${where}: tick sketch`);
      break;
  }
}

// ───────────────────────────── the match ─────────────────────────────

test('two players and their server: every payload in the wire format, one match ID on all three sides', { timeout: 30_000 }, async () => {
  const game = gameServer();
  await new Promise((r) => game.wss.once('listening', r));
  const p1 = player('p1', game.url());
  const p2 = player('p2', game.url());
  await until(() => p1.started && p2.started);
  await settle(2200); // two seconds of play: pings, states, about two network samples each
  p1.gd.track('fight', { weapon: 'bow', won: true, range_m: 8 });
  game.kick(1);
  await until(() => p2.closed);
  await settle(100);
  p1.gd.levelComplete('arena_7');
  p1.gd.track('match_end', { won: true, duration_s: 2.4, items: ['boots', 'blink'] });
  p1.gd.setGroup('match', null);
  game.endMatch();
  p1.leaving = true; // the player quits: no disconnect
  p1.ws.close(1000);
  await until(() => p1.closed);
  for (const p of [p1, p2]) {
    p.stop();
    await p.gd.featuresCheck;
    p.gd.closeWindow();
    p.gd.flush();
  }
  game.server.closeWindow();
  await game.server.close();
  await game.close();
  await settle(300);

  const batches = intake.batches.map((b) => b.body);
  const serverBatches = batches.filter((b) => b.role === 'server');
  const playerBatches = batches.filter((b) => !b.role);
  assert.ok(serverBatches.length >= 1 && playerBatches.length >= 2);

  // Envelopes: players in anonymous mode send no player ID; the server says it is one, under the game's own service.
  for (const b of playerBatches) assert.deepEqual(keys(b), ['batch_id', 'env', 'events', 'player_id', 'sdk', 'service', 'session_id', 'version']);
  for (const b of serverBatches) assert.deepEqual([b.role, b.player_id, b.service], ['server', null, SERVICE]);
  for (const b of batches) for (const e of b.events) checkEvent(e, b.role ? 'server' : 'player');

  const bySession = (b) => b.session_id;
  const sessions = [...new Set(playerBatches.map(bySession))];
  assert.equal(sessions.length, 2);
  const eventsOf = (sid) => playerBatches.filter((b) => b.session_id === sid).flatMap((b) => b.events);
  const [e1, e2] = sessions.map(eventsOf).sort((a) => (a.some((e) => e.type === 'disconnect') ? 1 : -1));
  const serverEvents = serverBatches.flatMap((b) => b.events);

  // One match ID on three sides: hashed the same way from the ID the server made.
  const match = hashGroupId(SERVICE, game.matchId);
  for (const events of [e1, e2, serverEvents]) assert.equal(events.find((e) => e.type === 'group' && e.kind === 'match' && e.id).id, match);
  assert.ok(!JSON.stringify(batches).includes(game.matchId), 'the raw match ID never leaves');

  // A player's match: level attributes, zone and match on its events and windows, network samples, counters.
  const start = e1.find((e) => e.type === 'level_start');
  assert.deepEqual([start.level, start.match, start.attrs], ['arena_7', match, { mode: 'duel', hero: 'ember', loadout: ['bow', 'dash', 'shield'] }]);
  const windows = e1.filter((e) => e.type === 'frame_window' && e.match === match);
  assert.ok(windows.length >= 1);
  assert.equal(windows[0].zone, 'north_bridge');
  assert.ok(windows.some((w) => w.net?.samples >= 1 && w.net.transport === 'ws' && w.net.rtt_p50 >= 0), 'pings measured on the socket');
  const counts = e1.filter((e) => e.type === 'counts').flatMap((e) => e.counts);
  const shots = counts.filter((c) => c.name === 'shot').reduce((n, c) => n + c.n, 0);
  assert.ok(shots >= 20, `${shots} shots counted, one per server state`);
  assert.ok(counts.some((c) => c.name === 'hit' && c.sums.damage === c.n * 12), 'damage summed on the device');
  assert.equal(e1.filter((e) => e.type === 'custom' && e.name === 'shot').length, 0, 'counted, never tracked');
  const end = e1.find((e) => e.name === 'match_end');
  assert.deepEqual([end.match, end.attrs.items], [match, ['boots', 'blink']]);
  assert.equal(e1.filter((e) => e.type === 'level_complete').length, 1);
  assert.equal(e1.filter((e) => e.type === 'disconnect' || e.type === 'level_abandon').length, 0, 'p1 finished and left');

  // The kicked player: its disconnect ends the level as an abandon with reason disconnect, never a fail.
  const kicked = e2.find((e) => e.type === 'disconnect');
  assert.deepEqual([kicked.reason, kicked.match, kicked.level], ['kicked', match, 'arena_7']);
  assert.ok(kicked.connected_s > 0);
  const abandon = e2.find((e) => e.type === 'level_abandon');
  assert.deepEqual([abandon.reason, abandon.level], ['disconnect', 'arena_7']);
  assert.equal(e2.filter((e) => e.type === 'level_fail').length, 0);

  // The server's side: ticks against 20 Hz, both players at once, their pings from ws pings, the kick as a player_left.
  const sw = serverEvents.filter((e) => e.type === 'server_window');
  assert.ok(sw.reduce((n, w) => n + w.ticks, 0) >= 30, 'about 20 ticks a second');
  assert.equal(Math.max(...sw.map((w) => w.players_max)), 2);
  assert.ok(sw.some((w) => w.rtt_p95 != null), 'round trips from WebSocket pings');
  assert.ok(sw.some((w) => w.match === match), 'its windows carry the match');
  const left = serverEvents.filter((e) => e.type === 'counts').flatMap((e) => e.counts).filter((c) => c.name === 'player_left');
  assert.deepEqual(left.map((c) => c.attrs.reason).sort(), ['kicked', 'left']);
  assert.equal(serverEvents.find((e) => e.type === 'level_start').attrs.mode, 'duel');
  assert.equal(serverEvents.at(-1).type, 'session_end');

  // Intake takes every batch, and keeps the new fields on the events it stores.
  for (const b of batches) {
    const stored = normalize(parsePayload(JSON.stringify(b), { projectId: 'p_test' }));
    for (const e of stored.filter((s) => s.type === 'level_start' && s.match)) assert.equal(e.match, match);
    for (const e of stored.filter((s) => s.type === 'level_start' && s.attrs)) assert.ok(Array.isArray(e.attrs.loadout ?? []));
    for (const e of stored.filter((s) => s.type === 'frame_window' && b.events.find((x) => x.ts === s.ts && x.net))) assert.ok(e.net);
  }

  // The real server took every batch, and the match shows on its match page: both players and the server, the kick.
  assert.ok((await Promise.all(intake.forwarded)).every((status) => status === 202), 'the real server took every batch');
  if (!real) return;
  const range = `service=${SERVICE}&from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`;
  const page = await (await fetch(`${real.url}/v1/query/matches?${range}&id=${match}`)).json();
  assert.ok(page.match, JSON.stringify(page));
  assert.deepEqual([page.match.id, page.match.level, page.match.sessions.length, page.match.server.length], [match, 'arena_7', 2, 1]);
  assert.deepEqual(page.match.disconnect_reasons, { kicked: 1 });
  assert.equal(page.match.attrs.mode, 'duel', 'the attributes the match was set with');
  assert.equal(page.match.sessions.find((s) => s.disconnects.length).outcome, 'disconnect');
  assert.ok(page.match.server[0].slots.length >= 1 && page.match.server[0].budget_ms === 50, JSON.stringify(page.match.server[0]));
  const services = (await (await fetch(`${real.url}/v1/query/services`)).json()).services;
  assert.deepEqual(services.map((s) => [s.service, s.server?.service]), [[SERVICE, `${SERVICE}.server`]], 'the server goes under the game');
});
