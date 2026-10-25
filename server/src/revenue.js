// Revenue: what players really paid, from the revenue source a game is connected to (RevenueCat, through Glitchless
// Cloud's RevenueCat adapter), next to what Glitchless measured of the same game: its players and
// sessions, what its own purchase events add up to (track('purchase', { amount, currency }), sums.js), its new players
// next to the source's new customers (RevenueCat's nearest thing to installs: first seen by its SDK) and its players a
// day next to the source's active customers, and, where the source splits revenue by app version, each version's
// revenue next to its players, crash-free sessions and frame times; where it splits them by country, installs and
// revenue on a world map; and where it splits revenue by store (the App Store, Google Play), each store's revenue
// next to the sessions Glitchless measured on that store's platform (iOS, Android). A source's charts count production purchases only (RevenueCat leaves sandbox, TestFlight and licence-tester
// purchases out), so its revenue is the number to trust for money; Glitchless's own purchase events are the ones to
// read by level, item or player, and the gap between the two is the purchases that never reach Glitchless (builds
// without the SDK, purchases the game doesn't track). Store-neutral like reviews.js, which stores and reads a
// source's data with the stores' and dispatches its panels here. SPEC §3h.
//
// A payments source (Stripe: what a game sells through its own account, SPEC §3i) brings money as its account
// settled it: per day its refunds, disputes, fees and net next to the revenue, new paying customers instead of
// installs, revenue by product and by country, and the purchases the game tied to a Glitchless session or player,
// which are joined here to that session's version and platform (so its revenue splits by version without the source
// knowing versions).
//
// What a source's sync brings (createStoreData().write in reviews.js):
//   revenue: [{ day, revenue, transactions, mrr, actives, trials, new_customers, active_customers, currency,
//            incomplete }]   per UTC day: revenue, transactions, new customers and active customers in the day; MRR,
//            active subscriptions and trials as the source's snapshot of the day; `incomplete`: a day still filling in.
//            A payments source's days also have refunds, refund_count, disputes, fees, net and other_payments (payments
//            settled in another currency, left out), and new_customers are its new paying customers
//   revenue_versions: [{ day, version, revenue, transactions, currency }]   by the app version purchases were made on
//   revenue_countries: [{ day, country, name, revenue, transactions, currency }]   by the customer's country: `country`
//            an ISO 3166-1 alpha-2 code, else the source's name for it ("(other)": the countries past its top 50;
//            a payments source's "(none)": no country known)
//   installs_countries: [{ day, country, name, installs }]   new customers by country, the same way
//   revenue_stores: [{ day, store, name, revenue, transactions, currency }]   by the store a purchase was made in
//            (`store`: app_store, play_store, mac_app_store, amazon, stripe…; `name`: the source's)
//   revenue_products: [{ day, product, name, revenue, transactions, refunds, refund_count, currency }]   a payments
//            source's revenue and refunds by product ("(none)": payments with no product the source could name)
//   revenue_purchases: [{ day, ts, amount, currency, product, ref?, session?, player? }]   a payments source's
//            purchases tied to a Glitchless session or player (`ref`: either, as the game put it)
//   snapshots: { overview: { at, currency, metrics: [{ id, name, value, unit, period }] },
//                charts: { day, version_segment, country_segment, installs_country_segment, store_segment, segments,
//                          currency, countries_day, stores_day } }   the source's numbers now, what its charts can be
//                                                                     split by, and the last day the splits were read
//
//   STORE#<projectId>#<source>  REV#<YYYY-MM>    { days: { <day>: { revenue, transactions, mrr, actives, trials,
//                                                  new_customers, active_customers, currency, incomplete } } }   a day
//                                                  sent again replaces what it has
//   STORE#<projectId>#<source>  REVV#<YYYY-MM>   { rows: { <day>|<version>: { revenue, transactions, currency } } }
//                                                  a day sent again replaces all of that day's versions
//   STORE#<projectId>#<source>  REVC#<YYYY-MM>   { revenue: { <day>|<country>: { revenue, transactions, name, currency } },
//                                                  installs: { <day>|<country>: { installs, name } } }
//   STORE#<projectId>#<source>  REVS#<YYYY-MM>   { revenue: { <day>|<store>: { revenue, transactions, name, currency } } }
//                                                  a day sent again replaces that day's countries (or stores) of what
//                                                  it brings
//   STORE#<projectId>#<source>  REVP#<YYYY-MM>   { revenue: { <day>|<product>: { name, revenue, transactions, refunds,
//                                                  refund_count, currency } } }
//   STORE#<projectId>#<source>  RPAY#<YYYY-MM-DD>  { rows: [purchase] }   the day's purchases tied to a session or player
//                                                  (a day sent again replaces each of these)
import { overview, versions, eventIndex, playersAreSessions, retention, sessionsBy, platformOf, pct, round } from './analytics.js';
import { sumsBy, gameCurrency } from './sums.js';

// `lacks`: the measures a source doesn't count. `payments`: a payments source (above).
export const REVENUE_SOURCES = {
  revenuecat: { name: 'RevenueCat', lacks: ['refunds', 'customers', 'by_product'] },
  stripe: { name: 'Stripe', payments: true, lacks: ['installs', 'active_users', 'mrr', 'actives', 'trials', 'players_by_day', 'by_store'] },
};
const sourceName = (s) => REVENUE_SOURCES[s]?.name ?? s;
// A source as its panels name it: a Stripe connection with a test-mode key says so everywhere.
const nameOf = (st) => `${sourceName(st.store)}${st.mode === 'test' ? ' (test mode)' : ''}`;
// What a store_revenue panel shows (its `measure`), with its default title and size.
export const MEASURES = {
  revenue: { title: 'Revenue', size: 's' },
  per_player: { title: 'Revenue per player', size: 's' },
  installs: { title: 'Installs', size: 's' },
  active_users: { title: 'Active users a day', size: 's' },
  mrr: { title: 'MRR', size: 's' },
  actives: { title: 'Active subscriptions', size: 's' },
  trials: { title: 'Active trials', size: 's' },
  by_day: { title: 'Revenue per day', size: 'm' },
  players_by_day: { title: 'Installs and active users per day', size: 'm' },
  by_version: { title: 'Revenue by version', size: 'l' },
  by_country: { title: 'Installs and revenue by country', size: 'l', paymentsTitle: 'Revenue by country' },
  by_store: { title: 'Revenue by store', size: 'm' },
  refunds: { title: 'Refunds', size: 's' },
  customers: { title: 'New paying customers', size: 's' },
  by_product: { title: 'Revenue by product', size: 'm' },
};
// What a sync brings that writeRevenue keeps.
export const REVENUE_BATCHES = ['revenue', 'revenue_versions', 'revenue_countries', 'installs_countries', 'revenue_stores', 'revenue_products', 'revenue_purchases'];
// What a by_country panel's map shows first (the panel switches between them).
export const COUNTRY_VIEWS = ['installs', 'revenue'];
// The platform Glitchless names a store's sessions by (analytics.js platformOf).
const STORE_PLATFORM = { app_store: 'iOS', play_store: 'Android', mac_app_store: 'macOS' };
// The source's splits: by country (revenue and installs) and by store (revenue), kept by month.
const SPLITS = [
  { batch: 'revenue_countries', prefix: 'REVC', field: 'revenue', by: 'country', pick: (r) => ({ revenue: round(r.revenue ?? 0, 4), transactions: Number.isFinite(r.transactions) ? r.transactions : null, name: String(r.name ?? '').slice(0, 80) || null, currency: currencyOf(r.currency) }) },
  { batch: 'installs_countries', prefix: 'REVC', field: 'installs', by: 'country', pick: (r) => ({ installs: Number.isFinite(r.installs) ? r.installs : 0, name: String(r.name ?? '').slice(0, 80) || null }) },
  { batch: 'revenue_stores', prefix: 'REVS', field: 'revenue', by: 'store', pick: (r) => ({ revenue: round(r.revenue ?? 0, 4), transactions: Number.isFinite(r.transactions) ? r.transactions : null, name: String(r.name ?? '').slice(0, 80) || null, currency: currencyOf(r.currency) }) },
];
// The overview metric with a measure's number (by its ID or name), for before the charts have a day of it: MRR,
// subscriptions and trials now; new and active customers over the last 28 days.
const OVERVIEW = { mrr: /^mrr$/i, actives: /^active[_ ]subscriptions$/i, trials: /^active[_ ]trials$/i, installs: /^new[_ ]customers$/i, active_users: /^active[_ ](users|customers)$/i };
const overviewMetric = (o, measure) => o?.metrics?.find((m) => OVERVIEW[measure].test(m.id) || OVERVIEW[measure].test(m.name ?? '')) ?? null;
const MONEY = new Set(['revenue', 'per_player', 'mrr', 'refunds']);
// The purchase convention every SDK documents (sums.js): its event and the attribute summed.
const PURCHASE = { name: 'purchase', key: null, value: null };
const AMOUNT = 'amount';
const KEPT = ['revenue', 'transactions', 'mrr', 'actives', 'trials', 'new_customers', 'active_customers', 'refunds', 'refund_count', 'disputes', 'fees', 'net', 'other_payments'];
// A payments source's split by product, kept by month like the versions (its countries are the splits' above).
const PAYMENT_SPLITS = [
  { batch: 'revenue_products', prefix: 'REVP', by: 'product', pick: (r) => ({ name: String(r.name ?? '').slice(0, 80) || null, revenue: round(r.revenue ?? 0, 4), transactions: r.transactions ?? 0, refunds: round(r.refunds ?? 0, 4), refund_count: r.refund_count ?? 0, currency: currencyOf(r.currency) }) },
];
const PURCHASES_PER_DAY = 2000;
// How long after a session ends a purchase by its player still joins it (the store page opened from the game).
const AFTER_SESSION = 30 * 60_000;
const DAY = 86_400_000;

const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const dayTs = (day) => Date.parse(`${day}T00:00:00Z`);

// ───────────────────────────── stored data ─────────────────────────────

// A sync's revenue days and versions into their month items. `expires(month)` is the item's expiresAt.
export async function writeRevenue(kv, key, batch, expires) {
  const byMonth = (rows) => {
    const out = new Map();
    for (const r of rows ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.day ?? '')) continue;
      const month = r.day.slice(0, 7);
      if (!out.has(month)) out.set(month, []);
      out.get(month).push(r);
    }
    return out;
  };
  for (const [month, list] of byMonth(batch.revenue)) {
    const item = (await kv.get(key, `REV#${month}`)) ?? { days: {} };
    for (const r of list) {
      const day = { ...item.days[r.day] };
      for (const k of KEPT) if (Number.isFinite(r[k])) day[k] = round(r[k], 4);
      Object.assign(day, { currency: currencyOf(r.currency) ?? day.currency ?? null, incomplete: r.incomplete === true });
      item.days[r.day] = day;
    }
    await kv.put({ pk: key, sk: `REV#${month}`, days: item.days, expiresAt: expires(month) });
  }
  for (const [month, list] of byMonth(batch.revenue_versions)) {
    const item = (await kv.get(key, `REVV#${month}`)) ?? { rows: {} };
    const sent = new Set(list.map((r) => r.day));
    const rows = Object.fromEntries(Object.entries(item.rows).filter(([k]) => !sent.has(k.slice(0, 10))));
    for (const r of list) {
      if (!Number.isFinite(r.revenue)) continue;
      rows[`${r.day}|${String(r.version ?? '(none)').slice(0, 64)}`] = { revenue: round(r.revenue, 4), transactions: Number.isFinite(r.transactions) ? r.transactions : null, currency: currencyOf(r.currency) };
    }
    await kv.put({ pk: key, sk: `REVV#${month}`, rows, expiresAt: expires(month) });
  }
  // The splits: one item per prefix and month, each field's days replaced by the days sent.
  const items = new Map();
  for (const x of SPLITS) {
    for (const [month, list] of byMonth(batch[x.batch])) {
      const sk = `${x.prefix}#${month}`;
      if (!items.has(sk)) items.set(sk, { month, item: (await kv.get(key, sk)) ?? {} });
      const { item } = items.get(sk);
      const sent = new Set(list.map((r) => r.day));
      const rows = Object.fromEntries(Object.entries(item[x.field] ?? {}).filter(([k]) => !sent.has(k.slice(0, 10))));
      for (const r of list) rows[`${r.day}|${String(r[x.by] ?? '(none)').slice(0, 80)}`] = x.pick(r);
      item[x.field] = rows;
    }
  }
  for (const [sk, { month, item }] of items) {
    const { pk: _, sk: __, expiresAt, ...fields } = item;
    await kv.put({ pk: key, sk, ...fields, expiresAt: expires(month) });
  }
  // A payments source's products: each month item's days sent replace what that day had.
  for (const x of PAYMENT_SPLITS) {
    for (const [month, list] of byMonth(batch[x.batch])) {
      const { pk: _, sk, expiresAt, ...item } = (await kv.get(key, `${x.prefix}#${month}`)) ?? {};
      const sent = new Set(list.map((r) => r.day));
      const rows = Object.fromEntries(Object.entries(item.revenue ?? {}).filter(([k]) => !sent.has(k.slice(0, 10))));
      for (const r of list) rows[`${r.day}|${String(r[x.by] ?? '(none)').slice(0, 80)}`] = x.pick(r);
      await kv.put({ pk: key, sk: `${x.prefix}#${month}`, ...item, revenue: rows, expiresAt: expires(month) });
    }
  }
  // The purchases tied to a session or player, a day per item; every day the sync read is sent, so a day with none
  // left (another pick of products) is emptied.
  const days = new Map((batch.revenue ?? []).filter((r) => batch.revenue_purchases && /^\d{4}-\d{2}-\d{2}$/.test(r.day)).map((r) => [r.day, []]));
  for (const p of batch.revenue_purchases ?? []) if (/^\d{4}-\d{2}-\d{2}$/.test(p?.day ?? '') && Number.isFinite(p.amount)) (days.get(p.day) ?? days.set(p.day, []).get(p.day)).push(p);
  for (const [day, list] of days) {
    const rows = list.slice(0, PURCHASES_PER_DAY).map((p) => ({ ts: p.ts, amount: round(p.amount, 4), currency: currencyOf(p.currency), product: p.product ? String(p.product).slice(0, 80) : null, ...Object.fromEntries(['ref', 'session', 'player'].filter((k) => p[k]).map((k) => [k, String(p[k]).slice(0, 128)])) }));
    if (rows.length || (await kv.get(key, `RPAY#${day}`))) await kv.put({ pk: key, sk: `RPAY#${day}`, rows, expiresAt: expires(day.slice(0, 7)) });
  }
}

// A source's revenue days, versions, countries and stores for `months`, oldest first; a payments source's products
// and tied purchases too.
export async function readRevenue(kv, key, months, source = null) {
  const items = await Promise.all(months.flatMap((m) => ['REV', 'REVV', 'REVC', 'REVS'].map((p) => kv.get(key, `${p}#${m}`))));
  const revenue = [];
  const byVersion = [];
  const splits = Object.fromEntries(SPLITS.map((x) => [x.batch, []]));
  months.forEach((_, i) => {
    const [rev, revv, ...rest] = items.slice(i * 4, i * 4 + 4);
    for (const [day, v] of Object.entries(rev?.days ?? {})) revenue.push({ day, ...v });
    for (const [k, v] of Object.entries(revv?.rows ?? {})) byVersion.push({ day: k.slice(0, 10), version: k.slice(11), ...v });
    const item = { REVC: rest[0], REVS: rest[1] };
    for (const x of SPLITS) for (const [k, v] of Object.entries(item[x.prefix]?.[x.field] ?? {})) splits[x.batch].push({ day: k.slice(0, 10), [x.by]: k.slice(11), ...v });
  });
  const order = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  const out = { revenue: revenue.sort(order), revenue_versions: byVersion.sort(order), ...Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, v.sort(order)])) };
  if (!REVENUE_SOURCES[source]?.payments) return out;
  for (const x of PAYMENT_SPLITS) {
    const split = await Promise.all(months.map((m) => kv.get(key, `${x.prefix}#${m}`)));
    out[x.batch] = split.flatMap((item) => Object.entries(item?.revenue ?? {}).map(([k, v]) => ({ day: k.slice(0, 10), [x.by]: k.slice(11), ...v }))).sort(order);
  }
  const bought = await Promise.all(months.map((m) => kv.query(key, `RPAY#${m}`)));
  out.revenue_purchases = bought.flat().flatMap((item) => (item.rows ?? []).map((p) => ({ day: item.sk.slice(5), ...p }))).sort((a, b) => a.ts - b.ts);
  return out;
}

function currencyOf(v) {
  const c = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

// ───────────────────────────── the window ─────────────────────────────

// The revenue source a panel or query names, else the game's first connected one.
function pickSource(ctx, source) {
  const all = ctx.stores ?? {};
  if (source) return REVENUE_SOURCES[source] ? (all[source] ?? null) : null;
  return Object.values(all).find((x) => REVENUE_SOURCES[x.store]) ?? null;
}

function notConnected(ctx, source) {
  return source && ctx.stores ? `This game has no ${sourceName(source)} connection (Glitchless Cloud: Settings → Integrations → ${sourceName(source)}).` : 'This game has no revenue connected (Glitchless Cloud: Settings → Integrations → RevenueCat or Stripe).';
}

// A payments source's purchases in the window that the game tied to a Glitchless session or player, joined to it: the
// session named (or `ref` as a session), else the session the player (or `ref` as a player) was in when they paid, or
// that ended within 30 minutes before, from the window's sessions (with a version filter, that version's: a purchase
// made in another version's session joins none). → { rows: [{ day, version, revenue, transactions }], platforms,
// joined, unjoined: { revenue, transactions }, payers } or { daily: true } over more than 31 days (no sessions to join).
function joinedOf(ctx, st, lo, hi) {
  const purchases = (st.revenue_purchases ?? []).filter((p) => p.day >= lo && p.day <= hi);
  const all = (st.revenue ?? []).filter((r) => r.day >= lo && r.day <= hi);
  const total = { revenue: all.reduce((a, r) => a + (r.revenue ?? 0), 0), transactions: all.reduce((a, r) => a + (r.transactions ?? 0), 0) };
  if (ctx.daily) return { daily: true, tied: purchases.length, rows: [], platforms: [], joined: 0, unjoined: total, payers: null };
  const byPlayer = new Map();
  for (const s of ctx.sessions.values()) {
    if (!s.player_id) continue;
    if (!byPlayer.has(s.player_id)) byPlayer.set(s.player_id, []);
    byPlayer.get(s.player_id).push(s);
  }
  const startOf = (s) => s.start ?? s.first_ts ?? 0;
  const endOf = (s) => s.end ?? s.last_ts ?? startOf(s);
  for (const list of byPlayer.values()) list.sort((a, b) => startOf(a) - startOf(b));
  const rows = new Map();
  const platforms = new Map();
  const payers = new Set();
  let joined = 0;
  let revenue = 0;
  for (const p of purchases) {
    let s = ctx.sessions.get(p.session) ?? (p.ref ? ctx.sessions.get(p.ref) : null);
    if (!s) {
      s = byPlayer.get(p.player ?? p.ref)?.findLast((x) => startOf(x) <= p.ts && p.ts <= endOf(x) + AFTER_SESSION) ?? null;
    }
    if (!s) continue;
    joined++;
    revenue += p.amount;
    const version = s.version != null ? String(s.version) : '(none)';
    const k = `${p.day}|${version}`;
    const row = rows.get(k) ?? { day: p.day, version, revenue: 0, transactions: 0 };
    row.revenue += p.amount;
    row.transactions++;
    rows.set(k, row);
    const platform = platformOf(s.device);
    const pl = platforms.get(platform) ?? { platform, revenue: 0, purchases: 0 };
    pl.revenue += p.amount;
    pl.purchases++;
    platforms.set(platform, pl);
    if (s.player_id) payers.add(s.player_id);
  }
  return {
    tied: purchases.length,
    rows: [...rows.values()],
    platforms: [...platforms.values()].map((x) => ({ ...x, revenue: round(x.revenue, 2) })).sort((a, b) => b.revenue - a.revenue),
    joined,
    unjoined: { revenue: round(Math.max(0, total.revenue - revenue), 2), transactions: Math.max(0, total.transactions - joined) },
    payers: payers.size,
  };
}

// What the source says of the window, by UTC day (its first day to its last: a short window is the days it falls on),
// and what Glitchless measured of it: players, sessions, and the game's own purchase events in the same currency.
// `currency` is the dashboard's (the game's one currency, sums.js). A context filtered to one version (?version=, which
// filters the sessions) reads that version's revenue, where the source splits it by version, so revenue per player is
// that version's over its players; MRR, subscriptions and trials stay the whole game's (they are counts now, not a
// version's). `whole`: the game's days; `days`: the ones revenue is read from.
function windowOf(ctx, st, currency) {
  const cache = (ctx.revenueCache ??= new Map());
  if (cache.has(st.store)) return cache.get(st.store);
  const lo = isoDay(ctx.from);
  const hi = isoDay(ctx.to);
  const whole = (st.revenue ?? []).filter((r) => r.day >= lo && r.day <= hi);
  const version = ctx.q?.version ?? null;
  // Revenue by version: as the source splits it, or a payments source's purchases joined to their sessions.
  const payments = Boolean(REVENUE_SOURCES[st.store]?.payments);
  const joined = payments ? joinedOf(ctx, st, lo, hi) : null;
  const byVersion = payments ? joined.rows : (st.revenue_versions ?? []).filter((r) => r.day >= lo && r.day <= hi);
  const split = payments ? joined.joined > 0 : Boolean(st.snapshots?.charts?.version_segment || st.revenue_versions?.length);
  let days = whole;
  if (version) {
    const mine = new Map();
    for (const r of byVersion.filter((x) => x.version === version)) mine.set(r.day, { revenue: (mine.get(r.day)?.revenue ?? 0) + r.revenue, transactions: (mine.get(r.day)?.transactions ?? 0) + r.transactions });
    days = split ? whole.map((r) => ({ ...r, revenue: mine.get(r.day)?.revenue ?? 0, transactions: mine.get(r.day)?.transactions ?? 0 })) : [];
  }
  const cur = whole.findLast((r) => r.currency)?.currency ?? st.snapshots?.charts?.currency ?? st.currency ?? null;
  const has = (k) => days.some((r) => Number.isFinite(r[k]));
  const sum = (k) => (has(k) ? round(days.reduce((a, r) => a + (r[k] ?? 0), 0), 2) : null);
  const k = (ctx.overviewCache ??= overview(ctx)).kpis;
  const own = ownPurchases(ctx, currency);
  // Glitchless's purchases are compared only in the source's currency (one currency per game: never converted).
  const comparable = own && cur && own.currency === cur;
  const w = {
    lo,
    hi,
    whole,
    days,
    version,
    unsplit: Boolean(version && !split),
    currency: cur,
    revenue: sum('revenue'),
    transactions: sum('transactions'),
    incomplete: days.some((r) => r.incomplete),
    players: k.players ?? 0,
    sessions: k.sessions ?? 0,
    players_are_sessions: playersAreSessions(ctx),
    own,
    comparable: Boolean(comparable),
    byVersion,
    joined,
  };
  // A payments source's money after the sale (the whole game's, whatever the version filter) and its new paying customers.
  if (payments) {
    const whole2 = (k) => (whole.some((r) => Number.isFinite(r[k])) ? round(whole.reduce((a, r) => a + (r[k] ?? 0), 0), 2) : null);
    Object.assign(w, { refunds: whole2('refunds'), refund_count: whole2('refund_count'), disputes: whole2('disputes'), fees: whole2('fees'), net: whole2('net'), new_customers: whole2('new_customers'), other_payments: whole2('other_payments') });
  }
  w.coverage_pct = comparable && w.revenue ? pct(own.sum, w.revenue) : null;
  w.notes = notes(ctx, st, w, currency);
  w.customers = customersOf(ctx, whole, st);
  cache.set(st.store, w);
  return w;
}

// The source's new and active customers over the window's days (the whole game's, whatever the version filter), next
// to Glitchless's new players (first seen that UTC day, from the store's first-seen index: they need player IDs) and
// players a day. Averages a day leave out a day still filling in.
function customersOf(ctx, whole, st) {
  const m = measuredDays(ctx);
  const has = (k) => whole.some((r) => Number.isFinite(r[k]));
  const complete = whole.filter((r) => !r.incomplete);
  const full = complete.length ? complete : whole;
  const active = full.filter((r) => Number.isFinite(r.active_customers));
  const measured = active.filter((r) => m.players.has(r.day));
  const installs = has('new_customers') ? whole.reduce((a, r) => a + (r.new_customers ?? 0), 0) : null;
  const fresh = m.fresh ? whole.reduce((a, r) => a + (m.fresh.get(r.day) ?? 0), 0) : null;
  return {
    installs,
    new_players: fresh,
    new_players_pct: installs && fresh != null ? pct(fresh, installs) : null,
    active_per_day: active.length ? Math.round(active.reduce((a, r) => a + r.active_customers, 0) / active.length) : null,
    active_days: active.length,
    players_per_day: measured.length ? Math.round(measured.reduce((a, r) => a + m.players.get(r.day), 0) / measured.length) : null,
    anonymous: m.anonymous,
    notes: [
      REVENUE_SOURCES[st.store]?.payments
        ? `${sourceName(st.store)} counts a new paying customer on the day of their first payment for this game that Glitchless has read (by their ${sourceName(st.store)} customer, else their email, kept only as a hash); Glitchless counts a new player the first time it sees their player ID.`
        : 'RevenueCat counts a new customer the first time its SDK starts on a device (a reinstall without signing in is a new one, and testers count: customers have no sandbox side); Glitchless counts a new player the first time it sees their player ID.',
      ...(m.anonymous ? ["The game sends no player IDs, so Glitchless can't tell new players from returning ones (install mode turns them on)."] : []),
    ],
  };
}

// What Glitchless measured by UTC day: players who played that day (sessions in anonymous mode; over 31 days, the day
// groups' counts), and new players by the day first seen (analytics.js retention cohorts), or null without player IDs.
function measuredDays(ctx) {
  if (ctx.measuredDays) return ctx.measuredDays;
  const players = new Map();
  if (ctx.daily) {
    const o = (ctx.overviewCache ??= overview(ctx));
    if (ctx.bucketMs === DAY) o.series.ts.forEach((t, i) => players.set(isoDay(t), o.series.players[i]));
  } else {
    const per = new Map();
    for (const s of ctx.sessions.values()) {
      for (const minute of s.minutes ?? []) {
        const d = isoDay(minute);
        if (!per.has(d)) per.set(d, new Set());
        per.get(d).add(s.player_id);
      }
    }
    for (const [d, ids] of per) players.set(d, ids.size);
  }
  const r = retention(ctx);
  return (ctx.measuredDays = { players, fresh: r.status === 'ok' ? new Map(r.cohorts.map((c) => [c.day, c.players])) : null, anonymous: r.status === 'anonymous' });
}

// The game's own purchase events in the window (sums.js: in the game's currency, sandbox purchases counted apart),
// with their sums by UTC day; null when it sends none with an amount.
function ownPurchases(ctx, currency) {
  const e = eventIndex(ctx).get(PURCHASE.name);
  if (!e?.attrs.has(AMOUNT)) return null;
  const s = sumsBy(ctx, PURCHASE, AMOUNT, { currency });
  const g = s.groups.get('') ?? { sum: 0, events: 0, series: [] };
  const byDay = new Map();
  if (ctx.bucketMs <= DAY) ctx.buckets.forEach((t, i) => g.series[i] && byDay.set(isoDay(t), round((byDay.get(isoDay(t)) ?? 0) + g.series[i], 2)));
  return { sum: round(g.sum, 2), events: g.events, currency: s.currency ?? gameCurrency(ctx, currency), mismatch: s.mismatch, sandbox: e.attrs.get('sandbox')?.values.get('true')?.count ?? 0, byDay };
}

// Lines that say how to read the window's numbers.
function notes(ctx, st, w, currency) {
  const name = sourceName(st.store);
  const out = [];
  if (st.mode === 'test') out.push(`This ${name} connection uses a test-mode key: these are test payments, not real revenue. Connect a live restricted key (rk_live_…) for the game's sales.`);
  const game = currency ?? w.own?.currency ?? null;
  if (w.currency && game && game !== w.currency) out.push(`${name} reports in ${w.currency} and this game's money is in ${game}: ${name}'s amounts are shown in ${w.currency}, never converted or added to the game's own. Set the connection's currency to ${game} (Settings → Integrations → ${name}) to compare them.`);
  if (w.comparable && w.revenue > 0) {
    if (w.coverage_pct < 80) out.push(`The game's own purchase events add up to ${w.coverage_pct}% of what ${name} counts: the rest are purchases that never reached Glitchless (builds without the SDK, purchases the game doesn't track, players with telemetry off).`);
    else if (w.coverage_pct > 110) out.push(`The game's own purchase events add up to ${w.coverage_pct}% of what ${name} counts: amounts sent with a different price than the store charged, refunds ${name} took off, or purchases it hasn't processed yet.`);
  }
  if (w.own?.sandbox) out.push(`${w.own.sandbox} sandbox ${w.own.sandbox === 1 ? 'purchase' : 'purchases'} (TestFlight and other test installs) are counted by Glitchless and left out of every sum; ${name} never counts them.`);
  if (w.players_are_sessions) out.push('The game sends no player IDs, so revenue per player is per session.');
  if (w.other_payments > 0) out.push(`${w.other_payments} ${w.other_payments === 1 ? 'payment' : 'payments'} in this window settled in another currency than ${w.currency}: left out of these sums (one currency per game, never converted).`);
  if (w.version && REVENUE_SOURCES[st.store]?.payments) out.push(`Refunds, disputes, fees, net and new paying customers are the whole game's; revenue is the purchases joined to ${w.version}'s sessions.`);
  return out;
}

// ───────────────────────────── board panels ─────────────────────────────

export const REVENUE_PANEL = {
  title: (p) => (REVENUE_SOURCES[p.store]?.payments && MEASURES[p.measure]?.paymentsTitle) || (MEASURES[p.measure]?.title ?? 'Revenue'),
  size: (p) => MEASURES[p.measure]?.size ?? 'm',
  shared: 'sums',
};

// A store_revenue panel's own fields: `measure` (one of MEASURES) and `store` (a revenue source; default the game's
// first connected one). → fields or throws.
export function revenuePanelFields(p, at, BoardError) {
  if (!MEASURES[p.measure]) throw new BoardError(`${at} (store_revenue) needs measure: one of ${Object.keys(MEASURES).join(', ')}`);
  if (p.store != null && !REVENUE_SOURCES[p.store]) throw new BoardError(`${at}.store must be one of ${Object.keys(REVENUE_SOURCES).join(', ')}`);
  if (p.store != null && REVENUE_SOURCES[p.store].lacks?.includes(p.measure)) throw new BoardError(`${at}: ${sourceName(p.store)} doesn't count ${p.measure}; its measures are ${measuresOf(p.store).join(', ')}`);
  if (p.show != null && (p.measure !== 'by_country' || !COUNTRY_VIEWS.includes(p.show))) throw new BoardError(`${at}.show goes with measure by_country: ${COUNTRY_VIEWS.join(' or ')} (what its map shows first)`);
  return { measure: p.measure, ...(p.store != null ? { store: p.store } : {}), ...(p.show != null ? { show: p.show } : {}) };
}

const measuresOf = (source) => Object.keys(MEASURES).filter((m) => !REVENUE_SOURCES[source]?.lacks?.includes(m));

// The Revenue page a game gets when it is connected to a revenue source: the source's revenue in the window, revenue
// per player (over the players Glitchless measured), installs (new customers) and active users a day, revenue per day
// next to the game's own purchase events, MRR, active subscriptions, installs and active users per day next to the new
// players and players Glitchless measured, active trials, the players measured, and revenue by app version. A payments
// source's: revenue (with its net), revenue per player, refunds, new paying customers, revenue and refunds per day,
// revenue by product, and revenue by version from the purchases joined to their sessions. `named`: the game has
// another revenue source, so the page says whose it is ("Stripe revenue").
export function revenuePage(source, { id = 'revenue', named = false } = {}) {
  const panel = (measure, size) => ({ type: 'store_revenue', store: source, measure, size });
  const title = named ? `${sourceName(source)} revenue` : 'Revenue';
  if (REVENUE_SOURCES[source]?.payments) {
    return { id, title, icon: 'money', panels: [panel('revenue', 's'), panel('per_player', 's'), panel('refunds', 's'), panel('customers', 's'), panel('by_day', 'm'), panel('by_product', 'm'), panel('by_version', 'l')] };
  }
  return {
    id,
    title,
    icon: 'money',
    panels: [
      panel('revenue', 's'),
      panel('per_player', 's'),
      panel('installs', 's'),
      panel('active_users', 's'),
      panel('by_day', 'm'),
      panel('mrr', 's'),
      panel('actives', 's'),
      panel('players_by_day', 'm'),
      panel('trials', 's'),
      { type: 'stat', metric: 'players', title: 'Players measured', size: 's' },
      panel('by_version', 'l'),
    ],
  };
}

export function revenuePanel(ctx, p, { currency = null } = {}) {
  const st = pickSource(ctx, p.store);
  if (!st) return { empty: true, why: notConnected(ctx, p.store) };
  const name = nameOf(st);
  const named = { store: st.store, store_name: name, measure: p.measure, ...(st.mode ? { mode: st.mode } : {}) };
  if (REVENUE_SOURCES[st.store].lacks?.includes(p.measure)) return { ...named, empty: true, why: `${sourceName(st.store)} doesn't count ${(MEASURES[p.measure]?.title ?? p.measure).toLowerCase()}: its panels are ${measuresOf(st.store).join(', ')}.` };
  const w = windowOf(ctx, st, currency);
  const notSynced = `${name} has not been synced yet: the first sync runs within the hour.`;
  if (!st.synced_at && !w.whole.length && !st.snapshots?.overview) return { ...named, empty: true, why: notSynced };
  const none = { ...named, empty: true, why: w.unsplit ? unsplit(name, w.version) : `No ${name} revenue in this window: ${name}'s days kept here start ${st.revenue?.[0]?.day ?? 'with its next sync'}.` };
  const money = MONEY.has(p.measure) ? { currency: w.currency } : {};
  switch (p.measure) {
    case 'revenue':
      if (w.revenue == null) return none;
      return { ...named, value: w.revenue, unit: null, ...money, transactions: w.transactions, days: w.days.length, from_day: w.days[0].day, to_day: w.days.at(-1).day, incomplete: w.incomplete, glitchless: w.comparable ? { sum: w.own.sum, events: w.own.events, coverage_pct: w.coverage_pct } : null, ...(w.net != null ? { net: w.net, fees: w.fees, refunds: w.refunds, disputes: w.disputes } : {}), notes: w.notes };
    case 'per_player':
      if (w.revenue == null) return none;
      if (!w.players) return { ...named, empty: true, why: 'Glitchless measured no players in this window.' };
      return { ...named, value: round(w.revenue / w.players, 2), unit: null, ...money, total: w.revenue, players: w.players, players_are_sessions: w.players_are_sessions };
    case 'mrr':
    case 'actives':
    case 'trials':
      return { ...named, ...latest(st, w, p.measure, none), ...money };
    case 'installs':
    case 'active_users':
      return { ...named, ...customersStat(st, w, p.measure, name) };
    case 'players_by_day':
      return w.whole.some((r) => Number.isFinite(r.new_customers) || Number.isFinite(r.active_customers)) ? { ...named, ...customersByDay(ctx, w, name) } : { ...named, empty: true, why: `No ${name} new or active customers in this window yet.` };
    case 'by_day':
      return w.days.length ? { ...named, ...byDay(w) } : none;
    case 'by_version':
      return { ...named, ...byVersion(ctx, st, w, currency) };
    case 'refunds':
      if (w.refunds == null) return none;
      return { ...named, value: round((w.refunds ?? 0) + (w.disputes ?? 0), 2), unit: null, ...money, refunds: w.refunds, refund_count: w.refund_count, disputes: w.disputes, share_pct: w.revenue ? pct((w.refunds ?? 0) + (w.disputes ?? 0), w.revenue) : null, days: w.whole.length, notes: w.notes };
    case 'customers':
      if (w.new_customers == null) return none;
      return { ...named, value: w.new_customers, unit: null, days: w.whole.length, glitchless: w.customers.new_players != null ? { new_players: w.customers.new_players } : null, anonymous: w.customers.anonymous, notes: w.customers.notes };
    case 'by_product':
      return { ...named, ...byProduct(st, w) };
    case 'by_country':
      // A payments source has no installs: its map shows revenue.
      return { ...named, ...byCountry(st, w, REVENUE_SOURCES[st.store].payments ? 'revenue' : (p.show ?? 'installs')) };
    case 'by_store':
      return { ...named, ...byStore(ctx, st, w) };
  }
  return named;
}

// A payments source's revenue and refunds in the window by product, most revenue first; the payments it could name no
// product for last.
function byProduct(st, w) {
  const name = nameOf(st);
  const rows = (st.revenue_products ?? []).filter((r) => r.day >= w.lo && r.day <= w.hi);
  if (!rows.length) return { empty: true, why: st.synced_at ? `No ${name} sales in this window.` : `${name} has not been synced yet: the first sync runs within the hour.` };
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.product) ?? { product: r.product, name: r.name || r.product, revenue: 0, transactions: 0, refunds: 0, refund_count: 0 };
    g.revenue += r.revenue ?? 0;
    g.transactions += r.transactions ?? 0;
    g.refunds += r.refunds ?? 0;
    g.refund_count += r.refund_count ?? 0;
    if (r.name) g.name = r.name;
    groups.set(r.product, g);
  }
  const total = [...groups.values()].reduce((a, g) => a + g.revenue, 0);
  const out = [...groups.values()]
    .map((g) => ({ ...g, revenue: round(g.revenue, 2), refunds: round(g.refunds, 2), share_pct: pct(g.revenue, total), refunded_pct: g.revenue ? pct(g.refunds, g.revenue) : null }))
    .sort((a, b) => (a.product === '(none)') - (b.product === '(none)') || b.revenue - a.revenue || (a.name < b.name ? -1 : 1));
  const none = out.find((r) => r.product === '(none)');
  return {
    rows: out,
    currency: w.currency,
    total: round(total, 2),
    notes: [
      ...(st.products ? [`Only this game's products count: ${st.products}. Payments made without Checkout (or a Payment Link) can't be tied to a product, so they're left out.`] : []),
      ...(none ? [`${none.transactions} ${none.transactions === 1 ? 'payment' : 'payments'} came without a product ${name} could name (a PaymentIntent of the game's own, or a subscription's renewal).`] : []),
      ...w.notes.filter((n) => /another currency|never converted/.test(n)),
    ],
  };
}

// Installs (new customers in the window) or active users a day (the average of its days), next to Glitchless's new
// players and players a day; before the charts have a day, the overview's 28 days.
function customersStat(st, w, measure, name) {
  const c = w.customers;
  const value = measure === 'installs' ? c.installs : c.active_per_day;
  if (value != null) {
    return measure === 'installs'
      ? { value, unit: null, days: w.whole.length, glitchless: c.new_players != null ? { new_players: c.new_players, pct: c.new_players_pct } : null, anonymous: c.anonymous, notes: c.notes }
      : { value, unit: null, days: c.active_days, glitchless: c.players_per_day != null ? { players_per_day: c.players_per_day } : null, notes: c.notes };
  }
  const m = overviewMetric(st.snapshots?.overview, measure);
  if (m) return { value: m.value, unit: null, at: st.snapshots.overview.at, from_overview: true, period: m.period, notes: c.notes };
  return { empty: true, why: `No ${name} ${measure === 'installs' ? 'new customers' : 'active customers'} in this window yet.` };
}

function customersByDay(ctx, w, name) {
  const m = measuredDays(ctx);
  const col = (k) => w.whole.map((r) => (Number.isFinite(r[k]) ? r[k] : null));
  return {
    ts: w.whole.map((r) => dayTs(r.day)),
    days: w.whole.map((r) => r.day),
    // `measured`: what Glitchless measured, next to the source's.
    series: [
      { key: 'installs', label: `Installs (${name} new customers)`, values: col('new_customers') },
      ...(m.fresh ? [{ key: 'new_players', label: 'New players (Glitchless)', measured: true, values: w.whole.map((r) => m.fresh.get(r.day) ?? 0) }] : []),
      { key: 'active_users', label: `Active users (${name})`, values: col('active_customers') },
      { key: 'players', label: 'Players (Glitchless)', measured: true, values: w.whole.map((r) => m.players.get(r.day) ?? (ctx.daily && ctx.bucketMs !== DAY ? null : 0)) },
    ],
    installs: w.customers.installs,
    new_players: w.customers.new_players,
    incomplete_day: w.whole.at(-1)?.incomplete ? w.whole.at(-1).day : null,
    notes: w.customers.notes,
  };
}

const unsplit = (name, version) => `${name} can't split this game's revenue by app version (its revenue chart has no app version segment), so there is no revenue of ${version} alone: read it without the version filter.`;

// A stock measure (MRR, active subscriptions, active trials) at the start of the window's last day, with its change
// since the first; before any day has it, the source's overview figure now. Always the whole game's.
function latest(st, w, measure, none) {
  const days = w.whole.filter((r) => Number.isFinite(r[measure]));
  if (days.length) {
    const last = days.at(-1);
    return { value: last[measure], unit: null, day: last.day, change: days.length > 1 ? round(last[measure] - days[0][measure], 2) : null, since: days.length > 1 ? days[0].day : null };
  }
  const o = st.snapshots?.overview;
  const m = overviewMetric(o, measure);
  return m ? { value: m.value, unit: null, at: o.at, from_overview: true } : none;
}

// Revenue per day, next to the game's own purchase events; a payments source's refunds (and disputes) per day too, and
// its fees, net and new paying customers for the CSV.
function byDay(w) {
  const col = (k) => w.days.map((r) => (Number.isFinite(r[k]) ? r[k] : null));
  const own = w.comparable ? w.days.map((r) => w.own.byDay.get(r.day) ?? 0) : null;
  const payments = w.refunds != null;
  return {
    ts: w.days.map((r) => dayTs(r.day)),
    days: w.days.map((r) => r.day),
    series: [{ key: 'revenue', label: 'Revenue', values: col('revenue') }, ...(payments ? [{ key: 'refunds', label: 'Refunds and disputes', values: w.days.map((r) => round((r.refunds ?? 0) + (r.disputes ?? 0), 2)) }] : []), ...(own ? [{ key: 'purchases', label: "The game's purchase events", values: own }] : [])],
    transactions: col('transactions'),
    ...(payments ? { refunds: col('refunds'), disputes: col('disputes'), fees: col('fees'), net: col('net'), new_customers: col('new_customers'), net_total: w.net, refunds_total: round((w.refunds ?? 0) + (w.disputes ?? 0), 2) } : { mrr: col('mrr'), actives: col('actives'), trials: col('trials') }),
    currency: w.currency,
    total: w.revenue,
    incomplete_day: w.days.at(-1)?.incomplete ? w.days.at(-1).day : null,
    glitchless: w.comparable ? { sum: w.own.sum, events: w.own.events, coverage_pct: w.coverage_pct } : null,
    notes: w.notes,
  };
}

// The window's revenue by the app version purchases were made on, next to what Glitchless measured of each version:
// sessions, players, crash-free sessions, frame-time p95, the game's own purchase events, and revenue per player.
// Newest version first; the source's "Other" (versions past its top 20) last.
function byVersion(ctx, st, w, currency) {
  const name = sourceName(st.store);
  const rows = w.byVersion.filter((r) => !w.version || r.version === w.version);
  const j = w.joined;
  if (!rows.length && j) {
    if (j.daily) return { empty: true, why: `${name}'s purchases are joined to the sessions they were made in over 31 days or less: pick a shorter range for revenue by version.` };
    if (!j.tied) return { empty: true, why: `None of ${name}'s purchases in this window name a Glitchless session or player, so they can't be split by version. Have the game put its Glitchless session ID in the Checkout Session's client_reference_id (or glitchless_session metadata on it or its PaymentIntent).` };
    return { empty: true, why: `${j.tied} of ${name}'s purchases in this window name a Glitchless session or player, and none of them is a session or player Glitchless measured here${w.version ? ` on ${w.version}` : ''}.` };
  }
  if (!rows.length) {
    const charts = st.snapshots?.charts;
    if (charts && !charts.version_segment) return { empty: true, why: `${name}'s revenue chart for this project can't be split by app version (it splits by ${charts.segments?.length ? charts.segments.slice(0, 8).join(', ') : 'nothing'}), so its revenue is by day only. For the game's own purchases by version: a breakdown of purchase by $version with sum amount.` };
    return { empty: true, why: st.synced_at ? `No ${name} revenue by version in this window.` : `${name} has not been synced yet: the first sync runs within the hour.` };
  }
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.version) ?? { version: r.version, revenue: 0, transactions: 0 };
    g.revenue += r.revenue;
    g.transactions += r.transactions ?? 0;
    groups.set(r.version, g);
  }
  const measured = new Map(versions(ctx, { events: 0 }).map((v) => [String(v.version), v]));
  const own = w.comparable ? sumsBy(ctx, PURCHASE, AMOUNT, { split: '$version', currency }).groups : null;
  const total = [...groups.values()].reduce((a, g) => a + g.revenue, 0);
  const out = [...groups.values()].map((g) => {
    const v = measured.get(g.version);
    const players = v?.players ?? null;
    return {
      version: g.version,
      revenue: round(g.revenue, 2),
      transactions: g.transactions,
      share_pct: pct(g.revenue, total),
      sessions: v?.sessions ?? null,
      players,
      per_player: players ? round(g.revenue / players, 2) : null,
      crash_free_pct: v ? v.crash_free_pct : null,
      frame_p95: v?.frame_p95 ?? null,
      purchases: own ? (own.get(g.version)?.sum ?? 0) : null,
    };
  });
  out.sort((a, b) => (a.version === '(other)') - (b.version === '(other)') || compareVersions(b.version, a.version));
  // A payments source's: what wasn't joined to a session, the platforms the joined purchases were made on, and the
  // players who paid among those Glitchless measured.
  const joined = j && !w.version ? { unjoined: j.unjoined, platforms: j.platforms, payers: j.payers, payers_pct: j.payers != null && w.players && !w.players_are_sessions ? pct(j.payers, w.players) : null } : {};
  const lines = j && j.unjoined.transactions ? [`${j.unjoined.transactions} of ${name}'s ${j.unjoined.transactions + j.joined} purchases in this window aren't tied to a session Glitchless measured, so they're in no version's row.`] : [];
  // (A test-mode connection's note is on its revenue and by-day panels; their titles say test mode everywhere else.)
  return { rows: out, currency: w.currency, total: round(total, 2), segment: st.snapshots?.charts?.version_segment ?? null, comparable: w.comparable, ...joined, notes: [...lines, ...w.notes.filter((n) => !/test-mode key/.test(n))] };
}

// The segments a source's revenue chart has, for a line saying it can't be split some way.
const segmentsOf = (charts) => (charts?.segments?.length ? charts.segments.slice(0, 8).join(', ') : 'nothing');
const readDaily = (name, what) => `${name}'s ${what} are read once a day: the first read comes with the next sync.`;
// Lines for the splits, which are the whole game's and read once a day.
function splitNotes(w, name, asOf, what) {
  return [...(asOf && asOf < w.hi ? [`${name}'s ${what} are read once a day: these go to ${asOf}.`] : []), ...(w.version ? [`The whole game's ${what}, whatever the version filter.`] : []), ...w.notes.filter((n) => n.includes('never converted'))];
}

// The window's installs (the source's new customers), revenue and purchases (its transactions, renewals among them) by
// the customer's country, most installs first (most revenue first when the panel shows revenue), the source's "Other"
// last. `country` is the ISO code a map places, null for a name Glitchless couldn't place (the list still has it). A
// payments source's: revenue and payments only (it has no installs), read with every sync; "(none)" for payments
// without a country.
function byCountry(st, w, show) {
  const name = sourceName(st.store);
  const charts = st.snapshots?.charts;
  const payments = Boolean(REVENUE_SOURCES[st.store]?.payments);
  const inWindow = (r) => r.day >= w.lo && r.day <= w.hi;
  const revenue = (st.revenue_countries ?? []).filter(inWindow);
  const installs = (st.installs_countries ?? []).filter(inWindow);
  if (!revenue.length && payments) return { empty: true, why: st.synced_at ? `No ${nameOf(st)} payments in this window.` : `${name} has not been synced yet: the first sync runs within the hour.` };
  if (!revenue.length && !installs.length) {
    if (charts && !charts.country_segment && !charts.installs_country_segment) return { empty: true, why: `${name}'s charts for this project can't be split by country (its revenue chart splits by ${segmentsOf(charts)}).` };
    if (!charts?.countries_day) return { empty: true, why: st.synced_at ? readDaily(name, 'countries') : `${name} has not been synced yet: the first sync runs within the hour.` };
    return { empty: true, why: `No ${name} installs or revenue by country in this window.` };
  }
  const groups = new Map();
  const group = (r) => {
    const key = r.country;
    if (!groups.has(key)) groups.set(key, { country: /^[A-Z]{2}$/.test(key) ? key : null, key, name: r.name || key, installs: 0, revenue: 0, purchases: 0 });
    return groups.get(key);
  };
  for (const r of installs) group(r).installs += r.installs ?? 0;
  for (const r of revenue) {
    const g = group(r);
    g.revenue += r.revenue ?? 0;
    g.purchases += r.transactions ?? 0;
  }
  const totals = { installs: 0, revenue: 0, purchases: 0 };
  for (const g of groups.values()) for (const k of Object.keys(totals)) totals[k] += g[k];
  const first = show === 'revenue' ? ['revenue', 'installs'] : ['installs', 'revenue'];
  const rows = [...groups.values()]
    .map((g) => ({ ...g, revenue: round(g.revenue, 2), installs_pct: pct(g.installs, totals.installs), revenue_pct: pct(g.revenue, totals.revenue) }))
    .sort((a, b) => (a.key === '(other)') - (b.key === '(other)') || b[first[0]] - a[first[0]] || b[first[1]] - a[first[1]] || (a.name < b.name ? -1 : 1));
  const unplaced = rows.filter((r) => !r.country && r.key !== '(other)' && r.key !== '(none)').map((r) => r.name);
  const unknown = rows.find((r) => r.key === '(none)');
  return {
    show,
    rows,
    currency: w.currency,
    totals: { ...totals, revenue: round(totals.revenue, 2) },
    countries: rows.filter((r) => r.country).length,
    has: { installs: installs.length > 0 || Boolean(charts?.installs_country_segment), revenue: revenue.length > 0 || Boolean(charts?.country_segment) },
    as_of: charts?.countries_day ?? null,
    from_day: w.lo,
    to_day: w.hi,
    notes: [
      payments
        ? `Revenue is what ${name} settled from buyers in each country (the billing address's, else the card's), purchases its payments there; ${name} has no installs.${unknown ? ` ${unknown.purchases} ${unknown.purchases === 1 ? 'payment' : 'payments'} came with no country.` : ''}`
        : `Installs are ${name}'s new customers in each country, purchases its transactions there (renewals count too).`,
      ...(unplaced.length ? [`Not on the map (${name} named them in a way Glitchless doesn't know): ${unplaced.slice(0, 5).join(', ')}${unplaced.length > 5 ? ` and ${unplaced.length - 5} more` : ''}.`] : []),
      ...splitNotes(w, name, charts?.countries_day, 'countries'),
    ],
  };
}

// The window's revenue by the store purchases were made in (the App Store, Google Play…), most first, next to the
// sessions (and players) Glitchless measured on that store's platform: iOS for the App Store, Android for Google Play.
function byStore(ctx, st, w) {
  const name = sourceName(st.store);
  const charts = st.snapshots?.charts;
  const rows = (st.revenue_stores ?? []).filter((r) => r.day >= w.lo && r.day <= w.hi);
  if (!rows.length) {
    if (charts && !charts.store_segment) return { empty: true, why: `${name}'s revenue chart for this project can't be split by store (it splits by ${segmentsOf(charts)}).` };
    if (!charts?.stores_day) return { empty: true, why: st.synced_at ? readDaily(name, 'stores') : `${name} has not been synced yet: the first sync runs within the hour.` };
    return { empty: true, why: `No ${name} revenue by store in this window.` };
  }
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.store) ?? { store: r.store, name: r.name || r.store, revenue: 0, purchases: 0 };
    g.revenue += r.revenue ?? 0;
    g.purchases += r.transactions ?? 0;
    groups.set(r.store, g);
  }
  const measured = ctx.daily ? null : new Map(sessionsBy(ctx).rows.map((x) => [x.value, x]));
  const total = [...groups.values()].reduce((a, g) => a + g.revenue, 0);
  const anon = w.players_are_sessions;
  const out = [...groups.values()]
    .map((g) => {
      const platform = STORE_PLATFORM[g.store] ?? null;
      const m = platform && measured ? measured.get(platform) : null;
      const people = m ? (anon ? m.sessions : m.players) : null;
      return { ...g, revenue: round(g.revenue, 2), share_pct: pct(g.revenue, total), platform, sessions: platform && measured ? (m?.sessions ?? 0) : null, players: platform && measured && !anon ? (m?.players ?? 0) : null, per_player: people ? round(g.revenue / people, 2) : null };
    })
    .sort((a, b) => (a.store === '(other)') - (b.store === '(other)') || b.revenue - a.revenue || (a.name < b.name ? -1 : 1));
  return {
    rows: out,
    currency: w.currency,
    total: round(total, 2),
    players_are_sessions: anon,
    as_of: charts?.stores_day ?? null,
    notes: [
      `Left: what ${name} counted in each store (production purchases only). Right: the sessions Glitchless measured on that store's platform (iOS for the App Store, Android for Google Play)${anon ? '; the game sends no player IDs, so revenue per player is per session' : ''}.`,
      ...(ctx.daily ? ['Sessions by platform are counted over 31 days or less.'] : []),
      ...splitNotes(w, name, charts?.stores_day, 'stores'),
    ],
  };
}

function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return String(a).localeCompare(String(b));
}

// ───────────────────────────── the query ─────────────────────────────

// The store_revenue query (app.js, the glitchless_revenue MCP tool): the window's revenue, installs (new customers)
// and active users from a revenue source (`store`, default the first connected), by day with the sessions, players and
// new players Glitchless measured that day, by version, by country and by store where the source splits them (by store
// next to the sessions on that store's platform), with the source's overview now. A payments source's (Stripe):
// revenue, refunds, disputes, fees, net and new paying customers by day, revenue by product and by country, and by
// version and platform from the purchases joined to their sessions, with the players who paid.
// `version` (every query's filter of the sessions) reads that version's revenue only. `currency`: the dashboard's.
export function revenueQuery(ctx, params = new URLSearchParams(), { currency = null } = {}) {
  const source = params.get('store')?.trim() || null;
  const sources = Object.keys(ctx.stores ?? {}).filter((s) => REVENUE_SOURCES[s]);
  if (source && !REVENUE_SOURCES[source]) return { connected: false, why: `store is one of ${Object.keys(REVENUE_SOURCES).join(', ')}`, sources };
  const st = pickSource(ctx, source);
  if (!st) return { connected: false, why: notConnected(ctx, source), sources };
  const name = nameOf(st);
  const w = windowOf(ctx, st, currency);
  const payments = Boolean(REVENUE_SOURCES[st.store].payments);
  const head = { connected: true, store: st.store, store_name: name, sources, app_id: st.app_id, ...(payments ? { mode: st.mode ?? null, products_picked: st.products ?? null } : {}), synced_at: st.synced_at, currency: w.currency, ...(w.version ? { version: w.version } : {}), overview: st.snapshots?.overview ?? null };
  if (w.unsplit) return { ...head, empty: true, why: unsplit(name, w.version) };
  if (!w.days.length) return { ...head, empty: true, why: st.synced_at ? `No ${name} revenue in this window.` : `${name} has not been synced yet: the first sync runs within the hour.` };
  // Sessions by the UTC day they started (from the sessions themselves: ranges of 31 days or less); players who played
  // that day and new players first seen that day (measuredDays).
  const started = new Map();
  if (!ctx.daily) for (const s of ctx.sessions.values()) started.set(isoDay(s.start ?? s.first_ts), (started.get(isoDay(s.start ?? s.first_ts)) ?? 0) + 1);
  const m = measuredDays(ctx);
  const c = w.customers;
  const stock = (m) => {
    const x = latest(st, w, m, null);
    return x ? { value: x.value, day: x.day ?? null, change: x.change ?? null, since: x.since ?? null } : null;
  };
  const v = byVersion(ctx, st, w, currency);
  const products = payments ? byProduct(st, w) : null;
  const countries = byCountry(st, w, payments ? 'revenue' : 'installs');
  // (A payments source sells in no store: no split by one.)
  const stores = payments ? null : byStore(ctx, st, w);
  return {
    ...head,
    from_day: w.lo,
    to_day: w.hi,
    totals: payments
      ? { revenue: w.revenue, transactions: w.transactions, refunds: w.refunds, refund_count: w.refund_count, disputes: w.disputes, fees: w.fees, net: w.net, new_customers: w.new_customers, other_payments: w.other_payments, days: w.days.length, incomplete: w.incomplete }
      : { revenue: w.revenue, transactions: w.transactions, installs: c.installs, active_users_per_day: c.active_per_day, days: w.days.length, incomplete: w.incomplete },
    ...(payments ? {} : { latest: { mrr: stock('mrr'), actives: stock('actives'), trials: stock('trials') } }),
    new_players: c.new_players,
    new_players_pct: c.new_players_pct,
    players_per_day: c.players_per_day,
    players: w.players,
    sessions: w.sessions,
    players_are_sessions: w.players_are_sessions,
    per_player: w.players && w.revenue != null ? round(w.revenue / w.players, 2) : null,
    glitchless: w.own ? { purchases: w.own.sum, events: w.own.events, currency: w.own.currency, sandbox: w.own.sandbox, comparable: w.comparable, coverage_pct: w.coverage_pct } : null,
    ...(payments && v.payers != null ? { payers: v.payers, payers_pct: v.payers_pct } : {}),
    days: w.days.map((r) => ({
      day: r.day,
      revenue: r.revenue ?? null,
      transactions: r.transactions ?? null,
      ...(payments
        ? { refunds: r.refunds ?? null, refund_count: r.refund_count ?? null, disputes: r.disputes ?? null, fees: r.fees ?? null, net: r.net ?? null, new_customers: r.new_customers ?? null }
        : { installs: r.new_customers ?? null, active_users: r.active_customers ?? null, mrr: r.mrr ?? null, actives: r.actives ?? null, trials: r.trials ?? null }),
      ...(r.incomplete ? { incomplete: true } : {}),
      sessions: ctx.daily ? null : (started.get(r.day) ?? 0),
      players: m.players.get(r.day) ?? (ctx.daily ? null : 0),
      new_players: m.fresh ? (m.fresh.get(r.day) ?? 0) : null,
      purchases: w.comparable ? (w.own.byDay.get(r.day) ?? 0) : null,
    })),
    versions: v.rows ?? null,
    ...(v.rows ? {} : { versions_why: v.why }),
    countries: countries.rows ? countries.rows.slice(0, 50).map(({ country, name, installs, revenue, purchases }) => ({ country, name, ...(payments ? {} : { installs }), revenue, purchases })) : null,
    ...(countries.rows ? (payments ? {} : { countries_as_of: countries.as_of }) : { countries_why: countries.why }),
    ...(stores ? { stores: stores.rows ? stores.rows.map(({ store, name, revenue, purchases, share_pct, platform, sessions, players, per_player }) => ({ store, name, revenue, purchases, share_pct, platform, sessions, players, per_player })) : null, ...(stores.rows ? {} : { stores_why: stores.why }) } : {}),
    ...(payments ? { products: products.rows ?? null, ...(products.rows ? {} : { products_why: products.why }), platforms: v.platforms ?? null, unjoined: v.unjoined ?? null } : {}),
    notes: [...new Set([...(v.rows && payments ? v.notes : w.notes), ...(products?.notes ?? []), ...c.notes])],
  };
}
