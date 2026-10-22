---
name: instrument
description: Add Glitchless observability to a game: Three.js or React Three Fiber, Phaser 3 or 4, Unity 2022.3+ or Godot 4.5+. Frame-time percentiles, hitch attribution, errors, gameplay events, level heatmaps, and tools that let coding agents measure the running game. Use when the user wants telemetry, analytics, performance monitoring or "observability" in a game, or asks to add Glitchless.
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
| `ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json` | Unity 2022.3+ | [Unity](#unity) |
| `project.godot` | Godot 4.5+ | the Godot addon's README: `godot/addons/glitchless/README.md` in the Glitchless repo (`~/.glitchless/godot/addons/glitchless/README.md` if it's cloned there) |

Settings, for every engine:

- **Intake URL and client token.** If the user gave you them (a hosted Glitchless server prints both, for example
  `Send telemetry to https://api.example.com with client token gl_pub_…`), use those. Otherwise use
  `http://localhost:7777` and `gl_pub_dev`, a local server. The client token is public and write-only, so it may
  live in the game's source. A secret key (`gl_sk_…`) never goes in the game.
- **Privacy.** Keep the default anonymous mode: no player ID, coarse device facts, no positions. Ask the user
  before choosing full mode: it adds a stored player ID and positions, which the game's privacy policy and
  store answers must then disclose (each SDK's PRIVACY.md lists every field).
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
| pickups, power-ups, purchases, checkpoints | `glitchless.track('powerup', { kind: 'speed' })` |
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

Register WebMCP tools as for Three.js (`glitchless.registerTool`).

### 5. Bots and playtests

If the game has (or can get) an autoplay bot, make it read `?autoplay=1&seed=N&skill=0..1&level=N`, mark its
sessions synthetic, and set `window.__GLITCHLESS_PLAYTEST_DONE__ = true` when a run is over. Then
`glitchless-playtest` can compare builds. `apps/phaser-demo` in the Glitchless repo is a working example,
including `glitchless.playtest.json`.

### 6. Verify

Run the game, press `` ` `` for the overlay (draw calls, the gauges, the current level), play a level and die once,
then call `glitchless_list_games`. With WebMCP connected, `glitchless_inspect_scene` lists each running scene's
display list, physics bodies and busiest event listeners.

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

Unity resolves it the next time the Editor has focus. Pin a release by adding `#gg.glitchless.sdk/v0.1.0`.

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
| pickups, purchases, checkpoints | `Glitchless.Track("powerup", "magnet")` |
| counts of anything that scales, each frame | `Glitchless.SetContext("enemies", enemies.Count)` |
| the player's place, each frame | `Glitchless.SetPosition(player.position)` |
| a caught exception | `Glitchless.Error(e)` |

Uncaught exceptions, `Debug.LogError` and engine errors are reported without any code.

### 5. Bots and measuring

If the game has an autoplay or test mode, start it from the command line (`--autoplay --seed=N`): the SDK marks
those sessions synthetic. To measure a build before and after a change, run the player with
`--glitchless-measure=10 --glitchless-out=measure.json` (add `-batchmode -nographics` on a machine without a
screen); it writes frame stats as JSON and quits. In a live Editor you can drive, `Glitchless.Measure(5, r => Debug.Log(Json.Serialize(r)))`
does the same.

### 6. Verify

Press Play in the Editor, play a level and die once, then call `glitchless_list_games` or open the dashboard.
The **Glitchless** GameObject under DontDestroyOnLoad shows the SDK is running.

## Report

Tell the user what you wired (with file:line), the gauges you chose and why, the agent tools or measure commands
you set up, and anything you weren't sure about.
