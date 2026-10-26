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
