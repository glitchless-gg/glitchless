// Per-minute rollups: what the overview, performance and versions queries need from frame windows and
// event counts, pre-aggregated per (env, version, level) and minute of one service, and per zone where the game
// sets one (decision 6: `setZone`; a game without zones has the same cells as before).
//
// Stores fold events in as they arrive (rollup()), and queries merge the stored minutes that lie fully
// inside the asked range, folding raw events only for the partial minutes at its edges. Queries without
// stored rollups fold every raw event the same way, so both paths give identical numbers. Sums are kept
// in fixed point so that the order events arrive in never changes a total.

import { Sketch } from '../../packages/sdk/src/sketch.js';

export const MINUTE = 60_000;

// Fixed-point scales for summed fields: integers add exactly in any order.
export const FIXED = { sec: 1e6, render: 1e6, heap: 1e6, calls: 1e3, tris: 1, geo: 1, ev: 1e3, net: 1e3 };
// Network quality (A8, SPEC §2 frame_window.net): the round-trip sketch's relative accuracy (as the SDKs send it), and
// the round trip over which a connected player's time counts as lag.
export const NET_ALPHA = 0.05;
export const LAG_MS = 150;

// Custom event names, attribute keys and values are the game's own, so a cell counts at most this many
// names (ev) and name × attribute × value triples (evv); the rest go under OTHER.
export const MAX_EVENT_NAMES = 200;
export const MAX_EVENT_VALUES = 400;
// Numeric attributes of custom events are summed as well (revenue, coins, seconds…) as [sum, events]: per
// name, attribute and currency in evs, and per string or boolean attribute value of the event too in evx
// (revenue by item); at most this many of each per cell. An event's `currency` attribute (the purchase convention)
// keeps each currency's sums apart; events without one sum under ''. See sumKey. A sandbox purchase (an event named
// purchase, or with a currency, that says sandbox: true: TestFlight, Xcode, a store's test account) is counted but
// never summed: nobody paid for it.
export const MAX_EVENT_SUMS = 400;
// Rates (evb, [trues, events]): per name and boolean attribute, and per string or boolean value of the same event,
// keyed as evx's sums are (sumKey with currency ''); MAX_EVENT_SUMS of them per cell.
// Lists (a deck, a build: SPEC §2 custom) count each element apart from evv, so a game with 120 cards doesn't push its
// other attributes past their cap: evl counts events per name, list attribute and element (attrKey), evlb and evlx
// their rates and sums per element (sumKey with the list and element as the group); MAX_LIST_VALUES of each per cell.
export const MAX_LIST_VALUES = 1000;
// Distributions (evq): per name and numeric attribute, a sketch of its values (DIST_ALPHA relative accuracy; see
// distAdd); MAX_DISTS per cell. Values past the cap count in evqc per name, and the event's distribution says partial.
export const MAX_DISTS = 32;
export const DIST_ALPHA = 0.05;
export const OTHER = '(other)';
// The attributes of a custom event that counts and breakdowns use (see smallAttrs); a list keeps its first `list`
// distinct elements.
export const ATTRS = { keys: 12, valueLength: 64, list: 16 };
const SEP = '\u0001';

// One cell: n counts events by type, ev custom events by name and evv by name, attribute and value (keys
// joined by SEP; see attrKey), evs and evx sum numeric attributes (MAX_EVENT_SUMS), evb counts booleans, evl, evlb
// and evlx count list elements, evq sketches numbers, and evk counts the events that came from counters (only cells
// that have some carry each); the rest covers frame windows only. t0 is the first frame window's ts, which orders
// versions and levels the way the raw events would.
export function newCell(env = null, version = null, level = null, zone = null) {
  return {
    env,
    version,
    level,
    ...(zone != null ? { zone } : {}),
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
    // Frames slower than 1.15× their own window's budget_ms: each screen against its own refresh rate (a 60 Hz
    // phone's 16.7ms frames are on time next to 120 Hz ones), counted per window so cells merge exactly.
    over: 0,
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
    const key = cellKey(e.env, e.version, level, e.zone);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = newCell(e.env ?? null, e.version ?? null, level, e.zone ?? null)));
    addEvent(c, e);
  }
  return minutes;
}

export function addEvent(c, e) {
  c.n[e.type] = (c.n[e.type] || 0) + 1;
  if (e.type === 'counts') return addCounts(c, e);
  if (e.type === 'disconnect') return addDisconnect(c, e);
  if (e.type === 'server_window') return addServerWindow(c, e);
  if (e.type === 'reconnect') return void (netOf(c).rc += 1);
  if (e.type === 'custom' && typeof e.name === 'string' && e.name) {
    const name = eventName(e.name);
    countName(c.ev, name, 1, MAX_EVENT_NAMES);
    const attrs = smallAttrs(e.attrs);
    for (const [k, v] of Object.entries(attrs)) {
      if (Array.isArray(v)) for (const x of v) countName((c.evl ??= {}), attrKey(name, k, x), 1, MAX_LIST_VALUES);
      else countName(c.evv, attrKey(name, k, v), 1, MAX_EVENT_VALUES);
    }
    const currency = currencyOf(e.attrs);
    if (!isSandboxPurchase(name, e.attrs, currency)) addSums(c, name, attrs, currency);
    addRates(c, name, attrs);
    addDists(c, name, attrs);
  }
  if (e.type !== 'frame_window') return;
  if (c.t0 == null || e.ts < c.t0) c.t0 = e.ts;
  c.fw++;
  if (isNum(e.frames)) c.frames += e.frames;
  if (isNum(e.hitches)) c.hitches += e.hitches;
  if (isNum(e.frozen)) c.frozen += e.frozen;
  if (isNum(e.duration_s)) c.sec += fixed(e.duration_s, FIXED.sec);
  if (e.ft) {
    c.ft.merge(e.ft);
    c.over += framesOver(Sketch.from(e.ft), isNum(e.budget_ms) && e.budget_ms ? e.budget_ms : 1000 / 60);
  }
  if (isNum(e.budget_ms) && e.budget_ms) c.budgets[e.budget_ms] = (c.budgets[e.budget_ms] || 0) + 1;
  addPair(c.calls, e.draw_calls, FIXED.calls);
  if (isNum(e.draw_calls_max) && e.draw_calls_max > c.callsMax) c.callsMax = e.draw_calls_max;
  addPair(c.render, e.render_ms, FIXED.render);
  addPair(c.tris, e.triangles, FIXED.tris);
  addPair(c.geo, e.geometries, FIXED.geo);
  if (isNum(e.geometries) && e.geometries > c.geoMax) c.geoMax = e.geometries;
  addPair(c.heap, e.heap_mb, FIXED.heap);
  for (const [k, v] of Object.entries(e.ctx || {})) maxInto(c.ctxMax, k, v);
  if (e.net && typeof e.net === 'object') addNet(c, e.net, e.duration_s);
}

// ── network quality (A8) ──
//
// A cell's `net` (only cells with network data have one): the round trips of the windows players were connected in
// (a sketch at NET_ALPHA; a listen-server host's own windows are left out, its round trip is zero), seconds connected
// (`sec`) and seconds with samples (`ssec`), seconds over LAG_MS (`lag`: each window's share of samples over it times
// its length), loss and jitter weighted by samples ([sum, samples], fixed point), throughput ([sum, windows]), windows
// per kind of connection (`links`), and disconnects by reason (`dc`) and reconnects (`rc`). All of it adds up exactly.
export function newNet() {
  return { rtt: new Sketch(NET_ALPHA), sec: 0, ssec: 0, lag: 0, loss: [0, 0], jitter: [0, 0], kin: [0, 0], kout: [0, 0], w: 0, host: 0, links: {}, dc: {}, rc: 0 };
}

function netOf(c) {
  return (c.net ??= newNet());
}

function addNet(c, net, duration) {
  const x = netOf(c);
  const sec = isNum(duration) ? duration : 0;
  x.w++;
  x.sec += fixed(sec, FIXED.sec);
  if (typeof net.link === 'string' && ['wifi', 'cellular', 'wired'].includes(net.link)) x.links[net.link] = (x.links[net.link] || 0) + 1;
  if (net.host === true) {
    x.host++;
    return;
  }
  const samples = isNum(net.samples) ? net.samples : 0;
  if (net.rtt && typeof net.rtt === 'object' && net.rtt.n) {
    const sk = Sketch.from(net.rtt);
    x.rtt.merge(net.rtt);
    x.ssec += fixed(sec, FIXED.sec);
    x.lag += fixed(sk.fractionAbove(LAG_MS) * sec, FIXED.sec);
  }
  if (isNum(net.loss_pct) && samples) addPair(x.loss, net.loss_pct * samples, FIXED.net, samples);
  if (isNum(net.jitter_ms) && samples) addPair(x.jitter, net.jitter_ms * samples, FIXED.net, samples);
  if (isNum(net.in_kbps)) addPair(x.kin, net.in_kbps, FIXED.net);
  if (isNum(net.out_kbps)) addPair(x.kout, net.out_kbps, FIXED.net);
}

function addDisconnect(c, e) {
  const x = netOf(c);
  const reason = typeof e.reason === 'string' ? e.reason.slice(0, 24) : 'other';
  x.dc[reason] = (x.dc[reason] || 0) + 1;
}

// ── a game's servers (A9) ──
//
// A server session (filed under the game's companion service, `<service>.server`) sends a server_window every 5 s
// instead of frame windows. A cell's `sv` (only cells with server windows have one): windows, seconds, ticks and late
// ticks (over the budget), windows whose ticks were over budget 5% of the time or more (`over`: its p95 over budget),
// the ticks' sketch at 2%, players connected ([sum, windows] and the most), CPU, memory, the players' round trips as the
// server saw them and its networked objects ([sum, windows]; memory and objects also their highest), and windows per
// budget (budget_ms, where the SDK says it).
export function newServerCell() {
  return { w: 0, sec: 0, ticks: 0, late: 0, over: 0, tick: new Sketch(), players: [0, 0], pmax: 0, cpu: [0, 0], mem: [0, 0], mmax: 0, rtt: [0, 0], objs: [0, 0], omax: 0, budgets: {} };
}

// Whether a window's ticks were over budget: 5% or more of them late (its p95 over the budget).
export function overBudget(e) {
  return isNum(e.late) && isNum(e.ticks) && e.ticks > 0 && e.late / e.ticks >= 0.05;
}

function addServerWindow(c, e) {
  const x = (c.sv ??= newServerCell());
  x.w++;
  if (isNum(e.duration_s)) x.sec += fixed(e.duration_s, FIXED.sec);
  if (isNum(e.ticks)) x.ticks += e.ticks;
  if (isNum(e.late)) x.late += e.late;
  if (overBudget(e)) x.over++;
  if (e.tick && typeof e.tick === 'object') x.tick.merge(e.tick);
  addPair(x.players, e.players, 1);
  if (isNum(e.players_max) && e.players_max > x.pmax) x.pmax = e.players_max;
  addPair(x.cpu, e.cpu_pct, FIXED.net);
  addPair(x.mem, e.mem_mb, FIXED.net);
  if (isNum(e.mem_mb) && e.mem_mb > x.mmax) x.mmax = e.mem_mb;
  addPair(x.rtt, e.rtt_p95, FIXED.net);
  addPair(x.objs, e.net_objects, 1);
  if (isNum(e.net_objects) && e.net_objects > x.omax) x.omax = e.net_objects;
  if (isNum(e.budget_ms) && e.budget_ms > 0) x.budgets[e.budget_ms] = (x.budgets[e.budget_ms] || 0) + 1;
}

export function mergeServerCell(into, x) {
  if (!x) return into;
  for (const k of ['w', 'sec', 'ticks', 'late', 'over']) into[k] += x[k] || 0;
  into.tick.merge(x.tick instanceof Sketch ? sketchState(x.tick) : x.tick);
  for (const k of ['players', 'cpu', 'mem', 'rtt', 'objs']) {
    into[k][0] += x[k]?.[0] || 0;
    into[k][1] += x[k]?.[1] || 0;
  }
  for (const k of ['pmax', 'mmax', 'omax']) if ((x[k] || 0) > into[k]) into[k] = x[k];
  for (const [b, n] of Object.entries(x.budgets || {})) into.budgets[b] = (into.budgets[b] || 0) + n;
  return into;
}

export function mergeNet(into, n) {
  if (!n) return into;
  into.rtt.merge(n.rtt instanceof Sketch ? sketchState(n.rtt) : n.rtt);
  for (const k of ['sec', 'ssec', 'lag', 'w', 'host', 'rc']) into[k] += n[k] || 0;
  for (const k of ['loss', 'jitter', 'kin', 'kout']) {
    into[k][0] += n[k]?.[0] || 0;
    into[k][1] += n[k]?.[1] || 0;
  }
  for (const [k, v] of Object.entries(n.links || {})) into.links[k] = (into.links[k] || 0) + v;
  for (const [k, v] of Object.entries(n.dc || {})) into.dc[k] = (into.dc[k] || 0) + v;
  return into;
}

export function mergeCell(into, c) {
  for (const [t, k] of Object.entries(c.n)) into.n[t] = (into.n[t] || 0) + k;
  for (const [name, k] of Object.entries(c.ev || {})) countName(into.ev, name, k, MAX_EVENT_NAMES);
  for (const [key, k] of Object.entries(c.evv || {})) countName(into.evv, key, k, MAX_EVENT_VALUES);
  if (c.evk) for (const [name, k] of Object.entries(c.evk)) countName((into.evk ??= {}), name, k, MAX_EVENT_NAMES);
  if (c.evs) for (const [key, v] of Object.entries(c.evs)) addSum((into.evs ??= {}), key, v);
  if (c.evx) for (const [key, v] of Object.entries(c.evx)) addSum((into.evx ??= {}), key, v);
  if (c.evb) for (const [key, v] of Object.entries(c.evb)) addSum((into.evb ??= {}), key, v);
  if (c.evl) for (const [key, k] of Object.entries(c.evl)) countName((into.evl ??= {}), key, k, MAX_LIST_VALUES);
  if (c.evlb) for (const [key, v] of Object.entries(c.evlb)) addSum((into.evlb ??= {}), key, v, MAX_LIST_VALUES);
  if (c.evlx) for (const [key, v] of Object.entries(c.evlx)) addSum((into.evlx ??= {}), key, v, MAX_LIST_VALUES);
  if (c.evq) for (const [key, d] of Object.entries(c.evq)) mergeDist(into, key, d);
  if (c.evqc) for (const [name, k] of Object.entries(c.evqc)) (into.evqc ??= {})[name] = (into.evqc[name] || 0) + k;
  if (c.t0 != null && (into.t0 == null || c.t0 < into.t0)) into.t0 = c.t0;
  into.fw += c.fw;
  into.frames += c.frames;
  into.hitches += c.hitches;
  into.frozen += c.frozen;
  into.sec += c.sec;
  mergeSketch(into.ft, c.ft);
  into.over += c.over || 0;
  for (const [v, k] of Object.entries(c.budgets)) into.budgets[v] = (into.budgets[v] || 0) + k;
  for (const f of ['calls', 'render', 'tris', 'geo', 'heap']) {
    into[f][0] += c[f][0];
    into[f][1] += c[f][1];
  }
  if (c.callsMax > into.callsMax) into.callsMax = c.callsMax;
  if (c.geoMax > into.geoMax) into.geoMax = c.geoMax;
  for (const [k, v] of Object.entries(c.ctxMax)) maxInto(into.ctxMax, k, v);
  if (c.net) mergeNet(netOf(into), c.net);
  if (c.sv) mergeServerCell((into.sv ??= newServerCell()), c.sv);
  return into;
}

// Merge without Sketch.toJSON(), which rounds min and max.
export function mergeSketch(into, s) {
  return into.merge(s instanceof Sketch ? sketchState(s) : s);
}

export function cellToJSON(c) {
  return { ...c, ft: sketchState(c.ft), ...(c.net ? { net: { ...c.net, rtt: sketchState(c.net.rtt) } } : {}), ...(c.sv ? { sv: { ...c.sv, tick: sketchState(c.sv.tick) } } : {}) };
}

export function cellFromJSON(o) {
  const c = { ...newCell(), ...o, ft: Sketch.from(o.ft) };
  if (o.net) c.net = mergeNet(newNet(), o.net);
  if (o.sv) c.sv = mergeServerCell(newServerCell(), o.sv);
  // A cell stored before `over` was kept: its frames against its own median budget.
  if (o.over == null) c.over = framesOver(c.ft, budgetMedian(c.budgets) ?? 1000 / 60);
  return c;
}

// How many of a sketch's frames took over 1.15× the frame budget.
function framesOver(sketch, budget) {
  return Math.round(sketch.fractionAbove(budget * 1.15) * sketch.n);
}

// Merge one cell into minutes (taking ownership of `c` when the minute has no such cell yet).
export function addCell(minutes, m, c) {
  let cells = minutes.get(m);
  if (!cells) minutes.set(m, (cells = new Map()));
  const key = cellKey(c.env, c.version, c.level, c.zone);
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

// The attributes counts and breakdowns use: strings (shortened), booleans and finite numbers, and lists of them
// (their first ATTRS.list distinct elements, strings shortened), at most ATTRS.keys in all. Nested objects, and
// lists that hold objects or lists, are left out.
export function smallAttrs(attrs) {
  const out = {};
  if (!attrs || typeof attrs !== 'object') return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (Object.keys(out).length >= ATTRS.keys) break;
    const x = smallValue(v);
    if (x !== undefined) out[k] = x;
    else if (Array.isArray(v) && v.every((el) => smallValue(el) !== undefined)) out[k] = smallList(v);
  }
  return out;
}

function smallValue(v) {
  if (typeof v === 'string') return v.slice(0, ATTRS.valueLength);
  if (typeof v === 'boolean' || isNum(v)) return v;
  return undefined;
}

function smallList(list) {
  const seen = new Set();
  const out = [];
  for (const el of list) {
    const x = smallValue(el);
    if (seen.has(String(x))) continue;
    seen.add(String(x));
    out.push(x);
    if (out.length >= ATTRS.list) break;
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

// The sum of a numeric attribute (`sum`) of a named event in one currency: evs's key, and evx's with the
// event's attribute `key` = `value` in front (attrKey). And back: OTHER (past a cap) has no `sum`.
export function sumKey(name, sum, currency, key = null, value = null) {
  return `${key == null ? name : attrKey(name, key, value)}${SEP}${sum}${SEP}${currency}`;
}

export function splitSumKey(k) {
  const parts = k.split(SEP);
  if (parts.length < 3) return { name: parts[0] };
  const [name, ...rest] = parts;
  const currency = rest.pop();
  const sum = rest.pop();
  return rest.length ? { name, key: rest[0], value: rest.slice(1).join(SEP), sum, currency } : { name, sum, currency };
}

// The currency an event's amounts are in: its `currency` attribute, upper-cased ('' without one).
export function currencyOf(attrs) {
  const c = attrs?.currency;
  return typeof c === 'string' ? c.trim().toUpperCase().slice(0, 8) : '';
}

// A purchase made in a store's sandbox (SPEC §3b): free, so not revenue. Only money says so, so a game's own
// "sandbox" attribute on other events (a sandbox mode) keeps its sums.
export function isSandboxPurchase(name, attrs, currency = currencyOf(attrs)) {
  return attrs?.sandbox === true && (name === 'purchase' || currency !== '');
}

function addSums(c, name, attrs, currency) {
  const entries = Object.entries(attrs);
  for (const [k, v] of entries) {
    if (typeof v !== 'number') continue;
    const x = fixed(v, FIXED.ev);
    addSum((c.evs ??= {}), sumKey(name, k, currency), [x, 1]);
    eachGroup(entries, k, (g, gv, list) => (list ? addSum((c.evlx ??= {}), sumKey(name, k, currency, g, gv), [x, 1], MAX_LIST_VALUES) : addSum((c.evx ??= {}), sumKey(name, k, currency, g, gv), [x, 1])));
  }
}

// Each boolean attribute's [trues, events], overall and per value of the event's other string and boolean attributes
// (evb) and per element of its lists (evlb).
function addRates(c, name, attrs) {
  const entries = Object.entries(attrs);
  for (const [k, v] of entries) {
    if (typeof v !== 'boolean') continue;
    const x = v ? 1 : 0;
    addSum((c.evb ??= {}), sumKey(name, k, ''), [x, 1]);
    eachGroup(entries, k, (g, gv, list) => (list ? addSum((c.evlb ??= {}), sumKey(name, k, '', g, gv), [x, 1], MAX_LIST_VALUES) : addSum((c.evb ??= {}), sumKey(name, k, '', g, gv), [x, 1])));
  }
}

// A window's counters (SPEC §2 counts, A5): each entry folds in as `n` custom events with its words and flags would,
// its summed numbers as the sums of those n events. So a counter reads like any event (a count, a breakdown by its
// words, a sum per hour played, a rate of a flag), except a distribution: its values were added up on the device, so
// it has none. evk counts the events that came from counters, per name (the events query marks them `counted`).
function addCounts(c, e) {
  for (const entry of e.counts || []) {
    if (typeof entry?.name !== 'string' || !entry.name || !(entry.n >= 1)) continue;
    const name = eventName(entry.name);
    const n = entry.n;
    countName(c.ev, name, n, MAX_EVENT_NAMES);
    countName((c.evk ??= {}), name, n, MAX_EVENT_NAMES);
    const attrs = smallAttrs(entry.attrs);
    const entries = Object.entries(attrs);
    for (const [k, v] of entries) countName(c.evv, attrKey(name, k, v), n, MAX_EVENT_VALUES);
    const currency = currencyOf(attrs);
    if (!isSandboxPurchase(name, attrs, currency)) {
      for (const [k, v] of Object.entries(entry.sums || {})) {
        if (!isNum(v)) continue;
        const x = fixed(v, FIXED.ev);
        addSum((c.evs ??= {}), sumKey(name, k, currency), [x, n]);
        for (const [g, gv] of entries) addSum((c.evx ??= {}), sumKey(name, k, currency, g, gv), [x, n]);
      }
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'boolean') continue;
      const x = v ? n : 0;
      addSum((c.evb ??= {}), sumKey(name, k, ''), [x, n]);
      for (const [g, gv] of entries) if (g !== k) addSum((c.evb ??= {}), sumKey(name, k, '', g, gv), [x, n]);
    }
  }
}

// The groups a number or boolean of an event is counted under: each other string or boolean attribute's value, and
// each element of each list.
function eachGroup(entries, own, fn) {
  for (const [g, gv] of entries) {
    if (g === own || typeof gv === 'number') continue;
    if (Array.isArray(gv)) for (const el of gv) fn(g, el, true);
    else fn(g, gv, false);
  }
}

// Add [sum, events] under its key, or under OTHER once the map has `cap` keys.
function addSum(sums, key, [s, n], cap = MAX_EVENT_SUMS) {
  const k = key in sums || Object.keys(sums).length < cap ? key : OTHER;
  const have = sums[k];
  sums[k] = have ? [have[0] + s, have[1] + n] : [s, n];
}

// ── distributions (evq) ──
//
// A distribution is a plain, mergeable sketch of numbers, as JSON: { p, m, z, n, s, lo, hi, w }. p and m count
// positive and negative values in log buckets of DIST_ALPHA relative accuracy (about 23 a decade), z the values
// within 0.001 of zero, n all of them, and s adds them up in fixed point (for the mean); lo and hi are the smallest
// and largest, and w is 1 while every value is a whole number (placements, floors), 0 once one isn't. Everything adds
// up exactly, so cells merge the same in any order.
const DIST_GAMMA = (1 + DIST_ALPHA) / (1 - DIST_ALPHA);
const DIST_LN = Math.log(DIST_GAMMA);

export function distKey(name, attr) {
  return `${name}${SEP}${attr}`;
}

export function splitDistKey(k) {
  const [name, ...rest] = k.split(SEP);
  return { name, attr: rest.join(SEP) };
}

export function newDist() {
  return { p: {}, m: {}, z: 0, n: 0, s: 0, lo: null, hi: null, w: 1 };
}

export function distAdd(d, v, count = 1) {
  if (!isNum(v)) return d;
  const a = Math.abs(v);
  if (a < 1e-3) d.z += count;
  else {
    const side = v > 0 ? d.p : d.m;
    const i = Math.ceil(Math.log(a) / DIST_LN);
    side[i] = (side[i] || 0) + count;
  }
  d.n += count;
  d.s += fixed(v, FIXED.ev) * count;
  if (d.lo == null || v < d.lo) d.lo = v;
  if (d.hi == null || v > d.hi) d.hi = v;
  if (!Number.isInteger(v)) d.w = 0;
  return d;
}

export function distMerge(into, d) {
  for (const side of ['p', 'm']) for (const [i, k] of Object.entries(d[side] || {})) into[side][i] = (into[side][i] || 0) + k;
  into.z += d.z || 0;
  into.n += d.n || 0;
  into.s += d.s || 0;
  if (d.lo != null && (into.lo == null || d.lo < into.lo)) into.lo = d.lo;
  if (d.hi != null && (into.hi == null || d.hi > into.hi)) into.hi = d.hi;
  if (!d.w) into.w = 0;
  return into;
}

// The value a bucket stands for (the middle of its range, in relative terms).
export function distValue(i, negative = false) {
  const v = (2 * Math.pow(DIST_GAMMA, Number(i))) / (DIST_GAMMA + 1);
  return negative ? -v : v;
}

function addDists(c, name, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v !== 'number') continue;
    const key = distKey(name, k);
    const d = c.evq?.[key] ?? (Object.keys(c.evq || {}).length < MAX_DISTS ? ((c.evq ??= {})[key] = newDist()) : null);
    if (d) distAdd(d, v);
    else (c.evqc ??= {})[name] = (c.evqc[name] || 0) + 1;
  }
}

function mergeDist(into, key, d) {
  const have = into.evq?.[key];
  if (have) return distMerge(have, d);
  if (Object.keys(into.evq || {}).length < MAX_DISTS) return ((into.evq ??= {})[key] = distMerge(newDist(), d));
  const { name } = splitDistKey(key);
  (into.evqc ??= {})[name] = (into.evqc[name] || 0) + (d.n || 0);
}

function countName(counts, name, k, cap) {
  const key = name in counts || Object.keys(counts).length < cap ? name : OTHER;
  counts[key] = (counts[key] || 0) + k;
}

function cellKey(env, version, level, zone = null) {
  return JSON.stringify(zone == null ? [env ?? null, version ?? null, level] : [env ?? null, version ?? null, level, zone]);
}

function sketchState(s) {
  return { a: s.a, b: Object.fromEntries(s.bins), n: s.n, z: s.zeros, s: s.sum, mn: s.n ? s.min : null, mx: s.n ? s.max : null };
}

function addPair(pair, v, scale, n = 1) {
  if (!isNum(v)) return;
  pair[0] += fixed(v, scale);
  pair[1] += n;
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
