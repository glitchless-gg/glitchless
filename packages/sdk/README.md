# glitchless

The browser SDK for [Glitchless](https://github.com/glitchless-gg/glitchless): game observability for web games, with adapters for Three.js, Phaser, Babylon.js and PlayCanvas. One init call gives you:

- **Frame-time percentiles.** The budget is inferred from the display refresh rate (60/120/144 Hz), read off the fastest frames, so a slow start doesn't halve it. Every 5 s the SDK summarises frames into a mergeable 2%-accuracy sketch; batches go out every 15 s, gzipped.
- **Hitches with attribution.** Each hitch is tied to a Long Animation Frame script, a shader compile, a GC pause or an asset load (and with Three.js, to what the frame uploaded to the GPU: textures, geometry buffers, shader programs), plus your game-context gauges and the gameplay events in the 1.5 s before it.
- **Errors with gameplay breadcrumbs.** Also captures WebGL context loss.
- **Device and GPU tier, load timing**: time to first frame and time to first input.
- **Gameplay.** Level funnel, deaths, rage inputs; in `full` privacy mode also death places and 4 Hz position samples (heatmaps, replay).
- **An in-game overlay.** Toggle it with the `` ` `` key. It works with no backend.
- **Multiplayer and genre games.** Counters for streams of events (shots, kills, gold), session properties (mode,
  rank tier, class, region), match, party and run groups, zones, and ping, loss and disconnects. A Node game server
  reports its own ticks, players and crashes with `glitchless/server`.
- **Bug reports from players** (opt-in). F8 or a button opens a small form; the note, a screenshot, the level,
  the position and the last events go to the dashboard's Bug Reports and to coding agents.
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
  version: '1.0.0',              // powers version comparison; on Steam with `steam`, defaults to 'steam-<build>'
  env: 'dev',
  intake: 'http://localhost:7777',  // omit for overlay/WebMCP-only mode (nothing leaves the browser)
  clientToken: 'gl_pub_dev',
  privacy: 'anonymous',          // default; 'install' adds a stored random player ID for retention; 'full' that, device detail and positions
  positions: undefined,          // default: on in 'full'; true sends positions in anonymous and install mode too
  overlay: undefined,            // default: on unless env === 'prod'; ` toggles it
  webmcp: undefined,             // default: on unless env === 'prod'
  sessionType: 'user',           // 'synthetic' for bots/autoplay
  windowMs: 5000,                // frame stats per window (the dashboard's time resolution)
  flushIntervalMs: 15000,        // how often batches are sent (on a window boundary); the first goes after one window
  sampleRate: 1,                 // share of sessions to record
  bugReports: null,              // { hotkey: 'F8', onOpen, onClose } (or true): players send bug reports from a form
  datadog: null,                 // { applicationId, clientToken, site, replay: true } → Datadog RUM
  steam: null,                   // an Electron game's steamworks.js client: Steam build, branch and hardware per session
  properties: null,              // what holds for the session in your game's words: { mode: 'squads', region: 'eu' }
  hashGroupIds: true,            // match and party IDs are hashed before they're sent; false sends them as they are
  optIn: false,                  // true: off on this device until setEnabled(true), for a game that asks the player first
});
instrumentThree(glitchless, { renderer, scene, camera, THREE });
```

Script tag: `<script src="https://<your-glitchless>/sdk/glitchless.js"></script>`, then use `Glitchless.init(...)` and `Glitchless.instrumentThree(glitchless, {...})`.

**Retention needs install mode.** In anonymous mode (the default) nothing is kept between visits, so the dashboard can't tell a returning player from a new one. `privacy: 'install'` keeps a random `p_…` player ID in localStorage and sends it with every batch, and nothing else changes: the Players page and `retention` board panels then show D1, D7 and D30. `glitchless.resetInstallId()` forgets the ID (for a "reset my ID" setting): the page keeps the one it started with, and the next load makes a new one. A Steam Deck is tagged `steam_deck: true` when its browser shows the Deck's GPU.

**A "share performance data" setting.** `glitchless.setEnabled(false)` turns Glitchless off for this player: it stops measuring and sending at once, drops what was waiting, and ends the session without sending anything more. `setEnabled(true)` turns it back on with a new session. The choice is saved in localStorage (`glitchless.enabled`), so a player who turned it off sends nothing at all on later visits, from the first frame. Wire it to a toggle in your settings:

```js
const share = document.querySelector('#share-data'); // <input type="checkbox">
share.checked = localStorage.getItem('my-game.share') !== 'off'; // your own saved setting
glitchless.setEnabled(share.checked); // changes nothing when it already agrees
share.addEventListener('change', () => {
  localStorage.setItem('my-game.share', share.checked ? 'on' : 'off');
  glitchless.setEnabled(share.checked);
});
```

For a game that asks the player before collecting anything, `optIn: true` keeps Glitchless off on a device until you call `setEnabled(true)` (the player said yes), and remembers the yes. `glitchless.isEnabled()` says whether it is on (it has an intake and the player hasn't turned it off).

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

## Babylon.js

Babylon.js 5 and later (tested with 9), on WebGL or WebGPU. Hand the engine and your first scene to
`instrumentBabylon` right after you create them:

```js
import * as BABYLON from '@babylonjs/core';
import { Glitchless } from 'glitchless';
import { instrumentBabylon } from 'glitchless/babylon';

const glitchless = Glitchless.init({ service: 'my-game', version: '1.0.0', intake: 'http://localhost:7777', clientToken: 'gl_pub_dev' });
const engine = new BABYLON.Engine(canvas, true);
const scene = new BABYLON.Scene(engine);
scene.metadata = { level: 'forest' };                // optional: this scene is the level "forest"
instrumentBabylon(glitchless, { engine, scene, BABYLON }); // BABYLON is optional: it lets captureMap draw levels
engine.runRenderLoop(() => scene.render());
```

Script tag: `Glitchless.instrumentBabylon(glitchless, { engine, scene })` (the `BABYLON` global is found on its own).

What the adapter adds:

- **Frames from Babylon's loop**, from one `onBeginFrameObservable` to the next, so `engine.maxFPS` or a paused loop is measured as drawn. Each frame is split into update time (before-render observers, animations, physics and your render-loop code) and render time.
- **Babylon's own counters**: draw calls (the engine's counter, as `SceneInstrumentation` reads it), triangles from the active indices, compiled effects as `programs`, and GPU frame time where timer queries exist (`gpuTime: false` turns it off).
- **Scenes as levels.** A scene whose `metadata.level` is set starts that level when it first renders; setting a new name starts the next, and disposing the scene ends it. Scenes made later are picked up on their own. Or pass `levels: (scene) => name or null`, or `levels: false`. Calling `glitchless.levelStart()` yourself turns scene levels off.
- **Gauges** in every frame window and hitch: `meshes`, `active_meshes`, `materials`, `textures`, `particles` and `render_observers` (before- and after-render observers: a count that grows with every spawn or restart is a leak). Turn them off with `gauges: false`.
- **Hitch causes**: `shader_compile` (from the engine's compile observables; with parallel shader compiles the stall comes a few frames later, so compiles in the second before it count), `object_spawn` (50+ meshes in a frame), `texture_upload`, `geometry_upload`, `scene_change`, `script`, `render`, with `shaders_compiled`, `shader_compile_ms` and `gpu_ms`.
- **Errors**: context loss (or a lost WebGPU device), shaders that failed to compile (`kind: 'shader'`, with the compiler's message), textures that failed to load (`kind: 'asset'`), and `game_loop_stopped`: an uncaught error inside the render loop stops `runRenderLoop` for good, the screen freezes, and the dashboard counts it as a crash.
- **WebMCP**: `glitchless_inspect_scene` lists each scene's meshes by name and class, flagging copies that should be instances or thin instances and materials that should be shared, with what is frozen, lights, shadow generators and observers; `glitchless_screenshot` captures the canvas at the end of a frame. `captureMap` renders an orthographic picture of the level with Babylon's render-target screenshot.

[apps/babylon-demo](https://github.com/glitchless-gg/glitchless/tree/main/apps/babylon-demo) is a small Babylon.js game wired this way, with planted bugs.

## PlayCanvas

The PlayCanvas engine 2.x, editor projects and engine-only games, on WebGL2 or WebGPU:

```js
import * as pc from 'playcanvas';
import { Glitchless } from 'glitchless';
import { instrumentPlayCanvas } from 'glitchless/playcanvas';

const glitchless = Glitchless.init({ service: 'my-game', version: '1.0.0', intake: 'http://localhost:7777', clientToken: 'gl_pub_dev' });
const app = new pc.Application(canvas);
instrumentPlayCanvas(glitchless, { app, pc }); // pc is optional: it lets captureMap draw levels
app.start();
```

In a PlayCanvas Editor project, do this in a script on the first entity to load (in its `initialize`, with
`this.app`). Script tag: `Glitchless.instrumentPlayCanvas(glitchless, { app })` (the `pc` global is found on its own).

What the adapter adds:

- **Frames from the app's loop**, from one `frameupdate` to the next, split into update time (scripts, animation and physics, up to `framerender`) and render time (`prerender` to `postrender`).
- **Draw calls** from the device's own per-frame count, **triangles** counted as the device draws (PlayCanvas counts them only in its profiler build), shaders as `programs`, the device's textures and vertex buffers.
- **Scenes as levels.** `app.scenes.changeScene()` and `loadSceneHierarchy()` start a level named after the scene, unless the name reads as a loader, menu, overlay or end screen; changing to a menu ends it. Pass `levels: ['Forest', 'Cave']`, `levels: (name) => name or null`, or `levels: false`. A game that builds its levels in code calls `glitchless.levelStart()`, which turns scene levels off.
- **Gauges**: `entities`, `mesh_instances`, `materials`, `textures` and `lights`. Turn them off with `gauges: false`.
- **Hitch causes**: `shader_compile` (a new shader: the first time a material variant is drawn), `object_spawn` (50+ render, model, sprite, element or particle components added in a frame), `geometry_upload`, `texture_upload`, `scene_change`, `script`, `render`, with `shaders_compiled`, `objects_added` and `buffers_added`.
- **Errors**: failed asset loads (`kind: 'asset'`), context loss (or a lost WebGPU device), and script errors. PlayCanvas's debug build (what Vite's dev server serves) catches an error in a script, logs it and turns the script off, so it never reaches `window.onerror`; the adapter reports it as the same `js` error the production build gives.
- **WebMCP**: `glitchless_inspect_scene` lists the hierarchy's entities by name with their meshes and materials, flagging copies that should be instanced or batched, plus scripts by type, lights, cameras and the device's shaders and textures; `glitchless_screenshot` captures the canvas at the end of a frame. `captureMap` renders the level from an orthographic camera into a texture.

[apps/playcanvas-demo](https://github.com/glitchless-gg/glitchless/tree/main/apps/playcanvas-demo) is a small PlayCanvas game wired this way, with planted bugs.

**What it sends, and what it costs the game.** [PRIVACY.md](https://github.com/glitchless-gg/glitchless/blob/main/packages/sdk/PRIVACY.md) lists every field in each privacy mode. The per-frame work is a sketch insert, a few counters and two clock reads around `renderer.render`: about 30 ns for the sketch, measured. Every 5 s it summarises a window (about 10 µs); every 15 s it serialises and gzips one batch (about 15 µs to serialise a real batch of about 5 KB, which gzips to about 1 KB) and sends it with `fetch`, which runs off the main thread. Batches go out uncompressed with `sendBeacon` when the page is hidden or closed.

## Game API

| Call | Use |
| --- | --- |
| `glitchless.levelStart(id, attrs?)` / `glitchless.levelComplete(id, { durationS, score })` / `glitchless.levelFail(id, { cause })` | level funnel, difficulty spikes; `attrs` describe the attempt (`{ tier: 'pit_80', party_size: 3 }`) so clears split by them |
| `glitchless.levelAbandon(id)` | the player left the level before it ended (back to the menu, a restart): never counted as a fail or a rage quit. Sent by itself when the page goes away mid-level |
| `glitchless.death({ x, y, z, cause })` | death heatmap (places sent only when positions are on), rage-quit detection |
| `glitchless.track(name, attrs)` | pickups, power-ups, purchases; also breadcrumbs for errors and hitches |
| `glitchless.count(name, attrs, n)` | streams: shots, hits, kills, gold, taps. Summed per 5 s window instead of an event each |
| `glitchless.setProperties({ rank: 'gold' })` | what holds for the session: mode, rank tier, class, region. Every board can split by them |
| `glitchless.setGroup('match' \| 'party' \| 'run', id)` | which match, party or run the next events belong to; `null` ends it |
| `glitchless.setZone(name)` | where the player is in an open world (an MMO region, a metroidvania room) |
| `glitchless.netSample({ rtt_ms, loss_pct, jitter_ms })` / `disconnect({ reason })` / `reconnect()` | ping, loss and dropped connections in a multiplayer game |
| `glitchless.setPosition(vec3)` (every frame) | movement heatmap and session replay (sampled at 4 Hz, sent only when positions are on) |
| `glitchless.setContext({ particles, enemies })` (every frame) | numeric gauges correlated with hitches |
| `glitchless.captureMap(levelId, { axis: 'xy' \| 'xz', bounds: { min: [a, b], max: [a, b] } })` | renders an orthographic thumbnail used as the heatmap background |
| `glitchless.error(err, attrs)` | report a handled error |
| `glitchless.registerTool(name, description, inputSchema, handler)` | expose a game tool to coding agents over WebMCP |
| `glitchless.measure(seconds)` | frame-time stats over the next N seconds (the A/B primitive) |
| `glitchless.reportBug({ note, screenshot })` | send a player's bug report from your own UI (`screenshot: false` leaves the picture out); resolves `{ sent }` |
| `glitchless.openBugReport()` | open the built-in bug report form, from your pause menu for example |
| `glitchless.setEnabled(on)` / `glitchless.isEnabled()` | the player's "share performance data" setting: off stops measuring and sending at once and drops what was waiting, on starts a new session; saved, so it holds on the next visit |

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

**Purchases** have one convention in every Glitchless SDK:

```js
glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' });
```

Send it when the store confirms the purchase, with `amount` a number in the currency's units (4.99, not 499) and `currency` the ISO code the store charged in. Boards add the amounts up into revenue, revenue per player and revenue by item, in the game's one currency: purchases in another are listed as left out, not added in. Never send receipts, order ids or payment details.

### Streams: count, don't track

`track()` is for moments: a match ended, a boss died, a purchase. For things that happen many times a second, use
`count()`, which adds up in the SDK and sends one total per name and group every 5 s:

```js
glitchless.count('shot', { weapon: 'ar' });
glitchless.count('hit', { weapon: 'ar', damage: 23 });      // damage is added up
glitchless.count('gold', { source: 'loot', amount: 35 });  // gold per hour, by source
```

Strings and booleans group the counts (at most 4), numbers are added up (at most 4). Boards read a counter by its name
like any event: kills per hour played, damage by weapon. A `track()` sent more than 20 times a second gets a console
warning that names `count()`. Counters go only to a Glitchless server that reads them; an older one gets none.

### Who is playing: session properties

```js
glitchless.setProperties({ rank: 'diamond', class: 'druid', region: 'eu-west', input: 'controller' });
```

Set them where the game knows them (after sign-in, at the menu, at matchmaking); `null` removes one. Every board can
then split by `$rank` or show only the high ranks. They describe the session in your game's words, never the person:
use bands (`level_band: '30-39'`, `trophy_band: '3000-3499'`), not exact numbers. Keys that name a person (`email`,
`user_id`, `steam_id`, …) and values that look like an email address, a link, a phone number or an ID are dropped,
with a console warning. At most 12 a session; nothing is kept between sessions.

### Matches, parties, runs and zones

```js
glitchless.setGroup('match', match.id);            // the ID your game server made for this match
glitchless.setGroup('party', party.id);
glitchless.levelStart('rift', { mode: 'ranked', hero: 'ember' });
// …
glitchless.setGroup('match', null);

const run = glitchless.setGroup('run');            // a roguelite run across several levels: the SDK makes the ID
glitchless.setZone('westfall');                    // open worlds: where the player is, until the next call
```

Every event carries the group while it is set, so the dashboard can line up everyone in one match. Match and party
IDs are hashed before they are sent (`h_` and 24 hex characters of SHA-1 of `"<service>:<id>"`), the same way in every
Glitchless SDK and in `glitchless/server`, so a match's players and its server send one ID; `hashGroupIds: false`
sends them as they are, to match against your server's logs. Never use an account, guild or friends-list ID. A run
saved with `setGroup('run', savedId)` carries on after a restart in install and full mode only; anonymous mode starts
a new run.

### Ping, loss and disconnects

A WebSocket has no round trip of its own, so pass the ping your netcode measures, about once a second:

```js
// Socket.IO: the server answers socket.on('latency', (ack) => ack())
setInterval(() => {
  const sent = performance.now();
  socket.emit('latency', () => glitchless.netSample({ rtt_ms: performance.now() - sent, transport: 'socket.io' }));
}, 1000);
socket.on('disconnect', (reason) => {
  if (reason === 'io client disconnect') return; // the player left: not a disconnect
  glitchless.disconnect({ reason: reason === 'ping timeout' ? 'timeout' : reason === 'io server disconnect' ? 'kicked' : 'connection_lost' });
});
socket.io.on('reconnect', () => glitchless.reconnect());
```

Reasons are `timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect` or `other`. A disconnect
mid-level ends the attempt as an abandon with reason `disconnect`, never a fail; `glitchless.reconnect()` when the
player gets back in, and they can still finish the level. A WebRTC game hands its peer connection over instead:

```js
import { instrumentNet } from 'glitchless/net';
instrumentNet(glitchless, { peer }); // the RTCPeerConnection: round trip, loss, jitter and throughput from getStats()
```

### Game servers: `glitchless/server`

A Node game server reports its own side: how long its ticks take against the target rate, how many players are
connected, their round trips as it sees them, its CPU and memory, its errors and crashes. It goes under the game's
companion service (`my-game.server`), apart from the players' numbers. Node 20+, no dependencies.

```js
import { GlitchlessServer, instrumentWs } from 'glitchless/server';

const server = GlitchlessServer.init({ service: 'my-game', version: '1.4.0', intake, clientToken, tickHz: 30, region: 'eu-west' });
instrumentWs(server, wss);                            // players, pings and how connections end
setInterval(server.measureTick(update), 1000 / 30);  // tick time
server.setGroup('match', matchId);                    // the same ID you hand the players
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
```

`instrumentSocketIO(server, io)` does the same for Socket.IO (round trips from its heartbeat), and
`gameServer.define('battle', glitchlessRoom(server, BattleRoom))` for Colyseus: each room is a match, its simulation
interval the tick. A server hosting several matches at once uses `server.match(id)` handles. An uncaught error is
reported as a crash and the process still dies as it would; what was queued goes out as it does. It sends nothing to
a Glitchless server that doesn't read server sessions yet. [SPEC §1](https://github.com/glitchless-gg/glitchless/blob/main/docs/SPEC.md)
has every call and field.

### Bug reports

Turn them on for playtests, jams and early access:

```js
const glitchless = Glitchless.init({
  // …
  bugReports: { hotkey: 'F8', onOpen: () => game.pause(), onClose: () => game.resume() },
});
```

F8 (or the **Report a bug** button in the overlay) opens a small form over the game: a preview of the screenshot, a
note, Send and Cancel (Ctrl+Enter and Esc work too). While it's open the SDK keeps keys, clicks and mouse movement
from reaching the game; `onOpen` and `onClose` are where the game pauses, which also stops gamepad input. The
report carries the note, a JPEG of the canvas (from the engine adapter, shrunk to fit 200,000
characters), the level, the position when positions are on, the last 20 game events and hitches, the last frame
windows' fps and p95, and the device. It is sent on its own request straight away.

Reports show in the dashboard's Bug Reports page with a link to each session's replay, as a finding once three
come from one level, and to agents through the `glitchless_bug_reports` MCP tool. The note is whatever the player
types: read [PRIVACY.md](PRIVACY.md#bug-reports-the-players-own-words) before you ship it.

### Steam (Electron and steamworks.js)

A game that ships on Steam with Electron and [steamworks.js](https://github.com/ceifa/steamworks.js) can pass its
client, and every session then says which Steam build and beta branch it ran, whether on a Steam Deck, in Big Picture
mode, with which kind of controller and in which Steam language:

```js
const steamworks = require('steamworks.js');
const client = steamworks.init(480); // your app ID
const glitchless = Glitchless.init({ service: 'my-game', intake, clientToken, steam: client });
```

The dashboard can then filter any page by `steam_branch=beta`, break events down by `$steam_branch`, and compare two
branches the way it compares versions (`glitchless_compare_versions` with `by: "steam_branch"`). Without a `version`,
the SDK reports `steam-<build>` (`steam-18231`) on a Steam build, so every upload to Steam is a version you can
compare; pass your own `version` and it wins. The SDK only reads the client you pass, once, at init: steamworks.js
ends the process if it is called before its `init()`, so Glitchless never loads or looks for it. steamworks.js has no
calls for Family Sharing, timed trials or Proton, so those aren't sent. No Steam ID or name is ever read
([PRIVACY.md](PRIVACY.md#steam-facts) has a paragraph for your privacy page).

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

- **[webmcp.dev](https://webmcp.dev) bridge.** Works with Claude Code, Codex and Cursor today. Run `claude mcp add webmcp -- npx -y @jason.today/webmcp@latest --mcp`, ask the agent for a token, then paste it into the WebMCP widget: the small square in the bottom-right corner, just left of the overlay (`webmcp: { position: 'top-left' }` moves it).
- **W3C `document.modelContext.registerTool`.** Used when the browser supports it (Chrome origin trial).

The webmcp.dev client is vendored from `@jason.today/webmcp` (MIT) in `src/vendor/`.

## Wire format

See [docs/SPEC.md](https://github.com/glitchless-gg/glitchless/blob/main/docs/SPEC.md).
