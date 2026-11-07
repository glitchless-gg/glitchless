// A Roblox hub game's requests, for agents: glitchless_events gives the time to an event's first occurrence and the
// sessions that never sent it (first), and glitchless_set_dashboard takes ROBUX, devex, first, never and order on a
// count breakdown, sending them on as they are. Called over an in-memory MCP connection against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-money-'));
process.env.GLITCHLESS_API_KEY = 'gl_test_dashboard';

const seen = [];
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null });
  const name = url.pathname.replace('/v1/query/', '');
  let out = { meta: { from: 0 }, sessions: 12, events: [{ name: 'hall_left', count: 10, sessions: 10, attrs: [], sums: [] }], hours: 2 };
  if (name === 'events' && url.searchParams.get('first')) out.first = { event: 'hall_left', sessions: 10, median_s: 42, p90_s: 118.5, ended: 12, never: 2, never_pct: 16.7 };
  if (url.pathname === '/v1/dashboard') out = { service: 'starlift', dashboard: JSON.parse(body) };
  if (name === 'board') out = { meta: {}, board: { page: 'hub', title: 'Hub', panels: [{ type: 'stat', title: 'Time in the hall', value: 42 }] } };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.GLITCHLESS_URL = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_SERVICE = 'starlift';

const { createServer } = await import('../src/context.js');
await import('../src/tools/core.js');
await import('../src/tools/analytics.js');
await import('../src/tools/dashboard.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);

test('glitchless_events with first: the time to the first hall_left, and the sessions that never left', async () => {
  seen.length = 0;
  const r = await client.callTool({ name: 'glitchless_events', arguments: { name: 'hall_left', first: true } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(seen[0].params.first, '1');
  assert.match(r.content[0].text, /hall_left, first in a session: median 42 s after the session started, p90 118\.5 s \(10 sessions\); 16\.7% of 12 ended sessions never sent it/);
  assert.match(r.content.map((c) => c.text).join('\n'), /"never_pct": ?16\.7/);
  // Without first, nothing is asked.
  seen.length = 0;
  await client.callTool({ name: 'glitchless_events', arguments: { name: 'hall_left' } });
  assert.equal(seen[0].params.first, undefined);
});

test('glitchless_set_dashboard sends Robux, the DevEx estimate, first, never and order as they are', async (t) => {
  t.after(() => api.close());
  seen.length = 0;
  const panels = [
    { type: 'stat', event: 'purchase:result=done', sum: 'amount', devex: true, title: 'Robux spent' },
    { type: 'breakdown', event: 'purchase:result=done', by: 'item', sum: 'amount', devex: true },
    { type: 'stat', first: 'hall_left', quantile: 90 },
    { type: 'stat', never: 'hall_left' },
    { type: 'breakdown', event: 'streak_day', by: 'day', order: 'value' },
  ];
  const r = await client.callTool({ name: 'glitchless_set_dashboard', arguments: { currency: 'ROBUX', pages: [{ id: 'hub', title: 'Hub', panels }] } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const put = seen.find((x) => x.method === 'PUT');
  assert.deepStrictEqual(put.body, { currency: 'ROBUX', pages: [{ id: 'hub', title: 'Hub', panels }] });
  assert.match(r.content[0].text, /money in ROBUX/);
});
