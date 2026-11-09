// Unlike the read tools, this one acts: it launches browsers or the game's own build, or plays in Roblox Studio, and writes
// .glitchless/playtest/<name>.json in the project, so it is registered without the read-only hint.
import { z } from 'zod';
import { playtest } from 'glitchless-playtest';
import { define, base, apiKey, defaultService, fail } from '../context.js';

define(
  'glitchless_playtest',
  {
    description:
      'Playtest the game with its autoplay bot and compare against a saved baseline. Call with save_as "baseline" BEFORE changing code, then without arguments AFTER the change; a FAIL lists the regressions, warnings and improvements are listed too. Web games (Three.js, Phaser, Babylon.js, PlayCanvas): bots play fixed-seed scenarios in real Chrome, one at a time, against the running game (game_url); this needs the Glitchless server running and Playwright installed in the project, and takes 1–5 minutes (quick: about 1). Unity, Godot, Unreal and GameMaker: give command (or "command" in glitchless.playtest.json), what starts the build, such as ["godot", "--path", "."] or an exported build; each scenario starts it with the game\'s own autoplay flags (by default two runs: --autoplay --seed=7, then --seed=21) plus --glitchless-measure, and the Glitchless SDK in the build measures 10 seconds per run (a scenario\'s "seconds") and quits; no server or browser is needed. The game needs an autoplay mode that reads those flags and keeps playing for the whole measure: if it quits sooner, or never starts a level with the default scenarios, the error says how to fix it. Roblox: give engine "roblox" (or "engine": "roblox" in glitchless.playtest.json); it plays the place open in Roblox Studio, which needs Studio open with its MCP server on (Assistant → … → Manage MCP Servers → Enable Studio as MCP server) and Allow HTTP Requests on, and studio (part of the place\'s name) when several Studios are open. Each scenario sets its params as Workspace attributes (by default autoplay = true, seed = 7, then seed = 21) for the game\'s bot to read, plays until workspace:GetAttribute("GlitchlessPlaytestDone") is true or 90 seconds pass, stops, and puts the attributes back; the play test\'s sessions are read back from the Glitchless server this tool reads, so the game\'s Glitchless.init has to send there. All compare slow frames, frame time p95 and p99, render and update CPU, draw calls, hitches, errors and crashes, overall and per level (an engine build also GPU time and what grew over a run, run by run). A headless build, or runs on different frame budgets, only warn on frame times. Runs are saved in .glitchless/playtest/ in the project.',
    inputSchema: {
      save_as: z.string().optional().describe('Save this run under a name, e.g. "baseline" before a change'),
      compare_to: z.string().optional().describe('Saved run to compare with (default "baseline" when saved)'),
      quick: z.boolean().optional().describe('Play only the first scenario (about a minute)'),
      game_url: z.string().optional().describe('Web games: the URL to play (default http://localhost:5173/ or glitchless.playtest.json)'),
      engine: z.enum(['roblox', 'unity', 'godot', 'unreal', 'gamemaker']).optional().describe('"roblox" plays the place open in Roblox Studio; the others are told from command, so only needed when its name doesn\'t say (default: "engine" in glitchless.playtest.json)'),
      studio: z.string().optional().describe('Roblox: which open Studio to play in, part of its place\'s name (needed when several are open)'),
      command: z.array(z.string()).optional().describe('Unity, Godot, Unreal or GameMaker: the command that starts the build, e.g. ["godot", "--path", "."], ["./build/MyGame.x86_64"] or ["builds/MyGame.app"]; paths are from the project folder (default: "command" in glitchless.playtest.json)'),
      max_seconds: z.number().min(10).max(600).optional().describe('Cap each run at this many seconds (an engine build: the seconds it measures)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ save_as, compare_to, quick, game_url, engine, studio, command, max_seconds } = {}, ctx) => {
    const token = ctx?.mcpReq._meta?.progressToken;
    let step = 0;
    const log = (message) => {
      if (token != null) ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }).catch(() => {});
    };
    try {
      const r = await playtest({
        saveAs: save_as,
        compareTo: compare_to,
        quick,
        maxSeconds: max_seconds,
        config: { server: base(), api_key: apiKey() || undefined, service: defaultService() || undefined, game: game_url, command: command?.length ? command : undefined, engine, studio },
        log,
      });
      const files = Object.entries(r.files || {}).map(([k, f]) => `${k}: ${f}`).join('\n');
      return { content: [{ type: 'text', text: `${r.report}\n\nVerdict: ${r.verdict.toUpperCase()}\nSaved runs:\n${files}` }] };
    } catch (err) {
      return fail(err);
    }
  },
  // It plays the game in Chrome, runs its build or drives Roblox Studio on this computer, so it is not served over HTTP.
  { local: true },
);
