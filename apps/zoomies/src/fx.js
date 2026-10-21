// Juice: dust puffs, sparkles, zoomies trail, and the tennis-ball confetti party.
import * as THREE from 'three';
import { COLORS } from './theme.js';

const CONFETTI_COLORS = [0x632ca6, 0xe0457b, 0xffc83d, 0x3fd0c9, 0xd8f23c, 0xffffff, 0x8a5cf6];
const CONFETTI_PER_BURST = 800;

export function createFx(scene) {
  // ── pooled puffs (dust, sparkles, trail) — shared geometry, one material per pooled slot
  const puffGeo = new THREE.IcosahedronGeometry(0.2, 0);
  const pool = [];
  for (let i = 0; i < 90; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, roughness: 1, depthWrite: false, flatShading: true });
    const m = new THREE.Mesh(puffGeo, mat);
    m.visible = false;
    scene.add(m);
    pool.push({ mesh: m, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 1, gravity: 0, size: 1, emissive: false });
  }
  let cursor = 0;

  function spawn(x, y, z, { color = 0xffffff, size = 1, life = 0.5, vx = 0, vy = 0, vz = 0, grow = 1.5, gravity = 0, glow = 0 } = {}) {
    const p = pool[cursor];
    cursor = (cursor + 1) % pool.length;
    p.mesh.position.set(x, y, z);
    p.mesh.material.color.setHex(color);
    p.mesh.material.emissive.setHex(glow ? color : 0x000000);
    p.mesh.material.emissiveIntensity = glow;
    p.mesh.material.opacity = 0.9;
    p.mesh.visible = true;
    p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    p.life = life;
    p.max = life;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.grow = grow;
    p.gravity = gravity;
    p.size = size;
    p.mesh.scale.setScalar(size);
  }

  // ── confetti (see below)
  const confetti = [];

  // GLITCHLESS-DEMO: particle perf bomb — every tennis ball spawns 800 separate meshes, each with its
  // own SphereGeometry + MeshStandardMaterial. They fade to opacity 0 but are never removed from the
  // scene or disposed, so draw calls (x2 with the shadow pass) and frame time climb with every pickup.
  function confettiBurst(x, y, z) {
    for (let i = 0; i < CONFETTI_PER_BURST; i++) {
      const geometry = new THREE.SphereGeometry(0.05 + Math.random() * 0.05, 16, 12);
      const material = new THREE.MeshStandardMaterial({
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        roughness: 0.4,
        metalness: 0.2,
        transparent: true,
        opacity: 1,
      });
      const piece = new THREE.Mesh(geometry, material);
      piece.position.set(x, y, z);
      piece.castShadow = true;
      piece.frustumCulled = false; // pieces were popping out at the screen edges
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const speed = 3 + Math.random() * 7;
      piece.userData.velocity = new THREE.Vector3(Math.cos(a) * speed * 0.8, 4 + up * 8, Math.sin(a) * speed * 0.5);
      piece.userData.spin = Math.random() * 10;
      scene.add(piece);
      confetti.push(piece);
    }
  }

  function updateConfetti(dt) {
    for (const piece of confetti) {
      const v = piece.userData.velocity;
      v.y -= 14 * dt;
      v.multiplyScalar(1 - 1.2 * dt);
      piece.position.addScaledVector(v, dt);
      piece.position.x += Math.sin(piece.userData.spin + piece.position.y * 3) * dt * 0.6;
      piece.rotation.x += piece.userData.spin * dt;
      piece.material.opacity = Math.max(0, piece.material.opacity - dt * 0.45);
    }
  }

  return {
    get confettiCount() {
      return confetti.length;
    },
    dust(x, y, n = 6, strength = 1, color = 0xf3eadb) {
      for (let i = 0; i < n; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        spawn(x + (Math.random() - 0.5) * 0.4, y + 0.08, (Math.random() - 0.5) * 0.6, {
          color,
          size: (0.5 + Math.random() * 0.5) * strength,
          life: 0.35 + Math.random() * 0.25,
          vx: dir * (0.8 + Math.random() * 1.6) * strength,
          vy: 0.4 + Math.random() * 0.8,
          vz: (Math.random() - 0.5) * 1.2,
          grow: 1.8,
        });
      }
    },
    sparkle(x, y, color = COLORS.gold, n = 10) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        spawn(x, y, 0.2, {
          color,
          size: 0.35 + Math.random() * 0.2,
          life: 0.5 + Math.random() * 0.2,
          vx: Math.cos(a) * 3.2,
          vy: Math.sin(a) * 3.2,
          vz: 0,
          grow: -1.2,
          glow: 0.8,
        });
      }
    },
    poof(x, y, color = 0xffffff) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        spawn(x, y + 0.3, 0, { color, size: 0.9, life: 0.5, vx: Math.cos(a) * 2.6, vy: Math.sin(a) * 2.2 + 1, vz: (Math.random() - 0.5) * 2, grow: 1.2 });
      }
    },
    trail(x, y, facing) {
      spawn(x - facing * 0.5, y + 0.45 + (Math.random() - 0.5) * 0.3, -0.1, {
        color: Math.random() < 0.5 ? COLORS.pink : COLORS.purple,
        size: 0.55,
        life: 0.3,
        vx: -facing * 1.5,
        vy: 0,
        grow: -2.5,
        glow: 0.6,
      });
    },
    confettiBurst,
    update(dt) {
      for (const p of pool) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.mesh.visible = false;
          continue;
        }
        p.vy -= p.gravity * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.vx *= 1 - 3 * dt;
        p.vy *= 1 - 3 * dt;
        const t = p.life / p.max;
        p.mesh.scale.setScalar(Math.max(0.01, p.size * (1 + p.grow * (1 - t))));
        p.mesh.material.opacity = t * 0.85;
      }
      updateConfetti(dt);
    },
  };
}
