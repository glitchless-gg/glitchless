// Babylon.js and PlayCanvas sessions: findings read the SDK name on each session (envelope `sdk`) and give that
// engine's advice, not Three.js's; a Babylon.js render loop that stopped is a crash in Babylon's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const T0 = 1_760_000_000_000;
const BABYLON = 'glitchless-babylon/0.3.0';
const PLAYCANVAS = 'glitchless-playcanvas/0.3.0';
const THREE_JS = /InstancedMesh|THREE\.|compileAsync|geometry\.dispose|Phaser|Group/;
let seq = 0;

function session({ sdk, events = [], end = T0 + 60_000 }) {
  const id = `s_${++seq}`;
  const base = { service: 'g', env: 'prod', version: '1.0.0', session_id: id, player_id: id, sdk };
  const all = [{ type: 'session_start', ts: T0, device: { browser: 'Chrome', gpu_tier: 'mid' } }, ...events, { type: 'session_end', ts: end, reason: 'quit' }];
  return all.map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values, extra = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, budget_ms: 16.67, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'g', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const smooth = Array(400).fill(16.7);
const spiky = [...Array(360).fill(16.7), ...Array(40).fill(90)];

// Four sessions whose `level` stutters with these hitch causes and gauges.
function stutter(sdk, level, causes, ctx) {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        sdk,
        events: [
          { type: 'level_start', ts: T0 + 100, level: 'calm' },
          frames('calm', T0 + 5000, smooth, { ctx: Object.fromEntries(Object.keys(ctx).map((k) => [k, 10])) }),
          { type: 'level_start', ts: T0 + 10_000, level },
          ...[0, 1, 2, 3].map((k) => ({ type: 'hitch', ts: T0 + 11_000 + k * 1000, level, duration_ms: 120, causes, ctx, recent: ['prism'] })),
          frames(level, T0 + 15_000, spiky, { ctx }),
        ],
      }),
    );
  }
  return findings(ctxOf(evs)).find((f) => f.id === `perf-level-${level}`);
}

test('a Babylon.js stutter from shader compiles gets ShaderStore and instancing advice', () => {
  const f = stutter(BABYLON, 'nebula', ['shader_compile', 'object_spawn', 'script'], { materials: 400 });
  assert.ok(f, 'a frame-time finding for nebula');
  assert.match(f.suggestion, /ShaderStore\.ShadersStore/);
  assert.match(f.suggestion, /forceCompilationAsync|whenReadyAsync/);
  assert.match(f.suggestion, /thinInstanceAdd|createInstance/);
  assert.match(f.suggestion, /`materials` counts materials/);
  assert.doesNotMatch(f.suggestion, THREE_JS);
});

test('a slow Babylon.js render gets freezeActiveMeshes', () => {
  const f = stutter(BABYLON, 'garden', ['render'], { active_meshes: 3000 });
  assert.match(f.suggestion, /freezeActiveMeshes/);
});

test('a PlayCanvas stutter from spawning gets instancing and batching advice', () => {
  const f = stutter(PLAYCANVAS, 'canyon', ['object_spawn', 'geometry_upload'], { entities: 2400 });
  assert.ok(f, 'a frame-time finding for canyon');
  assert.match(f.suggestion, /setInstancing\(\)/);
  assert.match(f.suggestion, /app\.batcher|batch group/);
  assert.match(f.suggestion, /`entities` counts entities/);
  assert.doesNotMatch(f.suggestion, THREE_JS);
});

test('PlayCanvas shader compiles get its own advice', () => {
  const f = stutter(PLAYCANVAS, 'canyon', ['shader_compile'], { materials: 300 });
  assert.match(f.suggestion, /material variant/);
  assert.match(f.suggestion, /StandardMaterial per entity/);
});

test('errors: a stopped Babylon.js render loop is a crash in its words; PlayCanvas script errors get PlayCanvas advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ sdk: BABYLON, events: [{ type: 'custom', ts: T0 + 500, name: 'comet' }, { type: 'error', ts: T0 + 1000, kind: 'game_loop_stopped', message: "Babylon.js's render loop stopped after an uncaught error: TypeError", fn: 'Garden.collect', fingerprint: 'baby0001', source: 'game.js', line: 88 }], end: T0 + 9000 }));
    evs.push(...session({ sdk: PLAYCANVAS, events: [{ type: 'error', ts: T0 + 1000, kind: 'js', message: "TypeError: Cannot read properties of undefined (reading 'value')", fn: 'Collector.update', fingerprint: 'play0001', source: 'collector.js', line: 41 }] }));
  }
  const fs = findings(ctxOf(evs));
  const babylon = fs.find((f) => f.id === 'error-baby0001');
  const playcanvas = fs.find((f) => f.id === 'error-play0001');
  assert.match(babylon.summary, /Babylon\.js's render loop stopped — the game froze/);
  assert.doesNotMatch(babylon.summary, /Phaser/);
  assert.match(babylon.suggestion, /stops engine\.runRenderLoop for good/);
  assert.match(playcanvas.suggestion, /PlayCanvas keeps running after a script throws/);
  assert.match(playcanvas.summary, /debug build turns the script off/);
  for (const f of [babylon, playcanvas]) assert.doesNotMatch(f.suggestion, THREE_JS);
});

test('first-use shader compiles on a smooth Babylon.js level are named, with Babylon advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        sdk: BABYLON,
        events: [
          { type: 'level_start', ts: T0 + 100, level: 'nebula' },
          ...[0, 1, 2].map((k) => ({ type: 'hitch', ts: T0 + 2000 + k * 9000, level: 'nebula', duration_ms: 70, causes: ['shader_compile'], recent: ['prism'] })),
          // p95 within budget: one 70 ms frame in every other window
          ...[0, 1, 2, 3, 4, 5].map((k) => frames('nebula', T0 + k * 5000, k % 2 ? smooth : [...Array(399).fill(16.7), 70])),
        ],
        end: T0 + 30_000,
      }),
    );
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'hitches-level-nebula');
  assert.ok(f, 'a hitch finding for nebula');
  assert.match(f.title, /from shader compiles/);
  assert.match(f.suggestion, /ShaderStore/);
});
