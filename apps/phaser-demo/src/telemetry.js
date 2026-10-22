// Glitchless wiring: init before the game starts, so the session begins with the page, then hand the
// Phaser game to instrumentPhaser. The game reaches the SDK through tel(), which is null with ?nogd=1.
import { Glitchless } from 'glitchless';
import { instrumentPhaser } from 'glitchless/phaser';
import { params } from './params.js';
import { GAME_VERSION } from './version.js';

let glitchless = null;

export const tel = () => glitchless;

export function startTelemetry() {
  if (params.nogd) return null;
  glitchless = Glitchless.init({
    service: 'fetch',
    version: GAME_VERSION,
    env: params.env,
    intake: params.intake,
    clientToken: 'gl_pub_dev',
    sessionType: params.autoplay ? 'synthetic' : 'user',
    positions: true, // anonymous mode, plus death places and movement for the heatmap
    dashboardUrl: params.dashboard,
  });
  return glitchless;
}

export function instrument(game, Phaser) {
  if (glitchless) instrumentPhaser(glitchless, { game, Phaser });
}
