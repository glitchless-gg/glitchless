// The test game as a UE web build (UE 5.9's Wasm target), played in Chromium against a fresh local Glitchless server
// behind a proxy that notes how every request came. web.mjs checks the plugin's web layer without the engine; this
// checks it in a real Unreal page.
//
//   node unreal/test/web-game.mjs --stage=<folder>    a staged Wasm build of unreal/test/GlitchlessTest (the folder
//                                                     with index.html), from an engine that builds for Wasm
//   node unreal/test/web-game.mjs --build             package it here first (UE_ROOT: an engine with the Wasm
//                                                     platform: a 5.9 source build; the Mac launcher build has none)
//   --headless                                        no window (WebGPU in headless Chromium needs a GPU it can use)
//   --headless=new                                    no window, in the full Chromium, which keeps its GPU (the
//                                                     headless shell lost its WebGPU device on a Mac, 11 Nov 2026)
//
// The page passes the run's command line as ?args= (a Development build takes any), and ?glitchless stands in for
// -glitchless, as a page's address does for a player.
//   1. the session: sent by the page's fetch as text/plain with no CORS preflight, the device the browser (Chrome,
//      its OS and GPU), session_start.engine Unreal on WebGPU, frame windows and the map as a level
//   2. hidden: what waits goes at once and the session goes on
//   3. leaving while it shows, as a closed tab does: the page beacons the session's end (session_end and
//      level_abandon, reason pagehide), once
//   4. what the page keeps, in one browser profile as one player's browser is, in install mode (an -ini override on
//      ?args=) and with Saved in memory (Epic's ?saved=memory: where an iPhone, or a C++ game packaged from the
//      launcher's 5.9 preview, keeps it): reloaded, it is the same player; turned off by the player (the test
//      game's -glitchless-test-off) and reloaded, no request leaves the page; turned on again, the same player;
//      with Saved in the browser's own files (OPFS), still the same player; in anonymous mode, no ID is sent or kept
//      --no-kept skips it (seven more loads of the game)
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
      const entry = { method: req.method, path: req.url, type: req.headers['content-type'] || null, at: Date.now() };
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
const browser = await chromium.launch({ headless: !!args.headless, ...(args.headless === 'new' ? { channel: 'chromium' } : {}), args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await browser.newPage();
const log = [];
page.on('console', (m) => log.push(m.text()));
page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));

const ueArgs = `-glitchless-intake=http://127.0.0.1:${proxyPort}`;
console.log(`playing ${stage} in Chromium…`);
await page.goto(`http://127.0.0.1:${stagePort}/index.html?harness=1&glitchless&args=${encodeURIComponent(ueArgs)}`);
let firstRun = Infinity; // how many requests the first page made: the loads of part 4 come after
const batches = () => seen.slice(0, firstRun).filter((s) => s.method === 'POST' && s.path.startsWith('/v1/intake'));
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
await page.close();
fs.writeFileSync(path.join(tmp, 'console.log'), log.join('\n'));

// 4. What the page keeps. Each load is a new page in one profile; what it sent, and what the page's localStorage
// holds for the game afterwards (the plugin names it by the game's Saved folder, "glitchless:<Saved>/Glitchless/").
const INSTALL = '-ini:Game:[/Script/Glitchless.GlitchlessSettings]:Privacy=Install';
const kept = {};
firstRun = seen.length;
if (!args['no-kept']) {
  const profile = await browser.newContext();
  const load = async (label, flags, query, done, ms = 180_000) => {
    const p = await profile.newPage();
    const run = { log: [], from: seen.length };
    p.on('console', (m) => {
      run.log.push(m.text());
      if (!run.mountedAt && m.text().includes('file systems:')) run.mountedAt = Date.now(); // the engine is about to start
    });
    p.on('pageerror', (e) => run.log.push(`PAGEERROR ${e.message}`));
    run.batches = () => seen.slice(run.from).filter((r) => r.method === 'POST' && r.path.startsWith('/v1/intake'));
    run.said = (text) => run.log.some((l) => l.includes(text));
    console.log(`  ${label}…`);
    await p.goto(`http://127.0.0.1:${stagePort}/index.html?harness=1&glitchless&args=${encodeURIComponent([ueArgs, ...flags].join(' '))}${query}`);
    await until(() => done(run) || run.said('PAGEERROR'), ms, label);
    await new Promise((r) => setTimeout(r, 5000)); // what was on its way lands, and the page has what it was handed
    run.kept = await p.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('glitchless:')).map((k) => [k, localStorage.getItem(k)])));
    await p.goto('about:blank');
    await new Promise((r) => setTimeout(r, 2000)); // a parting batch lands
    await p.close();
    run.requests = seen.slice(run.from);
    run.players = [...new Set(run.batches().map((b) => b.json?.player_id ?? null))];
    run.sessions = [...new Set(run.batches().map((b) => b.json?.session_id))];
    run.privacy = run.batches().flatMap((b) => b.json?.events || []).find((e) => e.type === 'session_start')?.privacy;
    run.of = (name) => Object.entries(run.kept).find(([k]) => k.endsWith(`/Glitchless/${name}`))?.[1];
    fs.writeFileSync(path.join(tmp, `kept-${label.replace(/\W+/g, '-')}.log`), run.log.join('\n'));
    kept[label] = run;
    return run;
  };
  const started = (run) => run.batches().some((b) => (b.json?.events || []).some((e) => e.type === 'frame_window'));
  const MEMORY = '&saved=memory';
  const first = await load('first', [INSTALL], MEMORY, started);
  // How long this machine takes from the engine's start to the plugin's first batch: an off page gets three times that.
  const startMs = Math.max(10_000, (first.batches()[0]?.at ?? Date.now()) - (first.mountedAt ?? Date.now()));
  await load('reloaded', [INSTALL], MEMORY, started);
  await load('off', [INSTALL, '-autoplay', '-glitchless-test-off'], MEMORY, (run) => run.said('Glitchless turned off by the player'));
  // Off from the start: the game plays on for three times as long as it took to send its first batch, and says nothing.
  await load('still off', [INSTALL], MEMORY, (run) => run.mountedAt && Date.now() - run.mountedAt > 3 * startMs, 600_000);
  await load('on', [INSTALL, '-autoplay', '-glitchless-test-on'], MEMORY, (run) => run.said('Glitchless turned on by the player') && started(run));
  await load('opfs', [INSTALL], '', started);
  await load('anonymous', [], MEMORY, started);
  await profile.close();
  fs.writeFileSync(path.join(tmp, 'kept.json'), JSON.stringify(Object.fromEntries(Object.entries(kept).map(([k, r]) => [k, { players: r.players, sessions: r.sessions, privacy: r.privacy, kept: r.kept, requests: r.requests.map((q) => `${q.method} ${q.path.split('?')[0]}`), saved: r.log.find((l) => l.includes('file systems:')) }])), null, 1));
}
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

if (!args['no-kept']) {
  const { first, reloaded, off, 'still off': stillOff, on, opfs, anonymous } = kept;
  const player = first.players[0];
  check('kept: no page errors, and Saved is in memory where the test asks (?saved=memory), in OPFS where it doesn\'t', () => {
    for (const [label, run] of Object.entries(kept)) {
      assert.ok(!run.said('PAGEERROR'), `${label}: ${run.log.filter((l) => l.startsWith('PAGEERROR')).slice(0, 3).join(' / ')}`);
      assert.ok(run.said(label === 'opfs' ? 'Saved on OPFS' : 'Saved on memory (?saved=memory)'), `${label}: ${run.log.find((l) => l.includes('file systems:'))}`);
    }
  });
  check('kept: install mode sends a player ID, and the page keeps it', () => {
    assert.equal(first.privacy, 'install');
    assert.equal(first.players.length, 1, JSON.stringify(first.players));
    assert.match(player || '', /^p_[a-z0-9]{12}$/);
    assert.equal(first.of('player_id'), player, JSON.stringify(first.kept));
  });
  check('kept: reloaded with Saved gone, it is the same player in a new session', () => {
    assert.deepEqual(reloaded.players, [player]);
    assert.ok(reloaded.sessions.every((s) => !first.sessions.includes(s)), 'a session ID was used again');
    assert.equal(reloaded.of('player_id'), player);
  });
  check('kept: the player turns it off, and the page keeps "off"', () => {
    assert.equal(off.of('enabled'), 'off', JSON.stringify(off.kept));
    assert.equal(off.of('player_id'), player);
  });
  check('kept: reloaded, off is still off from the start: no request of any kind leaves the page', () => {
    assert.ok(stillOff.mountedAt, 'the game did not start');
    assert.deepEqual(stillOff.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`), []);
    assert.equal(stillOff.of('enabled'), 'off');
  });
  check('kept: turned on again in a later load, it sends as the same player, and the page keeps "on"', () => {
    assert.deepEqual(on.players, [player]);
    assert.equal(on.of('enabled'), 'on');
  });
  check('kept: with Saved in the browser\'s own files (OPFS), still the same player', () => {
    assert.deepEqual(opfs.players, [player]);
  });
  check('kept: anonymous mode sends no player ID, and the page keeps none, not even the one install mode left', () => {
    assert.equal(anonymous.privacy, 'anonymous');
    assert.ok(anonymous.batches().length > 0, 'nothing was sent');
    assert.deepEqual(anonymous.players, [null]);
    assert.equal(anonymous.of('player_id'), undefined, JSON.stringify(anonymous.kept));
    assert.deepEqual(Object.values(anonymous.kept), ['on'], 'only the choice, the same for everyone who made it');
  });
}

await browser.close();
site.close();
proxy.close();
glitchless.kill();
finish('a UE web build in Chromium', tmp);
