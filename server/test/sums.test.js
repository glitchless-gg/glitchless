// Purchases and revenue (sums.js, board.js): games send track('purchase', { amount, currency, item }), and a
// board adds the amounts up (revenue, per player or per session, by item or version, over time) and counts
// the share of players that bought (conversion). A game has one currency: amounts in another are named, never
// added in, and numbers sent without a currency (coins) are plain sums. Shared boards hide sums unless their
// link shows them. Every store gives the same sums from its events or its rollups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { buildContext, versions } from '../src/analytics.js';
import { rollup, mergeCell, newCell, cellToJSON, cellFromJSON, sumKey, MAX_EVENT_SUMS, OTHER } from '../src/rollups.js';
import { validateBoard, validateDashboard, evaluateBoard, dashboardStats, versionColumns } from '../src/board.js';
import { eventSums, gameCurrency } from '../src/sums.js';
import { shopSessions } from './helpers/game-data.js';

const NOW = Date.now();
const START = NOW - 3 * 3_600_000;
const events = shopSessions({ start: START, spanMs: 2 * 3_600_000, sessions: 80 }).flat();
const ctxOf = (list = events) => buildContext(list, { service: 'zoomies', from: START - 60_000, to: NOW, type: 'all' });
const r2 = (v) => Math.round(v * 100) / 100;

// What the board should say, worked out from the events themselves.
const purchases = events.filter((e) => e.name === 'purchase');
const inCurrency = (c) => purchases.filter((e) => e.attrs.currency.toUpperCase() === c);
const total = (list) => r2(list.reduce((t, e) => t + e.attrs.amount, 0));
const players = new Set(events.map((e) => e.player_id)).size;
const sessions = new Set(events.map((e) => e.session_id)).size;
const buyers = new Set(purchases.map((e) => e.player_id)).size;
const buyingSessions = new Set(purchases.map((e) => e.session_id)).size;

test('the data has what these tests need', () => {
  assert.ok(inCurrency('EUR').length >= 2 && inCurrency('USD').length > 10, `${inCurrency('EUR').length} in EUR`);
  assert.ok(purchases.some((e) => e.attrs.currency === 'usd'), 'a currency in lower case');
  assert.ok(buyers < players && buyingSessions < sessions);
});

test('a stat adds an attribute up: revenue in the game currency, with amounts in another named and left out', () => {
  const ctx = ctxOf();
  assert.equal(gameCurrency(ctx), 'USD', 'the currency most events were sent in');
  const [revenue, perPlayer, perSession, conversion, sessionConversion, gems, coins, missing, noAttr] = evaluateBoard(
    ctx,
    validateBoard({
      panels: [
        { type: 'stat', event: 'purchase', sum: 'amount', title: 'Revenue' },
        { type: 'stat', event: 'purchase', sum: 'amount', per: '$players' },
        { type: 'stat', event: 'purchase', sum: 'amount', per: '$sessions' },
        { type: 'stat', event: 'purchase', per: '$players' },
        { type: 'stat', event: 'purchase', per: '$sessions' },
        { type: 'stat', event: 'purchase:item=gems_500', sum: 'amount' },
        { type: 'stat', event: 'coins', sum: 'amount' },
        { type: 'stat', event: 'refund', sum: 'amount' },
        { type: 'stat', event: 'paywall', sum: 'amount' },
      ],
    }),
  );
  const usd = total(inCurrency('USD'));
  assert.deepStrictEqual([revenue.value, revenue.unit, revenue.currency, revenue.events], [usd, null, 'USD', inCurrency('USD').length]);
  assert.deepStrictEqual(revenue.mismatch, [{ currency: 'EUR', sum: total(inCurrency('EUR')), events: inCurrency('EUR').length }]);
  assert.equal(revenue.title, 'Revenue');
  assert.deepStrictEqual([perPlayer.value, perPlayer.total, perPlayer.base, perPlayer.currency], [r2(usd / players), usd, players, 'USD']);
  assert.equal(perPlayer.title, 'purchase amount per player');
  assert.deepStrictEqual([perSession.value, perSession.base], [r2(usd / sessions), sessions]);
  assert.deepStrictEqual([conversion.value, conversion.unit, conversion.count, conversion.base, conversion.title], [Math.round((buyers / players) * 1000) / 10, '%', buyers, players, 'Players who sent purchase']);
  assert.deepStrictEqual([sessionConversion.value, sessionConversion.count, sessionConversion.title], [Math.round((buyingSessions / sessions) * 1000) / 10, buyingSessions, 'Sessions that sent purchase']);
  assert.equal(gems.value, total(inCurrency('USD').filter((e) => e.attrs.item === 'gems_500')));
  // Coins carry no currency: a plain sum, whatever the game's money is in.
  const coinEvents = events.filter((e) => e.name === 'coins');
  assert.deepStrictEqual([coins.value, coins.currency, coins.mismatch], [total(coinEvents), null, undefined]);
  assert.equal(missing.empty, true);
  assert.match(missing.why, /refund/);
  assert.equal(noAttr.empty, true, 'paywall events have no amount');
  assert.match(noAttr.why, /"paywall" events have no "amount"/);
  // The dashboard's currency wins: now the dollars are the ones named.
  const [eur] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'stat', event: 'purchase', sum: 'amount' }] }), { currency: 'EUR' });
  assert.deepStrictEqual([eur.value, eur.currency, eur.mismatch], [total(inCurrency('EUR')), 'EUR', [{ currency: 'USD', sum: usd, events: inCurrency('USD').length }]]);
});

test('series and breakdowns by sum: revenue by item and by version, over time', () => {
  const ctx = ctxOf();
  const usd = inCurrency('USD');
  const [byItem, byVersion, overTime, itemsOverTime, onePerSeries] = evaluateBoard(
    ctx,
    validateBoard({
      panels: [
        { type: 'breakdown', event: 'purchase', sum: 'amount', by: 'item' },
        { type: 'breakdown', event: 'purchase', sum: 'amount', by: '$version' },
        { type: 'series', event: 'purchase', sum: 'amount' },
        { type: 'series', event: 'purchase', sum: 'amount', by: 'item', limit: 2 },
        { type: 'series', event: 'purchase:store=ios', sum: 'amount', by: '$version' },
      ],
    }),
  );
  const expected = (key) => {
    const m = new Map();
    for (const e of usd) m.set(String(e[key] ?? e.attrs[key]), r2((m.get(String(e[key] ?? e.attrs[key])) || 0) + e.attrs.amount));
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  assert.deepStrictEqual(byItem.rows.map((r) => [r.value, r.sum]), expected('item'));
  assert.equal(byItem.title, 'purchase amount by item');
  assert.equal(byItem.currency, 'USD');
  assert.equal(byItem.total, total(usd));
  assert.deepStrictEqual(
    byItem.rows.map((r) => r.count),
    byItem.rows.map((r) => purchases.filter((e) => e.attrs.item === r.value).length),
    'counts are every purchase of the item, in any currency',
  );
  assert.ok(byItem.mismatch[0].currency === 'EUR');
  assert.deepStrictEqual(byVersion.rows.map((r) => [r.value, r.sum]), expected('version'));
  assert.ok(byVersion.rows.every((r) => r.sessions > 0));
  const sumOf = (series) => r2(series.reduce((t, s) => t + s.values.reduce((a, b) => a + b, 0), 0));
  assert.deepStrictEqual([overTime.series.length, overTime.series[0].label, sumOf(overTime.series)], [1, 'amount', total(usd)]);
  assert.deepStrictEqual(itemsOverTime.series.map((s) => s.label), [...expected('item').slice(0, 2).map(([v]) => v), 'other']);
  assert.equal(sumOf(itemsOverTime.series), total(usd));
  assert.equal(sumOf(onePerSeries.series), total(usd.filter((e) => e.attrs.store === 'ios')));
});

test('versions compare revenue per session and player, and conversion', () => {
  const ctx = ctxOf();
  const stats = validateBoard({
    panels: [
      { type: 'stat', event: 'purchase', sum: 'amount' },
      { type: 'stat', event: 'purchase', sum: 'amount', per: '$players' },
      { type: 'stat', event: 'purchase', per: '$players' },
      { type: 'stat', event: 'purchase', per: '$sessions' },
    ],
  }).panels;
  const list = versions(ctx, { stats });
  for (const v of list) {
    const of = (e) => e.version === v.version;
    const usd = total(inCurrency('USD').filter(of));
    const vs = new Set(events.filter(of).map((e) => e.session_id)).size;
    const vp = new Set(events.filter(of).map((e) => e.player_id)).size;
    const pct = (a, b) => Math.round((a / b) * 1000) / 10;
    assert.deepStrictEqual(v.board, [r2(usd / vs), r2(usd / vp), pct(new Set(purchases.filter(of).map((e) => e.player_id)).size, vp), pct(new Set(purchases.filter(of).map((e) => e.session_id)).size, vs)], v.version);
  }
  assert.deepStrictEqual(
    versionColumns(stats, ctx).map((c) => [c.unit, c.currency ?? null]),
    [
      ['per session', 'USD'],
      ['per player', 'USD'],
      ['%', null],
      ['%', null],
    ],
  );
  // A dashboard's currency goes with its sum stats into the version comparison.
  const [sum] = dashboardStats({ currency: 'EUR', pages: [{ panels: stats }] });
  assert.equal(sum.currency, 'EUR');
  assert.equal(versionColumns([sum], ctx)[0].currency, 'EUR');
});

test('sums, per and currency are checked before they are saved', () => {
  const bad = (panel, re) => assert.throws(() => validateBoard({ panels: [panel] }), re, JSON.stringify(panel));
  bad({ type: 'stat', metric: 'players', sum: 'amount' }, /sum goes with event/);
  bad({ type: 'stat', event: 'purchase', sum: 'amount', per: 'paywall' }, /\$players or \$sessions/);
  bad({ type: 'stat', event: 'purchase', sum: '$version' }, /numeric attribute/);
  bad({ type: 'breakdown', event: 'purchase=gems_500', sum: 'amount', by: 'store' }, /event is a name only/);
  bad({ type: 'series', event: 'purchase:store=ios', sum: 'amount', by: 'item' }, /event is a name only/);
  // By $version a filtered event is fine: the cells are per version already.
  assert.deepStrictEqual(validateBoard({ panels: [{ type: 'series', event: 'purchase:store=ios', sum: 'amount', by: '$version' }] }).panels[0], { type: 'series', event: 'purchase:store=ios', sum: 'amount', by: '$version' });
  assert.deepStrictEqual(validateBoard({ panels: [{ type: 'stat', event: 'purchase', per: '$players' }] }).panels[0], { type: 'stat', event: 'purchase', per: '$players' });
  const pages = [{ title: 'Money', panels: [{ type: 'stat', event: 'purchase', sum: 'amount' }] }];
  assert.deepStrictEqual(validateDashboard({ currency: ' usd ', pages }).currency, 'USD');
  assert.equal('currency' in validateDashboard({ pages }), false);
  assert.throws(() => validateDashboard({ currency: 'dollars', pages }), /ISO 4217/);
});

test('a shared board hides sums unless its link was made to show them; conversion stays', () => {
  const ctx = ctxOf();
  const board = validateBoard({
    panels: [
      { type: 'stat', event: 'purchase', sum: 'amount' },
      { type: 'stat', event: 'purchase', per: '$players' },
      { type: 'breakdown', event: 'purchase', sum: 'amount', by: 'item' },
      { type: 'breakdown', event: 'purchase', by: 'item' },
      { type: 'versions' },
    ],
  });
  const [revenue, conversion, byItem, counts, byVersion] = evaluateBoard(ctx, board, { shared: true });
  assert.equal(revenue.empty, true);
  assert.match(revenue.why, /not shown on this shared board/);
  assert.equal(revenue.value, undefined);
  assert.equal(byItem.empty, true);
  assert.equal(byItem.rows, undefined);
  assert.ok(conversion.value > 0 && counts.rows.length, 'conversion and counts are shown');
  assert.deepStrictEqual(byVersion.columns.map((c) => !!c.hidden), [true, false]);
  assert.ok(byVersion.rows.every((r) => r.values[0] === null && r.values[1] != null));
  const shown = evaluateBoard(ctx, board, { shared: { sums: true } });
  assert.deepStrictEqual(shown, evaluateBoard(ctx, board), 'a link made with sums shows them as the board does');
});

test('sums ride in the rollup cells: exact in any merge order, kept apart per currency, capped', () => {
  const minutes = rollup(events);
  const cells = [...minutes.values()].flatMap((m) => [...m.values()]);
  const a = cells.reduce((into, c) => mergeCell(into, cellFromJSON(JSON.parse(JSON.stringify(cellToJSON(c))))), newCell());
  const b = [...cells].reverse().reduce((into, c) => mergeCell(into, c), newCell());
  assert.deepStrictEqual(a.evs, b.evs);
  assert.deepStrictEqual(a.evx, b.evx);
  assert.deepStrictEqual(a.evs[sumKey('purchase', 'amount', 'USD')], [Math.round(total(inCurrency('USD')) * 1000), inCurrency('USD').length]);
  assert.equal(a.evx[sumKey('purchase', 'amount', 'EUR', 'item', 'gems_500')]?.[0] ?? 0, Math.round(total(inCurrency('EUR').filter((e) => e.attrs.item === 'gems_500')) * 1000));
  // Cells without numbers carry no sums at all; a cell past its cap puts the rest under OTHER.
  assert.equal(rollup([{ type: 'custom', ts: NOW, name: 'open', attrs: { what: 'menu' } }]).values().next().value.values().next().value.evs, undefined);
  const many = Array.from({ length: MAX_EVENT_SUMS + 5 }, (_, i) => ({ type: 'custom', ts: NOW, name: `e${i}`, attrs: { n: 1 } }));
  const capped = rollup(many).values().next().value.values().next().value;
  assert.equal(Object.keys(capped.evs).length, MAX_EVENT_SUMS + 1);
  assert.deepStrictEqual(capped.evs[OTHER], [5000, 5]);
});

test('every event lists the sums of its numbers, per currency (glitchless_events)', () => {
  const sums = eventSums(ctxOf());
  assert.deepStrictEqual(
    sums.get('purchase').map((x) => [x.attr, x.currency, x.sum, x.events]),
    [
      ['amount', 'USD', total(inCurrency('USD')), inCurrency('USD').length],
      ['amount', 'EUR', total(inCurrency('EUR')), inCurrency('EUR').length],
    ],
  );
  assert.deepStrictEqual(sums.get('coins').map((x) => [x.attr, x.currency]), [['amount', null]]);
  assert.equal(sums.has('paywall'), false);
});

// Through the app: the dashboard keeps its currency, the events query lists sums, and two share links of one
// board, one made with sums and one without, each get their own answer at the same address.
test('the app keeps the currency, lists sums with events, and answers share links with and without sums apart', async () => {
  const SHARE = { id: 'share-1', service: 'zoomies', page: 'money' };
  const readers = {
    full: { projectId: 'A', scopes: ['read', 'dashboard'] },
    share: { projectId: 'A', scopes: ['read'], share: SHARE, keyId: 'share', rps: 1000 },
    sums: { projectId: 'A', scopes: ['read'], share: { ...SHARE, id: 'share-2', sums: true }, keyId: 'sums', rps: 1000 },
  };
  const auth = {
    resolveIngest: () => ({ projectId: 'A' }),
    resolveReader(req) {
      const reader = readers[req.headers['x-glitchless-api-key']];
      if (!reader) throw new AuthError(401, 'no');
      return reader;
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-sums-'));
  const server = http.createServer(createApp({ store: new FileStore(dir, { legacyProject: null }), auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, key) => (await fetch(base + p, { headers: { 'x-glitchless-api-key': key } })).json();
  try {
    const bySession = Map.groupBy(events, (e) => e.session_id);
    for (const list of bySession.values()) {
      const { service, env, version, session_id, player_id } = list[0];
      const res = await fetch(`${base}/v1/intake?token=any`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, sdk: 'test', events: list.map(({ service, env, version, session_id, player_id, ...e }) => e) }) });
      assert.equal(res.status, 202);
    }
    const money = { id: 'money', title: 'Money', panels: [{ type: 'stat', event: 'purchase', sum: 'amount' }, { type: 'stat', event: 'purchase', per: '$players' }, { type: 'stat', metric: 'sessions' }] };
    const put = await fetch(`${base}/v1/dashboard?service=zoomies`, { method: 'PUT', headers: { 'x-glitchless-api-key': 'full' }, body: JSON.stringify({ currency: 'eur', pages: [money] }) });
    assert.equal((await put.json()).dashboard.currency, 'EUR');
    const range = `from=${START - 60_000}&to=${NOW}`;
    assert.equal((await get(`/v1/query/dashboard?service=zoomies&${range}`, 'full')).dashboard.spec.currency, 'EUR');
    const board = (key) => get(`/v1/query/board?service=zoomies&page=money&${range}`, key);
    const full = (await board('full')).board.panels;
    assert.deepStrictEqual([full[0].value, full[0].currency], [total(inCurrency('EUR')), 'EUR'], "the dashboard's currency");
    const hidden = (await board('share')).board.panels;
    assert.equal(hidden[0].empty, true);
    assert.equal(hidden[1].value, full[1].value, 'conversion is shown');
    const shown = (await board('sums')).board.panels;
    assert.equal(shown[0].value, full[0].value);
    assert.equal((await board('share')).board.panels[0].empty, true, 'the cache keeps the two links apart');
    const listed = (await get(`/v1/query/events?service=zoomies&${range}`, 'full')).events.find((e) => e.name === 'purchase');
    assert.deepStrictEqual(listed.sums.map((x) => x.currency), ['USD', 'EUR']);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
