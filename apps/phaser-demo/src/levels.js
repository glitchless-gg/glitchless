// Level data, plain numbers in pixels. The ground's top is at GROUND_Y; x grows to the right.
//   pits       [start, end] gaps in the ground
//   hydrants   x of a hydrant to jump over
//   squirrels  [x, patrol half-width]
//   bones      [x, height above the ground]
//   balls      x of a tennis ball (zoomies: faster for a few seconds, and confetti)
//   frisbees   [x, height above the ground]
//   checkpoints x where a lost life restarts

export const GROUND_Y = 460;
export const VIEW = { width: 960, height: 540 };

export const LEVELS = [
  {
    id: 'level-1',
    name: 'Backyard',
    length: 3600,
    pits: [[900, 1010], [1700, 1820], [2600, 2730]],
    hydrants: [600, 1350, 2150, 3050],
    squirrels: [[2350, 90]],
    bones: [[400, 30], [450, 30], [500, 30], [955, 150], [1200, 30], [1250, 30], [1760, 150], [2000, 30], [2665, 150], [3200, 30], [3250, 30]],
    balls: [1300],
    frisbees: [],
    checkpoints: [1200, 2490],
    goal: 3450,
  },
  {
    id: 'level-2',
    name: 'Dog Park',
    length: 4400,
    pits: [[700, 830], [1500, 1640], [2450, 2600], [3300, 3490]], // GLITCHLESS-DEMO: the Long Jump, 3300-3490
    hydrants: [1000, 1900, 2850, 3560, 4080],
    squirrels: [[1280, 50], [2200, 100], [3780, 80]],
    bones: [[300, 30], [350, 30], [765, 150], [1000, 30], [1570, 150], [2050, 30], [2100, 30], [2525, 150], [3395, 160], [4150, 30]],
    balls: [600, 2000],
    frisbees: [],
    checkpoints: [1400, 2700],
    goal: 4250,
  },
  {
    id: 'level-3',
    name: 'Rooftops',
    length: 4000,
    pits: [[650, 780], [1150, 1290], [2050, 2200], [2900, 3050]],
    hydrants: [950, 1550, 2450, 3300, 3600],
    squirrels: [[1800, 90], [2650, 80]],
    bones: [[400, 30], [715, 150], [1220, 150], [1650, 30], [2125, 150], [2975, 150], [3450, 30]],
    balls: [1650],
    frisbees: [[1570, 125]], // GLITCHLESS-DEMO: catching it crashes the game
    checkpoints: [1000, 2300],
    goal: 3850,
  },
];

// Ground pieces between the pits.
export function groundSegments(level) {
  const out = [];
  let x = -200;
  for (const [a, b] of [...level.pits].sort((p, q) => p[0] - q[0])) {
    out.push([x, a]);
    x = b;
  }
  out.push([x, level.length + 400]);
  return out;
}
