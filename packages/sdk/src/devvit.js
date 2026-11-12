// The relay for a game that runs inside a Reddit post (Reddit's Developer Platform, Devvit Web). SPEC §5g.
//
// A Devvit Web client runs in a webview that may fetch only its own app's /api/ paths, so the browser, Unity and Godot
// SDKs can't reach Glitchless from there. The app's own server can, once Reddit has approved the domain (devvit.json's
// permissions.http.domains). This module is that hop, for the game's Devvit server:
//
//   import { context } from '@devvit/web/server';
//   import { glitchlessRelay } from 'glitchless/devvit';
//   const glitchless = glitchlessRelay({ clientToken: 'gl_pub_…', context });
//   api.all('/glitchless/*', (c) => glitchless.fetch(c.req.raw));   // Hono, as Devvit's templates have it
//   // Node's own server (the hello-world template) or Express: glitchless.node(req, res)
//
// and the client sends to it: Glitchless.init({ …, intake: '/api/glitchless' }).
//
// What it does, and no more:
//   - forwards the SDKs' two requests, POST …/v1/intake and GET …/v1/health, to the one intake it was given, and
//     answers everything else 404: it is no open proxy. With `clientToken` it sends for that game only;
//   - takes at most what the intake takes (1 MB a request, 8 MB unpacked);
//   - adds where the game was played as session properties, `subreddit` and `post`, read from the app's request context;
//   - keeps every session anonymous: it drops `player_id` (install mode's stored ID, SPEC §4b), and replaces the
//     redditor's own username and user IDs with `<redditor>` wherever they turn up in a batch's text. It never forwards
//     the request's headers, which carry the redditor's identity in Devvit's `devvit-*` metadata.
//
// No dependencies, and nothing from @devvit: the game passes its `context` in. It runs on Node 18 or later (Devvit's
// servers run Node 24) and on any runtime with fetch, Request, Response and DecompressionStream.

import { propValue, MAX_PROPS } from './props.js';

export const DEFAULT_INTAKE = 'https://api.glitchless.gg';
const MAX_BODY = 1_000_000; // the intake's own limit a request (server/src/app.js)
const MAX_UNPACKED = 8_000_000; // and what a gzipped batch may unpack to (server/src/ingest.js)
const TIMEOUT_MS = 10_000; // Devvit gives a request 30 s; a batch that waits longer is sent again by the SDK
const HEALTH_MS = 5 * 60_000; // /v1/health answers what the intake reads, which changes with a deploy
const PUBLIC_TOKEN = /^gl_pub_[A-Za-z0-9_-]{1,200}$/;
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;
const POST = /^t3_[a-z0-9]{1,16}$/i;
const SCRUBBED = '<redditor>';

/**
 * @param {object} options
 * @param {string} [options.intake]  the Glitchless intake, an absolute URL (Glitchless Cloud by default)
 * @param {string} [options.clientToken]  the game's public client token (gl_pub_…): sends for this game only
 * @param {object|function} [options.context]  Devvit's server `context` (from '@devvit/web/server'), or a function
 *   returning the request's context: subredditName and postId are read from it, userId, username and loid only to
 *   scrub them
 * @param {function} [options.fetch]  the fetch to forward with (tests)
 */
export function glitchlessRelay({ intake = DEFAULT_INTAKE, clientToken = null, context = null, fetch: send = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = intakeBase(intake);
  if (clientToken != null && !PUBLIC_TOKEN.test(clientToken)) throw new Error('glitchlessRelay: clientToken is the game\'s public client token, gl_pub_…');
  let health = null; // { at, status, body }

  // The one place a request is answered: { status, headers, body } from the method, the URL and the raw body.
  async function handle(method, url, body) {
    const path = url.pathname.replace(/\/+$/, '');
    if (method === 'OPTIONS') return answer(204, '');
    if (path.endsWith('/v1/health')) {
      if (method !== 'GET' && method !== 'HEAD') return answer(405, { error: 'GET only' });
      return relayHealth();
    }
    if (!path.endsWith('/v1/intake')) return answer(404, { error: 'the Glitchless relay forwards /v1/intake and /v1/health only' });
    if (method !== 'POST') return answer(405, { error: 'POST only' });
    const asked = url.searchParams.get('token');
    if (clientToken && asked && asked !== clientToken) return answer(403, { error: 'this relay sends for one game, and that is not its client token' });
    const token = clientToken || asked;
    if (!token || !PUBLIC_TOKEN.test(token)) return answer(401, { error: 'a public client token (gl_pub_…) is needed: ?token=' });
    if (body.byteLength > MAX_BODY) return answer(413, { error: 'payload too large' });
    let payload;
    try {
      payload = JSON.parse(await unpack(body));
    } catch (err) {
      return err instanceof TooLarge ? answer(413, { error: 'payload too large' }) : answer(400, { error: 'invalid batch' });
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) return answer(400, { error: 'invalid batch' });
    anonymize(payload, readContext(context));
    return forward(`${base}/v1/intake?token=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify(payload) });
  }

  async function relayHealth() {
    if (health && Date.now() - health.at < HEALTH_MS) return answer(health.status, health.body, health.headers);
    const r = await forward(`${base}/v1/health`, { method: 'GET' });
    if (r.status === 200) health = { at: Date.now(), ...r };
    return r;
  }

  // Only the intake's answer comes back: its status, its JSON and Retry-After. An intake that can't be reached is a
  // 502, which the SDKs send again later.
  async function forward(target, { method, body }) {
    try {
      const r = await send(target, {
        method,
        body,
        headers: { ...(body ? { 'content-type': 'text/plain' } : {}), 'x-glitchless-relay': 'devvit' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const retry = r.headers.get('retry-after');
      return answer(r.status, await r.text(), retry ? { 'retry-after': retry } : {});
    } catch {
      return answer(502, { error: 'the Glitchless intake could not be reached' });
    }
  }

  return {
    /** A Fetch API handler: (Request) → Response. Hono: app.all('/api/glitchless/*', (c) => relay.fetch(c.req.raw)). */
    async fetch(request) {
      const body = request.method === 'POST' ? await readLimited(request.body) : new Uint8Array();
      const r = body ? await handle(request.method, new URL(request.url), body) : answer(413, { error: 'payload too large' });
      return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
    },
    /** A Node handler: (IncomingMessage, ServerResponse). Express: app.use('/api/glitchless', relay.node). */
    async node(req, res) {
      const body = req.method === 'POST' ? await readNode(req) : new Uint8Array();
      const r = body ? await handle(req.method, new URL(req.originalUrl ?? req.url, 'http://relay'), body) : answer(413, { error: 'payload too large' });
      res.writeHead(r.status, r.headers);
      res.end(r.status === 204 ? undefined : r.body);
    },
  };
}

// ───────────────────────────── the batch ─────────────────────────────

// Anonymous whatever the game set: no player ID (install mode's becomes anonymous mode; full mode keeps its device
// fields and positions, without the ID), the redditor's own names scrubbed, and the subreddit and post on the start.
export function anonymize(payload, reddit = {}) {
  payload.player_id = null;
  const names = identities(reddit);
  for (const e of payload.events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'session_start') {
      if (e.privacy === 'install') e.privacy = 'anonymous';
      e.props = withReddit(e.props, reddit);
    }
  }
  if (names.length) scrub(payload.events, names); // the envelope is the game's own settings and IDs
  return payload;
}

function withReddit(props, { subredditName, postId } = {}) {
  const out = props && typeof props === 'object' && !Array.isArray(props) ? { ...props } : {};
  const add = (key, value) => {
    if (key in out || Object.keys(out).length >= MAX_PROPS) return;
    const v = propValue(value);
    if (v !== undefined) out[key] = v;
  };
  if (SUBREDDIT.test(String(subredditName ?? ''))) add('subreddit', subredditName);
  if (POST.test(String(postId ?? ''))) add('post', postId);
  return Object.keys(out).length ? out : undefined;
}

// The redditor's username and IDs (t2_…, and a logged-out visitor's loid), as patterns that match them as whole words.
function identities({ username, userId, loid } = {}) {
  const words = [];
  if (typeof username === 'string' && username.length >= 3) words.push(username);
  for (const id of [userId, loid]) {
    if (typeof id !== 'string' || id.length < 4) continue;
    words.push(id);
    const bare = id.replace(/^t2_/, '');
    if (bare !== id && bare.length >= 6) words.push(bare);
  }
  return words.map((w) => new RegExp(`(?<![A-Za-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'gi'));
}

// Every string in the batch (pictures excepted: a data: URL is no text, and a match in base64 would break it).
function scrub(value, patterns) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubOne(value[i], patterns);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = scrubOne(value[k], patterns);
  }
  return value;
}

function scrubOne(v, patterns) {
  if (typeof v === 'string') return v.startsWith('data:') ? v : patterns.reduce((s, re) => s.replace(re, SCRUBBED), v);
  return v && typeof v === 'object' ? scrub(v, patterns) : v;
}

function readContext(context) {
  try {
    const ctx = typeof context === 'function' ? context() : context;
    if (!ctx) return {};
    // Devvit's context is a proxy over the request: read the fields now, inside the request.
    return { subredditName: ctx.subredditName, postId: ctx.postId, userId: ctx.userId, username: ctx.username, loid: ctx.loid };
  } catch {
    return {};
  }
}

// ───────────────────────────── bodies ─────────────────────────────

class TooLarge extends Error {}

async function unpack(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await collect(stream, MAX_UNPACKED));
}

// A stream's bytes, or null past `max` (the request is answered 413).
async function readLimited(stream, max = MAX_BODY) {
  if (!stream) return new Uint8Array();
  try {
    return await collect(stream, max);
  } catch (err) {
    if (err instanceof TooLarge) return null;
    throw err;
  }
}

async function collect(stream, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) throw new TooLarge();
    chunks.push(chunk);
  }
  return join(chunks, size);
}

// A Node request's body, or null past the limit. Express may have read it already (express.text()): then req.body.
// Past the limit the rest is read and dropped, so the client gets the 413 rather than a closed socket, as the
// intake's own readBody does; one that keeps sending past twice the limit is cut off.
function readNode(req, max = MAX_BODY) {
  if (typeof req.body === 'string' || req.body instanceof Uint8Array) {
    const bytes = typeof req.body === 'string' ? new TextEncoder().encode(req.body) : req.body;
    return Promise.resolve(bytes.byteLength > max ? null : bytes);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
      else if (size > max * 2) req.destroy();
    });
    req.on('end', () => resolve(size > max ? null : join(chunks, size)));
    req.on('error', reject);
  });
}

function join(chunks, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function answer(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, body: text, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } };
}

function intakeBase(intake) {
  let url;
  try {
    url = new URL(String(intake));
  } catch {
    throw new Error(`glitchlessRelay: intake is the Glitchless server's address, such as ${DEFAULT_INTAKE}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('glitchlessRelay: intake must be an http(s) address');
  return url.origin + url.pathname.replace(/\/+$/, '');
}
