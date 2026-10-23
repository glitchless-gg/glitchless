import * as pc from 'playcanvas';
import { params } from './params.js';
import { startTelemetry, instrument, tel } from './telemetry.js';
import { createGame } from './game.js';
import { registerAgentTools } from './agent-tools.js';
import { HALF } from './levels.js';

startTelemetry();

// The run is over (won, or the bot gave up): end the session the way closing the tab would.
const run = (window.sparkRun = { won: false, quit: false });
function onDone(how) {
  run[how] = true;
  if (!params.autoplay) return;
  setTimeout(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.__GLITCHLESS_PLAYTEST_DONE__ = true;
  }, how === 'quit' ? 800 : 1500);
}

const canvas = document.getElementById('game');
const app = new pc.Application(canvas, { graphicsDeviceOptions: { antialias: true } });
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());
instrument(app, pc);

// Each track's picture for the heatmaps, the first time it is built.
const mapped = new Set();
const game = createGame({
  app,
  params,
  tel,
  onDone,
  onLevelBuilt: (level, board) => {
    if (mapped.has(level.id)) return;
    mapped.add(level.id);
    tel()?.captureMap(level.id, { axis: 'xz', bounds: { min: [-10, -HALF - 1.5], max: [level.length + 10, HALF + 1.5] }, exclude: [board] });
  },
});
app.start();
game.load(params.level - 1);

if (tel()) registerAgentTools(tel(), game.api);
run.game = game;
run.app = app;
