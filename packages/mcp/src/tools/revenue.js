// A game's real revenue from RevenueCat (Glitchless Cloud: Settings → Integrations → RevenueCat), by day, and by app
// version, country and store where RevenueCat splits it, next to the sessions and players Glitchless measured and what
// the game's own purchase events add up to.
import { z } from 'zod';
import { query, resolveService, range, reply, common, filters, tool } from '../context.js';

tool(
  'glitchless_revenue',
  "The game's real revenue, installs and active users as RevenueCat counts them, for a game connected to RevenueCat in Glitchless Cloud (Settings → Integrations). RevenueCat counts production purchases only, never sandbox, TestFlight or licence-tester ones. It gives, for the window, revenue and transactions by UTC day, MRR, active subscriptions and trials, and revenue per player Glitchless measured. It also gives installs (RevenueCat's new customers: the first time its SDK starts on a device) next to the new players Glitchless saw, and active users a day next to Glitchless's players a day. Where RevenueCat splits revenue by the app version purchases were made on, it gives revenue by version too; where it splits by country, installs, revenue and purchases by country; where it splits by store, revenue by store (App Store, Google Play) next to the sessions Glitchless measured on iOS and Android. Each day sits next to its sessions and players, and each version next to its players, crash-free sessions and frame-time p95. It also says what the game's own purchase events (track('purchase', { amount, currency })) add up to and how much of RevenueCat's revenue that is: the gap is purchases that never reach Glitchless. Use it for money questions, e.g. whether 1.4.2 earns more per player than 1.4.1. Use glitchless_events for purchases by item, level or player.",
  {
    service: common.service,
    hours: z.number().min(24).max(9600).optional().describe('Look-back window in hours (default 720, 30 days), read as whole UTC days'),
    version: z.string().optional().describe("Only this version: its revenue (where RevenueCat splits revenue by version) over its players. MRR, subscriptions and trials stay the whole game's"),
    env: common.env,
    session_type: common.session_type,
  },
  async ({ service, hours, version, env, session_type }) => {
    const svc = await resolveService(service);
    const r = await query('store_revenue', { service: svc, ...filters({ version, env, session_type }), ...range(hours || 720) });
    if (r.connected === false) return reply(`${svc}: ${r.why}`, {});
    if (r.empty) return reply(`${r.store_name} revenue of ${svc}: ${r.why}`, { overview: r.overview?.metrics ?? null });
    const money = (v) => (v == null ? '–' : r.currency ? new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency }).format(v) : String(v));
    const n = (v) => (v == null ? '–' : v.toLocaleString('en-US'));
    const t = r.totals;
    const stock = (x, label, isMoney = false) => (x ? `${isMoney ? money(x.value) : n(x.value)} ${label}${x.change != null ? ` (${x.change >= 0 ? '+' : '−'}${isMoney ? money(Math.abs(x.change)) : n(Math.abs(x.change))} since ${x.since})` : ''}` : null);
    const g = r.glitchless;
    const lines = [
      `${r.store_name} revenue of ${svc} (project ${r.app_id}), ${r.from_day} to ${r.to_day} (UTC days)${r.version ? `, version ${r.version}` : ''}: ${money(t.revenue)}${t.transactions != null ? ` from ${n(t.transactions)} transactions` : ''}${t.incomplete ? ' (today so far included)' : ''}.`,
      r.per_player != null ? `Revenue per player: ${money(r.per_player)} over ${n(r.players)} ${r.players_are_sessions ? 'sessions (no player IDs)' : 'players'} Glitchless measured (${n(r.sessions)} sessions).` : `Glitchless measured no players in this window.`,
      `Installs (${r.store_name}'s new customers): ${n(t.installs)}${r.new_players != null ? `; Glitchless saw ${n(r.new_players)} new players (${r.new_players_pct ?? '–'}%)` : '; Glitchless counts new players only with player IDs'}. Active users: ${t.active_users_per_day != null ? `${n(t.active_users_per_day)} a day` : '–'}${r.players_per_day != null ? `; Glitchless measured ${n(r.players_per_day)} players a day` : ''}.`,
      `Now: ${[stock(r.latest.mrr, 'MRR', true), stock(r.latest.actives, 'active subscriptions'), stock(r.latest.trials, 'active trials')].filter(Boolean).join(', ') || 'no MRR, subscriptions or trials yet'}.`,
      g ? `The game's own purchase events: ${g.comparable ? money(g.purchases) : `${g.purchases} ${g.currency ?? ''}`.trim()} from ${n(g.events)} events${g.coverage_pct != null ? ` (${g.coverage_pct}% of ${r.store_name}'s)` : ''}${g.sandbox ? `; ${n(g.sandbox)} sandbox purchases left out` : ''}.` : 'The game sends no purchase events with an amount.',
      r.versions?.length
        ? `By version:\n${r.versions.map((v) => `- ${v.version}: ${money(v.revenue)} (${v.share_pct}%), ${n(v.transactions)} transactions; ${v.players != null ? `${n(v.players)} players, ${money(v.per_player)} per player, crash-free ${v.crash_free_pct ?? '–'}%, frame p95 ${v.frame_p95 ?? '–'}ms` : 'no sessions of it in the window'}${v.purchases != null ? `; purchase events ${money(v.purchases)}` : ''}`).join('\n')}`
        : `By version: ${r.versions_why ?? 'none in this window'}`,
      r.countries?.length
        ? `By country${r.countries_as_of && r.countries_as_of < r.to_day ? ` (to ${r.countries_as_of})` : ''}: ${r.countries.slice(0, 10).map((c) => `${c.name} ${n(c.installs)} installs, ${money(c.revenue)} from ${n(c.purchases)} purchases`).join('; ')}${r.countries.length > 10 ? `; ${r.countries.length - 10} more in the data` : ''}.`
        : `By country: ${r.countries_why ?? 'none in this window'}`,
      r.stores?.length
        ? `By store: ${r.stores.map((x) => `${x.name} ${money(x.revenue)} (${x.share_pct}%), ${n(x.purchases)} purchases${x.platform ? `; ${x.sessions != null ? `${n(x.sessions)} ${x.platform} sessions` : `${x.platform} sessions not counted over 31 days`}${x.per_player != null ? `, ${money(x.per_player)} per ${r.players_are_sessions ? 'session' : 'player'}` : ''}` : ''}`).join('; ')}.`
        : `By store: ${r.stores_why ?? 'none in this window'}`,
      ...(r.notes?.length ? [`Notes:\n${r.notes.map((x) => `- ${x}`).join('\n')}`] : []),
    ];
    return reply(lines.join('\n'), { days: r.days, versions: r.versions, countries: r.countries, stores: r.stores, overview: r.overview?.metrics ?? null });
  },
);
