// Death markers on screen: one Points draw of glowing X's, each popping in at its own time. Used for
// everyone else's deaths (from a marker source, as bins), your own (exact), and the replay's pops.
import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aBorn;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uScale;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float age = uTime - aBorn;
    float on = step(0.0, age);
    float pop = 1.0 + 1.8 * exp(-age * 10.0);
    vAlpha = on * uOpacity * (1.0 + 2.5 * exp(-age * 5.0));
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = on * aSize * uScale * pop;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float d = min(abs(p.x - p.y), abs(p.x + p.y)) * 0.7071;
    float arm = smoothstep(0.17, 0.07, d) * smoothstep(0.82, 0.6, r);
    float glow = exp(-r * r * 5.0) * 0.22;
    float a = (arm + glow) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, min(a, 1.0));
  }
`;

// A small stable hash, so a bin's jitter doesn't move between polls.
function hash(a, b, i) {
  let h = Math.imul((a * 73856093) ^ (b * 19349663) ^ (i * 83492791), 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  return (h >>> 0) / 4294967296;
}

export function createMarkerLayer({ capacity = 6000, color = 0xff7a3d, size = 0.5, opacity = 0.6, z = 0 } = {}) {
  const pos = new Float32Array(capacity * 3);
  const col = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const born = new Float32Array(capacity);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aBorn', new THREE.BufferAttribute(born, 1));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 }, uScale: { value: 30 }, uOpacity: { value: opacity } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.position.z = z;
  const base = new THREE.Color(color);
  let count = 0;
  let known = new Map(); // "a,b,i" → born time, so markers already shown don't pop again

  function write(i, x, y, s, b, c, bright = 1) {
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = 0;
    col[i * 3] = c.r * bright;
    col[i * 3 + 1] = c.g * bright;
    col[i * 3 + 2] = c.b * bright;
    sizes[i] = s;
    born[i] = b;
  }

  function dirty() {
    geo.setDrawRange(0, count);
    for (const k of ['position', 'aColor', 'aSize', 'aBorn']) geo.attributes[k].needsUpdate = true;
  }

  return {
    points,
    get count() {
      return count;
    },
    /** Exact markers: [{ x, y, born? }]. */
    setPoints(list, now = 0) {
      count = Math.min(list.length, capacity);
      for (let i = 0; i < count; i++) write(i, list[i].x, list[i].y, size, list[i].born ?? now - 10, base);
      dirty();
    },
    /** Add one marker now (your own death). */
    add(x, y, now) {
      if (count >= capacity) return;
      write(count, x, y, size, now, base);
      count++;
      dirty();
    },
    /**
     * Binned markers from a source: [[x, y, n], …]. A bin of n deaths shows up to `perBin` X's scattered
     * around it, hotter the more it holds than it shows. New ones pop in over a couple of seconds.
     */
    setBins(deaths, bin, now) {
      const half = Math.max((bin || 0.5) * 0.5, 0.32);
      const most = 9;
      const totalWanted = deaths.reduce((s, d) => s + Math.min(d[2], most), 0);
      const perBin = Math.max(1, Math.min(most, Math.floor((most * capacity) / Math.max(1, totalWanted))));
      const next = new Map();
      count = 0;
      for (const [a, b, n] of deaths) {
        const show = Math.min(n, perBin);
        const bright = Math.min(1.9, 1 + Math.log10(n / show) * 0.45);
        const ia = Math.round(a * 100);
        const ib = Math.round(b * 100);
        for (let i = 0; i < show && count < capacity; i++) {
          const key = `${ia},${ib},${i}`;
          const t = known.get(key) ?? (known.size ? now + hash(ia, ib, i + 7) * 2.5 : now - 10);
          next.set(key, t);
          const x = a + (hash(ia, ib, i) * 2 - 1) * half;
          const y = b + (hash(ib, ia, i + 3) * 2 - 1) * half;
          write(count++, x, y, size * (0.85 + hash(ia, i, ib) * 0.3), t, base, bright);
        }
      }
      known = next;
      dirty();
    },
    clear() {
      count = 0;
      known = new Map();
      dirty();
    },
    update(time, ppuPx) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uScale.value = ppuPx;
    },
    setOpacity(o) {
      mat.uniforms.uOpacity.value = o;
    },
    get opacity() {
      return mat.uniforms.uOpacity.value;
    },
  };
}
