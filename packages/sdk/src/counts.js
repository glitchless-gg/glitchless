// Counters for frequent events (SPEC §1 count, §2 counts): shots, hits, kills, gold, taps. A track() per shot would
// fill the queue in a minute and push frame windows out, so count() queues nothing: it adds to one entry per name and
// group in the current window, and the window sends them all as one `counts` event. Shared by the browser SDK and the
// Node server SDK.
//
// The group is the call's string and boolean attributes (at most 4); its numbers (at most 4) are added up as given,
// so count('gold', { source: 'loot', amount: 35 }) sums `amount`. A window keeps at most 64 entries: past that, a new
// group of a name already counted goes under the name with its attributes as "(other)", and a new name is dropped,
// its counts added to `dropped`.

export const MAX_ENTRIES = 64;
const MAX_GROUP_ATTRS = 4;
const MAX_SUMS = 4;
const MAX_N = 1_000_000;
const OTHER = '(other)';

export class Counter {
  constructor() {
    this.entries = new Map();
    this.names = new Set();
    this.dropped = 0;
    this.kept = 0; // entries that count toward the 64 (overflow entries don't)
  }

  get size() {
    return this.entries.size;
  }

  // Returns false when the call was dropped.
  add(name, attrs, n = 1, now = Date.now()) {
    n = Math.round(Number(n));
    if (!name || !(n > 0)) return false;
    n = Math.min(n, MAX_N);
    name = String(name).slice(0, 64);
    const group = {};
    const sums = {};
    let groups = 0;
    let numbers = 0;
    for (const [key, value] of Object.entries(attrs || {})) {
      const k = String(key).slice(0, 64);
      if ((typeof value === 'string' || typeof value === 'boolean') && groups < MAX_GROUP_ATTRS) {
        group[k] = typeof value === 'string' ? value.slice(0, 64) : value;
        groups++;
      } else if (typeof value === 'number' && Number.isFinite(value) && numbers < MAX_SUMS) {
        sums[k] = value;
        numbers++;
      }
    }
    let key = name + '\u0001' + JSON.stringify(Object.entries(group).sort(([a], [b]) => (a < b ? -1 : 1)));
    let entry = this.entries.get(key);
    if (!entry && this.kept >= MAX_ENTRIES) {
      if (!this.names.has(name)) {
        this.dropped += n;
        return false;
      }
      key = name + '\u0001' + OTHER;
      entry = this.entries.get(key);
      for (const k of Object.keys(group)) group[k] = OTHER;
      if (entry) for (const k of Object.keys(group)) if (Object.keys(entry.attrs).length < MAX_GROUP_ATTRS) entry.attrs[k] = OTHER;
    } else if (!entry) this.kept++;
    if (!entry) {
      entry = { name, attrs: group, n: 0, sums: {}, first_ts: now };
      this.entries.set(key, entry);
      this.names.add(name);
    }
    entry.n += n;
    for (const [k, v] of Object.entries(sums)) {
      if (k in entry.sums || Object.keys(entry.sums).length < MAX_SUMS) entry.sums[k] = (entry.sums[k] ?? 0) + v;
    }
    return true;
  }

  // The window's entries as they go on the wire, or null when nothing was counted. Empties the counter.
  drain() {
    if (!this.entries.size && !this.dropped) return null;
    const counts = [...this.entries.values()].map((e) => ({
      name: e.name,
      attrs: e.attrs,
      n: e.n,
      ...(Object.keys(e.sums).length ? { sums: roundSums(e.sums) } : {}),
      first_ts: e.first_ts,
    }));
    const dropped = this.dropped;
    this.entries = new Map();
    this.names = new Set();
    this.dropped = 0;
    this.kept = 0;
    return { counts, dropped };
  }
}

function roundSums(sums) {
  const out = {};
  for (const [k, v] of Object.entries(sums)) out[k] = Math.round(v * 1e6) / 1e6;
  return out;
}
