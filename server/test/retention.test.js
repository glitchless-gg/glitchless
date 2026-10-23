// Retention (SPEC §3 players.retention): D1, D7 and D30 by the day players were first seen, counted over players with
// an ID (install or full mode, both the stored p_ player ID, SPEC §4b), exact from session states on the file store.
// A game in anonymous mode gets a state that says so, not zeros. Also players now (counted as batches arrive) and the
// Steam Deck as a platform of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';
import { Presence } from '../src/presence.js';
import { validateDashboard, evaluateBoard, dashboardStats } from '../src/board.js';
import { buildContext, retention } from '../src/analytics.js';
import { MINUTE, HOUR, DAY, D0, P, SERVICE, DECK, session, sessions, events, expected, serve, MONTH } from './helpers/retention-data.js';

let dir;
let store;
let file;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-retention-'));
  store = new FileStore(dir);
  await store.put(P, events);
  file = await serve(store);
});
after(() => {
  file?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the file store counts cohorts exactly as the raw events say, from its first-seen index', async () => {
  const { retention: r, meta } = await file.get('players', MONTH);
  const want = expected(MONTH.from, MONTH.to + 1);
  assert.deepStrictEqual(r.cohorts, want);
  assert.equal(r.status, 'ok');
  assert.equal(r.first_seen, 'index');
  assert.equal(meta.approximate, undefined);
  assert.equal(r.cohorts[0].day, new Date(D0 + 3 * DAY).toISOString().slice(0, 10), 'cohorts are whole days of the range');
  assert.ok(r.cohorts.some((c) => c.d1 > 0) && r.cohorts.some((c) => c.d7 > 0), 'D1 and D7 have returns in this data');
  assert.ok(r.cohorts.every((c) => c.d30 === null), 'no D30 fits in 31 days');
  const done = want.filter((c) => c.returned.d1 != null);
  assert.equal(r.d1, Math.round((done.reduce((a, c) => a + c.returned.d1, 0) / done.reduce((a, c) => a + c.players, 0)) * 1000) / 10, 'overall D1 weighs each cohort by its players');
  assert.equal(r.new_players, want.reduce((a, c) => a + c.players, 0));
  assert.ok(r.id_sessions_pct > 0 && r.id_sessions_pct < 100);
});

test('without a first-seen index, players are new on their first day in the range', () => {
  const ctx = buildContext(events.filter((e) => e.ts >= MONTH.from && e.ts <= MONTH.to), { service: SERVICE, ...MONTH, type: 'all' });
  const r = retention(ctx);
  assert.equal(r.first_seen, 'range');
  const day5 = new Date(D0 + 5 * DAY).toISOString().slice(0, 10);
  const indexed = expected(MONTH.from, MONTH.to + 1).find((c) => c.day === day5)?.players ?? 0;
  assert.equal(r.cohorts.find((c) => c.day === day5)?.players, indexed + 1, 'the veteran counts as new on day 5');
});

test('a game in anonymous mode says retention needs player IDs, not zeros', async () => {
  const anon = events.filter((e) => e.player_id === e.session_id);
  const ctx = buildContext(anon, { service: SERVICE, from: D0, to: D0 + 31 * DAY, type: 'all' });
  const r = retention(ctx);
  assert.equal(r.status, 'anonymous');
  assert.deepStrictEqual(r.cohorts, []);
  assert.equal(r.d1, null);
  assert.equal(r.id_sessions_pct, 0);
  const [panel] = evaluateBoard(ctx, validateDashboard({ pages: [{ title: 'Players', panels: [{ type: 'retention' }] }] }).pages[0]);
  assert.equal(panel.empty, true);
  assert.equal(panel.anonymous, true);
  assert.match(panel.why, /install/);
  const empty = retention(buildContext([], { service: SERVICE, from: D0, to: D0 + DAY, type: 'all' }));
  assert.equal(empty.status, 'empty');
});

test('a retention panel shows the latest cohorts, on a shared board too', async () => {
  const page = validateDashboard({ pages: [{ title: 'Return', panels: [{ type: 'retention', limit: 5 }, { type: 'stat', metric: 'players_now' }] }] }).pages[0];
  assert.throws(() => validateDashboard({ pages: [{ title: 'x', panels: [{ type: 'retention', limit: 0 }] }] }), /limit must be 1 to 90/);
  const ctx = buildContext(events.filter((e) => e.ts >= MONTH.from && e.ts <= MONTH.to), { service: SERVICE, ...MONTH, type: 'all' });
  ctx.cohorts = await store.cohorts(P, SERVICE, MONTH.from, MONTH.to);
  const [own, now] = evaluateBoard(ctx, page);
  const [shared] = evaluateBoard(ctx, page, { shared: true });
  const all = retention(ctx).cohorts;
  assert.equal(own.title, 'Retention');
  assert.deepStrictEqual(own.cohorts, all.slice(-5));
  assert.equal(own.more, all.length - 5);
  assert.deepStrictEqual(shared, own, 'counts by day reveal no ids, so a share link shows the panel as it is');
  assert.equal(now.empty, true, 'players now needs the app to count it');
  assert.deepStrictEqual(dashboardStats({ pages: [page] }), [], 'players now is not compared version by version');
});

test('players now: sessions that sent anything in the last two minutes, per game', async () => {
  let t = 1_000_000;
  const p = new Presence({ now: () => t });
  p.record(P, [{ service: 'a', session_id: 's1' }, { service: 'a', session_id: 's2' }, { service: 'b', session_id: 's3' }]);
  t += 60_000;
  p.record(P, [{ service: 'a', session_id: 's1' }]);
  assert.equal(p.count(P, 'a'), 2);
  assert.equal(p.count(P, 'b'), 1);
  assert.equal(p.count('other', 'a'), 0, 'per project');
  t += 61_000;
  assert.equal(p.count(P, 'a'), 1, 's2 last sent 121 s ago');
  t += 60_000;
  assert.equal(p.count(P, 'a'), 0);
  assert.equal(p.games.size, 1, 'games nobody plays are dropped');
});

test('the app counts players now at intake, or asks the host (auth.playersNow)', async () => {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-now-')));
  const own = createApp({ store, logger: { warn() {}, error() {} } });
  const asked = [];
  const hosted = createApp({ store, auth: { resolveIngest: () => ({ projectId: P }), resolveReader: () => ({ projectId: P, scopes: ['read', 'dashboard'] }), playersNow: async (project, service) => (asked.push([project, service]), 42) }, logger: { warn() {}, error() {} } });
  const servers = [];
  const base = async (handler) => {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${s.address().port}`;
  };
  try {
    const a = await base(own);
    const now = Date.now();
    const send = (sid) => fetch(`${a}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: SERVICE, env: 'prod', version: '1.0.0', session_id: sid, events: [{ type: 'session_start', ts: now, level: null, device: DECK }] }) });
    await send('s_a');
    await send('s_b');
    await send('s_a');
    const q = await (await fetch(`${a}/v1/query/players_now?service=${SERVICE}`)).json();
    assert.equal(q.players_now, 2);
    assert.equal(q.window_s, 120);
    await fetch(`${a}/v1/dashboard?service=${SERVICE}`, { method: 'PUT', body: JSON.stringify({ pages: [{ title: 'Live', panels: [{ type: 'stat', metric: 'players_now' }] }] }) });
    const panel = (await (await fetch(`${a}/v1/query/board?service=${SERVICE}`)).json()).board.panels[0];
    assert.deepStrictEqual([panel.title, panel.value], ['Playing now', 2]);
    const h = await base(hosted);
    assert.equal((await (await fetch(`${h}/v1/query/players_now?service=${SERVICE}`)).json()).players_now, 42);
    assert.deepStrictEqual(asked, [[P, SERVICE]]);
  } finally {
    for (const s of servers) s.close();
  }
});

test('performance breaks frame times down by platform, with the Steam Deck on its own', async () => {
  const { by_platform } = await file.get('performance', MONTH);
  assert.deepStrictEqual(by_platform.map((x) => x.key).sort(), ['Steam Deck', 'Windows']);
  const deck = by_platform.find((x) => x.key === 'Steam Deck');
  const desk = by_platform.find((x) => x.key === 'Windows');
  assert.ok(deck.p95 > desk.p95, 'the Deck runs slower in this data');
  const { sessions: list } = await file.get('sessions', MONTH);
  assert.ok(list.some((s) => s.steam_deck) && list.some((s) => !s.steam_deck));
});

// What the Unreal plugin (SPEC §5c) sends: install and full mode both send the stored `p_…` player ID, anonymous mode
// none; session_start says which mode; the device carries steam_deck (a boolean, false off a Deck) and os SteamOS on one.
test('Unreal sessions count for retention, players now and the Steam Deck platform as the plugin sends them', async () => {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-r-')));
  const server = http.createServer(createApp({ store, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const deck = { browser: 'Unreal', browser_version: '5.8.4', os: 'SteamOS', mobile: false, device_tier: 'mid', gpu_tier: 'low', renderer: 'deferred', driver: 'Vulkan', screen: [1280, 800], dpr: null, refresh_hz: null, steam_deck: true };
  const desk = { ...deck, os: 'Windows', device_tier: 'high', gpu_tier: 'high', driver: 'D3D12', screen: [2560, 1440], steam_deck: false };
  let n = 0;
  const play = async (player, day, device, privacy = 'install') => {
    const ts = today - day * DAY + 10 * HOUR + n * MINUTE;
    const sk = new Sketch();
    for (let i = 0; i < 300; i++) sk.add(device.steam_deck ? 24 : 9);
    const events = [
      { type: 'session_start', ts, level: null, session_type: 'user', privacy, device, page: null, nav_ms: null },
      { type: 'level_start', ts: ts + 500, level: 'Arena' },
      { type: 'frame_window', ts: ts + 1000, level: 'Arena', frames: 300, duration_s: 5, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0, game_ms: 6, process_ms: 6, render_ms: 5, rhi_ms: null, gpu_ms: 8, objects: 40000, actors: 300, ctx: { objects: 40000, actors: 300 } },
      { type: 'session_end', ts: ts + 60_000, level: 'Arena', reason: 'quit', duration_s: 60 },
    ];
    const res = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: 'arena', env: 'prod', version: '0.1.0', session_id: `s_ue${String(n++).padStart(13, '0')}`, player_id: player, sdk: 'glitchless-unreal/0.1.0', events }) });
    assert.equal(res.status, 202);
  };
  try {
    // Five players first seen five days ago (two on a Deck); three back the next day; one full-mode; two anonymous.
    for (let i = 0; i < 5; i++) await play(`p_ue000000000${i}`, 5, i < 2 ? deck : desk);
    for (let i = 0; i < 3; i++) await play(`p_ue000000000${i}`, 4, i < 2 ? deck : desk);
    await play('p_uefull000000', 5, desk, 'full');
    for (let i = 0; i < 2; i++) await play(null, 5, desk, 'anonymous');
    const get = async (name) => (await fetch(`${base}/v1/query/${name}?service=arena&from=${today - 6 * DAY}&to=${Date.now()}`)).json();
    const { retention: r } = await get('players');
    const day = new Date(today - 5 * DAY).toISOString().slice(0, 10);
    assert.equal(r.status, 'ok');
    assert.deepStrictEqual(r.cohorts.find((c) => c.day === day), { day, players: 6, d1: 50, d7: null, d30: null, returned: { d1: 3, d7: null, d30: null } });
    assert.equal(r.id_sessions_pct, 81.8, 'nine of the eleven sessions sent a player ID');
    assert.equal((await get('players_now')).players_now, 11, 'every session the server took in the last two minutes');
    const { by_platform } = await get('performance');
    assert.deepStrictEqual(Object.fromEntries(by_platform.map((x) => [x.key, x.sessions])), { Windows: 7, 'Steam Deck': 4 });
    const { sessions } = await get('sessions');
    assert.equal(sessions.filter((s) => s.steam_deck).length, 4);
  } finally {
    server.close();
  }
});
