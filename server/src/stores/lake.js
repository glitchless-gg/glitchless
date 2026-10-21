// The hosted event store: raw events to S3 through Amazon Data Firehose, summaries in DynamoDB.
//
// Ingest sends each intake batch to Firehose as one record (lake/record.js); nothing is written per event.
// A compactor (lake/compactor.js, every 1 to 5 minutes) turns the raw gzip JSON into per-minute summaries
// in DynamoDB, one file per finished session and hourly Parquet files (lake/layout.js has every key).
//
// Queries don't read raw events:
//   overview, performance, versions, findings, players, sessions, errors
//                     merge the summaries of the range (lake/summaries.js), exactly what the raw events
//                     would give (server/test/lake.test.js compares the two)
//   session, playtest read the session files
//   drill-downs       recent hitches, error breadcrumbs and heatmap positions read one project's Parquet
//                     and not yet compacted gzip files with DuckDB (lake/duck.js)
//   type=user|…       session-type filters read the raw events of the range with DuckDB
//
// Ranges are answered in whole minutes, up to the compactor's watermark (meta.from and meta.to say which
// range was answered): summaries are per minute, and the last few minutes are still on their way through
// Firehose. Same methods as FileStore (stores/file.js), plus context(), which app.js uses when present.

import zlib from 'node:zlib';
import { isProjectId } from '../auth.js';
import { semverCompare } from './file.js';
import { addCell, cellList, MINUTE } from '../rollups.js';
import { addFactsCell } from '../facts.js';
import { finalizeSession } from '../session-state.js';
import { buildContext, sessionContext, wantedCell, errorList, crumbsOf, crumbKey, heatmapLevel } from '../analytics.js';
import { toRecords } from '../lake/record.js';
import { mergeItems, decode, expandItems } from '../lake/summaries.js';
import { LakeTable, currentItems } from '../lake/table.js';
import { HOUR, DAY, META_PK, hourOf, planOf, retentionDays, PLAN_RETENTION_DAYS, indexPk, servicesPk, mapsPk, clearPk, summaryPk, seg } from '../lake/layout.js';

const MAX_RANGE_DAYS = 31;
// Drill-downs a query needs, by query name; issues: how many top error issues need breadcrumbs.
const DRILL = { performance: { hitches: true }, overview: { issues: 6 }, findings: { issues: 6 }, errors: { issues: Infinity }, heatmap: { pos: true } };

export class LakeStore {
  // table: a LakeTable (or { table, region, doc }), bucket: S3Bucket or FsBucket, firehose: FirehoseSink or
  // LocalFirehose. `compact` (optional) runs after every put: local development without a schedule.
  constructor({ table, bucket, firehose, now = Date.now, compact = null, watermarkTtlMs = 15_000 }) {
    this.table = table instanceof LakeTable ? table : new LakeTable(table);
    this.bucket = bucket;
    this.firehose = firehose;
    this.now = now;
    this.compact = compact;
    this.watermarkTtlMs = watermarkTtlMs;
    this.registered = new Set();
    this.mark = null;
    this.files = new Map(); // session file → events (finished sessions rarely change)
  }

  get kind() {
    return 'lake';
  }

  // `identity` is what the ingest hook resolved; its `plan` sets retention.
  async put(projectId, events, identity = {}) {
    checkProject(projectId);
    const plan = planOf(identity.plan);
    const maps = events.filter((e) => e.type === 'map');
    const rest = events.filter((e) => e.type !== 'map');
    const ttl = Math.floor((this.now() + retentionDays(plan) * DAY) / 1000);
    for (const e of maps) await this.table.put({ pk: mapsPk(projectId, e.service), sk: `${e.level}#${e.version}`, e: JSON.stringify({ ...e, project_id: projectId }), ttl });
    if (rest.length) await this.firehose.send(toRecords(projectId, plan, rest, this.now()));
    await this.register(projectId, events);
    if (this.compact) {
      await this.compact();
      this.mark = null;
    }
  }

  // A new game, version or env shows up in services() right away; the compactor keeps last_seen.
  async register(projectId, events) {
    for (const e of events) {
      const key = `${projectId}\n${e.service}\n${e.version}\n${e.env}`;
      if (this.registered.has(key)) continue;
      if (this.registered.size > 10_000) this.registered.clear();
      this.registered.add(key);
      await this.table.update(servicesPk(projectId), e.service, 'ADD versions :v, envs :e SET last_seen = if_not_exists(last_seen, :t)', {
        ':v': new Set([e.version]),
        ':e': new Set([e.env]),
        ':t': e.ts,
      });
    }
  }

  async services(projectId) {
    checkProject(projectId);
    return (await this.table.query(servicesPk(projectId))).map((i) => ({
      service: i.sk,
      versions: [...(i.versions || [])].sort(semverCompare),
      envs: [...(i.envs || [])],
      last_seen: i.last_seen || 0,
    }));
  }

  async getMaps(projectId, service) {
    checkProject(projectId);
    return (await this.table.query(mapsPk(projectId, service))).map((i) => JSON.parse(i.e));
  }

  // The range a query is answered for: whole minutes, up to the compactor's watermark.
  async window(from, to) {
    const lo = Math.max(Math.ceil(from / MINUTE) * MINUTE, Math.floor((to - MAX_RANGE_DAYS * DAY) / MINUTE) * MINUTE);
    const hi = Math.min(Math.floor((to + 1) / MINUTE) * MINUTE, await this.watermark());
    return { lo, hi: Math.max(lo, hi) };
  }

  async watermark() {
    const now = this.now();
    if (!this.mark || now - this.mark.at > this.watermarkTtlMs) this.mark = { at: now, w: (await this.table.get(META_PK, 'watermark'))?.w ?? 0 };
    return this.mark.w;
  }

  // Merged summaries of [lo, hi): { cells, facts, sessions } (sessions not yet finalized).
  async summaries(projectId, service, lo, hi) {
    checkProject(projectId);
    if (lo >= hi) return { cells: new Map(), facts: new Map(), sessions: new Map() };
    const first = hourOf(lo);
    const last = hourOf(hi - 1);
    const full = (h) => h >= lo && h + HOUR <= hi;
    const fullHours = [];
    for (let h = first; h <= last; h += HOUR) if (full(h)) fullHours.push(h);
    const edges = [first, last].filter((h, i, a) => !full(h) && a.indexOf(h) === i);
    const fetches = [this.table.summaryItems(projectId, service, 'C', first, last), this.table.summaryItems(projectId, service, 'A', first, last)];
    if (fullHours.length) fetches.push(this.table.summaryItems(projectId, service, 'H', fullHours[0], fullHours.at(-1)));
    for (const h of edges) fetches.push(this.table.summaryItems(projectId, service, 'F', h, h));
    // Whole hours need their minute cells and hour states; edge hours their minute cells and minute states.
    const wanted = (h) => new Set(['A', 'C', full(h) ? 'H' : 'F']);
    const items = currentItems((await Promise.all(fetches)).flat(), wanted).map((it) => ({ ...it, payload: decode(it.b) }));
    return mergeItems(
      expandItems(items, (f, h) => wanted(h).has(f)),
      lo,
      hi,
      { addCell, addFactsCell },
    );
  }

  // { lo, hi, minutes } as FileStore and DynamoStore give it: rollup cells of every minute in [lo, hi).
  async rollups(projectId, { service, from, to }) {
    const { lo, hi } = await this.window(from, to);
    return { lo, hi, minutes: (await this.summaries(projectId, service, lo, hi)).cells };
  }

  // Raw events of the range (for session-type filters), read with DuckDB.
  async query(projectId, { service, from, to }) {
    checkProject(projectId);
    const { lo, hi } = await this.window(from, to);
    if (lo >= hi) return [];
    return this.drill(projectId, service, lo, hi);
  }

  // The context the analytics take (see analytics.js sessionContext), for query `name`.
  async context(projectId, q, name, params = new URLSearchParams()) {
    checkProject(projectId);
    const { lo, hi } = await this.window(q.from, q.to);
    const qq = { ...q, from: lo, to: Math.max(lo, hi - 1) };
    if (name === 'session') return buildContext(await this.sessionEvents(projectId, q.service, [params.get('id')], lo, hi), qq);
    if (q.sessions) return buildContext(await this.sessionEvents(projectId, q.service, [...q.sessions], lo, hi), qq);
    if (q.type && q.type !== 'all') return buildContext(lo < hi ? await this.drill(projectId, q.service, lo, hi) : [], qq);

    const { cells, facts, sessions } = await this.summaries(projectId, q.service, lo, hi);
    for (const s of sessions.values()) finalizeSession(s);
    // In the order sessions first appeared, as the raw events list them.
    const ordered = new Map([...sessions].sort((a, b) => a[1].first_ts - b[1].first_ts || cmpOrder(a[1].idOrder, b[1].idOrder) || (a[0] < b[0] ? -1 : 1)));
    const ctx = sessionContext(qq, ordered);
    ctx.cells = cellList(cells, wantedCell(q));
    ctx.facts = cellList(facts, wantedCell(q));
    ctx.drill = { hitches: [], crumbs: new Map(), pos: new Map(), failed: [] };
    const need = DRILL[name] || {};
    const keep = (e) => ctx.sessions.has(e.session_id);
    // Drill-downs add detail to an answer the summaries already give: if one fails (DuckDB missing from a
    // deploy, a file gone), the answer goes out without it and says so (meta.partial).
    const attempt = async (what, fn) => {
      try {
        await fn();
      } catch (err) {
        ctx.drill.failed.push(what);
        console.warn(`[lake] ${what} drill-down failed:`, err.message);
      }
    };
    if (need.hitches) {
      await attempt('hitches', async () => {
        ctx.drill.hitches = await this.drill(projectId, q.service, lo, hi, { types: ['hitch'], newest: 100, keep });
      });
    }
    if (need.issues) {
      await attempt('breadcrumbs', async () => {
        const samples = errorList(ctx).slice(0, need.issues);
        const bySession = new Map();
        for (const i of samples) (bySession.get(i.sample_session) || bySession.set(i.sample_session, []).get(i.sample_session)).push(i.sample_ts);
        const events = await this.sessionEvents(projectId, q.service, [...bySession.keys()], lo, hi);
        for (const [sid, list] of bySession) for (const ts of list) ctx.drill.crumbs.set(crumbKey(sid, ts), crumbsOf(events, sid, ts));
      });
    }
    if (need.pos) {
      await attempt('positions', async () => {
        const level = heatmapLevel(ctx, await this.getMaps(projectId, q.service), params.get('level'));
        if (level) ctx.drill.pos.set(level, await this.drill(projectId, q.service, lo, hi, { types: ['pos'], level, keep: (e) => keep(e) && e.level === level }));
      });
    }
    return ctx;
  }

  // ── raw rows ──

  // Events of [lo, hi) from the hours' Parquet files and not yet compacted raw files, in arrival order;
  // `newest` reads hours from the latest back and stops once it has that many (newest first). `types`,
  // `level` and `session` narrow the rows in SQL; `keep` decides on each event.
  async drill(projectId, service, lo, hi, { types = null, level = null, session = null, newest = null, keep = () => true } = {}) {
    const { duck, queryRows, toEvent, lit } = await import('../lake/duck.js');
    const [cells, combined] = await Promise.all(['C', 'A'].map((f) => this.table.summaryItems(projectId, service, f, hourOf(lo), hourOf(hi - 1))));
    const items = expandItems(
      currentItems([...cells, ...combined], () => new Set(['A', 'C'])).map((it) => ({ ...it, payload: decode(it.b) })),
      (f) => f === 'C',
    );
    const byHour = new Map();
    for (const it of items) {
      const payload = it.payload;
      const f = byHour.get(it.hour) || byHour.set(it.hour, { parquet: [], raw: [], errors: [] }).get(it.hour);
      f.parquet.push(...(payload.parquet || []));
      for (const k of payload.raw || []) (k.startsWith('raw-errors/') ? f.errors : f.raw).push(k);
    }
    const hours = [...byHour.keys()].sort((a, b) => (newest ? b - a : a - b));
    const conn = await duck();
    const out = [];
    try {
      for (const h of hours) {
        const keys = byHour.get(h);
        const files = { parquet: [], raw: [], errors: [] };
        for (const kind of ['parquet', 'raw', 'errors']) for (const k of new Set(keys[kind])) files[kind].push(await this.bucket.path(k));
        const where = [
          `project = ${lit(projectId)}`,
          `service = ${lit(service)}`,
          `ts >= ${Math.max(lo, h)}`,
          `ts < ${Math.min(hi, h + HOUR)}`,
          types ? `type IN (${types.map(lit).join(', ')})` : null,
          level != null ? `level = ${lit(level)}` : null,
          session != null ? `session_id = ${lit(session)}` : null,
        ]
          .filter(Boolean)
          .join(' AND ');
        const rows = await queryRows(conn, { parquet: files.parquet.filter(Boolean), raw: files.raw.filter(Boolean), errors: files.errors.filter(Boolean) }, where, {
          order: newest ? 'ts DESC, a DESC, n DESC, w DESC, i DESC' : 'ts, a, n, w, i',
        });
        for (const r of rows) {
          const e = toEvent(r);
          if (keep(e)) out.push(e);
        }
        if (newest && out.length >= newest) break;
      }
    } finally {
      conn.closeSync?.();
    }
    return newest ? out.slice(0, newest) : out;
  }

  // Events of these sessions in [lo, hi): from their session files, or (still in progress) the raw rows.
  async sessionEvents(projectId, service, ids, lo, hi) {
    const index = new Map((await this.table.getAll(ids.filter(Boolean).map((sk) => ({ pk: indexPk(projectId, service), sk })))).map((i) => [i.sk, i]));
    const out = [];
    for (const id of ids) {
      const idx = index.get(id);
      if (!idx) continue;
      let events;
      if (idx.file) events = await this.sessionFile(idx.file, idx.n);
      else events = idx.first < hi ? await this.drill(projectId, service, Math.max(lo, Math.floor(idx.first / MINUTE) * MINUTE), hi, { session: id, keep: (e) => e.session_id === id }) : [];
      for (const e of events) if (e.ts >= lo && e.ts < hi) out.push(e);
    }
    // Several sessions: in time order (each session's own order is kept on ties).
    return ids.length > 1
      ? out
          .map((e, i) => [e, i])
          .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
          .map(([e]) => e)
      : out;
  }

  // Cached by the index's event count: late events rewrite a session's file and update the count.
  async sessionFile(key, n) {
    const id = `${key}#${n}`;
    const hit = this.files.get(id);
    if (hit) return hit;
    const buf = await this.bucket.get(key);
    const events = buf ? JSON.parse(zlib.gunzipSync(buf)).events : [];
    this.files.set(id, events);
    if (this.files.size > 200) this.files.delete(this.files.keys().next().value);
    return events;
  }

  // Deletes a service's summaries, session files, Parquet, index, maps and registry entry, and marks it
  // cleared so the compactor drops raw data that arrived before now (raw files expire on their own).
  async clear(projectId, service) {
    checkProject(projectId);
    const now = this.now();
    await this.table.put({ pk: clearPk(projectId), sk: service, at: now });
    const maxDays = Math.max(...Object.values(PLAN_RETENTION_DAYS)) + 1;
    for (let d = Math.floor(now / DAY) * DAY; d >= now - maxDays * DAY; d -= DAY) {
      const items = await this.table.query(summaryPk(projectId, service, d));
      if (items.length) await this.table.deleteAll(items.map(({ pk, sk }) => ({ pk, sk })));
    }
    for (const pk of [indexPk(projectId, service), mapsPk(projectId, service)]) await this.table.deleteAll((await this.table.query(pk)).map(({ pk: p, sk }) => ({ pk: p, sk })));
    await this.table.delete(servicesPk(projectId), service);
    for (const plan of Object.keys(PLAN_RETENTION_DAYS)) {
      for (const top of ['events', 'sessions']) {
        const keys = (await this.bucket.list(`${top}/plan=${plan}/project=${projectId}/service=${seg(service)}/`)).map((o) => o.key);
        if (keys.length) await this.bucket.delete(keys);
      }
    }
    this.files.clear();
  }
}

function checkProject(projectId) {
  if (!isProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
}

function cmpOrder(a, b) {
  if (!a || !b) return 0;
  return a[0] - b[0] || a[1] - b[1] || a[3] - b[3] || a[2] - b[2];
}
