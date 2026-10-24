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
  'level_abandon',
  'death',
  'pos',
  'custom',
  'map',
  // A player's bug report: their note, and a JPEG screenshot as a data URL (SPEC §2 bug_report).
  'bug_report',
]);

const MAX_EVENTS = 500;
const MAX_STRING = 4000;

export class IntakeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A batch's own ID (SPEC §2 batch_id): the SDK makes it when it cuts the batch and sends it again with every
// retry, so intake can store a batch once however often it arrives.
const BATCH_ID = /^[A-Za-z0-9_.:-]{8,64}$/;
// How long a store remembers a batch it took. The engine SDKs keep unsent batches up to 6 days, and intake files
// anything older than 7 days under "now" (normalize below), so a repeat never arrives later than this.
export const BATCH_KEEP_MS = 7 * 86_400_000;

// `projectId` comes from the resolved ingest key and is stamped on every event; a payload can't set it.
// `batch` is the payload's batch_id, or null when it sent none (an older SDK) or one that isn't an ID.
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
    batch: typeof payload.batch_id === 'string' && BATCH_ID.test(payload.batch_id) ? payload.batch_id : null,
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
    // A report keeps the player's note even when its screenshot is too big or not an image.
    if (e.type === 'bug_report' && e.screenshot != null && (typeof e.screenshot !== 'string' || !e.screenshot.startsWith('data:image/') || e.screenshot.length > 200_000)) delete e.screenshot;
    if (e.type === 'session_start' && e.device && typeof e.device === 'object') e.device = distributionDevice(steamDevice(e.device));
    out.push({ ...e, ...envelope, level: e.level ?? null, received: now });
  }
  return out;
}

// The Steam facts an engine SDK reads from Steamworks at session start (SPEC §4c), kept only in the shapes they are
// sent in, so filters and breakdowns see one spelling. Steam hardware refines the SDKs' own Steam Deck tag.
const STEAM_HARDWARE = new Set(['deck', 'machine', 'frame', 'none']);
const STEAM_FLAGS = ['proton', 'big_picture', 'family_shared', 'timed_trial'];
const STEAM_WORDS = { steam_branch: 64, steam_controller: 32, steam_language: 32 };

export function steamDevice(device) {
  const d = { ...device };
  if ('steam_build' in d) {
    const build = typeof d.steam_build === 'string' && /^\d{1,10}$/.test(d.steam_build) ? Number(d.steam_build) : d.steam_build;
    if (Number.isSafeInteger(build) && build > 0) d.steam_build = build;
    else delete d.steam_build;
  }
  if ('steam_hardware' in d && !STEAM_HARDWARE.has(d.steam_hardware)) delete d.steam_hardware;
  for (const k of STEAM_FLAGS) if (k in d && typeof d[k] !== 'boolean') delete d[k];
  for (const [k, max] of Object.entries(STEAM_WORDS)) {
    if (!(k in d)) continue;
    if (typeof d[k] === 'string' && d[k].trim()) d[k] = d[k].trim().slice(0, max);
    else delete d[k];
  }
  if (d.steam_hardware === 'deck') d.steam_deck = true;
  return d;
}

// Where an iOS build was installed from (SPEC §4b), in the words the engine SDKs send, or nothing.
const DISTRIBUTIONS = new Set(['app_store', 'testflight', 'development']);

export function distributionDevice(device) {
  if (!('distribution' in device) || DISTRIBUTIONS.has(device.distribution)) return device;
  const { distribution: _, ...d } = device;
  return d;
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
