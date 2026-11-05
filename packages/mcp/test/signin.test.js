// A saved sign-in goes only to the server it was saved for. Someone signed in to Glitchless Cloud with
// `glitchless-mcp login` who points GLITCHLESS_URL at another server (a meetup's own box at a jam) must not hand
// that server their workspace key: the MCP server connects without one, and a 401 says where the sign-in is for and
// to set GLITCHLESS_API_KEY. The same origin still gets the saved key, and GLITCHLESS_API_KEY goes where it's told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const KEY = `gl_ws_${'k'.repeat(43)}`;
const MEETUP_KEY = 'gl_sk_meetup';

// Two fake Glitchless servers on different ports, so different origins: Glitchless Cloud (one workspace, one game)
// and a meetup's self-hosted box, open or (locked) asking for its own key.
const seen = { cloud: [], meetup: [] };
let locked = false;
const fake = (name) =>
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const key = req.headers['x-glitchless-api-key'];
    seen[name].push({ path: url.pathname, key });
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (name === 'meetup' && locked && key !== MEETUP_KEY) return send(401, { error: 'missing or invalid x-glitchless-api-key' });
    if (url.pathname === '/v1/agent/games') return send(200, { games: [{ id: 'p_zoomies', name: 'Zoomies', services: [] }] });
    if (url.pathname === '/v1/query/services') return send(200, { services: [{ service: 'zoomies', last_seen: Date.now() }] });
    if (url.pathname === '/v1/query/findings') return send(200, { findings: [], meta: { from: 0 }, kpis: {}, deployments: [] });
    send(200, {});
  });
const cloud = fake('cloud');
const meetup = fake('meetup');
await Promise.all([cloud, meetup].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
const cloudUrl = `http://127.0.0.1:${cloud.address().port}`;
const meetupUrl = `http://127.0.0.1:${meetup.address().port}`;

// Signed in to "Cloud" with glitchless-mcp login, and this MCP server pointed at the meetup's box.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-signin-'));
fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, 'glitchless'));
fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'glitchless', 'credentials.json'), JSON.stringify({ url: cloudUrl, token: KEY, workspace: { id: 'w_jam', name: 'Jam team' }, scopes: ['read'] }));
delete process.env.GLITCHLESS_API_KEY;
delete process.env.GLITCHLESS_SERVICE;
delete process.env.GLITCHLESS_GAME;
process.env.GLITCHLESS_URL = meetupUrl;

const { createServer, stdioConnection, useCredentials } = await import('../src/context.js');
await import('../src/tools/core.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

// glitchless_triage over an in-memory MCP connection: with `c`, or with the stdio server's own connection.
async function triage(c = null) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(c ? { connection: c } : {}).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  try {
    return await client.callTool({ name: 'glitchless_triage', arguments: {} });
  } finally {
    await client.close();
  }
}

const reset = () => {
  seen.cloud.length = 0;
  seen.meetup.length = 0;
};

test.after(() => {
  cloud.close();
  meetup.close();
});

test('pointed at another server, the stdio server never sends it the saved Cloud key', async () => {
  reset();
  const open = await triage();
  assert.ok(!open.isError, open.content?.[0]?.text);
  assert.ok(seen.meetup.length > 0, 'it read from GLITCHLESS_URL');
  assert.deepEqual(seen.meetup.map((r) => r.key), seen.meetup.map(() => undefined), 'no key to an open self-hosted server');
  assert.equal(seen.cloud.length, 0, 'and nothing went to Cloud');

  locked = true;
  try {
    reset();
    const refused = await triage();
    assert.ok(refused.isError);
    assert.match(refused.content[0].text, /HTTP 401/);
    assert.ok(refused.content[0].text.endsWith(`The saved sign-in is for ${cloudUrl} and isn't sent to another server: set GLITCHLESS_API_KEY for ${meetupUrl}.`), refused.content[0].text);
    assert.ok(seen.meetup.every((r) => r.key === undefined), 'not even when the server asks for a key');
  } finally {
    locked = false;
  }
});

test('the saved key goes to the origin it was saved for, with or without GLITCHLESS_URL', async () => {
  for (const env of [{}, { GLITCHLESS_URL: cloudUrl }, { GLITCHLESS_URL: `${cloudUrl}/` }]) {
    const c = stdioConnection(env);
    assert.equal(c.base, cloudUrl, JSON.stringify(env));
    assert.equal(c.apiKey, KEY, JSON.stringify(env));
    assert.equal(c.savedFor, null);
    reset();
    const r = await triage(c);
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.ok(seen.cloud.length > 0 && seen.cloud.every((x) => x.key === KEY), JSON.stringify(seen.cloud));
  }
  // Another port, or another name for the same machine, is another origin.
  for (const url of [meetupUrl, `http://localhost:${cloud.address().port}`, `https://127.0.0.1:${cloud.address().port}`, 'not a url']) {
    const c = stdioConnection({ GLITCHLESS_URL: url });
    assert.equal(c.apiKey, '', url);
    assert.equal(c.savedFor, cloudUrl, url);
  }
});

test('GLITCHLESS_API_KEY goes to the server GLITCHLESS_URL names, and the saved sign-in stays out of it', async () => {
  locked = true;
  try {
    const c = stdioConnection({ GLITCHLESS_URL: meetupUrl, GLITCHLESS_API_KEY: MEETUP_KEY });
    assert.equal(c.savedFor, null, 'no saved sign-in to talk about');
    reset();
    const r = await triage(c);
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.ok(seen.meetup.every((x) => x.key === MEETUP_KEY));
    assert.equal(seen.cloud.length, 0);
  } finally {
    locked = false;
  }
});

test('signing in from inside the agent (glitchless_sign_in) still switches the running server to the workspace', async () => {
  useCredentials({ url: cloudUrl, token: KEY });
  reset();
  const r = await triage();
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(seen.meetup.length, 0);
  assert.ok(seen.cloud.length > 0 && seen.cloud.every((x) => x.key === KEY));
});
