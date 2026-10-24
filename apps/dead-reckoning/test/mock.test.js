// The dev mock: seeded, labelled fake, and shaped like a positions panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../src/levels.js';
import { createMockMarkers } from '../src/markers/mock.js';

async function finished(src, level) {
  for (let i = 0; i < 2000; i++) {
    const e = src.get(level);
    if (e && !e.loading) return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('mock never finished');
}

test('the mock is fake, seeded and binned like a positions panel', async () => {
  const a = createMockMarkers({ levels: LEVELS, seed: 1 });
  const b = createMockMarkers({ levels: LEVELS, seed: 1 });
  a.start();
  b.start();
  assert.equal(a.fake, true);
  const ea = await finished(a, '3');
  const eb = await finished(b, '3');
  assert.equal(ea.fake, true);
  assert.equal(ea.bin, 0.5);
  assert.ok(ea.total > 2500 && ea.total < 3700, `total ${ea.total}`);
  assert.deepEqual(ea.deaths, eb.deaths, 'same seed, same markers');
  for (const [x, y, n] of ea.deaths) {
    assert.ok(x >= 0 && x <= LEVELS[2].w && y >= -1.5 && y <= LEVELS[2].h && n >= 1);
  }
  a.stop();
  b.stop();
});
