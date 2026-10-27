// The player's off switch (SPEC §4d): setEnabled(false) stops measuring and sending at once, drops what was waiting and
// ends the session without a session_end; setEnabled(true) starts a new session. The choice is saved in localStorage,
// so it holds from the start of the next visit, and optIn starts a device off until the game says yes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5179', pathname: '/' };

const { Glitchless } = await import('../src/core.js');

// Made without `window`: no frame loop or timers, so the test calls tick() and flush() itself.
function sdk(options = {}) {
  const gd = new Glitchless({ service: 'off', version: '1.0.0', intake: 'http://intake.test', ...options });
  gd.startedAt -= 5000; // past the 3 s a session without a renderer waits before its first batch
  return gd;
}

// Answers each request with the next status in `statuses` (then 202); 0 is a network error. `hold` keeps answers
// back until release() is called, for a request still on its way.
function intake(statuses = [], { hold = false } = {}) {
  const bodies = [];
  const waiting = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)));
    if (hold) await new Promise((r) => waiting.push(r));
    const status = statuses.length ? statuses.shift() : 202;
    if (status === 0) throw new TypeError('Failed to fetch');
    return new Response('{}', { status });
  };
  bodies.release = () => waiting.splice(0).forEach((r) => r());
  return bodies;
}

// Turns it back on, past the 3 s the new session waits before its first batch.
const on = (gd) => {
  gd.setEnabled(true);
  gd.startedAt -= 5000;
};

const settle = () => new Promise((r) => setTimeout(r, 20));
const types = (b) => b.events.map((e) => e.type);
const frames = (gd, n = 30) => {
  let t = 1000;
  for (let i = 0; i < n; i++) gd.tick((t += 16.7));
};

beforeEach(() => storage.clear());

test('off: nothing more is sent, not even a session_end, and what was waiting is dropped', async () => {
  const sent = intake();
  const gd = sdk();
  gd.levelStart('wave-1');
  gd.flush();
  await settle();
  assert.deepEqual(types(sent[0]), ['session_start', 'level_start']);

  gd.track('pickup');
  gd.count('kill', { monster: 'elite' });
  frames(gd);
  gd.setEnabled(false);
  assert.equal(storage.get('glitchless.enabled'), 'off', 'saved first');
  assert.equal(gd.queue.length, 0);
  assert.equal(gd.win.frames, 0);
  assert.equal(gd.counter.size, 0);
  assert.equal(gd.isEnabled(), false);

  gd.track('after');
  gd.levelFail('wave-1', { cause: 'fell' });
  gd.error(new Error('boom'));
  gd.death({ cause: 'fell' });
  frames(gd);
  gd.closeWindow();
  gd.flush();
  gd.end('pagehide');
  await settle();
  assert.equal(sent.length, 1, 'no request after the player turned it off');
  assert.equal(gd.queue.length, 0, 'and nothing kept for later');
  assert.equal(gd.stats.lastStatus, 'off');
});

test('off drops batches waiting to be sent again, and ignores the answer to one already on its way', async () => {
  const sent = intake([0, 0], { hold: true });
  const gd = sdk();
  gd.track('a');
  gd.flush();
  await settle();
  sent.release();
  await settle();
  assert.equal(gd.retries.length, 1, 'the first try failed: it waits to go again');

  gd.track('b');
  gd.flush(); // the retry and the new batch go out, and their answers are held back
  await settle();
  assert.equal(sent.length, 3);
  gd.setEnabled(false);
  assert.equal(gd.retries.length, 0);
  sent.release(); // both fail: neither comes back as a batch to send again
  await settle();
  assert.equal(gd.retries.length, 0);
  on(gd);
  gd.flush();
  await settle();
  assert.equal(sent.length, 4);
  assert.deepEqual(types(sent[3]), ['session_start'], 'the new session sends only its own events');
});

test('off while a batch is being compressed: it never goes out', async () => {
  const sent = intake();
  const gd = sdk();
  gd.track('a');
  gd.flush(); // compressing now; the request would go once that's done
  gd.setEnabled(false);
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(gd.retries.length, 0);
});

test('on again: a new session with the properties and groups still set, and no load event again', async () => {
  const sent = intake();
  const gd = sdk({ properties: { mode: 'squads' } });
  gd.firstFrameAt = 900;
  gd.firstFrameWall = Date.now();
  const party = gd.setGroup('party', 'party_123456', { size: 3 });
  gd.flush();
  await settle();
  const first = sent[0];
  assert.deepEqual(types(first), ['session_start', 'group', 'load']);

  gd.setEnabled(false);
  gd.setProperties({ rank: 'gold' }); // said while off: kept for the next session, not sent
  gd.setZone('docks');
  on(gd);
  assert.equal(storage.get('glitchless.enabled'), 'on');
  assert.equal(gd.isEnabled(), true);
  assert.notEqual(gd.sessionId, first.session_id);
  gd.track('back');
  gd.flush();
  await settle();
  const next = sent[1];
  assert.equal(next.session_id, gd.sessionId);
  assert.deepEqual(types(next), ['session_start', 'group', 'custom'], 'no load: the page was not measured from its start');
  assert.deepEqual(next.events[0].props, { mode: 'squads', rank: 'gold' });
  assert.deepEqual(next.events[1], { ...next.events[1], kind: 'party', id: party, attrs: { size: 3 } });
  assert.equal(next.events[2].zone, 'docks');
});

test('the attempt going when the player turned it off has no outcome in the new session, until the next start', async () => {
  const sent = intake();
  const gd = sdk();
  gd.levelStart('wave-2');
  gd.setEnabled(false);
  on(gd);
  gd.levelComplete('wave-2', { score: 10 });
  gd.levelFail('wave-2', { cause: 'fell' });
  gd.levelAbandon();
  gd.levelStart('wave-2');
  gd.levelComplete('wave-2', { score: 20 });
  gd.flush();
  await settle();
  const events = sent.flatMap((b) => b.events);
  assert.deepEqual(events.map((e) => e.type), ['session_start', 'level_start', 'level_complete']);
  assert.equal(events.at(-1).score, 20);
  assert.equal(events.at(-1).level, 'wave-2');
});

test('a call that changes nothing does nothing', async () => {
  const sent = intake();
  const gd = sdk();
  const id = gd.sessionId;
  gd.setEnabled(true);
  assert.equal(gd.sessionId, id, 'on while on: the same session');
  assert.equal(storage.get('glitchless.enabled'), 'on', 'but the choice is saved');
  gd.track('x');
  gd.setEnabled(false);
  gd.setEnabled(false);
  gd.setEnabled(true);
  const again = gd.sessionId;
  gd.setEnabled(true);
  assert.equal(gd.sessionId, again);
  gd.startedAt -= 5000;
  gd.flush();
  await settle();
  assert.equal(sent.length, 1);
});

test('the saved choice holds from the start of the next visit: off sends nothing, not even a health check', async () => {
  const sent = intake();
  sdk().setEnabled(false);
  const urls = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (urls.push(String(url)), fetch(url, init));
  const gd = sdk();
  assert.equal(gd.isEnabled(), false);
  gd.checkFeatures();
  gd.track('a');
  frames(gd);
  gd.closeWindow();
  gd.flush();
  assert.deepEqual(await gd.reportBug({ note: 'stuck', screenshot: false }), { sent: false, reason: 'off' });
  assert.match(await gd.measure(1), /turned off/);
  await settle();
  assert.deepEqual(urls, []);
  assert.equal(sent.length, 0);
});

test('optIn starts a device off until the game turns it on; a saved choice wins over it', async () => {
  const sent = intake();
  const gd = sdk({ optIn: true });
  assert.equal(gd.isEnabled(), false);
  gd.track('a');
  gd.flush();
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(storage.has('glitchless.enabled'), false, 'nothing saved until the game calls setEnabled');

  on(gd); // the player said yes
  gd.track('b');
  gd.flush();
  await settle();
  assert.deepEqual(types(sent[0]), ['session_start', 'custom']);
  assert.equal(sdk({ optIn: true }).isEnabled(), true, 'the next visit remembers the yes');
  storage.set('glitchless.enabled', 'off');
  assert.equal(sdk().isEnabled(), false, 'and a saved no wins over the default');
});

test('without localStorage the choice lasts the page load', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  try {
    const gd = sdk();
    gd.setEnabled(false);
    assert.equal(gd.isEnabled(), false);
    assert.equal(sdk().isEnabled(), true);
  } finally {
    globalThis.localStorage = saved;
  }
});

test('isEnabled is false without an intake, whatever the player chose', () => {
  const gd = new Glitchless({ service: 'off', version: '1.0.0' });
  gd.setEnabled(true);
  assert.equal(gd.isEnabled(), false);
});
