// Groups (SPEC §2 group): the match, party or run that a session's events belong to, shared by the browser SDK and the
// Node server SDK. Match and party IDs come from the game's servers; runs are made here. Match and party IDs are hashed
// before they are sent unless the game turns that off, so they can't be looked up as they are in the game's own match
// logs. Every Glitchless SDK hashes them the same way, with SHA-1 because every engine has it built in, so a browser
// client, a Unity client and a Node server in one match all send one ID:
//
//   "h_" + the first 24 hex characters of SHA-1("<the game's service, lower case>:<id>")

export const GROUP_KINDS = ['match', 'party', 'run'];
const GROUP_ID = /^[A-Za-z0-9_.:-]{8,64}$/;

export function validGroupId(id) {
  return typeof id === 'string' && GROUP_ID.test(id);
}

// The salt is the game's own service even on its server (filed under "<service>.server"), so both sides agree.
export function hashGroupId(service, id) {
  return 'h_' + sha1Hex(`${String(service).toLowerCase()}:${id}`).slice(0, 24);
}

// A run ID: "r_" and 12 characters. `randomId(n)` is the SDK's own random string maker.
export function newRunId(randomId) {
  return 'r_' + randomId(12);
}

// SHA-1 of a string's UTF-8 bytes, as 40 lower-case hex characters. Written out because the browser's own
// (crypto.subtle) answers in a promise, and a group must stamp the very next event.
export function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;
  let [a, b, c, d, e] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[off + t];
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [A, B, C, D, E] = [a, b, c, d, e];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (B & C) | (~B & D) : t < 40 ? B ^ C ^ D : t < 60 ? (B & C) | (B & D) | (C & D) : B ^ C ^ D;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (rotl(A, 5) + f + E + k + w[t]) >>> 0;
      [E, D, C, B, A] = [D, C, rotl(B, 30), A, tmp];
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
    e = (e + E) >>> 0;
  }
  return [a, b, c, d, e].map((v) => v.toString(16).padStart(8, '0')).join('');
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}
