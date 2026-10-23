#!/usr/bin/env node
// Seeds Glitchless with simulated player history for the Zoomies demo game, so the dashboards have
// a day of "production" to show before the live demo starts.
//
// It is a simulation, not a recording: sessions are generated from the game's real level data
// (apps/zoomies/src/levels.js) — hazards, gaps, pickups, checkpoints — with a device mix, player
// skill, and a model of the four bugs shipped in 1.0.0. Seeded sessions are tagged
// session_type "simulated" and are written straight to the store (not through /v1/intake), so
// back-dated history is never forwarded to Datadog. Live play and autoplay bots are real telemetry.
//
//   node scripts/seed.js                 # ~440 sessions over the past 30h into the local store
//   node scripts/seed.js --reset         # wipe the service first

import { LEVELS } from '../apps/zoomies/src/levels.js';
import { Sketch } from '../packages/sdk/src/sketch.js';
import { fingerprint } from '../packages/sdk/src/fingerprint.js';
import { loadEnv, createStore } from '../server/src/config.js';
import { DEFAULT_PROJECT } from '../server/src/auth.js';

loadEnv();
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const SERVICE = flag('service', 'zoomies');
const N_OLD = Number(flag('old', 110));
const N_NEW = Number(flag('new', 330));
const HOURS = Number(flag('hours', 30));
const SEED = Number(flag('seed', 42));

// ───────────────────────────── rng ─────────────────────────────
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const uni = (a, b) => a + (b - a) * rnd();
const chance = (p) => rnd() < p;
const pickW = (items) => {
  const total = items.reduce((s, x) => s + x.w, 0);
  let r = rnd() * total;
  for (const x of items) if ((r -= x.w) <= 0) return x;
  return items.at(-1);
};
const id = (prefix, n) => prefix + Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 36)]).join('');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;

// ───────────────────────────── device mix ─────────────────────────────
const DEVICES = [
  { w: 14, browser: 'Chrome', bv: '141', os: 'macOS', gpu: 'Apple M2', vendor: 'Apple', tier: 'mid', hz: 60, base: [15.9, 17.4], scale: 1.0, cores: 8, mem: 8, screen: [1512, 982], dpr: 2 },
  { w: 9, browser: 'Chrome', bv: '141', os: 'macOS', gpu: 'Apple M3 Pro', vendor: 'Apple', tier: 'high', hz: 120, base: [7.9, 8.9], scale: 0.55, cores: 12, mem: 8, screen: [1728, 1117], dpr: 2 },
  { w: 7, browser: 'Safari', bv: '26', os: 'macOS', gpu: 'Apple M1', vendor: 'Apple', tier: 'mid', hz: 60, base: [16.0, 17.6], scale: 1.05, cores: 8, mem: null, screen: [1440, 900], dpr: 2 },
  { w: 11, browser: 'Chrome', bv: '141', os: 'Windows', gpu: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', tier: 'high', hz: 144, base: [6.6, 7.5], scale: 0.42, cores: 16, mem: 8, screen: [2560, 1440], dpr: 1 },
  { w: 6, browser: 'Edge', bv: '141', os: 'Windows', gpu: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', tier: 'high', hz: 60, base: [15.9, 17.1], scale: 0.6, cores: 12, mem: 8, screen: [1920, 1080], dpr: 1 },
  { w: 13, browser: 'Chrome', bv: '140', os: 'Windows', gpu: 'Intel(R) UHD Graphics 620', vendor: 'Intel', tier: 'low', hz: 60, base: [18.5, 25], scale: 2.3, cores: 4, mem: 8, screen: [1920, 1080], dpr: 1 },
  { w: 10, browser: 'Chrome', bv: '141', os: 'Windows', gpu: 'Intel(R) Iris(R) Xe Graphics', vendor: 'Intel', tier: 'mid', hz: 60, base: [16.2, 19.5], scale: 1.5, cores: 8, mem: 8, screen: [1920, 1200], dpr: 1.25 },
  { w: 4, browser: 'Firefox', bv: '143', os: 'Linux', gpu: 'AMD Radeon RX 6600', vendor: 'AMD', tier: 'high', hz: 60, base: [16.0, 17.2], scale: 0.7, cores: 12, mem: null, screen: [2560, 1440], dpr: 1 },
  { w: 5, browser: 'Chrome', bv: '141', os: 'ChromeOS', gpu: 'Intel(R) UHD Graphics 600', vendor: 'Intel', tier: 'low', hz: 60, base: [21, 29], scale: 2.9, cores: 4, mem: 4, screen: [1366, 768], dpr: 1 },
  { w: 9, browser: 'Chrome', bv: '141', os: 'Android', gpu: 'Adreno (TM) 650', vendor: 'Qualcomm', tier: 'low', hz: 60, base: [17.5, 23], scale: 2.1, cores: 8, mem: 8, screen: [412, 915], dpr: 2.63, mobile: true },
  { w: 6, browser: 'Safari', bv: '26', os: 'iOS', gpu: 'Apple GPU', vendor: 'Apple', tier: 'low', hz: 60, base: [16.3, 18.6], scale: 1.6, cores: 6, mem: null, screen: [393, 852], dpr: 3, mobile: true },
  { w: 2, browser: 'Chrome', bv: '141', os: 'Linux', gpu: 'SwiftShader', vendor: 'Google (software)', tier: 'software', hz: 60, base: [34, 52], scale: 5, cores: 4, mem: 4, screen: [1280, 720], dpr: 1 },
];

// ───────────────────────────── level model ─────────────────────────────
// Hazards come straight from the level layout; base = death chance per pass for an average player.
const HAZARDS = {
  'level-1': [
    [17.5, 20.5, 'fell', 0.05], [34, 37.5, 'fell', 0.05], [44, 53, 'squirrel', 0.1], [54.5, 58, 'fell', 0.07], [73, 76, 'fell', 0.06], [81, 89, 'squirrel', 0.1],
  ],
  'level-2': [
    [36, 46, 'vacuum', 0.1], [52, 62, 'fell', 0.14], [70, 77, 'vacuum', 0.1], [78, 88, 'fell', 0.16], [92, 101, 'vacuum', 0.1], [102, 106, 'fell', 0.07], [128, 142, 'fell', 0.16], [164, 169, 'vacuum', 0.07],
  ],
  'level-3': [
    [14, 17.5, 'fell', 0.06], [21, 29, 'squirrel', 0.1], [30, 33.5, 'fell', 0.07], [44.5, 47.6, 'fell', 'LEAP'], [62, 66.5, 'fell', 0.06], [69, 76, 'squirrel', 0.12], [77, 87, 'fell', 0.12], [92, 101, 'vacuum', 0.1], [103, 107, 'fell', 0.05], [112, 118, 'squirrel', 0.1],
  ],
};
const GEOMETRY_PER_LEVEL = { 'level-1': 184, 'level-2': 262, 'level-3': 236 };
const DRAW_CALLS = { 'level-1': 210, 'level-2': 290, 'level-3': 250 };
const TRIS = { 'level-1': 58_000, 'level-2': 74_000, 'level-3': 66_000 };
const CONFETTI_PER_BURST = 800;

function groundY(level, x) {
  let best = null;
  for (const p of [...level.platforms, ...level.movers]) if (x >= p.x && x <= p.x + p.w && (best == null || p.y > best)) best = p.y;
  return best;
}

function yAt(level, x, t) {
  const g = groundY(level, x);
  if (g != null) return g + (Math.sin(t * 9) > 0.92 ? 0.8 : 0); // the odd hop
  // over a gap: arc between the surrounding surfaces
  let x0 = x;
  let x1 = x;
  while (x0 > level.platforms[0].x && groundY(level, x0) == null) x0 -= 0.25;
  while (x1 < x + 20 && groundY(level, x1) == null) x1 += 0.25;
  const y0 = groundY(level, x0) ?? 0;
  const y1 = groundY(level, x1) ?? y0;
  const k = (x - x0) / Math.max(0.5, x1 - x0);
  return y0 + (y1 - y0) * k + Math.sin(k * Math.PI) * 2.2;
}

// ───────────────────────────── one session ─────────────────────────────
const STACK = `TypeError: Cannot read properties of undefined (reading 'position')
    at spawnScorePopup (http://localhost:5173/src/popups.js:46:11)
    at collectBone (http://localhost:5173/src/main.js:234:10)
    at checkPickups (http://localhost:5173/src/main.js:266:9)
    at fixedStep (http://localhost:5173/src/main.js:318:3)
    at frame (http://localhost:5173/src/main.js:421:7)`;
const ERR_MSG = "TypeError: Cannot read properties of undefined (reading 'position')";
const ERR_FP = fingerprint('js', ERR_MSG, 'spawnScorePopup');

function simulateSession({ version, start, player }) {
  const v1 = version !== '0.9.0'; // 1.0.0 added tennis balls (confetti bug) + bone rivers (popup bug)
  const dev = pickW(DEVICES);
  const skill = clamp(0.25 + rnd() * 0.65 + (player.returning ? 0.1 : 0), 0.05, 0.98);
  const speed = uni(5.4, 7.2) * (0.85 + skill * 0.3);
  const sessionId = id('s_', 16);
  const events = [];
  const env = { service: SERVICE, env: 'prod', version, session_id: sessionId, player_id: player.id, sdk: 'glitchless-browser/0.1.0' };
  const push = (e) => events.push({ ...e, ...env, level: e.level ?? null, received: e.ts });
  const budget = 1000 / dev.hz;

  let t = start;
  push({
    type: 'session_start',
    ts: t,
    session_type: 'simulated',
    device: { browser: dev.browser, browser_version: dev.bv, os: dev.os, mobile: !!dev.mobile, gpu: dev.gpu, gpu_vendor: dev.vendor, gpu_tier: dev.tier, webgl: 'webgl2', cores: dev.cores, memory_gb: dev.mem, screen: dev.screen, dpr: dev.dpr },
    page: { url: 'https://zoomies.glitchless.dev/', referrer: chance(0.5) ? 'https://x.com/' : null },
  });
  const ttff = Math.round(uni(700, 1400) * Math.sqrt(dev.scale) * (dev.mobile ? 1.8 : 1));
  push({ type: 'load', ts: t + ttff + 50, ttff_ms: ttff, assets: { count: 14, failed: 0, ms: Math.round(ttff * 0.6), slowest: [{ url: 'dog.glb', ms: Math.round(ttff * 0.3) }] } });
  t += ttff + uni(1500, 6000); // title screen
  push({ type: 'load', ts: t, ttp_ms: Math.round(t - start) });

  // live state shared by the frame model
  const st = { level: null, confetti: 0, geometries: 120, programs: 14, hitchQueue: [], recent: [] };
  const remember = (name, ts) => {
    st.recent.push({ name, ts });
    if (st.recent.length > 30) st.recent.shift();
  };
  const timeline = []; // [ts, level, x, y] samples
  let ended = null;
  const seenLevels = new Set();

  for (let li = 0; li < LEVELS.length && !ended; li++) {
    const level = LEVELS[li];
    const lid = level.id;
    st.level = lid;
    st.geometries += GEOMETRY_PER_LEVEL[lid]; // GLITCHLESS-DEMO leak: previous level's geometry is never disposed
    if (!seenLevels.has(lid)) {
      st.programs += 3;
      st.hitchQueue.push({ ts: t + 120, ms: uni(45, 110) * Math.sqrt(dev.scale), causes: ['shader_compile'], level: lid });
      seenLevels.add(lid);
    }
    push({ type: 'level_start', ts: t, level: lid });
    remember('level_start', t);
    const levelStart = t;
    let x = level.spawn.x;
    let checkpoint = level.spawn.x;
    let bones = 0;
    let lostBones = 0;
    let zoomUntil = 0;
    let errorsThisRiver = 0;
    const deathsAt = {};
    const balls = v1 ? level.balls.map((b) => ({ ...b, taken: false })) : [];
    const bonesLeft = level.bones.filter((b) => v1 || !(lid === 'level-2' && ((b.x >= 12 && b.x <= 31) || (b.x >= 148 && b.x <= 163)))).map((b) => ({ ...b, taken: false }));
    const hazards = HAZARDS[lid].map(([x0, x1, cause, base]) => ({ x0, x1, cause, base, passed: false }));
    let popupTimes = [];

    while (!ended) {
      const dt = 0.25;
      const zoom = t < zoomUntil;
      const hesitate = !zoom && chance((1 - skill) * 0.04) ? uni(0.4, 1.6) : 0;
      if (hesitate) {
        for (let k = 0; k < hesitate / dt; k++) {
          timeline.push([t, lid, x, yAt(level, x, t / 1000)]);
          t += dt * 1000;
        }
      }
      x += speed * (zoom ? 1.8 : 1) * dt;
      t += dt * 1000;
      timeline.push([t, lid, x, yAt(level, x, t / 1000)]);

      // pickups
      for (const b of balls) {
        if (!b.taken && x >= b.x) {
          b.taken = true;
          zoomUntil = t + 3000;
          st.confetti += CONFETTI_PER_BURST; // GLITCHLESS-DEMO perf bomb: 800 meshes, never removed
          st.geometries += CONFETTI_PER_BURST;
          push({ type: 'custom', ts: t, level: lid, name: 'powerup', attrs: { kind: 'zoomies' } });
          remember('powerup', t);
          st.hitchQueue.push({ ts: t + 16, ms: (70 + 95 * dev.scale) * uni(0.75, 1.3), causes: ['script'], loaf: [{ source: 'fx.js', fn: 'confettiBurst', ms: 0 }], level: lid });
        }
      }
      for (const b of bonesLeft) {
        if (b.taken || x < b.x) continue;
        b.taken = true;
        push({ type: 'custom', ts: t, level: lid, name: 'bone_collected', attrs: { golden: !!b.golden } });
        remember('bone_collected', t);
        popupTimes = popupTimes.filter((pt) => t - pt < 1500);
        if (popupTimes.length >= (v1 ? 8 : 16)) { // 1.0.0 shrank the popup pool from 16 to 8
          // GLITCHLESS-DEMO silent error: popup pool exhausted → TypeError, points lost
          lostBones++;
          if (errorsThisRiver++ < 25) {
            push({ type: 'error', ts: t, level: lid, kind: 'js', message: ERR_MSG, stack: STACK, source: 'popups.js', line: 46, col: 11, fn: 'spawnScorePopup', fingerprint: ERR_FP, attrs: null });
            remember(`error:${ERR_MSG.slice(0, 40)}`, t);
          }
        } else {
          popupTimes.push(t);
          bones += b.golden ? 10 : 1;
        }
      }

      // hazards
      let died = null;
      for (const h of hazards) {
        if (h.passed || x < h.x0 + (h.x1 - h.x0) * 0.4) continue;
        h.passed = true;
        const attempts = (deathsAt[h.x0] || 0) + 1;
        let p = h.base === 'LEAP' ? clamp(0.98 - 0.62 * skill, 0.3, 0.95) : clamp(h.base * (1.6 - 1.2 * skill), 0.01, 0.6);
        p *= Math.pow(h.base === 'LEAP' ? 0.96 : 0.93, attempts - 1);
        if (st.confetti > 1200 && dev.scale > 1.4) p *= 1.35; // stutter kills
        if (chance(p)) died = h;
        break;
      }

      if (died) {
        const dx = uni(died.x0 + 0.3, died.x1 - 0.3);
        const fell = died.cause === 'fell';
        const dy = fell ? level.killY : (groundY(level, dx) ?? 0) + 0.4;
        for (let k = 1; k <= 3 && fell; k++) timeline.push([t + k * 200, lid, dx + k * 0.2, yAt(level, dx, t / 1000) - (k * (yAt(level, dx, t / 1000) - dy)) / 3]);
        t += fell ? 650 : 120;
        push({ type: 'death', ts: t, level: lid, x: r2(dx), y: r2(dy), z: 0, cause: died.cause });
        remember(`death:${died.cause}`, t);
        deathsAt[died.x0] = (deathsAt[died.x0] || 0) + 1;
        const n = deathsAt[died.x0];
        if (died.base === 'LEAP' && n >= 2 && chance(0.25 + (1 - skill) * 0.35)) {
          push({ type: 'custom', ts: t + 400, level: lid, name: 'rage_input', attrs: { key: 'Space', count: 4 } });
        }
        const rageP = died.base === 'LEAP' ? (n >= 2 ? 0.14 + (1 - skill) * 0.32 : 0.04) : n >= 3 ? 0.1 : 0.012;
        const giveUp = died.base === 'LEAP' ? 6 : 8;
        if (chance(rageP) || n >= giveUp) {
          if (n >= giveUp) push({ type: 'level_fail', ts: t + 300, level: lid, cause: 'gave_up' });
          ended = { ts: t + uni(1500, 12000), reason: 'pagehide' };
          break;
        }
        t += 1100; // respawn delay
        const cps = level.checkpoints.map((c) => c.x).filter((cx) => cx < dx);
        checkpoint = Math.max(level.spawn.x, ...cps);
        x = checkpoint;
        for (const h of hazards) if (h.x0 >= x) h.passed = false;
        continue;
      }

      if (x >= level.goal.x) {
        const dur = (t - levelStart) / 1000;
        push({ type: 'level_complete', ts: t, level: lid, duration_s: r2(dur), score: bones * 10 });
        remember('level_complete', t);
        t += uni(2500, 6000); // level card
        const quitP = li === 0 ? 0.1 : li === 1 ? 0.12 : 1;
        if (li === LEVELS.length - 1 || chance(quitP)) ended = { ts: t + uni(3000, 25000), reason: 'pagehide' };
        break;
      }
      if (t - start > 14 * 60_000) ended = { ts: t, reason: 'hidden_timeout' };
    }
  }

  // ── frame windows, hitches and position batches over the whole session
  const tEnd = ended.ts;
  const firstFrame = start + ttff;
  const levelAt = (ts) => {
    let lvl = null;
    for (const s of timeline) {
      if (s[0] > ts) break;
      lvl = s[1];
    }
    return lvl;
  };
  const confettiAt = (ts) => events.filter((e) => e.name === 'powerup' && e.ts <= ts).length * CONFETTI_PER_BURST;
  const levelsStartedBy = (ts) => events.filter((e) => e.type === 'level_start' && e.ts <= ts).map((e) => e.level);
  for (let w = firstFrame; w < tEnd; w += 5000) {
    const lvl = levelAt(w + 2500);
    const conf = confettiAt(w + 2500);
    const loaded = levelsStartedBy(w + 2500);
    const geometries = 120 + loaded.reduce((s, l) => s + GEOMETRY_PER_LEVEL[l], 0) + conf;
    const extra = (conf / CONFETTI_PER_BURST) * 6.0 * dev.scale; // ms per frame per burst of meshes
    const sk = new Sketch();
    let frames = 0;
    let max = 0;
    let slow = 0;
    let jank = 0;
    let hitches = 0;
    let elapsed = 0;
    while (elapsed < 5000) {
      const normal = (dev.base[0] + dev.base[1]) / 2 + extra;
      let ft = uni(dev.base[0], dev.base[1]) + extra * uni(0.85, 1.15);
      ft = Math.max(budget * 0.98, ft);
      if (dev.hz === 60 && ft < 16.6) ft = uni(16.4, 17.0);
      if (chance(0.002 * dev.scale)) ft += uni(15, 30);
      const spike = ft > 50 && ft > 2 * normal; // same rule as the SDK: a stutter, not a slow device
      sk.add(ft);
      frames++;
      elapsed += ft;
      max = Math.max(max, ft);
      if (ft > budget * 1.5) slow++;
      if (ft > 33.4) jank++;
      if (spike) hitches++;
    }
    // explicit hitches (pickups, shader compiles) + GC
    const queued = st.hitchQueue.filter((h) => h.ts >= w && h.ts < w + 5000);
    if (lvl && chance(dev.tier === 'low' ? 0.05 : 0.015)) queued.push({ ts: w + uni(0, 5000), ms: uni(52, 85), causes: ['gc'], level: lvl });
    for (const h of queued) {
      sk.add(h.ms);
      frames++;
      max = Math.max(max, h.ms);
      hitches++;
      jank++;
      const crumbs = events.filter((e) => e.ts <= h.ts && e.ts >= h.ts - 1500 && (e.type === 'custom' || e.type === 'death' || e.type === 'level_start'));
      const recent = [...new Set(crumbs.map((e) => (e.type === 'custom' ? e.name : e.type === 'death' ? `death:${e.cause}` : e.type)))];
      push({
        type: 'hitch',
        ts: Math.round(h.ts),
        level: h.level,
        duration_ms: r2(h.ms),
        frozen: false,
        draw_calls: DRAW_CALLS[h.level] + conf * 2,
        triangles: TRIS[h.level] + conf * 192,
        programs: st.programs,
        ctx: { particles: confettiAt(h.ts), entities: HAZARDS[h.level]?.filter((z) => z[2] !== 'fell').length ?? 0 },
        recent,
        causes: h.causes,
        loaf: (h.loaf || []).map((l) => ({ ...l, ms: r2(h.ms * 0.86) })),
      });
    }
    push({
      type: 'frame_window',
      ts: Math.round(w),
      level: lvl,
      duration_s: 5,
      frames,
      fps: r2(frames / 5),
      hz: dev.hz,
      budget_ms: r2(budget),
      ft: sk.toJSON(),
      ft_p50: r2(sk.quantile(0.5)),
      ft_p95: r2(sk.quantile(0.95)),
      ft_p99: r2(sk.quantile(0.99)),
      ft_max: r2(max),
      slow,
      jank,
      hitches,
      frozen: 0,
      render_ms: r2(1.1 + (conf / 800) * 4.6 * dev.scale),
      draw_calls: lvl ? DRAW_CALLS[lvl] + conf * 2 : 12,
      draw_calls_max: lvl ? DRAW_CALLS[lvl] + conf * 2 + 20 : 12,
      triangles: lvl ? TRIS[lvl] + conf * 192 : 900,
      geometries,
      textures: 22 + loaded.length * 6,
      programs: 14 + new Set(loaded).size * 3,
      heap_mb: dev.browser === 'Chrome' || dev.browser === 'Edge' ? r2(38 + geometries * 0.012 + uni(-2, 2)) : null,
      ctx: { particles: conf, entities: lvl ? HAZARDS[lvl].filter((z) => z[2] !== 'fell').length : 0 },
    });
  }
  for (let w = firstFrame; w < tEnd; w += 5000) {
    const pts = timeline.filter((p) => p[0] >= w && p[0] < w + 5000);
    if (!pts.length) continue;
    const lvl = pts[0][1];
    push({ type: 'pos', ts: Math.round(pts[0][0]), level: lvl, pts: pts.filter((p) => p[1] === lvl).map((p) => [Math.round(p[0]), r2(p[2]), r2(p[3]), 0]) });
  }
  push({ type: 'session_end', ts: Math.round(tEnd), level: st.level, reason: ended.reason, duration_s: r2((tEnd - start) / 1000) });
  return events.sort((a, b) => a.ts - b.ts);
}

// ───────────────────────────── main ─────────────────────────────
function diurnalStart(fromTs, toTs) {
  for (;;) {
    const ts = uni(fromTs, toTs);
    const hour = new Date(ts).getHours();
    const weight = 0.35 + 0.65 * Math.max(0, Math.sin(((hour - 9) / 24) * Math.PI * 2)) + (hour >= 18 && hour <= 23 ? 0.4 : 0);
    if (rnd() < weight / 1.4) return Math.round(ts);
  }
}

const store = await createStore();
if (flag('reset', false)) {
  await store.clear(DEFAULT_PROJECT, SERVICE);
  console.log(`cleared ${SERVICE}`);
}

const now = Date.now();
const players = Array.from({ length: 320 }, () => ({ id: id('p_', 12), returning: false }));
const plan = [
  ...Array.from({ length: N_OLD }, () => ({ version: '0.9.0', from: now - HOURS * 3600e3, to: now - HOURS * 0.55 * 3600e3 })),
  ...Array.from({ length: N_NEW }, () => ({ version: '1.0.0', from: now - HOURS * 0.5 * 3600e3, to: now - 10 * 60e3 })),
];
let total = 0;
const versions = {};
for (const p of plan) {
  const player = chance(0.22) ? players[Math.floor(rnd() * 40)] : players[40 + Math.floor(rnd() * 280)];
  if (players.indexOf(player) < 40) player.returning = true;
  const events = simulateSession({ version: p.version, start: diurnalStart(p.from, p.to), player });
  await store.put(DEFAULT_PROJECT, events);
  total += events.length;
  versions[p.version] = (versions[p.version] || 0) + 1;
}
console.log(`seeded ${plan.length} simulated sessions (${JSON.stringify(versions)}) → ${total} events into ${store.kind} store`);
console.log(`popup error fingerprint: ${ERR_FP}`);
