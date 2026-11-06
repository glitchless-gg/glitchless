# Glitchless for Roblox

Game observability for coding agents, in a Roblox experience: every player's frame times, stutters, errors and
connection, your game servers' frame rate and memory, and your game's own events (races, levels, deaths, coins), sent
to [Glitchless](https://glitchless.gg) so your coding agent can see what players hit and fix it.

It's one ModuleScript, written in Luau, with a server half and a client half:

- **On each player's device** it times every frame and reads Roblox's `Stats` service (render and GPU time, physics,
  draw calls, triangles, instances), notes stutters and what caused them, catches errors from your LocalScripts, and
  samples the player's ping. Roblox only lets server scripts make HTTP requests, so the client hands all of this to
  your server over a RemoteEvent.
- **On the server** it keeps a session for each player (from joining to leaving) and one for the server itself, checks
  everything clients send, and posts it all to Glitchless with `HttpService`, within a budget of requests a minute.

Players are anonymous. Their sessions carry random IDs, never a user ID, name or display name, and the server scrubs
players' names and user IDs out of everything it sends (see [PRIVACY.md](PRIVACY.md)).

## Install

Put the `Glitchless` module in **ReplicatedStorage**, whichever way you manage your code:

| | |
| --- | --- |
| **Wally** | `Glitchless = "glitchless-gg/glitchless@0.1.0"` under `[dependencies]` in `wally.toml`, then `wally install` (it lands in `ReplicatedStorage.Packages`) |
| **Rojo** | copy `roblox/src` into your project as a folder named `Glitchless`, mapped under `ReplicatedStorage` (see `place.project.json` here) |
| **Studio** | download `Glitchless.rbxm` from the [release](https://github.com/glitchless-gg/glitchless/releases), right-click ReplicatedStorage → **Insert from File**. Or take it from the Creator Store |

Then turn on **Allow HTTP Requests** (Game Settings → Security). Without it Roblox refuses every request, and
Glitchless says so in the Output window in Studio.

## Start it

One server Script, in ServerScriptService:

```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Glitchless = require(ReplicatedStorage.Glitchless) -- ReplicatedStorage.Packages.Glitchless with Wally

Glitchless.init({
	service = "nardo-racing",      -- your game's name in Glitchless
	clientToken = "gl_pub_…",      -- from glitchless_create_game, or Settings → Games in Glitchless Cloud
})
```

That's all. `init` puts the `GlitchlessClient` LocalScript it ships in StarterPlayerScripts, so every player who joins
starts measuring with no client code. Call `init` when the server starts, before players join.

It sends to Glitchless Cloud (`https://api.glitchless.gg`). For your own Glitchless server pass
`intake = "https://glitchless.example.com"`; for a server on your Mac while you test in Studio,
`intake = "http://localhost:7777"` (Studio can reach your Mac; a live server can't).

The client token only writes, and it never leaves your server: it lives in a server Script, and clients never see it.

## What it measures without any code

| | |
| --- | --- |
| **Players' frames** | a frame window every 5 s for each player: frame times as a sketch the server merges, p50/p95/p99, slow and janky frames, the screen's rate, render CPU and GPU time, physics, draw calls, triangles, Luau memory, the client's memory and instance count |
| **Stutters** | a frame over 50 ms and twice the device's usual, with its likely causes: `asset_load` (assets still downloading), `object_spawn` (500+ instances in one frame), `physics`, `render`, `script` (none of those: Luau or the engine's other work), `frozen` (over 0.7 s) |
| **Errors** | every error in your LocalScripts and server Scripts (`ScriptContext.Error`), with its script, line and function, grouped into issues |
| **Loading** | how long each player sat on the loading screen: from joining to their first frame after the game loaded |
| **The connection** | each player's round trip to the server (`GetNetworkPing`) and the data in and out, once a second |
| **Deaths** | each time a player's Humanoid dies (`deaths = false` turns this off) |
| **The device** | the kind of device in Roblox's own words (`Computer`, `Phone`, `Tablet`, `Console`, `VR`: Roblox doesn't tell scripts the OS), screen size, graphics quality, and whether it has touch, a keyboard or a gamepad |
| **Your servers** | each server's own session: its frame rate (Heartbeat), late frames, players, memory, the data it sends and receives, the players' pings as it sees them, and its errors |
| **Sessions** | one per player join, ending when they leave (`quit`), are kicked (`kicked`) or the server closes (`close`) |
| **Matches** | until your game sets matches of its own, everyone in a Roblox server and the server itself share one match (the server), so Glitchless can tell a whole server lagging from one player's bad connection |

In Studio, sessions are marked `tester` and `env` is `dev`, so they stay out of your players' numbers. The version is
your place's published version (`game.PlaceVersion`) unless you pass `version`.

## What your game tells it

From a **server Script**, a player's session is the first argument; from a **LocalScript** there's no player argument
(the call is for the player whose device it runs on, and goes through the server):

```lua
-- server
Glitchless.levelStart(player, "desert_loop", { mode = "ranked", laps = 3 })
Glitchless.track(player, "boost_used", { kind = "nitro" })
Glitchless.count(player, "coin", { source = "track" }, 5)
Glitchless.levelComplete(player, "desert_loop", { score = 1, durationS = 93.2 })
Glitchless.setProperties(player, { car_class = "s" })

-- LocalScript
Glitchless.track("settings_opened", { from = "pause" })
Glitchless.setContext({ particles = #workspace.Effects:GetChildren() })
```

| Call | When |
| --- | --- |
| `levelStart(player, level, attrs?)` | a level, stage, race or round begins; every event after it carries it. `attrs` describe the attempt |
| `levelComplete(player, level?, { durationS?, score? })` | the player beat it |
| `levelFail(player, level?, { cause })` | the player lost it (fell, ran out of time) |
| `levelAbandon(player, level?)` | the player left it before it ended (back to the lobby); never a fail. Sent by itself when a player leaves mid-level |
| `death(player, { cause })` | the player died, with a cause. The first call turns automatic Humanoid deaths off, since your game reports its own |
| `track(player, name, attrs?)` | any event of your game's own: words, numbers, true/false, or lists |
| `count(player, name, attrs?, n?)` | a stream (coins, hits, kills): added up and sent once a window, so a stream never floods anything |
| `setProperties(player, { key = value })` / `clearProperty(player, key)` | what holds for the session in your game's words: a mode, a car class, a rank tier |
| `setZone(player, name)` | where the player is in an open world; `nil` clears it |
| `setGroup(player, "match" \| "party", id, attrs?)`, `setGroup(player, "run")`, `endGroup(player, kind)` | the match, party or run the player's next events belong to (server only). IDs are sent hashed |
| `error(player, err, attrs?)` | an error your game caught |
| `setContext(gauges)` | numbers to watch on the device (LocalScript), attached to frame windows and stutters; a number that only climbs reads as a leak |
| `setEnabled(player, on)` / `setEnabled(on)` | the player's "share performance data" setting (below) |
| `isEnabled(player?)` | whether Glitchless is on for that player |
| `flush()` | send what's waiting now (it sends every 15 s by itself, and everything when the server closes) |

The server's own session has the same calls under `Glitchless.server`, without the player:
`Glitchless.server.levelStart(map)`, `.track`, `.count`, `.setProperties`, `.setZone`, `.setGroup`, `.endGroup`,
`.levelComplete`, `.levelFail`, `.error`.

Names and words are the game's: a string up to 64 characters. Properties follow stricter rules (lower-case keys, no
`name` or `user_id`, no values that look like an ID or an email address) and anything that breaks them is dropped with
one warning in Studio.

## Options

| Option | Default | |
| --- | --- | --- |
| `service` | required | your game's name in Glitchless |
| `clientToken` | required | the game's public client token |
| `intake` | `https://api.glitchless.gg` | where to send: Glitchless Cloud, your own server, or `http://localhost:7777` while testing in Studio |
| `version` | `game.PlaceVersion` | your build's version; compare versions after a fix |
| `env` | `dev` in Studio, else `prod` | |
| `properties` | none | properties every session starts with |
| `requestsPerMinute` | `100` | Glitchless's share of the server's 500 HTTP requests a minute. One request carries one session's batch, so with many players each one's batches come less often and hold more |
| `flushInterval` | `15` | seconds between a session's batches, when the budget allows |
| `sampleRate` | `1` | the share of players whose sessions are sent |
| `positions` | `false` | sample each player's character position 4 times a second (`positionHz`) for heatmaps, and put deaths on the map |
| `deaths` | `true` | send a death when a player's Humanoid dies |
| `serverAsMatch` | `true` | a server's players and the server share one match until the game sets its own |
| `hashGroupIds` | `true` | match and party IDs are hashed before they're sent |
| `optIn` | `false` | nothing is sent for a player until `setEnabled(player, true)` |
| `saveChoice` | `true` | keep each player's on/off choice in your DataStore (below) |
| `region` | none | the region your servers run in, in your words |
| `sessionType` | `tester` in Studio, else `user` | |
| `client` | `true` | put `GlitchlessClient` in StarterPlayerScripts. With `false`, call `Glitchless.init()` from a LocalScript yourself |
| `debug` | on in Studio | warnings in the Output window |

## The player's off switch

`Glitchless.setEnabled(player, false)` (from the server) or `Glitchless.setEnabled(false)` (from a LocalScript, say a
settings toggle) stops measuring and sending for that player at once and drops what was waiting; `true` starts a new
session. The choice is saved in your experience's DataStore (`Glitchless`, key `u<UserId>`, value `on` or `off`) and
read when the player next joins, so a player who said no sends nothing from the moment they join. It never leaves
Roblox. If you handle Roblox's right-to-erasure requests, delete that key along with your own. In Studio, DataStore
needs **Enable Studio Access to API Services** (Game Settings → Security) and a published place; without them the
choice isn't kept, and Glitchless says so once. `saveChoice = false` leaves keeping it to your game.

## Ask your agent

With the Glitchless MCP server connected, ask in plain words: *what's wrong with my game this week*, *which phones
stutter*, *is the desert map's server lagging*, *where do players die*, *did version 42 fix the respawn error*.
`glitchless_triage`, `glitchless_performance`, `glitchless_servers`, `glitchless_match`, `glitchless_network` and
`glitchless_player_funnel` read what this SDK sends.

## How it sends

- One request is one session's batch (`POST /v1/intake?token=…`, gzipped over 1 KB), each with its own `batch_id`
  so a retry is stored once. Failed requests are tried again (2 s, 4 s, 8 s… up to 5 minutes, 12 tries); a refused
  token stops everything with one warning.
- Glitchless asks `GET /v1/health` once at start. The server's own session is sent only to a Glitchless server that
  keeps game servers apart from players (`server_mode`), and counters only to one that takes them.
- When the server closes (`BindToClose`), every session ends and everything goes at once, within 25 of the 30 seconds
  Roblox gives.

The full wire format is [SPEC §5e](../docs/SPEC.md).

## Tests

The SDK's core is plain Luau, tested outside Roblox under [Lune](https://lune-org.github.io/docs) against a small fake
of Roblox's services (`test/lib/roblox.luau`): players joining with clients of their own, RemoteEvents between them,
virtual time, and HTTP that's fake or real.

```bash
brew install lune rojo
lune run roblox/test/run                     # the Luau tests, from the repository root
node roblox/test/make-fixtures.mjs           # after a change to the JavaScript sketch, fingerprint or property rules
node --test roblox/test/e2e.mjs              # a race over real HTTP to a local Glitchless server
node --test roblox/test/studio.mjs           # a play test in Roblox Studio, over Studio's MCP server (below)
rojo build roblox/default.project.json -o Glitchless.rbxm         # the Creator Store model
rojo build roblox/place.project.json -o GlitchlessTest.rbxl       # a test place with a demo, for Studio
```

The sketch, error fingerprints, property rules and match ID hashes are checked against the JavaScript SDK's own output
(`test/fixtures/js-fixture.json`), so a Roblox player's frames merge with everyone else's.

`test/studio.mjs` plays the test place in real Roblox Studio through Studio's own
[MCP server](https://create.roblox.com/docs/studio/mcp) (Assistant → … → Manage MCP Servers → Enable Studio as MCP
server; it runs `StudioMCP` from the Studio app over stdio). It copies `src` and the demo into the open test place (it
opens one with Rojo's build if none is), points the demo at a Glitchless server of its own, starts a play test (a
server and one player), stops it when the demo's race ends, and checks what arrived and what Studio's Output said. It
only ever touches an unpublished place with the demo in it.
