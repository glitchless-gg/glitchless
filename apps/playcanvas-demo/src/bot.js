// The autoplay bot. It steers the board the way a player's keys do: away from the barriers it sees coming, and toward
// sparks, boost pads and power-ups. Lower skill sees barriers later and drifts. Fixed seed, same run.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Bot {
  constructor({ skill, seed, lanes }) {
    this.skill = skill;
    this.lanes = lanes;
    this.row = null;
    this.lane = 0;
    this.rng = mulberry32(seed);
    this.drift = 0;
    this.deaths = 0;
  }

  // Steering for this frame, -1..1 across the track. `ahead` lists what is in front: { x, z, width?, kind }. Barrier
  // rows block one or two of the lanes; it picks the open lane nearest to what it wants, once per row.
  steer(board, ahead, speed) {
    const sight = speed * (0.4 + this.skill * 0.6);
    const near = ahead.filter((o) => o.kind !== 'barrier' && o.x - board.x > 1 && o.x - board.x < 25);
    const want = near.find((o) => o.kind !== 'spark') || near[0]; // boost pads and power-ups first
    let target = want ? want.z : board.z;
    const row = ahead.find((o) => o.kind === 'barrier' && o.x - board.x > -0.6 && o.x - board.x < sight);
    if (row) {
      if (this.row !== row.x) {
        const blocked = ahead.filter((o) => o.kind === 'barrier' && o.x === row.x).map((o) => o.z);
        const open = this.lanes.filter((z) => !blocked.includes(z));
        this.row = row.x;
        this.lane = open.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? target;
      }
      target = this.lane;
    }
    this.drift += (this.rng() - 0.5) * 0.3;
    this.drift *= 0.97;
    const z = target + this.drift * (1 - this.skill) * 4;
    const d = z - board.z;
    return Math.abs(d) < 0.1 ? 0 : Math.max(-1, Math.min(1, d * 2));
  }

  // Low-skill bots give up after losing all their lives twice.
  outOfLives() {
    this.deaths++;
    return this.skill < 0.5 && this.deaths >= 2;
  }
}
