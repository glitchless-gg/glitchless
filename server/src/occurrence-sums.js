// Sums of a filtered event split by another attribute, from the sessions' occurrences: revenue of completed purchases
// by item (`event: "purchase:result=done", by: "item", sum: "amount"`), so a game can send the amount of a cancelled
// purchase too and still add up only the ones that went through. The cells sum a number per name and per one other
// attribute value (rollups.js evx), never per two, so what needs the filter and the split together reads the first 16 of
// each event a session keeps with all its attributes (occurrences.js), as filtered rates and distributions do.
//
// Over 31 days or less that is exact while no session sent more than 16 of the event (purchases rarely are); a session
// that sent more has its 16 stand for all of its events, and the answer says from how many sessions it was
// `estimated`. Over more than 31 days it reads each day's sample of sessions (daily.js), weighted by the day's sampling
// rate: exact while a day has no more sessions than the sample keeps, and named in meta.approximate when it has. Only
// occurrences inside the window count, as the cells only count its minutes. Money follows sums.js: each currency kept
// apart (Robux too), the game's one currency added up and the rest named in `mismatch`, and sandbox purchases counted
// but never added in. A counter's occurrence (count()) carries its words but not its numbers, so it adds nothing.

import { eachOccurrence, occurrenceGroups, bucketOf } from './occurrences.js';
import { currencyOf, isSandboxPurchase, FIXED } from './rollups.js';
import { eventIndex, round } from './analytics.js';
import { gameCurrency } from './sums.js';

// The sums of attribute `sum` of the occurrences matching `f`, per group `by` (an attribute, $version, $level, $zone):
// { currency, groups: Map(value → { value, sum, events, count, sessions, series }), mismatch, sandbox, estimated }.
// `count` is every matching event of the group, `events` the ones whose amounts were added in.
export function occurrenceSums(ctx, f, sum, by, { currency = null } = {}) {
  const nb = ctx.buckets.length;
  const groupsOf = occurrenceGroups(by, ctx);
  const from = ctx.from ?? -Infinity;
  const to = ctx.to ?? Infinity;
  const raw = new Map(); // group → { count, sessions, byCur: currency → [sum (fixed point), events, series] }
  let sandbox = 0;
  let anyCurrency = false;
  const { estimated } = eachOccurrence(ctx, f, (o) => {
    if (o.ts < from || o.ts > to) return;
    const cur = currencyOf(o.attrs);
    if (cur) anyCurrency = true;
    const free = isSandboxPurchase(f.name, o.attrs, cur);
    if (free) sandbox += o.w;
    const v = o.attrs[sum];
    const i = bucketOf(ctx, o.ts);
    for (const g of groupsOf(o)) {
      let x = raw.get(g);
      if (!x) raw.set(g, (x = { count: 0, sessions: new Set(), byCur: new Map() }));
      x.count += o.w;
      x.sessions.add(o.s);
      if (free || typeof v !== 'number' || !Number.isFinite(v)) continue;
      let c = x.byCur.get(cur);
      if (!c) x.byCur.set(cur, (c = [0, 0, new Array(nb).fill(0)]));
      const s = Math.round(v * FIXED.ev) * o.w;
      c[0] += s;
      c[1] += o.w;
      c[2][i] += s;
    }
  });
  const money = anyCurrency || !!eventIndex(ctx).get(f.name)?.attrs.has('currency');
  const cur = money ? gameCurrency(ctx, currency) : null;
  const groups = new Map();
  const mismatch = new Map();
  for (const [value, x] of raw) {
    const out = { value, sum: 0, events: 0, count: Math.round(x.count), sessions: x.sessions.size, series: new Array(nb).fill(0) };
    for (const [c, [s, n, series]] of x.byCur) {
      if (!money || !c || c === cur) {
        out.sum += s;
        out.events += n;
        for (let i = 0; i < nb; i++) out.series[i] += series[i];
      } else {
        const m = mismatch.get(c) || { currency: c, sum: 0, events: 0 };
        m.sum += s;
        m.events += n;
        mismatch.set(c, m);
      }
    }
    groups.set(value, { ...out, sum: units(out.sum), events: Math.round(out.events), series: out.series.map(units) });
  }
  return {
    currency: cur,
    groups,
    mismatch: [...mismatch.values()].map((m) => ({ ...m, sum: units(m.sum), events: Math.round(m.events) })).sort((a, b) => b.events - a.events || (a.currency < b.currency ? -1 : 1)),
    sandbox: Math.round(sandbox),
    estimated,
  };
}

function units(fixed) {
  return round(fixed / FIXED.ev, 2);
}
