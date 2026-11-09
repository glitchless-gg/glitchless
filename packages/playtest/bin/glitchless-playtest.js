#!/usr/bin/env node
// glitchless-playtest: autoplay bots play your game, and Glitchless compares the result with a baseline.
//
//   glitchless-playtest --save baseline        # before changing the code
//   glitchless-playtest                        # after: compares with "baseline", exits 1 on a regression
//   glitchless-playtest --compare-only baseline latest
//   glitchless-playtest --baseline-url http://localhost:5174/   # CI: main build vs this branch's build
//   glitchless-playtest --command "godot --path ." --save baseline   # an engine build instead of a web game
//   glitchless-playtest --engine roblox --studio "My Obby" --save baseline   # a play test in Roblox Studio
//
// A web game needs the game and a Glitchless server running, and Playwright installed in the game project.
// An engine build (Unity, Godot, Unreal, GameMaker) needs only the build, with the Glitchless SDK in it.
// A Roblox game needs its place open in Roblox Studio with Studio's MCP server on, and the Glitchless server it sends to.

import { playtest, compareSaved } from '../src/index.js';

const HELP = `Usage: glitchless-playtest [options]

  --save NAME            save this run as NAME (e.g. baseline)
  --compare NAME         compare with the saved run NAME (default: baseline, if saved)
  --compare-only A B     compare two saved runs without playing
  --baseline-url URL     play another running build as the baseline first (for CI)
  --game URL             game to play (default http://localhost:5173/)
  --command CMD          run an engine build instead (Unity, Godot, Unreal, GameMaker): an exported
                         build, or the engine with the project path, e.g. "godot --path ."
  --baseline-command CMD run another engine build as the baseline first (for CI)
  --engine NAME          godot, unity, unreal or gamemaker, when the command's name doesn't say;
                         roblox plays the place open in Roblox Studio, over Studio's MCP server
  --studio NAME          Roblox: which open Studio (part of its place's name), when several are open
  --server URL           Glitchless server (default $GLITCHLESS_URL or http://localhost:7777)
  --service NAME         game service name (default: read from the page)
  --api-key KEY          Glitchless API key (default $GLITCHLESS_API_KEY)
  --quick                play only the first scenario
  --max SECONDS          cap each run (an engine build: the seconds it measures)
  --channel NAME         browser: chrome (default, uses your real GPU) or chromium
  --headed               show the browser windows
  --json                 print the full result as JSON instead of markdown

Scenarios, thresholds, URLs and the command can also be set in glitchless.playtest.json.
Exit code: 0 pass (or nothing to compare), 1 regression, 2 error.`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

if (has('help') || has('h')) {
  console.log(HELP);
  process.exit(0);
}

const log = (msg) => process.stderr.write(`${msg}\n`);
const config = { game: val('game'), command: val('command'), engine: val('engine'), studio: val('studio'), server: val('server'), service: val('service'), api_key: val('api-key'), channel: val('channel'), headed: has('headed') || undefined };

try {
  let result;
  const only = argv.indexOf('--compare-only');
  if (only >= 0) {
    const [a, b] = argv.slice(only + 1, only + 3);
    if (!a || !b) throw new Error('--compare-only needs two saved run names, e.g. --compare-only baseline latest');
    result = compareSaved(a, b, { config });
  } else {
    result = await playtest({ saveAs: val('save'), compareTo: val('compare'), baselineUrl: val('baseline-url'), baselineCommand: val('baseline-command'), quick: has('quick'), maxSeconds: val('max') ? Number(val('max')) : undefined, config, log });
  }
  if (has('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.report);
  process.exit(result.verdict === 'fail' ? 1 : 0);
} catch (err) {
  log(`glitchless-playtest: ${err.message}`);
  process.exit(2);
}
