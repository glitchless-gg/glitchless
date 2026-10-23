// Comet Garden: roll the marble over a floating garden, collect every crystal, dodge the spore mines. Each level is
// its own Babylon.js scene, named in scene.metadata.level, which is how Glitchless knows the levels.
import * as BABYLON from '@babylonjs/core';
import { LEVELS, ARENA } from './levels.js';
import { Bot, mulberry32 } from './bot.js';

const LIVES = 3;
const SPAWN = { x: 0, z: -15 };
const SHARDS = 200; // shards in a prism burst
const POWERUPS = {
  boost: { seconds: 4, speed: 1.7 },
  shield: { seconds: 5, speed: 1 },
  // GLITCHLESS-DEMO: no 'comet' entry, so picking up the comet throws (see collectPowerup).
};

const SHARD_VERTEX = `precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vNormal;
void main() {
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

// GLITCHLESS-DEMO: the shard's colour is baked into its fragment shader's source (see shardBurst).
const shardFragment = (r, g, b) => `precision highp float;
varying vec3 vNormal;
void main() {
  float light = 0.55 + 0.45 * abs(vNormal.y);
  gl_FragColor = vec4(vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}) * light, 1.0);
}`;

export function createGame({ engine, params, tel, onDone, onSceneReady }) {
  const state = { index: params.level - 1, lives: LIVES, collected: 0, total: 0, score: 0, startedAt: 0, power: null, bursts: 0, shards: [], invulnerableUntil: 0, frame: 0, paused: false };
  const bot = params.autoplay ? new Bot({ skill: params.skill, seed: params.seed }) : null;
  const rng = mulberry32(params.seed ^ 0x5eed);
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyR' && world) giveUp('restart');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const hud = document.getElementById('hud');
  const banner = document.getElementById('banner');
  let scene = null;
  let world = null;

  const color = (c) => new BABYLON.Color3(c[0], c[1], c[2]);
  const glow = (name, c) => {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = color(c).scale(0.4);
    m.emissiveColor = color(c);
    m.specularColor = BABYLON.Color3.Black();
    return m;
  };

  function load(index) {
    scene?.dispose();
    const L = LEVELS[index];
    Object.assign(state, { index, lives: LIVES, collected: 0, power: null, shards: [], startedAt: performance.now(), invulnerableUntil: 0 });
    scene = new BABYLON.Scene(engine);
    scene.metadata = { level: L.id }; // Glitchless starts level L.id when this scene first renders
    scene.clearColor = new BABYLON.Color4(L.sky[0], L.sky[1], L.sky[2], 1);
    const camera = new BABYLON.ArcRotateCamera('camera', -Math.PI / 2, 0.62, 56, new BABYLON.Vector3(0, 0, -2.5), scene);
    camera.fov = 0.75;
    const sky = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(0.3, 1, -0.4), scene);
    sky.intensity = 0.95;

    const ground = BABYLON.MeshBuilder.CreateGround('garden', { width: ARENA * 2 + 2, height: ARENA * 2 + 2 }, scene);
    const groundMat = new BABYLON.StandardMaterial('garden', scene);
    groundMat.diffuseColor = color(L.ground);
    groundMat.specularColor = BABYLON.Color3.Black();
    ground.material = groundMat;
    const wallMat = glow('wall', [0.45, 0.4, 0.75]);
    for (const [x, z, w, d] of [
      [0, ARENA + 1, ARENA * 2 + 2, 0.4],
      [0, -ARENA - 1, ARENA * 2 + 2, 0.4],
      [ARENA + 1, 0, 0.4, ARENA * 2 + 2],
      [-ARENA - 1, 0, 0.4, ARENA * 2 + 2],
    ]) {
      const wall = BABYLON.MeshBuilder.CreateBox('wall', { width: w, depth: d, height: 0.6 }, scene);
      wall.position.set(x, 0.3, z);
      wall.material = wallMat;
    }

    const marble = BABYLON.MeshBuilder.CreateSphere('marble', { diameter: 1.2, segments: 16 }, scene);
    marble.material = glow('marble', [0.95, 0.95, 1]);
    marble.position.set(SPAWN.x, 0.6, SPAWN.z);

    // Crystals and mines are instances of one mesh each: one draw call per kind. (The shards are not: see below.)
    const pickups = (name, list, mesh, kind) =>
      list.map(([x, z], i) => {
        const m = i === 0 ? mesh : mesh.createInstance(`${name}-${i}`);
        m.position.set(x, 0.6, z);
        return { mesh: m, x, z, kind, taken: false };
      });
    const seedMesh = BABYLON.MeshBuilder.CreateIcoSphere('seed', { radius: 0.35, subdivisions: 2 }, scene);
    seedMesh.material = glow('seed', [1, 0.82, 0.3]);
    const prismMesh = BABYLON.MeshBuilder.CreatePolyhedron('prism', { type: 1, size: 0.5 }, scene);
    prismMesh.material = glow('prism', [0.95, 0.3, 0.9]);
    const mineMesh = BABYLON.MeshBuilder.CreatePolyhedron('spore-mine', { type: 2, size: 0.6 }, scene);
    mineMesh.material = glow('spore', [0.95, 0.2, 0.25]);
    const powerMat = { boost: glow('boost', [0.3, 1, 0.5]), comet: glow('comet', [0.3, 0.9, 1]), shield: glow('shield', [0.6, 0.6, 1]) };

    world = {
      L,
      marble,
      vel: { x: 0, z: 0 },
      seeds: pickups('seed', L.seeds, seedMesh, 'seed'),
      prisms: pickups('prism', L.prisms, prismMesh, 'prism'),
      mines: L.mines.map(([ax, az, r, w], i) => {
        const mesh = i === 0 ? mineMesh : mineMesh.createInstance(`spore-mine-${i}`);
        return { mesh, ax, az, r, w, phase: i * 1.7, x: ax, z: az };
      }),
      powerups: L.powerups.map(({ kind, at: [x, z] }) => {
        const mesh = BABYLON.MeshBuilder.CreateTorus(`powerup-${kind}`, { diameter: 1, thickness: 0.25 }, scene);
        mesh.material = powerMat[kind] || powerMat.boost;
        mesh.position.set(x, 0.7, z);
        return { mesh, kind, x, z, taken: false };
      }),
    };
    state.total = world.seeds.length + world.prisms.length;
    scene.onBeforeRenderObservable.add(() => {
      if (!state.paused) update(Math.min(0.05, engine.getDeltaTime() / 1000));
    });
    scene.executeWhenReady(() => onSceneReady?.(scene, L, world));
    showBanner(L.name, 1200);
  }

  function update(dt) {
    const t = performance.now() / 1000;
    for (const m of world.mines) {
      m.x = m.ax + Math.cos(t * m.w + m.phase) * m.r;
      m.z = m.az + Math.sin(t * m.w + m.phase) * m.r;
      m.mesh.position.set(m.x, 0.7, m.z);
      m.mesh.rotation.y = t * 2;
    }
    for (const p of world.powerups) p.mesh.rotation.y = t * 2;
    const p = world.marble.position;
    const input = bot ? bot.steer({ x: p.x, z: p.z }, targets(), world.mines) : keyInput();
    const power = state.power && performance.now() < state.power.until ? state.power : null;
    const accel = 30 * (power?.speed ?? 1);
    const v = world.vel;
    v.x = (v.x + input.x * accel * dt) * (1 - 2.4 * dt);
    v.z = (v.z + input.z * accel * dt) * (1 - 2.4 * dt);
    p.x += v.x * dt;
    p.z += v.z * dt;
    if (Math.abs(p.x) > ARENA) (p.x = Math.sign(p.x) * ARENA), (v.x *= -0.5);
    if (Math.abs(p.z) > ARENA) (p.z = Math.sign(p.z) * ARENA), (v.z *= -0.5);
    world.marble.rotation.x += v.z * dt;
    world.marble.rotation.z -= v.x * dt;
    tel()?.setPosition(p);

    for (const c of world.seeds) if (!c.taken && Math.hypot(c.x - p.x, c.z - p.z) < 1) collect(c);
    for (const c of world.prisms) if (!c.taken && Math.hypot(c.x - p.x, c.z - p.z) < 1.1) collect(c);
    for (const u of world.powerups) if (!u.taken && Math.hypot(u.x - p.x, u.z - p.z) < 1.2) collectPowerup(u);
    if (performance.now() > state.invulnerableUntil && power?.kind !== 'shield') {
      for (const m of world.mines) if (Math.hypot(m.x - p.x, m.z - p.z) < 1.25) return die();
    }
    updateShards(dt);
    tel()?.setContext({ shards: state.shards.length });
    if (++state.frame % 10 === 0) drawHud();
  }

  function targets() {
    const out = [];
    for (const c of world.seeds) if (!c.taken) out.push(c);
    for (const c of world.prisms) if (!c.taken) out.push(c);
    for (const u of world.powerups) if (!u.taken) out.push(u);
    return out;
  }

  function keyInput() {
    const x = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    const z = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0);
    const len = Math.hypot(x, z) || 1;
    return { x: x / len, z: z / len };
  }

  function collect(c) {
    c.taken = true;
    c.mesh.setEnabled(false);
    state.collected++;
    state.score += c.kind === 'prism' ? 50 : 10;
    tel()?.track(c.kind); // 'seed' or 'prism'
    if (c.kind === 'prism') shardBurst(c.x, c.z);
    if (state.collected === state.total) complete();
  }

  function collectPowerup(u) {
    u.taken = true;
    u.mesh.setEnabled(false);
    tel()?.track('powerup', { kind: u.kind });
    const def = POWERUPS[u.kind];
    state.power = { kind: u.kind, until: performance.now() + def.seconds * 1000, speed: def.speed };
  }

  // GLITCHLESS-DEMO: uncached shaders. Every shard gets its own ShaderMaterial with its colour baked into the fragment
  // source, so each one is a new effect for Babylon.js to compile: SHARDS compiles on the frame after a prism is
  // picked up. One shader in ShaderStore.ShadersStore with a colour uniform would compile once, for every burst.
  function shardBurst(x, z, n = SHARDS) {
    const burst = state.bursts++;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = hsv((burst * 0.13 + i / n) % 1, 0.75, 1);
      const material = new BABYLON.ShaderMaterial(`shard-${burst}-${i}`, scene, { vertexSource: SHARD_VERTEX, fragmentSource: shardFragment(r, g, b) }, { attributes: ['position', 'normal'], uniforms: ['world', 'worldViewProjection'] });
      const mesh = BABYLON.MeshBuilder.CreatePolyhedron(`shard-${burst}-${i}`, { type: 1, size: 0.2 }, scene);
      mesh.material = material;
      mesh.position.set(x, 0.8, z);
      const a = (i / n) * Math.PI * 2;
      const speed = 3 + rng() * 4;
      state.shards.push({ mesh, vx: Math.cos(a) * speed, vy: 4 + rng() * 4, vz: Math.sin(a) * speed, life: 1.2 + rng() * 0.4 });
    }
  }

  function updateShards(dt) {
    for (let i = state.shards.length - 1; i >= 0; i--) {
      const s = state.shards[i];
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.dispose(false, true);
        state.shards.splice(i, 1);
        continue;
      }
      s.vy -= 12 * dt;
      const pos = s.mesh.position;
      pos.x += s.vx * dt;
      pos.y = Math.max(0.15, pos.y + s.vy * dt);
      pos.z += s.vz * dt;
      s.mesh.rotation.y += dt * 6;
    }
  }

  function die() {
    const p = world.marble.position;
    tel()?.death({ x: p.x, y: 0, z: p.z, cause: 'spore' });
    state.lives--;
    if (state.lives <= 0) {
      tel()?.levelFail(world.L.id, { cause: 'out_of_lives' });
      if (bot?.outOfLives()) {
        state.paused = true;
        showBanner('Out of lives', 0);
        onDone('quit');
        return;
      }
      return later(() => load(state.index)); // a new scene: a new attempt
    }
    p.set(SPAWN.x, 0.6, SPAWN.z);
    world.vel.x = world.vel.z = 0;
    state.invulnerableUntil = performance.now() + 1500;
  }

  function giveUp(cause) {
    tel()?.levelFail(world.L.id, { cause });
    later(() => load(state.index));
  }

  function complete() {
    const L = world.L;
    tel()?.levelComplete(L.id, { durationS: (performance.now() - state.startedAt) / 1000, score: state.score });
    if (state.index + 1 < LEVELS.length) return later(() => load(state.index + 1));
    state.paused = true;
    showBanner('Garden complete!', 0);
    onDone('won');
  }

  // A scene can't be disposed from inside its own render: switch once this frame is over.
  const later = (fn) => engine.onEndFrameObservable.addOnce(fn);

  function drawHud() {
    hud.innerHTML = `${world.L.name} · crystals <b>${state.collected}/${state.total}</b> · lives <b>${state.lives}</b> · score <b>${state.score}</b>${state.power && performance.now() < state.power.until ? ` · ${state.power.kind}` : ''}`;
  }

  function showBanner(text, ms) {
    banner.textContent = text;
    banner.style.display = 'flex';
    if (ms) setTimeout(() => (banner.style.display = 'none'), ms);
  }

  const api = {
    getState: () => ({
      level: world?.L.id ?? null,
      position: world ? { x: round(world.marble.position.x), z: round(world.marble.position.z) } : null,
      crystals: `${state.collected}/${state.total}`,
      lives: state.lives,
      score: state.score,
      power: state.power && performance.now() < state.power.until ? state.power.kind : null,
      shards: state.shards.length,
      prism_bursts: state.bursts,
      paused: state.paused,
    }),
    loadLevel: (id) => {
      const i = LEVELS.findIndex((l) => l.id === id);
      if (i < 0) return { ok: false, error: `level must be one of ${LEVELS.map((l) => l.id).join(', ')}` };
      later(() => load(i));
      return { ok: true, level: id };
    },
    burst: (n = SHARDS) => {
      if (!world) return { ok: false, error: 'no level' };
      const p = world.marble.position;
      shardBurst(p.x, p.z, n);
      return { ok: true, shards: n, bursts: state.bursts };
    },
    teleport: (x, z) => {
      world.marble.position.set(Math.max(-ARENA, Math.min(ARENA, x)), 0.6, Math.max(-ARENA, Math.min(ARENA, z)));
      world.vel.x = world.vel.z = 0;
      return { ok: true, x, z };
    },
    setPaused: (paused) => {
      state.paused = paused;
      return { ok: true, paused };
    },
  };

  return {
    get scene() {
      return scene;
    },
    state,
    load,
    api,
  };
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

function round(v) {
  return Math.round(v * 100) / 100;
}
