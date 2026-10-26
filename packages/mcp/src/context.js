// What every Glitchless MCP tool shares: the connection to the Glitchless API it reads and writes, the helpers that
// shape a tool's reply, and the list of tools. Each area's tools live in tools/<area>.js and define themselves on
// import; createServer() builds a server from them, once for stdio (index.js) or once per HTTP request (http.js).

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const VERSION = '0.10.1';

// Where `glitchless-mcp login` keeps its workspace key: { url, token, workspace: { id, name }, scopes }.
export const CREDENTIALS_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'glitchless', 'credentials.json');
export function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// A connection: the Glitchless API an agent reaches and the key it reaches it with. A game key (gl_sk_…) reaches one
// game; a workspace key (gl_ws_…) every game in its workspace, and then every tool takes `game`. `game` is the one
// the agent last named; `fetch` is how requests go out (Glitchless Cloud answers its own MCP requests in-process).
export function connection({ base, apiKey = '', service = '', game = '', fetch = globalThis.fetch, client = '' }) {
  return { base: String(base).replace(/\/$/, ''), apiKey, service, game, fetch, client, games: null };
}

// On stdio, the one connection: GLITCHLESS_API_KEY wins; without it, a saved sign-in. Over HTTP each request runs
// with the connection its bearer token gives (createServer's `connection`).
const saved = process.env.GLITCHLESS_API_KEY ? null : readCredentials();
const local = connection({
  base: process.env.GLITCHLESS_URL || saved?.url || 'http://localhost:7777',
  apiKey: process.env.GLITCHLESS_API_KEY || saved?.token || '',
  service: process.env.GLITCHLESS_SERVICE || '',
  game: process.env.GLITCHLESS_GAME || '',
});
const connections = new AsyncLocalStorage();
const conn = () => connections.getStore() ?? local;

export const base = () => conn().base;
export const apiKey = () => conn().apiKey;
export const defaultService = () => conn().service;
export const isWorkspace = () => conn().apiKey.startsWith('gl_ws_');

// After a sign-in from inside the agent (glitchless_sign_in): the running server switches to the new key.
export function useCredentials({ url, token }) {
  Object.assign(local, { base: String(url).replace(/\/$/, ''), apiKey: token, games: null });
}

// The games a workspace key reaches, cached briefly; the game each call names (by name or id), else the one the
// connection last used (or GLITCHLESS_GAME), else the only game.
export async function workspaceGames(fresh = false) {
  const c = conn();
  if (!fresh && c.games && Date.now() - c.games.at < 30_000) return c.games.list;
  const { games: list, intake } = await agent('GET', '/games');
  c.games = { at: Date.now(), list, intake };
  return list;
}

// The intake address games send to, as the last game list gave it.
export const workspaceIntake = () => conn().games?.intake ?? null;

// How to add Glitchless to a game, in any engine: the setup steps a coding agent follows (docs/agent-setup-prompt.md).
export const SETUP_URL = 'https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/agent-setup-prompt.md';

export async function projectFor(game) {
  const c = conn();
  const want = game || c.game;
  let list = await workspaceGames();
  const find = () => list.find((g) => g.id === want) ?? list.find((g) => g.name.toLowerCase() === String(want).toLowerCase());
  let hit = want ? find() : list.length === 1 ? list[0] : null;
  if (want && !hit) {
    list = await workspaceGames(true);
    hit = find();
  }
  if (!list.length) throw new Error(`This workspace has no games yet: glitchless_list_games says how to make one (or the demo game, with a week of sample play), and the setup steps for adding Glitchless to a game are at ${SETUP_URL}.`);
  if (!hit) throw new Error(want ? `No game called "${want}" in this workspace. Games: ${list.map((g) => g.name).join(', ')}.` : `Name the game this is about (game: "<name>"): ${list.map((g) => g.name).join(', ')}.`);
  c.game = hit.id;
  return hit.id;
}

async function headers(extra = {}) {
  const client = conn().client || calls.getStore()?.server?.server.getClientVersion?.()?.name || 'mcp';
  return { 'x-glitchless-client': client, ...(apiKey() ? { 'x-glitchless-api-key': apiKey() } : {}), ...(isWorkspace() ? { 'x-glitchless-project': await projectFor(calls.getStore()?.game) } : {}), ...extra };
}

// A workspace key's own routes (/v1/agent/…, Glitchless Cloud).
export async function agent(method, p, body) {
  if (!isWorkspace()) throw new Error('This needs a workspace: sign in with glitchless_sign_in (or run `npx -y glitchless-mcp login`) on Glitchless Cloud.');
  const res = await conn().fetch(`${base()}/v1/agent${p}`, {
    method,
    headers: { 'x-glitchless-api-key': apiKey(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${data.error || `HTTP ${res.status}`}`);
  return data;
}

export async function query(name, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  const res = await conn().fetch(`${base()}/v1/query/${name}?${qs}`, { headers: await headers() });
  if (!res.ok) throw new Error(`Glitchless API ${name} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const call = calls.getStore();
  if (call && data?.meta) Object.assign(call, { meta: data.meta, from: params.from });
  return data;
}

// The tool call being answered: the game it names, the server answering it, and the meta of its last query, for
// windowNote().
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
  const res = await conn().fetch(`${base()}${p}`, {
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
  if (defaultService()) return defaultService();
  const { services } = await query('services');
  if (!services?.length) throw new Error(`No game has sent Glitchless any data yet. glitchless_list_games gives each game's client token and what to do next; the setup steps for adding the SDK are at ${SETUP_URL}. Data shows a few minutes after a level is played.`);
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
    .describe("Look-back window in hours (default 24), as far back as the workspace keeps data on Glitchless Cloud (the answer says when it starts later than asked). Past 744 (31 days) answers are by day."),
  version: z.string().optional().describe('Only include sessions from this game version'),
  steam_branch: z.string().optional().describe('Only include sessions that ran this Steam branch ("public", or a beta\'s name); games that use Steamworks send it'),
  env: z.string().optional().describe('Only include sessions from this environment, e.g. "prod" (what the game passes to init; builds a developer runs usually send "dev")'),
  session_type: z
    .enum(['user', 'tester', 'synthetic', 'all'])
    .optional()
    .describe('"user": players only; "tester": people on TestFlight and other test builds only; "synthetic": bots, playtests and store test devices only; "all" or unset: every session. Findings (glitchless_triage, and the overview\'s) read the production sessions of players unless env or session_type is given'),
  props: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
    .optional()
    .describe('Only sessions with these session properties (what the game set with setProperties): { rank: "diamond" }, or a list of values for any of them, { rank: ["diamond", "master"] }; "(none)" keeps the sessions without one. glitchless_events lists the properties and their values. Read from the sessions, so over 31 days or less'),
};

// The filters every read passes on to the Glitchless API: a session property becomes prop.<key>=<value>[,<value>…].
export function filters({ version, steam_branch, env, session_type, props } = {}) {
  const out = { version, steam_branch, env, type: session_type };
  for (const [key, value] of Object.entries(props || {})) out[`prop.${key}`] = (Array.isArray(value) ? value : [value]).map(String).join(',');
  return out;
}

// ── the tools ─────────────────────────────────────────────────────
// Every tool as its file defined it: { name, config, handler, scope, local }. Over HTTP a tool shows only to a
// connection whose scopes include its `scope` (read, dashboard or manage, as a workspace key's), and `local` tools
// (signing in, playtests, the Steam Deck) are left out: they act on the computer the server runs on.
const tools = [];

// The annotations a read gets: it changes nothing and reads only the person's own Glitchless data.
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function define(name, config, handler, { scope = 'read', local = false } = {}) {
  tools.push({ name, config: { ...config, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...config.annotations } }, handler, scope, local });
}

// A read-only tool.
export function tool(name, description, schema, handler) {
  define(name, { description, inputSchema: schema, annotations: READS }, handler);
}

// The tools a server built with these options shows: { name, title, description, annotations, scope, local }.
export function toolList({ remote = false, scopes = null } = {}) {
  return tools.filter((t) => !(remote && t.local) && (!scopes || scopes.includes(t.scope))).map((t) => ({ name: t.name, title: titleOf(t), description: t.config.description, annotations: t.config.annotations, scope: t.scope, local: t.local }));
}

// "glitchless_store_reviews" → "Store reviews", unless the tool names its own title.
const titleOf = (t) => t.config.title ?? `${t.name.replace(/^glitchless_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}`;

// Every tool takes `game` (by name or id): with a workspace key it picks the game, with a game key it's ignored.
const gameField = z.string().optional().describe('The game, by name or id, when signed in to a workspace (glitchless_list_games lists them); later calls keep it. Ignored with a key for one game.');

// A server with the tools. remote: the HTTP server's set (no local tools, and instructions to match); scopes: show
// only the tools these scopes allow; connection: what every call runs with (default: this process's own).
export function createServer({ remote = false, scopes = null, connection: c = null } = {}) {
  const server = new McpServer(
    { name: 'glitchless', title: 'Glitchless', version: VERSION, websiteUrl: 'https://www.glitchless.gg', icons: [{ src: 'https://app.glitchless.gg/brand/glitchless-icon-512.png', mimeType: 'image/png', sizes: ['512x512'] }] },
    { instructions: instructions(remote) },
  );
  for (const t of tools) {
    if ((remote && t.local) || (scopes && !scopes.includes(t.scope))) continue;
    const { inputSchema = {}, ...config } = t.config;
    server.registerTool(t.name, { ...config, title: titleOf(t), inputSchema: z.object({ game: gameField, ...inputSchema }) }, (args = {}, ctx) => {
      const run = () =>
        calls.run({ game: args.game, server }, async () => {
          try {
            return await t.handler(args, ctx);
          } catch (err) {
            return fail(err);
          }
        });
      return c ? connections.run(c, run) : run();
    });
  }
  return server;
}

function instructions(remote) {
  return [
    'Glitchless is observability for games made with Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot, Unreal or GameMaker.',
    remote
      ? "You're connected to the person's Glitchless workspace: glitchless_list_games lists every game (and says what to do when there is none, or a game has no data yet), glitchless_create_game makes one and hands back its client token (demo: true makes the demo game, Zoomies with a week of sample play, to try every tool on before a real game sends data), every tool takes game (by name), and glitchless_share_board makes a read-only link to a board."
      : "On Glitchless Cloud, glitchless_sign_in connects you to the person's whole workspace (they approve a code in the browser): then glitchless_list_games lists every game, glitchless_create_game makes one and hands back its client token, every tool takes game (by name), and glitchless_share_board makes a read-only link to a board.",
    'Start with glitchless_triage to get ranked, evidence-backed findings for a game, then drill in with glitchless_performance, glitchless_get_error, glitchless_death_hotspots or glitchless_session.',
    'When players or playtesters send bug reports from inside the game (an F8 form or a button), glitchless_bug_reports lists them with what they wrote, the level and where they stood, and opens one with its screenshot.',
    'For metrics the game defines itself (what it sends with track() and count(): plays, purchases, paywall views, kills and gold, and so on) and funnels between them, use glitchless_events; it also lists the session properties the game sets (rank, class, region), which every read tool takes as props.',
    'For a multiplayer game, glitchless_network gives ping, packet loss and disconnects by level, region, platform, kind of connection and version; glitchless_match lists matches or opens one from every side, telling a whole lobby lagging (the server) from one player lagging (their connection); and glitchless_servers reads the game\'s dedicated servers (tick time against its budget by players connected, crashes that ended matches, memory that climbs).',
    'For a game connected to a store (Steam, Google Play, the App Store), glitchless_store_reviews reads what players wrote there by build, with the hardware and Steam Deck playtime reviewers show, next to what Glitchless measured on that build, and glitchless_store_vitals what the store itself measured (slow rendering, crashes, ANRs, hangs) next to Glitchless, version by version.',
    "For a game connected to RevenueCat or to its own Stripe account, glitchless_revenue reads its real revenue by day, version and country (RevenueCat: production purchases only, by store too, installs and active users; Stripe: refunds, fees, net, new paying customers and revenue by product), next to the sessions, players and new players Glitchless measured and what the game's own purchase events add up to.",
    "Each game has its own dashboard, a list of pages (boards of panels, and built-in views such as Errors, Sessions and Live Tail): read it with glitchless_dashboard, and after instrumenting a game, design one that fits it with glitchless_set_dashboard.",
    ...(remote
      ? ['After shipping a fix (bump the version passed to Glitchless.init), use glitchless_compare_versions to confirm it with real players.']
      : [
          'Before changing game code, run glitchless_playtest with save_as "baseline"; after the change, run glitchless_playtest again to compare, and treat a FAIL as unfinished work. After shipping a fix (bump the version passed to Glitchless.init), use glitchless_compare_versions to confirm it with real players.',
          'If the game is running in a browser with WebMCP connected, its live tools (glitchless_live_performance, glitchless_measure, glitchless_inspect_scene, and game tools such as zoomies_load_level) let you reproduce and measure issues directly. Unity, Godot, Unreal and GameMaker builds measure themselves when run with --glitchless-measure=SECONDS (-glitchless-measure in Unreal and GameMaker); in the Unreal editor, Unreal MCP with the Glitchless Toolset has a Measure tool.',
        ]),
  ].join(' ');
}

export function slimIssue(i) {
  return { fingerprint: i.fingerprint, kind: i.kind, message: i.message, location: i.location, count: i.count, sessions: i.sessions, sessions_pct: i.sessions_pct, levels: i.levels, versions: i.versions, first_version: i.first_version, last_seen: new Date(i.last_seen).toISOString() };
}

export function slimGroup(g) {
  return { key: g.key, sessions: g.sessions, p50: g.p50, p95: g.p95, p99: g.p99, pct_over_budget: g.pct_over_budget, hitches_per_min: g.hitches_per_min, draw_calls: g.draw_calls };
}
