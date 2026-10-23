// The game's own dashboard: read its pages and one board's numbers, and save a new design.
import { z } from 'zod';
import { server, query, write, resolveService, range, reply, fail, common, tool } from '../context.js';

tool(
  'glitchless_dashboard',
  "The game's dashboard: its pages in order, each a board (panels in the game's own terms) or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live, reports), and one board's panels with their numbers for the window. `page` picks the board (default: the first). `source` says whether the dashboard was saved (by an agent or a person) or made automatically from what the game sends; `spec` (its pages, and its currency if it has one) is what to edit and send back to glitchless_set_dashboard. Money panels answer their `currency`, and `mismatch` lists amounts sent in another currency, which are left out.",
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
    type: z.enum(['stat', 'series', 'breakdown', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live', 'reports', 'retention']).describe('retention: D1, D7 and D30 by the day players were first seen; needs player IDs (privacy install or full)'),
    title: z.string().optional().describe("In the game's own words, e.g. \"Stops won vs lost\""),
    note: z.string().optional().describe('One line on why this panel matters'),
    size: z.enum(['s', 'm', 'l']).optional().describe('s = a quarter row (stats), m = half, l = full width'),
    metric: z.string().optional().describe('stat: sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct or players_now (sessions playing in the last two minutes, whatever the range)'),
    event: z.string().optional().describe('stat, series, breakdown: one event, "name", "name=value" or "name:key=value"'),
    sum: z.string().optional().describe('stat, series, breakdown: add up this numeric attribute instead of counting events, e.g. "amount" of "purchase" for revenue. Money (events with a currency) shows in the game\'s currency; amounts in another currency are named, not added'),
    per: z.string().optional().describe('stat: divide by this event to get a percentage (event "buy=done" per "paywall"); or "$players" / "$sessions": the share of them that sent the event (conversion), or with sum, the sum per player or session (revenue per player)'),
    by: z.string().optional().describe('series, breakdown: the attribute to split by, e.g. "mode" or "what", or $version / $level. With sum and an attribute, event is a name only'),
    limit: z.number().int().optional().describe('How many: errors, findings, reports and breakdown rows up to 20, sessions up to 50, series lines up to 8, retention days up to 90 (default 14)'),
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
    icon: z.enum(['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock', 'bug']).optional(),
    panels: z.array(panelSchema).optional().describe('A board: its panels, in order'),
    view: z.enum(['events', 'performance', 'errors', 'players', 'heatmaps', 'sessions', 'versions', 'live', 'reports']).optional().describe('A built-in view instead of panels (reports: the bug reports players sent, with their screenshots)'),
    options: z.object({ events: z.array(z.string()).optional() }).optional().describe('live view: events, only these event names or types'),
  })
  .describe('One page: either panels (a board) or view (a built-in view)');

server.registerTool(
  'glitchless_set_dashboard',
  {
    description:
      "Save the game's dashboard: its pages, in the order the sidebar shows them. Each page is a board of panels in the game's own words, or a built-in view (events, performance, errors, players, heatmaps, sessions, versions, live, reports) the game keeps, renames or drops. Design it for this game, not for a genre it isn't: a puzzle game cares about solve time and hints, a mobile game about opens, modes, the paywall and purchases (revenue: a stat with sum \"amount\" of \"purchase\"; revenue per player: per \"$players\"; conversion: event \"purchase\" per \"$players\"; revenue by item: a breakdown with sum), a platformer about deaths per level. The first page opens first. Use the events the game sends (glitchless_events lists them, with their attributes); on a board, stats first, then the game's own events and funnels, then levels, frame_time and errors. Leave out what the game has no data for (no Heatmaps page for a game without positions, no reports page for a game that doesn't turn bug reports on). Send every page: read the current ones with glitchless_dashboard (its spec), change them, send them all back. Pass reset: true to go back to the automatic dashboard. Needs a secret key with the dashboard scope.",
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
