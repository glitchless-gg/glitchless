// Plays the demo game (godot/demo) as a web export in Chromium against a fresh local Glitchless server, and checks
// what arrives. npm run test:godot runs it after test/e2e.mjs.
//
//   node godot/test/web.mjs          (npm run test:godot:web on its own)
//   GODOT=/path/to/Godot node godot/test/web.mjs
//
// Needs Godot 4.5 or later with its Web export templates (Editor → Manage Export Templates), and Playwright's
// Chromium (npx playwright install chromium).
//   0. parity     web_page.gd reads user agents, GPUs and the Steam Deck as packages/sdk/src/device.js does
//   1, 2. play    a debug export with thread support off (Godot's default since 4.3) on a plain page, and on, on a
//                 cross-origin-isolated one, at ?glitchless: the session, its frame windows, errors, hitches and a bug
//                 report arrive, sent as text/plain with no CORS preflight; the device is the browser (Chrome, its
//                 OS, the GPU the page names) with Godot in session_start.engine. Hidden, the page sends what waits by
//                 beacon and plays on; leaving it, the session ends (session_end, and level_abandon when a level was
//                 going, reason pagehide) by beacon too
//   3. quit       get_tree().quit() sends the session's end by beacon
//   4. debug      on this machine a debug export sends nothing without ?glitchless; on a page anywhere else it sends,
//                 and ?glitchless-synthetic marks the session a bot's
//   5. off switch a player's "off" is kept in IndexedDB: the next visit measures and sends nothing
//   6. outbox     batches a visit couldn't send are kept in IndexedDB and sent on the next visit
// The page's address (127.0.0.1, or game.test mapped to it) is where it runs; the demo's own flags go in the export's
// GODOT_CONFIG args, as a game's would. Every intake request passes through a proxy here that notes how it was sent.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { parseUserAgent, isSteamDeck, cleanGpu, cleanVendor, classifyGpu } from '../../packages/sdk/src/device.js';
import { findGodot } from './godot-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = path.join(ROOT, 'godot');
const SERVICE = 'glitchless-godot-demo';
const godot = findGodot();
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

// Browsers as players have them (Unity's parity fixture's list, unity/test/make-fixtures.mjs), GPUs as pages name them,
// and Steam Decks: device.js's answers, for web_page_test.gd to match.
const agents = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', false],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0', false],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15', null],
  ['Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', null],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', true],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0', true],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/92.0.0.0', true],
  ['Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36', true],
  ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', null],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', null],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36', null],
  ['Mozilla/5.0 (X11; Linux x86_64) Valve Steam Client SteamDeck/1', null],
  ['', null],
];
const gpus = [
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', 'Google Inc. (Apple)'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (NVIDIA)'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)'],
  ['ANGLE (AMD, AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.8.0), OpenGL 4.6)', 'Google Inc. (AMD)'],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google Inc. (Google)'],
  ['ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)', 'Google Inc. (Qualcomm)'],
  ['Apple GPU', 'Apple Inc.'],
  ['Radeon R9 200 Series, or similar', 'ATI Technologies Inc.'],
  ['Mali-G78', 'ARM'],
  ['', ''],
];
const linuxChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const decks = [
  [linuxChrome, 'AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)'],
  [linuxChrome, 'ANGLE (AMD, AMD Custom GPU 0932, OpenGL 4.6)'],
  [linuxChrome, 'AMD Radeon RX 7800 XT'],
  ['Mozilla/5.0 (X11; Linux x86_64) Valve Steam Client SteamDeck/1', ''],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Radeon R9 200 Series, or similar'],
];

// The intake's side of each request: how it was sent (sec-fetch-mode is no-cors for a beacon, cors for a fetch), and
// the batch, passed on to the Glitchless server, whose answer comes back as it was.
async function recordingProxy(target) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const r = { method: req.method, path: req.url.split('?')[0], type: req.headers['content-type'] || '', mode: req.headers['sec-fetch-mode'] || '', at: Date.now() };
    if (req.method === 'POST') r.batch = JSON.parse(body.toString('utf8'));
    requests.push(r);
    const up = await fetch(`http://127.0.0.1:${target}${req.url}`, { method: req.method, headers: { 'content-type': r.type || 'text/plain' }, body: req.method === 'POST' ? body : undefined });
    const headers = Object.fromEntries([...up.headers].filter(([k]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-encoding'].includes(k)));
    res.writeHead(up.status, headers).end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, requests, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

// Serves the exports: /nothreads/ on a plain page, /threads/ cross-origin isolated (COOP and COEP, which
// SharedArrayBuffer needs). The page's ?args=[...] become the export's GODOT_CONFIG args, the game's command line.
async function exportServer(dir) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const file = path.join(dir, path.normalize(u.pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    const isolated = u.pathname.startsWith('/threads/') ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {};
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) body = body.toString().replace('"args":[]', `"args":${JSON.stringify(JSON.parse(u.searchParams.get('args') || '[]'))}`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...isolated }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return child;
    } catch {}
    await sleep(100);
  }
  child.kill();
  throw new Error('Glitchless server did not start');
}

async function query(port, name, params = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/query/${name}?${new URLSearchParams({ service: SERVICE, from: '0', ...params })}`);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
  return res.json();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-godot-web-'));
let server;
let proxy;
let exports;
let browser;
try {
  // 0. parity
  const fixture = path.join(tmp, 'device-js.json');
  fs.writeFileSync(
    fixture,
    JSON.stringify({
      user_agents: agents.map(([ua, mobile]) => {
        const r = parseUserAgent({ userAgent: ua, userAgentData: mobile == null ? undefined : { mobile } });
        return { ua, uad_mobile: mobile, browser: r.browser, browser_version: r.browserVersion, os: r.os, mobile: r.mobile };
      }),
      gpus: gpus.map(([renderer, vendor]) => ({ renderer, vendor, clean: cleanGpu(renderer), vendor_clean: cleanVendor(vendor, renderer), tier: classifyGpu(cleanGpu(renderer)) })),
      decks: decks.map(([ua, gpu]) => ({ ua, gpu, deck: isSteamDeck({ userAgent: ua, gpu }) })),
    }),
  );
  if (!fs.existsSync(path.join(PROJECT, '.godot'))) spawnSync(godot, ['--headless', '--path', PROJECT, '--import'], { stdio: 'ignore' });
  const unit = spawnSync(godot, ['--headless', '--path', PROJECT, '--script', 'res://test/web_page_test.gd', '--', `--fixture=${fixture}`], { encoding: 'utf8', timeout: 120_000 });
  for (const m of unit.stdout.matchAll(/^(ok|FAIL) (.+)$/gm)) results.push(m[1] === 'ok' ? ['ok', `web page unit: ${m[2]}`] : ['FAIL', `web page unit: ${m[2]}`]);
  check('web page unit tests ran to the end, with no script error', () => {
    assert.match(unit.stdout, /web page tests: 0 failed/, unit.stdout + unit.stderr);
    assert.doesNotMatch(unit.stdout + unit.stderr, /SCRIPT ERROR/, unit.stdout + unit.stderr);
  });

  // The demo, exported for the web with debug on (as Godot's export dialog does unless it's unticked).
  const project = path.join(tmp, 'project');
  fs.cpSync(PROJECT, project, { recursive: true, filter: (src) => !/[\\/](\.godot|test)$/.test(src) && !src.endsWith('export_presets.cfg') });
  const preset = (i, name, threads) => `[preset.${i}]\n\nname="${name}"\nplatform="Web"\nrunnable=${i === 0}\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path=""\n\n[preset.${i}.options]\n\nvariant/extensions_support=false\nvariant/thread_support=${threads}\nhtml/export_icon=false\nhtml/canvas_resize_policy=2\nhtml/focus_canvas_on_start=true\nprogressive_web_app/enabled=false\n\n`;
  fs.writeFileSync(path.join(project, 'export_presets.cfg'), preset(0, 'Web', false) + preset(1, 'Web threads', true));
  spawnSync(godot, ['--headless', '--path', project, '--import'], { stdio: 'ignore', timeout: 120_000 });
  const site = path.join(tmp, 'site');
  for (const [name, dir] of [['Web', 'nothreads'], ['Web threads', 'threads']]) {
    fs.mkdirSync(path.join(site, dir), { recursive: true });
    const r = spawnSync(godot, ['--headless', '--path', project, '--export-debug', name, path.join(site, dir, 'index.html')], { encoding: 'utf8', timeout: 120_000 });
    if (!fs.existsSync(path.join(site, dir, 'index.wasm'))) {
      console.error(r.stdout, r.stderr);
      console.error(`The ${name} export failed. Install Godot's Web export templates (Editor → Manage Export Templates) for ${spawnSync(godot, ['--version'], { encoding: 'utf8' }).stdout.trim()}.`);
      process.exit(2);
    }
  }

  const port = await freePort();
  server = await startServer(port, path.join(tmp, 'data'));
  proxy = await recordingProxy(port);
  exports = await exportServer(site);
  const intake = `--intake=http://127.0.0.1:${proxy.port}`;
  try {
    // game.test is a page players play; Godot's shell runs only in a secure context, which plain http is on 127.0.0.1.
    // (The full Chromium build: its headless shell ignores that flag.)
    browser = await chromium.launch({ channel: 'chromium', args: ['--host-resolver-rules=MAP game.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=http://game.test:${exports.port}`] });
  } catch (err) {
    console.error(`Playwright's Chromium didn't start (npx playwright install chromium): ${err.message}`);
    process.exit(2);
  }

  // Opens the demo in a fresh browser profile (its own IndexedDB); logs keeps what the page printed.
  const open = async (url, context) => {
    const ctx = context ?? (await browser.newContext());
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(url);
    return { ctx, page, logs };
  };
  const pageUrl = (build, query, args, host = '127.0.0.1') => `http://${host}:${exports.port}/${build}/index.html?${query}${query ? '&' : ''}args=${encodeURIComponent(JSON.stringify(['--', ...args]))}`;
  const intakes = (from = 0) => proxy.requests.slice(from).filter((r) => r.path === '/v1/intake');
  const eventsOf = (reqs) => reqs.filter((r) => r.batch).flatMap((r) => r.batch.events.map((e) => ({ ...e, session_id: r.batch.session_id, mode: r.mode, batch_id: r.batch.batch_id })));
  const setVisibility = (page, state) =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { value: s, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);

  // 1, 2. play
  for (const build of ['nothreads', 'threads']) {
    const from = proxy.requests.length;
    const { ctx, page, logs } = await open(pageUrl(build, 'glitchless', [intake, '--level-seconds=1.5', '--bug-report-at=1']));
    const ua = await page.evaluate(() => navigator.userAgent);
    const isolated = await page.evaluate(() => self.crossOriginIsolated);
    const screen = await page.evaluate(() => [screen.width, screen.height]);
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    });
    await waitFor(() => eventsOf(intakes(from)).some((e) => e.type === 'error' && /missing node|Invalid call|nonexistent/i.test(e.message ?? '')), 15_000);
    await waitFor(() => intakes(from).filter((r) => r.mode === 'cors').length >= 2, 10_000);
    const beforeHide = intakes(from).length;
    await setVisibility(page, 'hidden');
    const hidBeacon = await waitFor(() => intakes(from).slice(beforeHide).some((r) => r.mode === 'no-cors'), 3000);
    const hiddenAt = Date.now();
    await setVisibility(page, 'visible');
    await sleep(2500);
    const leftAt = Date.now();
    await page.goto('about:blank');
    await waitFor(() => eventsOf(intakes(from)).some((e) => e.type === 'session_end'), 5000);
    await ctx.close();
    const reqs = proxy.requests.slice(from);
    const events = eventsOf(intakes(from));
    if (process.env.DEBUG) for (const [i, r] of reqs.entries()) console.log(build, i, r.method, r.path, r.mode, r.at - hiddenAt, r.batch?.events.map((e) => `${e.type}${e.reason ? ':' + e.reason : ''}`).join(' ') ?? '', r.at >= leftAt ? '(left)' : '');
    const start = events.find((e) => e.type === 'session_start');
    const label = build === 'nothreads' ? 'thread support off, plain page' : 'thread support on, cross-origin isolated page';
    check(`${label}: the build is what it says`, () => {
      assert.ok(logs.some((l) => l.includes(build === 'nothreads' ? 'single-threaded' : 'multi-threaded')), logs.join('\n'));
      assert.equal(isolated, build === 'threads');
    });
    check(`${label}: ?glitchless turns a debug export on, and it asks the server what it takes`, () => {
      assert.ok(logs.includes('glitchless on: true'), logs.join('\n'));
      assert.equal(reqs[0]?.method + ' ' + reqs[0]?.path, 'GET /v1/health');
    });
    check(`${label}: every batch is text/plain, so no request needs a CORS preflight`, () => {
      assert.ok(intakes(from).length >= 4, `${intakes(from).length} intake requests`);
      assert.deepEqual(reqs.filter((r) => r.method === 'OPTIONS').map((r) => r.path), []);
      for (const r of intakes(from)) assert.match(r.type, /^text\/plain/);
    });
    check(`${label}: one session, with the browser's name and OS, and Godot as its engine`, () => {
      assert.equal(new Set(events.map((e) => e.session_id)).size, 1);
      const want = parseUserAgent({ userAgent: ua });
      assert.equal(start?.device.browser, 'Chrome');
      assert.equal(start.device.browser_version, want.browserVersion);
      assert.equal(start.device.os, want.os);
      assert.equal(start.device.mobile, false);
      assert.deepEqual(start.device.screen, screen);
      assert.equal(start.device.gpu_tier, classifyGpu(cleanGpu(gpu)), gpu);
      assert.deepEqual(start.engine, { name: 'godot', version: start.engine?.version, renderer: 'webgl' });
      assert.match(start.engine.version, /^4\.\d+\.\d+$/);
      assert.equal(start.session_type, 'user');
    });
    check(`${label}: frame windows, hitches, errors (with the user dir cut to user://), deaths and the level funnel arrive`, () => {
      const windows = events.filter((e) => e.type === 'frame_window');
      assert.ok(windows.length >= 2, `${windows.length} frame windows`);
      assert.ok(windows.every((w) => w.frames > 0 && w.fps > 0 && w.ft?.n > 0), JSON.stringify(windows[0]));
      assert.ok(events.some((e) => e.type === 'hitch'), 'no hitch');
      const errors = events.filter((e) => e.type === 'error');
      assert.ok(errors.some((e) => e.kind === 'push_error' && e.message.includes('user://bonus.cfg') && !e.message.includes('/userfs')), JSON.stringify(errors.map((e) => e.message)));
      assert.ok(errors.some((e) => e.kind === 'script'), JSON.stringify(errors.map((e) => e.kind)));
      assert.ok(events.some((e) => e.type === 'death') && events.some((e) => e.type === 'level_complete') && events.some((e) => e.type === 'load' && e.ttff_ms > 0));
    });
    check(`${label}: a bug report goes on its own request, with its screenshot`, () => {
      const report = events.find((e) => e.type === 'bug_report');
      assert.ok(report, 'no bug report');
      assert.match(report.screenshot ?? '', /^data:image\/jpeg;base64,/);
      assert.equal(report.mode, 'cors');
      assert.equal(report.device.browser, 'Chrome');
    });
    check(`${label}: hidden, the page sends what waits by beacon, and the session plays on`, () => {
      assert.ok(hidBeacon, 'no beacon as the page was hidden');
      const later = events.filter((e) => e.ts > hiddenAt + 500 && e.type !== 'session_end' && e.type !== 'level_abandon');
      assert.ok(later.length > 0, 'nothing after the page came back');
      assert.ok(!events.some((e) => e.type === 'session_end' && e.ts < hiddenAt + 500), 'hiding ended the session');
    });
    // The demo plays at random: the level going as the page went may have just ended (a fall is a level_fail).
    const levelEvents = events.filter((e) => /^level_(start|complete|fail)$/.test(e.type));
    const levelOpen = levelEvents[levelEvents.length - 1]?.type === 'level_start';
    check(`${label}: leaving the page ends the session by beacon, reason pagehide, and abandons the level going`, () => {
      const last = intakes(from).filter((r) => r.at >= leftAt);
      const end = eventsOf(last).find((e) => e.type === 'session_end');
      assert.ok(end, `no session_end after leaving: ${JSON.stringify(last.map((r) => r.mode))}`);
      assert.equal(end.reason, 'pagehide');
      assert.equal(end.mode, 'no-cors');
      const abandon = eventsOf(last).find((e) => e.type === 'level_abandon');
      assert.equal(abandon?.reason, levelOpen ? 'pagehide' : undefined, JSON.stringify(levelEvents.slice(-3).map((e) => e.type)));
      if (abandon) assert.ok(abandon.ts <= end.ts);
    });
    check(`${label}: the page logged no IndexedDB failure, no blocked answer and no error from the addon`, () => {
      assert.ok(!logs.some((l) => /Failed to save IDB|ERR_BLOCKED_BY_RESPONSE|addons\/glitchless|pageerror/.test(l)), logs.filter((l) => /IDB|BLOCKED|glitchless\/|pageerror/.test(l)).join('\n'));
    });
    const { sessions } = await query(port, 'sessions');
    const stored = sessions.find((s) => s.session_id === start?.session_id);
    check(`${label}: the server stored the session as Chrome on its OS, ended, with its errors and the level left`, () => {
      assert.ok(stored, 'not stored');
      assert.match(stored.browser, /^Chrome \d+$/);
      assert.equal(stored.os, parseUserAgent({ userAgent: ua }).os);
      assert.equal(stored.ended, true);
      assert.ok(stored.errors >= 2 && stored.abandoned.length === (levelOpen ? 1 : 0), JSON.stringify(stored));
    });
  }

  // 3. quit: --autoplay quits after the last level
  {
    const from = proxy.requests.length;
    const { ctx, logs } = await open(pageUrl('nothreads', 'glitchless', [intake, '--autoplay', '--level-seconds=1']));
    await waitFor(() => eventsOf(intakes(from)).some((e) => e.type === 'session_end'), 15_000);
    await ctx.close();
    const end = eventsOf(intakes(from)).find((e) => e.type === 'session_end');
    check('quit: get_tree().quit() sends the session end by beacon', () => {
      assert.equal(end?.reason, 'quit', logs.join('\n'));
      assert.equal(end.mode, 'no-cors');
      assert.deepEqual(eventsOf(intakes(from)).filter((e) => e.type === 'level_complete').map((e) => e.level), ['level_1', 'level_2', 'level_3']);
    });
  }

  // 4. debug: where the page is decides
  {
    const from = proxy.requests.length;
    const { ctx, logs } = await open(pageUrl('nothreads', '', [intake, '--level-seconds=1.5']));
    await sleep(4000);
    await ctx.close();
    check('debug: on this machine, a debug export without ?glitchless sends nothing', () => {
      assert.deepEqual(proxy.requests.slice(from), []);
      assert.ok(logs.includes('glitchless on: false'), logs.join('\n'));
    });
    const from2 = proxy.requests.length;
    const hosted = await open(pageUrl('nothreads', 'glitchless-synthetic', [intake, '--level-seconds=1.5'], 'game.test'));
    await waitFor(() => eventsOf(intakes(from2)).some((e) => e.type === 'frame_window'), 10_000);
    await hosted.ctx.close();
    const start = eventsOf(intakes(from2)).find((e) => e.type === 'session_start');
    check('debug: on a page anywhere else, players are playing it: a debug export sends', () => {
      assert.ok(hosted.logs.includes('glitchless on: true'), hosted.logs.join('\n'));
      assert.ok(start, 'no session_start');
    });
    check('debug: ?glitchless-synthetic marks the session a bot\'s', () => assert.equal(start?.session_type, 'synthetic'));
  }

  // 5. off switch: kept in IndexedDB across visits
  {
    const ctx = await browser.newContext();
    const from = proxy.requests.length;
    const first = await open(pageUrl('nothreads', 'glitchless', [intake, '--level-seconds=1.5', '--off-at=1']), ctx);
    await waitFor(() => first.logs.some((l) => l.startsWith('glitchless on: false (set_enabled(false)')), 10_000);
    await sleep(1500);  // Godot copies user:// to IndexedDB a frame after a write
    await first.page.goto('about:blank');
    const sentBefore = proxy.requests.length;
    const second = await open(pageUrl('nothreads', 'glitchless', [intake, '--level-seconds=1.5']), ctx);
    await sleep(4000);
    await ctx.close();
    check('off switch: the player\'s off holds on the next visit: nothing is measured or sent', () => {
      assert.ok(proxy.requests.slice(from, sentBefore).length > 0, 'the first visit sent nothing before the player turned it off');
      assert.deepEqual(proxy.requests.slice(sentBefore).map((r) => `${r.method} ${r.path}`), []);
      assert.ok(second.logs.includes('glitchless on: false'), second.logs.join('\n'));
    });
  }

  // 6. outbox: what a visit couldn't send waits in IndexedDB for the next
  {
    const ctx = await browser.newContext();
    const dead = await freePort();
    const first = await open(pageUrl('nothreads', 'glitchless', [`--intake=http://127.0.0.1:${dead}`, '--level-seconds=1.5']), ctx);
    await sleep(4500);
    await first.page.goto('about:blank');
    const from = proxy.requests.length;
    const second = await open(pageUrl('nothreads', 'glitchless', [intake, '--level-seconds=1.5']), ctx);
    await waitFor(() => new Set(eventsOf(intakes(from)).filter((e) => e.type === 'session_start').map((e) => e.session_id)).size >= 2, 10_000);
    await second.page.goto('about:blank');
    await ctx.close();
    const starts = eventsOf(intakes(from)).filter((e) => e.type === 'session_start');
    check('outbox: the batches a visit couldn\'t send are sent on the next visit, under a new session ID', () => {
      assert.ok(starts.length >= 2, `${starts.length} sessions`);
      const earlier = starts.find((e) => e.ts < starts[starts.length - 1].ts);
      assert.ok(earlier, 'no earlier session');
      assert.ok(eventsOf(intakes(from)).some((e) => e.session_id === earlier.session_id && e.type === 'frame_window'), 'the earlier session came without its frames');
    });
  }
} finally {
  await browser?.close();
  await proxy?.close();
  await exports?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const [status, name, why] of results) console.log(`${status === 'ok' ? '✔' : '✖'} ${name}${why ? `\n    ${why}` : ''}`);
const failed = results.filter((r) => r[0] !== 'ok').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (Godot: ${godot})`);
process.exit(failed ? 1 : 0);
