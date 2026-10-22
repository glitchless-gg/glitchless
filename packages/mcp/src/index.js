#!/usr/bin/env node
// Glitchless MCP server — gives coding agents (Claude Code, Codex, Cursor…) read access to a game's
// production telemetry: ranked findings, frame-time breakdowns, errors, player funnels, death
// hotspots and version comparisons. Pair it with WebMCP (live tools exposed by the running game)
// and the agent can go from "players are rage quitting" to a verified fix.
//
//   claude mcp add glitchless -e GLITCHLESS_URL=http://localhost:7777 -- npx -y glitchless-mcp

import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { playtest } from 'glitchless-playtest';

const BASE = (process.env.GLITCHLESS_URL || 'http://localhost:7777').replace(/\/$/, '');
const API_KEY = process.env.GLITCHLESS_API_KEY || '';
const DEFAULT_SERVICE = process.env.GLITCHLESS_SERVICE || '';

const server = new McpServer(
  { name: 'glitchless', version: '0.2.0' },
  {
    instructions:
      'Glitchless is observability for games made with Three.js, Phaser, Unity or Godot. Start with glitchless_triage to get ranked, evidence-backed findings for a game, then drill in with glitchless_performance, glitchless_get_error, glitchless_death_hotspots or glitchless_session. For metrics the game defines itself (what it sends with track(): plays, purchases, paywall views and so on) and funnels between them, use glitchless_events. Each game has its own dashboard, a list of pages (boards of panels, and built-in views such as Errors, Sessions and Live Tail): read it with glitchless_dashboard, and after instrumenting a game, design one that fits it with glitchless_set_dashboard. Before changing game code, run glitchless_playtest with save_as "baseline"; after the change, run glitchless_playtest again to compare, and treat a FAIL as unfinished work. After shipping a fix (bump the version passed to Glitchless.init), use glitchless_compare_versions to confirm it with real players. If the game is running in a browser with WebMCP connected, its live tools (glitchless_live_performance, glitchless_measure, glitchless_inspect_scene, and game tools such as zoomies_load_level) let you reproduce and measure issues directly. Unity and Godot builds measure themselves when run with --glitchless-measure=SECONDS.',
  },
);

async function query(name, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  const client = server.server.getClientVersion?.()?.name || 'mcp';
  const res = await fetch(`${BASE}/v1/query/${name}?${qs}`, {
    headers: { 'x-glitchless-client': client, ...(API_KEY ? { 'x-glitchless-api-key': API_KEY } : {}) },
  });
  if (!res.ok) throw new Error(`Glitchless API ${name} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const call = calls.getStore();
  if (call && data?.meta) Object.assign(call, { meta: data.meta, from: params.from });
  return data;
}

// The tool call being answered: the meta of its last query, for windowNote().
const calls = new AsyncLocalStorage();

// How the window was answered, when an agent should know: by day past 31 days, what is estimated, what a
// view covers, a range cut to the plan's retention.
function windowNote() {
  const { meta, from } = calls.getStore() || {};
  if (!meta) return '';
  const parts = [];
  if (meta.resolution === 'day') parts.push('answered by day: each session counts on the day it started');
  if (meta.approximate?.length) parts.push(`estimated (sketches or samples): ${meta.approximate.join(', ')}`);
  if (meta.note) parts.push(meta.note);
  if (meta.retention_days && from != null && meta.from - from > 86400e3) parts.push(`the plan keeps ${meta.retention_days} days of data, so the window starts ${new Date(meta.from).toISOString().slice(0, 10)}`);
  return parts.length ? `\n(Note: ${parts.join('; ')}.)` : '';
}

async function write(method, path, body) {
  const client = server.server.getClientVersion?.()?.name || 'mcp';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-glitchless-client': client, ...(API_KEY ? { 'x-glitchless-api-key': API_KEY } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error(`${data.error || 'forbidden'}. Saving a dashboard needs a secret key with the dashboard scope (create one in the dashboard's settings).`);
  if (!res.ok) throw new Error(`Glitchless API ${method} ${path} → HTTP ${res.status}: ${data.error || ''}`);
  return data;
}

async function resolveService(service) {
  if (service) return service;
  if (DEFAULT_SERVICE) return DEFAULT_SERVICE;
  const { services } = await query('services');
  if (!services?.length) throw new Error('No games are reporting to Glitchless yet. Add the SDK and play a level first.');
  return services.sort((a, b) => b.last_seen - a.last_seen)[0].service;
}

function range(hours = 24) {
  const to = Date.now();
  return { from: to - hours * 3600e3, to };
}

function reply(title, data) {
  return { content: [{ type: 'text', text: `${title}${windowNote()}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function fail(err) {
  return { content: [{ type: 'text', text: `Glitchless error: ${err.message}` }], isError: true };
}

const common = {
  service: z.string().optional().describe('Game service name (defaults to the most recently active game)'),
  hours: z
    .number()
    .min(0.25)
    .max(9600)
    .optional()
    .describe("Look-back window in hours (default 24). Up to the plan's retention on Glitchless Cloud: 336 (14 days) on Free, 2160 (90 days) on Indie, 9600 (400 days) on Studio. Past 744 (31 days) answers are by day."),
  version: z.string().optional().describe('Only include sessions from this game version'),
};

function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: true } }, async (args) =>
    calls.run({}, async () => {
      try {
        return await handler(args || {});
      } catch (err) {
        return fail(err);
      }
    }),
  );
}

tool('glitchless_list_games', 'List the games reporting to Glitchless, with their versions, environments and when they were last seen.', {}, async () => {
  const { services } = await query('services');
  return reply(`${services.length} game(s) reporting to ${BASE}`, services.map((s) => ({ ...s, last_seen: new Date(s.last_seen).toISOString() })));
});

tool(
  'glitchless_triage',
  "Ranked findings for a game: performance spikes per level (with the gauges and events they correlate with), memory leaks, top errors, difficulty spikes / rage-quit hotspots and version regressions — ranked by severity and player impact, each with evidence and a suggested fix. Start here when asked 'what's wrong with my game?'.",
  { ...common },
  async ({ service, hours, version }) => {
    const svc = await resolveService(service);
    const { findings, meta } = await query('findings', { service: svc, version, ...range(hours) });
    const brief = findings.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`).join('\n');
    return reply(`Findings for ${svc} (${hours || 24}h${version ? `, ${version}` : ''}):\n${brief || 'Nothing unusual.'}\n\nFull findings with evidence (window ${new Date(meta?.from).toISOString()} → now):`, findings);
  },
);

tool('glitchless_overview', 'Headline KPIs for a game: sessions, players, crash-free and error-free sessions, frame-time p50/p95/p99 vs budget, hitches per minute, rage quits, top errors and the level funnel.', { ...common }, async ({ service, hours, version }) => {
  const svc = await resolveService(service);
  const d = await query('overview', { service: svc, version, ...range(hours) });
  return reply(`Overview for ${svc}`, { kpis: d.kpis, deployments: d.deployments, top_errors: d.top_errors.map(slimIssue), funnel: d.funnel });
});

tool(
  'glitchless_performance',
  'Frame-time breakdown for a game: global percentiles vs the frame budget, per-level p50/p95/p99 with draw calls / triangles / geometry counts / game-context gauges, hitch causes (script, shader compile, GC, asset load), what is on screen during hitches, which events precede hitches, per GPU tier / browser / version, memory growth per level load and the slowest recent hitches with script attribution.',
  { ...common, level: z.string().optional().describe('Focus on one level id, e.g. "level-2"') },
  async ({ service, hours, version, level }) => {
    const svc = await resolveService(service);
    const d = await query('performance', { service: svc, version, ...range(hours) });
    const hitches = (level ? d.hitches.filter((h) => h.level === level) : d.hitches).slice(0, 12);
    return reply(`Frame performance for ${svc}${level ? ` (${level})` : ''}`, {
      kpis: d.kpis,
      by_level: level ? d.by_level.filter((l) => l.key === level) : d.by_level,
      hitch_causes: d.hitch_causes,
      hitch_context: d.hitch_context,
      by_gpu_tier: d.by_gpu_tier.map(slimGroup),
      by_browser: d.by_browser.map(slimGroup),
      by_version: d.by_version.map(slimGroup),
      memory: d.memory,
      load: d.load,
      slowest_recent_hitches: hitches,
    });
  },
);

tool(
  'glitchless_get_error',
  'Error Tracking for a game. Without a fingerprint: the list of error issues ranked by sessions affected. With a fingerprint: the full issue — message, location, stack trace, affected levels/versions, occurrence counts and breadcrumbs (the game events right before it fired).',
  { ...common, fingerprint: z.string().optional().describe('Issue fingerprint from the list or from glitchless_triage') },
  async ({ service, hours, version, fingerprint }) => {
    const svc = await resolveService(service);
    const { issues } = await query('errors', { service: svc, version, ...range(hours) });
    if (!fingerprint) return reply(`${issues.length} error issue(s) in ${svc}`, issues.map(slimIssue));
    const issue = issues.find((i) => i.fingerprint === fingerprint || i.fingerprint.startsWith(fingerprint));
    if (!issue) return reply(`No issue ${fingerprint} in ${svc} in this window. Known issues:`, issues.map(slimIssue));
    const { series, ...rest } = issue;
    return reply(`Error issue ${issue.fingerprint} in ${svc}`, rest);
  },
);

tool('glitchless_player_funnel', 'Player experience per level: sessions that started vs completed each level, attempts, deaths per session and their causes, average clear time, rage quits (quit ≤20s after dying), session length distribution and recent rage quits with positions.', { ...common }, async ({ service, hours, version }) => {
  const svc = await resolveService(service);
  const d = await query('players', { service: svc, version, ...range(hours) });
  return reply(`Player funnel for ${svc}`, { kpis: d.kpis, funnel: d.funnel, session_length: d.session_length, recent_rage_quits: d.rage_quits.slice(0, 15) });
});

tool(
  'glitchless_events',
  "The game's own metrics, from the custom events it sends with track(): each event's count in the window, the sessions and players that sent it, and how its attribute values break down (for example plays by mode, paywall views by placement, purchases started vs done). Give `funnel` to count the sessions that went from one event to the next, in that order.",
  {
    ...common,
    name: z.string().optional().describe('Only this event, e.g. "paywall"'),
    funnel: z.string().optional().describe('Steps in order, comma-separated: "open,paywall,buy". A step can require a value: "buy=done" (any attribute) or "buy:step=done"'),
  },
  async ({ service, hours, version, name, funnel }) => {
    const svc = await resolveService(service);
    const d = await query('events', { service: svc, version, name, funnel, ...range(hours) });
    const brief = d.events
      .slice(0, 15)
      .map((e) => `${e.name}: ${e.count} in ${e.sessions} session(s)`)
      .join('\n');
    return reply(`Custom events for ${svc} (${hours || 24}h, ${d.sessions} sessions):\n${brief || 'None in this window. A game sends them with track(name, attrs).'}`, {
      events: d.events.map(({ series, ...e }) => e),
      ...(d.funnel ? { funnel: d.funnel } : {}),
    });
  },
);

tool(
  'glitchless_dashboard',
  "The game's dashboard: its pages in order, each a board (panels in the game's own terms) or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live), and one board's panels with their numbers for the window. `page` picks the board (default: the first). `source` says whether the dashboard was saved (by an agent or a person) or made automatically from what the game sends; `spec` is what to edit and send back to glitchless_set_dashboard.",
  { ...common, page: z.string().optional().describe('Id of the board page to evaluate (default: the first board)') },
  async ({ service, hours, version, page }) => {
    const svc = await resolveService(service);
    const { dashboard } = await query('dashboard', { service: svc, version, ...range(hours) });
    if (!dashboard) return reply(`${svc} has sent no data yet`, {});
    const b = await query('board', { service: svc, version, page, ...range(hours) });
    const pages = dashboard.pages.map((p) => ({ id: p.id, title: p.title, ...(p.view ? { view: p.view, ...(p.options ? { options: p.options } : {}) } : { panels: p.panels }) }));
    const board = b.board ? { page: b.board.page, title: b.board.title, panels: b.board.panels.map(({ ts, series, p50, p95, ...p }) => p) } : { error: b.error };
    return reply(`Dashboard for ${svc} (${dashboard.source}${dashboard.updated_by ? `, saved by ${dashboard.updated_by}` : ''}):`, { pages, board, spec: dashboard.spec });
  },
);

const panelSchema = z
  .object({
    type: z.enum(['stat', 'series', 'breakdown', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live']),
    title: z.string().optional().describe("In the game's own words, e.g. \"Stops won vs lost\""),
    note: z.string().optional().describe('One line on why this panel matters'),
    size: z.enum(['s', 'm', 'l']).optional().describe('s = a quarter row (stats), m = half, l = full width'),
    metric: z.string().optional().describe('stat: sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths or rage_quit_pct'),
    event: z.string().optional().describe('stat, series, breakdown: one event, "name", "name=value" or "name:key=value"'),
    per: z.string().optional().describe('stat: divide by this event to get a percentage, e.g. event "buy=done" per "paywall"'),
    by: z.string().optional().describe('series, breakdown: the attribute to split by, e.g. "mode" or "what", or $version / $level'),
    limit: z.number().int().optional(),
    steps: z.string().optional().describe('funnel: events in order, comma-separated, e.g. "paywall,buy=tapped,buy=done"'),
    label: z.string().optional().describe('levels: what the game calls a level, e.g. "Stop" or "Puzzle"'),
    sent: z.string().optional().describe('sessions: only sessions that sent this event, e.g. "buy=done"'),
    events: z.array(z.string()).optional().describe('live: only these event names or types, e.g. ["buy", "paywall", "error"]'),
  })
  .describe('One panel');

const pageSchema = z
  .object({
    id: z.string().optional().describe('Short id used in the page address, e.g. "money" (default: from the title)'),
    title: z.string().optional().describe('The name in the sidebar, in the words the game uses (a view keeps its built-in name without one)'),
    icon: z.enum(['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock']).optional(),
    panels: z.array(panelSchema).optional().describe('A board: its panels, in order'),
    view: z.enum(['events', 'performance', 'errors', 'players', 'heatmaps', 'sessions', 'versions', 'live']).optional().describe('A built-in view instead of panels'),
    options: z.object({ events: z.array(z.string()).optional() }).optional().describe('live view: events, only these event names or types'),
  })
  .describe('One page: either panels (a board) or view (a built-in view)');

server.registerTool(
  'glitchless_set_dashboard',
  {
    description:
      "Save the game's dashboard: its pages, in the order the sidebar shows them. Each page is a board of panels in the game's own words, or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live) the game keeps, renames or drops. Design it for this game, not for a genre it isn't: a puzzle game cares about solve time and hints, a mobile game about opens, modes, the paywall and purchases, a platformer about deaths per level. The first page opens first. Use the events the game sends (glitchless_events lists them, with their attributes); on a board, stats first, then the game's own events and funnels, then levels, frame_time and errors. Leave out what the game has no data for (no Heatmaps page for a game without positions). Send every page: read the current ones with glitchless_dashboard (its spec), change them, send them all back. Pass reset: true to go back to the automatic dashboard. Needs a secret key with the dashboard scope.",
    inputSchema: {
      service: z.string().optional().describe('Game service name (defaults to the most recently active game)'),
      pages: z.array(pageSchema).optional(),
      reset: z.boolean().optional().describe('Delete the saved dashboard and go back to the automatic one'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ service, pages, reset }) => {
    try {
      const svc = await resolveService(service);
      if (!reset && !pages?.length) throw new Error('give pages, or reset: true');
      const res = await write(reset ? 'DELETE' : 'PUT', `/v1/dashboard?service=${encodeURIComponent(svc)}`, reset ? null : { pages });
      if (reset) return reply(`Dashboard for ${svc} reset to automatic.`, {});
      // How each board looks with the last 7 days, so empty panels show up now rather than in the dashboard.
      const lines = [];
      for (const p of res.dashboard.pages) {
        if (p.view) {
          lines.push(`${p.title} (built-in ${p.view} view)`);
          continue;
        }
        const { board } = await query('board', { service: svc, page: p.id, ...range(168) });
        lines.push(`${p.title}:`, ...board.panels.map((x) => `  - ${x.title}${x.empty ? ` (no data yet: ${x.why})` : ''}`));
      }
      return reply(`Saved the dashboard for ${svc} (${res.dashboard.pages.length} pages). How it looks with the last 7 days:\n${lines.join('\n')}`, {});
    } catch (err) {
      return fail(err);
    }
  },
);

tool(
  'glitchless_death_hotspots',
  'Where players die on a level: clustered death positions in world coordinates (x range, share of the level’s deaths, top cause, rage quits at that spot), plus the level bounds and completion stats. Use it to find difficulty spikes, then look up the level data around those coordinates.',
  { ...common, level: z.string().describe('Level id, e.g. "level-3"') },
  async ({ service, hours, version, level }) => {
    const svc = await resolveService(service);
    const d = await query('heatmap', { service: svc, version, level, ...range(hours) });
    return reply(`Death hotspots on ${level} in ${svc}`, { level: d.level, axis: d.axis, bounds: d.bounds, hotspots: d.hotspots, level_stats: d.stats, total_deaths: d.deaths?.length ?? 0, position_samples: d.density?.samples ?? 0 });
  },
);

tool(
  'glitchless_compare_versions',
  'Compare game versions side by side, in the game\'s own terms first: the stats on its boards (glitchless_dashboard) and its own events per session, then the built-in measures it reports (frame time overall and per level, hitches/min, crash-free and error-free sessions, errors per session, level completion, rage-quit rate, deaths per session, geometry growth). Use it to confirm a fix or a design change after shipping a new version.',
  { service: common.service, hours: common.hours, a: z.string().optional().describe('Baseline version (default: second newest)'), b: z.string().optional().describe('New version (default: newest)') },
  async ({ service, hours, a, b }) => {
    const svc = await resolveService(service);
    const { versions, has = {}, board = [] } = await query('versions', { service: svc, ...range(hours || 72) });
    if (versions.length < 2 && !(a && b)) return reply(`Only one version of ${svc} has reported in this window`, versions);
    const va = versions.find((v) => v.version === a) || versions.at(-2);
    const vb = versions.find((v) => v.version === b) || versions.at(-1);
    const pair = (x, y) => ({ [va.version]: x ?? null, [vb.version]: y ?? null, change: x != null && y != null ? Math.round((y - x) * 100) / 100 : null });
    // Only the measures this game reports: no frame times for a game that sends none.
    const keys = [...(has.frames ? ['frame_p50', 'frame_p95', 'frame_p99', 'hitches_per_min'] : []), 'crash_free_pct', 'error_free_pct', 'errors_per_session', ...(has.levels ? ['level_completion_pct'] : []), ...(has.deaths || has.fails ? ['rage_quit_pct'] : []), ...(has.deaths ? ['deaths_per_session'] : []), ...(has.geometry ? ['geometries_growth_per_level_load'] : [])];
    const delta = Object.fromEntries(keys.map((k) => [k, pair(va[k], vb[k])]));
    const own = Object.fromEntries(board.map((s, i) => [s.unit === 'per session' ? `${s.title} (per session)` : s.title, pair(va.board?.[i], vb.board?.[i])]));
    const events = Object.fromEntries(Object.keys(vb.events || va.events || {}).map((n) => [n, pair(va.events?.[n], vb.events?.[n])]));
    const levels = [...new Set([...Object.keys(va.level_p95 || {}), ...Object.keys(vb.level_p95 || {})])];
    const level_p95 = Object.fromEntries(levels.map((l) => [l, { [va.version]: va.level_p95?.[l] ?? null, [vb.version]: vb.level_p95?.[l] ?? null }]));
    return reply(`${svc}: ${va.version} (${va.sessions} sessions) vs ${vb.version} (${vb.sessions} sessions)`, { board: own, events_per_session: events, delta, level_p95, all_versions: versions.map((v) => ({ version: v.version, sessions: v.sessions, first_seen: new Date(v.first_seen).toISOString() })) });
  },
);

tool(
  'glitchless_session',
  'One play session in detail: device/GPU, outcome (crashed, rage quit), and the full event timeline (levels, deaths with positions, errors, hitches with causes, agent annotations) plus per-5s frame stats. Use with session ids from errors, hitches or rage quits.',
  { service: common.service, session_id: z.string().describe('Session id (s_…)') },
  async ({ service, session_id }) => {
    const svc = await resolveService(service);
    const d = await query('session', { service: svc, id: session_id });
    if (d.error) return reply(`Session ${session_id} not found in ${svc}`, {});
    return reply(`Session ${session_id}`, { session: d.session, timeline: d.timeline.slice(0, 150), frames: d.frames.map(({ ctx, ...f }) => ({ ...f, ...ctx })).slice(0, 120) });
  },
);

// Unlike the tools above, this one acts: it launches browsers and writes .glitchless/playtest/<name>.json
// in the project, so it is registered without the read-only hint.
server.registerTool(
  'glitchless_playtest',
  {
    description:
      "Playtest the game with its autoplay bots and compare against a saved baseline. Bots play fixed-seed scenarios in real Chrome, one at a time, against the running game; Glitchless then compares frame time (overall and per level), render CPU, draw calls, errors, crashes, completion and deaths with the baseline. Regressions fail; warnings and improvements are listed. Call with save_as \"baseline\" BEFORE changing code, then without arguments AFTER the change. Takes 1–5 minutes (quick: about 1). Needs the game and the Glitchless server running and Playwright installed in the project.",
    inputSchema: {
      save_as: z.string().optional().describe('Save this run under a name, e.g. "baseline" before a change'),
      compare_to: z.string().optional().describe('Saved run to compare with (default "baseline" when saved)'),
      quick: z.boolean().optional().describe('Play only the first scenario (about a minute)'),
      game_url: z.string().optional().describe('Game URL to play (default http://localhost:5173/ or glitchless.playtest.json)'),
      max_seconds: z.number().min(10).max(600).optional().describe('Cap each run at this many seconds'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ save_as, compare_to, quick, game_url, max_seconds } = {}, extra) => {
    const token = extra?._meta?.progressToken;
    let step = 0;
    const log = (message) => {
      if (token != null) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }).catch(() => {});
    };
    try {
      const r = await playtest({
        saveAs: save_as,
        compareTo: compare_to,
        quick,
        maxSeconds: max_seconds,
        config: { server: BASE, api_key: API_KEY || undefined, service: DEFAULT_SERVICE || undefined, game: game_url },
        log,
      });
      const files = Object.entries(r.files || {}).map(([k, f]) => `${k}: ${f}`).join('\n');
      return { content: [{ type: 'text', text: `${r.report}\n\nVerdict: ${r.verdict.toUpperCase()}\nSaved runs:\n${files}` }] };
    } catch (err) {
      return fail(err);
    }
  },
);

function slimIssue(i) {
  return { fingerprint: i.fingerprint, kind: i.kind, message: i.message, location: i.location, count: i.count, sessions: i.sessions, sessions_pct: i.sessions_pct, levels: i.levels, versions: i.versions, first_version: i.first_version, last_seen: new Date(i.last_seen).toISOString() };
}

function slimGroup(g) {
  return { key: g.key, sessions: g.sessions, p50: g.p50, p95: g.p95, p99: g.p99, pct_over_budget: g.pct_over_budget, hitches_per_min: g.hitches_per_min, draw_calls: g.draw_calls };
}

await server.connect(new StdioServerTransport());
