// The pictures an agent gives a game's boards with glitchless_set_dashboard, against a real Glitchless server on a
// file store: a hub's (a place with no levels) heatmap background from a file and its world bounds, read back with
// where players die in a zone or anywhere (glitchless_player_funnel) and a zone's positions on a board; and the
// boards' logo and banner. Over HTTP, the server can't read the agent's files: it answers with an upload link, and
// the curl it gives sends the picture, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

  // Over HTTP the server reads no files: it answers with an upload link for that place and those bounds, and the curl it
  // gives (run as the agent would, in a shell) saves the picture, once. It takes base64 too.
  const remote = await connect(true);
  const linked = await remote('glitchless_set_dashboard', { background: { zone: 'hall', file, bounds: { min: [-50, -25], max: [50, 25] } } });
  assert.match(linked, /^hub: To send the background of zone hall, run this within 10 minutes: `curl -X PUT --data-binary @\S+ '[^']+\/v1\/uploads\/gl_up_[A-Za-z0-9_-]{43}'`\. The link takes one picture \(PNG, JPEG or WebP, at most 256 KB and 4096 × 4096 pixels\) and then stops working/, linked);
  const sent = JSON.parse(await curl(linked));
  assert.equal(sent.saved, 'Saved the background of zone hall: 200 × 100 pixels, seen from above. The Heatmaps view and positions panels of zone hall draw on it now.');
  assert.match(JSON.parse(await curl(linked)).error, /used up or has expired/);
  assert.match(await remote('glitchless_set_dashboard', { background: { zone: 'hall', upload: true } }), /give bounds/, 'a link is for its bounds');
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

  // A banner from a file over HTTP (a path with a space, quoted for the shell): a link, nothing saved yet (no "Saved
  // the look"), then one curl.
  assert.match(await call('glitchless_set_dashboard', { banner: { remove: true } }), /Removed the banner\./);
  const banner = path.join(path.dirname(file), 'key art.png');
  fs.writeFileSync(banner, png(1600, 400));
  const bannerLink = await remote('glitchless_set_dashboard', { banner: { file: banner } });
  assert.match(bannerLink, /^hub: To send the banner, run this within 10 minutes: `curl -X PUT --data-binary @'[^']+key art\.png' '[^']+'`.*at most 300 KB and 4096 × 2048 pixels/, bannerLink);
  assert.match(await call('glitchless_dashboard', {}), /"banner": false/);
  assert.match(JSON.parse(await curl(bannerLink)).saved, /^Saved the banner: 1600 × 400 pixels\./);
  assert.match(await call('glitchless_dashboard', {}), /"banner": true/);
  // With focus, the focus is saved now and the picture follows by the link.
  assert.match(await remote('glitchless_set_dashboard', { logo: { file: logo }, banner: { file: banner, focus: 'bottom' } }), /^Saved the look of hub's boards\. To send the logo, .* To send the banner, .* The banner keeps its bottom in view\./);
  // Any server makes one when asked, for a picture with no file named; and not with base64 as well.
  const asked = await call('glitchless_set_dashboard', { logo: { upload: true } });
  assert.match(asked, /curl -X PUT --data-binary @<file> '/);
  assert.match(await call('glitchless_set_dashboard', { logo: { upload: true, image: png(8, 8).toString('base64') } }), /not both/);
});

// The curl command a set_dashboard answer gives, run in a shell as an agent runs it (not blocking this process, whose
// server answers it); its answer.
async function curl(text) {
  const command = /curl -X PUT --data-binary @(?:'[^']*'|[^\s`]+) '[^']+'/.exec(text)[0];
  return (await promisify(execFile)('sh', ['-c', `${command} --silent`], { encoding: 'utf8' })).stdout;
}

test("a server that makes no upload links: over HTTP a file gets the old way to send it, with a key", async (t) => {
  const old = http.createServer(createApp({ store, uploads: null, auth: { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read', 'dashboard'] }) }, logger: { warn() {}, error() {} } }));
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  t.after(() => old.close());
  const { connection } = await import('../src/context.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ remote: true, connection: connection({ base: `http://127.0.0.1:${old.address().port}`, service: 'hub' }) }).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const text = (await client.callTool({ name: 'glitchless_set_dashboard', arguments: { logo: { file: '/tmp/logo.png' } } })).content[0].text;
  assert.match(text, /makes no upload links and can't read files on your computer: pass the picture as image \(base64\), or upload it yourself with a secret key .*curl -X PUT '.*\/v1\/brand\/logo\?service=hub'.*--data-binary @\/tmp\/logo\.png/);
});
