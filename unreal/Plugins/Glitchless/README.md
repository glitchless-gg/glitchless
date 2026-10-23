# Glitchless for Unreal

Game observability for Unreal Engine 5.8 (and 5.7). Glitchless records how your game runs for real players and gives your coding agent the same data, over MCP, so it can fix what they hit.

- **Stutter.** Every frame is timed, and each 5-second frame window carries a mergeable frame-time sketch and where the time went: the game thread, the render and RHI threads, the GPU. Each hitch (a frame over 50 ms and twice the recent median) comes with the thread that held it up and its likely causes: pipeline states compiled on the spot, shaders compiled (in the editor), garbage collection, a map load, a streamed level, assets loaded, or long game, render or frozen frames.
- **Errors and crashes.** `UE_LOG` errors, ensures with their callstacks, Blueprint runtime errors (Accessed None and the rest), and crashes, written to disk as the game dies and sent on the next launch. Grouped by the same fingerprint every Glitchless SDK uses, with the game events just before each one.
- **Bug reports.** A screenshot and the player's note, from one call or a key that opens a small box over the game.
- **Levels and players.** Maps are levels on their own. Deaths, level fails and quits feed the level funnel, death heatmaps and rage-quit detection.
- **Leaks.** UObject and actor counts and memory per level load.
- **Anonymous by default.** No player ID, no device identifier, coarse device facts only. [PRIVACY.md](PRIVACY.md) lists every field in each of the three modes.

It sends the same events as the browser, Unity and Godot SDKs, so the dashboard, the findings and the MCP tools work with an Unreal game as they are.

## Install

From Fab: install it to your engine, then enable Glitchless in **Edit → Plugins** (it is under Analytics). Fab installs it into the engine already built, so a Blueprint-only project can use it as it is.

From GitHub: download `glitchless-unreal-0.1.0.zip` from the [glitchless-unreal 0.1.0 release](https://github.com/glitchless-gg/glitchless/releases/tag/glitchless-unreal/v0.1.0) and unzip it to your project's `Plugins/Glitchless` (or copy this folder there), or add it to a project's `AdditionalPluginDirectories`. Enable it in **Edit → Plugins** and rebuild. A Blueprint-only project needs to become a C++ project once (**Tools → New C++ Class**), because the plugin is source.

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
| Level lost or quit | `FGlitchless::LevelFail(TEXT(""), TEXT("timeout"))` | Level Fail |
| The player died | `FGlitchless::Death(GetActorLocation(), TEXT("fell"))` | Death |
| Anything worth counting | `FGlitchless::Track(TEXT("powerup"), TEXT("magnet"))`, or a `TMap` of attributes and one of numbers | Track Event, Track Event (What) |
| A purchase (the convention in every SDK) | `FGlitchless::Track(TEXT("purchase"), {{TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}}, {{TEXT("amount"), 4.99}})` | Track Event, with `amount` in Numbers |
| What is on screen | `FGlitchless::SetContext(TEXT("enemies"), Enemies.Num())` | Set Context |
| Where the player is | `FGlitchless::SetPosition(GetActorLocation())` (sent in full mode or with Positions) | Set Position |
| A problem the game noticed | `FGlitchless::Error(TEXT("save failed"))` | Report Error |
| The player reports a bug | `FGlitchless::ReportBug(Note)` or `FGlitchless::ShowBugReportDialog()`; `FGlitchless::OnBugReportDialog()` says when the box opens and closes | Report Bug, Show Bug Report Dialog; the Glitchless subsystem's On Bug Report Dialog |

Bug reports are off until the game turns them on: set **Bug Report Key** (F8, as in the other SDKs) in the settings, or call Show Bug Report Dialog from the game's own menu. The box takes the game's input while it is open (the mouse is freed) and pauses the game (**Pause For Bug Report**, on by default; a game paused already stays paused).
| Send now | `FGlitchless::Flush()` | Flush |

A purchase is sent when the store confirms it: `amount` goes in the numbers (a number in the currency's units, 4.99, not 499) and `currency` is the ISO code the store charged in. Boards add the amounts up into revenue, revenue per player and revenue by item, in the game's one currency: purchases in another are listed as left out, not added in. Never send receipts, order ids or payment details.

Every call is safe before Init and from any thread. Positions are taken in Unreal units (centimetres, Z up) and sent as every SDK sends them, metres with y up: x = X/100, y = Z/100, z = Y/100.

Maps are levels except those that read as a menu, lobby, loader, overlay or end screen (`Entry`, `MainMenu`, `L_Frontend`, `Lobby`, `Loading`, `GameOver`, ...). The first `LevelStart` call turns that off: the game's own levels win.

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
| `-glitchless-off` | send nothing |
| `-glitchless-debug` | log each batch as it is sent |

On a phone, launch it from a Mac with the flags after the bundle ID, and the line comes back on the console: `xcrun devicectl device process launch --console --device <phone> <bundle id> -glitchless-measure=10`.

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

The envelope's `sdk` is `glitchless-unreal/0.1.0`. Differences from the browser SDK on the wire:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode. Install mode (new: a stored random player ID with coarse device facts) and full mode send one |
| `session_start` | `privacy` is `anonymous`, `install` or `full`. `device`: `browser: "Unreal"`, `browser_version` (`5.8.4`), `os` (`Windows`, `macOS`, `Linux`, `SteamOS`, `iOS`, `Android`), `mobile`, `device_tier`, `gpu_tier` (`low` on a Steam Deck), `renderer` (`deferred`, `forward`, `mobile`, `null`), `driver` (`D3D12`, `Metal`, `Vulkan`), `screen`, `dpr` (null), `refresh_hz` (phones only), `steam_deck`; full mode adds `model` (`Steam Deck OLED` on one), `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. `page` and `nav_ms` are null |
| `frame_window` | frame times from the clock at the start of each frame. Adds `game_ms` (game thread without its waits, GGameThreadTime), `process_ms` (the same, under the name the playtest gate reads), `render_ms` (render thread), `rhi_ms` (RHI thread, null without one), `gpu_ms`, `draw_calls` and `triangles` where the RHI counts them (it does only while its GPU profiler collects draw stats, so they are usually null in a packaged 5.8 build), `gc_collections`, `gc_ms`, `pso_compiles` (runtime PSO creations over 20 ms, UE 5.8), `shader_compiles` (editor only), `packages_loaded` (UE 5.8), `objects` (UObjects), `actors`, `heap_mb` (the process's memory), `texture_mb`, `screen`, `window`; `geometries`, `textures`, `programs` are null; `ctx` also holds `objects` and `actors`. A window never spans two levels |
| `hitch` | `duration_ms` is the frame's time on the clock, as Unreal's own hitch tracking times it (Unreal leaves waits out of its thread times, so a frame spent waiting on a pipeline state, the GPU or the disk would look short by them); `bound` names the slowest of the game, render and RHI threads and the GPU. `causes` from `pso_compile`, `shader_compile`, `gc`, `map_load`, `level_stream`, `asset_load`, `script` (game thread at 40% of the frame), `render` (render, RHI or GPU at 40%), `frozen` (over 700 ms). Adds `bound` (`game`, `render`, `rhi`, `gpu`, or null when no thread was measured), `game_ms`, `process_ms`, `render_ms`, `rhi_ms`, `gpu_ms`, `draw_calls` and `triangles` where the RHI counts them (it does only while its GPU profiler collects draw stats, so they are usually null in a packaged 5.8 build), `gc_collections`, `gc_ms`, `pso_compiles`, `shader_compiles`, `packages_loaded`; `loaf` is empty |
| `level_start` | also sent when a map that reads as a level loads |
| `error` | `kind`: `crash` (the game died: fatal, sent on the next launch), `ensure`, `script` (a Blueprint runtime error; Unreal stops that Blueprint there, so it is unhandled, like `exception`), `log_error` (`UE_LOG` Error; `fn` is the log category), `warning`, `manual`; adds `recent` (last 6 game events) and, for `script`, `attrs.blueprint` |
| `death`, `pos`, `bug_report` | positions only when they are on, in metres with y up |
| `bug_report` | as §2 has it, on a request of its own, from every session: `note`, `screenshot` (JPEG data URL of at most 200,000 characters, its longer side at most 960 px, shrunk through 800, 640, 480 and 320, as the Godot and Unity SDKs do), `recent` (the last 20 events and hitches as objects), `frames` (the last 6 windows' fps and p95), `device`; `x`, `y`, `z` when positions are on. `ts` and `level` are when the box opened. Neither the frame that reads the viewport back nor the box's first draw is timed |
| `session_end` | `reason`: `quit`, `background` (phones), `measure`, `crash` |
| `custom` | also `screen_change`, `app_resume`, `rage_input` |

What the server side needs (stream U2): `crash` (and `script` for Unreal, already) as fatal kinds for crash-free sessions; `ensure` as an error kind; engine-aware findings for `glitchless-unreal` (the leak finding should read `objects` and `actors`, and the hitch advice the Unreal causes above: PSO precaching and bundled PSO caches for `pso_compile`, `gc.TimeBetweenPurgingPendingKillObjects` and pooling for `gc`, async loading for `asset_load` and `map_load`, World Partition streaming for `level_stream`).

In anonymous mode a crash arrives under a fresh random session ID, because nothing on disk may tie it to the session it ended; in install and full mode it joins its session.

## How it is built

`Source/Glitchless/Private/Core` is the engine-independent core, a C++17 port of the Unity SDK's `GlitchlessCore.cs` with no Unreal types, no exceptions and no RTTI. It builds and runs without the engine: `node unreal/test/core.mjs` (clang or MSVC) runs its tests, among them JavaScript parity: the frame-time sketch matches `packages/sdk/src/sketch.js` byte for byte (its logarithm is fdlibm's, as V8's is, so every platform buckets alike; the copy is in `Source/ThirdParty/fdlibm`, with Sun's notice), and so do number formatting, rounding and error fingerprints. `node unreal/test/make-fixtures.mjs` rewrites the fixture from the JavaScript SDK.

The rest is the Unreal side: `GlitchlessRuntime` (frames and causes, maps, errors, crashes, lifecycle, the measure flag), `GlitchlessTransport` (FHttpModule, gzip through FCompression), `GlitchlessDevice`, `GlitchlessOutputDevice` (GLog), `GlitchlessBugReport` (Unreal's screenshot request, IImageWrapper JPEG, a Slate box), `GlitchlessInput`, the settings, subsystem and Blueprint library. Automation tests: `UnrealEditor-Cmd GlitchlessTest.uproject -ExecCmds="Automation RunTests Glitchless; Quit" -unattended -nullrhi` in `unreal/test/GlitchlessTest`, a test game that loads this plugin through `AdditionalPluginDirectories`. The end-to-end test, `node unreal/test/e2e.mjs`, packages that game as a Development build (BuildCookRun) and plays it against a local Glitchless server behind a recorder: a scripted run with planted problems (`-autoplay`), a crash and a fatal error each sent on the next launch, the bug report box typed into, and `-glitchless-measure`. `node unreal/test/ios.mjs` does the same on an iPhone: it packages and signs an iOS Development build (automatic signing, with the team in the test game's `DefaultEngine.ini`), installs it with `devicectl`, and plays it against a server on the Mac over the network. On Windows, `e2e.mjs` run over SSH renders with `-RenderOffscreen`, since a session with no desktop can't make a window (`--offscreen` does it anywhere). UE 5.8 won't cook with a Visual C++ runtime older than 14.50; it ships the installer in `Engine/Extras/Redist/en-us/vc_redist.x64.exe`. Build the editor target with `-NoHotReload` when an Unreal Editor is open, or UBT writes hot-reload module names the manifest doesn't point to.
