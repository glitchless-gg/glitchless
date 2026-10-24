# Changelog

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
