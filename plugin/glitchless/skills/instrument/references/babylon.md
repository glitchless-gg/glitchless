# Babylon.js

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


The same `glitchless` package, with a Babylon.js adapter (Babylon.js 5+, WebGL or WebGPU). It times frames from the
engine's own loop, reads Babylon's draw-call, triangle and shader-compile counters, reports scenes as levels, and
catches shader errors, failed textures, context loss and a render loop that stopped.

## 1. Read the game

Note file:line for: `new Engine(...)` (or `WebGPUEngine`), each `new Scene(engine)` and whether each level is its own
scene or one scene rebuilt; the render loop (`engine.runRenderLoop`) and the game update (`scene.onBeforeRenderObservable`
or `registerBeforeRender`); player death and respawn, level complete, game over, pickups; anything created in bulk at
runtime (meshes, `ShaderMaterial`s, particle systems, `DynamicTexture`s); where the version lives.

## 2. Install and initialize

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

## 3. Levels

- Each level is its own scene: set `scene.metadata = { level: 'forest' }` when you create it. The level starts when the
  scene first renders and ends when it is disposed; scenes created later are picked up on their own.
- One scene rebuilt for each level: set `scene.metadata.level` to the next name, or call `glitchless.levelStart('forest-2')`
  (any manual call turns scene levels off).
- Odd cases: `instrumentBabylon(glitchless, { engine, scene, levels: (scene) => name or null })`.

## 4. Wire game semantics

The same calls as for Three.js: `levelComplete`, `levelFail`, `death({ x, y, z, cause })`, `track`, `setPosition`
(every frame, from the player's mesh position), `setContext`, `error`. The adapter already sends `meshes`,
`active_meshes`, `materials`, `textures`, `particles` and `render_observers` as gauges; add the game's own counts with
`setContext`. After a level is built, `glitchless.captureMap(level, { axis: 'xz', bounds: { min: [x0, z0], max: [x1, z1] }, exclude: [player] })`
draws its picture for the heatmaps (pass `BABYLON` for it). Register WebMCP tools, bug reports and source maps as for
Three.js ([4](threejs.md#4-give-agents-hands-register-game-tools-webmcp), [4b](threejs.md#4b-bug-reports-from-players-ask-first),
[4c](threejs.md#4c-readable-errors-from-the-production-build-source-maps)).

Streams (`count`), session properties (`setProperties`), level attributes and zones are the same calls as in
[step 3 for Three.js](threejs.md#3-wire-game-semantics). A multiplayer game adds match groups, ping and disconnects,
and its Node server `glitchless/server`: [step 4a](threejs.md#4a-multiplayer-matches-ping-disconnects-and-the-games-server).

## 5. Bots and playtests

As for Phaser ([5](phaser.md#5-bots-and-playtests)): `?autoplay=1&seed=N&skill=0..1&level=N`, synthetic sessions and
`window.__GLITCHLESS_PLAYTEST_DONE__`. `apps/babylon-demo` in the Glitchless repo is a working example.

## 6. Verify

Run the game, press `` ` `` for the overlay (draw calls, triangles, the gauges, the level), play a level and die
once, then call `glitchless_list_games`. With WebMCP connected, `glitchless_inspect_scene` lists each scene's mesh
groups and flags copies that should be instances or thin instances.
