// Query-string knobs: ?autoplay=1&skill=0.3&seed=123&level=2&env=prod&intake=...&dashboard=...&nogd=1&mute=1
const q = new URLSearchParams(location.search);

function num(name, def, min = -Infinity, max = Infinity) {
  const v = parseFloat(q.get(name));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function flag(name) {
  const v = q.get(name);
  return v !== null && v !== '0' && v !== 'false';
}

function sameOrigin(v) {
  return v === 'same-origin' ? location.origin : v;
}

export const params = {
  autoplay: flag('autoplay'),
  skill: num('skill', 0.7, 0, 1),
  seed: Math.floor(num('seed', Math.floor(Math.random() * 1e9))),
  level: Math.floor(num('level', 1, 1, 3)),
  env: q.get('env') || 'dev',
  // VITE_GLITCHLESS_INTAKE=same-origin when the game is served by the Glitchless server itself (e.g. on AWS)
  intake: q.get('intake') || sameOrigin(import.meta.env.VITE_GLITCHLESS_INTAKE) || 'http://localhost:7777',
  dashboard: q.get('dashboard') || sameOrigin(import.meta.env.VITE_GLITCHLESS_INTAKE) || null,
  nogd: flag('nogd'),
  mute: flag('mute'),
};
