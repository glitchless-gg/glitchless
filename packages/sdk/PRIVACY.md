# What Glitchless for the web sends

This file lists every field the browser SDK sends in each privacy mode and what it keeps in the browser, so a game's privacy page can say the same. It was written from `src/core.js`, `src/device.js`, `src/steam.js`, `src/bugreport.js`, `src/props.js`, `src/groups.js`, `src/counts.js`, `src/net.js`, the engine adapters (`src/three.js`, `src/phaser.js`, `src/babylon.js`, `src/playcanvas.js`) and, for game servers, `src/server.js`; keep it in step with them. The Godot, Unity and Unreal SDKs have their own lists (`godot/addons/glitchless/PRIVACY.md`, `unity/Packages/gg.glitchless.sdk/PRIVACY.md`, `unreal/Plugins/Glitchless/PRIVACY.md`), and the modes mean the same thing in all of them (`docs/SPEC.md` §4b).

Nothing here is legal advice.

## The three modes

`Glitchless.init({ privacy: 'anonymous' })` is the default. `privacy: 'install'` adds a stored player ID, so the game can see how many players come back (retention). `privacy: 'full'` adds that and the fields marked **full**.

| | anonymous | install | full |
| --- | --- | --- | --- |
| Session ID | random, made per page load, **kept in memory only** | the same | the same |
| Player ID | **none**. The server files each session under its session ID. A `glitchless.pid` left in localStorage by an install- or full-mode build is deleted | random `p_…`, made on the first load and stored in localStorage as `glitchless.pid`. Not tied to any account or advertising ID | the same ID as install mode |
| Device | browser and its major version, OS, phone or not, GPU tier (low/mid/high), WebGL version, screen size, pixel ratio, and whether it is a Steam Deck | the same as anonymous | adds the full browser version, the GPU renderer and vendor strings, CPU core count and device memory |
| Positions | **not sent**: deaths go without a place, no movement samples | the same as anonymous | death places and 4 Hz position samples, in game-world units |
| Error text | URLs in messages and stacks lose their query strings and fragments | the same as anonymous | sent as captured |

**What install mode adds to anonymous mode:** one thing, the player ID. It goes in every batch as `player_id` and stays in localStorage, so the next visit from the same browser sends the same ID. Everything else is sent exactly as in anonymous mode. Install and full mode share the stored ID. `glitchless.resetInstallId()` deletes it: the page keeps sending the ID it started with until it closes, and the next page load makes a new one, which nothing links to the old one. If localStorage is blocked (some private windows), the ID lasts one page load.

`positions: true` turns positions on in anonymous and install mode. They are places in the game's own world, not the player's location.

In every mode:

- the page is sent as origin and path only (no query string), and the referrer as its origin only;
- nothing typed by the player (except a bug report's note, below), no names, emails or accounts, and no cookies;
- the session's properties, groups and network quality, when the game uses them (below): they describe the session and the connection, never the person;
- the Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's settings.

The GPU renderer string sent in full mode helps tell slow devices apart, but it is also one of the inputs browsers treat as fingerprintable. Anonymous and install mode send only the tier, and `steam_deck: true` when the renderer string is a Steam Deck's (the browser reads the string to work these out, and doesn't send it).

## Field by field

Every batch has an envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode, the stored player ID in install and full mode), `sdk` and `batch_id` (random, made for each batch and sent again with its retries, so the server stores it once). Every event has `type`, `ts` (milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `privacy` (`anonymous`, `install` or `full`), `device` (above; `steam_deck: true` only on a Steam Deck, with `gpu_tier` `low`), `page`, `nav_ms`; with the Phaser, Babylon.js or PlayCanvas adapter, `engine` (`phaser`, `babylon` or `playcanvas`, its version and renderer: the same for every player of a build); `props`, the properties the game set (below) | the first batch |
| `session_end` | `reason`, `duration_s` | page hidden or closed |
| `frame_window` | frames, fps, refresh rate and budget, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, render ms, update ms (Phaser, Babylon.js, PlayCanvas), draw calls, triangles, geometry/texture/shader counts, JS heap MB, `ctx` (the game's gauges; with Phaser also object, body, tween, listener and sound counts; with Babylon.js mesh, material, texture, particle and observer counts; with PlayCanvas entity, mesh instance, material, texture and light counts); `net` while a multiplayer game is connected ([Network quality](#network-quality)) | every 5 s, sent in batches every 15 s |
| `hitch` | duration, likely causes (Long Animation Frame script attribution, shader compile, GC, asset load, `gpu_or_os` where the browser reports long animation frames and the stall wasn't one; with Phaser, Babylon.js and PlayCanvas also scene change, object spawn, texture or geometry upload, update or render time, and what the frame compiled, added or uploaded), draw calls, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms and over twice the recent median, at most 3 per window |
| `load` | time to first frame (stamped when it was drawn), asset load timings | once |
| `error` | `kind`, `message`, `stack`, `source` (file name), `line`, `col`, `fn`, `fingerprint`, `attrs` (what the game passes to `glitchless.error`; for errors an adapter reports, engine counts, the Phaser scene key, how long the loop stalled, a shader compiler's message, or a PlayCanvas script's name and method). The server builds breadcrumbs from the session's earlier events | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them; `level_start` also `attrs`, the attempt's attributes in the game's words (`tier`, `party_size`, a list of skills) | the game calls them |
| `level_abandon` | `duration_s`; `reason` (`pagehide`, or `disconnect` after `disconnect()`) when the SDK sends it | the game calls `levelAbandon()`, the page goes away mid-level, or the connection drops mid-level |
| `death` | `cause`; with positions on: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `glitchless.track()`; also `rage_input` (a key code and count) from the SDK | as they happen |
| `counts` | per name and group: `name`, `attrs` (up to 4 strings or booleans), `n` (how many), `sums` (up to 4 numbers added up), `first_ts`; `dropped`, `duration_s`: the game's own words via `glitchless.count()` | each 5 s window that counted anything |
| `props` | `props`: the properties that changed, `null` for one removed (below) | at most once a window, when the game changes them |
| `group` | `kind` (`match`, `party` or `run`), `id` (hashed, or made by the SDK; below), `attrs` in the game's words, `resumed` | the game calls `setGroup()` |
| `disconnect` / `reconnect` | `reason` (`timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect`, `other`), `connected_s`, `rtt_p95`, `loss_pct` / `after_s` | the game calls them, or a WebRTC connection handed to `instrumentNet()` fails and comes back |
| `pos` | `[time, x, y, z]` samples | with positions on, in each batch |
| `map` | an orthographic thumbnail of a level, rendered from the scene by `glitchless.captureMap()` | the game calls it |
| `bug_report` | `note` (what the player typed), `screenshot` (a JPEG of the game's canvas, not of the rest of the page), `device` (the same fields as `session_start`, at the same mode), `recent` (the last 20 game events and hitches, as above), `frames` (fps and p95 of the last frame windows); with positions on: `x`, `y`, `z` | the player sends one from the form, or the game calls `glitchless.reportBug()`. Off unless the game turns it on |

**Game words.** Event names, attributes, level names, zones, causes and gauges are whatever the game passes. Use the game's own words, never anything typed by or particular to the player. A list attribute (a deck, a build) holds the game's words too: never a list of people, such as party members' names or friends.

**Fields on every event.** Besides `level`, events and windows carry `zone` (where the player is in an open world, in the game's words) and `match`, `party` and `run` (below) while the game has set them.

## Properties: the game's words about the session

A game can describe the session with `setProperties`, for example its mode, the player's rank tier or class, or the region of the game's servers. Properties go with the session in every mode, as event attributes do, and the SDK keeps nothing between sessions. They are checked before they are sent (`src/props.js`): keys such as `email`, `user_id` or `steam_id`, and values that look like an email address, a phone number, an ID or a link, are dropped. Values are short words, booleans or whole numbers, at most 12 keys a session. A property is not a player ID: in anonymous mode nothing ties one session's properties to another session.

## Groups

A game can mark the events of one match, party or run with an ID. Match and party IDs are made by the game's servers for that match or party and shared by the players in it. They are never a player's account, guild or friends-list ID. They say that some sessions played together, not who played. The SDK hashes them before sending (the first 24 hex characters of SHA-1 of the game's name and the ID), so they can't be looked up as they are in the game's own match logs; a game can turn that off (`hashGroupIds: false`) to match them against its own server logs. Run IDs are made by the SDK. In anonymous mode, a run that goes on after the game restarts gets a new ID, so no ID ties two launches together.

## Network quality

In a multiplayer game, frame windows carry `net` while the game is connected: round-trip times (a sketch, percentiles and the highest), packet loss, jitter and throughput, the number of samples, the networking library's name, whether this player hosts the game, and `link`, the kind of connection (`wifi`, `cellular` or `wired`) where the browser says (Chrome on Android), else null. It goes in every mode, like frame times: it describes the connection, not the person. Never sent: IP addresses, the server's address or host name, the ISP, the Wi-Fi network's name, or where the player is. `instrumentNet()` reads a WebRTC connection's statistics, which list addresses; it reads only the round trip, bytes, packets and jitter from them.

For the game's privacy page, a paragraph to adapt:

> **Multiplayer and what you play**
> The reports also say what you were doing in the game in the game's own terms, such as the mode, your rank tier or class, and the server region you play on, which matches and parties you played in (by an ID the game made for that match, not for you), and how good your connection to the game was: its delay, lost packets and whether it dropped. They never say who you are, and never carry your IP address or where you are.

## Steam facts

When an Electron game passes its steamworks.js client as `steam` (what `steamworks.init()` returned), `session_start`'s `device` also carries these, in every mode (`src/steam.js`). Nothing is read from Steam otherwise: the SDK never loads or looks for steamworks.js itself. steamworks.js has no calls for Family Sharing, timed trials, Proton or Steam hardware beyond a Deck, so those are left out.

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

For the game's privacy page, a paragraph to adapt:

> **Steam**
> On Steam, the reports also say which build and beta branch of the game you run, whether it runs on a Steam Deck or other Steam hardware, under Proton or in Big Picture mode, what kind of controller you use, the game's language, and whether you play through Family Sharing or a timed trial. They carry no Steam ID, account name or anything else from your Steam account.

## Bug reports: the player's own words

Bug reports are off until the game turns them on (`bugReports` in `Glitchless.init`, or its own button calling
`glitchless.reportBug()`). A report is the one place the SDK sends text the player typed, and Glitchless sends the note
as it is: it can't tell a bug description from a name, an email address, a phone number or anything else a player
chooses to write. If your game turns reports on:

- say so in your game's privacy page: a report sends the player's note, a screenshot of the game and where they were;
- don't ask players for contact details in the note. If you want to reply to them, collect that with consent in your own UI;
- the screenshot is the game's canvas only, but it shows whatever the game showed: a player's name or chat on screen goes with it;
- a developer who opens a report sees all of it. Treat reports like support email: when a player asks, delete their
  report with the Delete button on it in the dashboard (or `DELETE /v1/report?service=&id=`), which removes the note
  and the screenshot.

The form tells players what it sends ("your note, the screenshot and where you are in the game").

## Kept in the browser

| key | what | mode |
| --- | --- | --- |
| `glitchless.overlay` (localStorage) | whether the developer overlay is open | all, only when the overlay runs (off by default when `env` is `prod`) |
| `glitchless.pid` (localStorage) | the random player ID | **install** and **full**. Anonymous mode deletes it |

Unsent batches are held in memory only, and are dropped if the page closes before they can be sent.

## Server mode (`glitchless/server`)

A Node game server that uses `glitchless/server` sends nothing about players but how many are connected (`players`, `players_max`) and their round trips as the server sees them (`rtt_p95`): no player IDs, account IDs, names, chat or IP addresses. About itself it sends its OS, CPU core count, memory, process CPU and memory use, and the region the game names (`eu-west`), never its IP address or host name. Its batches carry `role: "server"` and no player ID, and are kept apart from players' sessions under the game's companion service. Errors keep their stack, with query strings and the user and password of connection strings removed. When it can't send as the process dies, the last batches wait in a file in the system's temporary folder (`crashDir`) until the next start; no player data is in them.

## The Datadog bridge

`datadog: {…}` loads Datadog's own RUM SDK, which collects its own data under Datadog's terms. It is off by default, and nothing above covers it.
