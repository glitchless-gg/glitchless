// Rules that held for the platformer the server was built around and broke on other genres: a frozen
// frame or a played-through error counted as a crash, endless games full of "rage quits", walls without
// deaths, texture leaks, top-down hotspots read as side views, rage quits matched to the wrong event, and
// gauges that only ever climb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, overview, funnel, deathHotspots, performance, gaugeClimbs, heatmap } from '../src/analytics.js';
import { findings } from '../src/findings.js';

const T0 = 1_760_000_000_000;
let seq = 0;

function session({ id = `g_${++seq}`, version = '1.0.0', events = [] }) {
  const base = { service: 'test', env: 'prod', version, session_id: id, player_id: `p_${id}`, sdk: 'glitchless-browser/0.2.2' };
  return [{ type: 'session_start', ts: T0, device: { gpu_tier: 'mid', browser: 'Chrome' } }, ...events].map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, extra = {}) {
  const sk = new Sketch();
  for (let i = 0; i < 300; i++) sk.add(16.6);
  return { type: 'frame_window', ts, level, duration_s: 5, frames: 300, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'test', from: T0 - 1000, to: T0 + 3600e3, type: 'all' });
const end = (ts) => ({ type: 'session_end', ts, reason: 'pagehide' });
const err = (ts) => ({ type: 'error', ts, kind: 'js', message: 'TypeError: boom', fingerprint: 'f1', fn: 'spawn' });

test('a frozen frame the game recovers from is not a crash; one the session ends inside is', () => {
  const recovered = session({ events: [{ type: 'level_start', ts: T0 + 1000, level: 'l1' }, frames('l1', T0 + 6000, { frozen: 1 }), frames('l1', T0 + 11_000), end(T0 + 60_000)] });
  const froze = session({ events: [{ type: 'level_start', ts: T0 + 1000, level: 'l1' }, frames('l1', T0 + 6000), frames('l1', T0 + 11_000, { frozen: 1 }), end(T0 + 12_000)] });
  assert.equal(overview(ctxOf(recovered)).kpis.crash_free_pct, 100);
  assert.equal(overview(ctxOf(froze)).kpis.crash_free_pct, 0);
});

test('an unhandled error the player plays through is not a crash, even if they leave soon after', () => {
  const playedOn = session({ events: [{ type: 'level_start', ts: T0 + 500, level: 'l1' }, err(T0 + 1000), { type: 'death', ts: T0 + 3000, level: 'l1', x: 4, y: 0, z: 0, cause: 'fell' }, { type: 'custom', ts: T0 + 3500, name: 'retry' }, end(T0 + 6000)] });
  // The SDK's own events after the error (a rage-input detector, a screen change) are not the game playing.
  const broke = session({ events: [{ type: 'level_start', ts: T0 + 500, level: 'l1' }, err(T0 + 1000), { type: 'custom', ts: T0 + 2000, name: 'rage_input' }, end(T0 + 6000)] });
  assert.equal(overview(ctxOf(playedOn)).kpis.crash_free_pct, 100);
  assert.equal(overview(ctxOf(broke)).kpis.crash_free_pct, 0);
});

// Runs of a flappy game: one level, never completed, every run ends in a death and the session soon after.
function runs(n, { completeOne = false } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const done = completeOne && i === 0;
    const events = [{ type: 'level_start', ts: T0 + 1000, level: 'endless' }];
    if (done) events.push({ type: 'level_complete', ts: T0 + 4000, level: 'endless' });
    else events.push({ type: 'death', ts: T0 + 4000, level: 'endless', x: 30 + (i % 3) * 0.4, y: 2, z: 0, cause: 'pipe' }, { type: 'death', ts: T0 + 5000, level: 'endless', x: 30.5, y: 2, z: 0, cause: 'pipe' }, { type: 'level_fail', ts: T0 + 5200, level: 'endless', cause: 'pipe' });
    events.push(end(T0 + 9000));
    out.push(...session({ events }));
  }
  return out;
}

test('a game nobody wins has no rage quits, and its hotspot reads by where runs end', () => {
  const ctx = ctxOf(runs(8));
  assert.equal(overview(ctx).kpis.rage_quits, 0);
  assert.equal(funnel(ctx)[0].rage_quits, 0);
  const spot = findings(ctx, []).find((f) => f.id.startsWith('design-hotspot-'));
  assert.ok(spot, 'a hotspot finding');
  assert.equal(spot.evidence.no_win, true);
  assert.doesNotMatch(spot.summary, /Completion rate|rage-quit/);
  assert.doesNotMatch(spot.suggestion, /rage-quit/);
  // The heatmap page shows its runs, not a completion rate of 0%.
  assert.equal(heatmap(ctx, 'endless', []).stats.no_win, true);
  assert.equal(heatmap(ctxOf(runs(8, { completeOne: true })), 'endless', []).stats.no_win, false);
  // One completed run makes it a game with a win: leaving right after a death is a rage quit again.
  assert.equal(overview(ctxOf(runs(8, { completeOne: true }))).kpis.rage_quits, 7);
});

// Sessions through three waves: everyone gets through waves 1 and 2, few through wave 3, and nobody dies.
function waves(n, through3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const events = [];
    let ts = T0;
    for (const level of ['wave-1', 'wave-2', 'wave-3']) {
      events.push({ type: 'level_start', ts: (ts += 1000), level });
      events.push({ type: level === 'wave-3' && i >= through3 ? 'level_fail' : 'level_complete', ts: (ts += 20_000), level, cause: 'leaked' });
    }
    events.push(end((ts += 60_000)));
    out.push(...session({ events }));
  }
  return out;
}

test('a level far fewer sessions get through is a wall, deaths or not', () => {
  const [wall] = findings(ctxOf(waves(8, 2)), []).filter((f) => f.id.startsWith('design-wall-'));
  assert.equal(wall?.id, 'design-wall-wave-3');
  // 8 sessions: under 10, a wall is never high, and says why.
  assert.equal(wall.severity, 'medium');
  assert.match(wall.summary, /Only 8 sessions reached it, so this could be chance\.$/);
  assert.equal(wall.evidence.completion_pct, 25);
  assert.equal(wall.evidence.other_levels_median_pct, 100);
  assert.match(wall.title, /wave-3 is a wall: 25% of the sessions that reach it get through/);
  assert.match(wall.summary, /Nobody dies on it/);
  assert.deepEqual(wall.link, { page: 'players', level: 'wave-3' });
  // A small step down is not a wall.
  assert.equal(findings(ctxOf(waves(8, 7)), []).filter((f) => f.id.startsWith('design-wall-')).length, 0);
});

test('textures that pile up with every level load are a leak, like geometries', () => {
  const evs = [];
  for (let i = 0; i < 4; i++) {
    const events = [];
    for (let l = 0; l < 3; l++) {
      const ts = T0 + l * 30_000;
      events.push({ type: 'level_start', ts: ts + 100, level: `l${l + 1}` }, frames(`l${l + 1}`, ts + 5000, { geometries: 50, textures: 20 + l * 25 }));
    }
    evs.push(...session({ events: [...events, end(T0 + 120_000)] }));
  }
  const ctx = ctxOf(evs);
  assert.deepEqual(performance(ctx).texture_growth['1.0.0'], { sessions: 4, textures_growth_per_level_load: 25, median_first: 20, median_last: 70 });
  const leak = findings(ctx, []).find((f) => f.id === 'leak-textures-1.0.0');
  assert.ok(leak, 'a texture leak finding');
  assert.equal(leak.title, 'Texture leak in 1.0.0: +25 textures per level load');
  assert.match(leak.suggestion, /texture\.dispose\(\)/);
  assert.ok(!findings(ctx, []).some((f) => f.id.startsWith('leak-geometries-')), 'geometries stay flat');
});

test('a top-down map bins deaths square and names both axes', () => {
  // Two clusters 5 units apart in z: separate places on a top-down map.
  const deaths = [...Array(10)].map(() => ({ x: 10, y: 0, z: 0.5, cause: 'goblin' })).concat([...Array(8)].map(() => ({ x: 10, y: 0, z: 5.5, cause: 'trap' })));
  const spots = deathHotspots(deaths, 'xz');
  assert.deepEqual(
    spots.map((s) => [s.deaths, s.z, s.z_range]),
    [
      [10, 0.5, [0.5, 0.5]],
      [8, 5.5, [5.5, 5.5]],
    ],
  );
  // Without a captured map, deaths with depth make the level top-down.
  const evs = [];
  for (let i = 0; i < 6; i++) {
    const events = [{ type: 'level_start', ts: T0 + 1000, level: 'crypt' }];
    for (let d = 0; d < 2; d++) events.push({ type: 'death', ts: T0 + 2000 + d * 30_000, level: 'crypt', x: 12 + d * 0.3, y: 1, z: -8 - (i % 2) * 0.5, cause: 'goblin' });
    events.push({ type: 'level_complete', ts: T0 + 70_000, level: 'crypt' }, end(T0 + 200_000));
    evs.push(...session({ events }));
  }
  const spot = findings(ctxOf(evs), []).find((f) => f.id.startsWith('design-hotspot-'));
  assert.equal(spot.evidence.axis, 'xz');
  assert.match(spot.title, /at x≈12(\.\d)?, z≈-8(\.\d)?:/);
  assert.match(spot.summary, /in x=12–12\.3, z=-8\.5–-8/);
  assert.doesNotMatch(spot.suggestion, /landing platform/);
});

test('a rage quit after a level_fail counts at the death behind it', () => {
  const evs = [];
  for (let i = 0; i < 10; i++) {
    const events = [{ type: 'level_start', ts: T0 + 1000, level: 'l1' }, { type: 'death', ts: T0 + 4000, level: 'l1', x: 10 + (i % 2) * 0.3, y: 0, z: 0, cause: 'fell' }, { type: 'level_fail', ts: T0 + 5500, level: 'l1', cause: 'fell' }];
    events.push(end(T0 + (i < 4 ? 12_000 : 300_000)));
    evs.push(...session({ events }));
  }
  // A completed run, so leaving after a death is a rage quit.
  evs.push(...session({ events: [{ type: 'level_start', ts: T0 + 1000, level: 'l1' }, { type: 'level_complete', ts: T0 + 9000, level: 'l1' }, end(T0 + 300_000)] }));
  const ctx = ctxOf(evs);
  assert.equal(overview(ctx).kpis.rage_quits, 4);
  const spot = findings(ctx, []).find((f) => f.id.startsWith('design-hotspot-'));
  assert.equal(spot.evidence.hotspot.rage_quits, 4);
});

// Sessions whose gauges come from setContext: `pipes` is never cleaned up, `enemies` comes in waves (each
// bigger, the last one still on screen when the session ends), and `score` climbs by design.
function gauged(n) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const events = [{ type: 'level_start', ts: T0 + 100, level: 'sky' }];
    for (let w = 0; w < 6; w++) events.push(frames('sky', T0 + 5000 * (w + 1), { ctx: { pipes: 10 + w * 30, enemies: [0, 20, 0, 45, 0, 70][w], score: w * 500 } }));
    evs.push(...session({ events: [...events, end(T0 + 60_000)] }));
  }
  return evs;
}

test('a gauge that keeps climbing is a leak in the game\'s own words', () => {
  const ctx = ctxOf(gauged(4));
  const pipes = gaugeClimbs(ctx).find((g) => g.key === 'pipes');
  assert.deepEqual(pipes, { key: 'pipes', sessions: 4, climbing: 4, median_first: 10, median_last: 160 });
  assert.equal(gaugeClimbs(ctx).find((g) => g.key === 'enemies').climbing, 0);
  const found = findings(ctx, []).filter((f) => f.id.startsWith('leak-gauge-'));
  assert.deepEqual(
    found.map((f) => f.id),
    ['leak-gauge-pipes'],
    'score climbs by design',
  );
  assert.match(found[0].title, /`pipes` keeps climbing: median 10 → 160/);
  // With a geometry leak, the climbing gauges go into its summary instead.
  const loads = [];
  for (let i = 0; i < 4; i++) {
    const events = [];
    for (let l = 0; l < 3; l++) for (let w = 0; w < 2; w++) {
      const ts = T0 + l * 30_000 + w * 5000;
      if (!w) events.push({ type: 'level_start', ts: ts + 100, level: `l${l + 1}` });
      events.push(frames(`l${l + 1}`, ts + 5000, { geometries: 40 + l * 200, ctx: { pipes: 10 + (l * 2 + w) * 30 } }));
    }
    loads.push(...session({ events: [...events, end(T0 + 120_000)] }));
  }
  const all = findings(ctxOf(loads), []);
  const geo = all.find((f) => f.id === 'leak-geometries-1.0.0');
  assert.match(geo.summary, /Gauges that also keep climbing: `pipes` \(10 → 160 in 4 of 4 sessions\)/);
  assert.equal(geo.evidence.climbing_gauges[0].key, 'pipes');
  assert.ok(!all.some((f) => f.id.startsWith('leak-gauge-')));
});
