// The test game as a UE web build (UE 5.9's Wasm target), played in Chromium against a fresh local Glitchless server
// behind a proxy that notes how every request came. web.mjs checks the plugin's web layer without the engine; this
// checks it in a real Unreal page.
//
//   node unreal/test/web-game.mjs --stage=<folder>    a staged Wasm build of unreal/test/GlitchlessTest (the folder
//                                                     with index.html), from an engine that builds for Wasm
//   node unreal/test/web-game.mjs --build             package it here first (UE_ROOT: an engine with the Wasm
//                                                     platform: a 5.9 source build; the Mac launcher build has none)
//   --headless                                        no window (WebGPU in headless Chromium needs a GPU it can use)
//
// The page passes the run's command line as ?args= (a Development build takes any), and ?glitchless stands in for
// -glitchless, as a page's address does for a player.
//   1. the session: sent by the page's fetch as text/plain with no CORS preflight, the device the browser (Chrome,
//      its OS and GPU), session_start.engine Unreal on WebGPU, frame windows and the map as a level
//   2. hidden: what waits goes at once and the session goes on
//   3. leaving while it shows, as a closed tab does: the page beacons the session's end (session_end and
//      level_abandon, reason pagehide), once
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PROJECT, SERVICE, checker, freePort, packageGame, requireEngine, startServer } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const { check, finish } = checker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-webgame-'));

function stageFolder() {
  if (args.stage) return path.resolve(String(args.stage));
  const staged = path.join(path.dirname(PROJECT), 'Saved/StagedBuilds/Wasm');
  return staged;
}

if (args.build) {
  requireEngine();
  // -package writes what the page loads first: wasm-manifest.json, wasm-cache.json and the .br copies.
  packageGame('Wasm', path.join(tmp, 'package.log'), ['-iostore', '-package']);
}

const stage = stageFolder();
if (!fs.existsSync(path.join(stage, 'index.html'))) {
  console.error(`No staged Wasm build at ${stage} (no index.html): pass --stage=<folder> or --build.`);
  process.exit(2);
}

// The stage as UE's serve.py serves it: cross-origin isolated, with the types its files need.
function serveStage(dir, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// Every request on its way to the server, as it came.
function startProxy(port, serverPort, seen) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, path: req.url, type: req.headers['content-type'] || null };
      try {
        const text = body[0] === 0x1f && body[1] === 0x8b ? (await import('node:zlib')).gunzipSync(body).toString('utf8') : body.toString('utf8');
        entry.json = text ? JSON.parse(text) : null;
      } catch {}
      seen.push(entry);
      try {
        const r = await fetch(`http://127.0.0.1:${serverPort}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k))), body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body });
        res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k))));
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  (waited ${ms} ms for ${label})`);
  return false;
}

const [stagePort, proxyPort, serverPort] = [await freePort(), await freePort(), await freePort()];
const glitchless = await startServer(serverPort, path.join(tmp, 'data'));
const seen = [];
const proxy = await startProxy(proxyPort, serverPort, seen);
const site = await serveStage(stage, stagePort);
const browser = await chromium.launch({ headless: !!args.headless, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await browser.newPage();
const log = [];
page.on('console', (m) => log.push(m.text()));
page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));

const ueArgs = `-glitchless-intake=http://127.0.0.1:${proxyPort}`;
console.log(`playing ${stage} in Chromium…`);
await page.goto(`http://127.0.0.1:${stagePort}/index.html?harness=1&glitchless&args=${encodeURIComponent(ueArgs)}`);
const batches = () => seen.filter((s) => s.method === 'POST' && s.path.startsWith('/v1/intake'));
const events = () => batches().flatMap((b) => b.json?.events || []);
const has = (type) => events().some((e) => e.type === type);
await until(() => events().filter((e) => e.type === 'frame_window').length >= 2 || log.some((l) => l.startsWith('PAGEERROR')), 180_000, 'two frame windows');

const before = batches().length;
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await until(() => batches().length > before, 15_000, 'the batch sent as the page hid');
const afterHide = batches().length;
// Back in view, the tab then goes while it shows (closed, or another address): hidden and gone in one go, too fast for
// the game thread, so the page must already hold the session's end.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await new Promise((r) => setTimeout(r, 6000));
await page.goto('about:blank');
await until(() => events().some((e) => e.type === 'session_end'), 10_000, 'the session end beaconed as the page went');
fs.writeFileSync(path.join(tmp, 'console.log'), log.join('\n'));
fs.writeFileSync(path.join(tmp, 'requests.json'), JSON.stringify(seen.map((r) => ({ ...r, events: r.json?.events?.map((e) => e.type) })).map(({ json, ...r }) => r), null, 1));
// The screen's refresh rate as the page measured it ("PAGE DISPLAY_HZ 60 (measured 60.0)").
const hz = Number(log.find((l) => l.startsWith('PAGE DISPLAY_HZ'))?.split(' ')[2]) || null;

check('the page runs the game: no page errors', () => {
  assert.ok(!log.some((l) => l.startsWith('PAGEERROR')), log.filter((l) => l.startsWith('PAGEERROR')).slice(0, 5).join('\n'));
});
check('batches go by the page\'s fetch as text/plain, with no CORS preflight', () => {
  assert.ok(batches().length >= 2, `${batches().length} batches`);
  assert.ok(batches().every((b) => b.type === 'text/plain'), JSON.stringify(batches().map((b) => b.type)));
  assert.deepEqual(seen.filter((s) => s.method === 'OPTIONS').map((s) => s.path), []);
  assert.ok(batches().every((b) => b.json?.service === SERVICE), 'a batch for another service');
});
check('the device is the browser, and session_start names Unreal on WebGPU', () => {
  const start = events().find((e) => e.type === 'session_start');
  assert.ok(start, 'no session_start');
  assert.equal(start.device.browser, 'Chrome');
  assert.match(start.device.browser_version || '', /^\d+$/);
  assert.equal(start.device.os, process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');
  assert.equal(start.engine?.name, 'unreal');
  assert.match(start.engine?.version || '', /^5\.(9|\d{2,})\./);
  assert.equal(start.engine?.renderer, 'webgpu');
  assert.ok('driver' in start.device && 'renderer' in start.device, JSON.stringify(start.device));
});
check('frame windows arrive, and the map is a level', () => {
  assert.ok(has('frame_window'), 'no frame windows');
  assert.ok(has('level_start'), 'no level_start');
});
// A page that isn't showing runs its engine without waiting for the browser's frames: those ticks aren't frames.
// Playwright keeps every page visible, and a page told it is hidden at the start never beacons its end (UE's page
// reads the same state), so a hidden start was checked by hand (9 Nov 2026); this checks a plain one.
check('frames are the ones the page showed: none faster than a screen, and the budget is the screen\'s', () => {
  const windows = events().filter((e) => e.type === 'frame_window');
  assert.deepEqual(windows.filter((w) => w.fps > 250).map((w) => [w.fps, w.frames]), []);
  if (hz) assert.ok(windows.every((w) => w.hz === hz), `windows judged at ${[...new Set(windows.map((w) => w.hz))]} Hz on a ${hz} Hz screen`);
});
check('hidden, what waits goes at once and the session goes on', () => {
  assert.ok(afterHide > before, 'nothing went as the page hid');
  const ended = batches().slice(0, afterHide).flatMap((b) => b.json?.events || []).filter((e) => e.type === 'session_end');
  assert.deepEqual(ended, [], 'the session ended as the page hid');
});
check('leaving while it shows, the page beacons the session\'s end once, reason pagehide', () => {
  const ends = events().filter((e) => e.type === 'session_end');
  assert.equal(ends.length, 1, JSON.stringify(ends));
  assert.equal(ends[0].reason, 'pagehide');
  const abandon = events().find((e) => e.type === 'level_abandon');
  assert.equal(abandon?.reason, 'pagehide');
});

await browser.close();
site.close();
proxy.close();
glitchless.kill();
finish('a UE web build in Chromium', tmp);
