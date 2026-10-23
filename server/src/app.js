// The whole Glitchless backend is one plain Node HTTP handler, so the exact same code runs on a laptop
// (`npm run server`) and on AWS Lambda Web Functions (which runs a normal server listening on a port).

import fs from 'node:fs';
import path from 'node:path';
import { parsePayload, normalize, IntakeError, decodeBody } from './ingest.js';
import { buildContext, overview, performance, errorIssues, players, customEvents, eventFunnel, parseFunnel, heatmap, heatmapLevels, heatmapLevel, sessionsList, sessionDetail, versions, playtestSummary } from './analytics.js';
import { findings, gameEngine } from './findings.js';
import { validateDashboard, autoDashboard, evaluateBoard, versionColumns, dashboardStats, VIEWS, BoardError } from './board.js';
import { defaultAuth, AuthError, RateLimiter, DEFAULT_INGEST_RPS, DEFAULT_SHARE_RPS, SHARE_MAX_DAYS, isProjectId } from './auth.js';
import { reportsOf, reportSummary, reportDetail, reportTimeline } from './reports.js';
import { createSourcemaps, MAX_UPLOAD_BYTES } from './sourcemaps.js';
import { eventSums } from './sums.js';
import { Presence, PLAYERS_NOW_MS } from './presence.js';

const MAX_BODY = 1_000_000;
const DAY = 86_400_000;
// Queries whose frame-time and count sections can come from per-minute rollups.
const ROLLUP_QUERIES = new Set(['overview', 'performance', 'versions', 'findings', 'events', 'dashboard', 'board']);
// Queries that show or rank bug reports (reports.js): they read the range's reports as ctx.reports.
const REPORT_QUERIES = new Set(['reports', 'overview', 'findings', 'dashboard', 'board', 'session']);
// Queries that show error issues: a web build with source maps gets their original frames (sourcemaps.js).
const SOURCEMAP_QUERIES = new Set(['errors', 'overview', 'findings', 'board', 'playtest']);
// Queries that show retention: they read who is new from the store's first-seen index (ctx.cohorts).
const RETENTION_QUERIES = new Set(['players', 'board']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// `auth` is { resolveIngest, resolveReader } (see auth.js); the default is the open-source single project.
// maxUploadBytes: the largest source map upload this host takes (a host behind a smaller body limit, such as
// Lambda's 6 MB, passes less, so a big map gets a clear 413 rather than the host's own error).
export function createApp({ store, forwarder = null, auth = defaultAuth(), staticRoutes = [], logger = console, maxUploadBytes = MAX_UPLOAD_BYTES }) {
  const subscribers = new Set();
  const activity = [];
  const cache = new Map();
  const limiter = new RateLimiter();
  const readLimiter = new RateLimiter();
  const counters = { received: 0, requests: 0, startedAt: Date.now() };
  const sourcemaps = createSourcemaps(store, { logger });
  // Players now, counted in this process unless the host counts them itself (auth.playersNow).
  const presence = auth.playersNow ? null : new Presence();
  const playersNow = (projectId, service) => (auth.playersNow ? auth.playersNow(projectId, service) : presence.count(projectId, service));

  async function handle(req, res) {
    counters.requests++;
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    setCors(res);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    try {
      if (p === '/v1/health') {
        return json(res, 200, { ok: true, store: store.kind, runtime: `${process.platform}-${process.arch}`, uptime_s: Math.round((Date.now() - counters.startedAt) / 1000), received: counters.received, exporters: forwarder?.status?.() ?? [] });
      }

      if (p === '/v1/intake' && req.method === 'POST') {
        const token = url.searchParams.get('token');
        const writer = checkIdentity(await auth.resolveIngest(token, req));
        const wait = limiter.take(`${writer.projectId}\n${writer.keyId ?? token}`, writer.rps ?? DEFAULT_INGEST_RPS);
        if (wait) {
          res.setHeader('Retry-After', String(wait));
          return json(res, 429, { error: 'rate limit exceeded' });
        }
        const body = decodeBody(await readBody(req));
        const parsed = normalize(parsePayload(body, { projectId: writer.projectId }));
        const admitted = auth.admitIntake ? await auth.admitIntake(writer, parsed) : { events: parsed };
        const events = admitted.events;
        if (events.length) {
          await sourcemaps.refingerprint(writer.projectId, events);
          await store.put(writer.projectId, events, writer);
          counters.received += events.length;
          presence?.record(writer.projectId, events);
          clearCache(writer.projectId);
          if (auth.recordIntake) await Promise.resolve(auth.recordIntake(writer, events)).catch((err) => logger.warn('[intake] record', err.message));
        }
        json(res, 202, { accepted: events.length, ...(admitted.dropped ? { dropped: admitted.dropped, reason: admitted.reason } : {}) });
        if (!events.length) return;
        broadcast(writer.projectId, events);
        forwarder?.forward(events).catch((err) => logger.warn('[export]', err.message));
        return;
      }

      // Everything else under /v1/ reads (or deletes) one project's data, never the intake token's.
      const reader = p.startsWith('/v1/') ? checkIdentity(await auth.resolveReader(req)) : null;
      if (reader) {
        const wait = readLimiter.take(`${reader.projectId}\n${reader.keyId ?? ''}`, reader.rps ?? (reader.share ? DEFAULT_SHARE_RPS : 0));
        if (wait) {
          res.setHeader('Retry-After', String(wait));
          return json(res, 429, { error: 'rate limit exceeded' });
        }
        const refused = reader.share && shareOnly(req, url, reader.share);
        if (refused) return json(res, 403, { error: refused });
      }
      const allow = (scope) => reader.scopes?.includes(scope) || json(res, 403, { error: `this key lacks the ${scope} scope` });

      if (p === '/v1/live') return allow('read') && live(req, res, url, reader.projectId);

      // A game's dashboard (board.js): read with the read scope, saved or reset to automatic with the dashboard scope.
      if (p === '/v1/dashboard') {
        const service = url.searchParams.get('service');
        if (!service) return json(res, 400, { error: 'service is required' });
        if (req.method === 'GET') return allow('read') && json(res, 200, { service, dashboard: await store.getDashboard(reader.projectId, service) });
        if (req.method === 'PUT') {
          if (!allow('dashboard')) return;
          let input;
          try {
            input = JSON.parse(await readBody(req));
          } catch {
            return json(res, 400, { error: 'invalid JSON' });
          }
          const dashboard = { ...validateDashboard(input), updated_at: Date.now(), updated_by: String(req.headers['x-glitchless-client'] || 'api').slice(0, 40) };
          await store.putDashboard(reader.projectId, service, dashboard);
          clearCache(reader.projectId);
          return json(res, 200, { service, dashboard });
        }
        if (req.method === 'DELETE') {
          if (!allow('dashboard')) return;
          await store.putDashboard(reader.projectId, service, null);
          clearCache(reader.projectId);
          return json(res, 200, { service, dashboard: null });
        }
        return json(res, 405, { error: 'GET, PUT or DELETE' });
      }

      if (p.startsWith('/v1/query/') && req.method === 'GET') {
        if (!allow('read')) return;
        const { projectId } = reader;
        const name = p.slice('/v1/query/'.length);
        const client = req.headers['x-glitchless-client'];
        if (client && client !== 'dashboard' && !reader.share) {
          const params = Object.fromEntries(url.searchParams);
          delete params.api_key;
          activity.push({ projectId, ts: Date.now(), client, query: name, params });
          if (activity.length > 200) activity.shift();
        }
        const key = `${projectId}\n${reader.share ? `${pinned(reader.share) ? 'pinned' : 'share'}${reader.share.sums ? '+sums' : ''}\n` : ''}${p}?${withoutKey(url.searchParams)}`;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < 4000) return json(res, 200, hit.body);
        const body = await query(projectId, name, url.searchParams, reader);
        if (body === undefined) return json(res, 404, { error: `unknown query: ${name}` });
        cache.set(key, { at: Date.now(), body });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return json(res, 200, body);
      }

      // A web build's source maps (sourcemaps.js), one per POST: the body is the .map file (or its gzip), `file` the
      // minified script's path in the build (default: the map's own "file"). GET lists them, DELETE drops a version's.
      if (p === '/v1/sourcemaps') {
        const service = url.searchParams.get('service')?.toLowerCase();
        const version = url.searchParams.get('version');
        if (!service || service.length > 128 || (version != null && (!version || version.length > 128))) return json(res, 400, { error: 'service (and version, to upload or delete) are required' });
        if (req.method === 'GET') return allow('read') && json(res, 200, { service, sourcemaps: (await sourcemaps.list(reader.projectId, service)).filter((m) => version == null || m.version === version) });
        if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'GET, POST or DELETE' });
        if (!allow('sourcemaps')) return;
        if (!version) return json(res, 400, { error: 'version is required: the version the game passes to Glitchless.init' });
        if (req.method === 'DELETE') {
          if (!(await sourcemaps.remove(reader.projectId, service, version))) return json(res, 404, { error: `no source maps for ${service} ${version}` });
          clearCache(reader.projectId);
          return json(res, 200, { service, deleted: version });
        }
        const stored = await sourcemaps.upload(reader.projectId, { service, version, file: url.searchParams.get('file') }, await readBody(req, maxUploadBytes));
        clearCache(reader.projectId);
        return json(res, 201, stored);
      }

      if (p === '/v1/data' && req.method === 'DELETE') {
        if (!allow('delete')) return;
        const service = url.searchParams.get('service');
        if (!service) return json(res, 400, { error: 'service is required' });
        await store.clear(reader.projectId, service);
        clearCache(reader.projectId);
        return json(res, 200, { cleared: service });
      }

      // One bug report, screenshot and all: what a player who asks for their report to go away needs.
      if (p === '/v1/report' && req.method === 'DELETE') {
        if (!allow('delete')) return;
        const service = url.searchParams.get('service');
        const id = url.searchParams.get('id');
        if (!service || !id) return json(res, 400, { error: 'service and id are required' });
        if (!store.deleteReport || !(await store.deleteReport(reader.projectId, service, id))) return json(res, 404, { error: 'report not found' });
        clearCache(reader.projectId);
        return json(res, 200, { deleted: id });
      }

      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p, staticRoutes);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof IntakeError || err instanceof AuthError || err instanceof BoardError) return json(res, err.status, { error: err.message });
      logger.error('[glitchless]', err);
      return json(res, 500, { error: err.message });
    }
  }

  // Every read goes through projectId; `service` only picks a game within that project.
  // `reader` (the auth hook's identity) may carry the project's `plan`: ranges stop at its retention.
  async function query(projectId, name, params, reader = {}) {
    // max_range_days: the longest range this store answers for the reader (null: no limit).
    if (name === 'services') {
      const services = await store.services(projectId);
      const max = store.maxRangeDays ? store.maxRangeDays(reader.plan) : null;
      if (reader.share) return { services: services.filter((s) => s.service === reader.share.service), max_range_days: Math.min(max ?? SHARE_MAX_DAYS, SHARE_MAX_DAYS), window: pinned(reader.share) ? { from: reader.share.from, to: reader.share.to } : null };
      return { services, max_range_days: max };
    }
    if (name === 'activity') return { activity: activity.filter((a) => a.projectId === projectId).reverse().map(({ projectId: _, ...a }) => a) };
    const services = await store.services(projectId);
    const service = params.get('service') || services.sort((a, b) => b.last_seen - a.last_seen)[0]?.service;
    if (!service) return emptyFor(name);
    const now = Date.now();
    const to = num(params.get('to')) ?? now;
    const from = num(params.get('from')) ?? (name === 'session' ? now - 7 * DAY : now - DAY);
    if (name === 'report') {
      // One bug report by id, with its screenshot (screenshot=0 leaves it out): no range to read.
      const r = params.get('id') && store.getReport ? await store.getReport(projectId, service, params.get('id')) : null;
      return r ? { meta: { service }, report: reportDetail(r, null, { screenshot: params.get('screenshot') !== '0' }) } : { meta: { service }, error: 'report not found' };
    }
    if (name === 'players_now') return { meta: { service }, players_now: await playersNow(projectId, service), window_s: PLAYERS_NOW_MS / 1000 };
    if (name === 'dashboard') {
      // A saved dashboard needs no data: only the automatic one is made from what the game sent.
      const saved = await store.getDashboard(projectId, service);
      if (saved) return dashboardBody({ service }, saved, saved);
    }
    const ids = params.get('sessions')?.split(',').map((s) => s.trim()).filter(Boolean);
    const q = { service, from, to, env: params.get('env') || null, version: params.get('version') || null, type: params.get('type') || 'all', sessions: ids?.length ? new Set(ids) : null, plan: reader.plan ?? null };
    let ctx;
    if (store.context) {
      // Stores that keep summaries build the context themselves (and answer in whole minutes).
      ctx = await store.context(projectId, q, name, params);
    } else {
      const raw = await store.query(projectId, { service, from, to });
      const rollups = ROLLUP_QUERIES.has(name) && q.type === 'all' && !q.sessions ? await store.rollups(projectId, { service, from, to }) : null;
      ctx = buildContext(raw, q, rollups);
    }
    // Reports are kept apart from the events (stored as they arrive), so they answer for the range as asked.
    ctx.reports = REPORT_QUERIES.has(name) && store.reports ? reportsOf(await store.reports(projectId, service, { from, to }), ctx) : [];
    if (SOURCEMAP_QUERIES.has(name)) await sourcemaps.prepare(ctx, projectId, service);
    // Day groups carry their new players (daily.js); other contexts ask the store who was first seen in the range.
    if (RETENTION_QUERIES.has(name) && !ctx.daily && store.cohorts) ctx.cohorts = await store.cohorts(projectId, service, ctx.from, ctx.to);
    // A store's own notes (ctx.meta): resolution 'day' and what is approximate, for long ranges.
    const meta = { service, from: ctx.from, to: ctx.to, env: q.env, version: q.version, bucket_ms: ctx.bucketMs, ...(ctx.drill?.failed?.length ? { partial: ctx.drill.failed } : {}), ...(ctx.meta || {}) };
    switch (name) {
      case 'overview':
        return { meta, ...overview(ctx), findings: findings(ctx, await store.getMaps(projectId, service)).slice(0, 6) };
      case 'performance':
        return { meta, ...performance(ctx) };
      case 'errors':
        return { meta, issues: errorIssues(ctx) };
      case 'players':
        return { meta, ...players(ctx) };
      case 'events': {
        const steps = parseFunnel(params.get('funnel'));
        // Each event with the sums of its numeric attributes, per currency (sums.js).
        const own = customEvents(ctx, { name: params.get('name') || null, sdk: params.get('sdk') === '1' });
        const sums = eventSums(ctx);
        return { meta, ...own, events: own.events.map((e) => ({ ...e, sums: sums.get(e.name) || [] })), ...(steps.length ? { funnel: eventFunnel(ctx, steps) } : {}) };
      }
      case 'dashboard': {
        // The game's pages, in order: what the dashboard's sidebar shows. Boards are evaluated one at a time (board).
        const { saved, spec } = await dashboardOf(projectId, service, ctx);
        return dashboardBody(meta, spec, saved);
      }
      case 'board': {
        // One board page with its numbers: `page` is its id (default: the first board).
        const { saved, spec } = await dashboardOf(projectId, service, ctx);
        const boards = spec.pages.filter((x) => x.panels);
        const id = params.get('page');
        const page = id ? spec.pages.find((x) => x.id === id) : boards[0];
        if (!page) return { meta, error: id ? `no page "${id}" on this dashboard` : 'this dashboard has no boards', ...(reader.share ? {} : { pages: spec.pages.map((x) => x.id) }) };
        if (!page.panels) return { meta, error: `"${page.id}" is the built-in ${page.view} view, not a board`, view: page.view };
        const maps = page.panels.some((x) => x.type === 'findings') ? await store.getMaps(projectId, service) : [];
        if (page.panels.some((x) => x.metric === 'players_now')) ctx.playersNow = await playersNow(projectId, service);
        return { meta, board: { page: page.id, title: page.title, source: saved ? 'saved' : 'auto', updated_at: saved?.updated_at ?? null, updated_by: saved?.updated_by ?? null, spec: { panels: page.panels }, panels: evaluateBoard(ctx, page, { maps, shared: reader.share || false, currency: spec.currency }) } };
      }
      case 'heatmap': {
        const maps = await store.getMaps(projectId, service);
        const level = heatmapLevel(ctx, maps, params.get('level'));
        return { meta, levels: heatmapLevels(ctx, maps), ...(level ? heatmap(ctx, level, maps) : {}) };
      }
      case 'sessions':
        return { meta, sessions: sessionsList(ctx) };
      case 'session': {
        const detail = sessionDetail(ctx, params.get('id'), await store.getMaps(projectId, service));
        if (detail) detail.timeline = [...(await sourcemaps.timeline(projectId, service, detail.session.version, detail.timeline)), ...reportTimeline(ctx.reports, params.get('id'))].sort((a, b) => a.ts - b.ts);
        return detail ? { meta, ...detail } : { meta, error: 'session not found' };
      }
      case 'reports':
        // Players' bug reports, newest first, without their screenshots (report?id= above gives one with it).
        return { meta, reports: ctx.reports.map((r) => reportSummary(r, ctx)), engine: gameEngine(ctx) };
      case 'versions': {
        // Compared per version: the numbers on the game's boards (their stat panels), then its own events.
        const { spec } = await dashboardOf(projectId, service, ctx);
        const stats = dashboardStats(spec);
        const list = versions(ctx, { stats });
        const has = {
          frames: list.some((v) => v.frame_p95 != null),
          levels: list.some((v) => v.level_attempts > 0),
          deaths: list.some((v) => v.deaths_per_session > 0),
          fails: list.some((v) => v.level_fails > 0),
          geometry: list.some((v) => v.geometries_growth_per_level_load != null),
        };
        return { meta, versions: list, has, board: versionColumns(stats, ctx) };
      }
      case 'playtest':
        // Only meaningful for an explicit set of sessions (the ones a playtest run produced).
        if (!q.sessions) return { meta, error: 'playtest needs sessions=<comma-separated session ids>' };
        return { meta, summary: playtestSummary(ctx) };
      case 'findings':
        return { meta, findings: findings(ctx, await store.getMaps(projectId, service)) };
      default:
        return undefined;
    }
  }

  function dashboardBody(meta, spec, saved) {
    const pages = spec.pages.map(({ panels, view, options, ...p }) => ({ ...p, icon: p.icon || (view ? VIEWS[view].icon : 'board'), ...(view ? { view, ...(options ? { options } : {}) } : { panels: panels.length }) }));
    return { meta, dashboard: { source: saved ? 'saved' : 'auto', updated_at: saved?.updated_at ?? null, updated_by: saved?.updated_by ?? null, spec: { ...(spec.currency ? { currency: spec.currency } : {}), pages: spec.pages }, pages } };
  }

  // The game's dashboard: the saved one, or the automatic one made from what it sends.
  async function dashboardOf(projectId, service, ctx) {
    const saved = await store.getDashboard(projectId, service);
    return { saved, spec: saved || autoDashboard(ctx) };
  }

  function live(req, res, url, projectId) {
    const service = url.searchParams.get('service');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': glitchless live tail\n\n');
    const sub = { res, service, projectId };
    subscribers.add(sub);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      subscribers.delete(sub);
    });
  }

  function broadcast(projectId, events) {
    if (!subscribers.size) return;
    for (const sub of subscribers) {
      if (sub.projectId !== projectId) continue;
      const mine = events.filter((e) => (!sub.service || e.service === sub.service) && e.type !== 'map' && e.type !== 'pos');
      if (!mine.length) continue;
      const slim = mine.map(({ ft, stack, received, screenshot, ...e }) => e);
      sub.res.write(`data: ${JSON.stringify(slim)}\n\n`);
    }
  }

  function clearCache(projectId) {
    for (const key of cache.keys()) if (key.startsWith(`${projectId}\n`)) cache.delete(key);
  }

  return handle;
}

// A share reader (`share: { service, page, from?, to? }` from the auth hook, a read-only link anyone may hold)
// may GET the `board` query for its page and `services` (its service only), over at most SHARE_MAX_DAYS. A
// pinned link (`from` and `to`) answers its own window whatever the request asks; any other link answers the
// request's range, cut to SHARE_MAX_DAYS. Everything else is refused. The request's parameters become exactly
// those, so no other filter or id reaches a query. (The store still cuts a range to the reader's retention.)
const SHARE_QUERIES = new Set(['/v1/query/board', '/v1/query/services']);
const pinned = (share) => Number.isFinite(share.from) && Number.isFinite(share.to);
function shareOnly(req, url, share) {
  const q = url.searchParams;
  const other = (k) => q.get(k) != null && q.get(k) !== share[k];
  if (req.method !== 'GET' || !SHARE_QUERIES.has(url.pathname) || other('service') || other('page')) return 'a share link shows one board and nothing else';
  const to = pinned(share) ? share.to : (num(q.get('to')) ?? Date.now());
  const from = Math.max(pinned(share) ? share.from : (num(q.get('from')) ?? to - DAY), to - SHARE_MAX_DAYS * DAY);
  url.search = new URLSearchParams({ service: share.service, page: share.page, from, to }).toString();
  return null;
}

// Hooks are written elsewhere (the hosted control plane), so check what they return before trusting it.
function checkIdentity(identity) {
  if (!isProjectId(identity?.projectId)) throw new Error('auth hook returned no valid projectId');
  return identity;
}

function withoutKey(params) {
  const copy = new URLSearchParams(params);
  copy.delete('api_key');
  return copy.toString();
}

function emptyFor(name) {
  return { meta: null, empty: true, ...(name === 'sessions' ? { sessions: [] } : {}), ...(name === 'reports' ? { reports: [] } : {}), ...(name === 'errors' ? { issues: [] } : {}), ...(name === 'findings' ? { findings: [] } : {}), ...(name === 'events' ? { events: [] } : {}), ...(name === 'dashboard' ? { dashboard: null } : {}) };
}

function serveStatic(res, pathname, routes) {
  for (const { prefix, dir, spa } of routes) {
    if (!pathname.startsWith(prefix) || !dir || !fs.existsSync(dir)) continue;
    if (prefix.endsWith('/') && pathname === prefix.slice(0, -1)) {
      res.writeHead(301, { Location: prefix });
      return res.end();
    }
    let rel = decodeURIComponent(pathname.slice(prefix.length));
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(dir)) return send(res, 403, 'forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
    if (spa) return sendFile(res, path.join(dir, 'index.html'));
  }
  return send(res, 404, 'not found');
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const immutable = /[.-][A-Za-z0-9_-]{8,}\.(js|css|png|jpg|webp|woff2)$/.test(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-glitchless-api-key, x-glitchless-client');
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json');
}

function send(res, status, body, type = 'text/plain') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

// Past `max` the request is refused (413), and the rest of the body is read and dropped so the client gets that
// answer instead of a closed socket; one that keeps sending past twice the limit is cut off.
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let refused = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) return void chunks.push(c);
      if (!refused) {
        refused = true;
        chunks.length = 0;
        reject(new IntakeError(413, 'payload too large'));
      }
      if (size > max * 2) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
