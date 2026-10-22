# What Glitchless for the web sends

This file lists every field the browser SDK sends in each privacy mode and what it keeps in the browser, so a game's privacy page can say the same. It was written from `src/core.js`, `src/device.js` and the engine adapters (`src/three.js`, `src/phaser.js`); keep it in step with them. The Godot and Unity SDKs have their own lists in `godot/addons/glitchless/PRIVACY.md` and `unity/Packages/gg.glitchless.sdk/PRIVACY.md`, and the two modes mean the same thing in all three.

Nothing here is legal advice.

## The two modes

`Glitchless.init({ privacy: 'anonymous' })` is the default. `privacy: 'full'` adds the fields marked **full**.

| | anonymous | full |
| --- | --- | --- |
| Session ID | random, made per page load, **kept in memory only** | the same |
| Player ID | **none**. The server files each session under its session ID. A `glitchless.pid` left in localStorage by a full-mode build is deleted | random `p_…`, stored in localStorage as `glitchless.pid`. Not tied to any account or advertising ID |
| Device | browser and its major version, OS, phone or not, GPU tier (low/mid/high), WebGL version, screen size, pixel ratio | adds the full browser version, the GPU renderer and vendor strings, CPU core count and device memory |
| Positions | **not sent**: deaths go without a place, no movement samples | death places and 4 Hz position samples, in game-world units |
| Error text | URLs in messages and stacks lose their query strings and fragments | sent as captured |

`positions: true` turns positions on in anonymous mode. They are places in the game's own world, not the player's location.

In both modes:

- the page is sent as origin and path only (no query string), and the referrer as its origin only;
- nothing typed by the player, no names, emails or accounts, and no cookies;
- the Glitchless server does not read or store the address a request came from. The host it runs on may log it, so check that host's settings.

The GPU renderer string sent in full mode helps tell slow devices apart, but it is also one of the inputs browsers treat as fingerprintable. Anonymous mode sends only the tier.

## Field by field

Every batch has an envelope: `service`, `env`, `version` (the game's), `session_id`, `player_id` (null in anonymous mode) and `sdk`. Every event has `type`, `ts` (milliseconds, UTC) and `level` (the game's own level name, or null).

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user` or `synthetic`), `privacy`, `device` (above), `page`, `nav_ms`; with the Phaser adapter, `engine` (`phaser`, its version and renderer: the same for every player of a build) | the first batch |
| `session_end` | `reason`, `duration_s` | page hidden or closed |
| `frame_window` | frames, fps, refresh rate and budget, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, render ms, update ms (Phaser), draw calls, triangles, geometry/texture/shader counts, JS heap MB, `ctx` (the game's gauges; with Phaser also object, body, tween, listener and sound counts) | every 5 s, sent in batches every 15 s |
| `hitch` | duration, likely causes (Long Animation Frame script attribution, shader compile, GC, asset load; with Phaser also scene change, object spawn, texture upload, update or render time), draw calls, `ctx`, `recent` (names of the game events in the last 1.5 s) | a frame over 50 ms and over twice the recent median, at most 3 per window |
| `load` | time to first frame, asset load timings | once |
| `error` | `kind`, `message`, `stack`, `source` (file name), `line`, `col`, `fn`, `fingerprint`, `attrs` (what the game passes to `glitchless.error`; for errors an adapter reports, engine counts, the Phaser scene key or how long the loop stalled). The server builds breadcrumbs from the session's earlier events | each error, at most 25 of a kind per session |
| `level_start` / `level_complete` / `level_fail` | `duration_s`, `score`, `cause`, as the game passes them | the game calls them |
| `death` | `cause`; with positions on: `x`, `y`, `z` | the game calls it |
| `custom` | `name`, `attrs`: the game's own words via `glitchless.track()`; also `rage_input` (a key code and count) from the SDK | as they happen |
| `pos` | `[time, x, y, z]` samples | with positions on, in each batch |
| `map` | an orthographic thumbnail of a level, rendered from the scene by `glitchless.captureMap()` | the game calls it |

**Game words.** Event names, attributes, level names, causes and gauges are whatever the game passes. Use the game's own words, never anything typed by or particular to the player.

## Kept in the browser

| key | what | mode |
| --- | --- | --- |
| `glitchless.overlay` (localStorage) | whether the developer overlay is open | both, only when the overlay runs (off by default when `env` is `prod`) |
| `glitchless.pid` (localStorage) | the random player ID | **full** |

Unsent batches are held in memory only, and are dropped if the page closes before they can be sent.

## The Datadog bridge

`datadog: {…}` loads Datadog's own RUM SDK, which collects its own data under Datadog's terms. It is off by default, and nothing above covers it.
