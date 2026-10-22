import { params } from './params.js';
import { VIEW, GROUND_Y } from './levels.js';
import { makeScenes } from './scenes.js';
import { startTelemetry, instrument, tel } from './telemetry.js';
import { registerAgentTools } from './agent-tools.js';

const Phaser = params.phaser === 4 ? await import('phaser4') : await import('phaser');
startTelemetry();

// The run is over (won, or the bot gave up): end the session the way closing the tab would.
const fetchGame = (window.fetchGame = { won: false, quit: false, crashed: false });
function onDone(how) {
  fetchGame[how] = true;
  if (!params.autoplay) return;
  setTimeout(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.__GLITCHLESS_PLAYTEST_DONE__ = true;
  }, how === 'quit' ? 800 : 1500);
}

// An uncaught error stops Phaser's loop and freezes the screen. A player would leave; the bot does too,
// after long enough for Glitchless to notice the loop stopped.
window.addEventListener('error', () => {
  fetchGame.crashed = true;
  if (params.autoplay) setTimeout(() => onDone('crashed'), 4000);
});

const { scenes, state } = makeScenes(Phaser, { params, tel, onDone });
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: VIEW.width,
  height: VIEW.height,
  backgroundColor: '#14213d',
  physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 1800 } } },
  audio: { noAudio: true },
  scene: scenes,
});
instrument(game, Phaser);

const levelScene = () => game.scene.getScenes(true).find((s) => s.sys.settings.key.startsWith('level-'));
const api = {
  getState: () => levelScene()?.agentState() ?? { level: null, screen: game.scene.getScenes(true).map((s) => s.sys.settings.key) },
  loadLevel: (id) => {
    for (const s of game.scene.getScenes(true)) if (s.sys.settings.key.startsWith('level-') || s.sys.settings.key === 'Menu') s.scene.stop();
    game.scene.start(id);
    return { ok: true, level: id };
  },
  throwBall: () => {
    const s = levelScene();
    if (!s) return { ok: false, error: 'not on a level' };
    s.fetchBall({ disableBody() {} });
    return { ok: true, confetti_images: state.confetti };
  },
  teleport: (x) => {
    const s = levelScene();
    if (!s) return { ok: false, error: 'not on a level' };
    s.dog.body.reset(x, GROUND_Y - 80);
    return { ok: true, x };
  },
  setPaused: (paused) => {
    if (paused) game.pause();
    else game.resume();
    return { ok: true, paused };
  },
};
if (tel()) registerAgentTools(tel(), api);
fetchGame.api = api;
fetchGame.game = game;
