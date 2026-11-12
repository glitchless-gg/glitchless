// A game in a Reddit post, without Reddit (SPEC §5g): the browser SDK in a Devvit-shaped webview (devvit-harness.js:
// connect-src 'self', no inline scripts or styles, Reddit's fetch wrapper, /api/ only with the app's token), framed by a
// page of another origin as reddit.com frames it, sending through glitchless/devvit to a local Glitchless server.
//
//   node packages/sdk/test/devvit-webview.mjs      (npm run test:devvit)
//
// Needs Playwright's Chromium (npx playwright install chromium). It checks that:
//   - the page can't reach the Glitchless server itself, so everything below went through the relay;
//   - the session arrives with the subreddit and post as properties, anonymous though the game asked for install mode,
//     and the redditor's name, which the game fetched from its own /api/ route, scrubbed from an error;
//   - every request carried the app's token, the last one too (fetch with keepalive as the page goes): a beacon would
//     have been turned away, and the harness shows that it is;
//   - the overlay draws with its styles under a CSP with no inline styles, no CSP report is raised, and the webmcp.dev
//     widget stays out;
//   - nothing the Glitchless server stored names the redditor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { glitchlessRelay } from '../src/devvit.js';
import { devvitApp, REDDITOR } from './devvit-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVICE = 'daily-dots';
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
async function waitFor(fn, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

// The game: a canvas, an /api/init call for who is playing (as Devvit's templates make), and Glitchless. No inline
// script or style, which the webview's CSP refuses.
const GAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Daily Dots</title><link rel="stylesheet" href="game.css"><script type="module" src="game.js"></script></head>
<body><canvas id="board" width="320" height="320"></canvas></body></html>`;
const GAME_CSS = 'html, body { margin: 0; background: #101418; } canvas { display: block; margin: auto; }';
const GAME_JS = `import { Glitchless } from '/sdk/index.js';
const me = await fetch('/api/init').then((r) => r.json());
const gl = Glitchless.init({ service: '${SERVICE}', version: '1.0.0', env: 'dev', intake: '/api/glitchless', clientToken: 'gl_pub_dev', privacy: 'install', windowMs: 500, flushIntervalMs: 1000, bugReports: true });
window.gl = gl;
gl.setProperties({ mode: 'daily' });
gl.levelStart('daily-2026-11-12');
gl.track('guess', { word: 'otter', right: true });
const ctx = document.getElementById('board').getContext('2d');
let t = 0;
(function frame() {
  ctx.fillStyle = 'hsl(' + (t++ % 360) + ' 60% 50%)';
  ctx.fillRect(0, 0, 320, 320);
  requestAnimationFrame(frame);
})();
setTimeout(() => { throw new Error('no saved streak for ' + me.username); }, 200);
window.ready = true;
`;

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], { env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return child;
    } catch {}
    await sleep(100);
  }
  child.kill();
  throw new Error('Glitchless server did not start');
}

// Between the relay and the Glitchless server: what the relay sent, headers and all.
async function recordingProxy(target) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    const r = { method: req.method, path: req.url.split('?')[0], headers: req.headers };
    if (req.method === 'POST') r.batch = JSON.parse((body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8'));
    seen.push(r);
    const up = await fetch(`http://127.0.0.1:${target}${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'text/plain' }, body: req.method === 'POST' ? body : undefined });
    r.status = up.status;
    res.writeHead(up.status, { 'content-type': 'application/json' }).end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

// reddit.test: the page that frames the game, as www.reddit.com frames a post's webview.
async function framingPage(src) {
  const server = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>r/${REDDITOR.subredditName}</title><iframe src="${src}" width="400" height="400" allow="autoplay"></iframe>`));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-devvit-'));
const client = path.join(tmp, 'client');
fs.mkdirSync(client);
fs.writeFileSync(path.join(client, 'game.html'), GAME_HTML);
fs.writeFileSync(path.join(client, 'game.css'), GAME_CSS);
fs.writeFileSync(path.join(client, 'game.js'), GAME_JS);
const dataDir = path.join(tmp, 'data');
const port = await freePort();
let server, proxy, app, parent, browser;
try {
  server = await startServer(port, dataDir);
  proxy = await recordingProxy(port);
  let relay;
  app = await devvitApp({
    dirs: { '/': client, '/sdk/': path.join(ROOT, 'packages/sdk/src') },
    api: async (request) => {
      const p = new URL(request.url).pathname;
      if (p === '/api/init') return Response.json({ username: app.context.username, postId: app.context.postId });
      if (p.startsWith('/api/glitchless/')) return relay.fetch(request);
      return null;
    },
  });
  relay = glitchlessRelay({ intake: proxy.url, clientToken: 'gl_pub_dev', context: app.context });
  const webview = `http://daily-dots-x1-webview.devvit.test:${app.port}`;
  parent = await framingPage(`${webview}/game.html`);
  try {
    // The webview is https on Reddit: a secure context, which also gets Sec-Fetch-Mode (no-cors for a beacon) sent.
    // (The full Chromium build: its headless shell ignores that flag.)
    browser = await chromium.launch({ channel: 'chromium', args: ['--host-resolver-rules=MAP *.devvit.test 127.0.0.1, MAP www.reddit.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${webview}`] });
  } catch (err) {
    console.error(`Playwright's Chromium didn't start (npx playwright install chromium): ${err.message}`);
    process.exit(2);
  }
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`http://www.reddit.test:${parent.port}/`);
  const frame = await (async () => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find((x) => x.url().startsWith(webview));
      if (f && (await f.evaluate(() => window.ready === true).catch(() => false))) return f;
      await sleep(100);
    }
    throw new Error(`the game didn't start in its frame:\n${logs.join('\n')}`);
  })();

  const batches = () => proxy.seen.filter((r) => r.path === '/v1/intake');
  const events = () => batches().flatMap((r) => r.batch.events.map((e) => ({ ...e, _r: r })));
  await waitFor(() => events().some((e) => e.type === 'error') && events().some((e) => e.type === 'frame_window'));

  const direct = await frame.evaluate(async (u) => {
    try {
      await fetch(u);
      return 'reached';
    } catch {
      return 'blocked';
    }
  }, `http://127.0.0.1:${port}/v1/health`);
  const overlay = await frame.evaluate(() => {
    const host = document.getElementById('glitchless-overlay');
    const gd = host?.shadowRoot?.querySelector('.gd');
    return gd ? { position: getComputedStyle(gd).position, styled: host.shadowRoot.adoptedStyleSheets.length, styleTags: host.shadowRoot.querySelectorAll('style').length } : null;
  });
  const bridge = await frame.evaluate(() => window.gl.webmcp ? window.gl.webmcp.bridge : 'no webmcp');
  const beaconAt = app.requests.length;
  const beaconQueued = await frame.evaluate(() => navigator.sendBeacon('/api/glitchless/v1/intake?token=gl_pub_dev', '{"events":[]}'));
  await waitFor(() => app.requests.length > beaconAt);
  const beacon = app.requests[beaconAt];

  const leftAt = Date.now();
  await page.goto('about:blank');
  await waitFor(() => events().some((e) => e.type === 'session_end'));
  await waitFor(() => app.requests.every((r) => r.status !== 0)); // the relay's answers to the last sends

  const all = events();
  const start = all.find((e) => e.type === 'session_start');
  const end = all.find((e) => e.type === 'session_end');
  const relayed = app.requests.filter((r) => r.path.startsWith('/api/glitchless/') && r !== beacon);
  const lastSend = relayed.filter((r) => r.method === 'POST' && r.at >= leftAt);
  if (process.env.DEBUG) {
    for (const r of app.requests) console.log(r.method, r.path, r.mode, r.authorized, r.status, r.at - leftAt);
    console.log(logs.join('\n'));
  }

  check('the page reaches nothing but its own origin: Glitchless itself is out of its reach', () => assert.equal(direct, 'blocked'));
  check('the session arrives through the relay, with frame windows, the level, the guess and the error', () => {
    assert.ok(start, 'no session_start');
    for (const t of ['frame_window', 'level_start', 'custom', 'error']) assert.ok(all.some((e) => e.type === t), `no ${t}`);
    assert.ok(batches().every((r) => r.status === 202), batches().map((r) => r.status).join(' '));
  });
  check('the subreddit and post are session properties next to the game\'s own', () => assert.deepEqual(start.props, { mode: 'daily', subreddit: REDDITOR.subredditName, post: REDDITOR.postId }));
  check('the page says where it was played: the webview\'s own address', () => assert.equal(start.page.url, `${webview}/game.html`));
  check('anonymous though the game asked for install mode: no player ID', () => {
    assert.equal(start.privacy, 'anonymous');
    assert.ok(batches().every((r) => r.batch.player_id === null));
  });
  check('the redditor\'s name, which the game put in an error, is scrubbed', () => {
    const err = all.find((e) => e.type === 'error');
    assert.match(err.message, /no saved streak for <redditor>/);
  });
  check('every request the SDK made carried the app\'s token, so /api/ took it', () => {
    assert.ok(relayed.length >= 3, `${relayed.length} requests`);
    assert.deepEqual(relayed.filter((r) => !r.authorized || r.status >= 400).map((r) => `${r.method} ${r.path} ${r.status}`), []);
    assert.ok(relayed.some((r) => r.method === 'GET' && r.path.endsWith('/v1/health')), 'the SDK asks what the server reads');
  });
  check('leaving the page ends the session by fetch with keepalive, with the token; a beacon would have been turned away', () => {
    assert.ok(end, 'no session_end');
    assert.ok(lastSend.length >= 1 && lastSend.every((r) => r.authorized && r.mode !== 'no-cors' && r.status === 202), JSON.stringify(lastSend));
    assert.equal(beaconQueued, true);
    assert.deepEqual([beacon?.mode, beacon?.authorized, beacon?.status], ['no-cors', false, 401]);
  });
  check('the relay forwards none of the request\'s headers: no token, no cookie', () => {
    for (const r of proxy.seen) {
      assert.equal(r.headers.authorization, undefined);
      assert.equal(r.headers.cookie, undefined);
      assert.equal(r.headers['x-glitchless-relay'], 'devvit');
    }
  });
  check('the overlay draws with its styles under a CSP with no inline styles, and the webmcp.dev widget stays out', () => {
    assert.deepEqual(overlay, { position: 'fixed', styled: 1, styleTags: 0 });
    assert.equal(bridge, null);
  });
  check('the page raised no CSP report but the one this test caused', () => {
    const others = app.violations.filter((v) => !String(v['blocked-uri']).includes(`127.0.0.1:${port}`));
    assert.deepEqual(others.map((v) => `${v['violated-directive']} ${v['blocked-uri']}`), []);
  });
  const query = async (params) => (await fetch(`http://127.0.0.1:${port}/v1/query/sessions?${new URLSearchParams({ service: SERVICE, from: '0', ...params })}`)).json();
  const bySubreddit = await query({ 'prop.subreddit': REDDITOR.subredditName });
  const byPost = await query({ 'prop.post': REDDITOR.postId });
  const other = await query({ 'prop.subreddit': 'SomewhereElse' });
  check('the Glitchless server splits the game by subreddit and post', () => {
    assert.equal(bySubreddit.sessions?.length, 1, JSON.stringify(bySubreddit).slice(0, 300));
    assert.equal(byPost.sessions?.length, 1);
    assert.equal(other.sessions?.length, 0);
  });
  const stored = fs.readdirSync(dataDir, { recursive: true }).map((f) => path.join(dataDir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
  check('nothing the server stored names the redditor', () => {
    assert.ok(stored.includes(SERVICE), 'the data folder holds the game');
    for (const who of [REDDITOR.username, REDDITOR.userId, REDDITOR.userId.slice(3)]) assert.ok(!stored.includes(who), `${who} is in the data folder`);
  });
} finally {
  await browser?.close();
  await parent?.close();
  await app?.close();
  await proxy?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const [status, name, msg] of results) console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'} ${name}${msg ? `\n     ${msg.split('\n').join('\n     ')}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\ndevvit webview: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
