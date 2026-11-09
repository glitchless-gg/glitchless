# Godot

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


Follow the addon's README (`godot/addons/glitchless/README.md`): install, `Glitchless.init`, levels, deaths,
`track`, and `--glitchless-measure` for bots.

## Bug reports from players (ask first)

As for [Three.js](threejs.md#4b-bug-reports-from-players-ask-first), and the same question to the user first. In Godot,
`"bug_reports": true` in the options of `Glitchless.init` adds the F8 form; it pauses the tree while it's open, so
a game with its own pause logic passes `"bug_reports": {"pause": false}` and connects `Glitchless.bug_report_opened` and
`bug_report_closed`. A pause menu can call `Glitchless.open_bug_report()`, and the game's own form
`await Glitchless.report_bug(note)`. The screenshot is the root viewport; headless runs have none. Privacy wording:
`godot/addons/glitchless/PRIVACY.md`.

## The player's off switch (where the game has a settings menu)

If the game has a settings or options menu, offer the user a "Share performance data" toggle there (ask first, as for
bug reports). Store it with the game's own settings, show that saved value in the menu, and call
`Glitchless.set_enabled(on)` when it changes; calling it again at start-up with the saved value does nothing. Use a
`CheckButton` like the game's other toggles (README, "The player's off switch"). Don't show `Glitchless.is_enabled()`
there: it is false in a debug build without `--glitchless`. Glitchless saves the choice itself
(`user://glitchless/enabled`), so it holds from the first frame of the next launch. For a game that asks before
collecting anything, pass `"opt_in": true` to `init` and call `set_enabled(true)` when the player says yes. With the
toggle, Google Play's Data safety form can say collection is optional (PRIVACY.md, "For the store forms").

## Runs from the editor

Every run the Godot editor starts is a debug build, and a debug build sends nothing without `--glitchless` (README,
"Off in debug builds"). So a game with no players yet sends nothing at all, and Glitchless looks empty to its developer.
If the game has no players yet, or the user asks for their own runs or playtests to show, add `--glitchless` to
`run/main_run_args` in the `[editor]` section of `project.godot` (after any arguments already there; the editor adds
them to every run). Tell the user it's there, that it counts their runs as a player's, and to take it out once the game
has players. Don't pass `"enabled": true` to `init` instead: that turns on every debug build for good.

## Playtests

`glitchless_playtest` runs the game with its autoplay bot before and after a change and compares the two. If the game
has no autoplay mode, add one: in the main scene's `_ready()`, read `--autoplay` and `--seed=N` from
`OS.get_cmdline_user_args()`, let a bot play with a `RandomNumberGenerator` seeded from N, call `level_start` as it
goes, and keep playing for at least 10 seconds (`godot/demo/demo.gd` in the Glitchless repo does this). Then add
`glitchless.playtest.json` beside `project.godot`:

```json
{
  "command": ["godot", "--path", "."],
  "scenarios": [
    { "name": "seed 7", "params": { "autoplay": true, "seed": 7 }, "seconds": 10 },
    { "name": "seed 21", "params": { "autoplay": true, "seed": 21 }, "seconds": 10 }
  ]
}
```

`godot` is Godot 4.5 or later on the PATH, or its full path; an exported build works too (`["build/Game.x86_64"]`).
Call `glitchless_playtest` with `save_as: "baseline"` before changing code and with no arguments after. Each run opens
the game's window for about 10 seconds; with `--headless`, frame times only warn.

## Web exports

A Godot web export (a game jam's entry on itch.io, say) needs nothing more: the addon works there with Thread Support
off (the default) or on, and sends what a desktop build does (README, "Web exports"). What differs:

- **Debug builds.** Godot's export dialog exports with debug on unless it's unticked, so a web export sends, debug or
  not, once its page is anywhere but the developer's own machine. On their machine (the editor's Run in Browser, a local
  server) a debug build sends only with `?glitchless` in the page's address: `main_run_args` doesn't reach a browser.
  Tell the user to open `http://localhost:8060/tmp_js_export.html?glitchless` to see their own runs.
- **Sessions name the browser** (Chrome, Safari, Firefox, Edge) and its OS, as the browser SDK's do, so a board splits a
  web game by `$browser` and `$platform` like a Three.js one; Godot's version is in `session_start.engine`.
- **Closing the tab** ends the session (`session_end` and `level_abandon`, reason `pagehide`), sent by beacon.
- **Measuring:** `--glitchless-measure` needs a command line, so measure a desktop export of the same game (or the
  game run from the editor); there are no WebMCP tools for a Godot web export.

## Streams, properties, matches and zones

- **Count a stream, track a moment.** Shots, hits, kills, loot and gold go through
  `Glitchless.count("kill", {"monster": "elite"})` (numbers are summed: `{"source": "loot", "amount": 35}`), never
  one `track()` each: the queue holds 2,000 events. A debug build warns when a name is tracked over 20 times a second.
- **Properties** hold for the session, in the game's words: `Glitchless.set_properties({"mode": "squads", "rank": "gold"})`
  where the game knows them (after sign-in, at the menu, at matchmaking), or `"properties"` in the options. Bands, not
  exact numbers (`"level_band": "30-39"`); never a name, account, email or ID (they are dropped). Hero, deck and map
  change per match: put them on events or on `level_start`.
- **Level attributes:** `Glitchless.level_start("pit", {"tier": "pit_80", "party_size": 3})`.
- **Groups:** `Glitchless.set_group("match", match_id)` with the ID the game's server made for the match (the client
  and the server set the same one; Glitchless hashes it), `set_group("party", id)`, and for a roguelite
  `var run_id := Glitchless.set_group("run")` at the run's start (save it, and pass it back to resume).
  `set_group("match", null)` when it ends.
- **Zones** for open worlds and metroidvania rooms: `Glitchless.set_zone("ashen_wastes")` as the player moves.

## Multiplayer

- **Godot's MultiplayerAPI with ENet** (the usual Godot multiplayer): nothing to add. Glitchless reads ping, jitter,
  packet loss and bytes from the ENet peer, and disconnects from `multiplayer`'s signals. If the game knows why a
  connection dropped (it was kicked), call `Glitchless.net_disconnect("kicked")` in its `server_disconnected` handler.
- **WebSocket (web exports) or other netcode** (Steam Networking Sockets, Nakama, a custom protocol): call
  `Glitchless.net_sample(rtt_ms, loss_pct, jitter_ms)` once a second with the game's own ping while connected,
  `Glitchless.net_disconnect(reason)` and `Glitchless.net_reconnect()`.
- **A dedicated server** (a dedicated-server export, or started with `--server`) reports as the game's server on its
  own: tick time against `Engine.physics_ticks_per_second`, players from `multiplayer.get_peers()`. In its `init`, pass
  `{"region": "eu-west", "max_players": 100}`; call `level_start(map)` for the map and `set_group("match", id)` with
  the match's ID. A game whose `--server` flag means something else passes `{"role": "player"}`; one that starts its
  server another way passes `{"role": "server"}`. With other netcode, `Glitchless.set_players(n)`.
- A server sends nothing to a Glitchless server that predates server mode, and says so in its log.
