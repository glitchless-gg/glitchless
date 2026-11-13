#!/usr/bin/env node
// A game check end to end, on this computer: an open-source Glitchless server of its own, and a plain WebGL game
// (test/fixtures/check-game, no Glitchless in it) served beside it. The check plays the game on a desktop and on a
// throttled phone, and this checks what it found: the error the game throws, the sound file that isn't there, the waves
// it shows, the memory it leaks, the dashboard it saved, and that robots.txt and a 403 stop it before it plays.
// Needs Playwright and Chrome; takes about two minutes. Run from the repo: npm run test:check
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameCheck } from '../src/check.js';
import { loadPlaywright } from '../src/run.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const GAME = path.join(HERE, 'fixtures/check-game');
const step = (msg) => console.log(`✔ ${msg}`);

try {
  await loadPlaywright(ROOT);
} catch (err) {
  console.log(`skipped: ${err.message}`);
  process.exit(0);
}
if (!fs.existsSync(path.join(ROOT, 'packages/sdk/dist/glitchless.js'))) execSync('npm run build -w glitchless', { cwd: ROOT, stdio: 'inherit' });

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const [port, playPort] = [await freePort(), await freePort()];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-check-e2e-'));
const server = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
  env: { ...process.env, PORT: String(port), GLITCHLESS_PLAY_PORT: String(playPort), GLITCHLESS_DATA_DIR: path.join(dir, 'data'), GLITCHLESS_DATADOG: 'off', GLITCHLESS_OTLP: 'off', GLITCHLESS_INGEST_RPS: '0', GLITCHLESS_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// The game's site: the game, a robots.txt that keeps bots out of /private/, and a page that answers 403.
const site = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private/\n');
  if (p.startsWith('/blocked/')) return res.writeHead(403, { 'content-type': 'text/html' }).end('<title>Forbidden</title>');
  if (p === '/' || p === '/private/') return res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(path.join(GAME, 'index.html')));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const gameUrl = `http://127.0.0.1:${site.address().port}`;
const base = `http://localhost:${port}`;

try {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited (${code})`)));
    setTimeout(() => reject(new Error('server did not start')), 15_000);
  });

  await assert.rejects(gameCheck({ url: `${gameUrl}/private/`, server: base, apiKey: '', seconds: 15, outDir: path.join(dir, 'private') }), /asks bots not to visit \/private\//);
  step('robots.txt keeps the check out of /private/ before it plays');
  const blocked = await gameCheck({ url: `${gameUrl}/blocked/`, server: base, apiKey: '', seconds: 15, outDir: path.join(dir, 'blocked') });
  assert.equal(blocked.profiles.length, 1, 'a refusal ends the check: no phone visit after it');
  assert.ok(blocked.profiles[0].refused);
  assert.match(blocked.report, /answered 403/);
  step('a 403 stops the check on its first visit, and the report says why');

  const log = [];
  const r = await gameCheck({ url: `${gameUrl}/`, server: base, apiKey: '', seconds: 30, outDir: path.join(dir, 'check'), log: (m) => log.push(m) });
  assert.equal(r.game.name, 'Square Siege', "the game's name is its page's title");
  assert.equal(r.game.service, 'square-siege');
  assert.deepEqual(r.profiles.map((p) => p.profile), ['desktop', 'phone']);
  for (const p of r.profiles) {
    assert.match(p.session_id || '', /^s_/, `${p.profile} ran with Glitchless in the page`);
    assert.ok(p.steps.length >= 4, `${p.profile} played several steps`);
    assert.ok(p.page.contexts.includes('webgl'));
  }
  assert.deepEqual(r.profiles[1].viewport, { width: 844, height: 390 }, 'the phone is held sideways for a wide game');
  step(`played on a desktop and a throttled phone (${r.profiles.map((p) => `${p.profile}: ${p.steps.length} steps`).join(', ')})`);

  assert.equal(r.summary?.runs?.length, 2, "Glitchless's summary has both runs");
  assert.ok(r.summary.runs.every((x) => x.session_type === 'synthetic'), 'every run is a bot session, never a player');
  assert.ok(r.summary.errors.some((e) => /reading 'charge'/.test(e.message)), "the desktop bot's third Space press threw, and Glitchless has it");
  assert.ok(r.profiles[0].load.missing.some((m) => /sfx\/explosion\.ogg/.test(m.url) && m.status === 404));
  assert.ok(r.profiles.some((p) => Object.keys(p.page.labels).some((l) => /^Wave [2-9]/.test(l))), 'the waves on screen were read');
  const heap = r.profiles[0].steps.map((s) => s.heap_mb).filter(Number.isFinite);
  assert.ok(heap.at(-1) - heap[0] >= 15, `the leak shows: ${heap[0]} → ${heap.at(-1)} MB`);
  step(`found the error, the missing sound, the waves and the leak (${heap[0]} → ${heap.at(-1)} MB)`);

  assert.match(r.report, /^# Game check: Square Siege/);
  assert.match(r.report, /fireLaser/);
  assert.match(r.report, /explosion\.ogg/);
  assert.match(r.report, /not from the game's players/);
  assert.match(r.dm, new RegExp(`${base.replace(/[/.]/g, '\\$&')}/\\?service=square-siege#/check`));
  for (const f of [r.files.report, r.files.dm, r.files.json, ...r.files.shots]) assert.ok(fs.existsSync(f), f);
  step(`wrote the report, the message and ${r.files.shots.length} screenshots`);

  const dash = await fetch(`${base}/v1/dashboard?service=square-siege`).then((x) => x.json());
  assert.equal(dash.dashboard.pages[0].id, 'check');
  const board = await fetch(`${base}/v1/query/board?service=square-siege&page=check`).then((x) => x.json());
  const panel = (type) => board.board.panels.find((p) => p.type === type);
  assert.ok(panel('stat').value > 0, 'the frames-a-second stat has a number');
  assert.deepEqual(panel('versions').rows.map((x) => x.version).sort(), ['desktop', 'phone'], 'desktop and phone side by side');
  assert.ok(panel('table').rows?.length || panel('table').groups?.length, 'what the bots did is listed');
  const brand = await fetch(`${base}/v1/brand?service=square-siege`).then((x) => x.json());
  assert.equal(brand.brand?.banner?.type, 'image/jpeg', "a screenshot of the game is the board's banner");
  step('saved the dashboard: its check page reads, desktop and phone side by side, with the game as its banner');
} finally {
  server.kill();
  site.close();
}
console.log('game check e2e: all passed');
