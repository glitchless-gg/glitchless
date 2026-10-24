// The reference leaderboard store (the interface is at the top of leaderboard.js), in memory, optionally saved to
// a JSON file so a self-hosted board survives a restart. It keeps every device's best, the score histograms, and the
// top KEEP_RUNS runs of each class: enough for the lists, small enough for one file.
import fs from 'node:fs';
import path from 'node:path';

const KEEP_RUNS = 500;

export class MemoryStore {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.kind = file ? 'file' : 'memory';
    this.file = file;
    this.now = now;
    this.runs = new Map(); // class → [run] highest first
    this.devices = new Map(); // class → Map(key → { deviceName, best, runs })
    this.bins = new Map(); // class → Map(bin → count)
    this.hits = new Map(); // `${key}|${window}` → { n, expiresAt }
    this.saveTimer = null;
    if (file && fs.existsSync(file)) this.load();
  }

  async addRun(run, { expiresAt }) {
    const list = this.runs.get(run.deviceClass) ?? [];
    list.push({ ...run, expiresAt });
    list.sort((a, b) => b.score - a.score);
    if (list.length > KEEP_RUNS) list.length = KEEP_RUNS;
    this.runs.set(run.deviceClass, list);
    this.changed();
  }

  async recordDevice(cls, key, name, score) {
    const map = this.devices.get(cls) ?? new Map();
    const d = map.get(key) ?? { deviceName: name, best: 0, runs: 0 };
    d.runs++;
    if (score > d.best) {
      d.best = score;
      d.deviceName = name; // the spelling of the best run
    }
    map.set(key, d);
    this.devices.set(cls, map);
    this.changed();
    return { best: d.best, runs: d.runs };
  }

  async countScore(cls, bin) {
    const map = this.bins.get(cls) ?? new Map();
    map.set(bin, (map.get(bin) ?? 0) + 1);
    this.bins.set(cls, map);
    this.changed();
  }

  async histogram(cls) {
    return [...(this.bins.get(cls) ?? new Map())];
  }

  async topDevices(cls, limit) {
    return [...(this.devices.get(cls)?.values() ?? [])]
      .sort((a, b) => b.best - a.best || a.deviceName.localeCompare(b.deviceName))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  async topRuns(cls, limit) {
    const nowS = this.now() / 1000;
    return (this.runs.get(cls) ?? [])
      .filter((r) => r.expiresAt > nowS)
      .slice(0, limit)
      .map(({ expiresAt, ...r }) => r);
  }

  async hit(key, window, expiresAt) {
    const k = `${key}|${window}`;
    const h = this.hits.get(k) ?? { n: 0, expiresAt };
    h.n++;
    this.hits.set(k, h);
    if (this.hits.size > 10_000) {
      const nowS = this.now() / 1000;
      for (const [hk, v] of this.hits) if (v.expiresAt < nowS) this.hits.delete(hk);
    }
    return h.n;
  }

  // ── the file ──

  changed() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const data = {
      version: 1,
      runs: Object.fromEntries(this.runs),
      devices: Object.fromEntries([...this.devices].map(([c, m]) => [c, Object.fromEntries(m)])),
      bins: Object.fromEntries([...this.bins].map(([c, m]) => [c, [...m]])),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file); // never a half-written board
  }

  load() {
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.runs = new Map(Object.entries(data.runs ?? {}));
    this.devices = new Map(Object.entries(data.devices ?? {}).map(([c, o]) => [c, new Map(Object.entries(o))]));
    this.bins = new Map(Object.entries(data.bins ?? {}).map(([c, a]) => [c, new Map(a)]));
  }
}
