// One fixed simulation step of "the dog in the level". Shared by the game loop and the autoplay
// bot's look-ahead so the bot's predictions match what actually happens.
import { PHYS, stepBody, stepMover } from './physics.js';
import { stepEnemy, enemyContact } from './enemies.js';

/**
 * play = { body, movers, solids, enemies, t, killY }
 * returns body events + { stomped, hit, fell }
 */
export function stepPlay(play, input, dt, invulnerable = false) {
  play.t += dt;
  for (const m of play.movers) stepMover(m, play.t);
  const b = play.body;
  // ride moving platforms
  if (b.grounded && b.ground && b.ground.axis) {
    b.x += b.ground.dx;
    b.y += b.ground.dy;
  }
  const prevY = b.y;
  const ev = stepBody(b, input, play.solids, dt);
  ev.stomped = null;
  ev.hit = null;
  ev.fell = false;
  for (const e of play.enemies) {
    stepEnemy(e, dt);
    if (ev.hit) continue;
    const c = enemyContact(b, prevY, e);
    if (c === 'stomp') {
      e.alive = false;
      b.vy = PHYS.STOMP_BOUNCE;
      b.jumping = false;
      ev.stomped = e;
    } else if (c === 'hit' && !invulnerable) {
      ev.hit = e;
    }
  }
  if (b.y < play.killY) ev.fell = true;
  return ev;
}

/** deep-enough copy of the play state for what-if simulation */
export function clonePlay(p) {
  const movers = p.movers.map((m) => ({ ...m }));
  const map = new Map(p.movers.map((m, i) => [m, movers[i]]));
  return {
    body: { ...p.body, ground: map.get(p.body.ground) || p.body.ground },
    movers,
    solids: p.solids.map((s) => map.get(s) || s),
    enemies: p.enemies.map((e) => ({ ...e })),
    t: p.t,
    killY: p.killY,
  };
}
