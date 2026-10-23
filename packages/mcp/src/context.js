// What every Glitchless MCP tool shares: the server, the Glitchless API it reads and writes, and the
// helpers that shape a tool's reply. Each area's tools live in tools/<area>.js and register on import.

import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const BASE = (process.env.GLITCHLESS_URL || 'http://localhost:7777').replace(/\/$/, '');
export const API_KEY = process.env.GLITCHLESS_API_KEY || '';
export const DEFAULT_SERVICE = process.env.GLITCHLESS_SERVICE || '';

export const server = new McpServer(
  { name: 'glitchless', version: '0.3.0' },
  {
    instructions:
      'Glitchless is observability for games made with Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot, Unreal or GameMaker. Start with glitchless_triage to get ranked, evidence-backed findings for a game, then drill in with glitchless_performance, glitchless_get_error, glitchless_death_hotspots or glitchless_session. When players or playtesters send bug reports from inside the game (an F8 form or a button), glitchless_bug_reports lists them with what they wrote, the level and where they stood, and opens one with its screenshot. For metrics the game defines itself (what it sends with track(): plays, purchases, paywall views and so on) and funnels between them, use glitchless_events. Each game has its own dashboard, a list of pages (boards of panels, and built-in views such as Errors, Sessions and Live Tail): read it with glitchless_dashboard, and after instrumenting a game, design one that fits it with glitchless_set_dashboard. Before changing game code, run glitchless_playtest with save_as "baseline"; after the change, run glitchless_playtest again to compare, and treat a FAIL as unfinished work. After shipping a fix (bump the version passed to Glitchless.init), use glitchless_compare_versions to confirm it with real players. If the game is running in a browser with WebMCP connected, its live tools (glitchless_live_performance, glitchless_measure, glitchless_inspect_scene, and game tools such as zoomies_load_level) let you reproduce and measure issues directly. Unity, Godot, Unreal and GameMaker builds measure themselves when run with --glitchless-measure=SECONDS (-glitchless-measure in Unreal and GameMaker); in the Unreal editor, Unreal MCP with the Glitchless Toolset has a Measure tool.',
  },
);

export async function query(name, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  const client = server.server.getClientVersion?.()?.name || 'mcp';
  const res = await fetch(`${BASE}/v1/query/${name}?${qs}`, {
    headers: { 'x-glitchless-client': client, ...(API_KEY ? { 'x-glitchless-api-key': API_KEY } : {}) },
  });
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

export async function write(method, path, body) {
  const client = server.server.getClientVersion?.()?.name || 'mcp';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-glitchless-client': client, ...(API_KEY ? { 'x-glitchless-api-key': API_KEY } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error(`${data.error || 'forbidden'}. Saving a dashboard needs a secret key with the dashboard scope (create one in the dashboard's settings).`);
  if (!res.ok) throw new Error(`Glitchless API ${method} ${path} → HTTP ${res.status}: ${data.error || ''}`);
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
};

// A read-only tool: errors come back as a tool error, not a thrown exception.
export function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: true } }, async (args) =>
    calls.run({}, async () => {
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
