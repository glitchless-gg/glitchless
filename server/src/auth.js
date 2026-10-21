// Who may write to and read from which project.
//
// The server never decides tenancy itself: createApp({ auth }) takes two hooks, so the same code runs
// as the open-source single-project server (envAuth below) and as the hosted service, whose control
// plane resolves hashed per-project keys and Auth0/Cognito sessions.
//
//   resolveIngest(token, req) → { projectId, keyId?, rps? }
//     `token` is the public client token from POST /v1/intake?token=…  It ships inside game builds,
//     so it is write-only: a reader hook must never accept it. `keyId` names the key for rate limiting
//     (defaults to the token itself; pass a hash or database id instead of keeping raw tokens around).
//     `rps` overrides the per-key ingest rate (requests per second, per server process; 0 = unlimited).
//
//   resolveReader(req) → { projectId, scopes }
//     For every other /v1/ route except /v1/health. Scopes: 'read' (queries and the live tail) and
//     'delete' (DELETE /v1/data).
//
// Both may be async. To refuse, throw (or reject with) AuthError(status, message): 401 for a missing
// or unknown credential, 403 for a known one that isn't allowed. The resolved projectId is the only
// tenancy boundary: events are stamped with it and stored under it, and queries only ever read it.
// Client-sent fields such as `service` pick data within a project, never across projects.

import crypto from 'node:crypto';

export const DEFAULT_PROJECT = 'default';
export const SCOPES = ['read', 'delete'];
export const DEFAULT_INGEST_RPS = 1000;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Project ids end up inside storage keys, so keep them to a safe alphabet (no '#', '/', '|').
export function isProjectId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

// The open-source default: one fixed project, public client tokens for intake, and an optional read
// key for everything else. No read key means reads are open, as they always were for local use.
export function defaultAuth({ clientTokens = ['gl_pub_dev'], apiKey = null, projectId = DEFAULT_PROJECT, ingestRps = DEFAULT_INGEST_RPS } = {}) {
  if (apiKey && clientTokens.includes(apiKey)) throw new Error('GLITCHLESS_API_KEY must not also be a public client token');
  const readKey = apiKey ? digest(apiKey) : null;
  return {
    resolveIngest(token) {
      if (clientTokens.length && !clientTokens.includes(token)) throw new AuthError(403, 'invalid client token');
      return { projectId, rps: ingestRps };
    },
    resolveReader(req) {
      if (readKey) {
        const given = req.headers['x-glitchless-api-key'] || new URL(req.url, 'http://local').searchParams.get('api_key');
        if (!given || !crypto.timingSafeEqual(digest(given), readKey)) throw new AuthError(401, 'missing or invalid x-glitchless-api-key');
      }
      return { projectId, scopes: SCOPES };
    },
  };
}

// defaultAuth configured from GLITCHLESS_CLIENT_TOKENS, GLITCHLESS_API_KEY and GLITCHLESS_INGEST_RPS.
export function envAuth(env = process.env) {
  const rps = Number(env.GLITCHLESS_INGEST_RPS);
  return defaultAuth({
    clientTokens: (env.GLITCHLESS_CLIENT_TOKENS || 'gl_pub_dev').split(',').map((s) => s.trim()).filter(Boolean),
    apiKey: env.GLITCHLESS_API_KEY || null,
    ingestRps: env.GLITCHLESS_INGEST_RPS != null && env.GLITCHLESS_INGEST_RPS !== '' && Number.isFinite(rps) ? rps : DEFAULT_INGEST_RPS,
  });
}

// Token bucket per key, in memory: a brake on a leaked or looping client, not billing. Each server
// process (or Lambda instance) counts on its own. Bursts of up to 2 s worth of requests are allowed.
export class RateLimiter {
  constructor({ maxKeys = 10_000, now = Date.now } = {}) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;
    this.now = now;
  }

  // → 0 when allowed, otherwise the seconds to wait before retrying.
  take(key, rps) {
    if (!(rps > 0) || rps === Infinity) return 0;
    const now = this.now();
    const burst = rps * 2;
    let b = this.buckets.get(key);
    if (b) this.buckets.delete(key);
    else b = { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rps);
    b.at = now;
    this.buckets.set(key, b); // re-insert: Map order doubles as least-recently-used order
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rps));
  }
}

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}
