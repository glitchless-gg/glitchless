// Players now: how many sessions of a game sent anything in the last two minutes, counted as batches arrive (by the
// server's clock, so a device's clock doesn't matter). This counts within one server process, which is all the
// open-source server runs. A host that runs many processes behind one address (Glitchless Cloud) counts in
// its own database and gives createApp an auth.playersNow(projectId, service) hook instead (app.js).

export const PLAYERS_NOW_MS = 120_000;

export class Presence {
  constructor({ now = Date.now, windowMs = PLAYERS_NOW_MS } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.games = new Map(); // `${project}\n${service}` → Map(session id → when it last sent), oldest first
  }

  record(projectId, events) {
    const t = this.now();
    const touched = new Set();
    for (const e of events) {
      if (!e.session_id || !e.service) continue;
      const key = `${projectId}\n${e.service}`;
      let g = this.games.get(key);
      if (!g) this.games.set(key, (g = new Map()));
      g.delete(e.session_id); // re-added last, so the map stays in the order sessions last sent
      g.set(e.session_id, t);
      touched.add(key);
    }
    for (const key of touched) this.prune(key, t);
  }

  count(projectId, service) {
    const key = `${projectId}\n${service}`;
    this.prune(key, this.now());
    return this.games.get(key)?.size ?? 0;
  }

  prune(key, t) {
    const g = this.games.get(key);
    if (!g) return;
    for (const [id, last] of g) {
      if (last > t - this.windowMs) break;
      g.delete(id);
    }
    if (!g.size) this.games.delete(key);
  }
}
