# Example dashboards

Dashboards for the [dashboard skill](../SKILL.md) to start from, each in the form `glitchless_set_dashboard`
takes. Keep the shape and rename everything to the game's own words.

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
