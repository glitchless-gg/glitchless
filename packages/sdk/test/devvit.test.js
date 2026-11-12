// glitchless/devvit: the relay a Reddit game's Devvit server mounts at /api/glitchless (SPEC §5g). Driven here through
// its Fetch API handler (Hono, as Devvit's templates use) and its Node handler (Node's own server, Express), against a
// stand-in intake that records what reaches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { glitchlessRelay, anonymize } from '../src/devvit.js';

const TOKEN = 'gl_pub_relaytest';

// The intake's side: every request with its headers and (unpacked) JSON. `answer` sets what it says back.
async function intake() {
  const seen = [];
  const self = {
    seen,
    answer: { status: 202, body: '{"accepted":1}', headers: {} },
    url: '',
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      seen.push({ method: req.method, url: req.url, headers: req.headers, json: buf.length ? JSON.parse(buf.toString('utf8')) : null });
      if (req.url === '/v1/health') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"features":["counts","props"]}');
      res.writeHead(self.answer.status, { 'content-type': 'application/json', ...self.answer.headers }).end(self.answer.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  self.url = `http://127.0.0.1:${server.address().port}`;
  return self;
}

// Devvit's server context for one request: a redditor in r/DailyDots playing post t3_abc123.
const reddit = { subredditName: 'DailyDots', postId: 't3_abc123', userId: 't2_q7w9e2rt', username: 'bright_otter_42', loid: undefined };

const batch = (events, extra = {}) => ({ service: 'daily-dots', env: 'prod', version: '1.0.0', session_id: 's_abcdefghijklmnop', player_id: 'p_abcdefghijkl', sdk: 'glitchless-browser/0.7.1', batch_id: 'b_abcdefghijklmnop', events, ...extra });
const start = (more = {}) => ({ type: 'session_start', ts: 1, privacy: 'install', device: { os: 'iOS' }, ...more });
const post = (relay, path, body, headers = {}) =>
  relay.fetch(new Request(`https://daily-dots-x1-webview.devvit.net${path}`, { method: 'POST', body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), headers: { 'content-type': 'text/plain', ...headers } }));

test('a batch reaches the intake anonymous, with the subreddit and post as session properties', async () => {
  const up = await intake();
  try {
    const relay = glitchlessRelay({ intake: up.url, clientToken: TOKEN, context: reddit });
    const r = await post(relay, `/api/glitchless/v1/intake?token=${TOKEN}`, batch([start({ props: { mode: 'daily' } }), { type: 'custom', name: 'guess', attrs: { by: 'bright_otter_42' } }]), { authorization: 'Bearer devvit-token', cookie: 'reddit_session=x' });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 1 });
    const [got] = up.seen;
    assert.equal(got.url, `/v1/intake?token=${TOKEN}`);
    assert.equal(got.json.player_id, null, 'no stored player ID through Reddit');
    const s = got.json.events[0];
    assert.equal(s.privacy, 'anonymous');
    assert.deepEqual(s.props, { mode: 'daily', subreddit: 'DailyDots', post: 't3_abc123' });
    assert.equal(got.json.events[1].attrs.by, '<redditor>', "the redditor's name is scrubbed from the game's own words");
    assert.equal(got.headers.authorization, undefined, "Devvit's token never leaves the app");
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.headers['x-glitchless-relay'], 'devvit');
    assert.ok(!JSON.stringify(got).includes('t2_q7w9e2rt') && !JSON.stringify(got).includes('bright_otter_42'));
  } finally {
    await up.close();
  }
});

test('the game\'s own properties win, and twelve leave no room', () => {
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
  const a = anonymize(batch([start({ props: { subreddit: 'mine' } })]), reddit);
  assert.deepEqual(a.events[0].props, { subreddit: 'mine', post: 't3_abc123' });
  const b = anonymize(batch([start({ props: twelve })]), reddit);
  assert.deepEqual(b.events[0].props, twelve);
  const c = anonymize(batch([start({ privacy: 'full' })]), {});
  assert.equal(c.events[0].privacy, 'full', 'full mode keeps its device fields, without the ID');
  assert.equal(c.events[0].props, undefined, 'no context, no properties');
  const d = anonymize(batch([start()]), { subredditName: 'bad name!', postId: 'javascript:1' });
  assert.equal(d.events[0].props, undefined, 'only real subreddit names and post IDs');
});

test('names are scrubbed as whole words, and pictures are left alone', () => {
  const shot = 'data:image/jpeg;base64,/bright_otter_42/t2_q7w9e2rt+';
  const a = anonymize(batch([{ type: 'error', message: 'no save for BRIGHT_OTTER_42 (t2_q7w9e2rt, q7w9e2rt)', stack: 'at load (bright_otter_42x.js:1:1)' }, { type: 'bug_report', screenshot: shot, note: 'bright_otter_42' }]), reddit);
  assert.equal(a.events[0].message, 'no save for <redditor> (<redditor>, <redditor>)');
  assert.equal(a.events[0].stack, 'at load (bright_otter_42x.js:1:1)', 'a longer word is another word');
  assert.equal(a.events[1].screenshot, shot);
  assert.equal(a.events[1].note, '<redditor>');
  assert.equal(a.service, 'daily-dots');
});

test('a gzipped batch is unpacked, and the client token is the relay\'s', async () => {
  const up = await intake();
  try {
    const relay = glitchlessRelay({ intake: `${up.url}/`, clientToken: TOKEN, context: () => reddit });
    const gz = new Uint8Array(gzipSync(JSON.stringify(batch([start()]))));
    assert.equal((await post(relay, '/api/glitchless/v1/intake', gz)).status, 202, 'no token from the client: the relay\'s');
    assert.equal(up.seen[0].url, `/v1/intake?token=${TOKEN}`);
    assert.equal(up.seen[0].json.events[0].props.subreddit, 'DailyDots');
    const other = await post(relay, '/api/glitchless/v1/intake?token=gl_pub_someoneelse', batch([start()]));
    assert.equal(other.status, 403, 'not a proxy for other games');
    assert.equal(up.seen.length, 1);
  } finally {
    await up.close();
  }
});

test('without a pinned token, only public tokens go', async () => {
  const up = await intake();
  try {
    const relay = glitchlessRelay({ intake: up.url });
    assert.equal((await post(relay, '/v1/intake?token=gl_sk_secret', batch([]))).status, 401, 'a secret key is never forwarded in a URL');
    assert.equal((await post(relay, '/v1/intake', batch([]))).status, 401);
    assert.equal((await post(relay, '/v1/intake?token=gl_pub_dev', batch([]))).status, 202);
    assert.equal(up.seen.length, 1);
  } finally {
    await up.close();
  }
});

test('only the intake\'s two paths, with their methods, sizes and bodies', async () => {
  const up = await intake();
  try {
    const relay = glitchlessRelay({ intake: up.url, clientToken: TOKEN });
    const get = (path, method = 'GET') => relay.fetch(new Request(`https://x.devvit.net${path}`, { method }));
    assert.equal((await get('/api/glitchless/v1/query/sessions')).status, 404);
    assert.equal((await get('/api/glitchless/v1/rooms')).status, 404);
    assert.equal((await get('/api/glitchless/v1/intake')).status, 405);
    assert.equal((await get('/api/glitchless/v1/health', 'DELETE')).status, 405);
    assert.equal((await get('/api/glitchless/v1/intake', 'OPTIONS')).status, 204);
    assert.equal((await post(relay, '/api/glitchless/v1/intake', 'not json')).status, 400);
    assert.equal((await post(relay, '/api/glitchless/v1/intake', { events: 'no' })).status, 400);
    assert.equal((await post(relay, '/api/glitchless/v1/intake', 'x'.repeat(1_000_001))).status, 413);
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(9_000_000, 32)));
    assert.equal((await post(relay, '/api/glitchless/v1/intake', bomb)).status, 413, 'a gzip bomb stops at 8 MB');
    assert.equal(up.seen.length, 0, 'nothing reached the intake');
  } finally {
    await up.close();
  }
});

test('health is relayed and kept a while; the intake\'s refusals and waits come back as they were', async () => {
  const up = await intake();
  try {
    const relay = glitchlessRelay({ intake: up.url, clientToken: TOKEN });
    const h1 = await relay.fetch(new Request('https://x.devvit.net/api/glitchless/v1/health'));
    const h2 = await relay.fetch(new Request('https://x.devvit.net/api/glitchless/v1/health'));
    assert.deepEqual(await h1.json(), { ok: true, features: ['counts', 'props'] });
    assert.equal(h2.status, 200);
    assert.equal(up.seen.filter((s) => s.url === '/v1/health').length, 1);
    up.answer = { status: 429, body: '{"error":"rate limit exceeded"}', headers: { 'retry-after': '3' } };
    const r = await post(relay, '/api/glitchless/v1/intake', batch([start()]));
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '3');
  } finally {
    await up.close();
  }
});

test('an intake that can\'t be reached is a 502, which the SDK sends again', async () => {
  const relay = glitchlessRelay({ intake: 'http://127.0.0.1:9', clientToken: TOKEN, timeoutMs: 2000 });
  assert.equal((await post(relay, '/api/glitchless/v1/intake', batch([start()]))).status, 502);
});

test('the Node handler serves Node\'s own server and Express, mounted or not', async () => {
  const up = await intake();
  const relay = glitchlessRelay({ intake: up.url, clientToken: TOKEN, context: reddit });
  const app = http.createServer((req, res) => {
    // Express's app.use('/api/glitchless', relay.node) strips the mount from req.url and keeps it in originalUrl.
    if (req.url.startsWith('/mounted/')) {
      req.originalUrl = req.url;
      req.url = req.url.slice('/mounted'.length);
    }
    if (req.url.startsWith('/express-text')) req.body = 'not json';
    relay.node(req, res);
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${app.address().port}`;
  try {
    const r = await fetch(`${at}/api/glitchless/v1/intake?token=${TOKEN}`, { method: 'POST', body: JSON.stringify(batch([start()])) });
    assert.equal(r.status, 202);
    assert.equal((await fetch(`${at}/mounted/v1/intake`, { method: 'POST', body: JSON.stringify(batch([start()])) })).status, 202);
    assert.equal(up.seen.length, 2);
    assert.equal(up.seen[1].json.events[0].props.post, 't3_abc123');
    assert.equal((await fetch(`${at}/express-text/v1/intake`, { method: 'POST', body: '{}' })).status, 400, 'a body Express already read is used');
    assert.equal((await fetch(`${at}/api/glitchless/v1/intake`, { method: 'POST', body: 'x'.repeat(1_200_000) })).status, 413);
    assert.equal((await fetch(`${at}/api/glitchless/v1/health`)).status, 200);
    assert.equal((await fetch(`${at}/api/other`)).status, 404);
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    await up.close();
  }
});

test('a bad intake or client token is refused when the relay is made', () => {
  assert.throws(() => glitchlessRelay({ intake: 'api.glitchless.gg' }), /intake/);
  assert.throws(() => glitchlessRelay({ intake: 'ftp://x' }), /http/);
  assert.throws(() => glitchlessRelay({ clientToken: 'gl_sk_x' }), /gl_pub_/);
});
