# Unreal

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


The Glitchless plugin (`unreal/Plugins/Glitchless` in the Glitchless repo), for Unreal Engine 5.8. It is C++
source: it times every frame on the game, render and RHI threads and the GPU, names each hitch's likely causes
(pipeline states created on the spot, garbage collection, map loads, streamed levels, asset loads), and reports
`UE_LOG` errors, ensures, Blueprint runtime errors and crashes. Maps are levels on their own.

## 1. Read the project

Note: `EngineAssociation` in the `.uproject` (5.8), whether there is a `Source/` folder (a C++ project) or not
(Blueprint only), `GameDefaultMap` in `Config/DefaultEngine.ini` and which maps are levels, the classes for player
death and respawn, level complete and fail, pickups, and anything spawned in bulk (projectiles, enemies, effects);
where the version lives (`ProjectVersion` under `[/Script/EngineSettings.GeneralProjectSettings]` in
`Config/DefaultGame.ini`). Blueprints are binary `.uasset` files: you can't read them as text. If Unreal MCP is
connected (below), use it to look inside them; otherwise ask the user where those moments live.

## 2. Install

Copy the plugin into the project, so it builds with the game (from the agent kit, or the GitHub release zip):

```bash
cp -R ~/.glitchless/unreal/Plugins/Glitchless "<Project>/Plugins/Glitchless"
```

Add it to the `.uproject`'s `Plugins` list: `{ "Name": "Glitchless", "Enabled": true }`. The plugin is source, so a
Blueprint-only project needs a C++ module once: ask the user to add one in the editor (**Tools → New C++ Class**,
any class) or add a minimal `Source/` folder yourself (a module, `<Game>.Target.cs` and `<Game>Editor.Target.cs`).
Then build the editor target: on a Mac `"/Users/Shared/Epic Games/UE_5.8/Engine/Build/BatchFiles/Mac/Build.sh"
<Game>Editor Mac Development -project="<path>/<Game>.uproject"`, on Windows `Engine\Build\BatchFiles\Build.bat
<Game>Editor Win64 Development -project=...`. Add `-NoHotReload` if an editor has the project open. C++ code that
calls Glitchless adds `"Glitchless"` to `PublicDependencyModuleNames` in its `.Build.cs`. If the user installed it
from Fab instead, it is an engine plugin that comes built: enabling it is all, and a Blueprint-only project needs no
C++ module. `unreal/demo` in the Glitchless repo is a working example, with three planted problems and a script
that checks Glitchless finds them.

## 3. Settings, without code

Add this to `Config/DefaultGame.ini` (or set it in **Project Settings → Plugins → Glitchless**); the game instance
starts Glitchless with it, so nothing calls Init:

```ini
[/Script/Glitchless.GlitchlessSettings]
Service=<game-id>
Intake=http://localhost:7777
ClientToken=gl_pub_dev
Privacy=Anonymous
bSendInDevelopmentBuilds=True
```

Play In Editor and Development builds send as env `dev`, Shipping builds as `prod`. The version is the project's
`ProjectVersion` unless `Version=` is set here: bump it on every release. For a game jam, keep
`bSendInDevelopmentBuilds=True`: jam submissions are Development builds.

## 4. Levels and game semantics

Maps are levels, except those that read as a menu, lobby, loader or end screen (`Entry`, `MainMenu`, `L_Frontend`,
`Lobby`, `Loading`, `GameOver`…). If one map plays many levels, call `LevelStart` where each begins; the first call
turns map levels off.

| Game moment | C++ (`#include "Glitchless.h"`) | Blueprint node |
| --- | --- | --- |
| level starts | `FGlitchless::LevelStart(TEXT("forest-2"))` | Level Start |
| level beaten | `FGlitchless::LevelComplete(TEXT(""), Score)` (empty: the current level) | Level Complete |
| game over: the player lost the level | `FGlitchless::LevelFail(TEXT(""), TEXT("timeout"))` | Level Fail |
| the player leaves mid-level (the menu, a restart) | `FGlitchless::LevelAbandon(TEXT(""))`: never a fail; quitting or going to the background mid-level sends one by itself | Level Abandon |
| player dies | `FGlitchless::Death(GetActorLocation(), TEXT("fell"))` | Death |
| pickups, checkpoints | `FGlitchless::Track(TEXT("powerup"), TEXT("magnet"))` | Track Event (What), Track Event |
| a purchase the store confirmed | `FGlitchless::Track(TEXT("purchase"), {{TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}}, {{TEXT("amount"), 4.99}})` | Track Event, `amount` in Numbers |
| counts of anything that scales, each frame | `FGlitchless::SetContext(TEXT("enemies"), Enemies.Num())` | Set Context |
| the player's place, each frame | `FGlitchless::SetPosition(GetActorLocation())` | Set Position |
| a problem the game noticed | `FGlitchless::Error(TEXT("save failed"))` | Report Error |

Pass Unreal units: the plugin sends positions in metres with y up, like the other SDKs. Every call is safe before
Init and from any thread.

**Outcomes, decks and streams.** Track a moment, count a stream, and send outcomes as flags so boards can show a win
rate. `FGlitchlessAttributes` takes words, numbers, flags and lists (in Blueprint: the **Glitchless Attributes**
struct, or the Add Word, Add Number, Add Flag and Add List nodes):

| What | C++ | Blueprint node |
| --- | --- | --- |
| a match, run or battle ends | `FGlitchless::Track(TEXT("match_end"), FGlitchlessAttributes().Add(TEXT("won"), true).Add(TEXT("hero"), Hero).Add(TEXT("items"), Items))` (`Items` a `TArray<FString>`) | Track Event (Attributes) |
| shots, kills, gold, taps: anything many times a second | `FGlitchless::Count(TEXT("gold"), FGlitchlessAttributes().Add(TEXT("source"), TEXT("loot")).Add(TEXT("amount"), 35.0))`: words and flags (4) say which, numbers (4) are summed, sent once every 5 s | Count Event |
| what the attempt is | `FGlitchless::LevelStart(TEXT("nmd_ghoa"), FGlitchlessAttributes().Add(TEXT("tier"), TEXT("pit_80")).Add(TEXT("party_size"), 3))` | Level Start's Attributes pin |
| what holds for the session: mode, rank tier, class, region | `FGlitchless::SetProperty(TEXT("rank"), TEXT("gold"))` (words, whole numbers, flags; a band like `"30-39"`, not an exact level), `ClearProperty` | Set Glitchless Property (and Number, Flag) |
| a match or party from the game's server | `FGlitchless::SetGroup(EGlitchlessGroup::Match, MatchId)` when it starts, `ClearGroup(EGlitchlessGroup::Match)` when it ends: every event carries the ID, hashed | Set Group, Clear Group |
| a roguelite run across levels | `FString Run = FGlitchless::SetGroup(EGlitchlessGroup::Run)`; save `Run` to resume it after a restart (Install and Full mode) | Set Group (Run) |
| where the player is in an open world (a zone, a room) | `FGlitchless::SetZone(TEXT("westfall"))`, empty to leave | Set Zone |

Properties and group IDs are checked: never a name, an account or platform ID, an email or a friends list. Match and
party IDs must be the ones the game's server made for that match (8 to 64 of `A-Z a-z 0-9 _ . : -`).

**Multiplayer on Unreal's replication needs nothing more.** Once a second a client's frame windows carry its round
trip, packet loss, jitter and traffic from the net driver, and a lost connection sends a `disconnect` (and abandons
the level, never a fail). A **dedicated server** reports itself as the game's server (role `server`, filed under
`<service>.server`): its tick time against `NetServerMaxTickRate`, players, their pings, CPU, memory and crashes. A
**listen server** is a player (`net.host`) and, while it hosts, a server too. Set `ServerRegion` in the settings (or
`-glitchless-region=eu-west` on each server's command line) to split ping by region, and `bServerSessionPerMatch` for
a server that hosts one match at a time. A game on another library (Steam Networking Sockets, EOS) calls
`FGlitchless::NetSample(RttMs, LossPct)` once a second and `FGlitchless::Disconnect(TEXT("timeout"))` itself. Call
`SetGroup(Match, …)` on the server and every client with the same ID, so a match reads from every side. `UE_LOG` errors, ensures, Blueprint runtime errors (Accessed None…) and crashes are
reported without code; a crash is sent the next time the game starts. UObject and actor counts are sent as gauges
already; add the game's own counts with `SetContext`. To find a Blueprint-only game's moments, add the nodes in the
Blueprints that handle them (with Unreal MCP, or by asking the user to).

## 4b. Bug reports from players (ask first)

As for [Three.js](threejs.md#4b-bug-reports-from-players-ask-first): ask the user first, since the note is free text the
player types, and point them at the privacy wording in the plugin's `PRIVACY.md`. Then add `BugReportKey=F8` to the
settings above: F8 opens a small Slate box over the game with a screenshot and a note. It takes the game's input
and pauses the game while open (`bPauseForBugReport`, on by default; a game paused already stays paused). A pause
menu can call **Show Bug Report Dialog** (`FGlitchless::ShowBugReportDialog()`), the game's own form **Report Bug**
(`FGlitchless::ReportBug(Note)`), and `FGlitchless::OnBugReportDialog()` (or the Glitchless subsystem's On Bug
Report Dialog) says when the box opens and closes.

## 4c. A "Share performance data" setting (where the game has a settings menu)

If the game has a settings or options menu, offer the user a toggle there that the player can turn off (ask before
adding UI; a game with no settings menu can go without). Keep it with the game's other settings, saved the way they are
(its SaveGame or `UGameUserSettings`), and pass it on as the game starts and on every change:

```cpp
FGlitchless::SetEnabled(Settings->bSharePerformanceData); // in UGameInstance::Init, and when the toggle changes
```

In Blueprint: the Check Box's **On Check State Changed** → **Set Enabled** (Is Checked into On), and the same node with
the saved value where the game loads its settings. Off stops measuring and sending at once and drops what was waiting
(the outbox on disk too); the plugin saves the choice in `Saved/Glitchless/enabled` and reads it before the first frame
of the next launch, so it holds even though Glitchless starts from Project Settings before any menu. A call that
changes nothing does nothing. Show the game's own setting on the toggle, not **Is Enabled** (false in a build that
sends nothing, such as a development build without `-glitchless`). For a game that asks before collecting anything,
set `bOptIn=True` in the settings above and default the toggle to off. With a toggle, the store forms can answer that
collection is optional, and the privacy page gets a sentence about it (the plugin's `PRIVACY.md`).

## 5. Bots and measuring

Package a Development build, then run it with flags:

```bash
"/Users/Shared/Epic Games/UE_5.8/Engine/Build/BatchFiles/RunUAT.sh" BuildCookRun -project="<path>/<Game>.uproject" -platform=Mac -clientconfig=Development -build -cook -stage -pak -unattended
<Game> -glitchless-warmup=2 -glitchless-measure=10 -glitchless-out=measure.json
```

`-glitchless-measure=S` waits for the first map plus the warmup, measures S seconds, prints
`{"glitchless_measure": {...}}` as one line on stdout and quits; the numbers are `glitchless_measure`'s (frame_ms
percentiles, fps, game/render/RHI/GPU ms, hitches with causes, memory, new errors) plus `session_id`. If the game has
an autoplay or test mode, start it with `-autoplay`; that and `-glitchless-synthetic` mark the session synthetic.
`-glitchless-intake=URL` sends to another server for one run. A Windows build has no console: read the
`-glitchless-out` file. A UE 5.8 Mac build is sandboxed: it can write `-glitchless-out` only inside
`~/Library/Containers/<bundle id>/Data` (its `tmp` is a good place), and stdout works anywhere. Don't start a build
or cook while another Unreal build, cook or shader compile is running on the machine.

## 6. Agents in the editor: Unreal MCP

UE 5.8 ships Unreal MCP (Experimental), Epic's MCP server inside the editor: with it you can open maps, look inside
Blueprints and actors, edit them and run Play In Editor. Glitchless doesn't replace it; the two split the work:

- **Unreal MCP** is your hands in the editor: find where deaths and level ends happen in Blueprints, add the
  Glitchless nodes there, change the scene or material a finding points at, and start Play In Editor.
- **Glitchless** says what is wrong and whether a change fixed it: the `glitchless` MCP server reads what players and
  bots sent (findings, hitches with causes, errors, sessions), and the optional **Glitchless Toolset** plugin
  (`unreal/Plugins/GlitchlessToolset`) adds `Status` and `Measure` tools to Unreal MCP, so you can measure the game
  while it plays in the editor, as `glitchless_measure` does for a web game.

To set it up, copy `GlitchlessToolset` next to `Glitchless` in `Plugins/`, enable **Unreal MCP**, **All Toolsets** (or
**Toolset Registry**) and **Glitchless Toolset** in **Edit → Plugins** (or the `.uproject`), start the server
(`ModelContextProtocol.StartServer` in the editor console, or Editor Preferences → Model Context Protocol → Auto
Start Server), and run `ModelContextProtocol.GenerateClientConfig ClaudeCode` (or Cursor, Codex…) for the client
config. Start Play In Editor before calling `Measure`. Numbers from the editor run slower than a packaged build
(shaders compile on first use there): confirm a fix with a packaged Development build and `-glitchless-measure`.

## 7. Verify

Press Play in the editor (or run a Development build), play a level and die once, then call `glitchless_list_games`
or open the dashboard. The log shows `LogGlitchless` lines; `-glitchless-debug` logs each batch as it is sent.
