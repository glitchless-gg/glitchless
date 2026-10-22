# Fetch! (the Glitchless Phaser demo)

A small one-button runner in Phaser. A purple pup runs right on its own; you jump over pits, fire hydrants and squirrels to reach the flag at the end of three levels. It is here to show `glitchless/phaser` on a real Phaser game, and it runs on **Phaser 3.90 or Phaser 4.2** from the same code.

Like Zoomies, it has **planted bugs** for Glitchless to find (listed below). Don't fix them.

## Run it

From the repo root:

```bash
npm install
npm run server                              # Glitchless on http://localhost:7777
npm run dev -w glitchless-phaser-demo       # http://localhost:5175
```

`http://localhost:5175/?phaser=4` runs the same game on Phaser 4. Every picture is drawn in code at boot, so there are no asset files.

| Key | Action |
| --- | --- |
| `Space`, `↑`, `W`, or a tap | jump |
| `R` | give up the level (`levelFail`, cause `restart`) |
| `` ` `` | the Glitchless overlay |

Three lives per level. Losing all three restarts the level.

| Param | Default | Meaning |
| --- | --- | --- |
| `phaser=3\|4` | `3` | which Phaser runs the game |
| `level=1..3` | `1` | start on a level |
| `autoplay=1` | off | the bot plays (sessions are tagged `synthetic`) |
| `skill=0..1` | `0.7` | bot skill: how far it misses its takeoff points |
| `seed=N` | random | bot seed: the same seed plays the same run |
| `env=`, `intake=`, `dashboard=` | `dev`, `http://localhost:7777`, `http://localhost:7777` | Glitchless settings |
| `nogd=1` | off | no Glitchless |

## How it's wired

[`src/telemetry.js`](src/telemetry.js) calls `Glitchless.init()` before the game is created and hands the game to `instrumentPhaser()` right after `new Phaser.Game()`:

```js
import { Glitchless } from 'glitchless';
import { instrumentPhaser } from 'glitchless/phaser';

const glitchless = Glitchless.init({ service: 'fetch', version: GAME_VERSION, intake, clientToken: 'gl_pub_dev', positions: true });
const game = new Phaser.Game(config);
instrumentPhaser(glitchless, { game, Phaser });
```

The game itself only reports what Phaser can't know: `death({ x, y, cause })`, `levelComplete`, `levelFail`, `track('bone_collected')`, `track('powerup', { kind })`, and `setPosition` and `setContext({ confetti })` every frame. Levels come from the scene keys (`level-1`, `level-2`, `level-3`); `Boot`, `Menu`, `HUD` and `GameOver` are left out because they read as a loader, a menu, an overlay and an end screen.

It runs in anonymous mode with `positions: true`, so deaths have places for the heatmap but there is no player ID.

## Agent tools (WebMCP)

[`src/agent-tools.js`](src/agent-tools.js) registers these next to the SDK's own `glitchless_*` tools:

| Tool | Does |
| --- | --- |
| `fetch_get_state` | level, position, lives, bones, zoomies, confetti count, update listeners on the level scene |
| `fetch_load_level` | start a level |
| `fetch_throw_ball` | the tennis-ball pickup at the dog: zoomies and the confetti burst |
| `fetch_teleport` | move the dog to an x |
| `fetch_set_paused` | pause or resume |

`node scripts/webmcp-smoke.js --game http://localhost:5175/ --level level-2` checks them end to end through the WebMCP bridge.

## Playtest

[`glitchless.playtest.json`](glitchless.playtest.json) plays three runs: an expert from level 1 on Phaser 3, an average player on level 2, and the expert again on Phaser 4.

```bash
cd apps/phaser-demo
npx glitchless-playtest --save baseline
npx glitchless-playtest
```

## The planted bugs

Each one is marked `GLITCHLESS-DEMO` in the code.

| # | Bug | Where | What happens | What Glitchless shows |
| --- | --- | --- | --- | --- |
| 1 | **Confetti that never goes away** | `confettiBurst` in [`src/scenes.js`](src/scenes.js) | Every tennis ball bakes a new 512×512 texture and throws 600 arcade-physics pieces with their own ground collider. They fade out but are never destroyed, so every piece ever thrown keeps being simulated. | update CPU per frame climbing on level 2 (from about 0.3 ms to over 2 ms after a few balls on an M3 Max, enough to miss frames on a slow phone), `physics_bodies` and `game_objects` in `ctx`, `textures` growing across levels, hitches with `object_spawn` and `texture_upload` on slower machines. The playtest fails on update CPU when the burst gets bigger |
| 2 | **A listener added on every restart** | `create()` in [`src/scenes.js`](src/scenes.js) | `this.events.on('update', this.drawSky, this)` is never removed. Scene events outlive a restart, so each restart adds another copy and the sky is redrawn once per copy, every frame. | the `listeners` gauge rising with each `level_fail`, and `busiest_events` in `glitchless_inspect_scene` |
| 3 | **The frisbee crash** | `catchToy` in [`src/scenes.js`](src/scenes.js), frisbee on level 3 at x 1570 | `POWERUPS` has no `frisbee` entry, so catching it throws a `TypeError` inside an arcade overlap callback. Phaser's loop stops for good and the screen freezes. | the top error issue, and a `game_loop_stopped` crash pointing at the same line |
| 4 | **The Long Jump** | level 2, the pit from x 3300 to 3490 in [`src/levels.js`](src/levels.js) | 190 px wide when a jump at normal speed covers about 208 px: the takeoff window is about 70 ms. | deaths (`fell`) piling up at x ≈ 3400, level 2 fails and rage quits |

Heatmaps put y up, as in Three.js. Phaser's y points down, so Fetch!'s heatmaps show the level upside down for now.
