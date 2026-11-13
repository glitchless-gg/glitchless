# glitchless-playtest

Playtest every change, and check any web game. Your game's autoplay bot plays it on a saved baseline and on the current code, and
[Glitchless](https://github.com/glitchless-gg/glitchless) compares the two: slow frames, frame time, render and
update time, draw calls, hitches, errors and crashes. A regression exits with code 1, so it can gate a pull request.
It plays Unity, Godot, Unreal and GameMaker builds from their command line ([engine builds](#engine-builds)), Roblox
games in Roblox Studio ([Roblox](#roblox)), and web games (Three.js, Phaser, Babylon.js, PlayCanvas or plain WebGL) in
Chrome.

```bash
npx glitchless-playtest --save baseline   # before changing the code
npx glitchless-playtest                   # after: compares with "baseline"
```

It also checks any web game someone posted, with nothing installed in it ([game checks](#game-checks)):

```bash
npx glitchless-playtest --check https://someone.itch.io/their-game
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

## Game checks

A game check shows a game's maker what Glitchless would do for their game, before they install anything. Glitchless's
bots play any web game, an itch.io page, a github.io, Vercel or Netlify page or any address, and make a report in
plain words, a dashboard made for that game and, on Glitchless Cloud, an unlisted link to it, with three sentences to
send its maker.

```bash
GLITCHLESS_URL=https://api.glitchless.gg GLITCHLESS_API_KEY=gl_ws_… npx glitchless-playtest --check https://someone.itch.io/their-game
```

- **Nothing in the game.** The browser SDK is added to the page before it runs, its sessions marked as bots
  (synthetic), so they never count as players. The engine is named where it can be (Three.js, Phaser, Babylon.js,
  PlayCanvas, Unity, Godot, GameMaker, Construct, GDevelop, Defold, PixiJS and others, or plain canvas and WebGL), and
  Three.js, Phaser, Babylon.js and PlayCanvas are handed to their Glitchless adapters, as installing it would.
- **Two ways of playing**, one after the other, in real Chrome: desktop on this computer's GPU (90 s by default,
  `--seconds`, at most 240), then a throttled phone: the same computer with its CPU slowed 4×, a phone's touch screen
  (sideways for a wide game) and a 4G-like connection, for two thirds as long. With loading, 3 to 6 minutes.
- **A player that needs no help.** It clicks Play, then tries the arrow keys, WASD, the mouse, click and drag and the
  usual action keys (taps, holds and swipes on the phone), and spends its time on what changes the screen. With
  `--ai` and an `ANTHROPIC_API_KEY`, a Claude model (Haiku) picks the inputs from screenshots instead
  (`npm install @anthropic-ai/sdk`; at most 40 screenshots a profile). Each step is kept with the frames, memory,
  errors and level of that moment, so the report can say when a freeze came.
- **Where it goes.** With a workspace key (`gl_ws_…`, from `npx glitchless-mcp login`) on Glitchless Cloud, it makes a
  game named after the page (`--name` to choose; an existing game by that name is reused), its dashboard and a share
  link that shows the check's bot runs, for 30 days. On the open-source server it saves the dashboard there, with no
  link. The report, `message.txt` (the link and three sentences), `check.json` and screenshots go in
  `.glitchless/checks/<game>-<time>/`. Check a game on a public site against a public server: Chrome keeps a public
  page from sending to a server on your own computer or network, and the report says so when that happens.
- **It asks first.** It reads the site's robots.txt (as `GlitchlessCheck`) and stops where bots are asked to stay out,
  stops on a 401, 403 or 429 or a page that checks for a human, never plays more than a few minutes from one computer,
  closes popups and comes back from links that leave the game. A game that already sends to Glitchless has its own
  sends held back during the check.
- **Private.** The check's game and board are in your workspace. Don't use it to rank games.

The numbers come from this computer, not from the game's players, and the report says so. Running checks for anyone
on the web would need a GPU machine in the cloud; this runs where you run it.

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

Game check (any web game, with nothing installed in it):
--check URL            play the game at URL on a desktop and a throttled phone, then make its
                       report, dashboard and (Glitchless Cloud) share link
--name NAME            the game's name in Glitchless (default: its page's title)
--seconds N            seconds of desktop play (default 90, at most 240; the phone plays 2/3 as long)
--profiles LIST        desktop, phone or desktop,phone (default)
--ai                   a Claude model picks the inputs (ANTHROPIC_API_KEY, @anthropic-ai/sdk)
--out DIR              where the report goes (default .glitchless/checks/<game>-<time>)
--no-share             no share link
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
import { playtest, gameCheck } from 'glitchless-playtest';
const result = await playtest({ saveAs: 'baseline' }); // later: playtest({ compareTo: 'baseline' })
const check = await gameCheck({ url: 'https://someone.itch.io/their-game', server, apiKey }); // → { report, dm, share, files }
```

The [glitchless-mcp](https://www.npmjs.com/package/glitchless-mcp) server exposes the same thing to
coding agents as the `glitchless_playtest` tool, and a game check as its `check_url`.

## License

MIT
