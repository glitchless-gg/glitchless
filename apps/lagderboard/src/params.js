// Query-string knobs: ?autoplay=1&fast=1&offline=1&overlay=1&env=prod&intake=...
const q = new URLSearchParams(location.search);

function flag(name) {
  const v = q.get(name);
  return v !== null && v !== '0' && v !== 'false';
}

function sameOrigin(v) {
  return v === 'same-origin' ? location.origin : v;
}

export const params = {
  autoplay: flag('autoplay'), // a bot taps and presses MORE; sessions are tagged synthetic and runs stay off the board
  fast: flag('fast'), // the load grows 3x faster (testing)
  offline: flag('offline'), // Glitchless still measures and scores the run, and sends nothing
  overlay: flag('overlay'), // the Glitchless overlay, bottom-right
  env: q.get('env') || import.meta.env.VITE_GLITCHLESS_ENV || 'dev',
  intake: q.get('intake') || sameOrigin(import.meta.env.VITE_GLITCHLESS_INTAKE) || 'http://localhost:7777',
  token: import.meta.env.VITE_GLITCHLESS_TOKEN || 'gl_pub_dev',
};
