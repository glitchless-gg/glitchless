// Projects are the tenancy boundary: a project's keys can neither write to nor read another project,
// whatever service names or ids a client sends. And the open-source default behaves as it always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { AuthError, RateLimiter, defaultAuth, envAuth } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { DynamoStore } from '../src/stores/dynamo.js';
import { buildContext, overview } from '../src/analytics.js';
import { normalize, parsePayload } from '../src/ingest.js';
import { FakeDynamo } from './helpers/fake-dynamo.js';
import { liveLake, hasDuckDB } from './helpers/lake-sim.js';
import { gameSessions } from './helpers/game-data.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-tenancy-'));

// What a hosted control plane does, minus the hashing and the database.
const KEYS = { A: { ingest: 'gl_pub_aaa', read: 'gl_read_aaa' }, B: { ingest: 'gl_pub_bbb', read: 'gl_read_bbb' } };
const twoProjects = {
  resolveIngest(token) {
    for (const [projectId, k] of Object.entries(KEYS)) if (token === k.ingest) return { projectId };
    throw new AuthError(403, 'invalid client token');
  },
  async resolveReader(req) {
    const key = req.headers['x-glitchless-api-key'] || new URL(req.url, 'http://x').searchParams.get('api_key');
    for (const [projectId, k] of Object.entries(KEYS)) if (key === k.read) return { projectId, scopes: ['read', 'delete'] };
    throw new AuthError(401, 'missing or invalid x-glitchless-api-key');
  },
};

async function serve(options) {
  const server = http.createServer(createApp({ logger: { warn() {}, error() {} }, ...options }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (token, payload) => fetch(`${base}/v1/intake?token=${token}`, { method: 'POST', body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const get = async (p, key, headers = {}) => {
    const res = await fetch(base + p, { headers: { ...(key ? { 'x-glitchless-api-key': key } : {}), ...headers } });
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  return { base, send, get, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

function payload(events, extra = {}) {
  const { service, env, version, session_id, player_id } = events[0];
  return { service, env, version, session_id, player_id, sdk: 'test', events: events.map(({ service, env, version, session_id, player_id, ...e }) => e), ...extra };
}

const now = Date.now();
const [sessionA] = gameSessions({ start: now - 3_600_000, spanMs: 60_000, sessions: 1, seed: 1, prefix: 'shared' });
const [sessionB] = gameSessions({ start: now - 3_600_000, spanMs: 60_000, sessions: 1, seed: 2, prefix: 'shared' });
// Same service and even the same session id in both projects: neither may pick the other's data.
for (const e of sessionB) e.version = '9.9.9';

const stores = {
  file: () => new FileStore(tmpdir(), { legacyProject: null }),
  dynamodb: () => new DynamoStore({ table: 't', doc: new FakeDynamo(), legacyProject: null, rollupsSince: 0 }),
  ...(hasDuckDB ? { lake: () => liveLake().store } : {}),
};

for (const [kind, makeStore] of Object.entries(stores)) {
  test(`${kind}: a project's keys can neither write to nor read another project`, async () => {
    const store = makeStore();
    const app = await serve({ store, auth: twoProjects });
    try {
      // Live tail for B opens before anything is sent.
      const tail = await fetch(`${app.base}/v1/live?service=zoomies&api_key=${KEYS.B.read}`);
      const reader = tail.body.getReader();

      // A payload can't choose its project: project_id in the body is overwritten by the key's project.
      assert.equal((await app.send(KEYS.A.ingest, payload(sessionA, { project_id: 'B' }))).status, 202);
      const forged = sessionA.map((e) => ({ ...e, project_id: 'B' }));
      assert.equal((await app.send(KEYS.A.ingest, payload(forged.slice(0, 3)))).status, 202);
      // A read key is not an ingest token, and an unknown token writes nowhere.
      assert.equal((await app.send(KEYS.A.read, payload(sessionA))).status, 403);
      assert.equal((await app.send('gl_pub_unknown', payload(sessionA))).status, 403);

      const bTail = await Promise.race([reader.read().then(({ value }) => new TextDecoder().decode(value)), new Promise((r) => setTimeout(() => r('silence'), 150))]);
      assert.equal(bTail.includes('shared_0'), false, `B's live tail saw A's events: ${bTail}`);

      assert.equal((await app.send(KEYS.B.ingest, payload(sessionB))).status, 202);
      let seen = '';
      while (!seen.includes('9.9.9')) seen += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();

      // Public ingest tokens never read, as a header or as ?api_key=.
      assert.equal((await app.get('/v1/query/services', KEYS.A.ingest)).status, 401);
      assert.equal((await app.get(`/v1/query/overview?service=zoomies&api_key=${KEYS.A.ingest}`)).status, 401);
      assert.equal((await app.get('/v1/live', KEYS.A.ingest)).status, 401);
      assert.equal((await app.get('/v1/query/services')).status, 401);

      const servicesA = (await app.get('/v1/query/services', KEYS.A.read)).body.services;
      const servicesB = (await app.get('/v1/query/services', KEYS.B.read)).body.services;
      assert.deepEqual(servicesA.map((s) => [s.service, s.versions]), [['zoomies', [sessionA[0].version]]]);
      assert.deepEqual(servicesB.map((s) => [s.service, s.versions]), [['zoomies', ['9.9.9']]]);

      // The same URL answers differently per project (and the query cache doesn't leak between them).
      const q = `/v1/query/sessions?service=zoomies&from=${now - 7_200_000}&to=${now}`;
      const listA = (await app.get(q, KEYS.A.read)).body.sessions;
      const listB = (await app.get(q, KEYS.B.read)).body.sessions;
      assert.deepEqual(listA.map((s) => s.version), [sessionA[0].version]);
      assert.deepEqual(listB.map((s) => s.version), ['9.9.9']);
      const overviewA = (await app.get(q.replace('sessions', 'overview'), KEYS.A.read)).body;
      assert.equal(overviewA.kpis.frame_p95, overview(buildContext(sessionA, { service: 'zoomies', from: now - 7_200_000, to: now, type: 'all' })).kpis.frame_p95);
      const detail = (await app.get(`/v1/query/session?service=zoomies&id=shared_0&from=${now - 7_200_000}&to=${now}`, KEYS.B.read)).body;
      assert.equal(detail.session.version, '9.9.9');

      // Agent activity stays with its project, and read keys never show up in it.
      await app.get(`${q}&api_key=${KEYS.A.read}`, null, { 'x-glitchless-client': 'claude-code' });
      assert.equal((await app.get('/v1/query/activity', KEYS.B.read)).body.activity.length, 0);
      const [act] = (await app.get('/v1/query/activity', KEYS.A.read)).body.activity;
      assert.equal(act.client, 'claude-code');
      assert.equal(JSON.stringify(act).includes(KEYS.A.read), false);

      if (kind !== 'dynamodb') {
        assert.equal((await fetch(`${app.base}/v1/data?service=zoomies`, { method: 'DELETE', headers: { 'x-glitchless-api-key': KEYS.B.read } })).status, 200);
        assert.equal((await app.get(q, KEYS.B.read)).body.sessions.length, 0);
        assert.equal((await app.get(q, KEYS.A.read)).body.sessions.length, 1);
      }
    } finally {
      await app.close();
    }
  });
}

test('ingest stamps the project of the key on every event, over anything the payload says', () => {
  const body = JSON.stringify(payload(sessionA.slice(0, 3).map((e) => ({ ...e, project_id: 'B' })), { project_id: 'B' }));
  assert.deepEqual([...new Set(normalize(parsePayload(body, { projectId: 'A' })).map((e) => e.project_id))], ['A']);
});

test('stores keep every method inside its project', async () => {
  for (const store of Object.values(stores).map((make) => make())) {
    const map = { ...sessionA[0], type: 'map', level: 'level-1', axis: 'xz', image: 'data:image/jpeg;base64,AA' };
    await store.put('A', [...sessionA, map]);
    await store.put('B', sessionB);
    const range = { service: 'zoomies', from: now - 7_200_000, to: now };
    assert.ok((await store.query('A', range)).every((e) => e.project_id === 'A' && e.version !== '9.9.9'));
    assert.ok((await store.query('B', range)).every((e) => e.project_id === 'B' && e.version === '9.9.9'));
    assert.equal((await store.query('C', range)).length, 0);
    assert.equal((await store.getMaps('A', 'zoomies')).length, 1);
    assert.equal((await store.getMaps('B', 'zoomies')).length, 0);
    const fw = (r) => [...r.minutes.values()].flatMap((cells) => [...cells.values()]).reduce((n, c) => n + c.fw, 0);
    assert.equal(fw(await store.rollups('B', range)), sessionB.filter((e) => e.type === 'frame_window').length);
    assert.equal(fw(await store.rollups('C', range)), 0);
    assert.deepEqual(await store.services('C'), []);
    await assert.rejects(store.query('A#zoomies', range), /invalid projectId/);
  }
});

test('open-source default: gl_pub_dev writes, reads are open, everything lands in one project', async () => {
  const dir = tmpdir();
  const app = await serve({ store: new FileStore(dir) });
  try {
    assert.equal((await app.send('gl_pub_dev', payload(sessionA))).status, 202);
    const bad = await app.send('nope', payload(sessionA));
    assert.equal(bad.status, 403);
    assert.deepEqual(await bad.json(), { error: 'invalid client token' });
    const { status, body } = await app.get('/v1/query/sessions?service=zoomies&from=0');
    assert.equal(status, 200);
    assert.equal(body.sessions.length, 1);
    // Payload caps still hold.
    // Over 1 MB the server answers 413 and drops the connection, so the client may only see the drop.
    const huge = await app.send('gl_pub_dev', 'x'.repeat(1_000_001)).then((r) => r.status, (err) => err.cause?.code);
    assert.ok([413, 'UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(huge), `oversized payload: ${huge}`);
    assert.equal((await app.send('gl_pub_dev', '{nope')).status, 400);
    const many = payload(Array.from({ length: 600 }, (_, i) => ({ ...sessionA[0], type: 'custom', name: 'tick', ts: now - i })));
    assert.deepEqual(await (await app.send('gl_pub_dev', many)).json(), { accepted: 500 });
  } finally {
    await app.close();
  }
  const lines = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('events-'))), 'utf8').trim().split('\n');
  assert.ok(lines.every((l) => JSON.parse(l).project_id === 'default'));
});

test('open-source default with GLITCHLESS_API_KEY: the read key guards queries, the live tail and deletes', async () => {
  const auth = envAuth({ GLITCHLESS_CLIENT_TOKENS: 'gl_pub_dev, gl_pub_game', GLITCHLESS_API_KEY: 'gl_read_secret' });
  const app = await serve({ store: new FileStore(tmpdir()), auth });
  try {
    assert.equal((await app.send('gl_pub_game', payload(sessionA))).status, 202);
    const denied = await app.get('/v1/query/services');
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: 'missing or invalid x-glitchless-api-key' });
    assert.equal((await app.get('/v1/query/services', 'gl_pub_dev')).status, 401);
    assert.equal((await app.get('/v1/query/services', 'gl_read_secret')).status, 200);
    assert.equal((await app.get('/v1/query/services?api_key=gl_read_secret')).status, 200);
    assert.equal((await app.get('/v1/health')).status, 200);
    assert.equal((await fetch(`${app.base}/v1/data?service=zoomies`, { method: 'DELETE' })).status, 401);
  } finally {
    await app.close();
  }
  assert.throws(() => envAuth({ GLITCHLESS_CLIENT_TOKENS: 'gl_pub_dev', GLITCHLESS_API_KEY: 'gl_pub_dev' }), /must not also be a public client token/);
});

test('data written before projects existed still belongs to the open-source project', async () => {
  const dir = tmpdir();
  const legacy = sessionA.map(({ project_id, ...e }) => e);
  fs.writeFileSync(path.join(dir, `events-${new Date(now).toISOString().slice(0, 10)}.jsonl`), legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'maps.json'), JSON.stringify([{ ...legacy[0], type: 'map', level: 'level-1', image: 'data:image/jpeg;base64,AA' }]));
  const file = new FileStore(dir);
  const range = { service: 'zoomies', from: now - 7_200_000, to: now };
  assert.equal((await file.query('default', range)).length, legacy.length);
  assert.equal((await file.getMaps('default', 'zoomies')).length, 1);
  assert.equal((await file.query('other', range)).length, 0);
  assert.equal((await new FileStore(dir, { legacyProject: null }).query('default', range)).length, 0);

  // DynamoDB: items keyed the old way ("<service>#<hour>", "MAP#…", "SERVICE").
  const doc = new FakeDynamo();
  for (const e of legacy) doc.put({ pk: `zoomies#${new Date(e.ts).toISOString().slice(0, 13)}`, sk: `${e.ts}#${e.session_id}#${Math.random()}`, e: JSON.stringify(e) });
  doc.put({ pk: 'SERVICE', sk: 'zoomies', versions: new Set([legacy[0].version]), envs: new Set(['prod']), last_seen: now });
  doc.put({ pk: 'MAP#zoomies', sk: 'level-1#1.0.0', e: JSON.stringify({ level: 'level-1' }) });
  const dynamo = new DynamoStore({ table: 't', doc });
  assert.equal((await dynamo.query('default', range)).length, legacy.length);
  assert.equal((await dynamo.services('default'))[0].service, 'zoomies');
  assert.equal((await dynamo.getMaps('default', 'zoomies')).length, 1);
  assert.equal((await dynamo.query('other', range)).length, 0);
  assert.deepEqual(await dynamo.services('other'), []);
  // New writes for the same project are read alongside the old ones (by a fresh process: finished
  // hours are cached).
  await dynamo.put('default', sessionB);
  assert.equal((await new DynamoStore({ table: 't', doc }).query('default', range)).length, legacy.length + sessionB.length);
});

test('ingest is rate limited per key', async () => {
  const app = await serve({ store: new FileStore(tmpdir()), auth: defaultAuth({ clientTokens: ['gl_pub_one', 'gl_pub_two'], ingestRps: 2 }) });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await app.send('gl_pub_one', payload(sessionA.slice(0, 2)))).status);
    assert.deepEqual(statuses, [202, 202, 202, 202, 429, 429]);
    const limited = await app.send('gl_pub_one', payload(sessionA.slice(0, 2)));
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal((await app.send('gl_pub_two', payload(sessionA.slice(0, 2)))).status, 202);
  } finally {
    await app.close();
  }
  let t = 0;
  const limiter = new RateLimiter({ now: () => t });
  assert.equal([0, 0, 0, 0].map(() => limiter.take('k', 1)).filter((w) => w === 0).length, 2);
  t += 1000;
  assert.equal(limiter.take('k', 1), 0);
  assert.equal(limiter.take('k', 0), 0, 'rps 0 means unlimited');
});
