// Per-session state: what every query needs to know about one session, folded from its events.
//
// The state is mergeable: folding a session's events in two parts and merging the two states gives the
// same state as folding all of them in order. So the raw path (indexSessions over the events of a range)
// and a store that keeps one state per session and minute (or hour) and merges the ones inside a range
// give identical sessions. Fields that depend on event order ("the last session_start", "the first frame
// window with geometries") keep the timestamp they were set at, and level/death events are kept as a list
// (`marks`) so the rage-quit state machine runs over them in order after merging.
//
// finalizeSession() then derives the fields the queries read (levels, attempts, last_fail, duration_s,
// rage_quit, crashed, p50/p95…), the same fields and values indexSessions always produced.

import { Sketch } from '../../packages/sdk/src/sketch.js';
import { newCell, addEvent, mergeCell, cellToJSON, cellFromJSON, minuteOf, eventName, smallAttrs, MINUTE, OTHER, ATTRS } from './rollups.js';

// 'script' is a Godot GDScript runtime error, an Unreal Blueprint runtime error, and 'exception' an
// unhandled Unity exception: the function stops part way, like an uncaught JS exception.
// 'game_loop_stopped' is a Phaser or Babylon.js game whose loop died on an uncaught error: the screen froze, so the
// session crashed whatever the player did next. 'crash' is a game that died (the Unreal plugin writes it
// down as the game goes and sends it on the next launch). An Unreal 'ensure' is an error, not fatal.
export const FATAL_KINDS = new Set(['js', 'promise', 'webgl_context_lost', 'script', 'exception', 'game_loop_stopped', 'crash']);
const UNHANDLED_KINDS = new Set(['js', 'promise', 'script', 'exception', 'crash']);
const HALT_KINDS = new Set(['game_loop_stopped', 'crash']);
const RAGE_QUIT_WINDOW_MS = 20_000;
const CRASH_WINDOW_MS = 10_000;
const NODE_COUNTS = ['nodes', 'orphan_nodes'];
// Custom events the SDKs send by themselves: not the game being played (see last_play).
const SDK_CUSTOM = new Set(['rage_input', 'screen_change', 'app_resume', 'webgl_context_restored', 'annotation', 'assets_loaded']);
// Context gauges (setContext) followed per session, to find counts that keep climbing (a leak). They are
// the game's own words, so capped.
const GAUGE_KEYS = 16;
// A gauge climbs when it ends within this share of its peak and its low point (the last time it was
// there) comes in the first half of its course: enemies go back to none between waves, a leak doesn't.
// Kept as first, last, peak and low point so states merge the same in any order.
const GAUGE_PEAK = 0.9;
const GAUGE_WINDOWS = 3; // frame windows (about 15 s) before a gauge's course says anything
const GAUGE_CLIMB = 50; // and how far it must climb, at least, to be a leak rather than a few objects

// Level and death events, in order: { ts, k: kind, level, cause, x, y, z, d: duration_s } (objects, so a
// missing field stays missing through JSON). An abandon is the player leaving a level before it ended
// (`level_abandon`, or a `level_fail` with the reserved cause `abandon`, SPEC §2): never a fail.
export const MARK = { start: 0, complete: 1, fail: 2, death: 3, abandon: 4 };
const MARK_OF = { level_start: MARK.start, level_complete: MARK.complete, level_fail: MARK.fail, death: MARK.death, level_abandon: MARK.abandon };
export const ABANDON_CAUSE = 'abandon';

// Custom events (`custom`, the game's own metrics), per name: { n, o, a }. n counts them; o holds the
// earliest occurrences as [ts, attrs], for ordered funnels; a counts each attribute's values as
// { v: { value: count }, s, c } (s and c sum numeric values, fixed point, for an average). Names, keys
// and values are the game's own words, so each is capped; past a cap the counts stay right but the
// detail goes under OTHER, and only the first EV.occurrences of a name take part in funnels.
export const EV = { names: 64, occurrences: 16, keys: ATTRS.keys, values: 40, scale: 1e3 };

export function newSession(e) {
  return {
    session_id: e.session_id,
    player_id: e.player_id,
    service: e.service,
    env: e.env,
    version: e.version,
    sdk: e.sdk ?? null,
    idAt: e.ts, // ts of the event the identity fields above came from (the session's first)
    idOrder: e.__order ?? null, // its arrival order, when a store knows it (orders sessions on ties)
    first_ts: e.ts,
    last_ts: e.ts,
    startAt: null, // last session_start: ts, device, session_type
    device: null,
    session_type: 'user',
    endAt: null, // last session_end: ts, end_reason (set with it)
    marks: [],
    errors: 0,
    fatal_errors: 0,
    last_unhandled: null,
    halted: false, // the game stopped running (see HALT_KINDS)
    last_play: null, // ts of the last thing the game did (a level, a death, one of its own events)
    fwAt: null, // ts of the latest frame window, and whether it had a frozen frame
    fwFrozen: false,
    ctxAt: null, // last webgl context loss or restore
    context_lost: false,
    rage_inputs: 0,
    annotations: [],
    ev: {},
    hitches: 0,
    frozen: 0,
    frames: 0,
    cell: newCell(), // this session's frame windows, for device breakdowns and its own p50/p95
    geo: null, // { first, firstAt, last, lastAt, max }
    tex: null, // textures, the same shape as geo
    gauges: {}, // { [key]: { first, firstAt, last, lastAt, max, min, minAt, windows } }
    nodes: {}, // { [key]: { first, firstAt, last, lastAt } }
    ttffAt: null,
    ttff: null,
    first_launch: null, // the load's first_launch: the first launch of this version on the device (engine SDKs)
    ttpAt: null,
    ttp: null,
    fwLevels: new Set(), // levels this session sent frame windows on (null for menus)
    minutes: new Set(), // minutes with any event, for players per time bucket
  };
}

export function addToSession(s, e) {
  if (e.ts < s.first_ts) s.first_ts = e.ts;
  if (e.ts > s.last_ts) s.last_ts = e.ts;
  s.minutes.add(minuteOf(e.ts));
  switch (e.type) {
    case 'session_start':
      s.startAt = e.ts;
      s.device = e.device || null;
      s.session_type = e.session_type || 'user';
      break;
    case 'session_end':
      s.endAt = e.ts;
      s.end_reason = e.reason;
      break;
    case 'level_start':
    case 'level_complete':
    case 'level_fail':
      if (e.type === 'level_fail' && e.cause === ABANDON_CAUSE) {
        s.marks.push({ ts: e.ts, k: MARK.abandon, level: e.level, d: e.duration_s });
        break;
      }
      s.marks.push({ ts: e.ts, k: MARK_OF[e.type], level: e.level, cause: e.cause, d: e.duration_s });
      played(s, e.ts);
      break;
    // Not play: the SDKs send it themselves when the game goes to the background or closes mid-level.
    case 'level_abandon':
      s.marks.push({ ts: e.ts, k: MARK.abandon, level: e.level, d: e.duration_s });
      break;
    case 'death':
      s.marks.push({ ts: e.ts, k: MARK.death, level: e.level, cause: e.cause, x: e.x, y: e.y, z: e.z });
      played(s, e.ts);
      break;
    case 'error':
      s.errors++;
      if (FATAL_KINDS.has(e.kind)) s.fatal_errors++;
      if (e.kind === 'webgl_context_lost') setContext(s, e.ts, true);
      if (UNHANDLED_KINDS.has(e.kind)) s.last_unhandled = e.ts;
      if (HALT_KINDS.has(e.kind)) s.halted = true;
      break;
    case 'custom':
      if (e.name === 'webgl_context_restored') setContext(s, e.ts, false);
      if (e.name === 'rage_input') s.rage_inputs++;
      if (e.name === 'annotation') s.annotations.push({ ts: e.ts, note: e.attrs?.note });
      if (!SDK_CUSTOM.has(e.name)) played(s, e.ts);
      addCustom(s, e);
      break;
    case 'frame_window':
      addEvent(s.cell, e);
      s.frames += e.frames || 0;
      s.hitches += e.hitches || 0;
      s.frozen += e.frozen || 0;
      s.fwLevels.add(e.level);
      if (s.fwAt == null || e.ts >= s.fwAt) [s.fwAt, s.fwFrozen] = [e.ts, (e.frozen || 0) > 0];
      if (e.geometries != null) s.geo = addCount(s.geo, e.geometries, e.ts);
      if (isNum(e.textures)) s.tex = addCount(s.tex, e.textures, e.ts);
      for (const [k, v] of Object.entries(e.ctx || {})) {
        if (!isNum(v)) continue;
        if (s.gauges[k]) s.gauges[k] = mergeGauge(s.gauges[k], gaugeAt(v, e.ts));
        else if (Object.keys(s.gauges).length < GAUGE_KEYS) s.gauges[k] = gaugeAt(v, e.ts);
      }
      // The Godot SDK sends scene-tree counts instead of three.js geometries.
      for (const k of NODE_COUNTS) {
        if (!isNum(e[k])) continue;
        const n = (s.nodes[k] ||= { first: e[k], firstAt: e.ts });
        n.last = e[k];
        n.lastAt = e.ts;
      }
      break;
    case 'load':
      if (e.ttff_ms != null) [s.ttffAt, s.ttff, s.first_launch] = [e.ts, e.ttff_ms, typeof e.first_launch === 'boolean' ? e.first_launch : null];
      if (e.ttp_ms != null) [s.ttpAt, s.ttp] = [e.ts, e.ttp_ms];
      break;
  }
  return s;
}

function played(s, ts) {
  if (s.last_play == null || ts > s.last_play) s.last_play = ts;
}

// A count that is read once per frame window (geometries, textures): its first, last and highest value.
function addCount(c, v, ts) {
  if (!c) return { first: v, firstAt: ts, last: v, lastAt: ts, max: Math.max(0, v) };
  [c.last, c.lastAt, c.max] = [v, ts, Math.max(c.max, v)];
  return c;
}

function mergeCount(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  if (b.firstAt < a.firstAt) [a.first, a.firstAt] = [b.first, b.firstAt];
  if (b.lastAt >= a.lastAt) [a.last, a.lastAt] = [b.last, b.lastAt];
  a.max = Math.max(a.max, b.max);
  return a;
}

// One frame window's value of a gauge, and two parts of a gauge's course merged: the earliest value, the
// latest (the later part on a tie), the peak, and the low point with the last time it was there.
function gaugeAt(v, ts) {
  return { first: v, firstAt: ts, last: v, lastAt: ts, max: v, min: v, minAt: ts, windows: 1 };
}

function mergeGauge(a, b) {
  const [first, firstAt] = b.firstAt < a.firstAt ? [b.first, b.firstAt] : [a.first, a.firstAt];
  const [last, lastAt] = b.lastAt >= a.lastAt ? [b.last, b.lastAt] : [a.last, a.lastAt];
  const [min, minAt] = b.min < a.min ? [b.min, b.minAt] : a.min < b.min ? [a.min, a.minAt] : [a.min, Math.max(a.minAt, b.minAt)];
  return { first, firstAt, last, lastAt, max: Math.max(a.max, b.max), min, minAt, windows: a.windows + b.windows };
}

function setContext(s, ts, lost) {
  s.ctxAt = ts;
  s.context_lost = lost;
}

function addCustom(s, e) {
  if (typeof e.name !== 'string' || !e.name) return;
  const name = eventName(e.name);
  let v = s.ev[name];
  if (!v) {
    if (Object.keys(s.ev).length >= EV.names) return;
    v = s.ev[name] = { n: 0, o: [], a: {} };
  }
  const attrs = smallAttrs(e.attrs);
  v.n++;
  v.o = mergeByTs(v.o, [[e.ts, attrs]], (x) => x[0]).slice(0, EV.occurrences);
  for (const [k, value] of Object.entries(attrs)) countAttr(v.a, k, { v: { [String(value)]: 1 }, ...(typeof value === 'number' ? { s: Math.round(value * EV.scale), c: 1 } : {}) });
}

// Add one attribute's counts ({ v, s, c }) into a name's attributes.
function countAttr(a, key, add) {
  let t = a[key];
  if (!t) {
    if (Object.keys(a).length >= EV.keys) return;
    t = a[key] = { v: {} };
  }
  for (const [value, k] of Object.entries(add.v)) {
    const label = value in t.v || Object.keys(t.v).length < EV.values ? value : OTHER;
    t.v[label] = (t.v[label] || 0) + k;
  }
  if (add.c) {
    t.s = (t.s || 0) + add.s;
    t.c = (t.c || 0) + add.c;
  }
}

function mergeCustom(a, b) {
  for (const [name, bv] of Object.entries(b || {})) {
    let av = a[name];
    if (!av) {
      if (Object.keys(a).length >= EV.names) continue;
      av = a[name] = { n: 0, o: [], a: {} };
    }
    av.n += bv.n;
    av.o = mergeByTs(av.o, bv.o, (x) => x[0]).slice(0, EV.occurrences);
    for (const [k, t] of Object.entries(bv.a)) countAttr(av.a, k, t);
  }
}

// Merge `b` into `a`. Where both set an order-dependent field, the later timestamp wins, and on a tie
// `b` (merge later states as `b`: they hold events that arrived later).
export function mergeSession(a, b) {
  if (b.idAt < a.idAt) for (const k of ['session_id', 'player_id', 'service', 'env', 'version', 'sdk', 'idAt', 'idOrder']) a[k] = b[k];
  if (b.first_ts < a.first_ts) a.first_ts = b.first_ts;
  if (b.last_ts > a.last_ts) a.last_ts = b.last_ts;
  if (b.startAt != null && (a.startAt == null || b.startAt >= a.startAt)) {
    a.startAt = b.startAt;
    a.device = b.device;
    a.session_type = b.session_type;
  }
  if (b.endAt != null && (a.endAt == null || b.endAt >= a.endAt)) {
    a.endAt = b.endAt;
    a.end_reason = b.end_reason;
  }
  a.marks = mergeByTs(a.marks, b.marks, (m) => m.ts);
  a.errors += b.errors;
  a.fatal_errors += b.fatal_errors;
  if (b.last_unhandled != null && (a.last_unhandled == null || b.last_unhandled > a.last_unhandled)) a.last_unhandled = b.last_unhandled;
  if (b.ctxAt != null && (a.ctxAt == null || b.ctxAt >= a.ctxAt)) setContext(a, b.ctxAt, b.context_lost);
  a.halted = !!(a.halted || b.halted);
  if (b.last_play != null && (a.last_play == null || b.last_play > a.last_play)) a.last_play = b.last_play;
  if (b.fwAt != null && (a.fwAt == null || b.fwAt >= a.fwAt)) [a.fwAt, a.fwFrozen] = [b.fwAt, b.fwFrozen];
  a.rage_inputs += b.rage_inputs;
  a.annotations = mergeByTs(a.annotations, b.annotations, (x) => x.ts);
  mergeCustom((a.ev ||= {}), b.ev);
  a.hitches += b.hitches;
  a.frozen += b.frozen;
  a.frames += b.frames;
  mergeCell(a.cell, b.cell);
  a.geo = mergeCount(a.geo, b.geo);
  a.tex = mergeCount(a.tex, b.tex);
  for (const [k, g] of Object.entries(b.gauges || {})) {
    if (a.gauges[k]) a.gauges[k] = mergeGauge(a.gauges[k], g);
    else if (Object.keys(a.gauges).length < GAUGE_KEYS) a.gauges[k] = { ...g };
  }
  for (const [k, n] of Object.entries(b.nodes)) {
    const m = a.nodes[k];
    if (!m) a.nodes[k] = { ...n };
    else {
      if (n.firstAt < m.firstAt) [m.first, m.firstAt] = [n.first, n.firstAt];
      if (n.lastAt >= m.lastAt) [m.last, m.lastAt] = [n.last, n.lastAt];
    }
  }
  if (b.ttffAt != null && (a.ttffAt == null || b.ttffAt >= a.ttffAt)) [a.ttffAt, a.ttff, a.first_launch] = [b.ttffAt, b.ttff, b.first_launch ?? null];
  if (b.ttpAt != null && (a.ttpAt == null || b.ttpAt >= a.ttpAt)) [a.ttpAt, a.ttp] = [b.ttpAt, b.ttp];
  for (const l of b.fwLevels) a.fwLevels.add(l);
  for (const m of b.minutes) a.minutes.add(m);
  return a;
}

// Derive what the queries read. Safe to call once per state; merge before finalizing.
export function finalizeSession(s) {
  s.start = s.startAt;
  s.end = s.endAt;
  s.ended = s.endAt != null;
  s.levels = new Set();
  s.completed = new Set();
  s.attempts = {};
  s.level_loads = 0;
  s.completes = 0;
  s.fails = 0;
  s.deaths = 0;
  s.last_fail = null;
  // Abandons per level. One counts once its attempt is over (the next level_start, or the session's end); if the
  // level goes on instead (a complete, fail or death on it: the player came back from the background and played
  // on), the SDK's abandon was early and is dropped. Two in a row before anything else are one.
  s.abandons = 0;
  s.abandoned = {};
  const pending = new Set();
  const settle = (level) => {
    if (!pending.delete(level)) return;
    s.abandons++;
    s.abandoned[level] = (s.abandoned[level] || 0) + 1;
  };
  for (const { ts, k: kind, level, cause, x, y, z } of s.marks) {
    if (kind === MARK.abandon) {
      pending.add(level);
      continue;
    }
    if (kind === MARK.start) settle(level);
    else pending.delete(level);
    if (kind === MARK.start) {
      s.levels.add(level);
      s.attempts[level] = (s.attempts[level] || 0) + 1;
      s.level_loads++;
      s.last_fail = null;
    } else if (kind === MARK.complete) {
      s.completed.add(level);
      s.completes++;
      s.last_fail = null;
    } else if (kind === MARK.fail) {
      s.fails++;
      // A fail takes its place from the death before it; `dts` says which death that was, so a rage quit
      // can be put on the map where it happened even when the game sent a level_fail after the death.
      s.last_fail = { ts, level, cause, x: s.last_fail?.x, y: s.last_fail?.y, z: s.last_fail?.z, dts: s.last_fail?.dts };
    } else if (kind === MARK.death) {
      s.deaths++;
      s.last_fail = { ts, level, cause, x, y, z, dts: ts };
    }
  }
  for (const level of [...pending]) settle(level);
  s.sketch = s.cell.ft;
  s.geo_first = s.geo ? s.geo.first : null;
  s.geo_last = s.geo ? s.geo.last : null;
  s.geo_max = s.geo ? s.geo.max : null;
  s.tex_first = s.tex ? s.tex.first : null;
  s.tex_last = s.tex ? s.tex.last : null;
  // Gauges followed long enough to judge, and those that only climbed: ending at their peak, far above where
  // they started, without going back to their low after the first half. Enemies come and go; a leak grows.
  s.gauge_seen = [];
  s.gauge_climbs = {};
  for (const [k, g] of Object.entries(s.gauges || {})) {
    if (g.windows < GAUGE_WINDOWS) continue;
    s.gauge_seen.push(k);
    const lowEarly = g.minAt - g.firstAt <= (g.lastAt - g.firstAt) / 2;
    if (lowEarly && g.last >= g.max * GAUGE_PEAK && g.last >= Math.max(g.first * 4, g.first + GAUGE_CLIMB)) s.gauge_climbs[k] = { first: g.first, last: g.last };
  }
  s.node_counts = Object.fromEntries(Object.entries(s.nodes).map(([k, n]) => [k, { first: n.first, last: n.last }]));
  const start = s.start ?? s.first_ts;
  const end = s.end ?? s.last_ts;
  s.duration_s = Math.max(0, (end - start) / 1000);
  // The end has to come after the fail: a fail the game logged as it closed, after the session had ended (a
  // level torn down as the app quits), is not the player quitting in anger.
  s.rage_quit = !!(s.ended && s.last_fail && s.last_fail.ts <= end && end - s.last_fail.ts <= RAGE_QUIT_WINDOW_MS);
  s.rage = s.rage_quit ? s.last_fail : null;
  // Game-aware crash: the run actually broke. The WebGL context was lost for good, the game loop stopped,
  // the session ended inside a frozen frame, or an unhandled error came right before the end with nothing
  // played after it. A long frame the game recovered from (a shader compile, a level load) is a hitch, and
  // an error the player kept playing through (a weapon that throws on some shots) didn't end the session.
  const brokeAtEnd = !!(s.last_unhandled && s.ended && end - s.last_unhandled <= CRASH_WINDOW_MS && !(s.last_play > s.last_unhandled));
  s.crashed = s.context_lost || !!s.halted || !!(s.ended && s.fwFrozen) || brokeAtEnd;
  s.p95 = s.sketch.quantile(0.95);
  s.p50 = s.sketch.quantile(0.5);
  return s;
}

// Fold events into one state per session (keyed by session_id), in the order given.
export function foldSessions(events, into = new Map()) {
  for (const e of events) {
    let s = into.get(e.session_id);
    if (!s) into.set(e.session_id, (s = newSession(e)));
    addToSession(s, e);
  }
  return into;
}

// Storage form: plain JSON, sets as arrays, minutes as offsets from the first one.
export function sessionToJSON(s) {
  const { cell, fwLevels, minutes, ...rest } = s;
  const mins = [...minutes].sort((x, y) => x - y);
  return { ...rest, cell: cellToJSON(cell), fwLevels: [...fwLevels], m0: mins[0] ?? null, mins: mins.map((m) => (m - mins[0]) / MINUTE) };
}

export function sessionFromJSON(o) {
  const { cell, fwLevels, m0, mins, ...rest } = o;
  return {
    ...rest,
    gauges: o.gauges || {},
    marks: o.marks || [],
    annotations: o.annotations || [],
    ev: o.ev || {},
    nodes: o.nodes || {},
    cell: cellFromJSON(cell),
    fwLevels: new Set(fwLevels),
    minutes: new Set((mins || []).map((d) => m0 + d * MINUTE)),
  };
}

// Merge two lists already sorted by `key`, keeping `a` first on ties.
function mergeByTs(a, b, key) {
  if (!b.length) return a;
  if (!a.length) return b.slice();
  if (key(a[a.length - 1]) <= key(b[0])) return a.concat(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(key(b[j]) < key(a[i]) ? b[j++] : a[i++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export { Sketch };
