// The whole Glitchless backend is one plain Node HTTP handler: `npm run server`, the Docker image, or any host
// that gives it a store (createApp below).

import fs from 'node:fs';
import path from 'node:path';
import { parsePayload, normalize, IntakeError, decodeBody, FEATURES, companionOf, isCompanion, gameOf, withServers } from './ingest.js';
import { buildContext, round, overview, performance, errorIssues, players, customEvents, eventFunnel, parseFunnel, heatmap, heatmapLevels, heatmapLevel, sessionsList, sessionDetail, versions, playtestSummary, steamWhere, STEAM_DIMENSIONS, playersAreSessions, sessionCount } from './analytics.js';
import { findings, gameEngine } from './findings.js';
import { validateDashboard, autoDashboard, evaluateBoard, eventQuery, versionColumns, dashboardStats, pathLevels, levelRows, VIEWS, BoardError } from './board.js';
import { defaultAuth, AuthError, RateLimiter, DEFAULT_INGEST_RPS, DEFAULT_SHARE_RPS, SHARE_MAX_DAYS, isProjectId } from './auth.js';
import { reportsOf, reportSummary, reportDetail, reportTimeline } from './reports.js';
import { createSourcemaps, MAX_UPLOAD_BYTES } from './sourcemaps.js';
import { eventSums } from './sums.js';
import { hoursPlayed } from './rates.js';
import { eventPercentiles } from './distributions.js';
import { Presence, PLAYERS_NOW_MS } from './presence.js';
import { propsWhere, pageWhere, andWhere, propertyList, propertyKey } from './properties.js';
import { matchList, matchDetail } from './matches.js';
import { serversView } from './servers.js';
import { storeReviews, storeVitals } from './reviews.js';
import { revenueQuery } from './revenue.js';
import { BRAND_IMAGES, BrandError, checkImage, checkAccent, checkFocus, brandBody, hasBrand } from './brand.js';

const MAX_BODY = 1_000_000;
const DAY = 86_400_000;
const MINUTE = 60_000;
// How long a share link's answer may be reused, here and by any cache in front (its Cache-Control): a game
// polling a link gets the same answer for a minute, whatever arrives meanwhile.
export const SHARE_MAX_AGE_S = 60;
const SHARE_CACHE = { 'Cache-Control': `public, max-age=${SHARE_MAX_AGE_S}`, Vary: 'x-glitchless-share' };
// Queries whose frame-time and count sections can come from per-minute rollups.
const ROLLUP_QUERIES = new Set(['overview', 'performance', 'versions', 'findings', 'events', 'dashboard', 'board']);
// Queries that show or rank bug reports (reports.js): they read the range's reports as ctx.reports.
const REPORT_QUERIES = new Set(['reports', 'overview', 'findings', 'dashboard', 'board', 'session']);
// Queries that show error issues: a web build with source maps gets their original frames (sourcemaps.js).
const SOURCEMAP_QUERIES = new Set(['errors', 'overview', 'findings', 'board', 'playtest']);
// Queries that show retention or new players: they read who is new from the store's first-seen index (ctx.cohorts).
const RETENTION_QUERIES = new Set(['players', 'board', 'store_revenue']);
// Queries that compare versions or pick the newest: they put versions in release order from the store's first
// sighting of each (ctx.versionsFirstSeen, analytics.js releaseOrder), whatever the range.
const VERSION_QUERIES = new Set(['overview', 'versions', 'findings', 'board', 'store_reviews', 'store_vitals', 'store_revenue']);
// Queries that make findings, which read the game's saved boards.
const FINDING_QUERIES = new Set(['overview', 'findings', 'board']);
// Queries that read the game's servers too (A9): its companion service's sessions, as ctx.server (servers.js).
const SERVER_QUERIES = new Set(['overview', 'findings', 'board', 'servers', 'matches']);
// Queries that join a game's store reviews and vitals (reviews.js) and its revenue (revenue.js) when the host has them:
// their panels, finding, queries.
const STORE_QUERIES = new Set(['overview', 'findings', 'dashboard', 'board', 'store_reviews', 'store_vitals', 'store_revenue']);
// meta.note for an answer from a game in anonymous mode (playersAreSessions).
const PLAYERS_ARE_SESSIONS = 'no session sent a player ID (anonymous mode), so every players count here is a count of sessions';
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
// maxUploadBytes: the largest source map upload this host takes (a host behind a smaller body limit passes less,
// so a big map gets a clear 413 rather than the host's own error).
// stores: { read(projectId, service, { from, to, recordsFrom }) } → the game's store data by store ({ steam: … },
// reviews.js), or null when it is connected to none; a host without stores leaves it out.
export function createApp({ store, forwarder = null, auth = defaultAuth(), staticRoutes = [], logger = console, maxUploadBytes = MAX_UPLOAD_BYTES, stores = null }) {
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
  // Servers now (A9): a game's servers that sent anything in the last two minutes, and the players connected to them.
  const serversNow = async (projectId, service) => {
    const companion = companionOf(service);
    if (auth.serversNow) return auth.serversNow(projectId, companion);
    return { servers: presence.count(projectId, companion), players: presence.players(projectId, companion) };
  };

  async function handle(req, res) {
    counters.requests++;
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    setCors(res);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    try {
      if (p === '/v1/health') {
        // features: what intake folds of the genre additions (ingest.js FEATURES); the SDKs read it before they send
        // counters, and a server-role SDK before it sends anything.
        return json(res, 200, { ok: true, store: store.kind, runtime: `${process.platform}-${process.arch}`, uptime_s: Math.round((Date.now() - counters.startedAt) / 1000), received: counters.received, exporters: forwarder?.status?.() ?? [], features: FEATURES });
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
        const payload = parsePayload(body, { projectId: writer.projectId });
        // A batch already stored (its response never reached the game, so the game sent it again) is
        // answered as taken, and nothing in it is stored, counted or forwarded twice (SPEC §2 batch_id).
        const batch = payload.batch && store.claimBatch ? { service: payload.envelope.service, id: payload.batch } : null;
        if (batch && !(await store.claimBatch(writer.projectId, batch.service, batch.id))) return json(res, 202, { accepted: 0, duplicate: true });
        const parsed = normalize(payload);
        const admitted = auth.admitIntake ? await auth.admitIntake(writer, parsed) : { events: parsed };
        const events = admitted.events;
        if (events.length) {
          await sourcemaps.refingerprint(writer.projectId, events);
          try {
            await store.put(writer.projectId, events, writer);
          } catch (err) {
            // Not stored, so the game's retry must not be taken for a repeat.
            if (batch) await store.releaseBatch?.(writer.projectId, batch.service, batch.id).catch(() => {});
            throw err;
          }
          counters.received += events.length;
          presence?.record(writer.projectId, events);
          clearCache(writer.projectId, { shares: false });
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
        // A share link is limited where its reads compute (the query cache below): polling one costs nothing.
        if (!reader.share && limited(res, reader)) return;
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

      // A game's branding (brand.js): read with the read scope (a share link reads its own game's), changed with the
      // dashboard scope. /v1/brand is the accent and banner position (JSON); /v1/brand/logo and /v1/brand/banner are
      // the images (the body is the image), served with their own type and cached for good at their hashed address.
      if (p === '/v1/brand' || p === '/v1/brand/logo' || p === '/v1/brand/banner') {
        const service = url.searchParams.get('service');
        if (!service) return json(res, 400, { error: 'service is required' });
        if (!store.getBrand) return json(res, 501, { error: 'this server keeps no branding' });
        const kind = p === '/v1/brand' ? null : p.slice('/v1/brand/'.length);
        const { projectId } = reader;
        if (req.method === 'GET') {
          if (!allow('read')) return;
          // A share link's answers are kept for SHARE_MAX_AGE_S, as its board's are, so a crowd opening it costs one read.
          const key = reader.share && `${projectId}\nshare brand\n${p}?${url.searchParams}`;
          let a = key && cache.get(key);
          if (!a || Date.now() - a.at >= SHARE_MAX_AGE_S * 1000) {
            if (reader.share && limited(res, reader)) return;
            a = { at: Date.now(), ...(await brandAnswer(projectId, service, kind, url.searchParams.get('v'))) };
            if (key) cache.set(key, a);
            if (cache.size > 200) cache.delete(cache.keys().next().value);
          }
          return send(res, a.status, a.body, a.type, a.headers);
        }
        if (req.method !== 'PUT' && req.method !== 'DELETE') return json(res, 405, { error: 'GET, PUT or DELETE' });
        if (!allow('dashboard')) return;
        const brand = await store.getBrand(projectId, service);
        try {
          let next = { ...brand };
          if (kind && req.method === 'PUT') {
            const bytes = await readBody(req, BRAND_IMAGES[kind].maxBytes);
            next[kind] = checkImage(kind, bytes);
            await store.putBrandImage(projectId, service, kind, bytes);
          } else if (kind) next[kind] = null;
          else if (req.method === 'PUT') {
            let input;
            try {
              input = JSON.parse(await readBody(req));
            } catch {
              return json(res, 400, { error: 'invalid JSON' });
            }
            if ('accent' in input) next.accent = checkAccent(input.accent);
            if ('banner_focus' in input) next.banner_focus = checkFocus(input.banner_focus);
          } else next = null; // DELETE /v1/brand: back to no branding
          next = hasBrand(next) ? { ...next, updated_at: Date.now(), updated_by: String(req.headers['x-glitchless-client'] || 'api').slice(0, 40) } : null;
          await store.putBrand(projectId, service, next);
          // An image the brand no longer names goes once the brand stops naming it.
          for (const k of Object.keys(BRAND_IMAGES)) if (brand?.[k] && !next?.[k]) await store.putBrandImage(projectId, service, k, null);
          clearCache(projectId);
          return json(res, 200, { service, brand: brandBody(service, next) });
        } catch (err) {
          if (err instanceof BrandError || err instanceof IntakeError) return json(res, err.status, { error: err.message });
          throw err;
        }
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
        // Share answers are kept apart from members' (pinned links' from rolling ones', with sums from without),
        // for SHARE_MAX_AGE_S however many events arrive; members' for 4 s, until the next batch.
        const share = reader.share ? `share ${pinned(reader.share) ? 'pinned' : 'rolling'}${reader.share.sums ? '+sums' : ''}\n` : '';
        const key = `${projectId}\n${share}${p}?${withoutKey(url.searchParams)}`;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < (share ? SHARE_MAX_AGE_S * 1000 : 4000)) return json(res, 200, hit.body, share ? SHARE_CACHE : undefined);
        if (share && limited(res, reader)) return;
        const body = await query(projectId, name, url.searchParams, reader);
        if (body === undefined) return json(res, 404, { error: `unknown query: ${name}` });
        cache.set(key, { at: Date.now(), body });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return json(res, 200, body, share ? SHARE_CACHE : undefined);
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
      const services = withServers(await store.services(projectId));
      const max = store.maxRangeDays ? store.maxRangeDays(reader.plan) : null;
      if (reader.share) return { services: services.filter((s) => s.service === reader.share.service), max_range_days: Math.min(max ?? SHARE_MAX_DAYS, SHARE_MAX_DAYS), window: pinned(reader.share) ? { from: reader.share.from, to: reader.share.to } : null };
      return { services, max_range_days: max };
    }
    if (name === 'activity') return { activity: activity.filter((a) => a.projectId === projectId).reverse().map(({ projectId: _, ...a }) => a) };
    const services = await store.services(projectId);
    // The default game is the one that sent last, never a game's servers (its companion, A9).
    const service = params.get('service') || services.filter((s) => !isCompanion(s.service) || !services.some((x) => x.service === gameOf(s.service))).sort((a, b) => b.last_seen - a.last_seen)[0]?.service;
    if (!service) return emptyFor(name);
    const now = Date.now();
    const to = num(params.get('to')) ?? now;
    const from = num(params.get('from')) ?? (name === 'session' ? now - 7 * DAY : now - DAY);
    if (name === 'report') {
      // One bug report by id, with its screenshot (screenshot=0 leaves it out): no range to read.
      const r = params.get('id') && store.getReport ? await store.getReport(projectId, service, params.get('id')) : null;
      return r ? { meta: { service }, report: reportDetail(r, null, { screenshot: params.get('screenshot') !== '0' }) } : { meta: { service }, error: 'report not found' };
    }
    if (name === 'players_now') return { meta: { service }, players_now: await playersNow(projectId, service), window_s: PLAYERS_NOW_MS / 1000, ...(services.some((s) => s.service === companionOf(service)) ? { servers_now: await serversNow(projectId, service) } : {}) };
    if (name === 'dashboard') {
      // A saved dashboard needs no data: only the automatic one is made from what the game sent.
      const saved = await store.getDashboard(projectId, service);
      if (saved) return dashboardBody({ service }, saved, saved);
    }
    const ids = params.get('sessions')?.split(',').map((s) => s.trim()).filter(Boolean);
    const q = { service, from, to, env: params.get('env') || null, version: params.get('version') || null, type: params.get('type') || 'all', sessions: ids?.length ? new Set(ids) : null, plan: reader.plan ?? null };
    // A share link shows players: the sessions of people (no bots, playtests, store test phones or TestFlight testers) on
    // the game's prod environment when it has one (no dev builds), as findings read them.
    if (reader.share) {
      q.type = 'user';
      if (services.find((s) => s.service === service)?.envs?.includes('prod')) q.env = 'prod';
    }
    // The levels a board's positions panels draw paths for: a store that keeps summaries reads their position
    // samples apart (only a saved dashboard has positions panels).
    const saved = name === 'board' ? await store.getDashboard(projectId, service) : undefined;
    const levels = saved ? pathLevels(boardPage(saved, params.get('page'))) : [];
    if (levels.length) q.positions = levels;
    // Steam facts the sessions must have (steam_branch=beta…, SPEC §4c), and the one versions are grouped by instead.
    q.where = steamWhere(params);
    // Session properties the sessions must have (prop.rank=diamond, A6), and a board page's own `where`.
    q.props = andWhere(propsWhere(params), name === 'board' && saved ? pageWhere(boardPage(saved, params.get('page'))?.where) : null);
    const by = params.get('by');
    q.by = name === 'versions' && (STEAM_DIMENSIONS.includes(by) || propertyKey(`$${by}`)) ? by : null;
    let versionsSeen;
    let dashboardSaved;
    const contextFor = async (q) => {
      let ctx;
      if (store.context) {
        // Stores that keep summaries build the context themselves (and answer in whole minutes).
        ctx = await store.context(projectId, q, name, params);
      } else {
        const raw = await store.query(projectId, { service: q.service, from, to });
        const rollups = ROLLUP_QUERIES.has(name) && q.type === 'all' && !q.sessions && !q.where && !q.props ? await store.rollups(projectId, { service: q.service, from, to }) : null;
        ctx = buildContext(raw, q, rollups);
      }
      if (q.service !== service) return ctx; // the game's servers (A9): their sessions and cells only
      // Reports are kept apart from the events (stored as they arrive), so they answer for the range as asked.
      ctx.reports = REPORT_QUERIES.has(name) && store.reports ? reportsOf(await store.reports(projectId, service, { from, to }), ctx) : [];
      if (SOURCEMAP_QUERIES.has(name)) await sourcemaps.prepare(ctx, projectId, service);
      // Day groups carry their new players (daily.js); other contexts ask the store who was first seen in the range.
      if (RETENTION_QUERIES.has(name) && !ctx.daily && store.cohorts) ctx.cohorts = await store.cohorts(projectId, service, ctx.from, ctx.to);
      if (VERSION_QUERIES.has(name) && store.versionsFirstSeen) ctx.versionsFirstSeen = await (versionsSeen ??= store.versionsFirstSeen(projectId, service));
      // Findings read the rates, per-hour sums and distributions on the game's saved boards (board-findings.js).
      if (FINDING_QUERIES.has(name)) ctx.dashboard = await (dashboardSaved ??= store.getDashboard(projectId, service));
      // The game's servers (A9), filed under its companion service, for its server panels, findings and matches. Their
      // sessions aren't players': the same env and session type, never the players' property filters.
      if (SERVER_QUERIES.has(name) && hasServers) ctx.server = await contextFor({ ...q, service: companion, props: null, sessions: null });
      return ctx;
    };
    const companion = companionOf(service);
    const hasServers = !isCompanion(service) && services.some((s) => s.service === companion);
    const ctx = await contextFor(q);
    ctx.hasServers = hasServers;
    if (stores && STORE_QUERIES.has(name)) ctx.stores = await storesOf(projectId, service, ctx, name === 'store_reviews' ? ctx.from : null, services);
    // A store's own notes (ctx.meta): resolution 'day' and what is approximate, for long ranges.
    const where = q.where || q.props ? { ...q.where, ...Object.fromEntries(Object.entries(q.props || {}).map(([k, v]) => [`prop.${k}`, v])) } : null;
    const meta = { service, from: ctx.from, to: ctx.to, env: q.env, version: q.version, ...(where ? { where } : {}), bucket_ms: ctx.bucketMs, ...(ctx.drill?.failed?.length ? { partial: ctx.drill.failed } : {}), ...(ctx.meta || {}) };
    // A game in anonymous mode sends no player IDs, so every players count in the answer is a count of sessions.
    if (playersAreSessions(ctx)) Object.assign(meta, { players_are_sessions: true, note: [meta.note, PLAYERS_ARE_SESSIONS].filter(Boolean).join('; ') });
    // Findings are about players: unless the query names an env, a session type or sessions, they read the range's
    // production sessions of players (not dev builds, bots or testers) when it has any, and meta says which they read.
    const findingsContext = async () => {
      if (params.get('env') || params.get('type') || q.sessions) return ctx;
      const env = services.find((s) => s.service === service)?.envs?.includes('prod') ? 'prod' : null;
      const players = await contextFor({ ...q, env, type: 'user' });
      players.stores = ctx.stores;
      const n = sessionCount(players);
      if (!n || n === sessionCount(ctx)) return ctx;
      meta.findings_from = { env, type: 'user', sessions: n, of: sessionCount(ctx) };
      meta.note = [meta.note, `findings read the ${n} ${env ? `${env} ` : ''}sessions of players (no ${env ? 'dev builds, ' : ''}bots or testers) of the ${sessionCount(ctx)} in the range`].filter(Boolean).join('; ');
      return players;
    };
    switch (name) {
      case 'overview':
        return { meta, ...overview(ctx), findings: findings(await findingsContext(), await store.getMaps(projectId, service)).slice(0, 6) };
      case 'performance':
        // by_prop=<key>: frame time, hitches and crash-free sessions per value of a session property (A6).
        return { meta, ...performance(ctx, { byProp: propertyKey(`$${params.get('by_prop')}`) }) };
      case 'errors':
        return { meta, issues: errorIssues(ctx) };
      case 'players':
        // by_prop=<key>: retention per value of a session property too (A6).
        // by=<attribute of the starts, $property or $platform> (and level=, count=runs): the level funnel per value (A7).
        return { meta, ...players(ctx, { byProp: propertyKey(`$${params.get('by_prop')}`) }), ...(params.get('by') || params.get('count') ? { funnel_by: levelRows(ctx, { by: params.get('by') || null, level: params.get('level') || null, count: params.get('count') === 'runs' ? 'runs' : null }) } : {}) };
      case 'events': {
        const steps = parseFunnel(params.get('funnel'));
        // Each event with the sums of its numeric attributes, per currency (sums.js), and their p50, p90 and p99
        // (distributions.js); `hours`, the hours played in the range, turns any count into a rate per hour.
        const own = customEvents(ctx, { name: params.get('name') || null, sdk: params.get('sdk') === '1' });
        const sums = eventSums(ctx);
        const spread = eventPercentiles(ctx);
        const events = own.events.map((e) => ({ ...e, attrs: e.attrs.map((a) => ({ ...a, ...(spread.get(e.name)?.[a.key] ?? {}) })), sums: sums.get(e.name) || [] }));
        // properties: what held for the sessions (A6), each with its values; identifier_like marks one that is really an ID.
        return { meta, ...own, events, hours: round(hoursPlayed(ctx), 2), properties: ctx.daily ? [] : propertyList(ctx, { players: !playersAreSessions(ctx) }), ...(steps.length ? { funnel: eventFunnel(ctx, steps) } : {}), ...eventQuery(ctx, params) };
      }
      case 'dashboard': {
        // The game's pages, in order: what the dashboard's sidebar shows. Boards are evaluated one at a time (board).
        const { saved, spec } = await dashboardOf(projectId, service, ctx);
        return dashboardBody(meta, spec, saved);
      }
      case 'board': {
        // One board page with its numbers: `page` is its id (default: the first board).
        const { spec } = await dashboardOf(projectId, service, ctx, saved);
        const id = params.get('page');
        const page = boardPage(spec, id);
        if (!page) return { meta, error: id ? `no page "${id}" on this dashboard` : 'this dashboard has no boards', ...(reader.share ? {} : { pages: spec.pages.map((x) => x.id) }) };
        if (!page.panels) return { meta, error: `"${page.id}" is the built-in ${page.view} view, not a board`, view: page.view };
        const maps = page.panels.some((x) => x.type === 'findings' || x.type === 'positions') ? await store.getMaps(projectId, service) : [];
        if (page.panels.some((x) => x.metric === 'players_now')) ctx.playersNow = await playersNow(projectId, service);
        if (page.panels.some((x) => x.metric === 'servers_now')) ctx.serversNow = hasServers ? await serversNow(projectId, service) : null;
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
        const list = versions(ctx, { stats, by: q.by });
        const has = {
          frames: list.some((v) => v.frame_p95 != null),
          levels: list.some((v) => v.level_attempts > 0),
          deaths: list.some((v) => v.deaths_per_session > 0),
          fails: list.some((v) => v.level_fails > 0),
          geometry: list.some((v) => v.geometries_growth_per_level_load != null),
        };
        return { meta, ...(q.by ? { by: q.by } : {}), versions: list, has, board: versionColumns(stats, ctx) };
      }
      case 'playtest':
        // Only meaningful for an explicit set of sessions (the ones a playtest run produced).
        if (!q.sessions) return { meta, error: 'playtest needs sessions=<comma-separated session ids>' };
        return { meta, summary: playtestSummary(ctx) };
      case 'findings':
        return { meta, findings: findings(await findingsContext(), await store.getMaps(projectId, service)) };
      case 'servers':
        // The game's servers (A9): ticks, players, crashes and memory, from its companion service (servers.js).
        return { meta: { ...meta, companion }, ...serversView(ctx, hasServers ? await serversNow(projectId, service) : null) };
      case 'matches': {
        // The range's matches (A7), or one with `id`: every side of it, slot by slot (matches.js).
        const id = params.get('id');
        if (id) {
          const match = matchDetail(ctx, id);
          return match ? { meta, match } : { meta, error: `no match ${id} in this window` };
        }
        return { meta, ...matchList(ctx, { sort: params.get('sort') || 'recent', limit: Math.min(200, Number(params.get('limit')) || 100) }) };
      }
      case 'store_reviews':
        // A store's reviews of the game in the range, filtered (reviews.js storeReviews): what glitchless_store_reviews reads.
        return { meta, ...storeReviews(ctx, params) };
      case 'store_vitals':
        // A store's own vitals by version next to what Glitchless measured (reviews.js storeVitals): glitchless_store_vitals.
        return { meta, ...storeVitals(ctx, params) };
      case 'store_revenue':
        // Real revenue from a revenue source (RevenueCat, Stripe) by day and version, next to the sessions and players measured
        // and the game's own purchase events (revenue.js revenueQuery), in the dashboard's currency: glitchless_revenue.
        return { meta, ...revenueQuery(ctx, params, { currency: (await store.getDashboard(projectId, service))?.currency ?? null }) };
      default:
        return undefined;
    }
  }

  // The game's store data for the context's range, each store's with the versions the game ever sent (to find them in
  // patch notes). A failing read leaves the stores out of the answer rather than failing it.
  async function storesOf(projectId, service, ctx, recordsFrom, services) {
    try {
      const all = await stores.read(projectId, service, { from: ctx.from, to: ctx.to, recordsFrom });
      if (!all || !Object.keys(all).length) return null;
      const versions = services.find((s) => s.service === service)?.versions ?? [];
      return Object.fromEntries(Object.entries(all).map(([name, data]) => [name, { ...data, store: name, versions }]));
    } catch (err) {
      logger.warn('[stores]', err.message);
      return null;
    }
  }

  function dashboardBody(meta, spec, saved) {
    const pages = spec.pages.map(({ panels, view, options, ...p }) => ({ ...p, icon: p.icon || (view ? VIEWS[view].icon : 'board'), ...(view ? { view, ...(options ? { options } : {}) } : { panels: panels.length }) }));
    return { meta, dashboard: { source: saved ? 'saved' : 'auto', updated_at: saved?.updated_at ?? null, updated_by: saved?.updated_by ?? null, spec: { ...(spec.currency ? { currency: spec.currency } : {}), pages: spec.pages }, pages } };
  }

  // The board page `id` of a dashboard, or its first board; null if it has none (or no such page).
  function boardPage(spec, id) {
    return (id ? spec.pages.find((x) => x.id === id) : spec.pages.find((x) => x.panels)) || null;
  }

  // The game's dashboard: the saved one (read here unless given), or the automatic one made from what it sends.
  async function dashboardOf(projectId, service, ctx, saved = undefined) {
    if (saved === undefined) saved = await store.getDashboard(projectId, service);
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

  // `shares: false` keeps share links' answers, which may be SHARE_MAX_AGE_S old (new events don't clear them).
  // GET /v1/brand (the brand as JSON) or one of its images: served with its own type, never sniffed or run, and kept for
  // good at the address that names its hash.
  async function brandAnswer(projectId, service, kind, v) {
    const brand = await store.getBrand(projectId, service);
    const answer = (status, body) => ({ status, body: JSON.stringify(body), type: 'application/json', headers: { 'Cache-Control': 'no-store' } });
    if (!kind) return answer(200, { service, brand: brandBody(service, brand) });
    const bytes = brand?.[kind] ? await store.getBrandImage(projectId, service, kind) : null;
    if (!bytes) return answer(404, { error: `this game has no ${kind}` });
    return {
      status: 200,
      body: Buffer.from(bytes),
      type: brand[kind].type,
      headers: { 'Cache-Control': v === brand[kind].hash ? 'private, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline' },
    };
  }

  function clearCache(projectId, { shares = true } = {}) {
    for (const key of cache.keys()) if (key.startsWith(`${projectId}\n`) && (shares || !key.startsWith(`${projectId}\nshare `))) cache.delete(key);
  }

  // 429 with Retry-After once a reader has used its rate (per keyId, per process); false while it hasn't.
  function limited(res, reader) {
    const wait = readLimiter.take(`${reader.projectId}\n${reader.keyId ?? ''}`, reader.rps ?? (reader.share ? DEFAULT_SHARE_RPS : 0));
    if (!wait) return false;
    res.setHeader('Retry-After', String(wait));
    json(res, 429, { error: 'rate limit exceeded' });
    return true;
  }

  return handle;
}

// A share reader (`share: { service, page, from?, to? }` from the auth hook, a read-only link anyone may hold)
// may GET the `board` query for its page and `services` (its service only), over at most SHARE_MAX_DAYS. A
// pinned link (`from` and `to`) answers its own window whatever the request asks; any other link answers the
// request's range, cut to SHARE_MAX_DAYS: `from` and `to`, or the last `days` (default 1) up to the last
// whole minute, so a game polling the same URL gets the same answer from a cache for a minute. Everything
// else is refused. The request's parameters become exactly those, so no other filter or id reaches a query.
// (The store still cuts a range to the reader's retention.)
const SHARE_QUERIES = new Set(['/v1/query/board', '/v1/query/services', '/v1/brand', '/v1/brand/logo', '/v1/brand/banner']);
const pinned = (share) => Number.isFinite(share.from) && Number.isFinite(share.to);
function shareOnly(req, url, share) {
  const q = url.searchParams;
  const other = (k) => q.get(k) != null && q.get(k) !== share[k];
  if (req.method !== 'GET' || !SHARE_QUERIES.has(url.pathname) || other('service') || other('page')) return 'a share link shows one board and nothing else';
  // Its game's branding: the brand, or one image at its hashed address.
  if (url.pathname.startsWith('/v1/brand')) {
    url.search = new URLSearchParams({ service: share.service, ...(q.get('v') ? { v: q.get('v') } : {}) }).toString();
    return null;
  }
  const to = pinned(share) ? share.to : (num(q.get('to')) ?? Math.floor(Date.now() / MINUTE) * MINUTE);
  const days = Math.min(num(q.get('days')) > 0 ? num(q.get('days')) : 1, SHARE_MAX_DAYS);
  const from = Math.max(pinned(share) ? share.from : (num(q.get('from')) ?? to - days * DAY), to - SHARE_MAX_DAYS * DAY);
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

// API answers are never cached unless they say so (a share link's, SHARE_CACHE).
function json(res, status, body, headers = undefined) {
  send(res, status, JSON.stringify(body), 'application/json', headers);
}

function send(res, status, body, type = 'text/plain', headers = { 'Cache-Control': 'no-store' }) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type, ...headers });
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
