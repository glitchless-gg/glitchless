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
//   { currency?, pages: [{ id, title, icon, panels: [...] } | { id, title, icon, view, options }] }
//
// `currency` (ISO 4217, e.g. "USD") is the game's one currency for money (sums.js): without it, the one most
// of its events were sent in.
//
// Board panels each take { type, title, note, size: 's' | 'm' | 'l' }:
//
//   stat        one number: `metric` (a built-in, see STATS), or `event` (a count of matching events),
//               optionally `per` another event, which makes it a percentage ("buy=done" per "paywall"), or
//               `per` $players or $sessions: the share of them that sent the event (conversion). With `sum`
//               (a numeric attribute, e.g. "amount") it adds that up instead (revenue), and `per` $players or
//               $sessions divides it by them (revenue per player); metric players_now is the sessions playing
//               now, whatever the range
//   series      an event's count over time, optionally split `by` an attribute (top `limit` values); with
//               `sum`, the attribute's sum over time
//   breakdown   how an event's attribute values compare (`event`, `by`, `limit`), by count or by `sum`
//               (`by` can also be $version or $level, which every event has: purchases by version, or a
//               Steam fact of the session that sent it, such as $steam_branch, counted by count only)
//               Both take `by` $platform, $browser or $device_tier: the platform, browser or GPU tier of the
//               sessions that sent the event (Windows, macOS, Steam Deck, iOS, Android…; Chrome, Safari…; high to
//               low), counted (no sum); without `event`, the sessions in each (and their players)
//   funnel      sessions that went through `steps` in order ("paywall,buy=tapped,buy=done")
//   levels      starts, completions, fails and deaths per level; `label` is what the game calls a level
//   frame_time  frame-time p50 and p95 over time against the frame budget
//   errors      the top error issues (`limit`)
//   deaths      deaths by level and cause
//   events      every custom event the game sends, with counts and sessions
//   findings    the ranked findings (`limit`)
//   sessions    recent sessions, optionally only those that `sent` an event (`limit`)
//   reports     the latest bug reports players sent, with their notes (`limit`)
//   store_reviews, store_players, store_sales   a store's reviews by build, players online next to the sessions
//               measured, units, returns and wishlists (reviews.js), for a game connected to a store (`store`)
//   store_revenue  a revenue source's (RevenueCat's or Stripe's) revenue in the window, revenue per player measured,
//               installs or active users next to the players measured, MRR, active subscriptions or trials, revenue or
//               installs and active users per day, or revenue by version next to Glitchless's; Stripe's refunds, new
//               paying customers and revenue by product (`measure`, revenue.js); money in the source's currency,
//               never converted
//   retention   D1, D7 and D30 by the day players were first seen (the latest `limit` days); needs player IDs
//   versions    this page's stat panels, version by version; `by` a Steam fact ($steam_branch, $steam_build)
//               compares Steam branches or builds instead: the beta against public
//   live        events as they arrive, optionally only `events` (names or types)
//   positions   where players died on one `level`, and with `show` 'path' or 'both' where they went, as
//               counts per `bin` world units (analytics.js levelPositions); counts only, so a game can read
//               it through a share link and draw its own dead (`show` defaults to 'deaths')
//
// Events are written as funnel steps are (analytics.js parseFunnel): "name", "name=value" or "name:key=value".

import { overview, funnel as levelFunnel, errorIssues, customEvents, eventCount, eventsBy, eventFunnel, parseFunnel, eventIndex, sessionsList, versions, retention, cellsOf, levelPositions, sessionsBy, SESSION_SPLITS, round } from './analytics.js';
import { findings } from './findings.js';
import { STEAM_DIMENSIONS } from './analytics.js';
import { reportSummary } from './reports.js';
import { sumsBy, senders } from './sums.js';
import { STORE_PANELS, storePanel, storePages, storePanelFields } from './reviews.js';

export const PANEL_TYPES = ['stat', 'series', 'breakdown', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live', 'reports', 'retention', 'positions'];
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
  players_now: { label: 'Playing now' },
};
// Stats of this moment rather than the range: no version has a value of them.
const LIVE_STATS = new Set(['players_now']);
// Store panels (reviews.js), for a game connected to a store.
PANEL_TYPES.push(...Object.keys(STORE_PANELS));
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
  reports: { title: 'Bug Reports', icon: 'bug' },
};
export const ICONS = ['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock', 'bug', 'money'];
const MAX_PANELS = 24;
const MAX_PAGES = 20;
// Dimensions every event has, for `by`: $version and $level.
const DIMENSIONS = ['version', 'level'];
// What series and breakdowns can split sessions by (analytics.js SESSION_SPLITS): $platform, $browser, $device_tier.
const SESSION_BY = Object.keys(SESSION_SPLITS).map((k) => `$${k}`);
const SESSION_WORDS = SESSION_BY.join(', ').replace(/, ([^,]+)$/, ' or $1');
// What a Steam fact (analytics.js STEAM_DIMENSIONS) is called in a panel's title.
const STEAM_LABELS = { steam_branch: 'Steam branch', steam_build: 'Steam build', steam_hardware: 'Steam hardware', steam_controller: 'controller', steam_language: 'Steam language', proton: 'Proton', big_picture: 'Big Picture', family_shared: 'Family Sharing', timed_trial: 'timed trial' };
const STEAM_BY = STEAM_DIMENSIONS.map((d) => `$${d}`);
// What a stat's `per` can be besides an event: every player or session in the window.
const PER = { $players: 'player', $sessions: 'session' };
// What a positions panel draws: where players died, where they went, or both.
const SHOW = ['deaths', 'path', 'both'];

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
  const currency = input.currency == null ? null : String(input.currency).trim().toUpperCase();
  if (currency != null && !/^[A-Z]{3}$/.test(currency)) throw new BoardError('currency is a three-letter ISO 4217 code, e.g. "USD"');
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
  return { ...(currency ? { currency } : {}), pages };
}

function viewOptions(p, at) {
  if (p.options == null) return {};
  if (typeof p.options !== 'object' || Array.isArray(p.options)) throw new BoardError(`${at}.options must be an object`);
  if (p.view === 'live' && p.options.events != null) return { options: { events: names(p.options.events, `${at}.options.events`) } };
  return {};
}

// The dashboard of a game that has saved none: an Overview board, then the built-in views it has data for
// (Bug Reports once players have sent some: ctx.reports).
export function autoDashboard(ctx) {
  const k = kpis(ctx);
  const own = customEvents(ctx).events.filter((e) => !e.sdk);
  const positions = cellsOf(ctx).some(({ c }) => c.n.pos);
  const view = (v) => ({ id: v, title: VIEWS[v].title, icon: VIEWS[v].icon, view: v });
  return {
    pages: [
      { id: 'overview', title: 'Overview', icon: 'overview', ...autoBoard(ctx) },
      ...storePages(ctx, { frames: k.frame_p95 != null }),
      ...(own.length ? [view('events')] : []),
      ...(k.frame_p95 != null ? [view('performance')] : []),
      view('errors'),
      ...(ctx.reports?.length ? [view('reports')] : []),
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
  // A Steam fact ($steam_branch…) splits a breakdown by the sessions that sent the event (`steam`), not a series.
  // $platform splits either by the sessions' platform.
  const by = (required, { steam = false } = {}) => {
    if (p.by == null && !required) return;
    const v = need('by');
    if (STEAM_BY.includes(v)) {
      if (!steam) throw new BoardError(`${at}.by: a ${p.type} can't be split by ${v} (sessions count their events, not per minute); use a breakdown, a versions panel with by ${v}, or filter the board (?${v.slice(1)}=…)`);
    } else if (v.startsWith('$') && !SESSION_BY.includes(v) && !DIMENSIONS.includes(v.slice(1))) throw new BoardError(`${at}.by is an attribute name, or $version, $level, ${SESSION_WORDS}${steam ? `, or a Steam fact of the session (${STEAM_BY.join(', ')})` : ''}`);
    out.by = v;
  };
  // A series or breakdown by $platform, $browser or $device_tier without an event counts the sessions in each.
  const eventOrSessions = () => {
    if (p.event == null && SESSION_BY.includes(p.by)) {
      if (p.sum != null) throw new BoardError(`${at}.sum goes with event`);
      return;
    }
    out.event = event('event');
  };
  const limit = (max) => {
    if (p.limit == null) return;
    if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > max) throw new BoardError(`${at}.limit must be 1 to ${max}`);
    out.limit = p.limit;
  };
  const sum = () => {
    if (p.sum == null) return;
    const v = text(p.sum, 64);
    if (!v || v.startsWith('$')) throw new BoardError(`${at}.sum is a numeric attribute of the event to add up, e.g. "amount"`);
    out.sum = v;
  };
  // Sums are kept per name and one attribute value, so a sum split by an attribute takes the event by name.
  const sumSplit = () => {
    if (out.sum && out.by && !out.by.startsWith('$') && parseFunnel(out.event)[0].value != null) throw new BoardError(`${at}: with sum and by an attribute, event is a name only ("purchase", not "purchase=done")`);
    if (out.sum && STEAM_BY.includes(out.by)) throw new BoardError(`${at}: a sum can't be split by ${out.by} (sums are kept per minute, not per session); count instead, or filter the board (?${out.by.slice(1)}=…)`);
    if (out.sum && SESSION_BY.includes(out.by)) throw new BoardError(`${at}: a sum can't be split by ${out.by} (sums are kept per minute, not per session); count instead${out.by === '$platform' ? ', or for revenue by store a store_revenue panel with measure by_store' : ''}`);
  };
  switch (p.type) {
    case 'stat':
      if ((p.metric == null) === (p.event == null)) throw new BoardError(`${at} (stat) needs either metric (${Object.keys(STATS).join(', ')}) or event`);
      if (p.metric != null) {
        if (!STATS[p.metric]) throw new BoardError(`${at}.metric must be one of ${Object.keys(STATS).join(', ')}`);
        if (p.sum != null) throw new BoardError(`${at}.sum goes with event, not metric`);
        out.metric = p.metric;
      } else {
        out.event = event('event');
        sum();
        if (p.per != null) {
          if (PER[p.per]) out.per = p.per;
          else if (out.sum) throw new BoardError(`${at}.per with sum is $players or $sessions (revenue per player or per session)`);
          else out.per = event('per');
        }
      }
      break;
    case 'series':
      eventOrSessions();
      sum();
      by(false);
      sumSplit();
      limit(8);
      break;
    case 'breakdown':
      eventOrSessions();
      sum();
      by(true, { steam: true });
      sumSplit();
      limit(20);
      break;
    case 'versions':
      if (p.by != null) {
        if (!STEAM_BY.includes(p.by)) throw new BoardError(`${at}.by compares sessions by a Steam fact: ${STEAM_BY.join(', ')}`);
        out.by = p.by;
      }
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
    case 'reports':
      limit(20);
      break;
    case 'retention':
      limit(90);
      break;
    case 'sessions':
      limit(50);
      if (p.sent != null) out.sent = event('sent');
      break;
    case 'live':
      if (p.events != null) out.events = names(p.events, `${at}.events`);
      break;
    case 'positions':
      out.level = need('level');
      if (p.show != null) {
        if (!SHOW.includes(p.show)) throw new BoardError(`${at}.show must be one of ${SHOW.join(', ')}`);
        out.show = p.show;
      }
      if (p.bin != null) {
        if (typeof p.bin !== 'number' || !Number.isFinite(p.bin) || p.bin <= 0) throw new BoardError(`${at}.bin is a bin's width in world units, a number above 0`);
        out.bin = p.bin;
      }
      break;
  }
  if (STORE_PANELS[p.type]) Object.assign(out, storePanelFields(p, at, BoardError));
  return out;
}

// The levels a board's positions panels draw paths for: a store without raw events reads those levels'
// position samples apart (q.positions, app.js).
export function pathLevels(page) {
  return [...new Set((page?.panels || []).filter((p) => p.type === 'positions' && (p.show === 'path' || p.show === 'both')).map((p) => p.level))];
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
// the game's level maps (for findings, and the plane and bounds of positions), `currency` the dashboard's.
// `shared`: for a share link's reader (app.js; its share, or true), see forShare.
export function evaluateBoard(ctx, board, { maps = [], shared = false, currency = null } = {}) {
  return board.panels.map((p, id) => {
    const data = shared ? (STORE_PANELS[p.type] ? sharedStorePanel(ctx, p, shared, currency) : forShare(p, ctx, board, maps, currency, shared)) : panelData(ctx, p, board, maps, currency);
    return { id, ...p, size: p.size || defaultSize(p), title: p.title || defaultTitle(p), ...data };
  });
}

// A panel as a share link shows it to anyone who has the link: sessions without session or player ids or
// devices, errors and findings without stacks, code locations or breadcrumbs, positions as counts per bin,
// and no live events. Fields are kept by name and panels by type, so whatever is added later stays out
// until it is listed here. Sums (revenue) are a game's business: hidden unless the link was made to show
// them (`shared.sums`). Conversion stays: it is a share, not an amount.
const SHARED_AS_IS = new Set(['stat', 'series', 'breakdown', 'funnel', 'levels', 'frame_time', 'deaths', 'events', 'versions', 'retention']);
const SHARED_SESSION = ['version', 'env', 'session_type', 'start', 'duration_s', 'levels', 'completed', 'deaths', 'errors', 'hitches', 'p50', 'p95', 'crashed', 'rage_quit', 'ended', 'ttff_ms', 'events'];
const SHARED_ISSUE = ['fingerprint', 'message', 'kind', 'count', 'sessions', 'last_seen', 'levels'];
const SHARED_FINDING = ['id', 'severity', 'category', 'title', 'summary', 'suggestion', 'impact', 'impact_pct'];
const SHARED_POSITIONS = ['level', 'axis', 'bounds', 'bin', 'deaths', 'total', 'truncated'];
const SHARED_PATH = ['bin', 'cells', 'samples', 'truncated'];
function forShare(p, ctx, board, maps, currency, shared) {
  const redacted = p.type === 'sessions' || p.type === 'errors' || p.type === 'findings' || p.type === 'positions';
  if (!SHARED_AS_IS.has(p.type) && !redacted) return { empty: true, why: `${p.type === 'live' ? 'Live events are' : 'This panel is'} not shown on a shared board.` };
  const sums = shared?.sums === true;
  if (p.sum && !sums) return { empty: true, why: 'Sums such as revenue are not shown on this shared board.' };
  const data = panelData(ctx, p, board, maps, currency);
  if (p.type === 'versions' && !data.empty && !sums) {
    const hidden = data.columns.map((c) => !!c.sum);
    return { ...data, columns: data.columns.map((c, i) => (hidden[i] ? { ...c, hidden: true } : c)), rows: data.rows.map((r) => ({ ...r, values: r.values.map((v, i) => (hidden[i] ? null : v)) })) };
  }
  if (data.empty || !redacted) return data;
  if (p.type === 'sessions') return { sessions: data.sessions.map((s) => ({ ...pick(s, SHARED_SESSION), rage: s.rage ? { level: s.rage.level } : null })) };
  if (p.type === 'errors') return { issues: data.issues.map((i) => pick(i, SHARED_ISSUE)) };
  if (p.type === 'positions') return { ...pick(data, SHARED_POSITIONS), ...(data.path ? { path: pick(data.path, SHARED_PATH) } : {}) };
  // An error's summary names its breadcrumbs and its suggested fix its code location, and a bug report's
  // quotes what players typed: say how often instead.
  return {
    findings: data.findings.map((f) => {
      if (f.category === 'stability') return { ...pick(f, SHARED_FINDING), summary: errorLine(f.evidence), suggestion: null };
      if (f.category === 'reports') return { ...pick(f, SHARED_FINDING), summary: reportLine(f.evidence), suggestion: null };
      return pick(f, SHARED_FINDING);
    }),
  };
}

function reportLine(e = {}) {
  return `${e.reports} bug reports from ${e.sessions} ${e.sessions === 1 ? 'session' : 'sessions'} on ${e.level}.`;
}

function errorLine(e = {}) {
  return `${e.count} occurrences in ${e.sessions} sessions${e.levels?.length ? ` on ${e.levels.join(', ')}` : ''}.`;
}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

// A store panel on a share link: reviews and players as counts (never what players wrote); units, returns,
// wishlists and revenue only on a link made to show sums.
function sharedStorePanel(ctx, p, shared, currency) {
  if (STORE_PANELS[p.type].shared === true || shared?.sums === true) return storePanel(ctx, p, { currency });
  return { empty: true, why: p.type === 'store_revenue' ? 'Revenue is not shown on this shared board.' : 'Units, returns and wishlists are not shown on this shared board.' };
}

function panelData(ctx, p, board, maps, currency) {
  if (STORE_PANELS[p.type]) return storePanel(ctx, p, { currency });
  switch (p.type) {
    case 'stat': {
      // Counted by the server as batches arrive (app.js), not from the range.
      if (p.metric === 'players_now') return ctx.playersNow == null ? { empty: true, why: 'This server does not count players now.' } : { value: ctx.playersNow, unit: null };
      if (p.metric) {
        const value = kpis(ctx)[p.metric];
        return value == null ? { empty: true, why: `No ${STATS[p.metric].label.toLowerCase()} in this window.` } : { value, unit: STATS[p.metric].unit || null };
      }
      const [f] = parseFunnel(p.event);
      if (p.sum) return sumStat(ctx, p, f, currency);
      if (PER[p.per]) return conversion(ctx, p, f);
      const count = eventCount(ctx, f);
      if (!p.per) return count || hasEvent(ctx, f.name) ? { value: count, unit: null } : missing(f.name);
      const [g] = parseFunnel(p.per);
      const base = eventCount(ctx, g);
      return base ? { value: round((count / base) * 100, 1), unit: '%', count, base } : missing(g.name);
    }
    case 'series': {
      if (SESSION_BY.includes(p.by)) return sessionSeries(ctx, p);
      const [f] = parseFunnel(p.event);
      if (!hasEvent(ctx, f.name)) return missing(f.name);
      if (p.sum) return sumSeries(ctx, p, f, currency);
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
      if (SESSION_BY.includes(p.by)) return sessionBreakdown(ctx, p);
      const [f] = parseFunnel(p.event);
      if (p.sum) return sumBreakdown(ctx, p, f, currency);
      if (STEAM_BY.includes(p.by) && ctx.daily) return overDays(p.by);
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
      return issues.length ? { issues: issues.map(({ fingerprint, message, kind, location, count, sessions, last_seen, levels }) => ({ fingerprint, message, kind, location, count, sessions, last_seen, levels })) } : { empty: true, why: 'No errors in this window.' };
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
      // With `by`, Steam branches or builds side by side instead (analytics.js steamGroups).
      const stats = board.panels.filter((x) => x.type === 'stat' && !LIVE_STATS.has(x.metric)).map((x) => withCurrency(x, currency));
      const by = p.by ? p.by.slice(1) : null;
      if (by && ctx.daily) return overDays(p.by);
      const list = versions(ctx, { stats, events: 0, by });
      if (!list.length) return { empty: true, why: by ? `No session sent its ${STEAM_LABELS[by]} in this window: the game reads it from Steamworks when it runs from Steam.` : 'No versions in this window.' };
      if (!stats.length) return { empty: true, why: 'This page has no stat panels to compare.' };
      return { ...(by ? { by } : {}), columns: versionColumns(stats, ctx), rows: list.map((v) => ({ version: v.version, sessions: v.sessions, first_seen: v.first_seen, values: v.board })) };
    }
    case 'live':
      return { live: true };
    case 'reports': {
      const list = (ctx.reports || []).slice(0, p.limit || 5).map((r) => reportSummary(r, ctx));
      return list.length ? { reports: list, total: ctx.reports.length } : { empty: true, why: 'No bug reports in this window.' };
    }
    case 'positions':
      return levelPositions(ctx, p.level, maps, { show: p.show || 'deaths', bin: p.bin ?? null });
    case 'retention': {
      const r = retention(ctx);
      // Not zeros: an anonymous game can't see anyone come back, which is not the same as nobody coming back.
      if (r.status === 'anonymous') return { empty: true, anonymous: true, why: "This game sends no player IDs, so returning players can't be counted. Turn on install mode (privacy: 'install') to see retention." };
      if (!r.cohorts.length) return { empty: true, why: r.status === 'empty' ? 'No sessions in this window.' : 'No new players in this window: a cohort is the day players were first seen.' };
      const cohorts = r.cohorts.slice(-(p.limit || 14));
      return { d1: r.d1, d7: r.d7, d30: r.d30, new_players: r.new_players, id_sessions_pct: r.id_sessions_pct, cohorts, more: r.cohorts.length - cohorts.length };
    }
  }
  return {};
}

// ── by the sessions' platform, browser or GPU tier (analytics.js sessionsBy) ──

// Read from the sessions, which a range of more than 31 days answers from day rollups without. `split`: what the
// panel's rows are, in words (its titles and lines use it).
function sessionRows(ctx, p) {
  const name = p.by.slice(1);
  const split = SESSION_SPLITS[name].label;
  if (ctx.daily) return { why: `Split by ${p.by} over 31 days or less: longer ranges are answered by day, without each session's ${split}.` };
  const [f] = p.event ? parseFunnel(p.event) : [null];
  if (f && !hasEvent(ctx, f.name)) return { why: missing(f.name).why };
  const { rows, players } = sessionsBy(ctx, f, name);
  if (!rows.length) return { why: f ? missing(f.name).why : 'No sessions in this window.' };
  return { rows, players, f, split };
}

// A breakdown by the sessions' platform, browser or GPU tier: an event's count from each group's sessions, or (no
// event) the sessions in each, with their players when the game sends player IDs.
function sessionBreakdown(ctx, p) {
  const { rows, players, f, split, why } = sessionRows(ctx, p);
  if (why) return { empty: true, why };
  const top = rows.slice(0, p.limit || 10).map(({ series, spread, ...r }) => r);
  return { total: rows.reduce((s, r) => s + r.count, 0), sessions: f ? rows.reduce((s, r) => s + r.sessions, 0) : null, rows: top, more: rows.length - top.length, avg: null, counts: f ? 'events' : 'sessions', split, ...(players != null ? { players } : {}) };
}

// A series by the sessions' platform, browser or GPU tier: an event's count over time from each group's sessions, or
// (no event) the sessions playing in each bucket in each group.
function sessionSeries(ctx, p) {
  const { rows, f, split, why } = sessionRows(ctx, p);
  if (why) return { empty: true, why };
  const top = rows.slice(0, p.limit || 5);
  const rest = rows.slice(top.length);
  const series = top.map((x) => ({ label: x.value, values: x.series }));
  if (rest.length) series.push({ label: 'other', values: ctx.buckets.map((_, i) => rest.reduce((s, x) => s + x.series[i], 0)) });
  const spread = rows.reduce((s, r) => s + r.spread, 0);
  return { ts: ctx.buckets, series, counts: f ? 'events' : 'sessions', split, ...(spread ? { spread } : {}) };
}

// ── sums and conversion (sums.js) ──

// Money panels say their currency, name the events sent in another one rather than adding them up, and count the
// sandbox purchases they leave out (TestFlight and other test installs: rollups.js isSandboxPurchase).
function money(s, ctx, f) {
  const sandbox = f.value == null && (s.currency || f.name === 'purchase') ? sandboxPurchases(ctx, f.name) : 0;
  return { currency: s.currency, ...(s.mismatch.length ? { mismatch: s.mismatch } : {}), ...(sandbox ? { sandbox } : {}) };
}

function sandboxPurchases(ctx, name) {
  return eventIndex(ctx).get(name)?.attrs.get('sandbox')?.values.get('true')?.count ?? 0;
}

function noSum(p) {
  return { empty: true, why: `"${parseFunnel(p.event)[0].name}" events have no "${p.sum}" in this window.` };
}

function sumStat(ctx, p, f, currency) {
  const e = eventIndex(ctx).get(f.name);
  if (!e) return missing(f.name);
  if (!e.attrs.has(p.sum)) return noSum(p);
  const s = sumsBy(ctx, f, p.sum, { currency });
  const g = s.groups.get('');
  const total = g?.sum ?? 0;
  if (!p.per) return { value: total, unit: null, ...money(s, ctx, f), events: g?.events ?? 0 };
  const base = kpis(ctx)[p.per === '$players' ? 'players' : 'sessions'];
  return base ? { value: round(total / base, 2), unit: null, ...money(s, ctx, f), total, base } : { empty: true, why: `No ${PER[p.per]}s in this window.` };
}

// The share of players or sessions that sent an event.
function conversion(ctx, p, f) {
  if (!hasEvent(ctx, f.name)) return missing(f.name);
  const base = kpis(ctx)[p.per === '$players' ? 'players' : 'sessions'];
  const count = senders(ctx, f, p.per);
  if (count == null) return { empty: true, why: 'Over more than 31 days players are counted per event, not per attribute value: use $sessions, or a shorter range.' };
  return base ? { value: round((count / base) * 100, 1), unit: '%', count, base } : { empty: true, why: `No ${PER[p.per]}s in this window.` };
}

function sumSeries(ctx, p, f, currency) {
  if (!eventIndex(ctx).get(f.name).attrs.has(p.sum)) return noSum(p);
  const s = sumsBy(ctx, f, p.sum, { split: p.by || null, currency });
  if (!p.by) return { ts: ctx.buckets, series: [{ label: p.sum, values: s.groups.get('')?.series ?? ctx.buckets.map(() => 0) }], ...money(s, ctx, f) };
  const values = [...s.groups.values()].sort((a, b) => b.sum - a.sum || (a.value < b.value ? -1 : 1));
  if (!values.length) return p.by.startsWith('$') ? noSum(p) : { empty: true, why: `"${f.name}" events have no "${p.by}" attribute in this window.` };
  const top = values.slice(0, p.limit || 5);
  const rest = values.slice(top.length);
  const series = top.map((x) => ({ label: x.value, values: x.series }));
  if (rest.length) series.push({ label: 'other', values: ctx.buckets.map((_, i) => round(rest.reduce((t, x) => t + x.series[i], 0), 2)) });
  return { ts: ctx.buckets, series, ...money(s, ctx, f) };
}

// A breakdown by sum: each value's sum, with its count and sessions as the breakdown by count has them.
function sumBreakdown(ctx, p, f, currency) {
  const e = eventIndex(ctx).get(f.name);
  if (!e) return missing(f.name);
  if (!e.attrs.has(p.sum)) return noSum(p);
  let counts;
  if (p.by.startsWith('$')) counts = eventsBy(ctx, f, p.by.slice(1));
  else {
    const a = customEvents(ctx, { name: f.name, sdk: true }).events[0].attrs.find((x) => x.key === p.by);
    if (!a) return { empty: true, why: `"${f.name}" events have no "${p.by}" attribute in this window.` };
    counts = a.values;
  }
  const s = sumsBy(ctx, f, p.sum, { split: p.by, currency });
  const byValue = new Map(counts.map((x) => [String(x.value), x]));
  const rows = [...new Set([...s.groups.keys(), ...byValue.keys()])]
    .map((value) => ({ value, count: byValue.get(value)?.count ?? 0, sessions: byValue.get(value)?.sessions ?? null, sum: s.groups.get(value)?.sum ?? 0 }))
    .sort((a, b) => b.sum - a.sum || b.count - a.count || (a.value < b.value ? -1 : 1));
  if (!rows.length) return missing(f.name);
  const top = rows.slice(0, p.limit || 10);
  return { total: round(rows.reduce((t, r) => t + r.sum, 0), 2), count: rows.reduce((t, r) => t + r.count, 0), sessions: null, rows: top, more: rows.length - top.length, avg: null, ...money(s, ctx, f) };
}

// A sum stat with the dashboard's currency, for versions() (sums.js versionStat).
function withCurrency(p, currency) {
  return p.sum && currency ? { ...p, currency } : p;
}

// The stat panels of every board on a dashboard, once each: what versions are compared on.
export function dashboardStats(dashboard) {
  const seen = new Set();
  const out = [];
  for (const p of dashboard.pages.flatMap((page) => page.panels || [])) {
    const key = p.type === 'stat' && !LIVE_STATS.has(p.metric) && (p.metric || `${p.event}/${p.sum || ''}/${p.per || ''}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(withCurrency(p, dashboard.currency));
  }
  return out.slice(0, 12);
}

// Stat panels as the columns of a version comparison. Versions are compared per session, so a count of
// events (or errors, or deaths) is shown per session there, and a sum per session unless it says per player.
// A sum's column says its currency when it is money (with `ctx`).
export function versionColumns(stats, ctx = null) {
  return stats.map((s) => ({
    title: s.title || defaultTitle(s),
    unit: s.metric ? (PER_SESSION.has(s.metric) ? 'per session' : STATS[s.metric].unit || null) : s.sum ? `per ${PER[s.per] || 'session'}` : s.per ? '%' : 'per session',
    metric: s.metric,
    event: s.event,
    per: s.per,
    ...(s.sum ? { sum: s.sum, currency: ctx ? sumsBy(ctx, parseFunnel(s.event)[0], s.sum, { currency: s.currency }).currency : null } : {}),
  }));
}
const PER_SESSION = new Set(['errors', 'deaths']);

function defaultSize(p) {
  if (STORE_PANELS[p.type]) return typeof STORE_PANELS[p.type].size === 'function' ? STORE_PANELS[p.type].size(p) : STORE_PANELS[p.type].size;
  if (p.type === 'stat') return 's';
  if (['levels', 'events', 'sessions', 'versions', 'live'].includes(p.type)) return 'l';
  return 'm';
}

function defaultTitle(p) {
  if (STORE_PANELS[p.type]) return STORE_PANELS[p.type].title(p);
  const by = (k) => (SESSION_BY.includes(k) ? SESSION_SPLITS[k.slice(1)].label : k?.startsWith('$') ? k.slice(1) : k);
  switch (p.type) {
    case 'stat':
      if (p.metric) return STATS[p.metric].label;
      if (p.sum) return `${p.event} ${p.sum}${p.per ? ` per ${PER[p.per]}` : ''}`;
      if (PER[p.per]) return p.per === '$players' ? `Players who sent ${p.event}` : `Sessions that sent ${p.event}`;
      return p.per ? `${p.event} per ${p.per}` : p.event;
    case 'series':
      return `${p.event ?? 'Sessions'}${p.sum ? ` ${p.sum}` : ''}${p.by ? ` by ${by(p.by)}` : ''}`;
    case 'breakdown':
      return `${p.event ?? 'Sessions'}${p.sum ? ` ${p.sum}` : ''} by ${STEAM_BY.includes(p.by) ? STEAM_LABELS[p.by.slice(1)] : by(p.by)}`;
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
    case 'reports':
      return 'Bug reports';
    case 'retention':
      return 'Retention';
    case 'sessions':
      return p.sent ? `Sessions that sent ${p.sent}` : 'Recent sessions';
    case 'versions':
      return p.by ? `By ${STEAM_LABELS[p.by.slice(1)]}` : 'By version';
    case 'live':
      return 'Live';
    case 'positions':
      return `${p.show === 'path' ? 'Where players went' : p.show === 'both' ? 'Where players went and died' : 'Where players died'} on ${p.level}`;
  }
  return p.type;
}

// Steam facts are read from sessions, which a range of more than 31 days answers from day rollups without.
function overDays(by) {
  return { empty: true, why: `Split by ${by} over 31 days or less: longer ranges are answered by day, without each session's Steam facts.` };
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
