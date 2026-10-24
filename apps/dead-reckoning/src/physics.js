// Tile physics for one small body, stepped at a fixed 60 Hz so a run plays the same every time: the game,
// the autoplay bot's look-ahead, the mock markers and the tests all step it. No three.js in here.
// World units are tiles; y is up; the body's (x, y) is the middle of its feet.

export const DT = 1 / 60;

export const PHYS = {
  halfW: 0.3,
  h: 0.8,
  run: 8.5, // top speed, tiles/s
  accel: 90,
  airAccel: 55,
  decel: 80,
  gravity: 55, // rising with jump held
  fallGravity: 80,
  jumpV: 17.5, // a full jump clears 2.7 tiles; a tap about half a tile
  jumpCut: 0.45, // let go early and the rise is cut
  maxFall: 26,
  coyote: 0.08,
  buffer: 0.1,
  killY: -1, // fall below this and you're gone
};

const EPS = 1e-6;

export function createBody(spawn) {
  return {
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    grounded: true,
    coyote: PHYS.coyote,
    buffer: 0,
    jumpHeld: true, // a fresh press is needed, so a held key from a menu doesn't jump
    rising: false,
    facing: 1,
    dead: null, // { x, y, cause }
    won: false,
  };
}

export function cloneBody(b) {
  return { ...b };
}

function solidAt(lv, c, r) {
  if (c < 0 || c >= lv.w || r >= lv.h) return true; // walls and ceiling
  if (r < 0) return false; // the abyss
  return lv.solid[r * lv.w + c] === 1;
}

function approach(v, target, d) {
  return v < target ? Math.min(target, v + d) : Math.max(target, v - d);
}

/**
 * One fixed step. `input` is { left, right, jump }. `ev` (optional) collects what the view wants to show:
 * jumped, landed (the tiles under the feet), bonked (tile above), bumped (tile beside).
 */
export function step(b, input, lv, ev = null) {
  if (b.dead || b.won) return b;
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir) b.facing = dir;

  const a = b.grounded ? (dir ? PHYS.accel : PHYS.decel) : PHYS.airAccel;
  b.vx = approach(b.vx, dir * PHYS.run, a * DT);

  const pressed = input.jump && !b.jumpHeld;
  b.jumpHeld = !!input.jump;
  b.buffer = pressed ? PHYS.buffer : Math.max(0, b.buffer - DT);
  b.coyote = b.grounded ? PHYS.coyote : Math.max(0, b.coyote - DT);
  if (b.buffer > 0 && b.coyote > 0) {
    b.vy = PHYS.jumpV;
    b.buffer = 0;
    b.coyote = 0;
    b.grounded = false;
    b.rising = true;
    if (ev) ev.jumped = true;
  }
  if (b.rising && !input.jump && b.vy > 0) {
    b.vy *= PHYS.jumpCut;
    b.rising = false;
  }
  if (b.vy <= 0) b.rising = false;
  const g = b.vy > 0 && input.jump ? PHYS.gravity : PHYS.fallGravity;
  b.vy = Math.max(-PHYS.maxFall, b.vy - g * DT);

  moveX(b, lv, b.vx * DT, ev);
  moveY(b, lv, b.vy * DT, ev);

  if (b.y < PHYS.killY) {
    b.dead = { x: b.x, y: b.y, cause: 'fell' };
    return b;
  }
  const hit = hazardHit(b, lv);
  if (hit) {
    b.dead = { x: b.x, y: b.y, cause: hit };
    return b;
  }
  if (overlapsGoal(b, lv)) b.won = true;
  return b;
}

function moveX(b, lv, dx, ev) {
  if (!dx) return;
  b.x += dx;
  const r0 = Math.floor(b.y + EPS);
  const r1 = Math.floor(b.y + PHYS.h - EPS);
  const c = dx > 0 ? Math.floor(b.x + PHYS.halfW - EPS) : Math.floor(b.x - PHYS.halfW + EPS);
  for (let r = r0; r <= r1; r++) {
    if (!solidAt(lv, c, r)) continue;
    b.x = dx > 0 ? c - PHYS.halfW : c + 1 + PHYS.halfW;
    b.vx = 0;
    if (ev && c >= 0 && c < lv.w && r < lv.h) ev.bumped = { c, r, side: dx > 0 ? -1 : 1 };
    return;
  }
}

function moveY(b, lv, dy, ev) {
  const wasGrounded = b.grounded;
  b.grounded = false;
  if (!dy) return;
  b.y += dy;
  const c0 = Math.floor(b.x - PHYS.halfW + EPS);
  const c1 = Math.floor(b.x + PHYS.halfW - EPS);
  if (dy < 0) {
    const r = Math.floor(b.y);
    const under = [];
    for (let c = c0; c <= c1; c++) if (solidAt(lv, c, r)) under.push(c);
    if (!under.length) return;
    b.y = r + 1;
    if (ev) ev.landed = { r, cols: under, hard: !wasGrounded ? -b.vy : 0 };
    b.vy = 0;
    b.grounded = true;
  } else {
    const r = Math.floor(b.y + PHYS.h - EPS);
    for (let c = c0; c <= c1; c++) {
      if (!solidAt(lv, c, r)) continue;
      b.y = r - PHYS.h;
      b.vy = 0;
      b.rising = false;
      if (ev && r < lv.h) ev.bonked = { c, r };
      return;
    }
  }
}

// Spikes point up (^) or down (v) and fill the lower or upper half of their tile; saws (x) fill most of it.
// The body's own box is shrunk a little, so a near miss is a miss.
const HAZARD_BOX = {
  2: [0.15, 0, 0.85, 0.5], // ^
  3: [0.15, 0.5, 0.85, 1], // v
  4: [0.12, 0.12, 0.88, 0.88], // x
};
const HAZARD_CAUSE = { 2: 'spikes', 3: 'spikes', 4: 'saw' };
const SHRINK = 0.06;

function hazardHit(b, lv) {
  const l = b.x - PHYS.halfW + SHRINK;
  const r = b.x + PHYS.halfW - SHRINK;
  const bot = b.y + SHRINK;
  const top = b.y + PHYS.h - SHRINK;
  for (let row = Math.floor(bot); row <= Math.floor(top); row++) {
    if (row < 0 || row >= lv.h) continue;
    for (let col = Math.floor(l); col <= Math.floor(r); col++) {
      if (col < 0 || col >= lv.w) continue;
      const k = lv.hazard[row * lv.w + col];
      if (!k) continue;
      const [x0, y0, x1, y1] = HAZARD_BOX[k];
      if (r > col + x0 && l < col + x1 && top > row + y0 && bot < row + y1) return HAZARD_CAUSE[k];
    }
  }
  return null;
}

function overlapsGoal(b, lv) {
  const g = lv.goal;
  return b.x + PHYS.halfW > g.x - 0.5 && b.x - PHYS.halfW < g.x + 0.5 && b.y + PHYS.h > g.y && b.y < g.y + 1.2;
}

export const HAZARD_KIND = { '^': 2, v: 3, x: 4 };
export { HAZARD_BOX };
