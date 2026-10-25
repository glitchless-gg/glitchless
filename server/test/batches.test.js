// A batch delivered twice is stored once (SPEC §2 batch_id). A game resends a batch when it never saw the answer
// to the first try: the request timed out on a phone that stalled, or the game went to the background and sent it
// again itself. Starlift's first batches arrived up to 8 times that way. Every store takes a batch ID once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';
import { parsePayload } from '../src/ingest.js';
import { STORES } from './helpers/stores.js';

const now = Date.now();
// The session played a few minutes ago: a store that answers whole minutes up to its compactor's watermark (the lake)
// has all of it, whatever second of the minute this file loads at.
const t0 = now - 3 * 60_000;

function body(sessionId, batchId, events) {
  return JSON.stringify({ service: 'zoomies', env: 'prod', version: '1.0.0', session_id: sessionId, player_id: null, sdk: 'test', ...(batchId ? { batch_id: batchId } : {}), events });
}

const first = (sid) => [
  { type: 'session_start', ts: t0, level: null, session_type: 'user', device: { browser: 'Godot', os: 'iOS' } },
  { type: 'custom', ts: t0 + 1000, level: null, name: 'open', attrs: { what: 'free' } },
  { type: 'hitch', ts: t0 + 2000, level: null, duration_ms: 1610, causes: ['shader_compile', 'frozen'] },
];

async function serve(store) {
  const server = http.createServer(createApp({ store, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (b) => {
    const res = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: b });
    return { status: res.status, body: await res.json() };
  };
  const get = async (name, params = {}) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: 'zoomies', from: now - 3_600_000, to: now + 60_000, ...params })}`)).json();
  return { send, get, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

test('batch_id is read from the payload when it looks like an ID', () => {
  assert.equal(parsePayload(body('s_1', 'b_k2j4h5g6f7d8s9a0', [])).batch, 'b_k2j4h5g6f7d8s9a0');
  assert.equal(parsePayload(body('s_1', null, [])).batch, null);
  assert.equal(parsePayload(body('s_1', 'short', [])).batch, null);
  assert.equal(parsePayload(body('s_1', 'b_has spaces in it', [])).batch, null);
  assert.equal(parsePayload(JSON.stringify({ service: 'z', session_id: 's', events: [], batch_id: 12345678 })).batch, null);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind}: a batch sent again is answered as taken and stored once`, async () => {
    const made = await make();
    const app = await serve(made.store);
    try {
      const b = body('s_3mvfmbg6ddrslf25', 'b_3mvfmbg6ddrslf25', first());
      assert.deepEqual(await app.send(b), { status: 202, body: { accepted: 3 } });
      for (let i = 0; i < 7; i++) assert.deepEqual(await app.send(b), { status: 202, body: { accepted: 0, duplicate: true } });
      // The same batch saved by a game that closed and replayed under a new session ID (anonymous mode) is a repeat too.
      assert.deepEqual((await app.send(body('s_replayed000000', 'b_3mvfmbg6ddrslf25', first()))).body, { accepted: 0, duplicate: true });
      // The next batch of the session, and a batch of another game with the same ID, are new.
      assert.equal((await app.send(body('s_3mvfmbg6ddrslf25', 'b_nextbatch000001', [{ type: 'session_end', ts: t0 + 10_000, level: null, reason: 'background', duration_s: 10 }]))).body.accepted, 1);
      assert.equal((await app.send(JSON.stringify({ ...JSON.parse(b), service: 'other-game' }))).body.accepted, 3);
      // An older SDK sends no batch ID: every copy is kept, as before.
      const old = body('s_old0000000000', null, first());
      assert.equal((await app.send(old)).body.accepted, 3);
      assert.equal((await app.send(old)).body.accepted, 3);
      await made.settle?.();

      const { session, timeline } = await app.get('session', { id: 's_3mvfmbg6ddrslf25' });
      assert.equal(session.events.open, 1, 'the open event once, not eight times');
      assert.equal(session.hitches, 0);
      assert.deepEqual(
        timeline.map((e) => e.type),
        ['session_start', 'custom', 'hitch', 'session_end'],
      );
      assert.equal((await app.get('session', { id: 's_replayed000000' })).error, 'session not found');
      assert.equal((await app.get('session', { id: 's_old0000000000' })).session.events.open, 2);
    } finally {
      await app.close();
      await made.close?.();
    }
  });

  test(`${kind}: a batch the store failed to keep can be sent again`, async () => {
    const made = await make();
    const store = made.store;
    const put = store.put.bind(store);
    let fail = true;
    store.put = (...args) => (fail ? Promise.reject(new Error('disk full')) : put(...args));
    const app = await serve(store);
    try {
      const b = body('s_retry000000000', 'b_retry000000000', first());
      assert.equal((await app.send(b)).status, 500);
      fail = false;
      assert.deepEqual(await app.send(b), { status: 202, body: { accepted: 3 } });
      assert.deepEqual((await app.send(b)).body, { accepted: 0, duplicate: true });
    } finally {
      await app.close();
      await made.close?.();
    }
  });
}

test('file: batch IDs are remembered across a restart, and forgotten after 7 days', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-batches-'));
  const a = new FileStore(dir);
  assert.equal(await a.claimBatch('p_default', 'zoomies', 'b_aaaaaaaaaaaaaaaa'), true);
  assert.equal(await a.claimBatch('p_default', 'zoomies', 'b_bbbbbbbbbbbbbbbb'), true);
  await a.releaseBatch('p_default', 'zoomies', 'b_bbbbbbbbbbbbbbbb');
  // A line from 8 days ago, as an older run left it.
  fs.appendFileSync(path.join(dir, 'batches.jsonl'), JSON.stringify({ p: 'p_default', s: 'zoomies', b: 'b_cccccccccccccccc', at: now - 8 * 86_400_000 }) + '\n');
  const b = new FileStore(dir);
  assert.equal(await b.claimBatch('p_default', 'zoomies', 'b_aaaaaaaaaaaaaaaa'), false, 'taken before the restart');
  assert.equal(await b.claimBatch('p_default', 'zoomies', 'b_bbbbbbbbbbbbbbbb'), true, 'released, so new');
  assert.equal(await b.claimBatch('p_default', 'zoomies', 'b_cccccccccccccccc'), true, 'older than 7 days');
  assert.equal(await b.claimBatch('p_default', 'other', 'b_aaaaaaaaaaaaaaaa'), true, 'another game');
  assert.equal(fs.readFileSync(path.join(dir, 'batches.jsonl'), 'utf8').includes('"del"'), false, 'the file is rewritten without released or expired lines at startup');
});
