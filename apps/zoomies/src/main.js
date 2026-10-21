// Zoomies! — a tiny 2.5D Three.js platformer (and the Glitchless demo game).
import * as THREE from 'three';
import { params } from './params.js';
import { GAME_VERSION } from './version.js';
import { LEVELS, levelBounds } from './levels.js';
import { THEMES } from './theme.js';
import { createEnvironment, buildLevel, unloadLevel, animateWorld, activateCheckpoint } from './world.js';
import { createDog, animateDog } from './dog.js';
import { PHYS, createBody, stepMover } from './physics.js';
import { stepPlay } from './sim.js';
import { stepEnemy, animateEnemy } from './enemies.js';
import { createFx } from './fx.js';
import { createPopups } from './popups.js';
import { createCameraRig } from './camera.js';
import { hud } from './hud.js';
import { keyboard } from './input.js';
import { sfx } from './audio.js';
import { gd, initTelemetry } from './telemetry.js';
import { createAutoplay } from './autoplay.js';
import { registerAgentTools } from './agent-tools.js';

const MAX_LIVES = 5;
const ZOOMIES_TIME = 3;
const DEATH_TIME = 1.1;
const INVULN_TIME = 1.2;

// ─────────────────────────────────────────────────────────────── renderer / scene

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 700);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const env = createEnvironment(scene);
const dog = createDog();
scene.add(dog);
const fx = createFx(scene);
const popups = createPopups(scene);
const rig = createCameraRig(camera);

// ─────────────────────────────────────────────────────────────── game state

const game = {
  state: 'boot', // boot | title | playing | dying | paused | complete | win
  levelIndex: params.level - 1,
  level: null,
  world: null,
  play: null, // { body, movers, solids, enemies, t, killY } — what the physics steps
  checkpoint: null,
  levelTime: 0,
  score: 0,
  bones: 0,
  deaths: 0,
  lives: MAX_LIVES,
  totals: { score: 0, bones: 0, deaths: 0, time: 0 },
  invuln: 0,
  dyingT: 0,
  deathAnim: null,
  lastCause: null,
  kick: 0,
  trailT: 0,
  hintT: 0,
  halted: false,
  mapsCaptured: new Set(),
};

const bot = params.autoplay
  ? createAutoplay({
      skill: params.skill,
      seed: params.seed,
      onRageQuit: () => halt('RAGE QUIT', 'Nope. Done.', `The bot died 3× at the same spot on ${game.level.name} and closed the tab.`),
      onFinished: () => halt('AUTOPLAY', 'Good dog!', 'The bot finished all three levels and closed the tab.'),
    })
  : null;

// ─────────────────────────────────────────────────────────────── level flow

function makeBody(at) {
  const body = createBody(at.x, at.y);
  body.jumpWasDown = true; // require a fresh press (Space may still be held from a menu)
  return body;
}

function loadLevel(index) {
  // GLITCHLESS-DEMO: geometry leak on level change — see unloadLevel() in world.js
  if (game.world) unloadLevel(game.world, scene);
  const level = LEVELS[index];
  game.levelIndex = index;
  game.level = level;
  env.applyTheme(THEMES[level.theme], renderer);
  const world = buildLevel(scene, level);
  game.world = world;
  game.checkpoint = { x: level.spawn.x, y: level.spawn.y };
  game.play = { body: makeBody(game.checkpoint), movers: world.movers, solids: world.solids, enemies: world.enemies, t: 0, killY: world.killY };
  game.levelTime = 0;
  game.score = 0;
  game.bones = 0;
  game.deaths = 0;
  game.lives = MAX_LIVES;
  game.invuln = 0;
  game.deathAnim = null;
  popups.reset();
  rig.snap(game.checkpoint.x, game.checkpoint.y);
  rig.setFloor(level.killY);
  hud.level(index + 1, level.name, world.bones.length);

  if (!game.mapsCaptured.has(level.id)) {
    game.mapsCaptured.add(level.id);
    captureLevelMap(level);
  }
}

function captureLevelMap(level) {
  dog.position.set(game.checkpoint.x, game.checkpoint.y, 0);
  // hide the dog, sky dome and clouds so the heatmap background is just the level
  gd.captureMap(level.id, { axis: 'xy', bounds: levelBounds(level), exclude: [dog, env.sky, ...env.clouds] });
}

function beginLevel() {
  game.state = 'playing';
  keyboard.clearPresses();
  hud.screen(null);
  hud.show(true);
  gd.levelStart(game.level.id);
  bot?.onRespawn();
}

function restartLevel(cause) {
  gd.levelFail(game.level.id, { cause });
  loadLevel(game.levelIndex);
  beginLevel();
}

function nextLevel() {
  if (game.levelIndex >= LEVELS.length - 1) {
    game.state = 'win';
    hud.win(game.totals);
    hud.screen('win');
    hud.show(false);
    keyboard.clearPresses();
    bot?.resetMenu(2.5);
    return;
  }
  loadLevel(game.levelIndex + 1);
  beginLevel();
  hud.toast(`${game.levelIndex + 1} · ${game.level.name}`, '', 1600);
}

function playAgain() {
  game.totals = { score: 0, bones: 0, deaths: 0, time: 0 };
  loadLevel(0);
  beginLevel();
}

function completeLevel() {
  game.state = 'complete';
  const durationS = Math.round(game.levelTime * 100) / 100;
  gd.levelComplete(game.level.id, { durationS, score: game.score });
  game.totals.score += game.score;
  game.totals.bones += game.bones;
  game.totals.time += game.levelTime;
  hud.complete(game.level.name, { bones: game.bones, total: game.world.bones.length, time: game.levelTime, score: game.score, deaths: game.deaths });
  hud.screen('complete');
  keyboard.clearPresses();
  sfx.complete();
  fx.sparkle(game.world.goal.x, game.world.goal.y + 3.6, 0xc9a0ff, 16);
  bot?.resetMenu();
}

function die(cause) {
  const b = game.play.body;
  game.state = 'dying';
  game.dyingT = DEATH_TIME;
  game.deaths++;
  game.totals.deaths++;
  game.lives--;
  game.lastCause = cause;
  gd.death({ x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: 0, cause });
  bot?.onDeath(b.x, b.y);
  sfx.death();
  rig.shake(cause === 'fell' ? 0.45 : 0.8);
  const fell = cause === 'fell';
  game.deathAnim = { x: b.x, y: b.y, vx: fell ? b.vx * 0.4 : -b.facing * 2.5, vy: fell ? b.vy : 9, spin: 0, fell };
  if (!fell) fx.poof(b.x, b.y);
  b.zoomies = 0;
}

function respawn() {
  if (game.lives <= 0) {
    hud.toast('Out of lives — restarting level', 'pink', 1800);
    restartLevel(game.lastCause);
    return;
  }
  game.play.body = makeBody(game.checkpoint);
  game.play.body.jumpWasDown = false;
  game.state = 'playing';
  game.invuln = INVULN_TIME;
  game.deathAnim = null;
  bot?.onRespawn();
}

function halt(ribbon, title, text) {
  game.halted = true;
  hud.show(false);
  hud.halted(ribbon, title, text);
  hud.screen('halted');
  window.zoomies.halted = true;
}

// ─────────────────────────────────────────────────────────────── pickups

function collectBone(bone) {
  bone.collected = true;
  bone.mesh.visible = false;
  gd.track('bone_collected', { golden: bone.golden });
  fx.sparkle(bone.x, bone.y, bone.golden ? 0xffc83d : 0xfff3dc, bone.golden ? 18 : 6);
  if (bone.golden) {
    sfx.golden();
    hud.toast('GOLDEN BONE!', 'gold', 1600);
  } else sfx.bone();
  const value = bone.golden ? 100 : 10;
  popups.spawnScorePopup(bone.mesh.position, value); // (see GLITCHLESS-DEMO note in popups.js)
  game.score += value;
  game.bones += 1;
}

function collectBall(ball, body) {
  ball.collected = true;
  ball.mesh.visible = false;
  startZoomies(ball.x, ball.y, body);
}

function startZoomies(x, y, body) {
  body.zoomies = ZOOMIES_TIME;
  // GLITCHLESS-DEMO: particle perf bomb — see confettiBurst() in fx.js
  fx.confettiBurst(x, y, 0);
  gd.track('powerup', { kind: 'zoomies' });
  sfx.ball();
  rig.shake(0.2);
  hud.toast('ZOOMIES!', 'pink', 1200);
}

function checkPickups() {
  const { world } = game;
  const b = game.play.body;
  const cy = b.y + PHYS.HEIGHT / 2;
  for (const bone of world.bones) {
    if (bone.collected) continue;
    const r = bone.golden ? 0.85 : 0.62;
    if (Math.abs(bone.x - b.x) < r && Math.abs(bone.y - cy) < r + 0.12) collectBone(bone);
  }
  for (const ball of world.balls) {
    if (!ball.collected && Math.hypot(ball.x - b.x, ball.y - cy) < 0.75) collectBall(ball, b);
  }
  for (const cp of world.checkpoints) {
    if (!cp.active && b.x >= cp.x - 0.3 && Math.abs(b.y - cp.y) < 3) {
      activateCheckpoint(cp);
      game.checkpoint = { x: cp.x, y: cp.y };
      sfx.checkpoint();
      fx.sparkle(cp.x, cp.y + 1.5, 0xe0457b, 10);
      hud.toast('Checkpoint!', '', 1000);
    }
  }
  if (b.x >= world.goal.x - 0.3 && b.y > world.goal.y - 1.5) completeLevel();
}

// ─────────────────────────────────────────────────────────────── simulation

function fixedStep(dt) {
  bot?.tick();
  if (game.halted) return;
  const play = game.play;

  if (game.state === 'dying') {
    play.t += dt;
    for (const m of play.movers) stepMover(m, play.t);
    for (const e of play.enemies) stepEnemy(e, dt);
    game.dyingT -= dt;
    if (game.dyingT <= 0) respawn();
    return;
  }

  game.levelTime += dt;
  if (game.invuln > 0) game.invuln -= dt;
  const input = bot ? bot.step(game) : keyboard.state();
  const b = play.body;
  const ev = stepPlay(play, input, dt, game.invuln > 0);

  if (ev.jumped) {
    game.kick -= 9;
    fx.dust(b.x, b.y, 4, 0.7);
    sfx.jump();
  }
  if (ev.landed) {
    const s = Math.min(1, -ev.landVy / 20);
    game.kick += 3 + 9 * s;
    if (s > 0.3) {
      fx.dust(b.x, b.y, 6, 0.6 + s * 0.6);
      sfx.land();
    }
  }
  if (ev.stomped) {
    fx.poof(ev.stomped.x, ev.stomped.y, ev.stomped.kind === 'vacuum' ? 0xb8bccb : 0xe8a46a);
    sfx.stomp();
    rig.shake(0.18);
    game.kick -= 6;
  }
  if (ev.hit) return die(ev.hit.kind);
  if (ev.fell) return die('fell');

  if (b.zoomies > 0 && (game.trailT += dt) > 0.035) {
    game.trailT = 0;
    fx.trail(b.x, b.y, b.facing);
  }
  checkPickups();
}

// ─────────────────────────────────────────────────────────────── per-frame

let clock = 0;

function handleMenus(dt) {
  if (keyboard.consume('mute')) hud.toast(sfx.toggleMute() ? 'Sound off' : 'Sound on', '', 900);
  const s = game.state;
  const confirm = () => keyboard.consume('jump') || keyboard.consume('confirm') || (bot ? bot.menu(s, dt) : false);
  if (s === 'title') {
    if (confirm()) beginLevel();
  } else if (s === 'playing' || s === 'dying') {
    if (keyboard.consume('pause') && s === 'playing') {
      game.state = 'paused';
      hud.screen('pause');
    } else if (keyboard.consume('restart')) restartLevel('restart');
  } else if (s === 'paused') {
    if (keyboard.consume('pause') || keyboard.consume('confirm')) {
      game.state = 'playing';
      hud.screen(null);
    } else if (keyboard.consume('restart')) {
      hud.screen(null);
      restartLevel('restart');
    }
  } else if (s === 'complete') {
    if (confirm()) nextLevel();
  } else if (s === 'win') {
    if (confirm()) playAgain();
  }
}

function updateVisuals(dt) {
  const b = game.play.body;
  const world = game.world;

  if (game.state === 'dying' && game.deathAnim) {
    const d = game.deathAnim;
    d.vy -= 32 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.spin += dt * (d.fell ? 0 : 9);
    dog.position.set(d.x, d.y, 0);
    dog.rotation.z = d.spin;
  } else {
    dog.position.set(b.x, b.y, 0);
    dog.rotation.z = 0;
  }
  animateDog(dog, { vx: b.vx, vy: b.vy, grounded: b.grounded && game.state !== 'dying', facing: b.facing, zoomies: b.zoomies > 0, kick: game.kick }, dt);
  game.kick = 0;
  dog.visible = !(game.invuln > 0 && Math.floor(game.invuln * 14) % 2 === 0);

  animateWorld(world, dt, clock);
  for (const e of world.enemies) animateEnemy(e, dt);
  fx.update(dt);
  popups.update(dt);

  const focus = rig.update(
    dt,
    { x: b.x, y: b.y, grounded: b.grounded, facing: b.facing, zoomies: b.zoomies > 0, dead: game.state === 'dying' },
    game.state === 'title' ? 'title' : 'play',
  );
  env.follow(camera, focus, dt);

  // HUD
  hud.timer(game.levelTime);
  hud.bones(game.bones);
  hud.score(game.score);
  hud.lives(game.lives, MAX_LIVES);
  hud.deaths(game.deaths);
  hud.zoomies(b.zoomies > 0 ? b.zoomies / ZOOMIES_TIME : 0);
  if (game.state === 'playing') {
    game.hintT += dt;
    hud.hint(!bot && game.hintT < 9);
  } else if (game.state !== 'paused') hud.hint(false);
}

let last = 0;
let acc = 0;

function frame(now) {
  if (game.halted) return;
  // keep the loop alive no matter what happens below
  requestAnimationFrame(frame);

  const raw = Math.max(0, (now - last) / 1000);
  last = now;
  const dt = Math.min(raw, 0.1);
  clock += dt;

  handleMenus(dt);
  if (game.state === 'playing' || game.state === 'dying') {
    acc = Math.min(acc + raw, 0.25);
    while (acc >= PHYS.STEP) {
      acc -= PHYS.STEP;
      fixedStep(PHYS.STEP);
      if (game.halted || (game.state !== 'playing' && game.state !== 'dying')) break;
    }
  } else {
    acc = 0;
  }

  updateVisuals(dt);
  gd.setPosition(dog.position);
  gd.setContext({ particles: fx.confettiCount, entities: game.world.enemies.filter((e) => e.alive).length });
  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────── agent tools (WebMCP via Glitchless)

function groundAt(x) {
  const platforms = game.world.statics.filter((p) => p.kind !== 'wall');
  const solid = (p) => p.kind === 'ground' || p.kind === 'roof';
  let best = null;
  for (const p of platforms) {
    if (x < p.x || x > p.x + p.w) continue;
    if (!best || (solid(p) && !solid(best)) || (solid(p) === solid(best) && p.y > best.y)) best = p;
  }
  if (best) return { x, y: best.y };
  let nearest = null;
  let dist = Infinity;
  for (const p of platforms) {
    const nx = Math.min(Math.max(x, p.x + 0.5), p.x + p.w - 0.5);
    if (Math.abs(nx - x) < dist) {
      dist = Math.abs(nx - x);
      nearest = { x: nx, y: p.y };
    }
  }
  return nearest;
}

const agentApi = {
  getState() {
    const b = game.play.body;
    const r = renderer.info;
    return {
      ok: true,
      version: GAME_VERSION,
      state: game.state,
      paused: game.state === 'paused',
      title: game.state === 'title',
      win: game.state === 'win',
      level: game.level.id,
      level_name: game.level.name,
      level_time_s: +game.levelTime.toFixed(2),
      player: { x: +b.x.toFixed(2), y: +b.y.toFixed(2), vx: +b.vx.toFixed(2), vy: +b.vy.toFixed(2), grounded: b.grounded, facing: b.facing },
      lives: game.lives,
      deaths: game.deaths,
      bones: game.bones,
      bones_total: game.world.bones.length,
      score: game.score,
      zoomies_active: b.zoomies > 0,
      zoomies_remaining_s: +b.zoomies.toFixed(2),
      confetti_meshes: fx.confettiCount,
      enemies: game.world.enemies.filter((e) => e.alive).length,
      renderer: { draw_calls: r.render.calls, geometries: r.memory.geometries, textures: r.memory.textures },
      autoplay: bot ? { skill: params.skill, seed: params.seed, halted: game.halted } : null,
    };
  },
  loadLevel(id) {
    const index = LEVELS.findIndex((l) => l.id === id);
    loadLevel(index);
    beginLevel();
    hud.toast(`${index + 1} · ${game.level.name}`, '', 1600);
    return { ok: true, level: game.level.id, state: game.state };
  },
  triggerZoomies() {
    if (game.state === 'title') beginLevel();
    if (game.state !== 'playing') return { ok: false, error: `can only trigger zoomies while playing (state: ${game.state})` };
    const b = game.play.body;
    startZoomies(b.x, b.y + PHYS.HEIGHT / 2, b);
    return { ok: true, confetti_meshes: fx.confettiCount, zoomies_remaining_s: b.zoomies };
  },
  teleport(x) {
    const at = groundAt(x);
    if (!at) return { ok: false, error: 'no ground on this level' };
    if (game.state === 'title') beginLevel();
    if (game.state === 'dying') {
      game.state = 'playing';
      game.deathAnim = null;
    }
    if (game.state !== 'playing' && game.state !== 'paused') return { ok: false, error: `cannot teleport in state ${game.state}` };
    game.play.body = makeBody(at);
    game.play.body.jumpWasDown = false;
    game.invuln = 0.5;
    rig.snap(at.x, at.y);
    bot?.onRespawn();
    return { ok: true, level: game.level.id, x: +at.x.toFixed(2), y: +at.y.toFixed(2), state: game.state };
  },
  setPaused(paused) {
    if (paused && game.state === 'playing') {
      game.state = 'paused';
      hud.screen('pause');
    } else if (!paused && game.state === 'paused') {
      game.state = 'playing';
      hud.screen(null);
    }
    return { ok: true, state: game.state, paused: game.state === 'paused' };
  },
};

// ─────────────────────────────────────────────────────────────── boot

window.zoomies = {
  version: GAME_VERSION,
  game,
  renderer,
  scene,
  bot,
  api: agentApi,
  halted: false,
  get state() {
    return game.state;
  },
  get level() {
    return game.level?.id;
  },
  get info() {
    const i = renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length, confetti: fx.confettiCount };
  },
};

async function boot() {
  hud.initTitle(`v${GAME_VERSION} · ${params.env}`);
  if (bot) hud.bot(`AUTOPLAY · skill <b>${params.skill.toFixed(2)}</b> · seed <b>${params.seed}</b>`);
  try {
    await Promise.race([document.fonts?.load('700 64px Fredoka'), new Promise((r) => setTimeout(r, 900))]);
  } catch {
    /* fonts are optional */
  }
  await initTelemetry({ renderer, scene, camera, THREE });
  if (gd.enabled) registerAgentTools(gd, agentApi);
  else document.getElementById('hint-gd')?.remove();
  hud.initTitle(`v${GAME_VERSION} · ${params.env} · ${gd.enabled ? 'instrumented with Glitchless — press ` for the overlay' : 'telemetry off'}`);

  loadLevel(game.levelIndex);
  game.state = 'title';
  hud.screen('title');
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
}

boot();
