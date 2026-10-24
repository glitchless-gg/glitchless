// Dead Reckoning: a precision platformer with invisible platforms. Every death by every player leaves a
// glowing mark, so the dead draw the path. Yours show at once; everyone else's come from Glitchless.
import * as THREE from 'three';
import { params } from './params.js';
import { LEVELS, levelBounds } from './levels.js';
import { PHYS, DT, createBody, step } from './physics.js';
import { createView, COLORS } from './view.js';
import { createMarkerLayer } from './markers/layer.js';
import { createMarkerSource } from './markers/index.js';
import { createReplay, createRecorder } from './replay.js';
import { renderCard, shareLines, shareText, canvasToBlob, shareNative, postOnX, copyText, saveImage } from './share.js';
import { input, bindTouch } from './input.js';
import { sfx } from './audio.js';
import { store } from './store.js';
import { gd, initTelemetry } from './telemetry.js';
import { createAutoplay } from './autoplay.js';

const RESPAWN_S = 0.32;
const WON_S = 0.9;
const $ = (id) => document.getElementById(id);

// Without WebGL there's no game: say so instead of a black page.
function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
if (!webglOk()) {
  $('nogl').hidden = false;
  $('nogl').classList.add('on');
  throw new Error('Dead Reckoning needs WebGL');
}

// ─────────────────────────────────────────────────────────────── scene

const view = createView($('game'));
const others = createMarkerLayer({ capacity: 6000, color: COLORS.others, size: 0.46, opacity: 0.5, z: view.Z.markers });
const mine = createMarkerLayer({ capacity: 2000, color: COLORS.mine, size: 0.62, opacity: 1, z: view.Z.markers + 0.3 });
view.scene.add(others.points, mine.points);
const replay = createReplay(view);
const source = createMarkerSource({ source: params.markers, levels: LEVELS, api: params.api, seed: 1 });

const bot = params.autoplay ? createAutoplay({ skill: params.skill, seed: params.seed }) : null;

const game = {
  state: 'title', // title | playing | dead | won | replay | card
  index: 0,
  lv: null,
  body: null,
  rec: null,
  attempts: [],
  tries: 1,
  before: null, // everyone's deaths on this level when you started it: the share card's number
  clock: 0,
  stateT: 0,
  acc: 0,
  replayInfo: null,
  card: null,
  mapsCaptured: new Set(),
  replayEnds: [],
  replayDoneAt: 0,
  totalTries: 0, // every level cleared this visit, for the last card
  replayReported: false,
};

// ─────────────────────────────────────────────────────────────── layout

const pad = $('pad');
const coarse = window.matchMedia?.('(pointer: coarse)').matches;
let touchUI = coarse;

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  view.resize(w, h);
  const portrait = h > w;
  const showPad = touchUI && (game.state === 'playing' || game.state === 'dead');
  pad.hidden = !showPad;
  view.setInsets({ top: w <= 640 ? 52 : 56, bottom: showPad ? (portrait ? 150 : 16) : 28, side: w <= 640 ? 8 : 16 });
}
window.addEventListener('resize', layout);

bindTouch({
  move: $('pad-move'),
  jump: $('pad-jump'),
  onFirstTouch: () => sfx.wake(),
});
window.addEventListener(
  'touchstart',
  () => {
    if (touchUI) return;
    touchUI = true;
    layout();
  },
  { passive: true, once: true },
);

// ─────────────────────────────────────────────────────────────── HUD

const hud = {
  el: $('hud'),
  level(lv) {
    $('hud-num').textContent = lv.id;
    $('hud-name').textContent = lv.name;
  },
  tries(n) {
    const el = $('hud-try');
    el.textContent = n;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  },
  dead(entry) {
    $('hud-dead').textContent = entry ? Math.round(entry.total).toLocaleString('en-US') : '…';
    $('hud-mock').hidden = !source.fake;
    $('hud-stale').hidden = !entry?.stale;
    $('hud-stale').title = entry?.error ? `Couldn't refresh: ${entry.error}. Showing the last markers.` : '';
  },
};

// Until the owner makes the board's share link the "Live stats" links are a placeholder: shown in development
// (so it's obvious), left out of a production build rather than sending players to a dead link.
const livePlaceholder = /REPLACE_WITH/.test(params.liveStatsUrl);
for (const id of ['hud-live', 'title-live', 'card-live']) {
  $(id).href = params.liveStatsUrl;
  if (livePlaceholder) $(id).title = 'Placeholder: set VITE_LIVE_STATS_URL to the board share link';
}
if (livePlaceholder && params.prod) for (const id of ['hud-live', 'title-live-wrap', 'card-live-wrap']) $(id).hidden = true;
// Bots seed the marks before launch (README.md), and the counts include them: say so.
$('title-bots').hidden = source.kind !== 'share';
if (coarse) $('title-controls').hidden = true;
if (params.poster) document.body.classList.add('poster');

let toastTimer = 0;
function toast(text, ms = 1800) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

function setMuted(m) {
  sfx.setMuted(m);
  store.muted = m;
  $('wave-path').style.display = m ? 'none' : '';
  $('hud-mute').setAttribute('aria-label', m ? 'Sound off' : 'Sound on');
}
setMuted(params.mute || store.muted);
$('hud-mute').addEventListener('click', () => setMuted(!sfx.muted));

function screen(id) {
  for (const s of ['title', 'card']) $(s).classList.toggle('on', s === id);
  $('replay-hud').hidden = id !== 'replay';
  hud.el.hidden = id !== null;
  $('bot-tag').hidden = !params.autoplay || id !== null;
}

// ─────────────────────────────────────────────────────────────── markers

function othersEntry() {
  return game.lv ? source.get(game.lv.id) : null;
}

function refreshOthers() {
  const e = othersEntry();
  if (e) others.setBins(e.deaths, e.bin, game.clock);
  else others.clear();
  if (e && game.before === null && !e.loading) game.before = e.total;
  hud.dead(e);
}
source.subscribe(refreshOthers);

// ─────────────────────────────────────────────────────────────── level flow

function loadLevel(index) {
  const lv = LEVELS[index];
  game.index = index;
  game.lv = lv;
  game.attempts = [];
  game.tries = 1;
  game.before = null;
  game.body = createBody(lv.spawn);
  game.rec = createRecorder();
  view.setLevel(lv, { revealAlways: params.reveal });
  view.snapCamera();
  mine.clear();
  others.clear();
  replay.stop();
  others.setOpacity(0.5);
  mine.points.visible = true;
  bot?.forLevel(lv);
  hud.level(lv);
  $('hud-try').textContent = '1';
  refreshOthers();
  renderLevelPicker();
}

// The dashboard's heatmap shows the level under its deaths: a top-down… well, side-on picture of the
// real level, revealed. Only bots and dev sessions send it, so thousands of players don't each upload one.
function captureMap(lv) {
  if (!gd.enabled || game.mapsCaptured.has(lv.id) || !(params.autoplay || params.env === 'dev')) return;
  game.mapsCaptured.add(lv.id);
  const hide = [others.points, mine.points, view.player];
  hide.forEach((o) => (o.visible = false));
  view.setReveal(1);
  gd.captureMap(lv.id, { axis: 'xy', bounds: levelBounds(lv) });
  view.setReveal(0);
  hide.forEach((o) => (o.visible = true));
}

let hinted = false;
function beginLevel() {
  sfx.wake();
  game.state = 'playing';
  game.stateT = 0;
  input.clearPresses();
  // Focus left on a hidden button (Play, Next level) would take the next Space as a click.
  document.activeElement?.blur?.();
  $('game').focus({ preventScroll: true });
  screen(null);
  layout();
  // The SDK loads on its own; a level begun before it's ready is announced as soon as it is.
  telemetryReady.then(() => {
    if (game.state !== 'playing' && game.state !== 'dead') return;
    captureMap(game.lv);
    gd.levelStart(game.lv.id);
  });
  if (!hinted && !params.autoplay) {
    hinted = true;
    if (!touchUI) {
      $('hint').classList.remove('gone');
      setTimeout(() => $('hint').classList.add('gone'), 6000);
    }
    if (source.kind !== 'none') setTimeout(() => game.state === 'playing' && toast('Orange marks: where others died. Blue: where you did.', 4200), 900);
  }
}

function respawn() {
  game.tries++;
  game.body = createBody(game.lv.spawn);
  game.rec = createRecorder();
  bot?.reset();
  game.state = 'playing';
  game.stateT = 0;
  hud.tries(game.tries);
}

function restart() {
  game.attempts.push(game.rec.finish('restart'));
  respawn();
}

function die() {
  const d = game.body.dead;
  const x = d.x;
  const y = d.y + PHYS.h / 2;
  game.attempts.push(game.rec.finish('death', { x, y, cause: d.cause }));
  gd.death({ x, y, z: 0, cause: d.cause });
  mine.add(x, y, game.clock);
  view.burst(x, Math.max(y, -0.9), COLORS.mine, 34, 8);
  sfx.die();
  shake = 0.18;
  game.state = 'dead';
  game.stateT = 0;
  const deaths = game.attempts.filter((a) => a.end === 'death').length;
  if (bot && deaths >= bot.patience) quitBot(`gave up on level ${game.lv.id} after ${deaths} deaths`);
}

function win() {
  game.attempts.push(game.rec.finish('win'));
  gd.levelComplete(game.lv.id);
  // Tries per clear, for the week-later numbers: a board can sum `tries` and divide by the clears.
  track('cleared', { tries: game.tries });
  game.replayReported = false;
  gd.clearPosition();
  game.totalTries += game.tries;
  if (!bot) {
    store.setBest(game.lv.id, game.tries);
    store.unlock(game.index + 2);
  }
  view.burst(game.lv.goal.x, game.lv.goal.y + 0.6, COLORS.gold, 80, 11);
  sfx.win();
  game.state = 'won';
  game.stateT = 0;
  if (game.before === null) game.before = othersEntry()?.total ?? 0;
}

function quitBot(reason) {
  console.info(`[dead-reckoning] autoplay: ${reason}`);
  game.state = 'halted';
  gd.clearPosition();
  gd.flush?.();
  bot.done(reason);
}

// ─────────────────────────────────────────────────────────────── replay and card

let rpCount = 0;
let replayWinner = null;
function startReplay() {
  replayWinner = null;
  input.clearPresses(); // a jump pressed on the way into the goal mustn't skip the replay
  game.state = 'replay';
  game.stateT = 0;
  view.frame.overview = true;
  view.setPlayer(null);
  others.setOpacity(0.22);
  mine.points.visible = false;
  view.setReveal(0);
  game.replayInfo = replay.start(game.attempts, game.clock);
  // The counter ticks once per attempt as it ends, the winning one last.
  game.replayEnds = game.attempts.slice(0, -1).map((a) => a.n).sort((a, b) => a - b);
  rpCount = 0;
  $('rp-level').textContent = `Level ${game.lv.id} · every attempt`;
  $('rp-tries').textContent = '0';
  screen('replay');
  layout();
}

// Did people watch their replay to the end, or skip it? (For the week-later numbers, and the 15-second clip.)
function replayWatched(how) {
  if (game.replayReported) return; // the first showing only, not "Watch again"
  game.replayReported = true;
  track('replay', { watched: how, tries: game.tries });
}

function endReplay() {
  replay.stop();
  view.frame.overview = false;
  others.setOpacity(0.5);
  mine.points.visible = true;
  view.setReveal(params.reveal ? 1 : 0);
}

async function showCard() {
  game.state = 'card';
  view.setReveal(1);
  const lv = game.lv;
  const e = othersEntry();
  const card = { level: lv, tries: game.tries, before: game.before ?? 0, attempts: game.attempts, others: e, fake: source.fake };
  const { head, sub } = shareLines(card);
  const best = store.best(lv.id);
  const deaths = game.attempts.filter((a) => a.end === 'death').length;
  $('card-meta').textContent = [`${deaths} ${deaths === 1 ? 'death' : 'deaths'}`, best && best < game.tries ? `best ${best} tries` : null, source.fake ? 'markers are MOCK DATA' : null].filter(Boolean).join(' · ');
  const last = game.index === LEVELS.length - 1;
  if (last) $('card-meta').textContent += ` · all five levels${game.totalTries > game.tries ? `, ${game.totalTries} tries this visit` : ''}`;
  $('card-next').textContent = last ? 'Play again from level 1' : 'Next level →';
  $('card-share').hidden = !navigator.share;
  $('card-x').classList.toggle('primary', !navigator.share);
  if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 600))]);
  const canvas = renderCard(card, { url: params.gameUrl });
  $('card-img').src = canvas.toDataURL('image/png');
  $('card-img').alt = `${head} ${sub}`;
  game.card = { card, canvas, blob: null, text: shareText(card, params.gameUrl) };
  canvasToBlob(canvas).then((b) => game.card && (game.card.blob = b));
  screen('card');
  if (bot && params.speed === 1) setTimeout(() => game.state === 'card' && !params.stay && nextLevel(), 3500);
}

function nextLevel() {
  endReplay();
  const next = (game.index + 1) % LEVELS.length;
  if (bot && game.index === LEVELS.length - 1) return quitBot('finished all five levels');
  loadLevel(next);
  beginLevel();
}

function track(name, attrs) {
  gd.track(name, { level: game.lv.id, ...attrs });
}

$('card-share').addEventListener('click', async () => {
  const c = game.card;
  if (!c) return;
  const r = await shareNative({ blob: c.blob, text: c.text, filename: `dead-reckoning-level-${game.lv.id}.png` });
  if (r === true) track('share', { via: 'native' });
  else if (!r) toast('Sharing is not available here');
});
$('card-x').addEventListener('click', () => {
  if (!game.card) return;
  postOnX(game.card.text);
  track('share', { via: 'x' });
});
$('card-copy').addEventListener('click', async () => {
  if (!game.card) return;
  toast((await copyText(game.card.text)) ? 'Copied' : 'Copy failed');
  track('share', { via: 'copy' });
});
$('card-save').addEventListener('click', async () => {
  if (!game.card) return;
  const blob = game.card.blob || (await canvasToBlob(game.card.canvas));
  saveImage(blob, `dead-reckoning-level-${game.lv.id}.png`);
  track('share', { via: 'image' });
});
$('card-again').addEventListener('click', () => startReplay());
$('card-next').addEventListener('click', () => {
  sfx.click();
  nextLevel();
});

// ─────────────────────────────────────────────────────────────── title

function renderLevelPicker() {
  const wrap = $('levels');
  const unlocked = params.level ? 5 : store.unlocked;
  wrap.replaceChildren(
    ...LEVELS.map((lv, i) => {
      const b = document.createElement('button');
      b.textContent = lv.id;
      b.disabled = i + 1 > unlocked;
      b.className = i === game.index ? 'on' : '';
      b.title = b.disabled ? 'Beat the level before it first' : lv.name;
      b.addEventListener('click', () => {
        sfx.click();
        loadLevel(i);
      });
      return b;
    }),
  );
}

$('play').addEventListener('click', () => beginLevel());
$('hud-menu').addEventListener('click', () => {
  if (!bot && (game.state === 'playing' || game.state === 'dead')) showTitle();
});

function showTitle() {
  game.state = 'title';
  endReplay();
  view.setPlayer(game.body);
  screen('title');
  layout();
}

// ─────────────────────────────────────────────────────────────── loop

let shake = 0;
let last = performance.now();
let gaugeT = 0;

function stepPlay() {
  const b = game.body;
  const inp = bot ? bot.input(b) : input.state();
  const ev = {};
  step(b, inp, game.lv, ev);
  bot?.after(b);
  game.rec.push(b.x, b.y);
  if (ev.jumped) {
    view.jumped();
    sfx.jump();
  }
  if (ev.landed) {
    for (const c of ev.landed.cols) view.touchEdge(`t${c},${ev.landed.r}`, c + 0.5, ev.landed.r + 1, 1, 0.07, ev.landed.hard > 4 ? 1 : 0.7);
    if (ev.landed.hard > 4) {
      view.landed(ev.landed.hard);
      sfx.land();
    }
  }
  if (ev.bonked) view.touchEdge(`b${ev.bonked.c},${ev.bonked.r}`, ev.bonked.c + 0.5, ev.bonked.r, 1, 0.07, 1);
  if (ev.bumped) view.touchEdge(`s${ev.bumped.c},${ev.bumped.r},${ev.bumped.side}`, ev.bumped.c + (ev.bumped.side < 0 ? 0 : 1), ev.bumped.r + 0.5, 0.07, 1, 0.8);
  if (b.dead) return die();
  if (b.won) return win();
  gd.setPosition({ x: b.x, y: b.y + PHYS.h / 2, z: 0 });
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  advance(dt);
}

function advance(dt) {
  game.clock += dt;
  game.stateT += dt;
  const speed = bot ? params.speed : 1;

  if (input.consume('mute')) setMuted(!sfx.muted);

  switch (game.state) {
    case 'title':
      if (input.consume('confirm') || input.consume('jump')) beginLevel();
      break;
    case 'playing': {
      if (input.consume('restart')) {
        restart();
        break;
      }
      if (input.consume('back') && !bot) {
        showTitle();
        break;
      }
      game.acc += dt * speed;
      let n = 0;
      while (game.acc >= DT && game.state === 'playing' && n++ < 8 * speed) {
        game.acc -= DT;
        stepPlay();
      }
      if (game.state !== 'playing') game.acc = 0;
      break;
    }
    case 'dead':
      if (game.stateT >= RESPAWN_S / speed || input.consume('restart')) respawn();
      break;
    case 'won':
      if (game.stateT >= WON_S / speed) {
        if (bot && speed > 1) nextLevel();
        else startReplay();
      }
      break;
    case 'replay': {
      const r = replay.update(dt, game.clock, view.frame.ppu * view.renderer.getPixelRatio(), (x, y) => {
        view.burst(x, Math.max(y, -0.9), COLORS.mine, 12, 5);
        sfx.pop();
      });
      replayWinner = r.winner;
      // Tries tick up as attempts end; the winning one is the last.
      const steps = r.t * 60 * game.replayInfo.speed;
      let c = 0;
      while (c < game.replayEnds.length && game.replayEnds[c] <= steps) c++;
      const shown = r.done ? game.tries : c;
      if (shown !== rpCount) {
        rpCount = shown;
        $('rp-tries').textContent = shown;
        $('rp-word').textContent = shown === 1 ? 'try' : 'tries';
      }
      if (r.done) {
        if (!game.replayDoneAt) {
          game.replayDoneAt = game.clock;
          view.burst(r.winner.x, r.winner.y + 0.4, COLORS.gold, 70, 10);
          sfx.win();
        }
        // Then the level, revealed: what everyone was walking on.
        const k = (game.clock - game.replayDoneAt - 0.4) / 1.3;
        view.setReveal(Math.max(0, Math.min(1, k)));
        if (k >= 1.5) {
          game.replayDoneAt = 0;
          replayWatched('full');
          showCard();
        }
      }
      if (input.consume('jump') || input.consume('confirm') || skipTapped) {
        skipTapped = false;
        game.replayDoneAt = 0;
        replayWatched(r.done ? 'full' : 'skipped');
        showCard();
      }
      break;
    }
    case 'card':
      if (input.consume('confirm')) nextLevel();
      break;
  }
  skipTapped = false;

  const b = game.body;
  const playing = game.state === 'playing' || game.state === 'title';
  view.setPlayer(b, { visible: playing });
  const focus = game.state === 'replay' && replayWinner ? { x: replayWinner.x, lead: 2 } : b ? { x: b.x, lead: b.facing * 1.5 } : null;
  view.updateCamera(dt, focus);
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    const s = shake * 0.6;
    view.camera.left += (Math.random() - 0.5) * s;
    view.camera.right = view.camera.left + view.frame.w / view.frame.ppu;
    view.camera.updateProjectionMatrix();
  }
  const ppuPx = view.frame.ppu * view.renderer.getPixelRatio();
  others.update(game.clock, ppuPx);
  mine.update(game.clock, ppuPx);
  view.update(dt);
  view.render();

  gaugeT += dt;
  if (gaugeT > 1) {
    gaugeT = 0;
    gd.setContext({ markers: others.count + mine.count, ghosts: replay.ghostsShown });
  }
}

let skipTapped = false;
$('game').addEventListener('pointerdown', () => {
  sfx.wake();
  if (game.state === 'replay') skipTapped = true;
});
$('replay-hud').addEventListener('pointerdown', () => (skipTapped = true));

// ─────────────────────────────────────────────────────────────── boot

// For poking at it from the console, and for tests in a background tab (where frames are throttled):
// deadReckoning.run(seconds) plays that much game time in 1/60 s ticks, right now.
window.deadReckoning = {
  game,
  source,
  params,
  view,
  LEVELS,
  run(seconds) {
    for (let i = 0; i < Math.round(seconds * 60); i++) advance(1 / 60);
    return { state: game.state, level: game.lv.id, tries: game.tries };
  },
};

// The bot always starts from level 1 (or ?level=), never from this browser's saved progress.
const startAt = params.level ? params.level - 1 : bot ? 0 : Math.min(store.unlocked, LEVELS.length) - 1;
loadLevel(startAt);
layout();
source.start();
$('hud-dead').parentElement.hidden = source.kind === 'none';
const telemetryReady = initTelemetry({ renderer: view.renderer, scene: view.scene, camera: view.camera, THREE });
if (bot) {
  // The bot's sessions are only worth anything once they're being recorded.
  telemetryReady.then(() => beginLevel());
} else {
  showTitle();
}
requestAnimationFrame((t) => {
  last = t;
  frame(t);
});
document.addEventListener('visibilitychange', () => {
  last = performance.now();
});
