// Findings read the SDK name on each session (envelope `sdk`) and gives Godot sessions Godot findings:
// a leak finding from orphan_nodes instead of three.js geometries, and fixes that name Godot APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, performance } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const T0 = 1_760_000_000_000;
const GODOT = 'glitchless-godot/0.1.0';
const BROWSER = 'glitchless-browser/0.1.0';
let seq = 0;

function session({ id = `s_${++seq}`, version = '1.0.0', sdk = GODOT, tier = 'mid', events = [] }) {
  const base = { service: 'gd', env: 'prod', version, session_id: id, player_id: id, sdk };
  const browser = sdk === GODOT ? 'Godot' : 'Chrome';
  return [{ type: 'session_start', ts: T0, device: { browser, gpu_tier: tier } }, ...events].map((e) => ({ level: null, ...e, ...base }));
}

// A Godot frame window: geometries are null, scene-tree counts sit at the top level and in ctx.
function frames(level, ts, values, { nodes = 300, orphans = 0, objects = 4000, ...extra } = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  const counts = { nodes, orphan_nodes: orphans, objects };
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, budget_ms: 16.67, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length, geometries: null, textures: null, programs: null, ...counts, ctx: counts, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'gd', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const smooth = Array(400).fill(16.7);
const THREE_JS = /InstancedMesh|THREE\.|dispose\(\)|compileAsync|devicePixelRatio|KTX2|WebGL/;

// Three level loads; orphan_nodes after each one.
function leakySession(version, orphansPerLevel, nodesPerLevel = [300, 420, 350]) {
  return session({
    version,
    events: orphansPerLevel.flatMap((orphans, i) => [
      { type: 'level_start', ts: T0 + 100 + i * 10_000, level: `level_${i + 1}` },
      frames(`level_${i + 1}`, T0 + 5000 + i * 10_000, smooth, { orphans, nodes: nodesPerLevel[i] }),
    ]),
  });
}

test('orphan nodes that grow with every level load make a node-leak finding for the latest leaky version', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) evs.push(...leakySession('1.0.0', [0, 100, 200]));
  for (let i = 0; i < 4; i++) evs.push(...leakySession('1.0.1', [0, 2500, 5000]));
  const ctx = ctxOf(evs);
  assert.equal(performance(ctx).node_growth['1.0.1'].orphan_nodes_growth_per_level_load, 2500);

  const fs = findings(ctx);
  const leak = fs.find((f) => f.id === 'leak-orphan-nodes-1.0.1');
  assert.ok(leak, `findings: ${fs.map((f) => f.id)}`);
  assert.equal(leak.severity, 'high');
  assert.equal(leak.category, 'memory');
  assert.equal(leak.title, 'Node leak in 1.0.1: +2500 orphan nodes per level load');
  assert.match(leak.summary, /Across 4 sessions with 2\+ level loads, orphan nodes .* grow from a median of 0 to 5,000/);
  assert.match(leak.summary, /also in 1\.0\.0: \+100 per load/);
  assert.equal(leak.evidence.sessions, 4);
  assert.equal(leak.evidence.nodes_growth_per_level_load, 25);
  assert.match(leak.suggestion, /queue_free\(\)/);
  assert.match(leak.suggestion, /remove_child\(\) alone does not free it/);
  assert.match(leak.suggestion, /references to removed nodes/);
  assert.doesNotMatch(leak.suggestion, /get_tree\(\)\.root/, 'the live tree did not grow');
  assert.doesNotMatch(leak.suggestion, THREE_JS);
  assert.ok(!fs.some((f) => f.id.startsWith('leak-geometries')), 'Godot sends no geometries');
  assert.ok(!fs.some((f) => f.id === 'leak-orphan-nodes-1.0.0'), 'one leak finding, for the latest version');
});

test('a node leak that also grows the live tree says to look at autoloads and the root', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) evs.push(...leakySession('2.0.0', [0, 80, 160], [300, 600, 900]));
  const leak = findings(ctxOf(evs)).find((f) => f.id === 'leak-orphan-nodes-2.0.0');
  assert.equal(leak.severity, 'medium');
  assert.match(leak.summary, /The live tree grows too, from 300 to 900 nodes\./);
  assert.match(leak.suggestion, /autoload or get_tree\(\)\.root/);
});

test('a steady pool of orphan nodes is not a leak', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) evs.push(...leakySession('1.0.0', [200, 200, 210]));
  const fs = findings(ctxOf(evs));
  assert.ok(!fs.some((f) => f.category === 'memory'), `findings: ${fs.map((f) => f.id)}`);
});

test('hitch fixes on a Godot level name Godot APIs, ordered by the commonest cause', () => {
  const evs = [];
  for (let i = 0; i < 6; i++) {
    const t = T0 + 10_000;
    const extra = [{ type: 'level_start', ts: T0 + 100, level: 'level_1' }, frames('level_1', T0 + 500, smooth), { type: 'level_start', ts: t, level: 'level_2' }];
    extra.push({ type: 'hitch', ts: t + 30, level: 'level_2', duration_ms: 90, causes: ['scene_change'], ctx: { nodes: 300, orphan_nodes: 0, objects: 4000 }, recent: ['level_start'] });
    for (let k = 0; k < 5; k++) {
      const ts = t + 1000 + k * 6000;
      for (let b = 0; b < 4; b++) extra.push({ type: 'custom', ts: ts - 3000 + b * 700, level: 'level_2', name: 'pickup' });
      extra.push({ type: 'custom', ts, level: 'level_2', name: 'powerup' });
      const burst = { nodes: 2800, orphan_nodes: 0, objects: 9000 };
      extra.push({ type: 'hitch', ts: ts + 20, level: 'level_2', duration_ms: 180, ctx: burst, recent: ['powerup', 'pickup'], causes: ['node_spawn', 'script'], nodes_added: 2500 });
      extra.push(frames('level_2', ts, [...Array(250).fill(30), 180], { nodes: 2800, objects: 9000 }));
      extra.push(frames('level_2', ts + 3000, Array(250).fill(16.8), { hitches: 0 }));
    }
    evs.push(...session({ events: extra }));
  }
  const fs = findings(ctxOf(evs));
  const perf = fs.find((f) => f.id === 'perf-level-level_2');
  assert.ok(perf, `findings: ${fs.map((f) => f.id)}`);
  assert.equal(perf.evidence.preceding_events[0].event, 'powerup');
  assert.equal(perf.evidence.correlated_gauges[0].key, 'nodes');
  assert.deepEqual(perf.evidence.hitch_causes, { scene_change: 6, node_spawn: 30, script: 30 });
  const s = perf.suggestion;
  assert.match(s, /^Find the code that runs on `powerup` and drives `nodes`\. If it spawns many nodes, draw them with one MultiMeshInstance2D\/3D/);
  assert.match(s, /instantiate\(\)/);
  assert.match(s, /queue_free\(\)/);
  assert.ok(s.indexOf('add many nodes in one frame') < s.indexOf('long _process()'), 'node_spawn before script');
  assert.ok(s.indexOf('long _process()') < s.indexOf('ResourceLoader.load_threaded_request()'), 'scene_change last: fewest hitches');
  assert.doesNotMatch(s, THREE_JS);
});

test("a Godot level that carries the last level's orphan nodes points at queue_free()", () => {
  // The demo's planted leak: level_2's sparks are taken off screen but never freed, so level_3 carries them.
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        events: [
          { type: 'level_start', ts: T0 + 100, level: 'level_1' },
          frames('level_1', T0 + 500, smooth),
          { type: 'level_start', ts: T0 + 20_000, level: 'level_3' },
          frames('level_3', T0 + 25_000, [...Array(300).fill(16.7), ...Array(60).fill(40)], { orphans: 2500, hitches: 0 }),
        ],
      }),
    );
  }
  const perf = findings(ctxOf(evs)).find((f) => f.id === 'perf-level-level_3');
  assert.ok(perf);
  assert.equal(perf.evidence.carried_over_gauges[0].key, 'orphan_nodes');
  assert.match(perf.summary, /`orphan_nodes` sits at 2,500 for this whole level vs 0 on level_1/);
  assert.match(perf.suggestion, /`orphan_nodes` counts nodes taken out of the tree but never freed: call queue_free\(\)/);
  assert.doesNotMatch(perf.suggestion, THREE_JS);
});

test('Godot device-gap, slow-start and error findings give Godot advice', () => {
  const evs = [];
  const err = (ts) => ({ type: 'error', ts, kind: 'script', message: "Invalid call. Nonexistent function 'collect' in base 'Nil'.", fingerprint: 'gd1', fn: '_on_bonus', source: 'res://demo/demo.gd', line: 88, level: 'level_1' });
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ tier: 'low', events: [{ type: 'load', ts: T0 + 50, ttff_ms: 9000 }, { type: 'level_start', ts: T0 + 100, level: 'level_1' }, frames('level_1', T0 + 500, Array(400).fill(40)), err(T0 + 600)] }));
    evs.push(...session({ tier: 'high', events: [{ type: 'load', ts: T0 + 50, ttff_ms: 2000 }, { type: 'level_start', ts: T0 + 100, level: 'level_1' }, frames('level_1', T0 + 500, smooth)] }));
  }
  const fs = findings(ctxOf(evs));

  const gap = fs.find((f) => f.id === 'device-gap-low-tier');
  assert.ok(gap, `findings: ${fs.map((f) => f.id)}`);
  assert.match(gap.suggestion, /Viewport\.scaling_3d_scale/);
  assert.match(gap.suggestion, /WorldEnvironment/);
  assert.doesNotMatch(gap.suggestion, THREE_JS);

  const slow = fs.find((f) => f.id === 'load-ttff');
  assert.ok(slow);
  assert.doesNotMatch(slow.summary, /Web portals/);
  assert.match(slow.suggestion, /ResourceLoader\.load_threaded_request\(\)/);
  assert.match(slow.suggestion, /Shader Baker/);
  assert.doesNotMatch(slow.suggestion, THREE_JS);
  assert.doesNotMatch(slow.suggestion, /Draco|Meshopt|Basis/);

  const error = fs.find((f) => f.id === 'error-gd1');
  assert.ok(error);
  assert.match(error.suggestion, /^Start at _on_bonus \(res:\/\/demo\/demo\.gd:88\)\./);
  assert.match(error.suggestion, /is_instance_valid\(\)/);
  assert.doesNotMatch(error.suggestion, /undefined/);
});

test('browser sessions keep their three.js findings, also next to Godot sessions', () => {
  const evs = [];
  const browserFrames = (level, ts, values, geometries) => {
    const f = frames(level, ts, values);
    for (const k of ['nodes', 'orphan_nodes', 'objects', 'ctx']) delete f[k];
    return { ...f, geometries };
  };
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        sdk: BROWSER,
        tier: 'low',
        events: [
          { type: 'load', ts: T0 + 50, ttff_ms: 9000 },
          ...[0, 1, 2].flatMap((n) => [{ type: 'level_start', ts: T0 + 100 + n * 10_000, level: `level-${n + 1}` }, browserFrames(`level-${n + 1}`, T0 + 5000 + n * 10_000, Array(400).fill(40), 100 + n * 200)]),
        ],
      }),
    );
  }
  // A smooth high-tier Godot session in the same service doesn't turn the low-tier (browser) advice into Godot advice.
  evs.push(...session({ tier: 'high', events: [{ type: 'level_start', ts: T0 + 100, level: 'level-1' }, frames('level-1', T0 + 500, smooth)] }));
  const fs = findings(ctxOf(evs));
  const leak = fs.find((f) => f.id === 'leak-geometries-1.0.0');
  assert.ok(leak, `findings: ${fs.map((f) => f.id)}`);
  assert.equal(leak.suggestion, 'When unloading a level, call geometry.dispose(), material.dispose() and texture.dispose() for everything you remove (scene.remove() alone does not free GPU memory). Share one geometry/material across identical tiles instead of creating one per mesh.');
  assert.ok(!fs.some((f) => f.id.startsWith('leak-orphan-nodes')));
  assert.equal(fs.find((f) => f.id === 'device-gap-low-tier').suggestion, 'Add a quality tier: cap devicePixelRatio at 1.5, disable shadows/post-processing and halve particle counts when gpu_tier is low or p95 stays above budget for 5s.');
  const slow = fs.find((f) => f.id === 'load-ttff');
  assert.equal(slow.summary, '100% of sessions waited more than 4s for the first frame (median 9.0s). Web portals expect gameplay within ~20s and every extra second costs conversion-to-play.');
  assert.equal(slow.suggestion, 'Lazy-load non-first-level assets, compress textures (KTX2/Basis) and meshes (Draco/Meshopt), and warm shaders with renderer.compileAsync before the first frame.');
  assert.match(fs.find((f) => f.id === 'perf-level-level-2').suggestion, /^Profile level-2 with the overlay open/);
});
