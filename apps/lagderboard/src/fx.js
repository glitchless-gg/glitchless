// Lights and explosions. Both follow the cube count, not the player, so every device faces the same mix and a score
// compares devices. A new light changes every material's shader, so it costs a real recompile: Glitchless sees
// that as a hitch with cause shader_compile.
import * as THREE from 'three';

const LIGHT_COLORS = [0x2ee6a6, 0xff4fd8, 0x3dd9ff, 0xffc83d, 0x8b5cff, 0xff6b57, 0x7cffcb, 0xff9d3d];
export const MAX_LIGHTS = 8;

// 1 light at 500 cubes, then one more each time the count doubles, up to 8 at 64,000.
export function lightsFor(cubes) {
  return Math.max(0, Math.min(MAX_LIGHTS, Math.floor(Math.log2(Math.max(1, cubes) / 250))));
}

export class Lights {
  constructor(scene) {
    this.scene = scene;
    this.lights = [];
    this.flash = [];
    this.onAdd = null;
  }

  set(count) {
    while (this.lights.length < count) {
      const i = this.lights.length;
      const light = new THREE.PointLight(LIGHT_COLORS[i % LIGHT_COLORS.length], 0, 0, 2);
      light.name = `light-${i + 1}`;
      this.scene.add(light);
      this.lights.push(light);
      this.flash.push(1);
      this.onAdd?.(this.lights.length);
    }
    while (this.lights.length > count) {
      this.scene.remove(this.lights.pop());
      this.flash.pop();
    }
  }

  update(dt, time, h, radius) {
    const n = this.lights.length;
    for (let i = 0; i < n; i++) {
      const light = this.lights[i];
      const a = time * (0.35 + i * 0.07) * (i % 2 ? -1 : 1) + (i / n) * Math.PI * 2;
      const r = radius * (0.55 + 0.25 * Math.sin(i * 1.7)) + 2;
      light.position.set(Math.cos(a) * r, h * (0.75 + 0.35 * Math.sin(time * 0.6 + i)) + 2, Math.sin(a) * r);
      this.flash[i] = Math.max(0, this.flash[i] - dt * 1.4);
      light.intensity = (h + 4) * (h + 4) * (2.2 + 9 * this.flash[i]);
    }
  }

  clear() {
    this.set(0);
  }
}

const POOL = 18;

export class Explosions {
  constructor(scene) {
    this.scene = scene;
    this.live = [];
    this.free = [];
    this.total = 0;
    const sphere = new THREE.IcosahedronGeometry(1, 3);
    const ring = new THREE.RingGeometry(0.82, 1, 64);
    ring.rotateX(-Math.PI / 2);
    for (let i = 0; i < POOL; i++) {
      const color = LIGHT_COLORS[i % LIGHT_COLORS.length];
      const ball = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      const wave = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ball.name = 'explosion';
      wave.name = 'shockwave';
      ball.visible = wave.visible = false;
      ball.frustumCulled = wave.frustumCulled = false;
      scene.add(ball, wave);
      this.free.push({ ball, wave, age: 0, size: 1 });
    }
  }

  spawn(p, size) {
    const e = this.free.pop() || this.live.shift();
    e.age = 0;
    e.size = size;
    e.ball.position.copy(p);
    e.wave.position.copy(p).setY(p.y + 0.05);
    e.ball.visible = e.wave.visible = true;
    this.live.push(e);
    this.total++;
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      e.age += dt;
      const k = e.age / 0.75;
      if (k >= 1) {
        e.ball.visible = e.wave.visible = false;
        this.live.splice(i, 1);
        this.free.push(e);
        continue;
      }
      const ease = 1 - (1 - k) ** 3;
      e.ball.scale.setScalar(e.size * (0.3 + ease * 0.9));
      e.ball.material.opacity = (1 - k) ** 2 * 0.9;
      e.wave.scale.setScalar(e.size * (0.4 + ease * 3.2));
      e.wave.material.opacity = (1 - k) * 0.8;
    }
  }

  clear() {
    for (const e of this.live) {
      e.ball.visible = e.wave.visible = false;
      this.free.push(e);
    }
    this.live = [];
    this.total = 0;
  }
}
