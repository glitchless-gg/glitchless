// <script> build: window.Glitchless.init({...}); then window.Glitchless.instrumentThree(gd, {...})
// or window.Glitchless.instrumentPhaser(gd, { game }), instrumentBabylon(gd, { engine, scene }) or
// instrumentPlayCanvas(gd, { app })
import { Glitchless, SDK_VERSION } from './core.js';
import { instrumentThree } from './three.js';
import { instrumentPhaser } from './phaser.js';
import { instrumentBabylon } from './babylon.js';
import { instrumentPlayCanvas } from './playcanvas.js';

const api = {
  init: (opts) => Glitchless.init(opts),
  instrumentThree,
  instrumentPhaser,
  instrumentBabylon,
  instrumentPlayCanvas,
  get instance() {
    return Glitchless.instance;
  },
  version: SDK_VERSION,
};
window.Glitchless = api;
export default api;
