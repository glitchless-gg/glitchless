import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, overview, funnel, errorIssues, performance, deathHotspots, versions, playtestSummary } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { normalize, parsePayload, IntakeError } from '../src/ingest.js';

const T0 = 1_760_000_000_000;
let seq = 0;

function session({ id = `s_${++seq}`, version = '1.0.0', events = [], tier = 'mid' }) {
  const base = { service: 'test', env: 'prod', version, session_id: id, player_id: `p_${id}` };
  return [{ type: 'session_start', ts: T0, device: { gpu_tier: tier, browser: 'Chrome' } }, ...events].map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values, extra = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, budget_ms: 16.67, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'test', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });

test('rage quit: session ends within 20s of a death without continuing', () => {
  const raged = session({ events: [{ type: 'level_start', ts: T0 + 1000, level: 'l1' }, { type: 'death', ts: T0 + 5000, level: 'l1', x: 10, y: 0, z: 0, cause: 'fell' }, { type: 'session_end', ts: T0 + 12000, reason: 'pagehide' }] });
  const calm = session({ events: [{ type: 'level_start', ts: T0 + 1000, level: 'l1' }, { type: 'death', ts: T0 + 5000, level: 'l1', x: 10, y: 0, z: 0, cause: 'fell' }, { type: 'session_end', ts: T0 + 90000, reason: 'pagehide' }] });
  const ctx = ctxOf([...raged, ...calm]);
  const k = overview(ctx).kpis;
  assert.equal(k.rage_quits, 1);
  assert.equal(funnel(ctx)[0].rage_quits, 1);
});

test('crash-free is game-aware: an unhandled error is only a crash if the player leaves right after', () => {
  const err = (ts) => ({ type: 'error', ts, kind: 'js', message: 'TypeError: boom', fingerprint: 'f1', fn: 'spawn' });
  const crashed = session({ events: [err(T0 + 1000), { type: 'session_end', ts: T0 + 4000, reason: 'pagehide' }] });
  const survived = session({ events: [err(T0 + 1000), { type: 'session_end', ts: T0 + 120000, reason: 'pagehide' }] });
  const k = overview(ctxOf([...crashed, ...survived])).kpis;
  assert.equal(k.crash_free_pct, 50);
  assert.equal(k.error_free_pct, 0);
});

test('global p95 comes from merged sketches, not averaged percentiles', () => {
  const smooth = session({ events: [frames('l1', T0 + 1000, Array(900).fill(16.6))] });
  const janky = session({ events: [frames('l1', T0 + 1000, [...Array(80).fill(16.6), ...Array(20).fill(80)])] });
  const k = performance(ctxOf([...smooth, ...janky])).kpis;
  // 20 slow frames out of 1000 = 2% → the merged p95 is still smooth; averaging per-session p95s would say ~48ms.
  assert.ok(k.frame_p95 < 18, `p95 ${k.frame_p95}`);
  assert.ok(k.frame_p99 > 70, `p99 ${k.frame_p99}`);
});

test('errors group by fingerprint and keep breadcrumbs', () => {
  const s = session({ events: [{ type: 'custom', ts: T0 + 500, name: 'bone_collected' }, { type: 'error', ts: T0 + 1000, kind: 'js', message: 'TypeError: x', fingerprint: 'abc', fn: 'spawn', level: 'l2' }, { type: 'error', ts: T0 + 1100, kind: 'js', message: 'TypeError: x', fingerprint: 'abc', fn: 'spawn', level: 'l2' }] });
  const [issue] = errorIssues(ctxOf(s));
  assert.equal(issue.count, 2);
  assert.equal(issue.sessions, 1);
  assert.deepEqual(issue.breadcrumbs.map((b) => b.name || b.type), ['session_start', 'bone_collected']);
});

test('death hotspots cluster nearby deaths', () => {
  const deaths = [...Array(30)].map((_, i) => ({ x: 44 + (i % 4) * 0.5, y: -7, z: 0, cause: 'fell' })).concat([{ x: 10, y: 0, z: 0, cause: 'squirrel' }]);
  const [top] = deathHotspots(deaths, 'xy');
  assert.equal(top.deaths, 30);
  assert.equal(top.top_cause, 'fell');
});

test('findings tie a hitchy level to the event that precedes its hitches', () => {
  const evs = [];
  for (let i = 0; i < 6; i++) {
    const s = session({});
    const t = T0 + 10_000;
    s.push(...session({ id: s[0].session_id }).slice(1));
    const extra = [{ type: 'level_start', ts: T0 + 100, level: 'l1' }, frames('l1', T0 + 500, Array(300).fill(16.7), { ctx: { particles: 0 } }), { type: 'level_start', ts: t, level: 'l2' }];
    for (let k = 0; k < 5; k++) {
      const ts = t + 1000 + k * 6000;
      for (let b = 0; b < 4; b++) extra.push({ type: 'custom', ts: ts - 3000 + b * 700, level: 'l2', name: 'bone_collected' });
      extra.push({ type: 'custom', ts, level: 'l2', name: 'powerup' });
      extra.push({ type: 'hitch', ts: ts + 20, level: 'l2', duration_ms: 180, ctx: { particles: 600 * (k + 1) }, recent: ['powerup', 'bone_collected'], causes: ['script'] });
      extra.push(frames('l2', ts, [...Array(250).fill(30), 180], { ctx: { particles: 600 * (k + 1) } }));
      extra.push(frames('l2', ts + 3000, Array(250).fill(16.8), { ctx: { particles: 0 }, hitches: 0 }));
    }
    evs.push(...s, ...extra.map((e) => ({ level: null, ...e, service: 'test', env: 'prod', version: '1.0.0', session_id: s[0].session_id, player_id: s[0].player_id })));
  }
  const fs = findings(ctxOf(evs));
  const perf = fs.find((f) => f.id === 'perf-level-l2');
  assert.ok(perf, `findings: ${fs.map((f) => f.id)}`);
  assert.equal(perf.evidence.preceding_events[0].event, 'powerup');
  assert.equal(perf.evidence.correlated_gauges[0].key, 'particles');
});

test('versions compares each build on its own sessions and frames', () => {
  const old = session({ version: '1.0.0', events: [{ type: 'level_start', ts: T0 + 100, level: 'l1' }, frames('l1', T0 + 1000, [...Array(90).fill(16.6), ...Array(10).fill(60)], { draw_calls: 4000, render_ms: 9 })] });
  const fixed = session({ version: '1.0.1', events: [{ type: 'level_start', ts: T0 + 200, level: 'l1' }, frames('l1', T0 + 1000, Array(100).fill(16.6), { draw_calls: 300, render_ms: 1 })] });
  const [a, b] = versions(ctxOf([...old, ...fixed]));
  assert.deepEqual([a.version, b.version], ['1.0.0', '1.0.1']);
  assert.equal(a.draw_calls, 4000);
  assert.equal(b.draw_calls, 300);
  assert.ok(a.level_p95.l1 > 50 && b.level_p95.l1 < 18, JSON.stringify([a.level_p95, b.level_p95]));
});

test('playtest summary covers exactly the requested sessions', () => {
  const err = { type: 'error', ts: T0 + 900, kind: 'js', message: 'TypeError: boom', fingerprint: 'f9', fn: 'spawn', level: 'l2' };
  const run = session({ id: 's_run', events: [{ type: 'level_start', ts: T0 + 100, level: 'l2' }, frames('l2', T0 + 1000, Array(100).fill(16.6), { draw_calls: 250, render_ms: 1.2 }), err, err] });
  const other = session({ id: 's_other', events: [frames('l2', T0 + 1000, Array(100).fill(90), { draw_calls: 9000 })] });
  const ctx = buildContext([...run, ...other], { service: 'test', from: T0 - 1000, to: T0 + 3600e3, type: 'all', sessions: new Set(['s_run']) });
  const s = playtestSummary(ctx);
  assert.equal(s.sessions, 1);
  assert.equal(s.levels.l2.draw_calls, 250);
  assert.ok(s.frame_p95 < 18, `p95 ${s.frame_p95}`);
  assert.deepEqual(s.errors.map((e) => [e.fingerprint, e.count]), [['f9', 2]]);
  assert.equal(s.runs[0].session_id, 's_run');
});

test('ingest validates envelopes and flattens them onto events', () => {
  assert.throws(() => parsePayload('{"events":[]}', {}), IntakeError);
  const p = parsePayload(JSON.stringify({ service: 'Zoomies', session_id: 's_1', version: '1.0.0', events: [{ type: 'death', ts: Date.now(), x: 1 }, { type: 'nope' }] }), {});
  const out = normalize(p);
  assert.equal(out.length, 1);
  assert.equal(out[0].service, 'zoomies');
  assert.equal(out[0].session_id, 's_1');
});

test('a bug report keeps its note when its screenshot is too big or not an image', () => {
  const shot = (n) => 'data:image/jpeg;base64,' + 'A'.repeat(n);
  const p = parsePayload(JSON.stringify({ service: 'zoomies', session_id: 's_1', events: [
    { type: 'bug_report', ts: Date.now(), note: 'stuck in the wall', screenshot: shot(1000) },
    { type: 'bug_report', ts: Date.now(), note: 'too big', screenshot: shot(200_000) },
    { type: 'bug_report', ts: Date.now(), note: 'not an image', screenshot: 'https://example.com/a.jpg' },
  ] }), {});
  const out = normalize(p);
  assert.deepEqual(out.map((e) => [e.note, typeof e.screenshot]), [['stuck in the wall', 'string'], ['too big', 'undefined'], ['not an image', 'undefined']]);
});
