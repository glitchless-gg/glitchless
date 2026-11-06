// The Roblox SDK end to end against a real Glitchless server, without Roblox: a race in the fake Roblox
// (roblox/test/e2e.luau, run under Lune) sends over real HTTP, gzipped, to server/src/local.js on a port of its own,
// and this reads back what the server made of it through the same /v1/query API the dashboard uses.
//   node roblox/test/e2e.mjs
//   GLITCHLESS_CAPTURE=server/test/fixtures/sdk-payloads/roblox.json node roblox/test/e2e.mjs   also writes the
//   batches as the server's cross-SDK payload test (server/test/sdk-payloads.test.js) reads them
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVICE = 'roblox-e2e';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-roblox-e2e-'));
let server;
let port;
let run;
let batches;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  port = await freePort();
  server = spawn(process.execPath, [path.join(REPO, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_PLAY_PORT: String(await freePort()), GLITCHLESS_DATA_DIR: path.join(tmp, 'data'), GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '', GLITCHLESS_CLIENT_TOKENS: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const capture = path.join(tmp, 'batches.json');
  const out = execFileSync('lune', ['run', 'roblox/test/e2e', `http://127.0.0.1:${port}`, capture], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  run = JSON.parse(out.trim().split('\n').at(-1));
  batches = JSON.parse(fs.readFileSync(capture, 'utf8'));
  if (process.env.GLITCHLESS_CAPTURE) {
    const fixture = {
      sdk: 'roblox',
      service: SERVICE,
      captured: new Date().toISOString(),
      note: 'roblox/test/e2e.luau: a three-player race in the fake Roblox under Lune (a kick, a client and a server error, counters, a zone), the Roblox server sending every session, as it sent them',
      batches,
    };
    fs.writeFileSync(path.resolve(REPO, process.env.GLITCHLESS_CAPTURE), JSON.stringify(fixture) + '\n');
  }
});

after(() => {
  server?.kill(); // this test's own server, by its handle
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function query(name, params = {}) {
  const qs = new URLSearchParams({ service: SERVICE, from: String(Date.now() - 3_600_000), to: String(Date.now() + 600_000), ...params });
  const res = await fetch(`http://127.0.0.1:${port}/v1/query/${name}?${qs}`);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
  return res.json();
}

test('the run sent its batches with no errors in the SDK', () => {
  assert.equal(Object.keys(run.errors).length, 0, JSON.stringify(run.errors));
  assert.ok(run.batches >= 6, JSON.stringify(run));
  assert.equal(run.intake, run.batches, 'every batch taken at the first try');
});

test('the server files the players under the game and the Roblox server under its companion', async () => {
  const { services } = await query('services');
  const game = services.find((s) => s.service === SERVICE);
  assert.ok(game, JSON.stringify(services));
  assert.equal(game.server?.service, `${SERVICE}.server`);
});

test('three players, one kicked; their device kinds; nothing names them', async () => {
  const sessions = await query('sessions');
  const list = sessions.sessions || sessions;
  assert.equal(list.length, 3, JSON.stringify(list).slice(0, 500));
  const text = JSON.stringify(batches);
  for (const name of ['xX_Racer_Xx', 'Pocket', 'Third', '284019882']) assert.ok(!text.includes(name), `${name} is not sent`);
  const starts = batches.flatMap((b) => b.events).filter((e) => e.type === 'session_start' && !e.server);
  assert.deepEqual(starts.map((e) => e.device.os).sort(), ['Computer', 'Computer', 'Phone']);
  const ends = batches.flatMap((b) => b.events).filter((e) => e.type === 'session_end');
  assert.ok(ends.some((e) => e.reason === 'kicked'));
});

test('frame times, hitches and the level read back', async () => {
  const perf = await query('performance');
  assert.ok(perf.kpis.frame_p50 > 16 && perf.kpis.frame_p50 < 18 && perf.kpis.hitches > 0, JSON.stringify(perf.kpis));
  assert.ok(perf.kpis.ttff_p50 >= 0, 'the loading screen, from join to first frame');
  const fw = batches.flatMap((b) => b.events).filter((e) => e.type === 'frame_window');
  assert.ok(fw.some((e) => e.level === 'desert_loop' && e.match?.startsWith('h_')));
  const hitches = batches.flatMap((b) => b.events).filter((e) => e.type === 'hitch');
  assert.ok(hitches.length > 0 && hitches.every((h) => h.duration_ms >= 100), JSON.stringify(hitches[0]));
});

test('errors from a client and the server are issues, scrubbed', async () => {
  const errors = batches.flatMap((b) => b.events).filter((e) => e.type === 'error');
  assert.equal(errors.length, 2, JSON.stringify(errors));
  assert.ok(errors.some((e) => e.source === 'Players.<player>.PlayerGui.Hud' && e.fn === 'Hud.refresh'));
  assert.ok(errors.some((e) => e.message === "<player>'s kart is missing" && e.fn === 'Race.respawn'));
  const issues = await query('errors');
  assert.ok((issues.issues || issues).length >= 1, JSON.stringify(issues).slice(0, 300));
});

test('the race is one match across the players and the server', async () => {
  const { matches } = await query('matches');
  assert.ok(matches.length >= 1, JSON.stringify(matches).slice(0, 300));
  // the race's ID hashed as every SDK hashes it (service roblox-e2e), on the players' and the server's group events
  const race = matches.find((m) => m.servers >= 1 || m.server);
  assert.ok(race, JSON.stringify(matches[0]));
});

test('the Roblox server: its windows, players and late frames', async () => {
  const view = await query('servers');
  assert.ok(view.kpis.servers >= 1 && view.kpis.windows > 0, JSON.stringify(view.kpis));
});

test('counters and properties arrive', async () => {
  const events = batches.flatMap((b) => b.events);
  const counts = events.filter((e) => e.type === 'counts').flatMap((e) => e.counts);
  assert.ok(counts.some((c) => c.name === 'coin' && c.sums?.value > 0));
  // set before each session's first batch, so in its session_start (a later change would be a props event)
  assert.equal(events.filter((e) => e.type === 'session_start' && e.props?.car_class === 's').length, 3);
  assert.ok(events.some((e) => e.zone === 'canyon'));
});
