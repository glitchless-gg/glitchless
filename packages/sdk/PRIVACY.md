# What Glitchless for the web sends

This file lists every field the browser SDK sends in each privacy mode and what it keeps in the browser, so a game's privacy page can say the same. It was written from `src/core.js`, `src/device.js`, `src/bugreport.js` and the engine adapters (`src/three.js`, `src/phaser.js`, `src/babylon.js`, `src/playcanvas.js`); keep it in step with them. The Godot, Unity and Unreal SDKs have their own lists (`godot/addons/glitchless/PRIVACY.md`, `unity/Packages/gg.glitchless.sdk/PRIVACY.md`, `unreal/Plugins/Glitchless/PRIVACY.md`), and the modes mean the same thing in all of them (`docs/SPEC.md` §4b).

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
- the Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's settings.

The GPU renderer string sent in full mode helps tell slow devices apart, but it is also one of the inputs browsers treat as fingerprintable. Anonymous and install mode send only the tier, and `steam_deck: true` when the renderer string is a Steam Deck's (the browser reads the string to work these out, and doesn't send it).

## Field by field

Every batch has an envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode, the stored player ID in install and full mode) and `sdk`. Every event has `type`, `ts` (milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `privacy` (`anonymous`, `install` or `full`), `device` (above; `steam_deck: true` only on a Steam Deck, with `gpu_tier` `low`), `page`, `nav_ms`; with the Phaser, Babylon.js or PlayCanvas adapter, `engine` (`phaser`, `babylon` or `playcanvas`, its version and renderer: the same for every player of a build) | the first batch |
| `session_end` | `reason`, `duration_s` | page hidden or closed |
| `frame_window` | frames, fps, refresh rate and budget, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, render ms, update ms (Phaser, Babylon.js, PlayCanvas), draw calls, triangles, geometry/texture/shader counts, JS heap MB, `ctx` (the game's gauges; with Phaser also object, body, tween, listener and sound counts; with Babylon.js mesh, material, texture, particle and observer counts; with PlayCanvas entity, mesh instance, material, texture and light counts) | every 5 s, sent in batches every 15 s |
| `hitch` | duration, likely causes (Long Animation Frame script attribution, shader compile, GC, asset load; with Phaser, Babylon.js and PlayCanvas also scene change, object spawn, texture or geometry upload, update or render time, and what the frame compiled, added or uploaded), draw calls, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms and over twice the recent median, at most 3 per window |
| `load` | time to first frame, asset load timings | once |
| `error` | `kind`, `message`, `stack`, `source` (file name), `line`, `col`, `fn`, `fingerprint`, `attrs` (what the game passes to `glitchless.error`; for errors an adapter reports, engine counts, the Phaser scene key, how long the loop stalled, a shader compiler's message, or a PlayCanvas script's name and method). The server builds breadcrumbs from the session's earlier events | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them | the game calls them |
| `death` | `cause`; with positions on: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `glitchless.track()`; also `rage_input` (a key code and count) from the SDK | as they happen |
| `pos` | `[time, x, y, z]` samples | with positions on, in each batch |
| `map` | an orthographic thumbnail of a level, rendered from the scene by `glitchless.captureMap()` | the game calls it |
| `bug_report` | `note` (what the player typed), `screenshot` (a JPEG of the game's canvas, not of the rest of the page), `device` (the same fields as `session_start`, at the same mode), `recent` (the last 20 game events and hitches, as above), `frames` (fps and p95 of the last frame windows); with positions on: `x`, `y`, `z` | the player sends one from the form, or the game calls `glitchless.reportBug()`. Off unless the game turns it on |

**Game words.** Event names, attributes, level names, causes and gauges are whatever the game passes. Use the game's own words, never anything typed by or particular to the player.

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

## The Datadog bridge

`datadog: {…}` loads Datadog's own RUM SDK, which collects its own data under Datadog's terms. It is off by default, and nothing above covers it.
