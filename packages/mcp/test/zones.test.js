// An agent reads where play time goes in a game with zones (setZone) and how each zone runs: glitchless_performance's
// by_zone (time, sessions, median stay, hitches; `zone` keeps one, with its hitches), and a Zones board saved with
// glitchless_set_dashboard (a breakdown by $zone without an event, a zone stat, frame_time by $zone), against a real
// Glitchless server on a file store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../server/src/app.js';
import { FileStore } from '../../../server/src/stores/file.js';
import { Sketch } from '../../sdk/src/sketch.js';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-zones-'));
delete process.env.GLITCHLESS_API_KEY;

const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-zones-store-')));
const api = http.createServer(createApp({ store, auth: { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read', 'dashboard'] }) }, logger: { warn() {}, error() {} } }));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_URL = base;
process.env.GLITCHLESS_SERVICE = 'hub';

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
const json = (text) => JSON.parse(text.slice(text.indexOf('{')));

// 12 sessions: a minute in the hall each, half of them 30 s in the garden, a third 20 s in the observatory, whose
// frames hitch.
test('an agent reads time in each zone and designs a Zones page', async (t) => {
  t.after(() => api.close());
  const start = Date.now() - 2 * 3_600_000;
  for (let n = 0; n < 12; n++) {
    let ts = start + n * 300_000;
    const events = [{ type: 'session_start', ts }];
    const win = (zone, k, extra = {}) => {
      for (let i = 0; i < k; i++) {
        const sk = new Sketch();
        for (let f = 0; f < 300; f++) sk.add(extra.slow && f < 10 ? 80 : 15);
        events.push({ type: 'frame_window', ts: (ts += 5000), zone, duration_s: 5, frames: 300, budget_ms: 16.67, ft: sk.toJSON(), hitches: extra.slow ? 2 : 0 });
      }
    };
    win('hall', 12);
    if (n % 2) win('garden', 6);
    if (n % 3 === 0) {
      win('observatory', 4, { slow: true });
      events.push({ type: 'hitch', ts: (ts += 100), zone: 'observatory', duration_ms: 90, causes: ['render'] });
    }
    const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service: 'hub', env: 'prod', version: '1.0', session_id: `s_${n}`, events }) });
    assert.equal(res.status, 202);
  }

  const perf = json(await call('glitchless_performance', { hours: 6 }));
  const zones = Object.fromEntries(perf.by_zone.map((z) => [z.key, z]));
  assert.deepEqual([zones.hall.sessions, zones.hall.median_s, zones.hall.hitches_per_min], [12, 60, 0]);
  assert.deepEqual([zones.garden.sessions, zones.garden.median_s], [6, 30]);
  assert.deepEqual([zones.observatory.sessions, zones.observatory.median_s, zones.observatory.hitches_per_min], [4, 20, 24]);
  assert.equal(zones.hall.share_pct, 73.5, '720 of 980 seconds played');
  const sky = json(await call('glitchless_performance', { hours: 6, zone: 'observatory' }));
  assert.deepEqual(sky.by_zone.map((z) => z.key), ['observatory']);
  assert.ok(sky.slowest_recent_hitches.length && sky.slowest_recent_hitches.every((h) => h.zone === 'observatory'));

  const saved = await call('glitchless_set_dashboard', {
    pages: [{ id: 'zones', title: 'Zones', panels: [{ type: 'breakdown', by: '$zone' }, { type: 'stat', metric: 'zone_median_s', zone: 'hall' }, { type: 'frame_time', by: '$zone' }] }],
  });
  assert.doesNotMatch(saved, /empty/i);
  const board = json(await call('glitchless_dashboard', { hours: 6, page: 'zones' })).board;
  const [time, stat, frames] = board.panels;
  assert.deepEqual(time.rows.map((r) => [r.value, r.share_pct, r.median_s]), [['hall', 73.5, 60], ['garden', 18.4, 30], ['observatory', 8.2, 20]]);
  assert.deepEqual([stat.title, stat.value], ['Median time in hall', 60]);
  assert.equal(frames.rows.find((r) => r.value === 'observatory').hitches_per_min, 24);
});
