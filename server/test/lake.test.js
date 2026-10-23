// The hosted event store (Firehose → S3, summaries in DynamoDB, a compactor) must answer every query
// exactly as the raw events of the same range do: summaries for the dashboard queries, session files for
// detail, replay and playtest runs, DuckDB over Parquet and raw files for the drill-downs. Batches arrive
// out of order and late, hours close and reopen, and a compactor run can die half way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildContext, overview, performance, versions, players, customEvents, eventFunnel, parseFunnel, errorIssues, sessionsList, sessionDetail, heatmap, heatmapLevels, playtestSummary } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { autoBoard, autoDashboard, evaluateBoard, validateBoard } from '../src/board.js';
import { eventSums } from '../src/sums.js';
import { foldSessions, finalizeSession, mergeSession, sessionToJSON, sessionFromJSON } from '../src/session-state.js';
import { toRecords } from '../src/lake/record.js';
import { rawErrorsPrefix, dayOf, hourLabel } from '../src/lake/layout.js';
import { gameSessions, shopSessions } from './helpers/game-data.js';
import { lakeSim, arrivals, hasDuckDB, needsDuckDB } from './helpers/lake-sim.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 9 * HOUR;
const START = T0 + 17_123;
const P = 'proj_a';
const SERVICE = 'zoomies';

const sessions = [...gameSessions({ start: START, spanMs: 2.5 * HOUR, sessions: 50 }), ...shopSessions({ start: START, spanMs: 2.5 * HOUR, sessions: 40 })];
const batches = arrivals(sessions, { project: P, late: 0.04 });
// A small game alongside: its summary blocks are small enough to be stored as one item each.
const TINY = 'proj_tiny';
const tiny = gameSessions({ start: START, spanMs: 2 * HOUR, sessions: 3, seed: 8, prefix: 't' });
const tinyBatches = arrivals(tiny, { project: TINY });
// What a raw store would hold: events in arrival order, stably sorted by time.
const reference = [...batches]
  .sort((a, b) => a.at - b.at)
  .flatMap((b) => b.events.map((e) => ({ ...e, project_id: P })))
  .map((e, i) => [e, i])
  .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
  .map(([e]) => e);
const times = reference.map((e) => e.ts);
const at = (q) => times[Math.floor(q * (times.length - 1))];
const RANGES = [
  [START - 5 * HOUR, START + 6 * HOUR], // everything: whole hours plus edge hours
  [at(0.1) - 1, at(0.9) + 1], // starts and ends inside busy minutes
  [at(0.3) + 1, at(0.31)], // a few minutes in the busiest stretch
  [Math.ceil(at(0.2) / HOUR) * HOUR, Math.ceil(at(0.8) / HOUR) * HOUR - 1], // whole hours only
  [at(0.5), at(0.5) + 20_000], // inside one or two minutes
];
const FILTERS = [{}, { env: 'prod' }, { version: '1.0.1' }, { env: 'dev', version: '1.1.0' }];
const QUERIES = {
  overview: (ctx) => overview(ctx),
  performance: (ctx) => performance(ctx),
  versions: (ctx) => versions(ctx),
  findings: (ctx) => findings(ctx, []),
  players: (ctx) => players(ctx),
  errors: (ctx) => errorIssues(ctx),
  sessions: (ctx) => sessionsList(ctx),
  events: (ctx) => ({ ...customEvents(ctx), funnel: eventFunnel(ctx, parseFunnel('enemy_spawn,bone_collected=big,enemy_spawn:boss=true')) }),
  board: (ctx) => evaluateBoard(ctx, autoBoard(ctx)),
  dashboard: (ctx) => autoDashboard(ctx).pages.map(({ panels, ...p }) => p),
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

let sim;
before(async () => {
  if (!hasDuckDB) return;
  sim = lakeSim({ start: T0 });
  await sim.send([...batches, ...tinyBatches]);
  await sim.settle();
});
after(() => sim?.close());

function rawContext(ctx, q) {
  return buildContext(
    reference.filter((e) => e.ts >= ctx.from && e.ts <= ctx.to),
    { ...q, from: ctx.from, to: ctx.to },
  );
}

const query = (from, to, f = {}, extra = {}) => ({ service: SERVICE, from, to, env: f.env || null, version: f.version || null, type: 'all', sessions: null, ...extra });

test('summaries answer every dashboard query exactly as the raw events of the range do', needsDuckDB, async () => {
  let compared = 0;
  for (const [from, to] of RANGES) {
    for (const f of FILTERS) {
      for (const [name, run] of Object.entries(QUERIES)) {
        const q = query(from, to, f);
        const ctx = await sim.store.context(P, q, name);
        assert.ok(!ctx.events, 'the summary path reads no raw events');
        assert.equal(ctx.from % MINUTE, 0, 'ranges are answered in whole minutes');
        assert.deepStrictEqual(run(ctx), run(rawContext(ctx, q)), `${name} ${JSON.stringify([from - START, to - START, f])}`);
        compared++;
      }
    }
  }
  assert.equal(compared, RANGES.length * FILTERS.length * Object.keys(QUERIES).length);
  // The ranges used whole-hour session states and per-minute ones at their edges, after consolidation.
  // Larger blocks are stored per family, small ones as one item (A).
  const families = (project) => [...new Set([...sim.doc.tables.keys()].filter((pk) => pk.startsWith(`P#${project}#L#`)).flatMap((pk) => [...sim.doc.tables.get(pk).keys()].map((sk) => sk[0])))].sort();
  assert.deepStrictEqual(families(P), ['C', 'F', 'H']);
  assert.deepStrictEqual(families(TINY), ['A']);
  const tinyRef = [...tinyBatches]
    .sort((a, b) => a.at - b.at)
    .flatMap((b) => b.events.map((e) => ({ ...e, project_id: TINY })))
    .map((e, i) => [e, i])
    .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
    .map(([e]) => e);
  for (const [from, to] of RANGES.slice(0, 2)) {
    for (const [name, run] of Object.entries(QUERIES)) {
      const q = query(from, to);
      const ctx = await sim.store.context(TINY, q, name);
      const raw = buildContext(
        tinyRef.filter((e) => e.ts >= ctx.from && e.ts <= ctx.to),
        { ...q, from: ctx.from, to: ctx.to },
      );
      assert.deepStrictEqual(run(ctx), run(raw), `${TINY} ${name}`);
    }
  }
  const all = await sim.store.context(P, query(...RANGES[0]), 'overview');
  assert.equal(all.sessions.size, sessions.length);
});

test('drill-downs read Parquet and raw files with DuckDB: recent hitches, breadcrumbs, heatmap positions', needsDuckDB, async () => {
  const parquet = (await sim.bucket.list(`events/plan=free/project=${P}/`)).filter((o) => o.key.endsWith('.parquet'));
  assert.ok(parquet.length >= 3, `hourly Parquet files: ${parquet.length}`);
  assert.ok(parquet.every((o) => o.key.startsWith(`events/plan=free/project=${P}/service=${SERVICE}/`)));
  const maps = [];
  for (const [from, to] of RANGES) {
    const q = query(from, to);
    const perf = await sim.store.context(P, q, 'performance');
    assert.deepStrictEqual(performance(perf).hitches, performance(rawContext(perf, q)).hitches);
    const levels = heatmapLevels(perf, maps);
    for (const level of levels) {
      const ctx = await sim.store.context(P, q, 'heatmap', new URLSearchParams({ level }));
      assert.deepStrictEqual(heatmap(ctx, level, maps), heatmap(rawContext(ctx, q), level, maps), `heatmap ${level}`);
    }
  }
  const whole = await sim.store.context(P, query(...RANGES[0]), 'performance');
  assert.equal(performance(whole).hitches.length, 100);
  const issues = errorIssues(await sim.store.context(P, query(...RANGES[0]), 'errors'));
  assert.ok(issues.length && issues.every((i) => i.breadcrumbs.length), 'every issue has breadcrumbs');
});

test('session detail, replay and playtest runs read session files; session-type filters read raw rows', needsDuckDB, async () => {
  const files = await sim.bucket.list(`sessions/plan=free/project=${P}/`);
  assert.equal(files.length, sessions.length, 'one file per finished session');
  const [from, to] = RANGES[0];
  for (const id of ['s_0', 's_7', 's_33']) {
    const q = query(from, to);
    const ctx = await sim.store.context(P, q, 'session', new URLSearchParams({ id }));
    assert.deepStrictEqual(sessionDetail(ctx, id, []), sessionDetail(rawContext(ctx, q), id, []));
  }
  const ids = new Set(['s_1', 's_2', 's_3']);
  const run = await sim.store.context(P, query(from, to, {}, { sessions: ids }), 'playtest');
  assert.deepStrictEqual(playtestSummary(run), playtestSummary(rawContext(run, query(from, to, {}, { sessions: ids }))));
  for (const type of ['user', 'synthetic']) {
    const q = query(RANGES[1][0], RANGES[1][1], {}, { type });
    const ctx = await sim.store.context(P, q, 'overview');
    assert.deepStrictEqual(overview(ctx), overview(rawContext(ctx, q)), type);
  }
});

test('every event is in exactly one session file', needsDuckDB, async () => {
  let n = 0;
  for (const { key } of await sim.bucket.list(`sessions/plan=free/project=${P}/`)) n += JSON.parse(zlib.gunzipSync(await sim.bucket.get(key))).events.length;
  assert.equal(n, reference.length);
});

test('events that arrive after their hour closed reopen it, and join the session file already written', needsDuckDB, async () => {
  const s = lakeSim({ start: T0 });
  try {
    const few = gameSessions({ start: START, spanMs: HOUR, sessions: 12, seed: 4 });
    const all = arrivals(few, { project: P });
    // A third of the batches are held back until every hour has closed and every session is written.
    const held = all.filter((_, i) => i % 3 === 1);
    await s.send(all.filter((_, i) => i % 3 !== 1));
    await s.settle();
    const before = s.runs.length;
    await s.send(held.map((b) => ({ ...b, at: s.clock + 60_000 })));
    await s.settle();
    const later = s.runs.slice(before);
    assert.ok(
      later.some((r) => r.lateSessions),
      'late events were merged into session files',
    );
    assert.ok(
      later.some((r) => r.consolidated),
      'closed hours were consolidated again',
    );
    const order = [...all.filter((_, i) => i % 3 !== 1), ...held];
    const ref = order
      .flatMap((b) => b.events.map((e) => ({ ...e, project_id: P })))
      .map((e, i) => [e, i])
      .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
      .map(([e]) => e);
    for (const name of ['overview', 'performance', 'findings', 'players', 'errors']) {
      const q = query(START - HOUR, START + 3 * HOUR);
      const ctx = await s.store.context(P, q, name);
      const raw = buildContext(
        ref.filter((e) => e.ts >= ctx.from && e.ts <= ctx.to),
        { ...q, from: ctx.from, to: ctx.to },
      );
      assert.deepStrictEqual(QUERIES[name](ctx), QUERIES[name](raw), name);
    }
    for (const id of ['s_1', 's_5']) {
      const q = query(START - HOUR, START + 3 * HOUR);
      const ctx = await s.store.context(P, q, 'session', new URLSearchParams({ id }));
      const raw = buildContext(
        ref.filter((e) => e.ts >= ctx.from && e.ts <= ctx.to),
        { ...q, from: ctx.from, to: ctx.to },
      );
      assert.deepStrictEqual(sessionDetail(ctx, id, []), sessionDetail(raw, id, []), id);
    }
  } finally {
    s.close();
  }
});

test('a compactor run that dies part way is redone without counting anything twice', needsDuckDB, async () => {
  const crash = lakeSim({ start: T0 });
  try {
    const table = crash.table;
    const putAll = table.putAll.bind(table);
    let calls = 0;
    // Every 7th batch of summary writes fails once, mid-run.
    table.putAll = async (items) => {
      if (++calls % 7 === 0) throw new Error('injected failure');
      return putAll(items);
    };
    const put = crash.bucket.put.bind(crash.bucket);
    let spills = 0;
    crash.bucket.put = async (key, body, opts) => {
      if (key === 'state/open-sessions.json.gz' && ++spills % 5 === 0) throw new Error('injected failure');
      return put(key, body, opts);
    };
    const run = crash.compactor.run.bind(crash.compactor);
    let failures = 0;
    crash.compactor.run = async () => {
      try {
        return await run();
      } catch {
        failures++;
        // The lease would expire; tests don't wait for it.
        await table.delete('LAKE#META', 'lease');
        return { failed: true };
      }
    };
    await crash.send(batches);
    await crash.settle();
    assert.ok(failures > 3, `runs that died: ${failures}`);
    for (const [from, to] of RANGES.slice(0, 2)) {
      for (const name of ['overview', 'performance', 'players']) {
        const q = query(from, to);
        const ctx = await crash.store.context(P, q, name);
        assert.deepStrictEqual(QUERIES[name](ctx), QUERIES[name](rawContext(ctx, q)), name);
      }
    }
    let n = 0;
    for (const { key } of await crash.bucket.list('sessions/')) n += JSON.parse(zlib.gunzipSync(await crash.bucket.get(key))).events.length;
    assert.equal(n, reference.length, 'session files hold every event once');
  } finally {
    crash.close();
  }
});

test('a backlog (the compactor was down) is worked off a slice per run, and the watermark waits for it', needsDuckDB, async () => {
  const s = lakeSim({ start: T0, compactor: { maxObjects: 5 } });
  try {
    const run = s.compactor.run.bind(s.compactor);
    s.compactor.run = async () => ({ skipped: 'down' }); // down while the batches arrive
    const few = gameSessions({ start: START, spanMs: HOUR, sessions: 6, seed: 12 });
    const all = arrivals(few, { project: P });
    await s.send(all);
    await s.advance(s.clock + 10 * MINUTE);
    await s.firehose.deliver({ all: true });
    s.compactor.run = run;
    const first = await s.compactor.run();
    assert.equal(first.backlog, true);
    assert.equal(first.watermark, null);
    await s.settle();
    const ref = [...all].sort((a, b) => a.at - b.at).flatMap((b) => b.events.map((e) => ({ ...e, project_id: P }))).map((e, i) => [e, i]).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([e]) => e);
    const q = query(START - HOUR, START + 3 * HOUR);
    const ctx = await s.store.context(P, q, 'overview');
    assert.deepStrictEqual(overview(ctx), overview(buildContext(ref.filter((e) => e.ts >= ctx.from && e.ts <= ctx.to), { ...q, from: ctx.from, to: ctx.to })));
  } finally {
    s.close();
  }
});

test('records Firehose could not partition (its error output) are compacted like the rest', needsDuckDB, async () => {
  const s = lakeSim({ start: T0 });
  try {
    const [one] = gameSessions({ start: T0 + 60_000, spanMs: 60_000, sessions: 1, seed: 9 });
    const lines = toRecords('proj_b', 'indie', one, T0 + 30 * MINUTE);
    const body =
      lines
        .map((l) => JSON.stringify({ attemptsMade: 1, arrivalTimestamp: T0, errorCode: 'DynamicPartitioning.ActivePartitionsLimitExceeded', rawData: Buffer.from(l).toString('base64') }))
        .join('\n') + '\n';
    s.clock = T0 + 30 * MINUTE;
    await s.bucket.put(`${rawErrorsPrefix}dt=${dayOf(T0)}/hour=${hourLabel(T0)}/partitioning-failed/x.gz`, zlib.gzipSync(body));
    await s.settle();
    const q = query(T0, T0 + 2 * HOUR);
    const ctx = await s.store.context('proj_b', q, 'overview');
    const raw = buildContext(
      one.map((e) => ({ ...e, project_id: 'proj_b' })).filter((e) => e.ts >= ctx.from && e.ts <= ctx.to),
      { ...q, from: ctx.from, to: ctx.to },
    );
    assert.equal(ctx.sessions.size, 1);
    assert.deepStrictEqual(overview(ctx), overview(raw));
    assert.ok((await s.bucket.list('events/plan=indie/project=proj_b/')).length, 'compacted under its plan');
  } finally {
    s.close();
  }
});

test('session states merge exactly, however a session is split', () => {
  let rnd = 42;
  const random = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const events of sessions.slice(0, 20)) {
    const whole = finalizeSession(foldSessions(events).get(events[0].session_id));
    for (let k = 2; k <= 6; k++) {
      // Cut into k time-ordered parts at random points, fold each, store and reload it, then merge.
      const cuts = [...new Set(Array.from({ length: k - 1 }, () => 1 + Math.floor(random() * (events.length - 1))))].sort((a, b) => a - b);
      const parts = [0, ...cuts, events.length]
        .slice(1)
        .map((end, i, ends) => events.slice(i ? ends[i - 1] : 0, end))
        .filter((p) => p.length);
      const states = parts.map((p) => sessionFromJSON(JSON.parse(JSON.stringify(sessionToJSON(foldSessions(p).get(p[0].session_id))))));
      const merged = states.reduce((a, b) => mergeSession(a, b));
      // Marks as stored (a field that was never set is absent, not undefined).
      const pick = ({ cell, sketch, minutes, fwLevels, nodes, geo, idOrder, marks, ...s }) => ({
        ...s,
        marks: JSON.parse(JSON.stringify(marks)),
        levels: [...s.levels],
        completed: [...s.completed],
        p: [sketch.n, sketch.quantile(0.5), sketch.quantile(0.99)],
        minutes: [...minutes].sort(),
        fw: [...fwLevels],
      });
      assert.deepStrictEqual(pick(finalizeSession(merged)), pick(whole), `${events[0].session_id} in ${parts.length} parts`);
    }
  }
});
