// GameMaker sessions (envelope `sdk` glitchless-gamemaker/…, SPEC §5d): findings name GameMaker's functions for its
// hitch causes (texture pages, room changes, collections, instance bursts, Step and Draw time), its leaks (instances,
// surfaces, DS structures), its errors, quality tiers and slow starts; a crash is fatal and ends its session as
// crashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, errorIssues } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { reportFindings } from '../src/reports.js';

const T0 = 1_760_000_000_000;
const GAMEMAKER = 'glitchless-gamemaker/0.1.0';
let seq = 0;

function session({ id = `s_${++seq}`, version = '0.1.0', tier = 'mid', events = [], end = null }) {
  const base = { service: 'gm', env: 'dev', version, session_id: id, player_id: null, sdk: GAMEMAKER };
  const device = { browser: 'GameMaker', browser_version: '2026.0.0.23', os: 'macOS', gpu_tier: tier, renderer: 'vm', driver: 'OpenGL' };
  const all = [{ type: 'session_start', ts: T0, device, privacy: 'anonymous' }, ...events];
  if (end) all.push({ type: 'session_end', ts: end.ts, reason: end.reason || 'quit' });
  return all.map((e) => ({ level: null, ...e, ...base }));
}

// A GameMaker frame window: Step and Draw time, the runner's counts at the top level and in ctx.
function frames(level, ts, values, { instances = 40, surfaces = 2, ctx = {}, ...extra } = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return {
    type: 'frame_window', ts, level, duration_s: values.reduce((a, b) => a + b, 0) / 1000, frames: values.length, budget_ms: 16.67, hz: 60, ft: sk.toJSON(),
    hitches: values.filter((v) => v > 50).length, frozen: values.filter((v) => v > 700).length,
    process_ms: 4, render_ms: 3, gpu_ms: null, physics_ms: null, draw_calls: null, triangles: null, geometries: null, textures: null, programs: null,
    gc_collections: 0, gc_ms: 0, texture_loads: 0, heap_mb: 60, instances, surfaces, ctx: { instances, surfaces, ...ctx }, ...extra,
  };
}

function hitch(level, ts, ms, causes, extra = {}) {
  return { type: 'hitch', ts, level, duration_ms: ms, frozen: ms > 700, causes, ctx: { instances: 40 }, recent: [], loaf: [], ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'gm', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const smooth = (n = 1800) => Array(n).fill(16.7);
const withSpikes = (n, spikes, ms) => [...Array(n - spikes).fill(16.7), ...Array(spikes).fill(ms)];
// Words from the other engines' advice, which a GameMaker finding must not use.
const OTHER_ENGINES = /InstancedMesh|THREE\.|compileAsync|devicePixelRatio|KTX2|dispose\(\)|queue_free|MultiMesh|Instantiate\(\)|ShaderVariantCollection|QualitySettings|getFirstDead|UPROPERTY|SpawnActor/;

test('a GameMaker crash is fatal and crashes its session; an error the game caught is not', () => {
  const crash = { type: 'error', ts: T0 + 9000, kind: 'crash', message: 'Unable to find instance for object index 7', fn: 'bonus_pay', source: 'bonus_pay', line: 14, fingerprint: 'gm000001' };
  const caught = { type: 'error', ts: T0 + 2000, kind: 'manual', message: 'bonus table missing row N in save:/bonus.cfg', fn: 'obj_demo.Step_0', source: 'obj_demo', line: 88, fingerprint: 'gm000002' };
  const evs = [
    ...session({ id: 's_crash', events: [frames('rm_level_3', T0 + 1000, smooth(300)), crash], end: { ts: T0 + 9000, reason: 'crash' } }),
    ...session({ id: 's_caught', events: [frames('rm_level_1', T0 + 1000, smooth(300)), caught], end: { ts: T0 + 3000 } }),
  ];
  const ctx = ctxOf(evs);
  assert.equal(ctx.sessions.get('s_crash').crashed, true);
  assert.equal(ctx.sessions.get('s_caught').crashed, false, 'an error the game caught right before quitting is not a crash');
  const issues = errorIssues(ctx);
  assert.equal(issues.find((i) => i.kind === 'crash').fatal, true);
  assert.equal(issues.find((i) => i.kind === 'manual').fatal, false);
});

test('a GameMaker level over budget from an instance burst gets pooling and particle advice', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        events: [
          frames('rm_level_1', T0 + 5000, smooth(400)),
          ...[0, 1, 2].map((k) => hitch('rm_level_2', T0 + 11_000 + k * 1000, 140, ['object_spawn', 'script'], { instances_added: 2500, process_ms: 120, recent: ['powerup'], ctx: { instances: 2540 } })),
          frames('rm_level_2', T0 + 15_000, withSpikes(400, 40, 90), { instances: 2540 }),
        ],
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  const f = fs.find((x) => x.id === 'perf-level-rm_level_2');
  assert.ok(f, `findings: ${fs.map((x) => x.id)}`);
  assert.match(f.suggestion, /pool them \(deactivate and reuse instead of instance_create_layer \/ instance_destroy/);
  assert.match(f.suggestion, /particle system \(part_system_create/);
  assert.match(f.suggestion, /with\(\) loops over every instance/);
  assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('one-off hitches from texture pages and collections, without the room change, get texture group and GC advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [
          hitch('rm_cave', T0 + 1000, 400, ['texture_upload', 'scene_change', 'script']),
          hitch('rm_cave', T0 + 12_000, 120, ['texture_upload'], { texture_loads: 1 }),
          hitch('rm_cave', T0 + 22_000, 75, ['gc'], { gc_ms: 45 }),
          hitch('rm_cave', T0 + 42_000, 75, ['gc'], { gc_ms: 45 }),
          frames('rm_cave', T0 + 1000, [400, ...smooth(3600), 120, 75, 75]),
          frames('rm_cave', T0 + 62_000, smooth(300)),
        ],
        end: { ts: T0 + 67_000 },
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  const f = fs.find((x) => x.id === 'hitches-level-rm_cave');
  assert.ok(f, `findings: ${fs.map((x) => x.id)}`);
  assert.equal(f.evidence.load_hitches, 3, 'the room change is the load');
  // Each load hitch comes off every cause's count (findings.js 1b), so the collections count 6 - 3.
  assert.deepEqual(f.evidence.hitch_causes, { gc: 3, texture_upload: 3 });
  assert.match(f.suggestion, /texturegroup_load or texture_prefetch/);
  assert.match(f.suggestion, /gc_enable\(false\).*gc_collect\(\)/);
  assert.doesNotMatch(f.suggestion, /room_goto builds the whole room/, 'the room change is not one of its causes');
  assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('instances and surfaces that keep climbing get GameMaker advice, not three.js disposal', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [0, 1, 2, 3].map((k) => frames('rm_level_3', T0 + 5000 * (k + 1), smooth(300), { instances: 40 + k * 900, surfaces: 2 + k * 60 })),
        end: { ts: T0 + 21_000 },
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  const instances = fs.find((f) => f.id === 'leak-gauge-instances');
  const surfaces = fs.find((f) => f.id === 'leak-gauge-surfaces');
  assert.ok(instances && surfaces, `findings: ${fs.map((f) => f.id)}`);
  assert.match(instances.suggestion, /instance_destroy\(\).*persistent/);
  assert.match(surfaces.suggestion, /surface_create\(\) and never surface_free\(\).*surface_exists\(\)/);
  for (const f of [instances, surfaces]) assert.doesNotMatch(f.suggestion, /dispose|geometry, materials and textures/);
});

test('GameMaker error findings say how to guard instance and variable reads', () => {
  const err = (message, fn, fingerprint) => ({ type: 'error', ts: T0 + 1000, kind: 'crash', message, fn, source: fn, line: 12, fingerprint });
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [{ type: 'custom', ts: T0 + 500, name: 'bonus' }, err('Unable to find instance for object index 7', 'bonus_pay', 'gm00000a'), err('Variable <unknown_object>.hp(N, -N) not set before reading it.', 'obj_enemy.Step_0', 'gm00000b')],
        end: { ts: T0 + 2000, reason: 'crash' },
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  const missing = fs.find((f) => f.id === 'error-gm00000a');
  const unset = fs.find((f) => f.id === 'error-gm00000b');
  assert.match(missing.suggestion, /instance_exists\(\)/);
  assert.match(missing.suggestion, /An unhandled exception stops a GameMaker game/);
  assert.match(unset.suggestion, /variable_instance_exists\(\).*struct\[\$ "name"\]/);
  assert.match(missing.summary, /The game crashed — written down as it died and sent on the next launch/);
  for (const f of [missing, unset]) assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('low-tier GPUs and a slow start get GameMaker advice, and bug reports say how to get back to the room', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ tier: 'low', events: [{ type: 'load', ts: T0 + 100, ttff_ms: 9000 }, frames('rm_level_1', T0 + 5000, withSpikes(400, 60, 45))] }));
    evs.push(...session({ tier: 'high', events: [{ type: 'load', ts: T0 + 100, ttff_ms: 9000 }, frames('rm_level_1', T0 + 5000, smooth(400))] }));
  }
  const ctx = ctxOf(evs);
  const fs = findings(ctx);
  assert.match(fs.find((f) => f.id === 'device-gap-low-tier').suggestion, /application surface \(surface_resize\(application_surface/);
  const start = fs.find((f) => f.id === 'load-ttff');
  assert.match(start.summary, /Players expect to be playing within seconds/);
  assert.match(start.suggestion, /first room light.*texturegroup_load.*Dynamic Texture Groups/);
  const reports = [0, 1, 2].map((k) => ({ id: `r_${k}`, ts: T0 + 1000 + k, session_id: [...ctx.sessions.keys()][k], level: 'rm_level_1', note: `stuck ${k}`, has_screenshot: true }));
  const [f] = reportFindings({ ...ctx, reports }, ctx.sessions.size, 'gamemaker');
  assert.match(f.suggestion, /run the game from GameMaker/);
});
