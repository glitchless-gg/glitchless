// Sums of the numbers a game sends with its own events (revenue, coins, seconds), and conversion: the share of
// players or sessions that sent an event. Sums come from the rollup cells (rollups.js evs and evx), so they are
// exact over any range, whether folded from raw events, merged from hour summaries or from daily rollups.
//
// Money: purchases follow a convention, track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' }).
// A sum is money when its events carry a `currency`, and the cells keep each currency's sums apart. A game has
// one currency: the dashboard's (`currency`), else the one most of its events were sent in. Events without a
// currency count in it; events in another are left out of the sum and named (`mismatch`), never added up.

import { cellsOf, eventIndex, eventsBy, sentEvent, parseFunnel, round } from './analytics.js';
import { splitSumKey, FIXED } from './rollups.js';
import { approximate } from './daily.js';

// The currency a game's money is shown in: `configured` (the dashboard's), else the currency most of its
// events were sent with (any event name), else null.
export function gameCurrency(ctx, configured = null) {
  if (configured) return configured;
  if (ctx.sumCurrency !== undefined) return ctx.sumCurrency;
  const tally = new Map();
  for (const e of eventIndex(ctx).values()) {
    const a = e.attrs.get('currency');
    if (!a) continue;
    for (const x of a.values.values()) {
      const c = String(x.value).trim().toUpperCase().slice(0, 8);
      if (c) tally.set(c, (tally.get(c) || 0) + x.count);
    }
  }
  const [best] = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return (ctx.sumCurrency = best ? best[0] : null);
}

// The sums of attribute `sum` of the events matching `f` ({ name, key, value }, as parseFunnel gives), per
// group: one group '' (split null), per version or level (split '$version' / '$level'), or per value of an
// attribute (split: its key; then `f` is a name only, as the cells don't cross two attributes). Each group is
// { sum, events, series } in the game's currency, and `mismatch` lists the sums in other currencies.
export function sumsBy(ctx, f, sum, { split = null, currency = null } = {}) {
  const nb = ctx.buckets.length;
  const keys = (ctx.sumKeys ??= new Map());
  const parse = (k) => {
    let x = keys.get(k);
    if (!x) keys.set(k, (x = splitSumKey(k)));
    return x;
  };
  const raw = new Map(); // group → currency → [sum, events, series], fixed point
  const add = (group, cur, [s, n], i) => {
    let g = raw.get(group);
    if (!g) raw.set(group, (g = new Map()));
    let x = g.get(cur);
    if (!x) g.set(cur, (x = [0, 0, new Array(nb).fill(0)]));
    x[0] += s;
    x[1] += n;
    x[2][i] += s;
  };
  const dim = split?.startsWith('$') ? split.slice(1) : null;
  const byAttr = split && !dim ? split : null;
  let cut = false;
  for (const { m, c } of cellsOf(ctx)) {
    const i = bucketOf(ctx, m);
    const group = dim ? String(c[dim] ?? '(none)') : '';
    // A name alone (and no attribute split) reads the totals; anything else the per-value sums.
    const list = f.value == null && !byAttr ? c.evs : c.evx;
    for (const [k, v] of Object.entries(list || {})) {
      const x = parse(k);
      if (x.sum == null) {
        cut = true;
        continue;
      }
      if (x.name !== f.name || x.sum !== sum) continue;
      if (byAttr) {
        if (x.key === byAttr) add(x.value, x.currency, v, i);
      } else if (f.value == null || (x.value === f.value && (!f.key || x.key === f.key))) add(group, x.currency, v, i);
    }
  }
  if (ctx.daily) approximate(ctx, 'event_sums', cut);
  const money = [...raw.values()].some((g) => [...g.keys()].some(Boolean));
  const cur = money ? gameCurrency(ctx, currency) : null;
  const groups = new Map();
  const mismatch = new Map();
  for (const [group, byCur] of raw) {
    const out = { value: group, sum: 0, events: 0, series: new Array(nb).fill(0) };
    for (const [c, [s, n, series]] of byCur) {
      if (!money || !c || c === cur) {
        out.sum += s;
        out.events += n;
        for (let i = 0; i < nb; i++) out.series[i] += series[i];
      } else {
        const x = mismatch.get(c) || { currency: c, sum: 0, events: 0 };
        x.sum += s;
        x.events += n;
        mismatch.set(c, x);
      }
    }
    groups.set(group, { ...out, sum: units(out.sum), series: out.series.map(units) });
  }
  return {
    currency: cur,
    groups,
    mismatch: [...mismatch.values()].map((x) => ({ ...x, sum: units(x.sum) })).sort((a, b) => b.events - a.events || (a.currency < b.currency ? -1 : 1)),
    cut,
  };
}

// How many players or sessions (`of`: '$players' or '$sessions') sent an event matching `f`; null when that
// can't be known (players per attribute value over more than 31 days: the day groups count sessions only).
export function senders(ctx, f, of) {
  const e = eventIndex(ctx).get(f.name);
  if (!e) return 0;
  if (of === '$sessions') {
    if (f.value == null) return e.sessions;
    // Sessions per value, as eventCount() counts them (a value without a key: every attribute that has it).
    const attrs = f.key ? [e.attrs.get(f.key)].filter(Boolean) : [...e.attrs.values()];
    return attrs.reduce((n, a) => n + (a.values.get(f.value)?.sessions || 0), 0);
  }
  if (f.value == null) return e.players.size;
  if (ctx.daily) return null;
  const players = new Set();
  for (const s of ctx.sessions.values()) if (sentEvent(s, f)) players.add(s.player_id);
  return players.size;
}

// A stat panel's number on one version (versions()): a sum per session, player or session as `per` says, or
// a conversion. `v` is the version's summary (sessions, players) and `cells` its rollup cells.
export function versionStat(ctx, p, v, cells, currency = null) {
  const [f] = parseFunnel(p.event);
  if (p.sum) {
    const sums = sumsBy({ ...ctx, cells: cells.map((c) => ({ m: ctx.buckets[0], c })) }, f, p.sum, { currency: currency ?? gameCurrency(ctx) });
    const total = sums.groups.get('')?.sum ?? 0;
    const base = p.per === '$players' ? v.players : v.sessions;
    return base ? round(total / base, 2) : null;
  }
  const base = p.per === '$players' ? v.players : v.sessions;
  if (!base) return null;
  let sent;
  if (p.per === '$sessions') sent = eventsBy(ctx, f, 'version').find((x) => x.value === String(v.version))?.sessions ?? 0;
  else if (ctx.daily) {
    // The day groups count players per event name, not per attribute value.
    if (f.value != null) return null;
    const e = ctx.daily.byVersion.get(v.version)?.ev.get(f.name);
    approximate(ctx, 'event_players', !!e?.pl.approx);
    sent = e ? e.pl.count() : 0;
  } else {
    const players = new Set();
    for (const s of ctx.sessions.values()) if (String(s.version) === String(v.version) && sentEvent(s, f)) players.add(s.player_id);
    sent = players.size;
  }
  return round((sent / base) * 100, 1);
}

// Every custom event's sums, per numeric attribute and currency (glitchless_events): name (in order) → [{ attr,
// currency, sum, events }], the largest first.
export function eventSums(ctx) {
  const out = new Map();
  const totals = new Map();
  for (const { c } of cellsOf(ctx)) {
    for (const [k, [s, n]] of Object.entries(c.evs || {})) {
      const x = splitSumKey(k);
      if (x.sum == null) continue;
      const key = JSON.stringify([x.name, x.sum, x.currency]);
      const t = totals.get(key) || { name: x.name, attr: x.sum, currency: x.currency || null, sum: 0, events: 0 };
      t.sum += s;
      t.events += n;
      totals.set(key, t);
    }
  }
  for (const { name, ...t } of totals.values()) {
    if (!out.has(name)) out.set(name, []);
    out.get(name).push({ ...t, sum: units(t.sum) });
  }
  for (const list of out.values()) list.sort((a, b) => b.events - a.events || (a.attr < b.attr ? -1 : a.attr > b.attr ? 1 : (a.currency || '') < (b.currency || '') ? -1 : 1));
  return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

function units(fixed) {
  return round(fixed / FIXED.ev, 2);
}

// The time bucket a minute falls in, as analytics.js buckets them.
function bucketOf(ctx, ts) {
  return Math.min(ctx.buckets.length - 1, Math.max(0, Math.floor((ts - ctx.buckets[0]) / ctx.bucketMs)));
}
