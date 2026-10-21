# glitchless

The browser SDK for [Glitchless](https://github.com/glitchless-gg/glitchless): game observability for web games. One init call gives you:

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
