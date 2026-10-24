// The shared leaderboard, through the API in server/http.js. Every run is also kept in this browser's local board,
// so when the service can't be reached the sheet still shows this player's runs, and says why.
import { LocalLeaderboard } from './local.js';

export class HttpLeaderboard {
  constructor(base) {
    this.kind = 'hosted';
    this.base = base.replace(/\/$/, '');
    this.local = new LocalLeaderboard();
    this.degraded = false; // the last call fell back to the local board
  }

  async submit(run) {
    const local = await this.local.submit(run);
    try {
      // text/plain is a CORS-safelisted type: no preflight round trip before the post
      const res = await fetch(`${this.base}/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(run), keepalive: true });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      this.degraded = false;
      return await res.json();
    } catch (err) {
      console.warn('[lagderboard] shared leaderboard unavailable', err);
      this.degraded = true;
      return { ...local, offline: true };
    }
  }

  async list(path, cls, limit) {
    try {
      const res = await fetch(`${this.base}/${path}?class=${encodeURIComponent(cls)}&limit=${limit}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.degraded = false;
      return (await res.json()).rows;
    } catch (err) {
      console.warn('[lagderboard] shared leaderboard unavailable', err);
      this.degraded = true;
      return this.local[path](cls, { limit });
    }
  }

  devices(cls, { limit = 25 } = {}) {
    return this.list('devices', cls, limit);
  }

  runs(cls, { limit = 25 } = {}) {
    return this.list('runs', cls, limit);
  }
}
