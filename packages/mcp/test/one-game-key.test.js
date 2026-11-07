// A key for one game (gl_sk_…) reaches only that game. On 2026-11-07 an agent whose MCP server held Starlift's key set
// another game's logo and banner, and they landed on Starlift: the server ignored the game the call named. Now the
// MCP server sends a call's `game` as x-glitchless-game with such a key, and Glitchless Cloud refuses another game's
// name (its own tests cover that side). Called over an in-memory MCP connection against a fake API that answers as
// the cloud does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-one-game-'));
process.env.GLITCHLESS_API_KEY = 'gl_sk_starlift_test';
delete process.env.GLITCHLESS_GAME;

const seen = [];
const api = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  const named = req.headers['x-glitchless-game'];
  seen.push({ path: new URL(req.url, 'http://local').pathname, named: named == null ? null : decodeURIComponent(named) });
  if (named && decodeURIComponent(named).toLowerCase() !== 'starlift') {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `this key is for the game "Starlift" only, and the call names "${decodeURIComponent(named)}": sign in to the workspace (npx -y glitchless-mcp login) to reach every game, or use that game's own key` }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'starlift', brand: { accent: '#e4572e' } }));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.GLITCHLESS_URL = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_SERVICE = 'starlift';

const { createServer } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

test("with a key for one game, a call that names another game is refused, not done on the key's game", async (t) => {
  t.after(() => api.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ remote: false }).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (args) => (await client.callTool({ name: 'glitchless_set_dashboard', arguments: args })).content[0].text;

  const refused = await call({ game: 'Born Two', accent: '#2ee6a6' });
  assert.match(refused, /this key is for the game "Starlift" only, and the call names "Born Two"/);
  assert.deepEqual(seen.map((s) => s.named), ['Born Two'], 'the game named went with the request');

  seen.length = 0;
  assert.match(await call({ game: 'Ìjàpá', accent: '#2ee6a6' }), /names "Ìjàpá"/, 'a name with accents is sent URI-encoded');
  seen.length = 0;
  assert.match(await call({ game: 'Starlift', accent: '#e4572e' }), /Saved the look of starlift's boards/);
  assert.deepEqual(seen.map((s) => s.named), ['Starlift']);
  seen.length = 0;
  await call({ accent: '#e4572e' });
  assert.deepEqual(seen.map((s) => s.named), [null], 'without game, no header: the key acts on its game as always');
  await client.close();
});
