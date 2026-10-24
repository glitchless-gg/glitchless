// Two things the Starlift audit found the server could not tell (SPEC §2 load, hitch causes):
// - Players' median time to first frame was 5.3 s against 0.7 s on the developer's phone: a first launch of a
//   version builds its shader caches. Engine SDKs now say which launches were first (first_launch), and the
//   slow-start finding splits them.
// - 67 of 77 hitches had no cause: their time went outside the game's measured code (the GPU, which Godot doesn't
//   time on Metal, presenting, the OS). The Godot SDK now calls that gpu_or_os, and findings word it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, performance } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const T0 = 1_760_000_000_000;
const GODOT = 'glitchless-godot/0.3.0';
let seq = 0;

function session(events, { sdk = GODOT } = {}) {
  const id = `s_${++seq}`;
  const base = { service: 'starlift', env: 'prod', version: '1.1', session_id: id, player_id: id, sdk };
  return [{ type: 'session_start', ts: T0, session_type: 'user', device: { browser: 'Godot', os: 'iOS', driver: 'metal' } }, ...events].map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values, extra = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, hz: 60, budget_ms: 16.67, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'starlift', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });

test('time to first frame is split into first launches of a version and the launches after', () => {
  const evs = [];
  for (let i = 0; i < 6; i++) evs.push(...session([{ type: 'load', ts: T0 + 500, ttff_ms: 5300 + i * 900, first_launch: true }]));
  for (let i = 0; i < 4; i++) evs.push(...session([{ type: 'load', ts: T0 + 500, ttff_ms: 700 + i * 10, first_launch: false }]));
  evs.push(...session([{ type: 'load', ts: T0 + 500, ttff_ms: 900 }])); // an older SDK: not said
  const ctx = ctxOf(evs);
  const by = performance(ctx).kpis.ttff_first_launch;
  assert.deepEqual(by.first, { sessions: 6, p50: 8000, slow_pct: 100 });
  assert.deepEqual(by.later, { sessions: 4, p50: 720, slow_pct: 0 });
  const slow = findings(ctx).find((f) => f.id === 'load-ttff');
  assert.match(slow.summary, /First launches of a version take a median 8\.0s \(100% over 4s, 6 sessions\), later launches 0\.7s \(0%, 4\)\./);
  assert.deepEqual(slow.evidence.by_launch, by);

  // Without first_launch, nothing is said about it.
  const old = ctxOf(session([{ type: 'load', ts: T0 + 500, ttff_ms: 9000 }]));
  assert.equal(performance(old).kpis.ttff_first_launch, null);
  assert.doesNotMatch(findings(old).find((f) => f.id === 'load-ttff').summary, /First launches/);
});

test('hitches spent outside the game code are named, with Godot advice about the GPU and the OS', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    const events = [{ type: 'level_start', ts: T0 + 100, level: 'endless_normal' }];
    for (let w = 0; w < 6; w++) {
      const ts = T0 + 1000 + w * 5000;
      events.push(frames('endless_normal', ts, [...Array(299).fill(16.7), 66.7]));
      events.push({ type: 'hitch', ts: ts + 4000, level: 'endless_normal', duration_ms: 66.7, causes: ['gpu_or_os'], process_ms: 0.1, physics_ms: 0, render_ms: 0.3, gpu_ms: null });
    }
    evs.push(...session(events));
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'hitches-level-endless_normal');
  assert.ok(f, 'a hitch finding');
  assert.equal(f.title, 'Hitches on endless_normal: 12 a minute, from time outside the game code (the GPU, presenting, the OS)');
  assert.deepEqual(f.evidence.hitch_causes, { gpu_or_os: 24 });
  assert.match(f.suggestion, /Godot times it only on Vulkan and Direct3D 12/);
});
