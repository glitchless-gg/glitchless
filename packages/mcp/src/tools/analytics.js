// The game's own metrics: its custom events and funnels, and versions compared in its own terms.
import { z } from 'zod';
import { query, resolveService, range, reply, common, tool } from '../context.js';

tool(
  'glitchless_events',
  "The game's own metrics, from the custom events it sends with track(): each event's count in the window, the sessions and players that sent it, how its attribute values break down (for example plays by mode, paywall views by placement, purchases started vs done), and the sums of its numeric attributes per currency (revenue: the amount of purchase events). Give `funnel` to count the sessions that went from one event to the next, in that order.",
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
      .map((e) => `${e.name}: ${e.count} in ${e.sessions} session(s)${(e.sums || []).length ? `; ${e.sums.map((x) => `${x.attr} sum ${x.sum}${x.currency ? ` ${x.currency}` : ''}`).join(', ')}` : ''}`)
      .join('\n');
    return reply(`Custom events for ${svc} (${hours || 24}h, ${d.sessions} sessions):\n${brief || 'None in this window. A game sends them with track(name, attrs).'}`, {
      events: d.events.map(({ series, ...e }) => e),
      ...(d.funnel ? { funnel: d.funnel } : {}),
    });
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
