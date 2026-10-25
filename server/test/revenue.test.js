// Revenue from a revenue source (revenue.js, SPEC §3h), store-neutral: how a source's days and versions are kept, the
// store_revenue panels and their validation, the Revenue page a first connection adds, and the store_revenue query, next
// to the sessions, players and purchase events Glitchless measured. A host's reader hands the core RevenueCat's data
// as Glitchless Cloud's does; nothing calls RevenueCat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';
import { createStoreData, withStorePage } from '../src/reviews.js';
import { validateDashboard, SIZES } from '../src/board.js';
import { scenarioSessions, memoryKv } from './helpers/steam-data.js';

const DAY = 86_400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const round2 = (v) => Math.round(v * 100) / 100;

test("a source's revenue days: a day sent again replaces the measures it has, a version split replaces that day's versions", async () => {
  const kv = memoryKv();
  const data = createStoreData(kv);
  await data.write('p', 'revenuecat', { revenue: [{ day: '2026-10-23', revenue: 10, transactions: 2, mrr: 300, currency: 'USD', incomplete: true }], revenue_versions: [{ day: '2026-10-23', version: '1.4.1', revenue: 10, transactions: 2, currency: 'USD' }], snapshots: { overview: { at: 1, currency: 'USD', metrics: [{ id: 'mrr', value: 300 }] } }, syncedAt: 1 });
  // The next sync: the day is complete now, the trials chart answered too, and 1.4.2 is out.
  await data.write('p', 'revenuecat', { revenue: [{ day: '2026-10-23', revenue: 14, transactions: 3, trials: 5, currency: 'USD' }, { day: '2026-11-01', revenue: 4, currency: 'USD', incomplete: true }], revenue_versions: [{ day: '2026-10-23', version: '1.4.2', revenue: 9, transactions: 2, currency: 'USD' }, { day: '2026-10-23', version: '1.4.1', revenue: 5, transactions: 1, currency: 'USD' }], syncedAt: 2 });
  const read = await data.read('p', 'revenuecat', { from: Date.parse('2026-10-01'), to: Date.parse('2026-11-02') });
  assert.deepEqual(read.revenue, [
    { day: '2026-10-23', revenue: 14, transactions: 3, mrr: 300, trials: 5, currency: 'USD', incomplete: false },
    { day: '2026-11-01', revenue: 4, currency: 'USD', incomplete: true },
  ]);
  assert.deepEqual(read.revenue_versions.map((r) => [r.version, r.revenue]).sort(), [['1.4.1', 5], ['1.4.2', 9]], "the first sync's 1.4.1 row gave way to the day's new split");
  assert.equal(read.snapshots.overview.metrics[0].value, 300);
  assert.equal((await data.stats('p', 'revenuecat')).overview.metrics[0].id, 'mrr');
  assert.equal((await data.read('p', 'steam', { from: 0, to: Date.parse('2026-11-02') })).revenue, undefined, 'a store has no revenue');
  assert.ok([...kv.items.values()].filter((i) => /^REVV?#/.test(i.sk)).every((i) => i.expiresAt > Date.parse('2027-11-01') / 1000));
  await data.clear('p', 'revenuecat');
  assert.equal(kv.items.size, 0);
});

test('store_revenue panels: measure and store are checked; the Revenue page goes after the first page once', () => {
  const page = (panels) => ({ pages: [{ id: 'money', title: 'Money', panels }] });
  assert.throws(() => validateDashboard(page([{ type: 'store_revenue' }])), /needs measure: one of revenue, per_player, installs, active_users, mrr, actives, trials, by_day, players_by_day, by_version/);
  assert.throws(() => validateDashboard(page([{ type: 'store_revenue', measure: 'mrr', store: 'steam' }])), /store must be one of revenuecat/);
  assert.throws(() => validateDashboard(page([{ type: 'store_reviews', store: 'revenuecat' }])), /store must be one of steam, google_play, app_store/);
  assert.deepEqual(validateDashboard(page([{ type: 'store_revenue', measure: 'by_day', store: 'revenuecat', size: 'l' }])).pages[0].panels, [{ type: 'store_revenue', size: 'l', measure: 'by_day', store: 'revenuecat' }]);

  const designed = { pages: [{ id: 'overview', title: 'Overview', panels: [{ type: 'store_reviews' }] }, { id: 'revenue', title: 'Revenue', view: 'events' }] };
  const next = withStorePage(designed, 'revenuecat');
  assert.deepEqual(next.pages.map((p) => p.id), ['overview', 'revenue-2', 'revenue'], 'a store panel naming no store is not a revenue panel; the id is free');
  assert.deepEqual(next.pages[1].panels.map((p) => p.measure ?? p.metric), ['revenue', 'per_player', 'installs', 'active_users', 'by_day', 'mrr', 'actives', 'players_by_day', 'trials', 'players', 'by_version']);
  // Whole rows of 12 columns: no gap at a row's end.
  const rows = [0];
  for (const p of next.pages[1].panels) rows[rows.length - 1] + SIZES[p.size] > 12 ? rows.push(SIZES[p.size]) : (rows[rows.length - 1] += SIZES[p.size]);
  assert.deepEqual(rows, [12, 12, 12, 12]);
  assert.equal(next.pages[1].icon, 'money');
  validateDashboard(next);
  assert.equal(withStorePage(next, 'revenuecat'), null, 'once');
  const money = { pages: [{ id: 'm', title: 'M', panels: [{ type: 'store_revenue', measure: 'mrr' }] }] };
  assert.equal(withStorePage(money, 'revenuecat'), null);
  assert.deepEqual(withStorePage(money, 'steam').pages.map((p) => p.id), ['m', 'steam'], 'a revenue panel is not a Steam page');
});

// A game with telemetry (purchases in every fifth session, in USD) and RevenueCat's days, served by the core with a
// stores reader as a host gives it. `versions`: whether RevenueCat split revenue by version; `anonymous`: the game sends
// no player IDs.
async function revenueGame({ versions = true, anonymous = false } = {}) {
  const now = Date.now();
  const release = now - 3 * DAY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-revenue-'));
  const store = new FileStore(dir);
  const data = createStoreData(memoryKv());
  const days = [];
  for (let d = 9; d >= 0; d--) {
    const t = now - d * DAY;
    const revenue = 40 + d;
    days.push({ day: isoDay(t), revenue, transactions: 8, mrr: 500 - d, actives: 90 - d, trials: 6, new_customers: 20 + d, active_customers: 150 + d, currency: 'USD', incomplete: d === 0, versions: t >= release ? [['1.4.2', revenue - 10], ['1.4.1', 10]] : [['1.4.1', revenue]] });
  }
  await data.write('default', 'revenuecat', {
    revenue: days.map(({ versions: _, ...r }) => r),
    revenue_versions: versions ? days.flatMap((r) => r.versions.map(([version, revenue]) => ({ day: r.day, version, revenue, transactions: 2, currency: 'USD' }))) : [],
    snapshots: { overview: { at: now, currency: 'USD', metrics: [{ id: 'mrr', value: 500 }] }, charts: { day: isoDay(now), version_segment: versions ? 'app_version' : null, segments: versions ? ['country', 'app_version'] : ['country', 'store'], currency: 'USD' } },
    syncedAt: now,
  });
  const read = async (projectId, service, range) => ({ revenuecat: { app_id: 'proj1ab2c3d4', currency: 'USD', keys: { secret: true }, ...(await data.read(projectId, 'revenuecat', range)) } });
  const server = http.createServer(createApp({ store, stores: { read }, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let bought = 0;
  for (const [i, batch] of scenarioSessions({ now, release, builds: [] }, { days: 5, perHour: 1 }).entries()) {
    if (anonymous) batch.player_id = batch.session_id;
    if (i % 5 === 0) {
      batch.events.splice(1, 0, { type: 'custom', ts: batch.events[0].ts + 500, name: 'purchase', attrs: { amount: 4.99, currency: 'USD', item: 'gems' } });
      bought++;
    }
    assert.equal((await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify(batch) })).status, 202);
  }
  const get = async (name, params = {}) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: 'caverun', from: now - 7 * DAY, to: now, ...params })}`)).json();
  const window = days.filter((r) => r.day >= isoDay(now - 7 * DAY));
  return { now, days, window, bought, base, get, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r)), fs.rmSync(dir, { recursive: true, force: true })) };
}

test('the Revenue page on the automatic dashboard: revenue, per player, installs, active users, MRR, subscriptions, trials, by day and by version next to Glitchless', async () => {
  const g = await revenueGame();
  try {
    const pages = (await g.get('dashboard')).dashboard.pages.map((p) => p.id);
    assert.deepEqual(pages.slice(0, 2), ['overview', 'revenue']);
    const { board } = await g.get('board', { page: 'revenue' });
    const panel = (m) => board.panels.find((p) => p.measure === m);
    const total = round2(g.window.reduce((a, r) => a + r.revenue, 0));
    assert.deepEqual([panel('revenue').value, panel('revenue').currency, panel('revenue').store_name], [total, 'USD', 'RevenueCat']);
    const players = board.panels.find((p) => p.metric === 'players').value;
    assert.equal(panel('per_player').value, round2(total / players));
    assert.deepEqual([panel('mrr').value, panel('mrr').change, panel('actives').value, panel('trials').value], [500, 500 - g.window[0].mrr, 90, 6]);
    assert.equal(panel('revenue').glitchless.sum, round2(g.bought * 4.99));
    const rows = panel('by_version').rows;
    assert.deepEqual(rows.map((r) => r.version), ['1.4.2', '1.4.1']);
    assert.ok(rows.every((r) => r.players > 0 && r.purchases >= 0));
    // Installs and active users a day, next to the new players and players a day Glitchless measured.
    assert.equal(panel('installs').value, g.window.reduce((a, r) => a + r.new_customers, 0));
    assert.ok(panel('installs').glitchless.new_players > 0);
    const full = g.window.filter((r) => !r.incomplete);
    assert.equal(panel('active_users').value, Math.round(full.reduce((a, r) => a + r.active_customers, 0) / full.length));
    assert.ok(panel('active_users').glitchless.players_per_day > 0);
    assert.deepEqual(panel('players_by_day').series.map((x) => [x.key, Boolean(x.measured)]), [['installs', false], ['new_players', true], ['active_users', false], ['players', true]]);
    // A store panel naming no store is about stores, not RevenueCat.
    const reviews = await g.get('store_reviews');
    assert.equal(reviews.connected, false);
    assert.match(reviews.why, /no store connected/);
  } finally {
    await g.close();
  }
});

test("the store_revenue query: by day with the day's sessions, one version's revenue, a game without player IDs, and a currency that isn't the game's", async () => {
  const g = await revenueGame({ versions: false, anonymous: true });
  try {
    const q = await g.get('store_revenue');
    assert.deepEqual([q.connected, q.store, q.totals.revenue, q.days.length, q.versions], [true, 'revenuecat', round2(g.window.reduce((a, r) => a + r.revenue, 0)), g.window.length, null]);
    assert.match(q.versions_why, /can't be split by app version \(it splits by country, store\)/);
    assert.ok(q.days.at(-1).incomplete && q.days.at(-2).sessions > 0);
    // Without player IDs Glitchless can't tell new players: installs stand alone, and say why.
    assert.deepEqual([q.totals.installs, q.new_players, q.days.at(-2).new_players], [g.window.reduce((a, r) => a + r.new_customers, 0), null, null]);
    assert.ok(q.notes.some((n) => /no player IDs, so Glitchless can't tell new players/.test(n)));
    const installs = (await g.get('board', { page: 'revenue' })).board.panels.find((p) => p.measure === 'installs');
    assert.deepEqual([installs.glitchless, installs.anonymous], [null, true]);
    const one = await g.get('store_revenue', { version: '1.4.2' });
    assert.equal(one.empty, true);
    assert.match(one.why, /no revenue of 1\.4\.2 alone/);
    assert.equal((await g.get('store_revenue', { store: 'steam' })).why, 'store is one of revenuecat');

    // The dashboard's money is in euros: RevenueCat's dollars are shown as dollars, and not compared.
    const put = await fetch(`${g.base}/v1/dashboard?service=caverun`, { method: 'PUT', body: JSON.stringify({ currency: 'EUR', pages: [{ id: 'overview', title: 'Overview', panels: [{ type: 'store_revenue', measure: 'revenue' }] }] }) });
    assert.equal(put.status, 200);
    const eur = await g.get('store_revenue', { from: g.now - 7 * DAY + 1 });
    assert.equal(eur.currency, 'USD');
    assert.equal(eur.glitchless.comparable, false);
    assert.match(eur.notes[0], /^RevenueCat reports in USD and this game's money is in EUR/);
  } finally {
    await g.close();
  }
});
