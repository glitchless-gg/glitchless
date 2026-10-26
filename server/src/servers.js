// A game's servers (docs/design/genre-coverage.md A9; SPEC §3 servers, §3b servers panel, §4): dedicated and
// authoritative servers that run a Glitchless SDK in server mode. Intake files their batches under the game's companion
// service, `<service>.server` (ingest.js), so every count of players leaves them out; the game's own dashboard, its
// findings and the `servers` query read the companion (app.js puts its context in `ctx.server`).
//
//   metrics   servers_now (servers that sent anything in the last two minutes, and the players connected to them),
//             server_tick_p95, server_crash_free_pct, players_per_server
//   panel     `servers` with `show` ticks (tick time against its budget, `by` players connected, $level or $version),
//             players, or crashes
//   view      Servers: tick time by map and by players connected, crashes, versions, and long-running servers whose
//             memory climbs
//   findings  server-tick-<level> (finding 5: falling behind when full), server-error-<fingerprint> (6: a crash that
//             ends matches), server-leak-<version> (7: memory or objects that keep climbing)

import { cellsOf, errorIssues, errorSessions, gaugeClimbs, round, pct, quantile, naturalSort } from './analytics.js';
import { newServerCell, mergeServerCell, FIXED, MINUTE } from './rollups.js';
import { bucketOf } from './occurrences.js';

export const SERVER_METRICS = {
  servers_now: { label: 'Servers running' },
  server_tick_p95: { label: 'Server tick, slowest 5%', unit: 'ms' },
  server_crash_free_pct: { label: 'Server runs without a crash', unit: '%' },
  players_per_server: { label: 'Players per server' },
};
export const SERVERS_SHOW = ['ticks', 'players', 'crashes'];
const BY = ['players', '$level', '$version'];

// The budget a tick has, in ms: the windows' own (budget_ms), else 1000 over the servers' target tick rate.
export function tickBudget(sctx, sv = null) {
  const budgets = sv?.budgets ?? mergedServer(sctx).budgets;
  const values = Object.entries(budgets || {}).flatMap(([b, n]) => Array(Math.min(n, 1000)).fill(Number(b)));
  if (values.length) return round(quantile(values, 0.5), 2);
  const rates = [...sctx.sessions.values()].map((s) => s.server?.tick_hz).filter((v) => v > 0);
  return rates.length ? round(1000 / quantile(rates, 0.5), 2) : null;
}

function mergedServer(sctx) {
  if (sctx.serverCell) return sctx.serverCell;
  const sv = newServerCell();
  for (const { c } of cellsOf(sctx)) if (c.sv) mergeServerCell(sv, c.sv);
  return (sctx.serverCell = sv);
}

function rowOf(sv, extra = {}) {
  return {
    windows: sv.w,
    hours: round(sv.sec / FIXED.sec / 3600, 2),
    tick_p50: sv.tick.n ? round(sv.tick.quantile(0.5), 2) : null,
    tick_p95: sv.tick.n ? round(sv.tick.quantile(0.95), 2) : null,
    over_budget_pct: sv.w ? pct(sv.over, sv.w) : null,
    late_pct: sv.ticks ? pct(sv.late, sv.ticks) : null,
    tick_hz: sv.sec ? round(sv.ticks / (sv.sec / FIXED.sec), 1) : null,
    players: sv.players[1] ? round(sv.players[0] / sv.players[1], 1) : null,
    players_max: sv.pmax || null,
    cpu_pct: sv.cpu[1] ? round(sv.cpu[0] / FIXED.net / sv.cpu[1], 1) : null,
    mem_mb: sv.mem[1] ? round(sv.mem[0] / FIXED.net / sv.mem[1], 1) : null,
    mem_max_mb: sv.mmax || null,
    net_objects: sv.objs[1] ? Math.round(sv.objs[0] / sv.objs[1]) : null,
    rtt_p95: sv.rtt[1] ? round(sv.rtt[0] / FIXED.net / sv.rtt[1], 1) : null,
    ...extra,
  };
}

// The companion's numbers: { servers, crashed, crash_free_pct, budget_ms, …rowOf }, or null without server sessions.
export function serverStats(sctx) {
  if (!sctx || !sctx.sessions.size) return null;
  const sessions = [...sctx.sessions.values()];
  const crashed = sessions.filter((s) => s.crashed).length;
  const sv = mergedServer(sctx);
  return { servers: sessions.length, crashed, crash_free_pct: pct(sessions.length - crashed, sessions.length), budget_ms: tickBudget(sctx, sv), ...rowOf(sv) };
}

// Ticks per band of players connected: tenths of the servers' capacity (their max_players, else the most seen), from
// each server session's windows per players count (session-state.js svl). `level` keeps one map's.
export function byPlayers(sctx, level = null) {
  const counts = new Map(); // players → [windows, over, ticks, late, tick p95 sum]
  const caps = [];
  let most = 0;
  for (const s of sctx.sessions.values()) {
    if (s.server?.max_players > 0) caps.push(s.server.max_players);
    for (const [lv, byP] of Object.entries(s.svl || {})) {
      if (level != null && lv !== level) continue;
      for (const [players, x] of Object.entries(byP)) {
        const y = counts.get(Number(players)) ?? counts.set(Number(players), [0, 0, 0, 0, 0]).get(Number(players));
        for (let k = 0; k < 5; k++) y[k] += x[k] || 0;
        most = Math.max(most, Number(players));
      }
    }
  }
  if (!counts.size) return [];
  const capacity = caps.length ? quantile(caps, 0.5) : most;
  const size = Math.max(1, Math.ceil((capacity || 1) / 10));
  const bands = new Map();
  for (const [players, x] of counts) {
    const lo = Math.floor(players / size) * size;
    const b = bands.get(lo) ?? bands.set(lo, { lo, hi: lo + size - 1, w: 0, over: 0, ticks: 0, late: 0, p95: 0 }).get(lo);
    b.w += x[0];
    b.over += x[1];
    b.ticks += x[2];
    b.late += x[3];
    b.p95 += x[4];
  }
  return [...bands.values()]
    .sort((a, b) => a.lo - b.lo)
    // tick_p95: the band's windows' p95, averaged (a window keeps its own p95, not its ticks).
    .map((b) => ({ value: size === 1 ? `${b.lo} players` : `${b.lo}–${b.hi} players`, lo: b.lo, hi: b.hi, windows: b.w, over_budget_pct: pct(b.over, b.w), late_pct: b.ticks ? pct(b.late, b.ticks) : null, tick_p95: b.w ? round(b.p95 / b.w, 2) : null }));
}

// Ticks by $level or $version, from the companion's cells.
function byDimension(sctx, dim) {
  const groups = new Map();
  for (const { c } of cellsOf(sctx)) {
    if (!c.sv) continue;
    const k = String(c[dim] ?? '(none)');
    mergeServerCell(groups.get(k) ?? groups.set(k, newServerCell()).get(k), c.sv);
  }
  const servers = new Map();
  if (dim === 'version') for (const s of sctx.sessions.values()) servers.set(String(s.version), (servers.get(String(s.version)) || 0) + 1);
  const rows = [...groups].map(([value, sv]) => ({ value, ...rowOf(sv, dim === 'version' ? { servers: servers.get(value) ?? 0 } : {}) }));
  return dim === 'level' ? naturalSort(rows.map((r) => r.value)).map((v) => rows.find((r) => r.value === v)) : rows;
}

// Over time: tick p50 and p95, average players connected, servers running per bucket.
function series(sctx) {
  const nb = sctx.buckets.length;
  const per = Array.from({ length: nb }, () => newServerCell());
  for (const { m, c } of cellsOf(sctx)) if (c.sv) mergeServerCell(per[bucketOf(sctx, m)], c.sv);
  const servers = new Array(nb).fill(0);
  for (const s of sctx.sessions.values()) for (const i of new Set([...s.minutes].map((m) => bucketOf(sctx, m)))) servers[i]++;
  return {
    ts: sctx.buckets,
    tick_p50: per.map((x) => (x.tick.n ? round(x.tick.quantile(0.5), 2) : null)),
    tick_p95: per.map((x) => (x.tick.n ? round(x.tick.quantile(0.95), 2) : null)),
    players: per.map((x) => (x.players[1] ? round(x.players[0] / x.players[1], 1) : null)),
    servers,
  };
}

// Fatal errors on server sessions, each with the matches and players it ended: the matches its crashed sessions were
// in at the end (a match's last event within a minute of the session's), and the players connected then.
export function serverCrashes(sctx) {
  return errorIssues(sctx)
    .filter((i) => i.fatal)
    .map((i) => {
      const hit = errorSessions(sctx, i.fingerprint).filter((s) => s.crashed);
      const matches = new Set();
      let players = 0;
      for (const s of hit) {
        const end = s.end ?? s.last_ts;
        for (const g of s.groups || []) if (g.kind === 'match' && end - g.to <= MINUTE) matches.add(g.id);
        players += s.svLast?.[1] ?? 0;
      }
      const { breadcrumbs, series: _, ...rest } = i;
      return { ...rest, breadcrumbs, crashed_servers: hit.length, matches_ended: matches.size, players_dropped: players };
    })
    .sort((a, b) => b.matches_ended - a.matches_ended || b.players_dropped - a.players_dropped || b.sessions - a.sessions);
}

// Long-running servers whose memory or networked objects keep climbing (the climbing-gauge rule, SPEC §4).
function climbing(sctx) {
  const out = [];
  for (const s of sctx.sessions.values()) {
    for (const k of ['mem_mb', 'net_objects']) {
      const c = s.gauge_climbs?.[k];
      if (c) out.push({ session_id: s.session_id, version: s.version, gauge: k, first: c.first, last: c.last, hours: round(s.duration_s / 3600, 1) });
    }
  }
  return out.sort((a, b) => b.last / (b.first || 1) - a.last / (a.first || 1)).slice(0, 20);
}

function sessionRows(sctx) {
  return [...sctx.sessions.values()]
    .sort((a, b) => (b.start ?? b.first_ts) - (a.start ?? a.first_ts))
    .slice(0, 50)
    .map((s) => {
      const sv = s.cell.sv;
      return {
        session_id: s.session_id,
        version: s.version,
        start: s.start ?? s.first_ts,
        duration_s: round(s.duration_s, 0),
        build: s.server?.build ?? null,
        region: s.server?.region ?? null,
        max_players: s.server?.max_players ?? null,
        players_max: sv?.pmax || null,
        tick_p95: sv?.tick.n ? round(sv.tick.quantile(0.95), 2) : null,
        over_budget_pct: sv?.w ? pct(sv.over, sv.w) : null,
        crashed: s.crashed,
        ended: s.ended,
        end_reason: s.end_reason ?? null,
        matches: (s.groups || []).filter((g) => g.kind === 'match').length,
      };
    });
}

// The `servers` query and the Servers view: everything about a game's servers in the range.
export function serversView(ctx, live = null) {
  const sctx = ctx.server;
  const stats = serverStats(sctx);
  if (!stats) return { servers: null, ...(live ? { servers_now: live.servers, players_on_servers: live.players } : {}), why: "No server of this game sent anything in this window: a dedicated server runs the SDK in server mode (role: 'server')." };
  return {
    ...(live ? { servers_now: live.servers, players_on_servers: live.players } : {}),
    kpis: stats,
    series: series(sctx),
    by_level: byDimension(sctx, 'level'),
    by_version: byDimension(sctx, 'version'),
    by_players: byPlayers(sctx),
    crashes: serverCrashes(sctx).slice(0, 10),
    memory: gaugeClimbs(sctx).filter((g) => g.climbing),
    climbing: climbing(sctx),
    sessions: sessionRows(sctx),
  };
}

// A `servers` panel.
export function serversPanel(ctx, p) {
  const sctx = ctx.server;
  const stats = serverStats(sctx);
  if (!stats) return { empty: true, why: "No server of this game sent anything in this window: a dedicated server runs the SDK in server mode (role: 'server')." };
  const show = p.show || 'ticks';
  if (show === 'crashes') {
    const crashes = serverCrashes(sctx).slice(0, p.limit || 5);
    return { show, kpis: { servers: stats.servers, crashed: stats.crashed, crash_free_pct: stats.crash_free_pct }, crashes: crashes.map(({ fingerprint, message, kind, location, count, sessions, matches_ended, players_dropped, last_seen }) => ({ fingerprint, message, kind, location, count, sessions, matches_ended, players_dropped, last_seen })) };
  }
  const by = p.by || (show === 'ticks' ? 'players' : null);
  const rows = by === 'players' ? byPlayers(sctx) : by ? byDimension(sctx, by.slice(1)) : null;
  return { show, budget_ms: stats.budget_ms, kpis: stats, ...series(sctx), ...(by ? { by, rows } : {}) };
}

export function validServersPanel(p, at, BoardError) {
  const out = {};
  if (p.show != null) {
    if (!SERVERS_SHOW.includes(p.show)) throw new BoardError(`${at}.show is ${SERVERS_SHOW.join(', ')}`);
    out.show = p.show;
  }
  if (p.by != null) {
    if (!BY.includes(p.by)) throw new BoardError(`${at}.by is ${BY.join(', ')}`);
    out.by = p.by;
  }
  return out;
}

// ───────────────────────────── findings ─────────────────────────────

const OVER_PCT = 10;
const BAND_WINDOWS = 20;

export function serverFindings(ctx, totalSessions) {
  const sctx = ctx.server;
  if (!serverStats(sctx)) return [];
  const out = [];
  const budget = tickBudget(sctx);
  // Finding 5: servers fall behind when full: on a map, from some band of players connected up, every band has 10% or
  // more of its windows over budget, and some band below it doesn't.
  const levels = new Set();
  for (const s of sctx.sessions.values()) for (const l of Object.keys(s.svl || {})) levels.add(l);
  for (const level of levels) {
    const bands = byPlayers(sctx, level).filter((b) => b.windows >= BAND_WINDOWS);
    if (bands.length < 2) continue;
    let i = bands.length;
    while (i > 0 && bands[i - 1].over_budget_pct >= OVER_PCT) i--;
    if (i === bands.length || i === 0) continue;
    const from = bands[i];
    const full = bands.slice(i);
    const base = bands.slice(0, i);
    const worst = [...full].sort((a, b) => b.over_budget_pct - a.over_budget_pct)[0];
    const share = (list) => pct(list.reduce((a, b) => a + (b.over_budget_pct * b.windows) / 100, 0), list.reduce((a, b) => a + b.windows, 0));
    const fullPct = share(full);
    const basePct = share(base);
    const hz = budget ? Math.round(1000 / budget) : null;
    out.push({
      id: `server-tick-${level}`,
      severity: fullPct >= 30 ? 'high' : 'medium',
      category: 'performance',
      title: `Servers on ${level} miss their ${hz ? `${hz} Hz ` : ''}tick in ${fullPct}% of windows once ${from.lo} or more players are connected (with fewer: ${basePct}%)`,
      summary: `A server window is over budget when 5% or more of its ticks take longer than ${budget ?? 'the budget'} ms. On ${level}, ${bands.map((b) => `${b.value}: ${b.over_budget_pct}%`).join(', ')}.`,
      evidence: { level, budget_ms: budget, bands },
      suggestion: `Profile a full ${level} server at ${worst.value}: what grows with players (relevance and replication, physics bodies, AI, per-player loops), cut its cost per player or the tick rate under load, and compare this panel version by version.`,
      link: { page: 'servers', level },
      impact: 1 / Math.max(1, levels.size),
    });
  }
  // Finding 6: a server crash ends matches.
  for (const c of serverCrashes(sctx).slice(0, 5)) {
    if (!c.crashed_servers) continue;
    out.push({
      id: `server-error-${c.fingerprint}`,
      severity: c.matches_ended || c.players_dropped ? 'high' : 'medium',
      category: 'stability',
      title: `A server crash ${c.matches_ended ? `ended ${c.matches_ended} ${c.matches_ended === 1 ? 'match' : 'matches'}` : `stopped ${c.crashed_servers} ${c.crashed_servers === 1 ? 'server' : 'servers'}`}${c.players_dropped ? ` with ${c.players_dropped.toLocaleString('en-US')} players` : ''}: ${String(c.message).slice(0, 80)}`,
      summary: `${c.count} times on ${c.crashed_servers} server ${c.crashed_servers === 1 ? 'run' : 'runs'}${c.location ? ` at ${c.location}` : ''}, first seen in ${c.first_version}. Everyone connected to a server that crashes loses their match.`,
      evidence: { fingerprint: c.fingerprint, kind: c.kind, message: c.message, location: c.location, stack: c.stack?.split('\n').slice(0, 6).join('\n'), count: c.count, crashed_servers: c.crashed_servers, matches_ended: c.matches_ended, players_dropped: c.players_dropped, versions: c.versions, levels: c.levels, breadcrumbs: c.breadcrumbs },
      suggestion: `Read the stack and the server's events before it (glitchless_get_error on the companion service), reproduce it on a local server with the same map and player count, and guard or fix the failing path; a crash on a server is everyone's crash.`,
      link: { page: 'servers', fingerprint: c.fingerprint },
      impact: Math.min(1, (c.players_dropped || c.crashed_servers) / (totalSessions || 1)),
    });
  }
  // Finding 7: a long-running server leaks: memory, networked objects or a server gauge that keeps climbing.
  for (const g of gaugeClimbs(sctx)) {
    if (g.sessions < 3 || g.climbing / g.sessions < 0.6) continue;
    const versions = new Map();
    for (const s of sctx.sessions.values()) if (s.gauge_climbs?.[g.key]) versions.set(s.version, (versions.get(s.version) || 0) + 1);
    const [version] = [...versions].sort((a, b) => b[1] - a[1])[0];
    const what = g.key === 'mem_mb' ? 'Server memory' : g.key === 'net_objects' ? 'Networked objects on the server' : `The server's \`${g.key}\``;
    const unit = g.key === 'mem_mb' ? ' MB' : '';
    out.push({
      id: `server-leak-${version}`,
      severity: 'medium',
      category: 'performance',
      title: `${what} climbs from ${round(g.median_first, 0).toLocaleString('en-US')}${unit} to ${round(g.median_last, 0).toLocaleString('en-US')}${unit} over a server's life, and never comes down`,
      summary: `In ${g.climbing} of the ${g.sessions} server runs that report it, \`${g.key}\` only grew and was at its peak when the run ended (mostly ${version}). A server that runs for hours fills up and slows, then runs out.`,
      evidence: { gauge: g.key, version, sessions: g.sessions, climbing: g.climbing, median_first: g.median_first, median_last: g.median_last },
      suggestion: g.key === 'net_objects' ? 'Find what spawns networked objects and check each one is despawned when its match, player or effect ends; a pool that only grows is a leak.' : 'Take a heap snapshot of a server that has run for an hour, compare it with one at the start, and free what each finished match leaves behind (players, match state, timers, listeners).',
      link: { page: 'servers', section: 'memory' },
      impact: 1,
    });
  }
  return out;
}
