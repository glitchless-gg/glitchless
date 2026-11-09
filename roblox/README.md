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
players' names and user IDs out of everything it sends (see [PRIVACY.md](PRIVACY.md)). The server can also draw a
top-down map of the place for heatmaps ([below](#a-map-for-heatmaps)).

## Install

Put the `Glitchless` module in **ReplicatedStorage**, whichever way you manage your code:

| | |
| --- | --- |
| **Wally** | `Glitchless = "glitchless-gg/glitchless@0.3.0"` under `[dependencies]` in `wally.toml`, then `wally install` (it lands in `ReplicatedStorage.Packages`) |
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
| **The device** | the kind of device in Roblox's own words (`Computer`, `Phone`, `Tablet`, `Console`, `VR`: Roblox doesn't tell scripts the OS), on a console whether it's an Xbox or a PlayStation (from its controller, so boards and the Performance view split the two), screen size, graphics quality, and whether it has touch, a keyboard or a gamepad |
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
| `isEnabled(player?)` | whether Glitchless is on for that player. Before it has started: whether a call made now will be kept, so `true` unless `setEnabled(false)` was called |
| `captureMap(options?)` | a top-down map of the place for heatmaps, drawn by the server ([below](#a-map-for-heatmaps)) |
| `mapBounds(area?)` | the place's (or an area's) extent on x and z, printed for an agent |
| `flush()` | send what's waiting now (it sends every 15 s by itself, and everything when the server closes) |

The server's own session has the same calls under `Glitchless.server`, without the player:
`Glitchless.server.levelStart(map)`, `.track`, `.count`, `.setProperties`, `.setZone`, `.setGroup`, `.endGroup`,
`.levelComplete`, `.levelFail`, `.error`.

**Calls made before Glitchless starts wait for it.** A LocalScript that runs before the shipped `GlitchlessClient`,
a server Script that runs before the one that calls `init`, a `PlayerAdded` handler that runs before Glitchless's:
their calls are kept and made when Glitchless starts (or, for a player, as soon as it sees them join), a client's at
the time they were made. No need to wait for `isEnabled()` first. At most 128 calls wait, and only the latest zone,
properties (merged by key), gauges and on/off choice; in Studio, Glitchless says so if calls are still waiting after
30 s (`init` never ran on the server).

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
| `prompts` | `false` | count each ProximityPrompt a player triggers ([extras](#extras-you-turn-on)) |
| `seats` | `false` | count each Seat and VehicleSeat a player's character sits in |
| `joinedWithFriend` | `false` | the session property `joined_with_friend`: whether the player followed a friend into the server |
| `friendsInServer` | `false` | the gauge `friends_in_server`: how many of the player's friends are in the same server |

## Extras you turn on

Four more things Glitchless can read by itself, each off until `init` turns it on. All are counts or true/false:

```lua
Glitchless.init({ service = "starlift", clientToken = "gl_pub_…", prompts = true, seats = true, joinedWithFriend = true, friendsInServer = true })
```

| Option | What arrives |
| --- | --- |
| `prompts` | each `ProximityPrompt` a player triggers (`ProximityPromptService.PromptTriggered`), counted as `prompt` in their counters, by the prompt's `ActionText` and `ObjectText` (`action`, `object`). Players' names are scrubbed out of both first, so a prompt on a player's plot counts as `<player>'s House` |
| `seats` | each `Seat` or `VehicleSeat` a player's character sits in (`Humanoid.Seated`), counted as `sit`, by the seat's name (its model's when the seat is still called `Seat`, so a sofa's seat counts as `Sofa`) and `vehicle` (true for a VehicleSeat) |
| `joinedWithFriend` | the session property `joined_with_friend`: `true` when the player followed someone into this server (joined from a friend's profile, `Player.FollowUserId` isn't 0). Only the yes or no is sent, never whose ID |
| `friendsInServer` | the gauge `friends_in_server` on each of the player's frame windows: how many of their friends are in the same server as the window ends. The server asks Roblox about each pair of players once (`Player:IsFriendsWith`, a web request, in a thread of its own, never in a frame; tried twice more if it fails), keeps the answers while both are in the server, and counts again as players come and go. A player who turned Glitchless off isn't counted in anyone's |

Read them with `glitchless_events` (`prompt` and `sit` by their words, `joined_with_friend` as a property to split
anything by) and in frame windows' gauges (`friends_in_server`).

## A map for heatmaps

With `positions = true`, boards draw where players go and die as a heatmap; under it they draw the place's map. A
Roblox script can't take a picture of the place (CaptureService only captures a player's own screen, when the player
chooses, and reading its pixels needs EditableImage, which a published experience can only use with an ID-verified
owner), so the server draws one: a ray straight down for every pixel, coloured by the part or terrain it hits, lit by
its slope and height, with a dark rim on whatever stands above its surroundings (walls, ledges). Players' characters
and fully transparent parts (zone volumes, invisible walls) are left out. From a server Script, once the place is
built:

```lua
task.spawn(Glitchless.captureMap)                                        -- the whole place
task.spawn(Glitchless.captureMap, { level = "desert_loop" })              -- a level's map
task.spawn(Glitchless.captureMap, { zone = "hall", area = workspace.Zones.Hall })  -- a zone's, by its volume
```

| Option | |
| --- | --- |
| `level`, `zone` | the map is that level's or that zone's; neither: the whole place |
| `area` | a part, model or folder whose parts bound the map (every part in it, seen or not: a zone's volume). Without one, the place's visible parts |
| `bounds` | `{ min = { x, z }, max = { x, z } }` in studs, instead of an area |
| `top` | rays start here (studs): set it below a roof to see inside |
| `size` | pixels on the longer side, `256` (512 at most) |
| `exclude` | instances to leave out (players' characters always are) |

It takes a few seconds and at most 3 ms of any frame, then sends one `map` event (a JPEG of 60 KB at most, its
bounds on the x and z axes) in a batch of its own, which starts no session. Once per version is enough: boards use
the latest map. It returns `{ axis, bounds, size, image, top, bottom }`. Parts are drawn in their `Color`: textures,
decals and a MeshPart's look aren't, so a place built of meshes reads as their shapes.

**A map from Studio.** For a picture that looks like the game, take it in Studio and give it to your agent with its
bounds. `Glitchless.mapBounds(area?)` prints the place's (or an area's) extent as JSON in the Output, for example
`[glitchless] map bounds: {"axis":"xz","bounds":{"min":[-60,-42],"max":[60,42]},"top":6,"bottom":-2}`; it works in
the command bar, started or not. Then look straight down on that rectangle: an agent with Studio's MCP server can run
`mapBounds` with `execute_luau` (`datamodel_type: "Edit"`) and take the picture with `screen_capture`
(`camera_position` above the rectangle's centre, `look_at_position` straight below it); by hand, set the camera's
`FieldOfView` low (5°) and move it high above the centre, looking down, so the view is close to flat, and screenshot
the viewport cropped to the rectangle. The picture's top edge is the bounds' smallest z and its left edge their
smallest x, as boards draw an xz map. `captureMap` in the command bar (Edit mode) draws the map and prints its bounds
without sending it. During a play test the command bar's `require` gets a copy of the module that was never started,
so its `captureMap` waits for an `init` that never comes: call it from the game's own server Script, or in Edit mode.

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
