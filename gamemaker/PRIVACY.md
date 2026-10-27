# What Glitchless for GameMaker sends

This file lists every field the GameMaker SDK sends in each mode, what it keeps on the device, and what a game's privacy page and store answers would need to say. It was written from `scripts/__glitchless_core`, `__glitchless_send`, `__glitchless_device`, `__glitchless_bug_report` and `__glitchless_play`, and checked against what reached a local server in `npm run test:gamemaker:core` and, from a real GameMaker build (runtime 2026.0.0.23), `npm run test:gamemaker`. Keep it in step with those files. The browser, Godot, Unity and Unreal SDKs have their own lists; the modes mean the same thing in all of them.

Nothing here is legal advice. The store answers at the end are a reading of Apple's, Google's and Valve's categories; check them against the forms as they are when you submit.

## The three modes

`glitchless_init(..., { privacy: "anonymous" })` is the default.

| | anonymous | install | full |
| --- | --- | --- | --- |
| Session ID | random, made at launch, **kept in memory only** | random, made at launch, saved with unsent batches until they go | the same as install |
| Player ID | **none**. The server files each session under its session ID | random `p_…` made on first launch and saved in `glitchless/player_id` in the save area, so returning players can be counted. Not tied to any account, platform ID or advertising ID | the same as install |
| Device | OS name, the runner (VM or YYC), the graphics API, screen size, refresh rate, a GPU tier where the runner names the GPU, whether it is a Steam Deck | the same as anonymous | adds the OS version, the GPU's name and vendor, and which Steam Deck |
| Positions | **not sent** unless `positions: true`: deaths go without a place, no movement samples | the same as anonymous | death places and 4 Hz position samples, in room coordinates |
| Saved on the device | unsent batches, without the session or player ID; the game version that last ran; the player's on or off choice, once the game asks | unsent batches with their IDs, the player ID, the game version that last ran, and the player's choice | the same as install |

`positions: true` turns positions on in anonymous and install mode. They are places in the game's own rooms, not the player's location.

No mode reads or sends:

- the computer's or phone's name, the user's account name (it is cut out of paths, below), or any hardware serial. `os_get_info()` is read for the GPU's name only; its `udid` is never sent
- the advertising ID, Apple's identifier for vendors, Android's ID, or a Steam or console account ID
- a name, email, account, or anything the player types, except the note in a bug report the player chooses to send
- contacts, location, locale, time zone, or the network address
- the address or host name of the game's own server, the internet provider, or the Wi-Fi network's name. Network samples (below) are the round trip, loss and jitter the game measured, nothing else

The Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's logging settings.

## Field by field

Every batch sends the envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode), `sdk` (`glitchless-gamemaker/0.4.0`) and `batch_id` (random, made for each batch and sent again with its retries, so the server stores it once).

Every event has `type`, `ts` (when it happened, in milliseconds, UTC) and `level` (the game's own level or room name, or null). While the game sets them, every event and frame window also carries `zone` (`glitchless_set_zone`: where the player is in an open world, in the game's words) and `match`, `party` and `run` (the group IDs below).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `privacy`, `device` (below), `props` (the [properties](#properties-the-games-words-about-the-session) set by then; none when there are none) | the first batch of a session |
| `session_end` | `reason` (`quit`, `measure`, `crash`), `duration_s` | quitting, the end of a measure run, a crash (sent on the next launch) |
| `frame_window` | frame count, fps, game speed, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, Step and draw ms, garbage collections and their ms, texture pages loaded, the runner's memory MB, the instance, surface, DS list, DS map and buffer counts, `screen` and `window` size in pixels, `ctx` (the game's gauges and the engine counts); while the game sends network samples, `net`: round-trip times as a sketch and percentiles, packet loss and jitter as the game measured them, how many samples, and `transport` (`gamemaker`, or the game's word for its networking). `in_kbps`, `out_kbps` and `link` are null and `host` is false | every 5 s |
| `hitch` | duration, likely causes (`gpu_or_os` when Step and draw time don't explain the frame), the same timings and counts for that one frame, instances added, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms, at most 3 per window |
| `load` | when the first frame was drawn, `ttff_ms` (game start to first frame), `first_launch` (whether this is the first launch of this game version on the device), `ttp_ms` (to the first key, click or gamepad button) | once |
| `error` | `kind` (`crash` or `manual`), `message`, `stack` (GameMaker's names for the code: objects, events, scripts, lines), `source`, `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `glitchless_error`), `recent` (the last 6 game event names) | each error, at most 25 of a kind per session; a crash is sent on the next launch |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them; `level_start` also when a room that reads as a level starts, and `attrs` (what the attempt is, in the game's words, as the game passes them: a difficulty, a mode, a party size) | the game calls them, or a room starts |
| `level_abandon` | `duration_s`; `reason` (`quit`, `measure`, `disconnect`) when Glitchless sends it | the game calls it, the game quits mid-level, or the connection drops mid-level |
| `death` | `cause`; **full** or `positions`: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `glitchless_track` | the game calls it |
| `counts` | `duration_s`, `dropped`, and `counts`: for each name and group the game counted with `glitchless_count`, its `name`, `attrs` (up to 4 of the game's words or true/false), `n` (how many), `sums` (up to 4 of the game's numbers, added up) and `first_ts` | once a window, when the game counted anything |
| `props` | `props`: the properties that changed since the last one (null for one removed) | at most once a window, when the game changes a property |
| `group` | `kind` (`match`, `party`, `run`), `id` (null when the group ends), `attrs` (as the game passes them), `resumed` (a run the game saved, resumed) | the game sets or ends a group |
| `disconnect` | `reason` (`timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect`, `other`), `connected_s`, and the last window's `rtt_p95` and `loss_pct` | the game calls `glitchless_disconnect`, at most 20 per session |
| `reconnect` | `after_s` | the game calls `glitchless_reconnect` after a disconnect |
| `custom` (by Glitchless) | `screen_change` {screen, window}, `app_resume` {away_s}, `rage_input` {key code or `pointer`, count; off on phones} | as they happen |
| `pos` | **full** or `positions`: `[time, x, y, z]` samples | every 5 s while positions are on |
| `bug_report` | `note` (what the player typed, up to 2,000 characters), `screenshot` (a PNG of the game's screen, its longer side at most 960 pixels), `recent` (the last 20 game events and hitches: when, which, and the few fields above that say what happened), `frames` (fps and p95 of the last frame windows), `device` (as in `session_start`, at the same mode); **full** or `positions`: `x`, `y`, `z` | only when the player sends one, or the game calls `glitchless_report_bug`; from every session, sampled or not. Off unless the game turns it on |

`device` in `session_start`:

| field | example | mode |
| --- | --- | --- |
| `browser`, `browser_version` | `GameMaker`, `2026.0.0.23`: the runtime, the same for every player of a build | all |
| `os` | `macOS`, `Windows`, `Linux`, `SteamOS` | all |
| `mobile` | `false` | all |
| `device_tier` | `unknown`: GameMaker can't read the core count or memory | all |
| `gpu_tier` | `low` / `mid` / `high`, from the GPU's name; `low` on phones and a Steam Deck | all |
| `steam_deck` | `false`: Steam's `SteamDeck=1`, a Valve Jupiter or Galileo board, or SteamOS in `/etc/os-release` | all |
| `renderer`, `driver` | `vm`, `OpenGL` | all |
| `screen`, `dpr`, `refresh_hz` | `[3024, 1964]`, null, `120` | all |
| `os_version` | `26.1.0` | **full** |
| `gpu`, `gpu_vendor` | `Apple M2 Pro`, `Apple` | **full** |
| `model` | `Steam Deck OLED` on a Steam Deck, null elsewhere: GameMaker doesn't say | **full** |
| `cores`, `memory_gb` | null: GameMaker doesn't say | **full** |

**Error text.** GameMaker's error messages come from the runner and the game's code, not from the player. Paths on the computer are cut down before sending, in every mode: the game's save folder becomes `save:/`, and `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` lose the name. If the game puts anything of the player's into an error message or `glitchless_error` attributes, it is sent. Don't.

**Game words.** `glitchless_track(name, what)`, `glitchless_count`, level and room names, level attributes, zones, death causes and gauges are whatever the game passes: the game's own words, never anything typed by or particular to the player. A list in an attribute (a deck, a build) holds the game's words too: never a list of people, such as party members' names or friends.

## Properties: the game's words about the session

A game can describe the session with `glitchless_set_properties` (or `properties` in the options), for example its mode, the player's rank tier or class, or the region of the game's servers. Properties go with the session in every mode, as event attributes do. They are checked before they are sent, and dropped (with a warning in a build run from the IDE) when they break a rule:

- keys are lower-case words of up to 32 characters, at most 12 a session, and not Glitchless's own splits (`version`, `level`, `zone`, `match`, `platform` and the like);
- keys that would say who the player is are dropped by name: `name`, `username`, `user`, `email`, `phone`, `user_id`, `account`, `account_id`, `player_id`, `steam_id`, `epic_id`, `psn_id`, `xbox_id`, `ip`, `address`, `device_id`, `idfa`, `gaid`, `ad_id`, `location`, `lat`, `lon`, `city`, `birthday`, `age` and `gender`;
- values are a word of up to 64 characters, true or false, or a whole number from -1,000,000 to 1,000,000; a fraction is dropped, so a level is sent as a band (`"30-39"`);
- values shaped like an email address, a link, a phone number or 7 digits in a row, a UUID, or a run of 16 characters of hex or base64 are dropped.

A property is not a player ID: in anonymous mode nothing ties one session's properties to another session. Properties are kept in memory only, never on the device; a new session in the same launch (back after the background timeout) starts with the ones still set.

## Groups

A game can mark the events of one match, party or run with an ID (`glitchless_set_group`). Match and party IDs are made by the game's servers for that match or party and shared by the players in it. They are never a player's account, guild or friends-list ID. They say that some sessions played together, not who played. They are hashed before they are sent, in every mode, with the game's name as the salt, so they can't be looked up in the game's own match logs; a game that turns `hash_group_ids` off to match them against its own server logs sends them as they are. Run IDs are made by the SDK and kept in memory. In anonymous mode, a run that goes on after the game restarts gets a new ID, so no ID ties two launches together; in install and full mode the game can resume a run under the ID it saved.

## Network quality

When the game passes its own ping to `glitchless_net_sample`, each frame window carries the round trip, packet loss and jitter, in every mode, like frame times: they describe the connection, not the person. `glitchless_disconnect` and `glitchless_reconnect` say when the connection dropped and came back, and why, in the words listed above. No address, host name or provider is ever read or sent.

## Bug reports: the player's own words

Bug reports are off until the game turns them on (`bug_reports` in the options of `glitchless_init`, or its own button calling `glitchless_report_bug`). A report is the one place the SDK sends text the player typed, and Glitchless sends the note as it is: it can't tell a bug description from a name, an email address, a phone number or anything else a player chooses to write. If your game turns reports on:

- say so in your game's privacy page (a paragraph is below): a report sends the player's note, a screenshot of the game and where they were;
- don't ask players for contact details in the note. If you want to reply to them, collect that with consent in your own UI;
- the screenshot is the game's own screen, but it shows whatever the game showed: a player's name or chat on screen goes with it;
- a report that can't be sent waits in `glitchless/outbox.json` until it can, like any batch;
- a developer who opens a report sees all of it. Treat reports like support email: when a player asks, delete their report with the Delete button on it in the dashboard (or `DELETE /v1/report?service=&id=`), which removes the note and the screenshot.

## Turned off by the player

A game can give players a setting that turns Glitchless off, and back on, with `glitchless_set_enabled` (README, "The player's off switch"). In every mode, once a player turns it off:

- nothing more is measured or sent, from that moment: no request of any kind goes out, not even the check of what the server takes, and the bug report form doesn't open;
- what was waiting to go is deleted: the events in memory and `glitchless/outbox.json`, bug reports in it included. A batch already on its way when the player turned it off may still arrive;
- the choice is saved (below) and read before anything else at the next launch, so a player who said no sends nothing at all from then on, until the game turns it back on.

With `opt_in: true`, nothing is measured, kept or sent on a device until the game calls `glitchless_set_enabled(true)`, for a game that asks the player first. What was sent before the player turned Glitchless off stays on the server for its retention; a player who wants it deleted asks the game's developer.

## Kept on the device

In the game's save area (`game_save_id`: `~/Library/Application Support/<game>` on macOS, `%LOCALAPPDATA%\<game>` on Windows, `~/.config/<game>` on Linux; a build run from the IDE uses the runner's, `~/Library/Application Support/com.yoyogames.macyoyorunner` on a Mac):

| file | what | mode |
| --- | --- | --- |
| `glitchless/outbox.json` | batches not yet sent (offline, the game closed first, or a crash): the events above, bug reports included, each with its own random batch ID (`b_…`, sent as `batch_id`; it names the batch, never the player or the session). In anonymous mode, no session or player ID. Deleted once everything is sent. At most 4,000 events, none over 6 days old | all |
| `glitchless/player_id` | the random player ID | **install** and **full**. Anonymous mode deletes it if another build left one |
| `glitchless/launched` | the game's version string, the last one that ran, so the next launch can tell whether it is a version's first (`first_launch`). The same on every player's device of that version, so it ties nothing to anyone | all |
| `glitchless/enabled` | `on` or `off`: the player's choice, written once the game calls `glitchless_set_enabled`, so a player who turned Glitchless off sends nothing from the start of every later launch. It holds nothing else, the same on every device that made the same choice, so it ties nothing to anyone. Never sent | all, once the game asks |
| `glitchless/measure.json` | the last `-glitchless-measure` result | only when run with that flag |

Uninstalling the game may leave the save area; deleting it removes them.

## Kept on the server

The Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store reads back the last 14 days, though the files stay until deleted. Glitchless Cloud keeps them for the plan's retention. Bug reports are kept apart from the events, each with its screenshot, and go when the game's events do; Datadog and OpenTelemetry forwarding never sends them.

## For the privacy page

A paragraph for anonymous mode:

> **Performance and error reports**
> So that we can find and fix stutters and bugs, the game measures how smoothly it runs and notes errors in its own code. Every few seconds, and when you quit, it sends these to our servers. A report says how long frames took, what was on screen (for example how many enemies), which level you were on and which of the game's events had just happened, along with the game's version and a few broad facts about the computer: its system, its screen size and refresh rate, and how fast its graphics chip is. Reports from one launch share a random number made when the game starts. The number is never saved, so the next launch cannot be linked to it. The game notes on your computer which of its versions last ran, so a report can say whether this is the first launch of a version (those start slower); that note holds nothing about you. Reports carry no player ID, no device identifier, nothing you type and no location, and we do not keep the address they came from. They are deleted after *[30 days]*.

If the game has the setting (`glitchless_set_enabled`), add:

> You can turn these reports off at any time in the game's settings (*[Settings → Share performance data]*). From then on nothing more is sent, and reports still waiting on your computer are deleted. The game remembers your choice, and nothing else, so it stays off the next time you play.

If the game sets properties, groups or network samples, add:

> The reports also say what you were doing in the game in the game's own terms, such as the mode, your rank tier or class, the server region you play on, which match or party you played in (as a scrambled number the match's players share), and how quickly the game's servers answered. They never say who you are.

Install mode needs one more sentence: a random number is saved with the game, so we can tell how many players come back; it is not linked to your account. Full mode needs that, the graphics chip's name, and positions in the game world.

If the game turns bug reports on, add:

> **Bug reports**
> If you send a bug report from the game, it sends what you typed, a picture of the game screen at that moment, the level you were on, what had just happened in the game and the same broad facts about the computer. Please don't put personal details in it. Ask us and we will delete a report you sent.

## For the store forms

**App Store Connect → App Privacy** (a Mac or iOS build):

| Apple's type | from | anonymous | install, full |
| --- | --- | --- | --- |
| Usage Data → Product Interaction | levels, deaths, `glitchless_track` and `glitchless_count` events, properties, groups | collected | collected |
| Diagnostics → Performance Data | frame times, hitches, load times, network round trips and disconnects | collected | collected |
| Diagnostics → Crash Data | crashes, sent on the next launch | collected | collected |
| Diagnostics → Other Diagnostic Data | errors, device facts, engine counts | collected | collected |
| Identifiers → Device ID | the random player ID | not collected | collected |
| User Content → Customer Support | bug reports: the player's note and a screenshot | collected if the game turns bug reports on | the same |

For each type: **purposes** Analytics, and App Functionality if the reports are used to fix bugs; **linked to you** No in anonymous mode (there is no identifier and the session number is never saved), and in install and full mode the cautious answer is Yes; **used for tracking** No in every mode.

**Google Play → Data safety** (an Android build):

| Google's type | anonymous | install, full |
| --- | --- | --- |
| App activity → App interactions | collected | collected |
| App info and performance → Crash logs, Diagnostics, Other app performance data | collected | collected |
| Device or other IDs | not collected | collected (the random player ID) |
| App activity → Other user-generated content | collected if the game turns bug reports on | the same |

**Shared:** none (a service provider such as Datadog isn't sharing). **Encrypted in transit:** Yes, when the intake URL is `https://`. **Required or optional:** optional, when the game has a settings toggle wired to `glitchless_set_enabled` (players can turn collection off, and with `opt_in: true` nothing is collected until they say yes); required without one.

**Steam.** Valve's store page has no data form, but its rules ask a game that collects data to say so: the privacy paragraph above, linked from the store page, covers it.

## When this file must change

Read it again when any of these change:

- the events or fields in `__glitchless_core`, `__glitchless_send`, `__glitchless_bug_report` or `__glitchless_play`
- the device fields in `__glitchless_device`
- what the server stores (`server/src/ingest.js`, `server/src/stores/`)
- whether the server forwards to Datadog

Then change the game's privacy page and store answers before the build that sends more is released.
