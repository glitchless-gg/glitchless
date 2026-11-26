// What every Glitchless MCP tool shares: the connection to the Glitchless API it reads and writes, the helpers that
// shape a tool's reply, and the list of tools. Each area's tools live in tools/<area>.js and define themselves on
// import; createServer() builds a server from them, once for stdio (index.js) or once per HTTP request (http.js).

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { serveSkills } from './served-skills.js';
import { TASKS, declaresTasks, runAsTask, serveTasks } from './tasks.js';

export const VERSION = '0.23.0';

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

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

// On stdio, the one connection: GLITCHLESS_URL and GLITCHLESS_API_KEY win, else the saved sign-in. A saved key goes
// only to the server it was saved for, so pointing GLITCHLESS_URL at a meetup's own server never hands it a Glitchless
// Cloud key: the connection goes without one (an open self-hosted server needs none), and `savedFor`, the origin the
// sign-in is for, says why on a 401. Over HTTP each request runs with the connection its bearer token gives
// (createServer's `connection`).
export function stdioConnection(env = process.env) {
  const saved = env.GLITCHLESS_API_KEY ? null : readCredentials();
  const savedAt = saved?.token ? originOf(saved.url) : null;
  const fits = Boolean(saved?.token) && (!env.GLITCHLESS_URL || (savedAt !== null && originOf(env.GLITCHLESS_URL) === savedAt));
  return {
    ...connection({
      base: env.GLITCHLESS_URL || (fits ? saved.url : '') || 'http://localhost:7777',
      apiKey: env.GLITCHLESS_API_KEY || (fits ? saved.token : ''),
      service: env.GLITCHLESS_SERVICE || '',
      game: env.GLITCHLESS_GAME || '',
    }),
    savedFor: saved?.token && !fits ? (savedAt ?? String(saved.url)) : null,
  };
}
const local = stdioConnection();
const connections = new AsyncLocalStorage();
const conn = () => connections.getStore() ?? local;

export const base = () => conn().base;
export const apiKey = () => conn().apiKey;
export const defaultService = () => conn().service;
export const isWorkspace = () => conn().apiKey.startsWith('gl_ws_');

// After a sign-in from inside the agent (glitchless_sign_in): the running server switches to the new key.
export function useCredentials({ url, token }) {
  Object.assign(local, { base: String(url).replace(/\/$/, ''), apiKey: token, games: null, savedFor: null });
}

// What a 401 adds when the saved sign-in was kept from this server: where it's for, and how to give this one a key.
function signInHint(status) {
  const { savedFor, base: at } = conn();
  return status === 401 && savedFor ? ` The saved sign-in is for ${savedFor} and isn't sent to another server: set GLITCHLESS_API_KEY for ${at}.` : '';
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

// How to add Glitchless to a game, in any engine: the setup steps a coding agent follows (docs/agent-setup-prompt.md),
// for a connection without glitchless_create_game, which hands over the steps for the game's engine itself.
export const SETUP_URL = 'https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/agent-setup-prompt.md';

// Whether an agent asks the person before it sends the Glitchless team feedback (glitchless_feedback). Off, as
// Cloudflare's agent feedback is: the agent sends, tells the person what it sent at the end of its turn, and never
// sends once they've said not to. The tool's description and the server's instructions both take the sentence from
// here; the skills and the setup prompt only name the tool, so asking first is this one line.
export const FEEDBACK_ASKS_FIRST = false;
export const feedbackConsent = () =>
  FEEDBACK_ASKS_FIRST ? 'Ask the person before sending each one, showing what you would send.' : 'You may send one without asking first, but never once the person has said not to.';

// Whether this call's connection shows the tools that need the manage scope (over HTTP, by the scopes the person gave
// it; on stdio every tool shows).
export const canManage = () => {
  const scopes = calls.getStore()?.scopes;
  return !scopes || scopes.includes('manage');
};

// Whether this call's connection may delete games: over HTTP, by the scopes its token carries (a token can carry fewer
// than its key); on stdio, Glitchless Cloud decides by the key.
export const canDeleteGames = () => {
  const scopes = calls.getStore()?.scopes;
  return !scopes || scopes.includes('delete_games');
};

// Where an agent gets the steps that add Glitchless to a game's code, as the end of a sentence: from
// glitchless_create_game (setup-guide.js) where the connection has it, else the setup prompt.
export const setupSteps = () =>
  canManage() ? "glitchless_create_game with the game's name and its engine (or files: what's in the game's folder) returns the steps for that engine" : `the setup steps are at ${SETUP_URL}`;

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
  if (!list.length) throw new Error(`This workspace has no games yet: glitchless_list_games says how to make one (or the demo game, with a week of sample play). To add Glitchless to a game: ${setupSteps()}.`);
  if (!hit) throw new Error(want ? `No game called "${want}" in this workspace. Games: ${list.map((g) => g.name).join(', ')}.` : `Name the game this is about (game: "<name>"): ${list.map((g) => g.name).join(', ')}.`);
  c.game = hit.id;
  return hit.id;
}

// After a game is deleted: later calls don't fall back to it.
export function forgetGame(id) {
  const c = conn();
  if (c.game === id) c.game = null;
}

// The app this call comes from, as it named itself connecting (MCP's clientInfo): { name, version }. A server over
// HTTP is made anew for each request, so a client that said it only when it connected (before the 2026-07-28 protocol)
// is named by its connection instead (the hosted server's: the OAuth client's name), with no version.
export const clientApp = () => {
  const info = calls.getStore()?.server?.server.getClientVersion?.();
  return { name: info?.name || conn().client || null, version: info?.name ? info.version || null : null };
};

// A workspace key names the game in x-glitchless-project. A key for one game sends the game a call names (or
// GLITCHLESS_GAME) as x-glitchless-game, so Glitchless Cloud refuses it when it isn't the key's game instead of
// answering, or writing, for the key's own game.
async function headers(extra = {}) {
  const client = conn().client || clientApp().name || 'mcp';
  const named = !isWorkspace() && (calls.getStore()?.game || conn().game);
  return { 'x-glitchless-client': client, ...(apiKey() ? { 'x-glitchless-api-key': apiKey() } : {}), ...(isWorkspace() ? { 'x-glitchless-project': await projectFor(calls.getStore()?.game) } : {}), ...(named ? { 'x-glitchless-game': encodeURIComponent(named) } : {}), ...extra };
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
  // The answer's code and fields go with the error, for a tool that answers one of them its own way.
  if (!res.ok) throw Object.assign(new Error(`${data.error || `HTTP ${res.status}`}`), { code: data.code ?? null, data });
  return data;
}

// A read the server refused (SPEC §3): it took too long and was stopped (503), or the server is busy with other large
// reads (429). Told apart by the body's `reason`, since a 429 is also a rate limit. → what to tell the agent, with what
// to do next in a tool's own terms, or null for any other answer.
const SMALLER = 'Call again with a smaller hours (for example 168, a week), then widen it if you need more.';
function refusal(res, text) {
  if (res.status !== 503 && res.status !== 429) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data?.reason === 'deadline') {
    const after = String(data.error).match(/[\d.]+ seconds?/)?.[0];
    return `This window was too big to read: Glitchless stopped the read${after ? ` after ${after}` : ''}. ${SMALLER}`;
  }
  if (data?.reason === 'busy' && data.behind === 'own') {
    return 'Another large read of yours (a tool call running at the same time) was still running, so this one waited for it and ran out of time. Nothing is wrong with the call: make it again once the other call has answered, one call at a time, or with a smaller hours.';
  }
  if (data?.reason === 'busy') {
    const wait = Number(res.headers.get('retry-after')) || 5;
    return `Glitchless is busy with other large reads right now. Nothing is wrong with the call: make it again in ${wait} second${wait === 1 ? '' : 's'}, or now with a smaller hours.`;
  }
  return null;
}

// The hosted server answers a tool call within one web request, however many reads the tool makes, and each read has
// the server's 25 seconds of its own. So a call that has used this long gives up the read it is waiting on and says
// why, where the agent would otherwise get a dropped connection. (The read itself stops at the server's deadline.)
export const CALL_LIMITS = { ms: 27_000 };
function withinCall(read) {
  const call = calls.getStore();
  if (!call?.remote) return read;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`This window was too big to read in one call: its reads took more than ${Math.round(CALL_LIMITS.ms / 100) / 10} seconds together (waiting for any other large read of yours running at the same time included), so the call was stopped. ${SMALLER} Make large calls one at a time.`)), Math.max(0, CALL_LIMITS.ms - (Date.now() - call.startedAt)));
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

export async function query(name, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  const res = await withinCall(conn().fetch(`${base()}/v1/query/${name}?${qs}`, { headers: await headers() }));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(refusal(res, text) ?? `Glitchless API ${name} → HTTP ${res.status}: ${text.slice(0, 200)}${signInHint(res.status)}`);
  }
  const data = await res.json();
  const call = calls.getStore();
  if (call && data?.meta) Object.assign(call, { meta: data.meta, from: params.from });
  return data;
}

// The tool call being answered: the game it names, the server answering it, the scopes its connection shows tools for
// (over HTTP), the meta of its last query, for windowNote(), and its task when it runs as one (tasks.js).
const calls = new AsyncLocalStorage();

// How a tool that takes a while says what it's doing, and hears that it should stop. log(message) is a progress
// notification on the call when its client gave a progressToken, or the task's statusMessage when the call runs as a
// task. signal, only when the call runs as a task, fires when the client cancels the task (or the call, before it
// answered). A call that isn't a task keeps running when its client gives up on it, as it always has: a client whose
// tool timeout cancels a long playtest still gets its baseline saved.
//
// cantStop() says the work ignores signal (an older glitchless-playtest), so a cancelled task says so instead of
// claiming the run stopped.
export function callProgress(ctx) {
  const task = calls.getStore()?.task;
  if (task) return { log: task.update, signal: task.signal, cantStop: task.cantStop };
  const token = ctx?.mcpReq?._meta?.progressToken;
  let step = 0;
  const log = (message) => {
    if (token != null) ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }).catch(() => {});
  };
  return { log, signal: undefined, cantStop: () => {} };
}

// Whether this call's client can ask the person something while the call runs (MCP elicitation): mode 'form', fields
// to fill in, or 'url', a page to open. A tool asks by returning inputRequired(…): a client on the 2026-07-28 protocol
// asks the person and calls again with the answer, and on an older connection the SDK sends the question itself and
// calls the tool again. It's read where the SDK reads it: the request's own capabilities on 2026-07-28, else what the
// client said when it connected. A server over HTTP never hears that (each request gets a server of its own, which
// couldn't take the answer either), so an older client is never asked there. A bare elicitation: {} is form only.
export function canElicit(ctx, mode = 'form') {
  const call = calls.getStore();
  const s = call?.server?.server;
  const modern = String(s?.getNegotiatedProtocolVersion?.() ?? '') >= '2026-07-28';
  const caps = modern ? ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY] : call?.remote ? undefined : s?.getClientCapabilities?.();
  const e = caps?.elicitation;
  if (!e || typeof e !== 'object') return false;
  return mode === 'url' ? e.url !== undefined : e.form !== undefined || e.url === undefined;
}

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
  if (!res.ok) throw new Error(`Glitchless API ${method} ${p} → HTTP ${res.status}: ${data.error || ''}${signInHint(res.status)}`);
  return data;
}

// A body that isn't JSON (a picture: PUT /v1/maps), with the same headers as write().
export async function upload(method, p, bytes, type) {
  const res = await conn().fetch(`${base()}${p}`, { method, headers: await headers({ 'content-type': type }), body: bytes });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error(`${data.error || 'forbidden'}. Uploading needs a key with the dashboard scope (a workspace key from glitchless_sign_in has it).`);
  if (!res.ok) throw new Error(`Glitchless API ${method} ${p.split('?')[0]} → HTTP ${res.status}: ${data.error || ''}${signInHint(res.status)}`);
  return data;
}

// Whether this call is answered by a server over HTTP (the hosted one, or `glitchless-mcp serve`), which can't read the
// agent's files: a tool that takes a file path takes its contents there instead.
export const isRemote = () => !!calls.getStore()?.remote;

export async function resolveService(service) {
  if (service) return service;
  if (defaultService()) return defaultService();
  const { services } = await query('services');
  if (!services?.length) throw new Error(`No game has sent Glitchless any data yet. glitchless_list_games gives each game's client token and what to do next. To add the SDK: ${setupSteps()}. Data shows a few minutes after a level is played.`);
  return services.sort((a, b) => b.last_seen - a.last_seen)[0].service;
}

export function range(hours = 24) {
  const to = Date.now();
  return { from: to - hours * 3600e3, to };
}

// rows: one row of each list per line (a level, an event, a match), so a long answer stays short and still reads as JSON.
export function reply(title, data, { rows = false } = {}) {
  return { content: [{ type: 'text', text: `${title}${windowNote()}\n\n${rows ? rowsJSON(data) : JSON.stringify(data, null, 2)}` }] };
}

// JSON with a line per top-level field, and a line per element of a list of objects.
function rowsJSON(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return JSON.stringify(data);
  const field = (v) => (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object') ? `[\n${v.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : JSON.stringify(v));
  return `{\n${Object.entries(data).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${JSON.stringify(k)}: ${field(v)}`).join(',\n')}\n}`;
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
    .describe("Look-back window in hours (default 24), as far back as the workspace keeps data on Glitchless Cloud (the answer says when it starts later than asked). Past 744 (31 days) answers are by day. A window that takes more than 25 seconds to read is stopped and the tool says so: ask again with fewer hours. When Glitchless is busy with other large reads the tool says to try again in a few seconds. On Glitchless Cloud an answer reads at most 100,000 raw events in all (props, Steam filters, matches and positions read them, and session_type only over data stored before it was kept by type), the latest ones, and its note says from when."),
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
// Every tool as its file defined it: { name, config, handler, scope, local, task }. Over HTTP a tool shows only to a
// connection whose scopes include its `scope` (read, dashboard or manage, as a workspace key's), and `local` tools
// (signing in, playtests, the Steam Deck) are left out: they act on the computer the server runs on. A `task` tool
// takes minutes, and runs as a task for a client that takes them (tasks.js): on stdio only.
const tools = [];

// The annotations a read gets: it changes nothing and reads only the person's own Glitchless data.
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function define(name, config, handler, { scope = 'read', local = false, task = false } = {}) {
  tools.push({ name, config: { ...config, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...config.annotations } }, handler, scope, local, task });
}

// A read-only tool.
export function tool(name, description, schema, handler) {
  define(name, { description, inputSchema: schema, annotations: READS }, handler);
}

// The tools a server built with these options shows: { name, title, description, annotations, scope, local }.
export function toolList({ remote = false, scopes = null } = {}) {
  return tools.filter((t) => !(remote && t.local) && (!scopes || scopes.includes(t.scope))).map((t) => ({ name: t.name, title: titleOf(t), description: t.config.description, annotations: t.config.annotations, scope: t.scope, local: t.local }));
}

// "glitchless_get_error" → "Get error", unless the tool names its own title.
const titleOf = (t) => t.config.title ?? `${t.name.replace(/^glitchless_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}`;

// Every tool takes `game` (by name or id): with a workspace key it picks the game, with a game key it's ignored.
const gameField = z.string().optional().describe('The game, by name or id, when signed in to a workspace (glitchless_list_games lists them); later calls keep it. With a key for one game (gl_sk_…), a call that names another game is refused: sign in to the workspace to reach every game.');

// A server with the tools. remote: the HTTP server's set (no local tools, and instructions to match); scopes: show
// only the tools these scopes allow; connection: what every call runs with (default: this process's own); skills:
// serve the skills over MCP (served-skills.js), which the Claude Code plugin's own copy turns off, since the plugin
// carries them itself.
//
// The tools are all there before the server connects and never change while it runs, so it says it sends no
// tool-list changes (McpServer would say it does). A client that is promised them opens a subscriptions/listen
// stream and waits: over HTTP that is one request held open per connected agent, for news that never comes. Told
// there are none, a client doesn't listen, and one that listens anyway is acknowledged with nothing and closed at
// once. Every tools/list answer is marked stale straight away (ttlMs 0), so a client that asks again gets the
// current list; one that stays connected through a release keeps the list it loaded until it reconnects.
//
// On stdio it also serves tasks (tasks.js), and says so in server/discover's capabilities: a `task` tool called by a
// client that takes tasks answers with one, and tasks/get, tasks/cancel and tasks/update answer for it. Over HTTP there
// are none.
export function createServer({ remote = false, scopes = null, connection: c = null, skills = true } = {}) {
  const server = new McpServer(
    { name: 'glitchless', title: 'Glitchless', version: VERSION, websiteUrl: 'https://www.glitchless.gg', icons: [{ src: 'https://app.glitchless.gg/brand/glitchless-icon-512.png', mimeType: 'image/png', sizes: ['512x512'] }] },
    { instructions: instructions(remote, scopes), capabilities: { tools: { listChanged: false }, ...(remote ? {} : { extensions: { [TASKS]: {} } }) } },
  );
  if (skills) serveSkills(server, { remote, scopes });
  for (const t of tools) {
    if ((remote && t.local) || (scopes && !scopes.includes(t.scope))) continue;
    const { inputSchema = {}, ...config } = t.config;
    server.registerTool(t.name, { ...config, title: titleOf(t), inputSchema: z.object({ game: gameField, ...inputSchema }) }, (args = {}, ctx) => {
      const call = { game: args.game, server, remote, scopes, startedAt: Date.now() };
      const handle = () =>
        calls.run(call, async () => {
          try {
            return await t.handler(args, ctx);
          } catch (err) {
            return fail(err);
          }
        });
      // A tool that takes minutes, for a client that said on this call it takes tasks: the task, at once.
      const run = t.task && !remote && declaresTasks(ctx, server.server) ? () => runAsTask((task) => ((call.task = task), handle()), { signal: ctx.mcpReq.signal }) : handle;
      return c ? connections.run(c, run) : run();
    });
  }
  if (!remote) {
    serveTasks(server.server);
    // Only a 2026-07-28 connection can take a task, so initialize's answer (an older client) leaves the extension out;
    // server/discover lists it. Other extensions stay as they are.
    const capabilities = server.server.getCapabilities.bind(server.server);
    server.server.getCapabilities = () => {
      const caps = capabilities();
      if (!caps.extensions?.[TASKS] || String(server.server.getNegotiatedProtocolVersion?.() ?? '') >= '2026-07-28') return caps;
      const { extensions, ...rest } = caps;
      const { [TASKS]: _tasks, ...others } = extensions;
      return Object.keys(others).length ? { ...rest, extensions: others } : rest;
    };
  }
  return server;
}

// The server's instructions, which an agent reads before any tool. Claude Code keeps 4,096 characters of them (2,048
// before v2.1.296), and with tool search they and the tools' names are all it loads upfront: so they say what
// Glitchless is, which tool starts each kind of task and when to reach for the tools, most important first, in under
// 2,048 characters for every connection (test/instructions.test.js). The rest is in each tool's own description and in
// the skills (served-skills.js). They name only tools the connection has: scopes as createServer's.
function instructions(remote, scopes = null) {
  const can = (scope) => !scopes || scopes.includes(scope);
  return [
    "Glitchless is observability for games made with Unity, Godot, Unreal, Three.js, GameMaker, Roblox, Phaser, Babylon.js or PlayCanvas: what players run into (stutters, crashes, errors, where they quit), the game's own metrics, multiplayer, store reviews and revenue. Use these tools when the person asks to set up Glitchless, analytics or telemetry in a game, or about its players, performance, crashes, metrics or dashboard.",
    can('manage')
      ? "To add Glitchless to a game, call glitchless_create_game first, before changing the game's code, with the game's name and its engine, or files: what you find in the game's folder. It returns that engine's steps."
      : `To add Glitchless to a game, follow the setup steps at ${SETUP_URL}: this connection may only read, so the person makes the game in Glitchless, and glitchless_list_games then has its client token.`,
    remote
      ? "You're connected to the person's workspace: glitchless_list_games lists its games, and every tool takes game (by name). If a game hasn't sent data yet, say so first and give the person its next_step before answering anything else."
      : "On Glitchless Cloud, glitchless_sign_in connects you to the person's whole workspace.",
    "To read a game, start with glitchless_triage (headline numbers and ranked findings), then drill in: glitchless_performance, glitchless_get_error, glitchless_player_funnel (levels), glitchless_session, glitchless_bug_reports (players' own reports) and glitchless_events (the game's own metrics).",
    `Multiplayer: glitchless_network, glitchless_match and glitchless_servers. Store reviews, vitals and sales: glitchless_store. Revenue: glitchless_revenue. The game's dashboard: glitchless_dashboard${can('dashboard') ? ', and after instrumenting a game, design one that fits it with glitchless_set_dashboard' : ''}.${can('manage') ? ' A read-only link to a board: glitchless_share_links.' : ''}`,
    remote ? '' : 'Before changing game code, run glitchless_playtest with save_as "baseline"; after the change, run it again and treat a FAIL as unfinished work.',
    'After shipping a fix, glitchless_compare_versions confirms it with real players.',
    // Last, as the one thing an agent does for the Glitchless team rather than the person: the tool's own description
    // says it all again.
    `When a Glitchless tool fails in a way you can't get around, a setup step doesn't work, or the person asks for something Glitchless can't do, tell the Glitchless team with glitchless_feedback. ${feedbackConsent()} At the end of your turn, tell the person what you sent and the ID it gave.`,
  ]
    .filter(Boolean)
    .join(' ');
}

// An issue in a list: with `resolved` or `came_back` when the game's owner resolved it (glitchless_resolve_error).
export function slimIssue(i) {
  return { fingerprint: i.fingerprint, kind: i.kind, message: i.message, location: i.location, count: i.count, sessions: i.sessions, sessions_pct: i.sessions_pct, levels: i.levels, versions: i.versions, first_version: i.first_version, last_seen: new Date(i.last_seen).toISOString(), ...(i.no_players ? { no_players: i.no_players } : {}), ...(i.resolved ? { resolved: i.resolved } : {}), ...(i.came_back ? { came_back: i.came_back } : {}) };
}

// An issue no player hit (the errors query's no_players: its sessions by kind), in a line, or ''.
const TEST_KINDS = { synthetic: 'synthetic (bots, playtests, store test phones)', tester: 'tester', simulated: 'simulated', dev_builds: 'on dev builds' };
export function noPlayersLine(i) {
  if (!i.no_players) return '';
  const kinds = Object.entries(i.no_players).map(([k, n]) => `${n} ${TEST_KINDS[k] ?? k}`);
  return `No player hit it${kinds.length ? `: its sessions were ${kinds.join(', ')}` : ', only test sessions'}. Check that it can happen on players' devices before changing code for it.`;
}

export function slimGroup(g) {
  return { key: g.key, sessions: g.sessions, p50: g.p50, p95: g.p95, p99: g.p99, pct_over_budget: g.pct_over_budget, hitches_per_min: g.hitches_per_min, draw_calls: g.draw_calls };
}
