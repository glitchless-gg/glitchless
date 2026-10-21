// A whole hosted event store on one machine: LakeStore with a local Firehose that delivers gzip objects
// into a directory bucket, the in-memory DynamoDB, and the compactor, all on a virtual clock. Batches are
// sent at their arrival time; Firehose delivers and the compactor runs on schedule as the clock moves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeDynamo } from './fake-dynamo.js';
import { FsBucket } from '../../src/lake/bucket.js';
import { LocalFirehose } from '../../src/lake/firehose.js';
import { LakeTable } from '../../src/lake/table.js';
import { Compactor } from '../../src/lake/compactor.js';
import { LakeStore } from '../../src/stores/lake.js';

// DuckDB is an optional dependency (only the hosted store uses it); without it the lake tests are skipped.
export const hasDuckDB = await import('@duckdb/node-api').then(
  () => true,
  () => false,
);
export const needsDuckDB = hasDuckDB ? {} : { skip: 'needs the optional dependency @duckdb/node-api' };

export function lakeSim({
  start = Date.now(),
  bufferMs = 120_000,
  everyMs = 120_000,
  deliveryDelayMs = bufferMs * 1.5 + 60_000,
  partitionByProject = true,
  pageSize = 50,
  compactor: options = {},
} = {}) {
  const sim = { clock: start };
  const now = () => sim.clock;
  sim.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-lake-'));
  sim.bucket = new FsBucket(sim.dir);
  sim.doc = new FakeDynamo({ pageSize });
  sim.table = new LakeTable({ table: 'lake', doc: sim.doc });
  sim.firehose = new LocalFirehose({ bucket: sim.bucket, bufferMs, partitionByProject, now });
  sim.compactor = new Compactor({ bucket: sim.bucket, table: sim.table, now, deliveryDelayMs, workDir: path.join(sim.dir, '.work'), ...options });
  sim.store = new LakeStore({ table: sim.table, bucket: sim.bucket, firehose: sim.firehose, now });
  sim.runs = [];
  let next = start + everyMs;

  // Move the clock to `t`, delivering and compacting on schedule on the way.
  sim.advance = async (t) => {
    while (next <= t) {
      sim.clock = next;
      await sim.firehose.deliver();
      sim.runs.push(await sim.compactor.run());
      next += everyMs;
    }
    sim.clock = Math.max(sim.clock, t);
  };

  // Send batches [{ project, events, at, identity? }] in arrival order.
  sim.send = async (batches) => {
    for (const b of [...batches].sort((x, y) => x.at - y.at)) {
      await sim.advance(b.at);
      await sim.store.put(b.project, b.events, b.identity);
    }
  };

  // Let everything settle: Firehose delivers, sessions finish, hours close.
  sim.settle = async (ms = 3 * 3_600_000) => sim.advance(sim.clock + ms);

  sim.close = () => fs.rmSync(sim.dir, { recursive: true, force: true });
  return sim;
}

// A lake on the real clock that delivers and compacts after every put, so what was sent is queryable
// at once (watermark: the current minute).
export function liveLake() {
  const sim = lakeSim({ bufferMs: 0, deliveryDelayMs: 0 });
  const now = () => Date.now();
  sim.firehose.now = now;
  sim.compactor.now = now;
  sim.store.now = now;
  sim.store.compact = async () => {
    await sim.firehose.deliver({ all: true });
    await sim.compactor.run();
  };
  return sim;
}

// SDK-sized batches of each session, arriving a second after their last event; `late` of them (seeded)
// arrive minutes to an hour later, as from a client that was offline.
export function arrivals(sessions, { project, size = 6, late = 0, seed = 5 } = {}) {
  let a = seed;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (const events of sessions) {
    for (let i = 0; i < events.length; i += size) {
      const batch = events.slice(i, i + size);
      const delay = rnd() < late ? 5 * 60_000 + Math.floor(rnd() * 55 * 60_000) : 1000;
      out.push({ project, events: batch, at: Math.max(...batch.map((e) => e.ts)) + delay });
    }
  }
  return out;
}
