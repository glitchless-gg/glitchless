# Roblox

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.

The Glitchless SDK for Roblox (`roblox/` in the Glitchless repo; `~/.glitchless/roblox` if it's cloned there) is one
Luau ModuleScript, `Glitchless`, with a server half and a client half. Its README (`roblox/README.md`) has the whole
API; this is the order to wire it in.

How it works, because it shapes everything below: only server scripts can make HTTP requests on Roblox. So the
server sends everything: it keeps a session for each player (from joining to leaving) and one for itself, and each
player's client measures frames, stutters, errors and ping and hands them to the server over a RemoteEvent the module
makes. Calls from server scripts take the player first; calls from LocalScripts take no player.

## 1. Read the project

A Roblox game an agent can edit is usually files synced into Studio: a `default.project.json` (Rojo), often a
`wally.toml` (Wally packages in `ReplicatedStorage.Packages`), `aftman.toml` or `rokit.toml`, and `.luau` or `.lua`
files named `*.server.luau` (Scripts) and `*.client.luau` (LocalScripts). Note:

- where server code starts (ServerScriptService), where client code starts (StarterPlayerScripts, StarterGui,
  ReplicatedFirst), and where shared modules live (ReplicatedStorage);
- the game's rounds, races, stages or levels, and where each starts and ends (a round manager, checkpoints in an
  obby, a race finish line). On Roblox these are almost always in server scripts;
- deaths (`Humanoid.Died`, or the game's own health system), respawns, pickups, purchases (`MarketplaceService`
  `ProcessReceipt`, game passes, developer products);
- anything that creates many instances at once (projectiles, effects, map loading, Clone() in loops);
- any analytics the game already sends (`AnalyticsService`, `HttpService` calls, other SDKs).

If the game only lives in Studio (a `.rbxl` with no project files), you can't edit its scripts as files: work through
Studio's own MCP server (below), or ask the user to insert the module and paste the scripts.

### Studio's MCP server

Roblox Studio has an MCP server built in ([docs](https://create.roblox.com/docs/studio/mcp)): the user turns it on in
Assistant → … → Manage MCP Servers → **Enable Studio as MCP server**, and it is the stdio command
`/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` on a Mac (`cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` on
Windows), or one switch for Claude Code, Codex, Cursor and others under Quick connect. Every tool takes a `studio_id`
from `list_roblox_studios` (it can be empty for a second while the server finds Studio: ask again). With it you can:

- read and write the open place's scripts (`script_read`, `script_grep`, `multi_edit` in Edit), or set any script's
  `Source` with `execute_luau` (`datamodel_type: "Edit"`), so a Studio-only game can be instrumented;
- play it: `start_stop_play` (`is_start: true`, then `false`), `get_studio_state` (the mode), and
  `get_console_output`, which during a play test holds that test's Output only (Glitchless's `[glitchless]` warnings
  are there), and keeps it after Stop;
- look inside a running test: `execute_luau` with `datamodel_type: "Server"` or `"Client"`.

It reads and changes the user's open places: say what you will do before you do it.

## 2. Install

Put the module in ReplicatedStorage, the way the project manages code:

- **Wally** (a `wally.toml`): add `Glitchless = "glitchless-gg/glitchless@0.3.0"` under `[dependencies]`, run
  `wally install`, and require `ReplicatedStorage.Packages.Glitchless`.
- **Rojo without Wally**: copy `~/.glitchless/roblox/src` into the project (for example `src/shared/Glitchless`) so it
  syncs to `ReplicatedStorage.Glitchless`. Keep the files as they are: `init.luau` makes the folder the module, and
  `GlitchlessClient.client.luau` must stay a LocalScript inside it.
- **Studio only**: build the model with `rojo build ~/.glitchless/roblox/default.project.json -o Glitchless.rbxm`
  and ask the user to insert it into ReplicatedStorage (right-click → Insert from File).

Then the user turns on **Allow HTTP Requests** (Game Settings → Security). Tell them: without it nothing is sent, and
it can't be turned on from a script in a published game.

## 3. Initialize

One server Script that runs when the server starts (ServerScriptService):

```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Glitchless = require(ReplicatedStorage.Glitchless) -- ReplicatedStorage.Packages.Glitchless with Wally

Glitchless.init({
	service = "<the game's name in Glitchless>",
	clientToken = "<client token>",
	intake = "<intake URL>", -- leave out for Glitchless Cloud (https://api.glitchless.gg)
	properties = { mode = "classic" }, -- optional: what holds for every session
})
```

- The client token goes in this server Script only. It never reaches players' devices.
- `http://localhost:7777` works while the user tests in Studio (Studio runs on their computer); a published game's
  servers can't reach it. For a published game use Glitchless Cloud or the user's own server's `https://` address.
- The version defaults to the place's published version (`game.PlaceVersion`), which changes with every publish. Pass
  `version` only if the game has its own version string.
- No client code is needed: `init` puts the module's `GlitchlessClient` LocalScript in StarterPlayerScripts. If the
  game already has its own client bootstrap and wants it there, pass `client = false` and call
  `require(ReplicatedStorage.Glitchless).init()` from a LocalScript.
- In Studio, sessions are marked `tester` and `env` is `dev`, so test plays stay out of player numbers. Nothing else
  marks bots: Roblox has none.
- Calls made before Glitchless starts wait for it: a LocalScript that runs before `GlitchlessClient`, a server Script
  that runs before the one calling `init`, a `PlayerAdded` handler that runs before Glitchless's. Don't poll
  `isEnabled()` before calling, and don't call `init()` from the game's LocalScripts to hurry it.

## 4. Levels, deaths and the game's own events

From server scripts, the player first:

```lua
Glitchless.levelStart(player, "desert_loop", { mode = "ranked", laps = 3 })
Glitchless.levelComplete(player, "desert_loop", { score = placement, durationS = raceTime })
Glitchless.levelFail(player, "desert_loop", { cause = "out_of_time" })
Glitchless.track(player, "boost_used", { kind = "nitro" })
Glitchless.count(player, "coin", { source = "track" }, amount) -- a stream: added up, sent once a window
Glitchless.setProperties(player, { car_class = "s", rank_band = "gold" })
```

From a LocalScript (UI, input, client-side effects), the same calls without the player:

```lua
Glitchless.track("settings_opened", { from = "pause" })
Glitchless.setContext({ effects = #workspace.Effects:GetChildren() }) -- gauges on this device's frame windows
```

- **Levels**: an obby's stages, a race, a round, a dungeon floor. Use the game's own names. A player who leaves
  mid-level gets a `level_abandon` by itself; never send a fail for leaving.
- **Deaths** are sent by themselves when a player's Humanoid dies. If the game knows why (lava, fell, an enemy), call
  `Glitchless.death(player, { cause = "lava" })` where it handles the death: the first such call turns the automatic
  ones off, so each death is sent once, with its cause.
- **Purchases**: in `ProcessReceipt`, after granting the item:
  `Glitchless.track(player, "purchase", { item = productName, amount = price, currency = "ROBUX" })`, the price in
  Robux. Boards keep Robux apart from dollars (the dashboard's `currency: "ROBUX"`), and a panel can add an estimate in
  dollars at Roblox's DevEx rate. A purchase that didn't go through can be the same event with `result = "cancelled"`
  (and `result = "done"` on the ones that did); never send the receipt or purchase ID.
- **The server's own session** (the map it runs, its rounds): `Glitchless.server.levelStart(mapName)`,
  `Glitchless.server.track("round_started", { players = #Players:GetPlayers() })`.
- Never put a player's name, display name or user ID in an event, a level name or a property. The server scrubs
  the ones it can see, but a name it doesn't know (a friend who isn't in the server) would go through.

## 5. Multiplayer: matches and the server

Every Roblox game is multiplayer, and Glitchless measures the server (its frame rate, late frames, players, memory,
data rates, errors) and each player's ping by itself. Until the game sets a match of its own, everyone in a server and
the server share one match: the server. A game with rounds or races inside one server sets each as the match, on the
server and on every player in it, with the same ID:

```lua
local roundId = HttpService:GenerateGUID(false)
Glitchless.server.setGroup("match", roundId, { mode = "ranked" })
for _, player in Players:GetPlayers() do
	Glitchless.setGroup(player, "match", roundId)
end
-- when the round ends
Glitchless.server.endGroup("match")
for _, player in Players:GetPlayers() do
	Glitchless.endGroup(player, "match")
end
```

Parties (players who queued together) use `"party"`. IDs are hashed before they're sent.

### Extras for hangouts and hubs

Four more things the server reads by itself once `init` turns them on, each off by default. Ask the user which fit,
and turn on those:

| Option | Turn it on when | What arrives |
| --- | --- | --- |
| `prompts = true` | the game uses ProximityPrompts (doors, shops, NPCs, machines) | `prompt` counts by `action` and `object` (the prompt's ActionText and ObjectText) |
| `seats = true` | players sit (sofas, cars, rides, arcade cabinets) | `sit` counts by `seat` (the seat's or its model's name) and `vehicle` |
| `joinedWithFriend = true` | it's social: do players who follow a friend in stay longer? | the session property `joined_with_friend`, to split anything by |
| `friendsInServer = true` | the same, while they play | the gauge `friends_in_server` on every frame window |

They replace hand-written `count` calls for prompts and seats: don't add both. Name prompts' ActionText and
ObjectText, and seats' models, in words a board can show ("Open", "Starter Pack"; "Sofa", "Kart").

Glitchless uses up to 100 of a server's 500 HTTP requests a minute (`requestsPerMinute`). If the game makes many
HTTP requests of its own, lower it; with many players, each one's batches simply come less often.

## 6. The player's off switch

If the game has a settings menu, add a "Share performance data" toggle. From the LocalScript that runs the menu:

```lua
toggle.Activated:Connect(function()
	local on = not Glitchless.isEnabled()
	Glitchless.setEnabled(on)
	-- show `on` in the toggle
end)
```

Glitchless keeps the choice in the game's DataStore (`Glitchless` store, key `u<UserId>`) and reads it when the player
joins, so it holds on every server. Tell the user: in Studio this needs Enable Studio Access to API Services and a
published place, and the key is the player's data under Roblox's erasure requests (delete it with the rest). With
`optIn = true` in `init`, nothing is sent for a player until the game calls `Glitchless.setEnabled(player, true)`
(after asking them).

## 7. Privacy

The Roblox SDK is anonymous only: there is no install or full mode, so it can't count returning players. Roblox can,
by account: on Glitchless Cloud, connect the experience in Settings → Integrations → Roblox (its universe ID, or its
roblox.com address) with an Open Cloud API key the user makes in Creator Dashboard → Open Cloud → API Keys, with the
experience under Access Permissions → `universe-analytics` and only `universe.analytics:read`. Roblox's D1, D7 and D30
retention, daily active and new users, Robux and its crash rate and frame rate by place version then show on the
game's Roblox page and in `glitchless_store` (`show: "vitals"`, `store: "roblox"`) and `glitchless_revenue`. Without a
key it still brings players now and the thumbs up and down. The user pastes the key there themselves; it never goes in
the game. Every session has a random ID, and no user ID, name or display name is sent.
Roblox's rules count those identifiers as protected data; `roblox/PRIVACY.md` has what Roblox's policies say, every
field sent, and a paragraph for the game's privacy notice. If the game sets properties, the notice needs the
properties line.

Positions are off. With `positions = true` in `init`, the server samples each player's character position for
heatmaps and puts deaths on the map; ask the user first. The extras (section 5) are counts and true/false only; with
`friendsInServer` or `joinedWithFriend`, the privacy notice gets the friends line in `roblox/PRIVACY.md`.

### A map under the heatmap

With positions on, give the heatmap a map. The server draws one itself, from the place's parts, one ray down per
pixel; call it once the place is built, from a server Script:

```lua
task.spawn(Glitchless.captureMap)                                                -- the whole place
task.spawn(Glitchless.captureMap, { zone = "hall", area = workspace.Zones.Hall })  -- a zone, by its volume
task.spawn(Glitchless.captureMap, { level = "obby_1", area = workspace.Obby1 })    -- a level, by its folder
```

Its map is the parts' colours, lit and outlined (no textures or decals). For a picture that looks like the game,
take one in Studio with Studio's MCP server: `execute_luau` (`datamodel_type: "Edit"`) with
`return require(game.ReplicatedStorage.Glitchless).mapBounds(workspace.Zones.Hall)` for the rectangle on x and z,
then `screen_capture` with `camera_position` high above its centre and `look_at_position` straight below. The
picture's top edge is the smallest z, its left edge the smallest x. Hand it and the bounds to the game's map upload.

## 8. Check that it works

1. In Studio, press Play (Test → Start Test Session → Test) with the intake set (`http://localhost:7777` for a local
   server), play for half a minute, then Stop. Stop closes the server, which sends everything. With Studio's MCP
   server, do it yourself: `start_stop_play` with `is_start: true`, wait, then `false`.
2. The Output window shows `[glitchless]` warnings if something is off (HTTP requests off, a token refused, a
   property dropped). One about DataStore in an unpublished place is expected.
3. Call `glitchless_list_games`: the game is listed, with its server under it (`<game>.server`). Then
   `glitchless_triage` (game set) shows the sessions, `glitchless_servers` the server's frames, and
   `glitchless_session` one player's frame windows, level and errors.

## 9. Playtests

`glitchless_playtest` with `engine: "roblox"` plays the place open in Studio before and after a change and compares the
two, over Studio's MCP server (it must be on; with several Studios open, pass `studio`, part of the place's name). The
game needs an autoplay mode it turns on from Workspace attributes, which the playtest sets before each play test and
puts back after (by default `autoplay = true` with `seed = 7`, then `seed = 21`):

```lua
-- In the server Script that calls Glitchless.init:
local autoplay = workspace:GetAttribute("autoplay")
Glitchless.init({
	-- …the options above, and:
	sessionType = if autoplay then "synthetic" else nil, -- a bot's sessions stay out of player numbers
})
if autoplay then
	local rng = Random.new(workspace:GetAttribute("seed") or 1) -- the same seed plays the same way
	-- drive each player's character (Humanoid:MoveTo, the game's own actions), Glitchless.levelStart as it goes,
	-- and when the run is over:
	workspace:SetAttribute("GlitchlessPlaytestDone", true)
end
```

A play test ends when `GlitchlessPlaytestDone` is true, or after 90 seconds (a scenario's `max_s`). The playtest reads
the run back from the Glitchless server the MCP server reads, so the game's intake must be that server. Without
Allow HTTP Requests, or with Studio in a play test already, it stops and says so. `roblox/demo/server.server.luau`
in the Glitchless repo does this.

A published game's first sessions arrive once real players join a server running the new version. Each publish is a
new place version (`game.PlaceVersion`), which the SDK sends as the game's version, so `glitchless_compare_versions`
and Roblox's own vitals line up version by version.
