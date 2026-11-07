// Time in zone and frame time by zone (decision 6, SPEC §3b Zones; asked for by an avatar-hub puzzle game): each zone's
// share of play time from the cells, the sessions that went there and their median time in it from each session's own
// frame windows, a board's breakdown by $zone without an event, stats about one zone, frame_time panels by $zone or
// $level, and the Performance view's zones with their time and hitches. Session states merge in any order, day
// rollups answer as the raw events do, and every store answers as the raw events do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext, performance, sessionContext } from '../src/analytics.js';
import { foldSessions, mergeSession, finalizeSession, sessionToJSON, sessionFromJSON } from '../src/session-state.js';
import { validateBoard, evaluateBoard, autoBoard } from '../src/board.js';
import { foldDay, mergeDays, sessionDay, dayParts, dayFromParts } from '../src/daily.js';
import { zoneTime, ZONES } from '../src/zones.js';
import { rollup } from '../src/rollups.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = Math.floor((NOW - 6 * 3_600_000) / 60_000) * 60_000;
const q = (extra = {}) => ({ service: 'hub', from: START - 60_000, to: NOW, type: 'all', ...extra });
const frames = (ms, n, slow = 0) => {
  const sk = new Sketch();
  for (let i = 0; i < n; i++) sk.add(i < slow ? 80 : ms);
  return sk.toJSON();
};

// An avatar hub: every session starts in the hall, half of them walk to the garden, every third climbs to the
// observatory, whose sky drops frames (hitches); puzzles are levels inside the zones. Each session also spends one
// window in a menu, outside every zone. Version 1.1 sessions stay twice as long in the hall.
function hub() {
  const out = [];
  for (let n = 0; n < 30; n++) {
    const version = n < 20 ? '1.0' : '1.1';
    const base = { service: 'hub', env: 'prod', version, session_id: `s_${n}`, player_id: `p_${n % 25}` };
    let ts = START + n * 300_000;
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base, ts: (ts += 5000) });
    const win = (zone, extra = {}) => push({ type: 'frame_window', ...(zone ? { zone } : {}), duration_s: 5, frames: 300, budget_ms: 16.67, ft: frames(15, 300), hitches: 0, ...extra });
    push({ type: 'session_start', session_type: 'user', device: { os: 'Windows' } });
    win(null);
    for (let i = 0; i < (2 + (n % 3)) * (version === '1.1' ? 2 : 1); i++) win('hall');
    if (n % 2) {
      push({ type: 'level_start', level: 'puzzle_1', zone: 'garden' });
      for (let i = 0; i < 3; i++) win('garden', { level: 'puzzle_1' });
      push({ type: 'level_complete', level: 'puzzle_1', zone: 'garden', duration_s: 15 });
    }
    if (n % 3 === 0) {
      for (let i = 0; i < 4; i++) win('observatory', { ft: frames(15, 300, 12), hitches: 3 });
      push({ type: 'hitch', zone: 'observatory', duration_ms: 80, causes: ['render'] });
    }
    push({ type: 'custom', name: 'purchase', zone: 'hall', attrs: { item: 'hat' } });
    push({ type: 'session_end' });
    out.push(events);
  }
  return out;
}

const play = hub();
const events = play.flat().sort((a, b) => a.ts - b.ts);
const ctxOf = (extra = {}, list = events) => buildContext(list, q(extra));
const board = (panels, ctx = ctxOf()) => evaluateBoard(ctx, validateBoard({ panels }));

// What the zones should read, from the raw frame windows: seconds per zone and per session.
function expected(list = events) {
  const total = new Map();
  const per = new Map();
  for (const e of list) {
    if (e.type !== 'frame_window') continue;
    const zone = e.zone ?? '(none)';
    total.set(zone, (total.get(zone) || 0) + e.duration_s);
    if (!per.has(zone)) per.set(zone, new Map());
    per.get(zone).set(e.session_id, (per.get(zone).get(e.session_id) || 0) + e.duration_s);
  }
  const all = [...total.values()].reduce((a, b) => a + b, 0);
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return Object.fromEntries([...total].map(([zone, s]) => [zone, { seconds: s, share_pct: Math.round((s / all) * 1000) / 10, sessions: per.get(zone).size, median_s: median([...per.get(zone).values()]) }]));
}

test('time in zone: each zone’s share of play time, the sessions that went there and their median time in it', () => {
  const t = zoneTime(ctxOf());
  const want = expected();
  assert.deepEqual(t.rows.map((r) => r.zone), ['hall', 'garden', 'observatory', '(none)'], 'most time first; play outside every zone is (none)');
  for (const r of t.rows) {
    const w = want[r.zone];
    if (r.zone === '(none)') assert.deepEqual([r.seconds, r.share_pct, r.sessions, r.median_s], [w.seconds, w.share_pct, null, null], 'time outside every zone: time only');
    else assert.deepEqual([r.seconds, r.share_pct, r.sessions, r.median_s], [w.seconds, w.share_pct, w.sessions, w.median_s], r.zone);
  }
  assert.equal(t.sessions, 30);
  assert.equal(t.rows.find((r) => r.zone === 'garden').sessions_pct, 50);
  assert.equal(t.rows.find((r) => r.zone === 'observatory').players, 10, 'players, each once');
  assert.ok(Math.abs(t.rows.reduce((a, r) => a + r.share_pct, 0) - 100) < 0.2, 'the shares add up to all play');
  // A game without zones has no zone time.
  assert.equal(zoneTime(ctxOf({}, events.map(({ zone, ...e }) => e))), null);
});

test('a breakdown by $zone without an event is the time in each zone; stats read one zone', () => {
  const [time, share, median, gone, top] = board([
    { type: 'breakdown', by: '$zone' },
    { type: 'stat', metric: 'zone_time_pct', zone: 'observatory' },
    { type: 'stat', metric: 'zone_median_s', zone: 'garden' },
    { type: 'stat', metric: 'zone_median_s', zone: 'crypt' },
    { type: 'breakdown', by: '$zone', limit: 2 },
  ]);
  const want = expected();
  assert.equal(time.title, 'Time by zone');
  assert.equal(time.counts, 'time');
  assert.deepEqual(time.rows[0], { value: 'hall', seconds: want.hall.seconds, share_pct: want.hall.share_pct, sessions: 30, sessions_pct: 100, players: 25, median_s: want.hall.median_s });
  assert.deepEqual([top.rows.length, top.more], [2, 2]);
  assert.deepEqual([share.title, share.value, share.unit, share.sessions], ['Play time in observatory', want.observatory.share_pct, '%', 10]);
  assert.deepEqual([median.title, median.value, median.unit], ['Median time in garden', 15, 's']);
  assert.match(gone.why, /No frames were drawn in the zone "crypt"/);
  const [none] = board([{ type: 'breakdown', by: '$zone' }], ctxOf({}, events.map(({ zone, ...e }) => e)));
  assert.match(none.why, /sets no zone/);
  // The automatic board shows where play time goes for a game that names its zones.
  assert.ok(autoBoard(ctxOf()).panels.some((p) => p.type === 'breakdown' && p.by === '$zone' && !p.event));
});

test('zone panels say what to fix when they are written wrong', () => {
  const bad = (panel, re) => assert.throws(() => validateBoard({ panels: [panel] }), re);
  bad({ type: 'stat', metric: 'zone_time_pct' }, /needs zone/);
  bad({ type: 'stat', metric: 'sessions', zone: 'hall' }, /zone goes with metric zone_time_pct or zone_median_s/);
  bad({ type: 'breakdown', by: '$zone', sum: 'amount' }, /sum goes with event; without one, a breakdown by \$zone is the time/);
  bad({ type: 'breakdown', by: '$zone', rate: 'won' }, /rate goes with event/);
  bad({ type: 'breakdown', by: '$level' }, /needs event/);
  bad({ type: 'frame_time', by: '$platform' }, /by is \$zone or \$level/);
  bad({ type: 'frame_time', by: '$zone', limit: 50 }, /limit must be 1 to 20/);
  // Before, a frame_time panel's `by` was dropped without a word.
  assert.deepEqual(validateBoard({ panels: [{ type: 'frame_time', by: '$zone' }] }).panels[0], { type: 'frame_time', by: '$zone' });
});

test('frame_time by $zone or $level: p50, p95 and hitches per minute played in each', () => {
  const [byZone, byLevel, overall] = board([{ type: 'frame_time', by: '$zone' }, { type: 'frame_time', by: '$level' }, { type: 'frame_time' }]);
  assert.equal(byZone.title, 'Frame time by zone');
  assert.deepEqual(byZone.rows.map((r) => r.value), ['hall', 'garden', 'observatory', '(none)']);
  const sky = byZone.rows.find((r) => r.value === 'observatory');
  // 10 sessions × 4 windows × 3 hitches over 200 s.
  assert.deepEqual([sky.sessions, sky.hitches, sky.hitches_per_min, sky.seconds], [10, 120, 36, 200]);
  assert.ok(sky.p99 > 70 && sky.p50 < 16, 'the observatory drops frames; its median is smooth');
  assert.equal(byZone.rows.find((r) => r.value === 'hall').hitches_per_min, 0);
  assert.equal(byZone.kpis.p95, overall.kpis.p95, 'the overall numbers ride along');
  assert.deepEqual(byLevel.rows.map((r) => [r.value, r.sessions]), [['(none)', 30], ['puzzle_1', 15]]);
  assert.ok(overall.ts && !overall.rows, 'without by, frame time over time as before');
});

test("the Performance view's zones carry their time, their sessions and hitches per minute", () => {
  const perf = performance(ctxOf());
  const want = expected();
  assert.deepEqual(perf.by_zone.map((z) => z.key), ['garden', 'hall', 'observatory']);
  for (const z of perf.by_zone) assert.deepEqual([z.sessions, z.seconds, z.share_pct, z.median_s], [want[z.key].sessions, want[z.key].seconds, want[z.key].share_pct, want[z.key].median_s], z.key);
  assert.equal(perf.by_zone.find((z) => z.key === 'observatory').hitches_per_min, 36);
  assert.ok(perf.hitches.length && perf.hitches.every((h) => h.zone === 'observatory'), 'recent hitches say their zone');
});

test('versions compare a zone stat version by version', () => {
  const [, cmp] = board([{ type: 'stat', metric: 'zone_median_s', zone: 'hall' }, { type: 'versions' }]);
  const hall = (v) => expected(events.filter((e) => e.version === v)).hall.median_s;
  assert.deepEqual(cmp.columns.map((c) => [c.metric, c.zone, c.unit]), [['zone_median_s', 'hall', 's']]);
  assert.deepEqual(
    cmp.rows.map((r) => [r.version, r.values[0]]),
    [
      ['1.0', hall('1.0')],
      ['1.1', hall('1.1')],
    ],
  );
  assert.ok(hall('1.1') > hall('1.0'));
});

test('session states keep seconds per zone the same however they are folded, merged and stored', () => {
  const list = play[3];
  const whole = finalizeSession(foldSessions(list).get('s_3'));
  const half = Math.floor(list.length / 2);
  const a = sessionFromJSON(JSON.parse(JSON.stringify(sessionToJSON(foldSessions(list.slice(half)).get('s_3')))));
  const b = foldSessions(list.slice(0, half)).get('s_3');
  const merged = finalizeSession(mergeSession(a, b));
  assert.deepEqual(merged.zs, whole.zs);
  assert.deepEqual(Object.keys(whole.zs).sort(), ['garden', 'hall', 'observatory']);
  // A session that wanders through more zones than it keeps puts the rest under (other), all its seconds kept.
  const many = [];
  for (let i = 0; i < ZONES + 5; i++) many.push({ type: 'frame_window', ts: START + i * 5000, session_id: 'w', zone: `z${i}`, duration_s: 5, frames: 300 });
  const w = foldSessions(many).get('w');
  assert.equal(Object.keys(w.zs).length, ZONES + 1);
  assert.equal(w.zs['(other)'], 5 * 5 * 1e6);
});

test('day rollups answer time in zone as the raw events do', () => {
  const sessions = [...ctxOf().sessions.values()];
  const days = new Map();
  for (const s of sessions) {
    const d = sessionDay(s);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(s);
  }
  // Each day goes through storage as JSON parts, as a store keeps it.
  const folded = [...days].map(([day, list]) => dayFromParts(day, JSON.parse(JSON.stringify(dayParts(foldDay(day, { cells: rollup(events), sessions: list })).main))));
  const { cells, facts, daily } = mergeDays(folded, () => true);
  const ctx = sessionContext({ ...q(), from: Math.min(...days.keys()), to: NOW }, new Map());
  Object.assign(ctx, { daily, cells, facts, events: [], meta: { resolution: 'day', approximate: [] } });
  const PANELS = [{ type: 'breakdown', by: '$zone' }, { type: 'stat', metric: 'zone_median_s', zone: 'garden' }, { type: 'frame_time', by: '$zone' }];
  const byDay = evaluateBoard(ctx, validateBoard({ panels: PANELS }));
  const raw = board(PANELS);
  assert.deepStrictEqual(byDay[0].rows, raw[0].rows);
  assert.equal(byDay[1].value, raw[1].value);
  assert.deepStrictEqual(byDay[2].rows.map((r) => [r.value, r.sessions, r.hitches_per_min]), raw[2].rows.map((r) => [r.value, r.sessions, r.hitches_per_min]));
  const perf = performance(ctx);
  assert.deepEqual(perf.by_zone.map((z) => [z.key, z.sessions, z.median_s]), performance(ctxOf()).by_zone.map((z) => [z.key, z.sessions, z.median_s]));
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: time in zone and frame time by zone answer as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const PANELS = [
      { type: 'breakdown', by: '$zone' },
      { type: 'stat', metric: 'zone_time_pct', zone: 'hall' },
      { type: 'stat', metric: 'zone_median_s', zone: 'observatory' },
      { type: 'frame_time', by: '$zone' },
      { type: 'frame_time', by: '$level' },
    ];
    try {
      for (const list of play) {
        const { service, env, version, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      await call('PUT', '/v1/dashboard?service=hub', { pages: [{ id: 'hub', title: 'Hub', panels: PANELS }] });
      const range = `service=hub&from=${START - 60_000}&to=${NOW + 1}`;
      const { meta, board: got } = await call('GET', `/v1/query/board?${range}&page=hub`);
      const raw = ctxOf({ from: meta.from, to: meta.to }, events.filter((e) => e.ts >= meta.from && e.ts <= meta.to));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(got.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels: PANELS })))));
      assert.equal(got.panels[0].rows[0].value, 'hall');
      const perf = await call('GET', `/v1/query/performance?${range}`);
      assert.deepStrictEqual(perf.by_zone, JSON.parse(JSON.stringify(performance(raw).by_zone)));
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
