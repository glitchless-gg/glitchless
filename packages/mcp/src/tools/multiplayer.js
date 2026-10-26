// Multiplayer: matches from every side, the network players play over, and the game's dedicated servers
// (docs/design/genre-coverage.md A7, A8, A9). A match is a group ID the game's server made, shared by everyone in it;
// network quality comes from each frame window's `net` and the disconnects the SDKs send; a server runs the SDK in
// server mode and its sessions are kept under the game's companion service, "<game>.server".
import { z } from 'zod';
import { query, resolveService, range, reply, common, tool, filters, slimIssue } from '../context.js';

// "<game>.server" → "<game>": these tools read a game's servers through the game itself.
const gameOf = (svc) => (svc.endsWith('.server') ? svc.slice(0, -'.server'.length) : svc);

// Seconds into a match as m:ss.
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Slot starts (seconds) → stretches "3:00–4:00", each slot `step` seconds long.
function stretches(ts, step) {
  const out = [];
  for (const t of [...ts].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && t - last[1] <= step) last[1] = t;
    else out.push([t, t]);
  }
  return out.map(([a, b]) => `${clock(a)}–${clock(b + step)}`);
}

const median = (xs) => {
  const s = xs.filter((v) => v != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// What a match page says first: whether the whole lobby lagged at once (the server or its network) or players lagged
// on their own (their connections), and what the server's ticks did then.
function verdict(m) {
  const step = m.slot_s || 30;
  const lobby = new Set(m.lobby_spikes || []);
  const ticks = (m.server || []).flatMap((s) => s.slots);
  const budget = (m.server || []).find((s) => s.budget_ms != null)?.budget_ms ?? null;
  const during = median(ticks.filter((x) => lobby.has(x.t)).map((x) => x.tick_p95));
  const otherwise = median(ticks.filter((x) => !lobby.has(x.t)).map((x) => x.tick_p95));
  const alone = m.sessions.map((s) => ({ s, at: s.slots.filter((x) => x.spike && !lobby.has(x.t)).map((x) => x.t) })).filter((x) => x.at.length);
  const parts = [];
  if (lobby.size) {
    parts.push(`The whole lobby lagged at once at ${stretches(lobby, step).join(', ')}: that's the server or its network, not players' connections.`);
    if (during != null) parts.push(`The server's slowest ticks then: ${during} ms${budget ? ` against a ${budget} ms budget` : ''} (${otherwise ?? '?'} ms the rest of the match).`);
  } else parts.push('No moment where the whole lobby lagged at once.');
  if (alone.length) parts.push(`${alone.length} ${alone.length === 1 ? 'player' : 'players'} lagged on their own (their connection): ${alone.slice(0, 5).map((x) => `${x.s.session_id} at ${stretches(x.at, step).join(', ')}`).join('; ')}.`);
  if (m.disconnects) parts.push(`${m.disconnects} disconnected (${Object.entries(m.disconnect_reasons || {}).map(([r, n]) => `${n} ${r.replace('_', ' ')}`).join(', ')}).`);
  return parts.join(' ');
}

tool(
  'glitchless_match',
  "Matches of a multiplayer game, from every side (the game marks a match with setGroup('match', id), the ID its server made; every SDK hashes it the same way, so its players and its server join up). Without id: the window's matches, the most recent first, or the worst by lag (ping) or disconnects (sort), each with its level, players, outcomes, disconnects, ping and lag (the share of connected play over 150 ms), and its server's tick. With id: one match slot by slot (30 seconds) from its start, with a verdict that tells a whole lobby lagging at once (the server or its network) from one player lagging (their connection): each player's ping, frame time, outcome and disconnects, the server's ticks against its budget and the players connected in the same slots, and the match's events. slots: true gives every slot of every player.",
  {
    ...common,
    id: z.string().optional().describe('A match id (h_… or the game\'s own), from the list or a finding'),
    sort: z.enum(['recent', 'lag', 'disconnects']).optional().describe('Without id: recent (default), lag (the worst ping p95 first) or disconnects'),
    limit: z.number().int().min(1).max(200).optional().describe('Without id: how many matches (default 20)'),
    slots: z.boolean().optional().describe('With id: every 30-second slot of every player and server (long for a big match); by default only the slots that lagged'),
  },
  async ({ service, hours, id, sort, limit, slots, ...f }) => {
    const svc = gameOf(await resolveService(service));
    if (!id) {
      const d = await query('matches', { service: svc, ...filters(f), sort, limit: limit || 20, ...range(hours) });
      const brief = d.matches
        .map((m, i) => `${i + 1}. ${m.id}${m.level ? ` on ${m.level}` : ''}: ${m.sessions} players, ${clock(m.duration_s)}, ping p95 ${m.ping_p95 ?? '–'} ms${m.lag_pct != null ? ` (${m.lag_pct}% of play over 150 ms)` : ''}, ${m.disconnects} disconnects${m.server?.tick_p95 != null ? `, server tick p95 ${m.server.tick_p95} ms` : ''}`)
        .join('\n');
      return reply(`${d.total} match(es) in ${svc}${d.sort !== 'recent' ? `, the worst by ${d.sort} first` : ''}:\n${brief || 'None in this window: the game marks a match with setGroup("match", id).'}`, d.matches);
    }
    const d = await query('matches', { service: svc, ...filters(f), id, ...range(hours) });
    if (d.error || !d.match) return reply(`No match ${id} in ${svc} in this window (${hours || 24}h): glitchless_match without id lists them`, {});
    const m = d.match;
    const lobby = new Set(m.lobby_spikes || []);
    const players = m.sessions.map(({ slots: list, ...s }) => ({
      ...s,
      lagged_alone_at: list.filter((x) => x.spike && !lobby.has(x.t)).map((x) => x.t),
      frame_p95_worst: Math.max(...list.map((x) => x.frame_p95 ?? 0)) || null,
      hitches: list.reduce((n, x) => n + (x.hitches || 0), 0),
      ...(slots ? { slots: list } : {}),
    }));
    const servers = (m.server || []).map((s) => {
      const usual = median(s.slots.map((x) => x.tick_p95));
      const over = s.slots.filter((x) => x.tick_p95 != null && (s.budget_ms != null ? x.tick_p95 > s.budget_ms : usual != null && x.tick_p95 > usual * 1.5));
      return { session_id: s.session_id, budget_ms: s.budget_ms ?? null, tick_p95_usual: usual, players_max: Math.max(0, ...s.slots.map((x) => x.players ?? 0)), slow_slots: over.slice(0, 20), ...(slots ? { slots: s.slots } : {}) };
    });
    const { sessions: _, server: __, events, slots: starts, ...head } = m;
    return reply(`Match ${m.id} in ${svc}: ${m.sessions.length} players on ${m.level ?? 'no level'}, ${clock(m.duration_s)}. ${verdict(m)}`, { ...head, ...(slots ? { slots: starts } : {}), players, servers, events: events.slice(0, 80) });
  },
);

// One table's rows as an agent reads them.
const netRow = (r) => ({ key: r.key ?? r.value, sessions: r.sessions ?? null, ping_p50: r.ping_p50, ping_p95: r.ping_p95, lag_pct: r.lag_pct, loss_pct: r.loss_pct, disconnects: r.disconnects, disconnects_per_hour: r.disconnects_per_hour, disconnect_pct: r.disconnect_pct, disconnect_reasons: r.disconnect_reasons });

tool(
  'glitchless_network',
  "Network quality of a multiplayer game: ping (median and the slowest 5%), lag (the share of connected play with a round trip over 150 ms), packet loss and jitter, and disconnects (per hour played, by reason, and the share of level attempts a disconnect ended: never counted as fails), overall and by level, version, platform and kind of connection (Wi-Fi, mobile data, wired), and by region when the game sets a region property (or by any property given as by). Also the worst matches by ping (glitchless_match opens one), and the network findings: a whole lobby lagging at once (the server), one kind of connection or region lagging (players' connections, or no server near them), disconnects rising in a release. The SDKs read it from the engine's netcode (Netcode for GameObjects, Mirror, Godot's ENet, Unreal's net driver, WebRTC) or the game's netSample calls.",
  {
    ...common,
    by: z.string().optional().describe('A session property to split by besides the built-in ones, e.g. "region" (the default when the game sets one) or "$play": each of its values (up to 8) read on its own'),
  },
  async ({ service, hours, by, ...f }) => {
    const svc = gameOf(await resolveService(service));
    const ask = { service: svc, ...filters(f), ...range(hours) };
    const ev = await query('events', ask);
    // A property to split by: the one asked for, else the region where the game sets one (the performance query's
    // by_prop gives its network rows in the same call).
    const key = by ? by.replace(/^\$/, '') : (ev.properties || []).some((p) => p.key === 'region') ? 'region' : null;
    const prop = key && (ev.properties || []).find((p) => p.key === key);
    const [perf, worst, found] = await Promise.all([query('performance', { ...ask, ...(prop && !prop.identifier_like ? { by_prop: key } : {}) }), query('matches', { ...ask, sort: 'lag', limit: 5 }), query('findings', ask)]);
    const net = perf.network;
    if (!net) return reply(`No network data from ${svc} in this window: the SDKs read it from the game's netcode, or the game calls netSample about once a second while connected (the instrument skill says how for each engine)`, {});
    const byProp = net.by_prop ? net.by_prop.rows.map(netRow) : null;
    const k = net.kpis;
    const title = `Network for ${svc} (${hours || 24}h): ping ${k.ping_p50} ms median, ${k.ping_p95} ms for the slowest 5%; ${k.lag_pct ?? 0}% of connected play over 150 ms; ${k.loss_pct ?? 0}% packet loss; ${k.disconnects} disconnects (${k.disconnects_per_hour ?? '–'} per hour played${k.disconnect_pct != null ? `, ${k.disconnect_pct}% of attempts` : ''})`;
    return reply(title, {
      kpis: k,
      by_level: net.by_level.map(netRow),
      by_version: net.by_version.map(netRow),
      by_platform: net.by_platform.map(netRow),
      by_link: net.by_link.map(netRow),
      ...(byProp ? { [`by_${key}`]: byProp } : key && !prop ? { note: `No session property ${key} in this window (glitchless_events lists the ones the game sets)` } : {}),
      worst_matches: worst.matches,
      findings: found.findings.filter((x) => x.category === 'network'),
    });
  },
);

tool(
  'glitchless_servers',
  "A multiplayer game's dedicated servers, when they run the Glitchless SDK in server mode (Node glitchless/server, or the Unity, Godot or Unreal server role): servers running now and the players connected to them; tick time against its budget (the slowest 5% of ticks, and the share of windows over budget) by players connected, by map and by version; CPU, memory and networked objects; crashes, each with the matches it ended and the players it dropped; long-running servers whose memory or objects keep climbing; the latest server runs; and the server findings (falling behind when full, a crash that ends matches, a leak). A server's sessions are kept apart from players' under the companion service \"<game>.server\": every other tool reads them with service \"<game>.server\" (glitchless_session for one server run, glitchless_get_error for a server crash's stack). Server sessions count as sessions like any other.",
  { ...common },
  async ({ service, hours, ...f }) => {
    const svc = gameOf(await resolveService(service));
    const ask = { service: svc, ...filters(f), ...range(hours) };
    const [d, found] = await Promise.all([query('servers', ask), query('findings', ask)]);
    const now = d.servers_now != null ? `${d.servers_now} running now with ${d.players_on_servers} players connected` : null;
    if (!d.kpis) return reply(`${d.why || `No server of ${svc} sent anything in this window.`}${now ? ` (${now})` : ''}`, {});
    const k = d.kpis;
    const title = `Servers of ${svc} (${hours || 24}h): ${k.servers} server runs${now ? `, ${now}` : ''}; tick p95 ${k.tick_p95} ms${k.budget_ms ? ` against a ${k.budget_ms} ms budget (in ${k.over_budget_pct}% of 5-second windows, 5% or more of the ticks went over it)` : ''}; ${k.players ?? 0} players per server on average; ${k.crashed} crashed (${k.crash_free_pct}% crash-free). Their sessions: service "${svc}.server"`;
    return reply(title, {
      servers_now: d.servers_now ?? null,
      players_on_servers: d.players_on_servers ?? null,
      kpis: k,
      by_players: d.by_players,
      by_level: d.by_level,
      by_version: d.by_version,
      crashes: d.crashes.map((c) => ({ ...slimIssue(c), crashed_servers: c.crashed_servers, matches_ended: c.matches_ended, players_dropped: c.players_dropped, breadcrumbs: c.breadcrumbs?.slice(-6) })),
      memory: d.memory,
      climbing: d.climbing,
      recent_runs: d.sessions.slice(0, 15),
      findings: found.findings.filter((x) => x.id.startsWith('server-')),
    });
  },
);
