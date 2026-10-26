// Findings from the numbers a game put on its own boards (ctx.dashboard, the saved dashboard): nothing here knows a
// genre, it reads the rates, per-hour sums and distributions the game's agent chose to watch.
//
//   balance-<event>-<attr>-<value>   one value of a rate breakdown is out of line: 500 or more events, and an interval
//                                    that leaves out the overall rate ± 5 points ("ember wins 58% of 12,400 matches,
//                                    against 50%")
//   expect-<event>-<value>           a rate misses what the board expects of it (`expect`): the game's own stated
//                                    rate, such as published odds. It says what was measured, never more: the board
//                                    says what the rate should be, and the agent reads the rest
//   economy-<event>-<version>        a sum per hour played moved 50% or more between the last two versions, with the
//                                    value of the event's attributes that moved most
//   shift-<event>-<attr>             a distribution's median or p90 moved 30% or more between the last two versions
//   shift-<event>-<attr>-<key>-<value>  a distribution split by a session property (A6) where one value's p90 is twice
//                                    the rest's ("1 in 10 Diamond players waits over 6 minutes for a match")

import { cellsOf, eventIndex, parseFunnel, round, pct } from './analytics.js';
import { measureOf, measureBy, measureProblem, rateOf, hoursPlayed, perHour, misses } from './rates.js';
import { sumsBy, gameCurrency, versionContext } from './sums.js';
import { distributionOf, listSummary } from './distributions.js';
import { eachOccurrence, occurrenceGroups } from './occurrences.js';
import { propertyKey } from './properties.js';

const BALANCE_EVENTS = 500;
const BALANCE_POINTS = 5;
const EXPECT_EVENTS = 30;
const ECONOMY_MOVE = 0.5;
const ECONOMY_HOURS = 1;
const ECONOMY_EVENTS = 30;
const SHIFT_MOVE = 0.3;
const SHIFT_VALUES = 30;

// `vers`: the range's versions in release order (analytics.js versions()), with their sessions.
export function boardFindings(ctx, vers, totalSessions) {
  const pages = (ctx.dashboard?.pages || []).filter((p) => p.panels);
  if (!pages.length) return [];
  const out = [];
  const seen = new Set();
  const push = (f) => {
    if (!f || seen.has(f.id)) return;
    seen.add(f.id);
    out.push(f);
  };
  const panels = pages.flatMap((page) => page.panels.map((p) => ({ p, page: page.id })));
  for (const { p, page } of panels) {
    if (!p.rate || !p.event) continue;
    const [f] = parseFunnel(p.event);
    const m = measureOf(p);
    if (!eventIndex(ctx).has(f.name) || measureProblem(ctx, f, m)) continue;
    if (p.type === 'breakdown') for (const x of rateRows(ctx, p, f, m)) push(x(page, totalSessions));
    else if (p.type === 'stat' && p.expect != null) {
      const { num, den } = measureBy(ctx, f, m, null).overall;
      const r = rateOf(num, den);
      if (den >= EXPECT_EVENTS && misses(r, p.expect)) push(expectFinding({ p, f, row: { value: null, events: Math.round(den), ...r }, overall: r.rate, page, impact: 1 }));
    }
  }
  for (const { p, page } of panels) if (p.type === 'distribution' && p.of && p.event && propertyKey(p.by) && !ctx.daily) for (const x of groupShift(ctx, p, page, totalSessions)) push(x);
  const [prev, cur] = vers.slice(-2);
  if (prev && cur) {
    for (const { p, page } of panels) if (p.sum && p.per === '$hours' && p.event) push(economy(ctx, p, page, prev, cur, totalSessions));
    for (const { p, page } of panels) if (p.of && p.event && (p.type === 'distribution' || p.type === 'stat')) push(shift(ctx, p, page, prev, cur, totalSessions));
  }
  return out;
}

// The rows of a rate breakdown out of line with the overall rate, or with what the board expects: each a finding maker.
function rateRows(ctx, p, f, m) {
  const r = measureBy(ctx, f, m, p.by);
  const overall = rateOf(r.overall.num, r.overall.den).rate;
  if (overall == null) return [];
  const makers = [];
  for (const [value, g] of r.groups) {
    const row = { value, events: Math.round(g.den), sessions: g.sessions ?? null, ...rateOf(g.num, g.den) };
    const impact = r.overall.den ? g.den / r.overall.den : 0;
    if (p.expect != null) {
      if (row.events >= (p.min ?? EXPECT_EVENTS) && misses(row, p.expect)) makers.push((page) => expectFinding({ p, f, row, overall, page, impact }));
    } else if (row.events >= BALANCE_EVENTS && (row.low > overall + BALANCE_POINTS || row.high < overall - BALANCE_POINTS)) {
      makers.push((page) => balanceFinding({ p, f, m, row, overall, page, impact, estimated: r.estimated }));
    }
  }
  return makers;
}

function rateWords(p) {
  return p.rate.includes('=') ? p.rate.replace('=', ' is ') : p.rate;
}

function balanceFinding({ p, f, m, row, overall, page, impact, estimated }) {
  const above = row.rate > overall;
  return {
    id: `balance-${f.name}-${p.by}-${row.value}`,
    severity: 'medium',
    category: 'design',
    title: `${p.by} ${row.value}: ${rateWords(p)} in ${row.rate}% of ${row.events.toLocaleString('en-US')} ${f.name} events, against ${overall}% for all`,
    summary:
      `Of the ${f.name} events with ${p.by} ${row.value}, ${row.rate}% have ${rateWords(p)} (95% interval ${row.low}–${row.high}%), ${above ? 'above' : 'below'} the ${overall}% of every ${p.by}. ` +
      `The gap is wider than ${BALANCE_POINTS} points either way, so it isn't chance.${estimated ? ` Part of it is estimated: ${estimated} sessions sent more of these events than Glitchless keeps the attributes of.` : ''}`,
    evidence: { event: p.event, rate: p.rate, by: p.by, value: row.value, rate_pct: row.rate, low: row.low, high: row.high, events: row.events, sessions: row.sessions, overall_pct: overall, panel: p.title ?? null, measure: m.kind },
    suggestion: `Check what sets ${row.value} apart (its numbers, what it unlocks, who picks it: a filter by version or mode shows whether it holds everywhere), change it if it's out of line, then compare this rate version by version.`,
    link: { page },
    impact,
  };
}

function expectFinding({ p, f, row, overall, page, impact }) {
  const what = row.value == null ? `${f.name} events` : `${f.name} events with ${p.by} ${row.value}`;
  return {
    id: `expect-${f.name}-${row.value ?? 'all'}`,
    severity: 'medium',
    category: 'design',
    title: `${row.value == null ? f.name : `${p.by} ${row.value}`}: ${rateWords(p)} in ${row.rate}% of ${row.events.toLocaleString('en-US')} events; the board expects ${p.expect}%`,
    summary: `Of the ${what}, ${row.rate}% have ${rateWords(p)} (95% interval ${row.low}–${row.high}%${row.value == null ? '' : `; every ${p.by}: ${overall}%`}). The board says ${p.expect}% is intended, and the interval leaves it out.`,
    evidence: { event: p.event, rate: p.rate, by: p.by ?? null, value: row.value, rate_pct: row.rate, low: row.low, high: row.high, events: row.events, expect_pct: p.expect, overall_pct: overall, panel: p.title ?? null },
    suggestion: `Check the code that decides ${rateWords(p)} against the ${p.expect}% the board expects (the odds table, its weights, any pity or streak rule), and how the event is sent: a ${f.name} sent twice or only on some paths skews the rate.`,
    link: { page },
    impact,
  };
}

// The per-hour sum of the version's own events over its own hours, and per value of each of the event's string
// attributes.
function versionHours(ctx, p, f, v) {
  const sub = versionContext(ctx, v.version, cellsOf(ctx).filter(({ c }) => String(c.version) === String(v.version)).map(({ c }) => c));
  const hours = hoursPlayed(sub);
  const currency = gameCurrency(ctx, p.currency ?? ctx.dashboard?.currency ?? null);
  const s = sumsBy(sub, f, p.sum, { currency });
  const g = s.groups.get('');
  return { sub, hours, events: g?.events ?? 0, per: perHour(g?.sum ?? 0, hours), currency };
}

function economy(ctx, p, page, prev, cur, totalSessions) {
  const [f] = parseFunnel(p.event);
  if (f.all || !eventIndex(ctx).get(f.name)?.attrs.has(p.sum)) return null;
  const a = versionHours(ctx, p, f, prev);
  const b = versionHours(ctx, p, f, cur);
  if (a.hours < ECONOMY_HOURS || b.hours < ECONOMY_HOURS || a.events < ECONOMY_EVENTS || b.events < ECONOMY_EVENTS || !a.per || b.per == null) return null;
  const move = (b.per - a.per) / a.per;
  if (Math.abs(move) < ECONOMY_MOVE) return null;
  // The value that moved most, in amount per hour: what the change mostly came from.
  let lead = null;
  if (f.value == null) {
    for (const attr of eventIndex(ctx).get(f.name).attrs.values()) {
      if (attr.list || attr.n || attr.key === p.sum || attr.key === 'currency') continue;
      const before = sumsBy(a.sub, f, p.sum, { split: attr.key, currency: a.currency }).groups;
      const after = sumsBy(b.sub, f, p.sum, { split: attr.key, currency: b.currency }).groups;
      for (const value of new Set([...before.keys(), ...after.keys()])) {
        const x = (before.get(value)?.sum ?? 0) / a.hours;
        const y = (after.get(value)?.sum ?? 0) / b.hours;
        if (!lead || Math.abs(y - x) > Math.abs(lead.to - lead.from)) lead = { attr: attr.key, value, from: round(x, 2), to: round(y, 2) };
      }
    }
  }
  const times = (x, y) => (x ? `${round(y / x, 1)}×` : 'from none');
  const up = move > 0;
  const name = p.title || `${p.event} ${p.sum} per hour played`;
  const from = lead && Math.sign(lead.to - lead.from) === Math.sign(move) ? `, most of it from ${lead.attr} ${lead.value} (${times(lead.from, lead.to)})` : '';
  return {
    id: `economy-${f.name}-${cur.version}`,
    severity: 'medium',
    category: 'design',
    title: `${name} went ${up ? 'up' : 'down'} ${up ? times(a.per, b.per) : `to ${Math.round((b.per / a.per) * 100)}%`} in ${cur.version}${from}`,
    summary: `${round(b.per, 2).toLocaleString('en-US')} per hour played in ${cur.version} (${round(b.hours, 1)} hours played), against ${round(a.per, 2).toLocaleString('en-US')} in ${prev.version} (${round(a.hours, 1)} hours).`,
    evidence: { event: p.event, sum: p.sum, previous: { version: prev.version, per_hour: a.per, hours: round(a.hours, 2), events: a.events }, current: { version: cur.version, per_hour: b.per, hours: round(b.hours, 2), events: b.events }, change_pct: pct(b.per - a.per, a.per), ...(lead ? { most_moved: lead } : {}), panel: p.title ?? null },
    suggestion: `Diff ${prev.version}..${cur.version} for changes to what gives or costs ${p.sum}${lead ? ` (start with ${lead.attr} ${lead.value})` : ''}: drop rates, prices, rewards. If it was meant, the board's per-hour number is the new baseline; if not, it inflates every price after it.`,
    link: { page },
    impact: cur.sessions / (totalSessions || 1),
  };
}

function shift(ctx, p, page, prev, cur, totalSessions) {
  const [f] = parseFunnel(p.event);
  const of = (v) => distributionOf(versionContext(ctx, v.version, cellsOf(ctx).filter(({ c }) => String(c.version) === String(v.version)).map(({ c }) => c)), f, p.of, { bins: 0 })?.total;
  const a = of(prev);
  const b = of(cur);
  if (!a || !b || a.count < SHIFT_VALUES || b.count < SHIFT_VALUES) return null;
  const moved = (x, y) => (x ? (y - x) / Math.abs(x) : 0);
  const m50 = moved(a.p50, b.p50);
  const m90 = moved(a.p90, b.p90);
  if (Math.max(Math.abs(m50), Math.abs(m90)) < SHIFT_MOVE) return null;
  const up = (Math.abs(m50) >= Math.abs(m90) ? m50 : m90) > 0;
  const say = (v) => inUnit(v, p.unit);
  return {
    id: `shift-${f.name}-${p.of}`,
    severity: 'medium',
    category: 'design',
    title: `${p.title || `${p.event} ${p.of}`} went ${up ? 'up' : 'down'} in ${cur.version}: half under ${say(b.p50)}, against ${say(a.p50)} in ${prev.version}`,
    summary: `In ${cur.version}, half of the ${b.count.toLocaleString('en-US')} values of ${p.of} are under ${say(b.p50)} and 1 in 10 over ${say(b.p90)}. In ${prev.version}: ${say(a.p50)} and ${say(a.p90)}, from ${a.count.toLocaleString('en-US')}.`,
    evidence: { event: p.event, of: p.of, previous: { version: prev.version, count: a.count, p50: a.p50, p90: a.p90 }, current: { version: cur.version, count: b.count, p50: b.p50, p90: b.p90 }, p50_change_pct: round(m50 * 100, 1), p90_change_pct: round(m90 * 100, 1), panel: p.title ?? null },
    suggestion: `Diff ${prev.version}..${cur.version} for what changes ${p.of} (its timers, rules, matchmaking or difficulty). If the shift was meant, it's the new normal; if not, the distribution panel split by $version shows where it moved.`,
    link: { page },
    impact: cur.sessions / (totalSessions || 1),
  };
}

// Finding 12's other half: in a distribution split by a session property, a value whose p90 is twice the rest's p90,
// each side with SHIFT_VALUES values or more. From the sessions' occurrences, as the panel reads them.
function groupShift(ctx, p, page, totalSessions) {
  const [f] = parseFunnel(p.event);
  const groupsOf = occurrenceGroups(p.by, ctx);
  const values = new Map();
  eachOccurrence(ctx, f, (o) => {
    const v = o.attrs[p.of];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    for (const g of groupsOf(o)) (values.get(g) ?? values.set(g, []).get(g)).push([v, o.w]);
  });
  const out = [];
  const key = p.by.slice(1);
  for (const [value, list] of values) {
    if (value === '(none)' || value === '(other)' || value === '(too many values)') continue;
    const rest = [...values].filter(([v]) => v !== value).flatMap(([, l]) => l);
    if (list.length < SHIFT_VALUES || rest.length < SHIFT_VALUES) continue;
    const a = listSummary(list, 0);
    const b = listSummary(rest, 0);
    if (!b.p90 || a.p90 < b.p90 * 2) continue;
    const say = (v) => inUnit(v, p.unit);
    out.push({
      id: `shift-${f.name}-${p.of}-${key}-${value}`,
      severity: 'medium',
      category: 'design',
      title: `${p.title || `${p.event} ${p.of}`}: 1 in 10 with ${key} ${value} is over ${say(a.p90)}, against ${say(b.p90)} for the rest`,
      summary: `Of the ${a.count.toLocaleString('en-US')} values of ${p.of} from sessions with ${key} ${value}, half are under ${say(a.p50)} and 1 in 10 over ${say(a.p90)}. For every other ${key}: ${say(b.p50)} and ${say(b.p90)}, from ${b.count.toLocaleString('en-US')}.`,
      evidence: { event: p.event, of: p.of, by: p.by, value, group: { count: a.count, p50: a.p50, p90: a.p90 }, rest: { count: b.count, p50: b.p50, p90: b.p90 }, panel: p.title ?? null },
      suggestion: `Check what ${key} ${value} changes about ${p.of} (matchmaking pools, difficulty, content): the distribution panel split by ${p.by} shows where it spreads.`,
      link: { page },
      impact: list.length / (list.length + rest.length),
    });
  }
  return out;
}

// A number in a panel's unit, in words: seconds as minutes or hours (14 minutes, 2.5 hours), else the game's word after it.
function inUnit(v, unit) {
  if (unit === 's') return v >= 5400 ? `${round(v / 3600, 1)} hours` : v >= 90 ? `${Math.round(v / 60)} minutes` : `${v} seconds`;
  return unit ? `${v.toLocaleString('en-US')} ${unit}` : v.toLocaleString('en-US');
}
