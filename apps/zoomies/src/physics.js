// Tiny platformer physics. No engine — just AABBs on the x/y plane.
// Pure module (no THREE) so it can run headless for tuning.

export const PHYS = {
  STEP: 1 / 120, // fixed simulation step (s)
  RUN_SPEED: 8.5, // u/s
  ZOOMIES_MULT: 1.6, // tennis-ball speed boost
  ACCEL_GROUND: 70,
  TURN_GROUND: 120,
  DECEL_GROUND: 55,
  ACCEL_AIR: 38,
  DECEL_AIR: 10,
  GRAVITY_UP: 36,
  GRAVITY_DOWN: 56, // falls a bit faster than it rises (feels snappier)
  JUMP_VELOCITY: 14, // => ~2.7u apex
  JUMP_CUT: 0.45, // releasing jump early multiplies vy by this (variable jump height)
  MAX_FALL: 24,
  COYOTE: 0.1, // s after leaving a ledge you can still jump
  JUMP_BUFFER: 0.1, // s a jump press is remembered before landing
  STOMP_BOUNCE: 11,
  HALF_W: 0.45,
  HEIGHT: 0.8,
};

const EPS = 0.001;

export function createBody(x, y) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    grounded: false,
    ground: null,
    coyote: 0,
    buffer: 0,
    jumping: false,
    jumpWasDown: false,
    facing: 1,
    zoomies: 0,
    airTime: 0,
  };
}

function approach(v, target, delta) {
  if (v < target) return Math.min(v + delta, target);
  if (v > target) return Math.max(v - delta, target);
  return v;
}

export function overlapsSolid(b, s) {
  const top = s.y;
  const bottom = s.y - s.h;
  return (
    b.x + PHYS.HALF_W > s.x + EPS &&
    b.x - PHYS.HALF_W < s.x + s.w - EPS &&
    b.y + PHYS.HEIGHT > bottom + EPS &&
    b.y < top - EPS
  );
}

/**
 * Advance the body one fixed step.
 * input: { left, right, jump } (booleans, jump = held)
 * solids: [{x, y, w, h}] — x = left edge, y = TOP surface, h = thickness below the top
 * returns events for juice (dust, squash, sfx)
 */
export function stepBody(b, input, solids, dt) {
  const ev = { jumped: false, landed: false, landVy: 0, bonked: false };
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const maxSpeed = PHYS.RUN_SPEED * (b.zoomies > 0 ? PHYS.ZOOMIES_MULT : 1);
  if (b.zoomies > 0) b.zoomies = Math.max(0, b.zoomies - dt);

  // --- horizontal intent
  let accel;
  if (b.grounded) {
    if (dir === 0) accel = PHYS.DECEL_GROUND;
    else if (Math.sign(b.vx) !== dir && Math.abs(b.vx) > 0.5) accel = PHYS.TURN_GROUND;
    else accel = PHYS.ACCEL_GROUND;
  } else {
    accel = dir === 0 ? PHYS.DECEL_AIR : PHYS.ACCEL_AIR;
  }
  b.vx = approach(b.vx, dir * maxSpeed, accel * dt);
  if (dir !== 0) b.facing = dir;

  // --- jump: buffer + coyote
  const pressed = input.jump && !b.jumpWasDown;
  b.jumpWasDown = !!input.jump;
  if (pressed) b.buffer = PHYS.JUMP_BUFFER;
  else b.buffer = Math.max(0, b.buffer - dt);
  if (b.grounded) b.coyote = PHYS.COYOTE;
  else b.coyote = Math.max(0, b.coyote - dt);

  if (b.buffer > 0 && b.coyote > 0) {
    b.vy = PHYS.JUMP_VELOCITY;
    b.grounded = false;
    b.ground = null;
    b.coyote = 0;
    b.buffer = 0;
    b.jumping = true;
    ev.jumped = true;
  }

  // variable jump height
  if (b.jumping && !input.jump && b.vy > 0) {
    b.vy *= PHYS.JUMP_CUT;
    b.jumping = false;
  }
  if (b.vy <= 0) b.jumping = false;

  // --- gravity
  const g = b.vy > 0 ? PHYS.GRAVITY_UP : PHYS.GRAVITY_DOWN;
  b.vy = Math.max(b.vy - g * dt, -PHYS.MAX_FALL);

  // --- move X, resolve
  b.x += b.vx * dt;
  for (const s of solids) {
    if (!overlapsSolid(b, s)) continue;
    const cx = s.x + s.w / 2;
    const pushLeft = b.vx > 0 || (b.vx === 0 && b.x < cx);
    if (pushLeft) b.x = s.x - PHYS.HALF_W;
    else b.x = s.x + s.w + PHYS.HALF_W;
    b.vx = 0;
  }

  // --- move Y, resolve
  const wasGrounded = b.grounded;
  const preVy = b.vy;
  b.y += b.vy * dt;
  b.grounded = false;
  b.ground = null;
  for (const s of solids) {
    if (!overlapsSolid(b, s)) continue;
    if (b.vy <= 0) {
      b.y = s.y;
      b.vy = 0;
      b.grounded = true;
      b.ground = s;
    } else {
      b.y = s.y - s.h - PHYS.HEIGHT;
      b.vy = 0;
      b.jumping = false;
      ev.bonked = true;
    }
  }

  if (b.grounded && !wasGrounded) {
    ev.landed = true;
    ev.landVy = preVy;
    b.airTime = 0;
  } else if (!b.grounded) {
    b.airTime += dt;
  }
  return ev;
}

/** Move a moving platform and carry anything standing on it. */
export function stepMover(m, t) {
  const prevX = m.x;
  const prevY = m.y;
  const s = Math.sin((t / m.period) * Math.PI * 2 + (m.phase || 0)) * 0.5 + 0.5;
  if (m.axis === 'y') m.y = m.y0 + s * m.range;
  else m.x = m.x0 + s * m.range;
  m.dx = m.x - prevX;
  m.dy = m.y - prevY;
}
