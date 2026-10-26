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

**Balance, outcomes and economies.** A rate breakdown answers "which hero wins too often" with how sure it is: each
row's whisker is the range its rate likely sits in, and a row whose range misses the line (all heroes, or `expect`)
is drawn in colour. Set `min` so rows of a handful of matches stay out (100 or more for a balance question), and say
in the `note` what the line should be ("Should sit near 50%"). A game with published odds (a gacha banner's 0.6%) can
put them in `expect` on a rate of its pulls: the board and a finding then say when what players got misses it, and the
developer decides what that means. Per-hour numbers (`per: "$hours"`) compare versions fairly when sessions get
longer or shorter, so put an economy's earn and spend rates in stats and add a `versions` panel; a sum per hour that
moves 50% between versions, or a distribution whose median moves 30%, becomes a finding. To check one combination
the board doesn't show, ask `glitchless_events` with `name`, `rate` and `by` (and a filter in `name`), or `of` for a
distribution.

**Money.** A sum of events that carry a `currency` is money: the dashboard shows it with the currency's symbol and
two decimals. A game has one currency, the dashboard's `currency` (`glitchless_set_dashboard` with
`currency: "USD"`, sent again with every save) or else the one most purchases are sent in; purchases in another
currency are listed on the panel as left out, never added in. If one shows up, fix the game (convert before
sending, or send the store's price in one currency) rather than the board. Revenue is hidden on a shared board
unless the link is made to show it. A game connected to RevenueCat (Glitchless Cloud: Settings → Integrations) gets a Revenue page of
`store_revenue` panels by itself: that is the real revenue (RevenueCat counts production purchases only), with installs
and active users next to the players Glitchless measures, so keep it, and read it with `glitchless_revenue`; the game's
own `purchase` sums are for revenue by item, level or player. A game that sells through its own Stripe account gets a
Stripe one (refunds, fees, new paying customers, revenue by product). For its revenue by version, the game's server puts
the player's Glitchless session ID (`Glitchless.instance.sessionId` in a web game) in the Checkout Session's
`client_reference_id`, or `glitchless_session` metadata on it or the PaymentIntent.

**Who is playing.** A game that sets properties splits anything by them (`by: "$rank"`): win rate by hero at each
rank is a page with `"where": { "$rank": ["diamond", "master"] }` and the same breakdown on it; retention by
`$spender`, frame time by `$preset` (the Performance view's by-property table), versions by `$class`. A property with
more than 200 values a day is an ID and reads as "(too many values)": fix the game. These read the sessions, so
ranges of 31 days or less.

**Multiplayer.** A game with online play gets a Network page: `stat` ping_p95 and disconnect_pct, a `net` panel by
`$region` (or `$link` on mobile: Wi-Fi against mobile data) and one with `show: "disconnects"`, and `findings`; a
whole lobby lagging at once (the server) and one player lagging (their connection) are findings of their own. With
match groups, keep the `matches` view. With dedicated servers in server mode, a Servers page (`servers_now`,
`server_tick_p95`, `server_crash_free_pct`, a `servers` panel `by: "players"`) or the built-in `servers` view; the
servers' sessions are kept under `<game>.server`, never counted as players. An open world splits by `$zone`.

**Platforms, browsers, devices.** A web game: `breakdown` by `$browser`. A game on PC, Mac and Steam Deck: by
`$platform`. Any game whose frame times vary: by `$device_tier`, next to frame time. For a game on iOS and Android, put the split on its main page: `breakdown` by `$platform` (players or
sessions on each), the same with `event: "purchase"` (purchases tracked on each), and with RevenueCat connected,
`store_revenue` `by_store` (the money in each store) and `by_country` (where installs and money come from). Add a
`store_score` per store the game is connected to.

Every panel and the tables of the Events, Errors, Sessions, Players and Versions views have a CSV button, so a
developer can take any number to a spreadsheet: no export panel is needed.

A mobile game with modes, stops and a paywall:

```json
{
  "currency": "USD",
  "pages": [
    { "title": "Overview", "icon": "overview", "panels": [
      { "type": "stat", "metric": "players", "size": "s" },
      { "type": "stat", "event": "open", "title": "App opens", "size": "s" },
      { "type": "stat", "event": "buy=done", "per": "paywall", "title": "Paywall to purchase", "size": "s" },
      { "type": "stat", "event": "purchase", "sum": "amount", "title": "Revenue", "size": "s" },
      { "type": "findings", "limit": 3, "size": "l" },
      { "type": "breakdown", "event": "play", "by": "what", "title": "Which modes they play", "size": "m" },
      { "type": "series", "event": "open", "by": "what", "title": "Opens, free vs full", "size": "m" }
    ] },
    { "id": "paywall", "title": "Paywall", "icon": "bolt", "panels": [
      { "type": "stat", "event": "purchase", "sum": "amount", "per": "$players", "title": "Revenue per player", "size": "s" },
      { "type": "stat", "event": "purchase", "per": "$players", "title": "Players who bought", "size": "s" },
      { "type": "breakdown", "event": "purchase", "sum": "amount", "by": "item", "title": "Revenue by item", "size": "m" },
      { "type": "funnel", "steps": "paywall,buy=tapped,buy=done", "title": "Paywall to purchase", "size": "l" },
      { "type": "breakdown", "event": "paywall", "by": "what", "title": "Where the paywall opens", "size": "m" },
      { "type": "versions", "title": "Paywall numbers by version", "size": "m" },
      { "type": "sessions", "sent": "buy=done", "title": "Sessions that bought", "size": "l" }
    ] },
    { "id": "stops", "title": "Stops", "icon": "flag", "panels": [
      { "type": "levels", "label": "Stop", "title": "Stops won and lost", "size": "l" },
      { "type": "breakdown", "event": "difficulty", "by": "what", "title": "Difficulty picked", "size": "m" }
    ] },
    { "id": "purchases-live", "title": "Purchases, live", "view": "live", "options": { "events": ["paywall", "buy"] } },
    { "view": "events" },
    { "view": "sessions" },
    { "view": "versions" },
    { "view": "errors" }
  ]
}
```

A competitive game (a MOBA, a card battler, a roguelite: the same shape with its own words):

```json
{ "pages": [
  { "id": "heroes", "title": "Heroes", "icon": "players", "panels": [
    { "type": "stat", "event": "match_end", "rate": "won", "title": "Matches won", "size": "s", "note": "Should sit near 50%" },
    { "type": "stat", "event": "match_end", "of": "duration_s", "quantile": 50, "unit": "s", "title": "Median match", "size": "s" },
    { "type": "stat", "event": "match_end", "per": "$hours", "title": "Matches per hour played", "size": "s" },
    { "type": "breakdown", "event": "match_end", "by": "hero", "rate": "won", "min": 100, "limit": 20, "title": "Win rate by hero", "size": "l" },
    { "type": "breakdown", "event": "match_end", "by": "items", "rate": "won", "min": 100, "limit": 20, "title": "Win rate of builds with each item", "size": "m" },
    { "type": "distribution", "event": "match_end", "of": "duration_s", "by": "mode", "unit": "s", "title": "Match length", "size": "m" },
    { "type": "versions", "title": "Version by version", "size": "l" }
  ] },
  { "view": "performance" },
  { "view": "errors" }
] }
```

A battle royale or other online game, next to its own pages:

```json
{ "pages": [
  { "id": "network", "title": "Network", "icon": "live", "panels": [
    { "type": "stat", "metric": "ping_p95", "title": "Ping for the slowest 5%", "size": "s" },
    { "type": "stat", "metric": "disconnect_pct", "title": "Matches ended by a disconnect", "size": "s" },
    { "type": "net", "show": "ping", "by": "$region", "title": "Ping by server region", "size": "l" },
    { "type": "net", "show": "disconnects", "title": "Disconnects and why", "size": "m" },
    { "type": "findings", "limit": 5, "size": "m" }
  ] },
  { "id": "servers", "title": "Servers", "icon": "perf", "panels": [
    { "type": "stat", "metric": "servers_now", "title": "Servers running", "size": "s" },
    { "type": "stat", "metric": "server_tick_p95", "title": "Server tick, slowest 5%", "size": "s" },
    { "type": "stat", "metric": "server_crash_free_pct", "title": "Server runs without a crash", "size": "s" },
    { "type": "servers", "show": "ticks", "by": "players", "title": "Tick time by players connected", "size": "l" }
  ] },
  { "id": "endgame", "title": "Dungeons", "icon": "flag", "panels": [
    { "type": "levels", "label": "Dungeon", "by": "tier", "title": "Clears by tier", "size": "l" },
    { "type": "levels", "label": "Dungeon", "by": "$class", "title": "Clears by class", "size": "m" }
  ] },
  { "view": "matches" },
  { "view": "performance" }
] }
```

A puzzle game: an Overview with `stat` players and average session, `levels` with `"label": "Puzzle"` (completion
and time), a `breakdown` of `hint` by `what` and a `funnel` of `tutorial=done,puzzle_solved`; then Events, Sessions
and Errors. No Performance unless it's slow, no Heatmaps, no deaths.

A platformer or shooter: an Overview with `stat` frame_p95 and crash_free_pct, `findings`, `frame_time`, `levels`,
`deaths` and a `breakdown` of `weapon` or `powerup`; then Performance, Heatmaps, Errors, Sessions and Versions. A
level whose deaths tell its story gets a `positions` panel (`"show": "both"` to see where players went too).

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
