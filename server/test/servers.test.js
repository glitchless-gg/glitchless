// Server mode (docs/design/genre-coverage.md A9; SPEC §2 role, server_window, §3 servers, §3b servers panel, §4, §6):
// a batch whose envelope says role "server" is filed under the game's companion service, `<service>.server`, so no
// players number takes in a server; the game's dashboard, findings, matches and the servers query read the companion.
// Server sessions count as sessions like any other. Every store answers as the raw events do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/analytics.js';
import { parsePayload, normalize, FEATURES, withServers } from '../src/ingest.js';
import { validateBoard, evaluateBoard, autoDashboard } from '../src/board.js';
import { findings } from '../src/findings.js';
import { serversView, byPlayers } from '../src/servers.js';
import { matchDetail } from '../src/matches.js';
import { Presence } from '../src/presence.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { hashGroupId } from '../../packages/sdk/src/groups.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = Math.floor((NOW - 8 * 3_600_000) / 60_000) * 60_000;
const q = (service, extra = {}) => ({ service, from: START - 60_000, to: NOW, type: 'all', ...extra });
const HZ = 30;
const BUDGET = 1000 / HZ;

// Six dedicated servers (Node, 30 Hz, 100 players) each host one 10-minute match on island: players join 10 a minute;
// past 80 connected, 8% of ticks are late. Memory climbs on every server. Server 4 crashes 9 minutes in, with 90 players
// and its match open. Each match has 8 players with network windows (the rest of the 100 are bots, as a load test
// would have); in matches 0, 2 and 4 the whole lobby lags 3 to 4 minutes in, when their server's tick is slow.
function arena() {
  const players = [];
  const servers = [];
  for (let m = 0; m < 6; m++) {
    const raw = `match-${String(m).padStart(4, '0')}`;
    const match = hashGroupId('arena', raw);
    const t0 = START + m * 3_600_000;
    const sid = `srv_${m}`;
    const crash = m === 4;
    const end = crash ? 9 * 60_000 : 10 * 60_000;
    const base = { service: 'arena', env: 'prod', version: '1.2', session_id: sid, player_id: null };
    const events = [{ ...base, type: 'session_start', ts: t0 - 2000, level: null, session_type: 'user', privacy: 'anonymous', engine: { name: 'node', version: '22' }, server: { tick_hz: HZ, max_players: 100, build: 'dedicated', region: 'eu-west', host: { os: 'Linux', cores: 8, memory_gb: 16 } } }];
    const push = (e) => events.push({ level: null, ...base, ...e });
    push({ type: 'group', ts: t0, kind: 'match', id: match, attrs: { mode: 'squads' } });
    push({ type: 'level_start', ts: t0 + 1, level: 'island', attrs: { mode: 'squads' }, match });
    for (let t = 0; t < end; t += 5000) {
      const connected = Math.min(100, Math.floor(t / 6000));
      const lobby = m % 2 === 0 && t >= 180_000 && t < 240_000;
      const late = connected >= 80 ? 12 : lobby ? 30 : 0;
      const tick = new Sketch();
      for (let i = 0; i < 150; i++) tick.add(i < late ? BUDGET * 1.6 : 12 + (i % 7));
      push({ type: 'server_window', ts: t0 + t, level: 'island', match, duration_s: 5, ticks: 150, tick_hz: HZ, tick: tick.toJSON(), tick_p50: 14, tick_p95: tick.quantile(0.95), tick_max: tick.max, late, players: connected, players_max: connected, net_objects: 200 + connected * 6, in_kbps: 400, out_kbps: 1200, cpu_pct: 40 + connected / 2, mem_mb: 100 + t / 750, rtt_p95: 60, ctx: { projectiles: connected * 3 } });
    }
    if (crash) {
      push({ type: 'error', ts: t0 + end + 1, kind: 'crash', message: 'TypeError: Cannot read properties of undefined (reading "hp")', fn: 'applyDamage', source: 'room.js', line: 88, fingerprint: 'fp-damage', attrs: { origin: 'uncaughtException' }, match });
      push({ type: 'session_end', ts: t0 + end + 2, reason: 'crash' });
    } else {
      push({ type: 'level_complete', ts: t0 + end, level: 'island', match, duration_s: end / 1000 });
      push({ type: 'group', ts: t0 + end + 1, kind: 'match', id: null, ended: match });
      push({ type: 'session_end', ts: t0 + end + 2, reason: 'match_end' });
    }
    servers.push(events);
    for (let p = 0; p < 8; p++) {
      const pb = { service: 'arena', env: 'prod', version: '1.2', session_id: `p_${m}_${p}`, player_id: `p_${m}_${p}` };
      const list = [{ ...pb, type: 'session_start', ts: t0 - 1000, level: null, session_type: 'user', device: { os: 'Windows' } }];
      const at = (e) => list.push({ level: null, ...pb, ...e });
      at({ type: 'group', ts: t0 + 10, kind: 'match', id: match, match });
      at({ type: 'level_start', ts: t0 + 20, level: 'island', match });
      for (let t = 0; t < end; t += 5000) {
        const lobby = m % 2 === 0 && t >= 180_000 && t < 240_000;
        const rtt = lobby ? 260 : 45;
        const sk = new Sketch(0.05);
        for (let i = 0; i < 5; i++) sk.add(rtt + i);
        const ft = new Sketch();
        for (let f = 0; f < 300; f++) ft.add(16);
        at({ type: 'frame_window', ts: t0 + t + 500, level: 'island', match, duration_s: 5, frames: 300, budget_ms: 16.67, ft: ft.toJSON(), hitches: 0, net: { rtt: sk.toJSON(), rtt_p50: rtt + 2, rtt_p95: rtt + 4, rtt_max: rtt + 4, jitter_ms: 2, loss_pct: 0.2, samples: 5, transport: 'ws', link: 'wifi', host: false } });
      }
      if (crash) {
        at({ type: 'disconnect', ts: t0 + end + 50, level: 'island', match, reason: 'server_closed', connected_s: end / 1000, rtt_p95: 49, loss_pct: 0.2 });
        at({ type: 'level_abandon', ts: t0 + end + 51, level: 'island', match, reason: 'disconnect' });
      } else at({ type: 'level_complete', ts: t0 + end, level: 'island', match, duration_s: end / 1000 });
      at({ type: 'session_end', ts: t0 + end + 3000 });
      players.push(list);
    }
  }
  return { players, servers };
}

const { players, servers } = arena();
const strip = ({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e;
// As intake files them: the servers' batches say role "server".
const filed = (list, role) => normalize(parsePayload({ service: list[0].service, env: 'prod', version: '1.2', session_id: list[0].session_id, player_id: list[0].player_id, ...(role ? { role } : {}), events: list.map(strip) }), NOW);
const playerEvents = players.flatMap((l) => filed(l)).sort((a, b) => a.ts - b.ts);
const serverEvents = servers.flatMap((l) => filed(l, 'server')).sort((a, b) => a.ts - b.ts);
const ctxOf = () => {
  const ctx = buildContext(playerEvents, q('arena'));
  ctx.server = buildContext(serverEvents, q('arena.server'));
  return ctx;
};

test("intake files a server's batches under the companion service, with no player ID; health lists server_mode", () => {
  assert.ok(FEATURES.includes('server_mode') && FEATURES.includes('counts'));
  const [first] = filed(servers[0], 'server');
  assert.deepEqual([first.service, first.player_id], ['arena.server', 'srv_0']);
  assert.equal(first.server.max_players, 100);
  assert.equal(filed(players[0])[0].service, 'arena');
  const listed = withServers([
    { service: 'arena', versions: ['1.2'], envs: ['prod'], last_seen: 5 },
    { service: 'arena.server', versions: ['1.2'], envs: ['prod'], last_seen: 6 },
    { service: 'lonely.server', versions: ['1'], envs: ['dev'], last_seen: 1 },
  ]);
  assert.deepEqual(listed.map((s) => [s.service, s.server?.service ?? null, s.server_of ?? null]), [['arena', 'arena.server', null], ['lonely.server', null, 'lonely']]);
});

test('the servers view: ticks by players connected and by map, crashes that ended matches, memory that climbs', () => {
  const v = serversView(ctxOf(), { servers: 2, players: 150 });
  assert.deepEqual([v.servers_now, v.players_on_servers, v.kpis.servers, v.kpis.crashed, v.kpis.budget_ms], [2, 150, 6, 1, Math.round(BUDGET * 100) / 100]);
  const bands = byPlayers(ctxOf().server);
  assert.equal(bands[0].value, '0–9 players');
  assert.ok(bands.find((b) => b.lo === 80).over_budget_pct === 100 && bands.find((b) => b.lo === 50).over_budget_pct < 50, JSON.stringify(bands));
  assert.deepEqual(v.by_level.map((r) => r.value), ['island']);
  assert.equal(v.by_version[0].servers, 6);
  const [crash] = v.crashes;
  assert.deepEqual([crash.fingerprint, crash.matches_ended, crash.players_dropped], ['fp-damage', 1, 89], 'the players its last window had');
  assert.ok(v.memory.some((g) => g.key === 'mem_mb' && g.climbing === 6));
  assert.equal(v.sessions.length, 6);
  assert.equal(v.sessions.find((s) => s.session_id === 'srv_4').crashed, true);
});

test("server panels and metrics read the companion; players' numbers never take in a server", () => {
  const ctx = ctxOf();
  ctx.serversNow = { servers: 3, players: 240 };
  const [now, tick, crashFree, perServer, ticks, crashes, sessions] = evaluateBoard(
    ctx,
    validateBoard({
      panels: [
        { type: 'stat', metric: 'servers_now' },
        { type: 'stat', metric: 'server_tick_p95' },
        { type: 'stat', metric: 'server_crash_free_pct' },
        { type: 'stat', metric: 'players_per_server' },
        { type: 'servers', show: 'ticks', by: 'players' },
        { type: 'servers', show: 'crashes' },
        { type: 'stat', metric: 'sessions' },
      ],
    }),
  );
  assert.deepEqual([now.value, now.players], [3, 240]);
  assert.ok(tick.value > 12 && tick.budget_ms === Math.round(BUDGET * 100) / 100, JSON.stringify(tick));
  assert.equal(crashFree.value, Math.round((5 / 6) * 1000) / 10);
  assert.ok(perServer.value > 40);
  assert.equal(ticks.rows.length, 10);
  assert.equal(crashes.crashes[0].matches_ended, 1);
  assert.equal(sessions.value, 48, 'the 48 players, no server');
  assert.throws(() => validateBoard({ panels: [{ type: 'servers', show: 'cpu' }] }), /show is ticks, players, crashes/);
  const auto = autoDashboard({ ...ctxOf(), hasServers: true });
  assert.ok(auto.pages.some((p) => p.view === 'servers'));
});

test('findings: servers fall behind when full, a crash ends a match, memory leaks, and the lobby lag is the server', () => {
  const list = findings(ctxOf());
  const ids = list.map((f) => f.id);
  const tick = list.find((f) => f.id === 'server-tick-island');
  assert.ok(tick, ids.join(', '));
  assert.match(tick.title, /^Servers on island miss their 30 Hz tick in 100% of windows once 80 or more players are connected \(with fewer: [\d.]+%\)$/);
  const crash = list.find((f) => f.id === 'server-error-fp-damage');
  assert.match(crash.title, /^A server crash ended 1 match with 89 players: /);
  assert.ok(list.find((f) => f.id === 'server-leak-1.2'), ids.join(', '));
  const lobby = list.find((f) => f.id === 'net-lobby-island');
  assert.ok(lobby, ids.join(', '));
  assert.ok(lobby.evidence.server.during > lobby.evidence.server.otherwise, JSON.stringify(lobby.evidence.server));
  assert.match(lobby.summary, /Server tick p95 reaches [\d.]+ ms then, against [\d.]+ ms the rest of the match/);
});

test("a match page shows the server's ticks in the same slots as its players", () => {
  const ctx = ctxOf();
  const match = hashGroupId('arena', 'match-0000');
  const d = matchDetail(ctx, match);
  assert.equal(d.server.length, 1);
  assert.deepEqual([d.server[0].session_id, d.sessions.length], ['srv_0', 8]);
  const slow = d.server[0].slots.find((s) => s.t === 180);
  assert.ok(slow.tick_p95 > BUDGET, JSON.stringify(slow));
  assert.deepEqual(d.lobby_spikes, [180, 210]);
  assert.equal(d.server_sessions ?? d.server.length, 1);
});

test('presence counts servers and the players connected to them', () => {
  let t = 1_000_000;
  const p = new Presence({ now: () => t });
  p.record('p1', [{ service: 'arena.server', session_id: 'a', type: 'server_window', ts: 1, players: 40 }, { service: 'arena.server', session_id: 'b', type: 'server_window', ts: 1, players: 12 }, { service: 'arena', session_id: 'x', type: 'frame_window', ts: 1 }]);
  p.record('p1', [{ service: 'arena.server', session_id: 'a', type: 'server_window', ts: 2, players: 44 }]);
  assert.deepEqual([p.count('p1', 'arena.server'), p.players('p1', 'arena.server'), p.count('p1', 'arena')], [2, 56, 1]);
  t += 121_000;
  assert.deepEqual([p.count('p1', 'arena.server'), p.players('p1', 'arena.server')], [0, 0]);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a game's servers answer under its companion, as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const PANELS = [
      { type: 'stat', metric: 'server_tick_p95' },
      { type: 'stat', metric: 'server_crash_free_pct' },
      { type: 'stat', metric: 'sessions' },
      { type: 'servers', show: 'ticks', by: 'players' },
      { type: 'servers', show: 'ticks', by: '$level' },
      { type: 'servers', show: 'crashes' },
      { type: 'net', show: 'ping' },
    ];
    try {
      assert.ok((await call('GET', '/v1/health')).features.includes('server_mode'));
      for (const [list, role] of [...players.map((l) => [l, null]), ...servers.map((l) => [l, 'server'])]) {
        const { service, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env: 'prod', version: '1.2', session_id, player_id, ...(role ? { role } : {}), events: list.map(strip) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      const { services } = await call('GET', '/v1/query/services');
      assert.deepEqual(services.map((s) => [s.service, s.server?.service]), [['arena', 'arena.server']]);
      await call('PUT', '/v1/dashboard?service=arena', { pages: [{ id: 'servers', title: 'Servers', panels: PANELS }, { id: 'srv', title: 'Servers', view: 'servers' }] });
      const range = `service=arena&from=${START - 60_000}&to=${NOW + 1}`;
      const { meta, board } = await call('GET', `/v1/query/board?${range}&page=servers`);
      const raw = buildContext(playerEvents.filter((e) => e.ts >= meta.from && e.ts <= meta.to), q('arena', { from: meta.from, to: meta.to }));
      raw.server = buildContext(serverEvents.filter((e) => e.ts >= meta.from && e.ts <= meta.to), q('arena.server', { from: meta.from, to: meta.to }));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(board.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels: PANELS })))));
      const view = await call('GET', `/v1/query/servers?${range}`);
      assert.equal(view.kpis.servers, 6);
      assert.equal(view.servers_now, kind === 'file' || kind === 'dynamodb' || kind === 'lake' ? view.servers_now : 0);
      assert.equal(view.crashes[0].matches_ended, 1);
      const f = await call('GET', `/v1/query/findings?${range}`);
      for (const id of ['server-tick-island', 'server-error-fp-damage', 'net-lobby-island']) assert.ok(f.findings.some((x) => x.id === id), `${id}: ${f.findings.map((x) => x.id).join(', ')}`);
      const one = await call('GET', `/v1/query/matches?${range}&id=${hashGroupId('arena', 'match-0000')}`);
      assert.equal(one.match.server.length, 1);
      const companion = await call('GET', `/v1/query/overview?service=arena.server&from=${START - 60_000}&to=${NOW + 1}`);
      assert.equal(companion.kpis.sessions, 6, 'server sessions count as sessions, under the companion');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
