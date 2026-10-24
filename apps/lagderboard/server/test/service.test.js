import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboardService, cleanDeviceName, scoreBin } from '../leaderboard.js';
import { createHandler } from '../http.js';
import { MemoryStore } from '../memory-store.js';

const NOW = Date.UTC(2026, 9, 30);
const make = (opts = {}) => {
  const store = new MemoryStore({ now: () => NOW });
  return createLeaderboardService({ store, now: () => NOW, ...opts });
};
const run = (over) => ({ score: 1000, deviceClass: 'desktop', deviceName: 'Apple M3 Max', seconds: 20, browser: 'Chrome', os: 'macOS', hz: 60, version: '0.2.0', ...over });

test('ranks runs within their class, exactly near the top', async () => {
  const s = make();
  assert.deepEqual(await s.submit(run({ score: 2_000_000 })), { id: (await s.runs('desktop'))[0].id, rank: 1, total: 1, approximate: false, deviceBest: 2_000_000, deviceRuns: 1 });
  const second = await s.submit(run({ score: 900_000, deviceName: 'NVIDIA GeForce RTX 3060' }));
  assert.equal(second.rank, 2);
  assert.equal(second.total, 2);
  const phone = await s.submit(run({ score: 40_000, deviceClass: 'phone', deviceName: 'iPhone 393×852' }));
  assert.deepEqual([phone.rank, phone.total], [1, 1]);
  const again = await s.submit(run({ score: 2_500_000 }));
  assert.deepEqual([again.rank, again.total, again.deviceBest, again.deviceRuns], [1, 3, 2_500_000, 2]);
  assert.deepEqual(
    (await s.devices('desktop')).map((d) => [d.deviceName, d.best, d.runs]),
    [
      ['Apple M3 Max', 2_500_000, 2],
      ['NVIDIA GeForce RTX 3060', 900_000, 1],
    ],
  );
});

test('past the top 50 the rank comes from the histogram, within a bin', async () => {
  const s = make({ rateLimit: null });
  for (let i = 0; i < 200; i++) await s.submit(run({ score: 10_000 + i * 1000, deviceName: `GPU ${i}` }));
  // 200 runs from 10,000 to 209,000; 60,500 has 149 runs above it.
  const r = await s.submit(run({ score: 60_500, deviceName: 'Mid GPU' }));
  assert.equal(r.approximate, true);
  assert.equal(r.total, 201);
  assert.ok(Math.abs(r.rank - 150) <= 4, `rank ${r.rank}`);
});

test('refuses runs that are not runs', async () => {
  const s = make();
  for (const bad of [
    null,
    run({ score: 0 }),
    run({ score: 1.5 }),
    run({ score: 8_000_001 }),
    run({ score: '5000' }),
    run({ deviceClass: 'console' }),
    run({ seconds: 1 }),
    run({ seconds: 'soon' }),
    run({ deviceName: '<<<>>>' }),
  ]) {
    await assert.rejects(s.submit(bad), (err) => err.status === 400, JSON.stringify(bad));
  }
});

test('device names keep what real ones use and lose the rest', () => {
  assert.equal(cleanDeviceName('  ANGLE  Apple M3 Max  '), 'ANGLE Apple M3 Max');
  assert.equal(cleanDeviceName('iPhone 393×852'), 'iPhone 393×852');
  assert.equal(cleanDeviceName('Adreno (TM) 740'), 'Adreno (TM) 740');
  assert.equal(cleanDeviceName('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(cleanDeviceName('x'.repeat(100)).length, 60);
});

test('rate-limits a flood from one address', async () => {
  const s = make({ rateLimit: { max: 3, windowMs: 60_000 } });
  for (let i = 0; i < 3; i++) await s.submit(run(), { ip: '9.9.9.9' });
  await assert.rejects(s.submit(run(), { ip: '9.9.9.9' }), (err) => err.status === 429);
  await s.submit(run(), { ip: '8.8.8.8' });
});

test('hidden devices stay off the lists', async () => {
  const s = make({ hidden: ['Rude Name 3000'] });
  await s.submit(run({ deviceName: 'Rude Name 3000', score: 7_000_000 }));
  await s.submit(run({ deviceName: 'Apple M2', score: 1_000_000 }));
  assert.deepEqual((await s.devices('desktop')).map((d) => d.deviceName), ['Apple M2']);
  assert.deepEqual((await s.runs('desktop')).map((r) => r.deviceName), ['Apple M2']);
});

test('score bins are monotonic and about 2.3% wide', () => {
  assert.equal(scoreBin(0), 0);
  assert.ok(scoreBin(1000) < scoreBin(1024));
  assert.equal(scoreBin(1000), scoreBin(1020));
  assert.ok(scoreBin(8_000_000) < 800);
});

test('HTTP: post a run, read the lists, CORS and errors', async () => {
  const handle = createHandler(make(), { origins: ['https://lagderboard.glitchless.gg'], prefix: '/api' });
  const post = (body, origin = 'https://lagderboard.glitchless.gg') =>
    handle(new Request('https://x/api/runs', { method: 'POST', headers: { 'content-type': 'text/plain', origin }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { ip: '1.1.1.1' });
  const ok = await post(run({ score: 31_400, deviceClass: 'phone', deviceName: 'iPhone 393×852' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://lagderboard.glitchless.gg');
  assert.equal((await ok.json()).rank, 1);

  const list = await handle(new Request('https://x/api/devices?class=phone'));
  assert.equal(list.status, 200);
  assert.match(list.headers.get('cache-control'), /max-age=30/);
  assert.deepEqual((await list.json()).rows, [{ deviceName: 'iPhone 393×852', best: 31_400, runs: 1 }]);

  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(run({ score: -1 }))).status, 400);
  assert.equal((await post('x'.repeat(5000))).status, 413);
  assert.equal((await handle(new Request('https://x/api/devices?class=fridge'))).status, 400);
  assert.equal((await handle(new Request('https://x/api/nope'))).status, 404);
  assert.equal((await post(run(), 'https://evil.example')).headers.get('access-control-allow-origin'), null);
  const pre = await handle(new Request('https://x/api/runs', { method: 'OPTIONS', headers: { origin: 'https://lagderboard.glitchless.gg' } }));
  assert.equal(pre.status, 204);
});

test('Node adapter: serve.js answers over a real socket', async () => {
  const http = await import('node:http');
  const { nodeHandler } = await import('../node.js');
  const server = http.createServer(nodeHandler(createHandler(make())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const posted = await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(run({ score: 777 })) });
    assert.equal(posted.status, 200);
    assert.equal((await posted.json()).rank, 1);
    assert.deepEqual((await (await fetch(`${base}/runs?class=desktop`)).json()).rows.map((r) => r.score), [777]);
  } finally {
    server.close();
  }
});
