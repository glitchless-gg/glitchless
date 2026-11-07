---
name: instrument
description: Add Glitchless observability to a game (Unity 6.3+, Godot 4.5+, Unreal Engine 5.8, Three.js or React Three Fiber, Roblox, Phaser 3 or 4, Babylon.js, PlayCanvas or GameMaker 2024.2+). Frame-time percentiles, hitch attribution, errors, gameplay events, level heatmaps, and tools that let coding agents measure the running game. Use when the user wants telemetry, analytics, performance monitoring or "observability" in a game, or asks to add Glitchless.
---

# Instrument a game with Glitchless

Goal: after this skill, every play session reports how the game *felt* (frame times, hitches and their causes),
what broke (errors, crashes) and what the player did (levels, deaths, pickups, positions), and you (the agent)
have a way to measure the running game before and after a change.

## 0. Find the engine, and the settings

| You find | Engine | Follow |
| --- | --- | --- |
| `ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json` | Unity 6.3+ | [references/unity.md](references/unity.md) |
| `project.godot` | Godot 4.5+ | the Godot addon's README: `godot/addons/glitchless/README.md` in the Glitchless repo (`~/.glitchless/godot/addons/glitchless/README.md` if it's cloned there), then [references/godot.md](references/godot.md) for bug reports, streams, properties and multiplayer |
| a `*.uproject` file | Unreal Engine 5.8 (5.7 untested) | [references/unreal.md](references/unreal.md) |
| `three` or `@react-three/fiber` in package.json | Three.js | [references/threejs.md](references/threejs.md) |
| a Rojo `default.project.json` (or `*.project.json`), `wally.toml`, `*.rbxl` / `*.rbxlx`, or `.luau` scripts that call `game:GetService` | Roblox | [references/roblox.md](references/roblox.md) |
| `phaser` in package.json, or a `<script>` that loads Phaser | Phaser 3.60+ or 4 | [references/phaser.md](references/phaser.md) |
| `@babylonjs/core` or `babylonjs` in package.json, or a `<script>` that loads Babylon.js | Babylon.js 5+ | [references/babylon.md](references/babylon.md) |
| `playcanvas` in package.json, a PlayCanvas Editor project (scripts using `pc.createScript` or `pc.Script`), or a `<script>` that loads PlayCanvas | PlayCanvas 2.x | [references/playcanvas.md](references/playcanvas.md) |
| a `*.yyp` file | GameMaker 2024.2+ | [references/gamemaker.md](references/gamemaker.md) |

Read only the file for this game's engine: each one walks through reading the game, installing,
levels and events, bots and measuring, and checking it works. Apply these settings first.

Settings, for every engine:

- **Intake URL and client token.** If the user gave you them (a hosted Glitchless server prints both, for example
  `Send telemetry to https://api.example.com with client token gl_pub_…`), use those. Otherwise use
  `http://localhost:7777` and `gl_pub_dev`, a local server. On Glitchless Cloud with no token yet, call
  `glitchless_create_game`: it returns the game's client token and intake URL. The hosted MCP server
  (`https://api.glitchless.gg/mcp`) is signed in once it's connected; a local one signs in first
  (`glitchless_sign_in`, or `npx -y glitchless-mcp login`; the user approves a code). The client token is public and
  write-only, so it may live in the game's source. A secret or workspace key (`gl_sk_…`, `gl_ws_…`) never goes in
  the game.
- **Privacy.** Keep the default anonymous mode: no player ID, coarse device facts, no positions. Ask the user
  before choosing another mode, since the game's privacy policy and store answers must then say so (each SDK's
  PRIVACY.md lists every field and has the wording). If they want to know whether players come back (retention:
  D1, D7, D30), offer install mode: it adds only a random player ID kept on the device (`privacy: 'install'`;
  Godot `"privacy": "install"`; Unity `Privacy = Privacy.Install`; Unreal `Privacy=Install`). Anonymous mode
  can't count returning players. Full mode adds a stored player ID, device detail and positions. The Roblox SDK is
  anonymous only: on Roblox a stored ID would be kept against the player's account, which Roblox's rules protect. For
  a Roblox game's retention, connect Roblox on Glitchless Cloud instead (Settings → Integrations → Roblox, with an Open
  Cloud API key that has only `universe.analytics:read` for the experience): Roblox's own D1, D7 and D30, daily active
  and new users, Robux and its crash rate by place version then sit next to what the SDK measures.
- **A "share performance data" setting.** If the game has a settings or options menu, offer to add a toggle wired to
  Glitchless's off switch, so players can turn it off and back on at any time (store rules such as the Unity Asset
  Store's ask for it, and it lets the store forms answer "optional"): `glitchless.setEnabled(on)`; Godot
  `Glitchless.set_enabled(on)`; Unity `Glitchless.SetEnabled(on)`; Unreal `FGlitchless::SetEnabled(bOn)` or the
  Blueprint node Set Enabled; GameMaker `glitchless_set_enabled(on)`; Roblox `Glitchless.setEnabled(on)` from the
  LocalScript that runs the menu (or `Glitchless.setEnabled(player, on)` on the server). Off stops measuring and sending at once and drops
  what was waiting; on starts a new session. Glitchless saves the choice on the device itself, so it holds from the
  first frame of the next launch: show the toggle from the game's own saved setting and call the switch when it
  changes (calling it with the saved value at start changes nothing when they agree). If the user wants players to
  agree before anything is collected, set the opt-in option (`optIn: true`; Godot and GameMaker `opt_in`; Unity
  `OptIn`; Unreal `bOptIn` or Project Settings > Opt In) and call the switch with `true` when the player says yes.
  Each SDK's reference below has the code.
- **Bots.** Sessions from autoplay bots and tests must be marked synthetic, so they stay out of player numbers.
- **Testers.** On iOS the Godot, Unity and Unreal SDKs tell a TestFlight install from an App Store one themselves
  (`distribution` in the device fields) and mark its sessions `tester`, out of player numbers, even though a
  TestFlight build is a release build that reports `prod`. Don't pass a session type that would undo this. On
  Android the Godot SDK marks debug builds and sideloaded ones (adb, an APK file) `tester` the same way; a game sold
  as an APK outside the stores (itch.io) passes `session_type: "user"`. Google Play's testing tracks can't be told
  apart on the device: if the developer ships test builds there, give the testing-track build its own env (`beta`)
  from a build flag. The developer's own play (checking the setup, a playtest) counts as a player's: on Glitchless
  Cloud, once it arrives, offer to mark their player as the team's with `glitchless_mark_known`'s `player` (`glitchless_session`
  without a session id lists the latest sessions with their `player_id`). It then reads as `tester` everywhere, past
  sessions too.
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
   - Roblox: `Glitchless.track(player, "play", { mode = "endless" })` in a server script, or
     `Glitchless.track("play", { mode = "endless" })` in a LocalScript

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
     run (the SDK makes its ID). `setZone(name)` for where the player is in an open world or a hub (an MMO zone, a room, a
     lobby hall): not a level, it never ends in a win or a fail. Time in each zone and frame time per zone come from the
     frames drawn there, so don't send zone entries or zone timing as events.

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
   - Roblox: the price in Robux, `Glitchless.track(player, "purchase", { item = "gems_500", amount = 99, currency = "ROBUX" })`
     in `ProcessReceipt` (boards show Robux with ⬡, never added to dollars; give the dashboard `currency: "ROBUX"`)
2. A multiplayer game also reports its network, and its dedicated servers (follow the engine reference's
   multiplayer section):
   - **Ping, loss and disconnects.** The Unity SDK reads Netcode for GameObjects and Mirror by itself, Godot its
     MultiplayerAPI with ENet or WebSocket, Unreal its own net driver; a web game passes its ping with
     `netSample({ rtt_ms })` about once a second (or `instrumentNet` for WebRTC), GameMaker with
     `glitchless_net_sample`, the Roblox SDK reads each player's ping by itself, and any engine on another library (Steam Networking Sockets, Photon, Nakama, a game's
     own) the same way. Call `disconnect({ reason })` when the connection drops and `reconnect()` when it comes back,
     where the netcode doesn't say: a disconnect ends a level attempt as an abandon, never a fail. Nothing about the
     other end is sent (no addresses).
   - **Server mode.** A dedicated or authoritative server runs the SDK as a server: `glitchless/server` on a Node
     server (with `instrumentWs`, `instrumentSocketIO` or `glitchlessRoom` for Colyseus), the Unity and Godot SDKs in a
     dedicated-server build (or `--glitchless-server`), the Unreal plugin on a dedicated server; on Roblox the server
     is always measured, since it is the one that sends. It sends its tick time
     against its tick rate, players connected, CPU, memory and crashes, never anything about players, and Glitchless
     keeps it apart from players under `<game>.server`. It uses the game's own service and client token, and sets
     the same match groups as its players. It needs a Glitchless server that lists `server_mode` in `GET /v1/health`
     (any current one does) and sends nothing to an older one.
3. Once events arrive, design the game's own dashboard: follow the `dashboard` skill (next to this one), which
   turns the developer's questions into collectors, panels and pages and saves them with the
   `glitchless_set_dashboard` MCP tool.

## In a jam room

When the user is at a Glitchless jam and gives you a room code (5 letters and digits, such as `K7Q2M`), the game also
goes to the room's arcade, where everyone plays everyone's game on their phones:

- Add the `glitchless-jam` MCP server (`npx -y glitchless-jam`, the same `GLITCHLESS_URL`; it uses the same sign-in as
  `glitchless-mcp`). It is the jam's own tool, kept apart from the production one.
- Build with relative paths, since the room serves the game from a folder of its own: `vite build --base ./` (or
  `base: './'` in `vite.config.js`), and no `fetch('/…')` of the game's own files. Keep `localStorage` keys prefixed
  with the game's name: every game in a room shares one origin.
- Keep the default anonymous mode; the room counts plays.
- Publish the build folder with `glitchless_jam` (`action: "publish"`, `dir: "dist"`, `room`), or
  `npx -y glitchless-jam publish dist --room <code>` in a terminal. It joins the room, checks the folder, reads the
  version from `Glitchless.init`, and answers with the game's link and a QR code: show both to the user.
- Before publishing a fix, bump the version passed to `Glitchless.init`: a room takes each version once, and its
  "biggest improvement" award compares the first version with the last.

## Report

Tell the user what you wired (with file:line), the gauges you chose and why, the events you track and count, the
properties and groups you set, the netcode and server mode you wired for a multiplayer game, and the board you
designed, the agent tools or measure commands you set up, and anything you weren't sure about.
