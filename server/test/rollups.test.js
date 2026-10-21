// Rollups written at ingest must give exactly the answers the raw events give, whatever order batches
// arrive in, wherever a range starts and ends, and whichever env/version filter is applied. The same holds
// for the hosted store's compacted summaries (more in lake.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file.js';
import { DynamoStore } from '../src/stores/dynamo.js';
import { buildContext, overview, performance, versions } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { FakeDynamo } from './helpers/fake-dynamo.js';
import { gameSessions, shuffledBatches } from './helpers/game-data.js';
import { lakeSim, needsDuckDB } from './helpers/lake-sim.js';

const HOUR = 3_600_000;
const START = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR + 17_123;
const P = 'proj_a';

const sessions = gameSessions({ start: START, spanMs: 90 * 60_000, sessions: 40 });
const batches = shuffledBatches(sessions);
const times = sessions.flat().map((e) => e.ts).sort((a, b) => a - b);
const at = (q) => times[Math.floor(q * (times.length - 1))];
const RANGES = [
  [START - 5 * HOUR, START + 5 * HOUR], // everything
  [at(0.1) - 1, at(0.9) + 1], // starts and ends inside busy minutes
  [at(0.3) + 1, at(0.31)], // a few minutes in the busiest stretch
  [Math.ceil(at(0.4) / 60_000) * 60_000, Math.ceil(at(0.7) / 60_000) * 60_000 - 1], // whole minutes only
  [at(0.5), at(0.5) + 20_000], // inside one or two minutes
];
const FILTERS = [{}, { env: 'prod' }, { version: '1.0.1' }, { env: 'dev', version: '1.1.0' }];

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-rollups-'));

async function fill(stores, batches) {
  for (let i = 0; i < batches.length; i++) await stores[i % stores.length].put(P, batches[i]);
}

function answers(raw, q, rollups) {
  const ctx = buildContext(raw, q, rollups);
  return { overview: overview(ctx), performance: performance(ctx), versions: versions(ctx), findings: findings(ctx, []) };
}

// Compares both paths on every range and filter; returns how many stored rollup minutes were used and
// how many frame windows came from the partial minutes at the edges.
async function compare(store) {
  let used = 0;
  let edges = 0;
  for (const [from, to] of RANGES) {
    for (const f of FILTERS) {
      const q = { service: 'zoomies', from, to, env: f.env || null, version: f.version || null, type: 'all', sessions: null };
      const raw = await store.query(P, q);
      const rollups = await store.rollups(P, q);
      used += rollups.minutes.size;
      edges += raw.filter((e) => e.type === 'frame_window' && (e.ts < rollups.lo || e.ts >= rollups.hi)).length;
      assert.deepStrictEqual(answers(raw, q, rollups), answers(raw, q, null), `range ${JSON.stringify([from - START, to - START, f])}`);
    }
  }
  return { used, edges };
}

function assertCovered({ used, edges }) {
  assert.ok(used > 200, `rollup minutes used: ${used}`);
  assert.ok(edges > 20, `frame windows folded from partial minutes: ${edges}`);
}

test('file store: rollups kept at ingest match the raw path, and again after a restart', async () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  await fill([store], batches);
  assertCovered(await compare(store));
  assertCovered(await compare(new FileStore(dir)));
});

test('dynamodb store: rollups from two writers match the raw path', async () => {
  const doc = new FakeDynamo();
  const writers = [new DynamoStore({ table: 't', doc, rollupsSince: 0 }), new DynamoStore({ table: 't', doc, rollupsSince: 0 })];
  await fill(writers, batches);
  // A fresh reader, so nothing comes from a writer's memory.
  const reader = new DynamoStore({ table: 't', doc, rollupsSince: 0 });
  assertCovered(await compare(reader));
  const items = [...doc.tables.keys()].filter((pk) => pk.startsWith(`P#${P}#R#zoomies#`));
  assert.ok(items.length > 0, 'rollup items are stored under the project');
});

test('dynamodb store: a late event for a minute this process already let go of is not lost', async () => {
  const doc = new FakeDynamo();
  const store = new DynamoStore({ table: 't', doc, rollupsSince: 0 });
  await fill([store], batches);
  // Pretend ten minutes have passed so the running rollups are dropped from memory.
  for (const r of store.running.values()) r.at -= 11 * 60_000;
  store.sweptAt = 0;
  // Replays of real sessions under new ids, so they land in minutes that already have rollup items.
  const late = sessions.slice(0, 5).flatMap((events) => events.map((e) => ({ ...e, session_id: `late_${e.session_id}` })));
  const items = () => [...doc.tables].filter(([pk]) => pk.includes('#R#')).reduce((n, [, t]) => n + t.size, 0);
  const before = items();
  for (let i = 0; i < late.length; i += 40) await store.put(P, late.slice(i, i + 40));
  assert.ok(items() > before, 'late minutes get items of their own');
  assertCovered(await compare(new DynamoStore({ table: 't', doc, rollupsSince: 0 })));
});

test('dynamodb store: rollups only count from the recorded start, and the raw path covers the rest', async () => {
  const doc = new FakeDynamo();
  const store = new DynamoStore({ table: 't', doc }); // default: complete from 2 h after the first write
  await fill([store], batches);
  const since = doc.get(`P#${P}#META`, 'rollups#zoomies').since;
  assert.ok(since > Date.now() + HOUR);
  const r = await store.rollups(P, { service: 'zoomies', from: START, to: START + 4 * HOUR });
  assert.equal(r.minutes.size, 0);
  assert.equal((await compare(store)).used, 0);
});

test('lake store: summaries the compactor writes match the raw path, batches arriving in any order', needsDuckDB, async () => {
  // The shuffled batches arrive in that order over three hours: some before the events in them (client
  // clocks ahead), most well after.
  const span = 3 * HOUR;
  const sim = lakeSim({ start: START - HOUR });
  try {
    await sim.send(batches.map((events, i) => ({ project: P, events, at: START + Math.floor((i * span) / batches.length) })));
    await sim.settle();
    const reference = batches
      .flat()
      .map((e, i) => [{ ...e, project_id: P }, i])
      .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
      .map(([e]) => e);
    const QUERIES = { overview, performance, versions, findings: (ctx) => findings(ctx, []) };
    for (const [from, to] of RANGES) {
      for (const f of FILTERS) {
        for (const [name, run] of Object.entries(QUERIES)) {
          const q = { service: 'zoomies', from, to, env: f.env || null, version: f.version || null, type: 'all', sessions: null };
          const ctx = await sim.store.context(P, q, name);
          const raw = buildContext(
            reference.filter((e) => e.ts >= ctx.from && e.ts <= ctx.to),
            { ...q, from: ctx.from, to: ctx.to },
          );
          assert.deepStrictEqual(run(ctx), run(raw), `${name} ${JSON.stringify([from - START, to - START, f])}`);
        }
      }
    }
  } finally {
    sim.close();
  }
});
