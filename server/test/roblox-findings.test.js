// Roblox sessions (envelope `sdk` glitchless-roblox/…, SPEC §5e): findings name Roblox's own fixes for its hitch causes
// (assets still downloading, instance bursts, physics, rendering, Luau), its leaks (instances), its errors and slow
// loading screens; a script error the player left right after counts as a crash, as Godot's does; the device kind is
// the platform and the browser is "Roblox app".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, errorIssues, platformOf, browserOf } from '../src/analytics.js';
import { findings, gameEngine } from '../src/findings.js';
import { reportFindings } from '../src/reports.js';

const T0 = 1_760_000_000_000;
const ROBLOX = 'glitchless-roblox/0.1.0';
let seq = 0;

function session({ id = `s_${++seq}`, version = '42', os = 'Computer', events = [], end = null }) {
  const base = { service: 'nardo', env: 'prod', version, session_id: id, player_id: id, sdk: ROBLOX };
  const device = { browser: 'Roblox', browser_version: '0.746.0.7461269', os, mobile: os === 'Phone', screen: [1920, 1080], quality: 'auto' };
  const all = [{ type: 'session_start', ts: T0, device, privacy: 'anonymous', session_type: 'user' }, ...events];
  if (end) all.push({ type: 'session_end', ts: end.ts, reason: end.reason || 'quit' });
  return all.map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values, { instances = 25_000, ctx = {}, ...extra } = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return {
    type: 'frame_window', ts, level, duration_s: values.reduce((a, b) => a + b, 0) / 1000, frames: values.length, budget_ms: 16.67, hz: 60, ft: sk.toJSON(),
    hitches: values.filter((v) => v > 50).length, frozen: values.filter((v) => v > 700).length,
    render_ms: 4, gpu_ms: 6, physics_ms: 1, draw_calls: 500, triangles: 180_000, heap_mb: 96, memory_mb: 1400, instances, ctx: { instances, ...ctx }, ...extra,
  };
}

function hitch(level, ts, ms, causes, extra = {}) {
  return { type: 'hitch', ts, level, duration_ms: ms, frozen: ms > 700, causes, ctx: { instances: 25_000 }, recent: [], loaf: [], ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'nardo', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const smooth = (n = 1800) => Array(n).fill(16.7);
const withSpikes = (n, spikes, ms) => [...Array(n - spikes).fill(16.7), ...Array(spikes).fill(ms)];
// Words from the other engines' advice, which a Roblox finding must not use.
const OTHER_ENGINES = /InstancedMesh|THREE\.|compileAsync|devicePixelRatio|KTX2|queue_free|MultiMesh|Instantiate\(\)|ShaderVariantCollection|QualitySettings|getFirstDead|UPROPERTY|SpawnActor|instance_create_layer|texturegroup_load/;

test('Roblox sessions are a Roblox game: the device kind is its platform, the browser "Roblox app"', () => {
  const ctx = ctxOf([...session({ os: 'Phone' }), ...session({ os: 'Computer' })]);
  assert.equal(gameEngine(ctx), 'roblox');
  assert.equal(platformOf({ os: 'Phone' }), 'Phone');
  assert.equal(platformOf({ os: 'Console' }), 'Console', "a console that didn't say which one");
  assert.equal(platformOf({ os: 'Console', console: 'Xbox' }), 'Xbox', 'which console, from its controller');
  assert.equal(platformOf({ os: 'Console', console: 'PlayStation' }), 'PlayStation');
  assert.equal(platformOf({ os: 'Computer', console: 'PlayStation' }), 'Computer', 'only a console is a console');
  assert.equal(platformOf({ os: 'Console', console: 'Switch' }), 'Console', 'only the two Roblox runs on');
  assert.equal(browserOf({ browser: 'Roblox', os: 'Phone' }), 'Roblox app');
});

test('a script error the player left right after is a crash; one they played through is an error', () => {
  const err = { type: 'error', ts: T0 + 9000, kind: 'script', message: "attempt to index nil with 'Humanoid'", fn: 'Race.onTouched', source: 'ServerScriptService.Race', line: 42, fingerprint: 'rb000001' };
  const caught = { type: 'error', ts: T0 + 2000, kind: 'manual', message: 'DataStore request dropped', fn: 'Saves.load', fingerprint: 'rb000002' };
  const evs = [
    ...session({ id: 's_left', events: [frames('desert_loop', T0 + 1000, smooth(300)), err], end: { ts: T0 + 12_000 } }),
    ...session({ id: 's_played', events: [frames('desert_loop', T0 + 1000, smooth(300)), { ...err, ts: T0 + 2000 }, { type: 'custom', ts: T0 + 3000, name: 'lap_done' }, caught], end: { ts: T0 + 60_000 } }),
  ];
  const ctx = ctxOf(evs);
  assert.equal(ctx.sessions.get('s_left').crashed, true);
  assert.equal(ctx.sessions.get('s_played').crashed, false);
  const issues = errorIssues(ctx);
  assert.equal(issues.find((i) => i.kind === 'script').fatal, true, 'a script error stops its thread');
  assert.equal(issues.find((i) => i.kind === 'manual').fatal, false);
});

test("a server Script's error right before the server closes is not a server crash", () => {
  const err = { type: 'error', ts: T0 + 9000, kind: 'server_script', message: 'DataStore request was dropped', fn: 'Saves.flush', source: 'ServerScriptService.Saves', line: 12, fingerprint: 'rb0000s1' };
  const server = session({ id: 's_server', os: 'Roblox', events: [{ type: 'server_window', ts: T0 + 5000, duration_s: 5, ticks: 300, tick_hz: 60 }, err], end: { ts: T0 + 11_000, reason: 'close' } });
  const ctx = ctxOf(server);
  assert.equal(ctx.sessions.get('s_server').crashed, false);
  assert.equal(errorIssues(ctx).find((i) => i.kind === 'server_script').fatal, false);
});

test('a level that stutters from instance bursts and streaming assets gets Roblox advice', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        events: [
          frames('lobby', T0 + 5000, smooth(400)),
          ...[0, 1, 2].map((k) => hitch('desert_loop', T0 + 11_000 + k * 1000, 140, ['object_spawn', 'asset_load', 'script'], { instances_added: 3000, recent: ['lap_done'] })),
          frames('desert_loop', T0 + 15_000, withSpikes(400, 40, 90)),
        ],
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  const f = fs.find((x) => x.id === 'perf-level-desert_loop');
  assert.ok(f, `findings: ${fs.map((x) => x.id)}`);
  assert.match(f.suggestion, /Clone\(\) and Destroy\(\)/);
  assert.match(f.suggestion, /ContentProvider:PreloadAsync/);
  assert.match(f.suggestion, /StreamingEnabled/);
  assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('instances that keep climbing on players\' devices get Destroy() and Debris advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ events: [0, 1, 2, 3].map((k) => frames('desert_loop', T0 + 5000 * (k + 1), smooth(300), { instances: 20_000 + k * 40_000 })), end: { ts: T0 + 21_000 } }));
  }
  const fs = findings(ctxOf(evs));
  const f = fs.find((x) => x.id === 'leak-gauge-instances');
  assert.ok(f, `findings: ${fs.map((x) => x.id)}`);
  assert.match(f.suggestion, /Destroy\(\).*Debris:AddItem/);
  assert.doesNotMatch(f.suggestion, /dispose|geometry, materials and textures/);
});

test('error findings say what a nil index usually is on Roblox', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [{ type: 'custom', ts: T0 + 500, name: 'respawn' }, { type: 'error', ts: T0 + 1000, kind: 'script', message: "attempt to index nil with 'Humanoid'", fn: 'Race.onTouched', source: 'ServerScriptService.Race', line: 42, fingerprint: 'rb00000a' }],
        end: { ts: T0 + 60_000 },
      }),
    );
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'error-rb00000a');
  assert.ok(f);
  assert.match(f.suggestion, /player\.Character before it loads.*WaitForChild/);
  assert.match(f.suggestion, /Roblox stops the thread at an error/);
  assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('a slow loading screen gets StreamingEnabled advice, and bug reports say how to get back in Studio', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) evs.push(...session({ events: [{ type: 'load', ts: T0 + 100, ttff_ms: 14_000 }, frames('desert_loop', T0 + 5000, smooth(400))] }));
  const ctx = ctxOf(evs);
  const start = findings(ctx).find((f) => f.id === 'load-ttff');
  assert.ok(start);
  assert.match(start.summary, /On Roblox this is the loading screen/);
  assert.match(start.suggestion, /StreamingEnabled.*ReplicatedFirst/);
  const reports = [0, 1, 2].map((k) => ({ id: `r_${k}`, ts: T0 + 1000 + k, session_id: [...ctx.sessions.keys()][k], level: 'desert_loop', note: `stuck ${k}`, has_screenshot: false }));
  const [f] = reportFindings({ ...ctx, reports }, ctx.sessions.size, 'roblox');
  assert.match(f.suggestion, /play test in Roblox Studio/);
});
