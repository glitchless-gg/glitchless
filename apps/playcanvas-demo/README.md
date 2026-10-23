# Spark Run (the Glitchless PlayCanvas demo)

A small PlayCanvas game: ride a hover-board down two long tracks, steer around the barriers, collect sparks and
hit the boost pads. It is here to show `glitchless/playcanvas` on a real PlayCanvas game (the PlayCanvas engine 2.x,
engine-only, with its behaviour in `pc.Script` classes).

Like the other demos, it has **planted bugs** for Glitchless to find (listed below). Don't fix them.

## Run it

From the repo root:

```bash
npm install
npm run server                                  # Glitchless on http://localhost:7777
npm run dev -w glitchless-playcanvas-demo       # http://localhost:5180
```

| Key | Action |
| --- | --- |
| `←` `→` or `A` `D` | steer |
| `R` | give up the track (`levelFail`, cause `restart`) |
| `F8` | report a bug |
| `` ` `` | the Glitchless overlay |

Three lives per track: a barrier costs one and sets you back a little. Losing all three starts the track again.

| Param | Default | Meaning |
| --- | --- | --- |
| `level=1..2` | `1` | start on the canyon or the skyway |
| `autoplay=1` | off | the bot plays (sessions are tagged `synthetic`) |
| `skill=0..1` | `0.7` | bot skill: how early it sees barriers and how much it drifts |
| `seed=N` | random | bot seed |
| `env=`, `intake=`, `dashboard=` | `dev`, `http://localhost:7777`, `http://localhost:7777` | Glitchless settings |
| `nogd=1` | off | no Glitchless |

## How it's wired

[`src/telemetry.js`](src/telemetry.js) calls `Glitchless.init()` before the app starts and hands the app to
`instrumentPlayCanvas()`:

```js
import * as pc from 'playcanvas';
import { Glitchless } from 'glitchless';
import { instrumentPlayCanvas } from 'glitchless/playcanvas';

const glitchless = Glitchless.init({ service: 'spark-run', version: GAME_VERSION, intake, clientToken: 'gl_pub_dev', positions: true });
const app = new pc.Application(canvas);
instrumentPlayCanvas(glitchless, { app, pc });
app.start();
```

`pc` is passed so `captureMap` can draw each track for the heatmaps. This game builds its tracks in code rather than
loading editor scenes, so it calls `glitchless.levelStart('canyon')` itself (an editor project's scenes become levels
on their own). The rest is what PlayCanvas can't know: `death({ x, z, cause: 'barrier' })`, `levelComplete`,
`levelFail`, `track('spark')`, `track('boost')`, `track('powerup', { kind })`, and `setPosition` and
`setContext({ sparks_fx })` every frame.

Vite's dev server runs PlayCanvas's debug build, which catches an error in a script, logs it and turns the script
off; the production build (`npm run build`) lets it reach `window.onerror`. Glitchless reports it the same way in both.

## Agent tools (WebMCP)

[`src/agent-tools.js`](src/agent-tools.js) registers these next to the SDK's own `glitchless_*` tools:

| Tool | Does |
| --- | --- |
| `spark_get_state` | track, position and progress, lives, sparks, score, live spark effects, bursts so far, whether the Collector script is still on |
| `spark_load_level` | start a track |
| `spark_boost_burst` | the boost pad's spark burst in front of the board: the stutter on demand |
| `spark_teleport` | move the board to an x along the track |
| `spark_set_paused` | pause or resume |

## Playtest

[`glitchless.playtest.json`](glitchless.playtest.json) plays an expert from the canyon and an average player on the
skyway:

```bash
cd apps/playcanvas-demo
npx glitchless-playtest --save baseline
npx glitchless-playtest
```

## The planted bugs

Each one is marked `GLITCHLESS-DEMO` in the code.

| # | Bug | Where | What happens | What Glitchless shows |
| --- | --- | --- | --- | --- |
| 1 | **A mesh per spark** | `sparkBurst` in [`src/game.js`](src/game.js) | Every boost pad builds 450 sparks on the frame it is crossed, each with a new sphere `Mesh` (its own vertex and index buffers), its own `StandardMaterial` and an entity of its own. | a hitch on every boost pad (about 85 ms on an M3 Max) with `object_spawn` and `geometry_upload`, `objects_added: 450`, `materials` jumping in `ctx`; the finding "Hitches on canyon … from geometry uploads and objects spawned in bursts", 90% or more within 1.5 s of a `boost`, with PlayCanvas's fixes: one mesh with hardware instancing (`meshInstance.setInstancing()`), pooled entities, a shared material |
| 2 | **The magnet error** | `Collector.update` in [`src/game.js`](src/game.js), the magnet on the skyway | `POWERUPS` has no `magnet` entry, so picking it up throws a `TypeError` in the Collector script. The debug build turns the Collector off, so the board stops collecting and passes through barriers for the rest of the run. | the `TypeError` issue at `Collector.update (game.js)` with PlayCanvas advice |
