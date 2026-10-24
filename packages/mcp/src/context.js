// What every Glitchless MCP tool shares: the server, the Glitchless API it reads and writes, and the
// helpers that shape a tool's reply. Each area's tools live in tools/<area>.js and register on import.

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Where `glitchless-mcp login` keeps its workspace key: { url, token, workspace: { id, name }, scopes }.
export const CREDENTIALS_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'glitchless', 'credentials.json');
export function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// GLITCHLESS_API_KEY wins; without it, a saved sign-in. A game key (gl_sk_…) reaches one game; a workspace key
// (gl_ws_…) every game in its workspace, and then every tool takes `game`.
const saved = process.env.GLITCHLESS_API_KEY ? null : readCredentials();
export let BASE = (process.env.GLITCHLESS_URL || saved?.url || 'http://localhost:7777').replace(/\/$/, '');
export let API_KEY = process.env.GLITCHLESS_API_KEY || saved?.token || '';
export const DEFAULT_SERVICE = process.env.GLITCHLESS_SERVICE || '';
export const isWorkspace = () => API_KEY.startsWith('gl_ws_');

// After a sign-in from inside the agent (glitchless_sign_in): the running server switches to the new key.
export function useCredentials({ url, token }) {
  BASE = String(url).replace(/\/$/, '');
  API_KEY = token;
  games = null;
}

export const server = new McpServer(
  { name: 'glitchless', version: '0.5.0' },
  {
    instructions:
      'Glitchless is observability for games made with Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot, Unreal or GameMaker. On Glitchless Cloud, glitchless_sign_in connects you to the person\'s whole workspace (they approve a code in the browser): then glitchless_list_games lists every game, glitchless_create_game makes one and hands back its client token, every tool takes game (by name), and glitchless_share_board makes a read-only link to a board. Start with glitchless_triage to get ranked, evidence-backed findings for a game, then drill in with glitchless_performance, glitchless_get_error, glitchless_death_hotspots or glitchless_session. When players or playtesters send bug reports from inside the game (an F8 form or a button), glitchless_bug_reports lists them with what they wrote, the level and where they stood, and opens one with its screenshot. For metrics the game defines itself (what it sends with track(): plays, purchases, paywall views and so on) and funnels between them, use glitchless_events. For a game connected to a store (Steam, Google Play, the App Store), glitchless_store_reviews reads what players wrote there by build, with the hardware and Steam Deck playtime reviewers show, next to what Glitchless measured on that build, and glitchless_store_vitals what the store itself measured (slow rendering, crashes, ANRs, hangs) next to Glitchless, version by version. Each game has its own dashboard, a list of pages (boards of panels, and built-in views such as Errors, Sessions and Live Tail): read it with glitchless_dashboard, and after instrumenting a game, design one that fits it with glitchless_set_dashboard. Before changing game code, run glitchless_playtest with save_as "baseline"; after the change, run glitchless_playtest again to compare, and treat a FAIL as unfinished work. After shipping a fix (bump the version passed to Glitchless.init), use glitchless_compare_versions to confirm it with real players. If the game is running in a browser with WebMCP connected, its live tools (glitchless_live_performance, glitchless_measure, glitchless_inspect_scene, and game tools such as zoomies_load_level) let you reproduce and measure issues directly. Unity, Godot, Unreal and GameMaker builds measure themselves when run with --glitchless-measure=SECONDS (-glitchless-measure in Unreal and GameMaker); in the Unreal editor, Unreal MCP with the Glitchless Toolset has a Measure tool.',
  },
);

// The games a workspace key reaches, cached briefly; the game each call names (by name or id), else the one the
// session last used (or GLITCHLESS_GAME), else the only game.
let games = null;
let currentGame = process.env.GLITCHLESS_GAME || '';
export async function workspaceGames(fresh = false) {
  if (!fresh && games && Date.now() - games.at < 30_000) return games.list;
  const { games: list } = await agent('GET', '/games');
  games = { at: Date.now(), list };
  return list;
}

export async function projectFor(game) {
  const want = game || currentGame;
  let list = await workspaceGames();
  const find = () => list.find((g) => g.id === want) ?? list.find((g) => g.name.toLowerCase() === String(want).toLowerCase());
  let hit = want ? find() : list.length === 1 ? list[0] : null;
  if (want && !hit) {
    list = await workspaceGames(true);
    hit = find();
  }
  if (!hit) throw new Error(want ? `No game called "${want}" in this workspace. Games: ${list.map((g) => g.name).join(', ') || 'none yet'}.` : `Name the game this is about (game: "<name>"): ${list.map((g) => g.name).join(', ') || 'none yet; glitchless_create_game makes one'}.`);
  currentGame = hit.id;
  return hit.id;
}

async function headers(extra = {}) {
  const client = server.server.getClientVersion?.()?.name || 'mcp';
  return { 'x-glitchless-client': client, ...(API_KEY ? { 'x-glitchless-api-key': API_KEY } : {}), ...(isWorkspace() ? { 'x-glitchless-project': await projectFor(calls.getStore()?.game) } : {}), ...extra };
}

// A workspace key's own routes (/v1/agent/…, Glitchless Cloud).
export async function agent(method, p, body) {
  if (!isWorkspace()) throw new Error('This needs a workspace: sign in with glitchless_sign_in (or run `npx -y glitchless-mcp login`) on Glitchless Cloud.');
  const res = await fetch(`${BASE}/v1/agent${p}`, {
    method,
    headers: { 'x-glitchless-api-key': API_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${data.error || `HTTP ${res.status}`}`);
  return data;
}

export async function query(name, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  const res = await fetch(`${BASE}/v1/query/${name}?${qs}`, { headers: await headers() });
  if (!res.ok) throw new Error(`Glitchless API ${name} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const call = calls.getStore();
  if (call && data?.meta) Object.assign(call, { meta: data.meta, from: params.from });
  return data;
}

// The tool call being answered: the meta of its last query, for windowNote().
const calls = new AsyncLocalStorage();

// How the window was answered, when an agent should know: by day past 31 days, what is estimated, what a
// view covers, a range cut to the plan's retention.
function windowNote() {
  const { meta, from } = calls.getStore() || {};
  if (!meta) return '';
  const parts = [];
  if (meta.resolution === 'day') parts.push('answered by day: each session counts on the day it started');
  if (meta.approximate?.length) parts.push(`estimated (sketches or samples): ${meta.approximate.join(', ')}`);
  if (meta.note) parts.push(meta.note);
  if (meta.retention_days && from != null && meta.from - from > 86400e3) parts.push(`the plan keeps ${meta.retention_days} days of data, so the window starts ${new Date(meta.from).toISOString().slice(0, 10)}`);
  return parts.length ? `\n(Note: ${parts.join('; ')}.)` : '';
}

export async function write(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: await headers({ 'content-type': 'application/json' }),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error(`${data.error || 'forbidden'}. Saving a dashboard needs a key with the dashboard scope (a workspace key from glitchless_sign_in has it).`);
  if (!res.ok) throw new Error(`Glitchless API ${method} ${p} → HTTP ${res.status}: ${data.error || ''}`);
  return data;
}

export async function resolveService(service) {
  if (service) return service;
  if (DEFAULT_SERVICE) return DEFAULT_SERVICE;
  const { services } = await query('services');
  if (!services?.length) throw new Error('No games are reporting to Glitchless yet. Add the SDK and play a level first.');
  return services.sort((a, b) => b.last_seen - a.last_seen)[0].service;
}

export function range(hours = 24) {
  const to = Date.now();
  return { from: to - hours * 3600e3, to };
}

export function reply(title, data) {
  return { content: [{ type: 'text', text: `${title}${windowNote()}\n\n${JSON.stringify(data, null, 2)}` }] };
}

export function fail(err) {
  return { content: [{ type: 'text', text: `Glitchless error: ${err.message}` }], isError: true };
}

export const common = {
  service: z.string().optional().describe('Game service name (defaults to the most recently active game)'),
  hours: z
    .number()
    .min(0.25)
    .max(9600)
    .optional()
    .describe("Look-back window in hours (default 24). Up to the plan's retention on Glitchless Cloud: 336 (14 days) on Free, 2160 (90 days) on Indie, 9600 (400 days) on Studio. Past 744 (31 days) answers are by day."),
  version: z.string().optional().describe('Only include sessions from this game version'),
  steam_branch: z.string().optional().describe('Only include sessions that ran this Steam branch ("public", or a beta\'s name); games that use Steamworks send it'),
};

// Every tool takes `game` (by name or id): with a workspace key it picks the game, with a game key it's ignored.
const gameField = z.string().optional().describe('The game, by name or id, when signed in to a workspace (glitchless_list_games lists them); later calls keep it. Ignored with a key for one game.');
const register = server.registerTool.bind(server);
server.registerTool = (name, config, handler) =>
  register(name, { ...config, inputSchema: { ...(config.inputSchema || {}), game: gameField } }, (args, extra) => calls.run({ game: args?.game }, () => handler(args || {}, extra)));

// A read-only tool: errors come back as a tool error, not a thrown exception.
export function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: true } }, async (args) =>
    calls.run({ game: args.game }, async () => {
      try {
        return await handler(args || {});
      } catch (err) {
        return fail(err);
      }
    }),
  );
}

export function slimIssue(i) {
  return { fingerprint: i.fingerprint, kind: i.kind, message: i.message, location: i.location, count: i.count, sessions: i.sessions, sessions_pct: i.sessions_pct, levels: i.levels, versions: i.versions, first_version: i.first_version, last_seen: new Date(i.last_seen).toISOString() };
}

export function slimGroup(g) {
  return { key: g.key, sessions: g.sessions, p50: g.p50, p95: g.p95, p99: g.p99, pct_over_budget: g.pct_over_budget, hitches_per_min: g.hitches_per_min, draw_calls: g.draw_calls };
}
