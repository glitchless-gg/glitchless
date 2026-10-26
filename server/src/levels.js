// Levels split by what describes each attempt (docs/design/genre-coverage.md A7; SPEC §3b levels `by`): clears and
// wipes by difficulty, tier, party size or a build (a level_start attribute), by a session property (rank, class) or a
// session split (platform), and runs counted once at each level they reached (`count: "runs"`, a roguelite's biomes).
//
// A level start keeps its attributes and its run (session-state.js marks `a` and `r`); the outcome, deaths and abandon
// after it belong to that attempt, since a session's marks are kept in order. So each session's marks are walked once
// per question, the same way the plain funnel (analytics.js funnel) walks them, and an attempt's rows are its values:
// one per element when the attribute is a list (a build with three skills counts under each), `(none)` without it.
// Abandons settle as the plain funnel settles them: at the next start of the level or the session's end, unless the
// level went on (the player came back from the background, or reconnected). Day rollups fold the same rows by the first
// three attributes of each level's starts (daily.js), so long ranges answer them too.

import { MARK } from './session-state.js';
import { FIXED } from './rollups.js';

export const NONE = '(none)';

// The values an attempt counts under, by `by`: an attribute of its start ('tier'), or a session split given as
// `session(s)` (a property, the platform). → (s, start mark) → [value]
export function attemptValues(by, session = null) {
  if (session) return (s) => [session(s)];
  return (s, start) => {
    const v = start?.a?.[by];
    if (v == null) return [NONE];
    return Array.isArray(v) ? (v.length ? v.map(String) : [NONE]) : [String(v)];
  };
}

// One session's attempts per (level, value): Map(`level\u0001value` → row). A row: { level, value, started, completed,
// at (attempts), co, fa, de, ab (abandons), ended (it completed, failed or died there), dr (attempts a disconnect
// ended), durations (completed attempts' duration_s), causes (deaths by cause), runs (the runs that started it) }.
export function sessionAttempts(s, valuesOf) {
  const rows = new Map();
  const row = (level, value) => {
    const key = `${level}\u0001${value}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { level, value, started: false, completed: false, at: 0, co: 0, fa: 0, de: 0, ab: 0, ended: false, dr: 0, durations: [], causes: {}, runs: new Set() }));
    return r;
  };
  const current = new Map(); // level → the values of its attempt in progress
  const pending = new Map(); // level → what ended an abandon not yet settled
  const settle = (level) => {
    if (!pending.has(level)) return;
    const why = pending.get(level);
    pending.delete(level);
    for (const v of current.get(level) || [NONE]) {
      const r = row(level, v);
      r.ab++;
      if (why === 'disconnect') r.dr++;
    }
  };
  for (const m of s.marks) {
    const { k: kind, level } = m;
    if (!level) continue;
    if (kind === MARK.abandon) {
      pending.set(level, m.why ?? null);
      continue;
    }
    if (kind === MARK.start) {
      settle(level);
      const values = [...new Set(valuesOf(s, m))];
      current.set(level, values);
      for (const v of values) {
        const r = row(level, v);
        r.started = true;
        r.at++;
        r.runs.add(m.r ?? s.session_id);
      }
      continue;
    }
    pending.delete(level);
    const values = current.get(level) || valuesOf(s, null);
    for (const v of values) {
      const r = row(level, v);
      r.ended = true;
      if (kind === MARK.complete) {
        r.completed = true;
        r.co++;
        if (typeof m.d === 'number' && Number.isFinite(m.d)) r.durations.push([m.ts, m.d]);
      } else if (kind === MARK.fail) r.fa++;
      else if (kind === MARK.death) {
        r.de++;
        r.causes[m.cause] = (r.causes[m.cause] || 0) + 1;
      }
    }
  }
  for (const level of [...pending.keys()]) settle(level);
  // A rage quit counts at the attempt it ended.
  if (s.rage_quit && s.rage?.level) for (const v of current.get(s.rage.level) || [NONE]) row(s.rage.level, v).rq = 1;
  return rows;
}

// The levels panel's rows by `by` (or `count: "runs"`), from the context's sessions: [{ level, value, sessions,
// players, completed, completion_pct, attempts, deaths, deaths_per_session, fails, abandons, abandoned, disconnects,
// avg_complete_s, p50_complete_s, p90_complete_s, death_causes, rage_quits, rage_quit_pct, runs? }], by level then the
// most sessions first. `level` keeps one level's rows. `quantile`: analytics.js quantile(), for the clear times.
export function levelsBy(ctx, { valuesOf, level = null, runs = false, quantile }) {
  const totals = new Map();
  for (const s of ctx.sessions.values()) {
    for (const r of sessionAttempts(s, valuesOf).values()) {
      if (level != null && r.level !== level) continue;
      const key = `${r.level}\u0001${r.value}`;
      let t = totals.get(key);
      if (!t) totals.set(key, (t = { level: r.level, value: r.value, ss: 0, sc: 0, players: new Set(), at: 0, co: 0, fa: 0, de: 0, ab: 0, lo: 0, dr: 0, durations: [], causes: {}, rq: 0, runs: new Set() }));
      if (r.started) {
        t.ss++;
        t.players.add(s.player_id);
      }
      if (r.completed) t.sc++;
      for (const k of ['at', 'co', 'fa', 'de', 'ab', 'dr']) t[k] += r[k];
      if (r.ab && !r.ended) t.lo++;
      if (r.rq) t.rq++;
      t.durations.push(...r.durations);
      for (const [c, n] of Object.entries(r.causes)) t.causes[c] = (t.causes[c] || 0) + n;
      for (const id of r.runs) t.runs.add(id);
    }
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return [...totals.values()]
    .map((t) => {
      const durations = t.durations.sort((a, b) => a[0] - b[0]).map(([, d]) => d);
      const base = runs ? t.runs.size : t.ss;
      return {
        level: t.level,
        value: t.value,
        sessions: t.ss,
        players: t.players.size,
        ...(runs ? { runs: t.runs.size } : {}),
        completed: t.sc,
        completion_pct: pct(t.sc, t.ss || 1),
        attempts: t.at,
        deaths: t.de,
        deaths_per_session: t.ss ? round(t.de / t.ss, 2) : null,
        fails: t.fa,
        abandons: t.ab,
        abandoned: t.lo,
        disconnects: t.dr,
        avg_complete_s: durations.length ? round(durations.reduce((a, d) => a + Math.round(d * FIXED.sec), 0) / FIXED.sec / durations.length, 1) : null,
        p50_complete_s: durations.length ? round(quantile(durations.map((d) => Math.round(d * 100) / 100), 0.5), 1) : null,
        p90_complete_s: durations.length ? round(quantile(durations.map((d) => Math.round(d * 100) / 100), 0.9), 1) : null,
        death_causes: t.causes,
        rage_quits: t.rq,
        rage_quit_pct: pct(t.rq, base || 1),
      };
    })
    .sort((a, b) => String(a.level).localeCompare(String(b.level), undefined, { numeric: true }) || b.sessions - a.sessions || String(a.value).localeCompare(String(b.value), undefined, { numeric: true }));
}

// Finding 10, a wall at one difficulty (design-wall-<level>-<attr>-<value>): the wall rule (SPEC §4) across one level's
// attempts split by an attribute of their starts. A value whose sessions get through 70% or less, 25 points under the
// median of the level's other values (each with WALL_SESSIONS or more sessions that played it to an end): "pit_80 is a
// wall for players alone". One finding per level and attribute, its worst value. Over 31 days or less.
const WALL_SESSIONS = 10;
export function attributeWalls(ctx, { quantile, totalSessions }) {
  if (ctx.daily) return [];
  const keys = new Map(); // level → attribute keys its starts carry
  for (const s of ctx.sessions.values()) {
    for (const m of s.marks) {
      if (m.k !== MARK.start || !m.level || !m.a) continue;
      if (!keys.has(m.level)) keys.set(m.level, new Set());
      for (const k of Object.keys(m.a)) if (keys.get(m.level).size < 6 || keys.get(m.level).has(k)) keys.get(m.level).add(k);
    }
  }
  const out = [];
  for (const [level, ks] of keys) {
    for (const attr of ks) {
      const rows = levelsBy(ctx, { valuesOf: attemptValues(attr), level, quantile })
        .filter((r) => r.value !== NONE)
        .map((r) => ({ ...r, decided: r.sessions - r.abandoned }))
        .filter((r) => r.decided >= WALL_SESSIONS)
        .map((r) => ({ ...r, through: Math.round((r.completed / r.decided) * 1000) / 10 }));
      if (rows.length < 2 || !rows.some((r) => r.completed)) continue;
      let worst = null;
      for (const r of rows) {
        if (r.through > 70) continue;
        const typical = quantile(rows.filter((o) => o !== r).map((o) => o.through), 0.5);
        if (typical == null || typical - r.through < 25) continue;
        if (!worst || typical - r.through > worst.gap) worst = { r, typical, gap: typical - r.through };
      }
      if (worst) {
        const { r, typical } = worst;
        out.push({
          id: `design-wall-${level}-${attr}-${r.value}`,
          severity: r.through < 50 ? 'high' : 'medium',
          category: 'design',
          title: `${level} with ${attr} ${r.value} is a wall: ${r.through}% of the sessions that play it get through, against ${typical}% with other ${attr} values`,
          summary: `${r.completed} of the ${r.decided} sessions that play ${level} with ${attr} ${r.value} to an end complete it. With the other values of ${attr}, a median of ${typical}% do.${r.abandoned ? ` ${r.abandoned} more left it before it ended and aren't counted.` : ''}${r.disconnects ? ` ${r.disconnects} attempts ended in a disconnect, which is never counted as a fail.` : ''}`,
          evidence: { level, attr, value: r.value, sessions: r.sessions, decided: r.decided, completed: r.completed, completion_pct: r.through, other_values_median_pct: typical, values: rows.map((o) => ({ value: o.value, sessions: o.decided, completion_pct: o.through })) },
          suggestion: `Play ${level} with ${attr} ${r.value} against its other values and list what steps up between them (enemy health and damage, timers, how many players it expects). Ease the biggest step, or let players work up to it, then compare the levels panel by ${attr} version by version.`,
          link: { page: 'players', level, by: attr },
          impact: r.sessions / (totalSessions || 1),
        });
      }
    }
  }
  return out;
}
