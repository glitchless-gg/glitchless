// The MCP server over Streamable HTTP (http.js): one stateless server per request, reading with the connection the
// host hands over. Clients of the 2026-07-28 protocol and older ones that open with initialize both work; tools that
// act on the server's own computer never show; scopes decide which writes show; every tool carries a title and
// all four annotation hints, which the Claude and ChatGPT directories check; and a connected client holds no request
// open, since the server has no news to send it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-http-'));
delete process.env.GLITCHLESS_API_KEY;

// A fake Glitchless Cloud: one workspace with two games.
const seen = [];
const GAMES = [
  { id: 'p_zoomies', name: 'Zoomies', services: [] },
  { id: 'p_starlift', name: 'Starlift', services: [] },
];
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  seen.push({ path: url.pathname, key: req.headers['x-glitchless-api-key'], project: req.headers['x-glitchless-project'], client: req.headers['x-glitchless-client'] });
  const send = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/v1/agent/games') return send({ games: GAMES });
  if (url.pathname === '/v1/query/services') return send({ services: [{ service: 'zoomies', last_seen: Date.now() }] });
  if (url.pathname === '/v1/query/findings') return send({ findings: [{ severity: 'high', title: 'Level 2 hitches on load' }], meta: { from: 0 } });
  if (url.pathname === '/v1/query/dashboard') return send({ dashboard: { source: 'auto', pages: [{ id: 'overview', title: 'Overview', panels: [] }], spec: { pages: [] } } });
  if (url.pathname === '/v1/query/board') return send({ board: { page: 'overview', title: 'Overview', panels: [] } });
  send({});
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

const { connection } = await import('../src/context.js');
const { createHttpHandler, serve } = await import('../src/http.js');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

const KEY = `gl_ws_${'k'.repeat(43)}`;
const mcp = createHttpHandler();
let scopes = ['read'];
// What the host was asked (a 2026-07-28 client names the method in Mcp-Method), and the requests it hasn't finished.
const asked = [];
const unfinished = new Set();
const host = http.createServer((req, res) => {
  asked.push(req.headers['mcp-method'] ?? req.method);
  unfinished.add(res);
  res.on('close', () => unfinished.delete(res));
  return mcp.handle(req, res, { connection: connection({ base: apiUrl, apiKey: KEY, client: 'Claude' }), scopes });
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const endpoint = new URL(`http://127.0.0.1:${host.address().port}/mcp`);

// A 2026-07-28 request as a client writes it by hand: the protocol version and the client ride in _meta.
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const ask = (url, method, params = {}, id = 1) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { _meta: META, ...params } }),
    signal: AbortSignal.timeout(1000),
  });
// The JSON-RPC messages of an answer, whether it came as JSON or as an event stream. Reading waits for the answer to
// end, so one the server holds open fails on ask()'s one-second limit.
const messages = async (res) => {
  const text = await res.text();
  return /event-stream/.test(res.headers.get('content-type')) ? text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))) : [JSON.parse(text)];
};

async function connect(versionNegotiation) {
  const client = new Client({ name: 'test', version: '0' }, versionNegotiation ? { versionNegotiation } : {});
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  return client;
}

// closeAllConnections: a test that failed may have left a client connected, and the run must still end.
test.after(() => {
  for (const server of [api, host]) {
    server.close();
    server.closeAllConnections();
  }
});

test('an older client (initialize) and a 2026-07-28 client both list and call the tools', async () => {
  for (const mode of [undefined, { pin: '2026-07-28' }]) {
    const client = await connect(mode && { mode });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('glitchless_triage') && names.includes('glitchless_dashboard'), names.join());
    seen.length = 0;
    const r = await client.callTool({ name: 'glitchless_triage', arguments: { game: 'Zoomies' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.match(r.content[0].text, /Level 2 hitches on load/);
    const read = seen.find((s) => s.path === '/v1/query/findings');
    assert.deepEqual([read.key, read.project, read.client], [KEY, 'p_zoomies', 'Claude'], 'reads with the connection it was handed, for the game it names');
    const board = await client.callTool({ name: 'glitchless_dashboard', arguments: { game: 'Zoomies' } });
    assert.ok(!board.isError && /Dashboard for zoomies/.test(board.content[0].text), board.content[0].text);
    await client.close();
  }
});

test("tools that act on the server's computer never show, and scopes decide which writes do", async () => {
  const client = await connect();
  const list = async () => (await client.listTools()).tools.map((t) => t.name);
  scopes = ['read'];
  const reads = await list();
  for (const local of ['glitchless_sign_in', 'glitchless_playtest', 'glitchless_deck']) assert.ok(!reads.includes(local), local);
  for (const write of ['glitchless_set_dashboard', 'glitchless_create_game', 'glitchless_share_links', 'glitchless_mark_known', 'glitchless_resolve_error', 'glitchless_set_alerts']) assert.ok(!reads.includes(write), write);
  assert.equal(reads.length, 17);
  assert.ok(reads.includes('glitchless_alerts'), 'reading the alerts takes only read');
  assert.ok(reads.includes('glitchless_feedback'), 'a connection that only reads can still tell the Glitchless team');
  scopes = ['read', 'dashboard'];
  assert.ok((await list()).includes('glitchless_set_dashboard'));
  scopes = ['read', 'dashboard', 'manage'];
  const all = await list();
  for (const write of ['glitchless_set_dashboard', 'glitchless_create_game', 'glitchless_share_links', 'glitchless_mark_known', 'glitchless_resolve_error', 'glitchless_set_alerts']) assert.ok(all.includes(write), write);
  assert.equal(all.length, 23);
  // Deleting games is a parameter of glitchless_create_game, so it shows no tool of its own.
  scopes = ['read', 'dashboard', 'manage', 'delete_games'];
  assert.deepEqual(await list(), all);
  await client.close();
});

test('every tool has a title and all four annotation hints, true to what it does', async () => {
  scopes = ['read', 'dashboard', 'manage'];
  const client = await connect();
  const tools = (await client.listTools()).tools;
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has a title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof t.annotations?.[hint], 'boolean', `${t.name} ${hint}`);
    assert.ok(t.inputSchema.properties.game, `${t.name} takes game`);
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  const writes = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(writes, ['glitchless_create_game', 'glitchless_feedback', 'glitchless_mark_known', 'glitchless_resolve_error', 'glitchless_set_alerts', 'glitchless_set_dashboard', 'glitchless_share_links']);
  assert.equal(by.glitchless_feedback.openWorldHint, true, 'a report goes beyond the workspace, to the Glitchless team');
  assert.equal(by.glitchless_set_dashboard.destructiveHint, true, 'it replaces the pages, and removes a background or a logo');
  assert.equal(by.glitchless_set_alerts.openWorldHint, true, 'a test alert posts to Discord, Slack or email');
  assert.equal(by.glitchless_share_links.destructiveHint, true, 'it revokes a link');
  assert.equal(by.glitchless_create_game.destructiveHint, true, 'it deletes a game');
  assert.equal(by.glitchless_set_dashboard.destructiveHint, true, 'it replaces the saved dashboard');
  assert.equal(by.glitchless_share_links.openWorldHint, true, 'a share link is public');
  assert.deepEqual(tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort(), ['glitchless_feedback', 'glitchless_set_alerts', 'glitchless_share_links']);
  const { serverInfo, instructions } = { serverInfo: client.getServerVersion(), instructions: client.getInstructions() };
  assert.equal(serverInfo.name, 'glitchless');
  assert.ok(!/glitchless_sign_in|glitchless_playtest/.test(instructions), 'the remote instructions name no local tool');
  await client.close();
});

// The server used to say it sends tool-list changes, as McpServer does by default. Each connected 2026-07-28 client
// then opened a subscriptions/listen stream and waited on it: behind a serverless function that is one request slot
// per agent, held until the function's timeout cuts it, then opened again.
test('a listen is acknowledged with nothing and ended at once, by the handler and by glitchless-mcp serve', async (t) => {
  const served = await serve(['--port', '0']);
  t.after(() => served.close().closeAllConnections());
  for (const url of [endpoint, `http://127.0.0.1:${served.address().port}/mcp`]) {
    const started = Date.now();
    const res = await ask(url, 'subscriptions/listen', { notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['glitchless://games'] } }, 'listen:0');
    const [ack, end, ...more] = await messages(res);
    assert.ok(Date.now() - started < 1000, 'the stream ends within a second');
    assert.equal(res.status, 200);
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
    assert.deepEqual(ack.params.notifications, {}, 'the client is told none of what it asked for will be sent');
    assert.deepEqual([end.id, end.result?.resultType, end.error], ['listen:0', 'complete', undefined], "the listen's own result: the stream ended on purpose, so it isn't a dropped connection to open again");
    assert.equal(more.length, 0);
  }
});

test("a client that wants tool-list changes doesn't listen, one that listens anyway isn't left to ask again, and tools still list and call", async (t) => {
  // Retries after 20 ms where the SDK's client waits a second, so a client that came back would show in this test.
  const transport = () => new StreamableHTTPClientTransport(endpoint, { reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 20, reconnectionDelayGrowFactor: 1, maxRetries: 5 } });
  const settled = () => new Promise((r) => setTimeout(r, 300));
  const listens = () => asked.filter((m) => m === 'subscriptions/listen').length;
  scopes = ['read'];

  for (const mode of [{ pin: '2026-07-28' }, undefined]) {
    asked.length = 0;
    const errors = [];
    const client = new Client({ name: 'test', version: '0' }, { listChanged: { tools: { onChanged() {} } }, ...(mode && { versionNegotiation: { mode } }) });
    client.onerror = (err) => errors.push(err.message);
    t.after(() => client.close());
    await client.connect(transport());
    const era = mode ? '2026-07-28' : 'initialize';
    assert.deepEqual(client.getServerCapabilities().tools, { listChanged: false }, `${era}: there are tools, and no news of the list changing`);
    assert.deepEqual(client.getServerCapabilities().resources, { listChanged: false }, `${era}: the skills' files are resources, and they don't change either`);
    assert.equal(client.autoOpenedSubscription, undefined, `${era}: nothing to listen for`);

    if (mode) {
      // A client that listens all the same: one that read the capabilities before this server said no, for one.
      const subscription = await client.listen({ toolsListChanged: true });
      assert.deepEqual(subscription.honoredFilter, {}, 'told it will be sent nothing');
      assert.equal(await subscription.closed, 'graceful', 'and that the server ended it on purpose');
    }
    assert.equal((await client.listTools()).tools.length, 17);
    const r = await client.callTool({ name: 'glitchless_triage', arguments: { game: 'Zoomies' } });
    assert.match(r.content[0].text, /Level 2 hitches on load/);

    await settled();
    assert.equal(listens(), mode ? 1 : 0, `${era}: no listen is opened again (asked: ${asked.join()})`);
    assert.equal(unfinished.size, 0, `${era}: a connected, idle client holds no request open (asked: ${asked.join()})`);
    assert.deepEqual(errors, [], era);
  }
});

test("with no list-change news, the tool list says it is stale at once, so a client that asks again gets a release's new tools", async () => {
  scopes = ['read'];
  const [{ result }] = await messages(await ask(endpoint, 'tools/list'));
  assert.equal(result.tools.length, 17);
  assert.deepEqual([result.ttlMs, result.cacheScope], [0, 'private'], 'stale at once, and never shared: the list depends on the scopes the person gave');
});

test('glitchless-mcp serve: this computer only, unless a token guards it', async () => {
  await assert.rejects(serve(['--port', '0', '--host', '0.0.0.0']), /GLITCHLESS_MCP_TOKEN/);
  const server = await serve(['--port', '0']);
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (p, headers = {}) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
  assert.equal((await post('/elsewhere')).status, 404);
  assert.equal((await post('/mcp', { origin: 'https://evil.example' })).status, 403, 'a web page elsewhere cannot reach it (DNS rebinding)');
  const ok = await post('/mcp');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /"name":"glitchless"/);
  server.close();
});
