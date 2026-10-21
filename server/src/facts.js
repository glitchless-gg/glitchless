// Per-minute event facts: what the performance, findings and error queries need from hitches,
// frame-window gauges, breadcrumb-named events and errors, folded per (env, version, level) and minute
// like rollup cells (rollups.js). Folding raw events and merging stored minutes give the same facts, so
// a store that keeps them answers exactly as the raw events would.
//
// Medians need every value, so gauges are kept as value → count maps. Where the raw queries list things
// in the order they first appeared (gauge keys, event names, error versions), the facts keep when each
// first appeared ([ts, position]) and the queries sort by that.

import { minuteOf } from './rollups.js';

// Level transitions always cost a frame or two (shader compile, uploads) — that's attributed via
// hitch causes, so leave them out of "what triggered this" analysis.
export const LOADING_EVENTS = new Set(['level_start', 'level_complete']);

export function newFacts(env = null, version = null, level = null) {
  return {
    env,
    version,
    level,
    hc: {}, // hitch causes → count
    hg: {}, // hitch gauges: key → { value: count }
    hk: {}, // hitch gauge keys: key → [ts, position] first seen
    wc: {}, // calm frame-window gauges (no hitch in the window): key → { value: count }
    wh: {}, // frame-window gauges of windows with hitches
    wk: {}, // frame-window gauge keys first seen
    cr: {}, // breadcrumb-named events → count
    hr: {}, // names in hitches' recent-event lists → number of hitches naming them
    hn: {}, // those names, first seen
    er: {}, // errors by fingerprint (see addError)
  };
}

// Fold events into minutes: Map<minute ts, Map<cell key, facts>>.
export function foldFacts(events, minutes = new Map()) {
  for (const e of events) {
    if (e.type === 'map') continue;
    const m = minuteOf(e.ts);
    let cells = minutes.get(m);
    if (!cells) minutes.set(m, (cells = new Map()));
    const level = e.level ?? null;
    const key = factsKey(e.env, e.version, level);
    let f = cells.get(key);
    if (!f) cells.set(key, (f = newFacts(e.env ?? null, e.version ?? null, level)));
    addFact(f, e);
  }
  return minutes;
}

export function addFact(f, e) {
  const name = crumbName(e);
  if (name) f.cr[name] = (f.cr[name] || 0) + 1;
  if (e.type === 'frame_window') {
    const gauges = (e.hitches || 0) > 0 ? f.wh : f.wc;
    Object.keys(e.ctx || {}).forEach((k, i) => {
      firstSeen(f.wk, k, e.ts, i);
      countValue(gauges, k, e.ctx[k]);
    });
  } else if (e.type === 'hitch') {
    for (const c of e.causes?.length ? e.causes : ['unattributed']) f.hc[c] = (f.hc[c] || 0) + 1;
    Object.keys(e.ctx || {}).forEach((k, i) => {
      firstSeen(f.hk, k, e.ts, i);
      countValue(f.hg, k, e.ctx[k]);
    });
    let i = 0;
    for (const n of new Set(e.recent || [])) {
      if (LOADING_EVENTS.has(n)) continue;
      f.hr[n] = (f.hr[n] || 0) + 1;
      firstSeen(f.hn, n, e.ts, i++);
    }
  } else if (e.type === 'error') {
    addError(f.er, e);
  }
}

// One fingerprint: count, the first occurrence (which names the issue), when it was last seen, and the
// sessions, players, versions and levels it touched.
function addError(er, e) {
  const key = fingerprintKey(e.fingerprint);
  let x = er[key];
  if (!x) {
    x = er[key] = {
      fp: e.fingerprint,
      n: 0,
      first: { ts: e.ts, kind: e.kind, message: e.message, fn: e.fn, source: e.source, line: e.line, stack: e.stack, version: e.version, session_id: e.session_id },
      last: e.ts,
      sessions: {},
      players: {},
      versions: {},
      levels: {},
    };
  }
  x.n++;
  if (e.ts < x.first.ts) x.first = { ts: e.ts, kind: e.kind, message: e.message, fn: e.fn, source: e.source, line: e.line, stack: e.stack, version: e.version, session_id: e.session_id };
  if (e.ts > x.last) x.last = e.ts;
  x.sessions[e.session_id] = 1;
  x.players[e.player_id] = 1;
  if (!(e.version in x.versions) || e.ts < x.versions[e.version]) x.versions[e.version] = e.ts;
  if (e.level) x.levels[e.level] = 1;
}

export function mergeFacts(into, f) {
  addCounts(into.hc, f.hc);
  addValueMaps(into.hg, f.hg);
  addFirstSeen(into.hk, f.hk);
  addValueMaps(into.wc, f.wc);
  addValueMaps(into.wh, f.wh);
  addFirstSeen(into.wk, f.wk);
  addCounts(into.cr, f.cr);
  addCounts(into.hr, f.hr);
  addFirstSeen(into.hn, f.hn);
  mergeErrors(into.er, f.er);
  return into;
}

export function mergeErrors(into, er) {
  for (const [key, x] of Object.entries(er)) {
    const y = into[key];
    if (!y) {
      into[key] = structuredClone(x);
      continue;
    }
    y.n += x.n;
    if (x.first.ts < y.first.ts) y.first = { ...x.first };
    if (x.last > y.last) y.last = x.last;
    Object.assign(y.sessions, x.sessions);
    Object.assign(y.players, x.players);
    Object.assign(y.levels, x.levels);
    for (const [v, ts] of Object.entries(x.versions)) if (!(v in y.versions) || ts < y.versions[v]) y.versions[v] = ts;
  }
  return into;
}

// Merge one stored facts cell into minutes (taking ownership of `f` when the minute has no such cell yet).
export function addFactsCell(minutes, m, f) {
  let cells = minutes.get(m);
  if (!cells) minutes.set(m, (cells = new Map()));
  const key = factsKey(f.env, f.version, f.level);
  const have = cells.get(key);
  if (have) mergeFacts(have, f);
  else cells.set(key, f);
}

// ── reading merged facts ──

// Keys of first-seen maps, in the order they first appeared.
export function inFirstSeenOrder(seen) {
  return Object.entries(seen)
    .sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1])
    .map(([k]) => k);
}

// The q-quantile of a value → count map, exactly as sorting every value and taking index
// min(n - 1, floor(q * n)) would give it; null when there are none.
export function valueQuantile(counts, q) {
  if (!counts) return null;
  const values = Object.keys(counts)
    .map(Number)
    .sort((a, b) => a - b);
  let n = 0;
  for (const k of Object.keys(counts)) n += counts[k];
  if (!n) return null;
  const idx = Math.min(n - 1, Math.floor(q * n));
  let acc = 0;
  for (const v of values) {
    acc += counts[v];
    if (acc > idx) return v;
  }
  return null;
}

export function valueCount(counts) {
  let n = 0;
  for (const k in counts || {}) n += counts[k];
  return n;
}

export function addValueMaps(into, maps) {
  for (const [k, counts] of Object.entries(maps)) addCounts((into[k] ||= {}), counts);
  return into;
}

// Name an event the way the SDK's breadcrumb buffer does (see core.js remember()).
export function crumbName(e) {
  if (e.type === 'custom') return e.name;
  if (e.type === 'death') return `death:${e.cause}`;
  if (e.type === 'error') return `error:${String(e.message).slice(0, 40)}`;
  if (e.type === 'level_start' || e.type === 'level_complete' || e.type === 'level_fail') return e.type;
  return null;
}

function factsKey(env, version, level) {
  return JSON.stringify([env ?? null, version ?? null, level]);
}

// Fingerprints are usually strings, but a missing one must not collide with the string "undefined".
function fingerprintKey(fp) {
  return fp === undefined ? '\u0000' : JSON.stringify(fp);
}

function countValue(maps, k, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  const counts = (maps[k] ||= {});
  counts[v] = (counts[v] || 0) + 1;
}

function firstSeen(seen, k, ts, i) {
  const have = seen[k];
  if (!have || ts < have[0] || (ts === have[0] && i < have[1])) seen[k] = [ts, i];
}

function addFirstSeen(into, seen) {
  for (const [k, [ts, i]] of Object.entries(seen)) firstSeen(into, k, ts, i);
}

function addCounts(into, counts) {
  for (const [k, n] of Object.entries(counts)) into[k] = (into[k] || 0) + n;
  return into;
}
