// When sessions first send an event, and the sessions that never do (SPEC §3b, a stat's `first` and `never`). A game
// that wants to know how long players stay in its lobby before they first leave it, and how many never leave it, sends
// the event it already has (`hall_left`) and nothing timed by hand:
//   - `first`: the seconds from a session's start to its first event that matches, a percentile of them over the
//     sessions that sent it (the median by default: "half of the players leave the hall within 40 s");
//   - `never`: the share of the window's ended sessions that never sent it ("12% of sessions end in the hall").
// Both read the sessions themselves (session-state.js keeps each event's earliest 16 occurrences in time order, and its
// values' counts), so over 31 days or less; a longer range is answered by day, without each session's start and end.
//
// A session starts at its first event (session_start) and has ended once it sent session_end, or sent nothing for
// QUIET_MS before the window's end (a closed tab, a killed app, a crash). A filtered event ("purchase:result=done") is
// first sent at its first kept occurrence that matches; a session whose kept 16 have none, though its counts say it sent
// one later, has no known time and is counted in `unknown`. A Roblox server sends a player's events into that player's
// session (SPEC §5e), so for a Roblox game `first` counts from the player joining the server.

import { matchAttrs, sentEvent, quantile, round } from './analytics.js';

// A session that sent nothing for this long before the window's end is over, whether or not it said so.
export const QUIET_MS = 30 * 60_000;
const WHY_DAYS = 'over 31 days or less: longer ranges are answered by day, without each session';

// The seconds from each session's start to its first event matching `f`, over the sessions that sent one →
// { seconds: [...], unknown } (unknown: sessions that sent one whose time isn't kept).
export function firstTimes(ctx, f) {
  const seconds = [];
  let unknown = 0;
  for (const s of ctx.sessions.values()) {
    const v = s.ev?.[f.name];
    if (!v) continue;
    const hit = v.o.find((o) => matchAttrs(o[1], f));
    if (hit) seconds.push(Math.max(0, (hit[0] - s.first_ts) / 1000));
    else if (sentEvent(s, f)) unknown++;
  }
  return { seconds, unknown };
}

// Whether a session is over by the window's end: it said so, or went quiet.
export function sessionOver(s, ctx) {
  return !!s.ended || s.last_ts <= (ctx.to ?? Date.now()) - QUIET_MS;
}

// The ended sessions, and how many of them never sent an event matching `f` → { ended, never }.
export function neverSent(ctx, f) {
  let ended = 0;
  let never = 0;
  for (const s of ctx.sessions.values()) {
    if (!sessionOver(s, ctx)) continue;
    ended++;
    if (!sentEvent(s, f)) never++;
  }
  return { ended, never };
}

// A stat's `first` (with `quantile`, default 50): { value (seconds), unit: 's', quantile, sessions, unknown? }, or
// { empty, why }. `label` is the event as the panel wrote it.
export function firstStat(ctx, f, q = 50, label = f.name) {
  if (ctx.daily) return { empty: true, why: `Time to a first event is read ${WHY_DAYS}'s start.` };
  const { seconds, unknown } = firstTimes(ctx, f);
  if (!seconds.length) return { empty: true, why: unknown ? `${unknown} ${unknown === 1 ? 'session' : 'sessions'} sent "${label}", but past the first 16 of its events, so when isn't kept.` : `No session sent "${label}" in this window.` };
  return { value: round(quantile(seconds, q / 100), 1), unit: 's', quantile: q, sessions: seconds.length, ...(unknown ? { unknown } : {}) };
}

// A stat's `never`: { value (%), unit: '%', count, base } (base: the ended sessions, count: those that never sent it),
// or { empty, why }.
export function neverStat(ctx, f) {
  if (ctx.daily) return { empty: true, why: `Sessions that never sent an event are counted ${WHY_DAYS}'s end.` };
  const { ended, never } = neverSent(ctx, f);
  if (!ended) return { empty: true, why: 'No session has ended in this window yet.' };
  return { value: round((never / ended) * 100, 1), unit: '%', count: never, base: ended };
}

// Both for one event, as the events query answers `first` (glitchless_events): the median and the slowest 1 in 10 of
// the seconds to the first, and the share of ended sessions that never sent it.
export function firstQuery(ctx, f, label) {
  if (ctx.daily) return { event: label, empty: true, why: `Time to a first event and sessions that never sent it are read ${WHY_DAYS}.` };
  const { seconds, unknown } = firstTimes(ctx, f);
  const { ended, never } = neverSent(ctx, f);
  return {
    event: label,
    sessions: seconds.length,
    median_s: seconds.length ? round(quantile(seconds, 0.5), 1) : null,
    p90_s: seconds.length ? round(quantile(seconds, 0.9), 1) : null,
    ...(unknown ? { unknown } : {}),
    ended,
    never,
    never_pct: ended ? round((never / ended) * 100, 1) : null,
  };
}
