// Revenue: what players really paid, from the revenue source a game is connected to (RevenueCat, through Glitchless
// Cloud's RevenueCat adapter), next to what Glitchless measured of the same game: its players and
// sessions, what its own purchase events add up to (track('purchase', { amount, currency }), sums.js), its new players
// next to the source's new customers (RevenueCat's nearest thing to installs: first seen by its SDK) and its players a
// day next to the source's active customers, and, where the source splits revenue by app version, each version's
// revenue next to its players, crash-free sessions and frame times. A source's charts count production purchases only (RevenueCat leaves sandbox, TestFlight and licence-tester
// purchases out), so its revenue is the number to trust for money; Glitchless's own purchase events are the ones to
// read by level, item or player, and the gap between the two is the purchases that never reach Glitchless (builds
// without the SDK, purchases the game doesn't track). Store-neutral like reviews.js, which stores and reads a
// source's data with the stores' and dispatches its panels here. SPEC §3h.
//
// What a source's sync brings (createStoreData().write in reviews.js):
//   revenue: [{ day, revenue, transactions, mrr, actives, trials, new_customers, active_customers, currency,
//            incomplete }]   per UTC day: revenue, transactions, new customers and active customers in the day; MRR,
//            active subscriptions and trials as the source's snapshot of the day; `incomplete`: a day still filling in
//   revenue_versions: [{ day, version, revenue, transactions, currency }]   by the app version purchases were made on
//   snapshots: { overview: { at, currency, metrics: [{ id, name, value, unit, period }] },
//                charts: { day, version_segment, segments, currency } }   the source's numbers now, and what its charts
//                                                                         can be split by
//
//   STORE#<projectId>#<source>  REV#<YYYY-MM>    { days: { <day>: { revenue, transactions, mrr, actives, trials,
//                                                  new_customers, active_customers, currency, incomplete } } }   a day
//                                                  sent again replaces what it has
//   STORE#<projectId>#<source>  REVV#<YYYY-MM>   { rows: { <day>|<version>: { revenue, transactions, currency } } }
//                                                  a day sent again replaces all of that day's versions
import { overview, versions, eventIndex, playersAreSessions, retention, pct, round } from './analytics.js';
import { sumsBy, gameCurrency } from './sums.js';

export const REVENUE_SOURCES = { revenuecat: { name: 'RevenueCat' } };
const sourceName = (s) => REVENUE_SOURCES[s]?.name ?? s;
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
};
// The overview metric with a measure's number (by its ID or name), for before the charts have a day of it: MRR,
// subscriptions and trials now; new and active customers over the last 28 days.
const OVERVIEW = { mrr: /^mrr$/i, actives: /^active[_ ]subscriptions$/i, trials: /^active[_ ]trials$/i, installs: /^new[_ ]customers$/i, active_users: /^active[_ ](users|customers)$/i };
const overviewMetric = (o, measure) => o?.metrics?.find((m) => OVERVIEW[measure].test(m.id) || OVERVIEW[measure].test(m.name ?? '')) ?? null;
const MONEY = new Set(['revenue', 'per_player', 'mrr']);
// The purchase convention every SDK documents (sums.js): its event and the attribute summed.
const PURCHASE = { name: 'purchase', key: null, value: null };
const AMOUNT = 'amount';
const KEPT = ['revenue', 'transactions', 'mrr', 'actives', 'trials', 'new_customers', 'active_customers'];
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
}

// A source's revenue days and versions for `months`, oldest first.
export async function readRevenue(kv, key, months) {
  const items = await Promise.all(months.flatMap((m) => [kv.get(key, `REV#${m}`), kv.get(key, `REVV#${m}`)]));
  const revenue = [];
  const byVersion = [];
  months.forEach((_, i) => {
    for (const [day, v] of Object.entries(items[i * 2]?.days ?? {})) revenue.push({ day, ...v });
    for (const [k, v] of Object.entries(items[i * 2 + 1]?.rows ?? {})) byVersion.push({ day: k.slice(0, 10), version: k.slice(11), ...v });
  });
  const order = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  return { revenue: revenue.sort(order), revenue_versions: byVersion.sort(order) };
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
  return source && ctx.stores ? `This game has no ${sourceName(source)} connection (Glitchless Cloud: Settings → Integrations → ${sourceName(source)}).` : 'This game has no RevenueCat connection (Glitchless Cloud: Settings → Integrations → RevenueCat).';
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
  const split = Boolean(st.snapshots?.charts?.version_segment || st.revenue_versions?.length);
  let days = whole;
  if (version) {
    const mine = new Map((st.revenue_versions ?? []).filter((r) => r.version === version && r.day >= lo && r.day <= hi).map((r) => [r.day, r]));
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
  };
  w.coverage_pct = comparable && w.revenue ? pct(own.sum, w.revenue) : null;
  w.notes = notes(ctx, st, w, currency);
  w.customers = customersOf(ctx, whole);
  cache.set(st.store, w);
  return w;
}

// The source's new and active customers over the window's days (the whole game's, whatever the version filter), next
// to Glitchless's new players (first seen that UTC day, from the store's first-seen index: they need player IDs) and
// players a day. Averages a day leave out a day still filling in.
function customersOf(ctx, whole) {
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
      'RevenueCat counts a new customer the first time its SDK starts on a device (a reinstall without signing in is a new one, and testers count: customers have no sandbox side); Glitchless counts a new player the first time it sees their player ID.',
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
  const game = currency ?? w.own?.currency ?? null;
  if (w.currency && game && game !== w.currency) out.push(`${name} reports in ${w.currency} and this game's money is in ${game}: ${name}'s amounts are shown in ${w.currency}, never converted or added to the game's own. Set the connection's currency to ${game} (Settings → Integrations → ${name}) to compare them.`);
  if (w.comparable && w.revenue > 0) {
    if (w.coverage_pct < 80) out.push(`The game's own purchase events add up to ${w.coverage_pct}% of what ${name} counts: the rest are purchases that never reached Glitchless (builds without the SDK, purchases the game doesn't track, players with telemetry off).`);
    else if (w.coverage_pct > 110) out.push(`The game's own purchase events add up to ${w.coverage_pct}% of what ${name} counts: amounts sent with a different price than the store charged, refunds ${name} took off, or purchases it hasn't processed yet.`);
  }
  if (w.own?.sandbox) out.push(`${w.own.sandbox} sandbox ${w.own.sandbox === 1 ? 'purchase' : 'purchases'} (TestFlight and other test installs) are counted by Glitchless and left out of every sum; ${name} never counts them.`);
  if (w.players_are_sessions) out.push('The game sends no player IDs, so revenue per player is per session.');
  return out;
}

// ───────────────────────────── board panels ─────────────────────────────

export const REVENUE_PANEL = {
  title: (p) => MEASURES[p.measure]?.title ?? 'Revenue',
  size: (p) => MEASURES[p.measure]?.size ?? 'm',
  shared: 'sums',
};

// A store_revenue panel's own fields: `measure` (one of MEASURES) and `store` (a revenue source; default the game's
// first connected one). → fields or throws.
export function revenuePanelFields(p, at, BoardError) {
  if (!MEASURES[p.measure]) throw new BoardError(`${at} (store_revenue) needs measure: one of ${Object.keys(MEASURES).join(', ')}`);
  if (p.store != null && !REVENUE_SOURCES[p.store]) throw new BoardError(`${at}.store must be one of ${Object.keys(REVENUE_SOURCES).join(', ')}`);
  return { measure: p.measure, ...(p.store != null ? { store: p.store } : {}) };
}

// The Revenue page a game gets when it is connected to a revenue source: the source's revenue in the window, revenue
// per player (over the players Glitchless measured), installs (new customers) and active users a day, revenue per day
// next to the game's own purchase events, MRR, active subscriptions, installs and active users per day next to the new
// players and players Glitchless measured, active trials, the players measured, and revenue by app version.
export function revenuePage(source, { id = 'revenue' } = {}) {
  const panel = (measure, size) => ({ type: 'store_revenue', store: source, measure, size });
  return {
    id,
    title: 'Revenue',
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
  const name = sourceName(st.store);
  const named = { store: st.store, store_name: name, measure: p.measure };
  const w = windowOf(ctx, st, currency);
  const notSynced = `${name} has not been synced yet: the first sync runs within the hour.`;
  if (!st.synced_at && !w.whole.length && !st.snapshots?.overview) return { ...named, empty: true, why: notSynced };
  const none = { ...named, empty: true, why: w.unsplit ? unsplit(name, w.version) : `No ${name} revenue in this window: ${name}'s days kept here start ${st.revenue?.[0]?.day ?? 'with its next sync'}.` };
  const money = MONEY.has(p.measure) ? { currency: w.currency } : {};
  switch (p.measure) {
    case 'revenue':
      if (w.revenue == null) return none;
      return { ...named, value: w.revenue, unit: null, ...money, transactions: w.transactions, days: w.days.length, from_day: w.days[0].day, to_day: w.days.at(-1).day, incomplete: w.incomplete, glitchless: w.comparable ? { sum: w.own.sum, events: w.own.events, coverage_pct: w.coverage_pct } : null, notes: w.notes };
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
  }
  return named;
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

function byDay(w) {
  const col = (k) => w.days.map((r) => (Number.isFinite(r[k]) ? r[k] : null));
  const own = w.comparable ? w.days.map((r) => w.own.byDay.get(r.day) ?? 0) : null;
  return {
    ts: w.days.map((r) => dayTs(r.day)),
    days: w.days.map((r) => r.day),
    series: [{ label: 'Revenue', values: col('revenue') }, ...(own ? [{ label: "The game's purchase events", values: own }] : [])],
    transactions: col('transactions'),
    mrr: col('mrr'),
    actives: col('actives'),
    trials: col('trials'),
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
  const rows = (st.revenue_versions ?? []).filter((r) => r.day >= w.lo && r.day <= w.hi && (!w.version || r.version === w.version));
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
  return { rows: out, currency: w.currency, total: round(total, 2), segment: st.snapshots?.charts?.version_segment ?? null, comparable: w.comparable, notes: w.notes };
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
// new players Glitchless measured that day, and by version where the source splits it, with the source's overview now.
// `version` (every query's filter of the sessions) reads that version's revenue only. `currency`: the dashboard's.
export function revenueQuery(ctx, params = new URLSearchParams(), { currency = null } = {}) {
  const source = params.get('store')?.trim() || null;
  const sources = Object.keys(ctx.stores ?? {}).filter((s) => REVENUE_SOURCES[s]);
  if (source && !REVENUE_SOURCES[source]) return { connected: false, why: `store is one of ${Object.keys(REVENUE_SOURCES).join(', ')}`, sources };
  const st = pickSource(ctx, source);
  if (!st) return { connected: false, why: notConnected(ctx, source), sources };
  const name = sourceName(st.store);
  const w = windowOf(ctx, st, currency);
  const head = { connected: true, store: st.store, store_name: name, sources, app_id: st.app_id, synced_at: st.synced_at, currency: w.currency, ...(w.version ? { version: w.version } : {}), overview: st.snapshots?.overview ?? null };
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
  return {
    ...head,
    from_day: w.lo,
    to_day: w.hi,
    totals: { revenue: w.revenue, transactions: w.transactions, installs: c.installs, active_users_per_day: c.active_per_day, days: w.days.length, incomplete: w.incomplete },
    latest: { mrr: stock('mrr'), actives: stock('actives'), trials: stock('trials') },
    new_players: c.new_players,
    new_players_pct: c.new_players_pct,
    players_per_day: c.players_per_day,
    players: w.players,
    sessions: w.sessions,
    players_are_sessions: w.players_are_sessions,
    per_player: w.players && w.revenue != null ? round(w.revenue / w.players, 2) : null,
    glitchless: w.own ? { purchases: w.own.sum, events: w.own.events, currency: w.own.currency, sandbox: w.own.sandbox, comparable: w.comparable, coverage_pct: w.coverage_pct } : null,
    days: w.days.map((r) => ({
      day: r.day,
      revenue: r.revenue ?? null,
      transactions: r.transactions ?? null,
      installs: r.new_customers ?? null,
      active_users: r.active_customers ?? null,
      mrr: r.mrr ?? null,
      actives: r.actives ?? null,
      trials: r.trials ?? null,
      ...(r.incomplete ? { incomplete: true } : {}),
      sessions: ctx.daily ? null : (started.get(r.day) ?? 0),
      players: m.players.get(r.day) ?? (ctx.daily ? null : 0),
      new_players: m.fresh ? (m.fresh.get(r.day) ?? 0) : null,
      purchases: w.comparable ? (w.own.byDay.get(r.day) ?? 0) : null,
    })),
    versions: v.rows ?? null,
    ...(v.rows ? {} : { versions_why: v.why }),
    notes: [...w.notes, ...c.notes],
  };
}
