// Glitchless wiring: init before the app starts, so the session begins with the page, then hand the app to
// instrumentPlayCanvas. The game reaches the SDK through tel(), which is null with ?nogd=1 or if the SDK fails to
// start: telemetry must never break the game.
import { Glitchless } from 'glitchless';
import { instrumentPlayCanvas } from 'glitchless/playcanvas';
import { params } from './params.js';
import { GAME_VERSION } from './version.js';

let glitchless = null;

export const tel = () => glitchless;

export function startTelemetry() {
  if (params.nogd) return null;
  try {
    glitchless = Glitchless.init({
      service: 'spark-run',
      version: GAME_VERSION,
      env: params.env,
      intake: params.intake,
      clientToken: 'gl_pub_dev',
      sessionType: params.autoplay ? 'synthetic' : 'user',
      positions: true, // anonymous mode, plus death places and movement for the heatmap
      dashboardUrl: params.dashboard,
      bugReports: { hotkey: 'F8' },
    });
  } catch (err) {
    console.warn('Glitchless did not start', err);
    glitchless = null;
  }
  return glitchless;
}

// pc is optional: with it, captureMap can draw each level for the heatmaps.
export function instrument(app, pc) {
  if (!glitchless) return;
  try {
    instrumentPlayCanvas(glitchless, { app, pc });
  } catch (err) {
    console.warn('Glitchless could not instrument PlayCanvas', err);
  }
}
