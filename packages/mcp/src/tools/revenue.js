// A game's real revenue from RevenueCat or Stripe (Glitchless Cloud: Settings → Integrations), by day, and by app
// version, country and store where the source splits it (RevenueCat) or by version where the game tied its purchases
// to sessions and by country (Stripe), next to the sessions and players Glitchless measured and what the game's own
// purchase events add up to. A game connected to both gets both, one after the other, unless `source` picks one.
import { z } from 'zod';
import { query, resolveService, range, reply, common, filters, tool } from '../context.js';

tool(
  'glitchless_revenue',
  "The game's real revenue as RevenueCat or Stripe counts it, for a game connected to either in Glitchless Cloud (Settings → Integrations); a game with both gets both unless source picks one. RevenueCat counts production purchases only (never sandbox, TestFlight or licence-tester ones): revenue and transactions by UTC day, MRR, active subscriptions and trials, installs (its new customers: the first time its SDK starts on a device) next to the new players Glitchless saw, active users a day next to Glitchless's players a day, and, where RevenueCat splits them, revenue by the app version purchases were made on, installs, revenue and purchases by country, and revenue by store (App Store, Google Play) next to the sessions Glitchless measured on iOS and Android. Stripe is the game's own account (a web or PC game's unlock, DLC, supporter packs; a test-mode key says so): revenue by UTC day with refunds, disputes, Stripe's fees and net, new paying customers, revenue by product and by country, and revenue by version and platform for the purchases the game tied to a Glitchless session or player (client_reference_id, or glitchless_session / glitchless_player metadata), with how many players paid. Both give revenue per player Glitchless measured, each day next to its sessions and players, each version next to its players, crash-free sessions and frame-time p95, and what the game's own purchase events (track('purchase', { amount, currency })) add up to: the gap is purchases that never reach Glitchless. Use it for money questions, e.g. whether 1.4.2 earns more per player than 1.4.1, or which DLC gets refunded. Use glitchless_events for purchases by item, level or player.",
  {
    service: common.service,
    source: z.enum(['revenuecat', 'stripe']).optional().describe('Only this revenue source (default: every one the game is connected to)'),
    hours: z.number().min(24).max(9600).optional().describe('Look-back window in hours (default 720, 30 days), read as whole UTC days'),
    version: z.string().optional().describe("Only this version: its revenue (where RevenueCat splits revenue by version, or Stripe's purchases joined to that version's sessions) over its players. MRR, subscriptions and trials, and Stripe's refunds and fees, stay the whole game's"),
    env: common.env,
    session_type: common.session_type,
  },
  async ({ service, source, hours, version, env, session_type }) => {
    const svc = await resolveService(service);
    const ask = (store) => query('store_revenue', { service: svc, ...(store ? { store } : {}), ...filters({ version, env, session_type }), ...range(hours || 720) });
    const first = await ask(source);
    if (first.connected === false) return reply(`${svc}: ${first.why}`, {});
    const rest = source ? [] : await Promise.all((first.sources ?? []).filter((s) => s !== first.store).map((s) => ask(s)));
    const all = [first, ...rest].filter((r) => r.connected !== false);
    const parts = all.map((r) => describe(svc, r));
    return reply(parts.map((p) => p.text).join('\n\n'), all.length === 1 ? parts[0].data : Object.fromEntries(all.map((r, i) => [r.store, parts[i].data])));
  },
);

function describe(svc, r) {
  if (r.empty) return { text: `${r.store_name} revenue of ${svc}: ${r.why}`, data: { overview: r.overview?.metrics ?? null } };
  const money = (v) => (v == null ? '–' : r.currency ? new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency }).format(v) : String(v));
  const n = (v) => (v == null ? '–' : v.toLocaleString('en-US'));
  const t = r.totals;
  const g = r.glitchless;
  const perPlayer = r.per_player != null ? `Revenue per player: ${money(r.per_player)} over ${n(r.players)} ${r.players_are_sessions ? 'sessions (no player IDs)' : 'players'} Glitchless measured (${n(r.sessions)} sessions).` : `Glitchless measured no players in this window.`;
  const own = g ? `The game's own purchase events: ${g.comparable ? money(g.purchases) : `${g.purchases} ${g.currency ?? ''}`.trim()} from ${n(g.events)} events${g.coverage_pct != null ? ` (${g.coverage_pct}% of ${r.store_name}'s)` : ''}${g.sandbox ? `; ${n(g.sandbox)} sandbox purchases left out` : ''}.` : 'The game sends no purchase events with an amount.';
  const versionLine = (v) => `- ${v.version}: ${money(v.revenue)} (${v.share_pct}%), ${n(v.transactions)} ${r.store === 'stripe' ? 'payments' : 'transactions'}; ${v.players != null ? `${n(v.players)} players, ${money(v.per_player)} per player, crash-free ${v.crash_free_pct ?? '–'}%, frame p95 ${v.frame_p95 ?? '–'}ms` : 'no sessions of it in the window'}${v.purchases != null ? `; purchase events ${money(v.purchases)}` : ''}`;
  const versions = r.versions?.length ? `By version:\n${r.versions.map(versionLine).join('\n')}` : `By version: ${r.versions_why ?? 'none in this window'}`;
  const notes = r.notes?.length ? [`Notes:\n${r.notes.map((x) => `- ${x}`).join('\n')}`] : [];
  const countries = r.countries?.length
    ? `By country${r.countries_as_of && r.countries_as_of < r.to_day ? ` (to ${r.countries_as_of})` : ''}: ${r.countries.slice(0, 10).map((c) => `${c.name} ${c.installs != null ? `${n(c.installs)} installs, ` : ''}${money(c.revenue)} from ${n(c.purchases)} ${r.store === 'stripe' ? 'payments' : 'purchases'}`).join('; ')}${r.countries.length > 10 ? `; ${r.countries.length - 10} more in the data` : ''}.`
    : `By country: ${r.countries_why ?? 'none in this window'}`;
  if (r.store === 'stripe') {
    const lines = [
      `${r.store_name} revenue of ${svc}${r.products_picked ? ` (products: ${r.products_picked})` : ''}, ${r.from_day} to ${r.to_day} (UTC days)${r.version ? `, version ${r.version}` : ''}: ${money(t.revenue)} from ${n(t.transactions)} payments${t.incomplete ? ' (today so far included)' : ''}; refunds ${money(t.refunds)} (${n(t.refund_count)}), disputes ${money(t.disputes)}, Stripe's fees ${money(t.fees)}, net ${money(t.net)}.`,
      perPlayer,
      `New paying customers: ${n(t.new_customers)}${r.new_players != null ? `; Glitchless saw ${n(r.new_players)} new players` : ''}${r.payers != null ? `. Players who paid, among those measured: ${n(r.payers)}${r.payers_pct != null ? ` (${r.payers_pct}%)` : ''}` : ''}.`,
      own,
      r.products?.length ? `By product:\n${r.products.map((p) => `- ${p.name}${p.product !== '(none)' ? ` (${p.product})` : ''}: ${money(p.revenue)} (${p.share_pct}%), ${n(p.transactions)} payments${p.refunds ? `; refunded ${money(p.refunds)} (${n(p.refund_count)})` : ''}`).join('\n')}` : `By product: ${r.products_why ?? 'none in this window'}`,
      versions,
      ...(r.platforms?.length ? [`By platform (tied purchases): ${r.platforms.map((p) => `${p.platform} ${money(p.revenue)} (${n(p.purchases)})`).join(', ')}`] : []),
      countries,
      ...notes,
    ];
    return { text: lines.join('\n'), data: { days: r.days, products: r.products, versions: r.versions, platforms: r.platforms ?? null, countries: r.countries ?? null, overview: r.overview?.metrics ?? null } };
  }
  const stock = (x, label, isMoney = false) => (x ? `${isMoney ? money(x.value) : n(x.value)} ${label}${x.change != null ? ` (${x.change >= 0 ? '+' : '−'}${isMoney ? money(Math.abs(x.change)) : n(Math.abs(x.change))} since ${x.since})` : ''}` : null);
  const lines = [
    `${r.store_name} revenue of ${svc} (project ${r.app_id}), ${r.from_day} to ${r.to_day} (UTC days)${r.version ? `, version ${r.version}` : ''}: ${money(t.revenue)}${t.transactions != null ? ` from ${n(t.transactions)} transactions` : ''}${t.incomplete ? ' (today so far included)' : ''}.`,
    perPlayer,
    `Installs (${r.store_name}'s new customers): ${n(t.installs)}${r.new_players != null ? `; Glitchless saw ${n(r.new_players)} new players (${r.new_players_pct ?? '–'}%)` : '; Glitchless counts new players only with player IDs'}. Active users: ${t.active_users_per_day != null ? `${n(t.active_users_per_day)} a day` : '–'}${r.players_per_day != null ? `; Glitchless measured ${n(r.players_per_day)} players a day` : ''}.`,
    `Now: ${[stock(r.latest.mrr, 'MRR', true), stock(r.latest.actives, 'active subscriptions'), stock(r.latest.trials, 'active trials')].filter(Boolean).join(', ') || 'no MRR, subscriptions or trials yet'}.`,
    own,
    versions,
    countries,
    r.stores?.length
      ? `By store: ${r.stores.map((x) => `${x.name} ${money(x.revenue)} (${x.share_pct}%), ${n(x.purchases)} purchases${x.platform ? `; ${x.sessions != null ? `${n(x.sessions)} ${x.platform} sessions` : `${x.platform} sessions not counted over 31 days`}${x.per_player != null ? `, ${money(x.per_player)} per ${r.players_are_sessions ? 'session' : 'player'}` : ''}` : ''}`).join('; ')}.`
      : `By store: ${r.stores_why ?? 'none in this window'}`,
    ...notes,
  ];
  return { text: lines.join('\n'), data: { days: r.days, versions: r.versions, countries: r.countries, stores: r.stores, overview: r.overview?.metrics ?? null } };
}
