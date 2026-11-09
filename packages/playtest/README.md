# glitchless-playtest

Playtest every change. Your game's autoplay bot plays it on a saved baseline and on the current code, and
[Glitchless](https://github.com/glitchless-gg/glitchless) compares the two: slow frames, frame time, render and
update time, draw calls, hitches, errors and crashes. A regression exits with code 1, so it can gate a pull request.
It plays Unity, Godot, Unreal and GameMaker builds from their command line ([engine builds](#engine-builds)), Roblox
games in Roblox Studio ([Roblox](#roblox)), and web games (Three.js, Phaser, Babylon.js, PlayCanvas or plain WebGL) in
Chrome.

```bash
npx glitchless-playtest --save baseline   # before changing the code
npx glitchless-playtest                   # after: compares with "baseline"
```

## Engine builds

A Unity, Godot, Unreal or GameMaker build with the Glitchless SDK measures itself: started with
`--glitchless-measure=SECONDS`, it times every frame for that long, prints the numbers as one line of JSON and quits.
Give the playtest the command that starts the build, an exported build or the engine with the project path, in
`glitchless.playtest.json`:

```json
{
  "command": ["godot", "--path", "."],
  "scenarios": [
    { "name": "seed 7", "params": { "autoplay": true, "seed": 7 }, "seconds": 10 },
    { "name": "seed 21", "params": { "autoplay": true, "seed": 21, "level": 2 }, "seconds": 10 }
  ]
}
```

Each scenario starts the build once, one at a time, with its `params` as the game's own flags
(`--autoplay --seed=7`; `-autoplay -seed=7` in Unreal and GameMaker; after a `--` in Godot), its `args` as they are,
and the measure flags. No browser and no Glitchless server are needed. Without `scenarios`, it runs
`--autoplay --seed=7`, then `--autoplay --seed=21`.

- **The game needs an autoplay mode**: a bot that starts when the game is given `--autoplay`, plays the same way for
  the same `--seed`, starts levels as it goes, and keeps playing for the whole measure. A game that quits sooner
  prints no measurement, and the error says to lower `seconds` or let the bot keep playing. With the default
  scenarios, a game that starts no level is taken to have no autoplay mode, and the error says how to add one for
  its engine. The Godot demo in the Glitchless repo, `godot/demo/demo.gd`, is a working example with its
  `godot/glitchless.playtest.json`.
- **Run it with a window.** A headless run draws nothing and runs frames uncapped, so its frame times mean little.
  When the build says it ran headless (Godot's `--headless`, GameMaker), frame times only warn; update time, errors,
  crashes and growth still count.
- `command` is a list or one string (`"godot --path ."`). Paths are from the project folder; a macOS `.app` runs the
  executable inside it. The engine is told from the command and from what an export leaves beside it; set `engine`
  (`godot`, `unity`, `unreal`, `gamemaker`) when it can't be.
- `seconds` (default 10) and `warmup` (seconds before measuring: default 0, so errors and stutter while loading count;
  Unity 1, since its memory counters read nothing on the first frames) can be set per scenario or for all. `max_s`
  (default warmup + seconds + 120) kills a build that froze; that run counts as crashed.
- The build writes its measurement to a file the playtest passes (`--glitchless-out`) too, which is how a Unity player
  on macOS, whose output goes to its log, is read. If a build's file sandbox keeps it from writing there, set
  `measure_file` to where it saves it (GameMaker: `glitchless/measure.json` in its save area).

On top of the web checks, an engine build compares frame time p99, GPU time (Unity, Unreal, Godot off Metal), Unreal's
RHI thread, Unity's physics, garbage collection and what grew over a run (objects, nodes, instances, MB: a leak), and
with two or more scenarios, each run against the same run of the baseline, and the level each run ended on. Errors
match across builds even when their numbers or line numbers moved. A crashed run is listed with the last lines it
printed. For CI, `--baseline-command` runs the other build as the baseline first.

## Roblox

A Roblox game has no command line, so its runs are play tests in the open Roblox Studio, driven over Studio's own MCP
server (Assistant → … → Manage MCP Servers → **Enable Studio as MCP server**):

```json
{
  "engine": "roblox",
  "studio": "My Obby",
  "scenarios": [
    { "name": "seed 7", "params": { "autoplay": true, "seed": 7 }, "max_s": 90 },
    { "name": "seed 21", "params": { "autoplay": true, "seed": 21 }, "max_s": 90 }
  ]
}
```

Each scenario sets its `params` as attributes of Workspace, starts a play test, waits until `done_when` (Luau, run on
the play test's server; by default `workspace:GetAttribute("GlitchlessPlaytestDone") == true`) or `max_s`, stops it,
and puts the attributes back as they were. The SDK sends the play test's sessions where the game's `Glitchless.init`
says, and the playtest reads them back from that Glitchless server (`--server`): the players' sessions, and the
server's own for its script errors. So the game needs an autoplay mode that reads those attributes, marks its sessions
`sessionType = "synthetic"` and says when it's done; [the Roblox SDK's README](https://github.com/glitchless-gg/glitchless/tree/main/roblox#ask-your-agent)
has the code.

- `studio` is part of the open Studio's place name. With one Studio open it can be left out; with several, the
  playtest refuses to guess, so it never plays another place.
- `service` is read from the place's `Glitchless.init`; set it when that can't be read.
- `luau` runs in Edit before each play test, for anything an attribute can't do (pointing a test place at a server).
- `studio_mcp` is StudioMCP's command, when Studio isn't installed where it usually is.
- It stops with what to do when Studio isn't reachable, is already in a play test, the place has no Glitchless module
  or has Allow HTTP Requests off, or no session arrives.

## Web games

- **Your game running**, by default at `http://localhost:5173/`, with the Glitchless SDK
  ([`glitchless`](https://www.npmjs.com/package/glitchless)) reporting to a Glitchless server.
- **An autoplay mode in the game.** Each scenario opens the game with URL parameters such as
  `?autoplay=1&seed=7&skill=0.95&level=1`. A fixed seed makes the bot play the same way on both builds,
  so the only thing that changes is the code. The bot's sessions should use `sessionType: 'synthetic'`,
  so they stay out of player numbers.
- **A Glitchless server**, by default `$GLITCHLESS_URL` or `http://localhost:7777`.
- **Playwright** installed in the game project (`npm install -D playwright`). It uses your installed
  Chrome by default, so frame times come from your real GPU.

A run ends after `max_s` seconds, or as soon as the page sets `window.__GLITCHLESS_PLAYTEST_DONE__ = true`.

On a fast machine, vsync hides a slower build in frame time. Render CPU and update CPU per frame don't
hide it, so they fail a run on their own: update CPU is the game's update code, which the SDK times
where the engine lets it (Phaser's scene updates and physics). The Phaser demo in the Glitchless repo,
`apps/phaser-demo`, has a working `glitchless.playtest.json`.

## Options

```
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
--channel NAME         browser: chrome (default) or chromium
--headed               show the browser windows
--json                 print the full result as JSON instead of markdown
```

Saved runs go in `.glitchless/playtest/` (add it to `.gitignore`).

## Configuration

A `glitchless.playtest.json` in the project root can set any default: `game`, `server`, `scenarios`,
`thresholds`, `done_when` (a JavaScript expression that ends a run when it's true), `viewport` and
`runs_dir`; for an engine build, `command`, `engine`, `seconds`, `warmup` and `measure_file`; for Roblox, `engine`,
`studio`, `luau` and `studio_mcp`.

```json
{
  "game": "http://localhost:3000/",
  "scenarios": [
    { "name": "speedrun", "params": { "autoplay": 1, "seed": 3, "skill": 0.95 }, "max_s": 60 }
  ]
}
```

A metric only counts as worse when it's worse by both its relative and its absolute margin, so noise
on a fast machine doesn't fail a build.

## From code or an agent

```js
import { playtest } from 'glitchless-playtest';
const result = await playtest({ saveAs: 'baseline' }); // later: playtest({ compareTo: 'baseline' })
```

The [glitchless-mcp](https://www.npmjs.com/package/glitchless-mcp) server exposes the same thing to
coding agents as the `glitchless_playtest` tool.

## License

MIT
