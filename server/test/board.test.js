// Dashboards and boards (board.js): every game gets a dashboard that fits it. A dashboard is its pages (boards
// or built-in views) and is checked before it is saved; a game without one gets an automatic dashboard made
// only of what it sends; dashboards are kept per game in every store, written with the dashboard scope and
// read with read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { buildContext, customEvents, eventFunnel, parseFunnel, versions } from '../src/analytics.js';
import { validateBoard, validateDashboard, autoBoard, autoDashboard, evaluateBoard, dashboardStats, versionColumns, BoardError } from '../src/board.js';
import { gameSessions } from './helpers/game-data.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = NOW - 2 * 3_600_000;

// A mobile game like Starlift: app opens, plays by mode, stops won and lost, the paywall and purchases.
// No frame windows, deaths or positions.
function mobileGame({ sessions = 12, service = 'starlift' } = {}) {
  const out = [];
  for (let i = 0; i < sessions; i++) {
    const base = { service, env: 'prod', version: '1.0.1', session_id: `m${i}`, player_id: `m${i}`, level: null };
    let ts = START + i * 300_000;
    const at = () => (ts += 7_000);
    const events = [{ type: 'session_start', ts, session_type: 'user', device: { browser: 'Godot', mobile: true } }];
    events.push({ type: 'custom', ts: at(), name: 'open', attrs: { what: i % 3 ? 'free' : 'full' } });
    for (let k = 0; k <= i % 3; k++) {
      events.push({ type: 'custom', ts: at(), name: 'play', attrs: { what: ['endless', 'voyage', 'daily'][(i + k) % 3] } });
      const stop = ['halcyon', 'glint', 'cinder'][(i + k) % 3];
      events.push({ type: 'level_start', ts: at(), level: stop });
      events.push(i % 4 === 0 && k === 0 ? { type: 'level_fail', ts: at(), level: stop, cause: 'lost' } : { type: 'level_complete', ts: at(), level: stop });
    }
    if (i % 2 === 0) events.push({ type: 'custom', ts: at(), name: 'paywall', attrs: { what: i % 4 ? 'settings' : 'world' } });
    if (i % 4 === 0) events.push({ type: 'custom', ts: at(), name: 'buy', attrs: { what: 'tapped' } });
    if (i % 8 === 0) events.push({ type: 'custom', ts: at(), name: 'buy', attrs: { what: 'done' } });
    events.push({ type: 'session_end', ts: at(), reason: 'pagehide' });
    out.push(events.map((e) => ({ ...base, ...e })));
  }
  return out;
}

const ctxOf = (events, service) => buildContext(events, { service, from: START - 60_000, to: NOW, type: 'all' });
const mobile = mobileGame().flat();
const platformer = gameSessions({ start: START, spanMs: 3_600_000, sessions: 10 })
  .flat()
  .map((e) => ({ ...e, service: 'zoomies' }));

test('a board is checked before it is saved, and says what to fix', () => {
  const good = validateBoard({
    title: 'Starlift',
    panels: [
      { type: 'stat', event: 'buy=done', per: 'paywall', title: 'Paywall conversion', size: 's', extra: 'dropped' },
      { type: 'series', event: 'open', by: 'what' },
      { type: 'funnel', steps: 'paywall, buy=tapped, buy=done' },
      { type: 'levels', label: 'Stop' },
    ],
  });
  assert.equal(good.panels.length, 4);
  assert.equal(good.panels[0].extra, undefined, 'unknown fields are dropped');
  const bad = [
    [{}, /panels/],
    [{ panels: [{ type: 'pie' }] }, /type must be one of/],
    [{ panels: [{ type: 'stat' }] }, /metric .* or event/],
    [{ panels: [{ type: 'stat', metric: 'revenue' }] }, /metric must be one of/],
    [{ panels: [{ type: 'breakdown', event: 'play' }] }, /needs by/],
    [{ panels: [{ type: 'funnel', steps: 'open' }] }, /at least two/],
    [{ panels: [{ type: 'series', event: 'a,b' }] }, /one event/],
    [{ panels: [{ type: 'levels', size: 'xl' }] }, /size/],
    [{ panels: [{ type: 'positions' }] }, /needs level/],
    [{ panels: [{ type: 'positions', level: 'cave', show: 'ghosts' }] }, /show must be one of deaths, path, both/],
    [{ panels: [{ type: 'positions', level: 'cave', bin: 0 }] }, /bin/],
    [{ panels: [{ type: 'positions', level: 'cave', bin: '5' }] }, /bin/],
  ];
  for (const [input, message] of bad) assert.throws(() => validateBoard(input), (err) => err instanceof BoardError && message.test(err.message), JSON.stringify(input));
});

// A side-scroller (z = 0) where players die in two pits and walk along y = 1, and a top-down game.
function deadGame({ level = 'cave', deaths = [], walk = [], service = 'dead-reckoning' } = {}) {
  return deaths.map(([x, y, z], i) => {
    const base = { service, env: 'prod', version: '0.1.0', session_id: `secret_${i}`, player_id: `player_${i}` };
    const ts = START + i * 1000;
    return [
      { ...base, type: 'session_start', ts },
      { ...base, type: 'level_start', ts: ts + 1, level },
      ...(walk.length ? [{ ...base, type: 'pos', ts: ts + 2, level, pts: walk.map((p, k) => [ts + 2 + k, ...p]) }] : []),
      { ...base, type: 'death', ts: ts + 3, level, x, y, z, cause: 'pit' },
    ];
  }).flat();
}

test('a positions panel: deaths counted per bin on the level plane, the busiest first, and paths on a coarser grid', () => {
  const deaths = [...Array(7).fill([12.2, 0.5, 0]), ...Array(3).fill([40.9, 0.5, 0]), [12.9, 0.4, 0]];
  const walk = Array.from({ length: 50 }, (_, k) => [k, 1, 0]);
  const ctx = ctxOf(deadGame({ deaths, walk }), 'dead-reckoning');
  const board = validateBoard({ panels: [{ type: 'positions', level: 'cave', bin: 1 }, { type: 'positions', level: 'cave', show: 'both' }, { type: 'positions', level: 'cave', show: 'path', bin: 10 }] });
  const [dead, both, path] = evaluateBoard(ctx, board);
  assert.equal(dead.title, 'Where players died on cave');
  assert.equal(dead.axis, 'xy', 'a side-scroller sends z = 0');
  assert.deepEqual(dead.deaths, [[12.5, 0.5, 8], [40.5, 0.5, 3]], 'bin centres on a fixed grid, the busiest first');
  assert.equal(dead.total, 11);
  assert.equal(dead.truncated, false);
  assert.deepEqual(dead.bounds, { min: [12, 0], max: [41, 1] }, 'rounded out to whole bins');
  assert.equal(dead.path, undefined, 'deaths only, by default');
  // Default bins: about a hundredth of the level (1, 2 or 5 times a power of ten); paths about 64 across.
  assert.equal(both.bin, 0.5);
  assert.equal(both.path.bin, 1);
  assert.equal(both.path.samples, 11 * 50);
  assert.equal(both.path.cells.length, 50);
  assert.ok(both.path.cells.every(([, b, n]) => b === 1.5 && n === 11));
  assert.equal(path.deaths, undefined, 'show path leaves deaths out');
  assert.equal(path.bin, 10);
  assert.deepEqual(path.path.cells.map((c) => c[2]), [110, 110, 110, 110, 110]);

  // A top-down game: its deaths leave z = 0, so the plane is xz, whatever y (height) says.
  const top = ctxOf(deadGame({ deaths: [[3, 9, 7.5], [3.2, 2, 7.9]] }), 'dead-reckoning');
  const [flat] = evaluateBoard(top, { panels: [{ type: 'positions', level: 'cave', bin: 1 }] });
  assert.equal(flat.axis, 'xz');
  assert.deepEqual(flat.deaths, [[3.5, 7.5, 2]]);

  // A captured map gives the plane and the bounds.
  const map = { level: 'cave', axis: 'xz', bounds: { min: [-100, -100], max: [100, 100] }, image: 'data:image/png;base64,AA', ts: START };
  const [mapped] = evaluateBoard(ctx, { panels: [{ type: 'positions', level: 'cave', bin: 1 }] }, { maps: [map] });
  assert.equal(mapped.axis, 'xz');
  assert.deepEqual(mapped.bounds, map.bounds);
  assert.equal(JSON.stringify(mapped).includes('base64'), false, 'not the map picture: a game polls this');

  // At most 2,000 bins, the busiest.
  const many = ctxOf(deadGame({ deaths: Array.from({ length: 2100 }, (_, i) => [i, 0, 0]).concat([[5, 0, 0]]) }), 'dead-reckoning');
  const [capped] = evaluateBoard(many, { panels: [{ type: 'positions', level: 'cave', bin: 1 }] });
  assert.equal(capped.deaths.length, 2000);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.deaths[0], [5.5, 0.5, 2]);
  assert.equal(capped.total, 2101);
});

test('a positions panel with nothing to place says why', () => {
  const ctx = ctxOf(deadGame({ deaths: [[1, 1, 0]] }).map((e) => (e.type === 'death' ? { ...e, x: undefined, y: undefined, z: undefined } : e)), 'dead-reckoning');
  const [noCoords, noLevel, noPath, nothing] = evaluateBoard(ctx, { panels: [{ type: 'positions', level: 'cave' }, { type: 'positions', level: 'moon' }, { type: 'positions', level: 'cave', show: 'path' }, { type: 'positions', level: 'moon', show: 'both' }] });
  assert.deepEqual([noCoords.empty, noCoords.why], [true, 'Deaths on cave have no positions: the game sends them without x and y.']);
  assert.deepEqual([noLevel.empty, noLevel.why], [true, 'No deaths on moon in this window.']);
  assert.match(noPath.why, /No positions from cave/);
  assert.match(nothing.why, /No deaths or positions on moon/);
  assert.equal(noCoords.deaths, undefined);
});

test('a dashboard is pages, each a board or a built-in view, and says what to fix', () => {
  const good = validateDashboard({
    pages: [
      { title: 'Overview', panels: [{ type: 'stat', metric: 'players' }] },
      { id: 'Money!', title: 'Paywall and purchases', icon: 'bolt', panels: [{ type: 'funnel', steps: 'paywall,buy=done' }, { type: 'sessions', sent: 'buy=done', limit: 5 }] },
      { view: 'live', title: 'Purchases, live', options: { events: ['buy', 'paywall'] } },
      { view: 'errors' },
    ],
  });
  assert.deepStrictEqual(good.pages.map((p) => p.id), ['overview', 'money', 'live', 'errors']);
  assert.equal(good.pages[3].title, 'Errors', 'a view keeps its built-in title unless it is given one');
  assert.deepStrictEqual(good.pages[2].options, { events: ['buy', 'paywall'] });
  const bad = [
    [{}, /pages/],
    [{ pages: [] }, /pages/],
    [{ pages: [{ title: 'A' }] }, /either a board/],
    [{ pages: [{ title: 'A', view: 'errors', panels: [] }] }, /either a board/],
    [{ pages: [{ view: 'retention' }] }, /view must be one of/],
    [{ pages: [{ panels: [{ type: 'stat', metric: 'players' }] }] }, /needs a title/],
    [{ pages: [{ view: 'errors' }, { view: 'errors' }] }, /used twice/],
    [{ pages: [{ title: 'A', icon: 'unicorn', panels: [{ type: 'errors' }] }] }, /icon/],
    [{ pages: [{ title: 'A', panels: [{ type: 'pie' }] }] }, /pages\[0\]\.panels\[0\]\.type/],
    [{ pages: [{ view: 'live', options: { events: 'buy' } }] }, /list of up to 20/],
  ];
  for (const [input, message] of bad) assert.throws(() => validateDashboard(input), (err) => err instanceof BoardError && message.test(err.message), JSON.stringify(input));
});

test("the automatic dashboard has only the pages a game has data for", () => {
  const ids = (events, service) => autoDashboard(ctxOf(events, service)).pages.map((p) => p.id);
  assert.deepStrictEqual(ids(mobile, 'starlift'), ['overview', 'events', 'errors', 'players', 'sessions', 'versions', 'live'], 'no Performance or Heatmaps for a game without frames or positions');
  const p = ids(platformer, 'zoomies');
  for (const page of ['overview', 'performance', 'heatmaps', 'live']) assert.ok(p.includes(page), `${page} for a platformer`);
  assert.ok(validateDashboard(autoDashboard(ctxOf(platformer, 'zoomies'))), 'the automatic dashboard is a valid dashboard');
});

test("the automatic board is made of what the game sends: a mobile game gets its own events, not deaths or frame times", () => {
  const types = (events, service) => autoBoard(ctxOf(events, service)).panels.map((p) => p.type + (p.metric ? `:${p.metric}` : p.event ? `:${p.event}` : ''));
  const m = types(mobile, 'starlift');
  assert.deepStrictEqual(m.slice(0, 3), ['stat:sessions', 'stat:players', 'stat:avg_session_s']);
  for (const e of ['play', 'open', 'paywall', 'buy']) assert.ok(m.some((t) => t.endsWith(`:${e}`)), `${e} has a panel`);
  assert.ok(m.includes('levels'));
  for (const absent of ['frame_time', 'deaths', 'stat:frame_p95']) assert.ok(!m.includes(absent), `no ${absent} for a game that sends none`);
  const p = types(platformer, 'zoomies');
  for (const present of ['stat:frame_p95', 'frame_time', 'deaths', 'levels']) assert.ok(p.includes(present), `${present} for a platformer`);
});

test("a saved board's panels answer in the game's own terms", () => {
  const ctx = ctxOf(mobile, 'starlift');
  const panels = evaluateBoard(
    ctx,
    validateBoard({
      panels: [
        { type: 'stat', event: 'buy=done' },
        { type: 'stat', event: 'buy:what=tapped' },
        { type: 'stat', event: 'buy=done', per: 'paywall', title: 'Paywall → purchase' },
        { type: 'series', event: 'open', by: 'what' },
        { type: 'breakdown', event: 'play', by: 'what' },
        { type: 'funnel', steps: 'open,paywall,buy=tapped,buy=done' },
        { type: 'levels', label: 'Stop' },
        { type: 'stat', event: 'refund' },
        { type: 'frame_time' },
      ],
    }),
  );
  const [done, tapped, conversion, opens, plays, funnel, stops, refunds, frames] = panels;
  assert.equal(done.value, 2);
  assert.equal(tapped.value, 3);
  assert.equal(conversion.value, round((2 / 6) * 100));
  assert.equal(conversion.unit, '%');
  assert.deepStrictEqual(opens.series.map((s) => s.label).sort(), ['free', 'full']);
  assert.equal(opens.series.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0), 12);
  assert.deepStrictEqual(plays.rows.map((r) => r.value).sort(), ['daily', 'endless', 'voyage']);
  assert.deepStrictEqual(funnel.steps.map((s) => s.sessions), [12, 6, 3, 2]);
  assert.equal(stops.title, 'Stops');
  assert.deepStrictEqual(stops.has, { completion: true, fails: true, deaths: false, time: false, rage_quits: false, disconnects: false }, 'no deaths column for a game without deaths');
  assert.equal(refunds.empty, true, 'an event the game never sent is empty, not zero');
  assert.match(refunds.why, /refund/);
  assert.equal(frames.empty, true);
});

test("versions compare the board's own numbers, and a board can split any event by $version", () => {
  // Version 1.1 shows the paywall to the same players, and three times as many of them buy.
  const events = [];
  let i = 0;
  for (const [version, buyers] of [['1.0', 1], ['1.1', 3]]) {
    for (let k = 0; k < 4; k++) {
      const base = { service: 'starlift', env: 'prod', version, session_id: `v${i}`, player_id: `v${i}`, level: null };
      const t = START + i++ * 60_000;
      events.push({ ...base, type: 'session_start', ts: t }, { ...base, type: 'custom', name: 'paywall', attrs: { where: 'shop' }, ts: t + 1000 });
      if (k < buyers) events.push({ ...base, type: 'custom', name: 'buy', attrs: { step: 'done' }, ts: t + 2000 });
    }
  }
  const ctx = ctxOf(events, 'starlift');
  const stats = [{ type: 'stat', event: 'buy=done', per: 'paywall' }, { type: 'stat', event: 'paywall' }, { type: 'stat', metric: 'crash_free_pct' }];
  const list = versions(ctx, { stats });
  assert.deepStrictEqual(list.map((v) => [v.version, v.board]), [['1.0', [25, 1, 100]], ['1.1', [75, 1, 100]]]);
  assert.deepStrictEqual(list[1].events, { paywall: 1, buy: 0.75 });
  const [byVersion, series] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'breakdown', event: 'buy=done', by: '$version' }, { type: 'series', event: 'buy', by: '$version' }] }));
  assert.deepStrictEqual(byVersion.rows.map((r) => [r.value, r.count, r.sessions]), [['1.1', 3, 3], ['1.0', 1, 1]]);
  assert.equal(byVersion.title, 'buy=done by version');
  assert.deepStrictEqual(series.series.map((s) => s.label).sort(), ['1.0', '1.1']);
  // Per level, sessions can't be known from the cells: unknown, not zero.
  const [byLevel] = evaluateBoard(ctxOf(mobile, 'starlift'), validateBoard({ panels: [{ type: 'breakdown', event: 'play', by: '$level' }] }));
  assert.ok(byLevel.rows.length && byLevel.rows.every((r) => r.sessions === null), JSON.stringify(byLevel.rows));
  // A name that can't be a session property (it names a person) isn't a split.
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'buy', by: '$email' }] }), /\$version, \$level, \$zone, \$platform, \$browser, \$device_tier, \$link, or a session property/);
});

test('built-in sections as panels: findings, sessions that sent an event, versions and live', () => {
  const ctx = ctxOf(mobile, 'starlift');
  const board = validateBoard({
    panels: [
      { type: 'stat', event: 'buy=done', per: 'paywall', title: 'Paywall to purchase' },
      { type: 'stat', metric: 'errors' },
      { type: 'sessions', sent: 'buy=done' },
      { type: 'sessions', limit: 3 },
      { type: 'versions' },
      { type: 'live', events: ['buy'] },
      { type: 'findings' },
    ],
  });
  const [, , buyers, recent, byVersion, live, found] = evaluateBoard(ctx, board);
  assert.deepStrictEqual(buyers.sessions.map((s) => s.session_id).sort(), ['m0', 'm8']);
  assert.equal(buyers.title, 'Sessions that sent buy=done');
  assert.equal(recent.sessions.length, 3);
  assert.deepStrictEqual(byVersion.columns.map((c) => [c.title, c.unit]), [['Paywall to purchase', '%'], ['Errors', 'per session']]);
  assert.deepStrictEqual(byVersion.rows.map((r) => [r.version, r.values[0]]), [['1.0.1', round((2 / 6) * 100)]]);
  assert.deepStrictEqual([live.live, live.events, live.size], [true, ['buy'], 'l']);
  assert.ok(found.findings || found.empty);
  // Versions are compared on the stats of every board, once each.
  const stats = dashboardStats({ pages: [{ panels: board.panels }, { view: 'errors' }, { panels: [{ type: 'stat', metric: 'errors' }, { type: 'stat', event: 'open' }] }] });
  assert.deepStrictEqual(versionColumns(stats).map((c) => c.title), ['Paywall to purchase', 'Errors', 'open']);
});

test('custom events: counts, sessions, attribute breakdowns and an ordered funnel', () => {
  const ctx = ctxOf(mobile, 'starlift');
  const { events, sessions } = customEvents(ctx);
  assert.equal(sessions, 12);
  const buy = events.find((e) => e.name === 'buy');
  assert.equal(buy.count, 5);
  assert.equal(buy.sessions, 3);
  assert.deepStrictEqual(buy.attrs[0].values.map((v) => [v.value, v.count, v.sessions]), [['tapped', 3, 3], ['done', 2, 2]]);
  // Order matters: nobody bought before opening, and "done" never comes before "tapped".
  assert.deepStrictEqual(eventFunnel(ctx, parseFunnel('buy=done,buy=tapped')).map((s) => s.sessions), [2, 0]);
});

const KEYS = { writer: 'gl_sk_writer', reader: 'gl_sk_reader', other: 'gl_sk_other' };
const auth = {
  resolveIngest() {
    return { projectId: 'p1' };
  },
  resolveReader(req) {
    const key = req.headers['x-glitchless-api-key'];
    if (key === KEYS.writer) return { projectId: 'p1', scopes: ['read', 'dashboard'] };
    if (key === KEYS.reader) return { projectId: 'p1', scopes: ['read'] };
    if (key === KEYS.other) return { projectId: 'p2', scopes: ['read', 'dashboard'] };
    throw new AuthError(401, 'no key');
  },
};
for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a dashboard is saved per game with the dashboard scope, read with read, and reset to automatic`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, key, body) => {
      const res = await fetch(base + p, { method, headers: { 'x-glitchless-api-key': key, 'x-glitchless-client': 'test' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() };
    };
    try {
      for (const events of mobileGame({ sessions: 4 })) {
        const { service, env, version, session_id, player_id } = events[0];
        await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: events.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
      }
      await settle?.();
      const dashboard = {
        pages: [
          { title: 'Overview', panels: [{ type: 'stat', metric: 'sessions' }, { type: 'breakdown', event: 'play', by: 'what' }] },
          { id: 'money', title: 'Money', panels: [{ type: 'stat', event: 'buy=done', per: 'paywall' }, { type: 'funnel', steps: 'paywall,buy=done' }] },
          { view: 'live', title: 'Live Tail' },
        ],
      };
      assert.equal((await call('PUT', '/v1/dashboard?service=starlift', KEYS.reader, dashboard)).status, 403, 'read alone cannot change a dashboard');
      assert.equal((await call('PUT', '/v1/dashboard?service=starlift', KEYS.writer, { pages: [{ title: 'A', panels: [{ type: 'pie' }] }] })).status, 400);
      const saved = await call('PUT', '/v1/dashboard?service=starlift', KEYS.writer, dashboard);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.dashboard.updated_by, 'test');
      const range = `service=starlift&from=${START - 3_600_000}&to=${Date.now() + 1}`;
      const pages = await call('GET', `/v1/query/dashboard?${range}`, KEYS.reader);
      assert.equal(pages.body.dashboard.source, 'saved');
      assert.deepStrictEqual(pages.body.dashboard.pages.map((p) => [p.id, p.view ?? p.panels]), [['overview', 2], ['money', 2], ['live', 'live']]);
      const first = await call('GET', `/v1/query/board?${range}`, KEYS.reader);
      assert.equal(first.body.board.page, 'overview', 'without a page, the first board');
      assert.deepStrictEqual(first.body.board.panels.map((p) => p.type), ['stat', 'breakdown']);
      const money = await call('GET', `/v1/query/board?${range}&page=money`, KEYS.reader);
      assert.equal(money.body.board.title, 'Money');
      assert.equal(money.body.board.panels[1].steps[0].sessions, 2);
      assert.match((await call('GET', `/v1/query/board?${range}&page=live`, KEYS.reader)).body.error, /built-in live view/);
      const vs = await call('GET', `/v1/query/versions?${range}`, KEYS.reader);
      assert.deepStrictEqual(vs.body.board.map((c) => c.unit), [null, '%'], "versions compare every board's stats");
      assert.equal((await call('GET', '/v1/dashboard?service=starlift', KEYS.other)).body.dashboard, null, "another project never sees this game's dashboard");
      assert.equal((await call('GET', '/v1/dashboard?service=zoomies', KEYS.reader)).body.dashboard, null, 'dashboards are per game');
      assert.equal((await call('DELETE', '/v1/dashboard?service=starlift', KEYS.writer)).status, 200);
      const auto = await call('GET', `/v1/query/dashboard?${range}`, KEYS.reader);
      assert.equal(auto.body.dashboard.source, 'auto');
      assert.equal(auto.body.dashboard.pages[0].id, 'overview');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });

  // A store that keeps summaries reads paths apart (q.positions): every position sample still counts.
  test(`${kind} store: a positions panel places every death and, for the levels it draws paths of, every position`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, key, body) => {
      const res = await fetch(base + p, { method, headers: { 'x-glitchless-api-key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() };
    };
    try {
      const sessions = gameSessions({ start: START, spanMs: 3_600_000, sessions: 10 });
      for (const events of sessions) {
        const { service, env, version, session_id, player_id } = events[0];
        await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: events.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
      }
      await settle?.();
      const service = sessions[0][0].service;
      const panels = [{ type: 'positions', level: 'level-1', show: 'both' }, { type: 'positions', level: 'level-2' }];
      assert.equal((await call('PUT', `/v1/dashboard?service=${service}`, KEYS.writer, { pages: [{ id: 'dead', title: 'The dead', panels }] })).status, 200);
      const { body } = await call('GET', `/v1/query/board?service=${service}&from=${START - 3_600_000}&to=${Date.now() + 1}`, KEYS.reader);
      const inRange = (e) => e.ts >= body.meta.from && e.ts <= body.meta.to;
      const all = sessions.flat().filter(inRange);
      const [one, two] = body.board.panels;
      for (const [p, level] of [[one, 'level-1'], [two, 'level-2']]) {
        const placed = all.filter((e) => e.type === 'death' && e.level === level).length;
        assert.ok(placed > 0, `the test data has deaths on ${level}`);
        assert.equal(p.total, placed, `${kind}: deaths on ${level}`);
        assert.equal(p.deaths.reduce((n, d) => n + d[2], 0), placed);
        assert.equal(p.axis, 'xz');
      }
      const samples = all.filter((e) => e.type === 'pos' && e.level === 'level-1').reduce((n, e) => n + e.pts.length, 0);
      assert.ok(samples > 0);
      assert.equal(one.path.samples, samples, `${kind}: every position on level-1`);
      assert.equal(two.path, undefined);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}

function round(v) {
  return Math.round(v * 10) / 10;
}

test('a breakdown or series by $platform: the sessions on each platform, or an event split by the platform of the sessions that sent it', () => {
  // Starlift on iOS and Android (two of every three sessions on iOS), anonymous; one Android session taps 20 times.
  const sessions = mobileGame().map((s, i) => s.map((e) => (e.type === 'session_start' ? { ...e, device: { ...e.device, os: i % 3 ? 'iOS' : 'Android' } } : e)));
  const tapper = sessions[0];
  const t0 = tapper[0].ts;
  tapper.splice(1, 0, ...Array.from({ length: 20 }, (_, k) => ({ ...tapper[1], type: 'custom', name: 'tap', attrs: { what: k % 2 ? 'left' : 'right' }, ts: t0 + 1000 + k * 30_000 })));
  const ctx = ctxOf(sessions.flat(), 'starlift');
  const board = validateBoard({
    panels: [
      { type: 'breakdown', by: '$platform' },
      { type: 'breakdown', event: 'buy=tapped', by: '$platform' },
      { type: 'series', by: '$platform' },
      { type: 'series', event: 'tap', by: '$platform' },
      { type: 'series', event: 'tap=left', by: '$platform', title: 'Left taps' },
      { type: 'breakdown', event: 'nope', by: '$platform' },
    ],
  });
  const [sessionsBy, tapped, playing, taps, left, nope] = evaluateBoard(ctx, board);
  assert.deepEqual([sessionsBy.title, sessionsBy.counts, sessionsBy.rows.map((r) => [r.value, r.sessions, r.players])], ['Sessions by platform', 'sessions', [['iOS', 8, null], ['Android', 4, null]]], 'no player IDs: sessions only');
  assert.equal(sessionsBy.total, 12);
  // buy=tapped: sessions m0, m4 and m8 (Android, iOS, iOS).
  assert.deepEqual([tapped.title, tapped.counts, tapped.rows.map((r) => [r.value, r.count, r.sessions])], ['buy=tapped by platform', 'events', [['iOS', 2, 2], ['Android', 1, 1]]]);
  assert.deepEqual(playing.series.map((s) => s.label), ['iOS', 'Android']);
  assert.ok(playing.series[0].values.reduce((a, b) => a + b, 0) >= 8);
  // 20 taps: the first 16 where they were sent, 4 spread over the minutes after.
  assert.deepEqual([taps.series.map((s) => s.label), taps.series[0].values.reduce((a, b) => a + b, 0), taps.spread], [['Android'], 20, 4]);
  assert.deepEqual([left.title, left.series[0].values.reduce((a, b) => a + b, 0)], ['Left taps', 10]);
  assert.equal(nope.empty, true);

  // With player IDs, players too.
  const known = sessions.map((s, i) => s.map((e) => ({ ...e, player_id: `p${i % 5}` })));
  const [withPlayers] = evaluateBoard(ctxOf(known.flat(), 'starlift'), validateBoard({ panels: [{ type: 'breakdown', by: '$platform' }] }));
  assert.deepEqual(withPlayers.rows.map((r) => [r.value, r.sessions, r.players]), [['iOS', 8, 5], ['Android', 4, 4]]);
  assert.equal(withPlayers.players, 5, 'a player on both platforms counted once');

  // What a board with $platform can't do.
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'buy', by: '$platform', sum: 'amount' }] }), /a sum can't be split by \$platform/);
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', by: 'what' }] }), /needs event/);
  assert.throws(() => validateBoard({ panels: [{ type: 'series', by: '$platform', sum: 'amount' }] }), /sum goes with event/);
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'buy', by: '$user_id' }] }), /\$version, \$level, \$zone, \$platform, \$browser, \$device_tier, \$link, or a session property/);
  assert.throws(() => validateBoard({ panels: [{ type: 'series', event: 'buy', by: '$browser', sum: 'amount' }] }), /a sum can't be split by \$browser/);
  // Over 31 days, answered by day without each session: it says so.
  const [daily] = evaluateBoard({ ...ctx, daily: { all: { n: 12 } } }, validateBoard({ panels: [{ type: 'breakdown', by: '$platform' }] }));
  assert.match(daily.why, /over 31 days or less/);
});

test('a split by $platform, $browser or $device_tier names each plainly: Steam hardware, OS names, engines that are not browsers, GPU tiers high to low', () => {
  const devices = [
    { os: 'Windows', browser: 'Chrome', gpu_tier: 'high' },
    { os: 'Windows', browser: 'Edge', gpu_tier: 'mid' },
    { os: 'macOS', browser: 'Safari', gpu_tier: 'mid' },
    { os: 'Mac OS X', browser: 'Firefox', gpu_tier: 'mid' },
    { os: 'Windows', browser: 'Godot', gpu_tier: 'low', steam_deck: true },
    { os: 'Windows', browser: 'Unreal', gpu_tier: 'high', steam_hardware: 'machine' },
    { os: 'Linux', browser: 'Godot', gpu_tier: 'mid' },
    { os: 'iOS', browser: 'Godot', gpu_tier: 'low' },
    { os: 'Android', browser: 'Unity', gpu_tier: 'low' },
    { os: 'Web', browser: 'Unity', gpu_tier: 'software' },
    { browser: 'Chrome' },
  ];
  const events = devices.flatMap((device, i) => {
    const base = { service: 'any', env: 'prod', version: '1.0.0', session_id: `d${i}`, player_id: `p${i}`, level: null };
    const ts = START + i * 60_000;
    return [{ ...base, type: 'session_start', ts, session_type: 'user', device }, { ...base, type: 'custom', ts: ts + 1000, name: 'open', attrs: {} }, { ...base, type: 'session_end', ts: ts + 5000, reason: 'pagehide' }];
  });
  const ctx = ctxOf(events, 'any');
  const [platforms, browsers, tiers, opens] = evaluateBoard(
    ctx,
    validateBoard({ panels: [{ type: 'breakdown', by: '$platform' }, { type: 'breakdown', by: '$browser', limit: 20 }, { type: 'breakdown', by: '$device_tier' }, { type: 'series', event: 'open', by: '$device_tier' }] }),
  );
  const rows = (p) => Object.fromEntries(p.rows.map((r) => [r.value, r.sessions]));
  assert.deepEqual(rows(platforms), { Windows: 2, macOS: 2, 'Steam Deck': 1, 'Steam Machine': 1, Linux: 1, iOS: 1, Android: 1, Web: 1, unknown: 1 });
  assert.deepEqual(rows(browsers), { Chrome: 2, Edge: 1, Safari: 1, Firefox: 1, 'Godot app': 3, 'Unreal app': 1, 'Unity app': 1, 'Unity web build': 1 });
  assert.deepEqual([browsers.title, tiers.title, opens.title], ['Sessions by browser', 'Sessions by device tier', 'open by device tier']);
  // Tiers in their order, high to low, whatever their counts.
  assert.deepEqual(tiers.rows.map((r) => [r.value, r.sessions]), [['High-end GPU', 2], ['Mid-range GPU', 4], ['Low-end GPU', 3], ['Software rendering (no GPU)', 1], ['Unknown GPU', 1]]);
  assert.deepEqual([tiers.split, tiers.players], ['device tier', 11]);
  assert.deepEqual(opens.series.map((s) => s.label), ['High-end GPU', 'Mid-range GPU', 'Low-end GPU', 'Software rendering (no GPU)', 'Unknown GPU']);
  assert.equal(opens.series.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0), 11);
  const [daily] = evaluateBoard({ ...ctx, daily: { all: { n: 11 } } }, validateBoard({ panels: [{ type: 'breakdown', by: '$browser' }] }));
  assert.equal(daily.why, "Split by $browser over 31 days or less: longer ranges are answered by day, without each session's browser.");
});
