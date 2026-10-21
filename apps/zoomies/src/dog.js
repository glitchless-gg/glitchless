// The hero: a low-poly purple pup in gaming headphones.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COLORS } from './theme.js';

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...extra });

function part(geo, material, x, y, z, parent) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export function createDog() {
  const purple = mat(COLORS.purple, { emissive: 0x2a0f55, emissiveIntensity: 0.45 });
  const purpleDark = mat(0x4b1f82, { emissive: 0x1e0a40, emissiveIntensity: 0.4 });
  const lavender = mat(COLORS.lavender, { roughness: 0.6 });
  const black = mat(0x15151c, { roughness: 0.35 });
  const phones = mat(0x1b1b22, { roughness: 0.3, metalness: 0.25 });
  const pink = mat(COLORS.pink, { roughness: 0.35, emissive: COLORS.pink, emissiveIntensity: 0.25 });
  const white = mat(0xffffff, { roughness: 0.2 });
  const tongueMat = mat(0xff7aa2, { roughness: 0.5 });

  const root = new THREE.Group(); // at the feet; rotates to face
  const squash = new THREE.Group(); // squash & stretch pivot (feet)
  root.add(squash);
  const body = new THREE.Group(); // bob / lean
  squash.add(body);

  // torso
  const torso = part(new RoundedBoxGeometry(0.86, 0.46, 0.46, 3, 0.16), purple, -0.02, 0.5, 0, body);
  part(new RoundedBoxGeometry(0.42, 0.3, 0.42, 2, 0.12), lavender, 0.16, 0.42, 0, body).scale.set(1, 1, 1.02);

  // legs (pivot at the hip)
  const legs = [];
  const legGeo = new RoundedBoxGeometry(0.15, 0.36, 0.15, 2, 0.05);
  legGeo.translate(0, -0.15, 0);
  const pawGeo = new RoundedBoxGeometry(0.19, 0.08, 0.18, 2, 0.035);
  for (const [x, z, front] of [
    [0.27, 0.15, true],
    [0.27, -0.15, true],
    [-0.27, 0.15, false],
    [-0.27, -0.15, false],
  ]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.36, z);
    body.add(hip);
    part(legGeo, z > 0 ? purple : purpleDark, 0, 0, 0, hip);
    part(pawGeo, lavender, 0.03, -0.32, 0, hip);
    legs.push({ hip, front, near: z > 0 });
  }

  // head
  const head = new THREE.Group();
  head.position.set(0.42, 0.86, 0);
  body.add(head);
  part(new RoundedBoxGeometry(0.54, 0.5, 0.5, 3, 0.18), purple, 0, 0, 0, head);
  part(new RoundedBoxGeometry(0.3, 0.22, 0.32, 2, 0.09), lavender, 0.32, -0.1, 0, head);
  part(new THREE.SphereGeometry(0.07, 10, 8), black, 0.48, -0.02, 0, head);
  const tongue = part(new RoundedBoxGeometry(0.1, 0.03, 0.1, 1, 0.012), tongueMat, 0.38, -0.22, 0.05, head);
  tongue.visible = false;
  const sclera = mat(0xffffff, { roughness: 0.25 });
  for (const s of [-1, 1]) {
    part(new THREE.SphereGeometry(0.08, 14, 10), sclera, 0.16, 0.09, 0.2 * s, head);
    part(new THREE.SphereGeometry(0.05, 12, 8), black, 0.2, 0.09, 0.245 * s, head);
    part(new THREE.SphereGeometry(0.017, 6, 5), white, 0.215, 0.115, 0.29 * s, head);
  }
  // floppy ears (pivot at top)
  const ears = [];
  const earGeo = new RoundedBoxGeometry(0.16, 0.34, 0.08, 2, 0.035);
  earGeo.translate(0, -0.15, 0);
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(-0.08, 0.18, 0.25 * s);
    head.add(pivot);
    part(earGeo, purpleDark, 0, 0, 0, pivot);
    pivot.rotation.x = 0.25 * s;
    ears.push({ pivot, side: s });
  }

  // gaming headphones: band over the top, chunky cups, pink accents, little mic boom
  const band = part(new THREE.TorusGeometry(0.3, 0.042, 8, 24, Math.PI), phones, -0.08, 0.04, 0, head);
  band.rotation.y = Math.PI / 2;
  for (const s of [-1, 1]) {
    const cup = part(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 20), phones, -0.09, -0.01, 0.29 * s, head);
    cup.rotation.x = Math.PI / 2;
    const ring = part(new THREE.TorusGeometry(0.11, 0.026, 8, 24), pink, -0.09, -0.01, 0.34 * s, head);
    ring.rotation.y = 0;
    const cap = part(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 16), pink, -0.09, -0.01, 0.345 * s, head);
    cap.rotation.x = Math.PI / 2;
  }
  const boom = new THREE.Group();
  boom.position.set(-0.09, -0.04, 0.34);
  head.add(boom);
  const boomArm = part(new THREE.CylinderGeometry(0.018, 0.018, 0.4, 8), phones, 0.19, -0.08, 0, boom);
  boomArm.rotation.z = Math.PI / 2 + 0.4;
  part(new THREE.SphereGeometry(0.042, 10, 8), pink, 0.37, -0.16, 0, boom);

  // tail (pivot at base)
  const tail = new THREE.Group();
  tail.position.set(-0.43, 0.62, 0);
  body.add(tail);
  const tailGeo = new THREE.CylinderGeometry(0.045, 0.075, 0.36, 8);
  tailGeo.translate(0, 0.17, 0);
  part(tailGeo, purple, 0, 0, 0, tail);
  part(new THREE.SphereGeometry(0.06, 8, 6), lavender, 0, 0.36, 0, tail);
  tail.rotation.z = 0.7;

  root.userData = { squash, body, head, legs, ears, tail, tongue, torso, materials: [purple, purpleDark] };
  return root;
}

/**
 * Per-frame animation. `s` = { vx, vy, grounded, facing, zoomies, dead, time, squashV }.
 */
export function animateDog(dog, s, dt) {
  const u = dog.userData;
  const speed = Math.abs(s.vx);
  u.phase = (u.phase || 0) + dt * (4 + speed * 2.1);
  const run = Math.min(1, speed / 6);

  // face direction with a little overshoot-free ease
  const targetYaw = s.facing > 0 ? 0 : Math.PI;
  u.yaw = u.yaw ?? targetYaw;
  u.yaw += (targetYaw - u.yaw) * Math.min(1, dt * 14);
  dog.rotation.y = u.yaw;

  // legs
  for (const leg of u.legs) {
    let a;
    if (!s.grounded) {
      a = leg.front ? -0.9 : 0.8; // superman pose in the air
      if (s.vy < 0) a *= 0.5;
    } else {
      const p = u.phase + (leg.front ? 0 : Math.PI) + (leg.near ? 0 : 0.6);
      a = Math.sin(p) * 0.9 * run;
    }
    leg.hip.rotation.z += (a - leg.hip.rotation.z) * Math.min(1, dt * 20);
  }

  // body bob + lean
  const bob = s.grounded ? Math.abs(Math.sin(u.phase)) * 0.06 * run : 0;
  u.body.position.y = bob;
  const lean = s.grounded ? -0.12 * run * (s.zoomies ? 1.8 : 1) : Math.max(-0.35, Math.min(0.35, s.vy * 0.025));
  u.body.rotation.z += (lean - u.body.rotation.z) * Math.min(1, dt * 10);
  u.head.rotation.z = Math.sin(u.phase * 0.5) * 0.04 + (s.grounded ? 0 : 0.1);

  // ears flop with vertical speed
  for (const ear of u.ears) {
    const flop = s.grounded ? Math.sin(u.phase + 1) * 0.15 * run : Math.max(-1.6, Math.min(0.6, -s.vy * 0.1));
    ear.pivot.rotation.z += (flop + (s.grounded ? -0.1 : 0) - ear.pivot.rotation.z) * Math.min(1, dt * 12);
    ear.pivot.rotation.x = 0.25 * ear.side + (s.grounded ? 0 : 0.25 * ear.side);
  }

  // tail wag (faster when happy/zooming)
  const wagSpeed = s.zoomies ? 30 : 10 + speed * 1.2;
  u.wag = (u.wag || 0) + dt * wagSpeed;
  u.tail.rotation.y = Math.sin(u.wag) * 0.7;
  u.tail.rotation.z = 0.7 + Math.sin(u.wag * 0.5) * 0.15;
  u.tongue.visible = !!s.zoomies || speed > 7.5;

  // squash & stretch (spring)
  u.sq = u.sq || 0;
  u.sqv = u.sqv || 0;
  if (s.kick) u.sqv += s.kick;
  const k = 260;
  const c = 16;
  u.sqv += (-k * u.sq - c * u.sqv) * dt;
  u.sq += u.sqv * dt;
  const q = Math.max(-0.45, Math.min(0.45, u.sq));
  u.squash.scale.set(1 + q * 0.6, 1 - q, 1 + q * 0.6);
}

export function setDogFlash(dog, on) {
  for (const m of dog.userData.materials) m.emissive.setHex(on ? 0x6644aa : 0x000000);
}
