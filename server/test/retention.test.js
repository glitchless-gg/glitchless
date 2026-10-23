// Retention (SPEC §3 players.retention): D1, D7 and D30 by the day players were first seen, counted over players with
// an ID (install or full mode, both the stored p_ player ID, SPEC §4b). Exact from session states for ranges up to 31 days, on the file store and the hosted
// store's hour summaries alike; from daily rollups past 31 days, exact while small and named in meta.approximate
// once their samples are capped. A game in anonymous mode gets a state that says so, not zeros. Also players now
// (counted as batches arrive) and the Steam Deck as a platform of its own.
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
import { CAPS } from '../src/daily.js';
import { lakeSim, needsDuckDB } from './helpers/lake-sim.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const D0 = Math.floor(Date.now() / DAY) * DAY - 50 * DAY;
const P = 'proj_r';
const SERVICE = 'starlift';
const DECK = { browser: 'Godot', browser_version: '4.5.1', os: 'Linux', mobile: false, gpu_tier: 'low', steam_deck: true };
const DESK = { browser: 'Godot', browser_version: '4.5.1', os: 'Windows', mobile: false, gpu_tier: 'high' };

// One short session: a start, a frame window, a custom event, an end. `player` null is an anonymous session (ingest
// files it under its session ID).
function session(id, player, ts, { device = DESK, version = '1.0.0' } = {}) {
  const sk = new Sketch();
  for (let i = 0; i < 300; i++) sk.add(device.steam_deck ? 22 + (i % 7) : 8 + (i % 5));
  const base = { service: SERVICE, env: 'prod', version, session_id: id, player_id: player ?? id, sdk: 'glitchless-godot/0.2.0', level: null };
  return [
    { ...base, type: 'session_start', ts, session_type: 'user', privacy: player ? 'install' : 'anonymous', device },
    { ...base, type: 'frame_window', ts: ts + 1000, level: 'voyage_1', frames: 300, duration_s: 5, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0 },
    { ...base, type: 'custom', ts: ts + 60_000, name: 'play', attrs: { mode: 'endless' } },
    { ...base, type: 'session_end', ts: ts + 3 * MINUTE, reason: 'quit', duration_s: 180 },
  ];
}

// 40 install players first seen on days 1 to 36, coming back on some of the 1st, 2nd, 7th and 30th days after; two
// full-mode players; a veteran first seen on day 0 who plays again later; anonymous sessions every day, some on a
// Deck. Sessions run 10:00 to 16:00 UTC, so none crosses midnight or a range boundary at 07:00.
const sessions = [];
let n = 0;
const at = (day, k) => D0 + day * DAY + 10 * HOUR + (k % 6) * HOUR + (k % 7) * MINUTE;
const play = (player, day, opts) => sessions.push(session(`s_${n++}`, player, at(day, n), opts));
for (let i = 0; i < 40; i++) {
  const first = 1 + ((i * 7) % 36);
  const id = `p_${String(i).padStart(12, '0')}`;
  const deck = i % 4 === 0 ? { device: DECK } : {};
  play(id, first, deck);
  if (i % 2 === 0) play(id, first + 1, deck);
  if (i % 4 === 1) play(id, first + 2, deck);
  if (i % 3 === 0) play(id, first + 7, deck);
  if (i % 5 === 0 && first + 30 < 44) play(id, first + 30, deck);
}
for (const [id, days] of [
  ['p_full00000001', [3, 4, 10]],
  ['p_full00000002', [3]],
  ['p_veteran00000', [0, 5, 6, 12]],
]) {
  for (const d of days) play(id, d);
}
for (let d = 0; d < 44; d++) for (let k = 0; k < 2; k++) play(null, d, k ? { device: DECK } : {});
const events = sessions.flat().sort((a, b) => a.ts - b.ts);

// Retention as the definition reads, from the raw events: a player's first day is the day of their first event of
// all; they belong to that day's cohort when a session of theirs in the range started on it; Dn counts those with an
// event on day n after it, shown once that day has ended inside [lo, hi).
function expected(lo, hi) {
  const real = (e) => e.player_id !== e.session_id;
  const first = new Map();
  for (const e of events) if (real(e) && !(first.get(e.player_id) <= e.ts)) first.set(e.player_id, e.ts);
  const inRange = events.filter((e) => e.ts >= lo && e.ts < hi);
  const startedOn = new Map();
  const activeOn = new Map();
  for (const e of inRange) {
    if (!real(e)) continue;
    const day = Math.floor(e.ts / DAY) * DAY;
    if (e.type === 'session_start') (startedOn.get(e.player_id) || startedOn.set(e.player_id, new Set()).get(e.player_id)).add(day);
    (activeOn.get(e.player_id) || activeOn.set(e.player_id, new Set()).get(e.player_id)).add(day);
  }
  const rows = new Map();
  for (const [id, ts] of first) {
    const day = Math.floor(ts / DAY) * DAY;
    if (day < lo || day >= hi || !startedOn.get(id)?.has(day)) continue;
    const r = rows.get(day) || rows.set(day, { players: 0, back: [0, 0, 0] }).get(day);
    r.players++;
    [1, 7, 30].forEach((k, j) => activeOn.get(id).has(day + k * DAY) && r.back[j]++);
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return [...rows]
    .sort((a, b) => a[0] - b[0])
    .map(([day, r]) => {
      const row = { day: new Date(day).toISOString().slice(0, 10), players: r.players };
      const returned = {};
      [1, 7, 30].forEach((k, j) => {
        const ended = day + (k + 1) * DAY <= hi;
        row[`d${k}`] = ended ? pct(r.back[j], r.players) : null;
        returned[`d${k}`] = ended ? r.back[j] : null;
      });
      return { ...row, returned };
    });
}

// An app over `store`, every request read as project P.
async function serve(store) {
  const auth = { resolveIngest: () => ({ projectId: P }), resolveReader: () => ({ projectId: P, scopes: ['read', 'dashboard'] }) };
  const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (name, params) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: SERVICE, ...params })}`)).json(),
    put: (p, body) => fetch(base + p, { method: 'PUT', body: JSON.stringify(body) }),
    close: () => server.close(),
  };
}

// A 31-day range starting at 07:00 on day 2, so day 2 is not a whole day of it, and one of 44 whole days.
const MONTH = { from: D0 + 2 * DAY + 7 * HOUR, to: D0 + 33 * DAY + 7 * HOUR - 1 };
const LONG = { from: D0, to: D0 + 44 * DAY - 1 };

let dir;
let store;
let file;
let sim;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-retention-'));
  store = new FileStore(dir);
  await store.put(P, events);
  file = await serve(store);
});
after(() => {
  file?.close();
  sim?.close();
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

test('the hosted store gives the same cohorts from hour summaries, and from daily rollups past 31 days', needsDuckDB, async () => {
  sim = lakeSim({ start: D0 - HOUR, everyMs: HOUR });
  const batches = sessions.map((s) => ({ project: P, events: s, at: s.at(-1).ts + 1000 }));
  await sim.send(batches);
  await sim.advance(D0 + 46 * DAY);
  const lake = await serve(sim.store);
  try {
    const month = await lake.get('players', MONTH);
    assert.deepStrictEqual(month.retention, (await file.get('players', MONTH)).retention, 'hour summaries answer as the file store');
    assert.equal(month.meta.resolution, undefined);
    const long = await lake.get('players', LONG);
    assert.equal(long.meta.resolution, 'day');
    assert.deepStrictEqual(long.retention.cohorts, expected(LONG.from, LONG.to + 1));
    assert.ok(long.retention.cohorts.some((c) => c.d30 > 0), 'D30 past 31 days');
    assert.deepStrictEqual(long.meta.approximate, [], 'exact while small');
    const board = await lake.put(`/v1/dashboard?service=${SERVICE}`, { pages: [{ title: 'Return', panels: [{ type: 'retention', limit: 50 }] }] });
    assert.equal(board.status, 200);
    const panel = (await lake.get('board', LONG)).board.panels[0];
    assert.deepStrictEqual(panel.cohorts, long.retention.cohorts, 'the panel reads the daily rollups too');
    const index = () => [...(sim.doc.tables.get(`P#${P}#N#${SERVICE}`)?.keys() || [])];
    assert.equal(index().filter((sk) => sk.startsWith('I#')).length, 43, 'one I item per player with an ID');
    assert.equal(index().filter((sk) => sk.startsWith('D#')).length, 43, 'and one D item under the day first seen');
    await sim.store.clear(P, SERVICE);
    assert.deepStrictEqual(index(), [], "clearing a game's data clears its first-seen index");
  } finally {
    lake.close();
  }
});

test('past 31 days with capped samples, retention is an estimate and meta.approximate says so', needsDuckDB, async () => {
  const s = lakeSim({ start: D0 - HOUR, everyMs: HOUR, compactor: { dayCaps: { ...CAPS, players: 2 } } });
  const lake = await serve(s.store);
  try {
    await s.send(sessions.map((x) => ({ project: P, events: x, at: x.at(-1).ts + 1000 })));
    await s.advance(D0 + 46 * DAY);
    const long = await lake.get('players', LONG);
    assert.ok(long.meta.approximate.includes('retention'), long.meta.approximate.join());
    assert.ok(long.retention.cohorts.length > 0);
    const sum = (list) => list.reduce((a, c) => a + c.players, 0);
    const exact = sum(expected(LONG.from, LONG.to + 1));
    assert.ok(Math.abs(sum(long.retention.cohorts) / exact - 1) < 0.25, `${sum(long.retention.cohorts)} new players estimated, ${exact} in fact`);
  } finally {
    lake.close();
    s.close();
  }
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
