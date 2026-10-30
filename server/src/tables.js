// Table panels: a game's own events listed one by one, grouped and sorted (SPEC §3b "Tables"). Every other panel adds
// events up; a table shows each one with its attributes, so a game can read its runs day by day (Starlift's Daily
// Launch: each `daily_run` under its day, the best score first, with the day's lowest, average and best).
//
// The rows are the occurrences each session keeps of the event (session-state.js: the first EV.occurrences of each
// name, with their attributes, level and time), so a table reads what a breakdown by attribute reads, costs about as
// much, and answers the same on every store. A session that sent more than it keeps has its first ones listed and the
// rest counted (`unlisted`). A count() counter sends totals per window, not events, so it has no rows (`counted`). Over
// more than 31 days a range is answered by day, without each session's events, so a table asks for 31 days or less.
//
// A table shows only what the events carry: no player IDs (a session is a session, never a player), and on a share
// link no session IDs either (forShareTable).

import { parseFunnel, matchAttrs, platformOf, round } from './analytics.js';
import { EV } from './session-state.js';

export const TABLE = { limit: 20, maxLimit: 100, groups: 30, columns: 12, attrs: 8 };
// What every event has besides its attributes, with its column heading.
export const TABLE_BUILTINS = { $time: 'Time', $version: 'Version', $platform: 'Platform', $level: 'Level', $session: 'Session' };
// What rows can be grouped by besides an attribute.
const GROUP_BY = ['$version', '$level', '$platform'];
const NONE = '(none)';

// A table panel's fields past its event → as stored, or BoardError saying what to fix.
export function validTablePanel(p, at, BoardError) {
  const out = {};
  const key = (v, what, { session = true } = {}) => {
    const k = typeof v === 'string' ? v.trim() : '';
    if (!k || k.length > 64) throw new BoardError(`${at}.${what} is an attribute of the event or one of ${Object.keys(TABLE_BUILTINS).join(', ')}`);
    if (k.startsWith('$') && (!TABLE_BUILTINS[k] || (!session && k === '$session'))) throw new BoardError(`${at}.${what}: "${k}" is not ${session ? 'one of' : 'among'} ${Object.keys(TABLE_BUILTINS).filter((x) => session || x !== '$session').join(', ')}`);
    return k;
  };
  if (p.columns != null) {
    if (!Array.isArray(p.columns) || !p.columns.length || p.columns.length > TABLE.columns) throw new BoardError(`${at}.columns is a list of 1 to ${TABLE.columns} attributes or ${Object.keys(TABLE_BUILTINS).join(', ')}`);
    const seen = new Set();
    out.columns = p.columns.map((c, i) => {
      const object = c && typeof c === 'object' && !Array.isArray(c);
      const k = key(object ? c.key : c, `columns[${i}]`);
      if (seen.has(k)) throw new BoardError(`${at}.columns has "${k}" twice`);
      seen.add(k);
      if (!object || c.unit == null) return k;
      const unit = typeof c.unit === 'string' ? c.unit.trim().slice(0, 12) : '';
      if (!unit) throw new BoardError(`${at}.columns[${i}].unit is a short word shown after the numbers, e.g. "s" or "pts"`);
      return { key: k, unit };
    });
  }
  if (p.group_by != null) {
    const k = key(p.group_by, 'group_by');
    if (k.startsWith('$') && !GROUP_BY.includes(k)) throw new BoardError(`${at}.group_by is an attribute of the event or one of ${GROUP_BY.join(', ')}`);
    out.group_by = k;
  }
  if (p.sort != null) {
    const v = typeof p.sort === 'string' ? p.sort.trim() : '';
    out.sort = `${v.startsWith('-') ? '-' : ''}${key(v.replace(/^[-+]/, ''), 'sort', { session: false })}`;
  }
  if (p.of != null) {
    const v = typeof p.of === 'string' ? p.of.trim().slice(0, 64) : '';
    if (!v || v.startsWith('$')) throw new BoardError(`${at}.of is a numeric attribute of the event, e.g. "score": each group's lowest, average and highest`);
    out.of = v;
  }
  if (p.limit != null) {
    if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > TABLE.maxLimit) throw new BoardError(`${at}.limit is the rows per group, 1 to ${TABLE.maxLimit}`);
    out.limit = p.limit;
  }
  return out;
}

// A table panel's answer: { columns: [{ key, label, unit }], groups: [{ value, events, sessions, min, avg, max, rows,
// more }], more_groups, events, sessions, unlisted?, counted? }. Each row is its values in the columns' order: `$time`
// in ms, `$session` the session's ID, a list attribute its list, null where the event has none.
export function tablePanel(ctx, p) {
  const [f] = parseFunnel(p.event);
  if (ctx.daily) return { empty: true, why: 'Tables list events over 31 days or less: longer ranges are answered by day, without each event.' };
  const { rows, sent, tracked, counted, unlisted } = eventRows(ctx, f);
  if (!rows.length) {
    if (!sent) return { empty: true, why: `No "${f.name}" events in this window.` };
    const totals = 'which sends totals per window rather than each event, so there are no rows to list. Send it with track() to list each one.';
    if (!tracked) return { empty: true, why: `"${f.name}" is counted with count(), ${totals}` };
    if (counted) return { empty: true, why: `The "${p.event}" events in this window were counted with count(), ${totals}` };
    return { empty: true, why: `No "${p.event}" events in this window.` };
  }
  const columns = (p.columns ?? defaultColumns(rows, p.group_by)).map((c) => {
    const k = typeof c === 'string' ? c : c.key;
    return { key: k, label: TABLE_BUILTINS[k] ?? k, unit: typeof c === 'string' ? null : c.unit };
  });
  const groupOf = p.group_by
    ? (r) => {
        const v = cellOf(r, p.group_by);
        return v == null || v === '' || (Array.isArray(v) && !v.length) ? NONE : Array.isArray(v) ? v.join(', ') : String(v);
      }
    : () => null;
  const groups = new Map();
  for (const r of rows) {
    const value = groupOf(r);
    let g = groups.get(value);
    if (!g) groups.set(value, (g = { value, list: [], sessions: new Set(), last: -Infinity }));
    g.list.push(r);
    g.sessions.add(r.s);
    if (r.ts > g.last) g.last = r.ts;
  }
  // Groups newest first (the day just played on top), events without the attribute last.
  const ordered = [...groups.values()].sort((a, b) => (a.value === NONE) - (b.value === NONE) || b.last - a.last || naturalCompare(a.value, b.value));
  const shown = ordered.slice(0, TABLE.groups);
  const sort = sortOf(p.sort);
  const limit = p.limit ?? TABLE.limit;
  return {
    columns,
    groups: shown.map((g) => {
      const list = g.list.sort(sort);
      return { value: g.value, events: list.length, sessions: g.sessions.size, ...(p.of ? spreadOf(list, p.of) : {}), rows: list.slice(0, limit).map((r) => columns.map((c) => cellOf(r, c.key))), more: Math.max(0, list.length - limit) };
    }),
    more_groups: ordered.length - shown.length,
    events: rows.length,
    sessions: new Set(rows.map((r) => r.s)).size,
    ...(unlisted.events ? { unlisted } : {}),
    ...(counted ? { counted } : {}),
  };
}

// The event's track() occurrences matching `f`, from every session in the context: { ts, attrs, level, s }. `sent`:
// whether any session sent the name at all, `tracked` whether any with track(); `counted`: its events that came from
// count() counters (no rows); `unlisted`: track() events past what their sessions keep, and how many sessions sent more
// than that.
function eventRows(ctx, f) {
  const rows = [];
  const unlisted = { events: 0, sessions: 0, keep: EV.occurrences };
  let sent = false;
  let tracked = false;
  let counted = 0;
  for (const s of ctx.sessions.values()) {
    const v = s.ev?.[f.name];
    if (!v?.n) continue;
    sent = true;
    let kept = 0;
    for (const o of v.o || []) {
      if (fromCounter(o, v)) {
        if (f.value != null && matchAttrs(o[1], f)) counted += o[3];
        continue;
      }
      kept++;
      if (matchAttrs(o[1], f)) rows.push({ ts: o[0], attrs: o[1] || {}, level: o[2] ?? null, s });
    }
    if (f.value == null) counted += v.k || 0;
    if (v.n > (v.k || 0)) tracked = true;
    const left = v.n - (v.k || 0) - kept;
    if (left > 0) {
      unlisted.events += left;
      unlisted.sessions++;
    }
  }
  return { rows, sent, tracked, counted, unlisted };
}

// Whether a kept occurrence is a counter's (one entry standing for its n events), not one track() event: a counter's
// carries its n as the 4th element, and a tracked event has a 4th only in a zone, where it is 1 (session-state.js).
function fromCounter(o, v) {
  if (!v.k) return false;
  if (v.k >= v.n) return true;
  return o.length >= 4 && (o.length === 4 || o[3] !== 1);
}

// The event's own attributes, in the order the game first sent them, without the one the rows are grouped by.
function defaultColumns(rows, groupBy) {
  const keys = [];
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    for (const k of Object.keys(r.attrs)) if (k !== groupBy && !keys.includes(k)) keys.push(k);
    if (keys.length >= TABLE.attrs) break;
  }
  return keys.slice(0, TABLE.attrs);
}

function cellOf(r, key) {
  switch (key) {
    case '$time':
      return r.ts;
    case '$version':
      return r.s.version ?? null;
    case '$platform':
      return platformOf(r.s.device);
    case '$level':
      return r.level;
    case '$session':
      return r.s.session_id;
  }
  return r.attrs[key] ?? null;
}

// Rows in `sort` order ("-score": the highest first; default the newest first). Events without the value go last
// either way; ties go newest first.
function sortOf(sort = '-$time') {
  const desc = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  return (a, b) => {
    const x = cellOf(a, key);
    const y = cellOf(b, key);
    if (x == null || y == null) return (x == null) - (y == null) || b.ts - a.ts;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : naturalCompare(Array.isArray(x) ? x.join(', ') : x, Array.isArray(y) ? y.join(', ') : y);
    return (desc ? -c : c) || b.ts - a.ts || naturalCompare(a.s.session_id, b.s.session_id);
  };
}

// A group's lowest, average and highest `of`, over all its events (not only the rows shown).
function spreadOf(list, of) {
  const xs = list.map((r) => r.attrs[of]).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!xs.length) return { min: null, avg: null, max: null };
  return { min: Math.min(...xs), avg: round(xs.reduce((s, x) => s + x, 0) / xs.length, 2), max: Math.max(...xs) };
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// A table on a share link (board.js forShare): sessions numbered 1, 2, 3 in the order the table first shows them, never
// their IDs, so a reader still sees which runs came from one session; and for an event that carries money (`money`) on a
// link that doesn't show sums, its number columns and each group's lowest, average and highest left out (`hidden`).
// Fields are kept by name, so whatever is added to the answer later stays off share links until it is listed here.
const SHARED_GROUP = ['value', 'events', 'sessions', 'min', 'avg', 'max', 'rows', 'more'];
export function forShareTable(data, { money = false, sums = false } = {}) {
  const hide = money && !sums;
  const numbered = new Map();
  const hidden = data.columns.map((c, i) => hide && !TABLE_BUILTINS[c.key] && data.groups.some((g) => g.rows.some((r) => typeof r[i] === 'number')));
  const value = (c, i, v) => {
    if (hidden[i]) return null;
    if (c.key !== '$session' || v == null) return v;
    if (!numbered.has(v)) numbered.set(v, numbered.size + 1);
    return numbered.get(v);
  };
  return {
    columns: data.columns.map((c, i) => ({ key: c.key, label: c.label, unit: c.unit, ...(c.key === '$session' ? { numbered: true } : {}), ...(hidden[i] ? { hidden: true } : {}) })),
    groups: data.groups.map((g) => {
      const kept = Object.fromEntries(SHARED_GROUP.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]));
      return { ...kept, ...(hide && 'min' in g ? { min: null, avg: null, max: null } : {}), rows: g.rows.map((r) => r.map((v, i) => value(data.columns[i], i, v))) };
    }),
    more_groups: data.more_groups,
    events: data.events,
    sessions: data.sessions,
    ...(data.unlisted ? { unlisted: data.unlisted } : {}),
    ...(data.counted ? { counted: data.counted } : {}),
  };
}
