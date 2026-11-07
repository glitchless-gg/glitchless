// The pictures an agent gives a game's boards with glitchless_set_dashboard, against a real Glitchless server on a
// file store: a hub's (a place with no levels) heatmap background from a file and its world bounds, read back with
// where players die in a zone or anywhere (glitchless_player_funnel) and a zone's positions on a board; and the
// boards' logo and banner. Over HTTP, the server can't read the agent's files, and says how to upload instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../../../server/src/app.js';
import { FileStore } from '../../../server/src/stores/file.js';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-heatmaps-'));
delete process.env.GLITCHLESS_API_KEY;

const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-heatmaps-store-')));
const api = http.createServer(createApp({ store, auth: { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read', 'dashboard'] }) }, logger: { warn() {}, error() {} } }));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_URL = base;
process.env.GLITCHLESS_SERVICE = 'hub';

const { createServer } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
async function connect(remote) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ remote }).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
}

// A 200 × 100 PNG: a room twice as wide as it is deep.
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 90)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('an agent gives a zone a background from a file, reads its death hotspots, and removes it', async (t) => {
  t.after(() => api.close());
  const call = await connect(false);
  const ts = Date.now() - 600_000;
  const events = [
    { type: 'session_start', ts },
    { type: 'pos', ts: ts + 1000, zone: 'hall', pts: Array.from({ length: 8 }, (_, k) => [ts + 1000 + k, -40 + k * 10, 1, 5]) },
    ...[0, 1, 2].map((k) => ({ type: 'death', ts: ts + 2000 + k, zone: 'hall', x: 30, y: 1, z: 5, cause: 'lava' })),
    { type: 'death', ts: ts + 3000, zone: 'garden', x: 300, y: 1, z: 50, cause: 'thorns' },
  ];
  await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service: 'hub', env: 'prod', version: '1.0.0', session_id: 's1', player_id: 's1', events }) });

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-hall-')), 'hall.png');
  fs.writeFileSync(file, png(200, 100));
  const saved = await call('glitchless_set_dashboard', { background: { zone: 'hall', file, bounds: { min: [-50, -25], max: [50, 25] } } });
  assert.match(saved, /^hub: Saved the background of zone hall: 200 × 100 pixels, seen from above/);
  assert.doesNotMatch(saved, /stretched/);
  assert.match(await call('glitchless_set_dashboard', { background: { file, bounds: { min: [0, 0], max: [10, 10] } } }), /stretched to fit them/, 'a 2:1 picture over square bounds');
  assert.match(await call('glitchless_set_dashboard', { background: { zone: 'hall', file } }), /give bounds/);
  assert.match(await call('glitchless_set_dashboard', { background: { level: 'a', zone: 'hall', file } }), /not both/);
  // glitchless_dashboard lists them (captured and uploaded), without their pictures.
  const list = await call('glitchless_dashboard', {});
  assert.match(list, /"backgrounds": \[/);
  assert.match(list, /"zone": "hall"/);
  assert.doesNotMatch(list, /base64/);

  const hall = await call('glitchless_player_funnel', { hotspots: true, zone: 'hall' });
  assert.match(hall, /Death hotspots in hall in hub/);
  assert.match(hall, /"background": "uploaded"/);
  assert.match(hall, /"top_cause": "lava"/);
  assert.match(hall, /"total_deaths": 3/);
  const everywhere = await call('glitchless_player_funnel', { hotspots: true });
  assert.match(everywhere, /Death hotspots anywhere in the game in hub/);
  assert.match(everywhere, /"total_deaths": 4/);
  assert.match(everywhere, /"zones": \[\s*"garden",\s*"hall"\s*\]/);

  // A board of the hall's paths, over its background.
  assert.match(await call('glitchless_set_dashboard', { pages: [{ id: 'lobby', title: 'Lobby', panels: [{ type: 'positions', zone: 'hall', show: 'both' }] }] }), /Lobby/);
  const board = await call('glitchless_dashboard', { page: 'lobby' });
  assert.match(board, /"zone": "hall"/);
  assert.match(board, /"url": "\/v1\/maps\/image\?service=hub&id=[0-9a-f]{16}"/);

  assert.match(await call('glitchless_set_dashboard', { background: { zone: 'hall', remove: true } }), /Removed the uploaded background of zone hall/);
  assert.match(await call('glitchless_set_dashboard', { background: { zone: 'hall', remove: true } }), /HTTP 404: no uploaded background/);

  // Over HTTP the server reads no files: it says how to send the picture instead, and takes it as base64.
  const remote = await connect(true);
  const refused = await remote('glitchless_set_dashboard', { background: { zone: 'hall', file, bounds: { min: [-50, -25], max: [50, 25] } } });
  assert.match(refused, /can't read files on your computer/);
  assert.match(refused, /curl -X PUT '.*\/v1\/maps\?service=hub&zone=hall&axis=xz&min=-50%2C-25&max=50%2C25'.*--data-binary @/);
  assert.match(await remote('glitchless_set_dashboard', { background: { zone: 'hall', image: png(200, 100).toString('base64'), bounds: { min: [-50, -25], max: [50, 25] } } }), /Saved the background of zone hall/);

  // The boards' logo and banner (the header behind each board's title), from a file or as base64, with the accent.
  const logo = path.join(path.dirname(file), 'logo.png');
  fs.writeFileSync(logo, png(64, 64));
  const look = await call('glitchless_set_dashboard', { accent: '#2ee6a6', logo: { file: logo }, banner: { image: png(800, 200).toString('base64'), focus: 'top' } });
  assert.match(look, /^Saved the look of hub's boards\. Accent: #2ee6a6\. Saved the logo: 64 × 64 pixels\. Saved the banner: 800 × 200 pixels\. The banner keeps its top in view\./, look);
  assert.match(await call('glitchless_dashboard', {}), /"brand": \{\s*"accent": "#2ee6a6",\s*"logo": true,\s*"banner": true\s*\}/);
  assert.match(await call('glitchless_set_dashboard', { logo: { remove: true } }), /Removed the logo\./);
  assert.match(await call('glitchless_set_dashboard', { banner: {} }), /give banner\.file or banner\.image/);
  assert.match(await call('glitchless_set_dashboard', { logo: { image: Buffer.from('<svg/>').toString('base64') } }), /415/);
  assert.match(await remote('glitchless_set_dashboard', { logo: { file: logo } }), /curl -X PUT '.*\/v1\/brand\/logo\?service=hub'.*--data-binary @/);
});
