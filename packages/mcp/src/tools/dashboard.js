// The game's own dashboard: read its pages and one board's numbers, and save a new design.
import { z } from 'zod';
import { server, query, write, resolveService, range, reply, fail, common, tool, filters } from '../context.js';

tool(
  'glitchless_dashboard',
  "The game's dashboard: its pages in order, each a board (panels in the game's own terms) or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live, reports), and one board's panels with their numbers for the window. `page` picks the board (default: the first). `source` says whether the dashboard was saved (by an agent or a person) or made automatically from what the game sends; `spec` (its pages, and its currency if it has one) is what to edit and send back to glitchless_set_dashboard. Money panels answer their `currency`, and `mismatch` lists amounts sent in another currency, which are left out.",
  { ...common, page: z.string().optional().describe('Id of the board page to evaluate (default: the first board)') },
  async ({ service, hours, page, ...f }) => {
    const svc = await resolveService(service);
    const { dashboard } = await query('dashboard', { service: svc, ...filters(f), ...range(hours) });
    if (!dashboard) return reply(`${svc} has sent no data yet`, {});
    const b = await query('board', { service: svc, ...filters(f), page, ...range(hours) });
    const pages = dashboard.pages.map((p) => ({ id: p.id, title: p.title, ...(p.view ? { view: p.view, ...(p.options ? { options: p.options } : {}) } : { panels: p.panels }) }));
    // A positions panel can hold thousands of bins: its busiest ten say where players die.
    const brief = (p) => (p.type === 'positions' && !p.empty ? { ...p, deaths: p.deaths?.slice(0, 10), path: p.path && { ...p.path, cells: p.path.cells.slice(0, 10) } } : p);
    const board = b.board ? { page: b.board.page, title: b.board.title, panels: b.board.panels.map(({ ts, series, p50, p95, ...p }) => brief(p)) } : { error: b.error };
    return reply(`Dashboard for ${svc} (${dashboard.source}${dashboard.updated_by ? `, saved by ${dashboard.updated_by}` : ''}):`, { pages, board, spec: dashboard.spec });
  },
);

const panelSchema = z
  .object({
    type: z.enum(['stat', 'series', 'breakdown', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live', 'reports', 'retention', 'positions']).describe('retention: D1, D7 and D30 by the day players were first seen; needs player IDs (privacy install or full). positions: where players died on one level (and where they went), as counts per bin: safe on a shared board, and a game can poll it through a share link to draw its own dead'),
    title: z.string().optional().describe("In the game's own words, e.g. \"Stops won vs lost\""),
    note: z.string().optional().describe('One line on why this panel matters'),
    size: z.enum(['s', 'm', 'l']).optional().describe('s = a quarter row (stats), m = half, l = full width'),
    metric: z.string().optional().describe('stat: sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct or players_now (sessions playing in the last two minutes, whatever the range)'),
    event: z.string().optional().describe('stat, series, breakdown: one event, "name", "name=value" or "name:key=value". A series or breakdown by $platform, $browser or $device_tier can leave it out: then it counts sessions (and players, with player IDs) in each'),
    sum: z.string().optional().describe('stat, series, breakdown: add up this numeric attribute instead of counting events, e.g. "amount" of "purchase" for revenue. Money (events with a currency) shows in the game\'s currency; amounts in another currency are named, not added'),
    per: z.string().optional().describe('stat: divide by this event to get a percentage (event "buy=done" per "paywall"); or "$players" / "$sessions": the share of them that sent the event (conversion), or with sum, the sum per player or session (revenue per player)'),
    by: z.string().optional().describe('series, breakdown: the attribute to split by, e.g. "mode" or "what", or $version / $level, or a split of the sessions that sent the event: $platform (Windows, macOS, Linux, Steam Deck, iOS, Android, Web…), $browser (Chrome, Safari, Firefox, Edge…; a native build is "Godot app", "Unity app" and so on, a web build "Unity web build"), $device_tier (High-end, Mid-range, Low-end GPU, Software rendering: the tiers the Performance view uses, high to low); counts only, no sum, over 31 days or less. With sum and an attribute, event is a name only. A breakdown (by count) can also split by a Steam fact of the sessions that sent the event: $steam_branch, $steam_build, $steam_hardware, $steam_controller, $steam_language, $proton, $big_picture, $family_shared, $timed_trial. versions: $steam_branch or $steam_build compares Steam branches or builds on this page\'s stats instead of versions (the beta against "public"); needs a game that uses Steamworks'),
    limit: z.number().int().optional().describe('How many: errors, findings, reports and breakdown rows up to 20, sessions up to 50, series lines up to 8, retention days up to 90 (default 14)'),
    steps: z.string().optional().describe('funnel: events in order, comma-separated, e.g. "paywall,buy=tapped,buy=done"'),
    label: z.string().optional().describe('levels: what the game calls a level, e.g. "Stop" or "Puzzle"'),
    sent: z.string().optional().describe('sessions: only sessions that sent this event, e.g. "buy=done"'),
    events: z.array(z.string()).optional().describe('live: only these event names or types, e.g. ["buy", "paywall", "error"]'),
    level: z.string().optional().describe('positions (required): the level id, as the game passes it to levelStart'),
    show: z.enum(['deaths', 'path', 'both', 'installs', 'revenue']).optional().describe('positions: deaths (default), path (where players went, on a coarser grid) or both. store_revenue by_country: installs (default) or revenue, what its map shows first (people can switch)'),
    bin: z.number().positive().optional().describe("positions: a bin's width in world units (default about a hundredth of the level). Fix it when a game draws the panel, so bins don't move as the level fills in"),
  })
  .describe('One panel');

// The store panels (server/src/reviews.js), for a game connected to a store: their types, and `store`.
const STORE_PANELS = {
  store_reviews: 'reviews over time and by build, with what was measured on each',
  store_vitals: "the store's own vitals by version (Google Play: slow rendering, crashes, ANRs; the App Store: hangs, launch, hitches) next to what Glitchless measured, with where they disagree",
  store_players: 'players online next to the sessions measured: telemetry coverage',
  store_sales: 'units, returns and wishlists by day; on Steam needs the Financial API key',
  store_score: "a store's rating, small (size s): the average stars of the written reviews synced in the window and how many, next to the store's own overall rating where it has one (the App Store: Apple's rating and rating count; Steam: its review summary). Google Play has no API for its overall rating, so it shows the synced reviews' average and says so. One panel per store",
  store_revenue: "real revenue from RevenueCat (store revenuecat; give measure): revenue in the window, revenue per player measured, installs (RevenueCat's new customers) next to Glitchless's new players, active users a day, MRR, active subscriptions, active trials, revenue per day next to the game's own purchase events, installs and active users per day, revenue by version next to what Glitchless measured, a world map of installs and revenue by country with a ranked list (by_country, size l), or revenue by store (App Store, Google Play) next to the iOS and Android sessions Glitchless measured (by_store)",
};
const withStores = (panel) =>
  panel
    .extend({
      type: z.enum([...panel.shape.type.options, ...Object.keys(STORE_PANELS)]).describe(`${panel.shape.type.description} For a game connected to a store (Steam; give store): ${Object.entries(STORE_PANELS).map(([t, d]) => `${t} (${d})`).join(', ')}`),
      store: z.enum(['steam', 'app_store', 'google_play', 'revenuecat']).optional().describe("store_reviews, store_players, store_sales, store_vitals, store_score: the store (default: the game's first connected one); store_revenue: revenuecat"),
      measure: z.enum(['revenue', 'per_player', 'installs', 'active_users', 'mrr', 'actives', 'trials', 'by_day', 'players_by_day', 'by_version', 'by_country', 'by_store']).optional().describe('store_revenue (required): revenue (in the window), per_player (over the players Glitchless measured), installs (new customers, next to Glitchless\'s new players), active_users (a day), mrr, actives (active subscriptions), trials (active trials), by_day (revenue), players_by_day (installs and active users), by_version, by_country (a world map of installs and revenue, and a list: country, installs, revenue, purchases; RevenueCat\'s countries are read once a day), by_store (revenue by store next to the sessions on its platform)'),
    })
    .describe('One panel');

const pageSchema = z
  .object({
    id: z.string().optional().describe('Short id used in the page address, e.g. "money" (default: from the title)'),
    title: z.string().optional().describe('The name in the sidebar, in the words the game uses (a view keeps its built-in name without one)'),
    icon: z.enum(['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock', 'bug', 'money']).optional(),
    panels: z.array(withStores(panelSchema)).optional().describe('A board: its panels, in order'),
    view: z.enum(['events', 'performance', 'errors', 'players', 'heatmaps', 'sessions', 'versions', 'live', 'reports']).optional().describe('A built-in view instead of panels (reports: the bug reports players sent, with their screenshots)'),
    options: z.object({ events: z.array(z.string()).optional() }).optional().describe('live view: events, only these event names or types'),
  })
  .describe('One page: either panels (a board) or view (a built-in view)');

server.registerTool(
  'glitchless_set_dashboard',
  {
    description:
      "Save the game's dashboard: its pages, in the order the sidebar shows them. Each page is a board of panels in the game's own words, or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live, reports) the game keeps, renames or drops. Design it for this game, not for a genre it isn't: a puzzle game cares about solve time and hints, a mobile game about opens, modes, the paywall and purchases (revenue: a stat with sum \"amount\" of \"purchase\"; revenue per player: per \"$players\"; conversion: event \"purchase\" per \"$players\"; revenue by item: a breakdown with sum), a platformer about deaths per level (and a positions panel for where on a level they die). For a game on several platforms, a breakdown by $platform splits players or an event between them (iOS vs Android, PC vs Mac vs Steam Deck); a web game splits by $browser, and any game by $device_tier. The first page opens first. Use the events the game sends (glitchless_events lists them, with their attributes); on a board, stats first, then the game's own events and funnels, then levels, frame_time and errors. Leave out what the game has no data for (no Heatmaps page for a game without positions, no reports page for a game that doesn't turn bug reports on). Send every page: read the current ones with glitchless_dashboard (its spec), change them, send them all back. Pass reset: true to go back to the automatic dashboard. Needs a secret key with the dashboard scope.",
    inputSchema: {
      service: z.string().optional().describe('Game service name (defaults to the most recently active game)'),
      pages: z.array(pageSchema).optional(),
      currency: z.string().optional().describe('The game\'s one currency for money panels, an ISO 4217 code such as "USD" (default: the one most of its purchases are sent in). Send it again with every save: glitchless_dashboard\'s spec has it'),
      reset: z.boolean().optional().describe('Delete the saved dashboard and go back to the automatic one'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ service, pages, currency, reset }) => {
    try {
      const svc = await resolveService(service);
      if (!reset && !pages?.length) throw new Error('give pages, or reset: true');
      const res = await write(reset ? 'DELETE' : 'PUT', `/v1/dashboard?service=${encodeURIComponent(svc)}`, reset ? null : { ...(currency ? { currency } : {}), pages });
      if (reset) return reply(`Dashboard for ${svc} reset to automatic.`, {});
      // How each board looks with the last 7 days, so empty panels show up now rather than in the dashboard.
      const lines = [];
      for (const p of res.dashboard.pages) {
        if (p.view) {
          lines.push(`${p.title} (built-in ${p.view} view)`);
          continue;
        }
        const { board } = await query('board', { service: svc, page: p.id, ...range(168) });
        lines.push(`${p.title}:`, ...board.panels.map((x) => `  - ${x.title}${x.empty ? ` (no data yet: ${x.why})` : ''}${x.mismatch?.length ? ` (left out, another currency: ${x.mismatch.map((m) => `${m.events} in ${m.currency}`).join(', ')})` : ''}`));
      }
      return reply(`Saved the dashboard for ${svc} (${res.dashboard.pages.length} pages${res.dashboard.currency ? `, money in ${res.dashboard.currency}` : ''}). How it looks with the last 7 days:\n${lines.join('\n')}`, {});
    } catch (err) {
      return fail(err);
    }
  },
);
