// Floating "+10" score popups (sprites), pooled.
import * as THREE from 'three';
import { canvasTexture } from './world.js';

const POOL_SIZE = 8;
const POPUP_LIFE = 1.5; // seconds

function textTexture(text, fill, stroke) {
  return canvasTexture(256, 128, (ctx, w, h) => {
    ctx.font = '700 84px "Fredoka", "Trebuchet MS", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 16;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, w / 2, h / 2 + 4);
    ctx.fillStyle = fill;
    ctx.fillText(text, w / 2, h / 2 + 4);
  });
}

export function createPopups(scene) {
  const textures = {
    10: textTexture('+10', '#ffffff', '#632CA6'),
    100: textTexture('+100', '#FFD84D', '#7a3b00'),
  };

  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textures[10], transparent: true, depthTest: false, depthWrite: false, fog: false }));
    sprite.renderOrder = 20;
    sprite.visible = false;
    sprite.active = false;
    sprite.life = 0;
    scene.add(sprite);
    pool.push(sprite);
  }

  // GLITCHLESS-DEMO: silent gameplay error — the pool only holds 8 popups. Collect a 9th bone while 8
  // are still floating (~1.5s) and find() returns undefined, so the next line throws
  // "TypeError: Cannot read properties of undefined (reading 'position')". The caller has already
  // hidden the bone but hasn't added the score yet, so the points are silently lost.
  function spawnScorePopup(pos, value) {
    const popup = pool.find((p) => !p.active);
    popup.position.set(pos.x, pos.y + 0.5, 0.6);
    popup.material.map = textures[value] || textures[10];
    popup.material.opacity = 1;
    popup.scale.set(value >= 100 ? 1.6 : 1.1, value >= 100 ? 0.8 : 0.55, 1);
    popup.life = POPUP_LIFE;
    popup.active = true;
    popup.visible = true;
  }

  function update(dt) {
    for (const p of pool) {
      if (!p.active) continue;
      p.life -= dt;
      p.position.y += dt * 1.4;
      const t = p.life / POPUP_LIFE;
      p.material.opacity = Math.min(1, t * 2.5);
      if (p.life <= 0) {
        p.active = false;
        p.visible = false;
      }
    }
  }

  function reset() {
    for (const p of pool) {
      p.active = false;
      p.visible = false;
    }
  }

  return { spawnScorePopup, update, reset };
}
