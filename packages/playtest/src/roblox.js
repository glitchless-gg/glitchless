// Roblox: a game has no command line, so its play tests run in the open Roblox Studio, driven over Studio's own MCP
// server (StudioMCP, the tools an agent uses there). Each scenario sets its params as attributes of Workspace, where
// the game's autoplay bot reads them, starts a play test, waits until done_when (Luau, on the server) is true or max_s
// passes, stops it and puts the attributes back. The SDK sends the play test's sessions to the game's intake as any
// Roblox server does, and the run is read back from that Glitchless server like a browser run: the players' sessions
// under the game's service, the server's own under <service>.server (its script errors are the game's too).
// Studio sessions are `tester` unless the game marks its bot's `synthetic`; the play test's window picks out its own.

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchSummary, gitInfo, machineInfo } from './run.js';

export const DEFAULT_ROBLOX_SCENARIOS = [
  { name: 'autoplay, seed 7', params: { autoplay: true, seed: 7 }, max_s: 90 },
  { name: 'autoplay, seed 21', params: { autoplay: true, seed: 21 }, max_s: 90 },
];

// Luau, on the play test's server: the run ends early once it is true.
export const ROBLOX_DONE_WHEN = 'workspace:GetAttribute("GlitchlessPlaytestDone") == true';

export const ROBLOX_AUTOPLAY =
  'On Roblox, read workspace:GetAttribute("autoplay") and workspace:GetAttribute("seed") in a server Script: when autoplay is set, let a bot play each player\'s character (Humanoid:MoveTo, the game\'s own actions, with Random.new(seed) so the same seed plays the same way), call Glitchless.levelStart(player, …) as it goes, set workspace:SetAttribute("GlitchlessPlaytestDone", true) when the run is over, and pass sessionType = if workspace:GetAttribute("autoplay") then "synthetic" else nil to Glitchless.init so its sessions stay out of player numbers.';

const NEEDS_STUDIO =
  'Roblox playtests run in Roblox Studio: open the game\'s place in Studio and turn on Assistant → … → Manage MCP Servers → Enable Studio as MCP server.';

/** The StudioMCP command: "studio_mcp" in glitchless.playtest.json, else where Studio installs it. */
export function studioMcpCommand(cfg) {
  if (cfg.studio_mcp) return [].concat(cfg.studio_mcp).map(String);
  if (process.platform === 'win32') return ['cmd.exe', '/c', path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'mcp.bat')];
  return ['/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP'];
}

// A small MCP client over stdio, for StudioMCP.
export function connectStudio(argv) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let buf = '';
  let seq = 0;
  let failed = null;
  const fail = (err) => {
    failed = err;
    for (const done of pending.values()) done({ error: { message: err.message } });
  };
  child.on('error', (err) => fail(err.code === 'ENOENT' ? new Error(`Roblox Studio's MCP server isn't at ${argv[0]}. ${NEEDS_STUDIO} Or set "studio_mcp" in glitchless.playtest.json to its command.`) : err));
  child.on('exit', () => fail(new Error(`Roblox Studio's MCP server (${argv.join(' ')}) stopped. ${NEEDS_STUDIO}`)));
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg);
      } catch {}
    }
  });
  child.stdin.on('error', () => {});
  const request = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      const id = ++seq;
      const timer = setTimeout(() => (pending.delete(id), reject(new Error(`Roblox Studio's MCP server didn't answer ${method} in ${timeoutMs / 1000} s`))), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        pending.delete(id);
        if (failed && !msg.result) reject(failed);
        else resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args = {}) => {
    const msg = await request('tools/call', { name, arguments: args });
    const text = (msg.result?.content || []).map((c) => c.text ?? '').join('\n');
    if (msg.error || msg.result?.isError) throw new Error(`Studio ${name}: ${msg.error?.message || text}`);
    return text;
  };
  return {
    tool,
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'glitchless-playtest', version: '0' } }, 30_000);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    close: () => child.kill(),
  };
}

// Luau answers come back as text; a marker around JSON survives however the tool prints a returned string.
const MARK = (expr) => `"GLP<" .. game:GetService("HttpService"):JSONEncode(${expr}) .. ">GLP"`;
export function unmark(text) {
  const m = String(text).match(/GLP<([\s\S]*?)>GLP/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return JSON.parse(JSON.parse(`"${m[1]}"`)); // printed inside a quoted string
  }
}
// A Luau long string that holds `text` as it is.
export function longString(text) {
  let eq = '=';
  while (text.includes(`]${eq}]`)) eq += '=';
  return `[${eq}[${text}]${eq}]`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const luau = (mcp, id, code, type = 'Edit') => mcp.tool('execute_luau', { studio_id: id, datamodel_type: type, code });
const mode = async (mcp, id) => (await mcp.tool('get_studio_state', { studio_id: id })).match(/Mode:\s*(\w+)/i)?.[1] || null;

// The Studio to play in: "studio" (part of its name, or its ID), else the only one open.
async function pickStudio(mcp, want, waitS = 10) {
  let studios = [];
  for (let i = 0; i < waitS && !studios.length; i++) {
    studios = JSON.parse((await mcp.tool('list_roblox_studios')) || '{}').studios || [];
    if (!studios.length) await sleep(1000); // the server finds open Studios a moment after it starts
  }
  if (!studios.length) throw new Error(`No Roblox Studio answered. ${NEEDS_STUDIO}`);
  const names = studios.map((s) => `"${s.name}"`).join(', ');
  const match = want ? studios.filter((s) => s.id === want || String(s.name).toLowerCase().includes(String(want).toLowerCase())) : studios;
  if (!match.length) throw new Error(`No open Roblox Studio is "${want}". Open: ${names}.`);
  if (match.length > 1) throw new Error(`${match.length} Roblox Studios are open (${names}): set "studio" in glitchless.playtest.json to part of the game's place name, so the playtest never plays another place.`);
  return match[0];
}

// What the place has: the Glitchless module, Allow HTTP Requests, and the service its Glitchless.init names.
const PROBE = `-- glitchless-playtest: probe
local HttpService = game:GetService("HttpService")
local module = game:GetService("ReplicatedStorage"):FindFirstChild("Glitchless", true)
local service
for _, root in { game:GetService("ServerScriptService"), game:GetService("ServerStorage"), game:GetService("ReplicatedStorage"), game:GetService("ReplicatedFirst") } do
	for _, d in root:GetDescendants() do
		if not service and d:IsA("LuaSourceContainer") and not (module and (d == module or d:IsDescendantOf(module))) then
			local ok, src = pcall(function() return d.Source end)
			if ok and type(src) == "string" and string.find(src, "Glitchless.init", 1, true) then
				service = string.match(src, "Glitchless%.init%s*%(%s*{.-service%s*=%s*[\\"']([^\\"']+)[\\"']")
			end
		end
	end
end
return ${MARK('{ module = module ~= nil, http = HttpService.HttpEnabled, service = service }')}`;

// Sets Workspace attributes and clears others, answering what they were before.
const attributes = (set, clear) => `-- glitchless-playtest: attributes
local HttpService = game:GetService("HttpService")
local set = HttpService:JSONDecode(${longString(JSON.stringify(set))})
local clear = HttpService:JSONDecode(${longString(JSON.stringify(clear))})
local before = {}
for k, v in set do
	before[k] = workspace:GetAttribute(k)
	workspace:SetAttribute(k, v)
end
for _, k in clear do
	before[k] = workspace:GetAttribute(k)
	workspace:SetAttribute(k, nil)
end
return ${MARK('before')}`;

const ATTRIBUTE = /^[A-Za-z0-9_]{1,100}$/;
function checkParams(sc) {
  for (const [k, v] of Object.entries(sc.params || {})) {
    if (!ATTRIBUTE.test(k) || k.startsWith('RBX')) throw new Error(`Scenario "${sc.name || k}": "${k}" can't be a Roblox attribute name (letters, digits and _, at most 100).`);
    if (!['boolean', 'number', 'string'].includes(typeof v)) throw new Error(`Scenario "${sc.name || k}": "${k}" must be true or false, a number or a string to be a Workspace attribute.`);
  }
}

const label = (sc) => sc.name || JSON.stringify(sc.params || {});

// One play test: attributes on, play until done or the cap, stop, attributes back as they were.
async function playOnce(mcp, studio, sc, cfg, log) {
  const params = sc.params || {};
  const before = unmark(await luau(mcp, studio.id, attributes(params, ['GlitchlessPlaytestDone']))) || {};
  const restore = () => luau(mcp, studio.id, attributes(before, [...Object.keys(params), 'GlitchlessPlaytestDone'].filter((k) => !(k in before)))).catch(() => {});
  const started = Date.now();
  let finished = false;
  try {
    if (sc.luau || cfg.luau) await luau(mcp, studio.id, sc.luau || cfg.luau);
    await mcp.tool('start_stop_play', { studio_id: studio.id, is_start: true });
    const maxMs = (sc.max_s || 90) * 1000;
    const done = `-- glitchless-playtest: done_when\nreturn if (${sc.done_when || cfg.done_when || ROBLOX_DONE_WHEN}) then ${MARK('true')} else ${MARK('false')}`;
    while (Date.now() - started < maxMs) {
      await sleep(1000);
      finished = (await luau(mcp, studio.id, done, 'Server').then(unmark).catch(() => false)) === true;
      if (finished) break;
    }
  } finally {
    await mcp.tool('start_stop_play', { studio_id: studio.id, is_start: false }).catch(() => {});
    for (let i = 0; i < 30 && (await mode(mcp, studio.id).catch(() => 'Edit')) !== 'Edit'; i++) await sleep(1000);
    await restore();
  }
  // From the start of a play test, the Output holds that test's lines only: Glitchless's warnings are the clues.
  const output = await mcp.tool('get_console_output', { studio_id: studio.id }).catch(() => '');
  const glitchless = output.split('\n').filter((l) => l.includes('[glitchless]')).slice(0, 12);
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`  → ${seconds}s${finished ? '' : ' (hit the time cap)'}`);
  return { scenario: sc.name || null, params, started, ended: Date.now(), seconds, finished, glitchless };
}

// The Studio sessions of a service (synthetic, or tester as Studio marks them) that started between two times.
async function sessionsOf(cfg, service, from, to) {
  const base = cfg.server.replace(/\/$/, '');
  const qs = new URLSearchParams({ service, from: String(from - 60_000), to: String(to + 60_000) });
  const headers = { 'x-glitchless-client': 'playtest', ...(cfg.api_key ? { 'x-glitchless-api-key': cfg.api_key } : {}) };
  const res = await fetch(`${base}/v1/query/sessions?${qs}`, { headers });
  if (!res.ok) throw new Error(`Glitchless server ${base} answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.sessions || []).filter((s) => (s.session_type === 'synthetic' || s.session_type === 'tester') && s.start >= from && s.start <= to);
}

// Each session belongs to the play test it started in: the play tests run one after another, and the SDK's clock is
// this machine's. A session that starts up to a second and a half early still counts, if it lasted into the test (one
// that ended before it began is the previous test's).
const SLACK_MS = 1500;
function assign(results, sessions, key) {
  for (const r of results) r[key] = [];
  for (const s of sessions) {
    const lasted = (x) => s.start + (s.duration_s ?? 0) * 1000 >= x.started;
    const within = (slack) => results.filter((x) => x.started - slack <= s.start && s.start <= x.ended && (!slack || lasted(x))).at(-1);
    within(0)?.[key].push(s.session_id) ?? within(SLACK_MS)?.[key].push(s.session_id);
  }
}

// One summary for the players' sessions, with the server's errors and crashes added: a script error on the server is
// the game's error too.
async function robloxSummary(cfg, service, players, servers, since, log) {
  const summary = await fetchSummary(cfg, service, players, since, { log });
  if (!servers.length || !summary) return summary;
  const server = await fetchSummary(cfg, `${service}.server`, servers, since, { log, timeoutMs: 10_000 }).catch(() => null);
  if (!server) return summary;
  const errors = [...(summary.errors || [])];
  for (const e of server.errors || []) if (!errors.some((x) => x.fingerprint === e.fingerprint)) errors.push({ ...e, server: true });
  return { ...summary, errors, crashes: (summary.crashes || 0) + (server.crashes || 0), server_errors_per_session: server.errors_per_session ?? null };
}

/** Plays every scenario in Roblox Studio and returns a run record ready to save or compare. */
export async function robloxRun(cfg, { scenarios = cfg.scenarios, log = () => {} } = {}) {
  for (const sc of scenarios) checkParams(sc);
  const mcp = connectStudio(studioMcpCommand(cfg));
  let studio;
  let service = cfg.service;
  const results = [];
  try {
    await mcp.init();
    studio = await pickStudio(mcp, cfg.studio, cfg.studio_wait_s);
    log(`Roblox Studio: ${studio.name}`);
    const state = await mode(mcp, studio.id);
    if (state && state !== 'Edit') throw new Error(`Roblox Studio ("${studio.name}") is in a play test (${state}): stop it, and run the playtest again.`);
    const place = unmark(await luau(mcp, studio.id, PROBE)) || {};
    if (!place.module) throw new Error(`"${studio.name}" has no Glitchless module in ReplicatedStorage: add Glitchless to the game first (the instrument skill's Roblox steps).`);
    if (!place.http) throw new Error(`"${studio.name}" has Allow HTTP Requests off, so Glitchless can't send anything: turn it on in Game Settings → Security.`);
    service ||= place.service;
    if (!service) throw new Error('Could not tell which game this is from its Glitchless.init: set "service" in glitchless.playtest.json (or pass --service) to the service name it sends as.');
    for (const [i, sc] of scenarios.entries()) {
      log(`run ${i + 1}/${scenarios.length}: ${label(sc)} …`);
      results.push(await playOnce(mcp, studio, sc, cfg, log));
    }
  } finally {
    mcp.close();
  }

  // BindToClose sends the last batches as the play test's server closes: give them a moment to land.
  log(`collecting the play tests' sessions from ${cfg.server} …`);
  const from = results[0].started - SLACK_MS;
  const to = results.at(-1).ended;
  for (let i = 0; i < (cfg.sessions_wait_s ?? 30); i++) {
    assign(results, await sessionsOf(cfg, service, from, to), 'session_ids');
    if (results.every((r) => r.session_ids.length)) break;
    await sleep(1000);
  }
  assign(results, await sessionsOf(cfg, `${service}.server`, from, to), 'server_session_ids');
  for (const r of results) r.session_id = r.session_ids[0] || null;
  const players = results.flatMap((r) => r.session_ids);
  if (!players.length) {
    const said = [...new Set(results.flatMap((r) => r.glitchless))];
    throw new Error(`No session from "${service}" reached ${cfg.server} during the play tests. The game sends where its Glitchless.init intake says: read from that server (--server, or GLITCHLESS_URL), and check the service name.${said.length ? `\nStudio's Output said:\n${said.join('\n')}` : ''}`);
  }
  const servers = results.flatMap((r) => r.server_session_ids);
  const started = Math.min(...results.map((r) => r.started));
  const summary = await robloxSummary(cfg, service, players, servers, started, log);
  const notes = [];
  const noLevel = !Object.keys(summary?.levels || {}).length && !summary?.level_attempts;
  if (noLevel && cfg.default_scenarios) throw new Error(`The play tests ran with the default scenarios (Workspace attributes autoplay = true, seed = 7) but no player started a level, so the game probably has no autoplay mode. ${ROBLOX_AUTOPLAY} Then list the runs in glitchless.playtest.json under "scenarios".`);
  if (noLevel) notes.push(`No player started a level (Glitchless.levelStart), so the bot may not have played. If the game has no autoplay mode yet: ${ROBLOX_AUTOPLAY}`);
  // A Studio window that is hidden or minimized runs the play test's client without drawing: no frames come back.
  if (summary?.sessions && summary.frame_p95 == null) notes.push("No frames came from the players: Studio's window was probably hidden or minimized, so the play test's client drew nothing, and frame times can't be compared. Keep the place's Studio window in view while it plays.");
  const many = results.filter((r) => r.server_session_ids.length > 1).length;
  if (many) notes.push(`${many} play test window(s) held more than one Studio server session of "${service}": someone else's play test may be mixed in.`);
  return {
    created: new Date().toISOString(),
    kind: 'roblox',
    game: studio.name,
    server: cfg.server,
    service,
    git: gitInfo(cfg.root),
    machine: { ...machineInfo(summary, 'Roblox Studio'), browser: 'Roblox Studio', cpu: os.cpus()[0]?.model || null },
    scenarios: results,
    summary,
    notes,
  };
}

// A quick run plays fewer scenarios than a full baseline: ask the server for just the matching baseline sessions,
// the server's too, or keep the full baseline (compareRuns notes the mismatch).
export async function matchingRobloxBaseline(cfg, baseline, candidate, log) {
  if (baseline.kind !== 'roblox') return baseline;
  const key = (s) => JSON.stringify([s.scenario, s.params]);
  const wanted = new Set((candidate.scenarios || []).map(key));
  const have = baseline.scenarios || [];
  const subset = have.filter((s) => wanted.has(key(s)) && s.session_ids?.length);
  if (subset.length === have.length || subset.length !== wanted.size) return baseline;
  try {
    const since = Math.min(...subset.map((s) => s.started)) - 2 * 3600e3;
    const summary = await robloxSummary(cfg, baseline.service, subset.flatMap((s) => s.session_ids), subset.flatMap((s) => s.server_session_ids || []), since, log);
    return summary?.sessions ? { ...baseline, scenarios: subset, summary, name: `${baseline.name} (matching runs)` } : baseline;
  } catch {
    return baseline;
  }
}
