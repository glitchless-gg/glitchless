# What Glitchless for Unreal sends

This file lists every field the Unreal plugin sends in each mode, what it keeps on the device, and what a game's privacy page and store answers would need to say. It was written from `Source/Glitchless/Private/Core/GlitchlessCore.cpp`, `GlitchlessDevice.cpp`, `Core/GlitchlessSteam.cpp`, `GlitchlessSteamworks.cpp` and `GlitchlessRuntime.cpp`, and checked against what reached a local server in `node unreal/test/e2e.mjs`. Keep it in step with those files. The browser, Unity and Godot SDKs have their own lists; anonymous and full mean the same thing in all of them.

Nothing here is legal advice. The store answers at the end are a reading of Apple's, Google's and Valve's categories; check them against the forms as they are when you submit.

## The three modes

**Project Settings → Plugins → Glitchless → Privacy**, or `FGlitchlessOptions::Privacy`. Anonymous is the default.

| | anonymous | install | full |
| --- | --- | --- | --- |
| Session ID | random, made at launch, **kept in memory only** | random, made at launch, saved with unsent batches until they go | the same as install |
| Player ID | **none**. The server files each session under its session ID | random `p_…` made on first launch and saved in `Saved/Glitchless/player_id`, so returning players can be counted. Not tied to any account, platform ID or advertising ID | the same as install |
| Device | OS name, a low/mid/high tier, renderer and graphics API, screen size (and on phones its refresh rate), whether it is a Steam Deck | the same as anonymous | adds model, OS version, GPU name and vendor, core count, memory |
| Positions | **not sent** unless Positions is on: deaths go without a place, no movement samples | the same as anonymous | death places and 4 Hz position samples in the game world |
| Saved on the device | unsent batches, without the session or player ID | unsent batches with their IDs, and the player ID | the same as install |

Positions (Advanced) turns positions on in anonymous and install mode. They are places in the game's own world, not the player's location: Unreal units are sent as metres, with y up.

No mode reads or sends:

- the computer's or phone's name, the user's account name (it is cut out of paths, below), or any hardware serial
- the advertising ID, Apple's identifier for vendors, Android's ID, or a Steam, Epic or console account ID
- a name, email, account, or anything the player types, except the note in a bug report the player chooses to send
- contacts, location, locale, time zone, or the network address

The Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's logging settings.

## Field by field

Every batch sends the envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode), `sdk` (`glitchless-unreal/0.2.0`) and `batch_id` (random, made for each batch and sent again with its retries).

Every event has `type`, `ts` (when it happened, in milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `privacy`, `device` (below) | the first batch of a session |
| `session_end` | `reason` (`quit`, `background`, `measure`, `crash`), `duration_s` | quitting, going to the background on a phone, a crash |
| `frame_window` | frame count, fps, the refresh rate measured from the frames (`hz`, `budget_ms`), frame-time sketch and percentiles, slow/jank/hitch/frozen counts, game/render/RHI thread and GPU ms (averages over the window), draw calls and triangles (averages, and the most draw calls), garbage collections and their ms, pipeline states compiled, packages loaded (totals over the window), UObject and actor counts, the process's memory MB, texture MB (the last sample: every 30 frames and as the window closes); `screen` and `window` size in pixels, `ctx` (the game's gauges and the engine counts, each the highest value it was set to in the window) | every 5 s |
| `hitch` | duration, the thread that held it up, likely causes, the same timings and counts for that one frame, `ctx` (the gauges as they were then), `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms, at most 3 per window |
| `load` | `ttff_ms` (engine start to first frame), `ttp_ms` (to first key, click or touch); `ts` is when that frame or input happened | once |
| `error` | `kind`, `message`, `stack` (function names, source paths of the game's build, lines), `source`, `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `Error`, and a Blueprint's class name), `recent` (the last 6 game event names) | each error, at most 25 of a kind per session; a crash is sent on the next launch |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them; `level_start` also when a map that is a level loads | the game calls them, or a map loads |
| `level_abandon` | `duration_s`; `reason` (`background`, `quit`, `measure`) when Glitchless sends it | the game calls `LevelAbandon`, or the game goes to the background or quits mid-level |
| `death` | `cause`; **full** or Positions: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `Track` | the game calls it |
| `custom` (by Glitchless) | `screen_change` {screen, window}, `app_resume` {away_s}, `rage_input` {key name or `pointer`, count; off on phones} | as they happen |
| `pos` | **full** or Positions: `[time, x, y, z]` samples | every 5 s while positions are on |
| `bug_report` | `note` (what the player wrote, up to 2,000 characters), `screenshot` (a JPEG of the game's screen, its longer side at most 960 pixels), `recent` (the last 20 game events and hitches, as above), `frames` (the last windows' fps and frame time), `device` (as in `session_start`, at the same mode); **full** or Positions: `x`, `y`, `z` | only when the player sends one, or the game calls `ReportBug`; from every session, sampled or not |

`device` in `session_start`:

| field | example | mode |
| --- | --- | --- |
| `browser`, `browser_version` | `Unreal`, `5.8.4`: the engine, the same for every player of a build | all |
| `os` | `Windows`, `macOS`, `SteamOS` | all |
| `mobile` | `false` | all |
| `device_tier` | `low` / `mid` / `high`, from core count and memory | all |
| `gpu_tier` | on desktops, from the GPU name; the same as `device_tier` on phones; `low` on a Steam Deck | all |
| `renderer`, `driver` | `deferred`, `D3D12` | all |
| `screen` | `[2560, 1440]` | all |
| `refresh_hz` | `120`: the screen's highest refresh rate as the OS reports it, on phones only (null elsewhere); the rate the game ran at is `frame_window.hz` | all |
| `steam_deck` | `true` | all |
| `model`, `os_version` | `Steam Deck OLED`, `Windows 11 (24H2)` | **full** |
| `gpu`, `gpu_vendor` | `NVIDIA GeForce RTX 4070`, `NVIDIA` | **full** |
| `cores`, `memory_gb` | `16`, `32` | **full** |

**Error text.** Unreal's messages come from the engine and the game's code, not from the player. Paths on the device are cut down before sending, in every mode: the project's Saved folder, the project, the engine, the user's settings folder and documents become `saved:`, `project:`, `engine:`, `settings:` and `documents:`, and on a phone the app's data folder and the app itself become `home:` and `app:`; `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` lose the name; iOS container IDs (made per install) become `<id>`. If the game puts anything of the player's into a `UE_LOG` error, an ensure message or `Error()` attributes, it is sent. Don't.

**Game words.** `Track` names and attributes, level names, map names (sent as level names), death causes and gauges are whatever the game passes. Use the game's own words, never anything typed by or particular to the player.

**Bug reports** are the one place the player's own words and a picture of their screen are sent, and only when the player presses Send (or the game calls `ReportBug` on their behalf). Say so wherever the game offers it.

## Steam facts

When the game already uses Steamworks through Unreal's `SteamShared` or `OnlineSubsystemSteam` module, `session_start`'s `device` also carries these, in every mode (`Core/GlitchlessSteam.cpp`, `GlitchlessSteamworks.cpp`). The plugin reads them through Steam's own library, only while one of those modules is loaded and once Steamworks is initialised, and links nothing of Steam's. A library without a call leaves that field out (Unreal 5.8 ships SDK 1.64, which tells a Steam Deck but not the other hardware, and has no Proton call).

| field | example | what it says |
| --- | --- | --- |
| `steam_build` | `18231` | the Steam build the game runs; left out when it isn't a build downloaded from Steam |
| `steam_branch` | `beta`, `public` | the beta branch it runs, or `public` on the default one |
| `steam_hardware` | `deck`, `machine`, `frame`, `none` | whether it runs on Valve's hardware (Steam Deck, Steam Machine, Steam Frame), and which. `deck` also makes `steam_deck` true |
| `proton` | `true` | running under Proton |
| `big_picture` | `false` | Steam is in Big Picture mode |
| `steam_controller` | `ps5`, `xbox_one`, `steam_deck` | the kind of the first controller Steam Input sees, once the game has started Steam Input |
| `family_shared` | `false` | the player has the game through Family Sharing |
| `timed_trial` | `false` | the game is played as a timed trial (not how long) |
| `steam_language` | `english` | the language the player picked for the game in Steam |

**Never read or sent, in any mode:** the player's Steam ID, the owner's Steam ID (`GetAppOwner`), the player's Steam name, friends, or anything else from their Steam account. Valve's rules on passing Steam IDs to third parties are unclear, so Glitchless leaves them out entirely. The facts above are about the build and the hardware, and many players share each one.

**Version.** When the game passes no version, batches carry `steam-<build>` (`steam-18231`) on a Steam build, so each build is a version on the dashboard.

## Kept on the device

| file | what | mode |
| --- | --- | --- |
| `Saved/Glitchless/outbox.json` | batches not yet sent (offline, the game closed first, or it crashed): the events above, each batch with its own random batch ID (`b_…`, sent as `batch_id` so the server stores a batch once however often it arrives; it names the batch, never the player or the session). In anonymous mode, no session or player ID. Rewritten as each batch is sent, deleted once everything is. At most 4,000 events, none over 6 days old | all |
| `Saved/Glitchless/player_id` | the random player ID | **install** and **full**. Anonymous mode deletes it if another build left one |

`Saved` is the game's own folder: `%LOCALAPPDATA%\<Game>\Saved` on Windows, `~/Library/Application Support/Epic/<Game>/Saved` on macOS. Uninstalling the game may leave it; deleting it removes both files.

## Kept on the server

The open-source Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store reads back the last 14 days, though the files stay until deleted. The hosted service at glitchless.gg keeps them for as long as the plan says.

If the server forwards to Datadog or an OpenTelemetry backend, that backend receives the same events, sent from the server, not the device.

## For the privacy page

A paragraph for anonymous mode, to adapt to the game's own voice:

> **Performance and error reports**
> So that we can find and fix stutters, crashes and bugs, the game measures how smoothly it runs and notes errors in its own code. Every few seconds, and when you leave the game, it sends these to our servers; a crash report is sent the next time you play. A report says how long frames took, what was on screen (for example how many enemies), which level you were on and which of the game's events had just happened, along with the game's version and a few broad facts about the device: its system, whether it is a slower or faster model, its screen size and whether it is a Steam Deck. Reports from one launch share a random number made when the game starts. The number is never saved, so the next launch cannot be linked to it. Reports carry no player ID, no device identifier or model name, nothing you type and no location, and we do not keep the address they came from. They are deleted after *[30 days]*.
>
> If you send a bug report, it includes what you wrote and a picture of the game's screen at that moment.

If the game ships on Steam and uses Steamworks, add:

> **Steam**
> On Steam, the reports also say which build and beta branch of the game you run, whether it runs on a Steam Deck or other Steam hardware, under Proton or in Big Picture mode, what kind of controller you use, the game's language, and whether you play through Family Sharing or a timed trial. They carry no Steam ID, account name or anything else from your Steam account.

Install mode needs one more sentence: a random number is saved with the game, so we can tell how many players come back; it is not linked to your account. Full mode needs that, the device model, and positions in the game world.

## For the store forms

**App Store Connect → App Privacy.** Apple counts data as collected when it leaves the device and is kept, anonymous or not.

| Apple's type | from | anonymous | install, full |
| --- | --- | --- | --- |
| Usage Data → Product Interaction | levels, deaths, `Track` events | collected | collected |
| Diagnostics → Performance Data | frame times, hitches, load times | collected | collected |
| Diagnostics → Crash Data | crashes, ensures | collected | collected |
| Diagnostics → Other Diagnostic Data | errors, device tier, screen, engine counts | collected | collected |
| User Content → Other User Content | bug report notes and screenshots | collected if the game offers bug reports | the same |
| Identifiers → Device ID | the random player ID | not collected | collected |

For each type: **purposes** Analytics, and App Functionality if the reports are used to fix bugs; **linked to you** No in anonymous mode (there is no identifier and the session number is never saved), and in install and full mode the cautious answer is Yes; **used for tracking** No in every mode.

**Google Play → Data safety.**

| Google's type | anonymous | install, full |
| --- | --- | --- |
| App activity → App interactions | collected | collected |
| App info and performance → Crash logs, Diagnostics, Other app performance data | collected | collected |
| Device or other IDs | not collected | collected (the random player ID) |
| Messages → Other in-app messages, Photos and videos | collected if the game offers bug reports | the same |

**Steam and the Epic Games Store** ask no form-by-form questions, but a game that sends data must say so in its privacy policy, and the EULA or store page should point to it.

**Shared:** none, when the server is your own or the hosted service acting for you. **Encrypted in transit:** Yes, when the intake URL is `https://`. **Required or optional:** collection is required unless the game offers a setting; a toggle that leaves the service empty, or turns Enabled off, makes it optional.

## When this file must change

Read it again when any of these change: the events or fields in `GlitchlessCore.cpp`, the device fields in `GlitchlessDevice.cpp`, the Steam facts in `GlitchlessSteam.cpp` and `GlitchlessSteamworks.cpp`, the counters in `GlitchlessRuntime.cpp`, what the server stores, or where it forwards. Then change the game's privacy page and store answers before the build that sends more is released.
