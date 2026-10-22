// Mergeable summaries for numbers the daily rollups (daily.js) keep per day: how many distinct players or
// sessions, and the median (or any quantile) of a per-session value. Each is exact while small and turns
// into a bounded sketch past a size cap, so a small game gets exact answers over a year and a large one
// gets answers of bounded size and known error. `approx` says which a merged result is; queries list
// approximate fields in their response's meta.
//
//   Distinct   a count of distinct ids: the ids' hashes while there are at most `k`, then a HyperLogLog
//              (2^p registers; about 1.04 / sqrt(2^p) relative error)
//   Sample     the `k` smallest id hashes (a KMV / theta sketch): a count, and also which ids two days
//              share (returning players), from the same uniform sample of ids
//   QMap       value → count, exact (to the 2 decimals answers are rounded to) while at most `cap`
//              distinct values, then values rounded to 3, then 2, significant digits
//
// In storage the caps keep each day's summary small. Merged at query time with k = Infinity, exact
// inputs stay exact however many days are merged.

const MAXH = 2 ** 53; // hashes are integers in [0, 2^53)

// A 53-bit hash of an id (cyrb53). Ids keep their type: null, "null" and 1 and "1" are different ids, as
// in a Set.
export function hashId(id) {
  const str = id === undefined ? '\u0000' : JSON.stringify(id);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ── Distinct ──

export class Distinct {
  constructor(k = 256, p = 10) {
    this.k = k;
    this.p = p;
    this.ids = new Set(); // hashes, while exact
    this.reg = null; // HyperLogLog registers (Uint8Array of 2^p), once past k
  }

  get approx() {
    return this.reg !== null;
  }

  add(id) {
    return this.addHash(hashId(id));
  }

  addHash(h) {
    if (this.reg) hllAdd(this.reg, this.p, h);
    else {
      this.ids.add(h);
      if (this.ids.size > this.k) this.toHll();
    }
    return this;
  }

  merge(o) {
    if (!o) return this;
    if (o.reg) {
      if (!this.reg) this.toHll(o.p);
      if (o.p !== this.p) throw new Error(`Distinct: cannot merge p=${o.p} into p=${this.p}`);
      for (let i = 0; i < this.reg.length; i++) if (o.reg[i] > this.reg[i]) this.reg[i] = o.reg[i];
    } else for (const h of o.ids) this.addHash(h);
    return this;
  }

  toHll(p = this.p) {
    this.p = p;
    this.reg = new Uint8Array(1 << p);
    for (const h of this.ids) hllAdd(this.reg, p, h);
    this.ids = new Set();
  }

  count() {
    return this.reg ? hllCount(this.reg, this.p) : this.ids.size;
  }

  toJSON() {
    return this.reg ? { p: this.p, r: Buffer.from(this.reg).toString('base64') } : { x: packHashes(this.ids) };
  }

  // A stored sketch, with the cap it is kept to from now on (Infinity: merged at query time).
  static from(o, k = Infinity, p = 10) {
    const d = new Distinct(k, o?.p ?? p);
    if (o?.r) d.reg = new Uint8Array(Buffer.from(o.r, 'base64'));
    else for (const h of unpackHashes(o?.x)) d.ids.add(h);
    return d;
  }
}

function hllAdd(reg, p, h) {
  const i = h % (1 << p);
  const rest = Math.floor(h / (1 << p)); // 53 - p bits
  const bits = 53 - p;
  let rank = 1;
  for (let b = bits - 1; b >= 0 && Math.floor(rest / 2 ** b) % 2 === 0; b--) rank++;
  if (rank > reg[i]) reg[i] = rank;
}

function hllCount(reg, p) {
  const m = reg.length;
  let sum = 0;
  let zeros = 0;
  for (const r of reg) {
    sum += 2 ** -r;
    if (!r) zeros++;
  }
  const alpha = m >= 128 ? 0.7213 / (1 + 1.079 / m) : m === 64 ? 0.709 : m === 32 ? 0.697 : 0.673;
  const e = (alpha * m * m) / sum;
  return Math.round(e <= 2.5 * m && zeros ? m * Math.log(m / zeros) : e);
}

// ── Sample ──

export class Sample {
  constructor(k = 512) {
    this.k = k;
    this.h = new Set();
    this.theta = MAXH; // every hash below theta is kept
  }

  get approx() {
    return this.theta < MAXH;
  }

  add(id) {
    return this.addHash(hashId(id));
  }

  addHash(h) {
    if (h >= this.theta) return this;
    this.h.add(h);
    if (this.h.size > this.k) this.trim();
    return this;
  }

  trim() {
    const sorted = [...this.h].sort((a, b) => a - b);
    this.theta = sorted[this.k];
    this.h = new Set(sorted.slice(0, this.k));
  }

  merge(o) {
    if (!o) return this;
    if (o.theta < this.theta) {
      this.theta = o.theta;
      for (const h of this.h) if (h >= this.theta) this.h.delete(h);
    }
    for (const h of o.h) if (h < this.theta) this.h.add(h);
    if (this.h.size > this.k) this.trim();
    return this;
  }

  // The fraction of all ids a hash below theta stands for.
  get rate() {
    return this.theta / MAXH;
  }

  count() {
    return this.approx ? Math.round(this.h.size / this.rate) : this.h.size;
  }

  toJSON() {
    return this.approx ? { x: packHashes(this.h), t: this.theta } : { x: packHashes(this.h) };
  }

  static from(o, k = Infinity) {
    const s = new Sample(k);
    s.theta = o?.t ?? MAXH;
    for (const h of unpackHashes(o?.x)) s.h.add(h);
    return s;
  }
}

// Of the ids in these samples (one per day), how many appear in two or more of them: { ids, repeat, approx },
// counted over the ids every sample covers (hashes below the smallest theta).
export function repeatedIds(samples) {
  const theta = Math.min(MAXH, ...samples.map((s) => s.theta));
  const seen = new Map();
  for (const s of samples) for (const h of s.h) if (h < theta) seen.set(h, (seen.get(h) || 0) + 1);
  let repeat = 0;
  for (const n of seen.values()) if (n > 1) repeat++;
  return { ids: seen.size, repeat, approx: theta < MAXH };
}

// 7 bytes per hash, sorted, base64.
function packHashes(set) {
  const list = [...set].sort((a, b) => a - b);
  const buf = Buffer.alloc(list.length * 7);
  list.forEach((h, i) => {
    buf.writeUInt8(Math.floor(h / 2 ** 48), i * 7);
    buf.writeUIntBE(h % 2 ** 48, i * 7 + 1, 6);
  });
  return buf.toString('base64');
}

function unpackHashes(s) {
  if (!s) return [];
  const buf = Buffer.from(s, 'base64');
  const out = [];
  for (let i = 0; i + 7 <= buf.length; i += 7) out.push(buf.readUInt8(i) * 2 ** 48 + buf.readUIntBE(i + 1, 6));
  return out;
}

// ── QMap ──

export class QMap {
  constructor(cap = 512) {
    this.cap = cap;
    this.c = {}; // value → count
    this.d = 0; // 0: values rounded to 2 decimals (exact for answers), else significant digits kept
    this.size = 0;
  }

  get approx() {
    return this.d > 0;
  }

  key(v) {
    return this.d ? Number(v.toPrecision(this.d)) : Math.round(v * 100) / 100;
  }

  add(v, n = 1) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return this;
    const k = this.key(v);
    if (!(k in this.c)) this.size++;
    this.c[k] = (this.c[k] || 0) + n;
    if (this.size > this.cap) this.coarsen();
    return this;
  }

  coarsen(d = this.d ? this.d - 1 : 3) {
    if (d < 2 || (this.d && d >= this.d)) return;
    const old = this.c;
    this.d = d;
    this.c = {};
    this.size = 0;
    for (const [v, n] of Object.entries(old)) this.add(Number(v), n);
  }

  merge(o) {
    if (!o) return this;
    if (o.d && (!this.d || o.d < this.d)) this.coarsen(o.d);
    for (const [v, n] of Object.entries(o.c)) this.add(Number(v), n);
    return this;
  }

  get n() {
    let n = 0;
    for (const k in this.c) n += this.c[k];
    return n;
  }

  // As quantile() in analytics.js gives it over every value: index min(n - 1, floor(q * n)) of the sorted
  // values, rounded to 2 decimals; null when there are none.
  quantile(q) {
    const values = Object.keys(this.c)
      .map(Number)
      .sort((a, b) => a - b);
    const n = this.n;
    if (!n) return null;
    const idx = Math.min(n - 1, Math.floor(q * n));
    let acc = 0;
    for (const v of values) {
      acc += this.c[v];
      if (acc > idx) return Math.round(v * 100) / 100;
    }
    return null;
  }

  toJSON() {
    return this.d ? { c: this.c, d: this.d } : { c: this.c };
  }

  static from(o, cap = Infinity) {
    const m = new QMap(cap);
    m.d = o?.d || 0;
    m.c = { ...(o?.c || {}) };
    m.size = Object.keys(m.c).length;
    return m;
  }
}
