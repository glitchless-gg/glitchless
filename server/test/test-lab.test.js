// Google Play's pre-launch test phones are bots (test-lab.js): a session that starts from one of Firebase Test Lab's
// published addresses is synthetic, whatever the SDK said, and the address is never stored. Starlift's pre-launch runs
// (October 2026) came from phones that didn't set firebase.test.lab, so they counted as players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';
import { isTestLabAddress, markTestLab } from '../src/test-lab.js';

test('Test Lab addresses: both of Google\'s groups, IPv4 and IPv6, with or without a port', () => {
  for (const a of ['108.177.6.5', '70.32.140.1', '172.217.120.70', '34.68.194.66', '199.192.115.17', '2001:4860:1008::1', '2001:4860:103a:5::9', '::ffff:35.203.128.3', '35.203.128.3:51000', '[2001:4860:101d::7]:443']) assert.ok(isTestLabAddress(a), a);
  for (const a of ['8.8.8.8', '108.177.8.1', '74.125.122.33', '2001:db8::1', '2001:4860:1009::1', '127.0.0.1', '', null, undefined, 'not an address']) assert.ok(!isTestLabAddress(a), String(a));
});

test('only a player\'s session_start changes: a type the game chose and a server\'s session stay as they are', () => {
  const start = (extra) => ({ type: 'session_start', ts: 1, service: 'starlift', session_id: 's_1', ...extra });
  const events = [start({ session_type: 'user' }), start({}), start({ session_type: 'tester' }), start({ session_type: 'simulated' }), start({ session_type: 'user', service: 'starlift.server' }), { type: 'custom', name: 'open' }];
  const marked = markTestLab(events, '108.177.6.5');
  assert.deepEqual(marked.map((e) => e.session_type), ['synthetic', 'synthetic', 'tester', 'simulated', 'user', undefined]);
  assert.equal(markTestLab(events, '8.8.8.8'), events, 'anywhere else, the batch is untouched');
});

test('through intake: a Test Lab phone is synthetic and a player is a player, and no address is stored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-test-lab-'));
  let from = '108.177.6.5';
  const server = http.createServer(createApp({ store: new FileStore(dir), logger: { warn() {}, error() {} }, clientAddress: () => from }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now() - 60_000;
  const send = (sid) => fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: 'starlift', env: 'prod', version: '1.1.1', session_id: sid, sdk: 'glitchless-godot/0.5.0', events: [{ type: 'session_start', ts: now, session_type: 'user', device: { os: 'Android' } }] }) });
  try {
    assert.equal((await send('s_testlab00000001')).status, 202);
    from = '203.0.113.9';
    assert.equal((await send('s_player000000001')).status, 202);
    const sessions = async (type) => (await (await fetch(`${base}/v1/query/overview?service=starlift&from=${now - 3_600_000}&to=${Date.now() + 60_000}&type=${type}`)).json()).kpis.sessions;
    assert.equal(await sessions('user'), 1);
    assert.equal(await sessions('synthetic'), 1);
    const stored = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('');
    assert.ok(!stored.includes('108.177.6.5') && !stored.includes('203.0.113.9'), 'the caller\'s address is never stored');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
