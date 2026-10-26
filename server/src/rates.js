// Rates per hour played (A1) and rates and averages by attribute (A2), for board panels, findings and the events
// query.
//
// Hours played (SPEC §4) is the time the game was on screen drawing frames: every frame window's duration_s, added up
// by the rollup cells (`sec`). So it is exact over any range, overall and by version and level; by a session split it
// comes from each session's own frame windows, over 31 days or less. A count or sum per hour played divides by them; a
// bucket or row with under MIN_HOURS of play has no rate, so near-empty ones don't spike.
//
// A rate is the share of an event's events for which an attribute holds (a board's `rate`):
//   - a flag: a boolean (won: true), or a number that is only ever 0 or 1 (Unreal sends 1 or 0 until its booleans
//     arrive). The cells count booleans in evb and sum numbers in evs, so both are exact from the cells: overall, by
//     version and level, and by another attribute's value or a list's element. Its share is of the events that carry it.
//   - a word outcome (result=win): the share of the events that carry `result` with that value (a list: of all the
//     event's events, those whose list has it). The cells count it overall and by version and level (evv, evl); split
//     by another attribute it reads the sessions' occurrences (occurrences.js), since cells never count two attributes
//     together.
// An average (`avg`) is a numeric attribute's mean per event, from the same sums. By a session split ($platform…), rates
// and averages come from the sessions' own counts of their events' values, over 31 days or less; a filtered event split
// by anything but its version or level, and any split by a numeric attribute (heat), reads the occurrences. Each rate has its 95% Wilson interval, so a row of 40
// matches isn't read as surely as one of 4,000.

import { cellsOf, eventIndex, eventsBy, steamValue, round, sessionSplit, STEAM_DIMENSIONS } from './analytics.js';
import { splitSumKey, splitAttrKey, attrKey, FIXED } from './rollups.js';
import { eachOccurrence, occurrenceGroups, bucketOf } from './occurrences.js';

// Under this many hours of play (6 minutes), a bucket or row has no per-hour rate.
export const MIN_HOURS = 0.1;
// Rows with fewer events than this are left out of a rate or average breakdown (and counted in `small`).
export const MIN_EVENTS = { rate: 30, avg: 10 };
// The values a flag (a boolean, or a number that is 0 or 1) is ever sent with, as the cells count them.
const FLAG_VALUES = new Set(['true', 'false', '1', '0']);
const Z = 1.96;

// ───────────────────────────── hours played ─────────────────────────────

// Hours played over the context (cells), or per value of `dim`: 'version' or 'level' (cells), a session split, a
// property or a Steam fact (the sessions' own frame windows) → Map(value → hours).
export function hoursPlayed(ctx) {
  return (ctx.hoursTotal ??= toHours(cellsOf(ctx).reduce((h, { c }) => h + c.sec, 0)));
}

// Seconds stay in fixed point (whole numbers) until they are hours, so the order cells come in never changes a total.
export function hoursBy(ctx, dim) {
  const out = new Map();
  const add = (k, sec) => out.set(k, (out.get(k) || 0) + sec);
  if (dim === 'version' || dim === 'level' || dim === 'zone') {
    for (const { c } of cellsOf(ctx)) if (c.sec) add(String(c[dim] ?? '(none)'), c.sec);
  } else {
    const split = sessionSplit(ctx, dim);
    for (const s of ctx.sessions.values()) {
      if (!s.cell.sec) continue;
      if (split) add(split.of(s), s.cell.sec);
      else if (STEAM_DIMENSIONS.includes(dim)) add(steamValue(s, dim) ?? '(none)', s.cell.sec);
    }
  }
  return new Map([...out].map(([k, sec]) => [k, toHours(sec)]));
}

// Hours played per time bucket; with `dim` ('version' or 'level'), per value → Map(value → [hours per bucket]).
export function hoursSeries(ctx, dim = null) {
  const nb = ctx.buckets.length;
  const all = new Array(nb).fill(0);
  const by = new Map();
  for (const { m, c } of cellsOf(ctx)) {
    if (!c.sec) continue;
    const i = bucketOf(ctx, m);
    all[i] += c.sec;
    if (!dim) continue;
    const k = String(c[dim] ?? '(none)');
    if (!by.has(k)) by.set(k, new Array(nb).fill(0));
    by.get(k)[i] += c.sec;
  }
  return dim ? new Map([...by].map(([k, list]) => [k, list.map(toHours)])) : all.map(toHours);
}

function toHours(sec) {
  return sec / FIXED.sec / 3600;
}

// A count or sum per hour played, or null under MIN_HOURS.
export function perHour(x, hours) {
  return hours >= MIN_HOURS ? round(x / hours, 2) : null;
}

export function hoursRound(h) {
  return round(h, 2);
}

// ───────────────────────────── rates and averages ─────────────────────────────

// What a panel's `rate` or `avg` measures: { kind: 'flag' | 'word' | 'avg', attr, value }.
export function measureOf(p) {
  if (p.avg) return { kind: 'avg', attr: p.avg };
  const at = p.rate.indexOf('=');
  if (at > 0) return { kind: 'word', attr: p.rate.slice(0, at).trim(), value: p.rate.slice(at + 1).trim() };
  return { kind: 'flag', attr: p.rate.trim() };
}

// Why the event's attribute can't give this measure in the window, or null.
export function measureProblem(ctx, f, m) {
  const a = eventIndex(ctx).get(f.name)?.attrs.get(m.attr);
  if (!a) return `"${f.name}" events have no "${m.attr}" attribute in this window.`;
  if (m.kind === 'flag' && ![...a.values.keys()].every((v) => FLAG_VALUES.has(v))) return `"${m.attr}" of "${f.name}" is not only true and false (or 1 and 0). For a word outcome give rate "${m.attr}=<value>", for a number avg "${m.attr}".`;
  if (m.kind === 'avg' && !a.n && !a.list) return `"${m.attr}" of "${f.name}" is not a number in this window.`;
  if (m.kind === 'avg' && a.list) return `"${m.attr}" of "${f.name}" is a list, not a number.`;
  return null;
}

// The measure per group, split `by` (null, '$version', '$level', an attribute, a session split or a Steam fact), of the
// events matching `f`: Map(group → { num, den, sessions, series }) where the rate or average is num / den. `series`
// (with `series: true`): [num, den] per time bucket. → { groups, overall: { num, den }, estimated, source }
export function measureBy(ctx, f, m, by = null, { series = false } = {}) {
  const list = !!eventIndex(ctx).get(f.name)?.attrs.get(m.attr)?.list;
  const dim = by?.startsWith('$') ? by.slice(1) : null;
  const sessionDim = dim && (sessionSplit(ctx, dim) || STEAM_DIMENSIONS.includes(dim));
  const filtered = f.value != null;
  // What the cells can count: anything of an unfiltered event by its version or level, a flag or an average by another
  // attribute too, and a filtered flag or average (not a word) overall or by version or level.
  // A number to split by (heat 0 to 8, party size) is never a group in the cells: its values would be endless.
  const numeric = by && !dim && !!eventIndex(ctx).get(f.name)?.attrs.get(by)?.n;
  const fromCells = !f.all && !sessionDim && (by == null || dim === 'version' || dim === 'level' || dim === 'zone' ? !(filtered && m.kind === 'word') : !filtered && !numeric && m.kind !== 'word');
  if (fromCells) return cellMeasure(ctx, f, m, by, { list, series });
  if (sessionDim && !filtered) return sessionMeasure(ctx, f, m, dim, { list });
  return occurrenceMeasure(ctx, f, m, by, { list, series });
}

function newGroup(nb, series) {
  return { num: 0, den: 0, sessions: null, ...(series ? { series: Array.from({ length: nb }, () => [0, 0]) } : {}) };
}

function cellMeasure(ctx, f, m, by, { list, series }) {
  const nb = ctx.buckets.length;
  const groups = new Map();
  const dim = by?.startsWith('$') ? by.slice(1) : null;
  const add = (g, num, den, i) => {
    if (!den) return;
    let x = groups.get(g);
    if (!x) groups.set(g, (x = newGroup(nb, series)));
    x.num += num;
    x.den += den;
    if (series) {
      x.series[i][0] += num;
      x.series[i][1] += den;
    }
  };
  const keys = (ctx.sumKeys ??= new Map());
  const parse = (k) => keys.get(k) ?? keys.set(k, splitSumKey(k)).get(k);
  for (const { m: minute, c } of cellsOf(ctx)) {
    const i = series ? bucketOf(ctx, minute) : 0;
    const fixed = dim ? String(c[dim] ?? '(none)') : by == null ? '' : null;
    if (m.kind === 'word') {
      // Only unfiltered events: the value's count over the events that carry the attribute (a list: all the event's).
      const hit = (c.evv?.[attrKey(f.name, m.attr, m.value)] || 0) + (c.evl?.[attrKey(f.name, m.attr, m.value)] || 0);
      let den = 0;
      if (list) den = c.ev?.[f.name] || 0;
      else for (const [k, n] of Object.entries(c.evv || {})) if (k.startsWith(attrKey(f.name, m.attr, ''))) den += n;
      add(fixed, hit * FIXED.ev, den, i);
      continue;
    }
    // Flags and averages: booleans from evb and evlb, numbers from evs, evx and evlx ([sum, events], fixed point).
    // Everything adds up in FIXED.ev units, whole numbers, so the order cells come in never changes a total.
    const maps = [];
    if (m.kind === 'flag') maps.push([c.evb, FIXED.ev], [c.evlb, FIXED.ev]);
    maps.push([c.evs, 1], [c.evx, 1], [c.evlx, 1]);
    for (const [map, scale] of maps) {
      for (const [k, [s, n]] of Object.entries(map || {})) {
        const x = parse(k);
        if (x.sum !== m.attr || x.name !== f.name) continue;
        // A whole map's own key (no group): evs and evb's overall entries.
        const grouped = x.key != null;
        if (fixed != null) {
          // Overall, or by version or level: the event's totals, or with a filter the entries of the filter's value.
          if (f.value == null ? grouped : !grouped || x.value !== f.value || (f.key && x.key !== f.key)) continue;
          add(fixed, s * scale, n, i);
        } else if (grouped && x.key === by) add(x.value, s * scale, n, i);
      }
    }
  }
  for (const x of groups.values()) {
    x.num /= FIXED.ev;
    if (series) for (const b of x.series) b[0] /= FIXED.ev;
  }
  const out = finish(ctx, f, m, by, groups);
  return { ...out, source: 'cells' };
}

// By a session split or a Steam fact: each session's own counts of its events' values.
function sessionMeasure(ctx, f, m, dim, { list }) {
  const groups = new Map();
  const split = sessionSplit(ctx, dim);
  for (const s of ctx.sessions.values()) {
    const v = s.ev?.[f.name];
    const t = v?.a[m.attr];
    if (!t) continue;
    let num = 0;
    let den = 0;
    if (m.kind === 'flag') {
      num = (t.v.true || 0) + (t.v['1'] || 0);
      den = num + (t.v.false || 0) + (t.v['0'] || 0);
    } else if (m.kind === 'avg') {
      num = t.s || 0; // fixed point, whole numbers until the end
      den = t.c || 0;
    } else {
      num = t.v[m.value] || 0;
      den = list ? v.n : Object.values(t.v).reduce((a, k) => a + k, 0);
    }
    if (!den) continue;
    const g = split ? split.of(s) : steamValue(s, dim) ?? '(none)';
    let x = groups.get(g);
    if (!x) groups.set(g, (x = { num: 0, den: 0, sessions: 0 }));
    x.num += num;
    x.den += den;
    x.sessions++;
  }
  if (m.kind === 'avg') for (const x of groups.values()) x.num /= FIXED.ev;
  const overall = [...groups.values()].reduce((o, x) => ({ num: o.num + x.num, den: o.den + x.den }), { num: 0, den: 0 });
  return { groups, overall, estimated: 0, source: 'sessions' };
}

// What the cells can't count together, from the sessions' occurrences.
function occurrenceMeasure(ctx, f, m, by, { list, series }) {
  const nb = ctx.buckets.length;
  const groups = new Map();
  const overall = { num: 0, den: 0 };
  const groupsOf = occurrenceGroups(by, ctx);
  const seen = new Map();
  const { estimated } = eachOccurrence(ctx, f, (o) => {
    const v = o.attrs[m.attr];
    let hit;
    if (m.kind === 'flag') {
      if (v !== true && v !== false && v !== 1 && v !== 0) return;
      hit = v === true || v === 1 ? 1 : 0;
    } else if (m.kind === 'avg') {
      if (typeof v !== 'number') return;
      hit = v;
    } else {
      if (v == null && !list) return;
      hit = Array.isArray(v) ? (v.map(String).includes(m.value) ? 1 : 0) : String(v) === m.value ? 1 : 0;
    }
    overall.num += hit * o.w;
    overall.den += o.w;
    const i = series ? bucketOf(ctx, o.ts) : 0;
    for (const g of groupsOf(o)) {
      let x = groups.get(g);
      if (!x) groups.set(g, (x = { ...newGroup(nb, series), sessions: 0 }));
      x.num += hit * o.w;
      x.den += o.w;
      if (series) {
        x.series[i][0] += hit * o.w;
        x.series[i][1] += o.w;
      }
      if (!seen.has(g)) seen.set(g, new Set());
      seen.get(g).add(o.s);
    }
  });
  for (const [g, set] of seen) groups.get(g).sessions = set.size;
  return { groups, overall, estimated, source: 'occurrences' };
}

// The overall measure next to the groups, and the sessions per row where the index has them.
function finish(ctx, f, m, by, groups) {
  let overall;
  if (by == null) overall = groups.get('') ?? { num: 0, den: 0 };
  else overall = cellMeasure(ctx, f, m, null, { list: !!eventIndex(ctx).get(f.name)?.attrs.get(m.attr)?.list, series: false }).overall;
  if (by === '$version') {
    for (const x of eventsBy(ctx, f, 'version')) if (groups.has(x.value)) groups.get(x.value).sessions = x.sessions;
  } else if (by && !by.startsWith('$')) {
    const a = eventIndex(ctx).get(f.name)?.attrs.get(by);
    for (const [value, x] of groups) x.sessions = a?.values.get(value)?.sessions ?? null;
  }
  return { groups, overall: { num: overall.num, den: overall.den }, estimated: 0 };
}

// A rate as a percentage with its 95% Wilson interval ({ rate, low, high }): one decimal, two under 10% (a gacha's 0.41%).
export function rateOf(num, den) {
  if (!den) return { rate: null, low: null, high: null };
  const p = num / den;
  const d = 1 + (Z * Z) / den;
  const c = (p + (Z * Z) / (2 * den)) / d;
  const h = (Z * Math.sqrt((p * (1 - p)) / den + (Z * Z) / (4 * den * den))) / d;
  const pctOf = (x) => round(x * 100, x < 0.1 ? 2 : 1);
  return { rate: pctOf(p), low: pctOf(Math.max(0, c - h)), high: pctOf(Math.min(1, c + h)) };
}

export function avgOf(num, den) {
  return den ? round(num / den, 2) : null;
}

// Whether an interval [low, high] leaves out a line (the overall rate, or the rate the game expects).
export function misses(row, line) {
  return line != null && row.low != null && (row.high < line || row.low > line);
}
