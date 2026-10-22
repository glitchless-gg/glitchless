// Query parameters. The playtest runner sets autoplay, seed, skill, level, env, intake and mute.
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);

export const params = {
  phaser: num('phaser', 3), // 3 or 4: which Phaser runs the game
  level: Math.min(3, Math.max(1, num('level', 1))),
  autoplay: q.get('autoplay') === '1',
  skill: Math.min(1, Math.max(0, num('skill', 0.7))),
  seed: num('seed', Math.floor(Math.random() * 1e9)),
  env: q.get('env') || 'dev',
  intake: q.get('intake') || import.meta.env.VITE_GLITCHLESS_INTAKE || 'http://localhost:7777',
  dashboard: q.get('dashboard') || 'http://localhost:7777',
  nogd: q.get('nogd') === '1',
};
