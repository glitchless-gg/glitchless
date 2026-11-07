// The built-in reads: which games report, findings, headline numbers, frame time, errors, levels,
// death hotspots and one session in detail.
import { z } from 'zod';
import { base, query, resolveService, range, reply, common, tool, slimIssue, noPlayersLine, slimGroup, filters, isWorkspace, workspaceGames, workspaceIntake, agent, SETUP_URL } from '../context.js';
import { sessionSummary, timelineView } from '../session-view.js';

tool('glitchless_list_games', 'List the games: with a workspace key, every game in the workspace (its id, name, client token and the services reporting to it); with a key for one game, its services, versions, environments and when they were last seen.', {}, async () => {
  if (isWorkspace()) {
    const list = await workspaceGames(true);
    if (!list.length) {
      // Someone who connected an app before making a game: say what to do, and what this connection may do about it.
      const who = await agent('GET', '/whoami').catch(() => null);
      const make = who?.scopes?.includes('manage')
        ? 'Make one with glitchless_create_game (name: the game\'s name), or try every tool first on the demo game: glitchless_create_game with demo: true adds Zoomies with a week of sample play.'
        : `Make one in Glitchless (${who?.dashboard ?? 'the dashboard'}): this connection may only read, so it can't create games. To let it, connect again and tick "Create games and share links".`;
      return reply(`No games in this workspace yet. ${make} Then add Glitchless to the game's code with its client token: the setup steps are at ${SETUP_URL}. ${CANT_EDIT.replaceAll('<the game>', 'my game')}`, []);
    }
    const intake = workspaceIntake();
    const rows = list.map((g) => (g.services?.length ? g : { ...g, next_step: nextStep(g, intake) }));
    // A new workspace starts with the demo game only: say it's sample play, and how the person's own game gets in.
    if (list.every((g) => g.demo)) {
      const who = await agent('GET', '/whoami').catch(() => null);
      const add = who?.scopes?.includes('manage')
        ? "To add the person's own game, glitchless_create_game with its name."
        : `To add the person's own game, they name it in Glitchless (${who?.dashboard ?? 'the dashboard'}): this connection may only read, so it can't create games.`;
      return reply(`Only the demo game so far: ${list[0].name} is a week of sample play to try every tool on (start with glitchless_triage on it). ${add} Then Glitchless goes into the game's code with its client token: the setup steps are at ${SETUP_URL}. ${CANT_EDIT.replaceAll('<the game>', 'my game')}`, rows);
    }
    return reply(`${list.length} game(s) in this workspace. Name one with game in any tool:`, rows);
  }
  const { services } = await query('services');
  return reply(`${services.length} game(s) reporting to ${base()}`, services.map((s) => ({ ...s, last_seen: new Date(s.last_seen).toISOString() })));
});

tool(
  'glitchless_triage',
  "Ranked findings for a game, after its headline numbers (sessions, players, crash-free and error-free sessions, frame-time p50/p95/p99 and the share of frames over their own screen's budget, pct_frames_over_budget, with frame_budgets the share of play at each refresh rate; hitches a minute, rage quits) and the versions deployed in the window: performance spikes per level (with the gauges, counter bursts and events they correlate with), memory leaks, top errors, difficulty spikes / rage-quit hotspots, walls (a level, or one value of a level start's attribute such as a tier), version regressions, settings that run slow (a session property), the network (a whole lobby lagging at once: the server; one kind of connection, platform or region lagging; disconnects rising in a release) and the game's dedicated servers (falling behind when full, a crash that ends matches, memory that keeps climbing) — ranked by severity and player impact, each with evidence and a suggested fix, and naming a session property when most of a problem falls on one value. Findings the game's owner marked known (glitchless_mark_known) come after the rest with `known` and its note: accepted, not new. One that got worse since has `came_back` instead. Errors the owner resolved (glitchless_resolve_error) have no finding, unless one came back in a later version: then its finding has `came_back` with the version and the note. Start here when asked 'what's wrong with my game?'.",
  { ...common },
  async ({ service, hours, ...f }) => {
    const svc = await resolveService(service);
    const { version } = f;
    const { findings, meta, kpis, deployments } = await query('findings', { service: svc, ...filters(f), kpis: 1, ...range(hours) });
    const brief = findings.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}${f.known ? ', KNOWN' : ''}] ${f.title}${f.known ? ` (known: ${f.known.note})` : f.came_back ? ` (${f.came_back.resolved ? 'resolved' : 'marked known'}, back: ${f.came_back.why})` : ''}`).join('\n');
    const head = kpis ? `${kpis.sessions ?? 0} sessions${kpis.players != null ? `, ${kpis.players} players` : ''}${kpis.crash_free_pct != null ? `, ${kpis.crash_free_pct}% crash-free` : ''}${kpis.frame_p95 != null ? `, frame p95 ${kpis.frame_p95}ms` : ''}` : null;
    return reply(`Findings for ${svc} (${hours || 24}h${version ? `, ${version}` : ''})${head ? `: ${head}` : ''}:\n${brief || 'Nothing unusual.'}\n\nHeadline numbers, deployments and the full findings with evidence (window ${new Date(meta?.from).toISOString()} → now):`, { kpis, deployments, findings });
  },
);

tool(
  'glitchless_performance',
  "Frame-time breakdown for a game: global percentiles, per-level p50/p95/p99 with draw calls / triangles / geometry counts / game-context gauges, hitch causes (script, shader compile, PSO compile in Unreal, GC, asset or map load), what is on screen during hitches, which events precede hitches, per GPU tier / browser / platform / version, per screen (by_display: each refresh rate's sessions, its budget_ms and share of play, so 120 Hz and 60 Hz phones read apart), per zone for an open-world game or hub that sets them (by_zone: each zone's frame time and hitches_per_min, and its time: seconds and share_pct of play time, sessions that went there and median_s, their median time in it; zone keeps one), memory growth per level load and the slowest recent hitches with script attribution. Every frame is judged against its own screen's budget: pct_over_budget is the share of frames slower than 1.15x their own window's budget_ms (under 5% means the p95 is on time on players' own screens; a 60 Hz phone's 16.7 ms frames are on time next to 120 Hz ones), so read it, not p95 against frame_budget_ms (the median screen's). With by_prop, frame time, hitches and crash-free sessions per value of a session property (a graphics preset, a class). A multiplayer game also gets `network` (ping, loss and disconnects; glitchless_network has more).",
  {
    ...common,
    level: z.string().optional().describe('Focus on one level id, e.g. "level-2"'),
    zone: z.string().optional().describe('Focus on one zone, as the game names it with setZone ("hall"): its by_zone row and its recent hitches'),
    by_prop: z.string().optional().describe('A session property (glitchless_events lists them), e.g. "preset": frame time, hitches and crash-free sessions per value, over 31 days or less'),
  },
  async ({ service, hours, level, zone, by_prop, ...f }) => {
    const svc = await resolveService(service);
    const d = await query('performance', { service: svc, ...filters(f), by_prop, ...range(hours) });
    const hitches = d.hitches.filter((h) => (!level || h.level === level) && (!zone || h.zone === zone)).slice(0, 12);
    const zones = d.by_zone && (zone ? d.by_zone.filter((z) => z.key === zone) : d.by_zone);
    return reply(`Frame performance for ${svc}${level ? ` (${level})` : ''}${zone ? ` (zone ${zone})` : ''}`, {
      kpis: d.kpis,
      by_level: level ? d.by_level.filter((l) => l.key === level) : d.by_level,
      hitch_causes: d.hitch_causes,
      hitch_context: d.hitch_context,
      by_gpu_tier: d.by_gpu_tier.map(slimGroup),
      by_browser: d.by_browser.map(slimGroup),
      by_version: d.by_version.map(slimGroup),
      by_platform: (d.by_platform || []).map(slimGroup),
      by_display: (d.by_display || []).map((g) => ({ ...slimGroup(g), hz: g.hz, budget_ms: g.budget_ms, windows_pct: g.windows_pct })),
      // Each zone's frame time and hitches, and its time: share of play time, the sessions that went there, their median.
      ...(zones ? { by_zone: zones.map((z) => ({ ...slimGroup(z), hitches: z.hitches, seconds: z.seconds, share_pct: z.share_pct, median_s: z.median_s })) } : {}),
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
  "Error Tracking for a game. Without a fingerprint: the open error issues ranked by sessions affected, any that came back first (`came_back`: resolved by the game's owner, then hit by players again in a later version: which, since when, and the note), and then, apart, the ones resolved (`resolved`: when, the newest version it had been seen in, the note). With a fingerprint: the full issue — message, location, stack trace, affected levels/versions, occurrence counts and breadcrumbs (the game events right before it fired), and whether it is resolved or came back. An issue no player hit has `no_players`, its sessions by kind (synthetic: bots, playtests and store test phones such as Google Play's pre-launch ones; tester; dev_builds): check that it can happen on players' devices before fixing it. For a minified web build whose source maps were uploaded (glitchless-sourcemaps), location and stack are the original ones, `frames` gives each frame with its line of code, and `minified` what the browser reported. glitchless_resolve_error resolves one.",
  { ...common, fingerprint: z.string().optional().describe('Issue fingerprint from the list or from glitchless_triage') },
  async ({ service, hours, fingerprint, ...f }) => {
    const svc = await resolveService(service);
    const { issues } = await query('errors', { service: svc, ...filters(f), ...range(hours) });
    if (!fingerprint) {
      const open = issues.filter((i) => !i.resolved).map(slimIssue);
      const resolved = issues.filter((i) => i.resolved).map(slimIssue);
      const back = open.filter((i) => i.came_back).length;
      const tests = open.filter((i) => i.no_players).length;
      return reply(`${open.length} open error issue(s) in ${svc}${back ? `, ${back} of them back after being resolved` : ''}${tests ? `, ${tests} hit by no player (only test phones, bots, testers or dev builds: no_players)` : ''}${resolved.length ? `; ${resolved.length} resolved (left out of glitchless_triage)` : ''}`, resolved.length ? { open, resolved } : open);
    }
    const issue = issues.find((i) => i.fingerprint === fingerprint || i.fingerprint?.startsWith(fingerprint));
    if (!issue) return reply(`No issue ${fingerprint} in ${svc} in this window. Known issues:`, issues.map(slimIssue));
    const { series, ...rest } = issue;
    const state = issue.came_back ? ` — resolved${issue.came_back.resolved.version ? ` in ${issue.came_back.resolved.version}` : ''}, and came back in ${issue.came_back.version}` : issue.resolved ? ` — resolved${issue.resolved.version ? ` (newest version then: ${issue.resolved.version})` : ''}${issue.resolved.note ? `: ${issue.resolved.note}` : ''}` : '';
    const tests = noPlayersLine(issue);
    return reply(`Error issue ${issue.fingerprint} in ${svc}${state}${tests ? `. ${tests}` : ''}`, rest);
  },
);

tool(
  'glitchless_player_funnel',
  'Player experience per level: sessions that started vs completed each level, attempts, deaths per session and their causes, fails, abandons and the attempts a disconnect ended (never counted as fails), median and slowest clear times, rage quits (quit ≤20s after dying), session length distribution, recent rage quits with positions, and recent rage inputs (one key mashed: the SDKs count them in kpis.rage_inputs) with their level, time, key and, for a game that sends positions, where the player stood. With by, each level per value of what describes the attempt: an attribute the game passed to levelStart ("tier", "difficulty", "party_size"; a list such as "build" counts under each element), a session property ("$class") or a split ("$platform"): clears and wipes by difficulty, by group size, by class; level keeps one level; count "runs" counts each run once at each level it reached (a roguelite\'s biomes). Also retention: of the players first seen each day, the share back 1, 7 and 30 days later (D1, D7, D30; hours of 48 or more for D1), and with by_prop per value of a session property (spenders against the rest). Retention needs player IDs: status "anonymous" means the game sends none, and privacy "install" in the SDK turns them on. With hotspots, for a game that sends positions: where players die instead, on one level (level), in one zone (zone, as the game passes it to setZone) or, with neither, anywhere in the game (a hub or lobby with no level set): clustered death positions in world coordinates (x range, share of the place\'s deaths, top cause, rage quits at that spot), the bounds and the place\'s stats (a level\'s completion; a zone\'s sessions, deaths and rage quits), to find a difficulty spike and then the level data around it.',
  {
    ...common,
    by: z.string().optional().describe('Split each level\'s attempts: an attribute of its levelStart ("tier"), a session property ("$class") or $platform, $browser, $device_tier, $link'),
    level: z.string().optional().describe('With by or count: only this level; with hotspots: the level, e.g. "level-3"'),
    zone: z.string().optional().describe('With hotspots: the zone instead of a level, e.g. "hall" (neither: the whole game)'),
    count: z.enum(['runs']).optional().describe('"runs": each run (setGroup("run")) counted once at each level it reached'),
    by_prop: z.string().optional().describe('Retention per value of this session property, e.g. "spender"'),
    hotspots: z.boolean().optional().describe('Where players die, instead of the funnel: on level, in zone, or with neither anywhere in the game'),
  },
  async ({ service, hours, by, level, zone, count, by_prop, hotspots, ...f }) => {
    const svc = await resolveService(service);
    if (hotspots) {
      if (level && zone) throw new Error('hotspots takes level or zone, not both (neither: the whole game)');
      const place = level ? { level } : zone ? { zone } : { all: 1 };
      const d = await query('heatmap', { service: svc, ...filters(f), ...place, ...range(hours) });
      const where = level ? `on ${level}` : zone ? `in ${zone}` : 'anywhere in the game';
      return reply(`Death hotspots ${where} in ${svc}`, { ...(level ? { level } : zone ? { zone } : {}), axis: d.axis, bounds: d.bounds, background: d.map ? (d.map.uploaded ? 'uploaded' : 'captured') : null, hotspots: d.hotspots, [level ? 'level_stats' : 'stats']: d.stats, total_deaths: d.deaths?.length ?? 0, position_samples: d.density?.samples ?? 0, levels: d.levels, zones: d.zones });
    }
    const d = await query('players', { service: svc, ...filters(f), by, level, count, by_prop, ...range(hours) });
    // Rage inputs (one key mashed): where and when each happened, the latest first.
    const rage = (d.rage_inputs || []).slice(0, 15).map(({ ts, ...r }) => ({ ...r, at: new Date(ts).toISOString() }));
    return reply(`Player funnel for ${svc}${by ? ` by ${by}` : ''}${count ? ', counting runs' : ''}`, { kpis: d.kpis, funnel: d.funnel, ...(d.funnel_by ? { funnel_by: d.funnel_by } : {}), session_length: d.session_length, recent_rage_quits: d.rage_quits.slice(0, 15), ...(rage.length ? { recent_rage_inputs: rage } : {}), retention: d.retention });
  },
);

tool(
  'glitchless_session',
  'One play session, or without session_id the latest sessions (who played, when, for how long, how far they got, the session type), to find one: the developer\'s own playtest to mark with glitchless_mark_known (player), a crash to open. With session_id, by default a summary an agent can hold: the device, then each level in the order it was played (when it was first reached, the time spent on it, tries, completions, deaths and their causes, the game\'s own events counted, hitches with the worst and their causes, frame rate, errors, rage inputs with where the player stood, and how it ended there), time outside levels (menus, a title screen), the worst hitches, errors, bug reports, and the outcome (crashed, rage quit, the last level). With level or types, the events themselves (levels with their attributes, deaths with positions, errors, hitches with causes, custom events, counters once a window, disconnects, agent annotations), each with at_s, seconds from the start: types "death,hitch" or a custom event name "room_done"; "frames" adds the per-5s frame windows. view "timeline" gives every event (long: a 10-minute session has hundreds). Use with session ids from errors, hitches, rage quits, rage inputs or a match. A game server\'s session (service "<game>.server") gives its tick windows.',
  {
    service: common.service,
    hours: common.hours,
    version: common.version,
    env: common.env,
    session_type: common.session_type,
    session_id: z.string().optional().describe('Session id (s_…); without it, the latest sessions'),
    view: z.enum(['summary', 'timeline']).optional().describe('"summary" (default, unless level or types is given): level by level; "timeline": the events themselves'),
    level: z.string().optional().describe('Only this level\'s events: its own and what happened while it was played'),
    types: z.string().optional().describe('Only these, comma-separated: event types (death, hitch, error, custom, level_start, bug_report…), custom event names (room_done), or "frames" for the frame windows'),
    limit: z.number().int().min(1).max(1000).optional().describe('With the timeline: at most this many events (default 150), from the first'),
  },
  async ({ service, hours, version, env, session_type, session_id, view, level, types, limit }) => {
    const svc = await resolveService(service);
    if (!session_id) {
      const { sessions = [] } = await query('sessions', { service: svc, ...filters({ version, env, session_type }), ...range(hours) });
      const rows = sessions.slice(0, limit ?? 25).map(sessionRow);
      return reply(`${sessions.length} session(s) of ${svc} in the last ${hours || 24}h${sessions.length > rows.length ? `, the latest ${rows.length} (limit gives more)` : ''}. Open one with session_id.`, rows, { rows: true });
    }
    const d = await query('session', { service: svc, id: session_id });
    if (d.error) return reply(`Session ${session_id} not found in ${svc}`, {});
    // A server's windows (A9) come every 5 s: they go in a list of their own, not the timeline.
    const ticks = d.timeline.filter((e) => e.type === 'server_window').map(({ ts, level, ticks, tick_hz, tick_p50, tick_p95, late, players, net_objects, cpu_pct, mem_mb, match }) => ({ ts, level, ticks, tick_hz, tick_p50, tick_p95, late, players, net_objects, cpu_pct, mem_mb, ...(match ? { match } : {}) }));
    const answer = { session: d.session, timeline: d.timeline.filter((e) => e.type !== 'server_window').map(({ tick, ...e }) => e), frames: d.frames || [], server_windows: ticks };
    if (view === 'timeline' || ((level || types) && view !== 'summary')) {
      const t = timelineView(answer, { level, types, limit: limit ?? 150 });
      const what = [level && `on ${level}`, types && `of ${types}`].filter(Boolean).join(' ');
      return reply(`Session ${session_id}: ${t.total} event(s)${what ? ` ${what}` : ''}${t.total > t.events.length ? `, the first ${t.events.length} (limit gives more)` : ''}`, { session: d.session, ...t, ...(ticks.length && !level && !types ? { server_windows: ticks.slice(0, limit ?? 120) } : {}) }, { rows: true });
    }
    const sum = sessionSummary(answer);
    const o = sum.outcome;
    const how = [o.crashed && 'crashed', o.rage_quit && 'rage quit', o.ended === false && 'still playing'].filter(Boolean).join(', ');
    return reply(`Session ${session_id}: ${sum.levels.length} level(s), ${Math.round(sum.session.duration_s ?? 0)} s${how ? `, ${how}` : ''}${o.last_level ? `, last on ${o.last_level}` : ''}. ${sum.timeline_events} events in all: pass level or types (or view "timeline") for them.`, sum, { rows: true });
  },
);

// A session as the list shows it: enough to tell who played, when, and how far they got.
function sessionRow(s) {
  return {
    session_id: s.session_id,
    player_id: s.player_id ?? null,
    session_type: s.session_type,
    ...(s.marked_tester ? { marked_tester: true } : {}),
    version: s.version,
    env: s.env,
    start: s.start != null ? new Date(s.start).toISOString() : null,
    duration_s: s.duration_s,
    device: [s.browser, s.os].filter(Boolean).join(', ') || null,
    levels: s.levels?.length ?? 0,
    completed: s.completed?.length ?? 0,
    deaths: s.deaths,
    errors: s.errors,
    hitches: s.hitches,
    ...(s.crashed ? { crashed: true } : {}),
    ...(s.rage_quit ? { rage_quit: true } : {}),
  };
}

// What to do about a game that hasn't sent anything yet: the demo game's sample play is on its way; any other game needs
// the SDK in its code. An agent that can edit the code adds it from the setup steps with the game's client token; one
// that can't (an app in a browser, such as claude.ai or ChatGPT) sends the person to a coding agent in the game's
// folder, where Claude Code signed in to the same Claude account already has the connection.
const CANT_EDIT = 'If you can\'t edit the game\'s code (in claude.ai or ChatGPT, say), tell the person to open Claude Code in the game\'s folder and say "Set up Glitchless for <the game> in this folder", or to paste the prompt on the Get started page in Glitchless into another coding agent.';
function nextStep(game, intake) {
  if (game.demo) return 'This is the demo game: its sample play can be read a few minutes after it was made. Ask again shortly.';
  return `No data yet: ${game.name} hasn't sent a session. Adding Glitchless means changing the game's code. If you can edit ${game.name}'s code, follow the setup steps at ${SETUP_URL} with client_token ${game.client_token}${intake ? ` and intake ${intake}` : ''}, then play a level: data shows a few minutes later. ${CANT_EDIT.replaceAll('<the game>', game.name)}`;
}
