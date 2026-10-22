// Dashboards and boards: every game gets a dashboard that fits it. Games differ (a platformer cares where
// players die, a puzzle game how long a puzzle takes, a mobile game whether the paywall turns into
// purchases), so nothing here assumes a genre.
//
// A game's dashboard is its list of pages. A page is either a board, panels in the game's own words, or
// one of the built-in views (VIEWS), which a game keeps, renames, reorders or drops. It is saved per game
// (service): the coding agent writes it over MCP while it instruments the game, and people edit it in the
// dashboard. A game without one gets the automatic dashboard: an Overview board made from what it sends,
// then the built-in views it has data for (no Performance without frame times, no Heatmaps without
// positions).
//
//   { pages: [{ id, title, icon, panels: [...] } | { id, title, icon, view, options }] }
//
// Board panels each take { type, title, note, size: 's' | 'm' | 'l' }:
//
//   stat        one number: `metric` (a built-in, see STATS), or `event` (a count of matching events),
//               optionally `per` another event, which makes it a percentage ("buy=done" per "paywall")
//   series      an event's count over time, optionally split `by` an attribute (top `limit` values)
//   breakdown   how an event's attribute values compare (`event`, `by`, `limit`)
//               (`by` can also be $version or $level, which every event has: purchases by version)
//   funnel      sessions that went through `steps` in order ("paywall,buy=tapped,buy=done")
//   levels      starts, completions, fails and deaths per level; `label` is what the game calls a level
//   frame_time  frame-time p50 and p95 over time against the frame budget
//   errors      the top error issues (`limit`)
//   deaths      deaths by level and cause
//   events      every custom event the game sends, with counts and sessions
//   findings    the ranked findings (`limit`)
//   sessions    recent sessions, optionally only those that `sent` an event (`limit`)
//   versions    this page's stat panels, version by version
//   live        events as they arrive, optionally only `events` (names or types)
//
// Events are written as funnel steps are (analytics.js parseFunnel): "name", "name=value" or "name:key=value".

import { overview, funnel as levelFunnel, errorIssues, customEvents, eventCount, eventsBy, eventFunnel, parseFunnel, eventIndex, sessionsList, versions, cellsOf, round } from './analytics.js';
import { findings } from './findings.js';

export const PANEL_TYPES = ['stat', 'series', 'breakdown', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live'];
export const SIZES = { s: 3, m: 6, l: 12 };
// Built-in numbers a stat panel can show, from the overview's KPIs.
export const STATS = {
  sessions: { label: 'Sessions' },
  players: { label: 'Players' },
  avg_session_s: { label: 'Average session', unit: 's' },
  crash_free_pct: { label: 'Crash-free sessions', unit: '%' },
  error_free_pct: { label: 'Error-free sessions', unit: '%' },
  frame_p95: { label: 'Frame time p95', unit: 'ms' },
  avg_fps: { label: 'Average FPS' },
  hitches_per_min: { label: 'Hitches per minute' },
  errors: { label: 'Errors' },
  deaths: { label: 'Deaths' },
  rage_quit_pct: { label: 'Rage quits', unit: '%' },
};
// The built-in views a page can be, with their default title and icon.
export const VIEWS = {
  events: { title: 'Events', icon: 'events' },
  performance: { title: 'Performance', icon: 'perf' },
  errors: { title: 'Errors', icon: 'errors' },
  players: { title: 'Players', icon: 'players' },
  heatmaps: { title: 'Heatmaps', icon: 'heatmap' },
  sessions: { title: 'Sessions', icon: 'sessions' },
  versions: { title: 'Versions', icon: 'versions' },
  live: { title: 'Live Tail', icon: 'live' },
};
export const ICONS = ['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock'];
const MAX_PANELS = 24;
const MAX_PAGES = 20;
// Dimensions every event has, for `by`: $version and $level.
const DIMENSIONS = ['version', 'level'];

export class BoardError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ───────────────────────────── dashboards ─────────────────────────────

// A dashboard as given (by an agent or the dashboard editor) → as stored, or BoardError saying what to fix.
export function validateDashboard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BoardError('a dashboard is an object: { pages: [...] }');
  if (!Array.isArray(input.pages) || !input.pages.length) throw new BoardError('pages must be a non-empty array');
  if (input.pages.length > MAX_PAGES) throw new BoardError(`at most ${MAX_PAGES} pages`);
  const ids = new Set();
  const pages = input.pages.map((p, i) => {
    const at = `pages[${i}]`;
    if (!p || typeof p !== 'object') throw new BoardError(`${at} must be an object`);
    if ((p.view == null) === (p.panels == null)) throw new BoardError(`${at} is either a board (panels) or a built-in view (view: ${Object.keys(VIEWS).join(', ')})`);
    if (p.view != null && !VIEWS[p.view]) throw new BoardError(`${at}.view must be one of ${Object.keys(VIEWS).join(', ')}`);
    const title = text(p.title, 40) || (p.view ? VIEWS[p.view].title : null);
    if (!title) throw new BoardError(`${at} needs a title`);
    const id = slug(p.id || p.view || title);
    if (!id) throw new BoardError(`${at}.id must have letters or digits`);
    if (ids.has(id)) throw new BoardError(`${at}.id "${id}" is used twice; give each page its own id`);
    ids.add(id);
    if (p.icon != null && !ICONS.includes(p.icon)) throw new BoardError(`${at}.icon must be one of ${ICONS.join(', ')}`);
    const page = { id, title, ...(p.icon ? { icon: p.icon } : {}) };
    if (p.view) return { ...page, view: p.view, ...viewOptions(p, at) };
    return { ...page, ...validateBoard({ panels: p.panels }, at) };
  });
  return { pages };
}

function viewOptions(p, at) {
  if (p.options == null) return {};
  if (typeof p.options !== 'object' || Array.isArray(p.options)) throw new BoardError(`${at}.options must be an object`);
  if (p.view === 'live' && p.options.events != null) return { options: { events: names(p.options.events, `${at}.options.events`) } };
  return {};
}

// The dashboard of a game that has saved none: an Overview board, then the built-in views it has data for.
export function autoDashboard(ctx) {
  const k = kpis(ctx);
  const own = customEvents(ctx).events.filter((e) => !e.sdk);
  const positions = cellsOf(ctx).some(({ c }) => c.n.pos);
  const view = (v) => ({ id: v, title: VIEWS[v].title, icon: VIEWS[v].icon, view: v });
  return {
    pages: [
      { id: 'overview', title: 'Overview', icon: 'overview', ...autoBoard(ctx) },
      ...(own.length ? [view('events')] : []),
      ...(k.frame_p95 != null ? [view('performance')] : []),
      view('errors'),
      view('players'),
      ...(positions ? [view('heatmaps')] : []),
      view('sessions'),
      view('versions'),
      view('live'),
    ],
  };
}

// ───────────────────────────── boards ─────────────────────────────

// One board's panels → as stored, or BoardError saying what to fix. `where` prefixes the messages.
export function validateBoard(input, where = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BoardError('a board is an object: { panels: [...] }');
  if (!Array.isArray(input.panels) || !input.panels.length) throw new BoardError(`${where ? `${where}.` : ''}panels must be a non-empty array`);
  if (input.panels.length > MAX_PANELS) throw new BoardError(`${where ? `${where}: ` : ''}at most ${MAX_PANELS} panels`);
  return { panels: input.panels.map((p, i) => validatePanel(p, `${where ? `${where}.` : ''}panels[${i}]`)) };
}

function validatePanel(p, at) {
  if (!p || typeof p !== 'object') throw new BoardError(`${at} must be an object`);
  if (!PANEL_TYPES.includes(p.type)) throw new BoardError(`${at}.type must be one of ${PANEL_TYPES.join(', ')}`);
  const out = { type: p.type };
  if (text(p.title, 80)) out.title = text(p.title, 80);
  if (text(p.note, 200)) out.note = text(p.note, 200);
  if (p.size != null) {
    if (!SIZES[p.size]) throw new BoardError(`${at}.size must be s, m or l`);
    out.size = p.size;
  }
  const need = (k) => {
    if (!text(p[k], 200)) throw new BoardError(`${at} (${p.type}) needs ${k}`);
    return text(p[k], 200);
  };
  const event = (k) => {
    const v = need(k);
    if (parseFunnel(v).length !== 1) throw new BoardError(`${at}.${k} is one event: "name", "name=value" or "name:key=value"`);
    return v;
  };
  const by = (required) => {
    if (p.by == null && !required) return;
    const v = need('by');
    if (v.startsWith('$') && !DIMENSIONS.includes(v.slice(1))) throw new BoardError(`${at}.by is an attribute name, or $version or $level`);
    out.by = v;
  };
  const limit = (max) => {
    if (p.limit == null) return;
    if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > max) throw new BoardError(`${at}.limit must be 1 to ${max}`);
    out.limit = p.limit;
  };
  switch (p.type) {
    case 'stat':
      if ((p.metric == null) === (p.event == null)) throw new BoardError(`${at} (stat) needs either metric (${Object.keys(STATS).join(', ')}) or event`);
      if (p.metric != null) {
        if (!STATS[p.metric]) throw new BoardError(`${at}.metric must be one of ${Object.keys(STATS).join(', ')}`);
        out.metric = p.metric;
      } else {
        out.event = event('event');
        if (p.per != null) out.per = event('per');
      }
      break;
    case 'series':
      out.event = event('event');
      by(false);
      limit(8);
      break;
    case 'breakdown':
      out.event = event('event');
      by(true);
      limit(20);
      break;
    case 'funnel': {
      const steps = parseFunnel(need('steps'));
      if (steps.length < 2) throw new BoardError(`${at}.steps needs at least two events, comma-separated`);
      out.steps = p.steps.trim();
      break;
    }
    case 'levels':
      if (text(p.label, 24)) out.label = text(p.label, 24);
      break;
    case 'errors':
    case 'findings':
      limit(20);
      break;
    case 'sessions':
      limit(50);
      if (p.sent != null) out.sent = event('sent');
      break;
    case 'live':
      if (p.events != null) out.events = names(p.events, `${at}.events`);
      break;
  }
  return out;
}

// A board for a game that has none: the numbers every game has, then the game's own events, then the
// sections it sends data for. Nothing appears that would only show zeros.
export function autoBoard(ctx) {
  const k = kpis(ctx);
  const panels = [
    { type: 'stat', metric: 'sessions' },
    { type: 'stat', metric: 'players' },
    { type: 'stat', metric: 'avg_session_s' },
  ];
  if (k.frame_p95 != null) panels.push({ type: 'stat', metric: 'frame_p95' });
  else if (k.errors) panels.push({ type: 'stat', metric: 'crash_free_pct' });
  // What stands out, ranked (findings.js): the question every game has, whatever it measures.
  panels.push({ type: 'findings', limit: 4, size: 'l' });
  const own = customEvents(ctx).events.filter((e) => !e.sdk);
  for (const e of own.slice(0, 4)) {
    const attr = e.attrs.find((a) => a.values.length >= 2 && a.values.length <= 20);
    panels.push(attr ? { type: 'breakdown', event: e.name, by: attr.key, title: `${e.name} by ${attr.key}`, size: 'm' } : { type: 'series', event: e.name, title: e.name, size: 'm' });
  }
  if (levelFunnel(ctx).length) panels.push({ type: 'levels', size: 'l' });
  if (k.frame_p95 != null) panels.push({ type: 'frame_time', size: 'm' });
  if (k.errors) panels.push({ type: 'errors', size: 'm' });
  if (k.deaths) panels.push({ type: 'deaths', size: 'm' });
  if (own.length) panels.push({ type: 'events', size: 'l' });
  return { panels };
}

// Each panel with its data. A panel whose data isn't there yet (an event the game hasn't sent in this
// window) gets `empty: true` and a line saying why, never zeros that look like a measurement. `maps` are
// the game's level maps (for findings).
export function evaluateBoard(ctx, board, { maps = [] } = {}) {
  return board.panels.map((p, id) => {
    const data = panelData(ctx, p, board, maps);
    return { id, ...p, size: p.size || defaultSize(p), title: p.title || defaultTitle(p), ...data };
  });
}

function panelData(ctx, p, board, maps) {
  switch (p.type) {
    case 'stat': {
      if (p.metric) {
        const value = kpis(ctx)[p.metric];
        return value == null ? { empty: true, why: `No ${STATS[p.metric].label.toLowerCase()} in this window.` } : { value, unit: STATS[p.metric].unit || null };
      }
      const [f] = parseFunnel(p.event);
      const count = eventCount(ctx, f);
      if (!p.per) return count || hasEvent(ctx, f.name) ? { value: count, unit: null } : missing(f.name);
      const [g] = parseFunnel(p.per);
      const base = eventCount(ctx, g);
      return base ? { value: round((count / base) * 100, 1), unit: '%', count, base } : missing(g.name);
    }
    case 'series': {
      const [f] = parseFunnel(p.event);
      if (!hasEvent(ctx, f.name)) return missing(f.name);
      if (!p.by) return { ts: ctx.buckets, series: [{ label: p.event, values: eventCount(ctx, f, 'series') }] };
      let values;
      if (p.by.startsWith('$')) values = eventsBy(ctx, f, p.by.slice(1));
      else {
        const a = eventIndex(ctx).get(f.name).attrs.get(p.by);
        if (!a) return { empty: true, why: `"${f.name}" events have no "${p.by}" attribute in this window.` };
        values = [...a.values.values()].sort((x, y) => y.count - x.count);
      }
      const top = values.slice(0, p.limit || 5);
      const rest = values.slice(top.length);
      const series = top.map((x) => ({ label: x.value, values: x.series }));
      if (rest.length) series.push({ label: 'other', values: ctx.buckets.map((_, i) => rest.reduce((s, x) => s + x.series[i], 0)) });
      return { ts: ctx.buckets, series };
    }
    case 'breakdown': {
      const [f] = parseFunnel(p.event);
      if (p.by.startsWith('$')) {
        const rows = eventsBy(ctx, f, p.by.slice(1)).map(({ series, ...r }) => r);
        if (!rows.length) return missing(f.name);
        const top = rows.slice(0, p.limit || 10);
        return { total: rows.reduce((s, r) => s + r.count, 0), sessions: null, rows: top, more: rows.length - top.length, avg: null };
      }
      const e = customEvents(ctx, { name: f.name, sdk: true }).events[0];
      if (!e) return missing(f.name);
      const a = e.attrs.find((x) => x.key === p.by);
      if (!a) return { empty: true, why: `"${f.name}" events have no "${p.by}" attribute in this window.` };
      const top = a.values.slice(0, p.limit || 10);
      return { total: e.count, sessions: e.sessions, rows: top, more: a.values.length - top.length, avg: a.avg };
    }
    case 'funnel': {
      const steps = eventFunnel(ctx, parseFunnel(p.steps));
      return steps[0].sessions ? { steps } : { steps, empty: true, why: `No session sent "${steps[0].step}" in this window.` };
    }
    case 'levels': {
      const rows = levelFunnel(ctx);
      if (!rows.length) return { empty: true, why: 'The game sends no level events (levelStart, levelComplete, levelFail).' };
      // Columns only for what the game reports: a puzzle game with no deaths shows no deaths column.
      const has = { completion: rows.some((r) => r.completed), fails: rows.some((r) => r.fails), deaths: rows.some((r) => r.deaths), time: rows.some((r) => r.avg_complete_s != null), rage_quits: rows.some((r) => r.rage_quits) };
      return { rows, has };
    }
    case 'frame_time': {
      const o = cachedOverview(ctx);
      if (o.kpis.frame_p95 == null) return { empty: true, why: 'No frame times in this window.' };
      return { ts: o.series.ts, p50: o.series.p50, p95: o.series.p95, budget_ms: o.kpis.frame_budget_ms, kpis: { p50: o.kpis.frame_p50, p95: o.kpis.frame_p95, avg_fps: o.kpis.avg_fps } };
    }
    case 'errors': {
      const issues = errorIssues(ctx).slice(0, p.limit || 5);
      return issues.length ? { issues: issues.map(({ fingerprint, message, kind, count, sessions, last_seen, levels }) => ({ fingerprint, message, kind, count, sessions, last_seen, levels })) } : { empty: true, why: 'No errors in this window.' };
    }
    case 'deaths': {
      const rows = levelFunnel(ctx).filter((l) => l.deaths);
      return rows.length ? { rows: rows.map((l) => ({ level: l.level, deaths: l.deaths, causes: l.death_causes })) } : { empty: true, why: 'No deaths in this window.' };
    }
    case 'events': {
      const events = customEvents(ctx).events.map(({ series, attrs, ...e }) => ({ ...e, attrs: attrs.map((a) => a.key) }));
      return events.length ? { events } : { empty: true, why: 'The game sends no custom events yet (track()).' };
    }
    case 'findings': {
      const list = findings(ctx, maps).slice(0, p.limit || 5);
      return list.length ? { findings: list } : { empty: true, why: 'Nothing stands out in this window.' };
    }
    case 'sessions': {
      const [f] = p.sent ? parseFunnel(p.sent) : [];
      const rows = sessionsList(ctx, { limit: p.limit || 10, sent: f });
      return rows.length ? { sessions: rows } : { empty: true, why: f ? `No session sent "${p.sent}" in this window.` : 'No sessions in this window.' };
    }
    case 'versions': {
      // This page's stat panels, version by version: what a release changed, in this page's terms.
      const stats = board.panels.filter((x) => x.type === 'stat');
      const list = versions(ctx, { stats, events: 0 });
      if (!list.length) return { empty: true, why: 'No versions in this window.' };
      if (!stats.length) return { empty: true, why: 'This page has no stat panels to compare.' };
      return { columns: versionColumns(stats), rows: list.map((v) => ({ version: v.version, sessions: v.sessions, first_seen: v.first_seen, values: v.board })) };
    }
    case 'live':
      return { live: true };
  }
  return {};
}

// The stat panels of every board on a dashboard, once each: what versions are compared on.
export function dashboardStats(dashboard) {
  const seen = new Set();
  const out = [];
  for (const p of dashboard.pages.flatMap((page) => page.panels || [])) {
    const key = p.type === 'stat' && (p.metric || `${p.event}/${p.per || ''}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, 12);
}

// Stat panels as the columns of a version comparison. Versions are compared per session, so a count of
// events (or errors, or deaths) is shown per session there.
export function versionColumns(stats) {
  return stats.map((s) => ({ title: s.title || defaultTitle(s), unit: s.metric ? (PER_SESSION.has(s.metric) ? 'per session' : STATS[s.metric].unit || null) : s.per ? '%' : 'per session', metric: s.metric, event: s.event, per: s.per }));
}
const PER_SESSION = new Set(['errors', 'deaths']);

function defaultSize(p) {
  if (p.type === 'stat') return 's';
  if (['levels', 'events', 'sessions', 'versions', 'live'].includes(p.type)) return 'l';
  return 'm';
}

function defaultTitle(p) {
  const by = (k) => (k?.startsWith('$') ? k.slice(1) : k);
  switch (p.type) {
    case 'stat':
      return p.metric ? STATS[p.metric].label : p.per ? `${p.event} per ${p.per}` : p.event;
    case 'series':
      return p.by ? `${p.event} by ${by(p.by)}` : p.event;
    case 'breakdown':
      return `${p.event} by ${by(p.by)}`;
    case 'funnel':
      return p.steps
        .split(',')
        .map((s) => s.trim())
        .join(' → ');
    case 'levels':
      return p.label ? `${p.label}s` : 'Levels';
    case 'frame_time':
      return 'Frame time';
    case 'errors':
      return 'Top errors';
    case 'deaths':
      return 'Deaths';
    case 'events':
      return 'All events';
    case 'findings':
      return 'Findings';
    case 'sessions':
      return p.sent ? `Sessions that sent ${p.sent}` : 'Recent sessions';
    case 'versions':
      return 'By version';
    case 'live':
      return 'Live';
  }
  return p.type;
}

function missing(name) {
  return { empty: true, why: `No "${name}" events in this window.` };
}

function hasEvent(ctx, name) {
  return eventIndex(ctx).has(name);
}

function cachedOverview(ctx) {
  return (ctx.overviewCache ??= overview(ctx));
}

function kpis(ctx) {
  const o = cachedOverview(ctx);
  return { ...o.kpis, avg_session_s: o.kpis.sessions ? o.kpis.avg_session_s : null };
}

function names(list, at) {
  if (!Array.isArray(list) || list.length > 20 || !list.every((x) => typeof x === 'string' && x.trim() && x.length <= 64)) throw new BoardError(`${at} is a list of up to 20 event names or types`);
  return list.map((x) => x.trim());
}

function slug(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function text(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}
