// Links to fill in before launch (README, "Before launch").

// The game's public Glitchless board: in Glitchless Cloud, open the Lagderboard board and press Share. Until there
// is a link, this placeholder stands in and the page says so.
export const LIVE_STATS_URL = import.meta.env.VITE_LAGDERBOARD_BOARD_URL || 'https://app.glitchless.gg/#/share/gl_share_PLACEHOLDER';
export const LIVE_STATS_IS_PLACEHOLDER = LIVE_STATS_URL.includes('PLACEHOLDER');

// What shared posts link to: the game's address (vite.config.js: VITE_LAGDERBOARD_URL, or the default for production
// builds), and in development wherever this page is served from.
// eslint-disable-next-line no-undef
export const SHARE_URL = __LAGDERBOARD_URL__ || `${location.origin}${location.pathname}`;
