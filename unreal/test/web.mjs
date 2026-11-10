// The plugin's web layer, in Chromium, without the engine: builds unreal/test/web/PageTest.cpp with em++ as UE 5.9
// builds a Wasm game (wasm64 lowered to 32-bit memory, pthreads, PROXY_TO_PTHREAD, so main() is a Worker like the game
// thread), with Private/Web/GlitchlessWebPage.cpp and the core's page rules, serves it cross-origin isolated (COOP and
// COEP, as UE's page is), and plays it against a fresh local Glitchless server behind a proxy that notes how every
// request came. A UE web build of the test game is checked elsewhere, on an engine that can build one.
//
//   node unreal/test/web.mjs
//   WASM_EMSDK_ROOT=/path/to/emsdk node unreal/test/web.mjs     (else $EMSDK, else ~/emsdk; Epic's 5.9 wants 6.0.10)
//
// Needs Playwright's Chromium (npx playwright install chromium).
//   1. local   the page on 127.0.0.1: its facts read as device.js reads them (browser, OS, GPU), a page on this
//              machine, the server's health over a GET, a batch over a POST answered 2xx as text/plain with no CORS
//              preflight, one released on its way that still lands, one over keepalive's budget, one to an address
//              with nothing behind it (0, not a hang); hidden, the page sends what waits and plays on, and hands
//              the page its parting batch; shown again, takes it back; leaving it, the page beacons that batch
//   2. hosted  the same page at game.test: not on this machine, and ?glitchless on its address is a flag
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ROOT, checker, freePort, startServer } from './harness.mjs';

const PLUGIN = path.join(ROOT, 'unreal/Plugins/Glitchless/Source');
const CORE = path.join(PLUGIN, 'Glitchless/Private/Core');
const WEB = path.join(PLUGIN, 'Glitchless/Private/Web');
const { check, finish } = checker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-web-'));

function emxx() {
  const roots = [process.env.WASM_EMSDK_ROOT, process.env.EMSDK, path.join(os.homedir(), 'emsdk')].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'upstream/emscripten', process.platform === 'win32' ? 'em++.bat' : 'em++');
    if (fs.existsSync(p)) return p;
  }
  console.error(`em++ not found in ${roots.join(', ')}: install emsdk 6.0.10 (git clone https://github.com/emscripten-core/emsdk ~/emsdk, then ./emsdk install 6.0.10 && ./emsdk activate 6.0.10) or set WASM_EMSDK_ROOT.`);
  process.exit(2);
}

function build() {
  const out = path.join(tmp, 'site');
  fs.mkdirSync(out);
  const sources = [path.join(ROOT, 'unreal/test/web/PageTest.cpp'), path.join(WEB, 'GlitchlessWebPage.cpp'), ...['GlitchlessPage', 'GlitchlessJson', 'GlitchlessText', 'GlitchlessSketch'].map((f) => path.join(CORE, `${f}.cpp`))];
  // UE 5.9's Wasm settings that matter here (WasmToolChain.cs): wasm64 lowered to 32-bit memory, pthreads with the
  // engine's main on a Worker, memory that grows, no exceptions or RTTI; and the warnings as errors.
  const args = ['-std=c++20', '-O1', '-fno-exceptions', '-fno-rtti', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-Wno-pthreads-mem-growth',
    '-pthread', '-m64', '-sMEMORY64=2', '-sPROXY_TO_PTHREAD', '-sPTHREAD_POOL_SIZE=2', '-sALLOW_MEMORY_GROWTH=1', '-sEXIT_RUNTIME=1', '-sENVIRONMENT=web,worker',
    "-sEXPORTED_RUNTIME_METHODS=['UTF8ToString']", `-I${CORE}`, `-I${WEB}`, `-I${path.join(PLUGIN, 'ThirdParty/fdlibm')}`, ...sources, '-o', path.join(out, 'page.html')];
  console.log('building the page test with em++…');
  const r = spawnSync(emxx(), args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`${r.stdout}\n${r.stderr}`);
    throw new Error('em++ failed');
  }
  return out;
}

// The build, as UE's serve.py serves it: cross-origin isolated, so its Workers share memory.
function serveSite(dir, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, new URL(req.url, 'http://x').pathname);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// Every request on its way to the server, as it came: method, path, type, and the batch.
function startProxy(port, serverPort, seen) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, path: req.url, type: req.headers['content-type'] || null, at: Date.now() };
      try {
        entry.json = body.length ? JSON.parse(body.toString('utf8')) : null;
      } catch {}
      seen.push(entry);
      try {
        const r = await fetch(`http://127.0.0.1:${serverPort}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k))), body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body });
        const headers = Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)));
        res.writeHead(r.status, headers);
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const lines = (log, what) => log.filter((l) => l.startsWith(`GLT ${what} `)).map((l) => JSON.parse(l.slice(`GLT ${what} `.length)));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`  (waited ${ms} ms for ${label})`);
  return false;
}

const site = build();
const [sitePort, proxyPort, serverPort] = [await freePort(), await freePort(), await freePort()];
const glitchless = await startServer(serverPort, path.join(tmp, 'data'));
const seen = [];
const proxy = await startProxy(proxyPort, serverPort, seen);
const web = await serveSite(site, sitePort);
let browser;
try {
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP game.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=http://game.test:${sitePort}`] });
} catch (err) {
  console.error(`Playwright's Chromium didn't start (npx playwright install chromium): ${err.message}`);
  process.exit(2);
}

async function play(label, host, query) {
  const page = await browser.newPage();
  const log = [];
  page.on('console', (m) => log.push(m.text()));
  page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));
  const session = `s_web${label}0000000000`.slice(0, 18);
  const from = seen.length;
  await page.goto(`http://${host}:${sitePort}/page.html?intake=http://127.0.0.1:${proxyPort}&session=${session}${query}`);
  await until(() => lines(log, 'sent').length > 0 || log.some((l) => l.startsWith('PAGEERROR')), 30_000, `${label}: the page's sends`);
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  // Hidden: another tab. Then the page goes (another page in its place).
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await until(() => lines(log, 'event').some((e) => e.event === 0), 10_000, `${label}: the hidden event`);
  // In view and out again: the parting batch taken back, then handed over again, so exactly one goes.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await until(() => lines(log, 'event').filter((e) => e.event === 0).length >= 2, 10_000, `${label}: hidden again`);
  await new Promise((r) => setTimeout(r, 300)); // the parting batch reaches the page
  await page.goto('about:blank');
  await until(() => seen.slice(from).some((s) => s.json?.events?.[0]?.name === 'leaving'), 5_000, `${label}: the batch sent as the page went`);
  await page.close();
  return { log, isolated, requests: seen.slice(from), session };
}

const local = await play('local', '127.0.0.1', '');
const hosted = await play('hosted', 'game.test', '&glitchless&glitchless-intake=https://elsewhere.example');
fs.writeFileSync(path.join(tmp, 'local.log'), local.log.join('\n'));
fs.writeFileSync(path.join(tmp, 'hosted.log'), hosted.log.join('\n'));

for (const [label, run] of [['local', local], ['hosted', hosted]]) {
  const facts = lines(run.log, 'facts')[0];
  const batches = run.requests.filter((r) => r.path.startsWith('/v1/intake') && r.method === 'POST');
  const named = (n) => batches.filter((b) => b.json?.events?.[0]?.name === n);
  check(`${label}: the page is cross-origin isolated and main() runs on a Worker, as a UE 5.9 game's does`, () => {
    assert.ok(run.isolated, 'not cross-origin isolated');
    assert.deepEqual(lines(run.log, 'start')[0], { web: true });
    assert.ok(!run.log.some((l) => l.startsWith('PAGEERROR')), run.log.filter((l) => l.startsWith('PAGEERROR')).join('\n'));
  });
  check(`${label}: the page's facts read as device.js reads them`, () => {
    assert.ok(facts?.parsed, JSON.stringify(facts));
    const d = facts.device;
    assert.equal(d.browser, 'Chrome');
    assert.match(d.browser_version, /^\d+$/);
    assert.equal(d.os, process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');
    assert.equal(d.mobile, false);
    assert.ok(d.cores > 0, `cores ${d.cores}`);
    assert.ok(Array.isArray(d.screen) && d.screen[0] > 0, `screen ${JSON.stringify(d.screen)}`);
    assert.ok(typeof d.gpu === 'string' && d.gpu.length > 0 && !d.gpu.startsWith('ANGLE ('), `gpu ${d.gpu}`);
  });
  check(`${label}: the server's health comes back over a GET`, () => {
    const h = lines(run.log, 'health')[0];
    assert.equal(h?.status, 200, JSON.stringify(h));
    assert.equal(JSON.parse(h.text).ok, true);
  });
  check(`${label}: batches go as text/plain with no CORS preflight, answered 2xx; a released one still lands`, () => {
    const sent = lines(run.log, 'sent')[0];
    assert.ok(sent.first >= 200 && sent.first < 300, `first: ${sent.first}`);
    assert.equal(named('first').length, 1);
    assert.equal(named('released').length, 1, 'the batch released on its way never arrived');
    assert.ok(batches.every((b) => b.type === 'text/plain'), JSON.stringify(batches.map((b) => b.type)));
    assert.deepEqual(run.requests.filter((r) => r.method === 'OPTIONS').map((r) => r.path), []);
  });
  check(`${label}: a batch over keepalive's budget still goes, and one to nowhere fails at once`, () => {
    const sent = lines(run.log, 'sent')[0];
    assert.ok(sent.large >= 200 && sent.large < 500, `large: ${sent.large}`);
    assert.equal(named('x'.repeat(200000)).length, 1);
    assert.equal(sent.nowhere, 0);
  });
  check(`${label}: hidden, the page sends what waits and plays on`, () => {
    const hidden = lines(run.log, 'event').filter((e) => e.event === 0);
    assert.equal(hidden.length, 2, 'the page was hidden twice');
    assert.ok(hidden.every((h) => h.status >= 200 && h.status < 300), JSON.stringify(hidden));
    assert.equal(named('hidden').length, 2);
  });
  check(`${label}: as the page goes, it beacons the parting batch it was handed, once`, () => {
    const leaving = named('leaving');
    assert.equal(leaving.length, 1, `events seen: ${JSON.stringify(lines(run.log, 'event'))}`);
    assert.equal(leaving[0].type, 'text/plain');
    assert.deepEqual(lines(run.log, 'event').map((e) => e.event), [0, 1, 0]);
  });
}
check('local: a page on 127.0.0.1 is the developer\'s, with no flags', () => {
  const f = lines(local.log, 'facts')[0];
  assert.equal(f.local, true);
  assert.deepEqual(f.flags, []);
});
check('hosted: a page at game.test is played by players, and only ?glitchless counts as a flag', () => {
  const f = lines(hosted.log, 'facts')[0];
  assert.equal(f.local, false);
  assert.deepEqual(f.flags, ['-glitchless']);
});

await browser.close();
web.close();
proxy.close();
glitchless.kill();
finish('Chromium', tmp);
