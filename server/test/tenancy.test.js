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
import { buildContext, overview } from '../src/analytics.js';
import { evaluateBoard } from '../src/board.js';
import { normalize, parsePayload } from '../src/ingest.js';
import { STORES } from './helpers/stores.js';
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

const stores = Object.fromEntries(Object.entries(STORES).map(([kind, make]) => [kind, () => make({ legacyProject: null }).store]));

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

// Bug reports are stored apart from the events (reports.js), so they get their own check.
for (const [kind, makeStore] of Object.entries(stores)) {
  test(`${kind}: a project's bug reports can't be listed or opened by another project`, async () => {
    const store = makeStore();
    const app = await serve({ store, auth: twoProjects });
    try {
      // The same session id, time and note in both projects: still two reports, one each.
      const report = { ...sessionA.at(-1), type: 'bug_report', ts: sessionA.at(-1).ts + 1000, level: 'level-1', note: 'stuck', screenshot: 'data:image/jpeg;base64,AAAA' };
      assert.equal((await app.send(KEYS.A.ingest, payload([...sessionA, report]))).status, 202);
      const q = `/v1/query/reports?service=zoomies&from=${now - 7_200_000}&to=${now}`;
      const [mine] = (await app.get(q, KEYS.A.read)).body.reports;
      assert.equal(mine.note, 'stuck');
      assert.deepEqual((await app.get(q, KEYS.B.read)).body.reports, []);
      assert.equal((await app.get(`/v1/query/report?service=zoomies&id=${mine.id}`, KEYS.B.read)).body.error, 'report not found');
      assert.equal((await app.get(`/v1/query/report?service=zoomies&id=${mine.id}`, KEYS.A.read)).body.report.screenshot, report.screenshot);
      assert.equal((await app.get(`/v1/query/report?service=zoomies&id=${mine.id}`, KEYS.A.ingest)).status, 401);
      assert.equal((await app.send(KEYS.B.ingest, payload([...sessionB, { ...report, version: '9.9.9' }]))).status, 202);
      const [theirs] = (await app.get(q, KEYS.B.read)).body.reports;
      assert.notEqual(theirs.id, mine.id);
      assert.deepEqual((await app.get(q, KEYS.A.read)).body.reports.map((r) => r.id), [mine.id]);
      assert.equal((await app.get(`/v1/query/report?service=zoomies&id=${theirs.id}`, KEYS.A.read)).body.error, 'report not found');
      // Nor deleted by it.
      const del = (id, key) => fetch(`${app.base}/v1/report?service=zoomies&id=${id}`, { method: 'DELETE', headers: { 'x-glitchless-api-key': key } });
      assert.equal((await del(mine.id, KEYS.B.read)).status, 404);
      assert.equal((await del(mine.id, KEYS.A.ingest)).status, 401);
      assert.equal((await app.get(q, KEYS.A.read)).body.reports.length, 1);
      assert.equal((await del(mine.id, KEYS.A.read)).status, 200);
      assert.deepEqual((await app.get(q, KEYS.A.read)).body.reports, []);
      assert.equal((await app.get(q, KEYS.B.read)).body.reports.length, 1);
    } finally {
      await app.close();
    }
  });
}

// Source maps are uploaded with a secret key (sourcemaps.js): one project's maps never map, list or leave another's.
for (const [kind, makeStore] of Object.entries(stores)) {
  test(`${kind}: a project's source maps can't be listed, used or deleted by another project`, async () => {
    const store = makeStore();
    const scoped = { ...twoProjects, async resolveReader(req) {
      const id = await twoProjects.resolveReader(req);
      return { ...id, scopes: [...id.scopes, 'sourcemaps'] };
    } };
    const app = await serve({ store, auth: scoped });
    try {
      const map = JSON.stringify({ version: 3, sources: ['src/weapons.js'], sourcesContent: ['function fireShotgun() {\n  e.hp -= 1;\n}'], names: [], mappings: 'AAAA,IACE' });
      const up = (key, version = '1.0.0') => fetch(`${app.base}/v1/sourcemaps?service=zoomies&version=${version}&file=assets/index-1.js`, { method: 'POST', body: map, headers: { 'x-glitchless-api-key': key } });
      assert.equal((await up(KEYS.A.read)).status, 201);
      // A public ingest token never uploads.
      assert.equal((await up(KEYS.B.ingest)).status, 401);
      const listed = async (key) => (await app.get('/v1/sourcemaps?service=zoomies', key)).body.sourcemaps.map((m) => m.version);
      assert.deepEqual(await listed(KEYS.A.read), ['1.0.0']);
      assert.deepEqual(await listed(KEYS.B.read), []);
      // The same game, version and script in both projects: only A's error is mapped.
      const error = { type: 'error', ts: sessionA[0].ts + 1000, kind: 'js', message: 'TypeError: x', stack: 'TypeError: x\n    at e (https://g.io/assets/index-1.js:1:5)', fn: 'e', source: 'index-1.js', line: 1, col: 5, fingerprint: 'sdk00001' };
      for (const [k, s] of [[KEYS.A, sessionA], [KEYS.B, sessionB]]) assert.equal((await app.send(k.ingest, payload([s[0], { ...error, version: '1.0.0', session_id: s[0].session_id }].map((e) => ({ ...e, version: '1.0.0' }))))).status, 202);
      const issues = async (key) => (await app.get(`/v1/query/errors?service=zoomies&version=1.0.0&from=${now - 7_200_000}&to=${now}`, key)).body.issues;
      const [a] = await issues(KEYS.A.read);
      const [b] = await issues(KEYS.B.read);
      assert.equal(a.location, 'fireShotgun (weapons.js:2)');
      assert.notEqual(a.fingerprint, 'sdk00001');
      assert.equal(b.location, 'e (index-1.js:1)');
      assert.equal(b.fingerprint, 'sdk00001');
      // Nor deleted by it.
      const del = (key) => fetch(`${app.base}/v1/sourcemaps?service=zoomies&version=1.0.0`, { method: 'DELETE', headers: { 'x-glitchless-api-key': key } });
      assert.equal((await del(KEYS.B.read)).status, 404);
      assert.deepEqual(await listed(KEYS.A.read), ['1.0.0']);
      assert.equal((await del(KEYS.A.read)).status, 200);
      assert.deepEqual(await listed(KEYS.A.read), []);
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

// A share reader (a read-only link anyone may hold) reads one board page of one service, at most 30 days back,
// with nothing in it that names a session, a player, a device or a line of code.
test('a share reader reads its one board and nothing else', async () => {
  const SHARE = { id: 'share-1', service: 'zoomies', page: 'jam' };
  const readers = {
    full: { projectId: 'A', scopes: ['read', 'delete', 'dashboard'] },
    share: { projectId: 'A', scopes: ['read', 'delete', 'dashboard'], share: SHARE, keyId: SHARE.id, rps: 1000 },
    slow: { projectId: 'A', scopes: ['read'], share: SHARE, keyId: 'slow', rps: 1 },
    plain: { projectId: 'A', scopes: ['read'], share: SHARE, keyId: 'plain' },
  };
  // Pinned links: the first two sessions' minute (t0 is set below), and a window longer than any link may read.
  const t0 = now - 3_600_000;
  readers.pinned = { projectId: 'A', scopes: ['read'], share: { ...SHARE, id: 'pin', from: t0 - 7_200_000, to: t0 + 1500 }, keyId: 'pin', rps: 1000 };
  readers.wide = { projectId: 'A', scopes: ['read'], share: { ...SHARE, id: 'wide', from: now - 60 * 86_400_000, to: now }, keyId: 'wide', rps: 1000 };
  const auth = {
    resolveIngest: () => ({ projectId: 'A' }),
    resolveReader(req) {
      const reader = readers[req.headers['x-glitchless-api-key']];
      if (!reader) throw new AuthError(401, 'no');
      return reader;
    },
  };
  const app = await serve({ store: new FileStore(tmpdir(), { legacyProject: null }), auth });
  try {
    for (let i = 0; i < 4; i++) {
      const base = { service: 'zoomies', env: 'prod', version: '1.0.0', session_id: `secret_session_${i}`, player_id: `secret_player_${i}` };
      const events = [
        { type: 'session_start', ts: t0 + i * 1000, session_type: 'user', device: { browser: 'SecretBrowser', os: 'SecretOS', gpu: 'SecretGPU', gpu_tier: 'high' } },
        { type: 'level_start', ts: t0 + i * 1000 + 10, level: 'level-1' },
        { type: 'custom', ts: t0 + i * 1000 + 20, level: 'level-1', name: 'opened_secret_door', attrs: { kind: i % 2 ? 'big' : 'small' } },
        { type: 'error', ts: t0 + i * 1000 + 30, level: 'level-1', kind: 'js', message: 'TypeError: boom', fn: 'tick', source: 'secret-file.js', line: 7, stack: 'TypeError: boom\n    at tick (secret-file.js:7:1)' },
        { type: 'session_end', ts: t0 + i * 1000 + 40, reason: 'pagehide' },
      ].map((e) => ({ ...base, ...e }));
      assert.equal((await app.send('any', payload(events))).status, 202);
    }
    assert.equal((await app.send('any', payload([{ service: 'other', env: 'prod', version: '1', session_id: 'o1', player_id: 'o1', type: 'session_start', ts: t0 }]))).status, 202);
    const board = { id: 'jam', title: 'Jam', panels: [{ type: 'stat', metric: 'sessions' }, { type: 'sessions' }, { type: 'errors' }, { type: 'findings' }, { type: 'live' }, { type: 'breakdown', event: 'opened_secret_door', by: 'kind' }] };
    const put = await fetch(`${app.base}/v1/dashboard?service=zoomies`, { method: 'PUT', headers: { 'x-glitchless-api-key': 'full' }, body: JSON.stringify({ pages: [board, { id: 'private', title: 'Private', panels: [{ type: 'sessions' }] }, { id: 'errors', view: 'errors' }] }) });
    assert.equal(put.status, 200);

    // services: its own service only, and ranges up to 30 days.
    const services = (await app.get('/v1/query/services', 'share')).body;
    assert.deepEqual(services.services.map((s) => s.service), ['zoomies']);
    assert.equal(services.max_range_days, 30);

    // The board: its page whatever the request leaves out, and the same answer for the same filters.
    const shared = await app.get(`/v1/query/board?from=${now - 7_200_000}&to=${now}`, 'share');
    assert.equal(shared.status, 200);
    assert.equal(shared.body.board.page, 'jam');
    const panel = (type) => shared.body.board.panels.find((p) => p.type === type);
    assert.equal(panel('stat').value, 4);
    assert.equal(panel('sessions').sessions.length, 4);
    assert.equal(panel('sessions').sessions[0].version, '1.0.0');
    assert.equal(panel('errors').issues[0].message, 'TypeError: boom');
    const stability = panel('findings').findings.find((f) => f.category === 'stability');
    assert.equal(stability.title, 'TypeError: boom');
    assert.equal(stability.summary, '4 occurrences in 4 sessions on level-1.');
    assert.equal(panel('live').empty, true);
    assert.deepEqual(panel('breakdown').rows.map((r) => r.value).sort(), ['big', 'small']);
    const text = JSON.stringify(shared.body);
    for (const secret of ['secret_session', 'secret_player', 'SecretBrowser', 'SecretOS', 'SecretGPU', 'secret-file.js', 'stack', 'breadcrumbs', 'evidence', 'Private'])
      assert.equal(text.includes(secret), false, `a shared board shows ${secret}`);

    // Members still get the whole board at the same URL, before and after (the query cache keeps them apart).
    const full = (await app.get(`/v1/query/board?service=zoomies&page=jam&from=${now - 7_200_000}&to=${now}`, 'full')).body;
    assert.ok(full.board.panels.find((p) => p.type === 'sessions').sessions[0].session_id.startsWith('secret_session'));
    const again = (await app.get(`/v1/query/board?service=zoomies&page=jam&from=${now - 7_200_000}&to=${now}`, 'share')).body;
    assert.equal(JSON.stringify(again).includes('secret_session'), false);

    // Filters and ids in the request don't reach the query; ranges stop at 30 days.
    const narrowed = (await app.get(`/v1/query/board?sessions=secret_session_0&env=dev&version=9&from=${now - 7_200_000}&to=${now}`, 'share')).body;
    assert.equal(narrowed.board.panels[0].value, 4);
    const long = (await app.get(`/v1/query/board?from=${now - 400 * 86_400_000}&to=${now}`, 'share')).body;
    assert.equal(long.meta.to - long.meta.from <= 30 * 86_400_000 + 60_000, true, `range ${long.meta.from}..${long.meta.to}`);

    // A pinned link answers its own window, whatever the request asks; the rolling one is unchanged.
    const pin = readers.pinned.share;
    for (const q of ['', `?from=0&to=${now}`, `?from=${now - 86_400_000}&to=${now}&service=zoomies&page=jam`]) {
      const res = (await app.get(`/v1/query/board${q}`, 'pinned')).body;
      assert.deepEqual([res.meta.from, res.meta.to], [pin.from, pin.to], q);
      assert.equal(res.board.panels[0].value, 2, `sessions in the pinned window ${q}`);
    }
    assert.deepEqual((await app.get('/v1/query/services', 'pinned')).body.window, { from: pin.from, to: pin.to });
    assert.equal((await app.get('/v1/query/services', 'share')).body.window, null);
    assert.equal((await app.get(`/v1/query/services?from=${pin.from}&to=${pin.to}`, 'share')).body.window, null, 'a rolling link asking for the pinned window gets its own answer');
    assert.equal((await app.get(`/v1/query/board?from=${now - 7_200_000}&to=${now}`, 'share')).body.board.panels[0].value, 4);
    const wide = (await app.get('/v1/query/board', 'wide')).body.meta;
    assert.equal(wide.to - wide.from, 30 * 86_400_000, 'a pinned window is cut to 30 days too');

    // Everything else is refused.
    const refused = [
      '/v1/query/board?page=private',
      '/v1/query/board?page=errors',
      '/v1/query/board?service=other',
      '/v1/query/overview?service=zoomies',
      '/v1/query/errors?service=zoomies',
      '/v1/query/sessions?service=zoomies',
      '/v1/query/session?service=zoomies&id=secret_session_0',
      '/v1/query/activity',
      '/v1/query/events?service=zoomies',
      '/v1/query/dashboard?service=zoomies',
      '/v1/query/findings?service=zoomies',
      '/v1/query/performance?service=zoomies',
      '/v1/query/players?service=zoomies',
      '/v1/query/heatmap?service=zoomies',
      '/v1/query/versions?service=zoomies',
      '/v1/query/playtest?service=zoomies&sessions=secret_session_0',
      '/v1/query/nope',
      '/v1/live?service=zoomies',
      '/v1/dashboard?service=zoomies',
      '/v1/nothing',
    ];
    for (const p of refused) assert.equal((await app.get(p, 'share')).status, 403, p);
    for (const [method, p] of [['PUT', '/v1/dashboard?service=zoomies'], ['DELETE', '/v1/dashboard?service=zoomies'], ['DELETE', '/v1/data?service=zoomies'], ['POST', '/v1/query/board']])
      assert.equal((await fetch(app.base + p, { method, headers: { 'x-glitchless-api-key': 'share' }, body: method === 'PUT' ? JSON.stringify({ pages: [board] }) : undefined })).status, 403, `${method} ${p}`);
    assert.equal((await app.get('/v1/query/sessions?service=zoomies', 'full')).body.sessions.length, 4, 'nothing was deleted');

    // Share readers are rate limited: by their own rps, or DEFAULT_SHARE_RPS (10/s, bursts of 20).
    const slow = [];
    for (let i = 0; i < 3; i++) slow.push((await app.get('/v1/query/services', 'slow')).status);
    assert.deepEqual(slow, [200, 200, 429]);
    assert.equal((await app.get('/v1/query/services', 'slow')).res.headers.get('retry-after'), '1');
    const burst = await Promise.all(Array.from({ length: 30 }, () => app.get('/v1/query/services', 'plain').then((r) => r.status)));
    assert.ok(burst.filter((s) => s === 429).length >= 5, `statuses: ${burst}`);
    assert.equal((await app.get('/v1/query/services', 'full')).status, 200, 'members are not limited by a link');
  } finally {
    await app.close();
  }
  // A kind of panel this list doesn't know yet stays off a shared board until it is added to it.
  const ctx = buildContext([], { service: 'zoomies', from: now - 3_600_000, to: now, type: 'all' });
  assert.deepEqual(evaluateBoard(ctx, { panels: [{ type: 'bug_reports' }] }, { shared: true })[0].empty, true);
});
