// The end-of-level replay, Super Meat Boy style: every attempt at once, each a ghost with a short trail,
// each death popping into a marker, until the one that made it walks into the goal.
//
// An attempt is { pts: Float32Array [x, y, …] (feet, one pair per 60 Hz step), n, end, death }.
import * as THREE from 'three';
import { PHYS } from './physics.js';
import { createMarkerLayer } from './markers/layer.js';

const MAX_GHOSTS = 300;
const TRAIL = 10; // samples in a trail
const TRAIL_GAP = 3; // steps between them
const TARGET_S = 8.5; // the winning run takes at most this long on screen

/** Records one attempt's path, a step at a time. */
export function createRecorder() {
  let buf = new Float32Array(2 * 600);
  let n = 0;
  return {
    push(x, y) {
      if (n * 2 + 2 > buf.length) {
        const bigger = new Float32Array(buf.length * 2);
        bigger.set(buf);
        buf = bigger;
      }
      buf[n * 2] = x;
      buf[n * 2 + 1] = y;
      n++;
    },
    finish(end, death = null) {
      return { pts: buf.slice(0, n * 2), n, end, death };
    },
    get n() {
      return n;
    },
  };
}

export function createReplay(view, { ghostColor = 0xdff8ff, winnerColor = 0xffcf5a, popColor = 0x86ecff } = {}) {
  const { scene, Z } = view;
  const geo = new THREE.PlaneGeometry(PHYS.halfW * 2, PHYS.h);
  const ghostMat = new THREE.MeshBasicMaterial({ map: view.playerTex, color: ghostColor, transparent: true, opacity: 0.42, depthWrite: false });
  const ghosts = new THREE.InstancedMesh(geo, ghostMat, MAX_GHOSTS);
  ghosts.frustumCulled = false;
  ghosts.position.z = Z.ghosts;
  ghosts.count = 0;
  const winner = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: view.playerTex, color: winnerColor, transparent: true, depthWrite: false }));
  winner.position.z = Z.ghosts + 0.5;
  const winnerGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: view.glowTex, color: winnerColor, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  winnerGlow.scale.set(2.6, 2.6, 1);
  winner.add(winnerGlow);

  const trailPos = new Float32Array(MAX_GHOSTS * (TRAIL - 1) * 2 * 3 + (TRAIL - 1) * 2 * 3);
  const trailCol = new Float32Array(trailPos.length);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
  const trails = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  trails.frustumCulled = false;
  trails.position.z = Z.ghosts - 0.2;

  const pops = createMarkerLayer({ capacity: 2000, color: popColor, size: 0.62, opacity: 1, z: Z.markers + 0.5 });
  const group = new THREE.Group();
  group.add(trails, ghosts, winner, pops.points);
  group.visible = false;
  scene.add(group);

  const m4 = new THREE.Matrix4();
  const ghostRGB = new THREE.Color(ghostColor);
  const goldRGB = new THREE.Color(winnerColor);
  let state = null;

  function start(attempts, clock) {
    const win = attempts[attempts.length - 1];
    let failed = attempts.slice(0, -1);
    if (failed.length > MAX_GHOSTS - 1) failed = failed.slice(failed.length - (MAX_GHOSTS - 1));
    const speed = Math.min(3, Math.max(1, win.n / (60 * TARGET_S)));
    const stepsPerS = 60 * speed;
    const end = win.n;
    // Every death pops at its own moment of the replay; the layer hides them until then.
    const deaths = failed.filter((a) => a.end === 'death' && a.n <= end).sort((a, b) => a.n - b.n);
    pops.setPoints(deaths.map((a) => ({ x: a.death.x, y: a.death.y, born: clock + a.n / stepsPerS })), clock);
    state = { failed, win, speed, stepsPerS, end, t: 0, popped: 0, deaths, clock0: clock, done: false };
    ghosts.count = failed.length;
    group.visible = true;
    winner.visible = true;
    return { duration: end / stepsPerS, ghosts: failed.length + 1, speed };
  }

  const at = (a, s) => {
    const i = Math.max(0, Math.min(a.n - 1, Math.floor(s)));
    return [a.pts[i * 2], a.pts[i * 2 + 1]];
  };

  function trail(a, s, k, rgb, strength) {
    // k: this ghost's slot in the trail buffer
    let o = k * (TRAIL - 1) * 6;
    for (let j = 0; j < TRAIL - 1; j++) {
      const [x0, y0] = at(a, s - j * TRAIL_GAP);
      const [x1, y1] = at(a, s - (j + 1) * TRAIL_GAP);
      const f0 = strength * (1 - j / (TRAIL - 1));
      const f1 = strength * (1 - (j + 1) / (TRAIL - 1));
      trailPos.set([x0, y0 + PHYS.h / 2, 0, x1, y1 + PHYS.h / 2, 0], o);
      trailCol.set([rgb.r * f0, rgb.g * f0, rgb.b * f0, rgb.r * f1, rgb.g * f1, rgb.b * f1], o);
      o += 6;
    }
  }

  /** Advance; returns { t (s), deaths so far, done }. `onPop(x, y)` for each death as it happens. */
  function update(dt, clock, ppuPx, onPop) {
    if (!state) return null;
    const s = state;
    if (!s.done) s.t = Math.min(s.end, s.t + dt * s.stepsPerS);
    const t = s.t;
    while (s.popped < s.deaths.length && s.deaths[s.popped].n <= t) {
      const d = s.deaths[s.popped++].death;
      onPop?.(d.x, d.y);
    }
    let live = 0;
    s.failed.forEach((a, i) => {
      // Runs that outlast the winning one are gone when it arrives: the replay ends on the one that made it.
      const alive = t < a.n && !s.done;
      const [x, y] = at(a, t);
      // A run that lasted longer than the winning one fades out as the winner arrives.
      const fade = alive ? Math.min(1, (s.end - t) / 30 + 0.2) : 0;
      m4.makeScale(alive ? 1 : 0, alive ? 1 : 0, 1);
      m4.setPosition(x, y + PHYS.h / 2, 0);
      ghosts.setMatrixAt(i, m4);
      trail(a, t, i, ghostRGB, alive ? 0.55 * fade : 0);
      if (alive) live++;
    });
    ghosts.instanceMatrix.needsUpdate = true;
    const [wx, wy] = at(s.win, t);
    const [px] = at(s.win, t - 2);
    winner.position.set(wx, wy + PHYS.h / 2, Z.ghosts + 0.5);
    if (wx !== px) winner.scale.x = wx > px ? 1 : -1;
    trail(s.win, t, s.failed.length, goldRGB, 1);
    const used = (s.failed.length + 1) * (TRAIL - 1) * 2;
    trailGeo.setDrawRange(0, used);
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
    pops.update(clock, ppuPx);
    if (t >= s.end && !s.done) {
      s.done = true;
      return update(0, clock, ppuPx, onPop);
    }
    return { t: t / s.stepsPerS, deaths: s.popped, live, done: s.done, winner: { x: wx, y: wy } };
  }

  function stop() {
    state = null;
    group.visible = false;
    ghosts.count = 0;
    pops.clear();
  }

  return {
    start,
    update,
    stop,
    get active() {
      return !!state;
    },
    get ghostsShown() {
      return state ? state.failed.length + 1 : 0;
    },
  };
}
