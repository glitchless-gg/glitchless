// The read tools take env and session_type and pass them on (env=, type=), so an agent can read players only,
// as the Starlift audit needed: its overview, triage and boards mixed in dev builds, bots and Google's test phones,
// and the tools had no way to leave them out. Calls each tool over an in-memory MCP connection against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// No saved sign-in (a workspace key would route every read through /v1/agent): the fake API is one game's.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-filters-'));
delete process.env.GLITCHLESS_API_KEY;

const seen = [];
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  seen.push({ name: url.pathname.replace('/v1/query/', ''), params: Object.fromEntries(url.searchParams) });
  const empty = { findings: [], meta: { from: 0 }, kpis: {}, top_errors: [], funnel: [], by_level: [], by_gpu_tier: [], by_browser: [], by_version: [], hitches: [], issues: [], rage_quits: [], events: [], versions: [], dashboard: null, sessions: 0 };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(empty));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.GLITCHLESS_URL = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_SERVICE = 'starlift';

const { server } = await import('../src/context.js');
await import('../src/tools/core.js');
await import('../src/tools/analytics.js');
await import('../src/tools/dashboard.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);

test('every read tool passes env and session_type on to the API', async (t) => {
  t.after(() => api.close());
  const reads = { glitchless_triage: 'findings', glitchless_overview: 'overview', glitchless_performance: 'performance', glitchless_get_error: 'errors', glitchless_player_funnel: 'players', glitchless_events: 'events', glitchless_compare_versions: 'versions', glitchless_dashboard: 'dashboard' };
  for (const [tool, name] of Object.entries(reads)) {
    seen.length = 0;
    const r = await client.callTool({ name: tool, arguments: { env: 'prod', session_type: 'user' } });
    assert.ok(!r.isError, `${tool}: ${r.content?.[0]?.text}`);
    const call = seen.find((c) => c.name === name);
    assert.ok(call, `${tool} read ${name}`);
    assert.equal(call.params.env, 'prod', tool);
    assert.equal(call.params.type, 'user', tool);
  }
  seen.length = 0;
  await client.callTool({ name: 'glitchless_triage', arguments: {} });
  assert.deepEqual(['env', 'type'].filter((k) => k in seen[0].params), [], 'unset: left out, so findings read prod players by default');
  const listed = (await client.listTools()).tools.find((x) => x.name === 'glitchless_triage');
  assert.deepEqual(listed.inputSchema.properties.session_type.enum, ['user', 'tester', 'synthetic', 'all']);
});
