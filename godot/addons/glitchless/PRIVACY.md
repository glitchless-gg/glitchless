# What Glitchless for Godot sends

This file lists every field the Godot SDK sends in each mode, what it keeps on the device, and what a game's privacy page and store answers would need to say. It was written from `glitchless.gd` and `device.gd` and checked against what reached a local server in `npm run test:godot`. Keep it in step with those files.

Nothing here is legal advice. The store answers at the end are a reading of Apple's and Google's categories; check them against the forms as they are when you submit.

## The two modes

`Glitchless.init(..., {"privacy": "anonymous"})` is the default. `"full"` adds the fields marked **full** below.

| | anonymous | full |
| --- | --- | --- |
| Session ID | random, made at launch, **kept in memory only** | random, made at launch, saved with unsent batches until they go |
| Player ID | **none**. The server files each session under its session ID | random `p_…` made on first launch and saved in `user://glitchless/player_id`. Not tied to any account, device ID or advertising ID |
| Device | OS name, a low/mid/high tier, renderer, screen size, refresh rate | adds model, OS version, GPU name, core count, memory |
| Positions | **not sent**: deaths go without a place, no movement samples | death places and 4 Hz position samples, in game-world units |
| Saved on the device | unsent batches, without any ID | unsent batches with their IDs, and the player ID |

`positions: true` turns positions on in anonymous mode. They are places in the game's own world, not the player's location.

Neither mode reads or sends:

- a name, email, account, or anything the player types
- the advertising ID, Apple's identifier for vendors, or Android's ID
- contacts, location, locale, time zone, or the network address

The Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's logging settings.

## Field by field

Every batch sends the envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode), and `sdk` (`glitchless-godot/0.1.0`).

Every event has `type`, `ts` (when it happened, in milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `device` (below) | the first batch of a session |
| `session_end` | `reason` (`background`, `close`, `quit`), `duration_s` | going to the background, closing, quitting |
| `frame_window` | frame count, fps, refresh rate, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, average draw calls, primitives, render/process/physics ms, object/node/orphan-node/resource counts, video and texture MB, static MB (debug builds only), `screen` and `window` size in pixels, `ctx` (the game's gauges and engine counts) | every 5 s |
| `hitch` | duration, likely causes, draw calls, primitives, timings, pipeline compiles, nodes added, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms, at most 3 per window |
| `load` | `ttff_ms` (engine start to first frame), `ttp_ms` (to first touch or key) | once |
| `error` | `kind`, `message`, `stack` (script files, lines and functions), `source`, `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `Glitchless.error`), `recent` (the last 6 game event names) | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them | the game calls them |
| `death` | `cause`; **full** or `positions`: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `track()` | the game calls it |
| `custom` (by Glitchless) | `screen_change` {screen, window}, `app_resume` {away_s}, `rage_input` {key code or `pointer`, count; off on phones} | as they happen |
| `pos` | **full** or `positions`: `[time, x, y, z]` samples | every 5 s while positions are on |

`device` in `session_start`:

| field | example | mode |
| --- | --- | --- |
| `browser`, `browser_version` | `Godot`, `4.7.2`: the engine, the same for every player of a build | both |
| `os` | `iOS` | both |
| `mobile` | `true` | both |
| `device_tier` | `low` / `mid` / `high`, from core count and memory | both |
| `gpu_tier` | the same as `device_tier` on phones; on desktops, from the GPU name | both |
| `renderer`, `driver` | `mobile`, `metal` | both |
| `screen`, `dpr`, `refresh_hz` | `[1290, 2796]`, `3`, `120` | both |
| `model`, `os_version` | `iPhone16,1`, `27.1` | **full** |
| `gpu`, `gpu_vendor` | `Apple A17 Pro GPU`, `Apple` | **full** |
| `cores`, `memory_gb` | `6`, `8` | **full** |

The screen size is sent so that an iPhone Duo's open and closed states can be told apart. Many thousands of phones share each screen size, tier and OS.

**Error text.** Godot's error messages come from the engine and the game's code, not from the player. Paths on the device are cut down before sending: the user-data folder becomes `user://`, `/Users/<name>` and `C:\Users\<name>` lose the name, and iOS container IDs (made per install) become `<id>`. If the game puts anything of the player's into `push_error()` text or `Glitchless.error()` attributes, it is sent. Don't.

**Game words.** `track(event, what)`, level names, death causes and gauges are whatever the game passes. The rule from the games' `Metrics.count` carries over: the game's own words, never anything typed by or particular to the player.

## Kept on the device

| file | what | mode |
| --- | --- | --- |
| `user://glitchless/outbox.json` | batches not yet sent (offline, or the app closed first): the events above. In anonymous mode, no session or player ID. Deleted once everything is sent. At most 4,000 events, none over 6 days old | both |
| `user://glitchless/player_id` | the random player ID | **full**. Anonymous mode deletes it if a full-mode build left one |

Deleting the app deletes both.

## Kept on the server

The Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store reads back the last 14 days, though the files stay until deleted. The DynamoDB store sets a 30-day expiry on every item.

If the server forwards to Datadog (`DD_API_KEY` set), Datadog receives the same events as logs and metrics, sent from the server, not the phone. Datadog then acts as a service provider under its own terms and keeps them for as long as the Datadog plan keeps logs.

## For the privacy page

Linebreakers' and Starlift's pages (`site/privacy/index.html`) say today:

1. *"collects no personal information"*: **still true** in anonymous mode.
2. *"no third-party analytics or tracking software"*: still true of the game, since Glitchless is the owner's own code and server. If the server forwards to Datadog, name Datadog as a service provider.
3. *"Playing … sends nothing but the purchase check and the anonymous counts"*: **must change**. Performance and error reports go too.
4. *"A count carries no player ID, no device identifier and no time"*: still true of the counts, but **Glitchless reports carry times and a random session ID**, so they need their own paragraph.

A paragraph in the pages' own voice, for anonymous mode:

> **Performance and error reports**
> So that we can find and fix stutters and bugs, the game measures how smoothly it runs and notes errors in its own code. Every few seconds, and when you leave the game, it sends these to our servers. A report says how long frames took, what was on screen (for example how many blocks), which level you were on and which of the game's events had just happened, along with the game's version and a few broad facts about the device: its system, whether it is a slower or faster model, its screen size and refresh rate. Reports from one launch share a random number made when the game starts. The number is never saved, so the next launch cannot be linked to it. Reports carry no player ID, no device identifier or model name, nothing you type and no location, and we do not keep the address they came from. *[If the server forwards to Datadog: We use Datadog, a monitoring service, to store and chart them on our behalf.]* They are deleted after *[30 days]*.

Full mode would need more than this: a random player ID saved on the device, the device model, and positions in the game world.

## For the store forms

**App Store Connect → App Privacy.** Apple counts data as collected when it leaves the device and is kept, anonymous or not. Glitchless's reports match these types:

| Apple's type | from | anonymous mode | full mode |
| --- | --- | --- | --- |
| Usage Data → Product Interaction | levels, deaths, `track()` events | collected | collected |
| Diagnostics → Performance Data | frame times, hitches, load times | collected | collected |
| Diagnostics → Other Diagnostic Data | errors, device tier, screen, engine counts | collected | collected |
| Diagnostics → Crash Data | Glitchless sends no crash logs, but script errors that stop a function are close; listing it is the cautious answer | optional | optional |
| Identifiers → Device ID | the random player ID | not collected | collected |

For each type, Apple asks four things:

- **Purposes:** Analytics, and App Functionality if the reports are used to fix bugs.
- **Linked to you:** No in anonymous mode, since there is no identifier and the session number is never saved. In full mode, answer as Starlift's online player ID is answered; with a saved ID the cautious answer is Yes.
- **Used for tracking:** No in both modes.
- **Data Not Collected:** no longer an honest answer once Glitchless sends.

**Google Play → Data safety.**

| Google's type | anonymous mode | full mode |
| --- | --- | --- |
| App activity → App interactions | collected | collected |
| App info and performance → Crash logs (errors), Diagnostics (frame times, device tier), Other app performance data | collected | collected |
| Device or other IDs | not collected | collected (the random player ID) |

- **Shared:** none. Google doesn't count passing data to a service provider like Datadog as sharing.
- **Encrypted in transit:** Yes, when the intake URL is `https://`.
- **Required or optional:** collection is required, since there is no in-game switch. Adding a settings toggle that calls `init(..., {"enabled": false})` would make it optional.

## When this file must change

Read it again when any of these change:

- the events or fields in `glitchless.gd`
- the device fields in `device.gd`
- what the server stores (`server/src/ingest.js`, `server/src/stores/`)
- whether the server forwards to Datadog

Then change the game's privacy page and store answers before the build that sends more is released.
