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
import { normalize } from '../src/ingest.js';
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

test('a beacon from a cross-origin-isolated page (a Godot web export with threads) may read the answer', async () => {
  const app = await serve();
  try {
    const res = await fetch(`${app.base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: batch(1), headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
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

// The rest of a session an engine SDK's outbox cut in two (SPEC §2 session_start.continued): its session_start comes
// again first, so the session has its own type and device, where before it had neither and counted as a player's.
test('a continued session_start gives the rest of a cut session its type and device; continued is kept only when true', async () => {
  const app = await serve();
  try {
    const now = Date.now();
    const rest = (sid, start) => JSON.stringify({ service: 'starlift', env: 'prod', version: '1.1.3', session_id: sid, sdk: 'glitchless-godot/0.6.0', batch_id: `b_${sid.slice(2)}`, events: [...(start ? [start] : []), { type: 'error', ts: now - 30_000, kind: 'engine', message: 'active uniforms exceed GL_MAX_FRAGMENT_UNIFORM_VECTORS (261)', fingerprint: '9803ec1a' }] });
    const start = { type: 'session_start', ts: now - 40_000, session_type: 'synthetic', privacy: 'anonymous', device: { browser: 'Godot', os: 'Android', gpu_tier: 'low' } };
    assert.equal((await app.send(rest('s_before0000000001', null))).status, 202);
    assert.equal((await app.send(rest('s_continued00000001', { ...start, continued: true }))).status, 202);
    assert.equal((await app.send(rest('s_notatrue00000001', { ...start, continued: 'yes' }))).status, 202);
    const { sessions } = await (await fetch(`${app.base}/v1/query/sessions?service=starlift&from=${now - 3_600_000}&to=${now + 60_000}`)).json();
    const by = Object.fromEntries(sessions.map((s) => [s.session_id, s]));
    assert.equal(by.s_before0000000001.session_type, 'user', 'without it, the rest looked like a player with no device');
    assert.equal(by.s_continued00000001.session_type, 'synthetic');
    assert.match(by.s_continued00000001.browser ?? '', /^Godot/);
    const envelope = { service: 'starlift', env: 'prod', version: '1.1.3', session_id: 's_x', sdk: 'glitchless-godot/0.6.0' };
    const kept = (continued) => normalize({ envelope, events: [{ ...start, continued }] }, now)[0];
    assert.equal(kept(true).continued, true);
    assert.ok(!('continued' in kept('yes')) && !('continued' in kept(1)), 'anything but true is dropped');
  } finally {
    await app.close();
  }
});
