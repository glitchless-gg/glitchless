// Unreal sessions (envelope `sdk` glitchless-unreal/…, SPEC §5c): findings name Unreal's tools and settings
// for its hitch causes (pso_compile, gc, map_load…), error kinds (ensure, script, crash, log_error), quality
// tiers and slow starts; a crash is fatal and ends its session as crashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, errorIssues } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const T0 = 1_760_000_000_000;
const UNREAL = 'glitchless-unreal/0.1.0';
const BROWSER = 'glitchless-browser/0.1.0';
let seq = 0;

function session({ id = `s_${++seq}`, version = '0.1.0', sdk = UNREAL, tier = 'high', events = [], end = null, start = true }) {
  const base = { service: 'ue', env: 'dev', version, session_id: id, player_id: null, sdk };
  const device = sdk === UNREAL ? { browser: 'Unreal', browser_version: '5.8.4', os: 'macOS', gpu_tier: tier, renderer: 'deferred', driver: 'Metal', steam_deck: false } : { browser: 'Chrome', gpu_tier: tier };
  const all = [...(start ? [{ type: 'session_start', ts: T0, device, privacy: 'anonymous' }] : []), ...events];
  if (end) all.push({ type: 'session_end', ts: end.ts, reason: end.reason || 'quit' });
  return all.map((e) => ({ level: null, ...e, ...base }));
}

// An Unreal frame window: thread times, engine counts at the top level and in ctx, no three.js counts.
function frames(level, ts, values, { objects = 40_000, actors = 300, ctx = {}, ...extra } = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return {
    type: 'frame_window', ts, level, duration_s: values.reduce((a, b) => a + b, 0) / 1000, frames: values.length, budget_ms: 16.67, ft: sk.toJSON(),
    hitches: values.filter((v) => v > 50).length, frozen: values.filter((v) => v > 700).length,
    game_ms: 6, process_ms: 6, render_ms: 5, rhi_ms: 3, gpu_ms: 8, draw_calls: null, triangles: null, geometries: null, textures: null, programs: null,
    objects, actors, gc_collections: 0, pso_compiles: 0, ctx: { objects, actors, ...ctx }, ...extra,
  };
}

function hitch(level, ts, ms, causes, extra = {}) {
  return { type: 'hitch', ts, level, duration_ms: ms, frozen: ms > 700, causes, bound: 'game', ctx: { objects: 40_000, actors: 300 }, recent: [], loaf: [], ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'ue', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const smooth = (n = 1800) => Array(n).fill(16.7);
const withSpikes = (n, spikes, ms) => [...Array(n - spikes).fill(16.7), ...Array(spikes).fill(ms)];
// Words from the other engines' advice, which an Unreal finding must not use.
const OTHER_ENGINES = /InstancedMesh|THREE\.|compileAsync|devicePixelRatio|KTX2|dispose\(\)|queue_free|MultiMesh|Instantiate\(\)|ShaderVariantCollection|QualitySettings|getFirstDead/;

test('an Unreal crash is fatal and crashes its session, also when it arrives under a fresh session ID', () => {
  const crash = { type: 'error', ts: T0 + 9000, kind: 'crash', message: 'Caught signal 11 (SIGSEGV) at 0x0', fn: 'AArena::Explode', source: 'Arena.cpp', line: 88, fingerprint: 'ue000001' };
  const ensure = { type: 'error', ts: T0 + 2000, kind: 'ensure', message: 'Ensure condition failed: Gate != nullptr', fn: 'AGallery::OpenGate', source: 'Gallery.cpp', line: 41, fingerprint: 'ue000002' };
  const evs = [
    // Install mode: the crash joins its session, sent on the next launch with the session's end.
    ...session({ id: 's_install', events: [frames('arena', T0 + 1000, smooth(300)), crash], end: { ts: T0 + 9000, reason: 'crash' } }),
    // Anonymous mode: nothing on disk ties the crash to its session, so it comes alone.
    ...session({ id: 's_orphan', start: false, events: [crash], end: { ts: T0 + 9000, reason: 'crash' } }),
    ...session({ id: 's_ensure', events: [frames('gallery', T0 + 1000, smooth(300)), ensure], end: { ts: T0 + 3000 } }),
  ];
  const ctx = ctxOf(evs);
  assert.equal(ctx.sessions.get('s_install').crashed, true);
  assert.equal(ctx.sessions.get('s_orphan').crashed, true);
  assert.equal(ctx.sessions.get('s_ensure').crashed, false, 'an ensure right before quitting is not a crash: the game carried on');
  const issues = errorIssues(ctx);
  assert.equal(issues.find((i) => i.kind === 'crash').fatal, true);
  assert.equal(issues.find((i) => i.kind === 'ensure').fatal, false);
});

test('an Unreal level over budget gets PSO and GC advice in Unreal terms', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    evs.push(
      ...session({
        events: [
          frames('gallery', T0 + 5000, smooth(400)),
          ...[0, 1, 2].map((k) => hitch('arena', T0 + 11_000 + k * 1000, 140, ['pso_compile', 'render'], { bound: 'rhi', pso_compiles: 3, recent: ['fireworks'] })),
          hitch('arena', T0 + 14_500, 90, ['gc', 'script'], { gc_collections: 1, gc_ms: 70 }),
          frames('arena', T0 + 15_000, withSpikes(400, 40, 90), { gc_collections: 1, pso_compiles: 9 }),
        ],
      }),
    );
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'perf-level-arena');
  assert.ok(f, 'a frame-time finding for arena');
  assert.deepEqual(f.evidence.hitch_causes, { pso_compile: 12, render: 12, gc: 4, script: 4 });
  assert.match(f.suggestion, /PSO precaching on \(r\.PSOPrecaching 1/);
  assert.match(f.suggestion, /bundled PSO cache.*-logPSO.*ShaderPipelineCacheTools/);
  assert.match(f.suggestion, /LogPSOHitching Verbose/);
  assert.match(f.suggestion, /garbage collections.*SpawnActor or NewObject.*gc\.CreateGCClusters/);
  // Causes that name the stall come before where its time went: the render tip doesn't push out the GC one.
  assert.ok(f.suggestion.indexOf('garbage collections') < f.suggestion.indexOf('render-thread'));
  assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('one-off hitches on a level within budget are a finding of their own, without the level\'s map load', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [
          hitch('gallery', T0 + 1000, 900, ['map_load', 'asset_load', 'gc', 'pso_compile', 'script', 'frozen']),
          hitch('gallery', T0 + 12_000, 180, ['pso_compile', 'render'], { recent: ['fireworks'], pso_compiles: 4 }),
          hitch('gallery', T0 + 22_000, 95, ['gc', 'script'], { gc_ms: 80 }),
          hitch('gallery', T0 + 42_000, 95, ['gc', 'script'], { gc_ms: 80 }),
          // 60 s of play: the load, a first-use PSO hitch and two collections; p95 stays at 16.7 ms.
          frames('gallery', T0 + 1000, [900, ...smooth(3600), 180, 95, 95]),
          frames('gallery', T0 + 62_000, smooth(300)),
        ],
        end: { ts: T0 + 67_000 },
      }),
    );
  }
  const ctx = ctxOf(evs);
  const fs = findings(ctx);
  assert.ok(!fs.some((f) => f.id === 'perf-level-gallery'), 'p95 is within budget');
  assert.ok(!fs.some((f) => f.category === 'stability'), `no errors: ${fs.map((f) => f.id)}`);
  // A map load's frozen frame mid-session is a hitch, not a crash (§4: only a session that ends inside one).
  assert.ok([...ctx.sessions.values()].every((s) => !s.crashed));
  const f = fs.find((x) => x.id === 'hitches-level-gallery');
  assert.ok(f, `findings: ${fs.map((x) => x.id)}`);
  assert.equal(f.severity, 'medium');
  assert.equal(f.evidence.hitches, 9, 'three per session, the map load left out');
  assert.equal(f.evidence.load_hitches, 3);
  // The render time came with the PSO hitches only, so the load's count takes it out.
  assert.deepEqual(f.evidence.hitch_causes, { gc: 6, pso_compile: 3, script: 6 });
  assert.equal(f.title, 'Hitches on gallery: 2.71 a minute, from garbage collection and pipeline states created on first use');
  assert.match(f.summary, /keeps its p95 at 16\.\d+ms, but 9 frames stalled during play \(2\.71 per minute\) in 3 sessions/);
  assert.match(f.summary, /Causes: gc 6, pso_compile 3, script 6\./);
  // No gauge rises with these hitches (the UObject count is the same in calm windows), so it starts with the causes.
  assert.match(f.suggestion, /^Some hitches are garbage collections/);
  assert.match(f.suggestion, /PSO precaching/);
  assert.match(f.suggestion, /gc\.TimeBetweenPurgingPendingKillObjects/);
  assert.doesNotMatch(f.suggestion, /loading screen \(the MoviePlayer\)|OpenLevel/, 'the map load is not one of its causes');
  assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('a level whose only hitches are its loads, or with rare hitches, has no hitch finding', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [
          hitch('quiet', T0 + 1000, 900, ['map_load', 'asset_load', 'frozen']),
          frames('quiet', T0 + 1000, [900, ...smooth(3600)]),
          hitch('rare', T0 + 70_000, 900, ['map_load', 'frozen']),
          hitch('rare', T0 + 90_000, 120, ['gc', 'script']),
          // Ten minutes on rare: one GC hitch each, 0.1 a minute.
          frames('rare', T0 + 70_000, [900, 120, ...smooth(36_000)]),
        ],
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  assert.deepEqual(fs.filter((f) => f.id.startsWith('hitches-level')).map((f) => f.id), []);
});

test('under two hitches a minute, only first-use compiles make a hitch finding', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [
          // Three minutes on each level, one hitch a minute: garbage collection on one, a pipeline built on first use on the other.
          ...[30_000, 90_000, 150_000].map((ts) => hitch('collects', T0 + ts, 95, ['gc', 'script'])),
          frames('collects', T0 + 1000, [...smooth(10_800), 95, 95, 95]),
          ...[200_000, 260_000, 320_000].map((ts) => hitch('compiles', T0 + ts, 180, ['pso_compile', 'render'])),
          frames('compiles', T0 + 190_000, [...smooth(10_800), 180, 180, 180]),
        ],
      }),
    );
  }
  const ids = findings(ctxOf(evs)).filter((f) => f.id.startsWith('hitches-level')).map((f) => [f.id, f.severity]);
  assert.deepEqual(ids, [['hitches-level-compiles', 'low']]);
});

test('a hitch finding whose stalls mostly have no cause does not name one', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        sdk: BROWSER,
        events: [
          // Ten stalls in three minutes; only three were caught with a cause, one each.
          hitch('round-1', T0 + 20_000, 80, ['gc']),
          hitch('round-1', T0 + 60_000, 80, ['render']),
          hitch('round-1', T0 + 100_000, 80, ['script']),
          frames('round-1', T0 + 1000, [...smooth(10_800), ...Array(10).fill(80)]),
        ],
      }),
    );
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'hitches-level-round-1');
  assert.ok(f);
  assert.match(f.title, /^Hitches on round-1: [\d.]+ a minute, most with no recorded cause$/);
  assert.match(f.summary, /Causes: gc 3, render 3, script 3\./);
});

test('the hitch finding gives a browser game the browser\'s advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        sdk: BROWSER,
        events: [
          ...[10_000, 25_000, 40_000].map((ts) => hitch('level-1', T0 + ts, 120, ['shader_compile'])),
          frames('level-1', T0 + 1000, [...smooth(3600), 120, 120, 120]),
        ],
      }),
    );
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'hitches-level-level-1');
  assert.ok(f);
  assert.equal(f.title, 'Hitches on level-1: 2.98 a minute, from shader compiles');
  assert.match(f.suggestion, /compileAsync/);
  assert.doesNotMatch(f.suggestion, /PSO|Unreal/);
});

test('Unreal error findings talk about IsValid, Blueprints and UPROPERTY, by kind', () => {
  const evs = [];
  const err = (kind, message, fn, source, line, fingerprint) => ({ type: 'error', ts: T0 + 3000, kind, message, fn, source, line, fingerprint, level: 'gallery' });
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [
          { type: 'custom', ts: T0 + 2500, name: 'gate_opened', level: 'gallery' },
          err('ensure', 'Ensure condition failed: Gate != nullptr', 'ADemoGallery::OpenGate', 'Source/GlitchlessDemo/DemoGallery.cpp', 64, 'ee000001'),
          err('script', 'Accessed None trying to read property Target', 'BP_Turret_C::ExecuteUbergraph_BP_Turret', null, null, 'ee000002'),
          err('log_error', 'Failed to load /Game/FX/NS_Sparks.NS_Sparks', 'LogStreaming', null, null, 'ee000003'),
        ],
        end: { ts: T0 + 60_000 },
      }),
    );
  }
  evs.push(...session({ id: 's_c1', events: [err('crash', 'Caught signal 11 (SIGSEGV)', 'ADemoArena::Tick', 'Source/GlitchlessDemo/DemoArena.cpp', 120, 'ee000004')], end: { ts: T0 + 3000, reason: 'crash' } }));
  evs.push(...session({ id: 's_c2', events: [err('crash', 'Caught signal 11 (SIGSEGV)', 'ADemoArena::Tick', 'Source/GlitchlessDemo/DemoArena.cpp', 120, 'ee000004')], end: { ts: T0 + 3000, reason: 'crash' } }));
  const fs = findings(ctxOf(evs));
  const by = (fp) => fs.find((f) => f.id === `error-${fp}`);
  const ensure = by('ee000001');
  assert.match(ensure.suggestion, /^Start at ADemoGallery::OpenGate \(Source\/GlitchlessDemo\/DemoGallery\.cpp:64\)/);
  assert.match(ensure.suggestion, /null or pending kill.*IsValid\(\), which checks for both/);
  assert.match(ensure.suggestion, /if \(!ensure\(IsValid\(Target\)\)\) return;/);
  assert.match(ensure.suggestion, /triggered by gate_opened/);
  assert.doesNotMatch(ensure.summary, /Unhandled/);
  const script = by('ee000002');
  assert.match(script.summary, /Unhandled script error/);
  assert.match(script.suggestion, /Is Valid node.*Unreal stops the Blueprint function at the error/);
  assert.match(by('ee000003').suggestion, /fn is its log category.*never cooked/);
  const crash = by('ee000004');
  assert.equal(crash.severity, 'high');
  assert.match(crash.summary, /The game crashed — written down as it died and sent on the next launch\./);
  assert.match(crash.suggestion, /UPROPERTY\(\).*TWeakObjectPtr.*\.dSYM on a Mac, the \.pdb on Windows/);
  for (const f of [ensure, script, crash]) assert.doesNotMatch(f.suggestion, OTHER_ENGINES);
});

test('low-tier Unreal machines get scalability advice, and a slow start gets Unreal loading advice', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ tier: 'low', events: [{ type: 'load', ts: T0 + 100, ttff_ms: 9000 }, frames('arena', T0 + 5000, withSpikes(400, 60, 45))] }));
    evs.push(...session({ tier: 'high', events: [{ type: 'load', ts: T0 + 100, ttff_ms: 9000 }, frames('arena', T0 + 5000, smooth(400))] }));
  }
  const fs = findings(ctxOf(evs));
  const gap = fs.find((f) => f.id === 'device-gap-low-tier');
  assert.match(gap.suggestion, /sg\.ShadowQuality/);
  assert.match(gap.suggestion, /r\.ScreenPercentage.*TSR/);
  assert.match(gap.suggestion, /Lumen/);
  assert.match(gap.suggestion, /Steam Deck/);
  const start = fs.find((f) => f.id === 'load-ttff');
  assert.match(start.summary, /Players expect to be playing within seconds/);
  assert.match(start.suggestion, /startup map tiny.*MoviePlayer.*Asset Manager.*PSO cache/);
});

test('UObjects or actors that keep climbing get Unreal advice, not three.js disposal', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        events: [0, 1, 2, 3].map((k) => frames('forge', T0 + 5000 * (k + 1), smooth(300), { objects: 35_000 + k * 200_000, actors: 40 + k * 60 })),
        end: { ts: T0 + 21_000 },
      }),
    );
  }
  const fs = findings(ctxOf(evs));
  const objects = fs.find((f) => f.id === 'leak-gauge-objects');
  const actors = fs.find((f) => f.id === 'leak-gauge-actors');
  assert.ok(objects && actors, `findings: ${fs.map((f) => f.id)}`);
  assert.match(objects.suggestion, /NewObject.*USTRUCTs.*UPROPERTY.*obj list/);
  assert.match(actors.suggestion, /Destroy\(\).*SetLifeSpan/);
  for (const f of [objects, actors]) assert.doesNotMatch(f.suggestion, /dispose|geometry, materials and textures/);
});
