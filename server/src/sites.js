// Where a web game was played: the site its page was on, for a board's `$site` (analytics.js SESSION_SPLITS) and the
// itch.io page's funnel (reviews.js). The browser SDK sends its page with session_start (SPEC §2: `page.url`, the
// page's origin and path, and `page.referrer`, the origin of the page that led there); a session keeps only their two
// hosts (session-state.js `page`), never a path, and this table names the sites games are put on. SPEC §3b.
//
// itch.io plays an HTML5 game in a frame on html-classic.itch.zone (a frame address that changes with every upload),
// inside the game's page on <maker>.itch.io, so the frame's referrer is the maker's page: either one says itch.io. A
// game's own page that a player reached from itch.io (a link on its page) counts as itch.io too, as it has the same
// referrer. A site is matched by its frames' hosts first (`hosts`), then by the page that led there (`referrers`); a
// host matches its own name and every name under it.
//
// The engines' web builds (a Godot web export, a Unity WebGL build) send no page, so they are "(none)" like a native
// build, unless the game sets a `site` property itself, which comes first, in its own words (as `graphics` does).
import { NONE, propOf } from './properties.js';

// A game in a Reddit post sends through its app's server (glitchless/devvit), which always sets the session's
// `subreddit` property, so an engine's web build there, which sends no page, still counts as played on Reddit.
export const REDDIT = 'Reddit';

// Each site: what a board shows (`site`), the hosts its game frames are served from, and the hosts of its own pages.
export const SITES = [
  { site: 'itch.io', hosts: ['itch.zone', 'itch.io'], referrers: ['itch.io'] },
  // CrazyGames' docs: a game's frame is on a crazygames.com subdomain (its sitelock checks the origin ends with it).
  { site: 'CrazyGames', hosts: ['crazygames.com'], referrers: ['crazygames.com'] },
  // Poki, Newgrounds and GX.games by their own addresses only, as the page that led to the game: the hosts their
  // frames are served from weren't confirmed (November 2026), so a frame there counts once its referrer says so.
  { site: 'Poki', hosts: [], referrers: ['poki.com'] },
  { site: 'Newgrounds', hosts: [], referrers: ['newgrounds.com'] },
  { site: 'GX.games', hosts: [], referrers: ['gx.games'] },
  // Reddit: a game in a post is a Devvit app's web view, served from a devvit.net host (SPEC §5g), in a page on reddit.com.
  { site: REDDIT, hosts: ['devvit.net'], referrers: ['reddit.com'] },
];
export const ITCH = 'itch.io';
// A page on the developer's own machine or network (localhost, *.local, a private address, a file opened directly).
export const LOCAL = 'localhost';
const MAX_HOST = 253;

// A session_start's page → { host, ref } (either may be null), or null without one. Only hosts are kept: `host` the
// page's own (lower case, without www.), `ref` the referrer's. A page opened from a file (the browser's origin "null")
// is the host "file".
export function pageHosts(page) {
  if (!page || typeof page !== 'object') return null;
  const host = hostOf(page.url);
  const ref = hostOf(page.referrer);
  return host || ref ? { host, ref } : null;
}

function hostOf(v) {
  if (typeof v !== 'string' || !v) return null;
  if (/^(null|file:)/i.test(v)) return 'file';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '').slice(0, MAX_HOST) || null;
  } catch {
    return null;
  }
}

const under = (host, name) => host === name || host.endsWith(`.${name}`);

// The site a page's hosts name: one of SITES, LOCAL, or the page's own host (a game's own site: mygame.com).
export function siteOfHosts(host, ref) {
  if (host) for (const x of SITES) if (x.hosts.some((h) => under(host, h))) return x.site;
  if (ref) for (const x of SITES) if (x.referrers.some((h) => under(ref, h))) return x.site;
  if (!host) return NONE;
  return isLocal(host) ? LOCAL : host;
}

// A session's site: the `site` property when the game sets one, else its page's (siteOfHosts), else Reddit when the
// Reddit relay set its `subreddit`, else "(none)": a native build, or an engine's web build, which sends no page.
export function siteOf(s) {
  const prop = propOf(s, 'site');
  if (prop != null) return prop;
  const site = s.page ? siteOfHosts(s.page.host ?? null, s.page.ref ?? null) : NONE;
  return site === NONE && propOf(s, 'subreddit') != null ? REDDIT : site;
}

function isLocal(host) {
  if (host === 'file' || host === 'localhost' || host === '[::1]' || host === '0.0.0.0') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
