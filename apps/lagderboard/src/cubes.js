// The cube storm: every cube on screen, drawn as instanced boxes in chunks of CHUNK. A cube's whole life (falling,
// one bounce, coming to rest on the mound) is worked out in the vertex shader from where and when it was spawned,
// so the CPU only writes 8 floats per new cube and the load lands on the GPU, where a device's limit is.
import * as THREE from 'three';
import { MAX_CUBES } from './rules.js';

const CHUNK = 65536;
const EMPTY = new Float32Array(0);
const SIZE = 0.55; // a cube's edge, before its per-cube 0.6..1 scale
const SLOPE = 0.85; // the mound's sides: height lost per unit out from the middle
const GRAVITY = 30;
const PACKED_VOLUME = 0.155; // space one resting cube takes in the pile (its volume over a 0.55 packing fraction)

// Glitchless mint into cyan, violet, magenta, coral and gold. Each few seconds of a run gets the next colour,
// so the mound shows its history in bands.
const PALETTE = [0x2ee6a6, 0x3dd9ff, 0x8b5cff, 0xff4fd8, 0xff6b57, 0xffc83d];

const header = /* glsl */ `
  attribute vec4 aA; // spawn x, y, z, spawn time
  attribute vec4 aB; // velocity x, y, z, height it comes to rest at
  uniform float uTime;
  varying vec3 vCubeCol;
  varying float vGlow;
  uniform vec3 uPal[6];

  mat3 lgRotate(vec3 axis, float a) {
    float s = sin(a), c = cos(a), oc = 1.0 - c;
    return mat3(
      oc * axis.x * axis.x + c, oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
      oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z + axis.x * s,
      oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c);
  }

  void lgCube(out mat3 R, out vec3 P, out float S) {
    float t = uTime - aA.w;
    float seed = fract(sin(dot(aA.xyz, vec3(12.9898, 78.233, 37.719)) + aA.w * 3.17) * 43758.5453);
    float g = ${GRAVITY.toFixed(1)};
    vec3 v = aB.xyz;
    float rest = aB.w;
    float tc = max(t, 0.0);
    float drop = max(aA.y - rest, 0.0);
    float t1 = (v.y + sqrt(v.y * v.y + 2.0 * g * drop)) / g; // when it lands
    float vb = -(v.y - g * t1) * 0.3; // bounce speed
    float t2 = 2.0 * vb / g;
    if (tc < t1) {
      P = aA.xyz + v * tc;
      P.y = aA.y + v.y * tc - 0.5 * g * tc * tc;
    } else {
      float tb = min(tc - t1, t2);
      P = aA.xyz + v * t1 + vec3(v.x, 0.0, v.z) * 0.25 * tb;
      P.y = rest + vb * tb - 0.5 * g * tb * tb;
    }
    vec3 axis = normalize(vec3(seed - 0.5, fract(seed * 7.13) - 0.5, fract(seed * 3.71) - 0.5) + 0.001);
    R = lgRotate(axis, (3.0 + seed * 6.0) * min(tc, t1 + t2) + seed * 6.2832);
    S = ${SIZE.toFixed(2)} * (0.6 + 0.4 * seed) * clamp(tc * 7.0, 0.0, 1.0) * step(0.0, t);
    float band = aA.w * 0.22 + seed * 1.2;
    int i = int(mod(floor(band), 6.0));
    vCubeCol = mix(uPal[i], uPal[int(mod(float(i) + 1.0, 6.0))], smoothstep(0.6, 1.0, fract(band)));
    vGlow = exp(-tc * 3.0);
  }
`;

function cubeMaterials(uniforms) {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${header}`)
      .replace('#include <beginnormal_vertex>', 'mat3 lgR; vec3 lgP; float lgS; lgCube(lgR, lgP, lgS);\nvec3 objectNormal = lgR * normal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = lgP + lgR * (position * lgS);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCubeCol;\nvarying float vGlow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vCubeCol;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vCubeCol * (0.1 + 1.8 * vGlow);');
  };
  material.customProgramCacheKey = () => 'lagderboard-cube';

  const depth = new THREE.MeshDepthMaterial(); // as three's own shadow depth material
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${header}`)
      .replace('#include <begin_vertex>', 'mat3 lgR; vec3 lgP; float lgS; lgCube(lgR, lgP, lgS);\nvec3 transformed = lgP + lgR * (position * lgS);');
  };
  depth.customProgramCacheKey = () => 'lagderboard-cube-depth';
  return { material, depth };
}

export class CubeStorm {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = { uTime: { value: 0 }, uPal: { value: PALETTE.map((c) => new THREE.Color(c)) } };
    const { material, depth } = cubeMaterials(this.uniforms);
    this.material = material;
    this.depth = depth;
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.chunks = [];
    this.count = 0;
  }

  // The mound's height for `n` cubes: a cone with SLOPE sides that holds them all.
  heightFor(n = this.count) {
    const volume = n * PACKED_VOLUME;
    return Math.max(1.2, Math.cbrt((3 * SLOPE * SLOPE * volume) / Math.PI));
  }

  radiusFor(n = this.count) {
    return this.heightFor(n) / SLOPE;
  }

  restAt(x, z, h) {
    return Math.max(0, h - Math.hypot(x, z) * SLOPE) + Math.random() * SIZE * 0.9;
  }

  chunk() {
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.used < CHUNK) return last;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = this.box.index;
    geometry.setAttribute('position', this.box.attributes.position);
    geometry.setAttribute('normal', this.box.attributes.normal);
    const a = new THREE.InstancedBufferAttribute(new Float32Array(CHUNK * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const b = new THREE.InstancedBufferAttribute(new Float32Array(CHUNK * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aA', a);
    geometry.setAttribute('aB', b);
    geometry.instanceCount = 0;
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'cubes';
    mesh.frustumCulled = false; // the shader moves every cube; three can't know the bounds
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.depth;
    this.scene.add(mesh);
    const c = { mesh, geometry, a: a.array, b: b.array, attrA: a, attrB: b, used: 0, dirtyFrom: -1 };
    this.chunks.push(c);
    return c;
  }

  add(x, y, z, t, vx, vy, vz, rest) {
    if (this.count >= MAX_CUBES) return false;
    const c = this.chunk();
    const i = c.used * 4;
    c.a[i] = x;
    c.a[i + 1] = Math.max(y, rest + 0.05);
    c.a[i + 2] = z;
    c.a[i + 3] = t;
    c.b[i] = vx;
    c.b[i + 1] = vy;
    c.b[i + 2] = vz;
    c.b[i + 3] = rest;
    if (c.dirtyFrom < 0) c.dirtyFrom = c.used;
    c.used++;
    this.count++;
    return true;
  }

  // n cubes dropping onto the mound. They fall from a little above where they land, not from one sky height: at
  // millions of cubes a second, a long fall would hang a solid column of cubes over the mound.
  rain(n, t) {
    const h = this.heightFor(this.count + n);
    const r = h / SLOPE;
    for (let k = 0; k < n; k++) {
      const d = r * 0.96 * Math.sqrt(Math.random());
      const ang = Math.random() * Math.PI * 2;
      const x = Math.cos(ang) * d;
      const z = Math.sin(ang) * d;
      const rest = this.restAt(x, z, h);
      const y = rest + 3 + Math.random() * (4 + h * 0.35);
      if (!this.add(x, y, z, t + Math.random() * 0.12, (Math.random() - 0.5) * 1.2, -Math.random() * 6 - h * 0.2, (Math.random() - 0.5) * 1.2, rest)) return;
    }
  }

  // n cubes thrown out of point p (a tap or an explosion), landing back on the mound.
  burst(p, n, t, speed = 9) {
    const h = this.heightFor(this.count + n);
    for (let k = 0; k < n; k++) {
      const ang = Math.random() * Math.PI * 2;
      const up = 0.35 + Math.random() * 0.65;
      const s = speed * (0.4 + Math.random() * 0.8);
      const vx = Math.cos(ang) * s * (1 - up * 0.6);
      const vz = Math.sin(ang) * s * (1 - up * 0.6);
      const vy = s * up * 1.4;
      // Where it lands: guess the flight time from the rest height under p, then once more from the landing spot.
      let rest = this.restAt(p.x, p.z, h);
      for (let pass = 0; pass < 2; pass++) {
        const tf = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(p.y - rest, 0))) / GRAVITY;
        rest = this.restAt(p.x + vx * tf, p.z + vz * tf, h);
      }
      if (!this.add(p.x, p.y, p.z, t, vx, vy, vz, rest)) return;
    }
  }

  // A point on the mound's surface: under a screen ray (taps), or at random (explosions).
  surfacePoint(ray, out) {
    const h = this.heightFor();
    const step = Math.max(0.25, h / 40);
    const p = out.copy(ray.origin);
    for (let i = 0; i < 400; i++) {
      p.addScaledVector(ray.direction, step);
      const ground = Math.max(0, h - Math.hypot(p.x, p.z) * SLOPE);
      if (p.y <= ground) {
        p.y = ground;
        return p;
      }
    }
    return null;
  }

  randomSurfacePoint(out) {
    const h = this.heightFor();
    const d = (h / SLOPE) * 0.75 * Math.sqrt(Math.random());
    const ang = Math.random() * Math.PI * 2;
    out.set(Math.cos(ang) * d, 0, Math.sin(ang) * d);
    out.y = Math.max(0, h - d * SLOPE);
    return out;
  }

  // Send this frame's new cubes to the GPU and move the clock.
  update(time) {
    this.uniforms.uTime.value = time;
    for (const c of this.chunks) {
      if (c.dirtyFrom < 0) continue;
      const from = c.dirtyFrom * 4;
      const n = (c.used - c.dirtyFrom) * 4;
      c.attrA.clearUpdateRanges();
      c.attrB.clearUpdateRanges();
      c.attrA.addUpdateRange(from, n);
      c.attrB.addUpdateRange(from, n);
      c.attrA.needsUpdate = true;
      c.attrB.needsUpdate = true;
      c.geometry.instanceCount = c.used;
      c.dirtyFrom = -1;
      // A full chunk never changes again: once its last cubes are on the GPU, drop the CPU copy (8M cubes would
      // otherwise keep 256 MB of arrays alive).
      if (c.used === CHUNK) {
        for (const attr of [c.attrA, c.attrB]) {
          attr.onUpload(function () {
            this.array = EMPTY;
            this.onUploadCallback = () => {};
          });
        }
        c.a = c.b = null;
      }
    }
  }

  get drawChunks() {
    return this.chunks.length;
  }

  clear() {
    for (const c of this.chunks) {
      this.scene.remove(c.mesh);
      // The box's index and attributes are shared by every chunk; only the per-cube buffers are freed here.
      c.geometry.deleteAttribute('position');
      c.geometry.deleteAttribute('normal');
      c.geometry.index = null;
      c.geometry.dispose();
    }
    this.chunks = [];
    this.count = 0;
  }
}
