---
name: instrument
description: Add Glitchless observability to a game: Three.js or React Three Fiber, Phaser 3 or 4, Babylon.js, PlayCanvas, Unity 2022.3+, Godot 4.5+, Unreal Engine 5.8 or GameMaker 2024.2+. Frame-time percentiles, hitch attribution, errors, gameplay events, level heatmaps, and tools that let coding agents measure the running game. Use when the user wants telemetry, analytics, performance monitoring or "observability" in a game, or asks to add Glitchless.
---

# Instrument a game with Glitchless

Goal: after this skill, every play session reports how the game *felt* (frame times, hitches and their causes),
what broke (errors, crashes) and what the player did (levels, deaths, pickups, positions), and you (the agent)
have a way to measure the running game before and after a change.

## 0. Find the engine, and the settings

| You find | Engine | Follow |
| --- | --- | --- |
| `three` or `@react-three/fiber` in package.json | Three.js | [Three.js](#threejs) |
| `phaser` in package.json, or a `<script>` that loads Phaser | Phaser 3.60+ or 4 | [Phaser](#phaser) |
| `@babylonjs/core` or `babylonjs` in package.json, or a `<script>` that loads Babylon.js | Babylon.js 5+ | [Babylon.js](#babylonjs) |
| `playcanvas` in package.json, a PlayCanvas Editor project (scripts using `pc.createScript` or `pc.Script`), or a `<script>` that loads PlayCanvas | PlayCanvas 2.x | [PlayCanvas](#playcanvas) |
| `ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json` | Unity 2022.3+ | [Unity](#unity) |
| `project.godot` | Godot 4.5+ | the Godot addon's README: `godot/addons/glitchless/README.md` in the Glitchless repo (`~/.glitchless/godot/addons/glitchless/README.md` if it's cloned there), then [Godot](#godot) here for bug reports |
| a `*.uproject` file | Unreal Engine 5.8 (5.7 untested) | [Unreal](#unreal) |
| a `*.yyp` file | GameMaker 2024.2+ | [GameMaker](#gamemaker) |

Settings, for every engine:

- **Intake URL and client token.** If the user gave you them (a hosted Glitchless server prints both, for example
  `Send telemetry to https://api.example.com with client token gl_pub_…`), use those. Otherwise use
  `http://localhost:7777` and `gl_pub_dev`, a local server. The client token is public and write-only, so it may
  live in the game's source. A secret key (`gl_sk_…`) never goes in the game.
- **Privacy.** Keep the default anonymous mode: no player ID, coarse device facts, no positions. Ask the user
  before choosing another mode, since the game's privacy policy and store answers must then say so (each SDK's
  PRIVACY.md lists every field and has the wording). If they want to know whether players come back (retention:
  D1, D7, D30), offer install mode: it adds only a random player ID kept on the device (`privacy: 'install'`;
  Godot `"privacy": "install"`; Unity `Privacy = Privacy.Install`; Unreal `Privacy=Install`). Anonymous mode
  can't count returning players. Full mode adds a stored player ID, device detail and positions.
- **Bots.** Sessions from autoplay bots and tests must be marked synthetic, so they stay out of player numbers.
- **Version.** Find where the game's version lives and pass it; bump it on every release so Glitchless can compare versions.

## Three.js

### 1. Read the game first

Find, and note file:line for each:
- where the `THREE.WebGLRenderer` (or `WebGPURenderer`), `scene` and main `camera` are created
- the game loop (`renderer.setAnimationLoop` / `requestAnimationFrame`)
- level/stage load and unload, player death/respawn, level complete/win, pickups/power-ups, game over
- anything spawned in bulk at runtime (particles, projectiles, enemies, debris): these become context gauges
- where the version lives (`package.json` version or a constant); if none, create `src/version.js`

### 2. Install and initialize (right after the renderer exists)

```bash
npm install glitchless
```

```js
import * as THREE from 'three';
import { Glitchless, instrumentThree } from 'glitchless';

const glitchless = Glitchless.init({
  service: '<game-id>',               // kebab-case, stable
  version: GAME_VERSION,
  env: import.meta.env?.MODE ?? 'dev',
  intake: import.meta.env?.VITE_GLITCHLESS_INTAKE ?? 'http://localhost:7777',
  clientToken: 'gl_pub_dev',
  sessionType: isBot ? 'synthetic' : 'user',
});
instrumentThree(glitchless, { renderer, scene, camera, THREE });
```

No bundler? Use `<script src="{GLITCHLESS_URL}/sdk/glitchless.js"></script>` and `Glitchless.init(...)` / `Glitchless.instrumentThree(...)`.

**Telemetry must never break the game.** Load the SDK through a small facade with try/catch and a no-op fallback
(see `apps/zoomies/src/telemetry.js` in the Glitchless repo for the pattern) and support a `?nogd=1` kill switch.

### 3. Wire game semantics

| Game moment | Call |
| --- | --- |
| level/stage starts (incl. restarts) | `glitchless.levelStart('level-2')` |
| level beaten | `glitchless.levelComplete('level-2', { durationS, score })` |
| player gives up / game over | `glitchless.levelFail('level-2', { cause })` |
| player dies | `glitchless.death({ x, y, z, cause: 'fell' })`: short, low-cardinality causes |
| pickups, power-ups, checkpoints | `glitchless.track('powerup', { kind: 'speed' })` |
| a purchase the store confirmed | `glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })` |
| every frame | `glitchless.setPosition(player.position)` |
| every frame | `glitchless.setContext({ particles, enemies, projectiles })`: counts of anything that scales |
| after a level is built | `glitchless.captureMap(levelId, { axis: 'xy' /* side-scroller */ \| 'xz' /* top-down */, bounds: { min: [a, b], max: [a, b] } })` |
| handled errors worth knowing about | `glitchless.error(err, { where: 'save-game' })` |

### 4. Give agents hands: register game tools (WebMCP)

Register 3–5 tools that let an agent reproduce problems. Handlers return a plain object or string and never throw.

```js
glitchless.registerTool('mygame_get_state', 'Current level, player position, score, enemy/particle counts', { type: 'object', properties: {} }, () => ({ ... }));
glitchless.registerTool('mygame_load_level', 'Jump to a level', { type: 'object', properties: { level: { type: 'string' } }, required: ['level'] }, ({ level }) => { loadLevel(level); return `loaded ${level}`; });
```

Good candidates: load level, teleport player, trigger the expensive effect (explosion, power-up), toggle pause.

### 4b. Bug reports from players (ask first)

For playtests, jams and early access, players can flag a problem where it happens: a key (F8) or a button in the
overlay opens a small form, and the note, a screenshot of the canvas, the level, the position (when positions are
on) and the last events go to Glitchless. They show under Bug Reports, in findings once a level has three, and in
`glitchless_bug_reports`. The note is free text the player types, so ask the user before turning it on and tell
them to mention it in the game's privacy page (`packages/sdk/PRIVACY.md` in the Glitchless repo has the wording).

```js
const glitchless = Glitchless.init({
  // …
  bugReports: { hotkey: 'F8', onOpen: () => pauseGame(), onClose: () => resumeGame() },
});
```

While the form is open the SDK holds keys, clicks and mouse movement back from the game; `onOpen`/`onClose` pause
it (a game that reads a gamepad needs the pause). A game with its own pause menu can add "Report a bug" there with
`glitchless.openBugReport()`, or send one from its own UI with `glitchless.reportBug({ note })`.

### 4c. Readable errors from the production build (source maps)

A minified build reports its errors as `e (index-3f2a.js:1:48213)`. With the build's source maps uploaded,
Glitchless shows them as `fireShotgun (weapons.js:141)`, with the original stack and the failing line, in the
dashboard and in `glitchless_get_error`, and an error keeps one fingerprint across builds. Most web games build
with Vite; add the plugin there:

```bash
npm install -D glitchless-sourcemaps
```

```js
// vite.config.js
import glitchlessSourcemaps from 'glitchless-sourcemaps/vite';
import { GAME_VERSION } from './src/version.js'; // wherever the version passed to Glitchless.init lives

export default defineConfig({
  plugins: [glitchlessSourcemaps({ version: GAME_VERSION, service: '<game-id>', deleteMaps: true })],
});
```

`version` and `service` must match what the game passes to `Glitchless.init` (the defaults are package.json's
`version` and `name`). The plugin builds with `build.sourcemap: 'hidden'`; leave `build.sourcemap` unset or set it to
`'hidden'`, because `true` points players' browsers at the maps. It uploads only when `GLITCHLESS_API_KEY` holds a
secret key that can upload source maps (tick "Can upload source maps" when creating it); put the key in CI secrets
or the user's environment, never in the game or a committed file. `deleteMaps: true` keeps the maps out of `dist`.
Without a key the build works as before and uploads nothing.

Other bundlers, or a CI step after the build (upload before deploying):

```bash
GLITCHLESS_API_KEY=… npx glitchless-sourcemaps upload dist --version 1.2.0 --service <game-id> --delete
```

`--url` (or `GLITCHLESS_URL`) is the Glitchless server, as for the MCP server.

### 5. Verify

1. Run the game, press `` ` ``: the Glitchless overlay shows fps, p95 frame time, draw calls, context gauges.
2. Play a level and die once. Then confirm data arrived: call `glitchless_list_games`, or open the dashboard.
3. If WebMCP is connected, call `glitchless_live_performance` and `glitchless_inspect_scene`.

## Phaser

The same `glitchless` package, with a Phaser adapter (Phaser 3.60+ and 4). It times frames from Phaser's own loop,
counts draw calls, reports scenes as levels, and catches failed loads and a game loop that stopped.

### 1. Read the game

Note file:line for: `new Phaser.Game(config)` and the scene list; which scene keys are levels and which are
boot/preload/menu/UI/game-over scenes; player death and respawn, level complete, game over, pickups; anything
spawned in bulk (Groups, particle emitters, bullets); where the version lives.

### 2. Install and initialize

```bash
npm install glitchless
```

Init before the game is created, so the session starts with the page, and hand the game over right after:

```js
import * as Phaser from 'phaser';
import { Glitchless } from 'glitchless';
import { instrumentPhaser } from 'glitchless/phaser';

const glitchless = Glitchless.init({
  service: '<game-id>',
  version: GAME_VERSION,
  intake: 'http://localhost:7777',
  clientToken: 'gl_pub_dev',
  sessionType: isBot ? 'synthetic' : 'user',
});
const game = new Phaser.Game(config);
instrumentPhaser(glitchless, { game, Phaser });
```

Script-tag games: load `{GLITCHLESS_URL}/sdk/glitchless.js`, then `Glitchless.instrumentPhaser(glitchless, { game })`.

### 3. Levels

A scene that starts is a level, named by its key, unless the key reads as a loader, menu, overlay or end screen
(`Boot`, `Preloader`, `MainMenu`, `UIScene`, `HUD`, `GameOver`, `Pause`, `Settings`, `Credits`…). Check the
game's keys against that:

- Levels are scenes (`Level1`, `Level2`): nothing to do.
- One `Game` scene plays every level: call `glitchless.levelStart('world-1-2')` in its `create()` with the real
  level name. Any manual call turns scene levels off.
- Odd keys: `instrumentPhaser(glitchless, { game, Phaser, levels: ['Forest', 'Cave'] })` or `levels: (scene) => name or null`.

### 4. Wire game semantics

The same calls as for Three.js: `levelComplete`, `levelFail`, `death({ x, y, cause })`, `track`, `setPosition`,
`setContext`, `error`. The adapter already sends `game_objects`, `physics_bodies`, `particles`, `tweens`,
`listeners` and `sounds` as gauges; add the game's own counts (enemies, bullets) with `setContext`.
Phaser's y axis points down, so heatmaps show a Phaser level upside down for now; leave the coordinates as they are.

Register WebMCP tools as for Three.js (`glitchless.registerTool`). Bug reports work as for Three.js too
(`bugReports` in init, [step 4b](#4b-bug-reports-from-players-ask-first)): the form's screenshot is the Phaser canvas.
So do source maps for the production build ([step 4c](#4c-readable-errors-from-the-production-build-source-maps)).

### 5. Bots and playtests

If the game has (or can get) an autoplay bot, make it read `?autoplay=1&seed=N&skill=0..1&level=N`, mark its
sessions synthetic, and set `window.__GLITCHLESS_PLAYTEST_DONE__ = true` when a run is over. Then
`glitchless-playtest` can compare builds. `apps/phaser-demo` in the Glitchless repo is a working example,
including `glitchless.playtest.json`.

### 6. Verify

Run the game, press `` ` `` for the overlay (draw calls, the gauges, the current level), play a level and die once,
then call `glitchless_list_games`. With WebMCP connected, `glitchless_inspect_scene` lists each running scene's
display list, physics bodies and busiest event listeners.

## Babylon.js

The same `glitchless` package, with a Babylon.js adapter (Babylon.js 5+, WebGL or WebGPU). It times frames from the
engine's own loop, reads Babylon's draw-call, triangle and shader-compile counters, reports scenes as levels, and
catches shader errors, failed textures, context loss and a render loop that stopped.

### 1. Read the game

Note file:line for: `new Engine(...)` (or `WebGPUEngine`), each `new Scene(engine)` and whether each level is its own
scene or one scene rebuilt; the render loop (`engine.runRenderLoop`) and the game update (`scene.onBeforeRenderObservable`
or `registerBeforeRender`); player death and respawn, level complete, game over, pickups; anything created in bulk at
runtime (meshes, `ShaderMaterial`s, particle systems, `DynamicTexture`s); where the version lives.

### 2. Install and initialize

```bash
npm install glitchless
```

Init before the engine starts, and hand over the engine and the first scene right after creating them:

```js
import * as BABYLON from '@babylonjs/core';
import { Glitchless } from 'glitchless';
import { instrumentBabylon } from 'glitchless/babylon';

const glitchless = Glitchless.init({
  service: '<game-id>',
  version: GAME_VERSION,
  intake: 'http://localhost:7777',
  clientToken: 'gl_pub_dev',
  sessionType: isBot ? 'synthetic' : 'user',
});
const engine = new BABYLON.Engine(canvas, true);
const scene = new BABYLON.Scene(engine);
instrumentBabylon(glitchless, { engine, scene, BABYLON }); // BABYLON (the namespace) lets captureMap draw levels
```

A game that imports single modules (`import { Engine } from '@babylonjs/core/Engines/engine'`) can leave `BABYLON`
out; then `captureMap` is off. Script-tag games: `Glitchless.instrumentBabylon(glitchless, { engine, scene })` (the
`BABYLON` global is found on its own).

### 3. Levels

- Each level is its own scene: set `scene.metadata = { level: 'forest' }` when you create it. The level starts when the
  scene first renders and ends when it is disposed; scenes created later are picked up on their own.
- One scene rebuilt for each level: set `scene.metadata.level` to the next name, or call `glitchless.levelStart('forest-2')`
  (any manual call turns scene levels off).
- Odd cases: `instrumentBabylon(glitchless, { engine, scene, levels: (scene) => name or null })`.

### 4. Wire game semantics

The same calls as for Three.js: `levelComplete`, `levelFail`, `death({ x, y, z, cause })`, `track`, `setPosition`
(every frame, from the player's mesh position), `setContext`, `error`. The adapter already sends `meshes`,
`active_meshes`, `materials`, `textures`, `particles` and `render_observers` as gauges; add the game's own counts with
`setContext`. After a level is built, `glitchless.captureMap(level, { axis: 'xz', bounds: { min: [x0, z0], max: [x1, z1] }, exclude: [player] })`
draws its picture for the heatmaps (pass `BABYLON` for it). Register WebMCP tools, bug reports and source maps as for
Three.js ([4](#4-give-agents-hands-register-game-tools-webmcp), [4b](#4b-bug-reports-from-players-ask-first),
[4c](#4c-readable-errors-from-the-production-build-source-maps)).

### 5. Bots and playtests

As for Phaser ([5](#5-bots-and-playtests)): `?autoplay=1&seed=N&skill=0..1&level=N`, synthetic sessions and
`window.__GLITCHLESS_PLAYTEST_DONE__`. `apps/babylon-demo` in the Glitchless repo is a working example.

### 6. Verify

Run the game, press `` ` `` for the overlay (draw calls, triangles, the gauges, the level), play a level and die
once, then call `glitchless_list_games`. With WebMCP connected, `glitchless_inspect_scene` lists each scene's mesh
groups and flags copies that should be instances or thin instances.

## PlayCanvas

The same `glitchless` package, with a PlayCanvas adapter (the PlayCanvas engine 2.x, WebGL2 or WebGPU; editor
projects and engine-only games). It times frames from the app's loop, reads the device's draw calls and shaders,
counts triangles, reports editor scenes as levels, and catches failed assets, context loss and script errors.

### 1. Read the game

Note file:line for: where the `pc.Application` (or `AppBase`) is created, or for an editor project the scripts and
scenes; how levels load (`app.scenes.changeScene()`, `loadSceneHierarchy()`, or built in code); the scripts that handle
death, level complete, pickups; anything spawned in bulk (entities cloned or built per effect, meshes made at runtime);
where the version lives.

### 2. Install and initialize

Engine-only game (`npm install glitchless`):

```js
import * as pc from 'playcanvas';
import { Glitchless } from 'glitchless';
import { instrumentPlayCanvas } from 'glitchless/playcanvas';

const glitchless = Glitchless.init({
  service: '<game-id>',
  version: GAME_VERSION,
  intake: 'http://localhost:7777',
  clientToken: 'gl_pub_dev',
  sessionType: isBot ? 'synthetic' : 'user',
});
const app = new pc.Application(canvas);
instrumentPlayCanvas(glitchless, { app, pc }); // pc (the namespace) lets captureMap draw levels
app.start();
```

PlayCanvas Editor project: add `{GLITCHLESS_URL}/sdk/glitchless.js` as an external script in the project settings,
then a script on the first entity that loads:

```js
const GlitchlessInit = pc.createScript('glitchlessInit');
GlitchlessInit.prototype.initialize = function () {
  const glitchless = Glitchless.init({ service: '<game-id>', version: '1.0.0', intake: 'http://localhost:7777', clientToken: 'gl_pub_dev' });
  Glitchless.instrumentPlayCanvas(glitchless, { app: this.app });
};
```

### 3. Levels

- Editor scenes: `app.scenes.changeScene('Level2')` and `loadSceneHierarchy()` start a level named after the scene,
  unless the name reads as a loader, menu, overlay or end screen. Odd names: `levels: ['Forest', 'Cave']` or
  `levels: (name) => name or null`.
- Levels built in code: call `glitchless.levelStart('track-2')` where the level is built (this turns scene levels off).

### 4. Wire game semantics

The same calls as for Three.js, from the scripts that handle them (`levelComplete`, `levelFail`, `death`, `track`,
`setPosition` every frame from the player entity's `getPosition()`, `setContext`, `error`). The adapter already sends
`entities`, `mesh_instances`, `materials`, `textures` and `lights` as gauges. After a level is built,
`glitchless.captureMap(level, { axis: 'xz', bounds, exclude: [player] })` draws its picture (pass `pc` for it). WebMCP
tools, bug reports and source maps work as for Three.js. Vite's dev server runs PlayCanvas's debug build, which turns
a script off after it throws; the adapter reports those errors too.

### 5. Bots and playtests

As for Phaser ([5](#5-bots-and-playtests)). `apps/playcanvas-demo` in the Glitchless repo is a working example.

### 6. Verify

Run the game, press `` ` `` for the overlay, play a level and fail once, then call `glitchless_list_games`. With
WebMCP connected, `glitchless_inspect_scene` lists entity groups and flags copies that should be instanced or batched.

## Unity

The `gg.glitchless.sdk` package, for Unity 2022.3 LTS and Unity 6.

### 1. Read the project

Note: the Unity version (`ProjectSettings/ProjectVersion.txt`; 2022.3 or later), the first scene
(`ProjectSettings/EditorBuildSettings.asset`), which scenes are levels, the scripts for player death and respawn,
level complete and fail, pickups, and anything spawned in bulk; where the version lives (`bundleVersion` in
`ProjectSettings/ProjectSettings.asset` is `Application.version`).

### 2. Install

Add one line to `dependencies` in `Packages/manifest.json`:

```json
"gg.glitchless.sdk": "https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk"
```

Unity resolves it the next time the Editor has focus. Pin a release by adding `#gg.glitchless.sdk/v0.3.0`.

### 3. Initialize, without touching a scene file

Create `Assets/Scripts/GlitchlessSetup.cs`:

```csharp
using GlitchlessSdk;
using UnityEngine;

static class GlitchlessSetup
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void Init() => Glitchless.Init(new GlitchlessOptions
    {
        Service = "<game-id>",
        Intake = "http://localhost:7777",
        ClientToken = "gl_pub_dev",
    });
}
```

It runs before the first scene loads, so no scene needs editing. (If the project has an assembly definition for
its scripts, add `GlitchlessSdk` to its references.) The Editor and development builds send with `Env` `dev`;
release builds with `prod`.

### 4. Levels and game semantics

Scenes are levels on their own: each scene that becomes active is a level unless its name reads as a menu, loader,
overlay or end screen (`Boot`, `Loading`, `MainMenu`, `UI`, `HUD`, `GameOver`…). If one scene plays many levels,
call `Glitchless.LevelStart("world-1-2")` where a level begins (that turns scene levels off), or set
`LevelForScene` in the options.

| Game moment | Call |
| --- | --- |
| level beaten | `Glitchless.LevelComplete("level-2", score: 1200)` |
| player gives up / game over | `Glitchless.LevelFail("level-2", "fell")` |
| player dies | `Glitchless.Death(player.position, "spikes")` |
| pickups, checkpoints | `Glitchless.Track("powerup", "magnet")` |
| a purchase the store confirmed | `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" })` |
| counts of anything that scales, each frame | `Glitchless.SetContext("enemies", enemies.Count)` |
| the player's place, each frame | `Glitchless.SetPosition(player.position)` |
| a caught exception | `Glitchless.Error(e)` |

Uncaught exceptions, `Debug.LogError` and engine errors are reported without any code.

### 4b. Bug reports from players (ask first)

As for [Three.js](#4b-bug-reports-from-players-ask-first): ask the user first, since the note is free text the
player types, and point them at the privacy wording in the package's `PRIVACY.md`. Then add one line to the options:

```csharp
BugReports = new BugReportOptions(), // F8 opens the form; OnOpen / OnClose to pause, Hotkey to change the key
```

The form is IMGUI, so the game needs no Canvas or EventSystem, and it works with the Input Manager and the Input
System. While it's open, `Time.timeScale` is 0 and the Input System's actions are off (`PauseGame`). Input the game
reads straight from `UnityEngine.Input` or a device isn't held back: guard it with `if (Glitchless.IsBugReportOpen)
return;`. A pause menu can call `Glitchless.OpenBugReport()`, and the game's own form `Glitchless.ReportBug(note)`.

### 5. Bots and measuring

If the game has an autoplay or test mode, start it from the command line (`--autoplay --seed=N`): the SDK marks
those sessions synthetic. To measure a build before and after a change, run the player with
`--glitchless-measure=10 --glitchless-out=measure.json` (add `-batchmode -nographics` on a machine without a
screen); it writes frame stats as JSON and quits. In a live Editor you can drive, `Glitchless.Measure(5, r => Debug.Log(Json.Serialize(r)))`
does the same.

### 6. Verify

Press Play in the Editor, play a level and die once, then call `glitchless_list_games` or open the dashboard.
The **Glitchless** GameObject under DontDestroyOnLoad shows the SDK is running.

## Godot

Follow the addon's README (`godot/addons/glitchless/README.md`): install, `Glitchless.init`, levels, deaths,
`track`, and `--glitchless-measure` for bots.

### Bug reports from players (ask first)

As for [Three.js](#4b-bug-reports-from-players-ask-first), and the same question to the user first. In Godot,
`"bug_reports": true` in the options of `Glitchless.init` adds the F8 form; it pauses the tree while it's open, so
a game with its own pause logic passes `"bug_reports": {"pause": false}` and connects `Glitchless.bug_report_opened` and
`bug_report_closed`. A pause menu can call `Glitchless.open_bug_report()`, and the game's own form
`await Glitchless.report_bug(note)`. The screenshot is the root viewport; headless runs have none. Privacy wording:
`godot/addons/glitchless/PRIVACY.md`.

## Unreal

The Glitchless plugin (`unreal/Plugins/Glitchless` in the Glitchless repo), for Unreal Engine 5.8. It is C++
source: it times every frame on the game, render and RHI threads and the GPU, names each hitch's likely causes
(pipeline states created on the spot, garbage collection, map loads, streamed levels, asset loads), and reports
`UE_LOG` errors, ensures, Blueprint runtime errors and crashes. Maps are levels on their own.

### 1. Read the project

Note: `EngineAssociation` in the `.uproject` (5.8), whether there is a `Source/` folder (a C++ project) or not
(Blueprint only), `GameDefaultMap` in `Config/DefaultEngine.ini` and which maps are levels, the classes for player
death and respawn, level complete and fail, pickups, and anything spawned in bulk (projectiles, enemies, effects);
where the version lives (`ProjectVersion` under `[/Script/EngineSettings.GeneralProjectSettings]` in
`Config/DefaultGame.ini`). Blueprints are binary `.uasset` files: you can't read them as text. If Unreal MCP is
connected (below), use it to look inside them; otherwise ask the user where those moments live.

### 2. Install

Copy the plugin into the project, so it builds with the game (from the agent kit, or the GitHub release zip):

```bash
cp -R ~/.glitchless/unreal/Plugins/Glitchless "<Project>/Plugins/Glitchless"
```

Add it to the `.uproject`'s `Plugins` list: `{ "Name": "Glitchless", "Enabled": true }`. The plugin is source, so a
Blueprint-only project needs a C++ module once: ask the user to add one in the editor (**Tools → New C++ Class**,
any class) or add a minimal `Source/` folder yourself (a module, `<Game>.Target.cs` and `<Game>Editor.Target.cs`).
Then build the editor target: on a Mac `"/Users/Shared/Epic Games/UE_5.8/Engine/Build/BatchFiles/Mac/Build.sh"
<Game>Editor Mac Development -project="<path>/<Game>.uproject"`, on Windows `Engine\Build\BatchFiles\Build.bat
<Game>Editor Win64 Development -project=...`. Add `-NoHotReload` if an editor has the project open. C++ code that
calls Glitchless adds `"Glitchless"` to `PublicDependencyModuleNames` in its `.Build.cs`. If the user installed it
from Fab instead, it is an engine plugin that comes built: enabling it is all, and a Blueprint-only project needs no
C++ module. `unreal/demo` in the Glitchless repo is a working example, with three planted problems and a script
that checks Glitchless finds them.

### 3. Settings, without code

Add this to `Config/DefaultGame.ini` (or set it in **Project Settings → Plugins → Glitchless**); the game instance
starts Glitchless with it, so nothing calls Init:

```ini
[/Script/Glitchless.GlitchlessSettings]
Service=<game-id>
Intake=http://localhost:7777
ClientToken=gl_pub_dev
Privacy=Anonymous
bSendInDevelopmentBuilds=True
```

Play In Editor and Development builds send as env `dev`, Shipping builds as `prod`. The version is the project's
`ProjectVersion` unless `Version=` is set here: bump it on every release. For a game jam, keep
`bSendInDevelopmentBuilds=True`: jam submissions are Development builds.

### 4. Levels and game semantics

Maps are levels, except those that read as a menu, lobby, loader or end screen (`Entry`, `MainMenu`, `L_Frontend`,
`Lobby`, `Loading`, `GameOver`…). If one map plays many levels, call `LevelStart` where each begins; the first call
turns map levels off.

| Game moment | C++ (`#include "Glitchless.h"`) | Blueprint node |
| --- | --- | --- |
| level starts | `FGlitchless::LevelStart(TEXT("forest-2"))` | Level Start |
| level beaten | `FGlitchless::LevelComplete(TEXT(""), Score)` (empty: the current level) | Level Complete |
| player gives up, game over | `FGlitchless::LevelFail(TEXT(""), TEXT("timeout"))` | Level Fail |
| player dies | `FGlitchless::Death(GetActorLocation(), TEXT("fell"))` | Death |
| pickups, checkpoints | `FGlitchless::Track(TEXT("powerup"), TEXT("magnet"))` | Track Event (What), Track Event |
| a purchase the store confirmed | `FGlitchless::Track(TEXT("purchase"), {{TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}}, {{TEXT("amount"), 4.99}})` | Track Event, `amount` in Numbers |
| counts of anything that scales, each frame | `FGlitchless::SetContext(TEXT("enemies"), Enemies.Num())` | Set Context |
| the player's place, each frame | `FGlitchless::SetPosition(GetActorLocation())` | Set Position |
| a problem the game noticed | `FGlitchless::Error(TEXT("save failed"))` | Report Error |

Pass Unreal units: the plugin sends positions in metres with y up, like the other SDKs. Every call is safe before
Init and from any thread. `UE_LOG` errors, ensures, Blueprint runtime errors (Accessed None…) and crashes are
reported without code; a crash is sent the next time the game starts. UObject and actor counts are sent as gauges
already; add the game's own counts with `SetContext`. To find a Blueprint-only game's moments, add the nodes in the
Blueprints that handle them (with Unreal MCP, or by asking the user to).

### 4b. Bug reports from players (ask first)

As for [Three.js](#4b-bug-reports-from-players-ask-first): ask the user first, since the note is free text the
player types, and point them at the privacy wording in the plugin's `PRIVACY.md`. Then add `BugReportKey=F8` to the
settings above: F8 opens a small Slate box over the game with a screenshot and a note. It takes the game's input
and pauses the game while open (`bPauseForBugReport`, on by default; a game paused already stays paused). A pause
menu can call **Show Bug Report Dialog** (`FGlitchless::ShowBugReportDialog()`), the game's own form **Report Bug**
(`FGlitchless::ReportBug(Note)`), and `FGlitchless::OnBugReportDialog()` (or the Glitchless subsystem's On Bug
Report Dialog) says when the box opens and closes.

### 5. Bots and measuring

Package a Development build, then run it with flags:

```bash
"/Users/Shared/Epic Games/UE_5.8/Engine/Build/BatchFiles/RunUAT.sh" BuildCookRun -project="<path>/<Game>.uproject" -platform=Mac -clientconfig=Development -build -cook -stage -pak -unattended
<Game> -glitchless-warmup=2 -glitchless-measure=10 -glitchless-out=measure.json
```

`-glitchless-measure=S` waits for the first map plus the warmup, measures S seconds, prints
`{"glitchless_measure": {...}}` as one line on stdout and quits; the numbers are `glitchless_measure`'s (frame_ms
percentiles, fps, game/render/RHI/GPU ms, hitches with causes, memory, new errors) plus `session_id`. If the game has
an autoplay or test mode, start it with `-autoplay`; that and `-glitchless-synthetic` mark the session synthetic.
`-glitchless-intake=URL` sends to another server for one run. A Windows build has no console: read the
`-glitchless-out` file. A UE 5.8 Mac build is sandboxed: it can write `-glitchless-out` only inside
`~/Library/Containers/<bundle id>/Data` (its `tmp` is a good place), and stdout works anywhere. Don't start a build
or cook while another Unreal build, cook or shader compile is running on the machine.

### 6. Agents in the editor: Unreal MCP

UE 5.8 ships Unreal MCP (Experimental), Epic's MCP server inside the editor: with it you can open maps, look inside
Blueprints and actors, edit them and run Play In Editor. Glitchless doesn't replace it; the two split the work:

- **Unreal MCP** is your hands in the editor: find where deaths and level ends happen in Blueprints, add the
  Glitchless nodes there, change the scene or material a finding points at, and start Play In Editor.
- **Glitchless** says what is wrong and whether a change fixed it: the `glitchless` MCP server reads what players and
  bots sent (findings, hitches with causes, errors, sessions), and the optional **Glitchless Toolset** plugin
  (`unreal/Plugins/GlitchlessToolset`) adds `Status` and `Measure` tools to Unreal MCP, so you can measure the game
  while it plays in the editor, as `glitchless_measure` does for a web game.

To set it up, copy `GlitchlessToolset` next to `Glitchless` in `Plugins/`, enable **Unreal MCP**, **All Toolsets** (or
**Toolset Registry**) and **Glitchless Toolset** in **Edit → Plugins** (or the `.uproject`), start the server
(`ModelContextProtocol.StartServer` in the editor console, or Editor Preferences → Model Context Protocol → Auto
Start Server), and run `ModelContextProtocol.GenerateClientConfig ClaudeCode` (or Cursor, Codex…) for the client
config. Start Play In Editor before calling `Measure`. Numbers from the editor run slower than a packaged build
(shaders compile on first use there): confirm a fix with a packaged Development build and `-glitchless-measure`.

### 7. Verify

Press Play in the editor (or run a Development build), play a level and die once, then call `glitchless_list_games`
or open the dashboard. The log shows `LogGlitchless` lines; `-glitchless-debug` logs each batch as it is sent.

## GameMaker

The Glitchless SDK for GameMaker (`gamemaker/` in the Glitchless repo; `~/.glitchless/gamemaker` if it's cloned
there) is GML: eight scripts and two objects. Its README (`gamemaker/README.md`) has the whole API; this is the
order to wire it in.

### 1. Read the project

Note: the `.yyp` (it must be GameMaker 2024.2 or later: `"$GMProject"` at its top; an older project needs opening
once in a newer GameMaker), the first room in `RoomOrderNodes` and its creation code, the controller objects that
live through the game (`persistent`), which rooms are levels and which are menus, the objects for the player, its
death and respawn, level complete and fail, pickups, and anything created in bulk (bullets, enemies, particles,
sparks). Check for an existing `exception_unhandled_handler` call and any analytics the game already sends.

### 2. Install

Without the IDE (an agent), from the Glitchless repo:

```bash
node ~/.glitchless/gamemaker/tools/install.mjs path/to/Game.yyp
```

It copies the scripts and objects into the project and lists them in the `.yyp` under a *Glitchless* folder; run it
again to update. In the IDE, **Tools → Import Local Package** with `Glitchless-<version>.yymps` does the same. Never
place `obj_glitchless` in a room: `glitchless_init` makes it.

### 3. Initialize

Once, as early as possible: the first room's creation code, or the Create event of the game's first persistent
controller.

```gml
glitchless_init("my-game", "", "prod", "<intake URL>", { client_token: "<client token>" }); // "" = GM_version
```

A build run from the IDE sends nothing without `-glitchless`; executables send. If the game sets its own
`exception_unhandled_handler`, move it into the `exception_handler` option, or call `glitchless_crash(ex)` first
thing in it, or crashes go unreported.

### 4. Levels and game semantics

- **Levels:** a room that reads as a level (`rm_cave_2`, not `rm_main_menu` or `rm_title`) starts that level on its
  own. A game whose levels aren't rooms calls `glitchless_level_start(id)` (the first call turns the rooms off), and
  every game calls `glitchless_level_complete(undefined, score)` and `glitchless_level_fail(undefined, cause)` where
  a level ends.
- **Deaths:** `glitchless_death(x, y, cause)` where the player dies.
- **Gauges:** `glitchless_set_context({ enemies: instance_number(obj_enemy), bullets: instance_number(obj_bullet) })`
  in a controller's End Step: whatever is created in bulk. The SDK already sends `instances`, `surfaces`, `ds_maps`,
  `ds_lists` and `buffers`.
- **Errors the game catches:** `glitchless_error(_e)` in its `catch` blocks.
- **Quit button:** `glitchless_quit()` in place of `game_end()`, so the last batch goes now, not next launch.

### 4b. Bug reports from players (ask first)

As for [Three.js](#4b-bug-reports-from-players-ask-first), and the same question to the user first. In GameMaker,
`bug_reports: true` in the options of `glitchless_init` adds the F8 form; it deactivates the game's instances while
it's open, so a game with its own pause passes `bug_reports: { pause: false, on_open: f, on_close: g }`. A pause menu
calls `glitchless_open_bug_report()`, and the game's own form `glitchless_report_bug(note, true, callback)`. The
screenshot is a PNG of the application surface. Privacy wording: `gamemaker/PRIVACY.md`.

### 5. Bots and measuring

Give the game an `-autoplay` flag (read it with `glitchless_has_flag("autoplay")`) that plays a few levels and
calls `glitchless_quit()`. Sessions run with `-autoplay` are synthetic. GameMaker must be set up once by a person
(`gamemaker/README.md`, "Setting up GameMaker for the end-to-end test"). Igor's `Run` (the IDE's, and `gm-cli run`)
starts the game with macOS's `open`, which passes no command line or environment on, so for a run from the IDE or
Igor put the flags in `glitchless/args.txt` in the runner's save area:

```bash
mkdir -p ~/Library/Application\ Support/com.yoyogames.macyoyorunner/glitchless
echo "-autoplay -glitchless-measure=10" > ~/Library/Application\ Support/com.yoyogames.macyoyorunner/glitchless/args.txt
npx @gamemaker/gm-cli@2.4.1 run Game.yyp --target=mac --runtime=vm   # or Run in the IDE
```

Or compile once and start the runner with the flags on its command line, as `gamemaker/test/e2e.mjs` does. The run
prints the stats as one line of JSON and where it saved them (`glitchless/measure.json` in the save area). Delete
`args.txt` afterwards. Measure before and after a change.

### 6. Verify

Run the game with `-glitchless` (from the IDE or gm-cli, in `args.txt` as above), play a level and die once, then
call `glitchless_list_games` or open the dashboard. `-glitchless-debug` logs each batch as it is sent.

## Every engine: the game's own metrics, and its board

Games differ: a puzzle game cares about solve time and hints, a mobile game about opens, modes, the paywall and
purchases, a platformer about where players die. Glitchless doesn't assume a genre, so this part is yours.

1. Find the moments this game's designer would want counted, and send each with `track`: one event name per
   moment, plus one word or a few attributes about it. Never anything about the player.
   - Three.js or Phaser: `glitchless.track('play', { mode: 'endless' })`
   - Godot: `Glitchless.track("play", "endless")` (one word becomes the attribute `what`) or a dictionary
   - Unity: `Glitchless.Track("play", "endless");` or a `Dictionary<string, object>`
   - Unreal: `FGlitchless::Track(TEXT("play"), TEXT("endless"));` (the attribute `what`) or a `TMap` of attributes
     and one of numbers; in Blueprint, Track Event (What) or Track Event
   - GameMaker: `glitchless_track("play", "endless");` (the attribute `what`) or a struct

   Good candidates: the game opening (with the edition, free or full), a mode or run starting, a run ending and
   how, shop and paywall views and where they were opened, purchases started and finished, hints, choices that
   matter (difficulty), shares and rating prompts. Levels, stages and puzzles go through levelStart,
   levelComplete and levelFail, not `track`. Attributes are strings, numbers or booleans, at most 12 per event.

   Purchases have one convention in every engine, so boards can add them up into revenue: a `purchase` event
   when the store confirms it, with `amount` (a number in the currency's units: 4.99, not 499), `currency` (the
   ISO code the store charged in) and `item`. A game has one currency on its boards; purchases in another are
   listed as left out, not added in. Never send receipts, order ids or payment details.
   - Web games (Three.js, Phaser, Babylon.js, PlayCanvas): `glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })`
   - Godot: `Glitchless.track("purchase", {"amount": 4.99, "currency": "USD", "item": "gems_500"})`
   - Unity: `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" });`
   - Unreal: `FGlitchless::Track(TEXT("purchase"), {{TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}}, {{TEXT("amount"), 4.99}});`
     (in Blueprint, Track Event with `amount` in Numbers)
2. Once events arrive, design the game's own dashboard: follow the `dashboard` skill (next to this one), which
   turns the developer's questions into collectors, panels and pages and saves them with the
   `glitchless_set_dashboard` MCP tool.

## Report

Tell the user what you wired (with file:line), the gauges you chose and why, the events you track and the board
you designed, the agent tools or measure commands you set up, and anything you weren't sure about.
