// Upload links (SPEC §3b Upload links): a short-lived address an agent sends one picture to with curl, for an agent
// that can't send a file through its tool call (the hosted MCP server reads no files on the agent's computer, and a
// banner in base64 is a quarter of a million characters in one call). `POST /v1/uploads` (dashboard scope) makes one
// for one game, service and slot: the logo, the banner, or one place's background with its axis and bounds.
// `PUT /v1/uploads/<token>` takes the picture with no key, checks it as the slot's own route does (brand.js, maps.js)
// and saves it as that route would (app.js serves both). A link lasts UPLOAD_LINKS.minutes and works once: the
// picture it saves spends it, and one refused for its size or type can be fixed and sent again until it ends.
//
// The host keeps the links, through createApp's `uploads`:
//
//   create(reader, { service, slot, params, by }) → { token, expiresAt (ms) }
//     reader: the auth hook's identity (it has the dashboard scope). Refuses with AuthError(429) past
//     UPLOAD_LINKS.perHour links a game an hour.
//   peek(token) → { projectId, service, slot, params, by } while the link is open, else null
//   claim(token) → the same, once: the link is spent after it (null when another request took it first or it ended)
//   origin (optional): the address links are made at; without it, the one the request that made the link came to
//
// memoryUploads() below keeps them in this process (the open-source server); Glitchless Cloud keeps them with its
// other short-lived tokens, so a link made on one server instance works on another. Either keeps only a hash of the
// token: the token is in the answer that makes it and nowhere else, never logged or stored.
import crypto from 'node:crypto';
import { AuthError } from './auth.js';
import { BRAND_IMAGES } from './brand.js';
import { MAP_UPLOAD, mapTarget } from './maps.js';

// putRps: uploads a second from one address (bursts of twice that), whatever the token.
export const UPLOAD_LINKS = { minutes: 10, perHour: 30, putRps: 2 };
export const SLOTS = ['logo', 'banner', 'background'];
const TOKEN_RE = /^gl_up_[A-Za-z0-9_-]{43}$/;

export const isUploadToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
export const newUploadToken = () => `gl_up_${crypto.randomBytes(32).toString('base64url')}`;
export const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// What a host refuses a game's link with past UPLOAD_LINKS.perHour.
export const tooManyLinks = () => new AuthError(429, `a game gets at most ${UPLOAD_LINKS.perHour} upload links an hour: send the picture as image (base64) instead, or wait`);

// The most a slot takes: { maxBytes, maxWidth, maxHeight }.
export const slotLimits = (slot) => (slot === 'background' ? MAP_UPLOAD : BRAND_IMAGES[slot]);

export class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The slot a POST /v1/uploads names and what its picture will need: { slot, params }, where a background's params are
// its place, axis and bounds as PUT /v1/maps takes them, checked now (maps.js mapTarget, a MapError) so a mistake
// shows before the picture is sent.
export function uploadTarget(query) {
  const slot = query.get('slot');
  if (!SLOTS.includes(slot)) throw new UploadError(400, `slot is ${SLOTS.join(', ')}: the picture this link takes`);
  if (slot !== 'background') return { slot, params: {} };
  const { place, axis, bounds } = mapTarget(query);
  return { slot, params: { ...place, axis, min: bounds.min.join(','), max: bounds.max.join(',') } };
}

// What POST /v1/uploads answers: the link, once, with what it takes and how to send to it.
export function uploadBody(origin, token, link, expiresAt, now = Date.now()) {
  const path = `/v1/uploads/${token}`;
  const url = `${origin}${path}`;
  const { maxBytes, maxWidth, maxHeight } = slotLimits(link.slot);
  return {
    url,
    path,
    service: link.service,
    slot: link.slot,
    ...link.params,
    expires_at: expiresAt,
    expires_in_s: Math.max(0, Math.round((expiresAt - now) / 1000)),
    max_bytes: maxBytes,
    max_width: maxWidth,
    max_height: maxHeight,
    types: ['image/png', 'image/jpeg', 'image/webp'],
    curl: `curl -X PUT --data-binary @<file> '${url}'`,
  };
}

// The links in this process: enough for one server, gone when it restarts.
export function memoryUploads({ now = Date.now, max = 10_000, origin = null } = {}) {
  const links = new Map(); // tokenHash → { projectId, service, slot, params, by, expiresAt }
  const made = new Map(); // `${projectId}\n${hour}` → links made
  const hourOf = () => Math.floor(now() / 3_600_000);
  const open = (link) => (link && link.expiresAt > now() ? link : null);
  return {
    origin,
    create(reader, link) {
      const hour = hourOf();
      for (const [k, l] of links) if (l.expiresAt <= now()) links.delete(k);
      for (const k of made.keys()) if (Number(k.slice(k.lastIndexOf('\n') + 1)) < hour) made.delete(k);
      const key = `${reader.projectId}\n${hour}`;
      const n = (made.get(key) ?? 0) + 1;
      if (n > UPLOAD_LINKS.perHour) throw tooManyLinks();
      made.set(key, n);
      const token = newUploadToken();
      const expiresAt = now() + UPLOAD_LINKS.minutes * 60_000;
      links.set(tokenHash(token), { ...link, projectId: reader.projectId, expiresAt });
      if (links.size > max) links.delete(links.keys().next().value);
      return { token, expiresAt };
    },
    peek(token) {
      return open(links.get(tokenHash(token)));
    },
    claim(token) {
      const h = tokenHash(token);
      const link = links.get(h);
      links.delete(h);
      return open(link);
    },
  };
}

// What the PUT answers in words, next to the brand or map it saved: what the picture is and where it shows.
export function savedLine(link, { brand, map }) {
  if (link.slot !== 'background') {
    const b = brand?.[link.slot];
    return `Saved the ${link.slot}${b ? `: ${b.width} × ${b.height} pixels` : ''}. It shows on the game's boards and share links now.`;
  }
  const name = link.params.level ? `level ${link.params.level}` : link.params.zone ? `zone ${link.params.zone}` : 'the whole game';
  const [w, h] = map.size;
  const [bw, bh] = [map.bounds.max[0] - map.bounds.min[0], map.bounds.max[1] - map.bounds.min[1]];
  // A picture shaped unlike its bounds is stretched to fit them: often bounds that don't match its edges.
  const shape = w / h / (bw / bh);
  const note = shape > 1.15 || shape < 0.87 ? ` The picture is ${w} × ${h} pixels but the bounds are ${round(bw)} × ${round(bh)} world units: it is stretched to fit them. Check that its edges are the bounds.` : '';
  return `Saved the background of ${name}: ${w} × ${h} pixels, ${map.axis === 'xy' ? 'a side view' : 'seen from above'}. The Heatmaps view and positions panels of ${name} draw on it now.${note}`;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
