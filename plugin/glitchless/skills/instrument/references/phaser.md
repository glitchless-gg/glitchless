# Phaser

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


The same `glitchless` package, with a Phaser adapter (Phaser 3.60+ and 4). It times frames from Phaser's own loop,
counts draw calls, reports scenes as levels, and catches failed loads and a game loop that stopped.

## 1. Read the game

Note file:line for: `new Phaser.Game(config)` and the scene list; which scene keys are levels and which are
boot/preload/menu/UI/game-over scenes; player death and respawn, level complete, game over, pickups; anything
spawned in bulk (Groups, particle emitters, bullets); where the version lives.

## 2. Install and initialize

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

## 3. Levels

A scene that starts is a level, named by its key, unless the key reads as a loader, menu, overlay or end screen
(`Boot`, `Preloader`, `MainMenu`, `UIScene`, `HUD`, `GameOver`, `Pause`, `Settings`, `Credits`…). Check the
game's keys against that:

- Levels are scenes (`Level1`, `Level2`): nothing to do.
- One `Game` scene plays every level: call `glitchless.levelStart('world-1-2')` in its `create()` with the real
  level name. Any manual call turns scene levels off.
- Odd keys: `instrumentPhaser(glitchless, { game, Phaser, levels: ['Forest', 'Cave'] })` or `levels: (scene) => name or null`.

## 4. Wire game semantics

The same calls as for Three.js: `levelComplete`, `levelFail`, `death({ x, y, cause })`, `track`, `setPosition`,
`setContext`, `error`. The adapter already sends `game_objects`, `physics_bodies`, `particles`, `tweens`,
`listeners` and `sounds` as gauges; add the game's own counts (enemies, bullets) with `setContext`.
Phaser's y axis points down, so heatmaps show a Phaser level upside down for now; leave the coordinates as they are.

Register WebMCP tools as for Three.js (`glitchless.registerTool`). Bug reports work as for Three.js too
(`bugReports` in init, [step 4b](threejs.md#4b-bug-reports-from-players-ask-first)): the form's screenshot is the Phaser canvas.
So do source maps for the production build ([step 4c](threejs.md#4c-readable-errors-from-the-production-build-source-maps)).

Streams (`count`), session properties (`setProperties`), level attributes and zones are the same calls as in
[step 3 for Three.js](threejs.md#3-wire-game-semantics). A multiplayer game adds match groups, ping and disconnects,
and its Node server `glitchless/server`: [step 4a](threejs.md#4a-multiplayer-matches-ping-disconnects-and-the-games-server).

## 5. Bots and playtests

If the game has (or can get) an autoplay bot, make it read `?autoplay=1&seed=N&skill=0..1&level=N`, mark its
sessions synthetic, and set `window.__GLITCHLESS_PLAYTEST_DONE__ = true` when a run is over. Then
`glitchless-playtest` can compare builds. `apps/phaser-demo` in the Glitchless repo is a working example,
including `glitchless.playtest.json`.

## 6. Verify

Run the game, press `` ` `` for the overlay (draw calls, the gauges, the current level), play a level and die once,
then call `glitchless_list_games`. With WebMCP connected, `glitchless_inspect_scene` lists each running scene's
display list, physics bodies and busiest event listeners.
