// All dashboard / MCP queries, computed from per-session states (session-state.js), per-minute rollup
// cells (rollups.js) for the frame-time and count sections, and per-minute facts (facts.js) for hitches,
// gauges, breadcrumbs and errors. The raw path folds all three from the events of the range; a store that
// keeps them per minute merges the stored ones instead, and both give identical answers. Frame-time
// percentiles always come from merged sketches — never from averaging per-session percentiles.

import { Sketch } from '../../packages/sdk/src/sketch.js';
import { rollup, cellList, newCell, mergeCell, mergeSketch, budgetMedian, meanOf, seconds, FIXED } from './rollups.js';
import { foldSessions, finalizeSession, MARK, FATAL_KINDS } from './session-state.js';
import { foldFacts, mergeFacts, mergeErrors, newFacts, inFirstSeenOrder as keysBySeen, valueQuantile, valueCount } from './facts.js';

const DIST_EDGES = [0, 4, 8, 12, 16.7, 20, 25, 33.3, 40, 50, 66.7, 100, 150, 250, 500, 1000, 5000];

// ───────────────────────────── context ─────────────────────────────

// `rollups` ({ lo, hi, minutes } from store.rollups()) stands in for the raw events of every minute in
// [lo, hi); the rest of the range is folded from raw events. Rollups have no session type or ids, so
// those filters always use the raw events.
export function buildContext(rawEvents, q, rollups = null) {
  const ctx = sessionContext(q, indexSessions(rawEvents));
  ctx.events = rawEvents.filter((e) => ctx.sessions.has(e.session_id));
  if (rollups && (!q.type || q.type === 'all') && !q.sessions) {
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
    return true;
  };
  for (const [id, s] of sessions) if (!keep(s)) sessions.delete(id);
  const bucketMs = pickBucket(q.to - q.from);
  return { q, sessions, from: q.from, to: q.to, bucketMs, buckets: makeBuckets(q.from, q.to, bucketMs) };
}

// Cells and facts are per (env, version, level); the env and version filters apply to them directly.
export function wantedCell(q) {
  return (c) => (!q.env || c.env === q.env) && (!q.version || c.version === q.version);
}

// Rollup cells covering exactly ctx.events: [{ m: minute ts, c: cell }].
function cellsOf(ctx) {
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

// One finalized state per session (session-state.js), in the order sessions first appear.
export function indexSessions(events) {
  const sessions = foldSessions(events);
  for (const s of sessions.values()) finalizeSession(s);
  return sessions;
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
    gpu: s.device?.gpu ?? null,
    gpu_tier: s.device?.gpu_tier ?? null,
    levels: naturalSort([...s.levels]),
    completed: naturalSort([...s.completed]),
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
  };
}

// ───────────────────────────── overview ─────────────────────────────

export function overview(ctx) {
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
      pct_frames_over_budget: round(all.fractionAbove(budget * 1.15) * 100, 1),
      avg_fps: frameSeconds ? round(total.frames / frameSeconds, 1) : null,
      hitches_per_min: frameSeconds ? round(total.hitches / (frameSeconds / 60), 2) : null,
      avg_session_s: round(avg(sessions.map((s) => s.duration_s)), 1),
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
  const nb = ctx.buckets.length;
  const total = newCell();
  const byLevel = new Map();
  const byVersion = new Map();
  const byTier = new Map();
  const byBrowser = new Map();
  const byGpu = new Map();
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
    for (const [map, key] of [[byTier, dev.gpu_tier || 'unknown'], [byBrowser, dev.browser || 'unknown'], [byGpu, dev.gpu || 'unknown']]) {
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
      pct_over_budget: round(g.ft.fractionAbove(budget * 1.15) * 100, 1),
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
      pct_frames_over_budget: round(all.fractionAbove(budget * 1.15) * 100, 1),
      hitches: total.hitches,
      hitches_per_min: frameSeconds ? round(total.hitches / (frameSeconds / 60), 2) : null,
      frozen_frames: total.frozen,
      draw_calls: total.calls[1] ? Math.round(meanOf(total.calls, FIXED.calls)) : null,
      render_cpu_ms: total.render[1] ? round(meanOf(total.render, FIXED.render), 2) : null,
      ttff_p50: quantile(sessions.map((s) => s.ttff).filter(isNum), 0.5),
      ttff_p95: quantile(sessions.map((s) => s.ttff).filter(isNum), 0.95),
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
export function eventLift(ctx, level = undefined, windowS = 1.5) {
  const hitches = hitchCount(ctx, level);
  if (!hitches) return [];
  const f = mergedFacts(ctx, level);
  let fixedSeconds = 0;
  for (const { c } of cellsOf(ctx)) if (level === undefined || c.level === level) fixedSeconds += c.sec;
  const seconds = fixedSeconds / FIXED.sec;
  const inHitch = {};
  for (const name of keysBySeen(f.hn)) inHitch[name] = f.hr[name];
  return Object.entries(inHitch)
    .map(([event, n]) => {
      const share = n / hitches;
      const rate = seconds ? (f.cr[event] || 0) / seconds : 0;
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

export function errorIssues(ctx) {
  return errorList(ctx).map((i) => ({ ...i, breadcrumbs: breadcrumbs(ctx, i.sample_session, i.sample_ts) }));
}

// Issues by fingerprint, most sessions first, without breadcrumbs (a store fetches those for the
// samples listed here when it has no raw events).
export function errorList(ctx) {
  const errors = {};
  const series = new Map();
  const totalSessions = ctx.sessions.size || 1;
  const nb = ctx.buckets.length;
  for (const { m, c } of factsOf(ctx)) {
    mergeErrors(errors, c.er);
    for (const [key, x] of Object.entries(c.er)) {
      if (!series.has(key)) series.set(key, new Array(nb).fill(0));
      series.get(key)[bucketIndex(ctx, m)] += x.n;
    }
  }
  // In the order each issue first occurred, as the raw events would list them.
  const list = Object.entries(errors)
    .map(([key, x]) => ({ x, series: series.get(key) }))
    .sort((a, b) => a.x.first.ts - b.x.first.ts)
    .map(({ x, series }) => {
      const e = x.first;
      const sessions = Object.keys(x.sessions).length;
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
        players: Object.keys(x.players).length,
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
  const levels = new Map();
  const get = (l) => {
    let v = levels.get(l);
    if (!v) levels.set(l, (v = { level: l, sessions_started: new Set(), sessions_completed: new Set(), players: new Set(), attempts: 0, completes: 0, fails: 0, deaths: 0, durations: [], causes: {}, rage_quits: 0 }));
    return v;
  };
  const durations = [];
  for (const s of ctx.sessions.values()) {
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
        if (isNum(duration)) durations.push([ts, l, duration]);
      } else if (kind === MARK.fail) {
        l.fails++;
      } else {
        l.deaths++;
        l.causes[cause] = (l.causes[cause] || 0) + 1;
      }
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
      avg_complete_s: l.durations.length ? round(avg(l.durations), 1) : null,
      death_causes: l.causes,
      rage_quits: l.rage_quits,
      rage_quit_pct: pct(l.rage_quits, l.sessions_started.size || 1),
    })),
    'level',
  );
}

export function players(ctx) {
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
      avg_session_s: round(avg(sessions.map((s) => s.duration_s)), 1),
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
  };
}

export function heatmap(ctx, level, maps) {
  const map = pickMap(maps, level, ctx.q.version);
  // No captured map: side-scrollers report z≈0 everywhere, so fall back to a side (xy) view.
  const pos = positionsOf(ctx, level);
  const axis = map?.axis || (pos.some((e) => e.pts?.some((p) => Math.abs(p[3]) > 0.01)) ? 'xz' : 'xy');
  const pick = (x, y, z) => (axis === 'xy' ? [x, y] : [x, z]);
  const deaths = [];
  const rageSessions = new Map();
  for (const s of ctx.sessions.values()) if (s.rage_quit && s.rage?.level === level) rageSessions.set(s.session_id, s.rage.ts);
  // Deaths without coordinates (the Godot SDK's anonymous mode leaves them out) can't be placed.
  for (const d of deathsOf(ctx, level)) {
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
    stats: funnel(ctx).find((f) => f.level === level) || null,
  };
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

export function deathHotspots(deaths, axis = 'xz', binSize = 2) {
  deaths = deaths.filter((d) => isNum(d.x));
  if (!deaths.length) return [];
  const bins = new Map();
  for (const d of deaths) {
    const a = Math.floor(d.x / binSize);
    const b = Math.floor((axis === 'xy' ? d.y : d.z) / (binSize * 2));
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

export function sessionsList(ctx, { limit = 300 } = {}) {
  return [...ctx.sessions.values()]
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

export function versions(ctx) {
  const sessionsBy = new Map();
  for (const s of ctx.sessions.values()) {
    if (!sessionsBy.has(s.version)) sessionsBy.set(s.version, []);
    sessionsBy.get(s.version).push(s);
  }
  const framesBy = new Map();
  for (const { c } of cellsOf(ctx)) {
    if (!sessionsBy.has(c.version)) continue;
    if (!framesBy.has(c.version)) framesBy.set(c.version, []);
    framesBy.get(c.version).push(c);
  }
  const list = [...sessionsBy].map(([version, sessions]) => ({ version, ...summarize(sessions, framesBy.get(version) || []) }));
  return list.sort((a, b) => a.first_seen - b.first_seen);
}

// The metrics both a version comparison and a playtest run report for one group of sessions; frame
// time and renderer cost come from the rollup cells of those sessions' events.
function summarize(sessions, cells) {
  let first_seen = Infinity;
  let last_seen = 0;
  let starts = 0;
  let completes = 0;
  let hitches = 0;
  for (const s of sessions) {
    first_seen = Math.min(first_seen, s.start ?? s.first_ts);
    last_seen = Math.max(last_seen, s.last_ts);
    starts += Object.values(s.attempts).reduce((a, b) => a + b, 0);
    completes += s.completes;
    hitches += s.hitches;
  }
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
  const n = sessions.length || 1;
  return {
    sessions: sessions.length,
    players: new Set(sessions.map((s) => s.player_id)).size,
    first_seen,
    last_seen,
    crash_free_pct: pct(sessions.filter((s) => !s.crashed).length, n),
    error_free_pct: pct(sessions.filter((s) => s.errors === 0).length, n),
    errors_per_session: round(sessions.reduce((a, s) => a + s.errors, 0) / n, 2),
    frame_p50: round(sketch.quantile(0.5), 2),
    frame_p95: round(sketch.quantile(0.95), 2),
    frame_p99: round(sketch.quantile(0.99), 2),
    hitches_per_min: frameSeconds ? round(hitches / (frameSeconds / 60), 2) : null,
    // Renderer cost per frame: on fast GPUs vsync hides a perf bug in frame time, these don't.
    draw_calls: total.calls[1] ? Math.round(meanOf(total.calls, FIXED.calls)) : null,
    render_cpu_ms: total.render[1] ? round(meanOf(total.render, FIXED.render), 2) : null,
    level_completion_pct: pct(completes, starts || 1),
    rage_quit_pct: pct(sessions.filter((s) => s.rage_quit).length, n),
    deaths_per_session: round(sessions.reduce((a, s) => a + s.deaths, 0) / n, 2),
    geometries_growth_per_level_load: quantile(
      sessions.filter((s) => s.geo_first != null && s.level_loads >= 2).map((s) => (s.geo_last - s.geo_first) / (s.level_loads - 1)),
      0.5,
    ),
    level_p95: levelP95,
  };
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

function tierRank(t) {
  return { high: 0, mid: 1, low: 2, software: 3, unknown: 4 }[t] ?? 5;
}
