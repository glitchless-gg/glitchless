// Lagderboard: how much can your device take? The load grows by itself (faster with MORE and with every tap) until
// Glitchless measures the device under 30 fps for 3 s; the score is the cube count it last held at 30 fps.
import '@fontsource-variable/unbounded/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import { Raycaster, Vector2, Vector3 } from 'three';
import { createStage } from './stage.js';
import { CubeStorm } from './cubes.js';
import { MAX_CUBES } from './rules.js';
import { Lights, Explosions, lightsFor } from './fx.js';
import { Judge } from './judge.js';
import { initGlitchless, safely } from './telemetry.js';
import { describeDevice } from './device.js';
import { createLeaderboard } from './leaderboard/index.js';
import { createUI } from './ui.js';
import { drawCard, shareText, nativeShare, xIntentUrl, download } from './share.js';
import { SHARE_URL } from './config.js';
import { params } from './params.js';
import { GAME_VERSION } from './version.js';
import { registerAgentTools } from './agent-tools.js';
import { startAutoplay } from './autoplay.js';

const canvas = document.getElementById('game');
const freeze = document.getElementById('freeze');
const stage = createStage(canvas);
const { renderer, scene, camera } = stage;
const gd = initGlitchless({ renderer, scene, camera });
const storm = new CubeStorm(scene);
const lights = new Lights(scene);
const booms = new Explosions(scene);
const judge = new Judge(gd);
const board = createLeaderboard();

const game = {
  phase: 'title', // title | run | end
  clock: 0, // the shaders' time, in seconds
  runTime: 0, // the run's simulated time: frame time, capped at 0.1 s a frame, so a slow device's run unfolds the same
  startedAt: 0, // the run's start on the wall clock (performance.now), for the seconds players see and the board gets
  assisted: false, // an agent or the console set the load (lagderboard_set_load): kept off the leaderboard
  load: 0, // the cube count the run is heading for; the storm catches up a few thousand a frame
  tier: 1,
  taps: 0,
  nextBoom: 0,
  peakLights: 0,
  maxedAt: 0,
  hold: null, // an agent holding the load at a number (lagderboard_set_load)
  pendingEnd: null,
  frozen: false,
  device: null,
  result: null,
  share: null, // { canvas, file, text }
  attempt: 0,
};

const ui = createUI({
  onStart: startRun,
  onMore: more,
  onTap: tap,
  onBoard: (from) => {
    safely(gd, 'track', 'board_open', { from });
    ui.openBoard(game.device?.deviceClass);
  },
  onLive: (from) => safely(gd, 'track', 'live_stats_open', { from }),
  onShare: share,
  devices: (cls) => board.devices(cls).catch(() => []),
  boardNote: () =>
    board.kind === 'local'
      ? 'This board lives in your browser for now: it lists the runs played here. The shared board arrives with launch.'
      : board.degraded
        ? "Couldn't reach the shared board, so this shows the runs played in this browser."
        : 'Best run per device, from everyone who played. A score is the cubes on screen the last time Glitchless measured 30 fps or better.',
});

lights.onAdd = (n) => {
  game.peakLights = Math.max(game.peakLights, n);
  if (game.phase === 'run') ui.toast(`+1 light (${n})`);
};

judge.onMeltdown = (m) => {
  game.pendingEnd = { ...m, reason: 'meltdown' };
};

// A phone that runs out of GPU memory can drop the WebGL context mid-run (the SDK reports it as an error). That's
// a meltdown too: end the run on the last load Glitchless measured at 30 fps, while the canvas still shows it.
canvas.addEventListener('webglcontextlost', () => {
  if (game.phase !== 'run' || game.pendingEnd) return;
  const v = judge.last;
  finishRun({ reason: 'context_lost', score: judge.lastGood ?? 0, limitMs: judge.limitMs(), heldS: 0, lastP95: v?.p95 ?? null, hz: gd.hz }, { snapshot: false });
});

describeDevice(gd).then((d) => {
  game.device = d;
  ui.setDevice(d);
});

// ───────────────────────────── the run ─────────────────────────────

function startRun() {
  if (game.phase === 'run' || !game.device) return;
  // After a lost context the browser may never give this canvas a GPU back: a fresh page gets a fresh one.
  if (renderer.getContext().isContextLost()) return location.reload();
  ui.closeBoard();
  storm.clear();
  booms.clear();
  lights.clear();
  Object.assign(game, { phase: 'run', runTime: 0, startedAt: performance.now(), assisted: false, load: 240, tier: 1, taps: 0, nextBoom: 1.2, peakLights: 0, maxedAt: 0, hold: null, pendingEnd: null, frozen: false, result: null, share: null });
  game.attempt++;
  canvas.hidden = false;
  freeze.hidden = true;
  stage.resize();
  ui.startRun();
  judge.start(() => storm.count);
  safely(gd, 'levelStart', 'run');
  safely(gd, 'track', 'run_start', { device_class: game.device.deviceClass, attempt: game.attempt });
}

function more() {
  if (game.phase !== 'run') return;
  game.tier++;
  game.load = Math.min(MAX_CUBES, game.load * 1.3);
  for (let i = 0; i < 3; i++) boom(storm.randomSurfacePoint(new Vector3()), 'more');
  ui.pressMore();
  navigator.vibrate?.(12); // Android; iOS ignores it
  ui.toast(`MORE ×${game.tier}`);
  safely(gd, 'track', 'more', { tier: game.tier });
}

const ray = new Raycaster();
const ndc = new Vector2();
function tap(x, y) {
  if (game.phase !== 'run') return;
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const p = storm.surfacePoint(ray.ray, new Vector3()) || storm.randomSurfacePoint(new Vector3());
  boom(p, 'tap');
  game.taps++;
  ui.tapped();
}

// An explosion throws new cubes out of p; they count toward the load like the rain does.
function boom(p, kind) {
  const h = storm.heightFor();
  const n = Math.round(30 + storm.count * (kind === 'auto' ? 0.012 : 0.03));
  game.load = Math.min(MAX_CUBES, game.load + n);
  storm.burst(p, n, game.clock, 6 + h * 0.22);
  booms.spawn(p, 1 + h * (kind === 'auto' ? 0.12 : 0.16));
}

function grow(dt) {
  if (game.hold != null) {
    game.load = game.hold;
    return;
  }
  // Ease off as Glitchless's live frame rate nears the line, and almost stop while a meltdown is being confirmed:
  // the device sits at its limit instead of being buried far past it, so the score lands close to the truth.
  const fps = gd.liveStats()?.fps ?? 60;
  const lineFps = 1000 / judge.limitMs();
  const ease = judge.streak ? 0.08 : Math.min(1, Math.max(0.15, (fps - lineFps * 0.9) / (lineFps * 0.8)));
  const rate = (0.24 + 0.022 * game.runTime + 0.07 * (game.tier - 1)) * (params.fast ? 3 : 1);
  game.load = Math.min(MAX_CUBES, game.load * (1 + rate * ease * dt));

  if (game.runTime >= game.nextBoom) {
    game.nextBoom = game.runTime + Math.min(2.2, Math.max(0.35, 2.2 - 0.07 * game.runTime));
    boom(storm.randomSurfacePoint(new Vector3()), 'auto');
  }

  // Past the most cubes the game makes: four more seconds over 30 fps and the device is unbreakable.
  if (storm.count >= MAX_CUBES) {
    game.maxedAt ||= game.runTime;
    if (game.runTime - game.maxedAt > 4 && !judge.streak) game.pendingEnd = { reason: 'unbreakable', score: MAX_CUBES, limitMs: judge.limitMs(), heldS: 0, hz: gd.hz };
  }
}

function fill() {
  const want = Math.floor(game.load) - storm.count;
  if (want > 0) storm.rain(Math.min(want, Math.ceil(3000 + storm.count * 0.04)), game.clock);
}

// The title screen's mound: a small live preview of a run.
function attract() {
  if (storm.count < 900) storm.rain(Math.min(900 - storm.count, 8), game.clock);
  else if (game.clock >= game.nextBoom && storm.count < 1600) {
    game.nextBoom = game.clock + 2.6;
    const p = storm.randomSurfacePoint(new Vector3());
    storm.burst(p, 24, game.clock, 6);
    booms.spawn(p, 1.4);
  }
}

// Right after the meltdown frame is drawn: copy it (the drawing buffer isn't kept past this task), stop drawing,
// free the cubes, and show the card.
function finishRun(m, { snapshot = true } = {}) {
  game.pendingEnd = null;
  judge.stop();
  game.phase = 'end';
  const scale = Math.min(1, 1600 / canvas.width);
  freeze.width = Math.round(canvas.width * scale);
  freeze.height = Math.round(canvas.height * scale);
  const g = freeze.getContext('2d');
  g.fillStyle = '#070b18';
  g.fillRect(0, 0, freeze.width, freeze.height);
  if (snapshot) g.drawImage(canvas, 0, 0, freeze.width, freeze.height);
  freeze.hidden = false;
  canvas.hidden = true;
  game.frozen = true;

  const peak = storm.count;
  const result = {
    reason: m.reason,
    score: Math.round(m.score),
    peak,
    limitMs: m.limitMs,
    heldS: m.heldS,
    lastP95: m.lastP95,
    hz: m.hz,
    lights: game.peakLights,
    explosions: booms.total,
    seconds: (performance.now() - game.startedAt) / 1000,
    tier: game.tier,
    device: game.device,
    synthetic: params.autoplay,
    assisted: game.assisted,
    placed: null,
  };
  game.result = result;
  storm.clear();
  booms.clear();
  lights.clear();

  safely(gd, 'levelComplete', 'run', { durationS: result.seconds, score: result.score });
  safely(gd, 'track', 'run_end', {
    score: result.score,
    score_band: band(result.score),
    device: result.device.name,
    device_class: result.device.deviceClass,
    gpu_tier: result.device.gpuTier,
    browser: result.device.browser,
    os: result.device.os,
    hz: result.hz,
    seconds: Math.round(result.seconds * 10) / 10,
    lights: result.lights,
    explosions: result.explosions,
    tier: result.tier,
    taps: game.taps,
    p95_ms: Number.isFinite(result.lastP95) ? Math.round(result.lastP95 * 10) / 10 : null,
    limit_ms: Math.round(result.limitMs * 10) / 10,
    reason: result.reason,
  });
  safely(gd, 'flush'); // a run is the thing worth keeping if the tab closes next

  ui.showEnd(result);
  if (!result.synthetic && !result.assisted && result.score >= 1) {
    board
      .submit({
        id: `${gd.sessionId}-${game.attempt}`,
        score: result.score,
        deviceClass: result.device.deviceClass,
        deviceName: result.device.name,
        gpu: result.device.gpu,
        browser: result.device.browser,
        os: result.device.os,
        hz: result.hz,
        seconds: Math.round(result.seconds * 10) / 10,
        version: GAME_VERSION,
        sessionId: gd.sessionId,
        at: new Date().toISOString(),
      })
      .then((placed) => {
        if (game.result !== result) return;
        result.placed = placed;
        ui.rank(result);
      })
      .catch((err) => console.warn('[lagderboard] leaderboard submit failed', err));
  }

  const text = shareText(result);
  ui.shareReady(xIntentUrl(text, SHARE_URL));
  drawCard({ snapshot: freeze, score: result.score, device: result.device, measured: result, stats: result, url: SHARE_URL }).then(async (card) => {
    if (game.result !== result) return;
    // The file is made now, so the Share tap can open the share sheet straight away (Safari wants that).
    const blob = await new Promise((r) => card.toBlob(r, 'image/png'));
    game.share = { card, text, file: blob ? new File([blob], 'lagderboard.png', { type: 'image/png' }) : null };
  });
}

async function share(method) {
  const s = game.share;
  if (!s && method !== 'x') return ui.toast('Making the card…');
  safely(gd, 'track', 'share', { method });
  if (method === 'image') download(s.card, `lagderboard-${game.result.score}.png`);
  else if (method === 'native') {
    const ok = await nativeShare(s.file, s.text, SHARE_URL);
    if (!ok) download(s.card, `lagderboard-${game.result.score}.png`);
  }
}

function band(score) {
  const edges = [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6];
  const names = ['<1k', '1k–3k', '3k–10k', '10k–30k', '30k–100k', '100k–300k', '300k–1M', '1M+'];
  const i = edges.findIndex((e) => score < e);
  return names[i === -1 ? names.length - 1 : i];
}

// ───────────────────────────── the frame ─────────────────────────────

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (game.frozen) return;
  game.clock += dt;

  if (game.phase === 'run') {
    game.runTime += dt;
    grow(dt);
    fill();
  } else attract();

  lights.set(lightsFor(storm.count));
  storm.update(game.clock);
  const n = Math.max(storm.count, 300);
  const h = storm.heightFor(n);
  const radius = storm.radiusFor(n);
  lights.update(dt, game.clock, h, radius);
  booms.update(dt);
  const melt = game.phase === 'run' ? judge.progress(now) : 0;
  stage.view.shake = melt * Math.min(1.2, 0.15 + h * 0.03);
  stage.update(dt, game.clock, { h, radius, orbit: game.phase === 'run' ? 0.09 : 0.05 });
  safely(gd, 'setContext', { cubes: storm.count, lights: lights.lights.length, explosions: booms.live.length, tier: game.tier, chunks: storm.drawChunks });

  renderer.render(scene, camera);

  if (game.pendingEnd) finishRun(game.pendingEnd);
  else if (game.phase === 'run') ui.frame({ cubes: storm.count, verdict: judge.last, lights: lights.lights.length, explosions: booms.total, seconds: (now - game.startedAt) / 1000, tier: game.tier, melt });
}
requestAnimationFrame(frame);

// ───────────────────────────── agents and bots ─────────────────────────────

const api = {
  state: () => ({
    phase: game.phase,
    version: GAME_VERSION,
    cubes: storm.count,
    load: Math.round(game.load),
    held_at: game.hold,
    lights: lights.lights.length,
    explosions: booms.total,
    tier: game.tier,
    run_seconds: Math.round(game.runTime * 10) / 10,
    judge: judge.last && { ...judge.last, p95: Number.isFinite(judge.last.p95) ? Math.round(judge.last.p95 * 100) / 100 : null },
    melting_for_s: judge.streak ? Math.round((performance.now() - judge.streak.startedAt) / 100) / 10 : 0,
    device: game.device,
    result: game.result && { ...game.result, device: undefined },
  }),
  start: () => {
    startRun();
    return api.state();
  },
  more: (times = 1) => {
    for (let i = 0; i < Math.min(10, times); i++) more();
    return api.state();
  },
  tapAt: (x, y) => tap(x, y),
  shareCard: () => game.share?.card.toDataURL('image/png') ?? null, // the last run's card as a PNG data URL
  setLoad: (cubes, hold = true) => {
    if (game.phase !== 'run') startRun();
    const target = Math.max(0, Math.min(MAX_CUBES, Math.round(cubes)));
    game.load = target;
    game.assisted = true;
    if (hold) {
      game.hold = target;
      judge.stop(); // a held run never ends: measure it with glitchless_measure
    } else {
      game.hold = null;
      judge.start(() => storm.count);
    }
    return api.state();
  },
};
window.lagderboard = api;
registerAgentTools(gd, api);
if (params.autoplay) startAutoplay(api);
