// Validates and normalizes SDK payloads into flat, storable events.
//
// The genre additions (docs/design/genre-coverage.md A5 to A9; SPEC §2) are checked here again for older and other
// SDKs: counters (`counts`), session properties (`session_start.props`, `props`), groups (`group`, and the `match`,
// `party` and `run` fields), zones (`zone`), network windows and disconnects (`frame_window.net`, `disconnect`,
// `reconnect`), and server mode: a batch whose envelope says `role: "server"` is filed under the game's companion
// service, `<service>.server`, so everything that keys by service keeps a game's servers apart from its players.
import { gunzipSync } from 'node:zlib';
import { propKeyProblem, propValue, gameAttrs, MAX_PROPS } from '../../packages/sdk/src/props.js';
import { GROUP_KINDS, validGroupId } from '../../packages/sdk/src/groups.js';
import { DISCONNECT_REASONS } from '../../packages/sdk/src/net.js';

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
  // The genre additions (SPEC §2): a window's counters, a change of properties, a group set or ended, a dropped and a
  // restored connection, and a server's own window.
  'counts',
  'props',
  'group',
  'disconnect',
  'reconnect',
  'server_window',
]);

// What intake answers in GET /v1/health `features` (SPEC §2): the SDKs send counters only to a server that folds them,
// and a server-role SDK sends nothing at all to one that can't keep its sessions apart.
export const FEATURES = ['counts', 'props', 'groups', 'zones', 'net', 'server_mode'];
// The companion service a game's servers are filed under (SPEC §6).
export const SERVER_SUFFIX = '.server';
export function companionOf(service) {
  return `${service}${SERVER_SUFFIX}`;
}
export function isCompanion(service) {
  return typeof service === 'string' && service.endsWith(SERVER_SUFFIX) && service.length > SERVER_SUFFIX.length;
}
export function gameOf(service) {
  return isCompanion(service) ? service.slice(0, -SERVER_SUFFIX.length) : service;
}

// A services list with each game's servers under the game: a companion service whose game is listed goes in the
// game's `server`, not in the list; one whose game sent nothing yet stays, marked `server_of`.
export function withServers(services) {
  const names = new Set(services.map((s) => s.service));
  const out = services.filter((s) => !(isCompanion(s.service) && names.has(gameOf(s.service)))).map((s) => (isCompanion(s.service) ? { ...s, server_of: gameOf(s.service) } : s));
  for (const s of services) {
    if (!isCompanion(s.service) || !names.has(gameOf(s.service))) continue;
    const game = out.find((x) => x.service === gameOf(s.service));
    game.server = { service: s.service, versions: s.versions, envs: s.envs, last_seen: s.last_seen };
  }
  return out;
}

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
  // A game's server (A9) sends the game's own service: its sessions go under the companion, never among players', and
  // carry no player ID.
  const server = payload.role === 'server';
  return {
    envelope: {
      project_id: projectId,
      service: server ? companionOf(service.toLowerCase()) : service.toLowerCase(),
      env: isId(env) ? env : 'dev',
      version: isId(version) ? version : '0.0.0',
      session_id,
      player_id: !server && isId(player_id) ? player_id : session_id,
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
    if (!genreFields(e)) continue;
    out.push({ ...e, ...envelope, level: e.level ?? null, received: now });
  }
  return out;
}

// ───────────────────────────── the genre additions ─────────────────────────────

const MAX_COUNT_ENTRIES = 256; // a window's 64, plus a name's (other) entry each, with room for other SDKs
const MAX_COUNT_N = 1e9;
const COUNT_GROUP = 4;
const COUNT_SUMS = 4;
const ZONE_LENGTH = 64;
const STAMPS = ['match', 'party', 'run'];

// Checks the fields and events of A5 to A9 in place; false drops the event. What breaks the rules is dropped, as the
// SDKs drop it: an invalid group ID, a property key that names a person, a value shaped like an email address.
function genreFields(e) {
  for (const k of STAMPS) if (k in e && !validGroupId(e[k])) delete e[k];
  if ('zone' in e) {
    if (typeof e.zone === 'string' && e.zone.trim()) e.zone = e.zone.trim().slice(0, ZONE_LENGTH);
    else delete e.zone;
  }
  switch (e.type) {
    case 'session_start':
      if ('props' in e) {
        const props = checkProps(e.props, false);
        if (props) e.props = props;
        else delete e.props;
      }
      if ('server' in e) {
        if (e.server && typeof e.server === 'object' && !Array.isArray(e.server)) e.server = serverInfo(e.server);
        else delete e.server;
      }
      return true;
    case 'level_start':
      if ('attrs' in e) {
        const attrs = gameAttrs(e.attrs);
        if (attrs) e.attrs = attrs;
        else delete e.attrs;
      }
      return true;
    case 'props': {
      const props = checkProps(e.props, true);
      if (!props) return false;
      e.props = props;
      return true;
    }
    case 'group':
      if (!GROUP_KINDS.includes(e.kind)) return false;
      if (e.id !== null && !validGroupId(e.id)) return false;
      if ('attrs' in e) {
        const attrs = gameAttrs(e.attrs);
        if (attrs) e.attrs = attrs;
        else delete e.attrs;
      }
      if ('resumed' in e && typeof e.resumed !== 'boolean') delete e.resumed;
      if ('ended' in e && !validGroupId(e.ended)) delete e.ended;
      return true;
    case 'counts':
      return countsEvent(e);
    case 'disconnect':
      e.reason = DISCONNECT_REASONS.has(e.reason) ? e.reason : 'other';
      for (const k of ['connected_s', 'rtt_p95', 'loss_pct']) if (!isNum(e[k])) e[k] = null;
      return true;
    case 'reconnect':
      if (!isNum(e.after_s)) e.after_s = null;
      return true;
    case 'frame_window':
      if ('net' in e && (!e.net || typeof e.net !== 'object' || Array.isArray(e.net))) delete e.net;
      return true;
    case 'server_window':
      return isNum(e.duration_s) || isNum(e.ticks);
  }
  return true;
}

// Session properties as intake keeps them (SPEC §2 props): at most 12 keys that follow the property rules, each a
// word, a flag or a whole number. `removals`: a props event says a key was removed with null. Null when none is left.
function checkProps(props, removals) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(props)) {
    if (n >= MAX_PROPS) break;
    if (propKeyProblem(key)) continue;
    if (value === null) {
      if (!removals) continue;
      out[key] = null;
      n++;
      continue;
    }
    const v = propValue(value);
    if (v === undefined) continue;
    out[key] = v;
    n++;
  }
  return n ? out : null;
}

// A server's description of itself (session_start.server): its tick rate, capacity, build and region in the game's
// words, and its host's OS, cores and memory. Never a host name or address.
function serverInfo(s) {
  const out = {};
  for (const k of ['tick_hz', 'max_players']) out[k] = isNum(s[k]) && s[k] >= 0 ? s[k] : null;
  for (const k of ['build', 'tick_source']) if (typeof s[k] === 'string' && s[k]) out[k] = s[k].slice(0, 24);
  const region = typeof s.region === 'string' ? propValue(s.region) : undefined;
  out.region = typeof region === 'string' ? region : null;
  if (s.host && typeof s.host === 'object') {
    out.host = {};
    if (typeof s.host.os === 'string') out.host.os = s.host.os.slice(0, 64);
    for (const k of ['cores', 'memory_gb']) if (isNum(s.host[k])) out.host[k] = s.host[k];
  }
  return out;
}

// A window's counters (SPEC §2 counts): each entry a name, up to 4 words or flags it is grouped by, a count and up to 4
// summed numbers. An entry that breaks the shape is dropped; an event left with none, and nothing dropped, is too.
function countsEvent(e) {
  if (!Array.isArray(e.counts)) return false;
  const counts = [];
  for (const c of e.counts.slice(0, MAX_COUNT_ENTRIES)) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name) continue;
    const n = Math.round(Number(c.n));
    if (!(n >= 1)) continue;
    const attrs = {};
    for (const [k, v] of Object.entries(plainObject(c.attrs))) {
      if (Object.keys(attrs).length >= COUNT_GROUP) break;
      if (typeof v === 'string') attrs[k.slice(0, 64)] = v.slice(0, 64);
      else if (typeof v === 'boolean') attrs[k.slice(0, 64)] = v;
    }
    const sums = {};
    for (const [k, v] of Object.entries(plainObject(c.sums))) {
      if (Object.keys(sums).length >= COUNT_SUMS) break;
      if (isNum(v)) sums[k.slice(0, 64)] = v;
    }
    counts.push({ name: c.name.slice(0, 64), attrs, n: Math.min(n, MAX_COUNT_N), ...(Object.keys(sums).length ? { sums } : {}), first_ts: isNum(c.first_ts) ? c.first_ts : e.ts });
  }
  e.counts = counts;
  e.dropped = isNum(e.dropped) && e.dropped > 0 ? Math.round(e.dropped) : 0;
  if (!isNum(e.duration_s)) e.duration_s = null;
  return counts.length > 0 || e.dropped > 0;
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
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
