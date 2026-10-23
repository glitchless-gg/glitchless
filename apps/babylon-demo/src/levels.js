// The two gardens. Positions come from a fixed seed per level, so every run plays the same layout.
import { mulberry32 } from './bot.js';

export const ARENA = 18; // the marble stays within ±ARENA on x and z

function scatter(seed, n, minR = 4) {
  const rng = mulberry32(seed);
  const out = [];
  while (out.length < n) {
    const x = (rng() * 2 - 1) * (ARENA - 2);
    const z = (rng() * 2 - 1) * (ARENA - 2);
    if (Math.hypot(x, z) < minR || out.some(([a, b]) => Math.hypot(a - x, b - z) < 3)) continue;
    out.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  }
  return out;
}

export const LEVELS = [
  {
    id: 'meadow',
    name: 'Meadow',
    sky: [0.05, 0.08, 0.2],
    ground: [0.16, 0.36, 0.22],
    seeds: scatter(11, 12),
    prisms: scatter(12, 3, 6),
    // [x, z, orbit radius, speed (rad/s)]
    mines: [
      [-8, 6, 3, 0.9],
      [9, -5, 4, 0.7],
      [2, 11, 3, 1.1],
    ],
    powerups: [{ kind: 'boost', at: [-12, -12] }],
  },
  {
    id: 'nebula',
    name: 'Nebula',
    sky: [0.12, 0.04, 0.2],
    ground: [0.24, 0.18, 0.4],
    seeds: scatter(21, 14),
    prisms: scatter(22, 5, 6),
    mines: [
      [-9, 8, 3, 1.2],
      [8, -7, 4, 1.0],
      [0, 0, 7, 0.6],
      [12, 10, 2.5, 1.5],
      [-11, -9, 3, 1.3],
    ],
    // GLITCHLESS-DEMO: the comet has no entry in POWERUPS (see game.js).
    powerups: [
      { kind: 'boost', at: [13, -13] },
      { kind: 'comet', at: [-6, 13] },
    ],
  },
];
