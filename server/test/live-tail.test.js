// The live tail's limits (SPEC §6 openLive): a host may hold how many streams are open and refuse one past its limit, and
// the dashboard's live streams (apps/dashboard/src/live-stream.js) share one stream per game across a page's live
// panels, tell a busy server from a person's own other tabs and from a signed-out session, and try again by themselves
// where that helps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { defaultAuth } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { createLiveStreams, RETRY_MS, MAX_RETRY_MS, REOPEN_MS } from '../../apps/dashboard/src/live-stream.js';

async function serve(auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-live-'));
  const server = http.createServer(createApp({ store: new FileStore(dir), auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => (server.closeAllConnections(), new Promise((r) => server.close(r)), fs.rmSync(dir, { recursive: true, force: true })),
  };
}

test('openLive: a host refuses a stream past its limit with 429 busy and Retry-After, and is told when one ends', async (t) => {
  const held = [];
  let allowed = 1;
  const auth = {
    ...defaultAuth(),
    openLive(req, reader) {
      if (held.length >= allowed) return { refused: { status: 429, error: 'live is busy', retryAfter: 7, reason: 'yours' } };
      const h = { reader, released: false, release: () => (h.released = true) };
      held.push(h);
      return h;
    },
  };
  const app = await serve(auth);
  t.after(app.close);
  const stop = new AbortController();
  const first = await fetch(`${app.base}/v1/live?service=zoomies`, { signal: stop.signal });
  assert.equal(first.status, 200);
  assert.equal(held[0].reader.projectId, 'default', 'asked once the reader is known');
  const second = await fetch(`${app.base}/v1/live?service=zoomies`);
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '7');
  assert.deepEqual(await second.json(), { error: 'live is busy', busy: true, reason: 'yours' });
  stop.abort();
  for (let i = 0; i < 50 && !held[0].released; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(held[0].released, true, 'released when the stream ends');

  // With maxMs the stream ends itself, and is released.
  allowed = 2;
  const cutAuth = { ...defaultAuth(), openLive: () => { const h = { released: false, maxMs: 50, release: () => (h.released = true) }; held.push(h); return h; } };
  const cutApp = await serve(cutAuth);
  t.after(cutApp.close);
  const cutRes = await fetch(`${cutApp.base}/v1/live?service=zoomies`);
  assert.equal(cutRes.status, 200);
  assert.match(await cutRes.text(), /glitchless live tail/, 'the stream ended by itself');
  assert.equal(held.at(-1).released, true);

  // Without the hook, as before: no limit.
  const open = await serve(defaultAuth());
  t.after(open.close);
  const streams = await Promise.all([1, 2, 3].map(() => fetch(`${open.base}/v1/live?service=zoomies`, { signal: AbortSignal.timeout(2000) })));
  assert.deepEqual(streams.map((r) => r.status), [200, 200, 200]);
  for (const r of streams) r.body.cancel().catch(() => {});
});

// Stand-in answers for the dashboard's streams: each request waits for the test to answer it with a Response.
function fakeRequests() {
  const made = [];
  const request = (url, signal) =>
    new Promise((resolve, reject) => {
      const r = { url, signal, aborted: false };
      signal.addEventListener('abort', () => {
        r.aborted = true;
        r.close?.();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      // A 200 whose body the test writes to (r.push) and ends (r.end).
      r.stream = () => {
        const body = new ReadableStream({
          start(c) {
            r.push = (text) => c.enqueue(new TextEncoder().encode(text));
            r.end = () => c.close();
            r.close = () => c.error(new Error('aborted'));
          },
        });
        resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      };
      r.refuse = (status, body = {}, retryAfter) => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) } }));
      r.fail = () => reject(new TypeError('fetch failed'));
      made.push(r);
    });
  const timers = [];
  return { made, request, timers, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: (id) => (timers[id - 1].fn = null), fire: () => timers.splice(0).forEach((x) => x.fn?.()) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('dashboard live streams: one stream per game for every panel on the page, read as server-sent events', async () => {
  const f = fakeRequests();
  const live = createLiveStreams(f);
  const got = { a: [], b: [] };
  const states = [];
  const stopA = live.subscribe('/v1/live?service=g', { onEvents: (e) => got.a.push(...e), onState: (s) => states.push(s) });
  const stopB = live.subscribe('/v1/live?service=g', { onEvents: (e) => got.b.push(...e) });
  const other = live.subscribe('/v1/live?service=h', {});
  assert.equal(f.made.length, 2, 'one stream for g, one for h');
  f.made[0].stream();
  await tick();
  assert.deepEqual(states, ['connecting', 'live']);
  f.made[0].push(': glitchless live tail\n\n: ping\n\ndata: [{"type":"death"}]\n\ndata: [{"type":');
  f.made[0].push('"error"}]\n\n');
  await tick();
  assert.deepEqual([got.a.map((e) => e.type), got.b.map((e) => e.type)], [['death', 'error'], ['death', 'error']]);
  stopA();
  assert.equal(f.made[0].aborted, false, 'b still watches');
  stopB();
  assert.equal(f.made[0].aborted, true);
  other();
  assert.equal(live.open(), 0);
});

test('dashboard live streams: a stream the host ends is opened again at once, still live; one that ends at once backs off', async () => {
  const f = fakeRequests();
  let t = 0;
  const live = createLiveStreams({ ...f, now: () => t });
  const states = [];
  live.subscribe('/v1/live?service=g', { onState: (s) => states.push(s) });
  f.made[0].stream();
  await tick();
  t += 25_000;
  f.made[0].end(); // the host's 25-second cut
  await tick();
  assert.equal(f.timers[0].ms, REOPEN_MS);
  f.fire();
  assert.equal(f.made.length, 2);
  f.made[1].stream();
  await tick();
  assert.deepEqual(states, ['connecting', 'live']);
  // A server that answers and closes at once is asked again more and more slowly, not twice a second.
  f.made[1].end();
  await tick();
  assert.equal(f.timers[0].ms, RETRY_MS);
  f.fire();
  f.made[2].stream();
  await tick();
  f.made[2].end();
  await tick();
  assert.equal(f.timers[0].ms, RETRY_MS * 2);
});

test('dashboard live streams: busy, it says so and tries again by itself, waiting Retry-After at least and backing off, then live', async () => {
  const f = fakeRequests();
  let t = 0;
  const live = createLiveStreams({ ...f, now: () => t });
  const states = [];
  live.subscribe('/v1/live?service=g', { onState: (s) => states.push(s) });
  f.made[0].refuse(429, { error: 'live is busy right now', busy: true, reason: 'busy' }, 10);
  await tick();
  assert.deepEqual(states, ['connecting', 'busy']);
  assert.equal(f.timers[0].ms, 10_000, "the server's Retry-After");
  f.fire();
  f.made[1].refuse(429, { busy: true, reason: 'busy' });
  await tick();
  assert.equal(f.timers[0].ms, RETRY_MS * 2, 'waits longer each time');
  for (let i = 0; i < 6; i++) {
    f.fire();
    f.made.at(-1).refuse(429, { busy: true, reason: 'busy' });
    await tick();
  }
  assert.equal(f.timers[0].ms, MAX_RETRY_MS, 'up to a cap');
  f.fire();
  f.made.at(-1).stream();
  await tick();
  assert.equal(states.at(-1), 'live');
  // Back off starts over after a stream that stayed open a while.
  t += 25_000;
  f.made.at(-1).end();
  await tick();
  f.fire();
  f.made.at(-1).refuse(429, { busy: true });
  await tick();
  assert.equal(f.timers[0].ms, RETRY_MS);
});

test("dashboard live streams: this person's share open elsewhere says so; no answer says offline; both try again", async () => {
  const f = fakeRequests();
  const live = createLiveStreams(f);
  const states = [];
  live.subscribe('/v1/live?service=g', { onState: (s) => states.push(s) });
  f.made[0].refuse(429, { error: 'you already have 3 live tails open here', busy: true, reason: 'yours' }, 10);
  await tick();
  assert.equal(states.at(-1), 'yours');
  f.fire();
  f.made[1].fail();
  await tick();
  assert.equal(states.at(-1), 'offline');
  assert.equal(f.timers.length, 1, 'tried again');
});

test('dashboard live streams: signed out (401) or no access (403) stops for good, and a 401 hands over to the page', async () => {
  for (const status of [401, 403]) {
    const f = fakeRequests();
    let unauthorized = 0;
    const live = createLiveStreams({ ...f, onUnauthorized: () => unauthorized++ });
    const states = [];
    live.subscribe('/v1/live?service=g', { onState: (s) => states.push(s) });
    f.made[0].refuse(status, { error: 'sign in' });
    await tick();
    assert.deepEqual(states, ['connecting', 'refused'], String(status));
    assert.equal(f.timers.length, 0, 'never tried again');
    assert.equal(unauthorized, status === 401 ? 1 : 0);
  }
});

test('dashboard live streams: a page that leaves while waiting to try again opens nothing more', async () => {
  const f = fakeRequests();
  const live = createLiveStreams(f);
  const stop = live.subscribe('/v1/live?service=g', {});
  f.made[0].refuse(429, { busy: true });
  await tick();
  stop();
  f.fire();
  assert.equal(f.made.length, 1);
  assert.equal(live.open(), 0);
});
