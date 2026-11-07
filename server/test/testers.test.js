// Testers (testers.js): players and sessions a game's team marked as its own play read as testers' in every query,
// their past sessions too, and players' numbers leave them out. And rage inputs (session-state.js) keep their level,
// time and place, for the players query and the session. From Lucky Twice, November 2026: the developer's own first
// playtest counted as the jam game's one real player, with a rage input nobody could place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, players, sessionsList, sessionDetail } from '../src/analytics.js';
import { foldSessions, mergeSession, finalizeSession, sessionToJSON, sessionFromJSON } from '../src/session-state.js';
import { testerIndex, markTester } from '../src/testers.js';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';

const T0 = Date.parse('2026-11-07T15:00:00Z');
const base = (id, player) => ({ service: 'kay-and-tee', env: 'prod', version: '0.3.0', session_id: id, player_id: player, sdk: 'glitchless-unity/0.6.4' });
function session(id, player, { type = 'user', at = T0, rage = false } = {}) {
  const evs = [
    { type: 'session_start', ts: at, session_type: type },
    { type: 'level_start', ts: at + 1000, level: 'day1-room1' },
    { type: 'pos', ts: at + 9000, level: 'day1-room1', pts: [[at + 8000, 3, 1, 0], [at + 8750, 4.5, 1, 0]] },
    ...(rage ? [{ type: 'custom', ts: at + 9100, level: 'day1-room1', name: 'rage_input', attrs: { key: 'Space', count: 5 } }] : []),
    { type: 'pos', ts: at + 9500, level: 'day1-room1', pts: [[at + 9250, 6, 1, 0]] },
    { type: 'level_complete', ts: at + 30_000, level: 'day1-room1', duration_s: 29 },
    { type: 'session_end', ts: at + 31_000, reason: 'pagehide' },
  ];
  return evs.map((e) => ({ level: null, ...e, ...base(id, player) }));
}
const range = { service: 'kay-and-tee', from: T0 - 60_000, to: T0 + 3_600_000 };

test('a marked player reads as a tester, past sessions too, and players-only reads leave them out', () => {
  const evs = [...session('s_dev1', 'p_dev'), ...session('s_dev2', 'p_dev', { at: T0 + 60_000 }), ...session('s_fan', 'p_fan'), ...session('s_bot', 'p_dev', { type: 'synthetic' })];
  const testers = testerIndex([{ player: 'p_dev', note: 'my own playtest', by: 'Owner', at: '2026-11-07T16:00:00Z' }]);
  const all = buildContext(evs, { ...range, type: 'all', testers });
  const types = Object.fromEntries(sessionsList(all).map((s) => [s.session_id, [s.session_type, Boolean(s.marked_tester)]]));
  assert.deepEqual(types, { s_dev1: ['tester', true], s_dev2: ['tester', true], s_fan: ['user', false], s_bot: ['synthetic', false] }, "a bot the developer ran stays a bot's");
  const users = buildContext(evs, { ...range, type: 'user', testers });
  assert.deepEqual([...users.sessions.keys()], ['s_fan']);
  assert.deepEqual([...buildContext(evs, { ...range, type: 'tester', testers }).sessions.keys()].sort(), ['s_dev1', 's_dev2']);
  // Without marks, the developer is a player.
  assert.equal(buildContext(evs, { ...range, type: 'user' }).sessions.size, 3);
});

test('a marked session is a tester, and the same player\'s other sessions stay players', () => {
  const evs = [...session('s_a', 'p_x'), ...session('s_b', 'p_x', { at: T0 + 60_000 })];
  const ctx = buildContext(evs, { ...range, type: 'user', testers: testerIndex([{ session: 's_a', note: 'demo at the meetup' }]) });
  assert.deepEqual([...ctx.sessions.keys()], ['s_b']);
  assert.equal(testerIndex([]), null);
  const s = { session_id: 's_1', player_id: null, session_type: 'user' };
  markTester(s, testerIndex([{ player: 'p_1' }]));
  assert.equal(s.session_type, 'user', 'an anonymous session matches no player');
});

test('the app reads the host\'s testers in every query, as soon as they change', async (t) => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'gl-testers-')));
  let marks = [];
  const app = createApp({ store, testers: async () => marks, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  for (const [id, player] of [['s_dev', 'p_dev'], ['s_fan', 'p_fan']]) {
    const events = session(id, player, { at: now - 120_000 }).map(({ service, env, version, session_id, player_id, sdk, ...e }) => e);
    assert.ok((await fetch(`${url}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ ...base(id, player), events }) })).ok);
  }
  const q = (name, extra = '') => fetch(`${url}/v1/query/${name}?service=kay-and-tee&from=${now - 3_600_000}&to=${now}${extra}`).then((r) => r.json());
  assert.equal((await q('players', '&type=user')).kpis.players, 2);
  marks = [{ player: 'p_dev', note: 'the developer', by: 'Owner', at: new Date(now).toISOString() }];
  app.forget('default');
  assert.equal((await q('players', '&type=user')).kpis.players, 1);
  const { session: s } = await q('session', '&id=s_dev');
  assert.equal(s.session_type, 'tester');
  assert.equal(s.marked_tester, true);
  assert.deepEqual((await q('sessions', '&type=tester')).sessions.map((x) => x.session_id), ['s_dev']);
});

test('a rage input keeps its level, time and the place the player stood just before it', () => {
  const evs = [...session('s_r', 'p_r', { rage: true }), ...session('s_calm', 'p_c', { at: T0 + 5000 })];
  const ctx = buildContext(evs, { ...range, type: 'all' });
  const p = players(ctx);
  assert.equal(p.kpis.rage_inputs, 1);
  assert.deepEqual(p.rage_inputs, [{ session_id: 's_r', version: '0.3.0', ts: T0 + 9100, level: 'day1-room1', key: 'Space', presses: 5, x: 4.5, y: 1, z: 0 }], 'the sample at 8.75 s, not the one after it');
  const detail = sessionDetail(ctx, 's_r', []);
  const r = detail.timeline.find((e) => e.name === 'rage_input');
  assert.deepEqual([r.level, r.x, r.y, r.z, r.attrs.key], ['day1-room1', 4.5, 1, 0, 'Space']);
});

test('a rage input finds its place across a store\'s parts of a session, as the whole session folded gives it', () => {
  const evs = session('s_r', 'p_r', { rage: true });
  // Parts split by time: the samples up to 8.75 s in one, the rage input (9.1 s) in another with only a later sample.
  const cut = T0 + 9050;
  const early = (e) => (e.type === 'pos' ? e.pts[0][0] : e.ts) < cut;
  const parts = [evs.filter((e) => early(e) && e.type !== 'pos'), evs.filter((e) => early(e) && e.type === 'pos'), evs.filter((e) => !early(e))];
  const [a, b, c] = parts.map((p) => sessionFromJSON(JSON.parse(JSON.stringify(sessionToJSON(foldSessions(p).get('s_r'))))));
  const merged = finalizeSession(mergeSession(mergeSession(c, a), b));
  const whole = finalizeSession(foldSessions(evs).get('s_r'));
  assert.deepEqual(merged.rin, whole.rin);
  assert.equal(whole.rin[0].x, 4.5);
  // Sessions stored before places were kept still list theirs from the custom event's occurrences.
  const old = { ...whole, rin: undefined };
  assert.deepEqual(players({ sessions: new Map([['s_r', old]]), events: [] }).rage_inputs, [{ session_id: 's_r', version: '0.3.0', ts: T0 + 9100, level: 'day1-room1', key: 'Space', presses: 5 }]);
});
