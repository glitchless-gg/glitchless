// Resolved errors: issues a game's owner has dealt with or accepts, as in Sentry, such as a GPU driver's error on
// test phones or one fixed in the newest build. Lists of issues (the errors query, a board's errors panel) keep them,
// marked `resolved`, after the rest, and the dashboard hides them unless asked; triage, the overview's top errors
// and the weekly summary leave them out. One that fires again after it was resolved, in a version later in release
// order than the newest it had been seen in then, is back: first in the list, marked `came_back`, with a finding
// again, and new to the new_error alert. Stragglers on the old builds don't bring it back. Glitchless Cloud keeps
// each game's list with its alert settings, beside its known findings (known.js, SPEC §3e); the matching is the
// core's, and analytics.js errorList applies it when a context carries `resolved`: { entries, share }.
//
// An entry: { fingerprint, note, by, at (ISO), version, any? }
//   version  the newest version the issue had been seen in when it was resolved (null if none was known)
//   any      true: back if it fires again at all after `at`, in any version
// A share link's reader sees that an issue is resolved or came back, never the note or who.
import { versionNewer } from './analytics.js';

export const RESOLVED_LIMITS = {
  max: 200, // entries a game keeps
  fingerprintMin: 4,
  fingerprintMax: 80,
  noteMax: 200,
};

// An issue's mark, from x (facts.js mergeErrors: versions { version: first time in the range }, last) and its entry
// e: { resolved } while it stays resolved, { came_back } once it's back, or {} without an entry.
// seen: the store's first sighting of each version (analytics.js versionNewer).
export function resolvedMark(x, e, { seen = null, share = false } = {}) {
  if (!e) return {};
  const at = Date.parse(e.at);
  const who = share ? {} : { note: e.note ?? null, by: e.by ?? null };
  const was = { at: e.at, version: e.version ?? null, ...(e.any ? { any_version: true } : {}), ...who };
  if (!(x.last > at)) return { resolved: was };
  // The versions that bring it back, with when the range first saw it in each: with `any`, every version it fired in
  // after `at` (or, when each of them was seen before, the newest of them); else those later than e.version.
  // When versions can't be ordered (names), a version it first fired in after `at` counts as later.
  const firsts = Object.entries(x.versions ?? {});
  const later = (v, first) => e.version == null || (versionNewer(v, e.version, seen) ?? (v !== e.version && first > at));
  let back = firsts.filter(([v, first]) => (e.any ? first > at : later(v, first)));
  if (e.any && !back.length) back = firsts;
  if (!back.length) return { resolved: was };
  const [version, first] = back.reduce((a, b) => (versionNewer(b[0], a[0], seen) ? b : a));
  return { came_back: { version, since: first > at ? first : x.last, resolved: was } };
}

// The entries by fingerprint, for errorList.
export const resolvedIndex = (entries = []) => new Map(entries.filter((e) => e?.fingerprint).map((e) => [e.fingerprint, e]));

// Issues in their order → the ones that came back first, then the open ones, then the resolved, each part in order.
export function resolvedOrder(list) {
  const rank = (i) => (i.came_back ? 0 : i.resolved ? 2 : 1);
  return list.map((i, n) => [i, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([i]) => i);
}

// "came back in 1.1.3 on Nov 2, after it was resolved in 1.1.2": for findings, alerts and agents.
export function cameBackLine(c) {
  const day = new Date(c.since).toISOString().slice(0, 10);
  const was = c.resolved.version ? ` in ${c.resolved.version}` : '';
  return `came back in ${c.version ?? 'an unknown version'} on ${day}, after it was resolved${was} on ${String(c.resolved.at).slice(0, 10)}`;
}
