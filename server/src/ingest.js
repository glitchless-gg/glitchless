// Validates and normalizes SDK payloads into flat, storable events.
import { gunzipSync } from 'node:zlib';

const MAX_DECODED_BODY = 8_000_000; // a gzipped body may unpack to at most this much (guards against gzip bombs)

// The browser SDK gzips its batches but keeps Content-Type: text/plain (no CORS preflight), so the
// body is recognised by gzip's magic bytes rather than a Content-Encoding header. Plain JSON passes through.
export function decodeBody(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf ?? '');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, { maxOutputLength: MAX_DECODED_BODY }).toString('utf8');
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new IntakeError(413, 'payload too large');
      throw new IntakeError(400, 'invalid gzip body');
    }
  }
  return buf.toString('utf8');
}

const EVENT_TYPES = new Set([
  'session_start',
  'session_end',
  'frame_window',
  'hitch',
  'load',
  'error',
  'level_start',
  'level_complete',
  'level_fail',
  'death',
  'pos',
  'custom',
  'map',
]);

const MAX_EVENTS = 500;
const MAX_STRING = 4000;

export class IntakeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// `projectId` comes from the resolved ingest key and is stamped on every event; a payload can't set it.
export function parsePayload(body, { projectId = null } = {}) {
  let payload;
  try {
    payload = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    throw new IntakeError(400, 'invalid JSON');
  }
  if (!payload || typeof payload !== 'object') throw new IntakeError(400, 'invalid payload');
  const { service, env, version, session_id, player_id, events } = payload;
  if (!isId(service) || !isId(session_id)) throw new IntakeError(400, 'service and session_id are required');
  if (!Array.isArray(events)) throw new IntakeError(400, 'events must be an array');
  return {
    envelope: {
      project_id: projectId,
      service: service.toLowerCase(),
      env: isId(env) ? env : 'dev',
      version: isId(version) ? version : '0.0.0',
      session_id,
      player_id: isId(player_id) ? player_id : session_id,
      sdk: typeof payload.sdk === 'string' ? payload.sdk.slice(0, 40) : null,
    },
    events: events.slice(0, MAX_EVENTS),
  };
}

// Flatten: every stored event carries its envelope so queries never need joins.
export function normalize({ envelope, events }, now = Date.now()) {
  const out = [];
  for (const raw of events) {
    if (!raw || !EVENT_TYPES.has(raw.type)) continue;
    const e = sanitize(raw);
    // Clamp client clocks: anything more than 1h in the future or 7d in the past is "now".
    if (typeof e.ts !== 'number' || e.ts > now + 3_600_000 || e.ts < now - 7 * 86_400_000) e.ts = now;
    if (e.type === 'map' && (typeof e.image !== 'string' || e.image.length > 120_000)) continue;
    out.push({ ...e, ...envelope, level: e.level ?? null, received: now });
  }
  return out;
}

function sanitize(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return value.length > MAX_STRING && !value.startsWith('data:image/') ? value.slice(0, MAX_STRING) : value;
  if (Array.isArray(value)) return value.slice(0, 2000).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('__')) continue;
      out[k.slice(0, 64)] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}
