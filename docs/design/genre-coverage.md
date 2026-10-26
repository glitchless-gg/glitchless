# Genre coverage: multiplayer and genre-specific games (design)

Status: a design, 26 October 2026; the owner decided the open questions the same day (section 7), and all nine
additions are being built at once, the server side in two phases and each engine in a session of its own. **A1 to A4
are built** (server phase 1, with findings 8, 9, 11 and 12 and phase 0's advice in the skills): SPEC describes them,
and [section 8](#8-built-a1-to-a4) says where the build differs from this design. **A5 to A9 are built on the server**
(phase 2, with findings 1 to 7, 10, 13 and 14), and [section 9](#9-built-a5-to-a9) says where that build differs. [`docs/SPEC.md`](../SPEC.md) describes what is built; each
addition below (A1 to A9) is written so that it can move into SPEC, in the section it names, once it ships.

The question was whether Glitchless is good enough for multiplayer games and for genres beyond the single-player
level loop: a battle royale like Fortnite, a MOBA like Dota, an MMO, a mobile 1v1 game like Clash Royale and a co-op
ARPG like Diablo 4. The short answer:

- **The data is mostly already sent.** Games can send outcomes, numbers and lists with `track()` today. The server
  just doesn't analyse them the way these genres need: it has no win rate by hero, no median match length and no
  "decks with this card". A1 to A4 are server work, plus one Unreal overload.
- **Some things need one SDK release on every engine.** These are who is playing (rank, class, region), how much
  happens (shots, kills, gold per second), and which events belong to one match or run. That is A5 to A7.
- **Multiplayer itself is new ground.** No SDK reads ping, packet loss or disconnects, and dedicated servers are
  either switched off (Unreal) or counted as bot players (Godot, Unity). That is A8 and A9, the largest part.

Privacy stays as it is: anonymous mode sends no player ID, and nothing here adds one. Player properties (A6) and
group IDs (A7) have their own rules so they can't turn into one.

## Contents

- [What exists today](#what-exists-today)
- [1. Example boards per genre](#1-example-boards-per-genre)
- [2. The additions, in order of value](#2-the-additions-in-order-of-value)
- [3. Engine work per addition](#3-engine-work-per-addition)
- [4. Findings these enable](#4-findings-these-enable)
- [5. Phased plan](#5-phased-plan)
- [6. Open questions for the owner](#6-open-questions-for-the-owner)
- [7. Decisions](#7-decisions-the-owner-26-october-2026)
- [8. Built: A1 to A4](#8-built-a1-to-a4)
- [9. Built: A5 to A9](#9-built-a5-to-a9)

## What exists today

Read from the code on `main` (5ad0b6e). Line numbers are at that commit.

- **Custom events.** `track(name, attrs)` events are counted per minute in rollup cells, one cell per env, version
  and level (`server/src/rollups.js:82-112`). A cell keeps four counts:
  - `ev`: events by name;
  - `evv`: events by name, attribute and value;
  - `evs`: the sum of each numeric attribute;
  - `evx`: those sums split by each string or boolean value of the same event (revenue by item).

  Caps: 12 attributes an event, strings cut to 64 characters, and 200 names, 400 values and 400 sums a cell
  (`rollups.js:16-29`). Each session also keeps, per event name, its count, its first 16 occurrences with their
  attributes, and a count of each attribute's values with a sum for an average (`server/src/session-state.js:46-51`,
  `:214-226`).
- **No two attributes together.** Cells count each attribute of an event on its own (`rollups.js:88`). Nothing counts
  "hero = ember and won = true", so a win rate by hero can't be read. A game that sends `won` as 1 or 0 gets part of
  the way: a breakdown by hero with `sum: "won"` shows wins and matches side by side (`server/src/board.js:634-653`),
  but not the rate.
- **Numbers.** Each distinct number counts as a value in `evv`, up to the caps. The events query gives an average per
  attribute (`server/src/analytics.js:1104-1108`), and sums add up. There are no medians, percentiles or histograms.
- **Lists.** Intake keeps a list attribute as sent (`sanitize`, `server/src/ingest.js:135-148`). `smallAttrs` then
  leaves lists and objects out of every count (`rollups.js:211-220`). A `deck: [...]` is stored but never counted, so
  no comparison of attribute values ever sees it.
- **Session splits.** `$platform`, `$browser` and `$device_tier` come from each session's `session_start.device`
  (`analytics.js:1030-1065`). The Steam facts are filters and breakdown splits (`analytics.js:68-87`). These
  splits read sessions, so they cover 31 days or less (`board.js:549-552`). No SDK has session or player properties,
  and none adds attributes to every event: each SDK's `push` adds only `ts` and `level` (`packages/sdk/src/core.js:650`,
  and the same in each engine).
- **Levels.** `level_start` carries nothing (SPEC §2; `core.js:135`). A level mark keeps its level, cause and
  duration (`session-state.js:114-121`).
- **Frequent events.** No SDK limits, merges or caps `track()`. Every SDK queues at most 2,000 events and drops the
  oldest first, frame windows included (`core.js:19`, `:653`; MaxQueue 2000 in Unity, Godot, Unreal and GameMaker).
  Intake takes at most 500 events a batch (`ingest.js:40`).
- **Time played.** Every SDK sends `duration_s` on each frame window (`core.js:698`; Unity
  `GlitchlessCore.cs:650`, Godot `glitchless.gd:754`, Unreal `GlitchlessCore.cpp:846`, GameMaker
  `__glitchless_core.gml:683`). The cells add it up (`rollups.js:98`), so time played with frames on screen is
  already known exactly, by version and level.
- **Networking.** No SDK has any networking code. A search for net, ping, rtt and multiplayer finds only each SDK's
  own HTTP sender.
- **Dedicated servers.**
  - Unreal never starts on one (`GlitchlessModule.cpp:20`, `GlitchlessSubsystem.cpp:13`: `!IsRunningDedicatedServer()`).
  - A Godot headless run is a `synthetic` session (`glitchless.gd:287`).
  - So is Unity batch mode (`GlitchlessRunner.cs:127`, `GlitchlessCore.cs:240`). Nothing checks `UNITY_SERVER`.
  - GameMaker has no headless runtime.

  So a server today sends nothing (Unreal), or it sends bot sessions. Boards count those with players' sessions,
  because `type=all` is the default (`analytics.js:44`).
- **Unreal's attributes.** The public `Track` takes a map of strings and a map of numbers
  (`unreal/Plugins/Glitchless/Source/Glitchless/Public/Glitchless.h:80`). Booleans and lists can't be sent, though the
  internal value type supports both.
- **What works for every genre already**:
  - stat, series, breakdown, funnel and levels panels;
  - deaths with causes and positions (positions need full mode or `positions: true`);
  - retention in install mode;
  - revenue and the store panels;
  - `players_now`;
  - frame time with `setContext` gauges;
  - errors.

### How to read the boards

Each board is a dashboard in the format of SPEC §3b (`{ currency?, pages: [...] }`). It is written as JSONC: a
`// A2` comment marks a panel, field or page that needs addition A2. Strip the comments before sending a board to
`glitchless_set_dashboard`. SDK calls are shown in the browser SDK's words, and each addition gives the calls for
every engine. The "today versus needs" table under each board maps that genre's questions to the additions.

## 1. Example boards per genre

### 1.1 Battle royale (100 players)

Questions the team asks:

1. Are matches smooth and fair? When a match lags, is it the server or one player's connection?
2. Do servers keep their tick rate with 100 players on the drop?
3. How long do players wait for a match, and how long do they stay alive?
4. Where do players land, and where do they die?
5. Which weapons win fights?
6. How many matches end in a disconnect?
7. Does the game stutter on the drop, with 100 players in view?

SDK calls:

```js
glitchless.setProperties({ mode: 'squads', region: 'eu-west', input: 'controller' }); // A6
glitchless.track('queue', { mode: 'squads', wait_s: 41 });                            // today (its distribution: A3)
glitchless.setGroup('match', match.id);                                               // A7: an ID the game server made
glitchless.levelStart('island', { mode: 'squads', squad_size: 4 });                    // attributes: A7
glitchless.track('landed', { zone: 'docks' });                                        // today
glitchless.setContext({ players_in_view: n, projectiles: m });                         // today
glitchless.count('shot', { weapon: 'ar' });                                           // A5
glitchless.count('hit', { weapon: 'ar', damage: 23 });                                // A5: damage is summed
glitchless.track('fight', { weapon: 'shotgun', won: true, range_m: 8 });              // today (rate: A2, range: A3)
glitchless.death({ x, y, z, cause: 'storm' });                                        // today
glitchless.track('match_end', { placement: 17, survived_s: 612, kills: 2, top10: false }); // today
glitchless.levelFail('island', { cause: 'eliminated' });                              // today (a win: levelComplete)
glitchless.setGroup('match', null);                                                   // A7
// Ping, packet loss and disconnects come from the engine's netcode (A8).
// The dedicated server runs the SDK in server mode (A9).
```

```jsonc
{ "pages": [
  { "id": "matches", "title": "Matches", "icon": "play", "panels": [
    { "type": "stat", "metric": "players_now", "title": "Playing now", "size": "s" },
    { "type": "stat", "event": "match_end", "per": "$hours", "title": "Matches per hour played", "size": "s" },           // A1
    { "type": "stat", "event": "match_end:top10=true", "per": "match_end", "title": "Matches that end in the top 10", "size": "s" },
    { "type": "stat", "event": "match_end", "of": "survived_s", "quantile": 50, "title": "Median time alive", "size": "s" }, // A3
    { "type": "distribution", "event": "queue", "of": "wait_s", "by": "mode", "title": "Time waiting for a match", "size": "m" }, // A3
    { "type": "distribution", "event": "match_end", "of": "placement", "title": "Where players finish", "size": "m" },  // A3
    { "type": "breakdown", "event": "landed", "by": "zone", "title": "Where players land", "size": "m" },
    { "type": "positions", "level": "island", "show": "both", "bin": 25, "title": "Where players die, and where they go", "size": "m" },
    { "type": "levels", "label": "Match", "title": "Wins, eliminations and leavers", "size": "l" },
    { "type": "breakdown", "event": "match_end", "by": "$region", "title": "Matches by server region", "size": "m" }  // A6
  ]},
  { "id": "fights", "title": "Fights", "icon": "bolt", "panels": [
    { "type": "breakdown", "event": "fight", "by": "weapon", "rate": "won", "min": 200, "title": "Fights won, by weapon", "size": "m" }, // A2
    { "type": "distribution", "event": "fight", "of": "range_m", "by": "weapon", "title": "How far away fights are", "size": "m" }, // A3
    { "type": "stat", "event": "hit", "per": "shot", "title": "Shots that hit", "size": "s" },                          // A5 (counters)
    { "type": "breakdown", "event": "hit", "by": "weapon", "sum": "damage", "title": "Damage by weapon", "size": "m" }  // A5
  ]},
  { "id": "network", "title": "Network", "icon": "live", "panels": [
    { "type": "stat", "metric": "ping_p95", "title": "Ping for the slowest 5%", "size": "s" },                           // A8
    { "type": "stat", "metric": "disconnect_pct", "title": "Matches ended by a disconnect", "size": "s" },               // A8
    { "type": "net", "show": "ping", "by": "$region", "title": "Ping by server region", "size": "l" },                   // A8, A6
    { "type": "net", "show": "disconnects", "title": "Disconnects and why", "size": "m" },                              // A8
    { "type": "findings", "limit": 5, "title": "What to look at", "size": "m" }
  ]},
  { "id": "servers", "title": "Servers", "icon": "perf", "panels": [
    { "type": "stat", "metric": "servers_now", "title": "Servers running", "size": "s" },                               // A9
    { "type": "stat", "metric": "server_tick_p95", "title": "Server tick, slowest 5%", "size": "s" },                  // A9
    { "type": "stat", "metric": "server_crash_free_pct", "title": "Server runs without a crash", "size": "s" },         // A9
    { "type": "servers", "show": "ticks", "by": "players", "title": "Tick time by players connected", "size": "l" }    // A9
  ]},
  { "id": "performance", "title": "Performance", "view": "performance" },
  { "id": "errors", "title": "Errors", "view": "errors" }
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. Smooth and fair; server or player | Frame time and hitches per level. Nothing about the network | A8 (ping, loss, disconnects), A7 (one ID for the whole lobby), A9 (the server's own ticks) |
| 2. Servers keep their tick rate | Nothing: an Unreal dedicated server sends nothing | A9 |
| 3. Queue and time alive | `wait_s` and `survived_s` get an average and a sum | A3 (median, p90, histogram) |
| 4. Landing and dying | `landed` by zone; deaths by cause; the positions panel | Works today |
| 5. Weapons that win | Fights per weapon. With `won` sent as 1 or 0, a sum breakdown shows wins next to fights | A2 (the rate itself, with how sure it is) |
| 6. Disconnects | `levelAbandon` counts leavers, but can't tell a disconnect from a quit | A8 (`level_abandon` with reason `disconnect`) |
| 7. Stutter on the drop | Frame time by level, gauges, hitch causes | Works today |
| Shots and hits | Hundreds of `track()` calls a minute per player. The queue drops the oldest events, frame windows too | A5 |

### 1.2 MOBA 5v5

Questions:

1. Which heroes win too often or too rarely, at each rank?
2. Which items win games?
3. How long are matches in each mode?
4. How many matches have a leaver, and was it a disconnect or a quit?
5. Does matchmaking take too long at high ranks?
6. Do team fights stutter on low-end PCs?
7. Do new players finish the tutorial and their first match?

```js
glitchless.setProperties({ rank: 'diamond', region: 'na', role_pref: 'support' });   // A6
glitchless.track('tutorial', { step: 'done' });                                     // today
glitchless.track('queue', { mode: 'ranked', wait_s: 95 });                          // today (A3)
glitchless.setGroup('match', match.id);                                             // A7
glitchless.setGroup('party', party.id);                                             // A7
glitchless.levelStart('rift', { mode: 'ranked', hero: 'ember', role: 'mid', party_size: 2 }); // A7
glitchless.setContext({ heroes_in_view: n, particles: m });                         // today
glitchless.count('last_hit');                                                       // A5
glitchless.track('match_end', { hero: 'ember', won: true, duration_s: 1930, items: ['boots', 'blink', 'bkb'] }); // today; the list: A4
glitchless.levelComplete('rift');      // a win; a loss is levelFail('rift', { cause: 'defeat' }), a leaver levelAbandon('rift')
```

```jsonc
{ "pages": [
  { "id": "heroes", "title": "Heroes", "icon": "players", "panels": [
    { "type": "stat", "event": "match_end", "rate": "won", "title": "Matches won", "size": "s",
      "note": "Should sit near 50%: far from it means only some players send data" },                                  // A2
    { "type": "stat", "event": "match_end", "of": "duration_s", "quantile": 50, "title": "Median match", "size": "s" }, // A3
    { "type": "stat", "event": "match_end", "per": "$hours", "title": "Matches per hour played", "size": "s" },         // A1
    { "type": "breakdown", "event": "match_end", "by": "hero", "rate": "won", "min": 100, "limit": 20, "title": "Win rate by hero", "size": "l" }, // A2
    { "type": "breakdown", "event": "match_end", "by": "items", "rate": "won", "min": 100, "limit": 20, "title": "Win rate of builds with each item", "size": "m" }, // A2, A4
    { "type": "breakdown", "event": "match_end", "by": "hero", "limit": 20, "title": "Hero picks", "size": "m" },
    { "type": "distribution", "event": "match_end", "of": "duration_s", "by": "mode", "title": "Match length", "size": "m" }, // A3
    { "type": "distribution", "event": "queue", "of": "wait_s", "by": "$rank", "title": "Time waiting for a match, by rank", "size": "m" } // A3, A6
  ]},
  { "id": "high-ranks", "title": "Diamond and up", "icon": "flag",
    "where": { "$rank": ["diamond", "master", "grandmaster"] },                                                         // A6: a page filter
    "panels": [
    { "type": "breakdown", "event": "match_end", "by": "hero", "rate": "won", "min": 50, "limit": 20, "title": "Win rate by hero", "size": "l" } // A2
  ]},
  { "id": "matches", "title": "Matches", "icon": "play", "panels": [
    { "type": "levels", "label": "Match", "by": "mode", "title": "Wins, losses and leavers by mode", "size": "l" },    // A7
    { "type": "stat", "metric": "disconnect_pct", "title": "Matches ended by a disconnect", "size": "s" },             // A8
    { "type": "funnel", "steps": "tutorial=start,tutorial=done,match_end", "title": "New players to their first match", "size": "m" },
    { "type": "frame_time", "title": "Frame time", "size": "m" },
    { "type": "breakdown", "by": "$device_tier", "title": "Players by GPU", "size": "s" }
  ]},
  { "id": "errors", "title": "Errors", "view": "errors" }
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. Hero balance by rank | Picks per hero. Wins per hero only through a 0/1 sum. No rank split | A2; A6 for rank (`$rank`, a page `where`) |
| 2. Items that win | `items` is stored and never counted | A4 with A2 |
| 3. Match length | An average | A3 |
| 4. Leavers | `levelAbandon` per match; the levels panel shows abandons | A8 to tell a disconnect from a quit |
| 5. Queue time at high ranks | An average of `wait_s`, with no rank | A3 with A6 |
| 6. Team fights stutter | Frame time, gauges, `$device_tier` | Works today |
| 7. New-player funnel | The funnel panel | Works today |

### 1.3 MMO

Questions:

1. How fast do players level, and in which zones do they stall?
2. Which dungeons wipe groups, at which difficulty and with which classes?
3. Is the economy healthy? What are gold earned and spent per hour played, by source and sink, version to version?
4. Do crowded zones and cities lag, on the players' machines and on the server?
5. Do players come back (D1, D7, D30)?

```js
glitchless.setProperties({ class: 'druid', level_band: '30-39', realm: 'pvp', region: 'eu' }); // A6
glitchless.levelStart('westfall');                         // today: a zone is a level that never ends in a win or a fail
glitchless.setContext({ players_nearby: 48, npcs: 120 });  // today
glitchless.count('xp', { source: 'quest', amount: 1200 }); // A5: amounts are summed on the device
glitchless.count('gold', { source: 'loot', amount: 35 });  // A5
glitchless.count('gold_spent', { sink: 'repair', amount: 12 }); // A5
glitchless.track('level_up', { level: 31 });               // today
glitchless.track('reached_cap', { played_h: 412 });        // today: its own event, so its distribution is exact (A3)
glitchless.setGroup('party', party.id);                    // A7
glitchless.levelStart('deadmines', { difficulty: 'heroic', party_size: 5 }); // A7
glitchless.levelFail('deadmines', { cause: 'wipe' });      // today; a clear is levelComplete
```

The level is where the player is: a zone or a dungeon. Zones are started and never completed or failed, so walls
leave them out, since a wall counts only attempts played to an end (SPEC §4). A zone dimension apart from levels would
read better (question 6 in [section 6](#6-open-questions-for-the-owner)).

```jsonc
{ "pages": [
  { "id": "progress", "title": "Progress", "icon": "flag", "panels": [
    { "type": "stat", "event": "xp", "sum": "amount", "per": "$hours", "title": "XP per hour played", "size": "s" },    // A1, A5
    { "type": "stat", "event": "reached_cap", "of": "played_h", "quantile": 50, "title": "Hours to the level cap", "size": "s" }, // A3
    { "type": "breakdown", "event": "xp", "by": "$level", "sum": "amount", "per": "$hours", "title": "XP per hour, by zone", "size": "m" }, // A1, A5
    { "type": "distribution", "event": "reached_cap", "of": "played_h", "by": "$class", "title": "Hours to the level cap, by class", "size": "m" }, // A3, A6
    { "type": "retention", "limit": 30, "title": "Players who come back", "size": "l" }
  ]},
  { "id": "dungeons", "title": "Dungeons", "icon": "play", "panels": [
    { "type": "levels", "label": "Dungeon", "by": "difficulty", "title": "Clears and wipes by difficulty", "size": "l" }, // A7
    { "type": "levels", "label": "Dungeon", "by": "$class", "title": "Clears by class", "size": "m" },                   // A7, A6
    { "type": "levels", "label": "Dungeon", "by": "party_size", "title": "Clears by group size", "size": "m" }           // A7
  ]},
  { "id": "economy", "title": "Economy", "icon": "money", "panels": [
    { "type": "stat", "event": "gold", "sum": "amount", "per": "$hours", "title": "Gold earned per hour played", "size": "s" },      // A1, A5
    { "type": "stat", "event": "gold_spent", "sum": "amount", "per": "$hours", "title": "Gold spent per hour played", "size": "s" }, // A1, A5
    { "type": "series", "event": "gold", "sum": "amount", "by": "source", "title": "Gold earned, by source", "size": "m" },          // A5
    { "type": "breakdown", "event": "gold_spent", "by": "sink", "sum": "amount", "per": "$hours", "title": "Where gold goes, per hour played", "size": "m" }, // A1, A5
    { "type": "versions", "title": "The economy, version by version", "size": "l" }
  ]},
  { "id": "world", "title": "World", "icon": "perf", "panels": [
    { "type": "frame_time", "title": "Frame time", "size": "m" },
    { "type": "servers", "show": "ticks", "by": "$level", "title": "Server tick by zone", "size": "m" },                 // A9
    { "type": "servers", "show": "players", "title": "Players per server", "size": "m" }                                 // A9
  ]},
  { "id": "performance", "title": "Performance", "view": "performance" }
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. Levelling speed by zone | `level_up` counts; the average of `played_h` on `reached_cap` | A3 (hours to the cap), A1 with A5 (XP per hour, by zone) |
| 2. Dungeon wipes by difficulty and class | Clears and fails per dungeon, with no difficulty or class | A7 (attributes on `level_start`), A6 (`$class`) |
| 3. Economy per hour | Sums of gold by source per minute; a `track()` per pickup floods the queue | A5 (summed on the device), A1 (per hour played) |
| 4. Crowded zones lag | Frame time by zone with a `players_nearby` gauge | A9 for the server's side |
| 5. Players come back | Retention in install mode | Works today |

### 1.4 Clash Royale-style mobile 1v1 PvP

Questions:

1. Which cards and decks win, in each arena?
2. Which cards beat which: what is the win rate against decks with a card?
3. How long are battles, and how many go to overtime?
4. How many battles end in a disconnect, on Wi-Fi and on mobile data?
5. Where do new players stall on the trophy road?
6. Does the shop convert, and what do the offers earn?
7. Does the game stutter on low-end Android phones?

```js
glitchless.setProperties({ arena: 'arena_7', trophy_band: '3000-3499' });  // A6
glitchless.setGroup('match', battle.id);                                   // A7
glitchless.levelStart('arena_7', { mode: 'ladder' });                      // A7
glitchless.track('battle_end', {
  won: true, crowns: 3, overtime: false, duration_s: 184,
  deck: ['hog_rider', 'fireball', 'ice_spirit', 'cannon', 'musketeer', 'log', 'skeletons', 'ice_golem'], // A4
  opponent_deck: ['golem', 'night_witch', 'lightning', 'tornado', 'baby_dragon', 'lumberjack', 'barbarian_barrel', 'mega_minion'],
});                                                                        // today, without the lists
glitchless.levelComplete('arena_7');                                       // or levelFail('arena_7', { cause: 'defeat' })
glitchless.track('trophy_road', { arena: 'arena_8' });                     // today
glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gem_pack_s' }); // today
// A8 adds net.link (wifi, cellular) from the engine where the phone says so.
```

```jsonc
{ "currency": "USD", "pages": [
  { "id": "cards", "title": "Cards", "icon": "bolt", "panels": [
    { "type": "stat", "event": "battle_end", "rate": "won", "title": "Battles won", "size": "s" },                      // A2
    { "type": "stat", "event": "battle_end:overtime=true", "per": "battle_end", "title": "Battles that go to overtime", "size": "s" },
    { "type": "stat", "event": "battle_end", "of": "duration_s", "quantile": 50, "title": "Median battle", "size": "s" }, // A3
    { "type": "breakdown", "event": "battle_end", "by": "deck", "rate": "won", "min": 200, "limit": 20, "title": "Win rate of decks with each card", "size": "l" }, // A2, A4
    { "type": "breakdown", "event": "battle_end", "by": "deck", "limit": 20, "title": "Decks with each card", "size": "m" },          // A4
    { "type": "breakdown", "event": "battle_end", "by": "opponent_deck", "rate": "won", "min": 200, "limit": 20, "title": "Win rate against decks with each card", "size": "m" }, // A2, A4
    { "type": "distribution", "event": "battle_end", "of": "duration_s", "title": "Battle length", "size": "m" }        // A3
  ]},
  { "id": "high-arenas", "title": "Arena 10 and up", "icon": "flag",
    "where": { "$arena": ["arena_10", "arena_11", "arena_12"] },                                                        // A6
    "panels": [
    { "type": "breakdown", "event": "battle_end", "by": "deck", "rate": "won", "min": 100, "limit": 20, "title": "Win rate of decks with each card", "size": "l" } // A2, A4
  ]},
  { "id": "ladder", "title": "Trophy road", "icon": "play", "panels": [
    { "type": "breakdown", "by": "$arena", "title": "Players by arena", "size": "m" },                                  // A6
    { "type": "funnel", "steps": "trophy_road=arena_2,trophy_road=arena_3,trophy_road=arena_4,trophy_road=arena_5", "title": "New players up the road", "size": "m" },
    { "type": "levels", "label": "Arena", "title": "Battles by arena", "size": "l" },
    { "type": "stat", "metric": "disconnect_pct", "title": "Battles ended by a disconnect", "size": "s" },             // A8
    { "type": "net", "show": "disconnects", "by": "$link", "title": "Disconnects on Wi-Fi and mobile data", "size": "m" } // A8
  ]},
  { "id": "shop", "title": "Shop", "icon": "money", "panels": [
    { "type": "stat", "event": "purchase", "sum": "amount", "title": "Revenue", "size": "s" },
    { "type": "stat", "event": "purchase", "per": "$players", "title": "Players who bought", "size": "s" },
    { "type": "breakdown", "event": "purchase", "sum": "amount", "by": "item", "title": "Revenue by offer", "size": "m" },
    { "type": "breakdown", "by": "$device_tier", "title": "Players by GPU", "size": "s" }
  ]}
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. Cards and decks that win | Decks are stored, never counted | A4 with A2; A6 for the arena (`$arena`, a page `where`) |
| 2. Win rate against a card | The same | A4 with A2 |
| 3. Length and overtime | The overtime share, as one event's count over another's; length as an average | A3 for the length |
| 4. Disconnects by connection | Nothing | A8, with `net.link` as the split |
| 5. Trophy road | Funnel and levels | Works today |
| 6. Shop | Revenue, conversion, revenue by offer, RevenueCat and the stores | Works today |
| 7. Low-end Android stutter | Frame time and `$device_tier` | Works today |

### 1.5 Diablo 4-style ARPG (PvE co-op)

Questions:

1. Which difficulty tiers do players clear, by class and group size?
2. How long does a dungeon take at each tier?
3. Which builds clear the hardest tiers?
4. How many kills, legendary drops and deaths per hour played? Is the farm too fast or too slow?
5. Does co-op lag or drop players?
6. Does a screen full of monsters stutter? Where, and to what, do players die?

```js
glitchless.setProperties({ class: 'necromancer', season: 's9', play: 'party' });     // A6
glitchless.setGroup('party', party.id);                                             // A7
glitchless.levelStart('nmd_ghoa', {
  tier: 'pit_80', party_size: 3,
  build: ['blood_surge', 'corpse_explosion', 'army_of_the_dead'],                   // A4
});                                                                                 // A7
glitchless.setContext({ monsters: 140, damage_numbers: 300 });                      // today
glitchless.count('kill', { monster: 'elite' });                                     // A5
glitchless.count('loot', { rarity: 'legendary' });                                  // A5
glitchless.death({ x, y, z, cause: 'butcher' });                                    // today
glitchless.levelComplete('nmd_ghoa');                 // today; a fail is levelFail('nmd_ghoa', { cause: 'timer' })
```

```jsonc
{ "pages": [
  { "id": "endgame", "title": "Endgame", "icon": "flag", "panels": [
    { "type": "levels", "label": "Dungeon", "by": "tier", "title": "Clears by tier, with clear times", "size": "l" },  // A7 (times: A3)
    { "type": "levels", "label": "Dungeon", "by": "$class", "title": "Clears by class", "size": "m" },                // A7, A6
    { "type": "levels", "label": "Dungeon", "by": "party_size", "title": "Clears by group size", "size": "m" },       // A7
    { "type": "levels", "label": "Dungeon", "by": "build", "title": "Clears of builds with each skill", "size": "l" } // A7, A4
  ]},
  { "id": "farming", "title": "Farming", "icon": "bolt", "panels": [
    { "type": "stat", "event": "kill", "per": "$hours", "title": "Kills per hour played", "size": "s" },               // A1, A5
    { "type": "stat", "event": "loot:rarity=legendary", "per": "$hours", "title": "Legendaries per hour played", "size": "s" }, // A1, A5
    { "type": "stat", "metric": "deaths", "per": "$hours", "title": "Deaths per hour played", "size": "s" },          // A1
    { "type": "breakdown", "event": "loot", "by": "rarity", "per": "$hours", "title": "Drops per hour played, by rarity", "size": "m" }, // A1, A5
    { "type": "versions", "title": "Farming speed, version by version", "size": "l" }
  ]},
  { "id": "co-op", "title": "Co-op", "icon": "players", "panels": [
    { "type": "stat", "metric": "ping_p95", "title": "Ping for the slowest 5%", "size": "s" },                         // A8
    { "type": "stat", "metric": "disconnect_pct", "title": "Dungeons ended by a disconnect", "size": "s" },            // A8
    { "type": "net", "show": "disconnects", "by": "$play", "title": "Disconnects, alone and in a party", "size": "m" } // A8, A6
  ]},
  { "id": "deaths", "title": "Deaths", "icon": "heatmap", "panels": [
    { "type": "deaths", "title": "Deaths by dungeon and cause", "size": "m" },
    { "type": "positions", "level": "nmd_ghoa", "show": "deaths", "title": "Where players die in the Ghoa dungeon", "size": "m" },
    { "type": "frame_time", "title": "Frame time", "size": "l" }
  ]}
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. Clears by tier, class and group size | Clears and fails per dungeon, with nothing about the attempt | A7 (attributes on `level_start`), A6 (`$class`) |
| 2. Time per dungeon | The levels panel's average clear time | A3 (median and p90 of clear times, by tier) |
| 3. Builds that clear | Nothing | A4 on `level_start`, A7 |
| 4. Farming per hour | Counts and sums per minute; a `track()` per kill floods the queue | A5, A1 |
| 5. Co-op lag and drops | Nothing | A8 |
| 6. Stutter and deaths | Gauges (`monsters`, `damage_numbers`), the climbing-gauge finding, deaths and positions | Works today |

### 1.6 Roguelite

Questions:

1. Which weapons (or characters) win runs, at each heat (difficulty) level?
2. Which boons and relics are in winning runs, and which do players take when offered?
3. How far do runs get, and what ends them?
4. How long is a run, and how many runs do players start per hour?
5. Does the step up in heat work?
6. Do boss fights stutter?

```js
glitchless.setGroup('run');                                         // A7: the SDK makes a new run ID
glitchless.levelStart('tartarus', { heat: 8, weapon: 'stygius' }); // A7: a biome is a level
glitchless.track('boon_offer', { boon: 'zeus_strike', picked: true }); // today: one per option offered (rate: A2)
glitchless.death({ x, y, z, cause: 'megaera' });                    // today
glitchless.levelComplete('tartarus');                               // today
glitchless.track('run_end', {
  won: false, weapon: 'stygius', heat: 8, floor: 14, duration_s: 1420,
  boons: ['zeus_strike', 'athena_dash', 'poseidon_cast'],           // A4
});                                                                 // today, without the list
glitchless.setGroup('run', null);                                   // A7
```

```jsonc
{ "pages": [
  { "id": "runs", "title": "Runs", "icon": "play", "panels": [
    { "type": "stat", "event": "run_end", "rate": "won", "title": "Runs won", "size": "s" },                            // A2
    { "type": "stat", "event": "run_end", "per": "$hours", "title": "Runs per hour played", "size": "s" },              // A1
    { "type": "stat", "event": "run_end", "of": "duration_s", "quantile": 50, "title": "Median run", "size": "s" },     // A3
    { "type": "breakdown", "event": "run_end", "by": "weapon", "rate": "won", "title": "Runs won, by weapon", "size": "m" }, // A2
    { "type": "breakdown", "event": "run_end", "by": "heat", "rate": "won", "order": "value", "title": "Runs won, by heat", "size": "m" }, // A2
    { "type": "distribution", "event": "run_end", "of": "floor", "title": "How far runs get", "size": "m" },          // A3
    { "type": "levels", "label": "Biome", "count": "runs", "title": "Runs that reach each biome", "size": "m" }        // A7
  ]},
  { "id": "choices", "title": "Boons", "icon": "bolt", "panels": [
    { "type": "breakdown", "event": "boon_offer", "by": "boon", "rate": "picked", "min": 50, "limit": 20, "title": "Taken when offered", "size": "m" }, // A2
    { "type": "breakdown", "event": "run_end", "by": "boons", "rate": "won", "min": 50, "limit": 20, "title": "Runs won with each boon", "size": "m" } // A2, A4
  ]},
  { "id": "deaths", "title": "Deaths", "icon": "heatmap", "panels": [
    { "type": "deaths", "title": "What ends runs", "size": "m" },
    { "type": "positions", "level": "tartarus", "show": "both", "title": "Where runs end in Tartarus", "size": "m" },
    { "type": "frame_time", "title": "Frame time", "size": "l" }
  ]}
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. Weapons and heat that win | Runs per weapon; wins only through a 0/1 sum | A2 |
| 2. Boons in winning runs; boons taken | `boon_offer` per boon with `picked`, as counts | A2 (taken when offered), A4 with A2 (boons in a run) |
| 3. How far runs get | The levels funnel counts sessions, and a session holds several runs | A3 (floors reached), A7 (`count: "runs"`) |
| 4. Run length and runs per hour | An average | A3, A1 |
| 5. Heat steps | Nothing by heat | A2 by `heat`; A7 for levels by heat |
| 6. Boss fights stutter | Frame time by level | Works today |

### 1.7 Gacha and idle

Questions:

1. Does a new player get to their first pull and their first purchase?
2. How many pulls does a top-rarity unit take, and does the rate match the published odds?
3. What does a player earn per hour played, and while away?
4. Which banners and offers make money?
5. Is the economy inflating, version to version?
6. Do spenders and non-spenders come back alike?

```js
glitchless.setProperties({ spender: 'none', account_band: '20-29', server: 'asia' }); // A6: bands, never amounts
glitchless.track('pull', { banner: 'summer_2026', top: false });  // today: one per unit pulled (rate: A2)
glitchless.track('top_pull', { banner: 'summer_2026', pity: 63 }); // today (distribution: A3)
glitchless.count('tap');                                           // A5
glitchless.count('gold', { source: 'idle', amount: 1500 });        // A5
glitchless.track('return', { away_s: 28800, earned: 1200000 });    // today (A3)
glitchless.track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' }); // today
```

```jsonc
{ "currency": "USD", "pages": [
  { "id": "pulls", "title": "Pulls", "icon": "bolt", "panels": [
    { "type": "breakdown", "event": "pull", "by": "banner", "rate": "top", "expect": 0.6, "min": 1000, "title": "Top-rarity rate by banner", "size": "l",
      "note": "The line is the published 0.6%: a banner whose range misses it is flagged" },                              // A2
    { "type": "distribution", "event": "top_pull", "of": "pity", "by": "banner", "title": "Pulls to a top-rarity unit", "size": "m" }, // A3
    { "type": "stat", "event": "pull", "per": "$hours", "title": "Pulls per hour played", "size": "s" }               // A1
  ]},
  { "id": "economy", "title": "Economy", "icon": "clock", "panels": [
    { "type": "stat", "event": "gold", "sum": "amount", "per": "$hours", "title": "Gold earned per hour played", "size": "s" }, // A1, A5
    { "type": "distribution", "event": "return", "of": "away_s", "unit": "s", "title": "Time away before coming back", "size": "m" }, // A3
    { "type": "breakdown", "event": "gold", "by": "source", "sum": "amount", "title": "Gold by source", "size": "m" },  // A5
    { "type": "versions", "title": "The economy, version by version", "size": "l" }
  ]},
  { "id": "money", "title": "Money", "icon": "money", "panels": [
    { "type": "stat", "event": "purchase", "sum": "amount", "title": "Revenue", "size": "s" },
    { "type": "stat", "event": "purchase", "per": "$players", "title": "Players who bought", "size": "s" },
    { "type": "funnel", "steps": "tutorial=done,pull,purchase", "title": "First pull, then first purchase", "size": "m" },
    { "type": "breakdown", "event": "purchase", "sum": "amount", "by": "item", "title": "Revenue by offer", "size": "m" },
    { "type": "retention", "title": "Players who come back", "size": "l" }
  ]}
]}
```

| Question | Today | Needs |
| --- | --- | --- |
| 1. First pull, first purchase | Funnel | Works today |
| 2. Pity and odds | Pulls per banner; `top` as counts; the average `pity` | A2 with `expect`, A3 |
| 3. Earned per hour, and while away | Sums of `gold` per minute; `away_s` as an average; a `track()` per tap floods the queue | A5, A1, A3 |
| 4. Banners and offers that make money | Revenue by item, RevenueCat, Stripe | Works today |
| 5. Inflation by version | Sums per version, not per hour played | A1 with a versions panel |
| 6. Retention by spender band | Retention for everyone | A6 for the band; retention split by a property is open question 5 |

## 2. The additions, in order of value

Value is how many of the seven genres need an addition, for how little work. A genre counts 1 when the addition
answers one of its main questions, ½ when it only helps. Work is a rough estimate in engineer-weeks, covering every
engine, the server, Glitchless Cloud's store, the dashboard, MCP, the skills, PRIVACY.md and SPEC.

| | Addition | BR | MOBA | MMO | 1v1 | ARPG | Rogue | Gacha | Genres | Weeks | Value |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Rates per hour played | ½ | | 1 | | 1 | ½ | 1 | 4 | 0.6 | 6.7 |
| A2 | Rates and averages by attribute | 1 | 1 | ½ | 1 | 1 | 1 | 1 | 6.5 | 1.5 | 4.3 |
| A3 | Distributions | 1 | 1 | ½ | 1 | 1 | 1 | 1 | 6.5 | 2 | 3.3 |
| A4 | List attributes ("contains") | ½ | 1 | ½ | 1 | 1 | 1 | ½ | 5.5 | 1.7 | 3.2 |
| A5 | Counters for frequent events | 1 | ½ | 1 | | 1 | ½ | 1 | 5 | 2 | 2.5 |
| A6 | Player and session properties | 1 | 1 | 1 | 1 | 1 | ½ | 1 | 6.5 | 3 | 2.2 |
| A7 | Groups (`match`, `party`, `run`) and level attributes | 1 | 1 | 1 | ½ | 1 | 1 | | 5.5 | 3 | 1.8 |
| A8 | Network quality and disconnects | 1 | 1 | 1 | 1 | ½ | | | 4.5 | 5.5 | 0.8 |
| A9 | Server mode | 1 | 1 | 1 | ½ | ½ | | | 4 | 6 | 0.7 |

The first four are almost all server work: the SDKs already send the data, except Unreal's booleans and lists. A5
to A7 are close in value, within the error of these estimates. They change every SDK, so they go out as one SDK
release (phase 2). A6 is the one the others lean on most: once it ships, rates, distributions and per-hour numbers
can split by rank or class.

Each addition below is written as it would go into SPEC: what it's for, the wire fields, the call in each engine,
the server and its stores, the query and panel changes, MCP, privacy, limits and what happens with older SDKs and
servers.

**Boards on older servers.** All the board changes (`rate`, `avg`, `of`, `quantile`, `per: "$hours"`, `by` on
`levels`, page `where`) share one back-compat rule. Today's `validatePanel` keeps only the fields it knows
(`board.js:192`), and it reads an unknown `per` as an event name. So an older server takes such a board without an
error. It shows the plain panel instead: counts for a rate, an empty "no `$hours` events" for a per-hour stat. And
it stores the board without the new fields, so a board saved there must be saved again after the upgrade. New
panel types (`distribution`, `net`, `servers`) and metrics are refused with a 400, as today. The MCP tool should read
the server's `features` (A5) and say which fields this server doesn't have yet. Every board in section 1 was checked
against today's validator: the panels without a `// A…` mark pass as they are.

### A1. Rates per hour played

**Built** (26 October 2026): now in SPEC §3b (per hour played) and §4 (hours played). Section 8 lists what differs from below.

SPEC: §3b (panels) and §4 (a new derived concept, hours played).

For XP and gold per hour (MMO), kills and legendaries per hour (ARPG), earnings per hour (gacha and idle), and runs or
matches per hour (roguelite, battle royale).

**Hours played** (§4). Hours played is the frame windows' `duration_s` added up: the time the game was on screen
drawing frames.
- Cells already keep it per minute, env, version and level (`sec`), so it's exact over any range, daily rollups
  included, overall and by `$version` and `$level`.
- By `$platform`, `$browser`, `$device_tier` and a property (A6), it comes from each session's own frame windows
  (`s.cell`), over 31 days or less.
- A game in the background has none, so an idle game's time away isn't play: send it as a number
  (`track('return', { away_s })`).
- Server sessions (A9) have none.

**Panels.** `per` takes `$hours` as well as `$players` and `$sessions`:

| panel | with `per: "$hours"` | answer |
| --- | --- | --- |
| `stat` with `event` | the event's count per hour played | `{value, unit: 'per hour', count, hours}` |
| `stat` with `event` and `sum` | the sum per hour played (XP per hour) | `{value, unit: 'per hour', total, hours, currency?}` |
| `stat` with `metric` `deaths` or `errors` | deaths or errors per hour played | `{value, unit: 'per hour', count, hours}` |
| `series` | each bucket's count or sum over the hours played in that bucket. `by` `$version` or `$level`: each line over its own hours. `by` an attribute: every line over all hours | `{ts, series, hours: [...]}` |
| `breakdown` | each row per hour played. By `$version`, `$level`, a session split or a property: each row over its own hours. By an attribute: every row over the window's hours, as in gold from each source per hour played | rows add `hours` |

- A `versions` panel compares a per-hour stat version by version, each over its own hours.
- `stat` gains the metric `hours_played`.
- A bucket or row with under 6 minutes of play shows no rate (`null`, with `why`), so near-empty buckets don't spike.
- In words: "1,240 XP per hour played (1.4: 980)".

**Query.** `overview.kpis` gains `hours_played`. The `events` query adds `hours`, the hours played in the range, so an
agent can turn any count into a rate.

**MCP.** `glitchless_set_dashboard`: `per` takes `$hours`, and `metric` takes `hours_played`. `glitchless_events`
answers `hours`. The dashboard skill lists "per hour played" next to conversion.

**Privacy.** Nothing new is sent.

**Back-compat.** Every SDK already sends `duration_s` on frame windows, and every stored cell has `sec`, so
per-hour numbers work over all history. Older dashboards are unchanged.

**Work.** About 3 days: `board.js` (validation, `panelData`), `analytics.js` (hours from cells and sessions),
`sums.js` (sums per hour), the dashboard's units, MCP and skills.

### A2. Rates and averages by attribute

**Built** (26 October 2026): now in SPEC §3b (rates and averages) and §6 (`evb`). Section 8 lists what differs from below.

SPEC: §3b (panels), §6 (cells).

For win rate by hero (MOBA), by weapon (BR), by card and deck (1v1, with A4), by weapon and heat (roguelite), clear
rate by class (ARPG), the share of boons taken when offered, and a gacha banner's top-rarity rate against its
published odds.

**Panel fields** on `stat`, `series` and `breakdown`:

| field | |
| --- | --- |
| `rate` | A boolean attribute of the event, or a number that is 0 or 1. Unreal sends numbers until its booleans ship (A4). It gives the share of events where the attribute is true; with `by`, one share per row |
| `avg` | A numeric attribute: its mean per event, per row |
| `min` | Rows with fewer events than this are left out of the rows and counted in `small`. Default 30 for `rate`, 10 for `avg` |
| `expect` | For `rate`: a percentage the game intends or publishes, such as a gacha's stated odds. Rows whose interval leaves it out are marked, and the balance finding (§4) can name them |
| `order` | `rate` (the default: highest first), `count` or `value` (in the values' own order, such as heat 0, 1, 2) |

**Answers.**
- A rate row is `{value, rate, events, low, high, sessions}`, where `rate`, `low` and `high` are percentages and
  `low` to `high` is the 95% Wilson interval. An average row is `{value, avg, events, sessions}`.
- Every answer has `overall`, the rate or average over all of the event's events: the normal value to show next to
  each row.
- A `stat` answers `{value, unit: '%', events, low, high}`, and a `versions` panel compares it.
- A `series` gives the rate per bucket, `by` `$version` or an attribute.

The dashboard draws each row as a bar with its interval as a whisker, and the overall rate as a line across the
rows. A row whose interval misses the line is drawn in the accent. In words: "Ember wins 54% of 1,240 matches (all
heroes: 50%)". A whisker that is too wide to mean anything tells people to wait for more matches.

**Storage.**
- Cells gain `evb`, a count of `[trues, events]`:
  - per name and boolean attribute;
  - per name, boolean attribute and each string or boolean value of the same event. Keys are made the way `evx`'s
    are (`sumKey(name, attr, '', key, value)`).

  The cap is 400 a cell, as for `evx` (`MAX_EVENT_SUMS`); past it, `(other)`. `mergeCell`, the cells' JSON form,
  hour summaries and daily rollups carry `evb` the way they carry `evx`.
- Numbers that are 0 or 1 are already summed in `evs` and `evx`. Their rate is the sum over the events, so it works
  over all history.
- Averages are `evs` and `evx` too (the sum over the events), so they need no new storage.
- By `$version` and `$level`, rates and averages come from the cells, over any range.
- By `$platform`, `$browser`, `$device_tier` and a property (A6), they come from the sessions. Each session already
  counts its events' `true` and `false` per attribute (`ev[name].a[key].v`) and sums its numbers for an average, so
  these are exact over 31 days or less.

**Words, not booleans.** A rate is of a boolean. An outcome sent as a word (`result: 'win'`) has no rate, because
the cells don't count two attributes together. The instrument and dashboard skills ask for `won: true`, and a game
can send both (open question 7).

**MCP.**
- The panel schema gains `rate`, `avg`, `min`, `expect` and `order`.
- `glitchless_events` gains `rate` or `avg` with `by` (an attribute, `$version`, `$level`, a session split or a
  property). `{ name: "match_end", rate: "won", by: "hero" }` answers the rows.
- Its list of attributes shows each boolean's rate and each number's average.

**Privacy.** Nothing new is sent.

**Limits.** At most 20 rows. A split by an attribute takes the event by name only, as `sum` does today. Two
attributes at once, such as hero at a rank, need a filter: a page `where` on a property (A6), or the board's filter.

**Back-compat.** `evb` counts from the release. A boolean rate over a range that starts earlier says from when
(`meta.note`). 0/1 numbers and averages work over all history.

**Work.** About 1.5 weeks: `rollups.js`, `board.js`, `sums.js` (shared with `evx`), `daily.js`, the breakdown and stat
renderers, MCP, skills and SPEC.

### A3. Distributions

**Built** (26 October 2026): now in SPEC §3b (distributions) and §6 (`evq`). Section 8 lists what differs from below.

SPEC: §3b (a new panel and a stat field), §6 (cells).

For match length (BR, MOBA, 1v1), time waiting for a match, time alive and placement (BR), hours to the level cap
(MMO), clear times (ARPG), floors reached and run length (roguelite), and pulls to a top unit and time away (gacha).

**Panel** `distribution`:

| field | |
| --- | --- |
| `event` | A name, or a name with one `key=value` |
| `of` | A numeric attribute |
| `by` | Optional: an attribute, `$version`, `$level`, a session split or a property |
| `limit` | Rows with `by`, at most 8 (default 5) |
| `bins` | Histogram bars, at most 40 (default 20) |
| `unit` | Shown after numbers (`s` reads as minutes or hours when large) |

It answers `{count, p50, p90, p99, min, max, mean, bins: [{lo, hi, count}], under, over}`, and with `by` also
`rows: [{value, count, p50, p90, mean}]`.
- Bins are equal steps from the 1st to the 99th percentile, at round sizes (1, 2 or 5 × 10ⁿ). `under` and `over`
  count what falls outside.
- Bins are whole numbers when every value is one, such as placements and floors.
- In words: "Half of matches end within 14 minutes, and 1 in 10 lasts over 26 (1.4: over 31)".

`stat` takes `of` with `quantile` (1 to 99) for one percentile, and a `versions` panel compares it. The `levels`
panel's rows add `p50_complete_s` and `p90_complete_s` from the durations of completed attempts, which marks
already keep.

**Storage.**
- Cells gain `evq`: per name and numeric attribute, a sketch of its values. It works like the frame-time sketch
  (§2), at 5% relative accuracy (about 23 bins a decade). A cell holds at most 32; past that, the event's
  distribution says `partial`.
- Negative values go in a mirrored sketch. Zeros go in its zero count.
- Sketches merge exactly across minutes, hours and days. So the whole distribution, and its split by `$version` or
  `$level`, are right to within 5% over any range.

**By an attribute, a session split or a property, or for a filtered event**, the values come from each session's
first 16 occurrences of the event (its `o`, as ordered funnels use), over 31 days or less.
- This is exact while no session sent more than 16 of the event; otherwise the answer says `estimated`, and from
  how many sessions.
- Over more than 31 days, it comes from the day's funnel sample (256 sessions a day) and is named in
  `meta.approximate`.
- So the skill says: send what you want measured once per match or run (`match_end`, `top_pull`), not on every hit.
  Keeping a sketch per attribute value in the cells would be exact, but would make cells about ten times bigger
  (open question 8).

**MCP.** The panel schema gains `distribution`, `of`, `quantile`, `bins` and `unit`. `glitchless_events` adds `p50`,
`p90` and `p99` for each numeric attribute, and takes `of` and `by` for one distribution.

**Privacy.** Nothing new is sent.

**Limits.** 32 sketched attributes a cell. Splits come from occurrences, as above.

**Back-compat.** From the release, with the events query keeping `avg`. Older dashboards are unchanged.

**Work.** About 2 weeks. That is the cells and sketches, the occurrence path, daily rollups, a check of Glitchless
Cloud's hour-summary size on real games, a histogram chart in the dashboard, MCP, skills and SPEC.

### A4. List attributes and "contains"

**Built** (26 October 2026): now in SPEC §2 (`custom`), §3b (lists, occurrences) and §6 (`evl`, `evlb`, `evlx`). Section 8 lists what differs from below.

SPEC: §2 (`custom`), §3b, §5c (Unreal).

For decks (1v1), items and team picks (MOBA), builds (ARPG), boons and relics (roguelite), loadouts (BR), group roles
(MMO) and teams (gacha).

**Wire.**
- An attribute of `custom`, and of `level_start` (A7), can be a list of strings, numbers or booleans.
- The first 16 distinct elements are counted, each string cut to 64 characters.
- A list is one of the event's 12 attributes.
- Lists of objects, and lists inside lists, are left out, as they are today.

**What it means.** Each element is a value the event contains.
- `match_end:items=blink` matches a `match_end` whose `items` has `blink`, wherever an event is written: stats, funnels,
  `sent`, the live tail.
- A breakdown by a list attribute has a row per element: the events whose list has it, with `share` (the % of the
  events). The rows add up to more than the event's count, and the panel's line says so: "a battle counts once under
  each card in its deck".
- With `rate`, `avg` or `sum` (A2), each element gets its own number: "decks with Hog Rider win 53% of 4,100 battles
  (all decks: 50%)".

**Storage.**
- `smallAttrs` keeps lists.
- Cells gain `evl`: events per name, attribute and element, with a cap of 1,000 a cell. It is kept apart from
  `evv`'s 400, so a game with 120 cards doesn't push its other attributes into `(other)`.
- Cells also gain `evlb` and `evlx`, rates and sums per element, at 1,000 each.
- Sessions count each element as a value (`ev[name].a[key].v`, up to 40 a session, then `(other)`) and keep lists in
  their occurrences.
- Every matcher treats a list as "contains": `eventCount`, `cellCount`, `sessionEventCount`, `placeEvents`,
  `eventFunnel`, `sumsBy` and the live tail's filter.

**SDKs.**
- The browser, Unity, Godot and GameMaker SDKs send lists today. Unity's `Json.Write` writes any `IEnumerable`, Godot
  sends an `Array`, and GameMaker an array. Only their tests and READMEs change.
- Unreal's public `Track` takes strings and numbers only, so it gains an attribute builder. The core's value type
  already writes booleans and lists (`GlitchlessCore.cpp:327-338`):

```cpp
FGlitchlessAttributes A;
A.Add(TEXT("deck"), TArray<FString>{ TEXT("hog_rider"), TEXT("fireball") });
A.Add(TEXT("won"), true);
A.Add(TEXT("duration_s"), 184.0);
FGlitchless::Track(TEXT("battle_end"), A);
```

In Blueprint, the builder is a `Glitchless Attributes` struct with strings, numbers, flags and string lists. A list
is an `FGlitchlessStringList`, because a Blueprint map can't hold arrays. It comes with a Make node and a
`Track Event (Attributes)` node. Booleans arrive with it, so `rate` reads Unreal's `won` as a boolean from then on.

**Privacy.** A list holds the game's words, like any attribute. Never a list of people: party members' names or
friends. PRIVACY.md's "Game words" paragraph says so.

**Limits.** 16 elements an event; 1,000 element counts a cell. Pairs ("Hog Rider with Ice Spirit") aren't counted
(open question 9).

**Back-compat.** Lists sent before the release are in the stored events. The file store rebuilds its cells when it
starts, so it counts them from then; Glitchless Cloud's summaries count from the release. Older servers ignore lists,
as they do now.

**Work.** About 1.7 weeks: `rollups.js`, `session-state.js`, the matchers in `analytics.js` and `sums.js`,
`daily.js`, Unreal's builder and Blueprint nodes with their tests, MCP, skills and SPEC.

### A5. Counters for frequent events

**Built** (26 October 2026): the SDKs in phase 2, the server in phase 3: now in SPEC §1, §2 (`counts`, `GET /v1/health`
`features`), §3 (`counted`), §4 (burst) and §6 (`evk`). Section 9 lists what differs from below.

SPEC: §1 and §5–5d (a new call), §2 (a new event type), §3b.

For shots and hits (BR), last hits and abilities (MOBA), kills and loot (ARPG, roguelite), XP and gold (MMO), and taps and
earnings (idle). These are streams of events: one `track()` each would fill the 2,000-event queue in a minute, and the
SDK would then drop the oldest events, frame windows included.

**Calls.**

| engine | call |
| --- | --- |
| Browser | `glitchless.count(name, attrs = {}, n = 1)` |
| Unity | `Glitchless.Count(string name, object what = null, int n = 1)` (a `Dictionary<string, object>` passes through, as with `Track`) |
| Godot | `Glitchless.count(name: String, what: Variant = null, n := 1)` |
| Unreal | `FGlitchless::Count(const FString& Name, const FGlitchlessAttributes& Attributes = {}, int32 N = 1)`; Blueprint `Count Event` |
| GameMaker | `glitchless_count(_name, _what = undefined, _n = 1)` |

**On the device.** A call queues no event.
- The SDK keeps one entry per name and group in the current window. That is the 5 s frame window; in Godot and
  GameMaker, the 5 s flush interval.
- The group is the call's string and boolean attributes, at most 4 of them. Its numbers, at most 4, are summed, and
  `n` adds to the count.
- `levelStart` closes the window, so counts keep their level.
- A window holds at most 64 entries. Past that, a new group of a name already counted goes under that name with its
  attributes as `(other)`. A new name is dropped and added to `dropped`.
- In a debug build, a name sent with `track()` more than 20 times a second gets one warning that names `count()`.

**Wire.** A new event type, `counts`, is sent once for each window that counted anything:

```json
{ "type": "counts", "ts": 1760540000000, "level": "nmd_ghoa", "duration_s": 5, "dropped": 0,
  "counts": [
    { "name": "kill", "attrs": { "monster": "elite" }, "n": 37, "first_ts": 1760540000412 },
    { "name": "gold", "attrs": { "source": "loot" }, "n": 52, "sums": { "amount": 1820 }, "first_ts": 1760540000100 } ] }
```

**Server.** Intake takes `counts`. Each entry folds into cells and sessions the way `n` custom events with those
attributes would:
- Cells: `ev` and `evv` count `n`. Each sum goes into `evs` and `evx` with `n` events. `evb` (A2) gets `n` trues where
  a boolean in the group is true.
- Sessions add `n` to the name's count and values, and the sums to its sums. They keep one occurrence at `first_ts`,
  so a funnel step reached by a counter counts as reached at its first one.
- A counter has no distribution (A3), since its values were summed on the device.
- Counters count as play (`last_play`). Breadcrumbs show them once a window (`kill ×37`), and each window's counts
  can be read next to its hitches, as gauges are (finding 13).
- Every panel reads a counter by its name, like any event: `stat` with `kill` per `$hours`, `breakdown` by `monster`,
  `sum: "amount"`. The events query marks it `counted: true`.

**MCP.** `glitchless_events` shows counters with `counted: true`. The instrument skill's rule: track a moment, count
a stream.

**Privacy.** The same as custom events: names and attributes are the game's own words. Each PRIVACY.md gains a
`counts` row in its event table.

**Limits.** 64 entries a window; 4 group attributes; 4 summed numbers; `n` up to 1,000,000 a call.

**Back-compat.** An older server drops event types it doesn't know (`ingest.js:89`). So each SDK reads `features`
from `GET /v1/health` when it starts (a new field). Against a server without `counts`, it sends no counters and warns
once, so it never sends half the data. Glitchless Cloud gets the feature in the same release.

**Work.** About 2 weeks: five SDKs and their tests, `ingest.js`, `rollups.js`, `session-state.js`, `facts.js`, MCP,
skills, PRIVACY.md and SPEC.

### A6. Player and session properties

**Built** (26 October 2026): now in SPEC §2 (`props`), §3 (`prop.<key>=`, `by_prop`, `properties`), §3b (`$<key>`
splits, page `where`, retention and versions by property), §4 (property lean, slow setting) and §4b. Section 9 lists what
differs from below.

SPEC: §1 and §5–5d (calls), §2 (`session_start.props`, a `props` event), §3 (filters), §3b (`$name` splits, page
`where`), §4b (privacy).

For rank (MOBA, 1v1), class and level band (MMO, ARPG), region (all online games), mode and input (BR), arena (1v1),
and spender and account bands (gacha). With properties, any panel can split by what holds for a session, and a page
can show only the high ranks.

**Player or session?** Both are one kind of property. In anonymous mode there is no player to attach a property to,
so the game sets what it knows about the player (rank, class) at the start of each session, and the SDK stores
nothing on the device. A property never outlives its session, which keeps anonymous sessions apart. Properties are
not copied into every event's attributes (super properties). That way they don't use up an event's 12 attributes,
and they aren't repeated on the wire: the server splits events by the session they came from.

**Calls.** `null` removes a property.

| engine | at start | later |
| --- | --- | --- |
| Browser | `Glitchless.init({ properties: { mode: 'squads' } })` | `glitchless.setProperties({ rank: 'gold' })` |
| Unity | `GlitchlessOptions.Properties` (`Dictionary<string, object>`) | `Glitchless.SetProperty("rank", "gold")`, `Glitchless.SetProperties(dict)` |
| Godot | `options.properties` | `Glitchless.set_property("rank", "gold")`, `Glitchless.set_properties({"rank": "gold"})` |
| Unreal | `FGlitchlessOptions::Properties` (`TMap<FString, FString>`) | `FGlitchless::SetProperty(TEXT("rank"), TEXT("gold"))` (string, number and boolean overloads); Blueprint `Set Glitchless Property` |
| GameMaker | `options.properties` (a struct) | `glitchless_set_properties({ rank: "gold" })` |

**Wire.**
- `session_start.props` holds the properties set before the session's first batch was cut: `{ "rank": "gold",
  "region": "eu" }`.
- A new event, `props`, carries a later change: `{ "type": "props", "ts": …, "level": …, "props": { "rank":
  "platinum", "party": null } }`. It lists only the keys that changed since the last one, with `null` for a key
  removed. The SDK sends at most one a window, with each key's last value, and a call that changes nothing sends
  nothing.

**Rules.** The SDK drops what breaks these and warns once in a debug build. Intake drops it again, for older or other
SDKs.
- Keys match `^[a-z][a-z0-9_]{0,31}$`, at most 12 a session.
- Values are a string (trimmed, up to 64 characters), a boolean or a whole number from −1,000,000 to 1,000,000.
  Fractions are dropped, and the skill asks for bands (`level_band: '30-39'`) rather than exact numbers.
- Reserved keys can't be used. These are the built-in splits and filters (`version`, `level`, `env`, `platform`,
  `browser`, `device_tier`, `session_type`, `privacy`, `role`, `link`, `type`, `players`, `sessions`, `hours`) and
  the Steam facts.
- Never identifying, so these keys are dropped by name: `name`, `username`, `user`, `email`, `phone`, `user_id`,
  `account`, `account_id`, `player_id`, `steam_id`, `epic_id`, `psn_id`, `xbox_id`, `ip`, `address`, `device_id`,
  `idfa`, `gaid`, `ad_id`, `location`, `lat`, `lon`, `city`, `birthday`, `age` and `gender`.
- Values are dropped by shape too: an email address, a URL, a phone number or any run of 7 or more digits, a UUID,
  or 16 or more characters of hex or base64 with no spaces.

**Server.**
- Each session keeps `props: { key: [value, ts] }`: the latest value of each key by time, merged the way `startAt` is.
  So a session has one value per property.
  - A property is for what holds for a session: rank, class, region, mode, input, a band.
  - What changes from match to match belongs on the events or on `level_start` (A7): hero, deck, map.
- Splits: `by: "$<key>"` works wherever `$platform` does: series and breakdowns, counts, rates and averages (A2),
  distributions (A3), hours (A1), and levels (A7). Sessions without the property are `(none)`. A split shows the top
  40 values; the rest are `(other)`.
- Filters: every query takes `prop.<key>=<value>`, which keeps the sessions with that value (`meta.where` says so).
  A board page can carry `where`, such as `{ "$rank": "diamond" }` or a list of values, and every panel on the page
  reads only those sessions.
  - These read raw events, as the Steam filters do. On Glitchless Cloud that covers the last 31 days of a longer
    range, which `meta.note` says.
- `performance` takes `by_prop=<key>`: frame time, hitches and crash-free sessions per value, from the sessions'
  own frame windows.
- A property with more than 200 values in a day reads as `(too many values)`. `glitchless_events` names it
  `identifier_like: true`. This guards against a property that is really an ID.
- Over more than 31 days, splits by a property say they can't be answered, as `$platform` does
  (`board.js:549-552`).
- Glitchless Cloud: session states carry `props` the way they carry `device`, and the raw-row filters learn
  properties the way they know the Steam facts.

**MCP.**
- `by` takes `$<property>`.
- Every query tool's filters take `props: { rank: "diamond" }`.
- `glitchless_events` lists `properties: [{key, values: [{value, sessions, players}], identifier_like}]`.
- `glitchless_set_dashboard` takes a page `where`.
- `glitchless_performance` takes `by_prop`.
- The dashboard skill asks which properties hold for a session. The instrument skill sets them where the game knows
  them: after sign-in, at the menu, at matchmaking.

**Privacy.** Properties go with the session in every mode, as event attributes do. They are the game's words about
the session, never about the person. In anonymous mode no ID links one session's properties to another's. The
checks above drop the shapes that identify, and the 200-values guard catches a property that does it another way.
Each PRIVACY.md gains a section:

> **Properties: the game's words about the session.** A game can describe the session with `setProperties`, for
> example its mode, the player's rank tier or class, or the region of the game's servers. Properties go with the
> session in every mode. They are checked before they are sent: keys such as `email`, `user_id` or `steam_id`, and
> values that look like an email address, a phone number, an ID or a link, are dropped. A property is not a player
> ID: in anonymous mode nothing ties one session's properties to another session.

and a paragraph for the game's privacy page:

> The reports also say what you were doing in the game in the game's own terms, such as the mode, your rank tier or
> class, and the server region you play on. They never say who you are.

**Limits.** 12 keys; values as above; 40 values a split; at most one `props` event a window.

**Back-compat.**
- Older servers keep `session_start.props` inside the stored event, since intake keeps fields it doesn't read, and
  drop `props` events.
- Once a file store is updated, it rebuilds from its events, so the properties sessions had at the start split
  from then. Changes made later in those sessions are lost.
- Sessions from older SDKs are `(none)`.

**Work.** About 3 weeks: five SDKs with their checks and tests, `ingest.js`, `session-state.js`, the splits and
filters in `analytics.js`, `board.js`, Glitchless Cloud's raw-row filters, the dashboard's filter bar and page filter,
MCP, skills, five PRIVACY.md files and SPEC.

### A7. Groups (`match`, `party`, `run`) and level attributes

**Built** (26 October 2026): now in SPEC §2 (`group`, the group fields, `level_start.attrs`), §3 (`matches`, `funnel_by`),
§3b (levels `by`, `level` and `count: "runs"`, deaths `by`, the metric `runs`, zones) and §4 (wall at one value).
Zones (decision 6) were built with it. Section 9 lists what differs from below.

SPEC: §1 and §5–5d (calls), §2 (`level_start.attrs`, a `group` event, group fields), §3 (a `matches` query), §3b,
§4b (privacy).

Level attributes are for clears by difficulty and group size (ARPG, MMO), mode and squad size (BR, MOBA) and heat
(roguelite). Groups are for comparing everyone in one match (BR, MOBA, 1v1, the lobby finding), parties (MMO, ARPG)
and runs that span several levels (roguelite).

**Level attributes.**

| engine | call |
| --- | --- |
| Browser | `glitchless.levelStart('nmd_ghoa', { tier: 'pit_80', party_size: 3 })` |
| Unity | `Glitchless.LevelStart("nmd_ghoa", new Dictionary<string, object> { ["tier"] = "pit_80", ["party_size"] = 3 })` |
| Godot | `Glitchless.level_start("nmd_ghoa", {"tier": "pit_80", "party_size": 3})` |
| Unreal | `FGlitchless::LevelStart(TEXT("nmd_ghoa"), Attributes)` with `FGlitchlessAttributes` (A4); Blueprint `Level Start` gains an Attributes pin |
| GameMaker | `glitchless_level_start("nmd_ghoa", { tier: "pit_80", party_size: 3 })` |

- On the wire, `level_start` gains `attrs`, with the same rules as a custom event's attributes (12 of them, strings up
  to 64 characters, lists as in A4).
- Levels an SDK starts by itself (scenes, maps, rooms) have none.
- The attempt's outcome and its deaths don't repeat the attributes. The server pairs each with the attempt it ends,
  since marks are kept in order.

On the server:
- A start mark keeps `a`, its attributes.
- The `players` query's funnel and the `levels` panel take `by`: an attribute of `level_start`, a property (A6) or a
  session split. Rows then go per level and value, or per value of one `level`.
- The `deaths` panel takes `by` as well.
- The wall rule (§4) compares a level's rows with each other (finding 10).
- Daily rollups fold funnels by the first 3 attributes, with 20 values each a level and day. Past that the funnel
  is named in `meta.approximate`.

**Groups.** There are three kinds:

| kind | made by | lasts | for |
| --- | --- | --- | --- |
| `match` | the game's server, shared by everyone in the match, lobby or battle | the match | the lobby finding, a match's timeline from every side |
| `party` | the game's server when the party forms | until the party breaks up. Never a guild, clan or friends list | parties against players alone |
| `run` | the SDK (`r_` and 12 characters) | the run | runs across levels (roguelites) |

| engine | call |
| --- | --- |
| Browser | `glitchless.setGroup('match', id, attrs?)`; `setGroup('match', null)` ends it; `setGroup('run')` makes a run ID and returns it |
| Unity | `Glitchless.SetGroup("match", id)`, `Glitchless.SetGroup("run")`, `Glitchless.SetGroup("match", null)` |
| Godot | `Glitchless.set_group("match", id)`, `Glitchless.set_group("run")`, `Glitchless.set_group("match", null)` |
| Unreal | `FGlitchless::SetGroup(EGlitchlessGroup::Match, Id)`, `ClearGroup(EGlitchlessGroup::Match)`; Blueprint `Set Group`, `Clear Group` |
| GameMaker | `glitchless_set_group("match", id)`, `glitchless_set_group("match", undefined)` |

- IDs are 8 to 64 characters of `[A-Za-z0-9_.:-]`. Anything else is dropped.
- A `group` event goes out when a group is set or cleared: `{ "type": "group", "kind": "match", "id": "m_8f2c…",
  "attrs": { "mode": "squads", "players": 100 } }`, with `id: null` when it ends.
- While a group is set, every event carries it as a field, as it carries `level`: `"match": "m_8f2c…"`, `"party"`,
  `"run"`.

**Runs and anonymous mode.** The SDK makes run IDs and keeps them in memory.
- In install and full mode, `setGroup('run', savedId)` resumes a run the game saved, so a run that goes on after a
  restart keeps its ID.
- In anonymous mode, a passed run ID is swapped for a new one, with `resumed: true` on the `group` event. Nothing
  ties two launches together.

**Server.**
- Each session keeps `groups: [{kind, id, from, to, attrs}]`, up to 32.
- The `levels` panel takes `count: "runs"`: each run counted once at each level it reached, so runs reached and
  not sessions.
- `stat` gains the metric `runs`.
- A new query, `matches`, lists the range's matches: `{id, from, to, sessions, level, attrs, outcomes,
  disconnects, ping_p95}`.
- `matches?id=` gives one match: its sessions' timelines lined up from the match's first event, their frame and
  network windows in 30-second slots (A8), and the server's windows (A9).
- These read raw events (on Glitchless Cloud, the last 31 days).
- Session timelines show their groups.

**MCP.** `glitchless_player_funnel` takes `by`. `glitchless_session` shows groups. A new `glitchless_match` takes an
ID, or lists the range's worst matches by lag or disconnects.

**Privacy.** Each PRIVACY.md gains:

> **Groups.** A game can mark the events of one match, party or run with an ID. Match and party IDs are made by the
> game's servers for that match or party and shared by the players in it. They are never a player's account, guild
> or friends-list ID. They say that some sessions played together, not who played. Run IDs are made by the SDK. In
> anonymous mode, a run that goes on after the game restarts gets a new ID, so no ID ties two launches together.

Whether to hash match and party IDs before sending is open question 2.

**Limits.** 3 kinds; IDs of 8 to 64 characters; 32 groups a session.

**Back-compat.** Older servers keep `level_start.attrs` and the group fields in stored events and drop `group`
events. A file store counts the attributes once updated, since it rebuilds from its events.

**Work.** About 3 weeks: five SDKs (attributes, groups and the field in each `push`: `core.js:650`,
`GlitchlessCore.cs:972`, `glitchless.gd:1155`, `GlitchlessCore.cpp:1513`, `__glitchless_core.gml:1135`),
`session-state.js` marks and groups, the funnel, `daily.js`, the `matches` query, the dashboard's levels split and
match page, MCP, PRIVACY.md and SPEC.

### A8. Network quality and disconnects

**Built** (26 October 2026): the SDKs in phase 2, the server in phase 3: now in SPEC §2 (`frame_window.net`, `disconnect`,
`reconnect`), §3 (`performance.network`), §3b (`net`, the metrics, `$link`) and §4 (lag, lobby spike, network findings).
Section 9 lists what differs from below.

SPEC: §1 and §5–5d (sources and calls), §2 (`frame_window.net`, `disconnect`, `reconnect`), §3b, §4.

For lag, packet loss and dropped players in every online game: BR, MOBA, MMO, 1v1, and co-op ARPGs.

**What is measured.** Once a second while connected, the SDK takes the round trip, packet loss, jitter and
throughput from the engine's networking. Each frame window then gains:

```json
"net": { "rtt": { "a": 0.05, "b": { "…": 1 }, "n": 5, "z": 0 }, "rtt_p50": 38, "rtt_p95": 61, "rtt_max": 74,
         "jitter_ms": 6, "loss_pct": 0.4, "in_kbps": 92, "out_kbps": 31, "samples": 5,
         "transport": "ngo", "link": "wifi", "host": false }
```

- `rtt` is a sketch (§2) at 5%, so the server merges ping percentiles the way it merges frame times.
- `transport` names the library.
- `link` is `wifi`, `cellular`, `wired` or null, where the device says (Unity `Application.internetReachability`,
  Unreal `FPlatformMisc::GetNetworkConnectionType`, the browser's `navigator.connection.type`).
- `host` is true for the player who hosts a listen server, whose own round trip is zero.
- Windows while not connected have no `net`.

**Disconnects.**
- A `disconnect` event: `{ "reason": "timeout" | "connection_lost" | "kicked" | "server_closed" |
  "failed_to_connect" | "other", "connected_s": 612, "rtt_p95": 240, "loss_pct": 12 }`, with the numbers of the
  window before it.
- A `reconnect` event: `{ "after_s": 9 }`.
- With a level open, the SDK also sends `level_abandon` with `reason: "disconnect"`: the disconnect outcome. It is
  never a fail, never a rage quit, and walls leave it out (§2, §4).
- A player who reconnects and plays on in the same level takes the abandon back, as one coming back from the
  background does today (§2).

**Where each engine reads it.** Libraries are found at run time, as the Steam facts are (§4c), so no SDK depends on
any of them.

| engine | round trip, loss, jitter | disconnects |
| --- | --- | --- |
| Unity | Netcode for GameObjects: `UnityTransport.GetCurrentRtt(ServerClientId)`. Mirror: `NetworkTime.rtt`. Fish-Net: `TimeManager.RoundTripTime`. Photon PUN 2: `PhotonNetwork.GetPing()`. Photon Fusion: `NetworkRunner.GetPlayerRtt`. These give round trips only: loss is null unless the game passes it | NGO `OnClientDisconnectCallback`, `OnTransportFailure`; Mirror `NetworkClient.OnDisconnectedEvent`; PUN's `OnDisconnected(cause)` |
| Godot | `ENetMultiplayerPeer.get_peer(1).get_statistic()`: `PEER_ROUND_TRIP_TIME`, `PEER_ROUND_TRIP_TIME_VARIANCE` (jitter), `PEER_PACKET_LOSS` over `PACKET_LOSS_SCALE` | `multiplayer.server_disconnected`, `multiplayer.connection_failed` |
| Unreal | The client's `UNetDriver::ServerConnection`: `AvgLag`, `GetInLossPercentage()` and `GetOutLossPercentage()`, `InBytesPerSecond`, `OutBytesPerSecond`; `APlayerState::GetPingInMilliseconds()` as a fallback. To confirm on 5.8 | `GEngine->OnNetworkFailure()` (`ConnectionLost`, `ConnectionTimeout`, `FailureReceived`, `PendingConnectionFailure`), `OnTravelFailure()` |
| Browser | `instrumentNet(glitchless, { peer })` reads an `RTCPeerConnection`'s `getStats()`: the candidate pair's `currentRoundTripTime`, `inbound-rtp` `packetsLost` and `jitter`. A WebSocket has no round trip of its own, so the game passes its ping | the game calls `glitchless.disconnect({ reason })` |
| GameMaker | `glitchless_net_sample(rtt_ms, loss_pct)`, from the game's own ping | `glitchless_disconnect(reason)` |
| Every SDK | `netSample({ rtt_ms, loss_pct, jitter_ms })`, `disconnect({ reason })`, `reconnect()`: for any other library (Steam Networking Sockets, Epic Online Services, Nakama, Colyseus, a game's own) | |

**Server.**
- Cells gain `net`: a round-trip sketch, loss and jitter as `[sum, n]`, seconds connected, and disconnects by reason.
- Sessions get their own round-trip sketch (in `s.cell`) and their disconnects, so one player's lag can be told from
  a lobby's.
- Metrics: `ping_p50`, `ping_p95`, `loss_pct`, `disconnects_per_hour` and `disconnect_pct` (level attempts ended by a
  disconnect).
- A new panel, `net`, takes `show`:
  - `ping`: p50 and p95 over time, with the share of play over 150 ms;
  - `loss`;
  - `disconnects`: per hour played, by reason.

  Its `by` can be `$version`, `$level`, `$platform`, `$link` or a property such as `$region`.
- `performance` gains `network`, by level, platform, link and version.
- The levels panel's rows gain `disconnects`.
- Network findings are in §4.

**MCP.** A new `glitchless_network` tool gives ping, loss and disconnects by level, region, platform, link and
version, the worst matches (with A7), and whether a match's lag was the lobby's or one player's. The panel schema
gains `net`, and the metrics above. The instrument skill finds the game's netcode and uses `netSample` when there's
nothing to find.

**Privacy.** Network quality goes in every mode, like frame times: it describes the connection, not the person.
Never sent: IP addresses, the server's address or host name, the ISP, the Wi-Fi network's name, or where the
player is. `link` is the kind of connection only. Each PRIVACY.md gains rows for `net`, `disconnect` and
`reconnect`. Its existing line that no mode sends "the network address" still holds.

**Limits.** One sample a second; 20 `disconnect` events a session; `net` only while connected.

**Back-compat.** Older servers keep `net` inside stored frame windows, unread, and drop `disconnect` and
`reconnect`. To them, a `level_abandon` with reason `disconnect` is an abandon, which is right.

**Work.** About 5.5 weeks, most of it in the engines: four Unity libraries, Unreal's net driver, Godot's ENet, WebRTC,
and multiplayer test games for each. Then the cells, `findings.js`, the panel, MCP and docs.

### A9. Server mode

**Built** (26 October 2026): the SDKs in phase 2, the server in phase 3: now in SPEC §2 (server mode, `server_window`),
§3 (`servers`, `services`, `players_now`), §3b (`servers` panel and view, the metrics), §4 (servers now, server findings)
and §6 (companion services). Section 9 lists what differs from below.

SPEC: §1 and §5–5d (the server role), §2 (envelope `role`, `server_window`), §3b, §4 (players now, servers now), §6
(the companion service).

For dedicated and authoritative servers: tick rate under load (BR, MOBA, MMO), crashes that end a match for everyone,
and the server's side of lag. A server's numbers are kept apart from players' numbers.

**When it runs.**

| engine | server mode | what it measures |
| --- | --- | --- |
| Unreal | `IsRunningDedicatedServer()`: the two checks that switch the plugin off (`GlitchlessModule.cpp:20`, `GlitchlessSubsystem.cpp:13`) start the server collector instead. A listen server (`NM_ListenServer`) stays a player session, with `net.host: true` | Tick time from the game thread's frame, against `NetServerMaxTickRate`. Players: `NetDriver->ClientConnections.Num()`. Crashes as now (`crash`, sent on the next start) |
| Unity | a Dedicated Server build (`UNITY_SERVER`), `Options.Role = GlitchlessRole.Server`, or `--glitchless-server` | NGO's `NetworkTickSystem` (its `TickRate`), Mirror's server update, or `FixedUpdate`. Players from NGO's `ConnectedClientsIds`, Mirror's `NetworkServer.connections`, or `Glitchless.SetPlayers(n)` |
| Godot | `OS.has_feature("dedicated_server")` (the dedicated-server export), `--glitchless-server`, or `role: "server"` | `_physics_process` against `Engine.physics_ticks_per_second`; players from `multiplayer.get_peers()` |
| Node (new) | `glitchless/server`, a new entry point for JavaScript game servers (Colyseus, Socket.IO, geckos.io), with no dependencies | `server.tick(ms)` around each tick, `server.setPlayers(n)`, `track`, `setGroup`, and uncaught errors |
| GameMaker | none: GameMaker has no headless server runtime | |

**Wire.**
- The envelope gains `role: "server"`, and `player_id` is always null.
- `session_start` takes `session_type` (`user` for live servers, `synthetic` for a load test) and `server: {tick_hz,
  max_players, build: "dedicated" | "headless", region, host: {os, cores, memory_gb}}`. `region` is in the game's
  own words.
- A new event, `server_window`, goes out every 5 s: `{ duration_s, ticks, tick_hz, tick: {sketch}, tick_p50, tick_p95,
  tick_max, late, players, players_max, net_objects, in_kbps, out_kbps, cpu_pct, mem_mb, rtt_p95, ctx }`. `tick_hz` is
  the rate reached, `late` the ticks over the budget (1000 / the target rate), and `rtt_p95` the connected players'
  pings as the server sees them.
- Errors, crashes, custom events, levels (the map) and groups (the match, A7) go as from a player's session.
- A server session lasts as long as its process, cut every 6 hours. It can also last one match, for a server that
  hosts one at a time (`sessionPerMatch: true`).

**Kept apart.** Intake files `role: server` batches under the game's companion service, `<service>.server` (the
name to be decided).
- Everything that keys by service then keeps servers apart with no new key: cells, session states, daily rollups,
  Glitchless Cloud's stores, the services list, players now. So no player number can take in a server session.
- The game's own dashboard reads the companion for its server panels and the Servers view.
- `services` lists the companion under its game.
- A server SDK reads `features` from `GET /v1/health` (A5) and sends nothing to a server without `server_mode`.
  That way its sessions can never land among players' on an older server.

**Players now and servers now.** `servers_now` counts servers that sent anything in the last two minutes. The sum of
their latest `players` sits next to `players_now`, which shows how many players run an SDK.

**Panels and views.**
- Metrics: `servers_now`, `server_tick_p95`, `server_crash_free_pct` and `players_per_server`.
- A new panel, `servers`, takes `show`:
  - `ticks`: tick time against its budget, by `players` connected, `$level` or `$version`;
  - `players`;
  - `crashes`.
- A new built-in view, `servers`, shows tick time by map and by players connected, crashes with their stacks
  (the Errors view on the companion), versions, and long-running servers whose memory climbs.

**MCP.** A new `glitchless_servers` tool gives ticks, players and crashes by map and version. Every other tool works
on the companion with `service: "<service>.server"`. `glitchless_triage` includes server findings. The setup prompt
and the instrument skill gain a server step.

**Privacy.** A server sends nothing about players: no player IDs, account IDs, names, chat or IP addresses.
`players` is a count. About itself it sends its OS, cores, memory and region in the game's words, never its IP
address or host name. The Unreal, Unity and Godot PRIVACY.md files gain a "Server mode" section that says so.

**Limits.** One `server_window` every 5 s; sessions cut every 6 hours.

**Back-compat.** Older servers get nothing from a server SDK, because of the `features` check. Player SDKs are
unchanged.

**Work.** About 6 weeks. That is the Unreal server collector, Unity and Godot server roles, the Node entry point, the
companion service across the stores, `presence.js`, the panel and view, findings, MCP, and dedicated-server test
builds: Linux, and Win64 on the Windows box.

## 3. Engine work per addition

The SDKs:

| | Browser SDK | Unity | Godot | Unreal | GameMaker |
| --- | --- | --- | --- | --- | --- |
| A1 per hour | none | none | none | none | none |
| A2 rates | none | none | none | none until A4 (send `won` as 1 or 0) | none (booleans or 1/0) |
| A3 distributions | none | none | none | none | none |
| A4 lists | tests, README | tests, README | tests, README | `FGlitchlessAttributes`, Blueprint struct and node | tests, README |
| A5 counters | `count()`, window entries, `counts`, debug warning, `features` check | `Count()`, flushed in `CloseWindow` | `count()`, in `_close_window` | `Count()` and `Count Event`, in `CloseWindow` | `glitchless_count()`, in `close_window` |
| A6 properties | `setProperties`, `properties`, `props`, checks | `SetProperty`, `SetProperties`, `Options.Properties` | `set_property`, `set_properties`, option | `SetProperty` overloads, option, Blueprint node | `glitchless_set_properties`, option |
| A7 groups, level attributes | `levelStart(id, attrs)`, `setGroup`, group fields in `push` | the same; fields in `Push` | the same; in `_push` | the same; in `Push`; Blueprint pins | the same; in the core's push |
| A8 network | `netSample`, `disconnect`, `instrumentNet` (WebRTC), `link` | NGO, Mirror, Fish-Net, Photon at run time; `internetReachability` | ENet statistics and signals | net driver, `OnNetworkFailure`, connection type | `glitchless_net_sample`, `glitchless_disconnect` |
| A9 server mode | new `glitchless/server` (Node) | server role, tick source, players | dedicated-server feature, physics tick | server collector in place of the two off-switches | none |

The rest:

| | Server (`server/src`) | Glitchless Cloud's store | Dashboard (`apps/dashboard`) | MCP (`packages/mcp`) | Skills (dashboard, instrument) |
| --- | --- | --- | --- | --- | --- |
| A1 | `board.js`, `analytics.js` (hours), `sums.js` | nothing new: cells already have `sec` | "per hour" units and lines | `per: "$hours"`, `hours_played`, `hours` in events | dashboard: per hour played |
| A2 | `rollups.js` `evb`, `board.js`, `sums.js`, `daily.js` | `evb` in hour summaries | rate bars with intervals and the overall line | `rate`, `avg`, `min`, `expect`; events `rate`/`avg`/`by` | instrument: outcomes as booleans; dashboard: rate panels |
| A3 | `rollups.js` `evq`, the occurrence path in `analytics.js`, `board.js`, `daily.js` | sketches in hour summaries (check the item size) | histogram panel; percentile stat | `distribution`, `quantile`; events p50/p90/p99 | one event per match or run |
| A4 | `smallAttrs`, `evl`/`evlb`/`evlx`, the matchers, `session-state.js`, `daily.js` | the new maps in hour summaries | the "counts once under each" line | lists in `by` | decks, builds and loadouts as lists |
| A5 | `ingest.js` type, folding in `rollups.js` and `session-state.js`, `facts.js`, `/v1/health` features | the new type flows through as any event | `counted` on the Events view | `counted` in events | track a moment, count a stream |
| A6 | `ingest.js` checks, `session-state.js` `props`, splits and filters in `analytics.js`, `board.js` `$name` and page `where`, `by_prop` | session states carry `props`; raw-row filters learn properties | filter bar, `$name` labels, page filter in Edit pages | `by`, `props` filters, events `properties`, page `where`, `by_prop` | what holds for a session; bands; the privacy rules |
| A7 | marks' `a` and `groups` in `session-state.js`, funnel `by` and runs, `matches` query, `daily.js` funnels | raw-row match queries | levels `by`, groups on session timelines, a match page | `glitchless_player_funnel` `by`, `glitchless_match`, session groups | level attributes; group IDs and their rules |
| A8 | cells' `net`, new types, `session-state.js`, `findings.js`, `net` panel | the new types flow through; match drill-downs | `net` panel; Network in Performance | `glitchless_network`, metrics | netcode detection; `netSample` otherwise |
| A9 | `role` in `ingest.js`, the companion service, `presence.js` `servers_now`, `server_window` cells, Servers view, findings | companion services in the registry; plans (open question 3) | Servers view and panels | `glitchless_servers`; server findings in triage | the server build; the setup prompt's server step |

Every addition also updates SPEC in the section it names. A6, A8 and A9 change setup, so they also update
`docs/agent-setup-prompt.md`.

## 4. Findings these enable

Each finding follows the findings convention: it says what happened to players, with players as the unit and the
normal value next to the number, how sure it is, where to look and what usually fixes it.

| # | Finding (id) | Needs | Rule | Reads like |
| --- | --- | --- | --- | --- |
| 1 | The whole lobby lagged (`net-lobby-<level>`) | A7, A8; A9 for evidence | Split each match into 30-second slots from its first event. A slot is a lobby spike when at least 60% of the match's sessions with network data (4 or more) have ping at least twice their own median and 50 ms over it. One session alone is a player spike. A level where 10% or more of matches have a lobby spike gets a finding, with the minute it comes most often and, with A9, the server's tick, players and net objects in those slots | "Whole lobbies on island lag together, most often 11 to 13 minutes in. That's the server, not players' connections: tick p95 reaches 52 ms then, against 21 ms the rest of the match" |
| 2 | One kind of connection lags (`net-link-<link>`, `net-player`) | A8 (A6 for a property) | Player spikes, grouped by `$link`, `$platform` or a property: a group whose share of play over 150 ms is 3× the rest's, with 30+ sessions | "Players on mobile data lag 4× as often as on Wi-Fi: 18% of their play is over 150 ms, against 4%" |
| 3 | No server near a region (`net-region-<region>`) | A8, A6 (`$region`) | A region whose median ping is over 120 ms for most of its play, with 30+ sessions | "Players in Oceania reach the servers at 190 ms for most of their play: no server is near them" |
| 4 | Disconnects went up (`disconnect-<version>`) | A8 | `disconnect_pct` doubled and up 2 points against the previous version (release order, §4), by reason | "1 match in 12 ends in a disconnect in 1.4, against 1 in 40 in 1.3. Most are timeouts 30 s after the match loads" (with the load hitches at that time as evidence) |
| 5 | Servers fall behind when full (`server-tick-<level>`) | A9 | Tick p95 over its budget in 10% or more of windows, compared across tenths of `players_max` | "Servers on island miss their 30 Hz tick in 34% of windows once over 80 players are connected (under 50 players: 2%)" |
| 6 | A server crash ends matches (`server-error-<fingerprint>`) | A9 (A7 for matches) | A fatal error on a server session, ranked by the matches and players it ended | "A server crash in the replication graph ended 41 matches with 3,900 players this week" |
| 7 | A long-running server leaks (`server-leak-<version>`) | A9 | The climbing-gauge rule (§4) on `mem_mb`, `net_objects` or a server gauge | "Server memory climbs from 1.1 GB to 6.4 GB over a server's life, and never comes down" |
| 8 | One choice is out of line (`balance-<event>-<attr>-<value>`) | A2 (A4 for lists) | For rates on the game's boards: 500+ events, with an interval that leaves out the overall rate ± 5 points | "Ember wins 58% of 12,400 matches, against 50% for all heroes" |
| 9 | Odds don't match the published ones (`odds-<event>-<value>`) | A2 with `expect` | A row whose interval leaves out `expect`; high severity, since stated odds are a legal matter in several countries | "Top-rarity pulls on summer_2026 come at 0.41% over 128,000 pulls. The published rate is 0.6%" |
| 10 | A wall at one difficulty (`design-wall-<level>-<attr>-<value>`) | A7 | The wall rule (§4) across a level's rows by an attempt attribute | "pit_80 is a wall for players alone: 12% clear it, against 61% of groups of four" |
| 11 | The economy jumped (`economy-<event>-<version>`) | A1 (A5 for counters) | A per-hour sum on the game's boards that moved 50% or more between the last two versions, with the attribute value that moved most | "Gold earned per hour played went up 3.1× in 1.6, most of it from loot (4.2×)" |
| 12 | A distribution shifted (`shift-<event>-<attr>`) | A3 (A6 for a group) | A distribution on the game's boards whose median or p90 moved 30% or more between the last two versions, or a property group whose p90 is twice the rest's | "Matches got longer in 1.4: half end within 18 minutes, against 14 in 1.3", "1 in 10 Diamond players waits over 6 minutes for a match" |
| 13 | Hitches come with a burst (in `perf-level-*` evidence) | A5 | Each window's counter totals are read next to its hitches, as gauges are | "Hitches on nmd_ghoa come in windows with 300 or more kills (a normal window: 40)" |
| 14 | One setting runs slow (`perf-prop-<key>`) | A6 | For properties with 10 or fewer values and 20+ sessions each, a value whose frame p95 is 1.5× the rest's | "Frame time on the ultra preset is 41 ms for the slowest 5% of frames, against 18 ms on high" |

Finding 1 is the one the owner's example asked for. "The whole lobby lagged at minute 12" points at the server,
while one player lagging points at their connection. It needs match IDs (A7), so that everyone in a lobby can be
compared, and network samples (A8). Server mode (A9) adds the server's own account of that minute, but the finding
works without it.

## 5. Phased plan

| Phase | What | Size | Ships as |
| --- | --- | --- | --- |
| 0 | Advice only. The instrument and dashboard skills ask games to send outcomes as booleans (`won: true`), numbers as numbers, decks and builds as lists, one event at the end of each match or run with its numbers, and bands rather than exact levels | 1 day | The plugin, then the skills repo (`scripts/export-skills.mjs`) |
| 1a | A1 per hour played, A2 rates and averages, findings 8, 9 and 11 | 2 weeks | Server and Glitchless Cloud; dashboard; MCP (`npm run bundle -w glitchless-mcp`) |
| 1b | A3 distributions, A4 lists, finding 12 | 4 weeks | The same, plus an Unreal plugin minor release for the attribute builder and booleans |
| 2 | A5 counters, A6 properties, A7 groups and level attributes, findings 10, 13 and 14 | 8 weeks | The next minor release of all five SDKs together, so the instrument skill says the same for each. Five PRIVACY.md files reviewed before release |
| 3a | A8 network quality and disconnects, findings 2, 3 and 4 | 5.5 weeks | All SDKs but GameMaker get netcode readers (GameMaker gets the manual calls); server; dashboard; MCP |
| 3b | A9 server mode, findings 1 (with server evidence), 5, 6 and 7 | 6 weeks | Unreal, Unity and Godot server roles; the Node entry point; server and Glitchless Cloud |

Phase 1 comes first because games already send what it reads: a game following phase 0's advice gets win rates and
medians on the day it ships, with no new build. Phase 2 is one coordinated SDK release, because A5, A6 and A7 each
change every engine's `push` and window code, and one PRIVACY.md review is better than three. In phase 3, A8 goes
before A9: it already covers listen-server and peer-to-peer co-op, and it gives finding 1 without servers.

Phase 3 needs things that don't exist yet:
- a multiplayer test game for each engine with its common netcode: Unity with NGO and Mirror, Godot with ENet, and
  Unreal's own networking with a dedicated server, on Linux and on the Windows box;
- bots that join a match together (glitchless-playtest);
- a network shaper for loss and latency in the tests.

In all, about 26 engineer-weeks. With one session per engine in phases 2 and 3, it's about three months.

## 6. Open questions for the owner

1. **Properties in anonymous mode.** Send them in every mode, as event attributes are (recommended), or only in
   install and full mode?
2. **Group IDs.** Allow match and party IDs from the game's servers in every mode, and runs that outlive a launch
   only in install and full mode (recommended)? Should the SDK also hash match and party IDs before sending them, so
   they can't be looked up in the game's own match logs?
3. **Server sessions.** Keep them under a companion service, `<game>.server` (recommended), or as a role inside the
   game's own service? On Glitchless Cloud, do server sessions count toward a plan's sessions?
4. **Netcode first.** Which libraries come first: Unity's NGO and Mirror (recommended), Fish-Net, Photon PUN or
   Fusion, or Steam Networking Sockets and Epic Online Services in every engine? And is a Node SDK for JavaScript
   game servers wanted?
5. **Retention, versions and findings by a property** (D7 by spender band, crash-free by class): in this design, or
   later?
6. **A zone dimension** apart from levels, for MMO zones and metroidvania rooms (the genre-demo games asked for it
   too)?
7. **Rates of words.** Should `result=win` get a rate from sessions' occurrences (approximate), or rates come from
   booleans only (recommended)?
8. **Exact distributions by attribute.** Keep a sketch per attribute value in the cells (exact, about ten times bigger
   cells), or read splits from occurrences (recommended to start)?
9. **Pairs in lists**, such as decks with both Hog Rider and Ice Spirit. The counts grow with every pair, so this
   needs a design of its own. Is it wanted?
10. **Published odds.** Should a mismatch between a gacha's published odds and what players get be a high-severity
    finding, and should the docs say Glitchless checks it (recommended)?

## 7. Decisions (the owner, 26 October 2026)

The owner's rule for all of them: Glitchless gives agents flexible tools and doesn't hard-code one genre's answers.

1. **Properties in anonymous mode:** yes, in every mode, as event attributes are. The limits in A6 (key and value
   lengths, a fixed number per session, no free text) keep them from carrying personal data, and PRIVACY.md says so.
2. **Group IDs:** match and party IDs in every mode, **hashed by the SDK by default** (with the game's service as the
   salt), with a setting to send them as they are for a developer who wants to match them against their own server
   logs. Runs that outlive a launch only in install and full mode.
3. **Server sessions:** under a companion service, `<game>.server`. They **count as sessions** like any other: one
   rule, easy to predict, and a match server adds about 1% to a 100-player match's sessions.
4. **Netcode first:** what a coding agent would suggest to someone making a multiplayer game. Unity: Netcode for
   GameObjects (with Relay and Lobby), then Mirror. Godot: its built-in MultiplayerAPI with ENet, and WebSocket for
   web exports. Unreal: its own replication, listen and dedicated servers. Web games: a Node server with `ws`,
   Socket.IO or Colyseus, so **a Node server SDK is wanted** (`glitchless/server`). GameMaker: manual calls around its
   `network_*` functions. Steam Networking Sockets, EOS, Photon and Fish-Net come later.
5. **Retention, versions and findings by a property:** yes. Retention and versions split by any property, and a
   finding names a property when most of a problem falls on one value ("crashes are mostly class=necromancer").
6. **Zones:** yes, apart from levels. A level is a unit with a start and an end (a dungeon, a match, a stage). A zone
   is where a player is in an open world (an MMO region, a metroidvania room), with no completion: `setZone(name)`
   stamps events and windows the way the current level does, and boards can split by `$zone`.
7. **Rates:** both. A rate comes from a boolean (`won: true`) or from a word outcome (`result=win`), whichever the
   game sends.
8. **Distributions by attribute:** no storage bloat. Splits read the stored occurrences (the recommended start); no
   sketch per attribute value.
9. **Pairs in lists:** not precomputed. A filter that asks for several values of one list at once ("contains all of"; A4 picks its syntax) answers any pair or trio
   an agent asks about.
10. **Published odds:** no built-in verdict. Distributions and rates let an agent check a gacha's published odds
    when a game wants it; the dashboard skill can suggest it.

## 8. Built: A1 to A4

Server phase 1 shipped A1 to A4 as written above, with the owner's decisions, except for these. Engine sessions and
phase 2 should read SPEC §2, §3, §3b, §4 and §6 for the shapes as built.

- **Rates of words (decision 7).** `rate` takes a flag (`"won"`: booleans and 1 or 0 together) or a word outcome
  (`"result=win"`). A word's rate is exact from the cells overall and by `$version` and `$level` (`evv`); split by
  another attribute it reads the sessions' occurrences, exact while no session sent more than 16 of the event and
  `estimated` past that. Flags stay exact from the cells everywhere.
- **The occurrence path.** One module (`server/src/occurrences.js`) reads the first 16 of each event a session keeps,
  with all its attributes and now its level. It answers what the cells can't count together: "contains all of",
  words by an attribute, a filtered event split by another attribute or a session split (not refused, as the design
  had it for sums), distributions split by an attribute (decision 8), and any split by a numeric attribute (`heat`),
  since cells never group by numbers (their values would be endless). Over more than 31 days it reads the day's sample
  (256 sessions), weighted by each session's own count of the event (the sample now keeps it, `c`).
- **"Contains all of" (decision 9).** `name:key=a+b+c` (up to 8 values) matches a list that has every one; a string
  equal to the whole value (`combo=up+down`) still matches. Nothing is precomputed. It works wherever an event is
  written: stats, series and breakdowns, funnels, `sent`, versions.
- **Distribution answers** name their bars `histogram`, not `bins`, so the answer never overwrites the panel's own
  `bins` (how many bars) when a board query spreads both into one panel. Sketches are plain JSON in the cells (`evq`:
  `{p, m, z, n, s, lo, hi, w}`), with an exact fixed-point sum for the mean.
- **Finding 9 (decision 10)** is `expect-<event>-<value>`: a rate, or a row, whose interval misses the board's own
  `expect`. Medium, never high, and worded as what was measured against what the board expects: no verdict on
  published odds or their legality. Finding 8 (`balance-…`) reads breakdowns without `expect`.
- **Finding 12** reads distributions and percentile stats between the last two versions; its property-group half
  ("1 in 10 Diamond players waits over 6 minutes") waits for A6.
- **The events query** answers `hours`, each numeric attribute's `p50`, `p90` and `p99`, and a list attribute's
  `list: true`. With `rate` or `avg` it adds `measure` (a stat, or with `by` a breakdown's rows); with `of`,
  `distribution`. `event=` carries a filter (`match_end:mode=ranked`) next to `name=`.
- **The `levels` panel** rows add `p50_complete_s` and `p90_complete_s`; day rollups keep a quantile map per level
  for them.
- **Metrics.** `hours_played` is a stat metric and an overview KPI; `deaths` and `errors` take `per: "$hours"`.
- **Not done here.** The live tail's filter matches event names only, so lists don't change it. The Unreal attribute
  builder (A4's booleans and lists) and each SDK's PRIVACY.md line that a list is never a list of people belong to the
  engine sessions. Older servers ignore lists, as the design says; boards saved there lose the new fields.
- **Size on Glitchless Cloud.** On a synthetic busy hour (3,000 sessions, 6,000 `match_end` with 120 heroes, a 6-item
  build from 200 items and 5 numbers each) the hour's cell items grow from 319 KB to 1.1 MB gzipped, 457 KB of it the
  sums per list element (`evlx`); the largest minute stays at 58 KB, well under an item. A game with 12 heroes, 20
  items and 1 number grows from 78 to 172 KB an hour, small next to its session states (890 KB). Watch `evlx` on real
  games: capping it lower is the first lever if items grow.

## 9. Built: A5 to A9

Server phase 2 (the five SDKs' client side came first, phase 2's engine sessions) built A5 to A9 with the owner's
decisions and the wire details the engine sessions settled between them. SPEC describes them; these are the
differences from the sections above.

- **Counters (A5).** A counter's entry keeps one occurrence in its session that stands for its `n` events (the
  occurrence's fourth element), and everything that reads occurrences weighs it so: a rate of a flag in a counter's
  group, split by a session split, is exact while a session keeps its entries. Finding 13 is evidence on the level's
  frame-time finding (`counter_bursts`), read from facts that pair each window's counts with its frame window.
- **Properties (A6).** A split by a property, and a filter, read the sessions (decision 8), over 31 days or less; a
  longer range says so (Glitchless Cloud reads its last 31 days). The players query takes `by_prop` for retention per
  value, and `versions` takes `by=<key>` (the panel `$<key>`), each value's rates, averages, percentiles and per-hour
  counts from its own sessions (sums stay out, as for Steam branches). A page `where` takes up to 4 properties. The lean
  (decision 5) is on error and wall findings; finding 14 is `perf-prop-<key>`, and finding 12's group half
  `shift-<event>-<attr>-<key>-<value>`, from distribution panels split by a property.
- **Groups and level attributes (A7).** Group IDs are whatever valid ID arrives (hashed `h_` and 24 hex by default, raw
  with `hashGroupIds: false`). The `matches` query lists matches and opens one with `id`; its server side comes from
  the companion service (A9). The lobby and player spikes the match page marks use finding 1's rule. The players query
  answers `funnel_by` next to `funnel`. Finding 10 compares one level's values of one attribute (the design's example,
  pit_80 alone against groups of four, is the level pit_80 by `party_size`).
- **Zones (decision 6).** Cells are kept per zone as well as per level, only for games that set one, so `$zone` is
  exact over any range like `$level`; facts (hitches, errors) stay per level. Occurrences keep their zone, so a filtered
  event splits by `$zone` too.
- **Network (A8).** `disconnect_pct` is the share of level attempts a disconnect ended (a game without levels: the
  connected sessions that dropped). Lag is read from each window's own sketch. Finding 1 (the lobby) is built from each
  session's ping per 30-second slot of each match, kept in its state (8 matches, 480 slots each), so it works on every
  store without raw events; its server evidence comes with A9. Finding 2 groups by `$link`, `$platform` and small
  properties (ids `net-link-`, `net-platform-`, `net-prop-`); finding 3 reads the property `region`.
- **Server mode (A9).** The companion is `<game>.server`, folded under its game by `services`; the queries that read
  servers put it in `ctx.server` with the same env and type. A window is over budget when 5% or more of its ticks were
  late (so a window alone says it, whatever the SDK's budget field); the budget shown is the windows' `budget_ms`, else
  1000 over `tick_hz`. Ticks by players connected come from each server session's windows per map and player count.
  Finding 5 needs every band from some count up over 10% (a mid-match spike in one band isn't "when full"); finding 6
  counts the matches open within a minute of the crash and the players of the crashed server's last window. Alerts skip
  companions. Server metrics stay out of version comparisons.
- **`GET /v1/health` `features`** lists `counts`, `props`, `groups`, `zones`, `net` and `server_mode`.
