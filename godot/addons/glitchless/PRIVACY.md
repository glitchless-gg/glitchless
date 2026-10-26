# What Glitchless for Godot sends

This file lists every field the Godot SDK sends in each mode, what it keeps on the device, and what a game's privacy page and store answers would need to say. It was written from `glitchless.gd`, `device.gd`, `steam.gd`, `bug_report.gd`, `properties.gd` and `net.gd` and checked against what reached a local server (and, for the multiplayer additions, a test intake) in `npm run test:godot`. Keep it in step with those files.

Nothing here is legal advice. The store answers at the end are a reading of Apple's and Google's categories; check them against the forms as they are when you submit.

## The three modes

`Glitchless.init(..., {"privacy": "anonymous"})` is the default. `"install"` adds a saved player ID, so the game can see how many players come back (retention). `"full"` adds that and the fields marked **full** below. The modes are the same in every Glitchless SDK (`docs/SPEC.md` §4b).

| | anonymous | install | full |
| --- | --- | --- | --- |
| Session ID | random, made at launch, **kept in memory only** | random, made at launch, saved with unsent batches until they go | the same as install |
| Player ID | **none**. The server files each session under its session ID | random `p_…` made on first launch and saved in `user://glitchless/player_id`. Not tied to any account, device ID or advertising ID | the same ID as install mode |
| Device | OS name, a low/mid/high tier, renderer, screen size, refresh rate, whether it is a Steam Deck, and on iOS whether it came from the App Store or TestFlight | the same as anonymous | adds model, OS version, GPU name, core count, memory |
| Positions | **not sent**: deaths go without a place, no movement samples | the same as anonymous | death places and 4 Hz position samples, in game-world units |
| Saved on the device | unsent batches, without the session or player ID; the game version that last ran | unsent batches with their IDs, the player ID, and the game version that last ran | the same as install mode |

**What install mode adds to anonymous mode:** the player ID, sent in every batch as `player_id` and kept in `user://glitchless/player_id`, so the next launch sends the same ID; and, because that ID is on the device anyway, unsent batches are saved with their session and player IDs. Everything else is sent exactly as in anonymous mode. Install and full mode share the saved ID; anonymous mode deletes one another build left. `Glitchless.reset_install_id()` deletes it: the session in progress keeps sending the ID it started with, and the next launch makes a new one, which nothing links to the old one.

`positions: true` turns positions on in anonymous and install mode. They are places in the game's own world, not the player's location.

Every mode reads one Android system setting, `firebase.test.lab`: Google Play's pre-launch report sets it on Google's test phones, and a session there is marked `synthetic` (a bot's) so it stays out of the players' numbers. The setting itself is not sent.

On iOS, every mode looks for three files to tell a TestFlight install from an App Store one: the App Store receipt (`StoreKit/receipt` in the app's own data container, which Apple writes with every App Store install), the sandbox receipt (`StoreKit/sandboxReceipt`, written by a purchase in a TestFlight or development build) and the provisioning profile a development build carries in its bundle (`embedded.mobileprovision`). It only checks whether they are there and never reads them, so nothing about the Apple account, the purchase or the device is taken. The answer is sent as `distribution` (`app_store`, `testflight` or `development`); a TestFlight or development session is marked `tester` so it stays out of the players' numbers, and a purchase made there says `sandbox: true`, as Apple charged nothing for it.

No mode reads or sends:

- a name, email, account, or anything the player types (except a bug report's note, below)
- the advertising ID, Apple's identifier for vendors, or Android's ID
- contacts, location, locale, time zone, or the network address
- in a multiplayer game: an IP address, the game server's address or host name, the internet provider, the Wi-Fi network's name, or other players' names or IDs

The Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's logging settings.

## Field by field

Every batch sends the envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode, the saved player ID in install and full mode), `sdk` (`glitchless-godot/0.2.0`) and `batch_id` (random, made for each batch and sent again with its retries).

Every event has `type`, `ts` (when it happened, in milliseconds, UTC) and `level` (the game's own level name, or null). While the game has set them, every event and window also carries `zone` (where the player is in an open world, in the game's words) and `match`, `party` or `run` (the [group](#groups) IDs).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user`, `tester` for TestFlight and development installs on iOS, or `synthetic`), `privacy` (`anonymous`, `install` or `full`), `device` (below), `props` (the game's [properties](#properties-the-games-words-about-the-session), when it set any) | the first batch of a session |
| `session_end` | `reason` (`background`, `close`, `quit`), `duration_s` | going to the background, closing, quitting |
| `frame_window` | frame count, fps, the refresh rate measured from the frames (`hz`), frame-time sketch and percentiles, slow/jank/hitch/frozen counts, average draw calls, primitives, render/process/physics ms, object/node/orphan-node/resource counts, video and texture MB, static MB (debug builds only), `screen` and `window` size in pixels, `ctx` (the game's gauges and engine counts); while connected to a game server, `net` ([network quality](#network-quality)) | every 5 s |
| `hitch` | duration, likely causes (`gpu_or_os` when the time went outside what the SDK measures in the game), draw calls, primitives, timings, pipeline compiles, nodes added, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms, at most 3 per window |
| `load` | when the first frame was drawn, `ttff_ms` (engine start to first frame), `first_launch` (whether this is the first launch of this game version on the device), `ttp_ms` (to first touch or key) | once |
| `error` | `kind`, `message`, `stack` (script files, lines and functions), `source`, `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `Glitchless.error`), `recent` (the last 6 game event names) | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, and `level_start`'s `attrs` (the attempt in the game's words, such as difficulty and party size), as the game passes them | the game calls them |
| `level_abandon` | `duration_s`; `reason` (`background`, `close`, `quit`, `disconnect`) when Glitchless sends it | the game calls it, or the game goes to the background, closes or loses its connection mid-level |
| `death` | `cause`; **full** or `positions`: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `track()`; in a TestFlight or development install on iOS a purchase (an event named `purchase`, or any with a `currency`) also gets `sandbox: true` | the game calls it |
| `counts` | `counts` (for each name and its words: `name`, `attrs`, `n` how many, `sums` of its numbers, `first_ts`), `duration_s`, `dropped`: the game's own words via `count()`, added up on the device | once a window that counted anything |
| `props` | `props`: the [properties](#properties-the-games-words-about-the-session) that changed, null for one removed | at most once a window, when the game changed one |
| `group` | `kind` (`match`, `party`, `run`), `id` (hashed for a match or party, null when it ends), `attrs` (the game's words), `resumed` | the game sets or ends a [group](#groups) |
| `disconnect` | `reason` (`timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect`, `other`), `connected_s`, `rtt_p95`, `loss_pct` | the connection to the game's server drops, at most 20 a session |
| `reconnect` | `after_s` | connected again within 5 minutes |
| `server_window` | a [dedicated server](#server-mode)'s physics ticks: their count, a tick-time sketch and percentiles, the budget and the ticks over it, the tick rate reached, `players` (a count) and `players_max`, the players' round trips (`rtt_p95`), kbps in and out, memory and CPU use, `ctx` | every 5 s, from a dedicated server only |
| `custom` (by Glitchless) | `screen_change` {screen, window}, `app_resume` {away_s}, `rage_input` {key code or `pointer`, count; off on phones} | as they happen |
| `pos` | **full** or `positions`: `[time, x, y, z]` samples | every 5 s while positions are on |
| `bug_report` | `note` (what the player typed), `screenshot` (a JPEG of the game's window as it was last drawn), `device` (the same fields as `session_start`, in the same mode), `recent` (the last 20 game events and hitches: when, which, and the few fields above that say what happened), `frames` (fps and p95 of the last frame windows); **full** or `positions`: `x`, `y`, `z` | the player sends one from the form, or the game calls `Glitchless.report_bug()`. Off unless the game turns it on |

`device` in `session_start`:

| field | example | mode |
| --- | --- | --- |
| `browser`, `browser_version` | `Godot`, `4.7.2`: the engine, the same for every player of a build | all |
| `os` | `iOS`; `SteamOS` on a Steam Deck running it (or one Steam started a Windows build on) | all |
| `mobile` | `true` | all |
| `device_tier` | `low` / `mid` / `high`, from core count and memory | all |
| `gpu_tier` | the same as `device_tier` on phones; `low` on a Steam Deck; on other desktops, from the GPU name | all |
| `renderer`, `driver` | `mobile`, `metal` | all |
| `screen`, `dpr`, `refresh_hz` | `[1290, 2796]`, `3`, `120`: `refresh_hz` is the screen's rate as the OS reports it, its highest, not the rate the game ran at (that is each frame window's `hz`) | all |
| `steam_deck` | `true` on a Steam Deck, `false` elsewhere: Steam's `SteamDeck=1`, Valve's Jupiter or Galileo board, or SteamOS (read from `/sys/class/dmi/id/` and `/etc/os-release` on Linux, and through Proton's `Z:` drive on Windows; read on the device and not sent) | all |
| `distribution` | iOS only: `app_store`, `testflight` (TestFlight, and App Review) or `development` (Xcode, ad hoc, the Simulator), from whether the receipts and profile above are there; left out when it can't tell | all |
| `model`, `os_version` | `iPhone16,1`, `27.1` | **full** |
| `gpu`, `gpu_vendor` | `Apple A17 Pro GPU`, `Apple` | **full** |
| `cores`, `memory_gb` | `6`, `8` | **full** |

The screen size is sent so that an iPhone Duo's open and closed states can be told apart. Many thousands of phones share each screen size, tier and OS.

**Error text.** Godot's error messages come from the engine and the game's code, not from the player. Paths on the device are cut down before sending: the user-data folder becomes `user://`, `/Users/<name>` and `C:\Users\<name>` lose the name, and iOS container IDs (made per install) become `<id>`. If the game puts anything of the player's into `push_error()` text or `Glitchless.error()` attributes, it is sent. Don't.

**Game words.** `track(event, what)`, level names, death causes and gauges are whatever the game passes. The rule from the games' `Metrics.count` carries over: the game's own words, never anything typed by or particular to the player.

## Properties: the game's words about the session

A game can describe the session with `set_properties`, for example its mode, the player's rank tier or class, the input they use, or the region of the game's servers. Properties go with the session in every mode, in `session_start` and in a `props` event when one changes, as event attributes do. They are checked before they are sent (`properties.gd`): keys such as `email`, `user_id`, `name`, `steam_id`, `age` or `gender`, and values that look like an email address, a phone number or a long number, an ID (a UUID, or a long run of hex or base64) or a link, are dropped. Values are short words, booleans or whole numbers; free text and fractions are not taken. A property is not a player ID: in anonymous mode nothing ties one session's properties to another session, and nothing is kept on the device. Glitchless's server drops the same shapes again, and treats a property with more than 200 values in a day as an ID.

## Groups

A game can mark the events of one match, party or run with an ID. Match and party IDs are made by the game's servers for that match or party and shared by the players in it. They are never a player's account, guild or friends-list ID. Glitchless sends them hashed (SHA-1 with the game's name), so they say that some sessions played together but can't be looked up in the game's own logs; a game can turn the hash off (`hash_group_ids: false`) to match them against its own server's logs. Run IDs are made by the SDK. In anonymous mode, a run that goes on after the game restarts gets a new ID, so no ID ties two launches together.

## Network quality

In a multiplayer game on Godot's MultiplayerAPI, every mode sends how the connection to the game's server behaved, as it sends frame times: the round trip (ping), its jitter, packet loss, how much was sent and received, the kind of transport (`enet`, `websocket`), whether this player hosts the game, and disconnects with their reason. It describes the connection, not the person. Never sent: IP addresses, the server's address or host name, the internet provider, the Wi-Fi network's name, or where the player is. `link` (Wi-Fi or mobile data) is always null: Godot can't tell.

## Server mode

A dedicated server (a dedicated-server export, or run with `--server`) sends nothing about players: no player IDs, account IDs, names, chat or IP addresses. `players` is a count, and their round trips are numbers the server measured. About itself it sends its OS, core count and memory, its tick times, its memory use and CPU, and its region in the game's own words, never its IP address or host name. Its envelope says `role: "server"` with no player ID, its device is sent as in anonymous mode, and it sends no positions and no bug reports.

## Steam facts

When the game already uses GodotSteam (the `Steam` singleton), `session_start`'s `device` also carries these, in every mode (`steam.gd`). The SDK reads only once GodotSteam says Steam is initialised (`steamInitEx()`, initialising from the Project Settings, or `steamInit()` with an app ID), and reads nothing without it. A GodotSteam without a call leaves that field out (Steam hardware beyond a Deck, and Proton, need GodotSteam 4.21).

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

Bug reports are off until the game turns them on (`"bug_reports"` in the options of `Glitchless.init`, or its own button calling `Glitchless.report_bug()`). A report is the one place the SDK sends text the player typed, and Glitchless sends the note as it is: it can't tell a bug description from a name, an email address, a phone number or anything else a player chooses to write. If your game turns reports on:

- say so in your game's privacy page (a paragraph is below): a report sends the player's note, a screenshot of the game and where they were;
- don't ask players for contact details in the note. If you want to reply to them, collect that with consent in your own UI;
- the screenshot is the game's own window, but it shows whatever the game showed: a player's name or chat on screen goes with it;
- a report that can't be sent waits in `user://glitchless/outbox.json` until it can, like any batch;
- a developer who opens a report sees all of it. Treat reports like support email: when a player asks, delete their report with the Delete button on it in the dashboard (or `DELETE /v1/report?service=&id=`), which removes the note and the screenshot.

The form tells players what it sends ("your note, the screenshot and where you are in the game").

## Kept on the device

| file | what | mode |
| --- | --- | --- |
| `user://glitchless/outbox.json` | batches not yet sent (offline, or the app closed first): the events above, bug reports included, each with its own random batch ID (`b_…`, sent as `batch_id` so the server stores a batch once however often it arrives; it names the batch, never the player or the session). In anonymous mode, no session or player ID. Deleted once everything is sent. At most 4,000 events, none over 6 days old | all |
| `user://glitchless/player_id` | the random player ID | **install** and **full**. Anonymous mode deletes it if another build left one |
| `user://glitchless/server_outbox.json` | a dedicated server's batches not yet sent, kept apart from a player build's: the [server mode](#server-mode) events, with no player ID | a dedicated server |
| `user://glitchless/launched` | the game's version string, the last one that ran, so the next launch can tell whether it is a version's first (`first_launch`). The same on every player's device of that version, so it ties nothing to anyone | all |

Deleting the app deletes them all.

## Kept on the server

The Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store reads back the last 14 days, though the files stay until deleted. Glitchless Cloud keeps them for the plan's retention. Bug reports are kept apart from the events, each with its screenshot, and go when the game's events do; Datadog and OpenTelemetry forwarding never sends them.

If the server forwards to Datadog (`DD_API_KEY` set), Datadog receives the same events as logs and metrics, sent from the server, not the phone. Datadog then acts as a service provider under its own terms and keeps them for as long as the Datadog plan keeps logs.

## For the privacy page

Linebreakers' and Starlift's pages (`site/privacy/index.html`) say today:

1. *"collects no personal information"*: **still true** in anonymous mode.
2. *"no third-party analytics or tracking software"*: still true of the game, since Glitchless is the owner's own code and server. If the server forwards to Datadog, name Datadog as a service provider.
3. *"Playing … sends nothing but the purchase check and the anonymous counts"*: **must change**. Performance and error reports go too.
4. *"A count carries no player ID, no device identifier and no time"*: still true of the counts, but **Glitchless reports carry times and a random session ID**, so they need their own paragraph.

A paragraph in the pages' own voice, for anonymous mode:

> **Performance and error reports**
> So that we can find and fix stutters and bugs, the game measures how smoothly it runs and notes errors in its own code. Every few seconds, and when you leave the game, it sends these to our servers. A report says how long frames took, what was on screen (for example how many blocks), which level you were on and which of the game's events had just happened, along with the game's version and a few broad facts about the device: its system, whether it is a slower or faster model, its screen size and refresh rate. Reports from one launch share a random number made when the game starts. The number is never saved, so the next launch cannot be linked to it. The game notes on your device which of its versions last ran, so a report can say whether this is the first launch of a version (those start slower); that note holds nothing about you. Reports carry no player ID, no device identifier or model name, nothing you type and no location, and we do not keep the address they came from. *[If the server forwards to Datadog: We use Datadog, a monitoring service, to store and chart them on our behalf.]* They are deleted after *[30 days]*.

Install mode needs one more sentence:

> The game also saves a random number on your device and sends it with every report, so that we can count how many players come back. It is not linked to your name, account or any other identifier, and deleting the game deletes it.

Full mode would need more than this: a random player ID saved on the device, the device model, and positions in the game world.

If the game ships on Steam and uses Steamworks, add:

> **Steam**
> On Steam, the reports also say which build and beta branch of the game you run, whether it runs on a Steam Deck or other Steam hardware, under Proton or in Big Picture mode, what kind of controller you use, the game's language, and whether you play through Family Sharing or a timed trial. They carry no Steam ID, account name or anything else from your Steam account.

If the game is played online, add:

> **Multiplayer**
> In online matches, the reports also say how the connection to our servers behaved (its delay, lost data and dropped connections), which match they belong to (as a code our servers made for the match, not linked to your account), and what you were doing in the game's own terms, such as the mode, your rank tier or class, and the server region you play on. They never say who you are, and carry no IP address.

If the game turns bug reports on, add:

> **Bug reports**
> If you send a bug report from the game, it sends what you typed, a picture of the game screen at that moment, the level you were on, what had just happened in the game and the same broad facts about the device. Please don't put personal details in it. Ask us and we will delete a report you sent.

## For the store forms

**App Store Connect → App Privacy.** Apple counts data as collected when it leaves the device and is kept, anonymous or not. Glitchless's reports match these types:

| Apple's type | from | anonymous mode | install mode | full mode |
| --- | --- | --- | --- | --- |
| Usage Data → Product Interaction | levels, deaths, `track()` and `count()` events, properties, match and party groups | collected | collected | collected |
| Diagnostics → Performance Data | frame times, hitches, load times, and in a multiplayer game ping, packet loss and disconnects | collected | collected | collected |
| Diagnostics → Other Diagnostic Data | errors, device tier, screen, engine counts | collected | collected | collected |
| Diagnostics → Crash Data | Glitchless sends no crash logs, but script errors that stop a function are close; listing it is the cautious answer | optional | optional | optional |
| Identifiers → Device ID | the random player ID | not collected | collected | collected |
| User Content → Customer Support | bug reports: the player's note and a screenshot of the game | collected if the game turns bug reports on | the same | the same |

For each type, Apple asks four things:

- **Purposes:** Analytics, and App Functionality if the reports are used to fix bugs.
- **Linked to you:** No in anonymous mode, since there is no identifier and the session number is never saved. In install and full mode, answer as Starlift's online player ID is answered; with a saved ID the cautious answer is Yes.
- **Used for tracking:** No in every mode: the IDs are random, made by the game, and never shared with other apps or advertisers.
- **Data Not Collected:** no longer an honest answer once Glitchless sends.

**Google Play → Data safety.**

| Google's type | anonymous mode | install mode | full mode |
| --- | --- | --- | --- |
| App activity → App interactions | collected | collected | collected |
| App info and performance → Crash logs (errors), Diagnostics (frame times, device tier), Other app performance data | collected | collected | collected |
| Device or other IDs | not collected | collected (the random player ID) | collected (the random player ID) |
| App activity → Other user-generated content | collected if the game turns bug reports on (the note and screenshot) | the same | the same |

- **Shared:** none. Google doesn't count passing data to a service provider like Datadog as sharing.
- **Encrypted in transit:** Yes, when the intake URL is `https://`.
- **Required or optional:** collection is required, since there is no in-game switch. Adding a settings toggle that calls `init(..., {"enabled": false})` would make it optional.

## When this file must change

Read it again when any of these change:

- the events or fields in `glitchless.gd`, or what the bug report form sends (`bug_report.gd`)
- the property checks in `properties.gd`, or what `net.gd` reads from the game's networking
- the device fields in `device.gd`, or the Steam facts in `steam.gd`
- what the server stores (`server/src/ingest.js`, `server/src/stores/`)
- whether the server forwards to Datadog

Then change the game's privacy page and store answers before the build that sends more is released.
