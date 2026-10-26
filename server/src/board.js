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
//               now, whatever the range. `per` $hours divides a count or sum by the hours played (rates.js:
//               kills per hour played), and so does a deaths or errors metric's. `rate` is the share of the
//               event's events where a flag holds (won) or a word is sent (result=win), with its interval;
//               `avg` a numeric attribute's mean; `of` with `quantile` (1 to 99) one percentile of a numeric
//               attribute (distributions.js: the median match)
//   series      an event's count over time, optionally split `by` an attribute (top `limit` values); with
//               `sum`, the attribute's sum over time; with `rate` or `avg`, the rate or average in each bucket
//   breakdown   how an event's attribute values compare (`event`, `by`, `limit`), by count or by `sum`
//               (`by` can also be $version or $level, which every event has: purchases by version, or a
//               Steam fact of the session that sent it, such as $steam_branch, counted by count only)
//               Both take `by` $platform, $browser or $device_tier: the platform, browser or GPU tier of the
//               sessions that sent the event (Windows, macOS, Steam Deck, iOS, Android…; Chrome, Safari…; high to
//               low), counted (no sum); without `event`, the sessions in each (and their players). Both take
//               `per` $hours (each bucket or row per hour played) and `rate` or `avg`: a breakdown's rows then
//               each have their rate with its interval (or average) next to the overall one, leaving out rows
//               of fewer than `min` events, in `order`, and marking rows whose interval misses `expect` (a
//               percentage the game intends) or the overall rate. By a list attribute (a deck) each element is
//               a row: the events whose list has it
//   distribution how a numeric attribute (`of`) of an event spreads: percentiles and a histogram of `bins`
//               bars, optionally split `by` an attribute, $version, $level or a session split (top `limit`
//               rows); `unit` is shown after its numbers
//   funnel      sessions that went through `steps` in order ("paywall,buy=tapped,buy=done")
//   levels      starts, completions, fails and deaths per level, with clear times; `label` is what the game
//               calls a level
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
// Events are written as funnel steps are (analytics.js parseFunnel): "name", "name=value" or "name:key=value"; a
// list matches when it has the value, and "name:key=a+b" when it has all of them.

import { overview, quantile, funnel as levelFunnel, errorIssues, customEvents, eventCount, eventsBy, eventFunnel, parseFunnel, eventIndex, sessionsList, versions, retention, cellsOf, levelPositions, sessionsBy, sessionSplit, SESSION_SPLITS, round } from './analytics.js';
import { propertyKey, whereProblem } from './properties.js';
import { levelsBy, attemptValues } from './levels.js';
import { netStats, netPanel, NET_METRICS, NET_SHOW } from './network.js';
import { serverStats, serversPanel, validServersPanel, SERVER_METRICS } from './servers.js';
import { dailyLevelsBy } from './daily.js';
import { findings } from './findings.js';
import { STEAM_DIMENSIONS } from './analytics.js';
import { reportSummary } from './reports.js';
import { sumsBy, senders } from './sums.js';
import { STORE_PANELS, storePanel, storePages, storePanelFields } from './reviews.js';
import { hoursPlayed, hoursBy, hoursSeries, perHour, hoursRound, measureOf, measureProblem, measureBy, rateOf, avgOf, misses, MIN_EVENTS, MIN_HOURS } from './rates.js';
import { distributionOf, percentileOf, BINS, ROWS } from './distributions.js';
import { eachOccurrence, occurrenceGroups, bucketOf } from './occurrences.js';

export const PANEL_TYPES = ['stat', 'series', 'breakdown', 'distribution', 'funnel', 'levels', 'frame_time', 'errors', 'deaths', 'events', 'findings', 'sessions', 'versions', 'live', 'reports', 'retention', 'positions', 'net', 'servers'];
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
  hours_played: { label: 'Hours played', unit: 'h' },
  // Runs in the range (A7): each run ID once, whatever its sessions (a roguelite run that resumed after a restart).
  runs: { label: 'Runs' },
  // Network quality (A8, network.js): ping, loss, and dropped connections per hour played or per attempt.
  ...NET_METRICS,
  // The game's servers (A9, servers.js), from its companion service.
  ...SERVER_METRICS,
};
// Stats a metric can give per hour played (`per` $hours).
const PER_HOUR_METRICS = new Set(['deaths', 'errors']);
// Stats of this moment rather than the range: no version has a value of them; and the servers' (the companion's).
const LIVE_STATS = new Set(['players_now', 'servers_now', 'server_tick_p95', 'server_crash_free_pct', 'players_per_server']);
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
  // The game's servers (A9): ticks by map and players connected, crashes, versions, memory.
  servers: { title: 'Servers', icon: 'perf' },
  // The range's matches (A7), each opening its match page: every side of it, slot by slot.
  matches: { title: 'Matches', icon: 'players' },
};
export const ICONS = ['board', 'overview', 'events', 'perf', 'errors', 'players', 'heatmap', 'sessions', 'versions', 'live', 'flag', 'bolt', 'play', 'clock', 'bug', 'money'];
const MAX_PANELS = 24;
const MAX_PAGES = 20;
// Dimensions every event has, for `by`: $version and $level.
const DIMENSIONS = ['version', 'level', 'zone'];
// What series and breakdowns can split sessions by (analytics.js SESSION_SPLITS): $platform, $browser, $device_tier.
const SESSION_BY = Object.keys(SESSION_SPLITS).map((k) => `$${k}`);
const SESSION_WORDS = `${SESSION_BY.join(', ')}, or a session property ($rank, $class…)`;
// Session properties (A6, properties.js) split wherever $platform does: `$<key>` for any key the property rules allow.
const isSessionBy = (v) => SESSION_BY.includes(v) || !!propertyKey(v);
// What a Steam fact (analytics.js STEAM_DIMENSIONS) is called in a panel's title.
const STEAM_LABELS = { steam_branch: 'Steam branch', steam_build: 'Steam build', steam_hardware: 'Steam hardware', steam_controller: 'controller', steam_language: 'Steam language', proton: 'Proton', big_picture: 'Big Picture', family_shared: 'Family Sharing', timed_trial: 'timed trial' };
const STEAM_BY = STEAM_DIMENSIONS.map((d) => `$${d}`);
// What a stat's `per` can be besides an event: every player or session in the window, or every hour played.
const PER = { $players: 'player', $sessions: 'session' };
const HOURS = '$hours';
const ORDERS = ['rate', 'avg', 'count', 'value'];
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
    // A board page can show only some sessions: `where` a session property has one of some values (A6).
    if (p.where != null) {
      const why = whereProblem(p.where);
      if (why) throw new BoardError(`${at}.${why}`);
      page.where = Object.fromEntries(Object.entries(p.where).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
    }
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
  const matches = cellsOf(ctx).some(({ c }) => c.n.group);
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
      ...(matches ? [view('matches')] : []),
      ...(ctx.hasServers ? [view('servers')] : []),
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
  // What a levels or deaths panel splits each attempt by (A7): an attribute of its level_start ("tier", "party_size",
  // a list such as "build"), a session property or a session split; `level` keeps one level's rows.
  const attempts = () => {
    if (p.by != null) {
      const v = need('by');
      if (v.startsWith('$') && !isSessionBy(v)) throw new BoardError(`${at}.by is an attribute of the level's start ("tier"), a session property ($class) or ${SESSION_BY.join(', ')}`);
      out.by = v;
    }
    if (p.level != null) out.level = need('level');
  };
  // A Steam fact ($steam_branch…) splits a breakdown by the sessions that sent the event (`steam`), not a series.
  // $platform splits either by the sessions' platform.
  const by = (required, { steam = false } = {}) => {
    if (p.by == null && !required) return;
    const v = need('by');
    if (STEAM_BY.includes(v)) {
      if (!steam) throw new BoardError(`${at}.by: a ${p.type} can't be split by ${v} (sessions count their events, not per minute); use a breakdown, a versions panel with by ${v}, or filter the board (?${v.slice(1)}=…)`);
    } else if (v.startsWith('$') && !isSessionBy(v) && !DIMENSIONS.includes(v.slice(1))) throw new BoardError(`${at}.by is an attribute name, or $version, $level, $zone, ${SESSION_WORDS}${steam ? `, or a Steam fact of the session (${STEAM_BY.join(', ')})` : ''}`);
    out.by = v;
  };
  // A series or breakdown by $platform, $browser or $device_tier without an event counts the sessions in each.
  const eventOrSessions = () => {
    if (p.event == null && isSessionBy(p.by)) {
      if (p.sum != null) throw new BoardError(`${at}.sum goes with event`);
      return;
    }
    out.event = event('event');
  };
  // What a number is in, after it: "s" (seconds: shown as minutes or hours when large), "%", or the game's word.
  const unit = () => {
    if (p.unit == null) return;
    const v = text(p.unit, 12);
    if (!v) throw new BoardError(`${at}.unit is a short word shown after the numbers, e.g. "s" or "floors"`);
    out.unit = v;
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
  // A rate (a flag, "won", or a word outcome, "result=win") or an average (a numeric attribute) instead of a count;
  // never with sum. Rates and averages by an attribute take every event of the name (the cells count them together),
  // and a filtered event reads the sessions' occurrences (rates.js).
  const measure = ({ rows = false } = {}) => {
    if (p.rate == null && p.avg == null) {
      for (const k of ['min', 'expect', 'order']) if (p[k] != null) throw new BoardError(`${at}.${k} goes with rate or avg`);
      return;
    }
    if (p.rate != null && p.avg != null) throw new BoardError(`${at}: rate or avg, not both`);
    if (out.sum) throw new BoardError(`${at}: sum, rate or avg, one of them`);
    if (p.rate != null) {
      const v = text(p.rate, 130);
      const [k, w] = (v || '').split('=');
      if (!v || k.startsWith('$') || !k.trim() || (v.includes('=') && !w?.trim())) throw new BoardError(`${at}.rate is a flag of the event ("won": true or false, or 1 or 0) or a word outcome ("result=win")`);
      out.rate = v;
    } else {
      const v = text(p.avg, 64);
      if (!v || v.startsWith('$')) throw new BoardError(`${at}.avg is a numeric attribute of the event, e.g. "duration_s"`);
      out.avg = v;
    }
    if (p.min != null) {
      if (!rows) throw new BoardError(`${at}.min goes with a breakdown's rows`);
      if (!Number.isInteger(p.min) || p.min < 1 || p.min > 1e6) throw new BoardError(`${at}.min is the fewest events a row needs, 1 to 1000000`);
      out.min = p.min;
    }
    if (p.expect != null) {
      if (!out.rate) throw new BoardError(`${at}.expect goes with rate`);
      if (typeof p.expect !== 'number' || !Number.isFinite(p.expect) || p.expect < 0 || p.expect > 100) throw new BoardError(`${at}.expect is the percentage the game intends, 0 to 100 (a published 0.6% is 0.6)`);
      out.expect = p.expect;
    }
    if (p.order != null) {
      if (!rows) throw new BoardError(`${at}.order goes with a breakdown's rows`);
      if (!ORDERS.includes(p.order)) throw new BoardError(`${at}.order is ${ORDERS.join(', ')}`);
      out.order = p.order;
    }
  };
  // per $hours: a count or sum per hour played (rates.js), never a rate or average.
  const perHours = () => {
    if (p.per == null) return;
    if (p.per !== HOURS) throw new BoardError(`${at}.per is ${HOURS} on a ${p.type} (each ${p.type === 'series' ? 'bucket' : 'row'} per hour played)`);
    if (out.rate || out.avg) throw new BoardError(`${at}: a rate or average is already per event; per ${HOURS} goes with a count or sum`);
    if (p.type === 'series' && isSessionBy(p.by)) throw new BoardError(`${at}: per ${HOURS} by ${p.by} is a breakdown (rows per hour played), not a series`);
    if (STEAM_BY.includes(p.by) && out.sum) throw new BoardError(`${at}: a sum can't be split by ${p.by}`);
    out.per = HOURS;
  };
  // Sums are kept per name and one attribute value, so a sum split by an attribute takes the event by name.
  const sumSplit = () => {
    if ((out.rate || out.avg) && STEAM_BY.includes(out.by) && p.type === 'series') throw new BoardError(`${at}: a series can't be split by ${out.by}`);
    if (out.sum && out.by && !out.by.startsWith('$') && parseFunnel(out.event)[0].value != null) throw new BoardError(`${at}: with sum and by an attribute, event is a name only ("purchase", not "purchase=done")`);
    if (out.sum && STEAM_BY.includes(out.by)) throw new BoardError(`${at}: a sum can't be split by ${out.by} (sums are kept per minute, not per session); count instead, or filter the board (?${out.by.slice(1)}=…)`);
    if (out.sum && isSessionBy(out.by)) throw new BoardError(`${at}: a sum can't be split by ${out.by} (sums are kept per minute, not per session); count instead${out.by === '$platform' ? ', or for revenue by store a store_revenue panel with measure by_store' : ''}`);
  };
  switch (p.type) {
    case 'stat':
      if ((p.metric == null) === (p.event == null)) throw new BoardError(`${at} (stat) needs either metric (${Object.keys(STATS).join(', ')}) or event`);
      if (p.metric != null) {
        if (!STATS[p.metric]) throw new BoardError(`${at}.metric must be one of ${Object.keys(STATS).join(', ')}`);
        for (const k of ['sum', 'rate', 'avg', 'of']) if (p[k] != null) throw new BoardError(`${at}.${k} goes with event, not metric`);
        out.metric = p.metric;
        if (p.per != null) {
          if (p.per !== HOURS || !PER_HOUR_METRICS.has(p.metric)) throw new BoardError(`${at}.per with a metric is ${HOURS}, for ${[...PER_HOUR_METRICS].join(' or ')} per hour played`);
          out.per = HOURS;
        }
      } else {
        out.event = event('event');
        sum();
        measure();
        if (p.of != null || p.quantile != null) {
          const v = text(p.of, 64);
          if (!v || v.startsWith('$')) throw new BoardError(`${at}.of is a numeric attribute of the event, e.g. "duration_s"`);
          if (!Number.isInteger(p.quantile) || p.quantile < 1 || p.quantile > 99) throw new BoardError(`${at}.quantile is the percentile of "${v}" to show, 1 to 99 (50: the median)`);
          if (out.sum || out.rate || out.avg) throw new BoardError(`${at}: of goes alone, not with sum, rate or avg`);
          out.of = v;
          out.quantile = p.quantile;
          unit();
        }
        if (p.per != null) {
          if (out.rate || out.avg || out.of) throw new BoardError(`${at}.per goes with a count or sum`);
          if (PER[p.per] || p.per === HOURS) out.per = p.per;
          else if (out.sum) throw new BoardError(`${at}.per with sum is $players, $sessions or ${HOURS} (revenue per player or per session, XP per hour played)`);
          else out.per = event('per');
        }
      }
      break;
    case 'series':
      eventOrSessions();
      sum();
      measure();
      by(false);
      sumSplit();
      perHours();
      limit(8);
      break;
    case 'breakdown':
      eventOrSessions();
      sum();
      measure({ rows: true });
      by(true, { steam: true });
      sumSplit();
      perHours();
      limit(20);
      break;
    case 'distribution': {
      out.event = event('event');
      const v = text(p.of, 64);
      if (!v || v.startsWith('$')) throw new BoardError(`${at} (distribution) needs of: a numeric attribute of the event, e.g. "duration_s"`);
      out.of = v;
      by(false, { steam: true });
      limit(ROWS.max);
      if (p.bins != null) {
        if (!Number.isInteger(p.bins) || p.bins < 2 || p.bins > BINS.max) throw new BoardError(`${at}.bins is how many bars, 2 to ${BINS.max}`);
        out.bins = p.bins;
      }
      unit();
      break;
    }
    case 'versions':
      if (p.by != null) {
        if (!STEAM_BY.includes(p.by) && !propertyKey(p.by)) throw new BoardError(`${at}.by compares sessions by a Steam fact (${STEAM_BY.join(', ')}) or a session property ($class…)`);
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
      attempts();
      if (p.count != null) {
        if (p.count !== 'runs') throw new BoardError(`${at}.count is "runs": each run counted once at each level it reached`);
        out.count = 'runs';
      }
      break;
    case 'deaths':
      attempts();
      break;
    // The game's servers (A9): tick time against its budget (by players connected, $level or $version), players, or
    // crashes, from its companion service.
    case 'servers':
      Object.assign(out, validServersPanel(p, at, BoardError));
      limit(20);
      break;
    // Network quality (A8): ping (p50 and p95 over time, the share of play over 150 ms), loss, or disconnects by
    // reason, overall or `by` $version, $level, $zone, a session split ($link, $platform) or a property ($region).
    case 'net':
      if (p.show != null) {
        if (!NET_SHOW.includes(p.show)) throw new BoardError(`${at}.show is ${NET_SHOW.join(', ')}`);
        out.show = p.show;
      }
      if (p.by != null) {
        const v = need('by');
        if (!v.startsWith('$') || (!isSessionBy(v) && !DIMENSIONS.includes(v.slice(1)))) throw new BoardError(`${at}.by is $version, $level, $zone, ${SESSION_WORDS}`);
        out.by = v;
      }
      limit(20);
      break;
    case 'errors':
    case 'findings':
    case 'reports':
      limit(20);
      break;
    case 'retention':
      limit(90);
      // By a session property (A6): D1, D7 and D30 per value (the spenders' against the rest).
      if (p.by != null) {
        if (!propertyKey(p.by)) throw new BoardError(`${at}.by is a session property, e.g. "$spender"`);
        out.by = p.by;
      }
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
const SHARED_AS_IS = new Set(['stat', 'series', 'breakdown', 'distribution', 'funnel', 'levels', 'frame_time', 'deaths', 'events', 'versions', 'retention', 'net', 'servers']);
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
  // An average or a spread of money adds back up to revenue (the mean times the count): hidden with the sums.
  if ((p.avg || p.of) && !sums && moneyEvent(ctx, p.event)) return { empty: true, why: 'Amounts such as prices are not shown on this shared board.' };
  const data = panelData(ctx, p, board, maps, currency);
  if (p.type === 'versions' && !data.empty && !sums) {
    const hidden = data.columns.map((c) => !!c.sum || (!!(c.avg || c.of) && moneyEvent(ctx, c.event)));
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

// Whether an event carries money: its amounts are sent with a `currency` (sums.js).
function moneyEvent(ctx, event) {
  return !!event && !!eventIndex(ctx).get(parseFunnel(event)[0].name)?.attrs.has('currency');
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
  return { empty: true, why: STORE_PANELS[p.type].hidden?.(p) ?? 'Not shown on this shared board.' };
}

function panelData(ctx, p, board, maps, currency) {
  if (STORE_PANELS[p.type]) return storePanel(ctx, p, { currency });
  switch (p.type) {
    case 'stat': {
      // Counted by the server as batches arrive (app.js), not from the range.
      if (p.metric === 'players_now') return ctx.playersNow == null ? { empty: true, why: 'This server does not count players now.' } : { value: ctx.playersNow, unit: null };
      if (SERVER_METRICS[p.metric]) {
        if (p.metric === 'servers_now') return ctx.serversNow == null ? { empty: true, why: "No server of this game is counted here: a dedicated server runs the SDK in server mode (role: 'server')." } : { value: ctx.serversNow.servers, unit: null, players: ctx.serversNow.players };
        const st = serverStats(ctx.server);
        if (!st) return { empty: true, why: "No server of this game sent anything in this window: a dedicated server runs the SDK in server mode (role: 'server')." };
        const value = { server_tick_p95: st.tick_p95, server_crash_free_pct: st.crash_free_pct, players_per_server: st.players }[p.metric];
        return value == null ? { empty: true, why: `No ${SERVER_METRICS[p.metric].label.toLowerCase()} in this window.` } : { value, unit: SERVER_METRICS[p.metric].unit ?? null, servers: st.servers, ...(p.metric === 'server_tick_p95' ? { budget_ms: st.budget_ms } : {}) };
      }
      if (NET_METRICS[p.metric]) {
        const n = netStats(ctx);
        if (!n || n[p.metric] == null) return { empty: true, why: !n ? 'No network data in this window: the game sends its ping with netSample, or its netcode is read by the SDK.' : p.metric === 'disconnect_pct' ? 'No level attempts or connected sessions in this window to count disconnects against.' : `No ${NET_METRICS[p.metric].label.toLowerCase()} in this window.` };
        return { value: n[p.metric], unit: NET_METRICS[p.metric].unit, ...(p.metric.startsWith('disconnect') ? { count: n.disconnects } : {}) };
      }
      if (p.metric === 'runs') {
        if (ctx.daily) return { empty: true, why: 'Runs are counted over 31 days or less: longer ranges are answered by day, without each session.' };
        const runs = runIds(ctx);
        return runs.size ? { value: runs.size, unit: null } : { empty: true, why: "No runs in this window: the game marks one with setGroup('run')." };
      }
      if (p.metric === 'hours_played') {
        const hours = hoursPlayed(ctx);
        return hours ? { value: hoursRound(hours), unit: 'h' } : { empty: true, why: 'No frames in this window: hours played are the time the game was on screen.' };
      }
      if (p.metric && p.per === HOURS) return perHourStat(ctx, kpis(ctx)[p.metric] ?? 0);
      if (p.metric) {
        const value = kpis(ctx)[p.metric];
        return value == null ? { empty: true, why: `No ${STATS[p.metric].label.toLowerCase()} in this window.` } : { value, unit: STATS[p.metric].unit || null };
      }
      const [f] = parseFunnel(p.event);
      if (p.rate || p.avg) return measureStat(ctx, p, f);
      if (p.of) return quantileStat(ctx, p, f);
      if (p.sum) return sumStat(ctx, p, f, currency);
      if (PER[p.per]) return conversion(ctx, p, f);
      if (p.per === HOURS) return hasEvent(ctx, f.name) ? perHourStat(ctx, eventCount(ctx, f)) : missing(f.name);
      const count = eventCount(ctx, f);
      if (!p.per) return count || hasEvent(ctx, f.name) ? { value: count, unit: null } : missing(f.name);
      const [g] = parseFunnel(p.per);
      const base = eventCount(ctx, g);
      return base ? { value: round((count / base) * 100, 1), unit: '%', count, base } : missing(g.name);
    }
    case 'series': {
      if ((p.rate || p.avg) && isSessionBy(p.by)) return { empty: true, why: `A ${p.rate ? 'rate' : 'average'} over time splits by $version, $level or an attribute; by ${p.by}, use a breakdown.` };
      if (isSessionBy(p.by)) return sessionSeries(ctx, p);
      const [f] = parseFunnel(p.event);
      if (!hasEvent(ctx, f.name)) return missing(f.name);
      if (p.rate || p.avg) return measureSeries(ctx, p, f);
      if (p.sum) return hourly(ctx, p, sumSeries(ctx, p, f, currency));
      if (!p.by) return hourly(ctx, p, { ts: ctx.buckets, series: [{ label: p.event, values: eventCount(ctx, f, 'series') }] });
      let values;
      if (p.by.startsWith('$')) values = f.all ? occurrenceRows(ctx, f, p.by) : eventsBy(ctx, f, p.by.slice(1));
      else {
        const a = eventIndex(ctx).get(f.name).attrs.get(p.by);
        if (!a) return { empty: true, why: `"${f.name}" events have no "${p.by}" attribute in this window.` };
        values = f.value != null ? occurrenceRows(ctx, f, p.by) : [...a.values.values()].sort((x, y) => y.count - x.count);
      }
      const top = values.slice(0, p.limit || 5);
      const rest = values.slice(top.length);
      const series = top.map((x) => ({ label: x.value, values: x.series }));
      if (rest.length) series.push({ label: 'other', values: ctx.buckets.map((_, i) => rest.reduce((s, x) => s + x.series[i], 0)) });
      return hourly(ctx, p, { ts: ctx.buckets, series });
    }
    case 'breakdown': {
      if (p.rate || p.avg) return measureBreakdown(ctx, p);
      if (isSessionBy(p.by)) return perHourRows(ctx, p, sessionBreakdown(ctx, p));
      const [f] = parseFunnel(p.event);
      if (p.sum) return perHourRows(ctx, p, sumBreakdown(ctx, p, f, currency));
      if (STEAM_BY.includes(p.by) && ctx.daily) return overDays(p.by);
      if (p.by.startsWith('$')) {
        const rows = (f.all ? occurrenceRows(ctx, f, p.by) : eventsBy(ctx, f, p.by.slice(1))).map(({ series, ...r }) => r);
        if (!rows.length) return missing(f.name);
        const top = rows.slice(0, p.limit || 10);
        return perHourRows(ctx, p, { total: rows.reduce((s, r) => s + r.count, 0), sessions: null, rows: top, more: rows.length - top.length, avg: null });
      }
      const e = customEvents(ctx, { name: f.name, sdk: true }).events[0];
      if (!e) return missing(f.name);
      const a = e.attrs.find((x) => x.key === p.by);
      if (!a) return { empty: true, why: `"${f.name}" events have no "${p.by}" attribute in this window.` };
      // A filtered event split by another attribute reads the occurrences (the cells count one attribute at a time).
      if (f.value != null) {
        const rows = occurrenceRows(ctx, f, p.by).map(({ series, ...r }) => r);
        if (!rows.length) return missing(p.event);
        const top = rows.slice(0, p.limit || 10);
        const total = eventCount(ctx, f);
        return perHourRows(ctx, p, { total, sessions: null, rows: a.list ? top.map((r) => ({ ...r, share: round((r.count / (total || 1)) * 100, 1) })) : top, more: rows.length - top.length, avg: null, ...(a.list ? { list: true } : {}), from: 'occurrences' });
      }
      const top = a.values.slice(0, p.limit || 10);
      // A list (a deck): each element's row counts the events whose list has it, so rows add up to more than the events.
      if (a.list) return perHourRows(ctx, p, { total: e.count, sessions: e.sessions, rows: top.map((r) => ({ ...r, share: round((r.count / (e.count || 1)) * 100, 1) })), more: a.values.length - top.length, avg: null, list: true });
      return perHourRows(ctx, p, { total: e.count, sessions: e.sessions, rows: top, more: a.values.length - top.length, avg: a.avg });
    }
    case 'distribution':
      return distributionPanel(ctx, p);
    case 'funnel': {
      const steps = eventFunnel(ctx, parseFunnel(p.steps));
      return steps[0].sessions ? { steps } : { steps, empty: true, why: `No session sent "${steps[0].step}" in this window.` };
    }
    case 'levels': {
      if (p.by || p.count || p.level) return levelRows(ctx, p);
      const rows = levelFunnel(ctx);
      if (!rows.length) return { empty: true, why: 'The game sends no level events (levelStart, levelComplete, levelFail).' };
      // Columns only for what the game reports: a puzzle game with no deaths shows no deaths column. Clear times are
      // the median and the slowest 1 in 10 of completed attempts.
      return { rows, has: hasOf(rows) };
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
      if (p.by || p.level) {
        const r = levelRows(ctx, p);
        if (r.empty) return r;
        const rows = r.rows.filter((l) => l.deaths);
        return rows.length ? { by: p.by ?? null, rows: rows.map((l) => ({ level: l.level, value: l.value, deaths: l.deaths, causes: l.death_causes })) } : { empty: true, why: 'No deaths in this window.' };
      }
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
      if (!list.length) return { empty: true, why: by ? (STEAM_LABELS[by] ? `No session sent its ${STEAM_LABELS[by]} in this window: the game reads it from Steamworks when it runs from Steam.` : `No session in this window has the property ${by}: the game sets it with setProperties.`) : 'No versions in this window.' };
      if (!stats.length) return { empty: true, why: 'This page has no stat panels to compare.' };
      return { ...(by ? { by } : {}), columns: versionColumns(stats, ctx), rows: list.map((v) => ({ version: v.version, sessions: v.sessions, first_seen: v.first_seen, first_seen_ever: v.first_seen_ever ?? null, values: v.board })) };
    }
    case 'live':
      return { live: true };
    case 'reports': {
      const list = (ctx.reports || []).slice(0, p.limit || 5).map((r) => reportSummary(r, ctx));
      return list.length ? { reports: list, total: ctx.reports.length } : { empty: true, why: 'No bug reports in this window.' };
    }
    case 'positions':
      return levelPositions(ctx, p.level, maps, { show: p.show || 'deaths', bin: p.bin ?? null });
    case 'net':
      return netPanel(ctx, p);
    case 'servers':
      return serversPanel(ctx, p);
    case 'retention': {
      const r = retention(ctx, { by: p.by ? p.by.slice(1) : null });
      // Not zeros: an anonymous game can't see anyone come back, which is not the same as nobody coming back.
      if (r.status === 'anonymous') return { empty: true, anonymous: true, why: "This game sends no player IDs, so returning players can't be counted. Turn on install mode (privacy: 'install') to see retention." };
      if (!r.cohorts.length) return { empty: true, why: r.status === 'empty' ? 'No sessions in this window.' : 'No new players in this window: a cohort is the day players were first seen.' };
      const cohorts = r.cohorts.slice(-(p.limit || 14));
      // By a property: each value's D1, D7 and D30 next to everyone's, as `split` (the panel's own `by` stays the spec's).
      return { d1: r.d1, d7: r.d7, d30: r.d30, new_players: r.new_players, id_sessions_pct: r.id_sessions_pct, cohorts, more: r.cohorts.length - cohorts.length, ...(r.by ? { split: r.by } : {}) };
    }
  }
  return {};
}

// Every run ID of the context's sessions (A7): their run groups, and the runs their level starts were in.
function runIds(ctx) {
  const ids = new Set();
  for (const s of ctx.sessions.values()) {
    for (const g of s.groups || []) if (g.kind === 'run') ids.add(g.id);
    for (const m of s.marks) if (m.r) ids.add(m.r);
  }
  return ids;
}

// ── levels by what describes each attempt (levels.js) ──

// The levels panel's rows by `by` (an attribute of the starts, a property or a session split), or counting runs, or
// one `level`'s: per level and value. Over 31 days or less from the sessions; longer ranges from the day rollups, which
// keep the first three attributes of each level's starts.
export function levelRows(ctx, p) {
  const session = p.by && isSessionBy(p.by) ? sessionSplit(ctx, p.by.slice(1)) : null;
  if (ctx.daily) {
    if (session || p.count === 'runs') return { empty: true, why: `${p.count === 'runs' ? 'Runs are counted' : `Split by ${p.by}`} over 31 days or less: longer ranges are answered by day, without each session.` };
    if (!p.by) return { rows: levelFunnel(ctx).filter((r) => !p.level || r.level === p.level).map((r) => ({ ...r, value: '' })), has: hasOf(levelFunnel(ctx)) };
    const { rows, kept } = dailyLevelsBy(ctx, { by: p.by, level: p.level ?? null });
    if (!kept) return { empty: true, why: `Over more than 31 days, levels split by the first three attributes of each level's starts, and "${p.by}" isn't one of them: pick a range of 31 days or less.` };
    return { by: p.by, rows, has: hasOf(rows) };
  }
  const valuesOf = p.by ? attemptValues(p.by, session ? session.of : null) : () => [''];
  const rows = levelsBy(ctx, { valuesOf, level: p.level ?? null, runs: p.count === 'runs', quantile });
  if (!rows.length) return { empty: true, why: p.level ? `No attempts at ${p.level} in this window.` : 'The game sends no level events (levelStart, levelComplete, levelFail).' };
  if (p.by && !session && rows.every((r) => r.value === '(none)')) return { empty: true, why: `No level start in this window carries "${p.by}": the game passes it with levelStart (levelStart('${p.level || 'level'}', { ${p.by}: … })).` };
  return { ...(p.by ? { by: p.by } : {}), ...(p.count ? { count: p.count } : {}), rows, has: hasOf(rows) };
}

function hasOf(rows) {
  return { completion: rows.some((r) => r.completed), fails: rows.some((r) => r.fails), deaths: rows.some((r) => r.deaths), time: rows.some((r) => r.avg_complete_s != null), rage_quits: rows.some((r) => r.rage_quits), disconnects: rows.some((r) => r.disconnects) };
}

// ── by the sessions' platform, browser or GPU tier (analytics.js sessionsBy) ──

// Read from the sessions, which a range of more than 31 days answers from day rollups without. `split`: what the
// panel's rows are, in words (its titles and lines use it).
function sessionRows(ctx, p) {
  const name = p.by.slice(1);
  const split = SESSION_SPLITS[name]?.label ?? name;
  if (ctx.daily) return { why: `Split by ${p.by} over 31 days or less: longer ranges are answered by day, without each session's ${SESSION_SPLITS[name] ? split : 'properties'}.` };
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
  if (p.per === HOURS) {
    const hours = hoursPlayed(ctx);
    const value = perHour(total, hours);
    return value == null ? noHours(hours) : { value, unit: 'per hour', total, hours: hoursRound(hours), ...money(s, ctx, f) };
  }
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

// ── the events query's measures ──

// What the events query adds for one event (`name`): with `rate` or `avg`, the rate or average (`measure`), per value
// `by` an attribute, $version, $level or a session split, as a stat or breakdown panel answers it; with `of`, the
// distribution of that numeric attribute (`distribution`), optionally `by`, as a distribution panel answers it. A
// filter is written as a panel's event is ("match_end:mode=ranked"). BoardError says what to fix.
export function eventQuery(ctx, params) {
  const name = params.get('name');
  const [rate, avg, of, by] = ['rate', 'avg', 'of', 'by'].map((k) => params.get(k) || null);
  if (!rate && !avg && !of) return {};
  const event = params.get('event') || name;
  if (!event) throw new BoardError('rate, avg and of need name: the event to measure');
  if (of) {
    const p = validatePanel({ type: 'distribution', event, of, ...(by ? { by } : {}), ...(params.get('bins') ? { bins: Number(params.get('bins')) } : {}), ...(params.get('limit') ? { limit: Number(params.get('limit')) } : {}) }, 'query');
    return { distribution: { event, of, ...(by ? { by } : {}), ...panelData(ctx, p, { panels: [] }, [], null) } };
  }
  const min = params.get('min') ? Number(params.get('min')) : undefined;
  const p = validatePanel({ type: by ? 'breakdown' : 'stat', event, ...(rate ? { rate } : { avg }), ...(by ? { by, limit: Number(params.get('limit')) || 20, ...(min ? { min } : {}) } : {}) }, 'query');
  return { measure: { event, ...(rate ? { rate } : { avg }), ...(by ? { by } : {}), ...panelData(ctx, p, { panels: [] }, [], null) } };
}

// ── per hour played (rates.js) ──

function noHours(hours) {
  return { empty: true, why: hours ? `Only ${Math.round(hours * 60)} minutes played in this window: a rate per hour needs ${Math.round(MIN_HOURS * 60)} or more.` : 'No frames in this window: hours played are the time the game was on screen.' };
}

// A count per hour played (kills, matches, deaths).
function perHourStat(ctx, count) {
  const hours = hoursPlayed(ctx);
  const value = perHour(count, hours);
  return value == null ? noHours(hours) : { value, unit: 'per hour', count, hours: hoursRound(hours) };
}

// A series per hour played: each bucket's count or sum over the hours played in it; by $version or $level each line
// over its own hours, by an attribute every line over all of them. Buckets with under MIN_HOURS show none.
function hourly(ctx, p, answer) {
  if (p.per !== HOURS || answer.empty) return answer;
  const dim = p.by === '$version' || p.by === '$level' || p.by === '$zone' ? p.by.slice(1) : null;
  const all = hoursSeries(ctx);
  const own = dim ? hoursSeries(ctx, dim) : null;
  const series = answer.series.map((x) => {
    const hours = own ? (own.get(String(x.label)) ?? all) : all;
    return { ...x, values: x.values.map((v, i) => perHour(v, hours[i])) };
  });
  return { ...answer, series, unit: 'per hour', hours: all.map(hoursRound) };
}

// A breakdown per hour played: by $version, $level, a session split or a Steam fact each row over its own hours, by an
// attribute every row over the window's.
function perHourRows(ctx, p, answer) {
  if (p.per !== HOURS || answer.empty) return answer;
  const dim = p.by?.startsWith('$') ? p.by.slice(1) : null;
  const own = dim ? hoursBy(ctx, dim) : null;
  const all = hoursPlayed(ctx);
  if (!all) return noHours(0);
  const rows = answer.rows.map((r) => {
    const hours = own ? (own.get(String(r.value)) ?? 0) : all;
    const x = p.sum ? r.sum : answer.counts === 'sessions' ? r.sessions : r.count;
    const value = perHour(x, hours);
    return { ...r, per_hour: value, hours: hoursRound(hours), ...(value == null ? { why: `under ${Math.round(MIN_HOURS * 60)} minutes played` } : {}) };
  });
  return { ...answer, rows, unit: 'per hour', hours: hoursRound(all) };
}

// ── rates, averages and distributions (rates.js, distributions.js) ──

// What a rate or average panel says when it can't be read: the event or attribute isn't there.
function measureEmpty(ctx, f, m) {
  if (!hasEvent(ctx, f.name)) return missing(f.name);
  const why = measureProblem(ctx, f, m);
  return why ? { empty: true, why } : null;
}

// A stat's rate (with its interval) or average.
function measureStat(ctx, p, f) {
  const m = measureOf(p);
  const nope = measureEmpty(ctx, f, m);
  if (nope) return nope;
  const r = measureBy(ctx, f, m, null);
  const { num, den } = r.overall;
  if (!den) return { empty: true, why: `No "${p.event}" events carry "${m.attr}" in this window.` };
  const extra = { ...(r.estimated ? { estimated: r.estimated } : {}), from: r.source };
  if (m.kind === 'avg') return { value: avgOf(num, den), unit: null, events: Math.round(den), ...extra };
  const { rate, low, high } = rateOf(num, den);
  return { value: rate, unit: '%', events: Math.round(den), low, high, ...(p.expect != null ? { off: misses({ low, high }, p.expect) } : {}), ...extra };
}

// A stat's percentile of a numeric attribute (the median match).
function quantileStat(ctx, p, f) {
  if (!hasEvent(ctx, f.name)) return missing(f.name);
  const q = percentileOf(ctx, f, p.of, p.quantile);
  if (!q) return { empty: true, why: `No "${p.event}" events carry a number "${p.of}" in this window.` };
  return { value: q.value, unit: p.unit ?? null, count: q.count, ...(q.partial ? { partial: true } : {}), ...(q.estimated ? { estimated: q.estimated } : {}) };
}

// A rate or average over time: overall, or one line per value `by` $version, $level or an attribute (the most events
// first). A bucket without events has none.
function measureSeries(ctx, p, f) {
  const m = measureOf(p);
  const nope = measureEmpty(ctx, f, m);
  if (nope) return nope;
  const r = measureBy(ctx, f, m, p.by || null, { series: true });
  const top = [...r.groups].sort((a, b) => b[1].den - a[1].den || (a[0] < b[0] ? -1 : 1)).slice(0, p.by ? p.limit || 5 : 1);
  if (!top.length) return { empty: true, why: `No "${p.event}" events carry "${m.attr}" in this window.` };
  const value = ([num, den]) => (den ? (m.kind === 'avg' ? avgOf(num, den) : round((num / den) * 100, 1)) : null);
  const series = top.map(([label, g]) => ({ label: p.by ? label : p.rate || p.avg, values: g.series.map(value) }));
  return { ts: ctx.buckets, series, unit: m.kind === 'avg' ? null : '%', ...(r.estimated ? { estimated: r.estimated } : {}), from: r.source };
}

// A breakdown's rates (each row with its 95% interval) or averages, next to the overall one. Rows of fewer than `min`
// events are left out and counted in `small`; a row whose interval misses the line (`expect`, else the overall rate)
// is marked `off`.
function measureBreakdown(ctx, p) {
  const [f] = parseFunnel(p.event);
  const m = measureOf(p);
  const nope = measureEmpty(ctx, f, m);
  if (nope) return nope;
  if (ctx.daily && (isSessionBy(p.by) || STEAM_BY.includes(p.by))) return isSessionBy(p.by) ? { empty: true, why: sessionRows(ctx, p).why } : overDays(p.by);
  const r = measureBy(ctx, f, m, p.by);
  const min = p.min ?? MIN_EVENTS[m.kind === 'avg' ? 'avg' : 'rate'];
  const all = [...r.groups].map(([value, g]) => {
    const row = { value, events: Math.round(g.den), sessions: g.sessions ?? null };
    return m.kind === 'avg' ? { ...row, avg: avgOf(g.num, g.den) } : { ...row, ...rateOf(g.num, g.den) };
  });
  const overall = m.kind === 'avg' ? avgOf(r.overall.num, r.overall.den) : rateOf(r.overall.num, r.overall.den).rate;
  const line = p.expect ?? overall;
  const kept = all.filter((x) => x.events >= min);
  const small = all.filter((x) => x.events < min);
  const number = (x) => (m.kind === 'avg' ? x.avg : x.rate);
  const order = p.order ?? 'rate';
  kept.sort((a, b) => (order === 'count' ? b.events - a.events : order === 'value' ? naturalCompare(a.value, b.value) : number(b) - number(a) || b.events - a.events) || naturalCompare(a.value, b.value));
  const top = kept.slice(0, p.limit || 10).map((x) => (m.kind === 'avg' ? x : { ...x, off: misses(x, line) }));
  const list = !p.by.startsWith('$') && !!eventIndex(ctx).get(f.name)?.attrs.get(p.by)?.list;
  if (!all.length) return { empty: true, why: `No "${p.event}" events carry both "${m.attr}" and "${p.by}" in this window.` };
  return {
    overall,
    events: Math.round(r.overall.den),
    rows: top,
    more: kept.length - top.length,
    small: { rows: small.length, events: small.reduce((n, x) => n + x.events, 0), min },
    ...(m.kind === 'avg' ? {} : { line }),
    ...(list ? { list: true } : {}),
    ...(r.estimated ? { estimated: r.estimated } : {}),
    from: r.source,
  };
}

// A distribution panel: the attribute's percentiles and histogram, and with `by` a row per value.
function distributionPanel(ctx, p) {
  const [f] = parseFunnel(p.event);
  if (!hasEvent(ctx, f.name)) return missing(f.name);
  if (ctx.daily && (isSessionBy(p.by) || STEAM_BY.includes(p.by))) return isSessionBy(p.by) ? { empty: true, why: sessionRows(ctx, p).why } : overDays(p.by);
  const d = distributionOf(ctx, f, p.of, { by: p.by ?? null, bins: p.bins ?? BINS.default, limit: p.limit ?? ROWS.default });
  if (!d) return { empty: true, why: `No "${p.event}" events carry a number "${p.of}" in this window.` };
  return { ...d.total, ...(d.rows ? { rows: d.rows, more: d.more } : {}), ...(d.partial ? { partial: true } : {}), ...(d.estimated ? { estimated: d.estimated } : {}), from: d.source };
}

// Counts of a filter the cells can't count (a list that contains all of several values, a filtered event by another
// attribute), per value `by`, from the occurrences: [{ value, count, sessions, series }], the most first.
function occurrenceRows(ctx, f, by) {
  const out = new Map();
  const groupsOf = occurrenceGroups(by, ctx);
  eachOccurrence(ctx, f, (o) => {
    for (const g of groupsOf(o)) {
      let x = out.get(g);
      if (!x) out.set(g, (x = { value: g, count: 0, sessions: new Set(), series: new Array(ctx.buckets.length).fill(0) }));
      x.count += o.w;
      x.series[bucketOf(ctx, o.ts)] += o.w;
      x.sessions.add(o.s);
    }
  });
  return [...out.values()].map((x) => ({ ...x, count: Math.round(x.count), sessions: x.sessions.size, series: x.series.map(Math.round) })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
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
    const key = p.type === 'stat' && !LIVE_STATS.has(p.metric) && JSON.stringify([p.metric, p.event, p.sum, p.per, p.rate, p.avg, p.of, p.quantile]);
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
    unit: columnUnit(s),
    metric: s.metric,
    event: s.event,
    per: s.per,
    ...(s.rate ? { rate: s.rate } : {}),
    ...(s.avg ? { avg: s.avg } : {}),
    ...(s.of ? { of: s.of, quantile: s.quantile } : {}),
    ...(s.sum ? { sum: s.sum, currency: ctx ? sumsBy(ctx, parseFunnel(s.event)[0], s.sum, { currency: s.currency }).currency : null } : {}),
  }));
}
const PER_SESSION = new Set(['errors', 'deaths']);

// What a version column's numbers are in: per hour played, a rate, an average or percentile in the attribute's own
// unit, else per session (counts and sums: versions with more players compare).
function columnUnit(s) {
  if (s.per === HOURS) return 'per hour';
  if (s.rate) return '%';
  if (s.avg) return null;
  if (s.of) return s.unit ?? null;
  if (s.metric) return PER_SESSION.has(s.metric) ? 'per session' : STATS[s.metric].unit || null;
  return s.sum ? `per ${PER[s.per] || 'session'}` : s.per ? '%' : 'per session';
}

function defaultSize(p) {
  if (STORE_PANELS[p.type]) return typeof STORE_PANELS[p.type].size === 'function' ? STORE_PANELS[p.type].size(p) : STORE_PANELS[p.type].size;
  if (p.type === 'stat') return 's';
  if (['levels', 'events', 'sessions', 'versions', 'live'].includes(p.type)) return 'l';
  return 'm';
}

function defaultTitle(p) {
  if (STORE_PANELS[p.type]) return STORE_PANELS[p.type].title(p);
  const by = (k) => (SESSION_SPLITS[k?.slice(1)] ? SESSION_SPLITS[k.slice(1)].label : k?.startsWith('$') ? k.slice(1) : k);
  switch (p.type) {
    case 'stat':
      if (p.metric) return `${STATS[p.metric].label}${p.per === HOURS ? ' per hour played' : ''}`;
      if (p.rate) return `${p.event}: ${p.rate}`;
      if (p.avg) return `Average ${p.avg} of ${p.event}`;
      if (p.of) return `${p.event} ${p.of}, ${p.quantile === 50 ? 'median' : `p${p.quantile}`}`;
      if (p.per === HOURS) return `${p.event}${p.sum ? ` ${p.sum}` : ''} per hour played`;
      if (p.sum) return `${p.event} ${p.sum}${p.per ? ` per ${PER[p.per]}` : ''}`;
      if (PER[p.per]) return p.per === '$players' ? `Players who sent ${p.event}` : `Sessions that sent ${p.event}`;
      return p.per ? `${p.event} per ${p.per}` : p.event;
    case 'series':
      return `${p.event ?? 'Sessions'}${p.sum ? ` ${p.sum}` : ''}${p.rate ? ` ${p.rate}` : ''}${p.avg ? ` average ${p.avg}` : ''}${p.per === HOURS ? ' per hour played' : ''}${p.by ? ` by ${by(p.by)}` : ''}`;
    case 'breakdown':
      return `${p.event ?? 'Sessions'}${p.sum ? ` ${p.sum}` : ''}${p.rate ? ` ${p.rate}` : ''}${p.avg ? ` average ${p.avg}` : ''}${p.per === HOURS ? ' per hour played' : ''} by ${STEAM_BY.includes(p.by) ? STEAM_LABELS[p.by.slice(1)] : by(p.by)}`;
    case 'distribution':
      return `${p.event} ${p.of}${p.by ? ` by ${STEAM_BY.includes(p.by) ? STEAM_LABELS[p.by.slice(1)] : by(p.by)}` : ''}`;
    case 'funnel':
      return p.steps
        .split(',')
        .map((s) => s.trim())
        .join(' → ');
    case 'levels':
      return `${p.label ? `${p.label}s` : 'Levels'}${p.level ? ` (${p.level})` : ''}${p.by ? ` by ${by(p.by)}` : ''}`;
    case 'frame_time':
      return 'Frame time';
    case 'errors':
      return 'Top errors';
    case 'deaths':
      return p.by ? `Deaths by ${by(p.by)}` : 'Deaths';
    case 'events':
      return 'All events';
    case 'findings':
      return 'Findings';
    case 'reports':
      return 'Bug reports';
    case 'retention':
      return p.by ? `Retention by ${p.by.slice(1)}` : 'Retention';
    case 'sessions':
      return p.sent ? `Sessions that sent ${p.sent}` : 'Recent sessions';
    case 'versions':
      return p.by ? `By ${STEAM_LABELS[p.by.slice(1)] ?? p.by.slice(1)}` : 'By version';
    case 'live':
      return 'Live';
    case 'positions':
      return `${p.show === 'path' ? 'Where players went' : p.show === 'both' ? 'Where players went and died' : 'Where players died'} on ${p.level}`;
    case 'net':
      return `${p.show === 'loss' ? 'Packet loss' : p.show === 'disconnects' ? 'Disconnects and why' : 'Ping'}${p.by ? ` by ${by(p.by)}` : ''}`;
    case 'servers':
      return p.show === 'crashes' ? 'Server crashes' : p.show === 'players' ? `Players per server${p.by ? ` by ${by(p.by)}` : ''}` : `Server tick by ${p.by && p.by !== 'players' ? by(p.by) : 'players connected'}`;
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
