// What the server needs to get right for the Godot SDK (godot/addons/glitchless).
//
// The SDK ships its own port of the frame-time sketch (sketch.gd).
// The server merges sketches bucket by bucket, so the GDScript port must put every value in the
// same bucket as packages/sdk/src/sketch.js. The fixture holds frame times and the sketch Godot
// made of them; regenerate it with:
//   godot --headless --path godot --script res://test/sketch_fixture.gd
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, performance, overview, errorIssues, heatmap } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../../godot/test/fixtures/sketch.json', import.meta.url), 'utf8'));
const gd = fixture.sketch;

test('the GDScript sketch buckets every frame time like the JavaScript sketch', () => {
  const js = new Sketch();
  fixture.values.forEach((v) => js.add(v));
  const mine = js.toJSON();
  assert.deepEqual(gd.b, mine.b);
  assert.equal(gd.n, mine.n);
  assert.equal(gd.z, mine.z);
  assert.equal(gd.mn, mine.mn);
  assert.equal(gd.mx, mine.mx);
  assert.ok(Math.abs(gd.s - mine.s) < 0.2, `sum ${gd.s} vs ${mine.s}`);
});

test('quantiles read from the GDScript sketch match what Godot computed', () => {
  const s = Sketch.from(gd);
  for (const [q, v] of Object.entries(fixture.quantiles)) assert.equal(s.quantile(Number(q)), v, `q${q}`);
  assert.equal(s.fractionAbove(19.17), fixture.fraction_above_19_17);
});

test('the server merges Godot frame windows with browser ones', () => {
  const browser = new Sketch();
  for (let i = 0; i < 500; i++) browser.add(16.7 + (i % 7) * 0.1);
  const T0 = 1_760_000_000_000;
  const base = (sdk, session_id) => ({ service: 'mixed', env: 'prod', version: '1.0.0', session_id, player_id: session_id, sdk });
  const events = [
    { type: 'session_start', ts: T0, level: null, device: { browser: 'Godot', gpu_tier: 'mid' }, ...base('glitchless-godot/0.1.0', 's_gd') },
    { type: 'frame_window', ts: T0 + 1000, level: 'l1', frames: gd.n, duration_s: 30, budget_ms: 16.67, ft: gd, hitches: 0, ...base('glitchless-godot/0.1.0', 's_gd') },
    { type: 'session_start', ts: T0, level: null, device: { browser: 'Chrome', gpu_tier: 'mid' }, ...base('glitchless-browser/0.1.0', 's_js') },
    { type: 'frame_window', ts: T0 + 1000, level: 'l1', frames: 500, duration_s: 8, budget_ms: 16.67, ft: browser.toJSON(), hitches: 0, ...base('glitchless-browser/0.1.0', 's_js') },
  ];
  const ctx = buildContext(events, { service: 'mixed', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
  const perf = performance(ctx);
  const union = Sketch.from(gd).merge(browser.toJSON());
  assert.equal(perf.kpis.frame_p95, Math.round(union.quantile(0.95) * 100) / 100);
  assert.equal(perf.by_level[0].frames, gd.n + 500);
  assert.deepEqual(perf.by_browser.map((b) => b.key).sort(), ['Chrome', 'Godot']);
});

const T1 = 1_760_000_000_000;
const ctxOf = (events) => buildContext(events, { service: 'gd', from: T1 - 1000, to: T1 + 3600e3, type: 'all' });
const godotSession = (id, events) =>
  [{ type: 'session_start', ts: T1, device: { browser: 'Godot', gpu_tier: 'mid' } }, ...events].map((e) => ({ level: null, ...e, service: 'gd', env: 'prod', version: '1.0.0', session_id: id, player_id: id }));

test('a GDScript runtime error counts as unhandled, like an uncaught JS exception', () => {
  const err = { type: 'error', ts: T1 + 1000, kind: 'script', message: "Cannot call method 'queue_free' on a null value.", fingerprint: 'g1', fn: '_play_event' };
  const crashed = godotSession('s_a', [err, { type: 'session_end', ts: T1 + 3000, reason: 'background' }]);
  const survived = godotSession('s_b', [{ ...err, kind: 'push_error', fingerprint: 'g2' }, { type: 'session_end', ts: T1 + 3000, reason: 'background' }]);
  const ctx = ctxOf([...crashed, ...survived]);
  assert.equal(overview(ctx).kpis.crash_free_pct, 50);
  const issues = errorIssues(ctx);
  assert.equal(issues.find((i) => i.kind === 'script').fatal, true);
  assert.equal(issues.find((i) => i.kind === 'push_error').fatal, false);
});

test('deaths sent without coordinates (anonymous mode) count but are never placed on the map', () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push({ type: 'level_start', ts: T1 + i * 100, level: 'l1' }, { type: 'death', ts: T1 + i * 100 + 50, level: 'l1', cause: 'fell' });
  const ctx = ctxOf(godotSession('s_c', events));
  assert.equal(overview(ctx).kpis.deaths, 12);
  assert.equal(heatmap(ctx, 'l1', []).deaths.length, 0);
  assert.ok(!findings(ctx).some((f) => f.category === 'design'), 'no hotspot at x=0 from unplaced deaths');
});
