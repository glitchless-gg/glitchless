// The game's own dashboard: read its pages and one board's numbers, and save a new design.
import { z } from 'zod';
import { define, query, write, resolveService, range, reply, common, tool, filters } from '../context.js';

tool(
  'glitchless_dashboard',
  "The game's dashboard: its pages in order, each a board (panels in the game's own terms) or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live, reports, servers, matches), and one board's panels with their numbers for the window. A board page with `where` shows only the sessions with those property values. `page` picks the board (default: the first). `source` says whether the dashboard was saved (by an agent or a person) or made automatically from what the game sends; `spec` (its pages, and its currency if it has one) is what to edit and send back to glitchless_set_dashboard. Money panels answer their `currency`, and `mismatch` lists amounts sent in another currency, which are left out. `brand` is the game's branding on its boards and share links: its accent colour (set with glitchless_set_dashboard's accent) and whether it has a logo and a banner (people upload those in the dashboard: Edit pages → Look).",
  { ...common, page: z.string().optional().describe('Id of the board page to evaluate (default: the first board)') },
  async ({ service, hours, page, ...f }) => {
    const svc = await resolveService(service);
    const { dashboard } = await query('dashboard', { service: svc, ...filters(f), ...range(hours) });
    if (!dashboard) return reply(`${svc} has sent no data yet`, {});
    const b = await query('board', { service: svc, ...filters(f), page, ...range(hours) });
    // A server without branding (501), or none set: no brand.
    const brand = (await write('GET', `/v1/brand?service=${encodeURIComponent(svc)}`).catch(() => null))?.brand;
    const pages = dashboard.pages.map((p) => ({ id: p.id, title: p.title, ...(p.view ? { view: p.view, ...(p.options ? { options: p.options } : {}) } : { panels: p.panels, ...(p.where ? { where: p.where } : {}) }) }));
    // A positions panel can hold thousands of bins: its busiest ten say where players die.
    // A table's times read as dates (each row's values are in its columns' order).
    const brief = (p) => {
      if (p.empty) return p;
      if (p.type === 'positions') return { ...p, deaths: p.deaths?.slice(0, 10), path: p.path && { ...p.path, cells: p.path.cells.slice(0, 10) } };
      if (p.type === 'table') {
        const at = p.columns.findIndex((c) => c.key === '$time');
        return at < 0 ? p : { ...p, groups: p.groups.map((g) => ({ ...g, rows: g.rows.map((r) => r.map((v, i) => (i === at && v != null ? new Date(v).toISOString() : v))) })) };
      }
      return p;
    };
    // Charts over time are left out (their numbers are in the panel's own fields, a net or servers panel's in kpis and
    // rows): any list as long as the panel's buckets goes; a distribution keeps its percentiles.
    const overTime = ({ ts, series, ...p }) => (Array.isArray(ts) ? Object.fromEntries(Object.entries(p).filter(([, v]) => !(Array.isArray(v) && v.length === ts.length))) : p);
    const board = b.board ? { page: b.board.page, title: b.board.title, panels: b.board.panels.map((p) => brief(overTime(p))) } : { error: b.error };
    return reply(`Dashboard for ${svc} (${dashboard.source}${dashboard.updated_by ? `, saved by ${dashboard.updated_by}` : ''}):`, { pages, board, spec: dashboard.spec, brand: brand ? { accent: brand.accent, logo: !!brand.logo, banner: !!brand.banner } : null });
  },
);

const panelSchema = z
  .object({
    type: z.enum(['stat', 'series', 'breakdown', 'distribution', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live', 'reports', 'retention', 'positions', 'net', 'servers', 'table']).describe('distribution: how a numeric attribute (of) spreads, as percentiles (p50, p90, p99) and a histogram, optionally by a split: match length, time in queue, placement, floors reached. levels: starts, completions, fails, deaths and disconnects per level, with the median and p90 clear time; by splits each level\'s attempts (clears by tier, by class), count "runs" counts runs per biome. retention: D1, D7 and D30 by the day players were first seen; needs player IDs (privacy install or full); by a property, per value. positions: where players died on one level (and where they went), as counts per bin: safe on a shared board, and a game can poll it through a share link to draw its own dead. net (a multiplayer game): show ping (p50 and p95 over time, and the share of play over 150 ms), loss, or disconnects (per hour played, by reason), optionally by a split ($region, $link, $level, $version). servers (a game whose dedicated servers run the SDK in server mode): show ticks (tick time against its budget, by "players" connected, $level or $version), players, or crashes (with the matches and players each ended). table: one event\'s events listed one by one (each a row of its attributes, time, version, platform, level or session), grouped by an attribute with each group\'s events, sessions and the lowest, average and highest of a number: daily runs by day with their scores, runs by seed, matches by mode. Only track() events have rows (count() sends totals); a session keeps its first 16 of each event'),
    title: z.string().optional().describe("In the game's own words, e.g. \"Stops won vs lost\""),
    note: z.string().optional().describe("One line on why this panel matters: people read it behind the info icon next to the panel's title"),
    size: z.enum(['s', 'm', 'l']).optional().describe('s = a quarter row (stats), m = half, l = full width'),
    metric: z.string().optional().describe('stat: sessions, players, avg_session_s, median_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct, hours_played (the time the game was on screen), players_now (sessions playing in the last two minutes, whatever the range), runs (each run once). Network (multiplayer): ping_p50, ping_p95 (ms), loss_pct, disconnects_per_hour, disconnect_pct (level attempts a disconnect ended). Servers (from the game\'s servers in server mode): servers_now (running now, with the players connected to them), server_tick_p95, server_crash_free_pct, players_per_server. deaths and errors take per "$hours": deaths per hour played'),
    event: z.string().optional().describe('stat, series, breakdown, distribution, table: one event, "name", "name=value" or "name:key=value". A list attribute (a deck, a build) matches when it has the value, and "battle_end:deck=hog_rider+ice_spirit" when it has all of them (any pair or trio). A series or breakdown by $platform, $browser or $device_tier can leave it out: then it counts sessions (and players, with player IDs) in each'),
    sum: z.string().optional().describe('stat, series, breakdown: add up this numeric attribute instead of counting events, e.g. "amount" of "purchase" for revenue. Money (events with a currency) shows in the game\'s currency; amounts in another currency are named, not added'),
    per: z.string().optional().describe('stat: divide by this event to get a percentage (event "buy=done" per "paywall"); or "$players" / "$sessions": the share of them that sent the event (conversion), or with sum, the sum per player or session (revenue per player); or "$hours": per hour played (matches per hour, with sum XP or gold per hour). series, breakdown: "$hours", each bucket or row per hour played (by $version or $level each over its own hours, by an attribute every row over the window\'s)'),
    rate: z.string().optional().describe('stat, series, breakdown: the share of the event\'s events where a flag holds, "won" (a boolean, or a number that is only 1 or 0), or a word outcome holds, "result=win". A breakdown gives each row its rate with a 95% interval (low, high) next to the overall rate: win rate by hero, by heat, of decks with each card (by a list), boons taken when offered. Send outcomes as booleans where you can: a word outcome split by another attribute reads the first 16 of each session\'s events'),
    avg: z.string().optional().describe('stat, series, breakdown: a numeric attribute\'s mean per event instead of a count, e.g. "duration_s" by mode'),
    min: z.number().int().optional().describe('breakdown with rate or avg: rows with fewer events are left out and counted in small (default 30 for a rate, 10 for an average)'),
    expect: z.number().optional().describe('breakdown or stat with rate: the percentage the game intends, such as a gacha\'s published odds (0.6 for 0.6%). Rows whose interval misses it are marked, and a finding names them'),
    order: z.enum(['rate', 'avg', 'count', 'value']).optional().describe('breakdown with rate or avg: rate or avg (default, the highest first), count (most events first) or value (in the values\' own order: heat 0, 1, 2)'),
    of: z.string().optional().describe('distribution (required), stat: the numeric attribute whose spread to show, e.g. "duration_s". A stat with of and quantile shows one percentile: the median match. table: the numeric attribute whose lowest, average and highest each group header shows, e.g. "score"'),
    quantile: z.number().int().optional().describe('stat with of: the percentile, 1 to 99 (50: the median, 90: 1 in 10 is over it)'),
    bins: z.number().int().optional().describe('distribution: how many histogram bars, 2 to 40 (default 20). Bars are equal round steps from the 1st to the 99th percentile; under and over count what falls outside'),
    unit: z.string().optional().describe('distribution, stat with of: what the numbers are in, shown after them ("s" reads as minutes or hours when large, or the game\'s own word: "floors")'),
    by: z.string().optional().describe('series, breakdown, distribution: the attribute to split by, e.g. "mode" or "what" (a list attribute splits by element: each card of a deck gets a row, and an event counts once under each), or $version / $level / $zone (where the player was in an open world, setZone), or a split of the sessions that sent the event: $platform (Windows, macOS, Linux, Steam Deck, iOS, Android, Web…), $browser (Chrome, Safari, Firefox, Edge…; a native build is "Godot app", "Unity app" and so on, a web build "Unity web build"), $device_tier (High-end, Mid-range, Low-end GPU, Software rendering: the tiers the Performance view uses, high to low), $link (Wi-Fi, Mobile data, Wired), or a session property the game sets with setProperties ($rank, $class, $region: sessions without it are "(none)", 40 values at most); counts only, no sum, over 31 days or less. levels and deaths: an attribute of the level\'s start ("tier", "party_size", a list such as "build"), a property or a split. net: $version, $level, $zone, a split or a property. servers: "players" (connected, in tenths of capacity), $level or $version. retention: a property ($spender). versions: also a property ($class), its values side by side. With sum and an attribute, event is a name only. A breakdown (by count) can also split by a Steam fact of the sessions that sent the event: $steam_branch, $steam_build, $steam_hardware, $steam_controller, $steam_language, $proton, $big_picture, $family_shared, $timed_trial. versions: $steam_branch or $steam_build compares Steam branches or builds on this page\'s stats instead of versions (the beta against "public"); needs a game that uses Steamworks'),
    limit: z.number().int().optional().describe('How many: errors, findings, reports and breakdown rows up to 20, sessions up to 50, series lines up to 8, distribution rows up to 8, retention days up to 90 (default 14), table rows per group up to 100 (default 20; at most 30 groups, the rest counted in more_groups)'),
    steps: z.string().optional().describe('funnel: events in order, comma-separated, e.g. "paywall,buy=tapped,buy=done"'),
    label: z.string().optional().describe('levels: what the game calls a level, e.g. "Stop" or "Puzzle"'),
    sent: z.string().optional().describe('sessions: only sessions that sent this event, e.g. "buy=done"'),
    events: z.array(z.string()).optional().describe('live: only these event names or types, e.g. ["buy", "paywall", "error"]'),
    level: z.string().optional().describe('positions (required): the level id, as the game passes it to levelStart. levels and deaths: only this level\'s rows'),
    count: z.enum(['runs']).optional().describe('levels: "runs" counts each run (setGroup("run")) once at each level it reached, however many sessions it spanned: a roguelite\'s runs that reach each biome'),
    show: z.enum(['deaths', 'path', 'both', 'installs', 'revenue', 'ping', 'loss', 'disconnects', 'ticks', 'players', 'crashes']).optional().describe('positions: deaths (default), path (where players went, on a coarser grid) or both. store_revenue by_country: installs (default) or revenue, what its map shows first (people can switch). net: ping (default), loss or disconnects. servers: ticks (default), players or crashes'),
    columns: z
      .array(z.union([z.string(), z.object({ key: z.string(), unit: z.string().optional() })]))
      .optional()
      .describe('table: the columns in order, up to 12: attributes of the event ("score", "attempt"), or $time, $version, $platform, $level, $session (a link to the session; numbered on a share link, never its ID). { "key": "duration_s", "unit": "s" } gives one a unit. Default: the event\'s own attributes, up to 8, without group_by'),
    group_by: z.string().optional().describe('table: rows go under one header per value of this attribute (or $version, $level, $platform), newest group first; events without it go under "(none)", last'),
    sort: z.string().optional().describe('table: the rows\' order inside each group, an attribute or $time, $version, $platform, $level, "-" first for highest first: "-score" (default "-$time", the newest first). Events without the value go last'),
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
  store_revenue: "real revenue from RevenueCat (store revenuecat) or the game's own Stripe account (store stripe); give measure: revenue in the window, revenue per player measured, revenue per day next to the game's own purchase events, revenue by version next to what Glitchless measured, or a world map of revenue by country with a ranked list (by_country, size l); RevenueCat also installs (its new customers) next to Glitchless's new players, active users a day, MRR, active subscriptions, active trials, installs and active users per day, installs on the map, and revenue by store (App Store, Google Play) next to the iOS and Android sessions Glitchless measured (by_store); Stripe also refunds (and disputes), new paying customers and revenue by product (by version from the purchases the game tied to a session)",
};
const withStores = (panel) =>
  panel
    .extend({
      type: z.enum([...panel.shape.type.options, ...Object.keys(STORE_PANELS)]).describe(`${panel.shape.type.description} For a game connected to a store (Steam; give store): ${Object.entries(STORE_PANELS).map(([t, d]) => `${t} (${d})`).join(', ')}`),
      store: z.enum(['steam', 'app_store', 'google_play', 'revenuecat', 'stripe']).optional().describe("store_reviews, store_players, store_sales, store_vitals, store_score: the store (default: the game's first connected one); store_revenue: revenuecat or stripe"),
      measure: z.enum(['revenue', 'per_player', 'installs', 'active_users', 'mrr', 'actives', 'trials', 'by_day', 'players_by_day', 'by_version', 'by_country', 'by_store', 'refunds', 'customers', 'by_product']).optional().describe('store_revenue (required): revenue (in the window), per_player (over the players Glitchless measured), by_day (revenue), by_version, by_country (a world map of installs and revenue, and a list: country, installs, revenue, purchases; RevenueCat\'s countries come with each hourly sync, Stripe\'s have revenue only); RevenueCat only: installs (new customers, next to Glitchless\'s new players), active_users (a day), mrr, actives (active subscriptions), trials (active trials), players_by_day (installs and active users), by_store (revenue by store next to the sessions on its platform); Stripe only: refunds (and disputes), customers (new paying customers), by_product'),
    })
    .describe('One panel');

const pageSchema = z
  .object({
    id: z.string().optional().describe('Short id used in the page address, e.g. "money" (default: from the title)'),
    title: z.string().optional().describe('The name in the sidebar, in the words the game uses (a view keeps its built-in name without one)'),
    icon: z.enum(['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock', 'bug', 'money']).optional(),
    panels: z.array(withStores(panelSchema)).optional().describe('A board: its panels, in order'),
    view: z.enum(['events', 'performance', 'errors', 'players', 'heatmaps', 'sessions', 'versions', 'live', 'reports', 'servers', 'matches']).optional().describe('A built-in view instead of panels (reports: the bug reports players sent, with their screenshots; servers: the game\'s dedicated servers in server mode, their ticks by map and players connected, crashes and memory; matches: the range\'s matches, each opening a match page with every player\'s ping slot by slot and the server\'s ticks under them)'),
    where: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
      .optional()
      .describe('A board page only: the session properties its sessions must have, "$<key>" → a value or a list of up to 20 (at most 4 properties), e.g. { "$rank": ["diamond", "master"] }: every panel on the page reads only those sessions (a "Diamond and up" page)'),
    options: z.object({ events: z.array(z.string()).optional() }).optional().describe('live view: events, only these event names or types'),
  })
  .describe('One page: either panels (a board) or view (a built-in view)');

define(
  'glitchless_set_dashboard',
  {
    title: 'Save dashboard',
    description:
      "Save the game's dashboard: its pages, in the order the sidebar shows them. Each page is a board of panels in the game's own words, or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live, reports, servers, matches) the game keeps, renames or drops. Design it for this game, not for a genre it isn't: a puzzle game cares about solve time and hints, a mobile game about opens, modes, the paywall and purchases (revenue: a stat with sum \"amount\" of \"purchase\"; revenue per player: per \"$players\"; conversion: event \"purchase\" per \"$players\"; revenue by item: a breakdown with sum), a platformer about deaths per level (and a positions panel for where on a level they die). For a game on several platforms, a breakdown by $platform splits players or an event between them (iOS vs Android, PC vs Mac vs Steam Deck); a web game splits by $browser, and any game by $device_tier. For balance and outcomes, a breakdown with rate gives each row its rate and interval next to the overall one (win rate by hero: event \"match_end\", by \"hero\", rate \"won\"); per \"$hours\" turns counts and sums into rates per hour played (gold per hour); a distribution panel or a stat with of and quantile shows how long matches or runs last; a table lists an event's events one by one, grouped and sorted (daily runs by day, best score first: type \"table\", event \"daily_run\", group_by \"day_label\", sort \"-score\", of \"score\"); a list attribute (deck, build, boons) splits by element. Split by what the game set for the session with setProperties ($rank, $class, $region), and give a page where to show only some sessions (a page for the high ranks); a levels panel by a levelStart attribute shows clears by tier or difficulty, and count \"runs\" runs per biome. A multiplayer game gets a Network page (ping_p95 and disconnect_pct stats, net panels by $region or $link), and one whose dedicated servers run the SDK in server mode a Servers page (servers_now, server_tick_p95, a servers panel by players) or the built-in servers view; a game that sets match groups can keep the built-in matches view. The first page opens first. Use the events the game sends (glitchless_events lists them, with their attributes); on a board, stats first, then the game's own events and funnels, then levels, frame_time and errors. Leave out what the game has no data for (no Heatmaps page for a game without positions, no reports page for a game that doesn't turn bug reports on). Send every page: read the current ones with glitchless_dashboard (its spec), change them, send them all back. Pass reset: true to go back to the automatic dashboard. accent sets the colour of the game's boards and share links (links, the selected page, stats, the main chart series, the map); it can be sent alone. Needs a secret key with the dashboard scope.",
    inputSchema: {
      service: z.string().optional().describe('Game service name (defaults to the most recently active game)'),
      pages: z.array(pageSchema).optional(),
      currency: z.string().optional().describe('The game\'s one currency for money panels, an ISO 4217 code such as "USD" (default: the one most of its purchases are sent in). Send it again with every save: glitchless_dashboard\'s spec has it'),
      reset: z.boolean().optional().describe('Delete the saved dashboard and go back to the automatic one'),
      accent: z
        .string()
        .nullable()
        .optional()
        .describe('The accent colour of the game\'s boards and share links, "#rrggbb" (the game\'s own colour, such as its logo\'s), or null for none. Kept apart from the pages: send it alone to change only the colour. The dashboard darkens or lightens it where it would be hard to read. The logo and a banner (key art) are uploaded in the dashboard: Edit pages → Look'),
    },
    // It replaces the saved pages (and reset: true deletes them), so it counts as destructive.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ service, pages, currency, reset, accent }) => {
    const svc = await resolveService(service);
    if (!reset && !pages?.length && accent === undefined) throw new Error('give pages, accent, or reset: true');
    const branded = accent === undefined ? null : (await write('PUT', `/v1/brand?service=${encodeURIComponent(svc)}`, { accent })).brand;
    const colour = accent === undefined ? '' : ` Accent: ${branded?.accent ?? 'none'}.`;
    if (!reset && !pages?.length) return reply(`Saved the look of ${svc}'s boards.${colour}`, {});
    const res = await write(reset ? 'DELETE' : 'PUT', `/v1/dashboard?service=${encodeURIComponent(svc)}`, reset ? null : { ...(currency ? { currency } : {}), pages });
    if (reset) return reply(`Dashboard for ${svc} reset to automatic.${colour}`, {});
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
    return reply(`Saved the dashboard for ${svc} (${res.dashboard.pages.length} pages${res.dashboard.currency ? `, money in ${res.dashboard.currency}` : ''}).${colour} How it looks with the last 7 days:\n${lines.join('\n')}`, {});
  },
  { scope: 'dashboard' },
);
