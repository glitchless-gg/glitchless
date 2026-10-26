// Events read with all their attributes at once, from the occurrences each session keeps of them (session-state.js:
// the first EV.occurrences of each event name, with its attributes and level). Rollup cells count each attribute on
// its own (rollups.js), so what needs two attributes together reads these instead:
//   - a list that must contain all of several values ("battle_end:deck=hog_rider+ice_spirit"): any pair or trio an
//     agent asks about, never counted ahead of time;
//   - a rate of a word outcome (result=win) split by another attribute, and a rate, average or sum of a filtered event
//     split by an attribute or a session split (rates.js);
//   - a distribution split by an attribute or a session split, or of a filtered event (distributions.js).
// Over 31 days or less they come from the range's sessions. That is exact while no session sent more of the event than
// it keeps; a session that sent more has its kept occurrences stand for all of its events (each weighs as many events
// as it stands for), and the answer says from how many sessions it was `estimated`. Over more than 31 days they come
// from the days' samples of sessions (daily.js), each weighted by its day's sampling rate, and meta.approximate names
// them.

import { matchAttrs, steamValue, sessionSplit, STEAM_DIMENSIONS } from './analytics.js';
import { approximate } from './daily.js';

// Each kept occurrence of the event `f.name` that matches `f`, as fn({ ts, attrs, level, w, s }): `w` is how many of
// the session's events it stands for, `s` the session (over more than 31 days, a day sample: { h, env, version }).
// → { estimated: how many sessions sent more of the event than they keep, sessions: how many sent it }
export function eachOccurrence(ctx, f, fn) {
  let estimated = 0;
  let sessions = 0;
  if (ctx.daily) {
    for (const { rate, list } of ctx.daily.samples) {
      for (const x of list) {
        const kept = x.o?.[f.name];
        if (!kept?.length) continue;
        sessions++;
        // Samples stored before their counts were kept stand for their kept occurrences only.
        const stands = standsFor(kept);
        const n = x.c?.[f.name] ?? stands;
        if (n > stands) estimated++;
        const w = n / stands / rate;
        for (const o of kept) if (matchAttrs(o[1], f)) fn({ ts: o[0], attrs: o[1], level: o[2] ?? null, zone: o[4] ?? null, w: w * (o[3] ?? 1), s: x });
      }
      approximate(ctx, 'event_occurrences', rate < 1);
    }
    approximate(ctx, 'event_occurrences', estimated > 0);
    return { estimated, sessions };
  }
  for (const s of ctx.sessions.values()) {
    const v = s.ev?.[f.name];
    if (!v?.o?.length) continue;
    sessions++;
    const stands = standsFor(v.o);
    if (v.n > stands) estimated++;
    const w = v.n / stands;
    for (const o of v.o) if (matchAttrs(o[1], f)) fn({ ts: o[0], attrs: o[1], level: o[2] ?? null, zone: o[4] ?? null, w: w * (o[3] ?? 1), s });
  }
  return { estimated, sessions };
}

// How many events kept occurrences stand for: one each, and a counter's its own count (session-state.js addCounted).
export function standsFor(kept) {
  let n = 0;
  for (const o of kept) n += o[3] ?? 1;
  return n;
}

// How many events match `f` (`field`: count, sessions or series), from the occurrences: what eventCount() answers for
// a filter the cells can't count.
export function occurrenceCount(ctx, f, field = 'count') {
  const series = new Array(ctx.buckets.length).fill(0);
  const sent = new Set();
  let count = 0;
  eachOccurrence(ctx, f, (o) => {
    count += o.w;
    series[bucketOf(ctx, o.ts)] += o.w;
    sent.add(o.s);
  });
  if (field === 'series') return series.map(Math.round);
  if (field === 'sessions') return sent.size;
  return Math.round(count);
}

// How many of one session's events match `f`, from its occurrences (weighted as eachOccurrence weighs them).
export function sessionOccurrenceCount(s, f) {
  const v = s.ev?.[f.name];
  if (!v?.o?.length) return 0;
  const w = v.n / standsFor(v.o);
  return v.o.reduce((n, o) => n + (matchAttrs(o[1], f) ? w * (o[3] ?? 1) : 0), 0);
}

// The groups an occurrence falls in, split `by` (as a board writes it): an attribute's value, or each element of a
// list; $version or $level; a session split ($platform, $browser, $device_tier), a property or a Steam fact. [] when it
// has none.
export function occurrenceGroups(by, ctx = null) {
  if (by == null) return () => [''];
  if (by === '$version') return (o) => [String(o.s.version ?? '(none)')];
  if (by === '$level') return (o) => [String(o.level ?? '(none)')];
  if (by === '$zone') return (o) => [String(o.zone ?? '(none)')];
  const name = by.slice(1);
  const split = by.startsWith('$') && ctx ? sessionSplit(ctx, name) : null;
  if (split) return (o) => [split.of(o.s)];
  if (by.startsWith('$') && STEAM_DIMENSIONS.includes(name)) return (o) => [steamValue(o.s, name) ?? '(none)'];
  return (o) => {
    const v = o.attrs[by];
    if (v == null) return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
  };
}

export function bucketOf(ctx, ts) {
  return Math.min(ctx.buckets.length - 1, Math.max(0, Math.floor((ts - ctx.buckets[0]) / ctx.bucketMs)));
}
