# What Glitchless for Unity sends

This file lists every field the Unity SDK sends in each mode, what it keeps on the device, and what a game's privacy page and store answers would need to say. It was written from `Runtime/GlitchlessCore.cs`, `Runtime/DeviceInfo.cs` and `Runtime/GlitchlessRunner.cs`, and checked against what reached a local server in `npm run test:unity`. Keep it in step with those files. The browser and Godot SDKs have their own lists, and the two modes mean the same thing in all three.

Nothing here is legal advice. The store answers at the end are a reading of Apple's and Google's categories; check them against the forms as they are when you submit.

## The two modes

`Privacy = Privacy.Anonymous` is the default. `Privacy.Full` adds the fields marked **full** below.

| | anonymous | full |
| --- | --- | --- |
| Session ID | random, made at launch, **kept in memory only** | random, made at launch, saved with unsent batches until they go |
| Player ID | **none**. The server files each session under its session ID | random `p_…` made on first launch and saved in `persistentDataPath/glitchless/player_id`. Not tied to any account, device ID or advertising ID |
| Device | OS name, a low/mid/high tier, render pipeline and graphics API, screen size, refresh rate | adds model, OS version, GPU name and vendor, core count, memory |
| Positions | **not sent** unless `Positions = true`: deaths go without a place, no movement samples | death places and 4 Hz position samples, in game-world units |
| Saved on the device | unsent batches, without any ID | unsent batches with their IDs, and the player ID |

`Positions = true` turns positions on in anonymous mode. They are places in the game's own world, not the player's location.

Neither mode reads or sends:

- `SystemInfo.deviceUniqueIdentifier` or `SystemInfo.deviceName` (which is often the owner's name, as in "Sam's iPhone")
- the advertising ID, Apple's identifier for vendors, or Android's ID
- a name, email, account, or anything the player types
- contacts, location, locale, time zone, or the network address

The Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's logging settings.

## Field by field

Every batch sends the envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode), and `sdk` (`glitchless-unity/0.1.0`).

Every event has `type`, `ts` (when it happened, in milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `privacy`, `device` (below) | the first batch of a session |
| `session_end` | `reason` (`background`, `quit`, `measure`), `duration_s` | going to the background on a phone, quitting |
| `frame_window` | frame count, fps, refresh rate, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, update/physics/render/GPU ms, draw calls, SetPass calls, batches, triangles, GC collections, GC heap and system memory MB; in development builds also mesh, material, texture, object and GameObject counts and allocation per frame; `screen` and `window` size in pixels, `ctx` (the game's gauges and the engine counts) | every 5 s |
| `hitch` | duration, likely causes, the same timings and counts for that one frame, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms, at most 3 per window |
| `load` | `ttff_ms` (app start to first frame), `ttp_ms` (to first touch or key) | once |
| `error` | `kind`, `message`, `stack` (function names, script file paths inside the project, lines), `source`, `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `Glitchless.Error`), `recent` (the last 6 game event names) | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them; `level_start` also when a scene that is a level becomes active | the game calls them, or a scene loads |
| `death` | `cause`; **full** or `Positions`: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `Track()` | the game calls it |
| `custom` (by Glitchless) | `screen_change` {screen, window}, `app_resume` {away_s}, `rage_input` {key name or `pointer`, count; off on phones} | as they happen |
| `pos` | **full** or `Positions`: `[time, x, y, z]` samples | every 5 s while positions are on |

`device` in `session_start`:

| field | example | mode |
| --- | --- | --- |
| `browser`, `browser_version` | `Unity`, `6000.3.5f2`: the engine, the same for every player of a build | both |
| `os` | `iOS` | both |
| `mobile` | `true` | both |
| `device_tier` | `low` / `mid` / `high`, from core count and memory | both |
| `gpu_tier` | the same as `device_tier` on phones; on desktops, from the GPU name | both |
| `renderer`, `driver` | `urp`, `Metal` | both |
| `screen`, `refresh_hz` | `[1290, 2796]`, `120` | both |
| `model`, `os_version` | `iPhone16,1`, `iOS 27.1` | **full** |
| `gpu`, `gpu_vendor` | `Apple A17 Pro GPU`, `Apple` | **full** |
| `cores`, `memory_gb` | `6`, `8` | **full** |

**Error text.** Unity's messages come from the engine and the game's code, not from the player. Paths on the device are cut down before sending, in both modes: `persistentDataPath`, `temporaryCachePath`, `streamingAssetsPath` and `dataPath` become `persistent:`, `cache:`, `streaming:` and `data:`; `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` lose the name; iOS container IDs (made per install) become `<id>`. If the game puts anything of the player's into an exception message, a `Debug.LogError` or `Glitchless.Error()` attributes, it is sent. Don't.

**Game words.** `Track()` names and attributes, level names, scene names (sent as level names), death causes and gauges are whatever the game passes. Use the game's own words, never anything typed by or particular to the player.

## Kept on the device

| file | what | mode |
| --- | --- | --- |
| `persistentDataPath/glitchless/outbox.json` | batches not yet sent (offline, or the app closed first): the events above. In anonymous mode, no session or player ID. Deleted once everything is sent. At most 4,000 events, none over 6 days old | both, not in WebGL builds |
| `persistentDataPath/glitchless/player_id` | the random player ID | **full**. Anonymous mode deletes it if a full-mode build left one |

Uninstalling the game deletes both.

## Kept on the server

The open-source Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store reads back the last 14 days, though the files stay until deleted. The DynamoDB store sets a 30-day expiry on every item. The hosted service at glitchless.gg keeps them for as long as the plan says.

If the server forwards to Datadog or an OpenTelemetry backend, that backend receives the same events, sent from the server, not the device.

## For the privacy page

A paragraph for anonymous mode, to adapt to the game's own voice:

> **Performance and error reports**
> So that we can find and fix stutters and bugs, the game measures how smoothly it runs and notes errors in its own code. Every few seconds, and when you leave the game, it sends these to our servers. A report says how long frames took, what was on screen (for example how many enemies), which level you were on and which of the game's events had just happened, along with the game's version and a few broad facts about the device: its system, whether it is a slower or faster model, its screen size and refresh rate. Reports from one launch share a random number made when the game starts. The number is never saved, so the next launch cannot be linked to it. Reports carry no player ID, no device identifier or model name, nothing you type and no location, and we do not keep the address they came from. They are deleted after *[30 days]*.

With `Positions = true`, add that reports include where in the game world deaths happened. Full mode needs more than this: a random player ID saved on the device, the device model, and positions in the game world.

## For the store forms

**App Store Connect → App Privacy.** Apple counts data as collected when it leaves the device and is kept, anonymous or not.

| Apple's type | from | anonymous mode | full mode |
| --- | --- | --- | --- |
| Usage Data → Product Interaction | levels, deaths, `Track()` events | collected | collected |
| Diagnostics → Performance Data | frame times, hitches, load times | collected | collected |
| Diagnostics → Crash Data | uncaught exceptions | collected | collected |
| Diagnostics → Other Diagnostic Data | errors, device tier, screen, engine counts | collected | collected |
| Identifiers → Device ID | the random player ID | not collected | collected |

For each type: **purposes** Analytics, and App Functionality if the reports are used to fix bugs; **linked to you** No in anonymous mode (there is no identifier and the session number is never saved), and in full mode the cautious answer is Yes; **used for tracking** No in both modes.

**Google Play → Data safety.**

| Google's type | anonymous mode | full mode |
| --- | --- | --- |
| App activity → App interactions | collected | collected |
| App info and performance → Crash logs, Diagnostics, Other app performance data | collected | collected |
| Device or other IDs | not collected | collected (the random player ID) |

**Shared:** none, when the server is your own or the hosted service acting for you. **Encrypted in transit:** Yes, when the intake URL is `https://`. **Required or optional:** collection is required unless the game offers a setting; a toggle that skips `Glitchless.Init` (or passes `Enabled = false`) makes it optional.

## When this file must change

Read it again when any of these change: the events or fields in `GlitchlessCore.cs`, the device fields in `DeviceInfo.cs`, the counters in `GlitchlessRunner.cs`, what the server stores, or where it forwards. Then change the game's privacy page and store answers before the build that sends more is released.
