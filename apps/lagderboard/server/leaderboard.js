// The leaderboard service: checks a submitted run, stores it, and answers where it placed. Storage is a small
// interface (memory-store.js has the reference implementation and the contract), so the same service runs on a
// file for a self-hosted board or on any key-value database with sorted keys.
//
// A store:
//   addRun(run, { expiresAt })               keep a run (expiresAt: epoch seconds, after which it may go)
//   recordDevice(cls, key, name, score)      → { best, runs }: the device's best (only ever rises) and run count
//   countScore(cls, bin)                     one more run in this score bin
//   histogram(cls)                           → [[bin, count]]
//   topDevices(cls, limit)                   → [{ deviceName, best, runs }] highest best first
//   topRuns(cls, limit)                      → [run] highest score first, unexpired
//   hit(key, windowStart, expiresAt)         → hits counted for key in this window, this one included
import { MAX_CUBES, DEVICE_CLASSES } from '../src/rules.js';

const BINS_PER_DECADE = 100; // rank histogram bins: about 2.3% wide, so an approximate rank is off by under that
const EXACT_TOP = 50; // a run in the top 50 gets its exact rank from the top list

export class BadRequest extends Error {
  status = 400;
}
export class TooMany extends Error {
  status = 429;
}

export function scoreBin(score) {
  return score < 1 ? 0 : Math.floor(Math.log10(score) * BINS_PER_DECADE) + 1;
}

// Device names come from the game (a GPU name, "iPhone 393×852", an Android model) but anyone can post anything.
// Keep letters, digits and the punctuation real names use, and squeeze the spaces.
export function cleanDeviceName(name) {
  const s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .,()+\-/×®™_']/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return s;
}

export function deviceKey(name) {
  return cleanDeviceName(name).toLowerCase();
}

export function createLeaderboardService({ store, now = () => Date.now(), rateLimit = { max: 30, windowMs: 10 * 60_000 }, runTtlDays = 30, hidden = [] } = {}) {
  const hide = new Set(hidden.map(deviceKey));
  const histograms = new Map(); // class → { at, bins: Map } cached a few seconds per process
  const HIST_TTL_MS = 15_000;

  async function histogram(cls) {
    const hit = histograms.get(cls);
    if (hit && now() - hit.at < HIST_TTL_MS) return hit.bins;
    const bins = new Map(await store.histogram(cls));
    histograms.set(cls, { at: now(), bins });
    return bins;
  }

  function check(body) {
    if (!body || typeof body !== 'object') throw new BadRequest('expected a JSON run');
    const cls = body.deviceClass;
    if (!DEVICE_CLASSES.includes(cls)) throw new BadRequest(`deviceClass must be one of ${DEVICE_CLASSES.join(', ')}`);
    const score = body.score;
    if (!Number.isInteger(score) || score < 1 || score > MAX_CUBES) throw new BadRequest(`score must be a whole number from 1 to ${MAX_CUBES}`);
    const seconds = Number(body.seconds);
    // A run ends after 3 s under the line, so nothing shorter is a run; nothing goes on for ten minutes.
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 600) throw new BadRequest('seconds must be from 3 to 600');
    const deviceName = cleanDeviceName(body.deviceName);
    if (!deviceName) throw new BadRequest('deviceName is required');
    const text = (v, n = 40) => (v == null ? null : cleanDeviceName(v).slice(0, n) || null);
    return {
      id: String(body.id ?? '').replace(/[^\w-]/g, '').slice(0, 64) || `r_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      score,
      deviceClass: cls,
      deviceName,
      gpu: text(body.gpu, 60),
      browser: text(body.browser),
      os: text(body.os),
      hz: Number.isFinite(Number(body.hz)) ? Math.round(Number(body.hz)) : null,
      seconds: Math.round(seconds * 10) / 10,
      version: text(body.version, 20),
      sessionId: body.sessionId == null ? null : String(body.sessionId).replace(/[^\w-]/g, '').slice(0, 40),
      at: new Date(now()).toISOString(),
    };
  }

  return {
    async submit(body, { ip = 'unknown' } = {}) {
      const run = check(body);
      if (rateLimit) {
        const window = Math.floor(now() / rateLimit.windowMs);
        const hits = await store.hit(`ip:${ip}`, window, Math.ceil((now() + rateLimit.windowMs) / 1000));
        if (hits > rateLimit.max) throw new TooMany('too many runs from here; try again in a few minutes');
      }
      const bin = scoreBin(run.score);
      const bins = await histogram(run.deviceClass); // read before this run counts, then add it here
      await store.addRun(run, { expiresAt: Math.ceil(now() / 1000) + runTtlDays * 86400 });
      await store.countScore(run.deviceClass, bin);
      const device = await store.recordDevice(run.deviceClass, deviceKey(run.deviceName), run.deviceName, run.score);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
      let total = 0;
      let above = 0;
      let same = 0;
      for (const [b, n] of bins) {
        total += n;
        if (b > bin) above += n;
        else if (b === bin) same += n;
      }
      // Exact near the top, where a place matters; elsewhere count the bins above and half of this one.
      const top = await store.topRuns(run.deviceClass, EXACT_TOP);
      const exact = top.length < EXACT_TOP || run.score >= top[top.length - 1].score;
      const rank = exact ? 1 + top.filter((r) => r.score > run.score).length : 1 + above + Math.floor((same - 1) / 2);
      return { id: run.id, rank, total: Math.max(total, rank), approximate: !exact, deviceBest: device.best, deviceRuns: device.runs };
    },

    async devices(cls, { limit = 25 } = {}) {
      if (!DEVICE_CLASSES.includes(cls)) throw new BadRequest('unknown class');
      const rows = await store.topDevices(cls, Math.min(100, limit) + hide.size);
      return rows.filter((r) => !hide.has(deviceKey(r.deviceName))).slice(0, limit);
    },

    async runs(cls, { limit = 25 } = {}) {
      if (!DEVICE_CLASSES.includes(cls)) throw new BadRequest('unknown class');
      const rows = await store.topRuns(cls, Math.min(100, limit) + hide.size);
      return rows
        .filter((r) => !hide.has(deviceKey(r.deviceName)))
        .slice(0, limit)
        .map(({ id, score, deviceClass, deviceName, browser, os, hz, seconds, at }) => ({ id, score, deviceClass, deviceName, browser, os, hz, seconds, at }));
    },
  };
}
