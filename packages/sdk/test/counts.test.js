// Counters for frequent events (SPEC §1 count, §2 counts; design A5): one entry per name and group a window, numbers
// added up on the device, at most 64 entries, the `counts` event, and the /v1/health check that keeps counters from a
// server that would drop them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5181', pathname: '/' };

const { Counter, MAX_ENTRIES } = await import('../src/counts.js');
const { Glitchless } = await import('../src/core.js');

function sdk(opts = {}) {
  const gd = new Glitchless({ service: 'counts', version: '1.0.0', intake: null, ...opts });
  gd.startedAt -= 5000;
  return gd;
}

test('a counter keeps one entry per name and group: strings and booleans group, numbers add up, n adds to the count', () => {
  const c = new Counter();
  c.add('kill', { monster: 'elite' }, 1, 1000);
  c.add('kill', { monster: 'elite' }, 2, 1200);
  c.add('kill', { monster: 'grunt' }, 1, 1300);
  c.add('gold', { source: 'loot', amount: 35 }, 1, 1100);
  c.add('gold', { amount: 15, source: 'loot' }, 3, 1400); // the order of attributes doesn't make a new group
  c.add('hit', { weapon: 'ar', crit: true, damage: 23 });
  const { counts, dropped } = c.drain();
  assert.equal(dropped, 0);
  assert.deepEqual(counts.map((e) => [e.name, e.attrs, e.n, e.sums ?? null]), [
    ['kill', { monster: 'elite' }, 3, null],
    ['kill', { monster: 'grunt' }, 1, null],
    ['gold', { source: 'loot' }, 4, { amount: 50 }],
    ['hit', { weapon: 'ar', crit: true }, 1, { damage: 23 }],
  ]);
  assert.equal(counts[0].first_ts, 1000, 'the first call in the window');
  assert.equal(c.drain(), null, 'drained: nothing until the next call');
});

test('a group has at most 4 attributes and 4 sums; n is a whole number from 1 to a million', () => {
  const c = new Counter();
  c.add('x', { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', n1: 1, n2: 2, n3: 3, n4: 4, n5: 5, list: ['no'], obj: { no: 1 } });
  assert.equal(c.add('x', {}, 0), false);
  assert.equal(c.add('x', {}, -3), false);
  assert.equal(c.add('', {}), false);
  c.add('big', {}, 5e9);
  const [x, big] = c.drain().counts;
  assert.deepEqual(x.attrs, { a: 'a', b: 'b', c: 'c', d: 'd' });
  assert.deepEqual(x.sums, { n1: 1, n2: 2, n3: 3, n4: 4 });
  assert.equal(big.n, 1_000_000);
});

test('past 64 entries a new group of a counted name goes under "(other)", and a new name is dropped into `dropped`', () => {
  const c = new Counter();
  for (let i = 0; i < MAX_ENTRIES; i++) c.add('card', { card: `card_${i}` });
  c.add('card', { card: 'card_64' });
  c.add('card', { card: 'card_65' }, 2);
  c.add('card', { card: 'card_0' }); // an entry it already has still counts as itself
  c.add('pull', { banner: 'summer' }, 7);
  const { counts, dropped } = c.drain();
  assert.equal(counts.length, MAX_ENTRIES + 1);
  assert.deepEqual(counts.at(-1), { name: 'card', attrs: { card: '(other)' }, n: 3, first_ts: counts.at(-1).first_ts });
  assert.equal(counts[0].n, 2);
  assert.equal(dropped, 7, 'the counts it could not keep');
});

test('count() queues nothing: each window that counted anything sends one counts event, with its level and zone', () => {
  const gd = sdk();
  gd.levelStart('nmd_ghoa');
  gd.setZone('crypt');
  for (let i = 0; i < 300; i++) gd.count('kill', { monster: i % 3 ? 'grunt' : 'elite' });
  gd.count('gold', { source: 'loot', amount: 35 });
  assert.equal(gd.queue.filter((e) => e.type === 'counts').length, 0);
  assert.equal(gd.queue.length, 1, 'only the level start');
  gd.closeWindow();
  const counts = gd.queue.filter((e) => e.type === 'counts');
  assert.equal(counts.length, 1);
  const [e] = counts;
  assert.deepEqual(Object.keys(e).sort(), ['counts', 'dropped', 'duration_s', 'level', 'ts', 'type', 'zone']);
  assert.equal(e.level, 'nmd_ghoa');
  assert.equal(e.zone, 'crypt');
  assert.equal(e.dropped, 0);
  assert.deepEqual(e.counts.map((c) => [c.name, c.attrs, c.n, c.sums]), [
    ['kill', { monster: 'elite' }, 100, undefined],
    ['kill', { monster: 'grunt' }, 200, undefined],
    ['gold', { source: 'loot' }, 1, { amount: 35 }],
  ]);
  gd.closeWindow();
  assert.equal(gd.queue.filter((e) => e.type === 'counts').length, 1, 'a window with nothing counted sends none');
});

test('a level start closes the window, so counts keep their level', () => {
  const gd = sdk();
  gd.levelStart('wave-1');
  gd.count('shot', {}, 40);
  gd.levelStart('wave-2');
  gd.count('shot', {}, 10);
  gd.closeWindow();
  assert.deepEqual(gd.queue.filter((e) => e.type === 'counts').map((e) => [e.level, e.counts[0].n]), [['wave-1', 40], ['wave-2', 10]]);
});

// Answers /v1/health with `health` and every batch with 202.
function intake(health) {
  const batches = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/health')) return new Response(JSON.stringify(health), { status: 200 });
    batches.push(JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(await new Response(new Blob([init.body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())));
    return new Response('{}', { status: 202 });
  };
  return batches;
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const sent = (batches, type) => batches.flatMap((b) => b.events).filter((e) => e.type === type);

test('counters wait until /v1/health says the server reads them, then go', async () => {
  const batches = intake({ ok: true, features: ['counts', 'server_mode'] });
  const gd = sdk({ intake: 'http://intake.test' });
  gd.count('tap', {}, 5);
  gd.closeWindow();
  gd.flush();
  await settle();
  assert.equal(sent(batches, 'counts').length, 0, 'held while the server has not answered');
  assert.equal(sent(batches, 'session_start').length, 1, 'everything else went');
  await gd.featuresCheck;
  gd.count('tap', {}, 2);
  gd.closeWindow();
  gd.flush();
  await settle();
  assert.deepEqual(sent(batches, 'counts').map((e) => e.counts[0].n), [5, 2], 'the held window first');
});

test('a server without counters gets none, and the game hears it once', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (const health of [{ ok: true }, { ok: true, features: { counts: false } }]) {
      const batches = intake(health);
      const gd = sdk({ intake: 'http://intake.test' });
      gd.checkFeatures();
      await gd.featuresCheck;
      for (let i = 0; i < 3; i++) {
        gd.count('tap');
        gd.track('opened');
        gd.closeWindow();
        gd.flush();
      }
      await settle();
      assert.equal(sent(batches, 'counts').length, 0);
      assert.equal(sent(batches, 'custom').length, 3);
    }
    assert.equal(warnings.filter((w) => w.includes('count()')).length, 2, 'once per session');
  } finally {
    console.warn = warn;
  }
});

test('a name tracked more than 20 times a second gets one warning that names count(), outside prod', () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const gd = sdk();
    for (let i = 0; i < 60; i++) gd.track('shot', { weapon: 'ar' });
    const prod = sdk({ env: 'prod' });
    for (let i = 0; i < 60; i++) prod.track('shot');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /track\('shot'\).*glitchless\.count\('shot'/);
});
