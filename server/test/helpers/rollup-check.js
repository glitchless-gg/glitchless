// The rollup check every store's rollups must pass (rollups.test.js runs it on the file store): the answers from
// stored rollup minutes plus the raw events at a range's edges equal the answers from the raw events alone, on
// every range and env/version filter below.
import assert from 'node:assert/strict';
import { buildContext, overview, performance, versions } from '../../src/analytics.js';
import { findings } from '../../src/findings.js';
import { gameSessions, shuffledBatches } from './game-data.js';

export const HOUR = 3_600_000;
export const START = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR + 17_123;
export const P = 'proj_a';

export const sessions = gameSessions({ start: START, spanMs: 90 * 60_000, sessions: 40 });
export const batches = shuffledBatches(sessions);
const times = sessions.flat().map((e) => e.ts).sort((a, b) => a - b);
const at = (q) => times[Math.floor(q * (times.length - 1))];
export const RANGES = [
  [START - 5 * HOUR, START + 5 * HOUR], // everything
  [at(0.1) - 1, at(0.9) + 1], // starts and ends inside busy minutes
  [at(0.3) + 1, at(0.31)], // a few minutes in the busiest stretch
  [Math.ceil(at(0.4) / 60_000) * 60_000, Math.ceil(at(0.7) / 60_000) * 60_000 - 1], // whole minutes only
  [at(0.5), at(0.5) + 20_000], // inside one or two minutes
];
export const FILTERS = [{}, { env: 'prod' }, { version: '1.0.1' }, { env: 'dev', version: '1.1.0' }];

export async function fill(stores, batches) {
  for (let i = 0; i < batches.length; i++) await stores[i % stores.length].put(P, batches[i]);
}

export function answers(raw, q, rollups) {
  const ctx = buildContext(raw, q, rollups);
  return { overview: overview(ctx), performance: performance(ctx), versions: versions(ctx), findings: findings(ctx, []) };
}

// Compares both paths on every range and filter; returns how many stored rollup minutes were used and
// how many frame windows came from the partial minutes at the edges.
export async function compare(store) {
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

export function assertCovered({ used, edges }) {
  assert.ok(used > 200, `rollup minutes used: ${used}`);
  assert.ok(edges > 20, `frame windows folded from partial minutes: ${edges}`);
}

