// Glitchless wiring: init before the engine starts, so the session begins with the page, then hand the engine
// and scene to instrumentBabylon. The game reaches the SDK through tel(), which is null with ?nogd=1 or if the SDK
// fails to start: telemetry must never break the game.
import { Glitchless } from 'glitchless';
import { instrumentBabylon } from 'glitchless/babylon';
import { params } from './params.js';
import { GAME_VERSION } from './version.js';

let glitchless = null;

export const tel = () => glitchless;

export function startTelemetry() {
  if (params.nogd) return null;
  try {
    glitchless = Glitchless.init({
      service: 'comet-garden',
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

// BABYLON is optional: with it, captureMap can draw each level for the heatmaps.
export function instrument(engine, scene, BABYLON) {
  if (!glitchless) return;
  try {
    instrumentBabylon(glitchless, { engine, scene, BABYLON });
  } catch (err) {
    console.warn('Glitchless could not instrument Babylon.js', err);
  }
}
