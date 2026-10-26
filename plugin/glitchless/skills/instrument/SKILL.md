---
name: instrument
description: Add Glitchless observability to a game (Three.js or React Three Fiber, Phaser 3 or 4, Babylon.js, PlayCanvas, Unity 6.3+, Godot 4.5+, Unreal Engine 5.8 or GameMaker 2024.2+). Frame-time percentiles, hitch attribution, errors, gameplay events, level heatmaps, and tools that let coding agents measure the running game. Use when the user wants telemetry, analytics, performance monitoring or "observability" in a game, or asks to add Glitchless.
---

# Instrument a game with Glitchless

Goal: after this skill, every play session reports how the game *felt* (frame times, hitches and their causes),
what broke (errors, crashes) and what the player did (levels, deaths, pickups, positions), and you (the agent)
have a way to measure the running game before and after a change.

## 0. Find the engine, and the settings

| You find | Engine | Follow |
| --- | --- | --- |
| `three` or `@react-three/fiber` in package.json | Three.js | [references/threejs.md](references/threejs.md) |
| `phaser` in package.json, or a `<script>` that loads Phaser | Phaser 3.60+ or 4 | [references/phaser.md](references/phaser.md) |
| `@babylonjs/core` or `babylonjs` in package.json, or a `<script>` that loads Babylon.js | Babylon.js 5+ | [references/babylon.md](references/babylon.md) |
| `playcanvas` in package.json, a PlayCanvas Editor project (scripts using `pc.createScript` or `pc.Script`), or a `<script>` that loads PlayCanvas | PlayCanvas 2.x | [references/playcanvas.md](references/playcanvas.md) |
| `ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json` | Unity 6.3+ | [references/unity.md](references/unity.md) |
| `project.godot` | Godot 4.5+ | the Godot addon's README: `godot/addons/glitchless/README.md` in the Glitchless repo (`~/.glitchless/godot/addons/glitchless/README.md` if it's cloned there), then [references/godot.md](references/godot.md) for bug reports, streams, properties and multiplayer |
| a `*.uproject` file | Unreal Engine 5.8 (5.7 untested) | [references/unreal.md](references/unreal.md) |
| a `*.yyp` file | GameMaker 2024.2+ | [references/gamemaker.md](references/gamemaker.md) |

Read only the file for this game's engine: each one walks through reading the game, installing,
levels and events, bots and measuring, and checking it works. Apply these settings first.

Settings, for every engine:

- **Intake URL and client token.** If the user gave you them (a hosted Glitchless server prints both, for example
  `Send telemetry to https://api.example.com with client token gl_pub_…`), use those. Otherwise use
  `http://localhost:7777` and `gl_pub_dev`, a local server. On Glitchless Cloud with no token yet, sign the MCP
  server in (`glitchless_sign_in`, or `npx -y glitchless-mcp login`; the user approves a code) and call
  `glitchless_create_game`: it returns the game's client token and intake URL. The client token is public and
  write-only, so it may live in the game's source. A secret or workspace key (`gl_sk_…`, `gl_ws_…`) never goes in
  the game.
- **Privacy.** Keep the default anonymous mode: no player ID, coarse device facts, no positions. Ask the user
  before choosing another mode, since the game's privacy policy and store answers must then say so (each SDK's
  PRIVACY.md lists every field and has the wording). If they want to know whether players come back (retention:
  D1, D7, D30), offer install mode: it adds only a random player ID kept on the device (`privacy: 'install'`;
  Godot `"privacy": "install"`; Unity `Privacy = Privacy.Install`; Unreal `Privacy=Install`). Anonymous mode
  can't count returning players. Full mode adds a stored player ID, device detail and positions.
- **Bots.** Sessions from autoplay bots and tests must be marked synthetic, so they stay out of player numbers.
- **Testers.** On iOS the Godot, Unity and Unreal SDKs tell a TestFlight install from an App Store one themselves
  (`distribution` in the device fields) and mark its sessions `tester`, out of player numbers, even though a
  TestFlight build is a release build that reports `prod`. Don't pass a session type that would undo this. On
  Android, Google Play's testing tracks can't be told apart on the device: if the developer ships test builds there,
  give the testing-track build its own env (`beta`) from a build flag.
- **Version.** Find where the game's version lives and pass it; bump it on every release so Glitchless can compare versions.

## Every engine: the game's own metrics, and its board

Games differ: a puzzle game cares about solve time and hints, a mobile game about opens, modes, the paywall and
purchases, a platformer about where players die. Glitchless doesn't assume a genre, so this part is yours.

1. Find the moments this game's designer would want counted, and send each with `track`: one event name per
   moment, plus one word or a few attributes about it. Never anything about the player.
   - Three.js or Phaser: `glitchless.track('play', { mode: 'endless' })`
   - Godot: `Glitchless.track("play", "endless")` (one word becomes the attribute `what`) or a dictionary
   - Unity: `Glitchless.Track("play", "endless");` or a `Dictionary<string, object>`
   - Unreal: `FGlitchless::Track(TEXT("play"), TEXT("endless"));` (the attribute `what`) or a `TMap` of attributes
     and one of numbers; in Blueprint, Track Event (What) or Track Event
   - GameMaker: `glitchless_track("play", "endless");` (the attribute `what`) or a struct

   Good candidates: the game opening (with the edition, free or full), a mode or run starting, a run ending and
   how, shop and paywall views and where they were opened, purchases started and finished, hints, choices that
   matter (difficulty), shares and rating prompts. Levels, stages and puzzles go through levelStart,
   levelComplete and levelFail, not `track`. Attributes are strings, numbers, booleans or lists of them, at most 12
   per event.

   Send them in the shape boards can measure:
   - **An outcome as a boolean**: `won: true`, `picked: true`, `top: true`, so a board can give its rate by hero,
     weapon or banner, with how sure it is. A word (`result: 'win'`) works too, and can go next to the boolean.
     Unreal: until its attributes take booleans, send the outcome as 1 or 0 in the numbers map; rates read both alike.
   - **An amount as a number**: `duration_s: 184`, `wait_s: 41`, `placement: 17`, `floor: 14`, never `"3:04"`.
     Boards give its median, its p90 and a histogram, and its average.
   - **What a match or run used as a list**: `deck: ['hog_rider', 'fireball']`, `items: [...]`, `boons: [...]`. Each
     element counts (the first 16), so a board shows "decks with each card" and their win rate. A list holds the
     game's words, never people (party members' names, friends).
   - **One event at the end of each match or run** with its outcome and numbers (`match_end`, `run_end`,
     `battle_end`), not one per hit: rates and distributions split by another attribute read a session's first 16
     of an event.
   - **Bands, not exact values, for what describes the player**: `level_band: '30-39'`, `trophy_band: '3000-3499'`.

   ```js
   glitchless.track('match_end', { hero: 'ember', won: true, duration_s: 1930, items: ['boots', 'blink', 'bkb'] });
   ```

   And four calls for what `track` shouldn't carry (each engine's reference has its spelling):
   - **Track a moment, count a stream.** Anything that happens many times a second (shots, hits, kills, gold and XP
     pickups, taps) goes through `count(name, attrs, n)`: the SDK adds it up per 5-second window (up to 4 words to
     group by, up to 4 numbers summed: `count('gold', { source: 'loot', amount: 35 })`) and sends one `counts` event,
     so the queue never fills with them. Boards read a counter by its name like any event. A `track` per hit would
     push frame windows out of the queue.
   - **Properties: what holds for the session.** `setProperties({ rank: 'gold', class: 'druid', region: 'eu' })` where
     the game learns it (after sign-in, at the menu, at matchmaking); every board then splits and filters by it
     (`$rank`). Bands and the game's words only, at most 12 keys, set again each session: never a name, an account or
     device ID, an email, an exact level or amount (the SDKs and the server drop keys like `user_id` and values shaped
     like an ID). They go in every privacy mode, so the game's privacy page should mention them (each PRIVACY.md has
     the paragraph). What changes from match to match (hero, deck, map) goes on the event or the level start.
   - **Level attributes.** `levelStart('nmd_ghoa', { tier: 'pit_80', party_size: 3 })`: what describes the attempt,
     so boards show clears and wipes by tier, group size or build. The outcome after it needs nothing more.
   - **Groups and zones.** `setGroup('match', id)` with the match ID the game's server made, the same on every
     player and on the server (the SDKs hash it the same way before sending it, by default); `setGroup('match', null)`
     ends it. `setGroup('party', id)` for a party (never a guild or friends list), `setGroup('run')` for a roguelite
     run (the SDK makes its ID). `setZone(name)` for where the player is in an open world (an MMO zone, a room): not a
     level, it never ends in a win or a fail.

   Purchases have one convention in every engine, so boards can add them up into revenue: a `purchase` event
   when the store confirms it, with `amount` (a number in the currency's units: 4.99, not 499), `currency` (the
   ISO code the store charged in) and `item`. A game has one currency on its boards; purchases in another are
   listed as left out, not added in. Never send receipts, order ids or payment details. A free test purchase
   (TestFlight, Xcode, a Play licence tester) is not revenue: the engine SDKs add `sandbox: true` to purchases in a
   TestFlight or development install on iOS by themselves, and where the game's billing library says a purchase is
   a sandbox one (RevenueCat's `isSandbox`, on Android too) pass `sandbox: true` yourself. Boards count those
   purchases but never add them into revenue.
   - Web games (Three.js, Phaser, Babylon.js, PlayCanvas): `glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })`
   - Godot: `Glitchless.track("purchase", {"amount": 4.99, "currency": "USD", "item": "gems_500"})`
   - Unity: `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" });`
   - Unreal: `FGlitchless::Track(TEXT("purchase"), {{TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}}, {{TEXT("amount"), 4.99}});`
     (in Blueprint, Track Event with `amount` in Numbers)
2. A multiplayer game also reports its network, and its dedicated servers (follow the engine reference's
   multiplayer section):
   - **Ping, loss and disconnects.** The Unity SDK reads Netcode for GameObjects and Mirror by itself, Godot its
     MultiplayerAPI with ENet or WebSocket, Unreal its own net driver; a web game passes its ping with
     `netSample({ rtt_ms })` about once a second (or `instrumentNet` for WebRTC), GameMaker with
     `glitchless_net_sample`, and any engine on another library (Steam Networking Sockets, Photon, Nakama, a game's
     own) the same way. Call `disconnect({ reason })` when the connection drops and `reconnect()` when it comes back,
     where the netcode doesn't say: a disconnect ends a level attempt as an abandon, never a fail. Nothing about the
     other end is sent (no addresses).
   - **Server mode.** A dedicated or authoritative server runs the SDK as a server: `glitchless/server` on a Node
     server (with `instrumentWs`, `instrumentSocketIO` or `glitchlessRoom` for Colyseus), the Unity and Godot SDKs in a
     dedicated-server build (or `--glitchless-server`), the Unreal plugin on a dedicated server. It sends its tick time
     against its tick rate, players connected, CPU, memory and crashes, never anything about players, and Glitchless
     keeps it apart from players under `<game>.server`. It uses the game's own service and client token, and sets
     the same match groups as its players. It needs a Glitchless server that lists `server_mode` in `GET /v1/health`
     (any current one does) and sends nothing to an older one.
3. Once events arrive, design the game's own dashboard: follow the `dashboard` skill (next to this one), which
   turns the developer's questions into collectors, panels and pages and saves them with the
   `glitchless_set_dashboard` MCP tool.

## Report

Tell the user what you wired (with file:line), the gauges you chose and why, the events you track and count, the
properties and groups you set, the netcode and server mode you wired for a multiplayer game, and the board you
designed, the agent tools or measure commands you set up, and anything you weren't sure about.
