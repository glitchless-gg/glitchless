# Glitchless technical spec (v0.1)

This is the contract between the pieces of Glitchless: the browser SDK, the intake/query API,
the dashboard, the MCP server and the demo game. If you change a shape here, change it everywhere.

## 1. Browser SDK — `glitchless`

```js
import { Glitchless } from 'glitchless';
import { instrumentThree } from 'glitchless/three';

const glitchless = Glitchless.init({
  service: 'zoomies',              // game id (required)
  version: '1.0.0',                // build version (required — powers version compare)
  env: 'dev',                      // dev | staging | prod
  intake: 'http://localhost:7777', // Glitchless API base URL. Omit → offline/overlay-only mode
  clientToken: 'gl_pub_dev',       // public, write-only token: safe to ship inside the game
  overlay: true,                   // in-game HUD, toggle with the backtick (`) key. Default: on unless env is prod
  privacy: 'anonymous',            // default. 'install' adds a stored random player ID (retention, §4b); 'full' that, GPU/CPU detail and positions (packages/sdk/PRIVACY.md)
  sampleRate: 1,                   // 0..1 fraction of sessions that send data
  positionHz: 4,                   // player position sampling rate for heatmaps / replay (positions are on in 'full' mode)
  windowMs: 5000,                  // frame stats are summarised per window
  flushIntervalMs: 15000,          // batches go out this often, gzipped, on a window boundary
  datadog: null,                   // optional { applicationId, clientToken, site } → mirrors to Datadog RUM
  bugReports: null,                // { hotkey: 'F8', onOpen, onClose } (or true): an in-game form players send bug reports from (§2 bug_report)
  steam: null,                     // an Electron game's steamworks.js client (what steamworks.init() returned): Steam facts per session (§4c)
  properties: null,                // what holds for the session in the game's words ({ mode: 'squads', region: 'eu' }): see setProperties
  hashGroupIds: true,              // match and party IDs are hashed before they're sent; false sends them as they are
  optIn: false,                    // true: off on a device until setEnabled(true), for a game that asks the player first (§4d)
});

instrumentThree(glitchless, { renderer, scene, camera, THREE }); // THREE is optional (enables LoadingManager hooks)
```

### Game-semantic API (call these from game code)

| Call | When |
| --- | --- |
| `glitchless.levelStart(levelId, attrs?)` | a level/stage begins (also sets current level on every event). `attrs` describe the attempt (`{ mode: 'ranked', tier: 'pit_80', party_size: 3 }`), with a custom event's rules: `level_start.attrs` |
| `glitchless.levelComplete(levelId, { durationS, score })` | level beaten |
| `glitchless.levelFail(levelId, { cause })` | level failed: the player lost it (died, ran out of time) |
| `glitchless.levelAbandon(levelId)` | the player left the level before it ended: quit to the menu, restarted it, closed the game. Never a fail (§2 `level_abandon`); the SDK sends it itself when the page hides mid-level |
| `glitchless.death({ x, y, z, cause })` | player died; `cause` is a short string (`fell`, `squirrel`, …) |
| `glitchless.track(name, attrs)` | any custom design event (`bone_collected`, `powerup`) |
| `glitchless.count(name, attrs = {}, n = 1)` | a stream of events (shots, hits, kills, gold, taps): summed per 5 s window, sent as one `counts` event (below) |
| `glitchless.setProperties({ rank: 'gold' })` | what holds for the session (mode, rank tier, class, region); `null` removes a key (below) |
| `glitchless.setGroup(kind, id, attrs?)` | marks the next events as one `match`, `party` or `run`; `null` ends it, `setGroup('run')` makes a run ID and returns it (below) |
| `glitchless.setZone(name)` | where the player is in an open world (an MMO region, a metroidvania room): every event and window carries `zone` until the next call; `null` clears it |
| `glitchless.netSample({ rtt_ms, loss_pct, jitter_ms })` | about once a second while connected, from the game's own netcode (below) |
| `glitchless.disconnect({ reason })` / `glitchless.reconnect()` | the connection dropped / came back (below) |
| `glitchless.setPosition({ x, y, z })` | every frame; SDK samples at `positionHz` |
| `glitchless.setContext({ particles, entities, ... })` | numeric gauges attached to frame windows and hitches |
| `glitchless.captureMap(levelId, { axis: 'xy' \| 'xz', bounds, exclude })` | after a level is built: renders an orthographic thumbnail used as the heatmap background, with the renderer's own tone mapping and output colour space (three.js r155+), so it looks like the game. `bounds = {min:[a,b], max:[a,b]}` in world units for the two axes; `exclude` = objects to hide while capturing (player, sky dome, effects) |
| `glitchless.registerTool(name, description, inputSchema, handler)` | expose a game-specific tool to coding agents over WebMCP |
| `glitchless.error(err, attrs)` | manually report a handled error |
| `glitchless.flush()` | force send (SDK also flushes on `pagehide`) |
| `glitchless.reportBug({ note, screenshot })` | send a player's bug report from the game's own UI (`screenshot: false` sends none); resolves `{ sent, reason? }` |
| `glitchless.openBugReport()` | open the built-in bug report form (from a pause menu, say) |
| `glitchless.resetInstallId()` | forget the stored player ID (§4b), for a "reset my ID" setting: this page load keeps its ID, the next makes a new one |
| `glitchless.setEnabled(on)` | the player's "share performance data" setting (§4d): `false` stops measuring and sending at once, drops what's waiting and ends the session without a `session_end`; `true` starts a new session. Saved in `localStorage`, so it holds from the start of the next visit |
| `glitchless.isEnabled()` | whether Glitchless is on: it has an intake and the player hasn't turned it off (§4d) |

Everything else (frames, hitches, errors, device/GPU, load timing, memory, session lifecycle) is automatic.

### Counters, properties, groups, zones and the network

The browser side of [docs/design/genre-coverage.md](design/genre-coverage.md) A5 to A8, with the owner's decisions
(its §7). Each SDK sends the same shapes.

**Counters** (`count`, A5). A call queues no event. The SDK keeps one entry per name and group in the current frame
window: the group is the call's string and boolean attributes (at most 4), its numbers (at most 4) are added up as
given, and `n` (1 to 1,000,000) adds to the count. `levelStart`, `setZone` and `setGroup` close the window, so counts
keep their level, zone and groups. A window holds 64 entries: past that, a new group of a name already counted goes
under the name with each of its attributes as `(other)`, and a new name is dropped, its `n` added to `dropped`. Each
window that counted anything sends:

```json
{ "type": "counts", "ts": 1760540000000, "level": "nmd_ghoa", "duration_s": 5, "dropped": 0,
  "counts": [ { "name": "kill", "attrs": { "monster": "elite" }, "n": 37, "first_ts": 1760540000412 },
              { "name": "gold", "attrs": { "source": "loot" }, "n": 52, "sums": { "amount": 1820 }, "first_ts": 1760540000100 } ] }
```

`ts` is the window's start. The SDK asks `GET {intake}/v1/health` once at start and sends counters only when its
`features` list has `"counts"`: until it answers they wait (up to 120 windows), and a server without it gets none and
a console warning, once, outside `prod`. Outside `prod` a name sent with `track()` more than 20 times a second gets one
warning that names `count()`.

**Properties** (`setProperties`, `properties` in init; A6). Sent in every privacy mode; the SDK keeps nothing between
sessions. The properties set before the first batch go in `session_start.props`; a later change is one
`{ "type": "props", "props": { "rank": "platinum", "play": null } }` a window at most, with only the keys that changed
(`null`: removed) and `ts` the last change. A call that changes nothing sends nothing. The SDK drops, with a console
warning once outside `prod`:
- keys that don't match `^[a-z][a-z0-9_]{0,31}$`, past 12 a session (removed keys count), reserved (`version`,
  `level`, `env`, `platform`, `browser`, `device_tier`, `session_type`, `privacy`, `role`, `link`, `type`, `players`,
  `sessions`, `hours`, `zone`, `match`, `party`, `run`, the Steam facts) or identifying (`name`, `username`, `user`,
  `email`, `phone`, `user_id`, `account`, `account_id`, `player_id`, `steam_id`, `epic_id`, `psn_id`, `xbox_id`, `ip`,
  `address`, `device_id`, `idfa`, `gaid`, `ad_id`, `location`, `lat`, `lon`, `city`, `birthday`, `age`, `gender`);
- values other than a string (trimmed, cut to 64 characters), a boolean or a whole number from −1,000,000 to
  1,000,000;
- strings shaped like an email address, a link (`scheme://`, `www.`), a run of 7+ digits, a phone number (`+…`,
  `(555) 123-4567`, `555-123-4567`), a UUID, 16+ hex characters, or 16+ base64 characters mixing upper case, lower
  case and digits. Bands pass (`3000-3499`, `30-39`), as do snake-case words (`summer_2026`).

**Groups** (`setGroup`, A7). `kind` is `match`, `party` or `run`. A `group` event goes out when one is set or ended
(`{ "type": "group", "kind": "match", "id": "h_5024a0627b476d00b16ae24a", "attrs": { "mode": "squads" } }`, `id: null` when it
ends), and while a group is set every event and window carries it as a field (`"match": "h_…"`, `"party"`, `"run"`).
IDs are 8 to 64 characters of `[A-Za-z0-9_.:-]`; anything else is dropped. Match and party IDs come from the game's
server and are hashed before they are sent, the same way in every Glitchless SDK, so a match's players and its server
send one ID: `"h_"` and the first 24 hex characters of SHA-1(`<service, lower case>:<id>`) (UTF-8; the game's own
service, also on its server). `hashGroupIds: false` sends them as they are. `setGroup('run')` makes `r_` and 12
characters and returns it; `setGroup('run', saved)` carries a saved run on in install and full mode, and in anonymous
mode starts a new one instead; either way its `group` event has `resumed: true`.

**Zones** (`setZone`, decision 6). Every event, frame window, position batch and hitch carries `"zone": "<name>"`
(cut to 64 characters) while one is set, as they carry `level`; none is sent while it is null. A new zone closes the
frame window. There is no zone event: a zone has no start or end.

**Network** (A8). `netSample({ rtt_ms, loss_pct, jitter_ms, in_kbps?, out_kbps?, transport?, host? })` from the game's
own ping (a WebSocket has no round trip of its own; `transport` names the library, `ws`, `socket.io`, `colyseus`;
`host: true` for the player who hosts the game). Samples less than 900 ms after the last one are left out. The first
sample marks the player connected, and from then each frame window carries:

```json
"net": { "rtt": { "a": 0.05, "b": { "…": 1 }, "n": 5, "z": 0 }, "rtt_p50": 38, "rtt_p95": 61, "rtt_max": 74,
         "jitter_ms": 6, "loss_pct": 0.4, "in_kbps": 92, "out_kbps": 31, "samples": 5,
         "transport": "ws", "link": "wifi", "host": false }
```

`rtt` is a sketch at 5% (§2's sketch format). The numbers are the window's samples (means for jitter, loss and
throughput; null without samples), and a window that was connected without a sample still carries `net` with
`samples: 0`, so time connected adds up. `link` is `navigator.connection.type` read as `wifi`, `cellular` or `wired`
(Chrome on Android), else null. A window while not connected has no `net`.

`disconnect({ reason })` sends `{ "type": "disconnect", "reason", "connected_s", "rtt_p95", "loss_pct" }` with the
current window's numbers (the last window's when this one has no sample yet); `reason` is `timeout`,
`connection_lost`, `kicked`, `server_closed`, `failed_to_connect` or `other` (anything else reads as `other`). At most
20 a session. With a level open it also sends `level_abandon` with `reason: "disconnect"`, and drops a `level_fail` or
`level_abandon` the game sends for that level before reconnecting. `reconnect()` sends `{ "type": "reconnect",
"after_s" }` and opens that level again, so the player can still finish it (the server takes the abandon back, §2).

`instrumentNet(glitchless, { peer, host? })` (`glitchless/net`, and `Glitchless.instrumentNet` in the script build)
reads an `RTCPeerConnection`'s `getStats()` once a second into `netSample`: the selected candidate pair's
`currentRoundTripTime` and bytes (throughput), and the inbound RTP streams' `packetsLost`, `packetsReceived` and
`jitter` (a game on data channels only has no RTP, so its loss is null). `connectionState` going to `failed` is a
`disconnect` with `connection_lost`, coming back from it a `reconnect`, and `closed` stops it. It returns
`{ stop() }`. Addresses and candidates are never read into anything sent.

### Phaser adapter (`glitchless/phaser`)

```js
import { instrumentPhaser } from 'glitchless/phaser';
const game = new Phaser.Game(config);
instrumentPhaser(glitchless, { game, Phaser, levels: 'auto' }); // Phaser 3.60+ and Phaser 4
```

The same SDK, with Phaser's own loop as the frame clock. Differences on the wire:

| | |
| --- | --- |
| envelope | `"sdk": "glitchless-phaser/<version>"`, so findings give Phaser advice |
| `session_start` | adds `engine: { name: 'phaser', version, renderer: 'webgl' \| 'canvas' \| 'headless' }` |
| `frame_window` | one frame per Phaser step (`prestep` to `prestep`), so an fps limit or a `setTimeout` loop is measured as drawn; adds `process_ms` (scene updates, `prestep` to `poststep`); `render_ms` is `prerender` to `postrender`; `draw_calls` and `triangles` are counted on the WebGL context (the Canvas renderer's `drawCount` otherwise); `textures` is the texture manager's key count; `programs` counts WebGL programs linked; `geometries` is null; `ctx` adds `game_objects`, `particles`, `physics_bodies`, `tweens`, `listeners`, `sounds` |
| `hitch` | `causes` adds `scene_change`, `object_spawn` (50+ objects added in one step), `texture_upload`, `shader_compile` (a program linked), `script`, `render`; adds `process_ms`, `render_ms`, `objects_added`, `textures_added`, `programs_linked` |
| `level_start` | sent when a scene that reads as a level starts (`levels: 'auto'`); a scene's shutdown sets the level to null. `levels` can be an array of keys, a function, or `false` |
| `error` | adds `kind: 'asset'` (a loader `loaderror`) and `kind: 'game_loop_stopped'`: the loop stopped stepping after an uncaught error, with that error's stack. The server counts that session as crashed |

### Babylon.js adapter (`glitchless/babylon`)

```js
import { instrumentBabylon } from 'glitchless/babylon';
instrumentBabylon(glitchless, { engine, scene, BABYLON, levels: 'auto', gauges: true, gpuTime: true }); // Babylon.js 5+, WebGL or WebGPU
```

The same SDK, with Babylon's own frame loop and counters. `BABYLON` (the namespace) is optional: `captureMap` needs it.

| | |
| --- | --- |
| envelope | `"sdk": "glitchless-babylon/<version>"`, so findings give Babylon.js advice |
| `session_start` | adds `engine: { name: 'babylon', version, renderer: 'webgl' \| 'webgpu' \| 'headless' }` |
| `frame_window` | one frame per engine frame (`onBeginFrameObservable` to the next), so work Babylon does just after drawing (a shader compiled in a promise) belongs to the frame; `render_ms` is each scene's render targets to `onAfterRenderObservable`, `process_ms` the rest of the frame's CPU time (before-render observers, animations, physics, the game's render-loop code); `draw_calls` from the engine's draw-call counter, `triangles` from the scenes' active indices; `geometries` and `textures` are the scenes' counts and `programs` the compiled effects; `ctx` adds `meshes`, `active_meshes`, `materials`, `textures`, `particles`, `render_observers` |
| `hitch` | `causes` adds `shader_compile` (compiles in the frame or the second before it: with `KHR_parallel_shader_compile` the stall comes a few frames after the compile), `scene_change` (a scene created, disposed, first drawn, or a level start), `object_spawn` (50+ meshes added), `texture_upload`, `geometry_upload` (as Three.js, on WebGL), `script`, `render`; adds `process_ms`, `render_ms`, `gpu_ms`, `shaders_compiled`, `shader_compile_ms`, `meshes_added`, `materials_added`, `textures_added`, `textures_uploaded`, `buffers_uploaded` |
| `level_start` | when a scene whose `metadata.level` is set first renders, or when that name changes; disposing the scene sets the level to null. `levels` can be a function `(scene) => name` or `false`; a manual `levelStart` turns scene levels off |
| `error` | adds `kind: 'shader'` (an effect that failed to compile; `attrs.errors` holds the compiler's message), `kind: 'asset'` (a texture that failed to load), `kind: 'webgl_context_lost'` (also a lost WebGPU device) and `kind: 'game_loop_stopped'`: the render loop queued no frame after an uncaught error, with that error's stack. The server counts that session as crashed |

### PlayCanvas adapter (`glitchless/playcanvas`)

```js
import { instrumentPlayCanvas } from 'glitchless/playcanvas';
instrumentPlayCanvas(glitchless, { app, pc, levels: 'auto', gauges: true }); // the PlayCanvas engine 2.x, WebGL2 or WebGPU
```

`pc` (the namespace) is optional: `captureMap` and the engine version need it.

| | |
| --- | --- |
| envelope | `"sdk": "glitchless-playcanvas/<version>"`, so findings give PlayCanvas advice |
| `session_start` | adds `engine: { name: 'playcanvas', version, renderer: 'webgl' \| 'webgpu' \| 'headless' }` |
| `frame_window` | one frame per app tick (`frameupdate` to the next); `process_ms` is `frameupdate` to `framerender` (scripts, animation, physics), `render_ms` is `prerender` to `postrender`; `draw_calls` is the device's per-frame count, `triangles` are counted at `device.draw`; `geometries` counts vertex buffers, `textures` the device's textures, `programs` its shaders; `ctx` adds `entities`, `mesh_instances`, `materials`, `textures`, `lights` |
| `hitch` | `causes` adds `shader_compile` (a shader created in the frame or the second before it), `scene_change` (a scene loaded, or a level start), `object_spawn` (50+ render, model, sprite, element or particle components added), `texture_upload`, `geometry_upload`, `script`, `render`; adds `process_ms`, `render_ms`, `shaders_compiled`, `shader_compile_ms`, `objects_added`, `textures_added`, `buffers_added`, `textures_uploaded`, `buffers_uploaded`, `buffer_kb` |
| `level_start` | when `app.scenes.changeScene()` or `loadSceneHierarchy()` loads a scene whose name reads as a level (as Phaser's scene keys do); `changeScene()` to any other scene sets the level to null. `levels` can be an array of names, a function `(name) => name` or `false`; a manual `levelStart` turns scene levels off |
| `error` | adds `kind: 'asset'` (the asset registry's `error`), `kind: 'webgl_context_lost'` (also a lost WebGPU device) and, for a script error the debug build caught (it turns the script off), `kind: 'js'` with `attrs: { script, method, script_disabled: true }`: the same kind and message as the production build's uncaught error (with source maps uploaded, the same issue) |

### Node server SDK (`glitchless/server`)

For JavaScript game servers (design A9, decision 4): `ws`, Socket.IO, Colyseus or the game's own. Node 20+, no
dependencies.

```js
import { GlitchlessServer, instrumentWs, instrumentSocketIO, glitchlessRoom } from 'glitchless/server';

const server = GlitchlessServer.init({
  service: 'zoomies',      // the game's own service: intake files this server under "zoomies.server"
  version: '1.4.0',
  env: 'prod',
  intake: 'https://…',
  clientToken: 'gl_pub_…', // the game's client token
  tickHz: 30,              // the target tick rate: a tick over 1000 / tickHz ms is late
  maxPlayers: 100,
  region: 'eu-west',       // in the game's own words
  build: 'dedicated',      // or 'headless'
  sessionType: 'user',     // 'synthetic' for a load test
  sessionPerMatch: false,  // true: one session per match, for a server that hosts one at a time
  hashGroupIds: true,
  crashes: true,           // watch uncaught errors and send what's queued as the process dies
  crashDir: os.tmpdir() + '/glitchless', // where batches wait when they couldn't go as it died (null: nowhere)
});
setInterval(server.measureTick(update), 1000 / 30); // or server.tick(ms) around each tick
instrumentWs(server, wss);                           // a `ws` WebSocketServer
```

| Call | When |
| --- | --- |
| `server.tick(ms)` / `server.measureTick(fn)` | each simulation tick took `ms`; the wrapper times a tick function (one that returns a promise until it settles) |
| `server.setPlayers(n)` | players connected now (the helpers call it) |
| `server.playerPing(ms)` | a connected player's round trip as the server sees it (the helpers call it) |
| `server.setContext({ net_objects, in_kbps, out_kbps, … })` | gauges: those three go in their `server_window` fields, the rest in `ctx` (highest per window) |
| `server.track`, `server.count`, `server.levelStart(map, attrs)`, `levelComplete`, `levelFail`, `levelAbandon`, `server.error(err, attrs)` | as in the browser SDK; the level is the map |
| `server.setGroup(kind, id, attrs)` | the match (party, run) the server's next events belong to, hashed as the players' SDKs hash it, so both sides join up. With `sessionPerMatch`, a new match starts a new session and `setGroup('match', null)` ends it |
| `server.match(id, attrs)` | a match among several the process hosts at once: a handle with `track`, `count`, `levelStart`, `levelComplete`, `levelFail`, `error` and `end()`, whose events carry its `match`, and whose counters are its own |
| `server.close(reason = 'shutdown')` | from the game's own SIGTERM handler: sends what's queued and `session_end` |

What it sends:
- The envelope has `role: "server"`, `player_id: null`, `service` the game's own and `sdk: "glitchless-node/<version>"`.
  Intake files these batches under the companion service `<service>.server` (§6), so no player number takes in a
  server.
- `session_start` (sent at once): `session_type`, `privacy: "anonymous"`, `engine: { name: "node", version }` and
  `server: { tick_hz, max_players, build, region, host: { os, cores, memory_gb } }`. Never the host name or address.
- Every 5 s a `server_window`: `{ duration_s, ticks, tick_hz, tick: {sketch at 2%}, tick_p50, tick_p95, tick_max, late,
  players, players_max, net_objects, in_kbps, out_kbps, cpu_pct, mem_mb, rtt_p95, ctx }`. `tick_hz` is the rate
  reached, `late` the ticks over the budget (null without `tickHz`), `cpu_pct` the process's CPU as a percent of one
  core, `mem_mb` its resident memory, `rtt_p95` the players' round trips it saw. A window without ticks still goes.
  Each window that counted anything adds a `counts` event, one per match handle.
- Groups as in the browser SDK. A match handle's `end()` sends `{ "type": "group", "kind": "match", "id": null,
  "ended": "<its id>" }`, since other matches are still open. Groups still set carry over to the next session.
- A session lasts as long as the process, cut every 6 hours (`session_end.reason: "max_duration"`), or one match with
  `sessionPerMatch` (`"match_end"`).
- Errors: `server.error` is `kind: "manual"`. Uncaught errors are watched with `uncaughtExceptionMonitor`, never
  caught, so the process dies as it would without Glitchless: the error goes as `kind: "crash"` (`attrs.origin`
  `uncaughtException` or `unhandledRejection`) with the last window and `session_end` (`reason: "crash"`), sent from a
  short-lived child process because the dying one can't wait for an answer; failing that, they wait in `crashDir` and
  the next start sends them. A process that keeps going because the game listens for `uncaughtException` reports
  `kind: "exception"` (`"promise"` for a rejection). A process that exits normally sends `session_end`
  (`reason: "exit"`). Error text loses query strings and the user and password in connection strings.
- It asks `GET {intake}/v1/health` once at start and sends nothing at all until its `features` list `"server_mode"`
  (counters also need `"counts"`); a server without it gets nothing, and a warning says so once.

Helpers (they only call what the objects passed in have):

| Helper | What it reads |
| --- | --- |
| `instrumentWs(server, wss, { pingMs: 5000 })` | a `ws` `WebSocketServer`: players from `wss.clients`, server errors, a WebSocket ping of its own to each client every `pingMs` (its own payload, so a game's heartbeat pings don't mix in) for `playerPing`, and each close as a `player_left` counter |
| `instrumentSocketIO(server, io)` | a Socket.IO `Server`: players from `io.engine.clientsCount`, round trips from Engine.IO's heartbeat (the server's `ping` packet to the client's `pong`, every `pingInterval`), and each `disconnect` as a `player_left` counter |
| `glitchlessRoom(server, RoomClass)` | a Colyseus room class: `gameServer.define('battle', glitchlessRoom(server, BattleRoom))`. Each room is a `server.match(roomId, { room: roomName })`, its `setSimulationInterval` callback is the tick, its joins and leaves count players, `onDispose` ends the match, and where the room defines `onUncaughtException` its errors are the match's |

`player_left` is a counter with `reason`: `left` (a normal close, `client namespace disconnect`), `timeout` (`ping
timeout`), `connection_lost` (close code 1006, `transport close`, `transport error`), `kicked` (1008, `server
namespace disconnect`), `server_closed` (1012, `server shutting down`) or `other`.

## 2. Wire format

`POST {intake}/v1/intake?token={clientToken}` with `Content-Type: text/plain` (avoids CORS preflight; `sendBeacon` compatible).

```json
{
  "service": "zoomies", "env": "dev", "version": "1.0.0",
  "session_id": "s_8f2c…", "player_id": "p_19ab…",
  "sdk": "glitchless-browser/0.1.0",
  "batch_id": "b_k2j4h5g6f7d8s9a0",
  "events": [ { "type": "frame_window", "ts": 1760540000000, "level": "level-2", "…": "…" } ]
}
```

Every event has `type`, `ts` (epoch ms) and `level` (current level or `null`). The server adds
`project_id` from the client token (§6); a payload can't set it. While the game has set them, every event and window
also carries `zone` (where the player is in an open world, cut to 64 characters) and `match`, `party` and `run` (its
groups, below); they are left out while unset. Intake drops a group field that isn't 8 to 64 of `[A-Za-z0-9_.:-]`.

**`level_abandon`.** The player left a level before it ended (went to the menu, restarted, closed the game). It
is never a fail: the level funnel counts it apart (`abandons`), it is no rage quit, and a level is judged a wall only
on the sessions that played it to an end (§4). Every SDK has a call for it, and sends one itself, before
`session_end`, when the game goes to the background, closes or quits (the page hides, in the browser) with a level
started and not yet completed, failed or abandoned. A `level_fail` or `level_abandon` the game sends for that level
after the session has ended (a level torn down as the app closes) is then dropped by the SDK: the attempt already
has its outcome. A player who comes back from the background and plays on in the same session takes the abandon
back: the server drops an abandon followed by a complete, fail or death on the same level before its next
`level_start`. A game on an older SDK can send `level_fail` with the cause `abandon`.

**`batch_id`.** The batch's own ID: `b_` and 16 random characters `[a-z0-9]` (8 to 64 of `[A-Za-z0-9_.:-]` are
accepted), made when the SDK cuts the batch and sent unchanged with every retry of it. An SDK sends a batch again
whenever it never saw the answer to an earlier try: the request timed out, the game went to the background with
it in flight, or the game closed with it still saved (engine SDKs send their saved batches on the next launch, in
anonymous mode under a new session ID, so the ID is not derived from the session). Intake stores a batch ID once
per project and game for 7 days: a repeat is answered `202 {"accepted": 0, "duplicate": true}` and nothing in it
is stored, counted, forwarded or shown on the live tail again. An SDK clears a batch as soon as any 2xx comes back.
A payload without `batch_id` (an older SDK) is stored every time it arrives. The ID names one batch, never the
player or the session: engine SDKs save it with the batch in every privacy mode (§4b).

| type | fields |
| --- | --- |
| `session_start` | `session_type` (`user`: a player; `tester`: a person on a test build, a TestFlight or development install on iOS (§4b); `synthetic`: a bot, a playtest or a store's test phone; `simulated`: made-up data), `privacy` (`anonymous`, `install`, `full`), `device {browser, browser_version, os, mobile, gpu, gpu_vendor, gpu_tier, cores, memory_gb, screen:[w,h], dpr, webgl, steam_deck, distribution}`, `page {url, referrer}`. The browser sends `steam_deck: true` only when it can tell it runs on a Steam Deck (§4b). The engine SDKs send `distribution` on iOS: `app_store`, `testflight` or `development` (§4b; intake drops any other value). A game that uses Steamworks adds its Steam facts to `device` (`steam_build`, `steam_branch`, `steam_hardware`…, §4c). `props`: the session's properties set before its first batch (below). Intake makes a `user` (or unset) `session_type` `synthetic` when the batch comes from one of Firebase Test Lab's published addresses (Google Play's pre-launch phones, `server/src/test-lab.js`), whatever engine sent it; the address decides only that and isn't stored |
| `frame_window` | every window (5 s; sent in batches every 15 s): `frames, fps, ft {sketch}, ft_p50, ft_p95, ft_p99, ft_max, jank` (frames > 33.3ms), `hitches` (frames > 50ms), `render_ms` (avg CPU ms inside `renderer.render`), `draw_calls, draw_calls_max, triangles, geometries, textures, programs, heap_mb, ctx {…gauges}`, `budget_ms` (from the display's refresh rate, read off the fastest frames and checked again as the session goes). A window never spans two levels: `levelStart` closes it, with the positions sampled so far. `net` (A8, §1) while the player was connected: `{rtt {sketch at 5%}, rtt_p50, rtt_p95, rtt_max, jitter_ms, loss_pct, in_kbps, out_kbps, samples, transport, link, host}` |
| `hitch` | single frame > 50ms: `duration_ms, draw_calls, triangles, ctx, recent [last 5 game events], loaf [{source, fn, ms}], causes` (`script`, `shader_compile`, `gc`, `asset_load`, `frozen`; engine SDKs also `gpu_or_os`: none of their other causes applies and what they measured inside the game, its code, physics, the renderer's CPU work and the GPU where it is timed, adds up to less than max(16 ms, 40% of the frame), so the time went to the GPU, to presenting the frame or to the OS). With `instrumentThree`, what the frame sent to the GPU, counted on the WebGL context: `causes` adds `shader_compile` (a program linked), `texture_upload` (4+ textures uploaded or re-uploaded, or a megapixel), `geometry_upload` (32+ buffers or 4 MB), `render` (`renderer.render` took 40% of the frame); adds `render_ms`, `textures_uploaded`, `texture_mpx`, `buffers_uploaded`, `buffer_kb`, `programs_linked` |
| `load` | `ts` is when the first frame was drawn; `ttff_ms` (navigation → first rendered frame; engine SDKs: process start → first frame), `assets {count, bytes, ms, slowest:[{url, ms, bytes}]}`. Engine SDKs add `first_launch`: whether this is the first launch of this game version on the device (the first after an install or an update builds the shader caches and reads files the OS hasn't cached, so it starts slower). They keep the last version that ran in a file of their own to tell; it holds no ID, the same on every device. The slow-start finding compares the two when both have 3+ sessions |
| `error` | `kind` (`js` \| `promise` \| `webgl_context_lost` \| `manual`), `message, stack, source, line, col, fn, fingerprint`. See below |
| `level_start` | `attrs` (optional): what describes the attempt (`{ tier: 'pit_80', party_size: 3, build: [...] }`), with a custom event's rules (12, strings cut to 64, lists); a level the SDK starts by itself has none |
| `level_complete` | `duration_s, score` |
| `level_fail` | `cause`. The cause `abandon` is reserved: such a fail is a `level_abandon` |
| `level_abandon` | `duration_s`, `reason` (`background`, `close`, `quit`, `pagehide`: the SDK sent it as the game went; `disconnect`: the connection dropped, A8; none when the game called it) |
| `disconnect` | the connection dropped (A8): `reason` (`timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect`, `other`; intake reads anything else as `other`), `connected_s`, `rtt_p95`, `loss_pct` (the window before it). At most 20 a session |
| `reconnect` | it came back: `after_s` |
| `server_window` | a game server's window (A9, server mode): `duration_s, ticks, tick_hz` (reached), `tick {sketch at 2%}, tick_p50, tick_p95, tick_max, late` (ticks over the budget), `budget_ms?, players, players_max, net_objects, in_kbps, out_kbps, cpu_pct` (of one core), `mem_mb, rtt_p95` (players' round trips as the server saw them), `ctx`. See below |
| `death` | `x, y, z, cause` |
| `pos` | `pts: [[ts, x, y, z], …]` (batched samples) |
| `custom` | `name, attrs`. See below |
| `map` | `axis, bounds, image` (JPEG data URL, ≤ 60 KB) |
| `session_end` | `reason` (`pagehide` \| `hidden_timeout`), `duration_s` |
| `bug_report` | `note` (typed by the player), `screenshot` (JPEG data URL, ≤ 200,000 characters; dropped when larger, keeping the note), `x, y, z`, `recent` (last game events), `frames` (the last windows' fps and p95), `device`. See below |
| `counts` | a window's counters (§1 `count`): `duration_s`, `dropped`, `counts: [{name, attrs, n, sums?, first_ts}]`. See below |
| `props` | `props: {key: value \| null}`: the session's properties that changed since the last one (null: removed). See below |
| `group` | `kind` (`match`, `party`, `run`), `id` (null: the group ended), `attrs?`, `resumed?` (a run carried on from a saved ID), `ended?` (the match a server hosting several ended). See below |

**`counts`.** One event a window for the streams a game counts rather than tracks (shots, hits, kills, gold, taps):
`ts` is the window's start, each entry a name, the words and flags it is grouped by (`attrs`, at most 4 strings or
booleans), how many (`n`), the numbers added up on the device (`sums`, at most 4) and when the first came
(`first_ts`). Intake drops an entry that breaks that shape, and the event when none is left. Each entry folds in as `n`
custom events of its name with those attributes would, its sums as those events' sums: so a counter is read by its
name everywhere an event is (a count, per hour played, a breakdown by its words, `sum`, `avg`, the `rate` of a flag),
except a distribution, since its values were added up before they were sent. A session keeps one occurrence per entry,
at `first_ts`, standing for its `n` events (§3b occurrences): a funnel step a counter reaches is reached at its first
one. Counters count as play (a rage quit, a crash with nothing played after it), and a breadcrumb shows a window's
counters once (`kill ×37, gold ×52`).

**`props`** (and `session_start.props`). What holds for the session in the game's words (§1 `setProperties`): the
mode, a rank tier, a class, the server region. Intake checks them again as the SDKs do and drops what breaks the rules:
keys of `^[a-z][a-z0-9_]{0,31}$`, at most 12, none of the built-in splits and filters (`version`, `level`, `env`,
`platform`, `browser`, `device_tier`, `session_type`, `privacy`, `role`, `link`, `type`, `players`, `sessions`,
`hours`, `zone`, `match`, `party`, `run`, the Steam facts) and none that names a person or a device (`name`, `email`,
`user_id`, `steam_id`, `ip`, `device_id`, `age`, `gender`…, §1); values a string (trimmed, cut to 64 characters), a
boolean or a whole number from −1,000,000 to 1,000,000, never shaped like an email address, a link, a phone number, a
run of 7+ digits, a UUID, 16+ hex characters or a random-looking run of base64. Each session keeps the latest value of
each key by time (`session_state.props: {key: [value, ts]}`), so it has one value per property however its events are
folded; splits, filters and findings read them (§3, §3b).

**Network** (A8). Each frame window the player was connected in carries `net` (§1). The cells add it up: a round-trip
sketch (a listen-server host's own windows left out: its round trip is zero), seconds connected, seconds over 150 ms
(each window's share of samples over it times its length: lag), loss and jitter weighted by samples, throughput, windows
per kind of connection, disconnects by reason and reconnects. A `disconnect` with a level open comes with
`level_abandon` reason `disconnect`: the attempt ends as an abandon (§4), never a fail or a rage quit, and the level
funnel counts it in `disconnects`; a player who reconnects and plays on takes it back, as one back from the background
does. Each session also keeps its disconnects (at most 20) and, per match it played, its ping per 30-second slot (the
lobby finding, §4).

**Server mode** (A9). A game's dedicated or authoritative server runs a Glitchless SDK in server mode (§1 Node server
SDK; §5, §5b, §5c): its envelope says `role: "server"`, with the game's own `service` and no player ID. Intake files
those batches under the game's companion service, `<service>.server` (§6), so everything that keys by service (cells,
session states, day rollups, players now) keeps a game's servers apart from its players and no players number takes in
a server. A server session counts as a session like any other (on Glitchless Cloud, toward the plan's sessions).
`session_start` carries `server: {tick_hz, max_players, build, region, host: {os, cores, memory_gb}}` (`region` in the
game's own words; never a host name or address); the cells add up `server_window`s (`sv`, §6), and each server session
keeps its windows per map and players connected, its memory and objects as gauges, its latest players, and its tick per
30-second slot of each match it hosts. A window is over budget when 5% or more of its ticks were late (its p95 over the
budget: `budget_ms` where the SDK sends it, else 1000 over the server's `tick_hz`). The game's dashboard, findings and
matches read the companion (§3 `servers`, §3b, §4).

**`group`.** A match (made by the game's server and shared by everyone in it), a party (until it breaks up; never a
guild or a friends list) or a run (made by the SDK, `r_` and 12 characters). Match and party IDs arrive hashed (`h_`
and 24 hex characters, §1) unless the game turned that off. Each session keeps its groups (`groups: [{kind, id, from,
to, attrs}]`, at most 32): from the first event that carried one to the last. A level start keeps its `attrs` and its
`run`, and the outcome, deaths and abandon after it belong to that attempt. Levels split by them (§3b `levels`), the
`matches` query lines a match's sessions up (§3), and a session's detail lists its groups.

**`GET /v1/health`** answers `features`, the genre additions intake folds: `counts` (counters), `props`, `groups`,
`zones`, `net` and `server_mode`. The SDKs send counters only to a server that lists `counts`, and a server-role
SDK sends nothing at all to one that doesn't list `server_mode`; an older server answers without `features`.

**`custom`.** `attrs` are the game's own words and numbers: a string (counted up to 64 characters), a boolean, a
finite number, or a **list** of them (`deck: ['hog_rider', 'fireball']`). A list counts its first 16 distinct elements
(strings cut to 64 characters) and is one of the event's 12 counted attributes; a list of objects or of lists is
stored and never counted, like an object. Each element of a list is a value the event *contains*: everywhere an event
is written (`battle_end:deck=hog_rider`, §3b) it matches an event whose list has the element, and a breakdown by the
list has a row per element. An outcome counts best as a boolean (`won: true`), a quantity as a number, and what a
match or run used as a list; what should be measured once a match or run goes on one event at its end (`match_end`,
`run_end`), since rates and distributions split by another attribute read each session's first 16 of an event (§3b).
A list holds the game's words, like any attribute: never a list of people (party members' names, friends).

**`error`.** `fingerprint` groups occurrences into one issue: the kind, the message (numbers of 3+ digits and hex
masked) and the function of the top frame, the first frame that isn't in a `glitchless*` file. File names are left
out, so a dev server's `fx.js` and a bundle's `index-3f2a.js` group alike. `stack` is the browser's own stack
string (at most 4,000 characters; Chrome, Firefox and Safari write it differently). In a minified web build the
top frame's function is a minified name that changes from build to build; when the build's source maps are
uploaded (§3d) the server stores the original `fn`, `source`, `line` and `col` instead, with a fingerprint on the
original function, and keeps what the SDK sent as `minified: {fingerprint, fn, source, line, col}`. The SDK
doesn't change.

**`bug_report`.** A player's report from inside the game. Reports are off until the game turns them on: in the
browser, `bugReports` in init options adds a hotkey (F8) and an overlay button that open a short form (a
screenshot preview, the note, Send and Cancel), and `reportBug()` sends one from the game's own UI. While the form
is open the game gets no keys, clicks, mouse or touch input (key releases still pass); `onOpen`/`onClose` let it
pause. Every SDK sends the same event:

| field | |
| --- | --- |
| `ts`, `level` | when the player opened the form (or called `reportBug`), and the level then |
| `note` | what the player typed, up to 2,000 characters. Free text: see each SDK's PRIVACY.md |
| `screenshot` | the game's view as a JPEG data URL of at most 200,000 characters. SDKs shrink it until it fits (960, 800, 640, 480, then 320 px wide, lower quality); the server drops a larger one, or one that isn't `data:image/`, and keeps the rest |
| `x, y, z` | where the player was, only when positions are on (as `death`) |
| `recent` | the last 20 game events and hitches, oldest first: `{ts, type, level}` plus whichever of `name, cause, kind, message, reason, duration_s, score, duration_ms, causes, x, y, z, attrs` the event had |
| `frames` | the last frame windows (up to 6, the one in progress last), oldest first: `{ts, level, fps, p95}` |
| `device` | the `session_start` device at the session's privacy level. Optional: without it the server shows the session's |

A report goes on a request of its own as soon as it is sent, from every session (`sampleRate` doesn't apply);
a failed send goes out with the next batch. Its id is a hash of project, service, session, `ts` and note, so a
batch sent twice stores it once.

Reports never join the events, rollups or summaries: each store keeps a small record (everything but the
screenshot) to list, and the screenshot apart, as it keeps level maps. FileStore: `reports.jsonl` and
`reports/<id>.jpg`, kept 14 days like events; another store (§7) keeps them as long as it keeps events. They are read
through the `reports` and `report` queries (§3), the Bug Reports view and `reports` panel (§3b), each session's
timeline (`{type: 'bug_report', ts, level, id, note, has_screenshot}`), a finding once a level has three in the
range (`reports-<level>`, quoting the notes), and the `glitchless_bug_reports` MCP tool. `DELETE
/v1/report?service=&id=` (the `delete` scope) removes one report and its screenshot. The live tail shows reports
without their screenshot, and exporters (Datadog, OTLP) don't send them.

`ft.sketch` is a DDSketch-style mergeable histogram of frame times (relative accuracy 2%):
`{ "a": 0.02, "b": { "<index>": count }, "n": totalCount, "z": zeroCount }` where
`index = ceil(log(ms) / log(gamma))`, `gamma = (1 + a) / (1 - a)`. The server merges sketches across
sessions to compute exact-within-2% global percentiles (never average percentiles).

## 3. Query API

`GET {api}/v1/query/{name}?service=zoomies&from={ms}&to={ms}[&version=][&env=][&level=][&steam_branch=]…`
Header `x-glitchless-api-key: …` when the server has a read key configured. Every query reads only the project
its key belongs to (§6); `service` picks a game inside that project. `type` keeps one session type (`user`, `tester`,
`synthetic`, `simulated`; `all`, the default, keeps every session): `type=tester` finds the TestFlight testers that
players' numbers leave out. Each Steam fact (§4c: `steam_branch`,
`steam_build`, `steam_hardware`, `steam_controller`, `steam_language`, `proton`, `big_picture`, `family_shared`,
`timed_trial`) is a filter too: `steam_branch=beta` keeps only the sessions that ran the beta (`meta.where` says so).
So is each session property (§2 `props`): `prop.<key>=<value>[,<value>…]` keeps the sessions with one of those
values (`prop.rank=diamond,master`; `(none)`: those without it), and `meta.where` lists it as `prop.<key>`. These read
the sessions, so over 31 days or less (Glitchless Cloud reads a longer range's last 31 days and says so in
`meta.note`).

| name | returns |
| --- | --- |
| `services` | `{services:[{service, versions[], envs[], last_seen, server?}], max_range_days}`: the longest range this store answers for the reader (the plan's retention on Glitchless Cloud; `null`: no limit). A game's servers (its companion service, A9) go under it as `server: {service, versions, envs, last_seen}`; a companion whose game sent nothing yet is listed with `server_of`. Without `service=`, queries read the game that sent last, never a companion |
| `overview` | `{kpis, series, top_errors, funnel, findings}`; `kpis.hours_played` is the hours the game was on screen (§4) |
| `performance` | `{distribution, by_level, by_gpu_tier, by_browser, by_version, by_platform, by_steam_branch, by_steam_build, by_zone?, hitches, memory, load, network?}`; the Steam breakdowns hold only sessions that sent the fact (§4c). `network` (A8, a game with network data): `{kpis: {ping_p50, ping_p95, lag_pct, loss_pct, jitter_ms, connected_h, disconnects, disconnect_reasons, reconnects, disconnects_per_hour, hours, disconnect_pct}, by_level, by_version, by_platform, by_link}`, each row `{key, …the same, sessions}`. `by_prop=<key>` adds `by_prop: {key, rows: [{key: value, sessions, all_sessions, p50, p95, p99, pct_over_budget, hitches_per_min, crash_free_pct, …}]}`: frame time and hitches per value of a session property from the sessions' own frame windows, crash-free sessions from every session with it, and `network.by_prop` the same network rows per value (ping by `region`) |
| `errors` | `{issues:[{fingerprint, message, kind, location, fn, source, line, count, sessions, players, first_seen, last_seen, first_version, versions, levels, stack, sample_session, breadcrumbs}]}`; for a web build with source maps (§3d), original frames with `frames` and `minified` |
| `players` | `{kpis, funnel, session_length, death_causes, rage_quits, retention}`. `funnel: [{level, sessions, players, completed, completion_pct, attempts, deaths, deaths_per_session, fails, abandons, abandoned, avg_complete_s, p50_complete_s, p90_complete_s, death_causes, rage_quits, rage_quit_pct}]`: `abandons` counts the attempts the player left (§2 `level_abandon`), `abandoned` the sessions that left the level without completing, failing or dying on it; `p50_complete_s` and `p90_complete_s` are the median and the slowest 1 in 10 of completed attempts' `duration_s` (clear times). `retention: {status, id_sessions_pct, new_players, d1, d7, d30, cohorts:[{day, players, d1, d7, d30, returned:{d1, d7, d30}}], first_seen}` (§4): cohorts oldest first, `dN` a percentage (null until day N has ended in the range), `returned` the counts; `d1`… over all cohorts that have one. `status` is `ok`, `anonymous` (no session in the range sent a player ID: nothing to count, not zero) or `empty`; `first_seen` is `index` (the store's first-seen index) or `range` (a store without one: new on the first day in the range). `by_prop=<key>` adds `retention.by: {key, rows: [{value, new_players, d1, d7, d30}]}`: each player in the value of the first session they started on their first-seen day (31 days or less). `by=` (an attribute of the level starts, `$<property>` or a session split), `level=` and `count=runs` add `funnel_by`: the `levels` panel's answer (§3b) |
| `players_now` | `{players_now, window_s, servers_now?}`: sessions of the game that sent anything in the last two minutes (§4), whatever the range; a game with servers adds `servers_now: {servers, players}` (its companion's live sessions and the players their latest windows had connected) |
| `servers` | A game's servers (A9), from its companion service: `{servers_now, players_on_servers, kpis: {servers, crashed, crash_free_pct, budget_ms, windows, hours, tick_p50, tick_p95, over_budget_pct, late_pct, tick_hz, players, players_max, cpu_pct, mem_mb, mem_max_mb, net_objects, rtt_p95}, series: {ts, tick_p50, tick_p95, players, servers}, by_level, by_version, by_players: [{value, lo, hi, windows, over_budget_pct, late_pct}], crashes: [{…error issue, crashed_servers, matches_ended, players_dropped}], memory, climbing, sessions}`; `by_players` in tenths of the servers' `max_players`. Any other query reads the companion itself with `service=<game>.server` |
| `matches` | The range's matches (A7): `{matches:[{id, from, to, duration_s, sessions, level, attrs, outcomes:{complete, fail, abandon, disconnect}, disconnects, disconnect_reasons, ping_p50, ping_p95, lag_pct, server:{sessions, tick_p95, players_max} \| null}], total, sort}`, the most recent first, or `sort=lag` (worst ping p95 first) or `sort=disconnects`; `limit` (at most 200). `id=` gives one: `{match:{…as listed, slot_s: 30, slots:[t], sessions:[{session_id, version, platform, props, level, outcome, from_s, to_s, disconnects:[{t, reason}], ping_p50, ping_p95, slots:[{t, fps, frame_p95, ping_p50, ping_p95, loss_pct, hitches, spike?}]}], server:[{session_id, slots:[{t, tick_p95, late, players, net_objects}]}], lobby_spikes:[t], events:[{t, session_id, type, level, name, reason?}]}}`, `t` in seconds from the match's first event. A slot is a `spike` for a session whose ping was twice its own median and 50 ms over it; a lobby spike when 60% of the sessions with network data (4 or more) spiked at once (§4). Read from raw events, the game's and its servers' (§6); Glitchless Cloud reads a longer range's last 31 days |
| `heatmap` | `{level, map, deaths:[{x,y,z,cause,version}], density:{…}, stats}` (requires `level`); `stats` is the level's funnel row plus `no_win`, true for a game nobody wins (§4), which has runs rather than a completion rate |
| `sessions` | `{sessions:[…]}` ; `session?id=` → `{session, events}` (its timeline includes its bug reports) |
| `reports` | Players' bug reports, newest first (at most 500): `{reports:[{id, ts, session_id, level, version, env, note, position: {x, y, z} \| null, device (one line), has_screenshot}]}`. Filters: `env`, `version`, `type`, `sessions`, the Steam facts |
| `report` | One bug report: `id=` → `{report:{…as listed, sdk, recent, frames, screenshot}}` (`screenshot=0` leaves the picture out), from any time the store still keeps; `{error}` if there is none |
| `versions` | `{versions:[{version, sessions, first_seen, first_seen_ever, crash_free_pct, frame_p95, level_completion_pct, rage_quit_pct, errors_per_session, …, board:[…], events:{name: per_session}}], has:{frames, levels, deaths, fails, geometry}, board:[{title, unit, metric, event, per, sum?, currency?}]}`. Versions come oldest first in release order (§4), so the last two are the newest and the one before it whatever the range; `first_seen` is a version's first session start in the range, `first_seen_ever` when the store first saw it (null when it can't say). `board` holds each version's value of the stats on the game's boards (each once, in the order of the top-level `board`, §3b); `unit` is `per session` for counts and sums compared per session, `per player` for a sum per player, `%` or a metric's unit, and a sum that is money has its `currency`; a rate is `%` (and carries `rate`), an average carries `avg`, a percentile `of` and `quantile` (in the panel's `unit`), and a count or sum per hour played is `per hour`, each over the version's own hours; `has` says which built-in measures the game reports. `by=steam_branch` (or `steam_build`) compares Steam branches or builds the same way instead (§4c): each row's `version` is the branch or build, `by` names the fact; builds come in build order, branches in the order the range first saw them. `by=<property key>` compares the values of a session property (class against class), the most sessions first, each value's rates, averages, percentiles and counts per hour played from its own sessions |
| `findings` | Ranked findings with evidence — what the MCP server hands to coding agents |
| `events` | The game's own metrics (`custom` events and counters): `{ts, sessions, hours, events:[{name, counted?, count, sessions, players, per_session, series, attrs:[{key, list?, values:[{value, count, sessions}], avg, p50?, p90?, p99?}], sums:[{attr, currency, sum, events}]}]}`. `counted: true` marks a name sent with `count()` (§2 `counts`): its numbers have sums and averages but no percentiles. `hours` is the hours played in the range (§4), to turn any count into a rate per hour. `properties: [{key, values: [{value, sessions, players}], identifier_like}]` lists the sessions' properties (§2 `props`), the top 40 values each; `identifier_like: true` marks one with more than 200 values on a day, which is an ID and splits as `(too many values)`. A list attribute says `list: true` and counts each element as a value (the events that have it, so they add up to more than `count`); a numeric one has its `p50`, `p90` and `p99` (§3b distributions). `sums` adds up each numeric attribute, per currency (null for events sent without one, §3b), the most sent first. `name=` keeps one event, `sdk=1` adds the SDKs' own; `funnel=open,paywall,buy=done` adds `funnel:[{step, sessions, pct_of_first, pct_of_previous, median_s_from_previous}]`. With `name=` (or `event=`, the same event with a filter such as `match_end:mode=ranked`) and `rate=` (`won`, or `result=win`) or `avg=` (a numeric attribute), it adds `measure`: the stat panel's answer, or with `by=` (and `min=`, `limit=`) the breakdown panel's rows; with `of=` (a numeric attribute, and optionally `by=`, `bins=`, `limit=`), `distribution`: the distribution panel's answer (§3b). A field that can't be read is a 400 saying what to fix |
| `dashboard` | The game's pages, in order: `{dashboard:{source, updated_at, updated_by, spec:{currency?, pages}, pages:[{id, title, icon, view, options} or {id, title, icon, panels: count}]}}`, `source` being `saved` or `auto` (§3b) |
| `board` | One board page with each panel's data: `page=` its id (default: the first board) → `{board:{page, title, source, updated_at, updated_by, spec:{panels}, panels:[…]}}`; a built-in view's id gives `{error, view}` |
| `store_reviews` | One store's reviews of the game (Steam, Google Play, the App Store), filtered, with counts by build, topic and device (§3f); `{connected: false}` without a store |
| `store_vitals` | One store's own measures of the game (Google Play's Android vitals, the App Store's hang, launch and animation metrics) by version, next to Glitchless's, with where they disagree (§3f) |
| `store_revenue` | A game's real revenue from RevenueCat (production purchases only) by UTC day and, where RevenueCat splits it, by version, with installs (new customers), active users, MRR, active subscriptions and trials (§3h); or from its own Stripe account (`store=stripe`), with refunds, disputes, fees, net, new paying customers, by product, and by version for purchases tied to a session (§3i); next to the sessions, players, new players and purchase events Glitchless measured; `{connected: false, why}` for a game without it |

### 3b. Dashboards and boards

Every game gets a dashboard that fits it (`server/src/board.js`): its list of pages, in the order the sidebar shows
them, the first opening first. A page is a board (`panels`, below) or one of the built-in views (`view`: events,
performance, errors, players, heatmaps, sessions, versions, live, reports, servers, matches), which a game keeps, renames, reorders or drops:

```json
{ "currency": "USD", "pages": [
  { "id": "overview", "title": "Overview", "icon": "overview", "panels": [ … ] },
  { "id": "money", "title": "Paywall", "icon": "bolt", "panels": [ … ] },
  { "id": "purchases-live", "title": "Purchases, live", "view": "live", "options": { "events": ["paywall", "buy"] } },
  { "id": "errors", "title": "Errors", "view": "errors" }
] }
```

`id` (default: from the view or the title) is the page's address, `#/<id>`; `icon` is one of board, overview,
events, perf, errors, players, heatmap, sessions, versions, live, flag, bolt, play, clock, bug, money. At most 20 pages and 24
panels a board. A built-in view a dashboard leaves out still opens from links (`#/errors/<fingerprint>`,
`#/sessions/<id>`, `#/reports/<id>`). The live view takes `options.events`: names or types to show. The reports view
(Bug Reports) lists what players sent, newest first, with each screenshot, its session's replay (opened at the
report's moment) and the events and frame rate before it.

A dashboard is saved per game: `GET /v1/dashboard?service=` needs the read scope; `PUT /v1/dashboard?service=` with
`{currency?, pages}` and `DELETE` (back to the automatic dashboard) need the `dashboard` scope. `currency` (an ISO
4217 code such as `USD`) is the game's one currency for money (below). A game without a saved one gets
the automatic dashboard, made from the data it sent in the last week: an Overview board (the stats every game has,
findings, its own events, then levels, frame time, errors and deaths only if it reports them), then Events if it
sends custom events, Performance if it sends frame times, Errors, Bug Reports if players sent bug reports, Players,
Heatmaps if it sends positions, Sessions, Versions and Live Tail. Versions are compared on the stat panels of every board.

**Branding** ([`server/src/brand.js`](../server/src/brand.js)). A game can have an accent colour, a logo and a banner
(its key art) on its boards and their share links, kept apart from the dashboard spec. `GET /v1/brand?service=` (read
scope; a share link reads its own game's) answers `{service, brand}`: null, or `{accent, logo, banner, updated_at,
updated_by}`, where `logo` and `banner` are null or `{url, type, width, height, bytes, hash}` and the banner also has
`focus` (`top`, `center` or `bottom`: the part kept in view when it is cropped to a strip). `url` names the image's
hash, so a new image gets a new address. `PUT /v1/brand?service=` with `{accent?, banner_focus?}` (`accent` is
`"#rrggbb"` or null), `PUT /v1/brand/logo?service=` and `PUT /v1/brand/banner?service=` with the image itself as the
body, and `DELETE` on each (on `/v1/brand`: all of it) need the `dashboard` scope (on Glitchless Cloud: Owners,
Admins and Developers). An image is checked by its content, never its name or declared type: PNG, JPEG or WebP only,
never SVG or HTML (415); a logo is at most 100 KB and 1024 × 1024 pixels, a banner 300 KB and 4096 × 2048 (413, 400).
The dashboard fits a logo inside 256 px and crops a banner to 1600 × 400 around its focus, in the browser, as WebP.
`GET /v1/brand/logo` and `/v1/brand/banner` answer the image with its own type, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox` and, at its current hash, `Cache-Control: private,
max-age=31536000, immutable` (`no-cache` at another). The dashboard shows the banner behind the board's title with a
dark scrim, so the title reads on any picture in either theme (a short strip on a phone), the logo by the game's name,
and the accent on links, the selected page, stats, the map's installs and the main chart series (not when it is close
to one of the other series' colours), darkened or lightened in each theme to 3:1 on a panel (4.5:1 for links). Agents
set the accent with `glitchless_set_dashboard`'s `accent` and see the brand in `glitchless_dashboard`; people upload
the images in Edit pages → Look.

| panel `type` | fields | shows |
| --- | --- | --- |
| `stat` | `metric` (sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct, players_now, hours_played, runs, ping_p50, ping_p95, loss_pct, disconnects_per_hour, disconnect_pct, servers_now, server_tick_p95, server_crash_free_pct, players_per_server) or `event`, optional `per`, optional `sum`, or `rate` (with `expect`), `avg`, or `of` with `quantile` (and `unit`) | one number; `event` per another event is a percentage; per `$players` or `$sessions`, the share of them that sent the event (conversion). With `sum`, the attribute added up (revenue), per `$players` or `$sessions` divided by them (revenue per player). Per `$hours`, a count or sum per hour played (below); the `deaths` and `errors` metrics take it too. `rate` and `avg`, the event's rate (with its interval) or average (below); `of` with `quantile`, one percentile of a numeric attribute (the median match, below). `players_now` is the sessions playing now, whatever the range, and is left out of version comparisons |
| `series` | `event`, optional `by`, `limit`, `sum`, `rate` or `avg`, `per` (`$hours`) | the event's count (or its `sum`, rate or average) over time, split by an attribute's top values; `by` can also be `$version`, `$level`, or the sessions' `$platform`, `$browser` or `$device_tier` (below; counts only) |
| `breakdown` | `event`, `by`, `limit`, `sum`, or `rate` or `avg` with `min`, `expect` and `order`; `per` (`$hours`) | the attribute's values with counts and sessions, or with each value's `sum`, largest first (revenue by item), each value's rate or average (below), or each row per hour played; `by` can also be a Steam fact of the sessions that sent the event (`$steam_branch`, `$steam_build`, `$steam_hardware`…, §4c), with `(none)` for sessions without it, or the sessions' `$platform`, `$browser` or `$device_tier` (below). By a list attribute, a row per element (below) |
| `distribution` | `event`, `of`, optional `by`, `limit` (rows, at most 8, default 5), `bins` (bars, 2 to 40, default 20), `unit` | how a numeric attribute spreads: percentiles and a histogram, and with `by` a row per value (below) |
| `funnel` | `steps` | sessions through the steps, in order |
| `levels` | `label`, `by`, `level`, `count` | starts, completion, fails, deaths, disconnects and times per level (the median clear time and the slowest 1 in 10, from completed attempts); columns only for what the game reports. `by` splits each level's attempts: an attribute of their `level_start` (`tier`; a list counts under each element), a session property (`$class`) or a session split; `level` keeps one level's rows; `count: "runs"` counts each run once at each level it reached (below) |
| `frame_time`, `errors`, `deaths`, `events` | `limit` (errors), `by` and `level` (deaths, as on `levels`) | frame-time p50/p95, top errors, deaths by level and cause (with `by`, per level and value), every custom event |
| `findings` | `limit` | the ranked findings |
| `sessions` | `sent`, `limit` | recent sessions, or only those that sent an event, each opening its replay |
| `store_reviews`, `store_vitals`, `store_players`, `store_sales` | `store` | for a game connected to a store (Steam, Google Play, the App Store, §3f): reviews over time and by build with what was measured on each, the store's vitals by version next to Glitchless's, players online next to the sessions measured, units, returns and wishlists by day |
| `store_score` | `store` | a store's rating (§3f): the average stars of the written reviews synced in the window and how many, next to the store's own rating where it has one (the App Store's, from Apple's lookup; Steam's summary); Google Play's is the synced reviews' average, and says so |
| `store_revenue` | `measure`, `store`, `show` | for a game connected to RevenueCat (§3h) or Stripe (§3i): its revenue in the window, revenue per player measured, installs or active users next to Glitchless's new players and players, MRR, active subscriptions or trials, revenue per day, installs and active users per day, revenue by version next to what Glitchless measured, installs and revenue by country on a world map with a ranked list (`by_country`; `show` installs or revenue first), or revenue by store next to the sessions on its platform (`by_store`); Stripe's refunds, new paying customers, revenue by product (§3i; no installs, MRR, subscriptions, trials or stores) |
| `reports` | `limit` | the latest bug reports players sent, each opening its report |
| `net` | `show` (`ping`, `loss` or `disconnects`; default `ping`), `by`, `limit` | network quality (A8, below): ping p50 and p95 over time with the share of connected play over 150 ms; loss and jitter; or disconnects per hour played by reason. With `by` (`$version`, `$level`, `$zone`, a session split such as `$link` or `$platform`, or a property such as `$region`) a row per value |
| `servers` | `show` (`ticks`, `players` or `crashes`; default `ticks`), `by` (`players`, `$level`, `$version`), `limit` | a game's servers (A9, from its companion service): tick time against its budget over time and by players connected (in tenths of capacity), map or version; players connected; or server crashes with the matches and players each ended |
| `retention` | `limit` (days, 1 to 90; default 14), `by` (a session property) | D1, D7 and D30 by first-seen day (§4), the latest days; with `by` (`$spender`), each value's too (`by: {key, rows: [{value, new_players, d1, d7, d30}]}`, 31 days or less); a game that sends no player IDs gets `anonymous: true` and a line on turning install mode on |
| `versions` | `by` | the board's own stat panels, version by version in release order (§4; rows `{version, sessions, first_seen, first_seen_ever, values}`); with `by` `$steam_branch` or `$steam_build`, Steam branch by branch (the beta against `public`) or build by build; with `by` a session property (`$class`), value by value |
| `live` | `events` | events as they arrive, optionally only these names or types |
| `positions` | `level`, `show` (`deaths`, `path` or `both`; default `deaths`), `bin` | where players died on one level, and where they went, as counts per bin (below) |

A board page can carry `where`: session properties (§2 `props`) its sessions must have, a value or a list of up to 20
each (`"where": { "$rank": ["diamond", "master", "grandmaster"] }`, at most 4 properties). Every panel on the page reads
only those sessions, as the query filter `prop.<key>=` does (§3), and the page's answer says so in `meta.where`.

Every panel takes `title`, `note` and `size` (`s`, `m` or `l`). An event is written like a funnel step: `name`,
`name=value` (any attribute) or `name:key=value`. A list attribute matches when it has the value, and `name:key=a+b`
when it has all of the values (up to 8; "contains all of": any pair or trio of cards, read from the occurrences,
below; in a query string, write the `+` as `%2B`). A panel with no data in the window says why instead of showing
zeros (the first sentence of a long reason; the rest behind the info icon).

The dashboard (`apps/dashboard/src/pages/Board.jsx`) shows each panel's title, its number or chart and at most one
short line (what it adds up to: "323 sessions", "93 transactions on RevenueCat"). The `note`, what the numbers are and
how they were counted, the store's or revenue source's `notes` and anything left out of a sum sit behind an info icon
next to the title, which opens on hover, on keyboard focus and on a tap. The board query and the CSV carry all of it.
A panel's CSV button shows while the panel is pointed at or has focus (always, on a touch screen). `s` is a quarter
of the row, `m` half and `l` all of it; on a board narrower than 840 px stats go two to a row and the rest full width,
and under 520 px (a phone) every panel is full width. Panels keep their order and are packed: each goes at the highest
place it fits that isn't above the panel before it (nor to its left at about the same height), so a short panel
doesn't stretch to the tallest beside it and the next ones fill in under it; panels side by side whose heights are
within about 36 px are made the same height. Share links lay boards out the same way. The dashboard is light or dark: the viewer
picks System, Light or Dark at the foot of the side navigation (kept in the browser, `glitchless.theme`), and a share
link always follows the viewer's system.

**Levels by attempt** (`server/src/levels.js`). A level start keeps its attributes (§2 `level_start.attrs`), and the
outcome, deaths and abandon after it belong to that attempt. With `by`, the `levels` panel's rows are per level and
value (`{level, value, sessions, players, completed, completion_pct, attempts, deaths, fails, abandons, abandoned,
disconnects, avg_complete_s, p50_complete_s, p90_complete_s, death_causes, rage_quits}`): clears and wipes by
difficulty, by group size, by class. An attempt without the attribute is `(none)`. `count: "runs"` adds `runs`: the
run IDs (§2 `group`) that started each level, each once however many sessions it spanned (a roguelite's runs that reach
each biome); a start without a run counts as its session's. The stat metric `runs` counts every run in the range. Over
31 days or less from the sessions; past that, day rollups keep each level's funnel by the first 3 attributes of its
starts (20 values each a day, the rest `(other)`, named in `meta.approximate`), and a split by anything else says it
needs 31 days or less.

**Network** (`server/src/network.js`, A8). The `net` panel answers `{show, ts, kpis, …}` with, for `ping`, `p50`, `p95`
and `lag_pct` per bucket (`lag_ms`: 150); for `loss`, `loss_pct` and `jitter_ms` per bucket; for `disconnects`,
`reasons: [{reason, count, per_hour}]` and `disconnects` per bucket; and with `by`, `rows: [{value, ping_p50, ping_p95,
lag_pct, loss_pct, jitter_ms, connected_h, disconnects, disconnect_reasons, disconnects_per_hour, hours,
disconnect_pct, sessions?}]`. By `$version`, `$level` or `$zone` from the cells (any range); by a session split or a
property from the sessions' own windows (31 days or less). `$link` splits sessions by the kind of connection they played
most of their connected time on: `Wi-Fi`, `Mobile data`, `Wired` or `Unknown connection`. The metrics `ping_p50`,
`ping_p95` (ms), `loss_pct`, `disconnects_per_hour` and `disconnect_pct` (the level attempts a disconnect ended; a game
without levels: the connected sessions that dropped) work on stat panels and version by version.

**Servers** (`server/src/servers.js`, A9). The stat metrics `servers_now` (live: the game's servers that sent anything in
the last two minutes, with `players` connected to them), `server_tick_p95` (with `budget_ms`), `server_crash_free_pct`
and `players_per_server` (the average connected per server window), and the `servers` panel, read the game's companion
service; they stay out of version comparisons. The built-in Servers view (`view: "servers"`; in the automatic dashboard
for a game whose servers sent data) shows the `servers` query (§3): tick time by map and by players connected, crashes
with their stacks and the matches they ended, versions, and long-running servers whose memory or objects climb. The
Matches view (`view: "matches"`; automatic for a game that sends groups) lists the range's matches (§3 `matches`), the
worst by lag or disconnects on request, each opening its match page (`#/matches/<id>`): every session's frame time and
ping slot by slot from the match's start, the server's ticks under them, outcomes and disconnects, and the slots where
the whole lobby lagged.

**Zones** (decision 6). `$zone` splits series and breakdowns (counts, sums, rates, per hour played) and distributions
the way `$level` does: the cells are kept per zone as well as per level (only for games that set one), so zones are
exact over any range. The `performance` query adds `by_zone` (frame time per zone; its sessions are null, as the cells
carry no session IDs).

**By a session property** (`server/src/properties.js`). `by: "$<key>"` works wherever `$platform` does: series and
breakdowns (counts, rates and averages, per hour played), distributions, `retention` and `versions`. Each session is
its value of the property (the latest it set, §2), `(none)` without one. A split shows the top 40 values and the rest
as `(other)`; a property with more than 200 values on one day is an ID, not a property, and every value reads as `(too
many values)` (the events query marks it `identifier_like`). Nothing is kept per property ahead of time: a split reads
the sessions, so over 31 days or less, as the platform split does.

**By platform, browser and device tier** (`sessionsBy` and `SESSION_SPLITS` in `server/src/analytics.js`). `by` on a
breakdown or a series can split the sessions themselves, each by its `session_start.device`, in plain words:

| `by` | each session's | values |
| --- | --- | --- |
| `$platform` | platform, as the Performance view's (`platformOf`) | Valve's hardware whatever the OS (`Steam Deck`, `Steam Machine`, `Steam Frame`), else the OS as the SDKs name it: `Windows`, `macOS`, `Linux`, `iOS`, `Android`, `SteamOS`, `ChromeOS`, `Web` (an engine's web build)…; other spellings of these (`Mac`, `OSX`, `X11`, `HTML5`) read as them; `unknown` without one |
| `$browser` | browser (`device.browser`, the Performance view's `by_browser`) | the browser SDK's `Chrome`, `Safari`, `Firefox`, `Edge`, `Opera`, `Other`; the engine SDKs send their engine there, so their sessions are `Godot app`, `Unity app`, `Unreal app`, `GameMaker app`, or `<engine> web build` when the OS is the web (its browser unknown) |
| `$device_tier` | GPU tier (`device.gpu_tier`, the Performance view's tiers) | `High-end GPU`, `Mid-range GPU`, `Low-end GPU`, `Software rendering (no GPU)`, `Unknown GPU`, in that order (other splits: most first) |

With an `event`, a split counts that event from each group's sessions (a breakdown's rows: `{value, count, sessions,
players}`; `players` is null when the game sends no player IDs), and a series places each session's events where the
session kept their time: a session keeps the first 16 of an event (above), so the rest of a session that sent more are
spread evenly over the minutes it played after the 16th, and the panel's `spread` says how many. Without an `event`, a
breakdown counts the sessions in each group and their players (`counts: "sessions"`; `total`, and `players`, each
player once, with player IDs), and a series the sessions playing in each time bucket. Either answers `split`: what
the groups are, in words (`platform`, `browser`, `device tier`). Counts only: a `sum` can't be split this way (sums are
kept per minute, not per session; for money by store, `store_revenue` `by_store`). Read from the sessions, so over 31
days or less; a longer range says so.

```json
[ { "type": "breakdown", "by": "$platform", "title": "Players by platform" },
  { "type": "breakdown", "event": "purchase", "by": "$platform", "title": "Purchases: iOS vs Android" },
  { "type": "breakdown", "by": "$browser", "title": "Which browsers they play in" },
  { "type": "series", "event": "play", "by": "$device_tier", "title": "Plays, by GPU tier" } ]
```

**Positions** (`levelPositions` in `server/src/analytics.js`). A `positions` panel answers

```json
{ "level": "cave", "axis": "xy", "bounds": { "min": [0, 0], "max": [300, 20] }, "bin": 2,
  "deaths": [[101, 13, 6], [137, 13, 4]], "total": 10, "truncated": false,
  "path": { "bin": 5, "cells": [[2.5, 7.5, 2], …], "samples": 60, "truncated": false } }
```

`a` and `b` are world coordinates on the level's plane: `axis` is the captured map's, else `xz` (top-down) once
positions or deaths leave z = 0, else `xy` (a side view; side-scrollers send z ≈ 0), as the Heatmaps view decides.
Each row of `deaths` is a bin's centre and how many deaths fell in it, the busiest first, at most 2,000 (`truncated`
says if more were left out); `total` is every death placed on the level (deaths sent without x and y can't be).
Bins are squares `bin` world units wide on a fixed grid, so a bin stays where it is as players come and go; without
`bin` it is 1, 2 or 5 times a power of ten near a hundredth of the level, and changes as the level fills in. With
`show` `path` or `both`, `path` counts position samples (`setPosition`) the same way on a coarser grid (about 64
bins across, never finer than `bin`); `show: "path"` leaves `deaths`, `total` and `truncated` out. `bounds` are the
captured map's, else the data's rounded out to whole bins. Nothing in the answer names a session, player, version
or time. A level with nothing to place says why (`{empty: true, why}`). Stores that keep summaries read the paths
apart, for the levels a board draws paths of (Glitchless Cloud: the last 31 days of a longer range, which
`meta.note` says).

Custom events are counted in the per-minute cells (by name, and by name, attribute and value; a list's elements apart,
by name, list and element) and in the session states (the first 16 occurrences of each name with their attributes
and level, for ordered funnels and the occurrences above; a counter's entry is one occurrence that stands for its `n`
events, and what reads occurrences weighs it so), so every event store answers the same. Names, attributes
and values are the game's own, so each is capped: 200 names and 400 values a minute, 1,000 list elements a minute, 64
names a session and 40 values per attribute (a list's elements among them). Past a cap the rest is counted as
`(other)`.

**Sums, purchases and money** (`server/src/sums.js`). The per-minute cells also add up every numeric attribute of
custom events, in fixed point (thousandths): per name, attribute and currency (`[sum, events]`), and the same per
string or boolean attribute value of the event (revenue by item, by store). Hour summaries and daily rollups merge
the cells, so a sum is exact over any range and every store gives the same one. At most 400 sums of each kind a cell;
past that the rest goes under `(other)` and a daily answer names `event_sums` in `meta.approximate`. Cells written
before sums existed carry none, so sums start from then.

Purchases follow one convention in every SDK: `track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })`.
An event's `currency` (upper-cased) keeps each currency's sums apart, and a sum is money when its events carry one.
A game has one currency: the dashboard's `currency`, else the one most of its events were sent in. Events without a
currency count in it; amounts in another currency are never added in: a money panel answers `currency` and lists
them in `mismatch: [{currency, sum, events}]`. A sum of events that never carry a currency (coins, seconds) is a
plain number. The dashboard shows money with the currency's symbol and two decimals.

**Sandbox purchases.** A purchase made where the store charges nothing (TestFlight, a build from Xcode, a store's
test account) says `sandbox: true`. The engine SDKs add it themselves on iOS, to an event named `purchase` or one that
carries a `currency`, when the install is a TestFlight or development one (§4b); a game adds it on any platform from
what its billing library says (RevenueCat's `isSandbox`, a Play licence tester's test purchase). Such an event is counted
like any other (conversion, breakdowns, `purchase:sandbox=true`), but its numbers are never added into sums, so
revenue leaves it out whatever the filters; a money panel says how many it left out (`sandbox`, the event's count with
`sandbox` true, when the panel's event is unfiltered). Only money is a sandbox purchase: `sandbox: true` on an event
that isn't named `purchase` and carries no currency (a game's own sandbox mode) keeps its sums.

```json
[ { "type": "stat", "event": "purchase", "sum": "amount", "title": "Revenue" },
  { "type": "stat", "event": "purchase", "sum": "amount", "per": "$players", "title": "Revenue per player" },
  { "type": "stat", "event": "purchase", "per": "$players", "title": "Players who bought" },
  { "type": "breakdown", "event": "purchase", "sum": "amount", "by": "item", "title": "Revenue by item" },
  { "type": "series", "event": "purchase", "sum": "amount", "by": "$version" } ]
```

A stat with `sum` answers `{value, currency, mismatch?, events}`, or with `per` `{value, currency, total, base}`; a
conversion `{value, unit: '%', count, base}`. A sum split `by` an attribute takes the event by name only (the cells
add up one attribute value at a time); by `$version` or `$level` it can be filtered (`purchase:store=ios`). Over
more than 31 days, players who sent an event are counted per name (a conversion per `$players` of `purchase=gems`
says so instead of answering); `$sessions` always answers. In a version comparison a sum is per session unless its
`per` says per player.

**Per hour played** (`server/src/rates.js`). `per: "$hours"` divides a count or sum by the hours played (§4): kills,
matches or runs per hour played, XP or gold per hour played. A stat answers `{value, unit: 'per hour', count, hours}`
(with `sum`: `total` in place of `count`, and the money fields). A series divides each bucket by the hours played in
it, and answers `hours: [...]`; by `$version` or `$level` each line divides by its own hours, by an attribute every
line by all of them. A breakdown's rows add `per_hour` and `hours`: by `$version`, `$level`, a session split or a Steam
fact each row over its own hours, by an attribute every row over the window's (gold from each source per hour played,
which add up). A bucket or row with under 6 minutes of play has no rate (`null`, and a stat says why), so near-empty
ones don't spike. A versions panel compares a per-hour stat version by version, each over its own hours. In words:
"1,240 XP per hour played".

**Rates and averages** (`server/src/rates.js`). `rate` is the share of an event's events for which something holds:

- a flag, `"won"`: a boolean, or a number that is only ever 1 or 0 (Unreal sends numbers until its booleans ship;
  both count together). The share is of the events that carry it. The cells count booleans per value of the event's
  other string and boolean attributes and per element of its lists (and sum numbers the same way), so a flag's rate
  is exact over any range: overall, by `$version` and `$level`, and by another attribute or a list's element.
- a word outcome, `"result=win"`: the share of the events that carry `result` (a list: of all the event's events)
  with that value. Exact overall and by `$version` and `$level`; split by another attribute it reads the occurrences
  (below), since the cells never count two attributes together. Send outcomes as booleans where you can.

`avg` is a numeric attribute's mean per event, exact from the same sums. By a session split or a Steam fact both come
from the sessions' own counts of their events' values (over 31 days or less); a filtered event split by anything but
its version or level, and a split by a numeric attribute (heat 0 to 8), read the occurrences.

A `stat` answers `{value, unit: '%', events, low, high}` (`low` to `high`: the 95% Wilson interval, in percent; with
`expect`, `off` when the interval leaves it out) or `{value, events}` for an average. A `breakdown` answers `{overall,
events, rows, more, small, line, list?, estimated?, from}`: each row `{value, rate, low, high, events, sessions, off}`
(an average: `{value, avg, events, sessions}`); `overall` is the rate or average of all the event's events, the normal
value to read each row against; `line` is `expect` (a percentage the game intends or publishes, such as a gacha's
odds: 0.6 for 0.6%) or else `overall`, and `off` marks a row whose interval misses it. Rows with fewer than `min`
events (default 30 for a rate, 10 for an average) are left out and counted in `small: {rows, events, min}`. `order` is
`rate` (the default; `avg` too: the highest first), `count` or `value` (the values' own order: heat 0, 1, 2). A `series`
gives the rate or average per bucket, overall or one line per value `by` `$version`, `$level` or an attribute. Rates
keep one decimal, two under 10% (`0.41`). `from` says where the numbers came from: `cells`, `sessions` or
`occurrences`. The dashboard draws each row as a bar with its interval as a whisker and the line across the rows; a row
whose interval misses the line takes the accent. In words: "Ember wins 54% of 1,240 matches (all heroes: 50%)".

**Distributions** (`server/src/distributions.js`). A `distribution` panel answers `{count, p50, p90, p99, min, max,
mean, whole, histogram: [{lo, hi, count}], under, over, partial?, estimated?, from}`, and with `by` also `rows:
[{value, count, p50, p90, mean}]` (the most events first) and `more`. The histogram's bars are equal steps of a round
size (1, 2 or 5 × 10ⁿ) from the 1st to the 99th percentile; `under` and `over` count what falls outside, and when
every value is a whole number (placements, floors) the edges are too (`whole`). `count`, `mean`, `min` and `max` are
exact. A `stat` with `of` and `quantile` (1 to 99) answers `{value, unit, count}`, and a versions panel compares it.
The cells sketch each event's numeric attributes at 5% relative accuracy (below), so a whole distribution, and one by
`$version` or `$level`, is right to within 5% over any range. Split by an attribute, a session split or a Steam fact,
or for a filtered event, the values come from the occurrences: exact (not sketched). In words: "Half of matches end
within 14 minutes, and 1 in 10 lasts over 26". The answer's histogram is `histogram`, not `bins`, so it never takes
the place of the panel's own `bins` (how many bars).

**Lists.** A breakdown by a list attribute has a row per element: `{value, count, sessions, share}`, the events whose
list has it and `share`, their percentage of the event's events; the rows add up to more than the events, and the
answer says `list: true` (the dashboard's line: each event counts once under each value it has). With `rate`, `avg` or
`sum` each element gets its own number from the cells: "decks with Hog Rider win 53% of 4,100 battles (all decks:
50%)".

**Occurrences** (`server/src/occurrences.js`). Each session keeps the first 16 of each event with all their attributes
(§6). What needs two attributes at once reads them: a list that contains all of several values, a word outcome's rate
by another attribute, a filtered event split by another attribute or a session split, and distributions split by an
attribute or a session split. That is exact while no session sent more than 16 of the event; a session that sent more
has its 16 stand for all of its events, weighted, and the answer says from how many sessions it was `estimated`. Over
more than 31 days they come from each day's sample of 256 sessions (§7), weighted, and `meta.approximate` names
`event_occurrences`. So what a game wants measured belongs on one event per match or run, not on every hit.

```json
[ { "type": "stat", "event": "match_end", "rate": "won", "title": "Matches won" },
  { "type": "stat", "event": "match_end", "of": "duration_s", "quantile": 50, "unit": "s", "title": "Median match" },
  { "type": "stat", "event": "gold", "sum": "amount", "per": "$hours", "title": "Gold per hour played" },
  { "type": "breakdown", "event": "match_end", "by": "hero", "rate": "won", "min": 100, "title": "Win rate by hero" },
  { "type": "breakdown", "event": "battle_end", "by": "deck", "rate": "won", "min": 200, "limit": 20, "title": "Win rate of decks with each card" },
  { "type": "breakdown", "event": "pull", "by": "banner", "rate": "top", "expect": 0.6, "title": "Top-rarity rate by banner" },
  { "type": "distribution", "event": "queue", "of": "wait_s", "by": "mode", "unit": "s", "title": "Time waiting for a match" } ]
```

**Findings from boards** (`server/src/board-findings.js`). Findings also read the rates, per-hour sums and
distributions on the game's saved boards, whatever its genre: `balance-<event>-<attr>-<value>` (a row of a rate
breakdown with 500 or more events whose interval leaves out the overall rate ± 5 points), `expect-<event>-<value>` (a
rate, or a row, whose interval misses the board's `expect`: it says what was measured against what the board expects,
at medium severity, and passes no verdict on published odds), `economy-<event>-<version>` (a sum per hour played that
moved 50% or more between the last two versions, each with an hour played and 30 events, with the attribute value that
moved most) and `shift-<event>-<attr>` (a distribution's median or p90 that moved 30% or more between the last two
versions, each with 30 values). Each says what happened in plain words with the normal value next to it, and links to
its board.

**CSV.** Every board panel with data, and the tables of the Errors, Sessions, Events, Players and Versions views,
download what they show as `<game>-<panel>-<from>-<to>.csv` (UTC minutes, `2026-10-23T1530Z`), built in the page from
the data it already has: a header row with the columns on screen, times in ISO 8601, durations in seconds, money
in its currency's units. A shared board exports only what it shows. (`?format=csv` on tabular queries may come
later.)

### 3c. Share links

A read-only link to one board page of one game, for a dev log, a Discord server or a publisher: anyone who has
it sees that board without signing in, and nothing else. Glitchless Cloud makes the links; the core enforces what
they read for any reader its auth hook marks with `share` (§6), so a self-hosted control plane can offer them too.

**Making one.** On Glitchless Cloud, members who may manage the game (Owner, Admin, Developer) press Share on a
board, or call the control API:

| route | does |
| --- | --- |
| `POST /api/projects/{p}/shares` | `{service, page, pageTitle?, name?, days?, from?, to?, sums?}` → `{share, token, url}`. `days` is 1, 7, 30, 90 or 365; without it the link lasts until it's revoked. `from` and `to` pin the window it shows (below). `sums: true` shows the board's sums such as revenue, which a link leaves out otherwise. At most 25 live links a game |
| `GET /api/projects/{p}/shares` | the game's links: `{id, name, service, page, pageTitle, hint, status, from, to, sums, createdAt, createdBy, expiresAt, revokedAt, lastUsedAt}`, `status` being Active, Expired or Revoked, `from` and `to` (ISO times) the pinned window or null, `sums` whether it shows sums, and `lastUsedAt` when it was last opened (below) or null |
| `DELETE /api/projects/{p}/shares/{id}` | revokes it: at once on the server that revoked it, within 15 s on the others |

The link is `https://app.glitchless.gg/s/gl_share_…` (32 base64url characters after the prefix). Like a
secret key it is shown once: the control table keeps its SHA-256 and the last four characters.

**Previews.** Posted on X, Slack or Discord, a link shows its own card. `/s/<token>` answers crawlers with the board's
title (the game and the page), a line of its stats for the last 7 days (a pinned link's own dates) and
`/s/<token>/card.png`: a 1200 x 630 image of the game, the page, its first four numbers (stats, a store's revenue
or counts, a store's rating out of 5) and its first chart (a series panel, else frame time), with Glitchy, drawn as SVG and turned into a PNG with resvg (WebAssembly). Both read the
board exactly as the link does, so they show nothing the link doesn't; a revoked or expired link gets the site's
card and no numbers. People are sent on to the board at `/#/share/<token>`, which links made before `/s/` still
open.

**Players only.** A link's board counts the sessions of players: `session_type` user (no bots, playtests, store
test phones or TestFlight testers) and, when the game has a `prod` environment, only that one (no dev builds), as
findings read them.

**Rolling or pinned.** A link without `from` and `to` shows the last days, from whenever it's opened: the viewer
picks the past hour up to the past 30 days. A pinned link always shows its own window, such as a jam's week for a
dev log that judges read two months later. `from` and `to` are times in ms or ISO strings; a date without a time
is that whole UTC day, so `{from: "2026-11-12", to: "2026-11-16"}` is five days. Both or neither; the window is at
most 30 days and falls between 400 days ago and a year from now. A pinned window still stops at what the reader's
plan keeps, counted back from now, so once those days have aged out the board shows nothing for them.

**Reading.** The token goes in `x-glitchless-share` (or `?share=`). The reader hook answers
`{projectId, scopes: ['read'], share: {service, page, from?, to?, sums?}, keyId, rps}` (`from` and `to` in ms for a
pinned link; `sums: true` for one made with sums). A link outranks a session cookie, so a member
who opens one sees what everyone sees. A share reader may only:

- `GET /v1/query/board`, for its page, and
- `GET /v1/query/services`, which lists its service only, with `max_range_days` at most 30 and `window`: a
  pinned link's `{from, to}`, or null, and
- `GET /v1/brand` and its images (§3b), for its service; their answers are kept for a minute, as its board's are.

Everything else is 403: other pages, services and queries, `/v1/live`, `/v1/dashboard` and `/v1/data`. The
request's parameters are replaced by `service`, `page`, `from` and `to` (a pinned link's own, whatever the request
asked), with `from` no earlier than 30 days before `to`, so env, version, session-type and session-id filters never
reach the query. A rolling link's request may give `from` and `to`, or `days` (1 to 30, default 1): the last days up
to the last whole minute, so the same URL is the same answer for a minute.

**Polling.** A share link's answers are cacheable: `Cache-Control: public, max-age=60` and
`Vary: x-glitchless-share` (every other API answer is `no-store`). The server keeps them for that minute too, apart
from members' (pinned links' apart from rolling ones', and links with sums apart from those without), and new
events don't clear them; saving the dashboard does. Share readers are rate limited per link where an answer is
made (10 a second per server process with bursts of 20 by default; `GLITCHLESS_SHARE_RPS` on Glitchless Cloud): an
answer already made costs nothing. So a game can read its own board, polling one URL from every player's browser
about once a minute: `GET {api}/v1/query/board?share=gl_share_…&days=30`, the token in the URL rather than the
header, so the browser sends no CORS preflight and the URL is the cache key. An answer may be up to a minute old
where it is made, and as much again in a cache in front; a revoked link may keep answering from such a cache for
that minute. On Glitchless Cloud that cache is CloudFront: `/v1/query/*` keeps an answer only for as long as it
says (so only share links'), keyed on the query string, cookies and the share, key and project headers.

**What a shared board leaves out** (`evaluateBoard(…, { shared: true })` in `server/src/board.js`):

- sessions panels: session and player ids, and devices (browser, OS, GPU, GPU tier)
- errors panels: anything but the message, kind, counts, last seen and levels (no stacks)
- findings: their evidence; an error finding's summary becomes its counts, with no breadcrumbs, code location
  or suggested fix, and a bug-report finding's becomes its counts, without the players' notes
- positions panels: anything but `level`, `axis`, `bounds`, `bin`, `deaths`, `total`, `truncated` and `path`
  (`bin`, `cells`, `samples`, `truncated`): counts per bin, never a session, player, version or time
- live panels, and any panel type not listed as safe. Stat, series, breakdown, funnel, levels, frame_time, deaths,
  events, versions and retention panels show counts and the game's own event names (retention: new players and
  returns per day, never an id; a breakdown or series by `$platform`, `$browser` or `$device_tier`: counts per group), and pass as they are; a
  new panel type stays off shared boards until it is added there. Store panels follow §3f (reviews, vitals, players
  online and store scores as counts and stars, never what players wrote) and §3h (RevenueCat's panels, installs and
  countries among them, only with sums).
- sums (revenue, revenue per player, revenue by item), unless the link was made with `sums: true`: a panel with
  `sum` says it isn't shown, and a versions panel marks its sum columns `hidden` and leaves their values out. So do
  an average (`avg`) or a spread (`of`: a distribution, a percentile) of an event that carries money (a `currency`),
  since the mean times the count is the revenue. Conversion (a share of players or sessions) and rates are shown:
  they are rates, not amounts.

**The page.** `#/share/<token>` opens before the sign-in gate and renders the board read only, with no sidebar,
editor or links into other views. Its filters are fixed, its range picker goes from an hour to 30 days (a pinned
link shows its dates instead, as UTC days: "Nov 12 – 16, 2026"), and it links to glitchless.gg ("Made with
Glitchless"). A revoked or expired link says so. The token sits in the URL
fragment, which browsers never send to a server or in a Referer. Pages can't be framed (`frame-ancestors 'none'`):
CloudFront never sees the fragment, so allowing embeds for shared boards alone would need a path of their own.

### 3d. Source maps

A minified web build's errors read `e (index-3f2a.js:1:48213)`. With the build's source maps uploaded, the server
shows them as `fireShotgun (weapons.js:141)`, with the original stack and line of code, and groups an error the
same way in every build. The SDK doesn't change: the server reads the stack string it already gets
(`server/src/sourcemaps.js`).

**Uploading.** One map per request. The `glitchless-sourcemaps` package (`packages/sourcemaps`: a CLI and a Vite
plugin) uploads a whole build directory.

| route | scope | does |
| --- | --- | --- |
| `POST /v1/sourcemaps?service=&version=&file=` | `sourcemaps` | the body is the `.map` file, as JSON or gzipped (recognised by its magic bytes). `file` is the minified script's path in the build, e.g. `assets/index-3f2a.js` (default: the map's own `file`); `version` is the one the game passes to `init`. → 201 `{service, version, file, bytes, sources, sources_with_content, pruned?}` |
| `GET /v1/sourcemaps?service=[&version=]` | `read` | `{service, sourcemaps:[{version, file, size, uploaded_at}]}` |
| `DELETE /v1/sourcemaps?service=&version=` | `sourcemaps` | deletes that version's maps; 404 when it had none |

An upload must be a version 3 map (`sources` a list of paths, `mappings` valid base64 VLQ, or an index map with
`sections` placed by offset) of at most 10 MB on the wire (a host passes `createApp` a smaller `maxUploadBytes`: the hosted service takes 4 MB,
under its web function's 6 MB) and 40 MB unpacked, with `file` a relative path that
doesn't climb out (`..`); otherwise 400 or 413. A version holds at most 200 maps, and a game keeps the 50 versions
uploaded most recently: an upload past that deletes the oldest (`pruned`).

**Storage.** Per project, service, version and file, apart from the events. FileStore:
`sourcemaps/<project>/<service>/<version>/<file>.map`. A store that expires data keeps a map 400 days after its
upload (`RETENTION_DAYS`), whatever it keeps events for: a version stays in players' hands far longer. `DELETE /v1/data` deletes a game's maps with its data.

**Matching a frame.** A stack line (Chrome `at fn (url:line:col)`, Firefox and Safari `fn@url:line:col`) belongs
to the longest uploaded `file` of the event's version that its URL path ends with, so the game can be served from
any host or folder. Its line and column are looked up in the map's `mappings`, giving the original source (made
relative: `../../src/weapons.js` is `src/weapons.js`), line and column. The function's name is read from
`sourcesContent`: the function around that position, named as V8 names it (`fireShotgun`, `Player.update`,
`new Player`, `<anonymous>` for a callback; TypeScript return types and generics are understood). A source without
`sourcesContent` takes the `names` entry at the caller's call site, then the minified name.

**At ingest.** For a browser error (not Godot, Unity or Unreal) whose version has maps, the server maps the stack,
takes the first frame that isn't Glitchless's own (as the SDK picks its top frame), and stores that frame's
original `fn`, `source` (the file name), `line` and `col`, with a fingerprint worked out as the SDK's on the
original function (`file:line` when no name could be read). Minified variables that engines quote in a message
are masked for it (`t.getPos is not a function` groups as `?.getPos is not a function`; property names stay). So
one bug in 1.2.0 and 1.2.1 is one issue. What the SDK sent stays in `minified` (§2). Each server process keeps a
game's list of maps for a minute and parsed maps up to 96 MB, so a game without maps costs one cached lookup and a
map is read once. An error that arrives before its version's maps keeps the SDK's fingerprint; it is still mapped
when shown.

**At query time.** `errors`, `findings`, `overview`, `board` and `playtest` map each issue's stack (its first
occurrence's, with that version's maps): `location`, `fn`, `source`, `line` and `stack` become the original ones,
and the issue gains

- `frames: [{fn, file, line, col, mapped, code?, minified?}]`, one per stack frame: `code` is the original line of
  source (trimmed, at most 200 characters) for the first 5 mapped frames, `minified` where the frame was in the
  build;
- `minified: {location, stack}`, what the browser reported.

A stability finding's evidence and advice name the original location, and a board's errors panel shows it. A
`session` timeline's errors are mapped the same way (with `minified.stack`). `glitchless_get_error` returns all of
it. Share links (§3c) show none of it: a shared errors panel keeps the message and counts only and findings lose
their evidence, so no file, function or line of source reaches a shared board.

### 3e. Alerts

A game's alerts tell its developers when something got worse for real players, by enough to act on today, in
Discord, Slack or email: in one plain sentence, with how many players next to what's normal, one line on what to do
and a line to paste into their coding agent. Standing problems (findings, §4) aren't alerts: a weekly summary lists
the few worth fixing. The rules, the check and the messages are the core's
([`server/src/alerts.js`](../server/src/alerts.js)). Glitchless Cloud keeps settings per game, checks every 15
minutes and adds the store, plan and weekly parts; a self-hosted server posts to one webhook
(`GLITCHLESS_ALERT_WEBHOOK`, README "Alerts").

**A check** reads each service that sent data in the last day, over the last day (summaries only, no drill-downs).
Every rule counts real players: sessions of type `synthetic` and `simulated` (autoplay, playtests) are left out,
and a session counts in the hour its `session_start` came. Players are player IDs; a game that sends none is
counted in sessions, and its messages say so. What's usual comes from a **profile**: for each hour of the last 8
days, its sessions, its players and the players who crashed (by the hour their session started). It is read once
(8 days) when a service has none or it is over 20 hours old, and the day every check reads keeps its last 24 hours
up to date. "The same hours over the last 7 days" are those hours on each of the 7 days before, counting only days
the profile has whole. A session **stutters** when it has 2 or more hitches (frames over 50 ms, §2) a minute over at
least a minute of frames, and 3 hitches at least; **crashed** is §4's crash.

| rule | fires when | holds while | key |
| --- | --- | --- | --- |
| `crashes` | at least 5 players who started a session in the last 6 hours crashed, that share is at least 3× the usual share for the same hours (from 20+ players in them), and a Poisson test puts it past chance (p ≤ 0.01) | 3+ players and 2× the usual share | `crashes` |
| `new_error` | an error first occurred after alerts went on and within the last day, and has reached 10 players, or 5% of the day's sessions and 3 sessions at least | it occurs in the last day | `error-<fingerprint>` |
| `release` | of the two newest versions with 5+ sessions in the day, in release order (§4), as the version finding picks them, each has 20+ players, and the newer one's share of players who stuttered (or crashed) is higher by a one-sided two-proportion z ≥ 2.33 (p < 0.01), 1.5× and 5 points (2 points for crashes) | still higher, by z ≥ 1 and 1.2× | `release-<prev>-<cur>` |
| `quiet` | the last 3 hours had under a tenth of the usual sessions for those hours, which average 10+ an hour (from 3+ days of the profile) | until the last hour has half its usual (then a "back" note, once, if the alert was sent, and the key clears) | `quiet` |
| `store` | Google Play's 28-day user-perceived crash rate is over 1.09%, or its user-perceived ANR rate over 0.47%: the bad-behaviour thresholds past which Play may show a game to fewer people ([Android vitals](https://developer.android.com/topic/performance/vitals)). Glitchless Cloud only, from the Google Play integration's freshest day (§3f), at most 7 days old | 90% of the threshold | `play-crash`, `play-anr` |
| `plan` | the workspace's play sessions this period reach 80%, then 100%, of what its plan includes (or of its cap, when that is lower). Glitchless Cloud only, once per workspace | once per share and period | `K#<period>#80`, `#100` |

The **crashes** message names a version when it has 60% of the crashed players: "Started with <version>" when its
first session was within the last 7 days, else "Most are on <version>". **Release** names the level whose hitches a
minute rose the most between the two versions (by 0.5 or more, with 2 minutes of frames on each). The release
message's finding is `version-<prev>-<cur>`, a new error's `error-<fingerprint>`.

Settings saved before these rules name `new_error`, `crash_free`, `frame_p95` and `finding`. They read as the rules
now: `crash_free` is `crashes`; `crash_free` or `frame_p95` on is `release`; `finding` is the weekly summary's
part (there is no finding alert); rules that are new (`quiet`, `store`, `plan`) are on. The next save writes the new
names. `newErrorSessions` is no longer read. `env` narrows a check to one env's sessions (default: all).

**Firing once.** A key fires when it starts to hold: it is claimed with a conditional write, so checks running at
once send it once. It stays claimed while it holds at the lower bar, and clears after it has not held for 24 hours;
then it can fire again. The first check after alerts are turned on (or on again), or on state from older rules (no
`v: 2`), is the **baseline**: what already holds is claimed without a message. New errors are the exception: whether
they are new comes from their first occurrence, which a 7-day read of errors on a service's first check provides. A
quiet only the baseline saw sends no "back" note. Fingerprints are remembered (first and last seen) for 30 days, at
most 2,000 a service. A check sends at most 5 alerts a service; the rest wait for the next.

**The message**, in every channel:

| part | what it is |
| --- | --- |
| `title` | the sentence, the email's subject: "Starlift is crashing: 14 players in the last 6 hours (usually about 2 a day). Started with 1.1.1." No percentiles, milliseconds, shares of frames or finding ids |
| `big` | `{value, label, normal}`: the number of players, and what's normal next to it ("Usually about 2 a day") |
| `quote` | the game's own text the alert is about (a new error's message), shown as code |
| `todo` | one line on what to do |
| `paste` | the line to paste into a coding agent: `Use glitchless_triage on <game>, then look at finding <id>.` (a new error adds `(glitchless_get_error with fingerprint <fp> has its stack)`; a release starts with `glitchless_compare_versions`; quiet with `glitchless_overview`; store with `glitchless_store_vitals`); none for the plan |
| `agent` | "For your agent": the measurements behind it (counts and shares, the usual, z or p, frame times, the Play metric and day, finding ids), small at the bottom |
| `link`, `figure` | the dashboard page, and for a channel that draws a card `{kind, headline, series, stats}` (crashed players or sessions per hour over the last day; a new error's counts) |

The game is its Glitchless Cloud name when it has one service, else the service.

- Discord: `content` is the title in bold; one embed has the big line, the quote, what to do, the paste line in a
  code block, the page as `url`, a colour by severity, and "For your agent" as its footer (small, plain text).
  `allowed_mentions: {parse: []}`.
- Slack: Block Kit sections (title; big line, quote and what to do; the paste line), then a context line with the
  link and "For your agent". No unfurls.
- Email (Glitchless Cloud): the shared layout (`cloud/docs/email.md`): a card with the big number and what's normal,
  hourly bars, up to three stats; what to do; a button to the page; the paste line; "For your agent" in small type;
  and a plain-text part. From `Glitchless alerts <alerts@glitchless.gg>`, saying why the reader gets it and linking
  to Settings → Alerts.

Text from a game (error messages, level and version names) is cut to one line without control characters, then
escaped for each channel (Discord markdown and `@`, Slack's `&<>`, HTML; inside code, backticks become `'`), so it
can't ping, link or format.

**The weekly summary** (Glitchless Cloud, `weekly`, default on): for each service with sessions in the two weeks,
once a week from the same 15-minute check, the first one on or after Monday 14:00 UTC, for games whose alerts were
on before that week began (claimed as `W#<service>#<monday>`, so no new schedule). It covers last week (Monday to
Sunday, UTC) against the week before: players (or sessions) and sessions, the share of players who crashed, revenue
(RevenueCat's when connected, §3h, else the game's own `purchase` events' `amount`), and **Worth fixing**: the top
three standing findings (critical, high or medium), each as one plain sentence with its paste line. A service with
no sessions in either week gets none. It goes to the game's channels like an alert.

**Glitchless Cloud.** Settings → Alerts, per game: a webhook URL, email to every active member of the workspace,
which rules, the weekly summary and an env. Changing them, and the test button, needs the exporters' permission
(Owner, Admin). Discord (`discord.com/api/webhooks/…`) and Slack (`hooks.slack.com/services/…`) URLs are
recognised; any other public https URL takes the format chosen (Slack's suits Mattermost, Discord's Guilded). The
URL is sealed like an exporter's secrets (KMS, encryption context `{project}`) and never returned: the dashboard
gets the host and its last four characters. Sends go through the exporters' guarded fetch: https, no redirects,
and no private, loopback, link-local or metadata address after DNS. A send's result is `HTTP <status>` or why it
could not connect, never the URL. Links open the game: `https://app.glitchless.gg/?ws=<workspace>&game=<project>#/<page>`.

The **plan** notice goes to every channel of the workspace's games that have the rule on, each webhook once and the
members' email once. On Free, 100% is also billing's own email to the Owners (`freeLimitEmail`, sent when intake
stops), so the plan notice's email then goes to the other members only (`{channel: 'email', ok: true, to: 0, note}`
when there are none). Spike protection keeps its own email; the plan notice says where it would pause.

| route | does |
| --- | --- |
| `GET /api/projects/{p}/alerts` | `{alerts: {on, onSince, webhook: {format, host, hint} \| null, email, emailRecipients, rules, weekly, env}, log, defaults, mail, permissions}`; `log` is the last 20 sends, tests included, each with what every channel answered |
| `PATCH /api/projects/{p}/alerts` | any of `{webhookUrl, webhookFormat, email, rules: {rule: bool}, weekly, env}`; `webhookUrl: null` removes the webhook. Alerts are on when there is a channel and a rule or the weekly summary |
| `POST /api/projects/{p}/alerts/test` | sends a test alert to every channel → `{sent: [{channel, ok, to?, error?}]}`; 10 an hour |
| `POST /api/dev/alerts/check` | the dev server only: runs the check now |

Glitchless Cloud checks every game with alerts on every 15 minutes, one run at a time, then each of their
workspaces' plan.

### 3f. Store reviews and vitals: Steam, Google Play, the App Store

What players write about a game on its store pages is joined to what Glitchless measures, **by build**: "the
reviews say it stutters since the update" becomes which build, which devices, how many reviewers played on a Steam
Deck, and the frame-time p95 and crash-free sessions measured on that build's version. Where a store measures the game
itself (Google Play's Android vitals, Apple's hang, launch and animation metrics), its numbers sit next to
Glitchless's for the same version, with a line wherever the two disagree. The pipeline is store-neutral
([`server/src/reviews.js`](../server/src/reviews.js)): a store adapter turns its answers into reviews, release marks
and vitals, and storage, the join, the panels, the finding and the queries are the same for every store. The
adapters: Steam ([`server/src/steam.js`](../server/src/steam.js), its keyless calls; Glitchless Cloud adds the
publisher's keys and the partner calls), the App Store
([`server/src/app-store.js`](../server/src/app-store.js), Apple's public review feed; Glitchless Cloud adds the App
Store Connect API) and Google Play (Glitchless Cloud only, with a service account).
A host hands the core a game's stores with `createApp({ stores: { read(projectId, service, { from, to, recordsFrom }) } })`,
which answers `{ steam: {…}, google_play: {…}, app_store: {…} }` (the connected ones) or null; without it the store
panels say the game has no store connected, and nothing else changes. Every adapter is read only: none replies to a
review or writes anything to a store.

**A review**, whatever the store: `{store, id, ts, up, rating, lang, text, topics, version, device, <store>: {…}}`.
`up` is the thumbs-up (a rating of 4 or 5 where a store has stars; `rating` is then 1–5, else null); `version` is the
game's version when the store says which one was reviewed (Google Play and the App Store do; Steam doesn't: the join
finds it); `device` is the hardware the reviewer shows (`os`, `cpu`, `gpu`, `ram_mb`, or a phone's `model`); the text
has BBCode and markup taken out and is cut to 500 characters. Its **topics** are found in the whole text first: `stutter`, `lag`, `fps`, `freeze`, `crash`, in
English and the languages most reviews are written in (German, French, Spanish, Portuguese, Russian, Chinese,
Japanese, Korean). What only one store has goes under its name: Steam's `steam: {playtime_min, deck_min, deck,
refunded, early_access}` (`deck`: played mostly on Steam Deck; `deck_min`: Steam Deck playtime at review); Google
Play's `google_play: {version_code, device, device_class}` (the device's code name, and Play's class: phone, tablet,
Chromebook); the App Store's `app_store: {territory}`. The author (a Steam ID, a Play or App Store reviewer's name or
nickname, their other reviews) is never read or kept.

**Releases.** Reviews and measurements are joined through a store's releases, oldest first, from the first of:
the store's release history (Steam: the builds set live on the default branch, with the publisher key; the App Store,
with an API key: its versions as Apple dates them), the versions the store's reviews and vitals name (Google Play and
the App Store, each from the first day it is named), the builds the game's sessions name (the SDKs send the Steam build on `session_start`, §4c; a build seen in 3 or more sessions,
from its first), the store's patch notes (Steam: announcements tagged `patchnotes`, or titled like a release), the
versions Glitchless saw first. A release's **version** is the one its sessions ran (for a build the sessions name),
else a version the game sent that its build description or patch-notes title names ("1.4.2 caves update", "Patch
1.4.2"), else the version most sessions ran among those first seen while it was live. Its label is
`build <id> (<version>)`, the version, or the title. A review belongs to the release it names (`version`), else the
one live when it was written; reviews before the first known release are a row of their own, measured on the
version most sessions ran before it. A store whose reviews name their version is counted by its reviews' versions
(a 1.4.1 review written after 1.4.2 shipped still counts for 1.4.1), not by when they were written.

**Vitals**, whatever the store: `{metric, value, version, build, day, period, users, percentile, device}`, by day
(`period: 'day'`, with the users the store counted that day) or as the store's latest figure for a version
(`period: 'version'`). `build` is the store's build number (Google Play's version code, the App Store's build), so a
game that passes either to `Glitchless.init` is matched too.

| `metric` | store | what the store counts | next to Glitchless's |
| --- | --- | --- | --- |
| `slow_rendering_20fps`, `slow_rendering_30fps` | Google Play | % of users in a day with slow rendering (frames slower than 20 or 30 fps) | % of sessions whose frame times' 75th percentile is slower than 50 ms (33.3 ms) |
| `crash_rate` | Google Play | % of users in a day with a crash | % of sessions that crashed (100 − crash-free) |
| `anr_rate` | Google Play | % of users in a day whose game stopped answering for 5 seconds | (nothing Glitchless measures) |
| `hang_rate` | App Store | seconds hung per hour of use (p50, p90) | hitches a minute |
| `launch_time` | App Store | launch to first frame, ms (p50, p90) | time to first frame, median |
| `animation_hitch_rate` | App Store | ms of hitches per second of animation (p50, p90) | hitches a minute |

They **disagree** when, for a version, the store's slow rendering is at least twice Glitchless's and 3 points more
(or the reverse), its crash rate twice and 0.5 points more (or the reverse), or its launch time and Glitchless's time
to first frame differ two-fold and by 500 ms. Each disagreement is a line saying which side counts more and the likely
reason: a store counts a user once a day and only on the devices it watches, Glitchless counts sessions; native
crashes and crashes before the SDK starts never reach Glitchless; Glitchless also counts a stopped game loop or a
fatal script error, which the OS doesn't see as a crash; a launch includes what runs before the SDK starts (the
engine, a splash screen). Sessions-based measures (slow sessions, time to first frame) need a range of 31 days or
less.

| panel `type` | fields | shows |
| --- | --- | --- |
| `store_reviews` | `store` | positive, negative and negative-about-performance reviews (any topic) by day (by hour under 3 days), each release marked; a row per release in the window: reviews, positive %, negative about performance (count and %), the store's segment (Steam Deck %), and the sessions, frame p95 and crash-free % measured on its version; the store's all-time score |
| `store_players` | `store` | players online as the store counted them each sync (Steam), next to the sessions Glitchless saw playing in that minute (for ranges of 31 days or less): `coverage_pct`, measured over counted, is how much of the game's play has telemetry |
| `store_sales` | `store` | units sold, returns (and the return rate), wishlist adds and deletes by day (Steam: from the Financial API Group key) |
| `store_vitals` | `store` | the store's vitals version by version (newest first; by day weighted by users, or the store's latest for the version), next to the sessions, frame p95, crash-free % and the matching measures Glitchless has of the same version; the lines where the two disagree; Google Play's slowest devices and GPUs on its freshest day; the App Store's heaviest hang signatures in the latest build |
| `store_score` | `store` | a store's rating, small (default size `s`; one panel per store): the average stars of the written reviews Glitchless synced in the window and how many (`synced: {average, reviews, stars: [1★…5★ counts], since, capped}`; on Steam the share positive instead), next to the store's own overall number where it has one (`overall`): the App Store's rating from Apple's public lookup, every rating with or without a review, weighted over the connection's countries, and the current version's (`{average, count, countries, day, current: {average, count, version}}`); Steam's review summary (`{desc, positive_pct, count}`). Google Play has no API for its overall rating: `overall` is null and a note says the number is the synced reviews' average. `notes` say which number is which |

`store` is `steam`, `app_store` or `google_play` (default: the game's first connected store). A game connected to a
store gets a **page per store** on the automatic dashboard, after the Overview (`steam`, `app-store`, `google-play`):
`store_reviews`, `store_vitals` where the store reports vitals, `store_players` where the store counts players,
`frame_time` when the game sends frame times, and `store_sales` when there are sales (or, on Steam, a financial key).
A saved dashboard adds the panels like any other, and Glitchless Cloud adds the store's page to a game's saved
dashboards when the game is first connected to that store (`withStorePage`: after the first page, unless a page already
shows that store; taken off, it isn't added again). A share link shows `store_reviews`, `store_vitals`,
`store_players` and `store_score` (counts and stars, never review text) and `store_sales` only when made with sums.

**The finding** (`store-reviews-<store>-<release key>`, category `reviews`), per store: of the releases in the last
30 days, the latest with 5 or more reviews since it went live (on Google Play and the App Store, 5 or more reviews of
that version), when 3 or more of them are negative about performance, and their share is 10 or more points above,
and at least 1.5 times, the share in the 30 days before it (there: of the earlier versions' reviews in those days) (z ≥ 1.64 when
there are 5 or more reviews to compare with; else a share of 25% or more). High when that share is 30% or more with 10
or more such reviews, or when the version's frame p95 is 15% worse or its crash-free sessions 2 points lower than the
version before's; else medium. Its summary counts the topics, the segment's share (Steam Deck) and the devices
reviewers show, then what Glitchless measured on the version and the one before; `evidence` has the counts,
`segment`, `devices`, `version`, `previous_version`, the performance findings to start with (`related_findings`) and up
to three short examples. The suggestion names `glitchless_compare_versions`, `glitchless_performance` with that
version, `glitchless_deck_measure` when most of these reviewers are on a Deck, `glitchless_store_reviews` for the
build, and `glitchless_store_vitals` on a store that reports vitals.

**Query** `store_reviews`: one store's reviews in the range (`store`, default the first connected), newest first,
filtered by `build` (a build ID, a version or a release's label), `sentiment` (`positive` or `negative`), `keyword` (a
topic, or any text), `deck=1` (Steam), `device` (part of the GPU or device name; `gpu` is the same) and `limit`
(default 20, at most 100) → `{connected, store, store_name, stores, app_id, summary, synced_at, window_reviews,
matched, negative, segment?, topics, devices, builds, reviews:[{…review, build, version}], texts_from, capped}`.
`builds` are the panel's rows. Texts are read for the range (other queries read the last 62 days), at most the latest
3,000; counts are always complete. An unknown build answers `{error, releases}`. The MCP tool
`glitchless_store_reviews` reads it.

**Query** `store_vitals`: one store's vitals (`store`, default the first connected one that reports vitals; `version`,
a version name or build number) → `{connected, store, store_name, stores, app_id, synced_at, columns:[{key, metric,
percentile, label, unit}], rows:[{version, build, latest, store: {<key>: value}, glitchless: {sessions, frame_p95,
hitches_per_min, crash_free_pct, crashed_pct, slow20_pct, slow30_pct, ttff_p50} | null, notes}], notes:[{version,
metric, store_value, glitchless_value, says}], devices, hangs}`, or `{empty, why}` before any. A column's `key` is the
metric, with `:p50` or `:p90` where the store gives percentiles. The MCP tool `glitchless_store_vitals` reads it.

**Stored** (a pk/sk store: Glitchless Cloud's control table), under `STORE#<project>#<store>`: `R#<day>` (that day's
reviews, up to 300 KB of UTF-8: past that a review is counted but its text not kept), `RH#<month>` (review counts per
hour: up, down, down about performance, and the same in the store's segment), `PL#<month>` (players-online samples),
`SALES#<month>` and `WISH#<month>` (by day; a day the store sends again replaces what was there), `VIT#<month>`
(vitals by day; likewise), `VITV` (each version's latest vitals), `SNAP#devices`, `SNAP#hangs` and `SNAP#rating` (the
App Store's own rating; the latest snapshot of each), `RELEASES` and `NOTES` (release marks), `META`, and `X#<name>` for what the adapter keeps for
itself (Steam: its builds). Each day or month item expires 400 days after its period.

**Steam.** What a sync takes, per game, from where its last sync stopped:

| from | call | when | key |
| --- | --- | --- | --- |
| reviews | `IUserReviewsService/GetAppReviews` (newest first, every language, any purchase, by creation date) | every sync: weekly date windows of 100-review pages from an hour before the last window ended; the first sync goes back the plan's retention (at most 90 days) | none (the publisher key gives a higher rate limit) |
| the review score | `GetAppReviews` (one review, all time) | every 6 hours | none |
| players online | `ISteamUserStats/GetNumberOfCurrentPlayers` | every sync | none |
| patch notes | `ISteamNews/GetNewsForApp` (the developer's announcements, titles and tags only) | every 6 hours | none |
| builds and branches | `ISteamApps/GetAppBetas`; `GetAppBuilds` when a branch changed, else every 6 hours | every sync | publisher Web API key |
| wishlists | `IPartnerFinancialsService/GetAppWishlistReporting` (GMT days) | once a day: the last 30 days on the first, then from the day before the last | Financial API Group key |
| units and returns | `GetChangedDatesForPartner`, then `GetDetailedSales` per changed date (Pacific days, the app's packages only) | once a day; changed dates back 90 days, 20 a run | Financial API Group key |

A build's history comes from the branches: a branch whose build changed between two syncs went live in between
(`from`, the time it was seen); on a game's first sync each branch's build is dated by its creation time and marked
`approx`. When the game's sessions send their Steam build (§4c), the join knows each session's build exactly.

**Google Play** (Glitchless Cloud). The developer creates a service account in a Google Cloud project, turns on
the Google Play Developer Reporting API there, and invites the account's email in Play Console → Users and
permissions with access to the app: "View app information (read only)" and "Reply to reviews" (the reviews API asks
for it even to read; Glitchless never replies). Its JSON key is pasted in Settings and sealed. A call is signed with a
token from the key (RS256, scopes `androidpublisher` and `playdeveloperreporting`, an hour).

| from | call | when |
| --- | --- | --- |
| reviews | Android Publisher `reviews.list` (Play keeps only reviews with text, on production versions, from the last week) | every 6 hours: every page (at most 10), skipping reviews already kept (an edit keeps the first text) |
| vitals by version code | Reporting API `slowRenderingRateMetricSet`, `crashRateMetricSet`, `anrRateMetricSet`: `:query` by `versionCode`, daily, Pacific days; each set's freshest day from its own `GET` | once a day: 30 days on the first sync, then from two days before the last day read (Play fills days in late) |
| slowest devices and GPUs | the same sets on the freshest day, by `deviceModel` and `deviceGpuModel` | once a day: the ten with the most users affected (10 users or more) |
| 28-day rates (the alerts' store rule, §3e) | `crashRateMetricSet` `userPerceivedCrashRate28dUserWeighted` and `anrRateMetricSet` `userPerceivedAnrRate28dUserWeighted`, each set's freshest day, no dimension (every version) | once a day: kept as the `health` snapshot `{day, crash: {rate, day, users}, anr}` |

Play's review history beyond a week is in the monthly review CSVs in its Cloud Storage bucket (`reviews_<package>_<YYYYMM>.csv`): an import of them is a later step.

**The App Store** (Glitchless Cloud). Without a key, the public review feed of each country set (default `us`, at
most 10): 50 reviews a page, 10 pages deep (Apple refuses page 11), newest first, each with the version it was written
on and its stars, read every 6 hours until a page brings nothing new (the newest 1,500 review IDs are remembered).
With an App Store Connect API key (an Admin creates a team key in Users and Access → Integrations, with a role that
can read the app; its issuer ID, key ID and `.p8` are pasted in Settings and sealed; calls are signed with an ES256
token, 20 minutes):

| from | call | when |
| --- | --- | --- |
| versions | `GET /v1/apps/{id}/appStoreVersions` | once a day: the release marks |
| reviews | `GET /v1/apps/{id}/customerReviews` (newest first), and `GET /v1/appStoreVersions/{id}/customerReviews` for the latest 3 versions, which name each review's version | every 6 hours, from a day before the newest kept (first: the plan's retention, at most 90 days), at most 5 pages |
| hang rate, launch time, animation hitches | `GET /v1/apps/{id}/perfPowerMetrics` (iOS, all devices, p50 and p90, by version) | once a day |
| heaviest hangs | the latest build's `GET /v1/builds/{id}/diagnosticSignatures` (`HANGS`), the top 5 by weight | once a day |

With or without the key, **Apple's own rating** comes from its public lookup, once a day, one call per country set
(keyless, counted in the daily keyless budget): `GET https://itunes.apple.com/lookup?id={id}&country={cc}` →
`averageUserRating` and `userRatingCount` (every rating in that country's store, with or without a review, all
versions) and `averageUserRatingForCurrentVersion` and `userRatingCountForCurrentVersion`. A country where the app isn't
sold answers no result and is left out; the rating kept (`SNAP#rating`) is weighted by each country's ratings.

The feed's and the API's review IDs differ, so adding or removing the key starts the game's App Store data again.
Apple's crash counts come from the Analytics Reports API ("App Crashes"), which an Admin must request once in App
Store Connect before any report exists: a later step.

**Not connected (yet).** Microsoft Partner Center, Epic, itch.io, GOG, PlayStation and Nintendo have no adapter;
Meta Quest's reviews and vitals have no API, so they would come in as a CSV import (a later step).

**Glitchless Cloud.** Settings → Integrations, per game, a card per store: Steam's App ID (required) and its two
optional keys; Google Play's package name and service account key; the App Store's Apple ID (the number in its App
Store URL), its countries and the optional API key. Each card also takes the game in the project it is for (default:
every game). A credential is checked with one read when saved (the store refusing it refuses the save, saying what to
fix) and sealed like an exporter's secrets (KMS, encryption context `{project}`); it is never sent back: the dashboard
gets a hint (a key's last four characters, a service account's email, an API key's ID). A new App ID or package name
forgets the old one's data (and Steam's publisher key). Changing a connection and syncing need the exporters'
permission (Owner, Admin).

| route | does |
| --- | --- |
| `GET /api/projects/{p}/stores` | `{stores: {<store>: {connection: {…settings, keys: {<name>: hint \| null}, service, connectedAt, updatedAt, updatedBy} \| null, status: {at, ok, errors: [{part, error}], added, players, calls} \| null, data: {reviews, syncedAt, summary}}}, permissions}` for `steam`, `google_play`, `app_store`, `revenuecat` (§3h) and `stripe` (§3i) |
| `PUT /api/projects/{p}/stores/{store}` | Steam `{appId, publisherKey?, financialKey?}`; Google Play `{packageName, serviceAccount?}` (the JSON key); the App Store `{appId, countries?, apiKey?: {issuerId, keyId, privateKey}}`; RevenueCat `{rcProjectId, currency?, secretKey?}` (§3h); Stripe `{restrictedKey?, products?}` (§3i); each with `service?`. A credential left out stays, `null` removes it → that store's `{connection, status, data}` |
| `DELETE /api/projects/{p}/stores/{store}` | disconnects and deletes the game's data from that store |
| `POST /api/projects/{p}/stores/{store}/sync` | syncs now (6 an hour, within 20 seconds; the hourly sync does the rest) |
| `GET`, `PUT`, `DELETE /api/projects/{p}/steam`, `POST …/steam/sync` | Steam's, as before the other stores: `{steam, status, data}` |
| `POST /api/dev/stores/sync` (or `/api/dev/steam/sync`) | the dev server only: runs the hourly sync now |

The `glitchless-stores` Lambda syncs every connected game of every store every hour, one run at a time, each game and
store under a 15-minute lease (`deploy.js` puts it up with everything else; `--stores off` leaves it out). A sync
stops for the day at 1,500 calls a game and store, and without credentials at 80,000 calls a day across every game on
Steam (Valve's Web API terms allow 100,000 and ask that only what is needed is retrieved: an ordinary hour is 3 calls
a game) and 20,000 on Apple's feed. A part a store refuses or rate-limits (`errors`) waits for the next sync from where
it was; the others go on.

### 3g. Agents across a workspace (Glitchless Cloud)

A coding agent can work across a Glitchless Cloud workspace without a browser: list and create games, read any of
them, save their dashboards and make share links. It does that with a **workspace key** (`gl_ws_…`), which acts for
the person who approved it, with their current role, and within its scopes:

| Scope | What it allows |
| --- | --- |
| `read` | Every game's queries (always included) |
| `dashboard` | Save a game's dashboard |
| `manage` | Create games and their public keys, make and revoke share links |
| `sourcemaps` | Upload a web game's source maps |

A workspace key never deletes data and never touches billing or people. It stops working when it's revoked
(Settings → Keys & access, or Agents & MCP) or when its person leaves the workspace, and loses `dashboard`, `manage`
and `sourcemaps` if their role drops to Viewer.

**Keys & access.** Settings → Keys & access lists everything that can reach a game in one place: the workspace's
keys (agents that signed in, apps connected over OAuth, keys made for CI), the game's ingest keys (`gl_pub_…`) and
secret keys (`gl_sk_…`, scopes `read` plus any of `dashboard`, `sourcemaps`, `delete`), and its share links (§3c),
each with who made it, when it was last used and when it ends, and Revoke. It makes the key for a job in one step:
connecting a coding agent (`glitchless-mcp login`, or a workspace key for CI), the game's ingest key, a source map
key (`read` + `sourcemaps`). The lists come from the control API, unchanged but for two fields:

| Route | Each key |
| --- | --- |
| `GET /api/workspaces/{ws}/agent-keys` | `{id, name, scopes, status, hint, via, client, createdAt, createdByName, revokedAt, expiresAt, lastUsedAt}`: `via` is `connect` (an agent's sign-in), `oauth` (an app connected by URL, `client.host`) or `settings`; `expiresAt` is null but for an app's key, which moves on while the app keeps refreshing its tokens. Owners, Admins and Developers get every key, anyone else their own |
| `GET /api/projects/{p}/keys` | `{id, kind, name, scopes, status, hint, token?, createdAt, createdBy, revokedAt, lastUsedAt}`; `token` only for an ingest key, which isn't secret |

`lastUsedAt` (ISO, or null for never) is when a key last read, sent data or signed in, or a link was last opened.
Each server stamps a key at most once every ten minutes, so it's right to about ten minutes.

**Signing an agent in** is a device flow, like `gh auth login`:

1. The agent calls `POST /v1/agent/connect` with `{ client }` (what it calls itself) and gets `{ device_code,
   user_code, verification_url, expires_in, interval }`. The code lasts 10 minutes.
2. It shows the person `verification_url` (`…/#/connect?code=XXXX-XXXX`). Signed in there, they check the code,
   pick the workspace and the scopes, and approve or decline. Anyone in the workspace can approve: a Viewer's
   approval gives `read` only, and the other scopes take an Owner, Admin or Developer, as does making a key in
   Settings → Keys & access. There, Owners, Admins and Developers see and revoke every key, and a Viewer the ones
   they approved.
3. The agent polls `POST /v1/agent/connect/poll` with `{ device_code }` every `interval` seconds: `pending`,
   `slow_down`, `denied`, `expired`, or `approved` with `{ token, workspace, scopes }`, which comes back once.

`npx -y glitchless-mcp login` does all three and saves the key; the MCP server's `glitchless_sign_in` tool does it
from inside a chat.

**With the key**, sent as `Authorization: Bearer gl_ws_…` or in `x-glitchless-api-key`:

| Route | What | Scope |
| --- | --- | --- |
| `GET /v1/agent/whoami` | The key's workspace, role, scopes and games | read |
| `GET /v1/agent/games` | Every game: id, name, client token, the services reporting to it | read |
| `POST /v1/agent/games` | `{ name }` → the new game, its client token and the intake URL; `{ demo: true }` → the demo game (below) | manage |
| `GET /v1/agent/games/{game}` | One game | read |
| `GET /v1/agent/games/{game}/shares` | Its share links | manage |
| `POST /v1/agent/games/{game}/shares` | `{ service, page, name?, days?, sums?, from?, to? }` → the link (shown once) | manage |
| `DELETE /v1/agent/games/{game}/shares/{id}` | Revoke one | manage |

**The demo game** is Zoomies (demo), a week of Zoomies' sample play (about 180 sessions, with the planted level-2
hitch and velocity error, and Zoomies' dashboard), so someone who connects an app before they have a game can try every
tool on something real. A workspace has one; it takes no room from the plan's games, its sessions aren't the plan's,
and games list it with `demo: true`. On the lake its data is readable about five minutes after it's made. In a
workspace with no games, `glitchless_list_games` says how to make one (with the demo game when the key may `manage`,
otherwise where in the dashboard and how to connect again with that scope), and a game that hasn't sent data gets a
`next_step`: its client token, the intake and the setup steps (`docs/agent-setup-prompt.md`). The approval page
(`#/connect`) asks for the first game, or offers the demo game, when the workspace has none.

Every other `/v1/` route (queries, `/v1/dashboard`, source maps) takes the same key with the game named in
`x-glitchless-project` (or `?project=`). `/v1/agent/` reads no cookies and sends no CORS headers: it's for programs,
not web pages. In the browser, the dashboard registers the same abilities as WebMCP tools
(`document.modelContext`), acting as the signed-in person.

### 3h. Revenue: RevenueCat (Glitchless Cloud)

A game that sells in-app purchases through RevenueCat connects it in Settings → Integrations, next to its stores, and
its **real revenue**, its **installs** and its **active users** sit next to what Glitchless measures. The game's own purchase events (`track('purchase',
{amount, currency})`, §3b) are what the game sends: they miss purchases on builds without the SDK or that the game
doesn't track, and on Android a licence tester's purchase looks like any other on the device. RevenueCat counts what
the stores charged, and its charts count production transactions only: sandbox purchases (TestFlight, StoreKit
testing, Google Play licence testers) are never in them (RevenueCat's docs, Charts; its dashboard shows sandbox
purchases only behind the Overview's sandbox toggle, which the API doesn't use). Its charts are in UTC days. So
RevenueCat's revenue is the number for money, and the game's purchase events are the ones to read by item, level or
player; the gap between them is the purchases that never reach Glitchless. The core is store-neutral like §3f
([`server/src/revenue.js`](../server/src/revenue.js): storage, panels, the Revenue page, the query; a source's data
comes through the same `stores.read` as the stores', under its name); the adapter that calls RevenueCat is Glitchless
Cloud's. Read only: nothing is written to RevenueCat, and its
webhooks (RevenueCat's Pro plan) are not used.

**Connecting.** The RevenueCat project ID (`proj…`; the 8 characters after `/projects/` in the dashboard's address are
taken too), a currency (one of the 14 RevenueCat converts to: USD, EUR, GBP, AUD, CAD, JPY, BRL, KRW, CNY, MXN, SEK,
PLN, NZD, CHF; default USD) and a **v2 secret key** (`sk_…`; Project settings → API keys) that has only Charts &
Metrics → Overview: Read and Charts: Read (`charts_metrics:overview:read`, `charts_metrics:charts:read`). The key is
checked with one read on save (`GET /v2/projects/{id}/metrics/overview`: a wrong key, a key of another project or one
without the overview permission is refused, saying what to fix; a public SDK key, `appl_…` or `goog_…`, is refused
before it is sent) and sealed like a store's credentials; the dashboard gets its last four characters. A new project or
currency forgets the kept revenue, and the next sync backfills it in the new one.

**The sync** (hourly with the stores, the `glitchless-stores` Lambda; API v2, `Authorization: Bearer sk_…`):

| from | call | when |
| --- | --- | --- |
| the overview | `GET /projects/{p}/metrics/overview?currency=` (MRR, active subscriptions and trials now; revenue, new customers and active customers over the last 28 days) | every sync |
| each chart's resolutions and segments | `GET /projects/{p}/charts/{revenue,mrr,actives,trials,customers_new,customers_active}/options?realtime=true` | once a day |
| revenue and transactions, MRR, active subscriptions, active trials, new customers, active customers, by UTC day | `GET /projects/{p}/charts/{chart}?realtime=true&resolution=<the daily resolution's ID>&start_date=&end_date=&currency=` | every sync: the first back the plan's retention (14, 90 or 400 days; active customers 28, the days RevenueCat says are accurate), then from 3 days before the last day read (late renewals; Charts v3 takes refunds off on the day they are processed) |
| revenue by app version | the revenue chart with `segment=<its app version segment>&limit_num_segments=20` | every sync, when the revenue chart's options list an app version segment |
| revenue and transactions by country; new customers (installs) by country | the revenue and new customers charts with `segment=<their country segment>&limit_num_segments=50` | once a day, when the chart's options list a country segment (an ID or name `country`, `country_code` or `customer_country`, never a first-seen or store country) |
| revenue and transactions by store | the revenue chart with `segment=<its store segment>&limit_num_segments=10` | once a day, when its options list a store segment (`store`) |

Charts & Metrics allow 25 requests a minute per RevenueCat project: a sync asks one call at a time, 7 or 8 of them
(16 or 17 once a day, with the options and the splits by country and store), never more than 20, and a 429 ends it:
the rest wait for the next sync, from where it was. Options kept from before Glitchless looked for the country and
store segments are read again at once. The
stores' daily budget (1,500 calls a game) applies too. A chart's points are `{cohort, measure, value, incomplete,
segment}` (`cohort`: the period's start in Unix seconds; `measure` and `segment` index the chart's `measures` and
`segments`, whose first is the total; older charts' arrays `[cohort, value…]` are read too). Each chart's measure is
picked by its name (Revenue and Transactions; MRR; active subscriptions, not trials; Active Trials), else its first.
The resolution and segments come from the options, never guessed; a chart new to a connection gets its options on the
next sync, and a chart RevenueCat doesn't have for the project (400 or 404 on its options, such as Active Customers
without Charts v3) is reported once a day and skipped. Today's point is `incomplete` (still filling in).
MRR, subscriptions and trials are RevenueCat's snapshot of each day (subscriptions and trials at its end).

**Installs and active users.** RevenueCat's **new customers** are the nearest thing it has to installs: a customer
counts on the day RevenueCat first saw them, which for most is the first time the app starts its SDK (a purchase made
outside the app can come first). A reinstall without signing in is a new customer again, an install that never opens
the app isn't one, and customers have no sandbox side, so testers and developers count. The board calls them
**Installs**. Its **active customers** are the customers whose SDK it heard from that day, each once: daily active
users. RevenueCat says that chart is only accurate for the last 28 days, so only those are read. Next to them,
Glitchless shows its own **new players** (first seen that UTC day, from the store's first-seen index; they need player
IDs, install or full mode, and without them the panels say so) and **players** a day (who played that day; sessions in
anonymous mode). Installs and active users are the whole game's, whatever the version filter.

**By version.** RevenueCat documents no app version dimension for its charts (October 2026: country, store, product,
offering, product duration, renewal cycle, attribution and others), so Glitchless takes one only when the revenue
chart's options list a segment named app version (never the first seen or install version, which says nothing about
the version a purchase was made on). Without one, revenue is by day only, the `by_version` panel says so and what to
use instead (a breakdown of `purchase` by `$version` with `sum: "amount"`), and a query filtered to a `version` answers
`{empty, why}` rather than the whole game's revenue over one version's players.

**By country and by store.** RevenueCat's country segments are named as its charts name them (an English name, maybe
a code): Glitchless finds each one's ISO 3166-1 alpha-2 code (`server/src/countries.js`: English names, other names,
alpha-3 and numeric codes) and keeps RevenueCat's own name for one it can't place, which the list shows and the map
can't (a note names them); RevenueCat's "Other" (the countries past its top 50) is `(other)`, listed last. A store
segment is kept with a key (`app_store`, `play_store`, `mac_app_store`, `amazon`, `stripe`, else its name) and
RevenueCat's name for it. Both are read once a day, from three days before the last day read (first: the backfill),
so the panels say which day they go to when it is before the window's last; they are the whole game's, whatever the
version filter. Purchases are RevenueCat's transactions (renewals among them).

**Money.** Amounts are in the connection's currency, as RevenueCat converted them. The game's own purchase events are
put next to them only in that currency; when the game's currency (the dashboard's, else its purchases', §3b) is
another, RevenueCat's amounts are shown in theirs, never converted or added to the game's, and a note says to set the
connection's currency. Revenue panels are sums: a share link shows them only when made with sums.

| panel `type` | fields | shows |
| --- | --- | --- |
| `store_revenue` | `measure`: `revenue` | the window's revenue (its UTC days, today so far included), transactions, and the game's own purchase events in the same currency with the share of it they cover |
| | `per_player` | that revenue over the players Glitchless measured in the window (sessions in anonymous mode) |
| | `installs` | RevenueCat's new customers in the window, next to the new players Glitchless saw (and their share of the installs) |
| | `active_users` | RevenueCat's active customers a day (the average of the window's days, leaving out today), next to Glitchless's players a day |
| | `mrr`, `actives`, `trials` | MRR, active subscriptions, active trials on the window's last day, and the change since its first (before any day: the overview's figure now; for installs and active users, its last 28 days) |
| | `by_day` | revenue per day (bars), with the game's own purchase events per day when comparable; transactions, MRR, subscriptions and trials per day in its CSV |
| | `players_by_day` | installs and active users per day, with Glitchless's new players and players per day |
| | `by_version` | a row per version purchases were made on (newest first, RevenueCat's "Other" last): revenue, share, transactions, and Glitchless's players, sessions, revenue per player, purchase events, crash-free % and frame p95 of the same version |
| | `by_country` | a world map of installs or revenue by country (one at a time, `show` picks the first: `installs`, the default, or `revenue`; people switch), drawn from outlines bundled with the dashboard (`apps/dashboard/src/world-map.js`, Natural Earth through world-atlas, made by `scripts/world-map.mjs`; no tiles or other requests), one hue light to dark on a log scale, grey for none; and the countries ranked by it with their installs, revenue and purchases. `{show, rows: [{country, key, name, installs, revenue, purchases, installs_pct, revenue_pct}], totals, countries, has: {installs, revenue}, as_of, from_day, to_day, currency, notes}`; `country` is null for a name Glitchless couldn't place |
| | `by_store` | a row per store (most revenue first): revenue, share and purchases, next to the sessions (and players) Glitchless measured on that store's platform (iOS for the App Store, Android for Google Play, macOS for the Mac App Store; over 31 days or less) and revenue per player (per session without player IDs): `{rows: [{store, name, revenue, purchases, share_pct, platform, sessions, players, per_player}], total, players_are_sessions, as_of, currency, notes}` |

`store` is `revenuecat` (the default). A game connected to RevenueCat gets a **Revenue page** (`revenue`, icon `money`)
on the automatic dashboard after the store pages: revenue, revenue per player, installs, active users a day, revenue per
day, MRR, active subscriptions, installs and active users per day, active trials, the players measured (`stat
players`) and revenue by version, in rows of 12 columns. Glitchless Cloud adds it to the
game's saved dashboards on the first connection (`withStorePage`, after the first page, unless a page has a
`store_revenue` panel; taken off, it isn't added again). With `?version=` (which filters the sessions, §3), revenue is
that version's and revenue per player that version's over its players; MRR, subscriptions and trials stay the whole
game's.

**Query** `store_revenue` (`store`, default the first connected source; the usual `version`, `env`, `type`) →
`{connected, store, store_name, sources, app_id, synced_at, currency, version?, overview: {at, currency, metrics}, from_day,
to_day, totals: {revenue, transactions, installs, active_users_per_day, days, incomplete}, latest: {mrr, actives, trials:
{value, day, change, since}}, new_players, new_players_pct, players_per_day, players, sessions, players_are_sessions,
per_player, glitchless: {purchases, events, currency, sandbox, comparable, coverage_pct} | null, days: [{day, revenue,
transactions, installs, active_users, mrr, actives, trials, incomplete?, sessions, players, new_players, purchases}],
versions: [row] | null, versions_why?, countries: [{country, name, installs, revenue, purchases}] | null (the top 50),
countries_as_of | countries_why, stores: [{store, name, revenue, purchases, share_pct, platform, sessions, players,
per_player}] | null, stores_why?, notes}`, or `{empty, why}`. A day's `sessions` are those that started that UTC
day (null over 31 days), its `players` those who played that day, its `new_players` those first seen that day (null
without player IDs). `notes` are plain lines: a currency that isn't the game's, purchase events covering under 80% or
over 110% of RevenueCat's revenue (and why that happens), sandbox purchases left out, how RevenueCat's installs differ
from Glitchless's new players, no player IDs. The MCP tool `glitchless_revenue` reads it.

**Stored** under `STORE#<project>#revenuecat` (§3f's layout): `REV#<month>` (by day: `revenue`, `transactions`,
`mrr`, `actives`, `trials`, `new_customers`, `active_customers`, `currency`, `incomplete`; a day sent again replaces the measures it has), `REVV#<month>`
(`<day>|<version>`: `revenue`, `transactions`, `currency`; a day sent again replaces all of its versions),
`REVC#<month>` (`revenue: {<day>|<country>: {revenue, transactions, name, currency}}`, `installs: {<day>|<country>:
{installs, name}}`), `REVS#<month>` (`revenue: {<day>|<store>: {revenue, transactions, name, currency}}`; a day sent
again replaces that day's countries or stores of what it brings), `SNAP#overview`, `SNAP#charts` (the version, country
and store segments found, the segments the revenue chart has, the currency, and the last day the splits were read:
`countries_day`, `stores_day`) and `META`;
each month item expires 400 days after its month. The sync's own state is `REVENUECAT#<project>` `STATE` (the options
and the last day each chart was read).

**Routes** are the stores' (§3f): `PUT /api/projects/{p}/stores/revenuecat` takes `{rcProjectId, currency?, secretKey?,
service?}` (a key left out stays, `null` removes it); `GET …/stores` gives its `connection` (`rcProjectId`, `currency`,
`keys.secret` hint), `status` and `data` (`overview`: RevenueCat's numbers now).

### 3i. Revenue: Stripe (Glitchless Cloud)

A game that sells through its own Stripe account (a web or PC game's full unlock, DLC, supporter packs; Checkout or a
Payment Link) connects it in Settings → Integrations, and its real revenue sits next to the players and versions
Glitchless measures, like RevenueCat's (§3h, whose Revenue page, panels and query it shares). This is the game's own
account read with the game's own key: Glitchless Cloud's billing (its own Stripe account) is a different thing, and
neither ever sees the other's keys. The core is the same store-neutral
[`server/src/revenue.js`](../server/src/revenue.js), where Stripe is a *payments source*: money as the account settled
it, so refunds, disputes, fees and net next to the revenue, new paying customers instead of installs, revenue by
product and country, and the purchases a game tied to a session, which the core joins to that session's version and
platform. The adapter that calls Stripe is Glitchless Cloud's. Read only: nothing is written to Stripe, and no webhook
is used.

**Connecting.** A **restricted key** (`rk_live_…`, or `rk_test_…` in test mode: Developers → API keys → Create
restricted key) with these set to Read and everything else at None:

| permission (Dashboard) | section | Stripe's name | for |
| --- | --- | --- | --- |
| Balance transaction sources | Core | `rak_balance_transaction_source_read` | listing balance transactions with the payment, refund or dispute behind each (`expand[]=data.source`); it also lets the key read the balance, payouts and transfers, read only |
| Checkout Sessions | Checkout | `rak_checkout_session_read` | the line items (products) of the session that took each payment, and its `client_reference_id` and metadata |
| Products | Core | `rak_product_read` | only when the game's products are picked by a metadata key |

A secret key (`sk_…`, which can do anything in the account), a publishable key (`pk_…`) or a webhook secret
(`whsec_…`) is refused before anything is sent, saying to create a restricted key with the permissions above. The key
is checked with one read on save (`GET /v1/balance_transactions?limit=1&expand[]=data.source`: a deleted key, or one
without the first permission, is refused with the permission Stripe names) and sealed like a store's credentials; the
dashboard gets its last four characters and its mode. **Products** (optional): the game's product IDs (`prod_…`), or
one metadata key its products have (`game=caverun`, or a bare key for any value), for an account that sells other
things too. Then only payments made through Checkout or a Payment Link for those products count, each with the share
of its line items that are the game's (a bundle with another game's product counts in part), and refunds and disputes
with the share of the payment they're for. Without a pick, every payment the account takes counts. A new key (it may be
another account's) or another pick forgets the kept data, and the next sync backfills it.

**Test and live.** A live key only ever reads live payments, and a test key only test ones (Stripe keeps them apart);
the sync also leaves out any source whose `livemode` isn't the key's. A test-mode connection says so wherever it shows:
"Stripe (test mode)" on its panels, a note that these are test payments, a badge on the Integrations page, `mode:
"test"` in the query.

**The sync** (hourly with the stores, the `glitchless-stores` Lambda; `Authorization: Bearer rk_…`, `Stripe-Version:
2026-09-30.endive` on every call, so the shapes read stay fixed whatever the account's default):

| from | call | when |
| --- | --- | --- |
| the game's products | `GET /v1/products?limit=100` (at most 10 pages) | once a day, and at once after the pick changes, when a metadata key picks them |
| the Checkout Sessions that may have taken the window's payments | `GET /v1/checkout/sessions?status=complete&created[gte]=<a day before the window>&created[lt]=&expand[]=data.line_items&limit=100` | every window |
| payments, refunds, disputes, with their fees and net | `GET /v1/balance_transactions?created[gte]=&created[lt]=&expand[]=data.source&limit=100` | every window |
| the session of a refund's or dispute's payment (or of a bank debit that succeeded days after its session) | `GET /v1/checkout/sessions?payment_intent=pi_…&expand[]=data.line_items&limit=1` | when it isn't the window's |

Lists are paged with `starting_after` (the last object of the page) while `has_more`. A sync reads whole UTC days,
oldest first, a week (a *window*) at a time: from the day after the last one closed, at first back the plan's retention
(14, 90 or 400 days), to today. A day closes 30 minutes after it ends; until then every sync reads it again whole, so a
day's numbers are always one whole read of it (a day sent again replaces what was kept). Calls go one at a time, at
most 150 a sync (Stripe allows 100 reads a second, 25 in a sandbox), within the stores' daily budget (1,500 a game). A
window cut short (calls or time out, or a 429, which stops the sync) keeps nothing, and the next sync reads it again.
A key without Checkout Sessions: Read still counts revenue (Last sync says which permission to add), with no products,
countries from the payments only, and no purchases tied to sessions; with products picked, it counts nothing.

**What counts.** A balance transaction's `reporting_category` (else its `type`) says what it is: `charge` a purchase,
`refund` a refund, `refund_failure` a refund that came back, `charge_failure` or `partial_capture_reversal` money
reversed after a payment, `dispute` and `dispute_reversal` a dispute lost and won back; payouts, transfers, top-ups
and the account's own fees (`fee`: Radar, Billing, Tax) are not a game's revenue. Per UTC day (the transaction's
`created`): **revenue** (gross: the purchases' `amount`), payments, **refunds** (and how many), **disputes**, Stripe's
**fees** (the transactions' `fee`: a payment's processing fee, a dispute's fee) and **net** (their `net`). All in the
account's **settlement currency**, as Stripe settled each payment: a payment presented in EUR or GBP counts at the
amount Stripe converted it to. The currency counted is the one most payments settle in; payments settled into another
balance currency are counted apart (`other_payments`) and left out, never converted. Amounts are in each currency's
units (Stripe's smallest unit over 100, 1 for zero-decimal currencies such as JPY and KRW, 1,000 for three-decimal
ones). **New paying customers**: a buyer is counted on the day of their first payment for the game that Glitchless has
read (by their Stripe customer, else their email), kept only as a hash of the game and that ID
(`X#customers-<0…f>`), never the email. **By product**: each payment split between its line items by their amounts
(`description`, else the product's name; "Not through Checkout" for a PaymentIntent of the game's own, which can't name
a product, as can't a subscription's renewal). **By country**: the billing address's country, else the Checkout
Session's customer's, else the card's issuing country (`revenue_countries`, an ISO code with its English name: the
same rows a RevenueCat country split gives, kept in the same `REVC#<month>` items, so the `by_country` map shows them).

**Revenue by version.** Stripe knows nothing of versions, so a game ties a purchase to its Glitchless session: its
server puts the session ID (in a web game `Glitchless.instance.sessionId`, sent with the purchase request) on the
Checkout Session it creates:

```js
stripe.checkout.sessions.create({ ..., client_reference_id: sessionId });
```

or sets `glitchless_session` (or `glitchless_player`, the player ID) in the Checkout Session's or the PaymentIntent's
metadata (Stripe copies a PaymentIntent's metadata to its charge). The sync keeps those purchases
(`revenue_purchases`: day, time, amount, product, and the ID given), and the core joins each, over a window of 31 days
or less (longer ones have no sessions to join, and the panel says so), to the session named, else to the session the
player was in when they paid or that ended within 30 minutes before. `by_version` is then revenue by that session's
version next to Glitchless's players, sessions, crash-free sessions and frame p95, revenue per player, the platforms
the purchases were made on, the players who paid (and their share of those measured), and what wasn't tied to any
session. With `?version=` revenue is the purchases joined to that version's sessions; refunds, fees, net and new paying
customers stay the whole game's.

| panel `type` | fields | shows |
| --- | --- | --- |
| `store_revenue` | `store: stripe`, `measure`: `revenue` | the window's revenue, payments, and net after refunds, disputes and fees |
| | `per_player` | that revenue over the players Glitchless measured |
| | `refunds` | refunds and disputes in the window, how many refunds, their share of revenue |
| | `customers` | new paying customers, next to the new players Glitchless saw |
| | `by_day` | revenue per day with refunds and disputes per day (and the game's own purchase events when comparable); fees, net and new paying customers per day in its CSV |
| | `by_product` | a row per product: revenue, share, payments, refunds (and their share of the product's revenue) |
| | `by_version` | as §3h's, from the purchases tied to sessions, with platforms, players who paid and what wasn't tied |
| | `by_country` | §3h's world map and ranked list, of revenue and payments only (Stripe has no installs, so it shows revenue whatever `show` says; titled "Revenue by country"); payments with no country are listed as "(none)", not on the map |

RevenueCat's `installs`, `active_users`, `mrr`, `actives`, `trials`, `players_by_day` and `by_store` aren't Stripe's (a board
naming `store: stripe` with one is refused; one naming no store says so on the panel), nor are `refunds`, `customers`
and `by_product` RevenueCat's. A game connected to Stripe gets a Revenue page (`revenue`, icon `money`: revenue,
revenue per player, refunds, new paying customers in a row, revenue per day and by product, then by version) on the
automatic dashboard, and on its saved ones on first connection (`withStorePage`). A game with both RevenueCat and Stripe
gets both pages, each titled by its source ("RevenueCat revenue", "Stripe revenue"; a saved page still called
"Revenue" is renamed, one the developer named is not). Revenue panels are sums: a share link shows them only when made
with sums.

**Query** `store_revenue` with `store=stripe` → §3h's `{connected, store, store_name, sources, synced_at, currency,
version?, overview, from_day, to_day, …}` plus `mode` and `products_picked`, with `totals: {revenue, transactions,
refunds, refund_count, disputes, fees, net, new_customers, other_payments, days, incomplete}` (no `latest`), `days:
[{day, revenue, transactions, refunds, refund_count, disputes, fees, net, new_customers, incomplete?, sessions,
players, new_players, purchases}]`, `products: [row]` (or `products_why`), `versions`, `platforms`, `unjoined`,
`payers`, `payers_pct`, `countries: [{country, name, revenue, purchases}]` (or `countries_why`; no `stores`), and
`notes`. `glitchless_revenue` reads it (`source: "stripe"`; without one, every source the
game is connected to).

**Stored** under `STORE#<project>#stripe` (§3f's layout, §3h's items): `REV#<month>` (by day: `revenue`,
`transactions`, `refunds`, `refund_count`, `disputes`, `fees`, `net`, `new_customers`, `other_payments`, `currency`,
`incomplete`), `REVP#<month>` (`revenue: {<day>|<product>: {name, revenue, transactions, refunds, refund_count,
currency}}`), `REVC#<month>` (§3h's, its `revenue` only), `RPAY#<day>`
(`rows`: the day's tied purchases, at most 2,000), `SNAP#overview` (the last 28 days, `days` of them kept: gross volume, payments, refunds,
disputes, fees, net, new paying customers; `mode`; `other_payments`), `X#customers-<0…f>` and `META`; a day sent
again replaces each. The sync's own state is `STRIPE_SALES#<project>` `STATE` (`through`: the last day closed;
`currency`; the products a metadata key picked). The connection is `PROJECT#<project>` `STRIPE_SALES` (not `STRIPE#`,
Glitchless's own billing).

**Routes** are the stores' (§3f): `PUT /api/projects/{p}/stores/stripe` takes `{restrictedKey?, products?, service?}`
(a key left out stays; `products: ""` picks none); `GET …/stores` gives its `connection` (`mode`, `products`,
`keys.restricted: {hint, mode}`), `status` and `data` (`overview`: the last 28 days, `mode`).

## 4. Derived concepts

- **Crash-free session**: a session that didn't crash. A session crashed when the run broke: the WebGL context
  was lost for good, the game stopped (`game_loop_stopped`, or an Unreal `crash`, sent on the next launch), the
  session ended inside a frozen frame (its last `frame_window` has `frozen`), or it ended ≤ 10s after an unhandled
  error (`js`, `promise`, `script`, `exception`) with nothing played after it (a level event, a death, or one of the
  game's own events; the SDKs' own events don't count). A frozen frame the game recovers from is a hitch, and an
  error the player plays through is an error, not a crash.
- **Rage quit**: session ends ≤ 20s after a `death`/`level_fail` with no later `level_start` or `level_complete`. The
  end has to come after the fail: a fail the game logged as it closed, after `session_end`, is not one, and an
  abandon (§2 `level_abandon`) never is.
  It counts at the death behind it (a `level_fail` right after a death is the same moment). A game nobody wins
  (5+ sessions in the range, levels started and failed, none completed: an endless or flappy game) has no rage
  quits: every run ends in a death, and leaving after one is the end of a run.
- **Wall**: a level that far fewer sessions get through than the game's other levels (25 points under their median,
  70% or less). The rate is over the sessions that played it to an end: a session that only abandoned it (§2) is
  left out, as it says nothing about how hard the level is.
- **Climbing gauge**: a `setContext` gauge that, over a session's frame windows (3 or more), ends within 10% of
  its peak, at least 4× and 50 above where it started, and was last at its low point in the first half. Enemies
  come and go between waves; a leak only grows. A gauge that climbs in 60% of the sessions that report it (3 or
  more) is a memory finding, unless it is a progress counter by name (score, time, kills, wave and the like).
- **Hitch**: a single frame > 50ms. **Jank**: a frame > 33.3ms (misses two 60Hz vsyncs).
- **Lag**: the share of a connected player's time with a round trip over 150 ms, from each window's sketch.
- **Lobby spike** (finding `net-lobby-<level>`): each match is cut into 30-second slots; a slot is a lobby spike when at
  least 60% of the match's sessions with network data in it (4 or more) have ping at least twice their own median for
  the match and 50 ms over it; one session alone is a player spike. A level where 10% or more of its matches (5+) have a
  lobby spike gets a finding with the minute it comes most often, and with the servers' tick in those slots (A9): the
  whole lobby lagging points at the server, one player lagging at their connection.
- **Network findings**: one kind of connection, platform or property value whose share of play over 150 ms is 3× the
  rest's with 30+ sessions (`net-link-<link>`, `net-platform-<value>`, `net-prop-<key>-<value>`); a region (the property
  `region`) whose median ping is over 120 ms with 30+ sessions (`net-region-<region>`: no server near it); the share of
  attempts a disconnect ended doubled and up 2 points against the previous version (`disconnect-<version>`), with the
  commonest reason and how far into the attempt they come.
- **Servers now**: a game's servers that sent anything in the last two minutes (players now on its companion service),
  and the players their latest `server_window`s had connected. Next to players now it shows how many players run an SDK.
- **Server findings** (A9, read from the companion): `server-tick-<level>`, servers fall behind when full: on a map, every
  band of players connected from some band up (tenths of `max_players`, 20+ windows each) has 10% or more of its windows
  over budget, and the bands below don't ("Servers on island miss their 30 Hz tick in 34% of windows once 80 or more
  players are connected"); `server-error-<fingerprint>`, a fatal error on server sessions, with the matches open when
  they crashed and the players connected then; `server-leak-<version>`, the climbing-gauge rule on servers' `mem_mb`,
  `net_objects` or a server gauge. The lobby finding adds the servers' tick in its lagging slots.
- **Wall at one value** (finding `design-wall-<level>-<attr>-<value>`): the wall rule across one level's attempts split
  by an attribute of their starts: a value whose sessions get through 70% or less, 25 points under the median of the
  level's other values (each with 10+ sessions that played it to an end), the worst value of each level and attribute:
  "pit_80 with party_size 1 is a wall".
- **Burst**: a counter (§2 `counts`) whose total in a level's frame windows with hitches is twice or more its total in
  calm ones (medians, 3 or more windows with hitches). A window's counts and its frame window share a `ts`, so the
  facts pair them; the level's frame-time finding names the counter in its evidence (`counter_bursts`): "hitches come
  in windows with 300 or so `kill` (a calm window: 40)".
- **Hours played**: the frame windows' `duration_s` added up: the time the game was on screen drawing frames. The
  cells keep it per minute, env, version and level, so it is exact over any range (daily rollups included), overall
  and by version and level; by a session split it comes from each session's own frame windows (31 days or less). A
  game in the background has none, so an idle game's time away isn't play: it sends that as a number
  (`track('return', { away_s })`). Rates per hour played divide by it (§3b).
- **Rate interval**: a rate's 95% Wilson interval, so 54% of 40 matches isn't read as surely as 54% of 4,000. A row is
  out of line when its interval leaves out the line it is read against (§3b).
- **GPU tier**: `high` (discrete NVIDIA/AMD, Apple M-Pro/Max), `mid` (Apple M base, recent Intel Iris/Arc), `low` (old Intel HD/UHD, mobile Mali/Adreno/PowerVR, a Steam Deck), `software` (SwiftShader/llvmpipe).
- **Retention** (D1, D7, D30): of the players first seen on a UTC day (a cohort), the share that played again on the
  1st, 7th and 30th day after it. Only players with an ID count (install or full mode, §4b): an anonymous session is
  filed under its own ID. A player's first-seen day is the day of their first event the store has (its first-seen
  index, which lasts as long as the store keeps data: the plan's retention on Glitchless Cloud, so a player gone
  longer than that is new again). They join that day's cohort
  when a session of theirs in the selection (env, version) started on it, as sessions count on the day they start.
  A cohort is a whole day of the range, and its Dn is null until day N has ended inside the range. Up to 31 days it
  is exact from session states; past 31 days a store with daily rollups (§7) reads each day's sample of new players
  against the days' samples of active players, exact while small and named in `meta.approximate` (`retention`) once
  capped.
- **Release order**: how versions are compared, oldest to newest, the same whatever the range: by when the store first
  saw each version (the time of its earliest event, from the store's version first-seen index, §6). A range that
  starts after a release, while players of the version before it still play, often sees the new version first; the
  version finding, the `versions` query (and `glitchless_compare_versions`, which compares its last two), the alerts'
  release rule and the weekly summary still compare the new version against the old one. A version the index has no
  sighting of (one the game already had when the index began) came before every version it has, so it goes first.
  Without sightings, versions that all read as version numbers (`1.2`, `1.10.0`, `2.0.0-beta.3`) go in version order,
  a pre-release before its release; anything else (commit hashes, names) in the order the range first saw them.
- **Players now**: sessions that sent anything in the last two minutes, counted as batches arrive. The open-source
  server counts in memory, per process; Glitchless Cloud counts across every server instance (whole minutes: this
  one and the two before) through the `auth.playersNow` hook.
- **Property lean**: a finding names a session property (§2 `props`) when most of the problem falls on one value: of
  the sessions it hit (an error issue's sessions, a wall's sessions that never got through), 60% or more and 5 or
  more have that value, at least 1.5× its share of every session (`evidence.property: {key, value, sessions,
  share_pct, all_pct}`; "Most of it falls on class necromancer: 82% of the sessions it hit, against 30% of all
  sessions"). Over 31 days or less.
- **Slow setting** (finding `perf-prop-<key>`): a session property with 2 to 10 values, each with 20+ sessions that drew
  frames, where one value's frame p95 is 1.5× the rest's and over the frame budget ("Frame time on preset ultra is 41
  ms for the slowest 5% of frames, against 18 ms on the rest").
- **Platform**: Valve's hardware named by Steamworks (`steam_hardware`: Steam Deck, Steam Machine, Steam Frame, §4c),
  else a Steam Deck (`steam_deck`), whatever OS the build is for, else the OS. Performance breaks frame times down by
  it (`by_platform`).

## 4b. Privacy levels

This is the one definition every SDK follows (the browser, Godot, Unity and Unreal SDKs, and any SDK added later):
the same levels, the same ID and the same Steam Deck rule. `session_start` says which level (`privacy`), and each
SDK's PRIVACY.md lists exactly what it sends at each.

| | anonymous (default) | install | full |
| --- | --- | --- | --- |
| `player_id` | null: the server files the session under its session ID | the **player ID**: random `p_` + 12 characters `[a-z0-9]`, made on first launch and kept on the device | the same stored ID |
| kept in | nothing; an ID another build left is deleted | browser `localStorage['glitchless.pid']`; Godot `user://glitchless/player_id`; Unity `persistentDataPath/glitchless/player_id` (PlayerPrefs `glitchless.player_id` in WebGL builds); Unreal `Saved/Glitchless/player_id` | the same |
| session ID | random per launch, in memory only | random per launch, saved with unsent batches until they go | the same as install |
| device | coarse: OS, tiers, screen, renderer, `steam_deck` | as anonymous | adds model, OS version, GPU, cores, memory |
| positions | off (on with `positions`) | as anonymous | on |
| unsent batches on the device (engine SDKs; the browser keeps none) | without the session or player ID (each keeps its own `batch_id`, §2) | with their session and player IDs | the same as install |

Install mode adds one thing to anonymous mode, the stored player ID (and, since that ID is on the device anyway,
unsent batches keep their IDs), so retention (D1, D7, D30, §4) can be counted without knowing who the player is: the
ID is random, made by the SDK, and tied to no account, device or advertising ID. Install and full mode share it, so a
game that moves between them keeps its players; anonymous mode deletes it. The browser, Godot and Unity SDKs can
reset it (`resetInstallId()`, `reset_install_id()`, `Glitchless.ResetInstallId()`): that deletes the stored ID, the
session in progress keeps sending the ID it started with (so it is never split), and the next launch makes a new ID
that nothing links to the old one. Where nothing can be stored (a browser that blocks localStorage) the ID lasts one
launch.

**Turned off.** In every mode a player can turn Glitchless off, and back on, from the game's settings (§4d): off sends
nothing more and drops what was waiting. Once the game has called it, the choice is saved on the device as `on` or
`off`, which holds nothing about the player.

**Properties** (§2 `props`) go with the session in every mode, as event attributes do: the game's words about the
session (its mode, a rank tier, a class, the server region), never about the person. In anonymous mode nothing ties one
session's properties to another session's. The SDKs and intake drop keys that name a person or a device and values
shaped like an email address, a phone number, a link or an ID, and a property with more than 200 values on a day is
treated as the ID it is (`(too many values)`, §3b).

**Steam Deck.** A Steam Deck is one when Steam says so (`SteamDeck=1`, set under Steam and Proton), the board is
Valve's Jupiter (LCD) or Galileo (OLED) (`/sys/class/dmi/id/board_vendor` and `board_name`), or the OS is SteamOS
(`ID=steamos` in `/etc/os-release`); a Windows build under Proton reads the same files through Wine's `Z:` drive. On
one, in every mode, the engine SDKs send `steam_deck: true` (and `false` elsewhere), `gpu_tier: "low"`, and
`os: "SteamOS"` when it runs SteamOS or Steam set `SteamDeck` (a Deck under another Linux keeps its OS name). The
browser SDK sends `steam_deck: true` when the browser shows the Deck's GPU (AMD Custom GPU 0405 or 0932,
"vangogh") or a user agent names it, with `gpu_tier: "low"`, and nothing when unsure. Only these fields are sent,
never what they were read from.

**Where an iOS build came from.** A TestFlight build is a release build, so it reports the game's `prod` environment
like an App Store install, and its purchases are free sandbox ones. The engine SDKs (Godot, Unity, Unreal) tell them
apart in every mode, with no native plugin, from three files the app can already see, checking only that they are
there:

| | `StoreKit/receipt` in the data container | `StoreKit/sandboxReceipt` there | `embedded.mobileprovision` in the bundle | `distribution` |
| --- | --- | --- | --- | --- |
| App Store | yes: Apple writes it with every App Store install | | | `app_store` |
| TestFlight (and App Review, which installs the same way) | | after a sandbox purchase | | `testflight` |
| Xcode, ad hoc or enterprise profile, the Simulator | | after a sandbox purchase | yes (the Simulator: its path says so) | `development` |

So a receipt means the App Store, a profile means a development build, and no receipt on an iPhone or iPad (a data
container under `/var/mobile/Containers/Data/Application/`) means TestFlight. An iPad app on a Mac without a receipt
can't tell and sends no `distribution`. The data container is `$HOME` (Godot `user://` and Unity's
`persistentDataPath` are its `Documents`); the SDKs look in the bundle's `StoreKit/` too. One install is misread: an
App Store app restored from a local backup without a network has no receipt until it gets one, so it reads as
TestFlight until then. A TestFlight or development install's session is `tester` unless the game sets a session type
or a bot flag makes it `synthetic`, and a purchase made in it says `sandbox: true` (§3b). Players' numbers (findings,
share links) read `user` sessions, so testers stay out of them; `type=tester` finds them (§3).

Apple deprecated `appStoreReceiptURL` in iOS 18 for `AppTransaction`, whose `environment` (`production`, `sandbox`,
`xcode`) is the API's own answer; it is Swift-only and asynchronous, so it needs a native plugin in every engine. The
receipt file is still written. Should Apple ever stop writing it, App Store installs on a phone would read as
TestFlight, and the SDKs would have to read `AppTransaction` through a plugin instead.

**Google Play's testing tracks** can't be told apart on the device. Internal, closed and open testing install from the
Play Store like production (`InstallSourceInfo` names `com.android.vending` as the installer and the store as the
source on every track), and nothing on the device says which track a build came from. A licence tester's test
purchase is marked only server-side (the Play Developer API's `purchaseType` 0) or by a billing library that asks it
(RevenueCat's `isSandbox`), so a game passes that on as `sandbox: true`, and a build for a testing track can send its
own `env` (`beta`) or version. Firebase Test Lab phones (the pre-launch report) are already `synthetic` (§5).

## 4c. Steam facts

A game that already uses Steamworks gets Steam facts on each session, so every chart, filter and comparison can split
by Steam build, beta branch and Steam hardware. Each SDK reads only what the game has set up, with no dependency on
Steam: nothing until Steamworks is initialised, and nothing at all without it. They go in `session_start.device`, in
every privacy mode, each only when the game's wrapper has the call:

| field | from | value |
| --- | --- | --- |
| `steam_build` | `ISteamApps::GetAppBuildId` | the Steam build ID; left out when 0 (not a build downloaded from Steam) |
| `steam_branch` | `ISteamApps::GetCurrentBetaName` | the beta's name, or `public` on the default branch |
| `steam_hardware` | `ISteamUtils::IsRunningOnSteamHardware` (SDK 1.65), before it `IsSteamRunningOnSteamDeck` | `deck`, `machine`, `frame` or `none` |
| `proton` | `ISteamUtils::IsRunningUnderProton` | true or false |
| `big_picture` | `ISteamUtils::IsSteamInBigPictureMode` | true or false |
| `steam_controller` | `ISteamInput::GetInputTypeForHandle` of the first connected controller, once the game has started Steam Input | `steam_controller`, `xbox_360`, `xbox_one`, `generic_xinput`, `ps4`, `apple_mfi`, `android`, `switch_joycon_pair`, `switch_joycon_single`, `switch_pro`, `mobile_touch`, `ps3`, `ps5`, `steam_deck`, `steamos_handheld`, `switch2_pro`, `steam_controller_2026`, `steam_frame_controllers`, `unknown`, or `other` for a newer type |
| `family_shared` | `ISteamApps::BIsSubscribedFromFamilySharing` | true or false |
| `timed_trial` | `ISteamApps::BIsTimedTrial` | true or false (not the seconds) |
| `steam_language` | `ISteamApps::GetCurrentGameLanguage` | the game's Steam language, such as `english` or `schinese` |

**No Steam ID, ever.** No SDK reads the player's Steam ID, the app's owner (`GetAppOwner`) or their name, in any mode.
Valve's rules on sending Steam IDs to third parties are unclear, so none is sent; each PRIVACY.md lists the fields and
has lines a game can adapt for its own privacy policy.

**Where they come from.** Unity: Steamworks.NET (after `SteamAPI.Init`, or once its `SteamManager` says initialised)
or Facepunch.Steamworks (`SteamClient.IsValid`), found by reflection. Godot: the `Steam` singleton GodotSteam registers
(`Engine.has_singleton("Steam")`), once `get_steam_init_result()` says OK or `current_app_id` is set. Unreal: only
while the `SteamShared` or `OnlineSubsystemSteam` module is loaded, through Steam's flat C API in the steam_api
library that module loaded (the plugin links nothing of Steam's). Browser: steamworks.js in Electron, only from the
client the game passes as `steam` (steamworks.js aborts the process if called before its `init()`, so the SDK never
probes for it); it has no family sharing, timed trial, Proton or Steam hardware calls, so those are left out. An
engine SDK reads them when `session_start` is built and again until Steamworks answers, so a game that initialises
Steam after Glitchless still sends them.

**Version.** A game that passes no version to init reports `steam-<build>` (`steam-18231`) when it runs a Steam build,
so version comparisons work build by build out of the box; a version the game passes always wins, and without a Steam
build the SDKs fall back as before (Application.version, `application/config/version`, the project's version).

**Server.** Intake keeps the facts in one shape (`server/src/ingest.js`: a build is a positive integer, the hardware
one of the four words, flags booleans, words trimmed and capped) and `steam_hardware: deck` sets `steam_deck: true`.
Every query takes them as filters (§3); boards split breakdowns by them (`$steam_branch`) and versions panels and the
`versions` query compare branches or builds (§3b). The platform (§4) is `Steam Deck`, `Steam Machine` or `Steam
Frame` from `steam_hardware`, else the SDKs' `steam_deck` tag finds a Deck. Filters and comparisons by them read
sessions: a store that keeps hour summaries reads raw events for a filter (as for session types), and a range of more
than 31 days is answered over its last 31 days (`meta.note`); `by_steam_branch` and `by_steam_build` in performance
work over any range. A breakdown by a Steam fact counts events per session, so a series can't be split by one, and
sums (kept per minute and currency) aren't split by one either.

## 4d. The player's off switch

Every SDK that runs on a player's device has one call for a "Share performance data" toggle in the game's settings,
so a player can turn Glitchless off at any time and back on: the browser's `glitchless.setEnabled(on)`, Godot
`Glitchless.set_enabled(on)`, Unity `Glitchless.SetEnabled(on)`, Unreal `FGlitchless::SetEnabled(bOn)` (Blueprint
**Set Enabled**), GameMaker `glitchless_set_enabled(on)`. It is the player's choice, on top of the developer's: Init,
its `enabled` option, an intake and the off flags (`--glitchless-off`, a build that sends only with `--glitchless`)
still decide whether a build sends at all. The switch can turn a build that sends off; it never turns on one that
doesn't. A call that changes nothing (on while on, off while off) only saves the choice, so a game may call it with
its saved setting every time it starts.

**Off** (`setEnabled(false)`):
- The choice is saved on the device first (below).
- Nothing more is measured or sent, from that call on: no frames, hitches, errors, events, counts, positions or
  network samples are kept, and no request of any kind goes out, `GET /v1/health` included. Every call stays safe and
  does nothing. The bug report form doesn't open, and a bug report from the game's own UI answers `off`. Measuring
  for an agent (`measure()`, `--glitchless-measure`) has no frames to measure and says Glitchless is off.
- Everything waiting is dropped: the events queued in memory, the open frame window with its counters and positions,
  hitches waiting for their causes, counters waiting for `GET /v1/health`, batches waiting to be sent again, and the
  outbox on the device (the engine SDKs; a server role's too), bug reports in it included. A request already on its way
  can't be called back; its answer is ignored.
- The session ends without a `session_end`, and a level going ends without a `level_abandon`: after the player says
  no, nothing more is sent. The server sees the session go quiet, as when a game is killed. It isn't counted as a crash
  (that takes a fatal error, §4).
- What the game has said stays in memory, unsent: the level, properties, groups, zone and gauges, so a session started
  later carries them.
- The player ID (install and full mode, §4b) stays on the device, so a player who turns Glitchless back on is still
  one player. Forgetting it is the separate reset setting (`resetInstallId()`, where the SDK has it).

**On** (`setEnabled(true)`, after off): the choice is saved, and a new session starts in the same launch, as after a
long time in the background: a new session ID, its own `session_start` (with the properties still set), a `group` event
for each group still set, and measuring from the next frame. The level stays the current one, so events carry it, but
the attempt that was going when the player turned Glitchless off isn't open in the new session: until the next level
start, a `level_complete`, `level_fail` or `level_abandon` for that level is dropped, so no outcome arrives without its
start. No `load` is sent in the new session: a load is only true of a launch measured from its start, so a launch
that started off, or was turned off before its first batch, sends none at all.

**Remembered across launches.** The SDK saves the choice on the device and reads it before anything else when it next
starts. So a player who turned Glitchless off sends nothing at all from the first frame of every later launch (not the
outbox of an earlier launch, not a health check) until the game turns it on again. The SDK keeps it, rather than the
game passing it to Init each launch, because:
- Glitchless often starts before the game reads its own settings: Unreal from Project Settings with the engine, Unity
  before the first scene (and from its Bootstrap component without a line of the game's code), Godot as an autoload,
  and it sends the last launch's outbox, a crash among it, as soon as it starts. A choice passed to Init would have to
  be read and passed ahead of all that in every engine, and a game that forgets the line would send for a player who
  said no. Kept by the SDK, the off switch holds however the game is wired;
- it is the same rule in every engine, so each PRIVACY.md and the store answers can say once that a player who turns it
  off sends nothing more.

The game still owns its toggle: it can keep the setting with its others and call `setEnabled(saved)` as it starts
(changing nothing else when the two agree), and read the switch back with `isEnabled()` (below).

| SDK | saved in |
| --- | --- |
| browser | `localStorage['glitchless.enabled']`; where storage is blocked, the choice lasts the page load, so the game passes its own setting with `setEnabled(saved)` after `init` |
| Godot | `user://glitchless/enabled` |
| Unity | `persistentDataPath/glitchless/enabled` (WebGL: PlayerPrefs `glitchless.enabled`) |
| Unreal | `Saved/Glitchless/enabled` |
| GameMaker | `glitchless/enabled` in the save area |

It holds `on` or `off` and nothing else, the same on every device that made the same choice, so it ties nothing to
anyone. It is kept in every privacy mode, and only once the game has called `setEnabled`. An outbox found at start
while the choice is off is deleted unread.

**Asking first** (`optIn`). With `optIn: true` (Godot `"opt_in": true`, Unity `OptIn = true`, Unreal `bOptIn` and the
project setting **Opt In**, GameMaker `opt_in: true`), a device with no saved choice starts off: nothing is measured,
kept or sent until the game calls `setEnabled(true)`, for a game that asks the player before collecting anything.
Without it, Glitchless is on until the player turns it off. A saved choice wins over both. A game server has no
player to ask, so `optIn` leaves it on (a game's player and server builds can share their options). Unity's automatic start
and Godot's autoload (both measure before `Init`) read the saved choice too, and keep no early frames for a player who
turned it off; with `optIn` they learn of it only at `Init`, and drop what they kept then.

**Reading it.** `isEnabled()` (Godot `is_enabled()`, Unity `Glitchless.Enabled`, Unreal `FGlitchless::IsEnabled()` and
Blueprint **Is Enabled**, GameMaker `glitchless_is_enabled()`) is true while Glitchless is on: the build sends (it has
an intake and wasn't turned off at Init or by a flag) and the player hasn't turned it off. In a build that sends nothing, such as Godot or GameMaker run from the editor
without `--glitchless`, it is false whatever the player chose, so a settings menu shows the game's own saved setting
(or `isEnabled()` in a build that sends).

**Servers.** A game server role (Godot, Unity, Unreal) follows the same switch: Godot and Unity read the same file
(the role is known only at Init, after the choice is read), an Unreal dedicated server its own
`Saved/Glitchless/Server/enabled`; an Unreal listen server's own session follows the player's switch, since it runs
on their machine. The Node server SDK has none: a
server's operator who doesn't want it doesn't call `init`.

**What it doesn't touch.** What was sent before the player turned Glitchless off stays on the server for the game's
retention (§6); a player who wants it deleted asks the game's developer.

## 5. Godot SDK

`godot/addons/glitchless` sends the same envelope with `"sdk": "glitchless-godot/0.5.1"` and the same event types. See its [README](../godot/addons/glitchless/README.md) and [PRIVACY.md](../godot/addons/glitchless/PRIVACY.md). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default), and the server files the session under `session_id`; install and full mode send the stored `p_…` player ID (`user://glitchless/player_id`, §4b) |
| off switch | `Glitchless.set_enabled(on)`, `is_enabled()` and the `opt_in` option (§4d). The choice is saved in `user://glitchless/enabled` (a dedicated server reads the same file: the role is known only at `init`, and the choice is read before the first frame) and read by the autoload before it measures anything, so a player who turned it off has no early frames kept; with `opt_in` and no saved choice, `init` drops what was kept before it. `enabled`, the build's own switch (`init`'s `enabled` option, off in debug builds unless `--glitchless`), is false while the player has it off |
| `session_start` | `session_type` is `synthetic` with `--autoplay`, `--glitchless-synthetic`, `--glitchless-measure`, headless (except a dedicated server's, below), or on Google Play's pre-launch report phones (the Android system setting `firebase.test.lab` is `true`, read through the AndroidRuntime singleton, or the GPU is a software renderer such as SwiftShader; neither is sent), else `tester` on a TestFlight or development install on iOS (§4b), unless the game passes `session_type`. `props`: the properties set before the first batch, when there are any |
| `session_start.device` | `browser: "Godot"`, `browser_version` (engine), `os`, `mobile`, `device_tier`, `gpu_tier`, `renderer`, `driver`, `screen`, `dpr`, `refresh_hz`, `steam_deck` (§4b: `os` is `SteamOS` on a Deck running it), `distribution` (iOS, §4b: the files are looked for from `$HOME` and `OS.get_executable_path()`'s folder); full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. With GodotSteam, the Steam facts (§4c). `page` and `nav_ms` are null. `refresh_hz` is the screen's rate as the OS reports it, its highest, not the rate the game ran at (some 60 Hz iPhones report 120; a ProMotion iPhone in Low Power Mode runs at 60): that is each `frame_window`'s `hz` |
| `frame_window` | adds `gpu_ms` (Vulkan and Direct3D 12 only: Godot doesn't time the GPU on Metal or OpenGL), `process_ms`, `physics_ms`, `objects`, `nodes`, `orphan_nodes`, `resources`, `video_mb`, `texture_mb`, `screen`, `window`; `heap_mb` is static memory (debug builds only, else null); `geometries`, `textures`, `programs` are null; `ctx` also holds `nodes`, `orphan_nodes`, `objects`. The top-level counts are the values when the window closed; `ctx` holds each gauge's highest value in the window, so a leak check compares like with like (the top-level counts, or ctx's maxima). `hz` and `budget_ms` are measured from the frames: the 20th percentile of frame times under 100 ms (a frame can take longer than the screen's interval, never less), a first guess after 30 frames, the answer at 120, a look every 480 frames that only ever goes faster, and lowered when the OS says the screen slowed down (Low Power Mode). A window never spans two levels |
| `hitch` | `causes` from `shader_compile`, `scene_change`, `node_spawn`, `script`, `physics`, `render`, `gpu_or_os`, `frozen`; adds `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `pipeline_compiles`, `nodes_added`; `loaf` is empty |
| `load` | `ts` is the first frame; `ttff_ms` counts from the engine's start; `first_launch` from `user://glitchless/launched` (the version that last ran) |
| `error` | `kind`: `script` (GDScript runtime error; unhandled, like `js`), `engine`, `push_error`, `shader`, `manual`, `warning`; adds `recent` (last 6 game events) |
| `death` | `x`, `y`, `z` only when positions are on (full mode or `positions: true`); the server leaves unplaced deaths off heatmaps and hotspots |
| `session_end` | `reason`: `background`, `close`, `quit`, `measure` |
| `level_abandon` | `level_abandon()`; sent by itself, with `reason` `background`, `close` or `quit`, before `session_end` when a level is open (§2) |
| `custom` | also `screen_change`, `app_resume`. `track()` adds `sandbox: true` to a purchase in a TestFlight or development install (§3b) |
| `bug_report` | `bug_reports` in init options adds the F8 form: a `CanvasLayer` that pauses the tree while open, with `bug_report_opened` and `bug_report_closed` signals. `report_bug(note)` sends one from the game's own UI. `screenshot` is the root viewport's last frame with its longer side at most 960 px (the browser caps the width), none in headless runs |
| `counts` | `count(name, what = null, n = 1)`: `what` is a dictionary or one word (`what`). Each window (the `flush_interval` window, and up to each `level_start`) keeps an entry per name and group (its string and boolean attributes, the first 4), sums its numbers (the first 4) as passed, and adds `n` (at most 1,000,000 a call). 64 entries a window; past that a known name's new group goes under its attributes as `(other)`, and a new name's `n` goes to `dropped`. One `counts` event per window that counted anything: `ts` and `duration_s` are the window's, each entry `{name, attrs, n, sums?, first_ts}`. A debug build warns once when one name is tracked over 20 times a second. Not sent, with one warning, to a server whose `features` lack `counts` |
| `props` | `set_property(key, value)`, `set_properties(dict)`, the `properties` option; null removes. Checked in `properties.gd`: keys `^[a-z][a-z0-9_]{0,31}$`, 12 a session; values a string (trimmed, cut to 64), a boolean or a whole number within ±1,000,000 (a whole float becomes an int; fractions are dropped); the reserved keys of the design (A6) plus `zone`, `match`, `party`, `run` and every Steam fact; the identifying keys; and values shaped like an email, a URL (`scheme://` or `www.`), a phone number (a run of digits, spaces and `().-` holding 7+ digits), 7+ digits in a row, a UUID, 16+ hex characters with a digit and a letter, or 16+ base64 characters with a digit, a capital and a small letter. A dropped one warns once in a debug build. Later changes: one `props` event a window at most, with the changed keys and null for removed ones. Nothing is stored; a new session (back after `session_timeout`) carries them in its own `session_start` |
| `group` | `set_group(kind, id = "", attrs = {})` returns the ID sent. `set_group("run")` makes `r_` and 12 characters; a run ID passed back resumes it in install and full mode, and is swapped for a new one in anonymous mode; both say `resumed: true`. Match and party IDs (8–64 of `[A-Za-z0-9_.:-]`, else dropped) are sent as `h_` and the first 24 hex characters of SHA-1 over the lowercased service, `:` and the ID (every SDK: `zoomies` and `m_8f2c91d04ab7` give `h_d8a6ac978165726ac21a722b`), so a server and its clients on any engine send one ID; `hash_group_ids: false` sends them as they are. Setting or clearing a group closes the window. While set, every event, window, counts, props and bug report carries `match`, `party` or `run` (`load` and `session_start` don't). Groups set before `init()` go out then; a new session sends a `group` event for each still set |
| `level_start` | `level_start(level, attrs = {})`: `attrs` as given, left out when empty |
| `zone` | `set_zone(name)` (null or "" clears; cut to 64): every event and window carries `zone`. A new zone closes a window that has run a second or more, so a window never spans two zones unless the player crosses back and forth within a second |
| `frame_window.net` | read once a second from `get_tree().get_multiplayer().multiplayer_peer` (`network: true`, the default), by class name and ClassDB constants, so a build without ENet loads. ENet client: `get_peer(1).get_statistic()` `PEER_ROUND_TRIP_TIME`, `PEER_ROUND_TRIP_TIME_VARIANCE` (`jitter_ms`), `PEER_PACKET_LOSS` / `PACKET_LOSS_SCALE`; bytes from the host's `pop_statistic(HOST_TOTAL_SENT_DATA / HOST_TOTAL_RECEIVED_DATA)`, which resets them. WebSocket and WebRTC give no round trip: `net_sample(rtt_ms, loss_pct, jitter_ms)`. `rtt` is a sketch at `a: 0.05`; `transport` `enet`, `websocket`, `webrtc` or `custom`; `link` is always null; a listen server's host sends `host: true` with round trips of 0. No `net` on a window that was never connected |
| `disconnect`, `reconnect` | from the MultiplayerAPI's signals: `peer_disconnected(1)` then `server_disconnected` is a drop; `server_disconnected` alone is the game closing its own connection, and sends nothing. ENet: data arriving with the drop (the server's disconnect) is `server_closed`, none is `timeout`; WebSocket: close code 1000 or 1001 is `server_closed`, else `connection_lost`; `connection_failed` is `failed_to_connect`. Recorded at the end of the frame, so `net_disconnect(reason)` from the game's own handler wins (`disconnect` is Object's own method). `connected_s`, and `rtt_p95` and `loss_pct` of the window so far, else the last. With a level open: `level_abandon` reason `disconnect`, and the game's fail or abandon for that attempt is dropped. `reconnect` (`after_s`) on connecting again within 300 s; back in the same level, it plays on. 20 a session; `net_reconnect()` for other netcode |
| server mode | `role: "server"`, a dedicated-server export (`OS.has_feature("dedicated_server")`), `--glitchless-server` or a bare `--server` (`role: "player"` overrides). The envelope adds `role: "server"` with the game's own `service` (intake files it under `<service>.server`) and `player_id: null`; privacy is anonymous, positions, bug reports and rage input are off, and headless is `user`. `session_start.server`: `tick_hz` (`Engine.physics_ticks_per_second`), `max_players` (option), `build` (`dedicated`, `headless` or null), `region` (option, checked as a property value), `host {os, cores, memory_gb}`. `server_window` in place of frame windows, hitches, positions and `load`: a tick runs from Glitchless's first `_physics_process` to the next one or to the frame's first `_process`, so the physics step is in it; adds `budget_ms`; `players` from `multiplayer.get_peers()` or `set_players(n)`; `rtt_p95` over each peer's ENet round trip, sampled once a second; `in_kbps`/`out_kbps` from the ENet host; `mem_mb` and `cpu_pct` (percent of one core) from `/proc/self` on Linux (elsewhere `mem_mb` is static memory, debug builds only); `net_objects` null. A session is cut every 6 hours (`session_end` reason `max_duration`), or per match with `session_per_match` (reason `match_end`). Nothing is sent until `GET /v1/health` lists `server_mode`; a server that answers without it gets nothing, and the batches are dropped with one warning. Unsent batches go to `user://glitchless/server_outbox.json` |
| `features` | `GET {intake}/v1/health` when `init()` runs, and again after the next batch is taken (a dedicated server: every 15 s) until it answers: `features` as an array of names or an object of booleans |

## 5b. Unity SDK

`unity/Packages/gg.glitchless.sdk` (Unity 6.3 LTS and later) sends the same envelope with `"sdk": "glitchless-unity/0.5.1"`. See its [README](../unity/Packages/gg.glitchless.sdk/README.md) and [PRIVACY.md](../unity/Packages/gg.glitchless.sdk/PRIVACY.md). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default); `Privacy.Install` and `Privacy.Full` send the stored `p_…` player ID (§4b). `batch_id` (§2) on every batch, kept through retries and saved with the batch in every mode. A server (below) adds `role: "server"` and always sends `player_id` null |
| off switch | `Glitchless.SetEnabled(bool)`, `Glitchless.Enabled` and `GlitchlessOptions.OptIn` (§4d). The choice is saved in `persistentDataPath/glitchless/enabled` (WebGL: PlayerPrefs `glitchless.enabled`) and read by the automatic start, so a player who turned it off has no early frames kept. `GlitchlessOptions.Enabled = false` and `--glitchless-off` still turn a build off whatever the player chose |
| `session_start` | `session_type` is `synthetic` in batch mode (not on a server: below), with `--autoplay`, `--glitchless-synthetic`, `--glitchless-measure`, or on Google Play's pre-launch report phones (Android's `firebase.test.lab` setting is `true`, read through `UnityPlayer.currentActivity`'s content resolver, or the GPU is a software renderer such as SwiftShader; neither is sent), else `tester` on a TestFlight or development install on iOS (§4b), unless the game sets `SessionType` |
| `session_start.device` | `browser: "Unity"`, `browser_version` (engine), `os`, `mobile`, `device_tier`, `gpu_tier`, `renderer` (`built-in`, `urp`, `hdrp`), `driver` (graphics API), `screen`, `dpr` (null), `refresh_hz` (`Screen.currentResolution`'s rate as the OS reports it, not the rate the game ran at: that is each `frame_window`'s `hz`), `steam_deck` (§4b: `os` is `SteamOS` on a Deck running it), `distribution` (iOS, §4b: the files are looked for from `$HOME` and `Application.dataPath`'s folder, with no native plugin); full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. With Steamworks.NET or Facepunch.Steamworks, the Steam facts (§4c). `page` and `nav_ms` are null |
| `frame_window` | frame times from `Time.unscaledDeltaTime`; adds `process_ms` (Update to LateUpdate), `physics_ms` (FixedUpdate and physics), `render_ms` (PostLateUpdate), `gpu_ms`, `setpass_calls`, `batches`, `gc_collections`, `gc_alloc_kb`, `materials`, `objects`, `game_objects`, `gc_reserved_mb`, `system_mb`, `screen`, `window`; `geometries` is the mesh count and `heap_mb` the GC heap; counts Unity only has in development builds are null in release builds. `ctx` also holds `game_objects`, `meshes`, `materials`. `gpu_ms` comes from `FrameTimingManager` (Frame Timing Stats on; the latest frame the GPU finished). The memory and object counts are their values when the window closed (sampled every 30 frames); `ctx` holds each gauge's highest value in the window. `hz` and `budget_ms` are measured as Godot's (§5). A window never spans two levels |
| `hitch` | `causes` from `gc`, `shader_compile`, `scene_change`, `object_spawn`, `script`, `physics`, `render`, `gpu_or_os`, `frozen`; adds `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `gc_collections`, `gc_alloc_kb`, `shader_compiles`, `objects_added`; `loaf` is empty |
| `level_start` | also sent when a scene that reads as a level becomes active (with no `attrs`); `Glitchless.LevelStart(level, attrs)` adds `attrs`, what the attempt is (`tier`, `party_size`, a build as a list), with the rules of `custom` attributes. The outcome and deaths don't repeat them |
| `level_abandon` | `Glitchless.LevelAbandon()`; sent by itself, with `reason` `background` (phones), `quit` or `measure`, before `session_end` when a level is open (§2), and `disconnect` when the connection drops mid-level (below); a scene level closes silently when its scene unloads |
| `load` | `ts` is the first frame; `ttff_ms` counts from Unity's start (`Time.realtimeSinceStartup` at the end of the first frame); `first_launch` from `persistentDataPath/glitchless/launched` (PlayerPrefs `glitchless.launched` in WebGL) |
| `error` | `kind`: `exception` (uncaught; unhandled, like `js`), `log_error`, `assert`, `manual`, `warning`; adds `recent` (last 6 game events) |
| `death` | `x`, `y`, `z` only when positions are on |
| `session_end` | `reason`: `background` (phones), `quit`, `measure`; a server's `max_duration` and `match_end` (below) |
| `custom` | also `screen_change`, `app_resume`. `Track()` adds `sandbox: true` to a purchase in a TestFlight or development install (§3b) |
| `bug_report` | `BugReports` in the options adds the F8 form: IMGUI (no EventSystem), with `Time.timeScale` 0 and the Input System's actions off while open, and `OnOpen`/`OnClose`. `Glitchless.ReportBug(note)` sends one from the game's own UI. `screenshot` is `ScreenCapture` at the end of the frame with its longer side at most 960 px, none with `-nographics` |
| `counts` | `Glitchless.Count(name, what, n)` counts a stream on the device: one `{name, attrs, n, sums?, first_ts}` entry per name and group in each frame window (a level start, `SetZone` and `SetGroup` close it), sent as one `counts` event with the window's `ts`, `level` and `duration_s`. The group is the call's string and boolean attributes, the first 4 by key; the first 4 numbers are added up as given; `n` (up to 1,000,000 a call) is how many events the call stands for. Past 64 entries a new group of a name already counted goes under it with every attribute `(other)`, and a new name's events are added to `dropped`. Counters wait for `GET /v1/health` to list `counts` (below): a server that doesn't gets none, and a debug build says so once. A debug build also says once when one name is sent with `Track` more than 20 times a second |
| `props` | `Glitchless.SetProperty(key, value)`, `SetProperties(dict)` and `GlitchlessOptions.Properties`, in every mode: `session_start.props` holds those set before the session's first batch, and later changes go out as one `props` event a window, `{props}` with only the keys that changed and `null` for a key removed (set and changed back within a window sends nothing). Values are a string (trimmed, cut to 64), a boolean or a whole number from -1,000,000 to 1,000,000; an enum goes as its name. Dropped, with one debug-build warning each: keys that don't match `^[a-z][a-z0-9_]{0,31}$`; the built-in splits (`version`, `level`, `zone`, `env`, `platform`, `browser`, `device_tier`, `session_type`, `privacy`, `role`, `link`, `type`, `players`, `sessions`, `hours`, `match`, `party`, `run`) and the Steam facts; keys that name a person (`name`, `email`, `user_id`, `steam_id`, `ip`, `location`, `age` and the rest of the design's list); values shaped like an email address, a link, a phone number or any run of 7 digits (a band such as `3000-3499` is kept), a UUID, 16+ characters of hex, or 16+ characters of base64 that change between upper case, lower case and digits as often as random text; fractions; a 13th key in a session. A new session (back after 5 minutes away, or a server's cut) starts with the same properties |
| groups | `Glitchless.SetGroup("match" \| "party", id, attrs?)`, `SetGroup("run")` (the SDK makes `r_` and 12 characters, and returns it), `SetGroup("run", savedId)`, and `SetGroup(kind, null)` to end one. Each sends `group` `{kind, id, attrs?, resumed?}` (`id` null at the end) and stamps `match`, `party` or `run` on every event and window but `session_start`, as `level` is; setting or ending one closes the frame window. IDs are 8 to 64 of `[A-Za-z0-9_.:-]`. Match and party IDs go as `h_` and the first 24 hex characters of SHA-1 over the UTF-8 of `service + ":" + id`, the same in every SDK so a match keeps one ID across engines (`zoomies`, `m_8f2c91d04ab7` → `h_d8a6ac978165726ac21a722b`); `HashGroupIds = false` sends them as they are. A saved run ID resumes as it is in install and full mode; in anonymous mode it maps to a new run ID for this launch, with `resumed: true`. One set before `Init` is hashed once the service is known. A new session says its groups again |
| `zone` | `Glitchless.SetZone(name)` (null clears): a `zone` field, up to 64 characters, on every event and window, as `level`; a change closes the frame window. A zone is not a level: it has no start, end or outcome |
| `frame_window.net` | while connected, once a second, from the game's netcode found by reflection (no dependency): Netcode for GameObjects 2.x (`NetworkManager.Singleton`, `UnityTransport.GetCurrentRtt(ServerClientId)`, `relay` from `UnityTransport.Protocol`, so a Relay connection says so; Lobby and Multiplayer Services sessions run under it) or Mirror (`NetworkClient.isConnected`, `NetworkTime.rtt`, `jitter_ms` from `NetworkTime.rttVariance`); or `Glitchless.NetSample(rttMs, lossPct, jitterMs)` from any other library, at most one a second. `rtt` is a sketch at 5% (`a: 0.05`); `jitter_ms` is the library's, else the mean change from one second's round trip to the next; `loss_pct` only from `NetSample`; `in_kbps` and `out_kbps` are null. `transport` is `ngo`, `mirror` or `manual`; `link` is `wifi` or `cellular` on a phone and `cellular` elsewhere from `Application.internetReachability`, else null; `host: true` on a listen server's host, with no round trip. A window the game was connected through without a sample (a level start closed it within the second) has `net` with `samples: 0` and no numbers, so the time connected adds up. `GlitchlessOptions.Netcode = false` reads none |
| `disconnect`, `reconnect` | `disconnect {reason, connected_s, rtt_p95, loss_pct, transport}`, with the window's numbers (the last one's when it has none): NGO's `OnClientDisconnectCallback` and `OnTransportFailure`, reasons from `NetworkManager.DisconnectEvent` and the server's `DisconnectReason` (its "shutting down" → `server_closed`, other words or a close without them → `kicked`, `ProtocolTimeout` → `timeout`, never connected or `MaxConnectionAttempts` → `failed_to_connect`, a transport failure or `ProtocolError` → `connection_lost`); Mirror's `NetworkClient.OnDisconnectedEvent` by `NetworkClient.connectState` (connected → `connection_lost`, connecting → `failed_to_connect`); or `Glitchless.Disconnect(reason)`. The game leaving on purpose (`NetworkManager.Shutdown`, Mirror's `StopClient`) sends none. A level going ends with `level_abandon` reason `disconnect`. `reconnect {after_s, transport}` comes at the first sample connected again (or `Glitchless.Reconnect()`), and a level the disconnect ended goes on. At most 20 `disconnect` events a session; a server sends none |
| server mode | a Dedicated Server build (`UNITY_SERVER`), `--glitchless-server`, or `GlitchlessOptions.Role = GlitchlessRole.Server` (`Role.Player` keeps a server build a player). The envelope says `role: "server"` and keeps the game's own `service`: intake files it under `<service>.server`. It sends nothing until `GET /v1/health` lists `server_mode`, and nothing at all to a server that doesn't (its batches wait in the outbox meanwhile). `session_start` has `session_type` `user` (batch mode doesn't make a bot; `--glitchless-synthetic` does), coarse `device`, and `server {tick_hz, tick_source, max_players, build: "dedicated" \| "headless", region, host: {os, cores, memory_gb}}` (`max_players` from `MaxPlayers` or Mirror's `maxConnections`, `region` from `ServerRegion`). No `frame_window`, `hitch`, `load` or `pos`: `server_window` every window instead, `{duration_s, ticks, tick_hz, tick {sketch}, tick_p50, tick_p95, tick_max, late, budget_ms, tick_source, players, players_max, net_objects, in_kbps, out_kbps, cpu_pct, mem_mb, rtt_p95, ctx}`. Ticks are NGO's `NetworkTickSystem.Tick` (`tick_source` `ngo`, target `NetworkConfig.TickRate`), Mirror's frames (`mirror`, `NetworkServer.tickRate`), or FixedUpdate's steps (`fixed_update`, 1 / `Time.fixedDeltaTime`). A tick's time is the work of the frame it ran in, from its first player loop phase to the end of PostLateUpdate (not the wait for the next frame); `late` counts ticks over `budget_ms` (1000 / the target rate); `tick_hz` is the rate reached. `players` from NGO's `ConnectedClientsIds`, Mirror's `NetworkServer.connections`, or `Glitchless.SetPlayers(n)`, which wins; `net_objects` from NGO's spawned objects or Mirror's `NetworkServer.spawned`; `rtt_p95` from each player's round trip as the server sees it; `cpu_pct` the process's CPU time over the window's, as a percentage of one core (as `top` shows it: over 100 with other threads busy); `mem_mb` the system memory counter. A session is cut every 6 hours (`session_end` reason `max_duration`), or at each new match with `SessionPerMatch` (reason `match_end`) |
| `GET /v1/health` | read once at `Init` (and at each flush until it answers): its `features`, an array of strings (an object of booleans is read too), says whether counters and server mode may be sent. An answer without `features` is an older server |

## 5c. Unreal SDK

`unreal/Plugins/Glitchless` (Unreal Engine 5.8; 5.7 is guarded but not built) sends the same envelope with `"sdk": "glitchless-unreal/0.4.0"` and the same event types. See its [README](../unreal/Plugins/Glitchless/README.md) and [PRIVACY.md](../unreal/Plugins/Glitchless/PRIVACY.md). Positions are in metres with y up (x = X/100, y = Z/100, z = Y/100). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default); install and full mode send a stored random `p_…` ID. `batch_id` (§2) on every batch, a bug report's and a crash's too, kept through retries and saved with the batch in every mode |
| off switch | `FGlitchless::SetEnabled(bool)`, `FGlitchless::IsEnabled()`, Blueprint **Set Enabled** and **Is Enabled**, and `FGlitchlessOptions::bOptIn` with the project setting **Opt In** (§4d). The choice is saved in `Saved/Glitchless/enabled` (a dedicated server's in `Saved/Glitchless/Server/enabled`) and read before the plugin starts from Project Settings; it covers a listen server's own session. `bEnabled` in the settings and `Enabled` in the options still turn a build off whatever the player chose |
| `session_start` | `privacy` (`anonymous`, `install`, `full`). `device`: `browser: "Unreal"`, `browser_version` (`5.8.4`), `os` (`Windows`, `macOS`, `Linux`, `SteamOS`, `iOS`, `Android`), `mobile`, `device_tier`, `gpu_tier` (`low` on a Steam Deck), `renderer` (`deferred`, `forward`, `mobile`), `driver` (`D3D12`, `Metal`, `Vulkan`), `screen`, `dpr` (null), `refresh_hz` (phones only: the panel's highest rate as the OS reports it; each `frame_window`'s `hz` is the measured rate), `steam_deck`, `distribution` (iOS, §4b: the files are looked for from `FPlatformProcess::UserHomeDir()` and the main bundle); full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. With the SteamShared or OnlineSubsystemSteam module loaded, the Steam facts (§4c). `page` and `nav_ms` are null. `session_type` is `tester` on a TestFlight or development install on iOS unless the game sets one or a bot flag makes it `synthetic` |
| `frame_window` | frame times from a clock at the start of each frame. Adds `game_ms` (game thread, GGameThreadTime), `process_ms` (the same, under the name the playtest gate reads), `render_ms` (render thread), `rhi_ms` (null without an RHI thread), `gpu_ms`, `gc_collections`, `gc_ms`, `pso_compiles` (pipeline states created at draw time that took over 20 ms, UE 5.8), `shader_compiles` (the editor only), `packages_loaded`, `objects` (UObjects), `actors`, `heap_mb` (the process), `texture_mb`, `screen`, `window`. `draw_calls` and `triangles` only while the RHI counts them (usually null in a packaged build); `geometries`, `textures`, `programs` are null. `ctx` also holds `objects` and `actors`. Thread and GPU times are averages over the window's frames; `gc_*`, `pso_compiles`, `shader_compiles` and `packages_loaded` totals; each `ctx` gauge its highest value in the window; `objects`, `actors`, `heap_mb` and `texture_mb` the last sample. `hz` and `budget_ms` are measured from the frames: the fastest fifth of the first 30 under 100 ms, then the median of the first 120 (60 before that). A window never spans two levels |
| `hitch` | `duration_ms` is the frame's time on the clock (Unreal leaves waits out of its thread times, so a frame stalled on a pipeline state, the GPU or the disk would look short by them). `causes` from `pso_compile`, `shader_compile`, `gc`, `map_load`, `level_stream`, `asset_load`, `script` (game thread at 40% of the frame), `render` (render, RHI or GPU at 40%), `gpu_or_os` (none of the others, and game, render, RHI and GPU time add up to under max(16 ms, 40% of the frame): waiting to present, GPU work Unreal didn't time, or the OS), `frozen` (over 700 ms). Adds `bound` (the slowest of `game`, `render`, `rhi`, `gpu`), `game_ms`, `process_ms`, `render_ms`, `rhi_ms`, `gpu_ms`, `gc_collections`, `gc_ms`, `pso_compiles`, `shader_compiles`, `packages_loaded`; `loaf` is empty |
| `level_start` | also sent when a map that reads as a level loads (not `Entry`, `MainMenu`, `Lobby`, `Loading`…); the game's first `LevelStart` turns that off |
| `level_abandon` | `LevelAbandon(Level)` (C++ and Blueprint). Sent by itself, with `reason` `background`, `quit` or `measure`, before `session_end`, for a level (a map level too) started and not ended; a map level that unloads closes without one, and a crash sends none |
| `load` | `ts` is the first frame's wall-clock time; `ttff_ms` runs from the engine's start (`GStartTime`) to the end of the first frame the plugin times |
| `error` | `kind`: `crash` (fatal; written to the outbox as the game dies and sent on the next launch, with `session_end` reason `crash`; in anonymous mode under a fresh session ID), `ensure` (an error, not fatal: the game carries on, and each ensure reports once a run), `script` (a Blueprint runtime error such as Accessed None; Unreal stops that Blueprint function, so it is unhandled, like `js`), `log_error` (`UE_LOG` Error; `fn` is the log category), `warning`, `manual`; adds `recent` (last 6 game events) and, for `script`, `attrs.blueprint` |
| `death`, `pos` | positions only when they are on (full mode, or Positions) |
| `session_end` | `reason`: `quit`, `background` (phones), `measure`, `crash` |
| `custom` | also `screen_change`, `app_resume`, `rage_input`. `Track` adds `sandbox: true` to a purchase in a TestFlight or development install (§3b) |
| `bug_report` | a **Bug Report Key** (F8) in the plugin's settings, or `ShowBugReportDialog()`, opens a Slate box that takes the game's input and pauses it (Pause For Bug Report); `ReportBug(note)` sends one from the game's own UI. `screenshot` is the viewport read back, its longer side at most 960 px. A report is its own one-event batch in the outbox, sent after the session's events; neither the read-back frame nor the box's first draw is timed |
| attributes | `Track(Name, FGlitchlessAttributes)` (Blueprint: Track Event (Attributes), with the Glitchless Attributes struct or Add Word, Add Number, Add Flag and Add List) sends words, numbers, booleans and lists of strings; the `TMap` overloads stay. `LevelStart(Level, Attributes)` (Level Start's Attributes pin) sends them as `level_start.attrs` |
| `counts` | `Count(Name, Attributes, N)` (Count Event): one entry per name and group (the first 4 strings and booleans) in the 5 s frame window, its first 4 numbers summed as each call gives them, `N` (up to 1,000,000) added to `n`; at most 64 entries a window, then a known name's new group goes under `(other)` values and a new name adds its `n` to `dropped`. Sent as one `counts` event when the window closes (`ts` the window's start, `duration_s`, `level`, `dropped`, `counts: [{name, attrs, n, sums?, first_ts}]`), held until `GET /v1/health` answers and sent only when its `features` list `counts`, else dropped with one log line. A development build logs once when a name is tracked more than 20 times a second |
| `props` | `SetProperty(Key, string / int / int64 / double / bool)`, `ClearProperty`, `FGlitchlessOptions::Properties` (Set Glitchless Property, and its Number and Flag forms). Keys match `^[a-z][a-z0-9_]{0,31}$`, 12 a session, not a built-in split (`version`, `level`, `env`, `platform`, `browser`, `device_tier`, `session_type`, `privacy`, `role`, `link`, `type`, `players`, `sessions`, `hours`, `zone`, `match`, `party`, `run`, the Steam facts) nor a name that identifies (`email`, `user_id`, `steam_id`…); values a string (trimmed, 64 characters), a boolean or a whole number in ±1,000,000, and no email address, link, phone number, run of 7+ digits, UUID, 16+ hex digits or 16+ characters of base64 mixing cases and digits. Those set before the session's first batch go in `session_start.props`; later changes as at most one `props` event a window, with null for a key removed. A new session in the same launch starts with them |
| groups and zones | `SetGroup(EGlitchlessGroup::Match / Party / Run, Id, Attributes)`, `ClearGroup` (Set Group, Clear Group) send a `group` event (`kind`, `id`, `attrs`, `resumed`; `id: null` ends it) and put `match`, `party` or `run` on every event while set. Match and party IDs (8 to 64 of `[A-Za-z0-9_.:-]`, else dropped) go as `h_` and the first 24 hex digits of SHA-1 of `<lowercase service>:<id>`, the same in every SDK, unless Hash Group Ids is off. A run's ID is `r_` and 12 characters; one passed back resumes the run in install and full mode and becomes a new ID in anonymous mode, `resumed: true` either way. `SetZone(Name)` puts `zone` on every event while set. Each is left out when not set, and a change of zone or group closes the frame window. A listen server's own session takes the host's match and party |
| `frame_window.net` | read once a second from Unreal's replication on a client: the server connection's `AvgLag` (the player state's ping when it has none), the worse of `GetInLossPercentage` and `GetOutLossPercentage`, `GetAverageJitterInMS`, `InBytesPerSecond` and `OutBytesPerSecond`; the link from `FPlatformMisc::GetNetworkConnectionType` (`wifi`, `cellular`, `wired`, else null). Fields as the browser's (`rtt` a sketch at a = 0.05, `transport: "unreal"`); a listen server's host sends `host: true` with a round trip of 0. `NetSample(RttMs, LossPct, JitterMs)` for another library sends `transport: "custom"` |
| `disconnect`, `reconnect` | from `GEngine->OnNetworkFailure()`: `ConnectionTimeout` is `timeout`, `ConnectionLost` `connection_lost`, `FailureReceived` `kicked`, either with "Host closed the connection." `server_closed` (what a server that shuts down sends), and a failure before the first connection (`PendingConnectionFailure`, an outdated client or server, a checksum mismatch, or `OnTravelFailure`'s pending net game) `failed_to_connect`. The same failure said twice within 5 s counts once; 20 a session. With a level open, `level_abandon` with `reason: "disconnect"` follows; a sample on the same level afterwards sends `reconnect {after_s}` and opens the level again. `Disconnect(Reason)` and `Reconnect()` for another library |
| server role | a dedicated server (`IsRunningDedicatedServer()`) starts the plugin in the server role, and a listen server (`NM_ListenServer`) runs a second core in it while it hosts. Envelope `role: "server"`, `player_id: null`, `service` the game's own (intake files it under `<service>.server`); the outbox is `Saved/Glitchless/Server/outbox.json`. Nothing is sent until `GET /v1/health` lists `server_mode`; a server that doesn't drops everything and sends nothing. `session_start.session_type` is `user` (`synthetic` with `-autoplay` or `-glitchless-synthetic`), `device` only `browser`, `browser_version` and `os`, and `server: {tick_hz, max_players (the game session's MaxPlayers), build: "dedicated" or "listen", region (Server Region or -glitchless-region=), host: {os, cores, memory_gb}}`. `server_window` every 5 s in place of `frame_window` (no `hitch`, `load`, `pos` or `bug_report`): `ticks`, `tick_hz` (reached), `tick` (a sketch at a = 0.02 of each tick's work: the time between frames less `FApp::GetIdleTime()` on a dedicated server, the game thread's time on a listen server, or its frame less that wait when nothing renders), `tick_p50`, `tick_p95`, `tick_max`, `late` (ticks over 1000 / the engine's cap: `NetServerMaxTickRate`, or `t.MaxFPS` when set), `players` (client connections, plus the host's local players), `players_max`, `net_objects` (the network object list's active objects; null with Iris), `in_kbps`, `out_kbps` (summed over its connections), `cpu_pct` (of one core), `mem_mb`, `rtt_p95` (the connections' `AvgLag`), `ctx`. A session lasts the process, cut every 6 hours (`session_end.reason: "max_duration"`), or one match with Server Session Per Match (`match_end`); a listen server that stops hosting ends its with `closed`. A server's map is never abandoned. Errors, crashes, custom events and counts go as from a player's session |

`-glitchless-measure=S` (with `-glitchless-warmup`, `-glitchless-out`) prints `{"glitchless_measure": {…}}` as Unity and Godot do, plus `session_id`; `-autoplay` and `-glitchless-synthetic` mark the session synthetic; `-glitchless-region=NAME` names a server's region. `unreal/test/mp.mjs` checks the multiplayer side with the editor binary (`-server` for the dedicated server): a dedicated server and a client, a listen server and a client, and a server crash. The optional GlitchlessToolset plugin gives Unreal MCP (UE 5.8, Experimental) `Status` and `Measure` tools for Play In Editor.

On the server, findings for an `unreal` game name Unreal's fixes (PSO precaching and bundled caches, GC pooling and clustering, streaming budgets, Insights and `stat` commands, scalability groups). `crash` is a fatal kind that halts its session, so the session counts as crashed (§4), like `game_loop_stopped`.

## 5d. GameMaker SDK

`gamemaker/` (GameMaker 2024.2 and later, built for LTS 2026) is GML: the `Glitchless` script's `glitchless_*` functions, internal `__glitchless_*` scripts and two persistent objects that `glitchless_init` creates. It sends the same envelope with `"sdk": "glitchless-gamemaker/0.3.0"` and the same event types, gzipped (a gzip wrapper around `buffer_compress`'s zlib stream; plain JSON in a web build). See its [README](../gamemaker/README.md) and [PRIVACY.md](../gamemaker/PRIVACY.md). Positions are room coordinates. Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default); install and full mode send a stored random `p_…` ID. `batch_id` (§2) on every batch, a bug report's and a crash's too, kept through retries and saved with the batch in every mode; its hash takes in the session ID, as GameMaker has no random source of its own that leaves the game's `random()` alone |
| off switch | `glitchless_set_enabled(on)`, `glitchless_is_enabled()` and the `opt_in` option (§4d). The choice is saved in `glitchless/enabled` in the save area and read by `glitchless_init` before anything else. The `enabled` option (off when run from the IDE unless `-glitchless`) still turns a build off whatever the player chose |
| every event | `level`, and while the game sets them `zone` (`glitchless_set_zone`) and `match`, `party`, `run` (`glitchless_set_group`). Groups and zones are left out while unset; zone names are cut to 64 characters. A group change closes the frame window, as a level start does, so a window (and its counters and network samples) never spans two matches; a zone change does once the window has run a second, so a player stepping back and forth over a zone's edge doesn't fill the queue (a shorter window takes the new zone) |
| `session_start` | `props`: the properties set before the session's first batch (`properties` in the options, `glitchless_set_properties`), left out when there are none. `privacy` (`anonymous`, `install`, `full`). `device`: `browser: "GameMaker"`, `browser_version` (the runtime, `2026.0.0.23`), `os`, `mobile`, `device_tier` (`unknown`: GameMaker can't read cores or memory), `gpu_tier` (from the GPU's name in `os_get_info`; `low` on a Steam Deck), `renderer` (`vm` or `yyc`), `driver`, `screen`, `dpr` (null), `refresh_hz`, `steam_deck` (as Unreal decides it: `SteamDeck=1`, a Valve board, or SteamOS, with `os` `SteamOS`); full mode adds `os_version`, `gpu`, `gpu_vendor`, and `model` on a Steam Deck (`cores`, `memory_gb` are null). `page` and `nav_ms` are null |
| `frame_window` | frame times from `delta_time`; `hz` and `budget_ms` from the game speed. Adds `process_ms` (the Step events: the frame's start to the first Pre-Draw), `render_ms` (the draw events: the first Pre-Draw to the last Draw GUI End), `gc_collections`, `gc_ms` (`gc_get_stats`), `texture_loads` (texture groups loaded or fetched), `heap_mb` (`debug_event("DumpMemory")`), `instances`, `surfaces`, `ds_lists`, `ds_maps`, `buffers` (`debug_event("ResourceCounts")`), `screen`, `window`. `draw_calls`, `triangles`, `gpu_ms`, `physics_ms`, `geometries`, `textures`, `programs` are null. `ctx` also holds `instances` and the resource counts. A window never spans two levels. While the game sends network samples (`glitchless_net_sample(rtt_ms, [loss_pct], [jitter_ms])`, from its own ping over `network_*`; samples under 500 ms apart are ignored), `net`: `rtt` (a 5% sketch), `rtt_p50`, `rtt_p95`, `rtt_max`, `jitter_ms` (the game's, else the mean change between consecutive round trips), `loss_pct` (the game's, else null), `samples`, `transport` (`gamemaker`, or the `net_transport` option); `in_kbps`, `out_kbps` and `link` are null and `host` false (only clients sample). No `net` before the first sample or after a disconnect |
| `hitch` | `causes` from `texture_upload` (a texture page fetched on first draw), `scene_change` (a room change: the level's load), `gc` (a collection over a quarter of the frame), `object_spawn` (50+ instances added), `script` (Step events at 40% of the frame), `render` (draw events at 40%), `gpu_or_os` (none of the others, and Step and draw time with any collection add up to under max(16 ms, 40% of the frame)), `frozen`. Adds `process_ms`, `render_ms`, `gc_ms`, `gc_collected`, `instances_added`, `texture_loads`; `loaf` is empty |
| `level_start` | also sent when a room that reads as a level starts (not `rm_main_menu`, `rm_title`, `rm_boot`, `rm_loading`…, the words Unity and Unreal use); the game's first `glitchless_level_start` turns that off. A menu room leaves the level. `attrs` from `glitchless_level_start(level, attrs)`, a struct sent as the game passes it (room levels have none) |
| `level_abandon` | `glitchless_level_abandon()`; sent by itself, with `reason` `quit` or `measure`, before `session_end` when a level is open (§2), and with `reason` `disconnect` after a `disconnect` while one is; a room level that ends with its room (back in a menu) closes without one, and a crash sends none |
| `load` | `ts` is the first frame; `ttff_ms` counts from the game's start; `first_launch` from `glitchless/launched` in the save area (the version that last ran) |
| `error` | `kind`: `crash` (an unhandled exception, through `exception_unhandled_handler`: GameMaker stops the game, so the crash and `session_end` reason `crash` are written to the outbox and sent on the next launch; in anonymous mode under a fresh session ID) and `manual` (`glitchless_error`, a message or a caught exception). `fn` is `obj_player.Step_0` for an object's event and the function's name for a script function; `stack` keeps GameMaker's frame names. Adds `recent` (last 6 game events) |
| `death`, `pos` | positions only when they are on (full mode, or `positions: true`) |
| `session_end` | `reason`: `quit` (`glitchless_quit`, or Game End: then it is sent on the next launch), `measure`, `crash` |
| `custom` | also `screen_change`, `app_resume`, `rage_input`. In a build run from the IDE or with `-glitchless-debug`, a name tracked more than 20 times a second gets one warning naming `glitchless_count` |
| `counts` | `glitchless_count(name, [what], [n])`: one entry per name and group in the frame window (the 5 s flush interval, closed early by a level start, zone or group change), sent as `{type: "counts", ts, level, duration_s, dropped, counts: [{name, attrs, n, sums?, first_ts}]}` when the window counted anything. `what` is a word (`attrs.what`), a number or a struct. The group is its first 4 strings and booleans by key (strings cut to 64 characters); its first 4 numbers by key are added up as given into `sums`; `n` (default 1, at most 1,000,000) adds to the count. 64 entries a window; past that a new group of a counted name goes into one entry per name whose group values are `(other)`, and a new name adds its `n` to `dropped`. At launch the SDK asks `GET /v1/health` once; an answer that parses without `counts` in `features` (an array of names, or an object of booleans) turns counters off with one debug message and drops `counts` events still queued. No answer leaves them on |
| `props` | `glitchless_set_properties(struct)`: at most one a window, with the keys changed since `session_start.props` or the last `props` (null for a key removed with `undefined`), at the time of the last change. The SDK applies the property rules before sending (keys `^[a-z][a-z0-9_]{0,31}$`, at most 12 a session, removing one doesn't free its place; the reserved keys, `zone`, `match`, `party` and `run` among them, and the identifying keys dropped by name; values a trimmed string up to 64 characters, a boolean or a whole number within ±1,000,000; strings shaped like an email address, a link, a phone number written in three or more runs of digits or after `+` or `(`, 7 digits in a row, a UUID, 16 hex digits in a row, or 16 base64 characters in a row with a letter and a digit, dropped), with one debug message per key. Properties and groups live in memory only: a new session in the same launch starts with the properties still set in its `session_start` and sends a `group` event again for each group still set |
| `group` | `glitchless_set_group(kind, [id], [attrs])`: `{type: "group", kind, id, attrs?, resumed?}`, `id: null` when the group ends (`id` passed as `undefined`). Kinds `match`, `party`, `run`. IDs are 8 to 64 of `[A-Za-z0-9_.:-]`, else the call is dropped. Match and party IDs go as `h_` + the first 24 hex digits of SHA-1(lowercased service + `:` + id) unless `hash_group_ids: false`, as in every SDK (service `zoomies` and ID `m_8f2c91d04ab7` give `h_d8a6ac978165726ac21a722b`). `glitchless_set_group("run")` makes `r_` + 12 characters and returns it; a passed run ID resumes in install and full mode, and is swapped for a new one in anonymous mode; both send `resumed: true`. Setting the same ID again with no attributes sends nothing |
| `disconnect`, `reconnect` | `glitchless_disconnect([reason])`: `{reason, connected_s, rtt_p95, loss_pct}`, the numbers of the window in progress, else the last window with `net`; `connected_s` from the first sample after the last (re)connect, 0 if there was none. Reasons outside `timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect` and `other` become `other`; at most 20 a session. `glitchless_reconnect()` after a disconnect: `{after_s}` |
| `bug_report` | `bug_reports` in the options adds the F8 form, drawn in Draw GUI End, which deactivates the game's instances while open (`pause: false` and `on_open`/`on_close` for a game's own pause); `glitchless_report_bug(note)` sends one from the game's own UI. `screenshot` is a **PNG** data URL (GameMaker writes no JPEG) of the application surface, its longer side at most 960 px |

`-glitchless-measure=S` (with `-glitchless-warmup`, `-glitchless-out`) prints `{"glitchless_measure": {…}}` as the other SDKs do, plus `session_id` and `gc_ms`, and writes it to `glitchless/measure.json` in the save area; `-autoplay` and `-glitchless-synthetic` mark the session synthetic. Igor's `Run` starts the game with macOS's `open`, which passes no command line or environment on, so the SDK also reads its flags from the `GLITCHLESS_ARGS` environment variable and, in a build run from the IDE or Igor, from `glitchless/args.txt` in the save area (the runner's, `com.yoyogames.macyoyorunner`).

On the server, findings for a `gamemaker` game name GameMaker's fixes (texture groups and prefetching, light room Create events, GC pacing, instance pooling and particle systems, surface reuse, freeing DS structures). `crash` is a fatal kind that halts its session, as for Unreal.

## 6. Projects, keys and storage

A **project** is the tenancy boundary. The server resolves every request to one project through two
hooks passed to `createApp({ auth })` ([`server/src/auth.js`](../server/src/auth.js)):

| hook | called for | returns | refuses with |
| --- | --- | --- | --- |
| `resolveIngest(token, req)` | `POST /v1/intake?token=` | `{ projectId, keyId?, rps? }` | `AuthError(403)` |
| `resolveReader(req)` | every other `/v1/` route but `/v1/health` | `{ projectId, scopes, keyId?, rps?, share? }` (`read`: queries and live tail; `delete`: `DELETE /v1/data` and `DELETE /v1/report`; `dashboard`: save or reset a dashboard; `sourcemaps`: upload source maps). `rps` rate-limits the reader per `keyId`; `share: { service, page }` limits it to one board (§3c) | `AuthError(401 \| 403)` |

Client tokens ship inside game builds, so they are write-only: a reader hook never accepts one. Intake
stamps `project_id` on every event and stores it under that project; queries, the live tail, the agent
activity feed and the query cache are all per project.

- **Open-source default** (`envAuth`): one project, `default`. `GLITCHLESS_CLIENT_TOKENS` (comma-separated,
  default `gl_pub_dev`) may write; `GLITCHLESS_API_KEY`, if set, is needed for everything else (header
  `x-glitchless-api-key` or `?api_key=`), and must differ from every client token. No API key means open reads.
- **Hosted**: a control plane implements the same hooks with hashed per-project keys and Auth0/Cognito sessions.
- **Rate limit**: a token bucket per ingest key, per server process, of `rps` requests/s with bursts of 2 s
  worth; 429 with `Retry-After` past it. `GLITCHLESS_INGEST_RPS` sets the default (1000; 0 turns it off). The
  payload caps still apply: 1 MB per request, 500 events, 4000-character strings.

**Storage.** Every store method takes the `projectId`: `put`, `query`, `rollups`, `getMaps`, `reports`,
`getReport`, `deleteReport`, `putSourcemap`, `getSourcemap`, `sourcemaps`, `deleteSourcemaps`, `services`, `clear`
([`server/src/stores/file.js`](../server/src/stores/file.js) lists them), and optionally `cohorts` (the players first
seen on each day of a range, for retention): the file store keeps that first-seen index in memory over everything it
holds; a store without one counts players as new on their first day in the range (`first_seen: 'range'`). Optionally
`versionsFirstSeen(projectId, service)`: a Map of version → the `ts` of its earliest event (intake keeps a device's
clock within 7 days), the release order (§4) every version comparison uses. The file store keeps it in memory over
every line it has on disk; Glitchless Cloud keeps it per game in DynamoDB from the moment its index began (the
versions the game had then have no sighting). A store without it orders versions by number, or by the range. Optionally
`claimBatch(projectId, service, id)` and `releaseBatch(...)` keep repeats of a batch out (§2 `batch_id`): `claimBatch`
is true the first time an ID comes within 7 days and false after, across every server process the store serves (the
file store keeps the IDs in `batches.jsonl`; Glitchless Cloud makes one conditional write per batch), and intake
releases an ID whose events it failed to store, so the game's retry is taken. A store without them keeps every copy.
Optionally `getBrand(projectId, service)`, `putBrand(…, brand)`, `getBrandImage(…, kind)` and `putBrandImage(…, kind,
bytes)` keep a game's branding (§3b): what it is in one item and each image's bytes in one of their own (the file
store: `brands.json` and `brand/<project>/<service>.<kind>`; Glitchless Cloud: items under `P#<project>#BRAND`, an
image at most 300 KB of a 400 KB item). A store without them answers `/v1/brand` with 501.

Data written before projects existed (JSONL lines without `project_id`) is read as the `default` project, so no
migration is needed.

**Companion services** (A9). A game's servers are kept under `<service>.server`: intake files every `role: "server"` batch
there, and every store keys it like any service, so nothing new is stored or indexed. `services` lists it under its
game, and the queries that read servers (`overview`, `findings`, `board`, `servers`, `matches`) read it next to the game
with the same filters (never the players' property filters). Players now counts it apart (`servers_now`); Glitchless
Cloud's `auth.serversNow(projectId, companion)` hook counts it across every server instance, with each server's latest
players.

**Rollups.** Intake also folds every event into per-minute cells per (project, service, env, version, level, and zone
where the game sets one):
a merged frame-time sketch, event counts by type, frames, seconds, hitches, frozen frames, frame-budget
counts, and sums, counts and maxima of draw calls, render ms, triangles, geometries, heap and context gauges
([`server/src/rollups.js`](../server/src/rollups.js)). For custom events a cell keeps: `ev` (per name), `evv` (per
name, attribute and value, 400), `evs` and `evx` (sums per name, attribute and currency, and per other string or
boolean value, 400 each), `evb` (`[trues, events]` per name and boolean attribute, and per other string or boolean
value, 400), `evl`, `evlb` and `evlx` (counts, rates and sums per list element, 1,000 each) and `evq` (per name and
numeric attribute, a sketch of its values: log buckets at 5% relative accuracy for positive and negative values, a
zero count, the count, a fixed-point sum, the smallest and largest, and whether every value was whole; 32 a cell, the
rest counted in `evqc` per name, and that event's distribution says `partial`). `sv` (A9, a companion's cells): server windows, seconds, ticks, late ticks, windows over budget, a tick sketch at 2%,
players `[sum, windows]` and the most, CPU, memory (and its highest), round trips, networked objects (and the most),
windows per `budget_ms`. `net` (A8, only cells with network data): a round-trip sketch at 5%, seconds connected and with samples, seconds over
150 ms, loss and jitter `[sum, samples]`, throughput, windows per link and host windows, disconnects by reason and
reconnects. A counter (§2 `counts`) folds into
`ev`, `evv`, `evs`, `evx` and `evb` as its `n` events would, and `evk` counts the events that came from counters per
name. Each merges exactly in any order. `overview`, `performance`, `versions` and
`findings` take their frame-time and count sections from the stored minutes that lie fully inside the range,
and fold raw events for the partial minutes at each end. Without stored rollups (filters by session type or
ids, or ranges before `since`) they fold every raw event the same way. Sums are fixed-point, so both paths
give identical numbers in any arrival order. On the file store, session-level numbers (crash-free, rage quits,
players), device breakdowns, hitch context and findings evidence are folded from the raw range, into mergeable
forms (session states, §7) that a store can also keep precomputed.

The file store rebuilds rollups from its event files at startup.

Every answer carries `meta`: the range answered (`from`, `to`, `bucket_ms`), the filters, and from a store that
keeps day rollups (§7) `resolution: 'day'` for ranges of more than 31 days, `approximate` (the parts estimated
from sketches or samples), `note` (a view answered over less of the range) and `retention_days` (the reader's
plan, when the host has plans).

## 7. Other stores

`createApp({ store })` takes any store with the methods in §6, so a server can keep its events somewhere other than
files (a database, object storage). To check one, run the server's tests on it:
`GLITCHLESS_TEST_STORES=./my-stores.js npm test -w glitchless-server`
([`server/test/helpers/stores.js`](../server/test/helpers/stores.js) says what that module exports).

A store may keep precomputed state instead of raw events: session states and facts merge exactly, so a store that
keeps them per minute or hour answers as the raw events of the range would. For long ranges it may keep **daily
rollups** ([`server/src/daily.js`](../server/src/daily.js)), and then answers ranges of more than 31 days in whole
days (`meta.resolution: 'day'`):

- **Exact**: everything from cells and facts, session counts, rates, sums and averages, the level funnel's
  counts, custom events' sessions and values, the latest sessions and rage quits; rates and averages of events by
  attribute, list element, version and level, hours played and everything per hour played, distributions (within
  their sketches' 5%). A session counts on the day it started, with all its events.
- **From the day's sample of sessions** (named in `meta.approximate` as `event_occurrences` once sampled or
  weighted): what reads occurrences (§3b), such as a list that contains all of several values or a distribution by
  an attribute. Splits by a session split or a Steam fact say they need 31 days or less.
- **Exact while small, then estimated** (named in `meta.approximate`): distinct players (overall, per level, per
  event, per error) and error sessions (HyperLogLog past 128–512 per day), returning players and retention past
  31 days (a uniform sample of 512 players a day), medians of per-session values and levels' clear times (3 then 2
  significant digits past 512 values), ordered funnels (256 sessions a day, weighted), GPUs past the top 30 a day, difficulty hotspots past
  100 deaths per level a day.
- **Over the last 31 days of the range** (`meta.note`): heatmaps and session-type filters, which read raw rows;
  recent hitches.

Glitchless Cloud runs its own store of this kind, with retention set by each workspace's plan; it is not part of
this repo.
