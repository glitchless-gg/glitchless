// The Glitchless SDK imports live in their own module so telemetry.js can load them with a dynamic
// import(): if the SDK is missing or broken, only this chunk fails and the game keeps running.
import { Glitchless } from 'glitchless';
import { instrumentThree } from 'glitchless/three';

export { Glitchless, instrumentThree };
