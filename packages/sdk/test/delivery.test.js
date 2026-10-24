// What the Starlift audit (Godot) found, checked in the browser SDK too (SPEC §2):
// - a batch sent again after its answer was lost is stored twice unless it carries the same batch_id: a failed
//   batch goes again whole, under its own ID, before newer events;
// - leaving a level is an abandon, sent by the SDK when the page goes mid-level, never a fail;
// - the load event is stamped when the first frame was drawn, not when the first batch went;
// - a long frame that didn't block the main thread (no long animation frame) took its time outside the page's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5179', pathname: '/' };

const { Glitchless } = await import('../src/core.js');

// Made without `window`: no frame loop or timers, so the test calls tick(), flush() and end() itself.
function sdk() {
  const gd = new Glitchless({ service: 'delivery', version: '1.0.0', intake: 'http://intake.test' });
  gd.startedAt -= 5000; // past the 3 s a session without a renderer waits before its first batch
  return gd;
}

// Answers each request with the next status in `statuses` (then 202); a status of 0 is a network error.
function intake(statuses = []) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)));
    const status = statuses.length ? statuses.shift() : 202;
    if (status === 0) throw new TypeError('Failed to fetch');
    return new Response('{}', { status });
  };
  return bodies;
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const types = (b) => b.events.map((e) => e.type);

test('every batch names itself; one that failed goes again whole, under the same batch_id, before newer events', async () => {
  const sent = intake([0]);
  const gd = sdk();
  gd.track('open', { what: 'free' });
  gd.flush();
  await settle();
  assert.equal(sent.length, 1);
  const first = sent[0];
  assert.match(first.batch_id, /^b_[a-z0-9]{16}$/);
  assert.deepEqual(types(first), ['session_start', 'custom']);
  assert.equal(gd.queue.length, 0, 'the failed events wait as their batch, not in the queue');

  gd.track('play', { what: 'endless' });
  gd.flush();
  await settle();
  assert.equal(sent.length, 3);
  assert.equal(sent[1].batch_id, first.batch_id, 'the same batch again');
  assert.deepEqual(sent[1].events, first.events);
  assert.notEqual(sent[2].batch_id, first.batch_id);
  assert.deepEqual(types(sent[2]), ['custom']);
  assert.equal(gd.retries.length, 0, 'a 2xx clears it');
});

test('a batch the server turned away is not sent again; one it was too busy for is', async () => {
  const sent = intake([400, 429]);
  const gd = sdk();
  gd.track('a');
  gd.flush();
  await settle();
  gd.track('b');
  gd.flush();
  await settle();
  assert.deepEqual(sent.map((b) => b.events.at(-1).name), ['a', 'b']);
  assert.equal(gd.retries.length, 1);
  gd.flush();
  await settle();
  assert.deepEqual(sent.map((b) => b.events.at(-1).name), ['a', 'b', 'b']);
  assert.equal(sent[2].batch_id, sent[1].batch_id);
});

test('closing the page mid-level sends an abandon before the end, and drops the game\'s own fail after it', async () => {
  const sent = intake();
  const gd = sdk();
  gd.levelStart('wave-3');
  gd.end('pagehide');
  gd.levelFail('wave-3', { cause: 'left' }); // a game's own pagehide handler, after the SDK's
  gd.levelAbandon('wave-3');
  await settle();
  const events = sent.flatMap((b) => b.events);
  const tail = events.filter((e) => ['level_abandon', 'level_fail', 'session_end'].includes(e.type));
  assert.deepEqual(tail.map((e) => [e.type, e.level ?? null, e.reason ?? e.cause ?? null]), [
    ['level_abandon', 'wave-3', 'pagehide'],
    ['session_end', 'wave-3', 'pagehide'],
  ]);
  assert.equal(typeof tail[0].duration_s, 'number');
});

test('levelAbandon is the game saying the player left; a completed level, or a menu, has nothing to abandon', async () => {
  const sent = intake();
  const gd = sdk();
  gd.levelStart('wave-1');
  gd.levelAbandon();
  gd.levelStart('wave-2');
  gd.levelComplete('wave-2');
  gd.levelStart('wave-3');
  gd.level = null; // what an engine adapter does back in a menu
  gd.end('pagehide');
  await settle();
  const abandons = sent.flatMap((b) => b.events).filter((e) => e.type === 'level_abandon');
  assert.deepEqual(abandons.map((e) => [e.level, 'reason' in e]), [['wave-1', false]], 'only the game\'s own abandon');
});

test('the load event is stamped when the first frame was drawn', async () => {
  const sent = intake();
  const gd = sdk();
  const before = Date.now();
  gd.tick(1000);
  gd.tick(1016.7);
  const drawn = gd.firstFrameWall;
  assert.ok(drawn >= before);
  await new Promise((r) => setTimeout(r, 50));
  gd.flush();
  await settle();
  const load = sent.flatMap((b) => b.events).find((e) => e.type === 'load');
  assert.equal(load.ts, drawn, 'not the flush, 50 ms later');
});

test('a long frame without a long animation frame went outside the page\'s code, where the browser reports them', () => {
  intake();
  for (const supported of [true, false]) {
    const gd = sdk();
    gd.loafSupported = supported;
    let t = 1000;
    for (let i = 0; i < 120; i++) gd.tick((t += 16.7));
    gd.tick((t += 120));
    gd.resolveHitches();
    const hitch = gd.queue.find((e) => e.type === 'hitch');
    assert.deepEqual(hitch.causes, supported ? ['gpu_or_os'] : [], `LoAF supported: ${supported}`);
  }
});
