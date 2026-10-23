import * as BABYLON from '@babylonjs/core';
import { params } from './params.js';
import { startTelemetry, instrument, tel } from './telemetry.js';
import { createGame } from './game.js';
import { registerAgentTools } from './agent-tools.js';
import { ARENA } from './levels.js';

startTelemetry();

// The run is over (won, or the bot gave up): end the session the way closing the tab would.
const garden = (window.cometGarden = { won: false, quit: false, crashed: false });
function onDone(how) {
  garden[how] = true;
  if (!params.autoplay) return;
  setTimeout(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.__GLITCHLESS_PLAYTEST_DONE__ = true;
  }, how === 'quit' ? 800 : 1500);
}

// An uncaught error inside the render loop stops it for good and freezes the screen. A player would leave; the bot
// does too, after long enough for Glitchless to notice the loop stopped.
window.addEventListener('error', () => {
  garden.crashed = true;
  if (params.autoplay) setTimeout(() => onDone('crashed'), 4000);
});

const canvas = document.getElementById('game');
const engine = new BABYLON.Engine(canvas, true, { stencil: true });
// Each level's picture for the heatmaps, the first time it is ready.
const mapped = new Set();
const game = createGame({
  engine,
  params,
  tel,
  onDone,
  onSceneReady: (scene, level, world) => {
    if (mapped.has(level.id)) return;
    mapped.add(level.id);
    tel()?.captureMap(level.id, { axis: 'xz', bounds: { min: [-ARENA - 1, -ARENA - 1], max: [ARENA + 1, ARENA + 1] }, exclude: [world.marble] });
  },
});
game.load(params.level - 1);
instrument(engine, game.scene, BABYLON);
engine.runRenderLoop(() => game.scene?.render());
window.addEventListener('resize', () => engine.resize());
canvas.focus();

if (tel()) registerAgentTools(tel(), game.api);
garden.game = game;
garden.engine = engine;
