// Session properties (docs/design/genre-coverage.md A6; SPEC §2 props, §3, §3b): what holds for a session in the game's
// own words, such as the mode, a rank tier, a class or the server region. The SDKs and intake check them (no key that
// names a person, no value shaped like an ID), and each session keeps the latest value of each key (session-state.js
// props). Nothing is kept per property in the cells (decision 8): every split and filter reads the sessions, so over
// 31 days or less, as the platform split does.
//
//   splits    `by: "$<key>"` wherever `$platform` works (series, breakdowns, rates and averages, distributions, hours
//             played, levels, retention, versions): each session is its value, `(none)` without one. A split shows the
//             top 40 values, the rest as `(other)`; a property with more than 200 values on one day is really an ID,
//             and every value reads as `(too many values)`.
//   filters   `prop.<key>=<value>[,<value>…]` on any query, and a board page's `where`, keep the sessions with one of
//             those values (`(none)`: those without the property).
//   findings  a finding names a property when most of the sessions it hit have one value of it (propertyLean), and
//             finding 14 a setting that runs slow (perf-prop-<key>).

import { propKeyProblem } from '../../packages/sdk/src/props.js';
import { newCell, mergeCell } from './rollups.js';

export const NONE = '(none)';
export const OTHER = '(other)';
export const TOO_MANY = '(too many values)';
// A split shows this many values, the rest as (other).
export const SPLIT_VALUES = 40;
// A property with more values than this on one day is an ID, not a property.
export const IDENTIFIER_VALUES = 200;
// A page `where` or a filter takes at most this many values of a key.
export const WHERE_VALUES = 20;
const DAY = 86_400_000;

// `$rank` → 'rank' when it can be a property (a key of the property rules that isn't a built-in split), else null.
export function propertyKey(by) {
  if (typeof by !== 'string' || !by.startsWith('$')) return null;
  const key = by.slice(1);
  return propKeyProblem(key) ? null : key;
}

// A session's value of a property, as a split or a filter compares it (numbers and flags as text), or null.
export function propOf(s, key) {
  const x = s.props?.[key];
  return x && x[0] != null ? String(x[0]) : null;
}

// Each property of the context's sessions: its values (the most sessions first, players where the game sends IDs) and
// whether it is identifier-like (more than IDENTIFIER_VALUES values on one day). Computed once per context.
export function propertyStats(ctx) {
  if (ctx.propStats) return ctx.propStats;
  const keys = new Map();
  for (const s of ctx.sessions.values()) {
    const day = Math.floor((s.start ?? s.first_ts) / DAY);
    for (const [key, [v]] of Object.entries(s.props || {})) {
      if (v == null) continue;
      let k = keys.get(key);
      if (!k) keys.set(key, (k = { key, values: new Map(), days: new Map() }));
      const value = String(v);
      let x = k.values.get(value);
      if (!x) k.values.set(value, (x = { value, sessions: 0, players: new Set() }));
      x.sessions++;
      x.players.add(s.player_id);
      if (!k.days.has(day)) k.days.set(day, new Set());
      k.days.get(day).add(value);
    }
  }
  const out = new Map();
  for (const k of keys.values()) {
    const values = [...k.values.values()].sort((a, b) => b.sessions - a.sessions || (a.value < b.value ? -1 : 1));
    const identifierLike = [...k.days.values()].some((set) => set.size > IDENTIFIER_VALUES);
    out.set(k.key, { key: k.key, values, identifier_like: identifierLike, top: new Set(values.slice(0, SPLIT_VALUES).map((x) => x.value)) });
  }
  return (ctx.propStats = out);
}

// The split of sessions by property `key`: { label, of(s) }, each session's value as a split shows it.
export function propertySplit(ctx, key) {
  const stats = propertyStats(ctx).get(key);
  return {
    label: key,
    of: (s) => {
      const v = propOf(s, key);
      if (v == null) return NONE;
      if (!stats) return v;
      if (stats.identifier_like) return TOO_MANY;
      return stats.top.has(v) ? v : OTHER;
    },
  };
}

// The properties for the events query (`properties`): [{ key, values: [{ value, sessions, players }], identifier_like }],
// players null when the game sends no player IDs.
export function propertyList(ctx, { players = true } = {}) {
  return [...propertyStats(ctx).values()]
    .map((k) => ({ key: k.key, identifier_like: k.identifier_like, values: k.identifier_like ? [] : k.values.slice(0, SPLIT_VALUES).map((x) => ({ value: x.value, sessions: x.sessions, players: players ? x.players.size : null })) }))
    .sort((a, b) => sessionsOf(b) - sessionsOf(a) || (a.key < b.key ? -1 : 1));
}

function sessionsOf(k) {
  return k.values.reduce((n, x) => n + x.sessions, 0);
}

// Query parameters → { key: [values] } for each prop.<key>=a,b, or null.
export function propsWhere(params) {
  const where = {};
  for (const [k, v] of params) {
    if (!k.startsWith('prop.')) continue;
    const key = k.slice(5);
    if (propKeyProblem(key) || v == null || v === '') continue;
    where[key] = [...new Set([...(where[key] || []), ...v.split(',').map((x) => x.trim().slice(0, 64)).filter(Boolean)])].slice(0, WHERE_VALUES);
  }
  return Object.keys(where).length ? where : null;
}

// A board page's `where` ({ "$rank": "diamond" } or a list of values) → { key: [values] }.
export function pageWhere(where) {
  if (!where) return null;
  const out = {};
  for (const [k, v] of Object.entries(where)) out[k.slice(1)] = (Array.isArray(v) ? v : [v]).map(String);
  return out;
}

// Both filters at once: a key in both keeps the values in both.
export function andWhere(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [k, vs] of Object.entries(b)) out[k] = out[k] ? out[k].filter((v) => vs.includes(v)) : vs;
  return out;
}

// Whether a session passes a property filter.
export function sessionPasses(s, where) {
  for (const [key, values] of Object.entries(where)) if (!values.includes(propOf(s, key) ?? NONE)) return false;
  return true;
}

// A page `where` as given → as stored, or a message saying what to fix.
export function whereProblem(where) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return 'where is an object of properties, e.g. { "$rank": ["diamond", "master"] }';
  const keys = Object.keys(where);
  if (!keys.length || keys.length > 4) return 'where takes 1 to 4 properties';
  for (const k of keys) {
    if (!propertyKey(k)) return `where.${k}: a property, written "$<key>" (a lower-case word that isn't a built-in split such as $platform)`;
    const values = Array.isArray(where[k]) ? where[k] : [where[k]];
    if (!values.length || values.length > WHERE_VALUES) return `where.${k} takes 1 to ${WHERE_VALUES} values`;
    if (!values.every((v) => (typeof v === 'string' && v.trim() && v.length <= 64) || typeof v === 'boolean' || Number.isInteger(v))) return `where.${k}: each value is a word, a flag or a whole number`;
  }
  return null;
}

// Most of a problem on one value (decision 5): of the sessions it hit (`hit`, session states), the property value
// that holds for 60% or more of them, 5 or more, and at least 1.5 times its share of every session. → { key, value,
// sessions, share_pct, all_pct } or null. Identifier-like properties and those with one value only are left out.
export function propertyLean(ctx, hit) {
  if (ctx.daily || !hit.length) return null;
  let best = null;
  const all = ctx.sessions.size;
  for (const stats of propertyStats(ctx).values()) {
    if (stats.identifier_like || stats.values.length < 2) continue;
    const counts = new Map();
    for (const s of hit) {
      const v = propOf(s, stats.key);
      if (v != null) counts.set(v, (counts.get(v) || 0) + 1);
    }
    for (const [value, n] of counts) {
      const share = n / hit.length;
      const base = (stats.values.find((x) => x.value === value)?.sessions ?? 0) / all;
      if (n < 5 || share < 0.6 || share < base * 1.5) continue;
      if (!best || share > best.share || (share === best.share && n > best.sessions)) best = { key: stats.key, value, sessions: n, share, base };
    }
  }
  return best && { key: best.key, value: best.value, sessions: best.sessions, share_pct: pctOf(best.share), all_pct: pctOf(best.base) };
}

// Finding 14, one setting runs slow (perf-prop-<key>): for a property with 2 to 10 values, each with 20 or more sessions
// that drew frames, the value whose frame p95 is 1.5 times the rest's (and over the frame budget): "Frame time on the
// ultra preset is 41 ms for the slowest 5% of frames, against 18 ms on high". From the sessions' own frame windows.
const SETTING_VALUES = 10;
const SETTING_SESSIONS = 20;
export function slowSettings(ctx, budget, totalSessions) {
  if (ctx.daily) return [];
  const out = [];
  for (const stats of propertyStats(ctx).values()) {
    if (stats.identifier_like || stats.values.length < 2 || stats.values.length > SETTING_VALUES) continue;
    const groups = new Map();
    for (const s of ctx.sessions.values()) {
      const v = propOf(s, stats.key);
      if (v == null || !s.cell.fw) continue;
      const g = groups.get(v) ?? groups.set(v, { cell: newCell(), sessions: 0 }).get(v);
      mergeCell(g.cell, s.cell);
      g.sessions++;
    }
    const eligible = [...groups].filter(([, g]) => g.sessions >= SETTING_SESSIONS);
    if (eligible.length < 2) continue;
    let worst = null;
    for (const [value, g] of eligible) {
      const rest = newCell();
      for (const [other, h] of eligible) if (other !== value) mergeCell(rest, h.cell);
      const p95 = g.cell.ft.quantile(0.95);
      const others = rest.ft.quantile(0.95);
      if (p95 == null || others == null || p95 < others * 1.5 || p95 < budget * 1.15) continue;
      if (!worst || p95 / others > worst.p95 / worst.others) worst = { value, p95, others, sessions: g.sessions, best: eligible.filter(([v]) => v !== value).sort((a, b) => a[1].cell.ft.quantile(0.95) - b[1].cell.ft.quantile(0.95))[0] };
    }
    if (!worst) continue;
    const [bestValue, best] = worst.best;
    const ms = (v) => Math.round(v * 10) / 10;
    out.push({
      id: `perf-prop-${stats.key}`,
      severity: 'medium',
      category: 'performance',
      title: `Frame time on ${stats.key} ${worst.value} is ${ms(worst.p95)} ms for the slowest 5% of frames, against ${ms(worst.others)} ms on the rest`,
      summary: `${worst.sessions} sessions with ${stats.key} ${worst.value} spend their slowest 5% of frames over ${ms(worst.p95)} ms; the other values of ${stats.key} stay under ${ms(worst.others)} ms (${bestValue}: ${ms(best.cell.ft.quantile(0.95))} ms). The frame budget is ${ms(budget)} ms.`,
      evidence: { key: stats.key, value: worst.value, sessions: worst.sessions, frame_p95: ms(worst.p95), rest_frame_p95: ms(worst.others), values: eligible.map(([v, g]) => ({ value: v, sessions: g.sessions, frame_p95: ms(g.cell.ft.quantile(0.95)) })) },
      suggestion: `Find what ${stats.key} ${worst.value} turns on (effects, draw distance, shadows, resolution, a heavier mode) and profile a session with it: the Performance view's by_prop=${stats.key} shows frame time, hitches and crash-free sessions per value. Lower its cost, or pick it only on hardware that keeps up.`,
      link: { page: 'performance', by_prop: stats.key },
      impact: worst.sessions / (totalSessions || 1),
    });
  }
  return out;
}

// The sentence a finding adds for a lean.
export function leanLine(lean, what = 'the sessions it hit') {
  return lean ? ` Most of it falls on ${lean.key} ${lean.value}: ${lean.share_pct}% of ${what}, against ${lean.all_pct}% of all sessions.` : '';
}

function pctOf(x) {
  return Math.round(x * 1000) / 10;
}
