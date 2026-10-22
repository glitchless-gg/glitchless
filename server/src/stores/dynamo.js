// DynamoDB store (single table, on-demand billing). Same methods as FileStore (see file.js); every key
// starts with the project the auth hooks resolved:
//
//   pk = "P#<project>#<service>#<YYYY-MM-DDTHH>"  sk = "<ts>#<session>#<batch><seq>" → events, hour-partitioned
//   pk = "P#<project>#MAP#<service>"             sk = "<level>#<version>"             → level map thumbnails
//   pk = "P#<project>#SVC"                       sk = "<service>"                     → versions / envs / last_seen
//   pk = "P#<project>#R#<service>#<YYYY-MM-DD>"   sk = "<minute>#<writer>"             → rollup cells (rollups.js)
//   pk = "P#<project>#META"                      sk = "rollups#<service>"             → since: rollups complete from here
//
// Services are lower-cased at intake and the fixed key parts are upper case, so the two never collide.
// Items from before projects existed ("<service>#<hour>", "MAP#<service>", "SERVICE") are read as
// `legacyProject` until their TTL removes them.
//
// Hour partitions keep hot writes spread out and make time-range reads a fan-out of small Queries.
// Rollups have one writer per item: each process keeps a running rollup per (project, service, minute)
// and rewrites its own item for that minute after every batch, so no locking is needed and a query
// merges the items of all writers. Items expire via TTL after 30 days.

import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand, UpdateCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { semverCompare } from './file.js';
import { DEFAULT_PROJECT, isProjectId } from '../auth.js';
import { rollup, addCell, cellList, cellToJSON, cellFromJSON, minuteOf, MINUTE } from '../rollups.js';

const TTL_DAYS = 30;
const MAX_RANGE_HOURS = 24 * 7;
const HOUR = 3_600_000;
// Servers that predate rollups may still be writing (events up to 1 h in the future) while the first new
// one starts, so a project's rollups count as complete only from 2 h after that first write.
const ROLLUP_GRACE_MS = 2 * HOUR;
const IDLE_ROLLUP_MS = 10 * MINUTE;

export class DynamoStore {
  constructor({ table, region, legacyProject = DEFAULT_PROJECT, rollupsSince = null, doc = null }) {
    this.table = table;
    this.legacyProject = legacyProject;
    this.rollupsSinceOverride = rollupsSince;
    this.doc =
      doc ||
      DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
    this.cache = new Map();
    this.writer = crypto.randomBytes(4).toString('hex');
    this.running = new Map(); // `${project}\n${service}\n${minute}` → this process's rollup for that minute
    this.generation = 0;
    this.sweptAt = 0;
    this.since = new Map(); // `${project}\n${service}` → { since, at }
  }

  get kind() {
    return 'dynamodb';
  }

  async put(projectId, events) {
    checkProject(projectId);
    const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86_400;
    const batch = crypto.randomBytes(3).toString('hex');
    const items = [];
    const stored = [];
    const services = new Map();
    let seq = 0;
    for (const raw of events) {
      const e = { ...raw, project_id: projectId };
      const svc = services.get(e.service) || { versions: new Set(), envs: new Set(), last: 0 };
      svc.versions.add(e.version);
      svc.envs.add(e.env);
      svc.last = Math.max(svc.last, e.ts);
      services.set(e.service, svc);
      if (e.type === 'map') {
        await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: `P#${projectId}#MAP#${e.service}`, sk: `${e.level}#${e.version}`, e: JSON.stringify(e), ttl } }));
        continue;
      }
      stored.push(e);
      items.push({
        pk: `P#${projectId}#${e.service}#${hourBucket(e.ts)}`,
        sk: `${pad(e.ts)}#${e.session_id}#${batch}${seq++}`,
        e: JSON.stringify(e),
        ttl,
      });
    }
    for (let i = 0; i < items.length; i += 25) {
      let request = { [this.table]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
      for (let attempt = 0; attempt < 5 && request && Object.keys(request).length; attempt++) {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: request }));
        request = res.UnprocessedItems;
        if (request && Object.keys(request).length) await sleep(50 * 2 ** attempt);
      }
    }
    await this.writeRollups(projectId, stored, ttl);
    for (const [service, s] of services) {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `P#${projectId}#SVC`, sk: service },
          UpdateExpression: 'ADD versions :v, envs :e SET last_seen = :t',
          ExpressionAttributeValues: { ':v': s.versions, ':e': s.envs, ':t': s.last },
        }),
      );
    }
  }

  async writeRollups(projectId, events, ttl) {
    const now = Date.now();
    if (now - this.sweptAt > 30_000) {
      this.sweptAt = now;
      // A late event for a dropped minute starts a new item (a new sk), so nothing is overwritten.
      for (const [key, r] of this.running) if (now - r.at > IDLE_ROLLUP_MS) this.running.delete(key);
    }
    const touched = new Set();
    for (const e of events) {
      const m = minuteOf(e.ts);
      const key = `${projectId}\n${e.service}\n${m}`;
      let r = this.running.get(key);
      if (!r) {
        r = { pk: `P#${projectId}#R#${e.service}#${dayBucket(m)}`, sk: `${pad(m)}#${this.writer}${++this.generation}`, m, minutes: new Map(), chain: Promise.resolve() };
        this.running.set(key, r);
      }
      r.at = now;
      rollup([e], r.minutes);
      touched.add(r);
    }
    for (const service of new Set(events.map((e) => e.service))) await this.markRollups(projectId, service, now);
    // Writes to one item are chained, and each sends the rollup as it is when the write starts, so the
    // last write always holds every batch this process folded in.
    await Promise.all(
      [...touched].map((r) => {
        const write = () => {
          const cells = cellList(r.minutes).map(({ c }) => cellToJSON(c));
          return this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: r.pk, sk: r.sk, m: r.m, c: JSON.stringify(cells), ttl } }));
        };
        return (r.chain = r.chain.catch(() => {}).then(write));
      }),
    );
  }

  // Record (once per project and service) the minute from which every event also went into a rollup.
  async markRollups(projectId, service, now) {
    const key = `${projectId}\n${service}`;
    if (this.since.get(key)?.since != null) return;
    const since = this.rollupsSinceOverride ?? Math.ceil(now / HOUR) * HOUR + ROLLUP_GRACE_MS;
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `P#${projectId}#META`, sk: `rollups#${service}` },
        UpdateExpression: 'SET since = if_not_exists(since, :t)',
        ExpressionAttributeValues: { ':t': since },
        ReturnValues: 'ALL_NEW',
      }),
    );
    this.since.set(key, { since: res.Attributes?.since ?? since, at: now });
  }

  async rollupsSince(projectId, service) {
    const key = `${projectId}\n${service}`;
    const hit = this.since.get(key);
    if (hit && (hit.since != null || Date.now() - hit.at < 60_000)) return hit.since;
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `P#${projectId}#META`, sk: `rollups#${service}` } }));
    const since = res.Item?.since ?? null;
    this.since.set(key, { since, at: Date.now() });
    return since;
  }

  async query(projectId, { service, from, to }) {
    checkProject(projectId);
    const results = await mapLimit(this.hours(from, to), 16, (h) => this.queryHour(projectId, service, h, from, to));
    return results.flat().sort((a, b) => a.ts - b.ts);
  }

  async queryHour(projectId, service, hourTs, from, to) {
    const pks = [`P#${projectId}#${service}#${hourBucket(hourTs)}`];
    if (projectId === this.legacyProject) pks.push(`${service}#${hourBucket(hourTs)}`);
    const out = [];
    for (const pk of pks) out.push(...(await this.cached(pk, hourTs, async () => (await this.queryAll(pk)).map((i) => JSON.parse(i.e)))));
    return out.filter((e) => e.ts >= from && e.ts <= to);
  }

  // The same hours as query() reads (a range is capped at MAX_RANGE_HOURS), so both see the same data.
  async rollups(projectId, { service, from, to }) {
    checkProject(projectId);
    const hours = this.hours(from, to);
    const hi = Math.min(minuteOf(to + 1), hours.length ? hours[hours.length - 1] + HOUR : from);
    const since = await this.rollupsSince(projectId, service);
    const lo = since == null ? hi : Math.max(Math.ceil(from / MINUTE) * MINUTE, Math.ceil(since / MINUTE) * MINUTE);
    const minutes = new Map();
    if (lo >= hi) return { lo: hi, hi, minutes };
    const wanted = hours.filter((h) => h + HOUR > lo && h < hi);
    const results = await mapLimit(wanted, 16, (h) => {
      const pk = `P#${projectId}#R#${service}#${dayBucket(h)}`;
      return this.cached(`${pk}|${h}`, h, () => this.queryAll(pk, 'sk BETWEEN :a AND :b', { ':a': pad(h), ':b': pad(h + HOUR - 1) }));
    });
    // Cells are parsed per query: merging writes into them.
    for (const item of results.flat()) {
      if (item.m < lo || item.m >= hi) continue;
      for (const c of JSON.parse(item.c)) addCell(minutes, item.m, cellFromJSON(c));
    }
    return { lo, hi, minutes };
  }

  // Finished hours never change (bar very late events), so what was read for them is cached.
  async cached(key, hourTs, load) {
    const closed = hourTs + HOUR < Date.now() - 120_000;
    if (closed && this.cache.has(key)) return this.cache.get(key);
    const out = await load();
    if (closed) {
      this.cache.set(key, out);
      if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    }
    return out;
  }

  // The newest MAX_RANGE_HOURS hours of the range.
  hours(from, to) {
    const hours = [];
    const start = Math.max(Math.floor(from / HOUR) * HOUR, Math.floor(to / HOUR) * HOUR - (MAX_RANGE_HOURS - 1) * HOUR);
    for (let t = start; t <= to && hours.length < MAX_RANGE_HOURS; t += HOUR) hours.push(t);
    return hours;
  }

  // The longest range this store answers, in days (app.js reports it with the services).
  maxRangeDays() {
    return MAX_RANGE_HOURS / 24;
  }

  async getMaps(projectId, service) {
    checkProject(projectId);
    const pks = projectId === this.legacyProject ? [`MAP#${service}`, `P#${projectId}#MAP#${service}`] : [`P#${projectId}#MAP#${service}`];
    const bySk = new Map();
    for (const pk of pks) for (const i of await this.queryAll(pk)) bySk.set(i.sk, JSON.parse(i.e));
    return [...bySk.values()];
  }

  // The game's saved dashboard (board.js): one item per service.
  async getDashboard(projectId, service) {
    checkProject(projectId);
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `P#${projectId}#DASH`, sk: service } }));
    return res.Item ? JSON.parse(res.Item.b) : null;
  }

  async putDashboard(projectId, service, dashboard) {
    checkProject(projectId);
    const Key = { pk: `P#${projectId}#DASH`, sk: service };
    if (dashboard) await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...Key, b: JSON.stringify(dashboard) } }));
    else await this.doc.send(new DeleteCommand({ TableName: this.table, Key }));
  }

  async services(projectId) {
    checkProject(projectId);
    const pks = projectId === this.legacyProject ? ['SERVICE', `P#${projectId}#SVC`] : [`P#${projectId}#SVC`];
    const by = new Map();
    for (const pk of pks) {
      for (const i of await this.queryAll(pk)) {
        const s = by.get(i.sk) || { service: i.sk, versions: new Set(), envs: new Set(), last_seen: 0 };
        for (const v of i.versions || []) s.versions.add(v);
        for (const v of i.envs || []) s.envs.add(v);
        s.last_seen = Math.max(s.last_seen, i.last_seen || 0);
        by.set(i.sk, s);
      }
    }
    return [...by.values()].map((s) => ({ ...s, versions: [...s.versions].sort(semverCompare), envs: [...s.envs] }));
  }

  async queryAll(pk, skCondition = null, values = {}) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: skCondition ? `pk = :pk AND ${skCondition}` : 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk, ...values },
          ExclusiveStartKey,
        }),
      );
      out.push(...(res.Items || []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async clear() {
    throw new Error('clear() is not supported on DynamoDB — delete the table or wait for TTL');
  }
}

function checkProject(projectId) {
  if (!isProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
}

function hourBucket(ts) {
  return new Date(ts).toISOString().slice(0, 13);
}

function dayBucket(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function pad(ts) {
  return String(ts).padStart(13, '0');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
}
