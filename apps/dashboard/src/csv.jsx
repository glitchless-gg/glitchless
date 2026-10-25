// CSV export: every board panel and the tables of the built-in views download what they show, built here from
// the data already on the page (nothing more is asked of the server, so a shared board exports only what it
// shows). The columns are the ones on screen, after a header row: times in ISO 8601 (UTC), durations in
// seconds, frame times in ms, money in its currency's units. A file is named <game>-<panel>-<from>-<to>.csv.
import { useFilters } from './filters.js';
import { STORE_TYPES, storeCsv } from './stores.jsx';

// Rows (arrays of cells) as CSV text.
export function toCsv(rows) {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function cell(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  let s = String(v);
  // Text from a game or its players that a spreadsheet would run as a formula is kept as text.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// <game>-<panel>-<from>-<to>.csv, with the range as UTC minutes: starlift-revenue-2026-10-22T1530Z-2026-10-23T1530Z.csv
export function csvName(game, panel, from, to) {
  const stamp = (ts) => `${new Date(ts).toISOString().slice(0, 16).replace(':', '')}Z`;
  return `${slug(game)}-${slug(panel)}-${stamp(from)}-${stamp(to)}.csv`;
}

function slug(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'export'
  );
}

export function downloadCsv(name, rows) {
  // The byte order mark tells spreadsheets the file is UTF-8 (currency symbols, the game's own words).
  const url = URL.createObjectURL(new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Downloads `rows()` (a header row, then the data) for the page's game and time range. `name` is the panel's.
export function CsvButton({ name, rows }) {
  const f = useFilters();
  return (
    <button
      type="button"
      className="btn csv"
      title="Download what this shows as CSV"
      onClick={(e) => {
        e.stopPropagation();
        downloadCsv(csvName(f.service, name, f.from, f.to), rows());
      }}
    >
      CSV
    </button>
  );
}

const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());
const sumHeader = (label, currency) => (currency ? `${label} (${currency})` : label);

// ───────────────────────────── board panels ─────────────────────────────

// A board panel's rows, or null when it shows nothing to export (empty; a live panel exports its feed with
// liveCsv).
export function panelCsv(p) {
  if (p.empty) return null;
  if (STORE_TYPES.has(p.type)) return storeCsv(p);
  switch (p.type) {
    case 'stat': {
      const head = ['Stat', p.currency ? `Value (${p.currency})` : p.unit ? `Value (${p.unit})` : 'Value'];
      const row = [p.title, p.value];
      if (p.base != null) {
        head.push(p.sum ? sumHeader('Total', p.currency) : 'Count', p.per === '$players' ? 'Players' : p.per === '$sessions' ? 'Sessions' : p.per);
        row.push(p.sum ? p.total : p.count, p.base);
      }
      if (p.mismatch?.length) {
        head.push('Left out (other currencies)');
        row.push(p.mismatch.map((m) => `${m.events} in ${m.currency}: ${m.sum}`).join('; '));
      }
      if (p.sandbox) {
        head.push('Left out (sandbox purchases)');
        row.push(p.sandbox);
      }
      return [head, row];
    }
    case 'series':
      return [['Time', ...p.series.map((s) => (p.sum ? sumHeader(s.label, p.currency) : s.label))], ...p.ts.map((t, i) => [iso(t), ...p.series.map((s) => s.values[i])])];
    case 'breakdown': {
      // A split of sessions ($platform, $browser, $device_tier) names its column in words.
      const by = p.split ?? (p.by.startsWith('$') ? p.by.slice(1) : p.by);
      const sessions = p.rows.some((r) => r.sessions != null);
      const players = p.rows.some((r) => r.players != null);
      // Split without an event, the count is the sessions.
      if (p.counts === 'sessions') return [[by, 'Sessions', ...(players ? ['Players'] : [])], ...p.rows.map((r) => [r.value, r.sessions, ...(players ? [r.players] : [])])];
      return [
        [by, 'Count', ...(sessions ? ['Sessions'] : []), ...(players ? ['Players'] : []), ...(p.sum ? [sumHeader(p.sum, p.currency)] : [])],
        ...p.rows.map((r) => [r.value, r.count, ...(sessions ? [r.sessions] : []), ...(players ? [r.players] : []), ...(p.sum ? [r.sum] : [])]),
      ];
    }
    case 'funnel':
      return [['Step', 'Sessions', '% of first', '% of the step before', 'Seconds from the step before'], ...p.steps.map((s, i) => [s.step, s.sessions, s.pct_of_first, i ? s.pct_of_previous : null, i ? s.median_s_from_previous : null])];
    case 'levels': {
      const h = p.has;
      return [
        [p.label || 'Level', 'Sessions', 'Attempts', ...(h.completion ? ['Completion %'] : []), ...(h.fails ? ['Fails'] : []), ...(h.deaths ? ['Deaths / session'] : []), ...(h.time ? ['Avg time (s)'] : []), ...(h.rage_quits ? ['Rage quits'] : [])],
        ...p.rows.map((l) => [l.level, l.sessions, l.attempts, ...(h.completion ? [l.completion_pct] : []), ...(h.fails ? [l.fails] : []), ...(h.deaths ? [l.deaths_per_session] : []), ...(h.time ? [l.avg_complete_s] : []), ...(h.rage_quits ? [l.rage_quits] : [])]),
      ];
    }
    case 'frame_time':
      return [['Time', 'p50 (ms)', 'p95 (ms)'], ...p.ts.map((t, i) => [iso(t), p.p50[i], p.p95[i]])];
    case 'errors': {
      const location = p.issues.some((i) => i.location);
      return [['Kind', 'Message', ...(location ? ['Location'] : []), 'Count', 'Sessions'], ...p.issues.map((i) => [i.kind, i.message, ...(location ? [i.location] : []), i.count, i.sessions])];
    }
    case 'deaths': {
      const causes = [...new Set(p.rows.flatMap((r) => Object.keys(r.causes)))];
      return [['Level', 'Deaths', ...causes], ...p.rows.map((r) => [r.level, r.deaths, ...causes.map((c) => r.causes[c] || 0)])];
    }
    case 'events':
      return [['Event', 'Count', 'Sessions', 'Sessions %', 'Per session', 'Attributes'], ...p.events.map((e) => [e.name, e.count, e.sessions, e.sessions_pct, e.per_session, e.attrs.join(' ')])];
    case 'findings':
      return [['Severity', 'Category', 'Title', 'Summary', 'Suggestion'], ...p.findings.map((x) => [x.severity, x.category, x.title, x.summary, x.suggestion])];
    case 'sessions':
      return sessionsCsv(p.sessions);
    case 'versions': {
      const cols = p.columns.filter((c) => !c.hidden);
      return [
        [{ steam_branch: 'Steam branch', steam_build: 'Steam build' }[p.by] || 'Version', 'First seen', 'Sessions', ...cols.map((c) => columnHeader(c))],
        ...p.rows.map((v) => [v.version, iso(v.first_seen), v.sessions, ...p.columns.flatMap((c, i) => (c.hidden ? [] : [v.values[i]]))]),
      ];
    }
    case 'reports':
      return reportsCsv(p.reports);
    case 'retention':
      return retentionCsv(p);
    case 'positions': {
      // One row per bin: its centre on the level's plane and how many fell in it.
      const b = p.axis === 'xy' ? 'y' : 'z';
      return [['Layer', 'x', b, 'Count'], ...(p.deaths || []).map(([x, y, n]) => ['death', x, y, n]), ...(p.path?.cells || []).map(([x, y, n]) => ['path', x, y, n])];
    }
  }
  return null;
}

// Retention cohorts as RetentionTable shows them: the first-seen day, its new players, and for D1, D7 and D30 the
// share and how many came back (empty until that day has ended in the range).
export function retentionCsv(r) {
  const days = ['d1', 'd7', 'd30'];
  return [
    ['First seen', 'New players', ...days.flatMap((d) => [`${d.toUpperCase()} %`, `${d.toUpperCase()} returned`])],
    ...r.cohorts.map((c) => [c.day, c.players, ...days.flatMap((d) => [c[d], c.returned[d]])]),
  ];
}

// A board stat as a version comparison's column: its title with its unit (a count or sum compared per session
// says so; one that is per player or session already doesn't).
export function columnHeader(c) {
  const per = c.unit?.startsWith('per ') && !c.per ? c.unit : null;
  const unit = [c.currency, per ?? (c.unit?.startsWith('per ') ? null : c.unit)].filter(Boolean).join(' ');
  return unit ? `${c.title} (${unit})` : c.title;
}

// ───────────────────────────── built-in views ─────────────────────────────

// Sessions as SessionsTable shows them: columns only for what the game reports, and none for ids or devices on
// a shared board (its rows come without them).
export function sessionsCsv(rows, all = rows) {
  const has = {
    levels: all.some((s) => s.levels.length),
    frames: all.some((s) => s.p95 != null),
    deaths: all.some((s) => s.deaths > 0),
    ids: all.some((s) => 'session_id' in s),
    devices: all.some((s) => 'browser' in s),
    events: all.some((s) => Object.keys(s.events || {}).length),
  };
  const outcome = (s) => (s.crashed ? 'crashed' : s.rage_quit ? `rage quit${s.rage?.level ? ` on ${s.rage.level}` : ''}` : s.completed.length ? `cleared ${s.completed.length}` : s.ended ? 'left' : 'playing');
  return [
    ['Started', ...(has.ids ? ['Session', 'Player'] : []), 'Type', 'Version', ...(has.devices ? ['Device', 'GPU tier'] : []), ...(has.events ? ['Events'] : []), ...(has.levels ? ['Levels', 'Cleared'] : []), 'Duration (s)', ...(has.frames ? ['p95 frame (ms)'] : []), ...(has.deaths ? ['Deaths'] : []), 'Errors', 'Outcome'],
    ...rows.map((s) => [
      iso(s.start),
      ...(has.ids ? [s.session_id, s.player_id] : []),
      s.session_type,
      s.version,
      ...(has.devices ? [[s.browser, s.os, s.gpu].filter(Boolean).join(' · '), s.gpu_tier] : []),
      ...(has.events
        ? [
            Object.entries(s.events || {})
              .map(([n, k]) => (k > 1 ? `${n} x${k}` : n))
              .join(' '),
          ]
        : []),
      ...(has.levels ? [s.levels.join(' '), s.completed.join(' ')] : []),
      s.duration_s,
      ...(has.frames ? [s.p95] : []),
      ...(has.deaths ? [s.deaths] : []),
      s.errors,
      outcome(s),
    ]),
  ];
}

// Error issues as the Errors view lists them.
export function issuesCsv(issues) {
  return [
    ['Kind', 'Message', 'Location', 'Levels', 'Count', 'Sessions', 'Sessions %', 'Versions', 'Last seen', 'Fingerprint'],
    ...issues.map((i) => [i.kind, i.message, i.location, (i.levels || []).join(' '), i.count, i.sessions, i.sessions_pct, (i.versions || []).join(' '), iso(i.last_seen), i.fingerprint]),
  ];
}

// The Events view's table, with each event's sums (server/src/sums.js) after its counts.
export function eventsCsv(events) {
  const sums = [...new Set(events.flatMap((e) => (e.sums || []).map((x) => sumHeader(x.attr, x.currency))))];
  return [
    ['Event', 'SDK', 'Count', 'Sessions', 'Sessions %', 'Per session', ...sums.map((h) => `Sum of ${h}`)],
    ...events.map((e) => {
      const by = new Map((e.sums || []).map((x) => [sumHeader(x.attr, x.currency), x.sum]));
      return [e.name, e.sdk ? 'yes' : '', e.count, e.sessions, e.sessions_pct, e.per_session, ...sums.map((h) => by.get(h) ?? null)];
    }),
  ];
}

export function reportsCsv(reports) {
  return [
    ['Time', 'Level', 'Version', 'Note', 'Position', 'Device', 'Screenshot', ...(reports.some((r) => 'session_id' in r) ? ['Session'] : [])],
    ...reports.map((r) => [
      iso(r.ts),
      r.level,
      r.version,
      r.note,
      r.position ? [r.position.x, r.position.y, r.position.z].map((v) => v ?? '').join(' ') : null,
      r.device,
      r.has_screenshot ? 'yes' : 'no',
      ...('session_id' in r ? [r.session_id] : []),
    ]),
  ];
}

// Live events as the feed lists them; `line` is the feed's own one-line detail.
export function liveCsv(events, line = () => '') {
  return [['Time', 'Event', 'Level', 'Version', 'Session', 'Detail'], ...events.map((e) => [iso(e.ts), e.type === 'custom' ? e.name : e.type, e.level, e.version, e.session_id, line(e)])];
}
