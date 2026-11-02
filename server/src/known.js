// Known findings: standing problems a game's owner has looked at and accepted, such as a slow first launch they chose
// or a freeze they can't get rid of. The weekly summary leaves them out, so it stops listing them every Monday; every
// list of findings (triage, the overview, a board's findings panel) keeps them, marked `known` with the owner's note,
// after the rest. Glitchless Cloud keeps each game's list with its alert settings (SPEC §3e); the matching is the
// core's, and findings.js applies it when a context carries `known`: { entries, now }.
//
// An entry: { id, note, by, at, until?, worse?, was? }
//   id      a finding id, or the start of one ("perf-level-tutorial_1_" covers every finding on those levels). A
//           finding's entry is the longest that matches it.
//   until   'YYYY-MM-DD': the last day (UTC) it is known. From the day after, the finding is back.
//   worse   true: known only while it is no worse than when it was marked. `was` holds what each finding the entry
//           matched measured then ({ [finding id]: { severity, impact, value? } }). It is back when its severity is
//           higher, its impact KNOWN_LIMITS.worseTimes as much and KNOWN_LIMITS.worsePoints points more, or its key
//           number (KEY_NUMBERS) KNOWN_LIMITS.worseTimes as much. A finding the entry matches that wasn't there when it
//           was marked is back too: there is nothing to compare it with.
// A finding that is back carries `came_back` { known (the entry's id), note, why } instead of `known`.

const DAY = 86_400_000;
const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export const KNOWN_LIMITS = {
  // "Until it gets worse": a quarter worse than when it was marked. Weekly numbers of a small game move by a tenth or
  // so on their own (Starlift's slow-start p95: 9.6 to 10.6 s), so less would bring findings back for nothing.
  worseTimes: 1.25,
  worsePoints: 5, // and, for impact (a share of sessions), at least this many points more
  max: 50, // entries a game keeps
  idMin: 3,
  idMax: 200,
  noteMax: 200,
};

// The number each kind of finding is about, higher being worse, by the start of its id: [start, evidence key, label].
// Other findings compare by severity and impact only.
export const KEY_NUMBERS = [
  ['perf-level-', 'p95', 'p95 frame time (ms)'],
  ['hitches-level-', 'hitches_per_min', 'hitches a minute'],
  ['load-ttff', 'ttff_p95', 'p95 time to first frame (ms)'],
];

export function keyNumber(f) {
  const k = KEY_NUMBERS.find(([start]) => f.id.startsWith(start));
  const value = k ? f.evidence?.[k[1]] : null;
  return Number.isFinite(value) ? { key: k[1], label: k[2], value } : null;
}

// What a finding measures now, to compare with later.
export function knownSnapshot(f) {
  const n = keyNumber(f);
  return { severity: f.severity, impact: f.impact, ...(n ? { value: n.value } : {}) };
}

// The entry that covers finding `id` (the longest that matches), or null.
export function knownEntry(id, entries = []) {
  let best = null;
  for (const e of entries) if (e?.id && id.startsWith(e.id) && !(best?.id.length >= e.id.length)) best = e;
  return best;
}

// An entry applies through its `until` day.
export const knownLive = (e, now) => !e.until || now < Date.parse(`${e.until}T00:00:00Z`) + DAY;

// How finding f is worse than what it measured when it was marked (`was`), for an agent: a line, or null.
export function gotWorse(f, was) {
  const why = [];
  if (RANK[f.severity] < RANK[was.severity]) why.push(`severity ${was.severity} → ${f.severity}`);
  if (f.impact >= KNOWN_LIMITS.worseTimes * was.impact && (f.impact - was.impact) * 100 >= KNOWN_LIMITS.worsePoints) why.push(`impact ${share(was.impact)} → ${share(f.impact)} of sessions`);
  const n = keyNumber(f);
  if (n && Number.isFinite(was.value) && n.value >= KNOWN_LIMITS.worseTimes * was.value && n.value > was.value) why.push(`${n.label} ${was.value} → ${n.value}`);
  return why.length ? `${why.join('; ')} since it was marked known` : null;
}

// Ranked findings → the same, with the known ones marked and after the rest (each part keeps its order).
export function markKnown(list, { entries = [], now = Date.now() } = {}) {
  const live = (entries ?? []).filter((e) => knownLive(e, now));
  if (!live.length) return list;
  const rest = [];
  const known = [];
  for (const f of list) {
    const e = knownEntry(f.id, live);
    if (!e) {
      rest.push(f);
      continue;
    }
    const was = e.worse ? e.was?.[f.id] : null;
    const why = !e.worse ? null : was ? gotWorse(f, was) : 'new since findings like it were marked known, so there is nothing to compare it with';
    if (why) rest.push({ ...f, came_back: { known: e.id, note: e.note, why, ...(was ? {} : { new: true }) } });
    else known.push({ ...f, known: { id: e.id, note: e.note, by: e.by ?? null, at: e.at ?? null, ...(e.until ? { until: e.until } : {}), ...(e.worse ? { until_worse: true } : {}) } });
  }
  return [...rest, ...known];
}

const share = (p) => `${Math.round((p ?? 0) * 1000) / 10}%`;
