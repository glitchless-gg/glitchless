// Glitchless wiring. The game only talks to `gd` (exported below); it is a no-op stub until the SDK
// loads, and stays a stub with ?nogd=1 or if the SDK can't be loaded. Telemetry must never break
// the game, so every call is wrapped.
import { params } from './params.js';
import { GAME_VERSION } from './version.js';

const METHODS = ['levelStart', 'levelComplete', 'levelFail', 'death', 'track', 'setPosition', 'setContext', 'captureMap', 'error', 'flush', 'registerTool'];

let real = null;
const warned = new Set();

/** Game-facing facade. Safe to call before/without the SDK. */
export const gd = { enabled: false };
for (const m of METHODS) {
  gd[m] = (...args) => {
    if (!real || typeof real[m] !== 'function') return undefined;
    try {
      return real[m](...args);
    } catch (err) {
      if (!warned.has(m)) {
        warned.add(m);
        console.warn(`[dead-reckoning] Glitchless.${m} threw — ignoring`, err);
      }
      return undefined;
    }
  };
}

// The SDK keeps sampling the last position it was given. Between attempts at a level (the replay, the
// card, menus) there is none, so the heatmap doesn't fill up with the goal.
gd.clearPosition = () => {
  if (real) real.position = null;
};

/** Load + init the SDK and instrument the Three.js renderer. Resolves once telemetry is ready (or
 * definitely unavailable). Never rejects. */
export async function initTelemetry({ renderer, scene, camera, THREE }) {
  if (params.nogd) {
    console.info('[dead-reckoning] Glitchless disabled (?nogd=1)');
    return gd;
  }
  try {
    const sdk = await Promise.race([
      import('./glitchless-sdk.js'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Glitchless SDK load timed out')), 4000)),
    ]);
    const { Glitchless, instrumentThree } = sdk;
    real = Glitchless.init({
      service: 'dead-reckoning',
      version: GAME_VERSION,
      env: params.env,
      intake: params.intake,
      clientToken: params.clientToken,
      // Anonymous (nothing stored on the device, so no consent banner) with positions on: death places and
      // 4 Hz samples in level tiles, which the markers are made of. 'install' would add a stored player ID,
      // for retention numbers; see README.md.
      privacy: 'anonymous',
      positions: true,
      sessionType: params.autoplay ? 'synthetic' : 'user',
      overlay: params.overlay,
      ...(params.overlay === false ? { webmcp: false } : {}), // ?overlay=0: no dev widgets at all
      dashboardUrl: params.dashboard || (params.env === 'dev' ? 'http://localhost:7777' : null),
    });
    instrumentThree(real, { renderer, scene, camera, THREE });
    gd.enabled = true;
    window.gd = real;
  } catch (err) {
    real = null;
    console.warn('[dead-reckoning] Glitchless SDK unavailable — running without telemetry.', err);
  }
  return gd;
}
