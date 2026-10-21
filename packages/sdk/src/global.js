// <script> build: window.Glitchless.init({...}); window.Glitchless.instrumentThree(gd, {...})
import { Glitchless, SDK_VERSION } from './core.js';
import { instrumentThree } from './three.js';

const api = {
  init: (opts) => Glitchless.init(opts),
  instrumentThree,
  get instance() {
    return Glitchless.instance;
  },
  version: SDK_VERSION,
};
window.Glitchless = api;
export default api;
