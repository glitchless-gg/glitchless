// The leaderboard in this browser's localStorage, or in memory where storage is blocked (private windows).
// It only ever holds runs played here: nothing is seeded.
const KEY = 'lagderboard.runs.v1';
const KEEP = 500;

export class LocalLeaderboard {
  constructor() {
    this.kind = 'local';
    this.memory = null;
  }

  load() {
    if (this.memory) return this.memory;
    try {
      const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(rows) ? rows.filter((r) => r && Number.isFinite(r.score)) : [];
    } catch {
      return (this.memory = []);
    }
  }

  save(rows) {
    try {
      localStorage.setItem(KEY, JSON.stringify(rows));
    } catch {
      this.memory = rows;
    }
  }

  async submit(run) {
    const rows = this.load();
    rows.push(run);
    rows.sort((a, b) => b.score - a.score);
    this.save(rows.slice(0, KEEP));
    const mine = rows.filter((r) => r.deviceClass === run.deviceClass);
    const sameDevice = mine.filter((r) => r.deviceName === run.deviceName);
    return { rank: mine.indexOf(run) + 1, total: mine.length, deviceBest: sameDevice[0]?.score ?? run.score, deviceRuns: sameDevice.length };
  }

  async devices(deviceClass, { limit = 25 } = {}) {
    const best = new Map();
    for (const r of this.load()) {
      if (r.deviceClass !== deviceClass) continue;
      const e = best.get(r.deviceName) || { deviceName: r.deviceName, best: 0, runs: 0 };
      e.best = Math.max(e.best, r.score);
      e.runs++;
      best.set(r.deviceName, e);
    }
    return [...best.values()].sort((a, b) => b.best - a.best).slice(0, limit);
  }

  async runs(deviceClass, { limit = 25 } = {}) {
    return this.load()
      .filter((r) => r.deviceClass === deviceClass)
      .slice(0, limit);
  }
}
