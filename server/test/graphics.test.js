// Splitting by the graphics setting a session played at (SPEC §3b `$graphics`, the performance query's by_graphics). A
// Roblox player on a console asked whether a lower Graphics Quality holds the frame rate: the Roblox SDK sends that
// setting with each session (device.quality, `auto` or 1–10), and a game on any engine can name its own preset with a
// `graphics` property, which comes first. Checked through a board breakdown, the performance query, and a range over
// 31 days, which reads day rollups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, sessionContext, indexSessions, performance, graphicsOf } from '../src/analytics.js';
import { rollup } from '../src/rollups.js';
import { foldFacts } from '../src/facts.js';
import { foldDay, dayParts, dayFromParts, mergeDays, sessionDay, dailyPerformance, DAY } from '../src/daily.js';
import { evaluateBoard, validateBoard } from '../src/board.js';

const START = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
const T0 = START + 3_600_000;

// A 5-second window of 300 frames near `ms`.
function frames(ms) {
  const sk = new Sketch();
  for (let f = 0; f < 300; f++) sk.add(ms - 0.2 + (f % 5) * 0.1);
  return { type: 'frame_window', level: 'arena', duration_s: 5, frames: 300, hz: 60, budget_ms: 16.67, ft: sk.toJSON(), ft_p50: ms, ft_p95: ms + 0.2, ft_max: ms + 0.2, hitches: 0 };
}

// Roblox sessions at each Graphics Quality (`quality`, as the SDK sends it), each frame time `ms`; `props` per session.
function sessions(list) {
  const out = [];
  list.forEach(([quality, n, ms, props], j) => {
    for (let k = 0; k < n; k++) {
      const base = { service: 'hub', env: 'prod', version: '42', session_id: `s_${j}_${k}`, sdk: 'glitchless-roblox/0.2.0', level: null };
      let ts = T0 + (j * 100 + k) * 60_000;
      const push = (e) => out.push({ ...base, ...e, ts: (ts += 1000) });
      push({ type: 'session_start', session_type: 'user', privacy: 'anonymous', device: { browser: 'Roblox', os: 'Console', ...(quality === undefined ? {} : { quality }) }, ...(props ? { props } : {}) });
      push({ type: 'level_start', level: 'arena' });
      push(frames(ms));
      push(frames(ms));
      push({ type: 'session_end' });
    }
  });
  return out;
}

const ctxOf = (events) => buildContext(events, { service: 'hub', from: START, to: START + DAY - 1, type: 'all' });

// The same events as a range over 31 days reads them: one day, folded, stored and merged back.
function dayContext(events, { before = false } = {}) {
  const states = [...indexSessions(events).values()];
  const day = foldDay(START, { cells: rollup(events), facts: foldFacts(events), sessions: states.filter((s) => sessionDay(s) === START) });
  const parts = JSON.parse(JSON.stringify(dayParts(day).main));
  // A day stored before graphics settings were kept has none.
  if (before) for (const p of parts) if (p[0] === 'g') delete p[1].dev.q;
  const { cells, facts, daily } = mergeDays([dayFromParts(START, parts)], () => true);
  const ctx = sessionContext({ service: 'hub', from: START, to: START + DAY - 1, type: 'all' }, new Map());
  return Object.assign(ctx, { daily, cells, facts, meta: { approximate: [] }, drill: { hitches: [] } });
}

const FLEET = [[10, 3, 19], ['auto', 4, 17], [1, 2, 15], [7, 5, 17.5], [undefined, 2, 16]];

test('a breakdown by $graphics lists Automatic, then each level low to high, then sessions without one', () => {
  const ctx = ctxOf(sessions(FLEET));
  const [panel] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'breakdown', by: '$graphics' }] }));
  assert.equal(panel.title, 'Sessions by graphics quality');
  assert.equal(panel.split, 'graphics quality');
  assert.equal(panel.counts, 'sessions');
  assert.deepEqual(panel.rows.map((r) => [r.value, r.sessions]), [['Automatic', 4], ['1', 2], ['7', 5], ['10', 3], ['(none)', 2]]);
});

test("a game's own graphics property comes before what the SDK read, in its words and its presets' order", () => {
  assert.equal(graphicsOf({ props: { graphics: ['Ultra', 1] }, device: { quality: 3 } }), 'Ultra');
  assert.equal(graphicsOf({ device: { quality: 'auto' } }), 'Automatic');
  assert.equal(graphicsOf({ device: { quality: 0 } }), '0');
  assert.equal(graphicsOf({ device: {} }), null);

  const ctx = ctxOf(sessions([[3, 2, 18, { graphics: 'ultra' }], [3, 1, 16, { graphics: 'low' }], [3, 2, 17, { graphics: 'medium' }], [3, 1, 17, { graphics: 'custom' }]]));
  const [panel] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'breakdown', by: '$graphics' }] }));
  assert.deepEqual(panel.rows.map((r) => r.value), ['low', 'medium', 'ultra', 'custom'], 'the usual preset words low to high, others after');
});

test('glitchless_performance gives frame time per graphics setting, lowest first, only for sessions that have one', () => {
  const p = performance(ctxOf(sessions(FLEET)));
  assert.deepEqual(p.by_graphics.map((r) => [r.key, r.sessions]), [['Automatic', 4], ['1', 2], ['7', 5], ['10', 3]]);
  const ten = p.by_graphics.find((r) => r.key === '10');
  const one = p.by_graphics.find((r) => r.key === '1');
  assert.ok(ten.p95 > one.p95 + 3, 'the highest setting draws slower here');

  // A game whose SDK reads no setting and that sets no property has no rows (the dashboard hides the segment).
  assert.deepEqual(performance(ctxOf(sessions([[undefined, 3, 16]]))).by_graphics, []);
});

test('a range over 31 days gets the same rows from the day rollups, and days stored before them have none', () => {
  const events = sessions(FLEET);
  const live = performance(ctxOf(events)).by_graphics;
  const daily = dailyPerformance(dayContext(events)).by_graphics;
  assert.deepEqual(daily.map((r) => [r.key, r.sessions, r.p95]), live.map((r) => [r.key, r.sessions, r.p95]));
  assert.deepEqual(dailyPerformance(dayContext(events, { before: true })).by_graphics, []);
});
