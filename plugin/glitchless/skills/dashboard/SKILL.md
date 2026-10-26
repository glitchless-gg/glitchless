---
name: dashboard
description: Build a game's own Glitchless dashboard. Work out what this game's developer wants to know, add the collectors for it (custom events with track(), levels, gauges, positions, game tools agents can call), check the data arrives, then design the game's dashboard (its pages, which are boards of panels and the built-in views it needs) with the glitchless_set_dashboard MCP tool. Use when the user asks for a dashboard, metrics, KPIs or analytics for their game, wants to track or count something, asks "how many players…", "which mode…", "does the paywall convert", or wants a different view of their game in Glitchless.
---

# Build a game's own dashboard

Every game needs different numbers. A mobile game cares whether players come back, which mode they pick and
whether the paywall turns into purchases; a puzzle game, how long a puzzle takes and how often hints are used; a
platformer or shooter, where players die and whether frames hold up in a fight. Glitchless doesn't guess: you
add the collectors this game needs, and design its dashboard from them: its own pages, in its own words. The
developer then sees it in Glitchless, and you can read the same data back over MCP to debug.

Before this skill, the game should already send data (the `instrument` skill). If it doesn't, do that first.

## 1. Find out what they want to know

Write down three to eight questions, in the developer's words. Ask if they haven't said; read the game to
suggest some (menus, modes, shops, level lists, settings, anything with a counter). Good questions are about
decisions: "Do players finish the tutorial?", "Which mode do they play?", "Does the paywall convert?", "Which
stage is too hard?", "Does it stutter on phones?". Leave out what nobody would act on.

## 2. Pick a collector for each question

| The question is about | Collector | Shows on a board as |
| --- | --- | --- |
| how often something happens, or which option players choose | `track(name, attrs)` | `stat`, `series`, `breakdown` |
| how much: revenue, coins, seconds | a number in `track`'s attributes (`purchase` with `amount` and `currency`) | `stat` or `breakdown` with `sum` |
| how many players do it at all (conversion) | `track(name)` | `stat` with `per: "$players"` |
| a sequence (tutorial → first win, paywall → purchase) | one `track` per step | `funnel` |
| progress or difficulty through stages, puzzles, waves, stops | `levelStart` / `levelComplete` / `levelFail` | `levels` |
| dying, and where | `death` (and `setPosition` for places) | `deaths`, `positions` (one level), the Heatmaps view |
| smoothness, and what makes it worse | automatic frame times, plus `setContext` gauges (enemies, particles) | `frame_time`, `stat: frame_p95` |
| crashes and errors | automatic, plus `error()` for handled ones | `errors`, `stat: crash_free_pct` |
| whether players come back (D1, D7, D30) | install mode: privacy `install` in the SDK, a stored random player ID (ask the user first: the privacy page must say so) | `retention`, the Players view |
| how many are playing right now | automatic | `stat: players_now` |
| who wins: a hero, weapon, card, heat or difficulty that wins too often or too rarely | one event at the end of each match or run with the outcome as a boolean (`match_end` with `hero` and `won: true`) | `breakdown` by `hero` with `rate: "won"` (each row's win rate with its likely range, next to all of them), `stat` with `rate` |
| how long, how far, how many: match length, time in queue, placement, floors reached, pulls to a top unit | a number on that one event (`duration_s`, `wait_s`, `floor`) | `distribution` (half under, 1 in 10 over, a histogram), `stat` with `of` and `quantile: 50` (the median) |
| what a match or run used: a deck, items, a build, boons | a list attribute (`deck: [...]`) | `breakdown` by the list (each card a row), with `rate` for the win rate of decks with each card |
| how fast players earn or play: gold, XP or kills per hour, matches per hour | the event (with its `amount`) | `stat` or `breakdown` with `per: "$hours"` (per hour played), and a `versions` panel to catch an economy that jumps |
| a stream: shots, hits, kills, gold pickups, taps (many a second) | `count(name, attrs)`: summed on the device, sent once every 5 s, never a `track` per hit | like any event by its name: `stat` per `$hours`, `breakdown` by its words, `sum` of its numbers (no distribution) |
| who is playing: rank, class, region, mode, a graphics preset, a spender band | `setProperties({ rank: 'gold' })`, set where the game knows it (after sign-in, the menu, matchmaking) | `by: "$rank"` on any breakdown, series, rate, distribution, `levels`, `retention` or `versions`; a page with `where` (only the high ranks) |
| clears and wipes by difficulty, tier, group size or build | `levelStart(id, { tier, party_size, build: [...] })` | `levels` with `by: "tier"` (one level's rows: `level`), `deaths` with `by` |
| runs that cross several levels (a roguelite) | `setGroup('run')` at the run's start | `levels` with `count: "runs"` (runs that reach each biome), `stat: runs` |
| one match from every side, and whether the lobby or one player lagged | `setGroup('match', id)` with the ID the game's server made (`'party'` for a party; its size goes on `levelStart` as `party_size`) | the Matches view (each match's page), the lobby finding; clears by group size: `levels` by `party_size` |
| where the player is in an open world (an MMO zone, a room) | `setZone(name)` | `by: "$zone"` on breakdowns and series (kept like levels: any range) |
| lag, packet loss and dropped players | read from the netcode by the SDK, or `netSample` / `disconnect` (the `instrument` skill) | `net` (ping, loss, disconnects), `stat: ping_p95`, `disconnect_pct`, the Network section of Performance |
| dedicated servers: tick rate under load, crashes that end matches, leaks | the SDK in server mode on the server build (the `instrument` skill) | `servers` panels, `stat: servers_now` / `server_tick_p95` / `server_crash_free_pct`, the Servers view |

The calls, per engine:

| | Three.js or Phaser | Godot | Unity | Unreal (C++; the Blueprint nodes match) |
| --- | --- | --- | --- | --- |
| a game event | `glitchless.track('play', { mode: 'endless' })` | `Glitchless.track("play", "endless")` | `Glitchless.Track("play", "endless");` | `FGlitchless::Track(TEXT("play"), TEXT("endless"));` (Track Event (What)) |
| several attributes | `glitchless.track('buy', { step: 'done', item: 'full_game' })` | `Glitchless.track("buy", {"step": "done"})` | `Glitchless.Track("buy", new Dictionary<string, object> { ["step"] = "done" });` | `FGlitchless::Track(TEXT("buy"), TMap<FString, FString>{{TEXT("step"), TEXT("done")}});` (Track Event) |
| a purchase | `glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })` | `Glitchless.track("purchase", {"amount": 4.99, "currency": "USD", "item": "gems_500"})` | `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" });` | `FGlitchless::Track(TEXT("purchase"), {{TEXT("amount"), TEXT("4.99")}, {TEXT("currency"), TEXT("USD")}, {TEXT("item"), TEXT("gems_500")}});` (Track Event) |
| a level | `levelStart(id)`, `levelComplete(id, { score })`, `levelFail(id, { cause })`, `levelAbandon(id)` (left, not lost) | `level_start`, `level_complete`, `level_fail`, `level_abandon` | `LevelStart`, `LevelComplete`, `LevelFail`, `LevelAbandon` | `LevelStart`, `LevelComplete`, `LevelFail`, `LevelAbandon` (maps are levels on their own) |
| a gauge | `glitchless.setContext({ enemies })` | `Glitchless.set_context({"enemies": n})` | `Glitchless.SetContext("enemies", n)` | `FGlitchless::SetContext(TEXT("enemies"), N)` |

Rules that keep the numbers useful:

- One event name per moment, in the game's own words (`open`, `play`, `paywall`, `buy`), and keep names stable:
  renaming an event splits its history.
- Put the choice in an attribute, not the name: `play` with `mode: 'endless'`, not `play_endless`. Godot, Unity
  and Unreal turn one word into the attribute `what`.
- Attributes are strings, numbers, booleans or lists of them, at most 12 per event; strings are cut to 64
  characters. Keep their values to a small set (modes, places, outcomes): a value per player or per run makes a
  useless breakdown.
- Outcomes as booleans (`won: true`), amounts as numbers (`duration_s: 184`), what a match or run used as a list
  (`deck: [...]`, its first 16 count), and one event at the end of each match or run carrying all of them, not one
  per hit. What describes the player goes in bands (`level_band: '30-39'`), never exact levels or amounts.
- Track a moment, count a stream: `count()` for anything that happens many times a second (shots, hits, kills,
  gold); `track()` for a moment worth its own event (a match's end, a purchase).
- A property is what holds for the session (rank tier, class, region, mode, preset), set again each session: bands
  and words, never an ID, a name or an exact number (intake drops keys like `email` or `user_id` and values shaped
  like one). What changes from match to match (hero, deck, map) goes on the event or the level start instead.
- Never send anything that identifies a player: no names, emails, account ids or anything they typed.
- Purchases: one `purchase` event when the store confirms it (not when the button is tapped), with `amount` (a
  number, in the currency's units: 4.99, not 499), `currency` (the ISO code the store charged in) and `item`. A
  number sent next to `currency` counts as money, so put other numbers (gems granted) on an event of their own.
  Never send receipts, order ids or payment details. Taps and failures are other events (`buy` with `step`).

Add the calls where the moment happens in code, then run the game (or let the bots play it) and check with
`glitchless_events` that every event arrives with the attributes you expect.

## 3. Design the dashboard

A dashboard is the game's pages, in the order its sidebar shows them; the first opens first. Each page is a
board, panels you choose, or a built-in view the game keeps: `events` (every event, breakdowns, funnels),
`performance` (frame time and hitches), `errors`, `players`, `heatmaps` (positions on the level), `sessions`
(each with its replay), `versions`, `live` (events as they arrive; `options.events` keeps only some), `reports`
(bug reports players sent, with screenshots), `matches` (a multiplayer game's matches, each opening a page with every
player's ping slot by slot and the server's ticks under it) and `servers` (a game whose dedicated servers run the SDK
in server mode: ticks by map and players connected, crashes, memory). Give the game the pages its developer would open, named in the game's
words, and drop the views it has no data for: no Heatmaps for a puzzle or mobile game, no Performance for a game
that sends no frame times, no reports page for a game that doesn't turn bug reports on.

Start from what is there: `glitchless_dashboard` returns the current pages (`spec`; an automatic dashboard until
someone saves one). Then call `glitchless_set_dashboard` with every page. On a board: a row of stats, then the
game's own events and funnels, then levels, then frame time and errors. Title each panel with the question it
answers. Each panel takes `size`: `s` (a quarter row, for stats), `m` (half) or `l` (full width); and a `note`,
one line on why it matters. People see the note behind the info icon next to the title, so put what they must see
in the title. Panels keep their order and pack under each other, so a short panel can sit next to a tall one.
Give the game its own colour with `accent` ("#rrggbb", such as the main colour of its logo or key art) in
`glitchless_set_dashboard`, alone or with the pages: it colours the links, the selected page, stats, the main chart
series and the map on its boards and share links. The logo and a banner (key art) are uploaded by people in the
dashboard (Edit pages → Look); `glitchless_dashboard` says whether the game has them.

| type | fields |
| --- | --- |
| `stat` | `metric` (sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct, hours_played, players_now: playing now, whatever the range; runs; for a multiplayer game ping_p50, ping_p95, loss_pct, disconnects_per_hour, disconnect_pct; with servers in server mode servers_now, server_tick_p95, server_crash_free_pct, players_per_server), or `event` with an optional `per`: another event (a percentage), `$players` / `$sessions` (the share of them that sent it: conversion) or `$hours` (per hour played: matches per hour; `deaths` and `errors` take it too). With `sum` (a numeric attribute), it adds that up instead, and `per: "$players"` gives it per player, `"$hours"` per hour played (gold per hour). `rate`: the share of the events where a flag holds (`"won"`) or a word is sent (`"result=win"`), with `expect` for a rate the game intends; `avg`: a numeric attribute's average; `of` with `quantile` (1 to 99) and `unit`: one percentile (the median match) |
| `series` | `event`, optional `by` (split by an attribute, or `$version` / `$level` / `$zone`, or the sessions' `$platform` / `$browser` / `$device_tier` / `$link` or a property, `$rank`), `limit`, `sum`, `rate` or `avg`, `per: "$hours"` |
| `breakdown` | `event`, `by`, `limit`, `sum` (each value's sum, largest first). `by` can split the sessions themselves: `$platform` (Windows, macOS, Linux, Steam Deck, iOS, Android, Web…), `$browser` (Chrome, Safari, Firefox, Edge…; a native build shows as "Godot app", a web build of an engine as "Unity web build") or `$device_tier` (High-end, Mid-range, Low-end GPU, Software rendering, high to low), `$link` (Wi-Fi, Mobile data, Wired), or a property the game sets (`$rank`, `$class`; sessions without it are "(none)"). Without `event` it counts the sessions in each, and their players when the game sends player IDs. Ranges of 31 days or less. With `rate` (`"won"`, `"result=win"`) or `avg`, each row's rate with its likely range (or its average) next to the overall one: `min` leaves out rows of fewer events (default 30 for a rate), `expect` draws the rate the game intends (a gacha's published odds, as a percentage: 0.6), `order` is `rate` (default), `count` or `value` (heat 0, 1, 2). `per: "$hours"` makes each row per hour played. By a list attribute (a deck), each element is a row |
| `distribution` | `event`, `of` (a numeric attribute), optional `by` (an attribute, `$version`, `$level`, a session split), `limit` (rows, up to 8), `bins` (bars, up to 40), `unit` (`"s"` shows minutes and hours; or the game's word, `"floors"`). How it spreads: half under, 1 in 10 over, and a histogram |
| `funnel` | `steps`: events in order, comma-separated |
| `levels` | `label`: what the game calls a level ("Stop", "Puzzle", "Wave"); shows each one's median clear time and the slowest 1 in 10, and the attempts a disconnect ended. `by` splits each level's attempts: an attribute of its `levelStart` (`"tier"`, `"party_size"`, a list such as `"build"`), a property (`"$class"`) or a split; `level` keeps one level; `count: "runs"` counts each run once at each level it reached |
| `net` | `show`: `ping` (median and slowest 5% over time, and the share of play over 150 ms), `loss` or `disconnects` (per hour played, by reason); `by`: `$region` (a property), `$link`, `$platform`, `$level`, `$version` |
| `servers` | `show`: `ticks` (tick time against its budget; `by`: `players` connected, `$level` or `$version`), `players` or `crashes` (with the matches and players each ended). Read from the game's servers in server mode |
| `sessions` | `sent`: only sessions that sent this event ("buy=done"), `limit` |
| `versions` | none: this board's stats, version by version; `by` a property (`$class`) compares its values instead |
| `live` | `events`: only these names or types, as they arrive |
| `findings`, `frame_time`, `errors`, `deaths`, `events`, `reports` | none (`limit` for findings, errors and reports; `by` and `level` for deaths, as on `levels`) |
| `retention` | `limit`: how many of the latest first-seen days (default 14); `by` a property (`$spender`): each value's D1, D7 and D30. Needs player IDs: a game in anonymous mode gets a panel saying to turn install mode on |
| `store_revenue` | `measure` (required): `revenue`, `per_player`, `by_day`, `by_version` or `by_country` (a world map of installs or revenue by country with the countries ranked: installs, revenue, purchases; `show: "revenue"` opens it on revenue; size `l`); RevenueCat's `installs`, `active_users`, `mrr`, `actives`, `trials`, `players_by_day` and `by_store` (revenue in the App Store and Google Play next to the iOS and Android sessions measured); Stripe's `refunds`, `customers` (new paying customers) and `by_product`. `store`: `revenuecat` or `stripe` (default: the first connected). Real revenue from RevenueCat or the game's own Stripe account, for a game connected to it in Glitchless Cloud |
| `store_score` | `store` (`app_store`, `google_play` or `steam`): a store's rating, one small panel per store. The average stars of the written reviews synced in the window and how many, next to Apple's own rating on the App Store. Google Play has no API for its overall rating, so its panel is the reviews' average and says so |
| `positions` | `level` (required), `show`: `deaths` (default), `path` or `both`, `bin`: a bin's width in world units (default about a hundredth of the level). Where players died on that level, counted per bin, and where they went on a coarser grid: one panel per level |

An event is written `name`, `name=value` (any attribute has that value) or `name:key=value`. A list matches when it
has the value (`battle_end:deck=hog_rider`), and `battle_end:deck=hog_rider+ice_spirit` when it has all of them:
ask about any pair or trio this way. With `sum` and `by` an attribute, the event is a name only (`purchase`, not
`purchase=done`).

For a game with heroes, decks or builds to balance, money, player properties, online play, or several platforms
and devices, read [references/genres.md](references/genres.md): the panels each of those asks for.

Every panel and the tables of the Events, Errors, Sessions, Players and Versions views have a CSV button, so a
developer can take any number to a spreadsheet: no export panel is needed.

Whole dashboards to start from, a mobile game, a competitive game, a battle royale, a puzzle game and a platformer,
are in [references/examples.md](references/examples.md). Take the shape, not the words: every page and panel uses
this game's own names.

**A game that reads its own board.** A `positions` panel is only counts per bin (`deaths: [[a, b, n], …]` on the
level's plane, `axis` xy or xz, `bounds`, `bin`, `total`, `truncated`), so it can go on a board shared with a link,
and the game itself can poll that link to draw everyone's deaths without a backend of its own: one board, one
positions panel per level, a share link, and the game fetches `https://api.glitchless.gg/v1/query/board?share=gl_share_…&days=30`
about once a minute, always the same URL (no `from` or `to`, no header). The answer is cached for a minute, so
every player can poll it. Fix `bin` in the panel so the dead stay where they fell as more arrive.

Saving checks every page and answers with each panel as it looks over the last week; a panel without data says
why ("No "buy" events in this window"), and `glitchless_dashboard` with `page` shows one board's numbers. Show the
developer, then change what they ask for: "split opens by version", "add the shop" is one more `track` call and one
more panel, "a page for the tutorial" one more board. People can rename, reorder, add and remove pages in the
dashboard too (Edit pages), so read the current pages before saving over them.

## 4. Use it to debug

The boards also decide what a release is judged on: the Versions view and `glitchless_compare_versions` compare
the stats on every board, version by version (purchases per paywall view, revenue per session, opens per session), so ship a change,
bump the version, and read whether it moved the numbers this game cares about. For one event across versions on a
board, use `by: "$version"`; for a board's own stats, a `versions` panel.

The dashboard's numbers are what you read when something looks wrong: `glitchless_events` with a `funnel` finds
where players drop off, `glitchless_triage` ranks performance, crash, difficulty, network and server problems (and
names a property when most of one falls on a value: "crashes are mostly class necromancer"),
`glitchless_network`, `glitchless_match` and `glitchless_servers` read a multiplayer game, and in a browser game the
WebMCP tools let you reproduce one in the running game. Add a panel for anything you find yourself
checking twice.

## Report

List the questions, the events and calls you added (file:line), and the dashboard's pages and panels, and say
which panels will fill in only once players or bots send that data.
