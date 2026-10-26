// The built-in reads: which games report, findings, headline numbers, frame time, errors, levels,
// death hotspots and one session in detail.
import { z } from 'zod';
import { base, query, resolveService, range, reply, common, tool, slimIssue, slimGroup, filters, isWorkspace, workspaceGames } from '../context.js';

tool('glitchless_list_games', 'List the games: with a workspace key, every game in the workspace (its id, name, client token and the services reporting to it); with a key for one game, its services, versions, environments and when they were last seen.', {}, async () => {
  if (isWorkspace()) {
    const list = await workspaceGames(true);
    return reply(`${list.length} game(s) in this workspace. Name one with game in any tool:`, list);
  }
  const { services } = await query('services');
  return reply(`${services.length} game(s) reporting to ${base()}`, services.map((s) => ({ ...s, last_seen: new Date(s.last_seen).toISOString() })));
});

tool(
  'glitchless_triage',
  "Ranked findings for a game: performance spikes per level (with the gauges, counter bursts and events they correlate with), memory leaks, top errors, difficulty spikes / rage-quit hotspots, walls (a level, or one value of a level start's attribute such as a tier), version regressions, settings that run slow (a session property), the network (a whole lobby lagging at once: the server; one kind of connection, platform or region lagging; disconnects rising in a release) and the game's dedicated servers (falling behind when full, a crash that ends matches, memory that keeps climbing) — ranked by severity and player impact, each with evidence and a suggested fix, and naming a session property when most of a problem falls on one value. Start here when asked 'what's wrong with my game?'.",
  { ...common },
  async ({ service, hours, ...f }) => {
    const svc = await resolveService(service);
    const { version } = f;
    const { findings, meta } = await query('findings', { service: svc, ...filters(f), ...range(hours) });
    const brief = findings.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`).join('\n');
    return reply(`Findings for ${svc} (${hours || 24}h${version ? `, ${version}` : ''}):\n${brief || 'Nothing unusual.'}\n\nFull findings with evidence (window ${new Date(meta?.from).toISOString()} → now):`, findings);
  },
);

tool('glitchless_overview', 'Headline KPIs for a game: sessions, players, crash-free and error-free sessions, frame-time p50/p95/p99 vs budget, hitches per minute, rage quits, top errors and the level funnel.', { ...common }, async ({ service, hours, ...f }) => {
  const svc = await resolveService(service);
  const d = await query('overview', { service: svc, ...filters(f), ...range(hours) });
  return reply(`Overview for ${svc}`, { kpis: d.kpis, deployments: d.deployments, top_errors: d.top_errors.map(slimIssue), funnel: d.funnel });
});

tool(
  'glitchless_performance',
  'Frame-time breakdown for a game: global percentiles vs the frame budget, per-level p50/p95/p99 with draw calls / triangles / geometry counts / game-context gauges, hitch causes (script, shader compile, PSO compile in Unreal, GC, asset or map load), what is on screen during hitches, which events precede hitches, per GPU tier / browser / platform / version, per zone for an open-world game that sets them, memory growth per level load and the slowest recent hitches with script attribution. With by_prop, frame time, hitches and crash-free sessions per value of a session property (a graphics preset, a class). A multiplayer game also gets `network` (ping, loss and disconnects; glitchless_network has more).',
  {
    ...common,
    level: z.string().optional().describe('Focus on one level id, e.g. "level-2"'),
    by_prop: z.string().optional().describe('A session property (glitchless_events lists them), e.g. "preset": frame time, hitches and crash-free sessions per value, over 31 days or less'),
  },
  async ({ service, hours, level, by_prop, ...f }) => {
    const svc = await resolveService(service);
    const d = await query('performance', { service: svc, ...filters(f), by_prop, ...range(hours) });
    const hitches = (level ? d.hitches.filter((h) => h.level === level) : d.hitches).slice(0, 12);
    return reply(`Frame performance for ${svc}${level ? ` (${level})` : ''}`, {
      kpis: d.kpis,
      by_level: level ? d.by_level.filter((l) => l.key === level) : d.by_level,
      hitch_causes: d.hitch_causes,
      hitch_context: d.hitch_context,
      by_gpu_tier: d.by_gpu_tier.map(slimGroup),
      by_browser: d.by_browser.map(slimGroup),
      by_version: d.by_version.map(slimGroup),
      by_platform: (d.by_platform || []).map(slimGroup),
      ...(d.by_zone ? { by_zone: d.by_zone.map(slimGroup) } : {}),
      ...(d.by_prop ? { by_prop: { key: d.by_prop.key, ...(d.by_prop.why ? { why: d.by_prop.why } : {}), rows: d.by_prop.rows.map((r) => ({ ...slimGroup(r), all_sessions: r.all_sessions, crash_free_pct: r.crash_free_pct })) } } : {}),
      ...(d.network ? { network: d.network.kpis } : {}),
      memory: d.memory,
      load: d.load,
      slowest_recent_hitches: hitches,
    });
  },
);

tool(
  'glitchless_get_error',
  'Error Tracking for a game. Without a fingerprint: the list of error issues ranked by sessions affected. With a fingerprint: the full issue — message, location, stack trace, affected levels/versions, occurrence counts and breadcrumbs (the game events right before it fired). For a minified web build whose source maps were uploaded (glitchless-sourcemaps), location and stack are the original ones, `frames` gives each frame with its line of code, and `minified` what the browser reported.',
  { ...common, fingerprint: z.string().optional().describe('Issue fingerprint from the list or from glitchless_triage') },
  async ({ service, hours, fingerprint, ...f }) => {
    const svc = await resolveService(service);
    const { issues } = await query('errors', { service: svc, ...filters(f), ...range(hours) });
    if (!fingerprint) return reply(`${issues.length} error issue(s) in ${svc}`, issues.map(slimIssue));
    const issue = issues.find((i) => i.fingerprint === fingerprint || i.fingerprint?.startsWith(fingerprint));
    if (!issue) return reply(`No issue ${fingerprint} in ${svc} in this window. Known issues:`, issues.map(slimIssue));
    const { series, ...rest } = issue;
    return reply(`Error issue ${issue.fingerprint} in ${svc}`, rest);
  },
);

tool(
  'glitchless_player_funnel',
  'Player experience per level: sessions that started vs completed each level, attempts, deaths per session and their causes, fails, abandons and the attempts a disconnect ended (never counted as fails), median and slowest clear times, rage quits (quit ≤20s after dying), session length distribution and recent rage quits with positions. With by, each level per value of what describes the attempt: an attribute the game passed to levelStart ("tier", "difficulty", "party_size"; a list such as "build" counts under each element), a session property ("$class") or a split ("$platform"): clears and wipes by difficulty, by group size, by class; level keeps one level; count "runs" counts each run once at each level it reached (a roguelite\'s biomes). Also retention: of the players first seen each day, the share back 1, 7 and 30 days later (D1, D7, D30; hours of 48 or more for D1), and with by_prop per value of a session property (spenders against the rest). Retention needs player IDs: status "anonymous" means the game sends none, and privacy "install" in the SDK turns them on.',
  {
    ...common,
    by: z.string().optional().describe('Split each level\'s attempts: an attribute of its levelStart ("tier"), a session property ("$class") or $platform, $browser, $device_tier, $link'),
    level: z.string().optional().describe('With by or count: only this level'),
    count: z.enum(['runs']).optional().describe('"runs": each run (setGroup("run")) counted once at each level it reached'),
    by_prop: z.string().optional().describe('Retention per value of this session property, e.g. "spender"'),
  },
  async ({ service, hours, by, level, count, by_prop, ...f }) => {
    const svc = await resolveService(service);
    const d = await query('players', { service: svc, ...filters(f), by, level, count, by_prop, ...range(hours) });
    return reply(`Player funnel for ${svc}${by ? ` by ${by}` : ''}${count ? ', counting runs' : ''}`, { kpis: d.kpis, funnel: d.funnel, ...(d.funnel_by ? { funnel_by: d.funnel_by } : {}), session_length: d.session_length, recent_rage_quits: d.rage_quits.slice(0, 15), retention: d.retention });
  },
);

tool(
  'glitchless_death_hotspots',
  'Where players die on a level: clustered death positions in world coordinates (x range, share of the level’s deaths, top cause, rage quits at that spot), plus the level bounds and completion stats. Use it to find difficulty spikes, then look up the level data around those coordinates.',
  { ...common, level: z.string().describe('Level id, e.g. "level-3"') },
  async ({ service, hours, level, ...f }) => {
    const svc = await resolveService(service);
    const d = await query('heatmap', { service: svc, ...filters(f), level, ...range(hours) });
    return reply(`Death hotspots on ${level} in ${svc}`, { level: d.level, axis: d.axis, bounds: d.bounds, hotspots: d.hotspots, level_stats: d.stats, total_deaths: d.deaths?.length ?? 0, position_samples: d.density?.samples ?? 0 });
  },
);

tool(
  'glitchless_session',
  'One play session in detail: device/GPU, outcome (crashed, rage quit), its properties and its groups (the matches, parties and runs it was in), and the full event timeline (levels with their attributes, deaths with positions, errors, hitches with causes, counters once a window, disconnects, agent annotations) plus per-5s frame stats. Use with session ids from errors, hitches, rage quits or a match. A game server\'s session (service "<game>.server") gives its tick windows instead of frames.',
  { service: common.service, session_id: z.string().describe('Session id (s_…)') },
  async ({ service, session_id }) => {
    const svc = await resolveService(service);
    const d = await query('session', { service: svc, id: session_id });
    if (d.error) return reply(`Session ${session_id} not found in ${svc}`, {});
    // A server's windows (A9) come every 5 s: they go in a list of their own, not the timeline.
    const ticks = d.timeline.filter((e) => e.type === 'server_window').map(({ ts, level, ticks, tick_hz, tick_p50, tick_p95, late, players, net_objects, cpu_pct, mem_mb, match }) => ({ ts, level, ticks, tick_hz, tick_p50, tick_p95, late, players, net_objects, cpu_pct, mem_mb, ...(match ? { match } : {}) }));
    const timeline = d.timeline.filter((e) => e.type !== 'server_window').map(({ tick, ...e }) => e);
    return reply(`Session ${session_id}`, { session: d.session, timeline: timeline.slice(0, 150), frames: d.frames.map(({ ctx, ...f }) => ({ ...f, ...ctx })).slice(0, 120), ...(ticks.length ? { server_windows: ticks.slice(0, 120) } : {}) });
  },
);
