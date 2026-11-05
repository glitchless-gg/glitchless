// Serving jam rooms' games (rooms.js) on the open-source server: a port of its own, so games never share an origin
// with the dashboard or the API, serving the static layout rooms.js writes. Glitchless Cloud serves the same layout
// from S3 through CloudFront, with these same headers (PLAY_HEADERS).
//
//   /r/<CODE>/<slug>/            the game's current upload: its index.html with a <base> into the upload's folder
//   /r/<CODE>/<slug>/<n>/…       an upload's files, never changed, so they're cached for good
//
// Every upload is hostile until shown otherwise: types come from the extension (never sniffed), and the
// Content-Security-Policy keeps a game from calling any host but its own, a few CDNs and the Glitchless intake
// (no trackers, ads or mining pools on players' phones), posting forms, or being framed.
import { typeOf } from './rooms.js';

// Where vibe-coded games load three.js, Phaser and their fonts from.
export const CDNS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://esm.sh'];

// The headers every game's files are served with. intake: the origins games send telemetry to.
export function playHeaders(intake = [], { https = true } = {}) {
  const cdn = CDNS.join(' ');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${cdn}`,
    `style-src 'self' 'unsafe-inline' ${cdn} https://fonts.googleapis.com`,
    `font-src 'self' data: ${cdn} https://fonts.gstatic.com`,
    `img-src 'self' data: blob: ${cdn}`,
    "media-src 'self' data: blob:",
    `connect-src 'self' data: blob: ${cdn} ${intake.join(' ')}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), display-capture=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Robots-Tag': 'noindex',
  };
}

const NOT_FOUND = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not here</title><body style="font:16px/1.6 system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.4rem">No game here</h1><p>The jam this game was in may have ended: rooms are deleted a day after.</p></body>';

// files: rooms.js's file host (get). intake: as for playHeaders.
export function createPlay({ files, intake = [], https = false }) {
  const headers = playHeaders(intake, { https });
  return async function play(req, res) {
    const url = new URL(req.url, 'http://local');
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...headers, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'GET only', { 'Content-Type': 'text/plain' });
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      return send(400, 'bad path', { 'Content-Type': 'text/plain' });
    }
    const m = /^\/r\/([A-Z0-9]{5})\/([a-z0-9-]{1,32})(\/.*)?$/.exec(p);
    if (!m) return send(404, NOT_FOUND, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    const [, code, slug, rest] = m;
    if (!rest) return send(301, '', { Location: `/r/${code}/${slug}/${url.search}` });
    let file = rest.slice(1);
    if (file === '' || file.endsWith('/')) file += 'index.html';
    if (file.split('/').some((s) => !s || s.startsWith('.'))) return send(404, NOT_FOUND, { 'Content-Type': 'text/html; charset=utf-8' });
    const bytes = await files.get(`${code}/${slug}/${file}`);
    if (!bytes) return send(404, NOT_FOUND, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    // The game's own index.html moves with each publish; everything inside an upload's folder never changes.
    const current = file === 'index.html';
    return send(200, bytes, { 'Content-Type': typeOf(file) ?? 'application/octet-stream', 'Content-Length': String(bytes.length), 'Cache-Control': current ? 'no-cache' : 'public, max-age=31536000, immutable' });
  };
}
