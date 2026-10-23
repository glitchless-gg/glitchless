# Comet Garden (the Glitchless Babylon.js demo)

A small Babylon.js game: roll a glowing marble around a floating garden, collect every crystal and dodge the
spore mines. It is here to show `glitchless/babylon` on a real Babylon.js game (Babylon.js 9, WebGL2 or WebGPU).

Like Zoomies and Fetch!, it has **planted bugs** for Glitchless to find (listed below). Don't fix them.

## Run it

From the repo root:

```bash
npm install
npm run server                               # Glitchless on http://localhost:7777
npm run dev -w glitchless-babylon-demo       # http://localhost:5179
```

| Key | Action |
| --- | --- |
| arrows or `WASD` | roll |
| `R` | give up the level (`levelFail`, cause `restart`) |
| `F8` | report a bug |
| `` ` `` | the Glitchless overlay |

Three lives per level. Losing all three starts the level again in a new scene.

| Param | Default | Meaning |
| --- | --- | --- |
| `level=1..2` | `1` | start on the meadow or the nebula |
| `autoplay=1` | off | the bot plays (sessions are tagged `synthetic`) |
| `skill=0..1` | `0.7` | bot skill: how soon it sees mines and how much it wobbles |
| `seed=N` | random | bot seed |
| `env=`, `intake=`, `dashboard=` | `dev`, `http://localhost:7777`, `http://localhost:7777` | Glitchless settings |
| `nogd=1` | off | no Glitchless |

## How it's wired

[`src/telemetry.js`](src/telemetry.js) calls `Glitchless.init()` before the engine starts and hands the engine and
the first scene to `instrumentBabylon()`:

```js
import * as BABYLON from '@babylonjs/core';
import { Glitchless } from 'glitchless';
import { instrumentBabylon } from 'glitchless/babylon';

const glitchless = Glitchless.init({ service: 'comet-garden', version: GAME_VERSION, intake, clientToken: 'gl_pub_dev', positions: true });
const engine = new BABYLON.Engine(canvas, true);
instrumentBabylon(glitchless, { engine, scene, BABYLON });
```

Each level is its own Babylon scene with `scene.metadata = { level: 'meadow' }`: the adapter starts that level when
the scene first renders, and later scenes are picked up as the engine creates them. `BABYLON` is passed so
`captureMap` can draw each level for the heatmaps. The game itself only reports what Babylon can't know:
`death({ x, z, cause: 'spore' })`, `levelComplete`, `levelFail`, `track('seed')`, `track('prism')`,
`track('powerup', { kind })`, and `setPosition` and `setContext({ shards })` every frame.

## Agent tools (WebMCP)

[`src/agent-tools.js`](src/agent-tools.js) registers these next to the SDK's own `glitchless_*` tools:

| Tool | Does |
| --- | --- |
| `comet_get_state` | level, marble position, crystals, lives, score, power-up, live shards, bursts so far |
| `comet_load_level` | start a level (a new scene) |
| `comet_prism_burst` | the prism pickup's shard burst at the marble: the stutter on demand |
| `comet_teleport` | move the marble to (x, z) |
| `comet_set_paused` | pause or resume |

## Playtest

[`glitchless.playtest.json`](glitchless.playtest.json) plays an expert from the meadow and an average player on the
nebula:

```bash
cd apps/babylon-demo
npx glitchless-playtest --save baseline
npx glitchless-playtest
```

## The planted bugs

Each one is marked `GLITCHLESS-DEMO` in the code.

| # | Bug | Where | What happens | What Glitchless shows |
| --- | --- | --- | --- | --- |
| 1 | **A shader per shard** | `shardBurst` in [`src/game.js`](src/game.js) | Every prism throws 200 shards, each a mesh of its own with a `ShaderMaterial` whose colour is baked into its fragment source. Each is a new effect, so Babylon compiles 200 shaders on the frame after a pickup. | a hitch on every prism pickup (about 70 ms on an M3 Max, far longer on a laptop GPU), with `shader_compile` and `shaders_compiled: 200`; the finding "Hitches on meadow … from shader compiles" with Babylon's fixes: one shader in `ShaderStore.ShadersStore` with a colour uniform, compiled ahead with `forceCompilationAsync`, and thin instances instead of a mesh per shard. `programs` (compiled effects) climbs by 200 a burst |
| 2 | **The comet crash** | `collectPowerup` in [`src/game.js`](src/game.js), the comet on the nebula at (-6, 13) | `POWERUPS` has no `comet` entry, so picking it up throws a `TypeError` inside the scene's before-render observer. An error there stops Babylon's render loop for good: the screen freezes. | the `TypeError` issue at `collectPowerup (game.js)`, and a `game_loop_stopped` crash ("Babylon.js's render loop stopped after an uncaught error") with the same stack |
