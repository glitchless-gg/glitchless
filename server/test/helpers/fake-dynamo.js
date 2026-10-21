// An in-memory stand-in for the DynamoDB document client, covering exactly the commands and expressions
// the stores send. Queries page every `pageSize` items so the pagination loops run too.
//
// It also meters what DynamoDB on-demand would bill (`meter`): write request units (1 per KB of item,
// rounded up, per item written or deleted; an update counts the larger of the old and new item) and read
// request units (eventually consistent: half a unit per 4 KB, rounded up per item read or per query page).
import { BatchWriteCommand, BatchGetCommand, QueryCommand, UpdateCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

export class FakeDynamo {
  // `kindOf(pk)` names what an item is, to meter request units per kind (meter.byKind).
  constructor({ pageSize = 7, kindOf = null } = {}) {
    this.tables = new Map(); // pk → Map<sk, item>
    this.pageSize = pageSize;
    this.sent = 0;
    this.kindOf = kindOf;
    this.meter = { wru: 0, rru: 0, writes: 0, reads: 0, byKind: {} };
  }

  put(item) {
    if (!this.tables.has(item.pk)) this.tables.set(item.pk, new Map());
    this.tables.get(item.pk).set(item.sk, clone(item));
  }

  get(pk, sk) {
    return this.tables.get(pk)?.get(sk);
  }

  // Bytes stored, as DynamoDB sizes items.
  storedBytes() {
    let n = 0;
    for (const t of this.tables.values()) for (const item of t.values()) n += itemSize(item);
    return n;
  }

  write(item, old = null) {
    const wru = Math.max(1, Math.ceil(Math.max(item ? itemSize(item) : 0, old ? itemSize(old) : 0) / 1024));
    this.meter.writes++;
    this.meter.wru += wru;
    this.count((item || old)?.pk, 'wru', wru);
  }

  read(bytes, pk = null) {
    const rru = Math.max(1, Math.ceil(bytes / 4096)) / 2;
    this.meter.reads++;
    this.meter.rru += rru;
    this.count(pk, 'rru', rru);
  }

  count(pk, unit, n) {
    if (!this.kindOf || pk == null) return;
    const k = (this.meter.byKind[this.kindOf(pk)] ||= { wru: 0, rru: 0, writes: 0 });
    k[unit] += n;
    if (unit === 'wru') k.writes++;
  }

  async send(cmd) {
    this.sent++;
    const i = cmd.input;
    if (cmd instanceof PutCommand) {
      const old = this.get(i.Item.pk, i.Item.sk);
      if (i.ConditionExpression && !check(i.ConditionExpression, old, i)) throw conditionFailed();
      this.write(i.Item, old);
      return (this.put(i.Item), {});
    }
    if (cmd instanceof DeleteCommand) {
      const old = this.get(i.Key.pk, i.Key.sk);
      if (i.ConditionExpression && !check(i.ConditionExpression, old, i)) throw conditionFailed();
      this.write(null, old);
      this.tables.get(i.Key.pk)?.delete(i.Key.sk);
      return {};
    }
    if (cmd instanceof BatchWriteCommand) {
      for (const reqs of Object.values(i.RequestItems)) {
        for (const r of reqs) {
          if (r.PutRequest) {
            this.write(r.PutRequest.Item, this.get(r.PutRequest.Item.pk, r.PutRequest.Item.sk));
            this.put(r.PutRequest.Item);
          } else {
            const { pk, sk } = r.DeleteRequest.Key;
            this.write(null, this.get(pk, sk));
            this.tables.get(pk)?.delete(sk);
          }
        }
      }
      return { UnprocessedItems: {} };
    }
    if (cmd instanceof GetCommand) {
      const item = this.get(i.Key.pk, i.Key.sk);
      this.read(item ? itemSize(item) : 0, i.Key.pk);
      return { Item: clone(item) };
    }
    if (cmd instanceof BatchGetCommand) {
      const Responses = {};
      for (const [table, { Keys }] of Object.entries(i.RequestItems)) {
        Responses[table] = [];
        for (const k of Keys) {
          const item = this.get(k.pk, k.sk);
          this.read(item ? itemSize(item) : 0, k.pk);
          if (item) Responses[table].push(clone(item));
        }
      }
      return { Responses, UnprocessedKeys: {} };
    }
    if (cmd instanceof QueryCommand) return this.query(i);
    if (cmd instanceof UpdateCommand) return this.update(i);
    throw new Error(`FakeDynamo: unsupported ${cmd.constructor.name}`);
  }

  query({ KeyConditionExpression: cond, ExpressionAttributeValues: v, ExclusiveStartKey }) {
    const m = /^pk = :pk(?: AND sk BETWEEN :a AND :b)?$/.exec(cond);
    if (!m) throw new Error(`FakeDynamo: unsupported key condition ${cond}`);
    const between = cond.includes('BETWEEN');
    const items = [...(this.tables.get(v[':pk'])?.values() || [])].filter((it) => !between || (it.sk >= v[':a'] && it.sk <= v[':b'])).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    const start = ExclusiveStartKey ? items.findIndex((it) => it.sk === ExclusiveStartKey.sk) + 1 : 0;
    const page = items.slice(start, start + this.pageSize);
    const more = start + this.pageSize < items.length;
    this.read(
      page.reduce((n, it) => n + itemSize(it), 0),
      v[':pk'],
    );
    return { Items: page.map(clone), ...(more ? { LastEvaluatedKey: { pk: v[':pk'], sk: page[page.length - 1].sk } } : {}) };
  }

  // Handles "ADD a :x, b :y SET c = :z, d = if_not_exists(d, :w)", with #names.
  update({ Key, UpdateExpression: expr, ExpressionAttributeValues: v, ExpressionAttributeNames: names = {}, ReturnValues }) {
    const old = this.get(Key.pk, Key.sk);
    const item = old ? clone(old) : { ...Key };
    const name = (n) => names[n] ?? n;
    for (const [, action, body] of expr.matchAll(/(ADD|SET)\s+(.*?)(?=\s+(?:ADD|SET)\s|$)/g)) {
      for (const part of body.split(/,(?![^(]*\))/).map((s) => s.trim())) {
        if (action === 'ADD') {
          const [n, ref] = part.split(/\s+/);
          const val = v[ref];
          if (val instanceof Set) item[name(n)] = new Set([...(item[name(n)] || []), ...val]);
          else item[name(n)] = (item[name(n)] || 0) + val;
        } else {
          const ifNot = /^([#\w]+) = if_not_exists\(([#\w]+), (:\w+)\)$/.exec(part);
          if (ifNot) item[name(ifNot[1])] ??= v[ifNot[3]];
          else {
            const [n, ref] = part.split(/\s*=\s*/);
            item[name(n)] = v[ref];
          }
        }
      }
    }
    this.write(item, old);
    this.put(item);
    return ReturnValues === 'ALL_NEW' ? { Attributes: clone(item) } : {};
  }
}

// "attribute_not_exists(a) OR #b < :c", "#o = :o" and the like.
function check(expr, item, { ExpressionAttributeNames: names = {}, ExpressionAttributeValues: v = {} }) {
  const name = (n) => names[n] ?? n;
  return expr.split(/\s+OR\s+/).some((alt) =>
    alt.split(/\s+AND\s+/).every((term) => {
      let m = /^attribute_not_exists\(([#\w]+)\)$/.exec(term);
      if (m) return !item || item[name(m[1])] === undefined;
      m = /^attribute_exists\(([#\w]+)\)$/.exec(term);
      if (m) return !!item && item[name(m[1])] !== undefined;
      m = /^([#\w]+)\s*(=|<|>|<=|>=)\s*(:\w+)$/.exec(term);
      if (!m) throw new Error(`FakeDynamo: unsupported condition ${term}`);
      if (!item) return false;
      const a = item[name(m[1])];
      const b = v[m[3]];
      return { '=': a === b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[m[2]];
    }),
  );
}

function conditionFailed() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

// DynamoDB's item size: attribute names plus values (strings and binary by length, numbers by digits,
// sets, lists and maps by their elements plus a little overhead).
export function itemSize(item) {
  let n = 0;
  for (const [k, v] of Object.entries(item)) n += Buffer.byteLength(k) + valueSize(v);
  return n;
}

function valueSize(v) {
  if (v == null || typeof v === 'boolean') return 1;
  if (typeof v === 'string') return Buffer.byteLength(v);
  if (typeof v === 'number')
    return (
      Math.ceil(
        String(Math.abs(v))
          .replace(/[.e+-]/g, '')
          .replace(/^0+/, '').length / 2,
      ) + 1
    );
  if (v instanceof Uint8Array) return v.length;
  if (v instanceof Set) return [...v].reduce((n, x) => n + valueSize(x), 0);
  if (Array.isArray(v)) return 3 + v.reduce((n, x) => n + 1 + valueSize(x), 0);
  if (typeof v === 'object') return 3 + Object.entries(v).reduce((n, [k, x]) => n + 1 + Buffer.byteLength(k) + valueSize(x), 0);
  return 8;
}

function clone(x) {
  return x === undefined ? undefined : structuredClone(x);
}
