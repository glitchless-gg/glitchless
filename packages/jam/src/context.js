// The connection glitchless-jam's tool and CLI share: which Glitchless server it calls, with which key, and the room
// and game it remembers. Signing in is Glitchless's own: GLITCHLESS_URL and GLITCHLESS_API_KEY win, else the sign-in
// `glitchless-mcp login` (or `glitchless-jam login`) saved, so signing in to either signs in both.
//
// With a workspace key (gl_ws_…, Glitchless Cloud) a maker's calls under /v1/rooms/{code}/games… name the game in
// x-glitchless-project, found by name or id in GET /v1/agent/games. An organiser's calls and the public reads name none.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.1';
export const DEFAULT_URL = 'http://localhost:7777';

const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'glitchless');

// Where glitchless-mcp keeps its sign-in: { url, token, workspace: { id, name }, scopes }.
export const credentialsFile = () => path.join(configDir(), 'credentials.json');
// The room and game this computer last joined or published to, per server: { [url]: { room, slug, project } }.
const stateFile = () => path.join(configDir(), 'jam.json');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

export const readCredentials = () => readJson(credentialsFile());
export function saveCredentials(c) {
  const credentials = { ...c, savedAt: new Date().toISOString() };
  writeJson(credentialsFile(), credentials);
  return credentials;
}

export class JamError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

const origin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

// A connection: { base, apiKey, client, fetch }. client is what x-glitchless-client says published (the MCP client's
// name, or 'cli').
export function connection({ base = DEFAULT_URL, apiKey = '', client = 'cli', fetch = globalThis.fetch } = {}) {
  return { base: String(base).replace(/\/$/, ''), apiKey, client, fetch, games: null, game: null };
}

// From the environment, else the saved sign-in. A saved key goes only to the server it was saved for, so pointing
// GLITCHLESS_URL at a meetup's own server never hands it a Glitchless Cloud key.
export function connect(env = process.env, opts = {}) {
  const saved = env.GLITCHLESS_API_KEY ? null : readCredentials();
  const savedFits = saved?.token && (!env.GLITCHLESS_URL || origin(env.GLITCHLESS_URL) === origin(saved.url));
  return connection({ base: env.GLITCHLESS_URL || (savedFits ? saved.url : '') || DEFAULT_URL, apiKey: env.GLITCHLESS_API_KEY || (savedFits ? saved.token : ''), ...opts });
}

export const isWorkspace = (c) => c.apiKey.startsWith('gl_ws_');

const RETRIES = 6;

// One call to the Glitchless API. opts: body (JSON) or raw (bytes, with type), project (x-glitchless-project), anon
// (a public read: no key), text (the answer as text). Answers the JSON, or throws the server's own message.
export async function request(c, method, p, { body, raw, type, project, anon = false, text = false } = {}) {
  const headers = { 'x-glitchless-client': c.client || 'cli' };
  if (c.apiKey && !anon) headers['x-glitchless-api-key'] = c.apiKey;
  if (project && !anon) headers['x-glitchless-project'] = project;
  let payload;
  if (raw) {
    headers['content-type'] = type || 'application/octet-stream';
    // A Blob, not a Buffer: Node's fetch fails outright on an error answer to a request whose body is a Buffer.
    payload = new Blob([raw]);
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  // A rate limit's 429 says when to try again (an upload's files arrive faster than the server takes them, past its
  // burst); a room's own limits (uploads an hour) say no Retry-After, and aren't tried again.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await c.fetch(`${c.base}${p}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    } catch (err) {
      throw new JamError(`can't reach the Glitchless server at ${c.base} (${err.cause?.code || err.cause?.message || err.message}): is it running, and is GLITCHLESS_URL right?`);
    }
    const wait = Number(res.headers.get('retry-after'));
    if (res.status !== 429 || !(wait > 0) || attempt >= RETRIES) break;
    await res.arrayBuffer().catch(() => {});
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
  }
  const answer = await res.text();
  let data = null;
  try {
    data = JSON.parse(answer);
  } catch {}
  if (!res.ok) {
    const why = data?.error?.message ?? data?.error ?? (answer.slice(0, 200) || `HTTP ${res.status}`);
    const hint = res.status === 401 ? ` Sign in with \`npx -y glitchless-jam login\`, or set GLITCHLESS_API_KEY for ${c.base}.` : '';
    throw new JamError(`${why}${hint}`, res.status);
  }
  return text ? answer : (data ?? {});
}

// The games a workspace key reaches: [{ id, name, services: [{ service, last_seen }] }], cached for 30 seconds.
async function workspaceGames(c, fresh = false) {
  if (!fresh && c.games && Date.now() - c.games.at < 30_000) return c.games.list;
  const { games = [] } = await request(c, 'GET', '/v1/agent/games');
  c.games = { at: Date.now(), list: games };
  return games;
}

// The workspace game a maker's call is about: `want` by id or name, else the one last named, else the only one.
// → { id, name, service } (its one service, if it has sent data), or null without a workspace key. The workspace's
// demo game (sample play, which every new workspace starts with) is never one: it isn't the maker's, and taking it as
// the only game would join a room with it before the maker has made theirs.
const MAKE_ONE = "Make your game first (glitchless-mcp's glitchless_create_game, or in the dashboard), then join the room with it.";
export async function gameFor(c, want = null) {
  if (!isWorkspace(c)) return null;
  want ||= c.game;
  let list = await workspaceGames(c);
  const find = () => list.find((g) => g.id === want) ?? list.find((g) => g.name.toLowerCase() === String(want).toLowerCase());
  const own = () => list.filter((g) => !g.demo);
  const names = () => own().map((g) => g.name).join(', ');
  let hit = want ? find() : own().length === 1 ? own()[0] : null;
  if ((want && !hit) || (!want && !own().length)) {
    list = await workspaceGames(c, true);
    hit = want ? find() : own().length === 1 ? own()[0] : null;
  }
  if (hit?.demo) throw new JamError(`"${hit.name}" is the workspace's demo game, with sample play: a room takes the game you're making. ${own().length ? `Your games: ${names()}.` : MAKE_ONE}`);
  if (!own().length) throw new JamError(`This workspace has ${list.length ? 'only its demo game' : 'no games yet'}. ${MAKE_ONE}`);
  if (!hit) throw new JamError(want ? `No game called "${want}" in this workspace. Games: ${names()}.` : `Name the game (game: "<name>"): ${names()}.`);
  c.game = hit.id;
  const services = (hit.services ?? []).filter((s) => !s.server_of).map((s) => s.service);
  return { id: hit.id, name: hit.name, service: services.length === 1 ? services[0] : null };
}

// ── the room and game this computer is in ──
export const normalRoom = (room) => {
  const code = String(room ?? '').trim().toUpperCase();
  if (!/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/.test(code)) throw new JamError(room ? `"${room}" isn't a room code: it's the 5 letters and digits the organiser shared, like K7Q2M` : 'Which room? Give room: the 5-character code the organiser shared, like K7Q2M.');
  return code;
};

export function remembered(c) {
  return readJson(stateFile())?.[c.base] ?? null;
}

export function remember(c, entry) {
  const all = readJson(stateFile()) ?? {};
  if (entry) all[c.base] = entry;
  else delete all[c.base];
  try {
    writeJson(stateFile(), all);
  } catch {}
}

// The room a call is about: the one given, else GLITCHLESS_ROOM, else the one last joined.
export function roomFor(c, room, env = process.env) {
  return normalRoom(room || env.GLITCHLESS_ROOM || remembered(c)?.room);
}

// The game this computer has in `room`: { slug, project } (project: the workspace game's id, or null), or null.
export function gameIn(c, room) {
  const r = remembered(c);
  return r?.room === room && r.slug ? { slug: r.slug, project: r.project ?? null } : null;
}
