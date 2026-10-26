// Distributions of the numbers a game sends with its events (A3): match length, time waiting for a match, placement,
// floors reached, pulls to a top unit. For the distribution panel, a stat's percentile (`of` with `quantile`), the
// levels panel's clear times, findings and the events query.
//
// The cells sketch each event's numeric attributes (rollups.js evq, 5% relative accuracy), and sketches merge exactly,
// so a whole distribution, and one split by version or level, is right to within 5% over any range. Split by an
// attribute, a session split or a Steam fact, or for a filtered event, the values come from the sessions' occurrences
// (occurrences.js), never from a sketch per attribute value: exact while no session sent more of the event than it
// keeps, so a game should send what it wants measured once per match or run.
//
// A summary is { count, p50, p90, p99, min, max, mean, histogram, under, over, whole }: `histogram` is [{ lo, hi,
// count }] in equal steps of a round size (1, 2 or 5 × 10ⁿ) from the 1st to the 99th percentile, with `under` and
// `over` counting what falls outside; its edges are whole numbers when every value is one (placements, floors).

import { cellsOf, round } from './analytics.js';
import { newDist, distMerge, distValue, distKey, splitDistKey, FIXED } from './rollups.js';
import { eachOccurrence, occurrenceGroups } from './occurrences.js';

export const BINS = { default: 20, max: 40 };
export const ROWS = { default: 5, max: 8 };

// The distribution of attribute `of` of the events matching `f`, overall and (with `by`) per group, the largest
// `limit` groups first. → { total, rows, partial, estimated, source } or null when no event carried it.
export function distributionOf(ctx, f, of, { by = null, bins = BINS.default, limit = ROWS.default } = {}) {
  const dim = by?.startsWith('$') ? by.slice(1) : null;
  if (!f.value && (by == null || dim === 'version' || dim === 'level' || dim === 'zone')) return fromCells(ctx, f, of, dim, { bins, limit });
  return fromOccurrences(ctx, f, of, by, { bins, limit });
}

function fromCells(ctx, f, of, dim, { bins, limit }) {
  const key = distKey(f.name, of);
  const all = newDist();
  const groups = new Map();
  let partial = false;
  for (const { c } of cellsOf(ctx)) {
    if (c.evqc?.[f.name]) partial = true;
    const d = c.evq?.[key];
    if (!d) continue;
    distMerge(all, d);
    if (!dim) continue;
    const g = String(c[dim] ?? '(none)');
    if (!groups.has(g)) groups.set(g, newDist());
    distMerge(groups.get(g), d);
  }
  if (!all.n) return null;
  const rows = [...groups]
    .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([value, d]) => ({ value, ...rowOf(sketchSummary(d, 0)) }));
  return { total: sketchSummary(all, bins), ...(dim ? { rows, more: Math.max(0, groups.size - rows.length) } : {}), partial, estimated: 0, source: 'cells' };
}

function fromOccurrences(ctx, f, of, by, { bins, limit }) {
  const all = [];
  const groups = new Map();
  const groupsOf = occurrenceGroups(by, ctx);
  const { estimated } = eachOccurrence(ctx, f, (o) => {
    const v = o.attrs[of];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    all.push([v, o.w]);
    if (by == null) return;
    for (const g of groupsOf(o)) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([v, o.w]);
    }
  });
  if (!all.length) return null;
  const weight = (list) => list.reduce((s, [, w]) => s + w, 0);
  const rows = [...groups]
    .map(([value, list]) => [value, list, weight(list)])
    .sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([value, list]) => ({ value, ...rowOf(listSummary(list, 0)) }));
  return { total: listSummary(all, bins), ...(by != null ? { rows, more: Math.max(0, groups.size - rows.length) } : {}), partial: false, estimated, source: 'occurrences' };
}

function rowOf(s) {
  return { count: s.count, p50: s.p50, p90: s.p90, mean: s.mean };
}

// A summary of a sketch (rollups.js distAdd): percentiles to within 5%, the exact count, mean, min and max.
export function sketchSummary(d, bins = BINS.default) {
  return summary(bucketsOf(d), d.n, { min: d.lo, max: d.hi, mean: d.n ? d.s / FIXED.ev / d.n : null, whole: d.w === 1, bins });
}

// A sketch's buckets in order, each as [the value it stands for, count]: negatives (largest magnitude first), zeros,
// positives. A bucket's value stays within the smallest and largest seen, and is whole when every value was.
function bucketsOf(d) {
  const whole = d.w === 1;
  const side = (o, negative) => Object.entries(o).map(([i, k]) => [distValue(Number(i), negative), k]);
  return [...side(d.m, true), ...(d.z ? [[0, d.z]] : []), ...side(d.p, false)].sort((a, b) => a[0] - b[0]).map(([v, k]) => [clamp(whole ? Math.round(v) : v, d.lo, d.hi), k]);
}

// A summary of exact values, each [value, weight].
export function listSummary(list, bins = BINS.default) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const n = sorted.reduce((s, [, w]) => s + w, 0);
  const whole = sorted.every(([v]) => Number.isInteger(v));
  const mean = n ? sorted.reduce((s, [v, w]) => s + v * w, 0) / n : null;
  return summary(sorted, n, { min: sorted[0][0], max: sorted.at(-1)[0], mean, whole, bins });
}

// Percentiles over values in order ([value, count]): the value at index min(n - 1, floor(q × n)) of all of them, as
// analytics.js quantile() picks it.
function summary(sorted, n, { min, max, mean, whole, bins }) {
  const at = (q) => (n ? valueAt(sorted, n, q, false) : null);
  const fmt = (v) => (v == null ? null : whole ? Math.round(v) : round(v, 2));
  const out = { count: Math.round(n), p50: fmt(at(0.5)), p90: fmt(at(0.9)), p99: fmt(at(0.99)), min: fmt(min), max: fmt(max), mean: mean == null ? null : round(mean, 2), whole };
  if (!bins) return out;
  return { ...out, ...histogram(sorted, at(0.01), at(0.99), whole, bins) };
}

// Equal bins of a round size from lo (the 1st percentile) to hi (the 99th); what falls outside is under or over.
function histogram(sorted, lo, hi, whole, bins) {
  let step = niceStep((hi - lo) / bins || (whole ? 1 : Math.abs(lo) / 10 || 1));
  if (whole) step = Math.max(1, Math.ceil(step));
  const start = Math.floor(lo / step) * step;
  const k = Math.max(1, Math.min(bins * 2, Math.floor((hi - start) / step) + 1));
  const counts = new Array(k).fill(0);
  let under = 0;
  let over = 0;
  for (const [v, w] of sorted) {
    const i = Math.floor((v - start) / step + 1e-9);
    if (i < 0) under += w;
    else if (i >= k) over += w;
    else counts[i] += w;
  }
  const edge = (i) => round(start + i * step, 6);
  return { histogram: counts.map((count, i) => ({ lo: edge(i), hi: edge(i + 1), count: Math.round(count) })), under: Math.round(under), over: Math.round(over) };
}

// The smallest of 1, 2 or 5 × 10ⁿ at or above v.
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v * (1 - 1e-9)) return m * p;
  return 10 * p;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo ?? v), hi ?? v);
}

// One percentile (1 to 99) of attribute `of` of the events matching `f`, or null. → { value, count, partial,
// estimated }
export function percentileOf(ctx, f, of, q) {
  if (!f.value) {
    const all = newDist();
    const key = distKey(f.name, of);
    let partial = false;
    for (const { c } of cellsOf(ctx)) {
      if (c.evq?.[key]) distMerge(all, c.evq[key]);
      if (c.evqc?.[f.name]) partial = true;
    }
    if (!all.n) return null;
    return { value: valueAt(bucketsOf(all), all.n, q / 100, all.w === 1), count: all.n, partial, estimated: 0 };
  }
  return percentileOfOccurrences(ctx, f, of, q);
}

// One percentile from the sessions' occurrences, whatever the filter: for a group of sessions (versions by a property).
export function percentileFromOccurrences(ctx, f, of, q) {
  return percentileOfOccurrences(ctx, f, of, q)?.value ?? null;
}

function percentileOfOccurrences(ctx, f, of, q) {
  const values = [];
  const { estimated } = eachOccurrence(ctx, f, (o) => typeof o.attrs[of] === 'number' && Number.isFinite(o.attrs[of]) && values.push([o.attrs[of], o.w]));
  if (!values.length) return null;
  values.sort((a, b) => a[0] - b[0]);
  const n = values.reduce((s, [, w]) => s + w, 0);
  return { value: valueAt(values, n, q / 100, values.every(([v]) => Number.isInteger(v))), count: Math.round(n), partial: false, estimated };
}

function valueAt(sorted, n, q, whole) {
  const idx = Math.min(n - 1, Math.floor(q * n));
  let acc = 0;
  for (const [v, k] of sorted) {
    acc += k;
    if (acc > idx) return whole ? Math.round(v) : round(v, 2);
  }
  return sorted.at(-1)[0];
}

// Every numeric attribute's p50, p90 and p99 per event name, from the cells (glitchless_events): name → attr → { p50,
// p90, p99 }.
export function eventPercentiles(ctx) {
  const merged = new Map();
  for (const { c } of cellsOf(ctx)) {
    for (const [k, d] of Object.entries(c.evq || {})) {
      if (!merged.has(k)) merged.set(k, newDist());
      distMerge(merged.get(k), d);
    }
  }
  const out = new Map();
  for (const [k, d] of merged) {
    const { name, attr } = splitDistKey(k);
    const s = sketchSummary(d, 0);
    if (!out.has(name)) out.set(name, {});
    out.get(name)[attr] = { p50: s.p50, p90: s.p90, p99: s.p99 };
  }
  return out;
}
