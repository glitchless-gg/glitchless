// FAKE markers for development: no Glitchless needed. A few hundred seeded autoplay-bot attempts per level,
// run a slice at a time so the page never stalls, binned like a positions panel and scaled up to look like
// a few thousand players. The game labels them MOCK DATA wherever they show.
import { createBody, step } from '../physics.js';
import { createBot } from '../bot.js';
import { createRng } from '../rng.js';

const BIN = 0.5;
const ATTEMPTS = 260;
const MAX_STEPS = 60 * 25;
// How many deaths each level pretends to have: fewer people get as far as the later levels.
const TOTALS = { 1: 5240, 2: 4186, 3: 3112, 4: 1957, 5: 1204 };

export function createMockMarkers({ levels, seed = 1 } = {}) {
  const byId = new Map(levels.map((lv) => [lv.id, lv]));
  const runs = new Map(); // level → { bins: Map, raw: number, attempts: number, done }
  const listeners = new Set();
  let stopped = false;
  let timer = null;
  const queue = [];

  const notify = () => listeners.forEach((fn) => fn());

  function run(id) {
    if (runs.has(id) || !byId.has(id)) return;
    const lv = byId.get(id);
    const rng = createRng(seed * 7919 + Number(id) * 104729);
    runs.set(id, { lv, rng, bins: new Map(), raw: 0, attempts: 0, bot: null, done: false });
    queue.push(id);
    pump();
  }

  // A few attempts at a time, then yield.
  function pump() {
    if (timer || stopped || !queue.length) return;
    timer = setTimeout(() => {
      timer = null;
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 5) {
        const r = runs.get(queue[0]);
        attempt(r);
        if (r.attempts >= ATTEMPTS) {
          r.done = true;
          queue.shift();
        }
      }
      notify();
      pump();
    }, 0);
  }

  function attempt(r) {
    // A new player every 10 attempts: skill and seed vary, so the deaths spread like a crowd's.
    if (!r.bot || r.attempts % 10 === 0) r.bot = createBot(r.lv, { skill: 0.25 + r.rng.next() * 0.6, seed: Math.floor(r.rng.next() * 1e9) });
    r.attempts++;
    const b = createBody(r.lv.spawn);
    r.bot.reset();
    for (let i = 0; i < MAX_STEPS && !b.dead && !b.won; i++) {
      step(b, r.bot.input(b), r.lv);
      r.bot.after(b);
    }
    if (!b.dead) return;
    const a = (Math.floor(b.dead.x / BIN) + 0.5) * BIN;
    const y = (Math.floor((b.dead.y + 0.4) / BIN) + 0.5) * BIN;
    const key = `${a},${y}`;
    r.bins.set(key, (r.bins.get(key) || 0) + 1);
    r.raw++;
  }

  function entry(id) {
    const r = runs.get(id);
    if (!r) return null;
    const target = TOTALS[id] ?? 1000;
    // Scale to the pretend total, in proportion to how much of the run is done.
    const total = Math.round((target * r.attempts) / ATTEMPTS);
    const k = r.raw ? total / r.raw : 0;
    const deaths = [...r.bins].map(([key, n]) => {
      const [a, y] = key.split(',').map(Number);
      return [a, y, Math.max(1, Math.round(n * k))];
    });
    return {
      level: id,
      deaths,
      total: deaths.reduce((s, d) => s + d[2], 0),
      bin: BIN,
      bounds: { min: [0, -1.5], max: [r.lv.w, r.lv.h] },
      truncated: false,
      fetchedAt: Date.now(),
      stale: false,
      fake: true,
      loading: !r.done,
    };
  }

  return {
    kind: 'mock',
    fake: true,
    start() {
      stopped = false;
      pump();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    async refresh() {},
    get(level) {
      const id = String(level);
      run(id);
      return entry(id);
    },
    status() {
      return { kind: 'mock', fake: true, fetchedAt: Date.now(), error: null, levels: [...runs.keys()] };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
