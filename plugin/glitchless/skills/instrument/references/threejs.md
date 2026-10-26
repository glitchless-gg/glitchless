# Three.js

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


## 1. Read the game first

Find, and note file:line for each:
- where the `THREE.WebGLRenderer` (or `WebGPURenderer`), `scene` and main `camera` are created
- the game loop (`renderer.setAnimationLoop` / `requestAnimationFrame`)
- level/stage load and unload, player death/respawn, level complete/win, pickups/power-ups, game over
- anything spawned in bulk at runtime (particles, projectiles, enemies, debris): these become context gauges
- where the version lives (`package.json` version or a constant); if none, create `src/version.js`

## 2. Install and initialize (right after the renderer exists)

```bash
npm install glitchless
```

```js
import * as THREE from 'three';
import { Glitchless, instrumentThree } from 'glitchless';

const glitchless = Glitchless.init({
  service: '<game-id>',               // kebab-case, stable
  version: GAME_VERSION,
  env: import.meta.env?.MODE ?? 'dev',
  intake: import.meta.env?.VITE_GLITCHLESS_INTAKE ?? 'http://localhost:7777',
  clientToken: 'gl_pub_dev',
  sessionType: isBot ? 'synthetic' : 'user',
});
instrumentThree(glitchless, { renderer, scene, camera, THREE });
```

No bundler? Use `<script src="{GLITCHLESS_URL}/sdk/glitchless.js"></script>` and `Glitchless.init(...)` / `Glitchless.instrumentThree(...)`.

**Telemetry must never break the game.** Load the SDK through a small facade with try/catch and a no-op fallback
(see `apps/zoomies/src/telemetry.js` in the Glitchless repo for the pattern) and support a `?nogd=1` kill switch.

## 3. Wire game semantics

| Game moment | Call |
| --- | --- |
| level/stage starts (incl. restarts) | `glitchless.levelStart('level-2')`; with what describes the attempt: `levelStart('rift', { mode: 'ranked', hero: 'ember' })` |
| level beaten | `glitchless.levelComplete('level-2', { durationS, score })` |
| game over: the player lost the level | `glitchless.levelFail('level-2', { cause })` |
| the player leaves mid-level (back to the menu, a restart) | `glitchless.levelAbandon('level-2')`: never a fail. Closing the page or app mid-level sends one by itself |
| player dies | `glitchless.death({ x, y, z, cause: 'fell' })`: short, low-cardinality causes |
| pickups, power-ups, checkpoints | `glitchless.track('powerup', { kind: 'speed' })` |
| something that happens many times a second: shots, hits, kills, gold, taps | `glitchless.count('kill', { monster: 'elite' })`, `glitchless.count('gold', { source: 'loot', amount: 35 })`: summed per 5 s window. Track a moment, count a stream |
| what holds for the session: mode, rank tier, class, server region, input | `glitchless.setProperties({ mode: 'squads', rank: 'gold' })` where the game knows it (after sign-in, at the menu, at matchmaking). Bands, never exact numbers or anything about the person |
| an open world: the region or room the player is in | `glitchless.setZone('westfall')` on each change (a zone has no start or end; a level does) |
| a purchase the store confirmed | `glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })` |
| every frame | `glitchless.setPosition(player.position)` |
| every frame | `glitchless.setContext({ particles, enemies, projectiles })`: counts of anything that scales |
| after a level is built | `glitchless.captureMap(levelId, { axis: 'xy' /* side-scroller */ \| 'xz' /* top-down */, bounds: { min: [a, b], max: [a, b] } })` |
| handled errors worth knowing about | `glitchless.error(err, { where: 'save-game' })` |

## 4. Give agents hands: register game tools (WebMCP)

Register 3–5 tools that let an agent reproduce problems. Handlers return a plain object or string and never throw.

```js
glitchless.registerTool('mygame_get_state', 'Current level, player position, score, enemy/particle counts', { type: 'object', properties: {} }, () => ({ ... }));
glitchless.registerTool('mygame_load_level', 'Jump to a level', { type: 'object', properties: { level: { type: 'string' } }, required: ['level'] }, ({ level }) => { loadLevel(level); return `loaded ${level}`; });
```

Good candidates: load level, teleport player, trigger the expensive effect (explosion, power-up), toggle pause.

## 4a. Multiplayer: matches, ping, disconnects and the game's server

Skip this for a single-player game. Find the netcode first (`ws`, Socket.IO, Colyseus, WebRTC, or the game's own) and
note file:line for: joining a match or lobby and the ID the server gives it, the client's ping (or where one could
go), the disconnect and reconnect handlers, and the server's tick loop.

On the client:

```js
glitchless.setGroup('match', match.id);   // the ID the game's server made, shared by everyone in the match
glitchless.setGroup('party', party.id);   // a party, until it breaks up. Never an account, guild or friends-list ID
glitchless.setGroup('match', null);       // the match is over
const run = glitchless.setGroup('run');   // a roguelite run across levels: the SDK makes the ID
```

Match and party IDs are hashed before they're sent, the same way in every Glitchless SDK and on the server, so the
match lines up from every side; leave `hashGroupIds` on unless the user wants to match IDs against their server logs.

Ping, about once a second: a WebSocket has no round trip of its own, so time an app-level ping (Socket.IO: an emit
with an acknowledgement; `ws` or Colyseus: a ping message the server echoes) and pass it:

```js
glitchless.netSample({ rtt_ms, transport: 'socket.io' });    // loss_pct and jitter_ms too where the netcode knows them
glitchless.disconnect({ reason: 'timeout' });                // timeout, connection_lost, kicked, server_closed, failed_to_connect, other
glitchless.reconnect();                                      // back in the same game
```

Call `disconnect` only when the connection dropped, not when the player chose to leave (Socket.IO's
`io client disconnect`, a close the game made itself). A disconnect mid-level ends it as an abandon with reason
`disconnect`, never a fail. A WebRTC game: `import { instrumentNet } from 'glitchless/net'` and
`instrumentNet(glitchless, { peer })` with its `RTCPeerConnection` does all of this from `getStats()`.

On a Node game server (in the same repo or the user's server project), add `glitchless/server`:

```js
import { GlitchlessServer, instrumentWs } from 'glitchless/server'; // or instrumentSocketIO, glitchlessRoom

const server = GlitchlessServer.init({
  service: '<game-id>',                 // the game's own id, not "<game-id>.server": intake files it apart
  version: GAME_VERSION,
  intake: process.env.GLITCHLESS_INTAKE ?? 'http://localhost:7777',
  clientToken: 'gl_pub_dev',            // the game's client token
  tickHz: 30,                           // the server's target tick rate
  maxPlayers: 16,
  region: process.env.REGION,           // in the game's words: 'eu-west'
  sessionType: isLoadTest ? 'synthetic' : 'user',
});
instrumentWs(server, wss);                           // ws: players, pings, how connections end
// instrumentSocketIO(server, io);                   // Socket.IO
// gameServer.define('battle', glitchlessRoom(server, BattleRoom)); // Colyseus: each room is a match
setInterval(server.measureTick(update), 1000 / 30); // the tick loop (Colyseus: done by glitchlessRoom)
server.setGroup('match', matchId);                   // the same ID the players get; server.match(id) when it hosts several at once
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
```

Uncaught errors are reported as crashes and the process still dies as before. It sends nothing to a Glitchless
server that doesn't read server sessions yet, so on an old one nothing shows: say so in the report.

## 4b. Bug reports from players (ask first)

For playtests, jams and early access, players can flag a problem where it happens: a key (F8) or a button in the
overlay opens a small form, and the note, a screenshot of the canvas, the level, the position (when positions are
on) and the last events go to Glitchless. They show under Bug Reports, in findings once a level has three, and in
`glitchless_bug_reports`. The note is free text the player types, so ask the user before turning it on and tell
them to mention it in the game's privacy page (`packages/sdk/PRIVACY.md` in the Glitchless repo has the wording).

```js
const glitchless = Glitchless.init({
  // …
  bugReports: { hotkey: 'F8', onOpen: () => pauseGame(), onClose: () => resumeGame() },
});
```

While the form is open the SDK holds keys, clicks and mouse movement back from the game; `onOpen`/`onClose` pause
it (a game that reads a gamepad needs the pause). A game with its own pause menu can add "Report a bug" there with
`glitchless.openBugReport()`, or send one from its own UI with `glitchless.reportBug({ note })`.

## 4c. Readable errors from the production build (source maps)

A minified build reports its errors as `e (index-3f2a.js:1:48213)`. With the build's source maps uploaded,
Glitchless shows them as `fireShotgun (weapons.js:141)`, with the original stack and the failing line, in the
dashboard and in `glitchless_get_error`, and an error keeps one fingerprint across builds. Most web games build
with Vite; add the plugin there:

```bash
npm install -D glitchless-sourcemaps
```

```js
// vite.config.js
import glitchlessSourcemaps from 'glitchless-sourcemaps/vite';
import { GAME_VERSION } from './src/version.js'; // wherever the version passed to Glitchless.init lives

export default defineConfig({
  plugins: [glitchlessSourcemaps({ version: GAME_VERSION, service: '<game-id>', deleteMaps: true })],
});
```

`version` and `service` must match what the game passes to `Glitchless.init` (the defaults are package.json's
`version` and `name`). The plugin builds with `build.sourcemap: 'hidden'`; leave `build.sourcemap` unset or set it to
`'hidden'`, because `true` points players' browsers at the maps. It uploads only when `GLITCHLESS_API_KEY` holds a
secret key that can upload source maps (tick "Can upload source maps" when creating it); put the key in CI secrets
or the user's environment, never in the game or a committed file. `deleteMaps: true` keeps the maps out of `dist`.
Without a key the build works as before and uploads nothing.

Other bundlers, or a CI step after the build (upload before deploying):

```bash
GLITCHLESS_API_KEY=… npx glitchless-sourcemaps upload dist --version 1.2.0 --service <game-id> --delete
```

`--url` (or `GLITCHLESS_URL`) is the Glitchless server, as for the MCP server.

## 5. Verify

1. Run the game, press `` ` ``: the Glitchless overlay shows fps, p95 frame time, draw calls, context gauges.
2. Play a level and die once. Then confirm data arrived: call `glitchless_list_games`, or open the dashboard.
3. If WebMCP is connected, call `glitchless_live_performance` and `glitchless_inspect_scene`.
