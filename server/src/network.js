// Network quality and disconnects (docs/design/genre-coverage.md A8; SPEC §2 frame_window.net, disconnect, §3b net,
// §4): ping, packet loss, lag and dropped players in every online game, and the findings that tell a whole lobby
// lagging (the server) from one player lagging (their connection).
//
// The cells keep each minute's network windows (rollups.js `net`: a round-trip sketch, seconds connected and over
// LAG_MS, loss and jitter, disconnects by reason), so ping and disconnects are exact over any range by version, level
// and zone; by a session split ($platform, $link) or a property ($region) they come from the sessions' own windows, over
// 31 days or less. A disconnect with a level open ends the attempt as an abandon (`level_abandon` reason disconnect):
// never a fail, never a rage quit, and walls leave it out.
//
//   metrics   ping_p50, ping_p95, loss_pct, disconnects_per_hour, disconnect_pct (level attempts a disconnect ended;
//             without levels, the connected sessions that dropped)
//   panel     `net` with `show` ping (p50 and p95 over time, and the share of play over 150 ms), loss, or disconnects
//             (per hour played, by reason), and `by` a dimension, a session split or a property
//   view      the Performance view's `network` section
//   findings  net-lobby-<level> (finding 1), net-link-, net-platform-, net-prop-<key>- (2), net-region- (3),
//             disconnect-<version> (4)

import { cellsOf, funnel, sessionSplit, round, pct, quantile } from './analytics.js';
import { newNet, mergeNet, FIXED, LAG_MS } from './rollups.js';
import { hoursPlayed, hoursBy, perHour, hoursRound } from './rates.js';
import { SLOT_MS } from './session-state.js';
import { propertyStats } from './properties.js';
import { bucketOf } from './occurrences.js';

export const NET_METRICS = { ping_p50: { label: 'Ping, median', unit: 'ms' }, ping_p95: { label: 'Ping for the slowest 5%', unit: 'ms' }, loss_pct: { label: 'Packet loss', unit: '%' }, disconnects_per_hour: { label: 'Disconnects per hour played', unit: 'per hour' }, disconnect_pct: { label: 'Attempts ended by a disconnect', unit: '%' } };
export const NET_SHOW = ['ping', 'loss', 'disconnects'];
// A player's connection, in words (the SDKs' `link`: what the device says it is on).
export const LINKS = { wifi: 'Wi-Fi', cellular: 'Mobile data', wired: 'Wired' };
const UNKNOWN_LINK = 'Unknown connection';

// The kind of connection a session played most of its connected time on, in words.
export function linkOf(s) {
  const links = s.cell?.net?.links;
  const [best] = Object.entries(links || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return best ? LINKS[best[0]] : UNKNOWN_LINK;
}

// One group's numbers from its merged net (rollups.js), the hours played it is read against and its attempts.
function numbers(n, hours, { attempts = null, dropped = null, sessions = null } = {}) {
  const dc = Object.values(n.dc).reduce((a, k) => a + k, 0);
  return {
    ping_p50: n.rtt.n ? round(n.rtt.quantile(0.5), 1) : null,
    ping_p95: n.rtt.n ? round(n.rtt.quantile(0.95), 1) : null,
    lag_pct: n.ssec ? round((n.lag / n.ssec) * 100, 1) : null,
    loss_pct: n.loss[1] ? round(n.loss[0] / FIXED.net / n.loss[1], 2) : null,
    jitter_ms: n.jitter[1] ? round(n.jitter[0] / FIXED.net / n.jitter[1], 1) : null,
    connected_h: hoursRound(n.sec / FIXED.sec / 3600),
    disconnects: dc,
    disconnect_reasons: n.dc,
    reconnects: n.rc,
    disconnects_per_hour: perHour(dc, hours),
    hours: hoursRound(hours),
    disconnect_pct: attempts ? pct(dropped, attempts) : null,
    ...(sessions != null ? { sessions } : {}),
  };
}

// Level attempts a disconnect ended, out of all attempts, from the level funnel; a game without levels: its connected
// sessions that dropped (31 days or less).
function disconnectShare(ctx) {
  const rows = funnel(ctx);
  const attempts = rows.reduce((a, r) => a + r.attempts, 0);
  if (attempts) return { attempts, dropped: rows.reduce((a, r) => a + (r.disconnects || 0), 0) };
  if (ctx.daily) return { attempts: null, dropped: null };
  let connected = 0;
  let dropped = 0;
  for (const s of ctx.sessions.values()) {
    if (!s.cell.net) continue;
    connected++;
    if (s.disc?.length) dropped++;
  }
  return { attempts: connected || null, dropped };
}

// The context's network numbers: { ping_p50, ping_p95, lag_pct, loss_pct, jitter_ms, connected_h, disconnects,
// disconnect_reasons, reconnects, disconnects_per_hour, hours, disconnect_pct }, or null without network data.
export function netStats(ctx) {
  if (ctx.netStats !== undefined) return ctx.netStats;
  const n = newNet();
  let any = false;
  for (const { c } of cellsOf(ctx)) {
    if (!c.net) continue;
    any = true;
    mergeNet(n, c.net);
  }
  return (ctx.netStats = any ? numbers(n, hoursPlayed(ctx), disconnectShare(ctx)) : null);
}

// Network numbers per value of `by`: $version, $level or $zone from the cells; a session split ($platform, $link) or a
// property from the sessions' own windows. → [{ value, …numbers }], the most connected time first.
export function netBy(ctx, by) {
  const dim = by.slice(1);
  const groups = new Map();
  const group = (v) => groups.get(v) ?? groups.set(v, { net: newNet(), sessions: new Set(), attempts: 0, dropped: 0, sec: 0, dropouts: 0 }).get(v);
  if (dim === 'version' || dim === 'level' || dim === 'zone') {
    for (const { c } of cellsOf(ctx)) if (c.net) mergeNet(group(String(c[dim] ?? '(none)')).net, c.net);
    const hours = hoursBy(ctx, dim);
    const levels = dim === 'level' ? new Map(funnel(ctx).map((r) => [String(r.level), r])) : null;
    for (const s of dim === 'version' && !ctx.daily ? ctx.sessions.values() : []) {
      const g = groups.get(String(s.version));
      if (!g) continue;
      g.sessions.add(s.session_id);
      g.attempts += Object.values(s.attempts).reduce((a, k) => a + k, 0);
      g.dropped += Object.values(s.dropped || {}).reduce((a, k) => a + k, 0);
    }
    return [...groups]
      .map(([value, g]) => {
        const l = levels?.get(value);
        const share = l ? { attempts: l.attempts, dropped: l.disconnects } : g.attempts ? { attempts: g.attempts, dropped: g.dropped } : {};
        return { value, ...numbers(g.net, hours.get(value) ?? 0, { ...share, sessions: dim === 'version' && !ctx.daily ? g.sessions.size : null }) };
      })
      .sort((a, b) => b.connected_h - a.connected_h || (a.value < b.value ? -1 : 1));
  }
  const split = sessionSplit(ctx, dim);
  if (!split || ctx.daily) return [];
  for (const s of ctx.sessions.values()) {
    if (!s.cell.net) continue;
    const g = group(split.of(s));
    mergeNet(g.net, s.cell.net);
    g.sessions.add(s.session_id);
    g.sec += s.cell.sec;
    g.attempts += Object.values(s.attempts).reduce((a, k) => a + k, 0);
    g.dropped += Object.values(s.dropped || {}).reduce((a, k) => a + k, 0);
    if (s.disc?.length) g.dropouts++;
  }
  // Without level attempts, the share of the group's connected sessions that dropped.
  const share = (g) => (g.attempts ? { attempts: g.attempts, dropped: g.dropped } : { attempts: g.sessions.size, dropped: g.dropouts });
  return [...groups]
    .map(([value, g]) => ({ value, ...numbers(g.net, g.sec / FIXED.sec / 3600, { ...share(g), sessions: g.sessions.size }) }))
    .sort((a, b) => b.sessions - a.sessions || (a.value < b.value ? -1 : 1));
}

// A `net` panel (SPEC §3b): `show` ping, loss or disconnects, over time and with `by` per value.
export function netPanel(ctx, p) {
  const total = netStats(ctx);
  if (!total) return { empty: true, why: 'No network data in this window: the game sends its ping with netSample, or its netcode is read by the SDK.' };
  const show = p.show || 'ping';
  const nb = ctx.buckets.length;
  const series = Array.from({ length: nb }, () => newNet());
  for (const { m, c } of cellsOf(ctx)) if (c.net) mergeNet(series[bucketOf(ctx, m)], c.net);
  const sessionDim = p.by && !['$version', '$level', '$zone'].includes(p.by);
  if (sessionDim && ctx.daily) return { empty: true, why: `Split by ${p.by} over 31 days or less: longer ranges are answered by day, without each session.` };
  const rows = p.by ? netBy(ctx, p.by) : null;
  const out = { show, ts: ctx.buckets, kpis: total, ...(p.by ? { by: p.by, rows: rows.slice(0, p.limit || 10), more: Math.max(0, rows.length - (p.limit || 10)) } : {}) };
  if (show === 'ping') {
    return {
      ...out,
      p50: series.map((n) => (n.rtt.n ? round(n.rtt.quantile(0.5), 1) : null)),
      p95: series.map((n) => (n.rtt.n ? round(n.rtt.quantile(0.95), 1) : null)),
      lag_pct: series.map((n) => (n.ssec ? round((n.lag / n.ssec) * 100, 1) : null)),
      lag_ms: LAG_MS,
    };
  }
  if (show === 'loss') return { ...out, loss_pct: series.map((n) => (n.loss[1] ? round(n.loss[0] / FIXED.net / n.loss[1], 2) : null)), jitter_ms: series.map((n) => (n.jitter[1] ? round(n.jitter[0] / FIXED.net / n.jitter[1], 1) : null)) };
  const reasons = Object.entries(total.disconnect_reasons)
    .map(([reason, count]) => ({ reason, count, per_hour: perHour(count, total.hours) }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
  return { ...out, reasons, disconnects: series.map((n) => Object.values(n.dc).reduce((a, k) => a + k, 0)) };
}

// The Performance view's network section: the numbers, and by level, platform, kind of connection and version; with
// `byProp`, by that session property too (the performance query's by_prop, A6: ping by $region).
export function networkView(ctx, byProp = null) {
  const total = netStats(ctx);
  if (!total) return null;
  const rows = (by) => netBy(ctx, by).map(({ value, ...x }) => ({ key: value, ...x }));
  return { kpis: total, by_level: rows('$level'), by_version: rows('$version'), by_platform: ctx.daily ? [] : rows('$platform'), by_link: ctx.daily ? [] : rows('$link'), ...(byProp ? { by_prop: { key: byProp, rows: ctx.daily ? [] : rows(`$${byProp}`) } } : {}) };
}

// ───────────────────────────── findings ─────────────────────────────

// Finding 1 (net-lobby-<level>): split each match into 30-second slots; a slot is a lobby spike when at least 60% of the
// match's sessions with network data in it (4 or more) have ping at least twice their own median and 50 ms over it. A
// level where 10% or more of its matches (5 or more) have one gets a finding, with the minute it comes most often, and
// with the server's account of those slots where its servers send theirs (A9: ctx.server).
const LOBBY_SHARE = 0.6;
const LOBBY_MIN = 4;
const SPIKE_MS = 50;
const LOBBY_MATCHES = 5;
const LOBBY_PCT = 10;

export function lobbySpikes(ctx) {
  const matches = new Map(); // id → { level, sessions: [{ median, slots: Map(slot → ping) }] }
  for (const s of ctx.sessions.values()) {
    for (const [id, m] of Object.entries(s.mslots || {})) {
      const slots = new Map(Object.entries(m.s).map(([i, [sum, n]]) => [Number(i), sum / n]));
      if (!slots.size) continue;
      let x = matches.get(id);
      if (!x) matches.set(id, (x = { id, levels: new Map(), sessions: [] }));
      if (m.l) x.levels.set(m.l, (x.levels.get(m.l) || 0) + 1);
      x.sessions.push({ median: quantile([...slots.values()], 0.5), slots });
    }
  }
  const out = [];
  for (const x of matches.values()) {
    const start = Math.min(...x.sessions.flatMap((s) => [...s.slots.keys()]));
    const bySlot = new Map();
    for (const s of x.sessions) {
      for (const [i, ping] of s.slots) {
        const b = bySlot.get(i) ?? bySlot.set(i, { n: 0, spiked: 0 }).get(i);
        b.n++;
        if (ping >= s.median * 2 && ping >= s.median + SPIKE_MS) b.spiked++;
      }
    }
    const spikes = [...bySlot].filter(([, b]) => b.n >= LOBBY_MIN && b.spiked / b.n >= LOBBY_SHARE).map(([i]) => i);
    out.push({ id: x.id, level: [...x.levels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, sessions: x.sessions.length, start, spikes });
  }
  return out;
}

export function netFindings(ctx, vers, totalSessions) {
  const out = [];
  if (!netStats(ctx) && !ctx.server) return out;
  if (!ctx.daily) {
    out.push(...lobbyFindings(ctx, totalSessions));
    out.push(...groupLag(ctx, totalSessions));
    out.push(...regions(ctx, totalSessions));
  }
  const d = disconnectRise(ctx, vers, totalSessions);
  if (d) out.push(d);
  return out;
}

function lobbyFindings(ctx, totalSessions) {
  const byLevel = new Map();
  for (const m of lobbySpikes(ctx)) {
    if (m.sessions < LOBBY_MIN || !m.level) continue;
    const l = byLevel.get(m.level) ?? byLevel.set(m.level, { matches: 0, spiked: [], minutes: new Map(), sessions: 0 }).get(m.level);
    l.matches++;
    l.sessions += m.sessions;
    if (!m.spikes.length) continue;
    l.spiked.push(m);
    for (const i of m.spikes) {
      const minute = Math.floor(((i - m.start) * SLOT_MS) / 60_000);
      l.minutes.set(minute, (l.minutes.get(minute) || 0) + 1);
    }
  }
  const out = [];
  for (const [level, l] of byLevel) {
    if (l.matches < LOBBY_MATCHES || (l.spiked.length / l.matches) * 100 < LOBBY_PCT) continue;
    const [minute] = [...l.minutes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const server = serverInSpikes(ctx, l.spiked);
    const share = pct(l.spiked.length, l.matches);
    out.push({
      id: `net-lobby-${level}`,
      severity: share >= 25 ? 'high' : 'medium',
      category: 'network',
      title: `Whole lobbies on ${level} lag together, most often ${minute} to ${minute + 1} minutes in`,
      summary:
        `In ${l.spiked.length} of ${l.matches} matches on ${level} (${share}%), most of the lobby's ping jumped to twice its normal at the same time: that's the server or its network, not players' connections.` +
        (server ? ` Server tick p95 reaches ${server.during} ms then, against ${server.otherwise} ms the rest of the match${server.players ? `, with ${server.players} players connected` : ''}.` : ''),
      evidence: { level, matches: l.matches, matches_with_lobby_spike: l.spiked.length, share_pct: share, minute_most_often: minute, spikes_by_minute: Object.fromEntries([...l.minutes].sort((a, b) => a[0] - b[0])), example_matches: l.spiked.slice(0, 3).map((m) => m.id), ...(server ? { server } : {}) },
      suggestion: `Open one of these matches (glitchless_match, or the match page) and look at the server's ticks in the lagging slots: a tick over budget there is the simulation (too many players or objects at once at that moment); a smooth tick with lag is the server's network or host. Then profile that moment of the match on the server.`,
      link: { page: 'matches', match: l.spiked[0].id },
      impact: l.sessions / (totalSessions || 1),
    });
  }
  return out;
}

// The server's tick p95 in the lobby-spike slots against the rest of those matches (A9), from its sessions' slots.
function serverInSpikes(ctx, spiked) {
  if (!ctx.server) return null;
  const during = [];
  const otherwise = [];
  let players = 0;
  const want = new Map(spiked.map((m) => [m.id, new Set(m.spikes)]));
  for (const s of ctx.server.sessions.values()) {
    for (const [id, m] of Object.entries(s.mslots || {})) {
      const spikes = want.get(id);
      if (!spikes) continue;
      for (const [i, x] of Object.entries(m.s)) {
        const tick = x[0] / x[1];
        if (spikes.has(Number(i))) {
          during.push(tick);
          players = Math.max(players, x[2] ?? 0);
        } else otherwise.push(tick);
      }
    }
  }
  if (!during.length || !otherwise.length) return null;
  return { during: round(quantile(during, 0.5), 1), otherwise: round(quantile(otherwise, 0.5), 1), players: players || null };
}

// Finding 2: one kind of connection, platform or property value lags far more than the rest: its share of connected
// play over 150 ms is 3 times the others', with 30 or more sessions.
const LAG_GROUP = 30;
function groupLag(ctx, totalSessions) {
  const out = [];
  const dims = [['link', 'net-link'], ['platform', 'net-platform']];
  for (const stats of propertyStats(ctx).values()) if (!stats.identifier_like && stats.values.length >= 2 && stats.values.length <= 10 && stats.key !== 'region') dims.push([stats.key, `net-prop-${stats.key}`]);
  for (const [dim, prefix] of dims) {
    const rows = netBy(ctx, `$${dim}`).filter((r) => r.lag_pct != null && r.value !== UNKNOWN_LINK && r.value !== '(none)');
    if (rows.length < 2) continue;
    for (const r of rows) {
      if (r.sessions < LAG_GROUP) continue;
      const rest = rows.filter((o) => o !== r);
      const restLag = weighted(rest);
      if (restLag == null || r.lag_pct < Math.max(restLag * 3, 5)) continue;
      const what = dim === 'link' ? `Players on ${r.value.toLowerCase()}` : dim === 'platform' ? `Players on ${r.value}` : `Players with ${dim} ${r.value}`;
      out.push({
        id: `${prefix}-${slug(r.value)}`,
        severity: 'medium',
        category: 'network',
        title: `${what} lag ${round(r.lag_pct / Math.max(restLag, 0.1), 1)}× as often as the rest: ${r.lag_pct}% of their play is over ${LAG_MS} ms`,
        summary: `${r.sessions} sessions: ${r.lag_pct}% of their connected time had a round trip over ${LAG_MS} ms, against ${restLag}% for everyone else; their median ping is ${r.ping_p50} ms. When one group lags and the lobby doesn't, it's their connections, not the server.`,
        evidence: { by: `$${dim}`, value: r.value, sessions: r.sessions, lag_pct: r.lag_pct, rest_lag_pct: restLag, ping_p50: r.ping_p50, ping_p95: r.ping_p95, loss_pct: r.loss_pct, rows },
        suggestion: dim === 'link' ? 'Smooth over a weak connection: interpolate other players for longer, send less per tick on mobile data, and tell players their connection is the problem rather than the game.' : `Look at what sets ${r.value} apart on the network (its connection, its server region, the netcode path it takes), and send less or compensate more where it lags.`,
        link: { page: 'performance', section: 'network' },
        impact: r.sessions / (totalSessions || 1),
      });
    }
  }
  return out;
}

function weighted(rows) {
  const sec = rows.reduce((a, r) => a + (r.connected_h || 0), 0);
  if (!sec) return null;
  return round(rows.reduce((a, r) => a + (r.lag_pct || 0) * (r.connected_h || 0), 0) / sec, 1);
}

// Finding 3: no server near a region (a session property `region`, A6): its median ping over 120 ms, with 30 or more
// sessions.
const REGION_MS = 120;
function regions(ctx, totalSessions) {
  if (!propertyStats(ctx).has('region')) return [];
  const out = [];
  for (const r of netBy(ctx, '$region')) {
    if (r.value === '(none)' || r.sessions < LAG_GROUP || !(r.ping_p50 > REGION_MS)) continue;
    out.push({
      id: `net-region-${slug(r.value)}`,
      severity: 'medium',
      category: 'network',
      title: `Players in ${r.value} reach the servers at ${Math.round(r.ping_p50)} ms for most of their play: no server is near them`,
      summary: `${r.sessions} sessions with region ${r.value} have a median ping of ${r.ping_p50} ms (the slowest 5%: ${r.ping_p95} ms), over the ${REGION_MS} ms where play starts to feel late.`,
      evidence: { region: r.value, sessions: r.sessions, ping_p50: r.ping_p50, ping_p95: r.ping_p95, lag_pct: r.lag_pct },
      suggestion: `Add a server in or near ${r.value}, or match its players to the nearest one, and check the region players are sent to matches where they are.`,
      link: { page: 'performance', section: 'network' },
      impact: r.sessions / (totalSessions || 1),
    });
  }
  return out;
}

// Finding 4 (disconnect-<version>): the share of attempts a disconnect ended doubled and went up 2 points or more
// against the previous version (release order), with what ended most of them and when.
function disconnectRise(ctx, vers, totalSessions) {
  const [prev, cur] = vers.slice(-2);
  if (!prev || !cur) return null;
  const share = (v) => {
    const rows = netBy(ctx, '$version');
    return rows.find((r) => r.value === String(v.version));
  };
  const a = share(prev);
  const b = share(cur);
  if (!a || !b || a.disconnect_pct == null || b.disconnect_pct == null) return null;
  if (!(b.disconnect_pct >= a.disconnect_pct * 2 && b.disconnect_pct - a.disconnect_pct >= 2)) return null;
  const [reason, count] = Object.entries(b.disconnect_reasons).sort((x, y) => y[1] - x[1])[0] || [];
  const after = ctx.daily ? null : secondsIntoAttempt(ctx, cur.version);
  const oneIn = (p) => (p ? Math.round(100 / p) : null);
  return {
    id: `disconnect-${cur.version}`,
    severity: b.disconnect_pct >= 10 ? 'high' : 'medium',
    category: 'network',
    title: `1 attempt in ${oneIn(b.disconnect_pct)} ends in a disconnect in ${cur.version}, against 1 in ${oneIn(a.disconnect_pct)} in ${prev.version}`,
    summary: `${b.disconnect_pct}% of level attempts in ${cur.version} ended because the player lost the connection, against ${a.disconnect_pct}% in ${prev.version}.${reason ? ` Most are ${reason.replace('_', ' ')} (${count} of ${b.disconnects}).` : ''}${after != null ? ` Half of them come within ${Math.round(after)} s of the attempt's start.` : ''}`,
    evidence: { previous: { version: prev.version, disconnect_pct: a.disconnect_pct, disconnects: a.disconnects, reasons: a.disconnect_reasons }, current: { version: cur.version, disconnect_pct: b.disconnect_pct, disconnects: b.disconnects, reasons: b.disconnect_reasons }, ...(after != null ? { median_s_into_attempt: round(after, 1) } : {}) },
    suggestion: `Diff ${prev.version}..${cur.version} for what changed in the netcode, timeouts, the load at the start of a match (a long load can time a client out) and the servers the build talks to; reproduce a ${reason ?? 'disconnect'} with a network shaper.`,
    link: { page: 'performance', section: 'network' },
    impact: cur.sessions / (totalSessions || 1),
  };
}

// The median time from an attempt's start to the disconnect that ended it, in one version's sessions.
function secondsIntoAttempt(ctx, version) {
  const gaps = [];
  for (const s of ctx.sessions.values()) {
    if (String(s.version) !== String(version) || !s.disc?.length) continue;
    for (const d of s.disc) {
      const start = [...s.marks].reverse().find((m) => m.k === 0 && m.level === d.level && m.ts <= d.ts);
      if (start) gaps.push((d.ts - start.ts) / 1000);
    }
  }
  return gaps.length ? quantile(gaps, 0.5) : null;
}

function slug(v) {
  return String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

