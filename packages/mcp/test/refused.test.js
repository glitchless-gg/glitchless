// A read Glitchless refused (a 503 or a 429, SPEC §3) reaches the agent as what happened and what to do next: a window too big
// to read in time is to be asked again smaller; a busy server, again in a few seconds. Over HTTP (the hosted server,
// where a tool call is one web request of at most 30 seconds) a call whose reads together run too long stops with the
// same advice, rather than the connection dropping. Calls the tools over an in-memory MCP connection against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-refused-'));
delete process.env.GLITCHLESS_API_KEY;

// What the fake API answers next: { status, body, headers, delayMs }.
let answer = null;
const api = http.createServer(async (req, res) => {
  const a = answer;
  if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
  res.writeHead(a.status, { 'content-type': 'application/json', ...a.headers }).end(JSON.stringify(a.body));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.GLITCHLESS_URL = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_SERVICE = 'starlift';

const { createServer, CALL_LIMITS } = await import('../src/context.js');
await import('../src/tools/core.js');
await import('../src/tools/dashboard.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

async function connect(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}
const local = await connect();
const remote = await connect({ remote: true });
test.after(() => api.close());

test('a window too big to read in time says to ask again with fewer hours', async () => {
  answer = { status: 503, body: { error: 'This took more than 25 seconds to read, so it was stopped. Ask for a shorter range.', reason: 'deadline' } };
  const r = await local.callTool({ name: 'glitchless_triage', arguments: { hours: 2160 } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Glitchless error: This window was too big to read: Glitchless stopped the read after 25 seconds. Call again with a smaller hours (for example 168, a week), then widen it if you need more.');
});

test('a busy server says to make the same call again after its wait', async () => {
  answer = { status: 429, headers: { 'retry-after': '3' }, body: { error: 'Glitchless is busy with other large reads. Try again in 3 seconds, or ask for a shorter range.', reason: 'busy' } };
  const r = await local.callTool({ name: 'glitchless_dashboard', arguments: { hours: 720 } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Glitchless error: Glitchless is busy with other large reads right now. Nothing is wrong with the call: make it again in 3 seconds, or now with a smaller hours.');
});

test('any other failure keeps the status and the start of the body', async () => {
  answer = { status: 503, body: { error: 'Service Unavailable' } };
  assert.match((await local.callTool({ name: 'glitchless_triage', arguments: {} })).content[0].text, /^Glitchless error: Glitchless API findings → HTTP 503: \{"error":"Service Unavailable"\}/);
  // A rate limit is a 429 too, with no reason: told as it is, not as a busy server.
  answer = { status: 429, body: { error: 'rate limit exceeded' } };
  assert.match((await local.callTool({ name: 'glitchless_triage', arguments: {} })).content[0].text, /HTTP 429: \{"error":"rate limit exceeded"\}/);
});

test("over HTTP a call whose reads together run past the call's limit stops with the same advice", async () => {
  CALL_LIMITS.ms = 150;
  try {
    // glitchless_dashboard reads the dashboard, then a board: each well inside the server's deadline, together not.
    answer = { status: 200, delayMs: 400, body: { meta: { from: 0 }, dashboard: { source: 'auto', spec: { pages: [{ id: 'main', title: 'Main', panels: [] }] }, pages: [] }, board: { page: 'main', panels: [] } } };
    const started = Date.now();
    const r = await remote.callTool({ name: 'glitchless_dashboard', arguments: { hours: 2160 } });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'Glitchless error: This window was too big to read: its reads took more than 0.2 seconds together, so the call was stopped. Call again with a smaller hours (for example 168, a week), then widen it if you need more.');
    assert.ok(Date.now() - started < 700, 'stopped at the limit, not after both reads (800 ms)');
    // On stdio nothing holds the call to a web request's time: the same call answers.
    assert.notEqual((await local.callTool({ name: 'glitchless_dashboard', arguments: { hours: 2160 } })).isError, true);
  } finally {
    CALL_LIMITS.ms = 27_000;
  }
});
