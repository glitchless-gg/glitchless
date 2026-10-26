// The game's own metrics: its custom events, counters and funnels, the session properties it sets, and versions (or
// Steam branches, or a property's values) compared in its own terms.
import { z } from 'zod';
import { query, resolveService, range, reply, common, tool, filters } from '../context.js';

tool(
  'glitchless_events',
  "The game's own metrics, from the custom events it sends with track() and the streams it counts with count() (marked counted: summed on the device per window, so their numbers have sums and averages but no spread): each event's count in the window, the sessions and players that sent it, how its attribute values break down (for example plays by mode, paywall views by placement, purchases started vs done; a list attribute such as a deck by element, each event counted once under each), the sums of its numeric attributes per currency (revenue: the amount of purchase events) and their p50, p90 and p99, and `hours`, the hours played in the window, to turn any count into a rate per hour. Give `funnel` to count the sessions that went from one event to the next, in that order. With name and `rate` (a flag such as \"won\", or a word outcome \"result=win\") or `avg` (a numeric attribute), it measures that event: overall, or with `by` per value (win rate by hero, with a 95% interval for each, next to the overall rate). With name and `of` (a numeric attribute), it gives that attribute's distribution: percentiles and a histogram, optionally `by` a split. `properties` lists what the game set for its sessions with setProperties (rank, class, region, a preset), each with its values and their sessions and players; identifier_like marks one with more than 200 values a day, which is an ID rather than a property. Every read tool filters by them (props) and splits by them (by \"$rank\").",
  {
    ...common,
    name: z.string().optional().describe('Only this event, e.g. "paywall". With rate, avg or of, the event to measure; it can carry a filter like a panel\'s event: "match_end:mode=ranked", or "battle_end:deck=hog_rider+ice_spirit" for decks with both'),
    funnel: z.string().optional().describe('Steps in order, comma-separated: "open,paywall,buy". A step can require a value: "buy=done" (any attribute) or "buy:step=done"; a list matches when it has the value'),
    rate: z.string().optional().describe('The share of the event\'s events where a flag holds ("won": true or false, or 1 or 0) or a word outcome holds ("result=win")'),
    avg: z.string().optional().describe('A numeric attribute\'s mean per event, e.g. "duration_s"'),
    of: z.string().optional().describe('A numeric attribute whose distribution to give, e.g. "duration_s" (match length) or "placement"'),
    by: z.string().optional().describe('With rate, avg or of: split by an attribute (a list splits by element), $version, $level, $zone, $platform, $browser, $device_tier, $link (the kind of connection), or a session property ("$rank")'),
    min: z.number().int().optional().describe('With rate or avg and by: the fewest events a row needs (default 30 for a rate, 10 for an average); smaller rows are counted in small'),
  },
  async ({ service, hours, name, funnel, rate, avg, of, by, min, ...f }) => {
    const svc = await resolveService(service);
    const d = await query('events', { service: svc, ...filters(f), name: name?.split(/[:=]/)[0].trim(), event: name, funnel, rate, avg, of, by, min, ...range(hours) });
    const brief = d.events
      .slice(0, 15)
      .map((e) => `${e.name}${e.counted ? ' (counted)' : ''}: ${e.count} in ${e.sessions} session(s)${(e.sums || []).length ? `; ${e.sums.map((x) => `${x.attr} sum ${x.sum}${x.currency ? ` ${x.currency}` : ''}`).join(', ')}` : ''}`)
      .join('\n');
    const props = d.properties || [];
    const propLine = props.length ? `\nSession properties: ${props.map((p) => (p.identifier_like ? `${p.key} (an ID: too many values)` : `${p.key} (${p.values.slice(0, 5).map((v) => v.value).join(', ')}${p.values.length > 5 ? ', …' : ''})`)).join('; ')}` : '';
    const m = d.measure;
    const measured = m ? `\n${m.event} ${m.rate ? `rate of ${m.rate}` : `average ${m.avg}`}${m.by ? ` by ${m.by}` : ''}: ${m.empty ? m.why : m.rows ? `${m.rows.length} rows, overall ${m.overall}${m.rate ? '%' : ''}` : `${m.value}${m.unit === '%' ? '%' : ''} of ${m.events} events`}` : '';
    const dist = d.distribution ? `\n${d.distribution.event} ${d.distribution.of}: ${d.distribution.empty ? d.distribution.why : `p50 ${d.distribution.p50}, p90 ${d.distribution.p90} of ${d.distribution.count}`}` : '';
    return reply(`Custom events for ${svc} (${hours || 24}h, ${d.sessions} sessions, ${d.hours ?? 0} hours played):\n${brief || 'None in this window. A game sends them with track(name, attrs), and streams with count(name, attrs).'}${propLine}${measured}${dist}`, {
      events: d.events.map(({ series, ...e }) => e),
      hours_played: d.hours ?? null,
      properties: props,
      ...(d.funnel ? { funnel: d.funnel } : {}),
      ...(m ? { measure: (({ ts, series, ...x }) => x)(m) } : {}),
      ...(d.distribution ? { distribution: d.distribution } : {}),
    });
  },
);

tool(
  'glitchless_compare_versions',
  'Compare game versions side by side, in the game\'s own terms first: the stats on its boards (glitchless_dashboard) and its own events per session, then the built-in measures it reports (frame time overall and per level, hitches/min, crash-free and error-free sessions, errors per session, level completion, rage-quit rate, deaths per session, geometry growth). Use it to confirm a fix or a design change after shipping a new version. Versions come in release order (when each first showed up at all, not in this window), so by default it compares the newest with the one before it, also while players of older versions still play. For a game on Steam, by "steam_branch" compares Steam branches instead (a beta against "public"), and by "steam_build" Steam builds: a and b are then branch names or build ids. By a session property ("class", "spender"; glitchless_events lists them) it compares that property\'s values the same way, the most sessions first (over 31 days or less): a and b are then values.',
  {
    service: common.service,
    hours: common.hours,
    env: common.env,
    session_type: common.session_type,
    props: common.props,
    a: z.string().optional().describe('Baseline version, branch or build (default: the one before the newest)'),
    b: z.string().optional().describe('New version, branch or build (default: newest)'),
    by: z.string().optional().describe('What to compare (default version): steam_branch or steam_build (a game that uses Steamworks), or a session property\'s key, e.g. "class"'),
  },
  async ({ service, hours, a, b, by, env, session_type, props }) => {
    const svc = await resolveService(service);
    const steam = by && by !== 'version' ? by.replace(/^\$/, '') : null;
    const { versions, has = {}, board = [] } = await query('versions', { service: svc, ...filters({ env, session_type, props }), ...(steam ? { by: steam } : {}), ...range(hours || 72) });
    const prop = steam && steam !== 'steam_branch' && steam !== 'steam_build';
    const what = steam === 'steam_branch' ? 'Steam branch' : steam === 'steam_build' ? 'Steam build' : prop ? `${steam} value` : 'version';
    if (steam && !versions.length) return reply(prop ? `No session of ${svc} has the property ${steam} in this window: the game sets it with setProperties (glitchless_events lists the properties it sends)` : `No session of ${svc} sent its ${what} in this window: the SDKs read it from Steamworks when the game uses it and runs from Steam`, versions);
    if (versions.length < 2 && !(a && b)) return reply(`Only one ${what} of ${svc} has reported in this window`, versions);
    // A version asked for by name is that one or none: never quietly another.
    const va = a ? versions.find((v) => v.version === a) : versions.at(-2);
    const vb = b ? versions.find((v) => v.version === b) : versions.at(-1);
    if (!va || !vb) {
      const missing = [!va && (a ?? 'an older one'), !vb && (b ?? 'a newer one')].filter(Boolean).join(' and ');
      return reply(`No sessions of ${svc} from ${what} ${missing} in this window (${hours || 72}h); the ${what}s that reported in it: ${versions.map((v) => v.version).join(', ') || 'none'}. Try a longer window with hours`, versions);
    }
    const pair = (x, y) => ({ [va.version]: x ?? null, [vb.version]: y ?? null, change: x != null && y != null ? Math.round((y - x) * 100) / 100 : null });
    // Only the measures this game reports: no frame times for a game that sends none.
    const keys = [...(has.frames ? ['frame_p50', 'frame_p95', 'frame_p99', 'hitches_per_min'] : []), 'crash_free_pct', 'error_free_pct', 'errors_per_session', ...(has.levels ? ['level_completion_pct'] : []), ...(has.deaths || has.fails ? ['rage_quit_pct'] : []), ...(has.deaths ? ['deaths_per_session'] : []), ...(has.geometry ? ['geometries_growth_per_level_load'] : [])];
    const delta = Object.fromEntries(keys.map((k) => [k, pair(va[k], vb[k])]));
    const own = Object.fromEntries(board.map((s, i) => [s.unit === 'per session' ? `${s.title} (per session)` : s.title, pair(va.board?.[i], vb.board?.[i])]));
    const events = Object.fromEntries(Object.keys(vb.events || va.events || {}).map((n) => [n, pair(va.events?.[n], vb.events?.[n])]));
    const levels = [...new Set([...Object.keys(va.level_p95 || {}), ...Object.keys(vb.level_p95 || {})])];
    const level_p95 = Object.fromEntries(levels.map((l) => [l, { [va.version]: va.level_p95?.[l] ?? null, [vb.version]: vb.level_p95?.[l] ?? null }]));
    // Branches and builds are compared from the sessions' own frame windows, which carry no level: no level_p95.
    return reply(`${svc}: ${steam ? `${what} ` : ''}${va.version} (${va.sessions} sessions) vs ${vb.version} (${vb.sessions} sessions)`, { board: own, events_per_session: events, delta, ...(steam ? {} : { level_p95 }), [steam ? `all_${steam === 'steam_branch' ? 'branches' : steam === 'steam_build' ? 'builds' : 'values'}` : 'all_versions']: versions.map((v) => ({ [steam || 'version']: v.version, sessions: v.sessions, first_seen: new Date(v.first_seen).toISOString(), ...(steam ? {} : { first_seen_ever: v.first_seen_ever == null ? null : new Date(v.first_seen_ever).toISOString() }) })) });
  },
);
