---
name: instrument
description: Add Glitchless observability to a three.js (or React Three Fiber) browser game — frame-time percentiles, hitch attribution, errors, gameplay events, level heatmaps, an in-game overlay and WebMCP tools for agents. Use when the user wants telemetry, analytics, performance monitoring or "observability" in a web game, or asks to add Glitchless.
---

# Instrument a web game with Glitchless

Goal: after this skill, every play session reports how the game *felt* (frame times, hitches and their causes),
what broke (errors, WebGL context loss) and what the player did (levels, deaths, pickups, positions) — and the
running game exposes WebMCP tools so you (the agent) can measure and reproduce problems live.

## 1. Read the game first

Find, and note file:line for each:
- where the `THREE.WebGLRenderer` (or `WebGPURenderer`), `scene` and main `camera` are created
- the game loop (`renderer.setAnimationLoop` / `requestAnimationFrame`)
- level/stage load and unload, player death/respawn, level complete/win, pickups/power-ups, game over
- anything spawned in bulk at runtime (particles, projectiles, enemies, debris) — these become context gauges
- where the version lives (`package.json` version or a constant); if none, create `src/version.js`

## 2. Install and initialize (right after the renderer exists)

```bash
npm install glitchless   # or, inside this repo's workspace: "glitchless": "*"
```

```js
import * as THREE from 'three';
import { Glitchless, instrumentThree } from 'glitchless';

const glitchless = Glitchless.init({
  service: '<game-id>',               // kebab-case, stable
  version: GAME_VERSION,              // bump on every release so Glitchless can compare versions
  env: import.meta.env?.MODE ?? 'dev',
  intake: import.meta.env?.VITE_GLITCHLESS_INTAKE ?? 'http://localhost:7777',
  clientToken: 'gl_pub_dev',
  sessionType: isBot ? 'synthetic' : 'user', // bots/autoplay must not pollute player metrics
  // privacy: 'anonymous' (default) sends no player ID, no detailed device fields and no positions.
  // Ask the user before choosing 'full': it adds a stored player ID and positions (heatmaps, replay),
  // which a game's privacy policy and store answers must then disclose (see the SDK's PRIVACY.md).
});
instrumentThree(glitchless, { renderer, scene, camera, THREE });
```

If the user gave you an intake URL and client token (a hosted Glitchless server prints both, for example
`Send telemetry to https://api.example.com with client token gl_pub_…`), use those instead of the local
defaults above. The client token is public and write-only, so it may live in the game's source; a secret
key (`gl_sk_…`) never goes in the game.

No bundler? Use `<script src="{GLITCHLESS_URL}/sdk/glitchless.js"></script>` and `Glitchless.init(...)` / `Glitchless.instrumentThree(...)`.

**Telemetry must never break the game.** Load the SDK through a small facade with try/catch and a no-op fallback
(see `apps/zoomies/src/telemetry.js` in the Glitchless repo for the pattern) and support a `?nogd=1` kill switch.

## 3. Wire game semantics

| Game moment | Call |
| --- | --- |
| level/stage starts (incl. restarts) | `glitchless.levelStart('level-2')` |
| level beaten | `glitchless.levelComplete('level-2', { durationS, score })` |
| player gives up / game over | `glitchless.levelFail('level-2', { cause })` |
| player dies | `glitchless.death({ x, y, z, cause: 'fell' })` — short, low-cardinality causes |
| pickups, power-ups, purchases, checkpoints | `glitchless.track('powerup', { kind: 'speed' })` |
| every frame | `glitchless.setPosition(player.position)` |
| every frame | `glitchless.setContext({ particles, enemies, projectiles })` — counts of anything that scales |
| after a level is built | `glitchless.captureMap(levelId, { axis: 'xy' /* side-scroller */ \| 'xz' /* top-down */, bounds: { min: [a, b], max: [a, b] } })` |
| handled errors worth knowing about | `glitchless.error(err, { where: 'save-game' })` |

## 4. Give agents hands: register game tools (WebMCP)

Register 3–5 tools that let an agent reproduce problems. Handlers return a plain object or string and never throw.

```js
glitchless.registerTool('mygame_get_state', 'Current level, player position, score, enemy/particle counts', { type: 'object', properties: {} }, () => ({ ... }));
glitchless.registerTool('mygame_load_level', 'Jump to a level', { type: 'object', properties: { level: { type: 'string' } }, required: ['level'] }, ({ level }) => { loadLevel(level); return `loaded ${level}`; });
```

Good candidates: load level, teleport player, trigger the expensive effect (explosion, power-up), toggle pause.

## 5. Verify

1. Run the game, press `` ` `` — the Glitchless overlay shows fps, p95 frame time, draw calls, context gauges.
2. Play a level and die once. Then confirm data arrived: call `glitchless_list_games`, or open the dashboard (`{GLITCHLESS_URL}`).
3. If WebMCP is connected, call `glitchless_live_performance` and `glitchless_inspect_scene`.

Report what you wired (with file:line), the gauges you chose and why, and the registered tools.
