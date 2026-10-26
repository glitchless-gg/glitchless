// Groups, level attributes and zones (docs/design/genre-coverage.md A7 and decision 6; SPEC §2 group, §3 matches, §3b
// levels `by`): each session keeps its matches, parties and runs, a level start its attributes, and boards split
// levels by them; the matches query lines a match's players up slot by slot; zones split like levels. Every store
// answers as the raw events do, and day rollups fold the level funnel by the first attributes of each level's starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext, performance, sessionDetail } from '../src/analytics.js';
import { foldSessions, mergeSession, finalizeSession, sessionToJSON, sessionFromJSON } from '../src/session-state.js';
import { parsePayload, normalize } from '../src/ingest.js';
import { validateBoard, evaluateBoard } from '../src/board.js';
import { findings } from '../src/findings.js';
import { matchList, matchDetail } from '../src/matches.js';
import { foldDay, mergeDays, sessionDay, DAY } from '../src/daily.js';
import { sessionContext } from '../src/analytics.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { hashGroupId } from '../../packages/sdk/src/groups.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = Math.floor((NOW - 6 * 3_600_000) / 60_000) * 60_000;
const q = (extra = {}) => ({ service: 'pit', from: START - 60_000, to: NOW, type: 'all', ...extra });
const MATCH = hashGroupId('pit', 'm_8f2c91d04ab7');
const TIERS = ['pit_40', 'pit_60', 'pit_80'];

// A co-op ARPG: sessions in parties run dungeon attempts at a tier with a party size and a build (a list); pit_80 alone
// is a wall. A battle royale lobby of 6 shares one match ID; at 60-90 s everyone's ping spikes at once (the server),
// and one player lags on their own later. A roguelite's runs cross two biomes, one run resumed in a second session.
function pit() {
  let x = 5;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  const sessionOf = (n, extra = {}) => ({ service: 'pit', env: 'prod', version: '2.0', session_id: `s_${n}`, player_id: `p_${n}`, ...extra });
  for (let n = 0; n < 60; n++) {
    const base = sessionOf(n);
    let ts = START + n * 120_000;
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base, ts: (ts += 1000) });
    const solo = n % 3 === 0;
    const party = solo ? null : `h_${String(Math.floor(n / 3)).padStart(24, '0')}`;
    push({ type: 'session_start', session_type: 'user', device: { os: n % 2 ? 'Windows' : 'Linux' }, props: { class: ['druid', 'rogue'][n % 2] } });
    if (party) push({ type: 'group', kind: 'party', id: party, attrs: { size: 3 } });
    for (let a = 0; a < 3; a++) {
      const tier = TIERS[a];
      const stamp = party ? { party } : {};
      push({ type: 'level_start', level: tier, attrs: { tier, party_size: solo ? 1 : 3, build: ['blood_surge', a % 2 ? 'corpse_explosion' : 'bone_spear'] }, zone: 'kehjistan', ...stamp });
      const sk = new Sketch();
      for (let f = 0; f < 200; f++) sk.add(15 + rnd() * 3);
      push({ type: 'frame_window', level: tier, zone: 'kehjistan', duration_s: 5, frames: 200, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0, ...stamp });
      const wall = tier === 'pit_80' && solo;
      if (wall || rnd() < 0.08) {
        push({ type: 'death', level: tier, cause: 'butcher', x: 1, y: 2, z: 3, zone: 'kehjistan', ...stamp });
        push({ type: 'level_fail', level: tier, cause: 'timer', ...stamp });
      } else push({ type: 'level_complete', level: tier, duration_s: 300 + Math.floor(rnd() * 200), ...stamp });
    }
    push({ type: 'frame_window', level: null, zone: 'gea_kul', duration_s: 5, frames: 300, budget_ms: 16.67, ft: new Sketch().toJSON(), hitches: 0 });
    push({ type: 'custom', name: 'stash', zone: 'gea_kul', attrs: { gold: 10 } });
    push({ type: 'session_end' });
    out.push(events);
  }
  // The battle royale lobby: 6 players, 4 minutes, a ping of 40 ms, all at 200 ms in the third slot (60-90 s), and
  // player 0 alone at 250 ms in the sixth (150-180 s). Player 5 times out at 200 s.
  const lobbyStart = NOW - 2 * 3_600_000;
  for (let p = 0; p < 6; p++) {
    const base = sessionOf(100 + p);
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base });
    push({ type: 'session_start', ts: lobbyStart - 5000, session_type: 'user', device: { os: 'Windows' }, props: { region: 'eu' } });
    push({ type: 'group', ts: lobbyStart, kind: 'match', id: MATCH, attrs: { mode: 'squads', players: 6 }, match: MATCH });
    push({ type: 'level_start', ts: lobbyStart + 100, level: 'island', attrs: { mode: 'squads' }, match: MATCH });
    const end = p === 5 ? 200_000 : 240_000;
    for (let t = 0; t < end; t += 5000) {
      const slot = Math.floor(t / 30_000);
      const rtt = slot === 2 ? 200 : slot === 5 && p === 0 ? 250 : 40;
      const sk = new Sketch(0.05);
      for (let i = 0; i < 5; i++) sk.add(rtt + i);
      const ft = new Sketch();
      for (let f = 0; f < 300; f++) ft.add(16);
      push({ type: 'frame_window', ts: lobbyStart + t, level: 'island', match: MATCH, duration_s: 5, frames: 300, budget_ms: 16.67, ft: ft.toJSON(), hitches: 0, net: { rtt: sk.toJSON(), rtt_p50: rtt + 2, rtt_p95: rtt + 4, rtt_max: rtt + 4, jitter_ms: 2, loss_pct: 0.1, samples: 5, transport: 'ws', link: 'wifi', host: false } });
    }
    if (p === 5) {
      push({ type: 'disconnect', ts: lobbyStart + 200_000, level: 'island', match: MATCH, reason: 'timeout', connected_s: 200, rtt_p95: 44, loss_pct: 0.1 });
      push({ type: 'level_abandon', ts: lobbyStart + 200_001, level: 'island', match: MATCH, reason: 'disconnect' });
    } else push({ type: 'level_complete', ts: lobbyStart + 240_000, level: 'island', match: MATCH, duration_s: 240 });
    push({ type: 'group', ts: lobbyStart + 240_001, kind: 'match', id: null });
    push({ type: 'session_end', ts: lobbyStart + 241_000 });
    out.push(events);
  }
  // Two roguelite runs: run A crosses both biomes over two sessions (resumed), run B dies in the first.
  const runs = [
    ['s_200', 'r_aaaaaaaaaaaa', ['tartarus']],
    ['s_201', 'r_aaaaaaaaaaaa', ['asphodel']],
    ['s_202', 'r_bbbbbbbbbbbb', ['tartarus']],
  ];
  runs.forEach(([sid, run, levels], i) => {
    const base = sessionOf(Number(sid.slice(2)), { session_id: sid });
    let ts = NOW - 3_600_000 + i * 600_000;
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base, ts: (ts += 1000) });
    push({ type: 'session_start', session_type: 'user', device: { os: 'macOS' } });
    push({ type: 'group', kind: 'run', id: run, run, ...(i === 1 ? { resumed: true } : {}) });
    for (const level of levels) {
      push({ type: 'level_start', level, attrs: { heat: 8 }, run });
      push({ type: 'level_complete', level, duration_s: 120, run });
    }
    push({ type: 'session_end' });
    out.push(events);
  });
  return out;
}

const play = pit();
const events = play.flat().sort((a, b) => a.ts - b.ts);
const ctxOf = (extra = {}, list = events) => buildContext(list, q(extra));
const board = (panels, ctx = ctxOf()) => evaluateBoard(ctx, validateBoard({ panels }));

test('intake keeps groups, level attributes and zones, and drops what breaks their rules', () => {
  const { events: raw } = parsePayload({
    service: 'pit',
    session_id: 's_check',
    events: [
      { type: 'group', ts: NOW, kind: 'match', id: MATCH, attrs: { mode: 'squads', who: { a: 1 } }, match: MATCH },
      { type: 'group', ts: NOW, kind: 'guild', id: 'guild-000001' },
      { type: 'group', ts: NOW, kind: 'match', id: 'bad id!' },
      { type: 'group', ts: NOW, kind: 'match', id: null, ended: 'h_short' },
      { type: 'custom', ts: NOW, name: 'x', match: 'no', party: 'party_0042_x', zone: `  ${'z'.repeat(80)}  ` },
      { type: 'level_start', ts: NOW, level: 'pit', attrs: { tier: 'pit_80', build: ['a', 'b', 'a'], deep: { no: 1 } } },
    ],
  });
  const stored = normalize({ envelope: { service: 'pit', session_id: 's_check', player_id: 's_check', env: 'dev', version: '1' }, events: raw }, NOW);
  assert.deepEqual(stored.map((e) => e.type), ['group', 'group', 'custom', 'level_start']);
  assert.deepEqual(stored[0].attrs, { mode: 'squads' });
  assert.equal('ended' in stored[1], false, 'an ended ID that is not one is dropped');
  assert.equal('match' in stored[2], false);
  assert.equal(stored[2].party, 'party_0042_x');
  assert.equal(stored[2].zone, 'z'.repeat(64));
  assert.deepEqual(stored[3].attrs, { tier: 'pit_80', build: ['a', 'b'] });
});

test('a session keeps its groups, each from its first event to its last, however its events are folded', () => {
  const list = play[60];
  const whole = finalizeSession(foldSessions(list).get('s_100'));
  const half = Math.floor(list.length / 2);
  const [a, b] = [foldSessions(list.slice(half)).get('s_100'), foldSessions(list.slice(0, half)).get('s_100')];
  const merged = finalizeSession(mergeSession(sessionFromJSON(JSON.parse(JSON.stringify(sessionToJSON(a)))), b));
  assert.deepEqual(merged.groups, whole.groups);
  assert.deepEqual(whole.groups.map(({ kind, id, attrs }) => ({ kind, id, attrs })), [{ kind: 'match', id: MATCH, attrs: { mode: 'squads', players: 6 } }]);
  const detail = sessionDetail(ctxOf(), 's_1', []);
  assert.equal(detail.session.groups[0].kind, 'party');
  assert.ok(detail.timeline.some((e) => e.type === 'group'), 'the session timeline shows its groups');
});

test('the levels panel splits attempts by a start attribute, a list, a property or a split, one level or all', () => {
  const [byTier, bySize, byBuild, byClass, oneLevel, deaths] = board([
    { type: 'levels', label: 'Dungeon', by: 'tier' },
    { type: 'levels', by: 'party_size', level: 'pit_80' },
    { type: 'levels', by: 'build' },
    { type: 'levels', by: '$class' },
    { type: 'levels', level: 'island' },
    { type: 'deaths', by: 'tier' },
  ]);
  const attempts = events.filter((e) => e.type === 'level_start' && TIERS.includes(e.level));
  for (const tier of TIERS) {
    const row = byTier.rows.find((r) => r.level === tier && r.value === tier);
    assert.equal(row.attempts, attempts.filter((e) => e.attrs.tier === tier).length);
    const done = events.filter((e) => e.type === 'level_complete' && e.level === tier);
    assert.equal(row.completed, new Set(done.map((e) => e.session_id)).size, tier);
  }
  assert.equal(byTier.by, 'tier');
  assert.equal(byTier.title, 'Dungeons by tier');
  assert.deepEqual(bySize.rows.map((r) => r.value).sort(), ['1', '3']);
  const solo = bySize.rows.find((r) => r.value === '1');
  assert.ok(solo.completion_pct < bySize.rows.find((r) => r.value === '3').completion_pct);
  assert.equal(byBuild.rows.filter((r) => r.value === 'blood_surge').reduce((n, r) => n + r.attempts, 0), attempts.length, 'an attempt counts under each element of a list');
  assert.equal(byBuild.rows.filter((r) => r.value !== 'blood_surge' && TIERS.includes(r.level)).reduce((n, r) => n + r.attempts, 0), attempts.length);
  assert.deepEqual(byClass.rows.filter((r) => r.level === 'pit_80').map((r) => r.value).sort(), ['druid', 'rogue']);
  assert.deepEqual(oneLevel.rows.map((r) => [r.level, r.sessions, r.completed, r.abandons, r.disconnects]), [['island', 6, 5, 1, 1]]);
  assert.ok(deaths.rows.every((r) => r.value === 'pit_80' || r.deaths > 0));
});

test('runs count once at each level they reach, across sessions; stat runs counts every run', () => {
  const [runs, total] = board([{ type: 'levels', label: 'Biome', count: 'runs' }, { type: 'stat', metric: 'runs' }]);
  assert.deepEqual(runs.rows.filter((r) => ['tartarus', 'asphodel'].includes(r.level)).map((r) => [r.level, r.runs]), [['asphodel', 1], ['tartarus', 2]]);
  assert.equal(total.value, 2);
});

test('finding 10: a wall at one value of an attempt attribute', () => {
  const list = findings(ctxOf());
  const wall = list.find((f) => f.id === 'design-wall-pit_80-party_size-1');
  assert.ok(wall, list.map((f) => f.id).join(', '));
  assert.match(wall.title, /^pit_80 with party_size 1 is a wall: \d+(\.\d)?% of the sessions that play it get through, against \d+(\.\d)?% with other party_size values$/);
});

test("matches: the range's matches, and one match slot by slot, with the lobby spike and a player alone", () => {
  const ctx = ctxOf();
  const { matches, total } = matchList(ctx);
  assert.equal(total, 1);
  const [m] = matches;
  assert.deepEqual([m.id, m.sessions, m.level, m.attrs, m.outcomes, m.disconnects, m.disconnect_reasons], [MATCH, 6, 'island', { mode: 'squads', players: 6 }, { complete: 5, disconnect: 1 }, 1, { timeout: 1 }]);
  assert.ok(m.ping_p95 > 190 && m.ping_p50 < 50, `${m.ping_p50} ${m.ping_p95}`);
  const d = matchDetail(ctx, MATCH);
  assert.equal(d.slot_s, 30);
  assert.deepEqual(d.lobby_spikes, [60], 'everyone lagged at once in the third slot: the server');
  const p0 = d.sessions.find((s) => s.session_id === 's_100');
  assert.deepEqual(p0.slots.filter((x) => x.spike).map((x) => x.t), [60, 150], 'player 0 also lagged alone');
  const p5 = d.sessions.find((s) => s.session_id === 's_105');
  assert.deepEqual([p5.outcome, p5.disconnects], ['disconnect', [{ t: 200, reason: 'timeout' }]]);
  assert.equal(p5.props.region, 'eu');
  assert.equal(matchDetail(ctx, 'h_nothing_here_000000000'), null);
});

test('zones split like levels: $zone on breakdowns and series, and the performance view by zone', () => {
  const [byZone, hours] = board([{ type: 'breakdown', event: 'stash', by: '$zone' }, { type: 'breakdown', event: 'stash', by: '$zone', per: '$hours' }]);
  assert.deepEqual(byZone.rows.map((r) => [r.value, r.count]), [['gea_kul', 60]]);
  assert.ok(hours.rows[0].hours > 0);
  const perf = performance(ctxOf());
  assert.deepEqual(perf.by_zone.map((z) => z.key), ['gea_kul', 'kehjistan']);
  assert.ok(perf.by_zone.every((z) => z.sessions === null && z.frames > 0));
});

test("day rollups fold the level funnel by the first attributes of each level's starts, as the raw events do", () => {
  const sessions = [...ctxOf().sessions.values()];
  const days = new Map();
  for (const s of sessions) {
    const d = sessionDay(s);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(s);
  }
  const folded = [...days].map(([day, list]) => foldDay(day, { sessions: list }));
  const { cells, facts, daily } = mergeDays(folded, () => true);
  const ctx = sessionContext({ ...q(), from: Math.min(...days.keys()), to: NOW }, new Map());
  Object.assign(ctx, { daily, cells, facts, meta: { resolution: 'day', approximate: [] } });
  const [byTier] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'levels', by: 'party_size', level: 'pit_80' }] }));
  const [raw] = board([{ type: 'levels', by: 'party_size', level: 'pit_80' }]);
  const keep = (r) => [r.level, r.value, r.sessions, r.completed, r.attempts, r.fails, r.deaths, r.abandons, r.p50_complete_s];
  assert.deepStrictEqual(byTier.rows.map(keep), raw.rows.map(keep));
  const [byClass] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'levels', by: '$class' }] }));
  assert.match(byClass.why, /31 days or less/);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: levels by attribute, runs, matches and zones answer as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const PANELS = [
      { type: 'levels', by: 'tier' },
      { type: 'levels', by: '$class' },
      { type: 'levels', count: 'runs' },
      { type: 'stat', metric: 'runs' },
      { type: 'breakdown', event: 'stash', by: '$zone' },
      { type: 'deaths', by: 'party_size' },
    ];
    try {
      for (const list of play) {
        const { service, env, version, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      await call('PUT', '/v1/dashboard?service=pit', { pages: [{ id: 'pit', title: 'Pit', panels: PANELS }] });
      const range = `service=pit&from=${START - 60_000}&to=${NOW + 1}`;
      const { meta, board: got } = await call('GET', `/v1/query/board?${range}&page=pit`);
      const raw = ctxOf({ from: meta.from, to: meta.to }, events.filter((e) => e.ts >= meta.from && e.ts <= meta.to));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(got.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels: PANELS })))));
      const list = await call('GET', `/v1/query/matches?${range}`);
      assert.deepStrictEqual(list.matches, JSON.parse(JSON.stringify(matchList(raw).matches)));
      const one = await call('GET', `/v1/query/matches?${range}&id=${MATCH}`);
      assert.deepEqual(one.match.lobby_spikes, [60]);
      assert.equal(one.match.sessions.length, 6);
      const players = await call('GET', `/v1/query/players?${range}&by=party_size&level=pit_80`);
      assert.deepEqual(players.funnel_by.rows.map((r) => r.value).sort(), ['1', '3']);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
