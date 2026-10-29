# Changelog

## 0.6.1

- The SDK's own warnings are no longer sent as the game's errors. With `CaptureWarnings` on, a warning the SDK logged itself (they start with `[glitchless]`, such as a `--glitchless-out` file it couldn't write, or a bug report callback that threw) came back through Unity's log and was sent as one of the game's errors. Nothing new is sent.

## 0.6.0

- The player's off switch. `Glitchless.SetEnabled(on)` is for a "Share performance data" toggle in the game's settings. Off saves the choice first, then stops Glitchless at once: nothing more is measured or sent (not even `GET /v1/health`), everything waiting is dropped, the outbox on the device included, and the session ends without a `session_end` or `level_abandon`. The bug report form doesn't open, `ReportBug` answers `(false, "off")`, and measuring says Glitchless is off. On starts a new session in the same launch, with the properties and groups still set; the level attempt that was going gets no outcome. A call that changes nothing does nothing, and every call is safe before `Init`.
- The choice is saved in `persistentDataPath/glitchless/enabled` (WebGL: PlayerPrefs `glitchless.enabled`) as `on` or `off`, in every privacy mode, once the game calls `SetEnabled`. The automatic start reads it before anything else, so a player who turned Glitchless off has nothing measured from the first frame, and an outbox an earlier launch left is deleted unread.
- `GlitchlessOptions.OptIn` (and **Opt In** on the Bootstrap): a device with no choice saved starts off until the game calls `SetEnabled(true)`, for a game that asks first. A saved choice wins over it.
- `Glitchless.Enabled` is false while the player has Glitchless off. `GlitchlessOptions.Enabled = false` and `--glitchless-off` still turn a build off whatever the player chose.

## 0.5.1

- Google Play's pre-launch test phones are `synthetic` again. They no longer set Android's `firebase.test.lab` setting (Starlift's pre-launch runs in October 2026 came without it): they are virtual phones that draw in software, so an Android device whose GPU is a software renderer (SwiftShader, llvmpipe) is a test phone too (`DeviceInfo.IsStoreTestDevice`). No phone a player holds draws in software. Nothing new is sent.

## 0.5.0

For multiplayer games and genres beyond the single-player level loop. Every new event needs a Glitchless server that knows it: an older one keeps the new fields and drops the new events, and the SDK sends counters and a server's sessions only to a server that says it takes them (`GET /v1/health`).

- `Glitchless.Count(name, what, n)` counts a stream (shots, kills, gold picked up) on the device and sends it as one `counts` event a frame window, instead of an event each time. Words and booleans make its group, numbers are added up. In a debug build, a name tracked more than 20 times a second gets a hint to count it instead.
- Properties: `Glitchless.SetProperty(key, value)`, `SetProperties(dict)` and `Properties` in the options say what holds for the session (mode, rank tier, class, server region). They go in `session_start` and, when they change, in one `props` event a window, in every privacy mode. Keys and values that would say who the player is are dropped (PRIVACY.md).
- Groups: `Glitchless.SetGroup("match" | "party", id)`, `SetGroup("run")` and `SetGroup(kind, null)` mark every event and window with the match, party or run. Match and party IDs are hashed with the service as the salt, the same way in every Glitchless SDK (`HashGroupIds = false` sends them as they are). A saved run resumes after a restart only in install and full mode.
- `Glitchless.LevelStart(level, attrs)`: what kind of attempt a level is (difficulty, party size, a build).
- `Glitchless.SetZone(name)`: where the player is in an open world, on every event and window.
- Network quality: with Netcode for GameObjects 2.x (Relay and Lobby included) or Mirror, found at run time with no dependency, frame windows carry `net` (round trip, jitter, whether through Relay, Wi-Fi or mobile data on phones) while connected, and disconnects are `disconnect` events with their reason; a level going ends as an abandon with reason `disconnect`, and a reconnect lets it go on. `Glitchless.NetSample`, `Disconnect` and `Reconnect` for any other library.
- Server mode: a Dedicated Server build, `--glitchless-server` or `Role = GlitchlessRole.Server` reports as the game's companion service (`role: "server"`) with `server_window` events (tick time, ticks late, tick rate reached, players, networked objects, players' ping, CPU, memory) instead of frame windows, and never as a player. `ServerRegion`, `MaxPlayers`, `SessionPerMatch` and `Glitchless.SetPlayers(n)`.
- `ITransport` has a `Get` for `/v1/health`: a game with its own transport adds it.

## 0.4.1

- TestFlight testers are not players. On iOS the SDK tells a TestFlight install from an App Store one, with no native plugin: Apple writes an App Store receipt (`StoreKit/receipt` in the data container) with every App Store install and none with a TestFlight one, and a development build carries `embedded.mobileprovision`. It only checks that the files are there. `session_start.device` says `distribution` (`app_store`, `testflight` or `development`), a TestFlight or development session is `tester` unless `SessionType` is set (findings and share links count `user` sessions only), and `Track()` adds `sandbox: true` to a purchase there (an event named `purchase`, or any with a `currency`), which boards count but never add into revenue.

## 0.4.0

- Needs Unity 6.3 LTS or later: Unity 2022.3 is no longer supported. Tested on Unity 6.3 LTS (6000.3.27f1) and Unity 6.5 (6000.5.9f1).
- Compiles on Unity 6.5, where `Scene.handle` is a `SceneHandle` that no longer converts to an int (0.3.0 didn't build there).
- Every batch carries a random `batch_id` (`b_` and 16 characters), made when the batch is cut and sent with every try of it, and saved with the batch in every privacy mode (it names the batch, not the session or the player). The server stores a batch once however often it arrives: after a timeout, a send cut short by going to the background or quitting (which sends the batch in flight again), or a launch that sends what the last one saved. Sending on the way out saves the outbox after each batch the server takes, and the answer to an aborted send is no longer taken for a later try of the same batch.
- `Glitchless.LevelAbandon(level)`: the player left the level before it ended (the menu, a restart). Never a fail. Going to the background (phones) or quitting with a level started and not yet completed, failed or abandoned sends one by itself, with that `reason`, before `session_end`, and a `LevelFail` or `LevelAbandon` for that level after the session has ended is dropped. Back from the background in the same session, the level carries on.
- A Glitchless call from an `OnDestroy` as the game quits no longer starts Glitchless again.
- Sessions on Firebase Test Lab devices (Google Play's pre-launch report; Android's `firebase.test.lab` setting, read on the device and not sent) are `synthetic` unless `SessionType` is set.
- Hitches that none of the other causes explain, with what the timing points measured adding up to less than max(16 ms, 40% of the frame), get the cause `gpu_or_os`: the GPU, presenting the frame or the OS.
- The `load` event is stamped with the first frame's time, not the first batch's, and says `first_launch` (the first launch of this game version on the device; `persistentDataPath/glitchless/launched` holds the version that last ran).
- The frame budget (`hz`, `budget_ms`) is read from the fast frames, as the browser SDK reads it: the 20th percentile, a first guess after 30 frames (the first windows no longer go out at 60 Hz on every screen), the answer at 120, then a look every 480 frames that only goes faster, and lowered when the OS reports a slower screen. A game at 40 fps on a 60 Hz screen was judged at 30 Hz; now at 60.
- Docs: `refresh_hz` is the screen's rate as the OS reports it, not the rate the game ran at; what each frame window field means (averages, maxima, totals, and counts as the window closed).

## 0.3.0

- `Privacy.Install`: anonymous mode plus the random `p_…` player ID saved on the device (`persistentDataPath/glitchless/player_id`, the one `Privacy.Full` uses; PlayerPrefs in WebGL builds, which now keep it in Full mode too) and sent as `player_id`, so the dashboard can count retention (D1, D7, D30). Device fields and positions are sent as in anonymous mode, and unsent batches keep their IDs. `Glitchless.ResetInstallId()` forgets the ID from the next launch, and Install ID on the Bootstrap turns the mode on. `session_start` says `privacy: "install"`. `Privacy.Full` keeps its value (1); `Install` is 2. The same as the Unreal plugin's install mode.
- `steam_deck` in the device fields (`true` on a Steam Deck: `SteamDeck=1`, Valve's Jupiter or Galileo board, or SteamOS; under Proton through Wine's `Z:` drive), with `gpu_tier` `low` and `os` `SteamOS` on a Deck running it, as the Unreal plugin sends them.
- Steam facts in the device fields when the game uses Steamworks.NET or Facepunch.Steamworks (found by reflection, read only once Steam is initialised): `steam_build`, `steam_branch` (`public` on the default branch), `steam_hardware` (`deck`, `machine`, `frame`, `none`), `proton`, `big_picture`, `steam_controller` (the first Steam Input controller's type), `family_shared`, `timed_trial`, `steam_language`. Never a Steam ID. With `Version` empty, a Steam build reports `steam-<build>` as its version. See PRIVACY.md.

## 0.2.0

- Bug reports from players: `Glitchless.ReportBug(note)`, `Glitchless.OpenBugReport()` and `BugReports = new BugReportOptions()` in the options for an F8 form (IMGUI, no EventSystem needed, Input Manager or Input System). A report carries the note, a screenshot shrunk to fit, where the player was, the last game events and frame windows, and goes on a request of its own with the outbox as fallback. The form pauses the game (`PauseGame`) and has `OnOpen` and `OnClose`.
- The package now depends on the built-in IMGUI, Image Conversion and Screen Capture modules.

## 0.1.0

The first release.

- Frame times from `Time.unscaledDeltaTime`, summed up per 5-second window in the frame-time sketch the browser and Godot SDKs use, with update, physics, render and GPU time per frame.
- Hitches with likely causes: garbage collection, shader compiles, scene loads, object bursts, long script, physics or render work, frozen frames.
- Uncaught exceptions, `Debug.LogError`, assertions and engine errors, grouped by fingerprint, with the game events before each.
- Scenes as levels, deaths, level completes and fails, game events, gauges and positions.
- Draw calls, SetPass calls, batches, triangles and memory from Unity's profiler counters; mesh, material, texture and object counts in development builds.
- Anonymous by default. Gzipped batches with retries, an offline outbox, and a last send when the app goes to the background or quits.
- `--glitchless-measure` for coding agents, and the Fetch! sample with planted bugs.
- Unity 2022.3 LTS and Unity 6.
