// The autoplay bot's brain. It knows the level (the bot reads the map; players can't) and, each time it
// lands, tries a few dozen short moves ("run 6 frames, jump, hold 8, drift left") on a copy of the body,
// keeping the one that lands fewest moves from the goal (routeField, below). Then it plays that move
// with its timing smudged by (1 - skill), which is what makes it die a lot, and where players die too.
import { step, cloneBody, createBody } from './physics.js';
import { createRng } from './rng.js';

const WAITS = [1, 6, 14];
const HOLDS = [3, 8, 18];
const MAX_MOVE_STEPS = 150;

const MOVES = [];
for (const dir of [1, -1, 0]) {
  for (const wait of WAITS) MOVES.push({ dir, wait, hold: 0, airDir: dir, airSwitch: 0 });
  for (const wait of WAITS) {
    for (const hold of HOLDS) {
      const drifts = dir ? [[dir, 0], [0, 10], [-dir, 10]] : [[0, 0], [1, 6], [-1, 6]];
      for (const [airDir, airSwitch] of drifts) MOVES.push({ dir, wait, hold, airDir, airSwitch });
    }
  }
}

// Places to stand, in half tiles: (x * 2, feet row).
const spot = (b) => `${Math.floor(b.x * 2)},${Math.round(b.y)}`;

/**
 * How far each place to stand is from the goal, in frames of moves. Explores every landing reachable from
 * the spawn by the same moves the bot plays (from rest, an approximation), then walks back from the goal.
 * A straight line through the air would send the bot into dead ends on a level that zigzags up.
 */
export function routeField(lv) {
  const edges = new Map(); // spot → [{ to, cost }]
  const starts = new Map([[spot(lv.spawn), lv.spawn]]);
  const queue = [lv.spawn];
  while (queue.length) {
    const at = queue.shift();
    const from = spot(at);
    const out = [];
    for (const m of MOVES) {
      const res = rollout(createBody(at), m, lv);
      if (res.b.dead || res.timeout) continue;
      const to = res.b.won ? 'goal' : spot(res.b);
      if (to === from) continue;
      out.push({ to, cost: res.f + 20 });
      if (to !== 'goal' && !starts.has(to)) {
        const p = { x: res.b.x, y: Math.round(res.b.y) };
        starts.set(to, p);
        queue.push(p);
      }
    }
    edges.set(from, out);
  }
  // Back from the goal (Dijkstra over the reversed edges; the graph is small).
  const dist = new Map([['goal', 0]]);
  const done = new Set();
  for (;;) {
    let best = null;
    for (const [k, d] of dist) if (!done.has(k) && (best === null || d < dist.get(best))) best = k;
    if (best === null) break;
    done.add(best);
    for (const [from, out] of edges) {
      for (const e of out) {
        if (e.to !== best) continue;
        const d = dist.get(best) + e.cost;
        if (d < (dist.get(from) ?? Infinity)) dist.set(from, d);
      }
    }
  }
  return { dist, spots: starts.size };
}

const fields = new WeakMap();
function fieldOf(lv) {
  if (!fields.has(lv)) fields.set(lv, routeField(lv));
  return fields.get(lv);
}

export function moveInput(m, f) {
  const dir = m.hold && f >= m.wait + m.airSwitch ? m.airDir : m.dir;
  const jump = m.hold > 0 && f >= m.wait && f < m.wait + m.hold;
  return { left: dir < 0, right: dir > 0, jump };
}

/** Is the move over, given the body after its f-th step? */
export function moveDone(m, f, b) {
  if (b.dead || b.won) return true;
  // A move always ends on the ground, so walking off an edge is judged by where it lands.
  if (!m.hold) return f + 1 >= m.wait && b.grounded;
  return f > m.wait + 2 && b.grounded;
}

function rollout(body, m, lv) {
  const b = cloneBody(body);
  for (let f = 0; f < MAX_MOVE_STEPS; f++) {
    step(b, moveInput(m, f), lv);
    if (moveDone(m, f, b)) return { b, f };
  }
  return { b, f: MAX_MOVE_STEPS, timeout: true };
}

function where(field, b) {
  return field.dist.get(spot(b)) ?? Infinity;
}

function score(field, res) {
  if (res.b.won) return 1e6 - res.f;
  if (res.b.dead) return -1e6;
  const d = where(field, res.b);
  // Somewhere the explorer never stood: better than dying, worse than any known way on.
  return (Number.isFinite(d) ? -d : -5e5) - res.f - 20 - (res.timeout ? 50 : 0);
}

/** The best move from here, or null if every move dies. */
export function plan(lv, field, body) {
  let best = null;
  let bestScore = -Infinity;
  for (const m of MOVES) {
    const s = score(field, rollout(body, m, lv));
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return { move: best, score: bestScore };
}

/**
 * A player for one level at a time. Each fixed step, `input(body)` returns { left, right, jump }.
 * skill 1 plays its plan exactly; lower skill smudges the timing and sometimes picks a worse move.
 */
export function createBot(lv, { skill = 0.6, seed = 1 } = {}) {
  const rng = createRng(seed);
  const field = fieldOf(lv);
  const sigma = (1 - skill) * 4.5;
  let move = null;
  let f = 0;
  let stuck = 0;
  let lastD = Infinity;

  const smudge = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v + rng.gauss() * sigma)));

  function choose(body) {
    const { move: best, score: s } = plan(lv, field, body);
    const d = where(field, body);
    stuck = d < lastD ? 0 : stuck + 1;
    lastD = Math.min(lastD, d);
    let m = best;
    // No way forward found (or going round in circles): try something, like a person would.
    if (!m || s <= -1e6 || stuck > 8) m = { dir: rng.chance(0.75) ? 1 : -1, wait: rng.int(1, 12), hold: rng.pick([0, 4, 10, 18]), airDir: rng.pick([-1, 0, 1]), airSwitch: rng.int(0, 12) };
    if (skill < 1) {
      m = {
        ...m,
        wait: smudge(m.wait, 1, 40),
        hold: m.hold ? smudge(m.hold, 1, 24) : 0,
        airSwitch: smudge(m.airSwitch, 0, 30),
      };
    }
    return m;
  }

  return {
    input(body) {
      if (!move) {
        move = choose(body);
        f = 0;
      }
      return moveInput(move, f);
    },
    /** Call after the step the input was used for. */
    after(body) {
      if (!move) return;
      if (moveDone(move, f, body) || f >= MAX_MOVE_STEPS) move = null;
      else f++;
    },
    reset() {
      move = null;
      f = 0;
      stuck = 0;
      lastD = Infinity;
    },
  };
}
