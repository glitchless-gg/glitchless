# What Glitchless for Roblox sends

This file lists every field the Roblox SDK sends, what it keeps, what Roblox's own rules say about sending data out of
an experience, and what a game's privacy notice would need to say. It was written from `src/Server.luau`,
`src/Client.luau`, `src/Session.luau`, `src/Frames.luau`, `src/Ticks.luau`, `src/Inbox.luau` and `src/Words.luau`, and
checked against what reached a local Glitchless server from `lune run roblox/test/run`, `node --test
roblox/test/e2e.mjs` and a play test in Roblox Studio (0.746). Keep it in step with those files. The browser, Godot,
Unity, Unreal and GameMaker SDKs have their own lists.

Nothing here is legal advice, and Roblox's rules change: read them again (the links are below) before you ship.

## One mode: anonymous

The other Glitchless SDKs have three privacy modes; the Roblox SDK has only the first, and always sends it
(`privacy: "anonymous"`).

| | |
| --- | --- |
| Session ID | random (`s_` and 24 hex characters), made when the player joins, in the server's memory only |
| Player ID | **none**. No Roblox user ID, name or display name is ever sent, and nothing ties one session to another: a player who comes back tomorrow is a new, unrelated session |
| Device | the kind of device in Roblox's words (`Computer`, `Phone`, `Tablet`, `Console`, `VR`), the Roblox client's version, the screen size, the graphics quality setting, and whether it has touch, a keyboard or a gamepad |
| Positions | **not sent** unless the game sets `positions = true`: then the server samples each player's character position 4 times a second, in studs, and deaths carry where they happened |
| Kept | nothing on the player's device. On the server, in memory only, until it is sent. The player's on/off choice in the game's own DataStore, once the game asks (below) |

Install and full mode would add a stored random player ID, so returning players could be counted. On Roblox that ID
would have to be kept against the player's account (in a DataStore, keyed by user ID), which makes it a persistent
identifier of a Roblox user sent to a third party: the case Roblox's rules (below) are least clear about. So it isn't
there. Roblox's own analytics (Creator Dashboard) has retention.

## Names and user IDs never leave the server

Roblox names a player's scripts and character after the player: an error in a LocalScript reads
`Players.xX_Racer_Xx.PlayerGui.Hud:31: …`, and one in a character script `Workspace.xX_Racer_Xx.Animate`. So:

- the client scrubs the names and user IDs of everyone in the server out of its error text before it sends it;
- the server scrubs **every string in every batch** of the name, display name and user ID of every player in the
  server (and of those who left in the last 2 minutes): error messages and stacks, but also anything the game put in
  its own events, a level name, a zone, an attribute (`track(player, "gift", { to = other.Name })` sends
  `to: "<player>"`). A user ID goes as `<user>`, and a number that is a player's user ID is dropped. The SDK can only
  scrub the players it knows; don't put names or IDs in your events;
- property keys that name a person (`name`, `user_id`, `userid`, `display_name`, `email`…) and values shaped like an
  ID (7 or more digits in a row, which every Roblox user ID has) are dropped.

## Field by field

Every event has `type`, `ts` (milliseconds, Roblox's synced server time), `level` (the game's current level or null),
and while set `zone`, `match`, `party` and `run`. The envelope has `service`, `env`, `version`, `session_id`, `sdk`
(`glitchless-roblox/0.1.0`), `batch_id` (random, names the batch, never the player), and `role: "server"` on the
server's own session.

| event | fields | when |
| --- | --- | --- |
| `session_start` | `session_type` (`user`, or `tester` in Studio), `privacy` (`anonymous`), `device` (above), `props`; the server's own adds `server` {`tick_hz`, `max_players`, `build`, `region`, `host: {os: "Roblox"}`} | the session's first batch |
| `session_end` | `reason` (`quit`, `kicked`, `close`, `max_duration` for a server running 6 hours), `duration_s` | the player leaves, the server closes |
| `frame_window` | frame count, fps, the screen's rate, frame-time sketch and percentiles, slow/jank/hitch/frozen counts, render CPU, GPU and physics ms, draw calls, triangles, Luau memory and the client's memory in MB, instance and part counts, `screen`, graphics `quality`, `ctx` (the game's gauges and the instance count), `net`: the round trip to the server as a sketch and percentiles, jitter, data in and out, and `transport: "roblox"` | every 5 s per player |
| `hitch` | duration, likely causes, the frame's render, GPU and physics ms, draw calls, triangles, instances added, assets still loading, `ctx`, `recent` (names of the game's events in the 1.5 s before) | a frame over 50 ms, at most 3 a window |
| `load` | `ttff_ms`: from joining the server to the first frame after the game loaded | once a session |
| `error` | `kind` (`script` from a player's client, `server_script` from a server Script, or `manual`), `message`, `stack`, `source` (the script's path), `line`, `fn`, `fingerprint`, `attrs` (only what the game passes to `error`), `recent` (the last 6 of the game's event names) | each error, at most 25 of one kind a session |
| `level_start` / `level_complete` / `level_fail` / `level_abandon` | `attrs`, `duration_s`, `score`, `cause`, `reason`, as the game passes them | the game calls them; an abandon when a player leaves mid-level |
| `death` | `cause`; with `positions`: `x`, `y`, `z` | the game calls it, or the player's Humanoid dies |
| `custom` | `name`, `attrs`: the game's own words | the game calls `track` |
| `counts` | `duration_s`, `dropped`, `counts`: each name and group the game counted, its `attrs`, `n`, `sums`, `first_ts` | once a window, when the game counted anything |
| `props` | the properties that changed (null for one removed) | at most once a window |
| `group` | `kind`, `id` (hashed, or null when it ends), `attrs` | a match, party or run is set or ends |
| `pos` | with `positions`: `[time, x, y, z]` samples | every 5 s while positions are on |
| `server_window` | the server's frames (ticks as a sketch, rate reached, p50/p95/max, late frames, budget), Stats' Heartbeat and physics ms, players, the server's memory, data in and out, the players' round trips | every 5 s, the server's own session |

What is never read or sent: a user ID, name or display name, the player's account age, locale, country or friends,
chat, anything a player types, the server's JobId (it is hashed into the server's match ID), IP addresses (Roblox
doesn't give them to scripts, and the requests come from Roblox's servers, not the player's device).

## Turned off by the player

`Glitchless.setEnabled(player, false)` from the server, or `Glitchless.setEnabled(false)` from a LocalScript:

- nothing more is measured or sent for that player, from that moment;
- what was waiting for them is dropped, the session ends with no `session_end`;
- the choice is saved in the game's DataStore (`Glitchless` store, key `u<UserId>`, value `on` or `off`) and read when
  the player next joins, so they send nothing from the moment they join. It is never sent anywhere. Because it is kept
  against the player's user ID, a right-to-erasure request from Roblox covers it: delete that key with the rest of the
  player's data. `saveChoice = false` leaves keeping it to the game.

With `optIn = true`, nothing is sent for a player until the game calls `setEnabled(player, true)`.

## Kept on the server

The Glitchless server stores events as they arrive, each with its envelope and the time it arrived. The file store
reads back the last 14 days; Glitchless Cloud keeps them for the plan's retention.

## Roblox's rules on sending data out of an experience

What we read (November 2026), and how the SDK fits:

- **Only server scripts can make HTTP requests**, with Allow HTTP Requests on, at most 500 a minute for everything a
  server does ([HttpService](https://create.roblox.com/docs/reference/engine/classes/HttpService)). The SDK sends from
  the server, keeps to 100 a minute by default (`requestsPerMinute`), and never from a player's device.
- **Roblox identifiers are protected data.** Roblox's reminder on third-party integrations (Developer Forum, 2 June
  2026, ["A Reminder About User Privacy and Third-Party Integrations"](https://devforum.roblox.com/t/a-reminder-about-user-privacy-and-third-party-integrations/4665118))
  counts user IDs, usernames, display names and individual players' behavioral history as protected, and says
  creators may not track users across third-party services, build behavioral profiles outside Roblox, send individual
  user data to social platforms, chat apps or ad networks, or sell it; developer tools and backends are allowed as long
  as they don't track users across experiences or export user data to such platforms. The SDK sends no identifier,
  scrubs names and user IDs from every batch, ties no session to another or to a user, and its data stays with the
  experience's developer.
- **The Creator Third Party App Policy** ([help article](https://en.help.roblox.com/hc/en-us/articles/37924211313044-Creator-Third-Party-App-Policy))
  names "Analytics & Insights Tools" as a kind of third-party tool and bars fingerprinting users. The SDK sends only
  coarse device facts (the kind of device, screen size, graphics setting), the same for many players. We couldn't open
  the article itself (it refused automated reading); read it before you ship.
- **Community Standards, Advertising Integrations** ([Community Standards](https://about.roblox.com/community-standards)):
  "Games may not make programmatic calls to third-party advertising and measurement services." It sits in the
  advertising section, next to rules on sharing engagement data with advertisers; Glitchless measures performance and
  errors for the developer, isn't an ad service and shares nothing with advertisers. The wording is broad, though, so
  it is worth confirming with Roblox if your experience is large or under review.
- **Scoped user IDs.** Roblox is moving new players to per-experience user IDs (Developer Forum, 10 June 2026,
  ["Introducing Scoped User Identifiers"](https://devforum.roblox.com/t/update-on-safety-privacy-introducing-scoped-user-identifiers/4677155)).
  The SDK never sends a user ID, so this changes nothing for it; the off switch's DataStore key uses whatever
  `UserId` the server sees.
- **Players under 13.** Roblox's own rules on personal information apply to every player; the SDK collects nothing a
  player types and no identifier, in every session, whatever the player's age.

Third-party analytics SDKs that send from a Roblox server are an established pattern: GameAnalytics publishes an
official one for Roblox (installed with Rojo, Wally or the Toolbox).

## For the privacy notice

If your experience has a privacy notice (on its page, or a settings screen), a paragraph:

> **Performance and error reports**
> So that we can find and fix lag and bugs, the game measures how smoothly it runs on your device and on our servers,
> and notes errors in its scripts. Every few seconds, and when you leave, our game server sends these reports to our
> analytics provider, Glitchless. A report says how long frames took, which level you were on and which of the game's
> events had just happened, along with the game's version and broad facts about your device: whether it's a computer,
> phone, tablet or console, its screen size and graphics setting. Reports from one visit share a random number made
> when you join, which is never saved, so visits can't be linked to each other. Reports carry no Roblox user name,
> display name or ID, nothing you type and no location. They are deleted after *[30 days]*.

If the game has the setting (`setEnabled`):

> You can turn these reports off at any time in the game's settings (*[Settings → Share performance data]*). From then
> on nothing more is sent. The game remembers your choice, and nothing else.

## When this file must change

Read it again when any of these change: the events or fields in `src/Session.luau`, `src/Frames.luau`,
`src/Ticks.luau` or `src/Server.luau`; what the client sends (`src/Client.luau`) or the server takes from it
(`src/Inbox.luau`); the scrub in `src/Words.luau`; what the Glitchless server stores (`server/src/ingest.js`,
`server/src/stores/`); or Roblox's rules above. Then change your privacy notice before you publish the version that
sends more.
