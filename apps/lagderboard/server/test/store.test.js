import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../memory-store.js';
import { storeContract } from './store-contract.js';

storeContract('memory store', (now) => new MemoryStore({ now: () => now }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagderboard-'));
let n = 0;
storeContract('file store', (now) => new MemoryStore({ file: path.join(dir, `board-${n++}.json`), now: () => now }));

test('file store: the board survives a restart', async () => {
  const file = path.join(dir, 'restart.json');
  const now = () => Date.UTC(2026, 9, 24);
  const a = new MemoryStore({ file, now });
  await a.addRun({ id: 'x', score: 4242, deviceClass: 'phone', deviceName: 'Pixel 8' }, { expiresAt: 4e9 });
  await a.recordDevice('phone', 'pixel 8', 'Pixel 8', 4242);
  await a.countScore('phone', 363);
  a.flush();
  const b = new MemoryStore({ file, now });
  assert.deepEqual((await b.topRuns('phone', 5)).map((r) => r.score), [4242]);
  assert.deepEqual(await b.topDevices('phone', 5), [{ deviceName: 'Pixel 8', best: 4242, runs: 1 }]);
  assert.deepEqual(await b.histogram('phone'), [[363, 1]]);
});
