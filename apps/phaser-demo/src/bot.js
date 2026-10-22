// The autoplay bot. It runs the same jump code a player triggers: it picks a takeoff point for each
// hazard ahead, then misses it by a random amount that grows as skill drops. Fixed seed, same run.

const AIRTIME_S = 0.8; // jump speed 720 px/s against gravity 1800 px/s²

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
    this.sigma = 6 + (1 - skill) * 70; // px of takeoff error
    this.offsets = new Map(); // hazard → this attempt's error
    this.deathSpots = [];
  }

  gauss() {
    const u = 1 - this.rng();
    const v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Each attempt at a level misses its jumps differently.
  newAttempt() {
    this.offsets.clear();
  }

  // Hazards ahead of x, with the takeoff point a perfect player would use.
  hazards(level, speed) {
    const reach = speed * AIRTIME_S;
    const out = [];
    for (const [a, b] of level.pits) out.push({ id: `pit${a}`, x: a, end: b, takeoff: a - (reach - (b - a)) / 2 });
    for (const h of level.hydrants) out.push({ id: `hyd${h}`, x: h - 12, end: h + 12, takeoff: h - reach / 2 });
    return out.sort((p, q) => p.x - q.x);
  }

  // True when the dog should jump this frame.
  wantsJump({ x, speed, grounded, level, squirrels }) {
    if (!grounded) return false;
    const list = this.hazards(level, speed);
    for (const s of squirrels) if (s.alive && s.x > x) list.push({ id: `sq${s.id}`, x: s.x - 16, end: s.x + 16, takeoff: s.x - speed * AIRTIME_S * 0.45 });
    list.sort((p, q) => p.x - q.x);
    const next = list.find((h) => h.end > x);
    if (!next) return false;
    if (!this.offsets.has(next.id)) this.offsets.set(next.id, this.gauss() * this.sigma);
    const target = next.takeoff + this.offsets.get(next.id);
    // Missed the planned spot but the hazard is still ahead: jump now, late.
    return x >= target && x < next.x + 4;
  }

  // Low-skill bots give up after dying three times in the same place.
  died(x) {
    this.deathSpots.push(Math.round(x / 120));
    const here = this.deathSpots.filter((s) => s === Math.round(x / 120)).length;
    return this.skill < 0.5 && here >= 3;
  }
}
