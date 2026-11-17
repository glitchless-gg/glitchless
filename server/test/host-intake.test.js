// Intake from the host itself (app.js handle.intake): a host that measures its own service in a game of its own sends
// that game's batches in process, several sessions in one store write. They land as a game's batches do (queries,
// the host's count of each batch), with no rate limit and no batch claim, and a failed store write stores nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { defaultAuth } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';

const now = Date.now();
const t0 = now - 3 * 60_000;

function setup({ ingestRps = 1 } = {}) {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-host-')));
  const writes = [];
  const put = store.put.bind(store);
  store.put = async (projectId, events, identity) => {
    writes.push(events.length);
    return put(projectId, events, identity);
  };
  const recorded = [];
  const auth = { ...defaultAuth({ ingestRps }), recordIntake: (writer, events) => recorded.push(events.map((e) => e.session_id)) };
  const app = createApp({ store, auth, logger: { warn() {}, error() {} } });
  return { app, store, writes, recorded };
}

const payload = (session, batch, events) => ({ service: 'app.example', env: 'prod', version: '1', session_id: session, player_id: `p_${session}`, sdk: 'host', batch_id: batch, events });

test("the host's own batches: several sessions in one store write, each counted as its own batch", async () => {
  const { app, store, writes, recorded } = setup();
  const got = await app.intake('gl_pub_dev', [
    payload('s_a', 'b_aaaaaaaaaaaaaaaa', [{ type: 'session_start', ts: t0, session_type: 'user' }, { type: 'custom', ts: t0 + 1, name: 'active', attrs: {} }]),
    payload('s_b', 'b_bbbbbbbbbbbbbbbb', [{ type: 'custom', ts: t0 + 2, name: 'tool_call', attrs: { tool: 'x' } }]),
    payload('s_a', 'b_cccccccccccccccc', [{ type: 'custom', ts: t0 + 3, name: 'tool_call', attrs: { tool: 'y' } }]),
  ]);
  assert.deepEqual(got, { accepted: 4 });
  assert.deepEqual(writes, [4], 'one store write');
  assert.deepEqual(recorded, [['s_a', 's_a'], ['s_b'], ['s_a']], "the host's count sees each batch");
  const rows = await store.query('default', { service: 'app.example', from: t0 - 1, to: now });
  const what = rows.map((e) => [e.session_id, e.player_id, e.name ?? e.type].join(' ')).sort();
  assert.deepEqual(what, ['s_a p_s_a active', 's_a p_s_a session_start', 's_a p_s_a tool_call', 's_b p_s_b tool_call']);
});

test("the host's own batches have no rate limit and no batch claim: nothing resends them", async () => {
  const { app, writes } = setup({ ingestRps: 1 });
  for (let i = 0; i < 20; i++) assert.deepEqual(await app.intake('gl_pub_dev', [payload('s_c', 'b_samebatch000000', [{ type: 'custom', ts: t0 + i, name: 'n', attrs: {} }])]), { accepted: 1 });
  assert.equal(writes.length, 20);
});

test("a host's batch stored, then something after it fails: the call still says it was taken, so it's never sent again", async () => {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-host-')));
  const warned = [];
  const forwarder = {
    forward() {
      throw new Error('forwarder broke (test)');
    },
  };
  const app = createApp({ store, forwarder, auth: defaultAuth(), logger: { warn: (...a) => warned.push(a.join(' ')), error() {} } });
  assert.deepEqual(await app.intake('gl_pub_dev', [payload('s_e', 'b_eeeeeeeeeeeeeeee', [{ type: 'session_start', ts: t0, session_type: 'user' }])]), { accepted: 1 });
  assert.equal((await store.query('default', { service: 'app.example', from: t0 - 1, to: now })).length, 1);
  assert.ok(warned.some((w) => w.includes('forwarder broke')));
});

test("a host's batch that fails stores nothing and says so", async () => {
  const { app, store, recorded } = setup();
  store.put = () => Promise.reject(new Error('store down'));
  await assert.rejects(app.intake('gl_pub_dev', [payload('s_d', 'b_dddddddddddddddd', [{ type: 'session_start', ts: t0, session_type: 'user' }])]), /store down/);
  assert.deepEqual(recorded, []);
  await assert.rejects(app.intake('gl_pub_wrong', [payload('s_d', 'b_dddddddddddddddd', [])]), /invalid client token/);
});
