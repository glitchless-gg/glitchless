// What A5 to A9 give agents (docs/design/genre-coverage.md): every read tool filters by session properties (props →
// prop.<key>=), the funnel splits levels by attempt, events mark counters and list properties, compare_versions compares
// a property's values, and three tools read multiplayer games: glitchless_match (one match from every side, telling a
// lagging lobby from a lagging player), glitchless_network and glitchless_servers. Called over an in-memory MCP
// connection against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-multiplayer-'));
delete process.env.GLITCHLESS_API_KEY;

const NET = { ping_p50: 42, ping_p95: 210, lag_pct: 12.5, loss_pct: 0.4, jitter_ms: 3, connected_h: 20, disconnects: 6, disconnect_reasons: { timeout: 4, server_closed: 2 }, reconnects: 1, disconnects_per_hour: 0.3, hours: 20, disconnect_pct: 4.5 };
const row = (key, extra = {}) => ({ key, ...NET, sessions: 40, ...extra });
const MATCH = {
  id: 'h_d8a6ac978165726ac21a722b',
  from: 1,
  to: 240_001,
  duration_s: 240,
  sessions: 4,
  level: 'island',
  attrs: { mode: 'squads' },
  outcomes: { complete: 3, disconnect: 1 },
  disconnects: 1,
  disconnect_reasons: { timeout: 1 },
  ping_p50: 41,
  ping_p95: 230,
  lag_pct: 20,
  server: { sessions: 1, tick_p95: 40, players_max: 4 },
  slot_s: 30,
  slots: [0, 30, 60, 90, 120, 150, 180, 210],
  // The whole lobby lagged at 60-120 s; player s_2 alone at 180 s.
  sessions_: null,
  lobby_spikes: [60, 90],
  events: [{ t: 200, session_id: 's_3', type: 'disconnect', level: 'island', name: null, reason: 'timeout' }],
};
MATCH.sessions = ['s_0', 's_1', 's_2', 's_3'].map((id) => ({
  session_id: id,
  version: '1.4',
  platform: 'Windows',
  level: 'island',
  outcome: id === 's_3' ? 'disconnect' : 'complete',
  from_s: 0,
  to_s: 240,
  disconnects: id === 's_3' ? [{ t: 200, reason: 'timeout' }] : [],
  ping_p50: 40,
  ping_p95: 230,
  slots: MATCH.slots.map((t) => ({ t, fps: 60, frame_p95: 17, ping_p50: t === 60 || t === 90 || (id === 's_2' && t === 180) ? 220 : 40, ping_p95: 230, loss_pct: 0.1, hitches: 0, ...(t === 60 || t === 90 || (id === 's_2' && t === 180) ? { spike: true } : {}) })),
}));
delete MATCH.sessions_;
MATCH.server = [{ session_id: 'srv_1', budget_ms: 33.33, slots: MATCH.slots.map((t) => ({ t, tick_p95: t === 60 || t === 90 ? 52 : 18, late: 0, players: 4, net_objects: 300 })) }];

const seen = [];
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const name = url.pathname.replace('/v1/query/', '');
  const params = Object.fromEntries(url.searchParams);
  seen.push({ name, params });
  const send = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ meta: { from: 0 }, ...body }));
  if (name === 'services') return send({ services: [{ service: 'arena', last_seen: 1, server: { service: 'arena.server' } }] });
  if (name === 'findings') return send({ findings: [{ id: 'net-lobby-island', category: 'network', severity: 'high', title: 'Whole lobbies on island lag together' }, { id: 'server-tick-island', category: 'performance', severity: 'medium', title: 'Servers on island miss their tick' }, { id: 'error-x', category: 'stability', severity: 'low', title: 'x' }] });
  if (name === 'events') return send({ sessions: 40, hours: 20, events: [{ name: 'kill', counted: true, count: 900, sessions: 40, attrs: [], sums: [] }, { name: 'match_end', count: 40, sessions: 40, attrs: [], sums: [] }], properties: [{ key: 'region', identifier_like: false, values: [{ value: 'eu', sessions: 30, players: null }, { value: 'oceania', sessions: 10, players: null }] }, { key: 'lobby', identifier_like: true, values: [] }] });
  if (name === 'performance') {
    const network = { kpis: NET, by_level: [row('island')], by_version: [row('1.4')], by_platform: [row('Windows')], by_link: [row('Wi-Fi'), row('Mobile data', { lag_pct: 60 })], ...(params.by_prop === 'region' ? { by_prop: { key: 'region', rows: [row('eu'), row('oceania', { ping_p50: 190 })] } } : {}) };
    return send({ kpis: {}, by_level: [], by_gpu_tier: [], by_browser: [], by_version: [], by_platform: [], hitches: [], network, ...(params.by_prop ? { by_prop: { key: params.by_prop, rows: [{ key: 'ultra', sessions: 20, p95: 41, all_sessions: 22, crash_free_pct: 100 }] } } : {}) });
  }
  if (name === 'players') return send({ kpis: {}, funnel: [], session_length: {}, rage_quits: [], retention: { status: 'ok', by: params.by_prop ? { key: params.by_prop, rows: [{ value: 'whale', new_players: 3, d1: 66.7 }] } : undefined }, ...(params.by ? { funnel_by: { by: params.by, rows: [{ level: 'pit', value: 'pit_80', sessions: 12, completion_pct: 25, disconnects: 1 }] } } : {}) });
  if (name === 'matches') return send(params.id ? (params.id === MATCH.id ? { match: MATCH } : { error: `no match ${params.id} in this window` }) : { matches: [{ ...MATCH, slots: undefined, sessions: 4, server: MATCH.server && { sessions: 1, tick_p95: 40, players_max: 4 }, events: undefined }], total: 1, sort: params.sort || 'recent' });
  if (name === 'servers') return send({ servers_now: 2, players_on_servers: 180, kpis: { servers: 6, crashed: 1, crash_free_pct: 83.3, budget_ms: 33.33, tick_p95: 40, over_budget_pct: 12, players: 60 }, by_players: [{ value: '90–99 players', windows: 40, over_budget_pct: 40, tick_p95: 52 }], by_level: [], by_version: [], crashes: [{ fingerprint: 'fp', kind: 'crash', message: 'boom', count: 1, sessions: 1, last_seen: 5, crashed_servers: 1, matches_ended: 1, players_dropped: 90, breadcrumbs: [] }], memory: [], climbing: [], sessions: [] });
  if (name === 'versions') return send({ versions: [{ version: 'druid', sessions: 30, first_seen: 1, crash_free_pct: 100 }, { version: 'necromancer', sessions: 20, first_seen: 2, crash_free_pct: 90 }], has: {}, board: [] });
  if (name === 'dashboard') return send({ dashboard: { source: 'saved', pages: [{ id: 'net', title: 'Network', panels: 1 }], spec: { pages: [] } } });
  if (name === 'board') return send({ board: { page: 'net', title: 'Network', panels: [{ type: 'net', show: 'ping', title: 'Ping', ts: [1, 2, 3], p50: [40, 41, 42], p95: [60, 61, 62], lag_pct: [1, 2, 3], kpis: NET, rows: [{ value: 'eu', ping_p95: 60 }] }, { type: 'servers', show: 'ticks', title: 'Ticks', ts: [1, 2, 3], tick_p95: [1, 2, 3], players: [4, 4, 4], servers: [1, 1, 1], kpis: { tick_p95: 40 }, rows: [] }] } });
  send({});
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.GLITCHLESS_URL = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_SERVICE = 'arena';

const { createServer } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
  return r.content.map((c) => c.text).join('\n');
};

test('every read tool filters by session properties: props become prop.<key>=, a list of values comma-joined', async () => {
  for (const [tool, name] of [['glitchless_triage', 'findings'], ['glitchless_events', 'events'], ['glitchless_performance', 'performance'], ['glitchless_player_funnel', 'players'], ['glitchless_compare_versions', 'versions'], ['glitchless_dashboard', 'board']]) {
    seen.length = 0;
    await call(tool, { props: { rank: ['diamond', 'master'], season: 9 } });
    const q = seen.find((c) => c.name === name);
    assert.deepEqual([q.params['prop.rank'], q.params['prop.season']], ['diamond,master', '9'], tool);
  }
});

test('performance by a property, the funnel by an attempt attribute and retention by a property', async () => {
  seen.length = 0;
  const perf = await call('glitchless_performance', { by_prop: 'preset' });
  assert.equal(seen[0].params.by_prop, 'preset');
  assert.match(perf, /"key": "ultra"/);
  assert.match(perf, /"network"/);
  seen.length = 0;
  const funnel = await call('glitchless_player_funnel', { by: 'tier', level: 'pit', count: 'runs', by_prop: 'spender' });
  assert.deepEqual([seen[0].params.by, seen[0].params.level, seen[0].params.count, seen[0].params.by_prop], ['tier', 'pit', 'runs', 'spender']);
  assert.match(funnel, /Player funnel for arena by tier, counting runs/);
  assert.match(funnel, /"funnel_by"/);
  assert.match(funnel, /"value": "whale"/);
});

test('events mark counters and list the properties; versions compare a property\'s values', async () => {
  const ev = await call('glitchless_events');
  assert.match(ev, /^kill \(counted\): 900 in 40 session\(s\)$/m);
  assert.match(ev, /Session properties: region \(eu, oceania\); lobby \(an ID: too many values\)/);
  seen.length = 0;
  const vs = await call('glitchless_compare_versions', { by: '$class' });
  assert.equal(seen.find((c) => c.name === 'versions').params.by, 'class');
  assert.match(vs, /^arena: class value druid \(30 sessions\) vs necromancer \(20 sessions\)/);
  assert.match(vs, /"all_values"/);
});

test('glitchless_match lists matches, and opens one with a verdict: the whole lobby (the server) or one player (their connection)', async () => {
  seen.length = 0;
  const list = await call('glitchless_match', { sort: 'lag', limit: 5 });
  assert.deepEqual([seen[0].params.sort, seen[0].params.limit], ['lag', '5']);
  assert.match(list, /^1 match\(es\) in arena, the worst by lag first:\n1\. h_d8a6ac978165726ac21a722b on island: 4 players, 4:00, ping p95 230 ms \(20% of play over 150 ms\), 1 disconnects, server tick p95 40 ms/);
  const one = await call('glitchless_match', { id: MATCH.id });
  assert.match(one, /The whole lobby lagged at once at 1:00–2:00: that's the server or its network, not players' connections\. The server's slowest ticks then: 52 ms against a 33\.33 ms budget \(18 ms the rest of the match\)\. 1 player lagged on their own \(their connection\): s_2 at 3:00–3:30\. 1 disconnected \(1 timeout\)\./);
  assert.match(one, /"lagged_alone_at": \[\s+180\s+\]/);
  assert.match(one, /"slow_slots"/);
  assert.doesNotMatch(one, /"fps"/, 'slots stay out unless asked');
  assert.match(await call('glitchless_match', { id: MATCH.id, slots: true }), /"fps": 60/);
  assert.match(await call('glitchless_match', { id: 'h_nothing' }), /^No match h_nothing in arena/);
});

test('glitchless_network: by level, version, platform and connection, by region in the same call, the worst matches and network findings', async () => {
  seen.length = 0;
  const net = await call('glitchless_network');
  assert.match(net, /^Network for arena \(24h\): ping 42 ms median, 210 ms for the slowest 5%; 12\.5% of connected play over 150 ms/);
  assert.deepEqual(seen.filter((c) => c.name === 'performance').map((c) => c.params.by_prop), ['region'], 'one performance query, by_prop region');
  assert.match(net, /"by_region": \[\s+\{\s+"key": "eu"/);
  assert.match(net, /"ping_p50": 190/);
  assert.match(net, /"key": "Mobile data"/);
  assert.equal(seen.find((c) => c.name === 'matches').params.sort, 'lag');
  assert.match(net, /"id": "net-lobby-island"/);
  assert.doesNotMatch(net, /"id": "server-tick-island"/);
});

test('glitchless_servers reads the game\'s servers, from the game or its companion service, with server findings only', async () => {
  seen.length = 0;
  const s = await call('glitchless_servers', { service: 'arena.server' });
  assert.equal(seen.find((c) => c.name === 'servers').params.service, 'arena', 'the companion reads through its game');
  assert.match(s, /^Servers of arena \(24h\): 6 server runs, 2 running now with 180 players connected; tick p95 40 ms against a 33\.33 ms budget/);
  assert.match(s, /Their sessions: service "arena\.server"/);
  assert.match(s, /"matches_ended": 1/);
  assert.match(s, /"id": "server-tick-island"/);
  assert.doesNotMatch(s, /"id": "net-lobby-island"/);
});

test('the dashboard leaves out a net or servers panel\'s numbers over time; the panel schema has the new panels, fields and views', async (t) => {
  t.after(() => api.close());
  const d = await call('glitchless_dashboard');
  assert.match(d, /"ping_p95": 60/, 'rows stay');
  assert.doesNotMatch(d, /"lag_pct": \[/);
  assert.doesNotMatch(d, /"tick_p95": \[/);
  const tools = (await client.listTools()).tools;
  const names = tools.map((x) => x.name);
  for (const n of ['glitchless_match', 'glitchless_network', 'glitchless_servers']) assert.ok(names.includes(n), n);
  const page = tools.find((x) => x.name === 'glitchless_set_dashboard').inputSchema.properties.pages.items;
  const panel = page.properties.panels.items;
  for (const type of ['net', 'servers']) assert.ok(panel.properties.type.enum.includes(type), type);
  for (const show of ['ping', 'loss', 'disconnects', 'ticks', 'players', 'crashes']) assert.ok(panel.properties.show.enum.includes(show), show);
  assert.deepEqual(panel.properties.count.enum, ['runs']);
  for (const view of ['servers', 'matches']) assert.ok(page.properties.view.enum.includes(view), view);
  assert.ok(page.properties.where, 'a page takes where');
  assert.match(panel.properties.metric.description, /ping_p95.*disconnect_pct.*servers_now.*server_tick_p95/s);
});
