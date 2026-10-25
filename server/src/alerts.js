// Alerts: tells a game's developers when something got worse for real players, by enough to act on today, in
// Discord, Slack or email. Each says it in one plain sentence, with the number of players next to what's normal, one
// line on what to do and a line to paste into their coding agent; measurements (frame times, rates, finding ids) go
// only in a small "For your agent" part. The rules (ALERT_RULES):
//   crashes    more players crash in the last 6 hours than usual for those hours
//   new_error  a new error is spreading
//   release    the newest version stutters or crashes for more players than the one before
//   quiet      the game went quiet (and a short note when sessions are back)
//   store      a store limit that cuts the game's visibility: Google Play's bad-behaviour thresholds
//   plan       the plan's play sessions for the month (Glitchless Cloud only, which knows the plan)
// Standing problems (findings) aren't alerts: a weekly summary lists the few worth fixing (weeklySummary,
// weeklyMessage). The rules, the check, the messages and their Discord and Slack formats are here; where settings and
// state live and how a message is sent, email included, is the host's (Glitchless Cloud keeps them per game; a
// self-hosted server uses GLITCHLESS_ALERT_WEBHOOK).
//
// A check reads the last day of one service. Every rule counts real players: bot sessions (autoplay, playtests,
// simulated players) are left out, and a game that sends no player IDs is counted in sessions, which every message
// then says. What's usual comes from an hour-by-hour profile of the last week the check keeps in its state (read once,
// then kept up to date by the day it reads anyway). Each rule gives signals with a stable key. A signal fires when it
// starts to hold and its key isn't active: the key is claimed with a conditional write, so it fires once however
// many checks run. It stays active while the signal holds at a lower bar, and clears only after it has not held for
// a day, so an alert never flaps. SPEC §3e has every number.
import { buildContext, errorList, versions, cellsOf, playersAreSessions, round } from './analytics.js';
import { findings } from './findings.js';
import { seconds } from './rollups.js';
import { sumsBy } from './sums.js';
import { reportsOf } from './reports.js';
import { DEFAULT_PROJECT } from './auth.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ALERT_RULES = ['crashes', 'new_error', 'release', 'quiet', 'store', 'plan'];
// What a game gets when it turns alerts on. Every number here is in SPEC §3e.
export const ALERT_DEFAULTS = { rules: Object.fromEntries(ALERT_RULES.map((r) => [r, true])), weekly: true };
export const LIMITS = {
  // crashes: crashMin players crash in the window, at crashTimes the usual share for the same hours of the last
  // week (from crashUsualMin players at least), and unlikely by chance (Poisson, p ≤ 0.01). It holds at crashHoldTimes.
  crashWindowMs: 6 * HOUR,
  crashMin: 5,
  crashTimes: 3,
  crashUsualMin: 20,
  crashHoldMin: 3,
  crashHoldTimes: 2,
  // new_error: first seen within newForMs, and it reached spreadPlayers or spreadPct of sessions (from spreadPctMin)
  newForMs: DAY,
  spreadPlayers: 10,
  spreadPct: 5,
  spreadPctMin: 3,
  // release: the two newest versions with releaseUnits players each. A session stutters when it has stutterPerMin
  // hitches (frames over 50 ms) a minute over stutterMinSec of frames at least. Worse is a one-sided two-proportion
  // z of releaseZ (p < 0.01), releaseTimes the share, and stutterPoints (crashPoints) percentage points more.
  releaseUnits: 20,
  stutterPerMin: 2,
  stutterMinSec: 60,
  stutterHitchesMin: 3,
  releaseZ: 2.33,
  releaseTimes: 1.5,
  stutterPoints: 5,
  crashPoints: 2,
  releaseHoldZ: 1,
  releaseHoldTimes: 1.2,
  // quiet: fewer than quietShare of the usual sessions in quietMs, when those hours usually have quietUsual an hour
  // (over usualDaysMin days at least). Back once the last hour has backShare of its usual.
  quietMs: 3 * HOUR,
  quietShare: 0.1,
  quietUsual: 10,
  backShare: 0.5,
  usualDays: 7,
  usualDaysMin: 3,
  // store: Google Play's bad-behaviour thresholds, its 28-day user-perceived rates (developer.android.com/topic/performance/vitals)
  playCrashPct: 1.09,
  playAnrPct: 0.47,
  playHold: 0.9,
  profileDays: 8, // hours kept in the profile, and read at once when it's missing or stale
  profileStaleMs: 20 * HOUR, // the day each check reads refreshes the last 24 hours; a profile older than this is read again
  seedDays: 7, // errors read once per service, so errors from before alerts were on aren't new
  clearAfterMs: DAY, // a key that hasn't held for this long clears, and can fire again
  touchMs: HOUR, // how often a held key's heldAt is written
  perCheck: 5, // alerts one check sends for one service at most; the rest wait for the next check
  seenKeepMs: 30 * DAY, // error fingerprints not seen for this long are forgotten
  seenMax: 2000,
  versionsMax: 50,
};
// The check's state for a service is from these rules: older state is a new baseline (see checkService).
export const STATE_VERSION = 2;
const PRIORITY = ['crashes', 'new_error', 'release', 'quiet', 'store', 'quiet_back'];
const BOTS = new Set(['synthetic', 'simulated']);

// Saved rules → the rules now. Settings saved before these rules name new_error, crash_free, frame_p95 and finding:
// crash_free becomes crashes, crash_free or frame_p95 becomes release (a release that crashes or stutters more), and
// finding (standing problems) is the weekly summary's now. Rules that are new start on.
export function alertRules(saved = {}) {
  const r = saved && typeof saved === 'object' ? saved : {};
  const was = (k) => (typeof r[k] === 'boolean' ? r[k] : undefined);
  const release = was('crash_free') === undefined && was('frame_p95') === undefined ? undefined : Boolean(was('crash_free') || was('frame_p95'));
  const out = {};
  for (const rule of ALERT_RULES) out[rule] = was(rule) ?? (rule === 'crashes' ? was('crash_free') : rule === 'release' ? release : undefined) ?? ALERT_DEFAULTS.rules[rule];
  return out;
}

// The context the rules read: what query `name` gets from app.js, with no drill-downs.
export async function contextFor(store, projectId, q) {
  const query = { service: q.service, from: q.from, to: q.to, env: q.env || null, version: null, type: 'all', sessions: null, plan: q.plan ?? null };
  let ctx;
  if (store.context) ctx = await store.context(projectId, query, 'alerts');
  else ctx = buildContext(await store.query(projectId, query), query, await store.rollups(projectId, query));
  ctx.reports = store.reports ? reportsOf(await store.reports(projectId, q.service, { from: q.from, to: q.to }), ctx) : [];
  return ctx;
}

// ── what a check measures ──

const realSessions = (ctx) => [...ctx.sessions.values()].filter((s) => !BOTS.has(s.session_type));
const who = (s) => s.player_id ?? s.session_id;

// A session stutters when it has LIMITS.stutterPerMin hitches a minute over a minute of frames or more.
export function stutters(s) {
  const sec = s.cell ? seconds(s.cell) : 0;
  return sec >= LIMITS.stutterMinSec && s.hitches >= LIMITS.stutterHitchesMin && s.hitches / (sec / 60) >= LIMITS.stutterPerMin;
}

// Whole hours in [lo, hi), by the hour each session started in: { [hour index]: [sessions, players, players who
// crashed] }. A session that started before the range (no session_start in it) isn't counted.
export function hourCounts(sessions, lo, hi) {
  const sets = new Map();
  for (let h = Math.ceil(lo / HOUR); h < Math.floor(hi / HOUR); h++) sets.set(h, [0, new Set(), new Set()]);
  for (const s of sessions) {
    if (s.start == null) continue;
    const c = sets.get(Math.floor(s.start / HOUR));
    if (!c) continue;
    c[0]++;
    c[1].add(who(s));
    if (s.crashed) c[2].add(who(s));
  }
  return Object.fromEntries([...sets].map(([h, [n, p, k]]) => [h, [n, p.size, k.size]]));
}

// Players who started a session in [lo, hi), those who crashed, and those by version.
function playersIn(sessions, lo, hi) {
  const all = new Set();
  const crashed = new Set();
  const byVersion = new Map();
  let n = 0;
  for (const s of sessions) {
    if (s.start == null || s.start < lo || s.start >= hi) continue;
    n++;
    all.add(who(s));
    if (!s.crashed) continue;
    crashed.add(who(s));
    if (!byVersion.has(s.version)) byVersion.set(s.version, new Set());
    byVersion.get(s.version).add(who(s));
  }
  return { sessions: n, total: all.size, crashed: crashed.size, byVersion: Object.fromEntries([...byVersion].map(([v, set]) => [v, set.size])) };
}

// The two newest versions with a few sessions (as the version finding picks them), each counted in players: those
// who stuttered, those who crashed; and the level whose hitches a minute rose the most between them.
export function releaseStats(ctx, real = realSessions(ctx), vers = versions(ctx)) {
  const recent = vers.filter((v) => v.sessions >= 5);
  if (recent.length < 2) return null;
  const [a, b] = recent.slice(-2).map((v) => v.version);
  const of = (version) => {
    const units = new Set();
    const stutter = new Set();
    const crashed = new Set();
    for (const s of real) {
      if (s.version !== version) continue;
      units.add(who(s));
      if (stutters(s)) stutter.add(who(s));
      if (s.crashed) crashed.add(who(s));
    }
    return { version, units: units.size, stutter: stutter.size, crashed: crashed.size };
  };
  const levels = new Map();
  for (const { c } of cellsOf(ctx)) {
    if (!c.level || c.level === '(menu)' || (c.version !== a && c.version !== b)) continue;
    if (!levels.has(c.level)) levels.set(c.level, { [a]: [0, 0], [b]: [0, 0] });
    const x = levels.get(c.level)[c.version];
    x[0] += c.hitches;
    x[1] += seconds(c);
  }
  let level = null;
  for (const [name, by] of levels) {
    if (by[a][1] < 120 || by[b][1] < 120) continue; // two minutes of frames on each
    const [before, after] = [by[a][0] / (by[a][1] / 60), by[b][0] / (by[b][1] / 60)];
    if (after - before >= 0.5 && (!level || after - before > level.after - level.before)) level = { name, before: round(before, 2), after: round(after, 2) };
  }
  return { prev: of(a), cur: of(b), level };
}

// What the rules read about one service: its last day, and (seed) its last LIMITS.profileDays for the profile of
// what's usual, (history) with the errors of its last LIMITS.seedDays.
export async function measure(store, projectId, { service, env = null, plan = null, now, seed = false, history = false }) {
  const q = { service, env, plan };
  const ctx = await contextFor(store, projectId, { ...q, from: now - DAY, to: now });
  const long = seed || history ? await contextFor(store, projectId, { ...q, from: now - LIMITS.profileDays * DAY, to: now }) : null;
  const to = Math.min(now, (ctx.to ?? now) + 1); // summaries are complete up to here
  const real = realSessions(ctx);
  const longReal = long ? realSessions(long) : [];
  const versionsSeen = {};
  for (const s of [...longReal, ...real]) if (s.start != null && s.version != null && !(versionsSeen[s.version] <= s.start)) versionsSeen[s.version] = s.start;
  const hourly = (fn) => Array.from({ length: 24 }, (_, i) => fn(to - (24 - i) * HOUR, to - (23 - i) * HOUR));
  const window = playersIn(real, now - LIMITS.crashWindowMs, to);
  return {
    to,
    units: playersAreSessions(real.length || !long ? ctx : long) ? 'sessions' : 'players',
    history: history ? errorList(await contextFor(store, projectId, { ...q, from: now - LIMITS.seedDays * DAY, to: now })) : null,
    errors: errorList(ctx),
    hours: { ...(long ? hourCounts(longReal, long.from, to) : {}), ...hourCounts(real, ctx.from, to) },
    versionsSeen,
    recent: {
      crash: window,
      quiet: { sessions: playersIn(real, to - LIMITS.quietMs, to).sessions, lastHour: playersIn(real, to - HOUR, to).sessions, lastStart: Math.max(0, ...[...real, ...longReal].map((s) => s.start ?? 0)) || null },
    },
    release: releaseStats(ctx, real, versions(ctx)),
    series: { crashed: hourly((lo, hi) => playersIn(real, lo, hi).crashed), sessions: hourly((lo, hi) => playersIn(real, lo, hi).sessions) },
  };
}

// ── the rules ──

// The same hours [lo, hi) on each of the last LIMITS.usualDays days, from the profile: the days it covers fully, and
// their sums of [sessions, players, crashed] and how many hours that is.
function sameHours(hours, lo, hi) {
  const sums = [0, 0, 0];
  let days = 0;
  let n = 0;
  for (let k = 1; k <= LIMITS.usualDays; k++) {
    const from = Math.floor((lo - k * DAY) / HOUR);
    const until = Math.max(from + 1, Math.floor((hi - k * DAY) / HOUR));
    const rows = [];
    for (let h = from; h < until; h++) rows.push(hours[h]);
    if (rows.some((r) => !r)) continue;
    days++;
    n += rows.length;
    for (const r of rows) r.forEach((v, i) => (sums[i] += v));
  }
  return { days, hours: n, sums };
}

// Players who crashed a day over the profile's whole days before `hi`, or null with less than a day of it.
function crashesPerDay(hours, lo, hi) {
  let sum = 0;
  let n = 0;
  for (let h = Math.ceil(lo / HOUR); h < Math.floor(hi / HOUR); h++) {
    if (!hours[h]) continue;
    sum += hours[h][2];
    n++;
  }
  return n >= 24 ? sum / (n / 24) : null;
}

// P(X ≥ k) for X ~ Poisson(λ): exact while λ is small, else the normal approximation.
export function poissonTail(k, lambda) {
  if (k <= 0) return 1;
  if (lambda <= 0) return 0;
  if (lambda > 30) return 1 - phi((k - 0.5 - lambda) / Math.sqrt(lambda));
  let term = Math.exp(-lambda);
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += term;
    term *= lambda / (i + 1);
  }
  return Math.max(0, 1 - below);
}

function phi(z) {
  // Abramowitz and Stegun 7.1.26, through erf.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// One-sided two-proportion z for "b's share is higher than a's".
export function zHigher(ka, na, kb, nb) {
  if (!na || !nb) return 0;
  const p = (ka + kb) / (na + nb);
  const se = Math.sqrt(p * (1 - p) * (1 / na + 1 / nb));
  return se ? round((kb / nb - ka / na) / se, 2) : 0;
}

// The rules, on what one check measured. Pure: everything it knows comes in.
//   errors, history, units, hours, recent, release, series, to   measure()'s (hours: the whole profile, kept by checkService)
//   versionsSeen                  { version: first session start }
//   play                          Google Play's 28-day user-perceived rates: { crash: { rate, day, users }, anr } or null
//   seen                          { fingerprint: [first, last] } from earlier checks (null on the first)
//   active                        Map key → { firedAt, heldAt } of keys that fired and haven't cleared
//   settings                      { rules }; enabledAt (ms) when alerts were turned on
// → { signals: [{ key, rule, holds, ...data }], seen }, one signal per key, the most urgent first.
export function evaluate({ now, to = now, units = 'players', errors = [], history = null, hours = {}, versionsSeen = {}, recent = null, release = null, series = null, play = null, seen = null, active = new Map(), settings = {}, enabledAt = 0 }) {
  const rules = alertRules(settings.rules);
  const next = new Map(Object.entries(seen || {}));
  // An error without a fingerprint (an SDK sends one with each error) can't be told apart from the next.
  errors = errors.filter((i) => i.fingerprint);
  for (const i of [...(history || []).filter((h) => h.fingerprint), ...errors]) {
    const was = next.get(i.fingerprint);
    next.set(i.fingerprint, [Math.min(was?.[0] ?? Infinity, i.first_seen), Math.max(was?.[1] ?? 0, i.last_seen ?? i.first_seen)]);
  }
  const signals = [];

  if (rules.crashes && recent?.crash) {
    const key = 'crashes';
    const cur = recent.crash;
    const usual = sameHours(hours, now - LIMITS.crashWindowMs, now);
    const [players, crashed] = [usual.sums[1], usual.sums[2]];
    const usualShare = players >= LIMITS.crashUsualMin ? crashed / players : null;
    const share = cur.total ? cur.crashed / cur.total : 0;
    const p = usualShare == null ? 1 : poissonTail(cur.crashed, usualShare * cur.total);
    const holds = usualShare != null && (active.has(key) ? cur.crashed >= LIMITS.crashHoldMin && share >= LIMITS.crashHoldTimes * usualShare : cur.crashed >= LIMITS.crashMin && share >= LIMITS.crashTimes * usualShare && p <= 0.01);
    const [version, onIt] = Object.entries(cur.byVersion ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const mostly = version != null && onIt >= 0.6 * cur.crashed;
    signals.push({
      key,
      rule: 'crashes',
      holds,
      units,
      crashed: cur.crashed,
      total: cur.total,
      share,
      usualShare,
      usualPlayers: players,
      usualDays: usual.days,
      perDay: crashesPerDay(hours, now - LIMITS.usualDays * DAY, now - LIMITS.crashWindowMs),
      p: round(p, 4),
      version: mostly ? version : null,
      onVersion: mostly ? onIt : null,
      startedWith: mostly && versionsSeen[version] >= now - LIMITS.usualDays * DAY,
      series: series?.crashed ?? null,
    });
  }

  if (rules.new_error) {
    for (const issue of errors) {
      const key = `error-${issue.fingerprint}`;
      const first = next.get(issue.fingerprint)[0];
      const fresh = first >= enabledAt && now - first <= LIMITS.newForMs;
      const players = issue.players ?? issue.sessions;
      const spread = players >= LIMITS.spreadPlayers || (issue.sessions_pct >= LIMITS.spreadPct && issue.sessions >= LIMITS.spreadPctMin);
      signals.push({ key, rule: 'new_error', finding: key, holds: active.has(key) || (fresh && spread), issue, first, units, players });
    }
  }

  if (rules.release && release) {
    const { prev, cur } = release;
    const key = `release-${prev.version}-${cur.version}`;
    const enough = prev.units >= LIMITS.releaseUnits && cur.units >= LIMITS.releaseUnits;
    const held = active.has(key);
    const worse = [];
    for (const [measure, points] of [
      ['crashed', LIMITS.crashPoints],
      ['stutter', LIMITS.stutterPoints],
    ]) {
      const [p0, p1] = [prev[measure] / (prev.units || 1), cur[measure] / (cur.units || 1)];
      const z = zHigher(prev[measure], prev.units, cur[measure], cur.units);
      const ok = held ? z >= LIMITS.releaseHoldZ && p1 > p0 && p1 >= LIMITS.releaseHoldTimes * p0 : z >= LIMITS.releaseZ && p1 >= LIMITS.releaseTimes * p0 && (p1 - p0) * 100 >= points;
      if (enough && ok) worse.push({ measure, p0, p1, z });
    }
    signals.push({ key, rule: 'release', finding: `version-${prev.version}-${cur.version}`, holds: worse.length > 0, prev, cur, worse, level: release.level, units });
  }

  if (rules.quiet && recent?.quiet) {
    const key = 'quiet';
    const usual = sameHours(hours, to - LIMITS.quietMs, to);
    const perHour = usual.days >= LIMITS.usualDaysMin ? usual.sums[0] / usual.hours : null;
    const last = sameHours(hours, to - HOUR, to);
    const lastPerHour = last.days >= LIMITS.usualDaysMin ? last.sums[0] / last.hours : null;
    const enter = perHour >= LIMITS.quietUsual && recent.quiet.sessions < LIMITS.quietShare * perHour * (LIMITS.quietMs / HOUR);
    const back = active.has(key) && lastPerHour != null && recent.quiet.lastHour >= Math.max(1, LIMITS.backShare * lastPerHour);
    signals.push({ key, rule: 'quiet', holds: active.has(key) ? !back : enter, back, sessions: recent.quiet.sessions, lastHour: recent.quiet.lastHour, lastStart: recent.quiet.lastStart, perHour, lastPerHour, usualDays: usual.days, series: series?.sessions ?? null });
  }

  if (rules.store && play) {
    for (const [metric, limit] of [
      ['crash', LIMITS.playCrashPct],
      ['anr', LIMITS.playAnrPct],
    ]) {
      const v = play[metric];
      if (!Number.isFinite(v?.rate)) continue;
      const key = `play-${metric}`;
      signals.push({ key, rule: 'store', store: 'google_play', metric, holds: active.has(key) ? v.rate >= limit * LIMITS.playHold : v.rate > limit, rate: v.rate, limit, day: v.day ?? null, users: v.users ?? null });
    }
  }

  const kept = [...next].filter(([, [, last]]) => now - last <= LIMITS.seenKeepMs).sort((a, b) => b[1][1] - a[1][1]).slice(0, LIMITS.seenMax);
  return { signals: signals.sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule)), seen: Object.fromEntries(kept) };
}

// ── the check ──

// One check of one service: reads its last day, applies the rules and claims what newly holds.
//   state (the host's, for this project): seen(service) → { seen, baselineAt, hours, hoursAt, versions, v } | null,
//     saveSeen(service, that), active(service) → Map, claim(service, key, record) → true for the one check that wins,
//     hold(service, key, record), release(service, key)
//   play: Google Play's rates for this game (the host's store data), or null
//   read: measure() (tests pass fixtures)
// The first check after alerts are turned on (enabledAt), or after these rules replaced older ones (STATE_VERSION),
// is the baseline: what already holds then is claimed without a message, so turning alerts on doesn't send what the
// dashboard already shows. New errors are the exception: they are new by their first occurrence, which the history
// says. The game going quiet then coming back sends a short note, once, if the quiet one was sent.
// → the signals that fired (at most LIMITS.perCheck), each ready for alertMessage().
export async function checkService({ store, state, projectId, service, settings = {}, enabledAt = 0, plan = null, play = null, now = Date.now(), read = measure }) {
  const stored = await state.seen(service);
  const baseline = !stored || !(stored.baselineAt >= enabledAt) || stored.v !== STATE_VERSION;
  const seed = !stored?.hours || !(now - stored.hoursAt <= LIMITS.profileStaleMs);
  const measured = await read(store, projectId, { service, env: settings.env || null, plan, now, seed, history: !stored });
  const oldest = Math.floor((now - LIMITS.profileDays * DAY) / HOUR);
  const hours = Object.fromEntries(Object.entries({ ...(seed ? {} : stored.hours), ...measured.hours }).filter(([h]) => +h >= oldest));
  const versionsSeen = { ...stored?.versions };
  for (const [v, at] of Object.entries(measured.versionsSeen ?? {})) if (!(versionsSeen[v] <= at)) versionsSeen[v] = at;
  const active = await state.active(service);
  const { signals, seen } = evaluate({ ...measured, hours, versionsSeen, play, seen: stored?.seen, active, settings, enabledAt, now });
  const keptVersions = Object.fromEntries(Object.entries(versionsSeen).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.versionsMax));
  await state.saveSeen(service, { seen, baselineAt: baseline ? now : stored.baselineAt, hours, hoursAt: now, versions: keptVersions, v: STATE_VERSION });

  const fired = [];
  for (const s of signals) {
    const was = active.get(s.key);
    if (s.back && was) {
      // Sessions came back: a note, once, if the quiet alert was sent; then the key clears, so it can fire again.
      const note = !was.quiet && fired.length < LIMITS.perCheck && (await state.claim(service, `quiet-back-${was.firedAt}`, { key: `quiet-back-${was.firedAt}`, rule: 'quiet_back', firedAt: now, heldAt: now }));
      await state.release(service, s.key);
      if (note) fired.push({ ...s, key: `quiet-back-${was.firedAt}`, rule: 'quiet_back', quietSince: was.firedAt, service, at: now });
      continue;
    }
    if (!s.holds) {
      if (was && now - was.heldAt >= LIMITS.clearAfterMs) await state.release(service, s.key);
      continue;
    }
    if (was) {
      if (now - was.heldAt >= LIMITS.touchMs) await state.hold(service, s.key, { ...was, heldAt: now });
      continue;
    }
    const quiet = baseline && s.rule !== 'new_error';
    if (!quiet && fired.length >= LIMITS.perCheck) continue;
    const record = { key: s.key, rule: s.rule, finding: s.finding ?? null, firedAt: now, heldAt: now, ...(quiet ? { quiet: true } : {}) };
    if ((await state.claim(service, s.key, record)) && !quiet) fired.push({ ...s, service, at: now });
  }
  // Keys no rule spoke for this time (a version pair a newer release replaced, a rule turned off, an older rule's).
  const spoken = new Set(signals.map((s) => s.key));
  for (const [key, was] of active) if (!spoken.has(key) && now - was.heldAt >= LIMITS.clearAfterMs) await state.release(service, key);
  return fired;
}

// The dashboard page an alert links to, as a hash route: '#/errors/<fingerprint>', '#/performance?level=…'.
export function dashboardRoute(page, params = {}) {
  if (params.fingerprint) return `#/errors/${encodeURIComponent(params.fingerprint)}`;
  return `#/${page === 'overview' ? '' : page}${params.level ? `?level=${encodeURIComponent(params.level)}` : ''}`;
}

// ── messages ──

// What one alert says, in any channel:
//   title     the sentence: the email's subject and every channel's headline. No jargon.
//   big       { value, label, normal }: the number of players, and what's normal next to it
//   quote     the game's own text it is about (an error's message), shown as code, or left out
//   todo      one line: what to do
//   paste     the line for a coding agent, or null
//   agent     lines for "For your agent": the measurements behind it (rates, frame times, ids), at the bottom
//   link      the dashboard URL (link(page, params), or null; linkLabel, when it isn't "Open in Glitchless"), and figure { kind, headline, series, stats } for a
//             channel that draws a card (Glitchless Cloud's email)
// with { key, rule, severity, finding, game, at }. `name`: what the host calls the game (Glitchless Cloud: the game's
// name), else its service.
export function alertMessage(s, { link = () => null, name = null } = {}) {
  const game = clean(name ?? s.service, 80);
  const base = { key: s.key, rule: s.rule, finding: s.finding ?? null, game, at: s.at };
  const unit = s.units === 'sessions' ? 'session' : 'player';
  const counted = s.units === 'sessions' ? 'Counted in sessions: the game sends no player IDs.' : null;

  if (s.rule === 'crashes') {
    const v = s.version ? clean(s.version, 40) : null;
    const usual = s.perDay == null ? (s.usualShare ? `usually ${oneIn(s.usualShare)} ${unit}s in these hours` : 'usually none in these hours') : s.perDay < 0.5 ? 'usually none' : s.perDay < 1 ? 'usually under 1 a day' : `usually about ${Math.round(s.perDay)} a day`;
    const where = v ? (s.startedWith ? ` Started with ${v}.` : ` Most are on ${v}.`) : '';
    return {
      ...base,
      severity: 'high',
      title: `${game} is crashing: ${count(s.crashed, unit)} in the last 6 hours (${usual}).${where}`,
      big: { value: whole(s.crashed), label: `${s.crashed === 1 ? unit : `${unit}s`} crashed in the last 6 hours`, normal: cap(usual) },
      todo: v && s.startedWith ? `Find the crash that came with ${v} and ship a fix, or roll back to the version before.` : 'Find the crash behind the jump and ship a fix: the crashes page lists them, the newest first.',
      paste: `Use glitchless_triage on ${game}: crashes jumped in the last 6 hours${v ? `, mostly on ${v}` : ''}. glitchless_get_error has each crash's stack.`,
      agent: [
        `${s.crashed} of the ${s.total} ${unit}s who started a session in the last 6 hours crashed (${pct1(s.share)}), against ${pct1(s.usualShare)} in the same hours over the last ${s.usualDays} days (${whole(s.usualPlayers)} ${unit}s); Poisson p ${s.p < 0.001 ? '< 0.001' : `= ${s.p}`}.`,
        ...(v ? [`${s.onVersion} of them on ${v}${s.startedWith ? ', first seen this week' : ''}.`] : []),
        ...(counted ? [counted] : []),
      ],
      link: link('errors'),
      figure: { kind: 'Crashes', headline: `${game} crashes more than usual`, series: s.series, stats: v ? [{ label: s.startedWith ? 'Started with' : 'Most on', value: v, hot: true }] : [] },
    };
  }

  if (s.rule === 'new_error') {
    const i = s.issue;
    const level = i.levels?.length ? clean(i.levels[0], 40) : null;
    const version = clean(i.first_version, 40);
    const since = ago(s.at - s.first);
    const players = s.players ?? i.sessions;
    const where = [level && `on ${level}`, version && `in ${version}`].filter(Boolean).join(' ');
    return {
      ...base,
      severity: i.fatal ? 'high' : 'medium',
      title: `A new error is spreading in ${game}: ${count(players, unit)} in ${since}${where ? `, ${where}` : ''}.`,
      big: { value: whole(players), label: `${players === 1 ? unit : `${unit}s`} hit it in ${since}`, normal: `None before ${clock(s.first)} UTC` },
      quote: clean(i.message, 160),
      todo: `Fix it before more ${unit}s hit it: its page has the stack and what ${unit}s did just before.`,
      paste: `Use glitchless_triage on ${game}, then look at finding error-${clean(i.fingerprint, 80)} (glitchless_get_error with fingerprint ${clean(i.fingerprint, 80)} has its stack).`,
      agent: [
        `${i.fatal ? 'Fatal ' : ''}${clean(i.kind, 40)}${i.location ? ` at ${clean(i.location, 160)}` : ''}; ${count(i.count, 'time')} in ${count(i.sessions, 'session')} (${i.sessions_pct}% of sessions) in the last day, first at ${clock(s.first)} UTC.`,
        ...(i.levels?.length > 1 ? [`Levels: ${i.levels.slice(0, 6).map((l) => clean(l, 40)).join(', ')}.`] : []),
        `Finding error-${clean(i.fingerprint, 80)}.`,
        ...(counted ? [counted] : []),
      ],
      link: link('errors', { fingerprint: i.fingerprint }),
      figure: { kind: i.fatal ? 'New crash' : 'New error', headline: clean(i.message, 140), series: i.series ?? null, stats: [...(version ? [{ label: 'First seen in', value: version }] : []), ...(level ? [{ label: i.levels.length > 1 ? `Level (of ${i.levels.length})` : 'Level', value: level }] : []), { label: 'Sessions hit', value: `${i.sessions_pct}%`, hot: true }] },
    };
  }

  if (s.rule === 'release') {
    const [a, b] = [clean(s.prev.version, 40), clean(s.cur.version, 40)];
    const by = Object.fromEntries(s.worse.map((w) => [w.measure, w]));
    const verb = { crashed: 'crashes', stutter: 'stutters' };
    const parts = s.worse.map((w, i) => `${verb[w.measure]} for ${oneIn(w.p1)}${i ? '' : ` ${unit}s`} (${a}: ${oneIn(w.p0)})`);
    const level = by.stutter && s.level ? clean(s.level.name, 40) : null;
    const lead = s.worse[0];
    return {
      ...base,
      severity: 'high',
      title: `${game} ${b} ${parts.join(' and ')}${level ? `, most of all on ${level}` : ''}.`,
      big: { value: oneIn(lead.p1), label: `${unit}s ${lead.measure === 'crashed' ? 'crash' : 'stutter'} in ${b}`, normal: `${a}: ${oneIn(lead.p0)}` },
      todo: `Look at what changed from ${a} to ${b}${level ? ` on ${level}` : ''} and ship a fix, or roll back to ${a}.`,
      paste: `Use glitchless_compare_versions on ${game} for ${a} and ${b}, then glitchless_triage: ${b} ${s.worse.map((w) => verb[w.measure]).join(' and ')} for more ${unit}s${level ? `, most of all on ${level}` : ''}.`,
      agent: [
        ...s.worse.map((w) => `${w.measure === 'crashed' ? 'Crashed' : `Stuttered (${LIMITS.stutterPerMin}+ hitches a minute in a session; a hitch is a frame over 50 ms)`}: ${s.cur[w.measure]} of ${s.cur.units} ${unit}s on ${b} (${pct1(w.p1)}), ${s.prev[w.measure]} of ${s.prev.units} on ${a} (${pct1(w.p0)}); z = ${w.z}.`),
        ...(level ? [`Hitches a minute on ${level}: ${s.level.before} on ${a}, ${s.level.after} on ${b}.`] : []),
        `Finding ${s.finding}; the last day.`,
        ...(counted ? [counted] : []),
      ],
      link: link('versions'),
      figure: { kind: 'Worse release', headline: `${b} is worse than ${a} for ${unit}s`, stats: level ? [{ label: 'Most of all on', value: level, hot: true }] : [] },
    };
  }

  if (s.rule === 'quiet') {
    const usual = Math.round(s.perHour * (LIMITS.quietMs / HOUR));
    return {
      ...base,
      severity: 'high',
      title: `${game} has gone quiet: ${s.sessions ? count(s.sessions, 'session') : 'no sessions'} in the last 3 hours (usually about ${whole(usual)}).`,
      big: { value: whole(s.sessions), label: 'sessions in the last 3 hours', normal: `Usually about ${whole(usual)}` },
      todo: 'Check that the game still starts and reaches Glitchless: its servers, its store page, and the latest build.',
      paste: `Use glitchless_overview on ${game}: sessions all but stopped in the last 3 hours${s.lastStart ? ` (the last started at ${clock(s.lastStart)} UTC)` : ''}. Look at the errors and sessions just before.`,
      agent: [`${s.sessions} sessions in the last 3 hours; the same hours over the last ${s.usualDays} days averaged ${round(s.perHour, 1)} an hour.`, ...(s.lastStart ? [`The latest session started at ${new Date(s.lastStart).toISOString().slice(0, 16).replace('T', ' ')} UTC.`] : [])],
      link: link('sessions'),
      figure: { kind: 'Gone quiet', headline: `Players stopped reaching ${game}`, series: s.series, stats: s.lastStart ? [{ label: 'Last session started', value: `${clock(s.lastStart)} UTC`, hot: true }] : [] },
    };
  }

  if (s.rule === 'quiet_back') {
    const usual = Math.round(s.lastPerHour);
    return {
      ...base,
      severity: 'ok',
      title: `${game}'s sessions are back: ${count(s.lastHour, 'session')} in the last hour (usually about ${whole(usual)}).`,
      big: { value: whole(s.lastHour), label: 'sessions in the last hour', normal: `Usually about ${whole(usual)}` },
      todo: `Nothing to do. It was quiet for about ${ago(s.at - s.quietSince + LIMITS.quietMs)}.`,
      paste: `Use glitchless_overview on ${game} for the last day: sessions stopped, then came back. Look at the errors just before the gap.`,
      agent: [`${s.lastHour} sessions in the last hour; that hour averaged ${round(s.lastPerHour, 1)} over the last days.`],
      link: link('overview'),
      figure: { kind: 'Back', headline: `Players are reaching ${game} again`, stats: [] },
    };
  }

  if (s.rule === 'store') {
    const crash = s.metric === 'crash';
    const rate = `${round(s.rate, 2)}%`;
    return {
      ...base,
      severity: 'high',
      title: crash ? `${game} is over Google Play's crash limit: ${rate} of Android players crash in a day (the limit is ${s.limit}%).` : `${game} is over Google Play's freeze limit: ${rate} of Android players see it stop responding in a day (the limit is ${s.limit}%).`,
      big: { value: rate, label: `of Android players a day ${crash ? 'crash' : 'see it freeze'}, over the last 28 days`, normal: `Google Play's limit: ${s.limit}%` },
      todo: `Fix the top Android ${crash ? 'crashes' : 'freezes'}: while the 28-day average is over ${s.limit}%, Play may show ${game} to fewer people and warn them on its page.`,
      paste: `Use glitchless_store_vitals on ${game} with store "google_play", then glitchless_triage: Play's ${crash ? 'user-perceived crash rate' : 'user-perceived ANR rate'} is ${rate}, over its ${s.limit}% bad-behaviour threshold.`,
      agent: [`Play Developer Reporting API, ${crash ? 'userPerceivedCrashRate28dUserWeighted' : 'userPerceivedAnrRate28dUserWeighted'}${s.day ? ` for ${s.day}` : ''}: ${rate}${s.users ? ` of ${whole(s.users)} users` : ''}. Bad-behaviour threshold ${s.limit}% overall (8% on any one phone model).`],
      link: link('stores'),
      figure: { kind: 'Store limit', headline: `Google Play may show ${game} to fewer people`, stats: [] },
    };
  }
  throw new Error(`no message for rule ${s.rule}`);
}

// The test button's message: every part of a real one, saying what it is.
export function testMessage({ service, at, link = () => null }) {
  const game = clean(service, 80);
  return {
    key: 'test',
    rule: 'test',
    severity: 'info',
    finding: null,
    game,
    at,
    title: `Test alert for ${game}: alerts reach this channel.`,
    big: null,
    todo: "Nothing to do. A real alert says what got worse for players in one sentence, how many it hit next to what's normal, and what to do.",
    paste: `Use glitchless_triage on ${game}.`,
    agent: ['A real alert puts its measurements here, for your coding agent: rates, frame times and finding ids.'],
    link: link('overview'),
    figure: { kind: 'Test alert', headline: 'Alerts reach this channel', stats: [] },
  };
}

// ── the weekly summary ──

// Monday 00:00 UTC of the week `ms` is in.
export function weekStart(ms) {
  const d = Math.floor(ms / DAY) * DAY;
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
}

// One week of a service's real players: [lo, hi) by session start.
function weekOf(ctx, lo, hi) {
  const real = realSessions(ctx).filter((s) => s.start != null && s.start >= lo && s.start < hi);
  const players = new Set(real.map(who));
  const crashed = new Set(real.filter((s) => s.crashed).map(who));
  const days = Array.from({ length: 7 }, (_, i) => new Set(real.filter((s) => s.start >= lo + i * DAY && s.start < lo + (i + 1) * DAY).map(who)).size);
  const sums = sumsBy(ctx, { name: 'purchase', key: null, value: null }, 'amount');
  const g = sums.groups.get('');
  return { sessions: real.length, players: players.size, crashed: crashed.size, days, purchases: g?.events ? { sum: round(g.sum, 2), currency: sums.currency ?? null } : null };
}

// Last week (Monday to Sunday, UTC) of one service against the week before, and the standing findings most worth
// fixing (paste lines name the game `name`, else its service). revenue: the host's revenue source for the two weeks ({ source, currency, last, before }), else the game's
// own purchase events are summed.
export async function weeklySummary(store, projectId, { service, name = null, env = null, plan = null, now, revenue = null }) {
  const end = weekStart(now);
  const q = { service, env, plan };
  const [last, before] = await Promise.all([contextFor(store, projectId, { ...q, from: end - 7 * DAY, to: end }), contextFor(store, projectId, { ...q, from: end - 14 * DAY, to: end - 7 * DAY })]);
  const w = weekOf(last, end - 7 * DAY, end);
  const b = weekOf(before, end - 14 * DAY, end - 7 * DAY);
  const own = w.purchases || b.purchases ? { source: null, currency: w.purchases?.currency ?? b.purchases?.currency ?? null, last: w.purchases?.sum ?? 0, before: b.purchases?.sum ?? 0 } : null;
  const found = findings(last, store.getMaps ? await store.getMaps(projectId, service) : []).filter((f) => ['critical', 'high', 'medium'].includes(f.severity));
  return { service, from: end - 7 * DAY, to: end, units: playersAreSessions(last) ? 'sessions' : 'players', last: w, before: b, revenue: revenue ?? own, fixes: found.slice(0, 3).map((f) => ({ id: f.id, severity: f.severity, ...plainFinding(f, clean(name ?? service, 80)) })) };
}

// A finding as one plain sentence, and the line to paste.
export function plainFinding(f, game) {
  const ev = f.evidence ?? {};
  const level = clean(ev.level ?? f.link?.level ?? '', 40);
  const id = f.id;
  const times = (n) => (n >= 1.5 ? `about ${Math.round(n)} times a minute` : 'about once a minute');
  let text;
  if (id.startsWith('perf-level-')) text = ev.hitches_per_min >= 0.5 ? `${level} stutters: it freezes for a moment ${times(ev.hitches_per_min)}, for the ${f.impact_pct}% of sessions that play it.` : `${level} runs slowly: its frames are often late, for the ${f.impact_pct}% of sessions that play it.`;
  else if (id.startsWith('hitches-level-')) text = `${level} freezes for a moment ${times(ev.hitches_per_min ?? 0)} during play, though it runs smoothly otherwise.`;
  else if (/^leak-(geometries|textures|orphan-nodes)-/.test(id)) text = `Memory keeps growing from level to level in ${clean(id.replace(/^leak-(geometries|textures|orphan-nodes)-/, ''), 40)}, so long sessions slow down and can crash.`;
  else if (id.startsWith('leak-gauge-')) text = `Something the game counts as "${clean(ev.key ?? id.slice(11), 40)}" keeps piling up during play and is never cleared, which slows long sessions down.`;
  else if (id.startsWith('error-')) text = `An error hits ${f.impact_pct}% of sessions${ev.levels?.length ? ` on ${clean(ev.levels[0], 40)}` : ''}: "${clean(f.title, 80)}".`;
  else if (id.startsWith('design-wall-')) text = `Players get stuck on ${level}: only ${ev.completion_pct}% of the sessions that reach it get through.`;
  else if (id.startsWith('design-hotspot-')) text = `Most deaths on ${level} happen at one spot: look at what kills players there.`;
  else if (id.startsWith('version-')) text = `${clean(ev.current?.version, 40)} does worse than ${clean(ev.previous?.version, 40)} for players.`;
  else if (id === 'device-gap-low-tier') text = 'Players on low-end graphics chips get a much choppier game than everyone else.';
  else if (id === 'load-ttff') text = `The game is slow to start: ${ev.slow_sessions_pct ?? f.impact_pct}% of sessions wait more than 4 seconds for the first frame.`;
  else if (id.startsWith('reports-')) text = `Players sent ${ev.reports} bug reports from ${level}.`;
  else if (id.startsWith('store-reviews-')) text = 'Store reviews about how the game runs went up after the latest update.';
  else text = `${clean(f.title, 140)}.`;
  return { text, paste: `Use glitchless_triage on ${game}, then look at finding ${clean(id, 200)}.` };
}

// The weekly summary in every channel's terms, as alertMessage's (key, rule 'weekly', title, big, lines, fixes, …).
export function weeklyMessage(w, { link = () => null, name = null } = {}) {
  const game = clean(name ?? w.service, 80);
  const unit = w.units === 'sessions' ? 'session' : 'player';
  const change = (a, b) => (!b ? (a ? 'new this week' : null) : a === b ? 'the same as the week before' : `${a > b ? 'up' : 'down'} ${Math.abs(Math.round((a / b - 1) * 100))}%`);
  const players = w.units === 'sessions' ? w.last.sessions : w.last.players;
  const before = w.units === 'sessions' ? w.before.sessions : w.before.players;
  const moved = change(players, before);
  const share = (x) => (x.players ? x.crashed / x.players : 0);
  const money = w.revenue && (w.revenue.last || w.revenue.before) ? w.revenue : null;
  const lines = [
    `${cap(unit)}s: ${whole(players)}${before ? ` (the week before: ${whole(before)}${moved ? `, ${moved}` : ''})` : ''}.`,
    ...(w.units === 'players' ? [`Sessions: ${whole(w.last.sessions)}${w.before.sessions ? ` (${whole(w.before.sessions)})` : ''}.`] : []),
    `Crashes: ${w.last.crashed ? `${oneIn(share(w.last))} ${unit}s had one` : `no ${unit} crashed`}${w.before.players ? ` (the week before: ${w.before.crashed ? oneIn(share(w.before)) : 'none'})` : ''}.`,
    ...(money ? [`Revenue: ${amount(money.last, money.currency)}${money.before ? ` (${amount(money.before, money.currency)})` : ''}, ${money.source ? `from ${money.source}` : "from the game's purchase events"}.`] : []),
  ];
  const range = shortDay(w.from).slice(0, 3) === shortDay(w.to - DAY).slice(0, 3) ? `${shortDay(w.from)}–${new Date(w.to - DAY).getUTCDate()}` : `${shortDay(w.from)}–${shortDay(w.to - DAY)}`;
  const fixing = w.fixes.length ? `${w.fixes.length === 1 ? 'One thing' : `${w.fixes.length} things`} worth fixing.` : 'Nothing standing out to fix.';
  return {
    key: `weekly-${new Date(w.to).toISOString().slice(0, 10)}`,
    rule: 'weekly',
    severity: 'info',
    finding: null,
    game,
    at: w.at ?? w.to,
    title: `${game} last week: ${count(players, unit)}${moved ? `, ${moved}` : ''}. ${fixing}`,
    big: { value: whole(players), label: `${unit}s, ${range}`, normal: before ? `The week before: ${whole(before)}` : 'Nothing the week before' },
    lines,
    todo: w.fixes.length ? 'Paste one into your coding agent when you have an hour.' : null,
    fixes: w.fixes.map((f) => ({ text: f.text, paste: f.paste })),
    paste: null,
    agent: w.fixes.length ? [`Findings ${w.fixes.map((f) => `${f.id} (${f.severity})`).join(', ')}, from glitchless_triage over ${range}.`] : [],
    link: link('overview'),
    figure: {
      kind: 'Your week',
      headline: `${game}, ${range}`,
      series: w.last.days,
      seriesFrom: shortDay(w.from),
      seriesTo: shortDay(w.to - DAY),
      stats: [],
    },
  };
}

// ── channels ──

const COLORS = { critical: 0xd83a52, high: 0xe5534b, medium: 0xe8a33d, low: 0x6b7a90, info: 0x4f8cff, ok: 0x2ee6a6 };

// The lines every channel shows, in order: the big number with what's normal, the week's lines, what to do.
function bigLine(m, bold) {
  return m.big ? `${bold(m.big.value)} ${m.big.label}${m.big.normal ? ` · ${m.big.normal}` : ''}` : null;
}

// Discord's webhook body. Text from games (error messages, level names) is escaped, and nobody is pinged. "For your
// agent" is the footer: small, grey and plain text.
export function discordPayload(m) {
  const big = bigLine({ ...m, big: m.big && { ...m.big, label: discordText(m.big.label), normal: m.big.normal && discordText(m.big.normal) } }, (v) => `**${discordText(v)}**`);
  const lines = [...(big ? [big] : []), ...(m.quote ? [`\`${code(m.quote)}\``] : []), ...(m.lines ?? []).map(discordText), ...(m.todo ? ['', discordText(m.todo)] : [])];
  for (const [i, f] of (m.fixes ?? []).entries()) lines.push('', `**${i + 1}.** ${discordText(f.text)}`, '```', code(f.paste), '```');
  if (m.paste) lines.push('', 'Paste into your coding agent:', '```', code(m.paste), '```');
  const agent = m.agent?.length ? `For your agent: ${m.agent.join(' ')}` : '';
  return {
    username: 'Glitchless',
    content: cut(`**${discordText(m.title)}**`, 2000),
    allowed_mentions: { parse: [] },
    embeds: [{ ...(m.link ? { title: m.linkLabel ?? 'Open in Glitchless', url: m.link } : {}), description: cut(lines.join('\n').trim(), 4000), color: COLORS[m.severity] ?? COLORS.info, footer: { text: cut([agent, `Glitchless · ${m.game}`].filter(Boolean).join('\n'), 2000) }, timestamp: new Date(m.at).toISOString() }],
  };
}

// Slack's incoming-webhook body (Block Kit). Slack wants &, < and > escaped, which also stops links and mentions.
// "For your agent" is a context block: small and grey.
export function slackPayload(m) {
  const big = bigLine({ ...m, big: m.big && { ...m.big, label: slackText(m.big.label), normal: m.big.normal && slackText(m.big.normal) } }, (v) => `*${slackText(v)}*`);
  const body = [...(big ? [big] : []), ...(m.quote ? [`\`${slackText(code(m.quote))}\``] : []), ...(m.lines ?? []).map(slackText), ...(m.todo ? [slackText(m.todo)] : [])];
  const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: cut(text, 3000) } });
  return {
    text: cut(slackText(m.title), 3000),
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      section(`*${slackText(m.title)}*`),
      ...(body.length ? [section(body.join('\n'))] : []),
      ...(m.fixes ?? []).map((f, i) => section(`*${i + 1}.* ${slackText(f.text)}\n\`\`\`${slackText(code(f.paste))}\`\`\``)),
      ...(m.paste ? [section(`Paste into your coding agent:\n\`\`\`${slackText(code(m.paste))}\`\`\``)] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: cut([m.link && `<${m.link}|${m.linkLabel ?? 'Open in Glitchless'}>`, m.agent?.length && `For your agent: ${m.agent.map(slackText).join(' ')}`].filter(Boolean).join(' · ') || 'Glitchless', 3000) }] },
    ],
  };
}

// ── a self-hosted server: GLITCHLESS_ALERT_WEBHOOK (server/src/local.js) ──

// The `state` checkService takes, in memory: a restart starts a new baseline.
export function memoryAlertState() {
  const seen = new Map();
  const keys = new Map();
  const id = (service, key) => `${service}\n${key}`;
  return {
    keys,
    seen: async (service) => seen.get(service) ?? null,
    saveSeen: async (service, value) => void seen.set(service, value),
    active: async (service) => new Map([...keys].filter(([k]) => k.startsWith(`${service}\n`)).map(([, v]) => [v.key, v])),
    claim: async (service, key, record) => (keys.has(id(service, key)) ? false : (keys.set(id(service, key), record), true)),
    hold: async (service, key, record) => void keys.set(id(service, key), record),
    release: async (service, key) => void keys.delete(id(service, key)),
  };
}

// Checks every service of one project now (the baseline) and every `everyMs` after, while the process runs, and
// posts what fires to one webhook: Slack's format for hooks.slack.com, else Discord's, unless `format` says.
// appUrl: where this server's dashboard is, for the links.
export function watchAlerts({ store, url, format = null, projectId = DEFAULT_PROJECT, appUrl = null, everyMs = 15 * MINUTE, fetch = globalThis.fetch, logger = console, now = Date.now }) {
  const state = memoryAlertState();
  const enabledAt = now();
  const kind = format || (new URL(url).hostname === 'hooks.slack.com' ? 'slack' : 'discord');
  const link = (page, params) => (appUrl ? `${appUrl}/${dashboardRoute(page, params)}` : null);
  async function check() {
    const t = now();
    const sent = [];
    for (const { service, last_seen } of await store.services(projectId)) {
      if (last_seen < t - DAY) continue;
      for (const s of await checkService({ store, state, projectId, service, enabledAt, now: t })) {
        const m = alertMessage(s, { link });
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'slack' ? slackPayload(m) : discordPayload(m)), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) logger.warn(`[alerts] the webhook answered HTTP ${res.status}`);
        sent.push(m);
      }
    }
    return sent;
  }
  const run = () => check().catch((err) => logger.warn('[alerts]', err.message));
  const first = run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return { check, first, stop: () => clearInterval(timer) };
}

// ── text from games, and numbers in words ──

// One line, no control characters, at most `max` characters.
export function clean(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cut(s, max);
}

function cut(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// A share as people say it: "1 in 4", "6 in 10", "nearly all", "none".
export function oneIn(p) {
  if (!(p > 0)) return 'none';
  if (p >= 0.95) return 'nearly all';
  if (p >= 0.45) return `${Math.round(p * 10)} in 10`;
  if (p < 0.001) return 'under 1 in 1,000';
  return `1 in ${whole(Math.round(1 / p))}`;
}

// Inside a code span or block: no backticks to break out with.
const code = (s) => String(s ?? '').replace(/`/g, "'");
const discordText = (s) => String(s).replace(/[\\*_~`|>#[\]()<:-]/g, '\\$&').replace(/@/g, '@\u200b');
const slackText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const whole = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const count = (n, word) => `${whole(n)} ${word}${n === 1 ? '' : 's'}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pct1 = (p) => `${round((p ?? 0) * 100, 1)}%`;
const clock = (ms) => new Date(ms).toISOString().slice(11, 16);
const shortDay = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const amount = (n, currency) => {
  try {
    const digits = Number.isInteger(n) ? 0 : 2;
    return currency ? Number(n).toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }) : whole(n);
  } catch {
    return `${whole(n)} ${currency}`;
  }
};
// A duration as people say it: "40 minutes", "9 hours", "2 days".
function ago(ms) {
  if (ms < 90 * MINUTE) return count(Math.max(1, Math.round(ms / MINUTE)), 'minute');
  if (ms < 2 * DAY) return count(Math.round(ms / HOUR), 'hour');
  return count(Math.round(ms / DAY), 'day');
}
