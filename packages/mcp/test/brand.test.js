// An agent sets a game's accent colour with glitchless_set_dashboard (alone, or with its pages) and reads the brand
// back in glitchless_dashboard, against a real Glitchless server on a file store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../server/src/app.js';
import { FileStore } from '../../../server/src/stores/file.js';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-brand-'));
delete process.env.GLITCHLESS_API_KEY;

const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-brand-store-')));
const api = http.createServer(createApp({ store, auth: { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read', 'dashboard'] }) }, logger: { warn() {}, error() {} } }));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_URL = base;
process.env.GLITCHLESS_SERVICE = 'starlift';

const { createServer } = await import('../src/context.js');
await import('../src/tools/dashboard.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

test("an agent sets the accent of a game's boards and reads the brand back", async (t) => {
  t.after(() => api.close());
  const ts = Date.now() - 60_000;
  await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service: 'starlift', env: 'prod', version: '1.0.0', session_id: 's1', events: [{ type: 'session_start', ts }] }) });
  assert.match(await call('glitchless_set_dashboard', { accent: '#7C4DFF' }), /Saved the look of starlift's boards\. Accent: #7c4dff\./);
  assert.match(await call('glitchless_dashboard', {}), /"brand": \{\s*"accent": "#7c4dff",\s*"logo": false,\s*"banner": false/);
  assert.match(await call('glitchless_set_dashboard', { accent: 'purple' }), /accent is a colour written "#rrggbb"/);
  assert.match(await call('glitchless_set_dashboard', { accent: null }), /Accent: none\./);
  assert.equal(await store.getBrand('default', 'starlift'), null, 'no accent, no logo, no banner: no brand');
  assert.match(await call('glitchless_set_dashboard', {}), /give pages, accent, or reset: true/);
});
