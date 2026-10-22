// <script> build: window.Glitchless.init({...}); then window.Glitchless.instrumentThree(gd, {...})
// or window.Glitchless.instrumentPhaser(gd, { game })
import { Glitchless, SDK_VERSION } from './core.js';
import { instrumentThree } from './three.js';
import { instrumentPhaser } from './phaser.js';

const api = {
  init: (opts) => Glitchless.init(opts),
  instrumentThree,
  instrumentPhaser,
  get instance() {
    return Glitchless.instance;
  },
  version: SDK_VERSION,
};
window.Glitchless = api;
export default api;
