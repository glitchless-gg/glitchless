// Matches (docs/design/genre-coverage.md A7, A8, A9; SPEC §3 matches): everyone in one match, lobby or battle, from
// every side. A match is a group ID the game's server made (A7), hashed the same way by every SDK, so a browser player,
// a Unity player and the Node server of one match send one ID; every event and window carries it while it is set.
//
//   matches          the range's matches: { id, from, to, duration_s, sessions, level, attrs, outcomes, disconnects,
//                    ping_p50, ping_p95, lag_pct, server }, the most recent first, or the worst by lag or disconnects
//   matches?id=      one match: each session's frame and network windows in 30-second slots from the match's first
//                    event, its level outcomes and disconnects, the server's ticks in the same slots, and the slots
//                    where the whole lobby lagged at once (the server) or one player did (their connection)
//
// These read raw events (the game's, and its companion service's for the server side, A9): a store without them reads
// its raw rows (Glitchless Cloud: the last 31 days of a longer range).

import { Sketch } from '../../packages/sdk/src/sketch.js';
import { NET_ALPHA } from '../../packages/sdk/src/net.js';
import { platformOf } from './analytics.js';

export const SLOT_MS = 30_000;
// Lag: share of a connected player's time with a round trip over this (SPEC §4).
export const LAG_MS = 150;
// A lobby spike (finding 1): in one slot, this share of the match's sessions with network data (at least LOBBY_MIN)
// at twice their own median ping and SPIKE_MS over it.
export const LOBBY_SHARE = 0.6;
export const LOBBY_MIN = 4;
export const SPIKE_MS = 50;
const LIST = 100;

function outcomeOf(e) {
  if (e.type === 'level_complete') return 'complete';
  if (e.type === 'level_fail') return e.cause === 'abandon' ? 'abandon' : 'fail';
  if (e.type === 'level_abandon') return e.reason === 'disconnect' ? 'disconnect' : 'abandon';
  return null;
}

// Every match of the context's events (and the companion's, `serverEvents`): Map(id → match being built).
function collect(events, serverEvents = []) {
  const matches = new Map();
  const get = (id) => {
    let m = matches.get(id);
    if (!m) matches.set(id, (m = { id, from: Infinity, to: -Infinity, sessions: new Set(), servers: new Set(), levels: new Map(), attrs: null, attrsAt: Infinity, outcomes: {}, disconnects: {}, rtt: new Sketch(NET_ALPHA), lagSec: 0, netSec: 0, ticks: new Sketch(), players: 0 }));
    return m;
  };
  const touch = (m, e) => {
    if (e.ts < m.from) m.from = e.ts;
    if (e.ts > m.to) m.to = e.ts + (e.type === 'frame_window' || e.type === 'server_window' ? (e.duration_s || 0) * 1000 : 0);
  };
  for (const [list, server] of [
    [events, false],
    [serverEvents, true],
  ]) {
    for (const e of list) {
      const id = e.match ?? (e.type === 'group' && e.kind === 'match' ? e.id || e.ended : null);
      if (!id) continue;
      const m = get(id);
      touch(m, e);
      (server ? m.servers : m.sessions).add(e.session_id);
      if (e.type === 'group' && e.attrs && e.ts < m.attrsAt) [m.attrs, m.attrsAt] = [e.attrs, e.ts];
      if (e.type === 'level_start' && e.level) m.levels.set(e.level, (m.levels.get(e.level) || 0) + 1);
      if (server) {
        if (e.type === 'server_window') {
          if (e.tick) m.ticks.merge(e.tick);
          if (e.players_max > m.players) m.players = e.players_max;
        }
        continue;
      }
      const outcome = outcomeOf(e);
      if (outcome) m.outcomes[outcome] = (m.outcomes[outcome] || 0) + 1;
      if (e.type === 'disconnect') m.disconnects[e.reason || 'other'] = (m.disconnects[e.reason || 'other'] || 0) + 1;
      if (e.type === 'frame_window' && e.net && !e.net.host) {
        const sec = e.duration_s || 0;
        m.netSec += sec;
        if (e.net.rtt?.n) {
          m.rtt.merge(e.net.rtt);
          m.lagSec += Sketch.from(e.net.rtt).fractionAbove(LAG_MS) * sec;
        }
      }
    }
  }
  return matches;
}

function summary(m) {
  const level = [...m.levels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const disconnects = Object.values(m.disconnects).reduce((a, n) => a + n, 0);
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    duration_s: Math.round((m.to - m.from) / 1000),
    sessions: m.sessions.size,
    level,
    attrs: m.attrs,
    outcomes: m.outcomes,
    disconnects,
    disconnect_reasons: m.disconnects,
    ping_p50: m.rtt.n ? round(m.rtt.quantile(0.5), 1) : null,
    ping_p95: m.rtt.n ? round(m.rtt.quantile(0.95), 1) : null,
    lag_pct: m.netSec ? round((m.lagSec / m.netSec) * 100, 1) : null,
    server: m.servers.size ? { sessions: m.servers.size, tick_p95: m.ticks.n ? round(m.ticks.quantile(0.95), 2) : null, players_max: m.players } : null,
  };
}

// The range's matches: `sort` recent (default), lag (the worst ping p95 first) or disconnects; at most `limit`.
export function matchList(ctx, { sort = 'recent', limit = LIST } = {}) {
  const all = [...collect(ctx.events || [], ctx.server?.events || []).values()].filter((m) => m.sessions.size || m.servers.size).map(summary);
  const by = {
    lag: (a, b) => (b.ping_p95 ?? -1) - (a.ping_p95 ?? -1) || b.from - a.from,
    disconnects: (a, b) => b.disconnects - a.disconnects || b.from - a.from,
    recent: (a, b) => b.from - a.from,
  };
  all.sort(by[sort] || by.recent);
  return { matches: all.slice(0, limit), total: all.length, sort: by[sort] ? sort : 'recent' };
}

// One match, slot by slot: { id, from, to, duration_s, level, attrs, outcomes, disconnects, ping_p95, slots: [t, …]
// (seconds from the start), sessions: [{ session_id, version, platform, props, level, outcome, from_s, to_s,
// disconnects: [{ t, reason }], ping_p50, ping_p95, slots: [{ t, fps, frame_p95, ping_p50, ping_p95, loss_pct, hitches,
// spike }] }], server: [{ session_id, slots: [{ t, tick_p95, late, players, net_objects }] }], lobby_spikes: [t],
// events: [{ t, session_id, type, level, name, reason }] } or null.
export function matchDetail(ctx, id) {
  const m = collect(ctx.events || [], ctx.server?.events || []).get(id);
  if (!m) return null;
  const base = summary(m);
  const start = m.from;
  const slotOf = (ts) => Math.max(0, Math.floor((ts - start) / SLOT_MS));
  const sessions = new Map();
  const timeline = [];
  for (const e of ctx.events || []) {
    if (e.match !== id && !(e.type === 'group' && e.kind === 'match' && (e.id === id || e.ended === id))) continue;
    let s = sessions.get(e.session_id);
    if (!s) sessions.set(e.session_id, (s = { session_id: e.session_id, version: e.version, from: e.ts, to: e.ts, level: null, outcome: null, disconnects: [], rtt: new Sketch(NET_ALPHA), slots: new Map() }));
    if (e.ts < s.from) s.from = e.ts;
    if (e.ts > s.to) s.to = e.ts;
    if (e.type === 'level_start') s.level = e.level;
    const outcome = outcomeOf(e);
    if (outcome) s.outcome = outcome;
    if (e.type === 'disconnect') s.disconnects.push({ t: round((e.ts - start) / 1000, 1), reason: e.reason });
    if (e.type === 'frame_window') {
      const x = slotRow(s.slots, slotOf(e.ts));
      x.frames += e.frames || 0;
      x.sec += e.duration_s || 0;
      x.hitches += e.hitches || 0;
      if (e.ft) x.ft.merge(e.ft);
      if (e.net && !e.net.host && e.net.rtt?.n) {
        x.rtt.merge(e.net.rtt);
        s.rtt.merge(e.net.rtt);
        if (e.net.loss_pct != null) x.loss.push(e.net.loss_pct);
      }
    }
    if (['level_start', 'level_complete', 'level_fail', 'level_abandon', 'death', 'disconnect', 'reconnect', 'error', 'custom', 'group'].includes(e.type)) {
      timeline.push({ t: round((e.ts - start) / 1000, 1), session_id: e.session_id, type: e.type, level: e.level ?? null, name: e.name ?? e.cause ?? e.kind ?? null, ...(e.reason ? { reason: e.reason } : {}), ...(e.message ? { message: String(e.message).slice(0, 120) } : {}) });
    }
  }
  const servers = new Map();
  for (const e of ctx.server?.events || []) {
    if (e.match !== id || e.type !== 'server_window') continue;
    let s = servers.get(e.session_id);
    if (!s) servers.set(e.session_id, (s = { session_id: e.session_id, slots: new Map() }));
    const x = slotRow(s.slots, slotOf(e.ts));
    if (e.tick) x.tick.merge(e.tick);
    x.late += e.late || 0;
    x.players = Math.max(x.players, e.players ?? 0);
    if (e.net_objects != null) x.net_objects = Math.max(x.net_objects ?? 0, e.net_objects);
  }
  const lastSlot = slotOf(m.to);
  const slots = Array.from({ length: lastSlot + 1 }, (_, i) => (i * SLOT_MS) / 1000);
  // Each session's own median ping over the match, and the slots where it was twice that and SPIKE_MS over.
  const spikes = new Map(); // slot → sessions with network data that spiked
  const withNet = new Map(); // slot → sessions with network data
  const rows = [...sessions.values()].map((s) => {
    const median = s.rtt.n ? s.rtt.quantile(0.5) : null;
    const out = [...s.slots]
      .sort((a, b) => a[0] - b[0])
      .map(([i, x]) => {
        const p50 = x.rtt.n ? x.rtt.quantile(0.5) : null;
        const spike = median != null && p50 != null && p50 >= median * 2 && p50 >= median + SPIKE_MS;
        if (p50 != null) {
          withNet.set(i, (withNet.get(i) || 0) + 1);
          if (spike) spikes.set(i, (spikes.get(i) || 0) + 1);
        }
        return { t: (i * SLOT_MS) / 1000, fps: x.sec ? round(x.frames / x.sec, 1) : null, frame_p95: x.ft.n ? round(x.ft.quantile(0.95), 1) : null, ping_p50: p50 == null ? null : round(p50, 1), ping_p95: x.rtt.n ? round(x.rtt.quantile(0.95), 1) : null, loss_pct: x.loss.length ? round(x.loss.reduce((a, v) => a + v, 0) / x.loss.length, 2) : null, hitches: x.hitches, ...(spike ? { spike: true } : {}) };
      });
    const dev = ctx.sessions?.get(s.session_id);
    return {
      session_id: s.session_id,
      version: s.version,
      platform: dev ? platformOf(dev.device) : null,
      ...(dev?.prop && Object.keys(dev.prop).length ? { props: dev.prop } : {}),
      level: s.level,
      outcome: s.outcome,
      from_s: round((s.from - start) / 1000, 1),
      to_s: round((s.to - start) / 1000, 1),
      disconnects: s.disconnects,
      ping_p50: median == null ? null : round(median, 1),
      ping_p95: s.rtt.n ? round(s.rtt.quantile(0.95), 1) : null,
      slots: out,
    };
  });
  const lobby = [...withNet].filter(([i, n]) => n >= LOBBY_MIN && (spikes.get(i) || 0) / n >= LOBBY_SHARE).map(([i]) => (i * SLOT_MS) / 1000).sort((a, b) => a - b);
  const server = [...servers.values()].map((s) => ({
    session_id: s.session_id,
    // The tick budget, ms: 1000 over the server's target tick rate (A9 session_start.server.tick_hz).
    budget_ms: ctx.server?.sessions?.get(s.session_id)?.server?.tick_hz > 0 ? round(1000 / ctx.server.sessions.get(s.session_id).server.tick_hz, 2) : null,
    slots: [...s.slots].sort((a, b) => a[0] - b[0]).map(([i, x]) => ({ t: (i * SLOT_MS) / 1000, tick_p95: x.tick.n ? round(x.tick.quantile(0.95), 2) : null, late: x.late, players: x.players, net_objects: x.net_objects ?? null })),
  }));
  return { ...base, slot_s: SLOT_MS / 1000, slots, sessions: rows.sort((a, b) => a.from_s - b.from_s), server, lobby_spikes: lobby, events: timeline.sort((a, b) => a.t - b.t).slice(0, 500) };
}

function slotRow(map, i) {
  let x = map.get(i);
  if (!x) map.set(i, (x = { frames: 0, sec: 0, hitches: 0, ft: new Sketch(), rtt: new Sketch(NET_ALPHA), loss: [], tick: new Sketch(), late: 0, players: 0, net_objects: null }));
  return x;
}

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return null;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
