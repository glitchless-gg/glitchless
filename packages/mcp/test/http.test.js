// The MCP server over Streamable HTTP (http.js): one stateless server per request, reading with the connection the
// host hands over. Clients of the 2026-07-28 protocol and older ones that open with initialize both work; tools that
// act on the server's own computer never show; scopes decide which writes show; and every tool carries a title and
// all four annotation hints, which the Claude and ChatGPT directories check.
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
const host = http.createServer((req, res) => mcp.handle(req, res, { connection: connection({ base: apiUrl, apiKey: KEY, client: 'Claude' }), scopes }));
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const endpoint = new URL(`http://127.0.0.1:${host.address().port}/mcp`);

async function connect(versionNegotiation) {
  const client = new Client({ name: 'test', version: '0' }, versionNegotiation ? { versionNegotiation } : {});
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  return client;
}

test.after(() => {
  api.close();
  host.close();
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
  for (const local of ['glitchless_sign_in', 'glitchless_playtest', 'glitchless_deck_send', 'glitchless_deck_measure']) assert.ok(!reads.includes(local), local);
  for (const write of ['glitchless_set_dashboard', 'glitchless_create_game', 'glitchless_share_board', 'glitchless_revoke_share_link']) assert.ok(!reads.includes(write), write);
  scopes = ['read', 'dashboard'];
  assert.ok((await list()).includes('glitchless_set_dashboard'));
  scopes = ['read', 'dashboard', 'manage'];
  const all = await list();
  for (const write of ['glitchless_set_dashboard', 'glitchless_create_game', 'glitchless_share_board', 'glitchless_list_share_links', 'glitchless_revoke_share_link']) assert.ok(all.includes(write), write);
  assert.equal(all.length, 20);
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
  assert.deepEqual(writes, ['glitchless_create_game', 'glitchless_revoke_share_link', 'glitchless_set_dashboard', 'glitchless_share_board']);
  assert.equal(by.glitchless_revoke_share_link.destructiveHint, true);
  assert.equal(by.glitchless_set_dashboard.destructiveHint, true, 'it replaces the saved dashboard');
  assert.equal(by.glitchless_share_board.openWorldHint, true, 'a share link is public');
  assert.deepEqual(tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name), ['glitchless_share_board']);
  const { serverInfo, instructions } = { serverInfo: client.getServerVersion(), instructions: client.getInstructions() };
  assert.equal(serverInfo.name, 'glitchless');
  assert.ok(!/glitchless_sign_in|glitchless_playtest/.test(instructions), 'the remote instructions name no local tool');
  await client.close();
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
