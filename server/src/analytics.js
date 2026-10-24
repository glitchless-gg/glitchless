// All dashboard / MCP queries, computed from per-session states (session-state.js), per-minute rollup
// cells (rollups.js) for the frame-time and count sections, and per-minute facts (facts.js) for hitches,
// gauges, breadcrumbs and errors. The raw path folds all three from the events of the range; a store that
// keeps them per minute merges the stored ones instead, and both give identical answers. Frame-time
// percentiles always come from merged sketches — never from averaging per-session percentiles.
//
// Over more than 31 days a store with daily rollups (SPEC §7) hands over a daily context instead (daily.js): ctx.sessions is
// empty, ctx.cells and ctx.facts hold one cell per day, and ctx.daily holds the range's sessions folded
// per day; the functions below that read sessions answer from it (daily.js says what stays exact).

import { Sketch } from '../../packages/sdk/src/sketch.js';
import { rollup, cellList, newCell, mergeCell, mergeSketch, budgetMedian, meanOf, seconds, splitAttrKey, attrKey, FIXED } from './rollups.js';
import { foldSessions, finalizeSession, MARK, FATAL_KINDS } from './session-state.js';
import { foldFacts, mergeFacts, mergeErrors, newFacts, inFirstSeenOrder as keysBySeen, valueQuantile, valueCount } from './facts.js';
import { idCount } from './facts.js';
import { dailyOverview, dailyPerformance, dailyFunnel, dailyPlayers, dailyEventIndex, dailyEventSessions, dailyEventFunnel, dailySessionsList, dailyDeaths, dailyVersionStats, dailyGaugeClimbs, dailyRetention, sessionTotal, approximate } from './daily.js';
import { versionStat } from './sums.js';

const DIST_EDGES = [0, 4, 8, 12, 16.7, 20, 25, 33.3, 40, 50, 66.7, 100, 150, 250, 500, 1000, 5000];
// A first frame later than this is a slow start (the slow-start finding, and the share of sessions it hits).
export const SLOW_START_MS = 4000;

// ───────────────────────────── context ─────────────────────────────

// `rollups` ({ lo, hi, minutes } from store.rollups()) stands in for the raw events of every minute in
// [lo, hi); the rest of the range is folded from raw events. Rollups have no session type, ids or Steam
// facts, so those filters always use the raw events.
export function buildContext(rawEvents, q, rollups = null) {
  const ctx = sessionContext(q, indexSessions(rawEvents));
  ctx.events = rawEvents.filter((e) => ctx.sessions.has(e.session_id));
  if (rollups && (!q.type || q.type === 'all') && !q.sessions && !q.where) {
    const { lo, hi } = rollups;
    ctx.cells = [...cellList(rollups.minutes, wantedCell(q)), ...cellList(rollup(ctx.events.filter((e) => e.ts < lo || e.ts >= hi)))];
  }
  return ctx;
}

// The context every query takes, from finalized sessions (filtered here). Without raw events, the store
// sets ctx.cells, ctx.facts and the drill-downs (ctx.drill) itself.
export function sessionContext(q, sessions) {
  const keep = (s) => {
    if (q.env && s.env !== q.env) return false;
    if (q.version && s.version !== q.version) return false;
    if (q.type && q.type !== 'all' && s.session_type !== q.type) return false;
    if (q.sessions && !q.sessions.has(s.session_id)) return false;
    if (q.where) for (const [k, v] of Object.entries(q.where)) if (steamValue(s, k) !== v) return false;
    return true;
  };
  for (const [id, s] of sessions) if (!keep(s)) sessions.delete(id);
  let starts = 0;
  let completes = 0;
  let fails = 0;
  for (const s of sessions.values()) {
    starts += s.level_loads;
    completes += s.completes;
    fails += s.fails + s.deaths;
  }
  if (noWin({ sessions: sessions.size, starts, completes, fails })) {
    for (const s of sessions.values()) {
      s.rage_quit = false;
      s.rage = null;
    }
  }
  const bucketMs = pickBucket(q.to - q.from);
  return { q, sessions, from: q.from, to: q.to, bucketMs, buckets: makeBuckets(q.from, q.to, bucketMs) };
}

// Steam facts a session has from its session_start (SPEC §4c, when the game uses Steamworks). Each is a filter (a
// query parameter of that name, q.where: only sessions with that value) and a dimension a breakdown can be split
// by and versions compared on ($steam_branch: beta against public).
export const STEAM_DIMENSIONS = ['steam_branch', 'steam_build', 'steam_hardware', 'steam_controller', 'steam_language', 'proton', 'big_picture', 'family_shared', 'timed_trial'];

// A session's value of a Steam fact, as a filter or a group compares it (builds and flags as text), or null.
export function steamValue(s, dim) {
  const v = s.device?.[dim];
  return v == null ? null : String(v);
}

// Query parameters → q.where: { steam_branch: 'beta', … } for the Steam facts asked for, or null.
export function steamWhere(params) {
  const where = {};
  for (const k of STEAM_DIMENSIONS) {
    const v = params.get(k);
    if (v != null && v !== '') where[k] = v.slice(0, 64);
  }
  return Object.keys(where).length ? where : null;
}

// A game that never completes a level (an endless runner, a flappy game) ends every run in a death or a
// fail, so leaving after one is the end of a run, not a rage quit. Decided over the range once there are
// enough sessions to tell: one level nobody beats (a wall) doesn't make a game endless while others are
// completed. daily.js mergeDays() applies the same rule to day groups.
export const NO_WIN_SESSIONS = 5;
export function noWin({ sessions, starts, completes, fails }) {
  return sessions >= NO_WIN_SESSIONS && starts > 0 && completes === 0 && fails > 0;
}

// Cells and facts are per (env, version, level); the env and version filters apply to them directly.
export function wantedCell(q) {
  return (c) => (!q.env || c.env === q.env) && (!q.version || c.version === q.version);
}

// Rollup cells covering exactly ctx.events: [{ m: minute ts, c: cell }].
export function cellsOf(ctx) {
  return (ctx.cells ??= cellList(rollup(ctx.events)));
}

// Facts (facts.js) covering exactly ctx.events: [{ m: minute ts, c: facts }].
function factsOf(ctx) {
  return (ctx.facts ??= cellList(foldFacts(ctx.events)));
}

// One level's facts, merged.
export function levelFacts(ctx, level) {
  return mergedFacts(ctx, level);
}

// All facts of the context merged into one, or those of one level.
function mergedFacts(ctx, level = undefined) {
  const key = level === undefined ? 'all' : `level:${level}`;
  ctx.merged ??= new Map();
  let f = ctx.merged.get(key);
  if (!f) {
    f = newFacts();
    for (const { c } of factsOf(ctx)) if (level === undefined || c.level === level) mergeFacts(f, c);
    ctx.merged.set(key, f);
  }
  return f;
}

function pickBucket(range) {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 86400e3];
  return steps.find((s) => range / s <= 120) || 86400e3;
}

function makeBuckets(from, to, size) {
  const out = [];
  for (let t = Math.floor(from / size) * size; t <= to; t += size) out.push(t);
  return out;
}

function bucketIndex(ctx, ts) {
  return Math.min(ctx.buckets.length - 1, Math.max(0, Math.floor((ts - ctx.buckets[0]) / ctx.bucketMs)));
}

// How many sessions the context holds (a daily context counts them per day).
export function sessionCount(ctx) {
  return ctx.daily ? sessionTotal(ctx) : ctx.sessions.size;
}

// One finalized state per session (session-state.js), in the order sessions first appear.
export function indexSessions(events) {
  const sessions = foldSessions(events);
  for (const s of sessions.values()) finalizeSession(s);
  return sessions;
}

function ttffByLaunch(sessions) {
  const first = sessions.filter((s) => isNum(s.ttff) && s.first_launch === true).map((s) => s.ttff);
  const later = sessions.filter((s) => isNum(s.ttff) && s.first_launch === false).map((s) => s.ttff);
  if (!first.length && !later.length) return { ttff_first_launch: null };
  const part = (list) => ({ sessions: list.length, p50: quantile(list, 0.5), slow_pct: pct(list.filter((v) => v > SLOW_START_MS).length, list.length || 1) });
  return { ttff_first_launch: { first: part(first), later: part(later) } };
}

export function sessionSummary(s) {
  return {
    session_id: s.session_id,
    player_id: s.player_id,
    version: s.version,
    env: s.env,
    session_type: s.session_type,
    start: s.start ?? s.first_ts,
    duration_s: round(s.duration_s, 1),
    browser: s.device ? `${s.device.browser} ${s.device.browser_version || ''}`.trim() : null,
    os: s.device?.os ?? null,
    steam_deck: s.device?.steam_deck === true,
    steam_build: s.device?.steam_build ?? null,
    steam_branch: s.device?.steam_branch ?? null,
    steam_hardware: s.device?.steam_hardware ?? null,
    gpu: s.device?.gpu ?? null,
    gpu_tier: s.device?.gpu_tier ?? null,
    levels: naturalSort([...s.levels]),
    completed: naturalSort([...s.completed]),
    // Levels the player left before they ended (SPEC §2 level_abandon).
    abandoned: naturalSort(Object.keys(s.abandoned || {})),
    deaths: s.deaths,
    errors: s.errors,
    hitches: s.hitches,
    p50: round(s.p50, 1),
    p95: round(s.p95, 1),
    crashed: s.crashed,
    rage_quit: s.rage_quit,
    rage: s.rage,
    ended: s.ended,
    geometries: s.geo_first != null ? { first: s.geo_first, last: s.geo_last, max: s.geo_max } : null,
    ttff_ms: s.ttff,
    // What the player did, in the game's own events (not the SDKs'): the most sent first.
    events: Object.fromEntries(
      Object.entries(s.ev || {})
        .filter(([name]) => !SDK_EVENTS.has(name))
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 6)
        .map(([name, v]) => [name, v.n]),
    ),
  };
}

// ───────────────────────────── overview ─────────────────────────────

export function overview(ctx) {
  if (ctx.daily) return dailyOverview(ctx);
  const sessions = [...ctx.sessions.values()];
  const nb = ctx.buckets.length;
  const series = {
    ts: ctx.buckets,
    sessions: new Array(nb).fill(0),
    players: new Array(nb).fill(0),
    errors: new Array(nb).fill(0),
    hitches: new Array(nb).fill(0),
    deaths: new Array(nb).fill(0),
    p50: new Array(nb).fill(null),
    p95: new Array(nb).fill(null),
    p99: new Array(nb).fill(null),
  };
  const bucketSketch = Array.from({ length: nb }, () => new Sketch());
  const bucketPlayers = Array.from({ length: nb }, () => new Set());
  for (const s of ctx.sessions.values()) for (const m of s.minutes) bucketPlayers[bucketIndex(ctx, m)].add(s.player_id);
  // Buckets are whole minutes, so a rollup minute always lands in one bucket.
  const total = newCell();
  for (const { m, c } of cellsOf(ctx)) {
    const i = bucketIndex(ctx, m);
    series.sessions[i] += c.n.session_start || 0;
    series.errors[i] += c.n.error || 0;
    series.deaths[i] += c.n.death || 0;
    series.hitches[i] += c.hitches;
    mergeSketch(bucketSketch[i], c.ft);
    mergeCell(total, c);
  }
  for (let i = 0; i < nb; i++) {
    series.players[i] = bucketPlayers[i].size;
    if (bucketSketch[i].n) {
      series.p50[i] = round(bucketSketch[i].quantile(0.5), 2);
      series.p95[i] = round(bucketSketch[i].quantile(0.95), 2);
      series.p99[i] = round(bucketSketch[i].quantile(0.99), 2);
    }
  }
  const all = total.ft;
  const frameSeconds = seconds(total);
  const budget = budgetMedian(total.budgets) ?? 1000 / 60;
  const n = sessions.length || 1;
  const rageQuits = sessions.filter((s) => s.rage_quit).length;
  return {
    kpis: {
      sessions: sessions.length,
      players: new Set(sessions.map((s) => s.player_id)).size,
      crash_free_pct: pct(sessions.filter((s) => !s.crashed).length, n),
      error_free_pct: pct(sessions.filter((s) => s.errors === 0).length, n),
      frame_p50: round(all.quantile(0.5), 2),
      frame_p95: round(all.quantile(0.95), 2),
      frame_p99: round(all.quantile(0.99), 2),
      frame_budget_ms: round(budget, 2),
      pct_frames_over_budget: all.n ? round((total.over / all.n) * 100, 1) : 0,
      avg_fps: frameSeconds ? round(total.frames / frameSeconds, 1) : null,
      hitches_per_min: frameSeconds ? round(total.hitches / (frameSeconds / 60), 2) : null,
      avg_session_s: meanSeconds(sessions),
      rage_quits: rageQuits,
      rage_quit_pct: pct(rageQuits, n),
      errors: total.n.error || 0,
      deaths: total.n.death || 0,
      synthetic_sessions: sessions.filter((s) => s.session_type === 'synthetic').length,
      simulated_sessions: sessions.filter((s) => s.session_type === 'simulated').length,
    },
    series,
    deployments: deployments(ctx),
    top_errors: errorIssues(ctx).slice(0, 5),
    funnel: funnel(ctx),
  };
}

function deployments(ctx) {
  const first = new Map();
  for (const s of ctx.sessions.values()) {
    const t = s.start ?? s.first_ts;
    if (!first.has(s.version) || t < first.get(s.version)) first.set(s.version, t);
  }
  return [...first.entries()].map(([version, ts]) => ({ version, ts })).sort((a, b) => a.ts - b.ts);
}

// ───────────────────────────── performance ─────────────────────────────

export function performance(ctx) {
  if (ctx.daily) return dailyPerformance(ctx);
  const nb = ctx.buckets.length;
  const total = newCell();
  const byLevel = new Map();
  const byVersion = new Map();
  const byTier = new Map();
  const byBrowser = new Map();
  const byGpu = new Map();
  const byPlatform = new Map();
  const byBranch = new Map();
  const byBuild = new Map();
  const bucketSketch = Array.from({ length: nb }, () => new Sketch());
  const bucketCalls = Array.from({ length: nb }, () => [0, 0]);
  const bucketGeo = Array.from({ length: nb }, () => [0, 0]);
  const bucketHeap = Array.from({ length: nb }, () => [0, 0]);
  const versionBuckets = new Map();

  // A group is a rollup cell plus the sessions that sent frame windows into it.
  const group = (map, key) => {
    let g = map.get(key);
    if (!g) map.set(key, (g = { ...newCell(), key, sessions: new Set() }));
    return g;
  };
  const addPair = (into, pair) => {
    into[0] += pair[0];
    into[1] += pair[1];
  };

  // Frame time, renderer cost and counts per level, version and time bucket come from rollup cells.
  for (const { m, c } of cellsOf(ctx)) {
    mergeCell(total, c);
    if (!c.fw) continue;
    mergeCell(group(byLevel, c.level ?? '(menu)'), c);
    mergeCell(group(byVersion, c.version), c);
    const i = bucketIndex(ctx, m);
    mergeSketch(bucketSketch[i], c.ft);
    addPair(bucketCalls[i], c.calls);
    addPair(bucketGeo[i], c.geo);
    addPair(bucketHeap[i], c.heap);
    let vb = versionBuckets.get(c.version);
    if (!vb) versionBuckets.set(c.version, (vb = { key: c.version, t0: c.t0, sketches: Array.from({ length: nb }, () => new Sketch()) }));
    if (c.t0 < vb.t0) vb.t0 = c.t0;
    mergeSketch(vb.sketches[i], c.ft);
  }
  // Device breakdowns and session counts come from each session's own frame windows (its device is only
  // known from its session_start), in the order the sessions' first frame windows arrived.
  for (const s of sessionsByFirstWindow(ctx)) {
    const dev = s.device || {};
    // Steam branches and builds only for the sessions that read them from Steamworks.
    for (const [map, key] of [[byTier, dev.gpu_tier || 'unknown'], [byBrowser, dev.browser || 'unknown'], [byGpu, dev.gpu || 'unknown'], [byPlatform, platformOf(dev)], [byBranch, steamValue(s, 'steam_branch')], [byBuild, steamValue(s, 'steam_build')]]) {
      if (key == null) continue;
      const g = group(map, key);
      mergeCell(g, s.cell);
      g.sessions.add(s.session_id);
    }
    for (const level of s.fwLevels) group(byLevel, level ?? '(menu)').sessions.add(s.session_id);
    group(byVersion, s.version).sessions.add(s.session_id);
  }

  const all = total.ft;
  const frameSeconds = seconds(total);
  const budget = budgetMedian(total.budgets) ?? 1000 / 60;
  const summarize = (g) => {
    const secs = seconds(g);
    return {
      key: g.key,
      sessions: g.sessions.size,
      frames: g.frames,
      p50: round(g.ft.quantile(0.5), 2),
      p75: round(g.ft.quantile(0.75), 2),
      p95: round(g.ft.quantile(0.95), 2),
      p99: round(g.ft.quantile(0.99), 2),
      pct_over_budget: g.ft.n ? round((g.over / g.ft.n) * 100, 1) : 0,
      hitches: g.hitches,
      hitches_per_min: secs ? round(g.hitches / (secs / 60), 2) : null,
      draw_calls: g.calls[1] ? Math.round(meanOf(g.calls, FIXED.calls)) : null,
      draw_calls_max: g.callsMax || null,
      triangles: g.tris[1] ? Math.round(meanOf(g.tris, FIXED.tris)) : null,
      geometries_max: g.geoMax || null,
      ctx_max: g.ctxMax,
    };
  };

  const sessions = [...ctx.sessions.values()];
  const loadByVersion = {};
  for (const s of sessions) {
    if (s.ttff == null) continue;
    (loadByVersion[s.version] ||= []).push(s.ttff);
  }

  return {
    kpis: {
      frame_p50: round(all.quantile(0.5), 2),
      frame_p75: round(all.quantile(0.75), 2),
      frame_p95: round(all.quantile(0.95), 2),
      frame_p99: round(all.quantile(0.99), 2),
      frame_budget_ms: round(budget, 2),
      pct_frames_over_budget: all.n ? round((total.over / all.n) * 100, 1) : 0,
      hitches: total.hitches,
      hitches_per_min: frameSeconds ? round(total.hitches / (frameSeconds / 60), 2) : null,
      frozen_frames: total.frozen,
      draw_calls: total.calls[1] ? Math.round(meanOf(total.calls, FIXED.calls)) : null,
      render_cpu_ms: total.render[1] ? round(meanOf(total.render, FIXED.render), 2) : null,
      ttff_p50: quantile(sessions.map((s) => s.ttff).filter(isNum), 0.5),
      ttff_p95: quantile(sessions.map((s) => s.ttff).filter(isNum), 0.95),
      ttff_slow_pct: pct(sessions.filter((s) => isNum(s.ttff) && s.ttff > SLOW_START_MS).length, sessions.filter((s) => isNum(s.ttff)).length),
      // The first launch of a version on a device starts cold (empty shader and file caches); engine SDKs say which
      // launches were first. Null where no session said.
      ...ttffByLaunch(sessions),
      ttp_p50: quantile(sessions.map((s) => s.ttp).filter(isNum), 0.5),
    },
    distribution: {
      edges: DIST_EDGES,
      counts: all.histogram(DIST_EDGES),
    },
    series: {
      ts: ctx.buckets,
      p50: bucketSketch.map((s) => (s.n ? round(s.quantile(0.5), 2) : null)),
      p95: bucketSketch.map((s) => (s.n ? round(s.quantile(0.95), 2) : null)),
      p99: bucketSketch.map((s) => (s.n ? round(s.quantile(0.99), 2) : null)),
      draw_calls: bucketCalls.map((p) => (p[1] ? Math.round(meanOf(p, FIXED.calls)) : null)),
      geometries: bucketGeo.map((p) => (p[1] ? Math.round(meanOf(p, FIXED.geo)) : null)),
      heap_mb: bucketHeap.map((p) => (p[1] ? round(meanOf(p, FIXED.heap), 1) : null)),
      p95_by_version: Object.fromEntries(inFirstSeenOrder(versionBuckets).map((vb) => [vb.key, vb.sketches.map((s) => (s.n ? round(s.quantile(0.95), 2) : null))])),
    },
    by_level: naturalSortBy([...byLevel.values()].map(summarize), 'key'),
    by_version: inFirstSeenOrder(byVersion).map(summarize),
    by_gpu_tier: [...byTier.values()].map(summarize).sort((a, b) => tierRank(a.key) - tierRank(b.key)),
    by_browser: [...byBrowser.values()].map(summarize).sort((a, b) => b.frames - a.frames),
    by_gpu: [...byGpu.values()].map(summarize).sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    by_platform: [...byPlatform.values()].map(summarize).sort((a, b) => b.sessions - a.sessions),
    by_steam_branch: [...byBranch.values()].map(summarize).sort((a, b) => b.sessions - a.sessions),
    by_steam_build: [...byBuild.values()].map(summarize).sort((a, b) => Number(a.key) - Number(b.key)),
    hitch_causes: { ...mergedFacts(ctx).hc },
    hitch_context: hitchContext(ctx),
    hitches: recentHitches(ctx).map((h) => ({
      ts: h.ts,
      session_id: h.session_id,
      version: h.version,
      level: h.level,
      duration_ms: h.duration_ms,
      causes: h.causes,
      loaf: h.loaf,
      draw_calls: h.draw_calls,
      ctx: h.ctx,
      recent: h.recent,
    })),
    memory: memoryGrowth(sessions),
    texture_growth: textureGrowth(sessions),
    node_growth: nodeGrowth(sessions),
    load: Object.fromEntries(Object.entries(loadByVersion).map(([v, arr]) => [v, { p50: quantile(arr, 0.5), p95: quantile(arr, 0.95), n: arr.length }])),
  };
}

// Groups in the order their first frame window arrived, as iterating the raw events would give them.
function inFirstSeenOrder(map) {
  return [...map.values()].sort((a, b) => (a.t0 ?? Infinity) - (b.t0 ?? Infinity) || String(a.key).localeCompare(String(b.key)));
}

// Sessions that sent frame windows, in the order their first window arrived.
function sessionsByFirstWindow(ctx) {
  return [...ctx.sessions.values()].filter((s) => s.cell.fw).sort((a, b) => a.cell.t0 - b.cell.t0);
}

// The last 100 hitches of the range, newest first. Without raw events the store fetches them (ctx.drill).
function recentHitches(ctx) {
  if (ctx.drill?.hitches) return ctx.drill.hitches;
  return ctx.events.filter((e) => e.type === 'hitch').slice(-100).reverse();
}

// For each numeric context gauge, compare its value in frames that hitched vs frames that didn't.
function hitchContext(ctx) {
  const f = mergedFacts(ctx);
  const out = [];
  for (const k of keysBySeen(f.wk)) {
    const during = f.hg[k];
    if (!valueCount(during)) continue;
    const calm = f.wc[k];
    out.push({ key: k, median_during_hitch: round(valueQuantile(during, 0.5), 2), median_otherwise: valueCount(calm) ? round(valueQuantile(calm, 0.5), 2) : null, samples: valueCount(during) });
  }
  return { gauges: out, preceding_events: eventLift(ctx) };
}

// Which events show up right before hitches more often than chance? Frequent events (a pickup
// every second) appear before almost every hitch, so rank by lift over their base rate instead of raw share.
// A hitch's recent events can come from before its level started (the menu choice that launched it), and such an
// event is barely counted on the level: below LIFT_MIN_EVENTS there, its base rate is the whole game's instead,
// or the floor would make its lift share × 1000. Fewer than LIFT_MIN_HITCHES hitches naming it is chance.
const LIFT_MIN_EVENTS = 5;
const LIFT_MIN_HITCHES = 5;
export function eventLift(ctx, level = undefined, windowS = 1.5) {
  const hitches = hitchCount(ctx, level);
  if (!hitches) return [];
  const f = mergedFacts(ctx, level);
  const all = mergedFacts(ctx);
  let fixedSeconds = 0;
  let allFixedSeconds = 0;
  for (const { c } of cellsOf(ctx)) {
    allFixedSeconds += c.sec;
    if (level === undefined || c.level === level) fixedSeconds += c.sec;
  }
  const inHitch = {};
  for (const name of keysBySeen(f.hn)) inHitch[name] = f.hr[name];
  return Object.entries(inHitch)
    .filter(([, n]) => n >= LIFT_MIN_HITCHES)
    .map(([event, n]) => {
      const share = n / hitches;
      const [count, fixed] = (f.cr[event] || 0) >= LIFT_MIN_EVENTS ? [f.cr[event], fixedSeconds] : [all.cr[event] || 0, allFixedSeconds];
      const rate = fixed ? count / (fixed / FIXED.sec) : 0;
      const base = Math.min(0.99, Math.max(1e-3, 1 - Math.exp(-rate * windowS)));
      return { event, share: round(share, 3), base_rate: round(base, 3), lift: round(share / base, 1) };
    })
    .filter((x) => x.share >= 0.15)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 6);
}

// Hitch events in the context, or on one level (from the rollup cells' event counts).
export function hitchCount(ctx, level = undefined) {
  let n = 0;
  for (const { c } of cellsOf(ctx)) if (level === undefined || c.level === level) n += c.n.hitch || 0;
  return n;
}

// Renderer textures (three.js) or texture keys (Phaser) per level load, per version: like geometries, a
// count that keeps rising with every level is something made and never disposed.
function textureGrowth(sessions) {
  const byVersion = {};
  for (const s of sessions) {
    if (s.tex_first == null || s.level_loads < 2) continue;
    (byVersion[s.version] ||= []).push({ growth: (s.tex_last - s.tex_first) / Math.max(1, s.level_loads - 1), first: s.tex_first, last: s.tex_last });
  }
  return Object.fromEntries(
    Object.entries(byVersion).map(([v, arr]) => [
      v,
      {
        sessions: arr.length,
        textures_growth_per_level_load: quantile(arr.map((a) => a.growth), 0.5),
        median_first: quantile(arr.map((a) => a.first), 0.5),
        median_last: quantile(arr.map((a) => a.last), 0.5),
      },
    ]),
  );
}

// Context gauges (setContext) per key: how many sessions followed it long enough to judge, how many saw it
// keep climbing (session-state.js gauge_climbs), and where those started and ended. A gauge that keeps
// climbing in most sessions is a leak in the game's own words, whether or not it has slowed frames yet.
export function gaugeClimbs(ctx) {
  if (ctx.daily) return dailyGaugeClimbs(ctx);
  const by = new Map();
  const get = (k) => {
    if (!by.has(k)) by.set(k, { n: 0, f: [], l: [] });
    return by.get(k);
  };
  for (const s of ctx.sessions.values()) {
    for (const k of s.gauge_seen || []) get(k).n++;
    for (const [k, c] of Object.entries(s.gauge_climbs || {})) {
      get(k).f.push(c.first);
      get(k).l.push(c.last);
    }
  }
  return [...by].map(([key, g]) => ({ key, sessions: g.n, climbing: g.l.length, median_first: quantile(g.f, 0.5), median_last: quantile(g.l, 0.5) }));
}

function memoryGrowth(sessions) {
  const byVersion = {};
  for (const s of sessions) {
    if (s.geo_first == null || s.level_loads < 2) continue;
    const growthPerLoad = (s.geo_last - s.geo_first) / Math.max(1, s.level_loads - 1);
    (byVersion[s.version] ||= []).push({ growthPerLoad, first: s.geo_first, last: s.geo_last, loads: s.level_loads });
  }
  return Object.fromEntries(
    Object.entries(byVersion).map(([v, arr]) => [
      v,
      {
        sessions: arr.length,
        geometries_growth_per_level_load: quantile(arr.map((a) => a.growthPerLoad), 0.5),
        median_first: quantile(arr.map((a) => a.first), 0.5),
        median_last: quantile(arr.map((a) => a.last), 0.5),
      },
    ]),
  );
}

// Godot's leak watch: scene-tree counts per level load. Orphan nodes (taken out of the tree and never
// freed) should stay flat, so steady growth is a leak; `nodes` shows whether the live tree grows too.
function nodeGrowth(sessions) {
  const byVersion = {};
  for (const s of sessions) {
    const orphans = s.node_counts.orphan_nodes;
    if (!orphans || s.level_loads < 2) continue;
    const loads = s.level_loads - 1;
    const nodes = s.node_counts.nodes;
    (byVersion[s.version] ||= []).push({ orphans, nodes, orphanGrowth: (orphans.last - orphans.first) / loads, nodeGrowth: nodes ? (nodes.last - nodes.first) / loads : null });
  }
  return Object.fromEntries(
    Object.entries(byVersion).map(([v, arr]) => [
      v,
      {
        sessions: arr.length,
        orphan_nodes_growth_per_level_load: quantile(arr.map((a) => a.orphanGrowth), 0.5),
        orphan_nodes_median_first: quantile(arr.map((a) => a.orphans.first), 0.5),
        orphan_nodes_median_last: quantile(arr.map((a) => a.orphans.last), 0.5),
        nodes_growth_per_level_load: quantile(arr.map((a) => a.nodeGrowth), 0.5),
        nodes_median_first: quantile(arr.map((a) => a.nodes?.first), 0.5),
        nodes_median_last: quantile(arr.map((a) => a.nodes?.last), 0.5),
      },
    ]),
  );
}

// ───────────────────────────── errors ─────────────────────────────

// ctx.symbolicate (sourcemaps.js prepare): the original location and stack of a minified web build's issue.
export function errorIssues(ctx) {
  return errorList(ctx).map((i) => ({ ...(ctx.symbolicate ? ctx.symbolicate(i) : i), breadcrumbs: breadcrumbs(ctx, i.sample_session, i.sample_ts) }));
}

// Issues by fingerprint, most sessions first, without breadcrumbs (a store fetches those for the
// samples listed here when it has no raw events).
export function errorList(ctx) {
  const errors = {};
  const series = new Map();
  const totalSessions = sessionCount(ctx) || 1;
  const nb = ctx.buckets.length;
  for (const { m, c } of factsOf(ctx)) {
    mergeErrors(errors, c.er);
    for (const [key, x] of Object.entries(c.er)) {
      if (!series.has(key)) series.set(key, new Array(nb).fill(0));
      series.get(key)[bucketIndex(ctx, m)] += x.n;
    }
  }
  if (ctx.daily) approximate(ctx, 'error_sessions', Object.values(errors).some((x) => x.sessions.approx || x.players.approx));
  // In the order each issue first occurred, as the raw events would list them.
  const list = Object.entries(errors)
    .map(([key, x]) => ({ x, series: series.get(key) }))
    .sort((a, b) => a.x.first.ts - b.x.first.ts)
    .map(({ x, series }) => {
      const e = x.first;
      const sessions = idCount(x.sessions);
      return {
        fingerprint: x.fp,
        kind: e.kind,
        message: e.message,
        location: e.fn || e.source ? `${e.fn || '<anonymous>'} (${e.source || '?'}:${e.line ?? '?'})` : null,
        source: e.source,
        line: e.line,
        fn: e.fn,
        stack: e.stack,
        count: x.n,
        sessions,
        players: idCount(x.players),
        versions: Object.entries(x.versions)
          .sort((a, b) => a[1] - b[1])
          .map(([v]) => v),
        levels: naturalSort(Object.keys(x.levels)),
        first_seen: e.ts,
        last_seen: x.last,
        first_version: e.version,
        sample_session: e.session_id,
        sample_ts: e.ts,
        series,
        sessions_pct: pct(sessions, totalSessions),
        fatal: FATAL_KINDS.has(e.kind),
      };
    });
  return list.sort((a, b) => b.sessions - a.sessions || b.count - a.count);
}

// The six game events a session sent up to `ts` (not frames, positions, errors, maps or loads).
function breadcrumbs(ctx, sessionId, ts) {
  if (ctx.drill?.crumbs) return ctx.drill.crumbs.get(crumbKey(sessionId, ts)) ?? [];
  return crumbsOf(ctx.events, sessionId, ts);
}

export function crumbsOf(events, sessionId, ts) {
  const out = [];
  for (const e of events) {
    if (e.session_id !== sessionId || e.ts > ts) continue;
    if (['frame_window', 'pos', 'error', 'map', 'load'].includes(e.type)) continue;
    out.push({ ts: e.ts, type: e.type, name: e.name || e.cause || null, level: e.level });
  }
  return out.slice(-6);
}

export function crumbKey(sessionId, ts) {
  return `${sessionId}\n${ts}`;
}

// ───────────────────────────── players / design ─────────────────────────────

export function funnel(ctx) {
  if (ctx.daily) return dailyFunnel(ctx);
  const levels = new Map();
  const get = (l) => {
    let v = levels.get(l);
    if (!v) levels.set(l, (v = { level: l, sessions_started: new Set(), sessions_completed: new Set(), players: new Set(), attempts: 0, completes: 0, fails: 0, deaths: 0, abandons: 0, abandoned: 0, durations: [], causes: {}, rage_quits: 0 }));
    return v;
  };
  const durations = [];
  for (const s of ctx.sessions.values()) {
    const ended = new Set(); // levels this session completed, failed or died on
    for (const { ts, k: kind, level, cause, d: duration } of s.marks) {
      if (!level) continue;
      const l = get(level);
      if (kind === MARK.start) {
        l.sessions_started.add(s.session_id);
        l.players.add(s.player_id);
        l.attempts++;
      } else if (kind === MARK.complete) {
        l.sessions_completed.add(s.session_id);
        l.completes++;
        ended.add(level);
        if (isNum(duration)) durations.push([ts, l, duration]);
      } else if (kind === MARK.fail) {
        l.fails++;
        ended.add(level);
      } else if (kind === MARK.death) {
        l.deaths++;
        l.causes[cause] = (l.causes[cause] || 0) + 1;
        ended.add(level);
      }
    }
    for (const [level, n] of Object.entries(s.abandoned || {})) {
      const l = get(level);
      l.abandons += n;
      if (!ended.has(level)) l.abandoned++;
    }
  }
  // Averaged in time order across sessions, as the raw events come.
  for (const [, l, d] of durations.sort((a, b) => a[0] - b[0])) l.durations.push(d);
  for (const s of ctx.sessions.values()) if (s.rage_quit && s.rage?.level) get(s.rage.level).rage_quits++;
  return naturalSortBy(
    [...levels.values()].map((l) => ({
      level: l.level,
      sessions: l.sessions_started.size,
      players: l.players.size,
      completed: l.sessions_completed.size,
      completion_pct: pct(l.sessions_completed.size, l.sessions_started.size || 1),
      attempts: l.attempts,
      deaths: l.deaths,
      deaths_per_session: l.sessions_started.size ? round(l.deaths / l.sessions_started.size, 2) : null,
      fails: l.fails,
      abandons: l.abandons,
      abandoned: l.abandoned,
      avg_complete_s: l.durations.length ? round(l.durations.reduce((a, d) => a + Math.round(d * FIXED.sec), 0) / FIXED.sec / l.durations.length, 1) : null,
      death_causes: l.causes,
      rage_quits: l.rage_quits,
      rage_quit_pct: pct(l.rage_quits, l.sessions_started.size || 1),
    })),
    'level',
  );
}

export function players(ctx) {
  if (ctx.daily) return dailyPlayers(ctx);
  const sessions = [...ctx.sessions.values()];
  const byPlayer = new Map();
  for (const s of sessions) {
    let p = byPlayer.get(s.player_id);
    if (!p) byPlayer.set(s.player_id, (p = { sessions: 0, days: new Set() }));
    p.sessions++;
    p.days.add(new Date(s.start ?? s.first_ts).toISOString().slice(0, 10));
  }
  const lengthEdges = [0, 30, 60, 120, 300, 600, 1200, Infinity];
  const lengthLabels = ['<30s', '30s–1m', '1–2m', '2–5m', '5–10m', '10–20m', '20m+'];
  const lengths = new Array(lengthLabels.length).fill(0);
  for (const s of sessions) {
    const i = lengthEdges.findIndex((edge, k) => s.duration_s >= edge && s.duration_s < lengthEdges[k + 1]);
    if (i >= 0) lengths[i]++;
  }
  const causes = {};
  for (const d of deathsOf(ctx)) causes[d.cause] = (causes[d.cause] || 0) + 1;
  const rageQuits = sessions
    .filter((s) => s.rage_quit)
    .sort((a, b) => b.last_ts - a.last_ts)
    .slice(0, 50)
    .map((s) => ({ session_id: s.session_id, version: s.version, ts: s.end ?? s.last_ts, ...s.rage }));
  const n = sessions.length || 1;
  return {
    kpis: {
      players: byPlayer.size,
      sessions: sessions.length,
      sessions_per_player: byPlayer.size ? round(sessions.length / byPlayer.size, 2) : null,
      returning_players_pct: pct([...byPlayer.values()].filter((p) => p.days.size > 1).length, byPlayer.size || 1),
      avg_session_s: meanSeconds(sessions),
      median_session_s: quantile(sessions.map((s) => s.duration_s), 0.5),
      rage_quits: rageQuits.length,
      rage_quit_pct: pct(sessions.filter((s) => s.rage_quit).length, n),
      rage_inputs: sessions.reduce((a, s) => a + s.rage_inputs, 0),
      game_completion_pct: null,
    },
    funnel: funnel(ctx),
    session_length: { labels: lengthLabels, counts: lengths },
    death_causes: causes,
    rage_quits: rageQuits,
    retention: retention(ctx),
  };
}

// ───────────────────────────── retention ─────────────────────────────

// Returning players by first-seen day (SPEC §3, players.retention): of the players first seen on a day (a cohort),
// the share that played again on the 1st, 7th and 30th day after it, in UTC days (D1 is the next day). Only players
// with an ID count, from install or full mode: an anonymous session is filed under its own ID and never returns.
// Who is new comes from the store's first-seen index (ctx.cohorts: UTC day → ids first seen that day, over all the
// store keeps); without one, a player is new on the first day the range has them. A player belongs to a cohort when
// a session of theirs in this selection (env, version) started on that day, as daily.js counts sessions on the day
// they started. A cohort is a whole day of the range, and its Dn is null until day n has ended inside the range.
export const RETENTION_DAYS = [1, 7, 30];
const DAY_MS = 86_400_000;

export function retention(ctx) {
  if (ctx.daily) return dailyRetention(ctx);
  const players = new Map(); // id → { started: days its sessions started on, active: days it played on }
  let withId = 0;
  for (const s of ctx.sessions.values()) {
    if (!hasPlayerId(s)) continue;
    withId++;
    let p = players.get(s.player_id);
    if (!p) players.set(s.player_id, (p = { started: new Set(), active: new Set() }));
    p.started.add(utcDay(s.start ?? s.first_ts));
    for (const m of s.minutes) p.active.add(utcDay(m));
  }
  const firstDay = new Map();
  for (const [day, ids] of ctx.cohorts || []) for (const id of ids) firstDay.set(id, day);
  const cohorts = new Map();
  for (const [id, p] of players) {
    const day = ctx.cohorts ? firstDay.get(id) : Math.min(...p.started);
    if (day == null || !p.started.has(day)) continue; // first seen before the range, or not in this selection that day
    let c = cohorts.get(day);
    if (!c) cohorts.set(day, (c = { players: 0, returned: RETENTION_DAYS.map(() => 0) }));
    c.players++;
    RETENTION_DAYS.forEach((n, i) => p.active.has(day + n * DAY_MS) && c.returned[i]++);
  }
  return retentionAnswer(ctx, { sessions: ctx.sessions.size, withId, cohorts, firstSeen: ctx.cohorts ? 'index' : 'range' });
}

// Whether a session's player has an ID of their own (install or full mode): ingest files an anonymous session under
// its session ID.
export function hasPlayerId(s) {
  return s.player_id != null && s.player_id !== s.session_id;
}

// Whether every players count of a context is a count of sessions: none of its sessions sent a player ID (a game in
// anonymous mode), so each one was filed under its own session ID.
export function playersAreSessions(ctx) {
  if (ctx.daily) return !!ctx.daily.all?.n && !ctx.daily.all.id;
  return ctx.sessions.size > 0 && ![...ctx.sessions.values()].some(hasPlayerId);
}

export function utcDay(ts) {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

// The answer, from cohorts (day → { players, returned: one count per RETENTION_DAYS }) of either path. status says
// why there is nothing to show: 'anonymous' when no session in the range has a player ID.
export function retentionAnswer(ctx, { sessions, withId, cohorts, firstSeen }) {
  const end = ctx.to + 1;
  const rows = [...cohorts]
    .filter(([day]) => day >= ctx.from && day < end)
    .sort((a, b) => a[0] - b[0])
    .map(([day, c]) => {
      const row = { day: new Date(day).toISOString().slice(0, 10), players: c.players };
      const returned = {};
      RETENTION_DAYS.forEach((n, i) => {
        const ended = day + (n + 1) * DAY_MS <= end;
        row[`d${n}`] = ended ? pct(c.returned[i], c.players) : null;
        returned[`d${n}`] = ended ? c.returned[i] : null;
      });
      return { ...row, returned };
    });
  const overall = {};
  for (const n of RETENTION_DAYS) {
    const done = rows.filter((r) => r.returned[`d${n}`] != null);
    overall[`d${n}`] = pct(
      done.reduce((a, r) => a + r.returned[`d${n}`], 0),
      done.reduce((a, r) => a + r.players, 0),
    );
  }
  return {
    status: !sessions ? 'empty' : !withId ? 'anonymous' : 'ok',
    id_sessions_pct: pct(withId, sessions),
    new_players: rows.reduce((a, r) => a + r.players, 0),
    ...overall,
    cohorts: rows,
    first_seen: firstSeen,
  };
}

// ───────────────────────────── custom events ─────────────────────────────

// Custom events the SDKs send by themselves, as opposed to the game's own (`track()`).
export const SDK_EVENTS = new Set(['rage_input', 'screen_change', 'app_resume', 'webgl_context_restored', 'annotation']);

// Every custom event of the context, indexed once per query: per name its count and series (rollup cells,
// exact), the sessions and players that sent it (session states), and per attribute value its count and
// series (cells) and sessions (session states). Numeric attributes also keep a sum for their average.
export function eventIndex(ctx) {
  if (ctx.evIndex) return ctx.evIndex;
  if (ctx.daily) return (ctx.evIndex = dailyEventIndex(ctx));
  const nb = ctx.buckets.length;
  const names = new Map();
  const get = (n) => {
    let e = names.get(n);
    if (!e) names.set(n, (e = { name: n, count: 0, sessions: 0, players: new Set(), series: new Array(nb).fill(0), attrs: new Map() }));
    return e;
  };
  const attrOf = (e, key) => {
    let a = e.attrs.get(key);
    if (!a) e.attrs.set(key, (a = { key, values: new Map(), sum: 0, n: 0 }));
    return a;
  };
  const valueOf = (a, value) => {
    let x = a.values.get(value);
    if (!x) a.values.set(value, (x = { value, count: 0, sessions: 0, series: new Array(nb).fill(0) }));
    return x;
  };
  for (const { m, c } of cellsOf(ctx)) {
    const i = bucketIndex(ctx, m);
    for (const [n, k] of Object.entries(c.ev || {})) {
      const e = get(n);
      e.count += k;
      e.series[i] += k;
    }
    for (const [k, count] of Object.entries(c.evv || {})) {
      const { name, key, value } = splitAttrKey(k);
      if (!key) continue; // OTHER: past the cell's cap
      const x = valueOf(attrOf(get(name), key), value);
      x.count += count;
      x.series[i] += count;
    }
  }
  for (const s of ctx.sessions.values()) {
    for (const [n, v] of Object.entries(s.ev || {})) {
      const e = get(n);
      e.sessions++;
      e.players.add(s.player_id);
      for (const [key, t] of Object.entries(v.a)) {
        const a = attrOf(e, key);
        for (const value of Object.keys(t.v)) valueOf(a, value).sessions++;
        if (t.c) {
          a.sum += t.s;
          a.n += t.c;
        }
      }
    }
  }
  return (ctx.evIndex = names);
}

// How many events match a filter ({ name, key, value }, as parseFunnel gives): with a value but no key,
// the first attribute that has that value counts.
export function eventCount(ctx, f, field = 'count') {
  const e = eventIndex(ctx).get(f.name);
  if (!e) return 0;
  if (f.value == null) return field === 'series' ? e.series : e[field];
  const attrs = f.key ? [e.attrs.get(f.key)].filter(Boolean) : [...e.attrs.values()];
  const xs = attrs.map((a) => a.values.get(f.value)).filter(Boolean);
  if (field === 'series') return ctx.buckets.map((_, i) => xs.reduce((s, x) => s + x.series[i], 0));
  return xs.reduce((s, x) => s + x[field], 0);
}

// How many events of one rollup cell match a filter. A value without a key counts every attribute that
// has it (as eventCount does).
export function cellCount(c, f) {
  if (f.value == null) return c.ev?.[f.name] || 0;
  if (f.key) return c.evv?.[attrKey(f.name, f.key, f.value)] || 0;
  let n = 0;
  for (const [k, count] of Object.entries(c.evv || {})) {
    const a = splitAttrKey(k);
    if (a.name === f.name && a.value === f.value) n += count;
  }
  return n;
}

// How many events of one session match a filter, from its state (as cellCount counts a cell's).
export function sessionEventCount(s, f) {
  const v = s.ev?.[f.name];
  if (!v) return 0;
  if (f.value == null) return v.n;
  let n = 0;
  for (const [k, t] of Object.entries(v.a)) if (!f.key || k === f.key) n += t.v[f.value] || 0;
  return n;
}

// Whether a session sent an event that matches a filter.
export function sentEvent(s, f) {
  const v = s.ev?.[f.name];
  if (!v) return false;
  if (f.value == null) return true;
  return Object.entries(v.a).some(([k, t]) => (!f.key || k === f.key) && t.v[f.value]);
}

// An event's counts split by a dimension every event has: 'version' or 'level' (from the rollup cells),
// with the sessions that sent it per version. A Steam fact (STEAM_DIMENSIONS) splits by the sessions that sent
// it instead, from their states: counts and sessions, but no series (a session counts its events, not per minute).
export function eventsBy(ctx, f, dim) {
  if (STEAM_DIMENSIONS.includes(dim)) return steamEventsBy(ctx, f, dim);
  const nb = ctx.buckets.length;
  const out = new Map();
  for (const { m, c } of cellsOf(ctx)) {
    const n = cellCount(c, f);
    if (!n) continue;
    const value = String(c[dim] ?? '(none)');
    let x = out.get(value);
    // Sessions per version come from the sessions; per level they can't be known (cells carry no session IDs).
    if (!x) out.set(value, (x = { value, count: 0, sessions: dim === 'version' ? 0 : null, series: new Array(nb).fill(0) }));
    x.count += n;
    x.series[bucketIndex(ctx, m)] += n;
  }
  if (dim === 'version') for (const s of ctx.sessions.values()) if (sentEvent(s, f) && out.has(String(s.version))) out.get(String(s.version)).sessions++;
  if (dim === 'version' && ctx.daily) dailyEventSessions(ctx, f, out);
  return [...out.values()].sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

function steamEventsBy(ctx, f, dim) {
  const out = new Map();
  for (const s of ctx.sessions.values()) {
    const n = sessionEventCount(s, f);
    if (!n) continue;
    const value = steamValue(s, dim) ?? '(none)';
    let x = out.get(value);
    if (!x) out.set(value, (x = { value, count: 0, sessions: 0 }));
    x.count += n;
    x.sessions++;
  }
  return [...out.values()].sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

// The game's own metrics: every custom event name with its count over time, the sessions and players that
// sent it, and how each attribute's values break down. `name` keeps one event; `sdk` adds the SDKs' own.
export function customEvents(ctx, { name = null, sdk = false } = {}) {
  const sessions = sessionCount(ctx);
  const n = sessions || 1;
  const events = [...eventIndex(ctx).values()]
    .filter((e) => (name == null || e.name === name) && (sdk || !SDK_EVENTS.has(e.name)))
    .map((e) => ({
      name: e.name,
      sdk: SDK_EVENTS.has(e.name),
      count: e.count,
      sessions: e.sessions,
      players: e.players.size,
      sessions_pct: pct(e.sessions, n),
      per_session: e.sessions ? round(e.count / e.sessions, 2) : null,
      series: e.series,
      attrs: [...e.attrs.values()].map((a) => ({
        key: a.key,
        values: [...a.values.values()].map(({ series, ...x }) => x).sort((x, y) => y.count - x.count || (x.value < y.value ? -1 : 1)),
        avg: a.n ? round(a.sum / 1e3 / a.n, 2) : null,
      })),
    }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  return { ts: ctx.buckets, sessions, events };
}

// "open,paywall,buy=done" or "buy:step=done" → [{ name, key, value }]. A value without a key matches any
// attribute that has it.
export function parseFunnel(spec) {
  return String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((step) => {
      const [left, value] = step.split('=');
      const [name, key] = left.split(':');
      return { name: name.trim(), key: key?.trim() || null, value: value?.trim() ?? null };
    });
}

// Ordered funnel over custom events: how many sessions reached each step after the one before it (the
// earliest matching occurrence at or after the previous step's), and the median seconds between steps.
export function eventFunnel(ctx, steps) {
  if (ctx.daily) return dailyEventFunnel(ctx, steps);
  const reached = steps.map(() => 0);
  const gaps = steps.map(() => []);
  const matches = (attrs, st) => {
    if (st.value == null) return true;
    if (st.key) return String(attrs?.[st.key]) === st.value;
    return Object.values(attrs || {}).some((v) => String(v) === st.value);
  };
  for (const s of ctx.sessions.values()) {
    let t = -Infinity;
    for (let i = 0; i < steps.length; i++) {
      const hit = s.ev?.[steps[i].name]?.o.find(([ts, attrs]) => ts >= t && matches(attrs, steps[i]));
      if (!hit) break;
      if (i > 0) gaps[i].push((hit[0] - t) / 1000);
      t = hit[0];
      reached[i]++;
    }
  }
  const label = (st) => `${st.name}${st.key ? `:${st.key}` : ''}${st.value != null ? `=${st.value}` : ''}`;
  return steps.map((st, i) => ({
    step: label(st),
    sessions: reached[i],
    pct_of_first: pct(reached[i], reached[0] || 1),
    pct_of_previous: i ? pct(reached[i], reached[i - 1] || 1) : 100,
    median_s_from_previous: i && gaps[i].length ? round(median(gaps[i]), 1) : null,
  }));
}

export function heatmap(ctx, level, maps) {
  const map = pickMap(maps, level, ctx.q.version);
  const pos = positionsOf(ctx, level);
  const levelDeaths = deathsOf(ctx, level);
  const axis = levelAxis(map, pos, levelDeaths);
  const pick = (x, y, z) => (axis === 'xy' ? [x, y] : [x, z]);
  const deaths = [];
  const rageSessions = new Map();
  for (const s of ctx.sessions.values()) if (s.rage_quit && s.rage?.level === level) rageSessions.set(s.session_id, rageDeathTs(s.rage));
  // Deaths without coordinates (the Godot SDK's anonymous mode leaves them out) can't be placed.
  for (const d of levelDeaths) {
    if (isNum(d.x)) deaths.push({ x: d.x, y: d.y, z: d.z, cause: d.cause, version: d.version, session_id: d.session_id, ts: d.ts, rage_quit: rageSessions.get(d.session_id) === d.ts });
  }
  const pts = [];
  for (const e of pos) for (const p of e.pts || []) pts.push(pick(p[1], p[2], p[3]));
  let bounds = map?.bounds;
  if (!bounds) {
    const all = pts.concat(deaths.map((d) => pick(d.x, d.y, d.z)));
    if (all.length) {
      bounds = {
        min: [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))],
        max: [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))],
      };
    }
  }
  let density = null;
  if (bounds && pts.length) {
    const spanA = bounds.max[0] - bounds.min[0] || 1;
    const spanB = bounds.max[1] - bounds.min[1] || 1;
    const cols = 160;
    const rows = Math.max(8, Math.min(120, Math.round((cols * spanB) / spanA)));
    const cells = new Array(cols * rows).fill(0);
    for (const [a, b] of pts) {
      const c = Math.floor(((a - bounds.min[0]) / spanA) * cols);
      // xy (side view): screen-up is +y. xz (top-down capture): screen-up is -z, so row 0 is min z.
      const r = Math.floor(((axis === 'xy' ? bounds.max[1] - b : b - bounds.min[1]) / spanB) * rows);
      if (c >= 0 && c < cols && r >= 0 && r < rows) cells[r * cols + c]++;
    }
    density = { cols, rows, cells, samples: pts.length };
  }
  return {
    level,
    axis,
    bounds: bounds || null,
    map: map ? { image: map.image, size: map.size, version: map.version } : null,
    deaths: deaths.slice(-3000),
    hotspots: deathHotspots(deaths, axis),
    density,
    stats: levelStats(ctx, level),
  };
}

// The plane a level is drawn on: the captured map's, else top-down (xz) once positions or deaths leave z=0.
// Side-scrollers report z≈0 everywhere, so they get a side (xy) view.
function levelAxis(map, pos, deaths) {
  if (map?.axis) return map.axis;
  const off = (z) => Math.abs(z) > 0.01;
  return pos.some((e) => e.pts?.some((p) => off(p[3]))) || deaths.some((d) => off(d.z)) ? 'xz' : 'xy';
}

// Where players died on one level, and with `show` 'path' or 'both' where they went, as counts per bin and
// nothing else (no sessions, versions, players or times), so a share link can show it and a game can draw
// it (board.js positions panel). Bins are squares `bin` world units wide (default: about a hundredth of the
// level) on a fixed grid, so a bin stays put as players come and go; a and b are its centre on the level's
// plane (`axis`). Rows are the busiest bins first, at most MAX_BINS of them (`truncated` says if more were
// left out). Paths use a coarser grid (about 64 bins across). Bounds are the captured map's, else the data's
// rounded out to whole bins.
const MAX_BINS = 2000;
export function levelPositions(ctx, level, maps, { show = 'deaths', bin = null } = {}) {
  const map = pickMap(maps, level, ctx.q.version);
  const deaths = show === 'path' ? [] : deathsOf(ctx, level);
  // Deaths without coordinates (the Godot SDK's anonymous mode leaves them out) can't be placed.
  const placed = deaths.filter((d) => isNum(d.x));
  const pos = show === 'deaths' ? [] : positionsOf(ctx, level);
  const axis = levelAxis(map, pos, placed);
  const pick = (x, y, z) => (axis === 'xy' ? [x, y] : [x, z]);
  const points = placed.map((d) => pick(d.x, d.y, d.z));
  const pts = [];
  for (const e of pos) for (const p of e.pts || []) if (isNum(p[1])) pts.push(pick(p[1], p[2], p[3]));
  if (show === 'deaths' && !points.length) return { empty: true, why: deaths.length ? `Deaths on ${level} have no positions: the game sends them without x and y.` : `No deaths on ${level} in this window.` };
  if (show === 'path' && !pts.length) return { empty: true, why: `No positions from ${level} in this window: the game sends them with setPosition.` };
  if (!points.length && !pts.length) return { empty: true, why: `No deaths or positions on ${level} in this window.` };

  const all = points.concat(pts);
  const extent = map?.bounds || { min: [minOf(all, 0), minOf(all, 1)], max: [maxOf(all, 0), maxOf(all, 1)] };
  const span = Math.max(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1]);
  const size = bin || niceStep(span / 100);
  const pathSize = Math.max(size, niceStep(span / 64));
  const grids = show === 'deaths' ? [size] : show === 'path' ? [pathSize] : [size, pathSize];
  const bounds = map?.bounds
    ? { min: [...map.bounds.min], max: [...map.bounds.max] }
    : {
        min: [0, 1].map((k) => exact(Math.min(...grids.map((g) => Math.floor(extent.min[k] / g) * g)))),
        max: [0, 1].map((k) => exact(Math.max(...grids.map((g) => Math.max(Math.ceil(extent.max[k] / g), Math.floor(extent.min[k] / g) + 1) * g)))),
      };
  const out = { level, axis, bounds };
  if (show !== 'path') {
    const d = binCounts(points, size);
    Object.assign(out, { bin: size, deaths: d.rows, total: points.length, truncated: d.truncated });
  } else out.bin = pathSize;
  if (show !== 'deaths') {
    const p = binCounts(pts, pathSize);
    out.path = { bin: pathSize, cells: p.rows, samples: pts.length, truncated: p.truncated };
  }
  return out;
}

// [[a, b, n]]: how many points fell in each `size` square, the busiest first (ties in grid order).
function binCounts(points, size) {
  const bins = new Map();
  for (const [a, b] of points) {
    const i = Math.floor(a / size);
    const j = Math.floor(b / size);
    const key = `${i} ${j}`;
    const bin = bins.get(key);
    if (bin) bin[2]++;
    else bins.set(key, [i, j, 1]);
  }
  const rows = [...bins.values()].sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  return { rows: rows.slice(0, MAX_BINS).map(([i, j, n]) => [exact((i + 0.5) * size), exact((j + 0.5) * size), n]), truncated: rows.length > MAX_BINS };
}

// 1, 2 or 5 times a power of ten, the nearest at or above v.
function niceStep(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return exact((m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p);
}

// Without the float noise of bin arithmetic (0.35000000000000003).
function exact(v) {
  return +v.toPrecision(12);
}

function minOf(points, k) {
  return points.reduce((m, p) => Math.min(m, p[k]), Infinity);
}

function maxOf(points, k) {
  return points.reduce((m, p) => Math.max(m, p[k]), -Infinity);
}

// The heatmap's level row, and whether the game is one nobody wins (no_win: an endless or flappy game), so
// the page shows its runs rather than a completion rate of 0%.
function levelStats(ctx, level) {
  const fun = funnel(ctx);
  const row = fun.find((f) => f.level === level);
  if (!row) return null;
  const sum = (f) => fun.reduce((n, l) => n + (f(l) || 0), 0);
  return { ...row, no_win: noWin({ sessions: sessionCount(ctx), starts: sum((l) => l.attempts), completes: sum((l) => l.completed), fails: sum((l) => l.fails + l.deaths) }) };
}

// The levels a heatmap can show (captured maps, levels with deaths), and the one it shows.
export function heatmapLevels(ctx, maps) {
  return [...new Set([...maps.map((m) => m.level), ...deathsOf(ctx).map((d) => d.level)])].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function heatmapLevel(ctx, maps, requested) {
  return requested || heatmapLevels(ctx, maps)[0];
}

// Deaths in time order, from the sessions' level and death marks; one level's, or all.
export function deathsOf(ctx, level = undefined) {
  if (ctx.daily) return dailyDeaths(ctx, level);
  const out = [];
  for (const s of ctx.sessions.values()) {
    for (const { ts, k: kind, level: lvl, cause, x, y, z } of s.marks) {
      if (kind === MARK.death && (level === undefined || lvl === level)) out.push({ ts, level: lvl, cause, x, y, z, session_id: s.session_id, version: s.version });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// One level's position samples (pos events). Without raw events the store fetches them (ctx.drill).
function positionsOf(ctx, level) {
  if (ctx.drill?.pos) return ctx.drill.pos.get(level) ?? [];
  return ctx.events.filter((e) => e.type === 'pos' && e.level === level);
}

function pickMap(maps, level, version) {
  const forLevel = (maps || []).filter((m) => m.level === level);
  if (!forLevel.length) return null;
  return forLevel.find((m) => m.version === version) || forLevel.sort((a, b) => b.ts - a.ts)[0];
}

// The death a rage quit happened at (session-state.js keeps it as `dts` when a level_fail came after it).
export function rageDeathTs(rage) {
  return rage?.dts ?? rage?.ts;
}

// Clusters of deaths. A side view (xy) bins taller than wide, since height matters less than where along
// the level; a top-down map (xz) uses square bins, both axes being places.
export function deathHotspots(deaths, axis = 'xz', binSize = 2) {
  deaths = deaths.filter((d) => isNum(d.x));
  if (!deaths.length) return [];
  const bins = new Map();
  for (const d of deaths) {
    const a = Math.floor(d.x / binSize);
    const b = Math.floor((axis === 'xy' ? d.y : d.z) / (axis === 'xy' ? binSize * 2 : binSize));
    const key = `${a}|${b}`;
    let bin = bins.get(key);
    if (!bin) bins.set(key, (bin = { a, b, count: 0, causes: {}, rage_quits: 0, xs: [], ys: [] }));
    bin.count++;
    bin.causes[d.cause] = (bin.causes[d.cause] || 0) + 1;
    if (d.rage_quit) bin.rage_quits++;
    bin.xs.push(d.x);
    bin.ys.push(axis === 'xy' ? d.y : d.z);
  }
  // Merge adjacent bins along the main axis so one wide pit isn't split in two.
  const sorted = [...bins.values()].sort((p, q) => q.count - p.count);
  const used = new Set();
  const spots = [];
  for (const bin of sorted) {
    if (used.has(bin)) continue;
    const group = sorted.filter((o) => !used.has(o) && Math.abs(o.a - bin.a) <= 1 && Math.abs(o.b - bin.b) <= 1);
    group.forEach((o) => used.add(o));
    const count = group.reduce((s, o) => s + o.count, 0);
    const causes = {};
    group.forEach((o) => Object.entries(o.causes).forEach(([c, n]) => (causes[c] = (causes[c] || 0) + n)));
    const xs = group.flatMap((o) => o.xs);
    const ys = group.flatMap((o) => o.ys);
    spots.push({
      x: round(quantile(xs, 0.5), 1),
      [axis === 'xy' ? 'y' : 'z']: round(quantile(ys, 0.5), 1),
      x_range: [round(Math.min(...xs), 1), round(Math.max(...xs), 1)],
      [axis === 'xy' ? 'y_range' : 'z_range']: [round(Math.min(...ys), 1), round(Math.max(...ys), 1)],
      deaths: count,
      share: round(count / deaths.length, 3),
      top_cause: Object.entries(causes).sort((p, q) => q[1] - p[1])[0][0],
      causes,
      rage_quits: group.reduce((s, o) => s + o.rage_quits, 0),
    });
  }
  return spots.sort((p, q) => q.deaths - p.deaths).slice(0, 5);
}

// ───────────────────────────── sessions ─────────────────────────────

// The newest sessions first; `sent` ({ name, key, value }, as parseFunnel gives) keeps those that sent a
// matching event.
export function sessionsList(ctx, { limit = 300, sent = null } = {}) {
  if (ctx.daily) return dailySessionsList(ctx, { limit, sent });
  return [...ctx.sessions.values()]
    .filter((s) => !sent || sentEvent(s, sent))
    .sort((a, b) => (b.start ?? b.first_ts) - (a.start ?? a.first_ts))
    .slice(0, limit)
    .map(sessionSummary);
}

export function sessionDetail(ctx, id, maps) {
  const s = ctx.sessions.get(id);
  if (!s) return null;
  const events = ctx.events.filter((e) => e.session_id === id);
  const timeline = [];
  const frames = [];
  const positions = [];
  for (const e of events) {
    if (e.type === 'frame_window') {
      frames.push({ ts: e.ts, level: e.level, fps: e.fps, p50: e.ft_p50, p95: e.ft_p95, max: e.ft_max, draw_calls: e.draw_calls, geometries: e.geometries, heap_mb: e.heap_mb, hitches: e.hitches, ctx: e.ctx });
    } else if (e.type === 'pos') {
      for (const p of e.pts || []) positions.push([p[0], e.level, p[1], p[2], p[3]]);
    } else if (e.type !== 'map') {
      const { service, env, version, session_id, player_id, received, ft, ...rest } = e;
      timeline.push(rest);
    }
  }
  const levels = [...s.levels];
  return {
    session: { ...sessionSummary(s), device: s.device, annotations: s.annotations },
    timeline,
    frames,
    positions,
    maps: Object.fromEntries(levels.map((l) => [l, pickMap(maps, l, s.version)]).filter(([, m]) => m).map(([l, m]) => [l, { image: m.image, bounds: m.bounds, axis: m.axis, size: m.size }])),
  };
}

// ───────────────────────────── versions ─────────────────────────────

// `by` (a Steam fact, STEAM_DIMENSIONS) compares Steam branches or builds the same way instead (steamGroups).
export function versions(ctx, { stats = [], events = 8, by = null } = {}) {
  if (by) return steamGroups(ctx, { stats, events, by });
  const sessionsBy = new Map();
  for (const s of ctx.sessions.values()) {
    if (!sessionsBy.has(s.version)) sessionsBy.set(s.version, []);
    sessionsBy.get(s.version).push(s);
  }
  // A daily context has each version's session numbers (sessionStats()) instead of its sessions.
  if (ctx.daily) for (const [version, stats] of dailyVersionStats(ctx)) sessionsBy.set(version, stats);
  const framesBy = new Map();
  for (const { c } of cellsOf(ctx)) {
    if (!sessionsBy.has(c.version)) continue;
    if (!framesBy.has(c.version)) framesBy.set(c.version, []);
    framesBy.get(c.version).push(c);
  }
  const list = [...sessionsBy].map(([version, sessions]) => ({ version, ...summarize(sessions, framesBy.get(version) || []) }));
  // The game's own numbers per version: the board's stats (`stats`, board panels of type stat) and the
  // per-session rate of its most sent events. Counts are per session, so versions with more players compare.
  const top = customEvents(ctx).events.slice(0, events).map((e) => e.name);
  for (const v of list) {
    const cells = framesBy.get(v.version) || [];
    const n = v.sessions || 1;
    const count = (spec) => {
      const [f] = parseFunnel(spec);
      return cells.reduce((sum, c) => sum + cellCount(c, f), 0);
    };
    v.events = Object.fromEntries(top.map((name) => [name, round(count(name) / n, 2)]));
    v.board = stats.map((p) => {
      if (p.metric) return v[VERSION_METRIC[p.metric] || p.metric] ?? null;
      // Sums (revenue per session or player) and conversion (per $players or $sessions): sums.js.
      if (p.sum || p.per?.startsWith('$')) return versionStat(ctx, p, v, cells, p.currency);
      if (!p.per) return round(count(p.event) / n, 2);
      const base = count(p.per);
      return base ? round((count(p.event) / base) * 100, 1) : null;
    });
  }
  return list.sort((a, b) => a.first_seen - b.first_seen);
}

// A board stat's metric as a version summary names it.
const VERSION_METRIC = { errors: 'errors_per_session', deaths: 'deaths_per_session' };

// Sessions grouped by a Steam fact (the beta branch they ran, the build), each group summarized as a version is:
// frame times from the sessions' own frame windows, the game's events from what each session sent. Rows keep
// `version` as the group's name, so a version comparison reads them unchanged. Sessions without the fact (no
// Steamworks) are left out. Sums (revenue) are kept per minute and currency, not per session: null here.
function steamGroups(ctx, { stats, events, by }) {
  const groups = new Map();
  for (const s of ctx.sessions.values()) {
    const value = steamValue(s, by);
    if (value == null) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(s);
  }
  const top = customEvents(ctx).events.slice(0, events).map((e) => e.name);
  const list = [...groups].map(([value, sessions]) => {
    const v = { version: value, by, ...summarize(sessions, sessions.map((s) => s.cell)) };
    const n = v.sessions || 1;
    const count = (spec) => {
      const [f] = parseFunnel(spec);
      return sessions.reduce((sum, s) => sum + sessionEventCount(s, f), 0);
    };
    v.events = Object.fromEntries(top.map((name) => [name, round(count(name) / n, 2)]));
    v.board = stats.map((p) => {
      if (p.metric) return v[VERSION_METRIC[p.metric] || p.metric] ?? null;
      if (p.sum) return null;
      if (p.per === '$sessions' || p.per === '$players') {
        const [f] = parseFunnel(p.event);
        const sent = sessions.filter((s) => sentEvent(s, f));
        const base = p.per === '$players' ? v.players : v.sessions;
        return base ? round(((p.per === '$players' ? new Set(sent.map((s) => s.player_id)).size : sent.length) / base) * 100, 1) : null;
      }
      if (!p.per) return round(count(p.event) / n, 2);
      const base = count(p.per);
      return base ? round((count(p.event) / base) * 100, 1) : null;
    });
    return v;
  });
  return list.sort((a, b) => a.first_seen - b.first_seen);
}

// The metrics both a version comparison and a playtest run report for one group of sessions (or their
// sessionStats()); frame time and renderer cost come from the rollup cells of those sessions' events.
function summarize(sessions, cells) {
  const st = Array.isArray(sessions) ? sessionStats(sessions) : sessions;
  const total = newCell();
  const levels = new Map();
  for (const c of cells) {
    mergeCell(total, c);
    if (!c.fw || c.level == null) continue;
    if (!levels.has(c.level)) levels.set(c.level, { ...newCell(), key: c.level });
    mergeCell(levels.get(c.level), c);
  }
  const sketch = total.ft;
  const frameSeconds = seconds(total);
  const levelP95 = {};
  for (const l of inFirstSeenOrder(levels)) levelP95[l.key] = round(l.ft.quantile(0.95), 2);
  const n = st.sessions || 1;
  return {
    sessions: st.sessions,
    players: st.players,
    first_seen: st.first_seen,
    last_seen: st.last_seen,
    avg_session_s: st.avg_session_s,
    avg_fps: frameSeconds ? round(total.frames / frameSeconds, 1) : null,
    level_attempts: st.starts,
    level_fails: st.fails,
    crash_free_pct: pct(st.sessions - st.crashed, n),
    error_free_pct: pct(st.sessions - st.errored, n),
    errors_per_session: round(st.errors / n, 2),
    frame_p50: round(sketch.quantile(0.5), 2),
    frame_p95: round(sketch.quantile(0.95), 2),
    frame_p99: round(sketch.quantile(0.99), 2),
    hitches_per_min: frameSeconds ? round(st.hitches / (frameSeconds / 60), 2) : null,
    // Renderer cost per frame: on fast GPUs vsync hides a perf bug in frame time, these don't.
    draw_calls: total.calls[1] ? Math.round(meanOf(total.calls, FIXED.calls)) : null,
    render_cpu_ms: total.render[1] ? round(meanOf(total.render, FIXED.render), 2) : null,
    level_completion_pct: pct(st.completes, st.starts || 1),
    rage_quit_pct: pct(st.rage, n),
    deaths_per_session: round(st.deaths / n, 2),
    geometries_growth_per_level_load: st.geometries_growth_per_level_load,
    level_p95: levelP95,
    // The screens it ran on: the share of frame windows at each frame budget (1000 / refresh rate, in ms).
    frame_budgets: budgetShares(total.budgets),
  };
}

function budgetShares(budgets) {
  const total = Object.values(budgets).reduce((a, n) => a + n, 0);
  return Object.fromEntries(
    Object.entries(budgets)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([b, n]) => [b, pct(n, total)]),
  );
}

// One version's frame time on the devices that ran at one frame budget, from its sessions' own frame windows, so
// versions that ran on different screens (120 Hz phones in one, 60 Hz in the other) compare like with like. Null
// for a daily context (no sessions) or under `min` sessions at that budget.
export function versionFramesAt(ctx, version, budget, min = 3) {
  const cell = newCell();
  let n = 0;
  for (const s of ctx.sessions.values()) {
    if (s.version !== version || !s.cell.fw || budgetMedian(s.cell.budgets) !== budget) continue;
    mergeCell(cell, s.cell);
    n++;
  }
  if (n < min) return null;
  const secs = seconds(cell);
  return { sessions: n, frame_p95: round(cell.ft.quantile(0.95), 2), hitches_per_min: secs ? round(cell.hitches / (secs / 60), 2) : null };
}

// The session numbers summarize() reports, from a group of sessions (daily.js gives the same per version).
function sessionStats(sessions) {
  const st = { sessions: sessions.length, players: new Set(sessions.map((s) => s.player_id)).size, first_seen: Infinity, last_seen: 0, avg_session_s: meanSeconds(sessions), starts: 0, completes: 0, fails: 0, hitches: 0, crashed: 0, errored: 0, errors: 0, rage: 0, deaths: 0 };
  for (const s of sessions) {
    st.first_seen = Math.min(st.first_seen, s.start ?? s.first_ts);
    st.last_seen = Math.max(st.last_seen, s.last_ts);
    st.starts += Object.values(s.attempts).reduce((a, b) => a + b, 0);
    st.completes += s.completes;
    st.fails += s.fails;
    st.hitches += s.hitches;
    if (s.crashed) st.crashed++;
    if (s.errors !== 0) st.errored++;
    st.errors += s.errors;
    if (s.rage_quit) st.rage++;
    st.deaths += s.deaths;
  }
  st.geometries_growth_per_level_load = quantile(
    sessions.filter((s) => s.geo_first != null && s.level_loads >= 2).map((s) => (s.geo_last - s.geo_first) / (s.level_loads - 1)),
    0.5,
  );
  return st;
}

// ───────────────────────────── playtest ─────────────────────────────

// One summary for exactly the sessions a playtest run produced (buildContext filtered by q.sessions),
// with the per-level renderer cost and the error fingerprints a run-to-run comparison needs.
export function playtestSummary(ctx) {
  const sessions = [...ctx.sessions.values()];
  const levels = {};
  const budgets = [];
  const all = new Sketch();
  const updateMs = [];
  for (const e of ctx.events) {
    if (e.type !== 'frame_window') continue;
    if (e.budget_ms) budgets.push(e.budget_ms);
    if (e.ft) all.merge(e.ft);
    // The game's own update code per frame (Godot's _process, Phaser's scene updates, Unity's Update).
    if (e.process_ms != null) updateMs.push(e.process_ms);
    if (e.level == null) continue;
    const l = (levels[e.level] ||= { seconds: 0, calls: [], renderMs: [], updateMs: [], sketch: new Sketch() });
    l.seconds += e.duration_s || 0;
    if (e.draw_calls != null) l.calls.push(e.draw_calls);
    if (e.render_ms != null) l.renderMs.push(e.render_ms);
    if (e.process_ms != null) l.updateMs.push(e.process_ms);
    if (e.ft) l.sketch.merge(e.ft);
  }
  // Same definition as the dashboard: frames slower than 1.15× the display's frame budget. Unlike p95,
  // which jumps between vsync steps (16.7 → 33.3 ms) when ~5% of frames are slow, this moves smoothly.
  const budget = budgets.length ? median(budgets) : 1000 / 60;
  const overBudget = (sk) => round(sk.fractionAbove(budget * 1.15) * 100, 1);
  return {
    ...summarize(sessions, cellsOf(ctx).map(({ c }) => c)),
    frame_budget_ms: round(budget, 2),
    pct_frames_over_budget: overBudget(all),
    update_cpu_ms: updateMs.length ? round(avg(updateMs), 2) : null,
    crashes: sessions.filter((s) => s.crashed).length,
    deaths: sessions.reduce((a, s) => a + s.deaths, 0),
    levels: Object.fromEntries(
      naturalSort(Object.keys(levels)).map((k) => {
        const l = levels[k];
        return [k, { seconds: round(l.seconds, 1), frame_p95: round(l.sketch.quantile(0.95), 2), pct_frames_over_budget: overBudget(l.sketch), draw_calls: l.calls.length ? Math.round(avg(l.calls)) : null, render_cpu_ms: l.renderMs.length ? round(avg(l.renderMs), 2) : null, update_cpu_ms: l.updateMs.length ? round(avg(l.updateMs), 2) : null }];
      }),
    ),
    errors: errorIssues(ctx).map((i) => ({ fingerprint: i.fingerprint, kind: i.kind, message: i.message, location: i.location, count: i.count, sessions: i.sessions })),
    runs: sessions.map(sessionSummary),
  };
}

// ───────────────────────────── helpers ─────────────────────────────

export function round(v, d = 2) {
  if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

export function pct(a, b) {
  return b ? round((a / b) * 100, 1) : null;
}

export function avg(arr) {
  const xs = arr.filter(isNum);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Mean session length in seconds, from summed milliseconds (exact in any order, as daily rollups sum them).
export function meanSeconds(sessions) {
  if (!sessions.length) return null;
  let ms = 0;
  for (const s of sessions) ms += Math.max(0, (s.end ?? s.last_ts) - (s.start ?? s.first_ts));
  return round(ms / 1000 / sessions.length, 1);
}

export function median(arr) {
  return quantile(arr, 0.5);
}

export function quantile(arr, q) {
  const xs = arr.filter(isNum).sort((a, b) => a - b);
  if (!xs.length) return null;
  return round(xs[Math.min(xs.length - 1, Math.floor(q * xs.length))], 2);
}

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function naturalSort(arr) {
  return arr.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function naturalSortBy(arr, key) {
  return arr.sort((a, b) => String(a[key]).localeCompare(String(b[key]), undefined, { numeric: true }));
}

// The platform a session ran on, for the performance breakdown: Valve's hardware on its own, whatever OS the build
// is for (a Windows build runs on a Deck under Proton), else the OS. Steamworks names the hardware (steam_hardware)
// when the game uses it; otherwise the SDKs' own steam_deck tag finds a Deck.
const STEAM_PLATFORMS = { deck: 'Steam Deck', machine: 'Steam Machine', frame: 'Steam Frame' };
export function platformOf(dev) {
  return STEAM_PLATFORMS[dev?.steam_hardware] || (dev?.steam_deck === true ? 'Steam Deck' : dev?.os || 'unknown');
}

function tierRank(t) {
  return { high: 0, mid: 1, low: 2, software: 3, unknown: 4 }[t] ?? 5;
}
