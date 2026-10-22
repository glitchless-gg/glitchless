// Daily rollups: how queries over more than 31 days are answered without loading every session of the
// range. The hosted store keeps one summary per (project, service, UTC day), built once the day has
// closed (lake/compactor.js), and merges the days of a range; the days still open come from the hourly
// summaries, folded the same way at query time (stores/lake.js).
//
// A day's summary holds:
//   cells, facts   the day's minute cells and facts (rollups.js, facts.js) merged into one per (env,
//                  version, level): every frame-time, count and custom-event number is exact, at day
//                  resolution. Error fingerprints keep their sessions and players as Distinct sketches.
//   groups         per (env, version), the sessions that started that day, folded into what the
//                  session-level answers need: counts (sessions, crashes, rage quits…), sums (duration,
//                  errors, deaths…), quantile maps (session length, time to first frame, memory growth),
//                  device breakdowns, the level funnel, custom events per session, players, the latest
//                  sessions and rage quits, deaths with coordinates
//   sample         sessions that sent custom events, with their occurrences, for ordered funnels: all of
//                  them, or a uniform sample of CAPS.sample once a day has more
//
// A session belongs to the day it started (session_start, else its first event), with all its events,
// so a session that runs past midnight counts once. Cells and facts stay in event time.
//
// What is exact and what is not, at day resolution:
//   exact          everything from cells and facts; session counts, rates, sums and averages; the level
//                  funnel's counts; custom events' sessions, values and averages; the latest sessions and
//                  rage quits
//   exact while small, then estimated (meta.approximate names them)
//                  distinct players (overall, per level, per event, per error) and error sessions:
//                  Distinct and Sample sketches (sketches.js); returning players: the same sample of players
//                  across days; medians of per-session values: quantile maps; ordered funnels: the day's
//                  sample, weighted by its sampling rate; GPUs past the top CAPS.gpus a day; difficulty
//                  hotspots past CAPS.deaths deaths a level a day; attribute values past their caps
//   not at day resolution (stores/lake.js answers them over the last 31 days and says so in meta)
//                  heatmaps (position samples), session-type filters, recent hitches

import { newCell, mergeCell, cellToJSON, cellFromJSON, addCell, budgetMedian, meanOf, seconds, FIXED, OTHER } from './rollups.js';
import { newFacts, addFactsCell } from './facts.js';
import { MARK } from './session-state.js';
import { Distinct, Sample, QMap, hashId, repeatedIds } from './sketches.js';
import { sessionSummary, overview, performance, eventIndex, errorIssues, funnel, cellsOf, round, pct } from './analytics.js';

export const DAY = 86_400_000;

// What one day keeps at most; a cap reached makes the answers that read it approximate.
export const CAPS = {
  players: 512, // Sample of players per (env, version) and day
  quantiles: 512, // distinct values in a quantile map
  recent: 300, // latest sessions per (env, version) and day: the sessions list shows 300
  rageQuits: 50, // latest rage quits: the players page lists 50
  gpus: 30, // GPUs per (env, version) and day; the performance page lists the top 10
  deaths: 100, // deaths with coordinates per level, (env, version) and day
  sample: 256, // sessions with custom events per day, for ordered funnels
  values: 200, // values per custom event attribute (sessions that sent each)
  gauges: 512, // distinct values of a hitch-context gauge per cell and day
  levelPlayers: [128, 8], // Distinct (k, HyperLogLog p) of players per level
  eventPlayers: [128, 8], // …per custom event
  errorSessions: [256, 10], // …sessions per error fingerprint
  errorPlayers: [128, 8], // …players per error fingerprint
};
// At query time nothing is capped: merged exact inputs stay exact. The two lists are display limits.
export const UNCAPPED = Object.fromEntries(Object.entries(CAPS).map(([k, v]) => [k, Array.isArray(v) ? [Infinity, v[1]] : k === 'recent' || k === 'rageQuits' ? v : Infinity]));

// The players page's session length buckets (analytics.js players()).
const LENGTH_EDGES = [0, 30, 60, 120, 300, 600, 1200, Infinity];

export function dayOf(ts) {
  return Math.floor(ts / DAY) * DAY;
}

// The day a session counts on.
export function sessionDay(s) {
  return dayOf(s.start ?? s.first_ts);
}

// ───────────────────────────── folding a day ─────────────────────────────

// One day's summary from what the hourly summaries hold: `cells` and `facts` (Map<minute, Map<key, …>>,
// any minutes: only the day's are kept) and finalized session states (any: only those that started that
// day are kept).
export function foldDay(day, { cells = new Map(), facts = new Map(), sessions = [] }, caps = CAPS) {
  const out = { day, cells: new Map(), facts: new Map(), groups: new Map(), sample: { theta: null, list: [] } };
  const inDay = (m) => m >= day && m < day + DAY;
  const dayCells = new Map();
  for (const m of [...cells.keys()].filter(inDay).sort((a, b) => a - b)) for (const c of cells.get(m).values()) addCell(dayCells, day, cellFromJSON(cellToJSON(c)));
  out.cells = dayCells.get(day) || new Map();
  const dayFacts = new Map();
  for (const m of [...facts.keys()].filter(inDay).sort((a, b) => a - b)) for (const f of facts.get(m).values()) addFactsCell(dayFacts, day, structuredClone(f));
  out.facts = compactFacts(dayFacts.get(day) || new Map(), caps);
  const sample = [];
  for (const s of sessions) {
    if (sessionDay(s) !== day) continue;
    const key = groupKey(s.env, s.version);
    let g = out.groups.get(key);
    if (!g) out.groups.set(key, (g = newGroup(s.env, s.version, caps)));
    addSession(g, s, day, caps);
    if (Object.keys(s.ev || {}).length) sample.push({ h: hashId(s.session_id), env: s.env ?? null, version: s.version ?? null, o: Object.fromEntries(Object.entries(s.ev).map(([n, v]) => [n, v.o])) });
  }
  for (const g of out.groups.values()) seal(g, caps);
  sample.sort((a, b) => a.h - b.h);
  out.sample = sample.length > caps.sample ? { theta: sample[caps.sample].h, list: sample.slice(0, caps.sample) } : { theta: null, list: sample };
  return out;
}

function groupKey(env, version) {
  return JSON.stringify([env ?? null, version ?? null]);
}

function newGroup(env, version, caps) {
  const q = () => new QMap(caps.quantiles);
  return {
    env: env ?? null,
    version: version ?? null,
    n: 0, // sessions
    fw: 0, // sessions that sent frame windows
    crashed: 0,
    errored: 0, // sessions with at least one error
    rage: 0,
    syn: 0,
    sim: 0,
    ms: 0, // summed session duration, ms
    len: new Array(LENGTH_EDGES.length - 1).fill(0),
    dur: q(), // session duration, s
    start: null, // the earliest session start
    last: null, // the latest event
    pl: new Sample(caps.players),
    px: new Map(), // day → Sample: players active on days other than the one their session started
    ri: 0, // rage inputs
    er: 0, // errors
    de: 0, // deaths
    at: 0, // level starts
    co: 0, // level completes
    fa: 0, // level fails
    hi: 0, // hitches
    ttff: q(),
    ttp: q(),
    mem: { n: 0, g: q(), f: q(), l: q() }, // geometry growth per level load, first, last
    nodes: { n: 0, og: q(), of: q(), ol: q(), ng: q(), nf: q(), nl: q() }, // orphan and live node growth, first, last
    dev: { t: new Map(), b: new Map(), g: new Map() }, // GPU tier, browser, GPU → { n, cell }
    fwl: new Map(), // level (or '(menu)') → sessions that sent frame windows there
    lv: new Map(), // level → funnel row
    dc: {}, // death causes
    rq: [], // [last_ts, rage quit]
    recent: [], // [start, session summary]
    sdk: {}, // SDK → sessions
    dx: new Map(), // level → deaths with coordinates
    ev: new Map(), // custom event → { s: sessions, pl: Distinct, a: Map<key, { v: value → sessions, s, c }> }
    cut: new Set(), // what a cap cut short
    caps,
  };
}

function addSession(g, s, day, caps) {
  g.n++;
  if (s.cell.fw) g.fw++;
  if (s.crashed) g.crashed++;
  if (s.errors > 0) g.errored++;
  if (s.rage_quit) g.rage++;
  if (s.session_type === 'synthetic') g.syn++;
  else if (s.session_type === 'simulated') g.sim++;
  const start = s.start ?? s.first_ts;
  g.ms += durationMs(s);
  const li = LENGTH_EDGES.findIndex((edge, k) => s.duration_s >= edge && s.duration_s < LENGTH_EDGES[k + 1]);
  if (li >= 0) g.len[li]++;
  g.dur.add(s.duration_s);
  if (g.start == null || start < g.start) g.start = start;
  if (g.last == null || s.last_ts > g.last) g.last = s.last_ts;
  g.pl.add(s.player_id);
  for (const m of s.minutes) {
    const d = dayOf(m);
    if (d === day) continue;
    if (!g.px.has(d)) g.px.set(d, new Sample(caps.players));
    g.px.get(d).add(s.player_id);
  }
  g.ri += s.rage_inputs;
  g.er += s.errors;
  g.de += s.deaths;
  g.at += Object.values(s.attempts).reduce((a, b) => a + b, 0);
  g.co += s.completes;
  g.fa += s.fails;
  g.hi += s.hitches;
  g.ttff.add(s.ttff);
  g.ttp.add(s.ttp);
  if (s.geo_first != null && s.level_loads >= 2) {
    g.mem.n++;
    g.mem.g.add((s.geo_last - s.geo_first) / Math.max(1, s.level_loads - 1));
    g.mem.f.add(s.geo_first);
    g.mem.l.add(s.geo_last);
  }
  const orphans = s.node_counts?.orphan_nodes;
  if (orphans && s.level_loads >= 2) {
    const loads = s.level_loads - 1;
    const nodes = s.node_counts.nodes;
    const x = g.nodes;
    x.n++;
    x.og.add((orphans.last - orphans.first) / loads);
    x.of.add(orphans.first);
    x.ol.add(orphans.last);
    x.ng.add(nodes ? (nodes.last - nodes.first) / loads : null);
    x.nf.add(nodes?.first);
    x.nl.add(nodes?.last);
  }
  if (s.cell.fw) {
    const dev = s.device || {};
    for (const [map, key] of [
      [g.dev.t, dev.gpu_tier || 'unknown'],
      [g.dev.b, dev.browser || 'unknown'],
      [g.dev.g, dev.gpu || 'unknown'],
    ]) {
      let x = map.get(key);
      if (!x) map.set(key, (x = { n: 0, cell: newCell() }));
      x.n++;
      mergeCell(x.cell, s.cell);
    }
    for (const level of s.fwLevels) g.fwl.set(level ?? '(menu)', (g.fwl.get(level ?? '(menu)') || 0) + 1);
  }
  // The level funnel (analytics.js funnel()).
  const started = new Set();
  const completed = new Set();
  for (const { ts, k: kind, level, cause, x, y, z, d } of s.marks) {
    if (kind === MARK.death) {
      g.dc[cause] = (g.dc[cause] || 0) + 1;
      if (level && isNum(x)) {
        if (!g.dx.has(level)) g.dx.set(level, []);
        g.dx.get(level).push([hashId([s.session_id, ts]), { ts, level, cause, x, y, z, rage_quit: !!(s.rage_quit && s.rage?.level === level && s.rage.ts === ts) }]);
      }
    }
    if (!level) continue;
    const l = levelRow(g, level, caps);
    if (kind === MARK.start) {
      if (!started.has(level)) l.ss++;
      started.add(level);
      l.pl.add(s.player_id);
      l.at++;
    } else if (kind === MARK.complete) {
      if (!completed.has(level)) l.sc++;
      completed.add(level);
      l.co++;
      if (isNum(d)) {
        l.ds += Math.round(d * FIXED.sec);
        l.dn++;
      }
    } else if (kind === MARK.fail) {
      l.fa++;
    } else {
      l.de++;
      l.ca[cause] = (l.ca[cause] || 0) + 1;
    }
  }
  if (s.rage_quit && s.rage?.level) levelRow(g, s.rage.level, caps).rq++;
  if (s.rage_quit) g.rq.push([s.last_ts, { session_id: s.session_id, version: s.version, ts: s.end ?? s.last_ts, ...s.rage }]);
  const summary = sessionSummary(s);
  // What the session sent, for a sessions list filtered by an event (board.js `sent`); not shown.
  const sent = Object.fromEntries(Object.entries(s.ev || {}).map(([n, v]) => [n, Object.fromEntries(Object.entries(v.a).map(([k, t]) => [k, Object.keys(t.v)]))]));
  g.recent.push([start, { ...summary, _sent: sent }]);
  const sdk = s.sdk || '';
  g.sdk[sdk] = (g.sdk[sdk] || 0) + 1;
  for (const [name, v] of Object.entries(s.ev || {})) {
    let e = g.ev.get(name);
    if (!e) g.ev.set(name, (e = { s: 0, pl: new Distinct(...caps.eventPlayers), a: new Map() }));
    e.s++;
    e.pl.add(s.player_id);
    for (const [key, t] of Object.entries(v.a)) {
      let a = e.a.get(key);
      if (!a) e.a.set(key, (a = { v: {}, s: 0, c: 0 }));
      for (const value of Object.keys(t.v)) countValue(g, a.v, value, 1, caps);
      if (t.c) {
        a.s += t.s;
        a.c += t.c;
      }
    }
  }
}

function levelRow(g, level, caps) {
  let l = g.lv.get(level);
  if (!l) g.lv.set(level, (l = { ss: 0, pl: new Distinct(...caps.levelPlayers), sc: 0, at: 0, co: 0, fa: 0, de: 0, ds: 0, dn: 0, ca: {}, rq: 0 }));
  return l;
}

function countValue(g, counts, value, n, caps) {
  let key = value;
  if (!(value in counts) && Object.keys(counts).length >= caps.values) {
    key = OTHER;
    g.cut.add('event_values');
  }
  counts[key] = (counts[key] || 0) + n;
}

// Apply the list caps once a day's sessions are in.
function seal(g, caps) {
  g.recent = newestFirst(g.recent).slice(0, caps.recent);
  g.rq = newestFirst(g.rq).slice(0, caps.rageQuits);
  if (g.dev.g.size > caps.gpus) {
    g.dev.g = new Map(byDevice([...g.dev.g]).sort((a, b) => b[1].n - a[1].n).slice(0, caps.gpus));
    g.cut.add('gpus');
  }
  for (const [level, list] of g.dx) {
    if (list.length <= caps.deaths) continue;
    g.dx.set(level, list.sort((a, b) => a[0] - b[0]).slice(0, caps.deaths));
    g.cut.add('death_hotspots');
  }
}

function newestFirst(list) {
  return list.sort((a, b) => b[0] - a[0]);
}

// Device groups in the order their first frame window arrived (the order performance() makes them in).
function byDevice(entries) {
  return entries.sort((a, b) => (a[1].cell.t0 ?? Infinity) - (b[1].cell.t0 ?? Infinity) || String(a[0]).localeCompare(String(b[0])));
}

// Day facts: error fingerprints move into one facts cell per (env, version) (the error list doesn't
// break them down by level) with their sessions and players as Distinct sketches, and a gauge with more
// distinct values than the cap keeps them to fewer significant digits.
function compactFacts(facts, caps) {
  const out = new Map();
  const errorCell = (f) => {
    const key = JSON.stringify([f.env ?? null, f.version ?? null, null]);
    let e = out.get(key);
    if (!e) out.set(key, (e = newFacts(f.env ?? null, f.version ?? null, null)));
    return e;
  };
  for (const [key, f] of facts) {
    const er = f.er;
    f.er = {};
    for (const gauges of [f.hg, f.wc, f.wh]) {
      for (const [k, counts] of Object.entries(gauges)) {
        if (Object.keys(counts).length <= caps.gauges) continue;
        const m = new QMap(caps.gauges);
        for (const [v, n] of Object.entries(counts)) m.add(Number(v), n);
        gauges[k] = m.c;
        f.qz = true;
      }
    }
    out.set(key, out.has(key) ? Object.assign(out.get(key), { ...f, er: out.get(key).er }) : f);
    const into = errorCell(f).er;
    for (const [fp, x] of Object.entries(er)) {
      const y = into[fp];
      const sessions = Object.keys(x.sessions).reduce((d, id) => d.add(id), new Distinct(...caps.errorSessions));
      const players = Object.keys(x.players).reduce((d, id) => d.add(id), new Distinct(...caps.errorPlayers));
      if (!y) {
        into[fp] = { ...x, sessions, players };
        continue;
      }
      y.n += x.n;
      if (x.first.ts < y.first.ts) y.first = { ...x.first };
      if (x.last > y.last) y.last = x.last;
      y.sessions.merge(sessions);
      y.players.merge(players);
      Object.assign(y.levels, x.levels);
      for (const [v, ts] of Object.entries(x.versions)) if (!(v in y.versions) || ts < y.versions[v]) y.versions[v] = ts;
    }
  }
  return out;
}

// ───────────────────────────── storage ─────────────────────────────

// A day as parts (summaries.js chunk() splits them into items): `main`, one per cell, per group and per
// slice of the funnel sample; `recent`, each group's latest sessions, stored apart (family R) because only
// session lists read them, from the newest day back.
export function dayParts(d) {
  const recent = [];
  for (const g of d.groups.values()) if (g.recent.length) recent.push(['r', g.env, g.version, g.recent]);
  return { main: mainParts(d), recent };
}

function mainParts(d) {
  const parts = [];
  const facts = new Map(d.facts);
  for (const [key, c] of d.cells) {
    parts.push(['c', cellToJSON(c), factsToJSON(facts.get(key))]);
    facts.delete(key);
  }
  for (const f of facts.values()) parts.push(['c', null, factsToJSON(f)]);
  for (const g of d.groups.values()) parts.push(['g', groupToJSON(g)]);
  for (let i = 0; i < d.sample.list.length; i += 32) parts.push(['s', d.sample.theta, d.sample.list.slice(i, i + 32)]);
  if (!d.sample.list.length && d.sample.theta) parts.push(['s', d.sample.theta, []]);
  return parts;
}

// The latest sessions in R parts, of the groups that pass `keep(env, version)`: [start, summary] pairs.
export function recentFromParts(parts, keep) {
  return parts.flatMap((p) => (p[0] === 'r' && keep(p[1], p[2]) ? p[3] : []));
}

// Parts (in any order, from any number of items) back to a day, for merging at query time.
export function dayFromParts(day, parts) {
  const d = { day, cells: new Map(), facts: new Map(), groups: new Map(), sample: { theta: null, list: [] } };
  for (const p of parts) {
    if (p[0] === 'c') {
      if (p[1]) addCell(new Map([[day, d.cells]]), day, cellFromJSON(p[1]));
      if (p[2]) addFactsCell(new Map([[day, d.facts]]), day, factsFromJSON(p[2]));
    } else if (p[0] === 'g') {
      const g = groupFromJSON(p[1]);
      d.groups.set(groupKey(g.env, g.version), g);
    } else if (p[0] === 's') {
      d.sample.theta = p[1];
      d.sample.list.push(...p[2]);
    }
  }
  return d;
}

function factsToJSON(f) {
  if (!f) return null;
  const er = Object.fromEntries(Object.entries(f.er).map(([fp, x]) => [fp, { ...x, sessions: x.sessions.toJSON(), players: x.players.toJSON() }]));
  return { ...f, er };
}

function factsFromJSON(o) {
  const er = Object.fromEntries(Object.entries(o.er || {}).map(([fp, x]) => [fp, { ...x, sessions: Distinct.from(x.sessions), players: Distinct.from(x.players) }]));
  return { ...o, er };
}

const QMAPS = (g) => [
  ['dur', g.dur],
  ['ttff', g.ttff],
  ['ttp', g.ttp],
];

function groupToJSON(g) {
  const qs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? v : v.toJSON()]));
  return {
    env: g.env,
    version: g.version,
    n: g.n,
    fw: g.fw,
    crashed: g.crashed,
    errored: g.errored,
    rage: g.rage,
    syn: g.syn,
    sim: g.sim,
    ms: g.ms,
    len: g.len,
    ...Object.fromEntries(QMAPS(g).map(([k, m]) => [k, m.toJSON()])),
    start: g.start,
    last: g.last,
    pl: g.pl.toJSON(),
    px: [...g.px].map(([d, s]) => [d, s.toJSON()]),
    ri: g.ri,
    er: g.er,
    de: g.de,
    at: g.at,
    co: g.co,
    fa: g.fa,
    hi: g.hi,
    mem: qs(g.mem),
    nodes: qs(g.nodes),
    dev: Object.fromEntries(Object.entries(g.dev).map(([k, map]) => [k, [...map].map(([key, x]) => [key, x.n, cellToJSON(x.cell)])])),
    fwl: [...g.fwl],
    lv: [...g.lv].map(([level, l]) => [level, { ...l, pl: l.pl.toJSON() }]),
    dc: g.dc,
    rq: g.rq,
    sdk: g.sdk,
    dx: [...g.dx].map(([level, list]) => [level, list.map(([, d]) => [d.ts, d.x, d.y, d.z, d.cause, d.rage_quit ? 1 : 0])]),
    ev: [...g.ev].map(([name, e]) => [name, e.s, e.pl.toJSON(), [...e.a]]),
    cut: [...g.cut],
  };
}

function groupFromJSON(o) {
  const caps = UNCAPPED;
  const q = (x) => QMap.from(x, caps.quantiles);
  const qs = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? v : q(v)]));
  return {
    ...o,
    dur: q(o.dur),
    ttff: q(o.ttff),
    ttp: q(o.ttp),
    pl: Sample.from(o.pl),
    px: new Map(o.px.map(([d, s]) => [d, Sample.from(s)])),
    mem: qs(o.mem),
    nodes: qs(o.nodes),
    dev: Object.fromEntries(Object.entries(o.dev).map(([k, list]) => [k, new Map(list.map(([key, n, c]) => [key, { n, cell: cellFromJSON(c) }]))])),
    fwl: new Map(o.fwl),
    lv: new Map(o.lv.map(([level, l]) => [level, { ...l, pl: Distinct.from(l.pl) }])),
    recent: [],
    dx: new Map(o.dx.map(([level, list]) => [level, list.map(([ts, x, y, z, cause, rage]) => [0, { ts, level, cause, x, y, z, rage_quit: !!rage }])])),
    ev: new Map(o.ev.map(([name, s, pl, a]) => [name, { s, pl: Distinct.from(pl), a: new Map(a) }])),
    cut: new Set(o.cut),
    caps,
  };
}

// ───────────────────────────── merging days ─────────────────────────────

// Days (foldDay() or dayFromParts(), any order) → what a daily context holds: day cells and facts as
// { m, c } lists, and `daily`, the sessions of the range merged (`all`, and per version), with the
// players of each day for the players-per-day series and returning players. `keep(env, version)` is
// the query's env and version filter.
export function mergeDays(days, keep) {
  const daily = { all: null, byVersion: new Map(), players: new Map(), active: new Map(), samples: [], cut: new Set() };
  const cells = [];
  const facts = [];
  for (const d of [...days].sort((a, b) => a.day - b.day)) {
    for (const c of d.cells.values()) cells.push({ m: d.day, c });
    for (const f of d.facts.values()) facts.push({ m: d.day, c: f });
    const players = new Sample(Infinity);
    for (const g of d.groups.values()) {
      if (!keep(g.env, g.version)) continue;
      daily.all = mergeGroup(daily.all, g);
      daily.byVersion.set(g.version, mergeGroup(daily.byVersion.get(g.version) || null, g));
      players.merge(g.pl);
      addActive(daily.active, d.day, g.pl);
      for (const [day, s] of g.px) addActive(daily.active, day, s);
    }
    daily.players.set(d.day, players);
    const list = d.sample.list.filter((x) => keep(x.env, x.version));
    if (list.length || d.sample.theta) daily.samples.push({ rate: d.sample.theta == null ? 1 : d.sample.theta / 2 ** 53, list });
  }
  daily.all ||= newGroup(null, null, UNCAPPED);
  daily.all.recent = newestFirst(daily.all.recent);
  daily.all.rq = newestFirst(daily.all.rq);
  return { cells, facts, daily };
}

function addActive(active, day, sample) {
  if (!active.has(day)) active.set(day, new Sample(Infinity));
  active.get(day).merge(sample);
}

// Merge group `g` into `into` (null: a fresh copy of g's shape).
function mergeGroup(into, g) {
  if (!into) into = newGroup(g.env, g.version, UNCAPPED);
  for (const k of ['n', 'fw', 'crashed', 'errored', 'rage', 'syn', 'sim', 'ms', 'ri', 'er', 'de', 'at', 'co', 'fa', 'hi']) into[k] += g[k];
  g.len.forEach((n, i) => (into.len[i] += n));
  for (const k of ['dur', 'ttff', 'ttp']) into[k].merge(g[k]);
  if (g.start != null && (into.start == null || g.start < into.start)) into.start = g.start;
  if (g.last != null && (into.last == null || g.last > into.last)) into.last = g.last;
  into.pl.merge(g.pl);
  for (const [d, s] of g.px) {
    if (!into.px.has(d)) into.px.set(d, new Sample(Infinity));
    into.px.get(d).merge(s);
  }
  for (const part of ['mem', 'nodes']) for (const [k, v] of Object.entries(g[part])) typeof v === 'number' ? (into[part][k] += v) : into[part][k].merge(v);
  for (const k of ['t', 'b', 'g']) {
    for (const [key, x] of g.dev[k]) {
      const y = into.dev[k].get(key);
      if (!y) into.dev[k].set(key, { n: x.n, cell: mergeCell(newCell(), x.cell) });
      else {
        y.n += x.n;
        mergeCell(y.cell, x.cell);
      }
    }
  }
  for (const [level, n] of g.fwl) into.fwl.set(level, (into.fwl.get(level) || 0) + n);
  for (const [level, l] of g.lv) {
    const m = levelRow(into, level, UNCAPPED);
    for (const k of ['ss', 'sc', 'at', 'co', 'fa', 'de', 'ds', 'dn', 'rq']) m[k] += l[k];
    m.pl.merge(l.pl);
    for (const [c, n] of Object.entries(l.ca)) m.ca[c] = (m.ca[c] || 0) + n;
  }
  for (const [c, n] of Object.entries(g.dc)) into.dc[c] = (into.dc[c] || 0) + n;
  into.rq.push(...g.rq);
  into.recent.push(...g.recent);
  for (const [k, n] of Object.entries(g.sdk)) into.sdk[k] = (into.sdk[k] || 0) + n;
  for (const [level, list] of g.dx) {
    if (!into.dx.has(level)) into.dx.set(level, []);
    into.dx.get(level).push(...list);
  }
  for (const [name, e] of g.ev) {
    let x = into.ev.get(name);
    if (!x) into.ev.set(name, (x = { s: 0, pl: new Distinct(...UNCAPPED.eventPlayers), a: new Map() }));
    x.s += e.s;
    x.pl.merge(e.pl);
    for (const [key, a] of e.a) {
      let b = x.a.get(key);
      if (!b) x.a.set(key, (b = { v: {}, s: 0, c: 0 }));
      for (const [value, n] of Object.entries(a.v)) b.v[value] = (b.v[value] || 0) + n;
      b.s += a.s;
      b.c += a.c;
    }
  }
  for (const c of g.cut) into.cut.add(c);
  return into;
}

// ───────────────────────────── answers at day resolution ─────────────────────────────
//
// analytics.js hands a daily context (ctx.daily set, ctx.sessions empty) to these. Where an answer also
// has parts from cells and facts, the function computes it as analytics.js does with no sessions, then
// fills in the session parts from ctx.daily.

// The context without its daily part: analytics.js answers from cells and facts only.
function plain(ctx) {
  return { ...ctx, daily: null };
}

// Name an approximate part of the answer in meta.approximate.
export function approximate(ctx, what, yes = true) {
  const list = ctx.meta?.approximate;
  if (yes && list && !list.includes(what)) list.push(what);
}

export function sessionTotal(ctx) {
  return ctx.daily.all.n;
}

function playerCount(ctx, g) {
  approximate(ctx, 'players', g.pl.approx);
  return g.pl.count();
}

function avgDuration(g) {
  return g.n ? round(g.ms / 1000 / g.n, 1) : null;
}

export function dailyOverview(ctx) {
  const o = overview(plain(ctx));
  const g = ctx.daily.all;
  const n = g.n || 1;
  Object.assign(o.kpis, {
    sessions: g.n,
    players: playerCount(ctx, g),
    crash_free_pct: pct(g.n - g.crashed, n),
    error_free_pct: pct(g.n - g.errored, n),
    avg_session_s: avgDuration(g),
    rage_quits: g.rage,
    rage_quit_pct: pct(g.rage, n),
    synthetic_sessions: g.syn,
    simulated_sessions: g.sim,
  });
  o.series.players = ctx.buckets.map((b) => {
    const s = ctx.daily.active.get(b);
    approximate(ctx, 'players', !!s?.approx);
    return s ? s.count() : 0;
  });
  o.deployments = [...ctx.daily.byVersion]
    .filter(([, v]) => v.n)
    .map(([version, v]) => ({ version, ts: v.start }))
    .sort((a, b) => a.ts - b.ts);
  o.top_errors = errorIssues(ctx).slice(0, 5);
  o.funnel = funnel(ctx);
  return o;
}

export function dailyPerformance(ctx) {
  const p = performance(plain(ctx));
  const g = ctx.daily.all;
  const total = newCell();
  for (const { c } of cellsOf(ctx)) mergeCell(total, c);
  const budget = budgetMedian(total.budgets) ?? 1000 / 60;
  // As performance() summarizes a group of frame windows.
  const summarize = (key, x) => {
    const c = x.cell;
    const secs = seconds(c);
    return {
      key,
      sessions: x.n,
      frames: c.frames,
      p50: round(c.ft.quantile(0.5), 2),
      p75: round(c.ft.quantile(0.75), 2),
      p95: round(c.ft.quantile(0.95), 2),
      p99: round(c.ft.quantile(0.99), 2),
      pct_over_budget: round(c.ft.fractionAbove(budget * 1.15) * 100, 1),
      hitches: c.hitches,
      hitches_per_min: secs ? round(c.hitches / (secs / 60), 2) : null,
      draw_calls: c.calls[1] ? Math.round(meanOf(c.calls, FIXED.calls)) : null,
      draw_calls_max: c.callsMax || null,
      triangles: c.tris[1] ? Math.round(meanOf(c.tris, FIXED.tris)) : null,
      geometries_max: c.geoMax || null,
      ctx_max: c.ctxMax,
    };
  };
  const list = (map) => byDevice([...map]).map(([key, x]) => summarize(key, x));
  p.by_gpu_tier = list(g.dev.t).sort((a, b) => tierRank(a.key) - tierRank(b.key));
  p.by_browser = list(g.dev.b).sort((a, b) => b.frames - a.frames);
  p.by_gpu = list(g.dev.g)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);
  approximate(ctx, 'gpus', g.cut.has('gpus'));
  for (const l of p.by_level) l.sessions = g.fwl.get(l.key) || 0;
  for (const v of p.by_version) v.sessions = ctx.daily.byVersion.get(v.key)?.fw || 0;
  approximate(ctx, 'load_times', g.ttff.approx || g.ttp.approx);
  p.kpis.ttff_p50 = g.ttff.quantile(0.5);
  p.kpis.ttff_p95 = g.ttff.quantile(0.95);
  p.kpis.ttp_p50 = g.ttp.quantile(0.5);
  const versions = [...ctx.daily.byVersion];
  p.memory = Object.fromEntries(
    versions
      .filter(([, v]) => v.mem.n)
      .map(([version, v]) => {
        approximate(ctx, 'memory', v.mem.g.approx || v.mem.f.approx || v.mem.l.approx);
        return [version, { sessions: v.mem.n, geometries_growth_per_level_load: v.mem.g.quantile(0.5), median_first: v.mem.f.quantile(0.5), median_last: v.mem.l.quantile(0.5) }];
      }),
  );
  p.node_growth = Object.fromEntries(
    versions
      .filter(([, v]) => v.nodes.n)
      .map(([version, v]) => {
        const x = v.nodes;
        approximate(ctx, 'memory', [x.og, x.of, x.ol, x.ng, x.nf, x.nl].some((m) => m.approx));
        return [
          version,
          {
            sessions: x.n,
            orphan_nodes_growth_per_level_load: x.og.quantile(0.5),
            orphan_nodes_median_first: x.of.quantile(0.5),
            orphan_nodes_median_last: x.ol.quantile(0.5),
            nodes_growth_per_level_load: x.ng.quantile(0.5),
            nodes_median_first: x.nf.quantile(0.5),
            nodes_median_last: x.nl.quantile(0.5),
          },
        ];
      }),
  );
  p.load = Object.fromEntries(versions.filter(([, v]) => v.ttff.n).map(([version, v]) => [version, { p50: v.ttff.quantile(0.5), p95: v.ttff.quantile(0.95), n: v.ttff.n }]));
  return p;
}

export function dailyFunnel(ctx) {
  const rows = [...ctx.daily.all.lv].map(([level, l]) => {
    approximate(ctx, 'level_players', l.pl.approx);
    return {
      level,
      sessions: l.ss,
      players: l.pl.count(),
      completed: l.sc,
      completion_pct: pct(l.sc, l.ss || 1),
      attempts: l.at,
      deaths: l.de,
      deaths_per_session: l.ss ? round(l.de / l.ss, 2) : null,
      fails: l.fa,
      avg_complete_s: l.dn ? round(l.ds / FIXED.sec / l.dn, 1) : null,
      death_causes: l.ca,
      rage_quits: l.rq,
      rage_quit_pct: pct(l.rq, l.ss || 1),
    };
  });
  return rows.sort((a, b) => String(a.level).localeCompare(String(b.level), undefined, { numeric: true }));
}

export function dailyPlayers(ctx) {
  const g = ctx.daily.all;
  const n = g.n || 1;
  const players = playerCount(ctx, g);
  const returning = repeatedIds([...ctx.daily.players.values()]);
  approximate(ctx, 'returning_players_pct', returning.approx);
  approximate(ctx, 'median_session_s', g.dur.approx);
  const rageQuits = g.rq.slice(0, CAPS.rageQuits).map(([, r]) => r);
  return {
    kpis: {
      players,
      sessions: g.n,
      sessions_per_player: players ? round(g.n / players, 2) : null,
      returning_players_pct: pct(returning.repeat, returning.ids || 1),
      avg_session_s: avgDuration(g),
      median_session_s: g.dur.quantile(0.5),
      rage_quits: rageQuits.length,
      rage_quit_pct: pct(g.rage, n),
      rage_inputs: g.ri,
      game_completion_pct: null,
    },
    funnel: funnel(ctx),
    session_length: { labels: ['<30s', '30s–1m', '1–2m', '2–5m', '5–10m', '10–20m', '20m+'], counts: g.len },
    death_causes: g.dc,
    rage_quits: rageQuits,
  };
}

// eventIndex() with the session parts (sessions and players per event, sessions per attribute value,
// averages) from the day groups.
export function dailyEventIndex(ctx) {
  const names = eventIndex(plain(ctx));
  const nb = ctx.buckets.length;
  for (const [name, x] of ctx.daily.all.ev) {
    let e = names.get(name);
    if (!e) names.set(name, (e = { name, count: 0, sessions: 0, players: null, series: new Array(nb).fill(0), attrs: new Map() }));
    e.sessions += x.s;
    approximate(ctx, 'event_players', x.pl.approx);
    e.players = { size: x.pl.count() };
    for (const [key, t] of x.a) {
      let a = e.attrs.get(key);
      if (!a) e.attrs.set(key, (a = { key, values: new Map(), sum: 0, n: 0 }));
      for (const [value, k] of Object.entries(t.v)) {
        let v = a.values.get(value);
        if (!v) a.values.set(value, (v = { value, count: 0, sessions: 0, series: new Array(nb).fill(0) }));
        v.sessions += k;
      }
      a.sum += t.s;
      a.n += t.c;
    }
  }
  for (const e of names.values()) e.players ||= { size: 0 };
  approximate(ctx, 'event_values', ctx.daily.all.cut.has('event_values') || cellsOf(ctx).some(({ c }) => OTHER in (c.evv || {})));
  return names;
}

// Sessions per version that sent an event matching `f` (eventsBy()'s sessions), into `out`.
export function dailyEventSessions(ctx, f, out) {
  for (const [version, g] of ctx.daily.byVersion) {
    const x = out.get(String(version));
    const e = g.ev.get(f.name);
    if (!x || !e) continue;
    if (f.value == null) x.sessions += e.s;
    else for (const [key, a] of e.a) if (!f.key || key === f.key) x.sessions += a.v[f.value] || 0;
  }
}

// Ordered funnels over the days' samples: each sampled session counts for 1 / its day's sampling rate.
export function dailyEventFunnel(ctx, steps) {
  const reached = steps.map(() => 0);
  const gaps = steps.map(() => []);
  const matches = (attrs, st) => {
    if (st.value == null) return true;
    if (st.key) return String(attrs?.[st.key]) === st.value;
    return Object.values(attrs || {}).some((v) => String(v) === st.value);
  };
  for (const { rate, list } of ctx.daily.samples) {
    approximate(ctx, 'event_funnel', rate < 1);
    for (const s of list) {
      let t = -Infinity;
      for (let i = 0; i < steps.length; i++) {
        const hit = s.o[steps[i].name]?.find(([ts, attrs]) => ts >= t && matches(attrs, steps[i]));
        if (!hit) break;
        if (i > 0) gaps[i].push((hit[0] - t) / 1000);
        t = hit[0];
        reached[i] += 1 / rate;
      }
    }
  }
  const n = reached.map((r) => Math.round(r));
  const label = (st) => `${st.name}${st.key ? `:${st.key}` : ''}${st.value != null ? `=${st.value}` : ''}`;
  return steps.map((st, i) => ({
    step: label(st),
    sessions: n[i],
    pct_of_first: pct(n[i], n[0] || 1),
    pct_of_previous: i ? pct(n[i], n[i - 1] || 1) : 100,
    median_s_from_previous: i && gaps[i].length ? round(medianOf(gaps[i]), 1) : null,
  }));
}

export function dailySessionsList(ctx, { limit = 300, sent = null } = {}) {
  return ctx.daily.all.recent
    .map(([, s]) => s)
    .filter((s) => !sent || sentFilter(s._sent, sent))
    .slice(0, limit)
    .map(({ _sent, ...s }) => s);
}

function sentFilter(sent, f) {
  const v = sent?.[f.name];
  if (!v) return false;
  if (f.value == null) return true;
  return Object.entries(v).some(([k, values]) => (!f.key || k === f.key) && values.includes(f.value));
}

// Deaths with coordinates (the ones difficulty hotspots use), in time order; one level's or all, each
// with whether it ended a rage quit.
export function dailyDeaths(ctx, level = undefined) {
  approximate(ctx, 'death_hotspots', ctx.daily.all.cut.has('death_hotspots'));
  const out = [];
  for (const [lvl, list] of ctx.daily.all.dx) if (level === undefined || lvl === level) for (const [, d] of list) out.push(d);
  return out.sort((a, b) => a.ts - b.ts);
}

// Sessions per SDK, for findings' engine-specific advice.
export function dailySdks(ctx) {
  return ctx.daily.all.sdk;
}

// What versions() needs of each version's sessions, from its merged day groups.
export function dailyVersionStats(ctx) {
  return new Map(
    [...ctx.daily.byVersion]
      .filter(([, g]) => g.n)
      .map(([version, g]) => {
        approximate(ctx, 'players', g.pl.approx);
        approximate(ctx, 'memory', g.mem.g.approx);
        return [
          version,
          {
            sessions: g.n,
            players: g.pl.count(),
            first_seen: g.start,
            last_seen: g.last,
            avg_session_s: avgDuration(g),
            starts: g.at,
            completes: g.co,
            fails: g.fa,
            hitches: g.hi,
            crashed: g.crashed,
            errored: g.errored,
            errors: g.er,
            rage: g.rage,
            deaths: g.de,
            geometries_growth_per_level_load: g.mem.g.quantile(0.5),
          },
        ];
      }),
  );
}

function durationMs(s) {
  return Math.max(0, (s.end ?? s.last_ts) - (s.start ?? s.first_ts));
}

function medianOf(arr) {
  const xs = arr.filter(isNum).sort((a, b) => a - b);
  return xs.length ? round(xs[Math.min(xs.length - 1, Math.floor(0.5 * xs.length))], 2) : null;
}

function tierRank(t) {
  return { high: 0, mid: 1, low: 2, software: 3, unknown: 4 }[t] ?? 5;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

