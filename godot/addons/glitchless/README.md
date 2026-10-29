# Glitchless for Godot

A Glitchless SDK for Godot 4.5 and later, built for 4.7 and the Mobile renderer. It sends the same events as the browser SDK (`packages/sdk`), so a Godot game shows up in the same Glitchless server, dashboard, findings, Datadog forwarding and MCP tools with no server changes beyond the small ones listed under [Limits](#limits).

It reports:

- **Frame times.** Each 5 s window carries a mergeable 2% sketch, so the server's p95 and p99 cover every player. Slow frames are flagged the way the browser SDK flags them.
- **Hitches with likely causes.** A pipeline (shader) compile, a burst of new nodes, a scene change, slow `_process` code, physics, rendering, or a frozen frame. Each hitch also carries the game's gauges and the events in the 1.5 s before it.
- **Engine counts.** Draw calls, primitives, objects, nodes, orphan nodes, video memory, and static memory (debug builds only). They're the leak watch.
- **Errors** through Godot 4.5's custom loggers, with script backtraces and the last game events as breadcrumbs.
- **Play events:** the level funnel, deaths, game events and gauges.
- **The device:** a coarse tier, renderer, screen size and the refresh rate the OS reports (the rate the game ran at is measured from its frames, in each frame window). The screen size also shows whether an iPhone Duo is open or closed.
- **Bug reports from players**, when the game turns them on: F8 (or the game's own button) opens a short form, and the report carries what the player typed, a screenshot, where they were and what had just happened.
- **Multiplayer:** ping, packet loss and disconnects from Godot's own MultiplayerAPI (ENet, and WebSocket for web exports), which match and party each event belongs to, and a dedicated server's tick time and players, kept apart from players' sessions.
- **Genre numbers:** counters for streams of events (shots, kills, gold), properties that hold for a session (mode, rank tier, class, region), level attributes (difficulty, party size) and zones in an open world.

It also has an agent flag, `--glitchless-measure=SECONDS`, which prints frame stats as JSON and quits. It's the native version of the browser SDK's `glitchless_measure` tool.

Anonymous mode, the default, sends nothing that can be tied to a person. [PRIVACY.md](PRIVACY.md) lists every field each mode sends. [PORTING.md](PORTING.md) shows how a game that counts events with its own `Metrics.count(event, word)` moves over.

## Install

1. Copy `addons/glitchless/` into the game's `addons/`.
2. Add the autoload. Either turn on the plugin under *Project Settings → Plugins*, or add this line under `[autoload]` in `project.godot`:

   ```ini
   Glitchless="*res://addons/glitchless/glitchless.gd"
   ```

3. Optional, for script lines on errors in release builds: *Project Settings → Debug → GDScript → Always Track Call Stacks* (`debug/settings/gdscript/always_track_call_stacks=true`). It makes every GDScript call do a little more work. Without it, a release build reports the engine's own file and function instead.

The addon uses no `class_name`, so it adds no global names and works in a project that has never been opened in the editor.

## Use

```gdscript
func _ready() -> void:
	Glitchless.init("starlift", "", "prod", "https://glitchless.example.com")  # "" = the Steam build, else application/config/version

Glitchless.level_start("voyage_3")
Glitchless.level_complete("voyage_3", score)          # duration measured since level_start
Glitchless.level_fail("voyage_3", "lost")              # lost it: died, ran out of time
Glitchless.level_abandon("voyage_3")                  # left it: home, restart, a menu. Never a fail
Glitchless.death(pos.x, pos.y, "meteor")              # the place is sent only when positions are on
Glitchless.track("play", "endless")                   # one word, a number, or a dictionary
Glitchless.set_context({"blocks": blocks.size()})     # at the end of the frame's work
Glitchless.set_position(player.position)              # ignored unless positions are on
Glitchless.error("save slot unreadable", {"slot": 2}) # an error the game caught itself
var stats := await Glitchless.measure(5.0)            # what --glitchless-measure prints
Glitchless.open_bug_report()                          # the bug report form, from a pause menu
await Glitchless.report_bug(note)                     # or a report from the game's own form
Glitchless.count("kill", {"monster": "elite"})        # a stream of events: counted, sent once a window
Glitchless.set_properties({"mode": "squads", "rank": "gold"})  # what holds for this session
Glitchless.level_start("pit_80", {"tier": "pit_80", "party_size": 3})  # an attempt with its attributes
Glitchless.set_group("match", match_id)               # every event until set_group("match", null) carries it
Glitchless.set_zone("ashen_wastes")                   # where the player is in an open world
Glitchless.set_enabled(on)                            # the player's "Share performance data" setting
Glitchless.is_enabled()                               # true while this build sends and the player hasn't turned it off
```

**Leaving a level is not losing it.** Call `level_abandon()` when the player leaves a level before it ends (goes to the menu, restarts it), not `level_fail()`: the funnel counts abandons apart, they are never rage quits, and walls are judged only on the sessions that played a level to an end. When the game goes to the background or closes with a level started and not yet completed, failed or abandoned, Glitchless sends the abandon itself, before the session's end, and drops a `level_fail` or `level_abandon` the game sends for that level afterwards (from `_exit_tree`, say). Back from the background in the same session, the level carries on and the server takes the abandon back.

`track` is for the game's own metrics, whatever they are: `track("open", "full")`, `track("play", "endless")`,
`track("buy", {"step": "done"})`. One word becomes the attribute `what`. The dashboard's Events page counts each
event over time, breaks it down by attribute and builds funnels between events, and the game's own dashboard (its
pages designed by your coding agent with `glitchless_set_dashboard`) shows the ones that matter. Attributes are strings, numbers or
booleans, at most 12 per event.

Purchases have one convention in every Glitchless SDK:
`Glitchless.track("purchase", {"amount": 4.99, "currency": "USD", "item": "gems_500"})`. Send it when the store confirms the purchase, with `amount` a number in the currency's units (4.99, not 499) and `currency` the ISO code the store charged in. Boards add the amounts up into revenue, revenue per player and revenue by item, in the game's one currency: purchases in another are listed as left out, not added in. Never send receipts, order ids or payment details. A purchase made in a TestFlight or development install on iOS is a free sandbox purchase: the SDK adds `sandbox: true` to it (to an event named `purchase`, or any with a `currency`), and boards count it but never add it into revenue. On Android, pass `sandbox: true` yourself when the billing library says the purchase was a test one (RevenueCat's `isSandbox`).

`init(service, version, env, intake, options)` options. Every one is optional.

| option | default | |
| --- | --- | --- |
| `privacy` | `"anonymous"` | `"install"` adds a random player ID kept in `user://`, so retention can be counted; `"full"` that, device detail and positions. See [PRIVACY.md](PRIVACY.md) |
| `positions` | on in full mode only | death places and 4 Hz position samples |
| `client_token` | `"gl_pub_dev"` | the server's `GLITCHLESS_CLIENT_TOKENS` |
| `sample_rate` | `1.0` | the share of sessions that send |
| `flush_interval` | `5.0` | seconds between batches; the first goes 2 s after `init` |
| `session_type` | `"user"` | `"synthetic"` is automatic with `--autoplay`, `--glitchless-synthetic`, `--glitchless-measure` or `--headless`, and on the phones Google Play's pre-launch report runs a new build on (the Android setting `firebase.test.lab`, or a GPU that draws in software, as theirs do). `"tester"` is automatic on a TestFlight or development install on iOS (a TestFlight build is a release build, so it reports `prod` like the App Store; the receipt Apple writes with every App Store install tells them apart), and keeps testers out of the players' numbers |
| `session_timeout` | `300.0` | seconds in the background after which coming back starts a new session |
| `engine_gauges` | `true` | put `nodes`, `orphan_nodes` and `objects` in `ctx` |
| `measure_render_time` | `true` | renderer CPU (and GPU, where the driver reports it) time per frame |
| `capture_warnings` | `false` | also report `push_warning` and engine warnings |
| `rage_input` | off on phones | the same key or tap four times in a second; fast tapping is normal play in a phone game |
| `enabled` | off in debug builds | force sending on or off. This is the build's switch, which the player's [off switch](#the-players-off-switch) can't override |
| `opt_in` | `false` | `true`: each device starts off until the game calls `set_enabled(true)`, for a game that asks the player first. A choice the player already made wins. A dedicated server has no player to ask, so it starts on |
| `debug` | `false` | print each batch |
| `bug_reports` | `false` | `true`, or `{"hotkey": KEY_F8, "pause": true, "screenshot": true}`: F8 opens the [bug report form](#bug-reports) |
| `properties` | `{}` | the session's [properties](#properties) from the start, as `set_properties` takes them |
| `hash_group_ids` | `true` | send [match and party IDs](#matches-parties-and-runs) hashed; `false` sends them as the game's server made them |
| `network` | `true` | read [ping, packet loss and disconnects](#multiplayer-ping-packet-loss-and-disconnects) from Godot's MultiplayerAPI |
| `role` | `""` | `"server"` makes this a [dedicated server](#dedicated-servers); `"player"` stops a game's own `--server` flag from meaning one. `""`: a dedicated-server export, `--glitchless-server` or `--server` is a server |
| `region` | `""` | a server's region, in the game's words (`"eu-west"`) |
| `max_players` | `0` | the most players a server takes |
| `session_per_match` | `false` | a server's session lasts one match, for a server that hosts one at a time |

Frame times, errors and events are collected from the first frame. They wait in memory until `init()`, so a game can call it after loading its settings. A player who turned Glitchless off has nothing collected from the first frame on.

### Retention needs install mode

In anonymous mode (the default) nothing is kept between launches, so the dashboard can't tell a returning player from a new one. `{"privacy": "install"}` keeps a random `p_…` player ID in `user://glitchless/player_id` (the one full mode uses) and sends it with every batch; nothing else changes. The Players page and `retention` board panels then show D1, D7 and D30. `Glitchless.reset_install_id()` forgets it (for a "reset my ID" setting): this session keeps its ID, the next launch makes a new one. On a Steam Deck, `session_start` carries `steam_deck: true` and, on SteamOS, `os: "SteamOS"` (Linux builds and Windows builds under Proton).

### Steam

If the game already uses [GodotSteam](https://godotsteam.com), every session also says which Steam build and beta branch it ran, whether on a Steam Deck (with GodotSteam 4.21, also a Steam Machine or Steam Frame, and Proton), in Big Picture mode, with which kind of controller, in which Steam language, and whether through Family Sharing or a timed trial. Nothing to set up and no dependency: the addon reads the `Steam` singleton only when the game has one (`Engine.has_singleton("Steam")`), and only once GodotSteam says Steam is initialised (`steamInitEx()`, initialising from the Project Settings, or `steamInit()` with your app ID), since its calls print engine errors before that. The facts are read when the first batch goes, so a game that initialises Steam after Glitchless still sends them. The controller is known once the game has called `inputInit()`. No Steam ID or name is ever read ([PRIVACY.md](PRIVACY.md#steam-facts) has a paragraph for your privacy page).

**Versions are Steam builds.** Pass `""` as the version and a Steam build reports `steam-<build>` (`steam-18231`), so every upload to Steam is a version the Versions page and `glitchless_compare_versions` can compare. Outside Steam it falls back to `application/config/version`. A version you pass always wins.

**Branches.** Filter any dashboard query with `steam_branch=beta`, split a breakdown panel by `$steam_branch`, or compare branches with a versions panel `by: "$steam_branch"` or `glitchless_compare_versions` with `by: "steam_branch"`.

### Off in debug builds

As with the `Metrics` autoload in Linebreakers and Starlift, a debug build (the editor, or an export with debug on) sends nothing unless it is run with `--glitchless`. That keeps a developer's phone and the agents' bot runs out of the players' numbers. Release exports send by default.

### The player's off switch

Give players a "Share performance data" toggle in the game's settings and wire it to `Glitchless.set_enabled()`. Turned off, Glitchless stops at once: nothing more is measured or sent, not even a check that the server is there, and what it hadn't sent yet is deleted, the outbox on the device included. The session just goes quiet: no `session_end` or `level_abandon` is sent, and the server doesn't count it as a crash. Turned back on, a new session starts in the same launch, as after a long time in the background, with the properties and groups the game had set.

```gdscript
# settings_menu.gd
@onready var share: CheckButton = %SharePerformanceData

func _ready() -> void:
	share.button_pressed = Settings.share_performance_data  # the game's own saved setting
	share.toggled.connect(_on_share_toggled)

func _on_share_toggled(on: bool) -> void:
	Settings.share_performance_data = on
	Settings.save()
	Glitchless.set_enabled(on)
```

- **The choice is kept on the device**, as `on` or `off` in `user://glitchless/enabled`, and the autoload reads it before the first frame of every launch. A player who turned it off sends nothing from the start of the next launch, even though the game reads its own settings after Glitchless starts, and a batch an earlier launch left in the outbox is deleted unread. The file is written only once the game calls `set_enabled`, in every privacy mode.
- **A call that changes nothing does nothing**, so the game can also pass its own saved setting each time it starts: `Glitchless.set_enabled(Settings.share_performance_data)`.
- **Show the game's own setting in the menu**, not `Glitchless.is_enabled()`. `is_enabled()` is true only while this build sends and the player hasn't turned it off, so it is false in a debug build without `--glitchless` whatever the player chose. `set_enabled(true)` never turns on a build that sends nothing; it still saves the choice.
- **Asking first.** `{"opt_in": true}` starts each device off until the game calls `set_enabled(true)`, for a game that asks the player before collecting anything, such as a prompt on first launch. A choice the player already made wins over it, and what was collected before `init()` is dropped when `opt_in` leaves it off. A dedicated server has no player to ask, so `opt_in` leaves it on.
- **While it is off**, every call is safe and does nothing. The F8 form doesn't open, `report_bug()` answers `{"sent": false, "reason": "off"}`, and `measure()` and `--glitchless-measure` return an `error` saying Glitchless is off. The level, properties, groups, zone and gauges stay in memory for the next session.
- **Back on**, the attempt that was going when the player turned it off (or one started while it was off) gets no `level_complete`, `level_fail` or `level_abandon` until the next `level_start`, since its start was never sent in the new session. The load isn't sent again.
- **The player ID stays** (install and full mode), so a player who turns it back on is still one player. `reset_install_id()` is the separate setting that forgets it.
- A dedicated server follows the same switch, saved in the same file.
- With the toggle, collection is optional for the store forms ([PRIVACY.md](PRIVACY.md#for-the-store-forms)).

### Bug reports

Players and playtesters flag a problem where they see it, and you (or your coding agent, with the `glitchless_bug_reports` MCP tool) see it in Glitchless's Bug Reports view with the screenshot and a link to the session's replay.

```gdscript
Glitchless.init("starlift", "", "prod", intake, {"bug_reports": true})   # F8 opens the form
Glitchless.init("starlift", "", "prod", intake, {"bug_reports": {"hotkey": KEY_F1, "pause": false}})
Glitchless.bug_report_opened.connect(_pause)          # bug_report_closed too; for games that pause themselves
Glitchless.open_bug_report()                          # a pause menu's "Report a bug" (works without bug_reports)
var result := await Glitchless.report_bug(note)       # the game's own form: {"sent": true}, or {"sent": false, "reason": "offline" | "off" | "error"}
```

| `bug_reports` key | default | |
| --- | --- | --- |
| `hotkey` | `KEY_F8` | a `Key`, its name (`"F1"`), or `null` for none. It opens and closes the form |
| `pause` | `true` | pause the tree while the form is open, so the game neither runs nor reads what the player types (nodes set to always process still do). The pause state the game had comes back on close. Use `false` and the signals if the game has its own pause |
| `screenshot` | `true` | send a screenshot with each report |

- **The screenshot** is the root viewport's last frame, read before the form shows, so the form is never in it. It is shrunk until it fits the server's 200,000-character limit: the longer side at most 960 px, then 800, 640, 480 and 320, at lower JPEG quality. The frames that read it back and draw the form aren't timed, so they never show as hitches. A headless run draws nothing, so its reports have no screenshot; `report_bug(note, image)` sends an `Image` you pass, and `report_bug(note, false)` none.
- **The form** is a `CanvasLayer` on layer 128 with the note box, Send and Cancel. Esc cancels, Ctrl+Enter (Cmd+Enter) sends, and a captured mouse is set free while it is open.
- **Sending:** a report goes on a request of its own straight away, from every session (`sample_rate` doesn't apply), with the last 20 game events and hitches, the last frame windows and the device. It waits in the outbox meanwhile, so a report made offline goes with a later batch, even on a later launch. A debug build without `--glitchless` sends nothing, and says so (`"offline"`). While the player has Glitchless [off](#the-players-off-switch), the form doesn't open and `report_bug()` takes no screenshot and answers `"off"`.
- **The note is the player's own words.** [PRIVACY.md](PRIVACY.md#bug-reports-the-players-own-words) says what to tell players, and the dashboard can delete a report a player asks about.

### Counters

`track()` sends one event per call, and the SDK queues at most 2,000 events. A stream (shots, hits, kills, loot, gold, taps) would fill that in a minute and push out the frame windows. Count a stream instead:

```gdscript
Glitchless.count("kill", {"monster": "elite"})
Glitchless.count("gold", {"source": "loot", "amount": 35})   # numbers are summed as passed
Glitchless.count("shot", "bow", 3)                            # one word is "what"; 3 events at once
```

Nothing is queued per call. Each window (every `flush_interval` seconds, and at each `level_start`, so counts keep their level) adds the calls up per name and per its words and booleans (up to 4), sums its numbers (up to 4), and sends one `counts` event. A window holds 64 entries: past that, a new group of a name already counted goes under `(other)`, and a new name is dropped and counted in `dropped`. Dashboards read a counter by its name like any event (`kill` per hour played, `gold` by `source`, summed by `amount`). A debug build warns once when a name is tracked more than 20 times a second. The rule: track a moment, count a stream.

### Properties

What holds for the session, in the game's words: its mode, the player's rank tier or class, the input they use, the region of the game's servers. Any panel can then split by one (`$rank`), and a dashboard page can show only some sessions.

```gdscript
Glitchless.init("arena", "", "prod", intake, {"properties": {"mode": "squads"}})
Glitchless.set_property("rank", "gold")               # after sign-in, at the menu, at matchmaking
Glitchless.set_properties({"class": "necromancer", "level_band": "30-39"})
Glitchless.set_property("party", null)                # null removes one
```

- Keys are 1 to 32 of `a-z`, `0-9` and `_`, starting with a letter, at most 12 a session. Values are a word (trimmed, up to 64 characters), a boolean or a whole number from −1,000,000 to 1,000,000. Fractions are dropped: send a band (`"30-39"`), not an exact level.
- The built-in splits can't be used as keys (`version`, `level`, `platform`, `zone`, the Steam facts…). Keys that name a person (`name`, `email`, `user_id`, `steam_id`, `age`…) and values shaped like an email, a link, a phone number, a long number or an ID are dropped, with a warning in a debug build. [PRIVACY.md](PRIVACY.md#properties-the-games-words-about-the-session) says why.
- They go in `session_start` when the first batch goes, and a later change as one `props` event a window with only the keys that changed. A call that changes nothing sends nothing. Nothing is kept on the device: each launch sets them again.
- What changes from match to match (hero, deck, map) belongs on the events or on `level_start`, not in a property.

### Matches, parties and runs

```gdscript
Glitchless.set_group("match", match_id, {"mode": "squads", "players": 100})  # the ID the game's server made
Glitchless.set_group("party", party_id)               # while the party lasts; never a guild or friends list
var run_id := Glitchless.set_group("run")             # Glitchless makes run IDs: save it with the run
Glitchless.set_group("run", saved_run_id)             # a run that goes on after a restart
Glitchless.set_group("match", null)                   # the match ended
```

Each sends a `group` event, and while it is set every event and window carries `"match": …` (or `party`, `run`), as it carries the level. So everyone in one match can be lined up: the whole lobby lagging at minute 12 is the server; one player lagging is their connection.

- IDs are 8 to 64 of `A-Z`, `a-z`, `0-9` and `_ . : -`. Anything else is dropped.
- **Match and party IDs go hashed:** `h_` and the first 24 hex characters of SHA-1 over the game's service (lowercased), `:` and the ID, as every Glitchless SDK sends them. Everyone in the match sends the same hash, a server and its clients included, whatever engine each runs, but it can't be looked up in the game's own match logs. `"hash_group_ids": false` sends them as they are, to match them against your own server's logs.
- **Runs:** in install and full mode a saved run ID resumes the run. In anonymous mode it gets a new ID (with `resumed: true`), so nothing ties two launches together.
- Groups set before `init()` go out once it is called.

### Level attributes and zones

`level_start(level, attrs)` describes the attempt: `{"tier": "pit_80", "party_size": 3}`, `{"heat": 4, "weapon": "rail"}`. The level funnel can then split clears by difficulty or group size. Attributes follow the rules of `track()`'s.

A **zone** is where the player is in an open world (an MMO region, a metroidvania room), apart from levels, with no start or end. `Glitchless.set_zone("ashen_wastes")` stamps every event and window with it, as the level is, and dashboards split by `$zone`. A window never spans two zones, unless the player crosses back and forth within a second. `set_zone(null)` clears it.

### Multiplayer: ping, packet loss and disconnects

Nothing to set up for a game on Godot's MultiplayerAPI. Once a second while connected, Glitchless reads the tree's `multiplayer.multiplayer_peer`:

| | ENet (`ENetMultiplayerPeer`) | WebSocket (`WebSocketMultiplayerPeer`, web exports) |
| --- | --- | --- |
| round trip | `get_peer(1).get_statistic(PEER_ROUND_TRIP_TIME)` | none: pass the game's own ping with `net_sample()` |
| jitter, packet loss | `PEER_ROUND_TRIP_TIME_VARIANCE`; `PEER_PACKET_LOSS` over `PACKET_LOSS_SCALE` | none |
| bytes in and out | the ENet host's `pop_statistic` (which resets its counters: a game that reads them itself gets what is left since the last second) | none |
| disconnects | `peer_disconnected(1)` then `server_disconnected` | the same, with the WebSocket's close code |

Each frame window while connected gains `net`: a 5% sketch of the round trips, their p50, p95 and maximum, jitter, loss, kbps in and out, the transport, and `host: true` on a listen server's host (whose own round trip is zero).

**Disconnects.** A `disconnect` event says why (`timeout`, `connection_lost`, `server_closed`, `failed_to_connect`, `kicked`, `other`), how long the player was connected, and the window's ping and loss. A server that closes the connection sends ENet's goodbye, which arrives with the drop; a connection that timed out brings nothing, so the two are told apart (a kick reads as `server_closed`: say `Glitchless.net_disconnect("kicked")` in your own `server_disconnected` handler and that wins). A player who closes the connection themselves (`multiplayer_peer.close()`) is leaving, not disconnected: Godot sends `server_disconnected` alone then, and Glitchless sends nothing. With a level open, the attempt ends as a `level_abandon` with reason `disconnect`, never a fail, and a fail or abandon the game sends for it afterwards is dropped. Connecting again within 5 minutes is a `reconnect` (`after_s`); a player back in the same level plays on in it. At most 20 disconnects a session.

**Other netcode** (Steam Networking Sockets, Nakama, a WebSocket game's own ping): `Glitchless.net_sample(rtt_ms, loss_pct, jitter_ms)` about once a second while connected, `Glitchless.net_disconnect(reason)` and `Glitchless.net_reconnect()`. (`disconnect` is taken: every Godot object has one, for signals.) `"network": false` turns the reading off.

### Dedicated servers

A Godot dedicated-server export (`OS.has_feature("dedicated_server")`), a run with `--server` or `--glitchless-server`, or `{"role": "server"}` reports as the game's server, under its companion service `<game>.server`, and never as a player's session. A headless server is a live session (`user`), not a bot's; `--autoplay` or `--glitchless-synthetic` marks a load test.

```gdscript
Glitchless.init("arena", "", "prod", intake, {"region": "eu-west", "max_players": 100})
Glitchless.level_start("island")                      # the map it hosts
Glitchless.set_group("match", match_id)               # the same ID its players set
Glitchless.set_players(n)                             # only for netcode other than the MultiplayerAPI
```

- Every 5 s a `server_window`: each physics tick's time (from Glitchless's first `_physics_process` to the next tick or the frame's `_process`, so the physics step is in it) against the budget, 1000 / `Engine.physics_ticks_per_second`, the ticks over it (`late`), the tick rate reached, the players connected (`multiplayer.get_peers()`) and their round trips, kbps in and out, and on Linux the process's memory and CPU (percent of one core). No frame windows, hitches, positions or bug reports.
- `session_start` says the tick rate, `max_players`, the build (`dedicated` or `headless`), `region` and the host's OS, cores and memory. Never its address or host name.
- Envelopes carry `role: "server"` and no player ID. A server session lasts as long as its process, cut every 6 hours (`session_end` reason `max_duration`), or one match with `"session_per_match": true` (reason `match_end`).
- A server sends nothing until the Glitchless server says it takes server sessions (`features` in `GET /v1/health`): to an older one it sends nothing at all and says so, so its sessions never land among players'. Unsent batches wait in `user://glitchless/server_outbox.json`, apart from a player build's.
- `--server` is the flag Godot's docs suggest for starting a game as its server. If your game's `--server` means something else, pass `{"role": "player"}`.

### Older servers

Glitchless asks the server what it takes when `init()` runs (`GET /v1/health`). A server that predates counters gets none (the game is told once, in the log), and one that predates server mode gets nothing from a dedicated server. Properties, groups, level attributes, zones and network fields go to any server: an older one keeps them in the stored events unread.

### Flags

These go after `--` on the command line, like the games' own debug flags.

| flag | |
| --- | --- |
| `--glitchless` | send from a debug build too |
| `--glitchless-intake=URL` | send to this server instead of the one in `init()`, and turn sending on |
| `--glitchless-measure=SECONDS` | print frame stats as one line of JSON, `{"glitchless_measure": {...}}`, then quit |
| `--glitchless-warmup=SECONDS` | with `--glitchless-measure`: wait this long before measuring |
| `--glitchless-out=PATH` | with `--glitchless-measure`: write the line to this file too |
| `--glitchless-synthetic` | mark the session as a bot's (`--autoplay` does too) |
| `--glitchless-server` | report as the game's [dedicated server](#dedicated-servers) (a bare `--server` does too) |
| `--glitchless-debug` | print what is sent |

## For agents: `--glitchless-measure`

```bash
godot --path . -- --autoplay --seed=7 --glitchless-measure=10 | grep '^{"glitchless_measure"'
```

It works in any build, sends nothing unless sending is on, and quits when done. On a device where the player turned Glitchless off it measures nothing, and the JSON holds only an `error` that says so. The fields match the browser SDK's `glitchless_measure`:

| field | |
| --- | --- |
| `frame_ms` | `p50`, `p95`, `p99`, `worst` |
| `fps`, `frame_budget_ms`, `refresh_hz`, `pct_frames_over_budget` | the budget is the refresh rate the game actually runs at (60/90/120 Hz, or its own cap), read from the fast frames (their 20th percentile); `refresh_hz` is the screen's rate as the OS reports it |
| `hitches`, `hitch_count` | up to 10 hitches: `ms`, `causes`, `ctx`, `recent` events |
| `render_cpu_ms`, `gpu_ms` | the renderer's time per frame; `gpu_ms` is null where the driver doesn't report it (Metal) |
| `process_ms` | all the game's `_process` code per frame |
| `draw_calls`, `triangles_avg` | |
| `peak_context` | the highest value of each gauge |
| `memory`, `memory_delta` | objects, nodes, orphan nodes, resources, video MB and static MB, now and change over the run |
| `new_errors`, `errors` | errors during the run, grouped, with locations |
| `level_start`, `level_end`, `headless` | under `--headless` nothing is drawn and frames run uncapped, so frame times mean little there |

Run the same seed before and after a change to compare.

## What it measures

**Frame times** are the wall-clock time between frames, read in `_process`. The `delta` Godot passes in is smoothed (`application/run/delta_smoothing` is on by default) and scaled by `Engine.time_scale`, either of which would hide a stutter. These rules follow `packages/sdk/src/core.js`:

- A **hitch** is a frame over 50 ms *and* over twice the median of the last 60.
- **Jank** is a frame over 33.4 ms.
- A **frozen** frame is over 700 ms.
- A run of long frames is the OS throttling a hidden window, so it is dropped.
- Time spent in the background is never counted as a frame.

**Hitch causes** come from what the slow frame measured:

| cause | when |
| --- | --- |
| `shader_compile` | the engine's pipeline-compile counters went up |
| `scene_change` | `current_scene` changed |
| `node_spawn` | 50 or more nodes were added |
| `script` | `_process` code took 40% of the frame. Glitchless runs first in each frame and has a child node that runs last, so the gap between them is every other node's `_process` |
| `physics` | physics steps took 40% of the frame |
| `render` | the renderer's CPU and GPU time took 40% of the frame |
| `gpu_or_os` | none of the above, and everything measured in the game (`_process`, physics, the renderer's CPU and GPU time) adds up to less than 40% of the frame: the time went to the GPU (Godot times it only on Vulkan and Direct3D 12, so on iPhones and the Compatibility renderer it lands here), to presenting the frame, or to the OS |
| `frozen` | over 700 ms |

**Engine counts** go in each frame window, and with `engine_gauges` they also go in `ctx`. The two say different things: the window's own `nodes`, `orphan_nodes` and `objects` are the counts when it closed, and `ctx` holds each gauge's highest value in the window. That is where the findings compare a slow level with the smoothest one: *"`orphan_nodes` sits at 2,500 for this whole level vs 0 on level_1, so objects created earlier are never cleaned up"*. Orphan nodes are nodes that were taken out of the tree and never freed, the commonest Godot leak.

A frame window never spans two levels: `level_start` closes the current one.

## Errors

A custom `Logger` (Godot 4.5+) hears every engine and script error, on any thread. Glitchless groups them with the browser SDK's fingerprint, made from the kind, the message with long numbers blanked, and the function. Each error event also carries the last six game events (`recent`). The server adds breadcrumbs from the session's stored events.

| kind | what |
| --- | --- |
| `script` | a GDScript runtime error, which stops the function part way. Counted as unhandled, like an uncaught JS exception |
| `engine` | an error from the engine's own code, usually a bad call from a script (a missing node, a failed load). The engine's C++ location is the first stack line, the script lines follow |
| `push_error` | the game's own `push_error()` |
| `shader` | a shader compile error |
| `manual` | `Glitchless.error()` |
| `warning` | only with `capture_warnings` |

Paths on the device are cut out of messages before they're sent: the user-data folder becomes `user://`, the user-name part of `/Users/…` or `C:\Users\…` becomes `~`, and iOS container IDs become `<id>`. Errors raised inside the addon are never reported, so a failing send can't feed itself. Each kind of error is sent at most 25 times per session.

**Release builds catch fewer errors than debug builds.** Godot leaves most GDScript runtime checks out of release exports. This was measured with a macOS release export of Godot 4.7.2, with *Always Track Call Stacks* on:

| in the game's code | debug build | release export |
| --- | --- | --- |
| `get_node()` on a missing path, `load()` of a missing file, a null argument to an engine call | `engine`, with script line | `engine`, with script line |
| `push_error()` | `push_error` | `push_error` |
| index out of range, missing dictionary key, missing method, call on an untyped null, divide by zero | `script` | **nothing**: the code carries on |
| call on a *typed* null (`var n: Node = null; n.free()`) | `script` | **the game crashes** (SIGSEGV) |

So run the bots (`--autoplay --seed`) in debug builds with `--glitchless` to catch script mistakes, and let release builds report engine errors, `push_error` and performance. Native crashes are left to the platform: Xcode Organizer and App Store Connect on iOS, Android vitals in the Play Console. Glitchless sees a crash only as a session that stops without a `session_end`.

## Phones: background, close, offline

- **Going to the background ends the session.** iOS and Android usually stop a backgrounded app without warning, so on `NOTIFICATION_APPLICATION_PAUSED` Glitchless sends `session_end` (`reason: "background"`) at once. It waits up to 1.5 s on the network, then saves whatever didn't go.
- **Coming back** within `session_timeout` carries on the same session with an `app_resume` event. A later `session_end` then replaces the first. Coming back later than that starts a new session with a new random ID.
- **Closing** (the window's close button, Android's back button, or `get_tree().quit()`) sends `session_end` the same way.
- **Offline**, batches are saved to `user://glitchless/outbox.json` and sent on a later launch. At most 4,000 events are kept, and anything over six days old is dropped. In anonymous mode the session ID is not saved: each earlier session's batches go out under a new random ID. Each batch keeps its own `batch_id` through every retry and launch, so the server stores it once even when an answer was lost on the way back.

## What goes on the wire

`POST {intake}/v1/intake?token=…` with the browser SDK's envelope and `sdk: "glitchless-godot/0.6.0"`. Event types and core fields are the same; see [docs/SPEC.md](../../../docs/SPEC.md#5-godot-sdk) for what the Godot SDK adds. The browser fields it can't fill (`geometries`, `textures`, `programs`, `page`, `loaf`) are sent as null or empty.

## Limits

- **Godot 4.5 or later.** The `Logger` class came in 4.5.
- **The server:**
  - GDScript runtime errors count as unhandled because `server/src/analytics.js` treats kind `script` like `js`.
  - Deaths sent without a place, as anonymous mode sends them, are left off heatmaps and hotspot findings.
  - The memory-leak finding still reads three.js geometry counts. Godot leaks show through the `orphan_nodes` and `nodes` gauges instead.
  - Fix suggestions in findings are written for three.js.
- **Web exports** are untested. A web game is better served by the browser SDK. WebSocket disconnects and their close codes were checked in desktop builds, not in a browser.
- **Network:** Godot can't tell Wi-Fi from mobile data, so `net.link` is null. Only ENet gives a round trip; WebRTC and WebSocket need `net_sample()`.
- **Dedicated servers:** a server's memory and CPU come from `/proc/self` on Linux; elsewhere memory is the engine's static memory (debug builds only) and CPU is null. `net_objects` is null: Godot doesn't count replicated objects.
- Sending uses `HTTPRequest` while the game runs and a blocking `HTTPClient` for the last batch, which has no frames left to finish an `HTTPRequest`. A batch the server received just before a close can arrive twice.

## Tests

From the repo root:

- `npm run test:godot` runs the demo game (`godot/demo`) headless against a fresh local server and checks everything above through `/v1/query`. It covers offline saving, anonymous and full mode, errors, background and resume, `--glitchless-measure`, and bug reports: one from code, one typed into the F8 form (key presses pushed into the viewport) and one sent offline. It first runs `test/bug_report_test.gd`, which checks the screenshot shrinking, the slimmed events and the hotkey names, `test/genre_test.gd` (counters, properties and their checks, groups and hashed IDs, level attributes and zones, network samples and disconnects, server windows) and `test/off_switch_test.gd` (the player's off switch). Then it plays `test/net/net_game.tscn` as an ENet server (`--server`) and a client against a fake intake: the server is frozen so the client times out, kicks it, and the client leaves, so every payload of the additions is checked, and once more against an intake that lists no features, as an older server does. Last, it plays the demo with the off switch (`--off-at`, `--on-at`, `--opt-in`) against a fake intake that keeps every request: off and back on mid-run, off while offline, a launch with the choice saved as off, `opt_in`, and a debug build.
- `npm test` includes `server/test/godot.test.js`. It checks that the GDScript sketch buckets every frame time like the JavaScript one, and that the server merges the two.
