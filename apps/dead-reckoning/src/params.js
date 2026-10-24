// Query-string knobs and build settings.
//   ?autoplay=1&skill=0.6&seed=123&level=2&speed=4   the bot plays (session_type 'synthetic'); speed > 1 skips replays
//   ?markers=mock|none|<share link>|<board JSON url>  where everyone else's deaths come from
//   ?env=prod&intake=...&dashboard=...&nogd=1&mute=1&reveal=1&overlay=0&stay=1&poster=1
// Build-time (Vite) settings, for the deployed game: see README.md.
const q = new URLSearchParams(location.search);
const env = import.meta.env;

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

// PLACEHOLDER until the owner makes the game's public board and its share link (README.md, "Set up").
export const LIVE_STATS_PLACEHOLDER = 'https://app.glitchless.gg/#/share/gl_share_REPLACE_WITH_THE_BOARD_LINK';

const markers = q.get('markers') || env.VITE_MARKERS || (env.DEV ? 'mock' : 'none');

export const params = {
  autoplay: flag('autoplay'),
  skill: num('skill', 0.55, 0, 1),
  seed: Math.floor(num('seed', Math.floor(Math.random() * 1e9))),
  level: Math.floor(num('level', 0, 0, 5)), // 0: wherever the player got to
  speed: Math.floor(num('speed', 1, 1, 8)),
  env: q.get('env') || env.VITE_GLITCHLESS_ENV || (env.DEV ? 'dev' : 'prod'),
  intake: q.get('intake') || sameOrigin(env.VITE_GLITCHLESS_INTAKE) || (env.DEV ? 'http://localhost:7777' : 'https://api.glitchless.gg'),
  clientToken: env.VITE_GLITCHLESS_TOKEN || 'gl_pub_dev',
  dashboard: q.get('dashboard') || sameOrigin(env.VITE_GLITCHLESS_INTAKE) || null,
  api: q.get('api') || env.VITE_GLITCHLESS_API || 'https://api.glitchless.gg',
  markers,
  liveStatsUrl: env.VITE_LIVE_STATS_URL || (/gl_share_/.test(markers) && /^https?:/.test(markers) ? markers : LIVE_STATS_PLACEHOLDER),
  prod: !!env.PROD,
  gameUrl: env.VITE_GAME_URL || location.origin + location.pathname,
  nogd: flag('nogd'),
  mute: flag('mute'),
  reveal: flag('reveal'),
  overlay: q.has('overlay') ? flag('overlay') : undefined, // the Glitchless overlay (and WebMCP widget): default on outside prod
  stay: flag('stay'), // autoplay stops at the share card
  poster: flag('poster'), // the title alone, for the link-preview picture
};
