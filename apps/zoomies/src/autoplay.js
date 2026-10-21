// Autoplay bot: ?autoplay=1&skill=0..1&seed=N
//
// Runs right, and when something is coming up (a ledge, a wall, an enemy, a tennis ball) it
// simulates a handful of "jump in k steps" options with the real physics, picks the middle of the
// window that works, then adds human-ish timing noise. Lower skill = more noise, more hesitation,
// panic jumps and impatience on moving platforms. Deterministic per seed (fixed-step sim).
import { PHYS } from './physics.js';
import { stepPlay, clonePlay } from './sim.js';
import { createRng } from './rng.js';

const STEP = PHYS.STEP;
const MAX_SIM = 240;

export function createAutoplay({ skill, seed, onRageQuit, onFinished }) {
  const rng = createRng(seed);
  const sigmaSteps = (0.012 + (1 - skill) * 0.09) / STEP; // jump timing noise (1σ)
  const pHesitate = 0.04 + (1 - skill) * 0.32;
  const pPanic = (1 - skill) * 0.1;
  const deathsBySpot = new Map();

  const input = { left: false, right: false, jump: false };
  const bot = {
    skill,
    seed,
    halted: false,
    reason: null,
    input,
    plan: null,
    hes: 0,
    backups: 0,
    holding: false,
    sinceJump: 0,
    menuT: 0,
    menuWait: 0.6,
    rageIn: -1,
    lastThreatKey: null,
    skip: new Set(),
    stats: { plans: 0, sims: 0 },
  };

  // ── look-ahead ------------------------------------------------------------------------------

  function trial(play, delay, threat) {
    bot.stats.sims++;
    const s = clonePlay(play);
    const b = s.body;
    b.jumpWasDown = false;
    let since = -1;
    let released = false;
    let touched = false;
    let okAt = -1;
    const startGround = b.ground;
    const balls = (bot.world?.balls || []).filter((ball) => !ball.collected);
    for (let i = 0; i < MAX_SIM; i++) {
      let jump = false;
      if (i === delay) since = 0;
      if (since >= 0 && !released) {
        jump = since < 3 || b.vy > 0;
        if (!jump) released = true;
        since++;
      }
      const ev = stepPlay(s, { left: false, right: true, jump }, STEP);
      if (ev.hit || ev.fell) return false;
      for (let j = 0; j < balls.length; j++) {
        // tennis balls change our speed mid-air — predict that too
        if (balls[j] && Math.hypot(balls[j].x - b.x, balls[j].y - b.y - PHYS.HEIGHT / 2) < 0.75) {
          b.zoomies = 3;
          balls[j] = null;
        }
      }
      if (threat.kind === 'ball' && Math.hypot(b.x - threat.ball.x, b.y + 0.4 - threat.ball.y) < 0.75) touched = true;
      if (okAt >= 0) {
        if (i - okAt >= 18) return true; // landed and survived a beat afterwards
        continue;
      }
      if (!b.grounded || (delay !== Infinity && i < delay)) continue;
      let ok = false;
      if (threat.kind === 'ball') {
        ok = touched && i > delay + 2;
      } else if (threat.kind === 'enemy') {
        const e = s.enemies[threat.index];
        ok = !e.alive || b.x - PHYS.HALF_W > e.x + e.hw + 0.05;
      } else {
        ok = threat.kind === 'edge' ? b.ground !== startGround && b.x - PHYS.HALF_W > threat.x : b.x > threat.x + 0.35;
      }
      if (ok) okAt = i;
    }
    return false;
  }

  function makePlan(play, threat) {
    bot.stats.plans++;
    const b = play.body;
    if (threat.kind !== 'ball' && trial(play, Infinity, threat)) return { type: 'walk', untilX: threat.x + 0.6, key: threat.key };
    const speed = Math.max(2.5, Math.abs(b.vx));
    const K = Math.min(140, Math.ceil((threat.x + 1.3 - b.x) / speed / STEP) + 16);
    let lo = -1;
    let hi = -1;
    for (let k = 0; k <= K; k += 2) {
      if (trial(play, k, threat)) {
        if (lo < 0) lo = k;
        hi = k;
      } else if (lo >= 0) break;
    }
    if (lo < 0) return null;
    const center = (lo + hi) / 2;
    let k = Math.round(center + rng.gauss() * sigmaSteps);
    if (rng.chance(pPanic)) k = rng.int(0, Math.max(0, lo - 1)); // nervous early jump
    return { type: 'jump', k: Math.max(0, k), lo, hi, key: threat.key, threat, zoom: b.zoomies > 0 };
  }

  function supportEdge(play) {
    const b = play.body;
    const g = b.ground;
    if (!g) return null;
    let edge = g.x + g.w;
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of play.solids) {
        if (s === g || s.axis || s.kind === 'wall') continue;
        if (Math.abs(s.y - g.y) < 0.05 && s.x <= edge + 0.05 && s.x + s.w > edge + 0.05) {
          edge = s.x + s.w;
          grew = true;
        }
      }
    }
    return edge;
  }

  function findThreat(play, world) {
    const b = play.body;
    const look = Math.max(4, Math.abs(b.vx) * 0.85 + 1.5);
    let best = null;
    const goalX = world.goal ? world.goal.x : Infinity;
    const consider = (t) => {
      if (t.x > goalX) return; // nothing past the finish flag matters
      if (!best || t.x < best.x) best = t;
    };
    const edge = supportEdge(play);
    if (edge !== null && edge - b.x < look) consider({ kind: 'edge', x: edge, key: `edge:${edge.toFixed(1)}` });
    for (const s of play.solids) {
      if (s === b.ground || s.kind === 'wall') continue;
      if (s.x < b.x + PHYS.HALF_W - 0.05 || s.x - b.x > look) continue;
      if (s.y <= b.y + 0.05) continue;
      if (s.y - s.h >= b.y + PHYS.HEIGHT) continue;
      consider({ kind: 'wall', x: s.x, key: `wall:${s.x.toFixed(1)}` });
    }
    play.enemies.forEach((e, index) => {
      if (!e.alive) return;
      const dx = e.x - e.hw - (b.x + PHYS.HALF_W);
      if (dx < -0.3 || dx > look + 1.5) return;
      if (Math.abs(e.y - b.y) > 1.0) return;
      consider({ kind: 'enemy', x: e.x - e.hw, index, key: `enemy:${index}` });
    });
    for (const ball of world.balls) {
      if (ball.collected || bot.skip.has(`ball:${ball.x}`)) continue;
      const dx = ball.x - b.x;
      const dy = ball.y - b.y;
      if (dx > 0.5 && dx < 4 && dy > 1.3 && dy < 3.4) consider({ kind: 'ball', x: ball.x - 2.5, ball, key: `ball:${ball.x}` });
    }
    return best;
  }

  // ── per-step driving -------------------------------------------------------------------------

  function press() {
    input.jump = true;
    bot.holding = true;
    bot.sinceJump = 0;
  }

  /** called once per fixed step while playing; returns the input to use */
  bot.step = (game) => {
    input.left = false;
    input.right = true;
    input.jump = false;
    if (bot.halted) {
      input.right = false;
      return input;
    }
    const play = game.play;
    const b = play.body;
    bot.world = game.world;

    // finish an in-progress jump (hold until the apex)
    if (bot.holding) {
      bot.sinceJump++;
      if (bot.sinceJump < 3 || b.vy > 0) {
        input.jump = true;
        return input;
      }
      bot.holding = false;
    }

    if (bot.hes > 0) {
      bot.hes--;
      input.right = false;
      if (bot.backingUp) input.left = true;
      else if (b.grounded && b.vx > 0) {
        // pull back so we don't slide off the ledge we're staring at
        const edge = supportEdge(play);
        if (edge !== null && edge - b.x < (b.vx * b.vx) / (2 * PHYS.DECEL_GROUND) + 0.4) input.left = true;
      }
      if (bot.hes === 0) {
        bot.plan = null;
        bot.backingUp = false;
      }
      return input;
    }

    // existing plan (runs even mid-air: some jumps are timed into coyote time)
    const plan = bot.plan;
    if (plan) {
      if (plan.type === 'walk') {
        if (b.x > plan.untilX) bot.plan = null;
        else return input;
      } else if (plan.type === 'jump') {
        if (plan.zoom !== undefined && plan.zoom !== b.zoomies > 0 && b.grounded) {
          bot.plan = null; // speed changed under us — rethink
          return input;
        }
        if (plan.k <= 0) {
          bot.plan = null;
          press();
          return input;
        }
        plan.k--;
        return input;
      } else if (plan.type === 'wait') {
        plan.t += STEP;
        // brake near the edge
        const room = plan.x - b.x;
        if (room < 0.9) {
          input.right = false;
          if (b.vx > 0.5 && room < 0.6) input.left = true;
        }
        plan.retry--;
        if (plan.retry <= 0) {
          plan.retry = 6;
          for (let k = 0; k <= 6; k += 2) {
            if (trial(play, k, plan.threat)) {
              bot.plan = { type: 'jump', k: Math.max(0, k + Math.round(rng.gauss() * sigmaSteps * 0.5)), key: plan.key };
              return input;
            }
          }
          if (plan.t > plan.patience && rng.chance(1 - skill)) {
            // got bored waiting for the platform — just go for it
            bot.plan = null;
            press();
            return input;
          }
        }
        return input;
      }
    }

    if (!b.grounded) return input;

    const threat = findThreat(play, game.world);
    if (!threat) {
      bot.backups = 0;
      return input;
    }

    // a brand-new obstacle: maybe hesitate first (a human glancing at the gap)
    if (threat.key !== bot.lastThreatKey) {
      bot.lastThreatKey = threat.key;
      bot.backups = 0;
      if (threat.kind !== 'ball' && threat.x - b.x > 2.5 && rng.chance(pHesitate)) {
        bot.hes = Math.round(rng.range(0.15, 0.4 + (1 - skill) * 0.7) / STEP);
        input.right = false;
        return input;
      }
    }

    const p = makePlan(play, threat);
    if (p) {
      bot.plan = p;
      if (p.type === 'jump' && p.k <= 0) {
        bot.plan = null;
        press();
      }
      return input;
    }
    if (threat.kind === 'ball') {
      bot.skip.add(threat.key); // can't reach it from here — no big deal
      return input;
    }

    const moverNear = play.movers.some((m) => m.x < threat.x + 10 && m.x + m.w + (m.axis === 'x' ? m.range : 0) > threat.x - 3);
    if (moverNear || bot.backups >= 2) {
      bot.plan = { type: 'wait', x: threat.x, threat, key: threat.key, t: 0, retry: 0, patience: rng.range(0.8, 3.5) * (0.3 + skill) };
      if (bot.backups >= 2 && !moverNear) {
        // tried twice, still no clean line: leap of faith
        bot.plan = { type: 'jump', k: Math.max(0, Math.round((threat.x - b.x) / Math.max(1, b.vx) / STEP)), key: threat.key };
      }
      return input;
    }
    // not enough run-up: back off and try again
    bot.backups++;
    bot.backingUp = true;
    bot.hes = Math.round(rng.range(0.3, 0.6) / STEP);
    input.right = false;
    input.left = true;
    return input;
  };

  bot.onRespawn = () => {
    bot.skip.clear();
    bot.plan = null;
    bot.holding = false;
    bot.hes = 0;
    bot.lastThreatKey = null;
  };

  bot.onDeath = (x) => {
    const spot = Math.floor(x / 4);
    const n = (deathsBySpot.get(spot) || 0) + 1;
    deathsBySpot.set(spot, n);
    bot.plan = null;
    bot.holding = false;
    if (skill < 0.5 && n >= 3 && bot.rageIn < 0) bot.rageIn = Math.round(rng.range(0.6, 1.4) / STEP);
  };

  /** ticks every fixed step in any state (rage-quit timer) */
  bot.tick = () => {
    if (bot.rageIn > 0 && --bot.rageIn === 0) bot.quit('ragequit');
  };

  bot.quit = (reason) => {
    if (bot.halted) return;
    bot.halted = true;
    bot.reason = reason;
    if (reason === 'ragequit') onRageQuit?.();
    else onFinished?.();
    // "close the tab": let the SDK flush + end the session
    window.dispatchEvent(new Event('pagehide'));
  };

  /** menu screens: returns true when the bot "presses Space" */
  bot.menu = (state, dt) => {
    if (bot.halted) return false;
    bot.menuT += dt;
    if (bot.menuT < bot.menuWait) return false;
    bot.menuT = 0;
    if (state === 'win') {
      bot.quit('finished');
      return false;
    }
    bot.menuWait = state === 'complete' ? rng.range(1.2, 2.6) : rng.range(0.4, 0.9);
    return true;
  };
  bot.resetMenu = (wait) => {
    bot.menuT = 0;
    bot.menuWait = wait ?? rng.range(1.2, 2.6);
  };

  return bot;
}
