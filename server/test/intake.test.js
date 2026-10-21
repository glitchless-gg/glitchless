// The browser SDK gzips batches but sends them as text/plain (no CORS preflight), so intake must
// accept gzip by its magic bytes, keep accepting plain JSON, and refuse broken or oversized gzip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';

async function serve() {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-intake-')));
  const server = http.createServer(createApp({ store, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (body) => {
    const res = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
    return { status: res.status, body: await res.json() };
  };
  return { base, send, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

// An anonymous-mode batch: no player ID.
const batch = (n = 3) =>
  JSON.stringify({
    service: 'zoomies',
    env: 'dev',
    version: '1.0.0',
    session_id: 's_intake_' + n,
    player_id: null,
    sdk: 'test',
    events: Array.from({ length: n }, (_, i) => ({ type: 'custom', ts: Date.now(), name: 'tick', attrs: { i } })),
  });

test('gzip and plain JSON bodies are both accepted', async () => {
  const app = await serve();
  try {
    assert.deepEqual(await app.send(batch(3)), { status: 202, body: { accepted: 3 } });
    assert.deepEqual(await app.send(gzipSync(batch(4))), { status: 202, body: { accepted: 4 } });
    const { sessions } = await (await fetch(`${app.base}/v1/query/sessions?service=zoomies`)).json();
    const stored = sessions.find((s) => s.session_id === 's_intake_4');
    assert.ok(stored, 'the gzipped session is stored');
    assert.equal(stored.player_id, 's_intake_4', 'a session without a player ID is filed under its session ID');
  } finally {
    await app.close();
  }
});

test('a broken gzip body is a 400, a gzip bomb is a 413', async () => {
  const app = await serve();
  try {
    const gz = gzipSync(batch(2));
    assert.deepEqual(await app.send(gz.subarray(0, gz.length - 12)), { status: 400, body: { error: 'invalid gzip body' } });
    const bomb = gzipSync(Buffer.alloc(9_000_000, 0x20)); // ~9 KB on the wire, 9 MB unpacked
    assert.ok(bomb.length < 1_000_000);
    assert.deepEqual(await app.send(bomb), { status: 413, body: { error: 'payload too large' } });
  } finally {
    await app.close();
  }
});
