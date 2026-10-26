// The game's words on the wire, checked before they leave: session properties (SPEC §1 setProperties, §2 props) and the
// attributes of levels and groups (SPEC §2 level_start, group). Shared by the browser SDK and the Node server SDK.
//
// A property is what holds for a session, in the game's own words: the mode, a rank tier, a class, the server region.
// It goes in every privacy mode, so it must never say who the player is. Keys that name a person or a device are
// dropped by name, and values that look like an email address, a link, a phone number or an ID are dropped by shape.
// Intake checks the same again for older and other SDKs.

const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_PROPS = 12;
const PROP_NUMBER = 1_000_000;

// The built-in splits and filters, the Steam facts, and the fields every event carries.
const RESERVED = new Set([
  'version', 'level', 'env', 'platform', 'browser', 'device_tier', 'session_type', 'privacy', 'role', 'link', 'type',
  'players', 'sessions', 'hours', 'zone', 'match', 'party', 'run',
  'steam_build', 'steam_branch', 'steam_hardware', 'steam_deck', 'steam_controller', 'steam_language', 'proton',
  'big_picture', 'family_shared', 'timed_trial',
]);

const IDENTIFYING = new Set([
  'name', 'username', 'user', 'email', 'phone', 'user_id', 'account', 'account_id', 'player_id', 'steam_id', 'epic_id',
  'psn_id', 'xbox_id', 'ip', 'address', 'device_id', 'idfa', 'gaid', 'ad_id', 'location', 'lat', 'lon', 'city',
  'birthday', 'age', 'gender',
]);

const SHAPES = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // an email address
  /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i, // a link
  /\d{7}/, // a run of 7 or more digits
  /\+\d[\d\s().-]{6,}\d/, // a phone number written with its country code
  /\(\d{3}\)\s?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, // (555) 123-4567, 555-123-4567
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // a UUID
  /[0-9a-f]{16}/i, // 16 or more hex characters
];
// 16 or more characters of base64 with no spaces: random-looking, so it mixes upper case, lower case and digits.
// Snake-case game words (summer_2026, corpse_explosion) pass.
const BASE64_RUN = /[A-Za-z0-9+/=_-]{16,}/g;

export function looksIdentifying(text) {
  if (SHAPES.some((re) => re.test(text))) return true;
  for (const run of text.match(BASE64_RUN) || []) {
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

// Why a property key can't be used, or null when it can.
export function propKeyProblem(key) {
  if (!PROP_KEY.test(key)) return 'keys are lower-case words of up to 32 characters (a-z, 0-9, _)';
  if (RESERVED.has(key)) return 'it is a built-in split';
  if (IDENTIFYING.has(key)) return 'it would say who the player is';
  return null;
}

// A property value as it is sent, or undefined when it is dropped. A string is trimmed and cut to 64 characters; a
// number must be whole, from -1,000,000 to 1,000,000 (send bands, like level_band: '30-39', for anything finer).
export function propValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) <= PROP_NUMBER ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().slice(0, 64);
  return text && !looksIdentifying(text) ? text : undefined;
}

// Attributes as a custom event's are kept (SPEC §2 custom): 12 of them, strings cut to 64 characters, numbers,
// booleans, and lists of up to 16 distinct strings, numbers or booleans. Anything else is left out.
export function gameAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(attrs)) {
    if (n >= 12) break;
    const v = Array.isArray(value) ? listValue(value) : attrValue(value);
    if (v === undefined) continue;
    out[String(key).slice(0, 64)] = v;
    n++;
  }
  return n ? out : null;
}

function attrValue(v) {
  if (typeof v === 'string') return v.slice(0, 64);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  return undefined;
}

function listValue(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const v = attrValue(item);
    if (v === undefined || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length === 16) break;
  }
  return out;
}
