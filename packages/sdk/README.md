# glitchless

The browser SDK for [Glitchless](https://github.com/glitchless-gg/glitchless): game observability for web games, with adapters for Three.js and Phaser. One init call gives you:

- **Frame-time percentiles.** The budget is inferred from the display refresh rate (60/120/144 Hz). Every 5 s the SDK summarises frames into a mergeable 2%-accuracy sketch; batches go out every 15 s, gzipped.
- **Hitches with attribution.** Each hitch is tied to a Long Animation Frame script, a shader compile, a GC pause or an asset load, plus your game-context gauges and the gameplay events in the 1.5 s before it.
- **Errors with gameplay breadcrumbs.** Also captures WebGL context loss.
- **Device and GPU tier, load timing**: time to first frame and time to first input.
- **Gameplay.** Level funnel, deaths, rage inputs; in `full` privacy mode also death places and 4 Hz position samples (heatmaps, replay).
- **An in-game overlay.** Toggle it with the `` ` `` key. It works with no backend.
- **WebMCP tools** so coding agents can measure, inspect and reproduce problems in the running game.
- An optional **Datadog RUM bridge**: levels map to Operations, frame stats to duration vitals, events to actions.

## Install

```bash
npm install glitchless
```

```js
import * as THREE from 'three';
import { Glitchless, instrumentThree } from 'glitchless';

const glitchless = Glitchless.init({
  service: 'my-game',            // required
  version: '1.0.0',              // required: powers version comparison
  env: 'dev',
  intake: 'http://localhost:7777',  // omit for overlay/WebMCP-only mode (nothing leaves the browser)
  clientToken: 'gl_pub_dev',
  privacy: 'anonymous',          // default; 'full' adds a stored player ID, detailed device fields and positions
  positions: undefined,          // default: on in 'full'; true sends positions in anonymous mode too
  overlay: undefined,            // default: on unless env === 'prod'; ` toggles it
  webmcp: undefined,             // default: on unless env === 'prod'
  sessionType: 'user',           // 'synthetic' for bots/autoplay
  windowMs: 5000,                // frame stats per window (the dashboard's time resolution)
  flushIntervalMs: 15000,        // how often batches are sent (on a window boundary); the first goes after one window
  sampleRate: 1,                 // share of sessions to record
  datadog: null,                 // { applicationId, clientToken, site, replay: true } → Datadog RUM
});
instrumentThree(glitchless, { renderer, scene, camera, THREE });
```

Script tag: `<script src="https://<your-glitchless>/sdk/glitchless.js"></script>`, then use `Glitchless.init(...)` and `Glitchless.instrumentThree(glitchless, {...})`.

## Phaser

Phaser 3.60+ and Phaser 4. Init before you create the game, then hand the game to `instrumentPhaser`:

```js
import * as Phaser from 'phaser';
import { Glitchless } from 'glitchless';
import { instrumentPhaser } from 'glitchless/phaser';

const glitchless = Glitchless.init({ service: 'my-game', version: '1.0.0', intake: 'http://localhost:7777', clientToken: 'gl_pub_dev' });
const game = new Phaser.Game(config);
instrumentPhaser(glitchless, { game, Phaser });
```

Script tag: `Glitchless.instrumentPhaser(glitchless, { game })`.

What the adapter adds:

- **Frames from Phaser's loop.** Each Phaser step is one frame, so a game with an fps limit is measured by the frames it draws. Each frame is split into update time (your scenes' `update`, physics, tweens) and render time.
- **Draw calls, triangles and shader compiles**, counted on the WebGL context (Phaser keeps no counters), or the Canvas renderer's draw count.
- **Scenes as levels.** A scene that starts is a level (`level_start`), unless its key reads as a loader, menu, overlay or end screen (`Boot`, `Preloader`, `MainMenu`, `UIScene`, `HUD`, `GameOver`…). Its shutdown ends the level; a restart is a new attempt. Pass `levels: ['Level1', 'Level2']`, `levels: (scene) => name or null`, or `levels: false`. Calling `glitchless.levelStart()` yourself turns scene levels off.
- **Gauges** in every frame window and hitch: `game_objects`, `particles`, `physics_bodies`, `tweens`, `listeners` (event handlers on the game and its scenes: a count that grows on every restart is a leak) and `sounds`. Turn them off with `gauges: false`.
- **Hitch causes** from what the slow step did: `object_spawn` (50+ objects added), `texture_upload` (a texture made mid-game), `shader_compile`, `scene_change`, `script`, `render`.
- **Errors**: failed loads (`kind: 'asset'`), WebGL context loss, and `game_loop_stopped`: an uncaught error inside `update` or a physics callback stops Phaser's loop for good, the screen freezes, and the dashboard counts it as a crash.
- **WebMCP**: `glitchless_inspect_scene` lists each running scene's display list by type and texture, physics bodies, tweens and the busiest event listeners; `glitchless_screenshot` captures the canvas right after Phaser renders.

`captureMap` isn't there for Phaser yet, so heatmaps draw positions without a level picture. [apps/phaser-demo](https://github.com/glitchless-gg/glitchless/tree/main/apps/phaser-demo) is a small Phaser game wired this way, with planted bugs.

**What it sends, and what it costs the game.** [PRIVACY.md](https://github.com/glitchless-gg/glitchless/blob/main/packages/sdk/PRIVACY.md) lists every field in both privacy modes. The per-frame work is a sketch insert, a few counters and two clock reads around `renderer.render`: about 30 ns for the sketch, measured. Every 5 s it summarises a window (about 10 µs); every 15 s it serialises and gzips one batch (about 15 µs to serialise a real batch of about 5 KB, which gzips to about 1 KB) and sends it with `fetch`, which runs off the main thread. Batches go out uncompressed with `sendBeacon` when the page is hidden or closed.

## Game API

| Call | Use |
| --- | --- |
| `glitchless.levelStart(id)` / `glitchless.levelComplete(id, { durationS, score })` / `glitchless.levelFail(id, { cause })` | level funnel, difficulty spikes |
| `glitchless.death({ x, y, z, cause })` | death heatmap (places sent only when positions are on), rage-quit detection |
| `glitchless.track(name, attrs)` | pickups, power-ups, purchases; also breadcrumbs for errors and hitches |
| `glitchless.setPosition(vec3)` (every frame) | movement heatmap and session replay (sampled at 4 Hz, sent only when positions are on) |
| `glitchless.setContext({ particles, enemies })` (every frame) | numeric gauges correlated with hitches |
| `glitchless.captureMap(levelId, { axis: 'xy' \| 'xz', bounds: { min: [a, b], max: [a, b] } })` | renders an orthographic thumbnail used as the heatmap background |
| `glitchless.error(err, attrs)` | report a handled error |
| `glitchless.registerTool(name, description, inputSchema, handler)` | expose a game tool to coding agents over WebMCP |
| `glitchless.measure(seconds)` | frame-time stats over the next N seconds (the A/B primitive) |

### Your own metrics

Every game counts different things, so `track` takes any name and attributes:

```js
glitchless.track('open', { edition: 'free' });
glitchless.track('play', { mode: 'endless' });
glitchless.track('paywall', { where: 'settings' });
glitchless.track('buy', { step: 'done' });
```

The dashboard's Events page counts each one over time, breaks it down by each attribute (plays by `mode`,
paywall views by `where`) and builds funnels between them (`paywall` → `buy=done`). Each game also gets its own
dashboard, pages of the panels that matter for it, which your coding agent can design with the
`glitchless_set_dashboard` MCP tool. Attributes are strings, numbers or booleans: at most 12 per event, and strings
are cut to 64 characters. Use the game's words, never anything that identifies a player.

## WebMCP

Tools the running game exposes:

- `glitchless_live_performance`
- `glitchless_measure`
- `glitchless_inspect_scene`
- `glitchless_errors`
- `glitchless_game_events`
- `glitchless_screenshot`
- `glitchless_session`
- `glitchless_annotate`
- anything you add with `glitchless.registerTool()`

They're registered two ways:

- **[webmcp.dev](https://webmcp.dev) bridge.** Works with Claude Code, Codex and Cursor today. Run `claude mcp add webmcp -- npx -y @jason.today/webmcp@latest --mcp`, ask the agent for a token, then paste it into the WebMCP widget.
- **W3C `document.modelContext.registerTool`.** Used when the browser supports it (Chrome origin trial).

The webmcp.dev client is vendored from `@jason.today/webmcp` (MIT) in `src/vendor/`.

## Wire format

See [docs/SPEC.md](https://github.com/glitchless-gg/glitchless/blob/main/docs/SPEC.md).
