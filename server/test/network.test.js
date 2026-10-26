// Network quality and disconnects (docs/design/genre-coverage.md A8; SPEC §2 frame_window.net, disconnect, §3b net, §4):
// cells keep ping, lag, loss and disconnects, so they are exact by version, level and zone; sessions split them by
// connection, platform or property. A disconnect ends an attempt as an abandon, never a fail. Findings tell a whole
// lobby lagging from one kind of connection lagging, flag a region far from the servers and disconnects that rose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext, performance, versions } from '../src/analytics.js';
import { rollup, cellList, newCell, mergeCell, cellToJSON, cellFromJSON } from '../src/rollups.js';
import { validateBoard, evaluateBoard } from '../src/board.js';
import { findings } from '../src/findings.js';
import { netStats, lobbySpikes } from '../src/network.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { hashGroupId } from '../../packages/sdk/src/groups.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = Math.floor((NOW - 10 * 3_600_000) / 60_000) * 60_000;
const q = (extra = {}) => ({ service: 'royale', from: START - 60_000, to: NOW, type: 'all', ...extra });

// A battle royale: 16 matches of 8 players on island (4 minutes, a window every 5 s). Every third match lags all at
// once in its third slot (60-90 s: the server). One player in four is on mobile data and lags on their own most of
// the time; two in each match play from oceania at 140 ms. Version 1.3 (matches 0-7) drops one player in 64, 1.4 about
// one in 6, by timeout, 30 s into the match.
function royale() {
  let x = 9;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  for (let m = 0; m < 16; m++) {
    const match = hashGroupId('royale', `match-${String(m).padStart(4, '0')}`);
    const t0 = START + m * 1_800_000;
    const version = m < 8 ? '1.3' : '1.4';
    for (let p = 0; p < 8; p++) {
      const n = m * 8 + p;
      const base = { service: 'royale', env: 'prod', version, session_id: `s_${n}`, player_id: `s_${n}` };
      const mobile = p % 4 === 3;
      const region = p < 2 ? 'oceania' : 'eu';
      const events = [];
      const push = (e) => events.push({ level: null, ...e, ...base });
      push({ type: 'session_start', ts: t0 - 10_000, session_type: 'user', device: { os: p % 2 ? 'Android' : 'Windows' }, props: { region } });
      push({ type: 'group', ts: t0, kind: 'match', id: match, attrs: { mode: 'squads' }, match });
      push({ type: 'level_start', ts: t0 + 10, level: 'island', match });
      const drops = version === '1.3' ? m === 0 && p === 7 : p === 7 || (p === 6 && m % 2);
      const end = drops ? 30_000 : 240_000;
      for (let t = 0; t < end; t += 5000) {
        const slot = Math.floor(t / 30_000);
        const lobby = m % 3 === 0 && slot === 2;
        const base = region === 'oceania' ? 140 : mobile ? (rnd() < 0.7 ? 220 : 60) : 40;
        const rtt = lobby ? base * 3 + 100 : base;
        const sk = new Sketch(0.05);
        for (let i = 0; i < 5; i++) sk.add(rtt + i * 2);
        const ft = new Sketch();
        for (let f = 0; f < 300; f++) ft.add(16);
        push({ type: 'frame_window', ts: t0 + t, level: 'island', match, duration_s: 5, frames: 300, budget_ms: 16.67, ft: ft.toJSON(), hitches: 0, net: { rtt: sk.toJSON(), rtt_p50: rtt + 4, rtt_p95: rtt + 8, rtt_max: rtt + 8, jitter_ms: mobile ? 12 : 2, loss_pct: mobile ? 3 : 0.2, in_kbps: 90, out_kbps: 30, samples: 5, transport: 'ws', link: mobile ? 'cellular' : 'wifi', host: false } });
      }
      if (drops) {
        push({ type: 'disconnect', ts: t0 + 30_000, level: 'island', match, reason: 'timeout', connected_s: 30, rtt_p95: 60, loss_pct: 0.2 });
        push({ type: 'level_abandon', ts: t0 + 30_001, level: 'island', match, reason: 'disconnect' });
        push({ type: 'level_fail', ts: t0 + 30_100, level: 'island', cause: 'storm', match }); // the game's own fail after the drop: dropped by the SDK, but here the server must not take it as one either if it came
      } else push({ type: 'level_complete', ts: t0 + 240_000, level: 'island', match, duration_s: 240 });
      push({ type: 'session_end', ts: t0 + end + 5000 });
      out.push(events.filter((e) => !(drops && e.type === 'level_fail')));
    }
  }
  return out;
}

const play = royale();
const events = play.flat().sort((a, b) => a.ts - b.ts);
const ctxOf = (extra = {}, list = events) => buildContext(list, q(extra));
const board = (panels, ctx = ctxOf()) => evaluateBoard(ctx, validateBoard({ panels }));
const drops = (v) => play.filter((l) => l[0].version === v && l.some((e) => e.type === 'disconnect')).length;
const attempts = (v) => play.filter((l) => l[0].version === v).length;

test('cells keep ping, lag, loss and disconnects, merge exactly in any order, and survive JSON', () => {
  const minutes = [...cellList(rollup(events))];
  const a = newCell();
  for (const { c } of minutes) mergeCell(a, cellFromJSON(JSON.parse(JSON.stringify(cellToJSON(c)))));
  const b = newCell();
  for (const { c } of [...minutes].reverse()) mergeCell(b, c);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cellToJSON(a).net)), JSON.parse(JSON.stringify(cellToJSON(b).net)));
  assert.equal(a.net.dc.timeout, drops('1.3') + drops('1.4'));
  assert.equal(a.net.links.cellular, events.filter((e) => e.net?.link === 'cellular').length);
});

test('the metrics: ping, loss, disconnects per hour played and the share of attempts a disconnect ended', () => {
  const ctx = ctxOf();
  const n = netStats(ctx);
  assert.ok(n.ping_p50 >= 40 && n.ping_p50 < 60, String(n.ping_p50));
  assert.ok(n.ping_p95 > 190);
  const total = drops('1.3') + drops('1.4');
  assert.equal(n.disconnects, total);
  assert.equal(n.disconnect_pct, Math.round((total / play.length) * 1000) / 10);
  const [p95, pct, perHour] = board([{ type: 'stat', metric: 'ping_p95' }, { type: 'stat', metric: 'disconnect_pct' }, { type: 'stat', metric: 'disconnects_per_hour' }], ctx);
  assert.deepEqual([p95.value, p95.unit], [n.ping_p95, 'ms']);
  assert.equal(pct.value, n.disconnect_pct);
  assert.equal(perHour.unit, 'per hour');
  // A disconnect ends the attempt as an abandon: never a fail, never a rage quit.
  const [levels] = board([{ type: 'levels' }], ctx);
  const island = levels.rows.find((r) => r.level === 'island');
  assert.deepEqual([island.disconnects, island.fails, island.rage_quits], [total, 0, 0]);
  assert.equal(levels.has.disconnects, true);
  // Version by version.
  const stats = [{ type: 'stat', metric: 'disconnect_pct' }, { type: 'stat', metric: 'ping_p95' }];
  const vs = versions(ctx, { stats });
  assert.deepEqual(vs.map((v) => [v.version, v.board[0]]), [['1.3', Math.round((drops('1.3') / attempts('1.3')) * 1000) / 10], ['1.4', Math.round((drops('1.4') / attempts('1.4')) * 1000) / 10]]);
});

test('the net panel: ping over time and by connection, loss, disconnects by reason; Performance has a network section', () => {
  const [ping, byLink, loss, why, byRegion] = board([
    { type: 'net', show: 'ping' },
    { type: 'net', show: 'ping', by: '$link' },
    { type: 'net', show: 'loss', by: '$version' },
    { type: 'net', show: 'disconnects' },
    { type: 'net', show: 'disconnects', by: '$region' },
  ]);
  assert.equal(ping.title, 'Ping');
  assert.equal(ping.ts.length, ping.p50.length);
  assert.ok(ping.lag_pct.some((v) => v > 0));
  assert.deepEqual(byLink.rows.map((r) => r.value).sort(), ['Mobile data', 'Wi-Fi']);
  const mobile = byLink.rows.find((r) => r.value === 'Mobile data');
  assert.ok(mobile.lag_pct > 40 && byLink.rows.find((r) => r.value === 'Wi-Fi').lag_pct < 25, JSON.stringify(byLink.rows));
  assert.ok(loss.rows.every((r) => r.loss_pct > 0));
  assert.deepEqual(why.reasons.map((r) => [r.reason, r.count]), [['timeout', drops('1.3') + drops('1.4')]]);
  assert.ok(why.reasons[0].per_hour > 0);
  assert.equal(byRegion.rows.find((r) => r.value === 'oceania').sessions, 32);
  const perf = performance(ctxOf());
  assert.deepEqual(perf.network.by_link.map((r) => r.key).sort(), ['Mobile data', 'Wi-Fi']);
  assert.equal(perf.network.by_level[0].key, 'island');
  assert.ok(perf.network.kpis.ping_p95 > 0);
  assert.throws(() => validateBoard({ panels: [{ type: 'net', show: 'speed' }] }), /show is ping, loss, disconnects/);
});

test('findings: the whole lobby lagging (the server), mobile data lagging (players), a far region, disconnects up', () => {
  const spikes = lobbySpikes(ctxOf());
  assert.equal(spikes.filter((m) => m.spikes.length).length, 6);
  const list = findings(ctxOf());
  const lobby = list.find((f) => f.id === 'net-lobby-island');
  assert.ok(lobby, list.map((f) => f.id).join(', '));
  assert.match(lobby.title, /^Whole lobbies on island lag together, most often 1 to 2 minutes in$/);
  assert.equal(lobby.evidence.matches_with_lobby_spike, 6);
  const link = list.find((f) => f.id === 'net-link-mobile-data');
  assert.ok(link, list.map((f) => f.id).join(', '));
  assert.match(link.title, /^Players on mobile data lag [\d.]+× as often as the rest/);
  const region = list.find((f) => f.id === 'net-region-oceania');
  assert.match(region.title, /^Players in oceania reach the servers at 14\d ms for most of their play: no server is near them$/);
  const rise = list.find((f) => f.id === 'disconnect-1.4');
  assert.ok(rise, list.map((f) => f.id).join(', '));
  assert.match(rise.title, /^1 attempt in \d+ ends in a disconnect in 1\.4, against 1 in \d+ in 1\.3$/);
  assert.match(rise.summary, /Most are timeout .* Half of them come within 30 s of the attempt's start\./);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: ping, disconnects and the net panel answer as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const PANELS = [
      { type: 'stat', metric: 'ping_p95' },
      { type: 'stat', metric: 'disconnect_pct' },
      { type: 'net', show: 'ping', by: '$link' },
      { type: 'net', show: 'disconnects', by: '$version' },
      { type: 'levels' },
      { type: 'versions' },
    ];
    try {
      for (const list of play) {
        const { service, env, version, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      await call('PUT', '/v1/dashboard?service=royale', { pages: [{ id: 'net', title: 'Network', panels: PANELS }] });
      const range = `service=royale&from=${START - 60_000}&to=${NOW + 1}`;
      const { meta, board: got } = await call('GET', `/v1/query/board?${range}&page=net`);
      const raw = ctxOf({ from: meta.from, to: meta.to }, events.filter((e) => e.ts >= meta.from && e.ts <= meta.to));
      const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'first_seen_ever' ? undefined : v)));
      assert.deepStrictEqual(plain(got.panels), plain(evaluateBoard(raw, validateBoard({ panels: PANELS }))));
      const perf = await call('GET', `/v1/query/performance?${range}`);
      assert.ok(perf.network.kpis.disconnects > 0);
      const f = await call('GET', `/v1/query/findings?${range}`);
      assert.ok(f.findings.some((x) => x.id === 'net-lobby-island'), f.findings.map((x) => x.id).join(', '));
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
