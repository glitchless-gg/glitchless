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
    assert.equal((await g.get('store_revenue', { store: 'steam' })).why, 'store is one of revenuecat, stripe');

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

// ───────────────────────────── a payments source (Stripe, SPEC §3i) ─────────────────────────────

test("a payments source's days, products, countries and tied purchases: kept by day, a day sent again replaces each; its measures checked by source", async () => {
  const kv = memoryKv();
  const data = createStoreData(kv);
  const day = (d, x) => ({ day: d, revenue: 0, transactions: 0, refunds: 0, refund_count: 0, disputes: 0, fees: 0, net: 0, new_customers: 0, other_payments: 0, currency: 'USD', ...x });
  await data.write('p', 'stripe', {
    revenue: [day('2026-10-23', { revenue: 19.98, transactions: 2, fees: 1.18, net: 18.8, new_customers: 2, incomplete: true })],
    revenue_products: [{ day: '2026-10-23', product: 'prod_Full', name: 'Full game', revenue: 14.99, transactions: 1, currency: 'USD' }, { day: '2026-10-23', product: 'prod_Dlc', name: 'DLC', revenue: 4.99, transactions: 1, currency: 'USD' }],
    revenue_countries: [{ day: '2026-10-23', country: 'DE', name: 'Germany', revenue: 19.98, transactions: 2, currency: 'USD' }],
    revenue_purchases: [{ day: '2026-10-23', ts: Date.parse('2026-10-23T10:00:00Z'), amount: 14.99, currency: 'USD', product: 'prod_Full', ref: 's_abc' }],
    syncedAt: 1,
  });
  // The day read again, complete: a refund came, the DLC was refunded, and the purchase tied to a session is gone (another pick).
  await data.write('p', 'stripe', { revenue: [day('2026-10-23', { revenue: 19.98, transactions: 2, refunds: 4.99, refund_count: 1, fees: 1.18, net: 13.81, new_customers: 2 })], revenue_products: [{ day: '2026-10-23', product: 'prod_Full', name: 'Full game', revenue: 14.99, transactions: 1, currency: 'USD' }], revenue_countries: [], revenue_purchases: [], syncedAt: 2 });
  const read = await data.read('p', 'stripe', { from: Date.parse('2026-10-01'), to: Date.parse('2026-10-25') });
  assert.deepEqual([read.revenue[0].refunds, read.revenue[0].net, read.revenue[0].incomplete], [4.99, 13.81, false]);
  assert.deepEqual(read.revenue_products.map((r) => [r.product, r.revenue]), [['prod_Full', 14.99]], "the day's products replaced");
  assert.deepEqual(read.revenue_countries.map((r) => [r.country, r.name]), [['DE', 'Germany']], 'a split sent empty leaves the day as it was');
  assert.deepEqual(read.revenue_purchases, [], 'the day read again has none tied');
  assert.equal((await data.read('p', 'revenuecat', { from: Date.parse('2026-10-01'), to: Date.parse('2026-10-25') })).revenue_products, undefined, 'only a payments source has them');

  const page = (panels) => ({ pages: [{ id: 'money', title: 'Money', panels }] });
  assert.throws(() => validateDashboard(page([{ type: 'store_revenue', store: 'stripe', measure: 'mrr' }])), /Stripe doesn't count mrr; its measures are revenue, per_player, by_day, by_version, by_country, refunds, customers, by_product/);
  assert.throws(() => validateDashboard(page([{ type: 'store_revenue', store: 'revenuecat', measure: 'by_product' }])), /RevenueCat doesn't count by_product/);
  validateDashboard(page([{ type: 'store_revenue', store: 'stripe', measure: 'by_product' }]));
  assert.throws(() => validateDashboard(page([{ type: 'store_revenue', store: 'stripe', measure: 'by_store' }])), /Stripe doesn't count by_store/, 'it sells in no app store');

  // Stripe's page after RevenueCat's: both say whose they are (RevenueCat's, still as it came, is renamed).
  const overview = { id: 'overview', title: 'Overview', panels: [{ type: 'stat', metric: 'players' }] };
  const withRc = withStorePage({ pages: [overview] }, 'revenuecat');
  const both = withStorePage(withRc, 'stripe');
  assert.deepEqual(both.pages.map((p) => [p.id, p.title]), [['overview', 'Overview'], ['revenue-2', 'Stripe revenue'], ['revenue', 'RevenueCat revenue']]);
  assert.deepEqual(both.pages[1].panels.map((p) => [p.store, p.measure]), ['revenue', 'per_player', 'refunds', 'customers', 'by_day', 'by_product', 'by_version'].map((m) => ['stripe', m]));
  const rows = [0];
  for (const p of both.pages[1].panels) rows[rows.length - 1] + SIZES[p.size] > 12 ? rows.push(SIZES[p.size]) : (rows[rows.length - 1] += SIZES[p.size]);
  assert.deepEqual(rows, [12, 12, 12]);
  validateDashboard(both);
  const renamed = withStorePage({ pages: [overview, { ...withRc.pages[1], title: 'Gems money' }] }, 'stripe');
  assert.equal(renamed.pages[2].title, 'Gems money', "a page the developer named keeps its name");
  assert.equal(withStorePage(both, 'stripe'), null, 'once');
});

// A game with telemetry and its Stripe days (test mode), some purchases tied to its sessions (by session, by the
// session as client_reference_id, by player) and one tied to a session Glitchless never saw, served by the core.
async function stripeGame({ mode = 'test' } = {}) {
  const now = Date.now();
  const release = now - 3 * DAY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-stripe-'));
  const store = new FileStore(dir);
  const data = createStoreData(memoryKv());
  const batches = scenarioSessions({ now, release, builds: [] }, { days: 5, perHour: 1 });
  const days = [];
  for (let d = 9; d >= 0; d--) days.push({ day: isoDay(now - d * DAY), revenue: 50 + d, transactions: 5, refunds: d % 3 ? 0 : 4.99, refund_count: d % 3 ? 0 : 1, disputes: d === 4 ? 14.99 : 0, fees: 2.5, net: 47.5 + d - (d % 3 ? 0 : 4.99) - (d === 4 ? 14.99 : 0), new_customers: 3, other_payments: d === 2 ? 1 : 0, currency: 'USD', incomplete: d === 0 });
  const tied = batches.filter((_, i) => i % 6 === 0).map((b, i) => ({ day: isoDay(b.events[0].ts + 60_000), ts: b.events[0].ts + 60_000, amount: 4.99, currency: 'USD', product: 'prod_Dlc', ...(i % 3 === 0 ? { session: b.session_id } : i % 3 === 1 ? { ref: b.session_id } : { player: b.player_id }), version: b.version }));
  await data.write('default', 'stripe', {
    revenue: days,
    revenue_products: days.flatMap((r) => [{ day: r.day, product: 'prod_Full', name: 'Full game', revenue: r.revenue - 10, transactions: 3, refunds: r.refunds, refund_count: r.refund_count, currency: 'USD' }, { day: r.day, product: 'prod_Dlc', name: 'Deep Caves DLC', revenue: 10, transactions: 2, currency: 'USD' }]),
    revenue_purchases: [...tied.map(({ version: _, ...p }) => p), { day: isoDay(now - DAY), ts: now - DAY, amount: 9.99, currency: 'USD', product: 'prod_Full', session: 's_never_seen' }],
    revenue_countries: days.flatMap((r) => [{ day: r.day, country: 'US', name: 'United States', revenue: r.revenue - 20, transactions: 3, currency: 'USD' }, { day: r.day, country: 'DE', name: 'Germany', revenue: 15, transactions: 1, currency: 'USD' }, { day: r.day, country: '(none)', name: 'Unknown', revenue: 5, transactions: 1, currency: 'USD' }]),
    snapshots: { overview: { at: now, currency: 'USD', mode, metrics: [{ id: 'revenue', name: 'Gross volume', value: 540, unit: '$', period: 'P28D' }] } },
    syncedAt: now,
  });
  const read = async (projectId, service, range) => ({ stripe: { app_id: null, mode, products: 'game=caverun', keys: { restricted: true }, ...(await data.read(projectId, 'stripe', range)) } });
  const server = http.createServer(createApp({ store, stores: { read }, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const batch of batches) assert.equal((await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify(batch) })).status, 202);
  const get = async (name, params = {}) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: 'caverun', from: now - 7 * DAY, to: now, ...params })}`)).json();
  const window = days.filter((r) => r.day >= isoDay(now - 7 * DAY));
  const put = (body) => fetch(`${base}/v1/dashboard?service=caverun`, { method: 'PUT', body: JSON.stringify(body) });
  return { now, days, window, tied: tied.filter((p) => p.day >= isoDay(now - 7 * DAY)), get, put, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r)), fs.rmSync(dir, { recursive: true, force: true })) };
}

test("Stripe's Revenue page: revenue with its net, refunds and disputes, new paying customers, by product, and by version from purchases joined to their sessions; test mode says so", async () => {
  const g = await stripeGame();
  try {
    assert.equal((await g.get('dashboard')).dashboard.pages.find((p) => p.id === 'revenue').title, 'Revenue', "the game's only revenue source");
    const { board } = await g.get('board', { page: 'revenue' });
    assert.deepEqual(board.panels.map((p) => p.measure), ['revenue', 'per_player', 'refunds', 'customers', 'by_day', 'by_product', 'by_version']);
    const panel = (m) => board.panels.find((p) => p.measure === m);
    const sum = (k) => round2(g.window.reduce((a, r) => a + r[k], 0));
    const revenue = panel('revenue');
    assert.deepEqual([revenue.value, revenue.net, revenue.fees, revenue.store_name, revenue.mode], [sum('revenue'), sum('net'), sum('fees'), 'Stripe (test mode)', 'test']);
    assert.ok(revenue.notes[0].startsWith('This Stripe connection uses a test-mode key: these are test payments, not real revenue.'));
    assert.ok(revenue.notes.some((n) => /^1 payment in this window settled in another currency than USD: left out/.test(n)));
    assert.deepEqual([panel('refunds').value, panel('refunds').refund_count, panel('refunds').disputes], [round2(sum('refunds') + sum('disputes')), sum('refund_count'), sum('disputes')]);
    assert.equal(panel('refunds').share_pct, Math.round(((sum('refunds') + sum('disputes')) / sum('revenue')) * 1000) / 10);
    assert.equal(panel('customers').value, sum('new_customers'));
    assert.ok(panel('customers').glitchless.new_players > 0);
    assert.match(panel('customers').notes[0], /^Stripe counts a new paying customer on the day of their first payment/);
    assert.deepEqual(panel('by_day').series.map((s) => s.label), ['Revenue', 'Refunds and disputes']);
    assert.deepEqual(panel('by_day').net, g.window.map((r) => r.net));
    assert.deepEqual(panel('by_product').rows.map((r) => [r.name, r.revenue]), [['Full game', round2(sum('revenue') - 10 * g.window.length)], ['Deep Caves DLC', 10 * g.window.length]]);
    // By version: each tied purchase in its session's version (the one Glitchless never saw isn't).
    const byVersion = panel('by_version');
    const count = (v) => g.tied.filter((p) => p.version === v).length;
    assert.deepEqual(byVersion.rows.map((r) => [r.version, r.transactions]), [['1.4.2', count('1.4.2')], ['1.4.1', count('1.4.1')]]);
    assert.ok(byVersion.rows.every((r) => r.players > 0 && r.sessions > 0));
    assert.equal(byVersion.unjoined.transactions, sum('transactions') - g.tied.length);
    assert.deepEqual(byVersion.platforms.map((p) => p.platform).sort(), [...new Set(byVersion.platforms.map((p) => p.platform))].sort());
    assert.ok(byVersion.payers > 0 && byVersion.payers_pct > 0);
    // RevenueCat's measures aren't Stripe's.
    const q = await g.get('store_revenue', { version: '1.4.2' });
    assert.deepEqual([q.store, q.mode, q.version, q.totals.transactions, q.versions.map((r) => r.version)], ['stripe', 'test', '1.4.2', count('1.4.2'), ['1.4.2']]);
    assert.equal(q.totals.refunds, sum('refunds'), "refunds are the whole game's");
    assert.equal(q.stores, undefined, 'no split by store');

    // Its countries on the map: revenue and payments (it has no installs), payments with no country listed apart.
    assert.equal((await g.put({ pages: [{ id: 'map', title: 'Map', panels: [{ type: 'store_revenue', store: 'stripe', measure: 'by_country' }] }] })).status, 200);
    const map = (await g.get('board', { page: 'map' })).board.panels[0];
    assert.deepEqual([map.title, map.show, map.has], ['Revenue by country', 'revenue', { installs: false, revenue: true }]);
    assert.deepEqual(map.rows.map((r) => [r.key, r.country]), [['US', 'US'], ['DE', 'DE'], ['(none)', null]]);
    assert.deepEqual([map.totals.revenue, map.totals.purchases], [round2(sum('revenue') - 20 * g.window.length + 20 * g.window.length), 5 * g.window.length]);
    assert.match(map.notes[0], /^Revenue is what Stripe settled from buyers in each country .* Stripe has no installs\. 8 payments came with no country\.$/);
    assert.ok(!map.notes.some((n) => /Not on the map/.test(n)));
    const countries = (await g.get('store_revenue', { store: 'stripe' })).countries;
    assert.deepEqual(countries[0], { country: 'US', name: 'United States', revenue: round2(sum('revenue') - 20 * g.window.length), purchases: 3 * g.window.length });
  } finally {
    await g.close();
  }
});
