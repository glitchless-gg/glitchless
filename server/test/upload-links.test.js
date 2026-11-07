// Upload links (upload-links.js, SPEC §3b): the dashboard scope makes a short-lived link for one slot of one game, and
// the link takes one picture with no key, checked and saved as the slot's own route would. A used or expired link is
// refused, a picture refused for its size or type leaves the link open, a game gets so many links an hour, and the
// token is in the answer that makes it and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { memoryUploads, isUploadToken, UPLOAD_LINKS } from '../src/upload-links.js';
import { STORES } from './helpers/stores.js';
import { png, jpeg, svg } from './helpers/images.js';

const readers = {
  writer: { projectId: 'p1', scopes: ['read', 'dashboard'] },
  reader: { projectId: 'p1', scopes: ['read'] },
  other: { projectId: 'p2', scopes: ['read', 'dashboard'] },
  share: { projectId: 'p1', scopes: ['read'], share: { id: 'share-1', service: 'starlift', page: 'overview' }, keyId: 'share', rps: 1000 },
};
const auth = {
  resolveIngest: () => ({ projectId: 'p1' }),
  resolveReader(req) {
    const r = readers[req.headers['x-test-reader']];
    if (!r) throw new AuthError(401, 'no key');
    return r;
  },
};

// A server on a port, and a request helper: who is the reader (none for an upload link), body a Buffer or JSON. Every
// request comes from its own address unless it names one, so the per-address limit stays out of the way.
async function serve(opts) {
  let n = 0;
  const server = http.createServer(createApp({ auth, clientAddress: (req) => req.headers['x-test-address'] ?? `10.0.0.${++n % 250}`, ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { who, body, address } = {}) => {
    const res = await fetch(p.startsWith('http') ? p : base + p, { method, headers: { ...(who ? { 'x-test-reader': who } : {}), ...(address ? { 'x-test-address': address } : {}), 'x-glitchless-client': 'claude-ai' }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  return { base, call, close: () => new Promise((r) => server.close(r)) };
}

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a link from the dashboard scope takes one banner and one background with no key, as their own routes would`, async () => {
    const { store, close: closeStore } = await make({ legacyProject: null });
    const { base, call, close } = await serve({ store, logger: { warn() {}, error() {} } });
    try {
      // Only a reader that may change the dashboard makes one; a share link never does.
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=banner', { who: 'reader' })).status, 403);
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=banner', { who: 'share' })).status, 403);
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=banner')).status, 401);
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=poster', { who: 'writer' })).status, 400);
      assert.equal((await call('POST', '/v1/uploads?slot=banner', { who: 'writer' })).status, 400, 'service is required');
      assert.equal((await call('GET', '/v1/uploads?service=starlift&slot=banner', { who: 'writer' })).status, 405);

      const made = await call('POST', '/v1/uploads?service=starlift&slot=banner', { who: 'writer' });
      assert.equal(made.status, 201);
      const link = made.json.upload;
      assert.ok(isUploadToken(link.path.split('/').pop()), link.path);
      assert.equal(link.url, `${base}${link.path}`, 'at the address the request came to');
      assert.deepEqual([link.service, link.slot, link.expires_in_s, link.max_bytes, link.max_width, link.max_height], ['starlift', 'banner', UPLOAD_LINKS.minutes * 60, 300 * 1024, 4096, 2048]);
      assert.equal(link.curl, `curl -X PUT --data-binary @<file> '${link.url}'`);
      assert.equal(made.headers.get('cache-control'), 'no-store');

      // Refused for its type, size or pixels: the link still works.
      assert.equal((await call('PUT', link.url, { body: svg })).status, 415);
      const big = await call('PUT', link.url, { body: jpeg(1600, 400, { pad: 300 * 1024 + 1 }) });
      assert.equal(big.status, 413);
      assert.match(big.json.error, /a banner is at most 300 KB\. The link still works until it expires/);
      assert.equal((await call('PUT', link.url, { body: png(5000, 100) })).status, 400);
      assert.equal((await call('GET', link.url)).status, 405, 'only PUT');
      assert.equal((await call('GET', '/v1/brand?service=starlift', { who: 'reader' })).json.brand, null, 'nothing saved yet');

      // The picture: saved as PUT /v1/brand/banner saves it, by the client that made the link.
      const sent = await call('PUT', link.url, { body: jpeg(1600, 400) });
      assert.equal(sent.status, 200);
      assert.equal(sent.json.saved, "Saved the banner: 1600 × 400 pixels. It shows on the game's boards and share links now.");
      assert.deepEqual([sent.json.brand.banner.width, sent.json.brand.banner.focus, sent.json.brand.updated_by], [1600, 'center', 'claude-ai']);
      const { brand } = (await call('GET', '/v1/brand?service=starlift', { who: 'reader' })).json;
      assert.equal(brand.banner.hash, sent.json.brand.banner.hash);
      assert.equal((await call('GET', '/v1/brand?service=starlift', { who: 'other' })).json.brand, null, "another project's reader sees none of it");

      // Used once: refused after, whatever is sent.
      const again = await call('PUT', link.url, { body: jpeg(800, 200) });
      assert.equal(again.status, 410);
      assert.match(again.json.error, /used up or has expired: each takes one picture, within 10 minutes/);
      assert.equal((await call('PUT', '/v1/uploads/gl_up_nope', { body: png() })).status, 404, 'not a link at all');

      // A background: its place, axis and bounds are checked when the link is made, and kept with it.
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=background&zone=hall&min=5,5&max=1,1', { who: 'writer' })).status, 400);
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=background&level=a&zone=hall&min=0,0&max=1,1', { who: 'writer' })).status, 400);
      assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=background&zone=hall&axis=yz&min=0,0&max=1,1', { who: 'writer' })).status, 400);
      const bg = (await call('POST', '/v1/uploads?service=starlift&slot=background&zone=hall&min=-50,-25&max=50,25', { who: 'writer' })).json.upload;
      assert.deepEqual([bg.zone, bg.axis, bg.min, bg.max, bg.max_bytes], ['hall', 'xz', '-50,-25', '50,25', 256 * 1024]);
      const stretched = await call('PUT', bg.url, { body: png(100, 100) });
      assert.equal(stretched.status, 201);
      assert.match(stretched.json.saved, /^Saved the background of zone hall: 100 × 100 pixels, seen from above\. .*stretched to fit them/);
      const maps = (await call('GET', '/v1/maps?service=starlift', { who: 'reader' })).json.maps;
      assert.deepEqual(maps.map((m) => [m.zone, m.uploaded, m.bounds]), [['hall', true, { min: [-50, -25], max: [50, 25] }]]);
      assert.equal((await call('PUT', bg.url, { body: png(200, 100) })).status, 410);

      // Two requests racing for one link: one picture is saved.
      const race = (await call('POST', '/v1/uploads?service=starlift&slot=logo', { who: 'writer' })).json.upload;
      const both = await Promise.all([call('PUT', race.url, { body: png(64, 64) }), call('PUT', race.url, { body: png(32, 32) })]);
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 410]);
    } finally {
      await close();
      await closeStore?.();
    }
  });
}

test('a link expires after 10 minutes, a game gets 30 an hour, an address sends 2 a second, and the token is never kept or logged', async () => {
  let t = Date.parse('2026-11-07T12:00:00Z');
  const now = () => t;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-uploads-'));
  const logged = [];
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map((k) => [k, (...a) => logged.push(a.map(String).join(' '))]));
  const { call, close } = await serve({ store: new FileStore(dir), uploads: memoryUploads({ now, origin: 'https://api.example' }), logger });
  try {
    const made = (await call('POST', '/v1/uploads?service=starlift&slot=logo', { who: 'writer' })).json.upload;
    assert.match(made.url, /^https:\/\/api\.example\/v1\/uploads\/gl_up_/, "the host's own address");
    assert.equal(made.expires_at, t + 10 * 60_000);
    const local = made.path; // the server is on 127.0.0.1, whatever the host calls itself
    t += 10 * 60_000 - 1;
    const open = await call('PUT', local, { body: svg });
    assert.equal(open.status, 415, 'still open a moment before');
    t += 1;
    assert.equal((await call('PUT', local, { body: png(64, 64) })).status, 410, 'expired');

    // 30 links a game an hour (the one above was the first), then the next hour.
    for (let i = 1; i < UPLOAD_LINKS.perHour; i++) assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=logo', { who: 'writer' })).status, 201);
    const refused = await call('POST', '/v1/uploads?service=starlift&slot=logo', { who: 'writer' });
    assert.equal(refused.status, 429);
    assert.match(refused.json.error, /at most 30 upload links an hour/);
    assert.equal((await call('POST', '/v1/uploads?service=starlift&slot=logo', { who: 'other' })).status, 201, 'another game has its own');
    t += 3_600_000;
    const later = (await call('POST', '/v1/uploads?service=starlift&slot=logo', { who: 'writer' })).json.upload;
    assert.ok(later);

    // One address sending fast (made-up tokens or not) is slowed: bursts of 4, then 429 with Retry-After.
    const fast = [];
    for (let i = 0; i < 5; i++) fast.push(await call('PUT', `/v1/uploads/gl_up_${'x'.repeat(43)}`, { body: png(), address: '192.0.2.7' }));
    assert.deepEqual(fast.map((r) => r.status), [410, 410, 410, 410, 429]);
    assert.ok(Number(fast[4].headers.get('retry-after')) >= 1);

    assert.equal((await call('PUT', later.path, { body: png(64, 64) })).status, 200);
    // The token is in the answer that made it and nowhere else: not in what the store keeps, nor in a log line.
    const token = later.path.split('/').pop();
    const kept = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => fs.readFileSync(path.join(dir, f), 'latin1'));
    assert.ok(kept.length);
    assert.ok(!kept.some((text) => text.includes(token) || text.includes('gl_up_')));
    assert.ok(!logged.some((line) => line.includes('gl_up_')), logged.join('\n'));
  } finally {
    await close();
  }
});

test("a server without a store's pictures or without links says so when a link is asked for", async () => {
  const noMaps = { kind: 'bare', getMaps: async () => [], getBrand: async () => null };
  const bare = await serve({ store: noMaps, logger: { warn() {}, error() {} } });
  const none = await serve({ store: noMaps, uploads: null, logger: { warn() {}, error() {} } });
  try {
    assert.equal((await bare.call('POST', '/v1/uploads?service=s&slot=background&min=0,0&max=1,1', { who: 'writer' })).status, 501);
    assert.equal((await none.call('POST', '/v1/uploads?service=s&slot=logo', { who: 'writer' })).status, 501);
    assert.equal((await none.call('PUT', `/v1/uploads/gl_up_${'x'.repeat(43)}`, { body: png() })).status, 404);
  } finally {
    await bare.close();
    await none.close();
  }
});
