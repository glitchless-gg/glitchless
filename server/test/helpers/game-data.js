// Deterministic, varied play sessions for store and rollup tests: several versions, envs, levels,
// devices and frame budgets, frame windows every 5 s with sketches and renderer stats, plus hitches,
// errors, deaths, positions and custom events, with awkward fractional values in the summed fields.
import { Sketch } from '../../../packages/sdk/src/sketch.js';

export function gameSessions({ service = 'zoomies', start, spanMs = 3 * 3_600_000, sessions = 30, seed = 7, prefix = 's' }) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let n = 0; n < sessions; n++) {
    const base = {
      service,
      env: pick(['prod', 'prod', 'dev']),
      version: pick(['1.0.0', '1.0.1', '1.1.0']),
      session_id: `${prefix}_${n}`,
      player_id: `p_${Math.floor(rnd() * 12)}`,
      sdk: pick(['glitchless-browser/0.1.0', 'glitchless-godot/0.1.0']),
    };
    const budget = pick([16.67, 16.67, 8.33, 6.94]);
    let ts = start + Math.floor(rnd() * spanMs);
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base, ts: (ts += Math.floor(rnd() * 4000) + 1) });
    push({ type: 'session_start', session_type: pick(['user', 'user', 'synthetic']), device: { gpu_tier: pick(['high', 'mid', 'low']), browser: pick(['Chrome', 'Safari']), gpu: pick(['M3', 'RTX 4070', 'UHD 620']) } });
    push({ type: 'load', ttff_ms: 400 + Math.floor(rnd() * 900) });
    let geometries = 40 + Math.floor(rnd() * 20);
    // Textures and a gauge that only climbs (decals never cleaned up) follow the windows, not rnd().
    let decals = 0;
    for (const level of ['level-1', 'level-2', 'level-3'].slice(0, 1 + Math.floor(rnd() * 3))) {
      push({ type: 'level_start', level });
      const windows = 3 + Math.floor(rnd() * 30);
      for (let w = 0; w < windows; w++) {
        const sk = new Sketch();
        const frames = 120 + Math.floor(rnd() * 200);
        let hitches = 0;
        for (let f = 0; f < frames; f++) {
          const v = rnd() < 0.03 ? 40 + rnd() * 200 : budget * (0.6 + rnd() * 0.8);
          if (v > 50) hitches++;
          sk.add(v);
        }
        geometries += Math.floor(rnd() * 6);
        decals += 7;
        push({
          type: 'frame_window',
          level,
          duration_s: Math.round((4.5 + rnd()) * 100) / 100,
          frames,
          budget_ms: budget,
          ft: sk.toJSON(),
          hitches,
          frozen: rnd() < 0.01 ? 1 : 0,
          render_ms: Math.round(rnd() * 900) / (rnd() < 0.5 ? 100 : 1000),
          draw_calls: 20 + Math.floor(rnd() * 400),
          draw_calls_max: 400 + Math.floor(rnd() * 300),
          triangles: 10_000 + Math.floor(rnd() * 90_000),
          geometries,
          textures: Math.floor(geometries / 4),
          heap_mb: rnd() < 0.2 ? null : Math.round((40 + rnd() * 200) * 10) / 10,
          ctx: { particles: Math.floor(rnd() * 500), entities: Math.floor(rnd() * 40), decals },
        });
        if (hitches) push({ type: 'hitch', level, duration_ms: 60 + Math.floor(rnd() * 300), causes: [pick(['script', 'gc', 'shader_compile'])], ctx: { particles: Math.floor(rnd() * 900) }, recent: [pick(['bone_collected', 'enemy_spawn'])] });
        if (rnd() < 0.3) push({ type: 'pos', level, pts: [[ts, rnd() * 50, 0, rnd() * 50]] });
        // Attributes come from the event's position in the session, not rnd(), so the rest of the data stays the same.
        if (rnd() < 0.4) {
          const name = pick(['bone_collected', 'enemy_spawn']);
          push({ type: 'custom', level, name, attrs: { kind: events.length % 3 ? 'small' : 'big', points: (events.length % 7) * 2.5, ...(name === 'enemy_spawn' ? { boss: events.length % 5 === 0 } : {}) } });
        }
        if (rnd() < 0.05) push({ type: 'error', level, kind: pick(['js', 'manual']), message: 'TypeError: boom', fingerprint: pick(['f1', 'f2']) });
        if (rnd() < 0.06) push({ type: 'death', level, x: rnd() * 50, y: 0, z: rnd() * 50, cause: pick(['fell', 'squirrel']) });
      }
      push({ type: rnd() < 0.7 ? 'level_complete' : 'level_fail', level });
    }
    if (rnd() < 0.8) push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

// Sessions of a game with a shop: the paywall, purchases by the convention track('purchase', { amount,
// currency, item }) with a few in another currency (and some in lower case), and coins per level, a sum that
// isn't money. Two versions, players that come back.
export function shopSessions({ service = 'zoomies', start, spanMs = 3 * 3_600_000, sessions = 30, seed = 31, prefix = 'b' }) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const items = [
    ['gems_500', 4.99],
    ['gems_1200', 9.99],
    ['starter_pack', 2.49],
    ['no_ads', 3.33],
  ];
  const out = [];
  for (let n = 0; n < sessions; n++) {
    const base = { service, env: pick(['prod', 'prod', 'dev']), version: pick(['1.0.1', '1.1.0']), session_id: `${prefix}_${n}`, player_id: `bp_${Math.floor(rnd() * 24)}`, sdk: 'glitchless-godot/0.2.0', level: null };
    let ts = start + Math.floor(rnd() * spanMs);
    const events = [];
    const push = (e) => events.push({ ...base, ...e, ts: (ts += Math.floor(rnd() * 20_000) + 1) });
    // Every eighth session is a TestFlight tester's: its purchases are Apple's free sandbox ones (SPEC §3b).
    const tester = n % 8 === 7;
    push({ type: 'session_start', session_type: tester ? 'tester' : 'user', device: { gpu_tier: 'mid', browser: 'Godot', gpu: 'Apple A17', ...(tester ? { distribution: 'testflight' } : {}) } });
    // Coins carry the level they were won on (as the SDKs send it), without level events of their own.
    for (const level of ['halcyon', 'glint'].slice(0, 1 + Math.floor(rnd() * 2))) push({ type: 'custom', level, name: 'coins', attrs: { amount: Math.round(rnd() * 4000) / 100, source: pick(['run', 'chest']) } });
    if (rnd() < 0.6) push({ type: 'custom', name: 'paywall', attrs: { where: pick(['shop', 'settings']) } });
    for (let k = rnd() < 0.45 ? 1 + Math.floor(rnd() * 2) : 0; k > 0; k--) {
      const [item, amount] = pick(items);
      const currency = rnd() < 0.15 ? 'EUR' : rnd() < 0.15 ? 'usd' : 'USD';
      push({ type: 'custom', name: 'purchase', attrs: { amount, currency, item, store: pick(['ios', 'android']), ...(tester ? { sandbox: true } : {}) } });
    }
    if (rnd() < 0.8) push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

// Sessions of a competitive game for the genre panels (SPEC §3b rate, avg, of, per $hours, lists): matches on two
// arenas, each ending in a match_end with the hero played, whether it was won (a boolean, or 1 and 0 from an Unreal
// build), the outcome as a word, its length and placement, the deck as a list, and gold by source; gacha pulls with a
// top-rarity flag; level marks with clear times. Hero `ember` wins more often, and decks with `hog` too. Version 1.1
// pays three times the loot gold and its matches last 40% longer. Every `longEvery`th session plays more matches than
// a session keeps the attributes of (EV.occurrences), so answers read from occurrences are estimated.
export const HEROES = ['ember', 'frost', 'void', 'storm', 'gale', 'rook'];
export const CARDS = ['hog', 'ice_spirit', 'fireball', 'log', 'cannon', 'musketeer', 'golem', 'skeletons', 'tornado'];
export function genreSessions({ service = 'arena', start, spanMs = 3 * 3_600_000, sessions = 40, seed = 53, prefix = 'g', matches = [2, 6], longEvery = 0 }) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let n = 0; n < sessions; n++) {
    const version = n % 2 ? '1.1' : '1.0';
    const unreal = n % 7 === 3;
    const base = { service, env: 'prod', version, session_id: `${prefix}_${n}`, player_id: `${prefix}p_${n % 23}`, sdk: unreal ? 'glitchless-unreal/0.3.0' : 'glitchless-browser/0.4.0', level: null };
    let ts = start + Math.floor(rnd() * spanMs);
    const events = [];
    const push = (e) => events.push({ ...base, ...e, ts: (ts += 1 + Math.floor(rnd() * 3000)) });
    push({ type: 'session_start', session_type: 'user', device: { os: pick(['Windows', 'macOS', 'iOS']), gpu_tier: pick(['high', 'mid', 'low']), browser: unreal ? 'Unreal' : 'Chrome' } });
    const count = longEvery && n % longEvery === 0 ? 20 : matches[0] + Math.floor(rnd() * (matches[1] - matches[0] + 1));
    for (let m = 0; m < count; m++) {
      const level = pick(['arena', 'arena', 'arena_2']);
      push({ type: 'level_start', level });
      const windows = 2 + Math.floor(rnd() * 5);
      for (let w = 0; w < windows; w++) push({ type: 'frame_window', level, duration_s: 30, frames: 1800, budget_ms: 16.67, ft: { a: 0.02, b: { 140: 1800 }, n: 1800, z: 0, s: 30000, mn: 16, mx: 17 } });
      const hero = pick(HEROES);
      const deck = [...CARDS].sort(() => rnd() - 0.5).slice(0, 4);
      const won = rnd() < (hero === 'ember' ? 0.7 : 0.45) + (deck.includes('hog') ? 0.1 : 0);
      const duration = Math.round((300 + rnd() * 600) * (version === '1.1' ? 1.4 : 1));
      push({ type: 'custom', level, name: 'match_end', attrs: { hero, won: unreal ? (won ? 1 : 0) : won, result: won ? 'win' : 'loss', duration_s: duration, placement: 1 + Math.floor(rnd() * 10), deck, mode: pick(['ranked', 'casual']) } });
      push({ type: 'custom', level, name: 'gold', attrs: { amount: version === '1.1' ? 90 : 30, source: 'loot' } });
      push({ type: 'custom', level, name: 'gold', attrs: { amount: 20, source: 'quest' } });
      if (rnd() < 0.5) push({ type: 'custom', level, name: 'pull', attrs: { banner: pick(['summer', 'winter']), top: rnd() < 0.05 } });
      push(won ? { type: 'level_complete', level, duration_s: Math.round(duration / 10) } : { type: 'level_fail', level, cause: 'defeat' });
    }
    if (rnd() < 0.8) push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

// Cut sessions into SDK-sized batches and interleave them, as many clients sending at once would.
export function shuffledBatches(sessions, seed = 11) {
  const rnd = mulberry32(seed);
  const batches = [];
  for (const events of sessions) for (let i = 0; i < events.length; i += 6) batches.push(events.slice(i, i + 6));
  for (let i = batches.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [batches[i], batches[j]] = [batches[j], batches[i]];
  }
  return batches;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
