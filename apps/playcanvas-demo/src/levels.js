// The two tracks. They run along +x; the board steers across z, between the rails at z = ±HALF. Layouts come from a
// fixed seed per level, so every run plays the same track.
import { mulberry32 } from './bot.js';

export const HALF = 4.5;
export const LANES = [-3, 0, 3];
const LANE_WIDTH = 2.6;

// Barrier rows block one or two of the three lanes. Boost pads and power-ups sit in an open lane, between rows.
function track(seed, { length, rowEvery, pads, extras = [] }) {
  const rng = mulberry32(seed);
  const barriers = [];
  const rows = [];
  for (let x = 60; x < length - 20; x += Math.round(rowEvery * (0.8 + rng() * 0.4))) {
    const blocked = LANES.filter(() => rng() < 0.5);
    if (!blocked.length) blocked.push(LANES[Math.floor(rng() * 3)]);
    if (blocked.length === 3) blocked.splice(Math.floor(rng() * 3), 1);
    rows.push(x);
    for (const z of blocked) barriers.push({ x, z, width: LANE_WIDTH });
  }
  const clear = (x) => rows.every((r) => Math.abs(r - x) > 10);
  const lane = () => LANES[Math.floor(rng() * 3)];
  const sparks = [];
  for (let x = 25; x < length - 10; x += 22) {
    if (!clear(x) || !clear(x + 8)) continue;
    const z = lane();
    for (let i = 0; i < 4; i++) sparks.push({ x: x + i * 2.5, z });
  }
  // Moved along until clear of barrier rows.
  const place = (x) => {
    while (!clear(x)) x += 3;
    return x;
  };
  return {
    length,
    barriers,
    sparks,
    pads: pads.map((x) => ({ x: place(x), z: lane() })),
    extras: extras.map((e) => ({ ...e, x: place(e.x), z: e.z ?? lane() })),
  };
}

export const LEVELS = [
  { id: 'canyon', name: 'Canyon', speed: 20, ground: [0.55, 0.32, 0.2], sky: [0.95, 0.62, 0.42], ...track(31, { length: 560, rowEvery: 42, pads: [150, 330, 470] }) },
  {
    id: 'skyway',
    name: 'Skyway',
    speed: 24,
    ground: [0.25, 0.3, 0.45],
    sky: [0.3, 0.45, 0.75],
    // GLITCHLESS-DEMO: the magnet has no entry in POWERUPS (see game.js).
    ...track(41, { length: 620, rowEvery: 34, pads: [120, 260, 400, 520], extras: [{ kind: 'shield', x: 200 }, { kind: 'magnet', x: 330 }] }),
  },
];
