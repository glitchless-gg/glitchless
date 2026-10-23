// The autoplay bot. It steers the marble the way a player's keys do: toward the nearest thing left to collect, and
// away from spore mines it sees coming. Lower skill reacts later and wobbles more. Fixed seed, same run.

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
  constructor({ skill, seed }) {
    this.skill = skill;
    this.rng = mulberry32(seed);
    this.wobble = 0;
    this.deaths = 0;
  }

  // Input for this frame, each axis in -1..1. `targets` and `mines` are { x, z }.
  steer(player, targets, mines) {
    let tx = 0;
    let tz = 0;
    const next = targets.reduce((best, t) => (!best || dist(player, t) < dist(player, best) ? t : best), null);
    if (next) {
      const d = dist(player, next) || 1;
      tx = (next.x - player.x) / d;
      tz = (next.z - player.z) / d;
    }
    // A worse player notices mines later and dodges less.
    const sight = 2.5 + this.skill * 3.5;
    for (const m of mines) {
      const d = dist(player, m);
      if (d > sight || d === 0) continue;
      const push = ((sight - d) / sight) * (1 + this.skill * 2);
      tx += ((player.x - m.x) / d) * push;
      tz += ((player.z - m.z) / d) * push;
    }
    this.wobble += (this.rng() - 0.5) * 0.4;
    this.wobble *= 0.95;
    const noise = (1 - this.skill) * 0.9;
    tx += Math.cos(this.wobble * 6) * noise;
    tz += Math.sin(this.wobble * 6) * noise;
    const len = Math.hypot(tx, tz) || 1;
    return { x: tx / len, z: tz / len };
  }

  // Low-skill bots give up after losing all their lives twice.
  outOfLives() {
    this.deaths++;
    return this.skill < 0.5 && this.deaths >= 2;
  }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
