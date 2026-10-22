// Per-minute rollups: what the overview, performance and versions queries need from frame windows and
// event counts, pre-aggregated per (env, version, level) and minute of one service.
//
// Stores fold events in as they arrive (rollup()), and queries merge the stored minutes that lie fully
// inside the asked range, folding raw events only for the partial minutes at its edges. Queries without
// stored rollups fold every raw event the same way, so both paths give identical numbers. Sums are kept
// in fixed point so that the order events arrive in never changes a total.

import { Sketch } from '../../packages/sdk/src/sketch.js';

export const MINUTE = 60_000;

// Fixed-point scales for summed fields: integers add exactly in any order.
export const FIXED = { sec: 1e6, render: 1e6, heap: 1e6, calls: 1e3, tris: 1, geo: 1 };

// Custom event names, attribute keys and values are the game's own, so a cell counts at most this many
// names (ev) and name × attribute × value triples (evv); the rest go under OTHER.
export const MAX_EVENT_NAMES = 200;
export const MAX_EVENT_VALUES = 400;
export const OTHER = '(other)';
// The attributes of a custom event that counts and breakdowns use (see smallAttrs).
export const ATTRS = { keys: 12, valueLength: 64 };
const SEP = '\u0001';

// One cell: n counts events by type, ev custom events by name and evv by name, attribute and value (keys
// joined by SEP; see attrKey); the rest covers frame windows only. t0 is the first frame window's ts,
// which orders versions and levels the way the raw events would.
export function newCell(env = null, version = null, level = null) {
  return {
    env,
    version,
    level,
    t0: null,
    n: {},
    ev: {},
    evv: {},
    fw: 0,
    frames: 0,
    hitches: 0,
    frozen: 0,
    sec: 0,
    ft: new Sketch(),
    budgets: {},
    calls: [0, 0],
    callsMax: 0,
    render: [0, 0],
    tris: [0, 0],
    geo: [0, 0],
    geoMax: 0,
    heap: [0, 0],
    ctxMax: {},
  };
}

// Fold events into minutes: Map<minute ts, Map<cell key, cell>>.
export function rollup(events, minutes = new Map()) {
  for (const e of events) {
    if (e.type === 'map') continue;
    const m = minuteOf(e.ts);
    let cells = minutes.get(m);
    if (!cells) minutes.set(m, (cells = new Map()));
    const level = e.level ?? null;
    const key = cellKey(e.env, e.version, level);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = newCell(e.env ?? null, e.version ?? null, level)));
    addEvent(c, e);
  }
  return minutes;
}

export function addEvent(c, e) {
  c.n[e.type] = (c.n[e.type] || 0) + 1;
  if (e.type === 'custom' && typeof e.name === 'string' && e.name) {
    const name = eventName(e.name);
    countName(c.ev, name, 1, MAX_EVENT_NAMES);
    for (const [k, v] of Object.entries(smallAttrs(e.attrs))) countName(c.evv, attrKey(name, k, v), 1, MAX_EVENT_VALUES);
  }
  if (e.type !== 'frame_window') return;
  if (c.t0 == null || e.ts < c.t0) c.t0 = e.ts;
  c.fw++;
  if (isNum(e.frames)) c.frames += e.frames;
  if (isNum(e.hitches)) c.hitches += e.hitches;
  if (isNum(e.frozen)) c.frozen += e.frozen;
  if (isNum(e.duration_s)) c.sec += fixed(e.duration_s, FIXED.sec);
  if (e.ft) c.ft.merge(e.ft);
  if (isNum(e.budget_ms) && e.budget_ms) c.budgets[e.budget_ms] = (c.budgets[e.budget_ms] || 0) + 1;
  addPair(c.calls, e.draw_calls, FIXED.calls);
  if (isNum(e.draw_calls_max) && e.draw_calls_max > c.callsMax) c.callsMax = e.draw_calls_max;
  addPair(c.render, e.render_ms, FIXED.render);
  addPair(c.tris, e.triangles, FIXED.tris);
  addPair(c.geo, e.geometries, FIXED.geo);
  if (isNum(e.geometries) && e.geometries > c.geoMax) c.geoMax = e.geometries;
  addPair(c.heap, e.heap_mb, FIXED.heap);
  for (const [k, v] of Object.entries(e.ctx || {})) maxInto(c.ctxMax, k, v);
}

export function mergeCell(into, c) {
  for (const [t, k] of Object.entries(c.n)) into.n[t] = (into.n[t] || 0) + k;
  for (const [name, k] of Object.entries(c.ev || {})) countName(into.ev, name, k, MAX_EVENT_NAMES);
  for (const [key, k] of Object.entries(c.evv || {})) countName(into.evv, key, k, MAX_EVENT_VALUES);
  if (c.t0 != null && (into.t0 == null || c.t0 < into.t0)) into.t0 = c.t0;
  into.fw += c.fw;
  into.frames += c.frames;
  into.hitches += c.hitches;
  into.frozen += c.frozen;
  into.sec += c.sec;
  mergeSketch(into.ft, c.ft);
  for (const [v, k] of Object.entries(c.budgets)) into.budgets[v] = (into.budgets[v] || 0) + k;
  for (const f of ['calls', 'render', 'tris', 'geo', 'heap']) {
    into[f][0] += c[f][0];
    into[f][1] += c[f][1];
  }
  if (c.callsMax > into.callsMax) into.callsMax = c.callsMax;
  if (c.geoMax > into.geoMax) into.geoMax = c.geoMax;
  for (const [k, v] of Object.entries(c.ctxMax)) maxInto(into.ctxMax, k, v);
  return into;
}

// Merge without Sketch.toJSON(), which rounds min and max.
export function mergeSketch(into, s) {
  return into.merge(s instanceof Sketch ? sketchState(s) : s);
}

export function cellToJSON(c) {
  return { ...c, ft: sketchState(c.ft) };
}

export function cellFromJSON(o) {
  return { ...newCell(), ...o, ft: Sketch.from(o.ft) };
}

// Merge one cell into minutes (taking ownership of `c` when the minute has no such cell yet).
export function addCell(minutes, m, c) {
  let cells = minutes.get(m);
  if (!cells) minutes.set(m, (cells = new Map()));
  const key = cellKey(c.env, c.version, c.level);
  const have = cells.get(key);
  if (have) mergeCell(have, c);
  else cells.set(key, c);
}

// Minutes → [{ m, c }], optionally keeping only cells that pass `keep`.
export function cellList(minutes, keep = null) {
  const out = [];
  for (const [m, cells] of minutes) for (const c of cells.values()) if (!keep || keep(c)) out.push({ m, c });
  return out;
}

// The median frame budget, exactly as median() over every window's budget_ms would give it.
export function budgetMedian(budgets) {
  const values = Object.keys(budgets).map(Number).sort((a, b) => a - b);
  const total = values.reduce((a, v) => a + budgets[v], 0);
  if (!total) return null;
  const idx = Math.min(total - 1, Math.floor(0.5 * total));
  let acc = 0;
  for (const v of values) {
    acc += budgets[v];
    if (acc > idx) return Math.round(v * 100) / 100;
  }
  return null;
}

// Mean of a fixed-point [sum, count] pair, or null when nothing was counted.
export function meanOf([sum, n], scale) {
  return n ? sum / scale / n : null;
}

export function seconds(c) {
  return c.sec / FIXED.sec;
}

export function minuteOf(ts) {
  return Math.floor(ts / MINUTE) * MINUTE;
}

// A custom event's name as the queries key it.
export function eventName(name) {
  return String(name).slice(0, 64);
}

// The attributes counts and breakdowns use: strings (shortened), booleans and finite numbers, at most
// ATTRS.keys of them. Nested objects and lists are left out.
export function smallAttrs(attrs) {
  const out = {};
  if (!attrs || typeof attrs !== 'object') return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (Object.keys(out).length >= ATTRS.keys) break;
    if (typeof v === 'string') out[k] = v.slice(0, ATTRS.valueLength);
    else if (typeof v === 'boolean' || isNum(v)) out[k] = v;
  }
  return out;
}

// evv's key for one attribute value of a named event, and back.
export function attrKey(name, key, value) {
  return `${name}${SEP}${key}${SEP}${String(value)}`;
}

export function splitAttrKey(k) {
  const [name, key, ...rest] = k.split(SEP);
  return { name, key, value: rest.join(SEP) };
}

function countName(counts, name, k, cap) {
  const key = name in counts || Object.keys(counts).length < cap ? name : OTHER;
  counts[key] = (counts[key] || 0) + k;
}

function cellKey(env, version, level) {
  return JSON.stringify([env ?? null, version ?? null, level]);
}

function sketchState(s) {
  return { a: s.a, b: Object.fromEntries(s.bins), n: s.n, z: s.zeros, s: s.sum, mn: s.n ? s.min : null, mx: s.n ? s.max : null };
}

function addPair(pair, v, scale) {
  if (!isNum(v)) return;
  pair[0] += fixed(v, scale);
  pair[1]++;
}

function maxInto(obj, k, v) {
  const x = Math.max(obj[k] ?? 0, v);
  if (!Number.isNaN(x)) obj[k] = x;
}

function fixed(v, scale) {
  return Math.round(v * scale);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
