// The summaries the compactor keeps in DynamoDB, one block per (project, service, hour):
//
//   C  minute cells: per minute and (env, version, level), the rollup cell (rollups.js) and the facts
//      (facts.js) of that minute's events
//   F  per-minute session states (session-state.js): one per session and minute it sent events in
//   H  per-hour session states: one per session and hour
//   A  all three in one item, for blocks small enough (most small games): DynamoDB bills each item
//      written by the KB, rounded up, so three tiny items cost three units where one costs one
//
// A query over [lo, hi) merges the C minutes inside it, the H states of the hours that lie fully inside
// and the F states of the minutes inside it in the hours at its edges. All three merge exactly, so the
// answer equals folding the raw events of [lo, hi). Each compactor run writes its own items for the hours
// it saw events for (blocks merge in any number); once an hour is closed the compactor consolidates its
// items into one set.
//
// Items hold gzip-compressed JSON in a binary attribute: DynamoDB bills writes per KB of item, and the
// JSON compresses about tenfold.

import zlib from 'node:zlib';
import { rollup, cellToJSON, cellFromJSON, minuteOf } from '../rollups.js';
import { foldFacts } from '../facts.js';
import { foldSessions, mergeSession, sessionToJSON, sessionFromJSON } from '../session-state.js';
import { hourOf } from './layout.js';

export const FAMILIES = ['C', 'F', 'H'];
export const STORED_FAMILIES = ['A', 'C', 'F', 'H'];
// Stay well under DynamoDB's 400 KB item limit.
export const MAX_ITEM_BYTES = 300_000;
// Blocks whose three families together gzip to this or less are stored as one A item.
export const COMBINE_BYTES = 16_000;

// Fold events (already in order) into blocks keyed `${project}\n${service}\n${hour}`.
export function foldBlocks(events) {
  const groups = new Map();
  for (const e of events) {
    if (e.type === 'map') continue;
    const key = blockKey(e.project_id, e.service, hourOf(e.ts));
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { project: e.project_id, service: e.service, hour: hourOf(e.ts), events: [] }));
    g.events.push(e);
  }
  const blocks = new Map();
  for (const [key, g] of groups) blocks.set(key, foldBlock(g));
  return blocks;
}

export function foldBlock({ project, service, hour, events }) {
  const byMinute = new Map();
  for (const e of events) {
    const m = minuteOf(e.ts);
    if (!byMinute.has(m)) byMinute.set(m, []);
    byMinute.get(m).push(e);
  }
  return {
    project,
    service,
    hour,
    cells: rollup(events),
    facts: foldFacts(events),
    minuteSessions: new Map([...byMinute].map(([m, evs]) => [m, foldSessions(evs)])),
    hourSessions: foldSessions(events),
    events: events.length,
  };
}

export function blockKey(project, service, hour) {
  return `${project}\n${service}\n${hour}`;
}

// ── storage form ──

// One family of a block as plain JSON-able parts; chunk() splits the parts across items.
export function blockParts(block, family) {
  if (family === 'C') {
    const parts = [];
    for (const [m, cells] of block.cells) {
      const facts = block.facts.get(m);
      parts.push([m, [...cells].map(([key, c]) => [cellToJSON(c), facts.get(key)])]);
    }
    return parts;
  }
  if (family === 'F') return [...block.minuteSessions].map(([m, sessions]) => [m, [...sessions.values()].map(sessionToJSON)]);
  return [...block.hourSessions.values()].map(sessionToJSON);
}

// Gzip parts into as few payloads as fit an item each.
export function chunk(parts, extra = {}) {
  const encode = (list) => zlib.gzipSync(JSON.stringify({ ...extra, parts: list }));
  const out = [];
  const split = (list) => {
    const buf = encode(list);
    if (buf.length <= MAX_ITEM_BYTES || list.length <= 1) return out.push(buf);
    const mid = Math.ceil(list.length / 2);
    split(list.slice(0, mid));
    split(list.slice(mid));
  };
  split(parts);
  return out;
}

export function decode(buf) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString('utf8'));
}

// A block's items for one run: { family, chunk, b } (gzip JSON), one A item when small. `extra` goes with
// the minute cells (plan, raw and Parquet files).
export function blockPayloads(block, extra = {}) {
  const parts = Object.fromEntries(FAMILIES.map((f) => [f, blockParts(block, f)]));
  const chunks = Object.fromEntries(FAMILIES.map((f) => [f, chunk(parts[f], f === 'C' ? extra : {})]));
  const single = FAMILIES.every((f) => chunks[f].length === 1);
  const bytes = FAMILIES.reduce((n, f) => n + chunks[f].reduce((m, b) => m + b.length, 0), 0);
  if (single && bytes <= COMBINE_BYTES) {
    const b = zlib.gzipSync(JSON.stringify({ ...extra, parts }));
    if (b.length <= MAX_ITEM_BYTES) return [{ family: 'A', chunk: 0, b }];
  }
  return FAMILIES.flatMap((f) => chunks[f].map((b, i) => ({ family: f, chunk: i, b })));
}

// Decoded items → items of the three families (an A item yields one of each), keeping only `keep`.
export function expandItems(items, keep = () => true) {
  const out = [];
  for (const it of items) {
    if (it.family !== 'A') {
      if (keep(it.family, it.hour)) out.push(it);
      continue;
    }
    const { parts, ...extra } = it.payload;
    for (const f of FAMILIES) if (keep(f, it.hour)) out.push({ ...it, family: f, payload: { ...(f === 'C' ? extra : {}), parts: parts[f] } });
  }
  return out;
}

// ── reading ──

// Merge decoded items of one project and service into what a query over [lo, hi) needs:
// { cells: Map<m, Map<key, cell>>, facts: Map<m, Map<key, facts>>, sessions: Map<id, state> }.
// `items` are { family, hour, run, chunk, payload } in any order, freshly decoded (merging writes into
// them); which items of an hour count (consolidated or per run) is resolved by the caller.
export function mergeItems(items, lo, hi, { addCell, addFactsCell }) {
  const cells = new Map();
  const facts = new Map();
  const sessions = new Map();
  const ordered = [...items].sort((a, b) => a.hour - b.hour || famRank(a.family) - famRank(b.family) || (a.run < b.run ? -1 : a.run > b.run ? 1 : a.chunk - b.chunk));
  const addSession = (o) => {
    const s = sessionFromJSON(o);
    const have = sessions.get(s.session_id);
    if (have) mergeSession(have, s);
    else sessions.set(s.session_id, s);
  };
  // Session states must merge in time order: F minutes in order across all F items of an hour.
  for (const it of ordered) {
    if (it.family === 'C') {
      for (const [m, list] of it.payload.parts) {
        if (m < lo || m >= hi) continue;
        for (const [c, f] of list) {
          addCell(cells, m, cellFromJSON(c));
          addFactsCell(facts, m, f);
        }
      }
    } else if (it.family === 'H') {
      for (const o of it.payload.parts) addSession(o);
    }
  }
  const minuteStates = [];
  for (const it of ordered) if (it.family === 'F') for (const [m, list] of it.payload.parts) if (m >= lo && m < hi) minuteStates.push([m, it.hour, it.run, list]);
  // By minute; a minute written by two runs keeps run order.
  minuteStates.sort((a, b) => a[0] - b[0] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  // H states (whole hours) and F states (edge minutes) cover disjoint time, so merging them in any
  // order is exact; within each, the order above keeps later arrivals last.
  for (const [, , , list] of minuteStates) for (const o of list) addSession(o);
  return { cells, facts, sessions };
}

function famRank(f) {
  return f === 'C' ? 0 : f === 'H' ? 1 : 2;
}
