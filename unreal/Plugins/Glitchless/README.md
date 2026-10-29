# Glitchless for Unreal

Game observability for Unreal Engine 5.8 (and 5.7). Glitchless records how your game runs for real players and gives your coding agent the same data, over MCP, so it can fix what they hit.

- **Stutter.** Every frame is timed, and each 5-second frame window carries a mergeable frame-time sketch and where the time went: the game thread, the render and RHI threads, the GPU. Each hitch (a frame over 50 ms and twice the recent median) comes with the thread that held it up and its likely causes: pipeline states compiled on the spot, shaders compiled (in the editor), garbage collection, a map load, a streamed level, assets loaded, long game, render or frozen frames, or time spent where nothing measures it (presenting the frame, the OS).
- **Errors and crashes.** `UE_LOG` errors, ensures with their callstacks, Blueprint runtime errors (Accessed None and the rest), and crashes, written to disk as the game dies and sent on the next launch. Grouped by the same fingerprint every Glitchless SDK uses, with the game events just before each one.
- **Bug reports.** A screenshot and the player's note, from one call or a key that opens a small box over the game.
- **Levels and players.** Maps are levels on their own. Deaths, level fails, levels left before they ended and quits feed the level funnel, death heatmaps and rage-quit detection.
- **Your game's own terms.** Outcomes as flags (`won`), decks and builds as lists, streams of events counted on the device, what holds for the session (mode, rank tier, class), matches, parties and runs, and zones in an open world.
- **Multiplayer.** Unreal's own replication is read by itself: each client's ping, packet loss and jitter, and its disconnects. A dedicated server reports as your game's server, with its tick time, players and crashes; a listen server as both.
- **Leaks.** UObject and actor counts and memory per level load.
- **Anonymous by default.** No player ID, no device identifier, coarse device facts only. [PRIVACY.md](PRIVACY.md) lists every field in each of the three modes.
- **The player's off switch.** One call for a "Share performance data" toggle in the game's settings: off sends nothing more, from that moment and in every later launch, until the player turns it back on.

It sends the same events as the browser, Unity and Godot SDKs, so the dashboard, the findings and the MCP tools work with an Unreal game as they are.

## Install

From Fab: install it to your engine, then enable Glitchless in **Edit → Plugins** (it is under Analytics). Fab installs it into the engine already built, so a Blueprint-only project can use it as it is.

From GitHub: download `glitchless-unreal-0.5.1.zip` from the [glitchless-unreal 0.5.1 release](https://github.com/glitchless-gg/glitchless/releases/tag/glitchless-unreal/v0.5.1) and unzip it to your project's `Plugins/Glitchless` (or copy this folder there), or add it to a project's `AdditionalPluginDirectories`. Enable it in **Edit → Plugins** and rebuild. A Blueprint-only project needs to become a C++ project once (**Tools → New C++ Class**), because the plugin is source.

## Set it up

No code: **Project Settings → Plugins → Glitchless**, fill in **Service** (your game's id, lowercase), **Intake** (`http://localhost:7777` for a local server, or `https://api.glitchless.gg`) and **Client Token**. The game instance starts Glitchless with them. They are saved in `Config/DefaultGame.ini`:

```ini
[/Script/Glitchless.GlitchlessSettings]
Service=my-game
Intake=http://localhost:7777
ClientToken=gl_pub_dev
Privacy=Anonymous
bSendInDevelopmentBuilds=True
```

Or from C++, as early as you can (your `UGameInstance::Init`), leaving Service empty in the settings:

```cpp
#include "Glitchless.h"

FGlitchless::Init(TEXT("my-game"), TEXT("https://api.glitchless.gg"), TEXT("gl_pub_..."));
```

A packaged game starts capturing when the plugin loads, so frame times and errors from the first frames are kept; nothing is sent until Init. In the editor it runs only during Play In Editor. Play In Editor and development builds send too, as env `dev`; shipping builds send as `prod`. Turn **Send In Development Builds** off to keep your own play out; `-glitchless` turns it back on for one run.

## Tell it about your game

| Game moment | C++ | Blueprint |
| --- | --- | --- |
| A level starts (turns automatic map levels off) | `FGlitchless::LevelStart(TEXT("forest-2"))` | Level Start |
| Level beaten | `FGlitchless::LevelComplete(TEXT(""), Score)` | Level Complete (Score below 0: none) |
| Level lost: died, ran out of time | `FGlitchless::LevelFail(TEXT(""), TEXT("timeout"))` | Level Fail |
| Level left before it ended: the menu, a restart | `FGlitchless::LevelAbandon()` | Level Abandon |
| The player died | `FGlitchless::Death(GetActorLocation(), TEXT("fell"))` | Death |
| Anything worth counting | `FGlitchless::Track(TEXT("powerup"), TEXT("magnet"))`, or a `TMap` of attributes and one of numbers | Track Event, Track Event (What) |
| A purchase (the convention in every SDK) | `FGlitchless::Track(TEXT("purchase"), {{TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}}, {{TEXT("amount"), 4.99}})` | Track Event, with `amount` in Numbers |
| What is on screen | `FGlitchless::SetContext(TEXT("enemies"), Enemies.Num())` | Set Context |
| Where the player is | `FGlitchless::SetPosition(GetActorLocation())` (sent in full mode or with Positions) | Set Position |
| A problem the game noticed | `FGlitchless::Error(TEXT("save failed"))` | Report Error |
| An outcome, a deck, a build | `FGlitchless::Track(TEXT("battle_end"), FGlitchlessAttributes().Add(TEXT("won"), true).Add(TEXT("deck"), Deck))` | Track Event (Attributes), with the Glitchless Attributes struct or the Add Word, Add Number, Add Flag and Add List nodes |
| Shots, kills, gold: many a second | `FGlitchless::Count(TEXT("kill"), FGlitchlessAttributes().Add(TEXT("monster"), TEXT("elite")))` | Count Event |
| What the attempt is (difficulty, party size) | `FGlitchless::LevelStart(TEXT("nmd_ghoa"), FGlitchlessAttributes().Add(TEXT("tier"), TEXT("pit_80")))` | Level Start's Attributes pin |
| What holds for the session (mode, rank tier, class) | `FGlitchless::SetProperty(TEXT("rank"), TEXT("gold"))`, `ClearProperty`; `Properties` in `FGlitchlessOptions` from the start | Set Glitchless Property (and Number, Flag), Clear Glitchless Property |
| A match or party from your server; a run | `FGlitchless::SetGroup(EGlitchlessGroup::Match, MatchId)`, `ClearGroup(...)`; `SetGroup(EGlitchlessGroup::Run)` makes a run ID | Set Group, Clear Group |
| Where the player is in an open world | `FGlitchless::SetZone(TEXT("westfall"))` (empty leaves it) | Set Zone |
| The player reports a bug | `FGlitchless::ReportBug(Note)` or `FGlitchless::ShowBugReportDialog()`; `FGlitchless::OnBugReportDialog()` says when the box opens and closes | Report Bug, Show Bug Report Dialog; the Glitchless subsystem's On Bug Report Dialog |
| Send now | `FGlitchless::Flush()` | Flush |
| The player's "Share performance data" setting | `FGlitchless::SetEnabled(bShare)`; `FGlitchless::IsEnabled()` | Set Enabled, Is Enabled |

**Leaving a level is not losing it.** Call `LevelAbandon` when the player leaves a level before it ends (goes to the menu, restarts it), not `LevelFail`: the funnel counts abandons apart, they are never rage quits, and walls are judged only on the sessions that played a level to an end. When the game goes to the background on a phone or quits with a level started and not yet completed, failed or abandoned (a map level too), Glitchless sends the abandon itself, before the session's end, with the end's reason (`background`, `quit`, or `measure` for `-glitchless-measure`), and drops a `LevelFail` or `LevelAbandon` the game sends for that level after it. Unreal ends play (`EndPlay`) before the game instance shuts down, so a level the game ends in `EndPlay` as it quits keeps the game's own outcome. Back from the background in the same session, the level carries on and the server takes the abandon back. A crash sends no abandon: the session ends with `reason: crash`.

Bug reports are off until the game turns them on: set **Bug Report Key** (F8, as in the other SDKs) in the settings, or call Show Bug Report Dialog from the game's own menu. The box takes the game's input while it is open (the mouse is freed) and pauses the game (**Pause For Bug Report**, on by default; a game paused already stays paused).

A purchase is sent when the store confirms it: `amount` goes in the numbers (a number in the currency's units, 4.99, not 499) and `currency` is the ISO code the store charged in. Boards add the amounts up into revenue, revenue per player and revenue by item, in the game's one currency: purchases in another are listed as left out, not added in. Never send receipts, order ids or payment details. A purchase made in a TestFlight or development install on iOS is a free sandbox purchase: the SDK adds `sandbox: true` to it (to an event named `purchase`, or any with a `currency`), and boards count it but never add it into revenue. On Android, pass `sandbox: true` yourself when the billing library says the purchase was a test one (RevenueCat's `isSandbox`).

Every call is safe before Init and from any thread. Positions are taken in Unreal units (centimetres, Z up) and sent as every SDK sends them, metres with y up: x = X/100, y = Z/100, z = Y/100.

Maps are levels except those that read as a menu, lobby, loader, overlay or end screen (`Entry`, `MainMenu`, `L_Frontend`, `Lobby`, `Loading`, `GameOver`, ...). The first `LevelStart` call turns that off: the game's own levels win.

**Track a moment, count a stream.** A `Track` per shot or coin fills the 2,000-event queue in a minute and pushes frame windows out of it; a development build warns once when a name is tracked more than 20 times a second. `Count` adds up on the device instead: each name with its words and flags (4 at most) is one entry a 5-second window, its numbers (4 at most) are summed, and the window goes as one `counts` event. A window counts 64 entries; past that a known name goes under `(other)` and a new one is dropped, counted in `dropped`. Counts go only to a server that says it takes them (`GET /v1/health` lists `counts`); an older one gets none, and the log says so once.

**Properties** are what holds for a session, in the game's words: the mode, a rank tier, the class, the server region, a level band. Boards split any number by them (`$rank`). Keys are lowercase words of at most 32 characters, 12 a session; values a word (up to 64 characters), a whole number from -1,000,000 to 1,000,000, or a flag. A key that names a person (`email`, `user_id`, `steam_id`, `name`, `age`...) or a built-in split (`level`, `platform`, `zone`...), and a value that looks like an email address, a link, a phone number, 7 or more digits, a UUID or a long hex or base64 string, are dropped, with one warning in a development build. The first batch's `session_start` carries them; later changes go as one `props` event a window.

**Groups.** `SetGroup(EGlitchlessGroup::Match, Id)` marks every event and frame window with the match until `ClearGroup`, so one match can be read from every side: call it on the server and on each client with the ID your server made. Match and party IDs are sent hashed (`h_` and 24 hex digits of SHA-1 of the service and the ID, the same in every Glitchless SDK), so they can't be looked up as they are; **Hash Group Ids** off sends them as they are, to match them against your server's logs. A run's ID is the plugin's (`r_` and 12 characters): keep the one `SetGroup(EGlitchlessGroup::Run)` returns to resume the run after a restart. In anonymous mode a resumed run gets a new ID, so nothing ties two launches together. A group change, like a level start or a zone change, closes the frame window, so a window never spans two matches.

## The player's off switch

Give players a **Share performance data** toggle in the game's settings and pass it to Glitchless. When it changes, and again as the game starts with the setting the game saved:

```cpp
#include "Glitchless.h"

// UMySettingsWidget::OnShareDataChanged, and UMyGameInstance::Init with the saved value
FGlitchless::SetEnabled(bSharePerformanceData);
```

In Blueprint: a Check Box's **On Check State Changed** → **Set Enabled**, with **Is Checked** into **On**. Show the toggle from the game's own saved setting (its SaveGame or Game User Settings) rather than from **Is Enabled**: a build that sends nothing (a development build without `-glitchless`, say) says false there whatever the player chose.

- **Off** saves the choice, then stops at once. Nothing more is measured or sent: no frames, hitches, errors, ensures, events, counts, positions or network samples, and no request of any kind. What was waiting is dropped, `Saved/Glitchless/outbox.json` and the bug reports in it included (and a listen server's `Saved/Glitchless/Server/outbox.json`). The session ends without a `session_end` and a level going ends without a `level_abandon`: the server sees the session go quiet, as when a game is killed, and doesn't count it as a crash. The bug report box doesn't open, Report Bug sends nothing, and `-glitchless-measure` answers that Glitchless is off. The level, properties, groups, zone and gauges stay in memory, unsent, and the install ID stays on the device, so a player who turns it back on is still one player.
- **On** starts a new session in the same launch, as after a long time in the background: a new session ID, its own `session_start` with the properties still set, a `group` event for each group still set, and frames from the next one. The level stays the current one, but the attempt going when the player turned Glitchless off isn't open in the new session: until the next Level Start, a Level Complete, Level Fail or Level Abandon for that level is dropped, so no outcome arrives without its start.
- **The same value again** does nothing, so passing the saved setting at every start is safe.

The choice is saved in `Saved/Glitchless/enabled` (`on` or `off`, in every privacy mode, once the game has called Set Enabled) and read as the plugin starts, before Project Settings start it. A player who turned Glitchless off sends nothing at all from the first frame of every later launch: an outbox an earlier launch left is deleted unread, and a crash isn't written. A listen server's own session follows the player's switch; a dedicated server keeps its own, in `Saved/Glitchless/Server/enabled`. In the editor the file is in the project's `Saved` folder, so a toggle tried in Play In Editor holds for later runs: delete `Saved/Glitchless/enabled` to start again from no choice.

**Asking first.** For a game that asks the player before collecting anything, turn on **Opt In** in **Project Settings → Plugins → Glitchless** (`bOptIn=True`, or `FGlitchlessOptions::bOptIn` when the game calls Init): on a device where the player hasn't chosen yet, Glitchless starts off (nothing measured, kept or sent) until the game calls Set Enabled (true). Without it, Glitchless is on until the player turns it off. A saved choice wins over both. A dedicated server has no player to ask, so it starts on.

The build's own switches still decide whether a build sends at all: **Enabled** off in the settings, `Enabled = false` in the options, no intake, `-glitchless-off`, or a development build with **Send In Development Builds** off. Set Enabled (true) can't turn those on (it still saves the player's choice). **Is Enabled** (`FGlitchless::IsEnabled()`) is true while Glitchless is on: the build sends and the player hasn't turned it off. What was sent before the player turned it off stays on the server for the game's retention; a player who wants it deleted asks you.

## Steam

If the game already uses Steamworks through Unreal's **Online Subsystem Steam** (or the **SteamShared** plugin it builds on), every session also says which Steam build and beta branch it ran, whether on a Steam Deck, in Big Picture mode, with which kind of controller, in which Steam language, and whether through Family Sharing or a timed trial. Nothing to set up and no dependency: the plugin links nothing of Steam's. Only while one of those modules is loaded, it looks up Steam's flat C API in the `steam_api` library that module loaded (never loading it itself), and reads nothing until Steamworks is initialised. The facts are read when the first batch goes, so a subsystem that starts after Glitchless still counts. Unreal 5.8 ships Steamworks SDK 1.64: it tells a Steam Deck but not a Steam Machine or Steam Frame, and has no Proton call; a game built with SDK 1.65 or later sends those too. The controller is known once the game has started Steam Input. Windows, Linux and Mac. No Steam ID or name is ever read ([PRIVACY.md](PRIVACY.md#steam-facts) has a paragraph for your privacy page).

**Versions are Steam builds.** Leave the version empty and a Steam build reports `steam-<build>` (`steam-18231`), so every upload to Steam is a version the Versions page and `glitchless_compare_versions` can compare. Outside Steam it falls back to the project's version (**Project Settings → Description → Project Version**). A version you set always wins.

**Branches.** Filter any dashboard query with `steam_branch=beta`, split a breakdown panel by `$steam_branch`, or compare branches with a versions panel `by: "$steam_branch"` or `glitchless_compare_versions` with `by: "steam_branch"`.

## Multiplayer

Unreal's own replication, with listen and dedicated servers, is read with no setup:

- **A client.** Once a second, from its connection to the server (`UNetConnection`): the round trip (`AvgLag`, or the player state's ping), packet loss (the worse of in and out), jitter and traffic. Each frame window while connected carries them as `net`, with the kind of connection (`wifi`, `cellular`, `wired`) where the device says. A connection that fails (Unreal's `OnNetworkFailure`: a timeout, the connection lost, the server closing it, a kick, or a join that never connected) sends a `disconnect` with the last numbers, and abandons the level that was open, never a fail; coming back to the same level takes the abandon back. Leaving a match the normal way is no disconnect.
- **A dedicated server** starts Glitchless as a server: its own session, sent with `role: "server"` and filed under your game's companion service, `<service>.server`, so no player number counts it. In place of frame windows it sends server windows every 5 s: its tick time (each tick's work, without the sleep that holds it to `NetServerMaxTickRate`), the ticks late for that rate, players connected and their pings as the server sees them, replicated objects, traffic, CPU and memory. Its crashes are written to `Saved/Glitchless/Server/outbox.json` and sent when it starts again. A session lasts as long as the server, cut every 6 hours; **Server Session Per Match** makes it one session per match for a server that hosts one at a time (it ends at `ClearGroup(Match)`). Set **Server Region** (or `-glitchless-region=eu-west` on the command line) to split ping and ticks by region. A server sends nothing at all to a Glitchless server that doesn't say it takes servers (`server_mode` in `GET /v1/health`), so its sessions never land among players'.
- **A listen server** is a player whose frame windows say `net.host: true` (its own round trip is zero), and, while it hosts, a server too: a second session in the server role with the players and their pings, the map and the match.

A game on another library (Steam Networking Sockets, Epic Online Services, its own) calls `FGlitchless::NetSample(RttMs, LossPct, JitterMs)` once a second while connected and `FGlitchless::Disconnect(TEXT("timeout"))` when the connection fails (Report Net Sample and Report Disconnect in Blueprint). Nothing about the connection identifies anyone: no address, host name or network name is read.

## When it sends

Batches go every 15 seconds (the first after 2), gzipped when large. Init asks the server what it takes (`GET /v1/health`): counts wait for its answer, and a server's session waits for `server_mode`. Quitting, or going to the background on a phone, sends what is waiting and waits up to 1.5 s on the network. What doesn't go is kept in `Saved/Glitchless/outbox.json` and sent on a later launch: at most 4,000 events, none over six days old, and in anonymous mode without the session ID (each earlier session's batches go under a new random ID). Each batch has its own `batch_id`, sent again with every retry and saved with it in every mode, so the server stores a batch once even when its answer was lost on the way back (a send that timed out, one given up on as the game went to the background or quit, one saved as it crashed). A batch leaves the outbox file as soon as the server takes it.

## Crashes

A crash is written to `Saved/Glitchless/outbox.json` (on a phone, in the app's own data folder) as the game dies and sent on the next launch, with the frames before it and the session's end (`reason: crash`). Where it is caught: Unreal's `OnHandleSystemError` (the editor, builds that ship CrashReportClient, and every Windows build: Unreal raises it there before it has read the exception, so the plugin keeps each possibly fatal exception as it happens, with a vectored exception handler that does nothing else, and walks the crashed thread's stack from it); the `appError called` line every platform's error device logs as an assert or `UE_LOG` Fatal takes the game down; and, in a packaged Mac, Linux, iOS or Android game where nothing else handles them (Unreal installs no signal handlers there without CrashReportClient), the plugin's own handlers for SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT and SIGTRAP, which then pass the signal on so the OS still writes its report. Which file and line a stack frame names depends on the platform: a Windows build resolves them from the PDB beside the game (for the game's and the plugin's code; an engine installed from the Launcher has no line numbers of its own unless its debug symbols are installed), and a Linux build should from its `.sym` files (not tried yet). A packaged Mac or iOS game has function names only. Unreal names its frames with `dladdr` there, and turns on the system symbolicator only for tools outside the App Sandbox (`MacPlatformMisc.cpp`), so a dSYM beside the game doesn't help. Keep the dSYM anyway (`-EnableDSYM` when building) to read a crash's lines with `atos` or lldb.

## Measure from the command line

Agents and CI can ask a build how it runs:

```bash
MyGame -glitchless-warmup=2 -glitchless-measure=10 -glitchless-out=measure.json
```

It waits for the first map plus the warmup, measures for the given seconds, prints `{"glitchless_measure": {...}}` as one line on stdout (and in the log as LogGlitchless), writes it to `-glitchless-out`, and quits. The numbers are the browser SDK's `glitchless_measure` (frame_ms percentiles, fps, pct_frames_over_budget, update_cpu_ms for the game thread, render_cpu_ms, rhi_cpu_ms, gpu_ms, hitches with causes, draw calls, memory and its change, new errors) plus `session_id`. A Windows build opens no console, but its stdout can be piped or redirected, and `-glitchless-out` works too. UE 5.8 signs Mac builds with App Sandbox: such a build can write `-glitchless-out` only inside its container (`~/Library/Containers/<bundle id>/Data`, whose `tmp` is a good place), and its Saved folder is in there too; stdout works anywhere.

| Flag (`-` or `--`) | |
| --- | --- |
| `-glitchless` | send from a development build when Send In Development Builds is off |
| `-glitchless-intake=URL` | send to this server instead |
| `-glitchless-measure=S` | print frame stats as JSON after S seconds, then quit |
| `-glitchless-warmup=S` | with measure: wait this long after the first map first |
| `-glitchless-out=PATH` | with measure: write the JSON here too |
| `-glitchless-synthetic`, `-autoplay` | mark the session as a bot's (measure does too) |
| `-glitchless-off` | send nothing, whatever the player chose |
| `-glitchless-region=NAME` | a dedicated server's region, in your own words |
| `-glitchless-debug` | log each batch as it is sent |

On a phone, launch it from a Mac with the flags after the bundle ID, and the line comes back on the console: `xcrun devicectl device process launch --console --device <phone> <bundle id> -glitchless-measure=10`.

Testers are not players either. A TestFlight build is a Shipping build like the App Store's and reports `prod`, so on iOS the plugin tells them apart by the receipt Apple writes with every App Store install (and the provisioning profile a development build carries): a TestFlight or development install's session is `tester`, which findings and share links leave out, unless the game sets a session type or a flag above makes it a bot's.

## Builds that can't reach the network

- **Shipping Mac builds** are signed with `Sandbox.NoNet.entitlements` by default (Project Settings → Platforms → Xcode Projects → Shipping Specific Mac Entitlements): no network at all, so Glitchless can't send. Set it to `/Game/Build/Mac/Resources/Sandbox.Client.entitlements` (copied from `Engine/Build/Mac/Resources`), or `Sandbox.Server`, which Development builds already use.
- **iOS** allows only HTTPS. Send to `https://api.glitchless.gg` (or your HTTPS server). For a plain-HTTP server on your network, in a development build:
  - tick Allow web connections to non-HTTPS websites (`bDisableHTTPS=True` under `[/Script/IOSRuntimeSettings.IOSRuntimeSettings]`);
  - send to the computer's address on the network, not `localhost`, with the phone on the same network;
  - say why the game wants the local network, in Additional Plist Data: `<key>NSLocalNetworkUsageDescription</key><string>…</string>`. iOS asks the player once, at the first send, and nothing gets through until they allow it. The test game's `Config/DefaultEngine.ini` does all three.

## Agents in the editor: Unreal MCP

Unreal 5.8 ships Unreal MCP (Experimental), an MCP server inside the editor. The optional **Glitchless Toolset** plugin (`unreal/Plugins/GlitchlessToolset`, beside this one) gives it two tools, so an agent can measure the game itself while it plays in the editor, as WebMCP's `glitchless_measure` lets it in a browser game:

| tool | |
| --- | --- |
| `Status` | what Glitchless sees now: whether and where it sends, the level, its stats, the last frame windows and hitches with their causes, the gauges, memory, this session's errors |
| `Measure(Seconds)` | frame stats over the next seconds, the same JSON as `-glitchless-measure` |

Enable **Unreal MCP**, **All Toolsets** (or just Toolset Registry) and **Glitchless Toolset** in **Edit → Plugins**, start the server (`ModelContextProtocol.StartServer`, or Editor Preferences → Model Context Protocol → Auto Start Server), run `ModelContextProtocol.GenerateClientConfig ClaudeCode` (or Cursor, Codex, ...) for the project's `.mcp.json`, then start Play In Editor before calling the tools. It is a plugin of its own because Unreal MCP is Experimental and isn't in 5.7; the Glitchless plugin doesn't need it.

## For the Glitchless server and docs (SPEC §5c)

The envelope's `sdk` is `glitchless-unreal/0.5.1`. Differences from the browser SDK on the wire:

| | |
| --- | --- |
| off switch | `FGlitchless::SetEnabled(bool)`, `FGlitchless::IsEnabled()`, Blueprint Set Enabled and Is Enabled, `FGlitchlessOptions::bOptIn` and the project setting Opt In (§4d). Saved in `Saved/Glitchless/enabled` (a dedicated server's in `Saved/Glitchless/Server/enabled`) and read as the plugin starts; a listen server's own session follows the player's. Off drops the queue, the open window, hitches waiting, held counts and both outboxes, and ends the session without `session_end` or `level_abandon`; on starts a new session (`session_start` with the properties, a `group` event for each group, no `load`), and drops an outcome for the level that was going until the next `level_start`. Opt In doesn't apply to a dedicated server |
| envelope | `player_id` is null in anonymous mode. Install mode (new: a stored random player ID with coarse device facts) and full mode send one. `batch_id` (§2) on every batch, a bug report's own too, made when the batch is cut, sent again with every retry and saved with the batch in the outbox in every mode (in anonymous mode without the session ID); a batch saved by an older build gets one when it is loaded |
| `session_start` | `privacy` is `anonymous`, `install` or `full`. `device`: `browser: "Unreal"`, `browser_version` (`5.8.4`), `os` (`Windows`, `macOS`, `Linux`, `SteamOS`, `iOS`, `Android`), `mobile`, `device_tier`, `gpu_tier` (`low` on a Steam Deck), `renderer` (`deferred`, `forward`, `mobile`, `null`), `driver` (`D3D12`, `Metal`, `Vulkan`), `screen`, `dpr` (null), `refresh_hz` (phones only: the panel's highest rate as the OS reports it, `FPlatformMisc::GetMaxRefreshRate`, not the rate the game runs at, which is `frame_window.hz`), `steam_deck`; full mode adds `model` (`Steam Deck OLED` on one), `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. With Steamworks, the Steam facts (SPEC §4c). `page` and `nav_ms` are null |
| `frame_window` | frame times from the clock at the start of each frame. Adds `game_ms` (game thread without its waits, GGameThreadTime), `process_ms` (the same, under the name the playtest gate reads), `render_ms` (render thread), `rhi_ms` (RHI thread, null without one), `gpu_ms`, `draw_calls` and `triangles` where the RHI counts them (it does only while its GPU profiler collects draw stats, so they are usually null in a packaged 5.8 build), `gc_collections`, `gc_ms`, `pso_compiles` (runtime PSO creations over 20 ms, UE 5.8), `shader_compiles` (editor only), `packages_loaded` (UE 5.8), `objects` (UObjects), `actors`, `heap_mb` (the process's memory), `texture_mb`, `screen`, `window`; `geometries`, `textures`, `programs` are null; `ctx` also holds `objects` and `actors`. A window never spans two levels. `hz` and `budget_ms` are the rate measured from the session's frames (the nearest of 30, 60, 75, 90, 100, 120, 144, 165 and 240 Hz): from the fastest fifth of the first 30 frames under 100 ms, then the median of the first 120; 60 Hz before that. Thread and GPU times are averages over the window's frames, `draw_calls` and `triangles` averages (`draw_calls_max` the most), and `gc_collections`, `gc_ms`, `pso_compiles`, `shader_compiles`, `packages_loaded` totals. Each `ctx` gauge is the highest value it was set to in the window (gauges not set in it are left out); `objects`, `actors`, `heap_mb` and `texture_mb` are the last sample (taken every 30 frames and as the window closes, except when a level start closes it, so the new level's load stays out) |
| `hitch` | `duration_ms` is the frame's time on the clock, as Unreal's own hitch tracking times it (Unreal leaves waits out of its thread times, so a frame spent waiting on a pipeline state, the GPU or the disk would look short by them); `bound` names the slowest of the game, render and RHI threads and the GPU. `causes` from `pso_compile`, `shader_compile`, `gc`, `map_load`, `level_stream`, `asset_load`, `script` (game thread at 40% of the frame), `render` (render, RHI or GPU at 40%), `frozen` (over 700 ms), and `gpu_or_os` when none of those apply and the measured parts (game, render and RHI threads, GPU when the RHI times it) add up to under 40% of the frame (at least 16 ms): the time went where Unreal doesn't measure it, such as presenting the frame or the OS. Adds `bound` (`game`, `render`, `rhi`, `gpu`, or null when no thread was measured), `game_ms`, `process_ms`, `render_ms`, `rhi_ms`, `gpu_ms`, `draw_calls` and `triangles` where the RHI counts them (it does only while its GPU profiler collects draw stats, so they are usually null in a packaged 5.8 build), `gc_collections`, `gc_ms`, `pso_compiles`, `shader_compiles`, `packages_loaded`; `loaf` is empty |
| `load` | `ts` is the wall-clock time of the first frame (the event goes with the first batch after it); `ttff_ms` counts from the engine's start (`GStartTime`, set as the process starts) to the end of the first frame the plugin times; `ttp_ms` (a second `load`) to the first key, click or touch. Once a launch |
| `level_start` | also sent when a map that reads as a level loads |
| `level_abandon` | as §2 has it: `duration_s` since the level started, and `reason` (`background`, `quit`, `measure`: the session_end's) only when the plugin sends it itself, before `session_end`, for a level started (a map level too) and not yet completed, failed or abandoned. A `level_fail` or `level_abandon` for that level after the session ended is dropped; back from the background in the same session the level is open again. A map level that unloads closes without an abandon. A crash sends none |
| `error` | `kind`: `crash` (the game died: fatal, sent on the next launch), `ensure`, `script` (a Blueprint runtime error; Unreal stops that Blueprint there, so it is unhandled, like `exception`), `log_error` (`UE_LOG` Error; `fn` is the log category), `warning`, `manual`; adds `recent` (last 6 game events) and, for `script`, `attrs.blueprint` |
| `death`, `pos`, `bug_report` | positions only when they are on, in metres with y up |
| `bug_report` | as §2 has it, on a request of its own, from every session: `note`, `screenshot` (JPEG data URL of at most 200,000 characters, its longer side at most 960 px, shrunk through 800, 640, 480 and 320, as the Godot and Unity SDKs do), `recent` (the last 20 events and hitches as objects), `frames` (the last 6 windows' fps and p95), `device`; `x`, `y`, `z` when positions are on. `ts` and `level` are when the box opened. Neither the frame that reads the viewport back nor the box's first draw is timed |
| `session_end` | `reason`: `quit`, `background` (phones), `measure`, `crash`; a server's also `max_duration` (cut every 6 hours), `match_end` (Server Session Per Match) and `closed` (a listen server stopped hosting) |
| `custom` | also `screen_change`, `app_resume`, `rage_input`. Attributes take booleans and lists of strings (`FGlitchlessAttributes`) |
| `level_start` | `attrs` when the game passes `FGlitchlessAttributes` (a map level has none) |
| every event | `zone` while one is set (`SetZone`), and `match`, `party`, `run` while those groups are set; left out otherwise. A change of zone or group closes the frame window |
| `counts` | once a window that counted anything: `ts` (the window's start), `level`, `duration_s`, `dropped` (calls of new names turned away once 64 entries were counted), `counts: [{name, attrs, n, sums?, first_ts}]`. Held until `GET /v1/health` answers, and sent only when its `features` list `counts` |
| `props` | `props`: the keys that changed since the last, with null for one removed; at most one a window. Those set before the first batch go in `session_start.props` |
| `group` | `kind` (`match`, `party`, `run`), `id` (`h_` and 24 hex digits of SHA-1 of `<service>:<id>` for a match or party unless Hash Group Ids is off; `r_` and 12 characters for a run; null when it ends), `attrs`, `resumed: true` when the game passed a run's ID to go on with |
| `frame_window.net` | every window the game was connected in: `rtt` (a sketch at a = 0.05), `rtt_p50`, `rtt_p95`, `rtt_max`, `jitter_ms`, `loss_pct` (the worse of in and out), `in_kbps`, `out_kbps`, `samples` (one a second), `transport` (`unreal`, or `custom` for `NetSample`), `link` (`wifi`, `cellular`, `wired` or null), `host` (a listen server's host, whose round trip is 0) |
| `disconnect` | `reason` (`timeout`, `connection_lost`, `server_closed`, `kicked`, `failed_to_connect`, `other`), `connected_s`, `rtt_p95`, `loss_pct` (of that window, or the last). With a level open, a `level_abandon` with `reason: disconnect` follows. 20 a session |
| `reconnect` | `after_s` |
| server role | envelope `role: "server"`, `player_id` null, `service` the game's own. `session_start.session_type` is `user` (`synthetic` with `-autoplay` or `-glitchless-synthetic`), `device` only `browser`, `browser_version`, `os`, and `server: {tick_hz, max_players, build: "dedicated" or "listen", region, host: {os, cores, memory_gb}}`. `server_window` every 5 s in place of `frame_window` (no `hitch`, `load` or `pos`): `duration_s`, `ticks`, `tick_hz` (reached), `tick` (a sketch), `tick_p50`, `tick_p95`, `tick_max`, `late` (ticks over 1000 / NetServerMaxTickRate ms), `players`, `players_max`, `net_objects` (null with Iris), `in_kbps`, `out_kbps`, `cpu_pct` (of one core), `mem_mb`, `rtt_p95` (the players' pings), `ctx`. Nothing is sent until `GET /v1/health` lists `server_mode` |

What the server side needs (stream U2): `crash` (and `script` for Unreal, already) as fatal kinds for crash-free sessions; `ensure` as an error kind; engine-aware findings for `glitchless-unreal` (the leak finding should read `objects` and `actors`, and the hitch advice the Unreal causes above: PSO precaching and bundled PSO caches for `pso_compile`, `gc.TimeBetweenPurgingPendingKillObjects` and pooling for `gc`, async loading for `asset_load` and `map_load`, World Partition streaming for `level_stream`).

In anonymous mode a crash arrives under a fresh random session ID, because nothing on disk may tie it to the session it ended; in install and full mode it joins its session.

## How it is built

`Source/Glitchless/Private/Core` is the engine-independent core, a C++17 port of the Unity SDK's `GlitchlessCore.cs` with no Unreal types, no exceptions and no RTTI. It builds and runs without the engine: `node unreal/test/core.mjs` (clang or MSVC) runs its tests, among them JavaScript parity: the frame-time sketch matches `packages/sdk/src/sketch.js` byte for byte (its logarithm is fdlibm's, as V8's is, so every platform buckets alike; the copy is in `Source/ThirdParty/fdlibm`, with Sun's notice), and so do number formatting, rounding and error fingerprints. `node unreal/test/make-fixtures.mjs` rewrites the fixture from the JavaScript SDK.

The rest is the Unreal side: `GlitchlessRuntime` (frames and causes, maps, errors, crashes, lifecycle, the measure flag), `GlitchlessTransport` (FHttpModule, gzip through FCompression), `GlitchlessDevice`, `GlitchlessOutputDevice` (GLog), `GlitchlessBugReport` (Unreal's screenshot request, IImageWrapper JPEG, a Slate box), `GlitchlessInput`, the settings, subsystem and Blueprint library. Automation tests: `UnrealEditor-Cmd GlitchlessTest.uproject -ExecCmds="Automation RunTests Glitchless; Quit" -unattended -nullrhi` in `unreal/test/GlitchlessTest`, a test game that loads this plugin through `AdditionalPluginDirectories`. The end-to-end test, `node unreal/test/e2e.mjs`, packages that game as a Development build (BuildCookRun) and plays it against a local Glitchless server behind a recorder: a scripted run with planted problems (`-autoplay`), a crash and a fatal error each sent on the next launch, the bug report box typed into, a run of the genre calls (properties, groups, a level with attributes, a zone, counts, flags and lists, a dropped connection), the player's off switch (turned off mid-level and back on, a crash while it is off, and a later launch that sends nothing at all), and `-glitchless-measure`. `node unreal/test/mp.mjs` plays multiplayer matches on Unreal's replication with the editor binary (a launcher install can't build a Server target): a dedicated server and a client, a listen server and a client, and a server crash sent on its next start. `node unreal/test/ios.mjs` does the same on an iPhone: it packages and signs an iOS Development build (automatic signing, with the team in the test game's `DefaultEngine.ini`), installs it with `devicectl`, and plays it against a server on the Mac over the network. On Windows, `e2e.mjs` run over SSH renders with `-RenderOffscreen`, since a session with no desktop can't make a window (`--offscreen` does it anywhere). UE 5.8 won't cook with a Visual C++ runtime older than 14.50; it ships the installer in `Engine/Extras/Redist/en-us/vc_redist.x64.exe`. Build the editor target with `-NoHotReload` when an Unreal Editor is open, or UBT writes hot-reload module names the manifest doesn't point to.
