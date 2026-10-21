import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, judge } from '../src/compare.js';
import { comparisonReport } from '../src/report.js';
import { DEFAULT_THRESHOLDS } from '../src/config.js';

const scenarios = [{ params: { seed: 7 }, finished: true }];
const run = (summary, extra = {}) => ({ name: 'x', created: '2026-10-16T00:00:00.000Z', service: 'zoomies', scenarios, machine: { gpu: 'M3' }, summary, ...extra });
const base = {
  frame_p95: 16.8,
  render_cpu_ms: 8.8,
  draw_calls: 3500,
  hitches_per_min: 2,
  errors_per_session: 14,
  deaths_per_session: 1,
  level_completion_pct: 100,
  pct_frames_over_budget: 6,
  crashes: 0,
  levels: { 'level-2': { pct_frames_over_budget: 12, frame_p95: 33, draw_calls: 6700, render_cpu_ms: 9 } },
  errors: [{ fingerprint: 'popup', message: 'TypeError: position', count: 14, sessions: 1 }],
};

test('a change has to clear both the relative and the absolute margin', () => {
  const t = DEFAULT_THRESHOLDS.pct_frames_over_budget;
  assert.equal(judge(4.8, 5.4, t).status, 'same'); // +0.6 points: noise
  assert.equal(judge(0.5, 1.5, t).status, 'same'); // +200% but only +1 point
  assert.equal(judge(5, 20, t).status, 'regression');
  assert.equal(judge(20, 5, t).status, 'improvement');
  // p95 jumps between vsync steps, so on its own it only warns.
  assert.equal(judge(16.78, 33.12, DEFAULT_THRESHOLDS.frame_p95).status, 'warning');
  assert.equal(judge(100, 60, DEFAULT_THRESHOLDS.level_completion_pct).status, 'warning'); // lower is worse here
});

test('the confetti fix passes with improvements', () => {
  const fixed = { ...base, render_cpu_ms: 1.1, draw_calls: 300, pct_frames_over_budget: 1, levels: { 'level-2': { pct_frames_over_budget: 1, frame_p95: 16.8, draw_calls: 310, render_cpu_ms: 1.2 } } };
  const cmp = compareRuns(run(base), run(fixed));
  assert.equal(cmp.verdict, 'pass');
  assert.deepEqual(cmp.improvements.map((c) => c.id).sort(), ['draw_calls', 'level.draw_calls.level-2', 'level.frame_p95.level-2', 'level.pct_frames_over_budget.level-2', 'level.render_cpu_ms.level-2', 'pct_frames_over_budget', 'render_cpu_ms']);
});

test('slower frames on one level, a new error and a crash all fail', () => {
  const worse = { ...base, crashes: 1, levels: { 'level-2': { pct_frames_over_budget: 40, frame_p95: 50, draw_calls: 6700, render_cpu_ms: 9 } }, errors: [...base.errors, { fingerprint: 'new', message: 'RangeError: boom', location: 'spawn (fx.js:9)', count: 3, sessions: 1 }] };
  const cmp = compareRuns(run(base), run(worse));
  assert.equal(cmp.verdict, 'fail');
  assert.deepEqual(cmp.regressions.map((c) => c.id).sort(), ['crashes', 'level.pct_frames_over_budget.level-2', 'new_errors']);
  assert.deepEqual(cmp.warnings.map((c) => c.id), ['level.frame_p95.level-2']);
  const md = comparisonReport(run(base, { name: 'baseline' }), run(worse, { name: 'latest' }), cmp);
  assert.match(md, /FAIL, 3 regressions/);
  assert.match(md, /RangeError: boom/);
});

test('a level the baseline reached but the candidate did not is a warning', () => {
  const cmp = compareRuns(run(base), run({ ...base, levels: {} }));
  assert.equal(cmp.verdict, 'pass');
  assert.equal(cmp.warnings[0].id, 'level.reached.level-2');
});

test('different GPUs or scenarios are called out', () => {
  const cmp = compareRuns(run(base), run(base, { machine: { gpu: 'RTX 4070' }, scenarios: [{ params: { seed: 8 }, finished: false }] }));
  assert.equal(cmp.notes.length, 3);
});
