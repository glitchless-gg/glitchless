// Phaser and Unity sessions: findings read the SDK name on each session (envelope `sdk`) and name that
// engine's APIs; a Phaser game loop that stopped is a crash; Unity's uncaught `exception` is unhandled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, errorIssues } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const T0 = 1_760_000_000_000;
const PHASER = 'glitchless-phaser/0.2.0';
const UNITY = 'glitchless-unity/0.1.0';
let seq = 0;

function session({ id = `s_${++seq}`, version = '1.0.0', sdk, events = [], end = null }) {
  const base = { service: 'g', env: 'prod', version, session_id: id, player_id: id, sdk };
  const browser = sdk === UNITY ? 'Unity' : 'Chrome';
  const all = [{ type: 'session_start', ts: T0, device: { browser, gpu_tier: 'mid' } }, ...events];
  if (end != null) all.push({ type: 'session_end', ts: end, reason: 'quit' });
  return all.map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values, extra = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, budget_ms: 16.67, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'g', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const THREE_JS = /InstancedMesh|THREE\.|compileAsync|devicePixelRatio|KTX2|geometry\.dispose/;
const smooth = Array(400).fill(16.7);
const spiky = [...Array(360).fill(16.7), ...Array(40).fill(90)];

test('a Phaser game loop that stopped is a crash, even if the player stayed', () => {
  const error = { type: 'error', ts: T0 + 1000, kind: 'js', message: "TypeError: Cannot read properties of undefined (reading 'seconds')", fn: 'Level.catchToy', fingerprint: 'aaaa0001' };
  const stopped = { type: 'error', ts: T0 + 4000, kind: 'game_loop_stopped', message: "Phaser's game loop stopped after an uncaught error: TypeError", fn: 'Level.catchToy', fingerprint: 'aaaa0002' };
  const evs = [
    ...session({ id: 's_halted', sdk: PHASER, events: [error, stopped], end: T0 + 60_000 }),
    ...session({ id: 's_fine', sdk: PHASER, events: [error], end: T0 + 60_000 }),
  ];
  const ctx = ctxOf(evs);
  assert.equal(ctx.sessions.get('s_halted').crashed, true);
  assert.equal(ctx.sessions.get('s_fine').crashed, false, 'an error 59 s before leaving is not a crash');
  const issue = errorIssues(ctx).find((i) => i.kind === 'game_loop_stopped');
  assert.equal(issue.fatal, true);
});

test('Unity exceptions are unhandled errors', () => {
  const ex = { type: 'error', ts: T0 + 1000, kind: 'exception', message: 'KeyNotFoundException: frisbee', fn: 'FetchGame.CatchToy', fingerprint: 'bbbb0001', source: 'FetchGame.cs', line: 367 };
  const log = { type: 'error', ts: T0 + 1500, kind: 'log_error', message: 'Missing sprite', fn: 'Shop.Open', fingerprint: 'bbbb0002' };
  const ctx = ctxOf([...session({ id: 's_u', sdk: UNITY, events: [ex, log], end: T0 + 5000 })]);
  assert.equal(ctx.sessions.get('s_u').crashed, true, 'an uncaught exception right before leaving counts as a crash');
  const issues = errorIssues(ctx);
  assert.equal(issues.find((i) => i.kind === 'exception').fatal, true);
  assert.equal(issues.find((i) => i.kind === 'log_error').fatal, false);
});

test('error findings give engine-specific advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ sdk: PHASER, events: [{ type: 'custom', ts: T0 + 500, name: 'powerup' }, { type: 'error', ts: T0 + 1000, kind: 'game_loop_stopped', message: 'Phaser loop stopped', fn: 'Level.catchToy', fingerprint: 'cccc0001', source: 'scenes.js', line: 263 }], end: T0 + 9000 }));
    evs.push(...session({ sdk: UNITY, events: [{ type: 'error', ts: T0 + 1000, kind: 'exception', message: 'NullReferenceException: Object reference not set', fn: 'Player.Update', fingerprint: 'dddd0001', source: 'Player.cs', line: 42 }], end: T0 + 9000 }));
  }
  const fs = findings(ctxOf(evs));
  const phaser = fs.find((f) => f.id === 'error-cccc0001');
  const unity = fs.find((f) => f.id === 'error-dddd0001');
  assert.match(phaser.summary, /Phaser's game loop stopped — the game froze/);
  assert.match(phaser.suggestion, /stops the game loop for good/);
  assert.match(unity.summary, /Unity skipped the rest of that callback/);
  assert.match(unity.suggestion, /GetComponent\(\)|MissingReferenceException/);
  for (const f of [phaser, unity]) assert.doesNotMatch(f.suggestion, THREE_JS);
});

test('a Phaser frame-time finding talks about bodies and listeners, not meshes', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        sdk: PHASER,
        events: [
          { type: 'level_start', ts: T0 + 100, level: 'level-1' },
          frames('level-1', T0 + 5000, smooth, { ctx: { physics_bodies: 30 } }),
          { type: 'level_start', ts: T0 + 10_000, level: 'level-2' },
          ...[0, 1, 2, 3].map((k) => ({ type: 'hitch', ts: T0 + 11_000 + k * 1000, level: 'level-2', duration_ms: 90, causes: ['object_spawn', 'script'], ctx: { physics_bodies: 2400 }, recent: ['powerup'] })),
          frames('level-2', T0 + 15_000, spiky, { ctx: { physics_bodies: 2400 } }),
        ],
      }),
    );
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'perf-level-level-2');
  assert.ok(f, 'a frame-time finding for level-2');
  assert.match(f.suggestion, /physics_bodies|Group|destroy\(\)/);
  assert.doesNotMatch(f.suggestion, THREE_JS);
});

test('Unity mesh counts that grow per level load are a mesh leak with Unity advice', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        sdk: UNITY,
        version: '2.0.0',
        events: [0, 1, 2].flatMap((n) => [
          { type: 'level_start', ts: T0 + 100 + n * 10_000, level: `level-${n + 1}` },
          frames(`level-${n + 1}`, T0 + 5000 + n * 10_000, smooth, { geometries: 50 + n * 120 }),
        ]),
      }),
    );
  }
  const leak = findings(ctxOf(evs)).find((x) => x.id === 'leak-geometries-2.0.0');
  assert.ok(leak);
  assert.equal(leak.title, 'Mesh leak in 2.0.0: +120 meshes per level load');
  assert.match(leak.suggestion, /sharedMaterial|Destroy\(\)/);
  assert.doesNotMatch(leak.suggestion, /dispose\(\)/);
});
