// glitchless_events measures one event for an agent (win rate by hero, the median match), and glitchless_dashboard
// keeps a distribution panel's percentiles: called over an in-memory MCP connection against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-genre-'));
delete process.env.GLITCHLESS_API_KEY;

const seen = [];
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const name = url.pathname.replace('/v1/query/', '');
  const params = Object.fromEntries(url.searchParams);
  seen.push({ name, params });
  const body = { meta: { from: 0 }, sessions: 12, events: [{ name: 'match_end', count: 40, sessions: 12, attrs: [], sums: [] }], hours: 3.5 };
  if (params.rate) body.measure = { event: params.event, rate: params.rate, by: params.by, overall: 50, events: 40, rows: [{ value: 'ember', rate: 62.5, low: 40.9, high: 80, events: 16 }], small: { rows: 0, events: 0, min: 1 }, line: 50 };
  if (params.of) body.distribution = { event: params.event, of: params.of, count: 40, p50: 840, p90: 1500, p99: 1700, histogram: [] };
  if (name === 'dashboard') Object.assign(body, { dashboard: { source: 'saved', pages: [{ id: 'm', title: 'Matches', panels: 1 }], spec: { pages: [] } } });
  if (name === 'board') body.board = { page: 'm', title: 'Matches', panels: [{ type: 'distribution', title: 'Match length', p50: 840, p90: 1500, ts: [1], series: [] }, { type: 'frame_time', title: 'Frame time', p50: [1], p95: [2], ts: [1] }] };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.GLITCHLESS_URL = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_SERVICE = 'arena';

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

test('glitchless_events measures a rate by an attribute, and a filtered event keeps its filter', async () => {
  seen.length = 0;
  const r = await client.callTool({ name: 'glitchless_events', arguments: { name: 'match_end:mode=ranked', rate: 'won', by: 'hero', min: 10 } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.deepStrictEqual(pick(seen[0].params, ['name', 'event', 'rate', 'by', 'min']), { name: 'match_end', event: 'match_end:mode=ranked', rate: 'won', by: 'hero', min: '10' });
  assert.match(r.content[0].text, /3\.5 hours played/);
  assert.match(r.content[0].text, /match_end:mode=ranked rate of won by hero: 1 rows, overall 50%/);
  assert.match(r.content.map((c) => c.text).join('\n'), /"value": "ember",\s+"rate": 62\.5/);
});

test('glitchless_events gives a distribution, and the dashboard keeps its percentiles', async (t) => {
  t.after(() => api.close());
  const r = await client.callTool({ name: 'glitchless_events', arguments: { name: 'match_end', of: 'duration_s' } });
  assert.match(r.content[0].text, /match_end duration_s: p50 840, p90 1500 of 40/);
  const d = await client.callTool({ name: 'glitchless_dashboard', arguments: {} });
  const text = d.content.map((c) => c.text).join('\n');
  assert.match(text, /"p50": 840/);
  assert.doesNotMatch(text, /"p95"/, 'frame time charts stay out');
});

function pick(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
