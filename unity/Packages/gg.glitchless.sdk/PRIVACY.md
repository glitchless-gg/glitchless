# What Glitchless for Unity sends

This file lists every field the Unity SDK sends in each mode, what it keeps on the device, and what a game's privacy page and store answers would need to say. It was written from `Runtime/GlitchlessCore.cs`, `Runtime/DeviceInfo.cs`, `Runtime/SteamInfo.cs`, `Runtime/GlitchlessRunner.cs` and `Runtime/BugReports.cs`, and checked against what reached a local server in `npm run test:unity`. Keep it in step with those files. The browser, Godot and Unreal SDKs have their own lists, and the modes mean the same thing in all of them (`docs/SPEC.md` §4b).

Nothing here is legal advice. The store answers at the end are a reading of Apple's and Google's categories; check them against the forms as they are when you submit.

## The three modes

`Privacy = Privacy.Anonymous` is the default. `Privacy.Install` adds a saved player ID, so the game can see how many players come back (retention). `Privacy.Full` adds that and the fields marked **full** below. On the Glitchless Bootstrap component, Install ID and Full Privacy pick the same (Full wins when both are on).

| | anonymous | install | full |
| --- | --- | --- | --- |
| Session ID | random, made at launch, **kept in memory only** | random, made at launch, saved with unsent batches until they go | the same as install |
| Player ID | **none**. The server files each session under its session ID | random `p_…` made on first launch and saved in `persistentDataPath/glitchless/player_id` (in WebGL builds, in PlayerPrefs as `glitchless.player_id`, which is the browser's localStorage). Not tied to any account, device ID or advertising ID | the same ID as install mode |
| Device | OS name, a low/mid/high tier, render pipeline and graphics API, screen size, refresh rate, and whether it is a Steam Deck | the same as anonymous | adds model, OS version, GPU name and vendor, core count, memory |
| Positions | **not sent** unless `Positions = true`: deaths go without a place, no movement samples | the same as anonymous | death places and 4 Hz position samples, in game-world units |
| Saved on the device | unsent batches, without the session or player ID; the game version that last ran | unsent batches with their IDs, the player ID, and the game version that last ran | the same as install mode |

**What install mode adds to anonymous mode:** the player ID, sent in every batch as `player_id` and saved on the device, so the next launch sends the same ID; and, because that ID is on the device anyway, unsent batches are saved with their session and player IDs. Everything else is sent exactly as in anonymous mode. Install and full mode share the saved ID; anonymous mode deletes one another build left. `Glitchless.ResetInstallId()` deletes it: the session in progress keeps sending the ID it started with, and the next launch makes a new one, which nothing links to the old one.

`Positions = true` turns positions on in anonymous and install mode. They are places in the game's own world, not the player's location.

On Android, every mode reads one system setting, `firebase.test.lab`: Google Play's pre-launch report sets it on Google's test phones (Firebase Test Lab), and a session there is marked `synthetic` (a bot's) so it stays out of the players' numbers. It is read on the device, only to mark the session, and the setting itself is not sent.

No mode reads or sends:

- `SystemInfo.deviceUniqueIdentifier` or `SystemInfo.deviceName` (which is often the owner's name, as in "Sam's iPhone")
- the advertising ID, Apple's identifier for vendors, or Android's ID
- a name, email, account, or anything the player types (except a bug report's note, below)
- contacts, location, locale, time zone, or the network address

The Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's logging settings.

## Field by field

Every batch sends the envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode, the saved player ID in install and full mode), `sdk` (`glitchless-unity/0.4.0`) and `batch_id` (random, made for each batch and sent again with its retries).

Every event has `type`, `ts` (when it happened, in milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user`, or `synthetic` for bots, batch mode and Firebase Test Lab), `privacy` (`anonymous`, `install` or `full`), `device` (below) | the first batch of a session |
| `session_end` | `reason` (`background`, `quit`, `measure`), `duration_s` | going to the background on a phone, quitting |
| `frame_window` | frame count, fps, the refresh rate measured from the frames (`hz`), frame-time sketch and percentiles, slow/jank/hitch/frozen counts, update/physics/render/GPU ms, draw calls, SetPass calls, batches, triangles, GC collections, GC heap and system memory MB; in development builds also mesh, material, texture, object and GameObject counts and allocation per frame; `screen` and `window` size in pixels, `ctx` (the game's gauges and the engine counts, each at its highest in the window; the counts outside `ctx` are their value as the window closed) | every 5 s |
| `hitch` | duration, likely causes (`gpu_or_os` when the time went outside what the SDK times in the game), the same timings and counts for that one frame, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms, at most 3 per window |
| `load` | when the first frame was drawn, `ttff_ms` (app start to first frame), `first_launch` (whether this is the first launch of this game version on the device), `ttp_ms` (to first touch or key) | once |
| `error` | `kind`, `message`, `stack` (function names, script file paths inside the project, lines), `source`, `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `Glitchless.Error`), `recent` (the last 6 game event names) | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them; `level_start` also when a scene that is a level becomes active | the game calls them, or a scene loads |
| `level_abandon` | `duration_s`; `reason` (`background`, `quit`, `measure`) when Glitchless sends it | the game calls it, or the game goes to the background (phones) or quits mid-level |
| `death` | `cause`; **full** or `Positions`: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `Track()` | the game calls it |
| `custom` (by Glitchless) | `screen_change` {screen, window}, `app_resume` {away_s}, `rage_input` {key name or `pointer`, count; off on phones} | as they happen |
| `pos` | **full** or `Positions`: `[time, x, y, z]` samples | every 5 s while positions are on |
| `bug_report` | `note` (what the player typed), `screenshot` (a JPEG of the screen as Unity drew it), `device` (the same fields as `session_start`, in the same mode), `recent` (the last 20 game events and hitches: when, which, and the few fields above that say what happened), `frames` (fps and p95 of the last frame windows); **full** or `Positions`: `x`, `y`, `z` | the player sends one from the form, or the game calls `Glitchless.ReportBug()`. Off unless the game turns it on |

`device` in `session_start`:

| field | example | mode |
| --- | --- | --- |
| `browser`, `browser_version` | `Unity`, `6000.3.5f2`: the engine, the same for every player of a build | all |
| `os` | `iOS`; `SteamOS` on a Steam Deck running it (or one Steam started a Windows player on) | all |
| `mobile` | `true` | all |
| `device_tier` | `low` / `mid` / `high`, from core count and memory | all |
| `gpu_tier` | the same as `device_tier` on phones; `low` on a Steam Deck; on other desktops, from the GPU name | all |
| `renderer`, `driver` | `urp`, `Metal` | all |
| `screen`, `refresh_hz` | `[1290, 2796]`, `120`: `refresh_hz` is the screen's rate as the OS reports it, often its highest, not the rate the game ran at (that is each frame window's `hz`) | all |
| `steam_deck` | `true` on a Steam Deck, `false` elsewhere: Steam's `SteamDeck=1`, Valve's Jupiter or Galileo board, or SteamOS (read from `/sys/class/dmi/id/` and `/etc/os-release` in Linux players, and through Proton's `Z:` drive in Windows players; read on the device and not sent) | all |
| `model`, `os_version` | `iPhone16,1`, `iOS 27.1` | **full** |
| `gpu`, `gpu_vendor` | `Apple A17 Pro GPU`, `Apple` | **full** |
| `cores`, `memory_gb` | `6`, `8` | **full** |

**Error text.** Unity's messages come from the engine and the game's code, not from the player. Paths on the device are cut down before sending, in every mode: `persistentDataPath`, `temporaryCachePath`, `streamingAssetsPath` and `dataPath` become `persistent:`, `cache:`, `streaming:` and `data:`; `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` lose the name; iOS container IDs (made per install) become `<id>`. If the game puts anything of the player's into an exception message, a `Debug.LogError` or `Glitchless.Error()` attributes, it is sent. Don't.

**Game words.** `Track()` names and attributes, level names, scene names (sent as level names), death causes and gauges are whatever the game passes. Use the game's own words, never anything typed by or particular to the player.

## Steam facts

When the game already uses Steamworks.NET or Facepunch.Steamworks, `session_start`'s `device` also carries these, in every mode (`Runtime/SteamInfo.cs`). The SDK finds the wrapper by reflection, reads only once the game has initialised Steam itself (`SteamAPI.Init`, or `SteamClient.Init`), and reads nothing without one. A wrapper without a call leaves that field out (Facepunch has no Proton call, and only SDK 1.65 wrappers name the Steam hardware beyond a Deck).

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

## Bug reports: the player's own words

Bug reports are off until the game turns them on (`BugReports` in `GlitchlessOptions`, or its own button calling `Glitchless.ReportBug()`). A report is the one place the SDK sends text the player typed, and Glitchless sends the note as it is: it can't tell a bug description from a name, an email address, a phone number or anything else a player chooses to write. If your game turns reports on:

- say so in your game's privacy page (a paragraph is below): a report sends the player's note, a screenshot of the game and where they were;
- don't ask players for contact details in the note. If you want to reply to them, collect that with consent in your own UI;
- the screenshot is the game's own screen, but it shows whatever the game showed: a player's name or chat on screen goes with it;
- a report that can't be sent waits in `persistentDataPath/glitchless/outbox.json` until it can, like any batch;
- a developer who opens a report sees all of it. Treat reports like support email: when a player asks, delete their report with the Delete button on it in the dashboard (or `DELETE /v1/report?service=&id=`), which removes the note and the screenshot.

The form tells players what it sends ("your note, the screenshot and where you are in the game").

## Kept on the device

| file | what | mode |
| --- | --- | --- |
| `persistentDataPath/glitchless/outbox.json` | batches not yet sent (offline, or the app closed first): the events above, bug reports included, each with its own random batch ID (`b_…`, sent as `batch_id` so the server stores a batch once however often it arrives; it names the batch, never the player or the session). In anonymous mode, no session or player ID. Deleted once everything is sent. At most 4,000 events, none over 6 days old | all, not in WebGL builds |
| `persistentDataPath/glitchless/player_id` (WebGL: PlayerPrefs `glitchless.player_id`) | the random player ID | **install** and **full**. Anonymous mode deletes it if another build left one |
| `persistentDataPath/glitchless/launched` (WebGL: PlayerPrefs `glitchless.launched`) | the game's version string, the last one that ran, so the next launch can tell whether it is a version's first (`first_launch`). The same on every player's device of that version, so it ties nothing to anyone | all |

Uninstalling the game deletes them all (in WebGL, clearing the site's data does).

## Kept on the server

The open-source Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store reads back the last 14 days, though the files stay until deleted. The hosted service at glitchless.gg keeps them for as long as the plan says. Bug reports are kept apart from the events, each with its screenshot, and go when the game's events do.

If the server forwards to Datadog or an OpenTelemetry backend, that backend receives the same events, sent from the server, not the device. Bug reports are never forwarded.

## For the privacy page

A paragraph for anonymous mode, to adapt to the game's own voice:

> **Performance and error reports**
> So that we can find and fix stutters and bugs, the game measures how smoothly it runs and notes errors in its own code. Every few seconds, and when you leave the game, it sends these to our servers. A report says how long frames took, what was on screen (for example how many enemies), which level you were on and which of the game's events had just happened, along with the game's version and a few broad facts about the device: its system, whether it is a slower or faster model, its screen size and refresh rate. Reports from one launch share a random number made when the game starts. The number is never saved, so the next launch cannot be linked to it. The game notes on your device which of its versions last ran, so a report can say whether this is the first launch of a version (those start slower); that note holds nothing about you. Reports carry no player ID, no device identifier or model name, nothing you type and no location, and we do not keep the address they came from. They are deleted after *[30 days]*.

With `Positions = true`, add that reports include where in the game world deaths happened. Install mode needs one more sentence:

> The game also saves a random number on your device and sends it with every report, so that we can count how many players come back. It is not linked to your name, account or any other identifier, and deleting the game deletes it.

Full mode needs more than this: a random player ID saved on the device, the device model, and positions in the game world.

If the game ships on Steam and uses Steamworks, add:

> **Steam**
> On Steam, the reports also say which build and beta branch of the game you run, whether it runs on a Steam Deck or other Steam hardware, under Proton or in Big Picture mode, what kind of controller you use, the game's language, and whether you play through Family Sharing or a timed trial. They carry no Steam ID, account name or anything else from your Steam account.

If the game turns bug reports on, add:

> **Bug reports**
> If you send a bug report from the game, it sends what you typed, a picture of the game screen at that moment, the level you were on, what had just happened in the game and the same broad facts about the device. Please don't put personal details in it. Ask us and we will delete a report you sent.

## For the store forms

**App Store Connect → App Privacy.** Apple counts data as collected when it leaves the device and is kept, anonymous or not.

| Apple's type | from | anonymous mode | install mode | full mode |
| --- | --- | --- | --- | --- |
| Usage Data → Product Interaction | levels, deaths, `Track()` events | collected | collected | collected |
| Diagnostics → Performance Data | frame times, hitches, load times | collected | collected | collected |
| Diagnostics → Crash Data | uncaught exceptions | collected | collected | collected |
| Diagnostics → Other Diagnostic Data | errors, device tier, screen, engine counts | collected | collected | collected |
| Identifiers → Device ID | the random player ID | not collected | collected | collected |
| User Content → Customer Support | bug reports: the player's note and a screenshot of the game | collected if the game turns bug reports on | the same | the same |

For each type: **purposes** Analytics, and App Functionality if the reports are used to fix bugs; **linked to you** No in anonymous mode (there is no identifier and the session number is never saved), and in install and full mode the cautious answer is Yes; **used for tracking** No in every mode (the IDs are random, made by the game, and never shared with other apps or advertisers).

**Google Play → Data safety.**

| Google's type | anonymous mode | install mode | full mode |
| --- | --- | --- | --- |
| App activity → App interactions | collected | collected | collected |
| App info and performance → Crash logs, Diagnostics, Other app performance data | collected | collected | collected |
| Device or other IDs | not collected | collected (the random player ID) | collected (the random player ID) |
| App activity → Other user-generated content | collected if the game turns bug reports on (the note and screenshot) | the same | the same |

**Shared:** none, when the server is your own or the hosted service acting for you. **Encrypted in transit:** Yes, when the intake URL is `https://`. **Required or optional:** collection is required unless the game offers a setting; a toggle that skips `Glitchless.Init` (or passes `Enabled = false`) makes it optional.

## When this file must change

Read it again when any of these change: the events or fields in `GlitchlessCore.cs`, what the bug report form sends (`BugReports.cs`), the device fields in `DeviceInfo.cs`, the Steam facts in `SteamInfo.cs`, the counters in `GlitchlessRunner.cs`, what the server stores, or where it forwards. Then change the game's privacy page and store answers before the build that sends more is released.
