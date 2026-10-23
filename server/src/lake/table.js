// The lake's DynamoDB table (keys in layout.js): summary items per hour, the session index, services,
// maps, clear marks and the compactor's lease. `doc` is a DynamoDB document client (or the in-memory
// fake in tests).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, BatchWriteCommand, BatchGetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { HOUR, DAY, summaryPk, summarySk, dailyPk, dailySk, playersPk, cohortSk } from './layout.js';

export class LakeTable {
  constructor({ table, region = 'us-east-1', doc = null }) {
    this.table = table;
    this.doc = doc || DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  }

  put(item, condition = null) {
    return this.doc.send(new PutCommand({ TableName: this.table, Item: item, ...(condition || {}) }));
  }

  async get(pk, sk) {
    return (await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }))).Item ?? null;
  }

  update(pk, sk, expression, values, extra = {}) {
    return this.doc.send(new UpdateCommand({ TableName: this.table, Key: { pk, sk }, UpdateExpression: expression, ExpressionAttributeValues: values, ...extra }));
  }

  delete(pk, sk, condition = null) {
    return this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk }, ...(condition || {}) }));
  }

  async query(pk, between = null) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: between ? 'pk = :pk AND sk BETWEEN :a AND :b' : 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk, ...(between ? { ':a': between[0], ':b': between[1] } : {}) },
          ExclusiveStartKey,
        }),
      );
      out.push(...(res.Items || []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async batchWrite(requests) {
    for (let i = 0; i < requests.length; i += 25) {
      let pending = { [this.table]: requests.slice(i, i + 25) };
      for (let attempt = 0; pending && Object.keys(pending).length; attempt++) {
        if (attempt > 8) throw new Error('dynamodb: unprocessed items after retries');
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: pending }));
        pending = res.UnprocessedItems;
        if (pending && Object.keys(pending).length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
  }

  putAll(items) {
    return this.batchWrite(items.map((Item) => ({ PutRequest: { Item } })));
  }

  deleteAll(keys) {
    return this.batchWrite(keys.map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })));
  }

  async getAll(keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      let pending = { [this.table]: { Keys: keys.slice(i, i + 100) } };
      for (let attempt = 0; pending && Object.keys(pending).length; attempt++) {
        if (attempt > 8) throw new Error('dynamodb: unprocessed keys after retries');
        const res = await this.doc.send(new BatchGetCommand({ RequestItems: pending }));
        out.push(...(res.Responses?.[this.table] || []));
        pending = res.UnprocessedKeys;
        if (pending && Object.keys(pending).length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    return out;
  }

  // Summary items of one family for the hours [fromHour, toHour], with their hour, run and chunk.
  async summaryItems(project, service, family, fromHour, toHour) {
    if (toHour < fromHour) return [];
    const days = [];
    for (let d = Math.floor(fromHour / DAY) * DAY; d <= toHour; d += DAY) days.push(d);
    const results = await Promise.all(
      days.map((d) => {
        const lo = Math.max(fromHour, d);
        const hi = Math.min(toHour, d + DAY - HOUR);
        return this.query(summaryPk(project, service, d), [summarySk(family, lo, '', 0).replace(/#000$/, ''), summarySk(family, hi, '~', 0)]);
      }),
    );
    return results.flat().map((item) => {
      const [fam, hour, run, chunk] = item.sk.split('#');
      return { ...item, family: fam, hour: Number(hour), run, chunk: Number(chunk) };
    });
  }

  // Players first seen on each UTC day that starts in [from, to] (the compactor's first-seen index): day → Set of ids.
  async cohorts(project, service, from, to) {
    const out = new Map();
    const lo = Math.ceil(from / DAY) * DAY;
    if (lo > to) return out;
    for (const it of await this.query(playersPk(project, service), [cohortSk(lo), cohortSk(Math.floor(to / DAY) * DAY, '~')])) {
      const [, day, ...id] = it.sk.split('#');
      const d = Number(day);
      (out.get(d) || out.set(d, new Set()).get(d)).add(id.join('#'));
    }
    return out;
  }

  // Daily rollup items of one family (D or R) of the days [fromDay, toDay], with their day as `hour`, so
  // currentItems() picks each day's newest complete set. A month per query, all at once: a year's
  // partition is read in parallel rather than page after page.
  async dailyItems(project, service, fromDay, toDay, family = 'D') {
    if (toDay < fromDay) return [];
    const spans = [];
    for (let lo = fromDay; lo <= toDay; ) {
      const d = new Date(lo);
      const hi = Math.min(toDay, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - DAY);
      spans.push([lo, hi]);
      lo = hi + DAY;
    }
    const results = await Promise.all(spans.map(([lo, hi]) => this.query(dailyPk(project, service, lo), [dailySk(lo, '', 0, family).replace(/#000$/, ''), dailySk(hi, '~', 0, family)])));
    return results.flat().map((item) => {
      const [fam, day, run, chunk] = item.sk.split('#');
      return { ...item, family: fam, hour: Number(day), run, chunk: Number(chunk) };
    });
  }
}

// Which of an hour's items count: the newest complete consolidated set, plus run items written after it.
// Consolidated items carry `full` (the consolidating run) and `chunks` (how many items it has in each
// family); `fetched(hour)` says which families were read for that hour, the ones a set must be complete in.
export function currentItems(items, fetched) {
  const byHour = new Map();
  for (const it of items) {
    if (!byHour.has(it.hour)) byHour.set(it.hour, []);
    byHour.get(it.hour).push(it);
  }
  const out = [];
  for (const [hour, list] of byHour) {
    const sets = new Map();
    for (const it of list) if (it.full) (sets.get(it.full) || sets.set(it.full, []).get(it.full)).push(it);
    let base = null;
    for (const [run, set] of [...sets].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      const chunks = set[0].chunks || {};
      if ([...fetched(hour)].every((f) => set.filter((it) => it.family === f).length === (chunks[f] || 0))) {
        base = run;
        break;
      }
    }
    for (const it of list) {
      if (base == null ? !it.full : it.full === base || (!it.full && it.run > base)) out.push(it);
    }
  }
  return out;
}
