// Smooth side-on follow camera with look-ahead, a lazy vertical dead-zone and screen shake.
import * as THREE from 'three';

const OFFSET = new THREE.Vector3(-2.2, 3.3, 15.5);
const LOOK = new THREE.Vector3(0.9, 1.35, 0);

export function createCameraRig(camera) {
  const s = {
    x: 0,
    y: 0,
    focusY: 0,
    ahead: 0,
    shake: 0,
    floorY: -100,
    titleT: 0,
  };
  const tmp = new THREE.Vector3();

  function damp(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  return {
    snap(x, y) {
      s.x = x;
      s.y = y;
      s.focusY = y;
      s.ahead = 2;
    },
    setFloor(y) {
      s.floorY = y;
    },
    shake(amount) {
      s.shake = Math.max(s.shake, amount);
    },
    /** target = { x, y, grounded, facing, zoomies, dead } */
    update(dt, target, mode = 'play') {
      if (target.grounded || target.y < s.focusY - 0.6 || target.y > s.focusY + 3.2) {
        s.focusY = target.grounded ? target.y : target.y < s.focusY ? target.y + 0.6 : target.y - 3.2;
      }
      const focusY = Math.max(s.focusY, s.floorY + 4.5);
      const aheadTarget = target.dead ? 0 : target.facing * (target.zoomies ? 3.6 : 2.2);
      s.ahead = damp(s.ahead, aheadTarget, 2.2, dt);
      if (!target.dead) s.x = damp(s.x, target.x, target.zoomies ? 10 : 7, dt);
      s.y = damp(s.y, focusY, 3.2, dt);

      let ox = 0;
      let oy = 0;
      if (s.shake > 0.001) {
        ox = (Math.random() - 0.5) * s.shake;
        oy = (Math.random() - 0.5) * s.shake;
        s.shake *= Math.exp(-7 * dt);
      }
      const cx = s.x + s.ahead;
      if (mode === 'title') {
        s.titleT += dt;
        const sway = Math.sin(s.titleT * 0.3) * 1.2;
        camera.position.set(cx - 1.2 + sway, s.y + 1.5, 10.5);
        tmp.set(cx - 0.4, s.y + 2.6, 0);
      } else {
        camera.position.set(cx + OFFSET.x + ox, s.y + OFFSET.y + oy, OFFSET.z);
        tmp.set(cx + LOOK.x + ox * 0.5, s.y + LOOK.y + oy * 0.5, 0);
      }
      camera.lookAt(tmp);
      return tmp;
    },
  };
}
