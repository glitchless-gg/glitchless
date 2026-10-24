// What every leaderboard store must do (the interface is at the top of ../leaderboard.js). store.test.js runs it on
// the memory and file stores; another store passes the same checks by calling storeContract with its own factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const run = (over) => ({ id: `r${Math.random().toString(36).slice(2)}`, score: 1000, deviceClass: 'desktop', deviceName: 'Apple M3 Max', seconds: 20, at: '2026-10-24T00:00:00.000Z', ...over });

// makeStore(nowMs) → a fresh, empty store whose clock reads nowMs
export function storeContract(name, makeStore) {
  const NOW = Date.UTC(2026, 9, 24);
  const future = Math.ceil(NOW / 1000) + 86400;

  test(`${name}: top runs come highest first, per class, and expired runs drop out`, async () => {
    const s = await makeStore(NOW);
    await s.addRun(run({ id: 'a', score: 500 }), { expiresAt: future });
    await s.addRun(run({ id: 'b', score: 9000 }), { expiresAt: future });
    await s.addRun(run({ id: 'c', score: 3000, deviceClass: 'phone' }), { expiresAt: future });
    await s.addRun(run({ id: 'd', score: 7000 }), { expiresAt: Math.floor(NOW / 1000) - 1 });
    const top = await s.topRuns('desktop', 10);
    assert.deepEqual(top.map((r) => r.id), ['b', 'a']);
    assert.equal(top[0].deviceName, 'Apple M3 Max');
    assert.equal(top[0].expiresAt, undefined);
    assert.deepEqual((await s.topRuns('phone', 10)).map((r) => r.id), ['c']);
    assert.deepEqual((await s.topRuns('desktop', 1)).map((r) => r.id), ['b']);
  });

  test(`${name}: a device's best only rises, its runs count up, devices sort by best`, async () => {
    const s = await makeStore(NOW);
    assert.deepEqual(await s.recordDevice('desktop', 'apple m3 max', 'Apple M3 Max', 2000), { best: 2000, runs: 1 });
    assert.deepEqual(await s.recordDevice('desktop', 'apple m3 max', 'Apple M3 Max', 1500), { best: 2000, runs: 2 });
    assert.deepEqual(await s.recordDevice('desktop', 'apple m3 max', 'Apple M3 Max', 2500), { best: 2500, runs: 3 });
    await s.recordDevice('desktop', 'nvidia geforce rtx 4090', 'NVIDIA GeForce RTX 4090', 9000);
    await s.recordDevice('phone', 'iphone 393×852', 'iPhone 393×852', 40000);
    const top = await s.topDevices('desktop', 10);
    assert.deepEqual(
      top.map((d) => [d.deviceName, d.best, d.runs]),
      [
        ['NVIDIA GeForce RTX 4090', 9000, 1],
        ['Apple M3 Max', 2500, 3],
      ],
    );
    assert.equal((await s.topDevices('desktop', 1)).length, 1);
    assert.deepEqual((await s.topDevices('phone', 10)).map((d) => d.deviceName), ['iPhone 393×852']);
  });

  test(`${name}: the histogram counts runs per bin and class`, async () => {
    const s = await makeStore(NOW);
    await s.countScore('desktop', 301);
    await s.countScore('desktop', 301);
    await s.countScore('desktop', 450);
    await s.countScore('phone', 301);
    const h = new Map(await s.histogram('desktop'));
    assert.equal(h.get(301), 2);
    assert.equal(h.get(450), 1);
    assert.equal(h.size, 2);
    assert.deepEqual(await s.histogram('tablet'), []);
  });

  test(`${name}: hits count per key and window`, async () => {
    const s = await makeStore(NOW);
    assert.equal(await s.hit('ip:1.2.3.4', 7, future), 1);
    assert.equal(await s.hit('ip:1.2.3.4', 7, future), 2);
    assert.equal(await s.hit('ip:1.2.3.4', 8, future), 1);
    assert.equal(await s.hit('ip:5.6.7.8', 7, future), 1);
  });
}
