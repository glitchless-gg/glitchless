// Unlike the read tools, this one acts: it launches browsers or the game's own build, or plays in Roblox Studio, and writes
// .glitchless/playtest/<name>.json in the project, so it is registered without the read-only hint. With check_url it runs
// a game check instead (glitchless-playtest's check.js): any web game, nothing installed in it, a report and a dashboard.
// It takes minutes, so a client that takes MCP tasks gets one (tasks.js), and cancelling the task stops the run: the
// browser closes, the build is killed or Studio's play test stops. A call that isn't a task runs to the end, as before.
import path from 'node:path';
import { z } from 'zod';
import * as playtestLib from 'glitchless-playtest';
import { define, base, apiKey, defaultService, fail, callProgress } from '../context.js';

const { playtest, gameCheck } = playtestLib;
// The project folders with a run going (a playtest or a game check): one at a time, since two at once fight over the
// GPU, skew each other's frame times and both write latest.json. A cancelled run that can't stop holds it to its end.
const running = new Map();
// Whether the glitchless-playtest installed beside this server stops a run part-way (0.5.0 on). An older one ignores
// the signal: a cancelled task then says it asked the run to stop, and the run goes on to the end and saves.
export const CAN_STOP = typeof playtestLib.checkStop === 'function';

define(
  'glitchless_playtest',
  {
    description:
      "Playtest the game with its autoplay bot and compare against a saved baseline: call with save_as \"baseline\" BEFORE changing code, wait for its result, then without arguments AFTER the change. A FAIL lists the regressions; warnings and improvements are listed too. One run at a time in a project: a second call while one runs is refused. It compares slow frames, frame time p95 and p99, render and update CPU, draw calls, hitches, errors and crashes, overall and per level (an engine build also GPU time and what grew over a run, run by run); a headless build, or runs on different frame budgets, only warn on frame times. Runs are saved in .glitchless/playtest/ in the project. Web games (Three.js, Phaser, Babylon.js, PlayCanvas): bots play fixed-seed scenarios in real Chrome, one at a time, against the running game (game_url); this needs the Glitchless server running and Playwright installed in the project, and takes 1–5 minutes (quick: about 1). Unity, Godot, Unreal and GameMaker: command starts the build; each scenario runs it with the game's own autoplay flags (by default two runs: --autoplay --seed=7, then --seed=21) plus --glitchless-measure, and the Glitchless SDK in the build measures 10 seconds a run (a scenario's \"seconds\") and quits; no server or browser is needed. The game needs an autoplay mode that reads those flags and keeps playing for the whole measure: if it quits sooner, or never starts a level, the error says how to fix it. Roblox (engine \"roblox\"): it plays the place open in Roblox Studio, which needs Studio's MCP server and Allow HTTP Requests on; each scenario sets Workspace attributes for the game's bot to read (by default autoplay = true, seed = 7, then seed = 21), plays until workspace:GetAttribute(\"GlitchlessPlaytestDone\") is true or 90 seconds pass, and puts them back. Its sessions are read back from the Glitchless server this tool reads, so the game's Glitchless.init has to send there. A game check (check_url): Glitchless's bots play any web game someone posted, with nothing installed in it (an itch.io page, a github.io, Vercel or Netlify page, any address), on a desktop and then a throttled phone in Chrome on this computer, about 3 to 6 minutes in all, and make a report, a dashboard for the game and, on Glitchless Cloud, an unlisted 30-day share link, with three sentences to send its maker. It reads the site's robots.txt first and stops where bots are asked to stay out, on 401, 403 or 429, or on a page that checks for a human. The numbers come from this computer, not the game's players, and the report says so: keep a check private and never rank games with it. check_url's description has the rest. A client that takes MCP tasks gets a task at once and reads the result from it; cancelling the task stops the run.",
    inputSchema: {
      save_as: z.string().optional().describe('Save this run under a name, e.g. "baseline" before a change'),
      compare_to: z.string().optional().describe('Saved run to compare with (default "baseline" when saved)'),
      quick: z.boolean().optional().describe('Play only the first scenario (about a minute)'),
      game_url: z.string().optional().describe('Web games: the URL to play (default http://localhost:5173/ or glitchless.playtest.json)'),
      engine: z.enum(['roblox', 'unity', 'godot', 'unreal', 'gamemaker']).optional().describe("\"roblox\" plays the place open in Roblox Studio, which needs Studio open with its MCP server on (Assistant → … → Manage MCP Servers → Enable Studio as MCP server) and Allow HTTP Requests on; the others are told from command, so only needed when its name doesn't say (default: \"engine\" in glitchless.playtest.json)"),
      studio: z.string().optional().describe('Roblox: which open Studio to play in, part of its place\'s name (needed when several are open)'),
      command: z.array(z.string()).optional().describe('Unity, Godot, Unreal or GameMaker: the command that starts the build, e.g. ["godot", "--path", "."], ["./build/MyGame.x86_64"] or ["builds/MyGame.app"]; paths are from the project folder (default: "command" in glitchless.playtest.json)'),
      max_seconds: z.number().min(10).max(600).optional().describe('Cap each run at this many seconds (an engine build: the seconds it measures; a game check: seconds of desktop play, default 90, at most 240)'),
      check_url: z.string().optional().describe("A game check: the address of any web game to play with nothing installed in it: an itch.io page (its game frame is found and played at the page's size), a github.io, Vercel or Netlify page, or any address. The browser SDK is added to the page before it runs (bot sessions are synthetic, never players), and the engine is told where it can be (Three.js, Phaser, Babylon.js and PlayCanvas get their adapters; Unity, Godot, GameMaker, Construct, GDevelop, Defold, PixiJS or plain canvas and WebGL are named). It plays twice in real Chrome on this computer: desktop on its GPU (max_seconds of play, default 90, at most 240), then a throttled phone (CPU slowed 4×, a phone's touch screen and a 4G-like connection, two thirds as long). A heuristic explorer clicks to start and tries the common controls (with ai, a Claude model instead). It makes a game named after the page (check_name), designs its dashboard (a Game check page first, then pages that fill in with Glitchless installed), puts a screenshot of the game on it as its banner, and on Glitchless Cloud (a workspace key) makes an unlisted share link to the check page for 30 days, which shows the check's bot runs only; an open-source server gets the dashboard and no link. It returns the report, three sentences to send the game's maker with the link, and where the report and screenshots are saved (.glitchless/checks/ in the project)"),
      check_name: z.string().optional().describe("A game check: the game's name in Glitchless (default: its page's title). A game an earlier check made is reused, and a real game by that name is left alone: the check goes to \"<name> (game check)\""),
      ai: z.boolean().optional().describe("A game check: a Claude model (Haiku) picks the inputs from screenshots instead of the explorer (needs ANTHROPIC_API_KEY and @anthropic-ai/sdk where the MCP server runs; at most 40 screenshots a profile)"),
    },
    // A game check (check_url) plays a game on the open web.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ save_as, compare_to, quick, game_url, engine, studio, command, max_seconds, check_url, check_name, ai } = {}, ctx) => {
    const { log, signal, cantStop } = callProgress(ctx);
    if (!CAN_STOP) cantStop();
    const project = path.resolve(process.cwd());
    const busy = running.get(project);
    if (busy) return fail(new Error(`A ${busy.what} is already running in this project (started ${Math.round((Date.now() - busy.started) / 1000)} s ago). Wait for its result before starting another: two at once fight over the GPU, skew each other's frame times, and both write .glitchless/playtest/latest.json.`));
    running.set(project, { what: check_url ? 'game check' : 'playtest', started: Date.now() });
    try {
      if (check_url) {
        const r = await gameCheck({ url: check_url, name: check_name, server: base(), apiKey: apiKey() || '', seconds: max_seconds, ai: ai === true, log, signal });
        const where = [r.share?.url && `Share link (unlisted, 30 days, shows this check only): ${r.share.url}`, r.dashboard_url && `Dashboard: ${r.dashboard_url}`, `Saved: ${r.files.report} (report), ${r.files.dm} (the message), ${r.files.shots.length} screenshots in ${r.dir}`].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: `${r.report}\n\n---\nTo send the game's maker (the link and three sentences):\n\n${r.dm}\n\n${where}` }] };
      }
      const r = await playtest({
        saveAs: save_as,
        compareTo: compare_to,
        quick,
        maxSeconds: max_seconds,
        config: { server: base(), api_key: apiKey() || undefined, service: defaultService() || undefined, game: game_url, command: command?.length ? command : undefined, engine, studio },
        log,
        signal,
      });
      const files = Object.entries(r.files || {}).map(([k, f]) => `${k}: ${f}`).join('\n');
      return { content: [{ type: 'text', text: `${r.report}\n\nVerdict: ${r.verdict.toUpperCase()}\nSaved runs:\n${files}` }] };
    } catch (err) {
      return fail(err);
    } finally {
      running.delete(project);
    }
  },
  // It plays the game in Chrome, runs its build or drives Roblox Studio on this computer, so it is not served over HTTP.
  { local: true, task: true },
);
