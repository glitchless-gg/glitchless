// A query's budget (query-budget.js) and how the app uses it: identical queries that arrive together share one run;
// a query past its deadline answers 503, its work stops at the next checkpoint and nothing is kept; a store that is
// busy answers 429 with Retry-After; what a query holds goes back when its work ends. On 17 November 2026 a few
// 90-day boards asked for at once, each run in full with nothing to stop them, took Glitchless Cloud's instances down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildContext } from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { newBudget, runWithin, budget, checkpoint, ReadRefused, tooBusy, deadlineFrom, seconds, DEFAULT_QUERY_DEADLINE_MS } from '../src/query-budget.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for `ok()` to hold (requests reach the server in their own time, slower while other suites run), at most 5 s.
async function until(ok, what = 'the state the test waits for') {
  for (const end = Date.now() + 5000; !ok(); await sleep(5)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const P = 'proj_q';

// A store that keeps summaries (it has context()), with a `read` the test controls: what every query waits on.
function fakeStore(read) {
  const store = {
    kind: 'fake',
    reads: 0,
    dashboard: null,
    services: async () => [{ service: 'game', versions: ['1.0.0'], envs: ['prod'], last_seen: Date.now() }],
    getDashboard: async () => store.dashboard,
    putDashboard: async (projectId, service, d) => void (store.dashboard = d),
    getMaps: async () => [],
    put: async () => {},
    context: async (projectId, q) => {
      store.reads++;
      await read(q);
      return buildContext([], q);
    },
  };
  return store;
}

// asked counts the requests that reached the server's reader check: one per query, whether it runs or waits on another.
async function serve(t, store, options = {}) {
  const seen = { asked: 0 };
  const auth = { resolveIngest: () => ({ projectId: P }), resolveReader: () => (seen.asked++, { projectId: P, scopes: ['read', 'dashboard'] }) };
  const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} }, ...options }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, timing: res.headers.get('server-timing'), retryAfter: res.headers.get('retry-after'), cache: res.headers.get('cache-control'), body: await res.json() };
  };
  return { base, get, seen };
}

// Opens when the test says so.
function latch() {
  let open;
  const opened = new Promise((r) => (open = r));
  return { open, opened };
}

test('identical queries that arrive together run once and share the answer', async (t) => {
  const gate = latch();
  const store = fakeStore(() => gate.opened);
  const { get, seen } = await serve(t, store);
  const asks = Array.from({ length: 5 }, () => get('/v1/query/sessions?service=game&from=1000&to=2000'));
  const other = get('/v1/query/sessions?service=game&from=1000&to=3000');
  await until(() => seen.asked === 6 && store.reads === 2, 'all six asks, and the two reads');
  await sleep(30);
  assert.equal(store.reads, 2, 'five identical queries are one read; a different range is its own');
  gate.open();
  const answers = await Promise.all(asks);
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200]);
  assert.equal(new Set(answers.map((a) => JSON.stringify(a.body))).size, 1);
  assert.equal(answers.filter((a) => a.timing === 'shared').length, 4, 'four took the first one\'s answer, and say so');
  assert.equal((await other).status, 200);
  // The answer is then kept for a few seconds, as before.
  assert.equal((await get('/v1/query/sessions?service=game&from=1000&to=2000')).status, 200);
  assert.equal(store.reads, 2);
});

test('a query that fails is shared as a failure, kept by nobody, and run again when asked again', async (t) => {
  let fail = true;
  const store = fakeStore(async () => {
    await sleep(20);
    if (fail) throw new Error('table unreachable');
  });
  const { get } = await serve(t, store);
  const [a, b] = await Promise.all([get('/v1/query/sessions?service=game&from=1&to=2'), get('/v1/query/sessions?service=game&from=1&to=2')]);
  assert.deepEqual([a.status, b.status], [500, 500]);
  assert.equal(store.reads, 1);
  fail = false;
  assert.equal((await get('/v1/query/sessions?service=game&from=1&to=2')).status, 200);
  assert.equal(store.reads, 2);
});

test('past its deadline a query answers 503, its work stops at the next checkpoint, and nothing is kept', async (t) => {
  let steps = 0;
  // A long read in steps, as a store reads hour after hour: each step looks at the deadline first.
  const store = fakeStore(async () => {
    for (let i = 0; i < 200; i++) {
      checkpoint();
      steps++;
      await sleep(10);
    }
  });
  const { get } = await serve(t, store, { queryDeadlineMs: 80 });
  const started = Date.now();
  const [a, joined] = await Promise.all([get('/v1/query/sessions?service=game&from=1&to=2'), get('/v1/query/sessions?service=game&from=1&to=2')]);
  assert.equal(a.status, 503);
  assert.equal(a.body.reason, 'deadline');
  assert.match(a.body.error, /shorter range/);
  assert.equal(a.cache, 'no-store');
  assert.equal(a.timing, 'refused;desc=deadline');
  assert.equal(a.retryAfter, null, 'asking again for the same range would take as long');
  assert.equal(joined.status, 503, 'the one that shared its run is refused with it');
  assert.ok(Date.now() - started < 1000, 'answered at the deadline, not when the work would have ended');
  const stopped = steps;
  assert.ok(stopped < 20, `the work stopped early (${stopped} of 200 steps)`);
  await sleep(100);
  assert.equal(steps, stopped, 'and no further step ran after the answer');
  // Nothing was kept: the same query runs again.
  const reads = store.reads;
  assert.equal((await get('/v1/query/sessions?service=game&from=1&to=2')).status, 503);
  assert.equal(store.reads, reads + 1);
});

test('a query that finishes late in one synchronous stretch is still refused, and not kept', async (t) => {
  // A timer can't fire while the event loop is held, so the answer is checked against the clock before it goes out.
  const store = fakeStore(async () => {
    const until = Date.now() + 120;
    while (Date.now() < until);
  });
  const { get } = await serve(t, store, { queryDeadlineMs: 40 });
  const a = await get('/v1/query/sessions?service=game&from=1&to=2');
  assert.equal(a.status, 503);
  assert.equal(a.body.reason, 'deadline');
  assert.equal((await get('/v1/query/sessions?service=game&from=1&to=2')).status, 503);
  assert.equal(store.reads, 2);
});

test('with no deadline (0) a slow query still answers', async (t) => {
  const store = fakeStore(() => sleep(60));
  const { get } = await serve(t, store, { queryDeadlineMs: 0 });
  assert.equal((await get('/v1/query/sessions?service=game&from=1&to=2')).status, 200);
  assert.equal(deadlineFrom('0'), 0);
  assert.equal(deadlineFrom('1500'), 1500);
  assert.equal(deadlineFrom(undefined), DEFAULT_QUERY_DEADLINE_MS);
  assert.equal(deadlineFrom('soon'), DEFAULT_QUERY_DEADLINE_MS);
});

test('a store that is busy answers 429 with Retry-After and a plain message: the server working as it should, not a 5xx', async (t) => {
  const store = fakeStore(async () => {
    throw tooBusy(5);
  });
  const { get } = await serve(t, store);
  const a = await get('/v1/query/sessions?service=game&from=1&to=2');
  assert.equal(a.status, 429);
  assert.equal(a.body.reason, 'busy');
  assert.equal(a.retryAfter, '5');
  assert.match(a.body.error, /busy with other large reads\. Try again in 5 seconds/);
  assert.deepEqual([seconds(25_000), seconds(1000), seconds(150), seconds(250), seconds(2500), seconds(27_000)], ['25 seconds', '1 second', '0.2 seconds', '0.3 seconds', '2.5 seconds', '27 seconds']);
  assert.equal(a.timing, 'refused;desc=busy');
  assert.equal(a.cache, 'no-store');
});

test('an answer short of a part for want of a turn is not kept; out of time while in line, a query is told busy', async (t) => {
  const callers = [];
  const store = fakeStore(async () => {
    callers.push(budget().caller);
    budget().notes.busy = true;
  });
  const { get } = await serve(t, store);
  const a = await get('/v1/query/sessions?service=game&from=1&to=2');
  assert.equal(a.status, 200);
  assert.equal(a.timing, 'partial');
  assert.equal(a.cache, 'no-store');
  assert.equal((await get('/v1/query/sessions?service=game&from=1&to=2')).status, 200);
  assert.equal(store.reads, 2, 'asked again, it is read again: it may be whole now');
  assert.deepEqual(callers, [`project ${P}`, `project ${P}`], 'a reader with no key or person of its own is its game');
  // A query still in line for a heavy read when its time runs out was kept waiting: not too big.
  const waiting = fakeStore(async () => {
    budget().inLine = tooBusy(5);
    await sleep(300);
  });
  const late = await (await serve(t, waiting, { queryDeadlineMs: 40 })).get('/v1/query/sessions?service=game&from=1&to=2');
  assert.deepEqual([late.status, late.body.reason, late.retryAfter], [429, 'busy', '5']);
});

test('saving a dashboard lets go of the answers being worked out; new events do not', async (t) => {
  const gates = [];
  const store = fakeStore(() => {
    const g = latch();
    gates.push(g);
    return g.opened;
  });
  const { base, get, seen } = await serve(t, store);
  const url = '/v1/query/sessions?service=game&from=1&to=2';
  const before = get(url);
  await until(() => store.reads === 1, 'the first read');
  // New events arrive: the query in flight is still the one to wait on.
  const sent = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: 'game', version: '1.0.0', session_id: 's1', events: [{ type: 'session_start', ts: Date.now() }] }) });
  assert.equal(sent.status, 202);
  const during = get(url);
  await until(() => seen.asked === 2, 'the second ask');
  await sleep(30);
  assert.equal(store.reads, 1, 'the second ask shares the first one\'s run across an intake');
  // The dashboard is saved: a read that began before it must not answer a request made after it.
  const saved = await fetch(`${base}/v1/dashboard?service=game`, { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'main', title: 'Main', panels: [{ type: 'stat', metric: 'sessions' }] }] }) });
  assert.equal(saved.status, 200);
  const after = get(url);
  await until(() => store.reads === 2, 'the ask after the save to run on its own');
  for (const g of gates) g.open();
  assert.deepEqual((await Promise.all([before, during, after])).map((a) => a.status), [200, 200, 200]);
  // Only the run made after the save was kept.
  assert.equal((await get(url)).status, 200);
  assert.equal(store.reads, 2);
});

test('a budget: checkpoints, one hold a key given back when the work ends, and a grace for work that never stops', async () => {
  assert.equal(budget(), null, 'outside a query there is none');
  checkpoint();
  // One hold per key however often it is asked for, released when the work has ended.
  let taken = 0;
  let released = 0;
  const key = {};
  const acquire = async () => (taken++, () => released++);
  const b = newBudget({ deadlineMs: 1000 });
  const answer = await runWithin(b, async () => {
    assert.equal(budget(), b);
    await Promise.all([b.hold(key, acquire), b.hold(key, acquire)]);
    await b.hold(key, acquire);
    assert.equal(released, 0, 'held for the whole query');
    return 'done';
  });
  assert.equal(answer, 'done');
  assert.deepEqual([taken, released], [1, 1]);

  // Work stopped at the deadline: the caller hears at once, and the hold goes back when the work does stop.
  const slow = newBudget({ deadlineMs: 30 });
  let steps = 0;
  const run = runWithin(slow, async () => {
    await slow.hold(key, acquire);
    for (;;) {
      checkpoint();
      steps++;
      await sleep(10);
    }
  });
  await assert.rejects(run, (err) => err instanceof ReadRefused && err.reason === 'deadline' && err.status === 503);
  assert.ok(slow.signal.aborted, 'its signal aborts what is waiting on a network or a database');
  await sleep(40);
  assert.deepEqual([taken, released], [2, 2]);
  assert.ok(steps < 10);

  // Work that never looks at the deadline keeps its hold only for the grace period.
  const stuck = newBudget({ deadlineMs: 20, graceMs: 30 });
  let finish;
  const never = runWithin(stuck, async () => {
    await stuck.hold(key, acquire);
    await new Promise((r) => (finish = r));
  });
  await assert.rejects(never, ReadRefused);
  assert.equal(released, 2);
  await sleep(60);
  assert.equal(released, 3, 'given back after the grace, though the work has not ended');
  finish();
  // A refused hold is every later ask's refusal too.
  const refused = newBudget({ deadlineMs: 0 });
  await assert.rejects(
    runWithin(refused, async () => {
      await refused.hold(key, async () => {
        throw tooBusy(3);
      }).catch(() => {});
      await refused.hold(key, acquire);
    }),
    (err) => err.reason === 'busy' && err.retryAfter === 3,
  );
  assert.equal(taken, 3, 'the refused query never took one');
});
