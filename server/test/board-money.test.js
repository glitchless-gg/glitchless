// Board requests from a Roblox hub game (Starlift on Roblox: a lobby, the "hall", zones, puzzles, Robux purchases):
//   - Robux as a currency (robux.js): `currency: "ROBUX"` on a board and on purchase events, never added to real money,
//     and an opt-in estimate in US dollars at Roblox's DevEx rate, always labelled one;
//   - a sum breakdown of a filtered event (occurrence-sums.js): completed purchases by item, while cancelled ones still
//     carry their amount;
//   - time to an event's first occurrence and the sessions that never sent it (firsts.js), also for events a Roblox
//     server sends for a player;
//   - `order` on count and sum breakdowns: streak days 1 to 10 in their own order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { buildContext, versions } from '../src/analytics.js';
import { parsePayload, normalize } from '../src/ingest.js';
import { validateBoard, validateDashboard, evaluateBoard, eventQuery, dashboardStats, versionColumns } from '../src/board.js';
import { DEVEX } from '../src/revenue.js';
import { DEVEX_SOURCE } from '../src/robux.js';
import { firstStat, neverStat, QUIET_MS } from '../src/firsts.js';
import { STORES } from './helpers/stores.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();
const START = NOW - 3 * 3_600_000;
const SERVICE = 'starlift-roblox';

// Ten player sessions of the hub, as the Roblox server sends them (one session a player, from joining to leaving).
// `left`: seconds after joining that the player first left the hall (null: never). Purchases are in Robux, with the
// amount sent on cancelled ones too; one is in dollars (a web shop), which must never be added to the Robux.
const PLAYERS = [
  { left: 12, buys: [['boost', 100, 'done']], streak: '1' },
  { left: 20, buys: [['skin', 50, 'cancelled'], ['skin', 80, 'done']], streak: '1' },
  { left: 30, buys: [['boost', 100, 'done']], streak: '2' },
  { left: 45, buys: [['boost', 40, 'cancelled']], streak: '10' },
  { left: 60, again: 200, streak: '10' },
  { left: null, streak: '3' },
  { left: null, streak: '10' },
  // Went quiet two hours ago without a session_end (a crash): over, and never left the hall.
  { left: null, quiet: true, streak: '9' },
  // Still playing: joined five minutes ago, no session_end, so it isn't counted as one that never left.
  { left: null, playing: true, streak: '3' },
  { left: 90, buys: [['gems', 200, 'done', 'USD']], streak: '1', version: '2' },
];

function hub() {
  return PLAYERS.flatMap((x, i) => {
    const t0 = x.playing ? NOW - 5 * 60_000 : START + i * 60_000;
    const base = { service: SERVICE, env: 'prod', version: x.version ?? '1', session_id: `s_${i}`, level: null };
    const events = [{ type: 'session_start', ts: t0, session_type: 'user', device: { browser: 'Roblox', os: 'Computer' } }];
    if (x.left != null) events.push({ type: 'custom', ts: t0 + x.left * 1000, name: 'hall_left', attrs: { to: 'puzzles' } });
    if (x.again) events.push({ type: 'custom', ts: t0 + x.again * 1000, name: 'hall_left', attrs: { to: 'zone_b' } });
    (x.buys || []).forEach(([item, amount, result, currency = 'ROBUX'], k) => events.push({ type: 'custom', ts: t0 + 100_000 + k * 1000, name: 'purchase', attrs: { item, amount, currency, result } }));
    events.push({ type: 'custom', ts: t0 + 5_000, name: 'streak_day', attrs: { day: x.streak } });
    const last = x.playing ? NOW - 60_000 : t0 + 240_000;
    events.push({ type: 'custom', ts: last, name: 'zone_entered', attrs: { zone: 'hall' } });
    if (!x.quiet && !x.playing) events.push({ type: 'session_end', ts: last + 1000, reason: 'quit' });
    return events.map((e) => ({ ...base, ...e }));
  });
}

const ctxOf = (list = hub()) => buildContext(list, { service: SERVICE, from: START - 60_000, to: NOW, type: 'all' });
const panel = (p, { currency = null, ctx = ctxOf() } = {}) => evaluateBoard(ctx, validateBoard({ panels: [p] }), { currency })[0];

test('a board keeps its money in Robux: ROBUX on the dashboard, never added to dollars either way', () => {
  const pages = [{ id: 'money', title: 'Money', panels: [{ type: 'stat', event: 'purchase', sum: 'amount' }] }];
  assert.equal(validateDashboard({ currency: 'robux', pages }).currency, 'ROBUX');
  assert.equal(validateDashboard({ currency: 'usd', pages }).currency, 'USD');
  assert.throws(() => validateDashboard({ currency: 'R$', pages }), /ISO 4217 code.*"ROBUX"/);
  assert.throws(() => validateDashboard({ currency: 'DOLLARS', pages }), /ROBUX/);

  // Most of the purchases are in Robux, so without a board currency the money is Robux; the dollars are named, not added.
  const all = panel({ type: 'stat', event: 'purchase', sum: 'amount' });
  assert.deepStrictEqual([all.value, all.currency, all.mismatch], [370, 'ROBUX', [{ currency: 'USD', sum: 200, events: 1 }]]);
  const robux = panel({ type: 'stat', event: 'purchase', sum: 'amount' }, { currency: 'ROBUX' });
  assert.deepStrictEqual([robux.value, robux.currency], [370, 'ROBUX']);
  // A board in dollars: the Robux are the ones left out.
  const usd = panel({ type: 'stat', event: 'purchase', sum: 'amount' }, { currency: 'USD' });
  assert.deepStrictEqual([usd.value, usd.currency, usd.mismatch], [200, 'USD', [{ currency: 'ROBUX', sum: 370, events: 5 }]]);
});

test('a Robux panel can add an estimate in dollars at the DevEx rate, always labelled an estimate', () => {
  const done = panel({ type: 'stat', event: 'purchase=done', sum: 'amount', devex: true });
  assert.equal(done.value, 280);
  assert.equal(done.devex.estimate, true);
  assert.equal(done.devex.usd, Math.round(280 * DEVEX.usd * 100) / 100);
  assert.deepStrictEqual([done.devex.rate, done.devex.since, done.devex.source], [DEVEX.usd, DEVEX_SOURCE.since, DEVEX_SOURCE.url]);
  // Per player, the estimate is of the number shown, and of the total under it.
  const per = panel({ type: 'stat', event: 'purchase=done', sum: 'amount', per: '$sessions', devex: true });
  assert.equal(per.devex.usd, Math.round(per.value * DEVEX.usd * 100) / 100);
  assert.equal(per.devex.total_usd, Math.round(280 * DEVEX.usd * 100) / 100);
  // A breakdown: each row and the total.
  const rows = panel({ type: 'breakdown', event: 'purchase:result=done', by: 'item', sum: 'amount', devex: true });
  // gems was bought in dollars: its row counts the purchase, with no Robux (the dollars are named, not added).
  assert.deepStrictEqual(rows.rows.map((r) => [r.value, r.sum, r.usd]), [['boost', 200, 0.76], ['skin', 80, 0.3], ['gems', 0, 0]]);
  assert.equal(rows.devex.usd, 1.06);
  // Not Robux: no estimate (DevEx is for Robux only).
  assert.equal(panel({ type: 'stat', event: 'purchase', sum: 'amount', devex: true }, { currency: 'USD' }).devex, null);
  // It goes with a sum.
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', event: 'purchase', devex: true }] }), /devex goes with sum/);
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', metric: 'sessions', devex: true }] }), /devex goes with event/);
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', event: 'purchase', sum: 'amount', devex: 'yes' }] }), /devex is true/);
  assert.equal(validateBoard({ panels: [{ type: 'stat', event: 'purchase', sum: 'amount', devex: false }] }).panels[0].devex, undefined);
});

test('a sum breakdown of a filtered event: completed purchases by item, from the occurrences, matching the cells', () => {
  const spec = { type: 'breakdown', event: 'purchase:result=done', by: 'item', sum: 'amount' };
  assert.deepStrictEqual(validateBoard({ panels: [spec] }).panels[0], spec, 'a filtered event by an attribute is taken');
  const b = panel(spec);
  // The cancelled skin (50) and boost (40) are left out; the dollars too, named.
  assert.deepStrictEqual(b.rows.map((r) => [r.value, r.sum, r.count, r.sessions]), [['boost', 200, 2, 2], ['skin', 80, 1, 1], ['gems', 0, 1, 1]]);
  assert.deepStrictEqual([b.total, b.count, b.currency, b.from], [280, 4, 'ROBUX', 'occurrences']);
  assert.deepStrictEqual(b.mismatch, [{ currency: 'USD', sum: 200, events: 1 }]);
  // The same total as a stat of the filtered event, which the cells add up exactly.
  assert.equal(panel({ type: 'stat', event: 'purchase:result=done', sum: 'amount' }).value, b.total);
  // Cancelled ones by item still have their amounts.
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'purchase:result=cancelled', by: 'item', sum: 'amount' }).rows.map((r) => [r.value, r.sum]), [['skin', 50], ['boost', 40]]);
  // A series of it, by item.
  const s = panel({ type: 'series', event: 'purchase:result=done', by: 'item', sum: 'amount' });
  assert.deepStrictEqual(s.series.map((x) => [x.label, x.values.reduce((a, v) => a + v, 0)]), [['boost', 200], ['skin', 80], ['gems', 0]]);
  assert.equal(s.from, 'occurrences');
  // Unfiltered and by $version still read the cells.
  assert.equal(panel({ type: 'breakdown', event: 'purchase', by: 'item', sum: 'amount' }).from, undefined);
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'purchase:result=done', by: '$version', sum: 'amount' }).rows.map((r) => [r.value, r.sum]), [['1', 280], ['2', 0]]);
});

test('sandbox purchases of a filtered event are counted, never added, and an amount outside the window is left out', () => {
  const extra = [
    { service: SERVICE, env: 'prod', version: '1', session_id: 's_0', level: null, type: 'custom', ts: START + 200_000, name: 'purchase', attrs: { item: 'boost', amount: 999, currency: 'ROBUX', result: 'done', sandbox: true } },
    // Sent before the window opened, by a session that is in it.
    { service: SERVICE, env: 'prod', version: '1', session_id: 's_1', level: null, type: 'custom', ts: START - 120_000, name: 'purchase', attrs: { item: 'skin', amount: 777, currency: 'ROBUX', result: 'done' } },
  ];
  const ctx = ctxOf([...hub(), ...extra]);
  const b = panel({ type: 'breakdown', event: 'purchase:result=done', by: 'item', sum: 'amount' }, { ctx });
  assert.deepStrictEqual(b.rows.map((r) => [r.value, r.sum, r.count]), [['boost', 200, 3], ['skin', 80, 1], ['gems', 0, 1]]);
  assert.equal(b.sandbox, 1);
  // The cells count only the window's minutes (a store reads only those): the same 280.
  const inWindow = ctxOf([...hub(), ...extra].filter((e) => e.ts >= START - 60_000));
  assert.equal(panel({ type: 'stat', event: 'purchase:result=done', sum: 'amount' }, { ctx: inWindow }).value, 280);
});

test('time to a first event and the sessions that never sent it', () => {
  const ctx = ctxOf();
  const first = panel({ type: 'stat', first: 'hall_left' }, { ctx });
  // The first hall_left of each session that left, whatever came after (s_4 left again at 200 s).
  assert.deepStrictEqual([first.value, first.unit, first.quantile, first.sessions, first.title], [45, 's', 50, 6, 'Time to first hall_left']);
  assert.equal(panel({ type: 'stat', first: 'hall_left', quantile: 90 }, { ctx }).value, 90);
  // Ended sessions: nine (s_7 went quiet two hours ago; s_8 is still playing). Three of them never left the hall.
  const never = panel({ type: 'stat', never: 'hall_left' }, { ctx });
  assert.deepStrictEqual([never.value, never.unit, never.count, never.base, never.title], [33.3, '%', 3, 9, 'Sessions that never sent hall_left']);
  // A filtered event: the first completed purchase.
  assert.equal(panel({ type: 'stat', first: 'purchase:result=done' }, { ctx }).sessions, 4);
  assert.equal(panel({ type: 'stat', never: 'purchase:result=done' }, { ctx }).count, 5);
  // Nothing yet: why, not zeros.
  assert.match(panel({ type: 'stat', first: 'trophy' }, { ctx }).why, /No session sent "trophy"/);
  // Over more than 31 days the sessions aren't there: it says so.
  assert.match(firstStat({ ...ctx, daily: {} }, { name: 'hall_left' }).why, /31 days or less/);
  assert.match(neverStat({ ...ctx, daily: {} }, { name: 'hall_left' }).why, /31 days or less/);
  assert.ok(QUIET_MS >= 10 * 60_000);
});

test('first and never are checked, compared version by version, and answered by the events query', () => {
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', first: 'hall_left', event: 'hall_left' }] }), /needs one of metric/);
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', first: 'hall_left', sum: 'amount' }] }), /sum goes with event, not first/);
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', never: 'hall_left', quantile: 50 }] }), /quantile goes with first/);
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', first: 'hall_left', quantile: 0 }] }), /quantile is the percentile/);
  assert.throws(() => validateBoard({ panels: [{ type: 'stat', never: 'a=b=c,d' }] }), /never is one event/);
  const ctx = ctxOf();
  const page = { panels: [{ type: 'stat', first: 'hall_left', title: 'Time in the hall' }, { type: 'stat', never: 'hall_left', title: 'Never left the hall' }] };
  const stats = dashboardStats({ pages: [validateBoard(page)] });
  assert.equal(stats.length, 2);
  assert.deepStrictEqual(versionColumns(stats).map((c) => [c.title, c.unit]), [['Time in the hall', 's'], ['Never left the hall', '%']]);
  const v = Object.fromEntries(versions(ctx, { stats, events: 0 }).map((x) => [x.version, x.board]));
  assert.deepStrictEqual(v['1'], [30, 37.5]);
  assert.deepStrictEqual(v['2'], [90, 0]);
  const q = eventQuery(ctx, new URLSearchParams({ name: 'hall_left', first: '1' }));
  assert.deepStrictEqual(q.first, { event: 'hall_left', sessions: 6, median_s: 45, p90_s: 90, ended: 9, never: 3, never_pct: 33.3 });
  // With a measure too, both come back.
  const both = eventQuery(ctx, new URLSearchParams({ name: 'purchase', event: 'purchase:result=done', first: '1', avg: 'amount' }));
  assert.deepStrictEqual([both.first.sessions, both.measure.value], [4, 120]);
});

test('order on a breakdown by count or sum: the values in their own order, or the most first', () => {
  const ctx = ctxOf();
  const value = panel({ type: 'breakdown', event: 'streak_day', by: 'day', order: 'value' }, { ctx });
  assert.deepStrictEqual(value.rows.map((r) => r.value), ['1', '2', '3', '9', '10']);
  const count = panel({ type: 'breakdown', event: 'streak_day', by: 'day', order: 'count' }, { ctx });
  assert.deepStrictEqual(count.rows.map((r) => [r.value, r.count]), [['1', 3], ['10', 3], ['3', 2], ['2', 1], ['9', 1]]);
  // The top rows are taken after ordering, as a rate breakdown's are.
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'streak_day', by: 'day', order: 'value', limit: 3 }, { ctx }).rows.map((r) => r.value), ['1', '2', '3']);
  // A filtered event (read from the occurrences), by $version, and a sum.
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'hall_left:to=puzzles', by: 'to', order: 'value' }, { ctx }).rows.map((r) => r.value), ['puzzles']);
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'streak_day', by: '$version', order: 'value' }, { ctx }).rows.map((r) => r.value), ['1', '2']);
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'purchase', by: 'item', sum: 'amount', order: 'value' }, { ctx }).rows.map((r) => r.value), ['boost', 'gems', 'skin']);
  assert.deepStrictEqual(panel({ type: 'breakdown', event: 'purchase', by: 'item', sum: 'amount', order: 'count' }, { ctx }).rows.map((r) => [r.value, r.count]), [['boost', 3], ['skin', 2], ['gems', 1]]);
  assert.deepStrictEqual(panel({ type: 'breakdown', by: '$platform', order: 'value' }, { ctx }).rows.map((r) => r.value), ['Computer']);
  // Checked: count and value without a rate; rate and avg still need theirs; a series has no rows to order.
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'streak_day', by: 'day', order: 'rate' }] }), /order on a breakdown by count is count or value \(rate goes with rate\)/);
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'streak_day', by: 'day', order: 'size' }] }), /is count or value$/);
  assert.throws(() => validateBoard({ panels: [{ type: 'series', event: 'streak_day', by: 'day', order: 'value' }] }), /order goes with a breakdown's rows/);
  assert.equal(validateBoard({ panels: [{ type: 'breakdown', event: 'streak_day', by: 'day', rate: 'won', order: 'value' }] }).panels[0].order, 'value');
});

test('a share link shows first and never, and Robux and their estimate only when it shows sums', () => {
  const board = validateBoard({ panels: [{ type: 'stat', event: 'purchase=done', sum: 'amount', devex: true }, { type: 'breakdown', event: 'purchase:result=done', by: 'item', sum: 'amount', devex: true }, { type: 'stat', first: 'hall_left' }, { type: 'stat', never: 'hall_left' }] });
  const [stat, rows, first, never] = evaluateBoard(ctxOf(), board, { shared: true, currency: 'ROBUX' });
  assert.match(stat.why, /Sums such as revenue are not shown/);
  assert.equal(stat.devex, true, 'the spec only: no estimate');
  assert.match(rows.why, /Sums such as revenue are not shown/);
  assert.deepStrictEqual([first.value, never.value], [45, 33.3]);
  const [withSums] = evaluateBoard(ctxOf(), board, { shared: { sums: true }, currency: 'ROBUX' });
  assert.deepStrictEqual([withSums.value, withSums.devex.usd], [280, 1.06]);
});

// The Roblox SDK's own batches (a three-player race the Roblox server sent, fixtures/sdk-payloads/roblox.json), with
// one more event the server sends for a player: Glitchless.track(player, 'hall_left') from a server Script goes into
// that player's session, as the server sends it. Its coins are counted on the server for each player (count()).
function robloxRace() {
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/sdk-payloads/roblox.json'), 'utf8'));
  const last = Math.max(...fixture.batches.flatMap((b) => b.events.map((e) => e.ts)));
  const by = NOW - 120_000 - last;
  const move = (e) => ({ ...e, ts: e.ts + by, ...(e.first_ts ? { first_ts: e.first_ts + by } : {}), ...(e.counts ? { counts: e.counts.map((c) => ({ ...c, ...(c.first_ts ? { first_ts: c.first_ts + by } : {}) })) } : {}) });
  const batches = fixture.batches.map((b) => ({ ...b, events: b.events.map(move) }));
  const racer = batches.find((b) => b.events.some((e) => e.type === 'custom' && e.name === 'boost_used'));
  const joined = batches.find((b) => b.session_id === racer.session_id && b.events.some((e) => e.type === 'session_start')).events.find((e) => e.type === 'session_start').ts;
  racer.events.push({ type: 'custom', ts: joined + 15_000, level: null, name: 'hall_left', attrs: { to: 'race' } });
  return { batches, service: fixture.service, racer: racer.session_id };
}

test("a Roblox server's events for a player: time to the first and players who never sent it", () => {
  const { batches, service } = robloxRace();
  const events = batches.flatMap((b) => normalize(parsePayload(b)));
  const ctx = buildContext(events.filter((e) => e.service === service), { service, from: NOW - 3_600_000, to: NOW, type: 'all' });
  assert.equal(ctx.sessions.size, 3, 'three players; the server is its own service');
  const p = (x) => evaluateBoard(ctx, validateBoard({ panels: [x] }))[0];
  assert.deepStrictEqual([p({ type: 'stat', first: 'hall_left' }).value, p({ type: 'stat', first: 'hall_left' }).sessions], [15, 1]);
  // All three players left (one kicked), so all three ended; two never left the hall.
  assert.deepStrictEqual([p({ type: 'stat', never: 'hall_left' }).count, p({ type: 'stat', never: 'hall_left' }).base], [2, 3]);
  // Coins the server counts for each player (count()): every player got some, a few seconds in.
  const coin = p({ type: 'stat', first: 'coin' });
  assert.equal(coin.sessions, 3);
  assert.ok(coin.value > 0 && coin.value < 30, `${coin.value} s`);
  assert.equal(p({ type: 'stat', never: 'coin' }).value, 0);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: Robux, filtered sums, first and never, and orders answer as the raw events do`, async () => {
    const { store, close, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    try {
      const { batches, service } = robloxRace();
      // The hub's sessions as batches too, one a session, as the Roblox server sends them.
      const hubBatches = [...Map.groupBy(hub(), (e) => e.session_id)].map(([session_id, list]) => ({ service, env: 'prod', version: list[0].version, session_id, sdk: 'glitchless-roblox/0.1.0', batch_id: `b_${session_id}`, events: list.map(({ service: _s, env: _e, version: _v, session_id: _i, ...e }) => e) }));
      for (const b of [...batches, ...hubBatches]) {
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: zlib.gzipSync(JSON.stringify(b)) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      const panels = [
        { type: 'stat', event: 'purchase:result=done', sum: 'amount', devex: true },
        { type: 'breakdown', event: 'purchase:result=done', by: 'item', sum: 'amount', devex: true },
        { type: 'stat', first: 'hall_left' },
        { type: 'stat', never: 'hall_left' },
        { type: 'breakdown', event: 'streak_day', by: 'day', order: 'value' },
      ];
      const saved = await call('PUT', `/v1/dashboard?service=${service}`, { currency: 'robux', pages: [{ id: 'hub', title: 'Hub', panels }] });
      assert.equal(saved.dashboard.currency, 'ROBUX');
      const range = `service=${service}&from=${START - 60_000}&to=${NOW}`;
      const { meta, board } = await call('GET', `/v1/query/board?${range}&page=hub`);
      const all = [...batches, ...hubBatches].flatMap((b) => normalize(parsePayload(b))).filter((e) => e.service === service && e.ts >= meta.from && e.ts <= meta.to);
      const raw = buildContext(all, { service, from: meta.from, to: meta.to, type: 'all' });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(board.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels }), { currency: 'ROBUX' }))));
      const [stat, byItem, first, never, streak] = board.panels;
      assert.deepStrictEqual([stat.value, stat.currency, stat.devex.usd], [280, 'ROBUX', 1.06]);
      assert.deepStrictEqual(byItem.rows.map((r) => [r.value, r.sum]), [['boost', 200], ['skin', 80], ['gems', 0]]);
      assert.deepStrictEqual([first.sessions, never.base], [7, 12]);
      assert.deepStrictEqual(streak.rows.map((r) => r.value), ['1', '2', '3', '9', '10']);
      // The events query's first.
      const events = await call('GET', `/v1/query/events?${range}&name=hall_left&first=1`);
      assert.deepStrictEqual([events.first.sessions, events.first.ended, events.first.never], [7, 12, 5]);
    } finally {
      server.close();
      await close?.();
    }
  });
}
