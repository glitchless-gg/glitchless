// Level data. Everything is on the x/y plane (z is just for looks).
//
// platforms: { x, y, w, h, kind }  x = left edge, y = TOP surface, h = thickness below the top
// movers:    { x, y, w, h, axis: 'x'|'y', range, period, phase }  (x/y = start position)
// bones:     { x, y, golden? }
// balls:     { x, y }   tennis balls → zoomies (speed boost)
// enemies:   { kind: 'squirrel'|'vacuum', x, minX, maxX, speed }  (y = snapped to the platform below)
// checkpoints: { x }    (y = snapped to the platform below)
// goal:      { x }

const BONE_Y = 0.7; // bones float this far above the surface

/** a straight run of bones on a surface at height `top` */
function boneLine(x0, x1, top, step = 1.2) {
  const out = [];
  for (let x = x0; x <= x1 + 1e-6; x += step) out.push({ x: +x.toFixed(2), y: top + BONE_Y });
  return out;
}

/** bones in a little arc over a gap (where the jump goes) */
function boneArc(x0, x1, top, height = 1.8, n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    out.push({ x: +(x0 + (x1 - x0) * t).toFixed(2), y: +(top + BONE_Y + Math.sin(t * Math.PI) * height).toFixed(2) });
  }
  return out;
}

export const LEVELS = [
  // ───────────────────────────────────────────── 1. BACKYARD
  {
    id: 'level-1',
    name: 'Backyard',
    theme: 'backyard',
    spawn: { x: 0, y: 0 },
    killY: -6,
    platforms: [
      { x: -8, y: 0, w: 26, h: 8, kind: 'ground' },
      { x: 10, y: 1.5, w: 1.5, h: 1.5, kind: 'crate' },
      { x: 20.5, y: 0, w: 14, h: 8, kind: 'ground' },
      { x: 25, y: 2.6, w: 4, h: 0.5, kind: 'plank' },
      { x: 37.5, y: 0.6, w: 17, h: 8.6, kind: 'ground' },
      { x: 58, y: 1.6, w: 9, h: 9.6, kind: 'ground' },
      { x: 69.5, y: 2.8, w: 3.5, h: 0.5, kind: 'plank' },
      { x: 76, y: 1.0, w: 26, h: 9, kind: 'ground' },
    ],
    movers: [],
    bones: [
      ...boneLine(3, 6.6, 0),
      { x: 10.75, y: 1.5 + BONE_Y },
      ...boneLine(13.5, 14.7, 0),
      ...boneArc(18.6, 19.9, 0, 1.6),
      ...boneLine(25.6, 28.4, 0, 1.4),
      ...boneLine(25.8, 28.2, 2.6, 1.2),
      ...boneArc(35.2, 36.8, 0.3, 1.8),
      ...boneLine(40.5, 42.9, 0.6),
      ...boneArc(55.2, 57.2, 0.6, 2.0),
      ...boneLine(59.5, 65.5, 1.6, 1.5),
      ...boneArc(67.6, 69, 1.6, 1.2, 2),
      ...boneLine(70.5, 72, 2.8, 1.5),
      ...boneArc(73.8, 75.4, 2.2, 1.0, 2),
      ...boneLine(78, 80.4, 1.0),
      ...boneLine(90.5, 94.1, 1.0),
    ],
    balls: [],
    enemies: [
      { kind: 'squirrel', x: 48, minX: 44, maxX: 53, speed: 2.2 },
      { kind: 'squirrel', x: 85, minX: 81, maxX: 89, speed: 2.6 },
    ],
    checkpoints: [{ x: 39.5 }, { x: 77.5 }],
    goal: { x: 97 },
    signs: [{ x: 2.5, text: 'ZOOMIES →' }],
  },

  // ───────────────────────────────────────────── 2. DOG PARK
  {
    id: 'level-2',
    name: 'Dog Park',
    theme: 'park',
    spawn: { x: 0, y: 0 },
    killY: -6,
    platforms: [
      { x: -8, y: 0, w: 60, h: 8, kind: 'ground' },
      { x: 62, y: 0.8, w: 16, h: 8.8, kind: 'ground' },
      { x: 88, y: 3.6, w: 14, h: 11.6, kind: 'ground' },
      { x: 106, y: 1.4, w: 22, h: 9.4, kind: 'ground' },
      { x: 112, y: 2.6, w: 3, h: 1.2, kind: 'bench' },
      { x: 116.5, y: 5.2, w: 3, h: 0.5, kind: 'plank' },
      { x: 142, y: 0, w: 40, h: 8, kind: 'ground' },
    ],
    movers: [
      { x: 53, y: 0, w: 3, h: 0.5, axis: 'x', range: 5, period: 3.6, phase: 0 },
      { x: 81.5, y: 0, w: 3, h: 0.5, axis: 'y', range: 3.2, period: 4, phase: 0 },
      { x: 129, y: 1.4, w: 3, h: 0.5, axis: 'x', range: 3, period: 3.2, phase: 0 },
      { x: 135.5, y: 1.4, w: 3, h: 0.5, axis: 'x', range: 3, period: 3.2, phase: 0 },
    ],
    bones: [
      ...boneLine(-3, -0.6, 0),
      // the "bone river" right after the first tennis ball — very zoomies-friendly
      ...boneLine(12.5, 30.1, 0, 1.1),
      ...boneArc(37.5, 44.5, 0, 2.6, 5),
      ...boneArc(53.5, 60.5, 0.4, 1.4, 4),
      ...boneLine(64.5, 66.9, 0.8),
      ...boneArc(79, 87, 1.5, 2.4, 5),
      ...boneLine(90, 92.4, 3.6),
      ...boneArc(102.4, 105.6, 3.6, 0.8, 3),
      ...boneLine(108, 110.4, 1.4),
      { x: 118, y: 5.2 + 0.85, golden: true },
      ...boneArc(129.5, 140.5, 1.4, 1.6, 6),
      // second bone river after the last tennis ball
      ...boneLine(149, 162.2, 0, 1.1),
      ...boneLine(171, 173.4, 0),
    ],
    balls: [
      { x: 9, y: 0.9 },
      { x: 68, y: 0.8 + 1.9 },
      { x: 123, y: 1.4 + 0.9 },
      { x: 146, y: 0.9 },
    ],
    enemies: [
      { kind: 'vacuum', x: 40, minX: 36, maxX: 46, speed: 2.4 },
      { kind: 'vacuum', x: 74, minX: 70, maxX: 77, speed: 2.6 },
      { kind: 'vacuum', x: 96, minX: 92, maxX: 101, speed: 2.8 },
      { kind: 'vacuum', x: 166, minX: 164, maxX: 169, speed: 2.4 },
    ],
    checkpoints: [{ x: 64 }, { x: 108 }, { x: 143.5 }],
    goal: { x: 177 },
    signs: [{ x: 3.5, text: 'DOG PARK' }],
  },

  // ───────────────────────────────────────────── 3. ROOFTOPS
  {
    id: 'level-3',
    name: 'Rooftops',
    theme: 'rooftops',
    spawn: { x: 0, y: 0 },
    killY: -7,
    platforms: [
      { x: -6, y: 0, w: 20, h: 14, kind: 'roof' },
      { x: 8, y: 1.1, w: 1.6, h: 1.1, kind: 'ac' },
      { x: 17.5, y: 1.2, w: 12.5, h: 15.2, kind: 'roof' },
      { x: 33.5, y: 0, w: 8.5, h: 14, kind: 'roof' },
      // GLITCHLESS-DEMO: Leap of Faith — 6u gap (x 42→48) onto a roof 1.8u higher. Only makeable with a
      // full-speed running jump pressed in the last ~60ms around the edge (coyote time); see README.
      { x: 48, y: 1.8, w: 14, h: 15.8, kind: 'roof' },
      { x: 66.5, y: 0.2, w: 10.5, h: 14.2, kind: 'roof' },
      { x: 80.5, y: 2.0, w: 3, h: 0.4, kind: 'scaffold' },
      { x: 87, y: 2.6, w: 16, h: 16.6, kind: 'roof' },
      { x: 107, y: 1.0, w: 20, h: 15, kind: 'roof' },
    ],
    movers: [],
    gaps: [{ name: 'The Leap of Faith', x0: 42, x1: 48 }],
    bones: [
      ...boneLine(2, 5.6, 0),
      { x: 8.8, y: 1.1 + BONE_Y },
      ...boneArc(14.5, 17, 0.6, 1.6),
      ...boneLine(19, 20.2, 1.2),
      ...boneArc(30.6, 33, 0.6, 1.6),
      ...boneLine(36, 38.4, 0),
      // a tempting trail over the Leap of Faith
      ...boneArc(43.2, 46.8, 1.2, 2.0, 4),
      ...boneLine(52, 55.6, 1.8),
      ...boneArc(62.8, 65.8, 1.0, 1.6),
      ...boneArc(77.6, 80, 1.0, 1.4, 2),
      ...boneLine(81.2, 82.6, 2.0, 1.4),
      ...boneArc(84, 86.4, 2.3, 1.2, 2),
      ...boneLine(88.5, 90.9, 2.6),
      ...boneArc(103.6, 106.4, 1.8, 1.4),
      ...boneLine(108.5, 110.9, 1.0),
      ...boneLine(119, 121.4, 1.0),
    ],
    balls: [],
    enemies: [
      { kind: 'squirrel', x: 25, minX: 21, maxX: 29, speed: 2.6 },
      { kind: 'squirrel', x: 72, minX: 69, maxX: 76, speed: 3.0 },
      { kind: 'vacuum', x: 96, minX: 92, maxX: 101, speed: 3.0 },
      { kind: 'squirrel', x: 115, minX: 112, maxX: 118, speed: 3.2 },
    ],
    checkpoints: [{ x: 35 }, { x: 50.5 }, { x: 89 }],
    goal: { x: 123 },
    signs: [{ x: 39.6, text: 'THE LEAP OF FAITH' }],
  },
];

export function getLevelIndex(id) {
  return LEVELS.findIndex((l) => l.id === id);
}

/** Highest surface (static or mover) under x, at or below `fromY` — used to snap entities. */
export function surfaceYAt(level, x, fromY = Infinity) {
  let best = -Infinity;
  for (const p of level.platforms) {
    if (x >= p.x && x <= p.x + p.w && p.y <= fromY && p.y > best) best = p.y;
  }
  return best === -Infinity ? 0 : best;
}

/** Bounds of the level in world units (x/y) — used for Glitchless heatmap thumbnails. */
export function levelBounds(level) {
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of [...level.platforms, ...level.movers]) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w + (p.axis === 'x' ? p.range : 0));
    maxY = Math.max(maxY, p.y + (p.axis === 'y' ? p.range : 0));
  }
  return {
    min: [Math.floor(minX - 1), level.killY - 1],
    max: [Math.ceil(maxX + 1), Math.ceil(maxY + 6)],
  };
}
