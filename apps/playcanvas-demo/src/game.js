// Spark Run: ride a hover-board down a long track, steer around the barriers, collect sparks, hit the boost pads.
// Engine-only PlayCanvas: the board's behaviour lives in two script classes, Runner (moving, the camera, the finish)
// and Collector (pickups and crashes).
import * as pc from 'playcanvas';
import { LEVELS, HALF, LANES } from './levels.js';
import { Bot } from './bot.js';

const LIVES = 3;
const SPARKS = 450; // sparks in a boost-pad burst
const STEER = 9; // units a second across the track
const POWERUPS = {
  shield: { seconds: 3 },
  slowmo: { seconds: 2 },
  // GLITCHLESS-DEMO: no 'magnet' entry, so picking up the magnet throws (see Collector).
};

export function createGame({ app, params, tel, onDone, onLevelBuilt }) {
  const device = app.graphicsDevice;
  const state = { index: params.level - 1, lives: LIVES, sparks: 0, score: 0, x: 0, z: 0, steer: 0, startedAt: 0, boostUntil: 0, shieldUntil: 0, invulnerableUntil: 0, bursts: 0, frame: 0, paused: false, done: false };
  const bot = params.autoplay ? new Bot({ skill: params.skill, seed: params.seed, lanes: LANES }) : null;
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyR' && level) giveUp('restart');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const hud = document.getElementById('hud');
  const banner = document.getElementById('banner');
  const effects = [];
  let level = null;

  const material = (c, glow = 0) => {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(c[0], c[1], c[2]);
    if (glow) m.emissive = new pc.Color(c[0] * glow, c[1] * glow, c[2] * glow);
    m.update();
    return m;
  };
  const shared = {
    spark: material([1, 0.75, 0.2], 1),
    pad: material([0.2, 1, 0.6], 0.9),
    barrier: material([0.9, 0.25, 0.3], 0.3),
    rail: material([0.9, 0.9, 1], 0.4),
    shield: material([0.5, 0.6, 1], 1),
    magnet: material([0.9, 0.3, 1], 1),
    board: material([0.3, 0.95, 1], 0.8),
  };
  const box = (parent, name, mat, [x, y, z], [sx, sy, sz], type = 'box') => {
    const e = new pc.Entity(name);
    e.addComponent('render', { type, material: mat });
    e.setLocalPosition(x, y, z);
    e.setLocalScale(sx, sy, sz);
    parent.addChild(e);
    return e;
  };

  app.scene.ambientLight = new pc.Color(0.45, 0.45, 0.5);
  const sun = new pc.Entity('sun');
  sun.addComponent('light', { type: 'directional', intensity: 1.1 });
  sun.setEulerAngles(50, 30, 0);
  app.root.addChild(sun);
  const camera = new pc.Entity('camera');
  camera.addComponent('camera', { fov: 60, farClip: 400 });
  app.root.addChild(camera);

  // Moves the board, steers, follows with the camera, and ends the level at the finish.
  class Runner extends pc.Script {
    static scriptName = 'runner';

    update(dt) {
      if (!level || state.paused || state.done) return;
      const L = level.L;
      const speed = L.speed * (performance.now() < state.boostUntil ? 1.5 : 1);
      const input = bot ? bot.steer(state, level.ahead(state.x), speed) : keyInput();
      state.steer += (input - state.steer) * Math.min(1, dt * 10);
      state.x += speed * dt;
      state.z = Math.max(-HALF + 0.45, Math.min(HALF - 0.45, state.z + state.steer * STEER * dt));
      this.entity.setPosition(state.x, 0.35, state.z);
      this.entity.setEulerAngles(-state.steer * 14, 0, 0);
      camera.setPosition(state.x - 10, 5.5, state.z * 0.5);
      camera.lookAt(state.x + 8, 0, state.z * 0.3);
      tel()?.setPosition({ x: state.x, y: 0, z: state.z });
      updateEffects(dt);
      tel()?.setContext({ sparks_fx: effects.length });
      if (++state.frame % 10 === 0) drawHud();
      if (state.x >= L.length) complete();
    }
  }

  // Pickups and crashes along the track.
  class Collector extends pc.Script {
    static scriptName = 'collector';

    update() {
      if (!level || state.paused || state.done) return;
      const now = performance.now();
      for (const it of level.items) {
        const dx = Math.abs(it.x - state.x);
        if (it.taken || dx > 1.2) continue;
        const dz = Math.abs(it.z - state.z);
        if (it.kind === 'barrier') {
          if (dx < 0.8 && dz < it.width / 2 + 0.45 && now > state.invulnerableUntil && now > state.shieldUntil) return crash();
          continue;
        }
        if (dz > (it.kind === 'pad' ? 1.4 : 0.9)) continue;
        it.taken = true;
        it.entity.enabled = false;
        if (it.kind === 'spark') {
          state.sparks++;
          state.score += 10;
          tel()?.track('spark');
        } else if (it.kind === 'pad') {
          state.boostUntil = now + 2000;
          tel()?.track('boost');
          sparkBurst(it.x, it.z);
        } else {
          tel()?.track('powerup', { kind: it.kind });
          const until = now + POWERUPS[it.kind].seconds * 1000;
          if (it.kind === 'shield') state.shieldUntil = until;
        }
      }
    }
  }

  const board = box(app.root, 'board', shared.board, [0, 0.35, 0], [1.2, 0.25, 0.9]);
  board.addComponent('script');
  board.script.create(Runner);
  board.script.create(Collector);

  function load(index) {
    level?.root.destroy();
    effects.length = 0; // their entities were children of the level
    const L = LEVELS[index];
    Object.assign(state, { index, lives: LIVES, sparks: 0, x: 0, z: 0, steer: 0, startedAt: performance.now(), boostUntil: 0, shieldUntil: 0, invulnerableUntil: 0, done: false });
    const root = new pc.Entity(L.id);
    app.root.addChild(root);
    camera.camera.clearColor = new pc.Color(L.sky[0], L.sky[1], L.sky[2]);
    box(root, 'track', material(L.ground), [L.length / 2, -0.1, 0], [L.length + 40, 0.2, HALF * 2 + 2]);
    for (const side of [-1, 1]) box(root, 'rail', shared.rail, [L.length / 2, 0.25, side * (HALF + 0.6)], [L.length + 40, 0.5, 0.2]);
    box(root, 'finish', shared.pad, [L.length, 0.02, 0], [0.6, 0.05, HALF * 2]);
    const items = [];
    for (const b of L.barriers) items.push({ ...b, kind: 'barrier', entity: box(root, 'barrier', shared.barrier, [b.x, 0.6, b.z], [0.6, 1.2, b.width]) });
    for (const s of L.sparks) items.push({ ...s, kind: 'spark', entity: box(root, 'spark', shared.spark, [s.x, 0.6, s.z], [0.35, 0.35, 0.35], 'sphere') });
    for (const p of L.pads) items.push({ ...p, kind: 'pad', entity: box(root, 'boost-pad', shared.pad, [p.x, 0.03, p.z], [1.6, 0.06, 2.4]) });
    for (const e of L.extras) items.push({ ...e, kind: e.kind, entity: box(root, e.kind, shared[e.kind] || shared.shield, [e.x, 0.7, e.z], [0.6, 0.6, 0.6], 'torus') });
    items.sort((a, b) => a.x - b.x);
    level = {
      L,
      root,
      items,
      // What lies ahead of x, nearest first, for the bot.
      ahead: (x) => items.filter((it) => !it.taken && it.x > x && it.x < x + 30),
    };
    tel()?.levelStart(L.id);
    onLevelBuilt?.(L, board);
    showBanner(L.name, 1200);
  }

  // GLITCHLESS-DEMO: a mesh and a material per spark. Every boost pad builds SPARKS sparks on the frame it is
  // crossed, each with a new sphere Mesh (its own vertex and index buffers), its own StandardMaterial and an entity
  // of its own. One mesh drawn with hardware instancing (or a particle system) would cost one draw call.
  function sparkBurst(x, z) {
    state.bursts++;
    for (let i = 0; i < SPARKS; i++) {
      const mesh = pc.Mesh.fromGeometry(device, new pc.SphereGeometry({ radius: 0.07, latitudeBands: 10, longitudeBands: 10 }));
      const [r, g, b] = hsv((state.bursts * 0.21 + i / SPARKS) % 1, 0.7, 1);
      const spark = new pc.StandardMaterial();
      spark.diffuse = new pc.Color(0, 0, 0);
      spark.emissive = new pc.Color(r, g, b);
      spark.update();
      const e = new pc.Entity('spark-fx');
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, spark)] });
      e.setPosition(x, 0.4, z);
      level.root.addChild(e);
      const a = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      effects.push({ e, vx: Math.cos(a) * speed, vy: 3 + Math.random() * 5, vz: Math.sin(a) * speed, px: x, py: 0.4, pz: z, life: 0.8 + Math.random() * 0.6 });
    }
  }

  function updateEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.e.destroy();
        effects.splice(i, 1);
        continue;
      }
      fx.vy -= 12 * dt;
      fx.px += fx.vx * dt;
      fx.py = Math.max(0.05, fx.py + fx.vy * dt);
      fx.pz += fx.vz * dt;
      fx.e.setPosition(fx.px, fx.py, fx.pz);
    }
  }

  function keyInput() {
    return (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
  }

  function crash() {
    tel()?.death({ x: state.x, y: 0, z: state.z, cause: 'barrier' });
    state.lives--;
    if (state.lives <= 0) {
      tel()?.levelFail(level.L.id, { cause: 'out_of_lives' });
      if (bot?.outOfLives()) {
        state.done = true;
        showBanner('Out of lives', 0);
        onDone('quit');
        return;
      }
      state.done = true;
      return later(() => load(state.index));
    }
    state.x = Math.max(0, state.x - 12);
    state.invulnerableUntil = performance.now() + 1500;
  }

  function giveUp(cause) {
    tel()?.levelFail(level.L.id, { cause });
    state.done = true;
    later(() => load(state.index));
  }

  function complete() {
    const L = level.L;
    state.done = true;
    tel()?.levelComplete(L.id, { durationS: (performance.now() - state.startedAt) / 1000, score: state.score });
    if (state.index + 1 < LEVELS.length) return later(() => load(state.index + 1));
    showBanner('Run complete!', 0);
    onDone('won');
  }

  // Levels are switched once the frame is over, not from inside a script's update.
  const later = (fn) => app.once('frameend', fn);

  function drawHud() {
    hud.innerHTML = `${level.L.name} · <b>${Math.round((state.x / level.L.length) * 100)}%</b> · sparks <b>${state.sparks}</b> · lives <b>${state.lives}</b> · score <b>${state.score}</b>${performance.now() < state.boostUntil ? ' · boost' : ''}`;
  }

  function showBanner(text, ms) {
    banner.textContent = text;
    banner.style.display = 'flex';
    if (ms) setTimeout(() => (banner.style.display = 'none'), ms);
  }

  const api = {
    getState: () => ({
      level: level?.L.id ?? null,
      x: Math.round(state.x * 10) / 10,
      z: Math.round(state.z * 10) / 10,
      progress_pct: level ? Math.round((state.x / level.L.length) * 100) : null,
      lives: state.lives,
      sparks: state.sparks,
      score: state.score,
      spark_effects: effects.length,
      boost_bursts: state.bursts,
      collector_enabled: board.script.collector?.enabled ?? null,
      paused: state.paused,
    }),
    loadLevel: (id) => {
      const i = LEVELS.findIndex((l) => l.id === id);
      if (i < 0) return { ok: false, error: `level must be one of ${LEVELS.map((l) => l.id).join(', ')}` };
      later(() => load(i));
      return { ok: true, level: id };
    },
    burst: () => {
      if (!level) return { ok: false, error: 'no level' };
      sparkBurst(state.x + 3, state.z);
      return { ok: true, sparks: SPARKS, bursts: state.bursts };
    },
    teleport: (x) => {
      state.x = Math.max(0, Math.min(level.L.length - 1, x));
      return { ok: true, x: state.x };
    },
    setPaused: (paused) => {
      state.paused = paused;
      return { ok: true, paused };
    },
  };

  return { load, state, api, board };
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  return [
    [v, q, p, p, t, v][i % 6],
    [t, v, v, q, p, p][i % 6],
    [p, p, t, v, v, q][i % 6],
  ];
}
