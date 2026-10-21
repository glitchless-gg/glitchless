// The compactor: a scheduled job (every 1 to 5 minutes) that turns the raw gzip JSON Firehose delivers
// into what queries read. Each run:
//
//   1. lists the raw objects delivered since the last run and reads them with DuckDB;
//   2. folds their events into per-hour summary blocks (summaries.js) and writes them to DynamoDB as
//      this run's items (C: minute cells and facts, F: per-minute session states, H: per-hour states);
//   3. keeps the events of sessions still in progress in a spill file, and writes one session file per
//      finished session (session_end, or nothing new for a while) for session detail and replay;
//   4. once an hour has closed, consolidates its summary items into one set and rewrites its events as
//      Parquet for the drill-downs (late events reopen the hour and are folded in the same way);
//   5. records how far summaries are complete (the watermark queries stop at).
//
// One run at a time (a lease in DynamoDB, and reserved concurrency 1 on the Lambda). A run writes down
// which objects and blocks it is about to touch before touching them, so a run that dies half way is
// undone and redone by the next one: nothing is counted twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { addCell, cellFromJSON, cellToJSON, MINUTE } from '../rollups.js';
import { addFactsCell } from '../facts.js';
import { mergeSession, sessionFromJSON, sessionToJSON } from '../session-state.js';
import { foldBlocks, blockKey, blockPayloads, expandItems, decode, STORED_FAMILIES } from './summaries.js';
import { currentItems } from './table.js';
import { duck, queryRows, writeParquet, toEvent, lit } from './duck.js';
import {
  HOUR,
  DAY,
  META_PK,
  STATE_KEY,
  OPEN_SESSIONS_KEY,
  RAW_RETENTION_DAYS,
  rawPrefix,
  rawErrorsPrefix,
  hourOf,
  dayOf,
  hourLabel,
  parquetKey,
  sessionKey,
  summaryPk,
  summarySk,
  indexPk,
  servicesPk,
  clearPk,
  planOf,
  retentionDays,
} from './layout.js';

// Run items are only needed until their hour is consolidated, which happens within hours; they expire
// by TTL (free) a day after the raw data they came from. Consolidation deletes them right away (deletes
// are billed like writes, by item size) only where reading past them would cost more: many or large.
const RUN_ITEM_TTL_MS = (RAW_RETENTION_DAYS + 1) * DAY;
const DELETE_RUN_ITEMS = { count: 6, bytes: 48_000 };

export const DEFAULTS = {
  deliveryDelayMs: 7.5 * MINUTE, // Firehose buffer interval (300 s) × 1.5, plus a minute
  closeAfterMs: 15 * MINUTE, // an hour is closed this long after it ends (and after its last write)
  idleMs: 30 * MINUTE, // a session with nothing new for this long is finished
  endedIdleMs: 2 * MINUTE, // …or this long after its session_end
  lookbackHours: 2, // arrival hours watched on a first run
  leaseMs: 10 * MINUTE,
  // Work per run, so a run catching up after an outage still finishes inside the Lambda's time limit.
  maxObjects: 3000,
  maxConsolidations: 300,
};

export class Compactor {
  constructor({ bucket, table, now = Date.now, log = () => {}, workDir = path.join(os.tmpdir(), 'glitchless-compactor'), ...options }) {
    this.bucket = bucket;
    this.table = table;
    this.now = now;
    this.log = log;
    this.workDir = workDir;
    this.opt = { ...DEFAULTS, ...options };
  }

  async run() {
    const started = this.now();
    const owner = crypto.randomBytes(6).toString('hex');
    if (!(await this.lease(owner, started))) return { skipped: 'another run holds the lease' };
    try {
      return await this.runLocked(started);
    } finally {
      await this.table.delete(META_PK, 'lease', { ConditionExpression: '#o = :o', ExpressionAttributeNames: { '#o': 'owner' }, ExpressionAttributeValues: { ':o': owner } }).catch(() => {});
    }
  }

  async lease(owner, now) {
    try {
      await this.table.put(
        { pk: META_PK, sk: 'lease', owner, until: now + this.opt.leaseMs },
        { ConditionExpression: 'attribute_not_exists(pk) OR #u < :now', ExpressionAttributeNames: { '#u': 'until' }, ExpressionAttributeValues: { ':now': now } },
      );
      return true;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async runLocked(now) {
    const state = await this.loadState(now);
    if (state.inflight) await this.undo(state.inflight);
    const t = Math.max(now, (state.lastRun ?? 0) + 1);
    const run = runId(t);
    const stats = { run, objects: 0, events: 0, blocks: 0, items: 0, sessionsWritten: 0, lateSessions: 0, consolidated: 0, parquet: 0 };
    const conn = await duck();
    try {
      // ── Phase 1: fold what arrived since the last run. ──

      // New raw objects, by arrival hour, oldest first; a backlog is worked off over several runs.
      let fresh = [];
      for (const hour of watchedHours(state, now)) {
        const seen = new Set(state.seen[hour] || []);
        for (const prefix of [rawPrefix(hour), `${rawErrorsPrefix}dt=${dayOf(hour)}/hour=${hourLabel(hour)}/`]) {
          for (const { key } of await this.bucket.list(prefix)) if (!seen.has(key)) fresh.push({ key, hour });
        }
      }
      const backlog = fresh.length > this.opt.maxObjects;
      if (backlog) fresh = fresh.slice(0, this.opt.maxObjects);
      stats.objects = fresh.length;
      stats.backlog = backlog;
      const closable = Object.entries(state.pending).filter(([, p]) => now >= p.hour + HOUR + this.opt.closeAfterMs && now >= p.last + this.opt.closeAfterMs);
      const sessionsDue = state.openSessions > 0 && now >= (state.nextFinish ?? 0);
      const watermark = Math.floor((now - this.opt.deliveryDelayMs) / MINUTE) * MINUTE;
      if (!fresh.length && !closable.length && !sessionsDue) {
        // Nothing arrived and nothing is due: only the watermark moves. Idle runs write nothing else.
        if (pruneSeen(state, now, this.opt)) await this.saveState(state);
        await this.table.put({ pk: META_PK, sk: 'watermark', w: watermark, run, at: now });
        return { ...stats, idle: true, watermark };
      }

      // Read them with DuckDB, in arrival order, and drop data of cleared services.
      const { events, srcOf, planOfProject } = await this.read(
        conn,
        fresh.map((f) => f.key),
      );
      stats.events = events.length;

      // Fold into blocks, and note which blocks this run writes before writing them.
      const blocks = foldBlocks(events);
      const rawOf = new Map();
      for (const e of events) {
        const k = blockKey(e.project_id, e.service, hourOf(e.ts));
        if (!rawOf.has(k)) rawOf.set(k, new Set());
        rawOf.get(k).add(srcOf.get(e));
      }
      state.inflight = { run, blocks: [...blocks.values()].map((b) => ({ project: b.project, service: b.service, hour: b.hour })) };
      await this.saveState(state);
      for (const [k, b] of blocks) {
        const plan = planOfProject.get(b.project);
        stats.items += await this.writeBlock(b, run, { plan, raw: [...rawOf.get(k)].sort(), now });
        state.pending[k] = { project: b.project, service: b.service, hour: b.hour, plan, last: now };
      }
      stats.blocks = blocks.size;

      // Sessions: spill, finished session files, late events for sessions already written. Events are
      // deduplicated by identity, so redoing a run that died here adds nothing twice.
      const s = await this.sessions(events, planOfProject, now);
      stats.sessionsWritten = s.written;
      stats.lateSessions = s.late;
      state.openSessions = s.open;
      state.nextFinish = s.nextFinish;
      await this.services(events);

      for (const f of fresh) (state.seen[f.hour] ||= []).push(f.key);
      if (!backlog) pruneSeen(state, now, this.opt);
      state.lastRun = t + 1;
      state.inflight = null;
      await this.saveState(state);

      // ── Phase 2: close hours. Consolidation is idempotent: a set counts only once complete, and it
      // replaces exactly the items it merged. ──
      const consolidation = runId(t + 1);
      for (const [k, p] of closable.slice(0, this.opt.maxConsolidations)) {
        if (state.pending[k]?.last !== p.last) continue; // written to again in this run
        stats.parquet += await this.consolidate(conn, p, consolidation);
        delete state.pending[k];
        stats.consolidated++;
        await this.saveState(state);
      }

      // Behind on objects: summaries are not complete up to now, so the watermark waits.
      if (!backlog) await this.table.put({ pk: META_PK, sk: 'watermark', w: watermark, run, at: now });
      stats.watermark = backlog ? null : watermark;
      this.log('[compactor]', JSON.stringify(stats));
      return stats;
    } finally {
      conn.closeSync?.();
    }
  }

  // Raw objects → events in arrival order (each with its identity in __order), the raw key each came
  // from, and each project's plan.
  async read(conn, keys) {
    const pathOf = new Map();
    await mapLimit(keys, 16, async (k) => pathOf.set(k, await this.bucket.path(k)));
    const keyOfPath = new Map([...pathOf].map(([k, p]) => [p, k]));
    const files = { raw: keys.filter((k) => !k.startsWith(rawErrorsPrefix)).map((k) => pathOf.get(k)), errors: keys.filter((k) => k.startsWith(rawErrorsPrefix)).map((k) => pathOf.get(k)) };
    const rows = await queryRows(conn, files, 'TRUE', { order: 'project, service, ts, a, n, w, i' });
    const cleared = await this.clearMarks(new Set(rows.map((r) => r.project)));
    this.cleared = cleared;
    const events = [];
    const srcOf = new Map();
    const planOfProject = new Map();
    for (const r of rows) {
      if (Number(r.a) <= (cleared.get(`${r.project}\n${r.service}`) ?? -Infinity)) continue;
      const e = toEvent(r);
      if (e.type === 'map' || typeof e.ts !== 'number') continue;
      e.__order = [Number(r.a), Number(r.n), Number(r.i), Number(r.w)];
      srcOf.set(e, keyOfPath.get(r.src));
      planOfProject.set(r.project, planOf(r.plan));
      events.push(e);
    }
    return { events, srcOf, planOfProject };
  }

  // ── summaries ──

  async writeBlock(b, run, { plan, raw = [], parquet = null, full = false, now = this.now() }) {
    const ttl = Math.floor((full ? b.hour + HOUR + retentionDays(plan) * DAY : Math.max(now, b.hour + HOUR) + RUN_ITEM_TTL_MS) / 1000);
    const payloads = blockPayloads(b, { plan, raw, ...(parquet ? { parquet } : {}) });
    const chunks = {};
    for (const p of payloads) chunks[p.family] = (chunks[p.family] || 0) + 1;
    const items = payloads.map((p) => ({ pk: summaryPk(b.project, b.service, b.hour), sk: summarySk(p.family, b.hour, run, p.chunk), b: p.b, ttl, ...(full ? { full: run, chunks } : {}) }));
    await this.table.putAll(items);
    return items.length;
  }

  // Every item of one hour, all families.
  async hourItems(p) {
    const all = [];
    for (const family of STORED_FAMILIES) all.push(...(await this.table.summaryItems(p.project, p.service, family, p.hour, p.hour)));
    return all;
  }

  // Merge every current item of one hour into one block, rewrite it as one consolidated set, write the
  // hour's events not yet in Parquet as a Parquet file, and delete the items it replaces.
  async consolidate(conn, p, run) {
    const all = await this.hourItems(p);
    const items = currentItems(all, () => STORED_FAMILIES);
    const block = { project: p.project, service: p.service, hour: p.hour, cells: new Map(), facts: new Map(), minuteSessions: new Map(), hourSessions: new Map() };
    const parquet = new Set();
    const raw = new Set();
    const ordered = expandItems(items.map((it) => ({ ...it, payload: decode(it.b) }))).sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : a.chunk - b.chunk));
    for (const it of ordered) {
      if (it.family === 'C') {
        for (const k of it.payload.parquet || []) parquet.add(k);
        for (const k of it.payload.raw || []) raw.add(k);
        for (const [m, list] of it.payload.parts) {
          for (const [c, f] of list) {
            addCell(block.cells, m, cellFromJSON(c));
            addFactsCell(block.facts, m, f);
          }
        }
      } else if (it.family === 'F') {
        for (const [m, list] of it.payload.parts) {
          if (!block.minuteSessions.has(m)) block.minuteSessions.set(m, new Map());
          const states = block.minuteSessions.get(m);
          for (const o of list) mergeInto(states, o);
        }
      } else {
        for (const o of it.payload.parts) mergeInto(block.hourSessions, o);
      }
    }
    // Sorted so the stored minutes and sessions come out in time order.
    block.cells = new Map([...block.cells].sort((a, b) => a[0] - b[0]));
    block.minuteSessions = new Map([...block.minuteSessions].sort((a, b) => a[0] - b[0]));
    let written = 0;
    if (raw.size) {
      const key = parquetKey({ plan: p.plan, project: p.project, service: p.service, hour: p.hour, run });
      const files = { raw: [], errors: [] };
      for (const k of raw) {
        const f = await this.bucket.path(k);
        if (f) files[k.startsWith(rawErrorsPrefix) ? 'errors' : 'raw'].push(f);
        else this.log('[compactor] raw object gone before compaction:', k);
      }
      fs.mkdirSync(this.workDir, { recursive: true });
      const out = path.join(this.workDir, `${run}-${crypto.randomBytes(4).toString('hex')}.parquet`);
      const where = `project = ${lit(p.project)} AND service = ${lit(p.service)} AND ts >= ${p.hour} AND ts < ${p.hour + HOUR}`;
      const rows = await writeParquet(conn, files, where, out);
      if (rows) {
        await this.bucket.put(key, fs.readFileSync(out), { contentType: 'application/vnd.apache.parquet' });
        parquet.add(key);
        written++;
      }
      fs.rmSync(out, { force: true });
    }
    await this.writeBlock(block, run, { plan: p.plan, raw: [], parquet: [...parquet].sort(), full: true });
    // Older consolidated sets go (including incomplete ones left by a run that died); run items too when
    // there are many or they are large, else their TTL removes them.
    const runItems = all.filter((it) => !it.full);
    const bytes = runItems.reduce((n, it) => n + (it.b?.length || 0), 0);
    const many = runItems.length > DELETE_RUN_ITEMS.count || bytes > DELETE_RUN_ITEMS.bytes;
    await this.table.deleteAll(all.filter((it) => (it.full ? it.full !== run : many)).map(({ pk, sk }) => ({ pk, sk })));
    return written;
  }

  // Undo a run that died during phase 1: remove the summary items it wrote, so redoing it counts
  // nothing twice.
  async undo(inflight) {
    for (const p of inflight.blocks) {
      const items = await this.hourItems(p);
      await this.table.deleteAll(items.filter((it) => it.run === inflight.run && !it.full).map(({ pk, sk }) => ({ pk, sk })));
    }
    this.log('[compactor] undid run', inflight.run);
  }

  // ── sessions ──

  async sessions(events, planOfProject, now) {
    const spill = await this.loadSpill();
    let changed = events.length > 0;
    // Open sessions of a service cleared since they arrived are dropped.
    const cleared = new Map([...(this.cleared || []), ...(await this.clearMarks(new Set([...spill.values()].map((s) => s.project))))]);
    for (const [key, s] of spill) {
      if (s.arrived > (cleared.get(`${s.project}\n${s.service}`) ?? -Infinity)) continue;
      spill.delete(key);
      changed = true;
    }
    const keyOf = (e) => `${e.project_id}\n${e.service}\n${e.session_id}`;
    // Sessions not in the spill are either new or already written (late events): ask the index.
    const ask = dedupeKeys(events.filter((e) => !spill.has(keyOf(e))).map((e) => ({ pk: indexPk(e.project_id, e.service), sk: e.session_id })));
    const indexed = new Map((await this.table.getAll(ask)).map((item) => [`${item.pk}\n${item.sk}`, item]));
    const late = new Map();
    const firstSeen = [];
    for (const e of events) {
      const key = keyOf(e);
      let s = spill.get(key);
      if (!s) {
        const idx = indexed.get(`${indexPk(e.project_id, e.service)}\n${e.session_id}`);
        if (idx?.file) {
          if (!late.has(key)) late.set(key, { idx, events: [] });
          late.get(key).events.push(e);
          continue;
        }
        spill.set(key, (s = { project: e.project_id, service: e.service, session_id: e.session_id, plan: null, first: e.ts, last: e.ts, arrived: 0, ended: false, events: [], ids: new Set() }));
        if (!idx) firstSeen.push(s);
      }
      s.plan = planOfProject.get(e.project_id);
      if (!addOnce(s, e)) continue;
      s.first = Math.min(s.first, e.ts);
      s.last = Math.max(s.last, e.ts);
      s.arrived = Math.max(s.arrived, e.__order[0]);
      if (e.type === 'session_end') s.ended = true;
    }
    for (const s of firstSeen) {
      await this.table.update(
        indexPk(s.project, s.service),
        s.session_id,
        'SET #f = if_not_exists(#f, :f), #t = :t',
        { ':f': s.first, ':t': ttlFor(s.plan, s.last) },
        { ExpressionAttributeNames: { '#f': 'first', '#t': 'ttl' } },
      );
    }
    let written = 0;
    for (const [key, s] of spill) {
      const quiet = now - s.arrived;
      if (!(quiet >= this.opt.idleMs || (s.ended && quiet >= this.opt.endedIdleMs))) continue;
      await this.writeSession(s, s.plan);
      spill.delete(key);
      written++;
      changed = true;
    }
    // Late events for a session already written: merged into its file.
    for (const { idx, events: list } of late.values()) {
      const s = await this.readSessionFile(idx.file);
      for (const e of list) addOnce(s, e);
      await this.writeSession({ ...s, project: list[0].project_id, service: list[0].service, session_id: list[0].session_id }, null, idx.file);
    }
    if (changed) await this.saveSpill(spill);
    let nextFinish = Infinity;
    for (const s of spill.values()) nextFinish = Math.min(nextFinish, s.arrived + (s.ended ? this.opt.endedIdleMs : this.opt.idleMs));
    return { written, late: late.size, open: spill.size, nextFinish: Number.isFinite(nextFinish) ? nextFinish : null };
  }

  // One session file: its events in order, with each event's identity alongside.
  async writeSession(s, plan, file = null) {
    const pairs = s.events.map((e, i) => [e, s.order[i]]).sort((a, b) => a[0].ts - b[0].ts || cmpOrder(a[1], b[1]));
    const first = Math.min(...pairs.map(([e]) => e.ts));
    const last = Math.max(...pairs.map(([e]) => e.ts));
    file ||= sessionKey({ plan, project: s.project, service: s.service, start: first, session: s.session_id });
    await this.bucket.put(file, zlib.gzipSync(JSON.stringify({ v: 1, events: pairs.map(([e]) => e), order: pairs.map(([, o]) => o) })), { contentType: 'application/json' });
    await this.table.update(
      indexPk(s.project, s.service),
      s.session_id,
      'SET #f = :f, #l = :l, #file = :file, #n = :n' + (plan ? ', #t = :t' : ''),
      { ':f': first, ':l': last, ':file': file, ':n': pairs.length, ...(plan ? { ':t': ttlFor(plan, last) } : {}) },
      { ExpressionAttributeNames: { '#f': 'first', '#l': 'last', '#file': 'file', '#n': 'n', ...(plan ? { '#t': 'ttl' } : {}) } },
    );
  }

  async readSessionFile(file) {
    const buf = await this.bucket.get(file);
    const o = buf ? JSON.parse(zlib.gunzipSync(buf)) : { events: [], order: [] };
    return { events: o.events, order: o.order, ids: new Set(o.order.map((x) => x.join('.'))) };
  }

  async loadSpill() {
    const buf = await this.bucket.get(OPEN_SESSIONS_KEY);
    const sessions = buf ? JSON.parse(zlib.gunzipSync(buf)).sessions : {};
    return new Map(Object.entries(sessions).map(([k, s]) => [k, { ...s, ids: new Set(s.order.map((x) => x.join('.'))) }]));
  }

  saveSpill(spill) {
    const sessions = Object.fromEntries([...spill].map(([k, { ids, ...s }]) => [k, s]));
    return this.bucket.put(OPEN_SESSIONS_KEY, zlib.gzipSync(JSON.stringify({ v: 1, sessions })), { contentType: 'application/json' });
  }

  // ── services and clear marks ──

  async services(events) {
    const by = new Map();
    for (const e of events) {
      const k = `${e.project_id}\n${e.service}`;
      let s = by.get(k);
      if (!s) by.set(k, (s = { project: e.project_id, service: e.service, versions: new Set(), envs: new Set(), last: 0 }));
      s.versions.add(e.version);
      s.envs.add(e.env);
      s.last = Math.max(s.last, e.ts);
    }
    for (const s of by.values()) {
      const have = await this.table.get(servicesPk(s.project), s.service);
      const newVersions = [...s.versions].filter((v) => v != null && !have?.versions?.has?.(v));
      const newEnvs = [...s.envs].filter((v) => v != null && !have?.envs?.has?.(v));
      // last_seen only orders services (the newest is the default), so it moves every ten minutes, not every run.
      const last = Math.max(have?.last_seen ?? 0, s.last);
      if (!newVersions.length && !newEnvs.length && last - (have?.last_seen ?? 0) < 10 * MINUTE) continue;
      const add = [newVersions.length && 'versions :v', newEnvs.length && 'envs :e'].filter(Boolean);
      await this.table.update(servicesPk(s.project), s.service, `${add.length ? `ADD ${add.join(', ')} ` : ''}SET last_seen = :t`, {
        ...(newVersions.length ? { ':v': new Set(newVersions) } : {}),
        ...(newEnvs.length ? { ':e': new Set(newEnvs) } : {}),
        ':t': last,
      });
    }
  }

  async clearMarks(projects) {
    const out = new Map();
    for (const p of projects) for (const item of await this.table.query(clearPk(p))) out.set(`${p}\n${item.sk}`, item.at);
    return out;
  }

  // ── state ──

  async loadState(now) {
    const buf = await this.bucket.get(STATE_KEY);
    const state = buf ? JSON.parse(buf) : {};
    state.seen ||= {};
    state.pending ||= {};
    state.watchFrom ??= hourOf(now) - this.opt.lookbackHours * HOUR;
    return state;
  }

  saveState(state) {
    return this.bucket.put(STATE_KEY, JSON.stringify(state), { contentType: 'application/json' });
  }
}

// Run ids sort as strings in time order (fixed-width base 36 of the run's ms).
export function runId(ms) {
  return ms.toString(36).padStart(9, '0');
}

// Arrival hours still listed for new objects: from the oldest one not finished to now.
function watchedHours(state, now) {
  const hours = [];
  for (let h = state.watchFrom; h <= hourOf(now); h += HOUR) hours.push(h);
  return hours;
}

// An arrival hour is finished once Firehose can no longer deliver into it. → whether anything changed.
function pruneSeen(state, now, opt) {
  let from = state.watchFrom;
  while (from + HOUR + 2 * opt.deliveryDelayMs < now && from < hourOf(now)) {
    delete state.seen[from];
    from += HOUR;
  }
  const moved = from !== state.watchFrom;
  state.watchFrom = from;
  return moved;
}

function mergeInto(states, o) {
  const s = sessionFromJSON(o);
  const have = states.get(s.session_id);
  if (have) mergeSession(have, s);
  else states.set(s.session_id, s);
}

// Add an event to an open session (or a session file being merged) unless it is already there.
function addOnce(s, e) {
  const id = e.__order.join('.');
  if (s.ids.has(id)) return false;
  s.ids.add(id);
  const { __order, ...event } = e;
  s.events.push(event);
  (s.order ||= []).push(e.__order);
  return true;
}

// Event identities are [arrival ms, record seq, position, writer]; arrival order is ms, seq, writer, position.
function cmpOrder(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[3] - b[3] || a[2] - b[2];
}

function ttlFor(plan, ts) {
  return Math.floor((ts + retentionDays(plan) * DAY) / 1000);
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

function dedupeKeys(keys) {
  const seen = new Set();
  return keys.filter((k) => {
    const id = `${k.pk}\n${k.sk}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export { sessionToJSON, cellToJSON };
