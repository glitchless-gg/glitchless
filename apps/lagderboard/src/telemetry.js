// Glitchless wiring. Here Glitchless is also the referee (judge.js scores runs from its frame-time measurement), so
// the SDK is imported with the game instead of behind a dynamic import. ?offline=1 measures and scores, sends nothing.
import { Glitchless } from 'glitchless';
import { instrumentThree } from 'glitchless/three';
import { params } from './params.js';
import { GAME_VERSION } from './version.js';

// No THREE namespace goes to instrumentThree: the game loads no assets (its loading manager would have nothing to
// time) and doesn't capture maps, and passing the namespace would keep all of three.js in the bundle.
export function initGlitchless({ renderer, scene, camera }) {
  const gd = Glitchless.init({
    service: 'lagderboard',
    version: GAME_VERSION,
    env: params.env,
    intake: params.offline ? null : params.intake,
    clientToken: params.token,
    overlay: params.overlay,
    sessionType: params.autoplay ? 'synthetic' : 'user',
    // privacy stays 'anonymous' (the default): no player ID, no GPU string in session_start. The device a run
    // was played on goes in run_end instead, because the leaderboard is about devices (README, "Privacy").
  });
  instrumentThree(gd, { renderer, scene, camera });
  window.gd = gd; // handy from the console
  return gd;
}

// Game events must never break a run.
const warned = new Set();
export function safely(gd, method, ...args) {
  try {
    return gd[method](...args);
  } catch (err) {
    if (!warned.has(method)) {
      warned.add(method);
      console.warn(`[lagderboard] Glitchless.${method} threw, ignoring`, err);
    }
    return undefined;
  }
}
