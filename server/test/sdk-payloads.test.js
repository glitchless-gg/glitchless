// Each SDK's own genre payloads (docs/design/genre-coverage.md A5 to A9) through intake, on every store: the browser SDK
// and the Node server SDK played here as a small match, the GameMaker SDK's GML run in Node, and what the Godot, Unity
// and Unreal SDKs sent in their own tests (fixtures/sdk-payloads, each with a note on the run it was captured from:
// `GLITCHLESS_CAPTURE=<file>` on godot/test/e2e.mjs, on the Unity package's NetcodeTests, and on the Unreal plugin's
// core). Every batch is sent to /v1/intake as the SDK sent it, and each store's answers (counters, properties, groups
// and level attributes, zones, network windows and disconnects, and servers under the companion service) must match
// what the raw events give.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/analytics.js';
import { parsePayload, normalize, FEATURES, companionOf } from '../src/ingest.js';
import { validateBoard, evaluateBoard } from '../src/board.js';
import { matchList } from '../src/matches.js';
import { serversView } from '../src/servers.js';
import { STORES } from './helpers/stores.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures/sdk-payloads');

// ───────────────────────────── a recording intake ─────────────────────────────

// Takes every batch as an SDK sends it (gunzipped), answering /v1/health with what intake folds.
async function recorder() {
  const batches = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (url.pathname === '/v1/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, features: FEATURES }));
      if (url.pathname === '/v1/intake') {
        let buf = Buffer.concat(chunks);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        batches.push(JSON.parse(buf.toString('utf8')));
        return res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":1}');
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, batches, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── the browser and Node SDKs ─────────────────────────────

// Two browser players and their Node server in one match: properties, a group with attributes, a level with attributes
// (a list among them), a zone, counters with a summed number, network samples, a kick (disconnect) and the server's own
// windows with its ticks and players.
async function webMatch(intake) {
  globalThis.document ??= { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
  globalThis.location ??= { origin: 'http://localhost:5185', pathname: '/' };
  const { Glitchless } = await import('../../packages/sdk/src/core.js');
  const { GlitchlessServer } = await import('../../packages/sdk/src/server.js');
  const service = 'web-duel';
  const server = new GlitchlessServer({ service, version: '1.0.0', intake, tickHz: 20, maxPlayers: 2, region: 'eu-west', timers: false, crashes: false, crashDir: null });
  const players = [0, 1].map(() => {
    const gd = new Glitchless({ service, version: '1.0.0', intake, properties: { mode: 'duel', region: 'eu-west' } });
    gd.startedAt -= 5000;
    gd.checkFeatures();
    return gd;
  });
  await Promise.all(players.map((gd) => gd.featuresCheck));
  await server.featuresCheck;
  const match = 'match-' + Math.random().toString(36).slice(2, 10);
  server.setGroup('match', match, { mode: 'duel', players: 2 });
  server.levelStart('arena_7', { mode: 'duel' });
  server.setPlayers(2);
  players.forEach((gd, i) => {
    gd.setGroup('match', match, { mode: 'duel' });
    gd.levelStart('arena_7', { mode: 'duel', hero: i ? 'frost' : 'ember', loadout: ['bow', 'dash'] });
    gd.setZone('north_bridge');
  });
  let clock = 1000;
  for (let step = 0; step < 40; step++) {
    server.tick(8 + (step % 5));
    if (step % 5 === 0) server.playerPing(30 + step);
    for (const [i, gd] of players.entries()) {
      for (let f = 0; f < 3; f++) gd.tick((clock += 16.7));
      gd.count('shot', { weapon: 'bow' });
      if (step % 3 === 0) gd.count('hit', { weapon: 'bow', damage: 12 });
      if (step % 10 === 0) gd.netSample({ rtt_ms: 40 + i * 30 + step, loss_pct: 0.2, jitter_ms: 2, transport: 'ws' });
    }
    await settle(5);
  }
  players[0].setProperties({ rank: 'gold' });
  players[1].disconnect({ reason: 'kicked' });
  players[0].track('match_end', { won: true, duration_s: 2.4, items: ['boots', 'blink'] });
  players[0].levelComplete('arena_7');
  players[0].setGroup('match', null);
  server.setGroup('match', null);
  for (const gd of players) {
    gd.closeWindow();
    gd.flush();
  }
  server.closeWindow();
  await server.close();
  await settle(300);
  return service;
}

// ───────────────────────────── the GameMaker SDK ─────────────────────────────

async function gamemakerRun(intake) {
  const { launch } = await import('../../gamemaker/test/runtime.mjs');
  const service = 'gm-pit';
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-gm-payloads-'));
  const game = launch({ saveDir, args: ['-glitchless'], rooms: ['rm_boot', 'rm_pit'] });
  game.call('glitchless_init', service, '1.2.0', 'dev', intake, game.struct({ properties: game.struct({ class: 'druid', mode: 'pit' }) }));
  await game.settle();
  await game.frames(2);
  game.call('glitchless_level_start', 'nmd_ghoa', game.struct({ tier: 'pit_80', party_size: 3, build: ['blood_surge', 'corpse_explosion'] }));
  game.call('glitchless_set_group', 'match', 'm-8f2c-4410-aa', game.struct({ mode: 'squads' }));
  game.call('glitchless_set_group', 'party', 'party_0042_x');
  await game.frames(70, {
    during: (g) => {
      g.call('glitchless_count', 'kill', g.struct({ monster: 'elite' }));
      g.call('glitchless_count', 'gold', g.struct({ source: 'loot', amount: 35 }));
    },
  });
  game.call('glitchless_set_zone', 'docks');
  await game.frames(300, { during: (g) => g.state.now % 1000 < 17 && g.call('glitchless_net_sample', 40 + (g.state.now % 7), 0.5) });
  game.call('glitchless_set_properties', game.struct({ class: 'necromancer' }));
  game.call('glitchless_disconnect', 'timeout');
  await game.frames(30);
  game.call('glitchless_reconnect');
  await game.frames(30);
  game.call('glitchless_level_complete', 'nmd_ghoa');
  game.call('glitchless_flush');
  await game.settle();
  fs.rmSync(saveDir, { recursive: true, force: true });
  return service;
}

// ───────────────────────────── the batches ─────────────────────────────

// sdk → { services, batches }: what each SDK sent, as it sent it.
const SENT = new Map();

before(async () => {
  const rec = await recorder();
  try {
    const web = await webMatch(rec.url);
    SENT.set('web', { service: web, batches: rec.batches.splice(0) });
    const gm = await gamemakerRun(rec.url);
    SENT.set('gamemaker', { service: gm, batches: rec.batches.splice(0) });
  } finally {
    await rec.close();
  }
  for (const f of fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.json')) : []) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    SENT.set(fixture.sdk, { service: fixture.service, batches: fixture.batches, captured: fixture.captured });
  }
});

// The events intake stores from a batch, as the raw path reads them.
function stored(batches) {
  return batches.flatMap((b) => normalize(parsePayload(b))).sort((a, b) => a.ts - b.ts);
}

// Batches moved so their last event is two minutes ago: captured ones from hours or days ago (a store files anything
// older than a week under "now"), and this run's, which a store answering in whole minutes up to its compactor would
// not have yet.
function shifted(batches, now = Date.now()) {
  const last = Math.max(...batches.flatMap((b) => b.events.map((e) => e.ts)).filter(Number.isFinite));
  const by = now - 120_000 - last;
  const move = (e) => ({ ...e, ts: e.ts + by, ...(e.first_ts ? { first_ts: e.first_ts + by } : {}), ...(e.counts ? { counts: e.counts.map((c) => ({ ...c, ...(c.first_ts ? { first_ts: c.first_ts + by } : {}) })) } : {}), ...(e.pts ? { pts: e.pts.map(([t, ...r]) => [t + by, ...r]) } : {}) });
  return batches.map((b) => ({ ...b, events: b.events.map(move) }));
}

test('every SDK sent the genre additions: counters, properties, groups, level attributes, zones, network and servers', () => {
  assert.ok(SENT.size >= 2, [...SENT.keys()].join(', '));
  for (const [sdk, { batches }] of SENT) {
    const events = batches.flatMap((b) => b.events);
    const has = (type) => events.some((e) => e.type === type);
    assert.ok(has('counts') || sdk === 'unreal-server', `${sdk}: counts`);
    assert.ok(events.some((e) => e.type === 'session_start' && e.props) || sdk.endsWith('server'), `${sdk}: properties`);
    assert.ok(has('group') || events.some((e) => e.match), `${sdk}: groups`);
    assert.ok(events.some((e) => e.type === 'frame_window' && e.net) || batches.some((b) => b.role === 'server'), `${sdk}: network or server mode`);
  }
});

const PANELS = [
  { type: 'stat', metric: 'sessions' },
  { type: 'events' },
  { type: 'breakdown', by: '$mode' },
  { type: 'levels', by: 'mode' },
  { type: 'net', show: 'ping' },
  { type: 'net', show: 'disconnects' },
  { type: 'stat', metric: 'ping_p95' },
  { type: 'stat', metric: 'disconnect_pct' },
  { type: 'servers', show: 'ticks', by: 'players' },
  { type: 'stat', metric: 'server_tick_p95' },
];

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: each SDK's payloads go through intake and answer as their raw events do`, async () => {
    const { store, close: closeStore, settle: settleStore } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    try {
      // Every SDK's events end two minutes ago: a store that answers in whole minutes up to its compactor (the lake) has them.
      const sent = new Map([...SENT].map(([sdk, x]) => [sdk, { ...x, batches: shifted(x.batches) }]));
      for (const [sdk, { batches }] of sent) {
        for (const b of batches) {
          const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: zlib.gzipSync(JSON.stringify(b)) });
          const body = await res.json();
          assert.equal(res.status, 202, `${sdk}: ${JSON.stringify(body)}`);
          assert.equal(body.accepted, normalize(parsePayload(b)).length, `${sdk}: every event of the batch is taken`);
        }
      }
      await settleStore?.();
      const { services } = await call('GET', '/v1/query/services');
      for (const [sdk, { service, batches }] of sent) {
        const listed = services.find((s) => s.service === service);
        assert.ok(listed, `${sdk}: ${service} is listed`);
        if (batches.some((b) => b.role === 'server')) assert.equal(listed.server?.service, companionOf(service), `${sdk}: its server goes under the game`);
        await call('PUT', `/v1/dashboard?service=${service}`, { pages: [{ id: 'genre', title: 'Genre', panels: PANELS }] });
        const now = Date.now();
        const range = `service=${service}&from=${now - 8 * 86_400_000}&to=${now + 3_600_000}`;
        const { meta, board } = await call('GET', `/v1/query/board?${range}&page=genre`);
        const all = stored(batches);
        const inRange = (list) => list.filter((e) => e.ts >= meta.from && e.ts <= meta.to);
        const q = (svc) => ({ service: svc, from: meta.from, to: meta.to, type: 'all' });
        const raw = buildContext(inRange(all.filter((e) => e.service === service)), q(service));
        const companion = inRange(all.filter((e) => e.service === companionOf(service)));
        if (companion.length) raw.server = buildContext(companion, q(companionOf(service)));
        assert.deepStrictEqual(JSON.parse(JSON.stringify(board.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels: PANELS })))), sdk);
        // What each part reads, by SDK.
        const panel = (i) => board.panels[i];
        const events = all.filter((e) => e.service === service);
        if (events.some((e) => e.type === 'counts')) assert.ok(panel(1).events.some((e) => e.counted), `${sdk}: a counter is marked counted`);
        if (events.some((e) => e.type === 'session_start' && e.props?.mode)) assert.ok(!panel(2).empty && panel(2).rows.some((r) => r.value !== '(none)'), `${sdk}: sessions split by $mode`);
        if (events.some((e) => e.type === 'frame_window' && e.net?.rtt?.n && !e.net.host)) assert.ok(panel(6).value > 0, `${sdk}: ping from its network windows`);
        if (events.some((e) => e.type === 'disconnect')) assert.ok(panel(5).reasons.length > 0, `${sdk}: disconnects by reason`);
        const matches = await call('GET', `/v1/query/matches?${range}`);
        assert.deepStrictEqual(matches.matches, JSON.parse(JSON.stringify(matchList(raw).matches)), `${sdk}: matches`);
        if (events.some((e) => e.match)) assert.ok(matches.total >= 1, `${sdk}: its match is listed`);
        if (companion.length) {
          const view = await call('GET', `/v1/query/servers?${range}`);
          const want = serversView(raw);
          assert.deepStrictEqual([view.kpis.servers, view.kpis.tick_p95, view.by_players], JSON.parse(JSON.stringify([want.kpis.servers, want.kpis.tick_p95, want.by_players])), `${sdk}: servers`);
          assert.ok(view.kpis.servers >= 1 && view.kpis.windows > 0, `${sdk}: server windows`);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}

