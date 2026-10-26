// Session properties (docs/design/genre-coverage.md A6; SPEC §2 props, §3, §3b): checked at intake, kept per session
// (the latest value of each key), and read wherever $platform is: splits, filters, a page's `where`, performance by
// property, retention and versions by property, and findings that name a property. Every store answers as the raw
// events do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext, indexSessions, performance, retention, versions } from '../src/analytics.js';
import { foldSessions, mergeSession, finalizeSession, sessionToJSON, sessionFromJSON } from '../src/session-state.js';
import { parsePayload, normalize } from '../src/ingest.js';
import { validateBoard, validateDashboard, evaluateBoard } from '../src/board.js';
import { findings } from '../src/findings.js';
import { propertyList } from '../src/properties.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { STORES } from './helpers/stores.js';

const DAY = 86_400_000;
const NOW = Date.now();
const START = Math.floor((NOW - 4 * DAY) / DAY) * DAY + 3_600_000;
const q = (extra = {}) => ({ service: 'rift', from: START - 60_000, to: NOW, type: 'all', ...extra });
const RANKS = ['bronze', 'silver', 'gold', 'diamond'];
const CLASSES = ['druid', 'necromancer', 'rogue'];

// A seeded MOBA: 120 sessions over four days from 40 players, each with a rank and class (and some a preset), one in
// five changing rank part way, matches with a hero and a win, frame windows (the ultra preset slow), and a crash that
// hits necromancers.
function rift({ sessions = 120 } = {}) {
  let x = 11;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  for (let n = 0; n < sessions; n++) {
    const player = `p_${n % 40}`;
    const base = { service: 'rift', env: 'prod', version: n < 60 ? '1.3' : '1.4', session_id: `s_${n}`, player_id: player };
    let ts = START + Math.floor((n / sessions) * 3.5 * DAY) + Math.floor(rnd() * 3_600_000);
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base, ts: (ts += 1000 + Math.floor(rnd() * 2000)) });
    const cls = CLASSES[n % 3];
    const props = { rank: RANKS[Math.floor(rnd() * 4)], class: cls, ...(n % 4 === 0 ? {} : { preset: n % 4 === 1 ? 'ultra' : n % 4 === 2 ? 'high' : 'low' }) };
    push({ type: 'session_start', session_type: 'user', device: { os: n % 2 ? 'Windows' : 'macOS', gpu_tier: 'high' }, props });
    for (let m = 0; m < 3; m++) {
      if (m === 1 && n % 5 === 0) push({ type: 'props', props: { rank: 'master' } });
      push({ type: 'level_start', level: 'rift', attrs: { mode: 'ranked' } });
      for (let w = 0; w < 4; w++) {
        const sk = new Sketch();
        for (let f = 0; f < 300; f++) sk.add(props.preset === 'ultra' && f % 4 === 0 ? 45 : 14 + rnd() * 3);
        push({ type: 'frame_window', level: 'rift', duration_s: 5, frames: 300, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0 });
      }
      push({ type: 'custom', level: 'rift', name: 'queue', attrs: { mode: 'ranked', wait_s: props.rank === 'diamond' ? 300 + Math.floor(rnd() * 200) : 20 + Math.floor(rnd() * 40) } });
      push({ type: 'custom', level: 'rift', name: 'match_end', attrs: { hero: ['ember', 'frost'][Math.floor(rnd() * 2)], won: rnd() < (props.rank === 'gold' ? 0.7 : 0.45), duration_s: 900 + Math.floor(rnd() * 900) } });
      push({ type: 'level_complete', level: 'rift', duration_s: 1200 });
    }
    if (cls === 'necromancer' && n % 2 === 0) {
      push({ type: 'error', kind: 'js', message: 'TypeError: minion is undefined', fn: 'raise', fingerprint: 'fp-minion' });
      events.push({ ...base, level: null, type: 'session_end', ts: ts + 100 });
    } else push({ type: 'session_end' });
    out.push(events);
  }
  return out;
}

const play = rift();
const events = play.flat().sort((a, b) => a.ts - b.ts);
const ctxOf = (extra = {}, list = events) => buildContext(list, q(extra));
const board = (panels, ctx = ctxOf()) => evaluateBoard(ctx, validateBoard({ panels }));
const finalRank = (list) => [...list].reverse().find((e) => e.props?.rank)?.props.rank;
const sessionsWith = (fn) => play.filter(fn).length;

test('intake checks properties as the SDKs do: keys, reserved and identifying names, value shapes', () => {
  const { events: raw } = parsePayload({
    service: 'rift',
    session_id: 's_check',
    events: [
      { type: 'session_start', ts: NOW, props: { rank: 'gold', region: 'eu-west', level_band: '30-39', email: 'a@b.co', platform: 'pc', Rank: 'x', mode: 'see https://x.io', code: 'aGVsbG8Xd29ybGQ1', season: 'summer_2026', ok: true, n: 12, frac: 1.5, big: 2_000_000, gone: null } },
      { type: 'props', ts: NOW + 1, props: { rank: null, user_id: 'u1', phone: '+44 20 7946 0958', tier: '555-123-4567', band: '3000-3499' } },
      { type: 'props', ts: NOW + 2, props: { email: 'x' } },
    ],
  });
  const stored = normalize({ envelope: { service: 'rift', session_id: 's_check', player_id: 's_check', env: 'dev', version: '1' }, events: raw }, NOW);
  assert.deepEqual(stored[0].props, { rank: 'gold', region: 'eu-west', level_band: '30-39', season: 'summer_2026', ok: true, n: 12 });
  assert.deepEqual(stored[1].props, { rank: null, band: '3000-3499' });
  assert.equal(stored.length, 2, 'a props event with nothing left is dropped');
});

test('a session keeps the latest value of each key by time, however its events are folded and merged', () => {
  const list = play[0];
  const whole = finalizeSession(foldSessions(list).get('s_0'));
  const half = Math.floor(list.length / 2);
  const [a, b] = [foldSessions(list.slice(half)).get('s_0'), foldSessions(list.slice(0, half)).get('s_0')];
  const merged = finalizeSession(mergeSession(sessionFromJSON(JSON.parse(JSON.stringify(sessionToJSON(a)))), b));
  assert.deepEqual(merged.prop, whole.prop);
  assert.equal(whole.prop.rank, 'master', 'the session changed rank part way');
  assert.equal(whole.prop.class, 'druid');
});

test('$<property> splits breakdowns, series, rates, distributions and hours played; sessions without it are (none)', () => {
  const [byRank, byPreset, wins, waits, hours, overTime] = board([
    { type: 'breakdown', by: '$rank' },
    { type: 'breakdown', event: 'match_end', by: '$preset' },
    { type: 'breakdown', event: 'match_end', by: '$rank', rate: 'won', min: 1 },
    { type: 'distribution', event: 'queue', of: 'wait_s', by: '$rank' },
    { type: 'breakdown', event: 'match_end', by: '$class', per: '$hours' },
    { type: 'series', event: 'match_end', by: '$class' },
  ]);
  for (const rank of [...RANKS, 'master']) assert.equal(byRank.rows.find((r) => r.value === rank)?.sessions ?? 0, sessionsWith((l) => finalRank(l) === rank), rank);
  assert.equal(byRank.split, 'rank');
  assert.equal(byPreset.rows.find((r) => r.value === '(none)').count, sessionsWith((l) => !l[0].props.preset) * 3);
  const gold = events.filter((e) => e.name === 'match_end' && finalRank(play[Number(e.session_id.slice(2))]) === 'gold');
  assert.deepEqual([wins.rows.find((r) => r.value === 'gold').events, wins.from], [gold.length, 'sessions']);
  assert.equal(wins.rows.find((r) => r.value === 'gold').rate, Math.round((gold.filter((e) => e.attrs.won).length / gold.length) * 1000) / 10);
  assert.ok(waits.rows.find((r) => r.value === 'diamond').p50 >= 300, 'diamond players wait longest');
  assert.ok(hours.rows.every((r) => r.hours > 0 && r.per_hour > 0));
  assert.deepEqual(overTime.series.map((s) => s.label).sort(), CLASSES);
});

test('a property with more than 200 values a day is an ID: its split says so, and the events query names it', () => {
  const many = Array.from({ length: 230 }, (_, i) => [
    { type: 'session_start', ts: NOW - 3_600_000 + i, service: 'rift', env: 'prod', version: '1.4', session_id: `id_${i}`, player_id: `id_${i}`, level: null, props: { lobby: `lobby_${i}` } },
  ]).flat();
  const ctx = ctxOf({}, [...events, ...many]);
  const [split] = board([{ type: 'breakdown', by: '$lobby' }], ctx);
  assert.deepEqual(split.rows.map((r) => [r.value, r.sessions]), [['(too many values)', 230], ['(none)', play.length]]);
  assert.equal(propertyList(ctx).find((p) => p.key === 'lobby').identifier_like, true);
  // A split shows 40 values, the rest as (other).
  const wide = Array.from({ length: 60 }, (_, i) => ({ type: 'session_start', ts: NOW - 3_600_000 + i, service: 'rift', env: 'prod', version: '1.4', session_id: `w_${i}`, player_id: `w_${i}`, level: null, props: { skin: `skin_${i % 50}` } }));
  const [skins] = board([{ type: 'breakdown', by: '$skin', limit: 20 }], ctxOf({}, wide));
  assert.equal(skins.rows.length + skins.more, 41, '40 values and (other)');
});

test('prop.<key>= filters every query, and a board page shows only its `where`', async () => {
  const filtered = ctxOf({ props: { rank: ['diamond', 'master'] } });
  assert.equal(filtered.sessions.size, sessionsWith((l) => ['diamond', 'master'].includes(finalRank(l))));
  const none = ctxOf({ props: { preset: ['(none)'] } });
  assert.equal(none.sessions.size, sessionsWith((l) => !l[0].props.preset));
  const spec = validateDashboard({ pages: [{ id: 'high', title: 'Diamond and up', where: { $rank: ['diamond', 'master'] }, panels: [{ type: 'stat', metric: 'sessions' }] }] });
  assert.deepEqual(spec.pages[0].where, { $rank: ['diamond', 'master'] });
  assert.throws(() => validateDashboard({ pages: [{ id: 'x', title: 'X', where: { $email: 'a' }, panels: [{ type: 'stat', metric: 'sessions' }] }] }), /a property/);
  assert.throws(() => validateDashboard({ pages: [{ id: 'x', title: 'X', where: { $rank: [] }, panels: [{ type: 'stat', metric: 'sessions' }] }] }), /1 to 20 values/);
});

test('performance by property; retention and versions by property', () => {
  const ctx = ctxOf();
  const perf = performance(ctx, { byProp: 'preset' });
  const ultra = perf.by_prop.rows.find((r) => r.key === 'ultra');
  const high = perf.by_prop.rows.find((r) => r.key === 'high');
  assert.ok(ultra.p95 > 40 && high.p95 < 20, `${ultra.p95} against ${high.p95}`);
  assert.equal(perf.by_prop.rows.find((r) => r.key === 'low').crash_free_pct, 100);
  const r = retention(ctx, { by: 'class' });
  assert.deepEqual(r.by.rows.map((x) => x.value).sort(), CLASSES);
  assert.equal(r.by.rows.reduce((n, x) => n + x.new_players, 0), r.new_players);
  const stats = [{ type: 'stat', event: 'match_end', rate: 'won' }, { type: 'stat', metric: 'crash_free_pct' }, { type: 'stat', event: 'queue', of: 'wait_s', quantile: 50 }, { type: 'stat', event: 'match_end', per: '$hours' }];
  const byClass = versions(ctx, { stats, by: 'class' });
  assert.deepEqual(byClass.map((v) => v.version).sort(), CLASSES);
  const necro = byClass.find((v) => v.version === 'necromancer');
  assert.ok(necro.board[1] < 100 && byClass.find((v) => v.version === 'druid').board[1] === 100, 'crashes are the necromancers');
  assert.ok(necro.board.every((x) => x != null), JSON.stringify(necro.board));
});

test('findings name a property when most of a problem falls on one value, and a setting that runs slow', () => {
  const list = findings(ctxOf());
  const crash = list.find((f) => f.id === 'error-fp-minion');
  assert.deepEqual([crash.evidence.property.key, crash.evidence.property.value, crash.evidence.property.share_pct], ['class', 'necromancer', 100]);
  assert.match(crash.summary, /Most of it falls on class necromancer: 100% of the sessions it hit, against 33\.\d% of all sessions\./);
  const slow = list.find((f) => f.id === 'perf-prop-preset');
  assert.ok(slow, list.map((f) => f.id).join(', '));
  assert.match(slow.title, /Frame time on preset ultra is 4\d(\.\d)? ms for the slowest 5% of frames, against 1\d(\.\d)? ms on the rest/);
  // Finding 12's group half, off the game's board: diamond players wait far longer.
  const dash = validateDashboard({ pages: [{ id: 'q', title: 'Queue', panels: [{ type: 'distribution', event: 'queue', of: 'wait_s', by: '$rank', unit: 's' }] }] });
  const waits = findings({ ...ctxOf(), dashboard: dash }).find((f) => f.id === 'shift-queue-wait_s-rank-diamond');
  assert.ok(waits, 'diamond players wait twice as long');
  assert.match(waits.title, /1 in 10 with rank diamond is over \d+ minutes, against \d+ seconds for the rest/);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: property splits, filters and a page's where answer as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    // The last 30 hours of the data, wherever the clock is: a window ending now held fewer sessions the later in the
    // UTC day the test ran (the data ends at 13:00 the day before), and none of them ultra by the afternoon.
    const END = Math.max(...play.map((l) => l.at(-1).ts)) + 60_000;
    const recent = play.filter((l) => l[0].ts > END - 30 * 3_600_000);
    const PANELS = [
      { type: 'stat', metric: 'sessions' },
      { type: 'breakdown', by: '$rank' },
      { type: 'breakdown', event: 'match_end', by: '$class', rate: 'won', min: 1 },
      { type: 'distribution', event: 'queue', of: 'wait_s', by: '$rank' },
    ];
    try {
      for (const list of recent) {
        const { service, env, version, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      await call('PUT', '/v1/dashboard?service=rift', { pages: [{ id: 'all', title: 'All', panels: PANELS }, { id: 'high', title: 'Diamond and up', where: { $rank: ['diamond', 'master'] }, panels: PANELS }] });
      const range = `service=rift&from=${END - 30 * 3_600_000}&to=${END}`;
      const flat = recent.flat().sort((a, b) => a.ts - b.ts);
      for (const [page, props] of [['all', null], ['high', { rank: ['diamond', 'master'] }]]) {
        const { meta, board: got } = await call('GET', `/v1/query/board?${range}&page=${page}`);
        const raw = buildContext(flat.filter((e) => e.ts >= meta.from && e.ts <= meta.to), q({ from: meta.from, to: meta.to, ...(props ? { props } : {}) }));
        assert.deepStrictEqual(JSON.parse(JSON.stringify(got.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels: PANELS })))), page);
        if (props) assert.deepEqual(meta.where, { 'prop.rank': ['diamond', 'master'] });
      }
      const ov = await call('GET', `/v1/query/overview?${range}&prop.class=druid`);
      assert.equal(ov.kpis.sessions, recent.filter((l) => l[0].props.class === 'druid').length);
      const perf = await call('GET', `/v1/query/performance?${range}&by_prop=preset`);
      assert.ok(perf.by_prop.rows.find((r) => r.key === 'ultra').p95 > 40);
      const ev = await call('GET', `/v1/query/events?${range}`);
      assert.deepEqual(ev.properties.map((p) => p.key).sort(), ['class', 'preset', 'rank']);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
