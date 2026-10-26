# PlayCanvas

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


The same `glitchless` package, with a PlayCanvas adapter (the PlayCanvas engine 2.x, WebGL2 or WebGPU; editor
projects and engine-only games). It times frames from the app's loop, reads the device's draw calls and shaders,
counts triangles, reports editor scenes as levels, and catches failed assets, context loss and script errors.

## 1. Read the game

Note file:line for: where the `pc.Application` (or `AppBase`) is created, or for an editor project the scripts and
scenes; how levels load (`app.scenes.changeScene()`, `loadSceneHierarchy()`, or built in code); the scripts that handle
death, level complete, pickups; anything spawned in bulk (entities cloned or built per effect, meshes made at runtime);
where the version lives.

## 2. Install and initialize

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

## 3. Levels

- Editor scenes: `app.scenes.changeScene('Level2')` and `loadSceneHierarchy()` start a level named after the scene,
  unless the name reads as a loader, menu, overlay or end screen. Odd names: `levels: ['Forest', 'Cave']` or
  `levels: (name) => name or null`.
- Levels built in code: call `glitchless.levelStart('track-2')` where the level is built (this turns scene levels off).

## 4. Wire game semantics

The same calls as for Three.js, from the scripts that handle them (`levelComplete`, `levelFail`, `death`, `track`,
`setPosition` every frame from the player entity's `getPosition()`, `setContext`, `error`). The adapter already sends
`entities`, `mesh_instances`, `materials`, `textures` and `lights` as gauges. After a level is built,
`glitchless.captureMap(level, { axis: 'xz', bounds, exclude: [player] })` draws its picture (pass `pc` for it). WebMCP
tools, bug reports and source maps work as for Three.js. Vite's dev server runs PlayCanvas's debug build, which turns
a script off after it throws; the adapter reports those errors too.

Streams (`count`), session properties (`setProperties`), level attributes and zones are the same calls as in
[step 3 for Three.js](threejs.md#3-wire-game-semantics). A multiplayer game adds match groups, ping and disconnects,
and its Node server `glitchless/server`: [step 4a](threejs.md#4a-multiplayer-matches-ping-disconnects-and-the-games-server).

## 5. Bots and playtests

As for Phaser ([5](phaser.md#5-bots-and-playtests)). `apps/playcanvas-demo` in the Glitchless repo is a working example.

## 6. Verify

Run the game, press `` ` `` for the overlay, play a level and fail once, then call `glitchless_list_games`. With
WebMCP connected, `glitchless_inspect_scene` lists entity groups and flags copies that should be instanced or batched.
