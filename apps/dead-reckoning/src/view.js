// Everything three.js draws apart from the markers and the replay ghosts: the dark chart the level sits on,
// the two pads you can see, the start beacon, the goal, the player, glows where your feet touch the
// invisible ground, death bursts, and the level itself, revealed only after a replay (or with ?reveal=1).
import * as THREE from 'three';
import { PHYS, HAZARD_BOX } from './physics.js';

export const COLORS = {
  bg: 0x07080c,
  grid: 0x1d2433,
  gridMajor: 0x2a3348,
  pad: 0xe9e4d8,
  player: 0xf4f1ea,
  mine: 0x86ecff,
  others: 0xff7a3d,
  gold: 0xffcf5a,
  abyss: 0xb3263a,
  revealSolid: 0x4b5d86,
  revealHazard: 0xff4d5e,
};

const Z = { abyss: -8, grid: -6, reveal: -4, pads: -3, beacon: -2.5, glow: -1, markers: 0, ghosts: 2, player: 3, fx: 4 };

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function playerTexture() {
  const c = document.createElement('canvas');
  c.width = 60;
  c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f1ea';
  g.beginPath();
  g.roundRect(2, 2, 56, 76, 12);
  g.fill();
  g.fillStyle = '#0b0d14';
  g.fillRect(31, 22, 8, 14);
  g.fillRect(45, 22, 8, 14);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(COLORS.bg, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
  camera.position.z = 50;

  const glowTex = glowTexture();
  const additive = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });

  // ── per-level things, rebuilt by setLevel()
  let levelGroup = null;
  let reveal = null;
  let goal = null;
  let beacon = null;
  let lv = null;

  // ── the player
  const player = new THREE.Group();
  const playerTex = playerTexture();
  const playerMat = new THREE.MeshBasicMaterial({ map: playerTex, transparent: true });
  const playerMesh = new THREE.Mesh(new THREE.PlaneGeometry(PHYS.halfW * 2, PHYS.h), playerMat);
  const playerGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COLORS.mine, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  playerGlow.scale.set(3.2, 3.2, 1);
  player.add(playerGlow, playerMesh);
  player.position.z = Z.player;
  scene.add(player);
  const squash = { x: 1, y: 1 };

  // ── footstep glows: thin bars on the edges of tiles you touch
  const STEPS = 48;
  const stepGeo = new THREE.PlaneGeometry(1, 1);
  const steps = [];
  for (let i = 0; i < STEPS; i++) {
    const m = new THREE.Mesh(stepGeo, additive(COLORS.mine, 0));
    m.visible = false;
    m.position.z = Z.glow;
    scene.add(m);
    steps.push({ mesh: m, key: null, t: 0, life: 0.7, peak: 0.9 });
  }
  let stepNext = 0;

  function touchEdge(key, x, y, w, h, peak = 0.9, life = 0.7) {
    let s = steps.find((e) => e.key === key && e.t > 0);
    if (!s) {
      s = steps[stepNext];
      stepNext = (stepNext + 1) % STEPS;
    }
    s.key = key;
    s.t = life;
    s.life = life;
    s.peak = peak;
    s.mesh.position.set(x, y, Z.glow);
    s.mesh.scale.set(w, h, 1);
    s.mesh.visible = true;
  }

  // ── bursts (deaths, the win)
  const BURST = 600;
  const burstPos = new Float32Array(BURST * 3);
  const burstCol = new Float32Array(BURST * 3);
  const burstVel = new Float32Array(BURST * 2);
  const burstLife = new Float32Array(BURST);
  const burstGeo = new THREE.BufferGeometry();
  burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
  burstGeo.setAttribute('color', new THREE.BufferAttribute(burstCol, 3));
  const burstMat = new THREE.PointsMaterial({ size: 4, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, map: glowTex });
  const bursts = new THREE.Points(burstGeo, burstMat);
  bursts.frustumCulled = false;
  bursts.position.z = Z.fx;
  scene.add(bursts);
  let burstNext = 0;
  const tmpColor = new THREE.Color();

  function burst(x, y, color, n = 26, speed = 7) {
    tmpColor.set(color);
    for (let i = 0; i < n; i++) {
      const k = burstNext;
      burstNext = (burstNext + 1) % BURST;
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      burstPos[k * 3] = x;
      burstPos[k * 3 + 1] = y;
      burstPos[k * 3 + 2] = 0;
      burstVel[k * 2] = Math.cos(a) * v;
      burstVel[k * 2 + 1] = Math.sin(a) * v + 2;
      burstLife[k] = 0.45 + Math.random() * 0.35;
      burstCol[k * 3] = tmpColor.r;
      burstCol[k * 3 + 1] = tmpColor.g;
      burstCol[k * 3 + 2] = tmpColor.b;
    }
  }

  function setLevel(level, { revealAlways = false } = {}) {
    lv = level;
    if (levelGroup) {
      levelGroup.traverse((o) => {
        o.geometry?.dispose();
        if (o.material && o.material !== playerMat) o.material.dispose();
      });
      scene.remove(levelGroup);
    }
    levelGroup = new THREE.Group();
    scene.add(levelGroup);
    for (const s of steps) {
      s.t = 0;
      s.mesh.visible = false;
    }

    // Chart-paper dots at every tile corner, brighter every fifth.
    const dots = [];
    const majors = [];
    for (let c = 0; c <= lv.w; c++) for (let r = 0; r <= lv.h; r++) ((c % 5 === 0 && r % 5 === 0) ? majors : dots).push(c, r, 0);
    const dpr = renderer.getPixelRatio();
    for (const [list, color, size] of [[dots, COLORS.grid, 2], [majors, COLORS.gridMajor, 3]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size: size * dpr, sizeAttenuation: false }));
      p.position.z = Z.grid;
      levelGroup.add(p);
    }
    // The walls and ceiling, as hairlines.
    const frame = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1.6, 0), new THREE.Vector3(0, lv.h, 0), new THREE.Vector3(lv.w, lv.h, 0), new THREE.Vector3(lv.w, -1.6, 0)]);
    const frameLine = new THREE.Line(frame, new THREE.LineBasicMaterial({ color: COLORS.gridMajor, transparent: true, opacity: 0.8 }));
    frameLine.position.z = Z.grid;
    levelGroup.add(frameLine);

    // The abyss: a red haze along the bottom, where the fallen end up.
    const abyssGeo = new THREE.PlaneGeometry(lv.w, 2.2);
    const ac = new THREE.Color(COLORS.abyss);
    const colors = [];
    const pos = abyssGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const top = pos.getY(i) > 0;
      colors.push(top ? 0 : ac.r * 0.3, top ? 0 : ac.g * 0.3, top ? 0 : ac.b * 0.3);
    }
    abyssGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const abyss = new THREE.Mesh(abyssGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    abyss.position.set(lv.w / 2, -0.55, Z.abyss);
    levelGroup.add(abyss);

    // The pads you can see.
    const padGeo = new THREE.PlaneGeometry(1, 1);
    const padMat = new THREE.MeshBasicMaterial({ color: COLORS.pad });
    const padTopMat = additive(0xffffff, 0.9);
    for (let r = 0; r < lv.h; r++) {
      for (let c = 0; c < lv.w; c++) {
        if (!lv.visible[r * lv.w + c]) continue;
        const m = new THREE.Mesh(padGeo, padMat);
        m.scale.set(1, 0.32, 1);
        m.position.set(c + 0.5, r + 1 - 0.16, Z.pads);
        levelGroup.add(m);
        const top = new THREE.Mesh(padGeo, padTopMat);
        top.scale.set(1, 0.05, 1);
        top.position.set(c + 0.5, r + 1, Z.pads + 0.1);
        levelGroup.add(top);
      }
    }

    // Start beacon: a column of faint light over the spawn.
    beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COLORS.mine, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    beacon.scale.set(1.4, 7, 1);
    beacon.position.set(lv.spawn.x, lv.spawn.y + 2.6, Z.beacon);
    levelGroup.add(beacon);

    // The goal: a gold doorway that breathes.
    goal = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 48), new THREE.MeshBasicMaterial({ color: COLORS.gold, transparent: true }));
    ring.scale.set(1, 1.35, 1);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COLORS.gold, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.set(3.4, 3.8, 1);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COLORS.gold, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(0.9, 1.2, 1);
    goal.add(halo, ring, core);
    goal.position.set(lv.goal.x, lv.goal.y + 0.62, Z.pads + 0.5);
    goal.userData = { ring, halo, core };
    levelGroup.add(goal);

    reveal = buildReveal(lv);
    reveal.position.z = Z.reveal;
    reveal.userData.always = revealAlways;
    setReveal(revealAlways ? 1 : 0);
    levelGroup.add(reveal);
  }

  function buildReveal(level) {
    const group = new THREE.Group();
    const solid = [];
    const haz = [];
    const quad = (list, x0, y0, x1, y1) => list.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
    for (let r = 0; r < level.h; r++) {
      for (let c = 0; c < level.w; c++) {
        const k = r * level.w + c;
        if (level.solid[k] && !level.visible[k]) quad(solid, c + 0.04, r + 0.04, c + 0.96, r + 0.96);
        const h = level.hazard[k];
        if (!h) continue;
        const [x0, y0, x1, y1] = HAZARD_BOX[h];
        if (h === 2) haz.push(c + x0, r + y0, 0, c + x1, r + y0, 0, c + 0.5, r + y1, 0);
        else if (h === 3) haz.push(c + x0, r + y1, 0, c + 0.5, r + y0, 0, c + x1, r + y1, 0);
        else {
          const cx = c + 0.5;
          const cy = r + 0.5;
          const rr = (x1 - x0) / 2;
          for (let i = 0; i < 12; i++) {
            const a0 = (i / 12) * Math.PI * 2;
            const a1 = ((i + 1) / 12) * Math.PI * 2;
            const spike = i % 2 ? rr : rr * 0.72;
            haz.push(cx, cy, 0, cx + Math.cos(a0) * spike, cy + Math.sin(a0) * spike, 0, cx + Math.cos(a1) * spike, cy + Math.sin(a1) * spike, 0);
          }
        }
      }
    }
    for (const [list, color] of [[solid, COLORS.revealSolid], [haz, COLORS.revealHazard]]) {
      if (!list.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      group.add(m);
    }
    return group;
  }

  function setReveal(amount) {
    if (!reveal) return;
    const a = reveal.userData.always ? Math.max(amount, 0.75) : amount;
    reveal.visible = a > 0.001;
    reveal.children.forEach((m, i) => (m.material.opacity = a * (i === 0 ? 0.55 : 0.9)));
  }

  // ── framing. The level fits the safe area (between the HUD and the phone pad); if it's too wide for
  // that at a playable size, the camera follows the player along x instead.
  const frame = { w: 1, h: 1, ppu: 30, cx: 0, cy: 0, follow: false, viewW: 0, insets: { top: 56, bottom: 24, side: 12 }, overview: false };

  function resize(w, h) {
    renderer.setSize(w, h, false);
    frame.w = w;
    frame.h = h;
  }

  function setInsets(insets) {
    Object.assign(frame.insets, insets);
  }

  function updateCamera(dt, focus) {
    if (!lv) return;
    const { top, bottom, side } = frame.insets;
    const safeW = Math.max(100, frame.w - side * 2);
    const safeH = Math.max(100, frame.h - top - bottom);
    const worldW = lv.w + 1;
    const worldH = lv.h + 2.2;
    const fitAll = Math.min(safeW / worldW, safeH / worldH);
    const tall = safeH / worldH;
    // Follow when fitting the whole width would make tiles smaller than ~70% of the height fit. The replay
    // (overview) shows the whole level when it can, else follows at a middle zoom, about 16 tiles across.
    frame.follow = fitAll < tall * 0.7;
    frame.ppu = !frame.follow ? fitAll : frame.overview ? Math.max(fitAll, Math.min(tall, safeW / 16)) : tall;
    const halfW = safeW / frame.ppu / 2;
    const cy = lv.h / 2 - 0.6;
    let cx = lv.w / 2;
    if (frame.follow && focus) {
      const want = Math.min(lv.w + 0.5 - halfW, Math.max(-0.5 + halfW, focus.x + focus.lead));
      frame.cx = frame.cx ? frame.cx + (want - frame.cx) * Math.min(1, dt * 6) : want;
      cx = frame.cx;
    } else {
      frame.cx = 0;
    }
    frame.viewW = halfW * 2;
    // Safe-rect centre in pixels, and the camera box that puts (cx, cy) there.
    const sx = side + safeW / 2;
    const sy = top + safeH / 2;
    const ppu = frame.ppu;
    camera.left = cx - sx / ppu;
    camera.right = camera.left + frame.w / ppu;
    camera.top = cy + sy / ppu;
    camera.bottom = camera.top - frame.h / ppu;
    camera.updateProjectionMatrix();
  }

  function snapCamera() {
    frame.cx = 0;
  }

  /** World → CSS pixels (for DOM bits that sit over the level). */
  function toScreen(x, y) {
    return { x: ((x - camera.left) / (camera.right - camera.left)) * frame.w, y: ((camera.top - y) / (camera.top - camera.bottom)) * frame.h };
  }

  function setPlayer(b, { visible = true } = {}) {
    player.visible = visible && !!b;
    if (!b) return;
    player.position.set(b.x, b.y + PHYS.h / 2, Z.player);
    playerMesh.scale.set(b.facing * squash.x, squash.y, 1);
  }

  function landed(hard) {
    const k = Math.min(0.35, hard / 60);
    squash.x = 1 + k;
    squash.y = 1 - k;
  }

  function jumped() {
    squash.x = 0.8;
    squash.y = 1.22;
  }

  let t = 0;
  function update(dt) {
    t += dt;
    squash.x += (1 - squash.x) * Math.min(1, dt * 14);
    squash.y += (1 - squash.y) * Math.min(1, dt * 14);
    playerGlow.material.opacity = 0.3 + Math.sin(t * 3) * 0.05;
    if (goal) {
      const { ring, halo, core } = goal.userData;
      const s = 1 + Math.sin(t * 2.2) * 0.06;
      halo.scale.set(3.4 * s, 3.8 * s, 1);
      core.material.opacity = 0.35 + Math.sin(t * 4.4) * 0.12;
      ring.rotation.z = Math.sin(t * 0.8) * 0.08;
    }
    if (beacon) beacon.material.opacity = 0.18 + Math.sin(t * 1.7) * 0.05;
    for (const s of steps) {
      if (s.t <= 0) continue;
      s.t -= dt;
      const k = Math.max(0, s.t / s.life);
      s.mesh.material.opacity = s.peak * k * k;
      if (s.t <= 0) {
        s.mesh.visible = false;
        s.key = null;
      }
    }
    for (let i = 0; i < BURST; i++) {
      if (burstLife[i] <= 0) continue;
      burstLife[i] -= dt;
      burstVel[i * 2 + 1] -= 18 * dt;
      burstPos[i * 3] += burstVel[i * 2] * dt;
      burstPos[i * 3 + 1] += burstVel[i * 2 + 1] * dt;
      if (burstLife[i] <= 0) burstPos[i * 3 + 1] = -1e5;
      if (burstLife[i] < 0.4) for (let j = 0; j < 3; j++) burstCol[i * 3 + j] *= 0.93;
    }
    burstGeo.attributes.position.needsUpdate = true;
    burstGeo.attributes.color.needsUpdate = true;
    // An orthographic camera doesn't scale points: size is in pixels, so follow the zoom.
    burstMat.size = 0.3 * frame.ppu * renderer.getPixelRatio();
  }

  function render() {
    renderer.render(scene, camera);
  }

  return {
    THREE,
    renderer,
    scene,
    camera,
    frame,
    Z,
    glowTex,
    playerTex,
    resize,
    setInsets,
    setLevel,
    setReveal,
    updateCamera,
    snapCamera,
    toScreen,
    setPlayer,
    landed,
    jumped,
    touchEdge,
    burst,
    update,
    render,
    get player() {
      return player;
    },
    get levelGroup() {
      return levelGroup;
    },
    get revealGroup() {
      return reveal;
    },
  };
}
