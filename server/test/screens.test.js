// Frame time judged against each screen's own refresh rate (SPEC §4 "Frame budget"). Starlift's players are iPhones
// at 120 Hz and Android phones at 60 Hz: its median budget is 8.33 ms, so against that one budget a 60 Hz phone drawing
// every frame on time (16.7 ms) read yellow and could get frame-time findings. Each frame is judged against its own
// window's budget instead, in the queries, the findings, a day rollup and the dashboard's colours (format.js, which
// has no imports, so it runs here as it does in the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, sessionContext, indexSessions, overview, performance, versions, sessionSummary } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { rollup } from '../src/rollups.js';
import { foldFacts } from '../src/facts.js';
import { foldDay, dayParts, dayFromParts, mergeDays, sessionDay, dailyPerformance, DAY } from '../src/daily.js';
import { evaluateBoard, validateBoard } from '../src/board.js';
import { frameStatus, commonScreens, budgetLines } from '../../apps/dashboard/src/format.js';

const START = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
const T0 = START + 3_600_000;
const SCREENS = {
  120: { budget: 8.33, device: { browser: 'Godot', os: 'iOS', gpu_tier: 'high' }, props: { model: 'iphone_15_pro' } },
  60: { budget: 16.67, device: { browser: 'Godot', os: 'Android', gpu_tier: 'low' }, props: { model: 'pixel_7a' } },
};

// A 5-second window of 300 frames within 0.2 ms of `ms`, at one screen's budget.
function frames(level, ms, hz) {
  const sk = new Sketch();
  for (let f = 0; f < 300; f++) sk.add(ms - 0.2 + (f % 5) * 0.1);
  return { type: 'frame_window', level, duration_s: 5, frames: 300, hz: Number(hz), budget_ms: SCREENS[hz].budget, ft: sk.toJSON(), ft_p50: ms, ft_p95: ms + 0.2, ft_max: ms + 0.2, hitches: 0 };
}

// 30 iPhone sessions at 8.5 ms and 20 Android ones at `ms60` (on time: 16.7 ms; slow: 25 ms), on two versions and two
// levels, two windows a level.
function fleet(ms60) {
  const out = [];
  let i = 0;
  for (const [hz, n, ms] of [['120', 30, 8.5], ['60', 20, ms60]]) {
    for (let k = 0; k < n; k++, i++) {
      const base = { service: 'starlift', env: 'prod', version: i % 2 ? '1.2' : '1.1', session_id: `s_${hz}_${k}`, player_id: `p_${hz}_${k}`, sdk: 'glitchless-godot/0.6.0', level: null };
      let ts = T0 + i * 120_000;
      const push = (e) => out.push({ ...base, ...e, ts: (ts += 1000) });
      push({ type: 'session_start', session_type: 'user', device: SCREENS[hz].device, props: SCREENS[hz].props });
      for (const level of ['orbit_1', 'orbit_2']) {
        push({ type: 'level_start', level });
        push(frames(level, ms, hz));
        push(frames(level, ms, hz));
      }
      push({ type: 'session_end' });
    }
  }
  return out;
}

const ctxOf = (events) => buildContext(events, { service: 'starlift', from: START, to: START + DAY - 1, type: 'all' });

// The same events as a store with daily rollups answers a range over 31 days: one day, folded, stored and merged back.
function dayContext(events, { before = false } = {}) {
  const states = [...indexSessions(events).values()];
  const day = foldDay(START, { cells: rollup(events), facts: foldFacts(events), sessions: states.filter((s) => sessionDay(s) === START) });
  const parts = JSON.parse(JSON.stringify(dayParts(day).main));
  // A day stored before screens were kept has none.
  if (before) for (const p of parts) if (p[0] === 'g') delete p[1].dev.hz;
  const { cells, facts, daily } = mergeDays([dayFromParts(START, parts)], () => true);
  const ctx = sessionContext({ service: 'starlift', from: START, to: START + DAY - 1, type: 'all' }, new Map());
  return Object.assign(ctx, { daily, cells, facts, meta: { approximate: [] }, drill: { hitches: [] } });
}

const ROWS = ['by_level', 'by_version', 'by_gpu_tier', 'by_platform', 'by_display'];
const frameIds = (list) => list.map((f) => f.id).filter((id) => /^(perf-level|perf-prop|device-gap)/.test(id));

test('the dashboard grades frame time from the frames over their own screen\'s budget', () => {
  assert.equal(frameStatus(null, 16.7), 'neutral');
  assert.equal(frameStatus(0, 16.7), 'ok', "a 60 Hz phone's p95 next to 120 Hz ones");
  assert.equal(frameStatus(4.9, 30), 'ok');
  assert.equal(frameStatus(5, 20), 'warn');
  assert.equal(frameStatus(14.9, 30), 'warn');
  assert.equal(frameStatus(15, 20), 'alert');
  assert.equal(frameStatus(100, 25), 'alert', '60 Hz phones at 25 ms');
  assert.equal(frameStatus(10, 90), 'alert', 'a tenth of frames at 90 ms is janky on any screen');
  // The other percentiles of a headline: p50 is green while under half the frames are over, p99 under 1%.
  assert.deepEqual([frameStatus(49, 17, 0.5), frameStatus(50, 17, 0.5)], ['ok', 'alert']);
  assert.deepEqual([frameStatus(0.9, 40, 0.99), frameStatus(2, 30, 0.99), frameStatus(2, 40, 0.99), frameStatus(3, 20, 0.99)], ['ok', 'warn', 'alert', 'alert']);
  // Screens: common at 10% of the frame windows, read apart when two or more are.
  assert.deepEqual(commonScreens([{ key: '120 Hz', windows_pct: 92 }, { key: '60 Hz', windows_pct: 8 }]), []);
  assert.deepEqual(budgetLines({ 8.33: 92, 16.67: 8 }, 8.33), [{ value: 8.33, color: '#1fae84', label: 'budget' }]);
  assert.deepEqual(budgetLines({ 16.67: 40, 8.33: 60 }, 8.33).map((l) => l.label), ['120 Hz budget', '60 Hz budget']);
});

test('120 Hz phones at 8.5 ms and 60 Hz phones at 16.7 ms read all green', () => {
  const ctx = ctxOf(fleet(16.7));
  const p = performance(ctx);
  // The case that read yellow: every frame against the median screen's budget.
  assert.equal(p.kpis.frame_budget_ms, 8.33);
  assert.ok(p.kpis.frame_p95 > 16, `p95 ${p.kpis.frame_p95}`);
  assert.equal(p.kpis.pct_frames_over_budget, 0);
  assert.deepEqual([frameStatus(0, p.kpis.frame_p50, 0.5), frameStatus(0, p.kpis.frame_p95), frameStatus(0, p.kpis.frame_p99, 0.99)], ['ok', 'ok', 'ok']);
  for (const k of ROWS) for (const r of p[k]) assert.equal(frameStatus(r.pct_over_budget, r.p95), 'ok', `${k} ${r.key}: ${r.pct_over_budget}% over, p95 ${r.p95}`);
  // The headline splits by screen.
  assert.deepEqual(
    p.by_display.map((r) => [r.key, r.hz, r.budget_ms, r.windows_pct, r.sessions]),
    [['120 Hz', 120, 8.33, 60, 30], ['60 Hz', 60, 16.67, 40, 20]],
  );
  assert.ok(Math.abs(p.by_display[0].p50 - 8.5) < 0.2 && Math.abs(p.by_display[1].p50 - 16.7) < 0.3, JSON.stringify(p.by_display.map((r) => r.p50)));
  assert.equal(commonScreens(p.by_display).length, 2);

  const o = overview(ctx).kpis;
  assert.equal(o.pct_frames_over_budget, 0);
  assert.deepEqual(o.frame_budgets, { 8.33: 60, 16.67: 40 });
  for (const v of versions(ctx)) assert.equal(frameStatus(v.pct_frames_over_budget, v.frame_p95), 'ok', `${v.version}: ${v.pct_frames_over_budget}%`);
  const phone = sessionSummary(ctx.sessions.get('s_60_0'));
  assert.deepEqual([phone.budget_ms, phone.pct_over_budget, frameStatus(phone.pct_over_budget, phone.p95)], [16.67, 0, 'ok']);

  // A board's frame panel draws each screen's budget.
  const [panel] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'frame_time' }] }));
  assert.equal(panel.kpis.pct_over_budget, 0);
  assert.deepEqual(budgetLines(panel.budgets, panel.budget_ms).map((l) => [l.value, l.label]), [[8.33, '120 Hz budget'], [16.67, '60 Hz budget']]);

  // No frame-time finding, no low-tier gap, no slow phone model: nothing is late on its own screen.
  assert.deepEqual(frameIds(findings(ctx)), []);
});

test('60 Hz phones at 25 ms read red and get their findings', () => {
  const ctx = ctxOf(fleet(25));
  const p = performance(ctx);
  assert.equal(p.kpis.pct_frames_over_budget, 40);
  assert.equal(frameStatus(p.kpis.pct_frames_over_budget, p.kpis.frame_p95), 'alert');
  const [fast, slow] = p.by_display;
  assert.deepEqual([fast.key, fast.pct_over_budget, frameStatus(fast.pct_over_budget, fast.p95)], ['120 Hz', 0, 'ok']);
  assert.deepEqual([slow.key, slow.pct_over_budget, frameStatus(slow.pct_over_budget, slow.p95)], ['60 Hz', 100, 'alert']);
  for (const l of p.by_level) assert.equal(frameStatus(l.pct_over_budget, l.p95), 'alert', l.key);
  assert.equal(frameStatus(p.by_gpu_tier.find((t) => t.key === 'low').pct_over_budget, 25), 'alert');
  for (const v of versions(ctx)) assert.equal(frameStatus(v.pct_frames_over_budget, v.frame_p95), 'alert', v.version);

  const list = findings(ctx);
  const level = list.find((f) => f.id === 'perf-level-orbit_1');
  assert.ok(level, frameIds(list).join(', '));
  assert.match(level.title, /^Frame-time spikes on orbit_1: p95 2\d(\.\d+)?ms, 40% of frames over budget$/);
  assert.match(level.summary, /^orbit_1 misses the frame budget on 40% of frames, each against its own screen's refresh rate/);
  assert.ok(list.some((f) => f.id === 'perf-level-orbit_2'));
  const model = list.find((f) => f.id === 'perf-prop-model');
  assert.ok(model, 'the slow phone model');
  assert.equal(model.evidence.value, 'pixel_7a');
  assert.equal(model.evidence.pct_over_budget, 100);
});

test('a day rollup judges each screen the same way', () => {
  for (const [ms60, over] of [
    [16.7, 0],
    [25, 40],
  ]) {
    const events = fleet(ms60);
    const day = dayContext(events);
    const p = dailyPerformance(day);
    assert.equal(p.kpis.pct_frames_over_budget, over);
    assert.deepEqual(p.by_display, performance(ctxOf(events)).by_display, 'by screen, as the raw events give it');
    for (const k of ROWS) for (const r of p[k]) assert.equal(frameStatus(r.pct_over_budget, r.p95) === 'ok', !over || r.pct_over_budget === 0, `${ms60} ms: ${k} ${r.key}`);
    // The same frame-time findings as the raw events, but a slow setting: that needs each session's properties.
    const ids = frameIds(findings(day)).sort();
    assert.deepEqual(ids, frameIds(findings(ctxOf(events))).filter((id) => !id.startsWith('perf-prop')).sort());
    assert.equal(ids.includes('perf-level-orbit_1'), over > 0, `${ms60} ms: ${ids}`);
  }
  // A day stored before screens were kept has no split by screen; every other row still judges each screen.
  const old = dailyPerformance(dayContext(fleet(16.7), { before: true }));
  assert.deepEqual(old.by_display, []);
  assert.equal(old.kpis.pct_frames_over_budget, 0);
});
