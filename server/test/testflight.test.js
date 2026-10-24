// TestFlight testers are not players (SPEC §4b): Starlift's "full version" sessions and its one purchase came from
// TestFlight builds, which report env prod like App Store installs. The engine SDKs read where an iOS build came from
// (device.distribution) and mark a TestFlight session session_type "tester", and a purchase made there sandbox: true.
// Findings and share links then count App Store players only, a tester filter still finds the testers, and revenue
// leaves the free sandbox purchases out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { normalize, parsePayload, distributionDevice } from '../src/ingest.js';
import { rollup, sumKey, isSandboxPurchase } from '../src/rollups.js';

const NOW = Date.now();
const T = NOW - 3_600_000;
const SHARE = { id: 'share-1', service: 'starlift', page: 'money' };
const readers = {
  full: { projectId: 'A', scopes: ['read', 'dashboard'] },
  share: { projectId: 'A', scopes: ['read'], share: { ...SHARE, sums: true }, keyId: 'share', rps: 1000 },
};

// One session: where the build came from, its type as the SDK decides it, and what the player bought.
function session(id, { distribution = null, type = 'user', env = 'prod', buys = [] } = {}) {
  const device = { browser: 'Godot', os: 'iOS', mobile: true, ...(distribution ? { distribution } : {}) };
  return {
    service: 'starlift',
    env,
    version: '1.1',
    session_id: id,
    player_id: `p_${id}`,
    sdk: 'glitchless-godot/0.4.0',
    events: [
      { type: 'session_start', ts: T, level: null, session_type: type, privacy: 'install', device },
      { type: 'custom', ts: T + 1000, level: null, name: 'paywall', attrs: { where: 'title' } },
      ...buys.map((attrs, i) => ({ type: 'custom', ts: T + 2000 + i, level: null, name: 'purchase', attrs })),
      { type: 'session_end', ts: T + 60_000, level: null, reason: 'pagehide', duration_s: 60 },
    ],
  };
}

const FULL = { amount: 4.99, currency: 'USD', item: 'full_version' };

async function serve() {
  const auth = {
    resolveIngest: () => ({ projectId: 'A' }),
    resolveReader(req) {
      const reader = readers[req.headers['x-glitchless-api-key']];
      if (!reader) throw new AuthError(401, 'no');
      return reader;
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-testflight-'));
  const server = http.createServer(createApp({ store: new FileStore(dir, { legacyProject: null }), auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    send: (body) => fetch(`${base}/v1/intake?token=any`, { method: 'POST', body: JSON.stringify(body) }),
    get: async (p, key = 'full') => (await fetch(base + p, { headers: { 'x-glitchless-api-key': key } })).json(),
    put: (p, body) => fetch(base + p, { method: 'PUT', headers: { 'x-glitchless-api-key': 'full' }, body: JSON.stringify(body) }),
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('TestFlight sessions are left out of players, findings and share links, and a tester filter finds them', async () => {
  const app = await serve();
  try {
    // Three App Store players (one buys the full version), two TestFlight testers (both "buy" it, for free) and the
    // developer's own build from Xcode.
    for (const s of [
      session('s_store1', { distribution: 'app_store', buys: [FULL] }),
      session('s_store2', { distribution: 'app_store' }),
      session('s_store3', { distribution: 'app_store' }),
      session('s_tf1', { distribution: 'testflight', type: 'tester', buys: [{ ...FULL, sandbox: true }] }),
      session('s_tf2', { distribution: 'testflight', type: 'tester', buys: [{ ...FULL, sandbox: true }] }),
      session('s_xcode', { distribution: 'development', type: 'tester', env: 'dev' }),
    ])
      assert.equal((await app.send(s)).status, 202);
    const money = { id: 'money', title: 'Money', panels: [{ type: 'stat', metric: 'players' }, { type: 'stat', event: 'purchase', sum: 'amount', title: 'Revenue' }, { type: 'stat', event: 'purchase', per: '$players' }] };
    assert.equal((await app.put('/v1/dashboard?service=starlift', { pages: [money] })).status, 200);
    const range = `service=starlift&from=${T - 60_000}&to=${NOW}`;

    // Every session, as the dashboard shows by default: testers counted and told apart.
    const all = await app.get(`/v1/query/overview?${range}`);
    assert.equal(all.kpis.sessions, 6);
    assert.equal(all.kpis.tester_sessions, 3);
    const [players, revenue, bought] = (await app.get(`/v1/query/board?${range}&page=money`)).board.panels;
    assert.equal(players.value, 6);
    assert.deepStrictEqual([revenue.value, revenue.currency, revenue.events, revenue.sandbox], [4.99, 'USD', 1, 2], 'one real purchase; two sandbox ones left out');
    assert.equal(bought.count, 3, 'buying in TestFlight still counts as sending purchase');

    // Findings read App Store players only.
    const findings = await app.get(`/v1/query/findings?${range}`);
    assert.deepStrictEqual(findings.meta.findings_from, { env: 'prod', type: 'user', sessions: 3, of: 6 });
    assert.match(findings.meta.note, /findings read the 3 prod sessions of players \(no dev builds, bots or testers\) of the 6 in the range/);

    // So does a share link, revenue and all.
    const [sharedPlayers, sharedRevenue, sharedBought] = (await app.get(`/v1/query/board?service=starlift&page=money&days=1`, 'share')).board.panels;
    assert.equal(sharedPlayers.value, 3);
    assert.equal(sharedRevenue.value, 4.99);
    assert.equal(sharedRevenue.sandbox, undefined, 'no tester sessions, so no sandbox purchases to leave out');
    assert.deepStrictEqual([sharedBought.count, sharedBought.base], [1, 3]);

    // The testers are a filter away, with where their builds came from.
    const testers = await app.get(`/v1/query/sessions?${range}&type=tester`);
    assert.deepStrictEqual(testers.sessions.map((s) => s.session_id).sort(), ['s_tf1', 's_tf2', 's_xcode']);
    assert.ok(testers.sessions.every((s) => s.session_type === 'tester'));
    const tf = await app.get(`/v1/query/session?${range}&id=s_tf1`);
    assert.equal(tf.session.device.distribution, 'testflight');
    const testerRevenue = (await app.get(`/v1/query/board?${range}&page=money&type=tester`)).board.panels[1];
    assert.deepStrictEqual([testerRevenue.value, testerRevenue.currency, testerRevenue.sandbox], [0, 'USD', 2], 'still money, with nothing paid');
  } finally {
    await app.close();
  }
});

test('intake keeps distribution in the words the SDKs send', () => {
  assert.deepStrictEqual(distributionDevice({ os: 'iOS', distribution: 'testflight' }), { os: 'iOS', distribution: 'testflight' });
  assert.deepStrictEqual(distributionDevice({ os: 'iOS', distribution: 'TestFlight beta' }), { os: 'iOS' });
  assert.deepStrictEqual(distributionDevice({ os: 'Android' }), { os: 'Android' });
  const [start] = normalize(parsePayload(JSON.stringify(session('s_x', { distribution: 'enterprise' }))), NOW);
  assert.equal('distribution' in start.device, false);
  const [store] = normalize(parsePayload(JSON.stringify(session('s_y', { distribution: 'app_store' }))), NOW);
  assert.equal(store.device.distribution, 'app_store');
});

test('only money is a sandbox purchase: a game\'s own sandbox mode keeps its sums', () => {
  assert.equal(isSandboxPurchase('purchase', { amount: 4.99, sandbox: true }), true, 'a purchase, with or without a currency');
  assert.equal(isSandboxPurchase('unlock', { price: 2, currency: 'EUR', sandbox: true }), true, 'anything with a currency');
  assert.equal(isSandboxPurchase('build', { blocks: 40, sandbox: true }), false, 'a sandbox game');
  assert.equal(isSandboxPurchase('purchase', { amount: 4.99, sandbox: 'true' }), false, 'only true itself');
  assert.equal(isSandboxPurchase('purchase', { amount: 4.99, sandbox: false }), false);
  const ev = (name, attrs) => ({ type: 'custom', ts: NOW, env: 'prod', version: '1', level: null, name, attrs });
  const cell = rollup([ev('purchase', { ...FULL, sandbox: true }), ev('purchase', FULL), ev('build', { blocks: 40, sandbox: true })]).values().next().value.values().next().value;
  assert.deepStrictEqual(cell.evs[sumKey('purchase', 'amount', 'USD')], [4990, 1], 'the sandbox purchase is not summed');
  assert.deepStrictEqual(cell.evs[sumKey('build', 'blocks', '')], [40000, 1]);
  assert.equal(cell.ev.purchase, 2, 'both purchases are counted');
});
