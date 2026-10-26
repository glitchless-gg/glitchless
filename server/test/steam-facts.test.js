// Steam facts (SPEC §4c): a game that uses Steamworks sends its Steam build, beta branch, Steam hardware and the
// rest with session_start's device. They are kept in one shape at intake, filter any query (steam_branch=beta),
// split breakdowns and performance, and compare Steam branches or builds as versions are compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { normalize, steamDevice } from '../src/ingest.js';
import { buildContext, sessionContext, performance, overview, versions, sessionsList, platformOf, steamWhere } from '../src/analytics.js';
import { validateBoard, evaluateBoard, BoardError } from '../src/board.js';
import { foldDay, dayParts, dayFromParts, mergeDays, dailyPerformance } from '../src/daily.js';
import { indexSessions } from '../src/analytics.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { STORES } from './helpers/stores.js';

const DAY = 86_400_000;
const NOW = Date.now();
const START = NOW - 2 * 3_600_000;
const SERVICE = 'skyline';

// Ten Steam sessions, half on the public branch (build 2001) and half on a beta (2002) whose frames are slower,
// one on a Steam Deck and one on a Steam Machine, and two sessions from outside Steam (no Steamworks).
function steamGame({ start = START } = {}) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const steam = i < 10;
    const beta = steam && i % 2 === 1;
    const base = { service: SERVICE, env: 'prod', version: steam ? (beta ? 'steam-2002' : 'steam-2001') : '1.0.0', session_id: `st${i}`, player_id: `st${i}`, level: null };
    let ts = start + i * 120_000;
    const at = () => (ts += 5_000);
    const device = { browser: 'Unity', os: i === 2 ? 'SteamOS' : 'Windows', gpu_tier: 'mid', steam_deck: i === 2 };
    if (steam) Object.assign(device, { steam_build: beta ? 2002 : 2001, steam_branch: beta ? 'beta' : 'public', steam_hardware: i === 2 ? 'deck' : i === 4 ? 'machine' : 'none', proton: i === 2, big_picture: i === 2, family_shared: i === 6, timed_trial: false, steam_controller: i === 2 ? 'steam_deck' : 'xbox_one', steam_language: 'english' });
    const events = [{ type: 'session_start', ts: at(), session_type: 'user', device }];
    for (let w = 0; w < 4; w++) {
      const sk = new Sketch();
      for (let f = 0; f < 300; f++) sk.add(beta ? 30 : 15);
      events.push({ type: 'frame_window', ts: at(), level: 'run', frames: 300, fps: beta ? 33 : 66, budget_ms: 16.67, ft: sk.toJSON(), hitches: beta ? 2 : 0, frozen: 0 });
    }
    events.push({ type: 'custom', ts: at(), name: 'play', attrs: { mode: i % 3 ? 'arcade' : 'story' } });
    if (beta) events.push({ type: 'custom', ts: at(), name: 'play', attrs: { mode: 'arcade' } });
    if (i % 4 === 0) events.push({ type: 'custom', ts: at(), name: 'buy', attrs: { amount: 5, currency: 'USD' } });
    events.push({ type: 'session_end', ts: at(), reason: 'quit' });
    out.push(events.map((e) => ({ ...base, ...e })));
  }
  return out;
}

const events = steamGame().flat();
const q = (extra = {}) => ({ service: SERVICE, from: START - 60_000, to: NOW, type: 'all', ...extra });
const ctxOf = (extra) => buildContext(events, q(extra));

test('intake keeps Steam facts in one shape, and a Steam Deck by Steamworks is a Steam Deck', () => {
  const d = steamDevice({ os: 'Windows', steam_deck: false, steam_build: '20231', steam_branch: '  beta  ', steam_hardware: 'deck', proton: 'yes', big_picture: true, steam_controller: '', steam_language: 'french', family_shared: 1 });
  assert.deepStrictEqual(d, { os: 'Windows', steam_deck: true, steam_build: 20231, steam_branch: 'beta', steam_hardware: 'deck', big_picture: true, steam_language: 'french' });
  assert.equal(steamDevice({ steam_build: 0 }).steam_build, undefined, 'build 0 is not a Steam build');
  assert.equal(steamDevice({ steam_build: -4 }).steam_build, undefined);
  assert.equal(steamDevice({ steam_hardware: 'toaster' }).steam_hardware, undefined);
  assert.deepStrictEqual(steamDevice({ os: 'Linux', steam_deck: true }), { os: 'Linux', steam_deck: true }, 'a device without Steam facts is as it was');
  const [e] = normalize({ envelope: { service: SERVICE, env: 'prod', version: '1', session_id: 'a', player_id: 'a' }, events: [{ type: 'session_start', ts: NOW, device: { steam_hardware: 'frame', steam_build: 7 } }] }, NOW);
  assert.deepStrictEqual(e.device, { steam_hardware: 'frame', steam_build: 7 });
});

test('the platform is Valve hardware when Steamworks names it, else the Steam Deck tag, else the OS', () => {
  assert.equal(platformOf({ os: 'Windows', steam_hardware: 'machine' }), 'Steam Machine');
  assert.equal(platformOf({ os: 'Android', steam_hardware: 'frame' }), 'Steam Frame');
  assert.equal(platformOf({ os: 'Windows', steam_hardware: 'deck' }), 'Steam Deck');
  assert.equal(platformOf({ os: 'SteamOS', steam_deck: true, steam_hardware: 'none' }), 'Steam Deck', 'the SDK tag still finds a Deck');
  assert.equal(platformOf({ os: 'Windows', steam_hardware: 'none' }), 'Windows');
});

test('a Steam filter keeps only the sessions with that fact, in every query', () => {
  assert.deepStrictEqual(steamWhere(new URLSearchParams('steam_branch=beta&steam_build=&os=Linux')), { steam_branch: 'beta' });
  assert.equal(steamWhere(new URLSearchParams('version=1')), null);
  const all = ctxOf();
  const beta = ctxOf({ where: { steam_branch: 'beta' } });
  assert.equal(all.sessions.size, 12);
  assert.equal(beta.sessions.size, 5);
  assert.ok([...beta.sessions.values()].every((s) => s.device.steam_branch === 'beta'));
  assert.equal(overview(beta).kpis.frame_p95, overview(ctxOf({ version: 'steam-2002' })).kpis.frame_p95, 'frame times are those of the beta sessions only');
  assert.ok(overview(beta).kpis.frame_p95 > overview(ctxOf({ where: { steam_branch: 'public' } })).kpis.frame_p95);
  assert.equal(ctxOf({ where: { steam_build: '2001' } }).sessions.size, 5, 'builds compare as text');
  assert.equal(ctxOf({ where: { steam_hardware: 'deck' } }).sessions.size, 1);
  assert.equal(ctxOf({ where: { family_shared: 'true' } }).sessions.size, 1, 'flags compare as true or false');
  assert.equal(ctxOf({ where: { steam_branch: 'beta', steam_hardware: 'machine' } }).sessions.size, 0, 'every fact asked for must match');
  const [row] = sessionsList(ctxOf({ where: { steam_hardware: 'deck' } }));
  assert.deepStrictEqual([row.steam_build, row.steam_branch, row.steam_hardware, row.steam_deck], [2001, 'public', 'deck', true]);
});

test('performance breaks frame times down by Steam branch, build and hardware', () => {
  const p = performance(ctxOf());
  assert.deepStrictEqual(p.by_steam_branch.map((g) => [g.key, g.sessions]), [['public', 5], ['beta', 5]], 'only sessions that read it from Steamworks');
  assert.deepStrictEqual(p.by_steam_build.map((g) => g.key), ['2001', '2002']);
  const beta = p.by_steam_branch.find((g) => g.key === 'beta');
  const pub = p.by_steam_branch.find((g) => g.key === 'public');
  assert.ok(beta.p95 > pub.p95 && beta.hitches > pub.hitches);
  assert.deepStrictEqual(p.by_platform.map((g) => g.key).sort(), ['Steam Deck', 'Steam Machine', 'Windows']);
});

test('Steam branches and builds are compared as versions are, on the board\'s stats', () => {
  const stats = [{ type: 'stat', metric: 'frame_p95' }, { type: 'stat', event: 'play' }, { type: 'stat', event: 'buy', per: '$sessions' }, { type: 'stat', event: 'buy', sum: 'amount' }, { type: 'stat', event: 'play=story', per: 'play' }];
  const list = versions(ctxOf(), { stats, by: 'steam_branch' });
  assert.deepStrictEqual(list.map((v) => [v.version, v.sessions]), [['public', 5], ['beta', 5]], 'the non-Steam sessions are left out');
  const [pub, beta] = list;
  assert.ok(beta.frame_p95 > pub.frame_p95);
  assert.equal(beta.board[0], beta.frame_p95);
  assert.deepStrictEqual([pub.board[1], beta.board[1]], [1, 2], 'plays per session');
  // Sessions 0, 4 and 8 bought, all on public: 3 of 5.
  assert.deepStrictEqual([pub.board[2], beta.board[2]], [60, 0]);
  assert.deepStrictEqual([pub.board[3], beta.board[3]], [null, null], 'sums are not split by Steam facts');
  assert.ok(pub.board[4] > 0);
  assert.deepStrictEqual(Object.keys(pub.events), ['play', 'buy']);
  assert.deepStrictEqual(versions(ctxOf(), { by: 'steam_build' }).map((v) => v.version), ['2001', '2002']);
  assert.deepStrictEqual(versions(ctxOf({ where: { steam_hardware: 'deck' } }), { by: 'steam_branch' }).map((v) => v.version), ['public']);
});

test('boards split breakdowns by a Steam fact and compare branches, and say what a Steam fact cannot split', () => {
  const board = validateBoard({
    panels: [
      { type: 'stat', metric: 'frame_p95' },
      { type: 'stat', event: 'play' },
      { type: 'breakdown', event: 'play', by: '$steam_branch' },
      { type: 'breakdown', event: 'play=arcade', by: '$steam_hardware' },
      { type: 'versions', by: '$steam_branch' },
      { type: 'versions' },
    ],
  });
  const [, , branch, hardware, cmp, plain] = evaluateBoard(ctxOf(), board);
  assert.equal(branch.title, 'play by Steam branch');
  assert.deepStrictEqual(branch.rows.map((r) => [r.value, r.count, r.sessions]), [['beta', 10, 5], ['public', 5, 5], ['(none)', 2, 2]]);
  assert.equal(hardware.rows.find((r) => r.value === 'none').count, 9, 'arcade plays on no Valve hardware');
  assert.equal(cmp.title, 'By Steam branch');
  assert.equal(cmp.by, 'steam_branch');
  assert.deepStrictEqual(cmp.rows.map((r) => r.version), ['public', 'beta']);
  assert.deepStrictEqual(cmp.columns.map((c) => c.title), ['Frame time p95', 'play']);
  assert.deepStrictEqual(plain.rows.map((r) => r.version), ['steam-2001', 'steam-2002', '1.0.0']);
  const none = evaluateBoard(buildContext(events.filter((e) => !e.session_id.match(/^st\d$/)), q()), validateBoard({ panels: [{ type: 'stat', metric: 'sessions' }, { type: 'versions', by: '$steam_build' }] }))[1];
  assert.equal(none.empty, true);
  assert.match(none.why, /Steam build/);

  assert.throws(() => validateBoard({ panels: [{ type: 'series', event: 'play', by: '$steam_branch' }] }), (e) => e instanceof BoardError && /breakdown/.test(e.message));
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'buy', sum: 'amount', by: '$steam_branch' }] }), /sum can't be split/);
  assert.throws(() => validateBoard({ panels: [{ type: 'versions', by: '$email' }] }), /Steam fact/);
  assert.throws(() => validateBoard({ panels: [{ type: 'breakdown', event: 'play', by: '$email' }] }), /\$steam_branch/);
});

test('day rollups keep Steam branches and builds for performance over long ranges', () => {
  const start = Math.floor(NOW / DAY) * DAY - 3 * DAY;
  const states = [...indexSessions(steamGame({ start }).flat()).values()];
  const day = foldDay(start, { sessions: states });
  const back = dayFromParts(start, JSON.parse(JSON.stringify(dayParts(day).main)));
  const { cells, facts, daily } = mergeDays([back], () => true);
  const ctx = sessionContext({ service: SERVICE, from: start, to: start + DAY - 1, type: 'all' }, new Map());
  Object.assign(ctx, { daily, cells, facts, meta: { approximate: [] }, drill: { hitches: [] } });
  const p = dailyPerformance(ctx);
  assert.deepStrictEqual(p.by_steam_branch.map((g) => [g.key, g.sessions]), [['public', 5], ['beta', 5]]);
  assert.deepStrictEqual(p.by_steam_build.map((g) => g.key), ['2001', '2002']);
  assert.ok(p.by_steam_branch[1].p95 > p.by_steam_branch[0].p95);
  // A breakdown or comparison by a Steam fact needs sessions, which a day context doesn't hold.
  const [cmp] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'versions', by: '$steam_branch' }] }));
  assert.match(cmp.why, /31 days or less/);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: queries take Steam filters, and versions compare Steam branches`, async () => {
    const { store, close: closeStore, settle } = await make();
    const server = http.createServer(createApp({ store, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => (await fetch(base + p)).json();
    try {
      for (const list of steamGame()) {
        const { service, env, version, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      const range = `service=${SERVICE}&from=${START - 3_600_000}&to=${Date.now() + 1}`;
      assert.equal((await get(`/v1/query/overview?${range}`)).kpis.sessions, 12);
      const beta = await get(`/v1/query/overview?${range}&steam_branch=beta`);
      assert.equal(beta.kpis.sessions, 5);
      assert.deepStrictEqual(beta.meta.where, { steam_branch: 'beta' });
      assert.equal((await get(`/v1/query/performance?${range}&steam_hardware=deck`)).by_platform[0].key, 'Steam Deck');
      assert.equal((await get(`/v1/query/sessions?${range}&steam_branch=public&steam_build=2001`)).sessions.length, 5);
      const board = await get(`/v1/query/board?${range}&steam_branch=beta`);
      assert.equal(board.board.panels.find((p) => p.metric === 'sessions').value, 5, 'a board takes the filter too');
      const vs = await get(`/v1/query/versions?${range}&by=steam_branch`);
      assert.equal(vs.by, 'steam_branch');
      assert.deepStrictEqual(vs.versions.map((v) => [v.version, v.sessions]), [['public', 5], ['beta', 5]]);
      assert.deepStrictEqual((await get(`/v1/query/versions?${range}&by=email`)).versions.map((v) => v.version), ['steam-2001', 'steam-2002', '1.0.0'], 'by is a Steam fact, a property, or nothing');
    } finally {
      server.close();
      await closeStore?.();
    }
  });
}
