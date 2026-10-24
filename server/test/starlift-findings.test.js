// Findings checked against a real game's numbers: Starlift (Godot 4.7, iPhone and Android), 14 days to
// 24 October 2026, where each finding was recomputed from the raw sessions. Fixtures use its values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext, performance, eventLift } from '../src/analytics.js';
import { findings, versionFrames } from '../src/findings.js';
import { evaluate, alertMessage } from '../src/alerts.js';
import { versions } from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';

const T0 = 1_760_000_000_000;
const GODOT = 'glitchless-godot/0.2.0';
let seq = 0;

function session({ id = `s_${++seq}`, version = '1.1', env = 'prod', type = 'user', ts = T0, events = [] }) {
  const base = { service: 'starlift', env, version, session_id: id, player_id: id, sdk: GODOT };
  return [{ type: 'session_start', ts, session_type: type, device: { browser: 'Godot', os: 'iOS', gpu_tier: 'high' } }, ...events].map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values, { budget = 16.67, ...extra } = {}) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, budget_ms: budget, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length, ...extra };
}

const ctxOf = (events) => buildContext(events, { service: 'starlift', from: T0 - 1000, to: T0 + 86_400e3, type: 'all' });

// Starlift's 71 first-frame times (ms): the developer's phone and bots start in under 1.4s, players' phones
// mostly in 4 to 11.5s.
const TTFF = [
  545, 586, 620, 713, 815, 559, 583, 588, 603, 606, 637, 667, 683, 695, 705, 729, 740, 753, 793, 803, 811, 824, 838, 843, 872, 643, 667, 843, 887, 933, 1367,
  500, 531, 544, 583, 4149, 4241, 4358, 4794, 4950, 5156, 5257, 5294, 5307, 5325, 6338, 6689, 558, 686, 727, 4588, 4733, 5030, 5212, 5398, 5741, 5842, 6157,
  6224, 7143, 8537, 8695, 9388, 9633, 10582, 11513, 1259, 2578, 7029, 8722, 9787,
];

test('a slow start hits the sessions that waited over 4s, not every session', () => {
  const evs = TTFF.flatMap((ttff, i) => session({ ts: T0 + i * 60_000, events: [{ type: 'load', ts: T0 + i * 60_000 + 50, ttff_ms: ttff }] }));
  const slow = findings(ctxOf(evs)).find((f) => f.id === 'load-ttff');
  assert.ok(slow);
  assert.equal(slow.title, 'Slow start: p95 time-to-first-frame is 9.6s');
  assert.equal(slow.severity, 'high');
  assert.equal(slow.evidence.slow_sessions_pct, 43.7);
  assert.equal(slow.impact_pct, 43.7, '31 of 71 sessions, not 100%');
  assert.match(slow.summary, /^43\.7% of sessions waited more than 4s for the first frame \(median 0\.9s\)\. Players expect/);
});

// Starlift 1.0.1's "node leak": three identical bot runs whose last frame window came as the game quit, with
// 82 of its 84 nodes already out of the tree. Orphans went 0 → 82 while the live tree went 84 → 2.
test('orphans that rise only as the live tree empties are not a node leak', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(
      ...session({
        version: '1.0.1',
        events: [
          { type: 'level_start', ts: T0 + 100, level: 'expedition_1' },
          frames('expedition_1', T0 + 5000, Array(300).fill(8.3), { nodes: 84, orphan_nodes: 0 }),
          { type: 'level_start', ts: T0 + 20_000, level: 'expedition_2' },
          frames('expedition_2', T0 + 25_000, Array(300).fill(8.3), { nodes: 106, orphan_nodes: 0 }),
          { type: 'level_start', ts: T0 + 30_000, level: 'expedition_2' },
          frames('expedition_2', T0 + 35_000, Array(300).fill(8.3), { nodes: 2, orphan_nodes: 82 }),
        ],
      }),
    );
  }
  const ctx = ctxOf(evs);
  const growth = performance(ctx).node_growth['1.0.1'];
  assert.equal(growth.orphan_nodes_growth_per_level_load, 41);
  assert.equal(growth.nodes_growth_per_level_load, -41);
  const fs = findings(ctx);
  assert.ok(!fs.some((f) => f.id.startsWith('leak-orphan-nodes')), `findings: ${fs.map((f) => f.id)}`);
});

// Starlift 1.1 on 8 Android test devices (OpenGL, 288×480): every canvas shader link failure is followed in the
// same millisecond by the failed _compile_specialization that called it, 56 of each.
const LINK = { kind: 'engine', fingerprint: '9803ec1a', message: 'CanvasShaderGLES3: Program linking failed:\nFragment shader active uniforms exceed GL_MAX_FRAGMENT_UNIFORM_VECTORS (261)', fn: '_display_error_with_code', source: 'shader_gles3.cpp', line: 262, stack: 'engine: CanvasShaderGLES3: Program linking failed:\n    at _display_error_with_code (drivers/gles3/shader_gles3.cpp:262)' };
const SPECIALIZATION = { kind: 'engine', fingerprint: 'cc2b6e5e', message: 'Method/function failed.', fn: '_compile_specialization', source: 'shader_gles3.cpp', line: 464, stack: 'engine: Method/function failed.\n    at _compile_specialization (drivers/gles3/shader_gles3.cpp:464)' };

function shaderSessions() {
  const evs = [];
  for (let i = 0; i < 8; i++) {
    const t = T0 + i * 600_000;
    const errors = Array.from({ length: 7 }, (_, k) => [LINK, SPECIALIZATION].map((e) => ({ type: 'error', ts: t + 2000 + k * 400, ...e }))).flat();
    evs.push(...session({ ts: t, events: [{ type: 'custom', ts: t + 377, name: 'open', attrs: { what: 'free' } }, ...errors] }));
  }
  for (let i = 0; i < 84; i++) evs.push(...session({ ts: T0 + 6e6 + i * 60_000 }));
  return evs;
}

test('an error logged with another every time is one finding, not two', () => {
  const fs = findings(ctxOf(shaderSessions()));
  const errors = fs.filter((f) => f.category === 'stability');
  assert.deepEqual(errors.map((f) => f.id), ['error-9803ec1a']);
  const [link] = errors;
  assert.equal(link.severity, 'medium');
  assert.equal(link.impact_pct, 8.7);
  assert.deepEqual(link.evidence.logged_with, [{ fingerprint: 'cc2b6e5e', message: 'Method/function failed.', location: '_compile_specialization (shader_gles3.cpp:464)' }]);
  assert.match(link.summary, /^56 occurrences in 8 sessions \(8\.7% of sessions\)/);
  assert.match(link.summary, /Each time it comes with "Method\/function failed\." at _compile_specialization \(shader_gles3\.cpp:464\): one failure, logged 2 ways\.$/);
});

test('errors that only share a session stay apart', () => {
  const evs = shaderSessions().filter((e) => !(e.fingerprint === 'cc2b6e5e' && e.ts % 800 === 0));
  const ids = findings(ctxOf(evs)).filter((f) => f.category === 'stability').map((f) => f.id);
  assert.deepEqual(ids.sort(), ['error-9803ec1a', 'error-cc2b6e5e']);
});

test("a renderer error as the game starts gets the renderer's advice, not null-node advice", () => {
  const link = findings(ctxOf(shaderSessions())).find((f) => f.id === 'error-9803ec1a');
  assert.match(link.suggestion, /^Start at _display_error_with_code \(shader_gles3\.cpp:262\)\. The error fires as the game starts \(in the first seconds of a session, before any level\)\. It comes from Godot's renderer, not your scripts/);
  assert.doesNotMatch(link.suggestion, /normal play|not on load|get_node\(\)/);
});

// Starlift 1.0.1's e1ceb921: a Callable whose captured node was freed, on the Expedition's second stop.
test('an engine check broken during play points at the call, and says when it fires', () => {
  const freed = { kind: 'engine', fingerprint: 'e1ceb921', message: 'Lambda capture at index 0 was freed. Passed "null" instead.', fn: '_wait_for', source: 'main.gd', line: 995, stack: 'engine: Lambda capture at index 0 was freed. Passed "null" instead.\n    at call (modules/gdscript/gdscript_lambda_callable.cpp:242)\n    at _wait_for (res://src/main.gd:995)' };
  const evs = [];
  for (let i = 0; i < 3; i++) {
    evs.push(...session({ events: [{ type: 'level_start', ts: T0 + 20_000, level: 'expedition_2' }, { type: 'level_fail', ts: T0 + 22_000, level: 'expedition_2', cause: 'defeat' }, { type: 'error', ts: T0 + 23_000, level: 'expedition_2', ...freed }, { type: 'error', ts: T0 + 23_500, level: 'expedition_2', ...freed }] }));
  }
  const f = findings(ctxOf(evs)).find((x) => x.id === 'error-e1ceb921');
  assert.match(f.suggestion, /^Start at _wait_for \(main\.gd:995\)\. The error fires during play, so look for the call that broke the engine check the message names, on the code path triggered by defeat: .*is_instance_valid\(\)/);
});

// Starlift's endless_normal: 14 of its 77 hitch events come right after `quick`, which Quick Play sends from the
// menu before the run's level starts, so the level itself barely counts it. Its lift was 0.182 / 0.001 (the
// floor) = 181.8; measured against the game's own rate of `quick`, it is about 62.
test("an event sent before the level starts is measured against the game's rate, not the floor", () => {
  const evs = [];
  for (let i = 0; i < 23; i++) {
    const t = T0 + i * 600_000;
    const quick = i < 14;
    const events = [];
    if (quick) events.push({ type: 'custom', ts: t, name: 'quick', attrs: { what: 'halcyon' } }, frames(null, t, Array(1200).fill(16.7), { duration_s: 20 }));
    events.push({ type: 'level_start', ts: t + 20_050, level: 'endless_normal' });
    if (quick) events.push({ type: 'hitch', ts: t + 20_600, level: 'endless_normal', duration_ms: 90, causes: [], recent: ['quick', 'level_start'] });
    else for (let k = 0; k < 7; k++) events.push({ type: 'hitch', ts: t + 30_000 + k * 20_000, level: 'endless_normal', duration_ms: 60, causes: [], recent: ['sideways'] });
    events.push(frames('endless_normal', t + 25_000, Array(18_000).fill(16.7), { duration_s: 300 }));
    evs.push(...session({ ts: t, events }));
  }
  const [quick] = eventLift(ctxOf(evs), 'endless_normal').filter((p) => p.event === 'quick');
  assert.equal(quick.share, 0.182);
  assert.equal(quick.base_rate, 0.003);
  assert.equal(quick.lift, 62.3);
});

// endless_relaxed: 3 of its 6 hitches came after `play`, from 3 sessions. Too few to call it a trigger.
test('an event named by fewer than five hitches is not a trigger', () => {
  const evs = [];
  for (let i = 0; i < 3; i++) {
    const t = T0 + i * 600_000;
    evs.push(
      ...session({
        ts: t,
        events: [
          { type: 'custom', ts: t, name: 'play', attrs: { what: 'endless' } },
          { type: 'level_start', ts: t + 50, level: 'endless_relaxed' },
          { type: 'hitch', ts: t + 600, level: 'endless_relaxed', duration_ms: 96, causes: ['shader_compile'], recent: ['play', 'level_start'] },
          { type: 'hitch', ts: t + 40_000, level: 'endless_relaxed', duration_ms: 60, causes: [], recent: [] },
          frames('endless_relaxed', t + 5000, Array(3000).fill(16.7), { duration_s: 50 }),
        ],
      }),
    );
  }
  assert.deepEqual(eventLift(ctxOf(evs), 'endless_relaxed'), []);
});

// Starlift's "endless_intense is a wall": 6 sessions, all from the developer's own phone, 1 run played out and
// 4 left part way. Other levels: the lesson 15 of 21, endless_normal 17 of 31, expedition_1 6 of 6.
function plays(level, sessions, completes, fails) {
  return Array.from({ length: sessions }, (_, i) => {
    const t = T0 + i * 600_000;
    const end = i < completes ? [{ type: 'level_complete', ts: t + 90_000, level }] : i < completes + fails ? [{ type: 'level_fail', ts: t + 90_000, level, cause: 'left' }] : [];
    return session({ ts: t, events: [{ type: 'level_start', ts: t + 1000, level }, ...end] });
  }).flat();
}

test('a wall seen in fewer than 10 sessions is not high, and says it could be chance', () => {
  const evs = [...plays('lesson', 21, 15, 4), ...plays('endless_normal', 31, 17, 14), ...plays('expedition_1', 6, 6, 0), ...plays('endless_intense', 6, 1, 4)];
  const walls = findings(ctxOf(evs)).filter((f) => f.id.startsWith('design-wall-'));
  assert.deepEqual(walls.map((f) => f.id), ['design-wall-endless_intense']);
  const [wall] = walls;
  assert.equal(wall.evidence.completion_pct, 16.7);
  assert.equal(wall.evidence.other_levels_median_pct, 71.4);
  assert.equal(wall.severity, 'medium');
  assert.match(wall.summary, /Only 6 sessions reached it, so this could be chance\.$/);
});

// Starlift 1.1 vs 1.0.1: "improved — p95 frame time 9.98ms → 17.46ms", because error-free sessions went up.
// 1.0.1's frames all came from 120 Hz screens; half of 1.1's from 60 Hz phones, whose every frame is 16.7ms.
const fast = (n = 600) => [...Array(n - 30).fill(8.33), ...Array(30).fill(10)];
const slow60 = (n = 600) => [...Array(n - 30).fill(16.67), ...Array(30).fill(17.5)];
const heavy = (n = 600) => [...Array(n - 100).fill(8.33), ...Array(100).fill(17.5)];
const ERR = { type: 'error', kind: 'engine', fingerprint: 'ab', message: 'x', fn: 'f', source: 'a.gd', line: 1 };

function versionSessions(version, specs) {
  return specs.flatMap(({ values, budget, error }, i) => {
    const t = T0 + (version === '1.0.1' ? 0 : 86_400e3 / 2) + i * 60_000;
    return session({ version, ts: t, events: [frames(null, t + 5000, values, { budget }), ...(error ? [{ ...ERR, ts: t + 6000 }] : [])] });
  });
}
const ctxOf2 = (events) => buildContext(events, { service: 'starlift', from: T0 - 1000, to: T0 + 86_400e3 * 2, type: 'all' });

test('fewer errors do not make slower frames an improvement', () => {
  const evs = [
    ...versionSessions('1.0.1', Array.from({ length: 10 }, (_, i) => ({ values: fast(), budget: 8.33, error: i === 0 }))),
    ...versionSessions('1.1', Array.from({ length: 20 }, () => ({ values: heavy(), budget: 8.33 }))),
  ];
  const v = findings(ctxOf2(evs)).find((f) => f.id === 'version-1.0.1-1.1');
  assert.ok(v);
  assert.match(v.title, /^1\.1 vs 1\.0\.1: mixed — p95 frame time [\d.]+ms → [\d.]+ms$/);
  assert.equal(v.severity, 'high');
  assert.match(v.summary, /error-free sessions 90% → 100%/);
  assert.doesNotMatch(v.suggestion, /Ship it/);
  assert.match(v.suggestion, /error-free sessions got better, but frame time got worse\.$/);
});

test('versions that ran on different screens compare frame times at one refresh rate', () => {
  const evs = [
    ...versionSessions('1.0.1', Array.from({ length: 6 }, (_, i) => ({ values: fast(), budget: 8.33, error: i === 0 }))),
    ...versionSessions('1.1', [...Array.from({ length: 10 }, () => ({ values: fast(), budget: 8.33 })), ...Array.from({ length: 10 }, (_, i) => ({ values: slow60(), budget: 16.67, error: i === 0 }))]),
  ];
  const ctx = ctxOf2(evs);
  const v = findings(ctx).find((f) => f.id === 'version-1.0.1-1.1');
  assert.ok(v);
  // All frames together: p95 goes from a 120 Hz frame to a 60 Hz one. On the same screens nothing changed.
  assert.ok(v.evidence.current.frame_p95 > 16, `p95 ${v.evidence.current.frame_p95}`);
  assert.equal(v.title, '1.1 vs 1.0.1: improved — error-free sessions 83.3% → 95%');
  assert.equal(v.evidence.frames_compared_at_budget_ms, 8.33);
  assert.equal(v.evidence.previous_frames.frame_p95, v.evidence.current_frames.frame_p95);
  assert.match(v.summary, /The versions ran on different screens \(1\.0\.1 100% at 120 Hz; 1\.1 50% at 120 Hz, 50% at 60 Hz\), so frame times are compared on 120 Hz screens only\. Only 6 sessions on 1\.0\.1, so this could be chance\.$/);
});

// Starlift's 1.0.1 in prod is seven day totals imported from its old counters: sessions with no frame windows.
test('a version that sent no frame windows gets no screens note', () => {
  const evs = [
    ...Array.from({ length: 10 }, (_, i) => session({ version: '1.0.1', ts: T0 + i * 60_000 })).flat(),
    ...versionSessions('1.1', Array.from({ length: 12 }, (_, i) => ({ values: fast(), budget: 8.33, error: i < 2 }))),
  ];
  const v = findings(ctxOf2(evs)).find((f) => f.id === 'version-1.0.1-1.1');
  assert.equal(v.title, '1.1 vs 1.0.1: regressed — error-free sessions 100% → 83.3%');
  assert.doesNotMatch(v.summary, /screens/);
});

// Starlift 1.1's players: iPhones at 120 Hz and phones at 60 Hz. Against the range's median budget (8.33ms)
// every 60 Hz frame was "over budget": endless_relaxed, played only on 60 Hz phones, showed 100%.
test("frames over budget are judged against each screen's own refresh rate", () => {
  const evs = [
    ...session({ events: [frames('endless_normal', T0 + 5000, fast(), { budget: 8.33 }), frames('endless_normal', T0 + 10_000, fast(), { budget: 8.33 }), frames('endless_normal', T0 + 15_000, fast(), { budget: 8.33 })] }),
    ...session({ events: [frames('endless_relaxed', T0 + 5000, slow60(), { budget: 16.67 })] }),
  ];
  const p = performance(ctxOf(evs));
  assert.equal(p.kpis.frame_budget_ms, 8.33, 'the median screen is still reported');
  assert.equal(p.by_level.find((l) => l.key === 'endless_relaxed').pct_over_budget, 0);
  assert.equal(p.by_level.find((l) => l.key === 'endless_normal').pct_over_budget, 5);
  assert.equal(p.kpis.pct_frames_over_budget, 3.8);
});

// ───── through the API ─────

async function serve() {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'gl-starlift-')));
  const server = http.createServer(createApp({ store, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    send: (events) => {
      const { service, env, version, session_id, player_id } = events[0];
      const body = { service, env, version, session_id, ...(player_id ? { player_id } : {}), sdk: GODOT, events: events.map(({ service, env, version, session_id, player_id, sdk, ...e }) => e) };
      return fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify(body) });
    },
    get: async (p) => (await fetch(base + p)).json(),
    close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))),
  };
}

const NOW = Date.now();
const live = (opts, events = []) => session({ ts: NOW - 3_600_000, ...opts, events: events.map((e) => ({ ...e, ts: NOW - 3_600_000 + e.ts })) });

test('an anonymous game says its players counts are sessions', async () => {
  const app = await serve();
  try {
    for (let i = 0; i < 3; i++) {
      const evs = live({ id: `s_anon${i}` });
      for (const e of evs) e.player_id = undefined;
      assert.ok((await app.send(evs)).ok);
    }
    const range = `service=starlift&from=${NOW - 7_200_000}&to=${NOW}`;
    const o = await app.get(`/v1/query/overview?${range}`);
    assert.equal(o.kpis.players, 3);
    assert.equal(o.meta.players_are_sessions, true);
    assert.match(o.meta.note, /every players count here is a count of sessions/);
    // One install-mode session with its own player ID: counts of players are players again.
    await app.send(live({ id: 's_install', player_id: 'p_1' }).map((e) => ({ ...e, player_id: 'p_1' })));
    assert.equal((await app.get(`/v1/query/overview?${range}`)).meta.players_are_sessions, undefined);
  } finally {
    await app.close();
  }
});

// Starlift's "Lambda capture at index 0 was freed" came from 3 bot runs only, and its 1.0.1 node "leak" from the
// same bots: they are not about players.
test('findings read the production sessions of players unless asked otherwise', async () => {
  const app = await serve();
  try {
    const freed = { type: 'error', level: 'expedition_2', kind: 'engine', fingerprint: 'e1ceb921', message: 'Lambda capture at index 0 was freed. Passed "null" instead.', fn: '_wait_for', source: 'main.gd', line: 995 };
    for (let i = 0; i < 3; i++) await app.send(live({ id: `s_bot${i}`, env: 'dev', type: 'synthetic' }, [{ type: 'level_start', ts: 1000, level: 'expedition_2' }, { ...freed, ts: 2000 }, { ...freed, ts: 2500 }]));
    for (let i = 0; i < 2; i++) await app.send(live({ id: `s_dev${i}`, env: 'dev' }));
    for (let i = 0; i < 4; i++) await app.send(live({ id: `s_prod${i}` }));
    const range = `service=starlift&from=${NOW - 7_200_000}&to=${NOW}`;
    const players = await app.get(`/v1/query/findings?${range}`);
    assert.ok(!players.findings.some((f) => f.id === 'error-e1ceb921'), `findings: ${players.findings.map((f) => f.id)}`);
    assert.deepEqual(players.meta.findings_from, { env: 'prod', type: 'user', sessions: 4, of: 9 });
    assert.match(players.meta.note, /findings read the 4 prod sessions of players \(no dev builds or bots\) of the 9 in the range/);
    const all = await app.get(`/v1/query/findings?${range}&type=all`);
    assert.ok(all.findings.some((f) => f.id === 'error-e1ceb921'), 'asked for every session type');
    assert.equal(all.meta.findings_from, undefined);
    const overview = await app.get(`/v1/query/overview?${range}`);
    assert.equal(overview.kpis.sessions, 9, 'the KPIs keep what the query asked for');
    assert.ok(!overview.findings.some((f) => f.id === 'error-e1ceb921'));
  } finally {
    await app.close();
  }
});

// The release alert's frame_p95 rule compared the versions' p95 over all their frames: Starlift 1.1 reached more 60 Hz
// iPhones than 1.0.1, so its p95 rose with no frame any slower. It now compares on the screens both ran on.
test('the release alert compares frame times on the screens both versions ran on', () => {
  const alerts = (evs) => {
    const ctx = ctxOf2(evs);
    const [prev, cur] = versions(ctx).filter((v) => v.sessions >= 5).slice(-2);
    const frames = versionFrames(ctx, prev, cur);
    const out = evaluate({ now: T0 + 86_400e3 * 2, versions: [prev, cur].map((v) => ({ ...v, sessions: Math.max(v.sessions, 50) })), frames, settings: { rules: { crash_free: false, finding: false, new_error: false } } });
    return out.signals.filter((x) => x.rule === 'frame_p95');
  };
  // More 60 Hz phones, the same frames on each screen: no alert, though the p95 over everything rose.
  const mix = [
    ...versionSessions('1.0.1', Array.from({ length: 6 }, () => ({ values: fast(), budget: 8.33 }))),
    ...versionSessions('1.1', [...Array.from({ length: 10 }, () => ({ values: fast(), budget: 8.33 })), ...Array.from({ length: 10 }, () => ({ values: slow60(), budget: 16.67 }))]),
  ];
  const [quiet] = alerts(mix);
  assert.equal(quiet.holds, false);
  assert.equal(quiet.frames.budget, 8.33);
  assert.ok(quiet.cur.frame_p95 > 16, 'over all frames the p95 rose');

  // Slower on the same 120 Hz screens: the alert holds, and says it compared the 120 Hz ones.
  const slower = [
    ...versionSessions('1.0.1', Array.from({ length: 6 }, () => ({ values: fast(), budget: 8.33 }))),
    ...versionSessions('1.1', [...Array.from({ length: 10 }, () => ({ values: heavy(), budget: 8.33 })), ...Array.from({ length: 10 }, () => ({ values: slow60(), budget: 16.67 }))]),
  ];
  const [loud] = alerts(slower);
  assert.equal(loud.holds, true);
  const m = alertMessage({ ...loud, service: 'starlift', at: T0 });
  assert.match(m.title, /^starlift 1\.1 runs slower than 1\.0\.1: p95 frame time on 120 Hz screens [\d.]+ms → [\d.]+ms$/);
  assert.match(m.facts[0], /^The versions ran on different screens, so this compares the 120 Hz ones/);
});
