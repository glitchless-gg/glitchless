// Daily rollups (daily.js): ranges of more than 31 days are answered in whole days from per-day rollups the
// compactor builds once a day has closed, plus the hour summaries for days not yet built. At day
// resolution they must give what the raw events give, counting each session on the day it started (with
// all its events, past midnight too) and every event-time number from the events of the range. Sketches
// are exact while small, so on this data everything matches exactly; with tiny caps the answers name
// what is approximate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sessionContext, indexSessions, wantedCell, overview, performance, versions, players, customEvents, eventFunnel, parseFunnel, errorIssues, sessionsList, funnel } from '../src/analytics.js';
import { cellList, rollup } from '../src/rollups.js';
import { foldFacts } from '../src/facts.js';
import { findings } from '../src/findings.js';
import { autoBoard, evaluateBoard, validateBoard } from '../src/board.js';
import { eventSums } from '../src/sums.js';
import { sessionDay, foldDay, CAPS } from '../src/daily.js';
import { Distinct, Sample, QMap, repeatedIds } from '../src/sketches.js';
import { createApp } from '../src/app.js';
import { gameSessions, shopSessions } from './helpers/game-data.js';
import { lakeSim, arrivals, needsDuckDB } from './helpers/lake-sim.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// The compactor's first run is the day before D0, so it keeps daily rollups from D0 on.
const D0 = Math.floor(Date.now() / DAY) * DAY - 12 * DAY;
const T0 = D0 - 2 * HOUR;
const P = 'proj_d';
const SERVICE = 'zoomies';

// Sessions that retry a level and keep dying at one spot on it; every other one quits right after a
// death (a rage quit): a difficulty spike.
function spikeSessions(start, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let ts = start + i * 97 * MINUTE;
    const base = { service: SERVICE, env: 'prod', version: '1.0.1', session_id: `k_${i}`, player_id: `p_${i % 5}`, sdk: 'glitchless-browser/0.1.0', level: null };
    const events = [];
    const push = (e) => events.push({ ...base, ...e, ts: (ts += 1500) });
    push({ type: 'session_start', session_type: 'user', device: { gpu_tier: 'low', browser: 'Chrome', gpu: 'UHD 620' } });
    for (let a = 0; a < 3; a++) {
      push({ type: 'level_start', level: 'level-2' });
      push({ type: 'death', level: 'level-2', x: 10 + ((a + i) % 3) * 0.5, y: 0, z: 5, cause: 'fell' });
      if (a < 2 || i % 2 === 0) push({ type: 'level_fail', level: 'level-2', cause: 'fell' });
    }
    if (i % 2) push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

// Three days of play, sessions that run past midnight, late batches.
const sessions = [
  ...gameSessions({ start: D0 + 20 * MINUTE, spanMs: 3 * DAY - HOUR, sessions: 150, seed: 21 }),
  ...gameSessions({ start: D0 + DAY - 4 * MINUTE, spanMs: 3 * MINUTE, sessions: 4, seed: 22, prefix: 'x' }),
  ...gameSessions({ start: D0 + 2 * DAY - 6 * MINUTE, spanMs: 5 * MINUTE, sessions: 4, seed: 23, prefix: 'y' }),
  ...spikeSessions(D0 + HOUR, 30),
  ...shopSessions({ service: SERVICE, start: D0 + 30 * MINUTE, spanMs: 3 * DAY - 2 * HOUR, sessions: 60 }),
];
const all = arrivals(sessions, { project: P, late: 0.04 });
// Snapshots are taken while the third day is still open. The after-midnight batches of a session that
// started before midnight arrive later still, after both its days were built: the day it started on is
// built again (the next morning's hours belong to it too).
const MIDWAY = D0 + 2 * DAY + 5 * HOUR;
const HELD_AT = D0 + 2 * DAY + 12 * HOUR;
const late = (b) => b.events[0].session_id === 'x_1' && Math.min(...b.events.map((e) => e.ts)) >= D0 + DAY;
const early = all.filter((b) => !late(b) && b.at < MIDWAY);
const rest = all.filter((b) => !late(b) && b.at >= MIDWAY);
const held = all.filter(late).map((b) => ({ ...b, at: HELD_AT }));

const FILTERS = [{}, { env: 'prod' }, { version: '1.0.1' }, { env: 'dev', version: '1.1.0' }];
const QUERIES = {
  overview: (ctx) => overview(ctx),
  performance: (ctx) => performance(ctx),
  versions: (ctx) => versions(ctx, { stats: [{ metric: 'errors' }, { event: 'enemy_spawn' }, { event: 'bone_collected=big', per: 'bone_collected' }] }),
  findings: (ctx) => findings(ctx, []),
  players: (ctx) => players(ctx),
  errors: (ctx) => errorIssues(ctx),
  sessions: (ctx) => sessionsList(ctx),
  sent: (ctx) => sessionsList(ctx, { limit: 20, sent: parseFunnel('enemy_spawn:boss=true')[0] }),
  funnel: (ctx) => funnel(ctx),
  events: (ctx) => ({ ...customEvents(ctx), funnel: eventFunnel(ctx, parseFunnel('enemy_spawn,bone_collected=big,enemy_spawn:boss=true')) }),
  board: (ctx) => evaluateBoard(ctx, autoBoard(ctx)),
  sums: (ctx) => ({ board: evaluateBoard(ctx, SUMS), versions: versions(ctx, { stats: SUMS.panels.filter((p) => p.type === 'stat') }).map((v) => v.board), events: [...eventSums(ctx)] }),
};
// Revenue, revenue per player, conversion and sums split by item, version and level, over time.
const SUMS = validateBoard({
  panels: [
    { type: 'stat', event: 'purchase', sum: 'amount' },
    { type: 'stat', event: 'purchase', sum: 'amount', per: '$players' },
    { type: 'stat', event: 'purchase', per: '$players' },
    { type: 'stat', event: 'purchase:item=gems_500', per: '$sessions' },
    { type: 'stat', event: 'purchase:store=ios', sum: 'amount' },
    { type: 'series', event: 'purchase', sum: 'amount', by: 'item' },
    { type: 'breakdown', event: 'purchase', sum: 'amount', by: 'item' },
    { type: 'breakdown', event: 'purchase', sum: 'amount', by: '$version' },
    { type: 'series', event: 'bone_collected', sum: 'points', by: '$level' },
    { type: 'breakdown', event: 'enemy_spawn', sum: 'points', by: 'boss' },
  ],
});
const json = (x) => JSON.parse(JSON.stringify(x));
// The app query each comparison stands for (the store reads what that query shows).
const appQuery = (name) => ({ sent: 'sessions', funnel: 'players', sums: 'board' })[name] || name;
// Findings' advice names the engine of the sessions it is about; a daily context only knows the engine of
// most of the range's sessions (this data mixes two SDKs in one game), so advice is left out of the comparison.
const comparable = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'suggestion' ? undefined : v)));
const query = (from, to, f = {}) => ({ service: SERVICE, from, to, env: f.env || null, version: f.version || null, type: 'all', sessions: null });

// The events a raw store would hold after these batches: in arrival order, stably sorted by time.
function eventsOf(batches) {
  return [...batches]
    .sort((a, b) => a.at - b.at)
    .flatMap((b) => b.events.map((e) => ({ ...e, project_id: P })))
    .map((e, i) => [e, i])
    .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
    .map(([e]) => e);
}

// The raw answer at day resolution for the range a daily context answered: sessions that started in it
// with all their events up to its end, cells and facts of its events.
function rawDaily(ctx, q, reference) {
  const lo = ctx.from;
  const hi = ctx.to + 1;
  const events = reference.filter((e) => e.ts < hi);
  const started = [...indexSessions(events)].filter(([, s]) => sessionDay(s) >= lo && sessionDay(s) < hi).sort((a, b) => a[1].first_ts - b[1].first_ts);
  const raw = sessionContext({ ...q, from: lo, to: hi - 1 }, new Map(started));
  raw.events = events.filter((e) => raw.sessions.has(e.session_id));
  const inRange = events.filter((e) => e.ts >= lo);
  raw.cells = cellList(rollup(inRange), wantedCell(q));
  raw.facts = cellList(foldFacts(inRange), wantedCell(q));
  raw.cohorts = cohortsOf(reference);
  return raw;
}

// Who a store's first-seen index says is new on each day (FileStore.cohorts, the compactor's D items): every
// player with an ID, under the UTC day of their first event.
export function cohortsOf(events) {
  const first = new Map();
  for (const e of events) if (e.player_id !== e.session_id && !(first.get(e.player_id) <= e.ts)) first.set(e.player_id, e.ts);
  const out = new Map();
  for (const [id, ts] of first) {
    const day = Math.floor(ts / DAY) * DAY;
    (out.get(day) || out.set(day, new Set()).get(day)).add(id);
  }
  return out;
}

let sim;
let midway; // contexts taken while the third day was still open: stored days and hour summaries
let rebuilt; // compactor runs after the late batches
before(async () => {
  sim = lakeSim({ start: T0, everyMs: 10 * MINUTE });
  await sim.send(early);
  // Past the next compactor run, so everything sent so far is compacted.
  await sim.advance(MIDWAY + 20 * MINUTE);
  midway = [];
  for (const f of FILTERS) {
    for (const name of Object.keys(QUERIES)) {
      const q = query(sim.clock - 60 * DAY, sim.clock, f);
      midway.push({ name, f, q, ctx: await sim.store.context(P, q, appQuery(name)) });
    }
  }
  await sim.send(rest.filter((b) => b.at < HELD_AT));
  await sim.advance(HELD_AT);
  const runs = sim.runs.length;
  await sim.send([...held, ...rest.filter((b) => b.at >= HELD_AT)]);
  await sim.advance(D0 + 4 * DAY + 4 * HOUR);
  rebuilt = sim.runs.slice(runs);
});
after(() => sim?.close());

test('the compactor builds a day once it has closed, and again when late data reopens it', needsDuckDB, async () => {
  const mark = await sim.store.marks();
  assert.equal(mark.df, D0, 'rollups start the day after the first run');
  assert.equal(mark.dt, D0 + 4 * DAY, 'every closed day has rollups');
  const partitions = [...sim.doc.tables.keys()].filter((pk) => pk.startsWith(`P#${P}#Y#${SERVICE}#`));
  assert.ok(partitions.length >= 1 && partitions.length <= 2, 'one partition per calendar year');
  assert.ok(held.length, 'some batches after midnight');
  assert.ok(
    rebuilt.some((r) => r.days),
    'the late session\'s day was built again',
  );
  const days = new Set([...sim.doc.tables.get(partitions[0]).keys()].map((sk) => Number(sk.split('#')[1])));
  assert.deepStrictEqual([...days].sort(), [D0, D0 + DAY, D0 + 2 * DAY], 'one set of items per day with data');
});

test('daily rollups answer every query exactly as the raw events do at day resolution', needsDuckDB, async () => {
  const reference = eventsOf([...early, ...rest, ...held]);
  const to = sim.clock;
  let compared = 0;
  for (const from of [to - 45 * DAY, to - 400 * DAY]) {
    for (const f of FILTERS) {
      for (const [name, run] of Object.entries(QUERIES)) {
        const q = query(from, to, f);
        const ctx = await sim.store.context(P, q, appQuery(name));
        assert.ok(ctx.daily && !ctx.sessions.size, 'a daily context');
        assert.equal(ctx.from % DAY, 0, 'whole days');
        assert.equal(ctx.bucketMs, DAY);
        assert.deepStrictEqual(comparable(run(ctx)), comparable(run(rawDaily(ctx, q, reference))), `${name} ${JSON.stringify(f)} over ${Math.round((to - from) / DAY)} days`);
        assert.deepStrictEqual(ctx.meta.approximate, [], `${name}: nothing approximate`);
        compared++;
      }
    }
  }
  assert.equal(compared, 2 * FILTERS.length * Object.keys(QUERIES).length);
  // Sessions that ran past midnight count once, on the day they started; days with rollups read no hours.
  const read = [];
  const summaryItems = sim.table.summaryItems.bind(sim.table);
  sim.table.summaryItems = async (project, service, family, a, b) => (read.push([a, b]), summaryItems(project, service, family, a, b));
  const ctx = await sim.store.context(P, query(to - 45 * DAY, to), 'overview');
  sim.table.summaryItems = summaryItems;
  assert.equal(overview(ctx).kpis.sessions, sessions.length);
  const spike = findings(ctx, []).find((f) => f.category === 'design');
  assert.ok(spike && spike.evidence.rage_quits > 0 && spike.evidence.hotspot.rage_quits > 0, 'a difficulty spike with rage quits at the spot');
  assert.ok(read.length && read.every(([a, b]) => b < D0 + 3 * 3_600_000 || a >= D0 + 4 * DAY - 3 * 3_600_000), `hours read: ${JSON.stringify(read.map(([a, b]) => [(a - D0) / 3_600_000, (b - D0) / 3_600_000]))}`);
});

test('days without rollups yet come from the hour summaries, folded the same way', needsDuckDB, async () => {
  const reference = eventsOf(early);
  assert.ok(midway[0].ctx.to + 1 > D0 + 2 * DAY + HOUR, 'the range ends well inside a day without rollups');
  for (const { name, f, q, ctx } of midway) assert.deepStrictEqual(comparable(QUERIES[name](ctx)), comparable(QUERIES[name](rawDaily(ctx, q, reference))), `${name} ${JSON.stringify(f)}`);
  // A range that ends part way through a day with rollups takes that day from the hours.
  const reference2 = eventsOf([...early, ...rest, ...held]);
  for (const name of ['overview', 'players', 'events']) {
    const q = query(D0 + DAY + 13 * HOUR - 40 * DAY, D0 + DAY + 13 * HOUR);
    const ctx = await sim.store.context(P, q, name);
    assert.equal(ctx.to + 1, D0 + DAY + 13 * HOUR);
    const raw = rawDaily(ctx, q, reference2);
    assert.deepStrictEqual(comparable(QUERIES[name](ctx)), comparable(QUERIES[name](raw)), `${name} ending mid-day`);
  }
});

// An endless game: one level nobody completes, every run ends in a death and its session soon after.
function endlessSessions(start, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let ts = start + i * 101 * MINUTE;
    const base = { service: 'flappy', env: 'prod', version: '2.0.0', session_id: `f_${i}`, player_id: `p_${i % 7}`, sdk: 'glitchless-browser/0.2.2', level: null };
    const events = [];
    const push = (e) => events.push({ ...base, ...e, ts: (ts += 1500) });
    push({ type: 'session_start', session_type: 'user', device: { gpu_tier: 'mid', browser: 'Chrome', gpu: 'M3' } });
    for (let r = 0; r <= i % 3; r++) {
      push({ type: 'level_start', level: 'endless' });
      push({ type: 'death', level: 'endless', x: 40 + ((i + r) % 4) * 0.5, y: 3, z: 0, cause: 'pipe' });
      push({ type: 'level_fail', level: 'endless', cause: 'pipe' });
    }
    push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

test('a game nobody wins has no rage quits in its daily rollups either', needsDuckDB, async () => {
  const s = lakeSim({ start: T0, everyMs: 10 * MINUTE });
  try {
    const batches = arrivals(endlessSessions(D0 + HOUR, 40), { project: P });
    await s.send(batches);
    await s.advance(D0 + 3 * DAY + 4 * HOUR);
    const q = { ...query(s.clock - 45 * DAY, s.clock), service: 'flappy' };
    for (const name of ['overview', 'funnel', 'findings', 'players', 'sessions']) {
      const ctx = await s.store.context(P, q, appQuery(name));
      assert.ok(ctx.daily, 'a daily context');
      assert.deepStrictEqual(comparable(QUERIES[name](ctx)), comparable(QUERIES[name](rawDaily(ctx, q, eventsOf(batches)))), name);
    }
    const ctx = await s.store.context(P, q, 'overview');
    assert.equal(overview(ctx).kpis.sessions, 40);
    assert.equal(overview(ctx).kpis.rage_quits, 0);
    assert.ok(findings(ctx, []).some((f) => f.evidence?.no_win), 'its hotspot reads as a game without a win');
  } finally {
    s.close();
  }
});

test('with small caps a day keeps bounded sketches, and answers name what is approximate', needsDuckDB, async () => {
  const tiny = { ...CAPS, players: 3, quantiles: 4, gpus: 1, deaths: 2, sample: 20, values: 2, recent: 5, levelPlayers: [2, 4], eventPlayers: [2, 4], errorSessions: [2, 4], errorPlayers: [2, 4] };
  const s = lakeSim({ start: T0, everyMs: 10 * MINUTE, compactor: { dayCaps: tiny } });
  try {
    const batches = all.filter((b) => b.at < D0 + DAY + 5 * HOUR);
    await s.send(batches);
    await s.advance(D0 + DAY + 6 * HOUR);
    const q = query(s.clock - 60 * DAY, s.clock);
    const ctx = await s.store.context(P, q, 'overview');
    const raw = rawDaily(ctx, q, eventsOf(batches));
    const o = overview(ctx);
    const r = overview(raw);
    // Counts, rates and everything from cells stay exact; distinct counts and medians are estimated.
    for (const k of ['sessions', 'crash_free_pct', 'error_free_pct', 'avg_session_s', 'rage_quits', 'frame_p95', 'errors', 'deaths']) assert.equal(o.kpis[k], r.kpis[k], k);
    assert.ok(o.kpis.players > 0);
    // The newest sessions are among each day's newest; ordered funnels weight each day's sample.
    assert.deepStrictEqual(json(sessionsList(ctx, { limit: 5 })), json(sessionsList(raw, { limit: 5 })));
    const steps = parseFunnel('enemy_spawn,bone_collected');
    const est = eventFunnel(ctx, steps);
    const exact = eventFunnel(raw, steps);
    for (let i = 0; i < steps.length; i++) assert.ok(Math.abs(est[i].sessions / exact[i].sessions - 1) < 0.4, `funnel step ${i}: ${est[i].sessions} vs ${exact[i].sessions}`);
    players(ctx);
    performance(ctx);
    customEvents(ctx);
    findings(ctx, []);
    for (const what of ['players', 'returning_players_pct', 'median_session_s', 'level_players', 'gpus', 'event_funnel', 'event_players', 'event_values', 'error_sessions']) assert.ok(ctx.meta.approximate.includes(what), `${what} in ${ctx.meta.approximate}`);
  } finally {
    s.close();
  }
});

test('days the compactor has not built yet are read from the hours, and dayTo waits for them', needsDuckDB, async () => {
  const s = lakeSim({ start: T0, everyMs: 10 * MINUTE, compactor: { maxDayBuilds: 0 } });
  try {
    const batches = all.filter((b) => b.at < D0 + DAY + 5 * HOUR);
    await s.send(batches);
    await s.advance(D0 + 2 * DAY + 6 * HOUR);
    assert.equal((await s.store.marks()).dt, D0);
    for (const name of ['overview', 'players']) {
      const q = query(s.clock - 60 * DAY, s.clock);
      const ctx = await s.store.context(P, q, name);
      assert.deepStrictEqual(comparable(QUERIES[name](ctx)), comparable(QUERIES[name](rawDaily(ctx, q, eventsOf(batches)))), name);
    }
  } finally {
    s.close();
  }
});

test("the app answers long ranges at day resolution, within the reader plan's retention", needsDuckDB, async () => {
  let plan = 'indie';
  const auth = { resolveIngest: () => ({ projectId: P }), resolveReader: () => ({ projectId: P, scopes: ['read'], plan }) };
  const server = http.createServer(createApp({ store: sim.store, auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  try {
    const to = sim.clock;
    assert.equal((await get('/v1/query/services')).max_range_days, 90);
    const o = await get(`/v1/query/overview?service=${SERVICE}&from=${to - 90 * DAY}&to=${to}`);
    assert.equal(o.meta.resolution, 'day');
    assert.equal(o.meta.retention_days, 90);
    assert.equal(o.meta.bucket_ms, DAY);
    assert.deepStrictEqual(o.meta.approximate, []);
    assert.equal(o.kpis.sessions, sessions.length);
    const year = await get(`/v1/query/events?service=${SERVICE}&from=${to - 365 * DAY}&to=${to}`);
    assert.ok(year.meta.from >= to - 91 * DAY, "a year is cut to the plan's 90 days");
    assert.ok(year.events.length);
    const heat = await get(`/v1/query/heatmap?service=${SERVICE}&from=${to - 90 * DAY}&to=${to}`);
    assert.match(heat.meta.note, /last 31 days/);
    assert.ok(heat.meta.from >= to - 31 * DAY - MINUTE);
    plan = 'free';
    assert.equal((await get('/v1/query/services?plan=free')).max_range_days, 14);
    const free = await get(`/v1/query/overview?service=${SERVICE}&from=${to - 90 * DAY + 1}&to=${to}`);
    assert.equal(free.meta.resolution, undefined, '14 days are answered per minute');
    assert.ok(free.meta.from >= to - 14 * DAY);
    // Retention counts back from now, not from the end of the range: a range that ended 15 days ago (a share
    // link pinned to past dates) is past what the plan keeps, and one inside it still reads its days.
    const aged = await get(`/v1/query/overview?service=${SERVICE}&from=${to - 40 * DAY}&to=${to - 15 * DAY}`);
    assert.ok(aged.meta.from >= to - 15 * DAY, `aged range read from ${(to - aged.meta.from) / DAY} days ago`);
    assert.equal(aged.kpis.sessions, 0);
    const kept = await get(`/v1/query/overview?service=${SERVICE}&from=${D0}&to=${D0 + 3 * DAY}`);
    assert.equal(kept.meta.from, D0);
    assert.ok(kept.kpis.sessions > 0);
  } finally {
    server.close();
  }
});

test('a day keeps the newest sessions and rage quits of each env and version', () => {
  const day = D0 + DAY;
  const events = eventsOf(all.filter((b) => b.at < D0 + 2 * DAY));
  const states = [...indexSessions(events).values()];
  const d = foldDay(day, { sessions: states }, { ...CAPS, recent: 2, rageQuits: 1 });
  for (const g of d.groups.values()) {
    const mine = states.filter((s) => sessionDay(s) === day && s.env === g.env && s.version === g.version);
    const newest = mine.map((s) => s.start ?? s.first_ts).sort((a, b) => b - a);
    assert.deepStrictEqual(
      g.recent.map(([start]) => start),
      newest.slice(0, 2),
    );
    const rage = mine.filter((s) => s.rage_quit).map((s) => s.last_ts).sort((a, b) => b - a);
    assert.deepStrictEqual(
      g.rq.map(([ts]) => ts),
      rage.slice(0, 1),
    );
  }
  assert.ok([...d.groups.values()].some((g) => g.n > 2), 'some group has more sessions than it keeps');
});

test('sketches are exact while small and close past their caps', () => {
  const d = new Distinct(256, 10);
  for (let i = 0; i < 200; i++) d.add(`p${i}`);
  assert.equal(Distinct.from(json(d)).count(), 200);
  assert.equal(Distinct.from(json(d)).approx, false);
  for (const n of [5000, 50_000]) {
    const h = new Distinct(256, 10);
    for (let i = 0; i < n; i++) h.add(`x${i}`);
    const est = Distinct.from(json(h)).count();
    assert.ok(Math.abs(est / n - 1) < 0.1, `HyperLogLog ${n}: ${est}`);
  }
  // Exact sets merged at query time stay exact, however many.
  const u = new Distinct(Infinity);
  for (let day = 0; day < 30; day++) {
    const one = new Distinct(256, 10);
    for (let i = 0; i < 200; i++) one.add(`d${day}-${i}`);
    u.merge(Distinct.from(json(one)));
  }
  assert.equal(u.count(), 6000);
  assert.equal(u.approx, false);
  // Returning ids from day samples: exact while small, estimated past the cap.
  const days = (k) =>
    [0, 1, 2].map((d) => {
      const s = new Sample(k);
      for (let i = 0; i < 2000; i++) s.add(`q${d * 1600 + i}`);
      return s;
    });
  assert.deepStrictEqual(repeatedIds(days(Infinity)), { ids: 5200, repeat: 800, approx: false });
  const est = repeatedIds(days(512).map((s) => Sample.from(json(s))));
  assert.ok(est.approx && Math.abs(est.repeat / est.ids - 800 / 5200) < 0.05, JSON.stringify(est));
  // Quantile maps: exact (as quantile() rounds) while small, then a few significant digits.
  const m = new QMap(512);
  const values = [...Array(20_000).keys()].map((i) => ((i * 7919) % 360_000) / 100);
  for (const v of values) m.add(v);
  const sorted = [...values].sort((a, b) => a - b);
  const exact = sorted[Math.floor(0.5 * sorted.length)];
  assert.ok(m.approx && Math.abs(m.quantile(0.5) / exact - 1) < 0.02, `${m.quantile(0.5)} vs ${exact}`);
  const small = new QMap(512);
  for (const v of [3, 1, 2, 2.345, -1.234]) small.add(v);
  assert.equal(small.quantile(0.5), 2);
  assert.equal(QMap.from(json(small)).quantile(0.95), 3);
});

test("clearing a game's data deletes its daily rollups too", needsDuckDB, async () => {
  const s = lakeSim({ start: T0, everyMs: 10 * MINUTE });
  try {
    await s.send(all.filter((b) => b.at < D0 + DAY));
    await s.advance(D0 + 2 * DAY + 5 * HOUR);
    const rollups = () => [...s.doc.tables].filter(([pk, items]) => pk.startsWith(`P#${P}#Y#`) && items.size).length;
    assert.ok(rollups() > 0);
    await s.store.clear(P, SERVICE);
    assert.equal(rollups(), 0);
  } finally {
    s.close();
  }
});
