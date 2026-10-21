// Builds the 3D world for a level from the data in levels.js (and tears it down again).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { THEMES, COLORS } from './theme.js';
import { surfaceYAt } from './levels.js';
import { createEnemy } from './enemies.js';
import { createRng } from './rng.js';

const DEPTH = 3; // platform depth along z (the dog runs at z = 0)
const FIELD_Y = -1.2; // background lawn height for the outdoor themes

// ─────────────────────────────────────────────────────────────── helpers

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function jitterColor(hex, rng, amount = 0.06) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h + rng.range(-0.01, 0.01), hsl.s, Math.min(1, Math.max(0, hsl.l + rng.range(-amount, amount))));
  return c;
}

export function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const FONT = '"Fredoka", "Trebuchet MS", "Arial Rounded MT Bold", system-ui, sans-serif';

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
}

function mesh(geo, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

// ─────────────────────────────────────────────────────────────── environment (persistent)

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * p;
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 top;
  uniform vec3 mid;
  uniform vec3 bottom;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 col;
    if (h < 0.06) col = mix(bottom, mid, smoothstep(-0.05, 0.12, h));
    else col = mix(mid, top, smoothstep(0.12, 0.6, h));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createEnvironment(scene) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(450, 32, 16),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

  const sunTex = canvasTexture(256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.18, 'rgba(255,250,220,0.95)');
    g.addColorStop(0.3, 'rgba(255,230,180,0.35)');
    g.addColorStop(1, 'rgba(255,220,160,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, fog: false, depthWrite: false, transparent: true, toneMapped: false }));
  sunSprite.scale.set(70, 70, 1);
  sunSprite.renderOrder = -9;
  scene.add(sunSprite);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 14;
  sun.shadow.camera.bottom = -14;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  scene.fog = new THREE.Fog(0xffffff, 40, 130);

  // drifting low-poly clouds
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, emissive: 0xffffff, emissiveIntensity: 0.25 });
  const clouds = [];
  const crng = createRng(7);
  for (let i = 0; i < 16; i++) {
    const g = new THREE.Group();
    const n = crng.int(3, 5);
    for (let j = 0; j < n; j++) {
      const r = crng.range(1.6, 3.2);
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), cloudMat);
      puff.position.set(j * 2.2 - n, crng.range(-0.4, 0.8), crng.range(-1, 1));
      puff.scale.y = 0.7;
      g.add(puff);
    }
    g.position.set(-30 + i * 15 + crng.range(-4, 4), crng.range(15, 26), crng.range(-70, -95));
    g.userData.speed = crng.range(0.2, 0.6);
    scene.add(g);
    clouds.push(g);
  }

  const env = {
    sky,
    hemi,
    sun,
    clouds,
    cloudMat,
    sunSprite,
    sunOffset: new THREE.Vector3(),
    applyTheme(theme, renderer) {
      sky.material.uniforms.top.value.setHex(theme.sky.top);
      sky.material.uniforms.mid.value.setHex(theme.sky.mid);
      sky.material.uniforms.bottom.value.setHex(theme.sky.bottom);
      scene.fog.color.setHex(theme.fog.color);
      scene.fog.near = theme.fog.near;
      scene.fog.far = theme.fog.far;
      hemi.color.setHex(theme.hemi.sky);
      hemi.groundColor.setHex(theme.hemi.ground);
      hemi.intensity = theme.hemi.intensity;
      sun.color.setHex(theme.sun.color);
      sun.intensity = theme.sun.intensity;
      env.sunOffset.set(...theme.sun.offset);
      renderer.toneMappingExposure = theme.exposure;
      const sunset = theme === THEMES.rooftops;
      cloudMat.color.setHex(sunset ? 0xffc2c8 : 0xffffff);
      cloudMat.emissive.setHex(sunset ? 0xff8a7a : 0xffffff);
      cloudMat.emissiveIntensity = sunset ? 0.35 : 0.25;
      sunSprite.material.color.setHex(sunset ? 0xffb070 : 0xffffff);
      sunSprite.scale.setScalar(sunset ? 120 : 70);
      env.sunSky = sunset ? new THREE.Vector3(-60, 18, -300) : new THREE.Vector3(-140, 130, -300);
    },
    /** keep sky + shadow frustum centred on the action */
    follow(camera, focus, dt) {
      sky.position.copy(camera.position);
      sunSprite.position.copy(camera.position).add(env.sunSky || new THREE.Vector3(-140, 130, -300));
      sun.position.set(focus.x + env.sunOffset.x, focus.y + env.sunOffset.y, env.sunOffset.z);
      sun.target.position.set(focus.x, focus.y, 0);
      for (const c of clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > focus.x + 140) c.position.x -= 240;
        if (c.position.x < focus.x - 100) c.position.x += 240;
      }
    },
  };
  return env;
}

// ─────────────────────────────────────────────────────────────── platforms

// Tile factories. Each call makes a fresh geometry + material so every tile can get its own
// "hand-painted" colour jitter (see the GLITCHLESS-DEMO note in buildGroundPlatform).
function makeTile(w, h, d, color, opts) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  return mesh(geo, mat, opts);
}

let dirtTex = null;
function getDirtTexture() {
  if (dirtTex) return dirtTex;
  dirtTex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const r = createRng(11);
    for (let i = 0; i < 14; i++) {
      const x = r.range(0, w);
      const y = r.range(0, h);
      const rad = r.range(2.5, 6);
      ctx.fillStyle = r.chance(0.6) ? 'rgba(60,30,10,0.14)' : 'rgba(255,240,220,0.12)';
      ctx.beginPath();
      ctx.ellipse(x, y, rad, rad * 0.7, r.range(0, 3), 0, Math.PI * 2);
      ctx.fill();
    }
  });
  dirtTex.wrapS = dirtTex.wrapT = THREE.RepeatWrapping;
  return dirtTex;
}

/** box with world-scale UVs (so textures tile instead of stretch) and a dark-at-the-bottom gradient */
function shadedBox(w, h, d, bottomDarken = 0.7) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, uv.getX(i) * w * 0.5, uv.getY(i) * h * 0.5);
    const t = (pos.getY(i) + h / 2) / h; // 0 bottom .. 1 top
    const k = Math.max(0.0, 1 - bottomDarken * Math.min(1, ((1 - t) * h) / 4));
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function makeDirtTile(w, h, d, color, opts) {
  const geo = shadedBox(w, h, d);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.95, vertexColors: true, map: getDirtTexture() });
  return mesh(geo, mat, opts);
}

function makeRoundedTile(w, h, d, color, opts) {
  const geo = new RoundedBoxGeometry(w, h, d, 2, 0.08);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  return mesh(geo, mat, opts);
}

function buildGroundPlatform(p, theme, rng, isPark) {
  const g = new THREE.Group();
  const n = Math.ceil(p.w - 1e-6);
  // GLITCHLESS-DEMO: geometry leak on level change (part 1/2) — every 1-unit tile builds its own
  // geometry + material (grass + dirt here, roof + wall in buildRoofPlatform) instead of sharing
  // one, so each level build adds hundreds of GPU geometries (and unloadLevel never frees them).
  for (let i = 0; i < n; i++) {
    const tw = Math.min(1, p.w - i);
    const cx = p.x + i + tw / 2;
    const stripe = isPark ? Math.floor(i / 2) % 2 : i % 2;
    const grass = makeRoundedTile(tw + 0.001, 0.42, DEPTH + 0.2, jitterColor(theme.grass[stripe], rng, 0.025), { cast: false });
    grass.position.set(cx, p.y - 0.19, 0);
    g.add(grass);
    const dirtH = p.h - 0.35;
    const dirt = makeDirtTile(tw, dirtH, DEPTH, jitterColor(theme.dirt[(i + 1) % 2], rng, 0.03), { cast: false });
    dirt.position.set(cx, p.y - 0.35 - dirtH / 2, 0);
    g.add(dirt);
  }
  return g;
}

let windowTex = null;
function getWindowTexture() {
  if (windowTex) return windowTex;
  windowTex = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const r = createRng(42);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const lit = r.chance(0.45);
        ctx.fillStyle = lit ? '#ffd27a' : '#3b3360';
        ctx.fillRect(x * 128 + 30, y * 128 + 26, 68, 80);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x * 128 + 30, y * 128 + 26, 68, 10);
        ctx.fillStyle = '#e8dff0';
        ctx.fillRect(x * 128 + 24, y * 128 + 104, 80, 8);
      }
    }
  });
  windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
  return windowTex;
}

function buildRoofPlatform(p, theme, rng) {
  const g = new THREE.Group();
  const n = Math.ceil(p.w - 1e-6);
  const brick = theme.brick[rng.int(0, theme.brick.length - 1)];
  for (let i = 0; i < n; i++) {
    const tw = Math.min(1, p.w - i);
    const cx = p.x + i + tw / 2;
    const roof = makeTile(tw + 0.001, 0.3, DEPTH, jitterColor(theme.roof[i % 2], rng, 0.02), { cast: false });
    roof.position.set(cx, p.y - 0.15, 0);
    g.add(roof);
    const wallH = p.h - 0.3;
    const wall = makeDirtTile(tw, wallH, DEPTH - 0.1, jitterColor(brick, rng, 0.03), { cast: false });
    wall.position.set(cx, p.y - 0.3 - wallH / 2, -0.05);
    g.add(wall);
  }
  // trim along the roof edge
  const trim = mesh(new THREE.BoxGeometry(p.w + 0.2, 0.22, 0.25), std(theme.trim, { roughness: 0.6 }), { cast: false });
  trim.position.set(p.x + p.w / 2, p.y - 0.12, DEPTH / 2);
  g.add(trim);
  // back parapet
  const parapet = mesh(new THREE.BoxGeometry(p.w, 0.5, 0.25), std(jitterColor(brick, rng, 0.05)), { cast: true });
  parapet.position.set(p.x + p.w / 2, p.y + 0.25, -DEPTH / 2 + 0.12);
  g.add(parapet);
  // windows facade
  const facadeH = p.h - 1.0;
  const facadeGeo = new THREE.PlaneGeometry(p.w - 0.4, facadeH);
  const uv = facadeGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ((p.w - 0.4) / 2.2), uv.getY(i) * (facadeH / 2.4));
  const facade = new THREE.Mesh(
    facadeGeo,
    new THREE.MeshStandardMaterial({ map: getWindowTexture(), transparent: true, emissive: 0xffb860, emissiveMap: getWindowTexture(), emissiveIntensity: 0.5, roughness: 0.6 }),
  );
  facade.position.set(p.x + p.w / 2, p.y - 0.8 - facadeH / 2, DEPTH / 2 + 0.01);
  facade.receiveShadow = true;
  g.add(facade);
  return g;
}

let crateTex = null;
function getCrateTexture() {
  if (crateTex) return crateTex;
  crateTex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#c98b4f';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#b07440';
    for (let y = 0; y < h; y += 32) ctx.fillRect(0, y + 28, w, 4);
    ctx.strokeStyle = '#8a5530';
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.beginPath();
    ctx.moveTo(10, 10);
    ctx.lineTo(w - 10, h - 10);
    ctx.stroke();
  });
  return crateTex;
}

function buildPropPlatform(p, theme, rng) {
  const g = new THREE.Group();
  const cx = p.x + p.w / 2;
  if (p.kind === 'crate') {
    const crate = mesh(new THREE.BoxGeometry(p.w, p.h, 1.6), new THREE.MeshStandardMaterial({ map: getCrateTexture(), roughness: 0.9 }));
    crate.position.set(cx, p.y - p.h / 2, 0);
    g.add(crate);
  } else if (p.kind === 'plank' || p.kind === 'scaffold') {
    const wood = new THREE.MeshStandardMaterial({ color: p.kind === 'scaffold' ? 0x8f8aa3 : 0xb7794a, roughness: 0.8 });
    const plank = mesh(new RoundedBoxGeometry(p.w, p.h, 1.8, 2, 0.08), wood);
    plank.position.set(cx, p.y - p.h / 2, 0);
    g.add(plank);
    const stripe = mesh(new THREE.BoxGeometry(p.w * 0.98, 0.06, 1.82), std(p.kind === 'scaffold' ? 0xffc83d : 0x9a6238));
    stripe.position.set(cx, p.y - p.h * 0.55, 0);
    g.add(stripe);
    // ropes up out of frame
    const rope = std(0x5a4a3a);
    for (const dx of [-p.w / 2 + 0.25, p.w / 2 - 0.25]) {
      const r = mesh(new THREE.CylinderGeometry(0.03, 0.03, 20, 5), rope, { cast: false });
      r.position.set(cx + dx, p.y + 10, -0.6);
      g.add(r);
    }
  } else if (p.kind === 'bench') {
    const wood = std(0xc0703f, { roughness: 0.7 });
    const iron = std(0x2f3340, { roughness: 0.4, metalness: 0.5 });
    const seat = mesh(new RoundedBoxGeometry(p.w, 0.18, 1.1, 2, 0.05), wood);
    seat.position.set(cx, p.y - 0.09, 0);
    g.add(seat);
    const back = mesh(new RoundedBoxGeometry(p.w, 0.6, 0.12, 2, 0.04), wood);
    back.position.set(cx, p.y + 0.45, -0.55);
    back.rotation.x = -0.15;
    g.add(back);
    for (const dx of [-p.w / 2 + 0.2, p.w / 2 - 0.2]) {
      const leg = mesh(new THREE.BoxGeometry(0.12, p.h, 1.0), iron);
      leg.position.set(cx + dx, p.y - p.h / 2, 0);
      g.add(leg);
    }
  } else if (p.kind === 'ac') {
    const unit = mesh(new RoundedBoxGeometry(p.w, p.h, 1.4, 2, 0.06), std(0xc9cbd6, { roughness: 0.5, metalness: 0.3 }));
    unit.position.set(cx, p.y - p.h / 2, 0);
    g.add(unit);
    const fan = mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 20), std(0x55586a, { roughness: 0.4 }));
    fan.position.set(cx, p.y + 0.02, 0);
    g.add(fan);
    g.userData.fan = fan;
  }
  return g;
}

function buildMoverMesh(m, theme, rng) {
  const g = new THREE.Group();
  if (theme === THEMES.rooftops) {
    const plank = mesh(new RoundedBoxGeometry(m.w, m.h, 1.8, 2, 0.08), std(0x8f8aa3, { roughness: 0.5, metalness: 0.4 }));
    plank.position.set(m.w / 2, -m.h / 2, 0);
    g.add(plank);
    return g;
  }
  // floating lawn islands
  const top = mesh(new RoundedBoxGeometry(m.w, 0.4, 1.9, 2, 0.12), std(jitterColor(theme.grass[0], rng, 0.03), { roughness: 0.8 }));
  top.position.set(m.w / 2, -0.2, 0);
  g.add(top);
  const rock = mesh(new THREE.ConeGeometry(m.w * 0.48, 1.4, 7), std(theme.dirt[0], { flatShading: true }));
  rock.rotation.x = Math.PI;
  rock.position.set(m.w / 2, -1.05, 0);
  g.add(rock);
  const trim = mesh(new THREE.BoxGeometry(m.w * 0.9, 0.08, 1.95), std(COLORS.pink, { roughness: 0.4, emissive: COLORS.pink, emissiveIntensity: 0.2 }));
  trim.position.set(m.w / 2, -0.38, 0);
  g.add(trim);
  return g;
}

// ─────────────────────────────────────────────────────────────── decor

function makeTree(rng, theme, scale = 1) {
  const g = new THREE.Group();
  const h = rng.range(1.6, 2.6) * scale;
  const trunk = mesh(new THREE.CylinderGeometry(0.16 * scale, 0.24 * scale, h, 6), std(theme.trunk, { flatShading: true }));
  trunk.position.y = h / 2;
  g.add(trunk);
  const leafColor = rng.pick(theme.leaves);
  const leaves = std(leafColor, { flatShading: true, roughness: 0.9 });
  const n = rng.int(2, 3);
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.9, 1.4) * scale;
    const c = mesh(new THREE.IcosahedronGeometry(r, 0), leaves);
    c.position.set(rng.range(-0.5, 0.5) * scale, h + r * 0.6 + i * 0.45 * scale, rng.range(-0.4, 0.4) * scale);
    c.rotation.set(rng.range(0, 3), rng.range(0, 3), 0);
    g.add(c);
  }
  return g;
}

function makePine(rng, theme, scale = 1) {
  const g = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(0.14 * scale, 0.2 * scale, 1.2 * scale, 6), std(theme.trunk, { flatShading: true }));
  trunk.position.y = 0.6 * scale;
  g.add(trunk);
  const leaves = std(0x2f8f5a, { flatShading: true });
  for (let i = 0; i < 3; i++) {
    const cone = mesh(new THREE.ConeGeometry((1.3 - i * 0.3) * scale, 1.6 * scale, 7), leaves);
    cone.position.y = (1.5 + i * 0.85) * scale;
    g.add(cone);
  }
  return g;
}

function makeBush(rng, theme) {
  const g = new THREE.Group();
  const mat = std(rng.pick(theme.leaves), { flatShading: true });
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.3, 0.55);
    const b = mesh(new THREE.IcosahedronGeometry(r, 0), mat);
    b.position.set(i * 0.45 - n * 0.2, r * 0.6, rng.range(-0.2, 0.2));
    g.add(b);
  }
  return g;
}

function makeFlowers(rng, x0, x1, y) {
  const colors = [0xff7eb6, 0xffe066, 0xffffff, 0xb08cff];
  const groups = colors.map(() => []);
  for (let x = x0; x < x1; x += rng.range(0.4, 1.1)) {
    const ci = rng.int(0, colors.length - 1);
    const geo = new THREE.SphereGeometry(rng.range(0.06, 0.1), 6, 4);
    geo.translate(x, y + rng.range(0.05, 0.14), rng.range(-1.35, -0.75));
    groups[ci].push(geo);
  }
  const g = new THREE.Group();
  groups.forEach((geos, i) => {
    if (!geos.length) return;
    const m = mesh(mergeGeometries(geos), std(colors[i], { roughness: 0.6, emissive: colors[i], emissiveIntensity: 0.15 }), { cast: false });
    g.add(m);
  });
  return g;
}

function makeFence(x0, x1, y, color = 0xfaf6ef) {
  const geos = [];
  for (let x = x0 + 0.15; x < x1 - 0.1; x += 0.38) {
    const picket = new THREE.BoxGeometry(0.14, 0.95, 0.05);
    picket.translate(x, y + 0.475, -DEPTH / 2 + 0.15);
    geos.push(picket);
    const tip = new THREE.ConeGeometry(0.1, 0.14, 4);
    tip.rotateY(Math.PI / 4);
    tip.translate(x, y + 1.0, -DEPTH / 2 + 0.15);
    geos.push(tip);
  }
  for (const ry of [0.3, 0.72]) {
    const rail = new THREE.BoxGeometry(x1 - x0 - 0.1, 0.09, 0.05);
    rail.translate((x0 + x1) / 2, y + ry, -DEPTH / 2 + 0.11);
    geos.push(rail);
  }
  const nonIndexed = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  return mesh(mergeGeometries(nonIndexed), std(color, { roughness: 0.7 }));
}

function makeHydrant() {
  const g = new THREE.Group();
  const red = std(0xe2453c, { roughness: 0.45 });
  const body = mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.6, 12), red);
  body.position.y = 0.3;
  g.add(body);
  const cap = mesh(new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), red);
  cap.position.y = 0.6;
  g.add(cap);
  const nub = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8), std(0xc9372f));
  nub.rotation.z = Math.PI / 2;
  nub.position.y = 0.4;
  g.add(nub);
  const base = mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.08, 12), red);
  base.position.y = 0.04;
  g.add(base);
  return g;
}

function makeLamp() {
  const g = new THREE.Group();
  const iron = std(0x2b2d3a, { roughness: 0.4, metalness: 0.6 });
  const pole = mesh(new THREE.CylinderGeometry(0.07, 0.1, 3.4, 8), iron);
  pole.position.y = 1.7;
  g.add(pole);
  const globe = mesh(new THREE.SphereGeometry(0.28, 12, 10), new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe6a8, emissiveIntensity: 1.2 }), { cast: false });
  globe.position.y = 3.55;
  g.add(globe);
  return g;
}

function makeDoghouse() {
  const g = new THREE.Group();
  const walls = mesh(new THREE.BoxGeometry(1.7, 1.2, 1.4), std(0xe0574a, { roughness: 0.7 }));
  walls.position.y = 0.6;
  g.add(walls);
  const roofMat = std(0x3b3f5c, { roughness: 0.6 });
  for (const s of [-1, 1]) {
    const roof = mesh(new THREE.BoxGeometry(1.25, 0.12, 1.6), roofMat);
    roof.position.set(0.42 * s, 1.5, 0);
    roof.rotation.z = -0.65 * s;
    g.add(roof);
  }
  const gable = new THREE.Shape();
  gable.moveTo(-0.85, 0);
  gable.lineTo(0.85, 0);
  gable.lineTo(0, 0.62);
  gable.closePath();
  const gableMesh = mesh(new THREE.ExtrudeGeometry(gable, { depth: 1.4, bevelEnabled: false }), std(0xe0574a));
  gableMesh.position.set(0, 1.2, -0.7);
  g.add(gableMesh);
  const doorMat = std(0x1c1424);
  const arch = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 16, 1, false, -Math.PI / 2, Math.PI), doorMat, { cast: false });
  arch.rotation.x = -Math.PI / 2;
  arch.position.set(0, 0.6, 0.71);
  g.add(arch);
  const doorRect = mesh(new THREE.BoxGeometry(0.76, 0.6, 0.05), doorMat, { cast: false });
  doorRect.position.set(0, 0.3, 0.71);
  g.add(doorRect);
  const plate = mesh(new THREE.BoxGeometry(0.7, 0.18, 0.05), std(COLORS.pink, { emissive: COLORS.pink, emissiveIntensity: 0.2 }), { cast: false });
  plate.position.set(0, 1.0, 0.73);
  g.add(plate);
  return g;
}

function makeHouse(rng) {
  const g = new THREE.Group();
  const wall = std(0xfff1dc, { roughness: 0.9 });
  const body = mesh(new THREE.BoxGeometry(10, 6, 6), wall);
  body.position.y = 3;
  g.add(body);
  const roofMat = std(0x7a4b8c, { roughness: 0.7, flatShading: true });
  const tri = new THREE.Shape();
  tri.moveTo(-5.8, 0);
  tri.lineTo(5.8, 0);
  tri.lineTo(0, 3.2);
  tri.closePath();
  const roof = mesh(new THREE.ExtrudeGeometry(tri, { depth: 6.8, bevelEnabled: false }), roofMat);
  roof.position.set(0, 6, -3.4);
  g.add(roof);
  const chimney = mesh(new THREE.BoxGeometry(0.9, 2.4, 0.9), std(0xb85d4c));
  chimney.position.set(3, 8, -1);
  g.add(chimney);
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x6fb8ff, emissiveIntensity: 0.35, roughness: 0.2 });
  const frame = std(0xffffff);
  for (const [x, y] of [
    [-3, 4.3],
    [0, 4.3],
    [3, 4.3],
    [-3, 1.7],
    [3, 1.7],
  ]) {
    const f = mesh(new THREE.BoxGeometry(1.5, 1.5, 0.1), frame, { cast: false });
    f.position.set(x, y, 3.02);
    g.add(f);
    const w = mesh(new THREE.BoxGeometry(1.2, 1.2, 0.12), glass, { cast: false });
    w.position.set(x, y, 3.03);
    g.add(w);
  }
  const door = mesh(new THREE.BoxGeometry(1.3, 2.3, 0.12), std(0x6a3fa0), { cast: false });
  door.position.set(0, 1.15, 3.03);
  g.add(door);
  return g;
}

function makeSign(text, color = '#7a4b2a') {
  const g = new THREE.Group();
  const tex = canvasTexture(512, 160, (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    for (let y = 0; y < h; y += 40) ctx.fillRect(0, y + 36, w, 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    let size = 76;
    ctx.font = `700 ${size}px ${FONT}`;
    while (ctx.measureText(text).width > w - 50 && size > 20) {
      size -= 4;
      ctx.font = `700 ${size}px ${FONT}`;
    }
    ctx.fillStyle = '#fff8ea';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 4);
  });
  const board = mesh(new THREE.BoxGeometry(2.4, 0.75, 0.1), [
    std(0x6a3f22),
    std(0x6a3f22),
    std(0x6a3f22),
    std(0x6a3f22),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }),
    std(0x6a3f22),
  ]);
  board.position.y = 1.35;
  g.add(board);
  const post = std(0x5a3a22);
  for (const dx of [-0.8, 0.8]) {
    const p = mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), post);
    p.position.set(dx, 0.7, -0.08);
    g.add(p);
  }
  return g;
}

function makeChimney(rng, theme) {
  const g = new THREE.Group();
  const h = rng.range(0.9, 1.6);
  const c = mesh(new THREE.BoxGeometry(0.7, h, 0.7), std(jitterColor(theme.brick[0], rng, 0.08)));
  c.position.y = h / 2;
  g.add(c);
  const cap = mesh(new THREE.BoxGeometry(0.85, 0.14, 0.85), std(0x4a4458));
  cap.position.y = h + 0.07;
  g.add(cap);
  return g;
}

function makeWaterTower() {
  const g = new THREE.Group();
  const wood = std(0x9a5f3a, { roughness: 0.9 });
  const legs = std(0x3a3448, { metalness: 0.4, roughness: 0.5 });
  for (const [x, z] of [
    [-0.7, -0.5],
    [0.7, -0.5],
    [-0.7, 0.5],
    [0.7, 0.5],
  ]) {
    const l = mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), legs);
    l.position.set(x, 0.8, z);
    g.add(l);
  }
  const tank = mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.8, 14), wood);
  tank.position.y = 2.5;
  g.add(tank);
  const roof = mesh(new THREE.ConeGeometry(1.1, 0.8, 14), std(0x3a3448, { roughness: 0.6 }));
  roof.position.y = 3.8;
  g.add(roof);
  return g;
}

function makeAntenna() {
  const g = new THREE.Group();
  const metal = std(0x6b6880, { metalness: 0.6, roughness: 0.4 });
  const mast = mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.6, 6), metal);
  mast.position.y = 1.3;
  g.add(mast);
  for (let i = 0; i < 3; i++) {
    const bar = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9 - i * 0.2, 4), metal);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 1.8 + i * 0.3;
    g.add(bar);
  }
  const blink = mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff4060, emissive: 0xff2040, emissiveIntensity: 2 }), { cast: false });
  blink.position.y = 2.65;
  g.add(blink);
  return g;
}

function makeSkyline(rng, theme, x0, x1, z, hMin, hMax, colorIdx, glow) {
  const g = new THREE.Group();
  const tex = getWindowTexture();
  let x = x0;
  while (x < x1) {
    const w = rng.range(4, 9);
    const h = rng.range(hMin, hMax);
    const geo = new THREE.BoxGeometry(w, h, 6);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 2.6), uv.getY(i) * (h / 2.6));
    const mat = new THREE.MeshStandardMaterial({
      color: jitterColor(theme.skyline[colorIdx], rng, 0.04),
      emissive: 0xffc27a,
      emissiveMap: tex,
      emissiveIntensity: glow,
      roughness: 0.9,
    });
    const b = mesh(geo, mat, { cast: false, receive: false });
    b.position.set(x + w / 2, -14 + h / 2, z + rng.range(-3, 3));
    g.add(b);
    x += w + rng.range(0.5, 3);
  }
  return g;
}

function makeHills(rng, theme, x0, x1) {
  const g = new THREE.Group();
  for (let x = x0; x < x1; x += rng.range(14, 26)) {
    const r = rng.range(14, 26);
    const hill = mesh(new THREE.IcosahedronGeometry(r, 1), std(rng.pick(theme.hills), { flatShading: true, roughness: 1 }), { cast: false });
    hill.scale.set(1.6, rng.range(0.35, 0.55), 1);
    hill.position.set(x, FIELD_Y - 2, rng.range(-70, -95));
    g.add(hill);
  }
  return g;
}

// ─────────────────────────────────────────────────────────────── collectibles

function makeBoneGeometry() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.075, 0.075, 0.5, 10);
  shaft.rotateZ(Math.PI / 2);
  parts.push(shaft);
  for (const x of [-0.27, 0.27]) {
    for (const y of [-0.075, 0.075]) {
      const knob = new THREE.SphereGeometry(0.105, 12, 8);
      knob.translate(x, y, 0);
      parts.push(knob);
    }
  }
  return mergeGeometries(parts);
}

class SeamCurve extends THREE.Curve {
  constructor(r) {
    super();
    this.r = r;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const th = t * Math.PI * 2;
    const a = 0.62;
    const b = 0.38;
    const x = a * Math.cos(th) + b * Math.cos(3 * th);
    const y = a * Math.sin(th) - b * Math.sin(3 * th);
    const z = 2 * Math.sqrt(a * b) * Math.sin(2 * th);
    return target.set(x, y, z).multiplyScalar(this.r);
  }
}

function makeTennisBall() {
  const g = new THREE.Group();
  const ball = mesh(new THREE.SphereGeometry(0.32, 24, 16), new THREE.MeshStandardMaterial({ color: COLORS.ball, roughness: 0.75, emissive: 0x6a7a00, emissiveIntensity: 0.25 }));
  g.add(ball);
  const seam = mesh(new THREE.TubeGeometry(new SeamCurve(0.322), 80, 0.022, 6, true), std(0xffffff, { roughness: 0.6 }), { cast: false });
  g.add(seam);
  return g;
}

let glowTex = null;
function getGlowTexture() {
  if (glowTex) return glowTex;
  glowTex = canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  return glowTex;
}

function makeGlow(color, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.set(size, size, 1);
  return s;
}

let pawTex = null;
function getFlagTexture() {
  if (pawTex) return pawTex;
  pawTex = canvasTexture(256, 160, (ctx, w, h) => {
    ctx.fillStyle = '#632CA6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#E0457B';
    ctx.fillRect(0, h - 22, w, 22);
    ctx.fillStyle = '#ffffff';
    const cx = w * 0.5;
    const cy = h * 0.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 14, 30, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const [dx, dy] of [
      [-34, -14],
      [-12, -34],
      [12, -34],
      [34, -14],
    ]) {
      ctx.beginPath();
      ctx.ellipse(cx + dx, cy + dy, 11, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return pawTex;
}

function makeGoal() {
  const g = new THREE.Group();
  const pole = mesh(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 10), std(0xf4f1fa, { roughness: 0.4, metalness: 0.3 }));
  pole.position.y = 2.1;
  g.add(pole);
  const knob = mesh(new THREE.SphereGeometry(0.16, 14, 10), std(COLORS.gold, { metalness: 0.7, roughness: 0.25, emissive: 0x7a5200, emissiveIntensity: 0.4 }));
  knob.position.y = 4.3;
  g.add(knob);
  const flagGeo = new THREE.PlaneGeometry(1.7, 1.05, 14, 6);
  flagGeo.translate(0.85, 0, 0);
  const flag = mesh(flagGeo, new THREE.MeshStandardMaterial({ map: getFlagTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
  flag.position.set(0.08, 3.6, 0);
  g.add(flag);
  // a big bowl of kibble at the finish
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(0.55 + t * 0.25, t * 0.42));
  }
  pts.push(new THREE.Vector2(0.72, 0.42));
  pts.push(new THREE.Vector2(0.5, 0.06));
  pts.push(new THREE.Vector2(0.0, 0.06));
  const bowl = mesh(new THREE.LatheGeometry(pts, 24), std(COLORS.pink, { roughness: 0.35, side: THREE.DoubleSide }));
  bowl.position.set(1.2, 0, 0.4);
  g.add(bowl);
  const kib = [];
  const r = createRng(3);
  for (let i = 0; i < 40; i++) {
    const k = new THREE.IcosahedronGeometry(0.08, 0);
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * 0.6;
    k.translate(Math.cos(a) * d, 0.38 + r.range(0, 0.12) - d * 0.12, Math.sin(a) * d);
    kib.push(k);
  }
  const kibble = mesh(mergeGeometries(kib), std(0x9a5a2e, { flatShading: true }));
  kibble.position.copy(bowl.position);
  g.add(kibble);
  const glow = makeGlow(0xc9a0ff, 3.5);
  glow.position.set(0.9, 3.6, -0.1);
  g.add(glow);
  g.userData = { flag, base: flagGeo.attributes.position.array.slice() };
  return g;
}

function makeCheckpoint() {
  const g = new THREE.Group();
  const pole = mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.9, 8), std(0xe9e4f2, { roughness: 0.5 }));
  pole.position.y = 0.95;
  g.add(pole);
  const flagMat = new THREE.MeshStandardMaterial({ color: 0x8b8fa3, side: THREE.DoubleSide, roughness: 0.7 });
  const flagGeo = new THREE.PlaneGeometry(0.75, 0.48, 6, 3);
  flagGeo.translate(0.375, 0, 0);
  const flag = mesh(flagGeo, flagMat);
  flag.position.set(0.05, 0.75, 0);
  g.add(flag);
  const base = mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.12, 12), std(0x6b6880));
  base.position.y = 0.06;
  g.add(base);
  g.userData = { flag, flagMat };
  return g;
}

// ─────────────────────────────────────────────────────────────── level build / unload

export function buildLevel(scene, level) {
  const theme = THEMES[level.theme];
  const rng = createRng(hashString(level.id));
  const objects = [];
  const add = (obj) => {
    scene.add(obj);
    objects.push(obj);
    return obj;
  };
  const isOutdoor = level.theme !== 'rooftops';

  // physics solids (copies so we can mutate movers) + an invisible wall at the start
  const statics = level.platforms.map((p) => ({ ...p }));
  const minX = Math.min(...statics.map((p) => p.x));
  const maxX = Math.max(...statics.map((p) => p.x + p.w));
  statics.push({ x: minX - 1, y: 60, w: 1, h: 120, kind: 'wall' });
  const movers = level.movers.map((m) => ({ ...m, x0: m.x, y0: m.y, dx: 0, dy: 0 }));

  // visuals: platforms
  const fans = [];
  for (const p of level.platforms) {
    let g;
    if (p.kind === 'ground') g = buildGroundPlatform(p, theme, rng, level.theme === 'park');
    else if (p.kind === 'roof') g = buildRoofPlatform(p, theme, rng);
    else g = buildPropPlatform(p, theme, rng);
    add(g);
    if (g.userData.fan) fans.push(g.userData.fan);
  }
  for (const m of movers) {
    m.mesh = add(buildMoverMesh(m, theme, rng));
    m.mesh.position.set(m.x, m.y, 0);
  }

  // backdrop
  if (isOutdoor) {
    const field = mesh(new THREE.PlaneGeometry(maxX - minX + 260, 220), std(theme.field, { roughness: 1 }), { cast: false });
    field.rotation.x = -Math.PI / 2;
    field.position.set((minX + maxX) / 2, FIELD_Y, -DEPTH / 2 - 110);
    add(field);
    const backWall = mesh(new THREE.BoxGeometry(maxX - minX + 20, 14, 0.5), std(theme.backWall, { roughness: 1 }), { cast: false });
    backWall.position.set((minX + maxX) / 2, FIELD_Y - 7, -DEPTH / 2 - 0.25);
    add(backWall);
    add(makeHills(rng, theme, minX - 60, maxX + 80));
    // trees on the lawn behind the play lane
    for (let x = minX - 10; x < maxX + 20; x += rng.range(3.5, 7.5)) {
      const pine = level.theme === 'backyard' && rng.chance(0.25);
      const t = pine ? makePine(rng, theme, rng.range(1, 1.5)) : makeTree(rng, theme, rng.range(1, 1.5));
      t.position.set(x, FIELD_Y, rng.range(-5, -16));
      t.rotation.y = rng.range(0, Math.PI * 2);
      add(t);
    }
    if (level.theme === 'park') {
      for (let x = minX + 6; x < maxX; x += rng.range(14, 20)) {
        const lamp = makeLamp();
        lamp.position.set(x, FIELD_Y, -3.2);
        add(lamp);
      }
    }
  } else {
    const street = mesh(new THREE.PlaneGeometry(maxX - minX + 300, 300), std(0x2a2140, { roughness: 1 }), { cast: false });
    street.rotation.x = -Math.PI / 2;
    street.position.set((minX + maxX) / 2, -14, -100);
    add(street);
    add(makeSkyline(rng, theme, minX - 60, maxX + 80, -20, 6, 11, 2, 0.22));
    add(makeSkyline(rng, theme, minX - 80, maxX + 100, -45, 11, 19, 1, 0.4));
    add(makeSkyline(rng, theme, minX - 120, maxX + 140, -85, 16, 30, 0, 0.6));
  }

  // per-platform dressing (keep signs and checkpoints readable)
  const keepClear = [...(level.signs || []).map((s) => s.x), ...level.checkpoints.map((c) => c.x), level.goal.x];
  const clear = (x) => keepClear.every((k) => Math.abs(k - x) > 1.8);
  for (const p of level.platforms) {
    if (p.kind === 'ground') {
      if (p.w > 6 && level.theme === 'backyard' && rng.chance(0.6)) add(makeFence(p.x + 0.2, p.x + p.w - 0.2, p.y));
      add(makeFlowers(rng, p.x + 0.3, p.x + p.w - 0.3, p.y));
      for (let x = p.x + rng.range(1, 3); x < p.x + p.w - 1; x += rng.range(4, 8)) {
        if (!clear(x)) continue;
        const b = makeBush(rng, theme);
        b.position.set(x, p.y, rng.range(-1.35, -1.1));
        add(b);
      }
      if (level.theme === 'park' && p.w > 10) {
        const h = makeHydrant();
        h.position.set(p.x + rng.range(3, p.w - 3), p.y, -0.95);
        add(h);
      }
    } else if (p.kind === 'roof') {
      for (let x = p.x + rng.range(1, 2.5); x < p.x + p.w - 1; x += rng.range(3.5, 6)) {
        const r = rng.next();
        if (!clear(x)) continue;
        let d;
        if (r < 0.4) d = makeChimney(rng, theme);
        else if (r < 0.7) d = makeAntenna();
        else d = makeBush(rng, theme);
        d.position.set(x, p.y, -1.0);
        add(d);
      }
      if (p.w > 12) {
        const wt = makeWaterTower();
        wt.position.set(p.x + p.w * 0.6, p.y, -0.6 - 0.8);
        wt.scale.setScalar(0.9);
        add(wt);
      }
    }
  }
  if (level.theme === 'backyard') {
    const house = makeHouse(rng);
    house.position.set(-9, FIELD_Y, -12);
    add(house);
    const dh = makeDoghouse();
    dh.position.set(-5.6, 0, -0.6);
    add(dh);
  }
  for (const s of level.signs || []) {
    const sign = makeSign(s.text, level.theme === 'rooftops' ? '#4b3a78' : '#7a4b2a');
    sign.position.set(s.x, surfaceYAt(level, s.x), -1.05);
    add(sign);
  }

  // collectibles
  const boneGeo = makeBoneGeometry();
  const boneMat = new THREE.MeshStandardMaterial({ color: COLORS.bone, roughness: 0.45, emissive: 0xfff3dc, emissiveIntensity: 0.18 });
  const goldMat = new THREE.MeshStandardMaterial({ color: COLORS.gold, roughness: 0.2, metalness: 0.75, emissive: 0xb07800, emissiveIntensity: 0.55 });
  const bones = level.bones.map((b, i) => {
    const m = mesh(boneGeo, b.golden ? goldMat : boneMat, { cast: true, receive: false });
    m.position.set(b.x, b.y, 0);
    m.rotation.z = 0.35;
    if (b.golden) {
      m.scale.setScalar(1.6);
      const glow = makeGlow(0xffd36b, 2.2);
      m.add(glow);
    }
    add(m);
    return { x: b.x, y: b.y, golden: !!b.golden, collected: false, mesh: m, phase: i * 0.6 };
  });
  const balls = level.balls.map((b, i) => {
    const m = makeTennisBall();
    m.position.set(b.x, b.y, 0);
    const glow = makeGlow(0xeaff70, 1.6);
    m.add(glow);
    add(m);
    return { x: b.x, y: b.y, collected: false, mesh: m, phase: i };
  });
  const enemies = level.enemies.map((e, i) => {
    const en = createEnemy(e, surfaceYAt(level, e.x), i * 0.37);
    add(en.mesh);
    return en;
  });
  const checkpoints = level.checkpoints.map((c) => {
    const y = surfaceYAt(level, c.x);
    const m = makeCheckpoint();
    m.position.set(c.x, y, -0.9);
    add(m);
    return { x: c.x, y, active: false, mesh: m, raise: 0 };
  });
  const goalY = surfaceYAt(level, level.goal.x);
  const goalMesh = makeGoal();
  goalMesh.position.set(level.goal.x, goalY, -0.5);
  add(goalMesh);

  return {
    level,
    theme,
    objects,
    statics,
    movers,
    solids: [...statics, ...movers],
    bones,
    balls,
    enemies,
    checkpoints,
    goal: { x: level.goal.x, y: goalY, mesh: goalMesh },
    killY: level.killY,
    fans,
    minX,
    maxX,
    t: 0,
  };
}

/** per-frame visual animation of level things */
export function animateWorld(world, dt, time) {
  for (const b of world.bones) {
    if (b.collected) continue;
    b.mesh.rotation.y = time * 2.2 + b.phase;
    b.mesh.position.y = b.y + Math.sin(time * 3 + b.phase) * 0.08;
  }
  for (const b of world.balls) {
    if (b.collected) continue;
    b.mesh.rotation.y = time * 1.5;
    b.mesh.rotation.x = time * 0.7;
    b.mesh.position.y = b.y + Math.sin(time * 2.5 + b.phase) * 0.12;
  }
  for (const m of world.movers) m.mesh.position.set(m.x, m.y, 0);
  for (const c of world.checkpoints) {
    const target = c.active ? 1 : 0;
    c.raise += (target - c.raise) * Math.min(1, dt * 5);
    const { flag } = c.mesh.userData;
    flag.position.y = 0.75 + c.raise * 0.85;
    flag.rotation.y = Math.sin(time * 4 + c.x) * 0.15;
  }
  // wave the goal flag
  const { flag, base } = world.goal.mesh.userData;
  const pos = flag.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3];
    pos.setZ(i, Math.sin(x * 3.2 - time * 6) * 0.12 * x);
  }
  pos.needsUpdate = true;
  for (const fan of world.fans) fan.rotation.y += dt * 8;
}

export function activateCheckpoint(cp) {
  cp.active = true;
  cp.mesh.userData.flagMat.color.setHex(COLORS.pink);
  cp.mesh.userData.flagMat.emissive.setHex(COLORS.pink);
  cp.mesh.userData.flagMat.emissiveIntensity = 0.3;
}

// GLITCHLESS-DEMO: geometry leak on level change (part 2/2) — meshes are removed from the scene but
// their geometries/materials/textures are never disposed, so renderer.info.memory.geometries keeps
// climbing with every level change and restart.
export function unloadLevel(world, scene) {
  for (const obj of world.objects) scene.remove(obj);
  world.objects.length = 0;
}
