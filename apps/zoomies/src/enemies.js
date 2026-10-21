import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PHYS } from './physics.js';

export const ENEMY_SIZE = {
  squirrel: { hw: 0.34, h: 0.72 },
  vacuum: { hw: 0.46, h: 0.34 },
};

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildSquirrel() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const fur = std(0xc9733a);
  const furDark = std(0xa85a2c);
  const belly = std(0xf3c792);
  const black = std(0x16161c, { roughness: 0.3 });

  const torso = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.4, 0.34, 2, 0.12), fur));
  torso.position.set(0, 0.3, 0);
  body.add(torso);
  const tummy = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.28, 0.26, 2, 0.08), belly);
  tummy.position.set(0.17, 0.28, 0);
  body.add(tummy);
  const head = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.32, 0.3, 0.3, 2, 0.1), fur));
  head.position.set(0.22, 0.58, 0);
  body.add(head);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 4), furDark);
    ear.position.set(0.18, 0.78, 0.09 * s);
    body.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), black);
    eye.position.set(0.36, 0.63, 0.1 * s);
    body.add(eye);
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), belly);
    cheek.position.set(0.36, 0.53, 0.08 * s);
    body.add(cheek);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), std(0xe86a8a));
  nose.position.set(0.39, 0.58, 0);
  body.add(nose);
  // big fluffy tail: a curl of spheres
  const tail = new THREE.Group();
  tail.position.set(-0.22, 0.25, 0);
  const pts = [
    [-0.05, 0.05, 0.13],
    [-0.16, 0.18, 0.15],
    [-0.22, 0.36, 0.17],
    [-0.2, 0.56, 0.17],
    [-0.1, 0.7, 0.15],
    [0.02, 0.74, 0.12],
  ];
  for (const [x, y, r] of pts) {
    const puff = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), furDark));
    puff.position.set(x, y, 0);
    tail.add(puff);
  }
  body.add(tail);
  root.userData = { body, tail };
  return root;
}

function buildVacuum() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const shell = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.48, 0.2, 28), std(0xeceef4, { roughness: 0.3, metalness: 0.1 })));
  shell.position.y = 0.14;
  body.add(shell);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 0.05, 28), std(0x30333f, { roughness: 0.2, metalness: 0.3 }));
  lid.position.y = 0.265;
  body.add(lid);
  const bumper = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.035, 8, 32), std(0x3a3d4a, { roughness: 0.4 }));
  bumper.rotation.x = Math.PI / 2;
  bumper.position.y = 0.12;
  body.add(bumper);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0xe0457b, { roughness: 0.15, emissive: 0xe0457b, emissiveIntensity: 0.3 }));
  dome.position.set(0.12, 0.29, 0);
  body.add(dome);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xff3355, emissive: 0xff2244, emissiveIntensity: 2 });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), ledMat);
  led.position.set(-0.18, 0.3, 0);
  body.add(led);
  // grumpy little eyes on the bumper
  const white = std(0xffffff, { roughness: 0.3 });
  const black = std(0x101014, { roughness: 0.3 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), white);
    eye.scale.set(0.5, 1, 1);
    eye.position.set(0.43, 0.17, 0.13 * s);
    body.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), black);
    pupil.position.set(0.47, 0.16, 0.13 * s);
    body.add(pupil);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.12), black);
    brow.position.set(0.46, 0.25, 0.13 * s);
    brow.rotation.x = 0.45 * s;
    body.add(brow);
  }
  // spinning side brush
  const brush = new THREE.Group();
  brush.position.set(0.36, 0.04, 0.3);
  for (let i = 0; i < 3; i++) {
    const bristle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.01, 0.025), std(0xe0457b));
    bristle.rotation.y = (i / 3) * Math.PI;
    brush.add(bristle);
  }
  body.add(brush);
  root.userData = { body, brush, ledMat };
  return root;
}

export function createEnemy(def, y, phase = 0) {
  const size = ENEMY_SIZE[def.kind];
  const mesh = def.kind === 'vacuum' ? buildVacuum() : buildSquirrel();
  mesh.position.set(def.x, y, 0);
  return {
    kind: def.kind,
    x: def.x,
    y,
    minX: def.minX,
    maxX: def.maxX,
    speed: def.speed,
    dir: 1,
    hw: size.hw,
    h: size.h,
    alive: true,
    squashed: 0,
    t: phase,
    mesh,
  };
}

/** fixed-step logic */
export function stepEnemy(e, dt) {
  if (!e.alive) return;
  e.t += dt;
  e.x += e.dir * e.speed * dt;
  if (e.x > e.maxX) {
    e.x = e.maxX;
    e.dir = -1;
  } else if (e.x < e.minX) {
    e.x = e.minX;
    e.dir = 1;
  }
}

/** per-frame visuals */
export function animateEnemy(e, dt) {
  const m = e.mesh;
  const { body } = m.userData;
  m.position.x = e.x;
  m.position.y = e.y;
  if (!e.alive) {
    e.squashed += dt;
    body.scale.set(1.25, Math.max(0.15, 1 - e.squashed * 6), 1.25);
    if (e.squashed > 0.45) m.visible = false;
    return;
  }
  const targetRot = e.dir > 0 ? 0 : Math.PI;
  m.rotation.y += (targetRot - m.rotation.y) * Math.min(1, dt * 10);
  if (e.kind === 'squirrel') {
    const hop = Math.abs(Math.sin(e.t * 9));
    body.position.y = hop * 0.16;
    body.rotation.z = Math.sin(e.t * 9) * 0.08;
    m.userData.tail.rotation.z = Math.sin(e.t * 6) * 0.18;
  } else {
    body.position.y = Math.abs(Math.sin(e.t * 22)) * 0.012;
    m.userData.brush.rotation.y += dt * 25;
    m.userData.ledMat.emissiveIntensity = Math.sin(e.t * 8) > 0 ? 2.5 : 0.3;
  }
}

/**
 * Player vs enemy. 'stomp' when falling onto it from above, 'hit' when touching it any other way.
 * prevY = player feet before this step's move.
 */
export function enemyContact(body, prevY, e) {
  if (!e.alive) return null;
  const overlap =
    body.x + PHYS.HALF_W > e.x - e.hw &&
    body.x - PHYS.HALF_W < e.x + e.hw &&
    body.y + PHYS.HEIGHT > e.y &&
    body.y < e.y + e.h;
  if (!overlap) return null;
  if (body.vy < 0 && prevY >= e.y + e.h * 0.45) return 'stomp';
  return 'hit';
}
